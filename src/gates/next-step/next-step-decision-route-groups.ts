import * as fs from 'node:fs';
import * as path from 'node:path';

import {
    isTaskQueueActiveStatus,
    isTaskQueueDecomposedStatus,
    isTaskQueueDoneStatus,
    isTaskQueueSplitRequiredStatus
} from '../../core/active-task-state';
import { TASK_QUEUE_FILENAME } from '../../core/orchestration-constants';
import {
    describeDecomposedTaskProvenance,
    extractExplicitLinkedChildTaskIds,
    hasLinkedChildTasks,
    isDecomposedParentTask,
    resolveDecomposedParentCompletionState,
    resolveNextUnfinishedChildRoute,
    type TaskQueueEntry
} from './next-step-task-queue';
import {
    buildCommand,
    formatNextStepInlineValue,
    toRepoDisplayPath
} from './next-step-command-formatters';
import {
    restoreSplitRequiredParentFromPermanentLatch,
    transitionDecomposedParentsToDone,
    transitionSplitRequiredParentToReviewCycleContinuation,
    transitionSplitRequiredParentToDecomposed
} from './next-step-task-queue-transitions';
import {
    resolveDecomposedParentTerminalRoute,
    resolveDoneTaskQueueTerminalRoute,
    resolvePermanentSplitRequiredLatchRoute,
    resolveSplitRequiredTaskQueueRoute
} from './next-step-terminal-status-routing';
import {
    assessReviewCycleContinuationSplitLatchClearance,
    hasCompletedDecomposedParentAfterSplitRequiredClear,
    hasGateOwnedDecomposedParentCompletionEvidence,
    hasReviewCycleContinuationClearedEvidence,
    hasSplitRequiredClearedEvidence,
    readSplitRequiredLatchEvidence,
    suspendSplitRequiredWipBeforeDecomposition,
    type SplitRequiredLatchEvidence
} from './next-step-split-required-latch';
import type {
    ReviewCycleContinuationAssessment
} from '../review-cycle/review-cycle-continuation';
import {
    readFullSuiteRepairTaskMaterializationEvidence
} from '../full-suite/full-suite-repair-task';
import {
    resolveFullSuiteRepairDecompositionState
} from '../full-suite/full-suite-repair-decomposition';
import {
    resolveNextStepFullSuiteValidationRoute,
    type NextStepFullSuiteValidationRoutingOptions
} from './next-step-full-suite-routing';
import {
    resolveDelegatedReviewReadinessRoute,
    type DelegatedReviewReadinessRouteOptions
} from './next-step-review-readiness-routing';
import {
    resolveNextStepStartupRoute,
    type NextStepStartupRouteOptions
} from './next-step-startup-routing';
import {
    resolveNextStepPreGuardRoute,
    type NextStepOptionalSkillActivationRoutingOptions,
    type NextStepPreGuardRoutingOptions
} from './next-step-pre-review-routing';
import {
    suspendStrictDecompositionWipIfRequired
} from './next-step-strict-decomposition-wip';
import {
    resolveCompletedCloseoutRouteFromState
} from './next-step-closeout-routing';
import type {
    NextStepArtifactState,
    NextStepCommand,
    NextStepFinalReportSummary,
    NextStepOptionalSkillSelectionSummary,
    NextStepReviewCycleBlock,
    NextStepStatus
} from './next-step';

export interface NextStepDecisionRoutePayload {
    status: NextStepStatus;
    nextGate: string | null;
    title: string;
    reason: string;
    commands: NextStepCommand[];
    missingArtifacts?: NextStepArtifactState[];
    presentArtifacts?: NextStepArtifactState[];
    reviewCycleBlock?: NextStepReviewCycleBlock | null;
    finalReport?: NextStepFinalReportSummary | null;
}

