import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

import {
    DEFAULT_OPTIONAL_QUALITY_CHECKS_REVIEW_FAILURE_CADENCE_INTERVAL,
    formatOptionalQualityChecksRuleSetDiagnostics,
    isOptionalQualityCheckRuleActiveForScope,
    normalizeOptionalQualityChecksConfig,
    resolveOptionalQualityChecksReviewFailureCadenceInterval,
} from '../../core/workflow-config';
import {
    assessQualityChecklistAnswersTemplateFile,
    assessQualityChecklistPolicyCompatibility,
    buildQualityChecklistArtifact,
    buildQualityChecklistAnswersTemplate,
    buildQualityChecklistCadenceSkipArtifact,
    materializeQualityChecklistAnswersTemplate,
    QUALITY_CHECKLIST_ID,
    QUALITY_CHECKLIST_STATUSES,
    resolveDefaultQualityChecklistAnswersTemplatePath
} from '../quality-checklist';
import type {
    MaterializeQualityChecklistAnswersTemplateResult
} from '../quality-checklist';
import { appendMandatoryTaskEvent } from '../../gate-runtime/task-events';
import {
    fileSha256,
    joinOrchestratorPath
} from '../shared/helpers';
import {
    isPathInsideRoot,
    normalizePath
} from '../shared/path-utils';
import {
    isOrchestratorSourceCheckout
} from '../protected-control-plane/protected-control-plane';
import {
    resolveWorkflowConfigPath
} from '../full-suite/full-suite-validation';
import {
    formatNextStepInlineValue,
    toRepoDisplayPath
} from './next-step-command-formatters';
import { isPlainRecord } from '../../core/records';
import {
    assessTrustBoundaryAnalysisApplicability,
    TRUST_BOUNDARY_ANALYSIS_RULE_ID
} from '../../core/trust-boundary-analysis';
import { readTaskTimelineEventLikes } from './next-step-review-timeline-evidence';
import {
    createNextStepEffectPlanner,
    NextStepEffectPlanStaleError,
    type NextStepEffectController
} from './next-step-effects';

export type NextStepQualityChecklistEvidenceStatus = 'disabled' | 'not_required' | 'missing' | 'invalid' | 'stale' | 'current';
export type NextStepQualityChecklistEffect = 'disabled' | 'not_required' | 'missing' | 'invalid' | 'stale' | 'passed' | 'helped' | 'warned' | 'required_rework' | 'skipped_cadence';

export interface NextStepQualityChecklistReadiness {
    enabled: boolean;
    required: boolean;
    ready: boolean;
    status: string | null;
    evidenceStatus: NextStepQualityChecklistEvidenceStatus;
    effect: NextStepQualityChecklistEffect;
    reason: string;
    actionRequiredSummary: string | null;
    actionTakenSummary: string | null;
    actionsRequiredCount: number;
    actionsTakenCount: number;
    answerCount: number;
    changedFilesCount: number | null;
    scopeCategory: string | null;
    enabledRuleCount: number;
    activeRuleCount: number;
    skippedByScopeRuleCount: number;
    reviewFailureCadenceInterval: number;
    artifactPath: string | null;
    answersTemplatePath: string | null;
}

export interface NextStepQualityChecklistSummary {
    enabled: boolean;
    required: boolean;
    ready: boolean;
    status: string | null;
    evidence_status: NextStepQualityChecklistEvidenceStatus;
    effect: NextStepQualityChecklistEffect;
    artifact_path: string | null;
    action_required_summary: string | null;
    action_taken_summary: string | null;
    actions_required_count: number;
    actions_taken_count: number;
    answer_count: number;
    changed_files_count: number | null;
    scope_category: string | null;
    enabled_rule_count: number;
    active_rule_count: number;
    skipped_by_scope_rule_count: number;
    review_failure_cadence_interval: number;
    answers_template_path: string | null;
    visible_summary_line: string;
}

function fileExists(filePath: string): boolean {
    return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
}

function currentAnswersTemplatePolicySha256(options: {
    binding: Record<string, unknown>;
    template: Record<string, unknown>;
}): string | null {
    if (!Array.isArray(options.binding.active_rule_ids)
        || !Array.isArray(options.template.active_rule_ids)
        || !isPlainRecord(options.binding.active_rule_fingerprints)
        || !isPlainRecord(options.template.active_rule_fingerprints)) {
        return null;
    }
    const bindingFingerprints = options.binding.active_rule_fingerprints;
    const templateFingerprints = options.template.active_rule_fingerprints;
    const bindingRuleIds = options.binding.active_rule_ids.map((entry) => String(entry || '').trim());
    const templateRuleIds = options.template.active_rule_ids.map((entry) => String(entry || '').trim());
    if (
        bindingRuleIds.some((ruleId) => !ruleId)
        || JSON.stringify(bindingRuleIds) !== JSON.stringify(templateRuleIds)
    ) {
        return null;
    }
    const fingerprints = bindingRuleIds.map((ruleId) => {
        const bindingFingerprint = String(bindingFingerprints[ruleId] || '')
            .trim()
            .toLowerCase();
        const templateFingerprint = String(templateFingerprints[ruleId] || '')
            .trim()
            .toLowerCase();
        return /^[a-f0-9]{64}$/u.test(bindingFingerprint) && bindingFingerprint === templateFingerprint
            ? [ruleId, bindingFingerprint]
            : null;
    });
    if (fingerprints.some((entry) => entry === null)) {
        return null;
    }
    return createHash('sha256').update(JSON.stringify({
        schema_version: 1,
        active_rule_ids: bindingRuleIds,
        active_rule_fingerprints: fingerprints
    })).digest('hex');
}

