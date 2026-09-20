import type { ScopeBudgetGuardEvaluation } from '../../core/scope-budget-guard';
import type {
    ReviewCycleContinuationAssessment
} from '../review-cycle/review-cycle-continuation';
import type {
    NextStepReviewCycleBlock,
    ReviewCycleGuardEvaluation
} from './next-step-review-cycle-guard';
import type {
    SplitRequiredLatchResult
} from './next-step-split-required-latch';
import {
    buildCommand,
    formatNextStepInlineList,
    formatNextStepInlineValue
} from './next-step-command-formatters';
import type {
    NextStepDecisionRoutePayload
} from './next-step-decision-route-groups';
import {
    getActiveTaskLifecycleGateIds,
    resolveFirstActiveTaskLifecycleGate
} from '../../runtime/task-lifecycle-phase-runtime';

type ValidationRoute = NextStepDecisionRoutePayload;

interface BaselineOnlyRoute {
    nextGate: string;
    title: string;
    reason: string;
    commands?: NextStepDecisionRoutePayload['commands'];
}

interface TestFirstExpectedFailureRoute {
    nextGate: string;
    title: string;
    reason: string;
    commands: NextStepDecisionRoutePayload['commands'];
}

export interface NextStepGuardDecision {
    route: NextStepDecisionRoutePayload | null;
    warnings: string[];
}

export function resolveScopeBudgetGuardDecisionRoute(options: {
    evaluation: ScopeBudgetGuardEvaluation | null;
    guardReason: string | null;
    materializeLatch: () => SplitRequiredLatchResult;
    formatArtifactPath: (artifactPath: string) => string;
    presentArtifacts: NextStepDecisionRoutePayload['presentArtifacts'];
}): NextStepGuardDecision {
    const evaluation = options.evaluation;
    if (!evaluation) {
        return { route: null, warnings: [] };
    }
    const warnings = evaluation.should_warn
        ? [
            `${evaluation.summary_line}. Continuation allowed until a blocking scope-budget threshold is exceeded.`
        ]
        : [];
    if (!evaluation.should_block) {
        return { route: null, warnings };
    }

    const guardReason = options.guardReason || evaluation.summary_line;
    const latchResult = options.materializeLatch();
    if (
        latchResult.status_sync.outcome !== 'updated'
        && latchResult.status_sync.outcome !== 'already_synced'
    ) {
        return {
            warnings,
            route: {
                status: 'BLOCKED',
                nextGate: 'split-required-latch',
                title: 'Split-required latch could not update TASK.md.',
                reason:
                    `${guardReason}. The split-required latch artifact was materialized at ${formatNextStepInlineValue(options.formatArtifactPath(latchResult.artifact_path))}, ` +
                    `but TASK.md status sync failed with outcome ${formatNextStepInlineValue(latchResult.status_sync.outcome)}. ` +
                    `${latchResult.status_sync.error_message ? `${latchResult.status_sync.error_message} ` : ''}` +
                    'Do not continue parent compile, review, full-suite, completion, or final closeout gates until the latch is repaired.',
                commands: [],
                finalReport: null
            }
        };
    }

    return {
        warnings,
        route: {
            status: 'SPLIT_REQUIRED',
            nextGate: 'split-required-latch',
            title: 'Split-required latch is active.',
            reason:
                `${guardReason}. The gate moved this parent task to SPLIT_REQUIRED and materialized latch evidence at ` +
                `${formatNextStepInlineValue(options.formatArtifactPath(latchResult.artifact_path))}. ` +
                'Create and link child tasks before continuing; do not shrink or reshape the diff merely to bypass the guard. ' +
                'Ordinary classify, compile, review, full-suite, completion, and final closeout gates are suppressed for the parent while the latch is active.',
            commands: [],
            missingArtifacts: [],
            presentArtifacts: options.presentArtifacts,
            finalReport: null
        }
    };
}

