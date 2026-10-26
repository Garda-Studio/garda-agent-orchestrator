import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { withInvocationReadObservation } from '../../../src/core/invocation-read-observation';
import { withNextStepMeasurement, type NextStepMeasurement } from '../../../src/core/next-step-measurement';
import { readBoundedJsonlTailBuffer } from '../../../src/core/bounded-jsonl-tail';
import { appendTaskEvent, appendTaskEventAsync, inspectTaskEventFile, buildEventIntegrityHash } from '../../../src/gate-runtime/task-events';
import { readTaskTimelineCadenceWindow } from '../../../src/gate-runtime/timeline/task-events-integrity';
import { taskCadenceHeadPath, CADENCE_WINDOW_LIMITS } from '../../../src/gate-runtime/timeline/task-cadence-runtime';
import { readTaskTimelineJsonlEntries, readTaskTimelineEntryStartByte, readTaskTimelineValidationJsonLinesCompatible } from '../../../src/gate-runtime/timeline/task-events-helpers';
import { withTaskTimelineFileReadSnapshot } from '../../../src/gate-runtime/timeline/task-timeline-read-snapshot';
import { admitNativeReviewCadence } from '../../../src/gates/review-attempts/review-cadence-admission';

function fixture(t: TestContext) {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-cadence-native-'));
    t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
    execFileSync('git', ['init', '--quiet', repoRoot]);
    const bundle = path.join(repoRoot, 'garda-agent-orchestrator'), taskId = 'T-CADENCE-NATIVE';
    const timeline = path.join(bundle, 'runtime', 'task-events', taskId + '.jsonl');
    const report = path.join(repoRoot, 'closed-report.md');
    fs.writeFileSync(report, '# Review\n## Verdict\nREVIEW FAILED\n');
    const head = taskCadenceHeadPath(timeline, taskId);
    const details = () => admitNativeReviewCadence(repoRoot, taskId, { review_type: 'code',
        review_artifact_snapshot_path: report,
        review_artifact_snapshot_sha256: createHash('sha256').update(fs.readFileSync(report)).digest('hex') });
    const append = (type: string, value: unknown) => appendTaskEvent(bundle, taskId, type, 'PASS', 'Native event.', value,
        { passThru: true, lowNoiseRuntimeWrites: true });
    const read = () => withInvocationReadObservation(() => readTaskTimelineCadenceWindow(timeline, taskId));
    return { repoRoot, bundle, taskId, timeline, report, head, details, append, read };
}

test('native record append publishes the head and five consumers reuse one verified cadence capture without archive reads', t => {
    const f = fixture(t);
    const admitted = f.details();
    assert.equal(f.append('QUALITY_CHECKLIST_RECORDED', { status: 'PASS' })?.canonical_committed, true);
    assert.equal(f.append('REVIEW_RECORDED', admitted)?.commit_status, 'committed');
    assert.equal(fs.existsSync(f.head), true);
    const nativeFs = require('node:fs') as typeof fs, original = nativeFs.readFileSync;
    const readMock = t.mock.method(nativeFs, 'readFileSync', (...args: Parameters<typeof fs.readFileSync>) => {
        assert.notEqual(path.resolve(String(args[0])), path.resolve(f.report), 'Covered navigation cannot reread the archive Markdown');
        return original(...args);
    });
    let measured: NextStepMeasurement | undefined;
    try {
        withNextStepMeasurement(() => withInvocationReadObservation(() => {
            for (let consumer = 0; consumer < 5; consumer += 1) {
                const window = readTaskTimelineCadenceWindow(f.timeline, f.taskId);
                assert.ok(window?.available); assert.equal(window.ordinary.failureCount, 1);
                assert.equal(window.ordinary.hasBaseline, true);
            }
        }), value => { measured = value; });
    } finally { readMock.mock.restore(); }
    assert.equal(measured!.work.timeline_verify, 1);
    assert.equal(measured!.work.timeline_parse, 1);
    assert.equal(measured!.work.cadence_head_hmac_verify, 1);
    assert.equal(measured!.work.cadence_record_hmac_verify || 0, 0);
    assert.equal(measured!.work['visit:cadence_window_search_slot'], 14);
});

test('sync and async unrelated appends refresh the exact head and evict the old bounded window', async t => {
    const f = fixture(t);
    f.append('QUALITY_CHECKLIST_RECORDED', { status: 'PASS' });
    f.append('REVIEW_RECORDED', f.details());
    assert.equal(f.read()?.ordinary.failureCount, 1);
    const result = await appendTaskEventAsync(f.bundle, f.taskId, 'UNRELATED', 'PASS', 'Evict old records.',
        { padding: 'x'.repeat(CADENCE_WINDOW_LIMITS.maxBytes + 100) }, { passThru: true, lowNoiseRuntimeWrites: true });
    assert.equal(result?.commit_status, 'committed');
    const bytes = fs.readFileSync(f.timeline);
    const native = readBoundedJsonlTailBuffer(bytes, bytes.length, CADENCE_WINDOW_LIMITS);
    assert.equal(native.records.length, 0);
    const projected = f.read();
    assert.ok(projected?.available);
    assert.deepEqual(projected.ordinary, { hasBaseline: false, failureCount: 0, testResetPending: false });
    assert.equal(projected.parseAttempts, native.parseAttempts);
});

