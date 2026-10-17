import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { writeFileAtomically } from '../core/filesystem';
import {
    captureRuntimeMutationOwnerIdentity,
    createRuntimeMutationOwnerProbe,
    parseRuntimeMutationOwnerIdentity,
    type RuntimeMutationOwnerIdentity
} from './runtime-mutation-owner';
import { withFilesystemLock } from './timeline/task-events-locking';

const JOURNAL_DIRECTORY_NAME = '.runtime-mutation-generation';
const JOURNAL_LOCK_NAME = '.runtime-mutation-generation.lock';
const JOURNAL_ANCHOR_NAME = '.runtime-mutation-generation.anchor.json';
const HEAD_FILE_NAME = 'head.json';
const SLOT_FILE_NAMES = {
    a: 'state-a.json',
    b: 'state-b.json'
} as const;
const JOURNAL_SCHEMA_VERSION = 1;
const MAX_JOURNAL_FILE_BYTES = 1024 * 1024;
const MAX_ACTIVE_MUTATIONS = 4096;

type RuntimeMutationGenerationSlot = keyof typeof SLOT_FILE_NAMES;
type RuntimeMutationTransitionType = 'INITIALIZE' | 'BEGIN' | 'COMMIT' | 'ABORT';

interface RuntimeMutationIntent {
    mutation_id: string;
    mutation_kind: string;
    started_at_utc: string;
    owner?: RuntimeMutationOwnerIdentity | null;
}

interface RuntimeMutationTransition {
    type: RuntimeMutationTransitionType;
    mutation_id: string | null;
    mutation_kind: string | null;
}

interface RuntimeMutationGenerationState {
    schema_version: 1;
    transition_sequence: number;
    generation: number;
    active_mutations: RuntimeMutationIntent[];
    transitioned_at_utc: string;
    transition: RuntimeMutationTransition;
    previous_state_sha256: string | null;
    state_sha256: string;
}

interface RuntimeMutationGenerationHead {
    schema_version: 1;
    active_slot: RuntimeMutationGenerationSlot;
    transition_sequence: number;
    state_sha256: string;
    head_sha256: string;
}

interface RuntimeMutationGenerationAnchor {
    schema_version: 1;
    transition_sequence: number;
    generation: number;
    state_sha256: string;
    head_sha256: string;
    anchor_sha256: string;
}

interface RuntimeMutationGenerationPaths {
    runtimeRoot: string;
    journalDirectory: string;
    lockPath: string;
    anchorPath: string;
    headPath: string;
    slotPaths: Record<RuntimeMutationGenerationSlot, string>;
}

export interface RuntimeMutationGenerationTicket {
    orchestrator_root: string;
    mutation_id: string;
    mutation_kind: string;
}

export interface RuntimeMutationGenerationSnapshot {
    schema_version: 1;
    generation: number;
    transition_sequence: number;
    state_sha256: string;
}

export class RuntimeMutationGenerationError extends Error {
    readonly code: 'MISSING' | 'CORRUPT' | 'BUSY';

    constructor(code: RuntimeMutationGenerationError['code'], message: string) {
        super(message);
        this.name = 'RuntimeMutationGenerationError';
        this.code = code;
    }
}