function qualityChecklistAnswersMaterializationRequired(options: {
    repoRoot: string;
    taskId: string;
    preflightPath: string;
    refreshIfOlderThanUtc: string | null;
    answersPath?: string;
}): boolean {
    const answersPath = options.answersPath
        ?? resolveDefaultQualityChecklistAnswersTemplatePath(options.repoRoot, options.taskId);
    const assessment = assessQualityChecklistAnswersTemplateFile({
        repoRoot: options.repoRoot,
        taskId: options.taskId,
        preflightPath: options.preflightPath,
        answersPath
    });
    if (assessment.status !== 'current' || !assessment.template) {
        return true;
    }
    const refreshThreshold = Date.parse(String(options.refreshIfOlderThanUtc || ''));
    const templateTimestamp = Date.parse(String(assessment.template.timestamp_utc || ''));
    if (Number.isFinite(refreshThreshold) && (!Number.isFinite(templateTimestamp) || templateTimestamp <= refreshThreshold)) {
        return true;
    }
    const bindingPath = `${answersPath}.binding.json`;
    if (!fileExists(bindingPath)) {
        return true;
    }
    try {
        const binding = JSON.parse(fs.readFileSync(bindingPath, 'utf8')) as Record<string, unknown>;
        const template = assessment.template as unknown as Record<string, unknown>;
        const expectedPolicySha256 = currentAnswersTemplatePolicySha256({ binding, template });
        const scalarKeys = [
            'task_id',
            'checklist_id',
            'preflight_path',
            'preflight_sha256',
            'workflow_config_path',
            'workflow_config_sha256',
            'effective_policy_sha256'
        ];
        if (
            binding.schema_version !== 1
            || binding.event_source !== 'quality-checklist-answers-template-binding'
            || normalizePath(binding.answers_path) !== normalizePath(answersPath)
            || scalarKeys.some((key) => binding[key] !== template[key])
            || JSON.stringify(binding.active_rule_ids) !== JSON.stringify(template.active_rule_ids)
            || !expectedPolicySha256
            || binding.answers_template_policy_sha256 !== expectedPolicySha256
        ) {
            return true;
        }
        const bindingSha256 = fileSha256(bindingPath);
        const eventsRoot = joinOrchestratorPath(options.repoRoot, path.join('runtime', 'task-events'));
        return !readTaskTimelineEventLikes(eventsRoot, options.taskId).some((event) => {
            if (String(event.event_type || '') !== 'QUALITY_CHECKLIST_ANSWERS_TEMPLATE_BINDING_RECORDED') {
                return false;
            }
            const details = isPlainRecord(event.details) ? event.details : {};
            return normalizePath(details.answers_path) === normalizePath(answersPath)
                && normalizePath(details.binding_path) === normalizePath(bindingPath)
                && String(details.binding_sha256 || '').trim().toLowerCase() === bindingSha256
                && String(details.answers_template_policy_sha256 || '').trim().toLowerCase()
                    === String(binding.answers_template_policy_sha256).trim().toLowerCase();
        });
    } catch {
        return true;
    }
}

function resolveBoundQualityChecklistAnswersPath(options: {
    repoRoot: string;
    taskId: string;
    preflightPath: string;
    refreshIfOlderThanUtc: string | null;
}): string {
    const defaultPath = resolveDefaultQualityChecklistAnswersTemplatePath(options.repoRoot, options.taskId);
    if (!qualityChecklistAnswersMaterializationRequired({ ...options, answersPath: defaultPath })) {
        return defaultPath;
    }
    const repairPrefix = `${normalizePath(defaultPath)}.repair.json`;
    const eventsRoot = joinOrchestratorPath(options.repoRoot, path.join('runtime', 'task-events'));
    const events = readTaskTimelineEventLikes(eventsRoot, options.taskId);
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (String(event.event_type || '') !== 'QUALITY_CHECKLIST_ANSWERS_TEMPLATE_BINDING_RECORDED') continue;
        const details = isPlainRecord(event.details) ? event.details : {};
        const candidate = normalizePath(details.answers_path);
        if (!candidate.startsWith(repairPrefix)) continue;
        const suffix = candidate.slice(repairPrefix.length);
        if (suffix !== '' && suffix !== '.recovery.json'
            && !/^\.recovery\.(?:[2-9]|[1-9]\d+)\.json$/u.test(suffix)) continue;
        if (!qualityChecklistAnswersMaterializationRequired({ ...options, answersPath: candidate })) {
            return candidate;
        }
    }
    return defaultPath;
}

function parseOptionalNumberField(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}

function preflightHasChangedFiles(preflight: Record<string, unknown> | null): boolean {
    if (!preflight) {
        return false;
    }
    if (Array.isArray(preflight.changed_files) && preflight.changed_files.length > 0) {
        return true;
    }
    const metrics = isPlainRecord(preflight.metrics) ? preflight.metrics : {};
    const changedFilesCount = parseOptionalNumberField(metrics.changed_files_count);
    return changedFilesCount !== null && changedFilesCount > 0;
}

function preflightChangedFilesCount(preflight: Record<string, unknown> | null): number | null {
    if (!preflight) {
        return null;
    }
    if (Array.isArray(preflight.changed_files)) {
        return preflight.changed_files.length;
    }
    const metrics = isPlainRecord(preflight.metrics) ? preflight.metrics : {};
    return parseOptionalNumberField(metrics.changed_files_count);
}

function preflightChangedFiles(preflight: Record<string, unknown> | null): string[] {
    if (!preflight || !Array.isArray(preflight.changed_files)) {
        return [];
    }
    return preflight.changed_files
        .map((entry) => String(entry || '').replace(/\\/g, '/').trim())
        .filter(Boolean);
}

function preflightScopeCategory(preflight: Record<string, unknown> | null): string | null {
    const normalized = String(preflight?.scope_category || '').trim().toLowerCase();
    return normalized || null;
}

