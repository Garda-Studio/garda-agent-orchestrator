import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, timingSafeEqual } from 'node:crypto';
import { TextDecoder, isDeepStrictEqual } from 'node:util';
import { bindContainedDestination, assertContainedDestination } from '../../core/contained-filesystem';
import { isPlainRecord } from '../../core/records';
import { runGit, runGitBinary } from '../../core/git-helpers';
import { isCanonicalTaskId } from '../../core/task-ids';
import { joinOrchestratorPath } from '../../core/orchestrator-paths';
import { TASK_QUEUE_FILENAME } from '../../core/orchestration-constants';
import { resolveWorkflowConfigPath } from '../../core/full-suite-validation-config';
import { authenticateLocalCommitWorkflowAudit, resolveLocalCommitAvailability } from '../../core/auth/local-commit-availability';
import { inspectTaskEventFile, withTaskTimelineReadSnapshot } from '../../gate-runtime/task-events';
import {
    captureTaskTimelineReadSnapshotSha256, assertTaskTimelineReadSnapshotCurrent
} from '../../gate-runtime/timeline/task-timeline-read-snapshot';
import { readNativeAuditedNoOpSourceAcceptance, type NativeChildAuditReader } from './task-audit-summary-no-op-source';

const MAX_PROOF_INPUT_BYTES = 8 * 1024 * 1024;
const GIT_OBJECT_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const SOURCE_GIT_OPTIONS = { maxBuffer: 64 * 1024, timeoutMs: 10000 };
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const SOURCE_CYCLE_BOUNDARIES = new Set([
    'TASK_MODE_ENTERED', 'PREFLIGHT_CLASSIFIED', 'COMPILE_GATE_PASSED', 'COMPLETION_GATE_PASSED'
]);

export interface NativeChildGitSource {
    commitSha: string;
    treeSha: string;
    parentCommitSha: string | null;
}

export type NativeChildSourceAcceptance = NativeChildGitSource & {
    taskId: string;
    artifactPath: string;
    artifactSha256: string;
} & ({ postCommitAudit: Record<string, unknown>; noOpAcceptanceAudit?: never }
    | { postCommitAudit?: never; noOpAcceptanceAudit: Record<string, unknown> });

export function mergeNativeChildSources(groups: Iterable<Iterable<NativeChildSourceAcceptance>>): NativeChildSourceAcceptance[] {
    const sources = new Map<string, NativeChildSourceAcceptance>();
    for (const group of groups) {
        for (const source of group) {
            const previous = sources.get(source.taskId);
            if (previous && !isDeepStrictEqual(previous, source)) {
                throw new Error('Conflicting native child SOURCE observations: ' + source.taskId);
            }
            if (!previous) sources.set(source.taskId, source);
        }
    }
    return [...sources.values()];
}

class MissingNativeChildSourceAcceptanceError extends Error {}

function assertNativeSourceAuthentication(root: string, proof: Record<string, unknown>): void {
    if (!resolveLocalCommitAvailability(root).enabled) {
        throw new Error('Native child source acceptance requires current audited workspace authority.');
    }
    const expected = authenticateLocalCommitWorkflowAudit(root, proof, false);
    const actual = proof.local_commit_authentication, authentication = expected.local_commit_authentication;
    if (expected === proof || !isPlainRecord(actual) || !isPlainRecord(authentication)
        || actual.workspace_identity_sha256 !== authentication.workspace_identity_sha256
        || typeof actual.hmac_sha256 !== 'string' || !SHA256_PATTERN.test(actual.hmac_sha256)
        || typeof authentication.hmac_sha256 !== 'string' || !SHA256_PATTERN.test(authentication.hmac_sha256)
        || !timingSafeEqual(Buffer.from(actual.hmac_sha256, 'hex'), Buffer.from(authentication.hmac_sha256, 'hex'))) {
        throw new Error('Native child source acceptance authentication is invalid or foreign.');
    }
}

