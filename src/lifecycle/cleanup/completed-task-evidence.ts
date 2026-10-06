import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { resolveBundleName } from '../../core/constants';
import { fileSha256 } from '../../core/file-hashing';
import { runGit, runGitBinary } from '../../core/git-helpers';
import { TASK_QUEUE_FILENAME } from '../../core/orchestration-constants';
import { assertCanonicalTaskId } from '../../core/task-ids';
import { parseCanonicalActiveTaskQueue } from '../../core/task-md-table';
import { parseTaskQueueEntriesFromContent, type TaskQueueEntry } from '../../core/task-queue-read';
import { readTaskQueueStatusToken } from '../../core/active-task-state';
import { readTaskTimelineJsonlEntries } from '../../gate-runtime/task-events';
import { resolveTaskHistoryLedgerPath } from '../../gate-runtime/task-history-ledger';
import { buildTaskAuditSummary, type TaskAuditSummaryResult } from '../../gates/task-audit/task-audit-summary';
import {
    isLocalControlPlaneCommitPath, readPostDoneAuditedScopeFingerprint, resolveCommittableChangedFiles
} from '../../gates/task-audit/task-audit-summary-drift';

const MAX_COMPACT_EVIDENCE_BYTES = 4 * 1024 * 1024;
const GIT_EVIDENCE_TIMEOUT_MS = 60_000;
const MAX_COMMITTED_SCOPE_FILES = 256;
const MAX_GIT_SCOPE_ARGUMENT_CHARACTERS = 24 * 1024;
const GIT_BATCH_HEADER_BYTES = 128;
const MISSING_FILE_BINDING = 'missing';
const HASH_PATTERN = /^[0-9a-f]{64}$/u;
const RESTART_EVENTS = new Set([
    'TASK_MODE_ENTERED', 'PREFLIGHT_CLASSIFIED', 'IMPLEMENTATION_STARTED',
    'COMPILE_GATE_PASSED', 'REVIEW_PHASE_STARTED', 'REWORK_STARTED',
    'TASK_RESET', 'COHERENT_CYCLE_RESTARTED', 'REVIEW_CYCLE_RESTARTED'
]);

export interface CompletedTaskEvidenceOptions {
    repoRoot: string;
    taskId: string;
    requireCommittedScope?: boolean;
}

export interface CompletedTaskEvidence {
    eligible: boolean;
    reasons: string[];
    task_id: string;
    repo_root: string;
    commit_sha: string | null;
    completion_event_sha256: string | null;
    evidence_sha256: string | null;
}

interface TerminalQueueSnapshot {
    path: string;
    hash: string;
    entries: ReadonlyMap<string, TaskQueueEntry>;
    duplicateIds: ReadonlySet<string>;
}

function canonicalPath(value: string): string {
    const resolved = path.resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function readContainedFileStat(repoRoot: string, file: string): fs.Stats | null {
    const relative = path.relative(repoRoot, file);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error('Completed evidence must remain inside its workspace.');
    }
    let current = repoRoot;
    let stat: fs.Stats | null = null;
    for (const segment of relative.split(path.sep)) {
        current = path.join(current, segment);
        try {
            stat = fs.lstatSync(current);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
            throw error;
        }
        if (stat.isSymbolicLink()) throw new Error('Completed evidence contains a symbolic link.');
    }
    return stat;
}

function assertEvidenceFile(repoRoot: string, file: string): void {
    const stat = readContainedFileStat(repoRoot, file);
    if (!stat?.isFile() || stat.nlink !== 1) throw new Error('Completed evidence must be a regular unshared file.');
}

function readCompactJson(repoRoot: string, file: string): { value: Record<string, unknown>; hash: string } {
    assertEvidenceFile(repoRoot, file);
    if (fs.statSync(file).size > MAX_COMPACT_EVIDENCE_BYTES) throw new Error('Compact completed evidence exceeds its read budget.');
    const contents = fs.readFileSync(file, 'utf8');
    const hash = createHash('sha256').update(contents).digest('hex');
    if (evidenceFileHash(file) !== hash) throw new Error('Compact completed evidence changed while being read.');
    const value: unknown = JSON.parse(contents);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Compact completed evidence must be an object.');
    return { value: value as Record<string, unknown>, hash };
}

