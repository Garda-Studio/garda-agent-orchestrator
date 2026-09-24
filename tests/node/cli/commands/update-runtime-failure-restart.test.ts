import { it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { assertRuntimeRestartNotRequired } from '../../../../src/cli/commands/shared-command-utils';
import { runCliRuntimeMain } from '../../../../src/cli/runtime-main';

it('rejects another host command after an update fails following bundle mutation', async (context) => {
    const targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-failed-update-restart-'));
    const bundleRoot = path.join(targetRoot, 'garda-agent-orchestrator');
    const markerPath = path.join(bundleRoot, 'mutated-marker');
    fs.mkdirSync(bundleRoot);

    const checkUpdatePath = require.resolve('../../../../src/lifecycle/check-update');
    const updateCommandPath = require.resolve('../../../../src/cli/commands/update-command');
    const originalCheckUpdate = require.cache[checkUpdatePath];
    const originalCommand = require.cache[updateCommandPath];
    assertRuntimeRestartNotRequired();
    context.after(() => {
        if (originalCheckUpdate) require.cache[checkUpdatePath] = originalCheckUpdate;
        else delete require.cache[checkUpdatePath];
        if (originalCommand) require.cache[updateCommandPath] = originalCommand;
        else delete require.cache[updateCommandPath];
        fs.rmSync(targetRoot, { recursive: true, force: true });
    });

    require.cache[checkUpdatePath] = {
        id: checkUpdatePath,
        filename: checkUpdatePath,
        loaded: true,
        exports: {
            async runCheckUpdate() {
                fs.writeFileSync(markerPath, 'updated');
                throw new Error('failure after sync');
            }
        }
    } as NodeJS.Module;
    delete require.cache[updateCommandPath];

    const { handleUpdate } = require(updateCommandPath) as typeof import('../../../../src/cli/commands/update-command');
    await assert.rejects(() => handleUpdate([
        '--target-root', targetRoot, '--no-prompt', '--trust-override'
    ], { name: 'garda-agent-orchestrator', version: '1.0.0' }), /failure after sync/);
    assert.equal(fs.readFileSync(markerPath, 'utf8'), 'updated');
    await assert.rejects(() => runCliRuntimeMain(['--version']), /Start a new Garda process/);
});
