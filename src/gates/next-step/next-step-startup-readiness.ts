import * as path from 'node:path';

import { buildTaskPlanDiagnostics } from '../diagnostics/task-plan-diagnostics';
import type { TaskModeArtifact } from '../task-mode/task-mode-contracts';
import {
    collectOrderedTimelineEvents,
    type TimelineEventEntry
} from '../completion/completion-evidence';
import {
    getRulePackEvidence,
    getRulePackEvidenceViolations
} from '../rule-pack/rule-pack';
import {
    findLatestTimelineEvent,
    getTimelineEventDetailString
} from './next-step-timeline-readers';

export interface StartupCycleReadiness {
    ready: boolean;
    nextGate: 'load-rule-pack' | 'handshake-diagnostics' | 'shell-smoke-preflight' | null;
    title: string;
    reason: string;
}

export interface StartupCycleReadinessOptions {
    enforceLateRulePackAfterReviewPhase?: boolean;
}

export function readAttachedTaskPlanIntegrityFailure(
    repoRoot: string,
    taskId: string,
    taskMode: Record<string, unknown> | null
): string | null {
    const plan = taskMode?.plan;
    if (plan === undefined || plan === null) {
        return taskMode?.plan_guided === true ? 'The frozen attached JSON task plan metadata is missing.' : null;
    }
    const diagnostic = buildTaskPlanDiagnostics(repoRoot, taskId, {
        plan: plan as TaskModeArtifact['plan'],
        markdown_working_plan: null
    });
    if (diagnostic.evidence === 'current') return null;
    return `The frozen attached JSON task plan is ${diagnostic.evidence}. Restore its original approved bytes `
        + 'and rerun the navigator; changing the plan requires the existing operator task-reset/re-entry workflow.';
}

function isPassedStartupDiagnostic(entry: TimelineEventEntry): boolean {
    return entry.outcome === 'PASS' || entry.details?.passed === true;
}