function readCurrentNativeSourceEvent(file: string, taskId: string): Record<string, unknown> {
    let selected: Readonly<Record<string, unknown>> | undefined, sourceLine = 0, cycleLine = 0;
    const commits = new Set<unknown>();
    let duplicate = false;
    const inspection = inspectTaskEventFile(file, taskId, { onIntegrityEvent: (event, line) => {
        if (SOURCE_CYCLE_BOUNDARIES.has(String(event.event_type))) cycleLine = line;
        if (event.event_type !== 'TASK_SOURCE_COMMIT_ACCEPTED') return;
        const commit = isPlainRecord(event.details) ? event.details.commit_sha : undefined;
        if (commits.has(commit)) duplicate = true;
        commits.add(commit);
        selected = event; sourceLine = line;
    } });
    if (!['PASS', 'PASS_WITH_LEGACY_PREFIX'].includes(inspection.status) || inspection.violations.length) {
        throw new Error(`Native child ${taskId} source acceptance requires an intact task timeline.`);
    }
    if (!selected) {
        throw new MissingNativeChildSourceAcceptanceError(`Native child ${taskId} is missing TASK_SOURCE_COMMIT_ACCEPTED evidence; an audited no-op alone does not prove source acceptance.`);
    }
    if (selected.schema_version !== 2 || selected.outcome !== 'PASS'
        || selected.task_id !== taskId || !isPlainRecord(selected.details) || duplicate) {
        throw new Error(`Native child ${taskId} source acceptance has invalid or ambiguous TASK_SOURCE_COMMIT_ACCEPTED evidence.`);
    }
    if (cycleLine > sourceLine) throw new Error('Native child source acceptance is stale for the current child cycle.');
    return selected.details;
}

function sourceProofPath(root: string, taskId: string, event: Record<string, unknown>): string {
    if (event.repo_root !== root || typeof event.commit_sha !== 'string' || !GIT_OBJECT_PATTERN.test(event.commit_sha)
        || typeof event.artifact_sha256 !== 'string' || !SHA256_PATTERN.test(event.artifact_sha256)) {
        throw new Error('Native child source event has invalid workspace or Git identity.');
    }
    const file = joinOrchestratorPath(root, `runtime/reviews/${taskId}-source-acceptance-${event.commit_sha}.json`);
    if (event.artifact_path !== path.relative(root, file).replace(/\\/gu, '/')) {
        throw new Error('Native child source proof must use its exact task-qualified artifact path.');
    }
    return file;
}

function validateNativeSourceRecord(
    root: string, taskId: string, event: Record<string, unknown>, proof: Record<string, unknown>
): Record<string, unknown> {
    if (proof.schema_version !== 1 || proof.event_source !== 'native-source-acceptance') {
        throw new Error('Child source proof is not a native source-acceptance record.');
    }
    if (proof.task_id !== taskId || proof.repo_root !== root) {
        throw new Error('Native child source proof has a foreign task or workspace identity.');
    }
    for (const field of ['commit_sha', 'tree_sha', 'parent_commit_sha']) {
        if (proof[field] !== event[field] || (field === 'parent_commit_sha' && proof[field] === null ? false
            : typeof proof[field] !== 'string' || !GIT_OBJECT_PATTERN.test(proof[field] as string))) {
            throw new Error(`Native child source proof has inconsistent Git ${field} identity.`);
        }
    }
    const audit = proof.post_commit_audit;
    if (!isPlainRecord(audit) || audit.task_id !== taskId || audit.status !== 'PASS'
        || !['PASS', 'PASS_WITH_LEGACY_PREFIX'].includes(String(audit.integrity_status))
        || !Array.isArray(audit.blockers) || audit.blockers.length !== 0
        || !isPlainRecord(audit.point_in_time_snapshot) || audit.point_in_time_snapshot.status !== 'STABLE'
        || createHash('sha256').update(JSON.stringify(audit)).digest('hex') !== proof.post_commit_audit_sha256) {
        throw new Error('Native child source proof requires its exact stable, task-qualified PASS audit.');
    }
    return audit;
}

/** Child source corroboration does not discharge parent graph, memory, WIP or suite obligations. */
export function readNativeChildSourceAcceptance(
    repoRoot: string, taskId: string, readAudit?: NativeChildAuditReader
): NativeChildSourceAcceptance {
    try { return readNativeCommittedChildSourceAcceptance(repoRoot, taskId); }
    catch (error: unknown) {
        if (!(error instanceof MissingNativeChildSourceAcceptanceError) || !readAudit) throw error;
        return readNativeAuditedNoOpSourceAcceptance(repoRoot, taskId, {
            readAudit, verifyComposition: readNativeSourceCompositionProof, validateGit: validateNativeChildGitSource
        });
    }
}

