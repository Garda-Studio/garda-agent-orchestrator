import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { createHash } from 'node:crypto';
import { readTaskFinalReport, MAX_TASK_FINAL_REPORT_BYTES, type TaskFinalReport } from '../../../src/reports/ui/task-final-report';
import { UI_DASHBOARD_CLIENT_TASK_PROGRESS } from '../../../src/reports/ui/dashboard/dashboard-client-task-progress';
import { UI_DASHBOARD_CLIENT_TASK_FINAL_REPORT } from '../../../src/reports/ui/dashboard/dashboard-client-task-final-report';
import { startLocalUiServer } from '../../../src/reports/ui';
import { makeLocalUiTempRepo, writeLocalUiRepoFixture, cleanupLocalUiTestResources } from './local-ui-test-helpers';

function reportFixture(text?: string, bundleName = 'garda-agent-orchestrator'): { repoRoot: string; file: string } {
    const repoRoot = makeLocalUiTempRepo();
    const file = path.join(repoRoot, bundleName, 'runtime/reviews/T-100-final-user-report.md');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (text !== undefined) fs.writeFileSync(file, text);
    return { repoRoot, file };
}

test('existing final report retains its exact wording, ordering and language with current hash evidence', () => {
    const text = '\nGARDA FINAL REPORT\r\nTask: T-100\r\nReviews: code(1): passed\r\nНовый раздел: исходный текст\r\n';
    const { repoRoot, file } = reportFixture(text);
    const sha256 = createHash('sha256').update(text).digest('hex');
    const before = fs.statSync(file);
    const report = readTaskFinalReport({ repoRoot, taskId: 'T-100', reference: { state: 'available', path: file, sha256 } });
    assert.equal(report.state, 'available');
    assert.equal(report.text, text);
    assert.equal(report.sha256, sha256);
    assert.equal(fs.statSync(file).mtimeMs, before.mtimeMs);
    assert.equal(fs.readFileSync(file, 'utf8'), text);
});

test('missing, pending, stale and legacy reports do not imply authenticated completion', () => {
    const missing = reportFixture();
    assert.equal(readTaskFinalReport({ repoRoot: missing.repoRoot, taskId: 'T-100' }).state, 'missing');
    assert.equal(readTaskFinalReport({ repoRoot: missing.repoRoot, taskId: 'T-100', reference: { state: 'pending', path: null, sha256: null } }).state, 'pending');
    const existing = reportFixture('Original legacy report');
    assert.equal(readTaskFinalReport({ repoRoot: existing.repoRoot, taskId: 'T-100' }).state, 'legacy');
    for (const state of ['available', 'stale'] as const) {
        const report = readTaskFinalReport({ repoRoot: existing.repoRoot, taskId: 'T-100', reference: { state, path: existing.file, sha256: '0'.repeat(64) } });
        assert.equal(report.state, 'stale');
        assert.equal(report.text, 'Original legacy report');
    }
});

test('report reader rejects foreign references, oversized files, non-files and invalid task ids', () => {
    const { repoRoot, file } = reportFixture('Owned report');
    const foreign = path.join(repoRoot, 'private.md');
    fs.writeFileSync(foreign, 'Private content');
    const result = readTaskFinalReport({ repoRoot, taskId: 'T-100', reference: { state: 'available', path: foreign, sha256: null } });
    assert.equal(result.state, 'unavailable');
    assert.equal(result.text, null);
    fs.writeFileSync(file, Buffer.alloc(MAX_TASK_FINAL_REPORT_BYTES + 1));
    assert.equal(readTaskFinalReport({ repoRoot, taskId: 'T-100' }).text, null);
    fs.unlinkSync(file);
    fs.mkdirSync(file);
    assert.equal(readTaskFinalReport({ repoRoot, taskId: 'T-100' }).state, 'unavailable');
    assert.throws(() => readTaskFinalReport({ repoRoot, taskId: '../T-100' }), /task.?id/iu);
});

