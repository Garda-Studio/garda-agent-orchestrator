import * as fs from 'node:fs';
import * as path from 'node:path';

import { writeFileAtomically } from '../../core/filesystem';
import {
    appendTaskEvent,
    assertValidTaskId,
    forEachJsonlLine,
    inspectTaskEventFile
} from '../../gate-runtime/task-events';
import {
    fileSha256,
    isPathInsideRoot,
    joinOrchestratorPath,
    normalizePath,
    resolvePathInsideRepo
} from '../shared/helpers';
import {
    QUALITY_CHECKLIST_ID,
    QUALITY_CHECKLIST_ANSWERS_TEMPLATE_EVENT_SOURCE,
    QUALITY_CHECKLIST_ANSWERS_TEMPLATE_BINDING_EVENT_SOURCE,
    QUALITY_CHECKLIST_ANSWERS_TEMPLATE_BINDING_RECORDED_EVENT,
    activeRuleIdsMatch,
    bindingMatchesTemplate,
    normalizeActiveRuleIds,
    normalizeActiveRuleFingerprints,
    normalizeRuleFingerprint,
    qualityChecklistAnswersTemplatePolicySha256FromParts,
    templateRuleIds,
    type QualityChecklistAnswersTemplate,
    type QualityChecklistAnswersTemplateAnswer,
    type QualityChecklistAnswersTemplateAssessment,
    type QualityChecklistAnswersTemplateBinding,
    type QualityChecklistAnswersTemplatePolicy,
    type MaterializeQualityChecklistAnswersTemplateResult
} from './quality-checklist-template-contract';

const QUALITY_CHECKLIST_REPAIR_DIAGNOSTIC_LIMIT = 8;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function assessStoredQualityChecklistAnswersTemplateFile(options: {
    repoRoot: string;
    taskId: string;
    preflightPath?: unknown;
    answersPath: string;
}, assessTemplate: QualityChecklistAnswersTemplatePolicy['assessTemplate']): QualityChecklistAnswersTemplateAssessment {
    const repoRoot = path.resolve(options.repoRoot);
    const resolvedPath = resolvePathInsideRepo(options.answersPath, repoRoot, { allowMissing: true, enforceInside: true });
    if (!resolvedPath || !fs.existsSync(resolvedPath)) {
        return { status: 'missing', reason: 'Quality checklist answers template is missing.', template: null };
    }
    try {
        assertQualityChecklistAnswersPathHasNoSymlinks(resolvedPath, repoRoot);
        const repoRealPath = fs.realpathSync.native(repoRoot);
        const answersRealPath = fs.realpathSync.native(resolvedPath);
        if (!isPathInsideRoot(answersRealPath, repoRealPath) || !fs.statSync(answersRealPath).isFile()) {
            return { status: 'invalid', reason: 'Quality checklist answers template must resolve to a file inside the repo root.', template: null };
        }
        const template = JSON.parse(fs.readFileSync(answersRealPath, 'utf8'));
        return assessTemplate({ ...options, repoRoot, template });
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return { status: 'invalid', reason: `Quality checklist answers template is unreadable: ${message}`, template: null };
    }
}

export function resolveDefaultQualityChecklistAnswersTemplatePath(repoRoot: string, taskId: string): string {
    return joinOrchestratorPath(repoRoot, path.join('runtime', 'tmp', `${assertValidTaskId(taskId)}-quality-checklist-answers.json`));
}

export function assertQualityChecklistAnswersPathHasNoSymlinks(pathValue: string, repoRoot: string): void {
    const absoluteRoot = path.resolve(repoRoot);
    const absolutePath = path.resolve(pathValue);
    const relativePath = path.relative(absoluteRoot, absolutePath);
    if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
        throw new Error(`Quality checklist answers path must stay inside repo root: ${normalizePath(absolutePath)}`);
    }
    let currentPath = absoluteRoot;
    for (const segment of relativePath.split(path.sep).filter(Boolean)) {
        currentPath = path.join(currentPath, segment);
        if (!fs.existsSync(currentPath)) break;
        if (fs.lstatSync(currentPath).isSymbolicLink()) {
            throw new Error(`Quality checklist answers path must not contain symbolic links: ${normalizePath(currentPath)}`);
        }
    }
}