export function readStartupCycleReadiness(
    repoRoot: string,
    eventsRoot: string,
    taskId: string,
    taskModePath: string,
    options: StartupCycleReadinessOptions = {}
): StartupCycleReadiness {
    const timelinePath = path.join(eventsRoot, `${taskId}.jsonl`);
    const timelineErrors: string[] = [];
    const events = collectOrderedTimelineEvents(timelinePath, timelineErrors);
    if (timelineErrors.length > 0 || events.length === 0) {
        return {
            ready: true,
            nextGate: null,
            title: 'Startup cycle ordering was not checked.',
            reason: 'Timeline ordering could not be checked by next-step; downstream gates will report timeline integrity.'
        };
    }

    const latestTaskMode = findLatestTimelineEvent(
        events,
        (entry) => entry.event_type === 'TASK_MODE_ENTERED'
    );
    if (!latestTaskMode) {
        return {
            ready: true,
            nextGate: null,
            title: 'No task-mode cycle exists yet.',
            reason: 'No TASK_MODE_ENTERED event exists yet.'
        };
    }

    const isStartupRulePackEvent = (entry: TimelineEventEntry): boolean => {
        if (entry.event_type !== 'RULE_PACK_LOADED') {
            return false;
        }
        const stage = String(entry.details?.stage || '').trim().toUpperCase();
        return stage !== 'POST_PREFLIGHT';
    };
    const latestRulePack = findLatestTimelineEvent(
        events,
        (entry) => isStartupRulePackEvent(entry) && entry.sequence > latestTaskMode.sequence
    );
    const latestReviewPhaseStarted = findLatestTimelineEvent(
        events,
        (entry) => entry.event_type === 'REVIEW_PHASE_STARTED' && entry.sequence > latestTaskMode.sequence
    );
    const latestPostPreflightRulePackFailureBeforeLateStartup = latestRulePack && latestReviewPhaseStarted
        ? findLatestTimelineEvent(
            events,
            (entry) =>
                entry.event_type === 'RULE_PACK_LOAD_FAILED'
                && String(entry.details?.stage || '').trim().toUpperCase() === 'POST_PREFLIGHT'
                && entry.sequence > latestReviewPhaseStarted.sequence
                && entry.sequence < latestRulePack.sequence
        )
        : null;

    if (
        !options.enforceLateRulePackAfterReviewPhase
        && latestRulePack
        && latestReviewPhaseStarted
        && latestRulePack.sequence > latestReviewPhaseStarted.sequence
        && !latestPostPreflightRulePackFailureBeforeLateStartup
    ) {
        const latestPreReviewShellSmoke = findLatestTimelineEvent(
            events,
            (entry) =>
                entry.event_type === 'SHELL_SMOKE_PREFLIGHT_RECORDED'
                && entry.sequence > latestTaskMode.sequence
                && entry.sequence < latestReviewPhaseStarted.sequence
        );
        const latestPreReviewHandshake = latestPreReviewShellSmoke
            ? findLatestTimelineEvent(
                events,
                (entry) =>
                    entry.event_type === 'HANDSHAKE_DIAGNOSTICS_RECORDED'
                    && entry.sequence > latestTaskMode.sequence
                    && entry.sequence < latestPreReviewShellSmoke.sequence
            )
            : null;
        const latestPreReviewRulePack = latestPreReviewHandshake
            ? findLatestTimelineEvent(
                events,
                (entry) =>
                    isStartupRulePackEvent(entry)
                    && entry.sequence > latestTaskMode.sequence
                    && entry.sequence < latestPreReviewHandshake.sequence
            )
            : null;

        if (latestPreReviewRulePack && latestPreReviewHandshake && latestPreReviewShellSmoke) {
            const rulePackArtifactPath = getTimelineEventDetailString(latestRulePack, 'artifact_path')
                || getTimelineEventDetailString(latestRulePack, 'artifactPath');
            const rulePackEvidence = getRulePackEvidence(repoRoot, taskId, 'TASK_ENTRY', {
                artifactPath: rulePackArtifactPath,
                taskModePath
            });
            const rulePackViolations = getRulePackEvidenceViolations(rulePackEvidence);
            if (rulePackViolations.length === 0) {
                return {
                    ready: true,
                    nextGate: null,
                    title: 'Startup cycle is current.',
                    reason:
                        `Existing startup cycle before REVIEW_PHASE_STARTED is current; ignoring late startup rule-pack event ` +
                        `seq ${latestRulePack.sequence} recorded after review phase seq ${latestReviewPhaseStarted.sequence} ` +
                        `so review/preflight bindings are not invalidated without explicit task-mode restart or scope change.`
                };
            }
        }
    }

    if (!latestRulePack) {
        return {
            ready: false,
            nextGate: 'load-rule-pack',
            title: 'Record TASK_ENTRY rule files for the current task-mode cycle.',
            reason: `The latest TASK_MODE_ENTERED event is seq ${latestTaskMode.sequence}, but no RULE_PACK_LOADED event exists after it. Load TASK_ENTRY rules before handshake, preflight, compile, review, or completion.`
        };
    }

    const rulePackArtifactPath = getTimelineEventDetailString(latestRulePack, 'artifact_path')
        || getTimelineEventDetailString(latestRulePack, 'artifactPath');
    const rulePackEvidence = getRulePackEvidence(repoRoot, taskId, 'TASK_ENTRY', {
        artifactPath: rulePackArtifactPath,
        taskModePath
    });
    const rulePackViolations = getRulePackEvidenceViolations(rulePackEvidence);
    if (rulePackViolations.length > 0) {
        return {
            ready: false,
            nextGate: 'load-rule-pack',
            title: 'Refresh TASK_ENTRY rule files for the current task-mode cycle.',
            reason:
                `The latest TASK_ENTRY rule-pack evidence after TASK_MODE_ENTERED seq ${latestTaskMode.sequence} is stale or invalid: ` +
                `${rulePackViolations.join(' ')} Load TASK_ENTRY rules again before handshake, preflight, compile, review, or completion.`
        };
    }

    const latestHandshake = findLatestTimelineEvent(
        events,
        (entry) => entry.event_type === 'HANDSHAKE_DIAGNOSTICS_RECORDED' && entry.sequence > latestRulePack.sequence
    );
    if (!latestHandshake) {
        return {
            ready: false,
            nextGate: 'handshake-diagnostics',
            title: 'Run handshake diagnostics for the current task-mode cycle.',
            reason: `The latest TASK_MODE_ENTERED event is seq ${latestTaskMode.sequence}, and the latest startup rule-pack event is seq ${latestRulePack.sequence}, but no HANDSHAKE_DIAGNOSTICS_RECORDED event exists after them.`
        };
    }
    if (!isPassedStartupDiagnostic(latestHandshake)) {
        return {
            ready: false,
            nextGate: 'handshake-diagnostics',
            title: 'Retry failed handshake diagnostics for the current task-mode cycle.',
            reason: `The latest HANDSHAKE_DIAGNOSTICS_RECORDED event after startup rules is seq ${latestHandshake.sequence}, but it did not pass. Retry handshake diagnostics before shell-smoke, preflight, compile, review, or completion.`
        };
    }

    const latestShellSmoke = findLatestTimelineEvent(
        events,
        (entry) => entry.event_type === 'SHELL_SMOKE_PREFLIGHT_RECORDED' && entry.sequence > latestHandshake.sequence
    );
    if (!latestShellSmoke) {
        return {
            ready: false,
            nextGate: 'shell-smoke-preflight',
            title: 'Run shell smoke preflight for the current task-mode cycle.',
            reason: `The latest HANDSHAKE_DIAGNOSTICS_RECORDED event is seq ${latestHandshake.sequence}, but no SHELL_SMOKE_PREFLIGHT_RECORDED event exists after it.`
        };
    }
    if (!isPassedStartupDiagnostic(latestShellSmoke)) {
        return {
            ready: false,
            nextGate: 'shell-smoke-preflight',
            title: 'Retry failed shell smoke preflight for the current task-mode cycle.',
            reason: `The latest SHELL_SMOKE_PREFLIGHT_RECORDED event after handshake is seq ${latestShellSmoke.sequence}, but it did not pass. Retry shell-smoke before classify-change instead of advancing a partial restart cycle.`
        };
    }

    return {
        ready: true,
        nextGate: null,
        title: 'Startup cycle is current.',
        reason: 'TASK_ENTRY rule-pack, handshake, and shell-smoke evidence are current for the latest task-mode cycle.'
    };
}
