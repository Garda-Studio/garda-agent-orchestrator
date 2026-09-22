import * as fs from 'node:fs';
import * as path from 'node:path';
import { UNCONFIGURED_COMPILE_GATE_COMMAND } from '../../core/constants';
import { countFileLines, stringSha256, normalizePath, joinOrchestratorPath } from '../shared/helpers';
import { DEFAULT_GIT_TIMEOUT_MS, spawnSyncWithTimeout } from '../../core/subprocess';
import {
    readStagedBlobFingerprints,
    type StagedBlobFingerprints
} from '../../core/staged-index-fingerprints';
import {
    buildGitChangeClassificationEvidence,
    classifyGitChanges,
    collectGitChangeClassificationSnapshot,
    deriveGitChangeClassification,
    normalizeGitRepoRelativePath,
    selectGitChangeClassificationLayers,
    type GitChangeClassificationResult,
    type GitChangeClassificationSnapshot,
    type GitChangeLayer
} from '../../core/git-change-classification';
import { isGeneratedOrchestratorLockPath } from '../locks/generated-lock-paths';
import { splitGeneratedRuntimeControlPlaneArtifacts } from '../shared/generated-runtime-artifacts';
import { isOrchestratorSourceCheckout } from '../protected-control-plane/protected-control-plane';
import { getSafeWorktreePathState } from '../workspace/worktree-path-state';
import {
    getSplitCheckpointWorkspaceSnapshot,
    parseSplitCheckpointDetectionSource,
    resolveAuthenticatedSplitCheckpointPreflightScope
} from '../split-required/split-checkpoint-scope';

/**
 * Detect the compile command profile (kind/strategy/label/failure/success profiles).
 * Matches Python get_compile_command_profile exactly.
 */
export function getCompileCommandProfile(command: string) {
    const normalized = (command || '').trim().toLowerCase();
    let kind = 'compile';
    let strategy = 'generic';
    let label = 'compile';

    const testPatterns = [
        /(^|\s)(pytest|nosetests|tox)(\s|$)/,
        /(^|\s)(jest|vitest|ava|mocha)(\s|$)/,
        /(^|\s)(playwright\s+test|cypress\s+run)(\s|$)/,
        /(^|\s)(go\s+test|cargo\s+test|dotnet\s+test)(\s|$)/,
        /(^|\s)(?:\.\/|\.\\)?mvnw(\.cmd)?(\s+.*)?\s+test(\s|$)/,
        /(^|\s)mvn(\s+.*)?\s+test(\s|$)/,
        /(^|\s)(?:\.\/|\.\\)?gradlew(\.bat)?(\s+.*)?\s+test(\s|$)/,
        /(^|\s)gradle(\s+.*)?\s+test(\s|$)/,
        /(^|\s)(npm|pnpm|yarn|bun)(\s+run)?\s+(test(?::[\w:-]+)?|e2e|coverage)(\s|$)/
    ];
    const lintPatterns = [
        /(^|\s)(eslint|stylelint|ruff(\s+check)?|flake8|mypy|pyright|shellcheck|hadolint|ktlint|golangci-lint|phpstan|psalm)(\s|$)/,
        /(^|\s)(npm|pnpm|yarn|bun)(\s+run)?\s+(lint|typecheck|check)(\s|$)/,
        /(^|\s)(cargo\s+clippy|dotnet\s+format|tsc(\s|$).*(--noemit|--no-emit))/
    ];

    if (testPatterns.some(p => p.test(normalized))) {
        kind = 'test'; strategy = 'test'; label = 'test';
    } else if (lintPatterns.some(p => p.test(normalized))) {
        kind = 'lint'; strategy = 'lint'; label = 'lint';
    } else if (/(^|\s)(?:\.\/|\.\\)?mvnw(\.cmd)?(\s|$)/.test(normalized) || /(^|\s)mvn(\s|$)/.test(normalized)) {
        strategy = 'maven'; label = 'maven';
    } else if (/(^|\s)(?:\.\/|\.\\)?gradlew(\.bat)?(\s|$)/.test(normalized) || /(^|\s)gradle(\s|$)/.test(normalized)) {
        strategy = 'gradle'; label = 'gradle';
    } else if (/(^|\s)(npm|pnpm|yarn|bun|npx|vite|webpack|turbo|nx)(\s|$)/.test(normalized)) {
        strategy = 'node'; label = 'node-build';
    } else if (/(^|\s)cargo(\s|$)/.test(normalized)) {
        strategy = 'cargo'; label = 'cargo';
    } else if (/(^|\s)dotnet(\s|$)/.test(normalized)) {
        strategy = 'dotnet'; label = 'dotnet';
    } else if (/(^|\s)go(\s|$)/.test(normalized)) {
        strategy = 'go'; label = 'go';
    }

    let failureProfile, successProfile;
    if (kind === 'test') {
        failureProfile = 'test_failure_console';
        successProfile = 'test_success_console';
    } else if (kind === 'lint') {
        failureProfile = 'lint_failure_console';
        successProfile = 'lint_success_console';
    } else {
        failureProfile = `compile_failure_console_${strategy}`;
        successProfile = 'compile_success_console';
    }

    return { kind, strategy, label, failure_profile: failureProfile, success_profile: successProfile };
}

