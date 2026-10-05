import test from 'node:test';
import assert from 'node:assert/strict';
import * as childProcess from 'node:child_process';
import * as path from 'node:path';
import { parseOptions } from '../../../../src/cli/commands/cli-parsing';

const definitions = {
    '--task-id': { key: 'taskId', type: 'string' },
    '--repo-root': { key: 'repoRoot', type: 'string' },
    '--value': { key: 'value', type: 'string' },
    '--changed-path': { key: 'changedPaths', type: 'string[]' },
    '--dry-run': { key: 'dryRun', type: 'boolean' }
};

test('a missing string value does not consume the following defined option', () => {
    for (const next of ['--repo-root', '--repo-root=.', '--dry-run', '--task-id']) {
        assert.throws(() => parseOptions(['--task-id', next], definitions), /--task-id requires a value before/);
    }
});

test('missing values also preserve built-in help and version options', () => {
    for (const next of ['-h', '--help', '-v', '--version']) {
        assert.throws(() => parseOptions(['--task-id', next], definitions), /--task-id requires a value before/);
    }
});

test('repeated string-array options require a value for every occurrence', () => {
    assert.throws(
        () => parseOptions(['--changed-path', 'src/first.ts', '--changed-path', '--dry-run'], definitions),
        /--changed-path requires a value before --dry-run/
    );
});

test('negative numbers, dash-prefixed text and paths remain valid values', () => {
    for (const value of ['-1', '-0.25', '-filename.txt', '--literal-unregistered', '-', '-directory/file name.ts']) {
        assert.equal(parseOptions(['--value', value], definitions).options.value, value);
    }
    assert.deepEqual(parseOptions(['--changed-path', '-name.ts', '--changed-path', 'two words.ts'], definitions).options.changedPaths, ['-name.ts', 'two words.ts']);
});

test('inline syntax preserves literal option names and explicit empty values', () => {
    for (const value of ['--repo-root', '--help', '-v', '--repo-root=.', '']) {
        assert.equal(parseOptions(['--value=' + value], definitions).options.value, value);
    }
    assert.equal(parseOptions(['--value', '--repo-root extra text'], definitions).options.value, '--repo-root extra text');
});

test('boolean values and subsequent normal options retain their existing behavior', () => {
    const { options } = parseOptions(['--dry-run', 'false', '--task-id', 'T-123', '--repo-root', '.'], definitions);
    assert.equal(options.dryRun, false);
    assert.equal(options.taskId, 'T-123');
    assert.equal(options.repoRoot, '.');
    assert.equal(parseOptions(['--dry-run', '--value', '-1'], definitions).options.dryRun, true);
});

test('the public CLI diagnoses missing task values before executing a gate', () => {
    const result = childProcess.spawnSync(process.execPath, [
        path.resolve('bin/garda.js'), 'gate', 'log-task-event', '--task-id', '--repo-root', '.'
    ], { cwd: path.resolve('.'), encoding: 'utf8', timeout: 15000, windowsHide: true });
    assert.equal(result.error, undefined);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr + result.stdout, /--task-id requires a value before --repo-root/);
});
