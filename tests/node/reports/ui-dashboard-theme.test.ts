import test from 'node:test';
import assert from 'node:assert/strict';
import * as vm from 'node:vm';
import { UI_DASHBOARD_POLISH_STYLES } from '../../../src/reports/ui/dashboard/dashboard-polish-styles';
import { UI_DASHBOARD_STYLES } from '../../../src/reports/ui/dashboard/dashboard-styles';
import {
    UI_DASHBOARD_DARK_THEME_STYLES,
    UI_DASHBOARD_REFRESH_STYLES,
    UI_DASHBOARD_THEME_HEAD_SCRIPT,
    UI_THEME_STORAGE_KEY
} from '../../../src/reports/ui/dashboard/dashboard-theme';
import { renderLocalUiHtml } from '../../../src/reports/ui/ui-dashboard-html';
import { LOCAL_UI_LANGUAGES, LOCAL_UI_TEXT } from '../../../src/reports/ui/ui-i18n';
import { UPDATE_AVAILABILITY_STYLES } from '../../../src/reports/ui/ui-update-availability';

function declaredTokens(css: string, selector: RegExp): Set<string> {
    const tokens = new Set<string>();
    for (const block of css.matchAll(new RegExp(`${selector.source}\\s*\\{([^}]*)\\}`, 'gu'))) {
        for (const declaration of block[1].matchAll(/(--[a-z0-9-]+)\s*:/gu)) {
            tokens.add(declaration[1]);
        }
    }
    return tokens;
}

function usedTokens(css: string): Set<string> {
    return new Set([...css.matchAll(/var\((--[a-z0-9-]+)\)/gu)].map((match) => match[1]));
}

function runThemeHeadScript(stored: string | null): { theme: string | null; mode: string | null } {
    const attributes = new Map<string, string>();
    const context = {
        window: {
            localStorage: { getItem: (key: string) => (key === UI_THEME_STORAGE_KEY ? stored : null) }
        },
        document: {
            documentElement: { setAttribute: (name: string, value: string) => attributes.set(name, value) }
        }
    };
    vm.runInNewContext(UI_DASHBOARD_THEME_HEAD_SCRIPT, context);
    return { theme: attributes.get('data-theme') ?? null, mode: attributes.get('data-theme-mode') ?? null };
}

test('every color token used by the dashboard is defined for light and overridden for dark', () => {
    const allStyles = [UI_DASHBOARD_STYLES, UI_DASHBOARD_POLISH_STYLES, UPDATE_AVAILABILITY_STYLES, UI_DASHBOARD_REFRESH_STYLES].join('\n');
    const lightTokens = new Set([
        ...declaredTokens(UI_DASHBOARD_STYLES, /:root/u),
        ...declaredTokens(UI_DASHBOARD_REFRESH_STYLES, /:root/u)
    ]);
    const darkTokens = declaredTokens(UI_DASHBOARD_DARK_THEME_STYLES, /:root\[data-theme="dark"\]/u);
    const themeIndependentTokens = new Set(['--font-ui', '--font-mono']);

    for (const token of usedTokens(allStyles)) {
        assert.ok(lightTokens.has(token), `${token} is used but has no light value`);
    }
    for (const token of lightTokens) {
        if (themeIndependentTokens.has(token)) continue;
        assert.ok(darkTokens.has(token), `${token} has no dark theme value`);
    }
});

test('dashboard styles keep colors in tokens instead of literal values', () => {
    const ruleBodies = [UI_DASHBOARD_STYLES, UI_DASHBOARD_POLISH_STYLES]
        .join('\n')
        .replace(/:root\s*\{[^}]*\}/u, '');
    assert.doesNotMatch(ruleBodies, /(?:^|[\s:;])(?:#[0-9a-fA-F]{3,8}\b|rgba?\()/u);
});

test('theme head script applies an explicit choice and leaves System to the media query', () => {
    assert.deepEqual(runThemeHeadScript('dark'), { theme: 'dark', mode: 'dark' });
    assert.deepEqual(runThemeHeadScript('light'), { theme: 'light', mode: 'light' });
    assert.deepEqual(runThemeHeadScript('system'), { theme: null, mode: 'system' });
    assert.deepEqual(runThemeHeadScript(null), { theme: null, mode: 'system' });
    assert.deepEqual(runThemeHeadScript('neon'), { theme: null, mode: 'system' });
});

test('local UI renders the theme selector and applies the theme before the body', () => {
    const html = renderLocalUiHtml(false, 'theme-token', 'en');
    const head = html.slice(0, html.indexOf('<body>'));

    assert.match(head, /:root\[data-theme="dark"\] \{ color-scheme: dark;/u);
    assert.match(head, /@media \(prefers-color-scheme: dark\) \{\n:root:not\(\[data-theme="light"\]\) \{ color-scheme: dark;/u);
    assert.match(head, /<script data-garda-theme-boot>\s*\(function \(\) \{[\s\S]*data-theme-mode/u);
    assert.doesNotMatch(head, /<script>/u);
    assert.match(html, /<select id="theme-select" data-i18n-aria-label="themeTitle">/u);
    assert.match(html, /<option value="system" data-i18n="themeSystem">Match system<\/option>/u);
    assert.match(html, /<option value="light" data-i18n="themeLight">Light<\/option>/u);
    assert.match(html, /<option value="dark" data-i18n="themeDark">Dark<\/option>/u);
    assert.match(html, /function applyThemeMode\(mode\)/u);
});

test('theme selector labels are translated in every UI language pack', () => {
    for (const language of LOCAL_UI_LANGUAGES) {
        const text = LOCAL_UI_TEXT[language.id];
        for (const key of ['themeTitle', 'themeSystem', 'themeLight', 'themeDark'] as const) {
            assert.ok(text[key]?.trim(), `missing ${key} for ${language.id}`);
        }
    }
    assert.equal(LOCAL_UI_TEXT.de.themeDark, 'Dunkel');
    assert.equal(LOCAL_UI_TEXT.ru.themeSystem, 'Как в системе');
});
