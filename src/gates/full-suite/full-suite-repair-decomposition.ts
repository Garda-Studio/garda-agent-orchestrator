import * as fs from 'node:fs';
import * as path from 'node:path';

import { isPlainRecord } from '../../core/records';
import { readTaskQueueStatusToken } from '../../core/active-task-state';
import {
    extractExplicitLinkedChildTaskIds,
    readTaskQueueEntries,
    resolveSplitRequiredDecompositionState,
    type TaskQueueEntry
} from '../next-step/next-step-task-queue';
import { joinOrchestratorPath } from '../shared/helpers';
import { readImmutableOrderedTaskEvents } from '../task-audit/task-audit-summary-lifecycle';
import { readImmutableRegularFileSnapshot } from './full-suite-repair-capture';
import {
    hasRepairChildScopeDeclaration,
    readRepairChildScopeFromNotes,
    validateIndependentRepairChildScopes
} from './full-suite-repair-child-scope';
import type {
    RepairChildScopeEvidence
} from './full-suite-repair-contracts';
import { resolveInputPathInsideRepo } from './full-suite-repair-manifest';

export interface FullSuiteRepairDecompositionState {
    ready: boolean;
    child_task_ids: string[];
    child_scopes: RepairChildScopeEvidence[];
    violations: string[];
}

export interface FullSuiteRepairChildHandoffState {
    parent_task_id: string;
    full_suite_artifact_path: string;
    decomposition: FullSuiteRepairDecompositionState;
}

export function resolveFullSuiteRepairDecompositionState(
    repoRoot: string,
    parentTaskId: string,
    options: { allowCompletedChildren?: boolean; requireChildScopes?: boolean } = {}
): FullSuiteRepairDecompositionState {
    const taskEntries = readTaskQueueEntries(repoRoot);
    const parentEntry = taskEntries.get(parentTaskId);
    if (!parentEntry) {
        return {
            ready: false,
            child_task_ids: [],
            child_scopes: [],
            violations: [`repair parent ${parentTaskId} is missing from TASK.md.`]
        };
    }

    const state = resolveSplitRequiredDecompositionState(taskEntries, parentTaskId);
    const violations: string[] = [];
    if (state.linkedChildTaskIds.length < 2) {
        violations.push(
            'full-suite repair decomposition requires at least two meaningful linked child tasks; '
            + 'a singular repair_task_proposal.suggested_task_id is diagnostic guidance, not split provenance.'
        );
    }
    if (state.missingChildTaskIds.length > 0) {
        violations.push(`linked repair child rows are missing from TASK.md: ${state.missingChildTaskIds.join(', ')}.`);
    }
    if (!options.allowCompletedChildren && state.terminalChildTaskIds.length > 0) {
        violations.push(`terminal child tasks cannot establish a new repair split: ${state.terminalChildTaskIds.join(', ')}.`);
    }
    if (state.placeholderChildTaskIds.length > 0) {
        violations.push(`placeholder child tasks are not repair work packages: ${state.placeholderChildTaskIds.join(', ')}.`);
    }
    if (state.duplicateScopeChildTaskIds.length > 0) {
        violations.push(`duplicate repair child scopes are not independent: ${state.duplicateScopeChildTaskIds.join(', ')}.`);
    }
    const disallowedNonExecutableChildTaskIds = options.allowCompletedChildren
        ? state.nonExecutableChildTaskIds.filter((childTaskId) => (
            readTaskQueueStatusToken(taskEntries.get(childTaskId)?.status || null) !== 'DONE'
        ))
        : state.nonExecutableChildTaskIds;
    if (disallowedNonExecutableChildTaskIds.length > 0) {
        violations.push(`repair child tasks are not executable: ${disallowedNonExecutableChildTaskIds.join(', ')}.`);
    }
    const childScopes: RepairChildScopeEvidence[] = [];
    for (const childTaskId of state.linkedChildTaskIds) {
        const childEntry = taskEntries.get(childTaskId);
        if (!childEntry) {
            continue;
        }
        if (
            !options.requireChildScopes
            && !hasRepairChildScopeDeclaration(childEntry.notes || null)
        ) {
            continue;
        }
        const parsedScope = readRepairChildScopeFromNotes(
            repoRoot,
            childTaskId,
            childEntry.notes || null
        );
        violations.push(...parsedScope.violations);
        if (parsedScope.scope) {
            childScopes.push(parsedScope.scope);
        }
    }
    if (childScopes.length === state.linkedChildTaskIds.length) {
        violations.push(...validateIndependentRepairChildScopes(childScopes));
    } else if (options.requireChildScopes) {
        violations.push('every repair child must declare an independently bounded Repair scope paths list.');
    }

    return {
        ready: violations.length === 0,
        child_task_ids: state.linkedChildTaskIds,
        child_scopes: childScopes,
        violations
    };
}

