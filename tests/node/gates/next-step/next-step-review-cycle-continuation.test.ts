import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

import { formatNextStepText, resolveNextStep } from './next-step-test-support';
import { buildDefaultWorkflowConfig } from './next-step-test-support';
import { writeBalancedTestProfilesConfig } from './next-step-test-support';
import { buildTaskModeArtifact } from './next-step-test-support';
import { buildRulePackArtifact } from './next-step-test-support';
import { getWorkspaceSnapshot } from './next-step-test-support';
import { buildEventIntegrityHash } from './next-step-test-support';
import {
    REVIEW_CYCLE_CONTINUATION_EVENT,
    assessReviewCycleContinuationEvidence,
    buildReviewCycleContinuationArtifact
} from '../../../../src/gates/review-cycle/review-cycle-continuation';
import {
    runRecordReviewCycleContinuationCommand
} from '../../../../src/cli/commands/gates';
import {
    assessReviewCycleContinuationSplitLatchClearance,
    materializeSplitRequiredLatch,
    readSplitRequiredLatchEvidence
} from '../../../../src/gates/next-step/next-step-split-required-latch';
import {
    listSplitRequiredWip,
    restoreSplitRequiredWip
} from '../../../../src/gates/split-required/split-required-wip';
import { initGitRepo, runGitFixtureCommand } from '../git-fixtures';

const TASK_ID = 'T-NEXT-1';
const requireFromTest = createRequire(__filename);
const ALL_REVIEW_FLAGS = Object.freeze({
    code: false,
    db: false,
    security: false,
    refactor: false,
    api: false,
    test: false,
    performance: false,
    infra: false,
    dependency: false
});

let tempRoots: string[] = [];

