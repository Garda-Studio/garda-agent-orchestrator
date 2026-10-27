import { readTaskTimelineValidationJsonLinesCompatible } from '../../gate-runtime/timeline/task-events-helpers';
import { verifiedIndexForEvents, verifiedEventPosition } from '../../gate-runtime/timeline/task-verified-event-index';
import { isInvocationReadObservationActive } from '../../core/invocation-read-observation';
import { cloneJson } from '../../core/immutable-json';
import { readInvocationVerifiedEventIndex, readTaskTimelineValidationQuery } from '../../gate-runtime/timeline/task-events-integrity';
import { beginValidationTimelineQueryPass, type ValidationTimelineQuery } from '../../gate-runtime/timeline/validation-timeline-query';
import { countNextStepWork } from '../../core/next-step-measurement';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { runGit, runGitBinary } from '../../core/git-helpers';
import { splitNulRecords } from '../../core/git-path-output';
import { DEFAULT_GIT_TIMEOUT_MS } from '../../core/subprocess';
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
import { freezeValidationRecipe, validationPaths } from './authority';
import type { FrozenValidationRecipe } from '../../core/project-validation-contract';

const MAXIMUM_CONTROL_BYTES = 8 * 1024 * 1024;
const MAXIMUM_EVENTS = 10_000;
const MAXIMUM_GIT_EOL_PATHSPEC_CHARS = 16_000;
interface GitEolMetadata { index: string; worktree: string; attributes: string }
type ValidationEvent = { event_type: string; details?: Record<string, unknown>; integrity?: { task_sequence?: number } };
export type ValidationEvidenceInspection = 'active' | 'retained_completed';

/** Results may be evaluated late; execution recency is established by native START order. */
export function latestValidationRecipeAttempt<T extends ValidationEvent>(events: readonly T[], recipeId: string): T | undefined {
    const indexed = verifiedIndexForEvents(events);
    let mode = indexed?.lastIndexByType.TASK_MODE_ENTERED ?? -1;
    if (!indexed) for (let i = events.length - 1; i >= 0; i--) {
        countNextStepWork('visit:validation_timeline_query_event');
        if (events[i].event_type === 'TASK_MODE_ENTERED') { mode = i; break; }
    }
    const cycle = events.slice(mode + 1).reverse();
    const started = cycle.find(event => event.event_type === 'PROJECT_VALIDATION_STARTED'
        && event.details?.recipe_id === recipeId);
    return started && cycle.find(event => event.details?.recipe_id === recipeId
        && event.details?.attempt_id === started.details?.attempt_id
        && ['PROJECT_VALIDATION_STARTED', 'PROJECT_VALIDATION_COMPLETED', 'PROJECT_VALIDATION_RESULTS_EVALUATED'].includes(event.event_type));
}

declare const batchIdentity: unique symbol;
export type ValidationEvidenceBatch = { readonly [batchIdentity]: true };
interface ValidationEvidenceBatchState {
    repoRoot: string; taskId: string; inspection: ValidationEvidenceInspection;
    events: ValidationEvent[] | null; current: CurrentValidationSnapshot; recipes: Map<string, FrozenValidationRecipe>;
}
const activeBatches = new WeakMap<ValidationEvidenceBatch, ValidationEvidenceBatchState>();

function readBatchState(repoRoot: string, taskId: string, inspection: ValidationEvidenceInspection,
    batch: ValidationEvidenceBatch): ValidationEvidenceBatchState {
    const state = activeBatches.get(batch);
    if (!state || state.repoRoot !== path.resolve(repoRoot) || state.taskId !== taskId || state.inspection !== inspection)
        throw new Error('Validation evidence batch is inactive or belongs to another task inspection');
    return state;
}

export function readValidationRecipeSnapshot(repoRoot: string, taskId: string, recipeId: string,
    inspection: ValidationEvidenceInspection = 'active', batch?: ValidationEvidenceBatch): FrozenValidationRecipe {
    if (!batch) return freezeValidationRecipe(repoRoot, taskId, recipeId);
    const recipe = readBatchState(repoRoot, taskId, inspection, batch).recipes.get(recipeId);
    if (!recipe) throw new Error('Recipe is outside the current validation evidence batch');
    return recipe;
}