function readNativeCommittedChildSourceAcceptance(repoRoot: string, taskId: string): NativeChildSourceAcceptance {
    if (!isCanonicalTaskId(taskId)) throw new Error('Native child source acceptance requires an exact canonical task ID.');
    const root = fs.realpathSync.native(repoRoot), eventsRoot = joinOrchestratorPath(root, 'runtime/task-events');
    if (!resolveLocalCommitAvailability(root).enabled) {
        throw new Error('Native child source acceptance requires current audited workspace authority.');
    }
    const head = runGit(root, ['--no-replace-objects', 'rev-parse', 'HEAD'], SOURCE_GIT_OPTIONS).trim();
    return withTaskTimelineReadSnapshot(eventsRoot, taskId, () => {
        const timelinePath = path.join(eventsRoot, `${taskId}.jsonl`);
        const timelineSha256 = captureTaskTimelineReadSnapshotSha256(timelinePath);
        const event = readCurrentNativeSourceEvent(timelinePath, taskId);
        const file = sourceProofPath(root, taskId, event), hash = event.artifact_sha256 as string;
        const identity = bindContainedDestination(root, file);
        const proof = readParentAuditProofRecord(root, file, hash);
        const audit = validateNativeSourceRecord(root, taskId, event, proof);
        const source = { commitSha: event.commit_sha as string, treeSha: event.tree_sha as string,
            parentCommitSha: event.parent_commit_sha as string | null };
        assertNativeSourceAuthentication(root, proof);
        validateNativeChildGitSource(root, source);
        assertNativeSourceAuthentication(root, proof);
        readParentAuditProofRecord(root, file, hash);
        assertContainedDestination(identity);
        if (runGit(root, ['--no-replace-objects', 'rev-parse', 'HEAD'], SOURCE_GIT_OPTIONS).trim() !== head) {
            throw new Error('Native child source HEAD identity changed during proof consumption.');
        }
        assertTaskTimelineReadSnapshotCurrent(timelinePath, timelineSha256);
        return { taskId, ...source, artifactPath: event.artifact_path as string, artifactSha256: hash, postCommitAudit: audit };
    });
}

function readRawSourceObjects(root: string, requests: Array<{ sha: string; type: 'commit' | 'tree' }>): Buffer[] {
    const bytes = runGitBinary(root, ['--no-replace-objects', 'cat-file', '--batch'], {
        ...SOURCE_GIT_OPTIONS, maxBuffer: MAX_PROOF_INPUT_BYTES,
        input: requests.map(item => item.sha).join('\n') + '\n'
    });
    let offset = 0;
    const objects = requests.map(({ sha, type }) => {
        const end = bytes.indexOf(10, offset);
        const header = end < 0 ? null : /^([a-f0-9]+) (commit|tree) ([0-9]+)$/u
            .exec(bytes.subarray(offset, end).toString('ascii'));
        const size = header ? Number(header[3]) : NaN, start = end + 1;
        if (!header || header[1] !== sha || header[2] !== type || !Number.isSafeInteger(size)
            || size < 0 || size > MAX_PROOF_INPUT_BYTES || start + size >= bytes.length
            || bytes[start + size] !== 10) {
            throw new Error('Git proof requires complete bounded raw object frames.');
        }
        const object = bytes.subarray(start, start + size);
        const digest = createHash(sha.length === 40 ? 'sha1' : 'sha256')
            .update(`${type} ${size}\0`).update(object).digest('hex');
        if (digest !== sha) throw new Error('Git object bytes do not match their immutable identity.');
        offset = start + size + 1;
        return object;
    });
    if (offset !== bytes.length) throw new Error('Git proof contains unexpected raw object frames.');
    return objects;
}

