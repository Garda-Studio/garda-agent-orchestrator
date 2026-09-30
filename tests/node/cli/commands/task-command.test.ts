import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { handleTask } from '../../../../src/cli/commands/task-command';
import { appendTaskEvent } from '../../../../src/gate-runtime/task-events';
import { DEFAULT_BUNDLE_NAME } from '../../../../src/core/constants';

const PACKAGE_JSON = { name: 'garda-agent-orchestrator-test', version: '0.0.0-test' };

function makeTmpDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'garda-task-command-test-'));
}

function stripAnsi(value: string): string {
    return value.replace(/\x1B\[[0-9;?]*[ -/]*[@-~]/g, '');
}

async function captureOutput(action: () => void | Promise<void>): Promise<string> {
    const captured: string[] = [];
    const originalLog = console.log;
    const originalWrite = process.stdout.write;
    try {
        process.env.NO_COLOR = '1';
        console.log = (...args: unknown[]): void => {
            captured.push(args.map((arg) => String(arg)).join(' '));
        };
        process.stdout.write = ((chunk: string | Uint8Array, encodingOrCallback?: BufferEncoding | ((err?: Error) => void), callback?: (err?: Error) => void): boolean => {
            captured.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
            const cb = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback;
            if (cb) cb();
            return true;
        }) as typeof process.stdout.write;
        await action();
    } finally {
        console.log = originalLog;
        process.stdout.write = originalWrite;
        delete process.env.NO_COLOR;
    }
    return stripAnsi(captured.join('\n'));
}

test('handleTask prints task namespace help', async () => {
    for (const argv of [
        [],
        ['help'],
        ['--help'],
        ['-h'],
        ['T-001', 'help']
    ]) {
        const text = await captureOutput(() => handleTask(argv, PACKAGE_JSON));
        assert.ok(text.includes('GARDA_COMMAND_HELP'), argv.join(' '));
        assert.ok(text.includes('garda task "<task-id>" stats'), argv.join(' '));
        assert.ok(text.includes('garda task "<task-id>" events'), argv.join(' '));
    }
});

test('handleTask routes task stats to per-task stats without aggregate mode', async () => {
    const repoRoot = makeTmpDir();
    const orchestratorRoot = path.join(repoRoot, DEFAULT_BUNDLE_NAME);
    appendTaskEvent(orchestratorRoot, 'T-100', 'COMPILE_GATE_PASSED', 'PASS', 'Compile gate passed.', {}, { passThru: true });

    const text = await captureOutput(() => handleTask(['T-100', 'stats', '--target-root', repoRoot], PACKAGE_JSON));

    assert.ok(text.includes('Task: T-100'));
    assert.ok(text.includes('Events: 1'));
    assert.ok(!text.includes('GARDA_STATS'));
});

test('handleTask routes task events to read-only task event summary', async () => {
    const repoRoot = makeTmpDir();
    const orchestratorRoot = path.join(repoRoot, DEFAULT_BUNDLE_NAME);
    appendTaskEvent(orchestratorRoot, 'T-200', 'TASK_MODE_ENTERED', 'PASS', 'Task mode entered.', { profile: 'balanced' }, { passThru: true });

    const text = await captureOutput(() => handleTask(['T-200', 'events', '--repo-root', repoRoot, '--include-details'], PACKAGE_JSON));

    assert.ok(text.includes('Task: T-200'));
    assert.ok(text.includes('Events: 1'));
    assert.ok(text.includes('Timeline:'));
    assert.ok(text.includes('TASK_MODE_ENTERED'));
    assert.ok(text.includes('details='));
});

test('handleTask rejects task event artifact materialization flags', async () => {
    await assert.rejects(
        () => handleTask(['T-300', 'events', '--output-path', 'summary.md'], PACKAGE_JSON),
        /Unknown option: --output-path/
    );
});

test('handleTask rejects unsupported task actions', async () => {
    await assert.rejects(
        () => handleTask(['T-400', 'audit'], PACKAGE_JSON),
        /Unsupported task action: audit/
    );
});

test('handleTask routes plan list, missing filter and show without creating lifecycle artifacts', async t => {
    const repoRoot = makeTmpDir();
    t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
    fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
        '# Tasks', '## Active Queue',
        '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
        '|---|---|---|---|---|---|---|---|---|',
        '| T-500 | TODO | P2 | planning | Plan | unassigned | 2026-09-30 | balanced | [plan] Request |'
    ].join('\n'));
    const listed = await captureOutput(() => handleTask(['plan', 'list', '--missing', '--repo-root', repoRoot], PACKAGE_JSON));
    assert.match(listed, /T-500: missing/);
    const shown = await captureOutput(() => handleTask(['plan', 'show', 'T-500', '--repo-root', repoRoot], PACKAGE_JSON));
    assert.match(shown, /Plan: missing/);
    assert.deepEqual(fs.readdirSync(repoRoot), ['TASK.md']);
    const help = await captureOutput(() => handleTask(['plan', '--help'], PACKAGE_JSON));
    assert.match(help, /task plan list/);
    assert.match(help, /task plan show/);
});