function resolveAnswersTemplateWritePath(pathValue: string, repoRoot: string): string {
    const resolvedPath = resolvePathInsideRepo(pathValue, repoRoot, { allowMissing: true, enforceInside: true });
    if (!resolvedPath) {
        throw new Error('QualityChecklistAnswersTemplatePath must not be empty.');
    }
    assertQualityChecklistAnswersPathHasNoSymlinks(resolvedPath, repoRoot);
    let existingAncestor = fs.existsSync(resolvedPath) ? resolvedPath : path.dirname(resolvedPath);
    while (!fs.existsSync(existingAncestor) && existingAncestor !== path.dirname(existingAncestor)) {
        existingAncestor = path.dirname(existingAncestor);
    }
    const repoRealPath = fs.realpathSync.native(repoRoot);
    const ancestorRealPath = fs.realpathSync.native(existingAncestor);
    if (!isPathInsideRoot(ancestorRealPath, repoRealPath)) {
        throw new Error(`Quality checklist answers template path must resolve inside repo root: ${normalizePath(resolvedPath)}`);
    }
    return resolvedPath;
}

function resolveAnswersTemplateBindingPath(answersPath: string, repoRoot: string): string {
    return resolveAnswersTemplateWritePath(`${answersPath}.binding.json`, repoRoot);
}

function writeQualityChecklistAnswersTemplateFile(
    answersPath: string,
    repoRoot: string,
    template: QualityChecklistAnswersTemplate
): void {
    writeFileAtomically(answersPath, JSON.stringify(template, null, 2) + '\n', { encoding: 'utf8' });
    writeQualityChecklistAnswersTemplateBinding(answersPath, repoRoot, template);
}

function buildQualityChecklistAnswersTemplateBinding(
    answersPath: string,
    template: QualityChecklistAnswersTemplate
): QualityChecklistAnswersTemplateBinding {
    const activeRuleIds = normalizeActiveRuleIds(template.active_rule_ids) || [];
    const activeRuleFingerprints = normalizeActiveRuleFingerprints(template.active_rule_fingerprints, activeRuleIds) || {};
    return {
        schema_version: 1,
        event_source: QUALITY_CHECKLIST_ANSWERS_TEMPLATE_BINDING_EVENT_SOURCE,
        task_id: template.task_id,
        checklist_id: template.checklist_id,
        answers_path: normalizePath(answersPath),
        preflight_path: template.preflight_path,
        preflight_sha256: template.preflight_sha256,
        workflow_config_path: template.workflow_config_path,
        workflow_config_sha256: template.workflow_config_sha256,
        effective_policy_sha256: template.effective_policy_sha256,
        active_rule_ids: [...activeRuleIds],
        active_rule_fingerprints: activeRuleFingerprints,
        answers_template_policy_sha256: qualityChecklistAnswersTemplatePolicySha256FromParts(
            activeRuleIds,
            activeRuleFingerprints
        )
    };
}

function resolveQualityChecklistTaskEventsPath(repoRoot: string, taskId: string): string {
    return joinOrchestratorPath(repoRoot, path.join('runtime', 'task-events', `${assertValidTaskId(taskId)}.jsonl`));
}

function appendQualityChecklistAnswersTemplateBindingEvidence(options: {
    answersPath: string;
    bindingPath: string;
    binding: QualityChecklistAnswersTemplateBinding;
    repoRoot: string;
}): void {
    const bindingSha256 = fileSha256(options.bindingPath);
    appendTaskEvent(
        joinOrchestratorPath(options.repoRoot, ''),
        options.binding.task_id,
        QUALITY_CHECKLIST_ANSWERS_TEMPLATE_BINDING_RECORDED_EVENT,
        'INFO',
        'Quality checklist answers template binding recorded.',
        {
            answers_path: normalizePath(options.answersPath),
            binding_path: normalizePath(options.bindingPath),
            binding_sha256: bindingSha256,
            answers_template_policy_sha256: options.binding.answers_template_policy_sha256,
            active_rule_ids: options.binding.active_rule_ids
        },
        { actor: 'gate' }
    );
}