function verifySourceCommit(object: Buffer, row: string[], expectedTree?: string): void {
    const separator = object.indexOf('\n\n');
    const headers = object.subarray(0, separator).toString('utf8').split('\n');
    const tree = /^tree ((?:[a-f0-9]{40}|[a-f0-9]{64}))$/u.exec(headers[0])?.[1];
    let parentEnd = 1;
    while (headers[parentEnd]?.startsWith('parent ')) parentEnd++;
    const parents = headers.slice(1, parentEnd).map(line => line.slice(7));
    if (separator < 0 || !tree || headers.slice(parentEnd).some(line => /^(?:tree|parent) /u.test(line))
        || (expectedTree !== undefined && tree !== expectedTree)
        || parents.join(' ') !== row.slice(1).join(' ')) {
        throw new Error('Git commit tree or ancestry parents differ from immutable source evidence.');
    }
}

function verifyRawSourceAncestry(rows: string[][], head: string, accepted: string): void {
    const parents = new Map(rows.map(row => [row[0], row.slice(1)]));
    const pending = [head], seen = new Set<string>();
    while (pending.length) {
        const sha = pending.pop()!;
        if (sha === accepted) return;
        if (seen.has(sha)) continue;
        seen.add(sha);
        pending.push(...(parents.get(sha) || []));
    }
    throw new Error('Git raw ancestry does not connect current HEAD to accepted source.');
}

/** Git corroboration alone does not authenticate task SOURCE records or accept a parent audit. */
export function validateNativeChildGitSource(repoRoot: string, source: NativeChildGitSource): void {
    if (!source || (source.parentCommitSha !== null && !GIT_OBJECT_PATTERN.test(source.parentCommitSha))) {
        throw new Error('Git source proof requires exact commit, tree and parent object identity.');
    }
    validateExactGitSource(repoRoot, source, source.parentCommitSha === null ? [] : [source.parentCommitSha]);
}

/** Integrated HEADs may merge children; this does not broaden authenticated child SOURCE. */
export function validateNativeParentGitSource(
    repoRoot: string, source: Pick<NativeChildGitSource, 'commitSha' | 'treeSha'>, parentCommitShas: readonly string[]
): void {
    validateExactGitSource(repoRoot, source, parentCommitShas);
}

function validateExactGitSource(
    repoRoot: string, source: Pick<NativeChildGitSource, 'commitSha' | 'treeSha'>, parentCommitShas: readonly string[]
): void {
    if (!source || !GIT_OBJECT_PATTERN.test(source.commitSha) || !GIT_OBJECT_PATTERN.test(source.treeSha)
        || !Array.isArray(parentCommitShas) || parentCommitShas.some(sha => !GIT_OBJECT_PATTERN.test(sha))) {
        throw new Error('Git source proof requires exact commit, tree and parent object identity.');
    }
    const root = fs.realpathSync.native(repoRoot);
    const localVariables = runGit(root, ['--no-replace-objects', 'rev-parse', '--local-env-vars'], SOURCE_GIT_OPTIONS)
        .trim().split(/\r?\n/u).concat('GIT_NAMESPACE');
    const inherited = new Set(Object.keys(process.env).map(name => name.toUpperCase()));
    if (localVariables.some(name => inherited.has(name.toUpperCase()))) {
        throw new Error('Git proof rejects inherited repository environment overrides.');
    }
    const [gitRoot, grafts, head] = runGit(root, ['--no-replace-objects', 'rev-parse', '--show-toplevel',
        '--git-path', 'info/grafts', 'HEAD'], SOURCE_GIT_OPTIONS).trim().split(/\r?\n/u);
    if (!gitRoot || fs.realpathSync.native(gitRoot) !== root) {
        throw new Error('Git proof requires the exact workspace Git root.');
    }
    if (!grafts || fs.existsSync(path.resolve(root, grafts))) throw new Error('Git proof rejects graft ancestry.');
    if (!head || !GIT_OBJECT_PATTERN.test(head)
        || [source.commitSha, source.treeSha, ...parentCommitShas].some(sha => sha.length !== head.length)) {
        throw new Error('Git source object identity does not match the repository format.');
    }
    const ancestry = runGit(root, ['--no-replace-objects', 'rev-list', '--parents', '--ancestry-path', '--full-history',
        `${source.commitSha}..${head}`], SOURCE_GIT_OPTIONS).trim();
    const rows = [[source.commitSha, ...parentCommitShas],
        ...ancestry.split('\n').filter(Boolean).map(line => line.trim().split(' '))];
    if (rows.some(row => row.some(sha => !GIT_OBJECT_PATTERN.test(sha)))) {
        throw new Error('Git ancestry contains invalid object identity.');
    }
    const objects = readRawSourceObjects(root, [...rows.map(row => ({ sha: row[0], type: 'commit' as const })),
        { sha: source.treeSha, type: 'tree' }]);
    rows.forEach((row, index) => verifySourceCommit(objects[index], row, index === 0 ? source.treeSha : undefined));
    verifyRawSourceAncestry(rows, head, source.commitSha);
    if (runGit(root, ['--no-replace-objects', 'rev-parse', 'HEAD'], SOURCE_GIT_OPTIONS).trim() !== head) {
        throw new Error('Git HEAD changed during source proof verification.');
    }
}