test('report reader rejects hardlinks and parent links outside the workspace', () => {
    const { repoRoot, file } = reportFixture('Linked content');
    fs.linkSync(file, path.join(repoRoot, 'second-link.md'));
    assert.equal(readTaskFinalReport({ repoRoot, taskId: 'T-100' }).text, null);
    fs.unlinkSync(file);
    fs.unlinkSync(path.join(repoRoot, 'second-link.md'));
    fs.rmdirSync(path.dirname(file));
    const outside = reportFixture('Outside content');
    fs.symlinkSync(path.dirname(outside.file), path.dirname(file), process.platform === 'win32' ? 'junction' : 'dir');
    const result = readTaskFinalReport({ repoRoot, taskId: 'T-100' });
    assert.equal(result.state, 'unavailable');
    assert.equal(result.text, null);
});

test('changed files and malformed UTF-8 fail closed without publishing report text', (context) => {
    const { repoRoot, file } = reportFixture('Original');
    const originalRead = fs.readSync;
    let changed = false;
    context.mock.method(fs, 'readSync', (descriptor: number, buffer: NodeJS.ArrayBufferView, offset: number, length: number, position: number | null) => {
        const count = originalRead(descriptor, buffer, offset, length, position);
        if (!changed) {
            changed = true;
            fs.writeFileSync(file, 'Report changed to a different size');
        }
        return count;
    });
    assert.equal(readTaskFinalReport({ repoRoot, taskId: 'T-100' }).text, null);
    context.mock.restoreAll();
    fs.writeFileSync(file, Buffer.from([0xc3, 0x28]));
    const invalid = readTaskFinalReport({ repoRoot, taskId: 'T-100' });
    assert.equal(invalid.state, 'unavailable');
    assert.equal(invalid.text, null);
});

function clientReportPayload(): TaskFinalReport {
    return { task_id: 'T-100', state: 'stale', sha256: null,
        text: '<script>bad()</script>\n[link](javascript:bad)',
        path: 'garda-agent-orchestrator/runtime/reviews/T-100-final-user-report.md', diagnostics: [] };
}

function reportClient(language = 'en', payload: unknown = clientReportPayload()): { context: vm.Context; nodes: Map<string, Record<string, unknown>>; requests: string[] } {
    const nodes = new Map<string, Record<string, unknown>>();
    for (const id of ['task-final-report-load', 'task-final-report-status', 'task-final-report-text', 'task-final-report-source', 'task-final-report-diagnostics']) {
        nodes.set(id, { textContent: '', innerHTML: '', hidden: true, disabled: false, isConnected: true,
            addEventListener: (_event: string, listener: () => Promise<void>) => { nodes.get(id)!.listener = listener; } });
    }
    const requests: string[] = [];
    const context = vm.createContext({
        currentLanguage: language, fallbackLanguage: 'en', actionToken: 'test-token', encodeURIComponent,
        safe: (value: unknown) => String(value ?? '').replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/"/gu, '&quot;').replace(/'/gu, '&#39;'),
        t: (key: string) => key, document: { getElementById: (id: string) => nodes.get(id) },
        fetch: async (url: string) => { requests.push(url); return { ok: true, json: async () => payload }; }
    });
    vm.runInContext(UI_DASHBOARD_CLIENT_TASK_PROGRESS + UI_DASHBOARD_CLIENT_TASK_FINAL_REPORT, context);
    return { context, nodes, requests };
}

test('report card localizes only controls and labels the current summary without a stored final report', () => {
    for (const [language, heading] of [['ru', 'Текущая сводка'], ['de', 'Current summary'], ['unsupported', 'Current summary']]) {
        const client = reportClient(language);
        const html = vm.runInContext('taskFinalReportCard({ task_id: "T-100", progress: null, audit: { status: "BLOCKED", changed_files: ["<img>"] }, full_suite_validation: { state: "not_run", compact_summary: [] } })', client.context) as string;
        assert.match(html, new RegExp(heading, 'u'));
        assert.match(html, /BLOCKED/u);
        assert.doesNotMatch(html, /<img>/u);
        assert.match(html, /&lt;img&gt;/u);
        assert.deepEqual(client.requests, []);
    }
});

