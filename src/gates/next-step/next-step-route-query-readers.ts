import * as path from 'node:path';
import { collectOrderedTimelineEvents, type TimelineEventEntry } from '../completion/completion-evidence';
import { readTaskTimelineRouteQuery } from '../../gate-runtime/timeline/task-events-integrity';
import { routePreflightWitnesses, routeSplitWitnesses } from '../../gate-runtime/timeline/task-route-query';
export function readRouteOrderedWitnesses(timelinePath: string, errors: string[], purpose: 'preflight' | 'split'): TimelineEventEntry[] {
    const taskId = path.basename(timelinePath, '.jsonl');
    const query = readTaskTimelineRouteQuery(timelinePath, taskId);
    if (!query) return collectOrderedTimelineEvents(timelinePath, errors);
    return purpose === 'preflight' ? routePreflightWitnesses(query) : routeSplitWitnesses(query);
}
