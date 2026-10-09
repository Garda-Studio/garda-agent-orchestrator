import * as fs from 'node:fs';
import * as path from 'node:path';
import * as childProcess from 'node:child_process';

import type { SpawnedProcessInfo } from '../../core/subprocess';
import type { FullSuiteValidationCycleBinding } from './full-suite-validation';
import { ensureContainedDirectory } from '../../core/contained-filesystem';
import { fileSha256, joinOrchestratorPath, normalizePath, stringSha256 } from '../shared/helpers';
import { issueFullSuiteRunMarkerOwner, updateOwnedFullSuiteRunMarker,
    clearOwnedFullSuiteRunMarker } from './full-suite-validation-run-marker-owner';

export interface FullSuiteValidationRunMarker {
    schema_version: 1;
    task_id: string;
    status: 'running';
    started_at_utc: string;
    updated_at_utc: string;
    repo_root: string;
    cwd: string;
    command: string;
    timeout_ms: number;
    gate_pid: number;
    child_pid: number | null;
    child_command: string | null;
    child_args: string[];
    child_shell: boolean | null;
    preflight_path: string;
    preflight_sha256: string;
    cycle_binding: FullSuiteValidationCycleBinding;
}

export interface FullSuiteValidationInterruptedRunSummary {
    markerPath: string;
    taskId: string;
    startedAtUtc: string;
    updatedAtUtc: string;
    command: string;
    timeoutMs: number;
    gatePid: number;
    gateProcessAlive: boolean | null;
    childPid: number | null;
    childProcessAlive: boolean | null;
    childCommand: string | null;
    descendantProcessCandidates: FullSuiteValidationProcessCandidate[];
    processScanWarning: string | null;
    processCheckWarning?: string | null;
    preflightPath: string;
    preflightSha256: string;
    markerState?: 'CURRENT' | 'STALE';
    markerStateReason?: string;
}

export interface FullSuiteValidationRunMarkerInspection {
    state: 'MISSING' | 'CURRENT' | 'STALE' | 'INVALID';
    reason: string;
    markerPath: string;
    markerSha256: string | null;
    summary: FullSuiteValidationInterruptedRunSummary | null;
}

export interface FullSuiteValidationProcessCandidate {
    pid: number;
    parentPid: number | null;
    processGroupId?: number | null;
    commandLine: string;
}

export interface FullSuiteValidationProcessTableSnapshot {
    entries: FullSuiteValidationProcessCandidate[];
    warning: string | null;
}

export interface FullSuiteValidationRunMarkerInspectionOptions {
    isProcessAlive?: (pid: number | null | undefined) => boolean | null;
    processTableSnapshot?: FullSuiteValidationProcessTableSnapshot;
}

interface WriteRunMarkerOptions {
    repoRoot: string;
    taskId: string;
    command: string;
    cwd: string;
    timeoutMs: number;
    cycleBinding: FullSuiteValidationCycleBinding;
}

export function resolveFullSuiteValidationRunMarkerPath(repoRoot: string, taskId: string): string {
    return joinOrchestratorPath(repoRoot, path.join('runtime', 'reviews', `${taskId}-full-suite-run-marker.json`));
}

export function writeFullSuiteValidationRunMarker(options: WriteRunMarkerOptions): FullSuiteValidationRunMarker {
    const markerPath = resolveFullSuiteValidationRunMarkerPath(options.repoRoot, options.taskId);
    return withFullSuiteValidationRunMarkerMutationLock(options.repoRoot, options.taskId, () => {
        const now = new Date().toISOString();
        const marker: FullSuiteValidationRunMarker = {
            schema_version: 1,
            task_id: options.taskId,
            status: 'running',
            started_at_utc: now,
            updated_at_utc: now,
            repo_root: normalizePath(path.resolve(options.repoRoot)),
            cwd: normalizePath(path.resolve(options.cwd)),
            command: options.command,
            timeout_ms: options.timeoutMs,
            gate_pid: process.pid,
            child_pid: null,
            child_command: null,
            child_args: [],
            child_shell: null,
            preflight_path: options.cycleBinding.preflight_path,
            preflight_sha256: options.cycleBinding.preflight_sha256,
            cycle_binding: options.cycleBinding
        };
        issueFullSuiteRunMarkerOwner(options.repoRoot, markerPath, marker, `${JSON.stringify(marker, null, 2)}\n`);
        return marker;
    });
}

