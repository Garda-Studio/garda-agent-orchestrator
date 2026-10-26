import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash } from 'node:crypto';
import { readBoundedJsonlTailBuffer, type BoundedJsonlTailLimits } from '../../../../src/core/bounded-jsonl-tail';
import { isPlainRecord } from '../../../../src/core/records';
import { redactSensitiveData } from '../../../../src/core/redaction';
import { withNextStepMeasurement, countNextStepWork, type NextStepMeasurement } from '../../../../src/core/next-step-measurement';
import { appendTaskEvent, buildEventIntegrityHash } from '../../../../src/gate-runtime/task-events';
import { ReviewCadenceWindowAccumulator, selectReviewCadence } from '../../../../src/gates/review-attempts/review-cadence-window';
import { advanceCadenceHead, bootstrapCadenceHead, readCoveredReviewCadenceFailure, reviewCadenceFailedFromDetails,
    sealReviewCadenceAdmission, validateReviewCadenceAdmission, verifyCadenceHead } from '../../../../src/gates/review-attempts/review-cadence-admission';
import type { ClosedReviewAuthentication } from '../../../../src/gates/review-attempts/review-closed-cycle-auth';

const limits: BoundedJsonlTailLimits = { maxBytes: 2 * 1024 * 1024, maxLines: 8192, maxEvents: 4096, maxParseAttempts: 8192 };
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const review = (reviewType: string, failed = true) => ({ event_type: 'REVIEW_RECORDED', details: {
    review_type: reviewType, verdict_token: failed ? 'REVIEW FAILED' : 'REVIEW PASSED', cadence_failed: failed } });
const checklist = (status: string) => ({ event_type: 'QUALITY_CHECKLIST_RECORDED', details: { status } });
const noise = (text = '') => ({ event_type: 'UNRELATED', details: { text } });
const jsonl = (events: unknown[], ending = '\n') => Buffer.from(events.map(event => JSON.stringify(event)).join(ending) + ending);
function accumulator(source: Buffer, bounds = limits) {
    const result = new ReviewCadenceWindowAccumulator(bounds, event => {
        const details = isPlainRecord(event.details) ? event.details : {};
        return typeof details.cadence_failed === 'boolean' ? details.cadence_failed : null;
    });
    for (let start = 0; start < source.length;) {
        const newline = source.indexOf(0x0a, start), end = newline < 0 ? source.length : newline;
        const line = source.subarray(start, end).toString('utf8');
        if (line.trim()) {
            // This standalone test adapter really walks lines; production uses the existing verifier visit.
            countNextStepWork('visit:cadence_window_line');
            let record: unknown, invalid = false;
            try { record = JSON.parse(line); } catch { invalid = true; }
            result.accept(start, record, invalid);
        }
        start = end + 1;
    }
    return result;
}
// Native bounded reader plus the existing cadence reduction; the candidate uses prefix facts instead.
function oracle(source: Buffer, bounds: BoundedJsonlTailLimits, declared: boolean, interval: number) {
    const tail = readBoundedJsonlTailBuffer<Record<string, unknown>>(source, source.length, bounds);
    const passes: number[] = [], failures: Array<{ index: number; reviewType: string }> = [];
    (tail.invalidJson ? [] : tail.records).forEach((event, index) => {
        const details = isPlainRecord(event.details) ? event.details : {};
        if (String(event.event_type || '') === 'QUALITY_CHECKLIST_RECORDED') {
            const status = String(details.status || '').trim().toUpperCase().replace(/[\s-]+/g, '_');
            if (status === 'PASS' || status === 'WARN' || (declared && status === 'PENDING_VALIDATION')) passes.push(index);
            return;
        }
        if (String(event.event_type || '') === 'REVIEW_RECORDED' && reviewCadenceFailedFromDetails(details))
            failures.push({ index, reviewType: String(details.review_type || '').trim().toLowerCase() });
    });
    const firstTest = failures.find(failure => failure.reviewType === 'test');
    const testResetPending = !!firstTest && !passes.some(index => index > firstTest.index);
    const latestPass = passes.at(-1) ?? -1;
    const failureCount = failures.filter(failure => failure.index > latestPass).length;
    return { tail, cadence: { due: latestPass < 0 || testResetPending || failureCount >= interval,
        skip: latestPass >= 0 && !testResetPending && failureCount > 0 && failureCount < interval,
        failureCount, testResetPending } };
}
function assertMatches(source: Buffer, bounds: BoundedJsonlTailLimits): void {
    const projected = accumulator(source, bounds).finish(source.length, true);
    for (const declared of [false, true]) for (const interval of [1, 2, 5]) {
        const expected = oracle(source, bounds, declared, interval);
        for (const key of ['invalidJson', 'truncated', 'bytesRead', 'retainedLineCount', 'parseAttempts'] as const)
            assert.equal(projected[key], expected.tail[key], `${key}; ${JSON.stringify(bounds)}`);
        if (expected.tail.invalidJson) assert.equal(projected.available, false);
        else {
            assert.equal(projected.available, true);
            assert.deepEqual(selectReviewCadence(declared ? projected.declaredRequired : projected.ordinary, interval), expected.cadence);
        }
    }
}

