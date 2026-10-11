import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { inspectCompletedTaskEvidenceBatch } from '../../../src/lifecycle/cleanup/completed-task-evidence';
import {
    buildTaskAuditSummary, computeFileSha256, getWorkspaceSnapshot, makeTempDir,
    synchronizeFinalCloseoutArtifacts, writeArtifact, writeIntegrityEventSequence,
    writePreflight, writeWorkflowConfig
} from '../gates/task-audit/task-audit-summary-fixtures';
import { initGitRepo } from '../gates/git-fixtures';
import { writeTaskQueue, writeTimelineSummary } from './cleanup-fixtures';

const TASK_IDS = ['T-COST-1', 'T-COST-2', 'T-COST-3'];
const ACCEPTED_CONTENT = 'accepted completed content\n';

function committedFixture(t: TestContext, taskIds: readonly string[]) {
    const root = makeTempDir();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const ignored = 'garda-agent-orchestrator/\nTASK.md\n';
    fs.writeFileSync(path.join(root, '.gitignore'), ignored);
    fs.writeFileSync(path.join(root, 'example.txt'), 'baseline\n');
    initGitRepo(root, { gitignoreContent: ignored });
    fs.writeFileSync(path.join(root, 'example.txt'), ACCEPTED_CONTENT);
    const bundleRoot = path.join(root, 'garda-agent-orchestrator');
    const eventsDir = path.join(bundleRoot, 'runtime', 'task-events');
    const reviewsDir = path.join(bundleRoot, 'runtime', 'reviews');
    fs.mkdirSync(eventsDir, { recursive: true });
    fs.mkdirSync(reviewsDir, { recursive: true });
    writeWorkflowConfig(root, false);
    writeTaskQueue(root, taskIds.map(id => ({ id, status: 'DONE' })));
    for (const taskId of taskIds) {
        const changedFiles = ['example.txt'];
        writePreflight(reviewsDir, taskId, {
            task_id: taskId, mode: 'FULL_PATH', detection_source: 'explicit_changed_files',
            changed_files: changedFiles, required_reviews: {},
            metrics: getWorkspaceSnapshot(root, 'explicit_changed_files', true, changedFiles)
        });
        const preflightPath = path.join(reviewsDir, `${taskId}-preflight.json`);
        const preflightSha256 = computeFileSha256(preflightPath);
        for (const suffix of ['-task-mode.json', '-compile-gate.json', '-review-gate.json', '-doc-impact.json']) {
            writeArtifact(reviewsDir, taskId, suffix, {
                task_id: taskId, status: 'PASSED', preflight_sha256: preflightSha256,
                requested_depth: 2, effective_depth: 2, decision: 'NO_DOC_UPDATES'
            });
        }
        writeIntegrityEventSequence(eventsDir, taskId, [
            { event_type: 'TASK_MODE_ENTERED' }, { event_type: 'RULE_PACK_LOADED' },
            { event_type: 'HANDSHAKE_DIAGNOSTICS_RECORDED' }, { event_type: 'SHELL_SMOKE_PREFLIGHT_RECORDED' },
            { event_type: 'PREFLIGHT_CLASSIFIED', details: { artifact_path: preflightPath, artifact_hash: preflightSha256 } },
            { event_type: 'COMPILE_GATE_PASSED', details: { preflight_path: preflightPath, preflight_sha256: preflightSha256 } },
            { event_type: 'REVIEW_GATE_PASSED' }, { event_type: 'DOC_IMPACT_ASSESSED' },
            { event_type: 'STATUS_CHANGED', details: { new_status: 'DONE' } }, { event_type: 'COMPLETION_GATE_PASSED' }
        ]);
        writeTimelineSummary(eventsDir, taskId, { completenessStatus: 'COMPLETE' });
        const audit = buildTaskAuditSummary({ repoRoot: root, taskId });
        assert.equal(audit.status, 'PASS', JSON.stringify(audit.blockers));
        synchronizeFinalCloseoutArtifacts(audit);
    }
    execFileSync('git', ['add', '--', 'example.txt'], { cwd: root });
    execFileSync('git', ['commit', '-m', 'accepted completed task'], { cwd: root });
    for (const taskId of taskIds) {
        const audit = buildTaskAuditSummary({ repoRoot: root, taskId });
        assert.equal(audit.status, 'PASS', JSON.stringify(audit.blockers));
        synchronizeFinalCloseoutArtifacts(audit);
    }
    return { root, bundleRoot };
}

