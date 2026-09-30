import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildPostDoneWorkspaceDriftBlocker } from '../../../../src/gates/task-audit/task-audit-summary-drift';
import { getWorkspaceSnapshot } from '../../../../src/gates/compile/compile-gate';
import { initGitRepo, makeTempDir } from './task-audit-summary-fixtures';

function completedScope(t: TestContext) {
    const root = makeTempDir();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, '.gitignore'), 'garda-agent-orchestrator/runtime/\n');
    fs.writeFileSync(path.join(root, 'src', 'app.ts'), 'export const baseline = 1;\n');
    initGitRepo(root);
    const file = 'src/new-progress.ts';
    fs.writeFileSync(path.join(root, file), 'export const first = 1;\n\nexport const second = 2;\n');
    const snapshot = getWorkspaceSnapshot(root, 'explicit_changed_files', true, [file]);
    const finalCloseoutPath = path.join(root, 'garda-agent-orchestrator/runtime/reviews/T-STAGING-final-closeout.json');
    fs.mkdirSync(path.dirname(finalCloseoutPath), { recursive: true });
    fs.writeFileSync(finalCloseoutPath, JSON.stringify({ implementation_summary: {
        changed_files: [file],
        changed_files_sha256: snapshot.changed_files_sha256,
        scope_content_sha256: snapshot.scope_content_sha256
    } }));
    const metrics: Record<string, unknown> = {
        changed_lines_total: snapshot.changed_lines_total,
        scope_content_sha256: snapshot.scope_content_sha256
    };
    const preflight = { changed_files: [file], metrics };
    const inspect = () => buildPostDoneWorkspaceDriftBlocker(root, [file], [file], preflight, finalCloseoutPath);
    return { root, file, snapshot, metrics, inspect };
}

test('post-DONE content authentication survives staging and committing an unchanged new file with blank lines', t => {
    const fixture = completedScope(t);
    assert.equal(fixture.inspect(), null);
    execFileSync('git', ['add', '--', fixture.file], { cwd: fixture.root, stdio: 'ignore' });
    const staged = getWorkspaceSnapshot(fixture.root, 'explicit_changed_files', true, [fixture.file]);
    assert.equal(staged.scope_content_sha256, fixture.snapshot.scope_content_sha256);
    assert.notEqual(staged.changed_lines_total, fixture.snapshot.changed_lines_total);
    assert.equal(fixture.inspect(), null);
    execFileSync('git', ['commit', '-m', 'commit unchanged completed scope'], { cwd: fixture.root, stdio: 'ignore' });
    assert.equal(fixture.inspect(), null);
});

test('post-DONE staging still rejects same-line-count content changes', t => {
    const fixture = completedScope(t);
    execFileSync('git', ['add', '--', fixture.file], { cwd: fixture.root, stdio: 'ignore' });
    const before = getWorkspaceSnapshot(fixture.root, 'explicit_changed_files', true, [fixture.file]);
    fs.writeFileSync(path.join(fixture.root, fixture.file), 'export const first = 9;\n\nexport const second = 2;\n');
    const changed = getWorkspaceSnapshot(fixture.root, 'explicit_changed_files', true, [fixture.file]);
    assert.equal(changed.changed_lines_total, before.changed_lines_total);
    assert.notEqual(changed.scope_content_sha256, before.scope_content_sha256);
    assert.match(fixture.inspect()?.reason || '', /changed audited closeout content/u);
});

test('post-DONE implementation fingerprint mismatch remains blocking when the closeout fingerprint is current', t => {
    const fixture = completedScope(t);
    fixture.metrics.scope_content_sha256 = '0'.repeat(64);
    assert.match(fixture.inspect()?.reason || '', /scope_content_sha256 differs from completed preflight/u);
});

test('legacy post-DONE preflight without a content fingerprint still detects changed line counts', t => {
    const fixture = completedScope(t);
    delete fixture.metrics.scope_content_sha256;
    fixture.metrics.changed_lines_total = fixture.snapshot.changed_lines_total + 1;
    assert.match(fixture.inspect()?.reason || '', /changed_lines_total .* differs from completed preflight/u);
});
