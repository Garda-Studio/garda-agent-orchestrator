import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';
import { runCompactInspection } from '../../../src/core/compact/inspection';
import { parseCompactArguments } from '../../../src/cli/commands/compact-command';
import type { SpawnStreamedOptions } from '../../../src/core/process/subprocess';

function useControlledRgProducer(t: TestContext) {
    const subprocess = require('../../../src/core/process/subprocess') as typeof import('../../../src/core/process/subprocess');
    const spawnStreamed = subprocess.spawnStreamed;
    // Exercise routing and real output capture without requiring a host-installed ripgrep.
    const source = [
        "const fs = require('node:fs');",
        'const [query, file] = process.argv.slice(1);',
        "const lines = fs.readFileSync(file, 'utf8').split('\\n');",
        'let matched = false;',
        'lines.forEach((line, index) => {',
        '    if (line.includes(query)) {',
        '        matched = true;',
        "        process.stdout.write(file + ':' + (index + 1) + ':' + line + '\\n');",
        '    }',
        '});',
        'process.exitCode = matched ? 0 : 1;'
    ].join('\n');
    return t.mock.method(subprocess, 'spawnStreamed', (command: string, args: string[], options?: SpawnStreamedOptions) => {
        assert.equal(command, 'rg');
        assert.deepEqual(args, [
            '--no-config', '--color=never', '--line-number', '--with-filename',
            '--max-filesize', '16M', '--glob-case-insensitive', '--glob',
            '!garda-agent-orchestrator/runtime/**', '--fixed-strings', '--',
            'memory-budget-marker', 'garda-agent-orchestrator/runtime/tmp/full-suite.log'
        ]);
        assert.equal(options?.envMode, 'replace');
        assert.ok(options?.outputSink);
        return spawnStreamed(process.execPath, ['-e', source, ...args.slice(-2)], options);
    });
}

function resolveWindowsShortPath(target: string): string | null {
    if (process.platform !== 'win32') return null;
    const result = spawnSync(process.env.ComSpec || 'cmd.exe', [
        '/d',
        '/c',
        'for %I in (.) do @echo %~sI'
    ], {
        cwd: target,
        encoding: 'utf8',
        windowsHide: true
    });
    if (result.status !== 0) return null;
    const resolved = result.stdout.trim().replace(/^"|"$/g, '');
    return resolved && path.resolve(resolved).toLowerCase() !== path.resolve(target).toLowerCase()
        ? resolved
        : null;
}

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

test('rg rejects runtime directories and streams an exact log with a controlled producer', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'compact-rg-runtime-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const runtimeTmp = path.join(root, 'garda-agent-orchestrator', 'runtime', 'tmp');
    fs.mkdirSync(runtimeTmp, { recursive: true });
    fs.writeFileSync(path.join(root, '.gitignore'), 'garda-agent-orchestrator/runtime/\n');
    fs.writeFileSync(path.join(runtimeTmp, 'full-suite.log'), 'memory-budget-marker\n');
    const producer = useControlledRgProducer(t);

    await assert.rejects(
        runCompactInspection(root, 'T-LOCAL', {
            kind: 'rg',
            path: 'garda-agent-orchestrator/runtime/tmp',
            query: 'memory-budget-marker'
        }),
        /does not search runtime directories.*exact runtime log file/
    );
    assert.equal(producer.mock.callCount(), 0, 'Excluded directories must not launch a producer.');

    const result = await runCompactInspection(root, 'T-LOCAL', {
        kind: 'rg',
        path: 'garda-agent-orchestrator/runtime/tmp/full-suite.log',
        query: 'memory-budget-marker'
    });
    assert.equal(result.exitCode, 0, result.sinkError || result.stderr);
    assert.match(result.stdout, /full-suite\.log:1:memory-budget-marker/);
    assert.equal(producer.mock.callCount(), 1);

    if (process.platform === 'win32') {
        await assert.rejects(
            runCompactInspection(root, 'T-LOCAL', {
                kind: 'rg',
                path: 'GARDA-AGENT-ORCHESTRATOR/runtime/tmp',
                query: 'memory-budget-marker'
            }),
            /does not search runtime directories.*exact runtime log file/
        );
        assert.equal(producer.mock.callCount(), 1);
        const shortBundlePath = 'GARDA-~1';
        if (fs.existsSync(path.join(root, shortBundlePath))) {
            await assert.rejects(
                runCompactInspection(root, 'T-LOCAL', {
                    kind: 'rg',
                    path: `${shortBundlePath}/runtime/tmp`,
                    query: 'memory-budget-marker'
                }),
                /does not search runtime directories.*exact runtime log file/
            );
            assert.equal(producer.mock.callCount(), 1);
        }
        const shortRoot = resolveWindowsShortPath(root);
        if (shortRoot) {
            await assert.rejects(
                runCompactInspection(shortRoot, 'T-LOCAL', {
                    kind: 'rg',
                    path: 'garda-agent-orchestrator/runtime/tmp',
                    query: 'memory-budget-marker'
                }),
                /does not search runtime directories.*exact runtime log file/
            );
            assert.equal(producer.mock.callCount(), 1);
            const shortRootFile = await runCompactInspection(shortRoot, 'T-LOCAL', {
                kind: 'rg',
                path: 'garda-agent-orchestrator/runtime/tmp/full-suite.log',
                query: 'memory-budget-marker'
            });
            assert.equal(shortRootFile.exitCode, 0);
            assert.match(shortRootFile.stdout, /full-suite\.log:1:memory-budget-marker/);
            assert.equal(producer.mock.callCount(), 2);
        }
    }
});

test('rg reports a missing producer as a failure instead of successful empty output', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'compact-rg-missing-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.writeFileSync(path.join(root, 'sample.txt'), 'memory-budget-marker\n');
    const subprocess = require('../../../src/core/process/subprocess') as typeof import('../../../src/core/process/subprocess');
    const spawnStreamed = subprocess.spawnStreamed;
    const missingProducer = path.join(root, 'missing-rg');
    const producer = t.mock.method(subprocess, 'spawnStreamed', (command: string, args: string[], options?: SpawnStreamedOptions) => {
        assert.equal(command, 'rg');
        return spawnStreamed(missingProducer, args, options);
    });
    const result = await runCompactInspection(root, 'T-LOCAL', { kind: 'rg', path: 'sample.txt', query: 'memory-budget-marker' });
    assert.equal(producer.mock.callCount(), 1);
    assert.equal(result.exitCode, 1);
    assert.equal(result.stdout, '');
    assert.match(result.sinkError || result.stderr, /ENOENT|not found/);
});
