import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

import { runClassifyChangeCommand, runLoadRulePackCommand, runRecordNoOpCommand } from '../../../../src/cli/commands/gates';
import { appendTaskEvent, inspectTaskEventFile } from '../../../../src/gate-runtime/task-events';
import { getCurrentNoOpEventSha256, getNoOpEvidence } from '../../../../src/gates/task-mode/no-op';
import { handleWorkflow } from '../../../../src/cli/commands/workflow-command';
import { readWorkflowConfigState } from '../../../../src/cli/commands/workflow/workflow-command-state';
import { writeWorkflowConfig } from '../../../../src/cli/commands/workflow/workflow-command-mutation';
import { getCurrentWorkflowConfigFileHashes } from '../../../../src/gates/workflow-config/workflow-config-work';
import { resolveProtectedControlPlaneManifestPath } from '../../../../src/gates/shared/helpers';
import { readPreflightWorkspaceReadiness } from '../../../../src/gates/next-step/next-step-preflight-workspace-readiness';
import { getWorkspaceSnapshot, resolveNextStep } from './next-step-test-support';
import { initGitRepo } from '../git-fixtures';
import { buildOperatorConfirmationArgs } from '../../cli/commands/operator-confirmation-test-helpers';
import { runHandshakeForTask, runShellSmokeForTask } from '../../cli/commands/gate-test-helpers';
import {
    TASK_ID, makeTempRepo, reviewsRoot, writeJson, fileSha256,
    seedStartedTask
} from './next-step-completion-fixtures';

const WORKFLOW_CONFIG_FILE = 'garda-agent-orchestrator/live/config/workflow-config.json';
const PARENT_FILE = 'src/parent.ts';
const CHILD_FILE = 'src/app.ts';

function setWorkflow(repoRoot: string, args: string[]): void {
    const originalLog = console.log;
    console.log = () => undefined;
    try {
        const result = handleWorkflow([
            'set', '--bundle-root', path.join(repoRoot, 'garda-agent-orchestrator'),
            ...args, ...buildOperatorConfirmationArgs()
        ], { name: 'garda-agent-orchestrator', version: '1.0.0' });
        assert.equal(result?.action, 'set');
    } finally {
        console.log = originalLog;
    }
}

function interruptCommittedPolicyMutation(repoRoot: string, enabled: boolean): void {
    const child = spawnSync(process.execPath, ['-e', `
        const mutation = require(${JSON.stringify(require.resolve('../../../../src/cli/commands/workflow/workflow-command-mutation'))});
        const api = require(${JSON.stringify(require.resolve('../../../../src/cli/commands/workflow/workflow-command-set'))});
        mutation.bindCommittedWorkflowConfigAudit = () => process.exit(79);
        api.handleSet(${JSON.stringify({
            targetRoot: repoRoot, fullSuiteEnabled: String(enabled), operatorConfirmed: 'yes',
            operatorConfirmedAtUtc: new Date().toISOString(), json: true
        })});
    `], { encoding: 'utf8', timeout: 30_000 });
    assert.equal(child.status, 79, child.stderr);
}

