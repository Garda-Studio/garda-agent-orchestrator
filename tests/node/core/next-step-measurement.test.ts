import test from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { appendTaskEvent, readTaskTimelineBoundedJsonlTail, withTaskTimelineReadSnapshot } from '../../../src/gate-runtime/task-events';
import { readOrderedTaskEvents } from '../../../src/gates/task-audit/task-audit-summary-lifecycle';
import { reviewCorrectionWasSuperseded } from '../../../src/gates/next-step/next-step-review-correction-supersession';
import { countNextStepArrayCopy, withNextStepMeasurement, type NextStepMeasurement } from '../../../src/core/next-step-measurement';

test('measurement counts actual direct and helper process boundaries and restores native functions', () => {
    const native = require('node:child_process') as typeof import('node:child_process');
    const original = { spawnSync: native.spawnSync, execFileSync: native.execFileSync, execSync: native.execSync };
    let result: NextStepMeasurement | undefined;
    withNextStepMeasurement(() => {
        for (let i = 0; i < 2; i += 1) {
            const child = native.spawnSync(process.execPath, ['--version'], { encoding: 'utf8' });
            assert.equal(child.status, 0); assert.equal(child.stdout.trim(), process.version);
        }
        assert.equal(native.spawnSync(process.execPath, ['--version'], { cwd: os.tmpdir(), encoding: 'utf8' }).status, 0);
        assert.equal(native.execFileSync(process.execPath, ['--version'], { encoding: 'utf8' }).trim(), process.version);
        withNextStepMeasurement(() => assert.equal(native.execFileSync(process.execPath, ['--version'], { encoding: 'utf8' }).trim(), process.version));
    }, value => { result = value; });
    const counts = Object.entries(result!.work).filter(([key]) => key.startsWith('process:')).map(([, count]) => count).sort();
    assert.deepEqual(counts, [1, 2, 2]);
    assert.equal(result!.work.process_measurement_unavailable, undefined);
    for (const name of ['spawnSync', 'execFileSync', 'execSync'] as const) assert.equal(native[name], original[name]);
    const failure = new Error('original action failure');
    assert.throws(() => withNextStepMeasurement(() => { throw failure; }, () => { throw new Error('receiver failure'); }), error => error === failure);
    for (const name of ['spawnSync', 'execFileSync', 'execSync'] as const) assert.equal(native[name], original[name]);
});


test('process diagnostics do not invoke environment accessors or serialization hooks', () => {
    const native = require('node:child_process') as typeof import('node:child_process');
    const run = (measured: boolean) => {
        let reads = 0, serializations = 0;
        const env = { ...process.env };
        Object.defineProperty(env, 'GARDA_MEASUREMENT_GETTER', {
            enumerable: true, get: () => String(++reads)
        });
        const options = { env, encoding: 'utf8' as const };
        Object.defineProperty(options, 'toJSON', { value: () => { serializations += 1; throw new Error('must not serialize caller objects'); } });
        const action = () => native.execFileSync(process.execPath,
            ['-e', 'process.stdout.write(process.env.GARDA_MEASUREMENT_GETTER)'], options);
        const output = measured ? withNextStepMeasurement(action, () => {}) : action();
        return { output, reads, serializations };
    };
    assert.deepEqual(run(true), run(false));
    assert.deepEqual(run(true), { output: '1', reads: 1, serializations: 0 });
});

test('process diagnostics leave proxy traps and argument toJSON hooks untouched', () => {
    const native = require('node:child_process') as typeof import('node:child_process');
    const run = (measured: boolean) => {
        let traps = 0, serializations = 0;
        const env = new Proxy({ ...process.env }, {
            ownKeys(target) { traps += 1; return Reflect.ownKeys(target); },
            getOwnPropertyDescriptor(target, key) { traps += 1; return Reflect.getOwnPropertyDescriptor(target, key); },
            get(target, key, receiver) { traps += 1; return Reflect.get(target, key, receiver); }
        });
        const args = ['--version'];
        Object.defineProperty(args, 'toJSON', { value: () => { serializations += 1; return []; } });
        const action = () => native.execFileSync(process.execPath, args, { env, encoding: 'utf8' });
        const output = measured ? withNextStepMeasurement(action, () => {}) : action();
        return { output, traps, serializations };
    };
    assert.deepEqual(run(true), run(false));
});


