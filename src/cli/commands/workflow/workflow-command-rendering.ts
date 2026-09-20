import {
    UNCONFIGURED_COMPILE_GATE_COMMAND
} from '../../../core/constants';
import * as fs from 'node:fs';
import {
    REVIEW_EXECUTION_POLICY_MODES,
    buildReviewExecutionPolicySummaryLine,
    describeReviewExecutionPolicy,
    resolveEffectiveReviewExecutionPolicyConfigFromWorkflowConfig
} from '../../../core/review-execution-policy';
import {
    buildDefaultWorkflowConfig,
    GARDA_NO_DELEGATE_ENV,
    normalizeAutoBackupConfig,
    normalizeCompileGateConfig,
    normalizeOptionalQualityChecksConfig,
    normalizeOrchestratorWorkPolicyConfig,
    normalizeReviewDelegationConfig,
    type AutoBackupConfig,
    type CompileGateConfig,
    type OrchestratorWorkPolicyConfig,
    type OptionalQualityChecksConfig,
    type ReviewDelegationConfig,
    type TaskResetConfig,
    type WorkflowConfigData
} from '../../../core/workflow-config';
import { buildProjectMemoryMaintenanceSummaryLine } from '../../../core/project-memory-rollout';
import {
    normalizeScopeBudgetGuardConfig,
    type ScopeBudgetGuardConfig
} from '../../../core/scope-budget-guard';
import {
    normalizeReviewCycleGuardConfig,
    type ReviewCycleGuardConfig
} from '../../../core/review-cycle-guard';
import { validateManagedConfigByName } from '../../../schemas/config-artifacts';
import {
    DEFAULT_POLICY_CONFIG,
    normalizeOptionalSkillSelectionPolicyMode,
    type CanonicalOptionalSkillSelectionPolicyMode,
    type OptionalSkillSelectionPolicyMode
} from '../../../runtime/optional-skill-selection';
import {
    bold,
    cyan,
    dim,
    green,
    red,
    supportsColor,
    yellow
} from '../cli-helpers';
import { buildFullSuitePerformanceGuidance, formatFullSuitePerformanceGuidance } from '../../../gates/full-suite/full-suite-validation';
import {
    cloneOrchestratorWorkPolicyConfig,
    cloneAutoBackupConfig,
    cloneOptionalQualityChecksConfig,
    cloneProjectMemoryMaintenanceConfig,
    cloneReviewDelegationConfig,
    cloneTaskResetConfig
} from './workflow-command-state';
import type {
    WorkflowCommandResultBase,
    WorkflowCommandRoots,
    WorkflowConfigState,
    WorkflowReviewExecutionPolicyView,
    WorkflowSetResult,
    WorkflowShowResult
} from './workflow-command-types';

type WorkflowOptionalSkillSelectionPolicyView = WorkflowCommandResultBase['optional_skill_selection_policy'];

export function buildMandatoryFullSuiteLine(config: { full_suite_validation: WorkflowConfigData['full_suite_validation'] }): string {
    const guidance = buildFullSuitePerformanceGuidance(config.full_suite_validation.command);
    return `Mandatory full-suite: ${config.full_suite_validation.enabled ? 'true' : 'false'} placement=${config.full_suite_validation.placement} mode=${guidance.mode}`;
}

export function isConfiguredCompileGateCommand(command: unknown): command is string {
    const value = typeof command === 'string' ? command.trim() : '';
    return Boolean(value) && value !== UNCONFIGURED_COMPILE_GATE_COMMAND;
}

export function buildCompileGateLine(config: { compile_gate?: CompileGateConfig }): string {
    const command = config.compile_gate?.command || UNCONFIGURED_COMPILE_GATE_COMMAND;
    return isConfiguredCompileGateCommand(command)
        ? `Compile gate command: configured (${command})`
        : 'Compile gate command: unconfigured (fail-closed)';
}

