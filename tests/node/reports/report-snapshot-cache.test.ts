import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as path from 'node:path';
import { buildReportSnapshotFingerprint, type ReportDataContract } from '../../../src/reports/report-data-contract';
import { startLocalUiServer } from '../../../src/reports/ui';
import { buildReportSnapshotCacheKey } from '../../../src/reports/report-data/report-snapshot-fingerprint';
import {
    cleanupLocalUiTestResources,
    makeLocalUiTempRepo,
    writeLocalUiRepoFixture
} from './local-ui-test-helpers';

function writeLargeReviewsFixture(repoRoot: string): string {
    const reviewsRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews');
    fs.mkdirSync(reviewsRoot, { recursive: true });
    for (let index = 0; index < 600; index += 1) {
        fs.writeFileSync(path.join(reviewsRoot, `000-${String(index).padStart(3, '0')}.json`), '{}\n');
    }
    return path.join(reviewsRoot, 'T-100-quality-checklist.json');
}

function writeInvalidChecklist(checklistPath: string, action: string): void {
    fs.writeFileSync(checklistPath, JSON.stringify({
        task_id: 'T-100',
        status: 'CONFIG_ERROR',
        outcome: 'CONFIG_ERROR',
        timestamp_utc: '2026-10-05T00:00:00.000Z',
        actions_required: [action]
    }));
}

async function readReport(serverUrl: string): Promise<ReportDataContract> {
    const response = await fetch(`${serverUrl}api/report`);
    assert.equal(response.status, 200);
    return await response.json() as ReportDataContract;
}

test('complete snapshot keys are stable and change for small runtime trees', () => {
    const repoRoot = makeLocalUiTempRepo();
    writeLocalUiRepoFixture(repoRoot);
    const initial = buildReportSnapshotCacheKey(repoRoot);
    assert.equal(initial, buildReportSnapshotFingerprint(repoRoot));
    assert.equal(buildReportSnapshotCacheKey(repoRoot), initial);
    const reviewsRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews');
    fs.mkdirSync(reviewsRoot, { recursive: true });
    const checklistPath = path.join(reviewsRoot, 'T-100-quality-checklist.json');
    writeInvalidChecklist(checklistPath, 'A new configuration problem');
    const added = buildReportSnapshotCacheKey(repoRoot);
    assert.notEqual(added, null);
    assert.notEqual(added, initial);
    writeInvalidChecklist(checklistPath, 'A changed configuration problem with a different size');
    const changed = buildReportSnapshotCacheKey(repoRoot);
    assert.notEqual(changed, null);
    assert.notEqual(changed, added);
    fs.unlinkSync(checklistPath);
    const deleted = buildReportSnapshotCacheKey(repoRoot);
    assert.notEqual(deleted, null);
    assert.notEqual(deleted, changed);
    assert.equal(deleted, buildReportSnapshotFingerprint(repoRoot));
});

test('the exact scan limit remains cacheable until another entry is added', () => {
    const repoRoot = makeLocalUiTempRepo();
    writeLocalUiRepoFixture(repoRoot);
    const locksRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'locks');
    fs.mkdirSync(locksRoot, { recursive: true });
    for (let index = 0; index < 512; index += 1) {
        fs.writeFileSync(path.join(locksRoot, `lock-${String(index).padStart(3, '0')}.lock`), '{}\n');
    }
    const complete = buildReportSnapshotCacheKey(repoRoot);
    assert.notEqual(complete, null);
    assert.equal(buildReportSnapshotCacheKey(repoRoot), complete);
    const overflowPath = path.join(locksRoot, 'lock-512.lock');
    fs.writeFileSync(overflowPath, '{}\n');
    assert.equal(buildReportSnapshotCacheKey(repoRoot), null);
    fs.unlinkSync(overflowPath);
    assert.equal(buildReportSnapshotCacheKey(repoRoot), complete);
});

test('oversized nested runtime trees never produce a reusable snapshot key', () => {
    const repoRoot = makeLocalUiTempRepo();
    writeLocalUiRepoFixture(repoRoot);
    const eventsRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'task-events');
    const archiveRoot = path.join(eventsRoot, 'archive');
    fs.mkdirSync(archiveRoot, { recursive: true });
    for (let index = 0; index < 520; index += 1) {
        fs.writeFileSync(path.join(archiveRoot, `event-${String(index).padStart(3, '0')}.jsonl`), '{}\n');
    }
    assert.equal(buildReportSnapshotCacheKey(repoRoot), null);
    for (let index = 20; index < 520; index += 1) {
        fs.unlinkSync(path.join(archiveRoot, `event-${String(index).padStart(3, '0')}.jsonl`));
    }
    assert.notEqual(buildReportSnapshotCacheKey(repoRoot), null);
});

test('snapshot cache fallback preserves the file-stat scan budget', (t) => {
    const repoRoot = makeLocalUiTempRepo();
    writeLocalUiRepoFixture(repoRoot);
    const checklistPath = writeLargeReviewsFixture(repoRoot);
    const reviewsRoot = path.dirname(checklistPath);
    for (const entry of fs.readdirSync(reviewsRoot)) {
        fs.renameSync(path.join(reviewsRoot, entry), path.join(reviewsRoot, entry.replace('.json', '-preflight.json')));
    }
    const statSync = fs.statSync;
    const sampledFiles: string[] = [];
    t.mock.method(fs, 'statSync', (input: fs.PathLike, ...args: unknown[]) => {
        if (String(input).endsWith('-preflight.json')) {
            sampledFiles.push(String(input));
        }
        return Reflect.apply(statSync, fs, [input, ...args]);
    });
    assert.equal(buildReportSnapshotCacheKey(repoRoot), null);
    assert.equal(sampledFiles.length, 512);
});

test('local UI refreshes edits, deletions and additions beyond the snapshot scan limit', async () => {
    const repoRoot = makeLocalUiTempRepo();
    writeLocalUiRepoFixture(repoRoot);
    const checklistPath = writeLargeReviewsFixture(repoRoot);
    writeInvalidChecklist(checklistPath, 'Original configuration problem');
    const initialFingerprint = buildReportSnapshotFingerprint(repoRoot);
    assert.match(initialFingerprint, /scan_truncated:512/u);
    const server = await startLocalUiServer({ repoRoot, port: 0, idleShutdownEnabled: false });
    try {
        const initial = await readReport(server.url);
        assert.deepEqual(initial.quality_gate_tab.latest_check.actions_required, ['Original configuration problem']);

        writeInvalidChecklist(checklistPath, 'Updated configuration problem outside the first 512 entries');
        assert.equal(buildReportSnapshotFingerprint(repoRoot), initialFingerprint);
        const changed = await readReport(server.url);
        assert.deepEqual(changed.quality_gate_tab.latest_check.actions_required, [
            'Updated configuration problem outside the first 512 entries'
        ]);

        fs.unlinkSync(checklistPath);
        assert.equal(buildReportSnapshotFingerprint(repoRoot), initialFingerprint);
        const deleted = await readReport(server.url);
        assert.equal(deleted.quality_gate_tab.latest_check.artifact_exists, false);

        writeInvalidChecklist(checklistPath, 'New configuration problem outside the first 512 entries');
        assert.equal(buildReportSnapshotFingerprint(repoRoot), initialFingerprint);
        const added = await readReport(server.url);
        assert.deepEqual(added.quality_gate_tab.latest_check.actions_required, [
            'New configuration problem outside the first 512 entries'
        ]);
    } finally {
        await cleanupLocalUiTestResources({ repoRoot, server });
    }
});
