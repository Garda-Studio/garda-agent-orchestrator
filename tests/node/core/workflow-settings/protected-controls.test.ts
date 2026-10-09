import assert from 'node:assert/strict';
import test from 'node:test';
import { buildDefaultWorkflowConfig } from '../../../../src/core/workflow-config';
import { buildWorkflowSettingMetadata } from '../../../../src/core/workflow-setting-metadata';
import { PROTECTED_CONTROL_SETTING_REGISTRY } from '../../../../src/core/workflow-settings/protected-controls';
import { validateWorkflowConfig } from '../../../../src/schemas/config-artifacts-workflow';

const registry = PROTECTED_CONTROL_SETTING_REGISTRY;

function assertCandidate(id: string, value: boolean | string): void {
    const entry = registry.require(id);
    for (const target of ['live', 'template'] as const) {
        const changes = registry.materialize(id, value, { target });
        assert.deepEqual(changes, [{ path: entry.key, value }]);
        assert.ok(Object.isFrozen(changes));
        assert.ok(Object.isFrozen(changes[0]));
    }
}

test('protected definitions retain separate owners, exact flags and default OFF/deny', () => {
    assert.deepEqual(registry.entries.map(entry => [entry.id, entry.key, entry.default_value, entry.cli.flag]), [
        ['task-reset-enabled', 'task_reset.enabled', false, '--task-reset-enabled'],
        ['local-commit-enabled', 'local_commit.enabled', false, '--local-commit-enabled'],
        ['garda-self-guard', 'orchestrator_work_policy.mode', 'deny_agent_entry', '--garda-self-guard']
    ]);
    assert.deepEqual(registry.entries.map(entry => entry.owner), [
        { kind: 'workflow', section: 'task-reset' },
        { kind: 'workflow', section: 'local-commit' },
        { kind: 'workflow', section: 'orchestrator-work-policy' }
    ]);
    for (const entry of registry.entries) {
        assert.equal(entry.exposure, 'operator-visible');
        assertCandidate(entry.id, entry.default_value as boolean | string);
        assert.ok(Object.isFrozen(entry));
        assert.ok(Object.isFrozen(entry.owner));
        assert.ok(Object.isFrozen(entry.ui.options));
    }
    assert.equal(registry.require('garda-self-guard').ui.editable, false);
    for (const id of ['reset-authority', 'commit-grant', 'task-reset-action', 'project-memory-enabled']) {
        assert.throws(() => registry.require(id), /Unknown workflow setting/);
    }
});

test('protected boolean candidates reject coercion while existing config parsing keeps its aliases', () => {
    for (const id of ['task-reset-enabled', 'local-commit-enabled']) {
        for (const value of [true, false]) assertCandidate(id, value);
        for (const value of ['true', 'false', 0, 1, null, undefined, [], {}, new Boolean(true)]) {
            assert.throws(() => registry.validate(id, value), /Invalid value/);
            assert.throws(() => registry.materialize(id, value, { target: 'live' }), /Invalid value/);
        }
    }
    const parsed = validateWorkflowConfig({ ...buildDefaultWorkflowConfig(),
        task_reset: { enabled: 'true' }, local_commit: { enabled: 'false' } });
    assert.equal((parsed.task_reset as { enabled: boolean }).enabled, true);
    assert.equal((parsed.local_commit as { enabled: boolean }).enabled, false);
});

test('self-guard candidates admit canonical owner modes without changing legacy normalization', () => {
    for (const value of ['deny_agent_entry', 'require_operator_confirmation']) assertCandidate('garda-self-guard', value);
    assert.deepEqual(registry.require('garda-self-guard').ui.options!.map(option => option.value),
        ['deny_agent_entry', 'require_operator_confirmation']);
    for (const value of ['off', 'on', 'allow_agent_entry', 'REQUIRE_OPERATOR_CONFIRMATION',
        ' deny_agent_entry ', '', true, null, undefined, [], {}]) {
        assert.throws(() => registry.validate('garda-self-guard', value), /Invalid value/);
        assert.throws(() => registry.materialize('garda-self-guard', value, { target: 'template' }), /Invalid value/);
    }
    const parsed = validateWorkflowConfig({ ...buildDefaultWorkflowConfig(),
        orchestrator_work_policy: { mode: ' REQUIRE_OPERATOR_CONFIRMATION ' } });
    assert.equal((parsed.orchestrator_work_policy as { mode: string }).mode, 'require_operator_confirmation');
});

test('untrusted presentation and invalid candidates cannot grant protected authority', () => {
    const before = JSON.stringify(buildDefaultWorkflowConfig());
    const metadata = buildWorkflowSettingMetadata(registry);
    const guard = metadata.find(entry => entry.id === 'garda-self-guard')!;
    guard.editable = true;
    guard.options[0].value = 'allow_agent_entry';
    guard.options.push({ value: 'off', label: 'Injected', description: 'Untrusted presentation.' });
    assert.equal(registry.require(guard.id).ui.editable, false);
    assert.equal(registry.require(guard.id).ui.options![0].value, 'deny_agent_entry');
    assert.equal(registry.require(guard.id).ui.options!.length, 2);
    assert.throws(() => registry.materialize(guard.id, 'allow_agent_entry', { target: 'live' }), /Invalid value/);
    for (const entry of metadata) {
        for (const authority of ['owner', 'default_value', 'validate', 'materialize']) {
            assert.equal(authority in entry, false);
        }
    }
    assertCandidate('task-reset-enabled', true);
    assertCandidate('local-commit-enabled', true);
    assertCandidate('garda-self-guard', 'require_operator_confirmation');
    assert.throws(() => registry.materialize('local-commit-enabled', true, { target: 'other' } as never), /target/);
    assert.throws(() => registry.materialize('task-reset-enabled', true, {} as never), /target/);
    assert.equal(JSON.stringify(buildDefaultWorkflowConfig()), before);
    const defaults = buildDefaultWorkflowConfig();
    assert.equal(defaults.task_reset.enabled, false);
    assert.equal(defaults.local_commit.enabled, false);
    assert.equal(defaults.orchestrator_work_policy.mode, 'deny_agent_entry');
});
