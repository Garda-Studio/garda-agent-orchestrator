import test from 'node:test';
import assert from 'node:assert/strict';
import { createRollbackSnapshot, writeRollbackRecords } from '../../../../src/lifecycle/common';

import {
    formatStatusSnapshotJson
} from '../../../../src/validators/status';
import {
    formatDoctorResultJson
} from '../../../../src/validators/doctor';

function makeReadyStatusSnapshot(): Record<string, unknown> {
    return {
        targetRoot: '/tmp/test',
        bundlePath: '/tmp/test/garda-agent-orchestrator',
        initAnswersResolvedPath: '/tmp/test/init-answers.json',
        collectedVia: 'setup',
        activeAgentFiles: 'AGENTS.md',
        sourceOfTruth: 'Claude',
        canonicalEntrypoint: 'CLAUDE.md',
        bundlePresent: true,
        primaryInitializationComplete: true,
        agentInitializationComplete: true,
        readyForTasks: true,
        agentInitializationPendingReason: null,
        missingProjectCommands: [],
        initAnswersError: null,
        liveVersionError: null,
        agentInitStateError: null,
        commandsRulePath: '/tmp/test/commands.md',
        recommendedNextCommand: 'Execute task T-001',
        parityResult: {
            isSourceCheckout: false,
            isStale: false,
            violations: [],
            remediation: null
        },
        timelineTaskCount: 0,
        timelineHealthy: 0,
        timelineWarnings: [],
        providerComplianceResult: null,
        protectedManifestEvidence: null,
        initAnswersPathForDisplay: '/tmp/test/init-answers.json',
        initAnswersPresent: true,
        taskPresent: true,
        livePresent: true,
        usagePresent: true,
        agentInitStatePath: '/tmp/test/state.json',
        agentInitState: null
    };
}

function makeNotReadyStatusSnapshot(): Record<string, unknown> {
    return {
        ...makeReadyStatusSnapshot(),
        bundlePresent: false,
        primaryInitializationComplete: false,
        agentInitializationComplete: false,
        readyForTasks: false,
        collectedVia: null,
        activeAgentFiles: null,
        sourceOfTruth: null,
        canonicalEntrypoint: null,
        initAnswersPresent: false,
        taskPresent: false,
        livePresent: false,
        usagePresent: false,
        recommendedNextCommand: 'garda setup'
    };
}

const DEFAULT_DOCTOR_EVIDENCE = {
    runtimeMismatchEvidence: { checked: false, mismatches: [] },
    permissionEvidence: { checked: false, failures: [] },
    partialStateEvidence: { checked: false, sentinels: [] },
    rollbackHealthEvidence: { checked: false, snapshots: [] },
    taskHistoryLedgerSummary: {
        root_path: '/tmp/test/garda-agent-orchestrator/runtime/task-ledger',
        file_count: 0,
        verified_count: 0,
        incomplete_count: 0,
        contradictory_count: 0,
        invalid_count: 0
    }
};

function makePassingDoctorResult(): Record<string, unknown> {
    return {
        passed: true,
        targetRoot: '/tmp/test',
        verifyResult: {
            passed: true,
            targetRoot: '/tmp/test',
            sourceOfTruth: 'Claude',
            canonicalEntrypoint: 'CLAUDE.md',
            bundleVersion: '1.0.0',
            requiredPathsChecked: 10,
            violations: {
                missingPaths: [],
                initAnswersContractViolations: [],
                versionContractViolations: [],
                reviewCapabilitiesContractViolations: [],
                pathsContractViolations: [],
                tokenEconomyContractViolations: [],
                outputFiltersContractViolations: [],
                skillPacksConfigContractViolations: [],
                skillsIndexConfigContractViolations: [],
                ruleFileViolations: [],
                templatePlaceholderViolations: [],
                commandsContractViolations: [],
                manifestContractViolations: [],
                coreRuleContractViolations: [],
                entrypointContractViolations: [],
                taskContractViolations: [],
                qwenSettingsViolations: [],
                skillsIndexContractViolations: [],
                skillPackContractViolations: [],
                gitignoreMissing: []
            },
            totalViolationCount: 0
        },
        manifestResult: {
            passed: true,
            manifestPath: '/tmp/MANIFEST.md',
            entriesChecked: 5,
            duplicates: [],
            diagnostics: []
        },
        manifestError: null,
        timelineEvidence: [],
        timelineWarnings: [],
        lockHealth: {
            lock_root: '/tmp/test/runtime/task-events',
            subsystem_scope_note: 'task-event lock subsystem',
            locks: [],
            active_count: 0,
            stale_count: 0
        },
        lockCleanup: null,
        parityResult: {
            isSourceCheckout: false,
            isStale: false,
            violations: [],
            rootVersion: null,
            bundleVersion: null,
            remediation: null
        },
        providerComplianceResult: null,
        nestedBundleDuplication: { duplicatesFound: false, duplicatePaths: [] },
        protectedManifestEvidence: null,
        ...DEFAULT_DOCTOR_EVIDENCE
    };
}

