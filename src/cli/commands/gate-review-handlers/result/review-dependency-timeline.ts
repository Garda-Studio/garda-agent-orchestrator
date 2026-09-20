import * as fs from 'node:fs';
import {
    type ReviewDependencyTimelineEvent
} from '../../../../gates/review/review-dependencies';

export function readDependencyTimelineEvents(timelinePath: string): ReviewDependencyTimelineEvent[] {
    if (!fs.existsSync(timelinePath) || !fs.statSync(timelinePath).isFile()) {
        return [];
    }
    return fs.readFileSync(timelinePath, 'utf8')
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .flatMap((line, sequence) => {
            try {
                const parsed = JSON.parse(line) as Record<string, unknown>;
                const details = parsed.details && typeof parsed.details === 'object' && !Array.isArray(parsed.details)
                    ? parsed.details as Record<string, unknown>
                    : null;
                const rawIntegrity = parsed.integrity && typeof parsed.integrity === 'object' && !Array.isArray(parsed.integrity)
                    ? parsed.integrity as Record<string, unknown>
                    : null;
                const taskSequence = typeof rawIntegrity?.task_sequence === 'number'
                    ? rawIntegrity.task_sequence
                    : Number(rawIntegrity?.task_sequence);
                const eventSha256 = String(rawIntegrity?.event_sha256 || '').trim().toLowerCase();
                const prevEventSha256Raw = rawIntegrity?.prev_event_sha256;
                const prevEventSha256 = prevEventSha256Raw == null
                    ? null
                    : String(prevEventSha256Raw).trim().toLowerCase() || null;
                return [{
                    event_type: String(parsed.event_type || '').trim().toUpperCase(),
                    outcome: String(parsed.outcome || '').trim().toUpperCase(),
                    sequence,
                    details,
                    integrity: rawIntegrity
                        && Number.isInteger(taskSequence)
                        && taskSequence > 0
                        && /^[0-9a-f]{64}$/.test(eventSha256)
                        && (prevEventSha256 == null || /^[0-9a-f]{64}$/.test(prevEventSha256))
                        ? {
                            schema_version: typeof rawIntegrity.schema_version === 'number'
                                ? rawIntegrity.schema_version
                                : Number(rawIntegrity.schema_version) || 1,
                            task_sequence: taskSequence,
                            prev_event_sha256: prevEventSha256,
                            event_sha256: eventSha256
                        }
                        : null
                }];
            } catch {
                return [];
            }
        });
}
