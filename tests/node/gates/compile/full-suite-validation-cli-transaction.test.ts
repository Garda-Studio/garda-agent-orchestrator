import { afterEach, beforeEach, describe, it, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { isolateTestRunnerEnvironment } from '../../process-environment-fixtures';

beforeEach((context) => (context as TestContext).after(isolateTestRunnerEnvironment()));

import { EXIT_GATE_FAILURE } from '../../../../src/cli/exit-codes';
import { UNCONFIGURED_FULL_SUITE_VALIDATION_COMMAND } from '../../../../src/core/constants';
import {
    loadFullSuiteValidationConfig,
    recordFullSuiteValidationDuration,
    resolveFullSuiteDurationHistoryPath
} from '../../../../src/gates/full-suite/full-suite-validation';
import { getCurrentWorkflowConfigFileHashes } from '../../../../src/gates/workflow-config/workflow-config-work';
import { buildTaskModeArtifact } from '../../../../src/gates/task-mode';
import {
    runCliWithCapturedOutput,
    writeCompilePassEvidence
} from '../../cli/commands/gate-test-helpers';
import {
    classifyChange,
    getClassificationConfig
} from '../../../../src/gates/preflight/classify-change';
import {
    resolveFullSuiteValidationRunMarkerPath
} from '../../../../src/gates/full-suite/full-suite-validation-run-marker';

function writeFullSuitePreflight(
    repoRoot: string,
    preflightPath: string,
    preflight: Record<string, unknown>,
    options: { seedCompileEvidence?: boolean } = {}
): void {
    fs.writeFileSync(preflightPath, JSON.stringify(preflight), 'utf8');
    const taskId = String(preflight.task_id || '').trim();
    if (taskId) {
        writeFullSuiteTaskModeBaseline(repoRoot, taskId);
        if (options.seedCompileEvidence !== false) {
            writeCompilePassEvidence(repoRoot, taskId, preflightPath);
        }
    }
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
    describe('CLI integration', { concurrency: false, timeout: 15 * 60_000 }, () => {
        afterEach(() => {
            process.exitCode = undefined;
        });

        it('gate full-suite-validation prints SKIPPED and writes JSON artifact when disabled', async () => {
            const repoRoot = path.resolve(process.cwd());
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-fsv-cli-skip-'));
            const reviewsDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'reviews');
            const eventsDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'task-events');
            fs.mkdirSync(reviewsDir, { recursive: true });
            fs.mkdirSync(eventsDir, { recursive: true });
            const preflightPath = path.join(reviewsDir, 'T-SKIP-preflight.json');
            writeFullSuitePreflight(tempDir, preflightPath, {
                task_id: 'T-SKIP',
                changed_files: ['src/changed.ts']
            }, { seedCompileEvidence: false });

            const result = await runCliWithCapturedOutput([
                'gate', 'full-suite-validation',
                '--task-id', 'T-SKIP',
                '--preflight-path', preflightPath,
                '--repo-root', tempDir
            ], { cwd: repoRoot });

            assert.equal(result.exitCode, 0, result.errors.join('\n'));
            const artifactPath = path.join(reviewsDir, 'T-SKIP-full-suite-validation.json');
            assert.ok(fs.existsSync(artifactPath));
            const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
            assert.equal(artifact.status, 'SKIPPED');
            assert.equal(artifact.cycle_binding.task_id, 'T-SKIP');
            const timelinePath = path.join(eventsDir, 'T-SKIP.jsonl');
            assert.ok(fs.existsSync(timelinePath));
            const timeline = fs.readFileSync(timelinePath, 'utf8');
            assert.match(timeline, /"event_type":"FULL_SUITE_VALIDATION_SKIPPED"/);
            fs.rmSync(tempDir, { recursive: true, force: true });
        });

        it('gate full-suite-validation records NOT_REQUIRED for enabled docs-only scopes without running the command', async () => {
            const repoRoot = path.resolve(process.cwd());
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-fsv-cli-docs-skip-'));
            const configDir = path.join(tempDir, 'garda-agent-orchestrator', 'live', 'config');
            const reviewsDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'reviews');
            const eventsDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'task-events');
            fs.mkdirSync(configDir, { recursive: true });
            fs.mkdirSync(reviewsDir, { recursive: true });
            fs.mkdirSync(eventsDir, { recursive: true });
            fs.writeFileSync(path.join(configDir, 'workflow-config.json'), JSON.stringify({
                full_suite_validation: {
                    enabled: true,
                    command: `"${process.execPath.replace(/\\/g, '/')}" -e "process.exit(9)"`,
                    timeout_ms: 30000
                }
            }), 'utf8');
            const preflightPath = path.join(reviewsDir, 'T-DOCS-SKIP-preflight.json');
            writeFullSuitePreflight(tempDir, preflightPath, {
                task_id: 'T-DOCS-SKIP',
                scope_category: 'docs-only',
                changed_files: ['docs/runbook.md'],
                triggers: {
                    runtime_code_changed: false,
                    test: false,
                    db: false,
                    security: false,
                    api: false,
                    performance: false,
                    infra: false,
                    dependency: false,
                    refactor: false
                },
                required_reviews: {}
            }, { seedCompileEvidence: false });

            const result = await runCliWithCapturedOutput([
                'gate', 'full-suite-validation',
                '--task-id', 'T-DOCS-SKIP',
                '--preflight-path', preflightPath,
                '--repo-root', tempDir
            ], { cwd: repoRoot });

            assert.equal(result.exitCode, 0, result.errors.join('\n'));
            const artifactPath = path.join(reviewsDir, 'T-DOCS-SKIP-full-suite-validation.json');
            const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
            assert.equal(artifact.status, 'SKIPPED');
            assert.equal(artifact.enabled, true);
            assert.equal(artifact.required, false);
            assert.equal(artifact.skip_reason, 'DOCS_ONLY_SCOPE_NOT_REQUIRED');
            const timeline = fs.readFileSync(path.join(eventsDir, 'T-DOCS-SKIP.jsonl'), 'utf8');
            assert.match(timeline, /"event_type":"FULL_SUITE_VALIDATION_SKIPPED"/);
            fs.rmSync(tempDir, { recursive: true, force: true });
        });

        it('gate full-suite-validation records NOT_REQUIRED for preflight-classified security-sensitive docs-only scopes', async () => {
            const repoRoot = path.resolve(process.cwd());
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-fsv-cli-security-docs-skip-'));
            const configDir = path.join(tempDir, 'garda-agent-orchestrator', 'live', 'config');
            const reviewsDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'reviews');
            const eventsDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'task-events');
            fs.mkdirSync(configDir, { recursive: true });
            fs.mkdirSync(reviewsDir, { recursive: true });
            fs.mkdirSync(eventsDir, { recursive: true });
            fs.writeFileSync(path.join(configDir, 'workflow-config.json'), JSON.stringify({
                full_suite_validation: {
                    enabled: true,
                    command: `"${process.execPath.replace(/\\/g, '/')}" -e "process.exit(9)"`,
                    timeout_ms: 30000
                }
            }), 'utf8');

            const taskId = 'T-SECURITY-DOCS-SKIP';
            const classification = classifyChange({
                normalizedFiles: ['docs/security.md'],
                taskIntent: 'Update security support wording',
                changedLinesTotal: 4,
                additionsTotal: 4,
                deletionsTotal: 0,
                renameCount: 0,
                detectionSource: 'explicit_changed_files',
                classificationConfig: getClassificationConfig(tempDir),
                reviewCapabilities: {
                    code: true,
                    db: true,
                    security: true,
                    refactor: true,
                    api: true,
                    test: true,
                    performance: true,
                    infra: true,
                    dependency: true
                }
            });
            assert.equal(classification.scope_category, 'docs-only');
            assert.equal(classification.required_reviews.security, true);
            assert.equal(classification.required_reviews.code, false);
            assert.equal(classification.required_reviews.refactor, false);
            assert.equal(classification.required_reviews.test, false);

            const preflightPath = path.join(reviewsDir, `${taskId}-preflight.json`);
            writeFullSuitePreflight(tempDir, preflightPath, {
                ...classification,
                task_id: taskId
            }, { seedCompileEvidence: false });

            const result = await runCliWithCapturedOutput([
                'gate', 'full-suite-validation',
                '--task-id', taskId,
                '--preflight-path', preflightPath,
                '--repo-root', tempDir
            ], { cwd: repoRoot });

            assert.equal(result.exitCode, 0, result.errors.join('\n'));
            const artifactPath = path.join(reviewsDir, `${taskId}-full-suite-validation.json`);
            const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
            assert.equal(artifact.status, 'SKIPPED');
            assert.equal(artifact.required, false);
            assert.equal(artifact.skip_reason, 'DOCS_ONLY_SCOPE_NOT_REQUIRED');
            const timeline = fs.readFileSync(path.join(eventsDir, `${taskId}.jsonl`), 'utf8');
            assert.match(timeline, /"event_type":"FULL_SUITE_VALIDATION_SKIPPED"/);
            fs.rmSync(tempDir, { recursive: true, force: true });
        });

        it('gate full-suite-validation exits 0 for WARNED under AUDIT_AND_WARN', async () => {
            const repoRoot = path.resolve(process.cwd());
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-fsv-cli-warn-'));
            const configDir = path.join(tempDir, 'garda-agent-orchestrator', 'live', 'config');
            const reviewsDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'reviews');
            const eventsDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'task-events');
            fs.mkdirSync(configDir, { recursive: true });
            fs.mkdirSync(reviewsDir, { recursive: true });
            fs.mkdirSync(eventsDir, { recursive: true });

            const helperScript = path.join(tempDir, 'fail-unrelated.js');
            fs.writeFileSync(
                helperScript,
                [
                    'process.stdout.write("FAIL at src/unrelated.ts:5 detail\\n");',
                    'for (let index = 0; index < 40; index += 1) {',
                    '  process.stdout.write(`warn-path verbose detail ${index} that should be compacted away\\n`);',
                    '}',
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
                    red_failure_chunk_lines: 10,
                    out_of_scope_failure_policy: 'AUDIT_AND_WARN'
                }
            }), 'utf8');

            const preflightPath = path.join(reviewsDir, 'T-WARN-preflight.json');
            writeFullSuitePreflight(tempDir, preflightPath, {
                task_id: 'T-WARN',
                changed_files: ['src/changed.ts']
            });

            const result = await runCliWithCapturedOutput([
                'gate', 'full-suite-validation',
                '--task-id', 'T-WARN',
                '--preflight-path', preflightPath,
                '--repo-root', tempDir
            ], { cwd: repoRoot });

            assert.equal(result.exitCode, 0, `stdout=${result.logs.join('\n')}\nstderr=${result.errors.join('\n')}`);
            const artifactPath = path.join(reviewsDir, 'T-WARN-full-suite-validation.json');
            assert.ok(fs.existsSync(artifactPath));
            const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
            assert.equal(artifact.status, 'WARNED');
            assert.equal(artifact.out_of_scope_audit_verdict, 'WARNED');
            assert.equal(artifact.cycle_binding.task_id, 'T-WARN');
            assert.ok(artifact.output_telemetry);
            assert.ok(Number.isFinite(Number(artifact.output_telemetry.estimated_saved_tokens)));
            const outputArtifactPath = path.join(reviewsDir, 'T-WARN-full-suite-output.log');
            assert.equal(String(artifact.output_artifact_path).replace(/\\/g, '/'), outputArtifactPath.replace(/\\/g, '/'));
            assert.equal(artifact.output_retention.raw_output_retained, true);
            assert.equal(artifact.output_retention.retention_reason, 'FULL_OUTPUT_RETAINED');
            assert.equal(fs.existsSync(outputArtifactPath), true);
            const timelinePath = path.join(eventsDir, 'T-WARN.jsonl');
            assert.ok(fs.existsSync(timelinePath));
            const timeline = fs.readFileSync(timelinePath, 'utf8');
            assert.match(timeline, /"event_type":"FULL_SUITE_VALIDATION_WARNED"/);
            assert.match(timeline, /"retention_reason":"FULL_OUTPUT_RETAINED"/);
            assert.match(timeline, /"output_telemetry":\{/);
            fs.rmSync(tempDir, { recursive: true, force: true });
        });

        it('gate full-suite-validation records FULL_SUITE_VALIDATION_PASSED for an enabled successful run', async () => {
            const repoRoot = path.resolve(process.cwd());
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-fsv-cli-pass-'));
            const configDir = path.join(tempDir, 'garda-agent-orchestrator', 'live', 'config');
            const reviewsDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'reviews');
            const eventsDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'task-events');
            fs.mkdirSync(configDir, { recursive: true });
            fs.mkdirSync(reviewsDir, { recursive: true });
            fs.mkdirSync(eventsDir, { recursive: true });

            const helperScript = path.join(tempDir, 'pass.js');
            fs.writeFileSync(
                helperScript,
                [
                    'for (let index = 0; index < 40; index += 1) {',
                    '  process.stdout.write(`detail line ${index} with verbose raw output that should not survive compaction\\n`);',
                    '}',
                    'process.stdout.write("ACCESS_TOKEN=full-suite-secret-value\\n");',
                    'process.stdout.write("API_TOKEN=\\"full suite line one\\nfull suite line two\\"\\n");',
                    'process.stdout.write("# tests 20\\n# pass 20\\n# fail 0\\n# duration_ms 1234\\n");',
                    'process.exit(0);'
                ].join('\n'),
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

            const preflightPath = path.join(reviewsDir, 'T-PASS-preflight.json');
            writeFullSuitePreflight(tempDir, preflightPath, {
                task_id: 'T-PASS',
                changed_files: ['src/changed.ts']
            });

            const result = await runCliWithCapturedOutput([
                'gate', 'full-suite-validation',
                '--task-id', 'T-PASS',
                '--preflight-path', preflightPath,
                '--repo-root', tempDir
            ], { cwd: repoRoot });

            assert.equal(result.exitCode, 0, `stdout=${result.logs.join('\n')}\nstderr=${result.errors.join('\n')}`);
            const artifactPath = path.join(reviewsDir, 'T-PASS-full-suite-validation.json');
            assert.ok(fs.existsSync(artifactPath));
            const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
            assert.equal(artifact.status, 'PASSED');
            assert.deepEqual(artifact.command_provenance, {
                schema_version: 1,
                source: 'workflow_config.full_suite_validation.command',
                execution_mode: 'DIRECT_ARGV',
                validation_status: 'PASSED',
                rejection_reason: null,
                detected_syntax: null
            });
            assert.equal(typeof artifact.duration_ms, 'number');
            assert.equal(artifact.timeout_forecast.recommendation_source, 'history');
            assert.ok(artifact.output_telemetry);
            assert.ok(Number(artifact.output_telemetry.estimated_saved_tokens) > 0);
            const outputArtifactPath = path.join(reviewsDir, 'T-PASS-full-suite-output.log');
            assert.equal(fs.existsSync(outputArtifactPath), false);
            assert.equal(artifact.output_artifact_path, null);
            assert.equal(artifact.output_retention.raw_output_retained, false);
            assert.equal(artifact.output_retention.retention_reason, 'SUCCESS_LOG_OMITTED');
            assert.equal(typeof artifact.output_retention.raw_output_sha256, 'string');
            assert.ok(!fs.readFileSync(artifactPath, 'utf8').includes('full-suite-secret-value'));
            assert.ok(!fs.readFileSync(artifactPath, 'utf8').includes('full suite line one'));
            assert.ok(!fs.readFileSync(artifactPath, 'utf8').includes('full suite line two'));
            const latestPointerPath = path.join(
                tempDir,
                'garda-agent-orchestrator',
                'runtime',
                'metrics',
                'full-suite-validation-latest.json'
            );
            assert.ok(fs.existsSync(latestPointerPath));
            const latestPointer = JSON.parse(fs.readFileSync(latestPointerPath, 'utf8'));
            assert.equal(latestPointer.schema_version, 1);
            assert.equal(latestPointer.task_id, 'T-PASS');
            assert.equal(latestPointer.status, 'PASSED');
            assert.equal(String(latestPointer.artifact_path).replace(/\\/g, '/'), artifactPath.replace(/\\/g, '/'));
            assert.equal(typeof latestPointer.artifact_sha256, 'string');
            const timelinePath = path.join(eventsDir, 'T-PASS.jsonl');
            assert.ok(fs.existsSync(timelinePath));
            const timeline = fs.readFileSync(timelinePath, 'utf8');
            assert.match(timeline, /"event_type":"FULL_SUITE_VALIDATION_PASSED"/);
            assert.match(timeline, /"output_telemetry":\{/);
            assert.match(timeline, /"retention_reason":"SUCCESS_LOG_OMITTED"/);
            fs.rmSync(tempDir, { recursive: true, force: true });
        });

        it('rejects mutable preflight workflow-config hashes without task-mode baseline evidence', async () => {
            const repoRoot = path.resolve(process.cwd());
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-fsv-cli-preflight-baseline-'));
            const configDir = path.join(tempDir, 'garda-agent-orchestrator', 'live', 'config');
            const reviewsDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'reviews');
            fs.mkdirSync(configDir, { recursive: true });
            fs.mkdirSync(reviewsDir, { recursive: true });

            const helperScript = path.join(tempDir, 'pass.js');
            fs.writeFileSync(helperScript, 'process.stdout.write("all good\\n"); process.exit(0);', 'utf8');
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

            const preflightPath = path.join(reviewsDir, 'T-PREFLIGHT-BASELINE-preflight.json');
            fs.writeFileSync(preflightPath, JSON.stringify({
                task_id: 'T-PREFLIGHT-BASELINE',
                changed_files: ['src/changed.ts'],
                triggers: {
                    workflow_config_file_hashes: getCurrentWorkflowConfigFileHashes(tempDir)
                }
            }), 'utf8');

            const result = await runCliWithCapturedOutput([
                'gate', 'full-suite-validation',
                '--task-id', 'T-PREFLIGHT-BASELINE',
                '--preflight-path', preflightPath,
                '--repo-root', tempDir
            ], { cwd: repoRoot });

            assert.equal(result.exitCode, EXIT_GATE_FAILURE, `stdout=${result.logs.join('\n')}\nstderr=${result.errors.join('\n')}`);
            const artifactPath = path.join(reviewsDir, 'T-PREFLIGHT-BASELINE-full-suite-validation.json');
            const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
            assert.equal(artifact.status, 'FAILED');
            assert.ok(artifact.violations.some((line: string) => line.includes('baseline hashes are missing')));
            fs.rmSync(tempDir, { recursive: true, force: true });
        });

        it('records duration history for failed post-run workflow-config guard violations', async () => {
            const repoRoot = path.resolve(process.cwd());
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-fsv-cli-post-workflow-config-'));
            const configDir = path.join(tempDir, 'garda-agent-orchestrator', 'live', 'config');
            const reviewsDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'reviews');
            fs.mkdirSync(configDir, { recursive: true });
            fs.mkdirSync(reviewsDir, { recursive: true });

            const helperScript = path.join(tempDir, 'mutate-workflow-config.js');
            const workflowConfigPath = path.join(configDir, 'workflow-config.json');
            fs.writeFileSync(
                helperScript,
                [
                    'const fs = require("node:fs");',
                    'fs.appendFileSync(process.argv[2], "\\n", "utf8");',
                    'process.stdout.write("# tests 1\\n# pass 1\\n# fail 0\\n# duration_ms 1\\n");',
                    'process.exit(0);'
                ].join('\n'),
                'utf8'
            );
            fs.writeFileSync(workflowConfigPath, JSON.stringify({
                full_suite_validation: {
                    enabled: true,
                    command: `"${process.execPath.replace(/\\/g, '/')}" "${helperScript.replace(/\\/g, '/')}" "${workflowConfigPath.replace(/\\/g, '/')}"`,
                    timeout_ms: 30000,
                    green_summary_max_lines: 5,
                    red_failure_chunk_lines: 50,
                    out_of_scope_failure_policy: 'AUDIT_AND_BLOCK'
                }
            }), 'utf8');

            const preflightPath = path.join(reviewsDir, 'T-POST-WORKFLOW-CONFIG-preflight.json');
            writeFullSuitePreflight(tempDir, preflightPath, {
                task_id: 'T-POST-WORKFLOW-CONFIG',
                changed_files: ['src/changed.ts'],
                triggers: {
                    workflow_config_file_hashes: getCurrentWorkflowConfigFileHashes(tempDir)
                }
            });

            const result = await runCliWithCapturedOutput([
                'gate', 'full-suite-validation',
                '--task-id', 'T-POST-WORKFLOW-CONFIG',
                '--preflight-path', preflightPath,
                '--repo-root', tempDir
            ], { cwd: repoRoot });

            assert.equal(result.exitCode, EXIT_GATE_FAILURE, `stdout=${result.logs.join('\n')}\nstderr=${result.errors.join('\n')}`);
            const artifactPath = path.join(reviewsDir, 'T-POST-WORKFLOW-CONFIG-full-suite-validation.json');
            const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
            assert.equal(artifact.status, 'FAILED');
            assert.equal(typeof artifact.duration_ms, 'number');
            assert.equal(artifact.timeout_forecast.recommendation_source, 'config_timeout');
            const durationHistory = JSON.parse(
                fs.readFileSync(resolveFullSuiteDurationHistoryPath(tempDir), 'utf8')
            ) as {
                entries: Array<{
                    task_id: string;
                    status: string;
                    forecast_sample_eligible: boolean;
                    forecast_exclusion_reason: string;
                }>;
            };
            assert.deepEqual(
                durationHistory.entries.map((entry) => ({
                    task_id: entry.task_id,
                    status: entry.status,
                    forecast_sample_eligible: entry.forecast_sample_eligible,
                    forecast_exclusion_reason: entry.forecast_exclusion_reason
                })),
                [{
                    task_id: 'T-POST-WORKFLOW-CONFIG',
                    status: 'FAILED',
                    forecast_sample_eligible: false,
                    forecast_exclusion_reason: 'non_passing_status'
                }]
            );
            assert.ok(artifact.violations.some((line: string) => line.includes('Workflow config')));
            fs.rmSync(tempDir, { recursive: true, force: true });
        });

        it('gate full-suite-validation preserves execution provider env for the test subprocess', async () => {
            const repoRoot = path.resolve(process.cwd());
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-fsv-cli-env-'));
            const configDir = path.join(tempDir, 'garda-agent-orchestrator', 'live', 'config');
            const reviewsDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'reviews');
            const eventsDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'task-events');
            fs.mkdirSync(configDir, { recursive: true });
            fs.mkdirSync(reviewsDir, { recursive: true });
            fs.mkdirSync(eventsDir, { recursive: true });

            const helperScript = path.join(tempDir, 'env-pass.js');
            const envReportPath = path.join(tempDir, 'env-report.json');
            fs.writeFileSync(
                helperScript,
                [
                    'const fs = require("node:fs");',
                    'fs.writeFileSync(process.argv[2], JSON.stringify({',
                    '  executionProvider: process.env.GARDA_EXECUTION_PROVIDER ?? null',
                    '}, null, 2) + "\\n", "utf8");',
                    'if (process.env.GARDA_EXECUTION_PROVIDER !== "Codex") process.exit(42);',
                    'process.stdout.write("# tests 1\\n# pass 1\\n# fail 0\\n# duration_ms 1\\n");',
                    'process.exit(0);'
                ].join('\n'),
                'utf8'
            );
            fs.writeFileSync(path.join(configDir, 'workflow-config.json'), JSON.stringify({
                full_suite_validation: {
                    enabled: true,
                    command: `"${process.execPath.replace(/\\/g, '/')}" "${helperScript.replace(/\\/g, '/')}" "${envReportPath.replace(/\\/g, '/')}"`,
                    timeout_ms: 30000,
                    green_summary_max_lines: 5,
                    red_failure_chunk_lines: 50,
                    out_of_scope_failure_policy: 'AUDIT_AND_BLOCK'
                }
            }), 'utf8');

            const preflightPath = path.join(reviewsDir, 'T-ENV-PASS-preflight.json');
            writeFullSuitePreflight(tempDir, preflightPath, {
                task_id: 'T-ENV-PASS',
                changed_files: ['src/changed.ts']
            });

            const previousExecutionProvider = process.env.GARDA_EXECUTION_PROVIDER;
            process.env.GARDA_EXECUTION_PROVIDER = 'Codex';
            try {
                const result = await runCliWithCapturedOutput([
                    'gate', 'full-suite-validation',
                    '--task-id', 'T-ENV-PASS',
                    '--preflight-path', preflightPath,
                    '--repo-root', tempDir
                ], { cwd: repoRoot });

                assert.equal(result.exitCode, 0, `stdout=${result.logs.join('\n')}\nstderr=${result.errors.join('\n')}`);
                const artifactPath = path.join(reviewsDir, 'T-ENV-PASS-full-suite-validation.json');
                const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
                assert.equal(artifact.status, 'PASSED');
                const envReport = JSON.parse(fs.readFileSync(envReportPath, 'utf8'));
                assert.equal(envReport.executionProvider, 'Codex');
            } finally {
                if (previousExecutionProvider == null) {
                    delete process.env.GARDA_EXECUTION_PROVIDER;
                } else {
                    process.env.GARDA_EXECUTION_PROVIDER = previousExecutionProvider;
                }
                fs.rmSync(tempDir, { recursive: true, force: true });
            }
        });

        it('gate full-suite-validation still fails real subprocess test failures after env sanitization', async () => {
            const repoRoot = path.resolve(process.cwd());
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-fsv-cli-env-fail-'));
            const configDir = path.join(tempDir, 'garda-agent-orchestrator', 'live', 'config');
            const reviewsDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'reviews');
            const eventsDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'task-events');
            fs.mkdirSync(configDir, { recursive: true });
            fs.mkdirSync(reviewsDir, { recursive: true });
            fs.mkdirSync(eventsDir, { recursive: true });

            const helperScript = path.join(tempDir, 'env-fail.js');
            fs.writeFileSync(
                helperScript,
                [
                    'process.stdout.write("not ok 1 - failed at src/changed.ts:1\\n");',
                    'process.exit(13);'
                ].join('\n'),
                'utf8'
            );
            fs.writeFileSync(path.join(configDir, 'workflow-config.json'), JSON.stringify({
                full_suite_validation: {
                    enabled: true,
                    command: `"${process.execPath.replace(/\\/g, '/')}" "${helperScript.replace(/\\/g, '/')}"`,
                    timeout_ms: 30000,
                    green_summary_max_lines: 5,
                    red_failure_chunk_lines: 10,
                    out_of_scope_failure_policy: 'AUDIT_AND_BLOCK'
                }
            }), 'utf8');

            const preflightPath = path.join(reviewsDir, 'T-ENV-FAIL-preflight.json');
            writeFullSuitePreflight(tempDir, preflightPath, {
                task_id: 'T-ENV-FAIL',
                changed_files: ['src/changed.ts']
            });

            try {
                const result = await runCliWithCapturedOutput([
                    'gate', 'full-suite-validation',
                    '--task-id', 'T-ENV-FAIL',
                    '--preflight-path', preflightPath,
                    '--repo-root', tempDir
                ], { cwd: repoRoot });

                assert.equal(result.exitCode, EXIT_GATE_FAILURE, `stdout=${result.logs.join('\n')}\nstderr=${result.errors.join('\n')}`);
                const artifactPath = path.join(reviewsDir, 'T-ENV-FAIL-full-suite-validation.json');
                const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
                assert.equal(artifact.status, 'FAILED');
                assert.equal(artifact.exit_code, 13);
            } finally {
                fs.rmSync(tempDir, { recursive: true, force: true });
            }
        });

        it('gate full-suite-validation streams over 1 MiB stdout without maxBuffer failure', async () => {
            const repoRoot = path.resolve(process.cwd());
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-fsv-cli-large-output-'));
            const configDir = path.join(tempDir, 'garda-agent-orchestrator', 'live', 'config');
            const reviewsDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'reviews');
            const eventsDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'task-events');
            fs.mkdirSync(configDir, { recursive: true });
            fs.mkdirSync(reviewsDir, { recursive: true });
            fs.mkdirSync(eventsDir, { recursive: true });

            const helperScript = path.join(tempDir, 'large-pass.js');
            fs.writeFileSync(
                helperScript,
                [
                    'const fs = require("node:fs");',
                    'const chunk = "x".repeat(64 * 1024);',
                    'for (let index = 0; index < 17; index += 1) {',
                    '  fs.writeSync(1, `${chunk}\\n`);',
                    '}',
                    'fs.writeSync(1, "# tests 1\\n# pass 1\\n# fail 0\\n# duration_ms 1\\n");',
                    'process.exit(0);'
                ].join('\n'),
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

            const preflightPath = path.join(reviewsDir, 'T-LARGE-PASS-preflight.json');
            writeFullSuitePreflight(tempDir, preflightPath, {
                task_id: 'T-LARGE-PASS',
                changed_files: ['src/changed.ts']
            });

            const result = await runCliWithCapturedOutput([
                'gate', 'full-suite-validation',
                '--task-id', 'T-LARGE-PASS',
                '--preflight-path', preflightPath,
                '--repo-root', tempDir
            ], { cwd: repoRoot });

            assert.equal(result.exitCode, 0, `stdout=${result.logs.join('\n')}\nstderr=${result.errors.join('\n')}`);
            const artifactPath = path.join(reviewsDir, 'T-LARGE-PASS-full-suite-validation.json');
            assert.ok(fs.existsSync(artifactPath));
            const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
            assert.equal(artifact.status, 'PASSED');
            assert.equal(artifact.exit_code, 0);
            assert.equal(artifact.timed_out, false);
            assert.ok(artifact.compact_summary.some((line: string) => line.includes('# pass 1')));
            assert.ok(Number(artifact.output_telemetry.estimated_saved_tokens) > 0);
            assert.equal(artifact.output_artifact_path, null);
            assert.equal(artifact.output_retention.raw_output_retained, false);
            assert.equal(artifact.output_retention.retention_reason, 'SUCCESS_LOG_OMITTED');
            assert.ok(Number(artifact.output_retention.raw_output_char_count) > 1024 * 1024);
            const timelinePath = path.join(eventsDir, 'T-LARGE-PASS.jsonl');
            const timeline = fs.readFileSync(timelinePath, 'utf8');
            assert.match(timeline, /"event_type":"FULL_SUITE_VALIDATION_PASSED"/);
            assert.match(timeline, /"retention_reason":"SUCCESS_LOG_OMITTED"/);
            fs.rmSync(tempDir, { recursive: true, force: true });
        });

        it('gate full-suite-validation reports real command failure after over 1 MiB stdout', async () => {
            const repoRoot = path.resolve(process.cwd());
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-fsv-cli-large-fail-'));
            const configDir = path.join(tempDir, 'garda-agent-orchestrator', 'live', 'config');
            const reviewsDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'reviews');
            const eventsDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'task-events');
            fs.mkdirSync(configDir, { recursive: true });
            fs.mkdirSync(reviewsDir, { recursive: true });
            fs.mkdirSync(eventsDir, { recursive: true });

            const helperScript = path.join(tempDir, 'large-fail.js');
            fs.writeFileSync(
                helperScript,
                [
                    'const fs = require("node:fs");',
                    'fs.writeSync(1, "not ok 1 - failed at src/changed.ts:1\\n");',
                    'for (let index = 0; index < 70000; index += 1) {',
                    '  fs.writeSync(1, `verbose detail line ${index}\\n`);',
                    '}',
                    'process.exit(7);'
                ].join('\n'),
                'utf8'
            );
            fs.writeFileSync(path.join(configDir, 'workflow-config.json'), JSON.stringify({
                full_suite_validation: {
                    enabled: true,
                    command: `"${process.execPath.replace(/\\/g, '/')}" "${helperScript.replace(/\\/g, '/')}"`,
                    timeout_ms: 30000,
                    green_summary_max_lines: 5,
                    red_failure_chunk_lines: 10,
                    out_of_scope_failure_policy: 'AUDIT_AND_BLOCK'
                }
            }), 'utf8');

            const preflightPath = path.join(reviewsDir, 'T-LARGE-FAIL-preflight.json');
            writeFullSuitePreflight(tempDir, preflightPath, {
                task_id: 'T-LARGE-FAIL',
                changed_files: ['src/changed.ts']
            });

            const result = await runCliWithCapturedOutput([
                'gate', 'full-suite-validation',
                '--task-id', 'T-LARGE-FAIL',
                '--preflight-path', preflightPath,
                '--repo-root', tempDir
            ], { cwd: repoRoot });

            assert.equal(result.exitCode, EXIT_GATE_FAILURE, `stdout=${result.logs.join('\n')}\nstderr=${result.errors.join('\n')}`);
            const artifactPath = path.join(reviewsDir, 'T-LARGE-FAIL-full-suite-validation.json');
            assert.ok(fs.existsSync(artifactPath));
            const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
            assert.equal(artifact.status, 'FAILED');
            assert.equal(artifact.exit_code, 7);
            assert.equal(artifact.timed_out, false);
            assert.ok(artifact.violations.some((line: string) => line.includes('exit code 7')));

            const outputArtifactPath = path.join(reviewsDir, 'T-LARGE-FAIL-full-suite-output.log');
            assert.equal(String(artifact.output_artifact_path).replace(/\\/g, '/'), outputArtifactPath.replace(/\\/g, '/'));
            assert.equal(artifact.output_retention.raw_output_retained, true);
            assert.equal(artifact.output_retention.retention_reason, 'FULL_OUTPUT_RETAINED');
            assert.ok(fs.statSync(outputArtifactPath).size > 1024 * 1024);
            const timelinePath = path.join(eventsDir, 'T-LARGE-FAIL.jsonl');
            const timeline = fs.readFileSync(timelinePath, 'utf8');
            assert.match(timeline, /"event_type":"FULL_SUITE_VALIDATION_FAILED"/);
            assert.match(timeline, /"retention_reason":"FULL_OUTPUT_RETAINED"/);
            fs.rmSync(tempDir, { recursive: true, force: true });
        });

        it('keeps the canonical artifact and task timeline when only aggregate append warns after FULL_SUITE_VALIDATION_PASSED', async () => {
            const repoRoot = path.resolve(process.cwd());
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-fsv-cli-pass-aggregate-warning-'));
            const configDir = path.join(tempDir, 'garda-agent-orchestrator', 'live', 'config');
            const reviewsDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'reviews');
            const eventsDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'task-events');
            const aggregatePath = path.join(eventsDir, 'all-tasks.jsonl');
            fs.mkdirSync(configDir, { recursive: true });
            fs.mkdirSync(reviewsDir, { recursive: true });
            fs.mkdirSync(eventsDir, { recursive: true });

            const helperScript = path.join(tempDir, 'pass-aggregate-warning.js');
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

            const preflightPath = path.join(reviewsDir, 'T-PASS-AGGREGATE-preflight.json');
            writeFullSuitePreflight(tempDir, preflightPath, {
                task_id: 'T-PASS-AGGREGATE',
                changed_files: ['src/changed.ts']
            });

            const fsModule = require('node:fs') as typeof import('node:fs');
            const originalAppendFileSync = fsModule.appendFileSync;
            let injectedAggregateFailure = false;
            try {
                fsModule.appendFileSync = ((filePath: fs.PathOrFileDescriptor, data: string | Uint8Array, options?: fs.WriteFileOptions) => {
                    const normalizedPath = typeof filePath === 'string' ? path.resolve(filePath) : '';
                    const payload = typeof data === 'string' ? data : '';
                    if (
                        !injectedAggregateFailure
                        && normalizedPath === path.resolve(aggregatePath)
                        && payload.includes('"event_type":"FULL_SUITE_VALIDATION_PASSED"')
                    ) {
                        injectedAggregateFailure = true;
                        throw new Error('Injected aggregate append failure');
                    }
                    return originalAppendFileSync(filePath, data, options);
                }) as typeof fsModule.appendFileSync;

                const result = await runCliWithCapturedOutput([
                    'gate', 'full-suite-validation',
                    '--task-id', 'T-PASS-AGGREGATE',
                    '--preflight-path', preflightPath,
                    '--repo-root', tempDir
                ], { cwd: repoRoot });

                assert.equal(result.exitCode, 0, `stdout=${result.logs.join('\n')}\nstderr=${result.errors.join('\n')}`);
                assert.equal(injectedAggregateFailure, true);
                const artifactPath = path.join(reviewsDir, 'T-PASS-AGGREGATE-full-suite-validation.json');
                assert.ok(fs.existsSync(artifactPath));
                const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
                assert.equal(artifact.status, 'PASSED');
                const timelinePath = path.join(eventsDir, 'T-PASS-AGGREGATE.jsonl');
                assert.ok(fs.existsSync(timelinePath));
                const timeline = fs.readFileSync(timelinePath, 'utf8');
                assert.match(timeline, /"event_type":"FULL_SUITE_VALIDATION_PASSED"/);
            } finally {
                fsModule.appendFileSync = originalAppendFileSync;
                fs.rmSync(tempDir, { recursive: true, force: true });
            }
        });

        it('gate full-suite-validation fails clearly when enabled but the command is still unconfigured', async () => {
            const repoRoot = path.resolve(process.cwd());
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-fsv-cli-unconfigured-'));
            const configDir = path.join(tempDir, 'garda-agent-orchestrator', 'live', 'config');
            const reviewsDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'reviews');
            const eventsDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'task-events');
            fs.mkdirSync(configDir, { recursive: true });
            fs.mkdirSync(reviewsDir, { recursive: true });
            fs.mkdirSync(eventsDir, { recursive: true });

            fs.writeFileSync(path.join(configDir, 'workflow-config.json'), JSON.stringify({
                full_suite_validation: {
                    enabled: true,
                    command: UNCONFIGURED_FULL_SUITE_VALIDATION_COMMAND,
                    timeout_ms: 30000,
                    green_summary_max_lines: 5,
                    red_failure_chunk_lines: 50,
                    out_of_scope_failure_policy: 'AUDIT_AND_BLOCK'
                }
            }), 'utf8');

            const preflightPath = path.join(reviewsDir, 'T-UNCONFIGURED-preflight.json');
            writeFullSuitePreflight(tempDir, preflightPath, {
                task_id: 'T-UNCONFIGURED',
                changed_files: ['src/changed.ts']
            });

            const result = await runCliWithCapturedOutput([
                'gate', 'full-suite-validation',
                '--task-id', 'T-UNCONFIGURED',
                '--preflight-path', preflightPath,
                '--repo-root', tempDir
            ], { cwd: repoRoot });

            assert.equal(result.exitCode, EXIT_GATE_FAILURE, `stdout=${result.logs.join('\n')}\nstderr=${result.errors.join('\n')}`);
            const artifactPath = path.join(reviewsDir, 'T-UNCONFIGURED-full-suite-validation.json');
            const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
            assert.equal(artifact.status, 'FAILED');
            assert.ok(artifact.violations.some((line: string) => line.includes('not configured')));
            const timelinePath = path.join(eventsDir, 'T-UNCONFIGURED.jsonl');
            assert.ok(fs.existsSync(timelinePath));
            const timeline = fs.readFileSync(timelinePath, 'utf8');
            assert.match(timeline, /"event_type":"FULL_SUITE_VALIDATION_FAILED"/);
            fs.rmSync(tempDir, { recursive: true, force: true });
        });

        it('rejects compound shell syntax before launch and records command provenance', async () => {
            const repoRoot = path.resolve(process.cwd());
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-fsv-cli-compound-command-'));
            const configDir = path.join(tempDir, 'garda-agent-orchestrator', 'live', 'config');
            const reviewsDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'reviews');
            const eventsDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'task-events');
            fs.mkdirSync(configDir, { recursive: true });
            fs.mkdirSync(reviewsDir, { recursive: true });
            fs.mkdirSync(eventsDir, { recursive: true });

            const firstScript = path.join(tempDir, 'first.js');
            const secondScript = path.join(tempDir, 'second.js');
            const sideEffectPath = path.join(tempDir, 'must-not-exist.txt');
            fs.writeFileSync(firstScript, `require('node:fs').writeFileSync(${JSON.stringify(sideEffectPath)}, 'first');`, 'utf8');
            fs.writeFileSync(secondScript, `require('node:fs').writeFileSync(${JSON.stringify(sideEffectPath)}, 'second');`, 'utf8');
            const command = [
                `"${process.execPath.replace(/\\/g, '/')}"`,
                `"${firstScript.replace(/\\/g, '/')}"`,
                '&&',
                `"${process.execPath.replace(/\\/g, '/')}"`,
                `"${secondScript.replace(/\\/g, '/')}"`
            ].join(' ');
            fs.writeFileSync(path.join(configDir, 'workflow-config.json'), JSON.stringify({
                full_suite_validation: {
                    enabled: true,
                    command,
                    timeout_ms: 30000,
                    green_summary_max_lines: 5,
                    red_failure_chunk_lines: 50,
                    out_of_scope_failure_policy: 'AUDIT_AND_BLOCK'
                }
            }), 'utf8');
            const preflightPath = path.join(reviewsDir, 'T-COMPOUND-preflight.json');
            writeFullSuitePreflight(tempDir, preflightPath, {
                task_id: 'T-COMPOUND',
                changed_files: ['src/changed.ts']
            });

            const result = await runCliWithCapturedOutput([
                'gate', 'full-suite-validation',
                '--task-id', 'T-COMPOUND',
                '--preflight-path', preflightPath,
                '--repo-root', tempDir
            ], { cwd: repoRoot });

            assert.equal(result.exitCode, EXIT_GATE_FAILURE, `stdout=${result.logs.join('\n')}\nstderr=${result.errors.join('\n')}`);
            assert.equal(fs.existsSync(sideEffectPath), false);
            assert.equal(fs.existsSync(resolveFullSuiteValidationRunMarkerPath(tempDir, 'T-COMPOUND')), false);
            const artifact = JSON.parse(
                fs.readFileSync(path.join(reviewsDir, 'T-COMPOUND-full-suite-validation.json'), 'utf8')
            );
            assert.equal(artifact.status, 'FAILED');
            assert.equal(artifact.command, command);
            assert.equal(artifact.exit_code, null);
            assert.deepEqual(artifact.command_provenance, {
                schema_version: 1,
                source: 'workflow_config.full_suite_validation.command',
                execution_mode: 'DIRECT_ARGV',
                validation_status: 'REJECTED',
                rejection_reason: 'SHELL_CONTROL_OPERATOR',
                detected_syntax: '&&'
            });
            assert.ok(artifact.violations.some((line: string) => line.includes('npm run <wrapper-script>')));
            fs.rmSync(tempDir, { recursive: true, force: true });
        });

        it('gate full-suite-validation uses forecast timeout when it exceeds configured timeout', async () => {
            const repoRoot = path.resolve(process.cwd());
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-fsv-cli-forecast-timeout-'));
            const configDir = path.join(tempDir, 'garda-agent-orchestrator', 'live', 'config');
            const reviewsDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'reviews');
            const eventsDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'task-events');
            fs.mkdirSync(configDir, { recursive: true });
            fs.mkdirSync(reviewsDir, { recursive: true });
            fs.mkdirSync(eventsDir, { recursive: true });

            const helperScript = path.join(tempDir, 'pass-after-configured-timeout.js');
            fs.writeFileSync(
                helperScript,
                [
                    'const buildScriptsTimeout = Number(process.env.GARDA_BUILD_SCRIPTS_PROCESS_TIMEOUT_MS);',
                    'if (!Number.isSafeInteger(buildScriptsTimeout) || buildScriptsTimeout <= 100) process.exit(41);',
                    'if (process.env.GARDA_NODE_FOUNDATION_TEST_SHARD_TIMEOUT_MS) process.exit(42);',
                    'setTimeout(() => { process.stdout.write(`forecast timeout pass ${buildScriptsTimeout}\\n`); process.exit(0); }, 250);'
                ].join('\n'),
                'utf8'
            );
            fs.writeFileSync(path.join(configDir, 'workflow-config.json'), JSON.stringify({
                full_suite_validation: {
                    enabled: true,
                    command: `"${process.execPath.replace(/\\/g, '/')}" "${helperScript.replace(/\\/g, '/')}"`,
                    timeout_ms: 100,
                    green_summary_max_lines: 5,
                    red_failure_chunk_lines: 10,
                    out_of_scope_failure_policy: 'AUDIT_AND_BLOCK',
                    placement: 'after_compile_before_reviews'
                }
            }), 'utf8');

            const config = loadFullSuiteValidationConfig(tempDir);
            recordFullSuiteValidationDuration(tempDir, config, {
                timestamp_utc: new Date().toISOString(),
                task_id: 'T-FORECAST-TIMEOUT-SEED',
                status: 'PASSED',
                duration_ms: 250,
                timed_out: false,
                exit_code: 0
            });

            const preflightPath = path.join(reviewsDir, 'T-FORECAST-TIMEOUT-preflight.json');
            writeFullSuitePreflight(tempDir, preflightPath, {
                task_id: 'T-FORECAST-TIMEOUT',
                changed_files: ['src/changed.ts']
            });

            const originalShardTimeout = process.env.GARDA_NODE_FOUNDATION_TEST_SHARD_TIMEOUT_MS;
            delete process.env.GARDA_NODE_FOUNDATION_TEST_SHARD_TIMEOUT_MS;
            let result: Awaited<ReturnType<typeof runCliWithCapturedOutput>>;
            try {
                result = await runCliWithCapturedOutput([
                    'gate', 'full-suite-validation',
                    '--task-id', 'T-FORECAST-TIMEOUT',
                    '--preflight-path', preflightPath,
                    '--repo-root', tempDir
                ], { cwd: repoRoot });
            } finally {
                if (originalShardTimeout === undefined) {
                    delete process.env.GARDA_NODE_FOUNDATION_TEST_SHARD_TIMEOUT_MS;
                } else {
                    process.env.GARDA_NODE_FOUNDATION_TEST_SHARD_TIMEOUT_MS = originalShardTimeout;
                }
            }

            assert.equal(result.exitCode, 0, `stdout=${result.logs.join('\n')}\nstderr=${result.errors.join('\n')}`);
            const artifactPath = path.join(reviewsDir, 'T-FORECAST-TIMEOUT-full-suite-validation.json');
            const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
            assert.equal(artifact.status, 'PASSED');
            assert.equal(artifact.timed_out, false);
            assert.ok(artifact.compact_summary.some((line: string) => line.includes('forecast timeout pass')));
            assert.equal(artifact.timeout_forecast.recommendation_source, 'history');
            assert.ok(artifact.timeout_forecast.recommended_timeout_seconds > 1);
            const history = fs.readFileSync(resolveFullSuiteDurationHistoryPath(tempDir), 'utf8');
            assert.match(history, /T-FORECAST-TIMEOUT/);
            fs.rmSync(tempDir, { recursive: true, force: true });
        });

        it('gate full-suite-validation preserves explicit shard idle timeout overrides', async () => {
            const repoRoot = path.resolve(process.cwd());
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-fsv-cli-shard-timeout-env-'));
            const configDir = path.join(tempDir, 'garda-agent-orchestrator', 'live', 'config');
            const reviewsDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'reviews');
            const eventsDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'task-events');
            fs.mkdirSync(configDir, { recursive: true });
            fs.mkdirSync(reviewsDir, { recursive: true });
            fs.mkdirSync(eventsDir, { recursive: true });

            const helperScript = path.join(tempDir, 'assert-shard-timeout-env.js');
            fs.writeFileSync(
                helperScript,
                [
                    'const buildScriptsTimeout = Number(process.env.GARDA_BUILD_SCRIPTS_PROCESS_TIMEOUT_MS);',
                    'const shardTimeout = Number(process.env.GARDA_NODE_FOUNDATION_TEST_SHARD_TIMEOUT_MS);',
                    'if (!Number.isSafeInteger(buildScriptsTimeout) || buildScriptsTimeout < 30000) process.exit(41);',
                    'if (shardTimeout !== 777) process.exit(42);',
                    'process.stdout.write(`explicit shard timeout ${shardTimeout}\\n`);'
                ].join('\n'),
                'utf8'
            );
            fs.writeFileSync(path.join(configDir, 'workflow-config.json'), JSON.stringify({
                full_suite_validation: {
                    enabled: true,
                    command: `"${process.execPath.replace(/\\/g, '/')}" "${helperScript.replace(/\\/g, '/')}"`,
                    timeout_ms: 30000,
                    green_summary_max_lines: 5,
                    red_failure_chunk_lines: 10,
                    out_of_scope_failure_policy: 'AUDIT_AND_BLOCK',
                    placement: 'after_compile_before_reviews'
                }
            }), 'utf8');

            const preflightPath = path.join(reviewsDir, 'T-SHARD-TIMEOUT-ENV-preflight.json');
            writeFullSuitePreflight(tempDir, preflightPath, {
                task_id: 'T-SHARD-TIMEOUT-ENV',
                changed_files: ['src/changed.ts']
            });

            const originalShardTimeout = process.env.GARDA_NODE_FOUNDATION_TEST_SHARD_TIMEOUT_MS;
            process.env.GARDA_NODE_FOUNDATION_TEST_SHARD_TIMEOUT_MS = '777';
            try {
                const result = await runCliWithCapturedOutput([
                    'gate', 'full-suite-validation',
                    '--task-id', 'T-SHARD-TIMEOUT-ENV',
                    '--preflight-path', preflightPath,
                    '--repo-root', tempDir
                ], { cwd: repoRoot });

                assert.equal(result.exitCode, 0, `stdout=${result.logs.join('\n')}\nstderr=${result.errors.join('\n')}`);
            } finally {
                if (originalShardTimeout === undefined) {
                    delete process.env.GARDA_NODE_FOUNDATION_TEST_SHARD_TIMEOUT_MS;
                } else {
                    process.env.GARDA_NODE_FOUNDATION_TEST_SHARD_TIMEOUT_MS = originalShardTimeout;
                }
                fs.rmSync(tempDir, { recursive: true, force: true });
            }
        });

        it('gate full-suite-validation retries timed-out commands according to timeout retry policy', async () => {
            const repoRoot = path.resolve(process.cwd());
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-fsv-cli-timeout-retry-'));
            const configDir = path.join(tempDir, 'garda-agent-orchestrator', 'live', 'config');
            const reviewsDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'reviews');
            const eventsDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'task-events');
            fs.mkdirSync(configDir, { recursive: true });
            fs.mkdirSync(reviewsDir, { recursive: true });
            fs.mkdirSync(eventsDir, { recursive: true });

            const markerPath = path.join(tempDir, 'first-attempt-marker.txt');
            const helperScript = path.join(tempDir, 'timeout-once-then-pass.js');
            fs.writeFileSync(
                helperScript,
                [
                    'const fs = require("node:fs");',
                    `const marker = ${JSON.stringify(markerPath.replace(/\\/g, '/'))};`,
                    'if (!fs.existsSync(marker)) {',
                    '  fs.writeFileSync(marker, "seen", "utf8");',
                    '  setTimeout(() => { process.stdout.write("late first attempt\\n"); process.exit(0); }, 1500);',
                    '} else {',
                    '  process.stdout.write("retry pass\\n");',
                    '  process.exit(0);',
                    '}'
                ].join('\n'),
                'utf8'
            );
            fs.writeFileSync(path.join(configDir, 'workflow-config.json'), JSON.stringify({
                full_suite_validation: {
                    enabled: true,
                    command: `"${process.execPath.replace(/\\/g, '/')}" "${helperScript.replace(/\\/g, '/')}"`,
                    timeout_ms: 1,
                    timeout_blocker: true,
                    timeout_retry_count: 1,
                    green_summary_max_lines: 10,
                    red_failure_chunk_lines: 20,
                    out_of_scope_failure_policy: 'AUDIT_AND_BLOCK',
                    placement: 'after_compile_before_reviews'
                }
            }), 'utf8');

            const preflightPath = path.join(reviewsDir, 'T-TIMEOUT-RETRY-preflight.json');
            writeFullSuitePreflight(tempDir, preflightPath, {
                task_id: 'T-TIMEOUT-RETRY',
                changed_files: ['src/changed.ts']
            });

            const result = await runCliWithCapturedOutput([
                'gate', 'full-suite-validation',
                '--task-id', 'T-TIMEOUT-RETRY',
                '--preflight-path', preflightPath,
                '--repo-root', tempDir
            ], { cwd: repoRoot });

            assert.equal(result.exitCode, 0, `stdout=${result.logs.join('\n')}\nstderr=${result.errors.join('\n')}`);
            const artifactPath = path.join(reviewsDir, 'T-TIMEOUT-RETRY-full-suite-validation.json');
            const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
            assert.equal(artifact.status, 'PASSED');
            assert.equal(artifact.timed_out, false);
            assert.equal(artifact.timeout_policy.timeout_blocker, true);
            assert.equal(artifact.timeout_policy.timeout_retry_count, 1);
            assert.equal(artifact.timeout_policy.max_attempts, 2);
            assert.deepEqual(artifact.timeout_policy.attempts.map((entry: { timed_out: boolean }) => entry.timed_out), [true, false]);
            assert.equal(artifact.timeout_policy.attempts_exhausted, false);
            assert.equal(artifact.timeout_policy.warning_only_continuation, false);
            assert.ok(artifact.compact_summary.some((line: string) => line.includes('FULL_SUITE_TIMEOUT_RETRY')));
            assert.ok(artifact.compact_summary.some((line: string) => line.includes('retry pass')));
            const durationHistory = JSON.parse(fs.readFileSync(resolveFullSuiteDurationHistoryPath(tempDir), 'utf8')) as {
                entries: Array<{
                    task_id: string;
                    status: string;
                    timed_out: boolean;
                    retry_contaminated: boolean;
                    forecast_sample_eligible: boolean;
                    forecast_exclusion_reason: string;
                }>;
            };
            assert.deepEqual(durationHistory.entries.map((entry) => ({
                task_id: entry.task_id,
                status: entry.status,
                timed_out: entry.timed_out,
                retry_contaminated: entry.retry_contaminated,
                forecast_sample_eligible: entry.forecast_sample_eligible,
                forecast_exclusion_reason: entry.forecast_exclusion_reason
            })), [{
                task_id: 'T-TIMEOUT-RETRY',
                status: 'PASSED',
                timed_out: false,
                retry_contaminated: true,
                forecast_sample_eligible: true,
                forecast_exclusion_reason: 'none'
            }]);
            fs.rmSync(tempDir, { recursive: true, force: true });
        });

        it('gate full-suite-validation records warning-only timeout policy evidence when timeout blocker is disabled', async () => {
            const repoRoot = path.resolve(process.cwd());
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-fsv-cli-timeout-warn-'));
            const configDir = path.join(tempDir, 'garda-agent-orchestrator', 'live', 'config');
            const reviewsDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'reviews');
            const eventsDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'task-events');
            fs.mkdirSync(configDir, { recursive: true });
            fs.mkdirSync(reviewsDir, { recursive: true });
            fs.mkdirSync(eventsDir, { recursive: true });

            const helperScript = path.join(tempDir, 'hang-warning.js');
            fs.writeFileSync(
                helperScript,
                'process.stdout.write("warning timeout attempt\\n"); setInterval(() => {}, 1000);',
                'utf8'
            );
            fs.writeFileSync(path.join(configDir, 'workflow-config.json'), JSON.stringify({
                full_suite_validation: {
                    enabled: true,
                    command: `"${process.execPath.replace(/\\/g, '/')}" "${helperScript.replace(/\\/g, '/')}"`,
                    timeout_ms: 100,
                    timeout_blocker: false,
                    timeout_retry_count: 0,
                    green_summary_max_lines: 10,
                    red_failure_chunk_lines: 20,
                    out_of_scope_failure_policy: 'AUDIT_AND_BLOCK',
                    placement: 'after_compile_before_reviews'
                }
            }), 'utf8');

            const preflightPath = path.join(reviewsDir, 'T-TIMEOUT-WARN-preflight.json');
            writeFullSuitePreflight(tempDir, preflightPath, {
                task_id: 'T-TIMEOUT-WARN',
                changed_files: ['src/changed.ts']
            });

            const result = await runCliWithCapturedOutput([
                'gate', 'full-suite-validation',
                '--task-id', 'T-TIMEOUT-WARN',
                '--preflight-path', preflightPath,
                '--repo-root', tempDir
            ], { cwd: repoRoot });

            assert.equal(result.exitCode, 0, `stdout=${result.logs.join('\n')}\nstderr=${result.errors.join('\n')}`);
            const artifactPath = path.join(reviewsDir, 'T-TIMEOUT-WARN-full-suite-validation.json');
            const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
            assert.equal(artifact.status, 'WARNED');
            assert.equal(artifact.timed_out, true);
            assert.equal(artifact.timeout_policy.timeout_blocker, false);
            assert.equal(artifact.timeout_policy.timeout_retry_count, 0);
            assert.equal(artifact.timeout_policy.max_attempts, 1);
            assert.equal(artifact.timeout_policy.attempts_exhausted, true);
            assert.equal(artifact.timeout_policy.warning_only_continuation, true);
            assert.equal(artifact.timeout_policy.repair_task_proposal, null);
            const timeline = fs.readFileSync(path.join(eventsDir, 'T-TIMEOUT-WARN.jsonl'), 'utf8');
            assert.match(timeline, /"event_type":"FULL_SUITE_VALIDATION_WARNED"/);
            assert.match(timeline, /"timeout_policy":\{/);
            fs.rmSync(tempDir, { recursive: true, force: true });
        });

        it('gate full-suite-validation retries timed-out commands before warning-only timeout results', async () => {
            const repoRoot = path.resolve(process.cwd());
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-fsv-cli-timeout-retry-warn-'));
            const configDir = path.join(tempDir, 'garda-agent-orchestrator', 'live', 'config');
            const reviewsDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'reviews');
            const eventsDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'task-events');
            fs.mkdirSync(configDir, { recursive: true });
            fs.mkdirSync(reviewsDir, { recursive: true });
            fs.mkdirSync(eventsDir, { recursive: true });

            const markerPath = path.join(tempDir, 'first-attempt-marker.txt');
            const helperScript = path.join(tempDir, 'timeout-once-then-pass.js');
            fs.writeFileSync(
                helperScript,
                [
                    'const fs = require("node:fs");',
                    `const marker = ${JSON.stringify(markerPath.replace(/\\/g, '/'))};`,
                    'if (!fs.existsSync(marker)) {',
                    '  fs.writeFileSync(marker, "seen", "utf8");',
                    '  setTimeout(() => { process.stdout.write("late first warning attempt\\n"); process.exit(0); }, 1500);',
                    '} else {',
                    '  process.stdout.write("warning retry pass\\n");',
                    '  process.exit(0);',
                    '}'
                ].join('\n'),
                'utf8'
            );
            fs.writeFileSync(path.join(configDir, 'workflow-config.json'), JSON.stringify({
                full_suite_validation: {
                    enabled: true,
                    command: `"${process.execPath.replace(/\\/g, '/')}" "${helperScript.replace(/\\/g, '/')}"`,
                    timeout_ms: 1,
                    timeout_blocker: false,
                    timeout_retry_count: 1,
                    green_summary_max_lines: 10,
                    red_failure_chunk_lines: 20,
                    out_of_scope_failure_policy: 'AUDIT_AND_BLOCK',
                    placement: 'after_compile_before_reviews'
                }
            }), 'utf8');

            const preflightPath = path.join(reviewsDir, 'T-TIMEOUT-RETRY-WARN-preflight.json');
            writeFullSuitePreflight(tempDir, preflightPath, {
                task_id: 'T-TIMEOUT-RETRY-WARN',
                changed_files: ['src/changed.ts']
            });

            const result = await runCliWithCapturedOutput([
                'gate', 'full-suite-validation',
                '--task-id', 'T-TIMEOUT-RETRY-WARN',
                '--preflight-path', preflightPath,
                '--repo-root', tempDir
            ], { cwd: repoRoot });

            assert.equal(result.exitCode, 0, `stdout=${result.logs.join('\n')}\nstderr=${result.errors.join('\n')}`);
            const artifactPath = path.join(reviewsDir, 'T-TIMEOUT-RETRY-WARN-full-suite-validation.json');
            const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
            assert.equal(artifact.status, 'PASSED');
            assert.equal(artifact.timed_out, false);
            assert.equal(artifact.timeout_policy.timeout_blocker, false);
            assert.equal(artifact.timeout_policy.timeout_retry_count, 1);
            assert.equal(artifact.timeout_policy.max_attempts, 2);
            assert.deepEqual(artifact.timeout_policy.attempts.map((entry: { timed_out: boolean }) => entry.timed_out), [true, false]);
            assert.equal(artifact.timeout_policy.attempts_exhausted, false);
            assert.equal(artifact.timeout_policy.warning_only_continuation, false);
            assert.ok(artifact.compact_summary.some((line: string) => line.includes('FULL_SUITE_TIMEOUT_RETRY')));
            assert.ok(artifact.compact_summary.some((line: string) => line.includes('warning retry pass')));
            fs.rmSync(tempDir, { recursive: true, force: true });
        });

        it('gate full-suite-validation supplies prebuilt node test env to npm test subprocesses', async () => {
            const repoRoot = path.resolve(process.cwd());
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-fsv-cli-shard-env-'));
            const configDir = path.join(tempDir, 'garda-agent-orchestrator', 'live', 'config');
            const reviewsDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'reviews');
            const eventsDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'task-events');
            fs.mkdirSync(configDir, { recursive: true });
            fs.mkdirSync(reviewsDir, { recursive: true });
            fs.mkdirSync(eventsDir, { recursive: true });

            const helperScript = path.join(tempDir, 'print-shard-env.js');
            fs.writeFileSync(
                helperScript,
                [
                    'if (process.env.GARDA_NODE_FOUNDATION_TEST_PREBUILT !== "1") process.exit(41);',
                    'if (process.env.GARDA_NODE_FOUNDATION_REUSE_PUBLISH_RUNTIME !== "1") process.exit(42);',
                    'if (process.env.GARDA_VALIDATION_TASK_ID !== "T-SHARD-ENV") process.exit(43);',
                    'if (process.env.GARDA_VALIDATION_REPO_ROOT !== require("node:path").resolve(process.cwd())) process.exit(44);',
                    'process.stdout.write("node-foundation env ok\\n");'
                ].join('\n'),
                'utf8'
            );
            fs.writeFileSync(path.join(configDir, 'workflow-config.json'), JSON.stringify({
                full_suite_validation: {
                    enabled: true,
                    command: `"${process.execPath.replace(/\\/g, '/')}" "${helperScript.replace(/\\/g, '/')}"`,
                    timeout_ms: 30000,
                    green_summary_max_lines: 5,
                    red_failure_chunk_lines: 10,
                    out_of_scope_failure_policy: 'AUDIT_AND_BLOCK',
                    placement: 'after_compile_before_reviews'
                }
            }), 'utf8');

            const preflightPath = path.join(reviewsDir, 'T-SHARD-ENV-preflight.json');
            writeFullSuitePreflight(tempDir, preflightPath, {
                task_id: 'T-SHARD-ENV',
                changed_files: ['src/changed.ts']
            });

            const result = await runCliWithCapturedOutput([
                'gate', 'full-suite-validation',
                '--task-id', 'T-SHARD-ENV',
                '--preflight-path', preflightPath,
                '--repo-root', tempDir
            ], { cwd: repoRoot });

            assert.equal(result.exitCode, 0, `stdout=${result.logs.join('\n')}\nstderr=${result.errors.join('\n')}`);
            const artifactPath = path.join(reviewsDir, 'T-SHARD-ENV-full-suite-validation.json');
            const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
            assert.equal(artifact.status, 'PASSED');
            assert.ok(artifact.compact_summary.some((line: string) => line.includes('node-foundation env ok')));
            assert.equal(artifact.output_artifact_path, null);
            assert.equal(artifact.output_retention.raw_output_retained, false);
            assert.equal(artifact.output_retention.retention_reason, 'SUCCESS_LOG_OMITTED');
            assert.equal(artifact.output_retention.raw_output_line_count, 1);
            fs.rmSync(tempDir, { recursive: true, force: true });
        });

        it('gate full-suite-validation removes dead generated build locks after command timeout', async () => {
            const repoRoot = path.resolve(process.cwd());
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-fsv-cli-timeout-lock-'));
            const configDir = path.join(tempDir, 'garda-agent-orchestrator', 'live', 'config');
            const reviewsDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'reviews');
            const eventsDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'task-events');
            fs.mkdirSync(configDir, { recursive: true });
            fs.mkdirSync(reviewsDir, { recursive: true });
            fs.mkdirSync(eventsDir, { recursive: true });

            const helperScript = path.join(tempDir, 'hang-with-lock.js');
            fs.writeFileSync(
                helperScript,
                [
                    'const fs = require("node:fs");',
                    'const os = require("node:os");',
                    'const path = require("node:path");',
                    'const lockPath = path.join(process.cwd(), ".scripts-build.lock");',
                    'fs.mkdirSync(lockPath, { recursive: true });',
                    'fs.writeFileSync(path.join(lockPath, "owner.json"), JSON.stringify({',
                    '  hostname: os.hostname(),',
                    '  pid: process.pid,',
                    '  startedAtUtc: new Date().toISOString()',
                    '}, null, 2) + "\\n", "utf8");',
                    'process.stdout.write("helper acquired generated lock\\n");',
                    'setInterval(() => {}, 1000);'
                ].join('\n'),
                'utf8'
            );
            fs.writeFileSync(path.join(configDir, 'workflow-config.json'), JSON.stringify({
                full_suite_validation: {
                    enabled: true,
                    command: `"${process.execPath.replace(/\\/g, '/')}" "${helperScript.replace(/\\/g, '/')}"`,
                    timeout_ms: 300,
                    timeout_retry_count: 0,
                    green_summary_max_lines: 5,
                    red_failure_chunk_lines: 10,
                    out_of_scope_failure_policy: 'AUDIT_AND_BLOCK'
                }
            }), 'utf8');

            const preflightPath = path.join(reviewsDir, 'T-TIMEOUT-LOCK-preflight.json');
            writeFullSuitePreflight(tempDir, preflightPath, {
                task_id: 'T-TIMEOUT-LOCK',
                changed_files: ['src/changed.ts'],
                metrics: {
                    scope_sha256: 'a'.repeat(64)
                }
            });

            const result = await runCliWithCapturedOutput([
                'gate', 'full-suite-validation',
                '--task-id', 'T-TIMEOUT-LOCK',
                '--preflight-path', preflightPath,
                '--repo-root', tempDir
            ], { cwd: repoRoot });

            assert.equal(result.exitCode, EXIT_GATE_FAILURE, `stdout=${result.logs.join('\n')}\nstderr=${result.errors.join('\n')}`);
            assert.equal(fs.existsSync(path.join(tempDir, '.scripts-build.lock')), false);
            const artifactPath = path.join(reviewsDir, 'T-TIMEOUT-LOCK-full-suite-validation.json');
            const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
            assert.equal(artifact.status, 'FAILED');
            assert.equal(artifact.timed_out, true);
            assert.equal(artifact.timeout_policy.timeout_blocker, true);
            assert.equal(artifact.timeout_policy.timeout_retry_count, 0);
            assert.equal(artifact.timeout_policy.max_attempts, 1);
            assert.equal(artifact.timeout_policy.attempts_exhausted, true);
            assert.equal(artifact.timeout_policy.warning_only_continuation, false);
            assert.equal(artifact.timeout_policy.repair_task_proposal.suggested_task_id, 'T-TIMEOUT-LOCK-F1');
            assert.ok(artifact.warnings.some((line: string) => line.includes('timeout cleanup removed generated lock')));
            fs.rmSync(tempDir, { recursive: true, force: true });
        });

        it('gate full-suite-validation blocks after configured timeout retry is exhausted', async () => {
            const repoRoot = path.resolve(process.cwd());
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-fsv-cli-timeout-retry-exhausted-'));
            const configDir = path.join(tempDir, 'garda-agent-orchestrator', 'live', 'config');
            const reviewsDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'reviews');
            const eventsDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'task-events');
            fs.mkdirSync(configDir, { recursive: true });
            fs.mkdirSync(reviewsDir, { recursive: true });
            fs.mkdirSync(eventsDir, { recursive: true });

            const helperScript = path.join(tempDir, 'always-timeout.js');
            fs.writeFileSync(
                helperScript,
                'process.stdout.write("timeout retry exhausted attempt\\n"); setInterval(() => {}, 1000);',
                'utf8'
            );
            fs.writeFileSync(path.join(configDir, 'workflow-config.json'), JSON.stringify({
                full_suite_validation: {
                    enabled: true,
                    command: `"${process.execPath.replace(/\\/g, '/')}" "${helperScript.replace(/\\/g, '/')}"`,
                    timeout_ms: 100,
                    timeout_blocker: true,
                    timeout_retry_count: 1,
                    green_summary_max_lines: 10,
                    red_failure_chunk_lines: 20,
                    out_of_scope_failure_policy: 'AUDIT_AND_BLOCK',
                    placement: 'after_compile_before_reviews'
                }
            }), 'utf8');

            const preflightPath = path.join(reviewsDir, 'T-TIMEOUT-RETRY-EXHAUSTED-preflight.json');
            writeFullSuitePreflight(tempDir, preflightPath, {
                task_id: 'T-TIMEOUT-RETRY-EXHAUSTED',
                changed_files: ['src/changed.ts'],
                metrics: {
                    scope_sha256: 'b'.repeat(64)
                }
            });

            const result = await runCliWithCapturedOutput([
                'gate', 'full-suite-validation',
                '--task-id', 'T-TIMEOUT-RETRY-EXHAUSTED',
                '--preflight-path', preflightPath,
                '--repo-root', tempDir
            ], { cwd: repoRoot });

            assert.equal(result.exitCode, EXIT_GATE_FAILURE, `stdout=${result.logs.join('\n')}\nstderr=${result.errors.join('\n')}`);
            const artifactPath = path.join(reviewsDir, 'T-TIMEOUT-RETRY-EXHAUSTED-full-suite-validation.json');
            const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
            assert.equal(artifact.status, 'FAILED');
            assert.equal(artifact.timed_out, true);
            assert.equal(artifact.timeout_policy.timeout_blocker, true);
            assert.equal(artifact.timeout_policy.timeout_retry_count, 1);
            assert.equal(artifact.timeout_policy.max_attempts, 2);
            assert.deepEqual(artifact.timeout_policy.attempts.map((entry: { timed_out: boolean }) => entry.timed_out), [true, true]);
            assert.equal(artifact.timeout_policy.attempts_exhausted, true);
            assert.equal(artifact.timeout_policy.warning_only_continuation, false);
            assert.equal(artifact.timeout_policy.repair_task_proposal.suggested_task_id, 'T-TIMEOUT-RETRY-EXHAUSTED-F1');
            assert.ok(artifact.compact_summary.some((line: string) => line.includes('FULL_SUITE_TIMEOUT_RETRY attempt=1')));
            const timeline = fs.readFileSync(path.join(eventsDir, 'T-TIMEOUT-RETRY-EXHAUSTED.jsonl'), 'utf8');
            assert.match(timeline, /"event_type":"FULL_SUITE_VALIDATION_FAILED"/);
            assert.match(timeline, /"timeout_policy":\{/);
            fs.rmSync(tempDir, { recursive: true, force: true });
        });

        it('gate full-suite-validation clears the running marker after terminal evidence is recorded', async () => {
            const repoRoot = path.resolve(process.cwd());
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-fsv-cli-run-marker-'));
            const configDir = path.join(tempDir, 'garda-agent-orchestrator', 'live', 'config');
            const reviewsDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'reviews');
            const eventsDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'task-events');
            fs.mkdirSync(configDir, { recursive: true });
            fs.mkdirSync(reviewsDir, { recursive: true });
            fs.mkdirSync(eventsDir, { recursive: true });

            const helperScript = path.join(tempDir, 'pass-with-marker.js');
            fs.writeFileSync(
                helperScript,
                'process.stdout.write("marker success\\n"); process.exit(0);',
                'utf8'
            );
            fs.writeFileSync(path.join(configDir, 'workflow-config.json'), JSON.stringify({
                full_suite_validation: {
                    enabled: true,
                    command: `"${process.execPath.replace(/\\/g, '/')}" "${helperScript.replace(/\\/g, '/')}"`,
                    timeout_ms: 30000,
                    green_summary_max_lines: 5,
                    red_failure_chunk_lines: 10,
                    out_of_scope_failure_policy: 'AUDIT_AND_BLOCK',
                    placement: 'after_compile_before_reviews'
                }
            }), 'utf8');

            const preflightPath = path.join(reviewsDir, 'T-RUN-MARKER-preflight.json');
            writeFullSuitePreflight(tempDir, preflightPath, {
                task_id: 'T-RUN-MARKER',
                changed_files: ['src/changed.ts']
            });

            const result = await runCliWithCapturedOutput([
                'gate', 'full-suite-validation',
                '--task-id', 'T-RUN-MARKER',
                '--preflight-path', preflightPath,
                '--repo-root', tempDir
            ], { cwd: repoRoot });

            assert.equal(result.exitCode, 0, `stdout=${result.logs.join('\n')}\nstderr=${result.errors.join('\n')}`);
            assert.equal(fs.existsSync(resolveFullSuiteValidationRunMarkerPath(tempDir, 'T-RUN-MARKER')), false);
            const artifactPath = path.join(reviewsDir, 'T-RUN-MARKER-full-suite-validation.json');
            const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
            assert.equal(artifact.status, 'PASSED');
            fs.rmSync(tempDir, { recursive: true, force: true });
        });

        it('fails loudly and removes the canonical artifact when lifecycle event emission fails', async () => {
            const repoRoot = path.resolve(process.cwd());
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-fsv-cli-emit-fail-'));
            const configDir = path.join(tempDir, 'garda-agent-orchestrator', 'live', 'config');
            const runtimeDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime');
            const reviewsDir = path.join(runtimeDir, 'reviews');
            const blockedEventsPath = path.join(runtimeDir, 'task-events');
            fs.mkdirSync(configDir, { recursive: true });
            fs.mkdirSync(reviewsDir, { recursive: true });

            const helperScript = path.join(tempDir, 'pass-before-emit-failure.js');
            const commandRanPath = path.join(tempDir, 'emit-failure-command-ran');
            fs.writeFileSync(
                helperScript,
                [
                    "const fs = require('node:fs');",
                    `fs.writeFileSync(${JSON.stringify(commandRanPath)}, 'ran', 'utf8');`,
                    `fs.rmSync(${JSON.stringify(blockedEventsPath)}, { recursive: true, force: true });`,
                    `fs.writeFileSync(${JSON.stringify(blockedEventsPath)}, 'blocked', 'utf8');`,
                    'process.stdout.write("emit failure setup passed\\n");'
                ].join('\n'),
                'utf8'
            );
            fs.writeFileSync(path.join(configDir, 'workflow-config.json'), JSON.stringify({
                full_suite_validation: {
                    enabled: true,
                    command: `"${process.execPath.replace(/\\/g, '/')}" "${helperScript.replace(/\\/g, '/')}"`,
                    timeout_ms: 30000,
                    green_summary_max_lines: 5,
                    red_failure_chunk_lines: 10,
                    out_of_scope_failure_policy: 'AUDIT_AND_BLOCK',
                    placement: 'after_compile_before_reviews'
                }
            }), 'utf8');

            const preflightPath = path.join(reviewsDir, 'T-EMIT-FAIL-preflight.json');
            writeFullSuitePreflight(tempDir, preflightPath, {
                task_id: 'T-EMIT-FAIL',
                changed_files: ['src/changed.ts']
            });

            const result = await runCliWithCapturedOutput([
                'gate', 'full-suite-validation',
                '--task-id', 'T-EMIT-FAIL',
                '--preflight-path', preflightPath,
                '--repo-root', tempDir
            ], { cwd: repoRoot });

            assert.notEqual(result.exitCode, 0, `stdout=${result.logs.join('\n')}\nstderr=${result.errors.join('\n')}`);
            assert.ok(result.errors.some((line) => line.includes('Mandatory lifecycle event')));
            assert.equal(fs.existsSync(commandRanPath), true);
            const artifactPath = path.join(reviewsDir, 'T-EMIT-FAIL-full-suite-validation.json');
            const pendingArtifactPath = `${artifactPath}.pending`;
            const pendingMetaPath = `${artifactPath}.pending.meta.json`;
            assert.equal(fs.existsSync(artifactPath), false);
            assert.equal(fs.existsSync(pendingArtifactPath), false);
            assert.equal(fs.existsSync(pendingMetaPath), false);
            assert.equal(
                fs.existsSync(resolveFullSuiteValidationRunMarkerPath(tempDir, 'T-EMIT-FAIL')),
                false
            );
            fs.rmSync(tempDir, { recursive: true, force: true });
        });

        it('recovers a pending canonical artifact when lifecycle event append succeeded before artifact promotion failed', async () => {
            const repoRoot = path.resolve(process.cwd());
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-fsv-cli-promote-recover-'));
            const configDir = path.join(tempDir, 'garda-agent-orchestrator', 'live', 'config');
            const reviewsDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'reviews');
            const eventsDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'task-events');
            fs.mkdirSync(configDir, { recursive: true });
            fs.mkdirSync(reviewsDir, { recursive: true });
            fs.mkdirSync(eventsDir, { recursive: true });

            const helperScript = path.join(tempDir, 'pass-promote-recover.js');
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

            const preflightPath = path.join(reviewsDir, 'T-PROMOTE-RECOVER-preflight.json');
            writeFullSuitePreflight(tempDir, preflightPath, {
                task_id: 'T-PROMOTE-RECOVER',
                changed_files: ['src/changed.ts']
            });

            const artifactPath = path.join(reviewsDir, 'T-PROMOTE-RECOVER-full-suite-validation.json');
            const pendingArtifactPath = `${artifactPath}.pending`;
            const pendingMetaPath = `${artifactPath}.pending.meta.json`;
            const timelinePath = path.join(eventsDir, 'T-PROMOTE-RECOVER.jsonl');

            const fsModule = require('node:fs') as typeof import('node:fs');
            const originalCopyFileSync = fsModule.copyFileSync;
            let injectedPromotionFailure = false;
            try {
                fsModule.copyFileSync = ((src: fs.PathLike, dest: fs.PathLike, mode?: number) => {
                    const normalizedSrc = path.resolve(String(src));
                    const normalizedDest = path.resolve(String(dest));
                    if (
                        !injectedPromotionFailure
                        && normalizedSrc === path.resolve(pendingArtifactPath)
                        && normalizedDest === path.resolve(artifactPath)
                    ) {
                        injectedPromotionFailure = true;
                        throw new Error('Injected artifact promotion failure');
                    }
                    return originalCopyFileSync(src, dest, mode);
                }) as typeof fsModule.copyFileSync;

                const firstRun = await runCliWithCapturedOutput([
                    'gate', 'full-suite-validation',
                    '--task-id', 'T-PROMOTE-RECOVER',
                    '--preflight-path', preflightPath,
                    '--repo-root', tempDir
                ], { cwd: repoRoot });

                assert.notEqual(firstRun.exitCode, 0, `stdout=${firstRun.logs.join('\n')}\nstderr=${firstRun.errors.join('\n')}`);
                process.exitCode = 0;
                assert.equal(injectedPromotionFailure, true);
                assert.ok(firstRun.errors.some((line) => line.includes('canonical artifact promotion failed')));
                assert.equal(fs.existsSync(artifactPath), false);
                assert.equal(fs.existsSync(pendingArtifactPath), true);
                assert.equal(fs.existsSync(pendingMetaPath), true);
                const pendingMeta = JSON.parse(fs.readFileSync(pendingMetaPath, 'utf8'));
                assert.ok(fs.existsSync(timelinePath));
                const timeline = fs.readFileSync(timelinePath, 'utf8');
                assert.match(timeline, /"event_type":"FULL_SUITE_VALIDATION_PASSED"/);
                assert.match(timeline, new RegExp(String(pendingMeta.transaction_id)));
            } finally {
                fsModule.copyFileSync = originalCopyFileSync;
            }

            let recoveryPromotionCount = 0;
            try {
                fsModule.copyFileSync = ((src: fs.PathLike, dest: fs.PathLike, mode?: number) => {
                    const normalizedSrc = path.resolve(String(src));
                    const normalizedDest = path.resolve(String(dest));
                    if (
                        normalizedSrc === path.resolve(pendingArtifactPath)
                        && normalizedDest === path.resolve(artifactPath)
                    ) {
                        recoveryPromotionCount += 1;
                    }
                    return originalCopyFileSync(src, dest, mode);
                }) as typeof fsModule.copyFileSync;

                const secondRun = await runCliWithCapturedOutput([
                    'gate', 'full-suite-validation',
                    '--task-id', 'T-PROMOTE-RECOVER',
                    '--preflight-path', preflightPath,
                    '--repo-root', tempDir
                ], { cwd: repoRoot });

                assert.equal(secondRun.exitCode, 0, `stdout=${secondRun.logs.join('\n')}\nstderr=${secondRun.errors.join('\n')}`);
            } finally {
                fsModule.copyFileSync = originalCopyFileSync;
            }

            assert.equal(recoveryPromotionCount, 2);
            assert.ok(fs.existsSync(artifactPath));
            const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
            assert.equal(artifact.status, 'PASSED');
            assert.equal(fs.existsSync(pendingArtifactPath), false);
            assert.equal(fs.existsSync(pendingMetaPath), false);
            process.exitCode = 0;
            fs.rmSync(tempDir, { recursive: true, force: true });
        });
    });
});
