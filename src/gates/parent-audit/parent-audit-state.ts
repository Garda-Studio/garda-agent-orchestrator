import { isTaskQueueDoneStatus } from '../../core/active-task-state';
import { joinOrchestratorPath } from '../../core/orchestrator-paths';
import { withTaskTimelineReadSnapshot } from '../../gate-runtime/task-events';
import { captureTaskTimelineReadSnapshotSha256, assertTaskTimelineReadSnapshotCurrent } from '../../gate-runtime/timeline/task-timeline-read-snapshot';
import { isDeepStrictEqual } from 'node:util';
import { parentRecordDigest, readParentEvents } from './parent-audit-auth';
import { parentEventHash, readParentCompletionContract, readParentQueue, readParentRecordedReview } from './parent-audit-contract';
import { captureParentSource, readAcceptedParentChildren, assertParentWipPreserved } from './parent-audit-graph';
import { readAcceptedParentAuditResult } from './parent-audit-evidence';
import { readParentAuditFollowUp } from './parent-audit-follow-up';
import { readParentValidations } from './parent-audit-validation';
import type { ParentCompletionContract } from './parent-audit-types';
import { mergeNativeChildSources, type NativeChildSourceAcceptance } from '../task-audit/task-audit-summary-decomposed-parent-proofs';
import type { ParentCompletionInspection } from './parent-audit-types';
import { withNativeParentReadScope, type NativeParentObligationProofs } from '../task-audit/task-audit-summary-parent-obligation-proofs';
import type { ParentAuditEventReference, DecomposedParentRequiredProof } from '../task-audit/task-audit-summary-types';

const inspecting = new Set<string>();

export function inspectParentCompletion(root: string, taskId: string): ParentCompletionInspection | null {
    if (!readParentCompletionContract(root, taskId)) return null;
    return withNativeParentReadScope(root, taskId, scope => withTaskTimelineReadSnapshot(joinOrchestratorPath(root, 'runtime/task-events'), taskId, () => {
        const timeline = joinOrchestratorPath(root, `runtime/task-events/${taskId}.jsonl`);
        const snapshotSha256 = captureTaskTimelineReadSnapshotSha256(timeline), queue = readParentQueue(root).bytes;
        const snapshot = inspectParentCompletionSnapshot(root, taskId), result = snapshot?.inspection ?? null;
        if (snapshot && result) {
            const assertCurrent = () => {
                assertTaskTimelineReadSnapshotCurrent(timeline, snapshotSha256);
                if (!queue.equals(readParentQueue(root).bytes)) throw new Error('Parent queue changed during qualification.');
            };
            assertCurrent();
            scope.rechecks.push(() => withTaskTimelineReadSnapshot(joinOrchestratorPath(root, 'runtime/task-events'), taskId, assertCurrent));
            if (result.ready) scope.proofRechecks.push(() => withTaskTimelineReadSnapshot(joinOrchestratorPath(root, 'runtime/task-events'), taskId,
                () => assertParentInspectionCurrent(root, taskId, snapshot)));
        }
        return result;
    }), result => result?.ready === true);
}

function assertParentInspectionCurrent(root: string, taskId: string, snapshot: NonNullable<ReturnType<typeof inspectParentCompletionSnapshot>>): void {
    const result = snapshot.inspection, contract = readParentCompletionContract(root, taskId);
    if (!contract || !isDeepStrictEqual(contract, result.contract)) throw new Error('Parent completion contract changed during qualification.');
    assertParentWipPreserved(root, contract);
    if (!contract.policy.audit_enabled) {
        if (!automaticFailuresResolved(root, contract, result.childSources)) throw new Error('Parent original failure resolution changed during qualification.');
    } else if (!isDeepStrictEqual(readAcceptedParentAuditResult(root, contract), result.result)
        || (readParentAuditFollowUp(root, taskId)?.follow_up_task_id ?? null) !== result.followUpTaskId) {
        throw new Error('Parent aggregate result or correction changed during qualification.');
    }
    if (!isDeepStrictEqual(captureParentSource(root), snapshot.source)) throw new Error('Parent Git source changed during qualification.');
}

function readCurrentChildValidationEvents(root: string, taskId: string): Record<string, unknown>[] {
    const events = readParentEvents(root, taskId);
    const boundary = events.reduce((latest, event, index) => event.event_type === 'TASK_MODE_ENTERED'
        || event.event_type === 'REVIEW_CYCLE_RESTARTED' || String(event.event_type).startsWith('COMPILE_GATE_') ? index : latest, -1);
    return events.slice(boundary + 1);
}

