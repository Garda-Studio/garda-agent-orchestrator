import test from 'node:test';
import assert from 'node:assert/strict';
import * as vm from 'node:vm';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createUpdateAvailabilityService } from '../../../src/lifecycle/update-availability/update-availability-service';
import { UPDATE_CHECK_TTL_MS } from '../../../src/lifecycle/update-availability/update-availability-types';
import { startLocalUiServer } from '../../../src/reports/ui/local-ui-server';
import { buildDashboardUpdatesClientScript } from '../../../src/reports/ui/dashboard/dashboard-client-updates';
import { UI_DASHBOARD_CLIENT_BOOTSTRAP } from '../../../src/reports/ui/dashboard/dashboard-client-bootstrap';
import { LOCAL_UI_LANGUAGES } from '../../../src/reports/ui/ui-i18n';
import { UPDATE_AVAILABILITY_TEXT } from '../../../src/reports/ui/update-availability-text';
import { renderLocalUiHtml } from '../../../src/reports/ui/ui-dashboard-html';
import { cleanupLocalUiTestResources, makeLocalUiTempRepo, writeLocalUiRepoFixture } from './local-ui-test-helpers';

test('update notice has complete translations and accessibility text for every UI locale', () => {
    const englishKeys = Object.keys(UPDATE_AVAILABILITY_TEXT.en).sort();
    assert.deepEqual(Object.keys(UPDATE_AVAILABILITY_TEXT).sort(), LOCAL_UI_LANGUAGES.map(language => language.id).sort());
    for (const { id } of LOCAL_UI_LANGUAGES) {
        const pack = UPDATE_AVAILABILITY_TEXT[id];
        assert.deepEqual(Object.keys(pack).sort(), englishKeys);
        for (const key of englishKeys) {
            const value = pack[key as keyof typeof pack];
            assert.ok(value.trim(), `${id}: ${key}`);
            assert.deepEqual(value.match(/\{[a-z]+\}/gu), UPDATE_AVAILABILITY_TEXT.en[key as keyof typeof pack].match(/\{[a-z]+\}/gu));
        }
        const html = renderLocalUiHtml(false, 'test-token', id);
        assert.ok(html.includes('id="update-check"'));
        assert.ok(html.includes('aria-live="polite"'));
        assert.ok(html.includes(pack.checkButton));
    }
});

