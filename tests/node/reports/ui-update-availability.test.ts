import test from 'node:test';
import assert from 'node:assert/strict';
import * as vm from 'node:vm';
import { startLocalUiServer } from '../../../src/reports/ui/local-ui-server';
import { buildDashboardUpdatesClientScript } from '../../../src/reports/ui/dashboard/dashboard-client-updates';
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
    release();
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
