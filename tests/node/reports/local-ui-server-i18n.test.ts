import test from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import * as vm from 'node:vm';
import {
    startLocalUiServer
} from '../../../src/reports/ui';
import {
    cleanupLocalUiTestResources,
    makeLocalUiTempRepo,
    writeLocalUiRepoFixture
} from './local-ui-test-helpers';

type FakeListener = () => void | Promise<void>;

class FakeClassList {
    private readonly classes = new Set<string>();

    constructor(initialClasses: string[] = []) {
        for (const className of initialClasses) {
            this.classes.add(className);
        }
    }

    toggle(className: string, force?: boolean): void {
        if (force === true) {
            this.classes.add(className);
            return;
        }
        if (force === false) {
            this.classes.delete(className);
            return;
        }
        if (this.classes.has(className)) {
            this.classes.delete(className);
            return;
        }
        this.classes.add(className);
    }
}

class FakeElement {
    readonly listeners = new Map<string, FakeListener[]>();
    readonly dataset: Record<string, string> = {};
    readonly classList: FakeClassList;
    textContent = '';
    value = '';
    hidden = false;
    focused = false;
    scrolled = false;
    private buttonCacheHtml = '';
    private buttonCache: FakeElement[] = [];
    private html = '';

    constructor(readonly id: string, initialClasses: string[] = []) {
        this.classList = new FakeClassList(initialClasses);
    }

    get innerHTML(): string {
        return this.html;
    }

    set innerHTML(value: string) {
        this.html = value;
    }

    addEventListener(eventName: string, listener: FakeListener): void {
        const listeners = this.listeners.get(eventName) || [];
        listeners.push(listener);
        this.listeners.set(eventName, listeners);
    }

    async dispatch(eventName: string): Promise<void> {
        for (const listener of this.listeners.get(eventName) || []) {
            await listener();
        }
    }

    setAttribute(_name: string, _value: string): void {
        // no-op test double
    }

    focus(): void {
        this.focused = true;
    }

    scrollIntoView(): void {
        this.scrolled = true;
    }

    querySelectorAll(selector: string): FakeElement[] {
        if (selector !== 'button[data-task-id]'
            && selector !== 'button[data-action-id]'
            && selector !== 'button[data-setting-id]'
            && selector !== 'button[data-task-action-id]'
            && selector !== 'button[data-backup-action-id]'
            && selector !== 'button[data-instruction-tab]') {
            return [];
        }
        if (this.buttonCacheHtml !== this.innerHTML) {
            this.buttonCacheHtml = this.innerHTML;
            const attributeName = selector === 'button[data-task-id]'
                ? 'task-id'
                : selector === 'button[data-action-id]'
                    ? 'action-id'
                    : selector === 'button[data-setting-id]'
                    ? 'setting-id'
                    : selector === 'button[data-task-action-id]'
                        ? 'task-action-id'
                        : selector === 'button[data-backup-action-id]'
                            ? 'backup-action-id'
                            : 'instruction-tab';
            const dataKey = selector === 'button[data-task-id]'
                ? 'taskId'
                : selector === 'button[data-action-id]'
                    ? 'actionId'
                    : selector === 'button[data-setting-id]'
                        ? 'settingId'
                        : selector === 'button[data-task-action-id]'
                            ? 'taskActionId'
                            : selector === 'button[data-backup-action-id]'
                                ? 'backupActionId'
                                : 'instructionTab';
            const modePattern = /data-action-mode="([^"]+)"/u;
            const settingModePattern = /data-setting-mode="([^"]+)"/u;
            const taskActionModePattern = /data-task-action-mode="([^"]+)"/u;
            this.buttonCache = Array.from(this.innerHTML.matchAll(new RegExp(`data-${attributeName}="([^"]+)"`, 'gu')), (match) => {
                const button = new FakeElement(`button-${match[1]}`);
                button.dataset[dataKey] = match[1];
                const buttonHtml = this.innerHTML.slice(Math.max(0, match.index || 0), this.innerHTML.indexOf('</button>', match.index || 0));
                const modeMatch = buttonHtml.match(modePattern);
                if (modeMatch) {
                    button.dataset.actionMode = modeMatch[1];
                }
                const settingModeMatch = buttonHtml.match(settingModePattern);
                if (settingModeMatch) {
                    button.dataset.settingMode = settingModeMatch[1];
                }
                const taskActionModeMatch = buttonHtml.match(taskActionModePattern);
                if (taskActionModeMatch) {
                    button.dataset.taskActionMode = taskActionModeMatch[1];
                }
                return button;
            });
        }
        return this.buttonCache;
    }
}

