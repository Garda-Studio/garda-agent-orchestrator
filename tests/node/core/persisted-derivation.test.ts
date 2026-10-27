import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { encodeDerivationValue, decodeDerivationValue } from '../../../src/core/persisted-derivation-value';
import { withInvocationReadObservation, probeOptionalInvocationReads, enqueueInvocationOptionalPublication, registerInvocationDependency } from '../../../src/core/invocation-read-observation';
import { readInvocationFileContent, readInvocationPathObservation } from '../../../src/core/invocation-file-observation';
import { captureInvocationMemoTrace, captureDerivationObservations, isPublishableObservationCapture } from '../../../src/core/derivation-observation-recorder';
import { readInvocationFilteredDirectoryNames } from '../../../src/core/invocation-enumeration-observation';
import { encodePersistentDependencies, replayPersistentDependencies, observePersistentGitHead } from '../../../src/gates/derived-state/persisted-derivation-adapters';
import { withNextStepMeasurement, type NextStepMeasurement } from '../../../src/core/next-step-measurement';
function fixture(t: TestContext) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-q4-storage-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root;
}

test('Q4 result codec preserves native property presence and never executes getters or toJSON', () => {
    const value = { missing: undefined, array: [1, , undefined], negative: -0 };
    const restored = decodeDerivationValue(encodeDerivationValue(value)) as typeof value;
    assert.deepEqual(restored, value); assert.ok(Object.is(restored.negative, -0));
    let gets = 0; const opaque = { get field() { gets++; return 1; } };
    assert.throws(() => encodeDerivationValue(opaque)); assert.equal(gets, 0);
    let hooks = 0; assert.throws(() => encodeDerivationValue({ toJSON() { hooks++; return {}; } })); assert.equal(hooks, 0);
});

test('Q4 rejected optional absence does not become a decision dependency', t => {
    const file = path.join(fixture(t), 'candidate.json');
    assert.doesNotThrow(() => withInvocationReadObservation(() => {
        const probe = probeOptionalInvocationReads(() => { readInvocationPathObservation(file); return null; });
        assert.ok(probe); probe.discard(); fs.writeFileSync(file, 'new candidate');
    }));
});

test('Q4 selected hit dependencies reject byte replacement at final A1', t => {
    const file = path.join(fixture(t), 'selected.json'); fs.writeFileSync(file, 'before');
    assert.throws(() => withInvocationReadObservation(() => {
        const probe = probeOptionalInvocationReads(() => readInvocationFileContent(file)?.sha256); assert.ok(probe);
        probe.select(); fs.writeFileSync(file, 'after');
    }), /Invocation.*changed/);
});

test('Q4 optional replay inherits already observed immutable Q2 bytes without a second capture', t => {
    const file = path.join(fixture(t), 'shared.json'); fs.writeFileSync(file, '{}'); let measured!: NextStepMeasurement;
    withNextStepMeasurement(() => withInvocationReadObservation(() => {
        const first = readInvocationFileContent(file);
        const probe = probeOptionalInvocationReads(() => readInvocationFileContent(file)); assert.ok(probe);
        assert.equal(probe.value, first); probe.select();
    }), value => { measured = value; });
    assert.equal(measured.work['file_hash:' + path.resolve(file)], 1);
});

test('Q4 decoded typed traces replay absence and exact filtered directory membership', t => {
    const root = fixture(t), missing = path.join(root, 'receipt.json'); fs.writeFileSync(path.join(root, 'review-a.json'), '{}');
    const dependencies = withInvocationReadObservation(() => encodePersistentDependencies(captureInvocationMemoTrace(() => {
        readInvocationPathObservation(missing); readInvocationFilteredDirectoryNames(root, { prefix: 'review-', suffix: '.json', sort: true });
    }).trace));
    assert.ok(dependencies); const wire = JSON.parse(JSON.stringify(dependencies));
    assert.equal(withInvocationReadObservation(() => replayPersistentDependencies(wire)), true);
    fs.writeFileSync(path.join(root, 'unrelated.txt'), 'x');
    assert.equal(withInvocationReadObservation(() => replayPersistentDependencies(wire)), true);
    const matching = path.join(root, 'review-b.json');
    fs.writeFileSync(matching, '{}');
    assert.equal(withInvocationReadObservation(() => replayPersistentDependencies(wire)), false,
        'a newly matching directory entry invalidates the recorded selection even while receipt stays absent');
    fs.rmSync(matching);
    assert.equal(withInvocationReadObservation(() => replayPersistentDependencies(wire)), true);
    fs.renameSync(path.join(root, 'review-a.json'), path.join(root, 'hidden-a.json'));
    assert.equal(withInvocationReadObservation(() => replayPersistentDependencies(wire)), false,
        'an entry leaving the native filter invalidates the selection');
    fs.renameSync(path.join(root, 'hidden-a.json'), path.join(root, 'review-a.json'));
    fs.writeFileSync(missing, '{}');
    assert.equal(withInvocationReadObservation(() => replayPersistentDependencies(wire)), false);
});

