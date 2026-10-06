import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as retention from '../../../src/lifecycle/runtime-policy/runtime-retention-policy';
import {
    appendIntegrityEvent,
    buildTaskAuditSummary,
    computeFileSha256,
    getWorkspaceSnapshot,
    makeTempDir,
    synchronizeFinalCloseoutArtifacts,
    writeArtifact,
    writeIntegrityEventSequence,
    writePreflight,
    writeWorkflowConfig
} from '../gates/task-audit/task-audit-summary-fixtures';
import { initGitRepo } from '../gates/git-fixtures';
import { writeTaskQueue, writeTimelineSummary } from './cleanup-fixtures';

const TASK_ID = 'T-RETIRE-1';
type Eligibility = { eligible: boolean; reasons: string[]; commit_sha: string | null };

function inspect(root: string, requireCommittedScope = true): Eligibility {
    const inspectEvidence = (retention as unknown as {
        inspectCompletedTaskEvidence?: (input: {
            repoRoot: string; taskId: string; requireCommittedScope: boolean;
        }) => Eligibility;
    }).inspectCompletedTaskEvidence;
    assert.ok(inspectEvidence, 'canonical completed-task eligibility must be available');
    return inspectEvidence({ repoRoot: root, taskId: TASK_ID, requireCommittedScope });
}

function completedFixture(
    t: TestContext,
    priorFailure = false,
    acceptedContent: string | null = 'accepted completed content\n',
    initialContent: string | null = 'baseline\n',
    options: { extraTaskIds?: readonly string[]; additionalFiles?: Readonly<Record<string, string>> } = {}
) {
    const root = makeTempDir();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.writeFileSync(path.join(root, '.gitignore'), 'garda-agent-orchestrator/\nTASK.md\n');
    if (initialContent !== null) fs.writeFileSync(path.join(root, 'example.txt'), initialContent);
    for (const file of Object.keys(options.additionalFiles || {})) fs.writeFileSync(path.join(root, file), 'baseline\n');
    initGitRepo(root, { gitignoreContent: 'garda-agent-orchestrator/\nTASK.md\n' });
    if (acceptedContent === null) fs.unlinkSync(path.join(root, 'example.txt'));
    else fs.writeFileSync(path.join(root, 'example.txt'), acceptedContent);
    for (const [file, content] of Object.entries(options.additionalFiles || {})) fs.writeFileSync(path.join(root, file), content);
    const bundleRoot = path.join(root, 'garda-agent-orchestrator');
    const eventsDir = path.join(bundleRoot, 'runtime', 'task-events');
    const reviewsDir = path.join(bundleRoot, 'runtime', 'reviews');
    fs.mkdirSync(eventsDir, { recursive: true });
    fs.mkdirSync(reviewsDir, { recursive: true });
    writeWorkflowConfig(root, false);
    const taskIds = [TASK_ID, ...(options.extraTaskIds || [])];
    const changedFiles = ['example.txt', ...Object.keys(options.additionalFiles || {})];
    writeTaskQueue(root, taskIds.map(id => ({ id, status: 'DONE' })));
    let preflightPath = '';
    for (const taskId of taskIds) {
        const snapshot = getWorkspaceSnapshot(root, 'explicit_changed_files', true, changedFiles);
        writePreflight(reviewsDir, taskId, {
            task_id: taskId,
            mode: 'FULL_PATH',
            detection_source: 'explicit_changed_files',
            changed_files: changedFiles,
            metrics: snapshot,
            required_reviews: {}
        });
        const taskPreflightPath = path.join(reviewsDir, `${taskId}-preflight.json`);
        if (taskId === TASK_ID) preflightPath = taskPreflightPath;
        const preflightSha256 = computeFileSha256(taskPreflightPath);
        for (const suffix of ['-task-mode.json', '-compile-gate.json', '-review-gate.json', '-doc-impact.json']) {
            writeArtifact(reviewsDir, taskId, suffix, {
                task_id: taskId, status: 'PASSED', preflight_sha256: preflightSha256,
                requested_depth: 2, effective_depth: 2, decision: 'NO_DOC_UPDATES'
            });
        }
        writeIntegrityEventSequence(eventsDir, taskId, [
            { event_type: 'TASK_MODE_ENTERED' },
            ...(priorFailure ? [{ event_type: 'COMPILE_GATE_FAILED' }, { event_type: 'TASK_BLOCKED' }] : []),
            { event_type: 'RULE_PACK_LOADED' },
            { event_type: 'HANDSHAKE_DIAGNOSTICS_RECORDED' },
            { event_type: 'SHELL_SMOKE_PREFLIGHT_RECORDED' },
            { event_type: 'PREFLIGHT_CLASSIFIED', details: { artifact_path: taskPreflightPath, artifact_hash: preflightSha256 } },
            { event_type: 'COMPILE_GATE_PASSED', details: { preflight_path: taskPreflightPath, preflight_sha256: preflightSha256 } },
            { event_type: 'REVIEW_GATE_PASSED' },
            { event_type: 'DOC_IMPACT_ASSESSED' },
            { event_type: 'STATUS_CHANGED', details: { new_status: 'DONE' } },
            { event_type: 'COMPLETION_GATE_PASSED' }
        ]);
        writeTimelineSummary(eventsDir, taskId, { completenessStatus: 'COMPLETE' });
        const audit = buildTaskAuditSummary({ repoRoot: root, taskId });
        assert.equal(audit.status, 'PASS', JSON.stringify(audit.blockers));
        synchronizeFinalCloseoutArtifacts(audit);
    }
    const commit = () => {
        execFileSync('git', ['add', '--', ...changedFiles], { cwd: root, stdio: 'ignore' });
        execFileSync('git', ['commit', '-m', 'accepted completed task'], { cwd: root, stdio: 'ignore' });
        for (const taskId of taskIds) {
            const postCommitAudit = buildTaskAuditSummary({ repoRoot: root, taskId });
            assert.equal(postCommitAudit.status, 'PASS', JSON.stringify(postCommitAudit.blockers));
            synchronizeFinalCloseoutArtifacts(postCommitAudit);
        }
    };
    return { root, bundleRoot, eventsDir, reviewsDir, preflightPath, commit };
}

