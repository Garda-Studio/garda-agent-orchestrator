import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
    withLifecycleOperationLock,
    withLifecycleOperationLockAsync,
    getLifecycleOperationLockPath,
    getLastLifecycleLockTelemetry
} from '../../../src/lifecycle/common';

function mkTmpDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'gao-lifecycle-lock-'));
}


test('getLifecycleOperationLockPath returns path inside Garda runtime', () => {
    const lockPath = getLifecycleOperationLockPath('/some/project');
    assert.ok(lockPath.includes('garda-agent-orchestrator'));
    assert.ok(lockPath.includes('runtime'));
    assert.ok(lockPath.endsWith('.lifecycle-operation.lock'));
});


test('withLifecycleOperationLock acquires and releases lock', () => {
    const tmp = mkTmpDir();
    try {
        const result = withLifecycleOperationLock(tmp, 'test-sync', () => {
            const lockPath = getLifecycleOperationLockPath(tmp);
            assert.ok(fs.existsSync(lockPath), 'lock should exist during callback');
            return 42;
        });
        assert.equal(result, 42);
        const lockPath = getLifecycleOperationLockPath(tmp);
        assert.ok(!fs.existsSync(lockPath), 'lock should be released after callback');
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('withLifecycleOperationLock supports synchronous re-entrancy', () => {
    const tmp = mkTmpDir();
    try {
        const result = withLifecycleOperationLock(tmp, 'outer', () => {
            return withLifecycleOperationLock(tmp, 'inner', () => {
                return 'nested';
            });
        });
        assert.equal(result, 'nested');
        const lockPath = getLifecycleOperationLockPath(tmp);
        assert.ok(!fs.existsSync(lockPath), 'lock should be released after outer callback');
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('withLifecycleOperationLock releases lock on callback error', () => {
    const tmp = mkTmpDir();
    try {
        assert.throws(
            () => withLifecycleOperationLock(tmp, 'error-test', () => {
                throw new Error('callback error');
            }),
            /callback error/
        );
        const lockPath = getLifecycleOperationLockPath(tmp);
        assert.ok(!fs.existsSync(lockPath), 'lock should be released after error');
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('withLifecycleOperationLock reclaims lock from dead process', () => {
    const tmp = mkTmpDir();
    try {
        const lockPath = getLifecycleOperationLockPath(tmp);
        fs.mkdirSync(path.dirname(lockPath), { recursive: true });
        fs.mkdirSync(lockPath);
        fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
            pid: 999999999,
            hostname: os.hostname(),
            operation: 'stale-test',
            acquired_at_utc: new Date().toISOString(),
            target_root: tmp
        }));

        const result = withLifecycleOperationLock(tmp, 'reclaim', () => 'reclaimed');
        assert.equal(result, 'reclaimed');
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('withLifecycleOperationLock does not reclaim aged foreign-host lock without explicit override', () => {
    const tmp = mkTmpDir();
    const previousLifecycleEnv = process.env.GARDA_RECOVER_FOREIGN_HOST_LIFECYCLE_LOCKS;
    const previousFileLockEnv = process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS;
    delete process.env.GARDA_RECOVER_FOREIGN_HOST_LIFECYCLE_LOCKS;
    delete process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS;
    try {
        const lockPath = getLifecycleOperationLockPath(tmp);
        fs.mkdirSync(path.dirname(lockPath), { recursive: true });
        fs.mkdirSync(lockPath);
        fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
            pid: 999999999,
            hostname: 'remote-build-host',
            operation: 'remote-stale',
            acquired_at_utc: new Date().toISOString(),
            target_root: tmp
        }));
        const oldTime = new Date(Date.now() - (31 * 60 * 1000));
        fs.utimesSync(lockPath, oldTime, oldTime);
        if (fs.existsSync(path.join(lockPath, 'owner.json'))) {
            fs.utimesSync(path.join(lockPath, 'owner.json'), oldTime, oldTime);
        }

        let error: Error | null = null;
        try {
            withLifecycleOperationLock(tmp, 'reclaim-foreign-host', () => 'reclaimed');
        } catch (caught: unknown) {
            error = caught instanceof Error ? caught : new Error(String(caught));
        }
        assert.ok(error, 'foreign-host lock should block without explicit override');
        assert.match(error.message, /GARDA_RECOVER_FOREIGN_HOST_LIFECYCLE_LOCKS=1/);
        assert.doesNotMatch(String(error.message), /remote-build-host/);
    } finally {
        if (previousLifecycleEnv === undefined) {
            delete process.env.GARDA_RECOVER_FOREIGN_HOST_LIFECYCLE_LOCKS;
        } else {
            process.env.GARDA_RECOVER_FOREIGN_HOST_LIFECYCLE_LOCKS = previousLifecycleEnv;
        }
        if (previousFileLockEnv === undefined) {
            delete process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS;
        } else {
            process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS = previousFileLockEnv;
        }
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('withLifecycleOperationLock treats recent heartbeat as fresh when lock directory mtime is old', () => {
    const tmp = mkTmpDir();
    const previousLifecycleEnv = process.env.GARDA_RECOVER_FOREIGN_HOST_LIFECYCLE_LOCKS;
    const previousFileLockEnv = process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS;
    delete process.env.GARDA_RECOVER_FOREIGN_HOST_LIFECYCLE_LOCKS;
    delete process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS;
    try {
        const lockPath = getLifecycleOperationLockPath(tmp);
        fs.mkdirSync(path.dirname(lockPath), { recursive: true });
        fs.mkdirSync(lockPath);
        fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
            pid: 999999999,
            hostname: 'remote-build-host',
            operation: 'remote-recent-heartbeat',
            acquired_at_utc: new Date(Date.now() - (31 * 60 * 1000)).toISOString(),
            heartbeat_at_utc: new Date().toISOString(),
            target_root: tmp
        }));
        const oldTime = new Date(Date.now() - (31 * 60 * 1000));
        fs.utimesSync(lockPath, oldTime, oldTime);
        if (fs.existsSync(path.join(lockPath, 'owner.json'))) {
            fs.utimesSync(path.join(lockPath, 'owner.json'), oldTime, oldTime);
        }

        assert.throws(
            () => withLifecycleOperationLock(tmp, 'should-not-reclaim', () => 'nope'),
            /freshness_source=heartbeat.*heartbeat_age_ms=.*owner_file_age_ms=.*lock_dir_age_ms=/
        );
        assert.ok(fs.existsSync(lockPath), 'fresh heartbeat foreign-host lock should remain in place');
    } finally {
        if (previousLifecycleEnv === undefined) {
            delete process.env.GARDA_RECOVER_FOREIGN_HOST_LIFECYCLE_LOCKS;
        } else {
            process.env.GARDA_RECOVER_FOREIGN_HOST_LIFECYCLE_LOCKS = previousLifecycleEnv;
        }
        if (previousFileLockEnv === undefined) {
            delete process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS;
        } else {
            process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS = previousFileLockEnv;
        }
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('withLifecycleOperationLock uses stale heartbeat age even when lock directory mtime is fresh', () => {
    const tmp = mkTmpDir();
    try {
        const lockPath = getLifecycleOperationLockPath(tmp);
        fs.mkdirSync(path.dirname(lockPath), { recursive: true });
        fs.mkdirSync(lockPath);
        fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
            pid: 999999999,
            hostname: 'remote-build-host',
            operation: 'remote-stale-heartbeat',
            acquired_at_utc: new Date(Date.now() - (31 * 60 * 1000)).toISOString(),
            heartbeat_at_utc: new Date(Date.now() - (31 * 60 * 1000)).toISOString(),
            target_root: tmp
        }));

        const result = withLifecycleOperationLock(tmp, 'reclaim-stale-heartbeat', () => 'reclaimed', {
            allowForeignHostStaleRecovery: true
        });
        assert.equal(result, 'reclaimed');
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('withLifecycleOperationLock reclaims aged pid-only lock with dead PID and unknown host', () => {
    const tmp = mkTmpDir();
    try {
        const lockPath = getLifecycleOperationLockPath(tmp);
        fs.mkdirSync(path.dirname(lockPath), { recursive: true });
        fs.mkdirSync(lockPath);
        fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
            pid: 999999999,
            operation: 'legacy-partial',
            acquired_at_utc: new Date().toISOString(),
            target_root: tmp
        }));
        const oldTime = new Date(Date.now() - (31 * 60 * 1000));
        fs.utimesSync(lockPath, oldTime, oldTime);
        if (fs.existsSync(path.join(lockPath, 'owner.json'))) {
            fs.utimesSync(path.join(lockPath, 'owner.json'), oldTime, oldTime);
        }

        const result = withLifecycleOperationLock(tmp, 'recover-pid-only', () => 'reclaimed');
        assert.equal(result, 'reclaimed');
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('withLifecycleOperationLock reclaims aged foreign-host lock when explicit override is enabled', () => {
    const tmp = mkTmpDir();
    const previousEnv = process.env.GARDA_RECOVER_FOREIGN_HOST_LIFECYCLE_LOCKS;
    process.env.GARDA_RECOVER_FOREIGN_HOST_LIFECYCLE_LOCKS = '1';
    try {
        const lockPath = getLifecycleOperationLockPath(tmp);
        fs.mkdirSync(path.dirname(lockPath), { recursive: true });
        fs.mkdirSync(lockPath);
        fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
            pid: 999999999,
            hostname: 'remote-build-host',
            operation: 'remote-stale',
            acquired_at_utc: new Date().toISOString(),
            target_root: tmp
        }));
        const oldTime = new Date(Date.now() - (31 * 60 * 1000));
        fs.utimesSync(lockPath, oldTime, oldTime);
        if (fs.existsSync(path.join(lockPath, 'owner.json'))) {
            fs.utimesSync(path.join(lockPath, 'owner.json'), oldTime, oldTime);
        }

        const result = withLifecycleOperationLock(tmp, 'reclaim-foreign-host', () => 'reclaimed');
        assert.equal(result, 'reclaimed');
    } finally {
        if (previousEnv === undefined) {
            delete process.env.GARDA_RECOVER_FOREIGN_HOST_LIFECYCLE_LOCKS;
        } else {
            process.env.GARDA_RECOVER_FOREIGN_HOST_LIFECYCLE_LOCKS = previousEnv;
        }
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('withLifecycleOperationLock reclaims aged foreign-host lock with call-scoped override', () => {
    const tmp = mkTmpDir();
    try {
        const lockPath = getLifecycleOperationLockPath(tmp);
        fs.mkdirSync(path.dirname(lockPath), { recursive: true });
        fs.mkdirSync(lockPath);
        fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
            pid: 999999999,
            hostname: 'remote-build-host',
            operation: 'remote-stale',
            acquired_at_utc: new Date().toISOString(),
            target_root: tmp
        }));
        const oldTime = new Date(Date.now() - (31 * 60 * 1000));
        fs.utimesSync(lockPath, oldTime, oldTime);
        if (fs.existsSync(path.join(lockPath, 'owner.json'))) {
            fs.utimesSync(path.join(lockPath, 'owner.json'), oldTime, oldTime);
        }

        const result = withLifecycleOperationLock(tmp, 'reclaim-foreign-host', () => 'reclaimed', {
            allowForeignHostStaleRecovery: true
        });
        assert.equal(result, 'reclaimed');
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('withLifecycleOperationLock explicit false override wins over env-based recovery', () => {
    const tmp = mkTmpDir();
    const previousEnv = process.env.GARDA_RECOVER_FOREIGN_HOST_LIFECYCLE_LOCKS;
    process.env.GARDA_RECOVER_FOREIGN_HOST_LIFECYCLE_LOCKS = '1';
    try {
        const lockPath = getLifecycleOperationLockPath(tmp);
        fs.mkdirSync(path.dirname(lockPath), { recursive: true });
        fs.mkdirSync(lockPath);
        fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
            pid: 999999999,
            hostname: 'remote-build-host',
            operation: 'remote-stale',
            acquired_at_utc: new Date().toISOString(),
            target_root: tmp
        }));
        const oldTime = new Date(Date.now() - (31 * 60 * 1000));
        fs.utimesSync(lockPath, oldTime, oldTime);
        if (fs.existsSync(path.join(lockPath, 'owner.json'))) {
            fs.utimesSync(path.join(lockPath, 'owner.json'), oldTime, oldTime);
        }

        assert.throws(
            () => withLifecycleOperationLock(tmp, 'reclaim-foreign-host', () => 'reclaimed', {
                allowForeignHostStaleRecovery: false
            }),
            /GARDA_RECOVER_FOREIGN_HOST_LIFECYCLE_LOCKS=1|GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS=1/
        );
    } finally {
        if (previousEnv === undefined) {
            delete process.env.GARDA_RECOVER_FOREIGN_HOST_LIFECYCLE_LOCKS;
        } else {
            process.env.GARDA_RECOVER_FOREIGN_HOST_LIFECYCLE_LOCKS = previousEnv;
        }
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('withLifecycleOperationLock does not reclaim fresh foreign-host lock before stale threshold', () => {
    const tmp = mkTmpDir();
    const previousLifecycleEnv = process.env.GARDA_RECOVER_FOREIGN_HOST_LIFECYCLE_LOCKS;
    const previousFileLockEnv = process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS;
    delete process.env.GARDA_RECOVER_FOREIGN_HOST_LIFECYCLE_LOCKS;
    delete process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS;
    try {
        const lockPath = getLifecycleOperationLockPath(tmp);
        fs.mkdirSync(path.dirname(lockPath), { recursive: true });
        fs.mkdirSync(lockPath);
        fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
            pid: 999999999,
            hostname: 'remote-build-host',
            operation: 'remote-fresh',
            acquired_at_utc: new Date().toISOString(),
            target_root: tmp
        }));

        assert.throws(
            () => withLifecycleOperationLock(tmp, 'should-fail', () => 'nope'),
            /Another lifecycle operation is already running/
        );
    } finally {
        if (previousLifecycleEnv === undefined) {
            delete process.env.GARDA_RECOVER_FOREIGN_HOST_LIFECYCLE_LOCKS;
        } else {
            process.env.GARDA_RECOVER_FOREIGN_HOST_LIFECYCLE_LOCKS = previousLifecycleEnv;
        }
        if (previousFileLockEnv === undefined) {
            delete process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS;
        } else {
            process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS = previousFileLockEnv;
        }
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('withLifecycleOperationLock writes correct owner metadata', () => {
    const tmp = mkTmpDir();
    try {
        withLifecycleOperationLock(tmp, 'metadata-test', () => {
            const lockPath = getLifecycleOperationLockPath(tmp);
            const ownerPath = path.join(lockPath, 'owner.json');
            const owner = JSON.parse(fs.readFileSync(ownerPath, 'utf8'));
            assert.ok(typeof owner.lock_id === 'string' && owner.lock_id.length > 0);
            assert.equal(owner.pid, process.pid);
            assert.equal(owner.hostname, os.hostname());
            assert.equal(owner.operation, 'metadata-test');
            assert.ok(typeof owner.acquired_at_utc === 'string');
            assert.equal(owner.heartbeat_at_utc, owner.acquired_at_utc);
            assert.ok(typeof owner.command === 'string' && owner.command.includes('metadata-test'));
            assert.ok(typeof owner.target_root === 'string');
        });
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});


test('withLifecycleOperationLockAsync acquires and releases lock', async () => {
    const tmp = mkTmpDir();
    try {
        const result = await withLifecycleOperationLockAsync(tmp, 'async-test', async () => {
            const lockPath = getLifecycleOperationLockPath(tmp);
            assert.ok(fs.existsSync(lockPath), 'lock should exist during callback');
            return 42;
        });
        assert.equal(result, 42);
        const lockPath = getLifecycleOperationLockPath(tmp);
        assert.ok(!fs.existsSync(lockPath), 'lock should be released after callback');
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('withLifecycleOperationLockAsync refreshes heartbeat during long callbacks', async () => {
    const tmp = mkTmpDir();
    try {
        await withLifecycleOperationLockAsync(tmp, 'async-heartbeat', async () => {
            const lockPath = getLifecycleOperationLockPath(tmp);
            const ownerPath = path.join(lockPath, 'owner.json');
            const initialOwner = JSON.parse(fs.readFileSync(ownerPath, 'utf8'));
            const initialIdentity = fs.statSync(ownerPath, { bigint: true });
            await new Promise((resolve) => setTimeout(resolve, 80));
            const refreshedOwner = JSON.parse(fs.readFileSync(ownerPath, 'utf8'));

            assert.equal(refreshedOwner.lock_id, initialOwner.lock_id);
            const refreshedIdentity = fs.statSync(ownerPath, { bigint: true });
            assert.equal(refreshedIdentity.dev, initialIdentity.dev);
            assert.equal(refreshedIdentity.ino, initialIdentity.ino);
            assert.ok(
                Date.parse(refreshedOwner.heartbeat_at_utc) > Date.parse(initialOwner.heartbeat_at_utc),
                'heartbeat should advance while async lifecycle callback is running'
            );
        }, {
            heartbeatIntervalMs: 20
        });
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

// Windows denies the pinned-directory replacement; the genuine race executes on Linux.
test('lifecycle heartbeat preserves a new owner after the stale lock is replaced by a competing process', { skip: process.platform === 'win32' }, async (t) => {
    const tmp = mkTmpDir();
    const lockPath = getLifecycleOperationLockPath(tmp);
    const ownerPath = path.join(lockPath, 'owner.json');
    const mutableFs = require('node:fs') as typeof fs;
    const originalWriteFile = mutableFs.writeFileSync;
    const originalWrite = mutableFs.writeSync;
    let replacementBytes: Buffer | null = null;
    let replacementIdentity: fs.BigIntStats | null = null;
    try {
        await withLifecycleOperationLockAsync(tmp, 'heartbeat-old-owner', async () => {
            const originalIdentity = fs.statSync(ownerPath, { bigint: true });
            let signalWrite!: () => void;
            const heartbeatWritten = new Promise<void>((resolve) => { signalWrite = resolve; });
            const replaceBeforeWrite = (target: unknown): void => {
                if (replacementBytes !== null) return;
                if (target !== ownerPath && (typeof target !== 'number'
                    || fs.fstatSync(target, { bigint: true }).ino !== originalIdentity.ino)) return;
                const child = spawnSync(process.execPath, ['--eval', [
                    "const fs = require('node:fs');",
                    "const { withLifecycleOperationLock } = require(process.argv[1]);",
                    "fs.renameSync(process.argv[2], process.argv[2] + '.displaced');",
                    "withLifecycleOperationLock(process.argv[3], 'heartbeat-new-owner', () => {",
                    "  process.stdout.write(JSON.stringify({ pid: process.pid }));",
                    "  process.exit(0);", // Leave a real crashed owner for recovery coverage.
                    "});"
                ].join('\n'), require.resolve('../../../src/lifecycle/common'), lockPath, tmp], {
                    encoding: 'utf8', timeout: 5000
                });
                assert.ifError(child.error);
                assert.equal(child.status, 0, child.stderr);
                const claimed = JSON.parse(child.stdout);
                assert.notEqual(claimed.pid, process.pid);
                replacementBytes = fs.readFileSync(ownerPath);
                replacementIdentity = fs.statSync(ownerPath, { bigint: true });
                assert.notEqual(replacementIdentity.ino, originalIdentity.ino);
                assert.equal(JSON.parse(replacementBytes.toString('utf8')).pid, claimed.pid);
                console.log(JSON.stringify({ case: 'lifecycle-heartbeat-replacement', competingPid: claimed.pid,
                    originalInode: String(originalIdentity.ino), replacementInode: String(replacementIdentity.ino) }));
                signalWrite();
            };
            t.mock.method(mutableFs, 'writeFileSync', (...args: unknown[]) => {
                replaceBeforeWrite(args[0]);
                return Reflect.apply(originalWriteFile, mutableFs, args);
            });
            t.mock.method(mutableFs, 'writeSync', (...args: unknown[]) => {
                replaceBeforeWrite(args[0]);
                return Reflect.apply(originalWrite, mutableFs, args);
            });
            let timeout: ReturnType<typeof setTimeout> | undefined;
            try {
                await Promise.race([heartbeatWritten, new Promise<never>((_, reject) => {
                    timeout = setTimeout(() => reject(new Error('heartbeat write barrier was not reached')), 5000);
                })]);
            } finally {
                clearTimeout(timeout);
            }
            assert.ok(replacementBytes, 'a separate process must acquire the replacement');
            assert.deepEqual(fs.readFileSync(ownerPath), replacementBytes, 'old heartbeat must preserve new owner bytes');
            assert.equal(fs.statSync(ownerPath, { bigint: true }).ino, replacementIdentity!.ino);
            await new Promise((resolve) => setTimeout(resolve, 30));
            assert.deepEqual(fs.readFileSync(ownerPath), replacementBytes, 'later old heartbeats must skip the replacement');
        }, { heartbeatIntervalMs: 20 });
        assert.deepEqual(fs.readFileSync(ownerPath), replacementBytes, 'old release must preserve the replacement');
        assert.equal(withLifecycleOperationLock(tmp, 'recover-crashed-replacement', () => 'recovered'), 'recovered');
        assert.equal(getLastLifecycleLockTelemetry()?.staleLockRecovered, true);
        assert.equal(fs.existsSync(lockPath), false);
    } finally {
        t.mock.restoreAll();
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('withLifecycleOperationLockAsync releases lock on callback error', async () => {
    const tmp = mkTmpDir();
    try {
        await assert.rejects(
            () => withLifecycleOperationLockAsync(tmp, 'error-test', async () => {
                throw new Error('async callback error');
            }),
            /async callback error/
        );
        const lockPath = getLifecycleOperationLockPath(tmp);
        assert.ok(!fs.existsSync(lockPath), 'lock should be released after error');
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('withLifecycleOperationLockAsync supports same-root nested async re-entrancy', { concurrency: false }, async () => {
    const tmp = mkTmpDir();
    const executionOrder: string[] = [];
    try {
        const result = await withLifecycleOperationLockAsync(tmp, 'outer', async () => {
            executionOrder.push('outer-start');
            const nested = await withLifecycleOperationLockAsync(tmp, 'inner', async () => {
                executionOrder.push('inner-start');
                await new Promise((resolve) => setTimeout(resolve, 10));
                executionOrder.push('inner-end');
                return 'nested-ok';
            });
            executionOrder.push('outer-end');
            return nested;
        });

        assert.equal(result, 'nested-ok');
        assert.deepEqual(executionOrder, [
            'outer-start',
            'inner-start',
            'inner-end',
            'outer-end'
        ]);
        assert.ok(!fs.existsSync(getLifecycleOperationLockPath(tmp)), 'lock should be released after nested async callback');
        const telemetry = getLastLifecycleLockTelemetry();
        assert.ok(telemetry != null, 'telemetry should be available after nested async callback');
        assert.equal(telemetry!.queueWaitMs, 0);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('withLifecycleOperationLockAsync serializes concurrent callers', { concurrency: false }, async () => {
    const tmp = mkTmpDir();
    const executionOrder: string[] = [];
    try {
        const p1 = withLifecycleOperationLockAsync(tmp, 'op1', async () => {
            executionOrder.push('op1-start');
            await new Promise((r) => setTimeout(r, 50));
            executionOrder.push('op1-end');
        });
        const p2 = withLifecycleOperationLockAsync(tmp, 'op2', async () => {
            executionOrder.push('op2-start');
            await new Promise((r) => setTimeout(r, 10));
            executionOrder.push('op2-end');
        });
        await Promise.all([p1, p2]);
        assert.equal(executionOrder[0], 'op1-start');
        assert.equal(executionOrder[1], 'op1-end');
        assert.equal(executionOrder[2], 'op2-start');
        assert.equal(executionOrder[3], 'op2-end');
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('withLifecycleOperationLockAsync bounds queue wait time and leaves later calls recoverable', { concurrency: false }, async () => {
    const tmp = mkTmpDir();
    try {
        let timedWaiterRan = false;
        let releaseBlocker!: () => void;
        const blockerReleasePromise = new Promise<void>((resolve) => {
            releaseBlocker = resolve;
        });

        const blocker = withLifecycleOperationLockAsync(tmp, 'blocker', async () => {
            await blockerReleasePromise;
            return 'blocker-done';
        });

        const lockPath = getLifecycleOperationLockPath(tmp);
        const waitForLockStartedAt = Date.now();
        while (!fs.existsSync(lockPath)) {
            if (Date.now() - waitForLockStartedAt > 500) {
                throw new Error('timed out waiting for blocker lifecycle lock to appear');
            }
            await new Promise((resolve) => setTimeout(resolve, 5));
        }

        await assert.rejects(
            () => withLifecycleOperationLockAsync(tmp, 'timed-waiter', async () => {
                timedWaiterRan = true;
                return 'should-timeout';
            }, {
                queueTimeoutMs: 40
            }),
            /Lifecycle async queue wait exceeded 40ms.*requested_operation='timed-waiter'.*blocking_operation='blocker'/
        );
        assert.equal(timedWaiterRan, false);

        releaseBlocker();
        await blocker;
        await new Promise((resolve) => setTimeout(resolve, 20));
        assert.equal(timedWaiterRan, false);

        const recoveryResult = await withLifecycleOperationLockAsync(tmp, 'recovered', async () => 'recovered-ok');
        assert.equal(recoveryResult, 'recovered-ok');
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('withLifecycleOperationLockAsync keeps later waiters queued behind the blocker after a middle timeout', { concurrency: false }, async () => {
    const tmp = mkTmpDir();
    const executionOrder: string[] = [];
    try {
        let timedWaiterRan = false;
        let releaseBlocker!: () => void;
        const blockerReleasePromise = new Promise<void>((resolve) => {
            releaseBlocker = resolve;
        });

        const blocker = withLifecycleOperationLockAsync(tmp, 'blocker', async () => {
            executionOrder.push('blocker-start');
            await blockerReleasePromise;
            executionOrder.push('blocker-end');
            return 'blocker-done';
        });

        const lockPath = getLifecycleOperationLockPath(tmp);
        const waitForLockStartedAt = Date.now();
        while (!fs.existsSync(lockPath)) {
            if (Date.now() - waitForLockStartedAt > 500) {
                throw new Error('timed out waiting for blocker lifecycle lock to appear');
            }
            await new Promise((resolve) => setTimeout(resolve, 5));
        }

        const timedWaiter = withLifecycleOperationLockAsync(tmp, 'timed-waiter', async () => {
            timedWaiterRan = true;
            return 'should-timeout';
        }, {
            queueTimeoutMs: 40
        });

        await new Promise((resolve) => setTimeout(resolve, 10));

        const laterWaiter = withLifecycleOperationLockAsync(tmp, 'later-waiter', async () => {
            executionOrder.push('later-start');
            executionOrder.push('later-end');
            return 'later-ok';
        });

        await assert.rejects(
            () => timedWaiter,
            /Lifecycle async queue wait exceeded 40ms.*requested_operation='timed-waiter'.*blocking_operation='blocker'/
        );
        assert.equal(timedWaiterRan, false);

        await new Promise((resolve) => setTimeout(resolve, 60));
        assert.deepEqual(executionOrder, ['blocker-start']);

        releaseBlocker();
        await blocker;
        await new Promise((resolve) => setTimeout(resolve, 20));
        assert.equal(timedWaiterRan, false);

        const laterResult = await laterWaiter;
        assert.equal(laterResult, 'later-ok');
        assert.deepEqual(executionOrder, [
            'blocker-start',
            'blocker-end',
            'later-start',
            'later-end'
        ]);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('withLifecycleOperationLockAsync serializes three concurrent callers', { concurrency: false }, async () => {
    const tmp = mkTmpDir();
    const executionOrder: string[] = [];
    try {
        const p1 = withLifecycleOperationLockAsync(tmp, 'a', async () => {
            executionOrder.push('a-start');
            await new Promise((r) => setTimeout(r, 30));
            executionOrder.push('a-end');
        });
        const p2 = withLifecycleOperationLockAsync(tmp, 'b', async () => {
            executionOrder.push('b-start');
            await new Promise((r) => setTimeout(r, 10));
            executionOrder.push('b-end');
        });
        const p3 = withLifecycleOperationLockAsync(tmp, 'c', async () => {
            executionOrder.push('c-start');
            executionOrder.push('c-end');
        });
        await Promise.all([p1, p2, p3]);
        // All three should run sequentially: a completes, then b, then c
        assert.deepEqual(executionOrder, [
            'a-start', 'a-end',
            'b-start', 'b-end',
            'c-start', 'c-end'
        ]);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('withLifecycleOperationLockAsync allows independent targets concurrently', { concurrency: false }, async () => {
    const tmp1 = mkTmpDir();
    const tmp2 = mkTmpDir();
    const executionOrder: string[] = [];
    try {
        const p1 = withLifecycleOperationLockAsync(tmp1, 'target1', async () => {
            executionOrder.push('t1-start');
            await new Promise((r) => setTimeout(r, 30));
            executionOrder.push('t1-end');
        });
        const p2 = withLifecycleOperationLockAsync(tmp2, 'target2', async () => {
            executionOrder.push('t2-start');
            await new Promise((r) => setTimeout(r, 10));
            executionOrder.push('t2-end');
        });
        await Promise.all([p1, p2]);
        // Both should start before either finishes (different targets)
        assert.equal(executionOrder[0], 't1-start');
        assert.equal(executionOrder[1], 't2-start');
    } finally {
        fs.rmSync(tmp1, { recursive: true, force: true });
        fs.rmSync(tmp2, { recursive: true, force: true });
    }
});

test('withLifecycleOperationLockAsync does not reclaim aged foreign-host lock without explicit override', async () => {
    const tmp = mkTmpDir();
    const previousLifecycleEnv = process.env.GARDA_RECOVER_FOREIGN_HOST_LIFECYCLE_LOCKS;
    const previousFileLockEnv = process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS;
    delete process.env.GARDA_RECOVER_FOREIGN_HOST_LIFECYCLE_LOCKS;
    delete process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS;
    try {
        const lockPath = getLifecycleOperationLockPath(tmp);
        fs.mkdirSync(path.dirname(lockPath), { recursive: true });
        fs.mkdirSync(lockPath);
        fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
            pid: 999999999,
            hostname: 'remote-build-host',
            operation: 'remote-stale',
            acquired_at_utc: new Date().toISOString(),
            target_root: tmp
        }));
        const oldTime = new Date(Date.now() - (31 * 60 * 1000));
        fs.utimesSync(lockPath, oldTime, oldTime);
        if (fs.existsSync(path.join(lockPath, 'owner.json'))) {
            fs.utimesSync(path.join(lockPath, 'owner.json'), oldTime, oldTime);
        }

        let error: Error | null = null;
        try {
            await withLifecycleOperationLockAsync(tmp, 'async-foreign', async () => 'reclaimed');
        } catch (caught: unknown) {
            error = caught instanceof Error ? caught : new Error(String(caught));
        }
        assert.ok(error, 'async foreign-host lock should block without explicit override');
        assert.match(error.message, /GARDA_RECOVER_FOREIGN_HOST_LIFECYCLE_LOCKS=1/);
        assert.doesNotMatch(String(error.message), /remote-build-host/);
    } finally {
        if (previousLifecycleEnv === undefined) {
            delete process.env.GARDA_RECOVER_FOREIGN_HOST_LIFECYCLE_LOCKS;
        } else {
            process.env.GARDA_RECOVER_FOREIGN_HOST_LIFECYCLE_LOCKS = previousLifecycleEnv;
        }
        if (previousFileLockEnv === undefined) {
            delete process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS;
        } else {
            process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS = previousFileLockEnv;
        }
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('withLifecycleOperationLockAsync does not reclaim fresh foreign-host lock before stale threshold', async () => {
    const tmp = mkTmpDir();
    const previousLifecycleEnv = process.env.GARDA_RECOVER_FOREIGN_HOST_LIFECYCLE_LOCKS;
    const previousFileLockEnv = process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS;
    delete process.env.GARDA_RECOVER_FOREIGN_HOST_LIFECYCLE_LOCKS;
    delete process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS;
    try {
        const lockPath = getLifecycleOperationLockPath(tmp);
        fs.mkdirSync(path.dirname(lockPath), { recursive: true });
        fs.mkdirSync(lockPath);
        fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
            pid: 999999999,
            hostname: 'remote-build-host',
            operation: 'remote-fresh',
            acquired_at_utc: new Date().toISOString(),
            target_root: tmp
        }));

        await assert.rejects(
            () => withLifecycleOperationLockAsync(tmp, 'async-fresh-foreign', async () => 'nope'),
            /Another lifecycle operation is already running/
        );
    } finally {
        if (previousLifecycleEnv === undefined) {
            delete process.env.GARDA_RECOVER_FOREIGN_HOST_LIFECYCLE_LOCKS;
        } else {
            process.env.GARDA_RECOVER_FOREIGN_HOST_LIFECYCLE_LOCKS = previousLifecycleEnv;
        }
        if (previousFileLockEnv === undefined) {
            delete process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS;
        } else {
            process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS = previousFileLockEnv;
        }
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('withLifecycleOperationLockAsync reclaims aged foreign-host lock when explicit override is enabled', async () => {
    const tmp = mkTmpDir();
    const previousEnv = process.env.GARDA_RECOVER_FOREIGN_HOST_LIFECYCLE_LOCKS;
    process.env.GARDA_RECOVER_FOREIGN_HOST_LIFECYCLE_LOCKS = '1';
    try {
        const lockPath = getLifecycleOperationLockPath(tmp);
        fs.mkdirSync(path.dirname(lockPath), { recursive: true });
        fs.mkdirSync(lockPath);
        fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
            pid: 999999999,
            hostname: 'remote-build-host',
            operation: 'remote-stale',
            acquired_at_utc: new Date().toISOString(),
            target_root: tmp
        }));
        const oldTime = new Date(Date.now() - (31 * 60 * 1000));
        fs.utimesSync(lockPath, oldTime, oldTime);
        if (fs.existsSync(path.join(lockPath, 'owner.json'))) {
            fs.utimesSync(path.join(lockPath, 'owner.json'), oldTime, oldTime);
        }

        const result = await withLifecycleOperationLockAsync(tmp, 'async-foreign', async () => 'reclaimed');
        assert.equal(result, 'reclaimed');
    } finally {
        if (previousEnv === undefined) {
            delete process.env.GARDA_RECOVER_FOREIGN_HOST_LIFECYCLE_LOCKS;
        } else {
            process.env.GARDA_RECOVER_FOREIGN_HOST_LIFECYCLE_LOCKS = previousEnv;
        }
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('withLifecycleOperationLockAsync reclaims aged foreign-host lock with call-scoped override', async () => {
    const tmp = mkTmpDir();
    try {
        const lockPath = getLifecycleOperationLockPath(tmp);
        fs.mkdirSync(path.dirname(lockPath), { recursive: true });
        fs.mkdirSync(lockPath);
        fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
            pid: 999999999,
            hostname: 'remote-build-host',
            operation: 'remote-stale',
            acquired_at_utc: new Date().toISOString(),
            target_root: tmp
        }));
        const oldTime = new Date(Date.now() - (31 * 60 * 1000));
        fs.utimesSync(lockPath, oldTime, oldTime);
        if (fs.existsSync(path.join(lockPath, 'owner.json'))) {
            fs.utimesSync(path.join(lockPath, 'owner.json'), oldTime, oldTime);
        }

        const result = await withLifecycleOperationLockAsync(tmp, 'async-foreign', async () => 'reclaimed', {
            allowForeignHostStaleRecovery: true
        });
        assert.equal(result, 'reclaimed');
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('withLifecycleOperationLockAsync reclaims aged pid-only lock with dead PID and unknown host', async () => {
    const tmp = mkTmpDir();
    try {
        const lockPath = getLifecycleOperationLockPath(tmp);
        fs.mkdirSync(path.dirname(lockPath), { recursive: true });
        fs.mkdirSync(lockPath);
        fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
            pid: 999999999,
            operation: 'legacy-partial',
            acquired_at_utc: new Date().toISOString(),
            target_root: tmp
        }));
        const oldTime = new Date(Date.now() - (31 * 60 * 1000));
        fs.utimesSync(lockPath, oldTime, oldTime);
        if (fs.existsSync(path.join(lockPath, 'owner.json'))) {
            fs.utimesSync(path.join(lockPath, 'owner.json'), oldTime, oldTime);
        }

        const result = await withLifecycleOperationLockAsync(tmp, 'async-pid-only', async () => 'reclaimed');
        assert.equal(result, 'reclaimed');
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('withLifecycleOperationLockAsync explicit false override wins over env-based recovery', async () => {
    const tmp = mkTmpDir();
    const previousEnv = process.env.GARDA_RECOVER_FOREIGN_HOST_LIFECYCLE_LOCKS;
    process.env.GARDA_RECOVER_FOREIGN_HOST_LIFECYCLE_LOCKS = '1';
    try {
        const lockPath = getLifecycleOperationLockPath(tmp);
        fs.mkdirSync(path.dirname(lockPath), { recursive: true });
        fs.mkdirSync(lockPath);
        fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
            pid: 999999999,
            hostname: 'remote-build-host',
            operation: 'remote-stale',
            acquired_at_utc: new Date().toISOString(),
            target_root: tmp
        }));
        const oldTime = new Date(Date.now() - (31 * 60 * 1000));
        fs.utimesSync(lockPath, oldTime, oldTime);
        if (fs.existsSync(path.join(lockPath, 'owner.json'))) {
            fs.utimesSync(path.join(lockPath, 'owner.json'), oldTime, oldTime);
        }

        await assert.rejects(
            () => withLifecycleOperationLockAsync(tmp, 'async-foreign', async () => 'reclaimed', {
                allowForeignHostStaleRecovery: false
            }),
            /GARDA_RECOVER_FOREIGN_HOST_LIFECYCLE_LOCKS=1|GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS=1/
        );
    } finally {
        if (previousEnv === undefined) {
            delete process.env.GARDA_RECOVER_FOREIGN_HOST_LIFECYCLE_LOCKS;
        } else {
            process.env.GARDA_RECOVER_FOREIGN_HOST_LIFECYCLE_LOCKS = previousEnv;
        }
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('withLifecycleOperationLock reclaims aged foreign-host lock when shared file-lock env alias is enabled', () => {
    const tmp = mkTmpDir();
    const previousLifecycleEnv = process.env.GARDA_RECOVER_FOREIGN_HOST_LIFECYCLE_LOCKS;
    const previousFileLockEnv = process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS;
    delete process.env.GARDA_RECOVER_FOREIGN_HOST_LIFECYCLE_LOCKS;
    process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS = '1';
    try {
        const lockPath = getLifecycleOperationLockPath(tmp);
        fs.mkdirSync(path.dirname(lockPath), { recursive: true });
        fs.mkdirSync(lockPath);
        fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
            pid: 999999999,
            hostname: 'remote-build-host',
            operation: 'remote-stale',
            acquired_at_utc: new Date().toISOString(),
            target_root: tmp
        }));
        const oldTime = new Date(Date.now() - (31 * 60 * 1000));
        fs.utimesSync(lockPath, oldTime, oldTime);
        if (fs.existsSync(path.join(lockPath, 'owner.json'))) {
            fs.utimesSync(path.join(lockPath, 'owner.json'), oldTime, oldTime);
        }

        const result = withLifecycleOperationLock(tmp, 'reclaim-foreign-host', () => 'reclaimed');
        assert.equal(result, 'reclaimed');
    } finally {
        if (previousLifecycleEnv === undefined) {
            delete process.env.GARDA_RECOVER_FOREIGN_HOST_LIFECYCLE_LOCKS;
        } else {
            process.env.GARDA_RECOVER_FOREIGN_HOST_LIFECYCLE_LOCKS = previousLifecycleEnv;
        }
        if (previousFileLockEnv === undefined) {
            delete process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS;
        } else {
            process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS = previousFileLockEnv;
        }
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('withLifecycleOperationLockAsync reclaims aged foreign-host lock when shared file-lock env alias is enabled', async () => {
    const tmp = mkTmpDir();
    const previousLifecycleEnv = process.env.GARDA_RECOVER_FOREIGN_HOST_LIFECYCLE_LOCKS;
    const previousFileLockEnv = process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS;
    delete process.env.GARDA_RECOVER_FOREIGN_HOST_LIFECYCLE_LOCKS;
    process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS = '1';
    try {
        const lockPath = getLifecycleOperationLockPath(tmp);
        fs.mkdirSync(path.dirname(lockPath), { recursive: true });
        fs.mkdirSync(lockPath);
        fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
            pid: 999999999,
            hostname: 'remote-build-host',
            operation: 'remote-stale',
            acquired_at_utc: new Date().toISOString(),
            target_root: tmp
        }));
        const oldTime = new Date(Date.now() - (31 * 60 * 1000));
        fs.utimesSync(lockPath, oldTime, oldTime);
        if (fs.existsSync(path.join(lockPath, 'owner.json'))) {
            fs.utimesSync(path.join(lockPath, 'owner.json'), oldTime, oldTime);
        }

        const result = await withLifecycleOperationLockAsync(tmp, 'reclaim-foreign-host', async () => 'reclaimed');
        assert.equal(result, 'reclaimed');
    } finally {
        if (previousLifecycleEnv === undefined) {
            delete process.env.GARDA_RECOVER_FOREIGN_HOST_LIFECYCLE_LOCKS;
        } else {
            process.env.GARDA_RECOVER_FOREIGN_HOST_LIFECYCLE_LOCKS = previousLifecycleEnv;
        }
        if (previousFileLockEnv === undefined) {
            delete process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS;
        } else {
            process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS = previousFileLockEnv;
        }
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});


test('withLifecycleOperationLock reclaims SIGKILL-orphaned lock with missing metadata after grace period', () => {
    const tmp = mkTmpDir();
    try {
        const lockPath = getLifecycleOperationLockPath(tmp);
        fs.mkdirSync(path.dirname(lockPath), { recursive: true });
        // Simulate SIGKILL crash: lock directory exists but no owner.json
        fs.mkdirSync(lockPath);
        // Age the lock beyond the grace period
        const oldTime = new Date(Date.now() - 5000);
        fs.utimesSync(lockPath, oldTime, oldTime);
        if (fs.existsSync(path.join(lockPath, 'owner.json'))) {
            fs.utimesSync(path.join(lockPath, 'owner.json'), oldTime, oldTime);
        }

        const result = withLifecycleOperationLock(tmp, 'reclaim-orphan', () => 'recovered');
        assert.equal(result, 'recovered');
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('withLifecycleOperationLock does not reclaim orphaned lock within grace period', () => {
    const tmp = mkTmpDir();
    try {
        const lockPath = getLifecycleOperationLockPath(tmp);
        fs.mkdirSync(path.dirname(lockPath), { recursive: true });
        // Simulate very recent SIGKILL crash: lock directory exists, no owner.json,
        // but within the grace period (mtime is now)
        fs.mkdirSync(lockPath);

        assert.throws(
            () => withLifecycleOperationLock(tmp, 'too-early', () => 'should-not-reach'),
            /Another lifecycle operation is already running/
        );
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('withLifecycleOperationLock redacts absolute target and lock paths in contention errors', () => {
    const tmp = mkTmpDir();
    try {
        const lockPath = getLifecycleOperationLockPath(tmp);
        fs.mkdirSync(path.dirname(lockPath), { recursive: true });
        fs.mkdirSync(lockPath);
        fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
            pid: process.pid,
            hostname: os.hostname(),
            operation: 'blocker',
            acquired_at_utc: new Date().toISOString(),
            target_root: tmp
        }));

        assert.throws(
            () => withLifecycleOperationLock(tmp, 'should-fail', () => 'nope'),
            function (error: unknown) {
                assert.ok(error instanceof Error);
                assert.ok(error.message.includes("Another lifecycle operation is already running for '.'"));
                assert.ok(error.message.includes("lock='garda-agent-orchestrator/runtime/.lifecycle-operation.lock'"));
                assert.ok(!error.message.includes(lockPath.replace(/\\/g, '/')));
                return true;
            }
        );
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('withLifecycleOperationLock reclaims SIGKILL-orphaned lock with corrupt metadata after grace period', () => {
    const tmp = mkTmpDir();
    try {
        const lockPath = getLifecycleOperationLockPath(tmp);
        fs.mkdirSync(path.dirname(lockPath), { recursive: true });
        fs.mkdirSync(lockPath);
        // Write corrupt metadata that parses to all-null fields
        fs.writeFileSync(path.join(lockPath, 'owner.json'), 'NOT VALID JSON{{{', 'utf8');
        const oldTime = new Date(Date.now() - 5000);
        fs.utimesSync(lockPath, oldTime, oldTime);
        if (fs.existsSync(path.join(lockPath, 'owner.json'))) {
            fs.utimesSync(path.join(lockPath, 'owner.json'), oldTime, oldTime);
        }

        const result = withLifecycleOperationLock(tmp, 'reclaim-corrupt', () => 'recovered');
        assert.equal(result, 'recovered');
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('withLifecycleOperationLock reclaims lock with partial metadata (hostname only, no PID) after grace period', () => {
    const tmp = mkTmpDir();
    try {
        const lockPath = getLifecycleOperationLockPath(tmp);
        fs.mkdirSync(path.dirname(lockPath), { recursive: true });
        fs.mkdirSync(lockPath);
        // Write partial metadata with hostname but no valid PID
        fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
            hostname: os.hostname(),
            operation: 'partial-write'
        }), 'utf8');
        const oldTime = new Date(Date.now() - 5000);
        fs.utimesSync(lockPath, oldTime, oldTime);
        if (fs.existsSync(path.join(lockPath, 'owner.json'))) {
            fs.utimesSync(path.join(lockPath, 'owner.json'), oldTime, oldTime);
        }

        const result = withLifecycleOperationLock(tmp, 'reclaim-partial', () => 'recovered');
        assert.equal(result, 'recovered');
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('withLifecycleOperationLockAsync does not poison queue on acquisition failure', async () => {
    const tmp = mkTmpDir();
    try {
        const lockPath = getLifecycleOperationLockPath(tmp);
        fs.mkdirSync(path.dirname(lockPath), { recursive: true });
        // Simulate a live-process lock that cannot be reclaimed
        fs.mkdirSync(lockPath);
        fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
            pid: process.pid,
            hostname: os.hostname(),
            operation: 'blocker',
            acquired_at_utc: new Date().toISOString(),
            target_root: tmp
        }));

        // First async call should fail because the lock is held by us externally
        await assert.rejects(
            () => withLifecycleOperationLockAsync(tmp, 'should-fail', async () => 'nope'),
            /Another lifecycle operation is already running/
        );

        // Remove the blocking lock
        fs.rmSync(lockPath, { recursive: true, force: true });

        // Second async call must succeed — queue must not be poisoned
        const result = await withLifecycleOperationLockAsync(tmp, 'should-succeed', async () => 'ok');
        assert.equal(result, 'ok');
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});


test('withLifecycleOperationLock cleans up lock directory when metadata write fails', () => {
    const tmp = mkTmpDir();
    // Access the real fs module (not the __importStar wrapper) for monkey-patching
    const realFs = require('node:fs');
    const originalWriteFileSync = realFs.writeFileSync;
    let intercepted = false;
    try {
        realFs.writeFileSync = function (...args: any[]) {
            if (!intercepted && typeof args[0] === 'string' && args[0].includes('owner.json')) {
                intercepted = true;
                throw new Error('Simulated metadata write failure');
            }
            return originalWriteFileSync.apply(realFs, args);
        };

        assert.throws(
            () => withLifecycleOperationLock(tmp, 'meta-fail', () => 'unreachable'),
            /Simulated metadata write failure/
        );
        assert.ok(intercepted, 'writeFileSync interception should have fired');
        const lockPath = getLifecycleOperationLockPath(tmp);
        assert.ok(!fs.existsSync(lockPath), 'lock directory should be cleaned up after metadata write failure');
    } finally {
        realFs.writeFileSync = originalWriteFileSync;
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('withLifecycleOperationLock stale recovery does not leave .stale- temp directories', () => {
    const tmp = mkTmpDir();
    try {
        const lockPath = getLifecycleOperationLockPath(tmp);
        const lockParent = path.dirname(lockPath);
        fs.mkdirSync(lockParent, { recursive: true });
        fs.mkdirSync(lockPath);
        // Simulate dead-process lock
        fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
            pid: 999999999,
            hostname: os.hostname(),
            operation: 'dead-test',
            acquired_at_utc: new Date().toISOString(),
            target_root: tmp
        }));

        withLifecycleOperationLock(tmp, 'check-cleanup', () => {
            const entries = fs.readdirSync(lockParent);
            const staleEntries = entries.filter((e: string) => e.includes('.stale-'));
            assert.equal(staleEntries.length, 0, 'no stale temp directories should remain');
        });
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('withLifecycleOperationLock retries transient EBUSY during release and preserves callback result', () => {
    const tmp = mkTmpDir();
    const realFs = require('node:fs');
    const originalRmSync = realFs.rmSync;
    let interceptedRetries = 0;
    try {
        const result = withLifecycleOperationLock(tmp, 'release-retry', () => {
            const lockPath = getLifecycleOperationLockPath(tmp);
            realFs.rmSync = function (...args: unknown[]) {
                const targetPath = typeof args[0] === 'string' ? path.resolve(args[0]) : '';
                if (targetPath.startsWith(path.resolve(`${lockPath}.releasing`)) && interceptedRetries < 2) {
                    interceptedRetries += 1;
                    const error = new Error('EBUSY: simulated transient lifecycle release contention') as NodeJS.ErrnoException;
                    error.code = 'EBUSY';
                    throw error;
                }
                return originalRmSync.apply(realFs, args as [string, fs.RmOptions?]);
            };
            return 'ok';
        });

        assert.equal(result, 'ok');
        assert.equal(interceptedRetries, 2, 'lifecycle release should retry transient contention');
        assert.ok(!fs.existsSync(getLifecycleOperationLockPath(tmp)), 'lock should be released after retry recovery');
    } finally {
        realFs.rmSync = originalRmSync;
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('withLifecycleOperationLock retries transient EPERM while claiming release ownership', () => {
    const tmp = mkTmpDir();
    const realFs = require('node:fs');
    const originalRenameSync = realFs.renameSync;
    let interceptedRetries = 0;
    try {
        const result = withLifecycleOperationLock(tmp, 'release-claim-retry', () => {
            const lockPath = getLifecycleOperationLockPath(tmp);
            realFs.renameSync = function (...args: unknown[]) {
                const fromPath = typeof args[0] === 'string' ? path.resolve(args[0]) : '';
                const toPath = typeof args[1] === 'string' ? path.resolve(args[1]) : '';
                if (fromPath === path.resolve(lockPath)
                    && toPath.startsWith(path.resolve(`${lockPath}.releasing`))
                    && interceptedRetries < 2) {
                    interceptedRetries += 1;
                    const error = new Error('EPERM: simulated transient lifecycle release claim contention') as NodeJS.ErrnoException;
                    error.code = 'EPERM';
                    throw error;
                }
                return originalRenameSync.apply(realFs, args as [fs.PathLike, fs.PathLike]);
            };
            return 'ok';
        });

        assert.equal(result, 'ok');
        assert.equal(interceptedRetries, 2, 'lifecycle release claim should retry transient rename contention');
        assert.ok(!fs.existsSync(getLifecycleOperationLockPath(tmp)), 'lock should be released after claim retry recovery');
    } finally {
        realFs.renameSync = originalRenameSync;
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('withLifecycleOperationLock does not remove replacement lock when old release loses ownership race', () => {
    const parent = fs.mkdtempSync(path.join(os.homedir(), '.garda-lifecycle-diagnostic-test-'));
    const tmp = path.join(parent, 'project');
    fs.mkdirSync(tmp);
    const realFs = require('node:fs');
    const originalRenameSync = realFs.renameSync;
    const originalStderrWrite = process.stderr.write;
    let interceptedRelease = false;
    let stderrOutput = '';
    const replacement: { path: string; stat?: fs.BigIntStats; bytes?: Buffer } = { path: '' };
    try {
        const lockPath = getLifecycleOperationLockPath(tmp);
        (process.stderr as unknown as { write: (...args: unknown[]) => boolean }).write = function (chunk: unknown): boolean {
            stderrOutput += String(chunk);
            return true;
        };
        assert.throws(() => withLifecycleOperationLock(tmp, 'old-owner', () => {
            realFs.renameSync = function (...args: unknown[]) {
                const fromPath = typeof args[0] === 'string' ? path.resolve(args[0]) : '';
                const toPath = typeof args[1] === 'string' ? path.resolve(args[1]) : '';
                if (!interceptedRelease
                    && fromPath === path.resolve(lockPath)
                    && toPath.startsWith(path.resolve(`${lockPath}.releasing`))) {
                    interceptedRelease = true;
                    const stalePath = `${lockPath}.stale-test`;
                    originalRenameSync.call(realFs, lockPath, stalePath);
                    fs.mkdirSync(lockPath);
                    fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
                        lock_id: 'replacement-lock-id',
                        pid: process.pid,
                        hostname: os.hostname(),
                        operation: 'replacement-owner',
                        acquired_at_utc: new Date().toISOString(),
                        heartbeat_at_utc: new Date().toISOString(),
                        command: 'replacement-owner',
                        target_root: path.resolve(tmp)
                    }, null, 2) + '\n', 'utf8');
                    replacement.path = toPath;
                    replacement.stat = fs.statSync(lockPath, { bigint: true });
                    replacement.bytes = fs.readFileSync(path.join(lockPath, 'owner.json'));
                }
                return originalRenameSync.apply(realFs, args as [fs.PathLike, fs.PathLike]);
            };
            return 'ok';
        }), (error: unknown) => {
            assert.ok(error instanceof Error);
            assert.match(error.message, /Disputed lifecycle lock ownership conflict; canonical publication refused/);
            if (process.platform !== 'win32') {
                assert.match(error.message, /Verified disputed copy retained at/);
                assert.ok(!error.message.replace(/\\/g, '/').includes(os.homedir().replace(/\\/g, '/')));
            }
            return true;
        });

        assert.equal(interceptedRelease, true);
        assert.equal(fs.existsSync(lockPath), false, 'a pre-claim replacement remains in the disputed claim');
        assert.ok(replacement.stat);
        const retained = fs.statSync(replacement.path, { bigint: true });
        assert.deepEqual([retained.dev, retained.ino, retained.mode, retained.birthtimeNs, retained.uid, retained.gid],
            [replacement.stat.dev, replacement.stat.ino, replacement.stat.mode, replacement.stat.birthtimeNs, replacement.stat.uid, replacement.stat.gid]);
        const retainedBytes = fs.readFileSync(path.join(replacement.path, 'owner.json'));
        assert.deepEqual(retainedBytes, replacement.bytes);
        const owner = JSON.parse(retainedBytes.toString('utf8'));
        assert.equal(owner.lock_id, 'replacement-lock-id');
        assert.equal(owner.operation, 'replacement-owner');
        if (process.platform !== 'win32') {
            assert.ok(!stderrOutput.replace(/\\/g, '/').includes(os.homedir().replace(/\\/g, '/')));
            assert.equal(fs.readdirSync(path.join(parent, 'garda-recovery-preserved', 'lock-claims')).length, 1);
        }
    } finally {
        realFs.renameSync = originalRenameSync;
        (process.stderr as unknown as { write: typeof process.stderr.write }).write = originalStderrWrite;
        fs.rmSync(parent, { recursive: true, force: true });
    }
    assert.equal(fs.existsSync(parent), false, 'fixture-owned capture and project are both cleaned');
});


test('withLifecycleOperationLockAsync advances queue after release conflict', async () => {
    const tmp = mkTmpDir();
    const realFs = require('node:fs');
    const originalRenameSync = realFs.renameSync;
    const lockPath = getLifecycleOperationLockPath(tmp);
    let claimedPath = '';
    try {
        await assert.rejects(withLifecycleOperationLockAsync(tmp, 'old-async-owner', async () => {
            realFs.renameSync = function (...args: unknown[]) {
                const from = typeof args[0] === 'string' ? path.resolve(args[0]) : '';
                const to = typeof args[1] === 'string' ? path.resolve(args[1]) : '';
                if (!claimedPath && from === path.resolve(lockPath)
                    && to.startsWith(path.resolve(`${lockPath}.releasing`))) {
                    const ownerPath = path.join(lockPath, 'owner.json');
                    const owner = JSON.parse(fs.readFileSync(ownerPath, 'utf8'));
                    fs.writeFileSync(ownerPath, JSON.stringify({ ...owner, lock_id: 'replacement-async-owner' }));
                    claimedPath = to;
                }
                return originalRenameSync.apply(realFs, args as [fs.PathLike, fs.PathLike]);
            };
        }), /Disputed lifecycle lock ownership conflict; canonical publication refused/);
        realFs.renameSync = originalRenameSync;
        assert.ok(claimedPath && fs.existsSync(claimedPath));
        assert.equal(JSON.parse(fs.readFileSync(path.join(claimedPath, 'owner.json'), 'utf8')).lock_id,
            'replacement-async-owner');
        assert.equal(await withLifecycleOperationLockAsync(tmp, 'after-conflict', async () => 'next',
            { queueTimeoutMs: 1000 }), 'next');
        assert.ok(fs.existsSync(claimedPath), 'later queue progress must retain the disputed owner');
    } finally {
        realFs.renameSync = originalRenameSync;
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('getLastLifecycleLockTelemetry returns telemetry after sync lock', () => {
    const tmp = mkTmpDir();
    try {
        withLifecycleOperationLock(tmp, 'tel-test', () => 'done');
        const tel = getLastLifecycleLockTelemetry();
        assert.ok(tel != null, 'telemetry should be available');
        assert.ok(typeof tel!.elapsedMs === 'number');
        assert.equal(tel!.staleLockRecovered, false);
        assert.equal(tel!.queueWaitMs, 0);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('getLastLifecycleLockTelemetry reports stale recovery after dead lock reclaim', () => {
    const tmp = mkTmpDir();
    try {
        const lockPath = getLifecycleOperationLockPath(tmp);
        fs.mkdirSync(path.dirname(lockPath), { recursive: true });
        fs.mkdirSync(lockPath);
        fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
            pid: 999999999,
            hostname: os.hostname(),
            operation: 'dead',
            acquired_at_utc: new Date().toISOString(),
            target_root: tmp
        }));

        withLifecycleOperationLock(tmp, 'reclaim-tel', () => 'done');
        const tel = getLastLifecycleLockTelemetry();
        assert.ok(tel != null, 'telemetry should be available');
        assert.equal(tel!.staleLockRecovered, true);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('getLastLifecycleLockTelemetry returns telemetry after async lock', async () => {
    const tmp = mkTmpDir();
    try {
        await withLifecycleOperationLockAsync(tmp, 'async-tel-test', async () => 'done');
        const tel = getLastLifecycleLockTelemetry();
        assert.ok(tel != null, 'telemetry should be available');
        assert.ok(typeof tel!.elapsedMs === 'number');
        assert.ok(typeof tel!.queueWaitMs === 'number');
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});
