export interface TerminalRoutingCommand {
    label: string;
    command: string;
}

export interface TerminalStatusRoute {
    status: 'BLOCKED' | 'DONE' | 'DECOMPOSED' | 'SPLIT_REQUIRED';
    nextGate: string | null;
    title: string;
    reason: string;
    commands: TerminalRoutingCommand[];
}

export interface TerminalChildRoute {
    taskId: string;
    status: string | null;
    chain: readonly string[];
}

export interface TerminalStatusSyncSummary {
    outcome: string;
    errorMessage?: string | null;
    taskIds?: readonly string[];
}

function formatInlineValue(value: string): string {
    return JSON.stringify(value);
}

function describeStatusSync(summary: TerminalStatusSyncSummary): string {
    return `${formatInlineValue(summary.outcome)}${summary.errorMessage ? ` (${summary.errorMessage})` : ''}`;
}

function splitRequiredWipGuidance(taskId: string): string {
    return `Captured WIP, when present, is task-owned ignored evidence; inspect it with ${formatInlineValue(`node bin/garda.js gate list-split-required-wip --task-id "${taskId}" --repo-root "."`)} and restore only by explicit preview/apply commands in child scope.`;
}

function decomposedChildFullSuiteScopeCheckpoint(): string {
    return 'Before entering the selected child task, inspect workflow-config.full_suite_validation.command against that child scope. ' +
        'If it still includes suspended sibling tests, use the existing workflow set --full-suite-command route with required operator confirmation before enter-task-mode; ' +
        'keep current-child tests covered, exclude suspended siblings, leave an already-suitable command unchanged, and never retarget during an active child cycle.';
}

function formatChildChain(taskId: string, childRoute: TerminalChildRoute): string {
    return [taskId, ...childRoute.chain].join(' -> ');
}

export function isSuccessfulTerminalStatusSync(summary: TerminalStatusSyncSummary): boolean {
    return summary.outcome === 'updated' || summary.outcome === 'already_synced';
}

export function resolvePermanentSplitRequiredLatchRoute(options: {
    taskId: string;
    restoreResult: TerminalStatusSyncSummary;
    hasChildren: boolean;
    transitionResult: TerminalStatusSyncSummary | null;
    childRoute: TerminalChildRoute | null;
    continueChildCommand: TerminalRoutingCommand | null;
}): TerminalStatusRoute {
    if (!isSuccessfulTerminalStatusSync(options.restoreResult)) {
        return {
            status: 'SPLIT_REQUIRED',
            nextGate: 'split-required-latch',
            title: 'Split-required latch is active.',
            reason:
                `A valid split-required latch already exists for ${formatInlineValue(options.taskId)}, ` +
                'but the gate could not restore TASK.md to SPLIT_REQUIRED after detecting later status/config/scope drift. ' +
                `Status sync outcome: ${describeStatusSync(options.restoreResult)}. ` +
                'Do not run classify, compile, review, full-suite, completion, or final closeout gates on the parent. ' +
                splitRequiredWipGuidance(options.taskId),
            commands: []
        };
    }

    if (options.hasChildren) {
        if (options.transitionResult && !isSuccessfulTerminalStatusSync(options.transitionResult)) {
            return {
                status: 'SPLIT_REQUIRED',
                nextGate: 'split-required-latch',
                title: 'Split-required latch is active.',
                reason:
                    'A valid split-required latch is permanent for this task attempt, but the gate could not transition the parent to DECOMPOSED after detecting linked child tasks. ' +
                    `Status sync outcome: ${describeStatusSync(options.transitionResult)}. ` +
                    'Do not run classify, compile, review, full-suite, completion, or final closeout gates on the parent. ' +
                    splitRequiredWipGuidance(options.taskId),
                commands: []
            };
        }
        if (options.childRoute && options.continueChildCommand) {
            const chain = formatChildChain(options.taskId, options.childRoute);
            return {
                status: 'DECOMPOSED',
                nextGate: 'child-task',
                title: 'Split-required latch cleared; continue with the next child.',
                reason:
                    'A valid split-required latch stayed permanent after later status/config/scope drift. Linked child tasks were detected, so the gate restored the parent latch and transitioned the parent to DECOMPOSED. ' +
                    `Parent tasks in this state are not executable lifecycle scopes. Continue through child chain ${chain}; ` +
                    `next unfinished child status is ${formatInlineValue(options.childRoute.status || 'unknown')}. ` +
                    `${decomposedChildFullSuiteScopeCheckpoint()} ` +
                    splitRequiredWipGuidance(options.taskId),
                commands: [options.continueChildCommand]
            };
        }
        return {
            status: 'DECOMPOSED',
            nextGate: null,
            title: 'Split-required latch cleared; no unfinished child remains.',
            reason:
                'A valid split-required latch stayed permanent after later status/config/scope drift. Linked child tasks were detected, so the gate restored the parent latch and transitioned the parent to DECOMPOSED. ' +
                'No unfinished child task could be resolved from its notes. Do not run classify, compile, review, full-suite, completion, or final closeout gates on the parent. ' +
                splitRequiredWipGuidance(options.taskId),
            commands: []
        };
    }

    return {
        status: 'SPLIT_REQUIRED',
        nextGate: 'split-required-latch',
        title: 'Split-required latch is active.',
        reason:
            `A valid split-required latch already exists for ${formatInlineValue(options.taskId)}. ` +
            'The latch is permanent for this task attempt, so later status/config/scope changes cannot make the parent executable again. ' +
            'Create and link at least two meaningful, independently scoped, non-terminal child tasks so the gate can transition the parent to DECOMPOSED. ' +
            'If the work is genuinely unsplittable, use an explicit operator remediation or terminal decision; task-reset/discard remains the only way to clear the latch. ' +
            splitRequiredWipGuidance(options.taskId),
        commands: []
    };
}

