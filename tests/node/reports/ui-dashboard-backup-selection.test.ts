import test from 'node:test';
import assert from 'node:assert/strict';
import * as vm from 'node:vm';
import { UI_DASHBOARD_CLIENT_BACKUPS } from '../../../src/reports/ui/dashboard/dashboard-client-backups';
import { BACKUP_SELECTION_TEXT } from '../../../src/reports/ui/backup-selection-text';

function client(language = 'en', actionsEnabled = false, fetcher: typeof fetch = async () => { throw new Error('Unexpected request'); }) {
    type Node = { dataset: Record<string, string>; checked: boolean; value: string; disabled: boolean;
        listeners: Map<string, (event: unknown) => unknown>; focus: () => void;
        selectionStart: number | null; selectionEnd: number | null; setSelectionRange: (start: number, end: number) => void;
        addEventListener: (event: string, handler: (event: unknown) => unknown) => void };
    let html = '', focused = '';
    const nodes = new Map<string, Node>();
    const settingsNodes = new Map<string, Node>();
    const setting = { id: 'auto-backup-enabled', key: 'enabled', label: 'Enabled', description: '', current_value: false, confirmation_phrase: 'ENABLE BACKUPS' };
    let promptCalls = 0;
    let checkboxes: Node[] = [];
    const create = (id: string, tag: string, dataset: Record<string, string> = {}): Node => {
        const node: Node = { dataset, checked: tag.includes(' checked'), value: '', disabled: tag.includes(' disabled'),
            listeners: new Map(), focus: () => { focused = id; }, selectionStart: 0, selectionEnd: 0,
            setSelectionRange: (start, end) => { node.selectionStart = start; node.selectionEnd = end; },
            addEventListener: (event, handler) => node.listeners.set(event, handler) };
        nodes.set(id, node); return node;
    };
    const settingsRoot = {
        set innerHTML(value: string) {
            settingsNodes.clear();
            if (!value.includes('data-setting-id="auto-backup-enabled"')) return;
            const input = create('setting-input', '<input>'); nodes.delete('setting-input');
            const button = create('setting-save', '<button>', { settingId: setting.id, settingMode: 'execute', settingControlScope: 'backups' }); nodes.delete('setting-save');
            settingsNodes.set('setting-input', input); settingsNodes.set('setting-save', button);
        },
        querySelectorAll: (selector: string) => selector.includes('data-setting-id')
            ? [settingsNodes.get('setting-save')].filter(Boolean) : Array.from(settingsNodes.values())
    };
    const table = {
        get innerHTML() { return html; },
        set innerHTML(value: string) {
            html = value; nodes.clear(); checkboxes = [];
            for (const match of value.matchAll(/<(?:input|select|button|p)[^>]*id="(backup-selection-[^"]+)"[^>]*>/g)) {
                const node = create(match[1], match[0]);
                node.value = match[0].match(/value="([^"]*)"/)?.[1] || '';
            }
            for (const match of value.matchAll(/<input[^>]*data-backup-selection-id="([^"]+)"[^>]*>/g)) {
                checkboxes.push(create(match[1], match[0], { backupSelectionId: match[1] }));
            }
        },
        querySelectorAll: (selector: string) => selector.includes('data-backup-selection-id') ? checkboxes : Array.from(nodes.values())
    };
    const safe = (value: unknown) => String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const context = vm.createContext({ document: { getElementById: (id: string) => id === 'backups-table' ? table : id === 'backups-settings' ? settingsRoot : settingsNodes.get(id) || nodes.get(id) || { innerHTML: '', querySelectorAll: () => [] } },
        currentActionsPayload: null, actionsEnabled, actionToken: 'real-ui-token', fetch: fetcher, backupSelectionTextPacks: BACKUP_SELECTION_TEXT,
        backupsTabTextPacks: {}, localizedField: (pack: typeof BACKUP_SELECTION_TEXT, id: keyof typeof BACKUP_SELECTION_TEXT.en, _field: string, fallback: string) =>
            (pack[language as keyof typeof pack]?.[id] || pack.en?.[id])?.label || fallback,
        safe, badge: (value: string) => safe(value), currentSettingsPayload: { settings: [setting] }, currentReport: { backups_tab: { rows: [] } },
        settingTextPacks: {}, t: (key: string) => key, inlineText: safe, isDurationMsSetting: () => false,
        renderSettingControl: () => '<input id="setting-input">', settingControlId: () => 'setting-input', settingSubmitValue: () => true,
        window: { prompt: () => { promptCalls++; return setting.confirmation_phrase; } },
        submitSetting: async (id: string, mode: string, value: boolean, confirmation: string) => {
            await fetcher('/api/settings', { method: 'POST', body: JSON.stringify({ setting_id: id, mode, value, confirmation }) });
        } });
    vm.runInContext(UI_DASHBOARD_CLIENT_BACKUPS, context);
    const render = (rows: unknown[], unavailable: unknown[] = []) => context.renderBackupsTable({ rows, unavailable });
    context.renderBackups = (report: { backups_tab: { rows: unknown[] } }) => {
        context.renderBackupsAutoBackupSettings(report); render(report.backups_tab.rows);
    };
    const event = (id: string, type: string, value?: string | boolean) => {
        const node = nodes.get(id)!; assert.ok(node);
        if (typeof value === 'boolean') node.checked = value;
        if (typeof value === 'string') node.value = value;
        return node.listeners.get(type)!({ target: node });
    };
    const selected = () => Array.from(vm.runInContext('selectedBackupIds', context) as Set<string>).sort();
    const settingClick = () => { const button = settingsNodes.get('setting-save')!; return button.listeners.get('click')!({ target: button }); };
    return { context, render, event, selected, nodes, table, settingsNodes, settingClick, promptCalls: () => promptCalls, focused: () => focused };
}
const rows = [
    { id: 'alpha', created_at: '2026-01-01', size_bytes: 4, size_human: '4 B', health: 'AVAILABLE' },
    { id: 'beta', created_at: '2026-02-01', size_bytes: 8, size_human: '8 B', health: 'AVAILABLE' },
    { id: 'alpine', created_at: '2026-03-01', size_bytes: 16, size_human: '16 B', health: 'AVAILABLE' }
];

