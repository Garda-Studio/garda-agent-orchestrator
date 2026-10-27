/** Internal navigation projection support. Full audit/completion never installs lazy fields. */
import { countNextStepWork } from '../../core/next-step-measurement';
import { createInvocationReadMemoKey, isInvocationReadObservationActive, memoizeInvocationRead } from '../../core/invocation-read-observation';
import type { TaskAuditSummaryResult } from './task-audit-summary-types';
const REPORT_OWNER = createInvocationReadMemoKey<object>('navigation-report-owner');
const cycleBindings = new WeakMap<TaskAuditSummaryResult, TaskAuditSummaryResult['final_closeout']['cycle_binding']>();
export function bindNavigationAuditCycle(summary: TaskAuditSummaryResult, binding: TaskAuditSummaryResult['final_closeout']['cycle_binding']): void {
    cycleBindings.set(summary, binding);
}
export function readNavigationAuditCycle(summary: TaskAuditSummaryResult): TaskAuditSummaryResult['final_closeout']['cycle_binding'] {
    return cycleBindings.has(summary) ? cycleBindings.get(summary) : summary.final_closeout.cycle_binding;
}
/** Successful or failed derivations execute once. All actual object/file visits remain counted by builders. */
export function createReportProjectionValue<T>(name: string, lazy: boolean, build: () => T, withinSnapshot: <V>(action: () => V) => V): () => T {
    const owner = lazy && isInvocationReadObservationActive()
        ? memoizeInvocationRead(REPORT_OWNER, 'owner', () => ({})).value : null;
    let result: { ok: true; value: T } | { ok: false; error: unknown } | undefined;
    const read = (): T => {
        if (!result) {
            if (lazy && (!owner || !isInvocationReadObservationActive()
                || memoizeInvocationRead(REPORT_OWNER, 'owner', () => ({})).value !== owner))
                throw new Error('Unconsumed navigation report escaped its invocation: ' + name);
            countNextStepWork('report_projection:' + name);
            try { result = { ok: true, value: lazy ? withinSnapshot(build) : build() }; }
            catch (error) { result = { ok: false, error }; }
        }
        if (!result.ok) throw result.error;
        return result.value;
    };
    if (!lazy) read();
    return read;
}
