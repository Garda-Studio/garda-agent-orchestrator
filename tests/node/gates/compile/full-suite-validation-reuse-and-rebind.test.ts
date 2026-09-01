import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

import { EXIT_GATE_FAILURE } from '../../../../src/cli/exit-codes';
import {
    persistFullSuiteFailureEvidence,
    type FullSuiteValidationResult
} from '../../../../src/gates/full-suite/full-suite-validation';
import { getCurrentWorkflowConfigFileHashes } from '../../../../src/gates/workflow-config/workflow-config-work';
import { buildTaskModeArtifact } from '../../../../src/gates/task-mode';
import { buildEventIntegrityHash } from '../../../../src/gate-runtime/task-events';
import { runCliWithCapturedOutput } from '../../cli/commands/gate-test-helpers';
import { getWorkspaceSnapshot } from '../next-step/next-step-test-support';

function writeFullSuitePreflight(
    repoRoot: string,
    preflightPath: string,
    preflight: Record<string, unknown>
): void {
    const taskId = String(preflight.task_id || '').trim();
    const declaredChangedFiles = Array.isArray(preflight.changed_files)
        ? preflight.changed_files.map((entry) => String(entry || '').trim()).filter(Boolean)
        : [];
    for (const relativePath of declaredChangedFiles) {
        const absolutePath = path.resolve(repoRoot, relativePath);
        const relativeToRoot = path.relative(repoRoot, absolutePath);
        assert.ok(
            relativeToRoot && !relativeToRoot.startsWith('..') && !path.isAbsolute(relativeToRoot),
            `Full-suite fixture path must stay inside the temp repo: ${relativePath}`
        );
        if (!fs.existsSync(absolutePath)) {
            fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
            fs.writeFileSync(absolutePath, `export const fixture = ${JSON.stringify(taskId)};\n`, 'utf8');
        }
    }
    const snapshot = getWorkspaceSnapshot(
        repoRoot,
        'explicit_changed_files',
        true,
        declaredChangedFiles
    );
    const materializedPreflight = {
        ...preflight,
        detection_source: snapshot.detection_source,
        include_untracked: snapshot.include_untracked,
        changed_files: snapshot.changed_files,
        metrics: {
            changed_lines_total: snapshot.changed_lines_total,
            changed_files_sha256: snapshot.changed_files_sha256,
            scope_content_sha256: snapshot.scope_content_sha256,
            scope_sha256: snapshot.scope_sha256
        }
    };
    fs.writeFileSync(preflightPath, JSON.stringify(materializedPreflight), 'utf8');
    if (taskId) {
        writeFullSuiteTaskModeBaseline(repoRoot, taskId);
        const preflightSha256 = createHash('sha256').update(fs.readFileSync(preflightPath, 'utf8')).digest('hex');
        const compileTimestamp = new Date().toISOString();
        const reviewsDir = path.dirname(preflightPath);
        const eventsDir = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'task-events');
        fs.mkdirSync(eventsDir, { recursive: true });
        fs.writeFileSync(
            path.join(reviewsDir, `${taskId}-compile-gate.json`),
            JSON.stringify({
                task_id: taskId,
                event_source: 'compile-gate',
                status: 'PASSED',
                outcome: 'PASS',
                timestamp_utc: compileTimestamp,
                preflight_path: preflightPath.replace(/\\/g, '/'),
                preflight_hash_sha256: preflightSha256,
                scope_detection_source: snapshot.detection_source,
                scope_include_untracked: snapshot.include_untracked,
                scope_changed_files: snapshot.changed_files,
                scope_changed_lines_total: snapshot.changed_lines_total,
                scope_changed_files_sha256: snapshot.changed_files_sha256,
                scope_content_sha256: snapshot.scope_content_sha256,
                scope_sha256: snapshot.scope_sha256,
                scope_git_change_classification: snapshot.git_change_classification
            }, null, 2),
            'utf8'
        );
        writeAuthenticatedTimeline(repoRoot, taskId, [{
            event_type: 'COMPILE_GATE_PASSED',
            outcome: 'PASS',
            actor: 'gate',
            message: 'Compile gate fixture passed.',
            timestamp_utc: compileTimestamp,
            details: {
                preflight_path: preflightPath.replace(/\\/g, '/'),
                preflight_hash_sha256: preflightSha256,
                preflight_changed_files_sha256: snapshot.changed_files_sha256,
                preflight_scope_sha256: snapshot.scope_sha256,
                preflight_scope_content_sha256: snapshot.scope_content_sha256
            }
        }]);
    }
}

function writeAuthenticatedTimeline(
    repoRoot: string,
    taskId: string,
    events: Array<Record<string, unknown>>
): void {
    let previousEventSha256: string | null = null;
    const lines = events.map((sourceEvent, index) => {
        const event: Record<string, unknown> = {
            ...sourceEvent,
            task_id: taskId,
            integrity: {
                schema_version: 2,
                task_sequence: index + 1,
                prev_event_sha256: previousEventSha256
            }
        };
        const integrity = event.integrity as Record<string, unknown>;
        const eventSha256 = buildEventIntegrityHash(event);
        assert.match(String(eventSha256 || ''), /^[a-f0-9]{64}$/u);
        integrity.event_sha256 = eventSha256;
        previousEventSha256 = eventSha256;
        return JSON.stringify(event);
    });
    const timelinePath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'task-events', `${taskId}.jsonl`);
    fs.mkdirSync(path.dirname(timelinePath), { recursive: true });
    fs.writeFileSync(timelinePath, `${lines.join('\n')}\n`, 'utf8');
}

function writeFullSuiteTaskModeBaseline(repoRoot: string, taskId: string): void {
    const reviewsDir = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews');
    fs.mkdirSync(reviewsDir, { recursive: true });
    fs.writeFileSync(
        path.join(reviewsDir, `${taskId}-task-mode.json`),
        `${JSON.stringify(buildTaskModeArtifact({
            taskId,
            entryMode: 'EXPLICIT_TASK_EXECUTION',
            requestedDepth: 2,
            effectiveDepth: 2,
            taskSummary: `Full-suite validation fixture for ${taskId}`,
            startBanner: 'Garda captures my mind',
            provider: 'Codex',
            canonicalSourceOfTruth: 'Codex',
            executionProviderSource: 'explicit_provider',
            runtimeIdentityStatus: 'resolved',
            workflowConfigFileHashes: getCurrentWorkflowConfigFileHashes(repoRoot)
        }), null, 2)}\n`,
        'utf8'
    );
}