export interface CompileCommandContractOptions {
    fullSuiteCommand?: string | null;
    allowFullTestCompileCommand?: boolean;
    allowFullTestCompileCommandReason?: string | null;
    allowUnconfiguredSentinel?: boolean;
}

function normalizeCompileCommandForContract(command: string): string {
    return String(command || '')
        .trim()
        .replace(/\\/g, '/')
        .replace(/\s+/g, ' ')
        .toLowerCase();
}

function commandTokensForContract(command: string): string[] {
    return normalizeCompileCommandForContract(command)
        .split(/\s+/)
        .map((token) => token.trim())
        .filter(Boolean);
}

function isMavenExecutableToken(token: string): boolean {
    const normalized = token.replace(/^\.?\//, '');
    return normalized === 'mvn' || normalized === 'mvnw' || normalized === 'mvnw.cmd';
}

function isGradleExecutableToken(token: string): boolean {
    const normalized = token.replace(/^\.?\//, '');
    return normalized === 'gradle' || normalized === 'gradlew' || normalized === 'gradlew.bat';
}

function hasMavenSkipTestsFlag(tokens: readonly string[]): boolean {
    return tokens.some((token) => (
        token === '-dskiptests'
        || token === '-dskiptests=true'
        || token === '-dmaven.test.skip=true'
    ));
}

function getMavenLifecycleViolation(command: string): string | null {
    const tokens = commandTokensForContract(command);
    const executableIndex = tokens.findIndex(isMavenExecutableToken);
    if (executableIndex < 0) {
        return null;
    }
    const testBoundPhases = new Set(['test', 'package', 'verify', 'install', 'deploy']);
    const goals = tokens.slice(executableIndex + 1).filter((token) => !token.startsWith('-'));
    const violatingGoal = goals.find((goal) => testBoundPhases.has(goal));
    if (!violatingGoal) {
        return null;
    }
    if (violatingGoal !== 'test' && hasMavenSkipTestsFlag(tokens)) {
        return null;
    }
    return `Maven phase '${violatingGoal}' is test-bound; use 'compile' or 'test-compile' for compile-gate, or move this command to full-suite validation.`;
}

function hasGradleExcludedTestTask(tokens: readonly string[]): boolean {
    return getGradleExcludedTestTasks(tokens).length > 0;
}

function getGradleTaskName(token: string): string {
    return token.split(':').filter(Boolean).pop() || token;
}

function getGradleProjectPath(token: string): string {
    const normalized = String(token || '').trim();
    if (!normalized.includes(':')) {
        return '';
    }
    const lastColonIndex = normalized.lastIndexOf(':');
    return lastColonIndex > 0 ? normalized.slice(0, lastColonIndex) : '';
}

function getGradleExcludedTestTasks(tokens: readonly string[]): string[] {
    const excludedTasks: string[] = [];
    for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index];
        let excludedTask: string | null = null;
        if (token === '-x' || token === '--exclude-task') {
            excludedTask = tokens[index + 1] || null;
        } else if (token.startsWith('--exclude-task=')) {
            excludedTask = token.slice('--exclude-task='.length);
        }
        if (excludedTask && getGradleTaskName(excludedTask) === 'test') {
            excludedTasks.push(excludedTask);
        }
    }
    return excludedTasks;
}

function isGradleBuildTaskTestExcluded(buildTask: string, excludedTestTasks: readonly string[]): boolean {
    if (excludedTestTasks.includes('test')) {
        return true;
    }
    const projectPath = getGradleProjectPath(buildTask);
    return projectPath !== '' && excludedTestTasks.some((excludedTask) => (
        getGradleTaskName(excludedTask) === 'test'
        && getGradleProjectPath(excludedTask) === projectPath
    ));
}

function getGradleTaskTokensForContract(tokens: readonly string[], executableIndex: number): string[] {
    const tasks: string[] = [];
    const rawTokens = tokens.slice(executableIndex + 1);
    for (let index = 0; index < rawTokens.length; index += 1) {
        const token = rawTokens[index];
        if (token === '-x' || token === '--exclude-task') {
            index += 1;
            continue;
        }
        if (token.startsWith('--exclude-task=')) {
            continue;
        }
        if (token.startsWith('-')) {
            continue;
        }
        tasks.push(token);
    }
    return tasks;
}

function isGradleTestTokenOnlyExcluded(command: string): boolean {
    const tokens = commandTokensForContract(command);
    const executableIndex = tokens.findIndex(isGradleExecutableToken);
    if (executableIndex < 0 || !hasGradleExcludedTestTask(tokens)) {
        return false;
    }
    return !getGradleTaskTokensForContract(tokens, executableIndex)
        .map(getGradleTaskName)
        .includes('test');
}

