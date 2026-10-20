import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import * as path from 'node:path';
import { PROJECT_MEMORY_FILE_DEFINITIONS } from '../../../src/core/project-memory';
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

test('snapshot keys cover edits, deletions and additions of every displayed project memory file', () => {
    const repoRoot = makeLocalUiTempRepo();
    writeLocalUiRepoFixture(repoRoot);
    const memoryRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'docs', 'project-memory');
    for (const { fileName } of PROJECT_MEMORY_FILE_DEFINITIONS) {
        const filePath = path.join(memoryRoot, fileName);
        const initial = buildReportSnapshotCacheKey(repoRoot);
        assert.notEqual(initial, null);
        fs.writeFileSync(filePath, `# ${fileName}\n\nUpdated project memory with different content and size.\n`);
        const edited = buildReportSnapshotCacheKey(repoRoot);
        assert.notEqual(edited, initial, `${fileName}: edit`);
        assert.equal(buildReportSnapshotCacheKey(repoRoot), edited);
        fs.unlinkSync(filePath);
        const deleted = buildReportSnapshotCacheKey(repoRoot);
        assert.notEqual(deleted, edited, `${fileName}: deletion`);
        fs.writeFileSync(filePath, `# ${fileName}\n\nRestored memory.\n`);
        assert.notEqual(buildReportSnapshotCacheKey(repoRoot), deleted, `${fileName}: addition`);
    }
});

test('local UI refreshes project memory without restarting its server', async () => {
    const repoRoot = makeLocalUiTempRepo();
    writeLocalUiRepoFixture(repoRoot);
    const compactPath = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'docs', 'project-memory', 'compact.md');
    fs.writeFileSync(compactPath, 'old\n');
    const server = await startLocalUiServer({ repoRoot, port: 0, idleShutdownEnabled: false });
    try {
        const initial = await readReport(server.url);
        const compact = (report: ReportDataContract) => report.project_memory_tab.files.find(
            (file) => file.path.endsWith('/project-memory/compact.md')
        );
        assert.equal(compact(initial)?.size_bytes, 4);
        assert.deepEqual(await readReport(server.url), initial);

        const updated = '# Current project memory\n\nUpdated contents.\n';
        fs.writeFileSync(compactPath, updated);
        const edited = await readReport(server.url);
        assert.equal(compact(edited)?.size_bytes, Buffer.byteLength(updated));
        assert.deepEqual(await readReport(server.url), edited);

        fs.unlinkSync(compactPath);
        assert.equal(compact(await readReport(server.url))?.exists, false);
        fs.writeFileSync(compactPath, 'restored\n');
        assert.equal(compact(await readReport(server.url))?.size_bytes, 9);
    } finally {
        await cleanupLocalUiTestResources({ repoRoot, server });
    }
});

test('snapshot keys follow Git worktree inputs used by quality-checklist freshness', () => {
    const repoRoot = makeLocalUiTempRepo();
    writeLocalUiRepoFixture(repoRoot);
    const git = (args: string[]) => execFileSync('git', ['-C', repoRoot, ...args], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
    });
    git(['init', '-q']);
    git(['config', 'user.name', 'Garda Tests']);
    git(['config', 'user.email', 'tests@example.invalid']);
    git(['config', 'core.autocrlf', 'false']);
    const sourcePath = path.join(repoRoot, 'source.ts');
    fs.writeFileSync(sourcePath, 'export const value = 1;\n');
    git(['add', '.']);
    git(['commit', '-qm', 'baseline']);
    const initial = buildReportSnapshotCacheKey(repoRoot);
    assert.notEqual(initial, null);

    fs.writeFileSync(sourcePath, 'export const value = 200;\n');
    const edited = buildReportSnapshotCacheKey(repoRoot);
    assert.notEqual(edited, initial, 'worktree content used by quality freshness changed');
    git(['add', '--', 'source.ts']);
    const staged = buildReportSnapshotCacheKey(repoRoot);
    assert.notEqual(staged, edited, 'quality freshness distinguishes staged and unstaged scope');
    const untrackedPath = path.join(repoRoot, 'new-source.ts');
    fs.writeFileSync(untrackedPath, 'export const added = true;\n');
    const added = buildReportSnapshotCacheKey(repoRoot);
    assert.notEqual(added, staged, 'untracked worktree scope changed');
    fs.unlinkSync(untrackedPath);
    assert.equal(buildReportSnapshotCacheKey(repoRoot), staged);
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
