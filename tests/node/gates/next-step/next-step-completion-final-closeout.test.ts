import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { initGitRepo, runGitFixtureCommand } from '../git-fixtures';
import {
    buildTaskAuditSummary,
    formatNextStepText,
    readReadyFinalReportSummary,
    resolveNextStep,
    synchronizeFinalCloseoutArtifacts
} from './next-step-test-support';
import {
    buildForcedSourceCheckoutRuntimeBuildCommand
} from '../../../../src/validators/workspace-layout';
import { getCurrentNoOpEventSha256, getNoOpEvidence } from '../../../../src/gates/task-mode/no-op';
import {
    TASK_ID,
    ALL_REVIEW_FLAGS,
    makeTempRepo,
    reviewsRoot,
    writeJson,
    sha256Text,
    fileSha256,
    appendEvent,
    seedStartedTask,
    writePreflight,
    seedCompilePass,
    writeGitAutoPreflight,
    writeNoOpEvidence,
    seedGitAutoCompilePass,
    writeStagedPreflight,
    seedStagedCompilePass,
    seedReviewGatePass,
    seedDocImpactPass,
    seedCompletionPass,
    seedFullSuiteValidation,
    materializeFinalCloseout,
    seedCompletedTaskWithIndependentCodeReview,
    seedSourceCheckoutRuntime
} from './next-step-completion-fixtures';

function bindProtectedDirtyBaseline(
    preflightPath: string,
    relativePath: string,
    contentSha256: string
): void {
    const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
    preflight.triggers = {
        dirty_workspace_protection_status: 'PASS',
        dirty_workspace_untouched_baseline_files: [relativePath],
        dirty_workspace_protected_files: [relativePath],
        dirty_workspace_protected_files_sha256: sha256Text(relativePath),
        dirty_workspace_protected_file_hashes: {
            [relativePath]: contentSha256
        }
    };
    writeJson(preflightPath, preflight);
}

function seedNoOpRecordedEvent(repoRoot: string, taskId: string, preflightPath: string): void {
    const artifactPath = path.join(reviewsRoot(repoRoot), `${taskId}-no-op.json`);
    const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8')) as Record<string, unknown>;
    appendEvent(repoRoot, taskId, 'NO_OP_RECORDED', 'INFO', {
        artifact_path: artifactPath.replace(/\\/gu, '/'),
        artifact_sha256: fileSha256(artifactPath),
        classification: artifact.classification,
        reason: artifact.reason,
        preflight_path: preflightPath.replace(/\\/gu, '/'),
        preflight_sha256: artifact.preflight_sha256
    });
}

function captureGitCommands<T>(callback: () => T): { result: T; gitCommands: string[][] } {
    const childProcessModule = require('node:child_process') as typeof import('node:child_process');
    const originalSpawnSync = childProcessModule.spawnSync;
    const originalExecFileSync = childProcessModule.execFileSync;
    const gitCommands: string[][] = [];
    childProcessModule.spawnSync = ((command: string, args: string[], options: unknown) => {
        if (command === 'git') gitCommands.push([...args]);
        return originalSpawnSync(command, args, options as never);
    }) as typeof originalSpawnSync;
    childProcessModule.execFileSync = ((command: string, args: string[], options: unknown) => {
        if (command === 'git') gitCommands.push([...args]);
        return originalExecFileSync(command, args, options as never);
    }) as typeof originalExecFileSync;
    try {
        return { result: callback(), gitCommands };
    } finally {
        childProcessModule.spawnSync = originalSpawnSync;
        childProcessModule.execFileSync = originalExecFileSync;
    }
}

function seedCompletedTaskWithProtectedDirtyBaseline(
    repoRoot: string
): { baselinePath: string; preflightPath: string } {
    const baselineRelativePath = 'src/local-baseline.ts';
    const baselinePath = path.join(repoRoot, baselineRelativePath);
    fs.writeFileSync(baselinePath, 'export const localBaseline = 1;\n', 'utf8');
    initGitRepo(repoRoot);
    fs.appendFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const completedValue = 2;\n', 'utf8');
    fs.writeFileSync(baselinePath, 'export const localBaseline = 2;\n', 'utf8');
    seedStartedTask(repoRoot, TASK_ID);
    const preflightPath = writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS });
    bindProtectedDirtyBaseline(
        preflightPath,
        baselineRelativePath,
        sha256Text(fs.readFileSync(baselinePath, 'utf8'))
    );
    seedCompilePass(repoRoot, TASK_ID);
    seedReviewGatePass(repoRoot, TASK_ID);
    seedDocImpactPass(repoRoot, TASK_ID);
    seedCompletionPass(repoRoot, TASK_ID);
    materializeFinalCloseout(repoRoot, TASK_ID);
    return { baselinePath, preflightPath };
}