test('UI startup is nonblocking and manual checks reject missing tokens even in read-only UI', async t => {
    const repoRoot = makeLocalUiTempRepo();
    writeLocalUiRepoFixture(repoRoot);
    let automatic = 0;
    let manual = 0;
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const view = { status: 'available' as const, currentVersion: '1.4.3', latestVersion: '1.4.4', updateCommand: 'garda check-update --target-root "." --apply' };
    const server = await startLocalUiServer({ repoRoot, port: 0, actionsEnabled: false, updateAvailabilityService: {
        snapshot: () => view,
        check: async options => { if (options?.manual) { manual++; return view; } automatic++; await blocked; return view; }
    } });
    t.after(async () => { release(); await cleanupLocalUiTestResources({ repoRoot, server }); });
    assert.equal(automatic, 1);
    const html = await (await fetch(server.url)).text();
    const token = html.match(/const actionToken = "([a-f0-9]+)";/u)?.[1];
    assert.ok(token);
    const denied = await fetch(`${server.url}api/update-availability/check`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(denied.status, 403);
    assert.equal(manual, 0);
    const accepted = await fetch(`${server.url}api/update-availability/check`, { method: 'POST', headers: {
        'Content-Type': 'application/json', 'X-Garda-Action-Token': token, Origin: server.url.slice(0, -1)
    }, body: '{}' });
    assert.equal(accepted.status, 200);
    assert.equal((await accepted.json() as { latestVersion: string }).latestVersion, '1.4.4');
    assert.equal(manual, 1);
    let automaticDelivered = false;
    const automaticResponse = fetch(`${server.url}api/update-availability`).then(response => { automaticDelivered = true; return response; });
    await delay(20);
    assert.equal(automaticDelivered, false, 'the update endpoint waits for startup metadata without blocking the HTML page');
    release();
    const automaticView = await (await automaticResponse).json() as { latestVersion: string };
    assert.equal(automaticView.latestVersion, '1.4.4');
    assert.equal(automatic, 1, 'GET reuses the shared startup check');
});

test('real browser bootstrap GET reaches the startup endpoint and renders the localized update notice', async t => {
    const repoRoot = makeLocalUiTempRepo();
    writeLocalUiRepoFixture(repoRoot);
    let automatic = 0;
    const view = { status: 'available' as const, currentVersion: '1.4.3', latestVersion: '1.4.4', updateCommand: 'garda check-update --target-root "." --apply' };
    const server = await startLocalUiServer({ repoRoot, port: 0, actionsEnabled: false, updateAvailabilityService: {
        snapshot: () => view,
        check: async () => { automatic++; return view; }
    } });
    t.after(() => cleanupLocalUiTestResources({ repoRoot, server }));
    const html = await (await fetch(server.url)).text();
    const nodes = new Map<string, Record<string, unknown>>();
    for (const match of html.matchAll(/\bid="([^"]+)"/gu)) {
        nodes.set(match[1], { textContent: '', hidden: false, disabled: false, setAttribute: () => undefined, addEventListener: () => undefined });
    }
    const inertNode = { addEventListener: () => undefined };
    const requested: Array<{ path: string; method: string }> = [];
    const context: Record<string, unknown> = {
        document: { getElementById: (id: string) => nodes.get(id), querySelectorAll: () => [] },
        window: { addEventListener: () => undefined }, currentLanguage: 'ru', actionToken: '',
        languageSelectNode: inertNode, searchNode: inertNode, statusFilterNode: inertNode, priorityFilterNode: inertNode,
        sessionActivityNode: inertNode, sessionShutdownNode: inertNode, planModalCloseNode: inertNode, planModalNode: inertNode,
        renderTaskRows: () => undefined, closeTaskPlanModal: () => undefined,
        refreshSession: () => undefined, applyLanguage: () => undefined,
        setInterval: () => 0, renderTasks: () => undefined,
        fetch: (input: string, init?: RequestInit) => {
            requested.push({ path: input, method: init?.method ?? 'GET' });
            return fetch(new URL(input, server.url), init);
        }
    };
    for (const name of ['refreshActionsPayload', 'refreshSettingsPayload', 'refreshProfilesPayload', 'refreshBackupsSettingsEditor', 'refreshCleanupSettingsPayload']) {
        context[name] = async () => undefined;
    }
    vm.runInNewContext(buildDashboardUpdatesClientScript() + '\n' + UI_DASHBOARD_CLIENT_BOOTSTRAP, context);
    const deadline = Date.now() + 3000;
    while (!String(nodes.get('update-status')?.textContent).includes('1.4.4') && Date.now() < deadline) await delay(10);
    assert.ok(String(nodes.get('update-status')?.textContent).includes('1.4.3'));
    assert.ok(String(nodes.get('update-status')?.textContent).includes('1.4.4'));
    assert.equal(nodes.get('update-title')?.textContent, UPDATE_AVAILABILITY_TEXT.ru.title);
    assert.equal(nodes.get('update-check')?.textContent, UPDATE_AVAILABILITY_TEXT.ru.checkButton);
    assert.equal(nodes.get('update-command')?.textContent, view.updateCommand);
    assert.equal(nodes.get('update-panel')?.hidden, false);
    assert.deepEqual(requested.filter(request => request.path.includes('update-availability')), [{ path: '/api/update-availability', method: 'GET' }]);
    assert.equal(automatic, 1);
});