export function resolveSplitRequiredTaskQueueRoute(options: {
    taskId: string;
    latchValid: boolean;
    latchInvalidReason: string;
    hasChildren: boolean;
    transitionResult: TerminalStatusSyncSummary | null;
    childRoute: TerminalChildRoute | null;
    continueChildCommand: TerminalRoutingCommand | null;
}): TerminalStatusRoute {
    if (!options.latchValid) {
        return {
            status: 'BLOCKED',
            nextGate: 'split-required-latch',
            title: 'Split-required latch evidence is invalid.',
            reason:
                `TASK.md marks ${formatInlineValue(options.taskId)} as SPLIT_REQUIRED, but gate-owned latch evidence is invalid: ${options.latchInvalidReason}. ` +
                'Do not clear the latch, route child tasks, or run parent classify, compile, review, full-suite, completion, or final closeout gates until an operator repairs or resets the task. ' +
                splitRequiredWipGuidance(options.taskId),
            commands: []
        };
    }

    if (options.hasChildren) {
        if (options.transitionResult && !isSuccessfulTerminalStatusSync(options.transitionResult)) {
            return {
                status: 'SPLIT_REQUIRED',
                nextGate: 'split-required-latch',
                title: 'Split-required latch is active.',
                reason:
                    `TASK.md marks ${formatInlineValue(options.taskId)} as SPLIT_REQUIRED, but the gate could not transition the parent to DECOMPOSED after detecting linked child tasks. ` +
                    `Status sync outcome: ${describeStatusSync(options.transitionResult)}. ` +
                    'Do not run classify, compile, review, full-suite, completion, or final closeout gates on the parent. ' +
                    splitRequiredWipGuidance(options.taskId),
                commands: []
            };
        }
        if (options.childRoute && options.continueChildCommand) {
            const chain = formatChildChain(options.taskId, options.childRoute);
            return {
                status: 'DECOMPOSED',
                nextGate: 'child-task',
                title: 'Split-required latch cleared; continue with the next child.',
                reason:
                    'Linked child tasks were detected, so the gate transitioned the parent from SPLIT_REQUIRED to DECOMPOSED. ' +
                    `Parent tasks in this state are not executable lifecycle scopes. Continue through child chain ${chain}; ` +
                    `next unfinished child status is ${formatInlineValue(options.childRoute.status || 'unknown')}. ` +
                    `${decomposedChildFullSuiteScopeCheckpoint()} ` +
                    splitRequiredWipGuidance(options.taskId),
                commands: [options.continueChildCommand]
            };
        }
        return {
            status: 'DECOMPOSED',
            nextGate: null,
            title: 'Split-required latch cleared; no unfinished child remains.',
            reason:
                'Linked child tasks were detected, so the gate transitioned the parent from SPLIT_REQUIRED to DECOMPOSED. ' +
                'No unfinished child task could be resolved from its notes. Do not run classify, compile, review, full-suite, completion, or final closeout gates on the parent. ' +
                splitRequiredWipGuidance(options.taskId),
            commands: []
        };
    }

    return {
        status: 'SPLIT_REQUIRED',
        nextGate: 'split-required-latch',
        title: 'Split-required latch is active.',
        reason:
            `TASK.md marks ${formatInlineValue(options.taskId)} as SPLIT_REQUIRED. ` +
            'This parent task was blocked by an auto-split guard and cannot continue through classify, compile, review, full-suite, completion, or final closeout gates. ' +
            'Create and link at least two meaningful, independently scoped, non-terminal child tasks so the gate can transition the parent to DECOMPOSED. ' +
            'If the work is genuinely unsplittable, use an explicit operator remediation or terminal decision; task-reset/discard remains the only way to clear the latch. ' +
            splitRequiredWipGuidance(options.taskId),
        commands: []
    };
}

