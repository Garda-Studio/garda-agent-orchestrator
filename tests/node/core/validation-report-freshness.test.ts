import test from 'node:test';
import assert from 'node:assert/strict';
import { assertFreshValidationReport } from '../../../src/core/validation-report-capture';
import type { ValidationFileObservation } from '../../../src/core/project-validation-identity';

function observation(inode: string, hash: string, created = '1', modified = '2'): ValidationFileObservation {
    return { identity: { path: 'reports/result.xml', identity: `1:${inode}:${created}`, sha256: hash.repeat(64), size: 1 },
        created_ns: created, modified_ns: modified, changed_ns: modified };
}

test('T-404 accepts identical bytes in a new report identity with tunneled creation time', () => {
    assert.doesNotThrow(() => assertFreshValidationReport(observation('11', 'a', '1', '11'),
        observation('10', 'a'), 10n, '1970-01-01T00:00:00.001Z'));
});

test('T-404 rejects a touched foreign report with unrelated old creation time', () => {
    assert.throws(() => assertFreshValidationReport(observation('11', 'b', '2', '11'),
        observation('10', 'a'), 10n, '1970-01-01T00:00:00.001Z'), /foreign/);
});
