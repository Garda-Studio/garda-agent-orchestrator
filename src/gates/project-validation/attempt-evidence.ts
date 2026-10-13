import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { readStagedBlobFingerprints } from '../../core/staged-index-fingerprints';
import { bindContainedDestination, writeContainedFile } from '../../core/contained-filesystem';
import { readValidationFile, validationDigest } from '../../core/project-validation-identity';
import { readTaskQueueEntries } from '../../core/task-queue-read';
import { readTaskQueueStatusToken } from '../../core/task-queue/task-queue-status';
import { inspectTaskEventFile } from '../../gate-runtime/task-events';
import { appendTaskEventAsync } from '../../gate-runtime/task-events-io';
import { resolveCurrentNoOpPreflightPath as resolveNativePreflightPath } from '../task-mode/no-op';
import { pathListSha256 } from '../shared/canonical-path-list';
import { buildScopeContentFingerprint } from '../compile/compile-gate';
import { validationPaths } from './authority';

const MAXIMUM_CONTROL_BYTES = 8 * 1024 * 1024;
const MAXIMUM_EVENTS = 10_000;
type ValidationEvent = { event_type: string; details?: Record<string, unknown> };
export type ValidationEvidenceInspection = 'active' | 'retained_completed';

function classifiedContentFingerprint(repoRoot: string, source: string, files: string[]): string | null {
    const staged = ['git_staged_only', 'git_staged_plus_untracked'].includes(source)
        ? readStagedBlobFingerprints(repoRoot, files) : undefined;
    if (staged) for (const [relative, fingerprint] of staged) {
        const blob = /^staged:(?:100644|100755):([0-9a-f]{40}|[0-9a-f]{64})$/u.exec(fingerprint)?.[1];
        if (!blob) throw new Error('Validation staged scope must contain ordinary files');
        const { bytes } = readValidationFile(repoRoot, relative);
        const actual = createHash(blob.length === 40 ? 'sha1' : 'sha256')
            .update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
        if (actual !== blob) throw new Error('Validation preflight staged scope differs from executable worktree bytes');
    }
    return buildScopeContentFingerprint(repoRoot, source, files, staged);
}

export function readValidationEvents(repoRoot: string, taskId: string,
    inspection: ValidationEvidenceInspection = 'active'): ValidationEvent[] {
    const paths = validationPaths(repoRoot, taskId);
    const status = readTaskQueueStatusToken(readTaskQueueEntries(repoRoot).get(taskId)?.status ?? null);
    if (inspection === 'retained_completed') {
        if (status !== 'DONE') throw new Error('Retained validation inspection requires a completed native task');
    } else if (inspection !== 'active' || (status !== 'IN_PROGRESS' && status !== 'IN_REVIEW')) {
        throw new Error('Validation requires an active native task');
    }
    const preflightPath = resolveNativePreflightPath(repoRoot, taskId);
    const timeline = readValidationFile(repoRoot, paths.timeline, MAXIMUM_CONTROL_BYTES);
    const eventInspection = inspectTaskEventFile(path.join(repoRoot, paths.timeline), taskId);
    if (!['PASS', 'PASS_WITH_LEGACY_PREFIX'].includes(eventInspection.status)) throw new Error('Validation timeline integrity failed');
    const lines = timeline.bytes.toString('utf8').split(/\r?\n/u).filter(Boolean);
    if (lines.length > MAXIMUM_EVENTS) throw new Error('Validation timeline exceeds event bound');
    const events = lines.map(line => JSON.parse(line) as ValidationEvent);
    if (inspection === 'retained_completed') {
        const cycleStart = Math.max(events.map(event => event.event_type).lastIndexOf('TASK_MODE_ENTERED'),
            events.map(event => event.event_type).lastIndexOf('PREFLIGHT_CLASSIFIED'));
        const completions = events.slice(cycleStart + 1).filter(event => event.event_type === 'COMPLETION_GATE_PASSED');
        const completion = completions[0]?.details;
        if (cycleStart < 0 || completions.length !== 1 || completion?.status !== 'PASSED' || completion.outcome !== 'PASS'
            || typeof completion.preflight_path !== 'string' || path.resolve(completion.preflight_path) !== path.resolve(preflightPath))
            throw new Error('Retained validation inspection lacks current canonical completion binding');
    }
    const classified = events.filter(event => event.event_type === 'PREFLIGHT_CLASSIFIED').at(-1)?.details;
    const preflight = JSON.parse(readValidationFile(repoRoot,
        path.relative(path.resolve(repoRoot), preflightPath).replace(/\\/gu, '/'), MAXIMUM_CONTROL_BYTES).bytes.toString('utf8')) as Record<string, unknown>;
    const metrics = preflight.metrics as Record<string, unknown> | undefined;
    if (preflight.task_id !== taskId || !Array.isArray(preflight.changed_files) || !metrics || !classified
        || metrics.scope_sha256 !== classified.scope_sha256 || metrics.scope_content_sha256 !== classified.scope_content_sha256
        || metrics.changed_files_sha256 !== pathListSha256(preflight.changed_files as string[])
        || classifiedContentFingerprint(repoRoot, String(preflight.detection_source), preflight.changed_files as string[]) !== classified.scope_content_sha256)
        throw new Error('Validation preflight scope binding changed');
    if (readValidationFile(repoRoot, paths.timeline, MAXIMUM_CONTROL_BYTES).identity.sha256 !== timeline.identity.sha256) throw new Error('Validation timeline changed during inspection');
    return events;
}

export async function recordValidationEvent(repoRoot: string, taskId: string, type: string, details: Record<string, unknown>): Promise<void> {
    const receipt = await appendTaskEventAsync(path.join(repoRoot, validationPaths(repoRoot, taskId).bundle), taskId, type, 'INFO',
        'Project validation execution facts.', details, { actor: 'gate', passThru: true });
    if (!receipt?.canonical_committed) throw new Error('Validation event was not canonically persisted');
}

export function writeValidationFact(repoRoot: string, relative: string, content: string): string {
    const target = path.join(repoRoot, relative);
    if (!bindContainedDestination(repoRoot, target).missingAt) throw new Error('Validation facts must not overwrite an existing artifact');
    writeContainedFile(repoRoot, target, content);
    const digest = validationDigest(content);
    if (readValidationFile(repoRoot, relative).identity.sha256 !== digest) throw new Error('Retained validation fact changed during publication');
    return digest;
}
