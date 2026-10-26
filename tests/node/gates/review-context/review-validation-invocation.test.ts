import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { withInvocationReadObservation } from '../../../../src/core/invocation-read-observation';
import { readReviewContextTrustBoundaryAnalysis } from '../../../../src/gates/review-context/review-context-trust-boundary-analysis';
import { inspectQualityValidationPhases } from '../../../../src/gates/quality-checklist/quality-checklist-validation-phases';
import { readReviewValidationBytes } from '../../../../src/gates/review-context/review-validation-invocation';

test('Q3 quality capture preserves the native byte reader above the retained Q2 bound', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-q3-large-quality-'));
    try {
        const file = path.join(root, 'quality.json');
        const size = 128 * 1024 * 1024 + 1;
        const fd = fs.openSync(file, 'w');
        try {
            fs.ftruncateSync(fd, size);
            fs.writeSync(fd, Buffer.from('x'), 0, 1, size - 1);
        } finally { fs.closeSync(fd); }
        withInvocationReadObservation(() => {
            const actual = readReviewValidationBytes(file);
            assert.equal(actual.length, size);
            assert.equal(actual[0], 0);
            assert.equal(actual[size - 1], 'x'.charCodeAt(0));
        });
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('Q3 quality capture preserves contained symbolic-link reads', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-q3-linked-quality-'));
    try {
        const target = path.join(root, 'quality-target.json'), alias = path.join(root, 'quality.json');
        const bytes = Buffer.from('{"schema_version":1}\n');
        fs.writeFileSync(target, bytes);
        try { fs.symlinkSync(target, alias, 'file'); }
        catch (error) {
            if (['EPERM', 'EACCES'].includes(String((error as NodeJS.ErrnoException).code))) {
                t.skip('Creating a native symbolic link requires unavailable host permission.');
                return;
            }
            throw error;
        }
        withInvocationReadObservation(() => assert.deepEqual(readReviewValidationBytes(alias), bytes));
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});


test('Q3 quality analysis does not project accessor options into an ordinary memo key', t => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-q3-quality-options-'));
    t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
    const applicable = { triggers: { security: true } }, plain = { repoRoot, taskId: null, preflightSha256: null, preflight: applicable };
    const native = readReviewContextTrustBoundaryAnalysis(plain);
    assert.equal(native.status, 'invalid');
    const invoke = () => {
        let reads = 0;
        const accessor = { ...plain, get preflight() { reads += 1; return reads <= 2 ? applicable : {}; } };
        return { result: readReviewContextTrustBoundaryAnalysis(accessor), reads };
    };
    const expected = invoke();
    withInvocationReadObservation(() => {
        assert.deepEqual(invoke(), expected);
        assert.deepEqual(readReviewContextTrustBoundaryAnalysis(plain), native);
    });
});

test('Q3 quality phase options retain native accessor evaluation and cannot seed a false hit', t => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-q3-phase-options-'));
    t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
    const bound = { project_validation: { authority_sha256: 'a'.repeat(64) } };
    const plain = { repoRoot, taskId: 'T-Q3-PHASE', preflightSha256: null, preflight: bound, matrixRequired: false, matrix: null };
    const invoke = () => {
        let reads = 0;
        const accessor = { ...plain, get preflight() { reads += 1; return reads === 1 ? bound : {}; } };
        let error: unknown;
        try { inspectQualityValidationPhases(accessor); } catch (caught) { error = caught; }
        assert.ok(error instanceof Error);
        return { reads, message: error.message };
    };
    const expected = invoke();
    withInvocationReadObservation(() => {
        assert.deepEqual(invoke(), expected);
        assert.throws(() => inspectQualityValidationPhases(plain), /authority changed/u);
    });
});
