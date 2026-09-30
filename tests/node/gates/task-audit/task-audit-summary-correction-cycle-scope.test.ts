import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { buildReviewFindingsAuditSummary } from '../../../../src/gates/task-audit/task-audit-summary-review-findings';
import { resolveTaskCycleBindingSnapshot } from '../../../../src/gates/task-events-summary/task-events-summary-cycle-binding';

import {
    fs, path, makeTempDir, writeWorkflowConfig, writePreflight,
    computeFileSha256, writeCurrentIndependentReviewFixture, writeIntegrityEventSequence,
    appendIntegrityEvent, writeArtifact, buildReviewRecordedTelemetryDetails, buildTaskAuditSummary
} from './task-audit-summary-fixtures';

const TASK_ID = 'T-AUDIT-CORRECTION-CYCLE';

function rejectedCorrectionDetails(taskId = TASK_ID, reviewType = 'code'): Record<string, unknown> {
    return {
        task_id: taskId, review_type: reviewType, correction_attempt: 1,
        correction_package_sha256: 'a'.repeat(64), reviewer_identity: 'agent:old-reviewer',
        reviewer_attempt_id: 'old-attempt', provider_id: 'Codex', provider_invocation_id: 'old-invocation',
        reviewer_invocation_event_sha256: 'b'.repeat(64)
    };
}

function seedCurrentReview(repoRoot: string, oldDetails = rejectedCorrectionDetails()) {
    const reviewsDir = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews');
    const eventsDir = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'task-events');
    fs.mkdirSync(reviewsDir, { recursive: true });
    fs.mkdirSync(eventsDir, { recursive: true });
    writeWorkflowConfig(repoRoot, false);
    writePreflight(reviewsDir, TASK_ID, {
        mode: 'FULL_PATH', changed_files: [], metrics: { changed_lines_total: 0 },
        required_reviews: { code: true }
    });
    const preflightPath = path.join(reviewsDir, `${TASK_ID}-preflight.json`);
    const preflightSha256 = computeFileSha256(preflightPath);
    const reviewerIdentity = 'agent:current-reviewer';
    const fixture = writeCurrentIndependentReviewFixture({
        reviewsDir, taskId: TASK_ID, preflightSha256, reviewerIdentity, provenance: null
    });
    const events = writeIntegrityEventSequence(eventsDir, TASK_ID, [
        { event_type: 'TASK_MODE_ENTERED' },
        { event_type: 'REVIEW_OUTPUT_CORRECTION_REQUIRED', details: oldDetails },
        { event_type: 'COMPILE_GATE_PASSED', details: {
            preflight_path: preflightPath, preflight_hash_sha256: preflightSha256
        } }
    ]);
    const invocationEvent = appendIntegrityEvent(eventsDir, TASK_ID, {
        event_type: 'REVIEWER_INVOCATION_ATTESTED', details: {
            task_id: TASK_ID, review_type: 'code', reviewer_execution_mode: 'delegated_subagent',
            reviewer_identity: reviewerIdentity, review_context_sha256: fixture.reviewContextSha256,
            routing_event_sha256: 'd'.repeat(64)
        }
    });
    const receiptPath = path.join(reviewsDir, `${TASK_ID}-code-receipt.json`);
    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as Record<string, unknown>;
    const integrity = invocationEvent.integrity as Record<string, unknown>;
    receipt.reviewer_provenance = {
        schema_version: 1, attestation_type: 'reviewer_invocation_attestation',
        controller_event_type: 'REVIEWER_INVOCATION_ATTESTED', ...integrity,
        task_id: TASK_ID, review_type: 'code', reviewer_execution_mode: 'delegated_subagent',
        reviewer_identity: reviewerIdentity, review_context_sha256: fixture.reviewContextSha256,
        routing_event_sha256: 'd'.repeat(64)
    };
    writeArtifact(reviewsDir, TASK_ID, '-code-receipt.json', receipt);
    appendIntegrityEvent(eventsDir, TASK_ID, {
        event_type: 'REVIEW_RECORDED',
        details: buildReviewRecordedTelemetryDetails(reviewsDir, TASK_ID, 'code')
    });
    appendIntegrityEvent(eventsDir, TASK_ID, { event_type: 'REVIEW_GATE_PASSED' });
    return { reviewsDir, eventsDir, receiptPath, compileEvent: events[2] };
}