test('matches native byte line event and parse limits with first-test and both checklist modes', () => {
    const source = jsonl([checklist('PASS'), review('test'), checklist('WARN'), review('code'),
        noise('\u{1f642}\u00e9'.repeat(12)), checklist('pending-validation'), review('test'), review('code', false), noise()]);
    for (const maxBytes of [1, 2, 30, 100, source.length - 1, source.length, source.length + 1])
        for (const maxLines of [1, 2, 3, 8, 16]) for (const maxEvents of [1, 2, 9])
            for (const maxParseAttempts of [1, 3, 12]) assertMatches(source, { maxBytes, maxLines, maxEvents, maxParseAttempts });
    for (const events of [[review('test'), checklist('PASS'), review('test')],
        [review('test'), checklist('PENDING_VALIDATION'), review('code')]]) assertMatches(jsonl(events), limits);
});

test('unrelated append evictions include exact-line-start cutoffs and missing final newline', () => {
    for (const events of [[review('test'), checklist('PASS'), review('test')], [checklist('PASS'), review('code')]]) {
        const before = jsonl(events), after = Buffer.concat([before, jsonl([noise('x'.repeat(250))])]);
        const bounds = { ...limits, maxBytes: after.length - JSON.stringify(events[0]).length - 1 };
        assertMatches(before, bounds); assertMatches(after, bounds);
        assertMatches(after.subarray(0, after.length - 1), { ...bounds, maxBytes: bounds.maxBytes - 1 });
    }
});

test('raw offsets preserve malformed UTF-8 CRLF blank lines and invalid-JSON stopping', () => {
    const prefix = Buffer.concat([Buffer.from('{"event_type":"UNRELATED","details":{"text":"'),
        Buffer.from([0xff]), Buffer.from('"}}\r\n\r\n')]);
    const source = Buffer.concat([prefix, jsonl([review('test'), checklist('PASS')], '\r\n')]);
    assert.notEqual(Buffer.byteLength(prefix.toString('utf8')), prefix.length);
    assertMatches(source, { ...limits, maxBytes: source.length - prefix.length }); assertMatches(source, limits);
    const invalid = Buffer.concat([jsonl([checklist('PASS')]), Buffer.from('{invalid}\n'), jsonl([review('test'), noise()])]);
    for (const maxParseAttempts of [1, 2, 3, 4, 8]) assertMatches(invalid, { ...limits, maxParseAttempts });
});

test('missing proof stays legacy fallback only while selected; lookup has fixed probes and no replay', () => {
    const legacy = { event_type: 'REVIEW_RECORDED', details: { verdict_token: 'REVIEW FAILED', review_type: 'test' } };
    const source = jsonl([legacy, checklist('PASS'), review('code')]);
    assert.equal(accumulator(source).finish(source.length, true).available, false);
    assert.equal(accumulator(source, { ...limits, maxEvents: 2 }).finish(source.length, true).available, true);
    assert.equal(accumulator(source, { ...limits, maxEvents: 2 }).finish(source.length, false).available, false);
    for (const bytes of [jsonl([review('code')]), jsonl(Array.from({ length: 9000 }, () => noise()))]) {
        const captured = accumulator(bytes); let measured: NextStepMeasurement | undefined;
        withNextStepMeasurement(() => captured.finish(bytes.length, true), value => { measured = value; });
        assert.equal(measured!.work['visit:cadence_window_line'] || 0, 0);
        assert.equal(measured!.work['visit:cadence_window_search_slot'], 14);
        assert.equal(measured!.work['visit:cadence_window_row'], 4);
    }
});