function sha256(value: string): string {
    return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertExactKeys(value: Record<string, unknown>, expectedKeys: readonly string[], subject: string): void {
    const actualKeys = Object.keys(value).sort();
    const normalizedExpected = [...expectedKeys].sort();
    if (JSON.stringify(actualKeys) !== JSON.stringify(normalizedExpected)) {
        throw new RuntimeMutationGenerationError('CORRUPT', `${subject} has an unexpected shape.`);
    }
}

function assertNonNegativeSafeInteger(value: unknown, subject: string): asserts value is number {
    if (!Number.isSafeInteger(value) || Number(value) < 0) {
        throw new RuntimeMutationGenerationError('CORRUPT', `${subject} must be a non-negative safe integer.`);
    }
}

function assertSha256OrNull(value: unknown, subject: string): asserts value is string | null {
    if (value !== null && (typeof value !== 'string' || !/^[0-9a-f]{64}$/u.test(value))) {
        throw new RuntimeMutationGenerationError('CORRUPT', `${subject} must be null or a lowercase SHA-256 digest.`);
    }
}

function assertNonEmptyString(value: unknown, subject: string): asserts value is string {
    if (typeof value !== 'string' || value.trim() === '') {
        throw new RuntimeMutationGenerationError('CORRUPT', `${subject} must be a non-empty string.`);
    }
}

function getRuntimeMutationGenerationPaths(orchestratorRoot: string): RuntimeMutationGenerationPaths {
    const resolvedOrchestratorRoot = path.resolve(orchestratorRoot);
    const runtimeRoot = path.join(resolvedOrchestratorRoot, 'runtime');
    const journalDirectory = path.join(runtimeRoot, JOURNAL_DIRECTORY_NAME);
    return {
        runtimeRoot,
        journalDirectory,
        lockPath: path.join(runtimeRoot, JOURNAL_LOCK_NAME),
        anchorPath: path.join(runtimeRoot, JOURNAL_ANCHOR_NAME),
        headPath: path.join(journalDirectory, HEAD_FILE_NAME),
        slotPaths: {
            a: path.join(journalDirectory, SLOT_FILE_NAMES.a),
            b: path.join(journalDirectory, SLOT_FILE_NAMES.b)
        }
    };
}

function pathSegmentEquals(left: string, right: string): boolean {
    return process.platform === 'win32'
        ? left.toLowerCase() === right.toLowerCase()
        : left === right;
}

export function resolveOrchestratorRootFromRuntimePath(
    targetPath: string,
    runtimeSubtreeName: string
): string | null {
    const expectedSubtree = runtimeSubtreeName.trim();
    if (!expectedSubtree || expectedSubtree.includes('/') || expectedSubtree.includes('\\')) {
        throw new Error('runtimeSubtreeName must be one path segment.');
    }

    let cursor = path.dirname(path.resolve(targetPath));
    while (true) {
        const parent = path.dirname(cursor);
        if (
            pathSegmentEquals(path.basename(cursor), expectedSubtree)
            && pathSegmentEquals(path.basename(parent), 'runtime')
        ) {
            return path.dirname(parent);
        }
        if (parent === cursor) {
            return null;
        }
        cursor = parent;
    }
}

function assertJournalDirectory(journalDirectory: string, allowMissing: boolean): void {
    let stat: fs.Stats;
    try {
        stat = fs.lstatSync(journalDirectory);
    } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT' && allowMissing) {
            return;
        }
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            throw new RuntimeMutationGenerationError('MISSING', 'Runtime mutation generation journal is missing.');
        }
        throw error;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new RuntimeMutationGenerationError('CORRUPT', 'Runtime mutation generation journal directory must be a real directory.');
    }
}

function assertRegularJournalFile(filePath: string, allowMissing: boolean): fs.Stats | null {
    let stat: fs.Stats;
    try {
        stat = fs.lstatSync(filePath);
    } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT' && allowMissing) {
            return null;
        }
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            throw new RuntimeMutationGenerationError('MISSING', `Runtime mutation generation file '${path.basename(filePath)}' is missing.`);
        }
        throw error;
    }
    if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new RuntimeMutationGenerationError('CORRUPT', `Runtime mutation generation file '${path.basename(filePath)}' must be a regular file.`);
    }
    if (stat.size > MAX_JOURNAL_FILE_BYTES) {
        throw new RuntimeMutationGenerationError('CORRUPT', `Runtime mutation generation file '${path.basename(filePath)}' is too large.`);
    }
    return stat;
}

function readJsonRecord(filePath: string): Record<string, unknown> {
    assertRegularJournalFile(filePath, false);
    try {
        const value: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (!isRecord(value)) {
            throw new Error('expected a JSON object');
        }
        return value;
    } catch (error: unknown) {
        if (error instanceof RuntimeMutationGenerationError) {
            throw error;
        }
        throw new RuntimeMutationGenerationError(
            'CORRUPT',
            `Runtime mutation generation file '${path.basename(filePath)}' is invalid JSON: ${error instanceof Error ? error.message : String(error)}`
        );
    }
}

function buildStateHash(state: Omit<RuntimeMutationGenerationState, 'state_sha256'>): string {
    return sha256(JSON.stringify(state));
}

function buildHeadHash(head: Omit<RuntimeMutationGenerationHead, 'head_sha256'>): string {
    return sha256(JSON.stringify(head));
}

function buildAnchorHash(anchor: Omit<RuntimeMutationGenerationAnchor, 'anchor_sha256'>): string {
    return sha256(JSON.stringify(anchor));
}

