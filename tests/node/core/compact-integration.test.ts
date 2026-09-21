import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { applyCompactSettingOptions, compactSettingsFromConfig, COMPACT_SETTING_REGISTRY } from '../../../src/core/compact/setting-definitions';
import { compactGuidance } from '../../../src/core/compact/guidance';
import { cleanupCompactAtTaskBoundary } from '../../../src/core/compact/lifecycle';
import { CompactCapture, withCompactStore, readCompactOutput } from '../../../src/core/compact/store';
import { compactPreview, DEFAULT_COMPACT_SETTINGS } from '../../../src/core/compact/contract';
import { buildWorkflowConfigTab } from '../../../src/reports/report-data/workflow-config-tab';
import { buildUiSettingDefinitions, parseUiSettingValue } from '../../../src/reports/ui/actions/workflow-setting-actions';
import { getUpdateRollbackItems } from '../../../src/lifecycle/update/update';

test('compact settings share typed CLI and UI metadata with cross-limit validation', () => {
    assert.equal(COMPACT_SETTING_REGISTRY.entries.length, 13);
    const result = applyCompactSettingOptions({}, { 'compact-enabled': 'false', 'compact-preview-lines': '8' });
    assert.equal(compactSettingsFromConfig(result.config).enabled, false);
    assert.equal(result.config.preview_lines, 8);
    assert.throws(() => applyCompactSettingOptions({}, { 'compact-task-bytes': '1' }));
    assert.throws(() => applyCompactSettingOptions({}, { 'compact-enabled': 'yes' }));
});

test('task boundary cleanup preserves unfinished tasks and removes completed output', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'compact-lifecycle-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.writeFileSync(path.join(root, 'TASK.md'), '## Active Queue\n\n| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |\n|---|---|---|---|---|---|---|---|---|\n| T-DONE | DONE | P2 | x | done | x | 2026-09-20 | balanced | |\n| T-LIVE | BLOCKED | P2 | x | active | x | 2026-09-20 | balanced | |\n');
    const refs: Record<string, string> = {};
    await withCompactStore(root, async store => {
        for (const taskId of ['T-DONE', 'T-LIVE']) {
            const capture = new CompactCapture(store, taskId, { ...DEFAULT_COMPACT_SETTINGS });
            await capture.write('stdout', Buffer.alloc(16000, 120));
            refs[taskId] = capture.finish({ exitCode: 0, timedOut: false, cancelled: false }).ref!;
        }
    });
    await cleanupCompactAtTaskBoundary(root);
    await assert.rejects(readCompactOutput(root, { taskId: 'T-DONE', ref: refs['T-DONE'], stream: 'stdout' }));
    assert.ok((await readCompactOutput(root, { taskId: 'T-LIVE', ref: refs['T-LIVE'], stream: 'stdout' })).text);
    await cleanupCompactAtTaskBoundary(root, 'T-LIVE');
    await assert.rejects(readCompactOutput(root, { taskId: 'T-LIVE', ref: refs['T-LIVE'], stream: 'stdout' }));
});

test('discovery and UI honor disabled settings without rewriting gate commands', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'compact-guidance-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    assert.match(compactGuidance(root, 'T-ONE', true), /Do not run next-step/);
    assert.ok(buildWorkflowConfigTab(root).settings.some(setting => setting.id === 'compact-enabled'));
    assert.deepEqual(buildWorkflowConfigTab(root).compact_cache, { bytes: 0, runs: 0, available: true });
    assert.equal(fs.existsSync(path.join(root, 'garda-agent-orchestrator/runtime/compact')), false);
    const uiSettings = buildUiSettingDefinitions(root);
    assert.throws(() => parseUiSettingValue(uiSettings.find(setting => setting.id === 'compact-preview-lines')!, '1'));
    assert.throws(() => parseUiSettingValue(uiSettings.find(setting => setting.id === 'compact-task-bytes')!, '9216'));
    assert.ok(getUpdateRollbackItems(root, path.join(root, 'garda-agent-orchestrator/runtime/init-answers.json'))
        .every(item => !item.includes('runtime/compact') && !item.endsWith('/runtime')));
    const config = path.join(root, 'garda-agent-orchestrator/live/config');
    fs.mkdirSync(config, { recursive: true });
    fs.writeFileSync(path.join(config, 'workflow-config.json'), JSON.stringify({ compact: { enabled: false } }));
    assert.equal(compactGuidance(root, 'T-ONE'), '');
});

test('boundary GC recognizes canonical DONE forms and preserves ambiguous or finalizing tasks', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'compact-status-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const statuses = { 'T-LOWER': 'done', 'T-MARKER': '🟩', 'T-UNKNOWN': 'NOT DONE', 'T-FINALIZING': 'DONE' };
    fs.writeFileSync(path.join(root, 'TASK.md'), '## Active Queue\n\n| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |\n|---|---|---|---|---|---|---|---|---|\n'
        + Object.entries(statuses).map(([id, status]) => `| ${id} | ${status} | P2 | x | test | x | 2026-09-20 | balanced | |`).join('\n'));
    await withCompactStore(root, async store => {
        for (const id of Object.keys(statuses)) {
            const capture = new CompactCapture(store, id, { ...DEFAULT_COMPACT_SETTINGS });
            await capture.write('stdout', Buffer.alloc(16000, 120));
            capture.finish({ exitCode: 0, timedOut: false, cancelled: false });
        }
    });
    const runtime = path.join(root, 'garda-agent-orchestrator/runtime');
    fs.mkdirSync(path.join(runtime, 'reviews/T-FINALIZING-completion-gate.lock'), { recursive: true });
    assert.deepEqual(await cleanupCompactAtTaskBoundary(root), []);
    for (const id of ['T-LOWER', 'T-MARKER']) assert.equal(fs.existsSync(path.join(runtime, 'compact', id)), false);
    for (const id of ['T-UNKNOWN', 'T-FINALIZING']) assert.equal(fs.existsSync(path.join(runtime, 'compact', id)), true);
});

test('noisy fixture saves context after selective retrieval and instruction overhead', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'compact-savings-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const text = Array.from({ length: 1000 }, (_, index) => `${index}: ${index === 500 ? 'needle-evidence' : 'ordinary output '.repeat(5)}`).join('\n');
    const result = await withCompactStore(root, async store => {
        const capture = new CompactCapture(store, 'T-SAVINGS', { ...DEFAULT_COMPACT_SETTINGS });
        await capture.write('stdout', Buffer.from(text));
        return capture.finish({ exitCode: 0, timedOut: false, cancelled: false });
    });
    const read = await readCompactOutput(root, { taskId: 'T-SAVINGS', ref: result.ref!, stream: 'stdout', query: 'needle-evidence' });
    assert.match(read.text, /needle-evidence/);
    const disclosed = compactPreview(result.stdout).text.length + read.text.length + compactGuidance(root, 'T-SAVINGS', true).length + 600;
    assert.ok(1 - disclosed / text.length >= 0.5);
    const competentDirectBaseline = '500: needle-evidence'.length;
    assert.ok(competentDirectBaseline - disclosed < 0, 'already narrow native reads can be cheaper; do not clamp negative savings');
});