export function updateFullSuiteValidationRunMarkerChildProcess(
    repoRoot: string,
    taskId: string,
    child: SpawnedProcessInfo,
    owner: FullSuiteValidationRunMarker
): void {
    const markerPath = resolveFullSuiteValidationRunMarkerPath(repoRoot, taskId);
    withFullSuiteValidationRunMarkerMutationLock(repoRoot, taskId, () => {
        updateOwnedFullSuiteRunMarker(repoRoot, markerPath, owner, (content) => {
            const marker = JSON.parse(content) as FullSuiteValidationRunMarker;
            marker.updated_at_utc = new Date().toISOString();
            marker.child_pid = child.pid;
            marker.child_command = child.command;
            marker.child_args = child.args.map(String);
            marker.child_shell = child.shell;
            return `${JSON.stringify(marker, null, 2)}\n`;
        });
    });
}

export function clearFullSuiteValidationRunMarker(
    repoRoot: string, taskId: string, owner: FullSuiteValidationRunMarker
): void {
    withFullSuiteValidationRunMarkerMutationLock(repoRoot, taskId, () => {
        clearOwnedFullSuiteRunMarker(repoRoot, resolveFullSuiteValidationRunMarkerPath(repoRoot, taskId), owner);
    });
}

export async function withFullSuiteValidationRunMarkerMutationLockAsync<T>(
    repoRoot: string,
    taskId: string,
    action: () => Promise<T>
): Promise<T> {
    const lock = acquireRunMarkerMutationLock(repoRoot, taskId);
    try {
        return await action();
    } finally {
        releaseRunMarkerMutationLock(lock);
    }
}

interface FullSuiteValidationRunMarkerMutationLock {
    fd: number;
    path: string;
}

function withFullSuiteValidationRunMarkerMutationLock<T>(
    repoRoot: string,
    taskId: string,
    action: () => T
): T {
    const lock = acquireRunMarkerMutationLock(repoRoot, taskId);
    try {
        return action();
    } finally {
        releaseRunMarkerMutationLock(lock);
    }
}

function acquireRunMarkerMutationLock(
    repoRoot: string,
    taskId: string
): FullSuiteValidationRunMarkerMutationLock {
    const markerPath = resolveFullSuiteValidationRunMarkerPath(repoRoot, taskId);
    const lockPath = `${markerPath}.mutation-lock`;
    ensureContainedDirectory(repoRoot, path.dirname(lockPath));
    for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
            const fd = fs.openSync(lockPath, 'wx');
            try {
                fs.writeFileSync(fd, `${JSON.stringify({
                    schema_version: 1,
                    task_id: taskId,
                    owner_pid: process.pid,
                    acquired_at_utc: new Date().toISOString()
                })}\n`, 'utf8');
            } catch (writeError) {
                fs.closeSync(fd);
                fs.rmSync(lockPath, { force: true });
                throw writeError;
            }
            return { fd, path: lockPath };
        } catch (error: unknown) {
            const code = error && typeof error === 'object' && 'code' in error
                ? String((error as { code?: unknown }).code || '').toUpperCase()
                : '';
            if (code !== 'EEXIST') {
                throw error;
            }
            const observedLock = readMutationLockSnapshot(lockPath);
            if (!observedLock) {
                throw new Error(
                    `Full-suite run marker mutation lock owner is not safely verifiable: ${normalizePath(lockPath)}`
                );
            }
            const ownerAlive = isProcessAlive(observedLock.ownerPid);
            if (ownerAlive !== false) {
                const state = ownerAlive === true ? 'alive' : 'not safely verifiable';
                throw new Error(
                    `Full-suite run marker mutation is locked by owner pid ${observedLock.ownerPid} (${state}): ${normalizePath(lockPath)}`
                );
            }
            const recoveryGuard = acquireStaleLockRecoveryGuard(lockPath, taskId);
            try {
                const currentLock = readMutationLockSnapshot(lockPath);
                if (!currentLock) {
                    continue;
                }
                if (
                    currentLock.contentSha256 !== observedLock.contentSha256
                    || currentLock.ownerPid !== observedLock.ownerPid
                ) {
                    continue;
                }
                const currentOwnerAlive = isProcessAlive(currentLock.ownerPid);
                if (currentOwnerAlive !== false) {
                    const state = currentOwnerAlive === true ? 'alive' : 'not safely verifiable';
                    throw new Error(
                        `Full-suite run marker mutation lock owner changed state during stale recovery `
                        + `(pid ${currentLock.ownerPid}, ${state}): ${normalizePath(lockPath)}`
                    );
                }
                fs.rmSync(lockPath, { force: true });
            } finally {
                releaseRunMarkerMutationLock(recoveryGuard);
            }
        }
    }
    throw new Error(`Unable to acquire full-suite run marker mutation lock: ${normalizePath(lockPath)}`);
}

