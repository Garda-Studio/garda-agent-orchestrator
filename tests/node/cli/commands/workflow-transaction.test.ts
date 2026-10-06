import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { handleSet } from '../../../../src/cli/commands/workflow/workflow-command-set';
import { buildDefaultWorkflowConfig } from '../../../../src/core/workflow-config';
import { appendMandatoryTaskEvent, readTaskTimelineJsonlEntries } from '../../../../src/gate-runtime/task-events';

const TASK_ID = 'T-WORKFLOW-TRANSACTION-1';

function auditBindings(bundle: string) {
    return readTaskTimelineJsonlEntries(path.join(bundle, 'runtime/task-events', `${TASK_ID}.jsonl`))
        .filter(({ record }) => record?.event_type === 'WORKFLOW_CONFIG_MUTATION_AUDITED');
}

function fixture(): { root: string; bundle: string; config: string } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-workflow-transaction-'));
    const bundle = path.join(root, 'garda-agent-orchestrator');
    const config = path.join(bundle, 'live/config/workflow-config.json');
    fs.mkdirSync(path.dirname(config), { recursive: true });
    fs.writeFileSync(config, JSON.stringify(buildDefaultWorkflowConfig(), null, 2) + '\n');
    appendMandatoryTaskEvent(bundle, TASK_ID, 'TASK_MODE_ENTERED', 'PASS', 'Start transaction owner.', {}, { actor: 'gate' });
    return { root, bundle, config };
}

function options(root: string): Record<string, string | boolean> {
    return {
        targetRoot: root, taskResetEnabled: 'true', operatorConfirmed: 'yes',
        operatorConfirmedAtUtc: new Date().toISOString(), json: true
    };
}

test('workflow transaction binds the audit only after config and manifest publication commit', () => {
    const { root, bundle, config } = fixture();
    try {
        handleSet(options(root));
        assert.equal(JSON.parse(fs.readFileSync(config, 'utf8')).task_reset.enabled, true);
        const bindings = auditBindings(bundle);
        assert.equal(bindings.length, 1);
        assert.equal(bindings[0].record?.outcome, 'PASS');
        const record = JSON.parse(fs.readFileSync(path.join(bundle, 'runtime/workflow-config-audit.jsonl'), 'utf8'));
        assert.equal(record.command_only_change, false);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('workflow transaction restores config and audit when manifest publication fails', () => {
    const { root, bundle, config } = fixture();
    const before = fs.readFileSync(config);
    const realFs = require('node:fs') as typeof fs;
    const rename = realFs.renameSync;
    try {
        realFs.renameSync = (from, to) => {
            if (String(to).endsWith('protected-control-plane-manifest.json')) throw new Error('injected manifest failure');
            return rename(from, to);
        };
        assert.throws(() => handleSet(options(root)), /injected manifest failure/);
        assert.deepEqual(fs.readFileSync(config), before);
        assert.equal(fs.existsSync(path.join(bundle, 'runtime/workflow-config-audit.jsonl')), false);
        assert.equal(fs.existsSync(path.join(bundle, 'live/config/task-reset-enablement-receipt.json')), false);
        assert.equal(auditBindings(bundle).length, 0);
    } finally {
        realFs.renameSync = rename;
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('workflow transaction retains pending cycle evidence when interrupted after commit', () => {
    const { root, bundle, config } = fixture();
    try {
        const child = spawnSync(process.execPath, ['-e', `
            const mutation = require(${JSON.stringify(require.resolve('../../../../src/cli/commands/workflow/workflow-command-mutation'))});
            const api = require(${JSON.stringify(require.resolve('../../../../src/cli/commands/workflow/workflow-command-set'))});
            mutation.bindCommittedWorkflowConfigAudit = () => process.exit(79);
            api.handleSet(${JSON.stringify(options(root))});
        `], { encoding: 'utf8', timeout: 30_000 });
        assert.equal(child.status, 79, child.stderr);
        assert.equal(JSON.parse(fs.readFileSync(config, 'utf8')).task_reset.enabled, true);
        const record = JSON.parse(fs.readFileSync(path.join(bundle, 'runtime/workflow-config-audit.jsonl'), 'utf8'));
        assert.equal(record.command_only_change, false);
        const prepared = readTaskTimelineJsonlEntries(path.join(bundle, 'runtime/task-events', `${TASK_ID}.jsonl`))
            .filter(({ record: event }) => event?.event_type === 'WORKFLOW_CONFIG_MUTATION_PREPARED');
        assert.equal(prepared.length, 1);
        assert.equal(prepared[0].record?.outcome, 'INFO');
        assert.equal(auditBindings(bundle).length, 0);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('workflow transaction recovers an interrupted audit publication before the next mutation', () => {
    const { root, bundle, config } = fixture();
    const before = fs.readFileSync(config, 'utf8');
    try {
        const child = spawnSync(process.execPath, ['-e', `
            const fs = require('node:fs');
            const api = require(${JSON.stringify(require.resolve('../../../../src/cli/commands/workflow/workflow-command-set'))});
            const rename = fs.renameSync;
            fs.renameSync = (from, to) => {
                if (String(to).endsWith('workflow-config-audit.jsonl')) process.exit(78);
                return rename(from, to);
            };
            api.handleSet(${JSON.stringify(options(root))});
        `], { encoding: 'utf8', timeout: 30_000 });
        assert.equal(child.status, 78, child.stderr);
        // A subsequent no-op is enough to recover the previous generation.
        handleSet({ targetRoot: root, taskResetEnabled: 'false', json: true });
        assert.equal(fs.readFileSync(config, 'utf8'), before);
        assert.equal(fs.existsSync(path.join(bundle, 'runtime/workflow-config-audit.jsonl')), false);
        assert.equal(auditBindings(bundle).length, 0);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
