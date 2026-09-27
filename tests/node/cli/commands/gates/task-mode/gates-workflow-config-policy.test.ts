import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { handleWorkflow } from '../../../../../../src/cli/commands/workflow-command';
import { handleGate } from '../../../../../../src/cli/commands/gate-command';
import {
    runDocImpactGateCommand,
    runRequiredReviewsCheckCommand
} from '../../../../../../src/cli/commands/gates';
import { WORKFLOW_CONFIG_TASK_OWNERSHIP_PHRASE } from '../../../../../../src/cli/commands/gate-flows/task-mode/task-mode-flow';
import {
    recordTaskModeProtectedManifestFailure,
    runRecoverTaskModeProtectedManifestCommand
} from '../../../../../../src/cli/commands/gate-flows/task-mode/task-mode-entry-failure';
import { runCompileGateCommand } from '../../../../../../src/cli/commands/gate-flows/compile/compile-flow';
import { runFullSuiteValidationCommand } from '../../../../../../src/cli/commands/gate-flows/full-suite/full-suite-validation-flow';
import { UNCONFIGURED_COMPILE_GATE_COMMAND } from '../../../../../../src/core/constants';
import { runCompletionGate } from '../../../../../../src/gates/completion';
import { isWorkflowConfigControlPlanePath, writeProtectedControlPlaneManifest } from '../../../../../../src/gates/shared/helpers';
import { getTaskModeEvidence } from '../../../../../../src/gates/task-mode';
import {
    getAuditedWorkflowConfigChangeProvenance,
    getCurrentWorkflowConfigChanges,
    getCurrentWorkflowConfigFileHashes,
    getWorkflowConfigControlPlanePaths,
    getWorkflowConfigPreTaskBaselineState,
    getWorkflowConfigWorkViolations
} from '../../../../../../src/gates/workflow-config/workflow-config-work';
import {
    createTempRepo,
    getReviewsRoot,
    initializeGitRepo,
    loadTaskEntryRulePack,
    loadPostPreflightRulePack,
    runClassifyChangeCommand,
    runEnterTaskMode,
    runHandshakeForTask,
    runShellSmokeForTask,
    seedInitAnswers,
    seedTaskQueue,
    writeBalancedProfilesConfig,
    writeCleanReviewArtifact,
    writeCompilePassEvidence,
    writePreflight
} from '../../gate-test-helpers';
import { buildOperatorConfirmationArgs } from '../../operator-confirmation-test-helpers';

const PACKAGE_JSON = { name: 'garda-agent-orchestrator', version: '1.0.0' };

function captureConsole<T>(run: () => T): T {
    const originalConsoleLog = console.log;
    console.log = () => undefined;
    try {
        return run();
    } finally {
        console.log = originalConsoleLog;
    }
}

function writeIgnoredRuntimePolicy(repoRoot: string, options: { ignoreBundle?: boolean } = {}): void {
    fs.writeFileSync(path.join(repoRoot, '.gitignore'), [
        'TASK.md',
        'garda-agent-orchestrator/runtime/',
        ...(options.ignoreBundle ? ['garda-agent-orchestrator/'] : [])
    ].join('\n') + '\n', 'utf8');
}

function writeBaselineAgentEntrypoint(repoRoot: string): void {
    fs.writeFileSync(path.join(repoRoot, 'AGENTS.md'), '# baseline\n', 'utf8');
}

function markAsSourceCheckout(repoRoot: string): void {
    fs.writeFileSync(path.join(repoRoot, 'package.json'), JSON.stringify(PACKAGE_JSON, null, 2), 'utf8');
}

function seedWorkflowConfigTaskQueue(repoRoot: string, taskId: string, status = 'TODO'): void {
    fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
        '| ID | Status | Priority | Area | Title | Assignee | Updated | Profile | Notes |',
        '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
        `| ${taskId} | ${status} | P1 | workflow | Update ${WORKFLOW_CONFIG_TASK_OWNERSHIP_PHRASE} | unassigned | 2026-03-28 | default | Explicitly owns ${WORKFLOW_CONFIG_TASK_OWNERSHIP_PHRASE}. |`
    ].join('\n'), 'utf8');
}

function seedIncidentalWorkflowConfigMentionTaskQueue(repoRoot: string, taskId: string, status = 'TODO'): void {
    fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
        '| ID | Status | Priority | Area | Title | Assignee | Updated | Profile | Notes |',
        '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
        `| ${taskId} | ${status} | P1 | workflow | Inspect workflow-config.json docs | unassigned | 2026-03-28 | default | Mentions workflow-config.json but does not own the protected policy contract. |`
    ].join('\n'), 'utf8');
}

function prepareTaskRepo(
    taskId: string,
    options: {
        orchestratorWork?: boolean;
        workflowConfigWork?: boolean;
        ignoreBundle?: boolean;
    } = {}
): string {
    const repoRoot = createTempRepo();
    const taskSummary = 'Update app flow';
    writeIgnoredRuntimePolicy(repoRoot, { ignoreBundle: options.ignoreBundle === true });
    markAsSourceCheckout(repoRoot);
    writeBaselineAgentEntrypoint(repoRoot);
    if (options.workflowConfigWork === true) {
        seedWorkflowConfigTaskQueue(repoRoot, taskId);
    } else {
        seedTaskQueue(repoRoot, taskId);
    }
    seedInitAnswers(repoRoot);
    writeBalancedProfilesConfig(repoRoot);
    initializeGitRepo(repoRoot);
    if (options.ignoreBundle === true) {
        writeProtectedControlPlaneManifest(repoRoot);
    }

    runEnterTaskMode({
        repoRoot,
        taskId,
        orchestratorWork: options.orchestratorWork === true,
        workflowConfigWork: options.workflowConfigWork === true,
        operatorConfirmed: options.orchestratorWork === true || options.workflowConfigWork === true ? 'yes' : undefined,
        operatorConfirmedAtUtc: options.orchestratorWork === true || options.workflowConfigWork === true
            ? new Date().toISOString()
            : undefined,
        plannedChangedFiles: options.workflowConfigWork === true
            ? ['garda-agent-orchestrator/live/config/workflow-config.json']
            : [],
        taskSummary
    });
    const rulePackResult = loadTaskEntryRulePack(repoRoot, taskId);
    assert.equal(rulePackResult.exitCode, 0);
    runHandshakeForTask(repoRoot, taskId);
    runShellSmokeForTask(repoRoot, taskId);
    return repoRoot;
}

function weakenOutOfScopePolicy(repoRoot: string): void {
    const configPath = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
        full_suite_validation: { enabled?: boolean; out_of_scope_failure_policy: string };
    };
    config.full_suite_validation.out_of_scope_failure_policy = 'AUDIT_AND_WARN';
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
}

function weakenFullSuiteCommand(repoRoot: string): void {
    const configPath = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
        full_suite_validation: { enabled?: boolean; command?: string };
    };
    config.full_suite_validation.command = 'true';
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
}

function weakenFullSuiteTimeoutBlocker(repoRoot: string): void {
    const configPath = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
        full_suite_validation: { timeout_blocker?: boolean };
    };
    config.full_suite_validation.timeout_blocker = false;
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
}

function weakenFullSuiteTimeoutRetryCount(repoRoot: string): void {
    const configPath = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
        full_suite_validation: { timeout_retry_count?: number };
    };
    config.full_suite_validation.timeout_retry_count = 0;
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
}


function enableProjectMemoryMaintenancePolicy(repoRoot: string): void {
    const configPath = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
        project_memory_maintenance: {
            enabled?: boolean;
            mode?: string;
            run_before_final_closeout?: boolean;
            require_user_approval_for_writes?: boolean;
        };
    };
    config.project_memory_maintenance.enabled = true;
    config.project_memory_maintenance.mode = 'update';
    config.project_memory_maintenance.run_before_final_closeout = true;
    config.project_memory_maintenance.require_user_approval_for_writes = true;
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
}

function resetCompileGateCommandToUnconfigured(repoRoot: string): void {
    const configPath = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
        compile_gate?: { command?: string };
    };
    config.compile_gate = {
        ...(config.compile_gate || {}),
        command: UNCONFIGURED_COMPILE_GATE_COMMAND
    };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
}

function weakenProjectMemoryMaintenance(repoRoot: string): void {
    const configPath = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
        project_memory_maintenance: { enabled?: boolean };
    };
    config.project_memory_maintenance.enabled = false;
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
}

function weakenProjectMemoryApproval(repoRoot: string): void {
    const configPath = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
        project_memory_maintenance: { require_user_approval_for_writes?: boolean };
    };
    config.project_memory_maintenance.require_user_approval_for_writes = false;
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
}

function weakenProjectMemoryRetention(repoRoot: string): void {
    const configPath = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
        project_memory_maintenance: { impact_artifact_retention_days?: number };
    };
    config.project_memory_maintenance.impact_artifact_retention_days = 1;
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
}