test('report loads only on click through the guarded route and treats untrusted markup and links as text', async () => {
    const client = reportClient('ru');
    vm.runInContext('wireTaskFinalReport({ task_id: "T-100" })', client.context);
    assert.deepEqual(client.requests, []);
    await (client.nodes.get('task-final-report-load')!.listener as () => Promise<void>)();
    assert.deepEqual(client.requests, ['/api/tasks/T-100/final-report?action_token=test-token']);
    assert.equal(client.nodes.get('task-final-report-text')!.textContent, '<script>bad()</script>\n[link](javascript:bad)');
    assert.equal(client.nodes.get('task-final-report-text')!.innerHTML, '');
    assert.equal(client.nodes.get('task-final-report-status')!.textContent, 'Устаревшие подтверждения');
    assert.equal(client.nodes.get('task-final-report-load')!.disabled, false);
    assert.match(String(client.nodes.get('task-final-report-source')!.innerHTML), /\/files\?path=/u);
    assert.doesNotMatch(String(client.nodes.get('task-final-report-source')!.innerHTML), /javascript:/u);
});

test('old task view and foreign task payloads cannot replace the current report display', async () => {
    const client = reportClient();
    client.context.fetch = async () => ({ ok: true, json: async () => ({ ...clientReportPayload(), task_id: 'T-101' }) });
    vm.runInContext('wireTaskFinalReport({ task_id: "T-100" })', client.context);
    await (client.nodes.get('task-final-report-load')!.listener as () => Promise<void>)();
    assert.equal(client.nodes.get('task-final-report-text')!.textContent, '');
    assert.equal(client.nodes.get('task-final-report-status')!.textContent, 'Unavailable');
    const detached = reportClient();
    vm.runInContext('wireTaskFinalReport({ task_id: "T-100" })', detached.context);
    detached.nodes.get('task-final-report-load')!.isConnected = false;
    await (detached.nodes.get('task-final-report-load')!.listener as () => Promise<void>)();
    assert.equal(detached.nodes.get('task-final-report-text')!.textContent, '');
});

test('reader reports from deployed and root runtime layouts display their exact text and raw link', async () => {
    for (const bundleName of ['garda-agent-orchestrator', '']) {
        const { repoRoot } = reportFixture('Original report\nИсходный текст', bundleName);
        const report = readTaskFinalReport({ repoRoot, taskId: 'T-100' });
        const expectedPath = (bundleName ? bundleName + '/' : '') + 'runtime/reviews/T-100-final-user-report.md';
        assert.equal(report.path, expectedPath);
        const client = reportClient('en', report);
        vm.runInContext('wireTaskFinalReport({ task_id: "T-100" })', client.context);
        await (client.nodes.get('task-final-report-load')!.listener as () => Promise<void>)();
        assert.equal(client.nodes.get('task-final-report-text')!.textContent, report.text);
        assert.equal(client.nodes.get('task-final-report-text')!.hidden, false);
        const href = String(client.nodes.get('task-final-report-source')!.innerHTML).match(/href="([^"]+)"/u)![1];
        const link = new URL(href, 'http://localhost');
        assert.equal(link.pathname, '/files');
        assert.equal(link.searchParams.get('path'), expectedPath);
        assert.equal(link.searchParams.get('action_token'), 'test-token');
    }
});

test('client preserves recognized bundle casing in report display and the raw file link', async () => {
    const report = { ...clientReportPayload(), path: 'Garda-Agent-Orchestrator/runtime/reviews/T-100-final-user-report.md' };
    const client = reportClient('en', report);
    vm.runInContext('wireTaskFinalReport({ task_id: "T-100" })', client.context);
    await (client.nodes.get('task-final-report-load')!.listener as () => Promise<void>)();
    assert.equal(client.nodes.get('task-final-report-text')!.textContent, report.text);
    assert.match(String(client.nodes.get('task-final-report-source')!.innerHTML), new RegExp(encodeURIComponent(report.path), 'u'));
});

