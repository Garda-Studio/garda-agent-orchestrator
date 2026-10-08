import test from 'node:test';
import assert from 'node:assert/strict';

import {
    createWorkflowSettingRegistry,
    type WorkflowSettingManifestEntry,
    type WorkflowSettingUiControl,
    type WorkflowSettingValueByType,
    type WorkflowSettingValueType
} from '../../../src/core/workflow-setting-manifest';

function booleanSetting(
    overrides: Partial<WorkflowSettingManifestEntry<'boolean'>> = {}
): WorkflowSettingManifestEntry<'boolean'> {
    return {
        id: 'full-suite-enabled',
        key: 'full_suite_validation.enabled',
        owner: { kind: 'workflow', section: 'full-suite-validation' },
        value_type: 'boolean',
        exposure: 'operator-visible',
        default_value: true,
        validate: (value: unknown): value is boolean => typeof value === 'boolean',
        cli: { flag: '--full-suite' },
        ui: {
            group: 'full-suite',
            label: 'Full suite',
            description: 'Run the bounded mandatory full-suite command.',
            control: 'checkbox'
        },
        materialize: (value) => [{ path: 'full_suite_validation.enabled', value }],
        ...overrides
    };
}

function typedSetting<TValueType extends WorkflowSettingValueType>(
    valueType: TValueType,
    defaultValue: WorkflowSettingValueByType[TValueType],
    control: WorkflowSettingUiControl,
    validate: (value: unknown) => value is WorkflowSettingValueByType[TValueType]
): WorkflowSettingManifestEntry<TValueType> {
    const stableId = valueType.replaceAll('_', '-');
    return {
        id: `${stableId}-setting`,
        key: `value_types.${valueType}`,
        owner: { kind: 'workflow', section: 'value-types' },
        value_type: valueType,
        exposure: 'operator-visible',
        default_value: defaultValue,
        validate,
        cli: { flag: `--${stableId}-setting` },
        ui: {
            group: 'value-types',
            label: `${valueType} setting`,
            description: `Configure a ${valueType} workflow setting.`,
            control
        },
        materialize: (value) => [{ path: `value_types.${valueType}`, value }]
    };
}

test('workflow-setting registry binds typed defaults, metadata, validation, and materialization', () => {
    const registry = createWorkflowSettingRegistry([booleanSetting()]);
    const entry = registry.require('full-suite-enabled');

    assert.equal(entry.default_value, true);
    assert.equal(entry.owner.kind, 'workflow');
    assert.equal(entry.cli.flag, '--full-suite');
    assert.equal(entry.ui.control, 'checkbox');
    assert.equal(registry.validate(entry.id, false), false);
    assert.deepEqual(registry.materialize(entry.id, false, { target: 'live' }), [
        { path: 'full_suite_validation.enabled', value: false }
    ]);
    assert.ok(Object.isFrozen(registry));
    assert.ok(Object.isFrozen(registry.entries));
    assert.ok(Object.isFrozen(entry));
});

test('workflow-setting registry supports catalog references and per-lane ownership without catalog definitions', () => {
    const registry = createWorkflowSettingRegistry([
        booleanSetting({
            id: 'architecture-review-enabled',
            key: 'review_policy.architecture.enabled',
            owner: { kind: 'catalog-backed', catalog: 'review', entry_id: 'architecture' },
            cli: { flag: '--review-architecture-enabled' },
            materialize: (value) => [{ path: 'review_policy.architecture.enabled', value }]
        }),
        booleanSetting({
            id: 'security-delta-enabled',
            key: 'review_policy.security.delta_enabled',
            owner: { kind: 'review-lane', lane_id: 'security' },
            cli: { flag: '--security-delta-enabled' },
            materialize: (value) => [{ path: 'review_policy.security.delta_enabled', value }]
        })
    ]);

    assert.deepEqual(registry.require('architecture-review-enabled').owner, {
        kind: 'catalog-backed',
        catalog: 'review',
        entry_id: 'architecture'
    });
    assert.deepEqual(registry.require('security-delta-enabled').owner, {
        kind: 'review-lane',
        lane_id: 'security'
    });
});

