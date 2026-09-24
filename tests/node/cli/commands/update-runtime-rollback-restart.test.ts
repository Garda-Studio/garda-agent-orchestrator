import { it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { assertRuntimeRestartNotRequired } from '../../../../src/cli/commands/shared-command-utils';
import { runCliRuntimeMain } from '../../../../src/cli/runtime-main';

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