function getGradleLifecycleViolation(command: string): string | null {
    const tokens = commandTokensForContract(command);
    const executableIndex = tokens.findIndex(isGradleExecutableToken);
    if (executableIndex < 0) {
        return null;
    }
    const taskTokens = getGradleTaskTokensForContract(tokens, executableIndex);
    const taskNames = taskTokens.map(getGradleTaskName);
    if (taskNames.includes('test')) {
        return "Gradle task 'test' runs tests; use 'assemble', 'classes', or 'testClasses' for compile-gate, or move this command to full-suite validation.";
    }
    if (taskNames.includes('check')) {
        return "Gradle task 'check' is a verification lifecycle task; use 'assemble', 'classes', or 'testClasses' for compile-gate, or move this command to full-suite validation.";
    }
    const excludedTestTasks = getGradleExcludedTestTasks(tokens);
    const buildTasks = taskTokens.filter((task) => getGradleTaskName(task) === 'build');
    const hasUnexcludedBuildTask = buildTasks.some((task) => !isGradleBuildTaskTestExcluded(task, excludedTestTasks));
    if (hasUnexcludedBuildTask) {
        return "Gradle task 'build' normally depends on test/check tasks; use 'assemble', 'classes', or 'build -x test' for compile-gate, or move this command to full-suite validation.";
    }
    return null;
}

export function getCompileCommandContractViolations(
    command: string,
    options: CompileCommandContractOptions = {}
): string[] {
    const trimmedCommand = String(command || '').trim();
    const violations: string[] = [];
    if (!trimmedCommand) {
        return violations;
    }

    const configuredFullSuiteCommand = normalizeCompileCommandForContract(options.fullSuiteCommand || '');
    if (
        configuredFullSuiteCommand
        && normalizeCompileCommandForContract(trimmedCommand) === configuredFullSuiteCommand
    ) {
        violations.push('matches the configured full-suite validation command');
    }

    const profile = getCompileCommandProfile(trimmedCommand);
    if (profile.kind === 'test' && !isGradleTestTokenOnlyExcluded(trimmedCommand)) {
        violations.push('is classified as a test command');
    }

    const mavenViolation = getMavenLifecycleViolation(trimmedCommand);
    if (mavenViolation) {
        violations.push(mavenViolation);
    }
    const gradleViolation = getGradleLifecycleViolation(trimmedCommand);
    if (gradleViolation) {
        violations.push(gradleViolation);
    }

    return [...new Set(violations)];
}

function validateCompileCommandContract(
    command: string,
    rulePath: string,
    options: CompileCommandContractOptions
): void {
    const violations = getCompileCommandContractViolations(command, options);
    if (violations.length === 0) {
        return;
    }
    if (options.allowFullTestCompileCommand === true && String(options.allowFullTestCompileCommandReason || '').trim()) {
        return;
    }
    throw new Error(
        `Compile command must not run the full test suite in ${rulePath}: ${command}. `
        + `Reason: ${violations.join(' ')}. `
        + 'Use a compile/build/type-check command for compile-gate and keep test suites under full-suite-validation. '
        + 'If this repository has no separate compile command, rerun with --allow-full-test-compile-command and --allow-full-test-compile-command-reason after explicit operator approval.'
    );
}

export function validateCompileGateCommand(
    command: string,
    sourceLabel: string,
    options: CompileCommandContractOptions = {}
): void {
    const trimmedCommand = String(command || '').trim();
    if (!trimmedCommand) {
        throw new Error(`Compile command is missing in ${sourceLabel}.`);
    }
    if (trimmedCommand === UNCONFIGURED_COMPILE_GATE_COMMAND) {
        if (options.allowUnconfiguredSentinel) {
            return;
        }
        throw new Error(`Compile command is unconfigured in ${sourceLabel}: ${UNCONFIGURED_COMPILE_GATE_COMMAND}`);
    }
    if (/^\s*<[^>]+>\s*$/.test(trimmedCommand)) {
        throw new Error(`Compile command placeholder is unresolved in ${sourceLabel}: ${trimmedCommand}`);
    }
    if (/\borg\.apache\.maven\.wrapper\.mavenwrappermain\b/i.test(trimmedCommand)) {
        throw new Error(
            `Compile command anti-pattern detected in ${sourceLabel}: ` +
            "use wrapper entrypoint script (for example './mvnw' or '.\\mvnw.cmd') instead of MavenWrapperMain class invocation."
        );
    }
    validateCompileCommandContract(trimmedCommand, sourceLabel, options);
}

/**
 * Extract compile commands from a markdown rules file.
 * Matches Python get_compile_commands.
 */
export function getCompileCommands(rulePath: string, options: CompileCommandContractOptions = {}): string[] {
    const content = fs.readFileSync(rulePath, 'utf8');
    const lines = content.split(/\r?\n/);
    if (!lines.length) throw new Error(`Commands file is empty: ${rulePath}`);

    let sectionIndex = -1;
    for (let idx = 0; idx < lines.length; idx++) {
        if (lines[idx].trim() === '### Compile Gate (Mandatory)') {
            sectionIndex = idx;
            break;
        }
    }
    if (sectionIndex < 0) throw new Error(`Section '### Compile Gate (Mandatory)' not found in ${rulePath}`);

    let fenceStart = -1;
    for (let idx = sectionIndex + 1; idx < lines.length; idx++) {
        const stripped = lines[idx].trim();
        if (stripped.startsWith('```')) { fenceStart = idx; break; }
        if (stripped.startsWith('### ')) break;
    }
    if (fenceStart < 0) {
        throw new Error(`Code fence with compile command not found under '### Compile Gate (Mandatory)' in ${rulePath}`);
    }

    const commands = [];
    for (let idx = fenceStart + 1; idx < lines.length; idx++) {
        const stripped = lines[idx].trim();
        if (stripped.startsWith('```')) break;
        if (!stripped || stripped.startsWith('#')) continue;
        commands.push(stripped);
    }

    if (!commands.length) {
        throw new Error(`Compile command is missing under '### Compile Gate (Mandatory)' in ${rulePath}`);
    }

    for (const command of commands) {
        validateCompileGateCommand(command, rulePath, options);
    }

    return commands;
}