function parseMutationIntent(value: unknown, index: number): RuntimeMutationIntent {
    if (!isRecord(value)) {
        throw new RuntimeMutationGenerationError('CORRUPT', `active_mutations[${index}] must be an object.`);
    }
    const hasOwner = Object.prototype.hasOwnProperty.call(value, 'owner');
    assertExactKeys(value, ['mutation_id', 'mutation_kind', 'started_at_utc', ...(hasOwner ? ['owner'] : [])], `active_mutations[${index}]`);
    assertNonEmptyString(value.mutation_id, `active_mutations[${index}].mutation_id`);
    assertNonEmptyString(value.mutation_kind, `active_mutations[${index}].mutation_kind`);
    assertNonEmptyString(value.started_at_utc, `active_mutations[${index}].started_at_utc`);
    const parsed: RuntimeMutationIntent = {
        mutation_id: value.mutation_id,
        mutation_kind: value.mutation_kind,
        started_at_utc: value.started_at_utc
    };
    if (hasOwner) {
        try {
            parsed.owner = parseRuntimeMutationOwnerIdentity(value.owner);
        } catch (error: unknown) {
            throw new RuntimeMutationGenerationError('CORRUPT', `active_mutations[${index}].owner is invalid: ${String(error)}`);
        }
    }
    return parsed;
}

function parseTransition(value: unknown): RuntimeMutationTransition {
    if (!isRecord(value)) {
        throw new RuntimeMutationGenerationError('CORRUPT', 'transition must be an object.');
    }
    assertExactKeys(value, ['type', 'mutation_id', 'mutation_kind'], 'transition');
    if (!['INITIALIZE', 'BEGIN', 'COMMIT', 'ABORT'].includes(String(value.type))) {
        throw new RuntimeMutationGenerationError('CORRUPT', 'transition.type is invalid.');
    }
    if (value.mutation_id !== null) {
        assertNonEmptyString(value.mutation_id, 'transition.mutation_id');
    }
    if (value.mutation_kind !== null) {
        assertNonEmptyString(value.mutation_kind, 'transition.mutation_kind');
    }
    return {
        type: value.type as RuntimeMutationTransitionType,
        mutation_id: value.mutation_id,
        mutation_kind: value.mutation_kind
    };
}

function parseState(filePath: string): RuntimeMutationGenerationState {
    const value = readJsonRecord(filePath);
    assertExactKeys(value, [
        'schema_version',
        'transition_sequence',
        'generation',
        'active_mutations',
        'transitioned_at_utc',
        'transition',
        'previous_state_sha256',
        'state_sha256'
    ], path.basename(filePath));
    if (value.schema_version !== JOURNAL_SCHEMA_VERSION) {
        throw new RuntimeMutationGenerationError('CORRUPT', 'Runtime mutation generation state schema version is unsupported.');
    }
    assertNonNegativeSafeInteger(value.transition_sequence, 'transition_sequence');
    assertNonNegativeSafeInteger(value.generation, 'generation');
    if (!Array.isArray(value.active_mutations) || value.active_mutations.length > MAX_ACTIVE_MUTATIONS) {
        throw new RuntimeMutationGenerationError('CORRUPT', 'active_mutations must be a bounded array.');
    }
    assertNonEmptyString(value.transitioned_at_utc, 'transitioned_at_utc');
    assertSha256OrNull(value.previous_state_sha256, 'previous_state_sha256');
    assertSha256OrNull(value.state_sha256, 'state_sha256');
    if (value.state_sha256 === null) {
        throw new RuntimeMutationGenerationError('CORRUPT', 'state_sha256 cannot be null.');
    }
    const activeMutations = value.active_mutations.map(parseMutationIntent);
    const activeMutationIds = activeMutations.map((entry) => entry.mutation_id);
    if (new Set(activeMutationIds).size !== activeMutationIds.length) {
        throw new RuntimeMutationGenerationError('CORRUPT', 'active_mutations contains duplicate mutation IDs.');
    }
    if (JSON.stringify(activeMutationIds) !== JSON.stringify([...activeMutationIds].sort())) {
        throw new RuntimeMutationGenerationError('CORRUPT', 'active_mutations must be ordered by mutation ID.');
    }
    const parsed: RuntimeMutationGenerationState = {
        schema_version: 1,
        transition_sequence: value.transition_sequence,
        generation: value.generation,
        active_mutations: activeMutations,
        transitioned_at_utc: value.transitioned_at_utc,
        transition: parseTransition(value.transition),
        previous_state_sha256: value.previous_state_sha256,
        state_sha256: value.state_sha256
    };
    const { state_sha256: expectedHash, ...hashInput } = parsed;
    if (buildStateHash(hashInput) !== expectedHash) {
        throw new RuntimeMutationGenerationError('CORRUPT', 'Runtime mutation generation state integrity check failed.');
    }
    return parsed;
}

