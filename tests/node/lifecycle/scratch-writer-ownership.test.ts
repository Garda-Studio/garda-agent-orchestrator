import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { inspectScratchWriter, registerScratchWriter, resolveScratchWriterLocations,
    withScratchWriterLock } from '../../../src/lifecycle/cleanup/scratch-writer-ownership';

describe('cooperative scratch writer ownership', () => {
    let targetRoot: string;
    let bundleRoot: string;
    const deadPid = 2147483647;
    const realKill = process.kill.bind(process);
    beforeEach(() => {
        targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-scratch-owner-'));
        bundleRoot = path.join(targetRoot, 'garda-agent-orchestrator');
        fs.mkdirSync(bundleRoot);
        mock.method(process, 'kill', (pid: number, signal?: NodeJS.Signals | number) => {
            if (pid === deadPid) throw Object.assign(new Error('known dead local fixture'), { code: 'ESRCH' });
            return realKill(pid, signal);
        });
    });
    afterEach(() => {
        mock.restoreAll();
        fs.rmSync(targetRoot, { recursive: true, force: true });
    });
    const options = () => ({ targetRoot, bundleRoot, scratchName: 'worker-cache' });
    function updateOwner(changes: Record<string, unknown>): void {
        const locations = resolveScratchWriterLocations(options());
        const owner = JSON.parse(fs.readFileSync(locations.ownerPath, 'utf8'));
        fs.writeFileSync(locations.ownerPath, JSON.stringify({ ...owner, ...changes }));
    }
    it('creates exclusive scratch and binds its local owner outside the deletable subtree', () => {
        const registration = registerScratchWriter(options());
        const locations = resolveScratchWriterLocations(options());
        const inspection = inspectScratchWriter(locations);
        assert.equal(inspection.state, 'live');
        assert.equal(inspection.owner.pid, process.pid);
        assert.equal(inspection.owner.hostname, os.hostname());
        assert.equal(inspection.owner.registration_id, registration.registrationId);
        assert.equal(path.dirname(registration.scratchPath), locations.tmpDir);
        assert.ok(!locations.ownerPath.startsWith(registration.scratchPath + path.sep));
        assert.ok(!locations.lockPath.startsWith(registration.scratchPath + path.sep));
        assert.throws(() => registerScratchWriter(options()), /live|active/);
    });
    it('rejects adoption of an existing unowned legacy directory', () => {
        const locations = resolveScratchWriterLocations(options());
        fs.mkdirSync(locations.scratchPath, { recursive: true });
        fs.writeFileSync(path.join(locations.scratchPath, 'legacy.txt'), 'keep');
        assert.throws(() => registerScratchWriter(options()), /owner|registration/);
        assert.equal(fs.readFileSync(path.join(locations.scratchPath, 'legacy.txt'), 'utf8'), 'keep');
        assert.equal(fs.existsSync(locations.ownerPath), false);
    });
    it('can activate a registered root only after a known local owner has died', () => {
        const first = registerScratchWriter(options());
        updateOwner({ pid: deadPid });
        assert.equal(inspectScratchWriter(resolveScratchWriterLocations(options())).state, 'dead');
        const next = registerScratchWriter(options());
        assert.notEqual(first.registrationId, next.registrationId);
        assert.equal(inspectScratchWriter(resolveScratchWriterLocations(options())).state, 'live');
    });
    it('preserves foreign and unverifiable process ownership', () => {
        registerScratchWriter(options());
        updateOwner({ hostname: 'foreign-host', pid: deadPid });
        assert.equal(inspectScratchWriter(resolveScratchWriterLocations(options())).state, 'foreign');
        assert.throws(() => registerScratchWriter(options()), /foreign/);
        updateOwner({ hostname: os.hostname(), pid: deadPid });
        mock.method(process, 'kill', () => { throw Object.assign(new Error('unverifiable'), { code: 'EIO' }); });
        assert.equal(inspectScratchWriter(resolveScratchWriterLocations(options())).state, 'unknown');
        assert.throws(() => registerScratchWriter(options()), /unknown|unverifiable/);
    });
    it('rejects a replaced root even when the path and owner record are unchanged', () => {
        registerScratchWriter(options());
        updateOwner({ pid: deadPid });
        const locations = resolveScratchWriterLocations(options());
        fs.renameSync(locations.scratchPath, locations.scratchPath + '-saved');
        fs.mkdirSync(locations.scratchPath);
        assert.throws(() => inspectScratchWriter(locations), /identity/);
        assert.throws(() => registerScratchWriter(options()), /identity/);
    });
    for (const scratchName of ['../outside', 'reviews', 'WIP', 'T-001', 'T-001-output.log', 'project-memory', '.scratch-writers.lock']) {
        it(`rejects protected or escaping scratch name ${scratchName}`, () => {
            assert.throws(() => registerScratchWriter({ targetRoot, bundleRoot, scratchName }), /scratch|protected|name/);
        });
    }
    for (const owner of [null, {}, { pid: deadPid, hostname: os.hostname() },
        { lock_id: 'foreign-generation', pid: deadPid, hostname: 'foreign-host', created_at_utc: '2026-01-01T00:00:00.000Z' }]) {
        it(`does not recover unverifiable or active shared writer locks: ${JSON.stringify(owner)}`, () => {
            registerScratchWriter(options());
            const locations = resolveScratchWriterLocations(options());
            fs.mkdirSync(locations.lockPath);
            if (owner) fs.writeFileSync(path.join(locations.lockPath, 'owner.json'), JSON.stringify(owner));
            const old = new Date(Date.now() - 60 * 60 * 1000);
            fs.utimesSync(locations.lockPath, old, old);
            assert.throws(() => withScratchWriterLock(locations, () => assert.fail('lock must remain protected')), /lock|owner/);
            assert.equal(fs.existsSync(locations.lockPath), true);
        });
    }
    it('blocks recovery of an old shared writer lock with a verifiably live local owner', () => {
        registerScratchWriter(options());
        const locations = resolveScratchWriterLocations(options());
        fs.mkdirSync(locations.lockPath);
        fs.writeFileSync(path.join(locations.lockPath, 'owner.json'), JSON.stringify({ lock_id: 'live-generation',
            pid: process.pid, hostname: os.hostname(), created_at_utc: '2026-01-01T00:00:00.000Z' }));
        const old = new Date(Date.now() - 60 * 60 * 1000);
        fs.utimesSync(locations.lockPath, old, old);
        assert.throws(() => withScratchWriterLock(locations, () => assert.fail('live lock must survive')), /active|owner/);
        assert.equal(fs.existsSync(locations.lockPath), true);
    });
    it('recovers only a complete positively known-dead local writer lock', () => {
        registerScratchWriter(options());
        const locations = resolveScratchWriterLocations(options());
        fs.mkdirSync(locations.lockPath);
        fs.writeFileSync(path.join(locations.lockPath, 'owner.json'), JSON.stringify({ lock_id: 'dead-generation',
            pid: deadPid, hostname: os.hostname(), created_at_utc: '2026-01-01T00:00:00.000Z' }));
        let owned = false;
        withScratchWriterLock(locations, checkLock => { checkLock(); owned = true; });
        assert.equal(owned, true);
        assert.equal(fs.existsSync(locations.lockPath), false);
    });
});