test('formatStatusSnapshotJson returns valid JSON for ready snapshot', () => {
    const snapshot = makeReadyStatusSnapshot();
    const output = formatStatusSnapshotJson(snapshot as any);
    const parsed = JSON.parse(output);
    assert.equal(parsed.readyForTasks, true);
    assert.equal(parsed.sourceOfTruth, 'Claude');
    assert.equal(parsed.bundlePresent, true);
    assert.equal(parsed.targetRoot, '/tmp/test');
});

test('formatStatusSnapshotJson returns valid JSON for not-ready snapshot', () => {
    const snapshot = makeNotReadyStatusSnapshot();
    const output = formatStatusSnapshotJson(snapshot as any);
    const parsed = JSON.parse(output);
    assert.equal(parsed.readyForTasks, false);
    assert.equal(parsed.bundlePresent, false);
    assert.equal(parsed.sourceOfTruth, null);
});

test('formatStatusSnapshotJson output is pretty-printed', () => {
    const snapshot = makeReadyStatusSnapshot();
    const output = formatStatusSnapshotJson(snapshot as any);
    assert.ok(output.includes('\n'), 'JSON output must be pretty-printed');
    assert.ok(output.startsWith('{'), 'JSON output must start with {');
});

test('formatStatusSnapshotJson preserves nested structures', () => {
    const snapshot = makeReadyStatusSnapshot();
    const output = formatStatusSnapshotJson(snapshot as any);
    const parsed = JSON.parse(output);
    assert.equal(typeof parsed.parityResult, 'object');
    assert.equal(parsed.parityResult.isSourceCheckout, false);
    assert.ok(Array.isArray(parsed.missingProjectCommands));
});

test('formatDoctorResultJson returns valid JSON for passing result', () => {
    const result = makePassingDoctorResult();
    const output = formatDoctorResultJson(result as any);
    const parsed = JSON.parse(output);
    assert.equal(parsed.passed, true);
    assert.equal(parsed.targetRoot, '/tmp/test');
    assert.equal(parsed.verifyResult.passed, true);
});

test('formatDoctorResultJson returns valid JSON for failing result', () => {
    const result = {
        ...makePassingDoctorResult(),
        passed: false,
        verifyResult: {
            ...(makePassingDoctorResult().verifyResult as Record<string, unknown>),
            passed: false,
            totalViolationCount: 1,
            violations: {
                ...((makePassingDoctorResult().verifyResult as Record<string, unknown>).violations as Record<string, unknown>),
                missingPaths: ['some/path']
            }
        }
    };
    const output = formatDoctorResultJson(result as any);
    const parsed = JSON.parse(output);
    assert.equal(parsed.passed, false);
    assert.ok(Array.isArray(parsed.verifyResult.violations.missingPaths));
    assert.equal(parsed.verifyResult.violations.missingPaths.length, 1);
});

test('formatDoctorResultJson output is pretty-printed', () => {
    const result = makePassingDoctorResult();
    const output = formatDoctorResultJson(result as any);
    assert.ok(output.includes('\n'), 'JSON output must be pretty-printed');
    assert.ok(output.startsWith('{'), 'JSON output must start with {');
});

test('formatDoctorResultJson preserves manifest evidence', () => {
    const result = makePassingDoctorResult();
    const output = formatDoctorResultJson(result as any);
    const parsed = JSON.parse(output);
    assert.equal(parsed.manifestResult.passed, true);
    assert.equal(parsed.manifestResult.entriesChecked, 5);
});

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

function isWorkspaceRoot(candidate: string): boolean {
    return fs.existsSync(path.join(candidate, 'package.json')) &&
        fs.existsSync(path.join(candidate, 'VERSION')) &&
        fs.existsSync(path.join(candidate, 'bin', 'garda.js')) &&
        fs.existsSync(path.join(candidate, 'src', 'index.ts'));
}

function findRepoRoot(): string {
    const cwd = path.resolve(process.cwd());
    if (isWorkspaceRoot(cwd)) {
        return cwd;
    }

    let current = __dirname;
    while (current !== path.dirname(current)) {
        if (isWorkspaceRoot(current)) {
            return current;
        }
        current = path.dirname(current);
    }
    throw new Error('Cannot resolve repo root from ' + __dirname);
}

