import test from 'node:test';
import assert from 'node:assert/strict';

import { buildWorkflowSettingMetadata } from '../../../src/core/workflow-setting-metadata';
import {
    createWorkflowSettingRegistry,
    type WorkflowSettingManifestEntry,
    type WorkflowSettingUiControl,
    type WorkflowSettingValue,
    type WorkflowSettingValueType
} from '../../../src/core/workflow-setting-manifest';
import { COMPACT_SETTING_REGISTRY } from '../../../src/core/compact/setting-definitions';

function setting(
    valueType: WorkflowSettingValueType,
    defaultValue: WorkflowSettingValue,
    control: WorkflowSettingUiControl
): WorkflowSettingManifestEntry {
    const id = valueType.replaceAll('_', '-');
    return {
        id: `example-${id}`, key: `example.${valueType}`, owner: { kind: 'workflow', section: 'example' },
        value_type: valueType, exposure: 'operator-visible', default_value: defaultValue,
        validate: (value): value is WorkflowSettingValue => (
            Array.isArray(defaultValue) ? Array.isArray(value) : typeof value === typeof defaultValue
        ),
        cli: { flag: `--example-${id}` },
        ui: { group: 'example', label: id, description: `Describe the ${id} setting.`, control },
        materialize: value => [{ path: `example.${valueType}`, value }]
    };
}

test('metadata projection preserves all existing value types and definition order without extra authority fields', () => {
    const entries = [
        setting('string_list', ['first'], 'text_list'),
        setting('boolean', false, 'checkbox'),
        setting('enum', 'balanced', 'select'),
        setting('integer', 0, 'number'),
        setting('enum_list', ['code'], 'select'),
        setting('string', 'value', 'text')
    ];
    const registry = createWorkflowSettingRegistry(entries);
    const result = buildWorkflowSettingMetadata(registry);

    assert.deepEqual(result.map(entry => entry.value_type), ['string_list', 'boolean', 'enum', 'integer', 'enum_list', 'string']);
    assert.deepEqual(result.map(entry => entry.id), entries.map(entry => entry.id));
    assert.deepEqual(result.map(entry => Object.keys(entry)), entries.map(() => (
        ['id', 'key', 'label', 'description', 'flag', 'value_type', 'options']
    )));
    assert.deepEqual(result.map(entry => entry.options), entries.map(() => []));
    assert.ok(Object.isFrozen(result));
    assert.deepEqual(buildWorkflowSettingMetadata(COMPACT_SETTING_REGISTRY).map(entry => entry.id), COMPACT_SETTING_REGISTRY.entries.map(entry => entry.id));
});

test('metadata projection keeps optional legacy fields and independently mutable option copies', () => {
    const definition = setting('enum', 'balanced', 'select');
    definition.ui = { ...definition.ui, options: [
        { value: 'balanced', label: 'Balanced', description: 'Use balanced validation.' },
        { value: 'strict', label: 'Strict', description: 'Use strict validation.' }
    ], placeholder: 'Choose a profile', editable: false };
    const integer = setting('integer', 0, 'number');
    integer.ui = { ...integer.ui, min: 0, max: 5, editable: true };
    const registry = createWorkflowSettingRegistry([definition, integer]);
    const first = buildWorkflowSettingMetadata(registry);

    assert.deepEqual(first[0], {
        id: 'example-enum', key: 'example.enum', label: 'enum', description: 'Describe the enum setting.',
        flag: '--example-enum', value_type: 'enum', options: definition.ui.options,
        placeholder: 'Choose a profile', editable: false
    });
    assert.equal(first[1].min, 0);
    assert.equal(first[1].max, 5);
    assert.equal(first[1].editable, true);
    first[0].options[0].label = 'Caller-owned label';
    first[0].options.push({ value: 'foreign', label: 'Foreign', description: 'Caller-owned addition.' });
    assert.deepEqual(buildWorkflowSettingMetadata(registry)[0].options.map(option => option.label), ['Balanced', 'Strict']);
    assert.equal(registry.require(definition.id).ui.options?.length, 2);
});

test('metadata projection never invokes setting hooks or enables generic catalog and review-lane editing', () => {
    let validationCalls = 0;
    let materializationCalls = 0;
    const definition = setting('boolean', true, 'checkbox');
    definition.validate = (value): value is boolean => { validationCalls += 1; return typeof value === 'boolean'; };
    definition.materialize = value => { materializationCalls += 1; return [{ path: 'example.boolean', value }]; };
    const catalog = { ...setting('enum', 'balanced', 'select'), owner: { kind: 'catalog-backed' as const, catalog: 'review' as const, entry_id: 'architecture' } };
    catalog.ui = { ...catalog.ui, editable: true };
    const lane = { ...setting('integer', 1, 'number'), owner: { kind: 'review-lane' as const, lane_id: 'security' } };
    const registry = createWorkflowSettingRegistry([definition, catalog, lane]);
    validationCalls = 0;
    const projected = buildWorkflowSettingMetadata(registry);

    assert.deepEqual({ validationCalls, materializationCalls }, { validationCalls: 0, materializationCalls: 0 });
    assert.equal(projected[0].editable, undefined);
    assert.equal(projected[1].editable, false);
    assert.equal(projected[2].editable, false);
    assert.ok(projected.every(entry => !Object.hasOwn(entry, 'default_value') && !Object.hasOwn(entry, 'owner') && !Object.hasOwn(entry, 'validate') && !Object.hasOwn(entry, 'materialize')));
    assert.throws(() => registry.validate(definition.id, 'true'), /Invalid value/u);
});
