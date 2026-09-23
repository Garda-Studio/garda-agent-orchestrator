import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
    assertTaskModeProtectedEntryAllowed,
    buildOrchestratorWorkHandoffCommand,
    TaskModeProtectedManifestEntryError,
    WORKFLOW_CONFIG_TASK_OWNERSHIP_PHRASE,
    type AssertTaskModeProtectedEntryAllowedOptions
} from '../../../../../../src/cli/commands/gate-flows/task-mode/task-mode-entry-protection';
import { createTempRepo } from '../../gate-test-repo-bootstrap';

const WORKFLOW_CONFIG = 'garda-agent-orchestrator/live/config/workflow-config.json';

function baseInput(repoRoot: string): AssertTaskModeProtectedEntryAllowedOptions {
    return {
        repoRoot,
        orchestratorRoot: path.join(repoRoot, 'garda-agent-orchestrator'),
        taskId: 'T-101',
        options: { taskSummary: 'Protect task entry', provider: 'Codex' },
        plannedChangedFiles: [],
        protectedPlannedFiles: [],
        workflowConfigPlannedFiles: [],
        dirtyWorkflowConfigFiles: [],
        workflowConfigPreTaskBaseline: {
            changed_files: [],
            compatibility_baseline_files: [],
            git_changed_files: [],
            protected_manifest_changed_files: [],
            protected_manifest_status: 'present'
        },
        orchestratorWork: false,
        workflowConfigWork: false,
        taskQueueMetadata: null
    };
}

test('task-mode protection allows ordinary entry and requires scope flag plus confirmation for protected source', (t) => {
    const repoRoot = createTempRepo(t);
    fs.writeFileSync(path.join(repoRoot, 'package.json'), '{"name":"garda-agent-orchestrator"}\n', 'utf8');
    const ordinary = baseInput(repoRoot);
    assert.doesNotThrow(() => assertTaskModeProtectedEntryAllowed(ordinary));

    const protectedEntry = {
        ...ordinary,
        plannedChangedFiles: ['src/gates/task-mode/task-mode.ts'],
        protectedPlannedFiles: ['src/gates/task-mode/task-mode.ts']
    };
    assert.throws(() => assertTaskModeProtectedEntryAllowed(protectedEntry), /--orchestrator-work/u);
    assert.match(buildOrchestratorWorkHandoffCommand(
        repoRoot,
        'T-101',
        ordinary.options,
        protectedEntry.plannedChangedFiles
    ), /--operator-confirmed yes.*--planned-changed-file/u);
    assert.throws(() => assertTaskModeProtectedEntryAllowed({
        ...protectedEntry,
        orchestratorWork: true
    }), /operator-confirmed/u);
    assert.doesNotThrow(() => assertTaskModeProtectedEntryAllowed({
        ...protectedEntry,
        orchestratorWork: true,
        options: {
            ...ordinary.options,
            operatorConfirmed: 'yes',
            operatorConfirmedAtUtc: new Date().toISOString()
        }
    }));
});

test('task-mode protection requires workflow config scope and trusted task ownership', (t) => {
    const repoRoot = createTempRepo(t);
    fs.writeFileSync(path.join(repoRoot, 'package.json'), '{"name":"garda-agent-orchestrator"}\n', 'utf8');
    const base = baseInput(repoRoot);
    const configEntry = {
        ...base,
        plannedChangedFiles: [WORKFLOW_CONFIG],
        protectedPlannedFiles: [WORKFLOW_CONFIG],
        workflowConfigPlannedFiles: [WORKFLOW_CONFIG]
    };
    assert.throws(() => assertTaskModeProtectedEntryAllowed(configEntry), /--workflow-config-work/u);
    assert.throws(() => assertTaskModeProtectedEntryAllowed({
        ...configEntry,
        workflowConfigWork: true
    }), /requires --orchestrator-work/u);
    assert.throws(() => assertTaskModeProtectedEntryAllowed({
        ...configEntry,
        orchestratorWork: true,
        workflowConfigWork: true
    }), /trusted TASK\.md metadata/u);
    assert.doesNotThrow(() => assertTaskModeProtectedEntryAllowed({
        ...configEntry,
        orchestratorWork: true,
        workflowConfigWork: true,
        taskQueueMetadata: { notes: WORKFLOW_CONFIG_TASK_OWNERSHIP_PHRASE },
        options: {
            ...base.options,
            operatorConfirmed: 'yes',
            operatorConfirmedAtUtc: new Date().toISOString()
        }
    }));
});

