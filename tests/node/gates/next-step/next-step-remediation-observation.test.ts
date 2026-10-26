import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { sha256RedactedJsonPayload } from '../../../../src/core/redaction';
import { withInvocationReadObservation } from '../../../../src/core/invocation-read-observation';
import { withNextStepMeasurement, type NextStepMeasurement } from '../../../../src/core/next-step-measurement';
import { appendTaskEvent, inspectTaskEventFile, withTaskTimelineReadSnapshot } from '../../../../src/gate-runtime/task-events';
import { readInvocationVerifiedTaskEventTimeline } from '../../../../src/gate-runtime/timeline/task-events-integrity';
import { assertTaskTimelineAppendPrecondition } from '../../../../src/gate-runtime/timeline/task-timeline-read-snapshot';
import { resolvePersistedRemediationReviewExecutionAuthority as resolveAuthority } from '../../../../src/gates/review-remediation/review-remediation-execution-authority';
import { resolveAuthoritativeReviewRemediationDecision } from '../../../../src/gates/review-remediation/review-remediation-recovery-routing';
import { writeReviewClassificationSnapshot } from '../../../../src/gates/review-remediation/review-remediation-classification-evidence';

type AuthorityOptions = Parameters<typeof resolveAuthority>[0];
type Classification = Parameters<typeof resolveAuthoritativeReviewRemediationDecision>[0]['classification'];
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const mutationError = /(?:Task timeline snapshot|Invocation (?:file|Windows ACL) observation changed)/iu;

function fixture(t: TestContext, preserved = false, accepted = true) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-q6-authority-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const bundleRoot = path.join(root, 'garda-agent-orchestrator');
    const reviewsRoot = path.join(bundleRoot, 'runtime', 'reviews');
    const eventsRoot = path.join(bundleRoot, 'runtime', 'task-events');
    const taskId = 'T-Q6-AUTHORITY';
    const preflightSha256 = sha256('preflight');
    const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
    const receiptPath = path.join(reviewsRoot, `${taskId}-code-receipt.json`);
    const reviewArtifactPath = path.join(reviewsRoot, `${taskId}-code.md`);
    const preflightPath = path.join(reviewsRoot, `${taskId}-preflight.json`);
    const timelinePath = path.join(eventsRoot, taskId + '.jsonl');
    fs.mkdirSync(reviewsRoot, { recursive: true });
    fs.writeFileSync(reviewContextPath, '{"schema_version":2,"context":true}\n');
    fs.writeFileSync(receiptPath, '{"review_output_format":"verdict_token"}\n');
    fs.writeFileSync(reviewArtifactPath, 'REVIEW PASSED\n');
    fs.writeFileSync(preflightPath, 'preflight');
    const classificationPaths: string[] = [];
    function restart(classification: Classification, currentReviewType: string) {
        const decision = resolveAuthoritativeReviewRemediationDecision({
            taskId, currentReviewType, classification,
            requiredReviews: { code: true, test: true }, reviewExecutionPolicyMode: 'strict_sequential'
        });
        const withoutHash: Record<string, unknown> = { ...decision, preflight_sha256: preflightSha256 };
        delete withoutHash.decision_sha256;
        const bound = {
            ...withoutHash, decision_sha256: sha256RedactedJsonPayload(withoutHash),
            classification_sha256: decision.classification_sha256
        };
        const reference = writeReviewClassificationSnapshot({
            reviewsRoot, taskId, classification: classification as unknown as Record<string, unknown>
        });
        classificationPaths.push(reference.artifact_path);
        appendTaskEvent(bundleRoot, taskId, 'REVIEW_CYCLE_RESTARTED', 'PASS', 'Restart.', {
            task_id: taskId, event_type: 'REVIEW_CYCLE_RESTARTED', status: 'PASSED',
            preflight_sha256: preflightSha256, authoritative_review_decision: bound,
            authoritative_review_classification_reference: reference
        });
        return bound;
    }
    const decision = restart({
        source: 'runtime_fix', classification: {
            category: 'production', reason: 'Code changed.', blocked_before_reuse: false,
            invalidated_review_types: ['code']
        }
    }, 'code');
    if (preserved) restart({
        source: 'runtime_fix', classification: {
            category: 'review_evidence_only', reason: 'Only test evidence changed.', blocked_before_reuse: false,
            invalidated_review_types: ['test']
        }
    }, 'test');
    const recordedDetails = {
        task_id: taskId, review_type: 'code', preflight_sha256: preflightSha256,
        review_context_path: reviewContextPath, review_context_sha256: sha256(fs.readFileSync(reviewContextPath)),
        receipt_path: receiptPath, receipt_sha256: sha256(fs.readFileSync(receiptPath)),
        review_artifact_path: reviewArtifactPath, review_artifact_sha256: sha256(fs.readFileSync(reviewArtifactPath))
    };
    appendTaskEvent(bundleRoot, taskId, 'REVIEW_RECORDED', 'PASS', 'Recorded.', recordedDetails);
    const recorded = JSON.parse(fs.readFileSync(timelinePath, 'utf8').trim().split('\n').at(-1)!) as {
        integrity: { task_sequence: number; event_sha256: string }
    };
    if (accepted) appendTaskEvent(bundleRoot, taskId, 'REVIEW_CONTEXT_REUSE_ACCEPTED', 'PASS', 'Accepted.', {
        ...recordedDetails, current_pass_review_evidence: true, review_reuse_evidence: 'FRESH',
        reused_existing_review: false, preflight_path: preflightPath,
        findings_validation_artifact_path: null, findings_validation_artifact_sha256: null,
        findings_disposition_artifact_path: null, findings_disposition_artifact_sha256: null,
        findings_validation_required: false, review_recorded_sequence: recorded.integrity.task_sequence,
        review_recorded_event_sha256: recorded.integrity.event_sha256, remediation_mode: 'FULL',
        remediation_authoritative_decision_sha256: decision.decision_sha256,
        remediation_classification_sha256: decision.classification_sha256, remediation_authority_eligible: true
    });
    const options: AuthorityOptions = {
        reviewsRoot, taskId, reviewType: 'code', preflightSha256, preflightPath,
        fullReviewScope: ['src/app.ts'], reviewContextPath, receiptPath,
        reviewExecution: {
            source: 'remediation_full', mode: 'FULL', authoritative_decision_sha256: decision.decision_sha256,
            classification_sha256: decision.classification_sha256
        } as AuthorityOptions['reviewExecution']
    };
    return { root, bundleRoot, reviewsRoot, eventsRoot, timelinePath, reviewArtifactPath,
        classificationPaths, options };
}