function makeChild(options: {
    recordNoOp?: boolean;
    policyChange?: boolean;
    policyRestore?: boolean;
    twoCommands?: boolean;
    replayAuditFromEarlierCycle?: boolean;
    interruptedPolicyRoundTrip?: boolean;
    initialFormatting?: 'compact' | 'crlf' | 'no-final-newline';
} = {}) {
    const repoRoot = makeTempRepo();
    const bundleRoot = path.join(repoRoot, 'garda-agent-orchestrator');
    const configPath = path.join(repoRoot, WORKFLOW_CONFIG_FILE);
    const initialConfig = readWorkflowConfigState(configPath, bundleRoot).rawConfig;
    assert.ok(initialConfig);
    writeWorkflowConfig(configPath, initialConfig);
    if (options.initialFormatting) {
        const canonical = fs.readFileSync(configPath, 'utf8');
        const formatted = options.initialFormatting === 'compact'
            ? JSON.stringify(JSON.parse(canonical))
            : options.initialFormatting === 'crlf'
                ? canonical.replace(/\n/gu, '\r\n') : canonical.trimEnd();
        fs.writeFileSync(configPath, formatted);
    }
    const originalConfigBytes = fs.readFileSync(configPath);
    fs.writeFileSync(path.join(repoRoot, PARENT_FILE), 'export const parent = 1;\n');
    initGitRepo(repoRoot, { gitignoreContent: `TASK.md\ngarda-agent-orchestrator/runtime/\n${WORKFLOW_CONFIG_FILE}\n` });
    fs.appendFileSync(path.join(repoRoot, PARENT_FILE), 'export const pendingParent = 2;\n');
    const parentHash = fileSha256(path.join(repoRoot, PARENT_FILE));
    const baseline = getWorkspaceSnapshot(repoRoot, 'git_auto', true, []);
    const taskModePath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-task-mode.json`);
    const startChildCycle = () => {
        seedStartedTask(repoRoot, TASK_ID, 'Audit an already implemented child beside preserved parent changes');
        const taskMode = JSON.parse(fs.readFileSync(taskModePath, 'utf8')) as Record<string, unknown>;
        taskMode.planned_changed_files = [CHILD_FILE];
        taskMode.dirty_workspace_baseline = {
            ...baseline,
            file_hashes: { [PARENT_FILE]: fileSha256(path.join(repoRoot, PARENT_FILE)) }
        };
        taskMode.workflow_config_file_hashes = getCurrentWorkflowConfigFileHashes(repoRoot);
        writeJson(taskModePath, taskMode);
        runHandshakeForTask(repoRoot, TASK_ID);
        runShellSmokeForTask(repoRoot, TASK_ID);
        return taskMode;
    };
    const taskMode = startChildCycle();
    if (options.interruptedPolicyRoundTrip) {
        interruptCommittedPolicyMutation(repoRoot, true);
        interruptCommittedPolicyMutation(repoRoot, false);
    }
    if (options.policyChange) {
        setWorkflow(repoRoot, ['--full-suite-enabled', 'true']);
    }
    if (options.policyRestore) {
        setWorkflow(repoRoot, ['--full-suite-enabled', 'false']);
    }
    if (options.twoCommands) {
        setWorkflow(repoRoot, ['--full-suite-command', 'node --test tests/first.test.js']);
    }
    setWorkflow(repoRoot, ['--full-suite-command', 'node --test tests/affected.test.js']);
    const auditRecords = fs.readFileSync(path.join(bundleRoot, 'runtime/workflow-config-audit.jsonl'), 'utf8')
        .trim().split(/\r?\n/u).map((line) => JSON.parse(line) as Record<string, unknown>);
    if (!options.initialFormatting) {
        assert.equal(auditRecords[0].before_sha256,
            (taskMode.workflow_config_file_hashes as Record<string, string>)[WORKFLOW_CONFIG_FILE]);
    }
    if (options.replayAuditFromEarlierCycle) {
        const auditedConfigBytes = fs.readFileSync(configPath);
        fs.writeFileSync(configPath, originalConfigBytes);
        const restartedMode = JSON.parse(fs.readFileSync(taskModePath, 'utf8')) as Record<string, unknown>;
        restartedMode.timestamp_utc = new Date().toISOString();
        writeJson(taskModePath, restartedMode);
        appendTaskEvent(bundleRoot, TASK_ID, 'TASK_MODE_ENTERED', 'PASS',
            'Start a fresh task cycle before the unaudited settings replay.', {
                artifact_path: taskModePath,
                start_banner: restartedMode.start_banner,
                canonical_source_of_truth: restartedMode.canonical_source_of_truth,
                execution_provider_source: restartedMode.execution_provider_source,
                runtime_identity_status: restartedMode.runtime_identity_status,
                profile_policy_snapshot_required: true,
                profile_policy_snapshot_hash: (restartedMode.profile_policy_snapshot as Record<string, unknown>).snapshot_hash
            }, { actor: 'gate', passThru: false });
        runHandshakeForTask(repoRoot, TASK_ID);
        runShellSmokeForTask(repoRoot, TASK_ID);
        fs.writeFileSync(configPath, auditedConfigBytes);
    }
    const preflightPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-preflight.json`);
    const classified = runClassifyChangeCommand({
        repoRoot, taskId: TASK_ID, taskIntent: 'Audit already implemented child',
        changedFiles: [CHILD_FILE], outputPath: preflightPath, emitMetrics: false
    });
    const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
    assert.equal(preflight.task_id, TASK_ID, classified.outputText);
    assert.deepEqual(preflight.changed_files, []);
    const rules = runLoadRulePackCommand({
        repoRoot, taskId: TASK_ID, stage: 'POST_PREFLIGHT', preflightPath,
        loadedRuleFiles: ['00-core.md', '15-project-memory.md', '30-code-style.md',
            '35-strict-coding-rules.md', '40-commands.md', '50-structure-and-docs.md',
            '70-security.md', '80-task-workflow.md', '90-skill-catalog.md'],
        emitMetrics: false
    });
    assert.equal(rules.exitCode, 0, rules.outputLines.join('\n'));
    if (options.recordNoOp !== false) {
        const recorded = runRecordNoOpCommand({
            repoRoot, taskId: TASK_ID, classification: 'ALREADY_DONE', preflightPath,
            reason: 'The child source is already committed; the protected parent diff remains unchanged.',
            emitMetrics: false
        });
        assert.equal(recorded.exitCode, 0);
        const noOp = getNoOpEvidence(repoRoot, TASK_ID, '', preflightPath);
        assert.equal(noOp.evidence_status, 'PASS');
        assert.ok(getCurrentNoOpEventSha256(repoRoot, TASK_ID, noOp));
        assert.match(inspectTaskEventFile(path.join(repoRoot,
            'garda-agent-orchestrator/runtime/task-events', `${TASK_ID}.jsonl`), TASK_ID).status, /^PASS/u);
    }
    return { repoRoot, preflightPath, preflight, taskModePath, baseline, parentHash };
}

