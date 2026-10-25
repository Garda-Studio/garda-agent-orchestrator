import { isPlainRecord } from '../../core/records';

const RETRYABLE_FINALIZATION_ERROR_CODES = new Set(['EPERM', 'EACCES', 'EBUSY', 'ENOSPC', 'EMFILE', 'EAGAIN', 'EIO']);

export function isRetryableCompletionFinalizationError(error: unknown): boolean {
    const visited = new Set<object>();
    let current = error;
    while (current && typeof current === 'object' && !visited.has(current)) {
        visited.add(current);
        const details = current as { code?: unknown; cause?: unknown };
        // Only the primary cause grants retryability; repair messages can include rollback failures.
        if (details.cause === undefined) {
            return typeof details.code === 'string' && RETRYABLE_FINALIZATION_ERROR_CODES.has(details.code);
        }
        current = details.cause;
    }
    return false;
}

/**
 * A completion attempt whose validation passed and only finalization failed (for example a
 * permission error while appending the DONE status) does not invalidate the cycle evidence.
 * The exact completion-gate retry revalidates everything, so navigation must not demand a new
 * preflight. Linkage recovery failures keep their own dedicated recovery path.
 */
export function isValidatedCompletionFinalizationFailure(event: {
    event_type?: unknown;
    details?: unknown;
} | null | undefined): boolean {
    if (!event || event.event_type !== 'COMPLETION_GATE_FAILED' || !isPlainRecord(event.details)) {
        return false;
    }
    const details = event.details;
    return details.outcome === 'FINALIZATION_FAILED'
        && details.status === 'PASSED'
        && details.finalization_retryable === true
        && Array.isArray(details.violations) && details.violations.length === 0
        && (details.closeout_linkage_recovery === null || details.closeout_linkage_recovery === undefined);
}