function replaceSameBytes(file: string): void {
    const replacement = file + '.replacement';
    fs.writeFileSync(replacement, fs.readFileSync(file), { mode: 0o600 });
    fs.renameSync(replacement, file);
}

function measured(action: () => void): NextStepMeasurement {
    let result: NextStepMeasurement | undefined;
    withNextStepMeasurement(() => withInvocationReadObservation(action), value => { result = value; });
    return result!;
}

test('reuses the existing verified immutable timeline and one authority derivation at one and five consumers', t => {
    const f = fixture(t);
    const expected = resolveAuthority(f.options);
    assert.equal(expected?.acceptedCurrentPassReplacement, true);
    const measurements = [1, 5].map(consumers => measured(() =>
        withTaskTimelineReadSnapshot(f.eventsRoot, f.options.taskId, () => {
            assert.equal(inspectTaskEventFile(f.timelinePath, f.options.taskId).status, 'PASS');
            const first = readInvocationVerifiedTaskEventTimeline(f.timelinePath, f.options.taskId)!;
            assert.ok(Object.isFrozen(first.events));
            for (let consumer = 0; consumer < consumers; consumer += 1) {
                const view = readInvocationVerifiedTaskEventTimeline(f.timelinePath, f.options.taskId)!;
                assert.equal(view.events, first.events, 'The verified events are neither copied nor delivered to an observer again');
                const authority = resolveAuthority(f.options);
                assert.deepEqual(authority, expected);
                assert.equal(Object.isFrozen(authority), false);
                (authority!.fullReviewScope as string[]).push('caller-only');
                authority!.authoritativeDecisionSha256 = 'caller-only';
            }
        })
    ));
    const work = (measurement: NextStepMeasurement) => Object.fromEntries(Object.entries(measurement.work)
        .filter(([key]) => key.startsWith('timeline_') || key.startsWith('visit:timeline_')
            || key.startsWith('visit:remediation_') || key.startsWith('file_hash:')
            || key === 'derive:resolvePersistedRemediationReviewExecutionAuthority'));
    assert.deepEqual(work(measurements[1]), work(measurements[0]));
    assert.equal(measurements[1].work.timeline_verify, 1);
    assert.equal(measurements[1].work.timeline_parse, 1);
    assert.equal(measurements[1].work['derive:resolvePersistedRemediationReviewExecutionAuthority'], 1);
    assert.equal(measurements[1].work['visit:remediation_observer_event'] || 0, 0);
    assert.equal(measurements[1].work['visit:timeline_cloned_event'] || 0, 0);
});