test('production UI snapshot rejects synchronous source and cache reads', async t => {
    const repoRoot = makeLocalUiTempRepo();
    writeLocalUiRepoFixture(repoRoot);
    const bundleRoot = path.join(repoRoot, 'garda-agent-orchestrator');
    fs.writeFileSync(path.join(bundleRoot, 'VERSION'), '1.4.3');
    fs.writeFileSync(path.join(bundleRoot, 'package.json'), JSON.stringify({ name: 'garda-agent-orchestrator' }));
    const enabledBefore = process.env.GARDA_UPDATE_CHECK;
    process.env.GARDA_UPDATE_CHECK = '1';
    t.after(() => {
        if (enabledBefore === undefined) delete process.env.GARDA_UPDATE_CHECK; else process.env.GARDA_UPDATE_CHECK = enabledBefore;
    });
    await createUpdateAvailabilityService(repoRoot, {
        queryMetadata: async () => ({ version: '1.4.4', integrity: 'sha512-example' })
    }).check();
    const cacheFile = path.join(bundleRoot, 'runtime', 'update-availability', 'cache.json');
    const cached = fs.readFileSync(cacheFile, 'utf8');
    const server = await startLocalUiServer({ repoRoot, port: 0, actionsEnabled: false });
    t.after(() => cleanupLocalUiTestResources({ repoRoot, server }));
    const nativeFs = require('node:fs') as typeof fs;
    const originalStat = nativeFs.statSync;
    const originalRead = nativeFs.readFileSync;
    const originalExists = nativeFs.existsSync;
    const originalLstat = nativeFs.lstatSync;
    t.mock.method(nativeFs, 'existsSync', (...args: Parameters<typeof fs.existsSync>) => {
        assert.equal(String(args[0]).startsWith(bundleRoot), false, 'UI request thread cannot discover the bundle synchronously');
        return originalExists(...args);
    });
    t.mock.method(nativeFs, 'lstatSync', (...args: Parameters<typeof fs.lstatSync>) => {
        assert.equal(String(args[0]).startsWith(bundleRoot), false, 'UI request thread cannot inspect cache containment synchronously');
        return originalLstat(...args);
    });
    t.mock.method(nativeFs, 'statSync', (...args: Parameters<typeof fs.statSync>) => {
        assert.notEqual(path.basename(String(args[0])), '.npmrc', 'UI request thread cannot rediscover npm configuration synchronously');
        return originalStat(...args);
    });
    t.mock.method(nativeFs, 'readFileSync', (...args: Parameters<typeof fs.readFileSync>) => {
        assert.notEqual(String(args[0]), cacheFile, 'UI request thread cannot read the update cache synchronously');
        return originalRead(...args);
    });
    const getView = async (): Promise<{ status: string }> =>
        (await fetch(`${server.url}api/update-availability`)).json() as Promise<{ status: string }>;
    assert.equal((await getView()).status, 'available');
    fs.writeFileSync(cacheFile, JSON.stringify({ schema: 2, automaticBlockedUntil: Date.now() + UPDATE_CHECK_TTL_MS, entries: [] }));
    assert.equal((await getView()).status, 'unavailable', 'async presentation preserves the eviction cooldown');
    fs.writeFileSync(cacheFile, cached);
    fs.writeFileSync(path.join(bundleRoot, 'VERSION'), '1.4.4');
    assert.notEqual((await getView()).status, 'available', 'each GET reconstructs the installed version instead of retaining startup metadata');
});

test('browser notices render as text and manual error states follow the selected language', async () => {
    const nodes = new Map<string, Record<string, unknown>>();
    for (const id of ['update-panel', 'update-title', 'update-check', 'update-status', 'update-command', 'update-command-label', 'update-command-row']) {
        nodes.set(id, { textContent: '', hidden: false, disabled: false, setAttribute: () => undefined });
    }
    const context = { document: { getElementById: (id: string) => nodes.get(id) }, currentLanguage: 'ru', actionToken: 'token',
        fetch: async () => ({ ok: false, json: async () => ({}) }) };
    vm.runInNewContext(buildDashboardUpdatesClientScript() + '\ncurrentUpdateAvailability = {status:"available",currentVersion:"1.4.3",latestVersion:"<script>",updateCommand:"echo <unsafe>"}; renderUpdateAvailability();', context);
    assert.equal(nodes.get('update-command')?.textContent, 'echo <unsafe>');
    assert.ok(String(nodes.get('update-status')?.textContent).includes('<script>'));
    await vm.runInNewContext('refreshUpdateAvailability(true)', context);
    assert.equal(nodes.get('update-status')?.textContent, UPDATE_AVAILABILITY_TEXT.ru.error);
    assert.equal(nodes.get('update-check')?.disabled, false);
});