describe('gates/next-step', () => {
    const expectedSourceRuntimeRebuildCommand = buildForcedSourceCheckoutRuntimeBuildCommand();

    it('routes completed tasks to task-audit-summary until final closeout is materialized', () => {

        const repoRoot = makeTempRepo();

        seedStartedTask(repoRoot, TASK_ID);

        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS });

        seedCompilePass(repoRoot, TASK_ID);

        seedReviewGatePass(repoRoot, TASK_ID);

        seedDocImpactPass(repoRoot, TASK_ID);

        seedCompletionPass(repoRoot, TASK_ID);



        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });



        assert.equal(result.status, 'READY');

        assert.equal(result.next_gate, 'task-audit-summary');

        assert.ok(result.commands[0].command.includes('gate task-audit-summary'));

        assert.match(result.reason, /final closeout artifacts are not materialized/i);

        assert.deepEqual(

            result.missing_artifacts.map((artifact) => artifact.key),

            ['final-closeout-json', 'final-closeout-markdown', 'final-user-report']

        );

    });



    it('reports final closeout artifacts when source runtime remediation wraps completed tasks', () => {

        const repoRoot = makeTempRepo();

        seedStartedTask(repoRoot, TASK_ID);

        seedSourceCheckoutRuntime(repoRoot, true);

        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS });

        seedCompilePass(repoRoot, TASK_ID);

        seedReviewGatePass(repoRoot, TASK_ID);

        seedDocImpactPass(repoRoot, TASK_ID);

        seedCompletionPass(repoRoot, TASK_ID);



        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });



        assert.equal(result.status, 'BLOCKED');

        assert.equal(result.next_gate, 'source-runtime-remediation');

        assert.equal(result.commands[0].command, expectedSourceRuntimeRebuildCommand);

        assert.ok(result.reason.includes("intended gate 'task-audit-summary'"));

        assert.ok(result.reason.includes('gate task-audit-summary'));

        assert.deepEqual(

            result.missing_artifacts.map((artifact) => artifact.key),

            ['final-closeout-json', 'final-closeout-markdown', 'final-user-report']

        );

    });



    it('keeps current completed DONE rows ready for task-audit-summary until final closeout is materialized', () => {

        const repoRoot = makeTempRepo();

        const taskId = 'T-624';

        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [

            '# TASK.md',

            '',

            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',

            '|---|---|---|---|---|---|---|---|---|',

            '| T-624 | 🟩 DONE | P1 | workflow | Closed task | gpt-5.4 | 2026-05-05 | strict | Completion gate updated the queue row before final closeout. |',

            ''

        ].join('\n'), 'utf8');

        seedStartedTask(repoRoot, taskId);

        writePreflight(repoRoot, taskId, { ...ALL_REVIEW_FLAGS });

        seedCompilePass(repoRoot, taskId);

        seedReviewGatePass(repoRoot, taskId);

        seedDocImpactPass(repoRoot, taskId);

        seedCompletionPass(repoRoot, taskId);



        const result = resolveNextStep({ taskId, repoRoot });



        assert.equal(result.status, 'READY');

        assert.equal(result.next_gate, 'task-audit-summary');

        assert.equal(result.final_report, null);

        assert.ok(result.commands[0].command.includes('gate task-audit-summary'));

        assert.match(result.reason, /final closeout artifacts are not materialized/i);

    });



    it('surfaces final report order and commit guidance after final closeout is materialized', () => {

        const repoRoot = makeTempRepo();

        seedStartedTask(repoRoot, TASK_ID);

        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS });

        seedCompilePass(repoRoot, TASK_ID);

        seedReviewGatePass(repoRoot, TASK_ID);

        seedDocImpactPass(repoRoot, TASK_ID);

        seedCompletionPass(repoRoot, TASK_ID);

        materializeFinalCloseout(repoRoot, TASK_ID);



        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        const text = formatNextStepText(result);



        assert.equal(result.status, 'DONE', result.reason);

        assert.equal(result.next_gate, null);

        assert.deepEqual(result.missing_artifacts, []);

        assert.equal(result.commands.length, 0);

        assert.equal(result.task_queue_status_contract.agent_may_edit_non_status_task_content, true);

        assert.equal(result.final_report?.required_order.length, 4);

        assert.ok(result.final_report?.final_user_report_path.endsWith(`${TASK_ID}-final-user-report.md`));

        const finalUserReportPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-final-user-report.md`);
        const finalUserReportBody = fs.readFileSync(finalUserReportPath, 'utf8');
        assert.equal(result.final_report?.final_user_report_body, finalUserReportBody);
        assert.equal(result.final_report?.final_user_report_sha256, sha256Text(finalUserReportBody));

        assert.ok((result.final_report?.commit_command_suggestion || '').startsWith('git commit -m "'));

        assert.match(result.reason, /canonical final closeout is materialized/i);

        assert.ok(text.includes('Task status sync: gate-owned for IN_PROGRESS/IN_REVIEW/SPLIT_REQUIRED/DONE'));

        assert.ok(text.includes('FinalUserReportPath:'));

        assert.ok(text.includes(`CopyPasteFinalUserReportSha256: ${sha256Text(finalUserReportBody)}`));

        assert.ok(text.includes(`CopyPasteFinalUserReport:\n${finalUserReportBody}`));

        assert.equal(text.includes('EndCopyPasteFinalUserReport'), false);

        assert.equal(text.includes('```'), false);

        assert.ok(text.includes('FinalUserReportInstruction: write a short summary of what you did, then paste the compact CopyPasteFinalUserReport exactly as printed; do not expand referenced audit artifacts into chat; after that, present only the commit command and commit permission question listed in FinalReportOrder.'));

        assert.ok(text.includes('FinalReportOrder:'));

        assert.ok(text.includes('1. short agent-authored summary of what changed'));

        assert.ok(text.includes('2. verbatim Garda final user report'));

        assert.ok(text.includes('3. git commit -m "'));

        assert.ok(text.includes('4. Do you want me to commit now? (yes/no)'));

        assert.ok(text.includes('Commands:'));

        assert.ok(text.includes('  none'));

    });

    it('neutralizes standalone Markdown controls in completed-task reports without mutating closeout evidence', () => {
        const repoRoot = makeTempRepo();
        const hostileWarnings = [
            '# forged heading',
            '- forged bullet',
            '1. forged ordered item',
            '> forged quote',
            '```forged fence',
            '<script>forged html</script>',
            '[forged link](https://example.invalid)',
            '![forged image](https://example.invalid/pixel.png)'
        ];
        const hostileForecastWarning = [
            '## forged forecast heading',
            '   # forged indented heading',
            '   - forged indented bullet',
            '   > forged indented quote',
            '~~~forged tilde fence',
            '---',
            '<details open>forged disclosure</details>'
        ].join('\n');

        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS });
        seedCompilePass(repoRoot, TASK_ID);
        seedFullSuiteValidation(repoRoot, TASK_ID);
        seedReviewGatePass(repoRoot, TASK_ID);
        seedDocImpactPass(repoRoot, TASK_ID);
        seedCompletionPass(repoRoot, TASK_ID);

        const fullSuitePath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-full-suite-validation.json`);
        const fullSuiteArtifact = JSON.parse(fs.readFileSync(fullSuitePath, 'utf8')) as Record<string, unknown>;
        Object.assign(fullSuiteArtifact, {
            status: 'WARNED',
            timed_out: true,
            warnings: hostileWarnings,
            timeout_policy: {
                timeout_blocker: false,
                timeout_retry_count: 0,
                max_attempts: 1,
                attempts: [{ attempt: 1, timed_out: true }],
                attempts_exhausted: true,
                warning_only_continuation: true,
                repair_task_proposal: null
            },
            timeout_forecast: {
                warning: hostileForecastWarning,
                excluded_sample_count: 2,
                excluded_sample_reasons: {
                    timed_out: 1,
                    retry_contaminated: 1
                }
            }
        });
        writeJson(fullSuitePath, fullSuiteArtifact);
        materializeFinalCloseout(repoRoot, TASK_ID);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const text = formatNextStepText(result);
        const finalUserReportBody = result.final_report?.final_user_report_body || '';
        const closeoutPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-final-closeout.json`);
        const closeout = JSON.parse(fs.readFileSync(closeoutPath, 'utf8')) as {
            workflow?: {
                full_suite_timeout?: {
                    timeout_blocker: boolean | null;
                    timeout_retry_count: number | null;
                    max_attempts: number | null;
                    attempts_count: number;
                    attempts_exhausted: boolean | null;
                    warning_only_continuation: boolean | null;
                    repair_task_proposal: Record<string, unknown> | null;
                    warnings: string[];
                    forecast_warning: string | null;
                    forecast_excluded_sample_count: number;
                    forecast_excluded_sample_reasons: Record<string, number>;
                } | null;
            };
        };

        assert.equal(result.status, 'DONE', result.reason);
        assert.ok(text.includes(`CopyPasteFinalUserReport:\n${finalUserReportBody}`));
        assert.doesNotMatch(finalUserReportBody, /^ {0,3}#{1,6}\s+forged/mu);
        assert.doesNotMatch(finalUserReportBody, /^ {0,3}[-+*]\s+forged/mu);
        assert.doesNotMatch(finalUserReportBody, /^\d+[.)]\s+forged/mu);
        assert.doesNotMatch(finalUserReportBody, /^ {0,3}>\s+forged/mu);
        assert.doesNotMatch(finalUserReportBody, /^(?:-{3,}|_{3,}|\*{3,})\s*$/mu);
        assert.doesNotMatch(finalUserReportBody, /^ {0,3}(?:```|~~~)/mu);
        assert.equal(finalUserReportBody.includes('<script>'), false);
        assert.equal(finalUserReportBody.includes('<details open>'), false);
        assert.equal(finalUserReportBody.includes('[forged link](https://example.invalid)'), false);
        assert.equal(finalUserReportBody.includes('![forged image](https://example.invalid/pixel.png)'), false);
        assert.ok(finalUserReportBody.includes('Warning: # forged heading'));
        assert.ok(finalUserReportBody.includes('Warning: - forged bullet'));
        assert.ok(finalUserReportBody.includes('Warning: 1. forged ordered item'));
        assert.ok(finalUserReportBody.includes('Warning: &gt; forged quote'));
        assert.ok(finalUserReportBody.includes('Warning: \\`\\`\\`forged fence'));
        assert.ok(finalUserReportBody.includes('&lt;script&gt;forged html&lt;/script&gt;'));
        assert.ok(finalUserReportBody.includes('\\[forged link\\](https\\://example.invalid)'));
        assert.ok(finalUserReportBody.includes('!\\[forged image\\](https\\://example.invalid/pixel.png)'));
        assert.ok(finalUserReportBody.includes(
            'Forecast warning: ## forged forecast heading # forged indented heading - forged indented bullet '
            + '&gt; forged indented quote \\~\\~\\~forged tilde fence '
            + '--- &lt;details open&gt;forged disclosure&lt;/details&gt;'
        ));
        const timeoutEvidence = closeout.workflow?.full_suite_timeout;
        assert.deepEqual(timeoutEvidence?.warnings, hostileWarnings);
        assert.equal(timeoutEvidence?.forecast_warning, hostileForecastWarning);
        assert.equal(timeoutEvidence?.forecast_excluded_sample_count, 2);
        assert.deepEqual(timeoutEvidence?.forecast_excluded_sample_reasons, {
            timed_out: 1,
            retry_contaminated: 1
        });
        assert.deepEqual({
            timeout_blocker: timeoutEvidence?.timeout_blocker,
            timeout_retry_count: timeoutEvidence?.timeout_retry_count,
            max_attempts: timeoutEvidence?.max_attempts,
            attempts_count: timeoutEvidence?.attempts_count,
            attempts_exhausted: timeoutEvidence?.attempts_exhausted,
            warning_only_continuation: timeoutEvidence?.warning_only_continuation,
            repair_task_proposal: timeoutEvidence?.repair_task_proposal
        }, {
            timeout_blocker: false,
            timeout_retry_count: 0,
            max_attempts: 1,
            attempts_count: 1,
            attempts_exhausted: true,
            warning_only_continuation: true,
            repair_task_proposal: null
        });
    });



    it('surfaces no-commit final report guidance after final closeout is materialized on a clean tracked worktree', () => {

        const repoRoot = makeTempRepo();

        initGitRepo(repoRoot);

        seedStartedTask(repoRoot, TASK_ID);

        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS });

        seedCompilePass(repoRoot, TASK_ID);

        seedReviewGatePass(repoRoot, TASK_ID);

        seedDocImpactPass(repoRoot, TASK_ID);

        seedCompletionPass(repoRoot, TASK_ID);

        materializeFinalCloseout(repoRoot, TASK_ID);



        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        const text = formatNextStepText(result);



        assert.equal(result.status, 'DONE', result.reason);

        assert.equal(result.next_gate, null);

        assert.equal(result.commands.length, 0);

        assert.deepEqual(result.final_report?.required_order, [

            'short agent-authored summary of what changed',

            'verbatim Garda final user report'

        ]);

        assert.equal(result.final_report?.commit_command_suggestion, 'No commit required: no committable changes are present.');

        assert.equal(result.final_report?.commit_question, 'No commit confirmation required.');

        assert.ok(text.includes('FinalUserReportPath:'));

        assert.ok(!text.includes('3. No commit required: no committable changes are present.'));

        assert.ok(!text.includes('git commit -m "'));

        assert.ok(!text.includes('Do you want me to commit now? (yes/no)'));

    });

    it('accepts a materialized audited no-op closeout without a compile cycle', () => {
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
        preflight.profile_guardrails = { zero_diff_no_reviewable_scope: true };
        writeJson(preflightPath, preflight);
        writeNoOpEvidence(repoRoot, TASK_ID, preflightPath);
        seedNoOpRecordedEvent(repoRoot, TASK_ID, preflightPath);
        const noOpEvidence = getNoOpEvidence(repoRoot, TASK_ID, '', preflightPath);
        assert.match(String(noOpEvidence.evidence_hash), /^[0-9a-f]{64}$/u);
        seedReviewGatePass(repoRoot, TASK_ID);
        seedDocImpactPass(repoRoot, TASK_ID);
        seedCompletionPass(repoRoot, TASK_ID);
        materializeFinalCloseout(repoRoot, TASK_ID);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        assert.equal(result.status, 'DONE', result.reason);
        assert.equal(result.next_gate, null);
        assert.ok(result.final_report?.final_user_report_body.includes('Status: DONE'));

        fs.rmSync(path.join(reviewsRoot(repoRoot), `${TASK_ID}-no-op.json`));
        const missingNoOpSummary = buildTaskAuditSummary({ taskId: TASK_ID, repoRoot });
        assert.equal(readReadyFinalReportSummary(
            repoRoot,
            reviewsRoot(repoRoot),
            TASK_ID,
            missingNoOpSummary
        ), null);
    });

    it('rejects a prior no-op closeout and ledger after a later no-op cycle', () => {
        const repoRoot = makeTempRepo();
        initGitRepo(repoRoot);
        const closeoutRoot = reviewsRoot(repoRoot);
        const closeoutPath = path.join(closeoutRoot, `${TASK_ID}-final-closeout.json`);
        const closeoutMarkdownPath = path.join(closeoutRoot, `${TASK_ID}-final-closeout.md`);
        const reportPath = path.join(closeoutRoot, `${TASK_ID}-final-user-report.md`);
        const ledgerPath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'task-ledger', `${TASK_ID}.json`);
        const completeNoOpCycle = (reason: string): void => {
            seedStartedTask(repoRoot, TASK_ID);
            const preflightPath = writeGitAutoPreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS });
            const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
            preflight.scope_category = 'empty';
            preflight.zero_diff_guard = {
                zero_diff_detected: true,
                status: 'BASELINE_ONLY',
                completion_requires_audited_no_op: true
            };
            preflight.profile_guardrails = { zero_diff_no_reviewable_scope: true };
            writeJson(preflightPath, preflight);
            writeNoOpEvidence(repoRoot, TASK_ID, preflightPath);
            const noOpPath = path.join(closeoutRoot, `${TASK_ID}-no-op.json`);
            const noOp = JSON.parse(fs.readFileSync(noOpPath, 'utf8')) as Record<string, unknown>;
            noOp.reason = reason;
            writeJson(noOpPath, noOp);
            seedNoOpRecordedEvent(repoRoot, TASK_ID, preflightPath);
            seedReviewGatePass(repoRoot, TASK_ID);
            seedDocImpactPass(repoRoot, TASK_ID);
            seedCompletionPass(repoRoot, TASK_ID);
            materializeFinalCloseout(repoRoot, TASK_ID);
        };

        completeNoOpCycle('First audited no-op cycle with no source change.');
        const priorPaths = [
            closeoutPath,
            closeoutMarkdownPath,
            reportPath,
            ledgerPath,
            path.join(closeoutRoot, `${TASK_ID}-no-op.json`),
            path.join(closeoutRoot, `${TASK_ID}-preflight.json`)
        ];
        const prior = priorPaths
            .map((filePath) => fs.readFileSync(filePath));
        completeNoOpCycle('Second audited no-op cycle with no source change.');
        const currentSummary = buildTaskAuditSummary({ taskId: TASK_ID, repoRoot });
        assert.ok(readReadyFinalReportSummary(repoRoot, closeoutRoot, TASK_ID, currentSummary));

        priorPaths.forEach((filePath, index) => fs.writeFileSync(filePath, prior[index]));
        assert.equal(readReadyFinalReportSummary(
            repoRoot,
            closeoutRoot,
            TASK_ID,
            buildTaskAuditSummary({ taskId: TASK_ID, repoRoot })
        ), null);
    });

    it('binds a no-op cycle after an earlier compile to the current no-op event', () => {
        const repoRoot = makeTempRepo();
        initGitRepo(repoRoot);
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS });
        seedCompilePass(repoRoot, TASK_ID);
        seedReviewGatePass(repoRoot, TASK_ID);
        seedDocImpactPass(repoRoot, TASK_ID);
        seedCompletionPass(repoRoot, TASK_ID);
        materializeFinalCloseout(repoRoot, TASK_ID);

        const closeoutRoot = reviewsRoot(repoRoot);
        const priorPaths = [
            path.join(closeoutRoot, `${TASK_ID}-final-closeout.json`),
            path.join(closeoutRoot, `${TASK_ID}-final-closeout.md`),
            path.join(closeoutRoot, `${TASK_ID}-final-user-report.md`),
            path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'task-ledger', `${TASK_ID}.json`)
        ];
        const prior = priorPaths.map((filePath) => fs.readFileSync(filePath));

        seedStartedTask(repoRoot, TASK_ID);
        const preflightPath = writeGitAutoPreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS });
        const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
        preflight.scope_category = 'empty';
        preflight.zero_diff_guard = {
            zero_diff_detected: true,
            status: 'BASELINE_ONLY',
            completion_requires_audited_no_op: true
        };
        preflight.profile_guardrails = { zero_diff_no_reviewable_scope: true };
        writeJson(preflightPath, preflight);
        writeNoOpEvidence(repoRoot, TASK_ID, preflightPath);
        seedNoOpRecordedEvent(repoRoot, TASK_ID, preflightPath);
        seedReviewGatePass(repoRoot, TASK_ID);
        seedDocImpactPass(repoRoot, TASK_ID);
        seedCompletionPass(repoRoot, TASK_ID);
        materializeFinalCloseout(repoRoot, TASK_ID);

        const currentCloseout = JSON.parse(fs.readFileSync(priorPaths[0], 'utf8')) as Record<string, unknown>;
        const binding = currentCloseout.cycle_binding as Record<string, unknown>;
        assert.equal(binding.compile_gate_timestamp, null);
        assert.match(String(binding.no_op_event_sha256), /^[0-9a-f]{64}$/u);
        assert.equal(resolveNextStep({ taskId: TASK_ID, repoRoot }).status, 'DONE');

        priorPaths.forEach((filePath, index) => fs.writeFileSync(filePath, prior[index]));
        assert.equal(readReadyFinalReportSummary(
            repoRoot,
            closeoutRoot,
            TASK_ID,
            buildTaskAuditSummary({ taskId: TASK_ID, repoRoot })
        ), null);
    });

    it('blocks an audited no-op closeout without a matching current no-op event', () => {
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
        preflight.profile_guardrails = { zero_diff_no_reviewable_scope: true };
        writeJson(preflightPath, preflight);
        writeNoOpEvidence(repoRoot, TASK_ID, preflightPath);
        seedReviewGatePass(repoRoot, TASK_ID);
        seedDocImpactPass(repoRoot, TASK_ID);
        seedCompletionPass(repoRoot, TASK_ID);

        const summary = buildTaskAuditSummary({ taskId: TASK_ID, repoRoot });
        assert.equal(summary.final_closeout.status, 'NOT_READY');
        assert.match(String(summary.final_closeout.blocker), /NO_OP_RECORDED/u);
    });

    it('recovers a legacy no-op event by recording a hash-bound event and rerunning closeout gates', () => {
        const repoRoot = makeTempRepo();
        const taskQueuePath = path.join(repoRoot, 'TASK.md');
        const taskQueue = fs.readFileSync(taskQueuePath, 'utf8');
        assert.ok(taskQueue.includes(`| ${TASK_ID} | TODO |`));
        fs.writeFileSync(taskQueuePath, taskQueue.replace(`| ${TASK_ID} | TODO |`, `| ${TASK_ID} | 🟩 DONE |`), 'utf8');
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
        preflight.profile_guardrails = { zero_diff_no_reviewable_scope: true };
        writeJson(preflightPath, preflight);
        writeNoOpEvidence(repoRoot, TASK_ID, preflightPath);
        const artifactPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-no-op.json`);
        const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8')) as Record<string, unknown>;
        appendEvent(repoRoot, TASK_ID, 'NO_OP_RECORDED', 'INFO', {
            artifact_path: artifactPath.replace(/\\/gu, '/'),
            classification: artifact.classification,
            reason: artifact.reason,
            preflight_path: preflightPath.replace(/\\/gu, '/'),
            preflight_sha256: artifact.preflight_sha256
        });
        seedReviewGatePass(repoRoot, TASK_ID);
        seedDocImpactPass(repoRoot, TASK_ID);
        seedCompletionPass(repoRoot, TASK_ID);

        const evidence = getNoOpEvidence(repoRoot, TASK_ID, '', preflightPath);
        assert.equal(evidence.evidence_status, 'PASS');
        assert.equal(getCurrentNoOpEventSha256(repoRoot, TASK_ID, evidence), null);
        assert.equal(buildTaskAuditSummary({ taskId: TASK_ID, repoRoot }).final_closeout.status, 'NOT_READY');
        assert.equal(resolveNextStep({ taskId: TASK_ID, repoRoot }).next_gate, 'record-no-op');

        seedNoOpRecordedEvent(repoRoot, TASK_ID, preflightPath);
        assert.match(String(getCurrentNoOpEventSha256(repoRoot, TASK_ID, evidence)), /^[0-9a-f]{64}$/u);
        const recoveryStep = resolveNextStep({ taskId: TASK_ID, repoRoot });
        assert.notEqual(recoveryStep.next_gate, 'task-audit-summary');
        assert.notEqual(recoveryStep.next_gate, 'task-reset');
        assert.notEqual(recoveryStep.status, 'DONE');
        seedReviewGatePass(repoRoot, TASK_ID);
        seedDocImpactPass(repoRoot, TASK_ID);
        seedCompletionPass(repoRoot, TASK_ID);
        materializeFinalCloseout(repoRoot, TASK_ID);
        assert.equal(resolveNextStep({ taskId: TASK_ID, repoRoot }).status, 'DONE');
    });

    it('accepts a hash-bound no-op after an earlier compile in the same task entry', () => {
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
        preflight.profile_guardrails = { zero_diff_no_reviewable_scope: true };
        writeJson(preflightPath, preflight);
        seedGitAutoCompilePass(repoRoot, TASK_ID);
        writeNoOpEvidence(repoRoot, TASK_ID, preflightPath);
        seedNoOpRecordedEvent(repoRoot, TASK_ID, preflightPath);
        seedReviewGatePass(repoRoot, TASK_ID);
        seedDocImpactPass(repoRoot, TASK_ID);
        seedCompletionPass(repoRoot, TASK_ID);

        materializeFinalCloseout(repoRoot, TASK_ID);
        assert.equal(resolveNextStep({ taskId: TASK_ID, repoRoot }).status, 'DONE');
    });

    it('rejects a compile event after the hash-bound no-op anchor', () => {
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
        preflight.profile_guardrails = { zero_diff_no_reviewable_scope: true };
        writeJson(preflightPath, preflight);
        writeNoOpEvidence(repoRoot, TASK_ID, preflightPath);
        seedNoOpRecordedEvent(repoRoot, TASK_ID, preflightPath);
        seedGitAutoCompilePass(repoRoot, TASK_ID);
        seedReviewGatePass(repoRoot, TASK_ID);
        seedDocImpactPass(repoRoot, TASK_ID);
        seedCompletionPass(repoRoot, TASK_ID);

        const evidence = getNoOpEvidence(repoRoot, TASK_ID, '', preflightPath);
        assert.equal(getCurrentNoOpEventSha256(repoRoot, TASK_ID, evidence), null);
        assert.equal(buildTaskAuditSummary({ taskId: TASK_ID, repoRoot }).final_closeout.status, 'NOT_READY');
    });

    it('does not reuse review and doc events before the current no-op event', () => {
        const repoRoot = makeTempRepo();
        initGitRepo(repoRoot);
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS });
        seedCompilePass(repoRoot, TASK_ID);
        seedReviewGatePass(repoRoot, TASK_ID);
        seedDocImpactPass(repoRoot, TASK_ID);

        seedStartedTask(repoRoot, TASK_ID);
        const preflightPath = writeGitAutoPreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS });
        const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
        preflight.scope_category = 'empty';
        preflight.zero_diff_guard = {
            zero_diff_detected: true,
            status: 'BASELINE_ONLY',
            completion_requires_audited_no_op: true
        };
        preflight.profile_guardrails = { zero_diff_no_reviewable_scope: true };
        writeJson(preflightPath, preflight);
        writeNoOpEvidence(repoRoot, TASK_ID, preflightPath);
        seedNoOpRecordedEvent(repoRoot, TASK_ID, preflightPath);
        seedCompletionPass(repoRoot, TASK_ID);

        const summary = buildTaskAuditSummary({ taskId: TASK_ID, repoRoot });
        assert.equal(summary.final_closeout.status, 'NOT_READY');
        assert.ok(summary.gates.some((gate) => gate.gate === 'required-reviews-check' && gate.status === 'MISSING'));
        assert.ok(summary.gates.some((gate) => gate.gate === 'doc-impact-gate' && gate.status === 'MISSING'));
    });

    it('reads audited no-op evidence from explicit review and event roots', () => {
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
        preflight.profile_guardrails = { zero_diff_no_reviewable_scope: true };
        writeJson(preflightPath, preflight);
        writeNoOpEvidence(repoRoot, TASK_ID, preflightPath);
        seedNoOpRecordedEvent(repoRoot, TASK_ID, preflightPath);
        seedReviewGatePass(repoRoot, TASK_ID);
        seedDocImpactPass(repoRoot, TASK_ID);
        seedCompletionPass(repoRoot, TASK_ID);

        const alternateEventsRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'alternate-events');
        fs.mkdirSync(alternateEventsRoot, { recursive: true });
        const defaultEventPath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'task-events', `${TASK_ID}.jsonl`);
        fs.copyFileSync(defaultEventPath, path.join(alternateEventsRoot, `${TASK_ID}.jsonl`));
        fs.rmSync(defaultEventPath);
        const evidence = getNoOpEvidence(repoRoot, TASK_ID, '', preflightPath);
        assert.equal(evidence.evidence_status, 'PASS');
        assert.match(String(getCurrentNoOpEventSha256(repoRoot, TASK_ID, evidence, alternateEventsRoot)), /^[0-9a-f]{64}$/u);
        assert.equal(getCurrentNoOpEventSha256(repoRoot, TASK_ID, evidence), null);

        const alternateReviewsRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'alternate-reviews');
        fs.mkdirSync(alternateReviewsRoot, { recursive: true });
        const alternatePreflightPath = path.join(alternateReviewsRoot, `${TASK_ID}-preflight.json`);
        const alternateNoOpPath = path.join(alternateReviewsRoot, `${TASK_ID}-no-op.json`);
        fs.copyFileSync(preflightPath, alternatePreflightPath);
        const noOp = JSON.parse(fs.readFileSync(path.join(reviewsRoot(repoRoot), `${TASK_ID}-no-op.json`), 'utf8')) as Record<string, unknown>;
        noOp.preflight_path = alternatePreflightPath.replace(/\\/gu, '/');
        writeJson(alternateNoOpPath, noOp);
        assert.equal(getNoOpEvidence(repoRoot, TASK_ID, alternateNoOpPath, alternatePreflightPath).evidence_status, 'PASS');
    });

    it('does not reuse future-dated review and doc events recorded before no-op', () => {
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
        preflight.profile_guardrails = { zero_diff_no_reviewable_scope: true };
        writeJson(preflightPath, preflight);
        const futureUtc = new Date(Date.now() + 60_000).toISOString();
        appendEvent(repoRoot, TASK_ID, 'REVIEW_GATE_PASSED', 'PASS', {}, futureUtc);
        appendEvent(repoRoot, TASK_ID, 'DOC_IMPACT_ASSESSED', 'PASS', {}, futureUtc);
        writeNoOpEvidence(repoRoot, TASK_ID, preflightPath);
        seedNoOpRecordedEvent(repoRoot, TASK_ID, preflightPath);
        seedCompletionPass(repoRoot, TASK_ID);

        const summary = buildTaskAuditSummary({ taskId: TASK_ID, repoRoot });
        assert.ok(summary.gates.some((gate) => gate.gate === 'required-reviews-check' && gate.status === 'MISSING'));
        assert.ok(summary.gates.some((gate) => gate.gate === 'doc-impact-gate' && gate.status === 'MISSING'));
    });

    it('preserves a rule-pack failure recorded before no-op', () => {
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
        preflight.profile_guardrails = { zero_diff_no_reviewable_scope: true };
        writeJson(preflightPath, preflight);
        appendEvent(repoRoot, TASK_ID, 'RULE_PACK_LOAD_FAILED', 'FAIL');
        writeNoOpEvidence(repoRoot, TASK_ID, preflightPath);
        seedNoOpRecordedEvent(repoRoot, TASK_ID, preflightPath);
        seedReviewGatePass(repoRoot, TASK_ID);
        seedDocImpactPass(repoRoot, TASK_ID);
        seedCompletionPass(repoRoot, TASK_ID);

        const summary = buildTaskAuditSummary({ taskId: TASK_ID, repoRoot });
        assert.ok(summary.gates.some((gate) => gate.gate === 'load-rule-pack' && gate.status === 'FAIL'));
        assert.equal(summary.final_closeout.status, 'NOT_READY');
    });

    it('rejects a no-op artifact changed after its recorded event', () => {
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
        preflight.profile_guardrails = { zero_diff_no_reviewable_scope: true };
        writeJson(preflightPath, preflight);
        writeNoOpEvidence(repoRoot, TASK_ID, preflightPath);
        seedNoOpRecordedEvent(repoRoot, TASK_ID, preflightPath);
        const noOpPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-no-op.json`);
        const noOp = JSON.parse(fs.readFileSync(noOpPath, 'utf8')) as Record<string, unknown>;
        noOp.actor = 'replacement-actor';
        writeJson(noOpPath, noOp);
        seedReviewGatePass(repoRoot, TASK_ID);
        seedDocImpactPass(repoRoot, TASK_ID);
        seedCompletionPass(repoRoot, TASK_ID);

        const evidence = getNoOpEvidence(repoRoot, TASK_ID, '', preflightPath);
        assert.equal(evidence.evidence_status, 'PASS');
        assert.equal(getCurrentNoOpEventSha256(repoRoot, TASK_ID, evidence), null);
        assert.equal(buildTaskAuditSummary({ taskId: TASK_ID, repoRoot }).final_closeout.status, 'NOT_READY');
    });

    it('rejects no-op evidence recorded before the latest preflight classification', () => {
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
        preflight.profile_guardrails = { zero_diff_no_reviewable_scope: true };
        writeJson(preflightPath, preflight);
        writeNoOpEvidence(repoRoot, TASK_ID, preflightPath);
        seedNoOpRecordedEvent(repoRoot, TASK_ID, preflightPath);
        appendEvent(repoRoot, TASK_ID, 'PREFLIGHT_CLASSIFIED', 'INFO', {
            output_path: preflightPath.replace(/\\/gu, '/')
        });
        seedReviewGatePass(repoRoot, TASK_ID);
        seedDocImpactPass(repoRoot, TASK_ID);
        seedCompletionPass(repoRoot, TASK_ID);

        const evidence = getNoOpEvidence(repoRoot, TASK_ID, '', preflightPath);
        assert.equal(evidence.evidence_status, 'PASS');
        assert.equal(getCurrentNoOpEventSha256(repoRoot, TASK_ID, evidence), null);
        assert.equal(buildTaskAuditSummary({ taskId: TASK_ID, repoRoot }).final_closeout.status, 'NOT_READY');
    });



    it('surfaces final report readiness after independent review attestation and canonical materialization', () => {

        const repoRoot = makeTempRepo();

        seedCompletedTaskWithIndependentCodeReview(repoRoot, TASK_ID);

        materializeFinalCloseout(repoRoot, TASK_ID);



        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        const text = formatNextStepText(result);



        assert.equal(result.status, 'DONE', result.reason);

        assert.equal(result.next_gate, null);

        assert.equal(result.commands.length, 0);

        assert.equal(result.final_report?.required_order[0], 'short agent-authored summary of what changed');

        assert.equal(result.final_report?.required_order[1], 'verbatim Garda final user report');

        assert.ok(result.final_report?.required_order[2].startsWith('git commit -m "'));

        assert.equal(result.final_report?.required_order[3], 'Do you want me to commit now? (yes/no)');

        assert.ok((result.final_report?.commit_command_suggestion || '').startsWith('git commit -m "'));

        assert.match(result.reason, /canonical final closeout is materialized/i);

        assert.ok(text.includes('Review trust: INDEPENDENT_AUDITED via DELEGATED_SUBAGENT; independent reviewer launch attested.'));

        assert.ok(text.includes('1. short agent-authored summary of what changed'));

        assert.ok(text.includes('2. verbatim Garda final user report'));

        assert.ok(text.includes('3. git commit -m "'));

        assert.ok(text.includes('4. Do you want me to commit now? (yes/no)'));

        assert.ok(text.includes('Commands:'));

        assert.ok(text.includes('  none'));

    });



    it('rejects non-canonical final closeout artifacts and routes a representative tamper back to task-audit-summary', () => {

        const repoRoot = makeTempRepo();

        seedStartedTask(repoRoot, TASK_ID);

        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS });

        seedCompilePass(repoRoot, TASK_ID);

        seedReviewGatePass(repoRoot, TASK_ID);

        seedDocImpactPass(repoRoot, TASK_ID);

        seedCompletionPass(repoRoot, TASK_ID);

        const summary = buildTaskAuditSummary({ taskId: TASK_ID, repoRoot });

        synchronizeFinalCloseoutArtifacts(summary);

        const closeoutRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews');

        const closeoutPath = path.join(closeoutRoot, `${TASK_ID}-final-closeout.json`);

        const closeoutMarkdownPath = path.join(closeoutRoot, `${TASK_ID}-final-closeout.md`);

        const finalUserReportPath = path.join(closeoutRoot, `${TASK_ID}-final-user-report.md`);

        const canonicalCloseout = fs.readFileSync(closeoutPath);

        const canonicalCloseoutMarkdown = fs.readFileSync(closeoutMarkdownPath);

        const canonicalFinalUserReport = fs.readFileSync(finalUserReportPath);

        for (const tamper of [

            'missing-json-attestation',

            'forged-json-attestation',

            'forged-json-commit-guidance',

            'reformatted-json',

            'forged-markdown',

            'missing-markdown-final-newline',

            'extra-markdown-trailing-blank',

            'missing-final-user-report',

            'forged-final-user-report'

        ]) {

            fs.writeFileSync(closeoutPath, canonicalCloseout);

            fs.writeFileSync(closeoutMarkdownPath, canonicalCloseoutMarkdown);

            fs.writeFileSync(finalUserReportPath, canonicalFinalUserReport);

            const closeout = JSON.parse(canonicalCloseout.toString('utf8')) as Record<string, unknown>;

            if (tamper === 'missing-json-attestation') {

                delete closeout.review_integrity_attestation; writeJson(closeoutPath, closeout);

            } else if (tamper === 'forged-json-attestation') {

                closeout.review_integrity_attestation = { ...(closeout.review_integrity_attestation as Record<string, unknown>), status: 'NO_REVIEW_REQUIRED', reason: 'forged no-review attestation' }; writeJson(closeoutPath, closeout);

            } else if (tamper === 'forged-json-commit-guidance') {

                closeout.commit_command_suggestion = 'git commit -m "forged: command"'; writeJson(closeoutPath, closeout);

            } else if (tamper === 'reformatted-json') {

                fs.writeFileSync(closeoutPath, JSON.stringify(closeout), 'utf8');

            } else if (tamper === 'missing-markdown-final-newline') {

                fs.writeFileSync(closeoutMarkdownPath, fs.readFileSync(closeoutMarkdownPath, 'utf8').trimEnd(), 'utf8');

            } else if (tamper === 'extra-markdown-trailing-blank') {

                fs.appendFileSync(closeoutMarkdownPath, '\n', 'utf8');

            } else if (tamper === 'missing-final-user-report') {

                fs.rmSync(finalUserReportPath, { force: true });

            } else if (tamper === 'forged-final-user-report') {

                fs.appendFileSync(finalUserReportPath, '\nforged review timing warning\n', 'utf8');

            } else {

                fs.writeFileSync(closeoutMarkdownPath, `${fs.readFileSync(closeoutMarkdownPath, 'utf8')}\nforged review integrity line\n`, 'utf8');

            }



            assert.equal(
                readReadyFinalReportSummary(repoRoot, closeoutRoot, TASK_ID, summary),
                null,
                tamper
            );

            if (tamper !== 'forged-markdown') {
                continue;
            }

            const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

            assert.equal(result.status, 'READY', tamper);

            assert.equal(result.next_gate, 'task-audit-summary', tamper);

            assert.equal(result.final_report, null, tamper);

            assert.ok(result.commands[0].command.includes('gate task-audit-summary'), tamper);

            assert.match(result.reason, /final closeout artifacts are not materialized yet/i, tamper);

            assert.deepEqual(

                result.missing_artifacts.map((artifact) => artifact.key),

                ['final-closeout-json', 'final-closeout-markdown', 'final-user-report'],

                tamper

            );

        }

    });



    it('routes back to task-audit-summary when only a stale prior-cycle closeout is materialized', () => {

        const repoRoot = makeTempRepo();

        seedStartedTask(repoRoot, TASK_ID);

        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS });

        seedCompilePass(repoRoot, TASK_ID);

        seedReviewGatePass(repoRoot, TASK_ID);

        seedDocImpactPass(repoRoot, TASK_ID);

        seedCompletionPass(repoRoot, TASK_ID);

        materializeFinalCloseout(repoRoot, TASK_ID);



        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS });

        seedCompilePass(repoRoot, TASK_ID);

        seedReviewGatePass(repoRoot, TASK_ID);

        seedDocImpactPass(repoRoot, TASK_ID);

        seedCompletionPass(repoRoot, TASK_ID);



        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });



        assert.equal(result.status, 'READY', formatNextStepText(result));

        assert.equal(result.next_gate, 'task-audit-summary');

        assert.equal(result.final_report, null);

        assert.equal(result.commands.length, 1);

        assert.ok(result.commands[0].command.includes('gate task-audit-summary'));

        assert.match(result.reason, /final closeout artifacts are not materialized yet/i);

        assert.deepEqual(

            result.missing_artifacts.map((artifact) => artifact.key),

            ['final-closeout-json', 'final-closeout-markdown', 'final-user-report']

        );

    });



    it('keeps completed tasks ready for task-audit-summary even when the workspace is clean after commit', () => {

        const repoRoot = makeTempRepo();

        seedStartedTask(repoRoot, TASK_ID);

        const preflightPath = writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS });

        const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;

        preflight.detection_source = 'git_auto';

        preflight.changed_files = ['src/app.ts'];

        preflight.metrics = {

            changed_lines_total: 10

        };

        writeJson(preflightPath, preflight);

        seedCompilePass(repoRoot, TASK_ID);

        seedReviewGatePass(repoRoot, TASK_ID);

        seedDocImpactPass(repoRoot, TASK_ID);

        seedCompletionPass(repoRoot, TASK_ID);



        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });



        assert.equal(result.status, 'READY');

        assert.equal(result.next_gate, 'task-audit-summary');

        assert.ok(result.commands[0].command.includes('gate task-audit-summary'));

        assert.match(result.reason, /final closeout artifacts are not materialized yet/i);

    });

    it('keeps a materialized completed task DONE after its exact audited diff is committed', () => {
        const repoRoot = makeTempRepo();
        initGitRepo(repoRoot);
        fs.appendFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const completedValue = 2;\n', 'utf8');
        seedStartedTask(repoRoot, TASK_ID);
        writeGitAutoPreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS });
        seedGitAutoCompilePass(repoRoot, TASK_ID);
        seedReviewGatePass(repoRoot, TASK_ID);
        seedDocImpactPass(repoRoot, TASK_ID);
        seedCompletionPass(repoRoot, TASK_ID);
        materializeFinalCloseout(repoRoot, TASK_ID);
        runGitFixtureCommand(repoRoot, ['add', 'src/app.ts']);
        runGitFixtureCommand(repoRoot, ['commit', '-m', 'commit completed scope']);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.status, 'DONE', result.reason);
        assert.equal(result.next_gate, null);
        assert.equal(result.commands.length, 0);
    });

    it('blocks a materialized completed task when committed audited content no longer matches', () => {
        const repoRoot = makeTempRepo();
        initGitRepo(repoRoot);
        fs.appendFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const completedValue = 2;\n', 'utf8');
        seedStartedTask(repoRoot, TASK_ID);
        writeGitAutoPreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS });
        seedGitAutoCompilePass(repoRoot, TASK_ID);
        seedReviewGatePass(repoRoot, TASK_ID);
        seedDocImpactPass(repoRoot, TASK_ID);
        seedCompletionPass(repoRoot, TASK_ID);
        materializeFinalCloseout(repoRoot, TASK_ID);
        runGitFixtureCommand(repoRoot, ['add', 'src/app.ts']);
        runGitFixtureCommand(repoRoot, ['commit', '-m', 'commit completed scope']);
        fs.appendFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const laterValue = 3;\n', 'utf8');
        runGitFixtureCommand(repoRoot, ['add', 'src/app.ts']);
        runGitFixtureCommand(repoRoot, ['commit', '-m', 'change completed scope later']);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.status, 'BLOCKED');
        assert.equal(result.next_gate, 'post-done-drift');
        assert.match(result.reason, /scope_content_sha256/);
    });

    it('blocks a materialized completed task when an audited scope hash is missing', () => {
        const repoRoot = makeTempRepo();
        initGitRepo(repoRoot);
        fs.appendFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const completedValue = 2;\n', 'utf8');
        seedStartedTask(repoRoot, TASK_ID);
        writeGitAutoPreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS });
        seedGitAutoCompilePass(repoRoot, TASK_ID);
        seedReviewGatePass(repoRoot, TASK_ID);
        seedDocImpactPass(repoRoot, TASK_ID);
        seedCompletionPass(repoRoot, TASK_ID);
        materializeFinalCloseout(repoRoot, TASK_ID);
        const closeoutPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-final-closeout.json`);
        const closeout = JSON.parse(fs.readFileSync(closeoutPath, 'utf8')) as Record<string, unknown>;
        delete (closeout.implementation_summary as Record<string, unknown>).scope_content_sha256;
        writeJson(closeoutPath, closeout);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.status, 'BLOCKED');
        assert.equal(result.next_gate, 'post-done-drift');
        assert.match(result.reason, /missing valid audited scope hashes/);
    });



    it('routes completed tasks to initial final closeout materialization despite tracked drift', () => {

        const repoRoot = makeTempRepo();

        initGitRepo(repoRoot);

        fs.appendFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const completedValue = 2;\n', 'utf8');

        seedStartedTask(repoRoot, TASK_ID);

        writeGitAutoPreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS });

        seedGitAutoCompilePass(repoRoot, TASK_ID);

        seedReviewGatePass(repoRoot, TASK_ID);

        seedDocImpactPass(repoRoot, TASK_ID);

        seedCompletionPass(repoRoot, TASK_ID);

        fs.writeFileSync(path.join(repoRoot, 'src', 'post-done-drift.ts'), 'export const drift = true;\n', 'utf8');



        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });



        assert.equal(result.status, 'READY');

        assert.equal(result.next_gate, 'task-audit-summary');

        assert.ok(result.commands[0].command.includes('gate task-audit-summary'));

        assert.match(result.reason, /final closeout artifacts are not materialized yet/i);

    });



    it('filters only a hash-identical authenticated dirty baseline after DONE', () => {

        const repoRoot = makeTempRepo();

        const fixture = seedCompletedTaskWithProtectedDirtyBaseline(repoRoot);



        const unchangedResult = resolveNextStep({ taskId: TASK_ID, repoRoot });



        assert.equal(unchangedResult.status, 'DONE', unchangedResult.reason);

        assert.equal(unchangedResult.next_gate, null);

        assert.doesNotMatch(unchangedResult.reason, /post-DONE workspace drift/i);

        fs.appendFileSync(fixture.baselinePath, 'export const postDoneDrift = 3;\n', 'utf8');
        const changedResult = resolveNextStep({ taskId: TASK_ID, repoRoot });
        assert.equal(changedResult.next_gate, 'post-done-drift');
        assert.match(changedResult.reason, /src\/local-baseline\.ts/);

        fs.writeFileSync(fixture.baselinePath, 'export const localBaseline = 1;\n', 'utf8');
        const restoredToHeadResult = resolveNextStep({ taskId: TASK_ID, repoRoot });
        assert.equal(restoredToHeadResult.next_gate, 'post-done-drift');
        assert.match(restoredToHeadResult.reason, /src\/local-baseline\.ts/);

        fs.writeFileSync(fixture.baselinePath, 'export const localBaseline = 2;\n', 'utf8');
        fs.unlinkSync(fixture.baselinePath);
        const deletedBaselineResult = resolveNextStep({ taskId: TASK_ID, repoRoot });
        assert.equal(deletedBaselineResult.next_gate, 'post-done-drift');
        assert.match(deletedBaselineResult.reason, /src\/local-baseline\.ts/);

        fs.writeFileSync(fixture.baselinePath, 'export const localBaseline = 2;\n', 'utf8');
        const preflight = JSON.parse(fs.readFileSync(fixture.preflightPath, 'utf8')) as Record<string, unknown>;
        preflight.detection_source = 'git_staged_only';
        preflight.include_untracked = false;
        writeJson(fixture.preflightPath, preflight);
        const newUntrackedPath = path.join(repoRoot, 'src', 'post-done-untracked.ts');
        fs.writeFileSync(newUntrackedPath, 'export const postDoneUntracked = true;\n', 'utf8');
        const newUntrackedResult = resolveNextStep({ taskId: TASK_ID, repoRoot });
        assert.equal(newUntrackedResult.next_gate, 'post-done-drift');
        assert.match(newUntrackedResult.reason, /src\/post-done-untracked\.ts/);

        fs.unlinkSync(newUntrackedPath);
        const preflightWithMissingHash = JSON.parse(fs.readFileSync(fixture.preflightPath, 'utf8')) as Record<string, unknown>;
        const triggers = preflightWithMissingHash.triggers as Record<string, unknown>;
        triggers.dirty_workspace_protected_files = ['src/local-baseline.ts', 'src/deleted-untracked.ts'];
        triggers.dirty_workspace_protected_file_hashes = {
            'src/local-baseline.ts': sha256Text(fs.readFileSync(fixture.baselinePath, 'utf8'))
        };
        writeJson(fixture.preflightPath, preflightWithMissingHash);
        const missingHashResult = resolveNextStep({ taskId: TASK_ID, repoRoot });
        assert.equal(missingHashResult.next_gate, 'post-done-drift');
        assert.match(missingHashResult.reason, /src\/deleted-untracked\.ts/);

        bindProtectedDirtyBaseline(
            fixture.preflightPath,
            'src/local-baseline.ts',
            sha256Text(fs.readFileSync(fixture.baselinePath, 'utf8'))
        );
        const preflightWithMalformedScopeHash = JSON.parse(
            fs.readFileSync(fixture.preflightPath, 'utf8')
        ) as Record<string, unknown>;
        (preflightWithMalformedScopeHash.triggers as Record<string, unknown>)
            .dirty_workspace_protected_files_sha256 = 'malformed';
        writeJson(fixture.preflightPath, preflightWithMalformedScopeHash);
        const malformedScopeHashResult = resolveNextStep({ taskId: TASK_ID, repoRoot });
        assert.equal(malformedScopeHashResult.next_gate, 'post-done-drift');
        assert.match(malformedScopeHashResult.reason, /src\/local-baseline\.ts/);

        bindProtectedDirtyBaseline(fixture.preflightPath, 'src/local-baseline.ts', 'malformed');
        const malformedHashResult = resolveNextStep({ taskId: TASK_ID, repoRoot });
        assert.equal(malformedHashResult.next_gate, 'post-done-drift');
        assert.match(malformedHashResult.reason, /src\/local-baseline\.ts/);

        bindProtectedDirtyBaseline(
            fixture.preflightPath,
            'src/local-baseline.ts',
            sha256Text(fs.readFileSync(fixture.baselinePath, 'utf8'))
        );
        const preflightWithEmptyProtectedScope = JSON.parse(
            fs.readFileSync(fixture.preflightPath, 'utf8')
        ) as Record<string, unknown>;
        (preflightWithEmptyProtectedScope.triggers as Record<string, unknown>)
            .dirty_workspace_protected_files = [];
        writeJson(fixture.preflightPath, preflightWithEmptyProtectedScope);
        const emptyProtectedScopeResult = resolveNextStep({ taskId: TASK_ID, repoRoot });
        assert.equal(emptyProtectedScopeResult.next_gate, 'post-done-drift');
        assert.match(emptyProtectedScopeResult.reason, /protected-baseline authentication failed/i);

    });

    it('blocks completed tasks on tracked post-DONE drift without reopening lifecycle gates', () => {

        const repoRoot = makeTempRepo();

        initGitRepo(repoRoot);

        fs.appendFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const completedValue = 2;\n', 'utf8');

        seedStartedTask(repoRoot, TASK_ID);

        writeGitAutoPreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS });

        seedGitAutoCompilePass(repoRoot, TASK_ID);

        seedReviewGatePass(repoRoot, TASK_ID);

        seedDocImpactPass(repoRoot, TASK_ID);

        seedCompletionPass(repoRoot, TASK_ID);

        materializeFinalCloseout(repoRoot, TASK_ID);

        fs.writeFileSync(path.join(repoRoot, 'src', 'post-done-drift.ts'), 'export const drift = true;\n', 'utf8');



        const { result, gitCommands } = captureGitCommands(() => (
            resolveNextStep({ taskId: TASK_ID, repoRoot })
        ));

        const text = formatNextStepText(result);



        assert.equal(result.status, 'BLOCKED');

        assert.equal(result.next_gate, 'post-done-drift');

        assert.equal(result.commands.length, 0);

        assert.match(result.reason, /Post-DONE workspace drift detected/);

        assert.match(result.reason, /src\/post-done-drift\.ts/);

        assert.match(result.reason, /Do not reopen stale lifecycle gates automatically/);

        assert.equal(text.includes('gate classify-change'), false);

        assert.equal(text.includes('gate compile-gate'), false);

        assert.equal(text.includes('gate full-suite-validation'), false);

        const gitAutoNumstatCommands = gitCommands.filter((args) => (
            args.includes('--numstat') && !args.includes('--')
        ));

        assert.equal(gitAutoNumstatCommands.length, 1);

    });

    it('blocks completed tasks on staged-only post-DONE drift without reopening lifecycle gates', () => {

        const repoRoot = makeTempRepo();

        initGitRepo(repoRoot);

        fs.appendFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const completedValue = 2;\n', 'utf8');

        seedStartedTask(repoRoot, TASK_ID);

        writeGitAutoPreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS });

        seedGitAutoCompilePass(repoRoot, TASK_ID);

        seedReviewGatePass(repoRoot, TASK_ID);

        seedDocImpactPass(repoRoot, TASK_ID);

        seedCompletionPass(repoRoot, TASK_ID);

        materializeFinalCloseout(repoRoot, TASK_ID);

        fs.writeFileSync(path.join(repoRoot, 'src', 'post-done-staged.ts'), 'export const stagedDrift = true;\n', 'utf8');

        runGitFixtureCommand(repoRoot, ['add', 'src/post-done-staged.ts']);



        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        const text = formatNextStepText(result);



        assert.equal(result.status, 'BLOCKED');

        assert.equal(result.next_gate, 'post-done-drift');

        assert.equal(result.commands.length, 0);

        assert.match(result.reason, /Post-DONE workspace drift detected/);

        assert.match(result.reason, /src\/post-done-staged\.ts/);

        assert.match(result.reason, /Commit or isolate the already-completed task diff/);

        assert.equal(text.includes('gate classify-change'), false);

        assert.equal(text.includes('gate compile-gate'), false);

        assert.equal(text.includes('gate full-suite-validation'), false);

    });

    it('allows completed staged-scope closeout after the staged diff is committed', () => {

        const repoRoot = makeTempRepo();

        initGitRepo(repoRoot);

        fs.appendFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const completedValue = 2;\n', 'utf8');

        runGitFixtureCommand(repoRoot, ['add', 'src/app.ts']);

        seedStartedTask(repoRoot, TASK_ID);

        writeStagedPreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS });

        seedStagedCompilePass(repoRoot, TASK_ID);

        seedReviewGatePass(repoRoot, TASK_ID);

        seedDocImpactPass(repoRoot, TASK_ID);

        seedCompletionPass(repoRoot, TASK_ID);

        materializeFinalCloseout(repoRoot, TASK_ID);

        runGitFixtureCommand(repoRoot, ['commit', '-m', 'complete staged task']);



        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });



        assert.equal(result.status, 'DONE', result.reason);

        assert.equal(result.next_gate, null);

        assert.match(result.reason, /canonical final closeout is materialized/i);

        assert.doesNotMatch(result.reason, /post-DONE workspace drift/i);

    });

    it('blocks completed staged-scope closeout on same-path worktree drift after DONE', () => {

        const repoRoot = makeTempRepo();

        initGitRepo(repoRoot);

        fs.appendFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const completedValue = 2;\n', 'utf8');

        runGitFixtureCommand(repoRoot, ['add', 'src/app.ts']);

        seedStartedTask(repoRoot, TASK_ID);

        writeStagedPreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS });

        seedStagedCompilePass(repoRoot, TASK_ID);

        seedReviewGatePass(repoRoot, TASK_ID);

        seedDocImpactPass(repoRoot, TASK_ID);

        seedCompletionPass(repoRoot, TASK_ID);

        materializeFinalCloseout(repoRoot, TASK_ID);

        runGitFixtureCommand(repoRoot, ['commit', '-m', 'complete staged task']);

        fs.appendFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const postDoneDrift = 3;\n', 'utf8');



        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });



        assert.equal(result.status, 'BLOCKED');

        assert.equal(result.next_gate, 'post-done-drift');

        assert.match(result.reason, /Tracked post-DONE workspace drift/);

        assert.match(result.reason, /src\/app\.ts/);

    });

    it('blocks completed staged-scope closeout on doc-impact audited drift after DONE', () => {

        const repoRoot = makeTempRepo();

        initGitRepo(repoRoot);

        fs.appendFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const completedValue = 2;\n', 'utf8');

        runGitFixtureCommand(repoRoot, ['add', 'src/app.ts']);

        seedStartedTask(repoRoot, TASK_ID);

        writeStagedPreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS });

        seedStagedCompilePass(repoRoot, TASK_ID);

        seedReviewGatePass(repoRoot, TASK_ID);

        fs.mkdirSync(path.join(repoRoot, 'docs'), { recursive: true });

        fs.writeFileSync(path.join(repoRoot, 'docs', 'cli-reference.md'), '# CLI\n\nDocumented closeout.\n', 'utf8');

        writeJson(path.join(reviewsRoot(repoRoot), `${TASK_ID}-doc-impact.json`), {
            task_id: TASK_ID,
            decision: 'DOCS_UPDATED',
            status: 'PASSED',
            outcome: 'PASS',
            docs_updated: ['docs/cli-reference.md'],
            behavior_changed: false,
            changelog_updated: false
        });

        appendEvent(repoRoot, TASK_ID, 'DOC_IMPACT_ASSESSED');

        seedCompletionPass(repoRoot, TASK_ID);

        materializeFinalCloseout(repoRoot, TASK_ID);

        fs.appendFileSync(path.join(repoRoot, 'docs', 'cli-reference.md'), '\nPost-DONE drift.\n', 'utf8');



        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });



        assert.equal(result.status, 'BLOCKED');

        assert.equal(result.next_gate, 'post-done-drift');

        assert.match(result.reason, /changed audited closeout extra scope/);

        assert.match(result.reason, /docs\/cli-reference\.md/);

    });



    it('blocks completed tasks on tracked same-path post-DONE implementation drift', () => {

        const repoRoot = makeTempRepo();

        initGitRepo(repoRoot);

        fs.appendFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const completedValue = 2;\n', 'utf8');

        seedStartedTask(repoRoot, TASK_ID);

        const preflightPath = writeGitAutoPreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS });

        const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;

        const metrics = preflight.metrics as Record<string, unknown>;

        delete metrics.scope_sha256;

        writeJson(preflightPath, preflight);

        seedGitAutoCompilePass(repoRoot, TASK_ID);

        seedReviewGatePass(repoRoot, TASK_ID);

        seedDocImpactPass(repoRoot, TASK_ID);

        seedCompletionPass(repoRoot, TASK_ID);

        materializeFinalCloseout(repoRoot, TASK_ID);

        fs.writeFileSync(

            path.join(repoRoot, 'src', 'app.ts'),

            'export const value = 1;\nexport const completedValue = 3;\n',

            'utf8'

        );



        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        const text = formatNextStepText(result);



        assert.equal(result.status, 'BLOCKED');

        assert.equal(result.next_gate, 'post-done-drift');

        assert.equal(result.commands.length, 0);

        assert.match(result.reason, /Tracked post-DONE workspace drift detected/);

        assert.match(result.reason, /src\/app\.ts/);

        assert.match(result.reason, /scope_content_sha256/);

        assert.equal(text.includes('gate classify-change'), false);

        assert.equal(text.includes('gate compile-gate'), false);

        assert.equal(text.includes('gate full-suite-validation'), false);

    });



    it('blocks completed tasks when post-DONE workspace inspection fails in a git worktree', () => {

        const repoRoot = makeTempRepo();

        seedStartedTask(repoRoot, TASK_ID);

        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS });

        seedCompilePass(repoRoot, TASK_ID);

        seedReviewGatePass(repoRoot, TASK_ID);

        seedDocImpactPass(repoRoot, TASK_ID);

        seedCompletionPass(repoRoot, TASK_ID);

        materializeFinalCloseout(repoRoot, TASK_ID);

        fs.rmSync(path.join(repoRoot, '.git'), { recursive: true, force: true });
        fs.mkdirSync(path.join(repoRoot, '.git'), { recursive: true });



        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });



        assert.equal(result.status, 'BLOCKED');

        assert.equal(result.next_gate, 'post-done-drift');

        assert.equal(result.commands.length, 0);

        assert.match(result.reason, /Unable to inspect tracked post-DONE workspace drift/);

    });



    it('allows completed task closeout when only ignored runtime artifacts changed after DONE', () => {

        const repoRoot = makeTempRepo();

        initGitRepo(repoRoot);

        fs.appendFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const completedValue = 2;\n', 'utf8');

        seedStartedTask(repoRoot, TASK_ID);

        writeGitAutoPreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS });

        seedGitAutoCompilePass(repoRoot, TASK_ID);

        seedReviewGatePass(repoRoot, TASK_ID);

        seedDocImpactPass(repoRoot, TASK_ID);

        seedCompletionPass(repoRoot, TASK_ID);

        materializeFinalCloseout(repoRoot, TASK_ID);

        fs.writeFileSync(

            path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews', 'ignored-local.tmp'),

            'local runtime evidence\n',

            'utf8'

        );



        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });



        assert.equal(result.status, 'DONE', result.reason);

        assert.equal(result.next_gate, null);

        assert.equal(result.commands.length, 0);

        assert.match(result.reason, /canonical final closeout is materialized/i);

    });



    it('does not let an old completion pass hide a restarted task cycle', () => {

        const repoRoot = makeTempRepo();

        seedStartedTask(repoRoot, TASK_ID);

        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS });

        seedCompilePass(repoRoot, TASK_ID);

        seedReviewGatePass(repoRoot, TASK_ID);

        seedDocImpactPass(repoRoot, TASK_ID);

        seedCompletionPass(repoRoot, TASK_ID);

        appendEvent(repoRoot, TASK_ID, 'TASK_MODE_ENTERED', 'PASS', {

            restarted: true

        });



        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });



        assert.notEqual(result.status, 'DONE');

        assert.equal(result.next_gate, 'load-rule-pack');

        assert.ok(result.reason.includes('latest TASK_MODE_ENTERED'));

    });

});