export function resolveReviewCycleGuardDecisionRoute(options: {
    evaluation: ReviewCycleGuardEvaluation | null;
    getPendingRequiredReviewTypes: () => string[];
    assessContinuation: (
        pendingRequiredReviewTypes: string[]
    ) => ReviewCycleContinuationAssessment;
    buildOperatorBlock: () => NextStepReviewCycleBlock;
    materializeLatch: () => SplitRequiredLatchResult;
    materializeAutoSplitPrompt: (
        latchResult: SplitRequiredLatchResult
    ) => NextStepReviewCycleBlock['auto_split_prompt'];
    buildContinuationCommand: () => string;
    buildSplitDecisionCommand: () => string;
    formatArtifactPath: (artifactPath: string) => string;
    presentArtifacts: NextStepDecisionRoutePayload['presentArtifacts'];
    defaultMissingArtifacts: NextStepDecisionRoutePayload['missingArtifacts'];
}): NextStepGuardDecision {
    const evaluation = options.evaluation;
    if (!evaluation) {
        return { route: null, warnings: [] };
    }

    if (!evaluation.should_block) {
        const warnings = evaluation.active
            && evaluation.action === 'WARN_ONLY'
            && evaluation.violations.length > 0
            ? [
                `${evaluation.summary_line}. ` +
                `Counts: total_non_test_reviews=${evaluation.total_non_test_review_count}, ` +
                `failed_non_test_reviews=${evaluation.failed_non_test_review_count}, ` +
                `excluded_review_types=${formatNextStepInlineList(evaluation.excluded_review_types)}.`
            ]
            : [];
        return { route: null, warnings };
    }

    const continuationEvidence = options.assessContinuation(
        options.getPendingRequiredReviewTypes()
    );
    if (continuationEvidence.status === 'ACTIVE') {
        return {
            route: null,
            warnings: [
                `Review cycle one-shot continuation active: ${continuationEvidence.reason}. ` +
                `Artifact: ${formatNextStepInlineValue(options.formatArtifactPath(continuationEvidence.artifact_path))}. ` +
                'This approval is task-scoped runtime evidence only and does not mutate workflow-config.json; raise_limits remains a permanent repo-local workflow-config change through workflow set.'
            ]
        };
    }

    const warnings = continuationEvidence.status === 'MISSING'
        ? []
        : [
            `Review cycle one-shot continuation ${continuationEvidence.status.toLowerCase()}: ${continuationEvidence.reason}. ` +
            `Artifact: ${formatNextStepInlineValue(options.formatArtifactPath(continuationEvidence.artifact_path))}.`
        ];
    const reviewCycleBlock = options.buildOperatorBlock();
    const continuationAlreadyRecorded = continuationEvidence.status !== 'MISSING';
    if (continuationAlreadyRecorded) {
        reviewCycleBlock.choices = reviewCycleBlock.choices.filter(
            (choice) => choice !== 'allow_one_more_cycle'
        );
        reviewCycleBlock.operator_choice_guidance = reviewCycleBlock.operator_choice_guidance
            .filter((guidance) => !guidance.startsWith('allow_one_more_cycle:'));
        reviewCycleBlock.operator_choice_guidance.push(
            'continuation_already_recorded: A one-shot continuation was already recorded for this task attempt; do not offer or accept another one. Continue by splitting/decomposing the task or choosing an explicit terminal/operator decision.'
        );
    }

    const autoSplitEnabled = reviewCycleBlock.auto_split_enabled;
    const continuationDecisionGuidance = continuationAlreadyRecorded
        ? 'A one-shot continuation was already recorded for this task attempt; do not offer or accept another one. Continue by splitting/decomposing the task or choosing an explicit terminal/operator decision.'
        : 'The configured workflow guard blocks additional compile, review, or full-suite continuation until operator decision. allow_one_more_cycle records task-scoped one-shot runtime evidence only; raise_limits is a permanent repo-local workflow-config change through workflow set.';
    let splitRequiredLatch: SplitRequiredLatchResult | null = null;
    if (autoSplitEnabled) {
        splitRequiredLatch = options.materializeLatch();
        if (
            splitRequiredLatch.status_sync.outcome !== 'updated'
            && splitRequiredLatch.status_sync.outcome !== 'already_synced'
        ) {
            return {
                warnings,
                route: {
                    status: 'BLOCKED',
                    nextGate: 'split-required-latch',
                    title: 'Split-required latch could not update TASK.md.',
                    reason:
                        `${reviewCycleBlock.reason}. The split-required latch artifact was materialized at ` +
                        `${formatNextStepInlineValue(options.formatArtifactPath(splitRequiredLatch.artifact_path))}, ` +
                        `but TASK.md status sync failed with outcome ${formatNextStepInlineValue(splitRequiredLatch.status_sync.outcome)}. ` +
                        `${splitRequiredLatch.status_sync.error_message ? `${splitRequiredLatch.status_sync.error_message} ` : ''}` +
                        'Do not continue parent compile, review, full-suite, completion, or final closeout gates until the latch is repaired.',
                    commands: [],
                    reviewCycleBlock,
                    finalReport: null
                }
            };
        }
        reviewCycleBlock.auto_split_prompt = options.materializeAutoSplitPrompt(splitRequiredLatch);
    }

    return {
        warnings,
        route: {
            status: autoSplitEnabled ? 'SPLIT_REQUIRED' : 'BLOCKED',
            nextGate: autoSplitEnabled ? 'split-required-latch' : 'review-cycle-attempt-guard',
            title: autoSplitEnabled ? 'Split-required latch is active.' : 'Review cycle limit exceeded.',
            reason:
                `${reviewCycleBlock.reason}. ` +
                `Counts: total_non_test_reviews=${evaluation.total_non_test_review_count}, ` +
                `failed_non_test_reviews=${evaluation.failed_non_test_review_count}, ` +
                `excluded_review_types=${formatNextStepInlineList(evaluation.excluded_review_types)}. ` +
                (autoSplitEnabled
                    ? `The gate moved this parent task to SPLIT_REQUIRED and materialized latch evidence at ${formatNextStepInlineValue(options.formatArtifactPath(splitRequiredLatch?.artifact_path || ''))}. Follow the auto-split prompt artifact and create linked child tasks before continuing child work.`
                    : continuationDecisionGuidance),
            commands: autoSplitEnabled
                ? []
                : [
                    ...(continuationAlreadyRecorded
                        ? []
                        : [
                            buildCommand(
                                'Record one-shot review-cycle continuation',
                                options.buildContinuationCommand()
                            )
                        ]),
                    buildCommand(
                        'Record review-cycle split decision',
                        options.buildSplitDecisionCommand()
                    )
                ],
            reviewCycleBlock,
            missingArtifacts: autoSplitEnabled ? [] : options.defaultMissingArtifacts,
            presentArtifacts: options.presentArtifacts,
            finalReport: null
        }
    };
}