test('empty, single and multiple selections show count and exact size without deletion dispatch', () => {
    const c = client(); c.render([]); assert.match(c.table.innerHTML, /Selected backups: 0; 0 bytes/);
    c.render(rows); c.event('alpha', 'change', true); assert.deepEqual(c.selected(), ['alpha']);
    assert.match(c.table.innerHTML, /Selected backups: 1; 4 bytes/); assert.equal(c.focused(), 'alpha');
    c.event('beta', 'change', true); assert.match(c.table.innerHTML, /Selected backups: 2; 12 bytes/);
    c.event('alpha', 'change', false); assert.deepEqual(c.selected(), ['beta']);
    c.event('backup-selection-clear', 'click'); assert.deepEqual(c.selected(), []);
    assert.doesNotMatch(c.table.innerHTML, /backup-delete-selected/);
});

test('filtered select all uses stable IDs across sorting and filter changes, retaining hidden selections', () => {
    const c = client(); c.render(rows); c.event('beta', 'change', true);
    c.event('backup-selection-filter', 'input', 'AL');
    assert.equal(c.focused(), 'backup-selection-filter'); assert.equal(c.nodes.has('beta'), false);
    c.event('backup-selection-all', 'click'); assert.deepEqual(c.selected(), ['alpha', 'alpine', 'beta']);
    c.event('backup-selection-sort', 'change', 'id'); assert.equal(c.focused(), 'backup-selection-sort');
    assert.ok(c.table.innerHTML.indexOf('data-backup-selection-id="alpha"') < c.table.innerHTML.indexOf('data-backup-selection-id="alpine"'));
    c.event('backup-selection-filter', 'input', ''); assert.equal(c.nodes.get('beta')!.checked, true);
    assert.match(c.table.innerHTML, /Selected backups: 3; 28 bytes/);
});

