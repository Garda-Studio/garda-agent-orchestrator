import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';

import {
    captureRuntimeMutationOwnerIdentity,
    createRuntimeMutationOwnerProbe,
    parseRuntimeMutationOwnerIdentity,
    type RuntimeMutationOwnerIdentity
} from '../../../src/gate-runtime/runtime-mutation-owner';

const mutableFs = require('node:fs') as typeof fs;
const mutableOs = require('node:os') as typeof os;
const fixtureOwner: RuntimeMutationOwnerIdentity = {
    scheme: 'linux-proc-v1', hostname: 'journal-host',
    boot_id: '11111111-2222-3333-4444-555555555555',
    pid_namespace: 'pid:[12345]', pid: 424242, start_time_ticks: '9000', time_namespace: 'time:[24680]'
};

function procStat(pid: number, startTicks: string): string {
    const fields = Array<string>(20).fill('0');
    fields[0] = 'S'; fields[19] = startTicks;
    return `${pid} (node (worker) name)) ${fields.join(' ')}\n`;
}

function mockProc(t: TestContext, options: {
    targetTicks?: string; targetNamespace?: string; readError?: string; killError?: string;
    selfPid?: number; selfTicks?: string; numericSelfTicks?: string; malformedTarget?: boolean;
    localBoot?: string;
    localTimeNamespace?: string;
    timeNamespaceError?: string;
} = {}): void {
    const originalRead = mutableFs.readFileSync;
    const originalLink = mutableFs.readlinkSync;
    const originalKill = process.kill;
    t.mock.method(mutableOs, 'hostname', () => fixtureOwner.hostname);
    t.mock.method(mutableFs, 'readFileSync', (target: fs.PathOrFileDescriptor, encoding: unknown) => {
        if (target === '/proc/self/stat') return procStat(options.selfPid ?? process.pid, options.selfTicks ?? '8000');
        if (target === `/proc/${process.pid}/stat`) return procStat(process.pid, options.numericSelfTicks ?? options.selfTicks ?? '8000');
        if (target === '/proc/sys/kernel/random/boot_id') return `${options.localBoot ?? fixtureOwner.boot_id}\n`;
        if (target === `/proc/${fixtureOwner.pid}/stat`) {
            if (options.readError) throw Object.assign(new Error('fixture proc read failed'), { code: options.readError });
            return options.malformedTarget ? procStat(999, '9000') : procStat(fixtureOwner.pid, options.targetTicks ?? '9000');
        }
        return Reflect.apply(originalRead, mutableFs, [target, encoding]);
    });
    t.mock.method(mutableFs, 'readlinkSync', (target: fs.PathLike, optionsArg: unknown) => {
        if (target === '/proc/self/ns/time' || target === `/proc/${process.pid}/ns/time`) {
            if (options.timeNamespaceError) throw Object.assign(new Error('fixture time namespace unavailable'), { code: options.timeNamespaceError });
            return options.localTimeNamespace ?? 'time:[24680]';
        }
        if (target === '/proc/self/ns/pid' || target === `/proc/${process.pid}/ns/pid`) return fixtureOwner.pid_namespace;
        if (target === `/proc/${fixtureOwner.pid}/ns/pid`) return options.targetNamespace ?? fixtureOwner.pid_namespace;
        return Reflect.apply(originalLink, mutableFs, [target, optionsArg]);
    });
    t.mock.method(process, 'kill', (pid: number, signal?: NodeJS.Signals | number) => {
        if (pid === fixtureOwner.pid) {
            if (options.killError) throw Object.assign(new Error('fixture liveness failed'), { code: options.killError });
            return true;
        }
        return originalKill(pid, signal);
    });
}

test('mutation owner capture binds real Linux PID, boot, namespace and start generation', { skip: process.platform !== 'linux' }, () => {
    const owner = captureRuntimeMutationOwnerIdentity();
    assert.ok(owner, 'available Linux proc identity must be captured');
    assert.equal(owner.pid, process.pid);
    assert.equal(createRuntimeMutationOwnerProbe()(owner), owner.time_namespace ? 'live' : 'unknown');
    assert.deepEqual(parseRuntimeMutationOwnerIdentity(owner), owner);
});

test('mutation owner probe rejects death across differing observer time namespaces', { skip: process.platform !== 'linux' }, (t) => {
    mockProc(t, { targetTicks: '9001', localTimeNamespace: 'time:[24681]' });
    const owner = { ...fixtureOwner, time_namespace: 'time:[24680]' };
    assert.equal(createRuntimeMutationOwnerProbe()(owner), 'unknown', 'clock offset differences must preserve the live owner');
});

