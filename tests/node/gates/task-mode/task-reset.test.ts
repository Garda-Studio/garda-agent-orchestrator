import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash } from 'node:crypto';

import { buildDefaultWorkflowConfig } from '../../../../src/core/workflow-config';
import { handleWorkflow } from '../../../../src/cli/commands/workflow-command';
import { handleTaskReset } from '../../../../src/cli/commands/gate-task-handlers';
import { EXIT_GENERAL_FAILURE, EXIT_USAGE_ERROR } from '../../../../src/cli/exit-codes';
import { runCliWithCapturedOutput } from '../../cli/commands/gate-test-cli-capture';
import { computeProtectedSnapshotDigest } from '../../../../src/gates/protected-control-plane/protected-control-plane';
import {
    resolveTaskResetScope,
    runTaskResetCommand
} from '../../../../src/cli/commands/gate-flows/task/task-reset-flow';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'garda-task-reset-test-'));
}

function cleanup(dir: string): void {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
}

function captureConsole<T>(run: () => T): T {
    const originalConsoleLog = console.log;
    console.log = () => undefined;
    try {
        return run();
    } finally {
        console.log = originalConsoleLog;
    }
}

interface FakeRepoOptions {
    taskId?: string;
    taskStatus?: string;
    hasEventsFile?: boolean;
    hasAggregateLines?: boolean;
    hasReviewArtifact?: boolean;
    hasReviewTempDir?: boolean;
    taskResetEnabled?: boolean;
    writeWorkflowConfig?: boolean;
    writeTaskResetAudit?: boolean;
    writeTaskResetReceipt?: boolean;
}

function buildFakeRepo(options: FakeRepoOptions = {}): {
    repoRoot: string;
    eventsRoot: string;
    reviewsRoot: string;
    taskId: string;
} {
    const {
        taskId = 'T-001',
        taskStatus = 'IN_PROGRESS',
        hasEventsFile = false,
        hasAggregateLines = false,
        hasReviewArtifact = false,
        hasReviewTempDir = false,
        taskResetEnabled = true,
        writeWorkflowConfig = true,
        writeTaskResetAudit = taskResetEnabled,
        writeTaskResetReceipt = writeTaskResetAudit
    } = options;

    const repoRoot = makeTmpDir();

    // TASK.md with a row for the task (4 columns required by syncTaskQueueStatusDetailed)
    const taskMdContent = [
        '## Tasks',
        '',
        '| Task ID | Status | Description | Notes |',
        '|---------|--------|-------------|-------|',
        `| ${taskId} | ${taskStatus} | Test task | - |`
    ].join('\n') + '\n';
    fs.writeFileSync(path.join(repoRoot, 'TASK.md'), taskMdContent, 'utf8');

    // Orchestrator directory structure
    const bundleDir = path.join(repoRoot, 'garda-agent-orchestrator');
    const eventsRoot = path.join(bundleDir, 'runtime', 'task-events');
    const reviewsRoot = path.join(bundleDir, 'runtime', 'reviews');
    fs.mkdirSync(eventsRoot, { recursive: true });
    fs.mkdirSync(reviewsRoot, { recursive: true });

    // Fake MANIFEST.md and VERSION to satisfy joinOrchestratorPath heuristics
    fs.writeFileSync(path.join(bundleDir, 'MANIFEST.md'), '# MANIFEST\n', 'utf8');
    fs.writeFileSync(path.join(bundleDir, 'VERSION'), '1.0.0\n', 'utf8');
    if (writeWorkflowConfig) {
        const configDir = path.join(bundleDir, 'live', 'config');
        fs.mkdirSync(configDir, { recursive: true });
        const workflowConfig = buildDefaultWorkflowConfig();
        workflowConfig.task_reset.enabled = taskResetEnabled;
        const configText = JSON.stringify(workflowConfig, null, 2) + '\n';
        fs.writeFileSync(
            path.join(configDir, 'workflow-config.json'),
            configText,
            'utf8'
        );
        if (writeTaskResetAudit) {
            const auditPath = path.join(bundleDir, 'runtime', 'workflow-config-audit.jsonl');
            const auditRecord = {
                schema_version: 1,
                event_source: 'workflow-config-set',
                timestamp_utc: '2026-05-13T00:00:00.000Z',
                actor: 'operator_command',
                command: 'workflow set',
                config_path: path.normalize(path.join(configDir, 'workflow-config.json')).replace(/\\/g, '/'),
                changed_fields: ['task_reset.enabled'],
                before_sha256: createHash('sha256').update('before', 'utf8').digest('hex'),
                after_sha256: createHash('sha256').update(configText, 'utf8').digest('hex')
            };
            const auditLine = JSON.stringify(auditRecord);
            fs.appendFileSync(auditPath, auditLine + '\n', 'utf8');
            if (writeTaskResetReceipt) {
                const receiptPath = path.join(bundleDir, 'live', 'config', 'task-reset-enablement-receipt.json');
                const receiptPayload = {
                    event_source: 'task-reset-enablement-receipt',
                    command: 'workflow set',
                    config_path: auditRecord.config_path,
                    changed_fields: ['task_reset.enabled'],
                    after_sha256: auditRecord.after_sha256,
                    audit_record_sha256: createHash('sha256').update(auditLine, 'utf8').digest('hex')
                };
                const receiptText = `${JSON.stringify({
                    schema_version: 1,
                    ...receiptPayload,
                    timestamp_utc: '2026-05-13T00:00:00.000Z',
                    actor: 'operator_command',
                    receipt_sha256: createHash('sha256').update(JSON.stringify(receiptPayload), 'utf8').digest('hex')
                }, null, 2)}\n`;
                fs.writeFileSync(receiptPath, receiptText, 'utf8');
                const protectedSnapshot = {
                    'garda-agent-orchestrator/live/config/task-reset-enablement-receipt.json': createHash('sha256').update(receiptText, 'utf8').digest('hex')
                };
                fs.writeFileSync(path.join(bundleDir, 'runtime', 'protected-control-plane-manifest.json'), `${JSON.stringify({
                    schema_version: 1,
                    event_source: 'refresh-protected-control-plane-manifest',
                    timestamp_utc: '2026-05-13T00:00:00.000Z',
                    workspace_root: repoRoot.replace(/\\/gu, '/'),
                    orchestrator_root: bundleDir.replace(/\\/gu, '/'),
                    protected_roots: ['garda-agent-orchestrator/live/config/task-reset-enablement-receipt.json'],
                    protected_snapshot: protectedSnapshot,
                    protected_snapshot_sha256: computeProtectedSnapshotDigest(protectedSnapshot),
                    is_source_checkout: false
                }, null, 2)}\n`, 'utf8');
            }
        }
    }

    if (hasEventsFile) {
        fs.writeFileSync(
            path.join(eventsRoot, `${taskId}.jsonl`),
            `{"task_id":"${taskId}","event_type":"PLAN_CREATED","outcome":"INFO"}\n`,
            'utf8'
        );
    }

    if (hasAggregateLines) {
        const allTasksPath = path.join(eventsRoot, 'all-tasks.jsonl');
        const lines = [
            `{"task_id":"${taskId}","event_type":"PLAN_CREATED","outcome":"INFO"}`,
            `{"task_id":"T-999","event_type":"OTHER","outcome":"INFO"}`,
            `{"task_id":"${taskId}","event_type":"COMPILE_PASSED","outcome":"PASS"}`
        ].join('\n') + '\n';
        fs.writeFileSync(allTasksPath, lines, 'utf8');
    }

    if (hasReviewArtifact) {
        fs.writeFileSync(
            path.join(reviewsRoot, `${taskId}-preflight.json`),
            JSON.stringify({ task_id: taskId, outcome: 'PASS' }) + '\n',
            'utf8'
        );
    }

    if (hasReviewTempDir) {
        const reviewTempDir = path.join(repoRoot, '.review-temp', taskId);
        fs.mkdirSync(reviewTempDir, { recursive: true });
        fs.writeFileSync(path.join(reviewTempDir, 'context.md'), '# context\n', 'utf8');
    }

    return { repoRoot, eventsRoot, reviewsRoot, taskId };
}

// ---------------------------------------------------------------------------
// resolveTaskResetScope
// ---------------------------------------------------------------------------

