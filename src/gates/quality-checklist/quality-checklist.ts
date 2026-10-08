import * as fs from 'node:fs';
import * as path from 'node:path';

import {
    formatOptionalQualityChecksRuleSetDiagnostics,
    getOptionalQualityCheckRuleScopeSkipReason,
    getWorkflowConfigPath,
    normalizeOptionalQualityCheckChangedFileRegexes,
    normalizeOptionalQualityCheckScopeCategories,
    normalizeOptionalQualityChecksConfig,
    resolveOptionalQualityChecksReviewFailureCadenceInterval,
    type OptionalQualityCheckRule
} from '../../core/workflow-config';
import {
    assessTrustBoundaryAnalysisApplicability,
    assessTrustBoundaryMatrix,
    buildTrustBoundaryMatrixScaffold,
    TRUST_BOUNDARY_ANALYSIS_RULE_ID,
    type TrustBoundaryMatrixEntry
} from '../../core/trust-boundary-analysis';
import { assertValidTaskId } from '../../gate-runtime/task-events';
import {
    fileSha256,
    joinOrchestratorPath,
    normalizePath,
    resolvePathInsideRepo,
    stringSha256
} from '../shared/helpers';
import {
    buildQualityChecklistEffectivePolicyEntriesFromArtifact,
    computeQualityChecklistAnswersTemplateRuleSha256,
    computeQualityChecklistEffectivePolicySha256
} from './quality-checklist-policy';
import {
    QUALITY_CHECKLIST_ID,
    QUALITY_CHECKLIST_ANSWERS_TEMPLATE_EVENT_SOURCE,
    activeRuleFingerprintsMatch,
    bindingMatchesTemplate,
    normalizeActiveRuleIds,
    normalizeActiveRuleFingerprints,
    normalizeRuleFingerprint,
    normalizeRuleId,
    templateRuleIds,
    type QualityChecklistAnswersTemplate,
    type QualityChecklistAnswersTemplateAnswer,
    type QualityChecklistAnswersTemplateAssessment,
    type QualityChecklistAnswersTemplateBinding,
    type MaterializeQualityChecklistAnswersTemplateResult
} from './quality-checklist-template-contract';
import {
    assessStoredQualityChecklistAnswersTemplateFile,
    materializeStoredQualityChecklistAnswersTemplate
} from './quality-checklist-template-persistence';

export { QUALITY_CHECKLIST_ID, QUALITY_CHECKLIST_ANSWERS_TEMPLATE_EVENT_SOURCE } from './quality-checklist-template-contract';
export type {
    QualityChecklistAnswersTemplate,
    QualityChecklistAnswersTemplateAnswer,
    QualityChecklistAnswersTemplateAssessment,
    MaterializeQualityChecklistAnswersTemplateResult
} from './quality-checklist-template-contract';
export {
    assertQualityChecklistAnswersPathHasNoSymlinks,
    resolveDefaultQualityChecklistAnswersTemplatePath
} from './quality-checklist-template-persistence';

export const QUALITY_CHECKLIST_STATUSES = Object.freeze([
    'PASS',
    'WARN',
    'ACTION_REQUIRED',
    'SKIPPED_DISABLED',
    'SKIPPED_CADENCE',
    'CONFIG_ERROR'
] as const);

export const QUALITY_CHECKLIST_ANSWER_STATUSES = Object.freeze([
    'PASS',
    'WARN',
    'ACTION_REQUIRED'
] as const);

export type QualityChecklistStatus = typeof QUALITY_CHECKLIST_STATUSES[number];
export type QualityChecklistAnswerStatus = typeof QUALITY_CHECKLIST_ANSWER_STATUSES[number];

export interface QualityChecklistAnswerInput {
    rule_id?: unknown;
    status?: unknown;
    answer?: unknown;
    evidence_files?: unknown;
    actions_taken?: unknown;
    actions_required?: unknown;
    trust_boundary_matrix?: unknown;
}

export interface QualityChecklistAnswer {
    rule_id: string;
    status: QualityChecklistAnswerStatus;
    answer: string;
    evidence_files: string[];
    actions_taken: string[];
    actions_required: string[];
    trust_boundary_matrix?: TrustBoundaryMatrixEntry[];
}

export interface QualityChecklistRuleArtifact {
    id: string;
    title: string;
    prompt: string;
    enabled: boolean;
    included_scope_categories: string[];
    included_changed_file_regexes: string[];
    excluded_scope_categories: string[];
    scope_applicability: 'active' | 'disabled' | 'skipped_by_scope';
    scope_skip_reason: string | null;
}

export interface QualityChecklistChangedFileEvidence {
    changed_files: string[];
    changed_files_count: number;
    changed_files_sha256: string;
    scope_sha256: string | null;
    scope_content_sha256: string | null;
    scope_category: string | null;
}