test('completed evidence shares workspace discovery within one batch of genuine accepted tasks', t => {
    const fixture = committedFixture(t, TASK_IDS);
    const childProcess = require('node:child_process') as typeof import('node:child_process');
    const originalExec = childProcess.execFileSync, originalSpawn = childProcess.spawnSync;
    let gitCalls = 0;
    let headQueries = 0, numstatQueries = 0;
    function recordGit(command: unknown, args: unknown): void {
        if (command !== 'git') return;
        gitCalls += 1;
        const argumentsList = Array.isArray(args) ? args.map(String) : [];
        if (argumentsList.includes('rev-parse')) headQueries += 1;
        if (argumentsList.includes('--numstat')) numstatQueries += 1;
    }
    t.mock.method(childProcess, 'execFileSync', (...args: Parameters<typeof childProcess.execFileSync>) => {
        recordGit(args[0], args[1]);
        return originalExec(...args);
    });
    t.mock.method(childProcess, 'spawnSync', (...args: Parameters<typeof childProcess.spawnSync>) => {
        recordGit(args[0], args[1]);
        return originalSpawn(...args);
    });
    const single = inspectCompletedTaskEvidenceBatch({ repoRoot: fixture.root, taskIds: TASK_IDS.slice(0, 1) });
    assert.ok([...single.values()].every(result => result.eligible), JSON.stringify([...single.values()]));
    const singleCalls = gitCalls;
    assert.equal(headQueries, 2, 'fresh before/after fingerprints already bind HEAD for the whole batch');
    assert.equal(numstatQueries, 0, 'a fresh canonical generation without changes has no diff statistics to discover');
    gitCalls = 0;
    const batch = inspectCompletedTaskEvidenceBatch({ repoRoot: fixture.root, taskIds: TASK_IDS });
    assert.deepEqual([...batch.keys()], TASK_IDS);
    assert.ok([...batch.values()].every(result => result.eligible), JSON.stringify([...batch.values()]));
    t.diagnostic(`Real Git processes: one task=${singleCalls}, three-task batch=${gitCalls}`);
    assert.ok(gitCalls <= singleCalls + 8 * (TASK_IDS.length - 1),
        `workspace discovery repeated across tasks: one=${singleCalls}, batch=${gitCalls}`);
    fs.writeFileSync(path.join(fixture.root, 'example.txt'), 'changed after the previous successful proof\n');
    const later = inspectCompletedTaskEvidenceBatch({ repoRoot: fixture.root, taskIds: TASK_IDS.slice(0, 1) });
    assert.equal(later.get(TASK_IDS[0])!.eligible, false, 'a later operation must reconstruct current evidence');
});

for (const drift of ['HEAD', 'index', 'worktree', 'Git configuration'] as const) {
    test(`completed batch rejects ${drift} drift after an earlier task was verified`, t => {
        const taskIds = TASK_IDS.slice(0, 2);
        const fixture = committedFixture(t, taskIds);
        const nativeFs = require('node:fs') as typeof fs;
        const originalRead = nativeFs.readFileSync;
        const secondLedger = path.join(fixture.bundleRoot, 'runtime', 'task-ledger', `${taskIds[1]}.json`);
        let changed = false;
        t.mock.method(nativeFs, 'readFileSync', (...args: Parameters<typeof fs.readFileSync>) => {
            const value = originalRead(...args);
            if (!changed && String(args[0]) === secondLedger) {
                changed = true;
                if (drift === 'HEAD') {
                    execFileSync('git', ['commit', '--allow-empty', '-m', 'concurrent HEAD change'], { cwd: fixture.root });
                } else if (drift === 'index') {
                    fs.writeFileSync(path.join(fixture.root, 'example.txt'), 'concurrent staged content\n');
                    execFileSync('git', ['add', '--', 'example.txt'], { cwd: fixture.root });
                    fs.writeFileSync(path.join(fixture.root, 'example.txt'), ACCEPTED_CONTENT);
                } else if (drift === 'worktree') {
                    fs.writeFileSync(path.join(fixture.root, 'concurrent.txt'), 'concurrent new content\n');
                } else {
                    execFileSync('git', ['config', 'core.eol', 'crlf'], { cwd: fixture.root });
                }
            }
            return value;
        });
        const results = inspectCompletedTaskEvidenceBatch({ repoRoot: fixture.root, taskIds });
        assert.equal(changed, true, 'real mutation must happen after the first task proof');
        assert.equal(results.size, taskIds.length);
        assert.ok([...results.values()].every(result => !result.eligible), JSON.stringify([...results.values()]));
    });
}