test('client rejects foreign paths and individual response limits in otherwise valid report payloads', async () => {
    const cases: Array<{ label: string; override: Record<string, unknown> }> = [
        { label: 'foreign task path', override: { path: 'garda-agent-orchestrator/runtime/reviews/T-101-final-user-report.md' } },
        { label: 'unrecognized bundle', override: { path: 'private/runtime/reviews/T-100-final-user-report.md' } },
        { label: 'traversal', override: { path: '../runtime/reviews/T-100-final-user-report.md' } },
        { label: 'absolute path', override: { path: '/runtime/reviews/T-100-final-user-report.md' } },
        { label: 'backslash path', override: { path: 'runtime\\reviews\\T-100-final-user-report.md' } },
        { label: 'oversized text', override: { text: 'x'.repeat(MAX_TASK_FINAL_REPORT_BYTES + 1) } },
        { label: 'too many diagnostics', override: { diagnostics: Array(9).fill('Diagnostic') } },
        { label: 'oversized diagnostic', override: { diagnostics: ['x'.repeat(513)] } },
        { label: 'non-string text', override: { text: 1 } },
        { label: 'non-array diagnostics', override: { diagnostics: null } },
        { label: 'non-string diagnostic', override: { diagnostics: [1] } },
        { label: 'unknown state', override: { state: 'complete' } }
    ];
    for (const { label, override } of cases) {
        const client = reportClient('en', { ...clientReportPayload(), ...override });
        vm.runInContext('wireTaskFinalReport({ task_id: "T-100" })', client.context);
        await (client.nodes.get('task-final-report-load')!.listener as () => Promise<void>)();
        assert.equal(client.nodes.get('task-final-report-status')!.textContent, 'Unavailable', label);
        assert.equal(client.nodes.get('task-final-report-text')!.textContent, '', label);
        assert.equal(client.nodes.get('task-final-report-text')!.hidden, true, label);
        assert.equal(client.nodes.get('task-final-report-source')!.innerHTML, '', label);
        assert.equal(client.nodes.get('task-final-report-load')!.disabled, false, label);
    }
});

test('client accepts report text and diagnostics exactly at their response limits', async () => {
    const report = { ...clientReportPayload(), text: 'x'.repeat(MAX_TASK_FINAL_REPORT_BYTES), diagnostics: Array(8).fill('x'.repeat(512)) };
    const client = reportClient('en', report);
    vm.runInContext('wireTaskFinalReport({ task_id: "T-100" })', client.context);
    await (client.nodes.get('task-final-report-load')!.listener as () => Promise<void>)();
    assert.equal(client.nodes.get('task-final-report-text')!.textContent, report.text);
    assert.equal(client.nodes.get('task-final-report-diagnostics')!.textContent, report.diagnostics.join('\n'));
    assert.equal(client.nodes.get('task-final-report-status')!.textContent, 'Stale evidence');
});

test('HTTP report reads require the existing token and same-origin file boundary and reject unknown tasks', async () => {
    const { repoRoot, file } = reportFixture('Report containing <img> markup');
    writeLocalUiRepoFixture(repoRoot);
    const server = await startLocalUiServer({ repoRoot, port: 0 });
    let observed: Record<string, unknown> = {};
    try {
        const html = await (await fetch(server.url)).text();
        const token = html.match(new RegExp('const actionToken = "([^"]+)";', 'u'))![1];
        const origin = new URL(server.url).origin;
        const route = `${server.url}api/tasks/T-100/final-report`;
        const withoutToken = (await fetch(route, { headers: { origin } })).status;
        const withoutOrigin = (await fetch(`${route}?action_token=${token}`)).status;
        const foreignOrigin = (await fetch(`${route}?action_token=${token}`, { headers: { origin: 'https://foreign.example' } })).status;
        const before = fs.statSync(file).mtimeMs;
        const response = await fetch(`${route}?action_token=${token}`, { headers: { origin } });
        observed = { withoutToken, withoutOrigin, foreignOrigin, validStatus: response.status,
            text: (await response.json() as { text: string }).text,
            unchanged: fs.statSync(file).mtimeMs === before,
            unknownTask: (await fetch(`${server.url}api/tasks/T-101/final-report?action_token=${token}`, { headers: { origin } })).status,
            invalidTask: (await fetch(`${server.url}api/tasks/invalid/final-report?action_token=${token}`, { headers: { origin } })).status };
    } finally {
        await cleanupLocalUiTestResources({ repoRoot, server });
    }
    assert.deepEqual(observed, { withoutToken: 403, withoutOrigin: 403, foreignOrigin: 403, validStatus: 200,
        text: 'Report containing <img> markup', unchanged: true, unknownTask: 404, invalidTask: 400 });
});
