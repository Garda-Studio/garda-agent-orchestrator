import test from 'node:test';
import assert from 'node:assert/strict';
import * as vm from 'node:vm';
import { buildDashboardClientPrelude } from '../../../src/reports/ui/dashboard/dashboard-client-prelude';
import { renderDashboardBodyMarkup, renderDashboardPlanModalMarkup } from '../../../src/reports/ui/dashboard/render-dashboard-markup';
import { renderLocalUiHtml } from '../../../src/reports/ui/ui-dashboard-html';
import type { LocalUiTextKey } from '../../../src/reports/ui/ui-i18n';
import { UPDATE_AVAILABILITY_TEXT } from '../../../src/reports/ui/update-availability-text';

const uiI18n = require('../../../src/reports/ui/ui-i18n') as typeof import('../../../src/reports/ui/ui-i18n');
const HOSTILE_TEXT = '<img id="translation-injection" title=\'x\'>&';
const ENCODED_TEXT = '&lt;img id=&quot;translation-injection&quot; title=&#39;x&#39;&gt;&amp;';
const SCRIPT_TEXT = '</ScRiPt><script>globalThis.translationInjection = true;</script><!-- & " \' \u2028\u2029';
const PACK_BINDINGS: Readonly<Record<string, string>> = {
    LOCAL_UI_TEXT: 'languagePacks',
    LOCAL_UI_SETTING_TEXT: 'settingTextPacks',
    LOCAL_UI_ACTION_TEXT: 'actionTextPacks',
    LOCAL_UI_INIT_SETTING_TEXT: 'initSettingTextPacks',
    LOCAL_UI_CLEANUP_SETTING_TEXT: 'cleanupSettingTextPacks',
    LOCAL_UI_BACKUPS_TAB_TEXT: 'backupsTabTextPacks',
    LOCAL_UI_PROJECT_MEMORY_STATUS_TEXT: 'projectMemoryStatusTextPacks',
    LOCAL_UI_PROJECT_MEMORY_TEXT: 'projectMemoryTextPacks',
    LOCAL_UI_ACTION_CATEGORY_TEXT: 'actionCategoryTextPacks',
    LOCAL_UI_INSTRUCTION_TEXT: 'instructionTextPacks',
    LOCAL_UI_TASK_CLOSURE_POLICY_TEXT: 'taskClosurePolicyTextPacks',
    LOCAL_UI_LANGUAGES: 'languageMetadata'
};

function readPreludeValues(script: string): Record<string, unknown> {
    const bindings = [...Object.values(PACK_BINDINGS), 'actionToken', 'actionsEnabled', 'initialLanguage'];
    const json = vm.runInNewContext(`${script}\nJSON.stringify({${bindings.join(',')}});`, {
        document: { getElementById: () => null }
    }) as string;
    return JSON.parse(json) as Record<string, unknown>;
}

function withPackExports<T>(overrides: Record<string, unknown>, run: () => T): T {
    const descriptors = new Map<string, PropertyDescriptor>();
    try {
        for (const [name, value] of Object.entries(overrides)) {
            const descriptor = Object.getOwnPropertyDescriptor(uiI18n, name);
            assert.ok(descriptor?.configurable, `Expected configurable CommonJS export ${name}`);
            descriptors.set(name, descriptor);
            Object.defineProperty(uiI18n, name, { ...descriptor, value });
        }
        return run();
    } finally {
        for (const [name, descriptor] of descriptors) {
            Object.defineProperty(uiI18n, name, descriptor);
        }
    }
}

function elementText(markup: string, id: string): string {
    const match = new RegExp(`<([a-z0-9]+)\\b[^>]*\\bid="${id}"[^>]*>([\\s\\S]*?)</\\1>`, 'u').exec(markup);
    assert.ok(match, `Missing element ${id}`);
    return match[2];
}

