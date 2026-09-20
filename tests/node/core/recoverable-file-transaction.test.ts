import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { withRecoverableFileTransaction, type FileTransactionOptions } from '../../../src/core/recoverable-file-transaction';

const modulePath = require.resolve('../../../src/core/recoverable-file-transaction');
const participants = ['config', 'policy', 'audit', 'receipt', 'manifest'];

function fixture(): FileTransactionOptions {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-file-transaction-'));
    const files = Object.fromEntries(participants.map((id) => [id, path.join(root, `${id}.json`)]));
    for (const [id, file] of Object.entries(files)) fs.writeFileSync(file, `old-${id}`);
    return { root, files, journalPath: path.join(root, 'journal.json'), lockPath: path.join(root, 'transaction.lock') };
}

function assertOriginal(options: FileTransactionOptions): void {
    for (const [id, file] of Object.entries(options.files)) assert.equal(fs.readFileSync(file, 'utf8'), `old-${id}`);
}

test('transaction preserves an external change between its initial read and first write', () => {
    const options = fixture();
    try {
        assert.throws(() => withRecoverableFileTransaction(options, tx => {
            fs.writeFileSync(options.files.config, 'external');
            tx.write(options.files.config, 'bad');
        }), /outside the writer lock/);
        assert.equal(fs.readFileSync(options.files.config, 'utf8'), 'external');
    } finally {
        fs.rmSync(options.root, { recursive: true, force: true });
    }
});

test('rollback skips an unchanged participant whose publication persistently fails', () => {
    const options = fixture();
    const realFs = require('node:fs') as typeof fs;
    const rename = realFs.renameSync;
    try {
        realFs.renameSync = (from, to) => {
            if (String(to) === options.files.manifest) throw new Error('persistent manifest failure');
            return rename(from, to);
        };
        assert.throws(() => withRecoverableFileTransaction(options, tx => {
            tx.write(options.files.config, 'new-config');
            tx.write(options.files.manifest, 'new-manifest');
        }), /persistent manifest failure/);
        assertOriginal(options);
        assert.equal(fs.existsSync(options.journalPath), false);
    } finally {
        realFs.renameSync = rename;
        fs.rmSync(options.root, { recursive: true, force: true });
    }
});

for (const participant of participants) {
    test(`transaction restores every participant after a post-write ${participant} failure`, () => {
        const options = fixture();
        try {
            assert.throws(() => withRecoverableFileTransaction(options, (tx) => {
                for (const id of participants) {
                    tx.write(options.files[id], `new-${id}`);
                    if (id === participant) throw new Error('injected post-write failure');
                }
            }), /injected post-write failure/);
            assertOriginal(options);
            assert.equal(fs.existsSync(options.journalPath), false);
        } finally {
            fs.rmSync(options.root, { recursive: true, force: true });
        }
    });

    test(`transaction recovers a killed writer after publishing ${participant}`, () => {
        const options = fixture();
        try {
            const child = spawnSync(process.execPath, ['-e', `
                const { withRecoverableFileTransaction } = require(${JSON.stringify(modulePath)});
                const options = ${JSON.stringify(options)};
                withRecoverableFileTransaction(options, tx => {
                    for (const id of ${JSON.stringify(participants)}) {
                        tx.write(options.files[id], 'new-' + id);
                        if (id === '${participant}') process.exit(77);
                    }
                });
            `], { encoding: 'utf8', timeout: 15_000 });
            assert.equal(child.status, 77, child.stderr);
            assert.equal(fs.existsSync(options.journalPath), true);
            withRecoverableFileTransaction(options, () => { assertOriginal(options); });
            assert.equal(fs.existsSync(options.journalPath), false);
        } finally {
            fs.rmSync(options.root, { recursive: true, force: true });
        }
    });
}

test('recovery supports repeated audit writes interrupted after intent but before replacement', () => {
    const options = fixture();
    try {
        const child = spawnSync(process.execPath, ['-e', `
            const fs = require('node:fs');
            const { withRecoverableFileTransaction } = require(${JSON.stringify(modulePath)});
            const options = ${JSON.stringify(options)};
            withRecoverableFileTransaction(options, tx => {
                tx.append(options.files.audit, '\\nfirst');
                const rename = fs.renameSync;
                fs.renameSync = (from, to) => {
                    if (to === options.files.audit) process.exit(76);
                    return rename(from, to);
                };
                tx.append(options.files.audit, '\\nsecond');
            });
        `], { encoding: 'utf8', timeout: 15_000 });
        assert.equal(child.status, 76, child.stderr);
        withRecoverableFileTransaction(options, () => { assertOriginal(options); });
    } finally {
        fs.rmSync(options.root, { recursive: true, force: true });
    }
});