test('mutation owner probe preserves unknown clock scope while retaining absent-PID proof', { skip: process.platform !== 'linux' }, (t) => {
    mockProc(t, { targetTicks: '9001', timeNamespaceError: 'ENOENT' });
    assert.equal(captureRuntimeMutationOwnerIdentity()?.time_namespace, null);
    assert.equal(createRuntimeMutationOwnerProbe()(fixtureOwner), 'unknown');
    t.mock.method(process, 'kill', () => { throw Object.assign(new Error('fixture absent PID'), { code: 'ESRCH' }); });
    assert.equal(createRuntimeMutationOwnerProbe()(fixtureOwner), 'dead');
});

test('mutation owner probe rejects generation proof from legacy or null clock binding', { skip: process.platform !== 'linux' }, (t) => {
    mockProc(t, { targetTicks: '9001' });
    const { time_namespace: ignored, ...legacy } = fixtureOwner;
    assert.equal(createRuntimeMutationOwnerProbe()(legacy), 'unknown');
    assert.equal(createRuntimeMutationOwnerProbe()({ ...fixtureOwner, time_namespace: null }), 'unknown');
    assert.deepEqual(parseRuntimeMutationOwnerIdentity(legacy), legacy, 'legacy hash input remains unchanged');
});

test('mutation owner capture parses parenthesized comm and rejects incompatible numeric PID views', { skip: process.platform !== 'linux' }, (t) => {
    mockProc(t, { numericSelfTicks: '8001' });
    assert.equal(captureRuntimeMutationOwnerIdentity(), null);
});

test('mutation owner capture rejects a proc self PID from a different namespace view', { skip: process.platform !== 'linux' }, (t) => {
    mockProc(t, { selfPid: process.pid + 1 });
    assert.equal(captureRuntimeMutationOwnerIdentity(), null);
});

for (const [name, options, expected] of [
    ['matching live generation', {}, 'live'],
    ['reused live PID with different generation', { targetTicks: '9001' }, 'dead'],
    ['absent PID proven by ESRCH', { killError: 'ESRCH', readError: 'ENOENT' }, 'dead'],
    ['permission-denied process identity', { readError: 'EACCES', killError: 'EPERM' }, 'unknown'],
    ['failed liveness probe', { killError: 'EIO' }, 'unknown'],
    ['different target PID namespace', { targetNamespace: 'pid:[67890]' }, 'unknown'],
    ['malformed process identity', { malformedTarget: true }, 'unknown']
] as const) {
    test(`mutation owner probe preserves proof boundaries: ${name}`, { skip: process.platform !== 'linux' }, (t) => {
        mockProc(t, options);
        assert.equal(createRuntimeMutationOwnerProbe()(fixtureOwner), expected);
    });
}

test('mutation owner probe rejects death from a hidden live PID', { skip: process.platform !== 'linux' }, (t) => {
    mockProc(t, { readError: 'ENOENT' });
    assert.equal(createRuntimeMutationOwnerProbe()(fixtureOwner), 'unknown');
});

test('mutation owner probe preserves foreign host, boot, namespace and absent identity', { skip: process.platform !== 'linux' }, (t) => {
    mockProc(t, { killError: 'ESRCH' });
    const probe = createRuntimeMutationOwnerProbe();
    assert.equal(probe(null), 'unknown');
    assert.equal(probe({ ...fixtureOwner, hostname: 'foreign-host' }), 'unknown');
    assert.equal(probe({ ...fixtureOwner, boot_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' }), 'unknown');
    assert.equal(probe({ ...fixtureOwner, pid_namespace: 'pid:[67890]' }), 'unknown');
});

test('mutation owner capture is conservative on unsupported platforms', () => {
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
    try {
        Object.defineProperty(process, 'platform', { ...descriptor, value: 'win32' });
        assert.equal(captureRuntimeMutationOwnerIdentity(), null);
        assert.equal(createRuntimeMutationOwnerProbe()(fixtureOwner), 'unknown');
    } finally {
        Object.defineProperty(process, 'platform', descriptor);
    }
});

test('mutation owner parser rejects malformed or extended identity without defaulting to death', () => {
    assert.equal(parseRuntimeMutationOwnerIdentity(null), null);
    for (const owner of [
        undefined, [], {},
        { ...fixtureOwner, pid: -1 }, { ...fixtureOwner, pid: 1.5 },
        { ...fixtureOwner, start_time_ticks: '0' }, { ...fixtureOwner, start_time_ticks: 'NaN' },
        { ...fixtureOwner, boot_id: 'unknown' }, { ...fixtureOwner, pid_namespace: 'unknown' },
        { ...fixtureOwner, hostname: '' }, { ...fixtureOwner, scheme: 'pid-only' },
        { ...fixtureOwner, extra: true }, { ...fixtureOwner, time_namespace: 'unknown' }
    ]) assert.throws(() => parseRuntimeMutationOwnerIdentity(owner), /identity/);
});
