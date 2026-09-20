import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { redactHostname } from '../../../src/core/redaction';
import {
    appendTaskEvent,
    appendTaskEventAsync,
    appendMandatoryTaskEvent,
    scanTaskEventLocks,
    cleanupStaleTaskEventLocks
} from '../../../src/gate-runtime/timeline/task-events';
import {
    holdTaskEventLockInChildProcess,
    type TaskEventLockHolder
} from './task-events-test-helpers';
import type {
    AcquireLockTelemetry,
    LockOptions
} from '../../../src/gate-runtime/timeline/task-events-locking-types';


test('appendTaskEvent removes orphaned task lock when owner pid is no longer alive', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-append-orphan-lock-'));
    try {
        const eventsRoot = path.join(tempDir, 'runtime', 'task-events');
        const lockPath = path.join(eventsRoot, '.T-TEST.lock');
        fs.mkdirSync(lockPath, { recursive: true });
        fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
            pid: 999999,
            hostname: os.hostname(),
            created_at_utc: '2026-03-30T10:00:00.000Z'
        }, null, 2) + '\n', 'utf8');

        const result = appendTaskEvent(
            tempDir,
            'T-TEST',
            'test',
            'PASS',
            'Recovered from orphaned lock',
            { recovered: true },
            {
                passThru: true,
                lockTimeoutMs: 250,
                lockRetryMs: 5,
                lockStaleMs: 60000
            }
        );

        assert.ok(result !== null);
        assert.equal(result!.warnings.length, 0);
        assert.ok(fs.existsSync(path.join(eventsRoot, 'T-TEST.jsonl')));
        assert.ok(!fs.existsSync(lockPath), 'orphaned lock should be removed and released');
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});


