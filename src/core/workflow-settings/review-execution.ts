import {
    REVIEW_EXECUTION_POLICY_MODES,
    buildDefaultReviewExecutionPolicyConfig,
    describeReviewExecutionPolicy,
    normalizeReviewExecutionPolicyMode
} from '../review-execution-policy';
import { createWorkflowSettingRegistry, type WorkflowSettingManifestEntry } from '../workflow-setting-manifest';

function admitsMode(value: unknown): value is string {
    if (typeof value !== 'string') return false;
    try {
        normalizeReviewExecutionPolicyMode(value);
        return true;
    } catch {
        return false;
    }
}

const modeEntry: WorkflowSettingManifestEntry<'enum'> = {
    id: 'review-execution-policy',
    key: 'review_execution_policy.mode',
    owner: { kind: 'workflow', section: 'review-execution-policy' },
    value_type: 'enum',
    exposure: 'operator-visible',
    default_value: buildDefaultReviewExecutionPolicyConfig().mode,
    validate: admitsMode,
    cli: { flag: '--review-execution-policy' },
    ui: {
        group: 'review-execution-policy',
        label: 'Review execution mode',
        description: 'Controls whether required review lanes run in parallel, wait for code review, or run sequentially.',
        control: 'select',
        options: REVIEW_EXECUTION_POLICY_MODES.map(mode => ({
            value: mode,
            label: mode.replace(/_/gu, ' '),
            description: describeReviewExecutionPolicy(mode)
        }))
    },
    materialize: value => [{ path: 'review_execution_policy.mode', value: normalizeReviewExecutionPolicyMode(value) }]
};

export const REVIEW_EXECUTION_SETTING_REGISTRY = createWorkflowSettingRegistry([modeEntry]);
