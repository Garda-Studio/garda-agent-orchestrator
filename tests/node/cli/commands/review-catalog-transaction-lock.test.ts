import { afterEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
    issueReviewCatalogConfirmationReceipt,
    type ReviewCatalogManagementPlan
} from '../../../../src/cli/commands/review-catalog/review-catalog-transaction';

const roots: string[] = [];
const REJECTED = /concurrent mutation rejected|not safely verifiable|lock changed/iu;
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function fixture() {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-catalog-lock-'));
    roots.push(repoRoot);
    const bundleRoot = path.join(repoRoot, 'garda-agent-orchestrator');
    fs.mkdirSync(path.join(bundleRoot, 'runtime'), { recursive: true });
    const statePath = path.join(bundleRoot, 'fixture-state.json');
    const state = '{"fixture":"original"}\n';
    fs.writeFileSync(statePath, state);
    const digest = (text: string) => createHash('sha256').update(text).digest('hex');
    const plan = {
        action: 'fixture-lock-admission', operation: 'fixture-lock-admission', changed: true,
        before_state_sha256: digest(state), after_state_sha256: digest('fixture after'),
        plan_sha256: digest('isolated fixture plan'), changes: [], diff: [], explanation: []
    } as unknown as ReviewCatalogManagementPlan;
    const lockPath = path.join(bundleRoot, 'runtime', 'review-catalog-management.lock');
    const confirm = (readState = () => digest(fs.readFileSync(statePath, 'utf8'))) =>
        issueReviewCatalogConfirmationReceipt({
            repoRoot, bundleRoot, plan, expectedStateSha256: plan.before_state_sha256,
            expectedPlanSha256: plan.plan_sha256, operatorConfirmedAtUtc: new Date().toISOString(),
            readCurrentStateSha256: readState
        });
    return { lockPath, statePath, state, confirm, stateSha256: plan.before_state_sha256 };
}

function ownerRecord(overrides: Record<string, unknown> = {}) {
    return JSON.stringify({ schema_version: 1, pid: process.pid, hostname: os.hostname(),
        lock_id: randomUUID(), timestamp_utc: new Date().toISOString(), ...overrides }) + '\n';
}

function leaveDeadOwner(paths: string[]) {
    const child = spawnSync(process.execPath, ['-e', `
        const fs = require('node:fs'), os = require('node:os'), crypto = require('node:crypto');
        for (const file of JSON.parse(process.argv[1])) {
            const fd = fs.openSync(file, 'wx', 0o600);
            fs.writeFileSync(fd, JSON.stringify({schema_version:1,pid:process.pid,hostname:os.hostname(),
                lock_id:crypto.randomUUID(),timestamp_utc:new Date().toISOString()})+'\\n');
            fs.fsyncSync(fd); fs.closeSync(fd);
        }
        process.stdout.write(String(process.pid));
    `, JSON.stringify(paths)], { encoding: 'utf8', timeout: 10000 });
    assert.equal(child.status, 0, child.stderr);
    const pid = Number(child.stdout);
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
}

test('known-dead management owner recovers before confirmation without changing configuration', () => {
    const value = fixture();
    leaveDeadOwner([value.lockPath]);
    assert.equal(value.confirm().status, 'CONFIRMED');
    assert.equal(fs.existsSync(value.lockPath), false);
    assert.equal(fs.readFileSync(value.statePath, 'utf8'), value.state);
});

test('known-dead recovery guard recovers without leaving another transaction lock', () => {
    const value = fixture();
    const guard = value.lockPath + '.stale-recovery';
    leaveDeadOwner([value.lockPath, guard]);
    assert.equal(value.confirm().status, 'CONFIRMED');
    assert.equal(fs.existsSync(value.lockPath), false);
    assert.equal(fs.existsSync(guard), false);
    assert.equal(fs.existsSync(guard + '.stale-recovery'), false);
});

for (const drift of ['object', 'content', 'liveness']) {
    test(`guard-time ${drift} drift rejects recovery and preserves ownership`, () => {
        const value = fixture();
        leaveDeadOwner([value.lockPath]);
        const original = fs.readFileSync(value.lockPath, 'utf8'), owner = JSON.parse(original);
        const replacement = drift === 'content' ? ownerRecord({ pid: owner.pid }) : original;
        const nativeFs: typeof fs = require('node:fs'), originalOpen = nativeFs.openSync;
        const originalKill = process.kill;
        let guardAcquired = false, livenessChecks = 0;
        const openMock = mock.method(nativeFs, 'openSync', (...args: unknown[]) => {
            const descriptor = Reflect.apply(originalOpen, nativeFs, args);
            if (String(args[0]) === value.lockPath + '.stale-recovery' && args[1] === 'wx+') {
                guardAcquired = true;
                if (drift === 'object') fs.renameSync(value.lockPath, value.lockPath + '.original');
                if (drift !== 'liveness') fs.writeFileSync(value.lockPath, replacement);
            }
            return descriptor;
        });
        const killMock = mock.method(process, 'kill', (...args: unknown[]) => {
            if (args[0] === owner.pid) livenessChecks += 1;
            if (drift === 'liveness' && guardAcquired && args[0] === owner.pid) return true;
            return Reflect.apply(originalKill, process, args);
        });
        try {
            assert.throws(() => value.confirm(), /owner changed during recovery/u);
        } finally {
            killMock.mock.restore(); openMock.mock.restore();
        }
        assert.equal(guardAcquired, true);
        assert.equal(livenessChecks, drift === 'liveness' ? 2 : 1);
        assert.equal(fs.readFileSync(value.lockPath, 'utf8'), replacement);
        assert.equal(fs.readFileSync(value.statePath, 'utf8'), value.state);
        assert.equal(fs.existsSync(value.lockPath + '.stale-recovery'), false);
    });
}

