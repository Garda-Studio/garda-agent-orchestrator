import * as fs from 'node:fs';
import * as path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { spawnStreamed } from '../process/subprocess';
import { readTaskQueueEntries } from '../task-queue-read';
import { isTaskQueueDoneStatus } from '../task-queue/active-task-state';
import { assertCanonicalTaskId } from '../task-ids';
import { resolveBundleName } from '../constants';
import { CompactCapture, withCompactStore } from './store';
import { containedDirectory, openCompactFile } from './store-paths';
import { readCompactSettings } from './settings';
import type { CompactOutcome, CompactResult } from './capture';

export type CompactInspection =
    | { kind: 'git'; operation: 'status' | 'diff'; path?: string; staged?: boolean }
    | { kind: 'rg'; path: string; query: string; regex?: boolean }
    | { kind: 'file'; path: string; from: number; lines: number; metadata?: boolean };

function normalizeBoundaryPath(value: string): string {
    return value.replace(/\\/g, '/').toLowerCase();
}

function isPathAtOrBelow(relative: string, boundary: string): boolean {
    const normalizedRelative = normalizeBoundaryPath(relative);
    const normalizedBoundary = normalizeBoundaryPath(boundary);
    return normalizedRelative === normalizedBoundary
        || normalizedRelative.startsWith(`${normalizedBoundary}/`);
}

export function inspectPath(repoRoot: string, relative: string, allowMissing = false): string {
    if (!relative || relative.length > 2048 || relative.includes('\0') || path.isAbsolute(relative)) throw new Error('Use a repository-relative inspection path of at most 2048 characters.');
    const root = fs.realpathSync.native(repoRoot);
    const target = path.resolve(root, relative);
    const rel = path.relative(root, target);
    if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('Inspection path escapes repository.');
    if (isPathAtOrBelow(rel, `${resolveBundleName()}/runtime/compact`)) throw new Error('Use compact read/search for retained output.');
    if (allowMissing) {
        let current = root;
        for (const part of rel.split(path.sep).filter(Boolean)) {
            current = path.join(current, part);
            try {
                if (fs.lstatSync(current).isSymbolicLink()) throw new Error('Inspection path cannot contain links.');
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') return target;
                throw error;
            }
        }
    }
    containedDirectory(root, path.dirname(rel));
    const before = fs.lstatSync(target);
    if (before.isSymbolicLink() || (!before.isDirectory() && !before.isFile())) throw new Error('Inspection path must not be a link or special file.');
    const canonicalTarget = fs.realpathSync.native(target);
    const canonicalRelative = path.relative(root, canonicalTarget);
    if (canonicalRelative.startsWith('..') || path.isAbsolute(canonicalRelative)) throw new Error('Inspection path escapes repository.');
    if (isPathAtOrBelow(canonicalRelative, `${resolveBundleName()}/runtime/compact`)) throw new Error('Use compact read/search for retained output.');
    containedDirectory(root, path.dirname(canonicalRelative));
    const after = fs.lstatSync(canonicalTarget);
    if (before.dev !== after.dev || before.ino !== after.ino) throw new Error('Inspection path identity changed during validation.');
    return canonicalTarget;
}

function inspectionEnvironment(): NodeJS.ProcessEnv {
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
        if (/^(GIT_|RG_|RIPGREP_|PAGER$|LESS$)/i.test(key)) delete env[key];
    }
    return { ...env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_LITERAL_PATHSPECS: '1' };
}

