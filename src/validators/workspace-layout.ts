import { TASK_QUEUE_FILENAME } from '../core/orchestration-constants';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    CLI_ENTRYPOINT_CANDIDATES,
    DEFAULT_BUNDLE_NAME,
    getSourceCliCommand,
    PRIMARY_CLI_ENTRYPOINT,
    resolveBundleName,
    resolveBundleNameForTarget,
    SOURCE_TO_ENTRYPOINT_MAP
} from '../core/constants';
import { pathExists, readTextFile } from '../core/filesystem';
import { normalizeProviderId } from '../core/provider-registry';
import { isSourceCheckoutRoot } from './workspace-layout/source-runtime';

export {
    buildForcedSourceCheckoutRuntimeBuildCommand,
    detectSourceCheckoutRuntimeStaleness
} from './workspace-layout/source-runtime';
export type { SourceCheckoutRuntimeStalenessResult } from './workspace-layout/source-runtime';

function resolveCliRelativePathCandidates(bundleName: string): string[] {
    return CLI_ENTRYPOINT_CANDIDATES.map((entrypoint) => `${bundleName}/${entrypoint}`);
}

function resolveExistingCliPath(rootPath: string, bundleName?: string): string {
    const candidates = bundleName
        ? CLI_ENTRYPOINT_CANDIDATES.map((entrypoint) => path.join(rootPath, bundleName, entrypoint))
        : CLI_ENTRYPOINT_CANDIDATES.map((entrypoint) => path.join(rootPath, entrypoint));
    for (const candidate of candidates) {
        if (pathExists(candidate)) {
            return candidate;
        }
    }
    return bundleName
        ? path.join(rootPath, bundleName, PRIMARY_CLI_ENTRYPOINT)
        : path.join(rootPath, PRIMARY_CLI_ENTRYPOINT);
}

export function getBaseRequiredPaths(): readonly string[] {
    const bundleName = DEFAULT_BUNDLE_NAME;
    return Object.freeze([
        TASK_QUEUE_FILENAME,
        `${bundleName}/.gitattributes`,
        `${bundleName}/VERSION`,
        `${bundleName}/package.json`,
        `${bundleName}/dist/src`,
        `${bundleName}/dist/src/index.js`,
        `${bundleName}/dist/src/cli`,
        `${bundleName}/dist/src/materialization`,
        `${bundleName}/dist/src/validators`,
        `${bundleName}/dist/src/gates`,
        `${bundleName}/dist/src/lifecycle`,
        `${bundleName}/AGENT_INIT_PROMPT.md`,
        `${bundleName}/HOW_TO.md`,
        `${bundleName}/MANIFEST.md`,
        `${bundleName}/live/version.json`,
        `${bundleName}/live/config/review-capabilities.json`,
        `${bundleName}/live/config/paths.json`,
        `${bundleName}/live/config/token-economy.json`,
        `${bundleName}/live/config/output-filters.json`,
        `${bundleName}/live/config/skill-packs.json`,
        `${bundleName}/live/config/isolation-mode.json`,
        `${bundleName}/live/config/profiles.json`,
        `${bundleName}/live/config/skills-index.json`,
        `${bundleName}/live/config/skills-headlines.json`,
        `${bundleName}/live/config/garda.config.json`,
        `${bundleName}/template/config/garda.config.json`,
        `${bundleName}/live/skills/README.md`,
        `${bundleName}/live/docs/agent-rules/80-task-workflow.md`,
        `${bundleName}/live/skills/code-review/skill.json`,
        `${bundleName}/live/skills/db-review/skill.json`,
        `${bundleName}/live/skills/dependency-review/SKILL.md`,
        `${bundleName}/live/skills/dependency-review/skill.json`,
        `${bundleName}/live/skills/orchestration/SKILL.md`,
        `${bundleName}/live/skills/orchestration/skill.json`,
        `${bundleName}/live/skills/orchestration-depth1/skill.json`,
        `${bundleName}/live/skills/skill-builder/SKILL.md`,
        `${bundleName}/live/skills/skill-builder/skill.json`,
        `${bundleName}/live/skills/security-review/SKILL.md`,
        `${bundleName}/live/skills/security-review/skill.json`,
        `${bundleName}/live/skills/refactor-review/SKILL.md`,
        `${bundleName}/live/skills/refactor-review/skill.json`,
        `${bundleName}/live/init-report.md`,
        `${bundleName}/live/project-discovery.md`,
        `${bundleName}/live/source-inventory.md`,
        `${bundleName}/live/USAGE.md`,
        ...resolveCliRelativePathCandidates(bundleName)
    ]);
}

