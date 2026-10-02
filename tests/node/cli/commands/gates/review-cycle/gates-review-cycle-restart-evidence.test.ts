import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { appendRestartCompletedEvidence } from '../../../../../../src/cli/commands/gate-flows/recovery/recovery-flow-restart-evidence';
import { appendMandatoryTaskEvent, inspectTaskEventFile } from '../../../../../../src/gate-runtime/task-events';
import { readRestartReviewClassification, writeReviewClassificationSnapshot } from '../../../../../../src/gates/review-remediation/review-remediation-classification-evidence';

const TASK_ID = 'T-RESTART-STORAGE';
const tempRoots: string[] = [];

function fixture() {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-restart-storage-'));
    tempRoots.push(repoRoot);
    const bundleRoot = path.join(repoRoot, 'garda-agent-orchestrator');
    const reviewsRoot = path.join(bundleRoot, 'runtime', 'reviews');
    fs.mkdirSync(reviewsRoot, { recursive: true });
    const evidencePaths = ['task-mode', 'preflight', 'compile-gate'].map((suffix) => {
        const filePath = path.join(reviewsRoot, `${TASK_ID}-${suffix}.json`);
        fs.writeFileSync(filePath, '{}\n');
        return filePath;
    });
    return {
        repoRoot, bundleRoot, reviewsRoot,
        input: {
            repoRoot, taskId: TASK_ID, eventType: 'REVIEW_CYCLE_RESTARTED' as const,
            artifactSuffix: '-review-cycle-restart.json' as const,
            message: 'Review cycle restarted.', taskModePath: evidencePaths[0],
            preflightPath: evidencePaths[1], compileEvidencePath: evidencePaths[2],
            detectionSource: 'explicit_changed_files', plannedChangedFilesCount: 1,
            detectedChangedFilesCount: 1, elapsedMs: 1, restartReason: 'failed_review_remediation_cycle',
            nextStepSummary: 'Prepare fresh review.'
        }
    };
}

describe('review-cycle restart evidence storage', () => {
    afterEach(() => {
        for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
    });

    it('appends a large delta to a populated timeline using a compact evidence reference', () => {
        const { bundleRoot, reviewsRoot, input } = fixture();
        appendMandatoryTaskEvent(bundleRoot, TASK_ID, 'TEST_SETUP', 'PASS', 'Existing timeline.', {
            values: Array.from({ length: 120_000 }, (_, index) => ({ index }))
        });
        const classification = {
            source: 'delta',
            delta: { readable_diff: { pages: Array.from({ length: 32_000 }, (_, index) => ({ index, text: 'line' })) } }
        };
        const restartArtifactPath = appendRestartCompletedEvidence({
            ...input, extraDetails: { authoritative_review_classification: classification }
        });
        const events: Readonly<Record<string, unknown>>[] = [];
        const timeline = path.join(bundleRoot, 'runtime', 'task-events', `${TASK_ID}.jsonl`);
        const inspection = inspectTaskEventFile(timeline, TASK_ID, { onIntegrityEvent: (event) => events.push(event) });
        assert.match(inspection.status, /^PASS/u);
        assert.equal(events.length, 2);
        const details = events[1].details as Record<string, unknown>;
        assert.equal(details.authoritative_review_classification, undefined);
        assert.ok(details.authoritative_review_classification_reference);
        assert.ok(Buffer.byteLength(JSON.stringify(details)) < 8192);
        const restart = JSON.parse(fs.readFileSync(restartArtifactPath, 'utf8')) as Record<string, unknown>;
        assert.deepEqual(restart.authoritative_review_classification_reference, details.authoritative_review_classification_reference);
        assert.deepEqual(readRestartReviewClassification({ reviewsRoot, taskId: TASK_ID, details }), classification);
    });

    it('keeps separate immutable snapshots across restarts and supports legacy inline evidence', () => {
        const { reviewsRoot } = fixture();
        const first = { source: 'delta', delta: { readable_diff: { text: 'first' } } };
        const second = { source: 'delta', delta: { readable_diff: { text: 'second' } } };
        const options = { reviewsRoot, taskId: TASK_ID };
        const firstReference = writeReviewClassificationSnapshot({ ...options, classification: first });
        const firstBytes = fs.readFileSync(firstReference.artifact_path);
        assert.deepEqual(writeReviewClassificationSnapshot({ ...options, classification: first }), firstReference);
        const secondReference = writeReviewClassificationSnapshot({ ...options, classification: second });
        assert.notEqual(firstReference.artifact_path, secondReference.artifact_path);
        assert.deepEqual(fs.readFileSync(firstReference.artifact_path), firstBytes);
        for (const [reference, classification] of [[firstReference, first], [secondReference, second]] as const) {
            assert.deepEqual(readRestartReviewClassification({
                ...options, details: { authoritative_review_classification_reference: reference }
            }), classification);
        }
        assert.deepEqual(readRestartReviewClassification({
            ...options, details: { authoritative_review_classification: first }
        }), first);
    });

    it('rejects missing, modified, misdirected and ambiguous snapshot references', () => {
        const { reviewsRoot } = fixture();
        const options = { reviewsRoot, taskId: TASK_ID };
        const classification = { source: 'delta', delta: {} };
        const reference = writeReviewClassificationSnapshot({ ...options, classification });
        const read = (value: unknown, inline?: unknown) => readRestartReviewClassification({
            ...options, details: {
                authoritative_review_classification_reference: value,
                ...(inline === undefined ? {} : { authoritative_review_classification: inline })
            }
        });
        assert.throws(() => read(reference, classification), /Invalid.*reference/u);
        assert.throws(() => read({ ...reference, artifact_sha256: 'invalid' }), /Invalid.*reference/u);
        assert.throws(() => read({ ...reference, artifact_path: path.join(reviewsRoot, '..', 'outside.json') }), /path is not canonical/u);
        assert.throws(() => readRestartReviewClassification({
            reviewsRoot, taskId: 'T-OTHER', details: { authoritative_review_classification_reference: reference }
        }), /path is not canonical/u);
        fs.appendFileSync(reference.artifact_path, ' ');
        assert.throws(() => read(reference), /hash does not match/u);
        assert.throws(() => writeReviewClassificationSnapshot({ ...options, classification }), /does not match its hash/u);
        fs.unlinkSync(reference.artifact_path);
        assert.throws(() => read(reference), /missing/u);
    });

    it('rejects linked evidence files without changing their content', () => {
        const { repoRoot, reviewsRoot } = fixture();
        const options = { reviewsRoot, taskId: TASK_ID };
        const classification = { source: 'delta', delta: {} };
        const reference = writeReviewClassificationSnapshot({ ...options, classification });
        const original = fs.readFileSync(reference.artifact_path);
        const outside = path.join(repoRoot, 'outside.json');
        fs.linkSync(reference.artifact_path, outside);
        assert.throws(() => readRestartReviewClassification({
            ...options, details: { authoritative_review_classification_reference: reference }
        }), /Unsafe transaction path/u);
        assert.throws(() => writeReviewClassificationSnapshot({ ...options, classification }), /Unsafe transaction path/u);
        assert.deepEqual(fs.readFileSync(outside), original);
    });
});