describe('resolveTaskResetScope', () => {
    it('returns empty scope when no artifacts exist', () => {
        const { repoRoot, eventsRoot, reviewsRoot, taskId } = buildFakeRepo();
        try {
            const scope = resolveTaskResetScope({ taskId, repoRoot, eventsRoot, reviewsRoot });
            assert.equal(scope.taskId, taskId);
            assert.equal(scope.artifacts.length, 0);
            assert.equal(scope.aggregateLineCount, 0);
            assert.equal(scope.hasAnyArtifacts, false);
        } finally {
            cleanup(repoRoot);
        }
    });

    it('detects per-task events file', () => {
        const { repoRoot, eventsRoot, reviewsRoot, taskId } = buildFakeRepo({ hasEventsFile: true });
        try {
            const scope = resolveTaskResetScope({ taskId, repoRoot, eventsRoot, reviewsRoot });
            const eventsArtifact = scope.artifacts.find((a) => a.type === 'task-events');
            assert.ok(eventsArtifact, 'should have task-events artifact');
            assert.ok(fs.existsSync(eventsArtifact.path));
            assert.equal(scope.hasAnyArtifacts, true);
        } finally {
            cleanup(repoRoot);
        }
    });

    it('detects review artifact', () => {
        const { repoRoot, eventsRoot, reviewsRoot, taskId } = buildFakeRepo({ hasReviewArtifact: true });
        try {
            const scope = resolveTaskResetScope({ taskId, repoRoot, eventsRoot, reviewsRoot });
            const reviewArtifact = scope.artifacts.find((a) => a.type === 'review-artifact');
            assert.ok(reviewArtifact, 'should have review-artifact');
            assert.equal(scope.reviewArtifactNames.length, 1);
            assert.ok(scope.reviewArtifactNames[0].endsWith('-preflight.json'));
        } finally {
            cleanup(repoRoot);
        }
    });

    it('detects suffixed task event and review artifacts', () => {
        const taskId = 'T-506-1';
        const { repoRoot, eventsRoot, reviewsRoot } = buildFakeRepo({
            taskId,
            hasEventsFile: true,
            hasReviewArtifact: true
        });
        try {
            const scope = resolveTaskResetScope({ taskId, repoRoot, eventsRoot, reviewsRoot });
            assert.ok(scope.artifacts.some((a) => a.type === 'task-events' && a.path.endsWith(`${taskId}.jsonl`)));
            assert.ok(scope.reviewArtifactNames.includes(`${taskId}-preflight.json`));
            assert.equal(scope.hasAnyArtifacts, true);
        } finally {
            cleanup(repoRoot);
        }
    });

    it('counts aggregate log lines for the task only', () => {
        const { repoRoot, eventsRoot, reviewsRoot, taskId } = buildFakeRepo({ hasAggregateLines: true });
        try {
            const scope = resolveTaskResetScope({ taskId, repoRoot, eventsRoot, reviewsRoot });
            assert.equal(scope.aggregateLineCount, 2, 'should count only lines for the target task');
        } finally {
            cleanup(repoRoot);
        }
    });

    it('detects review temp directory', () => {
        const { repoRoot, eventsRoot, reviewsRoot, taskId } = buildFakeRepo({ hasReviewTempDir: true });
        try {
            const scope = resolveTaskResetScope({ taskId, repoRoot, eventsRoot, reviewsRoot });
            const tempArtifact = scope.artifacts.find((a) => a.type === 'review-temp-dir');
            assert.ok(tempArtifact, 'should detect review-temp-dir');
        } finally {
            cleanup(repoRoot);
        }
    });

    it('reads previous status from TASK.md', () => {
        const { repoRoot, eventsRoot, reviewsRoot, taskId } = buildFakeRepo({ taskStatus: 'IN_REVIEW' });
        try {
            const scope = resolveTaskResetScope({ taskId, repoRoot, eventsRoot, reviewsRoot });
            assert.equal(scope.previousStatus, 'IN_REVIEW');
        } finally {
            cleanup(repoRoot);
        }
    });
});

// ---------------------------------------------------------------------------
// runTaskResetCommand — input validation
// ---------------------------------------------------------------------------

describe('runTaskResetCommand — validation', () => {
    it('throws for empty task ID', () => {
        assert.throws(
            () => runTaskResetCommand({ taskId: '', repoRoot: '.', confirm: true }),
            /TaskId must not be empty/
        );
    });

    it('throws for task ID with spaces', () => {
        assert.throws(
            () => runTaskResetCommand({ taskId: 'T-001 child', repoRoot: '.', confirm: true }),
            /semantic pattern/
        );
    });

    it('throws for task ID with path separators', () => {
        assert.throws(
            () => runTaskResetCommand({ taskId: 'T-001/child', repoRoot: '.', confirm: true }),
            /semantic pattern/
        );
    });

    it('throws when task ID is not found in TASK.md', () => {
        const repoRoot = makeTmpDir();
        try {
            fs.writeFileSync(
                path.join(repoRoot, 'TASK.md'),
                '| T-999 | TODO | Other task | - |\n',
                'utf8'
            );
            assert.throws(
                () => runTaskResetCommand({ taskId: 'T-001', repoRoot, confirm: true }),
                /not found in TASK\.md/
            );
        } finally {
            cleanup(repoRoot);
        }
    });

    it('throws when TASK.md is missing', () => {
        const repoRoot = makeTmpDir();
        try {
            assert.throws(
                () => runTaskResetCommand({ taskId: 'T-001', repoRoot, confirm: true }),
                /TASK\.md not found/
            );
        } finally {
            cleanup(repoRoot);
        }
    });
});

// ---------------------------------------------------------------------------
// runTaskResetCommand — ALREADY_RESET
// ---------------------------------------------------------------------------

describe('runTaskResetCommand — ALREADY_RESET', () => {
    it('returns ALREADY_RESET when task is DONE with no artifacts', () => {
        const { repoRoot, eventsRoot, reviewsRoot, taskId } = buildFakeRepo({ taskStatus: 'DONE' });
        try {
            const result = runTaskResetCommand({ taskId, repoRoot, eventsRoot, reviewsRoot, confirm: true, discard: true });
            assert.equal(result.outcome, 'ALREADY_RESET');
            assert.equal(result.targetStatus, 'DONE');
            assert.equal(result.exitCode, 0);
            assert.ok(result.outputLines.some((l) => l.includes('ALREADY_RESET')));
        } finally {
            cleanup(repoRoot);
        }
    });

    it('returns ALREADY_RESET when task is TODO with no artifacts and reopen is requested', () => {
        const { repoRoot, eventsRoot, reviewsRoot, taskId } = buildFakeRepo({ taskStatus: 'TODO' });
        try {
            const result = runTaskResetCommand({ taskId, repoRoot, eventsRoot, reviewsRoot, confirm: true, reopen: true });
            assert.equal(result.outcome, 'ALREADY_RESET');
            assert.equal(result.targetStatus, 'TODO');
            assert.equal(result.exitCode, 0);
            assert.ok(result.outputLines.some((l) => l.includes('TargetStatus: TODO')));
        } finally {
            cleanup(repoRoot);
        }
    });

    it('does NOT return ALREADY_RESET when DONE but artifacts still exist', () => {
        const { repoRoot, eventsRoot, reviewsRoot, taskId } = buildFakeRepo({
            taskStatus: 'DONE',
            hasEventsFile: true
        });
        try {
            const result = runTaskResetCommand({ taskId, repoRoot, eventsRoot, reviewsRoot, confirm: true, discard: true });
            assert.equal(result.outcome, 'RESET_COMPLETE');
        } finally {
            cleanup(repoRoot);
        }
    });
});

// ---------------------------------------------------------------------------
// runTaskResetCommand — target status and confirmation guards
// ---------------------------------------------------------------------------