function parseHead(headPath: string): RuntimeMutationGenerationHead {
    const value = readJsonRecord(headPath);
    assertExactKeys(value, ['schema_version', 'active_slot', 'transition_sequence', 'state_sha256', 'head_sha256'], HEAD_FILE_NAME);
    if (value.schema_version !== JOURNAL_SCHEMA_VERSION || (value.active_slot !== 'a' && value.active_slot !== 'b')) {
        throw new RuntimeMutationGenerationError('CORRUPT', 'Runtime mutation generation head schema or slot is invalid.');
    }
    assertNonNegativeSafeInteger(value.transition_sequence, 'head.transition_sequence');
    assertSha256OrNull(value.state_sha256, 'head.state_sha256');
    assertSha256OrNull(value.head_sha256, 'head.head_sha256');
    if (value.state_sha256 === null || value.head_sha256 === null) {
        throw new RuntimeMutationGenerationError('CORRUPT', 'Runtime mutation generation head hashes cannot be null.');
    }
    const parsed: RuntimeMutationGenerationHead = {
        schema_version: 1,
        active_slot: value.active_slot,
        transition_sequence: value.transition_sequence,
        state_sha256: value.state_sha256,
        head_sha256: value.head_sha256
    };
    const { head_sha256: expectedHash, ...hashInput } = parsed;
    if (buildHeadHash(hashInput) !== expectedHash) {
        throw new RuntimeMutationGenerationError('CORRUPT', 'Runtime mutation generation head integrity check failed.');
    }
    return parsed;
}

function parseAnchor(anchorPath: string): RuntimeMutationGenerationAnchor {
    const value = readJsonRecord(anchorPath);
    assertExactKeys(value, [
        'schema_version',
        'transition_sequence',
        'generation',
        'state_sha256',
        'head_sha256',
        'anchor_sha256'
    ], JOURNAL_ANCHOR_NAME);
    if (value.schema_version !== JOURNAL_SCHEMA_VERSION) {
        throw new RuntimeMutationGenerationError('CORRUPT', 'Runtime mutation generation anchor schema version is unsupported.');
    }
    assertNonNegativeSafeInteger(value.transition_sequence, 'anchor.transition_sequence');
    assertNonNegativeSafeInteger(value.generation, 'anchor.generation');
    assertSha256OrNull(value.state_sha256, 'anchor.state_sha256');
    assertSha256OrNull(value.head_sha256, 'anchor.head_sha256');
    assertSha256OrNull(value.anchor_sha256, 'anchor.anchor_sha256');
    if (value.state_sha256 === null || value.head_sha256 === null || value.anchor_sha256 === null) {
        throw new RuntimeMutationGenerationError('CORRUPT', 'Runtime mutation generation anchor hashes cannot be null.');
    }
    const parsed: RuntimeMutationGenerationAnchor = {
        schema_version: 1,
        transition_sequence: value.transition_sequence,
        generation: value.generation,
        state_sha256: value.state_sha256,
        head_sha256: value.head_sha256,
        anchor_sha256: value.anchor_sha256
    };
    const { anchor_sha256: expectedHash, ...hashInput } = parsed;
    if (buildAnchorHash(hashInput) !== expectedHash) {
        throw new RuntimeMutationGenerationError('CORRUPT', 'Runtime mutation generation anchor integrity check failed.');
    }
    return parsed;
}

function activeMutationMap(state: RuntimeMutationGenerationState): Map<string, RuntimeMutationIntent> {
    return new Map(state.active_mutations.map((entry) => [entry.mutation_id, entry]));
}

function assertUnchangedMutationEntries(
    previous: Map<string, RuntimeMutationIntent>,
    current: Map<string, RuntimeMutationIntent>,
    excludedMutationId: string
): void {
    for (const [mutationId, entry] of previous) {
        if (mutationId === excludedMutationId) {
            continue;
        }
        if (JSON.stringify(current.get(mutationId)) !== JSON.stringify(entry)) {
            throw new RuntimeMutationGenerationError('CORRUPT', 'Runtime mutation generation active intent set changed unexpectedly.');
        }
    }
}

