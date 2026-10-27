import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as childProcess from 'node:child_process';
import { createRequire } from 'node:module';
import test from 'node:test';
import { captureDerivationObservations, captureInvocationMemoTrace, executeClosedObservationPlan,
    fingerprintObservationData, isPublishableObservationCapture, observeDerivationInput,
    replayDerivationObservations, unwrapObservationCapture, UnrecordedDerivationIoError } from '../../../src/core/derivation-observation-recorder';
import { createInvocationReadMemoKey, memoizeInvocationRead, withInvocationReadObservation } from '../../../src/core/invocation-read-observation';
import { readInvocationFileContent, readInvocationPathObservation } from '../../../src/core/invocation-file-observation';
import { readInvocationFilteredDirectoryNames } from '../../../src/core/invocation-enumeration-observation';
import { withInvocationGitReadObservation } from '../../../src/core/invocation-git-observation';
import { withNextStepMeasurement, type NextStepMeasurement } from '../../../src/core/next-step-measurement';
import { createHash } from 'node:crypto';
import { parseObservedQualityArtifactJson, readReviewValidationBytes } from '../../../src/gates/review-context/review-validation-invocation';
import { readReviewContextTrustBoundaryAnalysis } from '../../../src/gates/review-context/review-context-trust-boundary-analysis';
import { resolveDefaultQualityChecklistArtifactPath } from '../../../src/gates/quality-checklist';

