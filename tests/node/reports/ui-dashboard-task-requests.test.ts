import test from 'node:test';
import assert from 'node:assert/strict';
import * as vm from 'node:vm';
import { UI_DASHBOARD_CLIENT_CORE } from '../../../src/reports/ui/dashboard/dashboard-client-core';
import { UI_DASHBOARD_CLIENT_SESSION_ACTIONS } from '../../../src/reports/ui/dashboard/dashboard-client-session-actions';
import { UI_DASHBOARD_CLIENT_TASK_DETAIL } from '../../../src/reports/ui/dashboard/dashboard-client-task-detail';
import { LOCAL_UI_LANGUAGES, LOCAL_UI_TASK_CLOSURE_POLICY_TEXT, LOCAL_UI_TEXT } from '../../../src/reports/ui/ui-i18n';

function deferred<T>() {
    let resolve!: (value: T) => void, reject!: (error: Error) => void;
    const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
    return { promise, resolve, reject };
}
type Response = { ok: boolean; status: number; json: () => Promise<unknown> };
type Control = { disabled: boolean; checked: boolean; innerHTML: string; dataset: Record<string, string>; click: () => Promise<void>; addEventListener: (event: string, listener: () => Promise<void>) => void };

function createClient(onRequest?: (url: string) => void) {
    const requests: Array<ReturnType<typeof deferred<Response>> & { url: string; options?: { body: string } }> = [];
    const elements = new Map<string, Control>();
    const automaticResponses = new Map<string, unknown>();
    let actionButtons: Control[] = [], html = '';
    const detailNode = {
        get innerHTML() { return html; },
        set innerHTML(value: string) {
            html = value; elements.clear(); actionButtons = [];
            // Only the task-action controls/status nodes are needed by this DOM seam.
            const create = (disabled: boolean, dataset: Record<string, string> = {}): Control => {
                let click = async () => {};
                const node: Control = { disabled, checked: false, innerHTML: '', dataset,
                    click: async () => { if (!node.disabled) await click(); },
                    addEventListener: (event, listener) => { if (event === 'click') click = listener; } };
                return node;
            };
            for (const match of value.matchAll(/<button[^>]*data-task-action-id="([^"]+)"[^>]*data-task-action-mode="([^"]+)"[^>]*>/g)) {
                actionButtons.push(create(match[0].includes(' disabled'), { taskActionId: match[1], taskActionMode: match[2] }));
            }
            for (const match of value.matchAll(/<(?:button|input|div)[^>]*id="(task-(?:action-status|closure-[^"]+))"[^>]*>/g)) {
                elements.set(match[1], create(match[0].includes(' disabled')));
            }
        },
        querySelectorAll(selector: string) {
            return [...(selector.includes('data-task-action-id') ? actionButtons : []),
                ...(selector.includes('task-closure') ? [...elements].filter(([id]) => id !== 'task-closure-policy-status' && id !== 'task-action-status').map(([, node]) => node) : [])];
        }
    };
    const context = vm.createContext({
        Error, window: { localStorage: null, prompt: () => 'CONFIRM' },
        languageMetadata: LOCAL_UI_LANGUAGES, languagePacks: LOCAL_UI_TEXT,
        taskClosurePolicyTextPacks: LOCAL_UI_TASK_CLOSURE_POLICY_TEXT,
        fallbackLanguage: 'en', initialLanguage: 'en', detailNode,
        document: { getElementById: (id: string) => elements.get(id) || null },
        actionsEnabled: true, actionToken: 'test-token', selectedTaskId: null,
        currentTaskDetail: null, currentTaskClosurePolicyPreview: null, currentReport: null,
        currentSettingsPayload: null, loadedTaskDetails: {},
        findReportTask: () => null, artifactList: () => '', fullSuiteSummary: () => '',
        renderTaskRows: () => {},
        fetch: (url: string, options?: { body: string }) => {
            const request = { ...deferred<Response>(), url, options }; requests.push(request);
            onRequest?.(url);
            if (automaticResponses.has(url)) request.resolve({ ok: true, status: 200, json: async () => automaticResponses.get(url) });
            return request.promise;
        }
    });
    vm.runInContext(UI_DASHBOARD_CLIENT_CORE + '\n' + UI_DASHBOARD_CLIENT_SESSION_ACTIONS + '\n' + UI_DASHBOARD_CLIENT_TASK_DETAIL, context);
    const respond = (index: number, body: unknown, status = 200) => requests[index].resolve({ ok: status < 400, status, json: async () => body });
    const load = context.loadDetail as (id: string) => Promise<void>;
    const action = (id: string, command = 'task-stats') => (context.runTaskAction as Function)(id, command, 'execute', null) as Promise<void>;
    const closure = (id: string, mode = 'preview') => (context.requestTaskClosurePolicy as Function)(id, mode) as Promise<void>;
    const select = async (id: string) => {
        const pending = load(id); respond(requests.length - 1, { task_id: id, review_follow_up_task_closure_policy: { stored: {}, editable: true } }); await pending;
    };
    return { context, detailNode, requests, elements, automaticResponses, respond, load, action, closure, select, buttons: () => actionButtons };
}