function createFakeDocument(): {
    elements: Record<string, FakeElement>;
    getElementById: (id: string) => FakeElement;
    querySelectorAll: (selector: string) => FakeElement[];
} {
    const elements: Record<string, FakeElement> = {};
    for (const id of [
        'tasks',
        'detail',
        'meta',
        'warnings',
        'overview',
        'garda-switch-panel',
        'workflow',
        'workflow-config-path',
        'settings-editor',
        'init-settings',
        'project-memory',
        'instructions',
        'actions',
        'action-status',
        'session-summary',
        'session-countdown',
        'session-activity',
        'session-shutdown',
        'plan-modal',
        'plan-modal-body',
        'plan-modal-close',
        'language-select',
        'ui-notice',
        'task-search',
        'status-filter',
        'priority-filter',
        'tasks-tab',
        'workflow-tab',
        'init-settings-tab',
        'project-memory-tab',
        'backups-tab',
        'backups-settings',
        'backups-table',
        'backup-action-status',
        'cleanup-settings-tab',
        'cleanup-settings',
        'cleanup-status',
        'instructions-tab',
        'actions-tab',
        'task-detail-panel'
    ]) {
        elements[id] = new FakeElement(id, id.endsWith('-tab') ? ['tab'] : []);
    }
    elements['workflow-tab'].hidden = true;
    elements['init-settings-tab'].hidden = true;
    elements['project-memory-tab'].hidden = true;
    elements['backups-tab'].hidden = true;
    elements['cleanup-settings-tab'].hidden = true;
    elements['instructions-tab'].hidden = true;
    elements['actions-tab'].hidden = true;

    const navButtons = ['tasks-tab', 'workflow-tab', 'init-settings-tab', 'project-memory-tab', 'backups-tab', 'cleanup-settings-tab', 'instructions-tab', 'actions-tab'].map((tabId, index) => {
        const button = new FakeElement(`nav-${tabId}`, index === 0 ? ['active'] : []);
        button.dataset.tab = tabId;
        return button;
    });

    return {
        elements,
        getElementById: (id: string) => {
            elements[id] = elements[id] || new FakeElement(id);
            return elements[id];
        },
        querySelectorAll: (selector: string) => {
            if (selector === 'nav button[data-tab]') {
                return navButtons;
            }
            if (selector === '.tab') {
                return [
                    elements['tasks-tab'],
                    elements['workflow-tab'],
                    elements['init-settings-tab'],
                    elements['project-memory-tab'],
                    elements['backups-tab'],
                    elements['cleanup-settings-tab'],
                    elements['instructions-tab'],
                    elements['actions-tab']
                ];
            }
            return [];
        }
    };
}

function extractDashboardScript(html: string): string {
    const match = html.match(/<script>([\s\S]*)<\/script>/u);
    assert.ok(match, 'expected inline dashboard script');
    return match[1];
}

async function flushPromises(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
}

const makeTempRepo = makeLocalUiTempRepo;
const writeRepo = writeLocalUiRepoFixture;

test('local UI server applies initial language option to rendered dashboard', async () => {
    const repoRoot = makeTempRepo();
    writeRepo(repoRoot);
    const server = await startLocalUiServer({ repoRoot, port: 0, language: 'ru' });
    try {
        const html = await (await fetch(server.url)).text();
        assert.match(html, /<html lang="ru">/u);
        assert.match(html, /Загрузка сессии сервера/u);
        assert.equal(server.language, 'ru');
    } finally {
        await cleanupLocalUiTestResources({ repoRoot, server });
    }
});