test('appendTaskEvent does not reclaim aged foreign-host lock without explicit override', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-append-foreign-lock-'));
    const previousEnv = process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS;
    delete process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS;
    try {
        const eventsRoot = path.join(tempDir, 'runtime', 'task-events');
        const lockPath = path.join(eventsRoot, '.T-TEST.lock');
        fs.mkdirSync(lockPath, { recursive: true });
        const ownerPath = path.join(lockPath, 'owner.json');
        fs.writeFileSync(ownerPath, JSON.stringify({
            pid: 999999,
            hostname: 'remote-build-host',
            created_at_utc: '2026-03-30T10:00:00.000Z'
        }, null, 2) + '\n', 'utf8');
        const oldTime = new Date(Date.now() - (31 * 60 * 1000));
        fs.utimesSync(ownerPath, oldTime, oldTime);
        fs.utimesSync(lockPath, oldTime, oldTime);

        const result = appendTaskEvent(
            tempDir,
            'T-TEST',
            'test',
            'PASS',
            'Should not reclaim foreign-host lock by default',
            null,
            {
                passThru: true,
                lockTimeoutMs: 75,
                lockRetryMs: 5
            }
        );

        assert.ok(result !== null);
        assert.equal(result!.warnings.length, 1);
        assert.match(result!.warnings[0], /GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS=1/);
        assert.ok(result!.warnings[0].includes(`owner_hostname=${redactHostname('remote-build-host')}`));
        assert.doesNotMatch(result!.warnings[0], /remote-build-host/);
        assert.ok(!fs.existsSync(path.join(eventsRoot, 'T-TEST.jsonl')), 'blocked write must not append any task-event file');
        assert.ok(fs.existsSync(lockPath), 'aged foreign-host lock should remain without explicit override');
    } finally {
        if (previousEnv === undefined) {
            delete process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS;
        } else {
            process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS = previousEnv;
        }
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('appendTaskEvent reclaims aged foreign-host lock when explicit override is enabled', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-append-foreign-lock-'));
    const previousEnv = process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS;
    process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS = '1';
    try {
        const eventsRoot = path.join(tempDir, 'runtime', 'task-events');
        const lockPath = path.join(eventsRoot, '.T-TEST.lock');
        fs.mkdirSync(lockPath, { recursive: true });
        const ownerPath = path.join(lockPath, 'owner.json');
        fs.writeFileSync(ownerPath, JSON.stringify({
            pid: 999999,
            hostname: 'remote-build-host',
            created_at_utc: '2026-03-30T10:00:00.000Z'
        }, null, 2) + '\n', 'utf8');
        const oldTime = new Date(Date.now() - (31 * 60 * 1000));
        fs.utimesSync(ownerPath, oldTime, oldTime);
        fs.utimesSync(lockPath, oldTime, oldTime);

        const result = appendTaskEvent(
            tempDir,
            'T-TEST',
            'test',
            'PASS',
            'Recovered aged foreign-host lock',
            { recovered: true },
            {
                passThru: true,
                lockTimeoutMs: 250,
                lockRetryMs: 5
            }
        );

        assert.ok(result !== null);
        assert.equal(result!.warnings.length, 0);
        assert.ok(fs.existsSync(path.join(eventsRoot, 'T-TEST.jsonl')));
        assert.ok(!fs.existsSync(lockPath), 'aged foreign-host lock should be reclaimed and released');
    } finally {
        if (previousEnv === undefined) {
            delete process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS;
        } else {
            process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS = previousEnv;
        }
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});


test('appendTaskEvent timeout warning includes lock owner diagnostics', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-append-live-lock-'));
    try {
        const eventsRoot = path.join(tempDir, 'runtime', 'task-events');
        const lockPath = path.join(eventsRoot, '.T-TEST.lock');
        fs.mkdirSync(lockPath, { recursive: true });
        fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
            pid: process.pid,
            hostname: os.hostname(),
            created_at_utc: '2026-03-30T10:00:00.000Z'
        }, null, 2) + '\n', 'utf8');

        const result = appendTaskEvent(
            tempDir,
            'T-TEST',
            'test',
            'PASS',
            'Should time out on active lock',
            null,
            {
                passThru: true,
                lockTimeoutMs: 50,
                lockRetryMs: 5,
                lockStaleMs: 60000
            }
        );

        assert.ok(result !== null);
        assert.equal(result!.warnings.length, 1);
        assert.match(result!.warnings[0], /Timed out acquiring file lock/);
        assert.match(result!.warnings[0], /owner_pid=/);
        assert.match(result!.warnings[0], /owner_alive=yes/);
        assert.match(result!.warnings[0], /owner_metadata_status=ok/);
        assert.ok(result!.warnings[0].includes('runtime/task-events/.T-TEST.lock'));
        assert.ok(!result!.warnings[0].includes(lockPath.replace(/\\/g, '/')));
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('appendTaskEvent tolerates missing lock owner metadata', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-append-owner-race-'));

    try {
        const eventsRoot = path.join(tempDir, 'runtime', 'task-events');
        const lockPath = path.join(eventsRoot, '.T-TEST.lock');
        fs.mkdirSync(lockPath, { recursive: true });

        const result = appendTaskEvent(
            tempDir,
            'T-TEST',
            'test',
            'PASS',
            'Should time out on active lock with missing owner metadata',
            null,
            {
                passThru: true,
                lockTimeoutMs: 50,
                lockRetryMs: 5,
                lockStaleMs: 60000
            }
        );

        assert.ok(result !== null);
        assert.equal(result!.warnings.length, 1);
        assert.match(result!.warnings[0], /Timed out acquiring file lock/);
        assert.match(result!.warnings[0], /owner_metadata_status=missing/);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('appendMandatoryTaskEvent throws with detailed error when lock acquisition times out', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-append-mandatory-lock-'));
    try {
        const eventsRoot = path.join(tempDir, 'runtime', 'task-events');
        const lockPath = path.join(eventsRoot, '.T-TEST.lock');
        fs.mkdirSync(lockPath, { recursive: true });
        fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
            pid: process.pid,
            hostname: os.hostname(),
            created_at_utc: '2026-03-30T10:00:00.000Z'
        }, null, 2) + '\n', 'utf8');

        assert.throws(
            () => appendMandatoryTaskEvent(
                tempDir,
                'T-TEST',
                'TASK_MODE_ENTERED',
                'PASS',
                'Should fail on active lock',
                null,
                {
                    lockTimeoutMs: 50,
                    lockRetryMs: 5,
                    lockStaleMs: 60000
                }
            ),
            /Mandatory lifecycle event 'TASK_MODE_ENTERED' append failed:.*owner_pid=.*owner_alive=yes/
        );
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});


