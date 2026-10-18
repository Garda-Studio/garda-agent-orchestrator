import test from 'node:test';
import assert from 'node:assert/strict';
import * as childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runWipGit, runWipGitBinary, readWipGitTreeEntries } from '../../../src/gates/shared/wip-git';
import { canCaptureSplitRequiredWip } from '../../../src/gates/split-required/split-required-wip-contracts';

test('capture eligibility bounds Git and refuses partial success on timeout, overflow or signal', t => {
    const native = require('node:child_process') as typeof childProcess;
    for (const failure of ['ETIMEDOUT', 'ENOBUFS', 'SIGTERM']) {
        t.mock.method(native, 'spawnSync', (_command: string, _args: string[], options: childProcess.SpawnSyncOptions) => {
            assert.equal(options.timeout, 120_000);
            assert.equal(options.maxBuffer, 64 * 1024 * 1024);
            return { status: 0, stdout: 'true\n', stderr: '',
                error: failure === 'SIGTERM' ? undefined : new Error(failure),
                signal: failure === 'SIGTERM' ? 'SIGTERM' : null };
        });
        assert.equal(canCaptureSplitRequiredWip('.'), false);
        t.mock.restoreAll();
    }
});

test('WIP Git probes reject timeouts and output overflow without consuming partial evidence', t => {
    const native = require('node:child_process') as typeof childProcess;
    for (const code of ['ETIMEDOUT', 'ENOBUFS']) {
        t.mock.method(native, 'execFileSync', (_command: string, _args: string[], options: childProcess.ExecFileSyncOptions) => {
            assert.equal(options.timeout, 120_000);
            assert.ok(Number.isFinite(options.maxBuffer) && options.maxBuffer! > 0);
            throw Object.assign(new Error(code), { code, stdout: Buffer.from('incomplete evidence') });
        });
        assert.throws(() => runWipGit('.', ['rev-parse', 'HEAD']), new RegExp(code));
        assert.throws(() => runWipGitBinary('.', ['diff', '--binary']), new RegExp(code));
        assert.throws(() => readWipGitTreeEntries('.', 'HEAD', ['source.txt']), new RegExp(code));
        t.mock.restoreAll();
    }
});

test('WIP tree capture bounds both native batch reads and preserves the actual file identity', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-wip-git-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
    runWipGit(root, ['init']);
    runWipGit(root, ['config', 'user.name', 'Test']);
    runWipGit(root, ['config', 'user.email', 'test@example.invalid']);
    fs.writeFileSync(path.join(root, 'source.txt'), 'original bytes\n');
    runWipGit(root, ['add', 'source.txt']);
    runWipGit(root, ['commit', '-m', 'seed']);
    const expected = runWipGit(root, ['rev-parse', 'HEAD:source.txt']).trim();
    const native = require('node:child_process') as typeof childProcess;
    const original = native.execFileSync;
    const calls: string[][] = [];
    t.mock.method(native, 'execFileSync', (command: string, args: string[], options: childProcess.ExecFileSyncOptions) => {
        assert.equal(options.timeout, 120_000);
        assert.ok(Number.isFinite(options.maxBuffer) && options.maxBuffer! > 0);
        calls.push(args);
        return original(command, args, options);
    });
    const entries = readWipGitTreeEntries(root, 'HEAD', ['source.txt']);
    assert.equal(entries.get('source.txt')?.objectId, expected);
    assert.equal(calls.length, 2);
    assert.ok(calls.every(args => args.includes('cat-file')));
});
