import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { withInvocationReadObservation } from '../../../../src/core/invocation-read-observation';
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
