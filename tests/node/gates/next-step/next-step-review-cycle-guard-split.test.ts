import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fx from './next-step-review-cycle-fixtures';
import { initGitRepo, runGitFixtureCommand } from '../git-fixtures';
import {
    materializeSplitRequiredLatch
} from '../../../../src/gates/next-step/next-step-split-required-latch';
import {
    materializeReviewCycleAutoSplitPrompt,
    readReviewCycleGuardEvaluation
} from '../../../../src/gates/next-step/next-step-review-cycle-guard';

const {
    ALL_REVIEW_FLAGS,
    appendEvent,
    buildReviewContextScopeFixture,
    eventsRoot,
    buildDefaultWorkflowConfig,
    resolveNextStep,
    formatNextStepText,
    EXPECTED_LOOP_LINE,
    fileSha256,
    fs,
    getLoadedRuleFileBasenames,
    hasCompletedDecomposedParentAfterSplitRequiredClear,
    hasSplitRequiredClearedEvidence,
    launchInputEvidenceFixture,
    makeTempRepo,
    markReviewEvidenceAsStrictReuse,
    materializeFinalCloseout,
    NEXT_STEP_FULL_SUITE_TEST_CONFIG,
    normalizeForTimeline,
    os,
    path,
    PROVIDER_ENV_KEYS,
    readReviewContextTreeStateSha256,
    readSplitRequiredLatchEvidence,
    requireFromTest,
    resolveReviewCycleContinuationArtifactPath,
    resolveSplitRequiredArtifactPath,
    reviewsRoot,
    runRecordReviewCycleSplitDecisionCommand,
    seedCompilePass,
    seedCompletedReviewerLaunchAndInvocation,
    seedCompletedTaskWithIndependentCodeReview,
    seedCompletionPass,
    seedCustomStartedTask,
    seedDocImpactPass,
    seedFullSuiteValidation,
    seedGitAutoCompilePass,
    seedHandshake,
    seedPostPreflightRulePack,
    seedProjectMemory,
    seedProjectMemoryImpact,
    seedReviewGatePass,
    seedRulePack,
    seedShellSmoke,
    seedSourceCheckoutRuntime,
    seedSplitRequiredLatchEvidence,
    seedStartedTask,
    seedTaskModeOnly,
    sha256Text,
    TASK_ID,
    tempRoots,
    withProviderEnv,
    writeFreshReviewContextWithoutRouting,
    writeGitAutoPreflight,
    writeJson,
    writeJsonWithSha,
    writeNoOpEvidence,
    writePreflight,
    writeProjectMemoryWorkflowConfig,
    writeReviewContextOnly,
    writeReviewCycleContinuation,
    writeReviewEvidence,
    writeStrictDecompositionDecision,
    writeStrictIndependentCodeReviewEvidence
} = fx;
void [ALL_REVIEW_FLAGS, appendEvent, buildReviewContextScopeFixture, eventsRoot, buildDefaultWorkflowConfig, resolveNextStep, formatNextStepText, EXPECTED_LOOP_LINE, fileSha256, fs, getLoadedRuleFileBasenames, hasCompletedDecomposedParentAfterSplitRequiredClear, hasSplitRequiredClearedEvidence, launchInputEvidenceFixture, makeTempRepo, markReviewEvidenceAsStrictReuse, materializeFinalCloseout, NEXT_STEP_FULL_SUITE_TEST_CONFIG, normalizeForTimeline, os, path, PROVIDER_ENV_KEYS, readReviewContextTreeStateSha256, readSplitRequiredLatchEvidence, requireFromTest, resolveReviewCycleContinuationArtifactPath, resolveSplitRequiredArtifactPath, reviewsRoot, runRecordReviewCycleSplitDecisionCommand, seedCompilePass, seedCompletedReviewerLaunchAndInvocation, seedCompletedTaskWithIndependentCodeReview, seedCompletionPass, seedCustomStartedTask, seedDocImpactPass, seedFullSuiteValidation, seedGitAutoCompilePass, seedHandshake, seedPostPreflightRulePack, seedProjectMemory, seedProjectMemoryImpact, seedReviewGatePass, seedRulePack, seedShellSmoke, seedSourceCheckoutRuntime, seedSplitRequiredLatchEvidence, seedStartedTask, seedTaskModeOnly, sha256Text, TASK_ID, tempRoots, withProviderEnv, writeFreshReviewContextWithoutRouting, writeGitAutoPreflight, writeJson, writeJsonWithSha, writeNoOpEvidence, writePreflight, writeProjectMemoryWorkflowConfig, writeReviewContextOnly, writeReviewCycleContinuation, writeReviewEvidence, writeStrictDecompositionDecision, writeStrictIndependentCodeReviewEvidence];

