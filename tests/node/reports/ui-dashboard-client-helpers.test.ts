import test from 'node:test';
import assert from 'node:assert/strict';
import * as vm from 'node:vm';
import { UI_DASHBOARD_CLIENT_CORE } from '../../../src/reports/ui/dashboard/dashboard-client-core';
import { UI_DASHBOARD_CLIENT_TASKS } from '../../../src/reports/ui/dashboard/dashboard-client-tasks';
import { LOCAL_UI_LANGUAGES, LOCAL_UI_TEXT } from '../../../src/reports/ui/ui-i18n';

function createClient(overrides: Record<string, unknown> = {}) {
    const context = vm.createContext({
        window: { localStorage: null },
        navigator: { language: 'en', languages: [] },
        languagePacks: LOCAL_UI_TEXT,
        languageMetadata: LOCAL_UI_LANGUAGES,
        fallbackLanguage: 'en',
        initialLanguage: 'en',
        searchNode: { value: '' },
        statusFilterNode: { value: '' },
        priorityFilterNode: { value: '' },
        currentReport: null,
        ...overrides
    });
    vm.runInContext(`${UI_DASHBOARD_CLIENT_CORE}\n${UI_DASHBOARD_CLIENT_TASKS}`, context);
    return context;
}

test('dashboard language prefers saved choice and falls back when storage is unavailable', () => {
    const saved = createClient({
        window: { localStorage: { getItem: () => 'ru' } },
        navigator: { language: 'en-US', languages: [] }
    });
    assert.equal(vm.runInContext('currentLanguage', saved), 'ru');
    const denied = createClient({
        window: { get localStorage() { throw new Error('storage denied'); } },
        navigator: { language: 'RU-ru', languages: ['en'] }
    });
    assert.equal(vm.runInContext('currentLanguage', denied), 'ru');
    const unknown = createClient({ navigator: { language: 'xx-ZZ', languages: [] }, initialLanguage: 'ru' });
    assert.equal(vm.runInContext('currentLanguage', unknown), 'ru');
    const stale = createClient({ window: { localStorage: { getItem: () => 'unsupported' } } });
    assert.equal(vm.runInContext('currentLanguage', stale), 'en');
});

test('dashboard text helpers escape markup including inline code without losing plain text', () => {
    const context = createClient({ value: '<img src="x" onerror=\'bad\'>&', inline: 'Read `<script>` & continue' });
    assert.equal(vm.runInContext('safe(value)', context), '&lt;img src=&quot;x&quot; onerror=&#39;bad&#39;&gt;&amp;');
    assert.equal(vm.runInContext('inlineText(inline)', context), 'Read <code>&lt;script&gt;</code> &amp; continue');
    assert.equal(vm.runInContext('safe(null)', context), '');
    assert.equal(vm.runInContext('inlineText("unclosed `code")', context), 'unclosed `code');
});

test('dashboard filters combine case-insensitive search with exact status and priority', () => {
    const task = { task_id: 'T-071', title: 'Client helpers', status: '🟦 TODO', status_token: 'TODO', priority: 'P2', area: 'ui', owner: 'Team', notes: 'Regression coverage' };
    const context = createClient({ task });
    assert.equal(vm.runInContext('matchesFilters(task)', context), true);
    vm.runInContext('searchNode.value = " REGRESSION "; statusFilterNode.value = "TODO"; priorityFilterNode.value = "P2";', context);
    assert.equal(vm.runInContext('matchesFilters(task)', context), true);
    vm.runInContext('statusFilterNode.value = "DONE";', context);
    assert.equal(vm.runInContext('matchesFilters(task)', context), false);
    vm.runInContext('statusFilterNode.value = "TODO"; priorityFilterNode.value = "P1";', context);
    assert.equal(vm.runInContext('matchesFilters(task)', context), false);
    vm.runInContext('priorityFilterNode.value = "P2"; searchNode.value = "missing";', context);
    assert.equal(vm.runInContext('matchesFilters(task)', context), false);
    vm.runInContext('searchNode.value = ""; task.status = "TODO"; delete task.status_token;', context);
    assert.equal(vm.runInContext('matchesFilters(task)', context), true);
});

test('dashboard task lookup and terminal state handle absent reports and legacy statuses', () => {
    const task = { task_id: 'T-071', status: 'DONE' };
    const context = createClient({ task });
    assert.equal(vm.runInContext('findReportTask("T-071")', context), null);
    vm.runInContext('currentReport = { tasks_tab: { rows: [task] } };', context);
    assert.equal(vm.runInContext('findReportTask("T-071")', context), task);
    assert.equal(vm.runInContext('findReportTask("T-999")', context), null);
    assert.equal(vm.runInContext('isTerminalTask(task)', context), true);
    assert.equal(vm.runInContext('isTerminalTask({ status_token: "DECOMPOSED" })', context), true);
    assert.equal(vm.runInContext('isTerminalTask({ status_token: "BLOCKED" })', context), false);
    assert.equal(vm.runInContext('isTerminalTask(null)', context), false);
});

test('dashboard select refresh preserves a valid selection and escapes option values', () => {
    const select = { value: 'P2', innerHTML: '' };
    const context = createClient({ select });
    vm.runInContext('setOptions(select, ["P1", "P2"], "All & any");', context);
    assert.equal(select.value, 'P2');
    assert.match(select.innerHTML, /All &amp; any/u);
    vm.runInContext('setOptions(select, ["<new>"], "All");', context);
    assert.equal(select.value, '');
    assert.equal(select.innerHTML, '<option value="">All</option><option value="&lt;new&gt;">&lt;new&gt;</option>');
});
