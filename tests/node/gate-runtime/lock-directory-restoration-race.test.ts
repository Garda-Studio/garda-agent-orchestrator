import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

interface DirectoryIdentity { dev: string; ino: string; mode: string; birthtimeNs: string; uid: string; gid: string }
interface WorkerEvent {
    kind: string; pid: number; identity?: DirectoryIdentity;
    ownerPid?: number; ownerLockId?: string; empty?: boolean; failure?: string | null;
    canonicalWasAbsent?: boolean; canonicalExists?: boolean;
    claimedIdentity?: DirectoryIdentity; claimedHash?: string; queueReusable?: boolean | null;
    copyHash?: string | null; copySourceIdentity?: DirectoryIdentity; copyKind?: string;
    canonicalIdentity?: DirectoryIdentity | null; canonicalHash?: string | null;
    claimedIdentityAfter?: DirectoryIdentity | null; claimedHashAfter?: string | null;
}

function launchWorker(root: string, domain: string, role: string, competitor: boolean) {
    const workerPath = path.resolve(process.cwd(), 'tests/node/gate-runtime/fixtures/native-lock-restoration-worker.cjs');
    const moduleRoot = path.resolve(__dirname, '../../../src');
    const child = spawn(process.execPath, [workerPath, moduleRoot, root, domain, role, competitor ? 'yes' : 'no'], {
        stdio: ['ignore', 'pipe', 'pipe']
    });
    assert.ok(child.stdout && child.stderr && child.pid);
    let stderr = '';
    let stopped = false;
    let launchError: Error | null = null;
    child.stderr.on('data', bytes => { stderr += String(bytes); });
    const events: WorkerEvent[] = [];
    const listeners = new Set<() => void>();
    const lines = createInterface({ input: child.stdout });
    lines.on('line', line => {
        try {
            const event = JSON.parse(line) as WorkerEvent;
            if (typeof event.kind !== 'string' || event.pid !== child.pid) throw new Error('Invalid worker identity');
            events.push(event);
        } catch (error) {
            launchError = error instanceof Error ? error : new Error(String(error));
        }
        for (const listener of listeners) listener();
    });
    const exited = new Promise<number | null>(resolve => {
        child.once('error', error => { launchError = error; for (const listener of listeners) listener(); });
        child.once('close', code => { stopped = true; for (const listener of listeners) listener(); resolve(code); });
    });
    const next = (kind: string) => new Promise<WorkerEvent>((resolve, reject) => {
        const timer = setTimeout(() => { listeners.delete(check); reject(new Error(role + ' milestone timed out: ' + kind + '; ' + stderr)); }, 15000);
        function check() {
            const index = events.findIndex(event => event.kind === kind);
            if (index >= 0) {
                clearTimeout(timer); listeners.delete(check); resolve(events.splice(index, 1)[0]); return;
            }
            if (stopped || launchError) {
                clearTimeout(timer); listeners.delete(check); reject(launchError || new Error(role + ' exited before ' + kind + '; ' + stderr));
            }
        }
        listeners.add(check); check();
    });
    return { child, next, exited, async stop() { if (!stopped) child.kill(); await exited; lines.close(); } };
}

async function runRestorationSchedule(domain: string, competitor: boolean) {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-native-restore-race-'));
    const root = path.join(parent, 'project'); fs.mkdirSync(root);
    const workers: ReturnType<typeof launchWorker>[] = [];
    const signal = (name: string) => fs.writeFileSync(path.join(root, name), '', { flag: 'wx' });
    try {
        const restorer = launchWorker(root, domain, 'restorer', competitor); workers.push(restorer);
        let admitted: WorkerEvent | null = null;
        let published: WorkerEvent | null = null;
        let publisher: ReturnType<typeof launchWorker> | null = null;
        if (competitor) {
            const window = await restorer.next('window');
            assert.equal(window.canonicalWasAbsent, true);
            publisher = launchWorker(root, domain, 'publisher', true); workers.push(publisher);
            admitted = await publisher.next('admitted');
            assert.equal(admitted.empty, true, 'the real native acquirer is paused after mkdir and before owner.json publication');
            assert.equal(admitted.ownerPid, publisher.child.pid);
            assert.notEqual(restorer.child.pid, publisher.child.pid);
            process.kill(restorer.child.pid!, 0); process.kill(publisher.child.pid!, 0);
            signal('replacement-admitted');
        }
        const restored = await restorer.next('restored');
        if (publisher) {
            signal('publish-owner');
            published = await publisher.next('published');
            assert.equal(published.ownerPid, publisher.child.pid);
            assert.ok(published.ownerLockId);
            process.kill(restorer.child.pid!, 0); process.kill(publisher.child.pid!, 0);
            signal('finish-publisher');
            const cleaned = await publisher.next('cleaned');
            assert.equal(cleaned.canonicalExists, false, 'the real native publisher cleans up its own issued claim');
            assert.equal(await publisher.exited, 0);
        }
        signal('finish-restorer');
        assert.equal(await restorer.exited, 0);
        return { restored, admitted, published };
    } finally {
        await Promise.all(workers.map(worker => worker.stop()));
        fs.rmSync(parent, { recursive: true, force: true });
    }
}

const domains = ['timeline', 'timeline-async', 'lifecycle', 'lifecycle-async'];
test('native claim conflict preserves competing owners and verified copy custody', {
    skip: process.platform !== 'linux', timeout: 60000
}, async () => {
    const results = [];
    for (const domain of domains) results.push(await runRestorationSchedule(domain, true));
    assert.ok(results.every(({ restored }) => /Verified disputed copy retained/.test(restored.failure || '')));
    assert.ok(results.every(({ restored }) => restored.copyKind === 'DISPUTED_LOCK_COPY_NOT_RECOVERY_AUTHORITY'));
    assert.deepEqual(results.map(({ restored, published }) => ({
        replacement: restored.canonicalIdentity, originalClaim: restored.claimedIdentityAfter,
        originalBytes: restored.claimedHashAfter, publishedOwnerDirectory: published?.identity,
        copyHash: restored.copyHash, copySourceIdentity: restored.copySourceIdentity
    })), results.map(({ restored, admitted }) => ({
        replacement: admitted?.identity, originalClaim: restored.claimedIdentity,
        originalBytes: restored.claimedHash, publishedOwnerDirectory: admitted?.identity,
        copyHash: restored.claimedHash, copySourceIdentity: restored.claimedIdentity
    })), 'all four schedules retain both physical owners and exact bytes across native mkdir/publication');
});
test('native claim conflict refuses publication without a competitor or explicit timeline root', {
    timeout: 30000
}, async () => {
    const results = [];
    for (const domain of domains) results.push({ domain, ...(await runRestorationSchedule(domain, false)) });
    assert.ok(results.every(({ restored }) => /ownership conflict; canonical publication refused/.test(restored.failure || '')));
    assert.ok(results.every(({ restored }) => restored.claimedIdentity && restored.canonicalIdentity === null));
    assert.deepEqual(results.map(({ restored }) => [restored.claimedIdentityAfter, restored.claimedHashAfter]),
        results.map(({ restored }) => [restored.claimedIdentity, restored.claimedHash]));
    assert.ok(results.filter(({ domain }) => domain.startsWith('timeline')).every(({ restored }) =>
        /Explicit project root is unavailable/.test(restored.failure || '')));
    assert.equal(results.find(({ domain }) => domain === 'lifecycle-async')?.restored.queueReusable, true);
});