export interface QualityChecklistArtifact {
    schema_version: 1;
    timestamp_utc: string;
    event_source: 'quality-checklist';
    task_id: string;
    checklist_id: typeof QUALITY_CHECKLIST_ID;
    status: QualityChecklistStatus;
    outcome: 'PASS' | 'WARN' | 'FAIL' | 'INFO';
    workflow_config_path: string;
    workflow_config_sha256: string | null;
    effective_policy_sha256: string;
    preflight_path: string;
    preflight_sha256: string | null;
    changed_file_evidence: QualityChecklistChangedFileEvidence;
    scope_category: string | null;
    enabled_rule_count: number;
    active_rule_count: number;
    skipped_by_scope_rule_count: number;
    rules: QualityChecklistRuleArtifact[];
    answers: QualityChecklistAnswer[];
    actions_taken: string[];
    actions_required: string[];
    violations: string[];
}

export interface BuildQualityChecklistOptions {
    repoRoot: string;
    taskId: string;
    preflightPath?: unknown;
    answers?: unknown;
    actionsTaken?: unknown;
    actionsRequired?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toTextArray(value: unknown): string[] {
    if (Array.isArray(value)) {
        return value.map((entry) => String(entry || '').trim()).filter(Boolean);
    }
    const text = String(value || '').trim();
    return text ? [text] : [];
}

function normalizeAnswerStatus(value: unknown): QualityChecklistAnswerStatus | null {
    const normalized = String(value || '').trim().toUpperCase().replace(/[\s-]+/g, '_');
    if (normalized === 'OK' || normalized === 'PASSED') {
        return 'PASS';
    }
    if (normalized === 'WARNING' || normalized === 'WARNED') {
        return 'WARN';
    }
    if (normalized === 'ACTION' || normalized === 'REQUIRED' || normalized === 'NEEDS_ACTION') {
        return 'ACTION_REQUIRED';
    }
    return QUALITY_CHECKLIST_ANSWER_STATUSES.includes(normalized as QualityChecklistAnswerStatus)
        ? normalized as QualityChecklistAnswerStatus
        : null;
}

export function normalizeQualityChecklistAnswerInput(input: unknown): QualityChecklistAnswer | null {
    if (!isRecord(input)) {
        return null;
    }
    const ruleId = normalizeRuleId(input.rule_id ?? input.ruleId ?? input.id);
    const status = normalizeAnswerStatus(input.status);
    const answer = String(input.answer ?? input.summary ?? '').trim();
    if (!ruleId || !status || !answer) {
        return null;
    }
    const trustBoundaryMatrixInput = input.trust_boundary_matrix ?? input.trustBoundaryMatrix;
    const trustBoundaryMatrix = trustBoundaryMatrixInput === undefined
        ? undefined
        : assessTrustBoundaryMatrix(trustBoundaryMatrixInput).matrix;
    return {
        rule_id: ruleId,
        status,
        answer,
        evidence_files: toTextArray(input.evidence_files ?? input.evidenceFiles).map(normalizePath).filter(Boolean),
        actions_taken: toTextArray(input.actions_taken ?? input.actionsTaken),
        actions_required: toTextArray(input.actions_required ?? input.actionsRequired),
        ...(trustBoundaryMatrix !== undefined ? { trust_boundary_matrix: trustBoundaryMatrix } : {})
    };
}

function normalizeAnswers(value: unknown): QualityChecklistAnswer[] {
    const source = isRecord(value) && Array.isArray(value.answers) ? value.answers : value;
    if (!Array.isArray(source)) {
        return [];
    }
    return source
        .map((entry) => normalizeQualityChecklistAnswerInput(entry))
        .filter((entry): entry is QualityChecklistAnswer => entry !== null);
}

function normalizeScopeCategory(value: unknown): string | null {
    const normalized = String(value || '').trim().toLowerCase();
    return normalized || null;
}

function normalizeRuleForArtifact(
    rule: OptionalQualityCheckRule,
    scopeCategory: string | null,
    changedFiles: readonly string[],
    preflight: Record<string, unknown> | null,
    checklistEnabled: boolean
): QualityChecklistRuleArtifact {
    const trustBoundaryRequired = normalizeRuleId(rule.id) === TRUST_BOUNDARY_ANALYSIS_RULE_ID
        && assessTrustBoundaryAnalysisApplicability(preflight).required;
    const enabled = trustBoundaryRequired
        || (rule.enabled !== false && (checklistEnabled || !assessTrustBoundaryAnalysisApplicability(preflight).required));
    const includedScopeCategories = normalizeOptionalQualityCheckScopeCategories(rule.included_scope_categories);
    const includedChangedFileRegexes = normalizeOptionalQualityCheckChangedFileRegexes(rule.included_changed_file_regexes);
    const excludedScopeCategories = normalizeOptionalQualityCheckScopeCategories(rule.excluded_scope_categories);
    const scopeSkipReason = trustBoundaryRequired
        ? null
        : getOptionalQualityCheckRuleScopeSkipReason(rule, scopeCategory, changedFiles);
    const scopeApplicability: QualityChecklistRuleArtifact['scope_applicability'] = !enabled
        ? 'disabled'
        : scopeSkipReason
            ? 'skipped_by_scope'
            : 'active';
    return {
        id: normalizeRuleId(rule.id),
        title: String(rule.title || '').trim(),
        prompt: String(rule.prompt || '').trim(),
        enabled,
        included_scope_categories: includedScopeCategories,
        included_changed_file_regexes: includedChangedFileRegexes,
        excluded_scope_categories: excludedScopeCategories,
        scope_applicability: scopeApplicability,
        scope_skip_reason: scopeSkipReason
    };
}

function findDuplicateRuleIds(rules: readonly QualityChecklistRuleArtifact[]): string[] {
    const countsById = new Map<string, number>();
    for (const rule of rules) {
        countsById.set(rule.id, (countsById.get(rule.id) || 0) + 1);
    }
    return [...countsById.entries()]
        .filter(([, count]) => count > 1)
        .map(([id]) => id)
        .sort();
}

function findConfiguredDuplicateRuleIds(optionalQualityChecksInput: unknown): string[] {
    if (!isRecord(optionalQualityChecksInput) || !Array.isArray(optionalQualityChecksInput.rules)) {
        return [];
    }
    const configuredRules = optionalQualityChecksInput.rules
        .filter(isRecord)
        .map((rule) => normalizeRuleId(rule.id))
        .filter(Boolean)
        .map((id) => ({
            id,
            title: '',
            prompt: '',
            enabled: true,
            included_scope_categories: [],
            included_changed_file_regexes: [],
            excluded_scope_categories: [],
            scope_applicability: 'active' as const,
            scope_skip_reason: null
        }));
    return findDuplicateRuleIds(configuredRules);
}

function resolveQualityChecklistArtifactPath(repoRoot: string, taskId: string, artifactPath = ''): string {
    const explicit = String(artifactPath || '').trim();
    if (explicit) {
        const resolved = resolvePathInsideRepo(explicit, repoRoot, { allowMissing: true });
        if (!resolved) {
            throw new Error('QualityChecklistArtifactPath must not be empty.');
        }
        return resolved;
    }
    return joinOrchestratorPath(repoRoot, path.join('runtime', 'reviews', `${taskId}-quality-checklist.json`));
}

export function resolveDefaultQualityChecklistArtifactPath(repoRoot: string, taskId: string): string {
    return resolveQualityChecklistArtifactPath(repoRoot, taskId);
}

function resolvePreflightPath(repoRoot: string, taskId: string, preflightPath: unknown): string {
    const explicit = String(preflightPath || '').trim();
    if (explicit) {
        const resolved = resolvePathInsideRepo(explicit, repoRoot, { allowMissing: true, enforceInside: true });
        if (!resolved) {
            throw new Error('PreflightPath must not be empty.');
        }
        return resolved;
    }
    return joinOrchestratorPath(repoRoot, path.join('runtime', 'reviews', `${taskId}-preflight.json`));
}

function readJsonRecord(filePath: string): Record<string, unknown> | null {
    try {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        return isRecord(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

function readPreflightEvidence(preflightPath: string, expectedTaskId: string): {
    sha256: string | null;
    evidence: QualityChecklistChangedFileEvidence;
    violation: string | null;
    preflight: Record<string, unknown> | null;
} {
    const emptyChangedFilesSha256 = stringSha256('') || '';
    const emptyEvidence = {
        changed_files: [],
        changed_files_count: 0,
        changed_files_sha256: emptyChangedFilesSha256,
        scope_sha256: null,
        scope_content_sha256: null,
        scope_category: null
    };
    if (!fs.existsSync(preflightPath) || !fs.statSync(preflightPath).isFile()) {
        return {
            sha256: null,
            evidence: emptyEvidence,
            violation: `Preflight artifact not found: ${normalizePath(preflightPath)}.`,
            preflight: null
        };
    }
    const preflight = readJsonRecord(preflightPath);
    if (!preflight) {
        return {
            sha256: fileSha256(preflightPath),
            evidence: emptyEvidence,
            violation: `Preflight artifact is not valid JSON object: ${normalizePath(preflightPath)}.`,
            preflight: null
        };
    }
    const preflightTaskId = typeof preflight.task_id === 'string' ? preflight.task_id.trim() : '';
    if (preflightTaskId && preflightTaskId !== expectedTaskId) {
        return {
            sha256: fileSha256(preflightPath),
            evidence: emptyEvidence,
            violation: `Preflight artifact task_id '${preflightTaskId}' does not match quality-checklist task_id '${expectedTaskId}'.`,
            preflight
        };
    }
    const changedFiles = Array.isArray(preflight.changed_files)
        ? [...new Set(preflight.changed_files.map(normalizePath).filter(Boolean))].sort()
        : [];
    const metrics = isRecord(preflight.metrics) ? preflight.metrics : {};
    return {
        sha256: fileSha256(preflightPath),
        evidence: {
            changed_files: changedFiles,
            changed_files_count: changedFiles.length,
            changed_files_sha256: stringSha256(changedFiles.join('\n')) || '',
            scope_sha256: typeof metrics.scope_sha256 === 'string' ? metrics.scope_sha256.trim().toLowerCase() : null,
            scope_content_sha256: typeof metrics.scope_content_sha256 === 'string' ? metrics.scope_content_sha256.trim().toLowerCase() : null,
            scope_category: normalizeScopeCategory(preflight.scope_category)
        },
        violation: null,
        preflight
    };
}

function readChecklistRules(repoRoot: string): {
    workflowConfigPath: string;
    workflowConfigSha256: string | null;
    rules: OptionalQualityCheckRule[];
    enabled: boolean;
    violation: string | null;
    ruleSetDiagnostic: string | null;
} {
    const workflowConfigPath = getWorkflowConfigPath(joinOrchestratorPath(repoRoot, ''));
    if (!fs.existsSync(workflowConfigPath) || !fs.statSync(workflowConfigPath).isFile()) {
        return {
            workflowConfigPath,
            workflowConfigSha256: null,
            rules: [],
            enabled: false,
            violation: `Workflow config not found: ${normalizePath(workflowConfigPath)}.`,
            ruleSetDiagnostic: null
        };
    }
    const workflowConfig = readJsonRecord(workflowConfigPath);
    if (!workflowConfig) {
        return {
            workflowConfigPath,
            workflowConfigSha256: fileSha256(workflowConfigPath),
            rules: [],
            enabled: false,
            violation: `Workflow config is not valid JSON object: ${normalizePath(workflowConfigPath)}.`,
            ruleSetDiagnostic: null
        };
    }
    const configuredDuplicateRuleIds = findConfiguredDuplicateRuleIds(workflowConfig.optional_quality_checks);
    const optionalQualityChecks = normalizeOptionalQualityChecksConfig(workflowConfig.optional_quality_checks);
    const cadenceInterval = resolveOptionalQualityChecksReviewFailureCadenceInterval(workflowConfig.optional_quality_checks);
    const normalizedRules = optionalQualityChecks.rules.map((rule) => ({
        id: normalizeRuleId(rule.id),
        title: String(rule.title || '').trim(),
        prompt: String(rule.prompt || '').trim(),
        enabled: rule.enabled !== false,
        included_scope_categories: normalizeOptionalQualityCheckScopeCategories(rule.included_scope_categories),
        included_changed_file_regexes: normalizeOptionalQualityCheckChangedFileRegexes(rule.included_changed_file_regexes),
        excluded_scope_categories: normalizeOptionalQualityCheckScopeCategories(rule.excluded_scope_categories),
        scope_applicability: rule.enabled === false ? 'disabled' as const : 'active' as const,
        scope_skip_reason: null
    }));
    const duplicateRuleIds = [...new Set([
        ...configuredDuplicateRuleIds,
        ...findDuplicateRuleIds(normalizedRules)
    ])].sort();
    const configViolations = [
        duplicateRuleIds.length > 0
            ? `Workflow config has duplicate quality-check rule id(s): ${duplicateRuleIds.map((id) => `'${id}'`).join(', ')}.`
            : null,
        cadenceInterval.violation
    ].filter((entry): entry is string => !!entry);
    return {
        workflowConfigPath,
        workflowConfigSha256: fileSha256(workflowConfigPath),
        rules: optionalQualityChecks.rules,
        enabled: optionalQualityChecks.enabled,
        violation: configViolations.join(' ') || null,
        ruleSetDiagnostic: formatOptionalQualityChecksRuleSetDiagnostics(workflowConfig.optional_quality_checks)
    };
}

function decideStatus(
    repoRoot: string,
    activeRules: readonly QualityChecklistRuleArtifact[],
    skippedByScopeRules: readonly QualityChecklistRuleArtifact[],
    answers: readonly QualityChecklistAnswer[],
    violations: string[],
    rawAnswers: unknown
): QualityChecklistStatus {
    if (violations.length > 0) {
        return 'CONFIG_ERROR';
    }
    const answerCountsByRuleId = new Map<string, number>();
    for (const answer of answers) {
        answerCountsByRuleId.set(answer.rule_id, (answerCountsByRuleId.get(answer.rule_id) || 0) + 1);
    }
    for (const [ruleId, count] of answerCountsByRuleId) {
        if (count > 1) {
            violations.push(`Duplicate answer for quality-check rule '${ruleId}'.`);
        }
    }
    const activeRuleIds = new Set(activeRules.map((rule) => rule.id));
    if (activeRuleIds.has(TRUST_BOUNDARY_ANALYSIS_RULE_ID)) {
        const rawAnswerSource = isRecord(rawAnswers) && Array.isArray(rawAnswers.answers)
            ? rawAnswers.answers
            : rawAnswers;
        const rawTrustAnswers = Array.isArray(rawAnswerSource)
            ? rawAnswerSource.filter((entry) => (
                isRecord(entry)
                && normalizeRuleId(entry.rule_id ?? entry.ruleId ?? entry.id) === TRUST_BOUNDARY_ANALYSIS_RULE_ID
            ))
            : [];
        if (rawTrustAnswers.length > 1) {
            const duplicateViolation = `Duplicate answer for quality-check rule '${TRUST_BOUNDARY_ANALYSIS_RULE_ID}'.`;
            if (!violations.includes(duplicateViolation)) {
                violations.push(duplicateViolation);
            }
        }
        if (rawTrustAnswers.length === 1) {
            const assessment = assessTrustBoundaryMatrix(
                (rawTrustAnswers[0] as Record<string, unknown>).trust_boundary_matrix
                ?? (rawTrustAnswers[0] as Record<string, unknown>).trustBoundaryMatrix,
                { repoRoot }
            );
            for (const violation of assessment.violations) {
                violations.push(`Answer '${TRUST_BOUNDARY_ANALYSIS_RULE_ID}' ${violation}`);
            }
        }
    }
    const answerByRuleId = new Map(answers.map((answer) => [answer.rule_id, answer]));
    for (const rule of activeRules) {
        if (!answerByRuleId.has(rule.id)) {
            violations.push(`Missing answer for active quality-check rule '${rule.id}'.`);
        }
    }
    const skippedByScopeRuleIds = new Set(skippedByScopeRules.map((rule) => rule.id));
    for (const answer of answers) {
        if (skippedByScopeRuleIds.has(answer.rule_id)) {
            violations.push(`Answer references quality-check rule '${answer.rule_id}' skipped for the current preflight scope.`);
        } else if (!activeRuleIds.has(answer.rule_id)) {
            violations.push(`Answer references unknown or disabled quality-check rule '${answer.rule_id}'.`);
        }
        if (answer.status === 'ACTION_REQUIRED' && answer.actions_required.length === 0) {
            violations.push(`Answer '${answer.rule_id}' is ACTION_REQUIRED but has no actions_required entry.`);
        }
    }
    if (violations.length > 0) {
        return 'CONFIG_ERROR';
    }
    if (answers.some((answer) => answer.status === 'ACTION_REQUIRED')) {
        return 'ACTION_REQUIRED';
    }
    if (answers.some((answer) => answer.status === 'WARN')) {
        return 'WARN';
    }
    return 'PASS';
}

function outcomeForStatus(status: QualityChecklistStatus): QualityChecklistArtifact['outcome'] {
    if (status === 'PASS') return 'PASS';
    if (status === 'WARN') return 'WARN';
    if (status === 'SKIPPED_DISABLED' || status === 'SKIPPED_CADENCE') return 'INFO';
    return 'FAIL';
}

export function buildQualityChecklistArtifact(options: BuildQualityChecklistOptions): QualityChecklistArtifact {
    const repoRoot = path.resolve(String(options.repoRoot || '.'));
    const taskId = assertValidTaskId(String(options.taskId || '').trim());
    const preflightPath = resolvePreflightPath(repoRoot, taskId, options.preflightPath);
    const config = readChecklistRules(repoRoot);
    const preflight = readPreflightEvidence(preflightPath, taskId);
    const violations = [config.violation, preflight.violation].filter((entry): entry is string => !!entry);
    const scopeCategory = preflight.evidence.scope_category;
    const trustBoundaryRequired = assessTrustBoundaryAnalysisApplicability(preflight.preflight).required;
    const rules = config.rules.map((rule) => normalizeRuleForArtifact(
        rule,
        scopeCategory,
        preflight.evidence.changed_files,
        preflight.preflight,
        config.enabled
    ));
    const enabledRules = rules.filter((rule) => rule.enabled);
    const activeRules = enabledRules.filter((rule) => rule.scope_applicability === 'active');
    const skippedByScopeRules = enabledRules.filter((rule) => rule.scope_applicability === 'skipped_by_scope');
    const answers = normalizeAnswers(options.answers);
    const explicitActionsTaken = toTextArray(options.actionsTaken);
    const explicitActionsRequired = toTextArray(options.actionsRequired);

    let status: QualityChecklistStatus;
    if (violations.length > 0) {
        status = 'CONFIG_ERROR';
    } else if (!config.enabled && !trustBoundaryRequired) {
        status = 'SKIPPED_DISABLED';
    } else {
        status = decideStatus(repoRoot, activeRules, skippedByScopeRules, answers, violations, options.answers);
    }

    const actionsTaken = [
        ...explicitActionsTaken,
        ...answers.flatMap((answer) => answer.actions_taken)
    ].filter(Boolean);
    const actionsRequired = [
        ...explicitActionsRequired,
        ...answers.flatMap((answer) => answer.actions_required)
    ].filter(Boolean);
    if ((status === 'PASS' || status === 'WARN') && actionsRequired.length > 0) {
        status = 'ACTION_REQUIRED';
    }
    if (status === 'CONFIG_ERROR' && config.ruleSetDiagnostic) {
        violations.unshift(config.ruleSetDiagnostic);
    }

    return {
        schema_version: 1,
        timestamp_utc: new Date().toISOString(),
        event_source: 'quality-checklist',
        task_id: taskId,
        checklist_id: QUALITY_CHECKLIST_ID,
        status,
        outcome: outcomeForStatus(status),
        workflow_config_path: normalizePath(config.workflowConfigPath),
        workflow_config_sha256: config.workflowConfigSha256,
        effective_policy_sha256: computeQualityChecklistEffectivePolicySha256(
            config.rules,
            scopeCategory,
            preflight.evidence.changed_files
        ),
        preflight_path: normalizePath(preflightPath),
        preflight_sha256: preflight.sha256,
        changed_file_evidence: preflight.evidence,
        scope_category: scopeCategory,
        enabled_rule_count: enabledRules.length,
        active_rule_count: activeRules.length,
        skipped_by_scope_rule_count: skippedByScopeRules.length,
        rules,
        answers: status === 'SKIPPED_DISABLED' ? [] : answers,
        actions_taken: [...new Set(actionsTaken)].sort(),
        actions_required: [...new Set(actionsRequired)].sort(),
        violations
    };
}

export function buildQualityChecklistCadenceSkipArtifact(
    options: Omit<BuildQualityChecklistOptions, 'answers' | 'actionsTaken' | 'actionsRequired'>
): QualityChecklistArtifact {
    const artifact = buildQualityChecklistArtifact({ ...options, answers: [] });
    const blockingViolations = nonAnswerTemplateViolations(artifact);
    if (blockingViolations.length > 0) {
        return {
            ...artifact,
            status: 'CONFIG_ERROR',
            outcome: 'FAIL',
            answers: [],
            actions_taken: [],
            actions_required: [],
            violations: blockingViolations
        };
    }
    return {
        ...artifact,
        status: 'SKIPPED_CADENCE',
        outcome: 'INFO',
        answers: [],
        actions_taken: [],
        actions_required: [],
        violations: []
    };
}

function nonAnswerTemplateViolations(artifact: QualityChecklistArtifact): string[] {
    return artifact.violations.filter((violation) => (
        !violation.startsWith('Missing answer for active quality-check rule ')
        && !violation.startsWith('Quality-checklist workflow config baseline_version ')
    ));
}

function buildActiveRuleFingerprints(artifact: QualityChecklistArtifact): Record<string, string> {
    const fingerprints: Record<string, string> = {};
    for (const entry of buildQualityChecklistEffectivePolicyEntriesFromArtifact(artifact.rules)) {
        if (entry.scope_applicability !== 'active') {
            continue;
        }
        fingerprints[entry.id] = computeQualityChecklistAnswersTemplateRuleSha256(entry);
    }
    return fingerprints;
}

export function buildQualityChecklistAnswersTemplate(
    options: Omit<BuildQualityChecklistOptions, 'answers' | 'actionsTaken' | 'actionsRequired'>
): QualityChecklistAnswersTemplate {
    const artifact = buildQualityChecklistArtifact({ ...options, answers: [] });
    const blockingViolations = nonAnswerTemplateViolations(artifact);
    if (blockingViolations.length > 0) {
        throw new Error(`Cannot prepare quality checklist answers template: ${blockingViolations.join(' ')}`);
    }
    if (!artifact.preflight_sha256) {
        throw new Error('Cannot prepare quality checklist answers template without current preflight evidence.');
    }
    return {
        schema_version: 1,
        timestamp_utc: new Date().toISOString(),
        event_source: QUALITY_CHECKLIST_ANSWERS_TEMPLATE_EVENT_SOURCE,
        task_id: artifact.task_id,
        checklist_id: QUALITY_CHECKLIST_ID,
        preflight_path: artifact.preflight_path,
        preflight_sha256: artifact.preflight_sha256,
        workflow_config_path: artifact.workflow_config_path,
        workflow_config_sha256: artifact.workflow_config_sha256,
        effective_policy_sha256: artifact.effective_policy_sha256,
        active_rule_ids: artifact.rules
            .filter((rule) => rule.scope_applicability === 'active')
            .map((rule) => rule.id),
        active_rule_fingerprints: buildActiveRuleFingerprints(artifact),
        answers: artifact.rules
            .filter((rule) => rule.scope_applicability === 'active')
            .map((rule) => ({
                rule_id: rule.id,
                status: '',
                answer: '',
                ...(rule.id === TRUST_BOUNDARY_ANALYSIS_RULE_ID
                    ? { trust_boundary_matrix: buildTrustBoundaryMatrixScaffold() }
                    : {})
            }))
    };
}

function invalidAnswersTemplate(reason: string): QualityChecklistAnswersTemplateAssessment {
    return { status: 'invalid', reason, template: null };
}

function staleAnswersTemplate(
    reason: string,
    template: QualityChecklistAnswersTemplate
): QualityChecklistAnswersTemplateAssessment {
    return { status: 'stale', reason, template };
}

function normalizeReusableTemplateAnswer(value: unknown): QualityChecklistAnswersTemplateAnswer | null {
    if (!isRecord(value)
        || Object.hasOwn(value, 'title')
        || Object.hasOwn(value, 'prompt')
        || typeof value.status !== 'string'
        || typeof value.answer !== 'string') {
        return null;
    }
    const ruleId = normalizeRuleId(value.rule_id);
    if (!ruleId) {
        return null;
    }
    const optionalArrayFields = ['evidence_files', 'actions_taken', 'actions_required'] as const;
    for (const field of optionalArrayFields) {
        const fieldValue = value[field];
        if (fieldValue !== undefined && (!Array.isArray(fieldValue) || !fieldValue.every((entry) => typeof entry === 'string'))) {
            return null;
        }
    }
    const trustBoundaryMatrix = value.trust_boundary_matrix === undefined
        ? undefined
        : assessTrustBoundaryMatrix(value.trust_boundary_matrix).matrix;
    return {
        rule_id: ruleId,
        status: value.status,
        answer: value.answer,
        ...(value.evidence_files !== undefined ? { evidence_files: [...(value.evidence_files as string[])] } : {}),
        ...(value.actions_taken !== undefined ? { actions_taken: [...(value.actions_taken as string[])] } : {}),
        ...(value.actions_required !== undefined ? { actions_required: [...(value.actions_required as string[])] } : {}),
        ...(trustBoundaryMatrix !== undefined ? { trust_boundary_matrix: trustBoundaryMatrix } : {})
    };
}

function reusableTemplateAnswersByRuleId(
    template: QualityChecklistAnswersTemplate | null,
    currentTemplate: QualityChecklistAnswersTemplate,
    binding: QualityChecklistAnswersTemplateBinding | null
): Map<string, QualityChecklistAnswersTemplateAnswer> {
    const reusableAnswers = new Map<string, QualityChecklistAnswersTemplateAnswer>();
    if (!template || !Array.isArray(template.active_rule_ids) || !Array.isArray(template.answers)) {
        return reusableAnswers;
    }
    if (!bindingMatchesTemplate(binding, template)) {
        return reusableAnswers;
    }
    const staleActiveRuleIds = normalizeActiveRuleIds(template.active_rule_ids);
    const currentActiveRuleIds = normalizeActiveRuleIds(currentTemplate.active_rule_ids);
    if (!staleActiveRuleIds || !currentActiveRuleIds) {
        return reusableAnswers;
    }
    const currentRuleFingerprints = normalizeActiveRuleFingerprints(
        currentTemplate.active_rule_fingerprints,
        currentActiveRuleIds
    );
    if (!currentRuleFingerprints) {
        return reusableAnswers;
    }
    const staleActiveRuleIdsSet = new Set(staleActiveRuleIds);
    const currentActiveRuleIdsSet = new Set(currentActiveRuleIds);
    const duplicateRuleIds = new Set<string>();
    for (const answer of template.answers) {
        const normalizedAnswer = normalizeReusableTemplateAnswer(answer);
        if (!normalizedAnswer
            || !staleActiveRuleIdsSet.has(normalizedAnswer.rule_id)
            || !currentActiveRuleIdsSet.has(normalizedAnswer.rule_id)) {
            continue;
        }
        const staleFingerprint = normalizeRuleFingerprint(binding.active_rule_fingerprints[normalizedAnswer.rule_id]);
        const currentFingerprint = normalizeRuleFingerprint(currentRuleFingerprints[normalizedAnswer.rule_id]);
        if (!staleFingerprint || staleFingerprint !== currentFingerprint) {
            continue;
        }
        if (reusableAnswers.has(normalizedAnswer.rule_id)) {
            duplicateRuleIds.add(normalizedAnswer.rule_id);
            reusableAnswers.delete(normalizedAnswer.rule_id);
            continue;
        }
        reusableAnswers.set(normalizedAnswer.rule_id, normalizedAnswer);
    }
    for (const duplicateRuleId of duplicateRuleIds) {
        reusableAnswers.delete(duplicateRuleId);
    }
    return reusableAnswers;
}

function mergeReusableAnswersIntoTemplate(
    currentTemplate: QualityChecklistAnswersTemplate,
    staleTemplate: QualityChecklistAnswersTemplate | null,
    binding: QualityChecklistAnswersTemplateBinding | null
): QualityChecklistAnswersTemplate {
    const reusableAnswers = reusableTemplateAnswersByRuleId(staleTemplate, currentTemplate, binding);
    if (reusableAnswers.size === 0) {
        return currentTemplate;
    }
    return {
        ...currentTemplate,
        answers: currentTemplate.answers.map((answer) => reusableAnswers.get(answer.rule_id) ?? answer)
    };
}

export function assessQualityChecklistAnswersTemplate(options: {
    repoRoot: string;
    taskId: string;
    preflightPath?: unknown;
    template: unknown;
}): QualityChecklistAnswersTemplateAssessment {
    if (!isRecord(options.template)) {
        return invalidAnswersTemplate('Quality checklist answers template must be a JSON object.');
    }
    const template = options.template as unknown as QualityChecklistAnswersTemplate;
    if (template.schema_version !== 1 || template.event_source !== QUALITY_CHECKLIST_ANSWERS_TEMPLATE_EVENT_SOURCE) {
        return invalidAnswersTemplate('Quality checklist answers template has an unsupported schema or event_source.');
    }
    const expected = buildQualityChecklistAnswersTemplate(options);
    if (template.task_id !== expected.task_id || template.checklist_id !== expected.checklist_id) {
        return invalidAnswersTemplate('Quality checklist answers template belongs to a different task or checklist.');
    }
    if (template.preflight_path !== expected.preflight_path || template.preflight_sha256 !== expected.preflight_sha256) {
        return staleAnswersTemplate('Quality checklist answers template is stale for the current preflight.', template);
    }
    if (
        template.workflow_config_path !== expected.workflow_config_path
        || template.workflow_config_sha256 !== expected.workflow_config_sha256
        || template.effective_policy_sha256 !== expected.effective_policy_sha256
    ) {
        return staleAnswersTemplate('Quality checklist answers template is stale for the current quality policy.', template);
    }
    const actualRuleIds = templateRuleIds(template.answers);
    const expectedRuleIds = expected.answers.map((answer) => answer.rule_id);
    if (!Array.isArray(template.active_rule_ids)
        || template.active_rule_ids.length !== expectedRuleIds.length
        || template.active_rule_ids.some((ruleId, index) => ruleId !== expectedRuleIds[index])) {
        return invalidAnswersTemplate('Quality checklist answers template active rule order does not match the current policy.');
    }
    if (!activeRuleFingerprintsMatch(template.active_rule_fingerprints, expected.active_rule_fingerprints, expectedRuleIds)) {
        return invalidAnswersTemplate('Quality checklist answers template active rule fingerprints do not match the current policy.');
    }
    if (!actualRuleIds || actualRuleIds.length !== expectedRuleIds.length
        || actualRuleIds.some((ruleId, index) => ruleId !== expectedRuleIds[index])) {
        return invalidAnswersTemplate('Quality checklist answers template rule ids do not match the active rules.');
    }
    const scaffoldIsValid = template.answers.every((answer) => {
        return isRecord(answer)
            && !Object.hasOwn(answer, 'title')
            && !Object.hasOwn(answer, 'prompt')
            && typeof answer.status === 'string'
            && typeof answer.answer === 'string'
            && (answer.evidence_files === undefined || (Array.isArray(answer.evidence_files)
                && answer.evidence_files.every((entry) => typeof entry === 'string')))
            && (answer.actions_taken === undefined || (Array.isArray(answer.actions_taken)
                && answer.actions_taken.every((entry) => typeof entry === 'string')))
            && (answer.actions_required === undefined || (Array.isArray(answer.actions_required)
                && answer.actions_required.every((entry) => typeof entry === 'string')))
            && (answer.trust_boundary_matrix === undefined || Array.isArray(answer.trust_boundary_matrix));
    });
    if (!scaffoldIsValid) {
        return invalidAnswersTemplate(
            'Quality checklist answers template editable fields do not match the slim active-rule scaffold.'
        );
    }
    return { status: 'current', reason: 'Quality checklist answers template is current.', template };
}

export function assessQualityChecklistAnswersTemplateFile(options: {
    repoRoot: string;
    taskId: string;
    preflightPath?: unknown;
    answersPath: string;
}): QualityChecklistAnswersTemplateAssessment {
    return assessStoredQualityChecklistAnswersTemplateFile(options, assessQualityChecklistAnswersTemplate);
}

export function materializeQualityChecklistAnswersTemplate(options: {
    repoRoot: string;
    taskId: string;
    preflightPath?: unknown;
    answersPath?: string;
    refreshIfOlderThanUtc?: string | null;
}): MaterializeQualityChecklistAnswersTemplateResult {
    return materializeStoredQualityChecklistAnswersTemplate(options, {
        buildTemplate: buildQualityChecklistAnswersTemplate,
        assessTemplate: assessQualityChecklistAnswersTemplate,
        normalizeReusableAnswer: normalizeReusableTemplateAnswer,
        mergeReusableAnswers: mergeReusableAnswersIntoTemplate
    });
}

export function formatQualityChecklistResult(artifact: QualityChecklistArtifact): string[] {
    const headline = {
        PASS: 'QUALITY_CHECKLIST_PASSED',
        WARN: 'QUALITY_CHECKLIST_WARNED',
        ACTION_REQUIRED: 'QUALITY_CHECKLIST_ACTION_REQUIRED',
        SKIPPED_DISABLED: 'QUALITY_CHECKLIST_SKIPPED_DISABLED',
        SKIPPED_CADENCE: 'QUALITY_CHECKLIST_SKIPPED_CADENCE',
        CONFIG_ERROR: 'QUALITY_CHECKLIST_CONFIG_ERROR'
    }[artifact.status];
    const lines = [
        headline,
        `TaskId: ${artifact.task_id}`,
        `Status: ${artifact.status}`,
        `Outcome: ${artifact.outcome}`,
        `ChecklistId: ${artifact.checklist_id}`,
        `ScopeCategory: ${artifact.scope_category || 'unknown'}`,
        `EnabledRuleCount: ${artifact.enabled_rule_count}`,
        `ActiveRuleCount: ${artifact.active_rule_count}`,
        `SkippedByScopeRuleCount: ${artifact.skipped_by_scope_rule_count}`,
        `AnswersRecorded: ${artifact.answers.length}`,
        `ChangedFilesCount: ${artifact.changed_file_evidence.changed_files_count}`,
        `ActionsRequiredCount: ${artifact.actions_required.length}`
    ];
    if (artifact.actions_required.length > 0) {
        lines.push('ActionsRequired:');
        for (const action of artifact.actions_required) {
            lines.push(`  - ${action}`);
        }
    }
    if (artifact.violations.length > 0) {
        lines.push('Violations:');
        for (const violation of artifact.violations) {
            lines.push(`  - ${violation}`);
        }
    }
    return lines;
}