function evidenceFileHash(file: string): string {
    const hash = fileSha256(file);
    if (!hash || !HASH_PATTERN.test(hash)) throw new Error('Completed evidence cannot be hashed.');
    return hash;
}

function currentCompletionHash(timelinePath: string): string {
    const events = readTaskTimelineJsonlEntries(timelinePath).map(entry => entry.record);
    let completionHash: string | null = null;
    let latestStatus: string | null = null;
    for (const event of events) {
        if (!event) throw new Error('Completed timeline contains invalid evidence.');
        const type = String(event.event_type || '').toUpperCase();
        const outcome = String(event.outcome || '').toUpperCase();
        if (RESTART_EVENTS.has(type) || type.endsWith('_FAILED') || type === 'TASK_BLOCKED'
            || outcome === 'FAIL' || outcome === 'BLOCKED') completionHash = null;
        if (type === 'STATUS_CHANGED') {
            latestStatus = readTaskQueueStatusToken(String((event.details as Record<string, unknown> | undefined)?.new_status || ''));
            if (latestStatus !== 'DONE') completionHash = null;
        }
        if (type === 'COMPLETION_GATE_PASSED' && outcome === 'PASS') {
            const hash = (event.integrity as Record<string, unknown> | undefined)?.event_sha256;
            completionHash = typeof hash === 'string' && HASH_PATTERN.test(hash) ? hash : null;
        }
    }
    if (!completionHash || latestStatus !== 'DONE') throw new Error('No current successful terminal completion survives later lifecycle changes.');
    return completionHash;
}

function verifyCompactLedger(
    repoRoot: string,
    bundleRoot: string,
    taskId: string,
    audit: TaskAuditSummaryResult,
    closeoutHash: string
): Map<string, string> {
    const ledgerPath = resolveTaskHistoryLedgerPath(bundleRoot, taskId);
    const snapshot = readCompactJson(repoRoot, ledgerPath);
    const ledger = snapshot.value;
    const verification = ledger.verification as Record<string, unknown> | undefined;
    if (ledger.schema_version !== 1 || ledger.event_source !== 'task-history-ledger' || ledger.task_id !== taskId
        || ledger.audit_status !== 'PASS' || verification?.status !== 'VERIFIED'
        || !Array.isArray(verification.issues) || verification.issues.length !== 0) {
        throw new Error('Completed ledger is missing verified native audit evidence.');
    }
    const runtimeRoot = path.join(bundleRoot, 'runtime');
    const reviewsRoot = path.join(runtimeRoot, 'reviews');
    const expectedPaths: Record<string, string> = {
        task_events: path.join(runtimeRoot, 'task-events', `${taskId}.jsonl`),
        preflight: path.join(reviewsRoot, `${taskId}-preflight.json`),
        compile_gate: path.join(reviewsRoot, `${taskId}-compile-gate.json`),
        review_gate: path.join(reviewsRoot, `${taskId}-review-gate.json`),
        doc_impact: path.join(reviewsRoot, `${taskId}-doc-impact.json`),
        full_suite_validation: path.join(reviewsRoot, `${taskId}-full-suite-validation.json`),
        project_memory_impact: path.join(runtimeRoot, 'project-memory', `${taskId}-impact.json`),
        final_closeout_json: path.join(reviewsRoot, `${taskId}-final-closeout.json`),
        final_closeout_markdown: path.join(reviewsRoot, `${taskId}-final-closeout.md`)
    };
    const required = new Set(['task_events', 'preflight', 'final_closeout_json', 'final_closeout_markdown']);
    const gateRefs: Record<string, string> = {
        'compile-gate': 'compile_gate', 'required-reviews-check': 'review_gate', 'doc-impact-gate': 'doc_impact',
        'full-suite-validation': 'full_suite_validation', 'project-memory-impact': 'project_memory_impact'
    };
    for (const gate of audit.gates) if (gate.status === 'PASS' && gateRefs[gate.gate]) required.add(gateRefs[gate.gate]);
    const refs = ledger.artifact_refs as Record<string, Record<string, unknown>> | undefined;
    if (!refs || typeof refs !== 'object' || Array.isArray(refs)) throw new Error('Completed ledger has no canonical artifact references.');
    const hashes = new Map<string, string>([[ledgerPath, snapshot.hash]]);
    for (const [key, expectedPath] of Object.entries(expectedPaths)) {
        const ref = refs[key];
        if (!ref || typeof ref.path !== 'string' || canonicalPath(ref.path) !== canonicalPath(expectedPath)) {
            throw new Error(`Completed ledger reference ${key} belongs to another workspace or path.`);
        }
        if (ref.exists !== true) {
            if (required.has(key) || ref.exists !== false || ref.sha256 !== null || fs.existsSync(expectedPath)) {
                throw new Error(`Completed ledger reference ${key} is missing or contradictory.`);
            }
            continue;
        }
        assertEvidenceFile(repoRoot, expectedPath);
        const hash = evidenceFileHash(expectedPath);
        if (typeof ref.sha256 !== 'string' || !HASH_PATTERN.test(ref.sha256) || ref.sha256 !== hash
            || (key === 'final_closeout_json' && hash !== closeoutHash)) {
            throw new Error(`Completed ledger reference ${key} changed after accepted closeout.`);
        }
        hashes.set(expectedPath, hash);
    }
    return hashes;
}

