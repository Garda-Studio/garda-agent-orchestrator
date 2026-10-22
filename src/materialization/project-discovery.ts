import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathExists } from '../core/filesystem';
import { normalizeRelativePath } from '../core/paths';
import { DEFAULT_GIT_TIMEOUT_MS, spawnSyncWithTimeout } from '../core/subprocess';
import {
    UNCONFIGURED_COMPILE_GATE_COMMAND,
    UNCONFIGURED_FULL_SUITE_VALIDATION_COMMAND,
    resolveBundleName
} from '../core/constants';

interface StackSignal {
    name: string;
    pattern: RegExp;
}

interface StackEvidence {
    name: string;
    matches: string[];
}

// Out-of-source CMake build into build/, which the default build-output exclusions keep out of task scope.
const CMAKE_BUILD_COMMAND = 'cmake -S . -B build && cmake --build build';

interface CompileGateCommandSurface {
    commands: string[];
}

export interface ProjectDiscovery {
    source: string;
    fileCount: number;
    diagnostics: string[];
    detectedStacks: string[];
    stackEvidence: StackEvidence[];
    topLevelDirectories: string[];
    rootFiles: string[];
    runtimePathHints: string[];
    suggestedCommands: string[];
    suggestedCompileGateCommands: string[];
    suggestedFullSuiteValidationCommand: string | null;
    suggestedFullSuiteValidationCommands?: string[];
    relativeFiles: string[];
    sampleFiles: string[];
}

const _BASE_EXCLUDED_PATH_FRAGMENTS = Object.freeze([
    '/.git/', '/node_modules/', '/.next/', '/dist/', '/build/',
    '/target/', '/bin/', '/obj/', '/runtime/'
]);

export function getExcludedPathFragments(): readonly string[] {
    return [..._BASE_EXCLUDED_PATH_FRAGMENTS, `/${resolveBundleName()}/`];
}

export const STACK_SIGNALS: readonly StackSignal[] = Object.freeze([
    { name: 'Node.js or JavaScript', pattern: /(^|\/)package\.json$/ },
    { name: 'TypeScript', pattern: /(^|\/)tsconfig(\.[^/]+)?\.json$/ },
    { name: 'Java or JVM', pattern: /(^|\/)(pom\.xml|build\.gradle(\.kts)?|settings\.gradle(\.kts)?)$/ },
    { name: 'Python', pattern: /(^|\/)(?:pyproject\.toml|requirements(?:\.txt|-dev\.txt)?)$/ },
    { name: 'Go', pattern: /(^|\/)go\.mod$/ },
    { name: 'Rust', pattern: /(^|\/)Cargo\.toml$/ },
    { name: '.NET', pattern: /\.(sln|slnx|csproj|fsproj|vbproj)$/ },
    { name: 'PHP', pattern: /(^|\/)composer\.json$/ },
    { name: 'Ruby', pattern: /(^|\/)Gemfile$/ },
    { name: 'Scala', pattern: /(^|\/)build\.sbt$/ },
    { name: 'Elixir', pattern: /(^|\/)mix\.exs$/ },
    { name: 'Swift', pattern: /(^|\/)Package\.swift$/ },
    { name: 'Dart or Flutter', pattern: /(^|\/)pubspec\.yaml$/ },
    { name: 'C or C++', pattern: /(^|\/)(?:CMakeLists\.txt|meson\.build|conanfile\.(?:txt|py)|vcpkg\.json)$/ },
    { name: 'Containerization', pattern: /(^|\/)Dockerfile(\..+)?$|(^|\/)docker-compose(\.[^/]+)?\.ya?ml$/ }
]);

const _STATIC_EXCLUDED_TOP_LEVEL_DIRS = ['.git', 'node_modules', 'dist', 'build', 'target', 'bin', 'obj', 'runtime'];

const DEFAULT_FALLBACK_SCAN_MAX_FILES = 10000;
const DEFAULT_FALLBACK_SCAN_MAX_DIRECTORIES = 2000;
const DEFAULT_FALLBACK_SCAN_MAX_ELAPSED_MS = 5000;

export interface ProjectDiscoveryOptions {
    fallbackScanMaxFiles?: number;
    fallbackScanMaxDirectories?: number;
    fallbackScanMaxElapsedMs?: number;
}

interface FallbackScanResult {
    files: string[];
    diagnostics: string[];
}

export function getExcludedTopLevelDirs(): Set<string> {
    return new Set([resolveBundleName(), ..._STATIC_EXCLUDED_TOP_LEVEL_DIRS]);
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
    return Number.isInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}

function isExcludedDiscoveryRelativePath(relativePath: string): boolean {
    const normalized = normalizeRelativePath(relativePath);
    if (!normalized) {
        return false;
    }
    const wrapped = `/${normalized}/`;
    return getExcludedPathFragments().some((fragment) => wrapped.includes(fragment));
}