export function sameRepairChildTaskIds(left: readonly string[], right: readonly string[]): boolean {
    return left.length === right.length
        && left.every((taskId, index) => taskId === right[index]);
}

function isRepairQualifiedTimeoutPolicy(timeoutPolicy: Record<string, unknown> | null): boolean {
    return timeoutPolicy?.timeout_blocker === true
        && timeoutPolicy.attempts_exhausted === true
        && isPlainRecord(timeoutPolicy.repair_task_proposal);
}

export function isRepairQualifiedFullSuiteArtifact(
    artifact: unknown,
    parentTaskId: string
): boolean {
    if (!isPlainRecord(artifact) || artifact.timed_out !== true) {
        return false;
    }
    const cycleBinding = isPlainRecord(artifact.cycle_binding)
        ? artifact.cycle_binding
        : null;
    const hasTopLevelTaskId = Object.prototype.hasOwnProperty.call(artifact, 'task_id');
    const hasCycleBindingTaskId = Boolean(
        cycleBinding
        && Object.prototype.hasOwnProperty.call(cycleBinding, 'task_id')
    );
    if (
        (hasTopLevelTaskId && artifact.task_id !== parentTaskId)
        || (hasCycleBindingTaskId && cycleBinding?.task_id !== parentTaskId)
        || (!hasTopLevelTaskId && !hasCycleBindingTaskId)
    ) {
        return false;
    }
    const timeoutPolicy = isPlainRecord(artifact.timeout_policy)
        ? artifact.timeout_policy
        : null;
    return isRepairQualifiedTimeoutPolicy(timeoutPolicy);
}

function latestFullSuiteLifecycleRequiresRepair(eventsRoot: string, parentTaskId: string): boolean {
    const taskEventPath = path.join(eventsRoot, `${parentTaskId}.jsonl`);
    const fullSuiteEventTypes = new Set([
        'FULL_SUITE_VALIDATION_PASSED',
        'FULL_SUITE_VALIDATION_FAILED',
        'FULL_SUITE_VALIDATION_WARNED',
        'FULL_SUITE_VALIDATION_SKIPPED'
    ]);
    const events = readImmutableOrderedTaskEvents(taskEventPath).events;
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (!fullSuiteEventTypes.has(String(event.event_type || '').trim())) {
            continue;
        }
        const details = isPlainRecord(event.details) ? event.details : null;
        const timeoutPolicy = details && isPlainRecord(details.timeout_policy)
            ? details.timeout_policy
            : null;
        return details?.timed_out === true && isRepairQualifiedTimeoutPolicy(timeoutPolicy);
    }
    return false;
}