describe('runTaskResetCommand — CONFIRMATION_REQUIRED', () => {
    it('returns TARGET_STATUS_REQUIRED when --confirm is ambiguous', () => {
        const { repoRoot, eventsRoot, reviewsRoot, taskId } = buildFakeRepo({ hasEventsFile: true });
        const eventsFile = path.join(eventsRoot, `${taskId}.jsonl`);
        try {
            const result = runTaskResetCommand({ taskId, repoRoot, eventsRoot, reviewsRoot, confirm: true });
            assert.equal(result.outcome, 'TARGET_STATUS_REQUIRED');
            assert.equal(result.exitCode, 1);
            assert.equal(result.targetStatus, null);
            assert.ok(result.outputLines.some((l) => l.includes('--reopen')));
            assert.ok(fs.existsSync(eventsFile), 'ambiguous confirm must not delete files');
        } finally {
            cleanup(repoRoot);
        }
    });

    it('throws when target status flags conflict', () => {
        const { repoRoot, eventsRoot, reviewsRoot, taskId } = buildFakeRepo({ hasEventsFile: true });
        try {
            assert.throws(
                () => runTaskResetCommand({ taskId, repoRoot, eventsRoot, reviewsRoot, confirm: true, reopen: true, discard: true }),
                /Conflicting task-reset target status flags/
            );
        } finally {
            cleanup(repoRoot);
        }
    });

    it('throws when --to-status is not TODO or DONE', () => {
        const { repoRoot, eventsRoot, reviewsRoot, taskId } = buildFakeRepo({ hasEventsFile: true });
        try {
            assert.throws(
                () => runTaskResetCommand({ taskId, repoRoot, eventsRoot, reviewsRoot, confirm: true, toStatus: 'IN_PROGRESS' }),
                /Invalid task-reset target status/
            );
        } finally {
            cleanup(repoRoot);
        }
    });

    it('returns CONFIRMATION_REQUIRED when neither --dry-run nor --confirm is given', () => {
        const { repoRoot, eventsRoot, reviewsRoot, taskId } = buildFakeRepo({ hasEventsFile: true });
        try {
            const result = runTaskResetCommand({ taskId, repoRoot, eventsRoot, reviewsRoot, reopen: true });
            assert.equal(result.outcome, 'CONFIRMATION_REQUIRED');
            assert.equal(result.targetStatus, 'TODO');
            assert.equal(result.exitCode, 0);
            assert.ok(result.outputLines.some((l) => l.includes('--confirm')));
        } finally {
            cleanup(repoRoot);
        }
    });

    it('CONFIRMATION_REQUIRED does not delete any files', () => {
        const { repoRoot, eventsRoot, reviewsRoot, taskId } = buildFakeRepo({
            hasEventsFile: true,
            hasReviewArtifact: true
        });
        const eventsFile = path.join(eventsRoot, `${taskId}.jsonl`);
        try {
            runTaskResetCommand({ taskId, repoRoot, eventsRoot, reviewsRoot, reopen: true });
            assert.ok(fs.existsSync(eventsFile), 'events file should NOT be deleted in confirmation-required mode');
        } finally {
            cleanup(repoRoot);
        }
    });
});

// ---------------------------------------------------------------------------
// runTaskResetCommand — DRY_RUN
// ---------------------------------------------------------------------------

describe('runTaskResetCommand — DRY_RUN', () => {
    it('returns DRY_RUN with artifact list and does not delete files', () => {
        const { repoRoot, eventsRoot, reviewsRoot, taskId } = buildFakeRepo({
            hasEventsFile: true,
            hasReviewArtifact: true,
            hasAggregateLines: true
        });
        const eventsFile = path.join(eventsRoot, `${taskId}.jsonl`);
        try {
            const result = runTaskResetCommand({ taskId, repoRoot, eventsRoot, reviewsRoot, dryRun: true, reopen: true });
            assert.equal(result.outcome, 'DRY_RUN');
            assert.equal(result.exitCode, 0);
            assert.ok(result.dryRun);
            assert.equal(result.targetStatus, 'TODO');
            assert.ok(result.outputLines.some((l) => l.includes('TargetStatus: TODO')));
            assert.ok(result.artifacts.length > 0);
            assert.ok(result.aggregateLinesRemoved > 0);
            // No files deleted
            assert.ok(fs.existsSync(eventsFile), 'events file should NOT be deleted in dry-run mode');
        } finally {
            cleanup(repoRoot);
        }
    });

    it('DRY_RUN does not write audit breadcrumb', () => {
        const { repoRoot, eventsRoot, reviewsRoot, taskId } = buildFakeRepo({ hasEventsFile: true });
        const resetReportPath = path.join(reviewsRoot, `${taskId}-reset-report.json`);
        try {
            runTaskResetCommand({ taskId, repoRoot, eventsRoot, reviewsRoot, dryRun: true, discard: true });
            assert.ok(!fs.existsSync(resetReportPath), 'reset report should NOT be written in dry-run');
        } finally {
            cleanup(repoRoot);
        }
    });
});

// ---------------------------------------------------------------------------
// runTaskResetCommand — TASK_RESET_DISABLED
// ---------------------------------------------------------------------------

