import test from 'node:test';
import assert from 'node:assert/strict';
import * as vm from 'node:vm';
import type { ReportTaskDetail } from '../../../src/reports/report-data/types';
import { UI_DASHBOARD_CLIENT_CORE } from '../../../src/reports/ui/dashboard/dashboard-client-core';
import { UI_DASHBOARD_CLIENT_TASK_DETAIL } from '../../../src/reports/ui/dashboard/dashboard-client-task-detail';
import { LOCAL_UI_LANGUAGES, LOCAL_UI_TASK_PROGRESS_TEXT, LOCAL_UI_TEXT } from '../../../src/reports/ui/ui-i18n';

type TaskProgress = NonNullable<ReportTaskDetail['progress']>;

function progressModel(state: TaskProgress['state'] = 'active'): TaskProgress {
    return {
        state,
        navigator_status: 'READY',
        completed_stages: [{ gate: 'compile-gate', timestamp_utc: '2026-09-30T20:00:00Z' }],
        current_stage: 'build-review-context',
        remaining_stages: [{ gate: 'required-reviews-check', status: 'pending' }],
        blocker: null,
        next_action: { gate: 'build-review-context', label: 'Review only', command: 'node bin/garda.js next-step "T-150-2" --repo-root "."' },
        final_report: { state: 'pending', path: 'runtime/reviews/T-150-2-final-user-report.md', exists: false, sha256: null },
        evidence_references: [],
        timing: { first_event_utc: null, last_event_utc: null },
        diagnostics: ['RAW_DIAGNOSTIC T-150-2']
    };
}

function createClient(progress: unknown, language = 'en', clipboard?: { writeText: (value: string) => Promise<void> }) {
    const detail = { task_id: 'T-150-2', progress, stats: {}, audit: {}, full_suite_validation: {}, artifact_links: [] };
    const detailNode = { innerHTML: '', querySelectorAll: () => [] };
    const field = { value: '', focused: false, selected: false, focus() { this.focused = true; }, select() { this.selected = true; } };
    const status = { textContent: '' };
    const listeners: Array<() => Promise<void>> = [];
    const button = { addEventListener: (event: string, listener: () => Promise<void>) => { assert.equal(event, 'click'); listeners.push(listener); } };
    const context = vm.createContext({
        window: { localStorage: null, prompt: () => { throw new Error('Unexpected action confirmation'); } },
        navigator: { language, languages: [], clipboard },
        languageMetadata: LOCAL_UI_LANGUAGES,
        languagePacks: LOCAL_UI_TEXT,
        fallbackLanguage: 'en',
        initialLanguage: language,
        detail,
        detailNode,
        document: {
            querySelectorAll: () => [],
            getElementById: (id: string) => {
                if (!detailNode.innerHTML.includes('id="task-progress-command"')) return null;
                return ({ 'task-progress-command': field, 'task-progress-copy': button, 'task-progress-copy-status': status } as Record<string, unknown>)[id] || null;
            }
        },
        actionsEnabled: false,
        actionToken: 'unused-token',
        currentTaskDetail: null,
        currentSettingsPayload: null,
        loadedTaskDetails: {},
        selectedTaskId: null,
        findReportTask: () => ({ task_id: detail.task_id, title: 'Progress', status_token: 'DONE' }),
        artifactList: () => '',
        renderTaskRows: () => {},
        fetch: () => { throw new Error('Unexpected request'); }
    });
    vm.runInContext(`${UI_DASHBOARD_CLIENT_CORE}\n${UI_DASHBOARD_CLIENT_TASK_DETAIL}`, context);
    const render = () => vm.runInContext('renderTaskDetail(detail)', context);
    return { context, detail, detailNode, field, status, listeners, render };
}

test('task progress renders recorded stages and review-only action without inferring completion from the queue', () => {
    const model = progressModel();
    const before = JSON.stringify(model);
    const client = createClient(model);
    client.render();
    const html = client.detailNode.innerHTML;
    assert.match(html, /Task progress/u);
    assert.match(html, /In progress/u);
    assert.match(html, /Completed stages.*compile-gate.*2026-09-30T20:00:00Z/su);
    assert.match(html, /Current stage.*build-review-context/su);
    assert.match(html, /Remaining stages.*required-reviews-check.*Pending/su);
    assert.match(html, /Review only/u);
    assert.match(html, /Remaining checks can still fail/u);
    assert.match(html, /RAW_DIAGNOSTIC T-150-2/u);
    assert.match(html, /runtime\/reviews\/T-150-2-final-user-report\.md/u);
    assert.match(html, /Task commands/u);
    assert.equal(JSON.stringify(model), before);
});

test('task progress states stay explicit and completed models do not invent another command', () => {
    for (const state of ['active', 'blocked', 'stale', 'unknown', 'incomplete', 'completed', 'unavailable'] as const) {
        const model = { ...progressModel(state), next_action: null, blocker: { gate: 'compile-gate', reason: 'Exact blocker T-150-2' } };
        const client = createClient(model);
        client.render();
        assert.ok(client.detailNode.innerHTML.includes(LOCAL_UI_TASK_PROGRESS_TEXT.en[state]));
        assert.match(client.detailNode.innerHTML, /Exact blocker T-150-2/u);
        assert.doesNotMatch(client.detailNode.innerHTML, /id="task-progress-copy"/u);
    }
});