function assertValidTransition(previous: RuntimeMutationGenerationState, current: RuntimeMutationGenerationState): void {
    if (current.transition_sequence !== previous.transition_sequence + 1) {
        throw new RuntimeMutationGenerationError('CORRUPT', 'Runtime mutation transition sequence is discontinuous or rolled back.');
    }
    if (current.previous_state_sha256 !== previous.state_sha256) {
        throw new RuntimeMutationGenerationError('CORRUPT', 'Runtime mutation state hash chain is discontinuous or rolled back.');
    }
    const transition = current.transition;
    if (transition.type === 'INITIALIZE' || transition.mutation_id === null || transition.mutation_kind === null) {
        throw new RuntimeMutationGenerationError('CORRUPT', 'Non-initial runtime mutation transition metadata is incomplete.');
    }
    const previousEntries = activeMutationMap(previous);
    const currentEntries = activeMutationMap(current);
    if (transition.type === 'BEGIN') {
        if (
            current.generation !== previous.generation
            || previousEntries.has(transition.mutation_id)
            || currentEntries.size !== previousEntries.size + 1
            || currentEntries.get(transition.mutation_id)?.mutation_kind !== transition.mutation_kind
        ) {
            throw new RuntimeMutationGenerationError('CORRUPT', 'Runtime mutation BEGIN transition is inconsistent.');
        }
        assertUnchangedMutationEntries(previousEntries, currentEntries, transition.mutation_id);
        return;
    }
    if (
        !previousEntries.has(transition.mutation_id)
        || currentEntries.has(transition.mutation_id)
        || currentEntries.size !== previousEntries.size - 1
        || previousEntries.get(transition.mutation_id)?.mutation_kind !== transition.mutation_kind
    ) {
        throw new RuntimeMutationGenerationError('CORRUPT', `Runtime mutation ${transition.type} transition is inconsistent.`);
    }
    assertUnchangedMutationEntries(previousEntries, currentEntries, transition.mutation_id);
    const expectedGeneration = transition.type === 'COMMIT'
        ? previous.generation + 1
        : previous.generation;
    if (current.generation !== expectedGeneration) {
        throw new RuntimeMutationGenerationError('CORRUPT', `Runtime mutation ${transition.type} generation is inconsistent.`);
    }
}

function assertJournalSlotPairConsistency(
    current: RuntimeMutationGenerationState,
    other: RuntimeMutationGenerationState
): void {
    if (other.transition_sequence === current.transition_sequence - 1) {
        assertValidTransition(other, current);
        return;
    }
    if (other.transition_sequence === current.transition_sequence + 1) {
        // An unpublished transition is validated against the anchor's state, never adopted as authority.
        assertValidTransition(current, other);
        return;
    }
    throw new RuntimeMutationGenerationError(
        'CORRUPT',
        'Runtime mutation transition sequence is discontinuous or rolled back.'
    );
}

function slotForSequence(sequence: number): RuntimeMutationGenerationSlot {
    return sequence % 2 === 0 ? 'a' : 'b';
}

function assertCurrentStateMatchesAnchor(
    paths: RuntimeMutationGenerationPaths,
    head: RuntimeMutationGenerationHead,
    current: RuntimeMutationGenerationState
): void {
    const anchor = parseAnchor(paths.anchorPath);
    if (
        anchor.transition_sequence !== current.transition_sequence
        || anchor.generation !== current.generation
        || anchor.state_sha256 !== current.state_sha256
        || anchor.head_sha256 !== head.head_sha256
    ) {
        throw new RuntimeMutationGenerationError('CORRUPT', 'Runtime mutation generation anchor detected missing, stale, or rolled-back journal state.');
    }
}

function resolveAnchorCommittedState(
    paths: RuntimeMutationGenerationPaths,
    head: RuntimeMutationGenerationHead,
    headState: RuntimeMutationGenerationState
): RuntimeMutationGenerationState {
    try {
        if (headState.state_sha256 !== head.state_sha256) {
            throw new RuntimeMutationGenerationError('CORRUPT', 'Runtime mutation generation head does not match the active state.');
        }
        assertCurrentStateMatchesAnchor(paths, head, headState);
        return headState;
    } catch (error: unknown) {
        const anchor = parseAnchor(paths.anchorPath);
        const previousSlot: RuntimeMutationGenerationSlot = head.active_slot === 'a' ? 'b' : 'a';
        const previous = parseState(paths.slotPaths[previousSlot]);
        const previousHead = createHead(previous);
        const anchorMatchesPrevious =
            anchor.transition_sequence === previous.transition_sequence
            && anchor.generation === previous.generation
            && anchor.state_sha256 === previous.state_sha256
            && anchor.head_sha256 === previousHead.head_sha256;
        if (
            anchorMatchesPrevious
            && headState.transition_sequence === previous.transition_sequence + 1
        ) {
            // A retry can replace an unpublished slot before replacing its stale head.
            // Only the exactly anchored previous state remains authoritative here.
            assertValidTransition(previous, headState);
            return previous;
        }
        throw error;
    }
}