test('failed publication restores old certificate or restores absence while preserving the committed native event', t => {
    for (const existing of [false, true]) {
        const f = fixture(t), admitted = f.details();
        if (existing) f.append('QUALITY_CHECKLIST_RECORDED', { status: 'PASS' });
        const beforeHead = existing ? fs.readFileSync(f.head) : null;
        const nativeFs = require('node:fs') as typeof fs, rename = nativeFs.renameSync;
        let injected = false;
        const renameMock = t.mock.method(nativeFs, 'renameSync', (source: fs.PathLike, destination: fs.PathLike) => {
            rename(source, destination);
            if (!injected && path.resolve(String(destination)) === path.resolve(f.head)) {
                injected = true; throw Object.assign(new Error('Injected cadence publication failure'), { code: 'EPERM' });
            }
        });
        let result: ReturnType<typeof f.append>;
        try { result = f.append('REVIEW_RECORDED', admitted); }
        finally { renameMock.mock.restore(); }
        assert.equal(injected, true);
        assert.equal(result?.canonical_committed, true);
        assert.equal(result?.commit_status, 'committed_with_derived_index_failure');
        assert.match(result!.derived_warnings.join(' '), /cadence publication failure/iu);
        if (beforeHead) assert.deepEqual(fs.readFileSync(f.head), beforeHead);
        else assert.equal(fs.existsSync(f.head), false);
        assert.equal(f.read(), null, 'Missing/mismatched head must select the native fallback');
        assert.equal(inspectTaskEventFile(f.timeline, f.taskId).status, 'PASS');
        assert.equal(f.append('UNRELATED', {})?.commit_status, 'committed');
        assert.ok(f.read()?.available, 'Only the subsequent native writer bootstraps the missing/mismatched head');
    }
});

test('malformed UTF-8 retains exact private parser offsets and the verified public entry shape', t => {
    const f = fixture(t);
    f.append('REVIEW_RECORDED', f.details());
    f.append('UNRELATED', { marker: '\ufffd' });
    const bytes = fs.readFileSync(f.timeline);
    const marker = Buffer.from('\ufffd'); const at = bytes.indexOf(marker);
    assert.ok(at >= 0);
    const changed = Buffer.concat([bytes.subarray(0, at), Buffer.from([0xff]), bytes.subarray(at + marker.length)]);
    fs.writeFileSync(f.timeline, changed);
    assert.equal(inspectTaskEventFile(f.timeline, f.taskId).status, 'PASS');
    // The writer verifies the actual altered bytes and renews the head; no new UTF-8 rejection is introduced.
    assert.equal(f.append('UNRELATED', {})?.commit_status, 'committed');
    const all = fs.readFileSync(f.timeline);
    withTaskTimelineFileReadSnapshot(f.timeline, () => {
        const entries = readTaskTimelineJsonlEntries(f.timeline);
        let offset = 0;
        for (const entry of entries) {
            assert.equal(readTaskTimelineEntryStartByte(entry), offset);
            assert.deepEqual(Object.keys(entry).sort(), ['lineNumber', 'rawLine', 'record']);
            offset = all.indexOf(0x0a, offset) + 1;
        }
    });
    assert.ok(f.read()?.available);
});

test('forged rehashed cadence bits and old head certificates cannot bypass legacy fallback', t => {
    const f = fixture(t);
    f.append('REVIEW_RECORDED', f.details());
    const record = JSON.parse(fs.readFileSync(f.timeline, 'utf8').trim()) as Record<string, unknown>;
    (record.details as Record<string, unknown>).cadence_failed = false;
    (record.integrity as Record<string, unknown>).event_sha256 = buildEventIntegrityHash(record);
    fs.writeFileSync(f.timeline, JSON.stringify(record) + '\n');
    assert.equal(inspectTaskEventFile(f.timeline, f.taskId).status, 'PASS');
    assert.equal(f.read(), null);
    f.append('UNRELATED', {});
    assert.equal(f.read(), null, 'The generic append must never bootstrap an invalid present admission');
});

test('A1 rejects a consumed head replacement after the cadence decision', t => {
    const f = fixture(t); f.append('REVIEW_RECORDED', f.details());
    assert.throws(() => withInvocationReadObservation(() => {
        assert.ok(readTaskTimelineCadenceWindow(f.timeline, f.taskId));
        const replacement = f.head + '.replacement';
        fs.writeFileSync(replacement, fs.readFileSync(f.head)); fs.renameSync(replacement, f.head);
    }), /Invocation file observation changed/iu);
});


test('private validation line compatibility preserves the native whitespace-only rejection boundary', t => {
    const f = fixture(t); f.append('UNRELATED', {});
    const original = fs.readFileSync(f.timeline, 'utf8');
    for (const [prefix, suffix] of [['', ''], ['\n', ''], ['\r\n', ''], ['', '\r\n'],
        [' \n', ''], ['', ' '], ['', '\r'], ['', ' \r\n'], ['', '\t\n']]) {
        const bytes = prefix + original + suffix;
        fs.writeFileSync(f.timeline, bytes);
        let expected = true;
        try { bytes.split(/\r?\n/u).filter(Boolean).forEach(line => JSON.parse(line)); }
        catch { expected = false; }
        withTaskTimelineFileReadSnapshot(f.timeline, () => {
            assert.equal(readTaskTimelineValidationJsonLinesCompatible(f.timeline), expected,
                JSON.stringify({ prefix, suffix }));
            // Repeated metadata access neither reparses nor exposes an enumerable entry field.
            assert.equal(readTaskTimelineValidationJsonLinesCompatible(f.timeline), expected);
        });
    }
});
