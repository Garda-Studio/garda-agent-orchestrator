import assert from 'node:assert/strict';
import test from 'node:test';
import { UNCONFIGURED_COMPILE_GATE_COMMAND } from '../../../../src/core/constants';
import { buildDefaultWorkflowConfig } from '../../../../src/core/workflow-config';
import { buildWorkflowSettingMetadata } from '../../../../src/core/workflow-setting-metadata';
import { COMPILE_SETTING_REGISTRY } from '../../../../src/core/workflow-settings/compile';

const registry = COMPILE_SETTING_REGISTRY;
const id = 'compile-gate-command';

test('compile family retains the sole existing command and the fail-closed canonical default', () => {
    const entry = registry.require(id);
    assert.equal(registry.entries.length, 1);
    assert.equal(entry.key, 'compile_gate.command');
    assert.deepEqual(entry.owner, { kind: 'workflow', section: 'compile-gate' });
    assert.equal(entry.default_value, UNCONFIGURED_COMPILE_GATE_COMMAND);
    assert.equal(entry.default_value, buildDefaultWorkflowConfig().compile_gate.command);
    assert.equal(entry.value_type, 'string');
    assert.equal(entry.exposure, 'operator-visible');
    for (const target of ['live', 'template'] as const) {
        const changes = registry.materialize(id, entry.default_value, { target });
        assert.deepEqual(changes, [{ path: 'compile_gate.command', value: UNCONFIGURED_COMPILE_GATE_COMMAND }]);
        assert.ok(Object.isFrozen(changes));
        assert.ok(Object.isFrozen(changes[0]));
    }
    for (const other of ['compile-gate-enabled', 'full-suite-command', 'task-reset-enabled']) {
        assert.throws(() => registry.require(other), /Unknown workflow setting/);
    }
    assert.throws(() => registry.materialize(id, 'npm run typecheck', { target: 'other' } as never), /target/);
});

test('typed command candidates preserve owner normalization without granting execution admission', () => {
    for (const [input, expected] of [
        ['npm run typecheck', 'npm run typecheck'],
        ['  node scripts/check.js "two words"  ', 'node scripts/check.js "two words"'],
        ['npm test', 'npm test'],
        ['node first.js && node second.js', 'node first.js && node second.js']
    ]) {
        assert.equal(registry.validate(id, input), input);
        for (const target of ['live', 'template'] as const) {
            assert.deepEqual(registry.materialize(id, input, { target }), [
                { path: 'compile_gate.command', value: expected }
            ]);
        }
    }
    // Execution and compile-only admission are separate gate responsibilities.
    for (const value of ['', '   ', '\n\t', null, undefined, 0, 1, false, true, [], {}, new String('node check.js')]) {
        assert.throws(() => registry.validate(id, value), /Invalid value/);
        assert.throws(() => registry.materialize(id, value, { target: 'live' }), /Invalid value/);
    }
});

test('mutable presentation fields cannot alter canonical ownership or command admission', () => {
    const presentation = buildWorkflowSettingMetadata(registry)[0];
    presentation.options.push({ value: '', label: 'Empty', description: 'Untrusted presentation option.' });
    presentation.placeholder = 'untrusted input';
    assert.equal(registry.require(id).ui.options!.length, 0);
    assert.equal(registry.require(id).ui.placeholder, 'compile/build/type-check command');
    assert.throws(() => registry.validate(id, ''), /Invalid value/);
    assert.equal(registry.require(id).default_value, UNCONFIGURED_COMPILE_GATE_COMMAND);
    for (const object of [registry.entries, registry.require(id), registry.require(id).owner,
        registry.require(id).ui, registry.require(id).ui.options]) {
        assert.ok(Object.isFrozen(object));
    }
});
