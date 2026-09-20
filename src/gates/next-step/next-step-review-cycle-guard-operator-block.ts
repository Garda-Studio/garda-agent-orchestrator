import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

import { redactSecretText } from '../../core/redaction';
import { writeReviewArtifactText } from '../../gate-runtime/review-artifacts';
import {
    resolveBundleNameForTarget
} from '../../core/constants';
import {
    allocateParentDerivedTaskIds
} from '../../core/task-id-allocation';
import {
    readTaskQueueEntries
} from '../../core/task-queue-read';
import {
    normalizePath
} from '../shared/helpers';
import {
    formatNextStepInlineList,
    formatNextStepInlineValue,
    quoteCommandValue,
    toRepoDisplayPath
} from './next-step-command-formatters';
import {
    sanitizeReviewCycleAutoSplitSummary,
    type SplitRequiredLatchResult
} from './next-step-split-required-latch';
import {
    type NextStepReviewCycleAutoSplitPrompt,
    type NextStepReviewCycleBlock,
    type NextStepReviewCycleLatestFailedReview,
    type ReviewCycleGuardEvaluation
} from './next-step-review-cycle-guard-types';

const REVIEW_CYCLE_OPERATOR_CHOICES = Object.freeze([
    'split_task',
    'mark_blocked',
    'raise_limits',
    'allow_one_more_cycle',
    'create_follow_up_tasks'
]);

const REVIEW_CYCLE_OPERATOR_CHOICE_GUIDANCE = Object.freeze([
    'allow_one_more_cycle: task-scoped one-shot runtime approval; writes runtime evidence only and does not edit workflow-config.json',
    'raise_limits: permanent repo-local workflow-config change through workflow set; requires separate operator approval and changes future runs',
    'split_task/create_follow_up_tasks: decompose work into child or follow-up tasks instead of increasing limits',
    'mark_blocked: stop the current task attempt and preserve the blocker'
]);

const REVIEW_CYCLE_AUTO_SPLIT_TEMPLATE_PATH = 'template/docs/prompts/review-cycle-auto-split.md';
const REVIEW_CYCLE_WORK_PACKAGE_CONTRACT_SUFFIX = '-work-package-contract.json';

type ReviewCycleAutoSplitCurrentState = NextStepReviewCycleAutoSplitPrompt['current_state'];

interface ReviewCycleAutoSplitStateProjection {
    currentState: ReviewCycleAutoSplitCurrentState;
    stateNextAction: NextStepReviewCycleAutoSplitPrompt['state_next_action'];
    nextActionCommand: string;
    validationLaneCommand: string;
    restorePreviewCommand: string;
    checkpointInspectionCommand: string;
    restoreApplyCommand: string;
    childCreationCommand: string;
    workPackageContractPath: string;
}

function resolveBundleRootForReviewCycleGuard(repoRoot: string): string {
    const sourceCheckoutBundleRoot = path.resolve(repoRoot);
    return fs.existsSync(path.join(sourceCheckoutBundleRoot, 'bin', 'garda.js'))
        ? sourceCheckoutBundleRoot
        : path.join(sourceCheckoutBundleRoot, resolveBundleNameForTarget(repoRoot));
}

export function buildReviewCycleContinuationCommand(
    cliPrefix: string,
    taskId: string,
    evaluation: ReviewCycleGuardEvaluation
): string {
    return [
        `${cliPrefix} gate record-review-cycle-continuation`,
        `--task-id "${taskId}"`,
        '--decision "allow_one_more_cycle"',
        `--baseline-total-non-test-reviews "${evaluation.total_non_test_review_count}"`,
        `--baseline-failed-non-test-reviews "${evaluation.failed_non_test_review_count}"`,
        `--max-total-non-test-reviews "${evaluation.max_total_non_test_reviews}"`,
        `--max-failed-non-test-reviews "${evaluation.max_failed_non_test_reviews}"`,
        `--excluded-review-types ${quoteCommandValue(evaluation.excluded_review_types.join(','))}`,
        `--reason ${quoteCommandValue('Operator approved exactly one additional review-cycle continuation without changing workflow-config.json.')}`,
        '--operator-confirmed yes',
        `--operator-confirmed-at-utc ${quoteCommandValue('<ISO-8601 timestamp>')}`,
        '--repo-root "."'
    ].join(' ');
}