test('scanTaskEventLocks reports active and stale task-event locks only', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-scan-locks-'));
    try {
        const eventsRoot = path.join(tempDir, 'runtime', 'task-events');
        const staleLockPath = path.join(eventsRoot, '.T-005.lock');
        const activeLockPath = path.join(eventsRoot, '.all-tasks.lock');
        const reviewsLockPath = path.join(tempDir, 'runtime', 'reviews', '.ignored.lock');
        fs.mkdirSync(staleLockPath, { recursive: true });
        fs.mkdirSync(activeLockPath, { recursive: true });
        fs.mkdirSync(reviewsLockPath, { recursive: true });
        fs.writeFileSync(path.join(staleLockPath, 'owner.json'), JSON.stringify({
            pid: 999999,
            hostname: os.hostname(),
            created_at_utc: '2026-03-30T10:00:00.000Z'
        }, null, 2) + '\n', 'utf8');
        fs.writeFileSync(path.join(activeLockPath, 'owner.json'), JSON.stringify({
            pid: process.pid,
            hostname: os.hostname(),
            created_at_utc: '2026-03-30T10:00:00.000Z'
        }, null, 2) + '\n', 'utf8');

        const result = scanTaskEventLocks(tempDir, { staleMs: 60000 });
        assert.equal(result.locks.length, 2);
        assert.equal(result.stale_count, 1);
        assert.equal(result.active_count, 1);
        assert.ok(result.subsystem_scope_note.includes('runtime/task-events/*.lock'));
        assert.ok(result.locks.some((lock) => lock.lock_name === '.T-005.lock' && lock.status === 'STALE'));
        assert.ok(result.locks.some((lock) => lock.lock_name === '.all-tasks.lock' && lock.status === 'ACTIVE'));
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});


test('cleanupStaleTaskEventLocks removes only stale locks and supports dry-run', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-cleanup-locks-'));
    try {
        const eventsRoot = path.join(tempDir, 'runtime', 'task-events');
        const staleLockPath = path.join(eventsRoot, '.T-005.lock');
        const activeLockPath = path.join(eventsRoot, '.all-tasks.lock');
        fs.mkdirSync(staleLockPath, { recursive: true });
        fs.mkdirSync(activeLockPath, { recursive: true });
        fs.writeFileSync(path.join(staleLockPath, 'owner.json'), JSON.stringify({
            pid: 999999,
            hostname: os.hostname(),
            created_at_utc: '2026-03-30T10:00:00.000Z'
        }, null, 2) + '\n', 'utf8');
        fs.writeFileSync(path.join(activeLockPath, 'owner.json'), JSON.stringify({
            pid: process.pid,
            hostname: os.hostname(),
            created_at_utc: '2026-03-30T10:00:00.000Z'
        }, null, 2) + '\n', 'utf8');

        const dryRun = cleanupStaleTaskEventLocks(tempDir, { dryRun: true, staleMs: 60000 });
        assert.deepEqual(dryRun.removable_stale_locks, ['.T-005.lock']);
        assert.deepEqual(dryRun.removed_locks, []);
        assert.ok(fs.existsSync(staleLockPath));

        const applied = cleanupStaleTaskEventLocks(tempDir, { dryRun: false, staleMs: 60000 });
        assert.deepEqual(applied.removed_locks, ['.T-005.lock']);
        assert.deepEqual(applied.retained_live_locks, ['.all-tasks.lock']);
        assert.ok(!fs.existsSync(staleLockPath));
        assert.ok(fs.existsSync(activeLockPath));
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});