function readPackageJsonSafe(packageJsonPath: string): Record<string, unknown> | null {
    if (!pathExists(packageJsonPath)) {
        return null;
    }

    try {
        const parsed = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? parsed as Record<string, unknown>
            : null;
    } catch {
        return null;
    }
}

function readRootPackageJsonSafe(targetRoot: string): Record<string, unknown> | null {
    return readPackageJsonSafe(path.join(targetRoot, 'package.json'));
}

function detectNodePackageManager(targetRoot: string, packageJson: Record<string, unknown> | null): 'npm' | 'pnpm' | 'yarn' | 'bun' {
    const packageManagerField = String(packageJson?.packageManager || '').trim().toLowerCase();
    if (packageManagerField.startsWith('pnpm@')) return 'pnpm';
    if (packageManagerField.startsWith('yarn@')) return 'yarn';
    if (packageManagerField.startsWith('bun@')) return 'bun';
    if (packageManagerField.startsWith('npm@')) return 'npm';

    if (pathExists(path.join(targetRoot, 'pnpm-lock.yaml')) || pathExists(path.join(targetRoot, 'pnpm-workspace.yaml'))) {
        return 'pnpm';
    }
    if (pathExists(path.join(targetRoot, 'yarn.lock'))) {
        return 'yarn';
    }
    if (pathExists(path.join(targetRoot, 'bun.lock')) || pathExists(path.join(targetRoot, 'bun.lockb'))) {
        return 'bun';
    }
    if (pathExists(path.join(targetRoot, 'package-lock.json')) || pathExists(path.join(targetRoot, 'npm-shrinkwrap.json'))) {
        return 'npm';
    }

    return 'npm';
}

function getPackageJsonScripts(packageJson: Record<string, unknown> | null): Record<string, unknown> {
    if (!packageJson || typeof packageJson.scripts !== 'object' || Array.isArray(packageJson.scripts) || packageJson.scripts === null) {
        return {};
    }
    return packageJson.scripts as Record<string, unknown>;
}

function quoteCommandPath(relativePath: string): string {
    const normalized = normalizeRelativePath(relativePath);
    if (/^[A-Za-z0-9._/-]+$/.test(normalized)) {
        return normalized;
    }
    return `"${normalized.replace(/(["\\$`])/g, '\\$1')}"`;
}

function getRelativeSurfacePath(targetRoot: string, surfaceRoot: string): string {
    return normalizeRelativePath(path.relative(targetRoot, surfaceRoot));
}

function buildNodeRunCommand(
    runner: 'npm' | 'pnpm' | 'yarn' | 'bun',
    scriptName: string,
    relativeSurfacePath: string
): string {
    if (!relativeSurfacePath) {
        return `${runner} run ${scriptName}`;
    }

    const surfaceArg = quoteCommandPath(relativeSurfacePath);
    if (runner === 'npm') {
        return `npm --prefix ${surfaceArg} run ${scriptName}`;
    }
    if (runner === 'pnpm') {
        return `pnpm --dir ${surfaceArg} run ${scriptName}`;
    }
    return `${runner} --cwd ${surfaceArg} run ${scriptName}`;
}

function buildTscCompileCommand(relativeSurfacePath: string): string {
    if (!relativeSurfacePath) {
        return 'npx tsc --noEmit';
    }
    return `npx tsc --noEmit -p ${quoteCommandPath(`${relativeSurfacePath}/tsconfig.json`)}`;
}

function normalizeScriptForHeuristic(scriptValue: string): string {
    return String(scriptValue || '')
        .trim()
        .replace(/\\/g, '/')
        .replace(/\s+/g, ' ')
        .toLowerCase();
}

