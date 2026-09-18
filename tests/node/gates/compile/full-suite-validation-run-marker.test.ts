import { beforeEach, describe, it, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createDeadProcessInspectionFixture, isolateTestRunnerEnvironment } from '../../process-environment-fixtures';

beforeEach((context) => {
    const testContext = context as TestContext;
    testContext.after(isolateTestRunnerEnvironment());
    const mutableChildProcess = require('node:child_process') as typeof childProcess;
    const originalExecFileSync = mutableChildProcess.execFileSync;
    testContext.mock.method(mutableChildProcess, 'execFileSync', (...args: Parameters<typeof childProcess.execFileSync>) => {
        assert.notEqual(path.basename(String(args[0])), 'ps', 'Marker fixtures must not scan the host process table');
        assert.doesNotMatch(JSON.stringify(args.slice(0, 2)), /Get-CimInstance|Win32_Process/iu,
            'Marker fixtures must inject process snapshots instead of scanning the host');
        return originalExecFileSync(...args);
    });
});

import {
    parsePosixProcessRows,
    parseWindowsProcessRows,
    readInterruptedFullSuiteValidationRunMarker,
    readRecoverableFullSuiteValidationRunMarker,
    resolveFullSuiteValidationRunMarkerPath,
    withFullSuiteValidationRunMarkerMutationLockAsync
} from '../../../../src/gates/full-suite/full-suite-validation-run-marker';
import {
    runFullSuiteRunMarkerRecoveryCommand
} from '../../../../src/cli/commands/gate-flows/full-suite/full-suite-run-marker-recovery';
import { fileSha256, normalizePath } from '../../../../src/gates/shared/helpers';
import { resolveFullSuiteDurationHistoryPath } from '../../../../src/gates/full-suite/full-suite-validation';

function writeCurrentMarker(options: {
    repoRoot: string;
    taskId: string;
    preflightPath: string;
    preflightSha256: string;
    gatePid?: number;
    childPid?: number | null;
}): string {
    const markerPath = resolveFullSuiteValidationRunMarkerPath(options.repoRoot, options.taskId);
    fs.writeFileSync(markerPath, `${JSON.stringify({
        schema_version: 1,
        task_id: options.taskId,
        status: 'running',
        started_at_utc: '2026-06-07T01:01:00.000Z',
        updated_at_utc: '2026-06-07T01:01:00.000Z',
        repo_root: normalizePath(options.repoRoot),
        cwd: normalizePath(options.repoRoot),
        command: 'npm test',
        timeout_ms: 600000,
        gate_pid: options.gatePid ?? 999999,
        child_pid: options.childPid ?? null,
        child_command: options.childPid == null ? null : 'node.exe',
        child_args: [],
        child_shell: null,
        preflight_path: normalizePath(options.preflightPath),
        preflight_sha256: options.preflightSha256,
        cycle_binding: {
            task_id: options.taskId,
            preflight_path: normalizePath(options.preflightPath),
            preflight_sha256: options.preflightSha256,
            compile_gate_timestamp: null,
            scope_binding: null
        }
    }, null, 2)}\n`, 'utf8');
    return markerPath;
}

