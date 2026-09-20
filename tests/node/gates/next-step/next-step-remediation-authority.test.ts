import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import { sha256RedactedJsonPayload } from '../../../../src/core/redaction';
import { appendTaskEvent } from '../../../../src/gate-runtime/task-events';
import {
    resolvePersistedRemediationReviewExecutionAuthority
} from '../../../../src/gates/review-remediation/review-remediation-execution-authority';
import {
    resolveAuthoritativeReviewRemediationDecision
} from '../../../../src/gates/review-remediation/review-remediation-recovery-routing';

test('reconstructs remediation review execution authority only from an integrity-valid restart event', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-next-step-remediation-authority-'));
    const bundleRoot = path.join(root, 'garda-agent-orchestrator');
    const reviewsRoot = path.join(bundleRoot, 'runtime', 'reviews');
    const taskId = 'T-992-remediation-authority';
    const preflightSha256 = createHash('sha256').update('preflight').digest('hex');
    const classification = {
        source: 'runtime_fix' as const,
        classification: {
            category: 'production',
            reason: 'Runtime remediation requires a fresh code lane.',
            blocked_before_reuse: false,
            invalidated_review_types: ['code']
        }
    };
    const decision = resolveAuthoritativeReviewRemediationDecision({
        taskId,
        currentReviewType: 'code',
        classification,
        requiredReviews: { code: true },
        reviewExecutionPolicyMode: 'strict_sequential'
    });
    const decisionWithoutHash = {
        ...decision,
        preflight_sha256: preflightSha256
    } as Record<string, unknown>;
    delete decisionWithoutHash.decision_sha256;
    const boundDecision: Record<string, unknown> & { decision_sha256: string } = {
        ...decisionWithoutHash,
        decision_sha256: sha256RedactedJsonPayload(decisionWithoutHash)
    };
    appendTaskEvent(bundleRoot, taskId, 'REVIEW_CYCLE_RESTARTED', 'PASS', 'Review cycle restarted.', {
        task_id: taskId,
        event_type: 'REVIEW_CYCLE_RESTARTED',
        status: 'PASSED',
        preflight_sha256: preflightSha256,
        authoritative_review_decision: boundDecision,
        authoritative_review_classification: classification
    });
    const reviewExecution = {
        source: 'remediation_full',
        mode: 'FULL',
        authoritative_decision_sha256: boundDecision.decision_sha256,
        classification_sha256: boundDecision.classification_sha256
    } as Parameters<typeof resolvePersistedRemediationReviewExecutionAuthority>[0]['reviewExecution'];

    const authority = resolvePersistedRemediationReviewExecutionAuthority({
        reviewsRoot,
        taskId,
        reviewType: 'code',
        preflightSha256,
        fullReviewScope: ['src/app.ts'],
        reviewExecution
    });
    assert.equal(authority?.authoritativeDecisionSha256, boundDecision.decision_sha256);
    assert.equal(authority?.authoritativeClassificationSha256, boundDecision.classification_sha256);

    const preservedClassification = {
        source: 'runtime_fix' as const,
        classification: {
            category: 'review_evidence_only',
            reason: 'Only the downstream test reviewer evidence changed.',
            blocked_before_reuse: false,
            invalidated_review_types: ['test']
        }
    };
    const preservedDecision = resolveAuthoritativeReviewRemediationDecision({
        taskId,
        currentReviewType: 'test',
        classification: preservedClassification,
        requiredReviews: { code: true, test: true },
        reviewExecutionPolicyMode: 'strict_sequential'
    });
    const preservedDecisionWithoutHash = {
        ...preservedDecision,
        preflight_sha256: preflightSha256
    } as Record<string, unknown>;
    delete preservedDecisionWithoutHash.decision_sha256;
    const boundPreservedDecision = {
        ...preservedDecisionWithoutHash,
        decision_sha256: sha256RedactedJsonPayload(preservedDecisionWithoutHash)
    };
    appendTaskEvent(bundleRoot, taskId, 'REVIEW_CYCLE_RESTARTED', 'PASS', 'Downstream review cycle restarted.', {
        task_id: taskId,
        event_type: 'REVIEW_CYCLE_RESTARTED',
        status: 'PASSED',
        preflight_sha256: preflightSha256,
        authoritative_review_decision: boundPreservedDecision,
        authoritative_review_classification: preservedClassification
    });
    const reviewContextPath = path.join(reviewsRoot, 'custom', `${taskId}-code-review-context.json`);
    const receiptPath = path.join(reviewsRoot, `${taskId}-code-receipt.json`);
    const preflightPath = path.join(reviewsRoot, `${taskId}-preflight.json`);
    fs.mkdirSync(path.dirname(reviewContextPath), { recursive: true });
    fs.writeFileSync(reviewContextPath, '{"context":true}\n', 'utf8');
    fs.writeFileSync(receiptPath, '{"receipt":true}\n', 'utf8');
    const preservedOptions = {
        reviewsRoot,
        taskId,
        reviewType: 'code',
        preflightSha256,
        preflightPath,
        fullReviewScope: ['src/app.ts'],
        reviewExecution,
        reviewContextPath,
        receiptPath
    };
    assert.equal(resolvePersistedRemediationReviewExecutionAuthority(preservedOptions), null);
    appendTaskEvent(bundleRoot, taskId, 'REVIEW_CONTEXT_REUSE_ACCEPTED', 'PASS', 'Current PASS accepted.', {
        review_type: 'code',
        current_pass_review_evidence: true,
        preflight_path: preflightPath,
        preflight_sha256: preflightSha256,
        review_context_path: reviewContextPath,
        review_context_sha256: createHash('sha256').update(fs.readFileSync(reviewContextPath)).digest('hex'),
        receipt_path: receiptPath,
        receipt_sha256: createHash('sha256').update(fs.readFileSync(receiptPath)).digest('hex')
    });
    const preservedAuthority = resolvePersistedRemediationReviewExecutionAuthority(preservedOptions);
    assert.equal(preservedAuthority?.authoritativeDecisionSha256, boundDecision.decision_sha256);
    assert.equal(preservedAuthority?.authoritativeClassificationSha256, boundDecision.classification_sha256);
    assert.equal(resolvePersistedRemediationReviewExecutionAuthority({
        ...preservedOptions,
        preflightPath: path.join(reviewsRoot, 'same-bytes-other-preflight.json')
    }), null);
    assert.equal(resolvePersistedRemediationReviewExecutionAuthority({
        ...preservedOptions,
        preflightSha256: createHash('sha256').update('other-preflight').digest('hex')
    }), null);
    assert.equal(resolvePersistedRemediationReviewExecutionAuthority({
        ...preservedOptions,
        reviewExecution: {
            ...reviewExecution,
            classification_sha256: createHash('sha256').update('wrong-classification').digest('hex')
        }
    }), null);
    assert.equal(resolvePersistedRemediationReviewExecutionAuthority({
        ...preservedOptions,
        reviewExecution: { ...reviewExecution, mode: 'DELTA', source: 'remediation_delta' }
    }), null);
    if (process.platform !== 'win32') {
        const caseVariantContextPath = path.join(reviewsRoot, 'custom', `${taskId}-CODE-review-context.json`);
        fs.copyFileSync(reviewContextPath, caseVariantContextPath);
        assert.equal(resolvePersistedRemediationReviewExecutionAuthority({
            ...preservedOptions,
            reviewContextPath: caseVariantContextPath
        }), null);
    }

    fs.writeFileSync(receiptPath, '{"receipt":"changed"}\n', 'utf8');
    assert.equal(resolvePersistedRemediationReviewExecutionAuthority(preservedOptions), null);
    fs.writeFileSync(receiptPath, '{"receipt":true}\n', 'utf8');

    const invalidatedClassification = {
        source: 'runtime_fix' as const,
        classification: {
            category: 'production',
            reason: 'The code lane changed.',
            blocked_before_reuse: false,
            invalidated_review_types: ['code', 'test']
        }
    };
    const invalidatedDecision = resolveAuthoritativeReviewRemediationDecision({
        taskId,
        currentReviewType: 'code',
        classification: invalidatedClassification,
        requiredReviews: { code: true, test: true },
        reviewExecutionPolicyMode: 'strict_sequential'
    });
    const invalidatedDecisionWithoutHash = {
        ...invalidatedDecision,
        preflight_sha256: preflightSha256
    } as Record<string, unknown>;
    delete invalidatedDecisionWithoutHash.decision_sha256;
    appendTaskEvent(bundleRoot, taskId, 'REVIEW_CYCLE_RESTARTED', 'PASS', 'Code review cycle restarted.', {
        task_id: taskId,
        event_type: 'REVIEW_CYCLE_RESTARTED',
        status: 'PASSED',
        preflight_sha256: preflightSha256,
        authoritative_review_decision: {
            ...invalidatedDecisionWithoutHash,
            decision_sha256: sha256RedactedJsonPayload(invalidatedDecisionWithoutHash)
        },
        authoritative_review_classification: invalidatedClassification
    });
    assert.equal(resolvePersistedRemediationReviewExecutionAuthority(preservedOptions), null);

    const timelinePath = path.join(bundleRoot, 'runtime', 'task-events', `${taskId}.jsonl`);
    fs.appendFileSync(timelinePath, '{"forged":true}\n', 'utf8');
    assert.equal(resolvePersistedRemediationReviewExecutionAuthority({
        reviewsRoot,
        taskId,
        reviewType: 'code',
        preflightSha256,
        fullReviewScope: ['src/app.ts'],
        reviewExecution
    }), null);
});