function readCurrentState(paths: RuntimeMutationGenerationPaths): RuntimeMutationGenerationState {
    assertJournalDirectory(paths.journalDirectory, false);
    const head = parseHead(paths.headPath);
    if (head.active_slot !== slotForSequence(head.transition_sequence)) {
        throw new RuntimeMutationGenerationError('CORRUPT', 'Runtime mutation generation head slot does not match its sequence.');
    }
    const headState = parseState(paths.slotPaths[head.active_slot]);
    if (headState.transition_sequence !== head.transition_sequence) {
        throw new RuntimeMutationGenerationError('CORRUPT', 'Runtime mutation generation head does not match the active state.');
    }
    const current = resolveAnchorCommittedState(paths, head, headState);
    if (current.transition_sequence === 0) {
        if (
            current.generation !== 0
            || current.active_mutations.length !== 0
            || current.previous_state_sha256 !== null
            || current.transition.type !== 'INITIALIZE'
            || current.transition.mutation_id !== null
            || current.transition.mutation_kind !== null
        ) {
            throw new RuntimeMutationGenerationError('CORRUPT', 'Initial runtime mutation generation state is invalid.');
        }
        const currentSlot = slotForSequence(current.transition_sequence);
        const otherSlot: RuntimeMutationGenerationSlot = currentSlot === 'a' ? 'b' : 'a';
        if (assertRegularJournalFile(paths.slotPaths[otherSlot], true) !== null) {
            assertJournalSlotPairConsistency(current, parseState(paths.slotPaths[otherSlot]));
        }
        return current;
    }
    const currentSlot = slotForSequence(current.transition_sequence);
    const previousSlot: RuntimeMutationGenerationSlot = currentSlot === 'a' ? 'b' : 'a';
    const previous = parseState(paths.slotPaths[previousSlot]);
    assertJournalSlotPairConsistency(current, previous);
    return current;
}

function serializeJson(value: unknown): string {
    return `${JSON.stringify(value, null, 2)}\n`;
}

function createInitialState(): RuntimeMutationGenerationState {
    const hashInput: Omit<RuntimeMutationGenerationState, 'state_sha256'> = {
        schema_version: 1,
        transition_sequence: 0,
        generation: 0,
        active_mutations: [],
        transitioned_at_utc: new Date().toISOString(),
        transition: {
            type: 'INITIALIZE',
            mutation_id: null,
            mutation_kind: null
        },
        previous_state_sha256: null
    };
    return {
        ...hashInput,
        state_sha256: buildStateHash(hashInput)
    };
}

function createHead(state: RuntimeMutationGenerationState): RuntimeMutationGenerationHead {
    const hashInput: Omit<RuntimeMutationGenerationHead, 'head_sha256'> = {
        schema_version: 1,
        active_slot: slotForSequence(state.transition_sequence),
        transition_sequence: state.transition_sequence,
        state_sha256: state.state_sha256
    };
    return {
        ...hashInput,
        head_sha256: buildHeadHash(hashInput)
    };
}

function createAnchor(
    state: RuntimeMutationGenerationState,
    head: RuntimeMutationGenerationHead
): RuntimeMutationGenerationAnchor {
    const hashInput: Omit<RuntimeMutationGenerationAnchor, 'anchor_sha256'> = {
        schema_version: 1,
        transition_sequence: state.transition_sequence,
        generation: state.generation,
        state_sha256: state.state_sha256,
        head_sha256: head.head_sha256
    };
    return {
        ...hashInput,
        anchor_sha256: buildAnchorHash(hashInput)
    };
}

function assertSafeJournalWriteTarget(filePath: string): void {
    assertRegularJournalFile(filePath, true);
}

function persistState(paths: RuntimeMutationGenerationPaths, state: RuntimeMutationGenerationState): void {
    const slot = slotForSequence(state.transition_sequence);
    const statePath = paths.slotPaths[slot];
    const head = createHead(state);
    const stateContents = serializeJson(state);
    if (Buffer.byteLength(stateContents, 'utf8') > MAX_JOURNAL_FILE_BYTES) {
        throw new RuntimeMutationGenerationError('BUSY', 'Runtime mutation generation has reached its bounded journal capacity.');
    }
    assertSafeJournalWriteTarget(statePath);
    assertSafeJournalWriteTarget(paths.headPath);
    assertSafeJournalWriteTarget(paths.anchorPath);
    writeFileAtomically(statePath, stateContents, { encoding: 'utf8' });
    writeFileAtomically(paths.headPath, serializeJson(head), { encoding: 'utf8' });
    writeFileAtomically(paths.anchorPath, serializeJson(createAnchor(state, head)), { encoding: 'utf8' });
}