function verifyMaterializedCloseout(repoRoot: string, taskId: string, audit: TaskAuditSummaryResult) {
    const snapshot = readCompactJson(repoRoot, audit.final_closeout.artifact_paths.json);
    const closeout = snapshot.value;
    if (closeout.schema_version !== 1 || closeout.event_source !== 'task-audit-summary' || closeout.task_id !== taskId
        || closeout.audit_status !== 'PASS' || closeout.status !== 'READY' || closeout.artifact_state !== 'MATERIALIZED') {
        throw new Error('Current native closeout has not been successfully materialized.');
    }
    if (JSON.stringify(closeout.cycle_binding) !== JSON.stringify(audit.final_closeout.cycle_binding)) {
        throw new Error('Materialized closeout belongs to another task cycle.');
    }
    const scope = closeout.implementation_summary;
    if (!scope || typeof scope !== 'object' || Array.isArray(scope)) throw new Error('Materialized closeout has no accepted source binding.');
    return { scope: scope as Record<string, unknown>, hash: snapshot.hash };
}

function verifyAcceptedTaskScope(repoRoot: string, audit: TaskAuditSummaryResult, scope: Record<string, unknown>) {
    if (audit.changed_files.length > MAX_COMMITTED_SCOPE_FILES) throw new Error('Accepted task scope exceeds its verification budget.');
    for (const file of audit.changed_files) {
        const sourcePath = path.join(repoRoot, file);
        if (readContainedFileStat(repoRoot, sourcePath)) assertEvidenceFile(repoRoot, sourcePath);
    }
    const expectedContent = scope.worktree_scope_content_sha256 === undefined
        ? scope.scope_content_sha256 : scope.worktree_scope_content_sha256;
    const current = readPostDoneAuditedScopeFingerprint(repoRoot, audit.changed_files, scope);
    if (typeof expectedContent !== 'string' || !HASH_PATTERN.test(expectedContent)
        || typeof scope.changed_files_sha256 !== 'string' || !HASH_PATTERN.test(scope.changed_files_sha256)
        || current.changed_files_sha256 !== scope.changed_files_sha256
        || current.scope_content_sha256 !== expectedContent) {
        throw new Error('Accepted source scope changed after native closeout.');
    }
    return { changed_files_sha256: current.changed_files_sha256, scope_content_sha256: current.scope_content_sha256 };
}