test('late detail success, HTTP failure and rejection cannot replace a newer task', async () => {
    for (const outcome of ['success', 'http', 'rejection']) {
        const client = createClient(), older = client.load('T-A');
        await client.select('T-B');
        if (outcome === 'rejection') client.requests[0].reject(new Error('old failure'));
        else client.respond(0, { task_id: 'T-A' }, outcome === 'http' ? 503 : 200);
        await older;
        assert.match(client.detailNode.innerHTML, /<h2>T-B/);
        assert.equal(client.context.currentTaskDetail.task_id, 'T-B');
        assert.equal(client.context.selectedTaskId, 'T-B');
        assert.equal(client.context.loadedTaskDetails['T-A'], undefined);
    }
});

test('selection can change while an older detail JSON body is loading', async () => {
    const client = createClient(), body = deferred<unknown>(), older = client.load('T-A');
    client.requests[0].resolve({ ok: true, status: 200, json: () => body.promise });
    await Promise.resolve(); await client.select('T-B');
    body.resolve({ task_id: 'T-A' }); await older;
    assert.match(client.detailNode.innerHTML, /<h2>T-B/);
    assert.equal(client.context.currentTaskDetail.task_id, 'T-B');
});

test('current detail network, JSON and HTTP errors replace loading and allow a retry', async () => {
    for (const outcome of ['network', 'json', 'http']) {
        const client = createClient(), pending = client.load('T-A');
        if (outcome === 'network') client.requests[0].reject(new Error('network failure <unsafe>'));
        else if (outcome === 'json') client.requests[0].resolve({ ok: true, status: 200, json: async () => { throw new Error('invalid JSON'); } });
        else client.respond(0, {}, 503);
        await pending;
        assert.match(client.detailNode.innerHTML, /class="error"/);
        assert.doesNotMatch(client.detailNode.innerHTML, /Loading|<unsafe>/);
        assert.equal(client.context.currentTaskDetail, null);
        await client.select('T-A'); assert.match(client.detailNode.innerHTML, /<h2>T-A/);
    }
});

test('one pending task action excludes repeated commands and closure-policy requests and restores controls', async () => {
    const client = createClient(); await client.select('T-A');
    const permanentlyDisabled = client.elements.get('task-closure-forbid-children')!; permanentlyDisabled.disabled = true;
    const first = client.buttons().find(button => button.dataset.taskActionId === 'task-stats')!.click();
    const repeated = client.action('T-A'), closure = client.closure('T-A');
    const count = client.requests.length, locked = client.buttons().every(button => button.disabled) && client.elements.get('task-closure-policy-preview')!.disabled;
    for (let index = 1; index < client.requests.length; index++) client.respond(index, { task_id: 'T-A', status: 'previewed', exit_code: 0 });
    await Promise.all([first, repeated, closure]);
    assert.equal(count, 2); assert.equal(locked, true);
    assert.ok(client.buttons().every(button => !button.disabled));
    assert.equal(client.elements.get('task-closure-policy-preview')!.disabled, false);
    assert.equal(permanentlyDisabled.disabled, true);
});

test('task action rejection and invalid JSON are visible, restore controls and remain retryable', async () => {
    for (const outcome of ['network', 'json']) {
        const client = createClient(); await client.select('T-A');
        const pending = client.action('T-A');
        if (outcome === 'network') client.requests[1].reject(new Error('action failure <unsafe>'));
        else client.requests[1].resolve({ ok: true, status: 200, json: async () => { throw new Error('invalid action JSON'); } });
        await pending;
        assert.match(client.elements.get('task-action-status')!.innerHTML, /unavailable|error/);
        assert.doesNotMatch(client.elements.get('task-action-status')!.innerHTML, /<unsafe>/);
        assert.ok(client.buttons().every(button => !button.disabled));
        const retry = client.action('T-A'); client.respond(2, { task_id: 'T-A', status: 'executed' }); await retry;
        assert.match(client.elements.get('task-action-status')!.innerHTML, /T-A/);
    }
});

