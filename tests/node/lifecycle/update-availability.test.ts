import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { createUpdateAvailabilityService } from '../../../src/lifecycle/update-availability/update-availability-service';
import { resolveUpdateAvailabilitySource } from '../../../src/lifecycle/update-availability/update-availability-source';
import { buildUpdateCommand, formatUpdateAvailabilityNotice } from '../../../src/lifecycle/update-availability/update-availability-notice';
import { UPDATE_CHECK_TTL_MS } from '../../../src/lifecycle/update-availability/update-availability-types';

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