test('process counters distinguish enumerable environment inputs', () => {
    const native = require('node:child_process') as typeof import('node:child_process');
    let measurement: NextStepMeasurement | undefined;
    withNextStepMeasurement(() => {
        for (const enumerable of [false, true]) {
            const env = { ...process.env };
            Object.defineProperty(env, 'GARDA_MEASUREMENT_ENUMERABLE', { value: 'visible', enumerable });
            const result = native.execFileSync(process.execPath,
                ['-e', 'process.stdout.write(process.env.GARDA_MEASUREMENT_ENUMERABLE || "absent")'], { env, encoding: 'utf8' });
            assert.equal(result, enumerable ? 'visible' : 'absent');
        }
    }, value => { measurement = value; });
    const calls = Object.entries(measurement!.work).filter(([key]) => key.startsWith('process:'));
    assert.equal(calls.length, 2);
    assert.ok(calls.every(([, count]) => count === 1));
});

test('payload diagnostics count real reads and parses without changing caller hooks and restore on throws', () => {
    const fs = require('node:fs') as typeof import('node:fs');
    const path = require('node:path') as typeof import('node:path');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-measurement-'));
    const file = path.join(root, 'input.json');
    fs.writeFileSync(file, '{"value":1}');
    const originals = { readFileSync: fs.readFileSync, openSync: fs.openSync, readSync: fs.readSync, closeSync: fs.closeSync, parse: JSON.parse };
    const run = () => {
        let getterCalls = 0, reviverCalls = 0, coercions = 0;
        const options = { get encoding() { getterCalls += 1; return 'utf8' as const; } };
        const result = fs.readFileSync(file, options);
        const parsed = JSON.parse({ toString() { coercions += 1; return result; } } as unknown as string,
            (_key, value: unknown) => { reviverCalls += 1; return value; });
        const fd = fs.openSync(file, 'r');
        try {
            const buffer = Buffer.alloc(20);
            fs.readSync(fd, buffer, 0, 3, null); fs.readSync(fd, buffer, 3, 8, null);
        } finally { fs.closeSync(fd); }
        return { getterCalls, reviverCalls, coercions, parsed };
    };
    try {
        const plain = run();
        let measurement: NextStepMeasurement | undefined;
        assert.deepEqual(withNextStepMeasurement(run, value => { measurement = value; }), plain);
        assert.equal(measurement?.work['payload_read:' + file], 2);
        assert.equal(measurement?.work.json_parse_total, 1);
        let emptyMeasurement: NextStepMeasurement | undefined;
        fs.writeFileSync(file, '');
        withNextStepMeasurement(() => {
            const fd = fs.openSync(file, 'r');
            try { fs.readSync(fd, Buffer.alloc(1), 0, 1, null); fs.readSync(fd, Buffer.alloc(1), 0, 1, null); }
            finally { fs.closeSync(fd); }
        }, value => { emptyMeasurement = value; });
        assert.equal(emptyMeasurement?.work['payload_read:' + file], 1);
        const failure = new Error('reviver failed');
        assert.throws(() => withNextStepMeasurement(() => JSON.parse('{}', () => { throw failure; }), () => {}), error => error === failure);
        for (const key of ['readFileSync', 'openSync', 'readSync', 'closeSync'] as const) assert.equal(fs[key], originals[key]);
        assert.equal(JSON.parse, originals.parse);
    } finally { fs.unlinkSync(file); fs.rmdirSync(root); }
});