/**
 * Required workspace paths that must exist after a full install.
 * Matches the deployed Node-only bundle surface.
 * Uses the fixed deployed bundle name.
 */
export const BASE_REQUIRED_PATHS = getBaseRequiredPaths();

export const RULE_FILES = Object.freeze([
    '00-core.md',
    '10-project-context.md',
    '15-project-memory.md',
    '20-architecture.md',
    '30-code-style.md',
    '35-strict-coding-rules.md',
    '40-commands.md',
    '50-structure-and-docs.md',
    '60-operating-rules.md',
    '70-security.md',
    '80-task-workflow.md',
    '90-skill-catalog.md'
]);

export const OPTIONAL_RULE_SUPPORT_FILES = Object.freeze([
    '40-command-reference.md'
]);

export const PROJECT_COMMAND_PLACEHOLDERS = Object.freeze([
    '<install dependencies command>',
    '<local environment bootstrap command>',
    '<start backend command>',
    '<start frontend command>',
    '<start worker or background job command>',
    '<unit test command>',
    '<integration test command>',
    '<e2e test command>',
    '<lint command>',
    '<type-check command>',
    '<format check command>',
    '<compile command>',
    '<build command>',
    '<container or artifact packaging command>'
]);

export const TEMPLATE_PLACEHOLDER_PATTERN = /{{[A-Z0-9_]+}}/;

export const MANAGED_START = '<!-- garda-agent-orchestrator:managed-start -->';
export const MANAGED_END = '<!-- garda-agent-orchestrator:managed-end -->';

export const CRITICAL_BUNDLE_PATHS = Object.freeze([
    ...CLI_ENTRYPOINT_CANDIDATES,
    'dist/src/index.js',
    'package.json',
    'VERSION',
    'template/AGENTS.md',
    'template/entrypoints/canonical-rule-index.md',
    'template/config/garda.config.json'
]);

export const BUNDLE_RUNTIME_INVENTORY_PATHS = Object.freeze([
    'runtime/init-answers.json',
    'live/config/review-capabilities.json',
    'live/config/paths.json',
    'live/config/token-economy.json',
    'live/config/output-filters.json',
    'live/config/skill-packs.json',
    'live/config/isolation-mode.json',
    'live/config/profiles.json',
    'live/config/runtime-retention.json',
    'live/config/skills-index.json',
    'live/config/skills-headlines.json',
    'live/config/garda.config.json'
]);

export const FORBIDDEN_DEPLOYED_BUNDLE_PATHS = Object.freeze([
    '.node-build'
]);

interface BuildRequiredPathsOptions {
    activeAgentFiles?: readonly string[];
    claudeOrchestratorFullAccess?: boolean;
    bundleName?: string;
}

interface RuleFileViolations {
    ruleFileViolations: string[];
    templatePlaceholderViolations: string[];
}

interface VersionViolationResult {
    violations: string[];
    bundleVersion: string | null;
}

export interface SourceBundleParityResult {
    isSourceCheckout: boolean;
    isStale: boolean;
    violations: string[];
    rootVersion: string | null;
    bundleVersion: string | null;
    remediation: string | null;
}

export function getCanonicalEntrypoint(sourceOfTruth: string): string | null {
    const match = normalizeProviderId(sourceOfTruth);
    return match ? SOURCE_TO_ENTRYPOINT_MAP[match as keyof typeof SOURCE_TO_ENTRYPOINT_MAP] : null;
}

export function getBundlePath(targetRoot: string, bundleName?: string): string {
    return path.join(targetRoot, resolveBundleNameForTarget(targetRoot, bundleName));
}

export function buildRequiredPaths(options: BuildRequiredPathsOptions): string[] {
    const activeAgentFiles = options.activeAgentFiles || [];
    const claudeOrchestratorFullAccess = options.claudeOrchestratorFullAccess || false;
    const effectiveBundleName = resolveBundleName();

    const paths: string[] = [...getBaseRequiredPaths()];

    for (const ruleFile of RULE_FILES) {
        paths.push(`${effectiveBundleName}/live/docs/agent-rules/${ruleFile}`);
    }
    for (const supportFile of OPTIONAL_RULE_SUPPORT_FILES) {
        paths.push(`${effectiveBundleName}/live/docs/agent-rules/${supportFile}`);
    }

    for (const file of activeAgentFiles) {
        if (!paths.includes(file)) {
            paths.push(file);
        }
    }

    if (claudeOrchestratorFullAccess) {
        paths.push('.claude/settings.local.json');
    }

    return Array.from(new Set(paths)).sort();
}