test('rejects tampered fresh current PASS evidence before granting downstream replacement authority', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-next-step-current-pass-authority-'));
    const bundleRoot = path.join(root, 'garda-agent-orchestrator');
    const reviewsRoot = path.join(bundleRoot, 'runtime', 'reviews');
    const taskId = 'T-992-current-pass-authority';
    fs.mkdirSync(reviewsRoot, { recursive: true });
    const preflightPath = path.join(reviewsRoot, `${taskId}-preflight.json`);
    const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
    const receiptPath = path.join(reviewsRoot, `${taskId}-code-receipt.json`);
    const reviewArtifactPath = path.join(reviewsRoot, `${taskId}-code.md`);
    const findingsValidationArtifactPath = path.join(reviewsRoot, `${taskId}-code-findings-validation.json`);
    const findingsDispositionArtifactPath = path.join(reviewsRoot, `${taskId}-code-findings-disposition.json`);
    for (const [filePath, content] of [
        [preflightPath, '{"preflight":true}\n'],
        [reviewContextPath, '{"context":true}\n'],
        [receiptPath, '{"receipt":true}\n'],
        [reviewArtifactPath, '{"findings":[]}\n'],
        [findingsValidationArtifactPath, '{"accepted":true}\n'],
        [findingsDispositionArtifactPath, '{"blocking":0}\n']
    ]) {
        fs.writeFileSync(filePath, content, 'utf8');
    }
    const preflightSha256 = createHash('sha256').update(fs.readFileSync(preflightPath)).digest('hex');
    const classification = {
        source: 'runtime_fix' as const,
        classification: {
            category: 'production',
            reason: 'Runtime remediation requires a fresh code lane.',
            blocked_before_reuse: false,
            invalidated_review_types: ['code']
        }
    };
    const decision = resolveAuthoritativeReviewRemediationDecision({
        taskId,
        currentReviewType: 'code',
        classification,
        requiredReviews: { code: true },
        reviewExecutionPolicyMode: 'strict_sequential'
    });
    const decisionWithoutHash = {
        ...decision,
        preflight_sha256: preflightSha256
    } as Record<string, unknown>;
    delete decisionWithoutHash.decision_sha256;
    const boundDecision: Record<string, unknown> & {
        decision_sha256: string;
        classification_sha256: string;
    } = {
        ...decisionWithoutHash,
        decision_sha256: sha256RedactedJsonPayload(decisionWithoutHash),
        classification_sha256: decision.classification_sha256
    };
    appendTaskEvent(bundleRoot, taskId, 'REVIEW_CYCLE_RESTARTED', 'PASS', 'Review cycle restarted.', {
        task_id: taskId,
        event_type: 'REVIEW_CYCLE_RESTARTED',
        status: 'PASSED',
        preflight_sha256: preflightSha256,
        authoritative_review_decision: boundDecision,
        authoritative_review_classification: classification
    });
    appendTaskEvent(bundleRoot, taskId, 'REVIEW_RECORDED', 'PASS', 'Fresh review recorded.', {
        task_id: taskId,
        review_type: 'code',
        preflight_sha256: preflightSha256,
        review_context_path: reviewContextPath,
        review_context_sha256: createHash('sha256').update(fs.readFileSync(reviewContextPath)).digest('hex'),
        receipt_path: receiptPath,
        receipt_sha256: createHash('sha256').update(fs.readFileSync(receiptPath)).digest('hex'),
        review_artifact_path: reviewArtifactPath,
        review_artifact_sha256: createHash('sha256').update(fs.readFileSync(reviewArtifactPath)).digest('hex')
    });
    const timelinePath = path.join(bundleRoot, 'runtime', 'task-events', `${taskId}.jsonl`);
    const recordedEvent = JSON.parse(fs.readFileSync(timelinePath, 'utf8').trim().split('\n').at(-1)!) as {
        integrity: { task_sequence: number; event_sha256: string };
    };
    appendTaskEvent(bundleRoot, taskId, 'REVIEW_CONTEXT_REUSE_ACCEPTED', 'PASS', 'Current PASS accepted.', {
        review_type: 'code',
        current_pass_review_evidence: true,
        review_reuse_evidence: 'FRESH',
        reused_existing_review: false,
        preflight_path: preflightPath,
        preflight_sha256: preflightSha256,
        review_context_path: reviewContextPath,
        review_context_sha256: createHash('sha256').update(fs.readFileSync(reviewContextPath)).digest('hex'),
        receipt_path: receiptPath,
        receipt_sha256: createHash('sha256').update(fs.readFileSync(receiptPath)).digest('hex'),
        review_artifact_path: reviewArtifactPath,
        review_artifact_sha256: createHash('sha256').update(fs.readFileSync(reviewArtifactPath)).digest('hex'),
        findings_validation_artifact_path: findingsValidationArtifactPath,
        findings_validation_artifact_sha256: createHash('sha256')
            .update(fs.readFileSync(findingsValidationArtifactPath)).digest('hex'),
        findings_disposition_artifact_path: findingsDispositionArtifactPath,
        findings_disposition_artifact_sha256: createHash('sha256')
            .update(fs.readFileSync(findingsDispositionArtifactPath)).digest('hex'),
        review_recorded_sequence: recordedEvent.integrity.task_sequence,
        review_recorded_event_sha256: recordedEvent.integrity.event_sha256,
        remediation_mode: 'FULL',
        remediation_authoritative_decision_sha256: boundDecision.decision_sha256,
        remediation_classification_sha256: boundDecision.classification_sha256
    });
    const reviewExecution = {
        source: 'remediation_full',
        mode: 'FULL',
        authoritative_decision_sha256: boundDecision.decision_sha256,
        classification_sha256: boundDecision.classification_sha256
    } as Parameters<typeof resolvePersistedRemediationReviewExecutionAuthority>[0]['reviewExecution'];
    const authorityOptions = {
        reviewsRoot,
        taskId,
        reviewType: 'code',
        preflightSha256,
        preflightPath,
        fullReviewScope: ['src/app.ts'],
        reviewExecution,
        reviewContextPath,
        receiptPath
    };

    assert.equal(
        resolvePersistedRemediationReviewExecutionAuthority(authorityOptions)?.acceptedCurrentPassReplacement,
        true
    );
    fs.rmSync(findingsValidationArtifactPath);
    fs.rmSync(findingsDispositionArtifactPath);
    appendTaskEvent(bundleRoot, taskId, 'REVIEW_CONTEXT_REUSE_ACCEPTED', 'PASS', 'Verdict-token PASS accepted.', {
        review_type: 'code',
        current_pass_review_evidence: true,
        review_reuse_evidence: 'FRESH',
        reused_existing_review: false,
        preflight_path: preflightPath,
        preflight_sha256: preflightSha256,
        review_context_path: reviewContextPath,
        review_context_sha256: createHash('sha256').update(fs.readFileSync(reviewContextPath)).digest('hex'),
        receipt_path: receiptPath,
        receipt_sha256: createHash('sha256').update(fs.readFileSync(receiptPath)).digest('hex'),
        review_artifact_path: reviewArtifactPath,
        review_artifact_sha256: createHash('sha256').update(fs.readFileSync(reviewArtifactPath)).digest('hex'),
        findings_validation_artifact_path: null,
        findings_validation_artifact_sha256: null,
        findings_disposition_artifact_path: null,
        findings_disposition_artifact_sha256: null,
        review_recorded_sequence: recordedEvent.integrity.task_sequence,
        review_recorded_event_sha256: recordedEvent.integrity.event_sha256,
        remediation_mode: 'FULL',
        remediation_authoritative_decision_sha256: boundDecision.decision_sha256,
        remediation_classification_sha256: boundDecision.classification_sha256
    });
    assert.equal(
        resolvePersistedRemediationReviewExecutionAuthority(authorityOptions)?.acceptedCurrentPassReplacement,
        true
    );
    fs.writeFileSync(receiptPath, '{"receipt":false}\n', 'utf8');
    assert.equal(
        resolvePersistedRemediationReviewExecutionAuthority(authorityOptions)?.acceptedCurrentPassReplacement,
        false
    );

    fs.rmSync(root, { recursive: true, force: true });
});