test('search input retains caret and blur does not detach the control clicked for filtered select-all or checkbox', () => {
    const c = client(); c.render(rows);
    const original = c.nodes.get('backup-selection-filter')!;
    original.selectionStart = 1; original.selectionEnd = 2;
    c.event('backup-selection-filter', 'input', 'al');
    const filter = c.nodes.get('backup-selection-filter')!;
    assert.equal(filter.selectionStart, 1); assert.equal(filter.selectionEnd, 2);
    const all = c.nodes.get('backup-selection-all')!;
    // Browser order: mousedown on the visible button, search blur/change, then click.
    filter.listeners.get('change')?.({ target: filter });
    assert.equal(c.nodes.get('backup-selection-all'), all);
    all.listeners.get('click')!({ target: all });
    assert.deepEqual(c.selected(), ['alpha', 'alpine']);
    const checkbox = c.nodes.get('alpha')!;
    c.nodes.get('backup-selection-filter')!.listeners.get('change')?.({ target: filter });
    assert.equal(c.nodes.get('alpha'), checkbox);
    checkbox.checked = false; checkbox.listeners.get('change')!({ target: checkbox });
    assert.deepEqual(c.selected(), ['alpine']);
});

test('failed inventory preserves selected IDs and rejects select-all; authoritative refresh prunes missing IDs', () => {
    const c = client(); c.render(rows); c.event('alpha', 'change', true); c.event('beta', 'change', true);
    c.render([], [{ scope: 'backups:inventory', reason: 'EACCES' }]);
    assert.deepEqual(c.selected(), ['alpha', 'beta']); assert.match(c.table.innerHTML, /Size unavailable/);
    assert.equal(c.nodes.get('backup-selection-all')!.disabled, true);
    c.event('backup-selection-all', 'click'); assert.deepEqual(c.selected(), ['alpha', 'beta']);
    c.render([rows[1]], [{ scope: 'backups:auto-backup', reason: 'settings unreadable' }]);
    assert.deepEqual(c.selected(), ['beta']); assert.match(c.table.innerHTML, /Selected backups: 1; 8 bytes/);
    c.render([]); assert.deepEqual(c.selected(), []);
});

test('EN/RU selection labels have key parity and other languages use English fallback with escaped keyboard labels', () => {
    assert.deepEqual(Object.keys(BACKUP_SELECTION_TEXT.en).sort(), Object.keys(BACKUP_SELECTION_TEXT.ru).sort());
    for (const language of ['en', 'ru', 'fr']) {
        const c = client(language); c.render([{ ...rows[0], id: '<script>"' }]);
        assert.match(c.table.innerHTML, /<label><input type="checkbox"/);
        assert.match(c.table.innerHTML, language === 'ru' ? /Выбрать резервную копию/ : /Select backup/);
        assert.match(c.table.innerHTML, /&lt;script&gt;&quot;/); assert.doesNotMatch(c.table.innerHTML, /<script>/);
    }
});

const previewResult = {
    status: 'previewed', snapshotIds: ['alpha', 'beta'], confirmationToken: 'a'.repeat(64),
    confirmation_phrase: 'DELETE SELECTED BACKUPS', irreversible: true, totalSizeBytes: 12,
    lostRecoveryPointCount: 2, remainingRecoveryPointCount: 0, requiresFinalRecoveryPointConfirmation: true,
    backups: rows.slice(0, 2), warnings: ['Final recovery points']
};
function deletionClient(results: Array<unknown | Promise<unknown>>) {
    const requests: Record<string, unknown>[] = [];
    const c = client('en', true, (async (_url, init) => {
        requests.push(JSON.parse(String(init?.body)));
        const result = await results.shift();
        return { ok: true, json: async () => result } as Response;
    }) as typeof fetch);
    c.render(rows); c.event('alpha', 'change', true); c.event('beta', 'change', true);
    return { ...c, requests };
}

