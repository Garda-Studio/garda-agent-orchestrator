import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
    formatNodeFoundationTestMarker,
    NODE_FOUNDATION_TEST_MARKERS
} from '../../src/core/node-foundation-test-shard-markers';
import {
    buildNodeFoundationShardFailureDiagnostics,
    hasGreenNodeTestSummaryContent
} from '../../src/core/node-foundation-test-shard-log-analysis';
import { buildNodeFoundation, buildPublishRuntime, BuildResult } from './build';
import { ShardOutputForwarder } from './shard-output-forwarding';
import {
    addDurationReporterOptions,
    calibrateDurationWeights,
    createShardDurationCapture,
    FileDurationObservation,
    formatDurationForecastAccuracy,
    SHARD_DURATION_OUTPUT_ENV
} from './test-duration-telemetry';

const NODE_FOUNDATION_TEST_SHARDS_ENV = 'GARDA_NODE_FOUNDATION_TEST_SHARDS';
const NODE_FOUNDATION_TEST_SHARD_LOG_DIR_ENV = 'GARDA_NODE_FOUNDATION_TEST_SHARD_LOG_DIR';
const NODE_FOUNDATION_TEST_SHARD_TIMEOUT_MS_ENV = 'GARDA_NODE_FOUNDATION_TEST_SHARD_TIMEOUT_MS';
const NODE_FOUNDATION_TEST_SHARD_HEARTBEAT_MS_ENV = 'GARDA_NODE_FOUNDATION_TEST_SHARD_HEARTBEAT_MS';
const NODE_FOUNDATION_TEST_SHARD_CONCURRENCY_ENV = 'GARDA_NODE_FOUNDATION_TEST_SHARD_CONCURRENCY';
const NODE_FOUNDATION_TEST_DURATION_FILE_ENV = 'GARDA_NODE_FOUNDATION_TEST_DURATION_FILE';
const DURATION_REPORTER_URL = pathToFileURL(path.join(__dirname, 'test-duration-reporter.js')).href;
const NODE_FOUNDATION_TEST_DURATION_LOCK_TIMEOUT_MS = 30_000;
const NODE_FOUNDATION_TEST_DURATION_LOCK_RETRY_MS = 25;
const NODE_FOUNDATION_TEST_DURATION_LOCK_STALE_MS = 120_000;
const NODE_FOUNDATION_AUTO_SHARD_ARG_CHAR_LIMIT = 24_000;
const NODE_FOUNDATION_TEST_SLOWEST_REPORT_COUNT = 10;
const DEFAULT_NODE_FOUNDATION_TEST_SHARD_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_NODE_FOUNDATION_TEST_SHARD_HEARTBEAT_MS = 60 * 1000;
const NODE_FOUNDATION_TEST_SHARD_CLEANUP_GRACE_MS = 1_000;
const NODE_FOUNDATION_TEST_GREEN_EXIT_ISOLATION_MAX_FILES = 12;
const NODE_FOUNDATION_TEST_GREEN_EXIT_ISOLATION_TIMEOUT_MS = 30_000;
const DEFAULT_NODE_FOUNDATION_TEST_SHARD_CONCURRENCY = 2;
const DEFAULT_SHARDED_NODE_TEST_CONCURRENCY_MAX = 4;
const NODE_FOUNDATION_AUTO_SHARD_MAX_FILES = 32;
const GARDA_SHARDS_OPTION = '--garda-shards';
const GARDA_SHARD_CONCURRENCY_OPTION = '--garda-shard-concurrency';
const GARDA_SHARD_LOG_DIR_OPTION = '--garda-shard-log-dir';
const GARDA_DURATION_FILE_OPTION = '--garda-duration-file';
const NODE_FOUNDATION_BASELINE_SINGLE_FILE_SHARD_MIN_DURATION_MS = 60_000;
const NODE_FOUNDATION_SINGLE_FILE_SHARD_MIN_DURATION_MS = 4 * 60_000;
const NODE_FOUNDATION_ISOLATED_TEST_PATHS = new Set<string>([
    'tests/node/cli/commands/gates/completion/gates-completion-rollback.test.ts',
    'tests/node/cli/commands/gates/review-cycle/gates-review-cycle-restart.test.ts',
    'tests/node/cli/commands/gates/review-cycle/gates-review-cycle-remediation-ignored-changelog-guards.test.ts',
    'tests/node/cli/commands/gates/review-reuse/gates-review-reuse-historical-rejections.test.ts',
    'tests/node/cli/commands/gates/review-reuse/gates-review-reuse-upstream.test.ts',
    'tests/node/cli/commands/task-events-human-format.test.ts',
    'tests/node/gate-runtime/task-timeline-performance-acceptance.test.ts',
    'tests/node/gates/diagnostics/shell-smoke-preflight.test.ts',
    'tests/node/gates/compile/full-suite-validation-cli-transaction.test.ts'
]);
const NODE_FOUNDATION_SERIAL_TEST_PATHS = new Set<string>([
    'tests/node/bin/garda-delegation.test.ts',
    'tests/node/core/subprocess.test.ts',
    'tests/node/cli/commands/gates/diagnostics/gates-command-timeout.test.ts',
    'tests/node/cli/commands/gates/preflight/gates-dirty-workspace.test.ts',
    'tests/node/cli/commands/gates/review-launch/gates-command-review-launch-prepared-1.test.ts',
    'tests/node/cli/commands/gates/review-launch/gates-command-review-launch-prepared-2.test.ts',
    'tests/node/cli/commands/gates/review-launch/gates-command-review-launch-prepared-3.test.ts',
    'tests/node/cli/commands/gates/review-launch/gates-command-review-launch-prepared-4.test.ts',
    'tests/node/cli/commands/gates/review-launch/gates-command-review-launch-prepared-5.test.ts',
    'tests/node/cli/commands/gates/task-mode/gates-workflow-config-policy.test.ts',
    'tests/node/cli/commands/profile.test.ts',
    'tests/node/gate-runtime/review-artifacts.test.ts',
    'tests/node/gate-runtime/task-events-locks.test.ts',
    'tests/node/gates/next-step/next-step-review-failure-routing.test.ts',
    'tests/node/reports/local-ui-server-network.test.ts'
]);

const NODE_TEST_OPTIONS_WITH_VALUE = new Set<string>([
    '--test-name-pattern',
    '--test-skip-pattern',
    '--test-reporter',
    '--test-reporter-destination',
    '--test-concurrency',
    '--test-timeout',
    '--test-shard',
    '--watch-path'
]);
const NODE_TEST_PARTIAL_SELECTION_OPTIONS = [
    '--test-name-pattern',
    '--test-skip-pattern',
    '--test-only',
    '--test-shard'
] as const;

function normalizeCliPath(value: string): string {
    return value.replace(/\\/g, '/');
}

function collectCompiledNodeFoundationTestFiles(buildResult: BuildResult): string[] {
    return buildResult.copiedFiles
        .filter((relativePath: string) => relativePath.startsWith('tests/node/') && relativePath.endsWith('.test.js'))
        .map((relativePath: string) => path.join(buildResult.buildRoot, ...relativePath.split('/')));
}

function readOptionValue(args: string[], index: number, optionName: string): { value: string; consumedNext: boolean; } {
    const arg = args[index];
    if (arg.startsWith(`${optionName}=`)) {
        return { value: arg.slice(optionName.length + 1), consumedNext: false };
    }
    const value = args[index + 1];
    if (!value) {
        throw new Error(`Missing value for ${optionName}.`);
    }
    return { value, consumedNext: true };
}

function parsePositiveInteger(value: string, label: string): number {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1) {
        throw new Error(`${label} must be a positive integer.`);
    }
    return parsed;
}

function parseNonNegativeInteger(value: string, label: string): number {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 0) {
        throw new Error(`${label} must be a non-negative integer.`);
    }
    return parsed;
}

