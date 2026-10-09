import assert from 'node:assert/strict';
import test from 'node:test';
import { buildDefaultWorkflowConfig, normalizeAutoBackupConfig } from '../../../../src/core/workflow-config';
import { buildWorkflowSettingMetadata } from '../../../../src/core/workflow-setting-metadata';
import { BACKUP_SETTING_REGISTRY } from '../../../../src/core/workflow-settings/backup';
import { validateWorkflowConfig } from '../../../../src/schemas/config-artifacts-workflow';

const registry = BACKUP_SETTING_REGISTRY;

function assertCandidate(id: string, value: boolean | number): void {
    const entry = registry.require(id);
    for (const target of ['live', 'template'] as const) {
        const changes = registry.materialize(id, value, { target });
        assert.deepEqual(changes, [{ path: entry.key, value }]);
        assert.ok(Object.isFrozen(changes));
        assert.ok(Object.isFrozen(changes[0]));
    }
}

test('backup definitions retain exact defaults, flags, owner and presentation bounds', () => {
    assert.deepEqual(registry.entries.map(entry => [entry.id, entry.key, entry.default_value, entry.cli.flag]), [
        ['auto-backup-enabled', 'auto_backup.enabled', false, '--auto-backup-enabled'],
        ['auto-backup-interval-days', 'auto_backup.interval_days', 1, '--auto-backup-interval-days'],
        ['auto-backup-keep-latest', 'auto_backup.keep_latest', 10, '--auto-backup-keep-latest']
    ]);
    assert.deepEqual(registry.entries.map(entry => [entry.ui.min, entry.ui.max]),
        [[undefined, undefined], [1, 3650], [1, 1000]]);
    assert.deepEqual(registry.require('auto-backup-enabled').ui.options!.map(option => option.value), ['true', 'false']);
    for (const entry of registry.entries) {
        assert.deepEqual(entry.owner, { kind: 'workflow', section: 'auto-backup' });
        assert.equal(entry.exposure, 'operator-visible');
        assertCandidate(entry.id, entry.default_value as boolean | number);
        assert.ok(Object.isFrozen(entry));
        assert.ok(Object.isFrozen(entry.ui.options));
    }
});

test('backup boolean candidates reject coercion without changing legacy config aliases', () => {
    for (const value of [true, false]) assertCandidate('auto-backup-enabled', value);
    for (const value of ['true', 'false', 0, 1, null, undefined, [], {}, new Boolean(true)]) {
        assert.throws(() => registry.validate('auto-backup-enabled', value), /Invalid value/);
        assert.throws(() => registry.materialize('auto-backup-enabled', value, { target: 'live' }), /Invalid value/);
    }
    const parsed = validateWorkflowConfig({ ...buildDefaultWorkflowConfig(),
        auto_backup: { enabled: 'true', interval_days: '2', keep_latest: '11' } });
    assert.deepEqual(parsed.auto_backup, { enabled: true, interval_days: 2, keep_latest: 11 });
});

test('backup integer candidates retain UI bounds while owner parsing stays permissive', () => {
    for (const [id, maximum] of [['auto-backup-interval-days', 3650], ['auto-backup-keep-latest', 1000]] as const) {
        for (const value of [1, 10, maximum]) assertCandidate(id, value);
        for (const value of [0, -1, 1.5, maximum + 1, Number.MAX_SAFE_INTEGER + 1,
            NaN, Infinity, '2', true, null, undefined, [], {}, new Number(2)]) {
            assert.throws(() => registry.validate(id, value), /Invalid value/);
            assert.throws(() => registry.materialize(id, value, { target: 'template' }), /Invalid value/);
        }
    }
    const abovePresentationBounds = { enabled: true, interval_days: 3651, keep_latest: 1001 };
    assert.deepEqual(normalizeAutoBackupConfig(abovePresentationBounds), abovePresentationBounds);
    const parsed = validateWorkflowConfig({ ...buildDefaultWorkflowConfig(), auto_backup: abovePresentationBounds });
    assert.deepEqual(parsed.auto_backup, abovePresentationBounds);
    assert.deepEqual(normalizeAutoBackupConfig({ enabled: 'true', interval_days: 0, keep_latest: 0 }),
        { enabled: false, interval_days: 1, keep_latest: 10 });
});

test('untrusted backup presentation and invalid targets cannot change canonical candidates', () => {
    const before = JSON.stringify(buildDefaultWorkflowConfig());
    const metadata = buildWorkflowSettingMetadata(registry);
    metadata[0].options[0].value = 'purge';
    metadata[1].min = -100;
    metadata[1].max = Number.MAX_SAFE_INTEGER;
    assert.equal(registry.require('auto-backup-enabled').ui.options![0].value, 'true');
    assert.equal(registry.require('auto-backup-interval-days').ui.min, 1);
    assert.equal(registry.require('auto-backup-interval-days').ui.max, 3650);
    assert.throws(() => registry.validate('auto-backup-enabled', 'purge'), /Invalid value/);
    assert.throws(() => registry.validate('auto-backup-interval-days', -1), /Invalid value/);
    assert.throws(() => registry.validate('auto-backup-interval-days', 3651), /Invalid value/);
    assert.throws(() => registry.materialize('auto-backup-enabled', true, { target: 'other' } as never), /target/);
    assert.throws(() => registry.materialize('auto-backup-keep-latest', 1, {} as never), /target/);
    assert.throws(() => registry.require('backup-create'), /Unknown workflow setting/);
    assertCandidate('auto-backup-enabled', true);
    assertCandidate('auto-backup-interval-days', 1);
    assertCandidate('auto-backup-keep-latest', 1);
    assert.equal(JSON.stringify(buildDefaultWorkflowConfig()), before);
    for (const entry of metadata) {
        for (const authority of ['owner', 'default_value', 'validate', 'materialize', 'execute', 'cleanup']) {
            assert.equal(authority in entry, false);
        }
    }
});