/**
 * Get output stats (warning and error line counts).
 */
export function getOutputStats(lines: string[]) {
    let warningLines = 0;
    let errorLines = 0;
    for (const line of lines) {
        if (/\bwarning\b/i.test(line)) warningLines++;
        if (/\berror\b/i.test(line)) errorLines++;
    }
    return { warningLines, errorLines };
}

/**
 * Extract the "new" file path from a numstat path-spec column.
 * Handles rename syntax: "old => new" and "{old => new}/suffix".
 */
export function extractNewPathFromNumstat(pathSpec: string): string {
    if (!pathSpec.includes(' => ')) return pathSpec;

    // Brace-style: "prefix/{old => new}/suffix" or "{old => new}"
    const braceMatch = pathSpec.match(/^(.*?)\{[^}]* => ([^}]*)\}(.*)$/);
    if (braceMatch) {
        return braceMatch[1] + braceMatch[2] + braceMatch[3];
    }

    // Simple style: "old => new"
    const arrowIndex = pathSpec.indexOf(' => ');
    return pathSpec.substring(arrowIndex + 4);
}

function getWorktreeContentFingerprint(repoRoot: string, relativePath: string): string {
    const normalized = normalizePath(relativePath);
    if (!normalized) {
        return 'missing';
    }
    const state = getSafeWorktreePathState(repoRoot, normalized);
    switch (state.status) {
        case 'file':
            return `worktree:file:${state.size ?? 0}:${state.sha256 || 'UNHASHABLE'}`;
        case 'directory':
            return 'worktree:dir';
        case 'symbolic_link':
            return [
                'worktree:symlink',
                state.size ?? 0,
                state.link_sha256 || 'UNHASHABLE',
                state.target_status || 'unknown',
                state.target_path || '',
                state.target_mode ?? 0,
                state.target_size ?? 0,
                state.target_sha256 || 'UNHASHABLE'
            ].join(':');
        case 'unreviewable_symlink':
            return [
                'worktree:unreviewable_symlink',
                state.size ?? 0,
                state.link_sha256 || 'UNHASHABLE',
                state.target_status || 'unknown',
                state.target_path || '',
                state.target_mode ?? 0,
                state.target_size ?? 0
            ].join(':');
        case 'outside_repo':
            return 'outside_repo';
        case 'special':
            return 'worktree:other';
        case 'missing':
        default:
            return 'missing';
    }
}

export function buildScopeContentFingerprint(
    repoRoot: string,
    source: string,
    changedFiles: string[],
    stagedBlobFingerprints?: StagedBlobFingerprints
): string | null {
    if (parseSplitCheckpointDetectionSource(source)) {
        if (changedFiles.length === 0) {
            return stringSha256('');
        }
        return getSplitCheckpointWorkspaceSnapshot(repoRoot, source, changedFiles).scope_content_sha256;
    }
    const useStaged = ['git_staged_only', 'git_staged_plus_untracked'].includes(source);
    const normalizedChangedFiles = [...new Set(changedFiles.map((entry) => normalizePath(entry)).filter(Boolean))]
        .sort();
    const resolvedStagedBlobFingerprints = useStaged
        ? stagedBlobFingerprints || readStagedBlobFingerprints(repoRoot, normalizedChangedFiles)
        : undefined;
    const fingerprintEntries = normalizedChangedFiles
        .map((relativePath) => {
            const stagedFingerprint = useStaged
                ? resolvedStagedBlobFingerprints?.get(relativePath) || null
                : null;
            return `${relativePath}:${stagedFingerprint || getWorktreeContentFingerprint(repoRoot, relativePath)}`;
        });
    return stringSha256(fingerprintEntries.join('\n'));
}

export interface WorkspaceSnapshotGitGeneration {
    readonly repo_root: string;
    readClassification(explicitUntrackedPaths: readonly string[]): GitChangeClassificationResult;
    readNumstat(useStaged: boolean): readonly string[];
    readStagedBlobFingerprints(relativePaths: readonly string[]): StagedBlobFingerprints;
}

const workspaceSnapshotGitGenerations = new WeakSet<WorkspaceSnapshotGitGeneration>();

function runWorkspaceSnapshotGitLines(repoRoot: string, args: string[], failMsg: string): string[] {
    const result = spawnSyncWithTimeout('git', ['-C', String(repoRoot), ...args], {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeoutMs: DEFAULT_GIT_TIMEOUT_MS,
        maxBuffer: 50 * 1024 * 1024
    });
    if (result.timedOut) {
        throw new Error(`${failMsg} git timed out after ${DEFAULT_GIT_TIMEOUT_MS} ms.`);
    }
    if (result.error) {
        throw new Error(`${failMsg} ${result.error.message || result.error}`);
    }
    if (result.status !== 0) {
        const errText = String(result.stderr || '').trim();
        throw new Error(`${failMsg} git exited with code ${result.status}. ${errText}`);
    }
    return String(result.stdout || '').split(/\r?\n/).filter((line) => line.trim());
}