test('navigation during an action ignores its late success or failure and leaves the new task actionable', async () => {
    for (const outcome of ['success', 'rejection', 'json']) {
        const client = createClient(); await client.select('T-A');
        const pending = client.action('T-A', 'task-reset-reopen'); await client.select('T-B');
        client.automaticResponses.set('/api/report', {});
        client.automaticResponses.set('/api/tasks/T-A/detail', { task_id: 'T-A' });
        if (outcome === 'rejection') client.requests[1].reject(new Error('old action failure'));
        else if (outcome === 'json') client.requests[1].resolve({ ok: true, status: 200, json: async () => { throw new Error('old JSON failure'); } });
        else client.respond(1, { task_id: 'T-A', status: 'executed', exit_code: 0 });
        await pending;
        assert.equal(client.requests.length, 3, 'stale action must not refresh the report or reopen T-A');
        assert.equal(client.elements.get('task-action-status')!.innerHTML, '');
        assert.match(client.detailNode.innerHTML, /<h2>T-B/);
        assert.ok(client.buttons().every(button => !button.disabled));
    }
});

test('late closure-policy preview cannot enter a different task context', async () => {
    const client = createClient(); await client.select('T-A');
    const pending = client.closure('T-A'); await client.select('T-B');
    client.respond(1, { task_id: 'T-A', status: 'previewed', expected_notes_sha256: 'old-notes' }); await pending;
    assert.equal(client.context.currentTaskClosurePolicyPreview, null);
    assert.equal(client.elements.get('task-closure-policy-status')!.innerHTML, '');
    assert.ok(client.buttons().every(button => !button.disabled));
});

test('rerendering the current task keeps its pending action controls locked', async () => {
    const client = createClient(); await client.select('T-A');
    const pending = client.action('T-A');
    vm.runInContext('renderTaskDetail(currentTaskDetail)', client.context);
    const locked = client.buttons().every(button => button.disabled) && client.elements.get('task-closure-policy-preview')!.disabled;
    client.respond(1, { task_id: 'T-A', status: 'executed' }); await pending;
    assert.equal(locked, true);
    assert.ok(client.buttons().every(button => !button.disabled));
});

test('a later request for the same task also owns the detail and cache', async () => {
    const client = createClient(), older = client.load('T-A');
    await client.select('T-A');
    client.respond(0, { task_id: 'T-A', stats: { events_count: 999 } }); await older;
    assert.equal(client.context.currentTaskDetail.stats, undefined);
    assert.equal(client.context.loadedTaskDetails['T-A'].stats, undefined);
    assert.doesNotMatch(client.detailNode.innerHTML, /999/);
});

test('navigation while an action JSON body is pending suppresses the old result and refresh', async () => {
    const client = createClient(); await client.select('T-A');
    const body = deferred<unknown>(), started = deferred<void>(), pending = client.action('T-A', 'task-reset-discard');
    client.requests[1].resolve({ ok: true, status: 200, json: () => { started.resolve(); return body.promise; } });
    await started.promise; await client.select('T-B');
    body.resolve({ task_id: 'T-A', status: 'executed', exit_code: 0 }); await pending;
    assert.equal(client.requests.length, 3);
    assert.equal(client.elements.get('task-action-status')!.innerHTML, '');
    assert.equal(client.context.selectedTaskId, 'T-B');
});

test('closure-policy failures unlock the current context and allow a fresh preview', async () => {
    const client = createClient(); await client.select('T-A');
    const pending = client.closure('T-A'); client.requests[1].reject(new Error('preview failure')); await pending;
    assert.match(client.elements.get('task-closure-policy-status')!.innerHTML, /preview failure/);
    assert.equal(client.elements.get('task-closure-policy-preview')!.disabled, false);
    const retry = client.closure('T-A'); client.respond(2, { task_id: 'T-A', status: 'previewed', expected_notes_sha256: 'fresh' }); await retry;
    assert.equal(client.context.currentTaskClosurePolicyPreview.expected_notes_sha256, 'fresh');
});