test('terminal eligibility requires committed scope and fresh successful post-commit evidence', t => {
    const fixture = completedFixture(t);
    assert.equal(inspect(fixture.root).eligible, false);
    assert.equal(inspect(fixture.root, false).eligible, true);
    fixture.commit();
    assert.equal(inspect(fixture.root).eligible, true);
});

function hideAcceptedContentFromGit(root: string, indexFlag: string): void {
    execFileSync('git', ['update-index', indexFlag, '--', 'example.txt'], { cwd: root });
    assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim(), '');
    assert.equal(buildTaskAuditSummary({ repoRoot: root, taskId: TASK_ID }).status, 'PASS');
}

test('reject uncommitted accepted content hidden by assume-unchanged', t => {
    const fixture = completedFixture(t);
    hideAcceptedContentFromGit(fixture.root, '--assume-unchanged');
    assert.equal(inspect(fixture.root).eligible, false);
});

test('reject uncommitted accepted content hidden by skip-worktree', t => {
    const fixture = completedFixture(t);
    hideAcceptedContentFromGit(fixture.root, '--skip-worktree');
    assert.equal(inspect(fixture.root).eligible, false);
});

for (const indexFlag of ['--assume-unchanged', '--skip-worktree']) {
    test(`committed accepted content remains eligible with ${indexFlag}`, t => {
        const fixture = completedFixture(t);
        fixture.commit();
        execFileSync('git', ['update-index', indexFlag, '--', 'example.txt'], { cwd: fixture.root });
        assert.equal(inspect(fixture.root).eligible, true);
    });
}

test('accepted new files require their exact content in the selected commit', t => {
    const fixture = completedFixture(t, false, 'accepted new content\n', null);
    assert.equal(inspect(fixture.root).eligible, false);
    fixture.commit();
    assert.equal(inspect(fixture.root).eligible, true);
});