describe('runTaskResetCommand — TASK_RESET_DISABLED', () => {
    it('blocks confirmed reset mutations when workflow config disables task reset', () => {
        const { repoRoot, eventsRoot, reviewsRoot, taskId } = buildFakeRepo({
            hasEventsFile: true,
            hasReviewArtifact: true,
            hasAggregateLines: true,
            taskResetEnabled: false
        });
        const eventsFile = path.join(eventsRoot, `${taskId}.jsonl`);
        const preflightPath = path.join(reviewsRoot, `${taskId}-preflight.json`);
        const resetReportPath = path.join(reviewsRoot, `${taskId}-reset-report.json`);
        const aggregatePath = path.join(eventsRoot, 'all-tasks.jsonl');
        try {
            const result = runTaskResetCommand({ taskId, repoRoot, eventsRoot, reviewsRoot, confirm: true, discard: true });
            assert.equal(result.outcome, 'TASK_RESET_DISABLED');
            assert.equal(result.exitCode, 1);
            assert.equal(result.targetStatus, 'DONE');
            assert.equal(result.artifacts.length, 0);
            assert.equal(result.aggregateLinesRemoved, 0);
            assert.ok(result.outputLines.some((l) => l.includes('TaskResetEnabled: false')));
            assert.ok(!result.outputLines.some((l) => l.includes('ArtifactsFound:')));
            assert.ok(result.outputLines.some((l) => l.includes('--task-reset-enabled true')));
            assert.ok(fs.existsSync(eventsFile), 'events file should remain');
            assert.ok(fs.existsSync(preflightPath), 'review artifact should remain');
            assert.ok(!fs.existsSync(resetReportPath), 'reset report should not be written');
            assert.ok(fs.readFileSync(aggregatePath, 'utf8').includes(`"${taskId}"`), 'aggregate log should remain intact');
            assert.ok(fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8').includes('IN_PROGRESS'), 'TASK.md status should remain unchanged');
        } finally {
            cleanup(repoRoot);
        }
    });

    it('leaves split-required parents unchanged when disabled reset is attempted', () => {
        const { repoRoot, eventsRoot, reviewsRoot, taskId } = buildFakeRepo({
            taskStatus: 'SPLIT_REQUIRED',
            hasEventsFile: true,
            hasReviewArtifact: true,
            hasAggregateLines: true,
            taskResetEnabled: false
        });
        const eventsFile = path.join(eventsRoot, `${taskId}.jsonl`);
        const preflightPath = path.join(reviewsRoot, `${taskId}-preflight.json`);
        try {
            const result = runTaskResetCommand({ taskId, repoRoot, eventsRoot, reviewsRoot, confirm: true, discard: true });
            const taskMd = fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8');

            assert.equal(result.outcome, 'TASK_RESET_DISABLED');
            assert.equal(result.exitCode, 1);
            assert.equal(result.artifacts.length, 0);
            assert.ok(fs.existsSync(eventsFile), 'events file should remain');
            assert.ok(fs.existsSync(preflightPath), 'review artifact should remain');
            assert.ok(taskMd.includes('| T-001 | SPLIT_REQUIRED |'), 'TASK.md status should remain SPLIT_REQUIRED');
        } finally {
            cleanup(repoRoot);
        }
    });

    it('blocks confirmed reset mutations when enabled by manual config edit without audit', () => {
        const { repoRoot, eventsRoot, reviewsRoot, taskId } = buildFakeRepo({
            hasEventsFile: true,
            taskResetEnabled: true,
            writeTaskResetAudit: false
        });
        const eventsFile = path.join(eventsRoot, `${taskId}.jsonl`);
        try {
            const result = runTaskResetCommand({ taskId, repoRoot, eventsRoot, reviewsRoot, confirm: true, discard: true });
            assert.equal(result.outcome, 'TASK_RESET_DISABLED');
            assert.equal(result.exitCode, 1);
            assert.ok(result.outputLines.some((l) => l.includes('no matching audited workflow set record')));
            assert.ok(fs.existsSync(eventsFile), 'events file should remain');
        } finally {
            cleanup(repoRoot);
        }
    });

    it('blocks confirmed reset mutations when a task-reset audit row has no matching enablement receipt', () => {
        const { repoRoot, eventsRoot, reviewsRoot, taskId } = buildFakeRepo({
            hasEventsFile: true,
            taskResetEnabled: true,
            writeTaskResetAudit: true,
            writeTaskResetReceipt: false
        });
        const eventsFile = path.join(eventsRoot, `${taskId}.jsonl`);
        try {
            const result = runTaskResetCommand({ taskId, repoRoot, eventsRoot, reviewsRoot, confirm: true, discard: true });
            assert.equal(result.outcome, 'TASK_RESET_DISABLED');
            assert.equal(result.exitCode, 1);
            assert.ok(result.outputLines.some((l) => l.includes('no matching audited workflow set record')));
            assert.ok(fs.existsSync(eventsFile), 'events file should remain');
        } finally {
            cleanup(repoRoot);
        }
    });

    it('blocks confirmed reset mutations when enablement receipt is not protected by a manifest', () => {
        const { repoRoot, eventsRoot, reviewsRoot, taskId } = buildFakeRepo({
            hasEventsFile: true,
            taskResetEnabled: true,
            writeTaskResetAudit: true,
            writeTaskResetReceipt: true
        });
        const eventsFile = path.join(eventsRoot, `${taskId}.jsonl`);
        const manifestPath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'protected-control-plane-manifest.json');
        try {
            fs.rmSync(manifestPath, { force: true });
            const result = runTaskResetCommand({ taskId, repoRoot, eventsRoot, reviewsRoot, confirm: true, discard: true });
            assert.equal(result.outcome, 'TASK_RESET_DISABLED');
            assert.equal(result.exitCode, 1);
            assert.ok(fs.existsSync(eventsFile), 'events file should remain');
        } finally {
            cleanup(repoRoot);
        }
    });

    it('blocks confirmed reset mutations when protected manifest does not match the enablement receipt', () => {
        const { repoRoot, eventsRoot, reviewsRoot, taskId } = buildFakeRepo({
            hasEventsFile: true,
            taskResetEnabled: true,
            writeTaskResetAudit: true,
            writeTaskResetReceipt: true
        });
        const eventsFile = path.join(eventsRoot, `${taskId}.jsonl`);
        const receiptPath = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'task-reset-enablement-receipt.json');
        try {
            fs.appendFileSync(receiptPath, '\n', 'utf8');
            const result = runTaskResetCommand({ taskId, repoRoot, eventsRoot, reviewsRoot, confirm: true, discard: true });
            assert.equal(result.outcome, 'TASK_RESET_DISABLED');
            assert.equal(result.exitCode, 1);
            assert.ok(fs.existsSync(eventsFile), 'events file should remain');
        } finally {
            cleanup(repoRoot);
        }
    });

    it('keeps audited reset enabled when a later duplicate audit row is not receipt-bound', () => {
        const { repoRoot, eventsRoot, reviewsRoot, taskId } = buildFakeRepo({
            hasEventsFile: true,
            taskResetEnabled: true,
            writeTaskResetAudit: true,
            writeTaskResetReceipt: true
        });
        const eventsFile = path.join(eventsRoot, `${taskId}.jsonl`);
        try {
            const configPath = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json');
            const configText = fs.readFileSync(configPath, 'utf8');
            const auditPath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'workflow-config-audit.jsonl');
            fs.appendFileSync(auditPath, `${JSON.stringify({
                schema_version: 1,
                event_source: 'workflow-config-set',
                timestamp_utc: '2026-05-13T00:01:00.000Z',
                actor: 'operator_command',
                command: 'workflow set',
                config_path: configPath.replace(/\\/gu, '/'),
                changed_fields: ['task_reset.enabled'],
                before_sha256: createHash('sha256').update('forged-before', 'utf8').digest('hex'),
                after_sha256: createHash('sha256').update(configText, 'utf8').digest('hex')
            })}\n`, 'utf8');

            const result = runTaskResetCommand({ taskId, repoRoot, eventsRoot, reviewsRoot, confirm: true, discard: true });
            assert.equal(result.outcome, 'RESET_COMPLETE');
            assert.equal(result.exitCode, 0);
            assert.ok(!fs.existsSync(eventsFile), 'events file should be deleted by the authorized reset');
        } finally {
            cleanup(repoRoot);
        }
    });

    it('blocks forged runtime audit rows from bridging current config to an older receipt-bound enablement', () => {
        const { repoRoot, eventsRoot, reviewsRoot, taskId } = buildFakeRepo({
            hasEventsFile: true,
            taskResetEnabled: true,
            writeTaskResetAudit: true,
            writeTaskResetReceipt: true
        });
        const eventsFile = path.join(eventsRoot, `${taskId}.jsonl`);
        try {
            const configPath = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json');
            const previousConfigText = fs.readFileSync(configPath, 'utf8');
            const currentConfig = JSON.parse(previousConfigText) as ReturnType<typeof buildDefaultWorkflowConfig>;
            currentConfig.auto_backup.keep_latest = 11;
            const currentConfigText = JSON.stringify(currentConfig, null, 2) + '\n';
            fs.writeFileSync(configPath, currentConfigText, 'utf8');
            const auditPath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'workflow-config-audit.jsonl');
            fs.appendFileSync(auditPath, `${JSON.stringify({
                schema_version: 1,
                event_source: 'workflow-config-set',
                timestamp_utc: '2026-05-13T00:01:00.000Z',
                actor: 'operator_command',
                command: 'workflow set',
                config_path: configPath.replace(/\\/gu, '/'),
                changed_fields: ['auto_backup.keep_latest'],
                before_sha256: createHash('sha256').update(previousConfigText, 'utf8').digest('hex'),
                after_sha256: createHash('sha256').update(currentConfigText, 'utf8').digest('hex')
            })}\n`, 'utf8');

            const result = runTaskResetCommand({ taskId, repoRoot, eventsRoot, reviewsRoot, confirm: true, discard: true });
            assert.equal(result.outcome, 'TASK_RESET_DISABLED');
            assert.equal(result.exitCode, 1);
            assert.ok(fs.existsSync(eventsFile), 'events file should remain');
        } finally {
            cleanup(repoRoot);
        }
    });

    it('blocks confirmed reset mutations when workflow config is missing', () => {
        const { repoRoot, eventsRoot, reviewsRoot, taskId } = buildFakeRepo({
            hasEventsFile: true,
            writeWorkflowConfig: false
        });
        const eventsFile = path.join(eventsRoot, `${taskId}.jsonl`);
        try {
            const result = runTaskResetCommand({ taskId, repoRoot, eventsRoot, reviewsRoot, confirm: true, reopen: true });
            assert.equal(result.outcome, 'TASK_RESET_DISABLED');
            assert.equal(result.exitCode, 1);
            assert.ok(result.outputLines.some((l) => l.includes('workflow-config.json is missing')));
            assert.ok(fs.existsSync(eventsFile), 'events file should remain');
        } finally {
            cleanup(repoRoot);
        }
    });

    it('allows dry-run while task reset mutations are disabled', () => {
        const { repoRoot, eventsRoot, reviewsRoot, taskId } = buildFakeRepo({
            hasEventsFile: true,
            taskResetEnabled: false
        });
        const eventsFile = path.join(eventsRoot, `${taskId}.jsonl`);
        try {
            const result = runTaskResetCommand({ taskId, repoRoot, eventsRoot, reviewsRoot, dryRun: true, discard: true });
            assert.equal(result.outcome, 'DRY_RUN');
            assert.equal(result.exitCode, 0);
            assert.ok(fs.existsSync(eventsFile), 'dry-run should not delete files');
        } finally {
            cleanup(repoRoot);
        }
    });

    it('allows confirmed reset mutations after workflow set writes audited task-reset opt-in', () => {
        const { repoRoot, eventsRoot, reviewsRoot, taskId } = buildFakeRepo({
            hasEventsFile: true,
            taskResetEnabled: false
        });
        const bundleRoot = path.join(repoRoot, 'garda-agent-orchestrator');
        const eventsFile = path.join(eventsRoot, `${taskId}.jsonl`);
        try {
            captureConsole(() => handleWorkflow([
                'set',
                '--bundle-root', bundleRoot,
                '--task-reset-enabled', 'true',
                '--operator-confirmed', 'yes',
                '--operator-confirmed-at-utc', new Date().toISOString()
            ], { name: 'garda-agent-orchestrator', version: '1.0.0' }));
            const result = runTaskResetCommand({ taskId, repoRoot, eventsRoot, reviewsRoot, confirm: true, discard: true });
            assert.equal(result.outcome, 'RESET_COMPLETE');
            assert.equal(result.exitCode, 0);
            assert.ok(!fs.existsSync(eventsFile), 'events file should be deleted after audited opt-in');
        } finally {
            cleanup(repoRoot);
        }
    });
});

