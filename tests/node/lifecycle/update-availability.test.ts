import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { createUpdateAvailabilityService, prepareBackgroundUpdateAvailability } from '../../../src/lifecycle/update-availability/update-availability-service';
import { resolveUpdateAvailabilitySource } from '../../../src/lifecycle/update-availability/update-availability-source';
import { buildUpdateCommand, formatUpdateAvailabilityNotice } from '../../../src/lifecycle/update-availability/update-availability-notice';
import { UPDATE_CHECK_TTL_MS } from '../../../src/lifecycle/update-availability/update-availability-types';
import { UPDATE_CACHE_MAX_ENTRIES, updateCachePaths } from '../../../src/lifecycle/update-availability/update-availability-cache';

function fixture(t: TestContext): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-availability-'));
    const bundle = path.join(root, 'garda-agent-orchestrator');
    fs.mkdirSync(bundle);
    fs.writeFileSync(path.join(bundle, 'VERSION'), '1.4.3\n');
    fs.writeFileSync(path.join(bundle, 'package.json'), JSON.stringify({ name: 'garda-agent-orchestrator' }));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return root;
}

const metadata = { version: '1.4.4', integrity: 'sha512-example' };

test('a manual request in another process joins an automatic metadata request', async t => {
    const root = fixture(t);
    let release!: () => void;
    let started!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { started = resolve; });
    const service = createUpdateAvailabilityService(root, { automaticEnabled: true, queryMetadata: async () => {
        started(); await held; return metadata;
    } });
    const first = service.check();
    await ready;
    const code = `const {createUpdateAvailabilityService}=require(process.argv[1]);
const service=createUpdateAvailabilityService(process.argv[2],{automaticEnabled:true,queryMetadata:async()=>{throw Error('must join');}});
const pending=service.check({manual:true});
process.stdout.write('waiting\\n');
pending.then(view=>process.stdout.write(JSON.stringify(view)+'\\n'));`;
    const child = spawn(process.execPath, ['-e', code, require.resolve('../../../src/lifecycle/update-availability/update-availability-service'), root], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let output = '';
    const joined = new Promise<void>((resolve, reject) => {
        child.stdout.on('data', data => { output += String(data); if (output.includes('waiting\n')) resolve(); });
        child.on('error', reject);
    });
    const exited = new Promise<number | null>((resolve, reject) => { child.on('exit', resolve); child.on('error', reject); });
    await joined;
    release();
    assert.equal((await first).status, 'available');
    assert.equal(await exited, 0);
    assert.ok(output.includes('"status":"available"'), output);
});

test('UI and CLI service instances share the daily cache, including failed attempts', async t => {
    const root = fixture(t);
    let now = Date.now();
    let calls = 0;
    const options = { now: () => now, queryMetadata: async () => { calls++; return metadata; }, automaticEnabled: true };
    const cli = createUpdateAvailabilityService(root, options);
    assert.equal((await cli.check()).status, 'available');
    const ui = createUpdateAvailabilityService(root, options);
    assert.equal((await ui.check()).latestVersion, '1.4.4');
    assert.equal(calls, 1);
    now += UPDATE_CHECK_TTL_MS;
    const offline = createUpdateAvailabilityService(root, { ...options, queryMetadata: async () => { calls++; throw new Error('secret registry credential'); } });
    assert.equal((await offline.check()).status, 'unavailable');
    assert.equal((await ui.check()).status, 'unavailable');
    assert.equal(calls, 2);
    assert.doesNotMatch(JSON.stringify(ui.snapshot()), /secret|credential/);
});

test('concurrent automatic and manual callers coalesce across service instances', async t => {
    const root = fixture(t);
    let calls = 0;
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const options = { automaticEnabled: true, queryMetadata: async () => { calls++; await held; return metadata; } };
    const cli = createUpdateAvailabilityService(root, options);
    const ui = createUpdateAvailabilityService(root, options);
    const first = cli.check();
    const second = ui.check({ manual: true });
    release();
    assert.equal((await first).status, 'available');
    assert.equal((await second).status, 'available');
    assert.equal(calls, 1);
    await ui.check({ manual: true });
    assert.equal(calls, 2, 'a subsequent explicit check bypasses the TTL');
});

