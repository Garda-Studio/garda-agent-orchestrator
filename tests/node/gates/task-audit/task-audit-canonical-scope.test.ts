import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { initGitRepo, runGitFixtureCommand } from '../git-fixtures';
import {
    ALL_REVIEW_FLAGS, TASK_ID, makeTempRepo, reviewsRoot, writeJson,
    seedStartedTask, writePreflight, writeGitAutoPreflight, writeStagedPreflight,
    seedCompilePass, seedGitAutoCompilePass, seedStagedCompilePass, seedReviewGatePass,
    seedDocImpactPass, seedCompletionPass, seedPostPreflightRulePack
} from '../next-step/next-step-completion-fixtures';
import { getWorkspaceSnapshot } from '../../../../src/gates/compile/compile-gate';
import { buildDomainScopeFingerprints } from '../../../../src/gates/scope/domain-scope-fingerprints';
import {
    buildPostDoneAuditedScopeFingerprint, readPostDoneAuditedScopeFingerprint, evaluateStagedPostDoneAuditedScope
} from '../../../../src/gates/task-audit/task-audit-summary-drift';

const TRACKED_SCOPE = [
    'README.md', 'docs/!guidance.md', 'docs/Z-guide.md', 'docs/a-guide.md',
    'docs/Ä-guide.md', 'docs/Ω-guide.md', 'src/app.ts'
];
const IGNORED_CLOSEOUT_FILE = 'garda-agent-orchestrator/live/docs/changes/CHANGELOG.md';
const PROTECTED_BASELINE_FILE = 'src/parent-wip.ts';
const TRACKED_CLOSEOUT_FILE = 'docs/closeout-extra.md';
const ORIGINALLY_UNTRACKED_FILE = 'src/new-untracked.ts';

function writeFile(repoRoot: string, relativePath: string, content: string): void {
    const destination = path.join(repoRoot, relativePath);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, content);
}

function nativeJson(repoRoot: string, args: string[]) {
    const result = spawnSync(process.execPath, [require.resolve('../../../../src/cli/main'),
        ...args, '--repo-root', repoRoot, '--as-json'], {
        cwd: repoRoot, encoding: 'utf8', windowsHide: true, timeout: 30_000
    });
    assert.equal(result.error, undefined, String(result.error));
    assert.equal(result.signal, null);
    return { exitCode: result.status, errors: [result.stderr],
        payload: JSON.parse(result.stdout) as Record<string, unknown> };
}