export function resolveValidationDecisionRoute(options: {
    lifecycleGateIds?: readonly string[];
    resolveQualityChecklistRoute: () => ValidationRoute | null;
    resolveBaselineOnlyPreImplementationRoute: () => BaselineOnlyRoute | null;
    resolveTestFirstExpectedFailureRoute?: () => TestFirstExpectedFailureRoute | null;
    resolveCompileGateRoute: () => ValidationRoute | null;
    resolveAuditedNoOpState: () => {
        required: boolean;
        passed: boolean;
        evidenceStatus: string;
        command: string;
    };
    resolveFullSuiteValidationRoute: () => ValidationRoute | null;
}): NextStepDecisionRoutePayload | null {
    const gateIds = options.lifecycleGateIds ?? getActiveTaskLifecycleGateIds('validation', {
        changes_exist: true,
        optional_quality_checks_enabled: true,
        full_suite_after_compile_before_reviews: true
    });
    let baselineChecked = false;
    let testFirstChecked = false;
    let noOpChecked = false;
    const resolveBaselineRoute = (): ValidationRoute | null => {
        baselineChecked = true;
        const route = options.resolveBaselineOnlyPreImplementationRoute();
        return route
            ? {
                status: 'BLOCKED',
                nextGate: route.nextGate,
                title: route.title,
                reason: route.reason,
                commands: route.commands ?? []
            }
            : null;
    };
    const resolveTestFirstRoute = (): ValidationRoute | null => {
        testFirstChecked = true;
        const route = options.resolveTestFirstExpectedFailureRoute?.() ?? null;
        return route
            ? {
                status: 'BLOCKED',
                nextGate: route.nextGate,
                title: route.title,
                reason: route.reason,
                commands: route.commands
            }
            : null;
    };
    const resolveNoOpRoute = (): ValidationRoute | null => {
        noOpChecked = true;
        const state = options.resolveAuditedNoOpState();
        if (!state.required || state.passed) {
            return null;
        }
        return {
            status: 'BLOCKED',
            nextGate: 'record-no-op',
            title: 'Record audited zero-diff no-op evidence.',
            reason:
                'The current preflight is BASELINE_ONLY with no reviewable diff and requires audited no-op evidence before review or completion gates can pass. ' +
                `Record no-op evidence or implement changes and refresh preflight; current no-op evidence status: ${state.evidenceStatus}.`,
            commands: [buildCommand('Record audited no-op evidence', state.command)]
        };
    };
    const route = resolveFirstActiveTaskLifecycleGate(gateIds, {
        'optional-quality-checklist': options.resolveQualityChecklistRoute,
        'compile-gate': () => (
            resolveBaselineRoute()
            ?? resolveTestFirstRoute()
            ?? options.resolveCompileGateRoute()
        ),
        'full-suite-validation': () => resolveNoOpRoute() ?? options.resolveFullSuiteValidationRoute()
    });
    if (route) {
        return route;
    }
    return (!baselineChecked ? resolveBaselineRoute() : null)
        ?? (!testFirstChecked ? resolveTestFirstRoute() : null)
        ?? (!noOpChecked ? resolveNoOpRoute() : null);
}