test('prevents slow metadata queries from holding the shared cache lock', async t => {
    const root = fixture(t);
    let release!: () => void;
    let started!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { started = resolve; });
    const first = createUpdateAvailabilityService(root, { queryMetadata: async () => { started(); await held; return metadata; } }).check();
    await ready;
    try {
        const paths = updateCachePaths(resolveUpdateAvailabilitySource(root));
        assert.equal(fs.existsSync(paths.lock), false, 'no filesystem lock is held across the network await');
        fs.writeFileSync(path.join(root, '.npmrc'), '# independent effective source\n');
        const second = await createUpdateAvailabilityService(root, { queryMetadata: async () => metadata }).check();
        assert.equal(second.status, 'available', 'another source completes while the first query remains pending');
    } finally { release(); await first; }
});

test('rejects a replaced pending attempt before publishing delayed metadata', async t => {
    const root = fixture(t);
    let release!: () => void;
    let started!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { started = resolve; });
    const first = createUpdateAvailabilityService(root, { queryMetadata: async () => { started(); await held; return metadata; } }).check();
    await ready;
    const file = updateCachePaths(resolveUpdateAvailabilitySource(root)).file;
    const envelope = JSON.parse(fs.readFileSync(file, 'utf8'));
    envelope.entries[0].attemptId = '1'.repeat(32);
    envelope.entries[0].outcome = 'unavailable';
    const replacement = JSON.stringify(envelope);
    fs.writeFileSync(file, replacement);
    release();
    await first;
    assert.equal(fs.readFileSync(file, 'utf8'), replacement, 'a completed predecessor must preserve the successor cache entry');
});

test('source and installed-version changes suppress stale notices without rechecking the same source', async t => {
    const root = fixture(t);
    let calls = 0;
    const service = createUpdateAvailabilityService(root, { automaticEnabled: true, queryMetadata: async () => { calls++; return metadata; } });
    await service.check();
    fs.writeFileSync(path.join(root, 'garda-agent-orchestrator', 'VERSION'), '1.4.4');
    assert.equal(service.snapshot().status, 'up_to_date');
    await service.check();
    assert.equal(calls, 1);
    fs.writeFileSync(path.join(root, '.npmrc'), 'registry=https://registry.example.test/\n');
    assert.equal(service.snapshot().status, 'unknown');
    await service.check();
    assert.equal(calls, 2);
    fs.unlinkSync(path.join(root, '.npmrc'));
    await service.check();
    assert.equal(calls, 2, 'returning to a previously checked source preserves its daily throttle');
});

test('timeouts and opt-out do not throw or produce automatic error notices', async t => {
    const root = fixture(t);
    const disabled = createUpdateAvailabilityService(root, { automaticEnabled: false, queryMetadata: async () => metadata });
    assert.equal((await disabled.check()).status, 'disabled');
    assert.equal((await disabled.check({ manual: true })).status, 'available');
    const hung = createUpdateAvailabilityService(root, { automaticEnabled: true, timeoutMs: 25, queryMetadata: () => new Promise(() => {}) });
    assert.equal((await hung.check({ manual: true })).status, 'unavailable');
    assert.equal(formatUpdateAvailabilityNotice(root, hung.snapshot()), '');
});

test('untrusted sources and redirected cache directories fail quietly without writing outside the bundle', async t => {
    const root = fixture(t);
    const bundle = path.join(root, 'garda-agent-orchestrator');
    const outside = path.join(root, 'outside');
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(bundle, 'runtime'), process.platform === 'win32' ? 'junction' : 'dir');
    const service = createUpdateAvailabilityService(root, { automaticEnabled: true, queryMetadata: async () => metadata });
    assert.equal((await service.check()).status, 'unavailable');
    assert.deepEqual(fs.readdirSync(outside), []);
    fs.unlinkSync(path.join(bundle, 'runtime'));
    fs.writeFileSync(path.join(bundle, 'package.json'), JSON.stringify({ name: 'untrusted-update-source' }));
    assert.equal((await service.check()).status, 'unavailable');
});