function bindingHasTaskEventEvidence(options: {
    answersPath: string;
    bindingPath: string;
    binding: QualityChecklistAnswersTemplateBinding;
    repoRoot: string;
}): boolean {
    const taskEventsPath = resolveQualityChecklistTaskEventsPath(options.repoRoot, options.binding.task_id);
    const inspection = inspectTaskEventFile(taskEventsPath, options.binding.task_id);
    if (inspection.status !== 'PASS' && inspection.status !== 'PASS_WITH_LEGACY_PREFIX') {
        return false;
    }
    const expectedAnswersPath = normalizePath(options.answersPath);
    const expectedBindingPath = normalizePath(options.bindingPath);
    const expectedBindingSha256 = fileSha256(options.bindingPath);
    let matched = false;
    try {
        forEachJsonlLine(taskEventsPath, (rawLine: string) => {
            if (matched) {
                return;
            }
            const parsed = JSON.parse(rawLine) as Record<string, unknown>;
            if (parsed.event_type !== QUALITY_CHECKLIST_ANSWERS_TEMPLATE_BINDING_RECORDED_EVENT) {
                return;
            }
            const details = isRecord(parsed.details) ? parsed.details : {};
            if (normalizePath(details.answers_path) === expectedAnswersPath
                && normalizePath(details.binding_path) === expectedBindingPath
                && normalizeRuleFingerprint(details.binding_sha256) === expectedBindingSha256
                && normalizeRuleFingerprint(details.answers_template_policy_sha256) === options.binding.answers_template_policy_sha256) {
                matched = true;
            }
        });
    } catch {
        return false;
    }
    return matched;
}

function readQualityChecklistAnswersTemplateBinding(
    answersPath: string,
    repoRoot: string
): QualityChecklistAnswersTemplateBinding | null {
    const bindingPath = resolveAnswersTemplateBindingPath(answersPath, repoRoot);
    if (!fs.existsSync(bindingPath)) {
        return null;
    }
    try {
        assertQualityChecklistAnswersPathHasNoSymlinks(bindingPath, repoRoot);
        const parsed = JSON.parse(fs.readFileSync(bindingPath, 'utf8')) as Partial<QualityChecklistAnswersTemplateBinding>;
        if (parsed.schema_version !== 1
            || parsed.event_source !== QUALITY_CHECKLIST_ANSWERS_TEMPLATE_BINDING_EVENT_SOURCE
            || typeof parsed.task_id !== 'string'
            || parsed.checklist_id !== QUALITY_CHECKLIST_ID
            || typeof parsed.answers_path !== 'string'
            || typeof parsed.preflight_path !== 'string'
            || typeof parsed.preflight_sha256 !== 'string'
            || typeof parsed.workflow_config_path !== 'string'
            || !(typeof parsed.workflow_config_sha256 === 'string' || parsed.workflow_config_sha256 === null)
            || typeof parsed.effective_policy_sha256 !== 'string'
            || !Array.isArray(parsed.active_rule_ids)
            || !isRecord(parsed.active_rule_fingerprints)
            || typeof parsed.answers_template_policy_sha256 !== 'string') {
            return null;
        }
        if (normalizePath(parsed.answers_path) !== normalizePath(answersPath)) {
            return null;
        }
        const activeRuleIds = normalizeActiveRuleIds(parsed.active_rule_ids);
        if (!activeRuleIds) {
            return null;
        }
        const activeRuleFingerprints = normalizeActiveRuleFingerprints(parsed.active_rule_fingerprints, activeRuleIds);
        if (!activeRuleFingerprints) {
            return null;
        }
        if (parsed.answers_template_policy_sha256 !== qualityChecklistAnswersTemplatePolicySha256FromParts(
            activeRuleIds,
            activeRuleFingerprints
        )) {
            return null;
        }
        const binding: QualityChecklistAnswersTemplateBinding = {
            schema_version: 1,
            event_source: QUALITY_CHECKLIST_ANSWERS_TEMPLATE_BINDING_EVENT_SOURCE,
            task_id: parsed.task_id,
            checklist_id: QUALITY_CHECKLIST_ID,
            answers_path: normalizePath(parsed.answers_path),
            preflight_path: parsed.preflight_path,
            preflight_sha256: parsed.preflight_sha256,
            workflow_config_path: parsed.workflow_config_path,
            workflow_config_sha256: parsed.workflow_config_sha256,
            effective_policy_sha256: parsed.effective_policy_sha256,
            active_rule_ids: activeRuleIds,
            active_rule_fingerprints: activeRuleFingerprints,
            answers_template_policy_sha256: parsed.answers_template_policy_sha256
        };
        if (!bindingHasTaskEventEvidence({ answersPath, bindingPath, binding, repoRoot })) {
            return null;
        }
        return binding;
    } catch {
        return null;
    }
}

