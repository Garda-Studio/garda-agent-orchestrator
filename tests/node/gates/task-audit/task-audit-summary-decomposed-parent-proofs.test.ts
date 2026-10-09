import { afterEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const fs: typeof import('node:fs') = require('node:fs');
const modulePath = '../../../../src/gates/task-audit/task-audit-summary-decomposed-parent-proofs';
const roots: string[] = [];
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

function reader(): (repoRoot: string, artifactPath: string, expectedSha256: string) => Record<string, unknown> {
    let loaded: Record<string, unknown> = {};
    try { loaded = require(modulePath); }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'MODULE_NOT_FOUND') throw error;
    }
    assert.equal(typeof loaded.readParentAuditProofRecord, 'function',
        'contained parent proof reader must exist before proof can be reconstructed');
    return loaded.readParentAuditProofRecord as ReturnType<typeof reader>;
}

function fixture(content = JSON.stringify({ task_id: 'T-PROOF-1', answer: 'Пример' })) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-parent-proof-'));
    roots.push(root);
    fs.mkdirSync(path.join(root, 'proofs'));
    const file = path.join(root, 'proofs', 'record.json');
    const bytes = Buffer.from(content);
    fs.writeFileSync(file, bytes, { flag: 'wx' });
    return { root, file, bytes, sha256: digest(bytes) };
}

afterEach(() => {
    mock.restoreAll();
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('contained parent-audit proof inputs', () => {
    it('reads the exact ordinary UTF-8 record without granting acceptance or changing its bytes', () => {
        const f = fixture();
        const result = reader()(f.root, f.file, f.sha256);
        assert.deepEqual(result, { task_id: 'T-PROOF-1', answer: 'Пример' });
        assert.deepEqual(fs.readFileSync(f.file), f.bytes);
        assert.equal('status' in result, false);
        assert.equal('local_commit_authentication' in result, false);
    });

    it('blocks missing proof, bad hash syntax and stale or forged bytes', () => {
        const f = fixture();
        const read = reader();
        assert.throws(() => read(f.root, f.file + '.missing', f.sha256));
        for (const hash of ['', 'public assertion', 'a'.repeat(63)]) {
            assert.throws(() => read(f.root, f.file, hash));
        }
        fs.writeFileSync(f.file, JSON.stringify({ task_id: 'T-FOREIGN' }));
        assert.throws(() => read(f.root, f.file, f.sha256));
    });

    it('blocks invalid JSON and non-record proof values even with their exact digest', () => {
        const read = reader();
        const malformed = fixture('{');
        assert.throws(() => read(malformed.root, malformed.file, malformed.sha256));
        for (const value of ['', 'null', '[]', '"claimed PASS"']) {
            const f = fixture(value);
            assert.throws(() => read(f.root, f.file, f.sha256));
        }
    });

    it('rejects an input above the fixed eight-MiB budget', () => {
        const read = reader(), f = fixture();
        const bytes = Buffer.from(JSON.stringify({ payload: 'a'.repeat(8 * 1024 * 1024) }));
        assert.equal(JSON.parse(bytes.toString('utf8')).payload.length, 8 * 1024 * 1024);
        fs.writeFileSync(f.file, bytes);
        assert.throws(() => read(f.root, f.file, digest(bytes)), /bounded ordinary file/u);
    });

    it('rejects malformed UTF-8 even when its raw byte digest matches', () => {
        const read = reader(), f = fixture();
        const bytes = Buffer.concat([Buffer.from('{"answer":"'), Buffer.from([0xc3, 0x28]), Buffer.from('"}')]);
        fs.writeFileSync(f.file, bytes);
        assert.throws(() => read(f.root, f.file, digest(bytes)));
    });

    it('rejects foreign traversal, outside-root inputs, symlink parents and linked files', () => {
        const read = reader(), f = fixture(), other = fixture();
        assert.throws(() => read(f.root, other.file, other.sha256));
        assert.throws(() => read(f.root, path.relative(f.root, other.file), other.sha256));
        const linked = path.join(f.root, 'proofs', 'linked.json');
        fs.linkSync(other.file, linked);
        assert.throws(() => read(f.root, linked, other.sha256));
        if (process.platform !== 'win32') {
            const parent = path.join(f.root, 'foreign');
            fs.symlinkSync(path.dirname(other.file), parent, 'dir');
            assert.throws(() => read(f.root, path.join(parent, 'record.json'), other.sha256));
        }
    });

    it('rejects stale identity from a same-byte ordinary replacement between binding and descriptor acquisition', () => {
        const read = reader(), f = fixture(), open = fs.openSync;
        let replaced = false;
        mock.method(fs, 'openSync', (...args: Parameters<typeof fs.openSync>) => {
            if (!replaced && String(args[0]) === f.file) {
                replaced = true;
                const next = f.file + '.replacement';
                fs.writeFileSync(next, f.bytes, { flag: 'wx' });
                fs.renameSync(next, f.file);
            }
            return open(...args);
        });
        assert.throws(() => read(f.root, f.file, f.sha256));
        assert.equal(replaced, true);
        assert.deepEqual(fs.readFileSync(f.file), f.bytes);
    });

    it('rejects growth during the descriptor read and closes the proof descriptor', () => {
        const read = reader(), f = fixture();
        const open = fs.openSync, originalRead = fs.readSync, close = fs.closeSync;
        let descriptor = -1, grew = false, closed = false;
        mock.method(fs, 'openSync', (...args: Parameters<typeof fs.openSync>) => {
            const fd = open(...args);
            if (String(args[0]) === f.file && descriptor === -1) descriptor = fd;
            return fd;
        });
        mock.method(fs, 'readSync', (...args: unknown[]) => {
            const count = Reflect.apply(originalRead, fs, args) as number;
            if (args[0] === descriptor && !grew) {
                grew = true;
                fs.appendFileSync(f.file, ' ');
            }
            return count;
        });
        mock.method(fs, 'closeSync', (fd: number) => {
            if (fd === descriptor) closed = true;
            return close(fd);
        });
        assert.throws(() => read(f.root, f.file, f.sha256));
        assert.equal(grew, true);
        assert.equal(closed, true);
    });

    it('rejects final-file FIFO replacement without waiting for a writer', { skip: process.platform === 'win32' }, () => {
        reader();
        const f = fixture();
        const script = String.raw`
            const fs = require('node:fs'), assert = require('node:assert/strict');
            const { spawnSync } = require('node:child_process');
            const reader = require(process.argv[1]).readParentAuditProofRecord;
            const [root, file, hash] = process.argv.slice(2);
            const open = fs.openSync; let replaced = false;
            fs.openSync = (...args) => {
                if (!replaced && String(args[0]) === file) {
                    replaced = true; fs.renameSync(file, file + '.original');
                    const result = spawnSync('mkfifo', [file], { timeout: 1000 });
                    assert.equal(result.status, 0, 'isolated FIFO fixture must be created');
                }
                return open(...args);
            };
            assert.throws(() => reader(root, file, hash));
            assert.equal(replaced, true, 'the final file must actually be replaced before open');
            assert.equal(fs.lstatSync(file).isFIFO(), true);
            console.log('FIFO_REPLACEMENT_REJECTED');
        `;
        const result = spawnSync(process.execPath,
            ['-e', script, require.resolve(modulePath), f.root, f.file, f.sha256],
            { timeout: 3000, encoding: 'utf8' });
        assert.equal(result.error, undefined, 'proof acquisition must not hang on a writerless FIFO');
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /FIFO_REPLACEMENT_REJECTED/u);
        assert.deepEqual(fs.readFileSync(f.file + '.original'), f.bytes);
    });
});