test('accepted deletion requires absence from the selected commit', t => {
    const fixture = completedFixture(t, false, null);
    assert.equal(inspect(fixture.root).eligible, false);
    fixture.commit();
    assert.equal(inspect(fixture.root).eligible, true);
});

test('reject Git-converted commit bytes that differ from accepted working content', t => {
    const fixture = completedFixture(t, false, 'accepted completed content\r\n');
    execFileSync('git', ['config', 'core.autocrlf', 'true'], { cwd: fixture.root });
    fixture.commit();
    assert.equal(inspect(fixture.root).eligible, false);
});

test('authenticated successful closeout resolves earlier failed and blocked attempts for retention', t => {
    const fixture = completedFixture(t, true);
    fixture.commit();
    const preview = retention.buildRuntimeRetentionPreview(fixture.root, fixture.bundleRoot, [{
        path: path.join(fixture.eventsDir, `${TASK_ID}.jsonl`), category: 'task-events'
    }]);
    assert.equal(preview.tasks[0].health_state, 'healthy_done');
    assert.equal(inspect(fixture.root).eligible, true);
});

test('retention recovery rejects a foreign runtime bundle with the same task ID', t => {
    const source = completedFixture(t, true);
    source.commit();
    const target = completedFixture(t, true);
    target.commit();
    fs.appendFileSync(path.join(target.reviewsDir, `${TASK_ID}-final-closeout.json`), ' ');
    const timelinePath = path.join(target.eventsDir, `${TASK_ID}.jsonl`);
    const retainedAt = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    fs.utimesSync(timelinePath, retainedAt, retainedAt);
    assert.equal(inspect(source.root).eligible, true);
    assert.equal(inspect(target.root).eligible, false);
    const preview = retention.buildRuntimeRetentionPreview(source.root, target.bundleRoot, [{
        path: timelinePath, category: 'task-events'
    }]);
    assert.equal(preview.tasks[0].health_state, 'blocked');
    assert.equal(preview.tasks[0].eligible_now, false);
});

test('retention recovery accepts canonical path aliases for the same workspace', t => {
    const fixture = completedFixture(t, true);
    fixture.commit();
    const aliasedRoot = `${fixture.root}${path.sep}..${path.sep}${path.basename(fixture.root)}`;
    const aliasedBundle = `${fixture.bundleRoot}${path.sep}..${path.sep}${path.basename(fixture.bundleRoot)}${path.sep}`;
    const preview = retention.buildRuntimeRetentionPreview(aliasedRoot, aliasedBundle, [{
        path: path.join(fixture.eventsDir, `${TASK_ID}.jsonl`), category: 'task-events'
    }]);
    assert.equal(preview.tasks[0].health_state, 'healthy_done');
});

test('recovered-task preview reads the canonical queue a constant number of times across tasks', t => {
    const taskIds = [TASK_ID, 'T-RETIRE-2', 'T-RETIRE-3'];
    const fixture = completedFixture(t, true, undefined, undefined, { extraTaskIds: taskIds.slice(1) });
    fixture.commit();
    const nativeFs = require('node:fs') as typeof fs;
    const originalRead = nativeFs.readFileSync;
    let queueReads = 0;
    t.mock.method(nativeFs, 'readFileSync', (...args: Parameters<typeof fs.readFileSync>) => {
        if (String(args[0]) === path.join(fixture.root, 'TASK.md')) queueReads += 1;
        return originalRead(...args);
    });
    const preview = retention.buildRuntimeRetentionPreview(fixture.root, fixture.bundleRoot, taskIds.map(taskId => ({
        path: path.join(fixture.eventsDir, `${taskId}.jsonl`), category: 'task-events'
    })));
    assert.equal(preview.tasks.length, taskIds.length);
    assert.ok(preview.tasks.every(task => task.health_state === 'healthy_done'));
    assert.ok(queueReads <= 3, `canonical queue was reread ${queueReads} times for ${taskIds.length} recovered tasks`);
});