// ---------------------------------------------------------------------------
// runTaskResetCommand — RESET_COMPLETE
// ---------------------------------------------------------------------------

describe('runTaskResetCommand — RESET_COMPLETE', () => {
    it('deletes per-task events file and returns RESET_COMPLETE', () => {
        const { repoRoot, eventsRoot, reviewsRoot, taskId } = buildFakeRepo({ hasEventsFile: true });
        const eventsFile = path.join(eventsRoot, `${taskId}.jsonl`);
        try {
            const result = runTaskResetCommand({ taskId, repoRoot, eventsRoot, reviewsRoot, confirm: true, discard: true });
            assert.equal(result.outcome, 'RESET_COMPLETE');
            assert.equal(result.targetStatus, 'DONE');
            assert.equal(result.exitCode, 0);
            assert.ok(!fs.existsSync(eventsFile), 'events file should be deleted');
        } finally {
            cleanup(repoRoot);
        }
    });

    it('deletes review artifacts', () => {
        const { repoRoot, eventsRoot, reviewsRoot, taskId } = buildFakeRepo({ hasReviewArtifact: true });
        const preflightPath = path.join(reviewsRoot, `${taskId}-preflight.json`);
        try {
            const result = runTaskResetCommand({ taskId, repoRoot, eventsRoot, reviewsRoot, confirm: true, discard: true });
            assert.equal(result.outcome, 'RESET_COMPLETE');
            assert.ok(!fs.existsSync(preflightPath), 'preflight artifact should be deleted');
        } finally {
            cleanup(repoRoot);
        }
    });

    it('removes task lines from aggregate log', () => {
        const { repoRoot, eventsRoot, reviewsRoot, taskId } = buildFakeRepo({ hasAggregateLines: true });
        const aggregatePath = path.join(eventsRoot, 'all-tasks.jsonl');
        try {
            const result = runTaskResetCommand({ taskId, repoRoot, eventsRoot, reviewsRoot, confirm: true, discard: true });
            assert.equal(result.outcome, 'RESET_COMPLETE');
            assert.ok(result.aggregateLinesRemoved > 0);
            const remaining = fs.readFileSync(aggregatePath, 'utf8');
            assert.ok(!remaining.includes(`"${taskId}"`), 'task lines should be removed from aggregate log');
            assert.ok(remaining.includes('"T-999"'), 'other task lines should remain');
        } finally {
            cleanup(repoRoot);
        }
    });

    it('deletes review temp directory', () => {
        const { repoRoot, eventsRoot, reviewsRoot, taskId } = buildFakeRepo({ hasReviewTempDir: true });
        const reviewTempDir = path.join(repoRoot, '.review-temp', taskId);
        try {
            runTaskResetCommand({ taskId, repoRoot, eventsRoot, reviewsRoot, confirm: true, discard: true });
            assert.ok(!fs.existsSync(reviewTempDir), 'review temp dir should be deleted');
        } finally {
            cleanup(repoRoot);
        }
    });

    it('writes audit breadcrumb before deletion', () => {
        const { repoRoot, eventsRoot, reviewsRoot, taskId } = buildFakeRepo({ hasEventsFile: true });
        const resetReportPath = path.join(reviewsRoot, `${taskId}-reset-report.json`);
        try {
            const result = runTaskResetCommand({ taskId, repoRoot, eventsRoot, reviewsRoot, confirm: true, discard: true });
            assert.equal(result.outcome, 'RESET_COMPLETE');
            assert.ok(fs.existsSync(resetReportPath), 'audit breadcrumb should be written');
            const report = JSON.parse(fs.readFileSync(resetReportPath, 'utf8')) as Record<string, unknown>;
            assert.equal(report.task_id, taskId);
            assert.equal(report.event_source, 'task-reset');
            assert.equal(report.reset_by, 'operator');
            assert.equal(report.previous_status, 'IN_PROGRESS');
            assert.equal(report.target_status, 'DONE');
            assert.ok(typeof report.timestamp_utc === 'string');
        } finally {
            cleanup(repoRoot);
        }
    });

    it('audit breadcrumb is not itself deleted', () => {
        const { repoRoot, eventsRoot, reviewsRoot, taskId } = buildFakeRepo({ hasReviewArtifact: true });
        const resetReportPath = path.join(reviewsRoot, `${taskId}-reset-report.json`);
        try {
            runTaskResetCommand({ taskId, repoRoot, eventsRoot, reviewsRoot, confirm: true, discard: true });
            assert.ok(fs.existsSync(resetReportPath), 'reset report (breadcrumb) must survive deletion phase');
        } finally {
            cleanup(repoRoot);
        }
    });

    it('terminal discard updates TASK.md status to DONE', () => {
        const { repoRoot, eventsRoot, reviewsRoot, taskId } = buildFakeRepo({
            taskStatus: 'IN_PROGRESS',
            hasEventsFile: true
        });
        try {
            const result = runTaskResetCommand({ taskId, repoRoot, eventsRoot, reviewsRoot, confirm: true, discard: true });
            assert.equal(result.outcome, 'RESET_COMPLETE');
            assert.equal(result.targetStatus, 'DONE');
            assert.ok(result.statusSyncOutcome === 'updated' || result.statusSyncOutcome === 'already_synced');
            const taskMd = fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8');
            assert.ok(taskMd.includes('DONE'), 'TASK.md should have DONE status');
        } finally {
            cleanup(repoRoot);
        }
    });

    it('reset-for-rerun updates TASK.md status to TODO', () => {
        const { repoRoot, eventsRoot, reviewsRoot, taskId } = buildFakeRepo({
            taskStatus: 'IN_REVIEW',
            hasEventsFile: true,
            hasReviewArtifact: true
        });
        try {
            const result = runTaskResetCommand({ taskId, repoRoot, eventsRoot, reviewsRoot, confirm: true, reopen: true });
            assert.equal(result.outcome, 'RESET_COMPLETE');
            assert.equal(result.previousStatus, 'IN_REVIEW');
            assert.equal(result.targetStatus, 'TODO');
            const taskMd = fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8');
            assert.ok(taskMd.includes('TODO'), 'TASK.md should have TODO status');
            const report = JSON.parse(fs.readFileSync(String(result.resetReportPath), 'utf8')) as Record<string, unknown>;
            assert.equal(report.target_status, 'TODO');
        } finally {
            cleanup(repoRoot);
        }
    });

    it('reset-for-rerun rolls back pending generated review follow-ups and their parent marker', () => {
        const { repoRoot, eventsRoot, reviewsRoot, taskId } = buildFakeRepo({
            taskStatus: 'IN_REVIEW',
            hasEventsFile: true,
            hasReviewArtifact: true
        });
        const fingerprint = 'a'.repeat(64);
        const taskPath = path.join(repoRoot, 'TASK.md');
        fs.writeFileSync(taskPath, [
            '## Active Queue',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
            `| ${taskId} | IN_REVIEW | P1 | workflow | Parent | codex | 2026-08-20 | balanced | Keep this note. Review follow-up tasks materialized: \`${taskId}-F1\`; artifact \`runtime/reviews/${taskId}-code-findings-follow-ups.json\`. |`,
            `| ${taskId}-F1 | TODO | P2 | workflow | Deferred findings | codex | 2026-08-20 | fast | Child of \`${taskId}\`. review_follow_up_group_fingerprint=${fingerprint}. |`,
            `| ${taskId}-F2 | DONE | P2 | workflow | Completed findings | codex | 2026-08-20 | fast | Child of \`${taskId}\`. review_follow_up_group_fingerprint=${fingerprint}. |`,
            '| T-999 | TODO | P3 | other | Unrelated | codex | 2026-08-20 | fast | Keep. |',
            ''
        ].join('\n'), 'utf8');
        fs.writeFileSync(
            path.join(reviewsRoot, `${taskId}-code-findings-follow-ups.json`),
            JSON.stringify({ task_id: taskId, status: 'MATERIALIZED' }) + '\n',
            'utf8'
        );

        try {
            const scope = resolveTaskResetScope({ taskId, repoRoot, eventsRoot, reviewsRoot });
            assert.deepEqual(scope.pendingFollowUpTaskIds, [`${taskId}-F1`]);
            assert.deepEqual(scope.preservedFollowUpTaskIds, [`${taskId}-F2`]);
            assert.ok(scope.reviewArtifactNames.includes(`${taskId}-code-findings-follow-ups.json`));

            const result = runTaskResetCommand({ taskId, repoRoot, eventsRoot, reviewsRoot, confirm: true, reopen: true });
            assert.equal(result.outcome, 'RESET_COMPLETE');
            const taskMd = fs.readFileSync(taskPath, 'utf8');
            assert.doesNotMatch(taskMd, new RegExp(`\\|\\s*${taskId}-F1\\s*\\|`, 'u'));
            assert.match(taskMd, new RegExp(`\\|\\s*${taskId}-F2\\s*\\|`, 'u'));
            assert.match(taskMd, /Keep this note\./u);
            assert.doesNotMatch(taskMd, /Review follow-up tasks materialized:/u);
            assert.match(taskMd, /\| T-999\s+\|/u);
            assert.ok(!fs.existsSync(path.join(reviewsRoot, `${taskId}-code-findings-follow-ups.json`)));

            const report = JSON.parse(fs.readFileSync(String(result.resetReportPath), 'utf8')) as Record<string, unknown>;
            assert.deepEqual(report.removed_pending_follow_up_task_ids, [`${taskId}-F1`]);
            assert.deepEqual(report.pending_follow_up_task_ids_planned_for_removal, [`${taskId}-F1`]);
            assert.deepEqual(report.preserved_started_or_terminal_follow_up_task_ids, [`${taskId}-F2`]);
            assert.ok(result.outputLines.includes(`PendingFollowUpTasksPlannedForRemoval: ${taskId}-F1`));
            assert.ok(result.outputLines.includes(`PendingFollowUpTasksRemoved: ${taskId}-F1`));
            assert.ok(result.outputLines.includes(`StartedOrTerminalFollowUpTasksPreserved: ${taskId}-F2`));
        } finally {
            cleanup(repoRoot);
        }
    });

    it('preserves the current reset breadcrumb across repeated resets', () => {
        const { repoRoot, eventsRoot, reviewsRoot, taskId } = buildFakeRepo({
            taskStatus: 'IN_REVIEW',
            hasEventsFile: true
        });
        const resetReportPath = path.join(reviewsRoot, `${taskId}-reset-report.json`);
        fs.writeFileSync(resetReportPath, JSON.stringify({ task_id: taskId, timestamp_utc: 'old' }) + '\n', 'utf8');
        try {
            const result = runTaskResetCommand({ taskId, repoRoot, eventsRoot, reviewsRoot, confirm: true, reopen: true });
            assert.equal(result.outcome, 'RESET_COMPLETE');
            assert.ok(fs.existsSync(resetReportPath));
            const report = JSON.parse(fs.readFileSync(resetReportPath, 'utf8')) as Record<string, unknown>;
            assert.equal(report.event_source, 'task-reset');
            assert.notEqual(report.timestamp_utc, 'old');
        } finally {
            cleanup(repoRoot);
        }
    });

    it('is idempotent when no artifacts exist (no files to delete)', () => {
        const { repoRoot, eventsRoot, reviewsRoot, taskId } = buildFakeRepo({ taskStatus: 'IN_PROGRESS' });
        try {
            const result = runTaskResetCommand({ taskId, repoRoot, eventsRoot, reviewsRoot, confirm: true, discard: true });
            assert.equal(result.outcome, 'RESET_COMPLETE');
            assert.equal(result.artifacts.length, 0);
            assert.equal(result.aggregateLinesRemoved, 0);
        } finally {
            cleanup(repoRoot);
        }
    });

    it('preserves other task lines in aggregate log', () => {
        const { repoRoot, eventsRoot, reviewsRoot, taskId } = buildFakeRepo({ hasAggregateLines: true });
        const aggregatePath = path.join(eventsRoot, 'all-tasks.jsonl');
        try {
            runTaskResetCommand({ taskId, repoRoot, eventsRoot, reviewsRoot, confirm: true, discard: true });
            const remaining = fs.readFileSync(aggregatePath, 'utf8');
            const lines = remaining.split('\n').filter((l) => l.trim());
            assert.equal(lines.length, 1, 'only T-999 line should remain');
            assert.ok(lines[0].includes('"T-999"'));
        } finally {
            cleanup(repoRoot);
        }
    });

    it('previous status is captured in result', () => {
        const { repoRoot, eventsRoot, reviewsRoot, taskId } = buildFakeRepo({
            taskStatus: 'IN_REVIEW',
            hasEventsFile: true
        });
        try {
            const result = runTaskResetCommand({ taskId, repoRoot, eventsRoot, reviewsRoot, confirm: true, discard: true });
            assert.equal(result.previousStatus, 'IN_REVIEW');
        } finally {
            cleanup(repoRoot);
        }
    });

    it('rejects lowercase task ID aliases instead of normalizing them', () => {
        const { repoRoot, eventsRoot, reviewsRoot } = buildFakeRepo({ taskId: 'T-001' });
        try {
            assert.throws(
                () => runTaskResetCommand({
                    taskId: 't-001',
                    repoRoot,
                    eventsRoot,
                    reviewsRoot,
                    confirm: true,
                    discard: true
                }),
                /semantic pattern/
            );
        } finally {
            cleanup(repoRoot);
        }
    });
});

