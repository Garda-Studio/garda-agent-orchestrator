import * as path from 'node:path';
import { selectRulePackFiles } from '../../../../gates/review-context/review-context-token-economy';
import { selectTaskEntryRulePackFileNames } from '../../../../gates/rule-pack/rule-pack-selection';
import { getPreflightContext } from '../../../../gates/compile/compile-gate';
import { collectOrderedTimelineEvents, findLatestTimelineEvent } from '../../../../gates/completion/completion-evidence';
import { getLatestPrePreflightCycleAnchor, isTaskEntryRulePackLoadedEvent } from '../../../../gates/preflight/pre-preflight-cycle-anchor';
import { getTaskModeEvidence } from '../../../../gates/task-mode/task-mode';
import * as gateHelpers from '../../../../gates/shared/helpers';
import { expandValueList, parseBooleanOption } from '../../../gate-cli/gates-parser';
import { normalizeChangedFiles } from './recovery-flow-shared';
import type {
    ResolvedReplayScope,
    RestartCoherentCycleCommandOptions,
    RestartReviewCycleCommandOptions
} from './recovery-flow-types';

export function getTaskEntryRuleFilesForDepth(effectiveDepth: number | null | undefined): string[] {
    return selectTaskEntryRulePackFileNames({ effectiveDepth });
}

const REVIEW_CYCLE_BOUNDARY_EVENTS = new Set([
    'REVIEW_GATE_PASSED',
    'REVIEW_GATE_PASSED_WITH_OVERRIDE',
    'COMPLETION_GATE_PASSED'
]);

const REVIEW_CYCLE_PREFLIGHT_REFRESH_BOUNDARY_EVENTS = new Set([
    'REVIEW_PHASE_STARTED',
    'COMPLETION_GATE_FAILED'
]);

function toPlainRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

function getTaskOwnedReplayChangedFiles(previousPreflight: ReturnType<typeof getPreflightContext>): string[] {
    const changedFiles = normalizeChangedFiles(previousPreflight.changed_files as unknown[]);
    const triggers = toPlainRecord((previousPreflight as unknown as Record<string, unknown>).triggers);
    if (!triggers) {
        return changedFiles;
    }
    const taskOwnedFiles = normalizeChangedFiles(
        Array.isArray(triggers.dirty_workspace_task_owned_files)
            ? triggers.dirty_workspace_task_owned_files
            : []
    );
    const untouchedBaselineFiles = normalizeChangedFiles(
        Array.isArray(triggers.dirty_workspace_untouched_baseline_files)
            ? triggers.dirty_workspace_untouched_baseline_files
            : []
    );
    if (taskOwnedFiles.length === 0 && untouchedBaselineFiles.length === 0) {
        return changedFiles;
    }
    const untouchedSet = new Set(untouchedBaselineFiles);
    return [...new Set([
        ...changedFiles.filter((relativePath) => !untouchedSet.has(relativePath)),
        ...taskOwnedFiles
    ])].sort();
}

export function normalizeRuleFileList(requiredReviews: Record<string, boolean>, effectiveDepth: number): string[] {
    const fileNames = new Set<string>(getTaskEntryRuleFilesForDepth(effectiveDepth));
    for (const [reviewType, required] of Object.entries(requiredReviews)) {
        if (!required) {
            continue;
        }
        for (const fileName of selectRulePackFiles(reviewType, effectiveDepth)) {
            fileNames.add(fileName);
        }
    }
    return [...fileNames].sort();
}

