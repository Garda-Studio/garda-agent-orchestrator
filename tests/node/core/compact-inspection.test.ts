import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';
import { runCompactInspection } from '../../../src/core/compact/inspection';
import { parseCompactArguments } from '../../../src/cli/commands/compact-command';

test('compact parser rejects shell and wrong-operation flags', () => {
    assert.throws(() => parseCompactArguments(['exec', '--query', 'rm -rf /']));
    assert.throws(() => parseCompactArguments(['git', 'status', '--query', 'x']));
    assert.throws(() => parseCompactArguments(['file', '--path', 'a', '--path', 'b']));
    assert.equal(parseCompactArguments(['rg', '--query', '--literal', '--path', '.']).values.query, '--literal');
});

test('file ranges preserve secrets and disabled inspection creates no cache', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'compact-inspection-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.writeFileSync(path.join(root, 'sample.txt'), 'first\nsecret=abc\nlast\n');
    const result = await runCompactInspection(root, 'T-LOCAL', { kind: 'file', path: 'sample.txt', from: 2, lines: 1 });
    assert.equal(result.stdout, '2: secret=abc\n');
    assert.equal(result.ref, undefined);
    assert.equal(result.complete, true);
    const config = path.join(root, 'garda-agent-orchestrator/live/config');
    fs.mkdirSync(config, { recursive: true });
    fs.writeFileSync(path.join(config, 'workflow-config.json'), JSON.stringify({ compact: { enabled: false } }));
    await assert.rejects(runCompactInspection(root, 'T-LOCAL', { kind: 'file', path: 'sample.txt', from: 1, lines: 1 }), /disabled/);
    await assert.rejects(runCompactInspection(root, 'T-LOCAL', { kind: 'rg', path: '.', query: 'x' }), /disabled/);
});

test('git inspection returns actual paths, not just success status', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'compact-git-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    assert.equal(spawnSync('git', ['init', '--quiet'], { cwd: root }).status, 0);
    fs.writeFileSync(path.join(root, 'changed.txt'), 'data');
    const result = await runCompactInspection(root, 'T-LOCAL', { kind: 'git', operation: 'status' });
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /changed.txt/);
    assert.equal(spawnSync('git', ['add', 'changed.txt'], { cwd: root }).status, 0);
    fs.unlinkSync(path.join(root, 'changed.txt'));
    const deleted = await runCompactInspection(root, 'T-LOCAL', { kind: 'git', operation: 'diff', path: 'changed.txt' });
    assert.equal(deleted.exitCode, 0);
    assert.match(deleted.stdout, /deleted file/);
});