function splitForwardedTestArgs(forwardedArgs: string[]): {
    optionArgs: string[];
    fileTargets: string[];
    requestedShardCount: number | null;
    requestedShardConcurrency: number | null;
    requestedShardLogDir: string | null;
    requestedDurationFile: string | null;
} {
    const optionArgs: string[] = [];
    const fileTargets: string[] = [];
    let requestedShardCount: number | null = null;
    let requestedShardConcurrency: number | null = null;
    let requestedShardLogDir: string | null = null;
    let requestedDurationFile: string | null = null;
    let expectsOptionValue = false;
    let positionalOnly = false;

    for (let index = 0; index < forwardedArgs.length; index += 1) {
        const arg = forwardedArgs[index];
        if (expectsOptionValue) {
            optionArgs.push(arg);
            expectsOptionValue = false;
            continue;
        }

        if (positionalOnly) {
            fileTargets.push(arg);
            continue;
        }

        if (arg === '--') {
            optionArgs.push(arg);
            positionalOnly = true;
            continue;
        }

        if (arg === GARDA_SHARDS_OPTION || arg.startsWith(`${GARDA_SHARDS_OPTION}=`)) {
            const { value, consumedNext } = readOptionValue(forwardedArgs, index, GARDA_SHARDS_OPTION);
            requestedShardCount = parsePositiveInteger(value, GARDA_SHARDS_OPTION);
            if (consumedNext) {
                index += 1;
            }
            continue;
        }

        if (arg === GARDA_SHARD_CONCURRENCY_OPTION || arg.startsWith(`${GARDA_SHARD_CONCURRENCY_OPTION}=`)) {
            const { value, consumedNext } = readOptionValue(forwardedArgs, index, GARDA_SHARD_CONCURRENCY_OPTION);
            requestedShardConcurrency = parsePositiveInteger(value, GARDA_SHARD_CONCURRENCY_OPTION);
            if (consumedNext) {
                index += 1;
            }
            continue;
        }

        if (arg === GARDA_SHARD_LOG_DIR_OPTION || arg.startsWith(`${GARDA_SHARD_LOG_DIR_OPTION}=`)) {
            const { value, consumedNext } = readOptionValue(forwardedArgs, index, GARDA_SHARD_LOG_DIR_OPTION);
            requestedShardLogDir = value;
            if (consumedNext) {
                index += 1;
            }
            continue;
        }

        if (arg === GARDA_DURATION_FILE_OPTION || arg.startsWith(`${GARDA_DURATION_FILE_OPTION}=`)) {
            const { value, consumedNext } = readOptionValue(forwardedArgs, index, GARDA_DURATION_FILE_OPTION);
            requestedDurationFile = value;
            if (consumedNext) {
                index += 1;
            }
            continue;
        }

        if (arg.startsWith('--')) {
            optionArgs.push(arg);
            if (!arg.includes('=') && NODE_TEST_OPTIONS_WITH_VALUE.has(arg)) {
                expectsOptionValue = true;
            }
            continue;
        }

        if (arg.startsWith('-') && arg !== '-') {
            optionArgs.push(arg);
            continue;
        }

        fileTargets.push(arg);
    }

    if (expectsOptionValue) {
        throw new Error(`Missing value for Node test option '${optionArgs[optionArgs.length - 1]}'.`);
    }

    return {
        optionArgs,
        fileTargets,
        requestedShardCount,
        requestedShardConcurrency,
        requestedShardLogDir,
        requestedDurationFile
    };
}

function findPartialTestSelectionOption(optionArgs: readonly string[]): string | null {
    for (const arg of optionArgs) {
        const matchedOption = NODE_TEST_PARTIAL_SELECTION_OPTIONS.find(
            (option) => arg === option || arg.startsWith(`${option}=`)
        );
        if (matchedOption) {
            return matchedOption;
        }
    }
    return null;
}

function buildCompiledTestLookup(buildResult: BuildResult, compiledTestFiles: string[]): Map<string, string> {
    const lookup = new Map<string, string>();

    const addCandidate = (candidate: string, compiledPath: string): void => {
        const normalized = normalizeCliPath(candidate).replace(/^\.\//, '');
        if (!normalized || lookup.has(normalized)) {
            return;
        }
        lookup.set(normalized, compiledPath);
    };

    for (const compiledPath of compiledTestFiles) {
        const compiledRelative = normalizeCliPath(path.relative(buildResult.buildRoot, compiledPath));
        const compiledRepoRelative = normalizeCliPath(path.relative(buildResult.repoRoot, compiledPath));
        const sourceRelativeTs = compiledRelative.replace(/\.js$/i, '.ts');

        addCandidate(compiledRelative, compiledPath);
        addCandidate(`./${compiledRelative}`, compiledPath);
        addCandidate(compiledRepoRelative, compiledPath);
        addCandidate(`./${compiledRepoRelative}`, compiledPath);
        addCandidate(sourceRelativeTs, compiledPath);
        addCandidate(`./${sourceRelativeTs}`, compiledPath);
    }

    return lookup;
}

function collectTestFilesUnderDir(dirPath: string): string[] {
    if (!fs.existsSync(dirPath)) {
        return [];
    }
    const stat = fs.statSync(dirPath);
    if (!stat.isDirectory()) {
        return [];
    }
    const results: string[] = [];
    for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
        const entryPath = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
            results.push(...collectTestFilesUnderDir(entryPath));
        } else if (entry.isFile() && entry.name.endsWith('.test.js')) {
            results.push(entryPath);
        }
    }
    return results.sort();
}