function hasTerminalDiscardResetEvidence(options: {
    reviewsRoot: string;
    taskId: string;
}): boolean {
    const resetReportPath = path.join(options.reviewsRoot, `${options.taskId}-reset-report.json`);
    try {
        const report = JSON.parse(fs.readFileSync(resetReportPath, 'utf8')) as Record<string, unknown>;
        return report.event_source === 'task-reset'
            && report.task_id === options.taskId
            && report.target_status === 'DONE'
            && report.reset_by === 'operator'
            && typeof report.timestamp_utc === 'string'
            && Number.isFinite(Date.parse(report.timestamp_utc));
    } catch {
        return false;
    }
}

export function resolveTaskIdCaseMismatchDecisionRoute(options: {
    requestedTaskId: string;
    taskIdCaseMismatch: string | null;
    cliPrefix: string;
    presentArtifacts: NextStepArtifactState[];
}): NextStepDecisionRoutePayload | null {
    if (!options.taskIdCaseMismatch) {
        return null;
    }
    return {
        status: 'BLOCKED',
        nextGate: 'task-id-casing',
        title: 'Task ID casing does not match TASK.md.',
        reason:
            `Requested task id ${formatNextStepInlineValue(options.requestedTaskId)} matches TASK.md row ` +
            `${formatNextStepInlineValue(options.taskIdCaseMismatch)} only by case. ` +
            'Use the exact TASK.md task id before any lifecycle gate so artifacts cannot fork into a parallel casing namespace.',
        commands: [
            buildCommand(
                'Rerun navigator with TASK.md casing',
                `${options.cliPrefix} next-step "${options.taskIdCaseMismatch}" --repo-root "."`
            )
        ],
        missingArtifacts: [],
        presentArtifacts: options.presentArtifacts,
        finalReport: null
    };
}

export function resolveCompletedCloseoutDecisionRoute(options: {
    completionGatePassed: boolean;
    latestCompletionCurrent: boolean;
    postDoneDriftBlocked: boolean;
    postDoneDriftReason: string;
    finalReportContractReady: boolean;
    finalReportContractBlocker: string;
    finalReport: NextStepFinalReportSummary | null;
    taskAuditCommand: string;
    missingArtifacts: NextStepArtifactState[];
}): NextStepDecisionRoutePayload | null {
    if (!options.completionGatePassed || !options.latestCompletionCurrent) {
        return null;
    }
    const route = resolveCompletedCloseoutRouteFromState({
        postDoneDriftBlocked: options.postDoneDriftBlocked,
        postDoneDriftReason: options.postDoneDriftReason,
        finalReportContractReady: options.finalReportContractReady,
        finalReportContractBlocker: options.finalReportContractBlocker,
        finalReport: options.finalReport,
        taskAuditCommand: options.taskAuditCommand
    });
    return {
        status: route.status,
        nextGate: route.nextGate,
        title: route.title,
        reason: route.reason,
        commands: route.commands,
        missingArtifacts: route.status === 'DONE' ? [] : options.missingArtifacts,
        finalReport: route.finalReport as NextStepFinalReportSummary | null
    };
}

export function resolveStartupDecisionRoute(
    options: NextStepStartupRouteOptions
): NextStepDecisionRoutePayload | null {
    const route = resolveNextStepStartupRoute(options);
    return route
        ? {
            status: route.status,
            nextGate: route.nextGate,
            title: route.title,
            reason: route.reason,
            commands: route.commands
        }
        : null;
}

interface FailedGateRecoveryDecision {
    nextGate: string;
    title: string;
    reason: string;
    command?: string | null;
    label?: string | null;
}