export function detectMissingPaths(targetRoot: string, requiredPaths: readonly string[]): string[] {
    const missing: string[] = [];
    for (const requiredPath of requiredPaths) {
        if (!pathExists(path.join(targetRoot, requiredPath))) {
            missing.push(requiredPath);
        }
    }
    return missing;
}

export function getCommandsRulePath(bundlePath: string): string {
    return path.join(bundlePath, 'live', 'docs', 'agent-rules', '40-commands.md');
}

export function readUtf8IfExists(filePath: string): string | null {
    try {
        if (!pathExists(filePath)) return null;
        const stats = fs.lstatSync(filePath);
        if (!stats.isFile()) return null;
        return readTextFile(filePath);
    } catch {
        return null;
    }
}

export function getMissingProjectCommands(commandsContent: string | null): string[] {
    if (!commandsContent) {
        return [...PROJECT_COMMAND_PLACEHOLDERS];
    }

    return PROJECT_COMMAND_PLACEHOLDERS.filter(function (placeholder) {
        return commandsContent.includes(placeholder);
    });
}

export function extractManagedBlock(content: string | null): string | null {
    if (!content) return null;
    const startEscaped = MANAGED_START.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const endEscaped = MANAGED_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(startEscaped + '[\\s\\S]*?' + endEscaped);
    const match = content.match(pattern);
    return match ? match[0] : null;
}

export function detectRuleFileViolations(targetRoot: string): RuleFileViolations {
    const ruleFileViolations: string[] = [];
    const templatePlaceholderViolations: string[] = [];

    for (const ruleFile of RULE_FILES) {
        const relativePath = `${resolveBundleName()}/live/docs/agent-rules/${ruleFile}`;
        const fullPath = path.join(targetRoot, relativePath);
        if (!pathExists(fullPath)) {
            continue;
        }

        const content = readTextFile(fullPath);
        if (!content || !content.trim()) {
            ruleFileViolations.push(`Rule file is empty: ${relativePath}`);
        }
        if (TEMPLATE_PLACEHOLDER_PATTERN.test(content)) {
            templatePlaceholderViolations.push(`Unresolved template placeholder in: ${relativePath}`);
        }
    }

    return { ruleFileViolations, templatePlaceholderViolations };
}

export function detectSourceBundleParity(targetRoot: string): SourceBundleParityResult {
    const isSourceCheckout = isSourceCheckoutRoot(targetRoot);

    const result: SourceBundleParityResult = {
        isSourceCheckout,
        isStale: false,
        violations: [],
        rootVersion: null,
        bundleVersion: null,
        remediation: null
    };

    if (!isSourceCheckout) {
        return result;
    }

    const rootVersionPath = path.join(targetRoot, 'VERSION');
    if (pathExists(rootVersionPath)) {
        result.rootVersion = readTextFile(rootVersionPath).trim();
    }

    const bundlePath = getBundlePath(targetRoot);
    const bundleVersionPath = path.join(bundlePath, 'VERSION');
    if (pathExists(bundleVersionPath)) {
        result.bundleVersion = readTextFile(bundleVersionPath).trim();
    }

    if (result.rootVersion && result.bundleVersion && result.rootVersion !== result.bundleVersion) {
        result.isStale = true;
        result.violations.push(
            `Deployed bundle version '${result.bundleVersion}' does not match source checkout version '${result.rootVersion}'.`
        );
    }

    const rootLauncherPath = resolveExistingCliPath(targetRoot);
    const bundleLauncherPath = resolveExistingCliPath(targetRoot, resolveBundleName());
    if (pathExists(rootLauncherPath) && pathExists(bundleLauncherPath)) {
        const rootStat = fs.statSync(rootLauncherPath);
        const bundleStat = fs.statSync(bundleLauncherPath);
        if (rootStat.mtimeMs > bundleStat.mtimeMs + 1000) {
            result.isStale = true;
            result.violations.push(
                `Deployed bundle launcher '${resolveBundleName()}/${PRIMARY_CLI_ENTRYPOINT}' is older than source launcher '${PRIMARY_CLI_ENTRYPOINT}'. ` +
                `Source was updated at ${rootStat.mtime.toISOString()} but bundle has ${bundleStat.mtime.toISOString()}.`
            );
        }
    }

    const invariantResult = validateBundleInvariants(bundlePath);
    if (!invariantResult.isValid) {
        result.isStale = true;
        for (const violation of invariantResult.violations) {
            result.violations.push(`Bundle invariant violation: ${violation}`);
        }
    }

    if (result.isStale) {
        result.remediation = `Run 'npm run build' followed by '${getSourceCliCommand()} setup' or 'reinit' to update the deployed bundle.`;
    }

    return result;
}

