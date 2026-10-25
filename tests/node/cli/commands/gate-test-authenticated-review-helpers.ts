import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { appendTaskEvent } from '../../../../src/gate-runtime/task-events';
import { buildReviewReceiptReviewerInvocationProvenance } from '../../../../src/gate-runtime/review-context';
import { seedAuthenticatedReviewerLaunchFixture } from '../../gates/next-step/next-step-reviewer-launch-fixtures';
import { getReviewsRoot, getOrchestratorRoot, readTaskTimelineEvents } from './gate-test-helpers';

function sha256File(filePath: string): string {
    return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

export function authenticateCurrentReviewLaunch(repoRoot: string, taskId: string, reviewType: string): void {
    const reviewsRoot = getReviewsRoot(repoRoot);
    const receiptPath = path.join(reviewsRoot, `${taskId}-${reviewType}-receipt.json`);
    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    const invocationHolder: { event?: ReturnType<typeof appendTaskEvent> } = {};
    let invocationDetails: Record<string, unknown> = {};
    seedAuthenticatedReviewerLaunchFixture({
        repoRoot, taskId, reviewType, reviewerIdentity: receipt.reviewer_identity,
        reviewContextPath: path.join(reviewsRoot, `${taskId}-${reviewType}-review-context.json`),
        reviewTreeStateSha256: receipt.review_tree_state_sha256,
        appendEvent(root, id, type, outcome, details) {
            const event = appendTaskEvent(getOrchestratorRoot(root), id, type, outcome || 'INFO', type, details, { passThru: true });
            assert.ok(event?.integrity);
            if (type === 'REVIEWER_INVOCATION_ATTESTED') { invocationHolder.event = event; invocationDetails = details || {}; }
            return { task_sequence: Number(event.integrity.task_sequence), prev_event_sha256: event.integrity.prev_event_sha256 ?? null, event_sha256: String(event.integrity.event_sha256) };
        }
    });
    const invocation = invocationHolder.event;
    assert.ok(invocation?.integrity);
    receipt.reviewer_provenance = buildReviewReceiptReviewerInvocationProvenance('REVIEWER_INVOCATION_ATTESTED', invocation.integrity, invocationDetails);
    receipt.review_output_contract.reviewer_provenance_event_sha256 = invocation.integrity.event_sha256;
    fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
    const hash = sha256File(receiptPath);
    const snapshotPath = receiptPath.replace(/\.json$/u, `-${hash}.json`);
    fs.copyFileSync(receiptPath, snapshotPath);
    const previous = [...readTaskTimelineEvents(repoRoot, taskId)].reverse().find(event => event.event_type === 'REVIEW_RECORDED'
        && (event.details as Record<string, unknown>)?.review_type === reviewType);
    appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'REVIEW_RECORDED', 'PASS', 'Authenticated current review fixture.', {
        ...previous?.details as Record<string, unknown>, ...receipt,
        receipt_path: receiptPath.replace(/\\/gu, '/'), receipt_sha256: hash,
        receipt_snapshot_path: snapshotPath.replace(/\\/gu, '/'), receipt_snapshot_sha256: hash
    });
}
