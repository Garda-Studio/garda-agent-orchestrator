import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    validateStrictReusedReviewEvidence,
    validateHistoricalReviewRecordedTelemetryEventMatch,
    type ReviewReuseTelemetryEventLike
} from '../../../../src/gates/review-reuse/review-reuse-telemetry';

function sha256(content: string): string {
    return crypto.createHash('sha256').update(content).digest('hex');
}

function normalizeTestPath(value: string): string {
    return value.replace(/\\/g, '/');
}

function writeText(filePath: string, content: string): string {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
    return sha256(content);
}

function buildStrictReuseFixture(reviewType = 'code') {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-strict-reuse-'));
    const taskId = 'T-368';
    const reviewsRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews');
    fs.mkdirSync(reviewsRoot, { recursive: true });
    const reviewLabel = reviewType === 'test' ? 'Test Review' : 'Code Review';
    const passVerdict = reviewType === 'test' ? 'TEST REVIEW PASSED' : 'REVIEW PASSED';

    const receiptPath = path.join(reviewsRoot, `${taskId}-${reviewType}-receipt.json`);
    const artifactPath = path.join(reviewsRoot, `${taskId}-${reviewType}.md`);
    const artifactText = [
        `# ${reviewLabel}`,
        'Reviewed strict reused-review evidence bindings.',
        '## Findings by Severity',
        'none',
        '## Residual Risks',
        'none',
        '## Verdict',
        passVerdict,
        ''
    ].join('\n');
    const artifactSha = writeText(artifactPath, artifactText);
    const artifactSnapshotPath = path.join(reviewsRoot, `${taskId}-${reviewType}-artifact-${artifactSha}.md`);
    writeText(artifactSnapshotPath, artifactText);

    const currentContextSha = 'a'.repeat(64);
    const currentContextReuseSha = 'b'.repeat(64);
    const currentTreeStateSha = 'c'.repeat(64);
    const currentReviewScopeSha = 'd'.repeat(64);
    const currentCodeScopeSha = 'e'.repeat(64);
    const sourceContextSha = '1'.repeat(64);
    const sourceContextReuseSha = '2'.repeat(64);
    const sourceTreeStateSha = '3'.repeat(64);
    const sourceReviewScopeSha = '4'.repeat(64);
    const sourceCodeScopeSha = '5'.repeat(64);
    const routingEventSha = '6'.repeat(64);
    const invocationEventSha = '7'.repeat(64);
    const historicalReviewRecordedSha = '8'.repeat(64);
    const currentReviewRecordedSha = '9'.repeat(64);
    const reviewerIdentity = 'agent:strict-reviewer';
    const reviewerProvenance = {
        schema_version: 1,
        attestation_type: 'reviewer_invocation_attestation',
        controller_event_type: 'REVIEWER_INVOCATION_ATTESTED',
        task_sequence: 4,
        prev_event_sha256: routingEventSha,
        event_sha256: invocationEventSha,
        task_id: taskId,
        review_type: reviewType,
        reviewer_execution_mode: 'delegated_subagent',
        reviewer_identity: reviewerIdentity,
        review_context_sha256: sourceContextSha,
        review_tree_state_sha256: sourceTreeStateSha,
        routing_event_sha256: routingEventSha
    };

    const baseReceipt = {
        task_id: taskId,
        review_type: reviewType,
        review_artifact_sha256: artifactSha,
        reviewer_execution_mode: 'delegated_subagent',
        reviewer_identity: reviewerIdentity,
        reviewer_provenance: reviewerProvenance,
        trust_level: 'INDEPENDENT_AUDITED'
    };
    const sourceReceipt = {
        ...baseReceipt,
        review_context_sha256: sourceContextSha,
        review_context_reuse_sha256: sourceContextReuseSha,
        review_tree_state_sha256: sourceTreeStateSha,
        review_scope_sha256: sourceReviewScopeSha,
        code_scope_sha256: sourceCodeScopeSha,
        reused_existing_review: false
    };
    const sourceReceiptPayload = `${JSON.stringify(sourceReceipt, null, 2)}\n`;
    const sourceReceiptSha = sha256(sourceReceiptPayload);
    const sourceReceiptSnapshotPath = path.join(reviewsRoot, `${taskId}-${reviewType}-receipt-${sourceReceiptSha}.json`);
    writeText(sourceReceiptSnapshotPath, sourceReceiptPayload);

    const currentReceipt = {
        ...baseReceipt,
        review_context_sha256: currentContextSha,
        review_context_reuse_sha256: currentContextReuseSha,
        review_tree_state_sha256: currentTreeStateSha,
        review_scope_sha256: currentReviewScopeSha,
        code_scope_sha256: currentCodeScopeSha,
        reused_existing_review: true,
        reused_from_receipt_path: normalizeTestPath(receiptPath),
        reused_from_receipt_sha256: sourceReceiptSha,
        reused_from_review_context_sha256: sourceContextSha,
        reused_from_review_context_reuse_sha256: sourceContextReuseSha,
        reused_from_review_tree_state_sha256: sourceTreeStateSha,
        reused_from_review_scope_sha256: sourceReviewScopeSha,
        reused_from_code_scope_sha256: sourceCodeScopeSha
    };
    const currentReceiptPayload = `${JSON.stringify(currentReceipt, null, 2)}\n`;
    const currentReceiptSha = writeText(receiptPath, currentReceiptPayload);
    const currentReceiptSnapshotPath = path.join(reviewsRoot, `${taskId}-${reviewType}-receipt-${currentReceiptSha}.json`);
    writeText(currentReceiptSnapshotPath, currentReceiptPayload);

    const invocationEvent = {
        event_type: 'REVIEWER_INVOCATION_ATTESTED',
        sequence: 4,
        integrity: {
            task_sequence: 4,
            prev_event_sha256: routingEventSha,
            event_sha256: invocationEventSha
        },
        details: {
            task_id: taskId,
            review_type: reviewType,
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_identity: reviewerIdentity,
            review_context_sha256: sourceContextSha,
            review_tree_state_sha256: sourceTreeStateSha,
            routing_event_sha256: routingEventSha
        }
    };
    const historicalReviewRecordedEvent = {
        event_type: 'REVIEW_RECORDED',
        outcome: 'PASS',
        sequence: 5,
        integrity: {
            task_sequence: 5,
            event_sha256: historicalReviewRecordedSha
        },
        details: {
            ...sourceReceipt,
            receipt_path: normalizeTestPath(receiptPath),
            receipt_sha256: sourceReceiptSha,
            receipt_snapshot_path: normalizeTestPath(sourceReceiptSnapshotPath),
            receipt_snapshot_sha256: sourceReceiptSha,
            review_artifact_path: normalizeTestPath(artifactPath),
            review_artifact_snapshot_path: normalizeTestPath(artifactSnapshotPath),
            review_artifact_snapshot_sha256: artifactSha
        }
    };
    const currentReviewRecordedEvent = {
        event_type: 'REVIEW_RECORDED',
        outcome: 'PASS',
        sequence: 11,
        integrity: {
            task_sequence: 11,
            event_sha256: currentReviewRecordedSha
        },
        details: {
            ...currentReceipt,
            receipt_path: normalizeTestPath(receiptPath),
            receipt_sha256: currentReceiptSha,
            receipt_snapshot_path: normalizeTestPath(currentReceiptSnapshotPath),
            receipt_snapshot_sha256: currentReceiptSha,
            review_artifact_path: normalizeTestPath(artifactPath),
            review_artifact_snapshot_path: normalizeTestPath(artifactSnapshotPath),
            review_artifact_snapshot_sha256: artifactSha
        }
    };
    const events: ReviewReuseTelemetryEventLike[] = [
        invocationEvent,
        historicalReviewRecordedEvent,
        currentReviewRecordedEvent
    ];
    const input = {
        repoRoot,
        taskId,
        reviewType,
        events,
        receiptPath: normalizeTestPath(receiptPath),
        receiptSha256: currentReceiptSha,
        reviewContextSha256: currentContextSha,
        reviewContextReuseSha256: currentContextReuseSha,
        reviewTreeStateSha256: currentTreeStateSha,
        reviewScopeSha256: currentReviewScopeSha,
        codeScopeSha256: currentCodeScopeSha,
        reviewArtifactSha256: artifactSha,
        reusedFromReceiptPath: normalizeTestPath(receiptPath),
        reusedFromReceiptSha256: sourceReceiptSha,
        reusedFromReviewContextSha256: sourceContextSha,
        reusedFromReviewContextReuseSha256: sourceContextReuseSha,
        reusedFromReviewTreeStateSha256: sourceTreeStateSha,
        reusedFromReviewScopeSha256: sourceReviewScopeSha,
        reusedFromCodeScopeSha256: sourceCodeScopeSha,
        reviewerExecutionMode: 'delegated_subagent',
        reviewerIdentity,
        reviewerProvenance,
        latestCompileTaskSequence: 10,
        latestCompileEventSequence: 10
    };

    return {
        input,
        events,
        receiptPath,
        artifactPath,
        currentReceiptSnapshotPath,
        sourceReceiptSnapshotPath,
        artifactSnapshotPath,
        reviewsRoot,
        taskId,
        reviewType,
        historicalReviewRecordedEvent,
        currentReviewRecordedEvent,
        invocationEvent
    };
}