const REPO_ROOT = findRepoRoot();
const CLI_ENTRY = path.join(REPO_ROOT, 'bin', 'garda.js');
const NEUTRAL_CWD = path.join(REPO_ROOT, 'tests');
const CLI_JSON_TIMEOUT_MS = 90_000;

function runCliJson(args: string[]) {
    return spawnSync(process.execPath, [CLI_ENTRY, ...args], {
        cwd: NEUTRAL_CWD,
        encoding: 'utf8',
        timeout: CLI_JSON_TIMEOUT_MS
    });
}

function formatCliJsonResult(result: ReturnType<typeof runCliJson>): string {
    return [
        `status=${String(result.status)}`,
        `signal=${String(result.signal)}`,
        `error=${result.error ? result.error.message : 'none'}`,
        `timeout_ms=${CLI_JSON_TIMEOUT_MS}`,
        `stdout=${result.stdout || ''}`,
        `stderr=${result.stderr || ''}`
    ].join('\n');
}

function copyFixtureFile(sourcePath: string, destinationPath: string): void {
    fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
    fs.copyFileSync(sourcePath, destinationPath);
}

function createDeployedWorkspaceFixture(): {
    workspaceRoot: string;
    bundleRoot: string;
    cleanup: () => void;
} {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-json-output-'));
    const bundleRoot = path.join(workspaceRoot, 'garda-agent-orchestrator');
    const snapshotRoot = path.join(
        bundleRoot,
        'runtime',
        'update-rollbacks',
        'update-20260401-120000'
    );

    copyFixtureFile(path.join(REPO_ROOT, 'bin', 'garda.js'), path.join(bundleRoot, 'bin', 'garda.js'));
    copyFixtureFile(path.join(REPO_ROOT, 'VERSION'), path.join(bundleRoot, 'VERSION'));
    copyFixtureFile(path.join(REPO_ROOT, 'package.json'), path.join(bundleRoot, 'package.json'));
    copyFixtureFile(path.join(REPO_ROOT, 'MANIFEST.md'), path.join(bundleRoot, 'MANIFEST.md'));
    copyFixtureFile(path.join(REPO_ROOT, 'AGENT_INIT_PROMPT.md'), path.join(bundleRoot, 'AGENT_INIT_PROMPT.md'));

    fs.mkdirSync(path.join(bundleRoot, 'runtime'), { recursive: true });
    fs.writeFileSync(
        path.join(bundleRoot, 'runtime', 'init-answers.json'),
        JSON.stringify({
            AssistantLanguage: 'English',
            AssistantBrevity: 'concise',
            SourceOfTruth: 'Claude',
            EnforceNoAutoCommit: 'false',
            ClaudeOrchestratorFullAccess: 'false',
            TokenEconomyEnabled: 'true',
            ProviderMinimalism: 'true',
            CollectedVia: 'CLI_NONINTERACTIVE',
            ActiveAgentFiles: 'CLAUDE.md'
        }, null, 2),
        'utf8'
    );

    writeRollbackRecords(
        snapshotRoot,
        createRollbackSnapshot(workspaceRoot, snapshotRoot, ['garda-agent-orchestrator/VERSION'])
    );

    return {
        workspaceRoot,
        bundleRoot,
        cleanup() {
            fs.rmSync(workspaceRoot, { recursive: true, force: true });
        }
    };
}

function parseJsonStdout(result: ReturnType<typeof runCliJson>, message: string) {
    assert.ok(result.status !== 1 && result.status !== 2, `${message}:\n${formatCliJsonResult(result)}`);
    const trimmed = result.stdout.trim();
    assert.ok(trimmed.startsWith('{'), 'stdout must start with JSON object');
    return JSON.parse(trimmed);
}

test('status --json emits valid JSON to stdout', () => {
    const fixture = createDeployedWorkspaceFixture();
    try {
        const result = runCliJson(['status', '--target-root', fixture.workspaceRoot, '--json']);
        assert.equal(result.status, 0, `status --json exited non-zero:\n${formatCliJsonResult(result)}`);
        const parsed = JSON.parse(result.stdout);
        assert.equal(typeof parsed.readyForTasks, 'boolean');
        assert.equal(typeof parsed.bundlePresent, 'boolean');
        assert.equal(parsed.targetRoot, path.resolve(fixture.workspaceRoot));
    } finally {
        fixture.cleanup();
    }
});