test('handleTask plan show prints the original JSON text after compact diagnostics', async t => {
    const repoRoot = makeTmpDir();
    t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
    const planDir = path.join(repoRoot, DEFAULT_BUNDLE_NAME, 'runtime', 'reviews');
    fs.mkdirSync(planDir, { recursive: true });
    const original = '{\n  "task_id": "T-501", "custom_field": true\n}\n';
    const planFile = path.join(planDir, 'T-501-task-plan.json');
    fs.writeFileSync(planFile, original);
    const shown = await captureOutput(() => handleTask(['plan', 'show', 'T-501', '--repo-root', repoRoot], PACKAGE_JSON));
    assert.match(shown, /Plan: invalid/);
    assert.match(shown, /Diagnostic:/);
    assert.ok(shown.endsWith(original));
    assert.equal(fs.readFileSync(planFile, 'utf8'), original);
});

test('handleTask rejects unsupported plan actions, escaping ids and mutation flags', async () => {
    await assert.rejects(
        () => handleTask(['plan', 'list', '--output-path', 'result.json'], PACKAGE_JSON),
        /Unknown option: --output-path/
    );
    for (const argv of [
        ['plan', 'approve', 'T-500'], ['plan', 'show'], ['plan', 'show', '../T-500'],
        ['plan', 'show', 'T-500', '--missing'],
        ['plan', 'list', 'T-500'], ['plan', 'show', 'T-500', 'T-501']
    ]) {
        await assert.rejects(() => handleTask(argv, PACKAGE_JSON));
    }
});

test('handleTask plan save writes a prepared plan and rejects invalid save arguments', async t => {
    const repoRoot = makeTmpDir();
    t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
    fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
        '## Active Queue',
        '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
        '|---|---|---|---|---|---|---|---|---|',
        '| T-502 | TODO | P2 | planning | Save | unassigned | 2026-09-30 | balanced | [plan] Prepare |'
    ].join('\n'));
    fs.writeFileSync(path.join(repoRoot, 'input.json'), JSON.stringify({
        schema_version: 1, task_id: 'T-502', status: 'approved', goal: 'Prepare',
        scope_files: ['src/widget.ts'], risk_level: 'low', steps: [{ id: 'a', title: 'Implement' }],
        acceptance_criteria: ['Preserve'], verification_expectations: ['Test'], out_of_scope: ['Other code']
    }));
    const shown = await captureOutput(() => handleTask(['plan', 'save', 'T-502', '--input', 'input.json', '--repo-root', repoRoot], PACKAGE_JSON));
    assert.match(shown, /Plan: saved/);
    const saved = path.join(repoRoot, 'runtime', 'reviews', 'T-502-task-plan.json');
    assert.equal(JSON.parse(fs.readFileSync(saved, 'utf8')).task_id, 'T-502');
    assert.equal(fs.existsSync(path.join(repoRoot, 'runtime', 'task-events')), false);
    await assert.rejects(() => handleTask(['plan', 'save', 'T-502', '--repo-root', repoRoot], PACKAGE_JSON), /requires --input/);
    await assert.rejects(() => handleTask(['plan', 'save', '--input', 'input.json'], PACKAGE_JSON), /exactly one task id/);
    await assert.rejects(() => handleTask(['plan', 'save', 'T-502', '--input', 'input.json', '--missing'], PACKAGE_JSON), /Unknown option/);
    await assert.rejects(() => handleTask(['plan', 'show', 'T-502', '--input', 'input.json'], PACKAGE_JSON), /Unknown option/);
});