test('dashboard body treats translated labels, notices and quoted attributes as text', () => {
    const text = {
        ...uiI18n.LOCAL_UI_TEXT.en,
        appTitle: HOSTILE_TEXT,
        noticeActionsEnabled: HOSTILE_TEXT,
        noticeActionsDisabled: HOSTILE_TEXT,
        searchTasks: HOSTILE_TEXT
    };
    for (const enabled of [true, false]) {
        const markup = renderDashboardBodyMarkup(text, enabled);
        assert.ok(markup.includes(`<h1 data-i18n="appTitle">${ENCODED_TEXT}</h1>`));
        assert.equal(elementText(markup, 'ui-notice'), ENCODED_TEXT);
        assert.ok(markup.includes(`placeholder="${ENCODED_TEXT}" data-i18n-placeholder="searchTasks"`));
        assert.ok(!markup.includes('<img'));
        assert.ok(markup.includes('<span class="language-icon" aria-hidden="true">&#127760;</span>'));
        assert.ok(markup.includes('<table>'));
    }
});

test('task plan modal translates plain text while retaining its dialog shell', () => {
    const markup = renderDashboardPlanModalMarkup({ ...uiI18n.LOCAL_UI_TEXT.en, taskPlanTitle: HOSTILE_TEXT, close: HOSTILE_TEXT });
    assert.equal(elementText(markup, 'plan-modal-title'), ENCODED_TEXT);
    assert.equal(elementText(markup, 'plan-modal-close'), ENCODED_TEXT);
    assert.ok(markup.includes('role="dialog" aria-modal="true" aria-labelledby="plan-modal-title"'));
    assert.ok(!markup.includes('<img'));
});

test('notice values containing placeholder syntax remain literal translated data', () => {
    const literal = 'Keep ${text.appTitle} and ${text.close} as text.';
    const text = { ...uiI18n.LOCAL_UI_TEXT.en, noticeActionsEnabled: literal, noticeActionsDisabled: literal };
    for (const enabled of [true, false]) {
        assert.equal(elementText(renderDashboardBodyMarkup(text, enabled), 'ui-notice'), literal);
    }
});

test('missing and null text placeholders preserve their empty-string behavior', () => {
    const text = { ...uiI18n.LOCAL_UI_TEXT.en } as Partial<Record<LocalUiTextKey, string | null>>;
    delete text.searchTasks;
    text.chooseTask = null;
    const markup = renderDashboardBodyMarkup(text as Readonly<Record<LocalUiTextKey, string>>, false);
    assert.ok(markup.includes('placeholder="" data-i18n-placeholder="searchTasks"'));
    assert.equal(elementText(markup, 'detail'), '<p class="empty" data-i18n="chooseTask"></p>');
});

test('malformed inline script options cannot escape the HTML script and round-trip exactly', () => {
    assert.ok(!/[<>&\u2028\u2029]/u.test(buildDashboardClientPrelude({ actionToken: SCRIPT_TEXT, actionsEnabled: true, initialLanguage: SCRIPT_TEXT })));
    for (const enabled of [true, false]) {
        const script = buildDashboardClientPrelude({ actionToken: SCRIPT_TEXT, actionsEnabled: enabled, initialLanguage: SCRIPT_TEXT });
        assert.ok(!/[<>&\u2028\u2029]/u.test(script));
        const values = readPreludeValues(script);
        assert.equal(values.actionToken, SCRIPT_TEXT);
        assert.equal(values.initialLanguage, SCRIPT_TEXT);
        assert.equal(values.actionsEnabled, enabled);
    }
});

