import * as fs from 'node:fs';
import * as path from 'node:path';
import { formatActiveTaskQueueTable, parseCanonicalActiveTaskQueue, parseTaskMdTableRow, replaceTaskMdTableCell } from '../../core/task-md-table';
import { formatTaskQueueStatusCell } from '../../core/active-task-state';
import { readTaskQueueStatusToken } from '../../core/task-queue/task-queue-status';
import { assertValidTaskId, inspectTaskEventFile } from '../../gate-runtime/task-events';
import { isPlainRecord } from '../../core/records';
import { serializeSemanticCycleValue } from '../semantic-cycle-resume/semantic-cycle-snapshot';
import { readCurrentGitWorkspaceSnapshot } from '../scope/docs-only-delta-readiness';
import { getWorkspaceSnapshot } from '../compile/compile-gate';
import { readHeadSha } from '../workspace/workspace-snapshot-cache';
import { getSafeWorktreePathState } from '../workspace/worktree-path-state';
import { fileSha256, stringSha256, getProtectedControlPlaneRoots, scanProtectedPathHashes, joinOrchestratorPath,
    isPathRealpathInsideRoot, normalizePath } from '../shared/helpers';
import { buildOrchestratorDefectCaptureSummary, type OrchestratorDefectCaptureRecord } from '../task-audit/task-audit-summary-orchestrator-defects';
import type { TaskAuditSummaryResult } from '../task-audit/task-audit-summary-types';
import { collectOrderedTimelineEvents } from './completion-evidence';
import { withTaskTimelineFileReadSnapshot } from '../../gate-runtime/timeline/task-timeline-read-snapshot';
export class CloseoutLinkageFailure extends Error {
    constructor(message: string, readonly defects: OrchestratorDefectCaptureRecord[]) {
        super(message);
    }
}

interface RecoverySnapshot {
    schema_version: 1;
    task_id: string;
    preflight_path: string;
    state_sha256: string;
    task_rows: Record<string, string>;
}

interface LinkageRecoveryProof extends RecoverySnapshot { defects: OrchestratorDefectCaptureRecord[]; }
export interface CloseoutRecoveryEventSignature {
    event_type: string;
    detail_subset: Record<string, string>;
}
const recoveryOutput = /-(?:final-closeout|final-user-report|completion-gate)(?:\.|-)/u;
const recoveryBindingChanged = 'Closeout metadata recovery bindings changed during finalization.';

function bindReferencedFiles(repoRoot: string, taskId: string, value: unknown, files: Record<string, string>): void {
    if (Array.isArray(value)) {
        for (const entry of value) bindReferencedFiles(repoRoot, taskId, entry, files);
    } else if (isPlainRecord(value)) {
        for (const [key, entry] of Object.entries(value)) {
            if ((key === 'path' || key.endsWith('_path')) && typeof entry === 'string' && entry) {
                const filePath = path.resolve(repoRoot, entry);
                // These two mutable inputs are reconstructed canonically rather than byte-bound.
                if (filePath === path.join(repoRoot, 'TASK.md')
                    || filePath === joinOrchestratorPath(repoRoot, `runtime/task-events/${taskId}.jsonl`)) continue;
                if (!isPathRealpathInsideRoot(filePath, repoRoot, { allowMissing: true }) || recoveryOutput.test(path.basename(filePath))) continue;
                const relativePath = normalizePath(path.relative(repoRoot, filePath));
                if (!fs.existsSync(filePath)) files[relativePath] = '<missing>';
                else if (fs.statSync(filePath).isFile()) {
                    const hash = fileSha256(filePath);
                    if (!hash) throw new Error('Referenced evidence changed or is unreadable.');
                    files[relativePath] = hash;
                }
            } else bindReferencedFiles(repoRoot, taskId, entry, files);
        }
    }
}

function taskIdMatches(text: string, taskId: string): RegExpExecArray[] {
    const id = taskId.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    return [...text.matchAll(new RegExp(`(^|[^A-Za-z0-9-])(${id})(?=$|[^A-Za-z0-9-])`, 'gu'))];
}