test('rejects wrong phrase and missing final recovery acknowledgement; preview cancellation is read-only', async () => {
    const c = deletionClient([previewResult, previewResult, {
        status: 'executed', requestedIds: ['alpha', 'beta'], removedIds: ['alpha', 'beta'], errors: [],
        inventoryRefreshed: true, inventory: [rows[2]], inventoryError: null
    }]);
    await c.context.previewSelectedBackups();
    assert.equal(c.requests.length, 1); assert.equal(c.requests[0].mode, 'preview');
    assert.match(c.table.innerHTML, /DELETE SELECTED BACKUPS/);
    assert.match(c.table.innerHTML, /alpha/); assert.match(c.table.innerHTML, /12/);
    c.context.cancelBackupDeletion(); assert.equal(c.requests.length, 1);
    await c.context.previewSelectedBackups();
    await c.context.executeSelectedBackupDeletion('wrong', true); assert.equal(c.requests.length, 2);
    await c.context.executeSelectedBackupDeletion('DELETE SELECTED BACKUPS', false); assert.equal(c.requests.length, 2);
    await c.context.executeSelectedBackupDeletion('DELETE SELECTED BACKUPS', true);
    assert.deepEqual(c.requests[2], { action_id: 'backup-delete-selected', mode: 'execute', snapshot_ids: ['alpha', 'beta'],
        confirmation: 'DELETE SELECTED BACKUPS', confirmation_token: 'a'.repeat(64), confirm_final_recovery_point: true });
    assert.deepEqual(c.selected(), []);
});

test('busy preview prevents duplicates, selection mutation and conflicting backup operations; refresh invalidates preview', async () => {
    let resolve!: (value: unknown) => void;
    const c = deletionClient([new Promise(done => { resolve = done; })]);
    const pending = c.context.previewSelectedBackups();
    await c.context.previewSelectedBackups();
    let conflictCalls = 0; await c.context.runWithBackupBusy(async () => { conflictCalls++; });
    await c.context.runBackupAction('backup-create-manual', 'execute', null);
    await c.context.runBackupAction('backup-restore:alpha', 'execute', null);
    c.event('backup-selection-clear', 'click'); assert.deepEqual(c.selected(), ['alpha', 'beta']);
    assert.equal(conflictCalls, 0); assert.equal(c.requests.length, 1);
    c.render([], [{ scope: 'backups:inventory', reason: 'EACCES' }]);
    resolve(previewResult); await pending;
    await c.context.executeSelectedBackupDeletion('DELETE SELECTED BACKUPS', true);
    assert.equal(c.requests.length, 1); assert.deepEqual(c.selected(), ['alpha', 'beta']);
});

test('partial errors retain requested minus removed; failed inventory never becomes current or permits another preview', async () => {
    const c = deletionClient([previewResult, { status: 'partial_failure', requestedIds: ['alpha', 'beta'], removedIds: ['alpha'],
        errors: [{ snapshotId: 'beta', message: 'EACCES <unsafe>' }], inventoryRefreshed: false, inventory: [],
        inventoryError: 'EPERM', audit_error: 'Outcome audit unavailable' }]);
    await c.context.previewSelectedBackups(); await c.context.executeSelectedBackupDeletion('DELETE SELECTED BACKUPS', true);
    assert.deepEqual(c.selected(), ['beta']); assert.match(c.table.innerHTML, /EACCES &lt;unsafe&gt;/);
    assert.match(c.table.innerHTML, /Outcome audit unavailable/);
    await c.context.previewSelectedBackups(); assert.equal(c.requests.length, 2);
});