export function resolveClassifyDecisionRoute(options: {
    preflightExists: boolean;
    classifyChangePassed: boolean;
    readFailedGateRecovery: () => FailedGateRecoveryDecision | null;
    resolveStrictDecompositionRoute: () => NextStepDecisionRoutePayload | null;
    resolveProtectedScopeRoute: () => NextStepDecisionRoutePayload | null;
    buildClassifyCommand: () => string;
}): NextStepDecisionRoutePayload | null {
    if (options.preflightExists && options.classifyChangePassed) {
        return null;
    }
    const failedGateRecovery = options.readFailedGateRecovery();
    if (failedGateRecovery) {
        return {
            status: 'BLOCKED',
            nextGate: failedGateRecovery.nextGate,
            title: failedGateRecovery.title,
            reason: failedGateRecovery.reason,
            commands: failedGateRecovery.command
                ? [
                    buildCommand(
                        failedGateRecovery.label || failedGateRecovery.nextGate,
                        failedGateRecovery.command
                    )
                ]
                : []
        };
    }
    const strictDecompositionRoute = options.resolveStrictDecompositionRoute();
    if (strictDecompositionRoute) {
        return strictDecompositionRoute;
    }
    const protectedScopeRoute = options.resolveProtectedScopeRoute();
    if (protectedScopeRoute) {
        return protectedScopeRoute;
    }
    return {
        status: 'BLOCKED',
        nextGate: 'classify-change',
        title: 'Classify the task scope.',
        reason: 'No current preflight artifact exists, so required reviews and compile scope are unknown.',
        commands: [
            buildCommand('Classify changed files', options.buildClassifyCommand())
        ]
    };
}

export function resolveOptionalSkillSelectionDecisionRoute(options: {
    optionalSkillSelection: NextStepOptionalSkillSelectionSummary | null;
    mandatoryRemediation: { label: string; command: string; reason: string } | null;
    mandatoryPolicyMode: boolean;
    refreshCommand: string;
    timelineIntegrityCommand: string;
}): NextStepDecisionRoutePayload | null {
    const optionalSkillSelection = options.optionalSkillSelection;
    if (optionalSkillSelection?.artifact_violations.length) {
        return {
            status: 'BLOCKED',
            nextGate: 'classify-change',
            title: 'Refresh invalid optional-skill selection artifact.',
            reason:
                'The current optional-skill selection artifact is invalid for navigator use. ' +
                `${optionalSkillSelection.artifact_violations.join(' ')} ` +
                'Rerun classify-change so phase/source evidence is regenerated before activation, review, or closeout.',
            commands: [
                buildCommand(
                    'Refresh preflight and optional-skill selection',
                    options.refreshCommand
                )
            ]
        };
    }
    if (options.mandatoryRemediation) {
        return {
            status: 'BLOCKED',
            nextGate: 'optional-skill-remediation',
            title: 'Resolve mandatory optional-skill selection before implementation.',
            reason: options.mandatoryRemediation.reason,
            commands: [
                buildCommand(
                    options.mandatoryRemediation.label,
                    options.mandatoryRemediation.command
                )
            ]
        };
    }
    if (
        optionalSkillSelection?.decision === 'selected_installed_skills'
        && optionalSkillSelection.timeline_invalid_json
        && options.mandatoryPolicyMode
    ) {
        return {
            status: 'BLOCKED',
            nextGate: 'task-events-summary',
            title: 'Repair malformed task timeline before optional-skill activation.',
            reason:
                'The current task timeline JSONL is malformed, so current-cycle optional-skill activation evidence cannot be read reliably. ' +
                'Do not run activate-optional-skill until task-event integrity is repaired; otherwise newly appended SKILL_SELECTED events may remain invisible to the navigator.',
            commands: [
                buildCommand(
                    'Inspect task timeline integrity',
                    options.timelineIntegrityCommand
                )
            ]
        };
    }
    return null;
}

export function resolvePreGuardDecisionRoute(
    options: NextStepPreGuardRoutingOptions
): NextStepDecisionRoutePayload | null {
    const route = resolveNextStepPreGuardRoute(options);
    return route
        ? {
            status: route.status,
            nextGate: route.nextGate,
            title: route.title,
            reason: route.reason,
            commands: route.commands
        }
        : null;
}

export function resolvePendingOptionalSkillDecisionRoute(
    optionalSkillActivation: NextStepOptionalSkillActivationRoutingOptions | null
): NextStepDecisionRoutePayload | null {
    if (!optionalSkillActivation) {
        return null;
    }
    return {
        status: 'BLOCKED',
        nextGate: 'activate-optional-skill',
        title: 'Activate the selected optional skill.',
        reason:
            `Current preflight selected optional skill ${formatNextStepInlineValue(optionalSkillActivation.skillId)}, ` +
            'but the current task cycle has no matching activation evidence yet. ' +
            'Record activation before restart-coherent-cycle, compile, review, implementation, or closeout so selected-skill diagnostics and final audit describe the same current-cycle state.',
        commands: [
            buildCommand(
                `Activate optional skill ${optionalSkillActivation.skillId}`,
                optionalSkillActivation.command
            )
        ]
    };
}

