import * as path from 'node:path';
import { assertValidTaskId } from '../../gate-runtime/task-events';
import { normalizePath, resolvePathInsideRepo } from '../shared';
import { validatePreflightForReview } from '../required-reviews';
import { getTaskModeEvidence, getTaskModeEvidenceViolations } from '../task-mode';
import { buildRulePackBindingSha256, getPreflightClassificationBinding } from './rule-pack-binding';
import { readExistingRulePackArtifact, resolveRulePackArtifactPath } from './rule-pack-artifact-store';
import { isRecord } from './rule-pack-records';
import {
    buildRuleFileHashes,
    getRulePackRequiredEntryFiles,
    getRulePackRequiredFilesFromPreflight,
    getRulePackStageKey,
    normalizeLoadedRuleFiles
} from './rule-pack-selection';
import {
    type BuildRulePackArtifactOptions,
    type RulePackArtifact,
    type RulePackStageArtifact
} from './rule-pack-types';

export function buildRulePackArtifact(options: BuildRulePackArtifactOptions): RulePackArtifact {
    const repoRoot = path.resolve(options.repoRoot);
    const taskId = assertValidTaskId(options.taskId);
    const stage = options.stage;
    const actor = String(options.actor || 'orchestrator').trim() || 'orchestrator';
    const loadedRuleFiles = normalizeLoadedRuleFiles(repoRoot, options.loadedRuleFiles || []);

    const violations: string[] = [];
    if (loadedRuleFiles.length === 0) {
        violations.push('Explicit loaded rule file list is required. Pass --loaded-rule-file for every opened downstream rule file.');
    }

    let preflightPath: string | null = null;
    let preflightHash: string | null = null;
    let requiredReviews: Record<string, boolean> | null = null;
    let effectiveDepth: number | null = null;
    let requiredRuleFiles: string[] = [];
    let preflightEventSequence: number | null = null;
    let preflightPayload: unknown = null;

    if (stage === 'TASK_ENTRY') {
        const taskModeEvidence = getTaskModeEvidence(repoRoot, taskId, String(options.taskModePath || ''));
        const taskModeViolations = getTaskModeEvidenceViolations(taskModeEvidence);
        if (taskModeViolations.length > 0) {
            violations.push(...taskModeViolations);
            effectiveDepth = taskModeEvidence.effective_depth || null;
        } else {
            effectiveDepth = taskModeEvidence.effective_depth;
        }
        requiredRuleFiles = getRulePackRequiredEntryFiles(repoRoot, effectiveDepth);
    } else {
        const resolvedPreflightPath = resolvePathInsideRepo(String(options.preflightPath || '').trim(), repoRoot);
        if (!resolvedPreflightPath) {
            throw new Error('PreflightPath is required for POST_PREFLIGHT rule-pack evidence.');
        }
        const validatedPreflight = validatePreflightForReview(
            resolvedPreflightPath,
            taskId,
            String(options.taskModePath || '')
        );
        preflightPath = normalizePath(validatedPreflight.preflight_path);
        preflightHash = validatedPreflight.preflight_hash;
        requiredReviews = validatedPreflight.required_reviews;
        preflightPayload = validatedPreflight.preflight;
        violations.push(...validatedPreflight.errors);

        const taskModeEvidence = getTaskModeEvidence(repoRoot, taskId, String(options.taskModePath || ''));
        const taskModeViolations = getTaskModeEvidenceViolations(taskModeEvidence);
        if (taskModeViolations.length > 0) {
            violations.push(...taskModeViolations);
            effectiveDepth = taskModeEvidence.effective_depth || null;
        } else {
            effectiveDepth = taskModeEvidence.effective_depth;
        }

        // Prefer risk-aware promoted depth from preflight when available.
        const preflightRiskAwareDepth = validatedPreflight.preflight?.risk_aware_depth;
        if (preflightRiskAwareDepth && typeof preflightRiskAwareDepth.effective_depth === 'number') {
            effectiveDepth = preflightRiskAwareDepth.effective_depth;
        }

        requiredRuleFiles = getRulePackRequiredFilesFromPreflight(
            repoRoot,
            requiredReviews,
            effectiveDepth || 2
        );

        const preflightBinding = getPreflightClassificationBinding(repoRoot, taskId, preflightPath);
        preflightEventSequence = preflightBinding.latest_preflight_sequence;
        violations.push(...preflightBinding.violations);
    }

    const requiredRuleSet = new Set(requiredRuleFiles.map(function (ruleFile) {
        return ruleFile.toLowerCase();
    }));
    const loadedRuleSet = new Set(loadedRuleFiles.map(function (ruleFile) {
        return ruleFile.toLowerCase();
    }));
    const missingRuleFiles = requiredRuleFiles.filter(function (ruleFile) {
        return !loadedRuleSet.has(ruleFile.toLowerCase());
    });
    if (missingRuleFiles.length > 0) {
        violations.push(
            `Missing required downstream rule files for ${stage}: ${missingRuleFiles.join(', ')}.`
        );
    }
    const extraRuleFiles = loadedRuleFiles.filter(function (ruleFile) {
        return !requiredRuleSet.has(ruleFile.toLowerCase());
    });

    const stageArtifact: RulePackStageArtifact = {
        timestamp_utc: new Date().toISOString(),
        stage,
        status: violations.length > 0 ? 'FAILED' : 'PASSED',
        outcome: violations.length > 0 ? 'FAIL' : 'PASS',
        actor,
        required_rule_files: requiredRuleFiles,
        loaded_rule_files: loadedRuleFiles,
        missing_rule_files: missingRuleFiles,
        extra_rule_files: extraRuleFiles,
        required_rule_hashes: buildRuleFileHashes(repoRoot, requiredRuleFiles),
        loaded_rule_hashes: buildRuleFileHashes(repoRoot, loadedRuleFiles),
        required_rule_count: requiredRuleFiles.length,
        loaded_rule_count: loadedRuleFiles.length,
        effective_depth: effectiveDepth,
        preflight_path: preflightPath,
        preflight_hash_sha256: preflightHash,
        preflight_rule_pack_binding_sha256: buildRulePackBindingSha256({
            repoRoot,
            preflightPath,
            preflightPayload,
            effectiveDepth,
            requiredRuleFiles,
            requiredReviews
        }),
        preflight_event_sequence: preflightEventSequence,
        required_reviews: requiredReviews,
        violations
    };

    const existingArtifact = readExistingRulePackArtifact(
        resolveRulePackArtifactPath(repoRoot, taskId, String(options.artifactPath || ''))
    );
    const stages = isRecord(existingArtifact?.stages) ? { ...existingArtifact.stages } : {};
    stages[getRulePackStageKey(stage)] = stageArtifact;

    return {
        timestamp_utc: stageArtifact.timestamp_utc,
        event_source: 'load-rule-pack',
        task_id: taskId,
        status: stageArtifact.status,
        outcome: stageArtifact.outcome,
        latest_stage: stage,
        stages
    };
}