test('task-mode protection rejects dirty workflow config with an invalid trusted manifest', (t) => {
    const repoRoot = createTempRepo(t);
    const base = baseInput(repoRoot);
    assert.throws(() => assertTaskModeProtectedEntryAllowed({
        ...base,
        dirtyWorkflowConfigFiles: [WORKFLOW_CONFIG],
        workflowConfigPreTaskBaseline: {
            ...base.workflowConfigPreTaskBaseline,
            protected_manifest_status: 'invalid'
        }
    }), TaskModeProtectedManifestEntryError);
});

test('task-mode protection distinguishes missing manifest, stale baseline, and pre-entry edits', (t) => {
    const repoRoot = createTempRepo(t);
    const base = baseInput(repoRoot);
    const dirty = { ...base, dirtyWorkflowConfigFiles: [WORKFLOW_CONFIG] };

    assert.throws(() => assertTaskModeProtectedEntryAllowed({
        ...dirty,
        workflowConfigPreTaskBaseline: {
            ...base.workflowConfigPreTaskBaseline,
            protected_manifest_status: 'missing'
        }
    }), (error: unknown) => error instanceof TaskModeProtectedManifestEntryError
        && /manifest is missing/u.test(error.message));

    assert.throws(() => assertTaskModeProtectedEntryAllowed({
        ...dirty,
        workflowConfigPreTaskBaseline: {
            ...base.workflowConfigPreTaskBaseline,
            protected_manifest_changed_files: [WORKFLOW_CONFIG]
        }
    }), (error: unknown) => error instanceof TaskModeProtectedManifestEntryError
        && /manifest is stale/u.test(error.message)
        && /repair protected-manifest/u.test(error.message)
        && /rerun next-step/u.test(error.message));

    assert.throws(() => assertTaskModeProtectedEntryAllowed({
        ...dirty,
        workflowConfigPreTaskBaseline: {
            ...base.workflowConfigPreTaskBaseline,
            git_changed_files: [WORKFLOW_CONFIG]
        }
    }), /Workspace already contains workflow config changes before task-mode entry/u);
});

test('task-mode protection replays only an explicitly authorized dirty workflow config file', (t) => {
    const repoRoot = createTempRepo(t);
    fs.writeFileSync(path.join(repoRoot, 'package.json'), '{"name":"garda-agent-orchestrator"}\n', 'utf8');
    const base = baseInput(repoRoot);
    const replay = {
        ...base,
        plannedChangedFiles: [WORKFLOW_CONFIG],
        protectedPlannedFiles: [WORKFLOW_CONFIG],
        workflowConfigPlannedFiles: [WORKFLOW_CONFIG],
        dirtyWorkflowConfigFiles: [WORKFLOW_CONFIG],
        allowedDirtyWorkflowConfigFiles: [WORKFLOW_CONFIG],
        orchestratorWork: true,
        workflowConfigWork: true,
        taskQueueMetadata: { notes: WORKFLOW_CONFIG_TASK_OWNERSHIP_PHRASE },
        options: {
            ...base.options,
            operatorConfirmed: 'yes',
            operatorConfirmedAtUtc: new Date().toISOString()
        }
    };
    assert.doesNotThrow(() => assertTaskModeProtectedEntryAllowed(replay));
    assert.throws(() => assertTaskModeProtectedEntryAllowed({
        ...replay,
        allowedDirtyWorkflowConfigFiles: []
    }), /Workspace already contains workflow config changes before task-mode entry/u);
    assert.throws(() => assertTaskModeProtectedEntryAllowed({
        ...replay,
        workflowConfigPlannedFiles: []
    }), /Workspace already contains workflow config changes before task-mode entry/u);
});