test('source fingerprints retain transport policy but never expose npmrc credentials', t => {
    const root = fixture(t);
    fs.writeFileSync(path.join(root, '.npmrc'), '//registry.example.test/:_authToken=private-value\n');
    const source = resolveUpdateAvailabilitySource(root);
    assert.equal(source.packageSpec, 'garda-agent-orchestrator@latest');
    assert.equal(source.trustPolicy, 'enforced');
    assert.equal(source.transport.kind, 'npm-cli');
    assert.doesNotMatch(JSON.stringify(source), /private-value/);
});

test('notice stays English and quotes the current target for the existing apply command', t => {
    const root = fixture(t);
    const text = formatUpdateAvailabilityNotice(root, { status: 'available', currentVersion: '1.4.3', latestVersion: '1.4.4', updateCommand: 'garda check-update --target-root "example" --apply' });
    assert.equal(text, 'Garda update available: 1.4.3 → 1.4.4\n' + buildUpdateCommand(root));
});

test('mixed-case PATH changes invalidate transport metadata and preserve the old source daily throttle', async t => {
    const root = fixture(t);
    const envKey = Object.keys(process.env).find(key => key.toLowerCase() === 'path') ?? 'Path';
    const previous = process.env[envKey];
    t.after(() => { if (previous === undefined) delete process.env[envKey]; else process.env[envKey] = previous; });
    let calls = 0;
    const service = createUpdateAvailabilityService(root, { automaticEnabled: true, queryMetadata: async () => { calls++; return metadata; } });
    const first = resolveUpdateAvailabilitySource(root).fingerprint;
    await service.check();
    process.env[envKey] = `${previous ?? ''}${path.delimiter}${path.join(root, 'different-npm-bin')}`;
    assert.notEqual(resolveUpdateAvailabilitySource(root).fingerprint, first);
    assert.equal(service.snapshot().status, 'unknown');
    await service.check();
    if (previous === undefined) delete process.env[envKey]; else process.env[envKey] = previous;
    await service.check();
    assert.equal(calls, 2);
});

test('bounded cache eviction preserves daily automatic throttling while manual refresh remains available', async t => {
    const root = fixture(t);
    const config = path.join(root, '.npmrc');
    let now = Date.now();
    let calls = 0;
    const service = createUpdateAvailabilityService(root, { now: () => now, automaticEnabled: true, queryMetadata: async () => { calls++; return metadata; } });
    for (let index = 0; index <= UPDATE_CACHE_MAX_ENTRIES; index++) {
        fs.writeFileSync(config, `registry=https://registry-${index}.example.test/\n`);
        assert.equal((await service.check()).status, 'available');
        now++;
    }
    const cachePath = updateCachePaths(resolveUpdateAvailabilitySource(root)).file;
    const stored = JSON.parse(fs.readFileSync(cachePath, 'utf8')) as { entries: unknown[] };
    assert.equal(stored.entries.length, UPDATE_CACHE_MAX_ENTRIES);
    assert.deepEqual(fs.readdirSync(path.dirname(cachePath)), ['cache.json']);
    fs.writeFileSync(config, 'registry=https://registry-0.example.test/\n');
    assert.equal((await service.check()).status, 'unavailable');
    assert.equal(calls, UPDATE_CACHE_MAX_ENTRIES + 1, 'an evicted fresh source is still throttled');
    assert.equal((await service.check({ manual: true })).status, 'available');
    assert.equal(calls, UPDATE_CACHE_MAX_ENTRIES + 2);
    now += UPDATE_CHECK_TTL_MS;
    await service.check();
    assert.equal(calls, UPDATE_CACHE_MAX_ENTRIES + 3);
    assert.equal((JSON.parse(fs.readFileSync(cachePath, 'utf8')) as { entries: unknown[] }).entries.length, 1);
});

test('configuration changes during a request discard its metadata instead of reviving a stale notice', async t => {
    const root = fixture(t);
    let calls = 0;
    const config = path.join(root, '.npmrc');
    const service = createUpdateAvailabilityService(root, { automaticEnabled: true, queryMetadata: async () => {
        calls++; fs.writeFileSync(config, 'registry=https://changed.example.test/\n'); return metadata;
    } });
    assert.equal((await service.check()).status, 'unknown');
    fs.unlinkSync(config);
    assert.equal(service.snapshot().status, 'unavailable');
    await service.check();
    assert.equal(calls, 1);
    assert.equal(formatUpdateAvailabilityNotice(root, service.snapshot()), '');
});