async function completedFixture(staged = false, protectedBaseline = false, trackedCloseoutExtra = false, historicalBinding = false, stagedPlusUntracked = false) {
    const repoRoot = makeTempRepo();
    for (const file of TRACKED_SCOPE) writeFile(repoRoot, file, 'baseline\n');
    if (protectedBaseline) writeFile(repoRoot, PROTECTED_BASELINE_FILE, 'parent baseline\n');
    if (trackedCloseoutExtra) writeFile(repoRoot, TRACKED_CLOSEOUT_FILE, 'extra baseline\n');
    initGitRepo(repoRoot, { gitignoreContent: 'garda-agent-orchestrator/\nTASK.md\n' });
    for (const file of TRACKED_SCOPE) fs.appendFileSync(path.join(repoRoot, file), 'completed\n');
    writeFile(repoRoot, IGNORED_CLOSEOUT_FILE, '# Completed change\n');
    if (protectedBaseline) writeFile(repoRoot, PROTECTED_BASELINE_FILE, 'parent work in progress\n');
    if (stagedPlusUntracked) writeFile(repoRoot, ORIGINALLY_UNTRACKED_FILE, 'completed untracked content\n');
    if (staged) runGitFixtureCommand(repoRoot, ['add', '--', ...TRACKED_SCOPE]);
    seedStartedTask(repoRoot, TASK_ID);
    const mixedSnapshot = stagedPlusUntracked
        ? getWorkspaceSnapshot(repoRoot, 'git_staged_plus_untracked', true, []) : null;
    const preflightPath = mixedSnapshot
        ? writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS }, { changedFiles: mixedSnapshot.changed_files })
        : staged
        ? writeStagedPreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS })
        : protectedBaseline
            ? writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS }, { changedFiles: TRACKED_SCOPE })
            : writeGitAutoPreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS });
    if (mixedSnapshot) {
        const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8'));
        writeJson(preflightPath, { ...preflight, detection_source: mixedSnapshot.detection_source,
            use_staged: true, include_untracked: true, git_change_classification: mixedSnapshot.git_change_classification,
            metrics: { ...preflight.metrics, changed_lines_total: mixedSnapshot.changed_lines_total,
                changed_files_sha256: mixedSnapshot.changed_files_sha256,
                scope_content_sha256: mixedSnapshot.scope_content_sha256, scope_sha256: mixedSnapshot.scope_sha256,
                domain_scope_fingerprints: buildDomainScopeFingerprints({ repoRoot,
                    detectionSource: mixedSnapshot.detection_source, includeUntracked: true,
                    changedFiles: mixedSnapshot.changed_files }) } });
        seedPostPreflightRulePack(repoRoot, TASK_ID, preflightPath);
    }
    if (protectedBaseline) {
        const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8'));
        const hash = createHash('sha256').update(fs.readFileSync(path.join(repoRoot, PROTECTED_BASELINE_FILE))).digest('hex');
        writeJson(preflightPath, { ...preflight, triggers: {
            dirty_workspace_protection_status: 'PASS',
            dirty_workspace_untouched_baseline_files: [PROTECTED_BASELINE_FILE],
            dirty_workspace_protected_files: [PROTECTED_BASELINE_FILE],
            dirty_workspace_protected_files_sha256: createHash('sha256').update(PROTECTED_BASELINE_FILE).digest('hex'),
            dirty_workspace_protected_file_hashes: { [PROTECTED_BASELINE_FILE]: hash }
        } });
    }
    if (mixedSnapshot) {
        seedCompilePass(repoRoot, TASK_ID, undefined, mixedSnapshot.changed_files);
        const compilePath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-compile-gate.json`);
        const compile = JSON.parse(fs.readFileSync(compilePath, 'utf8'));
        writeJson(compilePath, { ...compile, scope_detection_source: mixedSnapshot.detection_source,
            scope_include_untracked: true, scope_changed_lines_total: mixedSnapshot.changed_lines_total,
            scope_changed_files_sha256: mixedSnapshot.changed_files_sha256,
            scope_content_sha256: mixedSnapshot.scope_content_sha256, scope_sha256: mixedSnapshot.scope_sha256 });
    } else if (staged) {
        seedStagedCompilePass(repoRoot, TASK_ID);
    } else if (protectedBaseline) {
        seedCompilePass(repoRoot, TASK_ID, undefined, TRACKED_SCOPE);
    } else {
        seedGitAutoCompilePass(repoRoot, TASK_ID);
    }
    seedReviewGatePass(repoRoot, TASK_ID);
    if (trackedCloseoutExtra) fs.appendFileSync(path.join(repoRoot, TRACKED_CLOSEOUT_FILE), 'completed extra\n');
    seedDocImpactPass(repoRoot, TASK_ID);
    const docImpactPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-doc-impact.json`);
    const docImpact = JSON.parse(fs.readFileSync(docImpactPath, 'utf8')) as Record<string, unknown>;
    writeJson(docImpactPath, { ...docImpact, decision: 'DOCS_UPDATED',
        docs_updated: [IGNORED_CLOSEOUT_FILE, ...(trackedCloseoutExtra ? [TRACKED_CLOSEOUT_FILE] : [])] });
    seedCompletionPass(repoRoot, TASK_ID);
    const initial = await nativeJson(repoRoot, ['gate', 'task-audit-summary', '--task-id', TASK_ID]);
    assert.equal(initial.exitCode, 0, initial.errors.join('\n'));
    assert.equal(initial.payload.status, 'PASS');
    if (historicalBinding) {
        // Publish the historical optional-field shape with a genuine materialization ledger.
        const script = 'const fs=require("node:fs");const audit=JSON.parse(fs.readFileSync(0,"utf8"));' +
            'delete audit.final_closeout.implementation_summary.worktree_scope_content_sha256;' +
            'audit.final_closeout.implementation_summary.changed_files_sha256=' +
            'audit.final_closeout.implementation_summary.audited_scope_provenance.changed_files_sha256;' +
            'require(process.argv[1]).synchronizeFinalCloseoutArtifacts(audit);';
        const published = spawnSync(process.execPath, ['-e', script,
            require.resolve('../../../../src/gates/task-audit/task-audit-summary')], {
            cwd: repoRoot, input: JSON.stringify(initial.payload), encoding: 'utf8', windowsHide: true, timeout: 30_000
        });
        assert.equal(published.status, 0, String(published.error || published.stderr));
    }
    const closeoutPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-final-closeout.json`);
    const closeout = JSON.parse(fs.readFileSync(closeoutPath, 'utf8')) as Record<string, unknown>;
    const summary = closeout.implementation_summary as Record<string, unknown>;
    assert.ok((summary.changed_files as string[]).includes(IGNORED_CLOSEOUT_FILE));
    assert.ok((summary.changed_files as string[]).includes('README.md'));
    if (staged) {
        const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8'));
        assert.equal(summary.scope_content_sha256, preflight.metrics.scope_content_sha256);
        if (!historicalBinding) assert.equal(summary.worktree_scope_content_sha256,
            buildPostDoneAuditedScopeFingerprint(repoRoot, summary.changed_files as string[]).scope_content_sha256);
    }
    const originalCloseoutBytes = fs.readFileSync(closeoutPath);
    runGitFixtureCommand(repoRoot, ['add', '--', ...TRACKED_SCOPE, ...(trackedCloseoutExtra ? [TRACKED_CLOSEOUT_FILE] : []),
        ...(stagedPlusUntracked ? [ORIGINALLY_UNTRACKED_FILE] : [])]);
    runGitFixtureCommand(repoRoot, ['commit', '-m', 'commit unchanged completed scope']);
    assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: repoRoot, encoding: 'utf8' }).trim(),
        protectedBaseline ? `M ${PROTECTED_BASELINE_FILE}` : '');
    return { repoRoot, closeoutPath, closeout, summary, originalCloseoutBytes };
}

test('unchanged mixed tracked and ignored closeout survives ordinary commit from an unstaged scope', async () => {
    const fixture = await completedFixture();
    const next = await nativeJson(fixture.repoRoot, ['next-step', TASK_ID]);
    assert.equal(next.payload.status, 'DONE', String(next.payload.reason));
    assert.equal(next.payload.next_gate, null);
    assert.deepEqual(fs.readFileSync(fixture.closeoutPath), fixture.originalCloseoutBytes);
    const audit = await nativeJson(fixture.repoRoot, ['gate', 'task-audit-summary', '--task-id', TASK_ID]);
    assert.equal(audit.exitCode, 0, JSON.stringify(audit.payload.blockers));
    assert.equal(audit.payload.status, 'PASS');
});

test('unchanged mixed tracked and ignored closeout survives ordinary commit from a staged scope', async () => {
    const fixture = await completedFixture(true);
    const next = await nativeJson(fixture.repoRoot, ['next-step', TASK_ID]);
    assert.equal(next.payload.status, 'DONE', String(next.payload.reason));
    assert.deepEqual(fs.readFileSync(fixture.closeoutPath), fixture.originalCloseoutBytes);
    const audit = await nativeJson(fixture.repoRoot, ['gate', 'task-audit-summary', '--task-id', TASK_ID]);
    assert.equal(audit.exitCode, 0, JSON.stringify(audit.payload.blockers));
    assert.equal(audit.payload.status, 'PASS');
});

test('committed explicit scope stays complete beside an unchanged protected parent WIP', async () => {
    const fixture = await completedFixture(false, true);
    const next = await nativeJson(fixture.repoRoot, ['next-step', TASK_ID]);
    assert.equal(next.payload.status, 'DONE', String(next.payload.reason));
    assert.deepEqual(fs.readFileSync(fixture.closeoutPath), fixture.originalCloseoutBytes);
    const audit = await nativeJson(fixture.repoRoot, ['gate', 'task-audit-summary', '--task-id', TASK_ID]);
    assert.equal(audit.payload.status, 'PASS', JSON.stringify(audit.payload.blockers));
    assert.equal(fs.readFileSync(path.join(fixture.repoRoot, PROTECTED_BASELINE_FILE), 'utf8'), 'parent work in progress\n');
    const refreshedSummary = JSON.parse(fs.readFileSync(fixture.closeoutPath, 'utf8')).implementation_summary;
    assert.deepEqual(refreshedSummary.changed_files, fixture.summary.changed_files);
    assert.equal(refreshedSummary.changed_files_sha256, fixture.summary.changed_files_sha256);
    assert.equal(refreshedSummary.scope_content_sha256, fixture.summary.scope_content_sha256);
    const refreshedNext = await nativeJson(fixture.repoRoot, ['next-step', TASK_ID]);
    assert.equal(refreshedNext.payload.status, 'DONE', String(refreshedNext.payload.reason));
});

test('committed staged scope stays complete beside an unchanged protected parent WIP', async () => {
    const fixture = await completedFixture(true, true);
    const next = await nativeJson(fixture.repoRoot, ['next-step', TASK_ID]);
    const audit = await nativeJson(fixture.repoRoot, ['gate', 'task-audit-summary', '--task-id', TASK_ID]);
    assert.equal(next.payload.status, 'DONE', String(next.payload.reason));
    assert.equal(audit.payload.status, 'PASS', JSON.stringify(audit.payload.blockers));
    assert.equal(fs.readFileSync(path.join(fixture.repoRoot, PROTECTED_BASELINE_FILE), 'utf8'), 'parent work in progress\n');
});

test('changed protected parent WIP remains blocked after the completed scope is committed', async () => {
    const fixture = await completedFixture(false, true);
    writeFile(fixture.repoRoot, PROTECTED_BASELINE_FILE, 'changed parent WIP\n');
    const next = await nativeJson(fixture.repoRoot, ['next-step', TASK_ID]);
    const audit = await nativeJson(fixture.repoRoot, ['gate', 'task-audit-summary', '--task-id', TASK_ID]);
    assert.equal(next.payload.status, 'BLOCKED', String(next.payload.reason));
    assert.equal(audit.payload.status, 'BLOCKED');
    assert.match(String(next.payload.reason), /parent-wip/);
});

test('later committed staged implementation edits remain blocked by both native consumers', async () => {
    const fixture = await completedFixture(true);
    fs.appendFileSync(path.join(fixture.repoRoot, 'README.md'), 'later change\n');
    runGitFixtureCommand(fixture.repoRoot, ['add', '--', 'README.md']);
    runGitFixtureCommand(fixture.repoRoot, ['commit', '-m', 'change completed staged content']);
    const next = await nativeJson(fixture.repoRoot, ['next-step', TASK_ID]);
    const audit = await nativeJson(fixture.repoRoot, ['gate', 'task-audit-summary', '--task-id', TASK_ID]);
    assert.equal(next.payload.status, 'BLOCKED', String(next.payload.reason));
    assert.equal(audit.payload.status, 'BLOCKED');
    assert.deepEqual(fs.readFileSync(fixture.closeoutPath), fixture.originalCloseoutBytes);
});

test('later committed staged implementation deletion remains blocked by both native consumers', async () => {
    const fixture = await completedFixture(true);
    runGitFixtureCommand(fixture.repoRoot, ['rm', '--', 'README.md']);
    runGitFixtureCommand(fixture.repoRoot, ['commit', '-m', 'delete completed staged file']);
    const next = await nativeJson(fixture.repoRoot, ['next-step', TASK_ID]);
    const audit = await nativeJson(fixture.repoRoot, ['gate', 'task-audit-summary', '--task-id', TASK_ID]);
    assert.equal(next.payload.status, 'BLOCKED', String(next.payload.reason));
    assert.equal(audit.payload.status, 'BLOCKED');
    assert.deepEqual(fs.readFileSync(fixture.closeoutPath), fixture.originalCloseoutBytes);
});

test('later committed staged implementation rename remains blocked by both native consumers', async () => {
    const fixture = await completedFixture(true);
    runGitFixtureCommand(fixture.repoRoot, ['mv', 'README.md', 'docs/renamed-staged.md']);
    runGitFixtureCommand(fixture.repoRoot, ['commit', '-m', 'rename completed staged file']);
    const next = await nativeJson(fixture.repoRoot, ['next-step', TASK_ID]);
    const audit = await nativeJson(fixture.repoRoot, ['gate', 'task-audit-summary', '--task-id', TASK_ID]);
    assert.equal(next.payload.status, 'BLOCKED', String(next.payload.reason));
    assert.equal(audit.payload.status, 'BLOCKED');
    assert.deepEqual(fs.readFileSync(fixture.closeoutPath), fixture.originalCloseoutBytes);
});

test('unchanged tracked closeout extra survives ordinary staged commit and repeated audit', async () => {
    const fixture = await completedFixture(true, false, true);
    const next = await nativeJson(fixture.repoRoot, ['next-step', TASK_ID]);
    assert.equal(next.payload.status, 'DONE', String(next.payload.reason));
    assert.deepEqual(fs.readFileSync(fixture.closeoutPath), fixture.originalCloseoutBytes);
    const audit = await nativeJson(fixture.repoRoot, ['gate', 'task-audit-summary', '--task-id', TASK_ID]);
    assert.equal(audit.payload.status, 'PASS', JSON.stringify(audit.payload.blockers));
    const repeated = await nativeJson(fixture.repoRoot, ['next-step', TASK_ID]);
    assert.equal(repeated.payload.status, 'DONE', String(repeated.payload.reason));
});

test('later committed tracked closeout extra edits remain blocked by both native consumers', async () => {
    const fixture = await completedFixture(true, false, true);
    fs.appendFileSync(path.join(fixture.repoRoot, TRACKED_CLOSEOUT_FILE), 'later extra change\n');
    runGitFixtureCommand(fixture.repoRoot, ['add', '--', TRACKED_CLOSEOUT_FILE]);
    runGitFixtureCommand(fixture.repoRoot, ['commit', '-m', 'change completed closeout extra']);
    const next = await nativeJson(fixture.repoRoot, ['next-step', TASK_ID]);
    const audit = await nativeJson(fixture.repoRoot, ['gate', 'task-audit-summary', '--task-id', TASK_ID]);
    assert.equal(next.payload.status, 'BLOCKED', String(next.payload.reason));
    assert.equal(audit.payload.status, 'BLOCKED');
    assert.deepEqual(fs.readFileSync(fixture.closeoutPath), fixture.originalCloseoutBytes);
});

test('mixed case punctuation and Unicode scope hashes remain canonical across locale settings', async () => {
    const fixture = await completedFixture();
    const files = fixture.summary.changed_files as string[];
    const expected = createHash('sha256').update([...new Set(files)].sort().join('\n')).digest('hex');
    assert.equal(fixture.summary.changed_files_sha256, expected);
    const modulePath = require.resolve('../../../../src/gates/task-audit/task-audit-summary-drift');
    const script = [
        'const {readPostDoneAuditedScopeFingerprint}=require(process.argv[1]);',
        'const [root,files,summary]=process.argv.slice(2).map(JSON.parse);',
        'console.log(JSON.stringify(readPostDoneAuditedScopeFingerprint(root,files,summary)));'
    ].join('\n');
    for (const locale of ['en_US.UTF-8', 'sv_SE.UTF-8', 'tr_TR.UTF-8']) {
        const output = execFileSync(process.execPath, ['-e', script, modulePath,
            JSON.stringify(fixture.repoRoot), JSON.stringify(files), JSON.stringify(fixture.summary)], {
            encoding: 'utf8', env: { ...process.env, LANG: locale, LC_ALL: locale }
        });
        const fingerprint = JSON.parse(output) as Record<string, unknown>;
        assert.equal(fingerprint.changed_files_sha256, expected, locale);
        assert.equal(fingerprint.scope_content_sha256, fixture.summary.scope_content_sha256, locale);
    }
});

test('authenticated historical list order is preserved without rewriting the closeout', async () => {
    const fixture = await completedFixture();
    const files = fixture.summary.changed_files as string[];
    const historicalSummary = { ...fixture.summary, changed_files: [...files].reverse() };
    const fingerprint = readPostDoneAuditedScopeFingerprint(fixture.repoRoot, files, historicalSummary);
    assert.equal(fingerprint.changed_files_sha256, fixture.summary.changed_files_sha256);
    assert.equal(fingerprint.scope_content_sha256, fixture.summary.scope_content_sha256);
    assert.deepEqual(fs.readFileSync(fixture.closeoutPath), fixture.originalCloseoutBytes);
});

test('authenticated historical hashes without list metadata retain the complete audited scope', async () => {
    const fixture = await completedFixture();
    const historicalSummary = { ...fixture.summary };
    delete historicalSummary.changed_files;
    const fingerprint = readPostDoneAuditedScopeFingerprint(fixture.repoRoot,
        fixture.summary.changed_files as string[], historicalSummary);
    assert.equal(fingerprint.changed_files_sha256, fixture.summary.changed_files_sha256);
    assert.equal(fingerprint.scope_content_sha256, fixture.summary.scope_content_sha256);
    assert.deepEqual(fs.readFileSync(fixture.closeoutPath), fixture.originalCloseoutBytes);
});

test('post-commit tracked content edits remain blocked by native next-step and task audit', async () => {
    const fixture = await completedFixture();
    fs.appendFileSync(path.join(fixture.repoRoot, 'README.md'), 'forged change\n');
    runGitFixtureCommand(fixture.repoRoot, ['add', '--', 'README.md']);
    runGitFixtureCommand(fixture.repoRoot, ['commit', '-m', 'change completed content']);
    const next = await nativeJson(fixture.repoRoot, ['next-step', TASK_ID]);
    assert.equal(next.payload.next_gate, 'post-done-drift');
    const audit = await nativeJson(fixture.repoRoot, ['gate', 'task-audit-summary', '--task-id', TASK_ID]);
    assert.notEqual(audit.exitCode, 0);
    assert.equal(audit.payload.status, 'BLOCKED');
});

test('post-commit ignored closeout content edits remain blocked', async () => {
    const fixture = await completedFixture(true);
    fs.appendFileSync(path.join(fixture.repoRoot, IGNORED_CLOSEOUT_FILE), 'forged change\n');
    const next = await nativeJson(fixture.repoRoot, ['next-step', TASK_ID]);
    assert.equal(next.payload.next_gate, 'post-done-drift');
    assert.match(String(next.payload.reason), /closeout extra scope/);
});

test('post-commit deletion of an audited file remains blocked', async () => {
    const fixture = await completedFixture();
    fs.unlinkSync(path.join(fixture.repoRoot, 'README.md'));
    runGitFixtureCommand(fixture.repoRoot, ['add', '--', 'README.md']);
    runGitFixtureCommand(fixture.repoRoot, ['commit', '-m', 'delete completed file']);
    const next = await nativeJson(fixture.repoRoot, ['next-step', TASK_ID]);
    assert.equal(next.payload.next_gate, 'post-done-drift');
    assert.equal(next.payload.status, 'BLOCKED');
});

test('post-commit rename of an audited file remains blocked', async () => {
    const fixture = await completedFixture();
    runGitFixtureCommand(fixture.repoRoot, ['mv', 'README.md', 'docs/renamed.md']);
    runGitFixtureCommand(fixture.repoRoot, ['commit', '-m', 'rename completed file']);
    const next = await nativeJson(fixture.repoRoot, ['next-step', TASK_ID]);
    assert.equal(next.payload.next_gate, 'post-done-drift');
    assert.equal(next.payload.status, 'BLOCKED');
});

test('forged audited list hash remains blocked', async () => {
    const fixture = await completedFixture();
    writeJson(fixture.closeoutPath, { ...fixture.closeout, implementation_summary: {
        ...fixture.summary, changed_files_sha256: '0'.repeat(64)
    } });
    const next = await nativeJson(fixture.repoRoot, ['next-step', TASK_ID]);
    assert.equal(next.payload.next_gate, 'post-done-drift');
    assert.match(String(next.payload.reason), /changed_files_sha256/);
});

test('forged audited content hash remains blocked', async () => {
    const fixture = await completedFixture();
    writeJson(fixture.closeoutPath, { ...fixture.closeout, implementation_summary: {
        ...fixture.summary, scope_content_sha256: '0'.repeat(64)
    } });
    const next = await nativeJson(fixture.repoRoot, ['next-step', TASK_ID]);
    assert.equal(next.payload.next_gate, 'post-done-drift');
    assert.match(String(next.payload.reason), /scope_content_sha256/);
});

test('an arbitrary replacement list remains blocked from authenticating the completed audited scope', async () => {
    const fixture = await completedFixture();
    const replacement = buildPostDoneAuditedScopeFingerprint(fixture.repoRoot, ['src/app.ts']);
    const fingerprint = readPostDoneAuditedScopeFingerprint(fixture.repoRoot,
        fixture.summary.changed_files as string[], { ...fixture.summary, ...replacement });
    assert.notEqual(fingerprint.changed_files_sha256, replacement.changed_files_sha256);
    assert.notEqual(fingerprint.scope_content_sha256, replacement.scope_content_sha256);
});

async function forgedResidualScope(replaceList: boolean, staged = false, historicalBinding = false) {
    const fixture = await completedFixture(staged, false, false, historicalBinding);
    const replacement = buildPostDoneAuditedScopeFingerprint(fixture.repoRoot, [IGNORED_CLOSEOUT_FILE]);
    const forgedFields = replaceList ? { ...replacement, changed_files_count: 1 } : {
        changed_files_sha256: replacement.changed_files_sha256,
        scope_content_sha256: replacement.scope_content_sha256
    };
    writeJson(fixture.closeoutPath, { ...fixture.closeout, implementation_summary: {
        ...fixture.summary, ...forgedFields
    } });
    const forgedCloseoutBytes = fs.readFileSync(fixture.closeoutPath);
    const next = await nativeJson(fixture.repoRoot, ['next-step', TASK_ID]);
    const audit = await nativeJson(fixture.repoRoot, ['gate', 'task-audit-summary', '--task-id', TASK_ID]);
    return { fixture, next, audit, forgedCloseoutBytes };
}

test('forged audited scope matching only the remaining ignored Git diff stays blocked', async () => {
    const { fixture, next, audit, forgedCloseoutBytes } = await forgedResidualScope(true);
    assert.equal(next.payload.status, 'BLOCKED', JSON.stringify(next.payload));
    assert.notEqual(audit.exitCode, 0, JSON.stringify(audit.payload));
    assert.equal(audit.payload.status, 'BLOCKED');
    assert.deepEqual(fs.readFileSync(fixture.closeoutPath), forgedCloseoutBytes);
});

test('forged audited hashes matching only the remaining ignored Git diff stays blocked', async () => {
    const { fixture, next, audit, forgedCloseoutBytes } = await forgedResidualScope(false);
    assert.equal(next.payload.status, 'BLOCKED', JSON.stringify(next.payload));
    assert.notEqual(audit.exitCode, 0, JSON.stringify(audit.payload));
    assert.equal(audit.payload.status, 'BLOCKED');
    assert.deepEqual(fs.readFileSync(fixture.closeoutPath), forgedCloseoutBytes);
});

test('forged staged audited list matching only the residual Git diff stays blocked', async () => {
    const { fixture, next, audit, forgedCloseoutBytes } = await forgedResidualScope(true, true);
    assert.equal(next.payload.status, 'BLOCKED', JSON.stringify(next.payload));
    assert.equal(audit.payload.status, 'BLOCKED');
    assert.deepEqual(fs.readFileSync(fixture.closeoutPath), forgedCloseoutBytes);
});

test('forged staged audited hashes matching only the residual Git diff stays blocked', async () => {
    const { fixture, next, audit, forgedCloseoutBytes } = await forgedResidualScope(false, true);
    assert.equal(next.payload.status, 'BLOCKED', JSON.stringify(next.payload));
    assert.equal(audit.payload.status, 'BLOCKED');
    assert.deepEqual(fs.readFileSync(fixture.closeoutPath), forgedCloseoutBytes);
});

test('invalid staged worktree binding null blocks both native consumers', async () => {
    const fixture = await completedFixture(true);
    writeJson(fixture.closeoutPath, { ...fixture.closeout, implementation_summary: {
        ...fixture.summary, worktree_scope_content_sha256: null
    } });
    const originalBytes = fs.readFileSync(fixture.closeoutPath);
    const next = await nativeJson(fixture.repoRoot, ['next-step', TASK_ID]);
    const audit = await nativeJson(fixture.repoRoot, ['gate', 'task-audit-summary', '--task-id', TASK_ID]);
    assert.equal(next.payload.status, 'BLOCKED', JSON.stringify(next.payload));
    assert.equal(audit.payload.status, 'BLOCKED');
    assert.deepEqual(fs.readFileSync(fixture.closeoutPath), originalBytes);
});

test('invalid staged worktree binding forged blocks both native consumers', async () => {
    const fixture = await completedFixture(true);
    writeJson(fixture.closeoutPath, { ...fixture.closeout, implementation_summary: {
        ...fixture.summary, worktree_scope_content_sha256: '0'.repeat(64)
    } });
    const originalBytes = fs.readFileSync(fixture.closeoutPath);
    const next = await nativeJson(fixture.repoRoot, ['next-step', TASK_ID]);
    const audit = await nativeJson(fixture.repoRoot, ['gate', 'task-audit-summary', '--task-id', TASK_ID]);
    assert.equal(next.payload.status, 'BLOCKED', JSON.stringify(next.payload));
    assert.equal(audit.payload.status, 'BLOCKED');
    assert.deepEqual(fs.readFileSync(fixture.closeoutPath), originalBytes);
});

test('authenticated historical staged index remains valid after unchanged commit without a worktree binding', async () => {
    const fixture = await completedFixture(true, false, false, true);
    assert.equal(fixture.summary.worktree_scope_content_sha256, undefined);
    assert.notEqual(fixture.summary.changed_files_sha256, buildPostDoneAuditedScopeFingerprint(
        fixture.repoRoot, fixture.summary.changed_files as string[]).changed_files_sha256);
    const next = await nativeJson(fixture.repoRoot, ['next-step', TASK_ID]);
    assert.equal(next.payload.status, 'DONE', JSON.stringify(next.payload));
    assert.deepEqual(fs.readFileSync(fixture.closeoutPath), fixture.originalCloseoutBytes);
    const audit = await nativeJson(fixture.repoRoot, ['gate', 'task-audit-summary', '--task-id', TASK_ID]);
    assert.equal(audit.payload.status, 'PASS', JSON.stringify(audit.payload.blockers));
});

test('historical staged index without a worktree binding rejects later committed content', async () => {
    const fixture = await completedFixture(true, false, false, true);
    assert.equal(fixture.summary.worktree_scope_content_sha256, undefined);
    const originalBytes = fs.readFileSync(fixture.closeoutPath);
    fs.appendFileSync(path.join(fixture.repoRoot, 'README.md'), 'later historical change\n');
    runGitFixtureCommand(fixture.repoRoot, ['add', '--', 'README.md']);
    runGitFixtureCommand(fixture.repoRoot, ['commit', '-m', 'change historical staged content']);
    const next = await nativeJson(fixture.repoRoot, ['next-step', TASK_ID]);
    const audit = await nativeJson(fixture.repoRoot, ['gate', 'task-audit-summary', '--task-id', TASK_ID]);
    assert.equal(next.payload.status, 'BLOCKED', JSON.stringify(next.payload));
    assert.equal(audit.payload.status, 'BLOCKED');
    assert.deepEqual(fs.readFileSync(fixture.closeoutPath), originalBytes);
});

test('historical staged closeout rejects missing extra scope hashes', async () => {
    const fixture = await completedFixture(true, false, true);
    const historicalSummary = { ...fixture.summary };
    delete historicalSummary.worktree_scope_content_sha256;
    const provenance = historicalSummary.audited_scope_provenance as Record<string, unknown>;
    const extra = provenance.closeout_extra_scope as Record<string, unknown>;
    writeJson(fixture.closeoutPath, { ...fixture.closeout, implementation_summary: {
        ...historicalSummary, audited_scope_provenance: { ...provenance, closeout_extra_scope: {
            ...extra, changed_files_sha256: null, scope_content_sha256: null
        } }
    } });
    const originalBytes = fs.readFileSync(fixture.closeoutPath);
    const next = await nativeJson(fixture.repoRoot, ['next-step', TASK_ID]);
    const audit = await nativeJson(fixture.repoRoot, ['gate', 'task-audit-summary', '--task-id', TASK_ID]);
    assert.equal(next.payload.status, 'BLOCKED', JSON.stringify(next.payload));
    assert.equal(audit.payload.status, 'BLOCKED');
    assert.deepEqual(fs.readFileSync(fixture.closeoutPath), originalBytes);
});

test('authenticated historical staged header preserves unchanged tracked closeout extras', async () => {
    const fixture = await completedFixture(true, false, true, true);
    assert.equal(fixture.summary.worktree_scope_content_sha256, undefined);
    const next = await nativeJson(fixture.repoRoot, ['next-step', TASK_ID]);
    assert.equal(next.payload.status, 'DONE', JSON.stringify(next.payload));
    assert.deepEqual(fs.readFileSync(fixture.closeoutPath), fixture.originalCloseoutBytes);
    const audit = await nativeJson(fixture.repoRoot, ['gate', 'task-audit-summary', '--task-id', TASK_ID]);
    assert.equal(audit.payload.status, 'PASS', JSON.stringify(audit.payload.blockers));
});

test('authenticated historical staged plus untracked scope survives unchanged commit', async () => {
    const fixture = await completedFixture(true, false, true, true, true);
    assert.equal(fixture.summary.worktree_scope_content_sha256, undefined);
    const preflightPath = path.join(reviewsRoot(fixture.repoRoot), `${TASK_ID}-preflight.json`);
    const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8'));
    assert.deepEqual(preflight.git_change_classification.untracked_files, [ORIGINALLY_UNTRACKED_FILE]);
    const next = await nativeJson(fixture.repoRoot, ['next-step', TASK_ID]);
    assert.equal(next.payload.status, 'DONE', JSON.stringify(next.payload));
    assert.deepEqual(fs.readFileSync(fixture.closeoutPath), fixture.originalCloseoutBytes);
    const audit = await nativeJson(fixture.repoRoot, ['gate', 'task-audit-summary', '--task-id', TASK_ID]);
    assert.equal(audit.payload.status, 'PASS', JSON.stringify(audit.payload.blockers));
    const repeated = await nativeJson(fixture.repoRoot, ['next-step', TASK_ID]);
    assert.equal(repeated.payload.status, 'DONE', JSON.stringify(repeated.payload));
});

test('current staged plus untracked scope preserves complete worktree binding after commit', async () => {
    const fixture = await completedFixture(true, false, false, false, true);
    assert.equal(typeof fixture.summary.worktree_scope_content_sha256, 'string');
    const next = await nativeJson(fixture.repoRoot, ['next-step', TASK_ID]);
    const audit = await nativeJson(fixture.repoRoot, ['gate', 'task-audit-summary', '--task-id', TASK_ID]);
    assert.equal(next.payload.status, 'DONE', JSON.stringify(next.payload));
    assert.equal(audit.payload.status, 'PASS', JSON.stringify(audit.payload.blockers));
});

test('historical staged plus untracked scope rejects later committed untracked content edits', async () => {
    const fixture = await completedFixture(true, false, false, true, true);
    fs.appendFileSync(path.join(fixture.repoRoot, ORIGINALLY_UNTRACKED_FILE), 'later committed change\n');
    runGitFixtureCommand(fixture.repoRoot, ['add', '--', ORIGINALLY_UNTRACKED_FILE]);
    runGitFixtureCommand(fixture.repoRoot, ['commit', '-m', 'change formerly untracked content']);
    const next = await nativeJson(fixture.repoRoot, ['next-step', TASK_ID]);
    const audit = await nativeJson(fixture.repoRoot, ['gate', 'task-audit-summary', '--task-id', TASK_ID]);
    assert.equal(next.payload.status, 'BLOCKED', JSON.stringify(next.payload));
    assert.equal(audit.payload.status, 'BLOCKED');
    assert.deepEqual(fs.readFileSync(fixture.closeoutPath), fixture.originalCloseoutBytes);
});

test('historical staged plus untracked scope rejects later committed untracked deletion', async () => {
    const fixture = await completedFixture(true, false, false, true, true);
    runGitFixtureCommand(fixture.repoRoot, ['rm', '--', ORIGINALLY_UNTRACKED_FILE]);
    runGitFixtureCommand(fixture.repoRoot, ['commit', '-m', 'delete formerly untracked content']);
    const next = await nativeJson(fixture.repoRoot, ['next-step', TASK_ID]);
    const audit = await nativeJson(fixture.repoRoot, ['gate', 'task-audit-summary', '--task-id', TASK_ID]);
    assert.equal(next.payload.status, 'BLOCKED', JSON.stringify(next.payload));
    assert.equal(audit.payload.status, 'BLOCKED');
    assert.deepEqual(fs.readFileSync(fixture.closeoutPath), fixture.originalCloseoutBytes);
});

test('historical staged plus untracked scope rejects later committed untracked rename', async () => {
    const fixture = await completedFixture(true, false, false, true, true);
    runGitFixtureCommand(fixture.repoRoot, ['mv', ORIGINALLY_UNTRACKED_FILE, 'src/renamed-untracked.ts']);
    runGitFixtureCommand(fixture.repoRoot, ['commit', '-m', 'rename formerly untracked content']);
    const next = await nativeJson(fixture.repoRoot, ['next-step', TASK_ID]);
    const audit = await nativeJson(fixture.repoRoot, ['gate', 'task-audit-summary', '--task-id', TASK_ID]);
    assert.equal(next.payload.status, 'BLOCKED', JSON.stringify(next.payload));
    assert.equal(audit.payload.status, 'BLOCKED');
    assert.deepEqual(fs.readFileSync(fixture.closeoutPath), fixture.originalCloseoutBytes);
});

test('historical mixed staged scope rejects missing original classification', async () => {
    const fixture = await completedFixture(true, false, false, true, true);
    const preflight = JSON.parse(fs.readFileSync(path.join(reviewsRoot(fixture.repoRoot), `${TASK_ID}-preflight.json`), 'utf8'));
    delete preflight.git_change_classification;
    const decision = evaluateStagedPostDoneAuditedScope({ repoRoot: fixture.repoRoot,
        auditedFiles: fixture.summary.changed_files as string[], currentChangedFiles: [],
        finalCloseoutJsonPath: fixture.closeoutPath, preflight });
    assert.equal(decision?.blocked, true);
    assert.match(String(decision?.reason), /historical audited staged index content/);
    assert.deepEqual(fs.readFileSync(fixture.closeoutPath), fixture.originalCloseoutBytes);
});

test('historical mixed staged scope rejects forged original staged and untracked partition', async () => {
    const fixture = await completedFixture(true, false, false, true, true);
    const preflight = JSON.parse(fs.readFileSync(path.join(reviewsRoot(fixture.repoRoot), `${TASK_ID}-preflight.json`), 'utf8'));
    preflight.git_change_classification.untracked_files.push('README.md');
    const decision = evaluateStagedPostDoneAuditedScope({ repoRoot: fixture.repoRoot,
        auditedFiles: fixture.summary.changed_files as string[], currentChangedFiles: [],
        finalCloseoutJsonPath: fixture.closeoutPath, preflight });
    assert.equal(decision?.blocked, true);
    assert.match(String(decision?.reason), /historical audited staged index content/);
    assert.deepEqual(fs.readFileSync(fixture.closeoutPath), fixture.originalCloseoutBytes);
});

test('forged historical staged residual scope remains blocked by both native consumers', async () => {
    const { fixture, next, audit, forgedCloseoutBytes } = await forgedResidualScope(true, true, true);
    assert.equal(next.payload.status, 'BLOCKED', JSON.stringify(next.payload));
    assert.equal(audit.payload.status, 'BLOCKED');
    assert.deepEqual(fs.readFileSync(fixture.closeoutPath), forgedCloseoutBytes);
});
