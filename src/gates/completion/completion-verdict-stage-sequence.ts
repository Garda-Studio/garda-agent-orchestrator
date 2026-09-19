import { normalizePath } from '../shared/helpers';
import {
    findLatestTimelineEvent,
    findLatestStageOccurrence,
    findLatestStageOccurrenceInRange
} from './completion-evidence';
import type { TimelineEventEntry } from './completion-evidence';
import { TASK_LIFECYCLE_PHASE_IDS } from '../../schemas/task-lifecycle-phase-manifest';
import type { TaskLifecyclePhaseId } from '../../schemas/task-lifecycle-phase-manifest';

const COMPLETION_STAGE_EVENTS_BY_PHASE: Readonly<Record<TaskLifecyclePhaseId, readonly string[]>> = Object.freeze({
    startup: Object.freeze([
        'TASK_MODE_ENTERED',
        'HANDSHAKE_DIAGNOSTICS_RECORDED',
        'SHELL_SMOKE_PREFLIGHT_RECORDED'
    ]),
    preflight: Object.freeze(['PREFLIGHT_CLASSIFIED']),
    implementation: Object.freeze(['IMPLEMENTATION_STARTED']),
    validation: Object.freeze(['COMPILE_GATE_PASSED']),
    review: Object.freeze([
        'REVIEW_PHASE_STARTED',
        'REVIEW_RECORDED',
        'REVIEW_GATE_PASSED'
    ]),
    closeout: Object.freeze([]),
    terminal: Object.freeze([])
});

export const STAGE_SEQUENCE_ORDER: readonly string[] = Object.freeze(
    TASK_LIFECYCLE_PHASE_IDS.flatMap((phaseId) => COMPLETION_STAGE_EVENTS_BY_PHASE[phaseId])
);

export const NO_REVIEW_RECORDED_STAGE_SEQUENCE_ORDER: readonly string[] = Object.freeze(
    STAGE_SEQUENCE_ORDER.filter((stage) => stage !== 'REVIEW_RECORDED' && stage !== 'REVIEW_PHASE_STARTED')
);

export const NON_CODE_STAGE_SEQUENCE_ORDER = NO_REVIEW_RECORDED_STAGE_SEQUENCE_ORDER;

export interface StageSequenceEvidence {
    observed_order: string[];
    expected_order: string[];
    code_changed: boolean;
    review_skill_ids: string[];
    review_skill_reference_paths: string[];
    review_artifact_keys: string[];
    reviewer_execution_modes: string[];
    violations: string[];
}

const CYCLE_BOUNDARY_EVENTS = new Set([
    'REVIEW_GATE_PASSED',
    'REVIEW_GATE_PASSED_WITH_OVERRIDE',
    'COMPLETION_GATE_FAILED',
    'COMPLETION_GATE_PASSED'
]);

const UPSTREAM_CYCLE_RESTART_EVENTS = new Set([
    'HANDSHAKE_DIAGNOSTICS_RECORDED',
    'SHELL_SMOKE_PREFLIGHT_RECORDED',
    'PREFLIGHT_CLASSIFIED'
]);