function files(t: TestContext) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-cadence-proof-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const report = path.join(root, 'report.md'); fs.writeFileSync(report, '# Review\n## Verdict\nREVIEW FAILED\n');
    const auth: ClosedReviewAuthentication = { repoRealpath: root, gitDirectoryRealpath: path.join(root, '.git'),
        workspaceSha256: 'a'.repeat(64), key: Buffer.alloc(32, 7) };
    return { root, report, auth };
}

test('producer bit keeps verdict precedence and Markdown semantics distinct from guard JSON failure', t => {
    const { report } = files(t);
    assert.equal(reviewCadenceFailedFromDetails({ verdict_token: 'REVIEW PASSED', status: 'REVIEW FAILED' }), false);
    assert.equal(reviewCadenceFailedFromDetails({ status: 'TEST REVIEW FAILED' }), true);
    assert.equal(reviewCadenceFailedFromDetails({ review_artifact_snapshot_path: report }), true);
    fs.writeFileSync(report, '{"verdict":"FAIL","findings":[{"severity":"critical"}]}');
    assert.equal(reviewCadenceFailedFromDetails({ review_artifact_snapshot_path: report }), false);
});

test('native HMAC binds cadence bit to exact task source and redacted record facts', t => {
    const { report, auth } = files(t), taskId = 'T-CADENCE';
    const details = sealReviewCadenceAdmission(auth, taskId, { review_type: 'code',
        review_artifact_snapshot_path: report, review_artifact_snapshot_sha256: hash(fs.readFileSync(report)) });
    const event = { schema_version: 2, event_source: 'task-events', task_id: taskId,
        event_type: 'REVIEW_RECORDED', actor: 'gate', outcome: 'PASS', details: redactSensitiveData(details) };
    assert.equal(validateReviewCadenceAdmission(auth, taskId, event), true);
    assert.throws(() => validateReviewCadenceAdmission(auth, taskId, { ...event, details: { ...details, cadence_failed: false } }), /mismatch/iu);
    assert.throws(() => validateReviewCadenceAdmission(auth, 'T-FOREIGN', event), /admission/iu);
    assert.throws(() => validateReviewCadenceAdmission(auth, taskId, { ...event, actor: 'user' }), /admission/iu);
    assert.throws(() => validateReviewCadenceAdmission({ ...auth, key: Buffer.alloc(32, 8) }, taskId, event), /authentication/iu);
});

test('one head certificate advances on native append and rejects rehashed forged bits', t => {
    const { root, report, auth } = files(t), taskId = 'T-CADENCE-HEAD';
    const details = sealReviewCadenceAdmission(auth, taskId, { review_type: 'test', review_artifact_snapshot_path: report });
    appendTaskEvent(root, taskId, 'REVIEW_RECORDED', 'PASS', 'Admitted.', details, { actor: 'gate' });
    const timeline = path.join(root, 'runtime', 'task-events', taskId + '.jsonl');
    const before = fs.readFileSync(timeline), certificate = bootstrapCadenceHead(auth, taskId, timeline);
    const head = verifyCadenceHead(auth, taskId, hash(before), before.length, certificate);
    const record = JSON.parse(before.toString('utf8').trim()) as Record<string, unknown>;
    assert.equal(readCoveredReviewCadenceFailure(head, record), true);
    appendTaskEvent(root, taskId, 'UNRELATED', 'PASS', 'Unrelated append.', { bytes: 'x'.repeat(100) });
    const after = fs.readFileSync(timeline);
    const appended = JSON.parse(after.toString('utf8').trim().split('\n').at(-1)!) as Record<string, unknown>;
    const advanced = advanceCadenceHead(auth, taskId, certificate, { beforeSha256: hash(before), beforeBytes: before.length,
        afterSha256: hash(after), afterBytes: after.length, appendedEvent: appended });
    assert.doesNotThrow(() => verifyCadenceHead(auth, taskId, hash(after), after.length, advanced));
    assert.throws(() => verifyCadenceHead(auth, taskId, hash(after), after.length, certificate), /cover/iu);
    const forged = { ...record, details: { ...(record.details as Record<string, unknown>), cadence_failed: false },
        integrity: { ...(record.integrity as Record<string, unknown>) } };
    forged.integrity.event_sha256 = buildEventIntegrityHash(forged);
    assert.throws(() => validateReviewCadenceAdmission(auth, taskId, forged), /mismatch/iu);
});