function readAuthenticatedBareAnswersTemplate(options: {
    answersPath: string;
    repoRoot: string;
    expectedTemplate: QualityChecklistAnswersTemplate;
}, policy: QualityChecklistAnswersTemplatePolicy): { template: QualityChecklistAnswersTemplate; binding: QualityChecklistAnswersTemplateBinding } | null {
    const answersPath = resolveAnswersTemplateWritePath(options.answersPath, options.repoRoot);
    try {
        const parsed = JSON.parse(fs.readFileSync(answersPath, 'utf8')) as unknown;
        const activeRuleIds = templateRuleIds(parsed);
        const binding = readQualityChecklistAnswersTemplateBinding(answersPath, options.repoRoot);
        if (!Array.isArray(parsed)
            || !activeRuleIds
            || !binding
            || binding.task_id !== options.expectedTemplate.task_id
            || binding.checklist_id !== options.expectedTemplate.checklist_id
            || !activeRuleIdsMatch(activeRuleIds, binding.active_rule_ids)) {
            return null;
        }
        const answers = parsed.map(policy.normalizeReusableAnswer);
        if (answers.some((answer) => answer === null)) {
            return null;
        }
        const template: QualityChecklistAnswersTemplate = {
            schema_version: 1,
            timestamp_utc: options.expectedTemplate.timestamp_utc,
            event_source: QUALITY_CHECKLIST_ANSWERS_TEMPLATE_EVENT_SOURCE,
            task_id: binding.task_id,
            checklist_id: binding.checklist_id,
            preflight_path: binding.preflight_path,
            preflight_sha256: binding.preflight_sha256,
            workflow_config_path: binding.workflow_config_path,
            workflow_config_sha256: binding.workflow_config_sha256,
            effective_policy_sha256: binding.effective_policy_sha256,
            active_rule_ids: [...binding.active_rule_ids],
            active_rule_fingerprints: { ...binding.active_rule_fingerprints },
            answers: answers as QualityChecklistAnswersTemplateAnswer[]
        };
        return bindingMatchesTemplate(binding, template) ? { template, binding } : null;
    } catch {
        return null;
    }
}

function writeQualityChecklistAnswersTemplateBinding(
    answersPath: string,
    repoRoot: string,
    template: QualityChecklistAnswersTemplate
): void {
    const bindingPath = resolveAnswersTemplateBindingPath(answersPath, repoRoot);
    const binding = buildQualityChecklistAnswersTemplateBinding(answersPath, template);
    writeFileAtomically(bindingPath, JSON.stringify(binding, null, 2) + '\n', { encoding: 'utf8' });
    appendQualityChecklistAnswersTemplateBindingEvidence({ answersPath, bindingPath, binding, repoRoot });
}

function buildQualityChecklistRepairCandidatePath(answersPath: string, candidateIndex: number): string {
    const repairPath = `${answersPath}.repair.json`;
    if (candidateIndex === 0) return repairPath;
    if (candidateIndex === 1) return `${repairPath}.recovery.json`;
    return `${repairPath}.recovery.${candidateIndex}.json`;
}