test('completed task progress presents the available final report without pending work or copy controls', () => {
    const model: TaskProgress = {
        ...progressModel('completed'), navigator_status: 'DONE', current_stage: null, remaining_stages: [], next_action: null,
        final_report: { state: 'available', path: 'runtime/reviews/T-150-2-final-user-report.md', exists: true, sha256: 'a'.repeat(64) }
    };
    const client = createClient(model);
    client.render();
    assert.match(client.detailNode.innerHTML, /<p>Completed<\/p>/u);
    assert.match(client.detailNode.innerHTML, /Final report<\/h4><p>Available/u);
    assert.match(client.detailNode.innerHTML, /No remaining stages reported/u);
    assert.equal(client.listeners.length, 0);
});

test('task progress uses Russian labels, English fallback and raw operational content', () => {
    const russian = createClient(progressModel(), 'ru');
    russian.render();
    assert.match(russian.detailNode.innerHTML, /Прогресс задачи/u);
    assert.match(russian.detailNode.innerHTML, /Выполненные этапы/u);
    assert.match(russian.detailNode.innerHTML, /Копировать команду/u);
    assert.match(russian.detailNode.innerHTML, /build-review-context/u);
    assert.equal(russian.field.value, progressModel().next_action!.command);
    for (const language of ['de', 'unsupported']) {
        const client = createClient(progressModel(), language);
        client.render();
        assert.match(client.detailNode.innerHTML, /Task progress/u);
        assert.match(client.detailNode.innerHTML, /Next command/u);
    }
});

test('task progress escapes all read-model markup while copying the exact command including its leading newline', async () => {
    const payload = '<img src=x onerror="bad()"> & </textarea><script>bad()</script>';
    const command = '\nnode command --value "' + payload + '"';
    const model = {
        ...progressModel('blocked'),
        current_stage: payload,
        completed_stages: [{ gate: payload, timestamp_utc: payload }],
        remaining_stages: [{ gate: payload, status: 'failed' }],
        blocker: { gate: payload, reason: payload },
        next_action: { gate: payload, label: payload, command },
        final_report: { state: 'stale', path: payload },
        diagnostics: [payload]
    };
    const copied: string[] = [];
    const client = createClient(model, 'en', { writeText: async value => { copied.push(value); } });
    client.render();
    assert.doesNotMatch(client.detailNode.innerHTML, /<img|<script>|onerror="bad/u);
    assert.match(client.detailNode.innerHTML, /&lt;img/u);
    assert.equal(client.field.value, command);
    assert.deepEqual(copied, []);
    await client.listeners[0]();
    assert.deepEqual(copied, [command]);
    assert.equal(client.status.textContent, 'Command copied.');
});

test('task progress copy remains available with actions disabled and exposes accessible labels and status', async () => {
    const copied: string[] = [];
    const client = createClient(progressModel(), 'ru', { writeText: async value => { copied.push(value); } });
    client.render();
    const html = client.detailNode.innerHTML;
    assert.match(html, /aria-labelledby="task-progress-title"/u);
    assert.match(html, /<label[^>]*for="task-progress-command"/u);
    assert.match(html, /<textarea[^>]*readonly/u);
    assert.match(html, /<button type="button" id="task-progress-copy">/u);
    assert.match(html, /role="status" aria-live="polite" aria-atomic="true"/u);
    await client.listeners[0]();
    assert.deepEqual(copied, [progressModel().next_action!.command]);
    assert.equal(client.status.textContent, 'Команда скопирована.');
});

test('task progress copy selects the command when clipboard access is absent or denied', async () => {
    for (const clipboard of [undefined, { writeText: async () => { throw new Error('Denied'); } }]) {
        const client = createClient(progressModel(), 'en', clipboard);
        client.render();
        await client.listeners[0]();
        assert.equal(client.field.focused, true);
        assert.equal(client.field.selected, true);
        assert.equal(client.status.textContent, 'Command selected. Copy it using your browser or keyboard.');
    }
});

test('task progress absence and unsupported states show unavailable or unknown evidence without commands', () => {
    for (const model of [null, undefined]) {
        const client = createClient(model);
        client.render();
        assert.match(client.detailNode.innerHTML, /Unavailable/u);
        assert.match(client.detailNode.innerHTML, /No confirmed completed stages/u);
        assert.match(client.detailNode.innerHTML, /No next action reported/u);
        assert.equal(client.listeners.length, 0);
    }
    const client = createClient({ state: 'unexpected-state' });
    client.render();
    assert.match(client.detailNode.innerHTML, /Unknown progress/u);
});

test('task detail still loads lazily and rendering or copying adds no server request', async () => {
    const client = createClient(progressModel());
    const requests: string[] = [];
    client.context.fetch = async (url: string) => {
        requests.push(url);
        return { ok: true, json: async () => client.detail };
    };
    assert.equal(client.detailNode.innerHTML, '');
    assert.deepEqual(requests, []);
    await vm.runInContext('loadDetail("T-150-2")', client.context);
    assert.deepEqual(requests, ['/api/tasks/T-150-2/detail']);
    assert.match(client.detailNode.innerHTML, /Task progress/u);
    await client.listeners[0]();
    assert.deepEqual(requests, ['/api/tasks/T-150-2/detail']);
});