function temporary<T>(callback: (root: string) => T): T {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-q4-recorder-'));
    try { return callback(root); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test('production unlisted I/O derives once and preserves result, side effects and error identity', () => temporary(root => {
    const target = path.join(root, 'side-effect.txt');
    let builds = 0;
    const value = captureDerivationObservations(() => { builds++; fs.appendFileSync(target, 'x'); return 17; });
    assert.equal(unwrapObservationCapture(value), 17);
    assert.equal(builds, 1);
    assert.equal(fs.readFileSync(target, 'utf8'), 'x');
    assert.equal(value.cacheable, false);
    assert.equal(isPublishableObservationCapture(value), false);
    assert.ok(value.trace.nonCacheableReasons.includes('unrecorded:fs.appendFileSync'));
    const failure = new Error('original failure');
    const rejected = captureDerivationObservations(() => { builds++; throw failure; });
    assert.equal(builds, 2);
    assert.throws(() => unwrapObservationCapture(rejected), error => error === failure);
}));

test('test-mode guard rejects a direct unlisted synchronous read', () => temporary(root => {
    const target = path.join(root, 'data.txt');
    fs.writeFileSync(target, 'value');
    const captured = captureDerivationObservations(() => fs.readFileSync(target), { assertRecorded: true });
    assert.throws(() => unwrapObservationCapture(captured), UnrecordedDerivationIoError);
    assert.equal(captured.cacheable, false);
}));

test('an fs alias captured before recorder installation remains technically non-publishable', () => temporary(root => {
    const target = path.join(root, 'data.txt');
    fs.writeFileSync(target, 'value');
    const modulePath = createRequire(__filename).resolve('../../../src/core/derivation-observation-recorder');
    const script = `const fs = require('node:fs');
const alias = fs.readFileSync;
const recorder = require(process.argv[1]);
const registry = require(require('node:path').join(require('node:path').dirname(process.argv[1]), 'invocation-read-observation'));
let calls = 0;
const key = registry.createInvocationReadMemoKey('pre-install-alias');
const captured = registry.withInvocationReadObservation(() => {
 const child = () => registry.memoizeInvocationRead(key, '', () => { calls++; return alias(process.argv[2], 'utf8'); }).value;
 child();
 return recorder.captureDerivationObservations(child);
});
process.stdout.write(JSON.stringify({ calls, value: recorder.unwrapObservationCapture(captured),
 cacheable: captured.cacheable, publishable: recorder.isPublishableObservationCapture(captured),
 reasons: captured.trace.nonCacheableReasons }));`;
    const result = JSON.parse(childProcess.execFileSync(process.execPath, ['-e', script, modulePath, target], { encoding: 'utf8' })) as {
        calls: number; value: string; cacheable: boolean; publishable: boolean; reasons: string[];
    };
    assert.equal(result.calls, 1); assert.equal(result.value, 'value');
    assert.equal(result.cacheable, false); assert.equal(result.publishable, false);
    assert.ok(result.reasons.includes('unsealed-call-closure'));
}));

test('async I/O and unsupported native closures cannot publish even when synchronous wrappers cannot see them', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-q4-async-'));
    try {
        const target = path.join(root, 'data.txt'); fs.writeFileSync(target, 'value');
        let calls = 0;
        const captured = captureDerivationObservations(async () => { calls++; return fs.promises.readFile(target, 'utf8'); });
        assert.equal(await unwrapObservationCapture(captured), 'value');
        assert.equal(calls, 1); assert.equal(captured.cacheable, false);
        assert.ok(captured.trace.nonCacheableReasons.includes('asynchronous-result'));
        const extensionLike = () => 23;
        const opaque = captureDerivationObservations(() => extensionLike());
        assert.equal(unwrapObservationCapture(opaque), 23);
        assert.equal(isPublishableObservationCapture(opaque), false);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a warmed child and graph memo replay their full dependency trace on hits', () => temporary(root => {
    const target = path.join(root, 'data.txt'); fs.writeFileSync(target, 'value');
    const childKey = createInvocationReadMemoKey<string>('test-child');
    const graphKey = createInvocationReadMemoKey<string>('test-graph');
    let childBuilds = 0, graphBuilds = 0;
    const read = () => memoizeInvocationRead(graphKey, '', () => {
        graphBuilds++;
        return memoizeInvocationRead(childKey, '', () => {
            childBuilds++; return readInvocationFileContent(target)!.copyBytes().toString('utf8');
        }).value;
    }).value;
    const trace = withInvocationReadObservation(() => {
        assert.equal(read(), 'value'); // Warm before the later recorder frame exists.
        const hit = captureInvocationMemoTrace(read);
        assert.equal(hit.outcome.returned && hit.outcome.value, 'value');
        assert.ok(hit.trace.observations.some(item => item.kind === 'file-bytes' && item.input.path === target));
        assert.equal(replayDerivationObservations(hit.trace), true);
        return hit.trace;
    });
    assert.equal(childBuilds, 1); assert.equal(graphBuilds, 1);
    fs.writeFileSync(target, 'changed');
    assert.equal(replayDerivationObservations(trace), false);
}));

test('memoized unlisted reads and cached exceptions retain their unsafe trace without a rebuild', () => temporary(root => {
    const target = path.join(root, 'data.txt'); fs.writeFileSync(target, 'value');
    const key = createInvocationReadMemoKey<string>('unsafe-child');
    let builds = 0;
    withInvocationReadObservation(() => {
        const read = () => memoizeInvocationRead(key, '', () => { builds++; return fs.readFileSync(target, 'utf8'); }).value;
        assert.equal(read(), 'value');
        const hit = captureInvocationMemoTrace(read);
        assert.ok(hit.trace.nonCacheableReasons.includes('unrecorded:fs.readFileSync'));
        assert.equal(replayDerivationObservations(hit.trace), false);
    });
    assert.equal(builds, 1);
    const failedKey = createInvocationReadMemoKey<never>('failed-child');
    const original = new Error('cached');
    withInvocationReadObservation(() => {
        const read = () => memoizeInvocationRead(failedKey, '', () => {
            readInvocationFileContent(target); throw original;
        }).value;
        assert.throws(read, error => error === original);
        const hit = captureInvocationMemoTrace(read);
        assert.equal(hit.outcome.returned, false);
        if (!hit.outcome.returned) assert.equal(hit.outcome.error, original);
        assert.ok(hit.trace.observations.some(item => item.kind === 'file-bytes'));
    });
}));

test('an absent path becoming present invalidates its replay', () => temporary(root => {
    const target = path.join(root, 'receipt.json');
    const captured = withInvocationReadObservation(() => captureInvocationMemoTrace(() => readInvocationPathObservation(target)));
    assert.equal(replayDerivationObservations(captured.trace), true);
    fs.writeFileSync(target, '{}');
    assert.equal(replayDerivationObservations(captured.trace), false);
}));

test('filtered enumeration records exactly the consumed name set and order contract', () => temporary(root => {
    fs.writeFileSync(path.join(root, 'receipt-a.json'), '{}');
    const captured = withInvocationReadObservation(() => captureInvocationMemoTrace(() =>
        readInvocationFilteredDirectoryNames(root, { prefix: 'receipt-', suffix: '.json', sort: true })));
    assert.equal(captured.outcome.returned, true);
    fs.writeFileSync(path.join(root, 'unrelated.txt'), 'ignored');
    assert.equal(replayDerivationObservations(captured.trace), true);
    fs.writeFileSync(path.join(root, 'receipt-b.json'), '{}');
    assert.equal(replayDerivationObservations(captured.trace), false);
}));

test('readonly process observations bind command identity and every captured output byte', () => temporary(root => {
    childProcess.execFileSync('git', ['init', '--quiet', root]);
    childProcess.execFileSync('git', ['config', 'fixture.observation', 'before'], { cwd: root });
    const captured = withInvocationReadObservation(() => withInvocationGitReadObservation(() => captureInvocationMemoTrace(() =>
        childProcess.execFileSync('git', ['config', '--get', 'fixture.observation'], { cwd: root, encoding: 'utf8' }))));
    assert.equal(captured.outcome.returned && captured.outcome.value.trim(), 'before');
    assert.ok(captured.trace.observations.some(item => item.kind === 'process-result'
        && typeof item.input.command === 'string' && item.input.command.includes('fixture.observation')));
    assert.equal(replayDerivationObservations(captured.trace), true);
    childProcess.execFileSync('git', ['config', 'fixture.observation', 'after'], { cwd: root });
    assert.equal(replayDerivationObservations(captured.trace), false);
}));

test('nested recorders retain observations and exceptions; unknown kinds derive once but cannot cache', () => temporary(root => {
    let reads = 0;
    const outer = captureDerivationObservations(() => {
        const inner = captureDerivationObservations(() => observeDerivationInput('future-kind', 9,
            { path: root }, () => { reads++; return 'value'; }, fingerprintObservationData));
        return unwrapObservationCapture(inner);
    });
    assert.equal(unwrapObservationCapture(outer), 'value'); assert.equal(reads, 1);
    assert.ok(outer.trace.nonCacheableReasons.includes('unknown-observation:future-kind:9'));
}));

test('descriptor recording and work counters never invoke getters or toJSON', () => {
    let getters = 0, serializers = 0;
    const input = { get hidden() { getters++; return 'secret'; }, toJSON() { serializers++; return 'serialized'; } };
    let measured: NextStepMeasurement | undefined;
    const captured = withNextStepMeasurement(() => captureDerivationObservations(() =>
        observeDerivationInput('path-state', 1, input, () => 7, fingerprintObservationData)), value => { measured = value; });
    assert.equal(unwrapObservationCapture(captured), 7);
    assert.equal(getters, 0); assert.equal(serializers, 0); assert.equal(captured.cacheable, false);
    assert.ok((measured?.work['visit:derivation_descriptor_field'] || 0) > 0);
    assert.ok((measured?.work['visit:derivation_descriptor_value'] || 0) > 0);
});

test('only module-owned closed pure-data plans obtain a publication seal', () => {
    const parsed = executeClosedObservationPlan({ operation: 'json-parse', text: '{"answer":42}' });
    assert.deepEqual(unwrapObservationCapture(parsed), { answer: 42 });
    assert.equal(parsed.cacheable, true); assert.equal(isPublishableObservationCapture(parsed), true);
    assert.equal(isPublishableObservationCapture({ ...parsed }), false, 'A copied shape cannot forge the private seal.');
    const arbitrary = captureDerivationObservations(() => ({ answer: 42 }));
    assert.equal(arbitrary.cacheable, false);
});

test('fixed quality JSON seam reuses a real parse and retains warmed file dependencies', () => temporary(root => {
    const target = path.join(root, 'quality.json');
    const bytes = Buffer.from('{"task_id":"T-closed","rules":[]}');
    fs.writeFileSync(target, bytes);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    let measured: NextStepMeasurement | undefined;
    const captured = withNextStepMeasurement(() => withInvocationReadObservation(() => {
        // The real Q3 consumer already acquired these bytes before the parse seam.
        const first = readReviewValidationBytes(target);
        assert.deepEqual(parseObservedQualityArtifactJson(target, first, sha256), { task_id: 'T-closed', rules: [] });
        const plan = { operation: 'quality-artifact-json' as const, path: target, text: first.toString('utf8'), sha256 };
        const hit = executeClosedObservationPlan(plan);
        assert.equal(isPublishableObservationCapture(hit), true);
        assert.ok(hit.trace.observations.some(item => item.kind === 'file-bytes'));
        assert.ok(hit.trace.observations.some(item => item.kind === 'path-state'));
        return hit;
    }), value => { measured = value; });
    assert.equal(measured?.work['derive:closed_quality_json_parse'], 1);
    assert.equal(replayDerivationObservations(captured.trace), true);
    fs.writeFileSync(target, '{"task_id":"forged","rules":[]}');
    assert.equal(replayDerivationObservations(captured.trace), false);
}));

test('real quality analysis invokes the fixed artifact parse without suppressing invalid evidence', () => temporary(root => {
    const taskId = 'T-q4-quality';
    const artifact = resolveDefaultQualityChecklistArtifactPath(root, taskId);
    fs.mkdirSync(path.dirname(artifact), { recursive: true }); fs.writeFileSync(artifact, '{}');
    let measured: NextStepMeasurement | undefined;
    const analysis = withNextStepMeasurement(() => withInvocationReadObservation(() =>
        readReviewContextTrustBoundaryAnalysis({ repoRoot: root, taskId, preflightSha256: 'a'.repeat(64),
            preflight: { triggers: { security: true }, changed_files: [] } })), value => { measured = value; });
    assert.equal(analysis.status, 'invalid');
    assert.ok(analysis.violations.length > 0);
    assert.equal(measured?.work['derive:closed_quality_json_parse'], 1);
}));

test('a warmed child using an aliased reader never makes an arbitrary enclosing graph publishable', () => temporary(root => {
    const target = path.join(root, 'value'); fs.writeFileSync(target, 'value');
    const alias = fs.readFileSync, key = createInvocationReadMemoKey<string>('alias-child');
    withInvocationReadObservation(() => {
        const child = () => memoizeInvocationRead(key, '', () => alias(target, 'utf8')).value;
        child();
        const graph = captureDerivationObservations(child);
        assert.equal(unwrapObservationCapture(graph), 'value');
        assert.equal(isPublishableObservationCapture(graph), false);
    });
}));