function materializeUnsafeRepairTemplate(options: {
    answersPath: string;
    repoRoot: string;
    template: QualityChecklistAnswersTemplate;
    reason: string;
    refreshIfOlderThanUtc?: string | null;
}, policy: QualityChecklistAnswersTemplatePolicy): MaterializeQualityChecklistAnswersTemplateResult {
    const originalAnswersPath = normalizePath(options.answersPath);
    resolveAnswersTemplateWritePath(path.dirname(options.answersPath), options.repoRoot);
    const rejectedCandidates: string[] = [];
    let rejectedCandidateCount = 0;
    const recordRejectedCandidate = (candidatePath: string, reason: string): void => {
        rejectedCandidateCount += 1;
        if (rejectedCandidates.length < QUALITY_CHECKLIST_REPAIR_DIAGNOSTIC_LIMIT) {
            rejectedCandidates.push(`${normalizePath(candidatePath)} (${reason})`);
        }
    };
    for (let candidateIndex = 0; ; candidateIndex += 1) {
        const candidatePath = buildQualityChecklistRepairCandidatePath(options.answersPath, candidateIndex);
        let repairPath: string;
        let assessment: QualityChecklistAnswersTemplateAssessment;
        let binding: QualityChecklistAnswersTemplateBinding | null;
        try {
            repairPath = resolveAnswersTemplateWritePath(candidatePath, options.repoRoot);
            assessment = assessStoredQualityChecklistAnswersTemplateFile({
                repoRoot: options.repoRoot,
                taskId: options.template.task_id,
                preflightPath: options.template.preflight_path,
                answersPath: repairPath
            }, policy.assessTemplate);
            if (assessment.status === 'invalid') {
                const authenticatedBareAnswers = readAuthenticatedBareAnswersTemplate({
                    answersPath: repairPath,
                    repoRoot: options.repoRoot,
                    expectedTemplate: options.template
                }, policy);
                if (!authenticatedBareAnswers) {
                    recordRejectedCandidate(repairPath, assessment.reason);
                    continue;
                }
                assessment = {
                    status: 'stale',
                    reason: 'Authenticated bare quality-checklist answers require template normalization.',
                    template: authenticatedBareAnswers.template
                };
                binding = authenticatedBareAnswers.binding;
            } else {
                binding = assessment.status === 'missing'
                    ? null
                    : readQualityChecklistAnswersTemplateBinding(repairPath, options.repoRoot);
            }
            if ((assessment.status === 'current' || assessment.status === 'stale')
                && !bindingMatchesTemplate(binding, assessment.template!)) {
                recordRejectedCandidate(
                    repairPath,
                    `${assessment.reason} Existing binding is missing or does not match this repair candidate.`
                );
                continue;
            }
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            recordRejectedCandidate(candidatePath, message);
            continue;
        }

        try {
            const refreshThreshold = Date.parse(String(options.refreshIfOlderThanUtc || ''));
            const candidateTimestamp = Date.parse(String(assessment.template?.timestamp_utc || ''));
            const candidateIsNewerThanThreshold = Number.isFinite(refreshThreshold)
                && Number.isFinite(candidateTimestamp)
                && candidateTimestamp > refreshThreshold;
            let repairTemplate = options.template;
            let materialization = 'materialized';
            if (assessment.status === 'current'
                && (!Number.isFinite(refreshThreshold) || candidateIsNewerThanThreshold)) {
                repairTemplate = assessment.template!;
                materialization = 'retained';
                writeQualityChecklistAnswersTemplateBinding(repairPath, options.repoRoot, options.template);
            } else if (assessment.status === 'current' || assessment.status === 'stale') {
                repairTemplate = policy.mergeReusableAnswers(options.template, assessment.template!, binding);
                materialization = 'refreshed';
                writeQualityChecklistAnswersTemplateFile(repairPath, options.repoRoot, repairTemplate);
            } else {
                writeQualityChecklistAnswersTemplateFile(repairPath, options.repoRoot, repairTemplate);
            }

            const repairAnswersPath = normalizePath(repairPath);
            const omittedRejectedCandidateCount = rejectedCandidateCount - rejectedCandidates.length;
            const omittedRejectedCandidateDiagnostic = omittedRejectedCandidateCount > 0
                ? `; ${omittedRejectedCandidateCount} additional unsafe candidate(s)`
                : '';
            const rejectedDiagnostic = rejectedCandidates.length > 0
                ? ` Existing repair candidate preserved: ${rejectedCandidates.join('; ')}`
                    + `${omittedRejectedCandidateDiagnostic}.`
                : '';
            return {
                status: 'repair_created',
                answers_path: repairAnswersPath,
                original_answers_path: originalAnswersPath,
                template: repairTemplate,
                warning:
                    `Unsafe existing answers template preserved at ${originalAnswersPath}; ` +
                    `repair template ${materialization} at ${repairAnswersPath}. Reason: ${options.reason}` +
                    rejectedDiagnostic
            };
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(
                `Unsafe existing answers template preserved at ${originalAnswersPath}, but repair template ` +
                `materialization failed at ${normalizePath(repairPath)}: ${message}`
            );
        }
    }
}