test('workflow-setting registry binds every declared value type to a compatible UI control', () => {
    assert.doesNotThrow(() => createWorkflowSettingRegistry([
        typedSetting('boolean', true, 'checkbox', (value): value is boolean => typeof value === 'boolean'),
        typedSetting('integer', 1, 'number', (value): value is number => Number.isSafeInteger(value)),
        typedSetting('enum', 'balanced', 'select', (value): value is string => typeof value === 'string'),
        typedSetting(
            'enum_list',
            ['code'],
            'select',
            (value): value is readonly string[] => Array.isArray(value) && value.every((item) => typeof item === 'string')
        ),
        typedSetting('string', 'value', 'text', (value): value is string => typeof value === 'string'),
        typedSetting(
            'string_list',
            ['value'],
            'text_list',
            (value): value is readonly string[] => Array.isArray(value) && value.every((item) => typeof item === 'string')
        )
    ]));
    assert.throws(
        () => createWorkflowSettingRegistry([booleanSetting({
            ui: {
                group: 'full-suite',
                label: 'Full suite',
                description: 'Run the bounded mandatory full-suite command.',
                control: 'number'
            }
        })]),
        /ui\.control is incompatible with value_type/u
    );
});

test('workflow-setting registry rejects duplicate ids, keys, and CLI flags, including case drift', () => {
    assert.throws(
        () => createWorkflowSettingRegistry([
            booleanSetting(),
            booleanSetting({ key: 'other.enabled', cli: { flag: '--other-enabled' } })
        ]),
        /duplicate or case-drifted id/u
    );
    assert.throws(
        () => createWorkflowSettingRegistry([
            booleanSetting(),
            booleanSetting({ id: 'FULL-SUITE-ENABLED', key: 'other.enabled', cli: { flag: '--other-enabled' } })
        ]),
        /stable lowercase kebab-case/u
    );
    assert.throws(
        () => createWorkflowSettingRegistry([
            booleanSetting(),
            booleanSetting({ id: 'other-setting', cli: { flag: '--other-enabled' } })
        ]),
        /duplicate or case-drifted key/u
    );
    assert.throws(
        () => createWorkflowSettingRegistry([
            booleanSetting(),
            booleanSetting({ id: 'other-setting', key: 'other.enabled' })
        ]),
        /duplicate or case-drifted CLI flag/u
    );
});

test('workflow-setting registry rejects invalid defaults and secret-bearing contracts', () => {
    assert.throws(
        () => createWorkflowSettingRegistry([booleanSetting({ default_value: 'yes' as unknown as boolean })]),
        /default_value must satisfy/u
    );
    assert.throws(
        () => createWorkflowSettingRegistry([booleanSetting({
            id: 'api-token',
            key: 'credentials.api_token',
            cli: { flag: '--api-token' }
        })]),
        /cannot register secret-bearing settings/u
    );
    assert.throws(
        () => createWorkflowSettingRegistry([booleanSetting({
            id: 'ssh-key-material',
            key: 'credentials.private_key',
            cli: { flag: '--ssh-key-material' }
        })]),
        /cannot register secret-bearing settings/u
    );
    assert.throws(
        () => createWorkflowSettingRegistry([booleanSetting({
            id: 'remote-access-enabled',
            key: 'remote_access.enabled',
            cli: { flag: '--api-key' }
        })]),
        /cannot register secret-bearing settings/u
    );
    assert.throws(
        () => createWorkflowSettingRegistry([booleanSetting({
            id: 'remote-access-enabled',
            key: 'remote_access.enabled',
            cli: { flag: '--remote-access-enabled', value_name: 'API_KEY' }
        })]),
        /cannot register secret-bearing settings/u
    );
    for (const key of ['credentials.api_key', 'credentials.access_key', 'credentials.bearer']) {
        assert.throws(
            () => createWorkflowSettingRegistry([booleanSetting({
                id: 'remote-access-enabled',
                key,
                cli: { flag: '--remote-access-enabled' }
            })]),
            /cannot register secret-bearing settings/u
        );
    }
    assert.throws(
        () => createWorkflowSettingRegistry([{
            ...booleanSetting(),
            value_type: 'string',
            default_value: true,
            validate: (_value: unknown): _value is string => true
        } as unknown as WorkflowSettingManifestEntry]),
        /default_value must satisfy its declared value_type/u
    );
});