type ChildFixture = ReturnType<typeof makeChild>;

function readiness(fixture: ChildFixture) {
    return readPreflightWorkspaceReadiness(fixture.repoRoot, fixture.preflight, {
        plannedChangedFiles: [CHILD_FILE],
        dirtyWorkspaceBaselineChangedFiles: [PARENT_FILE],
        dirtyWorkspaceBaselineFileHashes: {
            [PARENT_FILE]: fixture.parentHash
        }
    });
}

function editJson(file: string, edit: (payload: Record<string, unknown>) => void): void {
    const payload = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    edit(payload);
    writeJson(file, payload);
}

function editAudit(fixture: ChildFixture, edit: (records: Record<string, unknown>[]) => void): void {
    const auditPath = path.join(fixture.repoRoot, 'garda-agent-orchestrator/runtime/workflow-config-audit.jsonl');
    const records = fs.readFileSync(auditPath, 'utf8').trim().split(/\r?\n/u)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
    edit(records);
    fs.writeFileSync(auditPath, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
}

describe('authenticated zero-diff closeout beside protected parent WIP', () => {
    it('rejects committed policy changes interrupted before their accepted audit binding', () => {
        const result = readiness(makeChild({ interruptedPolicyRoundTrip: true }));
        assert.equal(result.ready, false, result.reason);
    });

    for (const initialFormatting of ['compact', 'crlf', 'no-final-newline'] as const) {
        it(`accepts a command-only audit from a ${initialFormatting} configuration baseline`, () => {
            const fixture = makeChild({ initialFormatting });
            const result = readiness(fixture);
            assert.equal(result.ready, true, result.reason);
            const audit = JSON.parse(fs.readFileSync(path.join(fixture.repoRoot,
                'garda-agent-orchestrator/runtime/workflow-config-audit.jsonl'), 'utf8'));
            const mode = JSON.parse(fs.readFileSync(fixture.taskModePath, 'utf8'));
            assert.equal(audit.before_sha256, mode.profile_policy_snapshot.config_hashes.workflow_config);
        });
    }

    it('accepts native ALREADY_DONE with an unchanged parent and audited test-command changes', () => {
        const fixture = makeChild({ twoCommands: true });
        const parentBefore = fs.readFileSync(path.join(fixture.repoRoot, PARENT_FILE));
        const result = readiness(fixture);
        assert.equal(result.ready, true, result.reason);
        assert.deepEqual(result.currentChangedFiles, []);
        assert.deepEqual(fs.readFileSync(path.join(fixture.repoRoot, PARENT_FILE)), parentBefore);
        assert.deepEqual(getWorkspaceSnapshot(fixture.repoRoot, 'git_auto', true, []).changed_files, [PARENT_FILE]);
        const next = resolveNextStep({ repoRoot: fixture.repoRoot, taskId: TASK_ID });
        assert.notEqual(next.next_gate, 'classify-change', next.reason);
        assert.ok(!next.commands.some((command) => command.command.includes(`--changed-file "${PARENT_FILE}"`)));
    });

    it('keeps a zero-diff child blocked until the native no-op is recorded', () => {
        const result = readiness(makeChild({ recordNoOp: false }));
        assert.equal(result.ready, false);
        assert.match(result.reason, /Protected workflow-config preflight is underscoped/u);
    });

    it('rejects stale, foreign, unaudited and out-of-scope inputs', () => {
        const fixture = makeChild({ twoCommands: true });
        const guardedFiles = [
            path.join(fixture.repoRoot, CHILD_FILE), path.join(fixture.repoRoot, PARENT_FILE),
            path.join(fixture.repoRoot, 'unowned.ts'), fixture.preflightPath, fixture.taskModePath,
            path.join(reviewsRoot(fixture.repoRoot), `${TASK_ID}-no-op.json`),
            path.join(fixture.repoRoot, WORKFLOW_CONFIG_FILE),
            path.join(fixture.repoRoot, 'garda-agent-orchestrator/runtime/workflow-config-audit.jsonl'),
            path.join(fixture.repoRoot, 'garda-agent-orchestrator/runtime/task-events', `${TASK_ID}.jsonl`),
            resolveProtectedControlPlaneManifestPath(fixture.repoRoot)
        ];
        const originalFiles = new Map(guardedFiles.map((file) => [
            file, fs.existsSync(file) ? fs.readFileSync(file) : null
        ]));
        for (const [label, mutate] of [
        ['a foreign no-op', (f: ChildFixture) => editJson(path.join(reviewsRoot(f.repoRoot), `${TASK_ID}-no-op.json`), (j) => { j.task_id = 'T-FOREIGN-1'; })],
        ['a stale preflight binding', (f: ChildFixture) => {
            editJson(f.preflightPath, (j) => { j.task_intent = 'Changed after the no-op binding'; });
            f.preflight = JSON.parse(fs.readFileSync(f.preflightPath, 'utf8')) as Record<string, unknown>;
        }],
        ['a replay from an earlier task cycle', (f: ChildFixture) => {
            appendTaskEvent(path.join(f.repoRoot, 'garda-agent-orchestrator'), TASK_ID,
                'TASK_MODE_ENTERED', 'PASS', 'Start a later task cycle.', {}, { actor: 'gate', passThru: false });
        }],
        ['a corrupt native timeline', (f: ChildFixture) => {
            const timeline = path.join(f.repoRoot, 'garda-agent-orchestrator/runtime/task-events', `${TASK_ID}.jsonl`);
            fs.appendFileSync(timeline, '{invalid-json\n');
        }],
        ['an unaudited configuration', (f: ChildFixture) => editAudit(f, (records) => { records.length = 0; })],
        ['a foreign settings audit', (f: ChildFixture) => editAudit(f, (records) => { records[0].active_task_ids = ['T-FOREIGN-1']; })],
        ['an incomplete settings audit chain', (f: ChildFixture) => editAudit(f, (records) => { records.shift(); })],
        ['new child source changes', (f: ChildFixture) => { fs.appendFileSync(path.join(f.repoRoot, CHILD_FILE), 'export const child = 2;\n'); }],
        ['a new file outside the child scope', (f: ChildFixture) => { fs.writeFileSync(path.join(f.repoRoot, 'unowned.ts'), 'export const unowned = true;\n'); }],
        ['settings changed after preflight', (f: ChildFixture) => { setWorkflow(f.repoRoot, ['--full-suite-command', 'node --test tests/later.test.js']); }]
        ] as const) {
            try {
                mutate(fixture);
                const result = readiness(fixture);
                assert.equal(result.ready, false, `${label}: ${result.reason}`);
            } finally {
                for (const [file, bytes] of originalFiles) {
                    if (bytes === null) fs.rmSync(file, { force: true });
                    else fs.writeFileSync(file, bytes);
                }
                fixture.preflight = JSON.parse(fs.readFileSync(fixture.preflightPath, 'utf8')) as Record<string, unknown>;
            }
        }
    });

    it('rejects tampered no-op evidence beside protected parent WIP', () => {
        const fixture = makeChild();
        editJson(path.join(reviewsRoot(fixture.repoRoot), `${TASK_ID}-no-op.json`), (j) => {
            j.reason = 'Changed after the native event was recorded.';
        });
        const result = readiness(fixture);
        assert.equal(result.ready, false, result.reason);
    });

    it('rejects parent mutation after audited child no-op', () => {
        const fixture = makeChild();
        fs.appendFileSync(path.join(fixture.repoRoot, PARENT_FILE), 'export const drift = 3;\n');
        const result = readiness(fixture);
        assert.equal(result.ready, false, result.reason);
    });

    it('rejects an audited policy change hidden behind a later test-command-only audit', () => {
        const result = readiness(makeChild({ policyChange: true }));
        assert.equal(result.ready, false, result.reason);
        assert.match(result.reason, /Protected workflow-config preflight is underscoped/u);
    });

    it('rejects a mutable task-mode settings baseline that hides a policy change', () => {
        const fixture = makeChild({ policyChange: true });
        editJson(fixture.taskModePath, (mode) => {
            mode.workflow_config_file_hashes = getCurrentWorkflowConfigFileHashes(fixture.repoRoot);
        });
        const result = readiness(fixture);
        assert.equal(result.ready, false, result.reason);
    });

    it('rejects a policy audit relabeled as a test-command change', () => {
        const fixture = makeChild({ policyChange: true });
        editAudit(fixture, (records) => {
            records[0].changed_fields = ['full_suite_validation.command'];
        });
        const result = readiness(fixture);
        assert.equal(result.ready, false, result.reason);
    });

    it('rejects an old-cycle audit for a fresh unaudited settings change', () => {
        const fixture = makeChild({ twoCommands: true, replayAuditFromEarlierCycle: true });
        const result = readiness(fixture);
        assert.equal(result.ready, false, result.reason);
    });

    it('accepts new current-cycle command audits anchored to the frozen baseline', () => {
        const fixture = makeChild({ twoCommands: true, replayAuditFromEarlierCycle: true });
        assert.equal(readiness(fixture).ready, false);
        setWorkflow(fixture.repoRoot, ['--full-suite-command', 'npm test']);
        setWorkflow(fixture.repoRoot, ['--full-suite-command', 'node --test tests/affected.test.js']);
        const result = readiness(fixture);
        assert.equal(result.ready, true, result.reason);
    });

    it('rejects a policy change restored before a later test-command audit', () => {
        const fixture = makeChild({ policyChange: true, policyRestore: true });
        const result = readiness(fixture);
        assert.equal(result.ready, false, result.reason);
    });
});
