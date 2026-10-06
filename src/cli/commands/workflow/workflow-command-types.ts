import type {
    EffectiveReviewExecutionPolicyMode,
    ReviewExecutionPolicyMode
} from '../../../core/review-execution-policy';
import { COMPACT_CLI_OPTIONS } from '../../../core/compact/setting-definitions';
import type {
    CompileGateConfig,
    ProjectMemoryMaintenanceConfig,
    OrchestratorWorkPolicyConfig,
    OptionalQualityChecksConfig,
    TaskResetConfig,
    AutoBackupConfig,
    WorkflowConfigData
} from '../../../core/workflow-config';
import type { ScopeBudgetGuardConfig } from '../../../core/scope-budget-guard';
import type { ReviewCycleGuardConfig } from '../../../core/review-cycle-guard';
import type {
    CanonicalOptionalSkillSelectionPolicyMode,
    OptionalSkillSelectionPolicyMode
} from '../../../runtime/optional-skill-selection';

export type ParsedOptionsRecord = Record<string, string | boolean | string[] | undefined>;

export type WorkflowFileConfigData = {
    compile_gate?: WorkflowConfigData['compile_gate'];
    full_suite_validation: WorkflowConfigData['full_suite_validation'];
    review_execution_policy?: WorkflowConfigData['review_execution_policy'];
    review_delegation?: WorkflowConfigData['review_delegation'];
    scope_budget_guard?: WorkflowConfigData['scope_budget_guard'];
    review_cycle_guard?: WorkflowConfigData['review_cycle_guard'];
    project_memory_maintenance?: WorkflowConfigData['project_memory_maintenance'];
    task_reset?: WorkflowConfigData['task_reset'];
    local_commit?: WorkflowConfigData['local_commit'];
    auto_backup?: WorkflowConfigData['auto_backup'];
    optional_quality_checks?: WorkflowConfigData['optional_quality_checks'];
    orchestrator_work_policy?: WorkflowConfigData['orchestrator_work_policy'];
    [key: string]: unknown;
};

export type WorkflowReviewExecutionPolicyView = {
    mode: EffectiveReviewExecutionPolicyMode;
    configured: boolean;
    allowed_modes: readonly ReviewExecutionPolicyMode[];
    description: string;
    visible_summary_line: string;
};

export interface WorkflowCommandRoots {
    targetRoot: string;
    bundleRoot: string;
    configPath: string;
    optionalSkillSelectionPolicyPath: string;
}

export interface ResolvedWorkflowBooleanSetting {
    value: string;
    flagName: string;
}

export type WorkflowConfigMutationSource = 'cli' | 'local-ui' | 'manual';

export interface WorkflowConfigState {
    rawConfig: WorkflowFileConfigData | null;
    config: WorkflowFileConfigData;
    exists: boolean;
    missingReviewExecutionPolicyMode: EffectiveReviewExecutionPolicyMode | null;
}

export interface WorkflowCommandResultBase {
    compact?: unknown;
    scope: 'repo-local';
    target_root: string;
    bundle_root: string;
    config_path: string;
    config_exists: boolean;
    compile_gate: CompileGateConfig;
    full_suite_validation: WorkflowConfigData['full_suite_validation'];
    review_execution_policy: WorkflowReviewExecutionPolicyView;
    review_delegation: WorkflowConfigData['review_delegation'];
    scope_budget_guard: ScopeBudgetGuardConfig;
    review_cycle_guard: ReviewCycleGuardConfig;
    project_memory_maintenance: ProjectMemoryMaintenanceConfig;
    task_reset: TaskResetConfig;
    local_commit: WorkflowConfigData['local_commit'];
    auto_backup: AutoBackupConfig;
    optional_quality_checks: OptionalQualityChecksConfig;
    optional_skill_selection_policy: {
        config_path: string;
        config_exists: boolean;
        status: 'present' | 'missing' | 'invalid';
        mode: OptionalSkillSelectionPolicyMode;
        effective_mode: CanonicalOptionalSkillSelectionPolicyMode;
        invalid_reason: string | null;
    };
    orchestrator_work_policy: OrchestratorWorkPolicyConfig;
    visible_summary_line: string;
    compile_gate_summary_line: string;
    review_execution_policy_summary_line: string;
    review_delegation_summary_line: string;
    scope_budget_guard_summary_line: string;
    review_cycle_guard_summary_line: string;
    project_memory_maintenance_summary_line: string;
    task_reset_summary_line: string;
    auto_backup_summary_line: string;
    optional_quality_checks_summary_line: string;
    optional_skill_selection_policy_summary_line: string;
    orchestrator_work_policy_summary_line: string;
}

