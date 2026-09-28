import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileSha256 } from '../../../src/core/file-hashing';
import { statFileIdentitySync } from '../../../src/core/file-stat';
import { appendTaskEvent, readTaskTimelineFileSnapshot, withTaskTimelineReadSnapshot } from '../../../src/gate-runtime/timeline/task-events';
import { readReviewArtifactFileSnapshot, withReviewArtifactReadSnapshot } from '../../../src/gate-runtime/review/review-artifacts';

test('authenticates native regular-file hashes on every supported Node runtime', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-native-file-identity-'));
    try {
        const file = path.join(root, 'source.txt');
        fs.writeFileSync(file, 'native-file-identity\n', { mode: 0o600 });
        const digest = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
        assert.equal(fileSha256(file), digest);
        assert.equal(fileSha256(file, fs.statSync(file)), digest);
        assert.equal(fileSha256(file, statFileIdentitySync(file)), digest);
        const rawStat = fs.statSync(file);
        const changedStat = Object.assign(Object.create(Object.getPrototypeOf(rawStat)), rawStat, { mtimeMs: rawStat.mtimeMs + 1 });
        assert.equal(fileSha256(file, changedStat), null);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('authenticates native timeline appends and immutable reads on every supported Node runtime', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-native-timeline-identity-'));
    try {
        const taskId = 'T-NATIVE-FILE-IDENTITY';
        const event = appendTaskEvent(root, taskId, 'TEST_EVENT', 'PASS', 'Native identity', {}, { passThru: true, lowNoiseRuntimeWrites: true });
        assert.equal(event?.commit_status, 'committed');
        const eventsRoot = path.join(root, 'runtime', 'task-events');
        const file = path.join(eventsRoot, `${taskId}.jsonl`);
        withTaskTimelineReadSnapshot(eventsRoot, taskId, () => {
            const snapshot = readTaskTimelineFileSnapshot(file);
            assert.equal(snapshot.valid, true);
            assert.equal(snapshot.exists, true);
            assert.match(snapshot.sha256 || '', /^[a-f0-9]{64}$/u);
        });
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('authenticates native review artifact snapshots on every supported Node runtime', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-native-review-identity-'));
    try {
        const file = path.join(root, 'artifact.json');
        fs.writeFileSync(file, '{"value":1}\n', { mode: 0o600 });
        withReviewArtifactReadSnapshot(root, () => {
            const snapshot = readReviewArtifactFileSnapshot(file);
            assert.equal(snapshot.valid, true);
            assert.equal(snapshot.exists, true);
            assert.equal(snapshot.content?.toString(), '{"value":1}\n');
        });
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