export function materializeStoredQualityChecklistAnswersTemplate(options: {
    repoRoot: string;
    taskId: string;
    preflightPath?: unknown;
    answersPath?: string;
    refreshIfOlderThanUtc?: string | null;
}, policy: QualityChecklistAnswersTemplatePolicy): MaterializeQualityChecklistAnswersTemplateResult {
    const repoRoot = path.resolve(options.repoRoot);
    const taskId = assertValidTaskId(options.taskId);
    const answersPath = resolveAnswersTemplateWritePath(
        options.answersPath || resolveDefaultQualityChecklistAnswersTemplatePath(repoRoot, taskId),
        repoRoot
    );
    const assessment = assessStoredQualityChecklistAnswersTemplateFile({
        repoRoot,
        taskId,
        preflightPath: options.preflightPath,
        answersPath
    }, policy.assessTemplate);
    const refreshThreshold = Date.parse(String(options.refreshIfOlderThanUtc || ''));
    const currentTimestamp = Date.parse(String(assessment.template?.timestamp_utc || ''));
    const currentIsNewerThanThreshold = Number.isFinite(refreshThreshold)
        && Number.isFinite(currentTimestamp)
        && currentTimestamp > refreshThreshold;
    const expectedTemplate = policy.buildTemplate({ repoRoot, taskId, preflightPath: options.preflightPath });
    if (assessment.status === 'current' && (!Number.isFinite(refreshThreshold) || currentIsNewerThanThreshold)) {
        writeQualityChecklistAnswersTemplateBinding(answersPath, repoRoot, expectedTemplate);
        return { status: 'current', answers_path: normalizePath(answersPath), template: assessment.template! };
    }

    const binding = readQualityChecklistAnswersTemplateBinding(answersPath, repoRoot);
    if (assessment.status === 'invalid') {
        const authenticatedBareAnswers = readAuthenticatedBareAnswersTemplate({
            answersPath,
            repoRoot,
            expectedTemplate
        }, policy);
        if (authenticatedBareAnswers) {
            const template = policy.mergeReusableAnswers(
                expectedTemplate,
                authenticatedBareAnswers.template,
                authenticatedBareAnswers.binding
            );
            writeQualityChecklistAnswersTemplateFile(answersPath, repoRoot, template);
            return {
                status: 'refreshed',
                answers_path: normalizePath(answersPath),
                template,
                warning: 'Authenticated bare quality-checklist answers normalized to the bound template at the existing path.'
            };
        }
        return materializeUnsafeRepairTemplate({
            answersPath,
            repoRoot,
            template: expectedTemplate,
            reason: assessment.reason,
            refreshIfOlderThanUtc: options.refreshIfOlderThanUtc
        }, policy);
    }
    if (assessment.status === 'stale' && !bindingMatchesTemplate(binding, assessment.template!)) {
        return materializeUnsafeRepairTemplate({
            answersPath,
            repoRoot,
            template: expectedTemplate,
            reason: `${assessment.reason} Existing binding is missing or does not match the stale answers template.`,
            refreshIfOlderThanUtc: options.refreshIfOlderThanUtc
        }, policy);
    }
    const template = assessment.status === 'stale'
        ? policy.mergeReusableAnswers(expectedTemplate, assessment.template!, binding)
        : assessment.status === 'current'
            ? policy.mergeReusableAnswers(
                expectedTemplate,
                assessment.template!,
                buildQualityChecklistAnswersTemplateBinding(answersPath, expectedTemplate)
            )
        : expectedTemplate;
    writeQualityChecklistAnswersTemplateFile(answersPath, repoRoot, template);
    return {
        status: assessment.status === 'missing' ? 'created' : 'refreshed',
        answers_path: normalizePath(answersPath),
        template
    };
}