function isHeavyweightCompileGateScript(scriptName: string, scriptValue: string): boolean {
    const normalizedName = String(scriptName || '').trim().toLowerCase();
    const normalizedScript = normalizeScriptForHeuristic(scriptValue);
    if (!normalizedScript) {
        return true;
    }

    const heavyweightNamePattern = /(^|[:_-])(test|tests|e2e|integration|integrated|perf|performance|benchmark|bench|deploy|release|publish|package|pack|docker|image|migration|migrate)([:_-]|$)/;
    if (heavyweightNamePattern.test(normalizedName)) {
        return true;
    }

    const heavyweightScriptPatterns = [
        /\b(?:npm|pnpm|yarn|bun)(?:\s+run)?\s+(?:test(?::[\w:-]+)?|e2e|coverage|integration)(?:\s|$)/,
        /\b(?:jest|vitest|ava|mocha|playwright\s+test|cypress\s+run|pytest|tox|go\s+test|cargo\s+test|dotnet\s+test)(?:\s|$)/,
        /\b(?:mvn|\.\/mvnw|mvnw|mvnw\.cmd)\b.*\b(?:test|package|verify|install|deploy)\b/,
        /\b(?:gradle|\.\/gradlew|gradlew|gradlew\.bat)\b.*\b(?:test|check|build)\b/,
        /\b(?:docker|docker-compose|podman|buildx)(?:\s|$)|\bimage(?:s)?\b/,
        /\b(?:deploy|deployment|release|publish|npm\s+pack|package)\b/,
        /\b(?:integration|e2e|perf|performance|benchmark|migration|migrate|full[-_\s]?suite)\b/,
        /(?:^|\s)(?:bash|sh|pwsh|powershell)(?:\.exe)?\s+\.?\/?scripts\/build\.sh\s+-f(?:\s|$)/,
        /(?:^|\s)\.?\/?scripts\/build\.sh\s+-f(?:\s|$)/,
        /\bci-build[\w:-]*\b/,
        /\bartifacts?[-_\s]*(?:lock|rebuild|package|build)\b|\b(?:lock|rebuild|package|build)[-_\s]*artifacts?\b/
    ];

    return heavyweightScriptPatterns.some((pattern) => pattern.test(normalizedScript));
}

function listImmediateProjectRootsWithMarker(
    targetRoot: string,
    markerFileNames: readonly string[],
    includeNestedWhenRootExists: boolean
): string[] {
    const roots: string[] = [];
    const rootHasMarker = markerFileNames.some((marker) => pathExists(path.join(targetRoot, marker)));
    if (rootHasMarker) {
        roots.push(targetRoot);
        if (!includeNestedWhenRootExists) {
            return roots;
        }
    }

    let entries: fs.Dirent[] = [];
    try {
        entries = fs.readdirSync(targetRoot, { withFileTypes: true });
    } catch {
        return roots;
    }

    const excludedTopLevelDirs = getExcludedTopLevelDirs();
    const nestedRoots = entries
        .filter((entry) => entry.isDirectory() && !excludedTopLevelDirs.has(entry.name))
        .map((entry) => path.join(targetRoot, entry.name))
        .filter((candidateRoot) => markerFileNames.some((marker) => pathExists(path.join(candidateRoot, marker))))
        .sort((left, right) => getRelativeSurfacePath(targetRoot, left).localeCompare(getRelativeSurfacePath(targetRoot, right)));

    return [...roots, ...nestedRoots];
}

function resolveNodeCompileGateSurfaces(targetRoot: string): CompileGateCommandSurface[] {
    const packageRoots = listImmediateProjectRootsWithMarker(targetRoot, ['package.json'], true);
    const surfaces: CompileGateCommandSurface[] = [];

    for (const packageRoot of packageRoots) {
        const packageJson = readPackageJsonSafe(path.join(packageRoot, 'package.json'));
        const runner = detectNodePackageManager(packageRoot, packageJson);
        const scripts = getPackageJsonScripts(packageJson);
        const relativeSurfacePath = getRelativeSurfacePath(targetRoot, packageRoot);
        const preferredScripts = ['build', 'compile', 'typecheck', 'type-check'];
        const commands = preferredScripts
            .filter((scriptName) => {
                const scriptValue = scripts[scriptName];
                return typeof scriptValue === 'string'
                    && !isHeavyweightCompileGateScript(scriptName, scriptValue);
            })
            .map((scriptName) => buildNodeRunCommand(runner, scriptName, relativeSurfacePath));

        if (commands.length === 0 && pathExists(path.join(packageRoot, 'tsconfig.json'))) {
            commands.push(buildTscCompileCommand(relativeSurfacePath));
        }

        if (commands.length > 0) {
            surfaces.push({
                commands
            });
        }
    }

    if (packageRoots.length === 0 && hasAnyRootFile(targetRoot, ['tsconfig.json'])) {
        surfaces.push({
            commands: [buildTscCompileCommand('')]
        });
    }

    return surfaces;
}

function resolveNodeFullSuiteValidationCommand(targetRoot: string): string | null {
    if (!pathExists(path.join(targetRoot, 'package.json'))) {
        return null;
    }

    const packageJson = readRootPackageJsonSafe(targetRoot);
    const testScript = getPackageJsonScripts(packageJson).test;
    if (typeof testScript !== 'string' || !testScript.trim()) {
        return null;
    }
    const runner = detectNodePackageManager(targetRoot, packageJson);
    return `${runner} test`;
}

function hasAnyRootFile(targetRoot: string, candidates: readonly string[]): boolean {
    return candidates.some((candidate) => pathExists(path.join(targetRoot, candidate)));
}