describe('task audit correction history belongs to its review cycle', () => {
    const roots: string[] = [];
    afterEach(() => {
        for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
    });
    function fixture(oldDetails?: Record<string, unknown>) {
        const repoRoot = makeTempDir();
        roots.push(repoRoot);
        return { repoRoot, ...seedCurrentReview(repoRoot, oldDetails) };
    }
    function audit(value: ReturnType<typeof fixture>) {
        return buildTaskAuditSummary({
            taskId: TASK_ID, repoRoot: value.repoRoot, eventsRoot: value.eventsDir,
            reviewsRoot: value.reviewsDir
        });
    }

    it('retains invalid historical evidence without blocking authenticated current reviews', () => {
        const value = fixture();
        const result = audit(value);
        assert.equal(result.integrity_status, 'PASS');
        assert.equal(result.final_closeout.review_integrity_attestation?.status, 'INDEPENDENT_REVIEW_ATTESTED');
        assert.equal(result.review_findings_audit?.status, 'CLEAR');
        assert.equal(result.review_findings_audit?.remaining_blocker_count, 0);
        assert.equal(result.review_findings_audit?.superseded_invalid_transport_count, 1);
        const transport = result.review_findings_audit?.correction_transports?.[0];
        assert.equal(transport?.audit_scope, 'SUPERSEDED_CYCLE');
        assert.equal(transport?.evidence_valid, false);
        assert.ok(transport?.violations.length);
        assert.equal(transport?.superseded_by_compile_event_sha256,
            (value.compileEvent.integrity as Record<string, unknown>).event_sha256);
    });

    it('keeps invalid current-cycle correction evidence blocking', () => {
        const value = fixture();
        appendIntegrityEvent(value.eventsDir, TASK_ID, {
            event_type: 'REVIEW_OUTPUT_CORRECTION_REQUIRED', details: rejectedCorrectionDetails()
        });
        const result = audit(value);
        assert.equal(result.final_closeout.review_integrity_attestation?.status, 'INDEPENDENT_REVIEW_ATTESTED');
        assert.equal(result.review_findings_audit?.status, 'BLOCKED');
        assert.equal(result.review_findings_audit?.remaining_blocker_count, 1);
        assert.deepEqual(result.review_findings_audit?.correction_transports?.map((entry) => entry.audit_scope),
            ['SUPERSEDED_CYCLE', 'CURRENT']);
    });

    for (const owner of ['foreign-task', 'unreviewed-lane']) {
        it(`does not supersede ${owner} evidence using another current review`, () => {
            const value = fixture(owner === 'foreign-task'
                ? rejectedCorrectionDetails('T-FOREIGN') : rejectedCorrectionDetails(TASK_ID, 'test'));
            const result = audit(value);
            assert.equal(result.review_findings_audit?.status, 'BLOCKED');
            assert.equal(result.review_findings_audit?.correction_transports?.[0]?.audit_scope, 'CURRENT');
        });
    }

    it('does not supersede history when the current receipt is modified', () => {
        const value = fixture();
        const receipt = JSON.parse(fs.readFileSync(value.receiptPath, 'utf8')) as Record<string, unknown>;
        receipt.reviewer_identity = 'agent:forged-reviewer';
        writeArtifact(value.reviewsDir, TASK_ID, '-code-receipt.json', receipt);
        const result = audit(value);
        assert.equal(result.final_closeout.review_integrity_attestation?.status, 'DEGRADED_OR_UNVERIFIABLE');
        assert.equal(result.review_findings_audit?.status, 'BLOCKED');
        assert.equal(result.review_findings_audit?.correction_transports?.[0]?.audit_scope, 'CURRENT');
    });

    it('does not supersede history when timeline integrity fails', () => {
        const value = fixture();
        const eventPath = path.join(value.eventsDir, `${TASK_ID}.jsonl`);
        const events = fs.readFileSync(eventPath, 'utf8').trim().split(/\r?\n/u)
            .map((line) => JSON.parse(line) as Record<string, unknown>);
        events[0].message = 'Mutated history';
        fs.writeFileSync(eventPath, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`, 'utf8');
        const result = audit(value);
        assert.equal(result.integrity_status, 'FAILED');
        assert.equal(result.review_findings_audit?.status, 'BLOCKED');
        assert.equal(result.review_findings_audit?.correction_transports?.[0]?.audit_scope, 'CURRENT');
    });

    for (const missingBinding of ['preflight', 'compile', 'timeline', 'attestation'] as const) {
        it(`does not supersede history without its current ${missingBinding} binding`, () => {
            const value = fixture();
            const result = audit(value);
            const timelineEvents = fs.readFileSync(path.join(value.eventsDir, `${TASK_ID}.jsonl`), 'utf8')
                .trim().split(/\r?\n/u).map((line) => JSON.parse(line) as Record<string, unknown>);
            const preflightPath = path.join(value.reviewsDir, `${TASK_ID}-preflight.json`);
            const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
            const findings = buildReviewFindingsAuditSummary({
                repoRoot: value.repoRoot, reviewsRoot: value.reviewsDir, taskId: TASK_ID,
                requiredReviews: { code: true }, currentPreflight: preflight,
                timelineEvents, reviewAttemptSummary: null,
                currentCycle: missingBinding === 'compile' ? null
                    : resolveTaskCycleBindingSnapshot(TASK_ID, timelineEvents, value.repoRoot, value.reviewsDir),
                reviewIntegrityAttestation: missingBinding === 'attestation' ? null
                    : result.final_closeout.review_integrity_attestation,
                timelineIntegrityStatus: missingBinding === 'timeline' ? 'ERROR' : result.integrity_status,
                currentPreflightSha256: missingBinding === 'preflight' ? 'f'.repeat(64)
                    : computeFileSha256(preflightPath)
            });
            assert.equal(findings?.status, 'BLOCKED');
            assert.equal(findings?.correction_transports?.[0]?.audit_scope, 'CURRENT');
        });
    }
});