function readTaskDocumentBinding(repoRoot: string, taskId: string, originalRows?: Record<string, string>): string {
    const content = fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8');
    const rows = new Map(parseCanonicalActiveTaskQueue(content).rows.map(row => [row.lineIndex, row]));
    const events = collectOrderedTimelineEvents(joinOrchestratorPath(repoRoot, `runtime/task-events/${taskId}.jsonl`), []);
    const records = buildOrchestratorDefectCaptureSummary({ repoRoot, taskId, events: events.map(event => ({ ...event })) }).records;
    const followUps = new Set(records.map(record => record.follow_up_task_id));
    let problemSectionLevel: number | null = null;
    let problemSectionFound = false;
    return content.split('\n').map((line, index) => {
        const row = rows.get(index);
        if (row) {
            if (originalRows && !Object.hasOwn(originalRows, row.taskId) && followUps.has(row.taskId)
                && readTaskQueueStatusToken(row.cells[1].trimmed) === 'TODO') return null;
            return `<task-row:${row.taskId}>${line.endsWith('\r') ? '\r' : ''}`;
        }
        const heading = /^(#{1,6})\s+(.+?)\s*$/u.exec(line.trim());
        if (heading) {
            if (problemSectionLevel !== null && heading[1].length <= problemSectionLevel) problemSectionLevel = null;
            const title = heading[2].toLowerCase();
            if (!problemSectionFound && (title === 'найденные проблемы оркестратора'
                || (/orchestrator/u.test(title) && /(defect|problem)/u.test(title)))) {
                problemSectionFound = true;
                problemSectionLevel = heading[1].length;
            }
        }
        if (problemSectionLevel === null || !/^\s*-\s/u.test(line)) return line;
        const ownerText = line.replace(/^\s*-\s+(?:Problem record\s+)?[`*\[]*/u, '');
        for (const record of records) {
            if (!record.problem_record_id || !record.follow_up_task_id) continue;
            const owner = taskIdMatches(ownerText, record.problem_record_id)[0];
            if (!owner || owner.index !== 0 || owner[1] !== '') continue;
            const matches = taskIdMatches(line, record.follow_up_task_id);
            const last = matches[matches.length - 1];
            if (last) {
                const index = last.index + last[1].length;
                line = line.slice(0, index) + '<follow-up>' + line.slice(index + last[2].length);
            }
        }
        return line;
    }).filter(line => line !== null).join('\n');
}

function readTaskRows(repoRoot: string): Record<string, string> {
    if (!isPathRealpathInsideRoot(path.join(repoRoot, 'TASK.md'), repoRoot)) throw new Error('Task queue escapes the workspace.');
    const queue = parseCanonicalActiveTaskQueue(fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8'));
    if (!queue.found || queue.rows.length === 0) throw new Error('Canonical task queue is unavailable.');
    const rows: Record<string, string> = {};
    for (const row of queue.rows) {
        if (Object.hasOwn(rows, row.taskId)) throw new Error('Duplicate task row.');
        rows[row.taskId] = row.rawLine;
    }
    return rows;
}

function readRecoveryState(repoRoot: string, taskId: string, preflightPath: string,
    taskBinding: { verifiedDocument?: string; originalRows?: Record<string, string> } = {}): string {
    const observedWorkspace = readCurrentGitWorkspaceSnapshot(repoRoot, true);
    const head = readHeadSha(repoRoot);
    if (!observedWorkspace || !head || !isPathRealpathInsideRoot(preflightPath, repoRoot)) {
        throw new Error('Recovery needs a current Git workspace and contained preflight.');
    }
    const workspace = getWorkspaceSnapshot(repoRoot, 'explicit_changed_files', true,
        observedWorkspace.changed_files.filter(file => file !== 'TASK.md'));
    const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
    if (preflight.task_id !== taskId || !Array.isArray(preflight.changed_files) || preflight.changed_files.includes('TASK.md')) {
        throw new Error('Recovery requires a task-bound source scope independent of task metadata.');
    }
    const checkedFiles: Record<string, unknown> = {};
    for (const file of preflight.changed_files) {
        if (typeof file !== 'string') throw new Error('Invalid checked source path.');
        const state = getSafeWorktreePathState(repoRoot, file, { includeContentHashes: true, distinguishAccessErrors: true });
        if (!['file', 'missing'].includes(state.status) || (state.status === 'file' && !state.sha256)) {
            throw new Error('Checked source cannot be safely reconstructed.');
        }
        checkedFiles[file] = state;
    }
    const roots = [...getProtectedControlPlaneRoots(repoRoot), 'VERSION', joinOrchestratorPath(repoRoot, 'VERSION'), 'live/config/', 'live/skills/',
        joinOrchestratorPath(repoRoot, 'live/config/'), joinOrchestratorPath(repoRoot, 'live/skills/')];
    const protectedFiles = scanProtectedPathHashes(repoRoot, roots, { readOnly: true, noCache: true });
    const artifacts: Record<string, string> = {};
    for (const directory of [path.dirname(preflightPath), joinOrchestratorPath(repoRoot, 'runtime/project-memory')]) {
        if (!fs.existsSync(directory)) continue;
        for (const name of fs.readdirSync(directory).sort()) {
            if (!name.startsWith(`${taskId}-`) || recoveryOutput.test(name) || !/\.(?:json|md|log)$/u.test(name)) continue;
            const artifactPath = path.join(directory, name);
            if (!isPathRealpathInsideRoot(artifactPath, repoRoot)) throw new Error('Recovery artifact escapes the workspace.');
            const hash = fileSha256(artifactPath);
            if (!hash) throw new Error('Recovery artifact is unreadable or changed while hashing.');
            artifacts[normalizePath(path.relative(repoRoot, artifactPath))] = hash;
            if (name.endsWith('.json')) bindReferencedFiles(repoRoot, taskId, JSON.parse(fs.readFileSync(artifactPath, 'utf8')), artifacts);
        }
    }
    const preflightHash = fileSha256(preflightPath);
    if (!preflightHash) throw new Error('Recovery preflight is unreadable.');
    const runtimeRoot = path.resolve(__dirname, '../..');
    const runtime = { root: runtimeRoot, node: process.version, platform: process.platform, architecture: process.arch,
        files: scanProtectedPathHashes(runtimeRoot, ['.'], { readOnly: true, noCache: true }) };
    const taskDocument = taskBinding.verifiedDocument ?? readTaskDocumentBinding(repoRoot, taskId, taskBinding.originalRows);
    return stringSha256(serializeSemanticCycleValue({ head, workspace, checkedFiles, protectedFiles, runtime, artifacts, preflightHash, taskDocument })) as string;
}
function assertRecoveryTimeline(repoRoot: string, proof: LinkageRecoveryProof, prefix: string,
    expectedEvents: readonly CloseoutRecoveryEventSignature[]): void {
    const timelinePath = joinOrchestratorPath(repoRoot, `runtime/task-events/${proof.task_id}.jsonl`);
    const content = fs.readFileSync(timelinePath, 'utf8');
    const suffix = content.slice(prefix.length).split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>);
    const capture = buildOrchestratorDefectCaptureSummary({ repoRoot, taskId: proof.task_id,
        events: content.split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>) });
    if (!content.startsWith(prefix) || inspectTaskEventFile(timelinePath, proof.task_id).status !== 'PASS'
        || suffix.length !== expectedEvents.length || suffix.some((event, index) => {
            const expected = expectedEvents[index];
            const details = isPlainRecord(event.details) ? event.details : {};
            return event.task_id !== proof.task_id
                || event.actor !== (expected.event_type === 'STATUS_CHANGED' ? 'orchestrator' : 'gate')
                || event.event_type !== expected.event_type
                || event.outcome !== (expected.event_type === 'STATUS_CHANGED' ? 'INFO' : 'PASS')
                || Object.entries(expected.detail_subset).some(([key, value]) => String(details[key] ?? '').trim() !== value);
        }) || capture.status !== 'CAPTURED' || !correctedRecordsAreBound(proof.defects, capture.records)
        || fs.readFileSync(timelinePath, 'utf8') !== content) throw new Error(recoveryBindingChanged);
}

export function buildCloseoutRecoveryFinalizationVerifier(repoRoot: string, proof: LinkageRecoveryProof):
    (expectedEvents: readonly CloseoutRecoveryEventSignature[]) => void {
    const taskPath = path.join(repoRoot, 'TASK.md');
    const content = fs.readFileSync(taskPath, 'utf8');
    const rows = parseCanonicalActiveTaskQueue(content).rows;
    if (new Set(rows.map(row => row.taskId)).size !== rows.length
        || Object.entries(proof.task_rows).some(([id, raw]) => rows.find(row => row.taskId === id)?.rawLine !== raw)) {
        throw new Error(recoveryBindingChanged);
    }
    const row = rows.find(candidate => candidate.taskId === proof.task_id);
    if (!row) throw new Error('Recovery task row is unavailable.');
    const doneRow = replaceTaskMdTableCell(row.rawLine, 1, formatTaskQueueStatusCell(row.cells[1].raw, 'DONE'));
    if (!doneRow) throw new Error('Recovery task status cannot be reconstructed.');
    const lines = content.split(/\r?\n/u);
    lines[row.lineIndex] = doneRow;
    const expected = formatActiveTaskQueueTable(lines.join(content.includes('\r\n') ? '\r\n' : '\n'));
    const taskDocument = readTaskDocumentBinding(repoRoot, proof.task_id, proof.task_rows);
    const timelinePath = joinOrchestratorPath(repoRoot, `runtime/task-events/${proof.task_id}.jsonl`);
    const prefix = fs.readFileSync(timelinePath, 'utf8');
    assertRecoveryTimeline(repoRoot, proof, prefix, []);
    return (expectedEvents) => {
        try {
            assertRecoveryTimeline(repoRoot, proof, prefix, expectedEvents);
            if (fs.readFileSync(taskPath, 'utf8') !== expected || readRecoveryState(repoRoot, proof.task_id, proof.preflight_path,
                { verifiedDocument: taskDocument }) !== proof.state_sha256 || fs.readFileSync(taskPath, 'utf8') !== expected) {
                throw new Error(recoveryBindingChanged);
            }
            assertRecoveryTimeline(repoRoot, proof, prefix, expectedEvents);
        } catch {
            throw new Error(recoveryBindingChanged);
        }
    };
}
export function captureCloseoutRecoverySnapshot(repoRoot: string, taskId: string, preflightPath: string,
    requireInvalidLinkage = false, originalRows?: Record<string, string>): RecoverySnapshot | null {
    try {
        assertValidTaskId(taskId);
        if (requireInvalidLinkage) {
            const events = collectOrderedTimelineEvents(joinOrchestratorPath(repoRoot, `runtime/task-events/${taskId}.jsonl`), []);
            if (buildOrchestratorDefectCaptureSummary({ repoRoot, taskId, events: events.map(event => ({ ...event })) }).status !== 'INVALID') return null;
        }
        return { schema_version: 1, task_id: taskId, preflight_path: normalizePath(path.resolve(preflightPath)),
            state_sha256: readRecoveryState(repoRoot, taskId, preflightPath, { originalRows }), task_rows: readTaskRows(repoRoot) };
    } catch {
        return null;
    }
}
export function buildCloseoutFailure(message: string, summary: TaskAuditSummaryResult): Error {
    const capture = summary.final_closeout.orchestrator_defect_capture;
    return summary.integrity_status === 'PASS' && summary.gates.every(gate => gate.status === 'PASS') && summary.blockers.length === 1
        && summary.blockers[0].gate === 'orchestrator-defect-capture' && capture?.status === 'INVALID'
        ? new CloseoutLinkageFailure(message, capture.records)
        : new Error(message);
}
export function getCloseoutLinkageRecoveryProof(error: unknown, snapshot: RecoverySnapshot | null,
    repoRoot: string): LinkageRecoveryProof | null {
    if (!(error instanceof CloseoutLinkageFailure) || !snapshot) return null;
    const current = captureCloseoutRecoverySnapshot(repoRoot, snapshot.task_id, snapshot.preflight_path, false, snapshot.task_rows);
    return current && serializeSemanticCycleValue(current) === serializeSemanticCycleValue(snapshot)
        ? { ...snapshot, defects: error.defects }
        : null;
}

function correctedRecordsAreBound(original: OrchestratorDefectCaptureRecord[], current: OrchestratorDefectCaptureRecord[]): boolean {
    if (original.length !== current.length || !original.some(record => record.status === 'INVALID')) return false;
    return original.every(record => current.some(candidate => candidate.status === 'CAPTURED'
        && ['defect_id', 'summary', 'resolution', 'problem_record_id'].every(key => (
            record[key as keyof OrchestratorDefectCaptureRecord] === candidate[key as keyof OrchestratorDefectCaptureRecord]
        )) && (record.status === 'INVALID' || record.follow_up_task_id === candidate.follow_up_task_id)));
}
export function readCloseoutLinkageRecovery(repoRoot: string, taskId: string, preflightPath: string,
    timelinePath: string): LinkageRecoveryProof | null {
    try {
        return withTaskTimelineFileReadSnapshot(timelinePath, () => readCloseoutLinkageRecoveryFromSnapshot(repoRoot, taskId, preflightPath, timelinePath));
    } catch {
        return null;
    }
}

function readCloseoutLinkageRecoveryFromSnapshot(repoRoot: string, taskId: string, preflightPath: string,
    timelinePath: string): LinkageRecoveryProof | null {
    try {
        if (inspectTaskEventFile(timelinePath, taskId).status !== 'PASS') return null;
        const errors: string[] = [];
        const events = collectOrderedTimelineEvents(timelinePath, errors);
        const failure = [...events].reverse().find(event => event.event_type === 'COMPLETION_GATE_FAILED');
        const proof = failure?.details?.closeout_linkage_recovery;
        if (errors.length || !failure || failure.details?.outcome !== 'FINALIZATION_FAILED' || !isPlainRecord(proof)
            || proof.schema_version !== 1 || proof.task_id !== taskId
            || proof.preflight_path !== normalizePath(path.resolve(preflightPath))
            || typeof proof.state_sha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(proof.state_sha256)
            || !isPlainRecord(proof.task_rows) || !Array.isArray(proof.defects)) return null;
        const later = events.filter(event => event.sequence > failure.sequence);
        if (!later.some(event => event.event_type === 'ORCHESTRATOR_DEFECT_ACKNOWLEDGED')
            || later.some(event => !['ORCHESTRATOR_DEFECT_ACKNOWLEDGED', 'CLOSEOUT_METADATA_RETRY_STARTED'].includes(event.event_type))) return null;
        const capture = buildOrchestratorDefectCaptureSummary({ repoRoot, taskId, events: events.map(event => ({ ...event })) });
        if (capture.status !== 'CAPTURED' || !correctedRecordsAreBound(proof.defects as OrchestratorDefectCaptureRecord[], capture.records)) return null;
        const current = captureCloseoutRecoverySnapshot(repoRoot, taskId, preflightPath, false, proof.task_rows as Record<string, string>);
        if (!current || current.state_sha256 !== proof.state_sha256) return null;
        if (Object.entries(proof.task_rows).some(([id, row]) => current.task_rows[id] !== row)) return null;
        const followUpIds = new Set(capture.records.map(record => record.follow_up_task_id));
        if (Object.keys(current.task_rows).some(id => !Object.hasOwn(proof.task_rows as object, id)
            && (!followUpIds.has(id) || readTaskQueueStatusToken(parseTaskMdTableRow(current.task_rows[id])[1]?.trimmed ?? null) !== 'TODO'))) return null;
        return proof as unknown as LinkageRecoveryProof;
    } catch {
        return null;
    }
}