export function getExpectedBundleInvariantPaths(sourceBundleRoot?: string | null): string[] {
    if (!sourceBundleRoot) {
        return [...CRITICAL_BUNDLE_PATHS, ...BUNDLE_RUNTIME_INVENTORY_PATHS];
    }

    const expected = new Set<string>();
    const hasExecutableSurface = [
        'package.json',
        ...CLI_ENTRYPOINT_CANDIDATES,
        'dist/src/index.js'
    ].some(function (relPath) {
        return pathExists(path.join(sourceBundleRoot, relPath));
    });

    if (hasExecutableSurface) {
        for (const relPath of CRITICAL_BUNDLE_PATHS) {
            expected.add(relPath);
        }
    } else {
        for (const relPath of CRITICAL_BUNDLE_PATHS) {
            if (pathExists(path.join(sourceBundleRoot, relPath))) {
                expected.add(relPath);
            }
        }
    }

    for (const relPath of BUNDLE_RUNTIME_INVENTORY_PATHS) {
        if (pathExists(path.join(sourceBundleRoot, relPath))) {
            expected.add(relPath);
        }
    }

    if (expected.size === 0) {
        return [...CRITICAL_BUNDLE_PATHS, ...BUNDLE_RUNTIME_INVENTORY_PATHS];
    }

    return Array.from(expected);
}

export function validateBundleInvariants(
    bundlePath: string,
    sourceBundleRootOrExpectedPaths?: string | readonly string[] | null
): { isValid: boolean; violations: string[] } {
    const violations: string[] = [];

    if (!pathExists(bundlePath)) {
        violations.push(`Bundle directory '${path.basename(bundlePath)}' is missing.`);
        return { isValid: false, violations };
    }

    const expectedPaths = Array.isArray(sourceBundleRootOrExpectedPaths)
        ? [...sourceBundleRootOrExpectedPaths]
        : getExpectedBundleInvariantPaths(
            typeof sourceBundleRootOrExpectedPaths === 'string' || sourceBundleRootOrExpectedPaths == null
                ? sourceBundleRootOrExpectedPaths
                : null
        );

    for (const relPath of expectedPaths) {
        if (!pathExists(path.join(bundlePath, relPath))) {
            if (CRITICAL_BUNDLE_PATHS.includes(relPath as typeof CRITICAL_BUNDLE_PATHS[number])) {
                violations.push(`Required bundle file '${relPath}' is missing.`);
            } else {
                violations.push(`Required bundle inventory '${relPath}' is missing.`);
            }
        }
    }

    for (const relPath of FORBIDDEN_DEPLOYED_BUNDLE_PATHS) {
        if (pathExists(path.join(bundlePath, relPath))) {
            violations.push(`Forbidden deployed bundle path '${relPath}' is present.`);
        }
    }

    return { isValid: violations.length === 0, violations };
}

export function detectManagedConfigViolations(targetRoot: string, configRelativePath: string): string[] {
    const violations: string[] = [];
    const configPath = path.join(targetRoot, configRelativePath);

    if (!pathExists(configPath)) {
        violations.push(`${configRelativePath} is missing.`);
        return violations;
    }

    try {
        JSON.parse(readTextFile(configPath));
    } catch {
        violations.push(`${configRelativePath} must contain valid JSON.`);
    }

    return violations;
}

