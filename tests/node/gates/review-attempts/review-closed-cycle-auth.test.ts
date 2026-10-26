import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { withInvocationReadObservation } from '../../../../src/core/invocation-read-observation';
import { resolveClosedReviewAuthentication, encodeClosedReviewEnvelope, decodeClosedReviewEnvelope }
    from '../../../../src/gates/review-attempts/review-closed-cycle-auth';

for (const throughAlias of [false, true]) {
    test(`native producer and observed reader retain the same worktree authentication${throughAlias ? ' through a real directory alias' : ''}`, t => {
        const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-closed-auth-'));
        t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
        const root = path.join(parent, 'repository');
        fs.mkdirSync(root);
        execFileSync('git', ['init', '--quiet', root], { stdio: 'pipe' });
        const producer = resolveClosedReviewAuthentication(root, true);
        const entry = throughAlias ? path.join(parent, 'repository-alias') : root;
        if (throughAlias) {
            try { fs.symlinkSync(root, entry, process.platform === 'win32' ? 'junction' : 'dir'); }
            catch (error) {
                if (['EPERM', 'EACCES', 'ENOTSUP'].includes(String((error as NodeJS.ErrnoException).code))) {
                    t.skip('Native directory aliases are unavailable in this environment.'); return;
                }
                throw error;
            }
        }
        const payload = { task_id: 'T-auth-parity', marker: 'native producer' };
        const signed = encodeClosedReviewEnvelope(producer, 'navigation', payload);
        const observed = withInvocationReadObservation(() => {
            const reader = resolveClosedReviewAuthentication(entry, false);
            assert.deepEqual(reader, producer);
            assert.deepEqual(decodeClosedReviewEnvelope(reader, 'navigation', signed), payload);
            return encodeClosedReviewEnvelope(reader, 'cadence', payload);
        });
        assert.deepEqual(decodeClosedReviewEnvelope(producer, 'cadence', observed), payload);
    });
}
