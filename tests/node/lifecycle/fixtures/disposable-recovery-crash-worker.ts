import * as fs from 'node:fs';
import * as path from 'node:path';
import { resumeOwnedDisposableArtifacts } from '../../../../src/lifecycle/cleanup/owned-disposable-artifact-recovery';
import type { OwnedDisposableArtifactJournalOptions } from '../../../../src/lifecycle/cleanup/owned-disposable-artifact-journal';
import { readOwnedDisposableArtifactRecoverySnapshot } from '../../../../src/lifecycle/cleanup/owned-disposable-artifact-recovery-snapshot';

export const recoveryCrashWorkerPath = __filename;

export function publishCrashMarker(marker: string, phase: string): void {
    const pending = `${marker}.pending`;
    fs.writeFileSync(pending, JSON.stringify({ pid: process.pid, phase }) + '\n', { flag: 'wx' });
    fs.renameSync(pending, marker);
}

function runCrashWorker(): void {
    const [optionsFile, marker, phase, payload] = process.argv.slice(2);
    const options = JSON.parse(fs.readFileSync(optionsFile, 'utf8')) as OwnedDisposableArtifactJournalOptions;
    const { confirmed, ...selection } = options;
    const initial = phase === 'before-finished' ? readOwnedDisposableArtifactRecoverySnapshot(selection) : null;
    const rawFs = require('node:fs') as typeof fs;
    const originalUnlink = rawFs.unlinkSync, originalOpen = rawFs.openSync;
    function pause(): never {
        publishCrashMarker(marker, phase);
        const waiter = new Int32Array(new SharedArrayBuffer(4));
        for (;;) Atomics.wait(waiter, 0, 0);
    }
    rawFs.unlinkSync = ((file: fs.PathLike) => {
        const target = String(file);
        if (target === path.join(payload, 'alpha.txt') && phase === 'pending') pause();
        originalUnlink(file);
        if (target === path.join(payload, 'alpha.txt') && phase === 'unlinked') pause();
    }) as typeof fs.unlinkSync;
    rawFs.openSync = ((...args: Parameters<typeof fs.openSync>) => {
        const file = String(args[0]), directory = initial?.progress.directory.path;
        // Pause before creating FINISHED's tempfile, after the complete REMOVED prefix is durable and validated.
        if (initial && phase === 'before-finished' && path.dirname(file) === directory && path.basename(file).includes('.json.intent-')) {
            const name = fs.readdirSync(directory).filter(item => /^\d{8}\.json$/u.test(item)).sort().at(-1);
            if (name) {
                const record = JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8')) as {
                    progress: { event: string; removed_member_count: number }
                };
                if (record.progress.event === 'REMOVED'
                    && record.progress.removed_member_count === initial.progress.order.length) pause();
            }
        }
        return originalOpen(...args);
    }) as typeof fs.openSync;
    const result = resumeOwnedDisposableArtifacts(options);
    process.stdout.write(JSON.stringify(result) + '\n');
    process.exitCode = result.status === 'FINISHED' ? 0 : 1;
}

if (require.main === module) runCrashWorker();
