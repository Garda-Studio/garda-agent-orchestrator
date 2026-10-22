import { createWorkflowSettingRegistry } from '../workflow-setting-manifest';
import { COMPACT_SETTING_REGISTRY } from '../compact/setting-definitions';
import { BACKUP_SETTING_REGISTRY } from './backup';
import { COMPILE_SETTING_REGISTRY } from './compile';
import { FULL_SUITE_SETTING_REGISTRY } from './full-suite';
import { OPTIONAL_QUALITY_SETTING_REGISTRY } from './optional-quality';
import { PROJECT_MEMORY_SETTING_REGISTRY } from './project-memory';
import { PROTECTED_CONTROL_SETTING_REGISTRY } from './protected-controls';
import { REVIEW_CYCLE_SETTING_REGISTRY } from './review-cycle';
import { REVIEW_EXECUTION_SETTING_REGISTRY } from './review-execution';
import { PARENT_AUDIT_SETTING_REGISTRY } from './parent-audit';
import { SCOPE_BUDGET_CONTROL_SETTING_REGISTRY } from './scope-budget-controls';
import { SCOPE_BUDGET_THRESHOLD_SETTING_REGISTRY } from './scope-budget-thresholds';

// The public catalog historically interleaves these families. Keep that order
// explicit while reusing each canonical owner's validators and materializers.
// External optional-skill policy remains with its guarded owner and report facade.
export const WORKFLOW_SETTING_REGISTRY = createWorkflowSettingRegistry([
    ...COMPACT_SETTING_REGISTRY.entries,
    FULL_SUITE_SETTING_REGISTRY.require('full-suite-enabled'),
    ...OPTIONAL_QUALITY_SETTING_REGISTRY.entries,
    ...COMPILE_SETTING_REGISTRY.entries,
    ...FULL_SUITE_SETTING_REGISTRY.entries.filter(entry => entry.id !== 'full-suite-enabled'),
    ...REVIEW_EXECUTION_SETTING_REGISTRY.entries,
    ...PARENT_AUDIT_SETTING_REGISTRY.entries,
    SCOPE_BUDGET_CONTROL_SETTING_REGISTRY.require('scope-budget-enabled'),
    SCOPE_BUDGET_CONTROL_SETTING_REGISTRY.require('scope-budget-action'),
    SCOPE_BUDGET_CONTROL_SETTING_REGISTRY.require('scope-budget-profiles'),
    ...SCOPE_BUDGET_THRESHOLD_SETTING_REGISTRY.entries,
    SCOPE_BUDGET_CONTROL_SETTING_REGISTRY.require('scope-budget-warn-files'),
    SCOPE_BUDGET_CONTROL_SETTING_REGISTRY.require('scope-budget-block-files'),
    SCOPE_BUDGET_CONTROL_SETTING_REGISTRY.require('scope-budget-warn-changed-lines'),
    SCOPE_BUDGET_CONTROL_SETTING_REGISTRY.require('scope-budget-block-changed-lines'),
    SCOPE_BUDGET_CONTROL_SETTING_REGISTRY.require('scope-budget-warn-required-reviews'),
    SCOPE_BUDGET_CONTROL_SETTING_REGISTRY.require('scope-budget-block-required-reviews'),
    SCOPE_BUDGET_CONTROL_SETTING_REGISTRY.require('scope-budget-warn-review-tokens'),
    SCOPE_BUDGET_CONTROL_SETTING_REGISTRY.require('scope-budget-block-review-tokens'),
    ...REVIEW_CYCLE_SETTING_REGISTRY.entries,
    ...PROJECT_MEMORY_SETTING_REGISTRY.entries,
    PROTECTED_CONTROL_SETTING_REGISTRY.require('task-reset-enabled'),
    PROTECTED_CONTROL_SETTING_REGISTRY.require('local-commit-enabled'),
    ...BACKUP_SETTING_REGISTRY.entries,
    PROTECTED_CONTROL_SETTING_REGISTRY.require('garda-self-guard')
]);