test('appendTaskEvent includes lock_telemetry in result', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-lock-telemetry-'));
    try {
        const result = appendTaskEvent(
            tempDir,
            'T-TELEM',
            'test',
            'PASS',
            'Telemetry check',
            null,
            { passThru: true }
        );

        assert.ok(result !== null);
        assert.ok(result!.lock_telemetry != null, 'lock_telemetry must be present');
        assert.equal(typeof result!.lock_telemetry!.task_lock_retries, 'number');
        assert.equal(typeof result!.lock_telemetry!.task_lock_elapsed_ms, 'number');
        assert.equal(typeof result!.lock_telemetry!.aggregate_lock_retries, 'number');
        assert.equal(typeof result!.lock_telemetry!.aggregate_lock_elapsed_ms, 'number');
        assert.equal(result!.lock_telemetry!.task_lock_retries, 0, 'no contention expected');
        assert.equal(result!.lock_telemetry!.aggregate_lock_retries, 0, 'no contention expected');
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('appendTaskEvent timeout includes retry count in diagnostic', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-retry-diagnostic-'));
    try {
        const eventsRoot = path.join(tempDir, 'runtime', 'task-events');
        const lockPath = path.join(eventsRoot, '.T-TEST.lock');
        fs.mkdirSync(lockPath, { recursive: true });
        fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
            pid: process.pid,
            hostname: os.hostname(),
            created_at_utc: new Date().toISOString()
        }, null, 2) + '\n', 'utf8');

        const result = appendTaskEvent(
            tempDir,
            'T-TEST',
            'test',
            'PASS',
            'Should include retry count in timeout',
            null,
            {
                passThru: true,
                lockTimeoutMs: 80,
                lockRetryMs: 5,
                lockStaleMs: 60000
            }
        );

        assert.ok(result !== null);
        assert.equal(result!.warnings.length, 1);
        assert.match(result!.warnings[0], /retries=/);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});