test('navigation during an already-started report fetch cannot reselect the old task', async () => {
    const started = deferred<void>(), client = createClient(url => { if (url === '/api/report') started.resolve(); });
    await client.select('T-A');
    const originalReport = { marker: 'current report' }; client.context.currentReport = originalReport;
    const pending = client.action('T-A', 'task-reset-reopen');
    client.respond(1, { task_id: 'T-A', status: 'executed', exit_code: 0 }); await started.promise;
    assert.equal(client.requests[2].url, '/api/report');
    await client.select('T-B');
    client.automaticResponses.set('/api/tasks/T-A/detail', { task_id: 'T-A', stats: { events_count: 999 } });
    client.respond(2, { marker: 'stale report' }); await pending;
    assert.equal(client.context.currentReport, originalReport);
    assert.equal(client.context.selectedTaskId, 'T-B');
    assert.equal(client.context.currentTaskDetail.task_id, 'T-B');
    assert.match(client.detailNode.innerHTML, /<h2>T-B/);
    assert.equal(client.requests.length, 4, 'stale report must not request the old detail');
    assert.equal(client.context.loadedTaskDetails['T-A'].stats, undefined);
    assert.ok(client.buttons().every(button => !button.disabled));
});

test('navigation during report JSON decoding cannot publish the old report or reload its task', async () => {
    const fetchStarted = deferred<void>(), bodyStarted = deferred<void>(), body = deferred<unknown>();
    const client = createClient(url => { if (url === '/api/report') fetchStarted.resolve(); });
    await client.select('T-A');
    const originalReport = { marker: 'current report' }; client.context.currentReport = originalReport;
    const pending = client.action('T-A', 'task-reset-discard');
    client.respond(1, { task_id: 'T-A', status: 'executed', exit_code: 0 }); await fetchStarted.promise;
    client.requests[2].resolve({ ok: true, status: 200, json: () => { bodyStarted.resolve(); return body.promise; } });
    await bodyStarted.promise; await client.select('T-B');
    client.automaticResponses.set('/api/tasks/T-A/detail', { task_id: 'T-A', stats: { events_count: 999 } });
    body.resolve({ marker: 'stale report' }); await pending;
    assert.equal(client.context.currentReport, originalReport);
    assert.equal(client.context.selectedTaskId, 'T-B');
    assert.equal(client.context.currentTaskDetail.task_id, 'T-B');
    assert.match(client.detailNode.innerHTML, /<h2>T-B/);
    assert.equal(client.requests.length, 4, 'stale decoded report must not request the old detail');
    assert.equal(client.context.loadedTaskDetails['T-A'].stats, undefined);
});

test('a successful current reset refresh publishes the report and reloads the current task', async () => {
    const client = createClient(); await client.select('T-A');
    const report = { marker: 'refreshed report' };
    client.automaticResponses.set('/api/report', report);
    client.automaticResponses.set('/api/tasks/T-A/detail', { task_id: 'T-A', stats: { events_count: 7 } });
    const pending = client.action('T-A', 'task-reset-reopen');
    client.respond(1, { task_id: 'T-A', status: 'executed', exit_code: 0 }); await pending;
    assert.deepEqual(client.requests.map(request => request.url), ['/api/tasks/T-A/detail', '/api/tasks/T-A/actions', '/api/report', '/api/tasks/T-A/detail']);
    assert.equal(client.context.currentReport, report);
    assert.equal(client.context.selectedTaskId, 'T-A');
    assert.equal(client.context.currentTaskDetail.stats.events_count, 7);
    assert.equal(client.context.loadedTaskDetails['T-A'].stats.events_count, 7);
    assert.ok(client.buttons().every(button => !button.disabled));
});

test('current report refresh failures retain the command result, restore controls and allow a retry', async () => {
    for (const outcome of ['network', 'http', 'json']) {
        const started = deferred<void>(), client = createClient(url => { if (url === '/api/report') started.resolve(); });
        await client.select('T-A');
        const originalReport = { marker: 'current report' }; client.context.currentReport = originalReport;
        const pending = client.action('T-A', 'task-reset-reopen');
        client.respond(1, { task_id: 'T-A', status: 'executed', exit_code: 0, stdout: 'reset completed' }); await started.promise;
        if (outcome === 'network') client.requests[2].reject(new Error('report failed'));
        else if (outcome === 'json') client.requests[2].resolve({ ok: true, status: 200, json: async () => { throw new Error('bad report JSON'); } });
        else client.respond(2, {}, 503);
        await pending;
        assert.equal(client.context.currentReport, originalReport);
        assert.equal(client.context.currentTaskDetail.task_id, 'T-A');
        assert.match(client.elements.get('task-action-status')!.innerHTML, /reset completed/);
        assert.ok(client.buttons().every(button => !button.disabled));
        assert.equal(client.requests.length, 3, 'failed report refresh must not reload detail');
        const retry = client.action('T-A'); client.respond(3, { task_id: 'T-A', status: 'executed', exit_code: 0 }); await retry;
        assert.equal(client.requests.length, 4);
    }
});