test('detects invalid timeline or classification bytes present before the invocation', t => {
    for (const input of ['timeline', 'classification']) {
        const f = fixture(t);
        if (input === 'timeline') {
            fs.writeFileSync(f.timelinePath, fs.readFileSync(f.timelinePath, 'utf8').replace('Restart.', 'Tampered.'));
        } else fs.appendFileSync(f.classificationPaths[0], ' ');
        withInvocationReadObservation(() => assert.equal(resolveAuthority(f.options), null));
    }
});

test('retains one authority after a same-byte timeline replacement and rejects before returning the invocation', t => {
    const f = fixture(t);
    let secondConsumerCompleted = false;
    assert.throws(() => withInvocationReadObservation(() => {
        const first = resolveAuthority(f.options);
        assert.ok(first);
        replaceSameBytes(f.timelinePath);
        assert.deepEqual(resolveAuthority(f.options), first);
        secondConsumerCompleted = true;
    }), mutationError);
    assert.equal(secondConsumerCompleted, true);
});

test('retains receipt context classification and review bytes but rejects their mid-call replacements', t => {
    for (const input of ['receipt', 'context', 'classification', 'report']) {
        const f = fixture(t, true);
        const file = input === 'receipt' ? f.options.receiptPath!
            : input === 'context' ? f.options.reviewContextPath!
                : input === 'classification' ? f.classificationPaths[0] : f.reviewArtifactPath;
        assert.throws(() => withInvocationReadObservation(() => {
            const first = resolveAuthority(f.options);
            assert.ok(first);
            replaceSameBytes(file);
            assert.deepEqual(resolveAuthority(f.options), first);
        }), mutationError, input);
    }
});

test('retains a consumed missing receipt and rejects its appearance', t => {
    const f = fixture(t, true);
    const bytes = fs.readFileSync(f.options.receiptPath!);
    fs.unlinkSync(f.options.receiptPath!);
    assert.throws(() => withInvocationReadObservation(() => {
        assert.equal(resolveAuthority(f.options), null);
        fs.writeFileSync(f.options.receiptPath!, bytes);
        assert.equal(resolveAuthority(f.options), null);
    }), mutationError);
});

test('isolates mode lane preflight path scope and preserved-pending-reuse options in the full contract key', t => {
    const f = fixture(t, true, false);
    withInvocationReadObservation(() => {
        assert.equal(resolveAuthority(f.options), null);
        const pending = { ...f.options, acceptPreservedPendingReuse: true };
        const authority = resolveAuthority(pending);
        assert.ok(authority);
        assert.equal(resolveAuthority(f.options), null);
        assert.equal(resolveAuthority({ ...pending, reviewType: 'security' }), null);
        assert.equal(resolveAuthority({ ...pending, reviewExecution: {
            ...pending.reviewExecution, mode: 'DELTA', source: 'remediation_delta'
        } }), null);
        assert.equal(resolveAuthority({ ...pending, preflightSha256: sha256('foreign') }), null);
        const differentScope = resolveAuthority({ ...pending, fullReviewScope: ['src/other.ts'] });
        assert.deepEqual(differentScope?.fullReviewScope, ['src/other.ts']);
        assert.deepEqual(resolveAuthority(pending)?.fullReviewScope, ['src/app.ts']);
    });
    const accepted = fixture(t, true);
    withInvocationReadObservation(() => {
        assert.ok(resolveAuthority(accepted.options));
        assert.equal(resolveAuthority({ ...accepted.options, preflightPath: path.join(accepted.reviewsRoot, 'other.json') }), null);
    });
});

test('an authenticated append changes the memo key and preserves the explicit live append precondition', t => {
    const f = fixture(t);
    const measurement = measured(() => {
        const first = resolveAuthority(f.options);
        assert.ok(first);
        appendTaskEvent(f.bundleRoot, f.options.taskId, 'Q6_EXTRA_EVENT', 'PASS', 'Authenticated append.', {});
        assert.deepEqual(resolveAuthority(f.options), first);
    });
    assert.equal(measurement.work['derive:resolvePersistedRemediationReviewExecutionAuthority'], 2);
    assert.throws(() => withInvocationReadObservation(() => {
        resolveAuthority(f.options);
        replaceSameBytes(f.timelinePath);
        assertTaskTimelineAppendPrecondition(f.timelinePath);
        assert.fail('Append precondition must reject before any write');
    }), mutationError);
});

test('authority calls outside invocation observation keep live native reads and checks', t => {
    const f = fixture(t, true);
    assert.ok(resolveAuthority(f.options));
    fs.appendFileSync(f.options.receiptPath!, ' ');
    assert.equal(resolveAuthority(f.options), null);
    assert.equal(readInvocationVerifiedTaskEventTimeline(f.timelinePath, f.options.taskId), null);
});
