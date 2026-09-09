import assert from 'node:assert/strict';
import mutableFs from 'node:fs';
import * as fs from 'node:fs';
import { mock } from 'node:test';

import {
    applyAdvancedRestorePlan,
    readAuthenticatedRepoFileSnapshot
} from '../../../../../src/gates/split-required/split-required-wip-restore-plan';
import type { AdvancedRestorePlan } from '../../../../../src/gates/split-required/split-required-wip-restore-plan';
import type { SplitRequiredWipTrackedFileEvidence } from '../../../../../src/gates/split-required/split-required-wip-contracts';

const ARRAY_BUFFER_GC_STABILIZATION_PASSES = 4;

function measureArrayBuffersAfterCollection(): number {
    let lowestBytes = Number.POSITIVE_INFINITY;
    for (let pass = 0; pass < ARRAY_BUFFER_GC_STABILIZATION_PASSES; pass++) {
        global.gc!();
        lowestBytes = Math.min(lowestBytes, process.memoryUsage().arrayBuffers);
    }
    return lowestBytes;
}

export function measureBackupStorage(mode: string): void {
    const input = JSON.parse(fs.readFileSync(0, 'utf8')) as {
        repoRoot: string;
        files: SplitRequiredWipTrackedFileEvidence[];
        plan: Omit<AdvancedRestorePlan, 'targetSha256'> & { targetSha256: [string, string | null][] };
    };
    assert.ok(global.gc, 'measurement subprocess requires --expose-gc');
    const initialBytes = measureArrayBuffersAfterCollection();
    assert.ok(mode === 'retained-baseline' || mode === 'spooled');
    const originalOpen = mutableFs.openSync;
    const originalRead = mutableFs.readSync;
    const originalWrite = mutableFs.writeSync;
    const originalSync = mutableFs.fsyncSync;
    const originalClose = mutableFs.closeSync;
    let descriptor: number | null = null;
    let capturing = mode === 'retained-baseline';
    const captureIo = { readCalls: 0, readBytes: 0, writeCalls: 0, writeBytes: 0 };
    const result = { retainedArrayBufferBytes: -1, spoolBytes: 0, spoolWrites: 0, spoolReads: 0, spoolClosed: false };
    mock.method(mutableFs, 'openSync', (file: fs.PathLike, flags: fs.OpenMode, permissions?: fs.Mode) => {
        const opened = originalOpen(file, flags, permissions);
        if (String(file).includes('.garda-restore-backup-')
            && typeof flags === 'number' && (flags & fs.constants.O_RDWR) !== 0) {
            descriptor = opened;
            capturing = true;
        }
        return opened;
    });
    const measuredWrite = mock.method(mutableFs, 'writeSync', (
        opened: number, buffer: NodeJS.ArrayBufferView, offset: number, length: number, position: number
    ) => {
        measuredWrite.mock.resetCalls();
        const written = originalWrite(opened, buffer, offset, length, position);
        if (capturing) {
            captureIo.writeCalls++;
            captureIo.writeBytes += written;
        }
        if (opened === descriptor && !result.spoolClosed) {
            assert.ok(length <= 64 * 1024);
            result.spoolBytes += written;
            result.spoolWrites++;
        }
        return written;
    });
    const measuredRead = mock.method(mutableFs, 'readSync', (
        opened: number, buffer: Buffer, offset: number, length: number, position: number
    ) => {
        measuredRead.mock.resetCalls();
        if (opened === descriptor && !result.spoolClosed) {
            assert.ok(length <= 64 * 1024);
            result.spoolReads++;
        }
        const bytesRead = originalRead(opened, buffer, offset, length, position);
        if (capturing) {
            captureIo.readCalls++;
            captureIo.readBytes += bytesRead;
        }
        return bytesRead;
    });
    mock.method(mutableFs, 'fsyncSync', (opened: number) => {
        originalSync(opened);
        if (opened === descriptor && !result.spoolClosed) {
            result.retainedArrayBufferBytes = measureArrayBuffersAfterCollection() - initialBytes;
            capturing = false;
        }
    });
    mock.method(mutableFs, 'closeSync', (opened: number) => {
        originalClose(opened);
        if (opened === descriptor) result.spoolClosed = true;
    });
    if (mode === 'retained-baseline') {
        // Model former capture retention only, not the full historical restore implementation.
        const snapshots = input.files.map(file => readAuthenticatedRepoFileSnapshot(
            input.repoRoot, file.path, 64 * 1024 * 1024
        ));
        const arrayBufferBytes = measureArrayBuffersAfterCollection();
        const retainedArrayBufferBytes = arrayBufferBytes - initialBytes;
        const retainedBytes = snapshots.reduce((sum, snapshot) => sum + (snapshot.content?.length ?? 0), 0);
        mock.restoreAll();
        process.stdout.write(JSON.stringify({
            arrayBufferBytes, initialArrayBufferBytes: initialBytes,
            retainedArrayBufferBytes, retainedBytes, captureIo, peakRssKiB: process.resourceUsage().maxRSS
        }));
        return;
    }
    const violations = applyAdvancedRestorePlan(input.repoRoot, {
        ...input.plan, targetSha256: new Map(input.plan.targetSha256)
    }, input.files, []);
    mock.restoreAll();
    assert.ok(result.retainedArrayBufferBytes >= 0, 'measure the sealed backup before mutation');
    process.stdout.write(JSON.stringify({ ...result, captureIo, violations, peakRssKiB: process.resourceUsage().maxRSS }));
}