function hasAnyRootFileByExtension(targetRoot: string, extensions: readonly string[]): boolean {
    try {
        const entries = fs.readdirSync(targetRoot, { withFileTypes: true });
        return entries.some((entry) => (
            entry.isFile()
            && extensions.some((extension) => entry.name.toLowerCase().endsWith(extension))
        ));
    } catch {
        return false;
    }
}

function resolveJvmWrapperCommand(options: {
    targetRoot: string;
    wrapperName: string;
    windowsWrapperName: string;
    fallbackCommand: string;
    runtimePlatform: NodeJS.Platform;
    taskName: string;
}): string {
    const { targetRoot, wrapperName, windowsWrapperName, fallbackCommand, runtimePlatform, taskName } = options;
    const posixWrapperExists = pathExists(path.join(targetRoot, wrapperName));
    const windowsWrapperExists = pathExists(path.join(targetRoot, windowsWrapperName));

    if (runtimePlatform === 'win32') {
        if (windowsWrapperExists) {
            return `.\\${windowsWrapperName} ${taskName}`;
        }
        if (posixWrapperExists) {
            return `./${wrapperName} ${taskName}`;
        }
        return fallbackCommand;
    }

    if (posixWrapperExists) {
        return `./${wrapperName} ${taskName}`;
    }

    return fallbackCommand;
}

function resolveMavenCompileCommand(
    targetRoot: string,
    projectRoot: string,
    runtimePlatform: NodeJS.Platform
): string {
    const relativeSurfacePath = getRelativeSurfacePath(targetRoot, projectRoot);
    if (!relativeSurfacePath) {
        return resolveJvmWrapperCommand({
            targetRoot,
            wrapperName: 'mvnw',
            windowsWrapperName: 'mvnw.cmd',
            fallbackCommand: 'mvn compile',
            runtimePlatform,
            taskName: 'compile'
        });
    }

    const pomArg = quoteCommandPath(`${relativeSurfacePath}/pom.xml`);
    return resolveJvmWrapperCommand({
        targetRoot,
        wrapperName: 'mvnw',
        windowsWrapperName: 'mvnw.cmd',
        fallbackCommand: `mvn -f ${pomArg} compile`,
        runtimePlatform,
        taskName: `-f ${pomArg} compile`
    });
}

function resolveGradleCompileCommand(
    targetRoot: string,
    projectRoot: string,
    runtimePlatform: NodeJS.Platform
): string {
    const relativeSurfacePath = getRelativeSurfacePath(targetRoot, projectRoot);
    if (!relativeSurfacePath) {
        return resolveJvmWrapperCommand({
            targetRoot,
            wrapperName: 'gradlew',
            windowsWrapperName: 'gradlew.bat',
            fallbackCommand: 'gradle assemble',
            runtimePlatform,
            taskName: 'assemble'
        });
    }

    const projectArg = quoteCommandPath(relativeSurfacePath);
    return resolveJvmWrapperCommand({
        targetRoot,
        wrapperName: 'gradlew',
        windowsWrapperName: 'gradlew.bat',
        fallbackCommand: `gradle -p ${projectArg} assemble`,
        runtimePlatform,
        taskName: `-p ${projectArg} assemble`
    });
}

function resolveMavenCompileGateSurfaces(
    targetRoot: string,
    runtimePlatform: NodeJS.Platform
): CompileGateCommandSurface[] {
    return listImmediateProjectRootsWithMarker(targetRoot, ['pom.xml'], false)
        .map((projectRoot) => {
            return {
                commands: [resolveMavenCompileCommand(targetRoot, projectRoot, runtimePlatform)]
            };
        });
}

function resolveGradleCompileGateSurfaces(
    targetRoot: string,
    runtimePlatform: NodeJS.Platform
): CompileGateCommandSurface[] {
    return listImmediateProjectRootsWithMarker(
        targetRoot,
        ['build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts'],
        false
    ).map((projectRoot) => {
        return {
            commands: [resolveGradleCompileCommand(targetRoot, projectRoot, runtimePlatform)]
        };
    });
}

function buildOrderedCompileGateCommands(surfaces: readonly CompileGateCommandSurface[]): string[] {
    const uniqueSurfaceCommands = [...new Set(surfaces.flatMap((surface) => surface.commands))];
    const primarySurfaceCommands = surfaces
        .map((surface) => surface.commands[0])
        .filter((command): command is string => Boolean(command));
    if (primarySurfaceCommands.length <= 1) {
        return uniqueSurfaceCommands;
    }

    return [...new Set([
        primarySurfaceCommands.join(' && '),
        ...uniqueSurfaceCommands
    ])];
}

function resolveJvmWrapperTestCommand(options: {
    targetRoot: string;
    wrapperName: string;
    windowsWrapperName: string;
    fallbackCommand: string;
    runtimePlatform: NodeJS.Platform;
}): string {
    return resolveJvmWrapperCommand({ ...options, taskName: 'test' });
}

