

import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { withInvocationReadObservation } from '../../../src/core/invocation-read-observation';
import { appendTaskEvent, readTaskTimelineFileSnapshot, withTaskTimelineReadSnapshot } from '../../../src/gate-runtime/task-events';
import { readReviewArtifactJsonSnapshot, withReviewArtifactReadSnapshot } from '../../../src/gate-runtime/review-artifacts';

function fixture(t: TestContext) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-invocation-snapshots-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const eventsRoot = path.join(root, 'runtime', 'task-events');
    const reviewsRoot = path.join(root, 'runtime', 'reviews');
    fs.mkdirSync(eventsRoot, { recursive: true, mode: 0o700 });
    fs.mkdirSync(reviewsRoot, { recursive: true });
    return { root, eventsRoot, reviewsRoot };
}

function timeline(root: string, taskId: string): string {
    const event = appendTaskEvent(root, taskId, 'TEST_EVENT', 'PASS', 'Observed event', {}, { passThru: true, lowNoiseRuntimeWrites: true });
    assert.equal(event?.commit_status, 'committed');
    return path.join(root, 'runtime', 'task-events', taskId + '.jsonl');
}

test('A1 retains a released timeline observation and rejects a later replacement', t => {
    const { root, eventsRoot } = fixture(t), taskId = 'T-A1-TIMELINE';
    const file = timeline(root, taskId);
    assert.throws(() => withInvocationReadObservation(() => {
        withTaskTimelineReadSnapshot(eventsRoot, taskId, () => assert.equal(readTaskTimelineFileSnapshot(file).valid, true));
        const replacement = file + '.replacement';
        fs.writeFileSync(replacement, fs.readFileSync(file), { mode: 0o600 });
        fs.renameSync(replacement, file);
    }), /(?:Task timeline snapshot (?:is unavailable|changed)|Invocation Windows ACL observation changed)/);
});

test('A1 retains a released absent timeline observation', t => {
    const { eventsRoot } = fixture(t), taskId = 'T-A1-MISSING';
    const file = path.join(eventsRoot, taskId + '.jsonl');
    assert.throws(() => withInvocationReadObservation(() => {
        withTaskTimelineReadSnapshot(eventsRoot, taskId, () => assert.equal(readTaskTimelineFileSnapshot(file).exists, false));
        fs.writeFileSync(file, '{}\n', { mode: 0o600 });
    }), /(?:Task timeline snapshot (?:is unavailable|changed)|Invocation Windows ACL observation changed)/);
});

test('A1 follows the existing authenticated append transition on the retained owner', t => {
    const { root, eventsRoot } = fixture(t), taskId = 'T-A1-APPEND';
    const file = timeline(root, taskId);
    assert.doesNotThrow(() => withInvocationReadObservation(() => withTaskTimelineReadSnapshot(eventsRoot, taskId, () => {
        const before = readTaskTimelineFileSnapshot(file);
        assert.equal(before.valid, true);
        timeline(root, taskId);
        const after = readTaskTimelineFileSnapshot(file);
        assert.equal(after.valid, true);
        assert.notEqual(after.sha256, before.sha256);
    })));
});

test('A1 retains review file observations after their snapshot is released', t => {
    const { reviewsRoot } = fixture(t), file = path.join(reviewsRoot, 'T-A1-code-receipt.json');
    fs.writeFileSync(file, '{"accepted":true}');
    assert.throws(() => withInvocationReadObservation(() => {
        withReviewArtifactReadSnapshot(reviewsRoot, () => assert.equal(readReviewArtifactJsonSnapshot(file).valid, true));
        fs.writeFileSync(file, '{"accepted":false}');
    }), /Review artifact read snapshot/);
});

test('A1 retains review path absence after its snapshot is released', t => {
    const { reviewsRoot } = fixture(t), file = path.join(reviewsRoot, 'T-A1-code-receipt.json');
    assert.throws(() => withInvocationReadObservation(() => {
        withReviewArtifactReadSnapshot(reviewsRoot, () => assert.equal(readReviewArtifactJsonSnapshot(file).valid, false));
        fs.writeFileSync(file, '{"accepted":true}');
    }), /Review artifact read snapshot/);
});

test('A1 keeps unchanged missing and invalid review inputs on their original rejection path', t => {
    const { reviewsRoot } = fixture(t), file = path.join(reviewsRoot, 'invalid.json');
    fs.writeFileSync(file, 'invalid JSON');
    assert.doesNotThrow(() => withInvocationReadObservation(() => withReviewArtifactReadSnapshot(reviewsRoot, () => {
        assert.equal(readReviewArtifactJsonSnapshot(file).valid, false);
        assert.equal(readReviewArtifactJsonSnapshot(path.join(reviewsRoot, 'missing.json')).valid, false);
    })));
});






test('A1 authenticated appends update retained timeline owners after their nested snapshot was released', t => {
    const { root, eventsRoot } = fixture(t), taskId = 'T-A1-RELEASED-APPEND';
    const file = timeline(root, taskId);
    assert.doesNotThrow(() => withInvocationReadObservation(() => {
        let before: string | null = null;
        withTaskTimelineReadSnapshot(eventsRoot, taskId, () => { before = readTaskTimelineFileSnapshot(file).sha256; });
        timeline(root, taskId);
        withTaskTimelineReadSnapshot(eventsRoot, taskId, () => {
            const after = readTaskTimelineFileSnapshot(file);
            assert.equal(after.valid, true);
            assert.notEqual(after.sha256, before);
        });
    }));
});