export function resolveDoneTaskQueueTerminalRoute(options: {
    taskId: string;
    conflictBlockers: readonly string[];
    allowAuthorizedTerminalEvidence: boolean;
    reopenPreviewCommand: TerminalRoutingCommand;
}): TerminalStatusRoute {
    if (options.conflictBlockers.length > 0 && !options.allowAuthorizedTerminalEvidence) {
        const blockerSummary = options.conflictBlockers.slice(0, 4).join('; ');
        const extraBlockerCount = options.conflictBlockers.length > 4
            ? ` (+${options.conflictBlockers.length - 4} more blocker(s))`
            : '';
        return {
            status: 'BLOCKED',
            nextGate: 'task-reset',
            title: 'TASK.md DONE conflicts with lifecycle evidence.',
            reason:
                `TASK.md marks ${formatInlineValue(options.taskId)} as DONE, but current lifecycle evidence is not terminal-clean: ` +
                `${blockerSummary}${extraBlockerCount}. ` +
                'Completion-gate remains the only normal owner of DONE. Do not hand-edit TASK.md or run stale lifecycle gates while this false-DONE conflict exists; use explicit operator task-reset/reopen recovery first.',
            commands: [options.reopenPreviewCommand]
        };
    }

    return {
        status: 'DONE',
        nextGate: null,
        title: 'Task is already marked DONE in TASK.md.',
        reason:
            `TASK.md marks ${formatInlineValue(options.taskId)} as DONE. ` +
            'Treat this task as terminal and do not run stale lifecycle recovery, classify, compile, review, full-suite, or completion gates. ' +
            'Use an explicit operator task-reset/reopen command before starting a new lifecycle cycle for this task; do not hand-edit active TASK.md lifecycle statuses.',
        commands: []
    };
}