export function buildReviewCycleSplitDecisionCommand(
    repoRoot: string,
    cliPrefix: string,
    taskId: string,
    evaluation: ReviewCycleGuardEvaluation,
    preflightPath: string
): string {
    return [
        `${cliPrefix} gate record-review-cycle-split-decision`,
        `--task-id "${taskId}"`,
        '--decision "split_task"',
        `--preflight-path ${quoteCommandValue(toRepoDisplayPath(repoRoot, preflightPath))}`,
        `--baseline-total-non-test-reviews "${evaluation.total_non_test_review_count}"`,
        `--baseline-failed-non-test-reviews "${evaluation.failed_non_test_review_count}"`,
        `--max-total-non-test-reviews "${evaluation.max_total_non_test_reviews}"`,
        `--max-failed-non-test-reviews "${evaluation.max_failed_non_test_reviews}"`,
        `--excluded-review-types ${quoteCommandValue(evaluation.excluded_review_types.join(','))}`,
        `--reason ${quoteCommandValue('Operator chose to split the task after the review-cycle guard blocked continuation.')}`,
        '--operator-confirmed yes',
        `--operator-confirmed-at-utc ${quoteCommandValue('<ISO-8601 timestamp>')}`,
        '--repo-root "."'
    ].join(' ');
}

function formatLatestFailedReviewForTemplate(latestFailedReview: NextStepReviewCycleLatestFailedReview | null): string {
    if (!latestFailedReview) {
        return 'none';
    }
    const parts = [
        `review_type=${formatNextStepInlineValue(latestFailedReview.review_type)}`,
        `event=${formatNextStepInlineValue(latestFailedReview.event_type)}`,
        `outcome=${formatNextStepInlineValue(latestFailedReview.outcome || 'unknown')}`,
        `sequence=${latestFailedReview.sequence}`
    ];
    if (latestFailedReview.review_artifact_path) {
        parts.push(`artifact=${formatNextStepInlineValue(latestFailedReview.review_artifact_path)}`);
    }
    if (latestFailedReview.summary) {
        parts.push(`summary=${formatNextStepInlineValue(latestFailedReview.summary)}`);
    }
    return parts.join('; ');
}

function readReviewCycleAutoSplitTemplate(repoRoot: string): string {
    const templatePath = path.join(resolveBundleRootForReviewCycleGuard(repoRoot), REVIEW_CYCLE_AUTO_SPLIT_TEMPLATE_PATH);
    try {
        return fs.readFileSync(templatePath, 'utf8');
    } catch (error: unknown) {
        throw new Error(
            `Review-cycle auto-split prompt template is required but unreadable: ${normalizePath(templatePath)}. ` +
            `${error instanceof Error ? error.message : String(error)}`
        );
    }
}

function buildReviewCycleAutoSplitPromptContent(
    repoRoot: string,
    taskId: string,
    evaluation: ReviewCycleGuardEvaluation,
    latestFailedReview: NextStepReviewCycleLatestFailedReview | null,
    latchResult: SplitRequiredLatchResult,
    state: ReviewCycleAutoSplitStateProjection
): string {
    const taskEntries = readTaskQueueEntries(repoRoot);
    const suggestedChildTaskIds = allocateParentDerivedTaskIds({
        parentTaskId: taskId,
        existingTaskIds: taskEntries.keys(),
        kind: 'child',
        count: 3
    });
    const suggestedFollowupTaskId = allocateParentDerivedTaskIds({
        parentTaskId: taskId,
        existingTaskIds: [...taskEntries.keys(), ...suggestedChildTaskIds],
        kind: 'followup',
        count: 1
    })[0];
    const replacements: Record<string, string> = {
        TASK_ID: taskId,
        GUARD_REASON: formatNextStepInlineValue(sanitizeReviewCycleAutoSplitSummary(evaluation)),
        TOTAL_NON_TEST_REVIEWS: String(evaluation.total_non_test_review_count),
        FAILED_NON_TEST_REVIEWS: String(evaluation.failed_non_test_review_count),
        EXCLUDED_REVIEW_TYPES: formatNextStepInlineList(evaluation.excluded_review_types),
        LATEST_FAILED_REVIEW: formatLatestFailedReviewForTemplate(latestFailedReview),
        SUGGESTED_CHILD_TASK_IDS: suggestedChildTaskIds.map((childTaskId) => `\`${childTaskId}\``).join(', '),
        SUGGESTED_FOLLOWUP_TASK_ID: `\`${suggestedFollowupTaskId}\``,
        LATCH_ARTIFACT: `path=${normalizePath(latchResult.artifact_path)}; sha256=${latchResult.artifact_sha256}`,
        WIP_CAPTURE: formatWipCaptureForTemplate(latchResult),
        CURRENT_STATE: state.currentState,
        WORK_PACKAGE_CONTRACT_PATH: `\`${state.workPackageContractPath}\``,
        NEXT_ACTION: state.stateNextAction,
        NEXT_ACTION_COMMAND: `\`${state.nextActionCommand}\``,
        VALIDATION_LANE_COMMAND: `\`${state.validationLaneCommand}\``,
        RESTORE_PREVIEW_COMMAND: `\`${state.restorePreviewCommand}\``,
        CHECKPOINT_INSPECTION_COMMAND: `\`${state.checkpointInspectionCommand}\``,
        RESTORE_APPLY_COMMAND: `\`${state.restoreApplyCommand}\``,
        CHILD_CREATION_COMMAND: `\`${state.childCreationCommand}\``
    };
    const template = readReviewCycleAutoSplitTemplate(repoRoot);
    return `${template.replace(/\{\{([A-Z0-9_]+)}}/g, (match, key: string) => replacements[key] ?? match).trimEnd()}\n`;
}