function readTerminalQueueSnapshot(repoRoot: string): TerminalQueueSnapshot {
    const queuePath = path.join(repoRoot, TASK_QUEUE_FILENAME);
    assertEvidenceFile(repoRoot, queuePath);
    const contents = fs.readFileSync(queuePath, 'utf8');
    const hash = createHash('sha256').update(contents).digest('hex');
    const seen = new Set<string>(), duplicateIds = new Set<string>();
    for (const row of parseCanonicalActiveTaskQueue(contents).rows) {
        if (seen.has(row.taskId)) duplicateIds.add(row.taskId);
        seen.add(row.taskId);
    }
    if (evidenceFileHash(queuePath) !== hash) throw new Error('Task queue changed while its snapshot was read.');
    return { path: queuePath, hash, entries: parseTaskQueueEntriesFromContent(contents), duplicateIds };
}

function readAcceptedAudit(repoRoot: string, taskId: string, queue: TerminalQueueSnapshot): TaskAuditSummaryResult {
    const audit = buildTaskAuditSummary({ repoRoot, taskId, taskQueueEntries: queue.entries });
    if (audit.status !== 'PASS' || audit.integrity_status !== 'PASS'
        || audit.point_in_time_snapshot.status !== 'STABLE' || audit.final_closeout.status !== 'READY') {
        throw new Error(`Current native task audit does not accept closeout: ${audit.blockers.map(blocker => blocker.gate).join(', ') || audit.status}.`);
    }
    return audit;
}

interface CommittedBlobRequest { file: string; objectId: string; hash: string; bytes: number; }

function readCommittedTree(repoRoot: string, head: string, files: readonly string[]): Map<string, string> {
    const args = ['--literal-pathspecs', 'ls-tree', '-z', '--full-tree', head, '--', ...files];
    if (args.join(' ').length > MAX_GIT_SCOPE_ARGUMENT_CHARACTERS) throw new Error('Committed scope exceeds its Git argument budget.');
    const output = runGit(repoRoot, args, { timeoutMs: GIT_EVIDENCE_TIMEOUT_MS, maxBuffer: MAX_COMPACT_EVIDENCE_BYTES });
    const wanted = new Set(files), entries = new Map<string, string>();
    for (const entry of output.split('\0').filter(Boolean)) {
        const metadata = /^[0-7]{6} (?:blob|tree|commit) (?:[0-9a-f]{40}|[0-9a-f]{64})\t([\s\S]+)$/u.exec(entry);
        if (!metadata || !wanted.has(metadata[1]!) || entries.has(metadata[1]!)) throw new Error('Git returned unexpected committed tree evidence.');
        entries.set(metadata[1]!, entry);
    }
    return entries;
}

function verifyCommittedBlobBatch(repoRoot: string, requests: readonly CommittedBlobRequest[]): void {
    const output = runGitBinary(repoRoot, ['cat-file', '--batch'], {
        input: requests.map(request => request.objectId).join('\n') + '\n',
        timeoutMs: GIT_EVIDENCE_TIMEOUT_MS,
        maxBuffer: MAX_COMPACT_EVIDENCE_BYTES + requests.length * GIT_BATCH_HEADER_BYTES
    });
    let offset = 0;
    for (const request of requests) {
        const headerEnd = output.indexOf(0x0a, offset);
        const header = headerEnd < 0 ? null : /^([0-9a-f]{40}|[0-9a-f]{64}) blob (0|[1-9][0-9]*)$/u
            .exec(output.subarray(offset, headerEnd).toString('ascii'));
        const bytes = Number(header?.[2]);
        if (!header || header[1] !== request.objectId || !Number.isSafeInteger(bytes) || bytes !== request.bytes) {
            throw new Error(`Git returned unexpected committed blob evidence: ${request.file}.`);
        }
        const contentStart = headerEnd + 1, contentEnd = contentStart + bytes;
        if (contentEnd >= output.length || output[contentEnd] !== 0x0a) throw new Error('Git returned truncated committed blob evidence.');
        if (createHash('sha256').update(output.subarray(contentStart, contentEnd)).digest('hex') !== request.hash) {
            throw new Error(`Accepted file content differs from its commit: ${request.file}.`);
        }
        offset = contentEnd + 1;
    }
    if (offset !== output.length) throw new Error('Git returned unexpected trailing committed blob evidence.');
}