export function buildCompileGateCommandSource(command: unknown): string {
    return isConfiguredCompileGateCommand(command) ? 'workflow-config' : 'unconfigured-fail-closed';
}

export function buildCompileGateRemediationLine(command: unknown): string {
    return isConfiguredCompileGateCommand(command)
        ? 'CompileGateRemediation: none'
        : 'CompileGateRemediation: Set workflow-config compile_gate.command with workflow set --compile-gate-command "<compile/build/type-check command>" --operator-confirmed yes --operator-confirmed-at-utc <ISO-8601 timestamp>';
}

export function buildReviewExecutionPolicyView(state: WorkflowConfigState): WorkflowReviewExecutionPolicyView {
    if (state.missingReviewExecutionPolicyMode) {
        const mode = state.missingReviewExecutionPolicyMode;
        return {
            mode,
            configured: false,
            allowed_modes: REVIEW_EXECUTION_POLICY_MODES,
            description: describeReviewExecutionPolicy(mode),
            visible_summary_line: buildReviewExecutionPolicySummaryLine(mode)
        };
    }
    const resolved = resolveEffectiveReviewExecutionPolicyConfigFromWorkflowConfig(
        state.config,
        'legacy_test_downstream'
    );
    const mode = resolved.mode;
    return {
        mode,
        configured: resolved.configured,
        allowed_modes: REVIEW_EXECUTION_POLICY_MODES,
        description: describeReviewExecutionPolicy(mode),
        visible_summary_line: buildReviewExecutionPolicySummaryLine(mode)
    };
}

export function buildReviewDelegationLine(config: ReviewDelegationConfig): string {
    return `Review delegation: ${config.no_delegate ? 'no-delegate active' : 'delegated reviewers allowed'} env=${GARDA_NO_DELEGATE_ENV}`;
}

export function buildScopeBudgetGuardLine(config: ScopeBudgetGuardConfig): string {
    return `Scope budget guard: ${config.enabled ? 'tiered WARN/BLOCK' : 'disabled'} profiles=${config.profiles.join(',')} warn_files=${config.warn_files} block_files=${config.block_files} warn_lines=${config.warn_changed_lines} block_lines=${config.block_changed_lines} warn_reviews=${config.warn_required_reviews} block_reviews=${config.block_required_reviews} warn_review_tokens=${config.warn_review_tokens} block_review_tokens=${config.block_review_tokens}`;
}

export function buildReviewCycleGuardLine(config: ReviewCycleGuardConfig): string {
    return `Review cycle guard: ${config.enabled ? config.action : 'disabled'} max_failed_non_test_reviews=${config.max_failed_non_test_reviews} max_total_non_test_reviews=${config.max_total_non_test_reviews} excluded=${config.excluded_review_types.join(',')} auto_split_enabled=${config.auto_split_enabled}`;
}

export function buildTaskResetLine(config: TaskResetConfig): string {
    return `Task reset: ${config.enabled ? 'enabled' : 'disabled'}`;
}

export function buildAutoBackupLine(config: AutoBackupConfig): string {
    return `Auto backup: ${config.enabled ? 'enabled' : 'disabled'} interval_days=${config.interval_days} keep_latest=${config.keep_latest}`;
}

export function buildOptionalQualityChecksLine(config: OptionalQualityChecksConfig): string {
    const enabledRules = config.rules.filter((rule) => rule.enabled !== false).length;
    return `Optional quality checks: ${config.enabled ? 'enabled' : 'disabled'} baseline=${config.baseline_version} rules=${config.rules.length} enabled_rules=${enabledRules} cadence_interval=${config.review_failure_cadence_interval}`;
}