test('Q4 fixed process descriptor persists no environment plaintext and changes invalidate it', t => {
    const root = fixture(t), name = 'GARDA_Q4_SECRET_TEST'; const before = process.env[name];
    try {
        process.env[name] = 'not-to-be-persisted-123';
        const dependencies = withInvocationReadObservation(() => encodePersistentDependencies(captureInvocationMemoTrace(() => observePersistentGitHead(root)).trace));
        assert.ok(dependencies); assert.ok(!JSON.stringify(dependencies).includes(process.env[name]!));
        process.env[name] = 'changed'; assert.equal(withInvocationReadObservation(() => replayPersistentDependencies(dependencies)), false);
    } finally { if (before === undefined) delete process.env[name]; else process.env[name] = before; }
});

test('Q4 unlisted direct read and copied eligibility cannot publish', t => {
    const file = path.join(fixture(t), 'unlisted.txt'); fs.writeFileSync(file, 'native'); let reads = 0;
    const capture = captureDerivationObservations(() => { reads++; return fs.readFileSync(file, 'utf8'); });
    assert.equal(reads, 1); assert.deepEqual(capture.outcome, { returned: true, value: 'native' });
    assert.equal(isPublishableObservationCapture(capture), false);
    assert.equal(isPublishableObservationCapture({ ...capture, cacheable: true }), false);
    assert.equal(encodePersistentDependencies(capture.trace), null);
});

test('Q4 unknown kinds and generic process metadata are never serialized', () => {
    assert.equal(encodePersistentDependencies({ nonCacheableReasons: [], observations: [{ kind: 'process-result', version: 1,
        input: { command: 'SECRET_ENV=abc' }, inputKey: 'raw-secret', fingerprint: 'returned:abc' }] }), null);
    assert.equal(withInvocationReadObservation(() => replayPersistentDependencies([{ kind: 'unknown', version: 1,
        input: {}, inputSha256: '0'.repeat(64), fingerprint: 'returned:abc' }])), false);
});

// Bootstrap must precede application imports. Each child exercises the real quality parser/facade.
for (const scenario of ['roundtrip', 'record-negatives', 'selected-change', 'native-facade', 'strict-soft', 'unavailable-store', 'native-error', 'late-native-failure']) {
    test('Q4 real loaded-code path: ' + scenario, { timeout: 120000 }, () => {
        const bootstrap = require.resolve('../../../src/bin/garda/derivation-source-receipts');
        const driver = require.resolve('./persisted-quality-driver');
        const result = spawnSync(process.execPath, ['-r', bootstrap, driver, scenario], { encoding: 'utf8', timeout: 110000, maxBuffer: 4 * 1024 * 1024 });
        assert.equal(result.status, 0, result.stdout + result.stderr);
    });
}

test('Q4 record survives a new process with no in-process replay closures', { timeout: 120000 }, t => {
    const root = fixture(t), bootstrap = require.resolve('../../../src/bin/garda/derivation-source-receipts');
    const driver = require.resolve('./persisted-quality-driver');
    for (const scenario of ['cross-process-seed', 'cross-process-hit']) {
        const result = spawnSync(process.execPath, ['-r', bootstrap, driver, scenario, root],
            { encoding: 'utf8', timeout: 55000, maxBuffer: 4 * 1024 * 1024 });
        assert.equal(result.status, 0, scenario + ':' + result.stdout + result.stderr);
    }
});


test('Q4 optional publication follows the outer final A1 and cannot replace the native result', () => {
    let published = 0, disposed = 0;
    const original = new Error('Original native failure');
    assert.throws(() => withInvocationReadObservation(() => {
        enqueueInvocationOptionalPublication(() => { published++; }, () => { disposed++; });
        registerInvocationDependency({}, () => { throw original; });
        return 'native';
    }), error => error === original);
    assert.equal(published, 0); assert.equal(disposed, 1);
    assert.equal(withInvocationReadObservation(() => {
        enqueueInvocationOptionalPublication(() => { throw new Error('Optional storage failure'); }, () => { disposed++; });
        return 'native';
    }), 'native');
    assert.equal(disposed, 2);
});


test('Q4 already loaded modules without the source bootstrap cannot authorize persistence', { timeout: 120000 }, () => {
    const driver = require.resolve('./persisted-quality-driver');
    const result = spawnSync(process.execPath, [driver, 'no-bootstrap'],
        { encoding: 'utf8', timeout: 110000, maxBuffer: 4 * 1024 * 1024 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
});


test('Q4 selected immutable observations are shared with later consumers without weakening validation', t => {
    const file = path.join(fixture(t), 'shared-selected.json'); fs.writeFileSync(file, '{}');
    let measured!: NextStepMeasurement; let checks = 0;
    withNextStepMeasurement(() => withInvocationReadObservation(() => {
        const probe = probeOptionalInvocationReads(() => {
            registerInvocationDependency({}, () => { checks++; });
            return readInvocationFileContent(file);
        });
        assert.ok(probe); assert.equal(checks, 1); probe.select(); assert.equal(checks, 2);
        assert.equal(readInvocationFileContent(file), probe.value);
        const second = probeOptionalInvocationReads(() => readInvocationFileContent(file));
        assert.ok(second); assert.equal(second.value, probe.value); second.select(); assert.equal(checks, 3);
    }), value => { measured = value; });
    assert.equal(checks, 4, 'Child, both selections and outer final A1 are still checked');
    assert.equal(measured.work['file_hash:' + path.resolve(file)], 1);
});
