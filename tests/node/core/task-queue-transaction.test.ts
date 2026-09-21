import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import {
    resolveTaskQueueTransactionLockPath,
    withTaskQueueTransaction,
    writeTaskQueueFile
} from '../../../src/core/task-queue/task-queue-repository';
import { acquireFilesystemLock } from '../../../src/gate-runtime/task-events-locking';
import { syncTaskQueueStatusDetailed, withTaskQueueStatusSyncLock } from '../../../src/cli/commands/gate-flows/task/task-queue-sync';

const queueModule = require.resolve('../../../src/cli/commands/gate-flows/task/task-queue-sync');
const repositoryModule = require.resolve('../../../src/core/task-queue/task-queue-repository');
const lockingModule = require.resolve('../../../src/gate-runtime/task-events-locking');
const content = '| ID | Status |\n| --- | --- |\n| T-001 | TODO |\n| T-002 | TODO |\n';

function fixture(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-queue-transaction-'));
    fs.writeFileSync(path.join(root, 'TASK.md'), content);
    return root;
}

test('queue refuses unlocked writes and foreign edits under its lock', () => {
    const root = fixture();
    const target = path.join(root, 'TASK.md');
    try {
        assert.throws(() => writeTaskQueueFile(target, 'bad'), /requires a task-queue transaction/);
        withTaskQueueStatusSyncLock(target, (message) => { throw new Error(message); }, () => {
            fs.writeFileSync(target, 'foreign edit');
            assert.throws(() => writeTaskQueueFile(target, 'bad'), /changed outside the transaction/);
        });
        assert.equal(fs.readFileSync(target, 'utf8'), 'foreign edit');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('queue rejects a hard-linked file without modifying either name', () => {
    const root = fixture();
    const target = path.join(root, 'TASK.md');
    const linked = path.join(root, 'linked.md');
    try {
        fs.linkSync(target, linked);
        assert.equal(syncTaskQueueStatusDetailed(root, 'T-001', 'IN_PROGRESS').outcome, 'write_failed');
        assert.equal(fs.readFileSync(linked, 'utf8'), content);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('queue retains a foreign-host lock even when its lease is old', () => {
    const root = fixture();
    const target = path.join(root, 'TASK.md');
    const lock = `${target}.garda-status-sync.lock`;
    try {
        fs.mkdirSync(lock);
        const owner = { lock_id: 'foreign-owner', pid: 12345, hostname: 'not-this-host', created_at_utc: '2000-01-01T00:00:00Z', heartbeat_at_utc: '2000-01-01T00:00:00Z' };
        fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify(owner));
        assert.equal(syncTaskQueueStatusDetailed(root, 'T-001', 'IN_PROGRESS').outcome, 'write_failed');
        assert.deepEqual(JSON.parse(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8')), owner);
        assert.equal(fs.readFileSync(target, 'utf8'), content);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('control-plane recovery does not reclaim old locks with missing owner metadata', () => {
    const root = fixture();
    const lock = path.join(root, 'TASK.md.garda-status-sync.lock');
    try {
        fs.mkdirSync(lock);
        const old = new Date('2000-01-01T00:00:00Z');
        fs.utimesSync(lock, old, old);
        assert.throws(() => acquireFilesystemLock(lock, {
            timeoutMs: 50, retryMs: 10, requireKnownDeadOwner: true, allowForeignHostStaleRecovery: false
        }), /lock/i);
        assert.equal(fs.existsSync(lock), true);
        assert.equal(fs.readFileSync(path.join(root, 'TASK.md'), 'utf8'), content);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('queue replacement preserves the original bytes when publication fails', () => {
    const root = fixture();
    const target = path.join(root, 'TASK.md');
    const realFs = require('node:fs') as typeof fs;
    const original = realFs.renameSync;
    try {
        realFs.renameSync = (source, destination) => {
            if (String(destination) === target) throw new Error('injected queue publication failure');
            return original(source, destination);
        };
        const result = syncTaskQueueStatusDetailed(root, 'T-001', 'IN_PROGRESS');
        assert.equal(result.outcome, 'write_failed');
        assert.equal(fs.readFileSync(target, 'utf8'), content);
    } finally {
        realFs.renameSync = original;
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('queue transaction owns both lock namespaces and reuses them for nested status sync', () => {
    const root = fixture();
    const target = path.join(root, 'TASK.md');
    const legacyLock = `${target}.garda-status-sync.lock`;
    const runtimeLock = resolveTaskQueueTransactionLockPath(target);
    try {
        withTaskQueueStatusSyncLock(target, (message) => { throw new Error(message); }, () => {
            const owners = [legacyLock, runtimeLock].map((lockPath) => (
                JSON.parse(fs.readFileSync(path.join(lockPath, 'owner.json'), 'utf8'))
            ));
            for (const owner of owners) {
                assert.equal(owner.pid, process.pid);
                assert.ok(owner.lock_id);
                assert.ok(owner.heartbeat_at_utc);
            }

            assert.equal(syncTaskQueueStatusDetailed(root, 'T-001', 'IN_PROGRESS').outcome, 'updated');
            const nestedOwners = [legacyLock, runtimeLock].map((lockPath) => (
                JSON.parse(fs.readFileSync(path.join(lockPath, 'owner.json'), 'utf8'))
            ));
            assert.deepEqual(nestedOwners.map((owner) => owner.lock_id), owners.map((owner) => owner.lock_id));
            assert.match(fs.readFileSync(target, 'utf8'), /T-001\s*\|[^|\n]*IN_PROGRESS/);
        });
        assert.equal(fs.existsSync(legacyLock), false);
        assert.equal(fs.existsSync(runtimeLock), false);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('queue releases the legacy lock when the runtime lock namespace is obstructed', () => {
    const root = fixture();
    const target = path.join(root, 'TASK.md');
    const legacyLock = `${target}.garda-status-sync.lock`;
    const runtimeLock = resolveTaskQueueTransactionLockPath(target);
    try {
        fs.mkdirSync(path.dirname(runtimeLock), { recursive: true });
        fs.writeFileSync(runtimeLock, 'foreign runtime lock');

        const result = syncTaskQueueStatusDetailed(root, 'T-001', 'IN_PROGRESS');

        assert.equal(result.outcome, 'write_failed');
        assert.match(String(result.error_message), /invalid TASK\.md lock/u);
        assert.equal(fs.existsSync(legacyLock), false);
        assert.equal(fs.readFileSync(runtimeLock, 'utf8'), 'foreign runtime lock');
        assert.equal(fs.readFileSync(target, 'utf8'), content);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('queue rejects a runtime lock path redirected at every descendant segment', () => {
    const segments = ['garda-agent-orchestrator', 'runtime', 'task-queue-locks', 'TASK.md.lock'];
    for (let index = 0; index < segments.length; index += 1) {
        const root = fixture();
        const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-queue-lock-outside-'));
        const target = path.join(root, 'TASK.md');
        const redirectedPath = path.join(root, ...segments.slice(0, index + 1));
        try {
            fs.mkdirSync(path.dirname(redirectedPath), { recursive: true });
            fs.symlinkSync(outside, redirectedPath, process.platform === 'win32' ? 'junction' : 'dir');

            const result = syncTaskQueueStatusDetailed(root, 'T-001', 'IN_PROGRESS');

            assert.equal(result.outcome, 'write_failed', segments[index]);
            assert.match(String(result.error_message), /symlink or junction/u, segments[index]);
            assert.equal(fs.readFileSync(target, 'utf8'), content, segments[index]);
            assert.deepEqual(fs.readdirSync(outside), [], segments[index]);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
            fs.rmSync(outside, { recursive: true, force: true });
        }
    }
});

test('queue transaction canonicalizes its queue path once', () => {
    const root = fixture();
    const target = path.join(root, 'TASK.md');
    const realFs = require('node:fs') as typeof fs;
    const original = realFs.realpathSync;
    let calls = 0;
    try {
        realFs.realpathSync = ((...args: Parameters<typeof fs.realpathSync>) => {
            calls += 1;
            return original(...args);
        }) as typeof fs.realpathSync;

        withTaskQueueTransaction(target, (message) => { throw new Error(message); }, () => undefined);
        assert.equal(calls, 1);
    } finally {
        realFs.realpathSync = original;
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('nested status sync preserves compare-before-write protection', () => {
    const root = fixture();
    const target = path.join(root, 'TASK.md');
    const foreignContent = content.replace('| T-002 | TODO |', '| T-002 | DONE |');
    try {
        withTaskQueueStatusSyncLock(target, (message) => { throw new Error(message); }, () => {
            fs.writeFileSync(target, foreignContent);
            const result = syncTaskQueueStatusDetailed(root, 'T-001', 'IN_PROGRESS');
            assert.equal(result.outcome, 'write_failed');
            assert.match(String(result.error_message), /changed outside the transaction/u);
        });
        assert.equal(fs.readFileSync(target, 'utf8'), foreignContent);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('queue recovers a dead process lock after interruption before publication', () => {
    const root = fixture();
    const target = path.join(root, 'TASK.md');
    try {
        const child = spawnSync(process.execPath, ['-e', `
            const fs = require('node:fs');
            const api = require(${JSON.stringify(queueModule)});
            const rename = fs.renameSync;
            fs.renameSync = (from, to) => {
                if (to === ${JSON.stringify(target)}) process.exit(79);
                return rename(from, to);
            };
            api.syncTaskQueueStatusDetailed(${JSON.stringify(root)}, 'T-001', 'IN_PROGRESS');
        `], { encoding: 'utf8', timeout: 15_000 });
        assert.equal(child.status, 79, child.stderr);
        assert.equal(fs.readFileSync(target, 'utf8'), content);
        assert.equal(syncTaskQueueStatusDetailed(root, 'T-002', 'IN_PROGRESS').outcome, 'updated');
        assert.match(fs.readFileSync(target, 'utf8'), /T-001\s*\|\s*TODO/);
        assert.match(fs.readFileSync(target, 'utf8'), /T-002\s*\|[^|\n]*IN_PROGRESS/);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('independent queue writers serialize without losing either update', async () => {
    const root = fixture();
    try {
        const run = (id: string) => new Promise<void>((resolve, reject) => {
            const child = spawn(process.execPath, ['-e', `
                const api = require(${JSON.stringify(queueModule)});
                const result = api.syncTaskQueueStatusDetailed(${JSON.stringify(root)}, '${id}', 'IN_PROGRESS');
                if (result.outcome !== 'updated') throw new Error(JSON.stringify(result));
            `], { stdio: ['ignore', 'ignore', 'pipe'] });
            let error = '';
            child.stderr.on('data', (chunk) => { error += String(chunk); });
            child.on('error', reject);
            child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(error)));
        });
        await Promise.all([run('T-001'), run('T-002')]);
        const updated = fs.readFileSync(path.join(root, 'TASK.md'), 'utf8');
        assert.match(updated, /T-001\s*\|[^|\n]*IN_PROGRESS/);
        assert.match(updated, /T-002\s*\|[^|\n]*IN_PROGRESS/);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('runtime and legacy queue writers serialize without losing either update', async () => {
    const root = fixture();
    const target = path.join(root, 'TASK.md');
    const readyPath = path.join(root, 'runtime-writer-ready');
    const legacyOwnerPath = path.join(`${target}.garda-status-sync.lock`, 'owner.json');
    const overlapObservedPath = path.join(root, 'writer-overlap-observed');
    const boundedWaitSource = `
        const waitForPath = (candidate, label) => {
            const deadline = Date.now() + 5_000;
            while (!fs.existsSync(candidate)) {
                if (Date.now() >= deadline) throw new Error('Timed out waiting for ' + label);
                Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
            }
        };
    `;
    const run = (label: string, source: string) => new Promise<void>((resolve, reject) => {
        const child = spawn(process.execPath, ['-e', source], { stdio: ['ignore', 'ignore', 'pipe'] });
        let error = '';
        let timedOut = false;
        const timeout = setTimeout(() => {
            timedOut = true;
            child.kill();
        }, 15_000);
        child.stderr.on('data', (chunk) => { error += String(chunk); });
        child.once('error', (failure) => {
            clearTimeout(timeout);
            reject(failure);
        });
        child.once('exit', (code) => {
            clearTimeout(timeout);
            if (timedOut) reject(new Error(`${label} timed out`));
            else if (code === 0) resolve();
            else reject(new Error(error || `${label} exited with code ${String(code)}`));
        });
    });
    try {
        const runtimeWriter = run('runtime writer', `
            const fs = require('node:fs');
            const repository = require(${JSON.stringify(repositoryModule)});
            const locking = require(${JSON.stringify(lockingModule)});
            const target = ${JSON.stringify(target)};
            ${boundedWaitSource}
            const { handle } = locking.acquireFilesystemLock(
                repository.resolveTaskQueueTransactionLockPath(target),
                { ownerLabel: 'runtime-queue-writer', requireKnownDeadOwner: true, allowForeignHostStaleRecovery: false }
            );
            try {
                const stale = fs.readFileSync(target, 'utf8');
                fs.writeFileSync(${JSON.stringify(readyPath)}, 'ready');
                waitForPath(${JSON.stringify(legacyOwnerPath)}, 'legacy lock ownership');
                fs.writeFileSync(${JSON.stringify(overlapObservedPath)}, 'observed');
                fs.writeFileSync(target, stale.replace('| T-001 | TODO |', '| T-001 | IN_PROGRESS |'));
            } finally {
                locking.releaseFilesystemLock(handle);
            }
        `);
        const legacyWriter = run('legacy writer', `
            const fs = require('node:fs');
            const api = require(${JSON.stringify(queueModule)});
            ${boundedWaitSource}
            waitForPath(${JSON.stringify(readyPath)}, 'runtime writer readiness');
            const result = api.syncTaskQueueStatusDetailed(${JSON.stringify(root)}, 'T-002', 'IN_PROGRESS');
            if (result.outcome !== 'updated') throw new Error(JSON.stringify(result));
        `);

        const results = await Promise.allSettled([runtimeWriter, legacyWriter]);
        const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
        if (failure) throw failure.reason;
        const updated = fs.readFileSync(target, 'utf8');
        assert.equal(fs.readFileSync(overlapObservedPath, 'utf8'), 'observed');
        assert.match(updated, /T-001\s*\|[^|\n]*IN_PROGRESS/);
        assert.match(updated, /T-002\s*\|[^|\n]*IN_PROGRESS/);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
