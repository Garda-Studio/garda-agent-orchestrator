import { it, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { assertRuntimeRestartNotRequired } from '../../../../src/cli/commands/shared-command-utils';
import { runCliRuntimeMain } from '../../../../src/cli/runtime-main';
import { createRollbackSnapshot, readRollbackRecords, writeRollbackRecords } from '../../../../src/lifecycle/common';

function setupCliDestinationSnapshot(answersRelative = 'garda-agent-orchestrator/runtime/init-answers.json') {
    const targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-rollback-cli-scope-'));
    const bundleRoot = path.join(targetRoot, 'garda-agent-orchestrator');
    const snapshotPath = path.join(bundleRoot, 'runtime/update-rollbacks/supported-history');
    const versionPath = path.join(bundleRoot, 'VERSION');
    const hookPath = path.join(targetRoot, '.git/hooks/pre-commit');
    const answersPath = path.join(targetRoot, answersRelative);
    for (const file of [versionPath, hookPath, answersPath]) fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(versionPath, '1.0.0\n');
    fs.writeFileSync(hookPath, 'supported hook\n');
    fs.writeFileSync(answersPath, '{"SourceOfTruth":"Codex"}\n');
    const records = createRollbackSnapshot(targetRoot, snapshotPath,
        ['garda-agent-orchestrator/VERSION', '.git/hooks/pre-commit', answersRelative]);
    writeRollbackRecords(snapshotPath, records);
    fs.writeFileSync(versionPath, '2.0.0\n');
    return { targetRoot, snapshotPath, versionPath, hookPath, answersPath, records };
}

function loadIsolatedRollbackHandler(context: TestContext) {
    // A real mutating-command failure intentionally marks its runtime for
    // restart. Give each handler fixture fresh module state, without clearing
    // or mocking the guard used by the existing host-restart regression.
    const commandPath = require.resolve('../../../../src/cli/commands/update-command');
    const utilsPath = require.resolve('../../../../src/cli/commands/shared-command-utils');
    const originalCommand = require.cache[commandPath];
    const originalUtils = require.cache[utilsPath];
    context.after(() => {
        if (originalCommand) require.cache[commandPath] = originalCommand;
        else delete require.cache[commandPath];
        if (originalUtils) require.cache[utilsPath] = originalUtils;
        else delete require.cache[utilsPath];
    });
    delete require.cache[commandPath];
    delete require.cache[utilsPath];
    return (require(commandPath) as typeof import('../../../../src/cli/commands/update-command')).handleRollback;
}

it('rejects rollback source trust override without non-interactive acknowledgement', async () => {
    const targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-rollback-trust-'));
    fs.mkdirSync(path.join(targetRoot, 'garda-agent-orchestrator'));
    try {
        const { handleRollback } = await import('../../../../src/cli/commands/update-command');
        await assert.rejects(
            () => handleRollback([
                '--target-root', targetRoot,
                '--to-version', '1.0.0',
                '--source-path', targetRoot,
                '--trust-override'
            ], { name: 'garda-agent-orchestrator', version: '1.0.0' }),
            /requires explicit non-interactive acknowledgement/
        );
    } finally {
        fs.rmSync(targetRoot, { recursive: true, force: true });
    }
});

it('forwards accepted rollback source trust and validation flags', async (context) => {
    const targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-rollback-flags-'));
    fs.mkdirSync(path.join(targetRoot, 'garda-agent-orchestrator'));
    const rollbackPath = require.resolve('../../../../src/lifecycle/rollback');
    const updateCommandPath = require.resolve('../../../../src/cli/commands/update-command');
    const originalRollback = require.cache[rollbackPath];
    const originalCommand = require.cache[updateCommandPath];
    const received: { options?: Record<string, unknown> } = {};
    context.after(() => {
        if (originalRollback) require.cache[rollbackPath] = originalRollback;
        else delete require.cache[rollbackPath];
        if (originalCommand) require.cache[updateCommandPath] = originalCommand;
        else delete require.cache[updateCommandPath];
        fs.rmSync(targetRoot, { recursive: true, force: true });
    });
    require.cache[rollbackPath] = {
        id: rollbackPath,
        filename: rollbackPath,
        loaded: true,
        exports: { async runRollback(options: Record<string, unknown>) {
            received.options = options;
            return { rollbackMode: 'version', restoreStatus: 'SKIPPED_DRY_RUN' };
        } }
    } as NodeJS.Module;
    delete require.cache[updateCommandPath];

    const { handleRollback } = require(updateCommandPath) as typeof import('../../../../src/cli/commands/update-command');
    await handleRollback([
        '--target-root', targetRoot, '--to-version', '1.0.0', '--source-path', targetRoot,
        '--trust-override', '--no-prompt', '--skip-verify', '--skip-manifest-validation',
        '--dry-run', '--json'
    ], { name: 'garda-agent-orchestrator', version: '1.0.0' });
    assert.ok(received.options);
    assert.equal(received.options.targetVersion, '1.0.0');
    assert.equal(received.options.sourcePath, path.resolve(targetRoot));
    assert.equal(received.options.trustOverride, true);
    assert.equal(received.options.skipVerify, true);
    assert.equal(received.options.skipManifestValidation, true);
    assert.equal(received.options.dryRun, true);
});

it('rejects self-consistent unsupported hook destinations through the real rollback CLI handler', async (context) => {
    const fixture = setupCliDestinationSnapshot();
    context.after(() => fs.rmSync(fixture.targetRoot, { recursive: true, force: true }));
    const destination = '.git/hooks/post-merge';
    fs.writeFileSync(path.join(fixture.snapshotPath, destination), 'forged additional hook\n');
    writeRollbackRecords(fixture.snapshotPath, [...fixture.records,
        { relativePath: destination, existed: true, pathType: 'file' }]);
    const handleRollback = loadIsolatedRollbackHandler(context);

    assert.ok(readRollbackRecords(fixture.snapshotPath).some(record => record.relativePath === destination));
    await assert.rejects(() => handleRollback([
        '--target-root', fixture.targetRoot, '--snapshot-path', fixture.snapshotPath, '--json'
    ], { name: 'garda-agent-orchestrator', version: '1.4.4' }), /Unsupported snapshot rollback destination.*post-merge/);
    assert.equal(fs.existsSync(path.join(fixture.targetRoot, destination)), false);
    assert.equal(fs.readFileSync(fixture.versionPath, 'utf8'), '2.0.0\n');
    assert.equal(fs.readFileSync(fixture.hookPath, 'utf8'), 'supported hook\n');
    assert.deepEqual(fs.readdirSync(path.dirname(fixture.snapshotPath)), ['supported-history']);
});

it('rejects unsupported destination deletion records through rollback CLI dry-run', async (context) => {
    const fixture = setupCliDestinationSnapshot();
    context.after(() => fs.rmSync(fixture.targetRoot, { recursive: true, force: true }));
    const unrelatedPath = path.join(fixture.targetRoot, 'user-source.txt');
    fs.writeFileSync(unrelatedPath, 'unrelated retained source\n');
    writeRollbackRecords(fixture.snapshotPath, [...fixture.records,
        { relativePath: 'user-source.txt', existed: false, pathType: 'missing' }]);
    const handleRollback = loadIsolatedRollbackHandler(context);

    await assert.rejects(() => handleRollback([
        '--target-root', fixture.targetRoot, '--snapshot-path', fixture.snapshotPath, '--dry-run', '--json'
    ], { name: 'garda-agent-orchestrator', version: '1.4.4' }), /Unsupported snapshot rollback destination.*user-source/);
    assert.equal(fs.readFileSync(unrelatedPath, 'utf8'), 'unrelated retained source\n');
    assert.equal(fs.readFileSync(fixture.versionPath, 'utf8'), '2.0.0\n');
    assert.deepEqual(fs.readdirSync(path.dirname(fixture.snapshotPath)), ['supported-history']);
});

it('binds custom historical answers to the explicit rollback CLI input', async (context) => {
    const answersRelative = 'config/prior-answers.json';
    const fixture = setupCliDestinationSnapshot(answersRelative);
    context.after(() => fs.rmSync(fixture.targetRoot, { recursive: true, force: true }));
    const handleRollback = loadIsolatedRollbackHandler(context);
    const output: string[] = [];
    context.mock.method(console, 'log', (value: unknown) => output.push(String(value)));

    await assert.rejects(() => handleRollback([
        '--target-root', fixture.targetRoot, '--snapshot-path', fixture.snapshotPath, '--dry-run', '--json'
    ], { name: 'garda-agent-orchestrator', version: '1.4.4' }), /Unsupported snapshot rollback destination.*prior-answers/);
    await handleRollback([
        '--target-root', fixture.targetRoot, '--snapshot-path', fixture.snapshotPath,
        '--init-answers-path', answersRelative, '--dry-run', '--json'
    ], { name: 'garda-agent-orchestrator', version: '1.4.4' });
    const result = JSON.parse(output.join('\n')) as { restoreStatus: string; previewAffectedItems: string[] };
    assert.equal(result.restoreStatus, 'SKIPPED_DRY_RUN');
    assert.ok(result.previewAffectedItems.includes(answersRelative));
    assert.equal(fs.readFileSync(fixture.versionPath, 'utf8'), '2.0.0\n');
    assert.equal(fs.readFileSync(fixture.answersPath, 'utf8'), '{"SourceOfTruth":"Codex"}\n');
    assert.deepEqual(fs.readdirSync(path.dirname(fixture.snapshotPath)), ['supported-history']);
});

it('rejects another host command after a successful non-dry-run rollback', async (context) => {
    const targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-rollback-restart-'));
    fs.mkdirSync(path.join(targetRoot, 'garda-agent-orchestrator'));
    const rollbackPath = require.resolve('../../../../src/lifecycle/rollback');
    const updateCommandPath = require.resolve('../../../../src/cli/commands/update-command');
    const originalRollback = require.cache[rollbackPath];
    const originalCommand = require.cache[updateCommandPath];
    assertRuntimeRestartNotRequired();
    context.after(() => {
        if (originalRollback) require.cache[rollbackPath] = originalRollback;
        else delete require.cache[rollbackPath];
        if (originalCommand) require.cache[updateCommandPath] = originalCommand;
        else delete require.cache[updateCommandPath];
        fs.rmSync(targetRoot, { recursive: true, force: true });
    });
    require.cache[rollbackPath] = {
        id: rollbackPath,
        filename: rollbackPath,
        loaded: true,
        exports: { async runRollback() { return { rollbackMode: 'snapshot', restoreStatus: 'SUCCESS' }; } }
    } as NodeJS.Module;
    delete require.cache[updateCommandPath];

    const { handleRollback } = require(updateCommandPath) as typeof import('../../../../src/cli/commands/update-command');
    await handleRollback(['--target-root', targetRoot, '--json'], {
        name: 'garda-agent-orchestrator', version: '1.0.0'
    });
    await assert.rejects(() => runCliRuntimeMain(['--version']), /Start a new Garda process/);
});