function readOptionalSkillSelectionPolicyView(
    roots: WorkflowCommandRoots
): WorkflowOptionalSkillSelectionPolicyView {
    if (!fs.existsSync(roots.optionalSkillSelectionPolicyPath) || !fs.statSync(roots.optionalSkillSelectionPolicyPath).isFile()) {
        return {
            config_path: roots.optionalSkillSelectionPolicyPath,
            config_exists: false,
            status: 'missing',
            mode: DEFAULT_POLICY_CONFIG.mode,
            effective_mode: normalizeOptionalSkillSelectionPolicyMode(DEFAULT_POLICY_CONFIG.mode),
            invalid_reason: null
        };
    }
    try {
        const parsed = JSON.parse(fs.readFileSync(roots.optionalSkillSelectionPolicyPath, 'utf8')) as unknown;
        const validated = validateManagedConfigByName(
            'optional-skill-selection-policy',
            parsed
        ) as Record<string, unknown>;
        const mode = String(validated.mode || DEFAULT_POLICY_CONFIG.mode) as OptionalSkillSelectionPolicyMode;
        return {
            config_path: roots.optionalSkillSelectionPolicyPath,
            config_exists: true,
            status: 'present',
            mode,
            effective_mode: normalizeOptionalSkillSelectionPolicyMode(mode),
            invalid_reason: null
        };
    } catch (error: unknown) {
        const mode = DEFAULT_POLICY_CONFIG.mode;
        return {
            config_path: roots.optionalSkillSelectionPolicyPath,
            config_exists: true,
            status: 'invalid',
            mode,
            effective_mode: normalizeOptionalSkillSelectionPolicyMode(mode) as CanonicalOptionalSkillSelectionPolicyMode,
            invalid_reason: error instanceof Error ? error.message : String(error)
        };
    }
}

export function buildOptionalSkillSelectionPolicyLine(config: WorkflowOptionalSkillSelectionPolicyView): string {
    const statusSuffix = config.status === 'present'
        ? ''
        : ` status=${config.status}`;
    const legacySuffix = config.mode === config.effective_mode
        ? ''
        : ` (legacy config=${config.mode})`;
    return `Specialist-skill selection: ${config.effective_mode}${legacySuffix}${statusSuffix}`;
}

export function buildOrchestratorWorkPolicyLine(config: OrchestratorWorkPolicyConfig): string {
    const selfGuard = config.mode === 'deny_agent_entry' ? 'on' : 'off';
    return `Garda self-guard: ${selfGuard} (${config.mode})`;
}