export function resolveFullSuiteDecisionRoute(
    options: NextStepFullSuiteValidationRoutingOptions
): NextStepDecisionRoutePayload | null {
    const route = resolveNextStepFullSuiteValidationRoute(options);
    return route
        ? {
            status: route.status,
            nextGate: route.nextGate,
            title: route.title,
            reason: route.reason,
            commands: route.commands
        }
        : null;
}

export function resolveDelegatedReviewDecisionRoute(
    options: DelegatedReviewReadinessRouteOptions
): NextStepDecisionRoutePayload | null {
    const route = resolveDelegatedReviewReadinessRoute(options);
    return route
        ? {
            status: route.status,
            nextGate: route.nextGate,
            title: route.title,
            reason: route.reason,
            commands: route.commands
        }
        : null;
}

function buildContinueChildCommand(
    cliPrefix: string,
    childRoute: { taskId: string } | null
): NextStepCommand | null {
    return childRoute
        ? buildCommand(
            'Continue child task',
            `${cliPrefix} next-step "${childRoute.taskId}" --repo-root "."`
        )
        : null;
}

function isSuccessfulStatusSync(summary: { outcome: string }): boolean {
    return summary.outcome === 'updated' || summary.outcome === 'already_synced';
}

function transitionSplitRequiredParentAfterWipSuspension(options: {
    repoRoot: string;
    reviewsRoot: string;
    eventsRoot: string;
    taskId: string;
    latchEvidence: SplitRequiredLatchEvidence;
}): { outcome: string; error_message: string | null } {
    const statusLockPath = `${path.join(options.repoRoot, TASK_QUEUE_FILENAME)}.garda-status-sync.lock`;
    if (fs.existsSync(statusLockPath)) {
        return {
            outcome: 'write_failed',
            error_message: `Could not acquire TASK.md status-sync lock: lock already exists at ${statusLockPath}`
        };
    }
    const wipSuspension = suspendSplitRequiredWipBeforeDecomposition(options);
    if (wipSuspension.status === 'BLOCKED') {
        return {
            outcome: 'write_failed',
            error_message:
                'Parent WIP could not be captured and suspended before child routing: ' +
                (wipSuspension.violations.join('; ') || 'unknown capture violation')
        };
    }
    return transitionSplitRequiredParentToDecomposed(options);
}

function resolveCompletedFullSuiteRepairWipRestoreRoute(options: {
    repoRoot: string;
    reviewsRoot: string;
    taskId: string;
    cliPrefix: string;
    taskEntries: Map<string, TaskQueueEntry>;
    taskEntry: TaskQueueEntry | null;
    fullSuiteArtifactPath?: string;
}): NextStepDecisionRoutePayload | null {
    if (!options.fullSuiteArtifactPath) {
        return null;
    }
    const decomposition = resolveFullSuiteRepairDecompositionState(
        options.repoRoot,
        options.taskId,
        { allowCompletedChildren: true }
    );
    const childTaskIds = decomposition.child_task_ids;
    if (
        !decomposition.ready
        || childTaskIds.some((childTaskId) => {
            const childEntry = options.taskEntries.get(childTaskId);
            return !childEntry || !isTaskQueueDoneStatus(childEntry.status);
        })
    ) {
        return null;
    }
    const evidence = readFullSuiteRepairTaskMaterializationEvidence({
        repoRoot: options.repoRoot,
        reviewsRoot: options.reviewsRoot,
        taskId: options.taskId,
        fullSuiteArtifactPath: options.fullSuiteArtifactPath,
        childTaskId: null,
        childTaskIds
    });
    if (!evidence.materialized || !evidence.wip_manifest_path) {
        return null;
    }
    const fullSuiteArtifactPath = toRepoDisplayPath(options.repoRoot, options.fullSuiteArtifactPath);
    const restoreBindingFlags =
        `--task-id "${options.taskId}" ` +
        `--full-suite-artifact-path "${fullSuiteArtifactPath}"`;
    return {
            status: 'BLOCKED',
            nextGate: 'restore-full-suite-repair-wip',
            title: 'Restore suspended full-suite repair WIP before resuming parent.',
            reason:
                `All linked full-suite repair children are DONE (${childTaskIds.join(', ')}) and materialized repair evidence is current. ` +
                'Restore the suspended parent WIP before running parent classify, compile, review, full-suite, completion, or final closeout gates. ' +
                'The restore gate validates manifest paths, artifact hashes, stale base, tracked workspace cleanliness, and untracked target conflicts before applying the parent WIP.',
            commands: [
                buildCommand(
                    'Dry-run full-suite repair WIP restore',
                    `${options.cliPrefix} gate restore-full-suite-repair-wip ${restoreBindingFlags} --manifest-path "${evidence.wip_manifest_path}" --dry-run --repo-root "."`
                ),
                buildCommand(
                    'Restore full-suite repair WIP and resume parent',
                    `${options.cliPrefix} gate restore-full-suite-repair-wip ${restoreBindingFlags} --manifest-path "${evidence.wip_manifest_path}" --repo-root "."`
                )
            ],
            missingArtifacts: [],
            finalReport: null
        };
}

