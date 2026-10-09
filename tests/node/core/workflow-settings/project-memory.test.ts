import assert from 'node:assert/strict';
import test from 'node:test';
import { buildDefaultWorkflowConfig } from '../../../../src/core/workflow-config';
import { buildWorkflowSettingMetadata } from '../../../../src/core/workflow-setting-metadata';
import { PROJECT_MEMORY_SETTING_REGISTRY } from '../../../../src/core/workflow-settings/project-memory';
import { validateWorkflowConfig } from '../../../../src/schemas/config-artifacts-workflow';

const registry = PROJECT_MEMORY_SETTING_REGISTRY;

function assertCandidate(id: string, value: boolean | string | number): void {
    const entry = registry.require(id);
    for (const target of ['live', 'template'] as const) {
        const changes = registry.materialize(id, value, { target });
        assert.deepEqual(changes, [{ path: entry.key, value }]);
        assert.ok(Object.isFrozen(changes));
        assert.ok(Object.isFrozen(changes[0]));
    }
}

test('project-memory definitions retain seven ordered fields, defaults and external ownership', () => {
    assert.deepEqual(registry.entries.map(entry => [entry.id, entry.key, entry.default_value]), [
        ['project-memory-enabled', 'project_memory_maintenance.enabled', true],
        ['project-memory-mode', 'project_memory_maintenance.mode', 'update'],
        ['project-memory-run-before-final-closeout', 'project_memory_maintenance.run_before_final_closeout', true],
        ['project-memory-require-user-approval-for-writes', 'project_memory_maintenance.require_user_approval_for_writes', true],
        ['project-memory-max-compact-summary-chars', 'project_memory_maintenance.max_compact_summary_chars', 12000],
        ['project-memory-read-strategy', 'project_memory_maintenance.read_strategy', 'index_first'],
        ['project-memory-impact-retention-days', 'project_memory_maintenance.impact_artifact_retention_days', 30]
    ]);
    assert.deepEqual(registry.entries.map(entry => entry.cli.flag), [
        '--project-memory-enabled', '--project-memory-mode', '--project-memory-run-before-final-closeout',
        '--project-memory-require-user-approval-for-writes', '--project-memory-max-compact-summary-chars',
        '--project-memory-read-strategy', '--project-memory-impact-artifact-retention-days'
    ]);
    const defaults = buildDefaultWorkflowConfig().project_memory_maintenance;
    for (const entry of registry.entries) {
        assert.deepEqual(entry.owner, { kind: 'workflow', section: 'project-memory' });
        assert.equal(entry.exposure, 'operator-visible');
        assert.equal(entry.default_value, defaults[entry.key.split('.')[1]]);
        assertCandidate(entry.id, entry.default_value as boolean | string | number);
    }
    for (const id of ['task-reset-enabled', 'local-commit-enabled', 'project-memory-files', 'project-memory-write']) {
        assert.throws(() => registry.require(id), /Unknown workflow setting/);
    }
});

test('project-memory boolean candidates reject coercion and do not update a companion field', () => {
    const ids = ['project-memory-enabled', 'project-memory-run-before-final-closeout',
        'project-memory-require-user-approval-for-writes'];
    for (const id of ids) {
        for (const value of [true, false]) {
            assert.equal(registry.validate(id, value), value);
            assertCandidate(id, value);
        }
        for (const value of ['true', 'false', 0, 1, null, undefined, [], {}, new Boolean(false)]) {
            assert.throws(() => registry.validate(id, value), /Invalid value/);
            assert.throws(() => registry.materialize(id, value, { target: 'live' }), /Invalid value/);
        }
    }
    assert.equal(buildDefaultWorkflowConfig().project_memory_maintenance.require_user_approval_for_writes, true);
});

test('project-memory enums preserve canonical choices while the existing config parser retains aliases', () => {
    for (const value of ['off', 'check', 'update', 'strict']) assertCandidate('project-memory-mode', value);
    assertCandidate('project-memory-read-strategy', 'index_first');
    for (const id of ['project-memory-mode', 'project-memory-read-strategy']) {
        for (const value of ['unknown', 'UPDATE', ' update ', 'INDEX_FIRST', '', null, undefined, true, [], {}]) {
            assert.throws(() => registry.validate(id, value), /Invalid value/);
            assert.throws(() => registry.materialize(id, value, { target: 'template' }), /Invalid value/);
        }
    }
    const defaults = buildDefaultWorkflowConfig();
    const normalized = validateWorkflowConfig({ ...defaults, project_memory_maintenance: {
        ...defaults.project_memory_maintenance, mode: ' UPDATE ', read_strategy: ' INDEX_FIRST ', enabled: 'false'
    } });
    assert.equal((normalized.project_memory_maintenance as Record<string, unknown>).mode, 'update');
    assert.equal((normalized.project_memory_maintenance as Record<string, unknown>).read_strategy, 'index_first');
    assert.equal((normalized.project_memory_maintenance as Record<string, unknown>).enabled, false);
});

test('project-memory integer candidates preserve both presentation bounds and safe primitive values', () => {
    for (const [id, minimum, defaultValue, maximum] of [
        ['project-memory-max-compact-summary-chars', 2000, 12000, 200000],
        ['project-memory-impact-retention-days', 1, 30, 3650]
    ] as const) {
        for (const value of [minimum, defaultValue, maximum]) assertCandidate(id, value);
        for (const value of [minimum - 1, maximum + 1, -1, 1.5, NaN, Infinity,
            Number.MAX_SAFE_INTEGER + 1, String(defaultValue), null, true, [], {}]) {
            assert.throws(() => registry.validate(id, value), /Invalid value/);
            assert.throws(() => registry.materialize(id, value, { target: 'live' }), /Invalid value/);
        }
    }
});

test('presentation mutation and invalid candidates cannot authorize memory writes', () => {
    const before = JSON.stringify(buildDefaultWorkflowConfig());
    const presentation = buildWorkflowSettingMetadata(registry);
    const mode = presentation.find(entry => entry.id === 'project-memory-mode')!;
    const summary = presentation.find(entry => entry.id === 'project-memory-max-compact-summary-chars')!;
    mode.options[0].value = 'bypass';
    mode.options.push({ value: 'write_anything', label: 'Injected', description: 'Untrusted presentation.' });
    summary.min = 0;
    summary.max = 1_000_000;
    assert.equal(registry.require(mode.id).ui.options![0].value, 'off');
    assert.equal(registry.require(mode.id).ui.options!.length, 4);
    assert.throws(() => registry.validate(mode.id, 'bypass'), /Invalid value/);
    assert.throws(() => registry.validate(summary.id, 200001), /Invalid value/);
    assert.throws(() => registry.materialize(mode.id, 'update', { target: 'other' } as never), /target/);
    assert.throws(() => registry.materialize(mode.id, 'update', {} as never), /target/);
    assert.deepEqual(registry.materialize('project-memory-require-user-approval-for-writes', false, { target: 'live' }),
        [{ path: 'project_memory_maintenance.require_user_approval_for_writes', value: false }]);
    assert.equal(buildDefaultWorkflowConfig().project_memory_maintenance.require_user_approval_for_writes, true);
    assert.equal(JSON.stringify(buildDefaultWorkflowConfig()), before);
    for (const entry of registry.entries) {
        assert.ok(Object.isFrozen(entry));
        assert.ok(Object.isFrozen(entry.owner));
        assert.ok(Object.isFrozen(entry.ui));
        assert.ok(Object.isFrozen(entry.ui.options));
    }
});