export function readParentAuditProofBytes(
    repoRoot: string, artifactPath: string, expectedSha256?: string
): Buffer {
    if (expectedSha256 !== undefined && (typeof expectedSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(expectedSha256))) {
        throw new Error('Parent-audit proof requires an exact SHA256 evidence binding.');
    }
    const binding = bindContainedDestination(repoRoot, artifactPath);
    const identity = binding.existing.at(-1);
    if (binding.missingAt || !identity || identity.path !== binding.path) {
        throw new Error('Parent-audit proof input is missing.');
    }
    assertContainedDestination(binding);
    const descriptor = fs.openSync(binding.path,
        fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | (fs.constants.O_NOFOLLOW || 0));
    try {
        const before = fs.fstatSync(descriptor, { bigint: true });
        if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(MAX_PROOF_INPUT_BYTES)
            || before.dev !== identity.dev || before.ino !== identity.ino
            || before.mode !== identity.mode || before.birthtimeNs !== identity.birthtimeNs) {
            throw new Error('Parent-audit proof requires a bounded ordinary file with intact identity.');
        }
        const bytes = Buffer.alloc(Number(before.size) + 1);
        let length = 0;
        while (length < bytes.length) {
            const count = fs.readSync(descriptor, bytes, length, bytes.length - length, null);
            if (count === 0) break;
            length += count;
        }
        const after = fs.fstatSync(descriptor, { bigint: true });
        assertContainedDestination(binding);
        if (length !== Number(before.size) || after.size !== before.size
            || after.nlink !== 1n || after.mode !== before.mode
            || after.ctimeNs !== before.ctimeNs || after.mtimeNs !== before.mtimeNs) {
            throw new Error('Parent-audit proof changed during its bounded read.');
        }
        const content = bytes.subarray(0, length);
        if (expectedSha256 !== undefined && createHash('sha256').update(content).digest('hex') !== expectedSha256) {
            throw new Error('Parent-audit proof bytes do not match their evidence binding.');
        }
        assertContainedDestination(binding);
        return content;
    } finally { fs.closeSync(descriptor); }
}

// Byte fidelity is not native source acceptance or aggregate audit authority.
export function readParentAuditProofRecord(
    repoRoot: string, artifactPath: string, expectedSha256: string
): Record<string, unknown> {
    if (typeof expectedSha256 !== 'string' || !SHA256_PATTERN.test(expectedSha256)) {
        throw new Error('Parent-audit proof requires an exact SHA256 evidence binding.');
    }
    const bytes = readParentAuditProofBytes(repoRoot, artifactPath, expectedSha256);
    const record: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!isPlainRecord(record)) throw new Error('Parent-audit proof must contain a JSON record.');
    return record;
}

export interface NativeSourceCompositionRequest {
    taskId: string;
    artifactPath: string;
    artifactSha256: string;
    command: string;
    coverageContractSha256: string | null;
    source: NativeChildGitSource;
}

function compositionReviewPath(root: string, input: unknown): string {
    if (typeof input !== 'string' || !input) throw new Error('Composition evidence path is missing.');
    const file = path.resolve(root, input);
    const relative = path.relative(joinOrchestratorPath(root, 'runtime/reviews'), file);
    if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
        throw new Error('Composition evidence must belong to the native reviews root.');
    }
    return file;
}

