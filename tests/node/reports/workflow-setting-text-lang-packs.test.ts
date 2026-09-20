import test from 'node:test';
import assert from 'node:assert/strict';
import { LOCAL_UI_LANGUAGES, LOCAL_UI_SETTING_TEXT } from '../../../src/reports/ui';
import { buildWorkflowSettingTextCatalog, listWorkflowSettingTextCatalogIds } from '../../../src/reports/ui/workflow-setting-text/catalog';
import { loadWorkflowSettingTextTranslations } from '../../../src/reports/ui/workflow-setting-text/load-translations';
import { assertWorkflowSettingTextPackComplete, validateWorkflowSettingTextPack } from '../../../src/reports/ui/workflow-setting-text/validate';

const WORKFLOW_SETTING_TEXT_CATALOG = buildWorkflowSettingTextCatalog();
const EXPECTED_SETTING_IDS = listWorkflowSettingTextCatalogIds(WORKFLOW_SETTING_TEXT_CATALOG);

test('workflow setting text catalog covers every workflow setting definition plus compile-gate fallback', () => {
    assert.equal(EXPECTED_SETTING_IDS.length, 59);
    assert.ok(EXPECTED_SETTING_IDS.includes('compact-enabled'));
    assert.ok(EXPECTED_SETTING_IDS.includes('compact-workspace-bytes'));
    assert.ok(EXPECTED_SETTING_IDS.includes('compile-gate-command-fallback'));
    assert.ok(EXPECTED_SETTING_IDS.includes('optional-check-rule-management'));
    assert.ok(EXPECTED_SETTING_IDS.includes('full-suite-enabled'));
    assert.ok(EXPECTED_SETTING_IDS.includes('optional-checks-enabled'));
    assert.ok(EXPECTED_SETTING_IDS.includes('optional-checks-review-failure-cadence-interval'));
    assert.ok(EXPECTED_SETTING_IDS.includes('optional-skill-selection-mode'));
    assert.ok(EXPECTED_SETTING_IDS.includes('full-suite-timeout-blocker'));
    assert.ok(EXPECTED_SETTING_IDS.includes('full-suite-timeout-retry-count'));
    assert.ok(EXPECTED_SETTING_IDS.includes('scope-budget-warn-changed-lines'));
    assert.ok(EXPECTED_SETTING_IDS.includes('scope-budget-block-changed-lines'));
});

test('every non-English UI language has a complete workflow setting text pack', () => {
    const loaded = loadWorkflowSettingTextTranslations();
    const nonEnglishLanguages = LOCAL_UI_LANGUAGES.filter((language) => language.id !== 'en');

    assert.equal(Object.keys(loaded).length, nonEnglishLanguages.length);

    for (const language of nonEnglishLanguages) {
        const pack = loaded[language.id];
        assert.ok(pack, `missing workflow setting text pack for ${language.id}`);
        assertWorkflowSettingTextPackComplete(language.id, pack, WORKFLOW_SETTING_TEXT_CATALOG);
    }
});

test('LOCAL_UI_SETTING_TEXT exposes English catalog and imported translations', () => {
    assert.deepEqual(Object.keys(LOCAL_UI_SETTING_TEXT.en).sort(), EXPECTED_SETTING_IDS);
    assert.equal(
        LOCAL_UI_SETTING_TEXT.ru['full-suite-enabled'].options?.true?.description,
        'Настроенная команда полной проверки обязательна в жизненном цикле задачи.'
    );
    assert.equal(
        LOCAL_UI_SETTING_TEXT.de['full-suite-enabled'].options?.false?.label,
        'Aus'
    );
    assert.doesNotMatch(
        LOCAL_UI_SETTING_TEXT.uk['full-suite-enabled'].description || '',
        /Controls whether the configured full-suite/u
    );
});

test('excluded review type options are translated with human-readable labels', () => {
    assert.equal(LOCAL_UI_SETTING_TEXT.ru['review-cycle-excluded-review-types'].options?.code?.label, 'Ревью кода');
    assert.match(
        LOCAL_UI_SETTING_TEXT.ru['review-cycle-excluded-review-types'].description || '',
        /Множественный выбор/u
    );
    assert.equal(
        LOCAL_UI_SETTING_TEXT.ru['review-cycle-excluded-review-types'].options?.security?.label,
        'Ревью безопасности'
    );
    assert.equal(
        LOCAL_UI_SETTING_TEXT.ru['review-cycle-excluded-review-types'].options?.code?.description,
        undefined
    );
});

