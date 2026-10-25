import * as fs from 'node:fs';
import { assertValidTaskId } from '../../gate-runtime/task-events';
import { fileSha256, normalizePath, resolvePathInsideRepo } from '../shared';
import { validatePreflightForReview } from '../required-reviews';
import { getTaskModeEvidence, getTaskModeEvidenceViolations } from '../task-mode';
import { buildRulePackBindingSha256, getStageRulePackBindingSha256 } from './rule-pack-binding';
import { resolveRulePackArtifactPath } from './rule-pack-artifact-store';
import { isRecord } from './rule-pack-records';
import {
    findStaleLoadedRuleFile,
    getLegacyPostPreflightRulePackFiles,
    getRulePackRequiredEntryFiles,
    getRulePackRequiredFilesFromPreflight,
    getRulePackStageKey,
    isCompatiblePostPreflightRuleFileSet,
    isCompatibleTaskEntryRuleFileSet
} from './rule-pack-selection';
import {
    collectOrderedTimelineEvents,
    getLatestRulePackTimelineArtifactPath,
    getTaskTimelinePath
} from './rule-pack-timeline';
import {
    type RulePackEvidenceResult,
    type RulePackStageLabel
} from './rule-pack-types';

export function getRulePackEvidence(
    repoRoot: string,
    taskId: string | null,
    stage: RulePackStageLabel,
    options: {
        artifactPath?: string;
        preflightPath?: string;
        taskModePath?: string;
    } = {}
): RulePackEvidenceResult {
    const result: RulePackEvidenceResult = {
        task_id: taskId,
        stage,
        evidence_path: null,
        timeline_artifact_path: null,
        evidence_hash: null,
        evidence_status: 'UNKNOWN',
        evidence_outcome: null,
        evidence_task_id: null,
        evidence_source: null,
        evidence_stage: null,
        evidence_preflight_path: null,
        evidence_preflight_hash: null,
        evidence_preflight_rule_pack_binding_sha256: null,
        binding_equivalent_to_current_preflight: false,
        effective_depth: null,
        required_rule_files: [],
        loaded_rule_files: [],
        missing_rule_files: [],
        stale_loaded_rule_file: null
    };

    if (!taskId) {
        result.evidence_status = 'TASK_ID_MISSING';
        return result;
    }

    const resolvedTaskId = assertValidTaskId(taskId);
    const resolvedPath = resolveRulePackArtifactPath(repoRoot, resolvedTaskId, String(options.artifactPath || ''));
    result.evidence_path = normalizePath(resolvedPath);

    if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isFile()) {
        result.evidence_status = 'EVIDENCE_FILE_MISSING';
        return result;
    }

    result.evidence_hash = fileSha256(resolvedPath);

    let artifact: Record<string, unknown>;
    try {
        const parsedArtifact = JSON.parse(fs.readFileSync(resolvedPath, 'utf8'));
        artifact = isRecord(parsedArtifact) ? parsedArtifact : {};
    } catch {
        result.evidence_status = 'EVIDENCE_INVALID_JSON';
        return result;
    }

    result.evidence_task_id = String(artifact.task_id || '').trim() || null;
    result.evidence_source = String(artifact.event_source || '').trim() || null;
    if (result.evidence_task_id !== resolvedTaskId) {
        result.evidence_status = 'EVIDENCE_TASK_MISMATCH';
        return result;
    }
    if ((result.evidence_source || '').toLowerCase() !== 'load-rule-pack') {
        result.evidence_status = 'EVIDENCE_SOURCE_INVALID';
        return result;
    }

    const stages = isRecord(artifact.stages) ? artifact.stages : null;
    const stageKey = getRulePackStageKey(stage);
    const stageArtifact = stages && isRecord(stages[stageKey]) ? stages[stageKey] : null;
    if (!stageArtifact) {
        result.evidence_status = 'EVIDENCE_STAGE_MISSING';
        return result;
    }

    result.evidence_stage = String(stageArtifact.stage || '').trim() || null;
    result.evidence_status = String(stageArtifact.status || '').trim().toUpperCase();
    result.evidence_outcome = String(stageArtifact.outcome || '').trim().toUpperCase() || null;
    result.evidence_preflight_path = String(stageArtifact.preflight_path || '').trim() || null;
    result.evidence_preflight_hash = String(stageArtifact.preflight_hash_sha256 || '').trim() || null;
    result.evidence_preflight_rule_pack_binding_sha256 = getStageRulePackBindingSha256(stageArtifact);
    result.effective_depth = typeof stageArtifact.effective_depth === 'number' ? stageArtifact.effective_depth : null;
    result.required_rule_files = Array.isArray(stageArtifact.required_rule_files)
        ? stageArtifact.required_rule_files.map(function (item) { return normalizePath(item); })
        : [];
    result.loaded_rule_files = Array.isArray(stageArtifact.loaded_rule_files)
        ? stageArtifact.loaded_rule_files.map(function (item) { return normalizePath(item); })
        : [];
    result.missing_rule_files = Array.isArray(stageArtifact.missing_rule_files)
        ? stageArtifact.missing_rule_files.map(function (item) { return normalizePath(item); })
        : [];

    if (result.evidence_stage !== stage) {
        result.evidence_status = 'EVIDENCE_STAGE_INVALID';
        return result;
    }

    const timelineViolations: string[] = [];
    const timelineEvents = collectOrderedTimelineEvents(getTaskTimelinePath(repoRoot, resolvedTaskId), timelineViolations);
    if (timelineViolations.length === 0) {
        result.timeline_artifact_path = getLatestRulePackTimelineArtifactPath(
            timelineEvents,
            stage,
            result.evidence_preflight_path
        );
        if (
            result.timeline_artifact_path
            && result.evidence_path
            && result.timeline_artifact_path.toLowerCase() !== result.evidence_path.toLowerCase()
        ) {
            result.evidence_status = 'EVIDENCE_ARTIFACT_PATH_MISMATCH';
            return result;
        }
    }

    let expectedRuleFiles: string[] = [];
    let artifactRuleSetCompatible = false;
    let postPreflightRequiredReviews: Record<string, boolean> | null = null;
    let postPreflightEffectiveDepth: number | null = null;
    if (stage === 'TASK_ENTRY') {
        const taskModeEvidence = getTaskModeEvidence(repoRoot, resolvedTaskId, String(options.taskModePath || ''));
        if (getTaskModeEvidenceViolations(taskModeEvidence).length > 0) {
            result.evidence_status = 'EVIDENCE_TASK_MODE_INVALID';
            return result;
        }
        const expectedEffectiveDepth = taskModeEvidence.effective_depth || 2;
        expectedRuleFiles = getRulePackRequiredEntryFiles(repoRoot, expectedEffectiveDepth);
        artifactRuleSetCompatible = isCompatibleTaskEntryRuleFileSet(
            repoRoot,
            result.required_rule_files,
            expectedEffectiveDepth
        );
    } else {
        const resolvedPreflightPath = resolvePathInsideRepo(String(options.preflightPath || '').trim(), repoRoot);
        if (!resolvedPreflightPath) {
            result.evidence_status = 'EVIDENCE_PREFLIGHT_REQUIRED';
            return result;
        }
        const validatedPreflight = validatePreflightForReview(
            resolvedPreflightPath,
            resolvedTaskId,
            String(options.taskModePath || '')
        );
        const taskModeEvidence = getTaskModeEvidence(repoRoot, resolvedTaskId, String(options.taskModePath || ''));
        if (getTaskModeEvidenceViolations(taskModeEvidence).length > 0) {
            result.evidence_status = 'EVIDENCE_TASK_MODE_INVALID';
            return result;
        }
        // Prefer risk-aware promoted depth from preflight when available.
        let evidenceEffectiveDepth = taskModeEvidence.effective_depth || 2;
        const evidenceRiskAwareDepth = validatedPreflight.preflight?.risk_aware_depth;
        if (evidenceRiskAwareDepth && typeof evidenceRiskAwareDepth.effective_depth === 'number') {
            evidenceEffectiveDepth = evidenceRiskAwareDepth.effective_depth;
        }
        postPreflightRequiredReviews = validatedPreflight.required_reviews;
        postPreflightEffectiveDepth = evidenceEffectiveDepth;
        expectedRuleFiles = getRulePackRequiredFilesFromPreflight(
            repoRoot,
            validatedPreflight.required_reviews,
            evidenceEffectiveDepth
        );
        const legacyRuleFiles = getLegacyPostPreflightRulePackFiles(
            repoRoot,
            validatedPreflight.required_reviews,
            evidenceEffectiveDepth
        );
        const expectedBindingSha256 = buildRulePackBindingSha256({
            repoRoot,
            preflightPath: validatedPreflight.preflight_path,
            preflightPayload: validatedPreflight.preflight,
            effectiveDepth: evidenceEffectiveDepth,
            requiredRuleFiles: expectedRuleFiles,
            requiredReviews: validatedPreflight.required_reviews
        });
        const legacyBindingSha256 = buildRulePackBindingSha256({
            repoRoot,
            preflightPath: validatedPreflight.preflight_path,
            preflightPayload: validatedPreflight.preflight,
            effectiveDepth: evidenceEffectiveDepth,
            requiredRuleFiles: legacyRuleFiles,
            requiredReviews: validatedPreflight.required_reviews
        });
        result.binding_equivalent_to_current_preflight = !!(
            result.evidence_preflight_rule_pack_binding_sha256
            && (
                expectedBindingSha256 === result.evidence_preflight_rule_pack_binding_sha256
                || legacyBindingSha256 === result.evidence_preflight_rule_pack_binding_sha256
            )
        );

        const normalizedPreflightPath = normalizePath(validatedPreflight.preflight_path);
        if ((result.evidence_preflight_path || '').toLowerCase() !== normalizedPreflightPath.toLowerCase()) {
            result.evidence_status = 'EVIDENCE_PREFLIGHT_PATH_MISMATCH';
            return result;
        }
        if (
            (result.evidence_preflight_hash || '').toLowerCase() !== String(validatedPreflight.preflight_hash || '').toLowerCase()
            && !result.binding_equivalent_to_current_preflight
        ) {
            result.evidence_status = 'EVIDENCE_PREFLIGHT_HASH_MISMATCH';
            return result;
        }
    }

    if (stage !== 'TASK_ENTRY') {
        artifactRuleSetCompatible = isCompatiblePostPreflightRuleFileSet(
            repoRoot,
            result.required_rule_files,
            postPreflightRequiredReviews || {},
            postPreflightEffectiveDepth
        );
    }
    if (!artifactRuleSetCompatible) {
        result.evidence_status = 'EVIDENCE_RULE_SET_INVALID';
        return result;
    }

    const loadedSet = new Set(result.loaded_rule_files.map(function (ruleFile) {
        return ruleFile.toLowerCase();
    }));
    const requiredRecordedSet = new Set(result.required_rule_files.map(function (ruleFile) {
        return ruleFile.toLowerCase();
    }));
    if (
        result.missing_rule_files.length > 0
        || expectedRuleFiles.some(function (ruleFile) { return !loadedSet.has(ruleFile.toLowerCase()); })
        || result.required_rule_files.some(function (ruleFile) { return !loadedSet.has(ruleFile.toLowerCase()); })
        || expectedRuleFiles.some(function (ruleFile) { return !requiredRecordedSet.has(ruleFile.toLowerCase()); })
    ) {
        result.evidence_status = 'EVIDENCE_REQUIRED_RULES_MISSING';
        return result;
    }

    const staleLoadedRuleFile = findStaleLoadedRuleFile(repoRoot, stageArtifact.loaded_rule_hashes, result.loaded_rule_files);
    if (staleLoadedRuleFile) {
        result.stale_loaded_rule_file = staleLoadedRuleFile;
        result.evidence_status = 'EVIDENCE_LOADED_RULE_STALE';
        return result;
    }

    if (result.evidence_status === 'PASSED' && result.evidence_outcome === 'PASS') {
        result.evidence_status = 'PASS';
        return result;
    }

    result.evidence_status = 'EVIDENCE_NOT_PASS';
    return result;
}
