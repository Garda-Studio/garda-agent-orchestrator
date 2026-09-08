import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { initGitRepo } from '../git-fixtures';
import { resolveNextStep } from './next-step-test-support';
import {
    buildForcedSourceCheckoutRuntimeBuildCommand
} from '../../../../src/validators/workspace-layout';
import { runRecordNoOpCommand } from '../../../../src/cli/commands/gates';
import {
    TASK_ID,
    ALL_REVIEW_FLAGS,
    makeTempRepo,
    reviewsRoot,
    writeJson,
    writeProjectMemoryWorkflowConfig,
    fileSha256,
    writeNoOpEvidence,
    appendEvent,
    seedStartedTask,
    seedPostPreflightRulePack,
    writePreflight,
    seedCompilePass,
    writeGitAutoPreflight,
    seedGitAutoCompilePass,
    writeReviewEvidence,
    seedReviewGatePass,
    seedDocImpactPass,
    seedCompletionPass,
    seedSourceCheckoutRuntime
} from './next-step-completion-fixtures';

describe('gates/next-step', () => {
    const expectedSourceRuntimeRebuildCommand = buildForcedSourceCheckoutRuntimeBuildCommand();

    it('blocks completion while a current failed code review remains even when independent lanes passed', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true, security: true, refactor: true });
        seedCompilePass(repoRoot, TASK_ID);
        writeReviewEvidence(repoRoot, TASK_ID, 'code', { verdict: 'fail' });
        writeReviewEvidence(repoRoot, TASK_ID, 'security');
        writeReviewEvidence(repoRoot, TASK_ID, 'refactor');

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.status, 'BLOCKED');
        assert.equal(result.next_gate, 'implementation');
        assert.equal(result.review.next_review_type, 'code');
        assert.match(result.title, /Fix failed 'code' review findings/);
        assert.ok(!result.commands[0].command.includes('completion-gate'));
    });

    it('preserves expanded explicit preflight scope when refreshing after completion failure', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        const taskModePath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-task-mode.json`);
        const taskMode = JSON.parse(fs.readFileSync(taskModePath, 'utf8')) as Record<string, unknown>;
        taskMode.planned_changed_files = ['src/app.ts'];
        writeJson(taskModePath, taskMode);
        fs.mkdirSync(path.join(repoRoot, 'src', 'gates'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'src', 'gates', 'next-step.ts'), 'export const routed = true;\n', 'utf8');
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true }, {
            changedFiles: ['src/app.ts', 'src/gates/next-step.ts']
        });
        appendEvent(repoRoot, TASK_ID, 'COMPLETION_GATE_FAILED', 'FAIL');

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const command = result.commands[0]?.command || '';

        assert.equal(result.next_gate, 'classify-change');
        assert.ok(command.includes('--changed-file "src/app.ts"'));
        assert.ok(command.includes('--changed-file "src/gates/next-step.ts"'));
    });


    it('keeps the old completion sequence when project memory maintenance is off', () => {
        const repoRoot = makeTempRepo();
        writeProjectMemoryWorkflowConfig(repoRoot, { enabled: false, mode: 'check' });
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS });
        seedCompilePass(repoRoot, TASK_ID);
        seedReviewGatePass(repoRoot, TASK_ID);
        seedDocImpactPass(repoRoot, TASK_ID);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'completion-gate');
        assert.equal(result.project_memory?.required, false);
        assert.equal(result.project_memory?.evidence_status, 'NOT_REQUIRED');
        assert.ok(!result.commands[0].command.includes('project-memory-impact'));
    });

    it('routes to required-reviews-check when compile passed and no reviews are required', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS });
        seedCompilePass(repoRoot, TASK_ID);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'required-reviews-check');
        assert.ok(result.commands[0].command.includes('gate required-reviews-check'));
    });

    it('attests satisfied review authorship evidence in required-reviews-check command', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        seedCompilePass(repoRoot, TASK_ID);
        writeReviewEvidence(repoRoot, TASK_ID, 'code');

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const command = result.commands[0].command;

        assert.equal(result.next_gate, 'required-reviews-check');
        assert.ok(command.includes('--review-authorship-attestation-json'));
        assert.ok(command.includes('{"code":true}'));
        assert.match(result.reason, /change a lane to true only/i);
    });

    it('attests only independently audited required lanes when building required-reviews-check command', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true, security: true, test: true });
        seedCompilePass(repoRoot, TASK_ID);
        writeReviewEvidence(repoRoot, TASK_ID, 'code');
        writeReviewEvidence(repoRoot, TASK_ID, 'test');

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const command = result.commands[0].command;

        assert.equal(result.next_gate, 'build-review-context', result.reason);
        assert.ok(!command.includes('required-reviews-check'), command);

        writeReviewEvidence(repoRoot, TASK_ID, 'security');
        const readyResult = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const readyCommand = readyResult.commands[0].command;

        assert.equal(readyResult.next_gate, 'required-reviews-check', readyResult.reason);
        assert.ok(readyCommand.includes('--review-authorship-attestation-json'));
        assert.ok(readyCommand.includes('{"code":true,"security":true,"test":true}'), readyCommand);
        assert.ok(!readyCommand.includes('prepare-reviewer-launch'), readyCommand);
        assert.ok(!readyCommand.includes('record-review-routing'), readyCommand);
        assert.ok(!readyCommand.includes('build-review-context'), readyCommand);
    });

    it('keeps attestation-only required-review failures on corrected required-reviews-check command', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true, test: true });
        seedCompilePass(repoRoot, TASK_ID);
        writeReviewEvidence(repoRoot, TASK_ID, 'code');
        writeReviewEvidence(repoRoot, TASK_ID, 'test');
        appendEvent(repoRoot, TASK_ID, 'REVIEW_GATE_FAILED', 'FAIL', {
            review_authorship_attestation: {
                status: 'FAILED',
                false_review_types: ['code', 'test'],
                violations: [
                    'Review authorship attestation is false for mandatory review types: code, test. Fresh delegated reviewer output/receipt is not honestly attested for those lanes.'
                ]
            },
            violations: [
                'Review authorship attestation is false for mandatory review types: code, test. Fresh delegated reviewer output/receipt is not honestly attested for those lanes.'
            ]
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const command = result.commands[0].command;

        assert.equal(result.next_gate, 'required-reviews-check', result.reason);
        assert.ok(command.includes('--review-authorship-attestation-json'));
        assert.ok(command.includes('{"code":true,"test":true}'), command);
        assert.ok(!command.includes('prepare-reviewer-launch'), command);
        assert.ok(!command.includes('record-review-routing'), command);
        assert.ok(!command.includes('build-review-context'), command);
    });

    it('reports stale source runtime before required reviews check without hiding the intended gate', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        seedSourceCheckoutRuntime(repoRoot, true);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS });
        seedCompilePass(repoRoot, TASK_ID);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.status, 'BLOCKED');
        assert.equal(result.next_gate, 'source-runtime-remediation');
        assert.equal(result.commands[0].command, expectedSourceRuntimeRebuildCommand);
        assert.ok(result.reason.includes("intended gate 'required-reviews-check'"));
        assert.ok(result.reason.includes('gate required-reviews-check'));
    });

    it('routes zero-diff no-review closeout to audited no-op before required reviews check', () => {
        const repoRoot = makeTempRepo();
        writeJson(path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json'), {
            full_suite_validation: {
                enabled: true,
                command: 'npm test',
                placement: 'after_compile_before_reviews'
            },
            review_execution_policy: {
                mode: 'strict_sequential'
            }
        });
        initGitRepo(repoRoot);
        seedStartedTask(repoRoot, TASK_ID, 'Audit-only: verify zero-diff closeout');
        const preflightPath = writeGitAutoPreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS });
        const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
        preflight.scope_category = 'empty';
        preflight.zero_diff_guard = {
            zero_diff_detected: true,
            status: 'BASELINE_ONLY',
            completion_requires_audited_no_op: true
        };
        preflight.profile_guardrails = {
            zero_diff_no_reviewable_scope: true
        };
        writeJson(preflightPath, preflight);
        seedPostPreflightRulePack(repoRoot, TASK_ID, preflightPath);
        seedGitAutoCompilePass(repoRoot, TASK_ID);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'record-no-op');
        assert.equal(result.title, 'Record audited zero-diff no-op evidence.');
        assert.ok(result.reason.includes('no reviewable diff'));
        assert.ok(result.reason.includes('audited no-op evidence'));
        assert.ok(!result.reason.includes('All required review artifacts appear present'));
        assert.ok(result.commands[0].command.includes('gate record-no-op'));
        assert.ok(result.commands[0].command.includes('<operator-approved no-op rationale>'));
        assert.ok(!result.commands[0].command.includes('gate full-suite-validation'));
        assert.ok(result.commands[0].command.includes('--classification "AUDIT_ONLY"'));
        assert.ok(result.commands[0].command.includes('--preflight-path'));
    });

    it('routes zero-diff with completed required reviews to audited no-op before review gate retry', () => {
        const repoRoot = makeTempRepo();
        initGitRepo(repoRoot);
        seedStartedTask(repoRoot, TASK_ID, 'Audit-only: verify zero-diff closeout');
        const preflightPath = writeGitAutoPreflight(repoRoot, TASK_ID, {
            ...ALL_REVIEW_FLAGS,
            code: true,
            security: true,
            refactor: true
        });
        const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
        preflight.scope_category = 'empty';
        preflight.zero_diff_guard = {
            zero_diff_detected: true,
            status: 'BASELINE_ONLY',
            completion_requires_audited_no_op: true
        };
        writeJson(preflightPath, preflight);
        seedPostPreflightRulePack(repoRoot, TASK_ID, preflightPath);
        seedGitAutoCompilePass(repoRoot, TASK_ID);
        writeReviewEvidence(repoRoot, TASK_ID, 'code');
        writeReviewEvidence(repoRoot, TASK_ID, 'security');
        writeReviewEvidence(repoRoot, TASK_ID, 'refactor');

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'record-no-op');
        assert.ok(result.reason.includes('EVIDENCE_FILE_MISSING'));
        assert.ok(result.commands[0].command.includes('gate record-no-op'));
        assert.ok(!result.commands[0].command.includes('gate required-reviews-check'));
    });

    it('routes zero-diff required-review children to audited no-op before review context preparation', () => {
        const repoRoot = makeTempRepo();
        initGitRepo(repoRoot);
        seedStartedTask(repoRoot, TASK_ID, 'Audit-only: verify zero-diff closeout');
        const preflightPath = writeGitAutoPreflight(repoRoot, TASK_ID, {
            ...ALL_REVIEW_FLAGS,
            code: true
        });
        const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
        preflight.scope_category = 'empty';
        preflight.zero_diff_guard = {
            zero_diff_detected: true,
            status: 'BASELINE_ONLY',
            completion_requires_audited_no_op: true
        };
        writeJson(preflightPath, preflight);
        seedPostPreflightRulePack(repoRoot, TASK_ID, preflightPath);
        seedGitAutoCompilePass(repoRoot, TASK_ID);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'record-no-op');
        assert.ok(result.reason.includes('audited no-op evidence'));
        assert.ok(result.commands[0].command.includes('gate record-no-op'));
        assert.ok(!result.commands[0].command.includes('build-review-context'));
    });

    it('requires planned dependency lockfile scope to materialize before audited no-op', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(path.join(repoRoot, 'package.json'), '{ "dependencies": {} }\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'package-lock.json'), '{ "lockfileVersion": 3 }\n', 'utf8');
        initGitRepo(repoRoot);
        seedStartedTask(repoRoot, TASK_ID);
        const taskModePath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-task-mode.json`);
        const taskMode = JSON.parse(fs.readFileSync(taskModePath, 'utf8')) as Record<string, unknown>;
        taskMode.planned_changed_files = ['package-lock.json'];
        writeJson(taskModePath, taskMode);
        const preflightPath = writeGitAutoPreflight(repoRoot, TASK_ID, {
            ...ALL_REVIEW_FLAGS,
            code: true
        });
        const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
        preflight.scope_category = 'empty';
        preflight.zero_diff_guard = {
            zero_diff_detected: true,
            status: 'BASELINE_ONLY',
            completion_requires_audited_no_op: true
        };
        preflight.profile_guardrails = {
            zero_diff_no_reviewable_scope: true
        };
        writeJson(preflightPath, preflight);
        seedPostPreflightRulePack(repoRoot, TASK_ID, preflightPath);
        seedGitAutoCompilePass(repoRoot, TASK_ID);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'materialize-planned-scope');
        assert.ok(result.reason.includes('package-lock.json'));
        assert.equal(result.commands.length, 0);
    });

    it('continues to required reviews check after current zero-diff no-op evidence exists', () => {
        const repoRoot = makeTempRepo();
        initGitRepo(repoRoot);
        seedStartedTask(repoRoot, TASK_ID);
        const preflightPath = writeGitAutoPreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS });
        const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
        preflight.scope_category = 'empty';
        preflight.zero_diff_guard = {
            zero_diff_detected: true,
            status: 'BASELINE_ONLY',
            completion_requires_audited_no_op: true
        };
        preflight.profile_guardrails = {
            zero_diff_no_reviewable_scope: true
        };
        writeJson(preflightPath, preflight);
        seedPostPreflightRulePack(repoRoot, TASK_ID, preflightPath);
        seedGitAutoCompilePass(repoRoot, TASK_ID);
        writeNoOpEvidence(repoRoot, TASK_ID, preflightPath);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'required-reviews-check');
        assert.equal(result.title, 'Validate zero-diff no-review closeout.');
        assert.ok(result.commands[0].command.includes('gate required-reviews-check'));
        assert.equal(result.missing_artifacts.some((artifact) => artifact.key === 'full-suite-validation'), false);
        assert.equal(result.missing_artifacts.some((artifact) => artifact.key === 'completion-gate'), true);
    });

    it('routes an audited zero-diff no-op through compile before required reviews', () => {
        const repoRoot = makeTempRepo();
        initGitRepo(repoRoot);
        seedStartedTask(repoRoot, TASK_ID);
        const preflightPath = writeGitAutoPreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS });
        const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
        preflight.scope_category = 'empty';
        preflight.zero_diff_guard = {
            zero_diff_detected: true,
            status: 'BASELINE_ONLY',
            completion_requires_audited_no_op: true
        };
        preflight.profile_guardrails = {
            zero_diff_no_reviewable_scope: true
        };
        writeJson(preflightPath, preflight);
        seedPostPreflightRulePack(repoRoot, TASK_ID, preflightPath);
        writeNoOpEvidence(repoRoot, TASK_ID, preflightPath);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'compile-gate');
        assert.ok(result.reason.includes('Compile gate evidence missing'));
        assert.ok(result.commands[0].command.includes('gate compile-gate'));
        assert.ok(!result.commands[0].command.includes('gate required-reviews-check'));
    });

    it('accepts an external-input rationale as audited zero-diff evidence', () => {
        const repoRoot = makeTempRepo();
        initGitRepo(repoRoot);
        seedStartedTask(repoRoot, TASK_ID);
        const preflightPath = writeGitAutoPreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS });
        const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
        preflight.scope_category = 'empty';
        preflight.zero_diff_guard = {
            zero_diff_detected: true,
            status: 'BASELINE_ONLY',
            completion_requires_audited_no_op: true
        };
        preflight.profile_guardrails = {
            zero_diff_no_reviewable_scope: true
        };
        writeJson(preflightPath, preflight);
        seedPostPreflightRulePack(repoRoot, TASK_ID, preflightPath);
        seedGitAutoCompilePass(repoRoot, TASK_ID);
        const noOpResult = runRecordNoOpCommand({
            repoRoot,
            taskId: TASK_ID,
            classification: 'AUDIT_ONLY',
            reason: 'Waiting for external operator input before implementation can continue.',
            preflightPath,
            emitMetrics: false
        });
        assert.equal(noOpResult.exitCode, 0);
        assert.ok(noOpResult.outputLines.includes('NO_OP_RECORDED'));

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'required-reviews-check');
        assert.ok(result.commands[0].command.includes('gate required-reviews-check'));
    });

    it('omits passed completion and not-required full-suite from zero-diff closeout diagnostics', () => {
        const repoRoot = makeTempRepo();
        initGitRepo(repoRoot);
        writeJson(path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json'), {
            full_suite_validation: {
                enabled: true,
                command: 'npm test',
                placement: 'after_compile_before_reviews'
            },
            review_execution_policy: {
                mode: 'strict_sequential'
            }
        });
        seedStartedTask(repoRoot, TASK_ID);
        const preflightPath = writeGitAutoPreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS });
        const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
        preflight.scope_category = 'empty';
        preflight.zero_diff_guard = {
            zero_diff_detected: true,
            status: 'BASELINE_ONLY',
            completion_requires_audited_no_op: true
        };
        preflight.profile_guardrails = {
            zero_diff_no_reviewable_scope: true
        };
        writeJson(preflightPath, preflight);
        seedPostPreflightRulePack(repoRoot, TASK_ID, preflightPath);
        seedGitAutoCompilePass(repoRoot, TASK_ID);
        writeNoOpEvidence(repoRoot, TASK_ID, preflightPath);
        seedReviewGatePass(repoRoot, TASK_ID);
        seedDocImpactPass(repoRoot, TASK_ID);
        seedCompletionPass(repoRoot, TASK_ID);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'task-audit-summary');
        assert.deepEqual(
            result.missing_artifacts.map((artifact) => artifact.key),
            ['final-closeout-json', 'final-closeout-markdown', 'final-user-report']
        );
    });

    it('routes stale zero-diff no-op evidence back to record-no-op', () => {
        const repoRoot = makeTempRepo();
        initGitRepo(repoRoot);
        seedStartedTask(repoRoot, TASK_ID, 'Audit-only: verify zero-diff closeout');
        const preflightPath = writeGitAutoPreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS });
        const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
        preflight.scope_category = 'empty';
        preflight.zero_diff_guard = {
            zero_diff_detected: true,
            status: 'BASELINE_ONLY',
            completion_requires_audited_no_op: true
        };
        preflight.profile_guardrails = {
            zero_diff_no_reviewable_scope: true
        };
        writeJson(preflightPath, preflight);
        seedPostPreflightRulePack(repoRoot, TASK_ID, preflightPath);
        seedGitAutoCompilePass(repoRoot, TASK_ID);
        writeNoOpEvidence(repoRoot, TASK_ID, preflightPath, {
            preflightSha256: '0'.repeat(64)
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'record-no-op');
        assert.ok(result.reason.includes('EVIDENCE_PREFLIGHT_HASH_MISMATCH'));
        assert.ok(result.commands[0].command.includes('gate record-no-op'));
        assert.ok(!result.commands[0].command.includes('gate required-reviews-check'));
    });

    it('routes foreign zero-diff no-op evidence back to record-no-op', () => {
        const repoRoot = makeTempRepo();
        initGitRepo(repoRoot);
        seedStartedTask(repoRoot, TASK_ID, 'Audit-only: verify zero-diff closeout');
        const preflightPath = writeGitAutoPreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS });
        const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
        preflight.scope_category = 'empty';
        preflight.zero_diff_guard = {
            zero_diff_detected: true,
            status: 'BASELINE_ONLY',
            completion_requires_audited_no_op: true
        };
        preflight.profile_guardrails = {
            zero_diff_no_reviewable_scope: true
        };
        writeJson(preflightPath, preflight);
        seedPostPreflightRulePack(repoRoot, TASK_ID, preflightPath);
        seedGitAutoCompilePass(repoRoot, TASK_ID);
        writeNoOpEvidence(repoRoot, TASK_ID, preflightPath, {
            evidenceTaskId: 'T-FOREIGN'
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'record-no-op');
        assert.ok(result.reason.includes('EVIDENCE_TASK_MISMATCH'));
        assert.ok(result.commands[0].command.includes('gate record-no-op'));
        assert.ok(!result.commands[0].command.includes('gate required-reviews-check'));
    });

    it('routes back to preflight refresh when workspace scope drifts after compile', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS });
        seedCompilePass(repoRoot, TASK_ID);
        fs.appendFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const drift = 2;\n', 'utf8');

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'classify-change');
        assert.ok(result.reason.includes('Preflight scope is stale before compile'));
    });

    it('routes failed compile scope-drift artifacts back to preflight refresh instead of compile retry', () => {
        const repoRoot = makeTempRepo();
        initGitRepo(repoRoot);
        seedStartedTask(repoRoot, TASK_ID);
        const preflightPath = writeGitAutoPreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS });
        fs.writeFileSync(path.join(repoRoot, 'CHANGELOG.md'), '# Changelog\n\n- Document compile drift recovery.\n', 'utf8');
        writeJson(path.join(reviewsRoot(repoRoot), `${TASK_ID}-compile-gate.json`), {
            timestamp_utc: new Date().toISOString(),
            task_id: TASK_ID,
            event_source: 'compile-gate',
            status: 'FAILED',
            outcome: 'FAIL',
            error:
                'Preflight scope drift detected. Refresh preflight for the current scope before compile: rerun classify-change, rerun load-rule-pack --stage POST_PREFLIGHT, and then rerun compile-gate.',
            preflight_path: preflightPath.replace(/\\/g, '/'),
            preflight_hash_sha256: fileSha256(preflightPath)
        });
        appendEvent(repoRoot, TASK_ID, 'COMPILE_GATE_FAILED', 'FAIL');

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'classify-change', result.reason);
        assert.ok(result.reason.includes('Preflight scope is stale before compile'));
        assert.ok(result.commands[0].command.includes('gate classify-change'));
        assert.ok(!result.commands[0].command.includes('gate compile-gate'));
    });

    it('does not route to preflight refresh only because generated orchestrator locks exist', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS });
        seedCompilePass(repoRoot, TASK_ID);
        for (const lockName of ['.scripts-build.lock', '.node-build.lock']) {
            const lockPath = path.join(repoRoot, lockName);
            fs.mkdirSync(lockPath, { recursive: true });
            writeJson(path.join(lockPath, 'owner.json'), {
                hostname: os.hostname(),
                pid: 999999,
                startedAtUtc: new Date().toISOString()
            });
        }

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'required-reviews-check');
        assert.ok(!result.reason.includes('Preflight scope is stale'));
    });


});