test('reject a queue reopened during shared terminal evidence verification', t => {
    const taskIds = [TASK_ID, 'T-RETIRE-2'];
    const fixture = completedFixture(t, true, undefined, undefined, { extraTaskIds: taskIds.slice(1) });
    fixture.commit();
    const nativeFs = require('node:fs') as typeof fs;
    const originalRead = nativeFs.readFileSync;
    let reopened = false;
    t.mock.method(nativeFs, 'readFileSync', (...args: Parameters<typeof fs.readFileSync>) => {
        const value = originalRead(...args);
        if (!reopened && String(args[0]) === path.join(fixture.reviewsDir, `${TASK_ID}-compile-gate.json`)) {
            reopened = true;
            writeTaskQueue(fixture.root, taskIds.map(id => ({ id, status: id === TASK_ID ? 'IN_PROGRESS' : 'DONE' })));
        }
        return value;
    });
    const preview = retention.buildRuntimeRetentionPreview(fixture.root, fixture.bundleRoot, taskIds.map(taskId => ({
        path: path.join(fixture.eventsDir, `${taskId}.jsonl`), category: 'task-events'
    })));
    assert.equal(reopened, true);
    assert.ok(preview.tasks.every(task => task.health_state !== 'healthy_done' && !task.eligible_now));
});

test('committed-scope verification batches small files including literal paths, empty and binary contents', t => {
    const single = completedFixture(t);
    single.commit();
    const fixture = completedFixture(t, false, null, undefined, { additionalFiles: {
        '[literal].txt': 'literal path\n', 'space name.txt': 'a\0b\nc\n', 'empty.txt': '',
        'one.txt': 'one\n', 'two.txt': 'two\n', 'three.txt': 'three\n', 'four.txt': 'four\n'
    } });
    fixture.commit();
    const childProcess = require('node:child_process') as typeof import('node:child_process');
    const originalExec = childProcess.execFileSync;
    let gitCalls = 0;
    t.mock.method(childProcess, 'execFileSync', (...args: Parameters<typeof childProcess.execFileSync>) => {
        if (args[0] === 'git') gitCalls += 1;
        return originalExec(...args);
    });
    const addedGitCalls = (root: string) => {
        gitCalls = 0;
        assert.equal(inspect(root, false).eligible, true);
        const auditCalls = gitCalls;
        gitCalls = 0;
        assert.equal(inspect(root).eligible, true);
        return gitCalls - auditCalls;
    };
    const singleFileCalls = addedGitCalls(single.root), eightPathCalls = addedGitCalls(fixture.root);
    t.diagnostic(`Added Git calls: one file=${singleFileCalls}, eight paths=${eightPathCalls}`);
    assert.ok(eightPathCalls <= singleFileCalls + 1,
        `small-file scope grew from ${singleFileCalls} to ${eightPathCalls} added Git processes`);
});

test('bounded blob batches verify an aggregate larger than one capture budget', t => {
    const fixture = completedFixture(t, false, undefined, undefined, { additionalFiles: {
        'large-one.txt': 'a'.repeat(3 * 1024 * 1024), 'large-two.txt': 'b'.repeat(3 * 1024 * 1024)
    } });
    fixture.commit();
    assert.equal(inspect(fixture.root).eligible, true);
});

test('reject truncated and foreign object responses from committed blob batches', t => {
    const fixture = completedFixture(t);
    fixture.commit();
    const childProcess = require('node:child_process') as typeof import('node:child_process');
    const originalExec = childProcess.execFileSync;
    let corrupt: 'truncated' | 'foreign' = 'truncated', injections = 0;
    t.mock.method(childProcess, 'execFileSync', (...args: Parameters<typeof childProcess.execFileSync>) => {
        const output = originalExec(...args);
        const gitArgs = args[1];
        if (args[0] === 'git' && Array.isArray(gitArgs) && gitArgs.length === 4
            && gitArgs[2] === 'cat-file' && gitArgs[3] === '--batch' && Buffer.isBuffer(output)) {
            injections += 1;
            if (corrupt === 'truncated') return output.subarray(0, output.length - 1);
            const replaced = Buffer.from(output);
            replaced.fill(0x30, 0, 40);
            return replaced;
        }
        return output;
    });
    assert.equal(inspect(fixture.root).eligible, false);
    corrupt = 'foreign';
    assert.equal(inspect(fixture.root).eligible, false);
    assert.equal(injections, 2);
});