test('live management owner rejects recovery and preserves configuration', () => {
    const value = fixture(), original = ownerRecord();
    fs.writeFileSync(value.lockPath, original);
    assert.throws(() => value.confirm(), REJECTED);
    assert.equal(fs.readFileSync(value.lockPath, 'utf8'), original);
    assert.equal(fs.readFileSync(value.statePath, 'utf8'), value.state);
});

test('indeterminate management owner rejects recovery and preserves marker', () => {
    const value = fixture();
    for (const original of ['{broken json', '{"pid":42}', ownerRecord({ hostname: 'foreign-fixture-host' })]) {
        fs.writeFileSync(value.lockPath, original);
        assert.throws(() => value.confirm(), REJECTED);
        assert.equal(fs.readFileSync(value.lockPath, 'utf8'), original);
    }
    assert.equal(fs.readFileSync(value.statePath, 'utf8'), value.state);
});

test('indeterminate process liveness rejects recovery and preserves marker', () => {
    const value = fixture(), original = ownerRecord();
    fs.writeFileSync(value.lockPath, original);
    const originalKill = process.kill;
    const killMock = mock.method(process, 'kill', (...args: unknown[]) => {
        if (args[0] === process.pid) throw Object.assign(new Error('Fixture liveness denied'), { code: 'EPERM' });
        return Reflect.apply(originalKill, process, args);
    });
    try {
        assert.throws(() => value.confirm(), REJECTED);
    } finally {
        killMock.mock.restore();
    }
    assert.equal(fs.readFileSync(value.lockPath, 'utf8'), original);
    assert.equal(fs.readFileSync(value.statePath, 'utf8'), value.state);
});

test('bounded recovery rejects a saturated guard chain and preserves records', () => {
    const value = fixture();
    const paths = Array.from({ length: 4 }, (_, index) => value.lockPath + '.stale-recovery'.repeat(index));
    leaveDeadOwner(paths);
    const original = paths.map(file => fs.readFileSync(file, 'utf8'));
    assert.throws(() => value.confirm(), REJECTED);
    assert.deepEqual(paths.map(file => fs.readFileSync(file, 'utf8')), original);
});

test('replaced management lock rejects release and preserves the replacement', () => {
    const value = fixture(), replacement = ownerRecord();
    assert.throws(() => value.confirm(() => {
        fs.renameSync(value.lockPath, value.lockPath + '.original');
        fs.writeFileSync(value.lockPath, replacement);
        return value.stateSha256;
    }), /transaction lock changed before release/iu);
    assert.equal(fs.readFileSync(value.lockPath, 'utf8'), replacement);
    assert.equal(fs.readFileSync(value.statePath, 'utf8'), value.state);
});

test('failed lock publication rejects cleanup of a substituted marker', () => {
    const value = fixture(), replacement = ownerRecord();
    const nativeFs: typeof fs = require('node:fs');
    const originalOpen = nativeFs.openSync, originalWrite = nativeFs.writeFileSync;
    let descriptor: number | undefined;
    const openMock = mock.method(nativeFs, 'openSync', (...args: unknown[]) => {
        const fd = Reflect.apply(originalOpen, nativeFs, args);
        if (String(args[0]) === value.lockPath && typeof args[1] === 'string'
            && args[1].startsWith('wx')) descriptor = fd;
        return fd;
    });
    const writeMock = mock.method(nativeFs, 'writeFileSync', (...args: unknown[]) => {
        if (args[0] === descriptor) {
            fs.renameSync(value.lockPath, value.lockPath + '.original');
            originalWrite(value.lockPath, replacement);
            throw Object.assign(new Error('Injected lock publication failure'), { code: 'EIO' });
        }
        return Reflect.apply(originalWrite, nativeFs, args);
    });
    try {
        assert.throws(() => value.confirm(), /publication|transaction lock changed/iu);
        assert.equal(fs.readFileSync(value.lockPath, 'utf8'), replacement);
    } finally {
        writeMock.mock.restore(); openMock.mock.restore();
    }
});