export function resolveTaskQueueTerminalDecisionRoute(options: {
    repoRoot: string;
    reviewsRoot: string;
    eventsRoot: string;
    taskId: string;
    cliPrefix: string;
    taskEntries: Map<string, TaskQueueEntry>;
    taskEntry: TaskQueueEntry | null;
    completionGatePassed: boolean;
    latestCompletionCurrent: boolean;
    finalReportContractReady: boolean;
    finalReportContractBlocker: string | null;
    summaryBlockers: readonly string[];
    filteredMissingArtifacts: NextStepArtifactState[];
    corePresentArtifacts: NextStepArtifactState[];
    fullSuiteArtifactPath?: string;
    reviewCycleContinuationAssessment?: ReviewCycleContinuationAssessment | null;
}): NextStepDecisionRoutePayload | null {
    const taskQueueStatus = options.taskEntry?.status || null;
    const splitRequiredStatusInTaskQueue = isTaskQueueSplitRequiredStatus(taskQueueStatus);
    const permanentSplitRequiredLatchEvidence = splitRequiredStatusInTaskQueue
        ? null
        : readSplitRequiredLatchEvidence({
            reviewsRoot: options.reviewsRoot,
            eventsRoot: options.eventsRoot,
            taskId: options.taskId
        });
    const decomposedStatusHasClearedLatchEvidence =
        isTaskQueueDecomposedStatus(taskQueueStatus)
        && permanentSplitRequiredLatchEvidence?.valid === true
        && hasSplitRequiredClearedEvidence({
            eventsRoot: options.eventsRoot,
            taskId: options.taskId,
            latchEvidence: permanentSplitRequiredLatchEvidence
        });
    const doneStatusHasCompletedClearedLatchEvidence =
        isTaskQueueDoneStatus(taskQueueStatus)
        && permanentSplitRequiredLatchEvidence?.valid === true
        && hasCompletedDecomposedParentAfterSplitRequiredClear({
            eventsRoot: options.eventsRoot,
            taskId: options.taskId,
            latchEvidence: permanentSplitRequiredLatchEvidence
        });
    const doneStatusHasGateOwnedDecomposedParentCompletionEvidence =
        isTaskQueueDoneStatus(taskQueueStatus)
        && hasGateOwnedDecomposedParentCompletionEvidence({
            eventsRoot: options.eventsRoot,
            taskId: options.taskId
        });
    const doneStatusHasTerminalDiscardEvidence =
        isTaskQueueDoneStatus(taskQueueStatus)
        && hasTerminalDiscardResetEvidence({
            reviewsRoot: options.reviewsRoot,
            taskId: options.taskId
        });
    const doneStatusHasAuthorizedTerminalEvidence = doneStatusHasCompletedClearedLatchEvidence
        || doneStatusHasGateOwnedDecomposedParentCompletionEvidence
        || doneStatusHasTerminalDiscardEvidence;
    const activeStatusHasClearedReviewCycleLatchEvidence =
        isTaskQueueActiveStatus(taskQueueStatus)
        && permanentSplitRequiredLatchEvidence?.valid === true
        && hasReviewCycleContinuationClearedEvidence({
            eventsRoot: options.eventsRoot,
            taskId: options.taskId,
            currentStatus: taskQueueStatus || '',
            latchEvidence: permanentSplitRequiredLatchEvidence
        });

    if (
        !splitRequiredStatusInTaskQueue
        && !decomposedStatusHasClearedLatchEvidence
        && !doneStatusHasAuthorizedTerminalEvidence
        && !activeStatusHasClearedReviewCycleLatchEvidence
        && permanentSplitRequiredLatchEvidence?.valid
    ) {
        const restoreResult = restoreSplitRequiredParentFromPermanentLatch({
            repoRoot: options.repoRoot,
            eventsRoot: options.eventsRoot,
            taskId: options.taskId,
            latchEvidence: permanentSplitRequiredLatchEvidence
        });

        const childRoute = resolveNextUnfinishedChildRoute(
            options.taskEntries,
            options.taskId,
            new Set<string>(),
            extractExplicitLinkedChildTaskIds
        );
        const hasChildren = hasLinkedChildTasks(options.taskEntries, options.taskId);
        let syncResult: ReturnType<typeof transitionSplitRequiredParentAfterWipSuspension> | null = null;
        if (hasChildren && isSuccessfulStatusSync(restoreResult)) {
            syncResult = transitionSplitRequiredParentAfterWipSuspension({
                repoRoot: options.repoRoot,
                reviewsRoot: options.reviewsRoot,
                eventsRoot: options.eventsRoot,
                taskId: options.taskId,
                latchEvidence: permanentSplitRequiredLatchEvidence
            });
        }

        const latchRoute = resolvePermanentSplitRequiredLatchRoute({
            taskId: options.taskId,
            restoreResult: {
                outcome: restoreResult.outcome,
                errorMessage: restoreResult.error_message
            },
            hasChildren,
            transitionResult: syncResult
                ? {
                    outcome: syncResult.outcome,
                    errorMessage: syncResult.error_message
                }
                : null,
            childRoute,
            continueChildCommand: buildContinueChildCommand(options.cliPrefix, childRoute)
        });
        return {
            status: latchRoute.status,
            nextGate: latchRoute.nextGate,
            title: latchRoute.title,
            reason: latchRoute.reason,
            commands: latchRoute.commands,
            missingArtifacts: [],
            presentArtifacts: options.corePresentArtifacts,
            finalReport: null
        };
    }

    if (splitRequiredStatusInTaskQueue) {
        const latchEvidence = readSplitRequiredLatchEvidence({
            reviewsRoot: options.reviewsRoot,
            eventsRoot: options.eventsRoot,
            taskId: options.taskId
        });
        const childRoute = resolveNextUnfinishedChildRoute(
            options.taskEntries,
            options.taskId,
            new Set<string>(),
            extractExplicitLinkedChildTaskIds
        );
        const hasChildren = hasLinkedChildTasks(options.taskEntries, options.taskId);
        if (!hasChildren) {
            const continuationClearance = assessReviewCycleContinuationSplitLatchClearance({
                eventsRoot: options.eventsRoot,
                taskId: options.taskId,
                latchEvidence,
                continuationAssessment: options.reviewCycleContinuationAssessment || null
            });
            if (continuationClearance.valid && continuationClearance.resume_status) {
                const continuationTransition = transitionSplitRequiredParentToReviewCycleContinuation({
                    repoRoot: options.repoRoot,
                    eventsRoot: options.eventsRoot,
                    taskId: options.taskId,
                    resumeStatus: continuationClearance.resume_status,
                    latchEvidence,
                    continuationAssessment: options.reviewCycleContinuationAssessment!
                });
                if (
                    continuationTransition.outcome === 'updated'
                    || continuationTransition.outcome === 'already_synced'
                ) {
                    return null;
                }
                return {
                    status: 'BLOCKED',
                    nextGate: 'split-required-latch',
                    title: 'Review-cycle continuation could not clear the split-required latch.',
                    reason:
                        `${continuationClearance.reason}, but TASK.md status recovery failed with outcome ` +
                        `${continuationTransition.outcome}. ${continuationTransition.error_message || ''}`.trim(),
                    commands: [],
                    missingArtifacts: [],
                    presentArtifacts: options.corePresentArtifacts,
                    finalReport: null
                };
            }
        }
        if (!childRoute) {
            const repairRestoreRoute = resolveCompletedFullSuiteRepairWipRestoreRoute({
                repoRoot: options.repoRoot,
                reviewsRoot: options.reviewsRoot,
                taskId: options.taskId,
                cliPrefix: options.cliPrefix,
                taskEntries: options.taskEntries,
                taskEntry: options.taskEntry,
                fullSuiteArtifactPath: options.fullSuiteArtifactPath
            });
            if (repairRestoreRoute) {
                return {
                    ...repairRestoreRoute,
                    presentArtifacts: options.corePresentArtifacts
                };
            }
        }
        const syncResult = latchEvidence.valid && hasChildren
            ? transitionSplitRequiredParentAfterWipSuspension({
                repoRoot: options.repoRoot,
                reviewsRoot: options.reviewsRoot,
                eventsRoot: options.eventsRoot,
                taskId: options.taskId,
                latchEvidence
            })
            : null;
        const splitRoute = resolveSplitRequiredTaskQueueRoute({
            taskId: options.taskId,
            latchValid: latchEvidence.valid,
            latchInvalidReason: latchEvidence.reason,
            hasChildren,
            transitionResult: syncResult
                ? {
                    outcome: syncResult.outcome,
                    errorMessage: syncResult.error_message
                }
                : null,
            childRoute,
            continueChildCommand: buildContinueChildCommand(options.cliPrefix, childRoute)
        });
        return {
            status: splitRoute.status,
            nextGate: splitRoute.nextGate,
            title: splitRoute.title,
            reason: splitRoute.reason,
            commands: splitRoute.commands,
            missingArtifacts: [],
            presentArtifacts: options.corePresentArtifacts,
            finalReport: null
        };
    }

    if (
        isTaskQueueDoneStatus(taskQueueStatus)
        && options.completionGatePassed
        && options.latestCompletionCurrent
    ) {
        return null;
    }

    if (isTaskQueueDoneStatus(taskQueueStatus)) {
        const doneConflictBlockers = [...options.summaryBlockers];
        if (!options.completionGatePassed) {
            doneConflictBlockers.unshift('completion-gate: missing or not passed');
        } else if (!options.latestCompletionCurrent) {
            doneConflictBlockers.unshift('completion-gate: pass exists but is stale for the current task cycle');
        }
        if (!options.finalReportContractReady) {
            doneConflictBlockers.push(
                `final-closeout: ${options.finalReportContractBlocker || 'canonical final closeout is not ready'}`
            );
        }
        const doneRoute = resolveDoneTaskQueueTerminalRoute({
            taskId: options.taskId,
            conflictBlockers: doneConflictBlockers,
            allowAuthorizedTerminalEvidence: doneStatusHasAuthorizedTerminalEvidence,
            reopenPreviewCommand: buildCommand(
                'Preview explicit operator reopen',
                `${options.cliPrefix} gate task-reset --task-id "${options.taskId}" --reopen --dry-run --repo-root "."`
            )
        });
        return {
            status: doneRoute.status,
            nextGate: doneRoute.nextGate,
            title: doneRoute.title,
            reason: doneRoute.reason,
            commands: doneRoute.commands,
            missingArtifacts: doneRoute.status === 'DONE' ? [] : options.filteredMissingArtifacts,
            presentArtifacts: options.corePresentArtifacts,
            finalReport: null
        };
    }

    if (!options.completionGatePassed && isDecomposedParentTask(options.taskEntry)) {
        const strictDecompositionWip = suspendStrictDecompositionWipIfRequired({
            repoRoot: options.repoRoot,
            taskId: options.taskId
        });
        if (strictDecompositionWip.status === 'BLOCKED') {
            return {
                status: 'BLOCKED',
                nextGate: 'strict-decomposition-wip-capture',
                title: 'Suspend legacy strict-decomposition parent WIP before child execution.',
                reason:
                    'TASK.md already marks this strict split parent as decomposed, but its implemented parent scope is still present in the worktree and could not be captured safely. ' +
                    `Capture violations: ${strictDecompositionWip.violations.map(formatNextStepInlineValue).join(', ') || 'unknown'}. ` +
                    'Do not enter a child task until the parent WIP is suspended; repair the reported scope or repository condition and rerun next-step.',
                commands: [],
                missingArtifacts: strictDecompositionWip.manifest_path
                    ? []
                    : [{ key: 'strict-decomposition-wip', path: '<not-created>', exists: false }],
                presentArtifacts: options.corePresentArtifacts,
                finalReport: null
            };
        }
        const completionState = isTaskQueueDecomposedStatus(taskQueueStatus)
            ? resolveDecomposedParentCompletionState(
                options.taskEntries,
                options.taskId,
                new Set<string>(),
                extractExplicitLinkedChildTaskIds
            )
            : null;
        const childRoute = completionState?.unfinishedRoute || resolveNextUnfinishedChildRoute(
            options.taskEntries,
            options.taskId,
            new Set<string>(),
            extractExplicitLinkedChildTaskIds
        );
        const decomposedReason = isTaskQueueDecomposedStatus(taskQueueStatus)
            ? 'Task queue marks this parent as DECOMPOSED.'
            : 'Task queue marks this parent as a legacy BLOCKED split umbrella.';
        const decomposedProvenanceReason = describeDecomposedTaskProvenance(options.taskEntry?.notes || null);
        const tasksToComplete = completionState?.hasLinkedChildren && completionState.complete
            ? [...new Set([...completionState.completedDecomposedTaskIds, options.taskId])]
            : [];
        if (completionState?.hasLinkedChildren && completionState.complete) {
            const repairRestoreRoute = resolveCompletedFullSuiteRepairWipRestoreRoute({
                repoRoot: options.repoRoot,
                reviewsRoot: options.reviewsRoot,
                taskId: options.taskId,
                cliPrefix: options.cliPrefix,
                taskEntries: options.taskEntries,
                taskEntry: options.taskEntry,
                fullSuiteArtifactPath: options.fullSuiteArtifactPath
            });
            if (repairRestoreRoute) {
                return {
                    ...repairRestoreRoute,
                    presentArtifacts: options.corePresentArtifacts
                };
            }
        }
        const syncResult = tasksToComplete.length > 0
            ? transitionDecomposedParentsToDone({
                repoRoot: options.repoRoot,
                eventsRoot: options.eventsRoot,
                rootTaskId: options.taskId,
                taskIds: tasksToComplete
            })
            : null;
        const decomposedRoute = resolveDecomposedParentTerminalRoute({
            taskId: options.taskId,
            decomposedReason: `${decomposedReason} ${decomposedProvenanceReason}`,
            childRoute,
            continueChildCommand: buildContinueChildCommand(options.cliPrefix, childRoute),
            hasLinkedChildren: completionState?.hasLinkedChildren || false,
            missingChildTaskIds: completionState?.missingChildTaskIds || [],
            complete: completionState?.complete || false,
            statusSyncResult: syncResult
                ? {
                    outcome: syncResult.outcome,
                    errorMessage: syncResult.error_message,
                    taskIds: syncResult.task_ids
                }
                : null
        });
        return {
            status: decomposedRoute.status,
            nextGate: decomposedRoute.nextGate,
            title: decomposedRoute.title,
            reason: decomposedRoute.reason,
            commands: decomposedRoute.commands,
            missingArtifacts: [],
            presentArtifacts: options.corePresentArtifacts,
            finalReport: null
        };
    }

    return null;
}
