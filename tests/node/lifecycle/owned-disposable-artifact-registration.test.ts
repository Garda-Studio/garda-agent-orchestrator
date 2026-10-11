import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import fsNative from 'node:fs';
import * as os from 'node:os';
import osNative from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { appendTaskEvent } from '../../../src/gate-runtime/task-events';
import { buildTaskModeArtifact } from '../../../src/gates/task-mode';
import { OWNED_DISPOSABLE_ARTIFACT_CATEGORIES } from '../../../src/lifecycle/cleanup/owned-disposable-artifact-contracts';
import { inspectOwnedDisposableArtifact, registerOwnedDisposableArtifact, sealOwnedDisposableArtifact }
    from '../../../src/lifecycle/cleanup/owned-disposable-artifact-registration';
import { resolveScratchWriterLocations, withScratchWriterLock } from '../../../src/lifecycle/cleanup/scratch-writer-ownership';
import { isProtectedGenericScratchName, RUNTIME_CLEANUP_OWNERSHIP_ENTRIES }
    from '../../../src/lifecycle/cleanup/runtime-cleanup-ownership';

describe('task/run-owned disposable producer registration', () => {
    let targetRoot: string;
    let bundleRoot: string;
    const taskId = 'T-OWNED-1';
    const deadPid = 2147483647;

    function enterRun(): void {
        const artifact = buildTaskModeArtifact({ taskId, entryMode: 'EXPLICIT_TASK_EXECUTION',
            requestedDepth: 2, effectiveDepth: 2, taskSummary: 'Produce disposable task artifacts',
            provider: 'Codex', canonicalSourceOfTruth: 'Codex', executionProviderSource: 'explicit_provider',
            runtimeIdentityStatus: 'resolved', reviewerSubagentLaunchStatus: 'launchable' });
        const artifactPath = path.join(bundleRoot, 'runtime', 'reviews', `${taskId}-task-mode.json`);
        fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
        fs.writeFileSync(artifactPath, JSON.stringify(artifact));
        const result = appendTaskEvent(bundleRoot, taskId, 'TASK_MODE_ENTERED', 'PASS', 'Native producer fixture entry',
            { artifact_path: artifactPath }, { passThru: true });
        assert.ok(result);
        assert.equal(result.canonical_committed, true);
    }
    const options = () => ({ targetRoot, bundleRoot, taskId });
    const register = () => registerOwnedDisposableArtifact({ ...options(), category: 'raw-stdout' });
    const inspect = (registrationId: string) => inspectOwnedDisposableArtifact({ ...options(), registrationId });
    const seal = (registrationId: string) => sealOwnedDisposableArtifact({ ...options(), registrationId });

    beforeEach(() => {
        targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-disposable-owner-'));
        bundleRoot = path.join(targetRoot, 'garda-agent-orchestrator');
        fs.mkdirSync(bundleRoot);
        enterRun();
    });
    afterEach(() => { mock.restoreAll(); fs.rmSync(targetRoot, { recursive: true, force: true }); });

    it('preserves unverified disposable namespaces during ordinary purge and generic scratch cleanup', () => {
        for (const id of ['owned-disposable-payloads', 'disposable-producer-registrations']) {
            const entry = RUNTIME_CLEANUP_OWNERSHIP_ENTRIES.find(candidate => candidate.id === id);
            assert.ok(entry);
            assert.equal(entry.taskPurgeMode, 'exclude-from-task-purge');
            assert.equal(entry.retentionMode, 'operator-managed');
            assert.equal('collectorKey' in entry, false);
            assert.equal('candidateCategory' in entry, false);
        }
        assert.equal(isProtectedGenericScratchName('owned-disposable'), true);
        assert.equal(isProtectedGenericScratchName('disposable-producers'), true);
    });

    for (const category of OWNED_DISPOSABLE_ARTIFACT_CATEGORIES) {
        it(`creates and seals fresh explicitly owned ${category} payload without removing it`, () => {
            const first = registerOwnedDisposableArtifact({ ...options(), category });
            const second = registerOwnedDisposableArtifact({ ...options(), category });
            assert.notEqual(first.registrationId, second.registrationId);
            assert.notEqual(first.payloadPath, second.payloadPath);
            assert.ok(!first.ownerPath.startsWith(first.payloadPath + path.sep));
            assert.ok(first.payloadPath.startsWith(path.join(bundleRoot, 'runtime', 'owned-disposable', taskId) + path.sep));
            fs.writeFileSync(path.join(first.payloadPath, 'output.bin'), 'retained raw bytes');
            const active = inspect(first.registrationId);
            assert.equal(active.record.category, category);
            assert.equal(active.record.task_id, taskId);
            assert.equal(active.record.pid, process.pid);
            assert.equal(active.record.hostname, os.hostname());
            assert.equal(active.record.sealed_at_utc, null);
            assert.equal(active.producerState, 'live');
            const sealed = seal(first.registrationId);
            assert.ok(sealed.record.sealed_at_utc);
            assert.equal(seal(first.registrationId).record.sealed_at_utc, sealed.record.sealed_at_utc);
            assert.equal(fs.readFileSync(path.join(first.payloadPath, 'output.bin'), 'utf8'), 'retained raw bytes');
        });
    }
    it('rejects caller-selected roots, arbitrary identifiers and categories at the boundary', () => {
        for (const taskId of ['../outside', 't-001', 'T-/outside']) {
            assert.throws(() => registerOwnedDisposableArtifact({ ...options(), taskId, category: 'raw-stdout' }));
        }
        for (const registrationId of ['../outside', 'not-a-registration', 'A'.repeat(36)]) {
            assert.throws(() => inspectOwnedDisposableArtifact({ ...options(), registrationId }), /registration/);
        }
        assert.throws(() => registerOwnedDisposableArtifact({ ...options(), category: 'wip' as never }), /category/);
        assert.throws(() => registerOwnedDisposableArtifact({ ...options(), category: 'raw-stdout', payloadPath: targetRoot } as never), /input|field/);
        assert.throws(() => registerOwnedDisposableArtifact({ ...options(), category: 'raw-stdout', pid: deadPid } as never), /input|field/);
        assert.throws(() => registerOwnedDisposableArtifact({ ...options(), bundleRoot: targetRoot, category: 'raw-stdout' }), /canonical|TargetRoot/);
    });
    it('rejects orphan payload and records rather than adopting existing bytes', () => {
        const first = register();
        fs.unlinkSync(first.ownerPath);
        assert.throws(() => inspect(first.registrationId), /missing|registration/);
        assert.equal(fs.existsSync(first.payloadPath), true);
        const second = register();
        fs.renameSync(second.payloadPath, second.payloadPath + '-saved');
        assert.throws(() => seal(second.registrationId), /missing|payload/);
        assert.equal(fs.existsSync(second.ownerPath), true);
    });
    it('rejects replaced payload roots while preserving both trees and registration', () => {
        const first = register();
        fs.renameSync(first.payloadPath, first.payloadPath + '-saved');
        fs.mkdirSync(first.payloadPath);
        fs.writeFileSync(path.join(first.payloadPath, 'foreign.txt'), 'keep');
        assert.throws(() => inspect(first.registrationId), /identity/);
        assert.throws(() => seal(first.registrationId), /identity/);
        assert.equal(fs.readFileSync(path.join(first.payloadPath, 'foreign.txt'), 'utf8'), 'keep');
        assert.equal(fs.existsSync(first.ownerPath), true);
    });
    it('rejects stale registrations after a later native run or modified entry bytes', () => {
        const first = register();
        enterRun();
        assert.throws(() => inspect(first.registrationId), /run/);
        const second = register();
        const artifactPath = path.join(bundleRoot, 'runtime', 'reviews', `${taskId}-task-mode.json`);
        fs.appendFileSync(artifactPath, '\n');
        assert.throws(() => seal(second.registrationId), /run/);
        assert.equal(fs.existsSync(first.payloadPath), true);
    });
    it('rejects missing native entry and a corrupt task timeline', () => {
        const artifactPath = path.join(bundleRoot, 'runtime', 'reviews', `${taskId}-task-mode.json`);
        fs.unlinkSync(artifactPath);
        assert.throws(register, /missing|native|entry/);
        enterRun();
        const timelinePath = path.join(bundleRoot, 'runtime', 'task-events', `${taskId}.jsonl`);
        fs.appendFileSync(timelinePath, 'invalid event\n');
        assert.throws(register, /timeline|native/);
        assert.equal(fs.existsSync(path.join(bundleRoot, 'runtime', 'owned-disposable')), false);
    });
    it('rejects copied registration from a different workspace even with the copied authority key', () => {
        const first = register();
        const otherRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-disposable-copy-'));
        try {
            const otherBundle = path.join(otherRoot, 'garda-agent-orchestrator');
            fs.cpSync(bundleRoot, otherBundle, { recursive: true });
            assert.throws(() => inspectOwnedDisposableArtifact({ targetRoot: otherRoot, bundleRoot: otherBundle,
                taskId, registrationId: first.registrationId }), /workspace|native|path|run/);
            assert.equal(fs.existsSync(first.payloadPath), true);
        } finally { fs.rmSync(otherRoot, { recursive: true, force: true }); }
    });
    for (const changes of [{ pid: deadPid }, { hostname: 'foreign-host' }, { sealed_at_utc: '2026-01-01T00:00:00.000Z' },
        { category: 'diagnostic-archive' }, { payload_relative_path: '../wip' }, { unexpected: true }]) {
        it(`rejects forged registration fields ${JSON.stringify(changes)}`, () => {
            const first = register();
            const original = JSON.parse(fs.readFileSync(first.ownerPath, 'utf8'));
            fs.writeFileSync(first.ownerPath, JSON.stringify({ ...original, ...changes }));
            assert.throws(() => inspect(first.registrationId), /authentication|schema|registration/);
            assert.throws(() => seal(first.registrationId), /authentication|schema|registration/);
            assert.equal(fs.existsSync(first.payloadPath), true);
        });
    }
    it('preserves untrusted unknown producer state read-only without granting ownership', () => {
        const first = register();
        const before = fs.readFileSync(first.ownerPath);
        mock.method(process, 'kill', () => { throw Object.assign(new Error('unverifiable'), { code: 'EIO' }); });
        assert.equal(inspect(first.registrationId).producerState, 'unknown');
        assert.deepEqual(fs.readFileSync(first.ownerPath), before);
    });
    it('rejects foreign host attempts to seal a producer registration', () => {
        const first = register();
        mock.method(osNative, 'hostname', () => 'foreign-host');
        assert.equal(inspect(first.registrationId).producerState, 'foreign');
        assert.throws(() => seal(first.registrationId), /producer|owner/);
    });
    it('rejects a fresh producer instance with the same PID rather than granting replayed seal authority', () => {
        const first = register();
        const producerModule = require.resolve('../../../src/lifecycle/cleanup/owned-disposable-artifact-registration');
        const originalModule = require.cache[producerModule];
        assert.ok(originalModule);
        delete require.cache[producerModule];
        try {
            const freshProducer = require(producerModule) as typeof import('../../../src/lifecycle/cleanup/owned-disposable-artifact-registration');
            assert.equal(freshProducer.inspectOwnedDisposableArtifact({ ...options(), registrationId: first.registrationId }).producerState, 'unknown');
            assert.throws(() => freshProducer.sealOwnedDisposableArtifact({ ...options(), registrationId: first.registrationId }), /producer/);
            assert.equal(inspect(first.registrationId).record.sealed_at_utc, null);
        } finally { require.cache[producerModule] = originalModule; }
        assert.ok(seal(first.registrationId).record.sealed_at_utc);
    });
    it('rejects forged producer and seal authority in a public record', () => {
        const first = register();
        const original = JSON.parse(fs.readFileSync(first.ownerPath, 'utf8'));
        fs.writeFileSync(first.ownerPath, JSON.stringify({ ...original, pid: deadPid,
            sealed_at_utc: new Date().toISOString() }));
        assert.throws(() => inspect(first.registrationId), /authentication/);
        assert.throws(() => seal(first.registrationId), /authentication/);
        assert.equal(fs.existsSync(first.payloadPath), true);
    });
    it('recognizes a real exited producer and refuses takeover or resealing by this process', () => {
        const producerModule = require.resolve('../../../src/lifecycle/cleanup/owned-disposable-artifact-registration');
        const producer = spawnSync(process.execPath, ['-e',
            'const api = require(process.argv[1]); const options = JSON.parse(process.argv[2]); '
            + 'const registration = api.registerOwnedDisposableArtifact({...options, category: "raw-stderr"}); '
            + 'api.sealOwnedDisposableArtifact({...options, registrationId: registration.registrationId}); '
            + 'process.stdout.write(JSON.stringify(registration));', producerModule, JSON.stringify(options())],
            { encoding: 'utf8', timeout: 15_000, maxBuffer: 64 * 1024 });
        assert.equal(producer.error, undefined);
        assert.equal(producer.status, 0, producer.stderr);
        const registration = JSON.parse(producer.stdout);
        assert.equal(inspect(registration.registrationId).producerState, 'dead');
        assert.ok(inspect(registration.registrationId).record.sealed_at_utc);
        assert.throws(() => seal(registration.registrationId), /producer/);
        assert.equal(fs.existsSync(registration.payloadPath), true);
    });
    it('rejects linked payload, shared registration and an oversized owner before reading bytes', () => {
        const first = register();
        fs.renameSync(first.payloadPath, first.payloadPath + '-saved');
        fs.symlinkSync(first.payloadPath + '-saved', first.payloadPath, process.platform === 'win32' ? 'junction' : 'dir');
        assert.throws(() => inspect(first.registrationId), /symlink|junction/);
        const second = register();
        fs.linkSync(second.ownerPath, second.ownerPath + '-shared');
        assert.throws(() => inspect(second.registrationId), /hard-linked|unshared/);
        const third = register();
        fs.writeFileSync(third.ownerPath, ' '.repeat(16 * 1024 + 1));
        assert.throws(() => inspect(third.registrationId), /bounded/);
    });
    it('fails closed when authority is missing or linked; inspections never recreate it', () => {
        const first = register();
        const keyPath = path.join(bundleRoot, 'runtime', 'disposable-producers', '.authority-key');
        fs.renameSync(keyPath, keyPath + '-saved');
        assert.throws(() => inspect(first.registrationId), /authority/);
        assert.equal(fs.existsSync(keyPath), false);
        fs.symlinkSync(keyPath + '-saved', keyPath);
        assert.throws(() => inspect(first.registrationId), /symlink/);
    });
    it('prevents readable authority bytes by creating private permissions before writing', { skip: process.platform === 'win32' }, () => {
        const keyPath = path.join(bundleRoot, 'runtime', 'disposable-producers', '.authority-key');
        const writeFileSync = fsNative.writeFileSync;
        let checked = false;
        mock.method(fsNative, 'writeFileSync', ((...args: Parameters<typeof fs.writeFileSync>) => {
            if (typeof args[0] === 'number' && fs.existsSync(keyPath)) {
                const opened = fs.fstatSync(args[0]), named = fs.statSync(keyPath);
                if (opened.dev === named.dev && opened.ino === named.ino) {
                    checked = true;
                    assert.equal(opened.mode & 0o777, 0o600);
                    assert.equal(opened.size, 0);
                }
            }
            return writeFileSync(...args);
        }) as typeof fs.writeFileSync);
        const first = register();
        assert.equal(checked, true);
        assert.equal(fs.statSync(keyPath).mode & 0o777, 0o600);
        assert.equal(inspect(first.registrationId).record.sealed_at_utc, null);
    });
    it('accepts omitted Windows pathname device identity using complete descriptor identity', () => {
        const keyPath = path.join(bundleRoot, 'runtime', 'disposable-producers', '.authority-key');
        const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
        const lstatSync = fsNative.lstatSync;
        let omitted = 0;
        mock.method(fsNative, 'lstatSync', ((...args: Parameters<typeof fs.lstatSync>) => {
            const stat = lstatSync(...args);
            if (!stat || String(args[0]) !== keyPath) return stat;
            omitted++;
            return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat,
                { dev: typeof stat.dev === 'bigint' ? 0n : 0 });
        }) as typeof fs.lstatSync);
        Object.defineProperty(process, 'platform', { value: 'win32' });
        try {
            const first = register();
            assert.ok(omitted > 0);
            assert.equal(fs.statSync(keyPath).size, 32);
            assert.equal(inspect(first.registrationId).producerState, 'live');
            assert.ok(seal(first.registrationId).record.sealed_at_utc);
        } finally { Object.defineProperty(process, 'platform', platform); }
    });
    it('rejects a backward seal clock without corrupting the unsealed owner', context => {
        const first = register(), before = fs.readFileSync(first.ownerPath);
        const registeredAt = inspect(first.registrationId).record.registered_at_utc;
        context.mock.timers.enable({ apis: ['Date'], now: Date.parse(registeredAt) - 1000 });
        try {
            assert.throws(() => seal(first.registrationId), /clock precedes registration/);
            assert.deepEqual(fs.readFileSync(first.ownerPath), before);
            assert.equal(inspect(first.registrationId).record.sealed_at_utc, null);
        } finally { context.mock.timers.reset(); }
        assert.ok(seal(first.registrationId).record.sealed_at_utc);
    });
    it('rejects partial private authority after interrupted exclusive creation without replacing it', { skip: process.platform === 'win32' }, () => {
        const keyPath = path.join(bundleRoot, 'runtime', 'disposable-producers', '.authority-key');
        const writeFileSync = fsNative.writeFileSync;
        mock.method(fsNative, 'writeFileSync', ((...args: Parameters<typeof fs.writeFileSync>) => {
            if (typeof args[0] === 'number' && fs.existsSync(keyPath)) {
                const opened = fs.fstatSync(args[0]), named = fs.statSync(keyPath);
                if (opened.dev === named.dev && opened.ino === named.ino) {
                    assert.equal(opened.mode & 0o777, 0o600);
                    throw new Error('Injected interruption before private authority write');
                }
            }
            return writeFileSync(...args);
        }) as typeof fs.writeFileSync);
        assert.throws(register, /interruption/);
        const before = fs.statSync(keyPath);
        assert.equal(before.mode & 0o777, 0o600);
        assert.equal(before.size, 0);
        mock.restoreAll();
        assert.throws(register, /private.*key/);
        assert.equal(fs.statSync(keyPath).ino, before.ino);
        assert.equal(fs.statSync(keyPath).size, 0);
    });
    it('preserves interrupted producer state and rejects lock contention before creating payload', () => {
        const first = register();
        const ownerBytes = fs.readFileSync(first.ownerPath);
        const locations = resolveScratchWriterLocations({ targetRoot, bundleRoot, scratchName: 'disposable-producer-registry' });
        withScratchWriterLock(locations, () => {
            assert.throws(register, /lock|active|owner/);
            assert.throws(() => seal(first.registrationId), /lock|active|owner/);
            assert.equal(inspect(first.registrationId).record.sealed_at_utc, null);
        });
        assert.deepEqual(fs.readFileSync(first.ownerPath), ownerBytes);
    });
    it('rejects tampered owner bytes during bounded descriptor reads', () => {
        const first = register();
        const readSync = fsNative.readSync;
        const ownerIdentity = fs.statSync(first.ownerPath);
        let changed = false;
        mock.method(fsNative, 'readSync', ((...args: Parameters<typeof fs.readSync>) => {
            const result = readSync(...args);
            const descriptorIdentity = fs.fstatSync(args[0]);
            if (!changed && descriptorIdentity.dev === ownerIdentity.dev && descriptorIdentity.ino === ownerIdentity.ino) {
                changed = true;
                fs.appendFileSync(first.ownerPath, '\n');
            }
            return result;
        }) as typeof fs.readSync);
        assert.throws(() => inspect(first.registrationId), /changed|identity|grew/);
        assert.equal(changed, true);
        assert.equal(fs.existsSync(first.payloadPath), true);
    });
    it('preserves an orphan root after failed publication and rejects missing ownership', () => {
        const renameSync = fsNative.renameSync;
        mock.method(fsNative, 'renameSync', (source: fs.PathLike, destination: fs.PathLike) => {
            if (String(destination).includes(`${path.sep}disposable-producers${path.sep}${taskId}${path.sep}`)) {
                throw Object.assign(new Error('Injected producer publication failure'), { code: 'EIO' });
            }
            return renameSync(source, destination);
        });
        assert.throws(register, /publication failure/);
        const taskPayloadPath = path.join(bundleRoot, 'runtime', 'owned-disposable', taskId);
        const runId = fs.readdirSync(taskPayloadPath)[0];
        const runPath = path.join(taskPayloadPath, runId);
        const registrationId = fs.readdirSync(runPath)[0];
        assert.ok(registrationId);
        assert.throws(() => inspect(registrationId), /missing|bounded|registration/);
        assert.equal(fs.existsSync(path.join(runPath, registrationId)), true);
        assert.deepEqual(fs.readdirSync(path.join(bundleRoot, 'runtime', 'disposable-producers', taskId)), []);
    });
});
