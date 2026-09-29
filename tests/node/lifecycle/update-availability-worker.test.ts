import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import { acquireFilesystemLock, releaseFilesystemLock } from '../../../src/gate-runtime/task-events-locking';
import { createUpdateAvailabilityService, prepareBackgroundUpdateAvailability, checkClaimedUpdateAvailability, readCachedUpdateAvailabilityView } from '../../../src/lifecycle/update-availability/update-availability-service';
import { cachedUpdateAvailabilityNotice, prefetchUpdateAvailabilityNotice, scheduleUpdateAvailabilityCheck } from '../../../src/lifecycle/update-availability/update-availability-worker';

function fixture(t: TestContext, holdMetadata = false): { root: string; calls: string; releaseMetadata: () => void } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-availability-worker-'));
    const bundle = path.join(root, 'garda-agent-orchestrator');
    fs.mkdirSync(bundle);
    fs.writeFileSync(path.join(bundle, 'VERSION'), '1.4.3');
    fs.writeFileSync(path.join(bundle, 'package.json'), JSON.stringify({ name: 'garda-agent-orchestrator' }));
    const calls = path.join(root, 'calls.jsonl');
    const fakeNpm = path.join(root, 'npm-cli.js');
    const release = path.join(root, 'release-metadata');
    fs.writeFileSync(fakeNpm, `const fs=require('node:fs');fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(process.argv.slice(2))+'\\n');
const respond=()=>process.stdout.write(JSON.stringify({version:'1.4.4','dist.integrity':${JSON.stringify('sha512-' + Buffer.alloc(64, 1).toString('base64'))}}));
${holdMetadata ? `const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){clearInterval(timer);respond();}},10);` : 'setTimeout(respond,1500);'}`);
    const previous = { npm: process.env.npm_execpath, enabled: process.env.GARDA_UPDATE_CHECK };
    process.env.npm_execpath = fakeNpm;
    process.env.GARDA_UPDATE_CHECK = '1';
    t.after(() => {
        if (previous.npm === undefined) delete process.env.npm_execpath; else process.env.npm_execpath = previous.npm;
        if (previous.enabled === undefined) delete process.env.GARDA_UPDATE_CHECK; else process.env.GARDA_UPDATE_CHECK = previous.enabled;
        fs.rmSync(root, { recursive: true, force: true });
    });
    return { root, calls, releaseMetadata: () => fs.writeFileSync(release, 'continue') };
}