function appendRecordedReviewCycleAttempt(repoRoot: string, reviewType: string): void {
    appendEvent(repoRoot, TASK_ID, 'REVIEW_RECORDED', 'PASS', {
        review_type: reviewType,
        reviewer_identity: `agent:${reviewType}-reviewer`,
        review_context_sha256: sha256Text(`review-recorded:${TASK_ID}:${reviewType}`)
    });
}

describe('gates/next-step review cycle guard split', () => {
    it('offers a task-scoped one-shot continuation instead of recommending permanent workflow-config mutation', () => {
        const repoRoot = makeTempRepo();
        const workflowConfig = buildDefaultWorkflowConfig();
        workflowConfig.full_suite_validation.enabled = false;
        workflowConfig.review_execution_policy = { mode: 'code_first_optional' };
        workflowConfig.review_cycle_guard.max_total_non_test_reviews = 2;
        workflowConfig.review_cycle_guard.auto_split_enabled = false;
        writeJson(path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json'), workflowConfig);
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        for (let index = 0; index < 2; index += 1) {
            appendEvent(repoRoot, TASK_ID, 'REVIEW_RECORDED', 'PASS', {
                review_type: 'code',
                reviewer_identity: `agent:code-one-shot-offer-${index}`,
                review_context_sha256: sha256Text(`code-one-shot-offer-${index}`)
            });
        }
        appendEvent(repoRoot, TASK_ID, 'REVIEW_RECORDED', 'FAIL', {
            review_type: 'code',
            reviewer_identity: 'agent:code-one-shot-offer-fail',
            review_context_sha256: sha256Text('code-one-shot-offer-fail'),
            summary: 'failed after reaching the review-cycle total limit'
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const text = formatNextStepText(result);

        assert.equal(result.next_gate, 'review-cycle-attempt-guard');
        assert.equal(result.commands[0]?.label, 'Record one-shot review-cycle continuation');
        assert.match(result.commands[0]?.command || '', /gate record-review-cycle-continuation/);
        assert.match(result.commands[0]?.command || '', /--decision "allow_one_more_cycle"/);
        assert.match(result.commands[0]?.command || '', /--baseline-total-non-test-reviews "3"/);
        assert.match(result.commands[0]?.command || '', /--baseline-failed-non-test-reviews "1"/);
        assert.ok(text.includes('allow_one_more_cycle: task-scoped one-shot runtime approval'));
        assert.ok(text.includes('raise_limits: permanent repo-local workflow-config change through workflow set'));
        assert.ok(text.includes('does not edit workflow-config.json'));
    });

    it('does not auto-split successful PASS attempts while the current sequential review phase is pending', () => {
        const repoRoot = makeTempRepo();
        const workflowConfig = buildDefaultWorkflowConfig();
        workflowConfig.full_suite_validation.enabled = false;
        workflowConfig.review_execution_policy = { mode: 'strict_sequential' };
        workflowConfig.review_cycle_guard.max_total_non_test_reviews = 2;
        workflowConfig.review_cycle_guard.auto_split_enabled = true;
        writeJson(path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json'), workflowConfig);
        seedStartedTask(repoRoot, TASK_ID);
        const preflightPath = writePreflight(
            repoRoot,
            TASK_ID,
            {
                ...ALL_REVIEW_FLAGS,
                code: true,
                security: true,
                refactor: true,
                api: true,
                performance: true,
                test: true
            },
            { reviewPolicyMode: 'strict_sequential' }
        );
        seedCompilePass(repoRoot, TASK_ID, preflightPath);
        writeReviewEvidence(repoRoot, TASK_ID, 'code');
        appendRecordedReviewCycleAttempt(repoRoot, 'code');
        writeReviewEvidence(repoRoot, TASK_ID, 'security');
        appendRecordedReviewCycleAttempt(repoRoot, 'security');
        writeReviewEvidence(repoRoot, TASK_ID, 'refactor');
        appendRecordedReviewCycleAttempt(repoRoot, 'refactor');
        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const text = formatNextStepText(result);

        assert.notEqual(result.status, 'SPLIT_REQUIRED');
        assert.notEqual(result.next_gate, 'split-required-latch');
        assert.notEqual(result.next_gate, 'review-cycle-attempt-guard');
        assert.equal(result.review_cycle_block, null);
        assert.equal(text.includes('Review cycle one-shot continuation active'), false);
        assert.ok(text.includes('api'));
        assert.equal(fs.existsSync(path.join(reviewsRoot(repoRoot), `${TASK_ID}-split-required.json`)), false);
        assert.equal(fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8').includes(`| ${TASK_ID} | 🟫 SPLIT_REQUIRED |`), false);
        assert.equal(result.review.next_review_type, 'api');
    });

    it('consumes one-shot continuation after the current sequential review phase completes', () => {
        const repoRoot = makeTempRepo();
        const workflowConfig = buildDefaultWorkflowConfig();
        workflowConfig.full_suite_validation.enabled = false;
        workflowConfig.review_execution_policy = { mode: 'strict_sequential' };
        workflowConfig.review_cycle_guard.max_total_non_test_reviews = 2;
        workflowConfig.review_cycle_guard.auto_split_enabled = true;
        writeJson(path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json'), workflowConfig);
        seedStartedTask(repoRoot, TASK_ID);
        const preflightPath = writePreflight(
            repoRoot,
            TASK_ID,
            {
                ...ALL_REVIEW_FLAGS,
                code: true,
                security: true,
                refactor: true,
                test: true
            },
            { reviewPolicyMode: 'strict_sequential' }
        );
        seedCompilePass(repoRoot, TASK_ID, preflightPath);
        writeReviewEvidence(repoRoot, TASK_ID, 'code');
        appendRecordedReviewCycleAttempt(repoRoot, 'code');
        writeReviewEvidence(repoRoot, TASK_ID, 'security');
        appendRecordedReviewCycleAttempt(repoRoot, 'security');
        writeReviewEvidence(repoRoot, TASK_ID, 'refactor');
        appendRecordedReviewCycleAttempt(repoRoot, 'refactor');
        writeReviewEvidence(repoRoot, TASK_ID, 'test');

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const text = formatNextStepText(result);

        assert.notEqual(result.status, 'SPLIT_REQUIRED');
        assert.notEqual(result.next_gate, 'split-required-latch');
        assert.notEqual(result.next_gate, 'review-cycle-attempt-guard');
        assert.equal(result.review_cycle_block, null);
        assert.equal(result.review.next_review_type, null);
        assert.equal(text.includes('completed the required review phase'), false);
        assert.equal(text.includes('allow_one_more_cycle'), false);
        assert.equal(fs.existsSync(path.join(reviewsRoot(repoRoot), `${TASK_ID}-split-required.json`)), false);
        assert.equal(fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8').includes(`| ${TASK_ID} | 🟫 SPLIT_REQUIRED |`), false);
    });

    it('expires one-shot continuation after a failed non-test review even with pending review lanes', () => {
        const repoRoot = makeTempRepo();
        const workflowConfig = buildDefaultWorkflowConfig();
        workflowConfig.full_suite_validation.enabled = false;
        workflowConfig.review_execution_policy = { mode: 'strict_sequential' };
        workflowConfig.review_cycle_guard.max_total_non_test_reviews = 2;
        workflowConfig.review_cycle_guard.max_failed_non_test_reviews = 1;
        workflowConfig.review_cycle_guard.auto_split_enabled = true;
        writeJson(path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json'), workflowConfig);
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, {
            ...ALL_REVIEW_FLAGS,
            code: true,
            security: true,
            refactor: true,
            api: true,
            test: true
        }, {
            reviewPolicyMode: 'strict_sequential'
        });
        seedCompilePass(repoRoot, TASK_ID);
        writeReviewEvidence(repoRoot, TASK_ID, 'code');
        writeReviewEvidence(repoRoot, TASK_ID, 'security');
        writeReviewCycleContinuation(repoRoot, TASK_ID, {
            baselineTotalNonTestReviewCount: 2,
            baselineFailedNonTestReviewCount: 0,
            maxTotalNonTestReviews: 2,
            maxFailedNonTestReviews: 1
        });
        writeReviewEvidence(repoRoot, TASK_ID, 'refactor', { verdict: 'fail' });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'implementation');
        assert.equal(result.review_cycle_block?.choices.includes('allow_one_more_cycle') ?? false, false);
    });

    it('offers an explicit manual split gate when review-cycle blocks with auto split disabled', () => {
        const repoRoot = makeTempRepo();
        const workflowConfig = buildDefaultWorkflowConfig();
        workflowConfig.full_suite_validation.enabled = false;
        workflowConfig.review_execution_policy = { mode: 'code_first_optional' };
        workflowConfig.review_cycle_guard.max_total_non_test_reviews = 2;
        workflowConfig.review_cycle_guard.auto_split_enabled = false;
        writeJson(path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json'), workflowConfig);
        seedStartedTask(repoRoot, TASK_ID);
        const preflightPath = writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        for (let index = 0; index < 2; index += 1) {
            appendEvent(repoRoot, TASK_ID, 'REVIEW_RECORDED', 'PASS', {
                review_type: 'code',
                reviewer_identity: `agent:manual-split-offer-${index}`,
                review_context_sha256: sha256Text(`manual-split-offer-${index}`)
            });
        }
        appendEvent(repoRoot, TASK_ID, 'REVIEW_RECORDED', 'FAIL', {
            review_type: 'code',
            reviewer_identity: 'agent:manual-split-offer-fail',
            review_context_sha256: sha256Text('manual-split-offer-fail'),
            summary: 'failed after reaching the review-cycle total limit'
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const text = formatNextStepText(result);

        assert.equal(result.status, 'BLOCKED');
        assert.equal(result.next_gate, 'review-cycle-attempt-guard');
        assert.equal(result.commands[1]?.label, 'Record review-cycle split decision');
        assert.match(result.commands[1]?.command || '', /gate record-review-cycle-split-decision/);
        assert.match(result.commands[1]?.command || '', /--decision "split_task"/);
        assert.ok(result.commands[1]?.command.includes(path.relative(repoRoot, preflightPath).replace(/\\/g, '/')));
        assert.ok(text.includes('Record review-cycle split decision'));
        assert.ok(text.includes('split_task/create_follow_up_tasks: decompose work into child or follow-up tasks'));
    });

    it('records a manual review-cycle split latch and keeps stale parent preflight suppressed', () => {
        const repoRoot = makeTempRepo();
        const workflowConfig = buildDefaultWorkflowConfig();
        workflowConfig.full_suite_validation.enabled = false;
        workflowConfig.review_execution_policy = { mode: 'code_first_optional' };
        workflowConfig.review_cycle_guard.max_total_non_test_reviews = 2;
        workflowConfig.review_cycle_guard.auto_split_enabled = false;
        writeJson(path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json'), workflowConfig);
        seedStartedTask(repoRoot, TASK_ID);
        const taskPath = path.join(repoRoot, 'TASK.md');
        fs.writeFileSync(
            taskPath,
            fs.readFileSync(taskPath, 'utf8').replace(`| ${TASK_ID} | TODO |`, `| ${TASK_ID} | IN_PROGRESS |`),
            'utf8'
        );
        const preflightPath = writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        for (let index = 0; index < 3; index += 1) {
            appendEvent(repoRoot, TASK_ID, 'REVIEW_RECORDED', 'PASS', {
                review_type: 'code',
                reviewer_identity: `agent:manual-split-latch-${index}`,
                review_context_sha256: sha256Text(`manual-split-latch-${index}`)
            });
        }

        const commandResult = runRecordReviewCycleSplitDecisionCommand({
            taskId: TASK_ID,
            decision: 'split_task',
            reason: 'Operator chose to split the task after review-cycle exhaustion.',
            preflightPath,
            baselineTotalNonTestReviewCount: 3,
            baselineFailedNonTestReviewCount: 0,
            maxTotalNonTestReviews: 2,
            maxFailedNonTestReviews: 15,
            excludedReviewTypes: ['test'],
            operatorConfirmed: 'yes',
            operatorConfirmedAtUtc: new Date().toISOString(),
            repoRoot
        });
        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const value = 2;\n', 'utf8');

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const taskMd = fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8');
        const events = fs.readFileSync(path.join(eventsRoot(repoRoot), `${TASK_ID}.jsonl`), 'utf8');

        assert.equal(commandResult.exitCode, 0);
        assert.equal(result.status, 'SPLIT_REQUIRED', result.reason);
        assert.equal(result.next_gate, 'split-required-latch');
        assert.equal(result.commands.length, 0);
        assert.ok(result.reason.includes(`TASK.md marks "${TASK_ID}" as SPLIT_REQUIRED`));
        assert.ok(result.reason.includes('cannot continue through classify, compile, review, full-suite, completion, or final closeout gates'));
        assert.ok(taskMd.includes(`| ${TASK_ID} | 🟫 SPLIT_REQUIRED |`));
        assert.ok(events.includes('"event_type":"REVIEW_CYCLE_SPLIT_DECISION_RECORDED"'));
        assert.ok(events.includes('"event_type":"SPLIT_REQUIRED_LATCHED"'));
        assert.equal(fs.existsSync(path.join(reviewsRoot(repoRoot), `${TASK_ID}-review-cycle-split-decision.json`)), true);
        assert.equal(fs.existsSync(path.join(reviewsRoot(repoRoot), `${TASK_ID}-split-required.json`)), true);
    });

    it('transitions a manually split review-cycle parent to decomposed when linked child rows already exist', () => {
        const repoRoot = makeTempRepo();
        const workflowConfig = buildDefaultWorkflowConfig();
        workflowConfig.full_suite_validation.enabled = false;
        workflowConfig.review_execution_policy = { mode: 'code_first_optional' };
        workflowConfig.review_cycle_guard.max_total_non_test_reviews = 2;
        workflowConfig.review_cycle_guard.auto_split_enabled = false;
        writeJson(path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json'), workflowConfig);
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '# TASK.md',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            `| ${TASK_ID} | IN_PROGRESS | P1 | workflow/review-cycle | Parent | gpt-5.4 | 2026-05-05 | strict | Split into child tasks \`${TASK_ID}-1\` and \`${TASK_ID}-2\`; do not continue the parent. |`,
            `| ${TASK_ID}-1 | TODO | P1 | workflow/review-cycle-state | Normalize guard state | gpt-5.4 | 2026-05-05 | strict | First logical work package. |`,
            `| ${TASK_ID}-2 | TODO | P1 | workflow/review-cycle-routing | Route guarded continuation | gpt-5.4 | 2026-05-05 | strict | Second logical work package. |`,
            ''
        ].join('\n'), 'utf8');
        seedStartedTask(repoRoot, TASK_ID);
        const preflightPath = writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        for (let index = 0; index < 3; index += 1) {
            appendEvent(repoRoot, TASK_ID, 'REVIEW_RECORDED', 'PASS', {
                review_type: 'code',
                reviewer_identity: `agent:manual-split-decomposed-${index}`,
                review_context_sha256: sha256Text(`manual-split-decomposed-${index}`)
            });
        }

        const commandResult = runRecordReviewCycleSplitDecisionCommand({
            taskId: TASK_ID,
            decision: 'create_follow_up_tasks',
            reason: 'Operator chose to split into child tasks after review-cycle exhaustion.',
            preflightPath,
            baselineTotalNonTestReviewCount: 3,
            baselineFailedNonTestReviewCount: 0,
            maxTotalNonTestReviews: 2,
            maxFailedNonTestReviews: 15,
            excludedReviewTypes: ['test'],
            operatorConfirmed: 'yes',
            operatorConfirmedAtUtc: new Date().toISOString(),
            repoRoot
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const taskMd = fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8');
        const events = fs.readFileSync(path.join(eventsRoot(repoRoot), `${TASK_ID}.jsonl`), 'utf8');

        assert.equal(commandResult.exitCode, 0);
        assert.equal(result.status, 'DECOMPOSED', result.reason);
        assert.equal(result.next_gate, 'child-task');
        assert.ok(result.commands[0]?.command.includes(`next-step "${TASK_ID}-1"`));
        assert.ok(taskMd.includes(`| ${TASK_ID} | 🟪 DECOMPOSED |`));
        assert.ok(events.includes('"event_type":"SPLIT_REQUIRED_CLEARED"'));
    });

    it('rejects one-shot continuation artifact paths outside the repo root', () => {
        const repoRoot = makeTempRepo();
        const outsidePath = path.join(path.dirname(repoRoot), 'outside-review-cycle-continuation.json');

        assert.throws(
            () => resolveReviewCycleContinuationArtifactPath(repoRoot, TASK_ID, outsidePath),
            /Path must stay inside repo root/
        );
    });

    it('rejects one-shot continuation artifact paths outside runtime review evidence', () => {
        const repoRoot = makeTempRepo();

        assert.throws(
            () => resolveReviewCycleContinuationArtifactPath(
                repoRoot,
                TASK_ID,
                path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json')
            ),
            /runtime review evidence directory/
        );
    });

    it('rejects one-shot continuation artifact paths that escape the repo through realpath links', () => {
        const repoRoot = makeTempRepo();
        const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-review-cycle-continuation-'));
        const linkDir = path.join(reviewsRoot(repoRoot), 'linked-outside');
        try {
            fs.symlinkSync(outsideDir, linkDir, process.platform === 'win32' ? 'junction' : 'dir');
        } catch (error: unknown) {
            if ((error as NodeJS.ErrnoException).code === 'EPERM') {
                return;
            }
            throw error;
        }

        assert.throws(
            () => resolveReviewCycleContinuationArtifactPath(repoRoot, TASK_ID, path.join(linkDir, 'artifact.json')),
            /runtime review evidence directory/
        );
    });

    it('latches split-required and materializes auto-split prompt when review cycle auto split is enabled', () => {
        const repoRoot = makeTempRepo();
        const fullSuiteCommand = 'node scripts/node-foundation/build-scripts.cjs test.js tests/node/gates/next-step/next-step-review-cycle-guard-split.test.ts';
        writeJson(
            path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json'),
            {
                full_suite_validation: {
                    enabled: false,
                    command: fullSuiteCommand,
                    timeout_ms: 600000,
                    green_summary_max_lines: 5,
                    red_failure_chunk_lines: 50,
                    out_of_scope_failure_policy: 'AUDIT_AND_BLOCK'
                },
                review_execution_policy: {
                    mode: 'code_first_optional'
                },
                review_cycle_guard: {
                    enabled: true,
                    action: 'BLOCK_FOR_OPERATOR_DECISION',
                    max_failed_non_test_reviews: 1,
                    max_total_non_test_reviews: 15,
                    excluded_review_types: ['test'],
                    auto_split_enabled: true
                }
            }
        );
        seedStartedTask(repoRoot, TASK_ID);
        initGitRepo(repoRoot);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true }, { changedFiles: [] });
        appendEvent(repoRoot, TASK_ID, 'REVIEW_RECORDED', 'FAIL', {
            review_type: 'code',
            reviewer_identity: 'agent:auto-split-code-0',
            review_context_sha256: sha256Text('auto-split-code-context-0'),
            summary: 'first code failure'
        });
        appendEvent(repoRoot, TASK_ID, 'REVIEW_RECORDED', 'FAIL', {
            review_type: 'code',
            reviewer_identity: 'agent:auto-split-code-1',
            review_context_sha256: sha256Text('auto-split-code-context-1'),
            summary: 'second code failure'
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const text = formatNextStepText(result);

        assert.equal(result.status, 'SPLIT_REQUIRED', result.reason);
        assert.equal(result.next_gate, 'split-required-latch');
        assert.equal(result.commands.length, 0);
        assert.equal(result.review_cycle_block?.operator_decision_required, false);
        assert.equal(result.review_cycle_block?.wait_for_operator, false);
        assert.equal(result.review_cycle_block?.auto_split_enabled, true);
        assert.equal(result.review_cycle_block?.auto_split_prompt?.next_action, 'follow_auto_split_prompt');
        const promptPath = path.join(repoRoot, result.review_cycle_block?.auto_split_prompt?.artifact_path || '');
        assert.equal(fs.existsSync(promptPath), true);
        const promptText = fs.readFileSync(promptPath, 'utf8');
        assert.ok(promptText.includes(`# Review Cycle Auto-Split Prompt for ${TASK_ID}`));
        assert.ok(promptText.includes('GuardReason: "Review cycle guard: BLOCK_FOR_OPERATOR_DECISION'));
        assert.equal(promptText.includes('failed_non_test_review_count=2>=1'), false);
        assert.ok(promptText.includes('summary="second code failure"'));
        assert.ok(promptText.includes(`SuggestedChildTaskIds: \`${TASK_ID}-1\`, \`${TASK_ID}-2\`, \`${TASK_ID}-3\``));
        assert.ok(promptText.includes(`SuggestedReviewerFollowUpTaskId: \`${TASK_ID}-F1\``));
        assert.ok(promptText.includes('parent-derived suffix task IDs'));
        assert.ok(promptText.includes('Before entering any ordinary child task, inspect the configured `workflow-config.full_suite_validation.command` against that child scope.'));
        assert.ok(promptText.includes('keep current-child tests covered, exclude suspended sibling tests, and leave an already-suitable command unchanged'));
        assert.ok(promptText.includes('Do not auto-edit workflow config, broaden a focused child test command to all project tests, skip operator approval for protected config changes, or retarget full-suite validation during an active child cycle.'));
        assert.equal(promptText.includes('normal numeric task IDs'), false);
        assert.ok(promptText.includes('DECOMPOSED'));
        assert.ok(text.includes('Status: SPLIT_REQUIRED'));
        assert.ok(text.includes('NextGate: split-required-latch'));
        assert.ok(text.includes('OperatorDecisionRequired: false'));
        assert.ok(text.includes('AutoSplitPromptArtifact: path='));
        assert.ok(text.includes('follow AutoSplitPromptArtifact instructions'));
        assert.equal(text.includes('wait for operator choice'), false);
        assert.ok(fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8').includes(`| ${TASK_ID} | 🟫 SPLIT_REQUIRED |`));
        const latchPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-split-required.json`);
        assert.equal(fs.existsSync(latchPath), true);
        const latch = JSON.parse(fs.readFileSync(latchPath, 'utf8')) as Record<string, unknown>;
        assert.equal(latch.guard_kind, 'review_cycle');
        const latchSha256 = fileSha256(latchPath);
        assert.ok(promptText.includes(`LatchArtifact: path=${normalizeForTimeline(latchPath)}; sha256=${latchSha256}`));
        assert.ok(promptText.includes('WipCapture: status=CAPTURED; manifest='));
        assert.ok(promptText.includes('captured_files=none'));
        assert.ok(promptText.includes('CurrentState: no_diff'));
        assert.ok(promptText.includes('NextAction: run_validation_lane'));
        assert.ok(promptText.includes(`NextActionCommand: \`${fullSuiteCommand}\``));
        assert.ok(promptText.includes(`StateRoute[validation_lane]: next_action=run_validation_lane; command=\`${fullSuiteCommand}\``));
        assert.equal(promptText.includes('gate run-intermediate-command'), false);
        assert.ok(promptText.includes('do not wrap it in `run-intermediate-command`'));
        assert.ok(promptText.includes(`WorkPackageContractPath: \`garda-agent-orchestrator/runtime/reviews/${TASK_ID}-work-package-contract.json\``));
        for (const state of ['no_diff', 'suspended_manifest', 'checkpoint', 'restore', 'validation_lane', 'child_creation']) {
            assert.ok(promptText.includes(`StateRoute[${state}]:`), `missing state route ${state}`);
        }
        assert.match(promptText, /StateRoute\[restore\]:[^\n]*--include-path "<repo\/path>"/u);
        assert.equal(promptText.includes('If the workspace contains parent diff, create a split checkpoint'), false);
        assert.equal(promptText.includes('create a split checkpoint before child execution'), false);
    });

    it('recovers an already-captured parent WIP manifest without creating a redundant checkpoint', () => {
        const repoRoot = makeTempRepo();
        const workflowConfig = buildDefaultWorkflowConfig();
        workflowConfig.full_suite_validation.enabled = true;
        workflowConfig.full_suite_validation.command = 'npm test -- captured-parent';
        workflowConfig.review_execution_policy = { mode: 'code_first_optional' };
        workflowConfig.review_cycle_guard.max_failed_non_test_reviews = 1;
        workflowConfig.review_cycle_guard.auto_split_enabled = true;
        writeJson(
            path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json'),
            workflowConfig
        );
        seedStartedTask(repoRoot, TASK_ID);
        initGitRepo(repoRoot);
        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const value = 2;\n', 'utf8');
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        appendEvent(repoRoot, TASK_ID, 'REVIEW_RECORDED', 'FAIL', {
            review_type: 'code',
            reviewer_identity: 'agent:auto-split-captured-code-0',
            review_context_sha256: sha256Text('auto-split-captured-code-context-0')
        });
        appendEvent(repoRoot, TASK_ID, 'REVIEW_RECORDED', 'FAIL', {
            review_type: 'code',
            reviewer_identity: 'agent:auto-split-captured-code-1',
            review_context_sha256: sha256Text('auto-split-captured-code-context-1')
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const promptPath = path.join(repoRoot, result.review_cycle_block?.auto_split_prompt?.artifact_path || '');
        const promptText = fs.readFileSync(promptPath, 'utf8');
        const latchPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-split-required.json`);
        const latch = JSON.parse(fs.readFileSync(latchPath, 'utf8')) as {
            wip_capture?: {
                status?: string;
                manifest_path?: string;
                manifest_sha256?: string;
                tracked_files?: string[];
            };
        };

        assert.equal(result.status, 'SPLIT_REQUIRED');
        assert.equal(result.review_cycle_block?.auto_split_prompt?.current_state, 'suspended_manifest');
        assert.equal(result.review_cycle_block?.auto_split_prompt?.wip_capture_status, 'CAPTURED');
        assert.equal(latch.wip_capture?.status, 'CAPTURED');
        assert.ok(latch.wip_capture?.manifest_path);
        assert.ok(latch.wip_capture?.manifest_sha256);
        assert.deepEqual(latch.wip_capture?.tracked_files, ['src/app.ts']);
        assert.equal(runGitFixtureCommand(repoRoot, ['status', '--short', '--', 'src/app.ts']).stdout.trim(), '');
        assert.ok(promptText.includes('CurrentState: suspended_manifest'));
        assert.ok(promptText.includes('captured_files=src/app.ts'));
        assert.ok(promptText.includes('NextAction: preview_restore'));
        assert.ok(promptText.includes('gate restore-split-required-wip'));
        assert.ok(promptText.includes('--dry-run'));
        assert.ok(promptText.includes('The parent implementation is suspended in the manifest and the captured paths were removed from the worktree.'));
        assert.equal(promptText.includes('If the workspace contains parent diff, create a split checkpoint'), false);
        assert.equal(promptText.includes('create a split checkpoint before child execution'), false);

        const preflightPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-preflight.json`);
        const reviewCycleGuard = readReviewCycleGuardEvaluation(repoRoot, eventsRoot(repoRoot), TASK_ID);
        const rerunLatch = materializeSplitRequiredLatch({
            repoRoot,
            eventsRoot: eventsRoot(repoRoot),
            reviewsRoot: reviewsRoot(repoRoot),
            taskId: TASK_ID,
            guardKind: 'review_cycle',
            guardReason: 'Review cycle guard recovery rerun.',
            rawGuardSummary: 'review cycle guard recovery rerun',
            preflightPath,
            guardDetails: { action: 'BLOCK_FOR_OPERATOR_DECISION' }
        });
        const rerunPrompt = materializeReviewCycleAutoSplitPrompt({
            repoRoot,
            reviewsRoot: reviewsRoot(repoRoot),
            taskId: TASK_ID,
            evaluation: reviewCycleGuard.evaluation,
            latestFailedReview: reviewCycleGuard.latestFailedReview,
            latchResult: rerunLatch,
            cliPrefix: 'node bin/garda.js',
            fullSuiteCommand: workflowConfig.full_suite_validation.command
        });
        const rerunPromptText = fs.readFileSync(path.join(repoRoot, rerunPrompt.artifact_path), 'utf8');

        assert.equal(rerunLatch.wip_capture?.status, 'ALREADY_CAPTURED');
        assert.equal(rerunLatch.wip_capture?.manifest_path, latch.wip_capture?.manifest_path);
        assert.equal(rerunLatch.wip_capture?.manifest_sha256, latch.wip_capture?.manifest_sha256);
        assert.equal(rerunPrompt.wip_capture_status, 'ALREADY_CAPTURED');
        assert.equal(rerunPrompt.wip_manifest_path, latch.wip_capture?.manifest_path);
        assert.equal(rerunPrompt.current_state, 'suspended_manifest');
        assert.equal(rerunPrompt.state_next_action, 'preview_restore');
        assert.ok(rerunPrompt.next_action_command.includes('gate restore-split-required-wip'));
        assert.ok(rerunPrompt.next_action_command.includes('--dry-run'));
        assert.ok(rerunPromptText.includes(`WipCapture: status=ALREADY_CAPTURED; manifest=${latch.wip_capture?.manifest_path}; captured_files=src/app.ts`));
        assert.equal(runGitFixtureCommand(repoRoot, ['status', '--short', '--', 'src/app.ts']).stdout.trim(), '');
    });

    it('auto-split prompt suggests the next available parent-derived child and follow-up ids', () => {
        const repoRoot = makeTempRepo();
        writeJson(
            path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json'),
            {
                full_suite_validation: {
                    enabled: false,
                    command: 'npm test',
                    timeout_ms: 600000,
                    green_summary_max_lines: 5,
                    red_failure_chunk_lines: 50,
                    out_of_scope_failure_policy: 'AUDIT_AND_BLOCK'
                },
                review_execution_policy: {
                    mode: 'code_first_optional'
                },
                review_cycle_guard: {
                    enabled: true,
                    action: 'BLOCK_FOR_OPERATOR_DECISION',
                    max_failed_non_test_reviews: 1,
                    max_total_non_test_reviews: 15,
                    excluded_review_types: ['test'],
                    auto_split_enabled: true
                }
            }
        );
        seedStartedTask(repoRoot, TASK_ID);
        fs.appendFileSync(path.join(repoRoot, 'TASK.md'), [
            `| ${TASK_ID}-1 | 🟦 TODO | P1 | workflow | Existing child | gpt-5.4 | 2026-05-05 | strict | Existing split child. |`,
            `| ${TASK_ID}-F1 | 🟦 TODO | P2 | workflow | Existing follow-up | gpt-5.4 | 2026-05-05 | balanced | Existing reviewer follow-up. |`
        ].join('\n') + '\n', 'utf8');
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        appendEvent(repoRoot, TASK_ID, 'REVIEW_RECORDED', 'FAIL', {
            review_type: 'code',
            reviewer_identity: 'agent:auto-split-code-0',
            review_context_sha256: sha256Text('auto-split-code-context-0'),
            summary: 'first code failure'
        });
        appendEvent(repoRoot, TASK_ID, 'REVIEW_RECORDED', 'FAIL', {
            review_type: 'code',
            reviewer_identity: 'agent:auto-split-code-1',
            review_context_sha256: sha256Text('auto-split-code-context-1'),
            summary: 'second code failure'
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const promptPath = path.join(repoRoot, result.review_cycle_block?.auto_split_prompt?.artifact_path || '');
        const promptText = fs.readFileSync(promptPath, 'utf8');

        assert.equal(result.status, 'SPLIT_REQUIRED');
        assert.ok(promptText.includes(`SuggestedChildTaskIds: \`${TASK_ID}-2\`, \`${TASK_ID}-3\`, \`${TASK_ID}-4\``));
        assert.ok(promptText.includes(`SuggestedReviewerFollowUpTaskId: \`${TASK_ID}-F2\``));
    });

});