test('malformed nested strings cannot escape any serialized pack or language metadata', () => {
    const overrides: Record<string, unknown> = {};
    for (const name of Object.keys(PACK_BINDINGS)) {
        const original = (uiI18n as unknown as Record<string, unknown>)[name];
        overrides[name] = name === 'LOCAL_UI_LANGUAGES'
            ? [...uiI18n.LOCAL_UI_LANGUAGES, { id: 'synthetic', label: SCRIPT_TEXT, nativeLabel: SCRIPT_TEXT }]
            : { ...(original as Record<string, unknown>), synthetic: { label: SCRIPT_TEXT, nested: { description: SCRIPT_TEXT } } };
    }
    const script = withPackExports(overrides, () => buildDashboardClientPrelude({ actionToken: 'fixture-token', actionsEnabled: true, initialLanguage: 'en' }));
    assert.ok(!/[<>&\u2028\u2029]/u.test(script));
    const values = readPreludeValues(script);
    for (const [name, binding] of Object.entries(PACK_BINDINGS)) {
        assert.deepEqual(values[binding], overrides[name], `${name} must survive serialization unchanged`);
    }
});

test('all shipped languages retain their complete runtime catalogs and dashboard structure', () => {
    for (const language of uiI18n.LOCAL_UI_LANGUAGES) {
        const values = readPreludeValues(buildDashboardClientPrelude({ actionToken: 'fixture-token', actionsEnabled: true, initialLanguage: language.id }));
        for (const [name, binding] of Object.entries(PACK_BINDINGS)) {
            assert.deepEqual(values[binding], (uiI18n as unknown as Record<string, unknown>)[name]);
        }
        const html = renderLocalUiHtml(true, 'fixture-token', language.id);
        assert.ok(html.includes(`<html lang="${language.id}">`));
        assert.equal((html.match(/<script\b/giu) || []).length, 2);
        assert.ok(html.includes('id="task-search"'));
        assert.ok(html.includes('id="plan-modal"'));
        assert.ok(!/\$\{text\./u.test(html));
    }
});

test('malformed title and translated attributes cannot escape the initial HTML document', () => {
    const title = '</title><script>globalThis.titleInjection = true;</script>&"\'';
    const text = { ...uiI18n.LOCAL_UI_TEXT.en, appTitle: title, searchTasks: HOSTILE_TEXT, taskPlanTitle: HOSTILE_TEXT, close: HOSTILE_TEXT };
    const html = withPackExports({ LOCAL_UI_TEXT: { ...uiI18n.LOCAL_UI_TEXT, en: text } }, () => renderLocalUiHtml(true, SCRIPT_TEXT, 'en'));
    assert.ok(html.includes('<title>&lt;/title&gt;&lt;script&gt;globalThis.titleInjection = true;&lt;/script&gt;&amp;&quot;&#39;</title>'));
    assert.ok(html.includes(`placeholder="${ENCODED_TEXT}" data-i18n-placeholder="searchTasks"`));
    assert.equal(elementText(html, 'plan-modal-title'), ENCODED_TEXT);
    assert.equal(elementText(html, 'plan-modal-close'), ENCODED_TEXT);
    assert.equal((html.match(/<script\b/giu) || []).length, 2);
    assert.equal((html.match(/<\/script\s*>/giu) || []).length, 2);
    assert.ok(!html.includes('<script>globalThis.'));
});

test('malformed language identifiers cannot escape the quoted HTML lang attribute', () => {
    const languageId = 'synthetic" data-language-injection="yes';
    let html: string;
    UPDATE_AVAILABILITY_TEXT[languageId] = UPDATE_AVAILABILITY_TEXT.en;
    try {
        html = withPackExports({
            LOCAL_UI_LANGUAGES: [...uiI18n.LOCAL_UI_LANGUAGES, { id: languageId, label: 'Synthetic', nativeLabel: 'Synthetic' }],
            LOCAL_UI_TEXT: { ...uiI18n.LOCAL_UI_TEXT, [languageId]: uiI18n.LOCAL_UI_TEXT.en }
        }, () => renderLocalUiHtml(false, 'fixture-token', languageId));
    } finally {
        delete UPDATE_AVAILABILITY_TEXT[languageId];
    }
    assert.ok(html.includes('<html lang="synthetic&quot; data-language-injection=&quot;yes">'));
    assert.ok(!html.includes('<html lang="synthetic" data-language-injection="yes">'));
});