test('status --json output does not include banner text', () => {
    const fixture = createDeployedWorkspaceFixture();
    try {
        const result = runCliJson(['status', '--target-root', fixture.workspaceRoot, '--json']);
        assert.equal(result.status, 0, `status --json exited non-zero:\n${formatCliJsonResult(result)}`);
        assert.ok(!result.stdout.includes('Workspace status'), 'JSON mode must suppress banner');
        const trimmed = result.stdout.trim();
        assert.ok(trimmed.startsWith('{'), 'stdout must start with JSON object');
    } finally {
        fixture.cleanup();
    }
});

test('doctor --json emits valid JSON to stdout', () => {
    const fixture = createDeployedWorkspaceFixture();
    try {
        const result = runCliJson(['doctor', '--target-root', fixture.workspaceRoot, '--json']);
        assert.ok(result.status !== 1 && result.status !== 2, `doctor --json crashed:\n${formatCliJsonResult(result)}`);
        const parsed = JSON.parse(result.stdout);
        assert.equal(typeof parsed.passed, 'boolean');
        assert.ok('targetRoot' in parsed);
        assert.ok('verifyResult' in parsed);
    } finally {
        fixture.cleanup();
    }
});

test('doctor --json output does not include banner text', () => {
    const fixture = createDeployedWorkspaceFixture();
    try {
        const result = runCliJson(['doctor', '--target-root', fixture.workspaceRoot, '--json']);
        assert.ok(result.status !== 1 && result.status !== 2, `doctor --json crashed:\n${formatCliJsonResult(result)}`);
        assert.ok(!result.stdout.includes('Workspace doctor'), 'JSON mode must suppress banner');
        const trimmed = result.stdout.trim();
        assert.ok(trimmed.startsWith('{'), 'stdout must start with JSON object');
    } finally {
        fixture.cleanup();
    }
});

test('check-update --json emits valid JSON to stdout in dry-run mode', () => {
    const fixture = createDeployedWorkspaceFixture();
    try {
        const parsed = parseJsonStdout(
            runCliJson([
                'check-update',
                '--target-root', fixture.workspaceRoot,
                '--source-path', REPO_ROOT,
                '--dry-run',
                '--trust-override',
                '--no-prompt',
                '--json'
            ]),
            'check-update --json crashed'
        );
        assert.equal(parsed.targetRoot, fixture.workspaceRoot);
        assert.equal(parsed.dryRun, true);
        assert.equal(typeof parsed.updateAvailable, 'boolean');
        assert.ok('checkUpdateResult' in parsed);
    } finally {
        fixture.cleanup();
    }
});

test('update --json emits valid JSON to stdout in dry-run mode', () => {
    const fixture = createDeployedWorkspaceFixture();
    try {
        const parsed = parseJsonStdout(
            runCliJson([
                'update',
                '--target-root', fixture.workspaceRoot,
                '--source-path', REPO_ROOT,
                '--dry-run',
                '--trust-override',
                '--no-prompt',
                '--json'
            ]),
            'update --json crashed'
        );
        assert.equal(parsed.targetRoot, fixture.workspaceRoot);
        assert.equal(parsed.dryRun, true);
        assert.equal(parsed.applyRequested, true);
        assert.ok('checkUpdateResult' in parsed);
    } finally {
        fixture.cleanup();
    }
});

test('rollback --json emits valid JSON to stdout in dry-run mode', () => {
    const fixture = createDeployedWorkspaceFixture();
    try {
        const parsed = parseJsonStdout(
            runCliJson(['rollback', '--target-root', fixture.workspaceRoot, '--dry-run', '--json']),
            'rollback --json crashed'
        );
        assert.equal(parsed.targetRoot, fixture.workspaceRoot);
        assert.equal(parsed.dryRun, true);
        assert.ok('rollbackMode' in parsed);
        assert.ok('previewAffectedItems' in parsed);
    } finally {
        fixture.cleanup();
    }
});

test('uninstall --json emits valid JSON to stdout in dry-run mode', () => {
    const fixture = createDeployedWorkspaceFixture();
    try {
        const parsed = parseJsonStdout(
            runCliJson(['uninstall', '--target-root', fixture.workspaceRoot, '--dry-run', '--json']),
            'uninstall --json crashed'
        );
        assert.equal(parsed.targetRoot, fixture.workspaceRoot);
        assert.equal(parsed.dryRun, true);
        assert.equal(parsed.result, 'DRY_RUN');
        assert.ok(Array.isArray(parsed.previewAffectedFiles));
    } finally {
        fixture.cleanup();
    }
});