afterEach(() => {
    for (const tempRoot of tempRoots) {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
    tempRoots = [];
});

describe('gates/next-step review cycle continuation', () => {
    it('clears a bound review-cycle split latch and restores the prior active status exactly once', () => {
        const repoRoot = makeTempRepo();
        seedReviewCycleAutoSplit(repoRoot);

        const splitResult = resolveNextStep({ taskId: TASK_ID, repoRoot });
        assert.equal(splitResult.status, 'SPLIT_REQUIRED', splitResult.reason);
        assert.ok(readTaskMd(repoRoot).includes(`| ${TASK_ID} | 🟫 SPLIT_REQUIRED |`));

        writeReviewCycleContinuation(repoRoot, TASK_ID, {
            baselineTotalNonTestReviewCount: 3,
            baselineFailedNonTestReviewCount: 1,
            maxTotalNonTestReviews: 2
        });

        const continuedResult = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const continuedText = formatNextStepText(continuedResult);
        assert.notEqual(continuedResult.status, 'SPLIT_REQUIRED', continuedResult.reason);
        assert.ok(readTaskMd(repoRoot).includes(`| ${TASK_ID} | 🟧 IN_REVIEW |`));
        assert.ok(
            continuedText.includes('Review cycle one-shot continuation active'),
            continuedText
        );
        assert.equal(countEvents(repoRoot, 'SPLIT_REQUIRED_CLEARED'), 1);

        const repeatedResult = resolveNextStep({ taskId: TASK_ID, repoRoot });
        assert.notEqual(repeatedResult.status, 'SPLIT_REQUIRED', repeatedResult.reason);
        assert.ok(readTaskMd(repoRoot).includes(`| ${TASK_ID} | 🟧 IN_REVIEW |`));
        assert.equal(countEvents(repoRoot, 'SPLIT_REQUIRED_CLEARED'), 1);
        assert.equal(countEvents(repoRoot, 'SPLIT_REQUIRED_RESTORED'), 0);
    });

    it('does not replay a consumed continuation when the same latch is observed as split-required again', () => {
        const repoRoot = makeTempRepo();
        seedReviewCycleAutoSplit(repoRoot);
        assert.equal(resolveNextStep({ taskId: TASK_ID, repoRoot }).status, 'SPLIT_REQUIRED');
        writeReviewCycleContinuation(repoRoot, TASK_ID, {
            baselineTotalNonTestReviewCount: 3,
            baselineFailedNonTestReviewCount: 1,
            maxTotalNonTestReviews: 2
        });
        assert.notEqual(resolveNextStep({ taskId: TASK_ID, repoRoot }).status, 'SPLIT_REQUIRED');
        assert.equal(countEvents(repoRoot, 'SPLIT_REQUIRED_CLEARED'), 1);

        setTaskStatus(repoRoot, 'SPLIT_REQUIRED');
        const replayResult = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(replayResult.status, 'SPLIT_REQUIRED', replayResult.reason);
        assert.ok(readTaskMd(repoRoot).includes(`| ${TASK_ID} | SPLIT_REQUIRED |`));
        assert.equal(countEvents(repoRoot, 'SPLIT_REQUIRED_CLEARED'), 1);
    });

    it('restores split-required when the mutable active status differs from the authenticated clear event', () => {
        const repoRoot = makeTempRepo();
        seedReviewCycleAutoSplit(repoRoot);
        assert.equal(resolveNextStep({ taskId: TASK_ID, repoRoot }).status, 'SPLIT_REQUIRED');
        writeReviewCycleContinuation(repoRoot, TASK_ID, {
            baselineTotalNonTestReviewCount: 3,
            baselineFailedNonTestReviewCount: 1,
            maxTotalNonTestReviews: 2
        });
        assert.notEqual(resolveNextStep({ taskId: TASK_ID, repoRoot }).status, 'SPLIT_REQUIRED');
        assert.ok(readTaskMd(repoRoot).includes(`| ${TASK_ID} | 🟧 IN_REVIEW |`));
        assert.equal(countEvents(repoRoot, 'SPLIT_REQUIRED_CLEARED'), 1);

        setTaskStatus(repoRoot, 'IN_PROGRESS');
        const tamperedResult = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(tamperedResult.status, 'SPLIT_REQUIRED', tamperedResult.reason);
        assert.ok(readTaskMd(repoRoot).includes(`| ${TASK_ID} | 🟫 SPLIT_REQUIRED |`));
        assert.equal(countEvents(repoRoot, 'SPLIT_REQUIRED_CLEARED'), 1);
        assert.equal(countEvents(repoRoot, 'SPLIT_REQUIRED_RESTORED'), 1);
    });

    it('restores an IN_PROGRESS review-cycle split latch to IN_PROGRESS', () => {
        const repoRoot = makeTempRepo();
        seedReviewCycleAutoSplit(repoRoot, 'IN_PROGRESS');
        assert.equal(resolveNextStep({ taskId: TASK_ID, repoRoot }).status, 'SPLIT_REQUIRED');
        writeReviewCycleContinuation(repoRoot, TASK_ID, {
            baselineTotalNonTestReviewCount: 3,
            baselineFailedNonTestReviewCount: 1,
            maxTotalNonTestReviews: 2
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.notEqual(result.status, 'SPLIT_REQUIRED', result.reason);
        assert.ok(readTaskMd(repoRoot).includes(`| ${TASK_ID} | 🟨 IN_PROGRESS |`));
        assert.equal(countEvents(repoRoot, 'SPLIT_REQUIRED_CLEARED'), 1);
    });

    it('rolls TASK.md back when authoritative continuation-clear evidence cannot be appended', () => {
        const repoRoot = makeTempRepo();
        seedReviewCycleAutoSplit(repoRoot);
        assert.equal(resolveNextStep({ taskId: TASK_ID, repoRoot }).status, 'SPLIT_REQUIRED');
        writeReviewCycleContinuation(repoRoot, TASK_ID, {
            baselineTotalNonTestReviewCount: 3,
            baselineFailedNonTestReviewCount: 1,
            maxTotalNonTestReviews: 2
        });
        const targetEventPath = path.join(eventsRoot(repoRoot), `${TASK_ID}.jsonl`);
        const mutableFs = requireFromTest('node:fs') as typeof fs;
        const originalOpenSync = mutableFs.openSync;
        mutableFs.openSync = ((filePath: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode): number => {
            const opensForAppend = typeof flags === 'number'
                ? (flags & fs.constants.O_APPEND) !== 0
                : String(flags).includes('a');
            if (opensForAppend && typeof filePath === 'string' && path.resolve(filePath) === path.resolve(targetEventPath)) {
                throw new Error('forced continuation clear append failure');
            }
            return originalOpenSync(filePath, flags, mode);
        }) as typeof fs.openSync;

        try {
            const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

            assert.equal(result.status, 'BLOCKED', result.reason);
            assert.ok(result.reason.includes('rollback=updated'), result.reason);
            assert.ok(readTaskMd(repoRoot).includes(`| ${TASK_ID} | 🟫 SPLIT_REQUIRED |`));
            assert.equal(countEvents(repoRoot, 'SPLIT_REQUIRED_CLEARED'), 0);
        } finally {
            mutableFs.openSync = originalOpenSync;
        }
    });

    it('preserves a recovered status when generic status telemetry fails after authoritative clearance', () => {
        const repoRoot = makeTempRepo();
        seedReviewCycleAutoSplit(repoRoot);
        assert.equal(resolveNextStep({ taskId: TASK_ID, repoRoot }).status, 'SPLIT_REQUIRED');
        writeReviewCycleContinuation(repoRoot, TASK_ID, {
            baselineTotalNonTestReviewCount: 3,
            baselineFailedNonTestReviewCount: 1,
            maxTotalNonTestReviews: 2
        });
        const targetEventPath = path.join(eventsRoot(repoRoot), `${TASK_ID}.jsonl`);
        const mutableFs = requireFromTest('node:fs') as typeof fs;
        const originalOpenSync = mutableFs.openSync;
        let targetOpenCount = 0;
        mutableFs.openSync = ((filePath: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode): number => {
            const opensForAppend = typeof flags === 'number'
                ? (flags & fs.constants.O_APPEND) !== 0
                : String(flags).includes('a');
            if (opensForAppend && typeof filePath === 'string' && path.resolve(filePath) === path.resolve(targetEventPath)) {
                targetOpenCount += 1;
                if (targetOpenCount === 2) {
                    throw new Error('forced continuation status telemetry failure');
                }
            }
            return originalOpenSync(filePath, flags, mode);
        }) as typeof fs.openSync;

        let failedResult: ReturnType<typeof resolveNextStep> | null = null;
        try {
            failedResult = resolveNextStep({ taskId: TASK_ID, repoRoot });
        } finally {
            mutableFs.openSync = originalOpenSync;
        }

        assert.ok(failedResult);
        assert.equal(failedResult.status, 'BLOCKED', failedResult.reason);
        assert.ok(readTaskMd(repoRoot).includes(`| ${TASK_ID} | 🟧 IN_REVIEW |`));
        assert.equal(countEvents(repoRoot, 'SPLIT_REQUIRED_CLEARED'), 1);

        const retriedResult = resolveNextStep({ taskId: TASK_ID, repoRoot });
        assert.notEqual(retriedResult.status, 'SPLIT_REQUIRED', retriedResult.reason);
        assert.ok(readTaskMd(repoRoot).includes(`| ${TASK_ID} | 🟧 IN_REVIEW |`));
        assert.equal(countEvents(repoRoot, 'SPLIT_REQUIRED_RESTORED'), 0);
    });

    it('keeps a review-cycle split latch when forged continuation baseline does not match the latch', () => {
        const repoRoot = makeTempRepo();
        seedReviewCycleAutoSplit(repoRoot);
        assert.equal(resolveNextStep({ taskId: TASK_ID, repoRoot }).status, 'SPLIT_REQUIRED');
        writeReviewCycleContinuation(repoRoot, TASK_ID, {
            baselineTotalNonTestReviewCount: 2,
            baselineFailedNonTestReviewCount: 1,
            maxTotalNonTestReviews: 2
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.status, 'SPLIT_REQUIRED', result.reason);
        assert.ok(readTaskMd(repoRoot).includes(`| ${TASK_ID} | 🟫 SPLIT_REQUIRED |`));
        assert.equal(countEvents(repoRoot, 'SPLIT_REQUIRED_CLEARED'), 0);
    });

    it('keeps a review-cycle split latch when the stale one-shot continuation is expired', () => {
        const repoRoot = makeTempRepo();
        seedReviewCycleAutoSplit(repoRoot);
        assert.equal(resolveNextStep({ taskId: TASK_ID, repoRoot }).status, 'SPLIT_REQUIRED');
        writeReviewCycleContinuation(repoRoot, TASK_ID, {
            baselineTotalNonTestReviewCount: 3,
            baselineFailedNonTestReviewCount: 1,
            maxTotalNonTestReviews: 2
        });
        const stalePreflight = JSON.parse(fs.readFileSync(
            path.join(reviewsRoot(repoRoot), `${TASK_ID}-preflight.json`),
            'utf8'
        )) as Record<string, unknown>;
        appendEvent(repoRoot, TASK_ID, 'PREFLIGHT_CLASSIFIED', 'INFO', {
            output_path: normalizeForTimeline(path.join(reviewsRoot(repoRoot), `${TASK_ID}-preflight.json`)),
            effective_review_snapshot: stalePreflight.effective_review_snapshot
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.status, 'SPLIT_REQUIRED', result.reason);
        assert.ok(readTaskMd(repoRoot).includes(`| ${TASK_ID} | 🟫 SPLIT_REQUIRED |`));
        assert.equal(countEvents(repoRoot, 'SPLIT_REQUIRED_CLEARED'), 0);
    });

    it('fails closed when the review-cycle latch timeline is malformed', () => {
        const repoRoot = makeTempRepo();
        seedReviewCycleAutoSplit(repoRoot);
        assert.equal(resolveNextStep({ taskId: TASK_ID, repoRoot }).status, 'SPLIT_REQUIRED');
        writeReviewCycleContinuation(repoRoot, TASK_ID, {
            baselineTotalNonTestReviewCount: 3,
            baselineFailedNonTestReviewCount: 1,
            maxTotalNonTestReviews: 2
        });
        const latchEvidence = readSplitRequiredLatchEvidence({
            reviewsRoot: reviewsRoot(repoRoot),
            eventsRoot: eventsRoot(repoRoot),
            taskId: TASK_ID
        });
        const continuationAssessment = assessReviewCycleContinuationEvidence({
            repoRoot,
            reviewsRoot: reviewsRoot(repoRoot),
            eventsRoot: eventsRoot(repoRoot),
            taskId: TASK_ID,
            evaluation: {
                active: true,
                action: 'BLOCK_FOR_OPERATOR_DECISION',
                auto_split_enabled: true,
                max_failed_non_test_reviews: 15,
                max_total_non_test_reviews: 2,
                total_non_test_review_count: 3,
                failed_non_test_review_count: 1,
                counts_by_review_type: {},
                excluded_review_types: ['test'],
                violations: [
                    {
                        metric: 'total_non_test_review_count',
                        actual: 3,
                        limit: 2
                    }
                ],
                should_block: true,
                summary_line: 'Review cycle guard blocked after total non-test review limit.'
            },
            reviewPhase: {
                required_review_types: ['code', 'test'],
                pending_required_review_types: ['code', 'test']
            }
        });
        assert.equal(continuationAssessment.status, 'ACTIVE', continuationAssessment.reason);
        fs.appendFileSync(
            path.join(eventsRoot(repoRoot), `${TASK_ID}.jsonl`),
            '{malformed-review-cycle-event\n',
            'utf8'
        );

        const clearance = assessReviewCycleContinuationSplitLatchClearance({
            eventsRoot: eventsRoot(repoRoot),
            taskId: TASK_ID,
            latchEvidence,
            continuationAssessment
        });

        assert.equal(clearance.valid, false);
        assert.ok(clearance.reason.includes('timeline is unreadable'), clearance.reason);
    });

    it('does not clear a foreign scope-budget split latch with review-cycle continuation evidence', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        const preflightPath = writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        setTaskStatus(repoRoot, 'IN_REVIEW');
        const latch = materializeSplitRequiredLatch({
            repoRoot,
            reviewsRoot: reviewsRoot(repoRoot),
            eventsRoot: eventsRoot(repoRoot),
            taskId: TASK_ID,
            guardKind: 'scope_budget',
            guardReason: 'scope budget exceeded',
            rawGuardSummary: 'Scope budget guard: BLOCK',
            preflightPath,
            guardDetails: {
                action: 'SPLIT_TASK',
                violations: [{ metric: 'changed_files_count', actual: 10, limit: 5 }]
            }
        });
        assert.equal(latch.status_sync.outcome, 'updated');
        writeReviewCycleContinuation(repoRoot, TASK_ID, {
            baselineTotalNonTestReviewCount: 0,
            baselineFailedNonTestReviewCount: 0
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.status, 'SPLIT_REQUIRED', result.reason);
        assert.ok(readTaskMd(repoRoot).includes(`| ${TASK_ID} | 🟫 SPLIT_REQUIRED |`));
        assert.equal(countEvents(repoRoot, 'SPLIT_REQUIRED_CLEARED'), 0);
    });

    it('preserves linked-child decomposition instead of reopening a review-cycle parent', () => {
        const repoRoot = makeTempRepo();
        seedReviewCycleAutoSplit(repoRoot);
        assert.equal(resolveNextStep({ taskId: TASK_ID, repoRoot }).status, 'SPLIT_REQUIRED');
        addLinkedChildTasks(repoRoot, [`${TASK_ID}-1`, `${TASK_ID}-2`]);
        writeReviewCycleContinuation(repoRoot, TASK_ID, {
            baselineTotalNonTestReviewCount: 3,
            baselineFailedNonTestReviewCount: 1,
            maxTotalNonTestReviews: 2
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.notEqual(result.status, 'SPLIT_REQUIRED');
        assert.ok(
            readTaskMd(repoRoot).includes(`| ${TASK_ID} | 🟪 DECOMPOSED |`),
            `${result.status}: ${result.reason}\n${readTaskMd(repoRoot)}`
        );
        assert.equal(countEvents(repoRoot, 'SPLIT_REQUIRED_CLEARED'), 1);
        assert.equal(readTaskEvents(repoRoot).includes('review_cycle_continuation_approved'), false);
    });

    it('uses an active one-shot continuation without changing workflow-config.json', () => {
        const repoRoot = makeTempRepo();
        const workflowConfig = buildDefaultWorkflowConfig();
        workflowConfig.full_suite_validation.enabled = false;
        workflowConfig.review_execution_policy = { mode: 'code_first_optional' };
        workflowConfig.review_cycle_guard.auto_split_enabled = false;
        workflowConfig.review_cycle_guard.max_total_non_test_reviews = 2;
        const configPath = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json');
        writeJson(configPath, workflowConfig);
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        for (let index = 0; index < 2; index += 1) {
            appendEvent(repoRoot, TASK_ID, 'REVIEW_RECORDED', 'PASS', {
                review_type: 'code',
                reviewer_identity: `agent:code-one-shot-active-${index}`,
                review_context_sha256: sha256Text(`code-one-shot-active-${index}`)
            });
        }
        appendEvent(repoRoot, TASK_ID, 'REVIEW_RECORDED', 'FAIL', {
            review_type: 'code',
            reviewer_identity: 'agent:code-one-shot-active-fail',
            review_context_sha256: sha256Text('code-one-shot-active-fail'),
            summary: 'failed after reaching the review-cycle total limit'
        });
        const beforeConfig = fs.readFileSync(configPath, 'utf8');
        writeReviewCycleContinuation(repoRoot, TASK_ID, {
            baselineTotalNonTestReviewCount: 3,
            baselineFailedNonTestReviewCount: 1,
            maxTotalNonTestReviews: 2
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const text = formatNextStepText(result);

        assert.notEqual(result.next_gate, 'review-cycle-attempt-guard');
        assert.ok(text.includes('Review cycle one-shot continuation active'));
        assert.ok(text.includes('does not mutate workflow-config.json'));
        assert.equal(fs.readFileSync(configPath, 'utf8'), beforeConfig);
    });

    it('does not offer a second one-shot continuation after the first one expires', () => {
        const repoRoot = makeTempRepo();
        const workflowConfig = buildDefaultWorkflowConfig();
        workflowConfig.full_suite_validation.enabled = false;
        workflowConfig.review_execution_policy = { mode: 'code_first_optional' };
        workflowConfig.review_cycle_guard.auto_split_enabled = false;
        workflowConfig.review_cycle_guard.max_total_non_test_reviews = 2;
        writeJson(path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json'), workflowConfig);
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        for (let index = 0; index < 2; index += 1) {
            appendEvent(repoRoot, TASK_ID, 'REVIEW_RECORDED', 'PASS', {
                review_type: 'code',
                reviewer_identity: `agent:code-one-shot-reuse-baseline-${index}`,
                review_context_sha256: sha256Text(`code-one-shot-reuse-baseline-${index}`)
            });
        }
        appendEvent(repoRoot, TASK_ID, 'REVIEW_RECORDED', 'FAIL', {
            review_type: 'code',
            reviewer_identity: 'agent:code-one-shot-reuse-fail',
            review_context_sha256: sha256Text('code-one-shot-reuse-fail'),
            summary: 'failed after reaching the review-cycle total limit'
        });
        writeReviewCycleContinuation(repoRoot, TASK_ID, {
            baselineTotalNonTestReviewCount: 3,
            baselineFailedNonTestReviewCount: 1,
            maxTotalNonTestReviews: 2
        });
        const refreshedPreflight = JSON.parse(fs.readFileSync(
            path.join(reviewsRoot(repoRoot), `${TASK_ID}-preflight.json`),
            'utf8'
        )) as Record<string, unknown>;
        appendEvent(repoRoot, TASK_ID, 'PREFLIGHT_CLASSIFIED', 'INFO', {
            output_path: normalizeForTimeline(path.join(reviewsRoot(repoRoot), `${TASK_ID}-preflight.json`)),
            reason: 'scope changed after one-shot continuation approval',
            effective_review_snapshot: refreshedPreflight.effective_review_snapshot
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const text = formatNextStepText(result);

        assert.equal(result.next_gate, 'review-cycle-attempt-guard');
        assert.ok(text.includes('Review cycle one-shot continuation expired'));
        assert.ok(text.includes('expired after PREFLIGHT_CLASSIFIED'));
        assert.equal(result.commands.some((command) => command.label === 'Record one-shot review-cycle continuation'), false);
        assert.equal(result.commands[0]?.label, 'Record review-cycle split decision');
        assert.equal(result.review_cycle_block?.choices.includes('allow_one_more_cycle'), false);
        assert.ok(text.includes('A one-shot continuation was already recorded for this task attempt'));
    });

    it('rejects a second direct one-shot continuation command in the same task attempt', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);

        const firstResult = runRecordReviewCycleContinuationCommand({
            repoRoot,
            taskId: TASK_ID,
            decision: 'allow_one_more_cycle',
            reason: 'Operator approved one continuation for the current attempt.',
            baselineTotalNonTestReviewCount: 3,
            baselineFailedNonTestReviewCount: 0,
            maxTotalNonTestReviews: 2,
            maxFailedNonTestReviews: 15,
            excludedReviewTypes: ['test'],
            operatorConfirmed: 'yes',
            operatorConfirmedAtUtc: new Date().toISOString()
        });
        assert.equal(firstResult.exitCode, 0);
        assertOperatorContinuationOutput(firstResult.outputLines, 'REVIEW_CYCLE_CONTINUATION_RECORDED');
        const artifactPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-review-cycle-continuation.json`);
        const firstArtifactSha256 = fileSha256(artifactPath);

        const secondResult = runRecordReviewCycleContinuationCommand({
            repoRoot,
            taskId: TASK_ID,
            decision: 'allow_one_more_cycle',
            reason: 'Operator tried to approve a second continuation for the same attempt.',
            baselineTotalNonTestReviewCount: 4,
            baselineFailedNonTestReviewCount: 0,
            maxTotalNonTestReviews: 2,
            maxFailedNonTestReviews: 15,
            excludedReviewTypes: ['test'],
            operatorConfirmed: 'yes',
            operatorConfirmedAtUtc: new Date().toISOString()
        });

        assert.equal(secondResult.exitCode, 3);
        assert.equal(fileSha256(artifactPath), firstArtifactSha256);
        assertOperatorContinuationOutput(secondResult.outputLines, 'REVIEW_CYCLE_CONTINUATION_REJECTED');
        assert.ok(secondResult.outputLines.includes('REVIEW_CYCLE_CONTINUATION_REJECTED'));
        assert.ok(
            secondResult.outputLines.some((line) => line.includes('already recorded for the current task attempt'))
        );
    });

    it('expires phase-based one-shot continuation after a failed non-test review cycle', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        writeReviewCycleContinuation(repoRoot, TASK_ID, {
            baselineTotalNonTestReviewCount: 2,
            baselineFailedNonTestReviewCount: 0,
            maxTotalNonTestReviews: 2,
            maxFailedNonTestReviews: 1
        });

        const assessment = assessReviewCycleContinuationEvidence({
            repoRoot,
            reviewsRoot: reviewsRoot(repoRoot),
            eventsRoot: eventsRoot(repoRoot),
            taskId: TASK_ID,
            evaluation: {
                active: true,
                action: 'BLOCK_FOR_OPERATOR_DECISION',
                auto_split_enabled: true,
                max_failed_non_test_reviews: 1,
                max_total_non_test_reviews: 2,
                total_non_test_review_count: 3,
                failed_non_test_review_count: 1,
                counts_by_review_type: {},
                excluded_review_types: ['test'],
                violations: [
                    {
                        metric: 'failed_non_test_review_count',
                        actual: 1,
                        limit: 1
                    }
                ],
                should_block: true,
                summary_line: 'Review cycle guard blocked after failed non-test review.'
            },
            reviewPhase: {
                required_review_types: ['code', 'security', 'refactor', 'api', 'test'],
                pending_required_review_types: ['api', 'test']
            }
        });

        assert.equal(assessment.status, 'EXPIRED');
        assert.ok(assessment.reason.includes('failed non-test review cycle'));
    });
});

function makeTempRepo(): string {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-next-step-continuation-'));
    tempRoots.push(repoRoot);
    fs.mkdirSync(path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews'), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'task-events'), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config'), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'docs', 'agent-rules'), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, 'bin'), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, 'template', 'docs', 'prompts'), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, 'bin', 'garda.js'), '#!/usr/bin/env node\n', 'utf8');
    fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const value = 1;\n', 'utf8');
    fs.copyFileSync(
        path.join(process.cwd(), 'template', 'docs', 'prompts', 'review-cycle-auto-split.md'),
        path.join(repoRoot, 'template', 'docs', 'prompts', 'review-cycle-auto-split.md')
    );
    fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
        '# TASK.md',
        '',
        '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
        '|---|---|---|---|---|---|---|---|---|',
        `| ${TASK_ID} | TODO | P1 | workflow/review-cycle | Review cycle continuation | gpt-5.4 | 2026-04-25 | balanced | Test queue entry. |`,
        ''
    ].join('\n'), 'utf8');
    writeJson(path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'init-answers.json'), {
        SourceOfTruth: 'Codex'
    });
    for (const ruleFile of [
        '00-core.md',
        '15-project-memory.md',
        '30-code-style.md',
        '35-strict-coding-rules.md',
        '40-commands.md',
        '50-structure-and-docs.md',
        '70-security.md',
        '80-task-workflow.md',
        '90-skill-catalog.md'
    ]) {
        fs.writeFileSync(
            path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'docs', 'agent-rules', ruleFile),
            `# ${ruleFile}\n`,
            'utf8'
        );
    }
    const workflowConfig = buildDefaultWorkflowConfig();
    workflowConfig.full_suite_validation.enabled = false;
    workflowConfig.review_execution_policy = { mode: 'code_first_optional' };
    workflowConfig.project_memory_maintenance.enabled = false;
    workflowConfig.project_memory_maintenance.mode = 'check';
    writeJson(path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json'), workflowConfig);
    writeBalancedTestProfilesConfig(repoRoot);
    initGitRepo(repoRoot, {
        gitignoreContent: [
            'TASK.md',
            'garda-agent-orchestrator/runtime/',
            'garda-agent-orchestrator/live/config/workflow-config.json',
            ''
        ].join('\n')
    });
    runGitFixtureCommand(repoRoot, ['config', 'core.autocrlf', 'false']);
    fs.appendFileSync(path.join(repoRoot, 'src', 'app.ts'), '\n', 'utf8');
    return repoRoot;
}

function reviewsRoot(repoRoot: string): string {
    return path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews');
}

function eventsRoot(repoRoot: string): string {
    return path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'task-events');
}

function writeJson(filePath: string, payload: unknown): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function fileSha256(filePath: string): string {
    return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function sha256Text(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex');
}

function normalizeForTimeline(filePath: string): string {
    return filePath.replace(/\\/g, '/');
}

function assertOperatorContinuationOutput(outputLines: string[], marker: string): void {
    assert.equal(outputLines[0], 'Next action:');
    assert.ok(outputLines.includes(marker), outputLines.join('\n'));
    assert.ok(outputLines.some((line) => line.includes('Gate: record-review-cycle-continuation')));
    assert.ok(outputLines.some((line) => line.includes('DetailsPath:')));
    assert.equal(outputLines.some((line) => line.startsWith('NextAction:')), false, outputLines.join('\n'));
}

function appendEvent(
    repoRoot: string,
    taskId: string,
    eventType: string,
    outcome = 'PASS',
    details: Record<string, unknown> = {}
): void {
    const timelinePath = path.join(eventsRoot(repoRoot), `${taskId}.jsonl`);
    const existingLines = fs.existsSync(timelinePath)
        ? fs.readFileSync(timelinePath, 'utf8').split('\n').filter((line) => line.trim())
        : [];
    const taskSequence = existingLines.length + 1;
    const previousEvent = taskSequence > 1
        ? JSON.parse(existingLines[existingLines.length - 1]) as Record<string, unknown>
        : null;
    const previousIntegrity = previousEvent?.integrity && typeof previousEvent.integrity === 'object'
        ? previousEvent.integrity as Record<string, unknown>
        : null;
    const previousEventSha256 = typeof previousIntegrity?.event_sha256 === 'string'
        ? previousIntegrity.event_sha256
        : null;
    const line: Record<string, unknown> = {
        task_id: taskId,
        event_type: eventType,
        outcome,
        actor: 'gate',
        message: eventType,
        timestamp_utc: new Date().toISOString(),
        details,
        integrity: {
            schema_version: 2,
            task_sequence: taskSequence,
            prev_event_sha256: previousEventSha256,
            event_sha256: null
        }
    };
    const integrity = line.integrity as Record<string, unknown>;
    integrity.event_sha256 = buildEventIntegrityHash(line);
    fs.appendFileSync(timelinePath, `${JSON.stringify(line)}\n`, 'utf8');
}

function seedStartedTask(repoRoot: string, taskId: string): void {
    writeJson(path.join(reviewsRoot(repoRoot), `${taskId}-task-mode.json`), buildTaskModeArtifact({
        taskId,
        entryMode: 'EXPLICIT_TASK_EXECUTION',
        requestedDepth: 2,
        effectiveDepth: 2,
        taskSummary: 'Seeded next-step task',
        startBanner: 'Garda captures my mind',
        provider: 'Codex',
        canonicalSourceOfTruth: 'Codex',
        executionProviderSource: 'explicit_provider',
        runtimeIdentityStatus: 'resolved'
    }));
    writeJson(path.join(reviewsRoot(repoRoot), `${taskId}-handshake.json`), { task_id: taskId, status: 'PASS' });
    writeJson(path.join(reviewsRoot(repoRoot), `${taskId}-shell-smoke.json`), { task_id: taskId, status: 'PASS' });
    appendEvent(repoRoot, taskId, 'TASK_MODE_ENTERED');
    seedRulePack(repoRoot, taskId, 'TASK_ENTRY');
    appendEvent(repoRoot, taskId, 'HANDSHAKE_DIAGNOSTICS_RECORDED');
    appendEvent(repoRoot, taskId, 'SHELL_SMOKE_PREFLIGHT_RECORDED');
}

function seedReviewCycleAutoSplit(
    repoRoot: string,
    activeStatus: 'IN_PROGRESS' | 'IN_REVIEW' = 'IN_REVIEW'
): void {
    const workflowConfig = buildDefaultWorkflowConfig();
    workflowConfig.full_suite_validation.enabled = false;
    workflowConfig.review_execution_policy = { mode: 'code_first_optional' };
    workflowConfig.review_cycle_guard.auto_split_enabled = true;
    workflowConfig.review_cycle_guard.max_total_non_test_reviews = 2;
    writeJson(
        path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json'),
        workflowConfig
    );
    seedStartedTask(repoRoot, TASK_ID);
    writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
    setTaskStatus(repoRoot, activeStatus);
    for (let index = 0; index < 2; index += 1) {
        appendEvent(repoRoot, TASK_ID, 'REVIEW_RECORDED', 'PASS', {
            review_type: 'code',
            reviewer_identity: `agent:code-auto-split-${index}`,
            review_context_sha256: sha256Text(`code-auto-split-${index}`)
        });
    }
    appendEvent(repoRoot, TASK_ID, 'REVIEW_RECORDED', 'FAIL', {
        review_type: 'code',
        reviewer_identity: 'agent:code-auto-split-fail',
        review_context_sha256: sha256Text('code-auto-split-fail'),
        summary: 'failed after reaching the review-cycle total limit'
    });
}

function readTaskMd(repoRoot: string): string {
    return fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8');
}

function setTaskStatus(repoRoot: string, status: string): void {
    const taskMdPath = path.join(repoRoot, 'TASK.md');
    const lines = readTaskMd(repoRoot).split('\n');
    const taskLineIndex = lines.findIndex((line) => line.startsWith(`| ${TASK_ID} |`));
    assert.notEqual(taskLineIndex, -1);
    const cells = lines[taskLineIndex].split('|');
    cells[2] = ` ${status} `;
    lines[taskLineIndex] = cells.join('|');
    fs.writeFileSync(taskMdPath, lines.join('\n'), 'utf8');
}

function addLinkedChildTasks(repoRoot: string, childTaskIds: string[]): void {
    const taskMdPath = path.join(repoRoot, 'TASK.md');
    const lines = readTaskMd(repoRoot).split('\n');
    const parentLineIndex = lines.findIndex((line) => line.startsWith(`| ${TASK_ID} |`));
    assert.notEqual(parentLineIndex, -1);
    const parentCells = lines[parentLineIndex].split('|');
    parentCells[9] = ` Child tasks: ${childTaskIds.map((childTaskId) => `\`${childTaskId}\``).join(', ')}. `;
    lines[parentLineIndex] = parentCells.join('|');
    lines.splice(
        parentLineIndex + 1,
        0,
        ...childTaskIds.map((childTaskId, index) => (
            `| ${childTaskId} | TODO | P1 | workflow/review-cycle-${index + 1} | Child review fix ${index + 1} | gpt-5.4 | 2026-04-25 | strict | Child of \`${TASK_ID}\`. |`
        ))
    );
    fs.writeFileSync(taskMdPath, lines.join('\n'), 'utf8');
}

function readTaskEvents(repoRoot: string): string {
    return fs.readFileSync(path.join(eventsRoot(repoRoot), `${TASK_ID}.jsonl`), 'utf8');
}

function countEvents(repoRoot: string, eventType: string): number {
    return readTaskEvents(repoRoot)
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((event) => event.event_type === eventType)
        .length;
}

function seedRulePack(repoRoot: string, taskId: string, stage: 'TASK_ENTRY' | 'POST_PREFLIGHT', preflightPath = ''): void {
    const rulePackPath = path.join(reviewsRoot(repoRoot), `${taskId}-rule-pack.json`);
    const loadedRuleFiles = stage === 'POST_PREFLIGHT'
        ? [
            '00-core.md',
            '15-project-memory.md',
            '30-code-style.md',
            '35-strict-coding-rules.md',
            '40-commands.md',
            '50-structure-and-docs.md',
            '70-security.md',
            '80-task-workflow.md',
            '90-skill-catalog.md'
        ]
        : ['00-core.md', '15-project-memory.md', '40-commands.md', '80-task-workflow.md', '90-skill-catalog.md'];
    const artifact = buildRulePackArtifact({
        repoRoot,
        taskId,
        stage,
        preflightPath,
        loadedRuleFiles
    });
    writeJson(rulePackPath, artifact);
    appendEvent(repoRoot, taskId, 'RULE_PACK_LOADED', 'PASS', {
        stage,
        ...(preflightPath ? { preflight_path: normalizeForTimeline(preflightPath) } : {}),
        artifact_path: normalizeForTimeline(rulePackPath)
    });
}

function writePreflight(repoRoot: string, taskId: string, requiredReviews: Record<string, boolean>): string {
    const preflightPath = path.join(reviewsRoot(repoRoot), `${taskId}-preflight.json`);
    const changedFiles = ['src/app.ts'];
    const snapshot = getWorkspaceSnapshot(repoRoot, 'explicit_changed_files', true, changedFiles);
    writeJson(preflightPath, {
        task_id: taskId,
        detection_source: snapshot.detection_source,
        mode: 'FULL_PATH',
        scope_category: 'code',
        metrics: {
            changed_lines_total: snapshot.changed_lines_total,
            changed_files_sha256: snapshot.changed_files_sha256,
            scope_content_sha256: snapshot.scope_content_sha256,
            scope_sha256: snapshot.scope_sha256
        },
        required_reviews: requiredReviews,
        changed_files: changedFiles,
        review_execution_policy: {
            mode: 'code_first_optional',
            visible_summary_line: 'Review execution policy: code_first_optional'
        }
    });
    appendEvent(repoRoot, taskId, 'PREFLIGHT_CLASSIFIED', 'INFO', {
        output_path: normalizeForTimeline(preflightPath)
    });
    seedRulePack(repoRoot, taskId, 'POST_PREFLIGHT', preflightPath);
    return preflightPath;
}

function writeReviewCycleContinuation(
    repoRoot: string,
    taskId: string,
    options: {
        baselineTotalNonTestReviewCount: number;
        baselineFailedNonTestReviewCount: number;
        maxTotalNonTestReviews?: number;
        maxFailedNonTestReviews?: number;
        excludedReviewTypes?: string[];
    }
): void {
    const capturedWip = [...listSplitRequiredWip({ repoRoot, taskId }).manifests]
        .reverse()
        .find((manifest) => manifest.status === 'suspended');
    if (capturedWip) {
        const restoreResult = restoreSplitRequiredWip({
            repoRoot,
            taskId,
            manifestPath: capturedWip.manifest_path
        });
        assert.equal(
            restoreResult.status,
            'RESTORED',
            restoreResult.violations.join('\n')
        );
    }
    const artifactPath = path.join(reviewsRoot(repoRoot), `${taskId}-review-cycle-continuation.json`);
    const artifact = buildReviewCycleContinuationArtifact({
        taskId,
        decision: 'allow_one_more_cycle',
        reason: 'Operator approved one more review-cycle continuation for the test.',
        operatorConfirmedAtUtc: new Date().toISOString(),
        baselineTotalNonTestReviewCount: options.baselineTotalNonTestReviewCount,
        baselineFailedNonTestReviewCount: options.baselineFailedNonTestReviewCount,
        maxTotalNonTestReviews: options.maxTotalNonTestReviews ?? 2,
        maxFailedNonTestReviews: options.maxFailedNonTestReviews ?? 15,
        excludedReviewTypes: options.excludedReviewTypes || ['test']
    });
    writeJson(artifactPath, artifact);
    appendEvent(repoRoot, taskId, REVIEW_CYCLE_CONTINUATION_EVENT, 'INFO', {
        artifact_path: normalizeForTimeline(artifactPath),
        artifact_sha256: fileSha256(artifactPath),
        decision: 'allow_one_more_cycle',
        one_shot: true,
        baseline_total_non_test_review_count: options.baselineTotalNonTestReviewCount,
        baseline_failed_non_test_review_count: options.baselineFailedNonTestReviewCount
    });
}
