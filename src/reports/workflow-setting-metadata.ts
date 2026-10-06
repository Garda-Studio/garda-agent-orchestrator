import {
    FULL_SUITE_TIMEOUT_RETRY_COUNT_MAX,
    FULL_SUITE_VALIDATION_PLACEMENTS,
    MAX_OPTIONAL_QUALITY_CHECKS_REVIEW_FAILURE_CADENCE_INTERVAL,
    PROJECT_MEMORY_MAINTENANCE_MODES,
    PROJECT_MEMORY_READ_STRATEGIES
} from '../core/workflow-config';
import { COMPACT_SETTING_REGISTRY, compactSettingMinimum, compactSettingMaximum } from '../core/compact/setting-definitions';
import { REVIEW_EXECUTION_POLICY_MODES, describeReviewExecutionPolicy } from '../core/review-execution-policy';
import { SCOPE_BUDGET_GUARD_ACTIONS } from '../core/scope-budget-guard';
import { REVIEW_CYCLE_GUARD_ACTIONS } from '../core/review-cycle-guard';
import { OUT_OF_SCOPE_FAILURE_POLICIES } from '../gates/full-suite/full-suite-validation';
import { CANONICAL_OPTIONAL_SKILL_SELECTION_POLICY_MODES } from '../runtime/optional-skill-selection';
import { EXCLUDED_REVIEW_TYPES_SETTING_DESCRIPTION } from './review-type-setting-text';

export type WorkflowSettingValueType = 'boolean' | 'enum' | 'enum_list' | 'integer' | 'string' | 'string_list';

export interface WorkflowSettingOption {
    value: string;
    label: string;
    description: string;
}

export interface WorkflowSettingDefinition {
    id: string;
    key: string;
    label: string;
    description: string;
    flag: string;
    value_type: WorkflowSettingValueType;
    options: WorkflowSettingOption[];
    min?: number;
    max?: number;
    placeholder?: string;
    editable?: boolean;
}

function booleanOptions(onDescription: string, offDescription: string): WorkflowSettingOption[] {
    return [
        {
            value: 'true',
            label: 'On',
            description: onDescription
        },
        {
            value: 'false',
            label: 'Off',
            description: offDescription
        }
    ];
}

const fullSuitePlacementOptions: WorkflowSettingOption[] = FULL_SUITE_VALIDATION_PLACEMENTS.map((placement) => {
    switch (placement) {
        case 'after_compile_before_reviews':
            return {
                value: placement,
                label: 'After compile, before reviews',
                description: 'Runs the full suite after compile passes and before reviewer work starts.'
            };
        case 'before_test_review':
            return {
                value: placement,
                label: 'Before test review',
                description: 'Runs the full suite immediately before the test-review lane needs its evidence.'
            };
        case 'before_completion':
            return {
                value: placement,
                label: 'Before completion',
                description: 'Defers the full suite until the final completion path.'
            };
        default:
            return {
                value: placement,
                label: placement,
                description: 'Full-suite placement mode.'
            };
    }
});

const outOfScopeFailurePolicyOptions: WorkflowSettingOption[] = OUT_OF_SCOPE_FAILURE_POLICIES.map((policy) => {
    switch (policy) {
        case 'AUDIT_AND_BLOCK':
            return {
                value: policy,
                label: 'Audit and block',
                description: 'Records the out-of-scope failure and stops the workflow until it is resolved.'
            };
        case 'AUDIT_AND_WARN':
            return {
                value: policy,
                label: 'Audit and warn',
                description: 'Records the out-of-scope failure but allows the workflow to continue with a warning.'
            };
        default:
            return {
                value: policy,
                label: policy,
                description: 'Out-of-scope failure policy.'
            };
    }
});

const reviewExecutionPolicyOptions: WorkflowSettingOption[] = REVIEW_EXECUTION_POLICY_MODES.map((mode) => ({
    value: mode,
    label: mode.replace(/_/gu, ' '),
    description: describeReviewExecutionPolicy(mode)
}));