export function resolveSuggestedCompileGateCommands(
    targetRoot: string,
    runtimePlatform: NodeJS.Platform = process.platform
): string[] {
    const normalizedTargetRoot = path.resolve(targetRoot);
    const surfaces: CompileGateCommandSurface[] = [];

    surfaces.push(...resolveNodeCompileGateSurfaces(normalizedTargetRoot));

    if (hasAnyRootFile(normalizedTargetRoot, ['pyproject.toml', 'requirements.txt', 'requirements-dev.txt'])) {
        surfaces.push({
            commands: ['python -m compileall .']
        });
    }

    surfaces.push(...resolveMavenCompileGateSurfaces(normalizedTargetRoot, runtimePlatform));

    if (pathExists(path.join(normalizedTargetRoot, 'go.mod'))) {
        surfaces.push({
            commands: ['go build ./...']
        });
    }

    if (pathExists(path.join(normalizedTargetRoot, 'Cargo.toml'))) {
        surfaces.push({
            commands: ['cargo check']
        });
    }

    if (hasAnyRootFileByExtension(normalizedTargetRoot, ['.sln', '.slnx', '.csproj', '.fsproj', '.vbproj'])) {
        surfaces.push({
            commands: ['dotnet build']
        });
    }

    surfaces.push(...resolveGradleCompileGateSurfaces(normalizedTargetRoot, runtimePlatform));

    if (pathExists(path.join(normalizedTargetRoot, 'CMakeLists.txt'))) {
        surfaces.push({
            commands: [CMAKE_BUILD_COMMAND]
        });
    }

    return buildOrderedCompileGateCommands(surfaces);
}

export function resolveSuggestedFullSuiteValidationCommand(
    targetRoot: string,
    runtimePlatform: NodeJS.Platform = process.platform
): string | null {
    const candidates = resolveSuggestedFullSuiteValidationCommands(targetRoot, runtimePlatform);
    return candidates.length === 1 ? candidates[0]! : null;
}

export function resolveSuggestedFullSuiteValidationCommands(
    targetRoot: string,
    runtimePlatform: NodeJS.Platform = process.platform
): string[] {
    const normalizedTargetRoot = path.resolve(targetRoot);
    const candidates: string[] = [];
    for (const packageRoot of listImmediateProjectRootsWithMarker(normalizedTargetRoot, ['package.json'], true)) {
        const nodeCommand = resolveNodeFullSuiteValidationCommand(packageRoot);
        if (nodeCommand) {
            const relativeSurfacePath = getRelativeSurfacePath(normalizedTargetRoot, packageRoot);
            candidates.push(relativeSurfacePath
                ? buildNodeRunCommand(detectNodePackageManager(packageRoot, readRootPackageJsonSafe(packageRoot)), 'test', relativeSurfacePath)
                : nodeCommand);
        }
    }

    if (hasAnyRootFile(normalizedTargetRoot, ['pyproject.toml', 'requirements.txt', 'requirements-dev.txt'])) {
        candidates.push('pytest');
    }

    if (pathExists(path.join(normalizedTargetRoot, 'pom.xml'))) {
        if (hasAnyRootFile(normalizedTargetRoot, ['mvnw', 'mvnw.cmd'])) {
            candidates.push(resolveJvmWrapperTestCommand({
                targetRoot: normalizedTargetRoot,
                wrapperName: 'mvnw',
                windowsWrapperName: 'mvnw.cmd',
                fallbackCommand: 'mvn test',
                runtimePlatform
            }));
        } else {
            candidates.push('mvn test');
        }
    }

    if (hasAnyRootFile(normalizedTargetRoot, ['build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts'])) {
        if (hasAnyRootFile(normalizedTargetRoot, ['gradlew', 'gradlew.bat'])) {
            candidates.push(resolveJvmWrapperTestCommand({
                targetRoot: normalizedTargetRoot,
                wrapperName: 'gradlew',
                windowsWrapperName: 'gradlew.bat',
                fallbackCommand: 'gradle test',
                runtimePlatform
            }));
        } else {
            candidates.push('gradle test');
        }
    }

    if (pathExists(path.join(normalizedTargetRoot, 'go.mod'))) {
        candidates.push('go test ./...');
    }

    if (pathExists(path.join(normalizedTargetRoot, 'Cargo.toml'))) {
        candidates.push('cargo test');
    }

    if (hasAnyRootFileByExtension(normalizedTargetRoot, ['.sln', '.slnx', '.csproj', '.fsproj', '.vbproj'])) {
        candidates.push('dotnet test');
    }

    if (pathExists(path.join(normalizedTargetRoot, 'CMakeLists.txt'))) {
        candidates.push('ctest --test-dir build --output-on-failure');
    }

    return [...new Set(candidates)];
}