function formatWipCaptureForTemplate(latchResult: SplitRequiredLatchResult): string {
    const capture = latchResult.wip_capture;
    const capturedFiles = capture
        ? [...capture.tracked_files, ...capture.untracked_files]
        : [];
    return [
        `status=${capture?.status || 'NOT_CAPTURED'}`,
        `manifest=${capture?.manifest_path || 'none'}`,
        `captured_files=${capturedFiles.length > 0 ? capturedFiles.join(',') : 'none'}`
    ].join('; ');
}

function buildReviewCycleAutoSplitStateProjection(params: {
    taskId: string;
    cliPrefix: string;
    fullSuiteCommand: string;
    latchResult: SplitRequiredLatchResult;
}): ReviewCycleAutoSplitStateProjection {
    const capture = params.latchResult.wip_capture;
    const capturedFileCount = (capture?.tracked_files.length || 0) + (capture?.untracked_files.length || 0);
    const currentState: ReviewCycleAutoSplitCurrentState = !capture
        ? 'checkpoint'
        : capturedFileCount > 0
            ? 'suspended_manifest'
            : 'no_diff';
    const validationLaneCommand = params.fullSuiteCommand;
    const manifestPath = capture?.manifest_path;
    const restorePreviewCommand = manifestPath
        ? `${params.cliPrefix} gate restore-split-required-wip --task-id "${params.taskId}" --manifest-path "${manifestPath}" --dry-run --repo-root "."`
        : `${params.cliPrefix} gate list-split-required-wip --task-id "${params.taskId}" --repo-root "."`;
    const restoreApplyCommand = manifestPath
        ? `${params.cliPrefix} gate restore-split-required-wip --task-id "${params.taskId}" --manifest-path "${manifestPath}" --include-path "<repo/path>" --repo-root "."`
        : `${params.cliPrefix} gate list-split-required-wip --task-id "${params.taskId}" --repo-root "."`;
    const checkpointInspectionCommand = 'git status --short';
    const childCreationCommand = `${params.cliPrefix} next-step "${params.taskId}" --repo-root "."`;
    const stateNextAction = currentState === 'suspended_manifest'
        ? 'preview_restore'
        : currentState === 'no_diff'
            ? 'run_validation_lane'
            : 'inspect_checkpoint_scope';
    const nextActionCommand = currentState === 'suspended_manifest'
        ? restorePreviewCommand
        : currentState === 'no_diff'
            ? validationLaneCommand
            : checkpointInspectionCommand;
    return {
        currentState,
        stateNextAction,
        nextActionCommand,
        validationLaneCommand,
        restorePreviewCommand,
        checkpointInspectionCommand,
        restoreApplyCommand,
        childCreationCommand,
        workPackageContractPath: normalizePath(path.join(
            'garda-agent-orchestrator',
            'runtime',
            'reviews',
            `${params.taskId}${REVIEW_CYCLE_WORK_PACKAGE_CONTRACT_SUFFIX}`
        ))
    };
}