test('workflow-setting registry rejects sparse declared list values', () => {
    const sparseDefault = new Array<string>(1);
    assert.throws(
        () => createWorkflowSettingRegistry([typedSetting(
            'string_list',
            sparseDefault,
            'text_list',
            (value): value is readonly string[] => (
                Array.isArray(value) && value.every((item) => typeof item === 'string')
            )
        )]),
        /default_value must satisfy/u
    );

    const registry = createWorkflowSettingRegistry([typedSetting(
        'enum_list',
        ['code'],
        'select',
        (value): value is readonly string[] => (
            Array.isArray(value) && value.every((item) => typeof item === 'string')
        )
    )]);
    assert.throws(() => registry.validate('enum-list-setting', new Array<string>(1)), /Invalid value/u);
});

test('workflow-setting registry fails closed for invalid values and unsafe materialization hooks', () => {
    const invalidValueRegistry = createWorkflowSettingRegistry([booleanSetting()]);
    assert.throws(() => invalidValueRegistry.validate('full-suite-enabled', 'false'), /Invalid value/u);
    assert.throws(() => invalidValueRegistry.require('missing-setting'), /Unknown workflow setting/u);
    const permissiveValidatorRegistry = createWorkflowSettingRegistry([booleanSetting({
        validate: (_value: unknown): _value is boolean => true
    })]);
    assert.throws(() => permissiveValidatorRegistry.validate('full-suite-enabled', 'false'), /Invalid value/u);
    assert.throws(
        () => invalidValueRegistry.materialize(
            'full-suite-enabled',
            true,
            { target: 'preview' } as unknown as { target: 'live' | 'template' }
        ),
        /target must be 'live' or 'template'/u
    );

    const unsafeRegistry = createWorkflowSettingRegistry([booleanSetting({
        materialize: (value) => [{ path: 'credentials.secret', value }]
    })]);
    assert.throws(
        () => unsafeRegistry.materialize('full-suite-enabled', true, { target: 'template' }),
        /invalid or secret-bearing materialization path/u
    );
    const privateKeyPathRegistry = createWorkflowSettingRegistry([booleanSetting({
        materialize: (value) => [{ path: 'credentials.private_key', value }]
    })]);
    assert.throws(
        () => privateKeyPathRegistry.materialize('full-suite-enabled', true, { target: 'template' }),
        /invalid or secret-bearing materialization path/u
    );

    const invalidMaterializationRegistries = [
        {
            registry: createWorkflowSettingRegistry([booleanSetting({ materialize: () => [] })]),
            message: /between 1 and 16 bounded changes/u
        },
        {
            registry: createWorkflowSettingRegistry([booleanSetting({
                materialize: (value) => Array.from(
                    { length: 17 },
                    (_unused, index) => ({ path: `limits.output_${index}`, value })
                )
            })]),
            message: /between 1 and 16 bounded changes/u
        },
        {
            registry: createWorkflowSettingRegistry([booleanSetting({
                materialize: (value) => [
                    { path: 'full_suite_validation.enabled', value },
                    { path: 'full_suite_validation.enabled', value }
                ]
            })]),
            message: /duplicate materialization path/u
        },
        {
            registry: createWorkflowSettingRegistry([booleanSetting({
                materialize: (value) => [{ path: 'full_suite_validation..enabled', value }]
            })]),
            message: /invalid or secret-bearing materialization path/u
        },
        {
            registry: createWorkflowSettingRegistry([booleanSetting({
                materialize: () => new Array<{ path: string; value: unknown }>(1)
            })]),
            message: /materialization\[0\] must be present/u
        }
    ];
    for (const { registry, message } of invalidMaterializationRegistries) {
        assert.throws(
            () => registry.materialize('full-suite-enabled', true, { target: 'live' }),
            message
        );
    }
});