export function getProjectDiscovery(targetRoot: string, options: ProjectDiscoveryOptions = {}): ProjectDiscovery {
    let relativeFiles: string[] = [];
    let discoverySource = 'filesystem_scan';
    const diagnostics: string[] = [];

    try {
        const gitDir = path.join(targetRoot, '.git');
        if (pathExists(gitDir)) {
            const files = spawnSyncWithTimeout('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
                cwd: targetRoot, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
                timeoutMs: DEFAULT_GIT_TIMEOUT_MS
            });
            if (files.status === 0) {
                relativeFiles = [...new Set((files.stdout || '').split('\0').filter(Boolean))].sort();
                discoverySource = 'git_index_and_worktree';
            } else {
                diagnostics.push('Git discovery failed; using bounded filesystem fallback scan.');
            }
        }
    } catch {
        diagnostics.push('Git discovery failed; using bounded filesystem fallback scan.');
    }

    if (relativeFiles.length === 0) {
        const scanResult = collectFilesRecursive(targetRoot, targetRoot, options);
        relativeFiles = scanResult.files;
        diagnostics.push(...scanResult.diagnostics);
    }

    const filteredFiles: string[] = relativeFiles
        .map((f: string) => normalizeRelativePath(f))
        .filter((f: string) => f && !isExcludedDiscoveryRelativePath(f));
    const uniqueFiles: string[] = [...new Set(filteredFiles)].sort();

    const detectedStacks: string[] = [];
    const stackEvidence: StackEvidence[] = [];
    for (const signal of STACK_SIGNALS) {
        const matches = uniqueFiles.filter((f: string) => signal.pattern.test(f)).slice(0, 8);
        if (matches.length > 0) {
            detectedStacks.push(signal.name);
            stackEvidence.push({
                name: signal.name,
                matches
            });
        }
    }

    let topLevelDirectories: string[] = [];
    try {
        const entries = fs.readdirSync(targetRoot, { withFileTypes: true });
        topLevelDirectories = entries
            .filter((e) => e.isDirectory() && !getExcludedTopLevelDirs().has(e.name))
            .map((e) => e.name)
            .sort();
    } catch {
        // Ignore
    }

    const suggestedFullSuiteValidationCommands = resolveSuggestedFullSuiteValidationCommands(targetRoot);
    const suggestedCommands = [...suggestedFullSuiteValidationCommands];
    for (const packageRoot of listImmediateProjectRootsWithMarker(targetRoot, ['package.json'], true)) {
        const packageJson = readRootPackageJsonSafe(packageRoot);
        const scripts = getPackageJsonScripts(packageJson);
        for (const script of ['lint', 'build']) {
            if (typeof scripts[script] === 'string' && String(scripts[script]).trim()) {
                suggestedCommands.push(buildNodeRunCommand(
                    detectNodePackageManager(packageRoot, packageJson), script, getRelativeSurfacePath(targetRoot, packageRoot)
                ));
            }
        }
    }

    const rootFiles = uniqueFiles.filter((filePath: string) => !filePath.includes('/')).slice(0, 20);
    const runtimePathHints = collectRuntimePathHints(uniqueFiles);
    const suggestedCompileGateCommands = resolveSuggestedCompileGateCommands(targetRoot);
    const suggestedFullSuiteValidationCommand = suggestedFullSuiteValidationCommands.length === 1
        ? suggestedFullSuiteValidationCommands[0]! : null;

    return {
        source: discoverySource,
        fileCount: uniqueFiles.length,
        diagnostics: [...new Set(diagnostics)].sort(),
        detectedStacks: [...new Set(detectedStacks)].sort(),
        stackEvidence,
        topLevelDirectories: [...new Set(topLevelDirectories)].sort(),
        rootFiles,
        runtimePathHints,
        suggestedCommands: [...new Set(suggestedCommands)].sort(),
        suggestedCompileGateCommands,
        suggestedFullSuiteValidationCommand,
        suggestedFullSuiteValidationCommands,
        relativeFiles: uniqueFiles,
        sampleFiles: uniqueFiles.slice(0, 40)
    };
}

export function collectRuntimePathHints(relativeFiles: string[]): string[] {
    const runtimeRootTokens = new Set(['src', 'app', 'apps', 'backend', 'frontend', 'web', 'api', 'services', 'packages']);
    const hints: string[] = [];
    const seen = new Set<string>();

    for (const filePath of relativeFiles) {
        const segments = String(filePath || '').split('/').filter(Boolean);
        if (segments.length < 2) {
            continue;
        }

        let hint = null;
        const first = segments[0].toLowerCase();
        const second = segments[1].toLowerCase();

        if (runtimeRootTokens.has(first)) {
            hint = `${segments[0]}/`;
        } else if (runtimeRootTokens.has(second)) {
            hint = `${segments[0]}/${segments[1]}/`;
        }

        if (hint && !seen.has(hint)) {
            seen.add(hint);
            hints.push(hint);
        }

        if (hints.length >= 20) {
            break;
        }
    }

    return hints;
}

