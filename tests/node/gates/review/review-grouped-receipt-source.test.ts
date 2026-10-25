import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { hasAuthenticatedIntermediateGroupedReceiptSource } from '../../../../src/gates/review/review-grouped-receipt-source';

for (const failure of ['non-directory timeline root', 'malformed repository path']) {
    test(`grouped receipt proof fails closed for ${failure}`, t => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-grouped-proof-'));
        t.after(() => fs.rmSync(root, { recursive: true, force: true }));
        const runtime = path.join(root, 'garda-agent-orchestrator', 'runtime');
        fs.mkdirSync(runtime, { recursive: true });
        fs.writeFileSync(path.join(runtime, 'task-events'), 'not a directory');
        const receiptPath = path.join(runtime, 'reviews', 'T-77-code-receipt.json');
        assert.equal(hasAuthenticatedIntermediateGroupedReceiptSource({
            repoRoot: failure === 'malformed repository path' ? `${root}\0invalid` : root,
            taskId: 'T-77', reviewType: 'code',
            receipt: { reused_existing_review: true, reused_from_receipt_sha256: 'a'.repeat(64) },
            receiptPath, receiptSha256: 'b'.repeat(64),
            sourceReceiptPath: receiptPath, sourceReceiptSha256: 'c'.repeat(64)
        }), false);
    });
}