export function validateStageSequence(
    events: TimelineEventEntry[],
    codeChanged: boolean,
    timelinePath: string,
    reviewRecordedRequired: boolean = codeChanged,
    compileGateRequired = true
): StageSequenceEvidence {
    const normalizedTimelinePath = normalizePath(timelinePath);
    const violations: string[] = [];
    const observedOrder: string[] = [];
    const baseExpectedStages = reviewRecordedRequired
        ? [...STAGE_SEQUENCE_ORDER]
        : [...NO_REVIEW_RECORDED_STAGE_SEQUENCE_ORDER];
    const expectedStages = compileGateRequired
        ? baseExpectedStages
        : baseExpectedStages.filter((stage) => (
            stage !== 'IMPLEMENTATION_STARTED'
            && stage !== 'COMPILE_GATE_PASSED'
        ));

    const anchorStage = expectedStages[expectedStages.length - 1];
    const anchorEntry = anchorStage
        ? findLatestStageOccurrence(events, anchorStage, Number.POSITIVE_INFINITY)
        : null;

    const cycleLocalStages = new Set([
        'HANDSHAKE_DIAGNOSTICS_RECORDED',
        'SHELL_SMOKE_PREFLIGHT_RECORDED',
        'PREFLIGHT_CLASSIFIED',
        'IMPLEMENTATION_STARTED',
        'COMPILE_GATE_PASSED',
        'REVIEW_PHASE_STARTED',
        'REVIEW_GATE_PASSED',
        ...(reviewRecordedRequired ? ['REVIEW_RECORDED'] : [])
    ]);

    let cycleFloorExclusive = Number.NEGATIVE_INFINITY;
    if (anchorEntry) {
        const latestUpstreamRestart = findLatestTimelineEvent(
            events,
            (entry) => entry.sequence < anchorEntry.sequence && UPSTREAM_CYCLE_RESTART_EVENTS.has(entry.event_type)
        );
        for (let index = events.length - 1; index >= 0; index -= 1) {
            const entry = events[index];
            if (!latestUpstreamRestart || entry.sequence >= latestUpstreamRestart.sequence) {
                continue;
            }
            if (CYCLE_BOUNDARY_EVENTS.has(entry.event_type)) {
                cycleFloorExclusive = entry.sequence;
                break;
            }
        }
    }

    const stageEntries = new Map<string, TimelineEventEntry>();
    const upperBoundExclusive = anchorEntry ? anchorEntry.sequence + 1 : Number.POSITIVE_INFINITY;
    for (const stage of expectedStages) {
        const lowerBoundExclusive = cycleLocalStages.has(stage) ? cycleFloorExclusive : Number.NEGATIVE_INFINITY;
        const latest = findLatestStageOccurrenceInRange(events, stage, lowerBoundExclusive, upperBoundExclusive);
        if (latest) {
            stageEntries.set(stage, latest);
        }
    }

    for (const stage of expectedStages) {
        if (stageEntries.has(stage)) {
            observedOrder.push(stage);
        }
    }

    for (let index = 0; index < expectedStages.length; index += 1) {
        const stage = expectedStages[index];
        if (stageEntries.has(stage)) {
            continue;
        }
        const laterStage = expectedStages
            .slice(index + 1)
            .find((candidate) => stageEntries.has(candidate));
        if (!laterStage) {
            continue;
        }
        const laterEntry = stageEntries.get(laterStage);
        const olderStage = findLatestStageOccurrence(events, stage, upperBoundExclusive);
        const backfillHint = olderStage
            ? ` Do not backfill '${stage}' from an older execution cycle.`
            : '';
        violations.push(
            `Stage sequence violation in '${normalizedTimelinePath}': ` +
            `latest '${laterStage}' evidence (seq ${laterEntry?.sequence ?? 'unknown'}) has no matching ` +
            `'${stage}' evidence inside the latest execution cycle.` +
            `${backfillHint} Expected order: ${expectedStages.join(' → ')}.`
        );
    }

    for (let index = 1; index < expectedStages.length; index += 1) {
        const previousStage = expectedStages[index - 1];
        const currentStage = expectedStages[index];
        const previousEntry = stageEntries.get(previousStage);
        const currentEntry = stageEntries.get(currentStage);

        if (!currentEntry) {
            continue;
        }

        if (!previousEntry) {
            const olderPrevious = findLatestStageOccurrence(events, previousStage, upperBoundExclusive);
            const backfillHint = olderPrevious
                ? ` Do not backfill '${previousStage}' from an older execution cycle.`
                : '';
            violations.push(
                `Stage sequence violation in '${normalizedTimelinePath}': ` +
                `latest '${currentStage}' evidence (seq ${currentEntry.sequence}) has no matching ` +
                `'${previousStage}' evidence inside the latest execution cycle.` +
                `${backfillHint} Expected order: ${expectedStages.join(' → ')}.`
            );
            continue;
        }

        if (currentEntry.sequence < previousEntry.sequence) {
            const olderPrevious = findLatestStageOccurrence(events, previousStage, currentEntry.sequence);
            const backfillHint = olderPrevious
                ? ` Do not backfill '${previousStage}' from an older execution cycle.`
                : '';
            violations.push(
                `Stage sequence violation in '${normalizedTimelinePath}': ` +
                `latest '${currentStage}' evidence (seq ${currentEntry.sequence}) appears before ` +
                `latest '${previousStage}' evidence (seq ${previousEntry.sequence}) in the latest execution cycle.` +
                `${backfillHint} Expected order: ${expectedStages.join(' → ')}.`
            );
        }
    }

    // For code-changing tasks, PREFLIGHT_CLASSIFIED is mandatory
    if (codeChanged && !stageEntries.has('PREFLIGHT_CLASSIFIED')) {
        violations.push(
            `Task timeline '${normalizedTimelinePath}' is missing PREFLIGHT_CLASSIFIED. ` +
            'Code-changing tasks must carry preflight classification evidence.'
        );
    }

    return {
        observed_order: observedOrder,
        expected_order: expectedStages,
        code_changed: codeChanged,
        review_skill_ids: [],
        review_skill_reference_paths: [],
        review_artifact_keys: [],
        reviewer_execution_modes: [],
        violations
    };
}