export function withValidationEvidenceBatch<T>(options: {
    repoRoot: string; taskId: string; recipeIds: readonly string[]; inspection?: ValidationEvidenceInspection;
}, inspect: (batch: ValidationEvidenceBatch) => T): T {
    const { repoRoot, taskId } = options, inspection = options.inspection ?? 'active';
    const active = isInvocationReadObservationActive();
    const observation = active ? readCurrentValidationSnapshot(repoRoot, taskId, inspection)
        : readValidationEventSnapshot(repoRoot, taskId, inspection);
    const observationSha256 = validationDigest(observation);
    const recipes = new Map(options.recipeIds.map(id => [id, freezeValidationRecipe(repoRoot, taskId, id)]));
    const recipeHashes = new Map([...recipes].map(([id, recipe]) => [id, recipe.snapshot_sha256]));
    const batch = Object.freeze({}) as ValidationEvidenceBatch;
    activeBatches.set(batch, { repoRoot: path.resolve(repoRoot), taskId, inspection,
        events: 'events' in observation ? observation.events : null,
        current: 'query' in observation ? observation : compactLegacyValidationSnapshot(observation), recipes });
    try {
        const result = inspect(batch);
        if (result && typeof (result as { then?: unknown }).then === 'function')
            throw new Error('Validation evidence batch requires synchronous read-only inspection');
        for (const [id, hash] of recipeHashes) {
            if (freezeValidationRecipe(repoRoot, taskId, id).snapshot_sha256 !== hash)
                throw new Error('Validation recipe or source identities changed during batch inspection');
        }
        if (validationDigest(active ? readCurrentValidationSnapshot(repoRoot, taskId, inspection)
            : readValidationEventSnapshot(repoRoot, taskId, inspection)) !== observationSha256)
            throw new Error('Validation timeline or scope changed during batch inspection');
        return result;
    } finally { activeBatches.delete(batch); }
}

function gitEolPathspecBatches(files: string[]): string[][] {
    const batches: string[][] = [];
    let batch: string[] = [], characters = 0;
    for (const file of files) {
        const pathspec = `:(literal)${file}`;
        // Reserve worst-case Windows quoting plus headroom for executable, -C and fixed arguments.
        const cost = pathspec.length * 2 + 3;
        if (cost > MAXIMUM_GIT_EOL_PATHSPEC_CHARS) throw new Error('Staged Git EOL path exceeds the argument bound');
        if (characters + cost > MAXIMUM_GIT_EOL_PATHSPEC_CHARS) {
            batches.push(batch); batch = []; characters = 0;
        }
        batch.push(pathspec); characters += cost;
    }
    if (batch.length) batches.push(batch);
    return batches;
}

function readGitEolMetadata(repoRoot: string, files: string[]): Map<string, GitEolMetadata> {
    const metadata = new Map<string, GitEolMetadata>();
    for (const pathspecs of gitEolPathspecBatches(files)) {
        const wanted = new Set(pathspecs.map(spec => spec.slice(':(literal)'.length)));
        // --eol reports Git's text/binary heuristic and resolved attributes without running filters.
        const records = splitNulRecords(runGitBinary(repoRoot, ['ls-files', '--eol', '-z', '--', ...pathspecs], {
            timeoutMs: DEFAULT_GIT_TIMEOUT_MS
        }));
        for (const record of records) {
            const eol = /^i\/(\S+)\s+w\/(\S+)\s+attr\/([^\t]*)\t([\s\S]+)$/u.exec(record);
            if (!eol || !wanted.delete(eol[4]) || metadata.has(eol[4]))
                throw new Error('Cannot authenticate staged Git EOL metadata');
            metadata.set(eol[4], { index: eol[1], worktree: eol[2], attributes: eol[3].trim() });
        }
        if (wanted.size) throw new Error('Cannot authenticate staged Git EOL metadata');
    }
    return metadata;
}

function gitEolNormalizedBytes(bytes: Buffer, metadata: GitEolMetadata, autocrlf: string): Buffer {
    const { index: indexEol, worktree: worktreeEol, attributes } = metadata;
    if (attributes === '-text') return bytes;
    const automatic = attributes.startsWith('text=auto') || (!attributes && ['true', 'input'].includes(autocrlf));
    if (!automatic && !/^text(?: eol=(?:lf|crlf))?$/u.test(attributes)) return bytes;
    if (automatic && (worktreeEol === '-text' || ['crlf', 'mixed'].includes(indexEol))) return bytes;
    const normalized = Buffer.allocUnsafe(bytes.length);
    let length = 0;
    for (let index = 0; index < bytes.length; index++) {
        if (bytes[index] === 13 && bytes[index + 1] === 10) continue;
        normalized[length++] = bytes[index];
    }
    return normalized.subarray(0, length);
}