function normalizeGenerationPaths(relativePaths: readonly string[]): string[] {
    return [...new Set(
        relativePaths
            .map((filePath) => normalizeGitRepoRelativePath(filePath))
            .filter((filePath): filePath is string => filePath !== null)
    )].sort();
}

export function createWorkspaceSnapshotGitGeneration(repoRoot: string): WorkspaceSnapshotGitGeneration {
    const resolvedRepoRoot = path.resolve(repoRoot);
    let classificationSnapshot: GitChangeClassificationSnapshot | null = null;
    const classifications = new Map<string, GitChangeClassificationResult>();
    const numstatByTarget = new Map<boolean, readonly string[]>();

    function readClassificationSnapshot(): GitChangeClassificationSnapshot {
        classificationSnapshot ??= collectGitChangeClassificationSnapshot(resolvedRepoRoot, {
            timeoutMs: DEFAULT_GIT_TIMEOUT_MS
        });
        return classificationSnapshot;
    }

    const generation = Object.freeze({
        repo_root: normalizePath(resolvedRepoRoot),
        readClassification(explicitUntrackedPaths: readonly string[]): GitChangeClassificationResult {
            const normalizedPaths = normalizeGenerationPaths(explicitUntrackedPaths);
            const key = normalizedPaths.join('\0');
            const cached = classifications.get(key);
            if (cached) return cached;
            const classification = deriveGitChangeClassification(
                resolvedRepoRoot,
                readClassificationSnapshot(),
                normalizedPaths
            );
            classifications.set(key, classification);
            return classification;
        },
        readNumstat(useStaged: boolean): readonly string[] {
            const cached = numstatByTarget.get(useStaged);
            if (cached) return cached;
            const args = ['diff', '--numstat', '--diff-filter=ACDMRTUXB', useStaged ? '--cached' : 'HEAD'];
            const rows = Object.freeze(runWorkspaceSnapshotGitLines(
                resolvedRepoRoot,
                args,
                'Failed to collect changed files snapshot.'
            ));
            numstatByTarget.set(useStaged, rows);
            return rows;
        },
        readStagedBlobFingerprints(relativePaths: readonly string[]): StagedBlobFingerprints {
            const snapshot = readClassificationSnapshot();
            const fingerprints = new Map<string, string>();
            for (const relativePath of normalizeGenerationPaths(relativePaths)) {
                const fingerprint = snapshot.stagedBlobFingerprints.get(relativePath);
                if (fingerprint) fingerprints.set(relativePath, fingerprint);
            }
            return fingerprints;
        }
    });
    workspaceSnapshotGitGenerations.add(generation);
    return generation;
}

function authenticateWorkspaceSnapshotGitGeneration(
    repoRoot: string,
    generation?: WorkspaceSnapshotGitGeneration
): WorkspaceSnapshotGitGeneration | null {
    if (!generation) return null;
    if (
        !workspaceSnapshotGitGenerations.has(generation)
        || path.resolve(generation.repo_root) !== path.resolve(repoRoot)
    ) {
        throw new Error('Workspace Git generation is not factory-authenticated for the requested repository root.');
    }
    return generation;
}

/**
 * Get workspace snapshot for scope validation.
 * Matches Python get_workspace_snapshot.
 */