test('disabled actions never dispatch deletion; changed authoritative inventory invalidates an old token', async () => {
    const disabledRequests: unknown[] = [];
    const disabled = client('en', false, (async (url, init) => {
        disabledRequests.push({ url, body: init?.body }); throw new Error('Unexpected disabled action');
    }) as typeof fetch); disabled.render(rows); disabled.event('alpha', 'change', true);
    await disabled.context.previewSelectedBackups();
    await disabled.context.executeSelectedBackupDeletion('DELETE SELECTED BACKUPS', true);
    assert.deepEqual(disabledRequests, []);
    assert.equal(disabled.nodes.get('backup-selection-preview')!.disabled, true);
    const c = deletionClient([previewResult]); await c.context.previewSelectedBackups();
    c.render([{ ...rows[0], size_bytes: 99 }, rows[1]]);
    await c.context.executeSelectedBackupDeletion('DELETE SELECTED BACKUPS', true); assert.equal(c.requests.length, 1);
});

test('server-rejected stale token retains IDs and exposes error; confirmation clears and fresh inventory is required', async () => {
    const requests: Record<string, unknown>[] = [];
    const c = client('en', true, (async (_url, init) => {
        const request = JSON.parse(String(init?.body)); requests.push(request);
        return { ok: request.mode === 'preview', status: request.mode === 'preview' ? 200 : 409,
            json: async () => request.mode === 'preview' ? previewResult : { error: 'Expired <token>', message: 'Preview no longer matches inventory' } } as Response;
    }) as typeof fetch);
    c.render(rows); c.event('alpha', 'change', true); c.event('beta', 'change', true);
    c.context.renderBackupsAutoBackupSettings({ backups_tab: {} });
    await c.context.previewSelectedBackups();
    await c.context.executeSelectedBackupDeletion('DELETE SELECTED BACKUPS', true);
    assert.equal(requests.length, 2); assert.equal(requests[1].mode, 'execute');
    assert.equal(requests[1].confirmation_token, 'a'.repeat(64));
    assert.deepEqual(c.selected(), ['alpha', 'beta']);
    assert.match(c.table.innerHTML, /Expired &lt;token&gt;/); assert.doesNotMatch(c.table.innerHTML, /Expired <token>/);
    assert.equal(c.nodes.has('backup-selection-phrase'), false); assert.equal(c.focused(), 'backup-selection-result');
    assert.equal(c.settingsNodes.get('setting-save')!.disabled, false);
    assert.equal(c.settingsNodes.get('setting-input')!.disabled, false);
    assert.equal(c.nodes.get('backup-selection-preview')!.disabled, true);
    await c.context.previewSelectedBackups(); await c.context.executeSelectedBackupDeletion('DELETE SELECTED BACKUPS', true);
    assert.equal(requests.length, 2);
    c.render(rows); assert.equal(c.nodes.get('backup-selection-preview')!.disabled, false);
    await c.context.previewSelectedBackups(); assert.equal(requests.length, 3);
    assert.equal(requests[2].mode, 'preview'); assert.equal(c.nodes.has('backup-selection-phrase'), true);
});