test('committed journal cleanup failure never rolls back a committed generation', () => {
    const options = fixture();
    const realFs = require('node:fs') as typeof fs;
    const unlink = realFs.unlinkSync;
    try {
        realFs.unlinkSync = (file) => {
            if (String(file) === options.journalPath) throw new Error('injected journal cleanup failure');
            return unlink(file);
        };
        assert.throws(() => withRecoverableFileTransaction(options, tx => tx.write(options.files.config, 'committed')));
        realFs.unlinkSync = unlink;
        withRecoverableFileTransaction(options, () => {
            assert.equal(fs.readFileSync(options.files.config, 'utf8'), 'committed');
        });
        assert.equal(fs.existsSync(options.journalPath), false);
    } finally {
        realFs.unlinkSync = unlink;
        fs.rmSync(options.root, { recursive: true, force: true });
    }
});

test('recovery refuses a foreign edit without changing any participant', () => {
    const options = fixture();
    try {
        const child = spawnSync(process.execPath, ['-e', `
            const { withRecoverableFileTransaction } = require(${JSON.stringify(modulePath)});
            const options = ${JSON.stringify(options)};
            withRecoverableFileTransaction(options, tx => {
                tx.write(options.files.config, 'new-config');
                tx.write(options.files.policy, 'new-policy');
                process.exit(75);
            });
        `], { encoding: 'utf8', timeout: 15_000 });
        assert.equal(child.status, 75, child.stderr);
        fs.writeFileSync(options.files.config, 'foreign-edit');
        assert.throws(() => withRecoverableFileTransaction(options, () => {}), /recovery conflict/);
        assert.equal(fs.readFileSync(options.files.config, 'utf8'), 'foreign-edit');
        assert.equal(fs.readFileSync(options.files.policy, 'utf8'), 'new-policy');
        assert.equal(fs.existsSync(options.journalPath), true);
    } finally {
        fs.rmSync(options.root, { recursive: true, force: true });
    }
});

test('transaction rejects malformed journals and paths outside the allowlist', () => {
    const options = fixture();
    try {
        assert.throws(() => withRecoverableFileTransaction(options, tx => tx.write(path.join(options.root, 'other.json'), 'bad')), /allowlist/);
        fs.writeFileSync(options.journalPath, JSON.stringify({ schema_version: 1, root: options.root, phase: 'prepared', entries: [{ id: '../outside' }] }));
        assert.throws(() => withRecoverableFileTransaction(options, () => {}), /Invalid transaction journal entry/);
        assertOriginal(options);
        assert.equal(fs.existsSync(options.journalPath), true);
    } finally {
        fs.rmSync(options.root, { recursive: true, force: true });
    }
});

test('transaction rejects symlinked participant directories', () => {
    const options = fixture();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-transaction-outside-'));
    try {
        fs.symlinkSync(outside, path.join(options.root, 'linked'), 'junction');
        const unsafe = { ...options, files: { escape: path.join(options.root, 'linked/config.json') } };
        assert.throws(() => withRecoverableFileTransaction(unsafe, tx => tx.write(unsafe.files.escape, 'bad')), /Unsafe transaction path/);
        assert.deepEqual(fs.readdirSync(outside), []);
    } finally {
        fs.rmSync(options.root, { recursive: true, force: true });
        fs.rmSync(outside, { recursive: true, force: true });
    }
});

test('concurrent transaction writers read inside the lock and preserve both increments', async () => {
    const options = fixture();
    fs.writeFileSync(options.files.config, '0');
    try {
        const run = () => new Promise<void>((resolve, reject) => {
            const child = spawn(process.execPath, ['-e', `
                const fs = require('node:fs');
                const { withRecoverableFileTransaction } = require(${JSON.stringify(modulePath)});
                const options = ${JSON.stringify(options)};
                withRecoverableFileTransaction(options, tx => {
                    const value = Number(fs.readFileSync(options.files.config, 'utf8'));
                    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
                    tx.write(options.files.config, String(value + 1));
                });
            `], { stdio: ['ignore', 'ignore', 'pipe'] });
            let error = '';
            child.stderr.on('data', chunk => { error += String(chunk); });
            child.on('error', reject);
            child.on('exit', code => code === 0 ? resolve() : reject(new Error(error)));
        });
        await Promise.all([run(), run()]);
        assert.equal(fs.readFileSync(options.files.config, 'utf8'), '2');
    } finally {
        fs.rmSync(options.root, { recursive: true, force: true });
    }
});
