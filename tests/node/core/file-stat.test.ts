import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { lstatFileIdentitySync, statFileIdentitySync } from '../../../src/core/file-stat';

const mutableFs = require('node:fs') as { -readonly [Key in keyof typeof fs]: typeof fs[Key] };

function withMissingWindowsPathDevice(callback: (file: string) => void): void {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-file-stat-'));
    const file = path.join(root, 'file.txt');
    fs.writeFileSync(file, 'bounded identity\n', { mode: 0o600 });
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    const originalLstat = mutableFs.lstatSync;
    const originalStat = mutableFs.statSync;
    const withoutDevice = (stat: fs.Stats | fs.BigIntStats | undefined): fs.Stats | fs.BigIntStats | undefined =>
        stat && Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { dev: typeof stat.dev === 'bigint' ? 0n : 0 });
    mutableFs.lstatSync = ((...args: Parameters<typeof fs.lstatSync>) =>
        withoutDevice(Reflect.apply(originalLstat, mutableFs, args))) as typeof fs.lstatSync;
    mutableFs.statSync = ((...args: Parameters<typeof fs.statSync>) =>
        withoutDevice(Reflect.apply(originalStat, mutableFs, args))) as typeof fs.statSync;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
        callback(file);
    } finally {
        mutableFs.lstatSync = originalLstat;
        mutableFs.statSync = originalStat;
        Object.defineProperty(process, 'platform', platform);
        fs.rmSync(root, { recursive: true, force: true });
    }
}

test('reconstructs number and bigint device identities without transferring file bytes', () => {
    withMissingWindowsPathDevice(file => {
        const descriptor = fs.openSync(file, 'r');
        const originalRead = mutableFs.readSync;
        const originalReadFile = mutableFs.readFileSync;
        mutableFs.readSync = (() => { throw Error('Unexpected payload read'); }) as typeof fs.readSync;
        mutableFs.readFileSync = (() => { throw Error('Unexpected payload read'); }) as typeof fs.readFileSync;
        try {
            assert.deepEqual(lstatFileIdentitySync(file), fs.fstatSync(descriptor));
            assert.deepEqual(statFileIdentitySync(file, { bigint: true }), fs.fstatSync(descriptor, { bigint: true }));
        } finally {
            mutableFs.readSync = originalRead;
            mutableFs.readFileSync = originalReadFile;
            fs.closeSync(descriptor);
        }
    });
});

for (const field of ['dev', 'ino', 'mode', 'nlink', 'uid', 'gid', 'rdev', 'size', 'mtimeMs', 'ctimeMs', 'birthtimeMs'] as const) {
    test(`rejects a changed descriptor ${field} even when the path device is missing`, () => {
        withMissingWindowsPathDevice(file => {
            const originalFstat = mutableFs.fstatSync;
            let calls = 0;
            mutableFs.fstatSync = ((descriptor: number) => {
                const stat = originalFstat(descriptor);
                calls += 1;
                return calls === 2
                    ? Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { [field]: stat[field] + Math.max(1, Math.abs(stat[field]) * Number.EPSILON * 2) })
                    : stat;
            }) as typeof fs.fstatSync;
            try {
                assert.throws(() => lstatFileIdentitySync(file), /File identity changed/u);
            } finally {
                mutableFs.fstatSync = originalFstat;
            }
        });
    });
}

for (const field of ['ino', 'mtimeNs', 'ctimeNs', 'birthtimeNs'] as const) {
test(`rejects bigint ${field} substitutions hidden by number precision`, () => {
    withMissingWindowsPathDevice(file => {
        const originalFstat = mutableFs.fstatSync;
        let calls = 0;
        mutableFs.fstatSync = ((descriptor: number, options: { bigint: true }) => {
            const stat = originalFstat(descriptor, options);
            calls += 1;
            return calls === 2
                ? Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { [field]: stat[field] + 1n })
                : stat;
        }) as typeof fs.fstatSync;
        try {
            assert.throws(() => lstatFileIdentitySync(file, { bigint: true }), /File identity changed/u);
        } finally {
            mutableFs.fstatSync = originalFstat;
        }
    });
});
}

test('rejects a reopened path bound to another file and closes both descriptors', () => {
    withMissingWindowsPathDevice(file => {
        const originalOpen = mutableFs.openSync;
        const originalClose = mutableFs.closeSync;
        const replacement = file + '.replacement';
        fs.writeFileSync(replacement, 'bounded identity\n', { mode: 0o600 });
        const opened: number[] = [];
        const closed: number[] = [];
        mutableFs.openSync = ((target: fs.PathLike, flags: fs.OpenMode) => {
            const descriptor = originalOpen(opened.length === 1 ? replacement : target, flags);
            opened.push(descriptor);
            return descriptor;
        }) as typeof fs.openSync;
        mutableFs.closeSync = (descriptor => {
            closed.push(descriptor);
            originalClose(descriptor);
        }) as typeof fs.closeSync;
        try {
            assert.throws(() => lstatFileIdentitySync(file), /File identity changed/u);
            assert.equal(opened.length, 2);
            assert.deepEqual([...closed].sort(), [...opened].sort());
        } finally {
            mutableFs.openSync = originalOpen;
            mutableFs.closeSync = originalClose;
        }
    });
});

test('reconstructs directory identity from live descriptors', () => {
    withMissingWindowsPathDevice(file => {
        const descriptor = fs.openSync(path.dirname(file), fs.constants.O_RDONLY);
        try {
            assert.deepEqual(lstatFileIdentitySync(path.dirname(file)), fs.fstatSync(descriptor));
        } finally {
            fs.closeSync(descriptor);
        }
    });
});
