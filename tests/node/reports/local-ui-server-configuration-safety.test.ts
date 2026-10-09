import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

import { buildDefaultWorkflowConfig } from '../../../src/core/workflow-config';
import { resolveTaskResetAvailability } from '../../../src/core/task-reset-availability';

const TASK_ID = 'T-207-RESET-FIXTURE';

function createFixture(): { root: string; config: string } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-ui-one-shot-'));
    const config = path.join(root, 'garda-agent-orchestrator/live/config/workflow-config.json');
    fs.mkdirSync(path.dirname(config), { recursive: true });
    fs.writeFileSync(config, JSON.stringify(buildDefaultWorkflowConfig(), null, 2) + '\n');
    fs.writeFileSync(path.join(root, 'TASK.md'), [
        '# Tasks', '## Active Queue',
        '| Task | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
        '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
        `| ${TASK_ID} | TODO | P1 | fixture | Reset fixture | test | 2026-10-07 | balanced | |`, ''
    ].join('\n'));
    const git = spawnSync('git', ['init', '--quiet', root], { encoding: 'utf8' });
    assert.equal(git.status, 0, git.stderr);
    return { root, config };
}

function runOneShot(root: string, scenario: 'interrupt' | 'concurrent-enable') {
    const modules = {
        handler: require.resolve('../../../src/reports/ui/actions/http/task-reset-one-shot-http'),
        actions: require.resolve('../../../src/reports/ui/actions/task-actions'),
        workflow: require.resolve('../../../src/cli/commands/workflow/workflow-command-set'),
        reset: require.resolve('../../../src/cli/commands/gate-flows/task/task-reset-flow'),
        availability: require.resolve('../../../src/core/task-reset-availability')
    };
    const script = `
        const modules = ${JSON.stringify(modules)};
        const root = ${JSON.stringify(root)};
        const taskId = ${JSON.stringify(TASK_ID)};
        const scenario = ${JSON.stringify(scenario)};
        const { handleSet } = require(modules.workflow);
        const { runTaskResetCommand } = require(modules.reset);
        const { resolveTaskResetAvailability } = require(modules.availability);
        const { processTaskResetOneShotActionRequest } = require(modules.handler);
        const action = require(modules.actions).buildUiTaskActionDefinitions(root, taskId)
            .find(value => value.id === 'task-reset-reopen');
        const setEnabled = enabled => handleSet({
            targetRoot: root, taskResetEnabled: String(enabled), json: true,
            operatorConfirmed: 'yes', operatorConfirmedAtUtc: new Date().toISOString()
        });
        const result = (exitCode, stdout = '') => ({
            exit_code: exitCode, signal: null, stdout, stderr: '', timed_out: false
        });
        const runner = async step => {
            if (step.id !== action.id || !step.command.args.includes('--one-action')) {
                throw new Error('Expected one native one-action reset without global setting operations.');
            }
            const flag = name => step.command.args[step.command.args.indexOf(name) + 1];
            const binding = { taskId, reopen: true, repoRoot: root,
                operatorConfirmed: flag('--operator-confirmed'),
                operatorConfirmedAtUtc: flag('--operator-confirmed-at-utc') };
            const prepared = runTaskResetCommand({ ...binding, prepareOneAction: true });
            if (prepared.exitCode !== 0) throw new Error(prepared.outputLines.join('\\n'));
            if (scenario === 'interrupt') {
                if (resolveTaskResetAvailability(root).enabled) throw new Error('Preparation changed durable reset policy.');
                process.stdout.write('NATIVE_PREPARATION_DISABLED\\n');
                process.exit(78);
            }
            setEnabled(true);
            process.stdout.write('EXPLICIT_ENABLE_COMMITTED_DURING_ONE_SHOT\\n');
            const reset = runTaskResetCommand({ ...binding, oneActionAuthority: prepared.oneActionAuthority, confirm: true });
            if (reset.exitCode !== 0) throw new Error(reset.outputLines.join('\\n'));
            process.stdout.write('NATIVE_RESET_COMPLETED\\n');
            return result(reset.exitCode, reset.outputLines.join('\\n'));
        };
        const response = { writeHead() {}, end(body) { process.stdout.write(body + '\\n'); } };
        processTaskResetOneShotActionRequest(response, root, taskId,
            { mode: 'execute', confirmation: action.confirmation_phrase }, action,
            { actionsEnabled: true, actionRunner: runner, actionToken: '', trustedOriginHost: '127.0.0.1' }
        ).catch(error => { console.error(error); process.exitCode = 1; });
    `;
    return spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 30_000 });
}

test('interrupted UI one-shot does not leave persistent reset permission enabled', () => {
    const { root, config } = createFixture();
    try {
        assert.equal(resolveTaskResetAvailability(root).enabled, false);
        const child = runOneShot(root, 'interrupt');
        assert.equal(child.status, 78, child.stderr);
        assert.match(child.stdout, /NATIVE_PREPARATION_DISABLED/u);
        assert.equal(JSON.parse(fs.readFileSync(config, 'utf8')).task_reset.enabled, false);
        assert.equal(resolveTaskResetAvailability(root).enabled, false);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('UI one-shot preserves an explicit reset enable committed during the operation', () => {
    const { root, config } = createFixture();
    try {
        const child = runOneShot(root, 'concurrent-enable');
        assert.equal(child.status, 0, child.stderr);
        assert.match(child.stdout, /EXPLICIT_ENABLE_COMMITTED_DURING_ONE_SHOT/u);
        assert.match(child.stdout, /NATIVE_RESET_COMPLETED/u);
        assert.equal(JSON.parse(fs.readFileSync(config, 'utf8')).task_reset.enabled, true);
        assert.equal(resolveTaskResetAvailability(root).enabled, true);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
