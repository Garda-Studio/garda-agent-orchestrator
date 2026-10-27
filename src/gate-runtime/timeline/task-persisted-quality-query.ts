import { createHash } from 'node:crypto';
/** Identity query for the sealed quality leaves, not a proof of full quality acquisition. */
export const PERSISTED_QUALITY_QUERY_VERSION = 1;
const boundaryTypes = new Set(['TASK_MODE_ENTERED', 'PREFLIGHT_CLASSIFIED', 'REVIEW_CYCLE_RESTARTED',
    'COHERENT_CYCLE_RESTARTED', 'TASK_RESET', 'TASK_DISCARDED']);
const consumedTypes = new Set([...boundaryTypes, 'QUALITY_CHECKLIST_RECORDED', 'QUALITY_CHECKLIST_FAILED',
    'COMPILE_GATE_FAILED', 'COMPLETION_GATE_FAILED']);
export interface PersistedQualityTimelineQuery { readonly version: 1; readonly querySha256: string; readonly cycleSha256: string; readonly matches: number }
export function beginPersistedQualityTimelinePass() {
    const digest = createHash('sha256').update('garda.quality-leaf-query.v1\0');
    let cycle: string | null = null, matches = 0, invalid = false;
    return {
        accept(event: Readonly<Record<string, unknown>> | null) {
            try {
                if (!event) { invalid = true; return; }
                const type = String(event.event_type || '').trim().toUpperCase();
                if (!consumedTypes.has(type)) return;
                const integrity = event.integrity as Record<string, unknown> | undefined;
                const sha = String(integrity?.event_sha256 || '').trim().toLowerCase();
                if (!/^[a-f0-9]{64}$/u.test(sha)) { invalid = true; return; }
                digest.update(JSON.stringify([type, Number(integrity?.task_sequence), sha]) + '\n');
                matches++;
                if (boundaryTypes.has(type)) cycle = sha;
            } catch { invalid = true; }
        },
        finish(status: string): PersistedQualityTimelineQuery | null {
            if (invalid || status !== 'PASS' || !cycle) return null;
            return Object.freeze({ version: 1, querySha256: digest.digest('hex'), cycleSha256: cycle, matches });
        }
    };
}