// ---------------------------------------------------------------------------
// runTaskResetCommand — full reset with all artifact types
// ---------------------------------------------------------------------------

describe('runTaskResetCommand — full artifact cleanup', () => {
    it('cleans all artifact types in one pass', () => {
        const { repoRoot, eventsRoot, reviewsRoot, taskId } = buildFakeRepo({
            taskStatus: 'IN_PROGRESS',
            hasEventsFile: true,
            hasAggregateLines: true,
            hasReviewArtifact: true,
            hasReviewTempDir: true
        });

        const eventsFile = path.join(eventsRoot, `${taskId}.jsonl`);
        const preflightPath = path.join(reviewsRoot, `${taskId}-preflight.json`);
        const reviewTempDir = path.join(repoRoot, '.review-temp', taskId);

        try {
            const result = runTaskResetCommand({ taskId, repoRoot, eventsRoot, reviewsRoot, confirm: true, discard: true });

            assert.equal(result.outcome, 'RESET_COMPLETE');
            assert.equal(result.targetStatus, 'DONE');
            assert.ok(!fs.existsSync(eventsFile), 'events file gone');
            assert.ok(!fs.existsSync(preflightPath), 'preflight artifact gone');
            assert.ok(!fs.existsSync(reviewTempDir), 'review temp dir gone');
            assert.ok(result.aggregateLinesRemoved > 0);

            const taskMd = fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8');
            assert.ok(taskMd.includes('DONE'));
        } finally {
            cleanup(repoRoot);
        }
    });
});