export function getWorkspaceSnapshot(
    repoRoot: string,
    detectionSource: string,
    includeUntracked: boolean,
    explicitChangedFiles: string[],
    gitGeneration?: WorkspaceSnapshotGitGeneration
) {
    const authenticatedGitGeneration = authenticateWorkspaceSnapshotGitGeneration(repoRoot, gitGeneration);
    const source = (detectionSource || 'git_auto').trim().toLowerCase();
    if (parseSplitCheckpointDetectionSource(source)) {
        const snapshot = getSplitCheckpointWorkspaceSnapshot(repoRoot, source, explicitChangedFiles);
        return {
            ...snapshot,
            git_change_classification: null,
            authorized_files: snapshot.changed_files,
            authorized_files_count: snapshot.changed_files_count,
            authorized_files_sha256: snapshot.changed_files_sha256
        };
    }
    const useStaged = ['git_staged_only', 'git_staged_plus_untracked'].includes(source);
    if (source === 'git_staged_only') includeUntracked = false;
    const snapshotCacheRelativePath = normalizePath(
        path.relative(repoRoot, joinOrchestratorPath(repoRoot, path.join('runtime', 'cache', 'workspace-snapshot.json')))
    );
    function isInternalSnapshotCachePath(relativePath: string): boolean {
        const normalized = normalizePath(relativePath);
        return !!normalized && normalized === snapshotCacheRelativePath;
    }
    function isIgnoredWorkspaceSnapshotPath(relativePath: string): boolean {
        return isInternalSnapshotCachePath(relativePath) || isGeneratedOrchestratorLockPath(relativePath);
    }
    const isSourceCheckout = isOrchestratorSourceCheckout(repoRoot);
    const generatedRuntimeSplitOptions = { isSourceCheckout };

    const rawExplicitSplit = splitGeneratedRuntimeControlPlaneArtifacts(
        (explicitChangedFiles || []).map((filePath) => {
            const normalizedPath = normalizePath(filePath);
            return normalizedPath ? path.posix.normalize(normalizedPath) : '';
        }),
        generatedRuntimeSplitOptions
    );
    const allNormalizedExplicit = [...new Set(
        rawExplicitSplit.reviewableFiles
            .map((f: string) => normalizeGitRepoRelativePath(f))
            .filter((f): f is string => f !== null)
    )]
        .filter((item: string) => !isIgnoredWorkspaceSnapshotPath(item))
        .sort();
    const explicitSplit = splitGeneratedRuntimeControlPlaneArtifacts(allNormalizedExplicit, generatedRuntimeSplitOptions);
    const normalizedExplicit = explicitSplit.reviewableFiles;
    const ignoredGeneratedRuntimeFiles = [
        ...rawExplicitSplit.ignoredGeneratedRuntimeFiles,
        ...explicitSplit.ignoredGeneratedRuntimeFiles
    ];
    const changedFileStats: Record<string, { additions: number; deletions: number; changed_lines: number }> = {};

    if (source === 'explicit_changed_files') {
        const selectedGitLayers: GitChangeLayer[] = [
            'staged',
            'unstaged',
            ...(includeUntracked ? ['untracked' as const] : [])
        ];
        const explicitUntrackedPaths = includeUntracked ? normalizedExplicit : [];
        const completeGitClassification = authenticatedGitGeneration
            ? authenticatedGitGeneration.readClassification(explicitUntrackedPaths)
            : classifyGitChanges(repoRoot, {
                timeoutMs: DEFAULT_GIT_TIMEOUT_MS,
                explicitUntrackedPaths
            });
        const explicitLayerClassification = selectGitChangeClassificationLayers(completeGitClassification, {
            layers: selectedGitLayers,
            paths: normalizedExplicit,
            context: `workspace snapshot detection_source=${source}`
        });
        const canonicalSplit = splitGeneratedRuntimeControlPlaneArtifacts(
            explicitLayerClassification.effectiveChangedFiles
                .filter((item) => !isIgnoredWorkspaceSnapshotPath(item)),
            generatedRuntimeSplitOptions
        );
        ignoredGeneratedRuntimeFiles.push(...canonicalSplit.ignoredGeneratedRuntimeFiles);
        const normalizedChanged = [...new Set(canonicalSplit.reviewableFiles)].sort();
        const normalizedChangedSet = new Set(normalizedChanged);
        const gitChangeClassification = selectGitChangeClassificationLayers(completeGitClassification, {
            layers: selectedGitLayers,
            paths: normalizedChanged,
            context: `workspace snapshot detection_source=${source}`
        });

        let additionsTotal = 0, deletionsTotal = 0;
        if (normalizedExplicit.length > 0) {
            const numstatLines = authenticatedGitGeneration
                ? authenticatedGitGeneration.readNumstat(false)
                : runWorkspaceSnapshotGitLines(
                    repoRoot,
                    ['diff', '--numstat', '--diff-filter=ACDMRTUXB', 'HEAD', '--', ...normalizedExplicit],
                    'Failed numstat'
                );
            for (const line of numstatLines) {
                const parts = line.split('\t');
                if (parts.length >= 3) {
                    const changedPath = normalizePath(extractNewPathFromNumstat(parts.slice(2).join('\t')));
                    if (!changedPath || isIgnoredWorkspaceSnapshotPath(changedPath)) continue;
                    if (!normalizedChangedSet.has(changedPath)) continue;
                    const additions = /^\d+$/.test(parts[0]) ? parseInt(parts[0], 10) : 0;
                    const deletions = /^\d+$/.test(parts[1]) ? parseInt(parts[1], 10) : 0;
                    additionsTotal += additions;
                    deletionsTotal += deletions;
                    changedFileStats[changedPath] = {
                        additions,
                        deletions,
                        changed_lines: additions + deletions
                    };
                }
            }
        }

        if (includeUntracked) {
            for (const item of gitChangeClassification.untrackedFiles) {
                const additions = countWorktreeFileLines(repoRoot, item);
                additionsTotal += additions;
                changedFileStats[item] = {
                    additions,
                    deletions: 0,
                    changed_lines: additions
                };
            }
        }
        for (const item of normalizedChanged) {
            changedFileStats[item] ??= { additions: 0, deletions: 0, changed_lines: 0 };
        }

        const changedLinesTotal = additionsTotal + deletionsTotal;
        const filesFingerprint = stringSha256(normalizedChanged.join('\n'));
        const authorizedFilesFingerprint = stringSha256(normalizedExplicit.join('\n'));
        const contentFingerprint = buildScopeContentFingerprint(repoRoot, source, normalizedChanged);
        const scopeFingerprint = stringSha256(
            `${source}|false|${includeUntracked}|${normalizedExplicit.length}|${authorizedFilesFingerprint}|` +
            `${normalizedChanged.length}|${changedLinesTotal}|${filesFingerprint}|${contentFingerprint}`
        );

        return {
            detection_source: source, use_staged: false, include_untracked: !!includeUntracked,
            git_change_classification: buildGitChangeClassificationEvidence(gitChangeClassification),
            authorized_files: normalizedExplicit,
            authorized_files_count: normalizedExplicit.length,
            authorized_files_sha256: authorizedFilesFingerprint,
            changed_files: normalizedChanged, changed_files_count: normalizedChanged.length,
            ignored_generated_runtime_files: [...new Set(ignoredGeneratedRuntimeFiles)].sort(),
            ignored_generated_runtime_files_count: new Set(ignoredGeneratedRuntimeFiles).size,
            additions_total: additionsTotal, deletions_total: deletionsTotal,
            changed_lines_total: changedLinesTotal,
            changed_file_stats: changedFileStats,
            changed_files_sha256: filesFingerprint,
            scope_content_sha256: contentFingerprint,
            scope_sha256: scopeFingerprint
        };
    }

    const selectedGitLayers: GitChangeLayer[] = useStaged
        ? ['staged', ...(includeUntracked ? ['untracked' as const] : [])]
        : ['staged', 'unstaged', ...(includeUntracked ? ['untracked' as const] : [])];
    const completeGitClassification = authenticatedGitGeneration
        ? authenticatedGitGeneration.readClassification([])
        : classifyGitChanges(repoRoot, {
            timeoutMs: DEFAULT_GIT_TIMEOUT_MS
        });
    const layerClassification = selectGitChangeClassificationLayers(completeGitClassification, {
        layers: selectedGitLayers,
        context: `workspace snapshot detection_source=${source}`
    });
    const canonicalCandidates = layerClassification.effectiveChangedFiles
        .filter((item) => !isIgnoredWorkspaceSnapshotPath(item));
    const canonicalSplit = splitGeneratedRuntimeControlPlaneArtifacts(
        canonicalCandidates,
        generatedRuntimeSplitOptions
    );
    ignoredGeneratedRuntimeFiles.push(...canonicalSplit.ignoredGeneratedRuntimeFiles);
    const normalizedChanged = [...new Set(canonicalSplit.reviewableFiles)].sort();
    const normalizedChangedSet = new Set(normalizedChanged);
    const gitChangeClassification = selectGitChangeClassificationLayers(completeGitClassification, {
        layers: selectedGitLayers,
        paths: normalizedChanged,
        context: `workspace snapshot detection_source=${source}`
    });

    const diffArgs = ['diff', '--numstat', '--diff-filter=ACDMRTUXB'];
    diffArgs.push(useStaged ? '--cached' : 'HEAD');
    const numstatOutput = authenticatedGitGeneration
        ? authenticatedGitGeneration.readNumstat(useStaged)
        : runWorkspaceSnapshotGitLines(repoRoot, diffArgs, 'Failed to collect changed files snapshot.');

    // Extract both file names and line counts from the single numstat call
    const diffFileStats: Record<string, { additions: number; deletions: number; changed_lines: number }> = {};
    let additionsTotal = 0, deletionsTotal = 0;
    for (const row of numstatOutput) {
        const parts = row.split('\t');
        if (parts.length < 3) continue;
        const filePath = extractNewPathFromNumstat(parts.slice(2).join('\t'));
        const normalizedFilePath = normalizePath(filePath);
        if (!normalizedFilePath || isIgnoredWorkspaceSnapshotPath(normalizedFilePath)) continue;
        if (!normalizedChangedSet.has(normalizedFilePath)) continue;
        const additions = /^\d+$/.test(parts[0]) ? parseInt(parts[0], 10) : 0;
        const deletions = /^\d+$/.test(parts[1]) ? parseInt(parts[1], 10) : 0;
        additionsTotal += additions;
        deletionsTotal += deletions;
        diffFileStats[normalizedFilePath] = {
            additions,
            deletions,
            changed_lines: additions + deletions
        };
    }

    if (includeUntracked) {
        for (const item of gitChangeClassification.untrackedFiles) {
            const additions = countWorktreeFileLines(repoRoot, item);
            additionsTotal += additions;
            diffFileStats[item] = {
                additions,
                deletions: 0,
                changed_lines: additions
            };
        }
    }
    for (const item of normalizedChanged) {
        diffFileStats[item] ??= { additions: 0, deletions: 0, changed_lines: 0 };
    }

    const changedLinesTotal = additionsTotal + deletionsTotal;
    const filesFingerprint = stringSha256(normalizedChanged.join('\n'));
    const contentFingerprint = buildScopeContentFingerprint(
        repoRoot,
        source,
        normalizedChanged,
        useStaged
            ? authenticatedGitGeneration?.readStagedBlobFingerprints(normalizedChanged)
            : undefined
    );
    const scopeFingerprint = stringSha256(
        `${source}|${useStaged}|${includeUntracked}|${normalizedChanged.length}|${changedLinesTotal}|${filesFingerprint}|${contentFingerprint}`
    );

    return {
        detection_source: source, use_staged: useStaged, include_untracked: !!includeUntracked,
        git_change_classification: buildGitChangeClassificationEvidence(gitChangeClassification),
        authorized_files: normalizedChanged,
        authorized_files_count: normalizedChanged.length,
        authorized_files_sha256: filesFingerprint,
        changed_files: normalizedChanged, changed_files_count: normalizedChanged.length,
        ignored_generated_runtime_files: [...new Set(ignoredGeneratedRuntimeFiles)].sort(),
        ignored_generated_runtime_files_count: new Set(ignoredGeneratedRuntimeFiles).size,
        additions_total: additionsTotal, deletions_total: deletionsTotal,
        changed_lines_total: changedLinesTotal,
        changed_file_stats: diffFileStats,
        changed_files_sha256: filesFingerprint,
        scope_content_sha256: contentFingerprint,
        scope_sha256: scopeFingerprint
    };
}

