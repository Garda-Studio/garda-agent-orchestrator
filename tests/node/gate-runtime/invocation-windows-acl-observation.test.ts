import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getWindowsSystemDirectory } from '../../../src/core/windows-native-environment';
import { assertInvocationDependenciesCurrent, withInvocationReadObservation } from '../../../src/core/invocation-read-observation';
import { withNextStepMeasurement, type NextStepMeasurement } from '../../../src/core/next-step-measurement';
import { inspectTrustedWindowsWriteAuthority } from '../../../src/gate-runtime/timeline/windows-acl-authority';
import { readTaskTimelineTextFile } from '../../../src/gate-runtime/timeline/task-events';

const windowsOnly = { skip: process.platform !== 'win32' ? 'Native Windows ACL checks require Windows.' : false };

function icacls(args: string[]): void {
    const result = childProcess.spawnSync(path.join(getWindowsSystemDirectory(), 'icacls.exe'), args,
        { encoding: 'utf8', windowsHide: true, timeout: 5_000 });
    assert.equal(result.status, 0, String(result.stderr || result.stdout || result.error));
}

function fixture(t: TestContext): { eventsRoot: string; file: string } {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'garda-invocation-acl-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const eventsRoot = path.join(root, 'runtime', 'task-events'), file = path.join(eventsRoot, 'T-ACL-OBSERVATION.jsonl');
    fs.mkdirSync(eventsRoot, { recursive: true }); fs.writeFileSync(file, '{}\n');
    const whoami = childProcess.spawnSync(path.join(getWindowsSystemDirectory(), 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'],
        { encoding: 'utf8', windowsHide: true, timeout: 5_000 });
    assert.equal(whoami.status, 0, String(whoami.stderr || whoami.error));
    const userSid = String(whoami.stdout).trim().match(/"(S-1-[0-9-]+)"$/u)?.[1];
    assert.ok(userSid);
    for (const [target, rights] of [[eventsRoot, '(OI)(CI)(F)'], [file, '(F)']]) {
        icacls([target, '/inheritance:r', '/grant:r', ...[...new Set(['S-1-5-18', 'S-1-5-32-544', userSid])].map(sid => '*' + sid + ':' + rights)]);
    }
    return { eventsRoot, file };
}

test('native ACL observations probe file and directory once initially and once finally despite warm legacy cache', windowsOnly, t => {
    const { eventsRoot, file } = fixture(t);
    assert.equal(readTaskTimelineTextFile(file), '{}\n');
    let measurement: NextStepMeasurement | undefined;
    withNextStepMeasurement(() => withInvocationReadObservation(() => {
        for (let index = 0; index < 4; index += 1) assert.equal(readTaskTimelineTextFile(file), '{}\n');
    }), value => { measurement = value; });
    for (const target of [eventsRoot, file]) {
        assert.equal(measurement?.work['acl_probe:initial:' + target], 1);
        assert.equal(measurement?.work['acl_probe:final:' + target], 1);
    }
    const icaclsCalls = Object.entries(measurement!.work)
        .filter(([key]) => key.startsWith('process:') && key.includes(':icacls.exe:'))
        .reduce((total, [, count]) => total + count, 0);
    assert.equal(icaclsCalls, 4);
    assert.equal(readTaskTimelineTextFile(file), '{}\n');
});

test('native untrusted file under trusted directory is rejected without an append even after legacy cache warmup', windowsOnly, t => {
    const { eventsRoot, file } = fixture(t), bytes = fs.readFileSync(file);
    assert.equal(readTaskTimelineTextFile(file), bytes.toString());
    icacls([file, '/grant', '*S-1-1-0:(W)']);
    try {
        assert.throws(() => withInvocationReadObservation(() => {
            assert.equal(inspectTrustedWindowsWriteAuthority(eventsRoot), true);
            assert.equal(inspectTrustedWindowsWriteAuthority(file), false);
            readTaskTimelineTextFile(file);
        }), /snapshot is unavailable/);
        assert.deepEqual(fs.readFileSync(file), bytes);
    } finally { icacls([file, '/remove:g', '*S-1-1-0']); }
    assert.equal(withInvocationReadObservation(() => readTaskTimelineTextFile(file)), bytes.toString());
});

test('native ACL-only changes to either object invalidate output even when the write-authority verdict stays trusted', windowsOnly, t => {
    const { eventsRoot, file } = fixture(t), bytes = fs.readFileSync(file), before = fs.statSync(file);
    for (const target of [eventsRoot, file]) {
        try {
            assert.throws(() => withInvocationReadObservation(() => {
                assert.equal(readTaskTimelineTextFile(file), bytes.toString());
                icacls([target, '/grant', '*S-1-1-0:(R)']);
                assert.equal(inspectTrustedWindowsWriteAuthority(target), true);
            }), /Invocation Windows ACL observation changed/);
            assert.equal(inspectTrustedWindowsWriteAuthority(target), true);
            assert.deepEqual(fs.readFileSync(file), bytes);
            assert.equal(fs.statSync(file).mtimeMs, before.mtimeMs);
            assert.equal(fs.statSync(file).size, before.size);
        } finally { icacls([target, '/remove:g', '*S-1-1-0']); }
        assert.equal(withInvocationReadObservation(() => readTaskTimelineTextFile(file)), bytes.toString());
    }
});

test('native caught ACL mutation remains sticky after restoring permissions and leaves the next invocation usable', windowsOnly, t => {
    const { file } = fixture(t), bytes = fs.readFileSync(file);
    let observed: unknown;
    try {
        assert.throws(() => withInvocationReadObservation(() => {
            assert.equal(readTaskTimelineTextFile(file), bytes.toString());
            icacls([file, '/grant', '*S-1-1-0:(W)']);
            try { assertInvocationDependenciesCurrent(); }
            catch (error: unknown) { observed = error; }
            assert.ok(observed instanceof Error);
            icacls([file, '/remove:g', '*S-1-1-0']);
        }), error => error === observed);
    } finally { icacls([file, '/remove:g', '*S-1-1-0']); }
    assert.deepEqual(fs.readFileSync(file), bytes);
    assert.equal(withInvocationReadObservation(() => readTaskTimelineTextFile(file)), bytes.toString());
});

test('SID fallback compares full descriptor evidence when raw output and the trusted verdict are unchanged', windowsOnly, t => {
    const { file } = fixture(t);
    // Warm native principal lookup before installing the narrow process fixture.
    assert.equal(inspectTrustedWindowsWriteAuthority(file), true);
    const native = require('node:child_process') as typeof childProcess;
    const original = native.spawnSync;
    let descriptors = 0;
    try {
        native.spawnSync = ((command: string, args: readonly string[] = [], options?: childProcess.SpawnSyncOptions) => {
            if (path.basename(command).toLowerCase() === 'icacls.exe' && args.length === 1 && args[0] === file) {
                const stdout = Buffer.from(file + ' GARDA_UNKNOWN_ACCOUNT:(W)\r\n');
                return { pid: 0, status: 0, signal: null, stdout, stderr: Buffer.alloc(0), output: [null, stdout, Buffer.alloc(0)] };
            }
            if (path.basename(command).toLowerCase() === 'powershell.exe' && options?.env?.GARDA_ACL_TARGET === file) {
                const script = Buffer.from(String(args.at(-1)), 'base64').toString('utf16le');
                assert.ok(script.includes('descriptor = $acl.Sddl'));
                const stdout = JSON.stringify({ trusted: true, descriptor: ++descriptors === 1 ? 'O:SYG:SYD:(A;;FA;;;SY)' : 'O:SYG:SYD:(A;;FR;;;SY)' });
                return { pid: 0, status: 0, signal: null, stdout, stderr: '', output: [null, stdout, ''] };
            }
            return original(command, args, options);
        }) as typeof childProcess.spawnSync;
        assert.throws(() => withInvocationReadObservation(() => {
            assert.equal(inspectTrustedWindowsWriteAuthority(file), true);
            assert.equal(inspectTrustedWindowsWriteAuthority(file), true);
        }), /Invocation Windows ACL observation changed/);
        assert.equal(descriptors, 2);
    } finally { native.spawnSync = original; }
});


test('active ACL observation preserves unchanged indeterminate rejection but rejects later valid evidence', windowsOnly, t => {
    const { file } = fixture(t);
    const native = require('node:child_process') as typeof childProcess;
    const original = native.spawnSync;
    try {
        for (const becomesValid of [false, true]) {
            let attempts = 0;
            native.spawnSync = ((command: string, args: readonly string[] = [], options?: childProcess.SpawnSyncOptions) => {
                if (path.basename(command).toLowerCase() !== 'icacls.exe' || args.length !== 1) return original(command, args, options);
                attempts += 1;
                if (becomesValid && attempts > 2) {
                    const stdout = Buffer.from(String(args[0]) + ' BUILTIN\\Administrators:(I)(F)\r\n');
                    return { pid: 0, status: 0, signal: null, stdout, stderr: Buffer.alloc(0), output: [null, stdout, Buffer.alloc(0)] };
                }
                return { pid: 0, status: null, signal: 'SIGTERM', stdout: Buffer.alloc(0), stderr: Buffer.alloc(0),
                    output: [null, Buffer.alloc(0), Buffer.alloc(0)],
                    error: Object.assign(new Error('spawnSync icacls.exe ETIMEDOUT'), { code: 'ETIMEDOUT' }) };
            }) as typeof childProcess.spawnSync;
            const action = () => withInvocationReadObservation(() => {
                assert.equal(inspectTrustedWindowsWriteAuthority(file), false);
                assert.equal(inspectTrustedWindowsWriteAuthority(file), false);
                return 'BLOCKED';
            });
            if (becomesValid) assert.throws(action, /Invocation Windows ACL observation changed/);
            else assert.equal(action(), 'BLOCKED');
            assert.equal(attempts, becomesValid ? 3 : 4);
        }
    } finally { native.spawnSync = original; }
});