describe('gates/review-reuse-telemetry', () => {
    it('accepts strict reused review evidence with current reuse and historical source bindings', () => {
        const { input } = buildStrictReuseFixture();

        const result = validateStrictReusedReviewEvidence(input);

        assert.equal(result.valid, true, result.valid ? undefined : result.reason);
        assert.equal(result.reason, null);
        if (result.valid) {
            assert.equal(result.currentReuseEventTaskSequence, 11);
            assert.equal(result.historicalReviewRecordedTaskSequence, 5);
            assert.equal(result.historicalReviewerInvocationTaskSequence, 4);
        }
    });

    it('computes the current reused receipt hash when callers omit receiptSha256', () => {
        const { input } = buildStrictReuseFixture();
        const inputWithoutReceiptSha = { ...input };
        delete (inputWithoutReceiptSha as { receiptSha256?: string }).receiptSha256;

        const result = validateStrictReusedReviewEvidence(inputWithoutReceiptSha);

        assert.equal(result.valid, true, result.valid ? undefined : result.reason);
    });

    it('rejects strict reused review evidence when the current receipt is tampered after reuse telemetry', () => {
        const { input, receiptPath } = buildStrictReuseFixture();
        fs.appendFileSync(receiptPath, 'tampered\n', 'utf8');

        const result = validateStrictReusedReviewEvidence(input);

        assert.equal(result.valid, false);
        assert.match((result as { valid: false; reason: string }).reason, /current reused review receipt hash no longer matches/);
    });

    it('rejects strict reused review evidence when the current review artifact is tampered after reuse telemetry', () => {
        const { input, artifactPath } = buildStrictReuseFixture();
        fs.appendFileSync(artifactPath, 'tampered\n', 'utf8');

        const result = validateStrictReusedReviewEvidence(input);

        assert.equal(result.valid, false);
        assert.match((result as { valid: false; reason: string }).reason, /current reused review artifact hash no longer matches/);
    });

    it('rejects strict reused review evidence when current receipt snapshot hash is not bound to receipt hash', () => {
        const { input, currentReviewRecordedEvent } = buildStrictReuseFixture();
        const details = currentReviewRecordedEvent.details as Record<string, unknown>;
        details.receipt_snapshot_sha256 = 'f'.repeat(64);

        const result = validateStrictReusedReviewEvidence(input);

        assert.equal(result.valid, false);
        assert.match((result as { valid: false; reason: string }).reason, /current-cycle REVIEW_RECORDED reuse telemetry.*receipt_snapshot_hash_not_bound_to_receipt_hash/);
    });

    it('rejects strict reused review evidence when current artifact snapshot hash is not bound to artifact hash', () => {
        const { input, currentReviewRecordedEvent } = buildStrictReuseFixture();
        const details = currentReviewRecordedEvent.details as Record<string, unknown>;
        details.review_artifact_snapshot_sha256 = 'f'.repeat(64);

        const result = validateStrictReusedReviewEvidence(input);

        assert.equal(result.valid, false);
        assert.match((result as { valid: false; reason: string }).reason, /current-cycle REVIEW_RECORDED reuse telemetry.*review_artifact_snapshot_hash_not_bound_to_artifact_hash/);
    });

    it('rejects strict reused review evidence when current reuse telemetry lacks integrity', () => {
        const { input, currentReviewRecordedEvent } = buildStrictReuseFixture();
        delete (currentReviewRecordedEvent as { integrity?: unknown }).integrity;

        const result = validateStrictReusedReviewEvidence(input);

        assert.equal(result.valid, false);
        assert.match((result as { valid: false; reason: string }).reason, /current-cycle REVIEW_RECORDED reuse telemetry.*missing_integrity/);
    });

    it('rejects a passing generic record combined with failed strict current reuse telemetry', () => {
        const { input, currentReviewRecordedEvent } = buildStrictReuseFixture();
        currentReviewRecordedEvent.outcome = 'FAIL';
        const genericDetails = {
            ...(currentReviewRecordedEvent.details as Record<string, unknown>)
        };
        for (const key of [
            'reused_existing_review',
            'reused_from_receipt_path',
            'reused_from_receipt_sha256',
            'reused_from_review_context_sha256',
            'reused_from_review_context_reuse_sha256',
            'reused_from_review_tree_state_sha256',
            'reused_from_review_scope_sha256',
            'reused_from_code_scope_sha256'
        ]) {
            delete genericDetails[key];
        }
        input.events.push({
            event_type: 'REVIEW_RECORDED',
            outcome: 'PASS',
            sequence: 12,
            integrity: {
                task_sequence: 12,
                event_sha256: 'f'.repeat(64)
            },
            details: genericDetails
        });

        const result = validateStrictReusedReviewEvidence(input);

        assert.equal(result.valid, false);
        assert.match((result as { valid: false; reason: string }).reason, /current-cycle REVIEW_RECORDED reuse telemetry/);
    });

    it('rejects strict reused review evidence when current receipt snapshot path is missing', () => {
        const { input, currentReviewRecordedEvent } = buildStrictReuseFixture();
        delete (currentReviewRecordedEvent.details as Record<string, unknown>).receipt_snapshot_path;

        const result = validateStrictReusedReviewEvidence(input);

        assert.equal(result.valid, false);
        assert.match((result as { valid: false; reason: string }).reason, /current-cycle REVIEW_RECORDED reuse telemetry.*receipt_snapshot_path_missing/);
    });

    it('rejects strict reused review evidence when current artifact snapshot path is missing', () => {
        const { input, currentReviewRecordedEvent } = buildStrictReuseFixture();
        delete (currentReviewRecordedEvent.details as Record<string, unknown>).review_artifact_snapshot_path;

        const result = validateStrictReusedReviewEvidence(input);

        assert.equal(result.valid, false);
        assert.match((result as { valid: false; reason: string }).reason, /current-cycle REVIEW_RECORDED reuse telemetry.*review_artifact_snapshot_path_missing/);
    });

    it('rejects strict reused review evidence when the current receipt snapshot is tampered', () => {
        const { input, currentReceiptSnapshotPath } = buildStrictReuseFixture();
        fs.appendFileSync(currentReceiptSnapshotPath, 'tampered\n', 'utf8');

        const result = validateStrictReusedReviewEvidence(input);

        assert.equal(result.valid, false);
        assert.match((result as { valid: false; reason: string }).reason, /current-cycle REVIEW_RECORDED reuse telemetry.*receipt_snapshot_hash_mismatch/);
    });

    it('rejects strict reused review evidence when the current artifact snapshot is tampered', () => {
        const { input, artifactSnapshotPath } = buildStrictReuseFixture();
        fs.appendFileSync(artifactSnapshotPath, 'tampered\n', 'utf8');

        const result = validateStrictReusedReviewEvidence(input);

        assert.equal(result.valid, false);
        assert.match((result as { valid: false; reason: string }).reason, /current-cycle REVIEW_RECORDED reuse telemetry.*review_artifact_snapshot_hash_mismatch/);
    });

    it('rejects strict reused review evidence when historical receipt snapshot hash is not the reused receipt hash', () => {
        const { input, reviewsRoot, taskId, reviewType, historicalReviewRecordedEvent } = buildStrictReuseFixture();
        const alternateReceiptPayload = `${JSON.stringify({ alternate: true }, null, 2)}\n`;
        const alternateReceiptSha = sha256(alternateReceiptPayload);
        const alternateReceiptSnapshotPath = path.join(reviewsRoot, `${taskId}-${reviewType}-receipt-${alternateReceiptSha}.json`);
        writeText(alternateReceiptSnapshotPath, alternateReceiptPayload);
        const details = historicalReviewRecordedEvent.details as Record<string, unknown>;
        details.receipt_snapshot_path = normalizeTestPath(alternateReceiptSnapshotPath);
        details.receipt_snapshot_sha256 = alternateReceiptSha;

        const result = validateStrictReusedReviewEvidence(input);

        assert.equal(result.valid, false);
        assert.match((result as { valid: false; reason: string }).reason, /receipt_snapshot_hash_not_bound_to_receipt_hash/);
    });

    it('rejects strict reused review evidence when historical artifact snapshot hash is not the reused artifact hash', () => {
        const { input, reviewsRoot, taskId, reviewType, historicalReviewRecordedEvent } = buildStrictReuseFixture();
        const alternateArtifactText = [
            '# Code Review',
            'Alternate pass artifact.',
            '## Findings by Severity',
            'none',
            '## Residual Risks',
            'none',
            '## Verdict',
            'REVIEW PASSED',
            ''
        ].join('\n');
        const alternateArtifactSha = sha256(alternateArtifactText);
        const alternateArtifactSnapshotPath = path.join(reviewsRoot, `${taskId}-${reviewType}-artifact-${alternateArtifactSha}.md`);
        writeText(alternateArtifactSnapshotPath, alternateArtifactText);
        const details = historicalReviewRecordedEvent.details as Record<string, unknown>;
        details.review_artifact_snapshot_path = normalizeTestPath(alternateArtifactSnapshotPath);
        details.review_artifact_snapshot_sha256 = alternateArtifactSha;

        const result = validateStrictReusedReviewEvidence(input);

        assert.equal(result.valid, false);
        assert.match((result as { valid: false; reason: string }).reason, /review_artifact_snapshot_hash_not_bound_to_artifact_hash/);
    });

    it('rejects non-test strict reused review evidence without code-scope hashes', () => {
        const { input } = buildStrictReuseFixture();
        const inputWithoutCodeScope = { ...input, codeScopeSha256: null, reusedFromCodeScopeSha256: null };

        const result = validateStrictReusedReviewEvidence(inputWithoutCodeScope);

        assert.equal(result.valid, false);
        assert.match((result as { valid: false; reason: string }).reason, /current code_scope_sha256/);
    });

    it('accepts strict reused test review evidence without code-scope hashes', () => {
        const { input } = buildStrictReuseFixture('test');
        const inputWithoutCodeScope = {
            ...input,
            codeScopeSha256: null,
            reusedFromCodeScopeSha256: null
        };

        const result = validateStrictReusedReviewEvidence(inputWithoutCodeScope);

        assert.equal(result.valid, true, result.valid ? undefined : result.reason);
    });

    it('rejects strict reused test review evidence when present code-scope hashes mismatch', () => {
        const { input, currentReviewRecordedEvent } = buildStrictReuseFixture('test');
        (currentReviewRecordedEvent.details as Record<string, unknown>).code_scope_sha256 = 'f'.repeat(64);

        const result = validateStrictReusedReviewEvidence(input);

        assert.equal(result.valid, false);
        assert.match((result as { valid: false; reason: string }).reason, /details_mismatch/);
    });

    it('rejects strict reused test review evidence when present code-scope hashes are malformed', () => {
        const { input, currentReviewRecordedEvent } = buildStrictReuseFixture('test');
        const inputWithoutCodeScope = { ...input, codeScopeSha256: null, reusedFromCodeScopeSha256: null };
        (currentReviewRecordedEvent.details as Record<string, unknown>).code_scope_sha256 = 'not-a-sha';

        const result = validateStrictReusedReviewEvidence(inputWithoutCodeScope);

        assert.equal(result.valid, false);
        assert.match((result as { valid: false; reason: string }).reason, /details_mismatch/);
    });

    it('rejects strict reused review evidence when the historical source event is missing', () => {
        const { input, historicalReviewRecordedEvent } = buildStrictReuseFixture();
        input.events = input.events.filter((event) => event !== historicalReviewRecordedEvent);

        const result = validateStrictReusedReviewEvidence(input);

        assert.equal(result.valid, false);
        assert.match((result as { valid: false; reason: string }).reason, /historical REVIEW_RECORDED telemetry/);
    });

    it('rejects strict reused review evidence when the historical source outcome failed', () => {
        const { input, historicalReviewRecordedEvent } = buildStrictReuseFixture();
        historicalReviewRecordedEvent.outcome = 'FAIL';

        const result = validateStrictReusedReviewEvidence(input);

        assert.equal(result.valid, false);
        assert.match((result as { valid: false; reason: string }).reason, /historical REVIEW_RECORDED telemetry/);
    });

    it('rejects strict reused review evidence when historical receipt snapshot telemetry is missing', () => {
        const { input, historicalReviewRecordedEvent } = buildStrictReuseFixture();
        delete (historicalReviewRecordedEvent.details as Record<string, unknown>).receipt_snapshot_path;

        const result = validateStrictReusedReviewEvidence(input);

        assert.equal(result.valid, false);
        assert.match((result as { valid: false; reason: string }).reason, /receipt_snapshot_path_missing/);
    });

    it('rejects strict reused review evidence when the historical receipt snapshot is tampered', () => {
        const { input, sourceReceiptSnapshotPath } = buildStrictReuseFixture();
        fs.appendFileSync(sourceReceiptSnapshotPath, 'tampered\n', 'utf8');

        const result = validateStrictReusedReviewEvidence(input);

        assert.equal(result.valid, false);
        assert.match((result as { valid: false; reason: string }).reason, /receipt_snapshot_hash_mismatch/);
    });

    it('rejects strict reused review evidence when historical reviewer provenance is not preserved', () => {
        const { input, historicalReviewRecordedEvent } = buildStrictReuseFixture();
        (historicalReviewRecordedEvent.details as Record<string, unknown>).reviewer_provenance = {
            ...input.reviewerProvenance,
            review_tree_state_sha256: 'f'.repeat(64)
        };

        const result = validateStrictReusedReviewEvidence(input);

        assert.equal(result.valid, false);
        assert.match((result as { valid: false; reason: string }).reason, /provenance/);
    });

    it('rejects strict reused review evidence when historical invocation telemetry is missing', () => {
        const { input, invocationEvent } = buildStrictReuseFixture();
        input.events = input.events.filter((event) => event !== invocationEvent);

        const result = validateStrictReusedReviewEvidence(input);

        assert.equal(result.valid, false);
        assert.equal(
            (result as { valid: false; reason: string }).reason,
            'historical REVIEWER_INVOCATION_ATTESTED telemetry is missing or does not match preserved reviewer_provenance'
        );
    });

    it('rejects historical provenance whose review tree-state binding differs from expected provenance', () => {
        const expectedTreeStateSha = '1'.repeat(64);
        const otherTreeStateSha = '2'.repeat(64);
        const contextSha = '3'.repeat(64);
        const artifactSha = '4'.repeat(64);
        const routingEventSha = '5'.repeat(64);
        const invocationEventSha = '6'.repeat(64);
        const receiptPath = '/repo/garda-agent-orchestrator/runtime/reviews/T-362-code-receipt.json';
        const expectedProvenance = {
            schema_version: 1,
            attestation_type: 'reviewer_invocation_attestation',
            controller_event_type: 'REVIEWER_INVOCATION_ATTESTED',
            task_sequence: 12,
            prev_event_sha256: routingEventSha,
            event_sha256: invocationEventSha,
            task_id: 'T-362',
            review_type: 'code',
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_identity: 'agent:code-reviewer',
            review_context_sha256: contextSha,
            review_tree_state_sha256: expectedTreeStateSha,
            routing_event_sha256: routingEventSha
        };
        const event = {
            event_type: 'REVIEW_RECORDED',
            sequence: 10,
            integrity: {
                task_sequence: 13,
                event_sha256: '7'.repeat(64)
            },
            details: {
                task_id: 'T-362',
                review_type: 'code',
                receipt_path: receiptPath,
                review_context_sha256: contextSha,
                review_tree_state_sha256: expectedTreeStateSha,
                review_artifact_sha256: artifactSha,
                reviewer_execution_mode: 'delegated_subagent',
                reviewer_identity: 'agent:code-reviewer',
                reviewer_provenance: {
                    ...expectedProvenance,
                    review_tree_state_sha256: otherTreeStateSha
                }
            }
        };

        const result = validateHistoricalReviewRecordedTelemetryEventMatch({
            event,
            taskId: 'T-362',
            reviewType: 'code',
            receiptPath,
            reviewContextSha256: contextSha,
            reviewTreeStateSha256: expectedTreeStateSha,
            reviewArtifactSha256: artifactSha,
            reviewerExecutionMode: 'delegated_subagent',
            reviewerIdentity: 'agent:code-reviewer',
            reviewerProvenance: expectedProvenance
        });

        assert.equal(result.matched, false);
        assert.equal(result.reason, 'provenance_mismatch');
    });
});