test('local UI dashboard restores persisted browser language on page load', async () => {
    const repoRoot = makeTempRepo();
    writeRepo(repoRoot);
    const server = await startLocalUiServer({ repoRoot, port: 0 });
    try {
        const html = await (await fetch(server.url)).text();
        const fakeDocument = createFakeDocument();
        const report = {
            repo_root: repoRoot,
            unavailable: [],
            tasks_tab: {
                rows: [
                    {
                        task_id: 'T-100',
                        status: 'TODO',
                        status_token: 'TODO',
                        priority: 'P2',
                        area: 'ui/report',
                        title: 'Build UI',
                        owner: 'gpt-5.4',
                        notes: 'Uses lazy details',
                        detail: { detail_status: 'skipped' }
                    }
                ]
            },
            workflow_config_tab: { settings: [] },
            instructions_tab: { entries: [] }
        };
        const session = {
            enabled: true,
            state: 'active',
            last_activity_at: '2026-05-19T00:00:00.000Z',
            idle_minutes: 15,
            warning_seconds: 60,
            idle_deadline_at: '2026-05-19T00:15:00.000Z',
            shutdown_deadline_at: null,
            seconds_until_warning: 900,
            seconds_until_shutdown: null,
            stop_message: 'The local Garda UI server has stopped. Rerun `garda ui` from a terminal to launch it again.'
        };

        vm.runInNewContext(extractDashboardScript(html), {
            document: fakeDocument,
            window: {
                prompt: () => null,
                addEventListener: () => undefined,
                localStorage: {
                    getItem: (key: string) => key === 'garda.ui.language' ? 'ru' : null,
                    setItem: () => undefined
                }
            },
            setInterval: () => 1,
            clearInterval: () => undefined,
            fetch: async (url: string) => ({
                ok: true,
                status: 200,
                json: async () => {
                    if (url === '/api/session') {
                        return session;
                    }
                    if (url === '/api/report') {
                        return report;
                    }
                    if (url === '/api/actions') {
                        return { enabled: false, switch_state: 'on', actions: [] };
                    }
                    if (url === '/api/settings') {
                        return { enabled: false, settings: [] };
                    }
                    return {};
                }
            })
        });
        await flushPromises();

        assert.equal(fakeDocument.elements['language-select'].value, 'ru');
        assert.match(fakeDocument.elements.overview.innerHTML, /Активные/u);
        assert.match(fakeDocument.elements['session-summary'].innerHTML, /Выключение через/u);
    } finally {
        await cleanupLocalUiTestResources({ repoRoot, server });
    }
});

test('local UI dashboard prefers case-insensitive regional browser language before base fallback', async () => {
    const repoRoot = makeTempRepo();
    writeRepo(repoRoot);
    const server = await startLocalUiServer({ repoRoot, port: 0 });
    try {
        const html = await (await fetch(server.url)).text();
        const fakeDocument = createFakeDocument();
        const report = {
            repo_root: repoRoot,
            unavailable: [],
            tasks_tab: {
                rows: [
                    {
                        task_id: 'T-100',
                        status: 'TODO',
                        status_token: 'TODO',
                        priority: 'P2',
                        area: 'ui/report',
                        title: 'Build UI',
                        owner: 'gpt-5.4',
                        notes: 'Uses lazy details',
                        detail: { detail_status: 'skipped' }
                    }
                ]
            },
            workflow_config_tab: { settings: [] },
            instructions_tab: { entries: [] }
        };
        const session = {
            enabled: true,
            state: 'active',
            last_activity_at: '2026-05-19T00:00:00.000Z',
            idle_minutes: 15,
            warning_seconds: 60,
            idle_deadline_at: '2026-05-19T00:15:00.000Z',
            shutdown_deadline_at: null,
            seconds_until_warning: 900,
            seconds_until_shutdown: null,
            stop_message: 'The local Garda UI server has stopped. Rerun `garda ui` from a terminal to launch it again.'
        };

        vm.runInNewContext(extractDashboardScript(html), {
            document: fakeDocument,
            navigator: {
                language: 'pt-br',
                languages: ['pt-br', 'pt']
            },
            window: {
                prompt: () => null,
                addEventListener: () => undefined,
                localStorage: {
                    getItem: () => null,
                    setItem: () => undefined
                }
            },
            setInterval: () => 1,
            clearInterval: () => undefined,
            fetch: async (url: string) => ({
                ok: true,
                status: 200,
                json: async () => {
                    if (url === '/api/session') {
                        return session;
                    }
                    if (url === '/api/report') {
                        return report;
                    }
                    if (url === '/api/actions') {
                        return { enabled: false, switch_state: 'on', actions: [] };
                    }
                    if (url === '/api/settings') {
                        return { enabled: false, settings: [] };
                    }
                    return {};
                }
            })
        });
        await flushPromises();

        assert.equal(fakeDocument.elements['language-select'].value, 'pt-BR');
    } finally {
        await cleanupLocalUiTestResources({ repoRoot, server });
    }
});