test('array-copy diagnostics preserve values, accessors, proxy traps and revoked proxies', () => {
    const run = (measured: boolean) => {
        let reads = 0, traps = 0, serializations = 0;
        const source = [1, 2, 3];
        Object.defineProperty(source, '1', { get() { reads += 1; return 2; }, enumerable: true });
        Object.defineProperty(source, 'toJSON', { value() { serializations += 1; return []; } });
        const proxy = new Proxy(source, {
            get(target, key, receiver) { traps += 1; return Reflect.get(target, key, receiver); },
            getOwnPropertyDescriptor(target, key) { traps += 1; return Reflect.getOwnPropertyDescriptor(target, key); }
        });
        let measurement: NextStepMeasurement | undefined;
        const action = () => {
            const copy = countNextStepArrayCopy('array_copy', [...proxy]);
            assert.deepEqual(copy, [1, 2, 3]);
            assert.equal(countNextStepArrayCopy('opaque_array_copy', proxy), proxy);
            const revoked = Proxy.revocable(source, {});
            revoked.revoke();
            assert.equal(countNextStepArrayCopy('revoked_array_copy', revoked.proxy), revoked.proxy);
            return copy;
        };
        const value = measured ? withNextStepMeasurement(action, result => { measurement = result; }) : action();
        return { value, reads, traps, serializations, measurement };
    };
    const { measurement, ...observed } = run(true);
    const { measurement: unmeasured, ...plain } = run(false);
    assert.equal(unmeasured, undefined);
    assert.deepEqual(observed, plain);
    assert.equal(measurement?.work.array_copy, 3);
    assert.equal(measurement?.work.array_copy_measurement_opaque, 2);
    assert.equal(measurement?.work.opaque_array_copy, undefined);
    assert.equal(measurement?.work.revoked_array_copy, undefined);
});

test('cached timeline consumers count every copied event while preserving their independent results', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-measurement-timeline-'));
    const taskId = 'T-MEASUREMENT-COPY';
    try {
        for (let index = 0; index < 3; index += 1) {
            const event = appendTaskEvent(root, taskId, 'TEST_EVENT', 'PASS', 'Measurement event', { index },
                { passThru: true, lowNoiseRuntimeWrites: true });
            assert.equal(event?.commit_status, 'committed');
        }
        const eventsRoot = path.join(root, 'runtime', 'task-events');
        const timelinePath = path.join(eventsRoot, taskId + '.jsonl');
        const correctionPath = path.join(root, 'correction.md');
        fs.writeFileSync(correctionPath, 'Unreferenced correction package');
        let measurement: NextStepMeasurement | undefined;
        withNextStepMeasurement(() => withTaskTimelineReadSnapshot(eventsRoot, taskId, () => {
            const first = readOrderedTaskEvents(timelinePath);
            const second = readOrderedTaskEvents(timelinePath);
            assert.deepEqual(first, second);
            assert.notEqual(first.events, second.events);
            first.events.pop();
            assert.equal(second.events.length, 3);
            const limits = { maxBytes: 1024 * 1024, maxLines: 100, maxEvents: 100, maxParseAttempts: 100 };
            const firstTail = readTaskTimelineBoundedJsonlTail(timelinePath, limits);
            const secondTail = readTaskTimelineBoundedJsonlTail(timelinePath, limits);
            assert.deepEqual(firstTail, secondTail);
            assert.notEqual(firstTail.records[0], secondTail.records[0]);
            firstTail.records.pop();
            assert.equal(secondTail.records.length, 3);
            assert.equal(reviewCorrectionWasSuperseded(eventsRoot, taskId, 'code', correctionPath), false);
            assert.equal(reviewCorrectionWasSuperseded(eventsRoot, taskId, 'code', correctionPath), false);
        }), value => { measurement = value; });
        assert.equal(measurement?.work['visit:audit_ordered_event_copy'], 6);
        const lifecycleCopies = Object.entries(measurement!.work)
            .filter(([key]) => key === 'visit:audit_ordered_event_copy' || key.startsWith('visit:task-audit-summary-lifecycle:copy:'))
            .reduce((sum, [, count]) => sum + count, 0);
        assert.equal(lifecycleCopies, 6);
        assert.equal(measurement?.work['visit:next-step-review-correction-supersession:event:38'], 6);
        assert.equal(measurement?.work['visit:timeline_cloned_event'], 6);
        assert.ok(measurement!.work['visit:timeline_memoized_object'] > 3);
        assert.ok(measurement!.work['visit:timeline_memoized_child'] > 3);
        assert.equal(measurement?.work.timeline_parse, 1);
        assert.equal(measurement?.work['timeline_payload_read:' + timelinePath], 1);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