export function resolveReplayScope(
    options: RestartCoherentCycleCommandOptions,
    previousPreflight: ReturnType<typeof getPreflightContext>
): ResolvedReplayScope {
    const explicitChangedFilesProvided = options.changedFiles !== undefined;
    const explicitChangedFiles = normalizeChangedFiles(expandValueList(options.changedFiles || [], { splitDelimiters: true }));
    const previousChangedFiles = getTaskOwnedReplayChangedFiles(previousPreflight);

    if (explicitChangedFilesProvided) {
        return {
            plannedChangedFiles: explicitChangedFiles,
            changedFiles: explicitChangedFiles,
            detectionSource: 'explicit_changed_files'
        };
    }

    if (options.useStaged === true) {
        const includeUntracked = parseBooleanOption(options.includeUntracked, previousPreflight.include_untracked);
        return {
            plannedChangedFiles: previousChangedFiles,
            useStaged: true,
            includeUntracked,
            detectionSource: includeUntracked ? 'git_staged_plus_untracked' : 'git_staged_only'
        };
    }

    switch (previousPreflight.detection_source) {
        case 'explicit_changed_files':
            return {
                plannedChangedFiles: previousChangedFiles,
                changedFiles: previousChangedFiles,
                detectionSource: 'explicit_changed_files'
            };
        case 'git_staged_only':
            return {
                plannedChangedFiles: previousChangedFiles,
                useStaged: true,
                includeUntracked: false,
                detectionSource: 'git_staged_only'
            };
        case 'git_staged_plus_untracked':
            return {
                plannedChangedFiles: previousChangedFiles,
                useStaged: true,
                includeUntracked: true,
                detectionSource: 'git_staged_plus_untracked'
            };
        default:
            if (previousChangedFiles.length === 0) {
                return {
                    plannedChangedFiles: [],
                    changedFiles: undefined,
                    detectionSource: 'git_auto_current_workspace'
                };
            }
            return {
                plannedChangedFiles: previousChangedFiles,
                changedFiles: previousChangedFiles,
                detectionSource: 'explicit_changed_files'
            };
    }
}

export function resolveReviewCycleReplayScope(
    options: RestartReviewCycleCommandOptions,
    previousPreflight: ReturnType<typeof getPreflightContext>,
    previousTaskMode: ReturnType<typeof getTaskModeEvidence>
): ResolvedReplayScope {
    const explicitChangedFilesProvided = options.changedFiles !== undefined;
    const explicitChangedFiles = normalizeChangedFiles(expandValueList(options.changedFiles || [], { splitDelimiters: true }));
    const previousChangedFiles = getTaskOwnedReplayChangedFiles(previousPreflight);
    const taskStartedDirty = !!previousTaskMode.dirty_workspace_baseline?.changed_files.length;

    if (explicitChangedFilesProvided) {
        return {
            plannedChangedFiles: explicitChangedFiles,
            changedFiles: explicitChangedFiles,
            detectionSource: 'explicit_changed_files'
        };
    }

    if (options.useStaged === true) {
        const includeUntracked = parseBooleanOption(options.includeUntracked, previousPreflight.include_untracked);
        return {
            plannedChangedFiles: previousChangedFiles,
            useStaged: true,
            includeUntracked,
            detectionSource: includeUntracked ? 'git_staged_plus_untracked' : 'git_staged_only'
        };
    }

    switch (previousPreflight.detection_source) {
        case 'git_staged_only':
            return {
                plannedChangedFiles: previousChangedFiles,
                useStaged: true,
                includeUntracked: false,
                detectionSource: 'git_staged_only'
            };
        case 'git_staged_plus_untracked':
            return {
                plannedChangedFiles: previousChangedFiles,
                useStaged: true,
                includeUntracked: true,
                detectionSource: 'git_staged_plus_untracked'
            };
        default:
            return {
                plannedChangedFiles: previousChangedFiles,
                changedFiles: taskStartedDirty ? previousChangedFiles : undefined,
                detectionSource: taskStartedDirty ? 'explicit_changed_files' : 'git_auto_current_workspace'
            };
    }
}

export function getEffectiveDepthFromPreflight(
    previousTaskMode: ReturnType<typeof getTaskModeEvidence>,
    refreshedPreflight: ReturnType<typeof getPreflightContext>
): number {
    const riskAwareDepth = refreshedPreflight.preflight?.risk_aware_depth;
    if (
        riskAwareDepth
        && typeof riskAwareDepth === 'object'
        && !Array.isArray(riskAwareDepth)
        && typeof (riskAwareDepth as Record<string, unknown>).effective_depth === 'number'
    ) {
        return (riskAwareDepth as Record<string, number>).effective_depth;
    }
    return previousTaskMode.effective_depth || previousTaskMode.requested_depth || 2;
}