function verifyCommittedTaskFiles(repoRoot: string, head: string, audit: TaskAuditSummaryResult, hashes: Map<string, string>): void {
    const files = audit.changed_files.filter(file => !isLocalControlPlaneCommitPath(file));
    if (files.length > MAX_COMMITTED_SCOPE_FILES) throw new Error('Committed task scope exceeds its verification budget.');
    if (files.length === 0) return;
    const tree = readCommittedTree(repoRoot, head, files);
    let batch: CommittedBlobRequest[] = [], batchBytes = 0;
    for (const file of files) {
        const sourcePath = path.join(repoRoot, file);
        const stat = readContainedFileStat(repoRoot, sourcePath), entry = tree.get(file);
        if (!stat) {
            if (entry) throw new Error(`Accepted deletion is not committed: ${file}.`);
            hashes.set(sourcePath, MISSING_FILE_BINDING);
            continue;
        }
        assertEvidenceFile(repoRoot, sourcePath);
        const metadata = /^100(?:644|755) blob ([0-9a-f]{40}|[0-9a-f]{64})\t([\s\S]+)$/u.exec(entry || '');
        if (!metadata || metadata[2] !== file) throw new Error(`Accepted file is not a regular committed blob: ${file}.`);
        if (!Number.isSafeInteger(stat.size) || stat.size > MAX_COMPACT_EVIDENCE_BYTES) throw new Error('Committed blob exceeds its byte budget.');
        if (batchBytes + stat.size > MAX_COMPACT_EVIDENCE_BYTES) {
            verifyCommittedBlobBatch(repoRoot, batch); batch = []; batchBytes = 0;
        }
        const hash = evidenceFileHash(sourcePath);
        batch.push({ file, objectId: metadata[1]!, hash, bytes: stat.size });
        batchBytes += stat.size;
        hashes.set(sourcePath, hash);
    }
    if (batch.length > 0) verifyCommittedBlobBatch(repoRoot, batch);
}

function readCommittedTaskHead(repoRoot: string, audit: TaskAuditSummaryResult, hashes: Map<string, string>): string {
    const changedFiles = resolveCommittableChangedFiles(repoRoot);
    if (changedFiles === null || changedFiles.some(file => audit.changed_files.includes(file))) {
        throw new Error('Accepted task scope has not been committed unchanged.');
    }
    const head = runGit(repoRoot, ['rev-parse', '--verify', 'HEAD'], { timeoutMs: GIT_EVIDENCE_TIMEOUT_MS }).trim();
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(head)) throw new Error('Current commit identity is unavailable.');
    verifyCommittedTaskFiles(repoRoot, head, audit, hashes);
    return head;
}