function countWorktreeFileLines(repoRoot: string, relativePath: string): number {
    const normalized = normalizePath(relativePath);
    if (!normalized || getSafeWorktreePathState(repoRoot, normalized).status !== 'file') {
        return 0;
    }
    return countFileLines(path.join(repoRoot, normalized));
}

function resolvePreflightContainingGitRoot(preflightPath: string): string {
    let candidate = path.dirname(path.resolve(preflightPath));
    while (true) {
        if (fs.existsSync(path.join(candidate, '.git'))) {
            return candidate;
        }
        const parent = path.dirname(candidate);
        if (parent === candidate) {
            throw new Error('Unable to resolve a git root containing preflight artifact ' + preflightPath + '.');
        }
        candidate = parent;
    }
}

/**
 * Get preflight context for scope validation.
 */
export function getPreflightContext(preflightPath: string, taskId: string) {
    if (!preflightPath || !fs.existsSync(preflightPath)) {
        throw new Error(`Preflight artifact not found: ${preflightPath}`);
    }
    let preflightObject;
    try {
        preflightObject = JSON.parse(fs.readFileSync(preflightPath, 'utf8'));
    } catch {
        throw new Error(`Preflight artifact is not valid JSON: ${preflightPath}`);
    }

    const preflightTaskId = String(preflightObject.task_id || '').trim();
    if (preflightTaskId && preflightTaskId !== taskId) {
        throw new Error(`TaskId '${taskId}' does not match preflight.task_id '${preflightTaskId}'.`);
    }
    if (!('changed_files' in preflightObject)) throw new Error('Preflight field `changed_files` is required.');
    if (!preflightObject.metrics || typeof preflightObject.metrics !== 'object') {
        throw new Error('Preflight field `metrics` is required.');
    }
    const metrics = preflightObject.metrics as Record<string, unknown>;
    if (!preflightObject.required_reviews || typeof preflightObject.required_reviews !== 'object') {
        throw new Error('Preflight field `required_reviews` is required.');
    }

    const preflightChangedFiles = [...new Set(
        (preflightObject.changed_files || []).map((f: string) => normalizePath(String(f).replace(/\\/g, '/'))).filter(Boolean)
    )].sort();
    const preflightAuthorizedFiles: string[] = [...new Set<string>(
        (Array.isArray(preflightObject.authorized_files)
            ? preflightObject.authorized_files
            : preflightObject.changed_files || [])
            .map((f: string) => normalizePath(String(f).replace(/\\/g, '/')))
            .filter(Boolean)
    )].sort();

    const changedLinesTotal = metrics.changed_lines_total;
    if (typeof changedLinesTotal !== 'number' || changedLinesTotal < 0) {
        throw new Error('Preflight field `metrics.changed_lines_total` is required and must be non-negative.');
    }

    const detectionSource = String(preflightObject.detection_source || 'git_auto').trim() || 'git_auto';
    if (parseSplitCheckpointDetectionSource(detectionSource)) {
        resolveAuthenticatedSplitCheckpointPreflightScope(
            resolvePreflightContainingGitRoot(preflightPath),
            taskId,
            detectionSource,
            preflightChangedFiles
        );
    }
    const includeUntracked = parseSplitCheckpointDetectionSource(detectionSource)
        ? false
        : detectionSource.toLowerCase() !== 'git_staged_only';
    const scopeSha256 = typeof metrics.scope_sha256 === 'string'
        ? metrics.scope_sha256.trim().toLowerCase()
        : null;
    const scopeContentSha256 = typeof metrics.scope_content_sha256 === 'string'
        ? metrics.scope_content_sha256.trim().toLowerCase()
        : null;
    const actualChangedFilesSha256 = typeof metrics.actual_changed_files_sha256 === 'string'
        ? metrics.actual_changed_files_sha256.trim().toLowerCase()
        : null;

    return {
        preflight: preflightObject,
        task_id: taskId,
        detection_source: detectionSource,
        include_untracked: includeUntracked,
        authorized_files: preflightAuthorizedFiles,
        authorized_files_count: preflightAuthorizedFiles.length,
        changed_files: preflightChangedFiles,
        changed_files_count: preflightChangedFiles.length,
        changed_lines_total: changedLinesTotal,
        changed_files_sha256: actualChangedFilesSha256 || stringSha256(preflightChangedFiles.join('\n')),
        scope_sha256: scopeSha256 || null,
        scope_content_sha256: scopeContentSha256 || null,
        budget_forecast: preflightObject.budget_forecast ?? null
    };
}