export interface WorkflowShowResult extends WorkflowCommandResultBase {
    action: 'show';
}

export interface WorkflowSetResult extends WorkflowCommandResultBase {
    action: 'set';
    status: 'CHANGED' | 'NO_CHANGE';
    changed: boolean;
    requested_fields: string[];
    changed_fields: string[];
    noop_fields: string[];
    audit_path: string | null;
    protected_manifest_path: string | null;
}

export interface WorkflowValidateResult extends WorkflowCommandResultBase {
    action: 'validate';
    status: 'PASS';
}

export interface WorkflowExplainResult extends WorkflowCommandResultBase {
    action: 'explain';
    topic: 'workflow-guards';
    explanation: string[];
}

export const WORKFLOW_SHARED_DEFINITIONS = {
    '--target-root': { key: 'targetRoot', type: 'string' },
    '--bundle-root': { key: 'bundleRoot', type: 'string' },
    '--json': { key: 'json', type: 'boolean' }
};

export const WORKFLOW_SET_DEFINITIONS = {
    ...COMPACT_CLI_OPTIONS,
    ...WORKFLOW_SHARED_DEFINITIONS,
    '--full-suite': { key: 'fullSuiteAlias', type: 'string' },
    '--compile-gate-command': { key: 'compileGateCommand', type: 'string' },
    '--full-suite-enabled': { key: 'fullSuiteEnabled', type: 'string' },
    '--full-suite-command': { key: 'fullSuiteCommand', type: 'string' },
    '--full-suite-timeout-ms': { key: 'fullSuiteTimeoutMs', type: 'string' },
    '--full-suite-timeout-blocker': { key: 'fullSuiteTimeoutBlocker', type: 'string' },
    '--full-suite-timeout-retry-count': { key: 'fullSuiteTimeoutRetryCount', type: 'string' },
    '--full-suite-green-summary-max-lines': { key: 'fullSuiteGreenSummaryMaxLines', type: 'string' },
    '--full-suite-red-failure-chunk-lines': { key: 'fullSuiteRedFailureChunkLines', type: 'string' },
    '--full-suite-out-of-scope-failure-policy': { key: 'fullSuiteOutOfScopeFailurePolicy', type: 'string' },
    '--full-suite-placement': { key: 'fullSuitePlacement', type: 'string' },
    '--review-execution-policy': { key: 'reviewExecutionPolicy', type: 'string' },
    '--no-delegate': { key: 'noDelegateAlias', type: 'string' },
    '--review-delegation-no-delegate': { key: 'reviewDelegationNoDelegate', type: 'string' },
    '--scope-budget': { key: 'scopeBudgetAlias', type: 'string' },
    '--scope-budget-enabled': { key: 'scopeBudgetEnabled', type: 'string' },
    '--scope-budget-action': { key: 'scopeBudgetAction', type: 'string' },
    '--scope-budget-profiles': { key: 'scopeBudgetProfiles', type: 'string' },
    '--scope-budget-max-files': { key: 'scopeBudgetMaxFiles', type: 'string' },
    '--scope-budget-max-changed-lines': { key: 'scopeBudgetMaxChangedLines', type: 'string' },
    '--scope-budget-max-required-reviews': { key: 'scopeBudgetMaxRequiredReviews', type: 'string' },
    '--scope-budget-max-review-tokens': { key: 'scopeBudgetMaxReviewTokens', type: 'string' },
    '--scope-budget-warn-files': { key: 'scopeBudgetWarnFiles', type: 'string' },
    '--scope-budget-block-files': { key: 'scopeBudgetBlockFiles', type: 'string' },
    '--scope-budget-warn-changed-lines': { key: 'scopeBudgetWarnChangedLines', type: 'string' },
    '--scope-budget-block-changed-lines': { key: 'scopeBudgetBlockChangedLines', type: 'string' },
    '--scope-budget-warn-required-reviews': { key: 'scopeBudgetWarnRequiredReviews', type: 'string' },
    '--scope-budget-block-required-reviews': { key: 'scopeBudgetBlockRequiredReviews', type: 'string' },
    '--scope-budget-warn-review-tokens': { key: 'scopeBudgetWarnReviewTokens', type: 'string' },
    '--scope-budget-block-review-tokens': { key: 'scopeBudgetBlockReviewTokens', type: 'string' },
    '--review-cycle-enabled': { key: 'reviewCycleEnabled', type: 'string' },
    '--review-cycle-action': { key: 'reviewCycleAction', type: 'string' },
    '--review-cycle-max-failed-non-test-reviews': { key: 'reviewCycleMaxFailedNonTestReviews', type: 'string' },
    '--review-cycle-max-total-non-test-reviews': { key: 'reviewCycleMaxTotalNonTestReviews', type: 'string' },
    '--review-cycle-excluded-review-types': { key: 'reviewCycleExcludedReviewTypes', type: 'string' },
    '--review-cycle': { key: 'reviewCycleAlias', type: 'string' },
    '--review-cycle-auto-split': { key: 'reviewCycleAutoSplitAlias', type: 'string' },
    '--review-cycle-auto-split-enabled': { key: 'reviewCycleAutoSplitEnabled', type: 'string' },
    '--project-memory': { key: 'projectMemoryAlias', type: 'string' },
    '--project-memory-enabled': { key: 'projectMemoryEnabled', type: 'string' },
    '--project-memory-mode': { key: 'projectMemoryMode', type: 'string' },
    '--project-memory-run-before-final-closeout': { key: 'projectMemoryRunBeforeFinalCloseout', type: 'string' },
    '--project-memory-require-user-approval-for-writes': { key: 'projectMemoryRequireUserApprovalForWrites', type: 'string' },
    '--project-memory-max-compact-summary-chars': { key: 'projectMemoryMaxCompactSummaryChars', type: 'string' },
    '--project-memory-read-strategy': { key: 'projectMemoryReadStrategy', type: 'string' },
    '--project-memory-impact-artifact-retention-days': { key: 'projectMemoryImpactArtifactRetentionDays', type: 'string' },
    '--task-reset': { key: 'taskResetAlias', type: 'string' },
    '--task-reset-enabled': { key: 'taskResetEnabled', type: 'string' },
    '--local-commit': { key: 'localCommitAlias', type: 'string' },
    '--local-commit-enabled': { key: 'localCommitEnabled', type: 'string' },
    '--auto-backup': { key: 'autoBackupAlias', type: 'string' },
    '--auto-backup-enabled': { key: 'autoBackupEnabled', type: 'string' },
    '--auto-backup-interval-days': { key: 'autoBackupIntervalDays', type: 'string' },
    '--auto-backup-keep-latest': { key: 'autoBackupKeepLatest', type: 'string' },
    '--optional-checks': { key: 'optionalChecksAlias', type: 'string' },
    '--optional-checks-enabled': { key: 'optionalChecksEnabled', type: 'string' },
    '--optional-checks-review-failure-cadence-interval': { key: 'optionalChecksReviewFailureCadenceInterval', type: 'string' },
    '--optional-check-rule-id': { key: 'optionalCheckRuleId', type: 'string' },
    '--optional-check-rule-title': { key: 'optionalCheckRuleTitle', type: 'string' },
    '--optional-check-rule-prompt': { key: 'optionalCheckRulePrompt', type: 'string' },
    '--optional-check-rule-enabled': { key: 'optionalCheckRuleEnabled', type: 'string' },
    '--optional-check-rule-exclude-test-only': { key: 'optionalCheckRuleExcludeTestOnly', type: 'string' },
    '--optional-check-rule-delete': { key: 'optionalCheckRuleDelete', type: 'string' },
    '--optional-skill-selection-mode': { key: 'optionalSkillSelectionMode', type: 'string' },
    '--garda-self-guard': { key: 'gardaSelfGuard', type: 'string' },
    '--mutation-source': { key: 'mutationSource', type: 'string' },
    '--operator-confirmed': { key: 'operatorConfirmed', type: 'string' },
    '--operator-confirmed-at-utc': { key: 'operatorConfirmedAtUtc', type: 'string' }
};
