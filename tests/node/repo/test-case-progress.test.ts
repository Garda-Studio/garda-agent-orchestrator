import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

interface ProgressFixtureOptions {
    registerProgress: boolean;
    replaceTimers?: boolean;
}

function runProgressFixture(options: ProgressFixtureOptions) {
    const temporaryRoot = path.resolve(os.tmpdir());
    const fixtureRoot = fs.mkdtempSync(path.join(temporaryRoot, 'garda-test-case-progress-'));
    try {
        const helperPath = path.join(__dirname, '..', 'test-case-progress.js');
        const fixturePath = path.join(fixtureRoot, 'progress.test.cjs');
        const fixture = [
            "const assert = require('node:assert/strict');",
            "const { test, after } = require('node:test');",
            "const timers = require('node:timers');",
            'const realImmediate = timers.setImmediate;',
            'let progressFlushed = false;',
            options.registerProgress ? `require(${JSON.stringify(helperPath)}).registerTestCaseProgress();` : '',
            options.replaceTimers ? [
                "const replacedImmediate = () => { throw new Error('Mocked scheduler must not drive the progress hook.'); };",
                'globalThis.setImmediate = replacedImmediate;',
                'timers.setImmediate = replacedImmediate;',
                'after(() => { globalThis.setImmediate = realImmediate; timers.setImmediate = realImmediate; });'
            ].join('\n') : '',
            "test('completed synchronous work schedules actual progress', () => {",
            '    realImmediate(() => { progressFlushed = true; });',
            '});',
            "test('next synchronous case observes delivered progress', () => {",
            "    assert.equal(progressFlushed, true, 'Queued progress must flush between completed test cases.');",
            '});'
        ].join('\n');
        fs.writeFileSync(fixturePath, fixture, 'utf8');
        return spawnSync(process.execPath,
            ['--test', '--test-concurrency=1', '--test-reporter=spec', fixturePath], {
                encoding: 'utf8',
                env: { ...process.env, NODE_OPTIONS: undefined, NODE_TEST_CONTEXT: undefined },
                windowsHide: true
            });
    } finally {
        assert.equal(path.dirname(path.resolve(fixtureRoot)), temporaryRoot);
        assert.ok(path.basename(fixtureRoot).startsWith('garda-test-case-progress-'));
        fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
}

test('synchronous scenario chains reproduce undelivered progress without a checkpoint', () => {
    const result = runProgressFixture({ registerProgress: false });
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.status, 1);
    assert.match(result.stdout + result.stderr, /Queued progress must flush between completed test cases/);
});

test('case checkpoints deliver genuine queued progress before the next synchronous scenario', () => {
    const result = runProgressFixture({ registerProgress: true });
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('case checkpoints retain the real scheduler when a scenario replaces timer APIs', () => {
    const result = runProgressFixture({ registerProgress: true, replaceTimers: true });
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.status, 0, result.stdout + result.stderr);
});