export function materializeReviewCycleAutoSplitPrompt(params: {
    repoRoot: string;
    reviewsRoot: string;
    taskId: string;
    evaluation: ReviewCycleGuardEvaluation;
    latestFailedReview: NextStepReviewCycleLatestFailedReview | null;
    latchResult: SplitRequiredLatchResult;
    cliPrefix: string;
    fullSuiteCommand: string;
}): NextStepReviewCycleAutoSplitPrompt {
    const state = buildReviewCycleAutoSplitStateProjection(params);
    const artifactPath = path.join(params.reviewsRoot, `${params.taskId}-review-cycle-auto-split-prompt.md`);
    const content = redactSecretText(buildReviewCycleAutoSplitPromptContent(
        params.repoRoot,
        params.taskId,
        params.evaluation,
        params.latestFailedReview,
        params.latchResult,
        state
    ));
    if (!fs.existsSync(artifactPath) || fs.readFileSync(artifactPath, 'utf8') !== content) {
        writeReviewArtifactText(artifactPath, content);
    }
    return {
        kind: 'review_cycle_auto_split_prompt',
        artifact_path: normalizePath(path.relative(params.repoRoot, artifactPath)),
        artifact_sha256: createHash('sha256').update(content).digest('hex'),
        current_state: state.currentState,
        latch_artifact_path: params.latchResult.artifact_path,
        latch_artifact_sha256: params.latchResult.artifact_sha256,
        wip_capture_status: params.latchResult.wip_capture?.status || 'NOT_CAPTURED',
        wip_manifest_path: params.latchResult.wip_capture?.manifest_path || null,
        work_package_contract_path: state.workPackageContractPath,
        next_action: 'follow_auto_split_prompt',
        state_next_action: state.stateNextAction,
        next_action_command: state.nextActionCommand,
        instructions: [
            'inspect_actual_split_required_state',
            'define_root_cause_work_package_contract',
            'run_validation_lane_before_child_creation',
            'create_parent_derived_child_tasks'
        ],
        constraints: [
            'do_not_auto_commit_unfinished_or_unreviewed_work',
            'do_not_mark_parent_done_because_split_exists',
            'do_not_decompose_one_child_per_finding',
            'preservation_is_not_review_or_completion',
            'preserve_review_cycle_block_reason',
            'stop_if_split_cannot_proceed_cleanly'
        ]
    };
}

export function buildReviewCycleOperatorBlock(
    evaluation: ReviewCycleGuardEvaluation,
    latestFailedReview: NextStepReviewCycleLatestFailedReview | null
): NextStepReviewCycleBlock {
    const countsByReviewType = Object.fromEntries(
        Object.entries(evaluation.counts_by_review_type)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([reviewType, counts]) => [
                reviewType,
                {
                    total: counts.total,
                    failed: counts.failed,
                    passed: counts.passed,
                    pending: counts.pending
                }
            ])
    );
    const hasReviewCyclePressureViolation = evaluation.violations.some((violation) =>
        violation.metric === 'failed_non_test_review_count'
        || violation.metric === 'total_non_test_review_count'
    );
    const autoSplitEnabled = evaluation.action === 'BLOCK_FOR_OPERATOR_DECISION'
        && evaluation.violations.length > 0
        && evaluation.active
        && hasReviewCyclePressureViolation
        && evaluation.auto_split_enabled;
    const reason = autoSplitEnabled
        ? sanitizeReviewCycleAutoSplitSummary(evaluation)
        : evaluation.summary_line;

    return {
        kind: 'review_cycle_guard',
        operator_decision_required: !autoSplitEnabled,
        wait_for_operator: !autoSplitEnabled,
        auto_split_enabled: autoSplitEnabled,
        reason,
        max_failed_non_test_reviews: evaluation.max_failed_non_test_reviews,
        max_total_non_test_reviews: evaluation.max_total_non_test_reviews,
        total_non_test_review_count: evaluation.total_non_test_review_count,
        failed_non_test_review_count: evaluation.failed_non_test_review_count,
        counts_by_review_type: countsByReviewType,
        cumulative_total_non_test_review_count: evaluation.attempt_diagnostics.cumulative_total_non_test_review_count,
        cumulative_failed_non_test_review_count: evaluation.attempt_diagnostics.cumulative_failed_non_test_review_count,
        current_scope_total_non_test_review_count: evaluation.current_scope_total_non_test_review_count,
        current_scope_failed_non_test_review_count: evaluation.current_scope_failed_non_test_review_count,
        current_scope_counts_by_review_type: evaluation.current_scope_counts_by_review_type,
        fresh_non_test_review_count: evaluation.attempt_diagnostics.fresh_non_test_review_count,
        reused_non_test_review_count: evaluation.attempt_diagnostics.reused_non_test_review_count,
        fresh_reused_by_review_type: evaluation.attempt_diagnostics.fresh_reused_by_review_type,
        scope_hash_count_by_review_type: evaluation.attempt_diagnostics.scope_hash_count_by_review_type,
        top_scope_hashes_by_review_type: evaluation.attempt_diagnostics.top_scope_hashes_by_review_type,
        excluded_review_types: evaluation.excluded_review_types,
        latest_failed_review: latestFailedReview,
        choices: [...REVIEW_CYCLE_OPERATOR_CHOICES],
        operator_choice_guidance: [...REVIEW_CYCLE_OPERATOR_CHOICE_GUIDANCE],
        auto_split_prompt: null
    };
}