function readMutationLockSnapshot(
    lockPath: string
): { ownerPid: number; contentSha256: string } | null {
    try {
        const content = fs.readFileSync(lockPath, 'utf8');
        const lock = JSON.parse(content) as Record<string, unknown>;
        const ownerPid = Number(lock.owner_pid);
        const contentSha256 = stringSha256(content);
        return Number.isInteger(ownerPid) && ownerPid > 0 && contentSha256
            ? { ownerPid, contentSha256 }
            : null;
    } catch {
        return null;
    }
}

function acquireStaleLockRecoveryGuard(
    lockPath: string,
    taskId: string
): FullSuiteValidationRunMarkerMutationLock {
    const recoveryPath = `${lockPath}.stale-recovery`;
    let fd: number;
    try {
        fd = fs.openSync(recoveryPath, 'wx');
    } catch (error: unknown) {
        const code = error && typeof error === 'object' && 'code' in error
            ? String((error as { code?: unknown }).code || '').toUpperCase()
            : '';
        if (code === 'EEXIST') {
            throw new Error(
                `Full-suite run marker stale-lock recovery is already in progress or requires operator maintenance: `
                + normalizePath(recoveryPath)
            );
        }
        throw error;
    }
    try {
        fs.writeFileSync(fd, `${JSON.stringify({
            schema_version: 1,
            task_id: taskId,
            owner_pid: process.pid,
            acquired_at_utc: new Date().toISOString()
        })}\n`, 'utf8');
    } catch (error) {
        fs.closeSync(fd);
        fs.rmSync(recoveryPath, { force: true });
        throw error;
    }
    return { fd, path: recoveryPath };
}

function releaseRunMarkerMutationLock(lock: FullSuiteValidationRunMarkerMutationLock): void {
    try {
        fs.closeSync(lock.fd);
    } finally {
        fs.rmSync(lock.path, { force: true });
    }
}

export function readInterruptedFullSuiteValidationRunMarker(
    repoRoot: string,
    taskId: string,
    preflightPath: string,
    preflightSha256?: string | null,
    expectedCompileGateTimestamp?: string | null,
    inspectionOptions: FullSuiteValidationRunMarkerInspectionOptions = {}
): FullSuiteValidationInterruptedRunSummary | null {
    const inspection = inspectFullSuiteValidationRunMarker(
        repoRoot,
        taskId,
        preflightPath,
        preflightSha256,
        expectedCompileGateTimestamp,
        inspectionOptions
    );
    return inspection.state === 'CURRENT' ? inspection.summary : null;
}

export function readRecoverableFullSuiteValidationRunMarker(
    repoRoot: string,
    taskId: string,
    preflightPath: string,
    preflightSha256?: string | null,
    expectedCompileGateTimestamp?: string | null,
    inspectionOptions: FullSuiteValidationRunMarkerInspectionOptions = {}
): FullSuiteValidationInterruptedRunSummary | null {
    const inspection = inspectFullSuiteValidationRunMarker(
        repoRoot,
        taskId,
        preflightPath,
        preflightSha256,
        expectedCompileGateTimestamp,
        inspectionOptions
    );
    return inspection.summary;
}