test('a later failure rejects stale terminal acceptance even when timestamps are older than successful closeout', t => {
    const fixture = completedFixture(t);
    fixture.commit();
    appendIntegrityEvent(fixture.eventsDir, TASK_ID, {
        event_type: 'COMPILE_GATE_FAILED', timestamp_utc: '2020-01-01T00:00:00.000Z'
    });
    assert.equal(inspect(fixture.root).eligible, false);
});

test('restarted and reopened task state cannot reuse old successful cleanup eligibility', t => {
    const fixture = completedFixture(t);
    fixture.commit();
    appendIntegrityEvent(fixture.eventsDir, TASK_ID, { event_type: 'TASK_MODE_ENTERED' });
    assert.equal(inspect(fixture.root).eligible, false);
    writeTaskQueue(fixture.root, [{ id: TASK_ID, status: 'IN_PROGRESS' }]);
    assert.equal(inspect(fixture.root).eligible, false);
});

test('missing ledger or a self-declared verified ledger without hash bindings cannot authorize cleanup', t => {
    const fixture = completedFixture(t);
    fixture.commit();
    const ledgerPath = path.join(fixture.bundleRoot, 'runtime', 'task-ledger', `${TASK_ID}.json`);
    fs.unlinkSync(ledgerPath);
    assert.equal(inspect(fixture.root).eligible, false);
    fs.writeFileSync(ledgerPath, JSON.stringify({
        schema_version: 1, event_source: 'task-history-ledger', task_id: TASK_ID,
        verification: { status: 'VERIFIED', issues: [] }
    }));
    assert.equal(inspect(fixture.root).eligible, false);
});

test('tampered closeout and changed accepted evidence stay blocking', t => {
    const fixture = completedFixture(t);
    fixture.commit();
    fs.appendFileSync(path.join(fixture.reviewsDir, `${TASK_ID}-final-closeout.json`), ' ');
    assert.equal(inspect(fixture.root).eligible, false);
});

test('stale source acceptance cannot authorize cleanup after later content drift', t => {
    const fixture = completedFixture(t);
    fixture.commit();
    fs.writeFileSync(path.join(fixture.root, 'example.txt'), 'different completed content\n');
    assert.equal(inspect(fixture.root).eligible, false);
});

for (const change of ['edit', 'delete', 'restore deletion'] as const) {
    test(`reject accepted source ${change} after native audit without committed-scope enforcement`, t => {
        const fixture = completedFixture(t, false, change === 'restore deletion' ? null : undefined);
        fixture.commit();
        const nativeFs = require('node:fs') as typeof fs;
        const originalRead = nativeFs.readFileSync;
        const ledgerPath = path.join(fixture.bundleRoot, 'runtime', 'task-ledger', `${TASK_ID}.json`);
        let changed = false;
        t.mock.method(nativeFs, 'readFileSync', (...args: Parameters<typeof fs.readFileSync>) => {
            const value = originalRead(...args);
            if (!changed && String(args[0]) === ledgerPath) {
                changed = true;
                const sourcePath = path.join(fixture.root, 'example.txt');
                if (change === 'delete') fs.unlinkSync(sourcePath);
                else fs.writeFileSync(sourcePath, 'content changed after native acceptance\n');
            }
            return value;
        });
        assert.equal(inspect(fixture.root, false).eligible, false);
        assert.equal(changed, true, 'source drift must occur after the native audit');
    });
}