function collectFilesRecursive(
    rootPath: string,
    basePath: string,
    options: ProjectDiscoveryOptions = {}
): FallbackScanResult {
    const results: string[] = [];
    const diagnostics: string[] = [];
    const stack: string[] = [rootPath];
    const maxFiles = normalizePositiveInteger(options.fallbackScanMaxFiles, DEFAULT_FALLBACK_SCAN_MAX_FILES);
    const maxDirectories = normalizePositiveInteger(options.fallbackScanMaxDirectories, DEFAULT_FALLBACK_SCAN_MAX_DIRECTORIES);
    const maxElapsedMs = normalizePositiveInteger(options.fallbackScanMaxElapsedMs, DEFAULT_FALLBACK_SCAN_MAX_ELAPSED_MS);
    const startedAt = Date.now();
    let scannedDirectories = 0;
    let stoppedReason: string | null = null;

    while (stack.length > 0) {
        if (results.length >= maxFiles) {
            stoppedReason = `file budget reached (${maxFiles})`;
            break;
        }
        if (scannedDirectories >= maxDirectories) {
            stoppedReason = `directory budget reached (${maxDirectories})`;
            break;
        }
        if (Date.now() - startedAt > maxElapsedMs) {
            stoppedReason = `elapsed budget reached (${maxElapsedMs} ms)`;
            break;
        }

        const current = stack.pop()!;
        const currentRelative = path.relative(basePath, current).replace(/\\/g, '/');
        if (currentRelative && isExcludedDiscoveryRelativePath(currentRelative)) {
            continue;
        }
        scannedDirectories += 1;

        try {
            const entries = fs.readdirSync(current, { withFileTypes: true });
            for (const entry of entries) {
                const fullPath = path.join(current, entry.name);
                if (entry.isDirectory()) {
                    const relativeDir = path.relative(basePath, fullPath).replace(/\\/g, '/');
                    if (isExcludedDiscoveryRelativePath(relativeDir)) {
                        continue;
                    }
                    stack.push(fullPath);
                } else if (entry.isFile()) {
                    results.push(path.relative(basePath, fullPath).replace(/\\/g, '/'));
                    if (results.length >= maxFiles) {
                        stoppedReason = `file budget reached (${maxFiles})`;
                        break;
                    }
                }
            }
        } catch {
            // Ignore unreadable dirs
        }
    }

    if (stoppedReason) {
        diagnostics.push(
            `Filesystem fallback scan stopped early: ${stoppedReason}; partial project discovery results were used.`
        );
    }
    return { files: results, diagnostics };
}