const scopeBudgetActionOptions: WorkflowSettingOption[] = SCOPE_BUDGET_GUARD_ACTIONS.map((action) => {
    if (action === 'BLOCK_FOR_SPLIT') {
        return {
            value: action,
            label: 'Legacy max maps to block',
            description: 'Compatibility mode for legacy max_* values: max_* is interpreted as the blocking threshold. Explicit block_* thresholds still block in every mode.'
        };
    }
    return {
        value: action,
        label: 'Legacy max maps to warn',
        description: 'Compatibility mode for legacy max_* values: max_* is interpreted as the warning threshold. Explicit block_* thresholds still block in every mode.'
    };
});

const reviewCycleActionOptions: WorkflowSettingOption[] = REVIEW_CYCLE_GUARD_ACTIONS.map((action) => {
    if (action === 'BLOCK_FOR_OPERATOR_DECISION') {
        return {
            value: action,
            label: 'Block for operator decision',
            description: 'Stops repeated review loops until an operator chooses the recovery path.'
        };
    }
    return {
        value: action,
        label: 'Warn only',
        description: 'Reports review-cycle pressure but lets the workflow continue.'
    };
});

const projectMemoryModeOptions: WorkflowSettingOption[] = PROJECT_MEMORY_MAINTENANCE_MODES.map((mode) => {
    switch (mode) {
        case 'off':
            return {
                value: mode,
                label: 'Off',
                description: 'Do not run project-memory maintenance during closeout.'
            };
        case 'check':
            return {
                value: mode,
                label: 'Check',
                description: 'Check whether memory updates are needed without writing them.'
            };
        case 'update':
            return {
                value: mode,
                label: 'Update',
                description: 'Allow the workflow to update focused project-memory files when needed.'
            };
        case 'strict':
            return {
                value: mode,
                label: 'Strict',
                description: 'Require memory evidence before closeout can pass.'
            };
        default:
            return {
                value: mode,
                label: mode,
                description: 'Project-memory maintenance mode.'
            };
    }
});

const projectMemoryReadStrategyOptions: WorkflowSettingOption[] = PROJECT_MEMORY_READ_STRATEGIES.map((strategy) => ({
    value: strategy,
    label: strategy.replace(/_/gu, ' '),
    description: 'Read the memory index first and open detailed files only when the index points to them.'
}));

const canonicalOptionalSkillSelectionPolicyOptions: WorkflowSettingOption[] = CANONICAL_OPTIONAL_SKILL_SELECTION_POLICY_MODES.map((mode) => {
    switch (mode) {
        case 'off':
            return {
                value: mode,
                label: 'Off',
                description: 'Do not suggest or require specialist skills at task start.'
            };
        case 'mandatory':
            return {
                value: mode,
                label: 'Mandatory',
                description: 'Require a selected installed optional or custom live specialist skill before implementation starts when policy matching selects one.'
            };
        default:
            return {
                value: mode,
                label: 'Optional',
                description: 'Show installed optional, custom live specialist-skill, and recommended pack suggestions without blocking ordinary task work.'
            };
    }
});

const legacyOptionalSkillSelectionPolicyOptions: WorkflowSettingOption[] = [
    {
        value: 'advisory',
        label: 'Legacy: advisory -> optional',
        description: 'Compatibility alias for optional; saving rewrites this value to optional.'
    },
    {
        value: 'required',
        label: 'Legacy: required -> mandatory',
        description: 'Compatibility alias for mandatory; saving rewrites this value to mandatory.'
    },
    {
        value: 'strict',
        label: 'Legacy: strict -> mandatory',
        description: 'Compatibility alias for mandatory; saving rewrites this value to mandatory.'
    }
];

const optionalSkillSelectionPolicyOptions: WorkflowSettingOption[] = [
    ...canonicalOptionalSkillSelectionPolicyOptions,
    ...legacyOptionalSkillSelectionPolicyOptions
];

