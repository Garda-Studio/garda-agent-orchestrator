import { executePersistentQualityPlan } from '../../../src/gates/derived-state/persisted-quality-operation';
import { TRUST_BOUNDARY_ANALYSIS_RULE_ID } from '../../../src/core/trust-boundary-analysis';
import type { ClosedQualityEvidence } from '../../../src/core/closed-quality-analysis';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { appendMandatoryTaskEvent } from '../../../src/gate-runtime/task-events';
import { withInvocationReadObservation } from '../../../src/core/invocation-read-observation';
import { withNextStepMeasurement, type NextStepMeasurement } from '../../../src/core/next-step-measurement';
import { withPersistentDerivationMode, type PersistentDerivationMode } from '../../../src/core/persisted-derivation-mode';
import { parseObservedQualityArtifactJson, readReviewValidationBytes } from '../../../src/gates/review-context/review-validation-invocation';
import { readReviewContextTrustBoundaryAnalysis, readQualityValidationPhaseAnalysis } from '../../../src/gates/review-context/review-context-trust-boundary-analysis';
import { decodePersistentDerivation, encodePersistentDerivation } from '../../../src/gates/derived-state/persisted-derivation-store';
import { resolveClosedReviewAuthentication } from '../../../src/gates/review-attempts/review-closed-cycle-auth';
const scenario = process.argv[2];
const suppliedRoot = process.argv[3];
const root = suppliedRoot || fs.mkdtempSync(path.join(os.tmpdir(), 'garda-q4-real-')), taskId = 'T-Q4';
const bundle = path.join(root, 'garda-agent-orchestrator'), reviews = path.join(bundle, 'runtime/reviews');
const artifactPath = path.join(reviews, taskId + '-quality-checklist.json');
const policyPath = path.join(bundle, 'live/config/workflow-config.json');
const preflight = { task_id: taskId, triggers: { security: true }, classification: { category: 'CODE' }, changed_files: ['src/demo.ts'] };
const options = { repoRoot: root, taskId, preflight, preflightSha256: '1'.repeat(64), inspection: 'active' as const, artifactPath };
function measure(mode: PersistentDerivationMode, beforeReturn?: () => void) {
    let measured!: NextStepMeasurement;
    const result = withNextStepMeasurement(() => withPersistentDerivationMode(mode, () => withInvocationReadObservation(() => {
        const bytes = readReviewValidationBytes(artifactPath);
        const value = parseObservedQualityArtifactJson(artifactPath, bytes, createHash('sha256').update(bytes).digest('hex'), options);
        beforeReturn?.(); return value;
    })), value => { measured = value; });
    return { result, counters: measured.work };
}
try {
    if (scenario === 'cross-process-hit') {
        const current = measure('ordinary'); assert.equal(current.counters.q4_hit, 1);
    } else {
    assert.equal(spawnSync('git', ['init', '--quiet', root], { encoding: 'utf8', windowsHide: true }).status, 0);
    fs.mkdirSync(reviews, { recursive: true }); fs.mkdirSync(path.dirname(policyPath), { recursive: true });
    fs.writeFileSync(policyPath, '{}'); fs.writeFileSync(artifactPath, '{"value":1,"private_note":"must-not-appear-in-store"}');
    appendMandatoryTaskEvent(bundle, taskId, 'TASK_MODE_ENTERED', 'PASS', 'Native cycle for quality leaf.', {});
    resolveClosedReviewAuthentication(root, true);
    const disabled = measure('disabled');
    if (scenario === 'no-bootstrap') {
        const current = measure('ordinary');
        assert.deepEqual(current.result, disabled.result);
        assert.equal(current.counters.q4_hit || 0, 0);
        assert.equal(current.counters.q4_publish || 0, 0, 'Fresh disk bytes cannot attest already loaded modules.');
    } else {
    const miss = measure('force-miss');
    assert.deepEqual(miss.result, disabled.result); assert.equal(miss.counters.q4_miss, 1);
    assert.equal(miss.counters.q4_publish, 1, 'A bootstrapped sealed native parser must publish, not silently remain unavailable.');
    const hit = measure('ordinary'); assert.deepEqual(hit.result, disabled.result); assert.equal(hit.counters.q4_hit, 1);
    const auth = resolveClosedReviewAuthentication(root, false);
    const store = path.join(auth.gitDirectoryRealpath, 'garda-private/derived-quality-v1');
    const recordPath = path.join(store, fs.readdirSync(store).find(name => name.endsWith('.json'))!);
    const good = fs.readFileSync(recordPath);
    assert.ok(!good.toString().includes('must-not-appear-in-store'));
    if (scenario === 'roundtrip') {
        appendMandatoryTaskEvent(bundle, taskId, 'UNRELATED_OBSERVATION', 'INFO', 'Unrelated append.', {});
        assert.deepEqual(measure('ordinary').result, disabled.result, 'Unrelated append preserves the native value; ancillary verified inputs may conservatively miss.');
        appendMandatoryTaskEvent(bundle, taskId, 'REVIEW_CYCLE_RESTARTED', 'PASS', 'Later cycle invalidates leaf record.', {});
        assert.equal(measure('ordinary').counters.q4_hit || 0, 0);
        fs.writeFileSync(artifactPath, '{"value":2}'); assert.deepEqual(measure('ordinary').result, { value: 2 });
        fs.writeFileSync(policyPath, '{"updated":true}'); assert.equal(measure('ordinary').counters.q4_hit || 0, 0);
    } else if (scenario === 'record-negatives') {
        const reject = (bytes: Buffer) => {
            fs.writeFileSync(recordPath, bytes); const current = measure('ordinary');
            assert.deepEqual(current.result, disabled.result); assert.equal(current.counters.q4_hit || 0, 0);
        };
        reject(good.subarray(0, good.length >> 1));
        const forged = JSON.parse(good.toString()); forged.hmac = '0'.repeat(64); reject(Buffer.from(JSON.stringify(forged)));
        const original = decodePersistentDerivation(auth, good); assert.ok(original);
        for (const patch of [{ taskId: 'T-OTHER' }, { lane: 'code' }, { contract: 'soft' }, { schema: 2 }, { operationVersion: 2 },
            { cycleSha256: '0'.repeat(64) }, { codeSha256: '0'.repeat(64) }, { inspection: 'retained_completed' }]) {
            const changed = { ...original, identity: { ...original.identity, ...patch } };
            reject(encodePersistentDerivation(auth, changed as typeof original));
        }
        const keyPath = path.join(auth.gitDirectoryRealpath, 'garda-private/review-history-key'); const key = fs.readFileSync(keyPath);
        try {
            fs.writeFileSync(recordPath, good); fs.writeFileSync(keyPath, randomBytes(32).toString('hex') + '\n');
            assert.equal(measure('ordinary').counters.q4_hit || 0, 0);
            fs.rmSync(keyPath); fs.writeFileSync(recordPath, good); assert.equal(measure('ordinary').counters.q4_hit || 0, 0);
        } finally { fs.writeFileSync(keyPath, key); }
    } else if (scenario === 'strict-soft') {
        const evidence: ClosedQualityEvidence = { base: { required: true, applicability_reasons: [],
            rule_id: TRUST_BOUNDARY_ANALYSIS_RULE_ID, artifact_path: artifactPath, artifact_sha256: '1'.repeat(64),
            recorded_artifact_sha256: '1'.repeat(64), binding_event_sha256: '2'.repeat(64) },
            violations: [], observedExecutionViolationIndex: 0, matrixSha256: '3'.repeat(64), matrix: [], phases: null };
        const projection = (strict: boolean, mode: PersistentDerivationMode) => {
            let work!: NextStepMeasurement;
            const value = withNextStepMeasurement(() => withPersistentDerivationMode(mode, () => withInvocationReadObservation(() =>
                executePersistentQualityPlan({ operation: 'quality-analysis', evidence, requireObservedExecution: strict }, options))),
                value => { work = value; }) as { status: string };
            return { value, work: work.work };
        };
        assert.equal(projection(true, 'force-miss').value.status, 'invalid');
        assert.equal(projection(true, 'ordinary').work.q4_hit, 1);
        const soft = projection(false, 'ordinary'); assert.equal(soft.value.status, 'current'); assert.equal(soft.work.q4_hit || 0, 0);
        assert.equal(projection(false, 'ordinary').work.q4_hit, 1, 'The supported soft contract must hit its own proof.');
        const strict = projection(true, 'ordinary'); assert.equal(strict.value.status, 'invalid'); assert.equal(strict.work.q4_hit, 1, 'Separate contract slots preserve the earlier strict proof.');
    } else if (scenario === 'unavailable-store') {
        fs.writeFileSync(recordPath, 'malformed');
        assert.doesNotThrow(() => measure('ordinary', () => fs.writeFileSync(recordPath, 'changed unselected candidate')));
        fs.rmSync(recordPath); fs.mkdirSync(recordPath);
        assert.deepEqual(measure('ordinary').result, disabled.result, 'Unsafe acceleration target does not change the native parser result.');
    } else if (scenario === 'late-native-failure') {
        fs.rmSync(recordPath);
        const original = new Error('Native work after the leaf failed');
        assert.throws(() => withPersistentDerivationMode('force-miss', () => withInvocationReadObservation(() => {
            const bytes = readReviewValidationBytes(artifactPath);
            parseObservedQualityArtifactJson(artifactPath, bytes, createHash('sha256').update(bytes).digest('hex'), options);
            assert.equal(fs.existsSync(recordPath), false, 'Leaf must not publish before outer A1.');
            throw original;
        })), error => error === original);
        assert.equal(fs.existsSync(recordPath), false, 'Failed native invocation must not publish a proof.');
    } else if (scenario === 'native-error') {
        fs.writeFileSync(artifactPath, '{invalid');
        const message = (mode: PersistentDerivationMode) => {
            try { measure(mode); throw new Error('Native invalid JSON unexpectedly passed.'); }
            catch (error) { assert.ok(error instanceof SyntaxError); return error.message; }
        };
        assert.equal(message('ordinary'), message('disabled')); assert.equal(message('force-miss'), message('disabled'));
    } else if (scenario === 'selected-change') {
        assert.throws(() => measure('ordinary', () => fs.appendFileSync(recordPath, ' ')), /Invocation.*changed/);
    } else if (scenario === 'native-facade') {
        // The full facade still acquires native evidence and emits the identical strict/soft diagnostics.
        // This deliberately invalid native quality artifact is not granted a fabricated quality verdict.
        const read = () => [readReviewContextTrustBoundaryAnalysis(options), readQualityValidationPhaseAnalysis(options)];
        const baseline = withPersistentDerivationMode('disabled', () => withInvocationReadObservation(read));
        const forced = withPersistentDerivationMode('force-miss', () => withInvocationReadObservation(read));
        let facadeWork!: NextStepMeasurement;
        const cached = withNextStepMeasurement(() => withPersistentDerivationMode('ordinary', () => withInvocationReadObservation(read)),
            value => { facadeWork = value; });
        assert.ok((facadeWork.work.q4_hit || 0) > 0, 'The real public facade must use an authenticated leaf hit.');
        assert.deepEqual(forced, baseline); assert.deepEqual(cached, baseline);
        assert.ok(baseline.every(value => value.status !== 'current'));
    } else if (scenario !== 'cross-process-seed') throw new Error('Unknown Q4 scenario.');
    }
    }
} finally { if (!suppliedRoot) fs.rmSync(root, { recursive: true, force: true }); }