export function inspectFullSuiteValidationRunMarker(
    repoRoot: string,
    taskId: string,
    preflightPath: string,
    preflightSha256?: string | null,
    expectedCompileGateTimestamp?: string | null,
    inspectionOptions: FullSuiteValidationRunMarkerInspectionOptions = {}
): FullSuiteValidationRunMarkerInspection {
    const markerPath = resolveFullSuiteValidationRunMarkerPath(repoRoot, taskId);
    let markerContent: string;
    try {
        markerContent = fs.readFileSync(markerPath, 'utf8');
    } catch (error: unknown) {
        const code = error && typeof error === 'object' && 'code' in error
            ? String((error as { code?: unknown }).code || '').toUpperCase()
            : '';
        if (code === 'ENOENT' || code === 'ENOTDIR') {
            return {
                state: 'MISSING',
                reason: 'The full-suite run marker file does not exist.',
                markerPath: normalizePath(markerPath),
                markerSha256: null,
                summary: null
            };
        }
        return {
            state: 'INVALID',
            reason: `The full-suite run marker cannot be read safely: ${error instanceof Error ? error.message : String(error)}`,
            markerPath: normalizePath(markerPath),
            markerSha256: null,
            summary: null
        };
    }
    const markerSha256 = stringSha256(markerContent);

    let marker: FullSuiteValidationRunMarker;
    try {
        marker = JSON.parse(markerContent) as FullSuiteValidationRunMarker;
    } catch (error: unknown) {
        return {
            state: 'INVALID',
            reason: `The full-suite run marker is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
            markerPath: normalizePath(markerPath),
            markerSha256,
            summary: null
        };
    }

    const invalidReason = validateInspectableMarker(marker);
    if (invalidReason) {
        return {
            state: 'INVALID',
            reason: invalidReason,
            markerPath: normalizePath(markerPath),
            markerSha256,
            summary: null
        };
    }

    const expectedPreflightPath = normalizePath(path.resolve(preflightPath));
    const markerPreflightPath = normalizePath(path.resolve(repoRoot, marker.preflight_path));
    const cycleBindingPreflightPath = normalizePath(path.resolve(repoRoot, marker.cycle_binding.preflight_path));
    const expectedPreflightSha256 = preflightSha256 || fileSha256(preflightPath) || '';
    const staleReasons: string[] = [];
    if (marker.task_id !== taskId) {
        staleReasons.push(`task_id mismatch (marker=${marker.task_id}, expected=${taskId})`);
    }
    if (markerPreflightPath !== expectedPreflightPath) {
        staleReasons.push(`preflight_path mismatch (marker=${markerPreflightPath}, expected=${expectedPreflightPath})`);
    }
    if (marker.preflight_sha256 !== expectedPreflightSha256) {
        staleReasons.push(`preflight_sha256 mismatch (marker=${marker.preflight_sha256}, expected=${expectedPreflightSha256})`);
    }
    if (marker.cycle_binding.task_id !== taskId) {
        staleReasons.push(
            `cycle_binding.task_id mismatch (marker=${marker.cycle_binding.task_id}, expected=${taskId})`
        );
    }
    if (cycleBindingPreflightPath !== expectedPreflightPath) {
        staleReasons.push(
            `cycle_binding.preflight_path mismatch (marker=${cycleBindingPreflightPath}, expected=${expectedPreflightPath})`
        );
    }
    if (marker.cycle_binding.preflight_sha256 !== expectedPreflightSha256) {
        staleReasons.push(
            `cycle_binding.preflight_sha256 mismatch (marker=${marker.cycle_binding.preflight_sha256}, expected=${expectedPreflightSha256})`
        );
    }
    if (
        expectedCompileGateTimestamp
        && marker.cycle_binding.compile_gate_timestamp !== expectedCompileGateTimestamp
    ) {
        staleReasons.push(
            `compile_gate_timestamp mismatch (marker=${marker.cycle_binding.compile_gate_timestamp || '<missing>'}, expected=${expectedCompileGateTimestamp})`
        );
    }

    const checkProcessAlive = inspectionOptions.isProcessAlive || isProcessAlive;
    const gateProcessAlive = checkProcessAlive(marker.gate_pid);
    const childProcessAlive = marker.child_pid == null ? null : checkProcessAlive(marker.child_pid);
    const processCheckWarning = gateProcessAlive === null || (marker.child_pid != null && childProcessAlive === null)
        ? 'Unable to verify one or more recorded process identifiers; cleanup must fail closed.'
        : null;
    const processScan = findDescendantProcessCandidates(marker.child_pid, inspectionOptions.processTableSnapshot);
    const state = staleReasons.length > 0 ? 'STALE' : 'CURRENT';
    const reason = staleReasons.length > 0
        ? staleReasons.join('; ')
        : 'The marker is bound to the current preflight and compile cycle.';
    const summary: FullSuiteValidationInterruptedRunSummary = {
        markerPath: normalizePath(markerPath),
        taskId,
        startedAtUtc: marker.started_at_utc,
        updatedAtUtc: marker.updated_at_utc,
        command: marker.command,
        timeoutMs: marker.timeout_ms,
        gatePid: marker.gate_pid,
        gateProcessAlive,
        childPid: marker.child_pid,
        childProcessAlive,
        childCommand: marker.child_command,
        descendantProcessCandidates: processScan.candidates,
        processScanWarning: processScan.warning,
        processCheckWarning,
        preflightPath: marker.preflight_path,
        preflightSha256: marker.preflight_sha256,
        markerState: state,
        markerStateReason: reason
    };
    return {
        state,
        reason,
        markerPath: normalizePath(markerPath),
        markerSha256,
        summary
    };
}

function validateInspectableMarker(marker: FullSuiteValidationRunMarker): string | null {
    if (!marker || typeof marker !== 'object' || Array.isArray(marker)) {
        return 'The full-suite run marker root must be a JSON object.';
    }
    if (marker.schema_version !== 1) {
        return `Unsupported full-suite run marker schema_version: ${String(marker.schema_version)}`;
    }
    if (marker.status !== 'running') {
        return `Unsupported full-suite run marker status: ${String(marker.status)}`;
    }
    if (!String(marker.task_id || '').trim()) {
        return 'The full-suite run marker has no task_id.';
    }
    if (!String(marker.preflight_path || '').trim() || !String(marker.preflight_sha256 || '').trim()) {
        return 'The full-suite run marker has no complete preflight binding.';
    }
    if (!marker.cycle_binding || typeof marker.cycle_binding !== 'object' || Array.isArray(marker.cycle_binding)) {
        return 'The full-suite run marker has no inspectable cycle_binding.';
    }
    if (
        !String(marker.cycle_binding.task_id || '').trim()
        || !String(marker.cycle_binding.preflight_path || '').trim()
        || !String(marker.cycle_binding.preflight_sha256 || '').trim()
    ) {
        return 'The full-suite run marker has no complete cycle_binding identity.';
    }
    if (!Number.isInteger(marker.gate_pid) || marker.gate_pid <= 0) {
        return `The full-suite run marker has no verifiable gate_pid: ${String(marker.gate_pid)}`;
    }
    if (marker.child_pid !== null && (!Number.isInteger(marker.child_pid) || marker.child_pid <= 0)) {
        return `The full-suite run marker has no verifiable child_pid: ${String(marker.child_pid)}`;
    }
    return null;
}

function isProcessAlive(pid: number | null | undefined): boolean | null {
    if (!Number.isInteger(pid) || Number(pid) <= 0) {
        return false;
    }
    try {
        process.kill(Number(pid), 0);
        return true;
    } catch (error: unknown) {
        const code = error && typeof error === 'object' && 'code' in error
            ? String((error as { code?: unknown }).code || '').toUpperCase()
            : '';
        return code === 'ESRCH' ? false : null;
    }
}

function findDescendantProcessCandidates(
    rootPid: number | null | undefined,
    processTableSnapshot?: FullSuiteValidationProcessTableSnapshot
): {
    candidates: FullSuiteValidationProcessCandidate[];
    warning: string | null;
} {
    if (!Number.isInteger(rootPid) || Number(rootPid) <= 0) {
        return { candidates: [], warning: null };
    }
    const table = processTableSnapshot || readProcessTable();
    if (table.warning) {
        return { candidates: [], warning: table.warning };
    }
    const byParent = new Map<number, FullSuiteValidationProcessCandidate[]>();
    for (const entry of table.entries) {
        if (entry.parentPid == null) {
            continue;
        }
        const siblings = byParent.get(entry.parentPid) || [];
        siblings.push(entry);
        byParent.set(entry.parentPid, siblings);
    }

    const seen = new Set<number>();
    const candidates: FullSuiteValidationProcessCandidate[] = [];
    const pending = [Number(rootPid)];
    // spawnStreamed creates the full-suite child as a detached POSIX process-group
    // leader. Group membership survives PPID reparenting when that leader exits.
    for (const entry of table.entries) {
        if (entry.pid !== Number(rootPid) && entry.processGroupId === Number(rootPid)) {
            seen.add(entry.pid);
            candidates.push(entry);
            pending.push(entry.pid);
        }
    }
    while (pending.length > 0) {
        const parentPid = pending.shift()!;
        for (const child of byParent.get(parentPid) || []) {
            if (seen.has(child.pid)) {
                continue;
            }
            seen.add(child.pid);
            candidates.push(child);
            pending.push(child.pid);
        }
    }
    return { candidates, warning: null };
}

function readProcessTable(): {
    entries: FullSuiteValidationProcessCandidate[];
    warning: string | null;
} {
    try {
        return process.platform === 'win32'
            ? readWindowsProcessTable()
            : readPosixProcessTable();
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return {
            entries: [],
            warning: `Unable to scan live process descendants: ${message}`
        };
    }
}

function readWindowsProcessTable(): {
    entries: FullSuiteValidationProcessCandidate[];
    warning: string | null;
} {
    const output = childProcess.execFileSync('powershell.exe', [
        '-NoProfile',
        '-Command',
        'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress'
    ], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 5000
    });
    const parsed = JSON.parse(output || '[]') as unknown;
    return {
        entries: parseWindowsProcessRows(parsed),
        warning: null
    };
}

export function parseWindowsProcessRows(rowsValue: unknown): FullSuiteValidationProcessCandidate[] {
    const rows = Array.isArray(rowsValue) ? rowsValue : [rowsValue];
    return rows
        .map(parseWindowsProcessRow)
        .filter((entry): entry is FullSuiteValidationProcessCandidate => entry !== null);
}

function parseWindowsProcessRow(row: unknown): FullSuiteValidationProcessCandidate | null {
    if (!row || typeof row !== 'object') {
        return null;
    }
    const record = row as Record<string, unknown>;
    const pid = Number(record.ProcessId);
    if (!Number.isInteger(pid) || pid <= 0) {
        return null;
    }
    const parentPid = Number(record.ParentProcessId);
    return {
        pid,
        parentPid: Number.isInteger(parentPid) && parentPid > 0 ? parentPid : null,
        commandLine: String(record.CommandLine || '').trim()
    };
}

function readPosixProcessTable(): {
    entries: FullSuiteValidationProcessCandidate[];
    warning: string | null;
} {
    const output = childProcess.execFileSync('ps', ['-eo', 'pid=,ppid=,pgid=,args='], {
        encoding: 'utf8',
        timeout: 5000
    });
    return { entries: parsePosixProcessRows(output), warning: null };
}

export function parsePosixProcessRows(output: string): FullSuiteValidationProcessCandidate[] {
    return output
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter(Boolean)
        .map(parsePosixProcessLine)
        .filter((entry): entry is FullSuiteValidationProcessCandidate => entry !== null);
}

function parsePosixProcessLine(line: string): FullSuiteValidationProcessCandidate | null {
    const match = /^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/u.exec(line);
    if (!match) {
        return null;
    }
    const pid = Number(match[1]);
    const parentPid = Number(match[2]);
    const processGroupId = Number(match[3]);
    if (!Number.isInteger(pid) || pid <= 0) {
        return null;
    }
    return {
        pid,
        parentPid: Number.isInteger(parentPid) && parentPid > 0 ? parentPid : null,
        processGroupId: Number.isInteger(processGroupId) && processGroupId > 0 ? processGroupId : null,
        commandLine: match[4].trim()
    };
}