describe('runTaskResetCommand — confirmed one-action reset', () => {
    it('CLI reset handler admits a fresh confirmed one-action without changing permanent OFF', async () => {
        const fixture = buildFakeRepo({ taskResetEnabled: false, hasEventsFile: true });
        const configPath = path.join(fixture.repoRoot, 'garda-agent-orchestrator/live/config/workflow-config.json');
        const originalConfig = fs.readFileSync(configPath);
        try {
            fs.mkdirSync(path.join(fixture.repoRoot, '.git'));
            await handleTaskReset(['--task-id', fixture.taskId, '--reopen', '--confirm', '--one-action',
                '--operator-confirmed', 'yes', '--operator-confirmed-at-utc', new Date().toISOString(),
                '--repo-root', fixture.repoRoot]);
            assert.deepEqual(fs.readFileSync(configPath), originalConfig);
            assert.equal(fs.existsSync(path.join(fixture.eventsRoot, `${fixture.taskId}.jsonl`)), false);
            assert.match(fs.readFileSync(path.join(fixture.repoRoot, 'TASK.md'), 'utf8'), /TODO/u);
        } finally { cleanup(fixture.repoRoot); }
    });

    it('executes a confirmed one-action reset while permanent reset stays disabled', () => {
        const fixture = buildFakeRepo({ taskResetEnabled: false, hasEventsFile: true });
        const configPath = path.join(fixture.repoRoot, 'garda-agent-orchestrator/live/config/workflow-config.json');
        const originalConfig = fs.readFileSync(configPath);
        try {
            fs.mkdirSync(path.join(fixture.repoRoot, '.git'));
            const options = {
                ...fixture, confirm: true, reopen: true, oneAction: true,
                operatorConfirmed: 'yes', operatorConfirmedAtUtc: new Date().toISOString()
            };
            const result = runTaskResetCommand(options);
            assert.equal(result.outcome, 'RESET_COMPLETE');
            assert.deepEqual(fs.readFileSync(configPath), originalConfig);
        } finally {
            cleanup(fixture.repoRoot);
        }
    });

    it('interrupted authority preparation preserves permanent OFF and blocks unqualified reset', () => {
        const fixture = buildFakeRepo({ taskResetEnabled: false, hasEventsFile: true });
        const configPath = path.join(fixture.repoRoot, 'garda-agent-orchestrator/live/config/workflow-config.json');
        const originalConfig = fs.readFileSync(configPath);
        try {
            fs.mkdirSync(path.join(fixture.repoRoot, '.git'));
            const prepared = runTaskResetCommand({ ...fixture, reopen: true, prepareOneAction: true,
                operatorConfirmed: 'yes', operatorConfirmedAtUtc: new Date().toISOString() });
            assert.equal(prepared.outcome, 'ONE_ACTION_AUTHORITY_PREPARED');
            assert.match(prepared.oneActionAuthority ?? '', /^[a-f0-9]{64}$/u);
            assert.deepEqual(fs.readFileSync(configPath), originalConfig);
            assert.equal(fs.existsSync(path.join(fixture.eventsRoot, `${fixture.taskId}.jsonl`)), true);
            assert.equal(fs.existsSync(path.join(fixture.reviewsRoot, `${fixture.taskId}-reset-report.json`)), false);
            assert.equal(runTaskResetCommand({ ...fixture, reopen: true, confirm: true }).outcome, 'TASK_RESET_DISABLED');
        } finally { cleanup(fixture.repoRoot); }
    });

    it('later explicit audited enable survives one-action reset completion', () => {
        const fixture = buildFakeRepo({ taskResetEnabled: false, hasEventsFile: true });
        const bundleRoot = path.join(fixture.repoRoot, 'garda-agent-orchestrator');
        const configPath = path.join(bundleRoot, 'live/config/workflow-config.json');
        try {
            fs.mkdirSync(path.join(fixture.repoRoot, '.git'));
            const prepared = runTaskResetCommand({ ...fixture, reopen: true, prepareOneAction: true,
                operatorConfirmed: 'yes', operatorConfirmedAtUtc: new Date().toISOString() });
            captureConsole(() => handleWorkflow(['set', '--bundle-root', bundleRoot,
                '--task-reset-enabled', 'true', '--operator-confirmed', 'yes',
                '--operator-confirmed-at-utc', new Date().toISOString()],
            { name: 'garda-agent-orchestrator', version: '1.0.0' }));
            const enabledConfig = fs.readFileSync(configPath);
            const receiptPath = path.join(bundleRoot, 'live/config/task-reset-enablement-receipt.json');
            const enabledReceipt = fs.readFileSync(receiptPath);
            const result = runTaskResetCommand({ ...fixture, reopen: true, confirm: true,
                oneActionAuthority: prepared.oneActionAuthority });
            assert.equal(result.outcome, 'RESET_COMPLETE');
            assert.deepEqual(fs.readFileSync(configPath), enabledConfig);
            assert.deepEqual(fs.readFileSync(receiptPath), enabledReceipt);
            assert.equal(JSON.parse(fs.readFileSync(configPath, 'utf8')).task_reset.enabled, true);
        } finally { cleanup(fixture.repoRoot); }
    });

    it('rejects malformed authority even when permanent reset is audited ON', () => {
        const fixture = buildFakeRepo({ hasEventsFile: true });
        try {
            assert.throws(() => runTaskResetCommand({ ...fixture, reopen: true, confirm: true,
                oneActionAuthority: '' }), /malformed/);
            assert.equal(fs.existsSync(path.join(fixture.eventsRoot, `${fixture.taskId}.jsonl`)), true);
            assert.equal(fs.existsSync(path.join(fixture.reviewsRoot, `${fixture.taskId}-reset-report.json`)), false);
        } finally { cleanup(fixture.repoRoot); }
    });

    it('rejects replay of prepared authority after native reset completion', () => {
        const fixture = buildFakeRepo({ taskResetEnabled: false, hasEventsFile: true });
        try {
            fs.mkdirSync(path.join(fixture.repoRoot, '.git'));
            const prepared = runTaskResetCommand({ ...fixture, reopen: true, prepareOneAction: true,
                operatorConfirmed: 'yes', operatorConfirmedAtUtc: new Date().toISOString() });
            const options = { ...fixture, reopen: true, confirm: true, oneActionAuthority: prepared.oneActionAuthority };
            assert.equal(runTaskResetCommand(options).outcome, 'RESET_COMPLETE');
            const report = fs.readFileSync(path.join(fixture.reviewsRoot, `${fixture.taskId}-reset-report.json`));
            assert.throws(() => runTaskResetCommand(options), /replay|mismatch/);
            assert.deepEqual(fs.readFileSync(path.join(fixture.reviewsRoot, `${fixture.taskId}-reset-report.json`)), report);
        } finally { cleanup(fixture.repoRoot); }
    });

    it('rejects replaced task evidence between preparation and reset effects', () => {
        const fixture = buildFakeRepo({ taskResetEnabled: false, hasEventsFile: true });
        try {
            fs.mkdirSync(path.join(fixture.repoRoot, '.git'));
            const prepared = runTaskResetCommand({ ...fixture, reopen: true, prepareOneAction: true,
                operatorConfirmed: 'yes', operatorConfirmedAtUtc: new Date().toISOString() });
            const events = path.join(fixture.eventsRoot, `${fixture.taskId}.jsonl`);
            fs.appendFileSync(events, '{"changed":true}\n');
            assert.throws(() => runTaskResetCommand({ ...fixture, reopen: true, confirm: true,
                oneActionAuthority: prepared.oneActionAuthority }), /mismatch/);
            assert.equal(fs.readFileSync(events, 'utf8').includes('"changed":true'), true);
            assert.equal(fs.existsSync(path.join(fixture.reviewsRoot, `${fixture.taskId}-reset-report.json`)), false);
        } finally { cleanup(fixture.repoRoot); }
    });

    it('rejects changed existing scratch descendants after authority preparation', () => {
        const fixture = buildFakeRepo({ taskResetEnabled: false, hasReviewTempDir: true });
        try {
            fs.mkdirSync(path.join(fixture.repoRoot, '.git'));
            const scratch = path.join(fixture.repoRoot, '.review-temp', fixture.taskId);
            const nested = path.join(scratch, 'nested');
            fs.mkdirSync(nested);
            const context = path.join(nested, 'context.md');
            fs.writeFileSync(context, '# original nested evidence\n');
            const prepared = runTaskResetCommand({ ...fixture, reopen: true, prepareOneAction: true,
                operatorConfirmed: 'yes', operatorConfirmedAtUtc: new Date().toISOString() });
            const directoryBefore = fs.statSync(nested);
            fs.writeFileSync(context, '# changed nested evidence\n');
            const directoryAfter = fs.statSync(nested);
            assert.equal(directoryAfter.mtimeMs, directoryBefore.mtimeMs);
            assert.equal(directoryAfter.ctimeMs, directoryBefore.ctimeMs);
            assert.throws(() => runTaskResetCommand({ ...fixture, reopen: true, confirm: true,
                oneActionAuthority: prepared.oneActionAuthority }), /mismatch/);
            assert.equal(fs.readFileSync(context, 'utf8'), '# changed nested evidence\n');
            assert.equal(fs.existsSync(path.join(fixture.reviewsRoot, `${fixture.taskId}-reset-report.json`)), false);
        } finally { cleanup(fixture.repoRoot); }
    });

    it('rejects count-preserving aggregate task evidence changes after authority preparation', () => {
        const fixture = buildFakeRepo({ taskResetEnabled: false, hasAggregateLines: true });
        try {
            fs.mkdirSync(path.join(fixture.repoRoot, '.git'));
            const aggregate = path.join(fixture.eventsRoot, 'all-tasks.jsonl');
            const prepared = runTaskResetCommand({ ...fixture, reopen: true, prepareOneAction: true,
                operatorConfirmed: 'yes', operatorConfirmedAtUtc: new Date().toISOString() });
            const replacement = fs.readFileSync(aggregate, 'utf8').replace('COMPILE_PASSED', 'COMPILE_FAILED');
            fs.writeFileSync(aggregate, replacement);
            assert.equal(resolveTaskResetScope(fixture).aggregateLineCount, 2);
            assert.throws(() => runTaskResetCommand({ ...fixture, reopen: true, confirm: true,
                oneActionAuthority: prepared.oneActionAuthority }), /mismatch/);
            assert.equal(fs.readFileSync(aggregate, 'utf8'), replacement);
            assert.equal(fs.existsSync(path.join(fixture.reviewsRoot, `${fixture.taskId}-reset-report.json`)), false);
        } finally { cleanup(fixture.repoRoot); }
    });

    it('preserves unrelated aggregate additions without invalidating task-specific authority', () => {
        const fixture = buildFakeRepo({ taskResetEnabled: false, hasAggregateLines: true });
        try {
            fs.mkdirSync(path.join(fixture.repoRoot, '.git'));
            const aggregate = path.join(fixture.eventsRoot, 'all-tasks.jsonl');
            const prepared = runTaskResetCommand({ ...fixture, reopen: true, prepareOneAction: true,
                operatorConfirmed: 'yes', operatorConfirmedAtUtc: new Date().toISOString() });
            const foreignLine = '{"task_id":"T-999","event_type":"NEW_UNRELATED_EVIDENCE"}';
            fs.appendFileSync(aggregate, foreignLine + '\n');
            const result = runTaskResetCommand({ ...fixture, reopen: true, confirm: true,
                oneActionAuthority: prepared.oneActionAuthority });
            assert.equal(result.outcome, 'RESET_COMPLETE');
            assert.equal(result.aggregateLinesRemoved, 2);
            assert.equal(fs.readFileSync(aggregate, 'utf8'),
                '{"task_id":"T-999","event_type":"OTHER","outcome":"INFO"}\n' + foreignLine + '\n');
        } finally { cleanup(fixture.repoRoot); }
    });
});