function processArguments(request: CompactInspection): { command: string; args: string[] } {
    if (request.kind === 'git') {
        const args = ['--no-pager', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-c', 'color.ui=false'];
        if (request.operation === 'status') args.push('status', '--short', '--untracked-files=normal', '--ignore-submodules=all');
        else {
            if (!request.path) throw new Error('Compact diff requires --path.');
            args.push('diff', '--no-ext-diff', '--no-textconv', '--ignore-submodules=all', '--no-color', '--no-renames');
            if (request.staged) args.push('--cached');
        }
        if (request.path) args.push('--', request.path);
        return { command: 'git', args };
    }
    if (request.kind !== 'rg') throw new Error('Not a subprocess inspection.');
    if (!request.query || Buffer.byteLength(request.query) > 256) throw new Error('Search query requires 1..256 bytes.');
    return { command: 'rg', args: ['--no-config', '--color=never', '--line-number', '--with-filename', '--max-filesize', '16M', '--glob-case-insensitive', '--glob', `!${resolveBundleName()}/runtime/**`, ...(request.regex ? [] : ['--fixed-strings']), '--', request.query, request.path] };
}

async function inspectFile(root: string, request: Extract<CompactInspection, { kind: 'file' }>, capture: CompactCapture): Promise<CompactOutcome> {
    const file = inspectPath(root, request.path);
    const fd = openCompactFile(file, fs.constants.O_RDONLY);
    try {
        const stat = fs.fstatSync(fd);
        if (request.metadata) {
            await capture.write('stdout', Buffer.from(JSON.stringify({ path: request.path, bytes: stat.size, modified: stat.mtime.toISOString() }) + '\n'));
            return { exitCode: 0, timedOut: false, cancelled: false };
        }
        if (!Number.isSafeInteger(request.from) || request.from < 1 || !Number.isSafeInteger(request.lines) || request.lines < 1 || request.lines > 2000) throw new Error('File ranges require from >= 1 and 1..2000 lines.');
        const decoder = new StringDecoder('utf8');
        const buffer = Buffer.alloc(32768);
        let pending = '';
        let line = 1;
        let offset = 0;
        const deadline = Date.now() + 10000;
        const emit = async (text: string): Promise<void> => {
            if (line >= request.from && line < request.from + request.lines) await capture.write('stdout', Buffer.from(`${line}: ${text}\n`));
            line++;
        };
        while (offset < stat.size && line < request.from + request.lines) {
            if (offset >= 64 * 1024 * 1024 || Date.now() > deadline) throw new Error('File scan source limit reached; use a narrower source.');
            const count = fs.readSync(fd, buffer, 0, buffer.length, offset);
            if (!count) break;
            if (buffer.subarray(0, count).includes(0)) throw new Error('Binary file inspection is unsupported.');
            offset += count;
            pending += decoder.write(buffer.subarray(0, count));
            let end: number;
            while ((end = pending.indexOf('\n')) >= 0 && line < request.from + request.lines) {
                await emit(pending.slice(0, end));
                pending = pending.slice(end + 1);
            }
            if (pending.length > 65536) throw new Error('File line exceeds 64 KiB; range is incomplete.');
        }
        if (line < request.from + request.lines && pending) { await emit(pending + decoder.end()); pending = ''; }
        const after = fs.fstatSync(fd);
        if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw new Error('Source file changed during inspection.');
        capture.source = { path: request.path, from: request.from, to: Math.max(request.from - 1, line - 1), eof: offset >= stat.size && !pending };
        return { exitCode: 0, timedOut: false, cancelled: false };
    } finally { fs.closeSync(fd); }
}

export async function runCompactInspection(root: string, taskId: string, request: CompactInspection): Promise<CompactResult> {
    assertCanonicalTaskId(taskId);
    const settings = readCompactSettings(root);
    if (!settings.enabled || !settings[request.kind]) throw new Error('Compact inspection is disabled; producer was not executed.');
    let effectiveRequest = request;
    if (request.path) {
        const inspectedPath = inspectPath(root, request.path, request.kind === 'git');
        if (request.kind === 'rg') {
            const canonicalRoot = fs.realpathSync.native(root);
            const canonicalRelative = path.relative(canonicalRoot, inspectedPath);
            if (fs.lstatSync(inspectedPath).isDirectory() && isPathAtOrBelow(canonicalRelative, `${resolveBundleName()}/runtime`)) {
                throw new Error('Compact rg does not search runtime directories. Select an exact runtime log file with --path.');
            }
            effectiveRequest = {
                ...request,
                path: canonicalRelative.replace(/\\/g, '/') || '.'
            };
        }
    }
    return withCompactStore(root, async store => {
        if (isTaskQueueDoneStatus(readTaskQueueEntries(root).get(taskId)?.status ?? null)) throw new Error('Task is complete; compact capture is closed.');
        const capture = new CompactCapture(store, taskId, settings, effectiveRequest.kind === 'file' && !effectiveRequest.metadata);
        let outcome: CompactOutcome;
        try {
            if (effectiveRequest.kind === 'file') outcome = await inspectFile(root, effectiveRequest, capture);
            else {
                const invocation = processArguments(effectiveRequest);
                outcome = await spawnStreamed(invocation.command, invocation.args, {
                    cwd: root, env: inspectionEnvironment(), envMode: 'replace', timeoutMs: 60000,
                    maxBuffer: 1024, outputSink: capture
                });
            }
        } catch (error) {
            outcome = { exitCode: 1, timedOut: false, cancelled: false, sinkError: error instanceof Error ? error.message : String(error) };
        }
        return capture.finish(outcome);
    });
}