test('busy settings and pending execute reject conflicting settings, deletion, create and restore; controls recover', async () => {
    let resolvePreview!: (value: unknown) => void, resolveExecute!: (value: unknown) => void, resolveSetting!: () => void;
    const requests: Record<string, unknown>[] = [];
    const pendingPreview = new Promise(done => { resolvePreview = done; });
    const pendingExecute = new Promise(done => { resolveExecute = done; });
    const pendingSetting = new Promise<void>(done => { resolveSetting = done; });
    const c = client('en', true, (async (_url, init) => {
        if (!init?.body) return { ok: true, json: async () => String(_url) === '/api/settings'
            ? { settings: [{ id: 'auto-backup-enabled', key: 'enabled', label: 'Enabled', current_value: false, confirmation_phrase: 'ENABLE BACKUPS' }] }
            : { backups_tab: { rows } } } as Response;
        const body = JSON.parse(String(init.body)); requests.push(body);
        const result = body.setting_id ? await pendingSetting : body.mode === 'preview' ? await pendingPreview : await pendingExecute;
        return { ok: true, json: async () => result } as Response;
    }) as typeof fetch);
    c.render(rows); c.event('alpha', 'change', true); c.event('beta', 'change', true);
    c.context.renderBackupsAutoBackupSettings({ backups_tab: {} });
    const preview = c.context.previewSelectedBackups(); await c.settingClick();
    assert.equal(c.promptCalls(), 0); assert.equal(requests.length, 1);
    assert.equal(c.settingsNodes.get('setting-save')!.disabled, true); assert.equal(c.settingsNodes.get('setting-input')!.disabled, true);
    resolvePreview(previewResult); await preview;
    assert.equal(c.settingsNodes.get('setting-save')!.disabled, false);
    const execute = c.context.executeSelectedBackupDeletion('DELETE SELECTED BACKUPS', true);
    await c.context.executeSelectedBackupDeletion('DELETE SELECTED BACKUPS', true); await c.context.previewSelectedBackups();
    await c.settingClick(); await c.context.runBackupAction('backup-create-manual', 'execute', null);
    await c.context.runBackupAction('backup-restore:alpha', 'execute', null);
    assert.equal(requests.length, 2); assert.equal(c.promptCalls(), 0);
    assert.equal(c.settingsNodes.get('setting-save')!.disabled, true);
    resolveExecute({ status: 'partial_failure', requestedIds: ['alpha', 'beta'], removedIds: [], errors: [], inventoryRefreshed: false, inventory: [] }); await execute;
    assert.equal(c.settingsNodes.get('setting-input')!.disabled, false);
    c.render(rows);
    const settings = c.settingClick(); await c.settingClick(); await c.context.previewSelectedBackups();
    await c.context.runBackupAction('backup-create-manual', 'execute', null); await c.context.runBackupAction('backup-restore:alpha', 'execute', null);
    assert.equal(requests.length, 3); assert.equal(c.promptCalls(), 1);
    assert.equal(requests[2].setting_id, 'auto-backup-enabled'); assert.equal(c.settingsNodes.get('setting-save')!.disabled, true);
    resolveSetting(); await settings;
    assert.equal(c.settingsNodes.get('setting-save')!.disabled, false);
    assert.equal(c.nodes.get('backup-selection-preview')!.disabled, false);
});


test('rejects late preview after inventory ABA or failed refresh followed by recovery', async () => {
    const outcomes = [];
    for (const failed of [false, true]) {
        let resolve!: (value: unknown) => void;
        const c = deletionClient([new Promise(done => { resolve = done; })]);
        const pending = c.context.previewSelectedBackups();
        if (failed) c.render([], [{ scope: 'backups:inventory', reason: 'EPERM' }]);
        else c.render([rows[1], rows[2]]);
        c.render(rows); resolve(previewResult); await pending;
        const hasConfirmation = c.nodes.has('backup-selection-phrase');
        await c.context.executeSelectedBackupDeletion('DELETE SELECTED BACKUPS', true);
        outcomes.push({ hasConfirmation, requests: c.requests.length, selected: c.selected() });
    }
    assert.deepEqual(outcomes, [
        { hasConfirmation: false, requests: 1, selected: ['beta'] },
        { hasConfirmation: false, requests: 1, selected: ['alpha', 'beta'] }
    ]);
});

test('keyboard preview cancel and delete transitions focus the new confirmation, preview or result target', async () => {
    const c = deletionClient([previewResult, previewResult, { status: 'executed', requestedIds: ['alpha', 'beta'],
        removedIds: ['alpha', 'beta'], errors: [], inventoryRefreshed: true, inventory: [rows[2]], inventoryError: null }]);
    c.nodes.get('backup-selection-preview')!.focus(); await c.context.previewSelectedBackups();
    assert.equal(c.focused(), 'backup-selection-phrase');
    c.nodes.get('backup-selection-cancel')!.focus(); c.context.cancelBackupDeletion();
    assert.equal(c.focused(), 'backup-selection-preview');
    await c.context.previewSelectedBackups();
    c.nodes.get('backup-selection-execute')!.focus(); await c.context.executeSelectedBackupDeletion('DELETE SELECTED BACKUPS', true);
    assert.equal(c.focused(), 'backup-selection-result');
    assert.match(c.table.innerHTML, /id="backup-selection-result"[^>]*tabindex="-1"/);
});
