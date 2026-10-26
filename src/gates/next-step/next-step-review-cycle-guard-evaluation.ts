import { countNextStepWork } from '../../core/next-step-measurement';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
    evaluateReviewCycleGuard,
    normalizeReviewCycleGuardConfig
} from '../../core/review-cycle-guard';
import {
    buildDefaultWorkflowConfig
} from '../../core/workflow-config';
import {
    validateWorkflowConfig
} from '../../schemas/config-artifacts';
import {
    resolveWorkflowConfigPath
} from '../full-suite/full-suite-validation';
import {
    toRepoDisplayPath
} from './next-step-command-formatters';
import {
    readCurrentReviewCyclePreflightFingerprints
} from './next-step-review-cycle-scope';
import {
    readReviewCycleGuardAttempts
} from './next-step-review-cycle-guard-attempts';
import {
    buildReviewCycleAttemptDiagnostics,
    extendReviewCycleGuardEvaluation
} from './next-step-review-cycle-guard-diagnostics';
import {
    type ReviewCycleGuardReadEvaluationResult
} from './next-step-review-cycle-guard-types';
import { isPlainRecord } from '../../core/records';

function fileExists(filePath: string): boolean {
    return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
}

function readWorkflowConfigRecordForReviewCycleGuard(repoRoot: string): Record<string, unknown> | null {
    const workflowConfigPath = resolveWorkflowConfigPath(repoRoot);
    if (!fileExists(workflowConfigPath)) {
        return null;
    }

    let workflowConfig: unknown;
    try {
        workflowConfig = JSON.parse(fs.readFileSync(workflowConfigPath, 'utf8'));
    } catch (error: unknown) {
        throw new Error(
            `Workflow config at '${toRepoDisplayPath(repoRoot, workflowConfigPath)}' is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
        );
    }
    if (!isPlainRecord(workflowConfig)) {
        throw new Error(
            `Workflow config at '${toRepoDisplayPath(repoRoot, workflowConfigPath)}' must be a JSON object.`
        );
    }
    return workflowConfig;
}

export function readReviewCycleGuardEvaluation(
    repoRoot: string,
    eventsRoot: string,
    taskId: string
): ReviewCycleGuardReadEvaluationResult {
    const defaultWorkflowConfig = buildDefaultWorkflowConfig();
    let rawReviewCycleGuard: unknown = defaultWorkflowConfig.review_cycle_guard;
    const workflowConfig = readWorkflowConfigRecordForReviewCycleGuard(repoRoot);
    if (workflowConfig?.review_cycle_guard !== undefined) {
        const validatedWorkflowConfig = validateWorkflowConfig({
            full_suite_validation: defaultWorkflowConfig.full_suite_validation,
            review_execution_policy: defaultWorkflowConfig.review_execution_policy,
            scope_budget_guard: defaultWorkflowConfig.scope_budget_guard,
            review_cycle_guard: workflowConfig.review_cycle_guard
        });
        rawReviewCycleGuard = isPlainRecord(validatedWorkflowConfig.review_cycle_guard)
            ? validatedWorkflowConfig.review_cycle_guard
            : defaultWorkflowConfig.review_cycle_guard;
    }
    const reviewCycleGuardConfig = normalizeReviewCycleGuardConfig(rawReviewCycleGuard);
    if (!reviewCycleGuardConfig.enabled) {
        const diagnostics = buildReviewCycleAttemptDiagnostics([], reviewCycleGuardConfig.excluded_review_types);
        const evaluation = evaluateReviewCycleGuard(reviewCycleGuardConfig, {
            attempts: [],
            timelineValid: true
        });
        return {
            evaluation: extendReviewCycleGuardEvaluation(evaluation, evaluation, diagnostics, false),
            latestFailedReview: null
        };
    }

    const timelinePath = path.join(eventsRoot, `${taskId}.jsonl`);
    const reviewCycleAttempts = readReviewCycleGuardAttempts(
        repoRoot,
        timelinePath,
        taskId,
        reviewCycleGuardConfig,
        readCurrentReviewCyclePreflightFingerprints(eventsRoot, taskId)
    );
    const evaluation = evaluateReviewCycleGuard(
        reviewCycleGuardConfig,
        {
            attempts: reviewCycleAttempts.attempts,
            timelineValid: reviewCycleAttempts.timelineValid
        }
    );
    const currentScopeEvaluation = evaluateReviewCycleGuard(
        reviewCycleGuardConfig,
        {
            attempts: reviewCycleAttempts.attempts.filter((attempt) => (countNextStepWork('visit:next-step-review-cycle-guard-evaluation:event:111'), attempt.currentScope)),
            timelineValid: reviewCycleAttempts.timelineValid
        }
    );
    const diagnostics = buildReviewCycleAttemptDiagnostics(
        reviewCycleAttempts.attempts,
        reviewCycleGuardConfig.excluded_review_types
    );

    return {
        evaluation: extendReviewCycleGuardEvaluation(
            evaluation,
            currentScopeEvaluation,
            diagnostics,
            evaluation.violations.length > 0 || currentScopeEvaluation.violations.length > 0
        ),
        latestFailedReview: reviewCycleAttempts.latestFailedReview
    };
}