function installControlledMetadataProbe(t: TestContext, root: string, calls: string, holdMetadata = false): void {
    const workerPath = require.resolve('../../../src/lifecycle/update-availability/update-availability-worker');
    const sourcePath = require.resolve('../../../src/lifecycle/check-update/check-update-source');
    const preload = path.join(root, 'controlled-metadata.cjs');
    const release = path.join(root, 'release-metadata');
    // Keep the real scheduler and metadata processes; isolate only their local metadata response.
    fs.writeFileSync(preload, `
        const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
        if (path.resolve(process.argv[1] || '.') === ${JSON.stringify(workerPath)} && process.argv[2] === ${JSON.stringify(root)}) {
            require(${JSON.stringify(sourcePath)}).queryNpmUpdateMetadata = request => new Promise((resolve, reject) => {
                assert.equal(request.cwd, ${JSON.stringify(root)});
                assert.equal(request.packageSpec, 'garda-agent-orchestrator@latest');
                fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ packageSpec: request.packageSpec }) + '\\n');
                let timer;
                const abort = () => { clearInterval(timer); reject(new Error('Controlled metadata request aborted.')); };
                const respond = () => {
                    clearInterval(timer); request.signal.removeEventListener('abort', abort);
                    resolve({ version: '1.4.4', integrity: ${JSON.stringify('sha512-' + Buffer.alloc(64, 1).toString('base64'))} });
                };
                if (request.signal.aborted) return abort();
                request.signal.addEventListener('abort', abort, { once: true });
                if (!${JSON.stringify(holdMetadata)} || fs.existsSync(${JSON.stringify(release)})) return respond();
                timer = setInterval(() => { if (fs.existsSync(${JSON.stringify(release)})) respond(); }, 10);
            });
        }
    `);
    const previous = process.env.NODE_OPTIONS;
    process.env.NODE_OPTIONS = `${previous ?? ''} --require ${JSON.stringify(preload.replaceAll('\\', '/'))}`;
    t.after(() => {
        if (previous === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = previous;
    });
}

test('pending launch claims coalesce and reject mismatched worker attempts', async t => {
    const { root, calls } = fixture(t);
    const prepared = await Promise.all(Array.from({ length: 8 }, () => prepareBackgroundUpdateAvailability(root)));
    const claims = prepared.flatMap(item => item.claim ? [item.claim] : []);
    assert.equal(claims.length, 1);
    const config = path.join(root, '.npmrc');
    await delay(10);
    fs.writeFileSync(config, 'registry=https://second-source.example.test/\n');
    const secondSource = await prepareBackgroundUpdateAvailability(root);
    assert.ok(secondSource.claim);
    fs.unlinkSync(config);
    await checkClaimedUpdateAvailability(root, { ...claims[0], attemptId: '0'.repeat(32) });
    assert.equal(fs.existsSync(calls), false, 'a mismatched claim cannot perform a registry check');
    await Promise.all(Array.from({ length: 8 }, () => checkClaimedUpdateAvailability(root, claims[0])));
    await checkClaimedUpdateAvailability(root, claims[0]);
    assert.equal(fs.readFileSync(calls, 'utf8').trim().split('\n').length, 1);
    assert.equal(createUpdateAvailabilityService(root).snapshot().status, 'available');
    fs.writeFileSync(config, 'registry=https://second-source.example.test/\n');
    assert.equal((await prepareBackgroundUpdateAvailability(root)).claim, null, 'finishing the older claim preserves newer pending history');
});

test('real CLI probes launch one detached metadata worker and return before its slow query', async t => {
    const { root, calls, releaseMetadata } = fixture(t, true);
    const started = Date.now();
    await scheduleUpdateAvailabilityCheck(root);
    const notices = await Promise.all(Array.from({ length: 8 }, () => cachedUpdateAvailabilityNotice(root)));
    assert.deepEqual(notices, Array(8).fill(''));
    t.diagnostic(`Detached scheduling and eight cache probes: ${Date.now() - started} ms; metadata response held by a barrier.`);
    const service = createUpdateAvailabilityService(root);
    assert.notEqual(service.snapshot().status, 'available', 'cached probes finish while the metadata response is held');
    releaseMetadata();
    const deadline = Date.now() + 7000;
    while (service.snapshot().status !== 'available' && Date.now() < deadline) await delay(20);
    assert.equal(service.snapshot().status, 'available');
    assert.equal(fs.readFileSync(calls, 'utf8').trim().split('\n').length, 1);
    assert.match(await cachedUpdateAvailabilityNotice(root), /^Garda update available: 1\.4\.3 → 1\.4\.4\ngarda check-update /u);
    await scheduleUpdateAvailabilityCheck(root);
    assert.equal(fs.readFileSync(calls, 'utf8').trim().split('\n').length, 1, 'fresh cache prevents another detached request');
});

test('cached CLI presentation reads source configuration off the calling thread and honors opt-out', async t => {
    const { root, calls } = fixture(t);
    const service = createUpdateAvailabilityService(root, { automaticEnabled: true, queryMetadata: async () => ({ version: '1.4.4', integrity: 'sha512-example' }) });
    await service.check();
    const nativeFs = require('node:fs') as typeof fs;
    const originalStat = nativeFs.statSync;
    t.mock.method(nativeFs, 'statSync', (...args: Parameters<typeof fs.statSync>) => {
        assert.notEqual(String(args[0]), path.join(root, '.npmrc'), 'CLI thread must not discover npm configuration');
        return originalStat(...args);
    });
    assert.match(await cachedUpdateAvailabilityNotice(root), /^Garda update available:/u);
    process.env.GARDA_UPDATE_CHECK = '0';
    assert.equal(await cachedUpdateAvailabilityNotice(root), '');
    await scheduleUpdateAvailabilityCheck(root);
    assert.equal(fs.existsSync(calls), false);
});

test('concurrent CLI probes preserve cached notices for different repository roots', async t => {
    const { root, calls } = fixture(t);
    const otherRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-availability-other-root-'));
    t.after(() => fs.rmSync(otherRoot, { recursive: true, force: true }));
    const otherBundle = path.join(otherRoot, 'garda-agent-orchestrator');
    fs.mkdirSync(otherBundle);
    fs.writeFileSync(path.join(otherBundle, 'VERSION'), '1.4.3');
    fs.writeFileSync(path.join(otherBundle, 'package.json'), JSON.stringify({ name: 'garda-agent-orchestrator' }));
    for (const repoRoot of [root, otherRoot]) {
        await createUpdateAvailabilityService(repoRoot, {
            automaticEnabled: true,
            queryMetadata: async () => ({ version: '1.4.4', integrity: 'sha512-example' })
        }).check();
    }
    const notices = await Promise.all([root, otherRoot].map(repoRoot => cachedUpdateAvailabilityNotice(repoRoot)));
    assert.deepEqual(notices, [root, otherRoot].map(repoRoot =>
        `Garda update available: 1.4.3 → 1.4.4\ngarda check-update --target-root "${repoRoot.replace(/\\/gu, '/')}" --apply`));
    assert.equal(fs.existsSync(calls), false, 'independent fresh caches need no registry requests');
});

test('cached CLI presentation isolates filesystem reads without a foreground network request', async t => {
    const { root, calls } = fixture(t);
    await createUpdateAvailabilityService(root, { queryMetadata: async () => ({ version: '1.4.4', integrity: 'sha512-example' }) }).check();
    const modulePath = require.resolve('../../../src/lifecycle/update-availability/update-availability-worker');
    const script = `
        const { cachedUpdateAvailabilityNotice } = require(${JSON.stringify(modulePath)});
        const fs = require('node:fs');
        for (const method of ['existsSync', 'lstatSync', 'statSync', 'readFileSync']) {
            const original = fs[method];
            fs[method] = function(file, ...args) {
                if (String(file).startsWith(${JSON.stringify(root)})) throw new Error('cached CLI filesystem reads must be isolated');
                return original(file, ...args);
            };
        }
        const started = Date.now();
        let callerTurnAdvanced = false;
        setImmediate(() => { callerTurnAdvanced = true; });
        cachedUpdateAvailabilityNotice(${JSON.stringify(root)}).then(notice => {
            process.stdout.write(JSON.stringify({ notice, elapsed: Date.now() - started, callerTurnAdvanced }));
        });
    `;
    const result = JSON.parse(execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' })) as { notice: string; elapsed: number; callerTurnAdvanced: boolean };
    assert.match(result.notice, /^Garda update available:/u);
    assert.equal(result.callerTurnAdvanced, true, 'the caller event loop remains available during isolated cache reads');
    t.diagnostic(`Cached presentation: ${result.elapsed} ms; source reads forbidden in the caller.`);
    assert.equal(fs.existsSync(calls), false);
});

test('closeout prefetch revalidates configuration changes during asynchronous cache reads', async t => {
    const { root, calls } = fixture(t);
    await createUpdateAvailabilityService(root, { queryMetadata: async () => ({ version: '1.4.4', integrity: 'sha512-example' }) }).check();
    const preload = path.join(root, 'change-source.cjs');
    fs.writeFileSync(preload, `if(process.argv.includes('--snapshot')){const fs=require('node:fs');const read=fs.promises.readFile;
fs.promises.readFile=async function(file,...args){const result=await read(file,...args);
if(String(file).endsWith('cache.json'))fs.writeFileSync(${JSON.stringify(path.join(root, '.npmrc'))},'registry=https://changed.example.test/\\n');return result;};}`);
    const previous = process.env.NODE_OPTIONS;
    process.env.NODE_OPTIONS = `${previous ?? ''} --require ${JSON.stringify(preload.replaceAll('\\', '/'))}`;
    t.after(() => {
        if (previous === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = previous;
    });
    assert.equal(await prefetchUpdateAvailabilityNotice(root)(), '', 'a cache read cannot revive a hint for the changed source');
    assert.equal(fs.existsSync(calls), false, 'cached presentation cannot schedule metadata work');
});

test('cancelling a speculative closeout read preserves concurrent shared cached readers', t => {
    const { root } = fixture(t);
    const script = `
        const assert = require('node:assert/strict');
        const { EventEmitter } = require('node:events');
        const workers = [];
        require('node:child_process').spawn = (file, args) => new class extends EventEmitter {
            constructor() { super(); assert.equal(args[1], '--snapshot'); this.terminated = false; workers.push(this); }
            unref() {}
            kill(signal) { assert.equal(signal, 'SIGKILL'); this.terminated = true; this.emit('close', 0); }
        };
        const { readCachedUpdateAvailabilityView: read } = require(${JSON.stringify(require.resolve('../../../src/lifecycle/update-availability/update-availability-service'))});
        const { prefetchUpdateAvailabilityNotice: prefetch } = require(${JSON.stringify(require.resolve('../../../src/lifecycle/update-availability/update-availability-worker'))});
        const available = { status: 'available', currentVersion: '1.4.3', latestVersion: '1.4.4', updateCommand: null };
        (async () => {
            for (const speculativeFirst of [false, true]) {
                const offset = workers.length;
                let speculative, shared;
                if (speculativeFirst) { speculative = prefetch(${JSON.stringify(root)}); shared = read(${JSON.stringify(root)}); }
                else { shared = read(${JSON.stringify(root)}); speculative = prefetch(${JSON.stringify(root)}); }
                const secondShared = read(${JSON.stringify(root)});
                assert.equal(workers.length, offset + 2, 'shared readers coalesce separately from owned speculative work');
                const speculativeWorker = workers[offset + (speculativeFirst ? 0 : 1)];
                const sharedWorker = workers[offset + (speculativeFirst ? 1 : 0)];
                speculative.cancel();
                assert.equal(await speculative(), '', 'discarded closeout returns quietly');
                assert.equal(speculativeWorker.terminated, true);
                assert.equal(sharedWorker.terminated, false, 'cancellation must leave the concurrent UI/cache read alive');
                sharedWorker.emit('message', available);
                sharedWorker.emit('close', 0);
                assert.deepEqual(await Promise.all([shared, secondShared]), [available, available]);
                await new Promise(resolve => setImmediate(resolve));
            }
            process.stdout.write('completed');
        })().catch(error => { console.error(error); process.exitCode = 1; });
    `;
    assert.equal(execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' }), 'completed');
});

test('a short-lived task entry launches a durable scheduler without waiting for its source probe', async t => {
    const { root, calls, releaseMetadata } = fixture(t, true);
    installControlledMetadataProbe(t, root, calls, true);
    const modulePath = require.resolve('../../../src/lifecycle/update-availability/update-availability-worker');
    const script = `
        require('node:worker_threads').Worker = function () { throw new Error('task entry must not start or await a local worker'); };
        const { scheduleUpdateAvailabilityCheck } = require(${JSON.stringify(modulePath)});
        const started = performance.now();
        scheduleUpdateAvailabilityCheck(${JSON.stringify(root)}).then(() => {
            process.stdout.write(JSON.stringify({ elapsed: performance.now() - started }));
        });
    `;
    const result = JSON.parse(execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' })) as { elapsed: number };
    t.diagnostic(`Short-lived task entry scheduling: ${result.elapsed} ms; metadata response held by a barrier.`);
    const service = createUpdateAvailabilityService(root);
    assert.notEqual(service.snapshot().status, 'available', 'the task entry process exits before metadata can respond');
    releaseMetadata();
    const deadline = Date.now() + 7000;
    while (service.snapshot().status !== 'available' && Date.now() < deadline) await delay(20);
    assert.equal(service.snapshot().status, 'available', 'scheduler survives its short-lived parent');
    assert.equal(fs.readFileSync(calls, 'utf8').trim().split('\n').length, 1);
});

test('concurrent entry processes create one scheduler before source and cache discovery', async t => {
    const { root, calls } = fixture(t);
    await createUpdateAvailabilityService(root, { queryMetadata: async () => ({ version: '1.4.4', integrity: 'sha512-example' }) }).check();
    const launches = path.join(root, 'scheduler-launches.txt');
    const modulePath = require.resolve('../../../src/lifecycle/update-availability/update-availability-worker');
    const script = `
        const cp = require('node:child_process');
        const nativeSpawn = cp.spawn;
        cp.spawn = function(command, args, options) {
            if (args[1] === '--schedule') require('node:fs').appendFileSync(${JSON.stringify(launches)}, 'launch\\n');
            return nativeSpawn(command, args, options);
        };
        require(${JSON.stringify(modulePath)}).scheduleUpdateAvailabilityCheck(${JSON.stringify(root)});
    `;
    await Promise.all(Array.from({ length: 8 }, () => promisify(execFile)(process.execPath, ['-e', script])));
    assert.equal(fs.readFileSync(launches, 'utf8').trim().split('\n').length, 1);
    const ticket = path.join(root, 'garda-agent-orchestrator', 'runtime', 'update-availability', 'scheduler.json');
    const before = JSON.parse(fs.readFileSync(ticket, 'utf8')) as { attemptId: string };
    await Promise.all(Array.from({ length: 8 }, () => scheduleUpdateAvailabilityCheck(root)));
    assert.equal((JSON.parse(fs.readFileSync(ticket, 'utf8')) as { attemptId: string }).attemptId,
        before.attemptId, 'fresh scheduling lease also coalesces same-process entries');
    assert.equal(fs.existsSync(calls), false, 'fresh daily metadata needs no npm request');
    await delay(500);
});

test('prevents a lost scheduler launch during lock contention', async t => {
    const { root, calls } = fixture(t);
    installControlledMetadataProbe(t, root, calls);
    const modulePath = require.resolve('../../../src/lifecycle/update-availability/update-availability-worker');
    const directory = path.join(root, 'garda-agent-orchestrator', 'runtime', 'update-availability');
    const lock = path.join(directory, 'scheduler.lock');
    const script = `
        const fs = require('node:fs'), cp = require('node:child_process');
        const nativeSpawn = cp.spawn;
        cp.spawn = (command, args, options) => {
            if (args[1] === '--schedule' && fs.existsSync(${JSON.stringify(lock)})) throw new Error('parent still owns scheduler lock');
            const child = nativeSpawn(command, args, options);
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
            return child;
        };
        require(${JSON.stringify(modulePath)}).scheduleUpdateAvailabilityCheck(${JSON.stringify(root)});
    `;
    await promisify(execFile)(process.execPath, ['-e', script]);
    const service = createUpdateAvailabilityService(root);
    const deadline = Date.now() + 7000;
    while (service.snapshot().status !== 'available' && Date.now() < deadline) await delay(20);
    assert.equal(service.snapshot().status, 'available', 'a delayed launcher still starts the durable probe');
    assert.equal(fs.readFileSync(calls, 'utf8').trim().split('\n').length, 1);

    const attemptId = randomUUID();
    const attemptedAt = Date.now() - 1000;
    const ticket = path.join(directory, 'scheduler.json');
    fs.writeFileSync(ticket, JSON.stringify({ schema: 2, attemptedAt, heartbeatAt: attemptedAt, attemptId }));
    const acquiring = path.join(root, 'scheduler-acquiring');
    const preload = path.join(root, 'scheduler-contention.cjs');
    fs.writeFileSync(preload, `
        const locking = require(${JSON.stringify(require.resolve('../../../src/gate-runtime/timeline/task-events-locking-acquire'))});
        const nativeLock = locking.withFilesystemLock;
        Object.defineProperty(locking, 'withFilesystemLock', { value: (...args) => {
            require('node:fs').writeFileSync(${JSON.stringify(acquiring)}, 'acquiring');
            return nativeLock(...args);
        } });
    `);
    const { handle } = acquireFilesystemLock(lock);
    const child = promisify(execFile)(process.execPath, ['--require', preload, modulePath, '--schedule', root, attemptId]);
    try {
        const startedDeadline = Date.now() + 5000;
        while (!fs.existsSync(acquiring) && Date.now() < startedDeadline) await delay(20);
        assert.equal(fs.existsSync(acquiring), true, 'the real child attempts the held lock');
        await delay(100);
    } finally { releaseFilesystemLock(handle); }
    await child;
    assert.ok((JSON.parse(fs.readFileSync(ticket, 'utf8')) as { heartbeatAt: number }).heartbeatAt > attemptedAt,
        'a temporary competing owner cannot discard the scheduler launch');
});

test('scheduler tickets fail quietly on malformed state and protect a live owner beyond the minute', async t => {
    const { root, calls } = fixture(t);
    await createUpdateAvailabilityService(root, { queryMetadata: async () => ({ version: '1.4.4', integrity: 'sha512-example' }) }).check();
    const ticket = path.join(root, 'garda-agent-orchestrator', 'runtime', 'update-availability', 'scheduler.json');
    fs.writeFileSync(ticket, '{malformed');
    await scheduleUpdateAvailabilityCheck(root);
    assert.equal(fs.readFileSync(ticket, 'utf8'), '{malformed');
    const live = JSON.stringify({ schema: 2, attemptedAt: Date.now() - 120_000, heartbeatAt: Date.now(), attemptId: randomUUID() });
    fs.writeFileSync(ticket, live);
    await scheduleUpdateAvailabilityCheck(root);
    assert.equal(fs.readFileSync(ticket, 'utf8'), live, 'a current scheduler heartbeat remains protected beyond the initial minute');
    fs.writeFileSync(ticket, JSON.stringify({ schema: 1, attemptedAt: Date.now() - 120_000, pid: 0 }));
    await scheduleUpdateAvailabilityCheck(root);
    assert.equal((JSON.parse(fs.readFileSync(ticket, 'utf8')) as { schema: number }).schema, 2, 'expired legacy ticket permits a new launch');
    assert.equal(fs.existsSync(calls), false);
    await delay(500);
});

test('rejects stale scheduler ownership when a PID is recycled', async t => {
    const { root, calls } = fixture(t);
    await createUpdateAvailabilityService(root, { queryMetadata: async () => ({ version: '1.4.4', integrity: 'sha512-example' }) }).check();
    const ticket = path.join(root, 'garda-agent-orchestrator', 'runtime', 'update-availability', 'scheduler.json');
    const expired = Date.now() - 120_000;
    fs.writeFileSync(ticket, JSON.stringify({ schema: 1, attemptedAt: expired, pid: process.pid }));
    await scheduleUpdateAvailabilityCheck(root);
    const replacement = JSON.parse(fs.readFileSync(ticket, 'utf8')) as { schema: number; attemptId: string };
    assert.equal(replacement.schema, 2, 'an unrelated live process cannot retain an expired legacy ticket');
    assert.ok(replacement.attemptId);
    await delay(500);
    fs.writeFileSync(ticket, JSON.stringify({ schema: 2, attemptedAt: expired, heartbeatAt: expired,
        attemptId: replacement.attemptId, pid: process.pid }));
    await scheduleUpdateAvailabilityCheck(root);
    assert.notEqual((JSON.parse(fs.readFileSync(ticket, 'utf8')) as { attemptId: string }).attemptId,
        replacement.attemptId, 'an expired owned lease is replaced independently of process PID liveness');
    assert.equal(fs.existsSync(calls), false);
    await delay(500);
});

test('rejects a replaced scheduler lease during renewal', async t => {
    const { root } = fixture(t);
    const directory = path.join(root, 'garda-agent-orchestrator', 'runtime', 'update-availability');
    fs.mkdirSync(directory, { recursive: true });
    const ticket = path.join(directory, 'scheduler.json');
    const attemptId = randomUUID();
    const attemptedAt = Date.now() - 1000;
    fs.writeFileSync(ticket, JSON.stringify({ schema: 2, attemptedAt, heartbeatAt: attemptedAt, attemptId }));
    const started = path.join(root, 'scheduler-started');
    const preload = path.join(root, 'scheduler-preload.cjs');
    fs.writeFileSync(preload, `
        const fs = require('node:fs');
        const service = require(${JSON.stringify(require.resolve('../../../src/lifecycle/update-availability/update-availability-service'))});
        service.prepareBackgroundUpdateAvailability = async () => {
            fs.writeFileSync(${JSON.stringify(started)}, 'started');
            await new Promise(resolve => setTimeout(resolve, 1000));
            return { claim: null, view: { status: 'unavailable' } };
        };
        const nativeInterval = global.setInterval;
        global.setInterval = callback => nativeInterval(callback, 20);
    `);
    const child = promisify(execFile)(process.execPath, ['--require', preload,
        require.resolve('../../../src/lifecycle/update-availability/update-availability-worker'), '--schedule', root, attemptId]);
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(started) && Date.now() < deadline) await delay(20);
    assert.equal(fs.existsSync(started), true, 'the real scheduler entered its probe with a valid owned lease');
    assert.ok((JSON.parse(fs.readFileSync(ticket, 'utf8')) as { heartbeatAt: number }).heartbeatAt > attemptedAt);
    const successor = JSON.stringify({ schema: 2, attemptedAt: Date.now(), heartbeatAt: Date.now(), attemptId: randomUUID() });
    fs.writeFileSync(ticket, successor);
    await child;
    assert.equal(fs.readFileSync(ticket, 'utf8'), successor, 'the old scheduler cannot renew another launch identity');
});

test('comparative entry and closeout measurements include cold warm and saturated samples', async t => {
    const { root, calls } = fixture(t);
    const metrics: Record<string, number[]> = { foreground_probe: [], cold_scheduler: [], warm_scheduler: [], closeout_prefetch: [], saturated_eight: [] };
    const timed = async (key: string, action: () => Promise<unknown>): Promise<void> => {
        const started = performance.now(); await action(); metrics[key].push(performance.now() - started);
    };
    const cpuBefore = process.cpuUsage();
    const servicePath = require.resolve('../../../src/lifecycle/update-availability/update-availability-service');
    const noticePath = require.resolve('../../../src/lifecycle/update-availability/update-availability-notice');
    const legacyCachedWorker = (target: string): Promise<void> => new Promise((resolve, reject) => {
        const script = `const { parentPort } = require('node:worker_threads');
            const view = require(${JSON.stringify(servicePath)}).createUpdateAvailabilityService(${JSON.stringify(target)}).snapshot();
            parentPort.postMessage(require(${JSON.stringify(noticePath)}).formatUpdateAvailabilityNotice(${JSON.stringify(target)}, view));`;
        const worker = new Worker(script, { eval: true });
        worker.on('error', reject);
        worker.on('message', (notice: string) => { assert.match(notice, /^Garda update available:/u); worker.unref(); resolve(); });
    });
    for (let index = 0; index < 20; index++) {
        const target = path.join(root, `sample-${index}`);
        const bundle = path.join(target, 'garda-agent-orchestrator');
        fs.mkdirSync(bundle, { recursive: true });
        fs.writeFileSync(path.join(bundle, 'VERSION'), '1.4.3');
        fs.writeFileSync(path.join(bundle, 'package.json'), JSON.stringify({ name: 'garda-agent-orchestrator' }));
        await createUpdateAvailabilityService(target, { queryMetadata: async () => ({ version: '1.4.4', integrity: 'sha512-example' }) }).check();
        await timed('foreground_probe', () => legacyCachedWorker(target));
        await timed('cold_scheduler', () => scheduleUpdateAvailabilityCheck(target));
        await timed('warm_scheduler', () => scheduleUpdateAvailabilityCheck(target));
        await timed('closeout_prefetch', () => prefetchUpdateAvailabilityNotice(target)());
        await timed('saturated_eight', () => Promise.all(Array.from({ length: 8 }, () => scheduleUpdateAvailabilityCheck(target))));
    }
    const distributions = Object.fromEntries(Object.entries(metrics).map(([key, samples]) => {
        const sorted = [...samples].sort((a, b) => a - b);
        return [key, { n: samples.length, p50_ms: sorted[9], p95_ms: sorted[18], max_ms: sorted[19] }];
    }));
    t.diagnostic(JSON.stringify({ measured_at_utc: new Date().toISOString(), platform: process.platform, node: process.version,
        cpus: os.availableParallelism(), fixture: '20 independent roots with fresh daily metadata; cold versus warm scheduler ticket; eight same-root entries',
        baseline: 'previous cached presentation mechanism reconstructed as a real snapshot worker on the same fresh cache', distributions,
        caller_cpu_microseconds: process.cpuUsage(cpuBefore), caller_rss_bytes: process.memoryUsage().rss,
        scheduler_capacity: 'one per root per minute with an owned renewable lease; separate eight-process regression checks launch count' }));
    assert.equal(fs.existsSync(calls), false);
    await delay(500);
});

test('production service checks keep configuration and cache I/O off the caller thread', async t => {
    const { root, calls } = fixture(t);
    await createUpdateAvailabilityService(root, {
        automaticEnabled: true, queryMetadata: async () => ({ version: '1.4.4', integrity: 'sha512-example' })
    }).check();
    const nativeFs = require('node:fs') as typeof fs;
    const originalStat = nativeFs.statSync;
    const originalRead = nativeFs.readFileSync;
    t.mock.method(nativeFs, 'statSync', (...args: Parameters<typeof fs.statSync>) => {
        assert.notEqual(String(args[0]), path.join(root, '.npmrc'), 'UI request thread must not discover configuration');
        return originalStat(...args);
    });
    t.mock.method(nativeFs, 'readFileSync', (...args: Parameters<typeof fs.readFileSync>) => {
        assert.notEqual(path.basename(String(args[0])), 'cache.json', 'UI request thread must not read availability cache');
        return originalRead(...args);
    });
    const production = createUpdateAvailabilityService(root, { automaticEnabled: true });
    const views = await Promise.all(Array.from({ length: 8 }, () => production.check()));
    assert.ok(views.every(view => view.status === 'available'));
    assert.equal(fs.existsSync(calls), false, 'the production worker uses the fresh shared cache');
});

test('a disabled production automatic check does not swallow a concurrent manual refresh', async t => {
    const { root, calls } = fixture(t);
    const production = createUpdateAvailabilityService(root, { automaticEnabled: false });
    const [automatic, manual] = await Promise.all([production.check(), production.check({ manual: true })]);
    assert.equal(automatic.status, 'disabled');
    assert.equal(manual.status, 'available');
    assert.equal(fs.readFileSync(calls, 'utf8').trim().split('\n').length, 1);
});

test('a production automatic cache hit does not swallow a concurrent manual refresh', async t => {
    const { root, calls } = fixture(t);
    await createUpdateAvailabilityService(root, { queryMetadata: async () => ({ version: '1.4.4', integrity: 'sha512-example' }) }).check();
    const production = createUpdateAvailabilityService(root, { automaticEnabled: true });
    const [automatic, manual] = await Promise.all([production.check(), production.check({ manual: true })]);
    assert.equal(automatic.status, 'available');
    assert.equal(manual.status, 'available');
    assert.equal(fs.readFileSync(calls, 'utf8').trim().split('\n').length, 1, 'manual refresh bypasses the fresh daily cache');
});

test('prevents lost manual refreshes after automatic and caller deadlines', t => {
    const { root } = fixture(t);
    const clientPath = require.resolve('../../../src/lifecycle/update-availability/update-availability-client');
    const script = `
        const assert = require('node:assert/strict');
        const { EventEmitter } = require('node:events');
        const workers = [], timers = [];
        require('node:child_process').spawn = (file, args) => new class extends EventEmitter {
            constructor() { super(); this.request = JSON.parse(args[3]).request; workers.push(this); }
            unref() { this.unreferenced = true; }
            kill(signal) { assert.equal(signal, 'SIGKILL'); this.terminated = true; }
        };
        global.setTimeout = callback => { const timer = { callback, active: true, lifetime: false, unref() { this.lifetime = true; } }; timers.push(timer); return timer; };
        global.clearTimeout = timer => { timer.active = false; };
        const { checkUpdateAvailabilityInProcess: check } = require(${JSON.stringify(clientPath)});
        const available = { status: 'available', currentVersion: '1.4.3', latestVersion: '1.4.4', updateCommand: 'garda check-update --apply' };
        require(${JSON.stringify(require.resolve('../../../src/lifecycle/update-availability/update-availability-service'))}).readCachedUpdateAvailabilityView = async () => available;
        (async () => {
            for (const expireManual of [false, true]) {
                const firstWorker = workers.length, firstTimer = timers.length;
                const repo = ${JSON.stringify(root)} + '/' + expireManual;
                const automatic = check(repo, {}, { automaticEnabled: true });
                const manual = Array.from({ length: 8 }, () => check(repo, { manual: true }, {}));
                timers[firstTimer].callback();
                assert.equal((await automatic).status, 'unavailable');
                assert.equal(workers.length, firstWorker + 1, 'timeout must not overlap live workers');
                timers[firstTimer + 1].callback();
                assert.equal(workers[firstWorker].terminated, true, 'the process lifetime is bounded independently from the caller');
                if (expireManual) {
                    for (const timer of timers.slice(firstTimer + 2).filter(timer => !timer.lifetime)) timer.callback();
                    assert.ok((await Promise.all(manual)).every(view => view.status === 'unavailable'));
                }
                workers[firstWorker].emit('close', 0);
                await Promise.resolve();
                assert.equal(workers.length, firstWorker + 2, 'exactly one queued manual refresh starts after exit');
                assert.equal(workers[firstWorker + 1].request.manual, true);
                if (expireManual) assert.equal(workers[firstWorker + 1].unreferenced, true);
                workers[firstWorker + 1].emit('message', available);
                workers[firstWorker + 1].emit('close', 0);
                if (!expireManual) assert.deepEqual(await Promise.all(manual), Array(8).fill(available));
                await new Promise(resolve => setImmediate(resolve));
                const next = check(repo, {}, { automaticEnabled: true });
                assert.equal(workers.length, firstWorker + 3, 'exit releases both queue entries');
                workers[firstWorker + 2].emit('message', available);
                workers[firstWorker + 2].emit('close', 0);
                await next;
            }
            process.stdout.write('completed');
        })().catch(error => { console.error(error); process.exitCode = 1; });
    `;
    assert.equal(execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' }), 'completed');
});

test('coalesced callers retain independent deadlines after queued callers expire', t => {
    const { root } = fixture(t);
    const script = `
        const assert = require('node:assert/strict');
        const { EventEmitter } = require('node:events');
        const workers = [], timers = [];
        require('node:child_process').spawn = (file, args) => new class extends EventEmitter {
            constructor() { super(); this.options = JSON.parse(args[3]).options; workers.push(this); }
            unref() {}
            kill() {}
        };
        global.setTimeout = (callback, duration) => {
            const timer = { callback, duration, active: true, lifetime: false, unref() { this.lifetime = true; } };
            timers.push(timer); return timer;
        };
        global.clearTimeout = timer => { if (timer) timer.active = false; };
        const { checkUpdateAvailabilityInProcess: check } = require(${JSON.stringify(require.resolve('../../../src/lifecycle/update-availability/update-availability-client'))});
        const available = { status: 'available', currentVersion: '1.4.3', latestVersion: '1.4.4', updateCommand: null };
        require(${JSON.stringify(require.resolve('../../../src/lifecycle/update-availability/update-availability-service'))}).readCachedUpdateAvailabilityView = async () => available;
        (async () => {
            const repo = ${JSON.stringify(root)};
            const automatic = check(repo, {}, {});
            const original = check(repo, { manual: true }, {});
            timers.filter(timer => !timer.lifetime).at(-1).callback();
            assert.equal((await original).status, 'unavailable');
            let lateSettled = false;
            const late = check(repo, { manual: true }, {});
            void late.then(() => { lateSettled = true; });
            await Promise.resolve();
            assert.equal(lateSettled, false, 'a fresh caller must not inherit an expired result');
            workers[0].emit('close', 0);
            await new Promise(resolve => setImmediate(resolve));
            assert.equal(workers.length, 2, 'late callers reuse the still-pending manual work');
            workers[1].emit('message', available);
            workers[1].emit('close', 0);
            assert.deepEqual(await late, available);
            await automatic;
            await new Promise(resolve => setImmediate(resolve));

            const short = check(repo, { manual: true }, { timeoutMs: 10 });
            const long = check(repo, { manual: true }, { timeoutMs: 20 });
            workers[2].emit('close', 0);
            await new Promise(resolve => setImmediate(resolve));
            assert.equal(workers.length, 4, 'different execution timeouts retain distinct work');
            assert.equal(workers[3].options.timeoutMs, 20);
            workers[3].emit('message', available);
            workers[3].emit('close', 0);
            await short;
            assert.deepEqual(await long, available);
            assert.equal(timers.filter(timer => timer.active).length, 0, 'all caller and lifetime timers are released');
            process.stdout.write('completed');
        })().catch(error => { console.error(error); process.exitCode = 1; });
    `;
    assert.equal(execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' }), 'completed');
});

test('production automatic checks preserve platform environment-key opt-out semantics', t => {
    const { root } = fixture(t);
    const script = `
        const assert = require('node:assert/strict');
        const { EventEmitter } = require('node:events');
        let payload;
        require('node:child_process').spawn = (file, args) => {
            payload = JSON.parse(args[3]);
            const child = new EventEmitter();
            child.unref = () => {};
            process.nextTick(() => child.emit('close', 0));
            return child;
        };
        delete process.env.GARDA_UPDATE_CHECK;
        process.env.garda_update_check = '0';
        const expectedEnabled = process.env.GARDA_UPDATE_CHECK !== '0';
        const { checkUpdateAvailabilityInProcess: check } = require(${JSON.stringify(require.resolve('../../../src/lifecycle/update-availability/update-availability-client'))});
        check(${JSON.stringify(root)}, {}, {}).then(() => {
            assert.equal(payload.options.automaticEnabled, expectedEnabled, 'capturing the environment must preserve native key lookup semantics');
            process.stdout.write('completed');
        }).catch(error => { console.error(error); process.exitCode = 1; });
    `;
    assert.equal(execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' }), 'completed');
});

test('production refreshes queue changed transport environments and capture each request source', t => {
    const { root } = fixture(t);
    const script = `
        const assert = require('node:assert/strict');
        const { EventEmitter } = require('node:events');
        const workers = [];
        require('node:child_process').spawn = (file, args, options) => new class extends EventEmitter {
            constructor() { super(); this.environment = options.env; workers.push(this); }
            unref() {}
            kill() { throw new Error('controlled workers must not reach their lifetime deadline'); }
        };
        const { checkUpdateAvailabilityInProcess: check } = require(${JSON.stringify(require.resolve('../../../src/lifecycle/update-availability/update-availability-client'))});
        const available = { status: 'available', currentVersion: '1.4.3', latestVersion: '1.4.4', updateCommand: null };
        require(${JSON.stringify(require.resolve('../../../src/lifecycle/update-availability/update-availability-service'))}).readCachedUpdateAvailabilityView = async () => available;
        (async () => {
            const repo = ${JSON.stringify(root)};
            process.env.npm_config_registry = 'https://first.example.test/';
            const first = check(repo, { manual: true }, {});
            process.env.npm_config_registry = 'https://second.example.test/';
            const second = check(repo, { manual: true }, {});
            const repeated = [check(repo, { manual: true }, {}), check(repo, {}, {})];
            process.env.npm_config_registry = 'https://third.example.test/';
            const third = check(repo, {}, {});
            process.env.npm_config_registry = 'https://first.example.test/';
            repeated.push(check(repo, { manual: true }, {}));
            process.env.npm_config_registry = 'https://second.example.test/';
            repeated.push(check(repo, { manual: true }, {}));
            process.env.npm_config_registry = 'https://third.example.test/';
            const initialNodeOptions = process.env.NODE_OPTIONS;
            process.env.NODE_OPTIONS = (initialNodeOptions || '') + ' --conditions=changed-environment';
            const fourth = check(repo, {}, {});
            assert.equal(workers.length, 1, 'changed sources queue without overlapping live checks');
            for (const [index, registry] of ['first', 'second', 'third', 'third'].entries()) {
                assert.equal(workers[index].environment.npm_config_registry, 'https://' + registry + '.example.test/');
                assert.equal(workers[index].environment.NODE_OPTIONS, index === 3 ? process.env.NODE_OPTIONS : initialNodeOptions);
                workers[index].emit('message', available);
                workers[index].emit('close', 0);
                await new Promise(resolve => setImmediate(resolve));
                assert.equal(workers.length, Math.min(index + 2, 4));
            }
            assert.ok((await Promise.all([first, second, third, fourth, ...repeated])).every(view => view.status === 'available'));
            assert.equal(workers.length, 4, 'equivalent work coalesces while each caller retains its own deadline');
            process.stdout.write('completed');
        })().catch(error => { console.error(error); process.exitCode = 1; });
    `;
    assert.equal(execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' }), 'completed');
});

test('prevents stalled filesystem reads from delaying cached presentation indefinitely', async t => {
    const { root, calls } = fixture(t);
    await createUpdateAvailabilityService(root, { queryMetadata: async () => ({ version: '1.4.4', integrity: 'sha512-example' }) }).check();
    const bundle = path.join(root, 'garda-agent-orchestrator');
    const previous = process.env.NODE_OPTIONS;
    const restore = (): void => { if (previous === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = previous; };
    t.after(restore);
    for (const method of ['existsSync', 'lstatSync']) {
        const marker = path.join(root, `${method}-pid.txt`);
        const preload = path.join(root, `${method}-stall.cjs`);
        fs.writeFileSync(preload, `const fs=require('node:fs');const original=fs[${JSON.stringify(method)}];
if(process.argv.includes('--snapshot'))fs[${JSON.stringify(method)}]=function(file,...args){
if(String(file).startsWith(${JSON.stringify(bundle)})){fs.writeFileSync(${JSON.stringify(marker)},String(process.pid));
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);}return original(file,...args);};`);
        process.env.NODE_OPTIONS = `${previous ?? ''} --require ${JSON.stringify(preload.replaceAll('\\', '/'))}`;
        let callerTicks = 0;
        const heartbeat = setInterval(() => { callerTicks++; }, 10);
        const views = await Promise.all(Array.from({ length: 8 }, () => readCachedUpdateAvailabilityView(root)));
        clearInterval(heartbeat);
        restore();
        assert.ok(views.every(view => view.status === 'unavailable'));
        assert.ok(callerTicks > 0, 'the caller remains responsive while root or containment I/O is stalled');
        assert.ok(fs.existsSync(marker), `the real snapshot child reaches ${method}`);
        const childPid = Number(fs.readFileSync(marker, 'utf8'));
        assert.notEqual(childPid, process.pid);
        const deadline = Date.now() + 2000;
        while (Date.now() < deadline) {
            try { process.kill(childPid, 0); } catch { break; }
            await delay(20);
        }
        assert.throws(() => process.kill(childPid, 0), /ESRCH/);
        assert.equal((await readCachedUpdateAvailabilityView(root)).status, 'available', 'a dead read cannot retain its coalescing entry');
    }
    assert.equal(fs.existsSync(calls), false, 'cached presentation never queries npm');
});

test('rejects cached child results when the parent transport environment changes', async t => {
    const { root, calls } = fixture(t);
    await createUpdateAvailabilityService(root, { queryMetadata: async () => ({ version: '1.4.4', integrity: 'sha512-example' }) }).check();
    const marker = path.join(root, 'snapshot-started');
    const release = path.join(root, 'snapshot-release');
    const preload = path.join(root, 'pause-snapshot.cjs');
    fs.writeFileSync(preload, `if(process.argv.includes('--snapshot')){const fs=require('node:fs');const read=fs.promises.readFile;
fs.promises.readFile=async function(file,...args){if(String(file).endsWith('cache.json')){
fs.writeFileSync(${JSON.stringify(marker)},'started');while(!fs.existsSync(${JSON.stringify(release)}))await new Promise(r=>setTimeout(r,10));}
return read(file,...args);};}`);
    const previous = { options: process.env.NODE_OPTIONS, registry: process.env.npm_config_registry };
    t.after(() => {
        if (previous.options === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = previous.options;
        if (previous.registry === undefined) delete process.env.npm_config_registry; else process.env.npm_config_registry = previous.registry;
    });
    process.env.NODE_OPTIONS = `${previous.options ?? ''} --require ${JSON.stringify(preload.replaceAll('\\', '/'))}`;
    const pending = readCachedUpdateAvailabilityView(root);
    const deadline = Date.now() + 3000;
    while (!fs.existsSync(marker) && Date.now() < deadline) await delay(20);
    assert.ok(fs.existsSync(marker));
    process.env.npm_config_registry = 'https://changed-source.example.test/';
    fs.writeFileSync(release, 'continue');
    assert.equal((await pending).status, 'unavailable');
    assert.equal(fs.existsSync(calls), false);
});

test('prevents a stalled check process from retaining resources and its cache lock', async t => {
    const { root } = fixture(t);
    const cacheFile = path.join(root, 'garda-agent-orchestrator', 'runtime', 'update-availability', 'cache.json');
    const marker = path.join(root, 'stalled-process.txt');
    const preload = path.join(root, 'stall-cache.cjs');
    fs.writeFileSync(preload, `const fs=require('node:fs');const rename=fs.renameSync;
fs.renameSync=function(from,to){const result=rename(from,to);if(String(to)===${JSON.stringify(cacheFile)}){
fs.writeFileSync(${JSON.stringify(marker)},String(process.pid));Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);}return result;};`);
    const previous = process.env.NODE_OPTIONS;
    process.env.NODE_OPTIONS = `${previous ?? ''} --require ${JSON.stringify(preload.replaceAll('\\', '/'))}`;
    const restore = (): void => { if (previous === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = previous; };
    t.after(restore);
    const stalled = await createUpdateAvailabilityService(root, { automaticEnabled: true, timeoutMs: 20 }).check();
    restore();
    assert.equal(stalled.status, 'unavailable');
    assert.ok(fs.existsSync(marker), 'the real child must reach the held cache lock');
    const childPid = Number(fs.readFileSync(marker, 'utf8'));
    assert.notEqual(childPid, process.pid);
    fs.writeFileSync(path.join(root, '.npmrc'), '# distinct source after the interrupted request\n');
    const recovered = await createUpdateAvailabilityService(root, { automaticEnabled: true }).check({ manual: true });
    assert.equal(recovered.status, 'available', 'the successor recovers the dead process lock and performs its own query');
    assert.throws(() => process.kill(childPid, 0), /ESRCH/);
    assert.equal(fs.existsSync(path.join(path.dirname(cacheFile), 'cache.lock')), false);
});
