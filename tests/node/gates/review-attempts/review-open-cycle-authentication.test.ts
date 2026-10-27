import '../../../../src/bin/garda/derivation-source-receipts';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendMandatoryTaskEvent } from '../../../../src/gate-runtime/task-events';
import { invalidateIndex } from '../../../../src/gate-runtime/reviews-index';
import { joinOrchestratorPath } from '../../../../src/core/orchestrator-paths';
import { withInvocationReadObservation } from '../../../../src/core/invocation-read-observation';
import { withNextStepMeasurement, type NextStepMeasurement } from '../../../../src/core/next-step-measurement';
import { captureClosedReviewGate, prepareClosedReviewCurrentIndex } from '../../../../src/gates/review-attempts/review-closed-cycle-capture';
import { publishClosedReviewHistory } from '../../../../src/gates/review-attempts/review-closed-cycle-storage';
import { readReviewCycleGuardEvaluation } from '../../../../src/gates/next-step/next-step-review-cycle-guard-evaluation';

const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
for (const refreshPreflight of [false, true]) test('earlier same-cycle receipts remain authenticated, preflight refresh=' + refreshPreflight, () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-open-cycle-'));
    try {
        execFileSync('git', ['init', '--quiet', repoRoot]);
        const taskId = 'T-open-cycle', bundle = joinOrchestratorPath(repoRoot, '');
        const reviews = path.join(bundle, 'runtime/reviews'), eventsRoot = path.join(bundle, 'runtime/task-events');
        fs.mkdirSync(reviews, { recursive: true });
        const mode = path.join(reviews, taskId + '-task-mode.json');
        const preflight = path.join(reviews, taskId + '-preflight.json');
        fs.writeFileSync(mode, JSON.stringify({ task_id: taskId }));
        appendMandatoryTaskEvent(bundle, taskId, 'TASK_MODE_ENTERED', 'PASS', 'Entry', { artifact_path: mode });
        const classify = (revision: number) => {
            fs.writeFileSync(preflight, JSON.stringify({ task_id: taskId, revision, metrics: { scope_sha256: null, scope_content_sha256: null } }));
            appendMandatoryTaskEvent(bundle, taskId, 'PREFLIGHT_CLASSIFIED', 'INFO', 'Preflight', {
                output_path: preflight, scope_sha256: null, scope_content_sha256: null
            });
        };
        classify(0);
        const receipts: string[] = [];
        for (let attempt = 0; attempt < 2; attempt++) {
            if (refreshPreflight && attempt === 1) classify(1);
            const body = '## Verdict\nREVIEW PASSED\n\nEvidence ' + attempt + '\n', digest = sha(body);
            const artifact = path.join(reviews, taskId + '-code-artifact-' + digest + '.md');
            fs.writeFileSync(artifact, body);
            const receipt = JSON.stringify({ task_id: taskId, review_type: 'code', review_artifact_sha256: digest });
            const receiptSha = sha(receipt), receiptPath = path.join(reviews, taskId + '-code-receipt-' + receiptSha + '.json');
            fs.writeFileSync(receiptPath, receipt); receipts.push(receiptPath);
            invalidateIndex(reviews);
            const admitted = appendMandatoryTaskEvent(bundle, taskId, 'REVIEW_RECORDED', 'PASS', 'Review ' + attempt, {
                review_type: 'code', reviewer_identity: 'reviewer-' + attempt, review_context_sha256: sha('context-' + attempt),
                preflight_sha256: sha(fs.readFileSync(preflight)), verdict_token: 'REVIEW PASSED',
                review_artifact_path: artifact, review_artifact_snapshot_path: artifact,
                review_artifact_sha256: digest, review_artifact_snapshot_sha256: digest,
                receipt_snapshot_path: receiptPath, receipt_snapshot_sha256: receiptSha
            }, { actor: 'gate' });
            assert.ok(admitted.integrity?.event_sha256);
            publishClosedReviewHistory(captureClosedReviewGate({ repoRoot, taskId, kind: 'record',
                sourceEventSha256: admitted.integrity.event_sha256 }));
            prepareClosedReviewCurrentIndex(repoRoot);
        }
        const sample = (observed: boolean) => {
            let measured: NextStepMeasurement | undefined;
            const read = () => readReviewCycleGuardEvaluation(repoRoot, eventsRoot, taskId);
            const result = withNextStepMeasurement(() => observed ? withInvocationReadObservation(read) : read(),
                value => { measured = value; });
            return { result, accepted: measured!.work['closed-review-summary:accepted'] || 0 };
        };
        const initial = sample(true);
        assert.equal(initial.accepted, 1, 'real native producer must create an eligible acceleration record');
        assert.deepEqual(initial.result, sample(false).result);
        const original = fs.readFileSync(receipts[0]);
        fs.appendFileSync(receipts[0], ' ');
        const changed = sample(true), native = sample(false);
        assert.equal(native.result.evaluation.should_block, true);
        assert.ok(native.result.evaluation.violations.some(violation => violation.metric === 'timeline_integrity'));
        assert.deepEqual(changed.result, native.result, 'no authenticated restart closed the first attempt');
        assert.equal(changed.accepted, 0, 'a compact result cannot skip another attempt in the same cycle');
        fs.writeFileSync(receipts[0], original);
        assert.equal(sample(true).accepted, 1);
    } finally { fs.rmSync(repoRoot, { recursive: true, force: true }); }
});