export function findFullSuiteRepairChildHandoffState(
    repoRoot: string,
    childTaskId: string,
    reviewsRoot = joinOrchestratorPath(repoRoot, path.join('runtime', 'reviews')),
    eventsRoot = joinOrchestratorPath(repoRoot, path.join('runtime', 'task-events')),
    taskQueueEntries?: ReadonlyMap<string, TaskQueueEntry>
): FullSuiteRepairChildHandoffState | null {
    const taskEntries = taskQueueEntries ?? readTaskQueueEntries(repoRoot);
    const resolvedReviewsRoot = resolveInputPathInsideRepo(repoRoot, reviewsRoot, 'ReviewsRoot');
    const resolvedEventsRoot = resolveInputPathInsideRepo(repoRoot, eventsRoot, 'EventsRoot');
    for (const [parentTaskId, parentEntry] of taskEntries) {
        if (parentTaskId === childTaskId) {
            continue;
        }
        const linkedChildTaskIds = extractExplicitLinkedChildTaskIds(
            parentEntry.notes || null,
            taskEntries.keys(),
            parentTaskId
        );
        if (!linkedChildTaskIds.includes(childTaskId)) {
            continue;
        }
        const fullSuiteArtifactPath = path.join(
            resolvedReviewsRoot,
            `${parentTaskId}-full-suite-validation.json`
        );
        try {
            fs.lstatSync(fullSuiteArtifactPath);
        } catch (error: unknown) {
            const code = error != null && typeof error === 'object' && 'code' in error
                ? String((error as { code?: unknown }).code || '')
                : '';
            if (code === 'ENOENT') {
                if (latestFullSuiteLifecycleRequiresRepair(resolvedEventsRoot, parentTaskId)) {
                    return {
                        parent_task_id: parentTaskId,
                        full_suite_artifact_path: fullSuiteArtifactPath,
                        decomposition: {
                            ready: false,
                            child_task_ids: linkedChildTaskIds,
                            child_scopes: [],
                            violations: [
                                `full-suite artifact for repair parent ${parentTaskId} is missing despite `
                                + 'durable timeout repair lifecycle evidence.'
                            ]
                        }
                    };
                }
                continue;
            }
            const message = error instanceof Error ? error.message : String(error);
            return {
                parent_task_id: parentTaskId,
                full_suite_artifact_path: fullSuiteArtifactPath,
                decomposition: {
                    ready: false,
                    child_task_ids: linkedChildTaskIds,
                    child_scopes: [],
                    violations: [
                        `full-suite artifact for repair parent ${parentTaskId} cannot be inspected: ${message}`
                    ]
                }
            };
        }
        let fullSuiteArtifact: unknown;
        try {
            const fullSuiteArtifactSnapshot = readImmutableRegularFileSnapshot({
                repoRoot,
                filePath: fullSuiteArtifactPath,
                label: `Full-suite artifact for repair parent ${parentTaskId}`
            });
            fullSuiteArtifact = JSON.parse(fullSuiteArtifactSnapshot.content.toString('utf8')) as unknown;
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            return {
                parent_task_id: parentTaskId,
                full_suite_artifact_path: fullSuiteArtifactPath,
                decomposition: {
                    ready: false,
                    child_task_ids: linkedChildTaskIds,
                    child_scopes: [],
                    violations: [
                        `full-suite artifact for repair parent ${parentTaskId} is not trusted: ${message}`
                    ]
                }
            };
        }
        const currentArtifactRequiresRepair = isRepairQualifiedFullSuiteArtifact(
            fullSuiteArtifact,
            parentTaskId
        );
        if (latestFullSuiteLifecycleRequiresRepair(resolvedEventsRoot, parentTaskId) && !currentArtifactRequiresRepair) {
            return {
                parent_task_id: parentTaskId,
                full_suite_artifact_path: fullSuiteArtifactPath,
                decomposition: {
                    ready: false,
                    child_task_ids: linkedChildTaskIds,
                    child_scopes: [],
                    violations: [
                        `full-suite artifact for repair parent ${parentTaskId} no longer matches `
                        + 'durable timeout repair lifecycle evidence.'
                    ]
                }
            };
        }
        if (!currentArtifactRequiresRepair) {
            continue;
        }
        return {
            parent_task_id: parentTaskId,
            full_suite_artifact_path: fullSuiteArtifactPath,
            decomposition: resolveFullSuiteRepairDecompositionState(
                repoRoot,
                parentTaskId,
                { allowCompletedChildren: true }
            )
        };
    }
    return null;
}