function weakenScopeBudgetGuard(repoRoot: string): void {
    const configPath = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
        scope_budget_guard: { max_changed_lines?: number };
    };
    config.scope_budget_guard.max_changed_lines = 999999;
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
}

function setScopeBudgetMaxRequiredReviews(repoRoot: string, maxRequiredReviews: number): void {
    const configPath = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
        scope_budget_guard: { max_required_reviews?: number };
    };
    config.scope_budget_guard.max_required_reviews = maxRequiredReviews;
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
}

function weakenReviewCycleExcludedReviews(repoRoot: string): void {
    const configPath = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
        review_cycle_guard: { excluded_review_types?: string[] };
    };
    config.review_cycle_guard.excluded_review_types = ['test', 'code', 'security'];
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
}

function weakenReviewExecutionPolicy(repoRoot: string): void {
    const configPath = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
        review_execution_policy: { mode?: string };
    };
    config.review_execution_policy.mode = 'test_after_code';
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
}

function addUnknownTopLevelWorkflowConfigKey(repoRoot: string): void {
    const configPath = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    config.future_policy_toggle = { enabled: false };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
}

function addUnknownWorkflowConfigSectionKey(repoRoot: string): void {
    const configPath = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
        full_suite_validation: Record<string, unknown>;
    };
    config.full_suite_validation.future_policy_toggle = false;
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
}

function removeReviewExecutionPolicy(repoRoot: string): void {
    const configPath = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    delete config.review_execution_policy;
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
}

function weakenReviewDelegationPolicy(repoRoot: string): void {
    const configPath = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
        review_delegation: { no_delegate?: boolean };
    };
    config.review_delegation.no_delegate = true;
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
}

function customizeOptionalQualityCheckRule(repoRoot: string): void {
    const configPath = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
        optional_quality_checks: {
            rules: Array<{ prompt?: string }>;
        };
    };
    config.optional_quality_checks.rules[0].prompt = 'Custom pre-review instruction';
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
}

function weakenOptionalQualityCheckCadence(repoRoot: string): void {
    const configPath = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
        optional_quality_checks: { review_failure_cadence_interval?: number };
    };
    config.optional_quality_checks.review_failure_cadence_interval = 4;
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
}

function customizeOptionalQualityCheckRuleIncludeFilter(repoRoot: string): void {
    const configPath = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
        optional_quality_checks: {
            rules: Array<{
                id?: string;
                included_changed_file_regexes?: string[];
            }>;
        };
    };
    const rule = config.optional_quality_checks.rules.find((candidate) => candidate.id === 'ops_shell_strict_error_handling');
    assert.ok(rule);
    rule.included_changed_file_regexes = ['(^|/).*\\.ts$'];
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
}

function corruptProtectedControlPlaneManifest(repoRoot: string): void {
    const manifestPath = path.join(
        repoRoot,
        'garda-agent-orchestrator',
        'runtime',
        'protected-control-plane-manifest.json'
    );
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.writeFileSync(manifestPath, '{ invalid json\n', 'utf8');
}

function writeTamperedProtectedControlPlaneManifest(repoRoot: string): void {
    const manifestPath = path.join(
        repoRoot,
        'garda-agent-orchestrator',
        'runtime',
        'protected-control-plane-manifest.json'
    );
    const configPath = path.join(
        repoRoot,
        'garda-agent-orchestrator',
        'live',
        'config',
        'workflow-config.json'
    );
    const currentHash = crypto.createHash('sha256')
        .update(fs.readFileSync(configPath))
        .digest('hex');
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.writeFileSync(manifestPath, JSON.stringify({
        schema_version: 1,
        event_source: 'refresh-protected-control-plane-manifest',
        protected_snapshot: {
            'garda-agent-orchestrator/live/config/workflow-config.json': currentHash
        },
        protected_snapshot_sha256: '0'.repeat(64)
    }, null, 2) + '\n', 'utf8');
}

function writeLegacyDigestlessProtectedControlPlaneManifest(repoRoot: string): void {
    const manifestPath = path.join(
        repoRoot,
        'garda-agent-orchestrator',
        'runtime',
        'protected-control-plane-manifest.json'
    );
    const configPath = path.join(
        repoRoot,
        'garda-agent-orchestrator',
        'live',
        'config',
        'workflow-config.json'
    );
    const currentHash = crypto.createHash('sha256')
        .update(fs.readFileSync(configPath))
        .digest('hex');
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.writeFileSync(manifestPath, JSON.stringify({
        schema_version: 1,
        event_source: 'refresh-protected-control-plane-manifest',
        protected_snapshot: {
            'garda-agent-orchestrator/live/config/workflow-config.json': currentHash
        }
    }, null, 2) + '\n', 'utf8');
}

function weakenBundleRootOutOfScopePolicy(repoRoot: string): void {
    const configPath = path.join(repoRoot, 'live', 'config', 'workflow-config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
        full_suite_validation: { out_of_scope_failure_policy: string };
    };
    config.full_suite_validation.out_of_scope_failure_policy = 'AUDIT_AND_WARN';
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
}

function makeBundleRootLike(repoRoot: string): void {
    fs.mkdirSync(path.join(repoRoot, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, 'package.json'), JSON.stringify(PACKAGE_JSON, null, 2) + '\n', 'utf8');
    fs.writeFileSync(path.join(repoRoot, 'VERSION'), '1.0.0\n', 'utf8');
    fs.writeFileSync(path.join(repoRoot, 'MANIFEST.md'), '# test bundle\n', 'utf8');
    fs.writeFileSync(path.join(repoRoot, 'bin', 'garda.js'), '#!/usr/bin/env node\n', 'utf8');
}

function editAppFile(repoRoot: string): string {
    const relativePath = 'src/app.ts';
    fs.appendFileSync(path.join(repoRoot, relativePath), '\nconsole.log("scoped app edit");\n', 'utf8');
    return relativePath;
}