function currentCompositionSource(root: string, source: NativeChildGitSource): Record<string, unknown> {
    const [head, tree] = runGit(root, ['--no-replace-objects', 'rev-parse', 'HEAD', 'HEAD^{tree}'], SOURCE_GIT_OPTIONS)
        .trim().split(/\r?\n/u);
    const status = runGit(root, ['--no-replace-objects', 'status', '--porcelain=v1', '--untracked-files=all', '-z'], SOURCE_GIT_OPTIONS);
    const tracked = runGit(root, ['--no-replace-objects', 'ls-files', '--cached', '-v', '-z'],
        { ...SOURCE_GIT_OPTIONS, maxBuffer: MAX_PROOF_INPUT_BYTES });
    if (head !== source.commitSha || tree !== source.treeSha || status !== ''
        || tracked.split('\0').filter(Boolean).some(entry => !entry.startsWith('H '))) {
        throw new Error('Composition proof requires the exact clean final Git source.');
    }
    const hash = (file: string) => createHash('sha256').update(readParentAuditProofBytes(root, file)).digest('hex');
    return { repo_root: root, source_head_sha: head, source_tree_sha: tree,
        source_status_sha256: createHash('sha256').update(status).digest('hex'), clean_worktree: true,
        task_queue_sha256: hash(path.join(root, TASK_QUEUE_FILENAME)),
        workflow_config_sha256: hash(resolveWorkflowConfigPath(root)) };
}

function currentCompositionEvent(root: string, file: string, request: NativeSourceCompositionRequest): {
    details: Record<string, unknown>; cycleUtc: string; eventUtc: string; previousCommandUtc: string | null;
} {
    let selected: Readonly<Record<string, unknown>> | undefined, selectedLine = 0, cycleLine = 0;
    let proofReferences = 0, cycleUtc = '', previousCommandUtc: string | null = null;
    const inspection = inspectTaskEventFile(file, request.taskId, { onIntegrityEvent: (event, line) => {
        if (['TASK_MODE_ENTERED', 'PREFLIGHT_CLASSIFIED'].includes(String(event.event_type))) {
            cycleLine = line; cycleUtc = String(event.timestamp_utc);
        }
        if (event.event_type === 'INTERMEDIATE_COMMAND_RUN' && isPlainRecord(event.details)
            && (event.details.artifact_sha256 === request.artifactSha256
                || path.resolve(root, String(event.details.artifact_path)) === path.resolve(root, request.artifactPath))) {
            proofReferences++;
        }
        if (event.event_type === 'INTERMEDIATE_COMMAND_RUN' && isPlainRecord(event.details)
            && event.details.command === request.command) {
            if (selected) previousCommandUtc = String(selected.timestamp_utc);
            selected = event; selectedLine = line;
        }
    } });
    if (!['PASS', 'PASS_WITH_LEGACY_PREFIX'].includes(inspection.status) || inspection.violations.length
        || !selected || selected.schema_version !== 2 || selected.task_id !== request.taskId
        || !['PASS', 'PASSED'].includes(String(selected.outcome)) || cycleLine === 0 || selectedLine <= cycleLine
        || proofReferences !== 1 || !isPlainRecord(selected.details) || selected.details.exit_code !== 0
        || selected.details.artifact_sha256 !== request.artifactSha256
        || path.resolve(root, String(selected.details.artifact_path)) !== path.resolve(root, request.artifactPath)) {
        throw new Error('Composition proof lacks the latest current-cycle native successful command event.');
    }
    return { details: selected.details, cycleUtc, eventUtc: String(selected.timestamp_utc), previousCommandUtc };
}