function automaticFailuresResolved(root: string, contract: ParentCompletionContract, children: NativeChildSourceAcceptance[]): boolean {
    const success: Record<string, string[]> = {
        COMPILE_GATE: ['COMPILE_GATE_PASSED'], REVIEW_GATE: ['REVIEW_GATE_PASSED', 'REVIEW_GATE_PASSED_WITH_OVERRIDE'],
        DOC_IMPACT: ['DOC_IMPACT_ASSESSED'], PROJECT_MEMORY_IMPACT: ['PROJECT_MEMORY_IMPACT_ASSESSED']
    };
    return contract.unresolved_failures.every(gate => {
        if (gate.startsWith('REVIEW_RECORDED:')) return children.every(child => {
            const latest = [...readCurrentChildValidationEvents(root, child.taskId)].reverse().map(readParentRecordedReview)
                .find(review => review?.reviewType === gate.slice('REVIEW_RECORDED:'.length));
            return latest?.passed === true;
        });
        if (gate === 'FULL_SUITE_VALIDATION') {
            if (contract.original_commands.length > 0) return readParentValidations(root, contract).every(proof => proof?.status === 'PASSED');
            return children.every(child => {
                const latest = [...readCurrentChildValidationEvents(root, child.taskId)].reverse().find(event =>
                    /^FULL_SUITE_VALIDATION_(?:PASSED|FAILED|BLOCKED|WARNED|SKIPPED)$/u.test(String(event.event_type)));
                return latest?.event_type === 'FULL_SUITE_VALIDATION_PASSED' && latest.outcome === 'PASS';
            });
        }
        const events = success[gate];
        return Boolean(events) && children.every(child => {
            const current = [...readParentEvents(root, child.taskId)].reverse().find(event =>
                events.includes(String(event.event_type)) || event.event_type === gate + '_FAILED' || event.event_type === gate + '_BLOCKED');
            return current?.outcome === 'PASS';
        });
    });
}

function inspectParentCompletionSnapshot(root: string, taskId: string): {
    inspection: ParentCompletionInspection; source: ReturnType<typeof captureParentSource> | null
} | null {
    const key = root + '\0' + taskId;
    if (inspecting.has(key)) throw new Error('Cyclic parent acceptance graph.');
    const contract = readParentCompletionContract(root, taskId);
    if (!contract) return null;
    inspecting.add(key);
    try {
        const inspection: ParentCompletionInspection = { contract, contractSha256: parentRecordDigest(contract), childSources: [],
            ready: false, result: null, followUpTaskId: null, violations: [] };
        let source: ReturnType<typeof captureParentSource> | null = null;
        try {
            source = captureParentSource(root);
            inspection.childSources = readAcceptedParentChildren(root, contract);
            assertParentWipPreserved(root, contract);
            if (!contract.policy.audit_enabled) {
                inspection.ready = automaticFailuresResolved(root, contract, inspection.childSources);
                return { inspection, source };
            }
            inspection.result = readAcceptedParentAuditResult(root, contract);
            if (!inspection.result) return { inspection, source };
            const followUp = readParentAuditFollowUp(root, taskId);
            if (inspection.result.follow_up_task_id !== (followUp?.follow_up_task_id ?? null)) throw new Error('Aggregate result and grouped correction link differ.');
            if (followUp) {
                inspection.followUpTaskId = followUp.follow_up_task_id;
                if (!isTaskQueueDoneStatus(readParentQueue(root).entries.get(followUp.follow_up_task_id)?.status ?? null)) return { inspection, source };
                inspection.childSources = mergeNativeChildSources([inspection.childSources,
                    readAcceptedParentChildren(root, { ...contract, child_task_ids: [followUp.follow_up_task_id] })]);
            }
            inspection.ready = true;
            return { inspection, source };
        } catch (error: unknown) {
            inspection.violations.push(error instanceof Error ? error.message : String(error));
            return { inspection, source };
        }
    } finally { inspecting.delete(key); }
}

export function readRegisteredParentObligations(root: string, taskId: string): NativeParentObligationProofs | null {
    const inspection = inspectParentCompletion(root, taskId);
    if (!inspection) return null;
    const events = readParentEvents(root, taskId), entry = readParentQueue(root).entries.get(taskId);
    const reference = (event: Record<string, unknown> | undefined): ParentAuditEventReference | null => {
        const hash = parentEventHash(event), integrity = event?.integrity as Record<string, unknown> | undefined;
        return hash && Number.isSafeInteger(integrity?.task_sequence)
            ? { taskId, sequence: Number(integrity!.task_sequence), sha256: hash } : null;
    };
    const decomposition = events.find(event => parentEventHash(event) === inspection.contract.decomposition_sha256)
        || events.find(event => event.event_type === 'PARENT_AUDIT_RECORD_PUBLISHED'
            && (event.details as Record<string, unknown> | undefined)?.kind === 'contract');
    const completion = [...events].reverse().find(event => event.event_type === 'DECOMPOSED_PARENT_COMPLETED');
    const required: DecomposedParentRequiredProof[] = ['authenticated-decomposition', 'source-qualified-child-acceptance', 'preserved-parent-wip'];
    if (inspection.contract.policy.audit_enabled) required.push('aggregate-parent-review');
    const children = [...inspection.contract.child_task_ids, ...(inspection.followUpTaskId ? [inspection.followUpTaskId] : [])];
    const facts = { taskId, taskStatus: entry?.status ?? null, childTaskIds: children,
        completedChildTaskIds: children.filter(id => isTaskQueueDoneStatus(readParentQueue(root).entries.get(id)?.status ?? null)),
        childGraphComplete: inspection.ready, decomposition: reference(decomposition), completion: reference(completion),
        historicalFailures: inspection.contract.unresolved_failures, fullSuiteRequired: false, projectMemoryRequired: false };
    const violations = [...inspection.violations];
    if (!inspection.ready) violations.push('Parent awaits its accepted aggregate result or grouped correction.');
    if (!isTaskQueueDoneStatus(facts.taskStatus) || !facts.completion) violations.push('Parent awaits gate-owned DONE publication.');
    return { status: violations.length ? 'BLOCKED' : 'QUALIFIED',
        native: { facts, requirements: { status: 'REQUIRES_PROOF', childTaskIds: children, requiredProofs: required,
            historicalFailures: inspection.contract.unresolved_failures, violations }, childSources: inspection.childSources },
        qualifiedProofs: violations.length ? [] : required, violations };
}