function resolveCompiledTestDirectoryTargets(
    buildResult: BuildResult,
    target: string
): string[] {
    const normalizedTarget = normalizeCliPath(target).replace(/^\.\//,  '');
    const repoRelativeTarget = normalizeCliPath(path.relative(buildResult.repoRoot, path.resolve(buildResult.repoRoot, target)));

    const dirCandidates = [normalizedTarget, repoRelativeTarget];
    for (const candidate of dirCandidates) {
        const strippedCandidate = candidate.replace(/^\.\//,  '');
        let compiledDirPath: string | null = null;
        if (strippedCandidate.startsWith('tests/node/')) {
            compiledDirPath = path.join(buildResult.buildRoot, ...strippedCandidate.split('/'));
        } else if (strippedCandidate.startsWith('.node-build/tests/node/')) {
            compiledDirPath = path.join(buildResult.repoRoot, ...strippedCandidate.split('/'));
        }
        if (compiledDirPath !== null) {
            const files = collectTestFilesUnderDir(compiledDirPath);
            if (files.length > 0) {
                return files;
            }
        }
    }
    return [];
}

function resolveCompiledTestTarget(
    buildResult: BuildResult,
    compiledTestLookup: Map<string, string>,
    target: string
): string | null {
    const normalizedTarget = normalizeCliPath(target).replace(/^\.\//,  '');
    const repoRelativeTarget = normalizeCliPath(path.relative(buildResult.repoRoot, path.resolve(buildResult.repoRoot, target)));
    const candidates = new Set<string>([normalizedTarget, repoRelativeTarget]);

    if (path.isAbsolute(target)) {
        const absoluteTarget = path.resolve(target);
        const relativeToBuildRoot = normalizeCliPath(path.relative(buildResult.buildRoot, absoluteTarget));
        if (!relativeToBuildRoot.startsWith('../') && !relativeToBuildRoot.startsWith('..\\')) {
            return absoluteTarget;
        }
    }

    for (const candidate of Array.from(candidates)) {
        if (candidate.endsWith('.ts')) {
            candidates.add(candidate.replace(/\.ts$/i, '.js'));
        }
    }

    for (const candidate of candidates) {
        const compiledPath = compiledTestLookup.get(candidate);
        if (compiledPath) {
            return compiledPath;
        }
    }

    for (const candidate of candidates) {
        const normalizedCandidate = candidate.replace(/^\.\//,  '');
        if (normalizedCandidate.startsWith('tests/node/')) {
            const compiledPath = path.join(buildResult.buildRoot, ...normalizedCandidate.replace(/\.ts$/i, '.js').split('/'));
            if (fs.existsSync(compiledPath)) {
                return compiledPath;
            }
        }
        if (normalizedCandidate.startsWith('.node-build/tests/node/')) {
            const compiledPath = path.join(buildResult.repoRoot, ...normalizedCandidate.split('/'));
            if (fs.existsSync(compiledPath)) {
                return compiledPath;
            }
        }
    }

    return null;
}

function resolveSelectedTestFiles(buildResult: BuildResult, compiledTestFiles: string[], fileTargets: string[]): string[] {
    if (fileTargets.length === 0) {
        return compiledTestFiles;
    }

    const compiledTestLookup = buildCompiledTestLookup(buildResult, compiledTestFiles);
    const selectedTestFiles: string[] = [];
    const seen = new Set<string>();

    for (const fileTarget of fileTargets) {
        // First, try to expand as a directory target.
        const dirFiles = resolveCompiledTestDirectoryTargets(buildResult, fileTarget);
        if (dirFiles.length > 0) {
            for (const dirFile of dirFiles) {
                if (!seen.has(dirFile)) {
                    seen.add(dirFile);
                    selectedTestFiles.push(dirFile);
                }
            }
            continue;
        }

        // Fall back to single file resolution.
        const compiledPath = resolveCompiledTestTarget(buildResult, compiledTestLookup, fileTarget);
        if (!compiledPath) {
            throw new Error(`Unable to resolve targeted Node foundation test path: ${fileTarget}`);
        }
        if (seen.has(compiledPath)) {
            continue;
        }
        seen.add(compiledPath);
        selectedTestFiles.push(compiledPath);
    }

    if (selectedTestFiles.length === 0) {
        throw new Error('No targeted Node foundation tests matched the requested file filters.');
    }

    return selectedTestFiles;
}

function hasExplicitTestShardOption(optionArgs: string[]): boolean {
    return optionArgs.some((arg) => arg === '--test-shard' || arg.startsWith('--test-shard='));
}

function estimateWindowsCommandLineArgChars(arg: string): number {
    if (arg.length > 0 && !/[ \t"]/u.test(arg)) {
        return arg.length;
    }
    let serializedChars = 2;
    let pendingBackslashes = 0;
    for (const char of arg) {
        if (char === '\\') {
            pendingBackslashes += 1;
        } else if (char === '"') {
            serializedChars += (pendingBackslashes * 2) + 2;
            pendingBackslashes = 0;
        } else {
            serializedChars += pendingBackslashes + char.length;
            pendingBackslashes = 0;
        }
    }
    return serializedChars + (pendingBackslashes * 2);
}

function buildNodeTestFileArgs(repoRoot: string, selectedTestFiles: readonly string[]): string[] {
    const resolvedRepoRoot = path.resolve(repoRoot);
    return selectedTestFiles.map((file) => {
        const absoluteFile = path.isAbsolute(file)
            ? path.resolve(file)
            : path.resolve(resolvedRepoRoot, file);
        const relativeFile = path.relative(resolvedRepoRoot, absoluteFile);
        const isOutsideRepo = (
            relativeFile === '..'
            || relativeFile.startsWith(`..${path.sep}`)
            || path.isAbsolute(relativeFile)
        );
        return relativeFile && !isOutsideRepo ? relativeFile : absoluteFile;
    });
}

function estimateNodeTestArgChars(
    repoRoot: string,
    optionArgs: string[],
    selectedTestFiles: string[]
): number {
    const args = [
        process.execPath,
        '--test',
        ...optionArgs,
        ...buildNodeTestFileArgs(repoRoot, selectedTestFiles)
    ];
    return args.reduce(
        (total, arg, index) => total + estimateWindowsCommandLineArgChars(arg) + (index === 0 ? 0 : 1),
        0
    );
}

function assertNodeTestArgCharsWithinLimit(
    repoRoot: string,
    optionArgs: string[],
    selectedTestFiles: string[]
): void {
    const estimatedArgChars = estimateNodeTestArgChars(repoRoot, optionArgs, selectedTestFiles);
    if (estimatedArgChars <= NODE_FOUNDATION_AUTO_SHARD_ARG_CHAR_LIMIT) {
        return;
    }
    throw new Error(
        `Node test shard command line exceeds ${NODE_FOUNDATION_AUTO_SHARD_ARG_CHAR_LIMIT} characters `
        + `(estimated ${estimatedArgChars}, files ${selectedTestFiles.length}).`
    );
}

function resolveCommandLineSafeShardCount(
    repoRoot: string,
    selectedTestFiles: string[],
    optionArgs: string[]
): number {
    if (selectedTestFiles.length <= 1) {
        return 1;
    }
    const estimatedArgChars = estimateNodeTestArgChars(repoRoot, optionArgs, selectedTestFiles);
    if (estimatedArgChars <= NODE_FOUNDATION_AUTO_SHARD_ARG_CHAR_LIMIT) {
        return 1;
    }
    return Math.max(2, Math.min(
        selectedTestFiles.length,
        Math.ceil(estimatedArgChars / NODE_FOUNDATION_AUTO_SHARD_ARG_CHAR_LIMIT)
    ));
}

function resolveAutoShardCount(repoRoot: string, selectedTestFiles: string[], optionArgs: string[]): number {
    const fileCountShardCount = Math.ceil(selectedTestFiles.length / NODE_FOUNDATION_AUTO_SHARD_MAX_FILES);
    return Math.min(
        selectedTestFiles.length,
        Math.max(
            fileCountShardCount,
            resolveCommandLineSafeShardCount(repoRoot, selectedTestFiles, optionArgs)
        )
    );
}

function resolveNodeFoundationShardCount(
    repoRoot: string,
    selectedTestFiles: string[],
    optionArgs: string[],
    _fileTargets: string[],
    requestedShardCount: number | null
): number {
    // Disable sharding only when an explicit --test-shard option is provided (manual shard selection).
    // Directory fileTargets expand to multiple files and should still benefit from GARDA_NODE_FOUNDATION_TEST_SHARDS.
    // Single-file targets still get shardCount=1 naturally since min(parsed, 1)=1.
    if (hasExplicitTestShardOption(optionArgs)) {
        return 1;
    }

    if (requestedShardCount !== null) {
        return Math.max(1, Math.min(requestedShardCount, selectedTestFiles.length));
    }

    const rawValue = String(process.env[NODE_FOUNDATION_TEST_SHARDS_ENV] || '').trim();
    if (!rawValue) {
        return resolveAutoShardCount(repoRoot, selectedTestFiles, optionArgs);
    }

    const parsed = parsePositiveInteger(rawValue, NODE_FOUNDATION_TEST_SHARDS_ENV);

    return Math.max(1, Math.min(parsed, selectedTestFiles.length));
}

interface TestDurationTelemetryEntry {
    file: string;
    duration_ms: number;
    samples: number;
    updated_at_utc: string;
}

interface TestDurationTelemetry {
    schema_version: 1;
    updated_at_utc: string;
    entries: Record<string, TestDurationTelemetryEntry>;
}

interface TestFileWeight {
    file: string;
    key: string;
    weight: number;
    durationMs: number | null;
    fallbackSize: number;
    estimatedDurationMs: number | null;
}

interface NodeTestShardResult {
    exitCode: number;
    durationMs: number;
    shardFiles: string[];
    shardIndex: number;
    shardCount: number;
    logPath: string;
    timedOut?: boolean;
    fileDurations?: FileDurationObservation[];
}

interface NodeTestShardRuntimeConfig {
    timeoutMs: number;
    heartbeatMs: number;
    concurrency: number;
    defaultNodeTestConcurrency: number | null;
}

interface NodeFoundationTestExecutionPlan {
    parallelFiles: string[];
    isolatedFiles: string[];
    serialFiles: string[];
}

interface NodeFoundationTestShardScheduleSummary {
    thresholdMs: number;
    groupedShardCount: number;
    isolatedFileCount: number;
    serialFileCount: number;
    scheduledShardCount: number;
    maxWorkerProcesses: number;
    knownDurationFiles: number;
    totalFiles: number;
    estimatedWallMs: number;
}

function resolveNodeTestShardRuntimeConfig(
    requestedShardConcurrency: number | null = null
): NodeTestShardRuntimeConfig {
    const configuredTimeout = String(process.env[NODE_FOUNDATION_TEST_SHARD_TIMEOUT_MS_ENV] || '').trim();
    const configuredHeartbeat = String(process.env[NODE_FOUNDATION_TEST_SHARD_HEARTBEAT_MS_ENV] || '').trim();
    const configuredConcurrency = String(process.env[NODE_FOUNDATION_TEST_SHARD_CONCURRENCY_ENV] || '').trim();
    const concurrency = requestedShardConcurrency !== null
        ? requestedShardConcurrency
        : configuredConcurrency
            ? parsePositiveInteger(configuredConcurrency, NODE_FOUNDATION_TEST_SHARD_CONCURRENCY_ENV)
            : DEFAULT_NODE_FOUNDATION_TEST_SHARD_CONCURRENCY;
    return {
        timeoutMs: configuredTimeout
            ? parseNonNegativeInteger(configuredTimeout, NODE_FOUNDATION_TEST_SHARD_TIMEOUT_MS_ENV)
            : DEFAULT_NODE_FOUNDATION_TEST_SHARD_TIMEOUT_MS,
        heartbeatMs: configuredHeartbeat
            ? parseNonNegativeInteger(configuredHeartbeat, NODE_FOUNDATION_TEST_SHARD_HEARTBEAT_MS_ENV)
            : DEFAULT_NODE_FOUNDATION_TEST_SHARD_HEARTBEAT_MS,
        concurrency,
        defaultNodeTestConcurrency: null
    };
}

function resolveDefaultShardedNodeTestConcurrency(
    runtimeConfig: NodeTestShardRuntimeConfig
): number {
    const maxWorkerProcesses = Math.max(1, runtimeConfig.concurrency);
    return Math.max(1, Math.min(
        DEFAULT_SHARDED_NODE_TEST_CONCURRENCY_MAX,
        Math.floor(os.availableParallelism() / maxWorkerProcesses)
    ));
}

function hasExplicitNodeTestOption(optionArgs: string[], optionName: string): boolean {
    return optionArgs.some((arg) => arg === optionName || arg.startsWith(`${optionName}=`));
}

function buildNodeTestShardOptionArgs(optionArgs: string[], runtimeConfig: NodeTestShardRuntimeConfig): string[] {
    if (
        runtimeConfig.defaultNodeTestConcurrency === null
        || hasExplicitNodeTestOption(optionArgs, '--test-concurrency')
    ) {
        return optionArgs;
    }
    return [`--test-concurrency=${runtimeConfig.defaultNodeTestConcurrency}`, ...optionArgs];
}

function describeNodeTestConcurrency(optionArgs: string[], runtimeConfig: NodeTestShardRuntimeConfig): string {
    if (hasExplicitNodeTestOption(optionArgs, '--test-concurrency')) {
        return 'explicit';
    }
    return runtimeConfig.defaultNodeTestConcurrency === null
        ? 'inherit'
        : String(runtimeConfig.defaultNodeTestConcurrency);
}

function resolveNodeFoundationRuntimeDir(repoRoot: string): string {
    const nestedRoot = path.join(repoRoot, 'garda-agent-orchestrator');
    if (fs.existsSync(nestedRoot) && fs.statSync(nestedRoot).isDirectory()) {
        return path.join(nestedRoot, 'runtime');
    }
    return path.join(repoRoot, 'runtime');
}

function resolveDurationTelemetryPath(repoRoot: string, requestedDurationFile: string | null): string {
    const configured = requestedDurationFile || String(process.env[NODE_FOUNDATION_TEST_DURATION_FILE_ENV] || '').trim();
    if (configured) {
        return path.resolve(repoRoot, configured);
    }
    return path.join(resolveNodeFoundationRuntimeDir(repoRoot), 'metrics', 'node-foundation-test-duration-telemetry.json');
}

function isTestDurationTelemetryEntry(value: unknown): value is TestDurationTelemetryEntry {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }
    const record = value as Record<string, unknown>;
    return typeof record.file === 'string'
        && typeof record.duration_ms === 'number'
        && Number.isFinite(record.duration_ms)
        && record.duration_ms > 0
        && typeof record.samples === 'number'
        && Number.isFinite(record.samples)
        && record.samples > 0
        && typeof record.updated_at_utc === 'string';
}

function readTestDurationTelemetry(telemetryPath: string): TestDurationTelemetry {
    const empty: TestDurationTelemetry = {
        schema_version: 1,
        updated_at_utc: new Date(0).toISOString(),
        entries: {}
    };
    if (!fs.existsSync(telemetryPath)) {
        return empty;
    }
    try {
        const parsed = JSON.parse(fs.readFileSync(telemetryPath, 'utf8')) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            console.warn(`NODE_FOUNDATION_TEST_DURATION_TELEMETRY_IGNORED malformed ${telemetryPath}`);
            return empty;
        }
        const rawEntries = (parsed as { entries?: unknown }).entries;
        if (!rawEntries || typeof rawEntries !== 'object' || Array.isArray(rawEntries)) {
            console.warn(`NODE_FOUNDATION_TEST_DURATION_TELEMETRY_IGNORED malformed ${telemetryPath}`);
            return empty;
        }
        const entries: Record<string, TestDurationTelemetryEntry> = {};
        for (const [key, value] of Object.entries(rawEntries)) {
            if (!isTestDurationTelemetryEntry(value)) {
                continue;
            }
            entries[key] = {
                file: key,
                duration_ms: value.duration_ms,
                samples: Math.max(1, Math.trunc(value.samples)),
                updated_at_utc: value.updated_at_utc
            };
        }
        return {
            schema_version: 1,
            updated_at_utc: typeof (parsed as { updated_at_utc?: unknown }).updated_at_utc === 'string'
                ? String((parsed as { updated_at_utc?: unknown }).updated_at_utc)
                : new Date(0).toISOString(),
            entries
        };
    } catch {
        console.warn(`NODE_FOUNDATION_TEST_DURATION_TELEMETRY_IGNORED unreadable ${telemetryPath}`);
        return empty;
    }
}

async function delay(ms: number): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function acquireTestDurationTelemetryLock(telemetryPath: string): Promise<() => void> {
    const lockPath = `${telemetryPath}.lock`;
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    const startedAt = Date.now();
    while (true) {
        try {
            const handle = fs.openSync(lockPath, 'wx');
            fs.writeFileSync(handle, JSON.stringify({
                pid: process.pid,
                created_at_utc: new Date().toISOString()
            }));
            return () => {
                try {
                    fs.closeSync(handle);
                } finally {
                    try {
                        fs.rmSync(lockPath, { force: true });
                    } catch {
                        // Telemetry is optional; stale lock cleanup handles leftovers.
                    }
                }
            };
        } catch (error: unknown) {
            const code = error && typeof error === 'object'
                ? (error as { code?: string }).code
                : null;
            if (code !== 'EEXIST') {
                throw error;
            }
            try {
                const ageMs = Date.now() - fs.statSync(lockPath).mtimeMs;
                if (ageMs > NODE_FOUNDATION_TEST_DURATION_LOCK_STALE_MS) {
                    fs.rmSync(lockPath, { force: true });
                    continue;
                }
            } catch {
                continue;
            }
            if (Date.now() - startedAt > NODE_FOUNDATION_TEST_DURATION_LOCK_TIMEOUT_MS) {
                throw new Error(`Timed out acquiring duration telemetry lock ${lockPath}`);
            }
            await delay(NODE_FOUNDATION_TEST_DURATION_LOCK_RETRY_MS);
        }
    }
}

function writeTestDurationTelemetryAtomic(telemetryPath: string, telemetry: TestDurationTelemetry): void {
    fs.mkdirSync(path.dirname(telemetryPath), { recursive: true });
    const temporaryPath = path.join(
        path.dirname(telemetryPath),
        `${path.basename(telemetryPath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
    );
    try {
        fs.writeFileSync(temporaryPath, `${JSON.stringify(telemetry, null, 2)}\n`, 'utf8');
        fs.renameSync(temporaryPath, telemetryPath);
    } finally {
        try {
            fs.rmSync(temporaryPath, { force: true });
        } catch {
            // Best-effort temp cleanup; the rename path already succeeded or the caller will report the write failure.
        }
    }
}

function compiledTestFileToTelemetryKey(buildResult: BuildResult, file: string): string {
    const relativeToBuildRoot = normalizeCliPath(path.relative(buildResult.buildRoot, file));
    if (!relativeToBuildRoot.startsWith('../') && !relativeToBuildRoot.startsWith('..\\')) {
        return relativeToBuildRoot.replace(/\.js$/i, '.ts');
    }
    return normalizeCliPath(path.relative(buildResult.repoRoot, file)).replace(/\.js$/i, '.ts');
}

function splitNodeFoundationTestExecutionPlan(
    buildResult: BuildResult,
    selectedTestFiles: string[],
    shardCount: number,
    telemetry: TestDurationTelemetry,
    singleFileShardMinDurationMs = NODE_FOUNDATION_SINGLE_FILE_SHARD_MIN_DURATION_MS
): NodeFoundationTestExecutionPlan {
    if (shardCount <= 1) {
        return { parallelFiles: selectedTestFiles, isolatedFiles: [], serialFiles: [] };
    }

    const parallelFiles: string[] = [];
    const isolatedFiles: string[] = [];
    const serialFiles: string[] = [];
    for (const file of selectedTestFiles) {
        const key = compiledTestFileToTelemetryKey(buildResult, file);
        if (NODE_FOUNDATION_SERIAL_TEST_PATHS.has(key)) {
            serialFiles.push(file);
        } else if (
            NODE_FOUNDATION_ISOLATED_TEST_PATHS.has(key)
            || ((telemetry.entries[key]?.duration_ms ?? 0) >= singleFileShardMinDurationMs)
        ) {
            isolatedFiles.push(file);
        } else {
            parallelFiles.push(file);
        }
    }

    return { parallelFiles, isolatedFiles, serialFiles };
}

function sortFilesByKnownDuration(
    buildResult: BuildResult,
    selectedTestFiles: string[],
    telemetry: TestDurationTelemetry
): string[] {
    return buildTestFileWeights(buildResult, selectedTestFiles, telemetry)
        .sort((a, b) => b.weight - a.weight || a.key.localeCompare(b.key))
        .map((item) => item.file);
}

function assignCommandLineSafeNodeFoundationTestShards(
    buildResult: BuildResult,
    selectedTestFiles: string[],
    optionArgs: string[],
    requestedShardCount: number,
    telemetry: TestDurationTelemetry
): Array<{ files: string[]; totalWeight: number; }> {
    const fileWeights = buildTestFileWeights(buildResult, selectedTestFiles, telemetry);
    let shardCount = Math.min(
        selectedTestFiles.length,
        Math.max(
            requestedShardCount,
            resolveCommandLineSafeShardCount(buildResult.repoRoot, selectedTestFiles, optionArgs)
        )
    );
    while (true) {
        const shards = assignNodeFoundationTestShardWeights(fileWeights, shardCount);
        if (
            shardCount >= selectedTestFiles.length
            || shards.every((shard) => (
                estimateNodeTestArgChars(buildResult.repoRoot, optionArgs, shard.files)
                <= NODE_FOUNDATION_AUTO_SHARD_ARG_CHAR_LIMIT
            ))
        ) {
            return shards;
        }
        shardCount += 1;
    }
}

function assertNodeFoundationShardCommandsWithinLimit(
    repoRoot: string,
    optionArgs: string[],
    shards: string[][]
): void {
    for (const shardFiles of shards) {
        assertNodeTestArgCharsWithinLimit(repoRoot, optionArgs, shardFiles);
    }
}

function assignNodeFoundationTestShardWeights(fileWeights: TestFileWeight[], shardCount: number): Array<{
    files: string[];
    totalWeight: number;
}> {
    const sortedFileWeights = [...fileWeights].sort((a, b) => b.weight - a.weight || a.key.localeCompare(b.key));
    const shards = Array.from({ length: shardCount }, () => ({
        files: [] as string[],
        totalWeight: 0
    }));

    for (const item of sortedFileWeights) {
        let minShardIndex = 0;
        let minWeight = shards[0].totalWeight;
        for (let i = 1; i < shardCount; i++) {
            if (shards[i].totalWeight < minWeight) {
                minWeight = shards[i].totalWeight;
                minShardIndex = i;
            }
        }
        shards[minShardIndex].files.push(item.file);
        shards[minShardIndex].totalWeight += item.weight;
    }

    return shards.filter((shard) => shard.files.length > 0);
}

function buildTestFileWeights(
    buildResult: BuildResult,
    selectedTestFiles: string[],
    telemetry: TestDurationTelemetry
): TestFileWeight[] {
    const fallbackDescriptors = selectedTestFiles.map((file) => {
        let fileSize = 1;
        let partitionSuitePath: string | null = null;
        let partitionSuiteSize = 0;
        try {
            fileSize = Math.max(1, fs.statSync(file).size);
            if (fileSize <= 1_024) {
                const source = fs.readFileSync(file, 'utf8');
                const match = source.match(/\brequire\(\s*['"](\.[^'"]+-suite)['"]\s*\)/u);
                if (match) {
                    const unresolvedSuitePath = path.resolve(path.dirname(file), match[1]);
                    const candidateSuitePath = path.extname(unresolvedSuitePath)
                        ? unresolvedSuitePath
                        : `${unresolvedSuitePath}.js`;
                    const relativeSuitePath = path.relative(buildResult.buildRoot, candidateSuitePath);
                    if (
                        relativeSuitePath
                        && relativeSuitePath !== '..'
                        && !relativeSuitePath.startsWith(`..${path.sep}`)
                        && !path.isAbsolute(relativeSuitePath)
                    ) {
                        partitionSuitePath = candidateSuitePath;
                        partitionSuiteSize = Math.max(1, fs.statSync(candidateSuitePath).size);
                    }
                }
            }
        } catch {
            fileSize = 1;
            partitionSuitePath = null;
            partitionSuiteSize = 0;
        }
        return { file, fileSize, partitionSuitePath, partitionSuiteSize };
    });
    const partitionCounts = new Map<string, number>();
    for (const descriptor of fallbackDescriptors) {
        if (descriptor.partitionSuitePath) {
            partitionCounts.set(
                descriptor.partitionSuitePath,
                (partitionCounts.get(descriptor.partitionSuitePath) ?? 0) + 1
            );
        }
    }
    return calibrateDurationWeights(fallbackDescriptors.map((descriptor) => {
        const { file } = descriptor;
        const key = compiledTestFileToTelemetryKey(buildResult, file);
        const entry = telemetry.entries[key];
        const partitionCount = descriptor.partitionSuitePath
            ? partitionCounts.get(descriptor.partitionSuitePath) ?? 1
            : 1;
        const fallbackSize = descriptor.fileSize + Math.ceil(descriptor.partitionSuiteSize / partitionCount);
        const durationMs = entry && Number.isFinite(entry.duration_ms) && entry.duration_ms > 0
            ? entry.duration_ms
            : null;
        return {
            file,
            key,
            durationMs,
            fallbackSize
        };
    }));
}

function printSlowestKnownTests(fileWeights: TestFileWeight[]): void {
    const slowest = fileWeights
        .filter((item) => item.durationMs !== null)
        .sort((a, b) => (b.durationMs ?? 0) - (a.durationMs ?? 0) || a.key.localeCompare(b.key))
        .slice(0, NODE_FOUNDATION_TEST_SLOWEST_REPORT_COUNT);
    if (slowest.length === 0) {
        console.log(formatNodeFoundationTestMarker(NODE_FOUNDATION_TEST_MARKERS.SHARD_SLOWEST, 'none'));
        return;
    }
    for (const item of slowest) {
        console.log(formatNodeFoundationTestMarker(
            NODE_FOUNDATION_TEST_MARKERS.SHARD_SLOWEST,
            `${item.key} duration_ms=${Math.trunc(item.durationMs ?? 0)}`
        ));
    }
}

function buildNodeFoundationTestShards(
    buildResult: BuildResult,
    selectedTestFiles: string[],
    shardCount: number,
    telemetry: TestDurationTelemetry,
    optionArgs: string[]
): string[][] {
    const fileWeights = buildTestFileWeights(buildResult, selectedTestFiles, telemetry);
    const knownDurationCount = fileWeights.filter((item) => item.durationMs !== null).length;
    const shards = assignCommandLineSafeNodeFoundationTestShards(
        buildResult,
        selectedTestFiles,
        optionArgs,
        shardCount,
        telemetry
    );

    const source = knownDurationCount === 0
        ? 'size_fallback'
        : knownDurationCount === fileWeights.length
            ? 'duration'
            : 'duration_with_calibrated_size_fallback';
    console.log(formatNodeFoundationTestMarker(
        NODE_FOUNDATION_TEST_MARKERS.SHARD_PLAN,
        `source=${source} duration_known=${knownDurationCount}/${fileWeights.length}`
    ));
    printSlowestKnownTests(fileWeights);

    return shards.map((s) => s.files);
}

function getKnownTestDurationMs(buildResult: BuildResult, file: string, telemetry: TestDurationTelemetry): number {
    const key = compiledTestFileToTelemetryKey(buildResult, file);
    const durationMs = telemetry.entries[key]?.duration_ms ?? 0;
    return Number.isFinite(durationMs) && durationMs > 0 ? Math.trunc(durationMs) : 0;
}

function sortNodeFoundationScheduledShards(
    buildResult: BuildResult,
    scheduledShards: string[][],
    telemetry: TestDurationTelemetry
): string[][] {
    const weights = new Map(buildTestFileWeights(buildResult, scheduledShards.flat(), telemetry)
        .map((item) => [item.file, item.weight]));
    return scheduledShards
        .map((files, index) => ({
            files,
            index,
            weight: files.reduce((sum, file) => sum + (weights.get(file) ?? 1), 0)
        }))
        .sort((a, b) => (
            b.weight - a.weight
            || a.index - b.index
        ))
        .map((item) => item.files);
}

function estimateDurationWallMs(
    buildResult: BuildResult,
    scheduledShards: string[][],
    serialFiles: string[],
    workerCount: number,
    telemetry: TestDurationTelemetry
): number {
    const estimates = new Map(buildTestFileWeights(buildResult, [...scheduledShards.flat(), ...serialFiles], telemetry)
        .map((item) => [item.file, item.estimatedDurationMs ?? 0]));
    const sumDurations = (files: string[]): number => files.reduce((sum, file) => sum + (estimates.get(file) ?? 0), 0);
    if (scheduledShards.length === 0) {
        return sumDurations(serialFiles);
    }
    const workerTotals = Array.from({ length: Math.max(1, workerCount) }, () => 0);
    for (const shardFiles of scheduledShards) {
        let minWorkerIndex = 0;
        for (let index = 1; index < workerTotals.length; index += 1) {
            if (workerTotals[index] < workerTotals[minWorkerIndex]) {
                minWorkerIndex = index;
            }
        }
        workerTotals[minWorkerIndex] += sumDurations(shardFiles);
    }
    return Math.ceil(Math.max(...workerTotals) + sumDurations(serialFiles));
}

function summarizeNodeFoundationShardSchedule(
    buildResult: BuildResult,
    selectedTestFiles: string[],
    shardOptionArgs: string[],
    shardCount: number,
    requestedConcurrency: number,
    telemetry: TestDurationTelemetry,
    thresholdMs: number
): NodeFoundationTestShardScheduleSummary {
    const executionPlan = splitNodeFoundationTestExecutionPlan(
        buildResult,
        selectedTestFiles,
        shardCount,
        telemetry,
        thresholdMs
    );
    const parallelShards = executionPlan.parallelFiles.length === 0
        ? []
        : assignCommandLineSafeNodeFoundationTestShards(
            buildResult,
            executionPlan.parallelFiles,
            shardOptionArgs,
            shardCount,
            telemetry
        ).map((shard) => shard.files);
    const isolatedShards = sortFilesByKnownDuration(buildResult, executionPlan.isolatedFiles, telemetry)
        .map((file) => [file]);
    const scheduledShards = sortNodeFoundationScheduledShards(
        buildResult,
        [...parallelShards, ...isolatedShards],
        telemetry
    );
    const maxWorkerProcesses = scheduledShards.length === 0
        ? 1
        : Math.max(1, Math.min(scheduledShards.length, requestedConcurrency));
    const knownDurationFiles = selectedTestFiles
        .filter((file) => getKnownTestDurationMs(buildResult, file, telemetry) > 0)
        .length;

    return {
        thresholdMs,
        groupedShardCount: parallelShards.length,
        isolatedFileCount: executionPlan.isolatedFiles.length,
        serialFileCount: executionPlan.serialFiles.length,
        scheduledShardCount: scheduledShards.length,
        maxWorkerProcesses,
        knownDurationFiles,
        totalFiles: selectedTestFiles.length,
        estimatedWallMs: estimateDurationWallMs(
            buildResult,
            scheduledShards,
            executionPlan.serialFiles,
            maxWorkerProcesses,
            telemetry
        )
    };
}

function printShardScheduleComparison(
    current: NodeFoundationTestShardScheduleSummary,
    baseline: NodeFoundationTestShardScheduleSummary,
    source: 'pre_run_telemetry' | 'post_run_telemetry' | 'observed_run',
    observedWallMs?: number
): void {
    console.log(formatNodeFoundationTestMarker(
        NODE_FOUNDATION_TEST_MARKERS.SHARD_COMPARISON,
        `source=${source} current_threshold_ms=${current.thresholdMs} baseline_threshold_ms=${baseline.thresholdMs} `
        + `current_estimated_wall_ms=${current.estimatedWallMs} baseline_estimated_wall_ms=${baseline.estimatedWallMs} `
        + `estimated_wall_delta_ms=${baseline.estimatedWallMs - current.estimatedWallMs} `
        + `current_isolated_files=${current.isolatedFileCount} baseline_isolated_files=${baseline.isolatedFileCount} `
        + `current_scheduled_shards=${current.scheduledShardCount} baseline_scheduled_shards=${baseline.scheduledShardCount} `
        + `current_grouped_shards=${current.groupedShardCount} baseline_grouped_shards=${baseline.groupedShardCount} `
        + `max_worker_processes=${current.maxWorkerProcesses} baseline_max_worker_processes=${baseline.maxWorkerProcesses} `
        + `serial_files=${current.serialFileCount} telemetry_known=${current.knownDurationFiles}/${current.totalFiles} `
        + `forecast=${current.knownDurationFiles === 0 ? 'unavailable' : current.knownDurationFiles < current.totalFiles ? 'partial' : 'complete'} `
        + `fallback=${current.knownDurationFiles === 0 ? 'uncalibrated_size' : current.knownDurationFiles < current.totalFiles ? 'calibrated_size' : 'none'}`
        + (observedWallMs === undefined ? '' : ` ${formatDurationForecastAccuracy(current.estimatedWallMs, observedWallMs)}`)
    ));
}

async function recordTestDurationTelemetry(
    telemetryPath: string,
    buildResult: BuildResult,
    results: NodeTestShardResult[]
): Promise<TestDurationTelemetry | null> {
    const measurableResults = results.filter((result) => result.exitCode === 0).flatMap((result) =>
        result.fileDurations?.length ? result.fileDurations : result.shardFiles.length === 1
            ? [{ file: result.shardFiles[0], durationMs: result.durationMs }] : []);
    if (measurableResults.length === 0) {
        return null;
    }
    let release: (() => void) | null = null;
    try {
        release = await acquireTestDurationTelemetryLock(telemetryPath);
        const latestTelemetry = readTestDurationTelemetry(telemetryPath);
        const updatedAt = new Date().toISOString();
        const nextEntries = { ...latestTelemetry.entries };
        for (const result of measurableResults) {
            const key = compiledTestFileToTelemetryKey(buildResult, result.file);
            const previous = nextEntries[key];
            const previousSamples = previous ? Math.max(1, Math.trunc(previous.samples)) : 0;
            const nextSamples = Math.min(previousSamples + 1, 20);
            const previousWeight = Math.min(previousSamples, 19);
            const durationMs = Math.max(1, Math.trunc(result.durationMs));
            const averagedDuration = previous
                ? Math.round(((previous.duration_ms * previousWeight) + durationMs) / (previousWeight + 1))
                : durationMs;
            nextEntries[key] = {
                file: key,
                duration_ms: averagedDuration,
                samples: nextSamples,
                updated_at_utc: updatedAt
            };
        }
        const nextTelemetry: TestDurationTelemetry = {
            schema_version: 1,
            updated_at_utc: updatedAt,
            entries: Object.fromEntries(Object.entries(nextEntries).sort(([a], [b]) => a.localeCompare(b)))
        };
        writeTestDurationTelemetryAtomic(telemetryPath, nextTelemetry);
        console.log(formatNodeFoundationTestMarker(
            NODE_FOUNDATION_TEST_MARKERS.DURATION_TELEMETRY_UPDATED,
            `${telemetryPath} entries=${Object.keys(nextTelemetry.entries).length}`
        ));
        return nextTelemetry;
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`NODE_FOUNDATION_TEST_DURATION_TELEMETRY_UPDATE_SKIPPED ${message}`);
        return null;
    } finally {
        release?.();
    }
}

export async function recordTestDurationTelemetryForTest(
    telemetryPath: string,
    buildResult: BuildResult,
    shardFile: string,
    durationMs: number
): Promise<void> {
    await recordTestDurationTelemetry(telemetryPath, buildResult, [{
        exitCode: 0,
        durationMs,
        shardFiles: [shardFile],
        shardIndex: 0,
        shardCount: 1,
        logPath: ''
    }]);
}

async function runSingleNodeTestProcess(
    repoRoot: string,
    buildResult: BuildResult,
    buildRoot: string,
    optionArgs: string[],
    selectedTestFiles: string[],
    requestedShardConcurrency: number | null,
    requestedShardLogDir: string | null,
    telemetryPath: string,
    updateDurationTelemetry: boolean
): Promise<number> {
    const shardLogDir = resolveShardLogDir(repoRoot, buildRoot, requestedShardLogDir);
    const runtimeConfig = resolveNodeTestShardRuntimeConfig(requestedShardConcurrency);
    console.log(formatNodeFoundationTestMarker(NODE_FOUNDATION_TEST_MARKERS.SHARD_LOG_DIR, shardLogDir));
    console.log(formatNodeFoundationTestMarker(NODE_FOUNDATION_TEST_MARKERS.DURATION_TELEMETRY, telemetryPath));
    console.log(formatNodeFoundationTestMarker(
        NODE_FOUNDATION_TEST_MARKERS.SHARD_RUNTIME,
        `timeout_ms=${runtimeConfig.timeoutMs} heartbeat_ms=${runtimeConfig.heartbeatMs} concurrency=1`
    ));
    const result = await runNodeTestShard(
        repoRoot,
        optionArgs,
        selectedTestFiles,
        0,
        1,
        shardLogDir,
        runtimeConfig,
        updateDurationTelemetry
    );
    diagnoseGreenSummaryShardFailure(repoRoot, buildResult, optionArgs, result);
    diagnoseFailedShardSummary(result);
    if (updateDurationTelemetry) {
        await recordTestDurationTelemetry(telemetryPath, buildResult, [result]);
    }
    return result.exitCode;
}

function readTextFileIfExists(filePath: string): string {
    try {
        if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
            return fs.readFileSync(filePath, 'utf8');
        }
    } catch {
        return '';
    }
    return '';
}

function getTailLines(text: string, maxLines: number): string[] {
    if (!text) {
        return [];
    }
    return text.split(/\r?\n/u).filter((line) => line.length > 0).slice(-maxLines);
}

function hasGreenNodeTestSummary(logPath: string): boolean {
    return hasGreenNodeTestSummaryContent(readTextFileIfExists(logPath));
}

function resolveShardLogDir(repoRoot: string, buildRoot: string, requestedShardLogDir: string | null): string {
    const configuredLogDir = requestedShardLogDir || String(process.env[NODE_FOUNDATION_TEST_SHARD_LOG_DIR_ENV] || '').trim();
    if (configuredLogDir) {
        return path.resolve(repoRoot, configuredLogDir);
    }
    return path.join(buildRoot, 'test-shard-logs', `run-${process.pid}`);
}

function killShardChildTree(child: childProcess.ChildProcess): string {
    if (process.platform === 'win32' && child.pid) {
        try {
            childProcess.execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
                stdio: 'ignore',
                windowsHide: true,
                timeout: 5000
            });
            return 'taskkill_tree';
        } catch (_error) {
            // Fall through to ChildProcess.kill for test doubles and already-exited children.
        }
    }

    if (process.platform !== 'win32' && child.pid) {
        try {
            process.kill(-child.pid, 'SIGKILL');
            return 'kill_process_group_sigkill';
        } catch (_error) {
            // Fall through to ChildProcess.kill for test doubles and processes without a group.
        }
    }

    try {
        child.kill('SIGKILL');
        return 'child_kill_sigkill';
    } catch (_error) {
        return 'already_exited_or_kill_failed';
    }
}

function runNodeTestShard(
    repoRoot: string,
    optionArgs: string[],
    shardFiles: string[],
    shardIndex: number,
    shardCount: number,
    shardLogDir: string,
    runtimeConfig: NodeTestShardRuntimeConfig,
    collectFileDurations: boolean
): Promise<NodeTestShardResult> {
    let shardOptionArgs = buildNodeTestShardOptionArgs(optionArgs, runtimeConfig);
    const captureEnabled = collectFileDurations && shardFiles.length > 1;
    if (captureEnabled) shardOptionArgs = addDurationReporterOptions(shardOptionArgs, DURATION_REPORTER_URL);
    assertNodeTestArgCharsWithinLimit(repoRoot, shardOptionArgs, shardFiles);
    return new Promise((resolve, reject) => {
        fs.mkdirSync(shardLogDir, { recursive: true });
        const durationCapture = captureEnabled ? createShardDurationCapture(shardLogDir, shardFiles) : null;
        const logPath = path.join(shardLogDir, `shard-${String(shardIndex + 1).padStart(2, '0')}-of-${String(shardCount).padStart(2, '0')}.log`);
        const logStream = fs.createWriteStream(logPath, { flags: 'w' });
        const startedAt = Date.now();
        let lastOutputAt = startedAt;
        let timedOut = false;
        let settled = false;
        let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
        let heartbeatHandle: ReturnType<typeof setInterval> | null = null;
        let cleanupGraceHandle: ReturnType<typeof setTimeout> | null = null;
        console.log(formatNodeFoundationTestMarker(
            NODE_FOUNDATION_TEST_MARKERS.SHARD_START,
            `${shardIndex + 1}/${shardCount} files=${shardFiles.length}`
        ));
        console.log(formatNodeFoundationTestMarker(
            NODE_FOUNDATION_TEST_MARKERS.SHARD_LOG,
            `${shardIndex + 1}/${shardCount} ${logPath}`
        ));
        const childCommand = process.execPath;
        const childArgs = [
            '--test',
            ...shardOptionArgs,
            ...buildNodeTestFileArgs(repoRoot, shardFiles)
        ];
        const child = childProcess.spawn(childCommand, childArgs, {
            cwd: repoRoot,
            detached: process.platform !== 'win32',
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env, [SHARD_DURATION_OUTPUT_ENV]: durationCapture?.destination ?? '' },
            windowsHide: true
        });
        let exitCode = 1;
        let exitSignal: NodeJS.Signals | null = null;
        let finishing = false;
        let outputFailed = false;
        const output = new ShardOutputForwarder(logStream, process.stdout, process.stderr, (error) => {
            if (settled) return;
            outputFailed = true;
            output.diagnostic(`Node test output forwarding failed: ${error.message}`, process.stderr);
            if (exitCode === 0) exitCode = 1;
            killShardChildTree(child);
            scheduleCleanupGrace();
            finishShard();
        });
        logStream.once('error', () => {
            if (settled || outputFailed) return;
            outputFailed = true;
            if (exitCode === 0) exitCode = 1;
            killShardChildTree(child);
            scheduleCleanupGrace();
            finishShard();
        });

        function cleanupTimers(): void {
            if (timeoutHandle) {
                clearTimeout(timeoutHandle);
                timeoutHandle = null;
            }
            if (heartbeatHandle) {
                clearInterval(heartbeatHandle);
                heartbeatHandle = null;
            }
            if (cleanupGraceHandle) {
                clearTimeout(cleanupGraceHandle);
                cleanupGraceHandle = null;
            }
        }

        function buildProgressFields(): string {
            const now = Date.now();
            return `pid=${child.pid ?? 'unknown'} elapsed_ms=${Math.max(1, now - startedAt)} `
                + `last_output_age_ms=${Math.max(0, now - lastOutputAt)} `
                + `command=${JSON.stringify(childCommand)} argv=${JSON.stringify(childArgs)} log=${logPath}`;
        }

        function settleShard(): void {
            if (settled) {
                return;
            }
            settled = true;
            cleanupTimers();
            output.cancel();
            const durationMs = Math.max(1, Date.now() - startedAt);
            console.log(formatNodeFoundationTestMarker(
                NODE_FOUNDATION_TEST_MARKERS.SHARD_DONE,
                `${shardIndex + 1}/${shardCount} exit=${exitCode} `
                + `duration_ms=${durationMs} timed_out=${timedOut} signal=${exitSignal ?? 'none'} log=${logPath}`
            ));
            resolve({
                exitCode,
                durationMs,
                shardFiles,
                shardIndex,
                shardCount,
                logPath,
                timedOut,
                fileDurations: durationCapture?.finish()
            });
        }

        function finishShard(force = false): void {
            if (settled || (finishing && !force)) return;
            finishing = true;
            if (heartbeatHandle) { clearInterval(heartbeatHandle); heartbeatHandle = null; }
            if (force) {
                output.cancel();
                if (logStream.destroyed) { settleShard(); return; }
                if (!logStream.writableEnded) endShardLog();
                cleanupGraceHandle = setTimeout(() => {
                    logStream.destroy();
                    settleShard();
                }, NODE_FOUNDATION_TEST_SHARD_CLEANUP_GRACE_MS);
                return;
            }
            void output.flush().then(() => {
                if (settled) return;
                output.cancel();
                endShardLog();
            }, () => {
                if (settled) return;
                if (exitCode === 0) exitCode = 1;
                scheduleCleanupGrace();
                if (logStream.destroyed) settleShard();
                else endShardLog();
            });
        }

        function endShardLog(): void {
            logStream.end((error?: Error | null) => {
                if (error) {
                    outputFailed = true;
                    if (exitCode === 0) exitCode = 1;
                    output.diagnostic(`Node test log finalization failed: ${error.message}`, process.stderr);
                }
                settleShard();
            });
        }

        function scheduleCleanupGrace(): void {
            if (cleanupGraceHandle || settled) {
                return;
            }
            cleanupGraceHandle = setTimeout(() => {
                if (settled) {
                    return;
                }
                output.diagnostic(
                    formatNodeFoundationTestMarker(
                        NODE_FOUNDATION_TEST_MARKERS.SHARD_CLEANUP_GRACE_EXPIRED,
                        `${shardIndex + 1}/${shardCount} ${buildProgressFields()}`
                    ),
                    process.stderr
                );
                finishShard(true);
            }, NODE_FOUNDATION_TEST_SHARD_CLEANUP_GRACE_MS);
        }

        function scheduleIdleTimeout(): void {
            if (runtimeConfig.timeoutMs <= 0 || settled) {
                return;
            }
            if (timeoutHandle) {
                clearTimeout(timeoutHandle);
            }
            timeoutHandle = setTimeout(() => {
                if (settled) {
                    return;
                }
                const idleForMs = Date.now() - lastOutputAt;
                if (idleForMs < runtimeConfig.timeoutMs) {
                    scheduleIdleTimeout();
                    return;
                }
                timedOut = true;
                exitCode = 1;
                const cleanupMethod = killShardChildTree(child);
                output.diagnostic(
                    formatNodeFoundationTestMarker(
                        NODE_FOUNDATION_TEST_MARKERS.SHARD_TIMEOUT,
                        `${shardIndex + 1}/${shardCount} ${buildProgressFields()} cleanup=${cleanupMethod}`
                    ),
                    process.stderr
                );
                scheduleCleanupGrace();
            }, runtimeConfig.timeoutMs);
        }

        function recordProgress(): void {
            lastOutputAt = Date.now();
            scheduleIdleTimeout();
        }

        output.forward(child.stdout, process.stdout, recordProgress);
        output.forward(child.stderr, process.stderr, recordProgress);
        scheduleIdleTimeout();
        if (runtimeConfig.heartbeatMs > 0) {
            heartbeatHandle = setInterval(() => {
                if (settled || finishing) {
                    return;
                }
                output.diagnostic(
                    formatNodeFoundationTestMarker(
                        NODE_FOUNDATION_TEST_MARKERS.SHARD_HEARTBEAT,
                        `${shardIndex + 1}/${shardCount} ${buildProgressFields()}`
                    ),
                    null
                );
            }, runtimeConfig.heartbeatMs);
        }
        child.once('error', (error) => {
            if (settled) return;
            settled = true;
            cleanupTimers();
            output.cancel();
            logStream.destroy();
            durationCapture?.finish();
            reject(error);
        });
        child.once('exit', (code, signal) => {
            if (!timedOut && !outputFailed) {
                exitCode = code == null ? 1 : code;
            }
            exitSignal = signal;
        });
        child.once('close', () => {
            finishShard();
        });
    });
}

function diagnoseGreenSummaryShardFailure(
    repoRoot: string,
    buildResult: BuildResult,
    optionArgs: string[],
    result: NodeTestShardResult
): void {
    if (result.exitCode === 0 || result.timedOut || !hasGreenNodeTestSummary(result.logPath)) {
        return;
    }

    const shardLabel = `${result.shardIndex + 1}/${result.shardCount}`;
    console.error(formatNodeFoundationTestMarker(
        NODE_FOUNDATION_TEST_MARKERS.SHARD_GREEN_EXIT_MISMATCH,
        `${shardLabel} exit=${result.exitCode} files=${result.shardFiles.length} log=${result.logPath}`
    ));
    for (const line of getTailLines(readTextFileIfExists(result.logPath), 40)) {
        console.error(formatNodeFoundationTestMarker(
            NODE_FOUNDATION_TEST_MARKERS.SHARD_GREEN_EXIT_TAIL,
            `${shardLabel} ${line}`
        ));
    }

    const isolationFiles = result.shardFiles.slice(0, NODE_FOUNDATION_TEST_GREEN_EXIT_ISOLATION_MAX_FILES);
    let reproduced = false;
    for (const filePath of isolationFiles) {
        const startedAt = Date.now();
        const rerun = childProcess.spawnSync(process.execPath, ['--test', ...optionArgs, filePath], {
            cwd: repoRoot,
            encoding: 'utf8',
            maxBuffer: 10 * 1024 * 1024,
            timeout: NODE_FOUNDATION_TEST_GREEN_EXIT_ISOLATION_TIMEOUT_MS,
            windowsHide: true
        });
        const exitCode = rerun.status == null ? 1 : rerun.status;
        if (exitCode === 0 && rerun.signal == null) {
            continue;
        }
        reproduced = true;
        const key = compiledTestFileToTelemetryKey(buildResult, filePath);
        console.error(formatNodeFoundationTestMarker(
            NODE_FOUNDATION_TEST_MARKERS.SHARD_ISOLATION_FAIL,
            `${shardLabel} file=${key} `
            + `exit=${exitCode} signal=${rerun.signal ?? 'none'} duration_ms=${Math.max(1, Date.now() - startedAt)}`
        ));
        const outputTail = getTailLines(`${rerun.stdout || ''}\n${rerun.stderr || ''}`, 30);
        for (const line of outputTail) {
            console.error(formatNodeFoundationTestMarker(
                NODE_FOUNDATION_TEST_MARKERS.SHARD_ISOLATION_TAIL,
                `${key} ${line}`
            ));
        }
    }
    if (!reproduced) {
        console.error(formatNodeFoundationTestMarker(
            NODE_FOUNDATION_TEST_MARKERS.SHARD_ISOLATION_NO_REPRO,
            `${shardLabel} checked=${isolationFiles.length} files=${result.shardFiles.length}`
        ));
    }
    if (isolationFiles.length < result.shardFiles.length) {
        console.error(formatNodeFoundationTestMarker(
            NODE_FOUNDATION_TEST_MARKERS.SHARD_ISOLATION_CAPPED,
            `${shardLabel} checked=${isolationFiles.length} files=${result.shardFiles.length} `
            + `timeout_ms=${NODE_FOUNDATION_TEST_GREEN_EXIT_ISOLATION_TIMEOUT_MS}`
        ));
    }
}

function diagnoseFailedShardSummary(result: NodeTestShardResult): void {
    if (result.exitCode === 0 || result.timedOut) {
        return;
    }

    const content = readTextFileIfExists(result.logPath);
    if (hasGreenNodeTestSummaryContent(content)) {
        return;
    }

    const shardLabel = `${result.shardIndex + 1}/${result.shardCount}`;
    for (const line of buildNodeFoundationShardFailureDiagnostics({
        shardLabel,
        exitCode: result.exitCode,
        logPath: result.logPath,
        logContent: content
    })) {
        console.error(line);
    }
}

async function runShardedNodeTestProcesses(
    repoRoot: string,
    buildResult: BuildResult,
    buildRoot: string,
    optionArgs: string[],
    selectedTestFiles: string[],
    shardCount: number,
    requestedShardConcurrency: number | null,
    requestedShardLogDir: string | null,
    telemetryPath: string,
    telemetry: TestDurationTelemetry,
    updateDurationTelemetry: boolean
): Promise<number> {
    const baseRuntimeConfig = resolveNodeTestShardRuntimeConfig(requestedShardConcurrency);
    const runtimeConfig: NodeTestShardRuntimeConfig = {
        ...baseRuntimeConfig,
        defaultNodeTestConcurrency: resolveDefaultShardedNodeTestConcurrency(baseRuntimeConfig)
    };
    const baseShardOptionArgs = buildNodeTestShardOptionArgs(optionArgs, runtimeConfig);
    const shardOptionArgs = updateDurationTelemetry
        ? addDurationReporterOptions(baseShardOptionArgs, DURATION_REPORTER_URL)
        : baseShardOptionArgs;
    const executionPlan = splitNodeFoundationTestExecutionPlan(buildResult, selectedTestFiles, shardCount, telemetry);
    const parallelShards = executionPlan.parallelFiles.length === 0
        ? []
        : buildNodeFoundationTestShards(
            buildResult,
            executionPlan.parallelFiles,
            shardCount,
            telemetry,
            shardOptionArgs
        );
    const isolatedShards = sortFilesByKnownDuration(buildResult, executionPlan.isolatedFiles, telemetry)
        .map((file) => [file]);
    const scheduledShards = sortNodeFoundationScheduledShards(
        buildResult,
        [...parallelShards, ...isolatedShards],
        telemetry
    );
    assertNodeFoundationShardCommandsWithinLimit(buildResult.repoRoot, shardOptionArgs, [
        ...scheduledShards,
        ...executionPlan.serialFiles.map((file) => [file])
    ]);
    const shardLogDir = resolveShardLogDir(repoRoot, buildRoot, requestedShardLogDir);
    console.log(formatNodeFoundationTestMarker(NODE_FOUNDATION_TEST_MARKERS.SHARD_LOG_DIR, shardLogDir));
    console.log(formatNodeFoundationTestMarker(NODE_FOUNDATION_TEST_MARKERS.DURATION_TELEMETRY, telemetryPath));
    const requestedConcurrency = runtimeConfig.concurrency;
    const shardConcurrency = Math.max(1, Math.min(scheduledShards.length, requestedConcurrency));
    const totalShardCount = scheduledShards.length + executionPlan.serialFiles.length;
    console.log(formatNodeFoundationTestMarker(
        NODE_FOUNDATION_TEST_MARKERS.SHARD_RUNTIME,
        `timeout_ms=${runtimeConfig.timeoutMs} heartbeat_ms=${runtimeConfig.heartbeatMs} `
        + `concurrency=${scheduledShards.length === 0 ? 1 : shardConcurrency} `
        + `node_test_concurrency=${describeNodeTestConcurrency(optionArgs, runtimeConfig)} `
        + `grouped_shards=${parallelShards.length} max_auto_shard_files=${NODE_FOUNDATION_AUTO_SHARD_MAX_FILES} `
        + `max_shard_arg_chars=${NODE_FOUNDATION_AUTO_SHARD_ARG_CHAR_LIMIT} `
        + `isolated_files=${executionPlan.isolatedFiles.length} serial_files=${executionPlan.serialFiles.length}`
    ));
    const preRunSchedule = summarizeNodeFoundationShardSchedule(
        buildResult,
        selectedTestFiles,
        shardOptionArgs,
        shardCount,
        requestedConcurrency,
        telemetry,
        NODE_FOUNDATION_SINGLE_FILE_SHARD_MIN_DURATION_MS
    );
    const preRunBaseline = summarizeNodeFoundationShardSchedule(
        buildResult,
        selectedTestFiles,
        shardOptionArgs,
        shardCount,
        requestedConcurrency,
        telemetry,
        NODE_FOUNDATION_BASELINE_SINGLE_FILE_SHARD_MIN_DURATION_MS
    );
    printShardScheduleComparison(preRunSchedule, preRunBaseline, 'pre_run_telemetry');
    const executionStartedAt = Date.now();
    const results: NodeTestShardResult[] = [];
    const scheduledResults: NodeTestShardResult[] = new Array(scheduledShards.length);
    let nextShardIndex = 0;
    const workerCount = scheduledShards.length === 0 ? 0 : shardConcurrency;
    await Promise.all(Array.from({ length: workerCount }, async () => {
        while (true) {
            const shardIndex = nextShardIndex;
            nextShardIndex += 1;
            if (shardIndex >= scheduledShards.length) {
                return;
            }
            const shardFiles = scheduledShards[shardIndex];
            const result = await runNodeTestShard(repoRoot, optionArgs, shardFiles, shardIndex, totalShardCount, shardLogDir, runtimeConfig, updateDurationTelemetry);
            scheduledResults[shardIndex] = result;
            diagnoseGreenSummaryShardFailure(repoRoot, buildResult, optionArgs, result);
            diagnoseFailedShardSummary(result);
        }
    }));
    for (const result of scheduledResults) {
        if (result) {
            results.push(result);
        }
    }
    for (let index = 0; index < executionPlan.serialFiles.length; index += 1) {
        const result = await runNodeTestShard(
            repoRoot,
            optionArgs,
            [executionPlan.serialFiles[index]],
            scheduledShards.length + index,
            totalShardCount,
            shardLogDir,
            runtimeConfig,
            updateDurationTelemetry
        );
        results.push(result);
        diagnoseGreenSummaryShardFailure(repoRoot, buildResult, optionArgs, result);
        diagnoseFailedShardSummary(result);
    }
    printShardScheduleComparison(preRunSchedule, preRunBaseline, 'observed_run', Math.max(1, Date.now() - executionStartedAt));
    const updatedTelemetry = updateDurationTelemetry
        ? await recordTestDurationTelemetry(telemetryPath, buildResult, results)
        : null;
    if (updatedTelemetry) {
        printShardScheduleComparison(
            summarizeNodeFoundationShardSchedule(
                buildResult,
                selectedTestFiles,
                shardOptionArgs,
                shardCount,
                requestedConcurrency,
                updatedTelemetry,
                NODE_FOUNDATION_SINGLE_FILE_SHARD_MIN_DURATION_MS
            ),
            summarizeNodeFoundationShardSchedule(
                buildResult,
                selectedTestFiles,
                shardOptionArgs,
                shardCount,
                requestedConcurrency,
                updatedTelemetry,
                NODE_FOUNDATION_BASELINE_SINGLE_FILE_SHARD_MIN_DURATION_MS
            ),
            'post_run_telemetry'
        );
    }
    return results.find((result) => result.exitCode !== 0)?.exitCode || 0;
}

export async function runNodeFoundationTests(): Promise<number> {
    // Some lifecycle/update tests seed sync-surface fixtures from the current
    // publish-runtime bundle, so refresh dist before compiling .node-build.
    buildPublishRuntime();
    const buildResult: BuildResult = buildNodeFoundation();
    const repoRoot = buildResult.repoRoot;
    const compiledTestFiles: string[] = collectCompiledNodeFoundationTestFiles(buildResult);
    const forwardedArgs = process.argv.slice(2);
    const {
        optionArgs,
        fileTargets,
        requestedShardCount,
        requestedShardConcurrency,
        requestedShardLogDir,
        requestedDurationFile
    } = splitForwardedTestArgs(forwardedArgs);
    const selectedTestFiles = resolveSelectedTestFiles(buildResult, compiledTestFiles, fileTargets);
    const telemetryPath = resolveDurationTelemetryPath(buildResult.repoRoot, requestedDurationFile);
    const telemetry = readTestDurationTelemetry(telemetryPath);
    const partialTestSelectionOption = findPartialTestSelectionOption(optionArgs);
    const updateDurationTelemetry = partialTestSelectionOption == null;
    if (partialTestSelectionOption) {
        console.log(formatNodeFoundationTestMarker(
            NODE_FOUNDATION_TEST_MARKERS.DURATION_TELEMETRY_UPDATE_SKIPPED,
            `reason=partial_test_selection option=${partialTestSelectionOption}`
        ));
    }

    if (compiledTestFiles.length === 0) {
        throw new Error('No Node foundation tests were found under .node-build/tests/node.');
    }

    const shardCount = resolveNodeFoundationShardCount(
        repoRoot,
        selectedTestFiles,
        optionArgs,
        fileTargets,
        requestedShardCount
    );
    const exitCode = shardCount === 1
        ? await runSingleNodeTestProcess(
            repoRoot,
            buildResult,
            buildResult.buildRoot,
            optionArgs,
            selectedTestFiles,
            requestedShardConcurrency,
            requestedShardLogDir,
            telemetryPath,
            updateDurationTelemetry
        )
        : await runShardedNodeTestProcesses(
            repoRoot,
            buildResult,
            buildResult.buildRoot,
            optionArgs,
            selectedTestFiles,
            shardCount,
            requestedShardConcurrency,
            requestedShardLogDir,
            telemetryPath,
            telemetry,
            updateDurationTelemetry
        );

    if (exitCode !== 0) {
        return exitCode;
    }
    console.log('NODE_FOUNDATION_TEST_OK');
    return 0;
}

// CLI entry point when run directly
if (require.main === module) {
    runNodeFoundationTests()
        .then((exitCode) => {
            if (exitCode !== 0) {
                process.exit(exitCode);
            }
        })
        .catch((error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            console.error(message);
            process.exit(1);
        });
}