function validateCompositionRecord(record: Record<string, unknown>, native: ReturnType<typeof currentCompositionEvent>,
    request: NativeSourceCompositionRequest, source: Record<string, unknown>): void {
    const event = native.details, generated = Date.parse(String(record.generated_utc));
    const cycle = Date.parse(native.cycleUtc), occurred = Date.parse(native.eventUtc);
    const previous = native.previousCommandUtc === null ? null : Date.parse(native.previousCommandUtc);
    const composition = record.source_composition;
    const before = isPlainRecord(composition) && isPlainRecord(composition.before) ? composition.before : null;
    const after = isPlainRecord(composition) && isPlainRecord(composition.after) ? composition.after : null;
    if (![generated, cycle, occurred].every(Number.isFinite) || generated < cycle || generated > occurred
        || (previous !== null && (!Number.isFinite(previous) || generated <= previous))
        || record.schema_version !== 1 || record.event_source !== 'native-intermediate-command'
        || record.task_id !== request.taskId || record.command !== request.command || record.status !== 'PASSED'
        || record.exit_code !== 0 || record.timed_out !== false || record.cancelled !== false || record.expected_failure === true
        || !['node-test', 'targeted-test', 'typecheck', 'validation'].includes(String(record.command_source))
        || !Number.isFinite(record.duration_ms) || Number(record.duration_ms) < 0
        || (record.coverage_contract_sha256 ?? null) !== request.coverageContractSha256
        || (event.coverage_contract_sha256 ?? null) !== request.coverageContractSha256
        || !isPlainRecord(composition) || composition.schema_version !== 1 || composition.status !== 'STABLE_CLEAN'
        || !before || !after
        || Object.entries(source).some(([key, value]) => before[key] !== value || after[key] !== value)
        || event.source_composition_sha256 !== createHash('sha256').update(JSON.stringify(composition)).digest('hex')) {
        throw new Error('Native composition task, command, coverage, success or final-source binding is invalid.');
    }
    for (const [recordKey, eventKey] of [['output_artifact', 'output_artifact_path'],
        ['output_artifact_sha256', 'output_artifact_sha256'], ['output_artifact_size_bytes', 'output_artifact_size_bytes'],
        ['command_source', 'command_source'], ['preflight_path', 'preflight_path'], ['preflight_sha256', 'preflight_sha256']]) {
        if (record[recordKey] !== event[eventKey]) throw new Error('Native composition command/output event binding differs.');
    }
}

/** The caller supplies the original required command/coverage; this proves execution, not parent acceptance. */
export function readNativeSourceCompositionProof(repoRoot: string, request: NativeSourceCompositionRequest): {
    taskId: string; command: string; processStatus: 'PASSED'; outputSha256: string;
} {
    if (!isCanonicalTaskId(request.taskId) || typeof request.command !== 'string' || !request.command.trim()
        || (request.coverageContractSha256 !== null && !SHA256_PATTERN.test(request.coverageContractSha256))) {
        throw new Error('Composition proof requires exact task, original command and coverage identity.');
    }
    const root = fs.realpathSync.native(repoRoot), eventsRoot = joinOrchestratorPath(root, 'runtime/task-events');
    validateNativeChildGitSource(root, request.source);
    return withTaskTimelineReadSnapshot(eventsRoot, request.taskId, () => {
        const timeline = path.join(eventsRoot, request.taskId + '.jsonl');
        const timelineHash = captureTaskTimelineReadSnapshotSha256(timeline);
        const event = currentCompositionEvent(root, timeline, request);
        const file = compositionReviewPath(root, request.artifactPath);
        const identity = bindContainedDestination(root, file);
        const record = readParentAuditProofRecord(root, file, request.artifactSha256);
        const source = currentCompositionSource(root, request.source);
        validateCompositionRecord(record, event, request, source);
        assertNativeSourceAuthentication(root, record);
        const output = compositionReviewPath(root, record.output_artifact);
        const outputIdentity = bindContainedDestination(root, output);
        const outputHash = String(record.output_artifact_sha256);
        const bytes = readParentAuditProofBytes(root, output, outputHash);
        if (bytes.length !== record.output_artifact_size_bytes) throw new Error('Composition output size differs.');
        assertNativeSourceAuthentication(root, record);
        readParentAuditProofRecord(root, file, request.artifactSha256);
        readParentAuditProofBytes(root, output, outputHash);
        if (JSON.stringify(currentCompositionSource(root, request.source)) !== JSON.stringify(source)) {
            throw new Error('Composition source changed during proof consumption.');
        }
        assertNativeSourceAuthentication(root, record);
        assertContainedDestination(identity);
        assertContainedDestination(outputIdentity);
        assertTaskTimelineReadSnapshotCurrent(timeline, timelineHash);
        return { taskId: request.taskId, command: request.command, processStatus: 'PASSED', outputSha256: outputHash };
    });
}