export function detectVersionViolations(
    targetRoot: string,
    sourceOfTruth: string,
    canonicalEntrypoint: string | null
): VersionViolationResult {
    const violations: string[] = [];
    const bn = resolveBundleName();
    const bundleVersionPath = path.join(targetRoot, bn, 'VERSION');
    const liveVersionPath = path.join(targetRoot, bn, 'live', 'version.json');

    let bundleVersion: string | null = null;

    if (pathExists(bundleVersionPath)) {
        bundleVersion = readTextFile(bundleVersionPath).trim();
        if (!bundleVersion) {
            violations.push(`${bn}/VERSION must not be empty.`);
        }
    }

    if (pathExists(liveVersionPath)) {
        let liveVersionObject: Record<string, unknown>;
        try {
            const parsed = JSON.parse(readTextFile(liveVersionPath));
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                throw new Error('Invalid JSON root');
            }
            liveVersionObject = parsed as Record<string, unknown>;
        } catch {
            violations.push(`${bn}/live/version.json must contain valid JSON.`);
            return { violations, bundleVersion };
        }

        const liveVersion = liveVersionObject.Version ? String(liveVersionObject.Version).trim() : '';
        if (!liveVersion) {
            violations.push(`${bn}/live/version.json must include non-empty Version.`);
        } else if (bundleVersion && liveVersion !== bundleVersion) {
            violations.push(
                `${bn}/live/version.json Version '${liveVersion}' must match ${bn}/VERSION '${bundleVersion}'.`
            );
        }

        const liveSourceOfTruth = liveVersionObject.SourceOfTruth ? String(liveVersionObject.SourceOfTruth).trim() : '';
        if (!liveSourceOfTruth) {
            violations.push(`${bn}/live/version.json must include non-empty SourceOfTruth.`);
        } else if (liveSourceOfTruth.toLowerCase() !== sourceOfTruth.toLowerCase()) {
            violations.push(
                `${bn}/live/version.json SourceOfTruth '${liveSourceOfTruth}' must match verification SourceOfTruth '${sourceOfTruth}'.`
            );
        }

        const liveCanonicalEntrypoint = liveVersionObject.CanonicalEntrypoint ? String(liveVersionObject.CanonicalEntrypoint).trim() : '';
        if (!liveCanonicalEntrypoint) {
            violations.push(`${bn}/live/version.json must include non-empty CanonicalEntrypoint.`);
        } else if (canonicalEntrypoint && liveCanonicalEntrypoint !== canonicalEntrypoint) {
            violations.push(
                `${bn}/live/version.json CanonicalEntrypoint '${liveCanonicalEntrypoint}' must match expected '${canonicalEntrypoint}'.`
            );
        }
    }

    return { violations, bundleVersion };
}

export function detectGitignoreViolations(targetRoot: string, requiredEntries: readonly string[]): string[] {
    const gitignorePath = path.join(targetRoot, '.gitignore');
    if (!pathExists(gitignorePath)) {
        return [...requiredEntries];
    }

    const existingLines = readTextFile(gitignorePath).split(/\r?\n/);
    const missing: string[] = [];

    for (const entry of requiredEntries) {
        if (!existingLines.includes(entry)) {
            missing.push(entry);
        }
    }

    return missing;
}

export function detectManagedMarkers(filePath: string): { hasStart: boolean; hasEnd: boolean } {
    const content = readUtf8IfExists(filePath);
    if (!content) return { hasStart: false, hasEnd: false };
    return {
        hasStart: content.includes(MANAGED_START),
        hasEnd: content.includes(MANAGED_END)
    };
}

export function detectMissingManagedEntries(filePath: string, requiredEntries: readonly string[]): string[] {
    const content = readUtf8IfExists(filePath);
    if (!content) return [...requiredEntries];

    const existingLines = content.split(/\r?\n/).map(function (line) { return line.trim(); });
    const missing: string[] = [];
    for (const entry of requiredEntries) {
        if (!existingLines.includes(entry.trim())) {
            missing.push(entry);
        }
    }
    return missing;
}

export interface NestedBundleDuplicationResult {
    duplicatesFound: boolean;
    duplicatePaths: string[];
}

/**
 * Detect nested deployed bundles that would cause IDEs and language services
 * to index two copies of the same codebase. Scans immediate children of the
 * deployed bundle directory for another garda-agent-orchestrator tree.
 */
export function detectNestedBundleDuplication(targetRoot: string, bundleName?: string): NestedBundleDuplicationResult {
    const duplicatePaths: string[] = [];
    const effectiveName = resolveBundleName(bundleName);
    const bundlePath = getBundlePath(targetRoot, effectiveName);

    if (!pathExists(bundlePath)) {
        return { duplicatesFound: false, duplicatePaths };
    }

    // Check for nested bundle inside the deployed bundle
    const nestedBundlePath = path.join(bundlePath, effectiveName);
    if (pathExists(nestedBundlePath)) {
        const nestedLauncherPaths = CLI_ENTRYPOINT_CANDIDATES.map((entrypoint) => path.join(nestedBundlePath, entrypoint));
        if (nestedLauncherPaths.some(pathExists)) {
            duplicatePaths.push(
                path.join(effectiveName, effectiveName).replace(/\\/g, '/')
            );
        }
    }

    // Check for dist/ inside the bundle containing another compiled tree
    const bundleDistSrc = path.join(bundlePath, 'dist', 'src');
    const bundleDistSrcMat = path.join(bundleDistSrc, 'materialization');
    if (pathExists(bundleDistSrc) && pathExists(bundleDistSrcMat)) {
        const nestedNodeModules = path.join(bundlePath, 'node_modules');
        if (pathExists(nestedNodeModules)) {
            duplicatePaths.push(
                (effectiveName + '/node_modules').replace(/\\/g, '/')
            );
        }
    }

    return {
        duplicatesFound: duplicatePaths.length > 0,
        duplicatePaths
    };
}