export function buildProjectDiscoveryLines(discovery: ProjectDiscovery, timestampIso: string): string[] {
    const tick = '`';
    const lines = [
        '# Project Discovery', '',
        `Generated at: ${timestampIso}`,
        `Source: ${discovery.source}`,
        `Files considered: ${discovery.fileCount}`,
        'Coverage: unverified. Discovery lists candidates; it does not establish complete build or test coverage.',
        'The agent must inspect repository-owned instructions, scripts and source/test layouts, configure applicable commands and exact file roles through the ordinary workflow, and execute the configured checks before claiming setup is complete.',
        '', '## Detected Stack Signals'
    ];

    if (discovery.detectedStacks.length === 0) {
        lines.push('- No strong stack markers detected. Continue ordinary agent setup using repository evidence.');
    } else {
        for (const stack of discovery.detectedStacks) {
            lines.push(`- ${stack}`);
        }
    }

    lines.push('', '## Top-Level Directories');
    if (discovery.topLevelDirectories.length === 0) {
        lines.push('- No top-level runtime directories detected.');
    } else {
        for (const dir of discovery.topLevelDirectories) {
            lines.push(`- ${tick}${dir}/${tick}`);
        }
    }

    if (Array.isArray(discovery.diagnostics) && discovery.diagnostics.length > 0) {
        lines.push('', '## Discovery Diagnostics');
        for (const diagnostic of discovery.diagnostics) {
            lines.push(`- ${diagnostic}`);
        }
    }

    lines.push('', '## Stack Evidence');
    if (!Array.isArray(discovery.stackEvidence) || discovery.stackEvidence.length === 0) {
        lines.push('- No stack evidence captured.');
    } else {
        for (const evidence of discovery.stackEvidence) {
            const matches = Array.isArray(evidence.matches) && evidence.matches.length > 0
                ? evidence.matches.map((item) => `${tick}${item}${tick}`).join(', ')
                : 'none';
            lines.push(`- ${evidence.name}: ${matches}`);
        }
    }

    lines.push('', '## Root Files');
    if (!Array.isArray(discovery.rootFiles) || discovery.rootFiles.length === 0) {
        lines.push('- No root files captured.');
    } else {
        for (const filePath of discovery.rootFiles) {
            lines.push(`- ${tick}${filePath}${tick}`);
        }
    }

    lines.push('', '## Runtime Path Hints');
    if (!Array.isArray(discovery.runtimePathHints) || discovery.runtimePathHints.length === 0) {
        lines.push('- No runtime path hints detected.');
    } else {
        for (const hint of discovery.runtimePathHints) {
            lines.push(`- ${tick}${hint}${tick}`);
        }
    }

    lines.push('', '## Suggested Compile Gate Commands (Heuristic)');
    if (!Array.isArray(discovery.suggestedCompileGateCommands) || discovery.suggestedCompileGateCommands.length === 0) {
        lines.push(`- No compile-gate candidate detected. The agent must determine and configure the project-specific compile/build/type-check command; keep \`${UNCONFIGURED_COMPILE_GATE_COMMAND}\` until that step is complete.`);
    } else {
        lines.push('- Use these only for `workflow-config.compile_gate.command`; `40-commands.md` is human guidance. If the first command composes multiple build surfaces with `&&`, keep the whole command together. Full test suites belong in full-suite validation.');
        for (const cmd of discovery.suggestedCompileGateCommands) {
            lines.push(`- ${tick}${cmd}${tick}`);
        }
    }

    lines.push('', '## Suggested Local Commands (Heuristic)');
    if (discovery.suggestedCommands.length === 0) {
        lines.push('- No command suggestions from discovery. The agent must inspect repository instructions and scripts to determine applicable checks.');
    } else {
        for (const cmd of discovery.suggestedCommands) {
            lines.push(`- ${tick}${cmd}${tick}`);
        }
    }

    lines.push('', '## Suggested Full-Suite Validation Commands (Candidates)');
    for (const candidate of discovery.suggestedFullSuiteValidationCommands || []) {
        lines.push(`- ${tick}${candidate}${tick}`);
    }
    if (!discovery.suggestedFullSuiteValidationCommand || discovery.suggestedFullSuiteValidationCommand === UNCONFIGURED_FULL_SUITE_VALIDATION_COMMAND) {
        lines.push('- No unambiguous single candidate. The agent must establish the required validation surfaces and configure their project-specific command; candidates alone do not complete setup.');
    } else if (!discovery.suggestedFullSuiteValidationCommands?.length) {
        lines.push(`- ${tick}${discovery.suggestedFullSuiteValidationCommand}${tick}`);
    }

    lines.push('', '## Sample Files Used For Detection');
    if (discovery.sampleFiles.length === 0) {
        lines.push('- No sample files captured.');
    } else {
        for (const sample of discovery.sampleFiles) {
            lines.push(`- ${tick}${sample}${tick}`);
        }
    }

    return lines;
}

export function buildDiscoveryOverlaySection(discovery: ProjectDiscovery): string {
    const stacksText = discovery.detectedStacks.length > 0
        ? discovery.detectedStacks.join(', ')
        : 'none detected';
    const dirsText = discovery.topLevelDirectories.length > 0
        ? discovery.topLevelDirectories.slice(0, 10).join(', ')
        : 'none detected';
    const fullSuiteCommandText = discovery.suggestedFullSuiteValidationCommand
        && discovery.suggestedFullSuiteValidationCommand !== UNCONFIGURED_FULL_SUITE_VALIDATION_COMMAND
        ? `\`${discovery.suggestedFullSuiteValidationCommand}\``
        : 'no single candidate; the agent must inspect and configure all applicable project validation surfaces';
    const compileGateCommandText = Array.isArray(discovery.suggestedCompileGateCommands)
        && discovery.suggestedCompileGateCommands.length > 0
        ? `\`${discovery.suggestedCompileGateCommands[0]}\``
        : 'none detected; the agent must inspect and configure a project-specific compile/build/type-check command';

    return [
        '## Project Discovery Snapshot',
        `- Discovery source: ${discovery.source}`,
        `- Files considered: ${discovery.fileCount}`,
        '- Coverage: unverified; ordinary agent setup must inspect repository instructions, configure commands and exact file roles, then execute the configured checks.',
        `- Detected stacks: ${stacksText}`,
        `- Top-level directories: ${dirsText}`,
        `- Suggested compile-gate command: ${compileGateCommandText}`,
        `- Suggested full-suite validation command: ${fullSuiteCommandText}`,
        `- Full report: \`${resolveBundleName()}/live/project-discovery.md\``
    ].join('\r\n');
}