export function getReviewCyclePrePreflightRefreshPlan(
    repoRoot: string,
    taskId: string
): { rerunHandshakeDiagnostics: boolean; rerunShellSmokePreflight: boolean } {
    const timelinePath = gateHelpers.joinOrchestratorPath(repoRoot, path.join('runtime', 'task-events', `${taskId}.jsonl`));
    const timelineErrors: string[] = [];
    const events = collectOrderedTimelineEvents(timelinePath, timelineErrors);
    if (timelineErrors.length > 0 || events.length === 0) {
        return {
            rerunHandshakeDiagnostics: true,
            rerunShellSmokePreflight: true
        };
    }

    const latestTaskModeEntered = findLatestTimelineEvent(
        events,
        (entry) => entry.event_type === 'TASK_MODE_ENTERED'
    );
    if (latestTaskModeEntered) {
        const latestTaskEntryRulePack = findLatestTimelineEvent(
            events,
            (entry) => entry.sequence > latestTaskModeEntered.sequence && isTaskEntryRulePackLoadedEvent(entry)
        );
        if (!latestTaskEntryRulePack) {
            throw new Error(
                `restart-review-cycle detected TASK_MODE_ENTERED without matching RULE_PACK_LOADED for TASK_ENTRY ` +
                `inside the current task-mode cycle in '${gateHelpers.normalizePath(timelinePath)}'. ` +
                'Run restart-coherent-cycle to rebuild the cycle from task entry before rerunning review preparation.'
            );
        }
    }

    const latestCycleAnchor = getLatestPrePreflightCycleAnchor(events);
    const lowerBoundExclusive = latestCycleAnchor?.sequence ?? Number.NEGATIVE_INFINITY;
    const latestCycleBoundary = findLatestTimelineEvent(
        events,
        (entry) => entry.sequence > lowerBoundExclusive && REVIEW_CYCLE_BOUNDARY_EVENTS.has(entry.event_type)
    );
    if (latestCycleBoundary) {
        throw new Error(
            `restart-review-cycle cannot continue after the current task-mode cycle already reached '${latestCycleBoundary.event_type}' ` +
            `in '${gateHelpers.normalizePath(timelinePath)}'. Run restart-coherent-cycle to begin a fresh coherent cycle ` +
            'from task entry before rebuilding review contexts.'
        );
    }

    const latestPreflightRefreshBoundary = findLatestTimelineEvent(
        events,
        (entry) => (
            entry.sequence > lowerBoundExclusive
            && REVIEW_CYCLE_PREFLIGHT_REFRESH_BOUNDARY_EVENTS.has(entry.event_type)
        )
    );
    const startupLowerBoundExclusive = latestPreflightRefreshBoundary?.sequence ?? lowerBoundExclusive;

    const latestHandshake = findLatestTimelineEvent(
        events,
        (entry) => (
            entry.sequence > startupLowerBoundExclusive
            && entry.event_type === 'HANDSHAKE_DIAGNOSTICS_RECORDED'
        )
    );
    const latestShellSmoke = findLatestTimelineEvent(
        events,
        (entry) => (
            entry.sequence > startupLowerBoundExclusive
            && entry.event_type === 'SHELL_SMOKE_PREFLIGHT_RECORDED'
        )
    );

    if (!latestHandshake && !latestShellSmoke) {
        return {
            rerunHandshakeDiagnostics: true,
            rerunShellSmokePreflight: true
        };
    }

    if (!latestHandshake && latestShellSmoke) {
        throw new Error(
            `restart-review-cycle detected SHELL_SMOKE_PREFLIGHT_RECORDED without matching HANDSHAKE_DIAGNOSTICS_RECORDED ` +
            `inside the current task-mode cycle in '${gateHelpers.normalizePath(timelinePath)}'. ` +
            'Run restart-coherent-cycle to rebuild the cycle from task entry.'
        );
    }

    if (latestHandshake && (!latestShellSmoke || latestShellSmoke.sequence < latestHandshake.sequence)) {
        return {
            rerunHandshakeDiagnostics: false,
            rerunShellSmokePreflight: true
        };
    }

    return {
        rerunHandshakeDiagnostics: false,
        rerunShellSmokePreflight: false
    };
}