test('local UI dashboard falls back from unsupported browser locale to server initial language', async () => {
    const repoRoot = makeTempRepo();
    writeRepo(repoRoot);
    const server = await startLocalUiServer({ repoRoot, port: 0, language: 'de' });
    try {
        const html = await (await fetch(server.url)).text();
        const fakeDocument = createFakeDocument();
        const report = {
            repo_root: repoRoot,
            unavailable: [],
            tasks_tab: {
                rows: [
                    {
                        task_id: 'T-100',
                        status: 'TODO',
                        status_token: 'TODO',
                        priority: 'P2',
                        area: 'ui/report',
                        title: 'Build UI',
                        owner: 'gpt-5.4',
                        notes: 'Uses lazy details',
                        detail: { detail_status: 'skipped' }
                    }
                ]
            },
            workflow_config_tab: { settings: [] },
            instructions_tab: { entries: [] }
        };
        const session = {
            enabled: true,
            state: 'active',
            last_activity_at: '2026-05-19T00:00:00.000Z',
            idle_minutes: 15,
            warning_seconds: 60,
            idle_deadline_at: '2026-05-19T00:15:00.000Z',
            shutdown_deadline_at: null,
            seconds_until_warning: 900,
            seconds_until_shutdown: null,
            stop_message: 'The local Garda UI server has stopped. Rerun `garda ui` from a terminal to launch it again.'
        };

        vm.runInNewContext(extractDashboardScript(html), {
            document: fakeDocument,
            navigator: {
                language: 'zz-ZZ',
                languages: ['zz-ZZ']
            },
            window: {
                prompt: () => null,
                addEventListener: () => undefined,
                localStorage: {
                    getItem: () => null,
                    setItem: () => undefined
                }
            },
            setInterval: () => 1,
            clearInterval: () => undefined,
            fetch: async (url: string) => ({
                ok: true,
                status: 200,
                json: async () => {
                    if (url === '/api/session') {
                        return session;
                    }
                    if (url === '/api/report') {
                        return report;
                    }
                    if (url === '/api/actions') {
                        return { enabled: false, switch_state: 'on', actions: [] };
                    }
                    if (url === '/api/settings') {
                        return { enabled: false, settings: [] };
                    }
                    return {};
                }
            })
        });
        await flushPromises();

        assert.equal(fakeDocument.elements['language-select'].value, 'de');
        assert.match(fakeDocument.elements.overview.innerHTML, /Aktiv/u);
    } finally {
        await cleanupLocalUiTestResources({ repoRoot, server });
    }
});