function loadOrInitializeState(paths: RuntimeMutationGenerationPaths): RuntimeMutationGenerationState {
    assertJournalDirectory(paths.journalDirectory, true);
    if (!fs.existsSync(paths.journalDirectory)) {
        if (assertRegularJournalFile(paths.anchorPath, true) !== null) {
            throw new RuntimeMutationGenerationError('CORRUPT', 'Runtime mutation generation journal is missing while its monotonic anchor exists.');
        }
        fs.mkdirSync(paths.journalDirectory, { recursive: false });
        const initialState = createInitialState();
        persistState(paths, initialState);
        return initialState;
    }
    return readCurrentState(paths);
}

function createTransitionState(
    previous: RuntimeMutationGenerationState,
    transition: RuntimeMutationTransition,
    activeMutations: RuntimeMutationIntent[],
    generation: number
): RuntimeMutationGenerationState {
    const hashInput: Omit<RuntimeMutationGenerationState, 'state_sha256'> = {
        schema_version: 1,
        transition_sequence: previous.transition_sequence + 1,
        generation,
        active_mutations: [...activeMutations].sort((left, right) => left.mutation_id.localeCompare(right.mutation_id)),
        transitioned_at_utc: new Date().toISOString(),
        transition,
        previous_state_sha256: previous.state_sha256
    };
    return {
        ...hashInput,
        state_sha256: buildStateHash(hashInput)
    };
}

function withGenerationMutationLock<T>(orchestratorRoot: string, callback: (paths: RuntimeMutationGenerationPaths) => T): T {
    const paths = getRuntimeMutationGenerationPaths(orchestratorRoot);
    fs.mkdirSync(paths.runtimeRoot, { recursive: true });
    const { result } = withFilesystemLock(paths.lockPath, {
        timeoutMs: 30_000,
        retryMs: 2,
        ownerLabel: 'runtime-mutation-generation'
    }, () => callback(paths));
    return result;
}

function toSnapshot(state: RuntimeMutationGenerationState): RuntimeMutationGenerationSnapshot {
    return {
        schema_version: 1,
        generation: state.generation,
        transition_sequence: state.transition_sequence,
        state_sha256: state.state_sha256
    };
}

export function readRuntimeMutationGeneration(orchestratorRoot: string): RuntimeMutationGenerationSnapshot {
    const paths = getRuntimeMutationGenerationPaths(orchestratorRoot);
    const state = readCurrentState(paths);
    if (state.active_mutations.length > 0) {
        throw new RuntimeMutationGenerationError(
            'BUSY',
            `Runtime mutation generation has ${state.active_mutations.length} uncommitted mutation(s).`
        );
    }
    return toSnapshot(state);
}

function recoverProvenDeadMutations(
    paths: RuntimeMutationGenerationPaths,
    initial: RuntimeMutationGenerationState
): RuntimeMutationGenerationState {
    if (initial.active_mutations.length === 0) return initial;
    const inspectOwner = createRuntimeMutationOwnerProbe();
    let previous = initial;
    for (const intent of initial.active_mutations) {
        if (inspectOwner(intent.owner ?? null) !== 'dead') continue;
        // The owner may have persisted canonical bytes before exiting; invalidate derived caches.
        const next = createTransitionState(previous, {
            type: 'COMMIT',
            mutation_id: intent.mutation_id,
            mutation_kind: intent.mutation_kind
        }, previous.active_mutations.filter((entry) => entry.mutation_id !== intent.mutation_id), previous.generation + 1);
        persistState(paths, next);
        previous = next;
    }
    return previous;
}

export function beginRuntimeMutationGeneration(
    orchestratorRoot: string,
    mutationKind: string
): RuntimeMutationGenerationTicket {
    const normalizedMutationKind = mutationKind.trim();
    if (!normalizedMutationKind) {
        throw new Error('mutationKind is required.');
    }
    const resolvedOrchestratorRoot = path.resolve(orchestratorRoot);
    const mutationId = crypto.randomUUID();
    withGenerationMutationLock(resolvedOrchestratorRoot, (paths) => {
        const previous = recoverProvenDeadMutations(paths, loadOrInitializeState(paths));
        if (previous.active_mutations.length >= MAX_ACTIVE_MUTATIONS) {
            throw new RuntimeMutationGenerationError('BUSY', 'Runtime mutation generation has too many active mutations.');
        }
        // A legacy parent must still be able to read both slots when its new-runtime child returns.
        const legacyWriterActive = previous.active_mutations.some((intent) => !Object.prototype.hasOwnProperty.call(intent, 'owner'));
        const next = createTransitionState(previous, {
            type: 'BEGIN',
            mutation_id: mutationId,
            mutation_kind: normalizedMutationKind
        }, [...previous.active_mutations, {
            mutation_id: mutationId,
            mutation_kind: normalizedMutationKind,
            started_at_utc: new Date().toISOString(),
            ...(legacyWriterActive ? {} : { owner: captureRuntimeMutationOwnerIdentity() })
        }], previous.generation);
        persistState(paths, next);
    });
    return {
        orchestrator_root: resolvedOrchestratorRoot,
        mutation_id: mutationId,
        mutation_kind: normalizedMutationKind
    };
}