describe('cli/commands/gates — workflow-config protected control-plane', () => {
    it('does not classify arbitrary app workflow-config lookalike paths as Garda workflow config', () => {
        assert.equal(isWorkflowConfigControlPlanePath('packages/foo/live/config/workflow-config.json'), false);
        assert.equal(isWorkflowConfigControlPlanePath('garda-agent-orchestrator/live/config/workflow-config.json'), true);
        assert.equal(isWorkflowConfigControlPlanePath('live/config/workflow-config.json'), true);
        assert.equal(isWorkflowConfigControlPlanePath('template/config/workflow-config.json'), true);
    });

    it('detects workflow-config edits when repoRoot is the bundle root', { concurrency: false }, () => {
        const outerRoot = createTempRepo();
        const repoRoot = path.join(outerRoot, 'garda-agent-orchestrator');

        try {
            makeBundleRootLike(repoRoot);
            const baseline = getCurrentWorkflowConfigFileHashes(repoRoot);
            assert.ok(getWorkflowConfigControlPlanePaths(repoRoot).includes('live/config/workflow-config.json'));
            assert.equal(typeof baseline['live/config/workflow-config.json'], 'string');

            weakenBundleRootOutOfScopePolicy(repoRoot);
            const changes = getCurrentWorkflowConfigChanges(repoRoot, baseline);

            assert.deepEqual(changes.changed_files, ['live/config/workflow-config.json']);
        } finally {
            fs.rmSync(outerRoot, { recursive: true, force: true });
        }
    });

    it('keeps the fixed bundle workflow config protected', { concurrency: false }, () => {
        const repoRoot = createTempRepo();
        const configPath = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json');

        try {
            fs.mkdirSync(path.dirname(configPath), { recursive: true });
            fs.writeFileSync(configPath, JSON.stringify({
                full_suite_validation: { out_of_scope_failure_policy: 'FAIL' }
            }, null, 2) + '\n', 'utf8');
            const baseline = getCurrentWorkflowConfigFileHashes(repoRoot);
            assert.ok(getWorkflowConfigControlPlanePaths(repoRoot).includes(
                'garda-agent-orchestrator/live/config/workflow-config.json'
            ));

            fs.writeFileSync(configPath, JSON.stringify({
                full_suite_validation: { out_of_scope_failure_policy: 'AUDIT_AND_WARN' }
            }, null, 2) + '\n', 'utf8');
            const changes = getCurrentWorkflowConfigChanges(repoRoot, baseline);

            assert.deepEqual(changes.changed_files, ['garda-agent-orchestrator/live/config/workflow-config.json']);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('blocks inconsistent workflow-config task-mode evidence without broad orchestrator work', () => {
        const violations = getWorkflowConfigWorkViolations({
            changedFiles: ['garda-agent-orchestrator/live/config/workflow-config.json'],
            taskModeEvidence: {
                workflow_config_work: true,
                orchestrator_work: false
            },
            phaseLabel: 'preflight'
        });

        assert.match(violations.join('\n'), /--workflow-config-work requires --orchestrator-work/);
    });

    it('rejects workflow-config task mode without broad orchestrator work', { concurrency: false }, () => {
        const taskId = 'T-900workflow-config-flag-pair';
        const repoRoot = createTempRepo();

        try {
            writeIgnoredRuntimePolicy(repoRoot);
            markAsSourceCheckout(repoRoot);
            writeBaselineAgentEntrypoint(repoRoot);
            seedTaskQueue(repoRoot, taskId);
            seedInitAnswers(repoRoot);
            enableProjectMemoryMaintenancePolicy(repoRoot);
            resetCompileGateCommandToUnconfigured(repoRoot);
            initializeGitRepo(repoRoot);

            assert.throws(
                () => runEnterTaskMode({
                    repoRoot,
                    taskId,
                    workflowConfigWork: true,
                    taskSummary: 'Update orchestrator workflow config'
                }),
                /--workflow-config-work requires --orchestrator-work/
            );
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('allows workflow-config task mode for ordinary tasks when both workflow flags are explicit', { concurrency: false }, () => {
        const taskId = 'T-900workflow-config-ordinary-task-flags';
        const repoRoot = createTempRepo();

        try {
            writeIgnoredRuntimePolicy(repoRoot);
            markAsSourceCheckout(repoRoot);
            writeBaselineAgentEntrypoint(repoRoot);
            seedWorkflowConfigTaskQueue(repoRoot, taskId);
            seedInitAnswers(repoRoot);
            initializeGitRepo(repoRoot);

            const result = runEnterTaskMode({
                repoRoot,
                taskId,
                orchestratorWork: true,
                workflowConfigWork: true,
                operatorConfirmed: 'yes',
                operatorConfirmedAtUtc: new Date().toISOString(),
                plannedChangedFiles: ['garda-agent-orchestrator/live/config/workflow-config.json'],
                taskSummary: 'Update app flow'
            });
            assert.equal(result.exitCode, 0);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('rejects incidental workflow-config mentions without the exact ownership phrase', { concurrency: false }, () => {
        const taskId = 'T-900workflow-config-incidental-mention';
        const repoRoot = createTempRepo();

        try {
            writeIgnoredRuntimePolicy(repoRoot);
            markAsSourceCheckout(repoRoot);
            writeBaselineAgentEntrypoint(repoRoot);
            seedIncidentalWorkflowConfigMentionTaskQueue(repoRoot, taskId);
            seedInitAnswers(repoRoot);
            initializeGitRepo(repoRoot);

            assert.throws(
                () => runEnterTaskMode({
                    repoRoot,
                    taskId,
                    orchestratorWork: true,
                    workflowConfigWork: true,
                    operatorConfirmed: 'yes',
                    operatorConfirmedAtUtc: new Date().toISOString(),
                    plannedChangedFiles: ['garda-agent-orchestrator/live/config/workflow-config.json'],
                    taskSummary: 'Update app flow'
                }),
                (error: unknown) => {
                    const message = error instanceof Error ? error.message : String(error);
                    assert.match(message, /requires trusted TASK\.md metadata/);
                    assert.match(message, new RegExp(WORKFLOW_CONFIG_TASK_OWNERSHIP_PHRASE));
                    assert.doesNotMatch(message, /mention workflow-config\.json/);
                    return true;
                }
            );
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('persists invalid-manifest entry failure when the protected manifest is missing', { concurrency: false }, () => {
        const taskId = 'T-900workflow-config-dirty-before-task-mode';
        const repoRoot = createTempRepo();

        try {
            writeIgnoredRuntimePolicy(repoRoot);
            writeBaselineAgentEntrypoint(repoRoot);
            seedTaskQueue(repoRoot, taskId);
            seedInitAnswers(repoRoot);
            enableProjectMemoryMaintenancePolicy(repoRoot);
            resetCompileGateCommandToUnconfigured(repoRoot);
            initializeGitRepo(repoRoot);
            weakenOutOfScopePolicy(repoRoot);

            const options = {
                repoRoot, taskId, orchestratorWork: true, workflowConfigWork: true,
                operatorConfirmed: 'yes', operatorConfirmedAtUtc: new Date().toISOString(),
                taskSummary: 'Update orchestrator workflow config'
            };
            let entryError: unknown;
            try {
                runEnterTaskMode(options);
            } catch (error: unknown) {
                entryError = error;
            }
            assert.match(String(entryError), /protected control-plane manifest is missing before task-mode entry/);
            assert.equal(recordTaskModeProtectedManifestFailure(options, entryError), true);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('routes ignored workflow-config trusted-manifest drift to repair guidance before task-mode entry', { concurrency: false }, () => {
        const taskId = 'T-900workflow-config-ignored-dirty-before-task-mode';
        const repoRoot = createTempRepo();

        try {
            writeIgnoredRuntimePolicy(repoRoot, { ignoreBundle: true });
            writeBaselineAgentEntrypoint(repoRoot);
            seedTaskQueue(repoRoot, taskId);
            seedInitAnswers(repoRoot);
            enableProjectMemoryMaintenancePolicy(repoRoot);
            resetCompileGateCommandToUnconfigured(repoRoot);
            initializeGitRepo(repoRoot);
            writeProtectedControlPlaneManifest(repoRoot);
            weakenOutOfScopePolicy(repoRoot);

            const baselineState = getWorkflowConfigPreTaskBaselineState(repoRoot);
            assert.deepEqual(baselineState.git_changed_files, []);
            assert.deepEqual(baselineState.protected_manifest_changed_files, [
                'garda-agent-orchestrator/live/config/workflow-config.json'
            ]);

            assert.throws(
                () => runEnterTaskMode({
                    repoRoot,
                    taskId,
                    orchestratorWork: true,
                    workflowConfigWork: true,
                    operatorConfirmed: 'yes',
                    operatorConfirmedAtUtc: new Date().toISOString(),
                    taskSummary: 'Update orchestrator workflow config'
                }),
                (error: unknown) => {
                    const message = error instanceof Error ? error.message : String(error);
                    assert.match(message, /Trusted protected control-plane manifest is stale before task-mode entry/);
                    assert.match(message, /repair protected-manifest --target-root "\." --confirm/);
                    assert.doesNotMatch(message, /already contains workflow config changes before task-mode entry/);
                    return true;
                }
            );
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('allows ignored pre-existing materialized workflow-config when no trusted baseline exists yet', { concurrency: false }, () => {
        const taskId = 'T-900workflow-config-upgrade-ignored-baseline';
        const repoRoot = createTempRepo();

        try {
            writeIgnoredRuntimePolicy(repoRoot, { ignoreBundle: true });
            writeBaselineAgentEntrypoint(repoRoot);
            seedTaskQueue(repoRoot, taskId);
            seedInitAnswers(repoRoot);
            enableProjectMemoryMaintenancePolicy(repoRoot);
            resetCompileGateCommandToUnconfigured(repoRoot);
            initializeGitRepo(repoRoot);

            const baselineState = getWorkflowConfigPreTaskBaselineState(repoRoot);
            assert.deepEqual(baselineState.changed_files, []);
            assert.ok(baselineState.compatibility_baseline_files.includes(
                'garda-agent-orchestrator/live/config/workflow-config.json'
            ));

            const result = runEnterTaskMode({
                repoRoot,
                taskId,
                taskSummary: 'Start after workflow-config baseline upgrade'
            });
            assert.equal(result.exitCode, 0);
            assert.ok(result.outputLines.includes('WorkflowConfigCompatibilityBaselineCount: 1'));

            const evidence = getTaskModeEvidence(repoRoot, taskId);
            assert.deepEqual(evidence.workflow_config_compatibility_baseline_files, [
                'garda-agent-orchestrator/live/config/workflow-config.json'
            ]);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('allows ignored pre-existing materialized workflow-config with legacy required-review limit', { concurrency: false }, () => {
        const taskId = 'T-900workflow-config-upgrade-ignored-legacy-review-limit';
        const repoRoot = createTempRepo();

        try {
            writeIgnoredRuntimePolicy(repoRoot, { ignoreBundle: true });
            writeBaselineAgentEntrypoint(repoRoot);
            seedTaskQueue(repoRoot, taskId);
            seedInitAnswers(repoRoot);
            enableProjectMemoryMaintenancePolicy(repoRoot);
            resetCompileGateCommandToUnconfigured(repoRoot);
            initializeGitRepo(repoRoot);
            setScopeBudgetMaxRequiredReviews(repoRoot, 6);

            const baselineState = getWorkflowConfigPreTaskBaselineState(repoRoot);
            assert.deepEqual(baselineState.changed_files, []);
            assert.ok(baselineState.compatibility_baseline_files.includes(
                'garda-agent-orchestrator/live/config/workflow-config.json'
            ));

            const result = runEnterTaskMode({
                repoRoot,
                taskId,
                taskSummary: 'Start after workflow-config baseline upgrade with legacy required-review limit'
            });
            assert.equal(result.exitCode, 0);
            assert.ok(result.outputLines.includes('WorkflowConfigCompatibilityBaselineCount: 1'));
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('allows ignored pre-existing legacy generated workflow-config when no trusted baseline exists yet', { concurrency: false }, () => {
        const taskId = 'T-900workflow-config-upgrade-ignored-generated-legacy-baseline';
        const repoRoot = createTempRepo();

        try {
            writeIgnoredRuntimePolicy(repoRoot, { ignoreBundle: true });
            writeBaselineAgentEntrypoint(repoRoot);
            seedTaskQueue(repoRoot, taskId);
            seedInitAnswers(repoRoot);
            resetCompileGateCommandToUnconfigured(repoRoot);
            initializeGitRepo(repoRoot);

            const baselineState = getWorkflowConfigPreTaskBaselineState(repoRoot);
            assert.deepEqual(baselineState.changed_files, []);
            assert.ok(baselineState.compatibility_baseline_files.includes(
                'garda-agent-orchestrator/live/config/workflow-config.json'
            ));

            const result = runEnterTaskMode({
                repoRoot,
                taskId,
                taskSummary: 'Start after legacy generated workflow-config baseline upgrade'
            });
            assert.equal(result.exitCode, 0);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('blocks ignored pre-existing materialized workflow-config above the legacy required-review limit', { concurrency: false }, () => {
        const taskId = 'T-900workflow-config-upgrade-ignored-high-review-limit';
        const repoRoot = createTempRepo();

        try {
            writeIgnoredRuntimePolicy(repoRoot, { ignoreBundle: true });
            writeBaselineAgentEntrypoint(repoRoot);
            seedTaskQueue(repoRoot, taskId);
            seedInitAnswers(repoRoot);
            enableProjectMemoryMaintenancePolicy(repoRoot);
            resetCompileGateCommandToUnconfigured(repoRoot);
            initializeGitRepo(repoRoot);
            setScopeBudgetMaxRequiredReviews(repoRoot, 7);

            const baselineState = getWorkflowConfigPreTaskBaselineState(repoRoot);
            assert.deepEqual(baselineState.compatibility_baseline_files, []);
            assert.deepEqual(baselineState.changed_files, [
                'garda-agent-orchestrator/live/config/workflow-config.json'
            ]);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('allows ignored pre-existing legacy materialized workflow-config without review execution policy', { concurrency: false }, () => {
        const taskId = 'T-900workflow-config-upgrade-ignored-legacy-review-policy';
        const repoRoot = createTempRepo();

        try {
            writeIgnoredRuntimePolicy(repoRoot, { ignoreBundle: true });
            writeBaselineAgentEntrypoint(repoRoot);
            seedTaskQueue(repoRoot, taskId);
            seedInitAnswers(repoRoot);
            enableProjectMemoryMaintenancePolicy(repoRoot);
            resetCompileGateCommandToUnconfigured(repoRoot);
            initializeGitRepo(repoRoot);
            removeReviewExecutionPolicy(repoRoot);

            const baselineState = getWorkflowConfigPreTaskBaselineState(repoRoot);
            assert.deepEqual(baselineState.changed_files, []);
            assert.ok(baselineState.compatibility_baseline_files.includes(
                'garda-agent-orchestrator/live/config/workflow-config.json'
            ));
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('blocks ignored pre-existing materialized workflow-config when protected manifest is invalid', { concurrency: false }, () => {
        const taskId = 'T-900workflow-config-upgrade-ignored-invalid-manifest';
        const repoRoot = createTempRepo();

        try {
            writeIgnoredRuntimePolicy(repoRoot, { ignoreBundle: true });
            writeBaselineAgentEntrypoint(repoRoot);
            seedTaskQueue(repoRoot, taskId);
            seedInitAnswers(repoRoot);
            enableProjectMemoryMaintenancePolicy(repoRoot);
            initializeGitRepo(repoRoot);
            corruptProtectedControlPlaneManifest(repoRoot);

            const baselineState = getWorkflowConfigPreTaskBaselineState(repoRoot);
            assert.deepEqual(baselineState.compatibility_baseline_files, []);
            assert.ok(baselineState.changed_files.includes(
                'garda-agent-orchestrator/live/config/workflow-config.json'
            ));

            assert.throws(
                () => runEnterTaskMode({
                    repoRoot,
                    taskId,
                    taskSummary: 'Start after invalid protected manifest'
                }),
                /protected control-plane manifest is invalid before task-mode entry/
            );
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('persists invalid-manifest entry failure and repairs only after fresh operator confirmation', { concurrency: false }, async () => {
        const taskId = 'T-900task-mode-manifest-confirmed-recovery';
        const repoRoot = createTempRepo();
        try {
            writeIgnoredRuntimePolicy(repoRoot, { ignoreBundle: true });
            writeBaselineAgentEntrypoint(repoRoot);
            seedTaskQueue(repoRoot, taskId);
            seedInitAnswers(repoRoot);
            initializeGitRepo(repoRoot);
            corruptProtectedControlPlaneManifest(repoRoot);
            const entryOptions = { repoRoot, taskId, entryMode: 'EXPLICIT_TASK_EXECUTION', requestedDepth: '2', taskSummary: 'Recover invalid manifest', provider: 'Codex' };
            const options = {
                ...entryOptions, effectiveDepth: '3', startBanner: 'Fresh recovery banner', routedTo: 'AGENTS.md',
                actor: 'operator-proxy', artifactPath: 'runtime/custom-task-mode.json',
                metricsPath: 'runtime/custom-metrics.json', emitMetrics: false
            };
            let entryError: unknown;
            try {
                runEnterTaskMode(entryOptions);
            } catch (error: unknown) {
                entryError = error;
            }
            assert.ok(entryError instanceof Error);
            assert.equal(recordTaskModeProtectedManifestFailure(options, entryError), true);
            assert.equal(recordTaskModeProtectedManifestFailure(options, new Error('workflow config scope is unauthorized')), false);
            const failurePath = path.join(getReviewsRoot(repoRoot), `${taskId}-task-mode-entry-failure.json`);
            const failure = JSON.parse(fs.readFileSync(failurePath, 'utf8')) as Record<string, unknown>;
            assert.equal(failure.manifest_status, 'INVALID');
            assert.match(String(failure.manifest_path), /protected-control-plane-manifest\.json$/);
            assert.equal(recordTaskModeProtectedManifestFailure(options, entryError), true);
            const immutableAttempts = fs.readdirSync(getReviewsRoot(repoRoot))
                .filter((name) => name.startsWith(`${taskId}-task-mode-entry-failure-`) && name.endsWith('.json'));
            assert.equal(immutableAttempts.length, 2);
            assert.equal(new Set(immutableAttempts).size, 2);
            const currentFailure = JSON.parse(fs.readFileSync(failurePath, 'utf8')) as Record<string, unknown>;
            const inspectedSnapshotSha256 = String(currentFailure.observed_protected_snapshot_sha256);
            assert.match(inspectedSnapshotSha256, /^[0-9a-f]{64}$/);
            assert.throws(
                () => runRecoverTaskModeProtectedManifestCommand({ repoRoot, taskId }),
                /operator-confirmed|operator confirmation/i
            );
            assert.throws(
                () => runRecoverTaskModeProtectedManifestCommand({
                    repoRoot, taskId, operatorConfirmed: 'yes',
                    operatorConfirmedAtUtc: new Date(Date.now() - 1_000).toISOString()
                }),
                /after the persisted task-mode protected-manifest failure/i
            );
            const workflowConfigPath = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json');
            const workflowConfigBeforeMutation = fs.readFileSync(workflowConfigPath, 'utf8');
            fs.writeFileSync(workflowConfigPath, `${workflowConfigBeforeMutation}\n`, 'utf8');
            assert.throws(
                () => runRecoverTaskModeProtectedManifestCommand({
                    repoRoot, taskId, operatorConfirmed: 'yes', operatorConfirmedAtUtc: new Date().toISOString(),
                    inspectedProtectedSnapshotSha256: inspectedSnapshotSha256
                }),
                /state changed after inspection/i
            );
            fs.writeFileSync(workflowConfigPath, workflowConfigBeforeMutation, 'utf8');
            const outputLines: string[] = [];
            const previousLog = console.log;
            const previousExitCode = process.exitCode;
            try {
                console.log = (...args: unknown[]) => outputLines.push(args.map(String).join(' '));
                process.exitCode = 0;
                await handleGate([
                    'recover-task-mode-protected-manifest', '--task-id', taskId,
                    '--inspected-protected-snapshot-sha256', inspectedSnapshotSha256,
                    '--operator-confirmed', 'yes', '--operator-confirmed-at-utc', new Date().toISOString(),
                    '--repo-root', repoRoot
                ]);
                assert.equal(process.exitCode ?? 0, 0);
            } finally {
                console.log = previousLog;
                process.exitCode = previousExitCode;
            }
            const recovery = JSON.parse(fs.readFileSync(path.join(getReviewsRoot(repoRoot), `${taskId}-task-mode-entry-recovery.json`), 'utf8')) as Record<string, unknown>;
            const output = String(recovery.fresh_entry_command || '');
            assert.match(output, /--effective-depth ['"]3['"]/);
            assert.match(output, /--start-banner ['"]Fresh recovery banner['"]/);
            assert.match(output, /--routed-to ['"]AGENTS\.md['"]/);
            assert.match(output, /--actor ['"]operator-proxy['"]/);
            assert.match(output, /--artifact-path ['"]runtime\/custom-task-mode\.json['"]/);
            assert.match(output, /--metrics-path ['"]runtime\/custom-metrics\.json['"]/);
            assert.match(output, /--emit-metrics false/);
            assert.equal(recovery.status_before, 'INVALID');
            assert.equal(recovery.status_after, 'MATCH');
            assert.ok(String(recovery.failure_artifact_sha256).length === 64);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('blocks deleted materialized workflow-config when protected manifest is invalid', { concurrency: false }, () => {
        const taskId = 'T-900workflow-config-upgrade-deleted-invalid-manifest';
        const repoRoot = createTempRepo();
        const configPath = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json');

        try {
            writeIgnoredRuntimePolicy(repoRoot, { ignoreBundle: true });
            writeBaselineAgentEntrypoint(repoRoot);
            seedTaskQueue(repoRoot, taskId);
            seedInitAnswers(repoRoot);
            initializeGitRepo(repoRoot);
            fs.rmSync(configPath);
            corruptProtectedControlPlaneManifest(repoRoot);

            const baselineState = getWorkflowConfigPreTaskBaselineState(repoRoot);
            assert.deepEqual(baselineState.compatibility_baseline_files, []);
            assert.ok(baselineState.changed_files.includes(
                'garda-agent-orchestrator/live/config/workflow-config.json'
            ));

            assert.throws(
                () => runEnterTaskMode({
                    repoRoot,
                    taskId,
                    taskSummary: 'Start after deleted workflow-config with invalid manifest'
                }),
                /protected control-plane manifest is invalid before task-mode entry/
            );
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('blocks ignored pre-existing materialized workflow-config when protected manifest digest is tampered', { concurrency: false }, () => {
        const taskId = 'T-900workflow-config-upgrade-ignored-tampered-manifest';
        const repoRoot = createTempRepo();

        try {
            writeIgnoredRuntimePolicy(repoRoot, { ignoreBundle: true });
            writeBaselineAgentEntrypoint(repoRoot);
            seedTaskQueue(repoRoot, taskId);
            seedInitAnswers(repoRoot);
            initializeGitRepo(repoRoot);
            weakenScopeBudgetGuard(repoRoot);
            writeTamperedProtectedControlPlaneManifest(repoRoot);

            const baselineState = getWorkflowConfigPreTaskBaselineState(repoRoot);
            assert.deepEqual(baselineState.compatibility_baseline_files, []);
            assert.ok(baselineState.changed_files.includes(
                'garda-agent-orchestrator/live/config/workflow-config.json'
            ));
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('keeps protected-manifest fallback baseline frozen after manifest refresh', { concurrency: false }, () => {
        const repoRoot = createTempRepo();

        try {
            writeIgnoredRuntimePolicy(repoRoot, { ignoreBundle: true });
            writeBaselineAgentEntrypoint(repoRoot);
            initializeGitRepo(repoRoot);
            writeProtectedControlPlaneManifest(repoRoot);

            const initialChanges = getCurrentWorkflowConfigChanges(repoRoot, null);
            assert.equal(initialChanges.baseline_source, 'protected_manifest');
            assert.ok(initialChanges.baseline_file_hashes);
            assert.deepEqual(initialChanges.changed_files, []);

            weakenOutOfScopePolicy(repoRoot);
            writeProtectedControlPlaneManifest(repoRoot);

            const unfrozenChanges = getCurrentWorkflowConfigChanges(repoRoot, null);
            assert.deepEqual(unfrozenChanges.changed_files, []);

            const frozenChanges = getCurrentWorkflowConfigChanges(repoRoot, initialChanges.baseline_file_hashes);
            assert.deepEqual(frozenChanges.changed_files, [
                'garda-agent-orchestrator/live/config/workflow-config.json'
            ]);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('allows legacy protected manifest without digest when workflow-config hash matches', { concurrency: false }, () => {
        const taskId = 'T-900workflow-config-upgrade-legacy-digestless-manifest';
        const repoRoot = createTempRepo();

        try {
            writeIgnoredRuntimePolicy(repoRoot, { ignoreBundle: true });
            writeBaselineAgentEntrypoint(repoRoot);
            seedTaskQueue(repoRoot, taskId);
            seedInitAnswers(repoRoot);
            initializeGitRepo(repoRoot);
            weakenScopeBudgetGuard(repoRoot);
            writeLegacyDigestlessProtectedControlPlaneManifest(repoRoot);

            const baselineState = getWorkflowConfigPreTaskBaselineState(repoRoot);
            assert.deepEqual(baselineState.compatibility_baseline_files, []);
            assert.deepEqual(baselineState.changed_files, []);

            const result = runEnterTaskMode({
                repoRoot,
                taskId,
                taskSummary: 'Start after legacy digestless manifest'
            });
            assert.equal(result.exitCode, 0);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('fails closed when no git status baseline is available for materialized workflow-config', { concurrency: false }, () => {
        const repoRoot = createTempRepo();

        try {
            const baselineState = getWorkflowConfigPreTaskBaselineState(repoRoot);
            assert.deepEqual(baselineState.compatibility_baseline_files, []);
            assert.ok(baselineState.changed_files.includes(
                'garda-agent-orchestrator/live/config/workflow-config.json'
            ));
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('blocks legacy identity-backfilled checks when workflow-config baseline hashes are missing', { concurrency: false }, () => {
        const repoRoot = createTempRepo();

        try {
            writeIgnoredRuntimePolicy(repoRoot, { ignoreBundle: true });
            writeBaselineAgentEntrypoint(repoRoot);
            initializeGitRepo(repoRoot);
            weakenScopeBudgetGuard(repoRoot);

            const changes = getCurrentWorkflowConfigChanges(repoRoot, null);
            assert.equal(changes.baseline_source, null);
            assert.deepEqual(changes.baseline_file_hashes, null);

            const violations = getWorkflowConfigWorkViolations({
                changedFiles: changes.changed_files,
                taskModeEvidence: {
                    identity_backfilled_from_legacy: true,
                    workflow_config_work: false,
                    orchestrator_work: false,
                    workflow_config_file_hashes: null
                },
                phaseLabel: 'compile gate',
                baselineFileHashes: changes.baseline_file_hashes,
                currentFileHashes: changes.current_file_hashes
            });

            assert.match(
                violations.join('\n'),
                /Workflow config baseline hashes are missing before compile gate/
            );
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('blocks ignored pre-existing materialized workflow-config when compatibility baseline is unsafe', { concurrency: false }, () => {
        const taskId = 'T-900workflow-config-upgrade-ignored-unsafe-baseline';
        const repoRoot = createTempRepo();

        try {
            writeIgnoredRuntimePolicy(repoRoot, { ignoreBundle: true });
            writeBaselineAgentEntrypoint(repoRoot);
            seedTaskQueue(repoRoot, taskId);
            seedInitAnswers(repoRoot);
            initializeGitRepo(repoRoot);
            weakenScopeBudgetGuard(repoRoot);

            const baselineState = getWorkflowConfigPreTaskBaselineState(repoRoot);
            assert.deepEqual(baselineState.compatibility_baseline_files, []);
            assert.deepEqual(baselineState.changed_files, [
                'garda-agent-orchestrator/live/config/workflow-config.json'
            ]);

            assert.throws(
                () => runEnterTaskMode({
                    repoRoot,
                    taskId,
                    taskSummary: 'Start after unsafe workflow-config baseline upgrade'
                }),
                /Trusted protected control-plane manifest is missing before task-mode entry/
            );
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('blocks ignored pre-existing materialized workflow-config when full-suite command is weakened', { concurrency: false }, () => {
        const taskId = 'T-900workflow-config-upgrade-ignored-command-unsafe';
        const repoRoot = createTempRepo();

        try {
            writeIgnoredRuntimePolicy(repoRoot, { ignoreBundle: true });
            writeBaselineAgentEntrypoint(repoRoot);
            seedTaskQueue(repoRoot, taskId);
            seedInitAnswers(repoRoot);
            initializeGitRepo(repoRoot);
            weakenFullSuiteCommand(repoRoot);

            const baselineState = getWorkflowConfigPreTaskBaselineState(repoRoot);
            assert.deepEqual(baselineState.compatibility_baseline_files, []);
            assert.deepEqual(baselineState.changed_files, [
                'garda-agent-orchestrator/live/config/workflow-config.json'
            ]);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('blocks ignored pre-existing materialized workflow-config when optional quality rules are customized', { concurrency: false }, () => {
        const taskId = 'T-900workflow-config-upgrade-ignored-custom-optional-check';
        const repoRoot = createTempRepo();

        try {
            writeIgnoredRuntimePolicy(repoRoot, { ignoreBundle: true });
            writeBaselineAgentEntrypoint(repoRoot);
            seedTaskQueue(repoRoot, taskId);
            seedInitAnswers(repoRoot);
            initializeGitRepo(repoRoot);
            customizeOptionalQualityCheckRule(repoRoot);

            const baselineState = getWorkflowConfigPreTaskBaselineState(repoRoot);
            assert.deepEqual(baselineState.compatibility_baseline_files, []);
            assert.deepEqual(baselineState.changed_files, [
                'garda-agent-orchestrator/live/config/workflow-config.json'
            ]);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('blocks ignored pre-existing materialized workflow-config when quality-checklist cadence is customized', { concurrency: false }, () => {
        const taskId = 'T-900workflow-config-upgrade-ignored-quality-cadence-unsafe';
        const repoRoot = createTempRepo();

        try {
            writeIgnoredRuntimePolicy(repoRoot, { ignoreBundle: true });
            writeBaselineAgentEntrypoint(repoRoot);
            seedTaskQueue(repoRoot, taskId);
            seedInitAnswers(repoRoot);
            initializeGitRepo(repoRoot);
            weakenOptionalQualityCheckCadence(repoRoot);

            const baselineState = getWorkflowConfigPreTaskBaselineState(repoRoot);
            assert.deepEqual(baselineState.compatibility_baseline_files, []);
            assert.deepEqual(baselineState.changed_files, [
                'garda-agent-orchestrator/live/config/workflow-config.json'
            ]);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('blocks ignored pre-existing materialized workflow-config when optional quality include filters are customized', { concurrency: false }, () => {
        const taskId = 'T-900workflow-config-upgrade-ignored-custom-optional-check-filter';
        const repoRoot = createTempRepo();

        try {
            writeIgnoredRuntimePolicy(repoRoot, { ignoreBundle: true });
            writeBaselineAgentEntrypoint(repoRoot);
            seedTaskQueue(repoRoot, taskId);
            seedInitAnswers(repoRoot);
            initializeGitRepo(repoRoot);
            customizeOptionalQualityCheckRuleIncludeFilter(repoRoot);

            const baselineState = getWorkflowConfigPreTaskBaselineState(repoRoot);
            assert.deepEqual(baselineState.compatibility_baseline_files, []);
            assert.deepEqual(baselineState.changed_files, [
                'garda-agent-orchestrator/live/config/workflow-config.json'
            ]);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('blocks ignored pre-existing materialized workflow-config when full-suite timeout blocker is disabled', { concurrency: false }, () => {
        const taskId = 'T-900workflow-config-upgrade-ignored-timeout-blocker-unsafe';
        const repoRoot = createTempRepo();

        try {
            writeIgnoredRuntimePolicy(repoRoot, { ignoreBundle: true });
            writeBaselineAgentEntrypoint(repoRoot);
            seedTaskQueue(repoRoot, taskId);
            seedInitAnswers(repoRoot);
            initializeGitRepo(repoRoot);
            weakenFullSuiteTimeoutBlocker(repoRoot);

            const baselineState = getWorkflowConfigPreTaskBaselineState(repoRoot);
            assert.deepEqual(baselineState.compatibility_baseline_files, []);
            assert.deepEqual(baselineState.changed_files, [
                'garda-agent-orchestrator/live/config/workflow-config.json'
            ]);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('blocks ignored pre-existing materialized workflow-config when full-suite timeout retry count is reduced', { concurrency: false }, () => {
        const taskId = 'T-900workflow-config-upgrade-ignored-timeout-retry-unsafe';
        const repoRoot = createTempRepo();

        try {
            writeIgnoredRuntimePolicy(repoRoot, { ignoreBundle: true });
            writeBaselineAgentEntrypoint(repoRoot);
            seedTaskQueue(repoRoot, taskId);
            seedInitAnswers(repoRoot);
            initializeGitRepo(repoRoot);
            weakenFullSuiteTimeoutRetryCount(repoRoot);

            const baselineState = getWorkflowConfigPreTaskBaselineState(repoRoot);
            assert.deepEqual(baselineState.compatibility_baseline_files, []);
            assert.deepEqual(baselineState.changed_files, [
                'garda-agent-orchestrator/live/config/workflow-config.json'
            ]);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('blocks ignored pre-existing materialized workflow-config when project memory maintenance is disabled', { concurrency: false }, () => {
        const taskId = 'T-900workflow-config-upgrade-ignored-project-memory-disabled';
        const repoRoot = createTempRepo();

        try {
            writeIgnoredRuntimePolicy(repoRoot, { ignoreBundle: true });
            writeBaselineAgentEntrypoint(repoRoot);
            seedTaskQueue(repoRoot, taskId);
            seedInitAnswers(repoRoot);
            initializeGitRepo(repoRoot);
            enableProjectMemoryMaintenancePolicy(repoRoot);
            weakenProjectMemoryMaintenance(repoRoot);

            const baselineState = getWorkflowConfigPreTaskBaselineState(repoRoot);
            assert.deepEqual(baselineState.compatibility_baseline_files, []);
            assert.deepEqual(baselineState.changed_files, [
                'garda-agent-orchestrator/live/config/workflow-config.json'
            ]);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('blocks ignored pre-existing materialized workflow-config when project memory approval is disabled', { concurrency: false }, () => {
        const taskId = 'T-900workflow-config-upgrade-ignored-project-memory-approval';
        const repoRoot = createTempRepo();

        try {
            writeIgnoredRuntimePolicy(repoRoot, { ignoreBundle: true });
            writeBaselineAgentEntrypoint(repoRoot);
            seedTaskQueue(repoRoot, taskId);
            seedInitAnswers(repoRoot);
            enableProjectMemoryMaintenancePolicy(repoRoot);
            initializeGitRepo(repoRoot);
            weakenProjectMemoryApproval(repoRoot);

            const baselineState = getWorkflowConfigPreTaskBaselineState(repoRoot);
            assert.deepEqual(baselineState.compatibility_baseline_files, []);
            assert.deepEqual(baselineState.changed_files, [
                'garda-agent-orchestrator/live/config/workflow-config.json'
            ]);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('blocks ignored pre-existing materialized workflow-config when project memory retention is reduced', { concurrency: false }, () => {
        const taskId = 'T-900workflow-config-upgrade-ignored-project-memory-retention';
        const repoRoot = createTempRepo();

        try {
            writeIgnoredRuntimePolicy(repoRoot, { ignoreBundle: true });
            writeBaselineAgentEntrypoint(repoRoot);
            seedTaskQueue(repoRoot, taskId);
            seedInitAnswers(repoRoot);
            enableProjectMemoryMaintenancePolicy(repoRoot);
            initializeGitRepo(repoRoot);
            weakenProjectMemoryRetention(repoRoot);

            const baselineState = getWorkflowConfigPreTaskBaselineState(repoRoot);
            assert.deepEqual(baselineState.compatibility_baseline_files, []);
            assert.deepEqual(baselineState.changed_files, [
                'garda-agent-orchestrator/live/config/workflow-config.json'
            ]);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('blocks ignored pre-existing materialized workflow-config when review-cycle exclusions are weakened', { concurrency: false }, () => {
        const taskId = 'T-900workflow-config-upgrade-ignored-review-cycle-unsafe';
        const repoRoot = createTempRepo();

        try {
            writeIgnoredRuntimePolicy(repoRoot, { ignoreBundle: true });
            writeBaselineAgentEntrypoint(repoRoot);
            seedTaskQueue(repoRoot, taskId);
            seedInitAnswers(repoRoot);
            initializeGitRepo(repoRoot);
            weakenReviewCycleExcludedReviews(repoRoot);

            const baselineState = getWorkflowConfigPreTaskBaselineState(repoRoot);
            assert.deepEqual(baselineState.compatibility_baseline_files, []);
            assert.deepEqual(baselineState.changed_files, [
                'garda-agent-orchestrator/live/config/workflow-config.json'
            ]);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('blocks ignored pre-existing materialized workflow-config when review execution policy is weakened', { concurrency: false }, () => {
        const taskId = 'T-900workflow-config-upgrade-ignored-review-policy-unsafe';
        const repoRoot = createTempRepo();

        try {
            writeIgnoredRuntimePolicy(repoRoot, { ignoreBundle: true });
            writeBaselineAgentEntrypoint(repoRoot);
            seedTaskQueue(repoRoot, taskId);
            seedInitAnswers(repoRoot);
            initializeGitRepo(repoRoot);
            weakenReviewExecutionPolicy(repoRoot);

            const baselineState = getWorkflowConfigPreTaskBaselineState(repoRoot);
            assert.deepEqual(baselineState.compatibility_baseline_files, []);
            assert.deepEqual(baselineState.changed_files, [
                'garda-agent-orchestrator/live/config/workflow-config.json'
            ]);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('blocks ignored pre-existing materialized workflow-config when review delegation is disabled', { concurrency: false }, () => {
        const taskId = 'T-900workflow-config-upgrade-ignored-review-delegation-unsafe';
        const repoRoot = createTempRepo();

        try {
            writeIgnoredRuntimePolicy(repoRoot, { ignoreBundle: true });
            writeBaselineAgentEntrypoint(repoRoot);
            seedTaskQueue(repoRoot, taskId);
            seedInitAnswers(repoRoot);
            initializeGitRepo(repoRoot);
            weakenReviewDelegationPolicy(repoRoot);

            const baselineState = getWorkflowConfigPreTaskBaselineState(repoRoot);
            assert.deepEqual(baselineState.compatibility_baseline_files, []);
            assert.deepEqual(baselineState.changed_files, [
                'garda-agent-orchestrator/live/config/workflow-config.json'
            ]);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('blocks ignored pre-existing materialized workflow-config with an unknown top-level policy key', { concurrency: false }, () => {
        const taskId = 'T-900workflow-config-upgrade-ignored-unknown-top-level';
        const repoRoot = createTempRepo();

        try {
            writeIgnoredRuntimePolicy(repoRoot, { ignoreBundle: true });
            writeBaselineAgentEntrypoint(repoRoot);
            seedTaskQueue(repoRoot, taskId);
            seedInitAnswers(repoRoot);
            enableProjectMemoryMaintenancePolicy(repoRoot);
            initializeGitRepo(repoRoot);
            addUnknownTopLevelWorkflowConfigKey(repoRoot);

            const baselineState = getWorkflowConfigPreTaskBaselineState(repoRoot);
            assert.deepEqual(baselineState.compatibility_baseline_files, []);
            assert.deepEqual(baselineState.changed_files, [
                'garda-agent-orchestrator/live/config/workflow-config.json'
            ]);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('blocks ignored pre-existing materialized workflow-config with an unknown section policy key', { concurrency: false }, () => {
        const taskId = 'T-900workflow-config-upgrade-ignored-unknown-section';
        const repoRoot = createTempRepo();

        try {
            writeIgnoredRuntimePolicy(repoRoot, { ignoreBundle: true });
            writeBaselineAgentEntrypoint(repoRoot);
            seedTaskQueue(repoRoot, taskId);
            seedInitAnswers(repoRoot);
            enableProjectMemoryMaintenancePolicy(repoRoot);
            initializeGitRepo(repoRoot);
            addUnknownWorkflowConfigSectionKey(repoRoot);

            const baselineState = getWorkflowConfigPreTaskBaselineState(repoRoot);
            assert.deepEqual(baselineState.compatibility_baseline_files, []);
            assert.deepEqual(baselineState.changed_files, [
                'garda-agent-orchestrator/live/config/workflow-config.json'
            ]);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('blocks ordinary task preflight when workflow-config policy is weakened by direct JSON edit', { concurrency: false }, () => {
        const taskId = 'T-900workflow-config-unauthorized';
        const repoRoot = prepareTaskRepo(taskId);

        try {
            weakenOutOfScopePolicy(repoRoot);

            assert.throws(
                () => runClassifyChangeCommand({
                    repoRoot,
                    taskId,
                    taskIntent: 'Update app flow',
                    emitMetrics: false
                }),
                /without task-mode --orchestrator-work --workflow-config-work/
            );
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('blocks workflow-config edits when task mode has only broad orchestrator work', { concurrency: false }, () => {
        const taskId = 'T-900workflow-config-orchestrator-only';
        const repoRoot = prepareTaskRepo(taskId, { orchestratorWork: true });

        try {
            weakenOutOfScopePolicy(repoRoot);

            assert.throws(
                () => runClassifyChangeCommand({
                    repoRoot,
                    taskId,
                    taskIntent: 'Update orchestrator workflow config',
                    emitMetrics: false
                }),
                /without task-mode --workflow-config-work/
            );
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('allows workflow-config edits only when task mode uses both explicit workflow flags', { concurrency: false }, () => {
        const taskId = 'T-900workflow-config-authorized-task';
        const repoRoot = prepareTaskRepo(taskId, {
            orchestratorWork: true,
            workflowConfigWork: true
        });

        try {
            weakenOutOfScopePolicy(repoRoot);

            const result = runClassifyChangeCommand({
                repoRoot,
                taskId,
                taskIntent: 'Update orchestrator workflow config',
                emitMetrics: false
            });
            const payload = JSON.parse(result.outputText);
            assert.equal(payload.triggers.protected_control_plane_changed, true);
            assert.deepEqual(payload.triggers.changed_workflow_config_files, [
                'garda-agent-orchestrator/live/config/workflow-config.json'
            ]);
            assert.ok(payload.triggers.changed_protected_files.includes(
                'garda-agent-orchestrator/live/config/workflow-config.json'
            ));
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('blocks workflow-config policy edits hidden outside an explicit changed-file scope', { concurrency: false }, () => {
        const taskId = 'T-900workflow-config-hidden-explicit-scope';
        const repoRoot = prepareTaskRepo(taskId);

        try {
            weakenOutOfScopePolicy(repoRoot);
            const appPath = editAppFile(repoRoot);

            assert.throws(
                () => runClassifyChangeCommand({
                    repoRoot,
                    taskId,
                    taskIntent: 'Update app flow',
                    changedFiles: [appPath],
                    emitMetrics: false
                }),
                /garda-agent-orchestrator\/live\/config\/workflow-config\.json/
            );
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('honors protected-manifest fallback baseline during preflight classification', { concurrency: false }, () => {
        const taskId = 'T-900workflow-config-preflight-manifest-baseline';
        const repoRoot = prepareTaskRepo(taskId, {
            orchestratorWork: true,
            ignoreBundle: true
        });
        const reviewsRoot = getReviewsRoot(repoRoot);
        const taskModePath = path.join(reviewsRoot, `${taskId}-task-mode.json`);

        try {
            const taskModeArtifact = JSON.parse(fs.readFileSync(taskModePath, 'utf8')) as Record<string, unknown>;
            delete taskModeArtifact.workflow_config_file_hashes;
            fs.writeFileSync(taskModePath, JSON.stringify(taskModeArtifact, null, 2) + '\n', 'utf8');
            const appPath = editAppFile(repoRoot);

            const result = runClassifyChangeCommand({
                repoRoot,
                taskId,
                taskIntent: 'Update app flow with legacy task-mode evidence',
                changedFiles: [appPath, 'garda-agent-orchestrator/live/config/workflow-config.json'],
                emitMetrics: false
            });
            const payload = JSON.parse(result.outputText);
            assert.deepEqual(payload.triggers.changed_workflow_config_files, []);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('blocks late workflow-config edits before full-suite when workflow-config flag is missing', { concurrency: false }, async () => {
        const taskId = 'T-900workflow-config-late-full-suite';
        const repoRoot = prepareTaskRepo(taskId, { orchestratorWork: true });
        const reviewsRoot = getReviewsRoot(repoRoot);
        const preflightPath = path.join(reviewsRoot, `${taskId}-preflight.json`);

        try {
            fs.mkdirSync(reviewsRoot, { recursive: true });
            fs.writeFileSync(preflightPath, JSON.stringify({
                task_id: taskId,
                changed_files: ['src/app.ts']
            }, null, 2), 'utf8');
            weakenOutOfScopePolicy(repoRoot);

            const result = await runFullSuiteValidationCommand({
                repoRoot,
                taskId,
                preflightPath
            });

            assert.notEqual(result.exitCode, 0);
            assert.match(result.outputText, /without task-mode --workflow-config-work/);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('blocks late workflow-config edits before compile when workflow-config flag is missing', { concurrency: false }, async () => {
        const taskId = 'T-900workflow-config-late-compile';
        const repoRoot = prepareTaskRepo(taskId, { orchestratorWork: true });
        const reviewsRoot = getReviewsRoot(repoRoot);
        const preflightPath = path.join(reviewsRoot, `${taskId}-preflight.json`);
        const commandsPath = path.join(repoRoot, 'commands-workflow-config-late-compile.md');

        try {
            fs.writeFileSync(commandsPath, [
                '### Compile Gate (Mandatory)',
                '```bash',
                'node -e "console.log(\'build ok\')"',
                '```'
            ].join('\n'), 'utf8');
            const appPath = editAppFile(repoRoot);
            runClassifyChangeCommand({
                repoRoot,
                taskId,
                taskIntent: 'Update app flow',
                changedFiles: [appPath],
                outputPath: preflightPath,
                emitMetrics: false
            });
            assert.equal(loadPostPreflightRulePack(repoRoot, taskId, preflightPath).exitCode, 0);
            weakenOutOfScopePolicy(repoRoot);

            const result = await runCompileGateCommand({
                repoRoot,
                taskId,
                preflightPath,
                commandsPath,
                emitMetrics: false
            });

            assert.notEqual(result.exitCode, 0);
            assert.equal(result.outputLines[0], 'COMPILE_GATE_FAILED');
            assert.match(result.outputLines.join('\n'), /without task-mode --workflow-config-work/);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('blocks completion when stale artifacts omit workflow-config hash baselines', { concurrency: false }, () => {
        const taskId = 'T-900workflow-config-completion-stale-baseline';
        const repoRoot = prepareTaskRepo(taskId, { orchestratorWork: true });

        try {
            const preflightPath = writePreflight(repoRoot, taskId, {
                triggers: {},
                changed_files: ['src/app.ts']
            });
            weakenOutOfScopePolicy(repoRoot);

            const result = runCompletionGate({
                repoRoot,
                taskId,
                preflightPath
            });

            assert.equal(result.outcome, 'FAIL');
            assert.ok(result.violations.some((violation: string) => (
                /without task-mode --workflow-config-work/.test(violation)
            )), JSON.stringify(result.violations, null, 2));
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('blocks late workflow-config edits before completion when workflow-config flag is missing', { concurrency: false }, () => {
        const taskId = 'T-900workflow-config-late-completion';
        const repoRoot = prepareTaskRepo(taskId, { orchestratorWork: true });
        const reviewsRoot = getReviewsRoot(repoRoot);
        const preflightPath = path.join(reviewsRoot, `${taskId}-preflight.json`);

        try {
            const appPath = editAppFile(repoRoot);
            runClassifyChangeCommand({
                repoRoot,
                taskId,
                taskIntent: 'Update app flow',
                changedFiles: [appPath],
                outputPath: preflightPath,
                emitMetrics: false
            });
            assert.equal(loadPostPreflightRulePack(repoRoot, taskId, preflightPath).exitCode, 0);
            writeCompilePassEvidence(repoRoot, taskId, preflightPath);
            writeCleanReviewArtifact(repoRoot, taskId, 'code', 'REVIEW PASSED');
            const reviewResult = runRequiredReviewsCheckCommand({
                repoRoot,
                taskId,
                preflightPath,
                reviewAuthorshipAttestationJson: '{"code":true}',
                emitMetrics: false
            });
            assert.equal(reviewResult.exitCode, 0, reviewResult.outputLines.join('\n'));
            assert.equal(runDocImpactGateCommand({
                repoRoot,
                taskId,
                preflightPath,
                rationale: 'No documentation updates are required for this workflow-config regression fixture.',
                emitMetrics: false
            }).exitCode, 0);
            weakenOutOfScopePolicy(repoRoot);

            const result = runCompletionGate({
                repoRoot,
                taskId,
                preflightPath
            });
            const violations = result.violations.join('\n');

            assert.equal(result.outcome, 'FAIL');
            assert.match(violations, /without task-mode --workflow-config-work/);
            assert.doesNotMatch(violations, /missing COMPILE_GATE_PASSED/);
            assert.doesNotMatch(violations, /missing REVIEW_GATE_PASSED/);
            assert.doesNotMatch(violations, /Compile gate evidence .*missing/i);
            assert.doesNotMatch(violations, /Review gate evidence .*missing/i);
            assert.doesNotMatch(violations, /Doc impact evidence .*missing/i);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('blocks late ignored bundle workflow-config edits before full-suite', { concurrency: false }, async () => {
        const taskId = 'T-900workflow-config-late-ignored-bundle';
        const repoRoot = prepareTaskRepo(taskId, {
            orchestratorWork: true,
            ignoreBundle: true
        });
        const reviewsRoot = getReviewsRoot(repoRoot);
        const preflightPath = path.join(reviewsRoot, `${taskId}-preflight.json`);

        try {
            const appPath = editAppFile(repoRoot);
            runClassifyChangeCommand({
                repoRoot,
                taskId,
                taskIntent: 'Update app flow',
                changedFiles: [appPath],
                outputPath: preflightPath,
                emitMetrics: false
            });
            weakenOutOfScopePolicy(repoRoot);

            const result = await runFullSuiteValidationCommand({
                repoRoot,
                taskId,
                preflightPath
            });

            assert.notEqual(result.exitCode, 0);
            assert.match(result.outputText, /garda-agent-orchestrator\/live\/config\/workflow-config\.json/);
            assert.match(result.outputText, /without task-mode --workflow-config-work/);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('allows ordinary task preflight after audited workflow set while retaining the original baseline', { concurrency: false }, () => {
        const taskId = 'T-900workflow-config-workflow-set-refreshes-manifest';
        const repoRoot = prepareTaskRepo(taskId);
        const bundleRoot = path.join(repoRoot, 'garda-agent-orchestrator');
        const originalTaskMode = getTaskModeEvidence(repoRoot, taskId);

        try {
            const workflowResult = captureConsole(() => handleWorkflow([
                'set',
                '--bundle-root', bundleRoot,
                '--full-suite-out-of-scope-failure-policy', 'audit_and_warn',
                ...buildOperatorConfirmationArgs()
            ], PACKAGE_JSON));
            assert.ok(workflowResult && workflowResult.action === 'set');
            assert.equal(workflowResult.status, 'CHANGED');
            assert.equal(typeof workflowResult.audit_path, 'string');
            assert.ok(fs.existsSync(String(workflowResult.audit_path)));
            assert.equal(typeof workflowResult.protected_manifest_path, 'string');
            assert.ok(fs.existsSync(String(workflowResult.protected_manifest_path)));
            const auditText = fs.readFileSync(String(workflowResult.audit_path), 'utf8');
            assert.match(auditText, /"event_source":"workflow-config-set"/);

            const taskModeResult = runEnterTaskMode({
                repoRoot,
                taskId,
                taskSummary: 'Start ordinary task after audited workflow set'
            });
            assert.equal(taskModeResult.exitCode, 0);
            const resumedTaskMode = getTaskModeEvidence(repoRoot, taskId);
            assert.deepEqual(resumedTaskMode.dirty_workspace_baseline, originalTaskMode.dirty_workspace_baseline);
            assert.deepEqual(resumedTaskMode.workflow_config_file_hashes, originalTaskMode.workflow_config_file_hashes);
            assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
            runHandshakeForTask(repoRoot, taskId);
            runShellSmokeForTask(repoRoot, taskId);

            const result = runClassifyChangeCommand({
                repoRoot,
                taskId,
                taskIntent: 'Update app flow',
                emitMetrics: false
            });
            const payload = JSON.parse(result.outputText);
            assert.equal(payload.triggers.protected_control_plane_manifest_status, 'MATCH');
            assert.deepEqual(payload.triggers.changed_workflow_config_files, ['garda-agent-orchestrator/live/config/workflow-config.json']);
            assert.equal(payload.triggers.workflow_config_audit_provenance.accepted, true);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('treats guarded local UI workflow-config changes during an active task as audited preflight warnings', { concurrency: false }, () => {
        const taskId = 'T-900workflow-config-local-ui-audited-during-task';
        const repoRoot = prepareTaskRepo(taskId);
        const bundleRoot = path.join(repoRoot, 'garda-agent-orchestrator');

        try {
            const workflowResult = captureConsole(() => handleWorkflow([
                'set',
                '--bundle-root', bundleRoot,
                '--full-suite-out-of-scope-failure-policy', 'audit_and_warn',
                '--mutation-source', 'local-ui',
                ...buildOperatorConfirmationArgs()
            ], PACKAGE_JSON));
            assert.ok(workflowResult && workflowResult.action === 'set');
            assert.equal(workflowResult.status, 'CHANGED');
            assert.ok(workflowResult.audit_path);
            const latestAudit = JSON.parse(fs.readFileSync(String(workflowResult.audit_path), 'utf8').trim().split(/\r?\n/u).at(-1) || '{}');
            assert.equal(latestAudit.mutation_source, 'local-ui');
            assert.deepEqual(latestAudit.active_task_ids, [taskId]);

            const taskModeEvidence = getTaskModeEvidence(repoRoot, taskId);
            const changes = getCurrentWorkflowConfigChanges(repoRoot, taskModeEvidence.workflow_config_file_hashes, {
                allowProtectedManifestFallback: false
            });
            assert.deepEqual(changes.changed_files, ['garda-agent-orchestrator/live/config/workflow-config.json']);
            const provenance = getAuditedWorkflowConfigChangeProvenance({
                repoRoot,
                changedFiles: changes.changed_files,
                currentFileHashes: changes.current_file_hashes,
                taskId
            });
            assert.equal(provenance.accepted, true);
            assert.equal(provenance.records[0]?.mutation_source, 'local-ui');
            assert.deepEqual(getWorkflowConfigWorkViolations({
                repoRoot,
                changedFiles: changes.changed_files,
                taskModeEvidence,
                phaseLabel: 'preflight classification',
                baselineFileHashes: changes.baseline_file_hashes,
                currentFileHashes: changes.current_file_hashes
            }), []);

            const result = runClassifyChangeCommand({
                repoRoot,
                taskId,
                taskIntent: 'Update app flow after UI workflow setting changed',
                emitMetrics: false
            });
            const payload = JSON.parse(result.outputText);
            assert.deepEqual(payload.triggers.changed_workflow_config_files, [
                'garda-agent-orchestrator/live/config/workflow-config.json'
            ]);
            assert.deepEqual(payload.triggers.changed_protected_files, []);
            assert.equal(payload.triggers.workflow_config_audit_provenance.accepted, true);
            assert.equal(payload.triggers.workflow_config_audit_provenance.records[0].mutation_source, 'local-ui');
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });
});