test('waiting for a pending launch uses bounded cache polling without rediscovering npm configuration', async t => {
    const root = fixture(t);
    const previous = process.env.GARDA_UPDATE_CHECK;
    process.env.GARDA_UPDATE_CHECK = '1';
    t.after(() => { if (previous === undefined) delete process.env.GARDA_UPDATE_CHECK; else process.env.GARDA_UPDATE_CHECK = previous; });
    assert.ok((await prepareBackgroundUpdateAvailability(root)).claim);
    const cachePath = updateCachePaths(resolveUpdateAvailabilitySource(root)).file;
    const nativeFs = require('node:fs') as typeof fs;
    const originalStat = nativeFs.statSync;
    const originalRead = nativeFs.readFileSync;
    let configurationProbes = 0;
    let cacheReads = 0;
    t.mock.method(nativeFs, 'statSync', (...args: Parameters<typeof fs.statSync>) => {
        if (String(args[0]) === path.join(root, '.npmrc')) configurationProbes++;
        return originalStat(...args);
    });
    t.mock.method(nativeFs, 'readFileSync', (...args: Parameters<typeof fs.readFileSync>) => {
        if (String(args[0]) === cachePath) cacheReads++;
        return originalRead(...args);
    });
    const service = createUpdateAvailabilityService(root, {
        automaticEnabled: true, timeoutMs: 500,
        queryMetadata: async () => { assert.fail('an existing pending claim must not start another query'); }
    });
    assert.equal((await service.check()).status, 'unavailable');
    assert.ok(configurationProbes <= 2, `configuration was probed ${configurationProbes} times`);
    assert.ok(cacheReads <= 12, `cache was read ${cacheReads} times during the bounded wait`);
});

test('legacy cache writes use only the current fingerprint without scanning unrelated entries', async t => {
    const root = fixture(t);
    const service = createUpdateAvailabilityService(root, { automaticEnabled: true, queryMetadata: async () => metadata });
    await service.check();
    const source = resolveUpdateAvailabilitySource(root);
    const paths = updateCachePaths(source);
    const entry = (JSON.parse(fs.readFileSync(paths.file, 'utf8')) as { entries: unknown[] }).entries[0];
    const currentLegacy = path.join(paths.directory, `${source.fingerprint}.json`);
    fs.writeFileSync(currentLegacy, JSON.stringify(entry));
    fs.unlinkSync(paths.file);
    const unrelated = Array.from({ length: 64 }, (_, index) => path.join(paths.directory, `${index.toString(16).padStart(64, '0')}.json`));
    for (const file of unrelated) fs.writeFileSync(file, 'invalid legacy-shaped cache');
    const nativeFs = require('node:fs') as typeof fs;
    const originalRead = nativeFs.readFileSync;
    const originalList = nativeFs.readdirSync;
    let unrelatedReads = 0;
    t.mock.method(nativeFs, 'readdirSync', (...args: Parameters<typeof fs.readdirSync>) => {
        assert.notEqual(String(args[0]), paths.directory, 'cache writes must not enumerate the feature directory');
        return originalList(...args);
    });
    t.mock.method(nativeFs, 'readFileSync', (...args: Parameters<typeof fs.readFileSync>) => {
        if (unrelated.includes(String(args[0]))) unrelatedReads++;
        return originalRead(...args);
    });
    assert.equal((await service.check()).status, 'available', 'legacy metadata retains its daily throttle');
    assert.equal((await service.check({ manual: true })).status, 'available');
    assert.equal(fs.existsSync(currentLegacy), false);
    assert.equal(unrelatedReads, 0);
    assert.ok(unrelated.every(file => fs.existsSync(file)), 'unrelated and malformed legacy files are preserved');
    assert.equal((JSON.parse(fs.readFileSync(paths.file, 'utf8')) as { entries: unknown[] }).entries.length, 1);
});
