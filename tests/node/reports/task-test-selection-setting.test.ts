import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildDefaultWorkflowConfig } from '../../../src/core/workflow-config';
import { getWorkflowSettingDefinition } from '../../../src/reports/workflow-setting-metadata';
import { buildUiSettingDefinitions } from '../../../src/reports/ui/actions/workflow-setting-actions';
import { LOCAL_UI_LANGUAGES, LOCAL_UI_SETTING_TEXT } from '../../../src/reports/ui/ui-i18n';
import { buildWorkflowSettingTextCatalog } from '../../../src/reports/ui/workflow-setting-text/catalog';

const ID = 'task-test-selection-require-operator-confirmation';

test('task test selection metadata exposes the existing guarded CLI setting and legacy default', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-selection-setting-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const configPath = path.join(root, 'garda-agent-orchestrator/live/config/workflow-config.json');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const config = buildDefaultWorkflowConfig();
    assert.equal(config.task_test_selection.require_operator_confirmation, false);
    const definition = getWorkflowSettingDefinition('task_test_selection.require_operator_confirmation')!;
    assert.equal(definition.id, ID);
    assert.equal(definition.flag, '--' + ID);
    assert.equal(definition.value_type, 'boolean');
    assert.deepEqual(definition.options.map(option => option.value), ['true', 'false']);
    for (const value of [undefined, false, true]) {
        const input: Record<string, unknown> = { ...config };
        if (value === undefined) delete input.task_test_selection;
        else input.task_test_selection = { require_operator_confirmation: value };
        fs.writeFileSync(configPath, JSON.stringify(input));
        const ui = buildUiSettingDefinitions(root).find(setting => setting.id === ID)!;
        assert.equal(ui.current_value, value === true);
        assert.equal(ui.confirmation_phrase, 'APPLY GARDA SETTING');
        assert.equal(ui.flag, '--' + ID);
    }
});

test('every shipped locale supplies the permission text and both choices', () => {
    const catalog = buildWorkflowSettingTextCatalog();
    assert.match(catalog[ID].description!, /Off by default/);
    assert.match(catalog[ID].description!, /Changing this setting still requires confirmation/);
    for (const language of LOCAL_UI_LANGUAGES) {
        const entry = LOCAL_UI_SETTING_TEXT[language.id][ID];
        assert.ok(entry?.label && entry.description, language.id);
        assert.deepEqual(Object.keys(entry.options!).sort(), ['false', 'true']);
        if (language.id !== 'en') {
            assert.notEqual(entry.label, catalog[ID].label, language.id);
            assert.notEqual(entry.description, catalog[ID].description, language.id);
        }
    }
});
