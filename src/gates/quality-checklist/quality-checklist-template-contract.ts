import type { TrustBoundaryMatrixEntry } from '../../core/trust-boundary-analysis';
import { stringSha256 } from '../shared/helpers';

export const QUALITY_CHECKLIST_ID = 'optional_quality_checks';

export const QUALITY_CHECKLIST_ANSWERS_TEMPLATE_EVENT_SOURCE = 'quality-checklist-answers-template';
export const QUALITY_CHECKLIST_ANSWERS_TEMPLATE_BINDING_EVENT_SOURCE = 'quality-checklist-answers-template-binding';
export const QUALITY_CHECKLIST_ANSWERS_TEMPLATE_BINDING_RECORDED_EVENT = 'QUALITY_CHECKLIST_ANSWERS_TEMPLATE_BINDING_RECORDED';

export interface QualityChecklistAnswersTemplateAnswer {
    rule_id: string;
    status: string;
    answer: string;
    evidence_files?: string[];
    actions_taken?: string[];
    actions_required?: string[];
    trust_boundary_matrix?: TrustBoundaryMatrixEntry[];
}

export interface QualityChecklistAnswersTemplate {
    schema_version: 1;
    timestamp_utc: string;
    event_source: typeof QUALITY_CHECKLIST_ANSWERS_TEMPLATE_EVENT_SOURCE;
    task_id: string;
    checklist_id: typeof QUALITY_CHECKLIST_ID;
    preflight_path: string;
    preflight_sha256: string;
    workflow_config_path: string;
    workflow_config_sha256: string | null;
    effective_policy_sha256: string;
    active_rule_ids: string[];
    active_rule_fingerprints?: Record<string, string>;
    answers: QualityChecklistAnswersTemplateAnswer[];
}

export interface QualityChecklistAnswersTemplateAssessment {
    status: 'missing' | 'invalid' | 'stale' | 'current';
    reason: string;
    template: QualityChecklistAnswersTemplate | null;
}

export interface QualityChecklistAnswersTemplateBinding {
    schema_version: 1;
    event_source: typeof QUALITY_CHECKLIST_ANSWERS_TEMPLATE_BINDING_EVENT_SOURCE;
    task_id: string;
    checklist_id: typeof QUALITY_CHECKLIST_ID;
    answers_path: string;
    preflight_path: string;
    preflight_sha256: string;
    workflow_config_path: string;
    workflow_config_sha256: string | null;
    effective_policy_sha256: string;
    active_rule_ids: string[];
    active_rule_fingerprints: Record<string, string>;
    answers_template_policy_sha256: string;
}

export interface MaterializeQualityChecklistAnswersTemplateResult {
    status: 'created' | 'refreshed' | 'current' | 'repair_created';
    answers_path: string;
    template: QualityChecklistAnswersTemplate;
    original_answers_path?: string;
    warning?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function normalizeRuleId(value: unknown): string {
    return String(value || '').trim().toLowerCase();
}

const RULE_FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/;

export function normalizeRuleFingerprint(value: unknown): string {
    const fingerprint = typeof value === 'string' ? value.trim().toLowerCase() : '';
    return RULE_FINGERPRINT_PATTERN.test(fingerprint) ? fingerprint : '';
}

export function normalizeActiveRuleIds(value: unknown): string[] | null {
    if (!Array.isArray(value)) {
        return null;
    }
    const ruleIds = value.map((entry) => normalizeRuleId(entry));
    if (!ruleIds.every(Boolean)) {
        return null;
    }
    return ruleIds;
}

export function normalizeActiveRuleFingerprints(
    value: unknown,
    activeRuleIds: readonly string[]
): Record<string, string> | null {
    if (!isRecord(value)) {
        return null;
    }
    const fingerprints: Record<string, string> = {};
    for (const ruleId of activeRuleIds) {
        const fingerprint = normalizeRuleFingerprint(value[ruleId]);
        if (!fingerprint) {
            return null;
        }
        fingerprints[ruleId] = fingerprint;
    }
    return fingerprints;
}

export function qualityChecklistAnswersTemplatePolicySha256FromParts(
    activeRuleIds: readonly string[],
    activeRuleFingerprints: Record<string, string>
): string {
    return stringSha256(JSON.stringify({
        schema_version: 1,
        active_rule_ids: activeRuleIds,
        active_rule_fingerprints: activeRuleIds.map((ruleId) => [
            ruleId,
            normalizeRuleFingerprint(activeRuleFingerprints[ruleId])
        ])
    })) || '';
}

export function activeRuleFingerprintsMatch(
    left: unknown,
    right: unknown,
    activeRuleIds: readonly string[]
): boolean {
    const normalizedLeft = normalizeActiveRuleFingerprints(left, activeRuleIds);
    const normalizedRight = normalizeActiveRuleFingerprints(right, activeRuleIds);
    return !!normalizedLeft
        && !!normalizedRight
        && activeRuleIds.every((ruleId) => normalizedLeft[ruleId] === normalizedRight[ruleId]);
}

export function templateRuleIds(value: unknown): string[] | null {
    if (!Array.isArray(value)) {
        return null;
    }
    const ruleIds = value.map((entry) => isRecord(entry) ? normalizeRuleId(entry.rule_id) : '');
    return ruleIds.every(Boolean) ? ruleIds : null;
}

export function activeRuleIdsMatch(left: readonly unknown[] | undefined, right: readonly unknown[] | undefined): boolean {
    const normalizedLeft = normalizeActiveRuleIds(left) || [];
    const normalizedRight = normalizeActiveRuleIds(right) || [];
    return normalizedLeft.length === normalizedRight.length
        && normalizedLeft.every((ruleId, index) => ruleId === normalizedRight[index]);
}

export function bindingMatchesTemplate(
    binding: QualityChecklistAnswersTemplateBinding | null,
    template: QualityChecklistAnswersTemplate
): binding is QualityChecklistAnswersTemplateBinding {
    return !!binding
        && binding.task_id === template.task_id
        && binding.checklist_id === template.checklist_id
        && binding.preflight_path === template.preflight_path
        && binding.preflight_sha256 === template.preflight_sha256
        && binding.workflow_config_path === template.workflow_config_path
        && binding.workflow_config_sha256 === template.workflow_config_sha256
        && binding.effective_policy_sha256 === template.effective_policy_sha256
        && activeRuleIdsMatch(binding.active_rule_ids, template.active_rule_ids)
        && activeRuleFingerprintsMatch(
            binding.active_rule_fingerprints,
            template.active_rule_fingerprints,
            binding.active_rule_ids
        )
        && binding.answers_template_policy_sha256 === qualityChecklistAnswersTemplatePolicySha256FromParts(
            binding.active_rule_ids,
            binding.active_rule_fingerprints
        );
}

// Persistence delegates policy decisions to the existing canonical checklist owner.
export interface QualityChecklistAnswersTemplatePolicy {
    buildTemplate(options: {
        repoRoot: string;
        taskId: string;
        preflightPath?: unknown;
    }): QualityChecklistAnswersTemplate;
    assessTemplate(options: {
        repoRoot: string;
        taskId: string;
        preflightPath?: unknown;
        template: unknown;
    }): QualityChecklistAnswersTemplateAssessment;
    normalizeReusableAnswer(value: unknown): QualityChecklistAnswersTemplateAnswer | null;
    mergeReusableAnswers(
        currentTemplate: QualityChecklistAnswersTemplate,
        staleTemplate: QualityChecklistAnswersTemplate | null,
        binding: QualityChecklistAnswersTemplateBinding | null
    ): QualityChecklistAnswersTemplate;
}
