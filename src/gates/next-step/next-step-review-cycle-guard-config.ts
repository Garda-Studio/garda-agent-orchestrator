import * as fs from 'node:fs';
import { normalizeReviewCycleGuardConfig } from '../../core/review-cycle-guard';
import { buildDefaultWorkflowConfig } from '../../core/workflow-config';
import { validateWorkflowConfig } from '../../schemas/config-artifacts';
import { resolveWorkflowConfigPath } from '../full-suite/full-suite-validation';
import { toRepoDisplayPath } from './next-step-command-formatters';
import { isPlainRecord } from '../../core/records';
function fileExists(filePath: string): boolean {
    return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
}

function readWorkflowConfigRecordForReviewCycleGuard(repoRoot: string): Record<string, unknown> | null {
    const workflowConfigPath = resolveWorkflowConfigPath(repoRoot);
    if (!fileExists(workflowConfigPath)) {
        return null;
    }

    let workflowConfig: unknown;
    try {
        workflowConfig = JSON.parse(fs.readFileSync(workflowConfigPath, 'utf8'));
    } catch (error: unknown) {
        throw new Error(
            `Workflow config at '${toRepoDisplayPath(repoRoot, workflowConfigPath)}' is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
        );
    }
    if (!isPlainRecord(workflowConfig)) {
        throw new Error(
            `Workflow config at '${toRepoDisplayPath(repoRoot, workflowConfigPath)}' must be a JSON object.`
        );
    }
    return workflowConfig;
}

export function readNormalizedReviewCycleGuardConfig(repoRoot: string) {
    const defaultWorkflowConfig = buildDefaultWorkflowConfig();
    let rawReviewCycleGuard: unknown = defaultWorkflowConfig.review_cycle_guard;
    const workflowConfig = readWorkflowConfigRecordForReviewCycleGuard(repoRoot);
    if (workflowConfig?.review_cycle_guard !== undefined) {
        const validatedWorkflowConfig = validateWorkflowConfig({
            full_suite_validation: defaultWorkflowConfig.full_suite_validation,
            review_execution_policy: defaultWorkflowConfig.review_execution_policy,
            scope_budget_guard: defaultWorkflowConfig.scope_budget_guard,
            review_cycle_guard: workflowConfig.review_cycle_guard
        });
        rawReviewCycleGuard = isPlainRecord(validatedWorkflowConfig.review_cycle_guard)
            ? validatedWorkflowConfig.review_cycle_guard
            : defaultWorkflowConfig.review_cycle_guard;
    }
    const reviewCycleGuardConfig = normalizeReviewCycleGuardConfig(rawReviewCycleGuard);
    return reviewCycleGuardConfig;
}