describe('full-suite validation run marker', () => {
    it('serializes stale mutation-lock recovery and preserves the observed lock', async () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-fsv-marker-lock-recovery-'));
        try {
            const taskId = 'T-MARKER-LOCK-RECOVERY';
            const markerPath = resolveFullSuiteValidationRunMarkerPath(repoRoot, taskId);
            const lockPath = `${markerPath}.mutation-lock`;
            const recoveryPath = `${lockPath}.stale-recovery`;
            fs.mkdirSync(path.dirname(lockPath), { recursive: true });
            const staleLock = `${JSON.stringify({
                schema_version: 1,
                task_id: taskId,
                owner_pid: 2147483647,
                acquired_at_utc: '2026-06-07T01:00:00.000Z'
            })}\n`;
            fs.writeFileSync(lockPath, staleLock, 'utf8');
            fs.writeFileSync(recoveryPath, JSON.stringify({
                schema_version: 1,
                task_id: taskId,
                owner_pid: process.pid
            }), 'utf8');

            await assert.rejects(
                () => withFullSuiteValidationRunMarkerMutationLockAsync(repoRoot, taskId, async () => undefined),
                /stale-lock recovery is already in progress or requires operator maintenance/u
            );
            assert.equal(fs.readFileSync(lockPath, 'utf8'), staleLock);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('removes a dead mutation lock under the stale-recovery guard before acquiring', async () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-fsv-marker-dead-lock-'));
        try {
            const taskId = 'T-MARKER-DEAD-LOCK';
            const markerPath = resolveFullSuiteValidationRunMarkerPath(repoRoot, taskId);
            const lockPath = `${markerPath}.mutation-lock`;
            const recoveryPath = `${lockPath}.stale-recovery`;
            fs.mkdirSync(path.dirname(lockPath), { recursive: true });
            fs.writeFileSync(lockPath, JSON.stringify({
                schema_version: 1,
                task_id: taskId,
                owner_pid: 2147483647
            }), 'utf8');

            let actionRan = false;
            await withFullSuiteValidationRunMarkerMutationLockAsync(repoRoot, taskId, async () => {
                actionRan = true;
            });

            assert.equal(actionRan, true);
            assert.equal(fs.existsSync(lockPath), false);
            assert.equal(fs.existsSync(recoveryPath), false);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('treats mismatched nested cycle identity as stale recovery evidence', async () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-fsv-marker-cycle-identity-'));
        try {
            const taskId = 'T-MARKER-CYCLE-IDENTITY';
            const reviewsRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews');
            fs.mkdirSync(reviewsRoot, { recursive: true });
            const preflightPath = path.join(reviewsRoot, `${taskId}-preflight.json`);
            fs.writeFileSync(preflightPath, JSON.stringify({ task_id: taskId }), 'utf8');
            const preflightSha256 = fileSha256(preflightPath) || '';
            const markerPath = writeCurrentMarker({
                repoRoot,
                taskId,
                preflightPath,
                preflightSha256,
                childPid: 999998
            });
            const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8')) as Record<string, unknown>;
            marker.cycle_binding = {
                task_id: 'T-OTHER-CYCLE',
                preflight_path: normalizePath(path.join(reviewsRoot, 'other-preflight.json')),
                preflight_sha256: '0'.repeat(64),
                compile_gate_timestamp: null,
                scope_binding: null
            };
            fs.writeFileSync(markerPath, `${JSON.stringify(marker, null, 2)}\n`, 'utf8');

            const inspection = readRecoverableFullSuiteValidationRunMarker(
                repoRoot,
                taskId,
                preflightPath,
                preflightSha256,
                null,
                createDeadProcessInspectionFixture()
            );
            assert.equal(inspection?.markerState, 'STALE');
            assert.match(String(inspection?.markerStateReason), /cycle_binding\.task_id mismatch/u);
            assert.match(String(inspection?.markerStateReason), /cycle_binding\.preflight_path mismatch/u);
            assert.match(String(inspection?.markerStateReason), /cycle_binding\.preflight_sha256 mismatch/u);

            const recovery = await runFullSuiteRunMarkerRecoveryCommand({
                repoRoot,
                taskId,
                preflightPath,
                clearDeadMarker: true,
                operatorConfirmed: 'yes',
                inspectionOptions: createDeadProcessInspectionFixture()
            });
            assert.ok(recovery.outputLines.some((line) => line.includes('Status: CLEARED_STALE_MARKER')));
            assert.equal(fs.existsSync(path.join(reviewsRoot, `${taskId}-full-suite-validation.json`)), false);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('rejects stale interrupted markers from a prior compile cycle with the same preflight', () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-fsv-marker-'));
        try {
            const taskId = 'T-MARKER';
            const reviewsRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews');
            fs.mkdirSync(reviewsRoot, { recursive: true });
            const preflightPath = path.join(reviewsRoot, `${taskId}-preflight.json`);
            fs.writeFileSync(preflightPath, JSON.stringify({ task_id: taskId }), 'utf8');
            const preflightSha256 = fileSha256(preflightPath);
            const markerPath = resolveFullSuiteValidationRunMarkerPath(repoRoot, taskId);
            const cycleBinding = {
                task_id: taskId,
                preflight_path: normalizePath(preflightPath),
                preflight_sha256: preflightSha256,
                compile_gate_timestamp: '2026-06-07T01:00:00.000Z',
                scope_binding: null
            };
            fs.writeFileSync(markerPath, `${JSON.stringify({
                schema_version: 1,
                task_id: taskId,
                status: 'running',
                started_at_utc: '2026-06-07T01:01:00.000Z',
                updated_at_utc: '2026-06-07T01:01:00.000Z',
                repo_root: normalizePath(repoRoot),
                cwd: normalizePath(repoRoot),
                command: 'npm test',
                timeout_ms: 600000,
                gate_pid: 999999,
                child_pid: 999998,
                child_command: 'node',
                child_args: [],
                child_shell: false,
                preflight_path: normalizePath(preflightPath),
                preflight_sha256: preflightSha256,
                cycle_binding: cycleBinding
            }, null, 2)}\n`, 'utf8');

            const stale = readInterruptedFullSuiteValidationRunMarker(
                repoRoot,
                taskId,
                preflightPath,
                preflightSha256,
                '2026-06-07T02:00:00.000Z',
                createDeadProcessInspectionFixture()
            );
            const current = readInterruptedFullSuiteValidationRunMarker(
                repoRoot,
                taskId,
                preflightPath,
                preflightSha256,
                '2026-06-07T01:00:00.000Z',
                createDeadProcessInspectionFixture()
            );
            const recoverable = readRecoverableFullSuiteValidationRunMarker(
                repoRoot,
                taskId,
                preflightPath,
                preflightSha256,
                '2026-06-07T02:00:00.000Z',
                createDeadProcessInspectionFixture()
            );

            assert.equal(stale, null);
            assert.equal(current?.command, 'npm test');
            assert.equal(recoverable?.markerState, 'STALE');
            assert.match(recoverable?.markerStateReason || '', /compile_gate_timestamp mismatch/u);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('parses Windows process snapshots for descendant detection', () => {
        const entries = parseWindowsProcessRows([
            { ProcessId: 1200, ParentProcessId: 1100, CommandLine: 'node.exe scripts/node-foundation/build-scripts.cjs' },
            { ProcessId: 1300, ParentProcessId: 1200, CommandLine: 'powershell.exe -NoProfile' },
            { ProcessId: 'bad', ParentProcessId: 1200, CommandLine: 'ignored.exe' }
        ]);

        assert.deepEqual(entries, [
            {
                pid: 1200,
                parentPid: 1100,
                commandLine: 'node.exe scripts/node-foundation/build-scripts.cjs'
            },
            {
                pid: 1300,
                parentPid: 1200,
                commandLine: 'powershell.exe -NoProfile'
            }
        ]);
    });

    it('parses POSIX process groups for reparented descendant detection', () => {
        assert.deepEqual(
            parsePosixProcessRows([
                '1200 1 1200 node scripts/node-foundation/build-scripts.cjs',
                '1300 1 1200 node orphaned-worker.js',
                'invalid row'
            ].join('\n')),
            [
                {
                    pid: 1200,
                    parentPid: 1,
                    processGroupId: 1200,
                    commandLine: 'node scripts/node-foundation/build-scripts.cjs'
                },
                {
                    pid: 1300,
                    parentPid: 1,
                    processGroupId: 1200,
                    commandLine: 'node orphaned-worker.js'
                }
            ]
        );
    });

    it('clears dead current-cycle markers only after preserving recovery evidence', async () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-fsv-marker-clear-'));
        try {
            const taskId = 'T-MARKER-CLEAR';
            const reviewsRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews');
            fs.mkdirSync(reviewsRoot, { recursive: true });
            const preflightPath = path.join(reviewsRoot, `${taskId}-preflight.json`);
            fs.writeFileSync(preflightPath, JSON.stringify({ task_id: taskId }), 'utf8');
            const preflightSha256 = fileSha256(preflightPath);
            const markerPath = resolveFullSuiteValidationRunMarkerPath(repoRoot, taskId);
            fs.writeFileSync(markerPath, `${JSON.stringify({
                schema_version: 1,
                task_id: taskId,
                status: 'running',
                started_at_utc: '2026-06-07T01:01:00.000Z',
                updated_at_utc: '2026-06-07T01:01:00.000Z',
                repo_root: normalizePath(repoRoot),
                cwd: normalizePath(repoRoot),
                command: 'npm test',
                timeout_ms: 600000,
                gate_pid: 999999,
                child_pid: 999998,
                child_command: 'node',
                child_args: [],
                child_shell: false,
                preflight_path: normalizePath(preflightPath),
                preflight_sha256: preflightSha256,
                cycle_binding: {
                    task_id: taskId,
                    preflight_path: normalizePath(preflightPath),
                    preflight_sha256: preflightSha256,
                    compile_gate_timestamp: null,
                    scope_binding: null
                }
            }, null, 2)}\n`, 'utf8');

            const result = await runFullSuiteRunMarkerRecoveryCommand({
                repoRoot,
                taskId,
                preflightPath,
                clearDeadMarker: true,
                operatorConfirmed: 'yes',
                inspectionOptions: createDeadProcessInspectionFixture()
            });

            assert.equal(result.exitCode, 0);
            assert.ok(result.outputLines.some((line) => line.includes('Status: CLEARED_DEAD_MARKER')));
            assert.equal(fs.existsSync(markerPath), false);
            const artifactPath = path.join(reviewsRoot, `${taskId}-full-suite-run-marker-recovery.json`);
            const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8')) as Record<string, unknown>;
            assert.equal(artifact.status, 'CLEARED_DEAD_MARKER');
            assert.equal(artifact.marker_path, normalizePath(markerPath));
            const fullSuiteArtifactPath = path.join(reviewsRoot, `${taskId}-full-suite-validation.json`);
            const fullSuiteArtifact = JSON.parse(fs.readFileSync(fullSuiteArtifactPath, 'utf8')) as Record<string, unknown>;
            assert.equal(fullSuiteArtifact.status, 'FAILED');
            assert.equal(fullSuiteArtifact.timed_out, true);
            const timeoutPolicy = fullSuiteArtifact.timeout_policy as Record<string, unknown>;
            assert.equal(timeoutPolicy.timeout_blocker, true);
            assert.equal(timeoutPolicy.timeout_retry_count, 1);
            assert.equal(timeoutPolicy.max_attempts, 2);
            assert.equal(timeoutPolicy.attempts_exhausted, false);
            assert.equal(timeoutPolicy.warning_only_continuation, false);
            assert.equal(timeoutPolicy.repair_task_proposal, null);
            assert.deepEqual((timeoutPolicy.attempts as Array<Record<string, unknown>>).map((entry) => ({
                attempt: entry.attempt,
                exit_code: entry.exit_code,
                timed_out: entry.timed_out,
                cancelled: entry.cancelled
            })), [{
                attempt: 1,
                exit_code: null,
                timed_out: true,
                cancelled: true
            }]);
            assert.equal(fullSuiteArtifact.output_retention && typeof fullSuiteArtifact.output_retention === 'object'
                ? (fullSuiteArtifact.output_retention as Record<string, unknown>).raw_output_retained
                : null, true);
            assert.equal(fullSuiteArtifact.failure_evidence && typeof fullSuiteArtifact.failure_evidence === 'object'
                ? (fullSuiteArtifact.failure_evidence as Record<string, unknown>).copied_logs_count
                : null, 0);
            const compactSummary = fullSuiteArtifact.compact_summary;
            assert.ok(Array.isArray(compactSummary));
            const compactSummaryText = compactSummary.join('\n');
            assert.match(compactSummaryText, /no eligible recent matching full-suite duration history/u);
            assert.match(compactSummaryText, /1 matching run\(s\) excluded from forecast \(timed_out=1\)/u);
            assert.match(compactSummaryText, new RegExp(`NextRecoveryCommand: .+next-step "${taskId}" --repo-root "\\."`, 'u'));
            assert.match(compactSummaryText, new RegExp(`CleanupCommand: .+gate full-suite-run-marker-recovery --task-id "${taskId}"`, 'u'));
            const outputLog = fs.readFileSync(path.join(reviewsRoot, `${taskId}-full-suite-output.log`), 'utf8');
            assert.match(outputLog, /FULL_SUITE_INTERRUPTED_TIMEOUT_RECOVERY/u);
            assert.match(outputLog, /no eligible recent matching full-suite duration history/u);
            assert.match(outputLog, /1 matching run\(s\) excluded from forecast \(timed_out=1\)/u);
            assert.match(outputLog, new RegExp(`CleanupCommand: .+gate full-suite-run-marker-recovery --task-id "${taskId}"`, 'u'));
            const timeline = fs.readFileSync(path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'task-events', `${taskId}.jsonl`), 'utf8');
            assert.match(timeline, /"event_type":"FULL_SUITE_VALIDATION_FAILED"/u);
            assert.match(timeline, /"timeout_policy":\{/u);
            const durationHistory = JSON.parse(fs.readFileSync(resolveFullSuiteDurationHistoryPath(repoRoot), 'utf8')) as {
                entries: Array<{
                    task_id: string;
                    status: string;
                    timed_out: boolean;
                    cancelled: boolean;
                    exit_code: number | null;
                    forecast_sample_eligible: boolean;
                    forecast_exclusion_reason: string;
                }>;
            };
            assert.deepEqual(durationHistory.entries.map((entry) => ({
                task_id: entry.task_id,
                status: entry.status,
                timed_out: entry.timed_out,
                cancelled: entry.cancelled,
                exit_code: entry.exit_code,
                forecast_sample_eligible: entry.forecast_sample_eligible,
                forecast_exclusion_reason: entry.forecast_exclusion_reason
            })), [{
                task_id: taskId,
                status: 'FAILED',
                timed_out: true,
                cancelled: true,
                exit_code: null,
                forecast_sample_eligible: false,
                forecast_exclusion_reason: 'timed_out'
            }]);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('uses the preflight scope hash for interrupted timeout blocker recovery', async () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-fsv-marker-blocker-scope-'));
        try {
            const taskId = 'T-MARKER-BLOCKER-SCOPE';
            const scopeSha256 = 'a'.repeat(64);
            childProcess.execFileSync('git', ['init', repoRoot], { stdio: 'ignore' });
            childProcess.execFileSync('git', ['-C', repoRoot, 'config', 'user.email', 'tests@example.com']);
            childProcess.execFileSync('git', ['-C', repoRoot, 'config', 'user.name', 'Garda Tests']);
            fs.writeFileSync(path.join(repoRoot, 'README.md'), '# Fixture\n', 'utf8');
            childProcess.execFileSync('git', ['-C', repoRoot, 'add', 'README.md']);
            childProcess.execFileSync('git', ['-C', repoRoot, 'commit', '-m', 'seed'], { stdio: 'ignore' });

            const reviewsRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews');
            fs.mkdirSync(reviewsRoot, { recursive: true });
            const configPath = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json');
            fs.mkdirSync(path.dirname(configPath), { recursive: true });
            fs.writeFileSync(configPath, JSON.stringify({
                full_suite_validation: {
                    enabled: true,
                    command: 'npm test',
                    timeout_ms: 600000,
                    timeout_retry_count: 0,
                    timeout_blocker: true
                }
            }), 'utf8');
            const preflightPath = path.join(reviewsRoot, `${taskId}-preflight.json`);
            fs.writeFileSync(preflightPath, JSON.stringify({
                task_id: taskId,
                metrics: {
                    changed_files_sha256: 'b'.repeat(64),
                    scope_sha256: scopeSha256,
                    scope_content_sha256: 'c'.repeat(64)
                }
            }), 'utf8');
            const preflightSha256 = fileSha256(preflightPath) || '';
            const markerPath = writeCurrentMarker({
                repoRoot,
                taskId,
                preflightPath,
                preflightSha256,
                childPid: 999998
            });

            const result = await runFullSuiteRunMarkerRecoveryCommand({
                repoRoot,
                taskId,
                preflightPath,
                clearDeadMarker: true,
                operatorConfirmed: 'yes',
                inspectionOptions: createDeadProcessInspectionFixture()
            });

            assert.equal(result.exitCode, 0);
            assert.equal(fs.existsSync(markerPath), false);
            const fullSuiteArtifact = JSON.parse(fs.readFileSync(
                path.join(reviewsRoot, `${taskId}-full-suite-validation.json`),
                'utf8'
            )) as Record<string, unknown>;
            const timeoutPolicy = fullSuiteArtifact.timeout_policy as Record<string, unknown>;
            const blockerIdentity = timeoutPolicy.blocker_identity as Record<string, unknown>;
            assert.equal(timeoutPolicy.attempts_exhausted, true);
            assert.equal(blockerIdentity.scope_sha256, scopeSha256);
            assert.notEqual(blockerIdentity.scope_sha256, preflightSha256);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('preserves existing current-cycle successful full-suite evidence when clearing a dead marker', async () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-fsv-marker-preserve-pass-'));
        try {
            const taskId = 'T-MARKER-PRESERVE-PASS';
            const reviewsRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews');
            fs.mkdirSync(reviewsRoot, { recursive: true });
            const configPath = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json');
            fs.mkdirSync(path.dirname(configPath), { recursive: true });
            fs.writeFileSync(configPath, JSON.stringify({
                full_suite_validation: {
                    enabled: true,
                    command: 'npm test',
                    timeout_ms: 600000
                }
            }), 'utf8');
            const preflightPath = path.join(reviewsRoot, `${taskId}-preflight.json`);
            fs.writeFileSync(preflightPath, JSON.stringify({ task_id: taskId }), 'utf8');
            const preflightSha256 = fileSha256(preflightPath) || '';
            const markerPath = writeCurrentMarker({
                repoRoot,
                taskId,
                preflightPath,
                preflightSha256,
                childPid: 999998
            });
            const fullSuiteArtifactPath = path.join(reviewsRoot, `${taskId}-full-suite-validation.json`);
            fs.writeFileSync(fullSuiteArtifactPath, `${JSON.stringify({
                status: 'PASSED',
                enabled: true,
                command: 'npm test',
                exit_code: 0,
                timed_out: false,
                output_artifact_path: null,
                compact_summary: ['preexisting pass evidence'],
                failure_chunks: [],
                out_of_scope_failure_policy: 'AUDIT_AND_BLOCK',
                out_of_scope_failure_detected: false,
                out_of_scope_audit_verdict: 'NOT_APPLICABLE',
                violations: [],
                warnings: [],
                cycle_binding: {
                    task_id: taskId,
                    preflight_path: normalizePath(preflightPath),
                    preflight_sha256: preflightSha256,
                    compile_gate_timestamp: null,
                    scope_binding: null
                }
            }, null, 2)}\n`, 'utf8');

            const result = await runFullSuiteRunMarkerRecoveryCommand({
                repoRoot,
                taskId,
                preflightPath,
                clearDeadMarker: true,
                operatorConfirmed: 'yes',
                inspectionOptions: createDeadProcessInspectionFixture()
            });

            assert.equal(result.exitCode, 0);
            assert.equal(fs.existsSync(markerPath), false);
            const fullSuiteArtifact = JSON.parse(fs.readFileSync(fullSuiteArtifactPath, 'utf8')) as Record<string, unknown>;
            assert.equal(fullSuiteArtifact.status, 'PASSED');
            assert.deepEqual(fullSuiteArtifact.compact_summary, ['preexisting pass evidence']);
            assert.equal(fs.existsSync(path.join(reviewsRoot, `${taskId}-full-suite-output.log`)), false);
            const recoveryArtifact = JSON.parse(fs.readFileSync(
                path.join(reviewsRoot, `${taskId}-full-suite-run-marker-recovery.json`),
                'utf8'
            )) as Record<string, unknown>;
            const terminalEvidence = recoveryArtifact.terminal_full_suite_evidence as Record<string, unknown>;
            assert.equal(terminalEvidence.status, 'PRESERVED_CURRENT_TERMINAL');
            assert.equal(terminalEvidence.full_suite_status, 'PASSED');
            const timelinePath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'task-events', `${taskId}.jsonl`);
            const timeline = fs.existsSync(timelinePath) ? fs.readFileSync(timelinePath, 'utf8') : '';
            assert.doesNotMatch(timeline, /"event_type":"FULL_SUITE_VALIDATION_FAILED"/u);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('does not claim cleared cleanup when terminal evidence materialization fails', async () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-fsv-marker-materialize-fail-'));
        try {
            const taskId = 'T-MARKER-MATERIALIZE-FAIL';
            const reviewsRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews');
            fs.mkdirSync(reviewsRoot, { recursive: true });
            const preflightPath = path.join(reviewsRoot, `${taskId}-preflight.json`);
            fs.writeFileSync(preflightPath, JSON.stringify({ task_id: taskId }), 'utf8');
            const preflightSha256 = fileSha256(preflightPath) || '';
            const markerPath = writeCurrentMarker({
                repoRoot,
                taskId,
                preflightPath,
                preflightSha256,
                childPid: 999998
            });
            const eventsRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'task-events');
            fs.mkdirSync(path.dirname(eventsRoot), { recursive: true });
            fs.writeFileSync(eventsRoot, 'not a directory', 'utf8');

            await assert.rejects(() => runFullSuiteRunMarkerRecoveryCommand({
                repoRoot,
                taskId,
                preflightPath,
                clearDeadMarker: true,
                operatorConfirmed: 'yes',
                inspectionOptions: createDeadProcessInspectionFixture()
            }));

            assert.equal(fs.existsSync(markerPath), true);
            const recoveryArtifact = JSON.parse(fs.readFileSync(
                path.join(reviewsRoot, `${taskId}-full-suite-run-marker-recovery.json`),
                'utf8'
            )) as Record<string, unknown>;
            assert.equal(recoveryArtifact.status, 'DEAD_MARKER');
            assert.equal(recoveryArtifact.terminal_full_suite_evidence, null);
            const fullSuiteArtifactPath = path.join(reviewsRoot, `${taskId}-full-suite-validation.json`);
            assert.equal(fs.existsSync(fullSuiteArtifactPath), false);
            assert.equal(fs.existsSync(resolveFullSuiteDurationHistoryPath(repoRoot)), false);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('prints a bundle-relative cleanup command outside source checkouts', async () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-fsv-marker-bundle-command-'));
        try {
            const taskId = 'T-MARKER-BUNDLE-COMMAND';
            const reviewsRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews');
            fs.mkdirSync(reviewsRoot, { recursive: true });
            const preflightPath = path.join(reviewsRoot, `${taskId}-preflight.json`);
            fs.writeFileSync(preflightPath, JSON.stringify({ task_id: taskId }), 'utf8');
            const preflightSha256 = fileSha256(preflightPath) || '';
            writeCurrentMarker({
                repoRoot,
                taskId,
                preflightPath,
                preflightSha256,
                childPid: 999998
            });

            const result = await runFullSuiteRunMarkerRecoveryCommand({
                repoRoot,
                taskId,
                preflightPath,
                inspectionOptions: createDeadProcessInspectionFixture()
            });

            assert.equal(result.exitCode, 0);
            assert.ok(result.outputLines.some((line) => line.includes('Status: DEAD_MARKER')));
            assert.ok(result.outputLines.some((line) => line.includes('CleanupCommand: node garda-agent-orchestrator/bin/garda.js gate full-suite-run-marker-recovery')));
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('rejects recovery artifact paths that alias the run marker path', async () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-fsv-marker-alias-'));
        try {
            const taskId = 'T-MARKER-ALIAS';
            const reviewsRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews');
            fs.mkdirSync(reviewsRoot, { recursive: true });
            const preflightPath = path.join(reviewsRoot, `${taskId}-preflight.json`);
            fs.writeFileSync(preflightPath, JSON.stringify({ task_id: taskId }), 'utf8');
            const preflightSha256 = fileSha256(preflightPath) || '';
            const markerPath = writeCurrentMarker({ repoRoot, taskId, preflightPath, preflightSha256 });

            await assert.rejects(
                () => runFullSuiteRunMarkerRecoveryCommand({
                    repoRoot,
                    taskId,
                    preflightPath,
                    artifactPath: markerPath,
                    clearDeadMarker: true,
                    operatorConfirmed: 'yes',
                    inspectionOptions: createDeadProcessInspectionFixture()
                }),
                /ArtifactPath must not equal the full-suite run marker path/u
            );
            assert.equal(fs.existsSync(markerPath), true);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('refuses to clear current-cycle markers with Windows descendant process evidence', async () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-fsv-marker-descendants-'));
        try {
            const taskId = 'T-MARKER-DESCENDANTS';
            const reviewsRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews');
            fs.mkdirSync(reviewsRoot, { recursive: true });
            const preflightPath = path.join(reviewsRoot, `${taskId}-preflight.json`);
            fs.writeFileSync(preflightPath, JSON.stringify({ task_id: taskId }), 'utf8');
            const preflightSha256 = fileSha256(preflightPath) || '';
            const markerPath = writeCurrentMarker({
                repoRoot,
                taskId,
                preflightPath,
                preflightSha256,
                childPid: 1200
            });
            const entries = parseWindowsProcessRows([
                { ProcessId: 1300, ParentProcessId: 1200, CommandLine: 'node.exe shard-one.js' },
                { ProcessId: 1400, ParentProcessId: 1300, CommandLine: 'powershell.exe nested.ps1' }
            ]);

            const result = await runFullSuiteRunMarkerRecoveryCommand({
                repoRoot,
                taskId,
                preflightPath,
                clearDeadMarker: true,
                operatorConfirmed: 'yes',
                inspectionOptions: {
                    isProcessAlive: () => false,
                    processTableSnapshot: { entries, warning: null }
                }
            });

            assert.notEqual(result.exitCode, 0);
            assert.ok(result.outputLines.some((line) => line.includes('Status: REFUSED_LIVE_CLEAR')));
            assert.ok(result.outputLines.some((line) => line.includes('DescendantCandidates: pid=1300,ppid=1200; pid=1400,ppid=1300')));
            assert.equal(fs.existsSync(markerPath), true);
            const artifactPath = path.join(reviewsRoot, `${taskId}-full-suite-run-marker-recovery.json`);
            const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8')) as Record<string, unknown>;
            assert.equal(artifact.status, 'REFUSED_LIVE_CLEAR');
            const summary = artifact.recovery_summary as { descendant_process_candidates: unknown[] };
            assert.equal(summary.descendant_process_candidates.length, 2);
            assert.equal(fs.existsSync(path.join(reviewsRoot, `${taskId}-full-suite-validation.json`)), false);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('refuses cleanup when process scanning warning makes descendant state unknown', async () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-fsv-marker-scan-warning-'));
        try {
            const taskId = 'T-MARKER-SCAN-WARNING';
            const reviewsRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews');
            fs.mkdirSync(reviewsRoot, { recursive: true });
            const preflightPath = path.join(reviewsRoot, `${taskId}-preflight.json`);
            fs.writeFileSync(preflightPath, JSON.stringify({ task_id: taskId }), 'utf8');
            const preflightSha256 = fileSha256(preflightPath) || '';
            const markerPath = writeCurrentMarker({
                repoRoot,
                taskId,
                preflightPath,
                preflightSha256,
                childPid: 1200
            });

            const result = await runFullSuiteRunMarkerRecoveryCommand({
                repoRoot,
                taskId,
                preflightPath,
                clearDeadMarker: true,
                operatorConfirmed: 'yes',
                inspectionOptions: {
                    isProcessAlive: () => false,
                    processTableSnapshot: {
                        entries: [],
                        warning: 'Unable to scan live process descendants: powershell failed'
                    }
                }
            });

            assert.notEqual(result.exitCode, 0);
            assert.ok(result.outputLines.some((line) => line.includes('Status: REFUSED_LIVE_CLEAR')));
            assert.ok(result.outputLines.some((line) => line.includes('ProcessScanWarning: Unable to scan live process descendants: powershell failed')));
            assert.equal(fs.existsSync(markerPath), true);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });
});

it('blocks cleanup for a reparented POSIX process-group member', async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-fsv-marker-process-group-'));
    try {
        const taskId = 'T-MARKER-PROCESS-GROUP';
        const reviewsRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews');
        fs.mkdirSync(reviewsRoot, { recursive: true });
        const preflightPath = path.join(reviewsRoot, `${taskId}-preflight.json`);
        fs.writeFileSync(preflightPath, JSON.stringify({ task_id: taskId }), 'utf8');
        const preflightSha256 = fileSha256(preflightPath) || '';
        const markerPath = writeCurrentMarker({
            repoRoot,
            taskId,
            preflightPath,
            preflightSha256,
            childPid: 1200
        });

        const result = await runFullSuiteRunMarkerRecoveryCommand({
            repoRoot,
            taskId,
            preflightPath,
            clearDeadMarker: true,
            operatorConfirmed: 'yes',
            inspectionOptions: {
                isProcessAlive: () => false,
                processTableSnapshot: {
                    entries: [{
                        pid: 1300,
                        parentPid: 1,
                        processGroupId: 1200,
                        commandLine: 'node orphaned-worker.js'
                    }],
                    warning: null
                }
            }
        });

        assert.notEqual(result.exitCode, 0);
        assert.ok(result.outputLines.some((line) => line.includes('Status: REFUSED_LIVE_CLEAR')));
        assert.ok(result.outputLines.some((line) => line.includes('DescendantCandidates: pid=1300,ppid=1,pgid=1200')));
        assert.equal(fs.existsSync(markerPath), true);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

it('blocks cleanup when no child pid was recorded before the gate exited', async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-fsv-marker-child-unrecorded-'));
    try {
        const taskId = 'T-MARKER-CHILD-UNRECORDED';
        const reviewsRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews');
        fs.mkdirSync(reviewsRoot, { recursive: true });
        const preflightPath = path.join(reviewsRoot, `${taskId}-preflight.json`);
        fs.writeFileSync(preflightPath, JSON.stringify({ task_id: taskId }), 'utf8');
        const markerPath = writeCurrentMarker({
            repoRoot,
            taskId,
            preflightPath,
            preflightSha256: fileSha256(preflightPath) || ''
        });

        const result = await runFullSuiteRunMarkerRecoveryCommand({
            repoRoot,
            taskId,
            preflightPath,
            clearDeadMarker: true,
            operatorConfirmed: 'yes',
            inspectionOptions: createDeadProcessInspectionFixture()
        });

        assert.notEqual(result.exitCode, 0);
        assert.ok(result.outputLines.some((line) => line.includes('Status: REFUSED_LIVE_CLEAR')));
        assert.ok(result.outputLines.some((line) => line.includes('ChildPid: none alive=unknown')));
        assert.equal(fs.existsSync(markerPath), true);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

it('blocks cleanup when owner process liveness is unverifiable', async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-fsv-marker-process-unknown-'));
    try {
        const taskId = 'T-MARKER-PROCESS-UNKNOWN';
        const reviewsRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews');
        fs.mkdirSync(reviewsRoot, { recursive: true });
        const preflightPath = path.join(reviewsRoot, `${taskId}-preflight.json`);
        fs.writeFileSync(preflightPath, JSON.stringify({ task_id: taskId }), 'utf8');
        const markerPath = writeCurrentMarker({
            repoRoot,
            taskId,
            preflightPath,
            preflightSha256: fileSha256(preflightPath) || ''
        });

        const result = await runFullSuiteRunMarkerRecoveryCommand({
            repoRoot,
            taskId,
            preflightPath,
            clearDeadMarker: true,
            operatorConfirmed: 'yes',
            inspectionOptions: {
                isProcessAlive: () => null,
                processTableSnapshot: { entries: [], warning: null }
            }
        });

        assert.notEqual(result.exitCode, 0);
        assert.ok(result.outputLines.some((line) => line.includes('Status: UNVERIFIABLE_PROCESS_STATE')));
        assert.ok(result.outputLines.some((line) => line.includes('ProcessCheckWarning: Unable to verify')));
        assert.equal(fs.existsSync(markerPath), true);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

it('blocks cleanup when a live marker replaces the inspected stale marker', async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-fsv-marker-replaced-'));
    try {
        const taskId = 'T-MARKER-REPLACED';
        const reviewsRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews');
        fs.mkdirSync(reviewsRoot, { recursive: true });
        const preflightPath = path.join(reviewsRoot, `${taskId}-preflight.json`);
        fs.writeFileSync(preflightPath, JSON.stringify({ task_id: taskId }), 'utf8');
        const preflightSha256 = fileSha256(preflightPath) || '';
        const markerPath = writeCurrentMarker({
            repoRoot,
            taskId,
            preflightPath,
            preflightSha256: '0'.repeat(64),
            childPid: 999998
        });

        await assert.rejects(
            () => runFullSuiteRunMarkerRecoveryCommand({
                repoRoot,
                taskId,
                preflightPath,
                clearDeadMarker: true,
                operatorConfirmed: 'yes',
                inspectionOptions: createDeadProcessInspectionFixture(),
                beforeCleanupLock: () => {
                    writeCurrentMarker({
                        repoRoot,
                        taskId,
                        preflightPath,
                        preflightSha256,
                        gatePid: process.pid
                    });
                }
            }),
            /marker changed after recovery inspection/u
        );

        const preservedMarker = JSON.parse(fs.readFileSync(markerPath, 'utf8')) as Record<string, unknown>;
        assert.equal(preservedMarker.gate_pid, process.pid);
        const recoveryArtifact = JSON.parse(fs.readFileSync(
            path.join(reviewsRoot, `${taskId}-full-suite-run-marker-recovery.json`),
            'utf8'
        )) as Record<string, unknown>;
        assert.equal(recoveryArtifact.status, 'STALE_MARKER');
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

it('clears a dead stale marker with exact binding evidence and is idempotent', async () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-fsv-marker-unknown-'));
        try {
            const taskId = 'T-MARKER-UNKNOWN';
            const secretMarkerTaskId = 'api_key=marker-secret-value';
            const reviewsRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews');
            fs.mkdirSync(reviewsRoot, { recursive: true });
            const preflightPath = path.join(reviewsRoot, `${taskId}-preflight.json`);
            fs.writeFileSync(preflightPath, JSON.stringify({ task_id: taskId }), 'utf8');
            const markerPath = resolveFullSuiteValidationRunMarkerPath(repoRoot, taskId);
            fs.writeFileSync(markerPath, `${JSON.stringify({
                schema_version: 1,
                task_id: secretMarkerTaskId,
                status: 'running',
                started_at_utc: '2026-06-07T01:01:00.000Z',
                updated_at_utc: '2026-06-07T01:01:00.000Z',
                repo_root: normalizePath(repoRoot),
                cwd: normalizePath(repoRoot),
                command: 'npm test',
                timeout_ms: 600000,
                gate_pid: 999999,
                child_pid: 999998,
                child_command: 'node',
                child_args: [],
                child_shell: false,
                preflight_path: normalizePath(preflightPath),
                preflight_sha256: '0'.repeat(64),
                cycle_binding: {
                    task_id: taskId,
                    preflight_path: normalizePath(preflightPath),
                    preflight_sha256: '0'.repeat(64),
                    compile_gate_timestamp: null,
                    scope_binding: null
                }
            }, null, 2)}\n`, 'utf8');

            const result = await runFullSuiteRunMarkerRecoveryCommand({
                repoRoot,
                taskId,
                preflightPath,
                clearDeadMarker: true,
                operatorConfirmed: 'yes',
                inspectionOptions: createDeadProcessInspectionFixture()
            });

            assert.equal(result.exitCode, 0);
            assert.ok(result.outputLines.some((line) => line.includes('Status: CLEARED_STALE_MARKER')));
            assert.ok(result.outputLines.some((line) => line.includes('preflight_sha256 mismatch')));
            assert.ok(result.outputLines.some((line) => line.includes('api_key=<redacted>')));
            assert.ok(result.outputLines.every((line) => !line.includes(secretMarkerTaskId)));
            assert.equal(fs.existsSync(markerPath), false);
            assert.equal(fs.existsSync(path.join(reviewsRoot, `${taskId}-full-suite-validation.json`)), false);
            const artifact = JSON.parse(fs.readFileSync(
                path.join(reviewsRoot, `${taskId}-full-suite-run-marker-recovery.json`),
                'utf8'
            )) as Record<string, unknown>;
            assert.equal(artifact.status, 'CLEARED_STALE_MARKER');
            assert.equal(artifact.marker_state, 'STALE');
            assert.match(String(artifact.marker_state_reason), /preflight_sha256 mismatch/u);
            assert.match(String(artifact.marker_state_reason), /api_key=<redacted>/u);
            assert.doesNotMatch(JSON.stringify(artifact), new RegExp(secretMarkerTaskId, 'u'));

            const repeated = await runFullSuiteRunMarkerRecoveryCommand({
                repoRoot,
                taskId,
                preflightPath,
                clearDeadMarker: true,
                operatorConfirmed: 'yes',
                inspectionOptions: createDeadProcessInspectionFixture()
            });
            assert.equal(repeated.exitCode, 0);
            assert.ok(repeated.outputLines.some((line) => line.includes('Status: MISSING')));
            assert.ok(repeated.outputLines.some((line) => line.includes('prior CLEARED_STALE_MARKER audit evidence remains preserved')));
            const preservedArtifact = JSON.parse(fs.readFileSync(
                path.join(reviewsRoot, `${taskId}-full-suite-run-marker-recovery.json`),
                'utf8'
            )) as Record<string, unknown>;
            assert.equal(preservedArtifact.status, 'CLEARED_STALE_MARKER');
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
});

it('finalizes prepared cleanup evidence after the final artifact write is interrupted', async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-fsv-marker-final-write-'));
    try {
        const taskId = 'T-MARKER-FINAL-WRITE';
        const reviewsRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews');
        fs.mkdirSync(reviewsRoot, { recursive: true });
        const preflightPath = path.join(reviewsRoot, `${taskId}-preflight.json`);
        fs.writeFileSync(preflightPath, JSON.stringify({ task_id: taskId }), 'utf8');
        const markerPath = writeCurrentMarker({
            repoRoot,
            taskId,
            preflightPath,
            preflightSha256: '0'.repeat(64),
            childPid: 999998
        });
        const artifactPath = path.join(reviewsRoot, `${taskId}-full-suite-run-marker-recovery.json`);

        await assert.rejects(
            () => runFullSuiteRunMarkerRecoveryCommand({
                repoRoot,
                taskId,
                preflightPath,
                clearDeadMarker: true,
                operatorConfirmed: 'yes',
                inspectionOptions: createDeadProcessInspectionFixture(),
                beforeFinalArtifactWrite: () => {
                    throw new Error('simulated final artifact write interruption');
                }
            }),
            /simulated final artifact write interruption/u
        );

        assert.equal(fs.existsSync(markerPath), false);
        const preparedArtifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8')) as Record<string, unknown>;
        assert.equal(preparedArtifact.status, 'STALE_MARKER');
        assert.equal(preparedArtifact.cleanup_phase, 'PREPARED');
        assert.equal(preparedArtifact.cleanup_target_status, 'CLEARED_STALE_MARKER');

        const repeated = await runFullSuiteRunMarkerRecoveryCommand({
            repoRoot,
            taskId,
            preflightPath,
            clearDeadMarker: true,
            operatorConfirmed: 'yes',
            inspectionOptions: createDeadProcessInspectionFixture()
        });
        assert.equal(repeated.exitCode, 0);
        assert.ok(repeated.outputLines.some((line) => line.includes('Status: MISSING')));
        assert.ok(repeated.outputLines.some((line) => (
            line.includes('prior CLEARED_STALE_MARKER audit evidence remains preserved')
        )));

        const finalizedArtifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8')) as Record<string, unknown>;
        assert.equal(finalizedArtifact.status, 'CLEARED_STALE_MARKER');
        assert.equal(finalizedArtifact.cleanup_phase, 'CLEARED');
        assert.equal(finalizedArtifact.recovered_from_prepared_cleanup, true);
        assert.ok(finalizedArtifact.recovery_summary);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

it('reports invalid marker state without clearing unverifiable ownership', async () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-fsv-marker-invalid-'));
        try {
            const taskId = 'T-MARKER-INVALID';
            const reviewsRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews');
            fs.mkdirSync(reviewsRoot, { recursive: true });
            const preflightPath = path.join(reviewsRoot, `${taskId}-preflight.json`);
            fs.writeFileSync(preflightPath, JSON.stringify({ task_id: taskId }), 'utf8');
            const markerPath = resolveFullSuiteValidationRunMarkerPath(repoRoot, taskId);
            fs.writeFileSync(markerPath, '{not-json', 'utf8');

            const result = await runFullSuiteRunMarkerRecoveryCommand({
                repoRoot,
                taskId,
                preflightPath,
                clearDeadMarker: true,
                operatorConfirmed: 'yes',
                inspectionOptions: createDeadProcessInspectionFixture()
            });

            assert.notEqual(result.exitCode, 0);
            assert.ok(result.outputLines.some((line) => line.includes('Status: UNKNOWN_STATE')));
            assert.ok(result.outputLines.some((line) => line.includes('MarkerStateReason: The full-suite run marker is not valid JSON')));
            assert.ok(result.outputLines.some((line) => line.includes('owner process state is not verifiable')));
            assert.equal(fs.existsSync(markerPath), true);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
});