function gitBlobHash(bytes: Buffer, objectId: string): string {
    return createHash(objectId.length === 40 ? 'sha1' : 'sha256')
        .update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

export function classifiedContentFingerprint(repoRoot: string, source: string, files: string[]): string | null {
    const staged = ['git_staged_only', 'git_staged_plus_untracked'].includes(source)
        ? readStagedBlobFingerprints(repoRoot, files) : undefined;
    if (staged) validateStagedWorktreeBytes(repoRoot, staged);
    return buildScopeContentFingerprint(repoRoot, source, files, staged);
}

function validateStagedWorktreeBytes(repoRoot: string, staged: ReadonlyMap<string, string>): void {
    const mismatched = new Map<string, string>();
    for (const [relative, fingerprint] of staged) {
        const blob = /^staged:(?:100644|100755):([0-9a-f]{40}|[0-9a-f]{64})$/u.exec(fingerprint)?.[1];
        if (!blob) throw new Error('Validation staged scope must contain ordinary files');
        const { bytes } = readValidationFile(repoRoot, relative);
        if (gitBlobHash(bytes, blob) !== blob) mismatched.set(relative, blob);
    }
    if (!mismatched.size) return;
    const metadata = readGitEolMetadata(repoRoot, [...mismatched.keys()]);
    const autocrlf = [...metadata.values()].some(eol => !eol.attributes)
        ? runGit(repoRoot, ['config', '--type=bool-or-str', '--get', 'core.autocrlf'], {
            timeoutMs: DEFAULT_GIT_TIMEOUT_MS, allowFailure: true, allowedFailureExitCodes: [1]
        }).trim().toLowerCase() : '';
    for (const [relative, blob] of mismatched) {
        // Re-read one file at a time rather than retaining the entire scoped worktree in memory.
        const { bytes } = readValidationFile(repoRoot, relative);
        if (gitBlobHash(bytes, blob) !== blob && gitBlobHash(gitEolNormalizedBytes(bytes, metadata.get(relative)!, autocrlf), blob) !== blob)
            throw new Error('Validation preflight staged scope differs from executable worktree bytes');
    }
}

export function readValidationEventSnapshot(repoRoot: string, taskId: string,
    inspection: ValidationEvidenceInspection = 'active') {
    const snapshot = readImmutableValidationEventSnapshot(repoRoot, taskId, inspection);
    return { ...snapshot, events: cloneJson(snapshot.events) as ValidationEvent[] };
}

/** Internal immutable evidence; callers that mutate must use the public snapshot above. */
export function readImmutableValidationEventSnapshot(repoRoot: string, taskId: string,
    inspection: ValidationEvidenceInspection = 'active'): {
        events: ValidationEvent[]; preflight_path: string; preflight_sha256: string; scope_content_sha256: string;
        preflight_sequence: number; timeline_sha256: string; changed_files: string[];
    } {
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
    const timelinePath = path.join(repoRoot, paths.timeline);
    const captured = readInvocationVerifiedEventIndex(timelinePath, taskId);
    // Whitespace-only rows differ in validation JSONL; retain the exact native rejection.
    const indexed = captured && readTaskTimelineValidationJsonLinesCompatible(timelinePath) ? captured : null;
    const events: ValidationEvent[] = indexed ? indexed.events as ValidationEvent[] : (() => {
        const lines = timeline.bytes.toString('utf8').split(/\r?\n/u).filter(Boolean);
        if (lines.length > MAXIMUM_EVENTS) throw new Error('Validation timeline exceeds event bound');
        countNextStepWork('validation_timeline_parse');
        return lines.map(line => { countNextStepWork('visit:validation_timeline_parse_event'); return JSON.parse(line) as ValidationEvent; });
    })();
    if (events.length > MAXIMUM_EVENTS) throw new Error('Validation timeline exceeds event bound');
    const lastType = (type: string): number => {
        if (indexed) return indexed.lastIndexByType[type] ?? -1;
        for (let i = events.length - 1; i >= 0; i--) {
            countNextStepWork('visit:validation_timeline_query_event');
            if (events[i].event_type === type) return i;
        }
        return -1;
    };
    const modeIndex = lastType('TASK_MODE_ENTERED');
    const classifiedIndex = lastType('PREFLIGHT_CLASSIFIED');
    const classifiedEvent = events[classifiedIndex];
    const preflightSequence = classifiedEvent?.integrity?.task_sequence;
    if (modeIndex < 0 || classifiedIndex <= modeIndex || !Number.isSafeInteger(preflightSequence) || Number(preflightSequence) < 1)
        throw new Error('Validation requires the current task-mode canonical preflight');
    if (inspection === 'retained_completed') {
        const cycleStart = Math.max(modeIndex, classifiedIndex);
        const completions = indexed
            ? ((indexed.byType.COMPLETION_GATE_PASSED ?? []) as readonly ValidationEvent[]).filter(event =>
                event.event_type === 'COMPLETION_GATE_PASSED' && verifiedEventPosition(event)! > cycleStart)
            : events.slice(cycleStart + 1).filter(event => event.event_type === 'COMPLETION_GATE_PASSED');
        const completion = completions[0]?.details;
        if (cycleStart < 0 || completions.length !== 1 || completion?.status !== 'PASSED' || completion.outcome !== 'PASS'
            || typeof completion.preflight_path !== 'string' || path.resolve(completion.preflight_path) !== path.resolve(preflightPath))
            throw new Error('Retained validation inspection lacks current canonical completion binding');
    }
    const classified = classifiedEvent.details;
    const preflightRelative = path.relative(path.resolve(repoRoot), preflightPath).replace(/\\/gu, '/');
    const retainedPreflight = readValidationFile(repoRoot, preflightRelative, MAXIMUM_CONTROL_BYTES);
    const preflight = JSON.parse(retainedPreflight.bytes.toString('utf8')) as Record<string, unknown>;
    const metrics = preflight.metrics as Record<string, unknown> | undefined;
    if (preflight.task_id !== taskId || !Array.isArray(preflight.changed_files) || !metrics || !classified
        || metrics.scope_sha256 !== classified.scope_sha256 || metrics.scope_content_sha256 !== classified.scope_content_sha256
        || metrics.changed_files_sha256 !== pathListSha256(preflight.changed_files as string[]))
        throw new Error('Validation preflight scope binding changed');
    const contentFingerprint = classifiedContentFingerprint(repoRoot, String(preflight.detection_source), preflight.changed_files as string[]);
    if (!contentFingerprint || contentFingerprint !== classified.scope_content_sha256)
        throw new Error('Validation preflight scope binding changed');
    if (readValidationFile(repoRoot, paths.timeline, MAXIMUM_CONTROL_BYTES).identity.sha256 !== timeline.identity.sha256) throw new Error('Validation timeline changed during inspection');
    if (readValidationFile(repoRoot, preflightRelative, MAXIMUM_CONTROL_BYTES).identity.sha256 !== retainedPreflight.identity.sha256)
        throw new Error('Validation preflight changed during inspection');
    return { events, preflight_path: preflightPath, preflight_sha256: retainedPreflight.identity.sha256,
        changed_files: preflight.changed_files as string[],
        scope_content_sha256: contentFingerprint, preflight_sequence: Number(preflightSequence),
        timeline_sha256: timeline.identity.sha256 };
}

export type CurrentValidationSnapshot = Omit<ReturnType<typeof readValidationEventSnapshot>, 'events'>
    & { query: ValidationTimelineQuery };

function compactLegacyValidationSnapshot(snapshot: ReturnType<typeof readValidationEventSnapshot>): CurrentValidationSnapshot {
    const { events, ...metadata } = snapshot;
    const pass = beginValidationTimelineQueryPass();
    events.forEach((event, ordinal) => {
        countNextStepWork('visit:validation_legacy_projection_event'); pass.accept(event as Record<string, unknown>, ordinal);
    });
    return { ...metadata, query: pass.finish(true)! };
}

/** Internal compact path: public full-history arrays retain their original contract. */
export function readCurrentValidationSnapshot(repoRoot: string, taskId: string,
    inspection: ValidationEvidenceInspection = 'active'): CurrentValidationSnapshot {
    const legacy = (): CurrentValidationSnapshot => compactLegacyValidationSnapshot(readValidationEventSnapshot(repoRoot, taskId, inspection));
    if (!isInvocationReadObservationActive()) return legacy();
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
    const projected = readTaskTimelineValidationQuery(path.join(repoRoot, paths.timeline), taskId, true);
    if (!projected) return legacy();
    if (projected.sha256 !== timeline.identity.sha256) throw new Error('Validation timeline changed during inspection');
    const query = projected.query;
    if (query.eventCount > MAXIMUM_EVENTS) throw new Error('Validation timeline exceeds event bound');
    const { modeIndex, classifiedIndex, classifiedEvent } = query;
    const preflightSequence = (classifiedEvent?.integrity as Record<string, unknown> | undefined)?.task_sequence;
    if (modeIndex < 0 || classifiedIndex <= modeIndex || !Number.isSafeInteger(preflightSequence) || Number(preflightSequence) < 1)
        throw new Error('Validation requires the current task-mode canonical preflight');
    if (inspection === 'retained_completed') {
        const completion = query.firstCompletion?.details as Record<string, unknown> | undefined;
        if (query.completionCount !== 1 || completion?.status !== 'PASSED' || completion.outcome !== 'PASS'
            || typeof completion.preflight_path !== 'string' || path.resolve(completion.preflight_path) !== path.resolve(preflightPath))
            throw new Error('Retained validation inspection lacks current canonical completion binding');
    }
    const classified = classifiedEvent!.details as Record<string, unknown> | undefined;
    const preflightRelative = path.relative(path.resolve(repoRoot), preflightPath).replace(/\\/gu, '/');
    const retainedPreflight = readValidationFile(repoRoot, preflightRelative, MAXIMUM_CONTROL_BYTES);
    const preflight = JSON.parse(retainedPreflight.bytes.toString('utf8')) as Record<string, unknown>;
    const metrics = preflight.metrics as Record<string, unknown> | undefined;
    if (preflight.task_id !== taskId || !Array.isArray(preflight.changed_files) || !metrics || !classified
        || metrics.scope_sha256 !== classified.scope_sha256 || metrics.scope_content_sha256 !== classified.scope_content_sha256
        || metrics.changed_files_sha256 !== pathListSha256(preflight.changed_files as string[]))
        throw new Error('Validation preflight scope binding changed');
    const contentFingerprint = classifiedContentFingerprint(repoRoot, String(preflight.detection_source), preflight.changed_files as string[]);
    if (!contentFingerprint || contentFingerprint !== classified.scope_content_sha256)
        throw new Error('Validation preflight scope binding changed');
    if (readValidationFile(repoRoot, paths.timeline, MAXIMUM_CONTROL_BYTES).identity.sha256 !== timeline.identity.sha256) throw new Error('Validation timeline changed during inspection');
    if (readValidationFile(repoRoot, preflightRelative, MAXIMUM_CONTROL_BYTES).identity.sha256 !== retainedPreflight.identity.sha256)
        throw new Error('Validation preflight changed during inspection');
    return { query, preflight_path: preflightPath, preflight_sha256: retainedPreflight.identity.sha256,
        changed_files: preflight.changed_files as string[],
        scope_content_sha256: contentFingerprint, preflight_sequence: Number(preflightSequence),
        timeline_sha256: timeline.identity.sha256 };
}

export function readValidationEvents(repoRoot: string, taskId: string,
    inspection: ValidationEvidenceInspection = 'active', batch?: ValidationEvidenceBatch): ValidationEvent[] {
    if (batch) {
        const state = readBatchState(repoRoot, taskId, inspection, batch);
        state.events ??= readValidationEventSnapshot(repoRoot, taskId, inspection).events;
        return state.events;
    }
    return readValidationEventSnapshot(repoRoot, taskId, inspection).events;
}

/** Same selection semantics as latestValidationRecipeAttempt, without a history array. */
export function readLatestValidationRecipeAttempt(repoRoot: string, taskId: string, recipeId: string,
    inspection: ValidationEvidenceInspection = 'active', batch?: ValidationEvidenceBatch,
    afterClassification = false): ValidationEvent | undefined {
    const query = batch ? readBatchState(repoRoot, taskId, inspection, batch).current.query
        : readCurrentValidationSnapshot(repoRoot, taskId, inspection).query;
    if (!query.recipeQueryCompatible) {
        const events = readValidationEvents(repoRoot, taskId, inspection, batch);
        const start = afterClassification ? Math.max(query.modeIndex, query.classifiedIndex) : -1;
        return latestValidationRecipeAttempt(start >= 0 ? events.slice(start + 1) : events, recipeId);
    }
    const event = (afterClassification ? query.recipeAttemptsAfterClassification : query.recipeAttemptsAfterMode)[recipeId];
    return event ? cloneJson(event) as ValidationEvent : undefined;
}

export function readCurrentValidationSnapshotInBatch(repoRoot: string, taskId: string,
    inspection: ValidationEvidenceInspection = 'active', batch?: ValidationEvidenceBatch): CurrentValidationSnapshot {
    return batch ? readBatchState(repoRoot, taskId, inspection, batch).current
        : readCurrentValidationSnapshot(repoRoot, taskId, inspection);
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