describe('handleTaskReset --as-json', () => {
    it('prints one JSON object for parse and command errors without an outer CLI failure marker', async () => {
        const fixture = buildFakeRepo({ hasEventsFile: true, hasReviewArtifact: true });
        const taskMdBefore = fs.readFileSync(path.join(fixture.repoRoot, 'TASK.md'), 'utf8');
        try {
            for (const scenario of [
                { argv: ['--as-json'], message: /TaskId must not be empty/u, exitCode: EXIT_USAGE_ERROR },
                { argv: ['--unknown', '--as-json'], message: /Unknown option: --unknown/u, exitCode: EXIT_USAGE_ERROR },
                { argv: ['--as-json=true', '--unknown'], message: /Unknown option: --unknown/u, exitCode: EXIT_USAGE_ERROR },
                { argv: ['--as-json', 'yes', '--unknown'], message: /Unknown option: --unknown/u, exitCode: EXIT_USAGE_ERROR },
                { argv: [fixture.taskId, '--as-json'], message: /Unexpected positional argument: T-001.*Suggested command:/u,
                    exitCode: EXIT_GENERAL_FAILURE },
                { argv: ['--task', fixture.taskId, '--as-json'], message: /Unknown option: --task.*Suggested command:/u,
                    exitCode: EXIT_USAGE_ERROR },
                { argv: ['--task-id', 'T-999', '--reopen', '--dry-run', '--as-json'],
                    message: /Task 'T-999' not found in TASK.md/u, exitCode: EXIT_GENERAL_FAILURE }
            ]) {
                const result = await runCliWithCapturedOutput([
                    'gate', 'task-reset', ...scenario.argv, '--repo-root', fixture.repoRoot
                ], { cwd: fixture.repoRoot });
                const payload = JSON.parse(result.logs.join('\n')) as Record<string, unknown>;

                assert.equal(payload.outcome, 'ERROR');
                assert.match(String(payload.error), scenario.message);
                assert.equal(payload.exit_code, scenario.exitCode);
                assert.equal(result.exitCode, scenario.exitCode);
                assert.deepEqual(result.errors, []);
            }
            assert.equal(fs.readFileSync(path.join(fixture.repoRoot, 'TASK.md'), 'utf8'), taskMdBefore);
        } finally {
            cleanup(fixture.repoRoot);
        }
    });

    it('keeps task-ID syntax remediation in text mode and for other gates', async () => {
        const fixture = buildFakeRepo();
        try {
            for (const scenario of [
                { argv: ['task-reset', fixture.taskId], exitCode: EXIT_GENERAL_FAILURE },
                { argv: ['task-reset', '--task', fixture.taskId], exitCode: EXIT_USAGE_ERROR },
                { argv: ['task-events-summary', fixture.taskId, '--as-json'], exitCode: EXIT_GENERAL_FAILURE }
            ]) {
                const result = await runCliWithCapturedOutput([
                    'gate', ...scenario.argv, '--repo-root', fixture.repoRoot
                ], { cwd: fixture.repoRoot });

                assert.equal(result.exitCode, scenario.exitCode);
                assert.deepEqual(result.logs, []);
                assert.match(result.errors.join('\n'), /GARDA_CLI_FAILED/u);
                assert.match(result.errors.join('\n'), /Canonical task-id syntax.*Suggested command:/u);
            }
        } finally {
            cleanup(fixture.repoRoot);
        }
    });

    it('keeps text error handling when JSON output is absent or explicitly disabled', async () => {
        const fixture = buildFakeRepo();
        try {
            for (const formatArgs of [[], ['--as-json=false'], ['--as-json', 'false']]) {
                const result = await runCliWithCapturedOutput([
                    'gate', 'task-reset', ...formatArgs, '--unknown', '--repo-root', fixture.repoRoot
                ], { cwd: fixture.repoRoot });

                assert.equal(result.exitCode, EXIT_USAGE_ERROR);
                assert.deepEqual(result.logs, []);
                assert.match(result.errors.join('\n'), /GARDA_CLI_FAILED/u);
                assert.match(result.errors.join('\n'), /Unknown option: --unknown/u);
            }
        } finally {
            cleanup(fixture.repoRoot);
        }
    });

    it('keeps returned failure results and their exit codes in JSON', async () => {
        const fixture = buildFakeRepo({ taskResetEnabled: false });
        try {
            const result = await runCliWithCapturedOutput([
                'gate', 'task-reset', '--task-id', fixture.taskId, '--reopen', '--confirm', '--as-json',
                '--repo-root', fixture.repoRoot
            ], { cwd: fixture.repoRoot });
            const payload = JSON.parse(result.logs.join('\n')) as Record<string, unknown>;

            assert.equal(payload.outcome, 'TASK_RESET_DISABLED');
            assert.equal(payload.exit_code, EXIT_GENERAL_FAILURE);
            assert.equal(result.exitCode, EXIT_GENERAL_FAILURE);
            assert.deepEqual(result.errors, []);
        } finally {
            cleanup(fixture.repoRoot);
        }
    });

    it('prints one JSON object for a dry run', async () => {
        const fixture = buildFakeRepo({ hasEventsFile: true, hasReviewArtifact: true });
        const written: string[] = [];
        const originalWrite = process.stdout.write.bind(process.stdout);
        const originalLog = console.log;
        process.stdout.write = ((chunk: string | Uint8Array) => {
            written.push(String(chunk));
            return true;
        }) as typeof process.stdout.write;
        console.log = (...args: unknown[]) => { written.push(`${args.map(String).join(' ')}\n`); };
        try {
            await handleTaskReset(['--task-id', fixture.taskId, '--reopen', '--dry-run', '--as-json',
                '--events-root', fixture.eventsRoot, '--reviews-root', fixture.reviewsRoot, '--repo-root', fixture.repoRoot]);
        } finally {
            process.stdout.write = originalWrite;
            console.log = originalLog;
            cleanup(fixture.repoRoot);
        }
        const payload = JSON.parse(written.join('').trim()) as Record<string, unknown>;
        assert.equal(payload.outcome, 'DRY_RUN');
        assert.equal(payload.dryRun, true);
        assert.equal(payload.targetStatus, 'TODO');
        assert.equal(payload.exit_code, 0);
        assert.ok(Array.isArray(payload.outputLines));
    });
});