test('reject a different source commit made after native acceptance', t => {
    const fixture = completedFixture(t);
    fixture.commit();
    const nativeFs = require('node:fs') as typeof fs;
    const originalRead = nativeFs.readFileSync;
    const ledgerPath = path.join(fixture.bundleRoot, 'runtime', 'task-ledger', `${TASK_ID}.json`);
    let committed = false;
    t.mock.method(nativeFs, 'readFileSync', (...args: Parameters<typeof fs.readFileSync>) => {
        const value = originalRead(...args);
        if (!committed && String(args[0]) === ledgerPath) {
            committed = true;
            fs.writeFileSync(path.join(fixture.root, 'example.txt'), 'new commit after native acceptance\n');
            execFileSync('git', ['add', '--', 'example.txt'], { cwd: fixture.root, stdio: 'ignore' });
            execFileSync('git', ['commit', '-m', 'concurrent changed source'], { cwd: fixture.root, stdio: 'ignore' });
        }
        return value;
    });
    assert.equal(inspect(fixture.root).eligible, false);
    assert.equal(committed, true, 'commit must change after the native audit');
});

test('foreign compact records copied from another workspace cannot authorize cleanup', t => {
    const source = completedFixture(t);
    source.commit();
    const target = completedFixture(t);
    target.commit();
    fs.copyFileSync(
        path.join(source.bundleRoot, 'runtime', 'task-ledger', `${TASK_ID}.json`),
        path.join(target.bundleRoot, 'runtime', 'task-ledger', `${TASK_ID}.json`)
    );
    assert.equal(inspect(target.root).eligible, false);
});

test('hardlinked compact evidence is rejected before cleanup', t => {
    const fixture = completedFixture(t);
    fixture.commit();
    fs.linkSync(path.join(fixture.reviewsDir, `${TASK_ID}-final-closeout.json`), path.join(fixture.root, 'shared-closeout.json'));
    assert.equal(inspect(fixture.root).eligible, false);
});

test('a foreign closeout task identity stays blocking even when its ledger hash is updated', t => {
    const fixture = completedFixture(t);
    fixture.commit();
    const closeoutPath = path.join(fixture.reviewsDir, `${TASK_ID}-final-closeout.json`);
    const closeout = JSON.parse(fs.readFileSync(closeoutPath, 'utf8'));
    closeout.task_id = 'T-OTHER';
    fs.writeFileSync(closeoutPath, JSON.stringify(closeout));
    const ledgerPath = path.join(fixture.bundleRoot, 'runtime', 'task-ledger', `${TASK_ID}.json`);
    const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
    ledger.artifact_refs.final_closeout_json.sha256 = computeFileSha256(closeoutPath);
    fs.writeFileSync(ledgerPath, JSON.stringify(ledger));
    assert.equal(inspect(fixture.root).eligible, false);
});

test('a tampered timeline cannot acquire cleanup eligibility from compact success labels', t => {
    const fixture = completedFixture(t);
    fixture.commit();
    const timelinePath = path.join(fixture.eventsDir, `${TASK_ID}.jsonl`);
    const timeline = fs.readFileSync(timelinePath, 'utf8');
    fs.writeFileSync(timelinePath, timeline.replace('TASK_MODE_ENTERED passed.', 'Changed historical event.'));
    assert.equal(inspect(fixture.root).eligible, false);
});

test('repeated eligibility reads leave compact evidence unchanged', t => {
    const fixture = completedFixture(t);
    fixture.commit();
    const paths = [
        path.join(fixture.bundleRoot, 'runtime', 'task-ledger', `${TASK_ID}.json`),
        path.join(fixture.reviewsDir, `${TASK_ID}-final-closeout.json`),
        path.join(fixture.eventsDir, `${TASK_ID}.jsonl`),
        path.join(fixture.root, 'TASK.md')
    ];
    const before = paths.map(computeFileSha256);
    assert.equal(inspect(fixture.root).eligible, true);
    assert.equal(inspect(fixture.root).eligible, true);
    assert.deepEqual(paths.map(computeFileSha256), before);
});
