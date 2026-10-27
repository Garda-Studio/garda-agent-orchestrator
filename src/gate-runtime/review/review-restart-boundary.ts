function isPlainRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function isAuthenticatedReviewRestartBoundary(
    event: Record<string, unknown>,
    taskId: string,
    reviewType: string,
    afterTaskSequence = 0
): boolean {
    const eventType = String(event.event_type || '').trim();
    if (eventType !== 'COHERENT_CYCLE_RESTARTED' && eventType !== 'REVIEW_CYCLE_RESTARTED') {
        return false;
    }
    const details = isPlainRecord(event.details) ? event.details : {};
    const integrity = isPlainRecord(event.integrity) ? event.integrity : {};
    if (
        Number(integrity.task_sequence) <= afterTaskSequence
        || String(event.task_id || '').trim() !== taskId
        || String(event.outcome || '').trim() !== 'PASS'
        || String(event.actor || '').trim() !== 'orchestrator'
        || String(details.task_id || '').trim() !== taskId
        || String(details.event_type || '').trim() !== eventType
        || String(details.status || '').trim() !== 'PASSED'
    ) {
        return false;
    }
    if (eventType === 'COHERENT_CYCLE_RESTARTED') {
        return true;
    }
    return Array.isArray(details.invalidated_review_types)
        && details.invalidated_review_types.some((entry) => String(entry || '').trim() === reviewType);
}