export function resolveDecomposedParentTerminalRoute(options: {
    taskId: string;
    decomposedReason: string;
    childRoute: TerminalChildRoute | null;
    continueChildCommand: TerminalRoutingCommand | null;
    hasLinkedChildren: boolean;
    missingChildTaskIds: readonly string[];
    complete: boolean;
    auditCommand: TerminalRoutingCommand;
    statusSyncResult: TerminalStatusSyncSummary | null;
}): TerminalStatusRoute {
    if (options.childRoute && options.continueChildCommand) {
        const chain = formatChildChain(options.taskId, options.childRoute);
        return {
            status: 'DECOMPOSED',
            nextGate: 'child-task',
            title: 'Parent task is decomposed; continue with the next child.',
            reason:
                `${options.decomposedReason} Parent tasks in this state are not executable lifecycle scopes. ` +
                `Continue through child chain ${chain}; next unfinished child status is ${formatInlineValue(options.childRoute.status || 'unknown')}. ` +
                decomposedChildFullSuiteScopeCheckpoint(),
            commands: [options.continueChildCommand]
        };
    }

    if (options.hasLinkedChildren && options.missingChildTaskIds.length > 0) {
        return {
            status: 'DECOMPOSED',
            nextGate: null,
            title: 'Parent task is decomposed but explicit child links are missing.',
            reason:
                `${options.decomposedReason} Explicit child task link(s) could not be found in TASK.md: ` +
                `${options.missingChildTaskIds.map(formatInlineValue).join(', ')}. ` +
                'Do not mark the parent DONE or run stale parent gates until every explicit child task exists and reaches DONE, or the parent notes are corrected by an operator.',
            commands: []
        };
    }

    if (options.hasLinkedChildren && options.complete) {
        if (options.statusSyncResult && !isSuccessfulTerminalStatusSync(options.statusSyncResult)) {
            return {
                status: 'DECOMPOSED',
                nextGate: 'task-status-sync',
                title: 'Decomposed parent completion status sync failed.',
                reason:
                    `Every explicit child task under ${formatInlineValue(options.taskId)} appeared DONE, but the gate could not atomically transition ` +
                    `the completed decomposed parent task set from DECOMPOSED to DONE after write-time revalidation. ` +
                    `Status sync outcome: ${describeStatusSync(options.statusSyncResult)}. ` +
                    'Do not hand-edit TASK.md status cells; repair the task queue or rerun next-step after resolving the sync failure.',
                commands: []
            };
        }
        const completedChain = (options.statusSyncResult?.taskIds || []).join(', ');
        return {
            status: 'DECOMPOSED',
            nextGate: 'task-audit-summary',
            title: 'Child tasks are complete; verify original parent acceptance.',
            reason:
                `${options.decomposedReason} Every explicit child task, including nested decomposed children, is DONE. ` +
                `The gate-owned status sync transitioned completed parent task(s) to DONE: ${completedChain}. ` +
                'This queue transition does not establish original parent acceptance. Run the native aggregate audit to verify child source provenance, original command composition, preserved WIP and memory obligations. ' +
                'Do not run stale parent classify, compile, review, full-suite, or completion gates.',
            commands: [options.auditCommand]
        };
    }

    return {
        status: 'DECOMPOSED',
        nextGate: null,
        title: 'Parent task is decomposed and has no unfinished child.',
        reason:
            `${options.decomposedReason} No unfinished child task could be resolved from its notes. ` +
            'Do not execute the parent directly or run classify, compile, review, full-suite, or completion gates on it. ' +
            'Add or reopen a child task when the parent objective is not complete, and record an explicit child task list or child range in Notes; do not infer candidates from unrelated task IDs.',
        commands: []
    };
}

export function resolveStrictDecompositionSplitTerminalRoute(options: {
    taskId: string;
    childProfile?: string;
    transitionResult: TerminalStatusSyncSummary;
    childRoute: TerminalChildRoute | null;
    continueChildCommand: TerminalRoutingCommand | null;
}): TerminalStatusRoute {
    if (!isSuccessfulTerminalStatusSync(options.transitionResult)) {
        return {
            status: 'BLOCKED',
            nextGate: 'strict-decomposition-split-routing',
            title: 'Strict decomposition child routing status sync failed.',
            reason:
                `A current strict decomposition decision says split-required and linked ${options.childProfile || 'strict'} child tasks were detected, but the gate could not transition the parent to DECOMPOSED. ` +
                `Status sync outcome: ${describeStatusSync(options.transitionResult)}. ` +
                'Do not run parent classify, compile, review, full-suite, completion, or final closeout gates until status sync succeeds.',
            commands: []
        };
    }

    if (options.childRoute && options.continueChildCommand) {
        const chain = formatChildChain(options.taskId, options.childRoute);
        return {
            status: 'DECOMPOSED',
            nextGate: 'child-task',
            title: 'Strict decomposition split routed; continue with the next child.',
            reason:
                `A current strict decomposition decision says split-required, and linked parent-derived ${options.childProfile || 'strict'} child tasks match the decision artifact. ` +
                'The gate transitioned the parent to DECOMPOSED, so it is no longer an executable lifecycle scope. ' +
                `Continue through child chain ${chain}; next unfinished child status is ${formatInlineValue(options.childRoute.status || 'unknown')}. ` +
                decomposedChildFullSuiteScopeCheckpoint(),
            commands: [options.continueChildCommand]
        };
    }

    return {
        status: 'DECOMPOSED',
        nextGate: null,
        title: 'Strict decomposition split routed; no unfinished child remains.',
        reason:
            `A current strict decomposition decision says split-required, and linked parent-derived ${options.childProfile || 'strict'} child tasks match the decision artifact. ` +
            'The gate transitioned the parent to DECOMPOSED, but no unfinished child task could be resolved from its notes. ' +
            'Do not run classify, compile, review, full-suite, completion, or final closeout gates on the parent.',
        commands: []
    };
}