export const WORKFLOW_SETTING_DEFINITIONS: readonly WorkflowSettingDefinition[] = Object.freeze([
    ...COMPACT_SETTING_REGISTRY.entries.map((entry): WorkflowSettingDefinition => ({
        id: entry.id, key: entry.key, label: entry.ui.label, description: entry.ui.description, flag: entry.cli.flag,
        value_type: entry.value_type === 'boolean' ? 'boolean' : 'integer',
        options: entry.value_type === 'boolean' ? booleanOptions('Enabled for compact inspections.', 'Disabled for compact inspections.') : [],
        ...(entry.value_type === 'integer' ? { min: compactSettingMinimum(entry.id), max: compactSettingMaximum(entry.id) } : {})
    })),
    {
        id: 'full-suite-enabled',
        key: 'full_suite_validation.enabled',
        label: 'Mandatory full-suite validation',
        description: 'Controls whether the configured full-suite test command is part of the task lifecycle.',
        flag: '--full-suite-enabled',
        value_type: 'boolean',
        options: booleanOptions(
            'The configured full-suite command is required in the task lifecycle.',
            'The full-suite gate is skipped unless another workflow path requires it.'
        )
    },
    {
        id: 'optional-checks-enabled',
        key: 'optional_quality_checks.enabled',
        label: 'Optional quality checks',
        description: 'Controls whether advisory self-check rules run before expensive gates when next-step routes current implementation changes through quality-checklist. Rule edits below use the same audited workflow-setting path.',
        flag: '--optional-checks-enabled',
        value_type: 'boolean',
        options: booleanOptions(
            'Agents run the configured advisory self-check rules before compile, review, or full-suite work when checklist evidence is needed.',
            'The optional quality-checklist gate is skipped without replacing mandatory compile, review, or full-suite gates.'
        )
    },
    {
        id: 'optional-checks-review-failure-cadence-interval',
        key: 'optional_quality_checks.review_failure_cadence_interval',
        label: 'Review failures between quality checks',
        description: 'Number of recorded review-failure attempts between required quality-checklist answer runs. The counter still advances only on recorded review FAIL results; repeated next-step or preflight refreshes do not advance it.',
        flag: '--optional-checks-review-failure-cadence-interval',
        value_type: 'integer',
        min: 1,
        max: MAX_OPTIONAL_QUALITY_CHECKS_REVIEW_FAILURE_CADENCE_INTERVAL,
        options: []
    },
    {
        id: 'optional-skill-selection-mode',
        key: 'optional_skill_selection_policy.mode',
        label: 'Specialist-skill selection mode',
        description: 'Controls whether task start keeps installed optional and custom live specialist-skill matching off, optional, or mandatory. Legacy advisory/required/strict values remain read-compatible and are rewritten to canonical modes when saved.',
        flag: '--optional-skill-selection-mode',
        value_type: 'enum',
        options: optionalSkillSelectionPolicyOptions
    },
    {
        id: 'compile-gate-command',
        key: 'compile_gate.command',
        label: 'Compile-gate command',
        description: 'Executable compile/build/type-check command used by compile-gate. Local UI edits use the same audited `garda workflow set` path as full-suite settings and require explicit confirmation. When the value is __COMPILE_GATE_COMMAND_UNCONFIGURED__, compile-gate fails closed and never falls back to 40-commands.md.',
        flag: '--compile-gate-command',
        value_type: 'string',
        options: [],
        placeholder: 'compile/build/type-check command'
    },
    {
        id: 'full-suite-command',
        key: 'full_suite_validation.command',
        label: 'Full-suite command',
        description: 'Command the full-suite gate runs when mandatory full-suite validation is enabled. Local UI edits use the same audited `garda workflow set` path and require explicit confirmation.',
        flag: '--full-suite-command',
        value_type: 'string',
        options: [],
        placeholder: 'npm test'
    },
    {
        id: 'full-suite-timeout-ms',
        key: 'full_suite_validation.timeout_ms',
        label: 'Full-suite timeout',
        description: 'Maximum runtime for the full-suite command, in milliseconds.',
        flag: '--full-suite-timeout-ms',
        value_type: 'integer',
        min: 1000,
        max: 86_400_000,
        options: []
    },
    {
        id: 'full-suite-timeout-blocker',
        key: 'full_suite_validation.timeout_blocker',
        label: 'Full-suite timeout blocker',
        description: 'Controls whether repeated full-suite timeouts block the task and propose a repair task, or continue as a final warning.',
        flag: '--full-suite-timeout-blocker',
        value_type: 'boolean',
        options: booleanOptions(
            'Repeated full-suite timeouts block task completion and propose a repair task.',
            'Repeated full-suite timeouts are reported as a warning and do not block completion.'
        )
    },
    {
        id: 'full-suite-timeout-retry-count',
        key: 'full_suite_validation.timeout_retry_count',
        label: 'Full-suite timeout retries',
        description: 'How many times the full-suite command is retried after a timeout before timeout policy is applied.',
        flag: '--full-suite-timeout-retry-count',
        value_type: 'integer',
        min: 0,
        max: FULL_SUITE_TIMEOUT_RETRY_COUNT_MAX,
        options: []
    },
    {
        id: 'full-suite-green-summary-max-lines',
        key: 'full_suite_validation.green_summary_max_lines',
        label: 'Green full-suite summary length',
        description: 'How many successful full-suite output lines stay visible in compact task evidence.',
        flag: '--full-suite-green-summary-max-lines',
        value_type: 'integer',
        min: 1,
        max: 200,
        options: []
    },
    {
        id: 'full-suite-red-failure-chunk-lines',
        key: 'full_suite_validation.red_failure_chunk_lines',
        label: 'Failure output chunk length',
        description: 'How many failing full-suite lines are kept per compact failure chunk.',
        flag: '--full-suite-red-failure-chunk-lines',
        value_type: 'integer',
        min: 10,
        max: 1000,
        options: []
    },
    {
        id: 'full-suite-out-of-scope-failure-policy',
        key: 'full_suite_validation.out_of_scope_failure_policy',
        label: 'Out-of-scope failure handling',
        description: 'What the workflow does when full-suite output shows a failure outside the current task scope.',
        flag: '--full-suite-out-of-scope-failure-policy',
        value_type: 'enum',
        options: outOfScopeFailurePolicyOptions
    },
    {
        id: 'full-suite-placement',
        key: 'full_suite_validation.placement',
        label: 'Full-suite placement',
        description: 'Where the mandatory full-suite gate runs in the task lifecycle.',
        flag: '--full-suite-placement',
        value_type: 'enum',
        options: fullSuitePlacementOptions
    },
    {
        id: 'review-execution-policy',
        key: 'review_execution_policy.mode',
        label: 'Review execution mode',
        description: 'Controls whether required review lanes run in parallel, wait for code review, or run sequentially.',
        flag: '--review-execution-policy',
        value_type: 'enum',
        options: reviewExecutionPolicyOptions
    },
    {
        id: 'scope-budget-enabled',
        key: 'scope_budget_guard.enabled',
        label: 'Scope budget guard',
        description: 'Warns or blocks when a task is too large for the configured profile budget.',
        flag: '--scope-budget-enabled',
        value_type: 'boolean',
        options: booleanOptions(
            'Scope budget checks warn or block when a task exceeds the configured profile budget.',
            'Scope budget limits are not enforced for task-size decisions.'
        )
    },
    {
        id: 'scope-budget-action',
        key: 'scope_budget_guard.action',
        label: 'Legacy max mapping mode',
        description: 'Compatibility-only mode for old max_* thresholds. It does not disable blocking: explicit block_* thresholds still produce BLOCK and route to split-required.',
        flag: '--scope-budget-action',
        value_type: 'enum',
        options: scopeBudgetActionOptions,
        editable: false
    },
    {
        id: 'scope-budget-profiles',
        key: 'scope_budget_guard.profiles',
        label: 'Scope budget profiles',
        description: 'Task profiles where the scope budget guard applies. Unknown legacy values are shown explicitly instead of being dropped.',
        flag: '--scope-budget-profiles',
        value_type: 'enum_list',
        options: [],
        placeholder: 'strict,balanced'
    },
    {
        id: 'scope-budget-max-files',
        key: 'scope_budget_guard.max_files',
        label: 'Scope budget file limit',
        description: 'Maximum changed-file count before the scope budget guard reacts.',
        flag: '--scope-budget-max-files',
        value_type: 'integer',
        min: 1,
        max: 10000,
        options: []
    },
    {
        id: 'scope-budget-max-changed-lines',
        key: 'scope_budget_guard.max_changed_lines',
        label: 'Scope budget changed-line limit',
        description: 'Maximum changed-line count before the scope budget guard reacts.',
        flag: '--scope-budget-max-changed-lines',
        value_type: 'integer',
        min: 1,
        max: 1_000_000,
        options: []
    },
    {
        id: 'scope-budget-max-required-reviews',
        key: 'scope_budget_guard.max_required_reviews',
        label: 'Mandatory review type limit',
        description: 'Maximum number of distinct review types required by the current preflight before the scope budget guard reacts. Disabled review capabilities do not become mandatory just because matching files changed; this counts review types, not reviewers, attempts, or review cycles.',
        flag: '--scope-budget-max-required-reviews',
        value_type: 'integer',
        min: 1,
        max: 100,
        options: []
    },
    {
        id: 'scope-budget-max-review-tokens',
        key: 'scope_budget_guard.max_review_tokens',
        label: 'Scope budget review-token forecast',
        description: 'Maximum estimated review-token budget before the scope budget guard reacts.',
        flag: '--scope-budget-max-review-tokens',
        value_type: 'integer',
        min: 1,
        max: 10_000_000,
        options: []
    },
    {
        id: 'scope-budget-warn-files',
        key: 'scope_budget_guard.warn_files',
        label: 'Scope budget file warning',
        description: 'Changed-file count above this value is reported as WARN and continuation remains allowed. Must stay lower than the blocking threshold.',
        flag: '--scope-budget-warn-files',
        value_type: 'integer',
        min: 1,
        max: 10000,
        options: []
    },
    {
        id: 'scope-budget-block-files',
        key: 'scope_budget_guard.block_files',
        label: 'Scope budget file block',
        description: 'Changed-file count above this value is reported as BLOCK and next-step routes to split-required.',
        flag: '--scope-budget-block-files',
        value_type: 'integer',
        min: 2,
        max: 10000,
        options: []
    },
    {
        id: 'scope-budget-warn-changed-lines',
        key: 'scope_budget_guard.warn_changed_lines',
        label: 'Scope budget changed-line warning',
        description: 'Changed-line count above this value is reported as WARN and continuation remains allowed. Must stay lower than the blocking threshold.',
        flag: '--scope-budget-warn-changed-lines',
        value_type: 'integer',
        min: 1,
        max: 1_000_000,
        options: []
    },
    {
        id: 'scope-budget-block-changed-lines',
        key: 'scope_budget_guard.block_changed_lines',
        label: 'Scope budget changed-line block',
        description: 'Changed-line count above this value is reported as BLOCK and next-step routes to split-required.',
        flag: '--scope-budget-block-changed-lines',
        value_type: 'integer',
        min: 2,
        max: 1_000_000,
        options: []
    },
    {
        id: 'scope-budget-warn-required-reviews',
        key: 'scope_budget_guard.warn_required_reviews',
        label: 'Mandatory review type warning',
        description: 'Distinct required review type count above this value is reported as WARN. Disabled review capabilities do not become mandatory just because matching files changed; this counts review types, not reviewers, attempts, or review cycles.',
        flag: '--scope-budget-warn-required-reviews',
        value_type: 'integer',
        min: 1,
        max: 100,
        options: []
    },
    {
        id: 'scope-budget-block-required-reviews',
        key: 'scope_budget_guard.block_required_reviews',
        label: 'Mandatory review type block',
        description: 'Distinct required review type count above this value is reported as BLOCK and next-step routes to split-required.',
        flag: '--scope-budget-block-required-reviews',
        value_type: 'integer',
        min: 2,
        max: 100,
        options: []
    },
    {
        id: 'scope-budget-warn-review-tokens',
        key: 'scope_budget_guard.warn_review_tokens',
        label: 'Review-token forecast warning',
        description: 'Estimated review-token budget above this value is reported as WARN and continuation remains allowed.',
        flag: '--scope-budget-warn-review-tokens',
        value_type: 'integer',
        min: 1,
        max: 10_000_000,
        options: []
    },
    {
        id: 'scope-budget-block-review-tokens',
        key: 'scope_budget_guard.block_review_tokens',
        label: 'Review-token forecast block',
        description: 'Estimated review-token budget above this value is reported as BLOCK and next-step routes to split-required.',
        flag: '--scope-budget-block-review-tokens',
        value_type: 'integer',
        min: 2,
        max: 10_000_000,
        options: []
    },
    {
        id: 'review-cycle-enabled',
        key: 'review_cycle_guard.enabled',
        label: 'Review-cycle guard',
        description: 'Detects repeated non-test review loops before they consume too much work.',
        flag: '--review-cycle-enabled',
        value_type: 'boolean',
        options: booleanOptions(
            'Repeated non-test review loops are detected before closeout continues.',
            'Review-cycle pressure is not checked by this guard.'
        )
    },
    {
        id: 'review-cycle-action',
        key: 'review_cycle_guard.action',
        label: 'Review-cycle action',
        description: 'What happens when repeated review attempts exceed configured limits.',
        flag: '--review-cycle-action',
        value_type: 'enum',
        options: reviewCycleActionOptions
    },
    {
        id: 'review-cycle-max-failed-non-test-reviews',
        key: 'review_cycle_guard.max_failed_non_test_reviews',
        label: 'Failed non-test review limit',
        description: 'Maximum failed non-test review attempts before the review-cycle guard reacts.',
        flag: '--review-cycle-max-failed-non-test-reviews',
        value_type: 'integer',
        min: 1,
        max: 1000,
        options: []
    },
    {
        id: 'review-cycle-max-total-non-test-reviews',
        key: 'review_cycle_guard.max_total_non_test_reviews',
        label: 'Total non-test review limit',
        description: 'Maximum total non-test review attempts before the review-cycle guard reacts.',
        flag: '--review-cycle-max-total-non-test-reviews',
        value_type: 'integer',
        min: 1,
        max: 1000,
        options: []
    },
    {
        id: 'review-cycle-excluded-review-types',
        key: 'review_cycle_guard.excluded_review_types',
        label: 'Excluded review types',
        description: EXCLUDED_REVIEW_TYPES_SETTING_DESCRIPTION,
        flag: '--review-cycle-excluded-review-types',
        value_type: 'enum_list',
        options: [],
        placeholder: 'test'
    },
    {
        id: 'review-cycle-auto-split-enabled',
        key: 'review_cycle_guard.auto_split_enabled',
        label: 'Automatic review-cycle split prompt',
        description: 'Allows review-cycle pressure to emit an auto-split prompt when the action is BLOCK_FOR_OPERATOR_DECISION. It has no blocking effect while action is WARN_ONLY.',
        flag: '--review-cycle-auto-split-enabled',
        value_type: 'boolean',
        options: booleanOptions(
            'Review-cycle pressure can emit the auto-split prompt when the action is BLOCK_FOR_OPERATOR_DECISION.',
            'Review-cycle pressure never emits the auto-split prompt.'
        )
    },
    {
        id: 'project-memory-enabled',
        key: 'project_memory_maintenance.enabled',
        label: 'Project-memory maintenance',
        description: 'Controls whether closeout checks project-memory impact.',
        flag: '--project-memory-enabled',
        value_type: 'boolean',
        options: booleanOptions(
            'Closeout checks whether project-memory impact evidence is needed.',
            'Closeout does not run project-memory maintenance checks.'
        )
    },
    {
        id: 'project-memory-mode',
        key: 'project_memory_maintenance.mode',
        label: 'Project-memory mode',
        description: 'How strongly the workflow enforces project-memory impact work.',
        flag: '--project-memory-mode',
        value_type: 'enum',
        options: projectMemoryModeOptions
    },
    {
        id: 'project-memory-run-before-final-closeout',
        key: 'project_memory_maintenance.run_before_final_closeout',
        label: 'Run memory check before final closeout',
        description: 'Runs project-memory maintenance before the final completion step.',
        flag: '--project-memory-run-before-final-closeout',
        value_type: 'boolean',
        options: booleanOptions(
            'Project-memory maintenance runs before the final completion step.',
            'Project-memory maintenance is not inserted before final closeout.'
        )
    },
    {
        id: 'project-memory-require-user-approval-for-writes',
        key: 'project_memory_maintenance.require_user_approval_for_writes',
        label: 'Require user approval for memory writes',
        description: 'Requires explicit user approval before the workflow writes project-memory files.',
        flag: '--project-memory-require-user-approval-for-writes',
        value_type: 'boolean',
        options: booleanOptions(
            'Project-memory writes require explicit user approval before the workflow writes files.',
            'Project-memory writes can proceed under the configured maintenance mode without an extra approval step.'
        )
    },
    {
        id: 'project-memory-max-compact-summary-chars',
        key: 'project_memory_maintenance.max_compact_summary_chars',
        label: 'Project-memory compact summary size',
        description: 'Maximum generated compact project-memory summary size, in characters.',
        flag: '--project-memory-max-compact-summary-chars',
        value_type: 'integer',
        min: 2000,
        max: 200000,
        options: []
    },
    {
        id: 'project-memory-read-strategy',
        key: 'project_memory_maintenance.read_strategy',
        label: 'Project-memory read strategy',
        description: 'How agents should read durable memory at task start.',
        flag: '--project-memory-read-strategy',
        value_type: 'enum',
        options: projectMemoryReadStrategyOptions
    },
    {
        id: 'project-memory-impact-retention-days',
        key: 'project_memory_maintenance.impact_artifact_retention_days',
        label: 'Project-memory impact retention',
        description: 'How many days project-memory impact artifacts are retained.',
        flag: '--project-memory-impact-artifact-retention-days',
        value_type: 'integer',
        min: 1,
        max: 3650,
        options: []
    },
    {
        id: 'task-reset-enabled',
        key: 'task_reset.enabled',
        label: 'Task reset commands',
        description: 'Allows confirmed task reset/discard mutations.',
        flag: '--task-reset-enabled',
        value_type: 'boolean',
        options: booleanOptions(
            'Confirmed task reset and discard commands are available through guarded paths.',
            'Task reset and discard mutations are unavailable.'
        )
    },
    {
        id: 'local-commit-enabled',
        key: 'local_commit.enabled',
        label: 'Local commit permission',
        description: 'An explicit audited ON grants this workspace durable permission to commit completed and audited task scope. OFF revokes it. Reviews, tests and post-commit audit remain required; no push or CI permission is granted.',
        flag: '--local-commit-enabled',
        value_type: 'boolean',
        options: booleanOptions(
            'Allow native commits of completed and audited task scope in this workspace.',
            'Block native local commits and revoke earlier grants.'
        )
    },
    {
        id: 'auto-backup-enabled',
        key: 'auto_backup.enabled',
        label: 'Scheduled auto-backups',
        description: 'Allows the daily maintenance trigger to create scheduled rollback backups when due.',
        flag: '--auto-backup-enabled',
        value_type: 'boolean',
        options: booleanOptions(
            'Daily maintenance may create scheduled rollback backups when the interval is due.',
            'Daily maintenance will not create scheduled rollback backups.'
        )
    },
    {
        id: 'auto-backup-interval-days',
        key: 'auto_backup.interval_days',
        label: 'Auto-backup interval',
        description: 'Minimum number of days between successful scheduled backups.',
        flag: '--auto-backup-interval-days',
        value_type: 'integer',
        min: 1,
        max: 3650,
        options: []
    },
    {
        id: 'auto-backup-keep-latest',
        key: 'auto_backup.keep_latest',
        label: 'Auto-backup retention',
        description: 'Number of latest backups to keep after a scheduled backup is created.',
        flag: '--auto-backup-keep-latest',
        value_type: 'integer',
        min: 1,
        max: 1000,
        options: []
    },
    {
        id: 'garda-self-guard',
        key: 'orchestrator_work_policy.mode',
        label: 'Garda self-guard',
        description: 'Controls whether agents may directly enter protected Garda control-plane work.',
        flag: '--garda-self-guard',
        value_type: 'enum',
        editable: false,
        options: [
            {
                value: 'deny_agent_entry',
                label: 'On',
                description: 'Agents cannot enter protected control-plane work without the operator-owned path.'
            },
            {
                value: 'require_operator_confirmation',
                label: 'Operator confirmation',
                description: 'Protected control-plane entry requires explicit operator confirmation.'
            }
        ]
    }
]);

export function getWorkflowSettingDefinition(key: string): WorkflowSettingDefinition | null {
    return WORKFLOW_SETTING_DEFINITIONS.find((definition) => definition.key === key) || null;
}