export function buildWorkflowShowResult(
    roots: WorkflowCommandRoots,
    state: WorkflowConfigState
): WorkflowShowResult {
    const compileGate = normalizeCompileGateConfig(
        state.config.compile_gate ?? buildDefaultWorkflowConfig().compile_gate
    );
    const reviewExecutionPolicy = buildReviewExecutionPolicyView(state);
    const reviewDelegation = cloneReviewDelegationConfig(
        normalizeReviewDelegationConfig(state.config.review_delegation ?? buildDefaultWorkflowConfig().review_delegation)
    );
    const scopeBudgetGuard = normalizeScopeBudgetGuardConfig(state.config.scope_budget_guard);
    const reviewCycleGuard = normalizeReviewCycleGuardConfig(state.config.review_cycle_guard);
    const projectMemoryMaintenance = cloneProjectMemoryMaintenanceConfig(
        state.config.project_memory_maintenance ?? buildDefaultWorkflowConfig().project_memory_maintenance
    );
    const taskReset = cloneTaskResetConfig(
        state.config.task_reset ?? buildDefaultWorkflowConfig().task_reset
    );
    const autoBackup = cloneAutoBackupConfig(
        normalizeAutoBackupConfig(state.config.auto_backup ?? buildDefaultWorkflowConfig().auto_backup)
    );
    const optionalQualityChecks = cloneOptionalQualityChecksConfig(
        normalizeOptionalQualityChecksConfig(
            state.config.optional_quality_checks ?? buildDefaultWorkflowConfig().optional_quality_checks
        )
    );
    const optionalSkillSelectionPolicy = readOptionalSkillSelectionPolicyView(roots);
    const orchestratorWorkPolicy = cloneOrchestratorWorkPolicyConfig(
        normalizeOrchestratorWorkPolicyConfig(
            state.config.orchestrator_work_policy ?? buildDefaultWorkflowConfig().orchestrator_work_policy
        )
    );
    return {
        action: 'show',
        scope: 'repo-local',
        target_root: roots.targetRoot,
        bundle_root: roots.bundleRoot,
        config_path: roots.configPath,
        config_exists: state.exists,
        compact: state.config.compact ?? buildDefaultWorkflowConfig().compact,
        compile_gate: compileGate,
        full_suite_validation: state.config.full_suite_validation,
        review_execution_policy: reviewExecutionPolicy,
        review_delegation: reviewDelegation,
        scope_budget_guard: scopeBudgetGuard,
        review_cycle_guard: reviewCycleGuard,
        project_memory_maintenance: projectMemoryMaintenance,
        task_reset: taskReset,
        auto_backup: autoBackup,
        optional_quality_checks: optionalQualityChecks,
        optional_skill_selection_policy: optionalSkillSelectionPolicy,
        orchestrator_work_policy: orchestratorWorkPolicy,
        visible_summary_line: buildMandatoryFullSuiteLine(state.config),
        compile_gate_summary_line: buildCompileGateLine({ compile_gate: compileGate }),
        review_execution_policy_summary_line: reviewExecutionPolicy.visible_summary_line,
        review_delegation_summary_line: buildReviewDelegationLine(reviewDelegation),
        scope_budget_guard_summary_line: buildScopeBudgetGuardLine(scopeBudgetGuard),
        review_cycle_guard_summary_line: buildReviewCycleGuardLine(reviewCycleGuard),
        project_memory_maintenance_summary_line: buildProjectMemoryMaintenanceSummaryLine(projectMemoryMaintenance),
        task_reset_summary_line: buildTaskResetLine(taskReset),
        auto_backup_summary_line: buildAutoBackupLine(autoBackup),
        optional_quality_checks_summary_line: buildOptionalQualityChecksLine(optionalQualityChecks),
        optional_skill_selection_policy_summary_line: buildOptionalSkillSelectionPolicyLine(optionalSkillSelectionPolicy),
        orchestrator_work_policy_summary_line: buildOrchestratorWorkPolicyLine(orchestratorWorkPolicy)
    };
}

export function colorWorkflowValue(key: string, value: string): string {
    const normalized = value.trim().toUpperCase();
    if (key === 'Status') {
        if (normalized === 'CHANGED' || normalized === 'PASS') return green(value);
        if (normalized === 'NO_CHANGE') return yellow(value);
        return red(value);
    }
    if (value === 'true' || value === 'enabled') return green(value);
    if (value === 'false' || value === 'disabled' || value === 'none' || value === 'n/a') return dim(value);
    return value;
}

export function colorizeWorkflowLine(line: string): string {
    if (!supportsColor() || !line.trim()) return line;
    if (line === 'GARDA_WORKFLOW') return bold(cyan(line));
    if (!line.includes(':')) return bold(line);
    const match = line.match(/^([A-Za-z][A-Za-z0-9]*):(.*)$/u);
    if (!match) return line;
    const [, key, rest] = match;
    const spacing = rest.match(/^\s*/u)?.[0] ?? ' ';
    const value = rest.slice(spacing.length);
    return `${bold(`${key}:`)}${spacing}${colorWorkflowValue(key, value)}`;
}

export function colorizeWorkflowHumanOutput(rendered: string): string {
    return rendered.split('\n').map((line) => colorizeWorkflowLine(line)).join('\n');
}

export function formatWorkflowFieldList(fields: readonly string[]): string {
    return fields.length > 0 ? fields.join(', ') : 'none';
}