test('scope budget required review limit text names review types instead of lanes', () => {
    const english = LOCAL_UI_SETTING_TEXT.en['scope-budget-max-required-reviews'];
    assert.equal(english.label, 'Mandatory review type limit');
    assert.match(english.description || '', /distinct review types required by the current preflight/u);
    assert.match(english.description || '', /Disabled review capabilities do not become mandatory/u);

    const russian = LOCAL_UI_SETTING_TEXT.ru['scope-budget-max-required-reviews'];
    assert.equal(russian.label, 'Лимит обязательных типов ревью');
    assert.match(russian.description || '', /Выключенный тип ревью не становится обязательным/u);

    for (const [languageId, pack] of Object.entries(LOCAL_UI_SETTING_TEXT)) {
        const setting = pack['scope-budget-max-required-reviews'];
        assert.doesNotMatch(
            `${setting.label} ${setting.description}`,
            /review[- ]?lanes?/iu,
            `${languageId} still describes the required-review limit as review lanes`
        );
    }
});

test('optional skill selection text treats legacy modes as compatibility aliases', () => {
    const english = LOCAL_UI_SETTING_TEXT.en['optional-skill-selection-mode'];
    assert.match(english.description || '', /off, optional, or mandatory/u);
    assert.match(english.options?.advisory?.label || '', /advisory -> optional/u);
    assert.match(english.options?.required?.label || '', /required -> mandatory/u);
    assert.match(english.options?.strict?.label || '', /strict -> mandatory/u);

    for (const [languageId, pack] of Object.entries(LOCAL_UI_SETTING_TEXT)) {
        const setting = pack['optional-skill-selection-mode'];
        assert.ok(setting.options?.advisory, `${languageId} lacks advisory compatibility text`);
        assert.ok(setting.options?.required, `${languageId} lacks required compatibility text`);
        assert.ok(setting.options?.strict, `${languageId} lacks strict compatibility text`);
        assert.doesNotMatch(
            setting.description || '',
            /off, advisory, or mandatory|aus, beratend oder verpflichtend|adviserende of verplicht/u,
            `${languageId} still presents advisory as a primary mode`
        );
    }
});

test('scope budget tiered threshold text names warning and blocking states', () => {
    const warnLines = LOCAL_UI_SETTING_TEXT.en['scope-budget-warn-changed-lines'];
    const blockLines = LOCAL_UI_SETTING_TEXT.en['scope-budget-block-changed-lines'];
    assert.match(warnLines.label ?? '', /warning/i);
    assert.match(warnLines.description ?? '', /WARN/u);
    assert.match(warnLines.description ?? '', /continuation remains allowed/u);
    assert.match(blockLines.label ?? '', /block/i);
    assert.match(blockLines.description ?? '', /BLOCK/u);
    assert.match(blockLines.description ?? '', /split-required/u);
});

test('scope budget legacy action text does not imply blocking is disabled', () => {
    const english = LOCAL_UI_SETTING_TEXT.en['scope-budget-action'];
    assert.equal(english.label, 'Legacy max mapping mode');
    assert.match(english.description || '', /does not disable blocking/u);
    assert.equal(english.options?.WARN_ONLY?.label, 'Legacy max maps to warn');
    assert.match(english.options?.WARN_ONLY?.description || '', /block_\* thresholds still block/u);

    for (const [languageId, pack] of Object.entries(LOCAL_UI_SETTING_TEXT)) {
        const action = pack['scope-budget-action'];
        assert.doesNotMatch(
            `${action.label} ${action.description} ${action.options?.WARN_ONLY?.label} ${action.options?.WARN_ONLY?.description}`,
            /Warn only|does not stop|не останавливает|no bloquea|sans effet bloquant/iu,
            `${languageId} still presents scope_budget_guard.action as a non-blocking mode`
        );
    }
});

test('workflow setting text packs do not contain unexpected setting ids', () => {
    for (const [languageId, pack] of Object.entries(loadWorkflowSettingTextTranslations())) {
        const issues = validateWorkflowSettingTextPack(languageId, pack, WORKFLOW_SETTING_TEXT_CATALOG);
        const unexpected = issues.filter((issue) => issue.reason === 'unexpected extra setting translation');
        assert.deepEqual(unexpected, [], `${languageId} has unexpected setting ids`);
    }
});