function readJsonRecordOrNull(filePath: string): Record<string, unknown> | null {
    try {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        return isPlainRecord(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

function formatQualityChecklistActions(actions: unknown): string | null {
    if (!Array.isArray(actions)) {
        return null;
    }
    const normalizedActions = actions
        .map((entry) => String(entry || '').trim())
        .filter(Boolean);
    if (normalizedActions.length === 0) {
        return null;
    }
    const preview = normalizedActions.slice(0, 3).join('; ');
    const remainder = normalizedActions.length > 3
        ? `; +${normalizedActions.length - 3} more`
        : '';
    return `${preview}${remainder}`;
}

function countArray(value: unknown): number {
    return Array.isArray(value) ? value.length : 0;
}

const REVIEW_FAILURE_VERDICT_PATTERN = /^(?:(?:CODE|DB|SECURITY|REFACTOR|API|TEST|PERFORMANCE|INFRA|DEPENDENCY) REVIEW|REVIEW) FAILED$/u;

function reviewRecordedFailed(details: Record<string, unknown>): boolean {
    const verdict = String(details.verdict_token || details.status || '').trim().toUpperCase();
    if (REVIEW_FAILURE_VERDICT_PATTERN.test(verdict)) {
        return true;
    }
    for (const candidate of [details.review_artifact_snapshot_path]) {
        const artifactPath = String(candidate || '').trim();
        if (!artifactPath || !fileExists(artifactPath)) continue;
        const verdictMatch = fs.readFileSync(artifactPath, 'utf8')
            .match(/(?:^|\n)## Verdict\s*\r?\n\s*([^\r\n]+)/iu);
        const snapshotVerdict = String(verdictMatch?.[1] || '').trim().toUpperCase();
        if (REVIEW_FAILURE_VERDICT_PATTERN.test(snapshotVerdict)) {
            return true;
        }
    }
    return false;
}

function writeActiveQuestionReference(options: {
    repoRoot: string;
    taskId: string;
    rules: readonly { id: string; prompt?: string }[];
    effects: NextStepEffectController;
}): string {
    const referencePath = joinOrchestratorPath(
        options.repoRoot,
        path.join('runtime', 'tmp', `${options.taskId}-quality-checklist-questions.md`)
    );
    assertActiveQuestionReferencePathIsSafe(referencePath, options.repoRoot);
    const lines = [
        `# Active quality-checklist questions for ${options.taskId}`,
        '',
        ...options.rules.flatMap((rule) => [
            `- ${rule.id}: ${String(rule.prompt || '').trim()}`
        ])
    ];
    const content = `${lines.join('\n')}\n`;
    if (fileExists(referencePath) && fs.readFileSync(referencePath, 'utf8') === content) {
        return referencePath;
    }
    return options.effects.run({
        kind: 'materialize-quality-checklist-question-reference',
        summary: `Materialize the active quality-checklist question reference for ${options.taskId}`,
        input: {
            task_id: options.taskId,
            reference_path: normalizePath(referencePath),
            content_sha256: createHash('sha256').update(content).digest('hex')
        },
        preview: () => referencePath,
        execute: () => {
            fs.mkdirSync(path.dirname(referencePath), { recursive: true });
            fs.writeFileSync(referencePath, content, 'utf8');
            return referencePath;
        }
    });
}

function tryWriteActiveQuestionReference(options: {
    repoRoot: string;
    taskId: string;
    rules: readonly { id: string; prompt?: string }[];
    effects: NextStepEffectController;
}): { path: string | null; error: string | null } {
    try {
        return { path: writeActiveQuestionReference(options), error: null };
    } catch (error: unknown) {
        if (error instanceof NextStepEffectPlanStaleError) {
            throw error;
        }
        return {
            path: null,
            error: error instanceof Error ? error.message : String(error)
        };
    }
}

function assertActiveQuestionReferencePathIsSafe(pathValue: string, repoRoot: string): void {
    const absoluteRoot = path.resolve(repoRoot);
    const absolutePath = path.resolve(pathValue);
    const relativePath = path.relative(absoluteRoot, absolutePath);
    if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
        throw new Error(`Quality checklist active-question reference must stay inside repo root: ${normalizePath(absolutePath)}`);
    }
    let currentPath = absoluteRoot;
    for (const segment of relativePath.split(path.sep).filter(Boolean)) {
        currentPath = path.join(currentPath, segment);
        if (!fs.existsSync(currentPath)) break;
        if (fs.lstatSync(currentPath).isSymbolicLink()) {
            throw new Error(`Quality checklist active-question reference path must not contain symbolic links: ${normalizePath(currentPath)}`);
        }
    }
    let existingAncestor = fs.existsSync(absolutePath) ? absolutePath : path.dirname(absolutePath);
    while (!fs.existsSync(existingAncestor) && existingAncestor !== path.dirname(existingAncestor)) {
        existingAncestor = path.dirname(existingAncestor);
    }
    const repoRealPath = fs.realpathSync.native(absoluteRoot);
    const ancestorRealPath = fs.realpathSync.native(existingAncestor);
    if (!isPathInsideRoot(ancestorRealPath, repoRealPath)) {
        throw new Error(`Quality checklist active-question reference must resolve inside repo root: ${normalizePath(absolutePath)}`);
    }
}

function combineMaterializationErrors(
    first: string | null,
    second: string | null
): string | null {
    return [first, second].filter((value): value is string => !!value).join(' ') || null;
}

interface QualityChecklistTemplateMaterialization {
    error: string | null;
    answersPath: string | null;
}

function buildTemplateMaterializationResult(
    result: MaterializeQualityChecklistAnswersTemplateResult
): QualityChecklistTemplateMaterialization {
    return {
        error: result.warning || null,
        answersPath: result.answers_path || null
    };
}

function reviewFailureCadence(repoRoot: string, taskId: string, reviewFailureCadenceInterval: number): {
    due: boolean;
    skip: boolean;
    failureCount: number;
    testResetPending: boolean;
} {
    const events = readTaskTimelineEventLikes(
        joinOrchestratorPath(repoRoot, path.join('runtime', 'task-events')),
        taskId
    );
    const checklistPasses: number[] = [];
    const reviewFailures: Array<{ index: number; reviewType: string }> = [];
    events.forEach((event, index) => {
        const details = isPlainRecord(event.details) ? event.details : {};
        if (String(event.event_type || '') === 'QUALITY_CHECKLIST_RECORDED') {
            const status = String(details.status || '').trim().toUpperCase().replace(/[\s-]+/g, '_');
            if (status === 'PASS' || status === 'WARN') checklistPasses.push(index);
            return;
        }
        if (String(event.event_type || '') !== 'REVIEW_RECORDED') return;
        if (!reviewRecordedFailed(details)) return;
        reviewFailures.push({ index, reviewType: String(details.review_type || '').trim().toLowerCase() });
    });
    const firstTestFailure = reviewFailures.find((failure) => failure.reviewType === 'test');
    const testResetConsumed = !!firstTestFailure
        && checklistPasses.some((index) => index > firstTestFailure.index);
    const testResetPending = !!firstTestFailure && !testResetConsumed;
    const latestChecklistPass = checklistPasses.at(-1) ?? -1;
    const failureCount = reviewFailures.filter((failure) => failure.index > latestChecklistPass).length;
    const hasBaseline = latestChecklistPass >= 0;
    return {
        due: !hasBaseline || testResetPending || failureCount >= reviewFailureCadenceInterval,
        skip: hasBaseline && !testResetPending && failureCount > 0 && failureCount < reviewFailureCadenceInterval,
        failureCount,
        testResetPending
    };
}

function writeCadenceSkipEvidence(options: {
    repoRoot: string;
    taskId: string;
    preflightPath: string;
    artifactPath: string;
    failureCount: number;
    effects: NextStepEffectController;
}): Record<string, unknown> {
    const artifact: Record<string, unknown> = {
        ...(buildQualityChecklistCadenceSkipArtifact(options) as unknown as Record<string, unknown>),
        review_failure_count: options.failureCount
    };
    return options.effects.run({
        kind: 'record-quality-checklist-cadence-skip',
        summary: `Record the quality-checklist cadence decision for ${options.taskId}`,
        input: {
            task_id: options.taskId,
            artifact_path: normalizePath(options.artifactPath),
            preflight_path: normalizePath(options.preflightPath),
            preflight_sha256: artifact.preflight_sha256,
            workflow_config_path: artifact.workflow_config_path,
            workflow_config_sha256: artifact.workflow_config_sha256,
            effective_policy_sha256: artifact.effective_policy_sha256,
            review_failure_count: options.failureCount,
            status: artifact.status,
            outcome: artifact.outcome,
            violations: artifact.violations
        },
        preview: () => artifact,
        execute: () => {
            const status = String(artifact.status || '').trim().toUpperCase().replace(/[\s-]+/g, '_');
            fs.mkdirSync(path.dirname(options.artifactPath), { recursive: true });
            fs.writeFileSync(options.artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
            appendMandatoryTaskEvent(options.repoRoot, options.taskId, 'QUALITY_CHECKLIST_RECORDED', status === 'SKIPPED_CADENCE' ? 'INFO' : 'FAIL',
                status === 'SKIPPED_CADENCE'
                    ? `Quality checklist skipped by review-failure cadence after failure ${options.failureCount}.`
                    : `Quality checklist cadence skip blocked by current configuration errors after failure ${options.failureCount}.`, {
                    artifact_path: options.artifactPath.replace(/\\/g, '/'),
                    artifact_hash: fileSha256(options.artifactPath),
                    status,
                    outcome: artifact.outcome,
                    preflight_path: artifact.preflight_path,
                    preflight_sha256: artifact.preflight_sha256,
                    review_failure_count: options.failureCount,
                    violations: Array.isArray(artifact.violations) ? artifact.violations : []
                });
            return artifact;
        }
    });
}

function materializePendingQualityChecklistAnswers(
    options: {
        repoRoot: string;
        taskId: string;
        preflightPath: string;
        effects: NextStepEffectController;
    },
    refreshIfOlderThanUtc: string | null = null
): QualityChecklistTemplateMaterialization {
    try {
        const defaultAnswersPath = resolveBoundQualityChecklistAnswersPath({
            ...options,
            refreshIfOlderThanUtc
        });
        if (!qualityChecklistAnswersMaterializationRequired({
            repoRoot: options.repoRoot,
            taskId: options.taskId,
            preflightPath: options.preflightPath,
            refreshIfOlderThanUtc,
            answersPath: defaultAnswersPath
        })) {
            return { error: null, answersPath: normalizePath(defaultAnswersPath) };
        }
        const expectedTemplate = buildQualityChecklistAnswersTemplate({
            repoRoot: options.repoRoot,
            taskId: options.taskId,
            preflightPath: options.preflightPath
        });
        return options.effects.run({
            kind: 'materialize-quality-checklist-answers',
            summary: `Materialize the quality-checklist answers template for ${options.taskId}`,
            input: {
                task_id: options.taskId,
                preflight_path: normalizePath(options.preflightPath),
                preflight_sha256: fileSha256(options.preflightPath),
                answers_path: normalizePath(defaultAnswersPath),
                workflow_config_path: expectedTemplate.workflow_config_path,
                workflow_config_sha256: expectedTemplate.workflow_config_sha256,
                effective_policy_sha256: expectedTemplate.effective_policy_sha256,
                refresh_if_older_than_utc: refreshIfOlderThanUtc
            },
            preview: () => ({ error: null, answersPath: normalizePath(defaultAnswersPath) }),
            execute: () => buildTemplateMaterializationResult(materializeQualityChecklistAnswersTemplate({
                repoRoot: options.repoRoot,
                taskId: options.taskId,
                preflightPath: options.preflightPath,
                refreshIfOlderThanUtc
            }))
        });
    } catch (error) {
        if (error instanceof NextStepEffectPlanStaleError) {
            throw error;
        }
        return {
            error: error instanceof Error ? error.message : String(error),
            answersPath: null
        };
    }
}

function buildQualityChecklistReadiness(options: {
    enabled: boolean;
    required: boolean;
    ready: boolean;
    status?: string | null;
    evidenceStatus: NextStepQualityChecklistEvidenceStatus;
    effect: NextStepQualityChecklistEffect;
    reason: string;
    artifactPath?: string | null;
    artifact?: Record<string, unknown> | null;
    changedFilesCount?: number | null;
    scopeCategory?: string | null;
    enabledRuleCount?: number;
    activeRuleCount?: number;
    skippedByScopeRuleCount?: number;
    reviewFailureCadenceInterval?: number;
    templateMaterializationError?: string | null;
    answersTemplatePath?: string | null;
}): NextStepQualityChecklistReadiness {
    const artifact = options.artifact || null;
    const templateMaterializationError = String(options.templateMaterializationError || '').trim();
    const artifactPath = String(options.artifactPath || '').trim();
    const taskId = artifactPath ? path.basename(artifactPath).replace(/-quality-checklist\.json$/u, '') : '';
    const questionReferenceSuffix = options.required && !options.ready && artifactPath && taskId
        ? ` Complete active-question reference: ${path.join(path.dirname(path.dirname(artifactPath)), 'tmp', `${taskId}-quality-checklist-questions.md`).replace(/\\/g, '/')}.`
        : '';
    return {
        enabled: options.enabled,
        required: options.required,
        ready: options.ready,
        status: options.status || null,
        evidenceStatus: options.evidenceStatus,
        effect: options.effect,
        reason: `${options.reason}${questionReferenceSuffix}${templateMaterializationError
            ? ` Answers template was not materialized: ${templateMaterializationError}`
            : ''}`,
        actionRequiredSummary: formatQualityChecklistActions(artifact?.actions_required),
        actionTakenSummary: formatQualityChecklistActions(artifact?.actions_taken),
        actionsRequiredCount: countArray(artifact?.actions_required),
        actionsTakenCount: countArray(artifact?.actions_taken),
        answerCount: countArray(artifact?.answers),
        changedFilesCount: options.changedFilesCount ?? null,
        scopeCategory: options.scopeCategory || null,
        enabledRuleCount: options.enabledRuleCount ?? 0,
        activeRuleCount: options.activeRuleCount ?? 0,
        skippedByScopeRuleCount: options.skippedByScopeRuleCount ?? 0,
        reviewFailureCadenceInterval: options.reviewFailureCadenceInterval
            ?? DEFAULT_OPTIONAL_QUALITY_CHECKS_REVIEW_FAILURE_CADENCE_INTERVAL,
        artifactPath: options.artifactPath || null,
        answersTemplatePath: options.answersTemplatePath || null
    };
}

export function readQualityChecklistReadiness(options: {
    repoRoot: string;
    reviewsRoot: string;
    taskId: string;
    preflight: Record<string, unknown> | null;
    preflightPath: string;
    preflightSha256: string | null;
    workflowConfig: Record<string, unknown> | null;
    effects?: NextStepEffectController;
}): NextStepQualityChecklistReadiness {
    const effects = options.effects ?? createNextStepEffectPlanner();
    const effectOptions = { ...options, effects };
    const hasOptionalQualityChecksConfig = options.workflowConfig?.optional_quality_checks !== undefined;
    const ruleSetDiagnostic = formatOptionalQualityChecksRuleSetDiagnostics(options.workflowConfig?.optional_quality_checks);
    const ruleSetDiagnosticSuffix = ruleSetDiagnostic ? ` ${ruleSetDiagnostic}` : '';
    const optionalQualityChecks = normalizeOptionalQualityChecksConfig(options.workflowConfig?.optional_quality_checks);
    const cadenceInterval = resolveOptionalQualityChecksReviewFailureCadenceInterval(options.workflowConfig?.optional_quality_checks);
    const buildReadiness = (
        readinessOptions: Parameters<typeof buildQualityChecklistReadiness>[0]
    ): NextStepQualityChecklistReadiness => buildQualityChecklistReadiness({
        ...readinessOptions,
        reviewFailureCadenceInterval: cadenceInterval.value
    });
    const changedFilesCount = preflightChangedFilesCount(options.preflight);
    const changedFiles = preflightChangedFiles(options.preflight);
    const scopeCategory = preflightScopeCategory(options.preflight);
    const trustBoundaryRequired = assessTrustBoundaryAnalysisApplicability(options.preflight).required;
    const required = preflightHasChangedFiles(options.preflight) || trustBoundaryRequired;
    const sourceCheckoutDefaultEnabled = !hasOptionalQualityChecksConfig && isOrchestratorSourceCheckout(options.repoRoot);
    const ordinaryChecksEnabled = (hasOptionalQualityChecksConfig || sourceCheckoutDefaultEnabled)
        && optionalQualityChecks.enabled;
    const isRuleEffectivelyEnabled = (rule: typeof optionalQualityChecks.rules[number]): boolean => (
        (trustBoundaryRequired && rule.id === TRUST_BOUNDARY_ANALYSIS_RULE_ID)
        || (ordinaryChecksEnabled && rule.enabled)
    );
    const isRuleEffectivelyActive = (rule: typeof optionalQualityChecks.rules[number]): boolean => (
        isRuleEffectivelyEnabled(rule)
        && (
            (trustBoundaryRequired && rule.id === TRUST_BOUNDARY_ANALYSIS_RULE_ID)
            || isOptionalQualityCheckRuleActiveForScope(rule, scopeCategory, changedFiles)
        )
    );
    const enabledRuleCount = optionalQualityChecks.rules.filter(isRuleEffectivelyEnabled).length;
    const activeRuleCount = optionalQualityChecks.rules
        .filter(isRuleEffectivelyActive)
        .length;
    const skippedByScopeRuleCount = enabledRuleCount - activeRuleCount;
    const enabled = enabledRuleCount > 0;
    if (cadenceInterval.violation && required) {
        return buildReadiness({
            enabled,
            required: true,
            ready: true,
            status: 'CONFIG_ERROR',
            evidenceStatus: 'invalid',
            effect: 'invalid',
            reason: `Quality checklist workflow configuration is invalid. ${cadenceInterval.violation}`,
            changedFilesCount,
            scopeCategory,
            enabledRuleCount,
            activeRuleCount,
            skippedByScopeRuleCount
        });
    }
    if (!enabled) {
        return buildReadiness({
            enabled: false,
            required,
            ready: true,
            evidenceStatus: 'disabled',
            effect: 'disabled',
            reason: 'Optional quality checks are disabled for the effective workflow configuration.',
            changedFilesCount,
            scopeCategory,
            enabledRuleCount,
            activeRuleCount,
            skippedByScopeRuleCount
        });
    }
    if (!required) {
        return buildReadiness({
            enabled,
            required: false,
            ready: true,
            evidenceStatus: 'not_required',
            effect: 'not_required',
            reason: 'The current preflight has no changed files, so optional quality checks are not required for this cycle.',
            changedFilesCount,
            scopeCategory,
            enabledRuleCount,
            activeRuleCount,
            skippedByScopeRuleCount
        });
    }

    const artifactPath = path.join(options.reviewsRoot, `${options.taskId}-quality-checklist.json`);
    const artifactExists = fileExists(artifactPath);
    const existingArtifact = artifactExists ? readJsonRecordOrNull(artifactPath) : null;
    const previousStatus = String(existingArtifact?.status || '').trim().toUpperCase().replace(/[\s-]+/g, '_');
    const invalidExistingArtifact = artifactExists && (!existingArtifact
        || !QUALITY_CHECKLIST_STATUSES.includes(previousStatus as typeof QUALITY_CHECKLIST_STATUSES[number])
        || existingArtifact.task_id !== options.taskId
        || existingArtifact.checklist_id !== QUALITY_CHECKLIST_ID);
    const forceChecklistRun = invalidExistingArtifact
        || previousStatus === 'ACTION_REQUIRED'
        || previousStatus === 'CONFIG_ERROR'
        || countArray(existingArtifact?.actions_required) > 0
        || !!ruleSetDiagnostic
        || !!cadenceInterval.violation;
    const cadence = reviewFailureCadence(options.repoRoot, options.taskId, cadenceInterval.value);
    if (cadence.skip && !forceChecklistRun && !trustBoundaryRequired) {
        const answersTemplatePath = resolveDefaultQualityChecklistAnswersTemplatePath(options.repoRoot, options.taskId);
        const templateMaterialization = fileExists(answersTemplatePath)
            ? materializePendingQualityChecklistAnswers(effectOptions)
            : { error: null, answersPath: null };
        const expectedPreflightSha256 = String(options.preflightSha256 || '').trim().toLowerCase()
            || (fileExists(options.preflightPath) ? fileSha256(options.preflightPath) : '');
        const existingPreflightSha256 = String(existingArtifact?.preflight_sha256 || '').trim().toLowerCase();
        const existingFailureCount = Number(existingArtifact?.review_failure_count);
        const workflowConfigPath = resolveWorkflowConfigPath(options.repoRoot);
        const expectedWorkflowConfigSha256 = fileExists(workflowConfigPath)
            ? fileSha256(workflowConfigPath)
            : null;
        const existingWorkflowConfigSha256 = typeof existingArtifact?.workflow_config_sha256 === 'string'
            ? existingArtifact.workflow_config_sha256.trim().toLowerCase()
            : null;
        const canReuseExistingCadenceSkip = previousStatus === 'SKIPPED_CADENCE'
            && existingPreflightSha256 === expectedPreflightSha256
            && existingFailureCount === cadence.failureCount
            && existingWorkflowConfigSha256 === expectedWorkflowConfigSha256;
        const artifact = canReuseExistingCadenceSkip
            ? existingArtifact!
            : writeCadenceSkipEvidence({
                repoRoot: options.repoRoot,
                taskId: options.taskId,
                preflightPath: options.preflightPath,
                artifactPath,
                failureCount: cadence.failureCount,
                effects
            });
        const artifactStatus = String(artifact.status || '').trim().toUpperCase().replace(/[\s-]+/g, '_');
        if (artifactStatus !== 'SKIPPED_CADENCE') {
            return buildReadiness({
                enabled,
                required: true,
                ready: true,
                status: artifactStatus || 'CONFIG_ERROR',
                evidenceStatus: 'current',
                effect: 'invalid',
                reason:
                    `Quality checklist cadence skip is blocked by current checklist configuration or preflight errors after review failure ${cadence.failureCount}. ` +
                    `Violations: ${formatQualityChecklistActions(artifact.violations)}.`,
                artifactPath,
                artifact,
                changedFilesCount,
                scopeCategory,
                enabledRuleCount,
                activeRuleCount,
                skippedByScopeRuleCount,
                templateMaterializationError: templateMaterialization.error,
                answersTemplatePath: templateMaterialization.answersPath
            });
        }
        return buildReadiness({
            enabled,
            required: false,
            ready: true,
            status: 'SKIPPED_CADENCE',
            evidenceStatus: 'current',
            effect: 'skipped_cadence',
            reason:
                `Quality checklist skipped after review failure ${cadence.failureCount}; ` +
                `review_failure_cadence_interval=${cadenceInterval.value} requires fresh answers on failure ${cadenceInterval.value}.`,
            artifactPath,
            artifact,
            changedFilesCount,
            scopeCategory,
            enabledRuleCount,
            activeRuleCount,
            skippedByScopeRuleCount,
            templateMaterializationError: templateMaterialization.error,
            answersTemplatePath: templateMaterialization.answersPath
        });
    }
    const activeRules = optionalQualityChecks.rules
        .filter(isRuleEffectivelyActive);
    let activeQuestionReference: { path: string | null; error: string | null } | null = null;
    const getActiveQuestionReference = (): { path: string | null; error: string | null } => {
        activeQuestionReference ??= tryWriteActiveQuestionReference({
            repoRoot: options.repoRoot,
            taskId: options.taskId,
            rules: activeRules,
            effects
        });
        return activeQuestionReference;
    };
    const materializeRequiredChecklistInputs = (): QualityChecklistTemplateMaterialization => {
        const activeQuestionReferenceResult = getActiveQuestionReference();
        const templateMaterialization = materializePendingQualityChecklistAnswers(effectOptions);
        return {
            error: combineMaterializationErrors(
                templateMaterialization.error,
                activeQuestionReferenceResult.error
                    ? `Active-question reference was not materialized: ${activeQuestionReferenceResult.error}`
                    : null
            ),
            answersPath: templateMaterialization.answersPath
        };
    };
    const buildInvalidCompletedTemplateReadiness = (
        templateMaterialization: QualityChecklistTemplateMaterialization
    ): NextStepQualityChecklistReadiness | null => {
        if (!templateMaterialization.answersPath || templateMaterialization.error) {
            return null;
        }
        try {
            const assessment = assessQualityChecklistAnswersTemplateFile({
                repoRoot: options.repoRoot,
                taskId: options.taskId,
                preflightPath: options.preflightPath,
                answersPath: templateMaterialization.answersPath
            });
            const completedTemplate = assessment.status === 'current' && assessment.template
                && assessment.template.answers.every((answer) => (
                    String(answer.status || '').trim().length > 0
                    && String(answer.answer || '').trim().length > 0
                ));
            if (!completedTemplate || !assessment.template) {
                return null;
            }
            const candidate = buildQualityChecklistArtifact({
                repoRoot: options.repoRoot,
                taskId: options.taskId,
                preflightPath: options.preflightPath,
                answers: assessment.template
            }) as unknown as Record<string, unknown>;
            const candidateStatus = String(candidate.status || '').trim().toUpperCase();
            if (candidateStatus !== 'CONFIG_ERROR') {
                return null;
            }
            return buildReadiness({
                enabled,
                required,
                ready: false,
                status: candidateStatus,
                evidenceStatus: 'invalid',
                effect: 'invalid',
                reason:
                    'Completed quality checklist answers failed validation. ' +
                    `Violations: ${formatQualityChecklistActions(candidate.violations) || 'unknown validation error'}. ` +
                    'Correct the answers template and rerun next-step.',
                artifactPath,
                artifact: candidate,
                changedFilesCount,
                scopeCategory,
                enabledRuleCount,
                activeRuleCount,
                skippedByScopeRuleCount,
                answersTemplatePath: templateMaterialization.answersPath
            });
        } catch {
            return null;
        }
    };
    if (cadence.due && artifactExists && !forceChecklistRun) {
        const templateMaterialization = materializeRequiredChecklistInputs();
        const invalidCompletedTemplate = buildInvalidCompletedTemplateReadiness(templateMaterialization);
        if (invalidCompletedTemplate) return invalidCompletedTemplate;
        return buildReadiness({
            enabled,
            required: true,
            ready: false,
            status: previousStatus || null,
            evidenceStatus: 'stale',
            effect: 'stale',
            reason: cadence.testResetPending
                ? 'The first failed test review requires a one-time fresh quality checklist.'
                : `Quality checklist cadence requires fresh answers after review failure ${cadence.failureCount} because review_failure_cadence_interval=${cadenceInterval.value} was reached.`,
            artifactPath,
            artifact: existingArtifact,
            changedFilesCount,
            scopeCategory,
            enabledRuleCount,
            activeRuleCount,
            skippedByScopeRuleCount,
            templateMaterializationError: templateMaterialization.error,
            answersTemplatePath: templateMaterialization.answersPath
        });
    }
    if (!fileExists(artifactPath)) {
        const templateMaterialization = materializeRequiredChecklistInputs();
        const activeQuestionReferenceResult = getActiveQuestionReference();
        const activeQuestionReferencePath = activeQuestionReferenceResult.path || joinOrchestratorPath(
            options.repoRoot,
            path.join('runtime', 'tmp', `${options.taskId}-quality-checklist-questions.md`)
        );
        const invalidCompletedTemplate = buildInvalidCompletedTemplateReadiness(templateMaterialization);
        if (invalidCompletedTemplate) return invalidCompletedTemplate;
        return buildReadiness({
            enabled,
            required,
            ready: false,
            evidenceStatus: 'missing',
            effect: 'missing',
            reason:
                'Optional quality checks are enabled and the current changed-file preflight has no quality checklist evidence yet. ' +
                `Active rules for scope ${formatNextStepInlineValue(scopeCategory || 'unknown')}: ${activeRuleCount}; ` +
                `skipped_by_scope=${skippedByScopeRuleCount}. ` +
                `Read-only active questions: ${activeRules
                    .slice(0, 12)
                    .map((rule) => `${rule.id}: ${String(rule.prompt || '').trim().slice(0, 160)}`)
                    .join(' | ')}. ` +
                `Complete active-question reference: ${normalizePath(path.relative(options.repoRoot, activeQuestionReferencePath))}.` +
                ruleSetDiagnosticSuffix,
            artifactPath,
            changedFilesCount,
            scopeCategory,
            enabledRuleCount,
            activeRuleCount,
            skippedByScopeRuleCount,
            templateMaterializationError: templateMaterialization.error,
            answersTemplatePath: templateMaterialization.answersPath
        });
    }

    const artifact = readJsonRecordOrNull(artifactPath);
    if (!artifact) {
        const templateMaterialization = materializeRequiredChecklistInputs();
        return buildReadiness({
            enabled,
            required,
            ready: false,
            evidenceStatus: 'invalid',
            effect: 'invalid',
            reason: `Quality checklist evidence at ${formatNextStepInlineValue(toRepoDisplayPath(options.repoRoot, artifactPath))} is not a valid JSON object.`,
            artifactPath,
            changedFilesCount,
            scopeCategory,
            enabledRuleCount,
            activeRuleCount,
            skippedByScopeRuleCount,
            templateMaterializationError: templateMaterialization.error,
            answersTemplatePath: templateMaterialization.answersPath
        });
    }

    const status = String(artifact.status || '').trim().toUpperCase().replace(/[\s-]+/g, '_');
    if (!QUALITY_CHECKLIST_STATUSES.includes(status as typeof QUALITY_CHECKLIST_STATUSES[number])) {
        const templateMaterialization = materializeRequiredChecklistInputs();
        return buildReadiness({
            enabled,
            required,
            ready: false,
            status: null,
            evidenceStatus: 'invalid',
            effect: 'invalid',
            reason: `Quality checklist evidence has unsupported status ${formatNextStepInlineValue(status || '<empty>')}.`,
            artifactPath,
            artifact,
            changedFilesCount,
            scopeCategory,
            enabledRuleCount,
            activeRuleCount,
            skippedByScopeRuleCount,
            templateMaterializationError: templateMaterialization.error,
            answersTemplatePath: templateMaterialization.answersPath
        });
    }
    if (artifact.task_id !== options.taskId) {
        const templateMaterialization = materializeRequiredChecklistInputs();
        return buildReadiness({
            enabled,
            required,
            ready: false,
            status,
            evidenceStatus: 'invalid',
            effect: 'invalid',
            reason: `Quality checklist evidence belongs to task ${formatNextStepInlineValue(String(artifact.task_id || '<missing>'))}, not ${formatNextStepInlineValue(options.taskId)}.`,
            artifactPath,
            artifact,
            changedFilesCount,
            scopeCategory,
            enabledRuleCount,
            activeRuleCount,
            skippedByScopeRuleCount,
            templateMaterializationError: templateMaterialization.error,
            answersTemplatePath: templateMaterialization.answersPath
        });
    }
    if (artifact.checklist_id !== QUALITY_CHECKLIST_ID) {
        const templateMaterialization = materializeRequiredChecklistInputs();
        return buildReadiness({
            enabled,
            required,
            ready: false,
            status,
            evidenceStatus: 'invalid',
            effect: 'invalid',
            reason: `Quality checklist evidence has checklist_id ${formatNextStepInlineValue(String(artifact.checklist_id || '<missing>'))}, not ${formatNextStepInlineValue(QUALITY_CHECKLIST_ID)}.`,
            artifactPath,
            artifact,
            changedFilesCount,
            scopeCategory,
            enabledRuleCount,
            activeRuleCount,
            skippedByScopeRuleCount,
            templateMaterializationError: templateMaterialization.error,
            answersTemplatePath: templateMaterialization.answersPath
        });
    }

    const expectedPreflightSha256 = String(options.preflightSha256 || '').trim().toLowerCase()
        || (fileExists(options.preflightPath) ? fileSha256(options.preflightPath) : '');
    const artifactPreflightSha256 = String(artifact.preflight_sha256 || '').trim().toLowerCase();
    if (expectedPreflightSha256 && artifactPreflightSha256 !== expectedPreflightSha256) {
        const templateMaterialization = materializeRequiredChecklistInputs();
        const invalidCompletedTemplate = buildInvalidCompletedTemplateReadiness(templateMaterialization);
        if (invalidCompletedTemplate) return invalidCompletedTemplate;
        return buildReadiness({
            enabled,
            required,
            ready: false,
            status,
            evidenceStatus: 'stale',
            effect: 'stale',
            reason:
                'Quality checklist evidence is stale for the current preflight hash. ' +
                `Expected ${formatNextStepInlineValue(expectedPreflightSha256)}, found ${formatNextStepInlineValue(artifactPreflightSha256 || '<missing>')}.`,
            artifactPath,
            artifact,
            changedFilesCount,
            scopeCategory,
            enabledRuleCount,
            activeRuleCount,
            skippedByScopeRuleCount,
            templateMaterializationError: templateMaterialization.error,
            answersTemplatePath: templateMaterialization.answersPath
        });
    }

    const expectedWorkflowConfigSha256 = fileExists(resolveWorkflowConfigPath(options.repoRoot))
        ? fileSha256(resolveWorkflowConfigPath(options.repoRoot))
        : null;
    const artifactWorkflowConfigSha256 = typeof artifact.workflow_config_sha256 === 'string'
        ? artifact.workflow_config_sha256.trim().toLowerCase()
        : null;
    if (expectedWorkflowConfigSha256 !== artifactWorkflowConfigSha256) {
        const compatibility = expectedWorkflowConfigSha256 && artifactWorkflowConfigSha256
            ? assessQualityChecklistPolicyCompatibility({
                currentRules: optionalQualityChecks.rules,
                artifactRules: artifact.rules,
                artifactAnswers: artifact.answers,
                scopeCategory,
                changedFiles,
                currentRuleSetDiagnostic: ruleSetDiagnostic
            })
            : null;
        if (compatibility?.compatible === true) {
            let templateMaterializationError: string | null = null;
            let answersTemplatePath: string | null = null;
            if (status === 'CONFIG_ERROR') {
                const templateMaterialization = materializePendingQualityChecklistAnswers(effectOptions);
                templateMaterializationError = templateMaterialization.error;
                answersTemplatePath = templateMaterialization.answersPath;
            }
            return buildReadiness({
                enabled,
                required,
                ready: true,
                status,
                evidenceStatus: 'current',
                effect: status === 'ACTION_REQUIRED'
                    ? 'required_rework'
                    : status === 'WARN'
                        ? 'warned'
                        : status === 'SKIPPED_DISABLED'
                            ? 'disabled'
                            : status === 'SKIPPED_CADENCE'
                                ? 'skipped_cadence'
                            : status === 'CONFIG_ERROR'
                                ? 'invalid'
                                : countArray(artifact.actions_taken) > 0
                                    ? 'helped'
                                    : 'passed',
                reason:
                    'Quality checklist evidence is current after compatible workflow configuration normalization. ' +
                    `Effective policy ${formatNextStepInlineValue(compatibility.effective_policy_sha256)} remains compatible with ` +
                    `${formatNextStepInlineValue(toRepoDisplayPath(options.repoRoot, artifactPath))}.`,
                artifactPath,
                artifact,
                changedFilesCount,
                scopeCategory,
                enabledRuleCount,
                activeRuleCount,
                skippedByScopeRuleCount,
                templateMaterializationError,
                answersTemplatePath
            });
        }
        const templateMaterialization = materializeRequiredChecklistInputs();
        const invalidCompletedTemplate = buildInvalidCompletedTemplateReadiness(templateMaterialization);
        if (invalidCompletedTemplate) return invalidCompletedTemplate;
        return buildReadiness({
            enabled,
            required,
            ready: false,
            status,
            evidenceStatus: 'stale',
            effect: 'stale',
            reason:
                'Quality checklist evidence is stale for the current workflow configuration. ' +
                `Expected ${formatNextStepInlineValue(expectedWorkflowConfigSha256 || '<missing>')}, found ${formatNextStepInlineValue(artifactWorkflowConfigSha256 || '<missing>')}.` +
                (compatibility && !compatibility.compatible ? ` Effective policy mismatch: ${compatibility.reasons[0] || 'unknown'}.` : ''),
            artifactPath,
            artifact,
            changedFilesCount,
            scopeCategory,
            enabledRuleCount,
            activeRuleCount,
            skippedByScopeRuleCount,
            templateMaterializationError: templateMaterialization.error,
            answersTemplatePath: templateMaterialization.answersPath
        });
    }

    if (status === 'ACTION_REQUIRED' || status === 'CONFIG_ERROR') {
        const templateMaterialization = materializePendingQualityChecklistAnswers(effectOptions);
        const answersPath = templateMaterialization.answersPath;
        if (answersPath && !templateMaterialization.error) {
            try {
                const assessment = assessQualityChecklistAnswersTemplateFile({
                    repoRoot: options.repoRoot,
                    taskId: options.taskId,
                    preflightPath: options.preflightPath,
                    answersPath
                });
                const candidateStatus = assessment.status === 'current' && assessment.template
                    ? String(buildQualityChecklistArtifact({
                        repoRoot: options.repoRoot,
                        taskId: options.taskId,
                        preflightPath: options.preflightPath,
                        answers: assessment.template
                    }).status || '').trim().toUpperCase()
                    : '';
                if (candidateStatus === 'PASS' || candidateStatus === 'WARN') {
                    return buildReadiness({
                        enabled,
                        required,
                        ready: false,
                        status,
                        evidenceStatus: 'stale',
                        effect: 'stale',
                        reason:
                            `Quality checklist answers were updated after ${status} remediation and now produce a non-blocking candidate. ` +
                            'Rerun the quality checklist to replace the blocking artifact before compile, review, full-suite, or completion gates.',
                        artifactPath,
                        artifact,
                        changedFilesCount,
                        scopeCategory,
                        enabledRuleCount: parseOptionalNumberField(artifact.enabled_rule_count) ?? enabledRuleCount,
                        activeRuleCount: parseOptionalNumberField(artifact.active_rule_count) ?? activeRuleCount,
                        skippedByScopeRuleCount: parseOptionalNumberField(artifact.skipped_by_scope_rule_count) ?? skippedByScopeRuleCount,
                        answersTemplatePath: answersPath
                    });
                }
            } catch {
                // The executable command builder performs the same fail-closed assessment.
            }
        }
    }

    const effect = status === 'ACTION_REQUIRED'
        ? 'required_rework'
        : status === 'WARN'
            ? 'warned'
            : status === 'SKIPPED_DISABLED'
                ? 'disabled'
                : status === 'SKIPPED_CADENCE'
                    ? 'skipped_cadence'
                : status === 'CONFIG_ERROR'
                    ? 'invalid'
                    : countArray(artifact.actions_taken) > 0
                        ? 'helped'
                    : 'passed';
    const configErrorDetails = status === 'CONFIG_ERROR'
        ? formatQualityChecklistActions(artifact.violations)
        : null;
    if (status === 'CONFIG_ERROR') {
        const templateMaterialization = materializePendingQualityChecklistAnswers(effectOptions);
        return buildReadiness({
            enabled,
            required,
            ready: true,
            status,
            evidenceStatus: 'current',
            effect,
            reason:
                `Quality checklist evidence is current with status ${formatNextStepInlineValue(status)} at ` +
                `${formatNextStepInlineValue(toRepoDisplayPath(options.repoRoot, artifactPath))}.` +
                (configErrorDetails ? ` Violations: ${configErrorDetails}.` : ''),
            artifactPath,
            artifact,
            changedFilesCount,
            scopeCategory,
            enabledRuleCount: parseOptionalNumberField(artifact.enabled_rule_count) ?? enabledRuleCount,
            activeRuleCount: parseOptionalNumberField(artifact.active_rule_count) ?? activeRuleCount,
            skippedByScopeRuleCount: parseOptionalNumberField(artifact.skipped_by_scope_rule_count) ?? skippedByScopeRuleCount,
            templateMaterializationError: templateMaterialization.error,
            answersTemplatePath: templateMaterialization.answersPath
        });
    }
    return buildReadiness({
        enabled,
        required,
        ready: true,
        status,
        evidenceStatus: 'current',
        effect,
        reason:
            `Quality checklist evidence is current with status ${formatNextStepInlineValue(status)} at ` +
            `${formatNextStepInlineValue(toRepoDisplayPath(options.repoRoot, artifactPath))}.` +
            (configErrorDetails ? ` Violations: ${configErrorDetails}.` : ''),
        artifactPath,
        artifact,
        changedFilesCount,
        scopeCategory,
        enabledRuleCount: parseOptionalNumberField(artifact.enabled_rule_count) ?? enabledRuleCount,
        activeRuleCount: parseOptionalNumberField(artifact.active_rule_count) ?? activeRuleCount,
        skippedByScopeRuleCount: parseOptionalNumberField(artifact.skipped_by_scope_rule_count) ?? skippedByScopeRuleCount
    });
}

export function buildNextStepQualityChecklistSummary(
    readiness: NextStepQualityChecklistReadiness
): NextStepQualityChecklistSummary {
    return {
        enabled: readiness.enabled,
        required: readiness.required,
        ready: readiness.ready,
        status: readiness.status,
        evidence_status: readiness.evidenceStatus,
        effect: readiness.effect,
        artifact_path: readiness.artifactPath,
        action_required_summary: readiness.actionRequiredSummary,
        action_taken_summary: readiness.actionTakenSummary,
        actions_required_count: readiness.actionsRequiredCount,
        actions_taken_count: readiness.actionsTakenCount,
        answer_count: readiness.answerCount,
        changed_files_count: readiness.changedFilesCount,
        scope_category: readiness.scopeCategory,
        enabled_rule_count: readiness.enabledRuleCount,
        active_rule_count: readiness.activeRuleCount,
        skipped_by_scope_rule_count: readiness.skippedByScopeRuleCount,
        review_failure_cadence_interval: readiness.reviewFailureCadenceInterval,
        answers_template_path: readiness.answersTemplatePath,
        visible_summary_line:
            `QualityChecklist: enabled=${readiness.enabled}; required=${readiness.required}; ready=${readiness.ready}; ` +
            `evidence=${readiness.evidenceStatus}; status=${readiness.status || 'none'}; effect=${readiness.effect}; ` +
            `scope_category=${readiness.scopeCategory || 'unknown'}; enabled_rules=${readiness.enabledRuleCount}; ` +
            `active_rules=${readiness.activeRuleCount}; skipped_by_scope=${readiness.skippedByScopeRuleCount}; ` +
            `review_failure_cadence_interval=${readiness.reviewFailureCadenceInterval}; ` +
            `answers=${readiness.answerCount}; actions_taken=${readiness.actionsTakenCount}; ` +
            `actions_required=${readiness.actionsRequiredCount}; changed_files=${readiness.changedFilesCount ?? 'unknown'}`
    };
}

export function markQualityChecklistReadinessStaleForWorkspace(
    readiness: NextStepQualityChecklistReadiness,
    reason: string
): NextStepQualityChecklistReadiness {
    if (readiness.evidenceStatus !== 'current') {
        return readiness;
    }
    return {
        ...readiness,
        ready: false,
        evidenceStatus: 'stale',
        effect: 'stale',
        reason:
            'Quality checklist evidence is stale because the current preflight/workspace freshness guard is not satisfied. ' +
            reason
    };
}