function settleRuntimeMutationGeneration(
    ticket: RuntimeMutationGenerationTicket,
    transitionType: 'COMMIT' | 'ABORT'
): RuntimeMutationGenerationSnapshot {
    return withGenerationMutationLock(ticket.orchestrator_root, (paths) => {
        const previous = loadOrInitializeState(paths);
        const activeMutation = previous.active_mutations.find((entry) => entry.mutation_id === ticket.mutation_id);
        if (
            !activeMutation
            && previous.transition.type === transitionType
            && previous.transition.mutation_id === ticket.mutation_id
            && previous.transition.mutation_kind === ticket.mutation_kind
        ) {
            // Only the latest anchor-committed settlement can acknowledge a repeated ticket.
            return toSnapshot(previous);
        }
        if (!activeMutation || activeMutation.mutation_kind !== ticket.mutation_kind) {
            throw new RuntimeMutationGenerationError('CORRUPT', `Runtime mutation ticket '${ticket.mutation_id}' is not active.`);
        }
        const next = createTransitionState(previous, {
            type: transitionType,
            mutation_id: ticket.mutation_id,
            mutation_kind: ticket.mutation_kind
        }, previous.active_mutations.filter((entry) => entry.mutation_id !== ticket.mutation_id),
        transitionType === 'COMMIT' ? previous.generation + 1 : previous.generation);
        persistState(paths, next);
        return toSnapshot(next);
    });
}

export function commitRuntimeMutationGeneration(
    ticket: RuntimeMutationGenerationTicket
): RuntimeMutationGenerationSnapshot {
    const snapshot = settleRuntimeMutationGeneration(ticket, 'COMMIT');
    try {
        const scheduler = require('../runtime/sqlite-catalog/sqlite-catalog-reconciliation') as {
            scheduleDerivedSqliteCatalogReconciliation(repoRoot: string): void;
        };
        scheduler.scheduleDerivedSqliteCatalogReconciliation(ticket.orchestrator_root);
    } catch (error: unknown) {
        const diagnostic = (error instanceof Error ? error.message : String(error))
            .replace(/\s+/gu, ' ')
            .trim()
            .slice(0, 512);
        process.stderr.write(
            `WARNING: Canonical mutation committed but derived SQLite catalog scheduling failed: `
            + `${diagnostic || 'unknown projection error'}\n`
        );
    }
    return snapshot;
}

export function abortRuntimeMutationGeneration(
    ticket: RuntimeMutationGenerationTicket
): RuntimeMutationGenerationSnapshot {
    return settleRuntimeMutationGeneration(ticket, 'ABORT');
}

export function withRuntimeMutationGeneration<T>(
    orchestratorRoot: string,
    mutationKind: string,
    callback: () => T
): T {
    const ticket = beginRuntimeMutationGeneration(orchestratorRoot, mutationKind);
    let callbackCompleted = false;
    try {
        const result = callback();
        callbackCompleted = true;
        commitRuntimeMutationGeneration(ticket);
        return result;
    } catch (error: unknown) {
        if (!callbackCompleted) {
            try {
                abortRuntimeMutationGeneration(ticket);
            } catch {
                // A journal settlement failure is intentionally left fail-closed.
            }
        }
        throw error;
    }
}

export async function withRuntimeMutationGenerationAsync<T>(
    orchestratorRoot: string,
    mutationKind: string,
    callback: () => Promise<T>
): Promise<T> {
    const ticket = beginRuntimeMutationGeneration(orchestratorRoot, mutationKind);
    let callbackCompleted = false;
    try {
        const result = await callback();
        callbackCompleted = true;
        commitRuntimeMutationGeneration(ticket);
        return result;
    } catch (error: unknown) {
        if (!callbackCompleted) {
            try {
                abortRuntimeMutationGeneration(ticket);
            } catch {
                // A journal settlement failure is intentionally left fail-closed.
            }
        }
        throw error;
    }
}