test('local UI cleanup settings rerender when the dashboard language changes', async () => {
    const repoRoot = makeTempRepo();
    writeRepo(repoRoot);
    const server = await startLocalUiServer({ repoRoot, port: 0, language: 'en' });
    try {
        const html = await (await fetch(server.url)).text();
        const fakeDocument = createFakeDocument();
        const report = {
            repo_root: repoRoot,
            unavailable: [],
            tasks_tab: { rows: [] },
            workflow_config_tab: { settings: [] },
            instructions_tab: { entries: [] }
        };
        const session = {
            enabled: true,
            state: 'active',
            last_activity_at: '2026-05-19T00:00:00.000Z',
            idle_minutes: 15,
            warning_seconds: 60,
            idle_deadline_at: '2026-05-19T00:15:00.000Z',
            shutdown_deadline_at: null,
            seconds_until_warning: 900,
            seconds_until_shutdown: null,
            stop_message: 'The local Garda UI server has stopped. Rerun `garda ui` from a terminal to launch it again.'
        };
        const cleanupPayload = {
            enabled: false,
            config_path: path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'runtime-retention.json'),
            settings: {
                daily_maintenance_enabled: true,
                daily_maintenance_max_tasks_per_run: 5,
                daily_maintenance_dry_run: true,
                eligible_older_than_days: 14,
                keep_latest_tasks: 10,
                include_problematic_tasks: false,
                purge_require_confirm: true,
                healthy_done_compact_after_days: 7,
                problem_tasks_compress_after_days: 30
            }
        };
        const context: Record<string, unknown> = {
            document: fakeDocument,
            window: {
                prompt: () => null,
                addEventListener: () => undefined,
                localStorage: {
                    getItem: () => null,
                    setItem: () => undefined
                }
            },
            setInterval: () => 1,
            clearInterval: () => undefined,
            fetch: async (url: string) => ({
                ok: true,
                status: 200,
                json: async () => {
                    if (url === '/api/session') {
                        return session;
                    }
                    if (url === '/api/report') {
                        return report;
                    }
                    if (url === '/api/actions') {
                        return { enabled: false, switch_state: 'on', actions: [] };
                    }
                    if (url === '/api/settings') {
                        return { enabled: false, settings: [] };
                    }
                    if (url === '/api/cleanup-settings') {
                        return cleanupPayload;
                    }
                    return {};
                }
            })
        };

        vm.runInNewContext(extractDashboardScript(html), context);
        await flushPromises();
        const cleanupSettingsHtml = fakeDocument.elements['cleanup-settings'].innerHTML;
        assert.match(cleanupSettingsHtml, /data-cleanup-maintenance-mode><strong>Daily maintenance:<\/strong> Preview calculation/u);
        const maintenanceMode = context.cleanupMaintenanceModeLabel as (settings: Record<string, boolean>) => string;
        assert.equal(maintenanceMode({ daily_maintenance_enabled: true, daily_maintenance_dry_run: false, purge_require_confirm: false }), 'Run cleanup');
        assert.equal(maintenanceMode({ daily_maintenance_enabled: true, daily_maintenance_dry_run: true, purge_require_confirm: false }), 'Preview calculation');
        assert.equal(maintenanceMode({ daily_maintenance_enabled: true, daily_maintenance_dry_run: false, purge_require_confirm: true }), 'Preview calculation');
        assert.notEqual(maintenanceMode({ daily_maintenance_enabled: false, daily_maintenance_dry_run: false, purge_require_confirm: false }), 'Run cleanup');
        assert.match(cleanupSettingsHtml, /Delete tasks older than \(days\)/u);
        assert.match(cleanupSettingsHtml, /Keep at least newest tasks \(count\)/u);
        assert.match(cleanupSettingsHtml, /Also delete problematic tasks/u);
        assert.match(cleanupSettingsHtml, /Preview calculation/u);
        assert.match(cleanupSettingsHtml, /Run cleanup/u);
        assert.ok(
            cleanupSettingsHtml.indexOf('id="cleanup-run-apply"') < cleanupSettingsHtml.indexOf('id="cleanup-older-than-days"'),
            'manual cleanup age input should render immediately after the run buttons'
        );
        assert.ok(
            cleanupSettingsHtml.indexOf('id="cleanup-older-than-days"') < cleanupSettingsHtml.indexOf('id="cleanup-keep-latest"'),
            'manual cleanup keep-latest input should render after the age input'
        );
        assert.ok(
            cleanupSettingsHtml.indexOf('id="cleanup-keep-latest"') < cleanupSettingsHtml.indexOf('id="cleanup-include-problematic"'),
            'manual cleanup problematic-task checkbox should render after the retention inputs'
        );
        assert.doesNotMatch(cleanupSettingsHtml, /data-cleanup-field="eligible_older_than_days"/u);
        assert.doesNotMatch(cleanupSettingsHtml, /data-cleanup-field="keep_latest_tasks"/u);
        fakeDocument.getElementById('cleanup-older-than-days').value = '11';
        fakeDocument.getElementById('cleanup-keep-latest').value = '2';
        const includeProblematicInput = fakeDocument.getElementById('cleanup-include-problematic') as unknown as {
            checked: boolean;
            type: string;
        };
        includeProblematicInput.type = 'checkbox';
        includeProblematicInput.checked = true;
        const cleanupRunSelectionFromInputs = context.cleanupRunSelectionFromInputs as (() => unknown) | undefined;
        assert.equal(typeof cleanupRunSelectionFromInputs, 'function');
        assert.ok(cleanupRunSelectionFromInputs);
        const cleanupRunSelection = cleanupRunSelectionFromInputs() as {
            eligible_older_than_days?: unknown;
            keep_latest_tasks?: unknown;
            include_problematic_tasks?: unknown;
        };
        assert.equal(cleanupRunSelection.eligible_older_than_days, '11');
        assert.equal(cleanupRunSelection.keep_latest_tasks, '2');
        assert.equal(cleanupRunSelection.include_problematic_tasks, true);
        const normalizePromptConfirmation = context.normalizePromptConfirmation as ((value: unknown) => unknown) | undefined;
        assert.equal(typeof normalizePromptConfirmation, 'function');
        assert.ok(normalizePromptConfirmation);
        assert.equal(normalizePromptConfirmation(' RUN GARDA CLEANUP '), 'RUN GARDA CLEANUP');

        const renderCleanupProgress = context.renderCleanupProgress as ((actionId: string) => void) | undefined;
        assert.equal(typeof renderCleanupProgress, 'function');
        assert.ok(renderCleanupProgress);
        renderCleanupProgress('cleanup-preview-custom');
        assert.match(fakeDocument.elements['cleanup-status'].innerHTML, /cleanup-progress-panel/u);
        assert.match(fakeDocument.elements['cleanup-status'].innerHTML, /<progress class="cleanup-progress"/u);
        assert.match(fakeDocument.elements['cleanup-status'].innerHTML, /Preview calculation/u);
        assert.match(fakeDocument.elements['cleanup-status'].innerHTML, /Manual runtime cleanup/u);
        assert.equal(fakeDocument.elements['cleanup-status'].focused, true);
        assert.equal(fakeDocument.elements['cleanup-status'].scrolled, true);

        const renderCleanupResult = context.renderCleanupResult as ((result: unknown) => void) | undefined;
        assert.equal(typeof renderCleanupResult, 'function');
        assert.ok(renderCleanupResult);
        renderCleanupResult({
            status: 'previewed',
            action_id: 'cleanup-preview-custom',
            command: 'garda cleanup batch-task-purge --dry-run',
            stdout: [
                '\u001b[36mBatchPurgeCandidateTasks:\u001b[0m 12',
                'BatchPurgeSelectedTasks: 4',
                '\u001b[33mWould remove\u001b[0m (reviews): 3',
                'Would remove (task-events): 1',
                '\u001b[32mWould free:\u001b[0m 1.00 MB'
            ].join('\n')
        });
        assert.match(fakeDocument.elements['cleanup-status'].innerHTML, /Preview calculation/u);
        assert.match(fakeDocument.elements['cleanup-status'].innerHTML, /Manual runtime cleanup/u);
        assert.match(fakeDocument.elements['cleanup-status'].innerHTML, /Cleanup result/u);
        assert.match(fakeDocument.elements['cleanup-status'].innerHTML, /Dry-run only/u);
        assert.match(fakeDocument.elements['cleanup-status'].innerHTML, /Cleanup report/u);
        assert.match(fakeDocument.elements['cleanup-status'].innerHTML, /Preview candidates: 12/u);
        assert.match(fakeDocument.elements['cleanup-status'].innerHTML, /Eligible now: 4/u);
        assert.match(fakeDocument.elements['cleanup-status'].innerHTML, /Would remove: 4 \(reviews: 3, task-events: 1\)/u);
        assert.match(fakeDocument.elements['cleanup-status'].innerHTML, /Would free: 1\.00 MB/u);
        assert.equal(fakeDocument.elements['cleanup-status'].focused, true);
        assert.equal(fakeDocument.elements['cleanup-status'].scrolled, true);

        renderCleanupResult({
            status: 'executed',
            action_id: 'cleanup-apply-custom',
            exit_code: 0,
            stdout: [
                'BatchPurgeSelectedTasks: 4',
                '\u001b[33mRemoved\u001b[0m (reviews): 2',
                'Removed (task-events): 1',
                '\u001b[32mFreed:\u001b[0m 768.00 KB'
            ].join('\n')
        });
        assert.match(fakeDocument.elements['cleanup-status'].innerHTML, /Run cleanup/u);
        assert.match(fakeDocument.elements['cleanup-status'].innerHTML, /Removed: 3 \(reviews: 2, task-events: 1\)/u);
        assert.match(fakeDocument.elements['cleanup-status'].innerHTML, /Freed: 768\.00 KB/u);
        assert.doesNotMatch(fakeDocument.elements['cleanup-status'].innerHTML, /Would remove/u);

        renderCleanupResult({
            status: 'executed',
            action_id: 'cleanup-apply-custom',
            exit_code: 1,
            stderr: 'cleanup failed'
        });
        assert.match(fakeDocument.elements['cleanup-status'].innerHTML, /Run cleanup/u);
        assert.match(fakeDocument.elements['cleanup-status'].innerHTML, /Exit code 1/u);
        assert.match(fakeDocument.elements['cleanup-status'].innerHTML, /cleanup failed/u);
        assert.doesNotMatch(fakeDocument.elements['cleanup-status'].innerHTML, /<code>Applied/u);

        renderCleanupResult({
            status: 'confirmation_required',
            action_id: 'cleanup-apply-custom',
            confirmation_phrase: 'RUN GARDA CLEANUP'
        });
        assert.match(fakeDocument.elements['cleanup-status'].innerHTML, /Run cleanup/u);
        assert.match(fakeDocument.elements['cleanup-status'].innerHTML, /Confirmation required: RUN GARDA CLEANUP/u);

        fakeDocument.elements['cleanup-status'].focused = false;
        fakeDocument.elements['cleanup-status'].scrolled = false;
        renderCleanupResult({
            status: 'executed',
            action_id: 'cleanup-task-purge',
            exit_code: 0,
            stdout: 'task runtime artifacts cleaned'
        });
        assert.match(fakeDocument.elements['cleanup-status'].innerHTML, /Clean task runtime artifacts/u);
        assert.match(fakeDocument.elements['cleanup-status'].innerHTML, /<code>OK<\/code>/u);
        assert.match(fakeDocument.elements['cleanup-status'].innerHTML, /task runtime artifacts cleaned/u);
        assert.equal(fakeDocument.elements['cleanup-status'].focused, true);
        assert.equal(fakeDocument.elements['cleanup-status'].scrolled, true);

        renderCleanupResult({
            status: 'previewed',
            action_id: 'cleanup-preview-custom',
            command: 'garda cleanup batch-task-purge --dry-run',
            stdout: [
                'BatchPurgeCandidateTasks: 12',
                'BatchPurgeSelectedTasks: 4',
                'Would remove (reviews): 3',
                'Would free: 1.00 MB'
            ].join('\n')
        });
        fakeDocument.elements['language-select'].value = 'de';
        await fakeDocument.elements['language-select'].dispatch('change');

        assert.match(fakeDocument.elements['cleanup-settings'].innerHTML, /Aufgaben älter als löschen|Tägliche Wartung|Speichern/u);
        assert.match(fakeDocument.elements['cleanup-settings'].innerHTML, /Auch problematische Aufgaben löschen/u);
        assert.match(fakeDocument.elements['cleanup-status'].innerHTML, /Vorberechnung/u);
        assert.match(fakeDocument.elements['cleanup-status'].innerHTML, /Manuelle Runtime-Bereinigung/u);
        assert.match(fakeDocument.elements['cleanup-status'].innerHTML, /Nur Dry-run/u);
    } finally {
        await cleanupLocalUiTestResources({ repoRoot, server });
    }
});