function inspectTaskWithQueue(options: CompletedTaskEvidenceOptions, repoRoot: string, queue: TerminalQueueSnapshot): CompletedTaskEvidence {
    const result: CompletedTaskEvidence = {
        eligible: false, reasons: [], task_id: options.taskId, repo_root: path.resolve(options.repoRoot),
        commit_sha: null, completion_event_sha256: null, evidence_sha256: null
    };
    try {
        const taskId = assertCanonicalTaskId(options.taskId);
        const bundleRoot = path.join(repoRoot, resolveBundleName());
        if (queue.duplicateIds.has(taskId) || readTaskQueueStatusToken(queue.entries.get(taskId)?.status || '') !== 'DONE') {
            throw new Error('Task queue is active, reopened, missing or ambiguous.');
        }
        const timelinePath = path.join(bundleRoot, 'runtime', 'task-events', `${taskId}.jsonl`);
        assertEvidenceFile(repoRoot, timelinePath);
        const timelineHash = evidenceFileHash(timelinePath);
        const completionHash = currentCompletionHash(timelinePath);
        const audit = readAcceptedAudit(repoRoot, taskId, queue);
        const closeout = verifyMaterializedCloseout(repoRoot, taskId, audit);
        const hashes = verifyCompactLedger(repoRoot, bundleRoot, taskId, audit, closeout.hash);
        hashes.set(queue.path, queue.hash);
        if (hashes.get(timelinePath) !== timelineHash) throw new Error('Completed timeline changed during verification.');
        if (options.requireCommittedScope !== false) {
            result.commit_sha = readCommittedTaskHead(repoRoot, audit, hashes);
        }
        for (const [file, hash] of hashes) {
            if (file === queue.path) continue; // The shared canonical queue is revalidated once before batch publication.
            if (hash === MISSING_FILE_BINDING) {
                if (readContainedFileStat(repoRoot, file)) throw new Error('Accepted deletion changed during verification.');
                continue;
            }
            assertEvidenceFile(repoRoot, file);
            if (evidenceFileHash(file) !== hash) throw new Error('Completed evidence changed during verification.');
        }
        if (result.commit_sha && runGit(repoRoot, ['rev-parse', '--verify', 'HEAD'], {
            timeoutMs: GIT_EVIDENCE_TIMEOUT_MS
        }).trim() !== result.commit_sha) throw new Error('Current commit changed during verification.');
        const acceptedScope = verifyAcceptedTaskScope(repoRoot, audit, closeout.scope);
        result.repo_root = repoRoot;
        result.completion_event_sha256 = completionHash;
        result.evidence_sha256 = createHash('sha256').update(JSON.stringify({
            repo_root: canonicalPath(repoRoot), task_id: taskId, completion_event_sha256: completionHash,
            commit_sha: result.commit_sha, accepted_scope: acceptedScope,
            hashes: [...hashes].sort(([left], [right]) => left.localeCompare(right))
        })).digest('hex');
        result.eligible = true;
    } catch (error) {
        result.reasons.push(error instanceof Error ? error.message : 'Completed evidence is unavailable.');
    }
    return result;
}

/** Shares only a private, invocation-owned queue snapshot; no caller-supplied success authority is accepted. */
export function inspectCompletedTaskEvidenceBatch(options: {
    repoRoot: string; taskIds: readonly string[]; requireCommittedScope?: boolean;
}): ReadonlyMap<string, CompletedTaskEvidence> {
    const results = new Map<string, CompletedTaskEvidence>();
    if (options.taskIds.length === 0) return results;
    try {
        const repoRoot = fs.realpathSync.native(path.resolve(options.repoRoot));
        const queue = readTerminalQueueSnapshot(repoRoot);
        for (const taskId of new Set(options.taskIds)) {
            results.set(taskId, inspectTaskWithQueue({ ...options, taskId }, repoRoot, queue));
        }
        assertEvidenceFile(repoRoot, queue.path);
        if (evidenceFileHash(queue.path) !== queue.hash) throw new Error('Task queue changed during completed evidence verification.');
    } catch (error) {
        const reason = error instanceof Error ? error.message : 'Completed evidence is unavailable.';
        for (const taskId of new Set(options.taskIds)) results.set(taskId, {
            eligible: false, reasons: [reason], task_id: taskId, repo_root: path.resolve(options.repoRoot),
            commit_sha: null, completion_event_sha256: null, evidence_sha256: null
        });
    }
    return results;
}

/** A read-only proof; removal must revalidate this binding under its mutation locks. */
export function inspectCompletedTaskEvidence(options: CompletedTaskEvidenceOptions): CompletedTaskEvidence {
    return inspectCompletedTaskEvidenceBatch({ ...options, taskIds: [options.taskId] }).get(options.taskId)!;
}
