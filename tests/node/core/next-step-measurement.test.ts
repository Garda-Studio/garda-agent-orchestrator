import test from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import { withNextStepMeasurement, type NextStepMeasurement } from '../../../src/core/next-step-measurement';

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