test('workflow-setting registry snapshots optional metadata without sharing nested option objects', () => {
    const options = [
        { value: 'true', label: 'On', description: 'Enable the existing guarded setting.' },
        { value: 'false', label: 'Off', description: 'Disable the existing guarded setting.' }
    ];
    const definition = booleanSetting();
    const ui = { ...definition.ui, options, placeholder: 'Choose a value', editable: false };
    definition.ui = ui;
    const registry = createWorkflowSettingRegistry([definition]);
    const entry = registry.require(definition.id);

    options[0].label = 'Changed outside the registry';
    options.push({ value: 'later', label: 'Later', description: 'A later source mutation.' });
    ui.placeholder = 'Changed after registration';
    assert.deepEqual(entry.ui.options?.map(option => option.label), ['On', 'Off']);
    assert.equal(entry.ui.placeholder, 'Choose a value');
    assert.equal(entry.ui.editable, false);
    assert.ok(Object.isFrozen(entry.ui.options));
    assert.ok(Object.isFrozen(entry.ui.options?.[0]));
    assert.equal(registry.validate(definition.id, false), false);
    assert.deepEqual(registry.materialize(definition.id, false, { target: 'live' }), [
        { path: 'full_suite_validation.enabled', value: false }
    ]);
});

test('workflow-setting registry retains zero bounds and enum choices using the existing value validators', () => {
    const integer = typedSetting('integer', 0, 'number', (value): value is number => Number.isSafeInteger(value));
    integer.ui = { ...integer.ui, min: 0, max: 5 };
    const enumeration = typedSetting('enum', 'balanced', 'select', (value): value is string => (
        value === 'balanced' || value === 'strict'
    ));
    enumeration.ui = { ...enumeration.ui, options: [
        { value: 'balanced', label: 'Balanced', description: 'Existing balanced value.' },
        { value: 'strict', label: 'Strict', description: 'Existing strict value.' }
    ] };
    const registry = createWorkflowSettingRegistry([integer, enumeration]);

    assert.equal(registry.require(integer.id).ui.min, 0);
    assert.equal(registry.require(integer.id).ui.max, 5);
    assert.equal(registry.validate(enumeration.id, 'strict'), 'strict');
    assert.throws(() => registry.validate(enumeration.id, 'invented'), /Invalid value/u);
});

test('workflow-setting registry rejects malformed optional metadata and contradictory presentation ranges', () => {
    const invalidUi = [
        { options: null },
        { options: new Array(1) },
        { options: [{ value: 'yes', label: 'Yes', description: 'Not a Boolean wire value.' }] },
        { options: [
            { value: 'true', label: 'First', description: 'First choice.' },
            { value: 'true', label: 'Duplicate', description: 'Duplicate choice.' }
        ] },
        { options: [{ value: 'true', label: '', description: 'Missing option label.' }] },
        { options: [{ value: 'true', label: 'On', description: null }] },
        { editable: 'true' },
        { placeholder: 1 },
        { min: 0 },
        { max: Number.NaN }
    ];
    let rejectedCount = 0;
    for (const metadata of invalidUi) {
        const definition = booleanSetting();
        definition.ui = { ...definition.ui, ...metadata } as unknown as typeof definition.ui;
        assert.throws(() => createWorkflowSettingRegistry([definition]), /\.ui\./u);
        rejectedCount += 1;
    }
    assert.equal(rejectedCount, invalidUi.length);

    const integer = typedSetting('integer', 1, 'number', (value): value is number => Number.isSafeInteger(value));
    assert.throws(() => createWorkflowSettingRegistry([{ ...integer, ui: { ...integer.ui, min: 5, max: 0 } }]), /min must not exceed/u);
    assert.throws(() => createWorkflowSettingRegistry([{ ...integer, ui: { ...integer.ui, min: 2 } }]), /default_value must stay within/u);
    assert.throws(() => createWorkflowSettingRegistry([{ ...integer, ui: { ...integer.ui, max: 0 } }]), /default_value must stay within/u);
    const enumeration = typedSetting('enum', 'balanced', 'select', (value): value is string => typeof value === 'string');
    assert.throws(() => createWorkflowSettingRegistry([{
        ...enumeration, ui: { ...enumeration.ui, options: [{ value: 'strict', label: 'Strict', description: 'A different value.' }] }
    }]), /default_value must appear in ui.options/u);
});