test('task-events module avoids Atomics.wait and uses async timer-based waiting', () => {
    const facadePath = path.resolve(__dirname, '..', '..', '..', '..', 'src', 'gate-runtime', 'timeline', 'task-events.ts');
    const lockingSupportPath = path.resolve(__dirname, '..', '..', '..', '..', 'src', 'gate-runtime', 'timeline', 'task-events-locking-support.ts');
    const strippedFacade = fs.readFileSync(facadePath, 'utf8')
        .replace(/\/\/.*$/gm, '')
        .replace(/\/\*[\s\S]*?\*\//g, '');
    const strippedLockingSupport = fs.readFileSync(lockingSupportPath, 'utf8')
        .replace(/\/\/.*$/gm, '')
        .replace(/\/\*[\s\S]*?\*\//g, '');

    assert.equal(
        /Atomics\.wait\s*\(/.test(strippedFacade),
        false,
        'task-events.ts must not use Atomics.wait on the main thread'
    );
    assert.equal(
        /while\s*\(\s*Date\.now\(\)\s*</.test(strippedFacade),
        false,
        'task-events.ts must not contain a Date.now() busy-wait spin loop'
    );
    assert.equal(
        /setTimeout\s*\(/.test(strippedLockingSupport),
        true,
        'task-events-locking-support.ts should use setTimeout-backed async waiting for lock retries'
    );
});


test('appendTaskEvent sync path fails fast on self-owned active lock without waiting', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-retry-cap-'));
    try {
        const eventsRoot = path.join(tempDir, 'runtime', 'task-events');
        const lockPath = path.join(eventsRoot, '.T-TEST.lock');
        fs.mkdirSync(lockPath, { recursive: true });
        fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
            pid: process.pid,
            hostname: os.hostname(),
            created_at_utc: new Date().toISOString()
        }, null, 2) + '\n', 'utf8');

        const startedAt = Date.now();
        const result = appendTaskEvent(
            tempDir,
            'T-TEST',
            'test',
            'PASS',
            'Should fail fast on live lock',
            null,
            {
                passThru: true,
                lockTimeoutMs: 600000,
                lockRetryMs: 1,
                lockStaleMs: 60000
            }
        );
        const elapsedMs = Date.now() - startedAt;

        assert.ok(result !== null);
        assert.equal(result!.warnings.length, 1);
        assert.match(result!.warnings[0], /wait_strategy=immediate_fail/);
        assert.match(result!.warnings[0], /retries=0/);
        assert.ok(elapsedMs < 2000, `sync append should fail fast, got ${elapsedMs} ms`);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('appendTaskEvent sync path waits through short-lived external contention', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-sync-contention-'));
    const lockPath = path.join(tempDir, 'runtime', 'task-events', '.T-SYNC-WAIT.lock');
    let lockHolder: TaskEventLockHolder | null = null;
    try {
        lockHolder = await holdTaskEventLockInChildProcess(lockPath, 1000);
        lockHolder.beginReleaseCountdown();
        const startedAt = Date.now();
        const result = appendTaskEvent(
            tempDir,
            'T-SYNC-WAIT',
            'test',
            'PASS',
            'Should wait for short-lived external lock',
            null,
            {
                passThru: true,
                lockTimeoutMs: 5000,
                lockRetryMs: 20,
                lockStaleMs: 60000
            }
        );
        const elapsedMs = Date.now() - startedAt;

        assert.ok(result !== null);
        assert.equal(result!.warnings.length, 0, 'sync append should succeed after bounded wait');
        assert.ok(elapsedMs >= 80, `sync append should wait for external owner, got ${elapsedMs} ms`);
        assert.ok((result!.lock_telemetry?.task_lock_retries || 0) > 0, 'telemetry should record sync retries');
        assert.notEqual(result!.lock_telemetry?.task_lock_contention_level, 'none');
    } finally {
        if (lockHolder) {
            await lockHolder.cleanup();
        }
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});


test('appendTaskEventAsync reports non-zero telemetry after contended lock acquisition', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-contention-telemetry-'));
    let lockHolder: TaskEventLockHolder | null = null;
    try {
        const eventsRoot = path.join(tempDir, 'runtime', 'task-events');
        const lockPath = path.join(eventsRoot, '.T-TELEM.lock');
        lockHolder = await holdTaskEventLockInChildProcess(lockPath, 1000);
        lockHolder.beginReleaseCountdown();

        const result = await appendTaskEventAsync(
            tempDir,
            'T-TELEM',
            'test',
            'PASS',
            'Should succeed after contention',
            null,
            {
                passThru: true,
                lockTimeoutMs: 5000,
                lockRetryMs: 5,
                lockStaleMs: 60000
            }
        );

        assert.ok(result !== null);
        assert.equal(result!.warnings.length, 0, 'Should succeed without warnings');
        assert.ok(result!.lock_telemetry != null, 'lock_telemetry must be present');
        assert.ok(result!.lock_telemetry!.task_lock_retries > 0, 'Should have non-zero retries after contention');
        assert.ok(result!.lock_telemetry!.task_lock_elapsed_ms > 0, 'Should have non-zero elapsed time after contention');
    } finally {
        if (lockHolder) {
            await lockHolder.cleanup();
        }
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});


test('appendTaskEventAsync does not reclaim aged foreign-host lock without explicit override', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-append-async-foreign-lock-'));
    const previousEnv = process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS;
    delete process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS;
    try {
        const eventsRoot = path.join(tempDir, 'runtime', 'task-events');
        const lockPath = path.join(eventsRoot, '.T-ASYNC.lock');
        fs.mkdirSync(lockPath, { recursive: true });
        const ownerPath = path.join(lockPath, 'owner.json');
        fs.writeFileSync(ownerPath, JSON.stringify({
            pid: 999999,
            hostname: 'remote-build-host',
            created_at_utc: '2026-03-30T10:00:00.000Z'
        }, null, 2) + '\n', 'utf8');
        const oldTime = new Date(Date.now() - (31 * 60 * 1000));
        fs.utimesSync(ownerPath, oldTime, oldTime);
        fs.utimesSync(lockPath, oldTime, oldTime);

        const result = await appendTaskEventAsync(
            tempDir,
            'T-ASYNC',
            'test',
            'PASS',
            'Should not reclaim foreign-host lock by default',
            null,
            {
                passThru: true,
                lockTimeoutMs: 75,
                lockRetryMs: 5
            }
        );

        assert.ok(result !== null);
        assert.equal(result!.warnings.length, 1);
        assert.match(result!.warnings[0], /GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS=1/);
        assert.ok(result!.warnings[0].includes(`owner_hostname=${redactHostname('remote-build-host')}`));
        assert.doesNotMatch(result!.warnings[0], /remote-build-host/);
        assert.ok(!fs.existsSync(path.join(eventsRoot, 'T-ASYNC.jsonl')), 'blocked async write must not append any task-event file');
        assert.ok(fs.existsSync(lockPath), 'aged foreign-host lock should remain without explicit override');
    } finally {
        if (previousEnv === undefined) {
            delete process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS;
        } else {
            process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS = previousEnv;
        }
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('appendTaskEventAsync reclaims aged foreign-host lock when explicit override is enabled', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-append-async-foreign-lock-'));
    const previousEnv = process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS;
    process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS = '1';
    try {
        const eventsRoot = path.join(tempDir, 'runtime', 'task-events');
        const lockPath = path.join(eventsRoot, '.T-ASYNC.lock');
        fs.mkdirSync(lockPath, { recursive: true });
        const ownerPath = path.join(lockPath, 'owner.json');
        fs.writeFileSync(ownerPath, JSON.stringify({
            pid: 999999,
            hostname: 'remote-build-host',
            created_at_utc: '2026-03-30T10:00:00.000Z'
        }, null, 2) + '\n', 'utf8');
        const oldTime = new Date(Date.now() - (31 * 60 * 1000));
        fs.utimesSync(ownerPath, oldTime, oldTime);
        fs.utimesSync(lockPath, oldTime, oldTime);

        const result = await appendTaskEventAsync(
            tempDir,
            'T-ASYNC',
            'test',
            'PASS',
            'Recovered aged foreign-host lock',
            { recovered: true },
            {
                passThru: true,
                lockTimeoutMs: 250,
                lockRetryMs: 5
            }
        );

        assert.ok(result !== null);
        assert.equal(result!.warnings.length, 0);
        assert.ok(fs.existsSync(path.join(eventsRoot, 'T-ASYNC.jsonl')));
        assert.ok(!fs.existsSync(lockPath), 'aged foreign-host lock should be reclaimed and released');
    } finally {
        if (previousEnv === undefined) {
            delete process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS;
        } else {
            process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS = previousEnv;
        }
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});


test('appendTaskEventAsync waits for aggregate lock and records contention telemetry when .all-tasks.lock is held', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-aggregate-contention-'));
    let lockHolder: TaskEventLockHolder | null = null;
    try {
        const eventsRoot = path.join(tempDir, 'runtime', 'task-events');
        const aggregateLockPath = path.join(eventsRoot, '.all-tasks.lock');
        lockHolder = await holdTaskEventLockInChildProcess(aggregateLockPath, 1000);
        lockHolder.beginReleaseCountdown();

        const startedAt = Date.now();
        const result = await appendTaskEventAsync(
            tempDir,
            'T-AGG-CONTEND',
            'test',
            'PASS',
            'Aggregate append should wait for the aggregate lock',
            null,
            {
                passThru: true,
                lockTimeoutMs: 5000,
                lockRetryMs: 5,
                lockStaleMs: 60000
            }
        );
        const elapsedMs = Date.now() - startedAt;

        assert.ok(result !== null);
        assert.equal(result!.warnings.length, 0, 'aggregate append should wait instead of warning');
        assert.ok(result!.lock_telemetry != null, 'lock_telemetry must be present');
        assert.equal(result!.lock_telemetry!.task_lock_retries, 0, 'task lock should acquire on first attempt');
        assert.equal(
            result!.lock_telemetry!.aggregate_append_mode, 'locked',
            'aggregate append mode should record serialized append'
        );
        assert.ok(result!.lock_telemetry!.aggregate_lock_retries > 0, 'aggregate lock should show contention');
        assert.ok(
            result!.lock_telemetry!.aggregate_lock_elapsed_ms >= 100 || elapsedMs >= 100,
            `aggregate append should wait for held lock (telemetry=${result!.lock_telemetry!.aggregate_lock_elapsed_ms}, elapsed=${elapsedMs})`
        );

        const taskFile = path.join(eventsRoot, 'T-AGG-CONTEND.jsonl');
        const allTasksFile = path.join(eventsRoot, 'all-tasks.jsonl');
        assert.ok(fs.existsSync(taskFile), 'task event file must exist');
        assert.ok(fs.existsSync(allTasksFile), 'all-tasks aggregate file must exist');
        const taskLines = fs.readFileSync(taskFile, 'utf8').split('\n').filter((l) => l.trim());
        const aggLines = fs.readFileSync(allTasksFile, 'utf8').split('\n').filter((l) => l.trim());
        assert.equal(taskLines.length, 1, 'exactly one task event line');
        assert.equal(aggLines.length, 1, 'exactly one aggregate event line');
    } finally {
        if (lockHolder) {
            await lockHolder.cleanup();
        }
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('appendTaskEvent fails if aggregate lock begins while task lock remains active', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-sync-lock-order-'));
    const taskId = 'T-SYNC-LOCK-ORDER';
    const taskLockName = `.${taskId}.lock`;
    const aggregateLockName = '.all-tasks.lock';
    const lockingModule = require('../../../src/gate-runtime/timeline/task-events-locking-acquire') as typeof import('../../../src/gate-runtime/timeline/task-events-locking-acquire');
    const originalWithFilesystemLock = lockingModule.withFilesystemLock;
    const enteredLocks: string[] = [];
    const activeLocks: string[] = [];

    assert.equal(activeLocks.length, 0, 'lock stack must start empty before the instrumented append');

    lockingModule.withFilesystemLock = function instrumentedWithFilesystemLock<T>(
        lockPath: string,
        options: LockOptions,
        callback: () => T
    ): { result: T; telemetry: AcquireLockTelemetry } {
        const lockName = path.basename(lockPath);
        if (lockName !== taskLockName && lockName !== aggregateLockName) {
            return originalWithFilesystemLock(lockPath, options, callback);
        }
        return originalWithFilesystemLock(lockPath, options, () => {
            if (lockName === aggregateLockName) {
                assert.deepEqual(
                    activeLocks,
                    [],
                    'aggregate append must begin only after the task lock callback has completed'
                );
            }
            enteredLocks.push(lockName);
            activeLocks.push(lockName);
            try {
                return callback();
            } finally {
                assert.equal(activeLocks.pop(), lockName);
            }
        });
    };

    let result: ReturnType<typeof appendTaskEvent> = null;
    try {
        result = appendTaskEvent(
            tempDir,
            taskId,
            'test',
            'PASS',
            'Verify synchronous task and aggregate lock ordering',
            null,
            { passThru: true }
        );
    } finally {
        lockingModule.withFilesystemLock = originalWithFilesystemLock;
        fs.rmSync(tempDir, { recursive: true, force: true });
    }

    assert.ok(result !== null);
    assert.deepEqual(enteredLocks, [taskLockName, aggregateLockName]);
    assert.deepEqual(activeLocks, []);
});

test('appendTaskEventAsync fails if aggregate lock begins while task lock remains active', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-lock-order-'));
    const taskId = 'T-LOCK-ORDER';
    const taskLockName = `.${taskId}.lock`;
    const aggregateLockName = '.all-tasks.lock';
    const lockingModule = require('../../../src/gate-runtime/timeline/task-events-locking-acquire') as typeof import('../../../src/gate-runtime/timeline/task-events-locking-acquire');
    const originalWithFilesystemLockAsync = lockingModule.withFilesystemLockAsync;
    const enteredLocks: string[] = [];
    const activeLocks: string[] = [];

    assert.equal(activeLocks.length, 0, 'lock stack must start empty before the instrumented append');

    lockingModule.withFilesystemLockAsync = async function instrumentedWithFilesystemLockAsync<T>(
        lockPath: string,
        options: LockOptions,
        callback: () => Promise<T> | T
    ): Promise<{ result: T; telemetry: AcquireLockTelemetry }> {
        const lockName = path.basename(lockPath);
        if (lockName !== taskLockName && lockName !== aggregateLockName) {
            return originalWithFilesystemLockAsync(lockPath, options, callback);
        }
        return originalWithFilesystemLockAsync(lockPath, options, async () => {
            if (lockName === aggregateLockName) {
                assert.deepEqual(
                    activeLocks,
                    [],
                    'aggregate append must begin only after the task lock callback has completed'
                );
            }
            enteredLocks.push(lockName);
            activeLocks.push(lockName);
            try {
                return await callback();
            } finally {
                assert.equal(activeLocks.pop(), lockName);
            }
        });
    };

    let result: Awaited<ReturnType<typeof appendTaskEventAsync>> = null;
    try {
        result = await appendTaskEventAsync(
            tempDir,
            taskId,
            'test',
            'PASS',
            'Verify task and aggregate lock ordering',
            null,
            { passThru: true }
        );
    } finally {
        lockingModule.withFilesystemLockAsync = originalWithFilesystemLockAsync;
        fs.rmSync(tempDir, { recursive: true, force: true });
    }

    assert.ok(result !== null);
    assert.deepEqual(enteredLocks, [taskLockName, aggregateLockName]);
    assert.deepEqual(activeLocks, []);
});

test('appendTaskEventAsync warns instead of bypassing held aggregate lock when timeout expires', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-agg-timeout-'));
    let lockHolder: TaskEventLockHolder | null = null;
    try {
        const eventsRoot = path.join(tempDir, 'runtime', 'task-events');
        const aggregateLockPath = path.join(eventsRoot, '.all-tasks.lock');
        lockHolder = await holdTaskEventLockInChildProcess(aggregateLockPath, 1000);
        lockHolder.beginReleaseCountdown();

        const result = await appendTaskEventAsync(
            tempDir,
            'T-AGG-TIMEOUT',
            'test',
            'PASS',
            'Aggregate append should not bypass a timed-out lock',
            null,
            {
                passThru: true,
                lockTimeoutMs: 40,
                lockRetryMs: 5,
                lockStaleMs: 60000
            }
        );

        assert.ok(result !== null);
        assert.equal(result!.warnings.length, 1, 'aggregate timeout should surface as a warning');
        assert.match(result!.warnings[0], /aggregate append\/prune failed/i);
        assert.match(result!.warnings[0], /\.all-tasks\.lock/i);
        assert.match(result!.warnings[0], /timeout_ms=/i);
        assert.ok(result!.integrity !== null, 'task integrity should still be set');

        const taskFile = path.join(eventsRoot, 'T-AGG-TIMEOUT.jsonl');
        assert.ok(fs.existsSync(taskFile), 'task event file must exist');
        const allTasksFile = path.join(eventsRoot, 'all-tasks.jsonl');
        assert.ok(!fs.existsSync(allTasksFile), 'aggregate file must not be written through a bypass path');
    } finally {
        if (lockHolder) {
            await lockHolder.cleanup();
        }
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('appendTaskEvent reports aggregate_append_mode=locked in lock_telemetry', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-agg-mode-'));
    try {
        const result = appendTaskEvent(
            tempDir,
            'T-AGG-MODE',
            'test',
            'PASS',
            'Check aggregate append mode telemetry',
            null,
            { passThru: true }
        );

        assert.ok(result !== null);
        assert.ok(result!.lock_telemetry != null, 'lock_telemetry must be present');
        assert.equal(
            result!.lock_telemetry!.aggregate_append_mode, 'locked',
            'default append mode should be locked'
        );
        assert.equal(
            result!.lock_telemetry!.aggregate_lock_retries, 0,
            'aggregate lock retries should be 0 without contention'
        );
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('appendTaskEvent sync aggregate append warns instead of bypassing held .all-tasks.lock', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-sync-lockfree-'));
    let lockHolder: TaskEventLockHolder | null = null;
    try {
        const eventsRoot = path.join(tempDir, 'runtime', 'task-events');
        const aggregateLockPath = path.join(eventsRoot, '.all-tasks.lock');
        lockHolder = await holdTaskEventLockInChildProcess(aggregateLockPath, 1000);
        lockHolder.beginReleaseCountdown();

        const result = appendTaskEvent(
            tempDir,
            'T-SYNC-LOCKFREE',
            'test',
            'PASS',
            'Sync aggregate append should not bypass a held lock',
            null,
            {
                passThru: true,
                lockTimeoutMs: 50,
                lockRetryMs: 5,
                lockStaleMs: 60000
            }
        );

        assert.ok(result !== null);
        assert.equal(result!.warnings.length, 1, 'timed-out sync aggregate append should warn');
        assert.match(result!.warnings[0], /aggregate append\/prune failed/i);
        assert.match(result!.warnings[0], /\.all-tasks\.lock/i);
        assert.match(result!.warnings[0], /timeout_ms=/i);
        assert.ok(result!.integrity !== null, 'task integrity should be set');

        const allTasksFile = path.join(eventsRoot, 'all-tasks.jsonl');
        assert.ok(!fs.existsSync(allTasksFile), 'all-tasks aggregate file must not be written through a bypass path');
    } finally {
        if (lockHolder) {
            await lockHolder.cleanup();
        }
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});
