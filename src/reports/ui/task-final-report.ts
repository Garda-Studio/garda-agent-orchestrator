import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { assertCanonicalTaskId } from '../../core/task-ids';
import { lstatFileIdentitySync } from '../../core/file-stat';
import { joinOrchestratorPath, resolvePathInsideRepo } from '../../core/orchestrator-paths';
import type { ReportTaskDetail } from '../report-data-contract';

type ReportReference = Pick<NonNullable<ReportTaskDetail['progress']>['final_report'], 'state' | 'path' | 'sha256'>;

export interface TaskFinalReport {
    task_id: string;
    state: 'available' | 'missing' | 'pending' | 'stale' | 'legacy' | 'unavailable';
    path: string;
    sha256: string | null;
    text: string | null;
    diagnostics: string[];
}

export const MAX_TASK_FINAL_REPORT_BYTES = 256 * 1024;
const MAX_REPORT_DIAGNOSTIC_CHARS = 512;

function sameReportFile(left: fs.Stats, right: fs.Stats): boolean {
    return left.isFile() && right.isFile() && left.nlink === 1 && right.nlink === 1
        && left.dev === right.dev && left.ino === right.ino && left.mode === right.mode
        && left.birthtimeMs === right.birthtimeMs && left.size === right.size
        && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function readReportBytes(repoRoot: string, file: string): Buffer | null {
    resolvePathInsideRepo(file, repoRoot, { allowMissing: true, enforceInside: true });
    let before: fs.Stats;
    try {
        before = lstatFileIdentitySync(file);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
    }
    if (!before.isFile() || before.nlink !== 1 || before.size > MAX_TASK_FINAL_REPORT_BYTES) {
        throw new Error('Final report requires an unshared regular file within the 256 KiB read limit.');
    }
    const realPath = fs.realpathSync.native(file);
    const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
    try {
        const opened = fs.fstatSync(descriptor);
        if (!sameReportFile(before, opened)) throw new Error('Final report identity changed before reading.');
        const buffer = Buffer.alloc(MAX_TASK_FINAL_REPORT_BYTES + 1);
        let bytes = 0;
        while (bytes < buffer.length) {
            const count = fs.readSync(descriptor, buffer, bytes, buffer.length - bytes, null);
            if (count === 0) break;
            bytes += count;
        }
        if (bytes > MAX_TASK_FINAL_REPORT_BYTES) throw new Error('Final report exceeds the 256 KiB read limit.');
        resolvePathInsideRepo(file, repoRoot, { enforceInside: true });
        if (fs.realpathSync.native(file) !== realPath || !sameReportFile(opened, fs.fstatSync(descriptor))
            || !sameReportFile(opened, lstatFileIdentitySync(file))) {
            throw new Error('Final report changed during reading.');
        }
        return buffer.subarray(0, bytes);
    } finally {
        fs.closeSync(descriptor);
    }
}

function reportState(reference: ReportReference | null | undefined, sha256: string): TaskFinalReport['state'] {
    if (reference?.state === 'available') {
        return reference.sha256?.toLowerCase() === sha256 ? 'available' : 'stale';
    }
    if (reference?.state === 'stale' || reference?.state === 'pending') return reference.state;
    return 'legacy';
}

export function readTaskFinalReport(options: {
    repoRoot: string;
    taskId: string;
    reference?: ReportReference | null;
}): TaskFinalReport {
    const taskId = assertCanonicalTaskId(options.taskId);
    const repoRoot = path.resolve(options.repoRoot);
    const file = joinOrchestratorPath(repoRoot, path.join('runtime', 'reviews', `${taskId}-final-user-report.md`));
    const report: TaskFinalReport = {
        task_id: taskId, state: 'unavailable', path: path.relative(repoRoot, file).replace(/\\/gu, '/'),
        sha256: null, text: null, diagnostics: []
    };
    try {
        if (options.reference?.path && path.resolve(repoRoot, options.reference.path) !== path.resolve(file)) {
            throw new Error('Final report reference does not belong to this task.');
        }
        const bytes = readReportBytes(repoRoot, file);
        if (bytes === null) {
            report.state = options.reference?.state === 'pending' ? 'pending' : 'missing';
            return report;
        }
        report.text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
        report.sha256 = createHash('sha256').update(bytes).digest('hex');
        report.state = reportState(options.reference, report.sha256);
        return report;
    } catch (error) {
        report.diagnostics.push((error instanceof Error ? error.message : String(error)).slice(0, MAX_REPORT_DIAGNOSTIC_CHARS));
        return report;
    }
}