describe('gates/full-suite-validation', () => {
    describe('CLI integration reuse and rebind', () => {
        it('rebinds same-scope passed evidence to the current compile cycle without rerunning the command', async () => {
            const repoRoot = path.resolve(process.cwd());
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-fsv-cli-rebind-current-'));
            const configDir = path.join(tempDir, 'garda-agent-orchestrator', 'live', 'config');
            const reviewsDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'reviews');
            const eventsDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'task-events');
            fs.mkdirSync(configDir, { recursive: true });
            fs.mkdirSync(reviewsDir, { recursive: true });
            fs.mkdirSync(eventsDir, { recursive: true });

            const executedMarker = path.join(tempDir, 'command-executed.txt');
            const helperScript = path.join(tempDir, 'pass-rebind-current.js');
            fs.writeFileSync(
                helperScript,
                `require('node:fs').writeFileSync(${JSON.stringify(executedMarker)}, 'executed\\n', 'utf8'); process.stdout.write("should not run\\n"); process.exit(0);`,
                'utf8'
            );
            fs.writeFileSync(path.join(configDir, 'workflow-config.json'), JSON.stringify({
                full_suite_validation: {
                    enabled: true,
                    command: `"${process.execPath.replace(/\\/g, '/')}" "${helperScript.replace(/\\/g, '/')}"`,
                    timeout_ms: 30000,
                    green_summary_max_lines: 5,
                    red_failure_chunk_lines: 50,
                    out_of_scope_failure_policy: 'AUDIT_AND_BLOCK'
                }
            }), 'utf8');

            const taskId = 'T-REBIND-CURRENT';
            const preflightPath = path.join(reviewsDir, `${taskId}-preflight.json`);
            writeFullSuitePreflight(tempDir, preflightPath, {
                task_id: taskId,
                changed_files: ['src/changed.ts']
            });
            const preflightSha256 = createHash('sha256').update(fs.readFileSync(preflightPath, 'utf8')).digest('hex');
            const currentCompileTimestamp = '2026-01-01T00:00:02.000Z';
            const compileArtifactPath = path.join(reviewsDir, `${taskId}-compile-gate.json`);
            const compileArtifact = JSON.parse(fs.readFileSync(compileArtifactPath, 'utf8')) as Record<string, unknown>;
            const changedFilesSha = String(compileArtifact.scope_changed_files_sha256);
            const scopeSha = String(compileArtifact.scope_sha256);
            const scopeContentSha = String(compileArtifact.scope_content_sha256);
            fs.writeFileSync(compileArtifactPath, JSON.stringify({
                ...compileArtifact,
                timestamp_utc: currentCompileTimestamp
            }, null, 2), 'utf8');
            writeAuthenticatedTimeline(tempDir, taskId, [
                {
                    event_type: 'FULL_SUITE_VALIDATION_PASSED',
                    timestamp_utc: '2026-01-01T00:00:01.000Z',
                    outcome: 'PASS',
                    details: {
                        cycle_binding: {
                            task_id: taskId,
                            preflight_path: preflightPath.replace(/\\/g, '/'),
                            preflight_sha256: 'old-cycle',
                            compile_gate_timestamp: '2026-01-01T00:00:00.000Z',
                            scope_binding: {
                                changed_files_sha256: changedFilesSha,
                                scope_sha256: scopeSha,
                                scope_content_sha256: scopeContentSha
                            }
                        }
                    }
                },
                {
                    event_type: 'COMPILE_GATE_PASSED',
                    timestamp_utc: currentCompileTimestamp,
                    outcome: 'PASS',
                    details: {
                        preflight_path: preflightPath.replace(/\\/g, '/'),
                        preflight_hash_sha256: preflightSha256,
                        preflight_changed_files_sha256: changedFilesSha,
                        preflight_scope_sha256: scopeSha,
                        preflight_scope_content_sha256: scopeContentSha
                    }
                }
            ]);
            const outputArtifactPath = path.join(reviewsDir, `${taskId}-full-suite-output.log`);
            fs.writeFileSync(outputArtifactPath, 'cached pass output\n', 'utf8');
            fs.writeFileSync(path.join(reviewsDir, `${taskId}-full-suite-validation.json`), JSON.stringify({
                status: 'PASSED',
                enabled: true,
                command: `"${process.execPath.replace(/\\/g, '/')}" "${helperScript.replace(/\\/g, '/')}"`,
                placement: 'after_compile_before_reviews',
                exit_code: 0,
                timed_out: false,
                output_artifact_path: outputArtifactPath,
                compact_summary: ['cached pass output'],
                failure_chunks: [],
                out_of_scope_failure_policy: 'AUDIT_AND_BLOCK',
                out_of_scope_failure_detected: false,
                out_of_scope_audit_verdict: 'NOT_APPLICABLE',
                violations: [],
                warnings: [],
                cycle_binding: {
                    task_id: taskId,
                    preflight_path: preflightPath.replace(/\\/g, '/'),
                    preflight_sha256: 'old-cycle',
                    compile_gate_timestamp: '2026-01-01T00:00:00.000Z',
                    scope_binding: {
                        changed_files_sha256: changedFilesSha,
                        scope_sha256: scopeSha,
                        scope_content_sha256: scopeContentSha
                    }
                }
            }, null, 2), 'utf8');

            const result = await runCliWithCapturedOutput([
                'gate', 'full-suite-validation',
                '--task-id', taskId,
                '--preflight-path', preflightPath,
                '--repo-root', tempDir
            ], { cwd: repoRoot });

            assert.equal(result.exitCode, 0, `stdout=${result.logs.join('\n')}\nstderr=${result.errors.join('\n')}`);
            assert.equal(fs.existsSync(executedMarker), false);
            assert.ok(result.logs.some((line) => line.includes('Rebound existing full-suite evidence')));
            const artifact = JSON.parse(fs.readFileSync(path.join(reviewsDir, `${taskId}-full-suite-validation.json`), 'utf8'));
            assert.equal(artifact.cycle_binding.preflight_sha256, preflightSha256);
            assert.equal(artifact.cycle_binding.compile_gate_timestamp, currentCompileTimestamp);
            const timelineLines = fs.readFileSync(path.join(eventsDir, `${taskId}.jsonl`), 'utf8')
                .split('\n')
                .filter((line) => line.trim())
                .map((line) => JSON.parse(line) as Record<string, unknown>);
            const latestEvent = timelineLines[timelineLines.length - 1];
            assert.equal(latestEvent.event_type, 'FULL_SUITE_VALIDATION_PASSED');
            assert.equal(((latestEvent.details as Record<string, unknown>).reused_existing_evidence), true);
            assert.equal((((latestEvent.details as Record<string, unknown>).cycle_binding as Record<string, unknown>).compile_gate_timestamp), currentCompileTimestamp);
            fs.rmSync(tempDir, { recursive: true, force: true });
        });

        it('retains raw output when rebinding PASSED evidence that carries warnings', async () => {
            const repoRoot = path.resolve(process.cwd());
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-fsv-cli-rebind-warning-pass-'));
            const configDir = path.join(tempDir, 'garda-agent-orchestrator', 'live', 'config');
            const reviewsDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'reviews');
            const eventsDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'task-events');
            fs.mkdirSync(configDir, { recursive: true });
            fs.mkdirSync(reviewsDir, { recursive: true });
            fs.mkdirSync(eventsDir, { recursive: true });

            const executedMarker = path.join(tempDir, 'command-executed.txt');
            const helperScript = path.join(tempDir, 'pass-rebind-warning-pass.js');
            fs.writeFileSync(
                helperScript,
                `require('node:fs').writeFileSync(${JSON.stringify(executedMarker)}, 'executed\\n', 'utf8'); process.stdout.write("should not run\\n"); process.exit(0);`,
                'utf8'
            );
            fs.writeFileSync(path.join(configDir, 'workflow-config.json'), JSON.stringify({
                full_suite_validation: {
                    enabled: true,
                    command: `"${process.execPath.replace(/\\/g, '/')}" "${helperScript.replace(/\\/g, '/')}"`,
                    timeout_ms: 30000,
                    green_summary_max_lines: 5,
                    red_failure_chunk_lines: 50,
                    out_of_scope_failure_policy: 'AUDIT_AND_BLOCK'
                }
            }), 'utf8');

            const taskId = 'T-REBIND-WARNING-PASS';
            const preflightPath = path.join(reviewsDir, `${taskId}-preflight.json`);
            writeFullSuitePreflight(tempDir, preflightPath, {
                task_id: taskId,
                changed_files: ['src/changed.ts']
            });
            const preflightSha256 = createHash('sha256').update(fs.readFileSync(preflightPath, 'utf8')).digest('hex');
            const currentCompileTimestamp = '2026-01-01T00:00:02.000Z';
            const compileArtifactPath = path.join(reviewsDir, `${taskId}-compile-gate.json`);
            const compileArtifact = JSON.parse(fs.readFileSync(compileArtifactPath, 'utf8')) as Record<string, unknown>;
            const changedFilesSha = String(compileArtifact.scope_changed_files_sha256);
            const scopeSha = String(compileArtifact.scope_sha256);
            const scopeContentSha = String(compileArtifact.scope_content_sha256);
            fs.writeFileSync(compileArtifactPath, JSON.stringify({
                ...compileArtifact,
                timestamp_utc: currentCompileTimestamp
            }, null, 2), 'utf8');
            writeAuthenticatedTimeline(tempDir, taskId, [
                {
                    event_type: 'FULL_SUITE_VALIDATION_PASSED',
                    timestamp_utc: '2026-01-01T00:00:01.000Z',
                    outcome: 'PASS',
                    details: {
                        cycle_binding: {
                            task_id: taskId,
                            preflight_path: preflightPath.replace(/\\/g, '/'),
                            preflight_sha256: 'old-cycle',
                            compile_gate_timestamp: '2026-01-01T00:00:00.000Z',
                            scope_binding: {
                                changed_files_sha256: changedFilesSha,
                                scope_sha256: scopeSha,
                                scope_content_sha256: scopeContentSha
                            }
                        }
                    }
                },
                {
                    event_type: 'COMPILE_GATE_PASSED',
                    timestamp_utc: currentCompileTimestamp,
                    outcome: 'PASS',
                    details: {
                        preflight_path: preflightPath.replace(/\\/g, '/'),
                        preflight_hash_sha256: preflightSha256,
                        preflight_changed_files_sha256: changedFilesSha,
                        preflight_scope_sha256: scopeSha,
                        preflight_scope_content_sha256: scopeContentSha
                    }
                }
            ]);
            const outputArtifactPath = path.join(reviewsDir, `${taskId}-full-suite-output.log`);
            fs.writeFileSync(outputArtifactPath, 'cached pass output with warning\n', 'utf8');
            fs.writeFileSync(path.join(reviewsDir, `${taskId}-full-suite-validation.json`), JSON.stringify({
                status: 'PASSED',
                enabled: true,
                command: `"${process.execPath.replace(/\\/g, '/')}" "${helperScript.replace(/\\/g, '/')}"`,
                placement: 'after_compile_before_reviews',
                exit_code: 0,
                timed_out: false,
                output_artifact_path: outputArtifactPath,
                compact_summary: ['cached pass output with warning'],
                failure_chunks: [],
                out_of_scope_failure_policy: 'AUDIT_AND_BLOCK',
                out_of_scope_failure_detected: false,
                out_of_scope_audit_verdict: 'NOT_APPLICABLE',
                violations: [],
                warnings: ['non-blocking warning'],
                cycle_binding: {
                    task_id: taskId,
                    preflight_path: preflightPath.replace(/\\/g, '/'),
                    preflight_sha256: 'old-cycle',
                    compile_gate_timestamp: '2026-01-01T00:00:00.000Z',
                    scope_binding: {
                        changed_files_sha256: changedFilesSha,
                        scope_sha256: scopeSha,
                        scope_content_sha256: scopeContentSha
                    }
                }
            }, null, 2), 'utf8');

            const result = await runCliWithCapturedOutput([
                'gate', 'full-suite-validation',
                '--task-id', taskId,
                '--preflight-path', preflightPath,
                '--repo-root', tempDir
            ], { cwd: repoRoot });

            assert.equal(result.exitCode, 0, `stdout=${result.logs.join('\n')}\nstderr=${result.errors.join('\n')}`);
            assert.equal(fs.existsSync(executedMarker), false);
            const artifact = JSON.parse(fs.readFileSync(path.join(reviewsDir, `${taskId}-full-suite-validation.json`), 'utf8'));
            assert.equal(String(artifact.output_artifact_path).replace(/\\/g, '/'), outputArtifactPath.replace(/\\/g, '/'));
            assert.equal(artifact.output_retention, undefined);
            assert.equal(fs.existsSync(outputArtifactPath), true);
            fs.rmSync(tempDir, { recursive: true, force: true });
        });

        it('drops stale pending full-suite artifacts when the transaction id does not match the latest lifecycle event', async () => {
            const repoRoot = path.resolve(process.cwd());
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-fsv-cli-stale-pending-'));
            const configDir = path.join(tempDir, 'garda-agent-orchestrator', 'live', 'config');
            const reviewsDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'reviews');
            const eventsDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'task-events');
            fs.mkdirSync(configDir, { recursive: true });
            fs.mkdirSync(reviewsDir, { recursive: true });
            fs.mkdirSync(eventsDir, { recursive: true });

            const helperScript = path.join(tempDir, 'pass-stale-pending.js');
            fs.writeFileSync(
                helperScript,
                'process.stdout.write(\"all good\\\\n\"); process.exit(0);',
                'utf8'
            );
            fs.writeFileSync(path.join(configDir, 'workflow-config.json'), JSON.stringify({
                full_suite_validation: {
                    enabled: true,
                    command: `"${process.execPath.replace(/\\/g, '/')}" "${helperScript.replace(/\\/g, '/')}"`,
                    timeout_ms: 30000,
                    green_summary_max_lines: 5,
                    red_failure_chunk_lines: 50,
                    out_of_scope_failure_policy: 'AUDIT_AND_BLOCK'
                }
            }), 'utf8');

            const preflightPath = path.join(reviewsDir, 'T-STALE-PENDING-preflight.json');
            writeFullSuitePreflight(tempDir, preflightPath, {
                task_id: 'T-STALE-PENDING',
                changed_files: ['src/changed.ts']
            });

            const artifactPath = path.join(reviewsDir, 'T-STALE-PENDING-full-suite-validation.json');
            const pendingArtifactPath = `${artifactPath}.pending`;
            const pendingMetaPath = `${artifactPath}.pending.meta.json`;
            fs.writeFileSync(pendingArtifactPath, `${JSON.stringify({ status: 'FAILED', marker: 'stale-pending' }, null, 2)}\n`, 'utf8');
            fs.writeFileSync(pendingMetaPath, `${JSON.stringify({ transaction_id: 'stale-transaction-id' }, null, 2)}\n`, 'utf8');
            const timelinePath = path.join(eventsDir, 'T-STALE-PENDING.jsonl');
            const compileEvent = JSON.parse(
                fs.readFileSync(timelinePath, 'utf8').trim().split('\n').at(-1) || '{}'
            ) as Record<string, unknown>;
            writeAuthenticatedTimeline(tempDir, 'T-STALE-PENDING', [compileEvent, {
                    event_type: 'FULL_SUITE_VALIDATION_PASSED',
                    details: {
                        artifact_transaction_id: 'different-transaction-id'
                    }
                }]);

            const fsModule = require('node:fs') as typeof import('node:fs');
            const originalCopyFileSync = fsModule.copyFileSync;
            let promotionCount = 0;
            try {
                fsModule.copyFileSync = ((src: fs.PathLike, dest: fs.PathLike, mode?: number) => {
                    const normalizedSrc = path.resolve(String(src));
                    const normalizedDest = path.resolve(String(dest));
                    if (
                        normalizedSrc === path.resolve(pendingArtifactPath)
                        && normalizedDest === path.resolve(artifactPath)
                    ) {
                        promotionCount += 1;
                    }
                    return originalCopyFileSync(src, dest, mode);
                }) as typeof fsModule.copyFileSync;

                const result = await runCliWithCapturedOutput([
                    'gate', 'full-suite-validation',
                    '--task-id', 'T-STALE-PENDING',
                    '--preflight-path', preflightPath,
                    '--repo-root', tempDir
                ], { cwd: repoRoot });

                assert.equal(result.exitCode, 0, `stdout=${result.logs.join('\n')}\nstderr=${result.errors.join('\n')}`);
            } finally {
                fsModule.copyFileSync = originalCopyFileSync;
            }

            assert.equal(promotionCount, 1);
            assert.ok(fs.existsSync(artifactPath));
            const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
            assert.equal(artifact.status, 'PASSED');
            assert.equal((artifact as Record<string, unknown>).marker, undefined);
            assert.equal(fs.existsSync(pendingArtifactPath), false);
            assert.equal(fs.existsSync(pendingMetaPath), false);
            fs.rmSync(tempDir, { recursive: true, force: true });
        });

        it('persists failed shard logs and compact failure evidence for failed full-suite runs', async () => {
            const repoRoot = path.resolve(process.cwd());
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-fsv-cli-failure-evidence-'));
            const configDir = path.join(tempDir, 'garda-agent-orchestrator', 'live', 'config');
            const reviewsDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'reviews');
            const eventsDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'task-events');
            fs.mkdirSync(configDir, { recursive: true });
            fs.mkdirSync(reviewsDir, { recursive: true });
            fs.mkdirSync(eventsDir, { recursive: true });

            const shardLogPath = path.join(tempDir, '.node-build', 'test-shard-logs', 'run-1', 'shard-01-of-02.log');
            const helperScript = path.join(tempDir, 'fail-with-shard-log.js');
            fs.writeFileSync(
                helperScript,
                [
                    'const fs = require("node:fs");',
                    'const path = require("node:path");',
                    `const shardLogPath = ${JSON.stringify(shardLogPath)};`,
                    'fs.mkdirSync(path.dirname(shardLogPath), { recursive: true });',
                    'fs.writeFileSync(shardLogPath, "shard detail line\\nnot ok 1 - shard failed\\n", "utf8");',
                    'process.stdout.write(`NODE_FOUNDATION_TEST_SHARD_LOG_DIR ${path.dirname(shardLogPath)}\\n`);',
                    'process.stdout.write("NODE_FOUNDATION_TEST_DURATION_TELEMETRY telemetry.json\\n");',
                    'process.stdout.write("NODE_FOUNDATION_TEST_SHARD_RUNTIME timeout_ms=30000 heartbeat_ms=1000 concurrency=1\\n");',
                    'process.stdout.write("NODE_FOUNDATION_TEST_SHARD_START 1/2 files=1\\n");',
                    'process.stdout.write(`NODE_FOUNDATION_TEST_SHARD_LOG 1/2 ${shardLogPath}\\n`);',
                    'process.stdout.write(`NODE_FOUNDATION_TEST_SHARD_DONE 1/2 exit=1 duration_ms=10 timed_out=false log=${shardLogPath}\\n`);',
                    'process.stdout.write("not ok 1 - failed at src/changed.ts:5\\n");',
                    'process.exit(1);'
                ].join('\n'),
                'utf8'
            );
            fs.writeFileSync(path.join(configDir, 'workflow-config.json'), JSON.stringify({
                full_suite_validation: {
                    enabled: true,
                    command: `"${process.execPath.replace(/\\/g, '/')}" "${helperScript.replace(/\\/g, '/')}"`,
                    timeout_ms: 30000,
                    green_summary_max_lines: 5,
                    red_failure_chunk_lines: 20,
                    out_of_scope_failure_policy: 'AUDIT_AND_BLOCK'
                }
            }), 'utf8');

            const taskId = 'T-FAILURE-EVIDENCE';
            const preflightPath = path.join(reviewsDir, `${taskId}-preflight.json`);
            writeFullSuitePreflight(tempDir, preflightPath, {
                task_id: taskId,
                changed_files: ['src/changed.ts']
            });

            const result = await runCliWithCapturedOutput([
                'gate', 'full-suite-validation',
                '--task-id', taskId,
                '--preflight-path', preflightPath,
                '--repo-root', tempDir
            ], { cwd: repoRoot });

            assert.equal(result.exitCode, EXIT_GATE_FAILURE, `stdout=${result.logs.join('\n')}\nstderr=${result.errors.join('\n')}`);
            assert.ok(result.logs.some((line) => line.includes('FailureEvidence: summary=')));
            const artifact = JSON.parse(fs.readFileSync(path.join(reviewsDir, `${taskId}-full-suite-validation.json`), 'utf8'));
            assert.equal(artifact.status, 'FAILED');
            assert.equal(artifact.failure_evidence.copied_logs_count, 1);
            const summaryPath = String(artifact.failure_evidence.summary_artifact_path);
            assert.ok(fs.existsSync(summaryPath));
            const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
            assert.match(summary.command, /fail-with-shard-log\.js/u);
            assert.equal(summary.exit_code, 1);
            assert.equal(summary.timed_out, false);
            assert.equal(summary.output_artifact_path, artifact.output_artifact_path);
            assert.equal(summary.copied_logs_count, 1);
            assert.ok(summary.last_output_lines.some((line: string) => line.includes('failed at src/changed.ts:5')));
            const copiedLogPath = String(summary.copied_logs[0].artifact_path);
            assert.ok(fs.existsSync(copiedLogPath));
            assert.match(fs.readFileSync(copiedLogPath, 'utf8'), /shard detail line/u);
            assert.ok(summary.shard_diagnostics.some((line: string) => line.includes('NODE_FOUNDATION_TEST_SHARD_LOG 1/2')));
            fs.rmSync(tempDir, { recursive: true, force: true });
        });

        it('does not copy undeclared shard log paths injected through untrusted command output', async () => {
            const repoRoot = path.resolve(process.cwd());
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-fsv-cli-fake-shard-log-'));
            const configDir = path.join(tempDir, 'garda-agent-orchestrator', 'live', 'config');
            const reviewsDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'reviews');
            const eventsDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'task-events');
            fs.mkdirSync(configDir, { recursive: true });
            fs.mkdirSync(reviewsDir, { recursive: true });
            fs.mkdirSync(eventsDir, { recursive: true });

            const fakeLogPath = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'reviews', 'sensitive.txt');
            fs.writeFileSync(fakeLogPath, 'do not copy this file\n', 'utf8');
            const helperScript = path.join(tempDir, 'fail-with-fake-shard-log.js');
            fs.writeFileSync(
                helperScript,
                [
                    `const fakeLogPath = ${JSON.stringify(fakeLogPath)};`,
                    'process.stdout.write(`NODE_FOUNDATION_TEST_SHARD_DONE 1/2 exit=1 duration_ms=10 timed_out=false log=${fakeLogPath}\\n`);',
                    'process.stdout.write("not ok 1 - failed at src/changed.ts:5\\n");',
                    'process.exit(1);'
                ].join('\n'),
                'utf8'
            );
            fs.writeFileSync(path.join(configDir, 'workflow-config.json'), JSON.stringify({
                full_suite_validation: {
                    enabled: true,
                    command: `"${process.execPath.replace(/\\/g, '/')}" "${helperScript.replace(/\\/g, '/')}"`,
                    timeout_ms: 30000,
                    green_summary_max_lines: 5,
                    red_failure_chunk_lines: 20,
                    out_of_scope_failure_policy: 'AUDIT_AND_BLOCK'
                }
            }), 'utf8');

            const taskId = 'T-FAKE-SHARD-LOG';
            const preflightPath = path.join(reviewsDir, `${taskId}-preflight.json`);
            writeFullSuitePreflight(tempDir, preflightPath, {
                task_id: taskId,
                changed_files: ['src/changed.ts']
            });

            const result = await runCliWithCapturedOutput([
                'gate', 'full-suite-validation',
                '--task-id', taskId,
                '--preflight-path', preflightPath,
                '--repo-root', tempDir
            ], { cwd: repoRoot });

            assert.equal(result.exitCode, EXIT_GATE_FAILURE, `stdout=${result.logs.join('\n')}\nstderr=${result.errors.join('\n')}`);
            const artifact = JSON.parse(fs.readFileSync(path.join(reviewsDir, `${taskId}-full-suite-validation.json`), 'utf8'));
            assert.equal(artifact.status, 'FAILED');
            assert.equal(artifact.failure_evidence.copied_logs_count, 0);
            const summary = JSON.parse(fs.readFileSync(String(artifact.failure_evidence.summary_artifact_path), 'utf8'));
            assert.equal(summary.copied_logs_count, 0);
            assert.equal(JSON.stringify(summary).includes('do not copy this file'), false);
            assert.ok(summary.shard_diagnostics.some((line: string) => line.includes('NODE_FOUNDATION_TEST_SHARD_DONE 1/2')));
            fs.rmSync(tempDir, { recursive: true, force: true });
        });

        it('does not trust shard log declarations injected after child output starts', async () => {
            const repoRoot = path.resolve(process.cwd());
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-fsv-cli-forged-shard-log-'));
            const configDir = path.join(tempDir, 'garda-agent-orchestrator', 'live', 'config');
            const reviewsDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'reviews');
            const eventsDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'task-events');
            fs.mkdirSync(configDir, { recursive: true });
            fs.mkdirSync(reviewsDir, { recursive: true });
            fs.mkdirSync(eventsDir, { recursive: true });

            const trustedLogDir = path.join(tempDir, '.node-build', 'test-shard-logs', 'run-1');
            const forgedLogPath = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'reviews', 'sensitive.txt');
            fs.writeFileSync(forgedLogPath, 'do not copy forged declaration\n', 'utf8');
            const helperScript = path.join(tempDir, 'fail-with-forged-shard-log.js');
            fs.writeFileSync(
                helperScript,
                [
                    `const trustedLogDir = ${JSON.stringify(trustedLogDir)};`,
                    `const forgedLogPath = ${JSON.stringify(forgedLogPath)};`,
                    'process.stdout.write(`NODE_FOUNDATION_TEST_SHARD_LOG_DIR ${trustedLogDir}\\n`);',
                    'process.stdout.write("NODE_FOUNDATION_TEST_SHARD_RUNTIME timeout_ms=30000 heartbeat_ms=1000 concurrency=1\\n");',
                    'process.stdout.write("not ok 1 - child output started\\n");',
                    'process.stdout.write(`NODE_FOUNDATION_TEST_SHARD_LOG 1/2 ${forgedLogPath}\\n`);',
                    'process.stdout.write(`NODE_FOUNDATION_TEST_SHARD_DONE 1/2 exit=1 duration_ms=10 timed_out=false log=${forgedLogPath}\\n`);',
                    'process.exit(1);'
                ].join('\n'),
                'utf8'
            );
            fs.writeFileSync(path.join(configDir, 'workflow-config.json'), JSON.stringify({
                full_suite_validation: {
                    enabled: true,
                    command: `"${process.execPath.replace(/\\/g, '/')}" "${helperScript.replace(/\\/g, '/')}"`,
                    timeout_ms: 30000,
                    green_summary_max_lines: 5,
                    red_failure_chunk_lines: 20,
                    out_of_scope_failure_policy: 'AUDIT_AND_BLOCK'
                }
            }), 'utf8');

            const taskId = 'T-FORGED-SHARD-LOG';
            const preflightPath = path.join(reviewsDir, `${taskId}-preflight.json`);
            writeFullSuitePreflight(tempDir, preflightPath, {
                task_id: taskId,
                changed_files: ['src/changed.ts']
            });

            const result = await runCliWithCapturedOutput([
                'gate', 'full-suite-validation',
                '--task-id', taskId,
                '--preflight-path', preflightPath,
                '--repo-root', tempDir
            ], { cwd: repoRoot });

            assert.equal(result.exitCode, EXIT_GATE_FAILURE, `stdout=${result.logs.join('\n')}\nstderr=${result.errors.join('\n')}`);
            const artifact = JSON.parse(fs.readFileSync(path.join(reviewsDir, `${taskId}-full-suite-validation.json`), 'utf8'));
            assert.equal(artifact.status, 'FAILED');
            assert.equal(artifact.failure_evidence.copied_logs_count, 0);
            const summary = JSON.parse(fs.readFileSync(String(artifact.failure_evidence.summary_artifact_path), 'utf8'));
            assert.equal(summary.copied_logs_count, 0);
            assert.equal(JSON.stringify(summary).includes('do not copy forged declaration'), false);
            assert.ok(summary.shard_diagnostics.some((line: string) => line.includes('NODE_FOUNDATION_TEST_SHARD_LOG 1/2')));
            fs.rmSync(tempDir, { recursive: true, force: true });
        });

        it('copies failed later-batch shard logs from the trusted shard log directory', () => {
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-fsv-later-batch-shard-log-'));
            const reviewsDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'reviews');
            const trustedLogDir = path.join(tempDir, '.node-build', 'test-shard-logs', 'run-1');
            fs.mkdirSync(reviewsDir, { recursive: true });
            fs.mkdirSync(trustedLogDir, { recursive: true });
            const laterBatchLogPath = path.join(trustedLogDir, 'shard-02-of-02.log');
            fs.writeFileSync(laterBatchLogPath, 'later batch shard failed\nnot ok 1\n', 'utf8');
            const result: FullSuiteValidationResult = {
                status: 'FAILED',
                enabled: true,
                command: 'npm test',
                exit_code: 1,
                timed_out: false,
                output_artifact_path: null,
                compact_summary: ['not ok 1 - failed at src/changed.ts:5'],
                failure_chunks: [['not ok 1 - failed at src/changed.ts:5']],
                out_of_scope_failure_policy: 'AUDIT_AND_BLOCK',
                out_of_scope_failure_detected: false,
                out_of_scope_audit_verdict: 'NOT_APPLICABLE',
                violations: [],
                warnings: []
            };

            const evidence = persistFullSuiteFailureEvidence({
                repoRoot: tempDir,
                reviewsRoot: reviewsDir,
                taskId: 'T-LATER-BATCH-SHARD-LOG',
                result,
                outputLines: [
                    `NODE_FOUNDATION_TEST_SHARD_LOG_DIR ${trustedLogDir}`,
                    'NODE_FOUNDATION_TEST_SHARD_RUNTIME timeout_ms=30000 heartbeat_ms=1000 concurrency=1',
                    'NODE_FOUNDATION_TEST_SHARD_START 1/2 files=1',
                    'NODE_FOUNDATION_TEST_SHARD_LOG 1/2 ignored-first-batch.log',
                    'not ok 1 - first batch child output started',
                    'NODE_FOUNDATION_TEST_SHARD_START 2/2 files=1',
                    `NODE_FOUNDATION_TEST_SHARD_LOG 2/2 ${laterBatchLogPath}`,
                    `NODE_FOUNDATION_TEST_SHARD_DONE 2/2 exit=1 duration_ms=10 timed_out=false log=${laterBatchLogPath}`
                ],
                maxCopiedLogs: 2
            });

            assert.ok(evidence);
            assert.equal(evidence.copied_logs_count, 1);
            assert.match(fs.readFileSync(evidence.copied_logs[0].artifact_path, 'utf8'), /later batch shard failed/u);
            fs.rmSync(tempDir, { recursive: true, force: true });
        });

        it('does not copy declared shard logs that escape the repo through symlinks', async () => {
            const repoRoot = path.resolve(process.cwd());
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-fsv-cli-symlink-shard-log-'));
            const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-fsv-outside-shard-log-'));
            try {
                const configDir = path.join(tempDir, 'garda-agent-orchestrator', 'live', 'config');
                const reviewsDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'reviews');
                const eventsDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'task-events');
                fs.mkdirSync(configDir, { recursive: true });
                fs.mkdirSync(reviewsDir, { recursive: true });
                fs.mkdirSync(eventsDir, { recursive: true });

                const trustedLogDir = path.join(tempDir, '.node-build', 'test-shard-logs', 'run-1');
                fs.mkdirSync(path.dirname(trustedLogDir), { recursive: true });
                const outsideLogPath = path.join(outsideDir, 'leaked.log');
                fs.writeFileSync(outsideLogPath, 'outside secret should not be copied\n', 'utf8');
                fs.symlinkSync(outsideDir, trustedLogDir, 'junction');

                const declaredLogPath = path.join(trustedLogDir, 'leaked.log');
                const helperScript = path.join(tempDir, 'fail-with-symlink-shard-log.js');
                fs.writeFileSync(
                    helperScript,
                    [
                        `const trustedLogDir = ${JSON.stringify(trustedLogDir)};`,
                        `const declaredLogPath = ${JSON.stringify(declaredLogPath)};`,
                        'process.stdout.write(`NODE_FOUNDATION_TEST_SHARD_LOG_DIR ${trustedLogDir}\\n`);',
                        'process.stdout.write("NODE_FOUNDATION_TEST_SHARD_RUNTIME timeout_ms=30000 heartbeat_ms=1000 concurrency=1\\n");',
                        'process.stdout.write("NODE_FOUNDATION_TEST_SHARD_START 1/2 files=1\\n");',
                        'process.stdout.write(`NODE_FOUNDATION_TEST_SHARD_LOG 1/2 ${declaredLogPath}\\n`);',
                        'process.stdout.write(`NODE_FOUNDATION_TEST_SHARD_DONE 1/2 exit=1 duration_ms=10 timed_out=false log=${declaredLogPath}\\n`);',
                        'process.stdout.write("not ok 1 - failed at src/changed.ts:5\\n");',
                        'process.exit(1);'
                    ].join('\n'),
                    'utf8'
                );
                fs.writeFileSync(path.join(configDir, 'workflow-config.json'), JSON.stringify({
                    full_suite_validation: {
                        enabled: true,
                        command: `"${process.execPath.replace(/\\/g, '/')}" "${helperScript.replace(/\\/g, '/')}"`,
                        timeout_ms: 30000,
                        green_summary_max_lines: 5,
                        red_failure_chunk_lines: 20,
                        out_of_scope_failure_policy: 'AUDIT_AND_BLOCK'
                    }
                }), 'utf8');

                const taskId = 'T-SYMLINK-SHARD-LOG';
                const preflightPath = path.join(reviewsDir, `${taskId}-preflight.json`);
                writeFullSuitePreflight(tempDir, preflightPath, {
                    task_id: taskId,
                    changed_files: ['src/changed.ts']
                });

                const result = await runCliWithCapturedOutput([
                    'gate', 'full-suite-validation',
                    '--task-id', taskId,
                    '--preflight-path', preflightPath,
                    '--repo-root', tempDir
                ], { cwd: repoRoot });

                assert.equal(result.exitCode, EXIT_GATE_FAILURE, `stdout=${result.logs.join('\n')}\nstderr=${result.errors.join('\n')}`);
                const artifact = JSON.parse(fs.readFileSync(path.join(reviewsDir, `${taskId}-full-suite-validation.json`), 'utf8'));
                assert.equal(artifact.status, 'FAILED');
                assert.equal(artifact.failure_evidence.copied_logs_count, 0);
                const summary = JSON.parse(fs.readFileSync(String(artifact.failure_evidence.summary_artifact_path), 'utf8'));
                assert.equal(summary.copied_logs_count, 0);
                assert.equal(JSON.stringify(summary).includes('outside secret should not be copied'), false);
                assert.ok(summary.shard_diagnostics.some((line: string) => line.includes('NODE_FOUNDATION_TEST_SHARD_LOG 1/2')));
            } finally {
                fs.rmSync(tempDir, { recursive: true, force: true });
                fs.rmSync(outsideDir, { recursive: true, force: true });
            }
        });

        it('summarizes top failing node tests from copied shard logs', () => {
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-fsv-top-failures-'));
            const reviewsDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'reviews');
            const trustedLogDir = path.join(tempDir, '.node-build', 'test-shard-logs', 'run-1');
            fs.mkdirSync(reviewsDir, { recursive: true });
            fs.mkdirSync(trustedLogDir, { recursive: true });
            const shardLogPath = path.join(trustedLogDir, 'shard-01-of-02.log');
            fs.writeFileSync(shardLogPath, [
                '✔ surfaces timeout output through the same failed-command path (1729.3283ms)',
                '▶ gates command timeout and execution wrappers',
                'ok 1 - previous test',
                'test at .node-build\\tests\\node\\cli\\commands\\gates\\shared\\gates-command-help.test.js:299:24',
                '✖ includes real-subagent hard-stop guidance in delegation-start help (3.0376ms)',
                '  AssertionError [ERR_ASSERTION]: The expression evaluated to a falsy value:',
                '    ok(helpOutput.includes("Provider-owned placeholders are --provider-invocation-id and --attestation-source"))',
                `tail filler ${'x'.repeat(500)}`,
                'NODE_FOUNDATION_TEST_SHARD_DONE 1/2 exit=1 duration_ms=10 timed_out=false log=' + shardLogPath
            ].join('\n'), 'utf8');
            const result: FullSuiteValidationResult = {
                status: 'FAILED',
                enabled: true,
                command: 'npm run test:sharded',
                exit_code: 1,
                timed_out: false,
                output_artifact_path: path.join(reviewsDir, 'T-TOP-FAILURES-full-suite-output.log'),
                compact_summary: ['NODE_FOUNDATION_TEST_SHARD_LOG_DIR ' + trustedLogDir],
                failure_chunks: [['NODE_FOUNDATION_TEST_SHARD_DONE 1/2 exit=1 duration_ms=10 timed_out=false log=' + shardLogPath]],
                out_of_scope_failure_policy: 'AUDIT_AND_BLOCK',
                out_of_scope_failure_detected: false,
                out_of_scope_audit_verdict: 'NOT_APPLICABLE',
                violations: [],
                warnings: []
            };

            const evidence = persistFullSuiteFailureEvidence({
                repoRoot: tempDir,
                reviewsRoot: reviewsDir,
                taskId: 'T-TOP-FAILURES',
                result,
                outputLines: [
                    '✔ loadCliMainModule enforces one runtime lock timeout budget per candidate (370.4191ms)',
                    '▶ gates command timeout and execution wrappers',
                    `NODE_FOUNDATION_TEST_SHARD_LOG_DIR ${trustedLogDir}`,
                    'NODE_FOUNDATION_TEST_SHARD_RUNTIME timeout_ms=30000 heartbeat_ms=1000 concurrency=1',
                    'NODE_FOUNDATION_TEST_SHARD_START 1/2 files=1',
                    `NODE_FOUNDATION_TEST_SHARD_LOG 1/2 ${shardLogPath}`,
                    `NODE_FOUNDATION_TEST_SHARD_DONE 1/2 exit=1 duration_ms=10 timed_out=false log=${shardLogPath}`
                ],
                maxLogChars: 120
            });

            assert.ok(evidence);
            assert.equal(evidence.copied_logs[0].truncated, true);
            const copiedArtifact = fs.readFileSync(evidence.copied_logs[0].artifact_path, 'utf8');
            assert.match(copiedArtifact, /retained_failure_window_chars=/u);
            assert.match(copiedArtifact, /includes real-subagent hard-stop guidance/u);
            assert.equal(evidence.failure_kind, 'assertion');
            assert.equal(evidence.top_failures.length, 1);
            assert.equal(evidence.top_failures[0].kind, 'assertion');
            assert.equal(evidence.top_failures[0].test_name, 'includes real-subagent hard-stop guidance in delegation-start help');
            assert.equal(evidence.top_failures[0].file_path, '.node-build/tests/node/cli/commands/gates/shared/gates-command-help.test.js');
            assert.equal(evidence.top_failures[0].line, 299);
            assert.equal(evidence.top_failures[0].source, 'copied_log');
            assert.equal(evidence.top_failures[0].source_path, shardLogPath.replace(/\\/g, '/'));
            assert.match(evidence.top_failures[0].artifact_path || '', /shard-log-01\.log$/u);
            const summary = JSON.parse(fs.readFileSync(String(evidence.summary_artifact_path), 'utf8'));
            assert.equal(summary.failure_kind, 'assertion');
            assert.equal(summary.top_failures[0].test_name, 'includes real-subagent hard-stop guidance in delegation-start help');
            fs.rmSync(tempDir, { recursive: true, force: true });
        });

        it('prioritizes concrete failing node tests over timeout fixture diagnostics', () => {
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-fsv-failing-test-priority-'));
            const reviewsDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'reviews');
            fs.mkdirSync(reviewsDir, { recursive: true });
            const result: FullSuiteValidationResult = {
                status: 'FAILED',
                enabled: true,
                command: 'npm run test:sharded',
                exit_code: 1,
                timed_out: false,
                output_artifact_path: path.join(reviewsDir, 'T-FAILURE-PRIORITY-full-suite-output.log'),
                compact_summary: [],
                failure_chunks: [],
                out_of_scope_failure_policy: 'AUDIT_AND_BLOCK',
                out_of_scope_failure_detected: false,
                out_of_scope_audit_verdict: 'NOT_APPLICABLE',
                violations: [],
                warnings: []
            };

            const evidence = persistFullSuiteFailureEvidence({
                repoRoot: tempDir,
                reviewsRoot: reviewsDir,
                taskId: 'T-FAILURE-PRIORITY',
                result,
                outputLines: [
                    '✔ preserves NODE_FOUNDATION_TEST_SHARD_TIMEOUT fixture output in passing tests (1.0000ms)',
                    ...Array.from({ length: 10 }, (_unused, index) => (
                        `NODE_FOUNDATION_TEST_SHARD_TIMEOUT 1/2 pid=${100 + index} elapsed_ms=759 last_output_age_ms=758 log=.node-build/test-shard-logs/run-1/shard-01-of-02.log cleanup=child_kill_sigkill`
                    )),
                    'process_hang fixture diagnostic retained for wrapper coverage',
                    'real test failure fixture diagnostic retained for wrapper coverage',
                    '✖ failing tests:',
                    'test at .node-build\\tests\\node\\ui\\local-ui-smoke.test.js:87:7',
                    '✖ local UI browser smoke opens checks cycle tab and renders diagnostics (30012.1234ms)',
                    '  Error: Timed out waiting for browser text matching /Tasks/u',
                    '# fail 1'
                ],
                maxCopiedLogs: 0
            });

            assert.ok(evidence);
            assert.equal(evidence.failure_kind, 'timeout');
            assert.equal(evidence.top_failures[0].kind, 'timeout');
            assert.equal(evidence.top_failures[0].test_name, 'local UI browser smoke opens checks cycle tab and renders diagnostics');
            assert.equal(evidence.top_failures[0].file_path, '.node-build/tests/node/ui/local-ui-smoke.test.js');
            assert.equal(evidence.top_failures[0].line, 87);
            assert.doesNotMatch(evidence.top_failures[0].summary, /NODE_FOUNDATION_TEST_SHARD_TIMEOUT/u);
            const summary = JSON.parse(fs.readFileSync(String(evidence.summary_artifact_path), 'utf8'));
            assert.equal(summary.failure_kind, 'timeout');
            assert.equal(summary.top_failures[0].test_name, 'local UI browser smoke opens checks cycle tab and renders diagnostics');
            assert.doesNotMatch(summary.top_failures[0].summary, /NODE_FOUNDATION_TEST_SHARD_TIMEOUT/u);
            fs.rmSync(tempDir, { recursive: true, force: true });
        });

        it('ignores nested timeout fixture failures before the explicit failing tests list', () => {
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-fsv-fixture-before-failing-list-'));
            const reviewsDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'reviews');
            const trustedLogDir = path.join(tempDir, '.node-build', 'test-shard-logs', 'run-1');
            fs.mkdirSync(reviewsDir, { recursive: true });
            fs.mkdirSync(trustedLogDir, { recursive: true });
            const shardLogPath = path.join(trustedLogDir, 'shard-01-of-02.log');
            fs.writeFileSync(shardLogPath, [
                '✔ preserves timeout fixture output in passing tests (1.0000ms)',
                '✖ real test failure (1.0000ms)',
                'NODE_FOUNDATION_TEST_SHARD_TIMEOUT 1/2 pid=100 elapsed_ms=759 last_output_age_ms=758 log=.node-build/test-shard-logs/run-1/shard-01-of-02.log cleanup=child_kill_sigkill',
                ...Array.from({ length: 30 }, (_unused, index) => `fixture filler ${index}`),
                '✖ failing tests:',
                'test at .node-build\\tests\\node\\validators\\release-readiness.test.js:42:9',
                '✖ release readiness fails when package files include node test build output (10.0000ms)',
                '  Error: EACCES: permission denied, open ".git/config"',
                '# fail 1',
                'NODE_FOUNDATION_TEST_SHARD_DONE 1/2 exit=1 duration_ms=10 timed_out=false log=' + shardLogPath
            ].join('\n'), 'utf8');
            const result: FullSuiteValidationResult = {
                status: 'FAILED',
                enabled: true,
                command: 'npm run test:sharded',
                exit_code: 1,
                timed_out: false,
                output_artifact_path: path.join(reviewsDir, 'T-FIXTURE-BEFORE-FAILING-LIST-full-suite-output.log'),
                compact_summary: [],
                failure_chunks: [],
                out_of_scope_failure_policy: 'AUDIT_AND_BLOCK',
                out_of_scope_failure_detected: false,
                out_of_scope_audit_verdict: 'NOT_APPLICABLE',
                violations: [],
                warnings: []
            };

            const evidence = persistFullSuiteFailureEvidence({
                repoRoot: tempDir,
                reviewsRoot: reviewsDir,
                taskId: 'T-FIXTURE-BEFORE-FAILING-LIST',
                result,
                outputLines: [
                    `NODE_FOUNDATION_TEST_SHARD_LOG_DIR ${trustedLogDir}`,
                    `NODE_FOUNDATION_TEST_SHARD_LOG 1/2 ${shardLogPath}`,
                    `NODE_FOUNDATION_TEST_SHARD_DONE 1/2 exit=1 duration_ms=10 timed_out=false log=${shardLogPath}`
                ],
                maxLogChars: 220
            });

            assert.ok(evidence);
            assert.notEqual(evidence.failure_kind, 'process_hang');
            assert.notEqual(evidence.top_failures[0].kind, 'process_hang');
            assert.equal(evidence.top_failures[0].test_name, 'release readiness fails when package files include node test build output');
            assert.equal(evidence.top_failures[0].file_path, '.node-build/tests/node/validators/release-readiness.test.js');
            assert.equal(evidence.top_failures[0].line, 42);
            assert.doesNotMatch(evidence.top_failures[0].summary, /NODE_FOUNDATION_TEST_SHARD_TIMEOUT/u);
            assert.doesNotMatch(evidence.top_failures[0].summary, /real test failure/u);
            const copiedArtifact = fs.readFileSync(evidence.copied_logs[0].artifact_path, 'utf8');
            assert.match(copiedArtifact, /release readiness fails/u);
            assert.doesNotMatch(copiedArtifact, /NODE_FOUNDATION_TEST_SHARD_TIMEOUT/u);
            const summary = JSON.parse(fs.readFileSync(String(evidence.summary_artifact_path), 'utf8'));
            assert.notEqual(summary.failure_kind, 'process_hang');
            assert.equal(summary.top_failures[0].test_name, 'release readiness fails when package files include node test build output');
            fs.rmSync(tempDir, { recursive: true, force: true });
        });

        it('classifies shard timeout diagnostics as process hangs', () => {
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-fsv-process-hang-'));
            const reviewsDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'reviews');
            fs.mkdirSync(reviewsDir, { recursive: true });
            const result: FullSuiteValidationResult = {
                status: 'FAILED',
                enabled: true,
                command: 'npm run test:sharded',
                exit_code: 1,
                timed_out: true,
                output_artifact_path: null,
                compact_summary: [],
                failure_chunks: [],
                out_of_scope_failure_policy: 'AUDIT_AND_BLOCK',
                out_of_scope_failure_detected: false,
                out_of_scope_audit_verdict: 'NOT_APPLICABLE',
                violations: [],
                warnings: []
            };

            const evidence = persistFullSuiteFailureEvidence({
                repoRoot: tempDir,
                reviewsRoot: reviewsDir,
                taskId: 'T-PROCESS-HANG',
                result,
                outputLines: [
                    'NODE_FOUNDATION_TEST_SHARD_TIMEOUT 1/2 pid=100 elapsed_ms=759 last_output_age_ms=758 log=.node-build/test-shard-logs/run-1/shard-01-of-02.log cleanup=child_kill_sigkill'
                ],
                maxCopiedLogs: 0
            });

            assert.ok(evidence);
            assert.equal(evidence.failure_kind, 'process_hang');
            assert.equal(evidence.top_failures[0].kind, 'process_hang');
            assert.match(evidence.top_failures[0].summary, /NODE_FOUNDATION_TEST_SHARD_TIMEOUT/u);
            fs.rmSync(tempDir, { recursive: true, force: true });
        });

        it('prioritizes command timeout over nested lock-timeout fixture output', () => {
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-fsv-command-timeout-priority-'));
            const reviewsDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'reviews');
            fs.mkdirSync(reviewsDir, { recursive: true });
            const result: FullSuiteValidationResult = {
                status: 'WARNED',
                enabled: true,
                command: 'npm run test:sharded',
                exit_code: 1,
                timed_out: true,
                output_artifact_path: path.join(reviewsDir, 'T-COMMAND-TIMEOUT-PRIORITY-full-suite-output.log'),
                compact_summary: [],
                failure_chunks: [],
                out_of_scope_failure_policy: 'AUDIT_AND_BLOCK',
                out_of_scope_failure_detected: false,
                out_of_scope_audit_verdict: 'NOT_APPLICABLE',
                violations: [],
                warnings: []
            };

            const evidence = persistFullSuiteFailureEvidence({
                repoRoot: tempDir,
                reviewsRoot: reviewsDir,
                taskId: 'T-COMMAND-TIMEOUT-PRIORITY',
                result,
                outputLines: [
                    'GARDA_CLI_FAILED',
                    'Timed out acquiring file lock: runtime/reviews/T-904z-lock-code-receipt.json.lock; waited_ms=4; timeout_ms=5000; retries=0; wait_strategy=immediate_fail',
                    'GARDA_CLI_FAILED',
                    'Process timed out after 600000 ms.'
                ],
                maxCopiedLogs: 0
            });

            assert.ok(evidence);
            assert.equal(evidence.failure_kind, 'timeout');
            assert.equal(evidence.top_failures[0].summary, 'Process timed out after 600000 ms.');
            fs.rmSync(tempDir, { recursive: true, force: true });
        });

        it('bounds summary evidence lines copied from failure output', () => {
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-fsv-bounded-summary-'));
            const reviewsDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'reviews');
            fs.mkdirSync(reviewsDir, { recursive: true });
            const longLine = `not ok 1 - ${'x'.repeat(20_000)}`;
            const longDiagnostic = `NODE_FOUNDATION_TEST_SHARD_DONE 1/2 exit=1 duration_ms=10 timed_out=false log=${'y'.repeat(20_000)}`;
            const result: FullSuiteValidationResult = {
                status: 'FAILED',
                enabled: true,
                command: `npm test ${'z'.repeat(20_000)}`,
                exit_code: 1,
                timed_out: false,
                output_artifact_path: null,
                compact_summary: [longLine],
                failure_chunks: [[longLine]],
                out_of_scope_failure_policy: 'AUDIT_AND_BLOCK',
                out_of_scope_failure_detected: false,
                out_of_scope_audit_verdict: 'NOT_APPLICABLE',
                violations: [],
                warnings: []
            };

            const evidence = persistFullSuiteFailureEvidence({
                repoRoot: tempDir,
                reviewsRoot: reviewsDir,
                taskId: 'T-BOUNDED-SUMMARY',
                result,
                outputLines: [longDiagnostic, longLine],
                maxCopiedLogs: 0
            });

            assert.ok(evidence);
            const summary = JSON.parse(fs.readFileSync(String(evidence.summary_artifact_path), 'utf8'));
            const summaryLines = [
                summary.command,
                summary.compact_summary[0],
                summary.failure_chunks[0][0],
                summary.last_output_lines[0],
                summary.shard_diagnostics[0]
            ];
            for (const line of summaryLines) {
                assert.equal(typeof line, 'string');
                assert.ok(line.length <= 4_000, `line should be capped, got ${line.length}`);
                assert.match(line, /truncated original_chars=/u);
            }
            assert.equal(JSON.stringify(summary).includes('x'.repeat(10_000)), false);
            assert.equal(JSON.stringify(summary).includes('y'.repeat(10_000)), false);
            fs.rmSync(tempDir, { recursive: true, force: true });
        });

        it('rejects malformed task ids before creating failure evidence directories', () => {
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-fsv-invalid-task-id-'));
            const reviewsDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'reviews');
            fs.mkdirSync(reviewsDir, { recursive: true });
            const escapedDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'escaped-full-suite-failure-evidence');
            const result: FullSuiteValidationResult = {
                status: 'FAILED',
                enabled: true,
                command: 'npm test',
                exit_code: 1,
                timed_out: false,
                output_artifact_path: null,
                compact_summary: ['not ok 1 - failed at src/changed.ts:5'],
                failure_chunks: [['not ok 1 - failed at src/changed.ts:5']],
                out_of_scope_failure_policy: 'AUDIT_AND_BLOCK',
                out_of_scope_failure_detected: false,
                out_of_scope_audit_verdict: 'NOT_APPLICABLE',
                violations: [],
                warnings: []
            };

            assert.throws(
                () => persistFullSuiteFailureEvidence({
                    repoRoot: tempDir,
                    reviewsRoot: reviewsDir,
                    taskId: '../escaped',
                    result,
                    outputLines: ['not ok 1 - failed at src/changed.ts:5']
                }),
                /semantic pattern/u
            );
            assert.equal(fs.existsSync(escapedDir), false);
            assert.equal(fs.readdirSync(reviewsDir).length, 0);
            fs.rmSync(tempDir, { recursive: true, force: true });
        });
    });
});