export function formatWorkflowShowOutput(result: WorkflowCommandResultBase & { action: 'show' | 'set' }, jsonMode: boolean): string {
    if (jsonMode) {
        return JSON.stringify(result, null, 2);
    }

    const compileGate = result.compile_gate;
    const fullSuiteValidation = result.full_suite_validation;
    const reviewExecutionPolicy = result.review_execution_policy;
    const reviewDelegation = result.review_delegation;
    const scopeBudgetGuard = result.scope_budget_guard;
    const reviewCycleGuard = result.review_cycle_guard;
    const projectMemoryMaintenance = result.project_memory_maintenance;
    const taskReset = result.task_reset;
    const autoBackup = result.auto_backup;
    const optionalQualityChecks = result.optional_quality_checks;
    const optionalSkillSelectionPolicy = result.optional_skill_selection_policy;
    const orchestratorWorkPolicy = result.orchestrator_work_policy;
    const lines: string[] = [];
    lines.push('GARDA_WORKFLOW');
    lines.push(`Action: ${result.action}`);
    lines.push('');
    lines.push('Target');
    lines.push(`Scope: ${result.scope}`);
    lines.push(`TargetRoot: ${result.target_root}`);
    lines.push(`Bundle: ${result.bundle_root}`);
    lines.push(`ConfigPath: ${result.config_path}`);
    lines.push(`ConfigExists: ${result.config_exists}`);
    lines.push('');
    lines.push('Settings summary');
    lines.push(result.compile_gate_summary_line);
    lines.push(result.visible_summary_line);
    lines.push(result.review_execution_policy_summary_line);
    lines.push(result.review_delegation_summary_line);
    lines.push(result.scope_budget_guard_summary_line);
    lines.push(result.review_cycle_guard_summary_line);
    lines.push(result.project_memory_maintenance_summary_line);
    lines.push(result.task_reset_summary_line);
    lines.push(result.auto_backup_summary_line);
    lines.push(result.optional_quality_checks_summary_line);
    lines.push(result.optional_skill_selection_policy_summary_line);
    lines.push(result.orchestrator_work_policy_summary_line);
    lines.push('');
    lines.push('Compile gate');
    lines.push(`CompileGateCommand: ${compileGate.command}`);
    lines.push(`CompileGateCommandSource: ${buildCompileGateCommandSource(compileGate.command)}`);
    lines.push('CompileGateFallback: disabled');
    lines.push(buildCompileGateRemediationLine(compileGate.command));
    lines.push('');
    lines.push('Full suite validation');
    lines.push(`FullSuiteEnabled: ${fullSuiteValidation.enabled}`);
    lines.push(`FullSuiteCommand: ${fullSuiteValidation.command}`);
    lines.push(`FullSuitePerformance: ${formatFullSuitePerformanceGuidance(fullSuiteValidation.command)}`);
    lines.push(`FullSuiteTimeoutMs: ${fullSuiteValidation.timeout_ms}`);
    lines.push(`FullSuiteTimeoutBlocker: ${fullSuiteValidation.timeout_blocker}`);
    lines.push(`FullSuiteTimeoutRetryCount: ${fullSuiteValidation.timeout_retry_count}`);
    lines.push(`FullSuiteGreenSummaryMaxLines: ${fullSuiteValidation.green_summary_max_lines}`);
    lines.push(`FullSuiteRedFailureChunkLines: ${fullSuiteValidation.red_failure_chunk_lines}`);
    lines.push(`FullSuiteOutOfScopeFailurePolicy: ${fullSuiteValidation.out_of_scope_failure_policy}`);
    lines.push(`FullSuitePlacement: ${fullSuiteValidation.placement}`);
    lines.push('');
    lines.push('Review execution');
    lines.push(`ReviewExecutionPolicy: ${reviewExecutionPolicy.mode}`);
    lines.push(`ReviewExecutionPolicyConfigured: ${reviewExecutionPolicy.configured}`);
    lines.push(`ReviewExecutionPolicyDescription: ${reviewExecutionPolicy.description}`);
    lines.push(`ReviewExecutionPolicyAllowedModes: ${reviewExecutionPolicy.allowed_modes.join(', ')}`);
    lines.push('');
    lines.push('Review delegation');
    lines.push(`NoDelegateMode: ${reviewDelegation.no_delegate}`);
    lines.push(`NoDelegateEnv: ${GARDA_NO_DELEGATE_ENV}`);
    lines.push('NoDelegateConfigKey: review_delegation.no_delegate');
    lines.push('');
    lines.push('Scope budget guard');
    lines.push(`ScopeBudgetGuardEnabled: ${scopeBudgetGuard.enabled}`);
    lines.push(`ScopeBudgetGuardProfiles: ${scopeBudgetGuard.profiles.join(', ')}`);
    lines.push(`ScopeBudgetGuardLegacyMaxMappingMode: ${scopeBudgetGuard.action}`);
    lines.push('ScopeBudgetGuardBlocking: explicit block_* thresholds produce BLOCK in every legacy mapping mode');
    lines.push(`ScopeBudgetGuardMaxFiles: ${scopeBudgetGuard.max_files}`);
    lines.push(`ScopeBudgetGuardMaxChangedLines: ${scopeBudgetGuard.max_changed_lines}`);
    lines.push(`ScopeBudgetGuardMaxRequiredReviews: ${scopeBudgetGuard.max_required_reviews}`);
    lines.push(`ScopeBudgetGuardMaxReviewTokens: ${scopeBudgetGuard.max_review_tokens}`);
    lines.push(`ScopeBudgetGuardWarnFiles: ${scopeBudgetGuard.warn_files}`);
    lines.push(`ScopeBudgetGuardBlockFiles: ${scopeBudgetGuard.block_files}`);
    lines.push(`ScopeBudgetGuardWarnChangedLines: ${scopeBudgetGuard.warn_changed_lines}`);
    lines.push(`ScopeBudgetGuardBlockChangedLines: ${scopeBudgetGuard.block_changed_lines}`);
    lines.push(`ScopeBudgetGuardWarnRequiredReviews: ${scopeBudgetGuard.warn_required_reviews}`);
    lines.push(`ScopeBudgetGuardBlockRequiredReviews: ${scopeBudgetGuard.block_required_reviews}`);
    lines.push(`ScopeBudgetGuardWarnReviewTokens: ${scopeBudgetGuard.warn_review_tokens}`);
    lines.push(`ScopeBudgetGuardBlockReviewTokens: ${scopeBudgetGuard.block_review_tokens}`);
    lines.push('');
    lines.push('Review cycle guard');
    lines.push(`ReviewCycleGuardEnabled: ${reviewCycleGuard.enabled}`);
    lines.push(`ReviewCycleGuardAction: ${reviewCycleGuard.action}`);
    lines.push(`ReviewCycleGuardMaxFailedNonTestReviews: ${reviewCycleGuard.max_failed_non_test_reviews}`);
    lines.push(`ReviewCycleGuardMaxTotalNonTestReviews: ${reviewCycleGuard.max_total_non_test_reviews}`);
    lines.push(`ReviewCycleGuardExcludedReviewTypes: ${reviewCycleGuard.excluded_review_types.join(', ')}`);
    lines.push(`ReviewCycleGuardAutoSplitEnabled: ${reviewCycleGuard.auto_split_enabled}`);
    lines.push('');
    lines.push('Project memory maintenance');
    lines.push(`ProjectMemoryMaintenanceEnabled: ${projectMemoryMaintenance.enabled}`);
    lines.push(`ProjectMemoryMaintenanceMode: ${projectMemoryMaintenance.mode}`);
    lines.push(`ProjectMemoryMaintenanceRunBeforeFinalCloseout: ${projectMemoryMaintenance.run_before_final_closeout}`);
    lines.push(`ProjectMemoryMaintenanceRequireUserApprovalForWrites: ${projectMemoryMaintenance.require_user_approval_for_writes}`);
    lines.push(`ProjectMemoryMaintenanceMaxCompactSummaryChars: ${projectMemoryMaintenance.max_compact_summary_chars}`);
    lines.push(`ProjectMemoryMaintenanceReadStrategy: ${projectMemoryMaintenance.read_strategy}`);
    lines.push(`ProjectMemoryMaintenanceImpactArtifactRetentionDays: ${projectMemoryMaintenance.impact_artifact_retention_days}`);
    lines.push('');
    lines.push('Task reset, auto backup, optional checks, and self-guard');
    lines.push(`TaskResetEnabled: ${taskReset.enabled}`);
    lines.push(`AutoBackupEnabled: ${autoBackup.enabled}`);
    lines.push(`AutoBackupIntervalDays: ${autoBackup.interval_days}`);
    lines.push(`AutoBackupKeepLatest: ${autoBackup.keep_latest}`);
    lines.push(`OptionalQualityChecksEnabled: ${optionalQualityChecks.enabled}`);
    lines.push(`OptionalQualityChecksBaselineVersion: ${optionalQualityChecks.baseline_version}`);
    lines.push(`OptionalQualityChecksReviewFailureCadenceInterval: ${optionalQualityChecks.review_failure_cadence_interval}`);
    lines.push(`OptionalQualityChecksRuleCount: ${optionalQualityChecks.rules.length}`);
    lines.push(`OptionalQualityChecksEnabledRuleCount: ${optionalQualityChecks.rules.filter((rule) => rule.enabled !== false).length}`);
    lines.push(`OptionalQualityChecksRuleIds: ${optionalQualityChecks.rules.map((rule) => rule.id).join(', ')}`);
    for (const rule of optionalQualityChecks.rules) {
        lines.push(`OptionalQualityCheckRule: ${rule.id} enabled=${rule.enabled !== false} title=${rule.title}`);
    }
    lines.push(`OptionalSkillSelectionPolicyMode: ${optionalSkillSelectionPolicy.effective_mode}`);
    lines.push(`OptionalSkillSelectionPolicyEffectiveMode: ${optionalSkillSelectionPolicy.effective_mode}`);
    if (optionalSkillSelectionPolicy.mode !== optionalSkillSelectionPolicy.effective_mode) {
        lines.push(`OptionalSkillSelectionPolicyLegacyMode: ${optionalSkillSelectionPolicy.mode}`);
    }
    lines.push(`OptionalSkillSelectionPolicyStatus: ${optionalSkillSelectionPolicy.status}`);
    lines.push(`OptionalSkillSelectionPolicyPath: ${optionalSkillSelectionPolicy.config_path}`);
    if (optionalSkillSelectionPolicy.invalid_reason) {
        lines.push(`OptionalSkillSelectionPolicyInvalidReason: ${optionalSkillSelectionPolicy.invalid_reason}`);
    }
    lines.push(`GardaSelfGuard: ${orchestratorWorkPolicy.mode === 'deny_agent_entry' ? 'on' : 'off'}`);
    lines.push(`OrchestratorWorkPolicy: ${orchestratorWorkPolicy.mode}`);
    lines.push('');
    lines.push('Hints');
    lines.push('Tip: compile-gate executes workflow-config compile_gate.command only; unconfigured workspaces fail closed and do not fall back to 40-commands.md.');
    lines.push('Tip: run "workflow set --compile-gate-command \"<compile/build/type-check command>\" --operator-confirmed yes --operator-confirmed-at-utc <ISO-8601 timestamp>" after operator approval to set the compile gate command.');
    lines.push('Tip: run "workflow set --full-suite on|off --operator-confirmed yes --operator-confirmed-at-utc <ISO-8601 timestamp>" to change the repo-local mode after operator approval.');
    lines.push('Tip: run "workflow set --full-suite-timeout-blocker true|false --full-suite-timeout-retry-count 1 --operator-confirmed yes --operator-confirmed-at-utc <ISO-8601 timestamp>" to change timeout blocker behavior after operator approval.');
    lines.push(`Tip: run "workflow set --review-execution-policy <${REVIEW_EXECUTION_POLICY_MODES.join('|')}> --operator-confirmed yes --operator-confirmed-at-utc <ISO-8601 timestamp>" to change review launch ordering after operator approval.`);
    lines.push('Tip: run "workflow set --no-delegate true|false --operator-confirmed yes --operator-confirmed-at-utc <ISO-8601 timestamp>" to toggle fail-closed delegated reviewer launch availability after operator approval.');
    lines.push('Tip: run "workflow set --scope-budget on|off --scope-budget-warn-changed-lines 2000 --scope-budget-block-changed-lines 5000 --operator-confirmed yes --operator-confirmed-at-utc <ISO-8601 timestamp>" to change the tiered scope budget guard after operator approval.');
    lines.push('Tip: run "workflow set --review-cycle on|off --operator-confirmed yes --operator-confirmed-at-utc <ISO-8601 timestamp>" to change the review cycle guard after operator approval.');
    lines.push('Tip: run "workflow set --project-memory on|off --operator-confirmed yes --operator-confirmed-at-utc <ISO-8601 timestamp>" to change project memory maintenance checks after operator approval.');
    lines.push('Tip: run "workflow set --task-reset on|off --operator-confirmed yes --operator-confirmed-at-utc <ISO-8601 timestamp>" to change confirmed task-reset availability after operator approval.');
    lines.push('Tip: run "workflow set --auto-backup on|off --auto-backup-interval-days 1 --auto-backup-keep-latest 10 --operator-confirmed yes --operator-confirmed-at-utc <ISO-8601 timestamp>" to change scheduled backup maintenance after operator approval.');
    lines.push('Tip: run "workflow set --optional-checks on|off --operator-confirmed yes --operator-confirmed-at-utc <ISO-8601 timestamp>" to change optional quality-check availability after operator approval.');
    lines.push('Tip: run "workflow set --optional-checks-review-failure-cadence-interval 3 --operator-confirmed yes --operator-confirmed-at-utc <ISO-8601 timestamp>" to change how many review FAIL attempts occur between required quality-checklist answer runs after operator approval.');
    lines.push('Tip: run "workflow set --optional-check-rule-id <id> --optional-check-rule-title <title> --optional-check-rule-prompt <prompt> --optional-check-rule-enabled true|false --optional-check-rule-exclude-test-only true|false --operator-confirmed yes --operator-confirmed-at-utc <ISO-8601 timestamp>" to add or update an optional quality-check rule.');
    lines.push('Tip: run "workflow set --optional-skill-selection-mode off|optional|mandatory --operator-confirmed yes --operator-confirmed-at-utc <ISO-8601 timestamp>" to change task-start specialist-skill selection after operator approval.');
    lines.push('Tip: run "workflow set --garda-self-guard on|off" to control agent self-entry into protected orchestrator work; off requires explicit operator approval.');
    return colorizeWorkflowHumanOutput(lines.join('\n'));
}

export function formatWorkflowSetSummaryOutput(result: WorkflowSetResult): string {
    const lines = [
        `Status: ${result.status}`,
        `RequestedFields: ${formatWorkflowFieldList(result.requested_fields)}`,
        `ChangedFields: ${formatWorkflowFieldList(result.changed_fields)}`,
        `NoOpFields: ${formatWorkflowFieldList(result.noop_fields)}`
    ];
    if (result.audit_path) {
        lines.push(`AuditPath: ${result.audit_path}`);
    }
    if (result.protected_manifest_path) {
        lines.push(`ProtectedManifestPath: ${result.protected_manifest_path}`);
    }
    if (result.status === 'NO_CHANGE') {
        lines.push(result.audit_path
            ? 'Hint: requested workflow settings already matched the current config; audit evidence was refreshed.'
            : 'Hint: requested workflow settings already matched the current config; no audit record was written.');
    }
    return colorizeWorkflowHumanOutput(lines.join('\n'));
}
