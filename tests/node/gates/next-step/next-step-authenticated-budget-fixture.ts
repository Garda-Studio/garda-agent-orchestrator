import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { formatNextStepText } from '../../../../src/gates/next-step/next-step-command-formatters';
import * as path from 'node:path';
import { withNextStepMeasurement, type NextStepMeasurement } from '../../../../src/core/next-step-measurement';
import { resolveNextStep } from '../../../../src/gates/next-step';
import type { AuthenticatedHistoryFixture } from './next-step-authenticated-history-fixture';

export interface HistoryRouteMeasurement {
    route: string;
    outputJsonSha256: string;
    outputTextSha256: string;
    nextGate: string | null;
    reason: string;
    status: string;
    auditStatus: string;
    elapsedMs: number;
    phasesMs: Record<string, number>;
    counters: Record<string, number>;
    artifactsByPath: Record<string, number>;
    artifactsByCycle: Record<string, number>;
}

function normalizedPath(value: string): string { return path.resolve(value).replace(/\\/gu, '/').toLowerCase(); }

export function measureHistoryRoute(state: Pick<AuthenticatedHistoryFixture, 'repoRoot' | 'taskId' | 'files' | 'historicalArtifacts' | 'artifactCycles'>, route: string): HistoryRouteMeasurement {
    let measured: NextStepMeasurement | undefined;
    const started = performance.now();
    const result = withNextStepMeasurement(() => resolveNextStep(state), measurement => { measured = measurement; });
    const elapsedMs = performance.now() - started;
    if (!measured) throw new Error('Real next-step measurement was not captured.');
    const scope = new Set(state.files.map(file => normalizedPath(path.join(state.repoRoot, file))));
    const oldArtifacts = new Set(state.historicalArtifacts.map(normalizedPath));
    const counters: Record<string, number> = {}, artifactsByPath: Record<string, number> = {}, artifactsByCycle: Record<string, number> = {};
    const cycles = new Map(Object.entries(state.artifactCycles).map(([file, cycle]) => [normalizedPath(file), cycle]));
    const add = (key: string, count: number) => { counters[key] = (counters[key] || 0) + count; };
    for (const [key, count] of Object.entries(measured.work)) {
        if (key.startsWith('process:')) { add(key.split(':').slice(0, 3).join(':'), count); continue; }
        const match = /^(payload_read|artifact_bytes|artifact_json_parse|file_hash|scope_path_state|timeline_capture|timeline_payload_read|timeline_revalidate|native_realpath_observation|native_realpath_final_validation|permission_workspace_identity_observation|permission_workspace_identity_final_validation|acl_probe:(?:initial|final)|acl_sid_probe:(?:initial|final)):(.+)$/u.exec(key);
        if (!match) { add(key, count); continue; }
        const [, operation, file] = match;
        if (scope.has(normalizedPath(file))) { add(operation + ':scope', count); continue; }
        if (operation.startsWith('timeline_')) {
            const current = path.basename(file) === state.taskId + '.jsonl';
            add(operation + (current ? ':task' : ':other'), count);
            continue;
        }
        const relative = path.relative(state.repoRoot, file).replace(/\\/gu, '/');
        const stableClass = relative.replaceAll(state.taskId, '<task>')
            .replace(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/giu, '<id>')
            .replace(/[a-f0-9]{64}/giu, '<sha>')
            .replace(/(\.lock\.(?:release-intent\.clearing|releasing))-\d+-\d+-<id>/gu, '$1-<pid>-<time>-<id>');
        const cycle = cycles.get(normalizedPath(file));
        const age = cycle !== undefined || oldArtifacts.has(normalizedPath(file)) ? 'closed' : 'current';
        add(operation + ':' + age + ':' + stableClass, count);
        if (operation.startsWith('artifact_') || operation === 'payload_read') {
            artifactsByPath[operation + ':' + relative] = count;
            const cycleKey = operation + ':cycle-' + (cycle ?? 'current') + ':' + stableClass;
            artifactsByCycle[cycleKey] = (artifactsByCycle[cycleKey] || 0) + count;
        }
    }
    counters.json_parse_outside_verified_timeline = (counters.json_parse_total || 0) - (counters.json_parse_verified_timeline_event || 0);
    delete counters.json_parse_total;
    delete counters.json_parse_verified_timeline_event;
    const stableOutput = { ...result, generated_utc: '<generated>' };
    const sha = (text: string) => createHash('sha256').update(text).digest('hex');
    return { route, outputJsonSha256: sha(JSON.stringify(stableOutput)), outputTextSha256: sha(formatNextStepText(stableOutput)), nextGate: result.next_gate, reason: result.reason, status: result.status, auditStatus: result.audit_status,
        elapsedMs, phasesMs: measured.phases_ms, counters: Object.fromEntries(Object.entries(counters).sort()), artifactsByPath, artifactsByCycle };
}

export function comparableHistoryCounters(measurement: HistoryRouteMeasurement): Record<string, number> {
    // Full timeline integrity still consumes all bytes/events exactly once.
    return Object.fromEntries(Object.entries(measurement.counters)
        .filter(([key]) => key !== 'timeline_bytes' && key !== 'timeline_events'));
}


/** Permanent guard for redundant native artifact acquisition, independent of mandatory input byte sizes. */
export function assertStableAuthenticatedArtifactWork(short: HistoryRouteMeasurement, long: HistoryRouteMeasurement): void {
    const a = short.counters, b = long.counters;
    for (const counter of new Set([...Object.keys(a), ...Object.keys(b)])) {
        if (/^(artifact_bytes|artifact_json_parse):/u.test(counter)
            || /^payload_read:.*(?:receipt|findings-validation|findings-disposition|remediation-baseline)/u.test(counter)) {
            assert.equal(b[counter] || 0, a[counter] || 0, long.route + ': redundant artifact work: ' + counter);
        }
    }
}
