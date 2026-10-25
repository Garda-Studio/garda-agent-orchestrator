import { buildGateChainLaunchDecision, formatGateChainLaunchDecision } from '../../core/dependent-validation-chains';
import { assertValidTaskId } from '../../gate-runtime/task-events';
import { fileSha256, normalizePath, resolvePathInsideRepo, stringSha256 } from '../shared/helpers';
import { validatePreflightForReview } from '../required-reviews/required-reviews-check';
import { getTaskModeEvidence, getTaskModeEvidenceViolations } from '../task-mode';
import { readExistingRulePackArtifact, resolveRulePackArtifactPath } from './rule-pack-artifact-store';
import { isRecord, normalizeRequiredReviewRecord, stringifyNormalizedRequiredReviews } from './rule-pack-records';
import {
    findStaleLoadedRuleFile,
    getLegacyPostPreflightRulePackFiles,
    getRulePackRequiredFilesFromPreflight,
    isCompatiblePostPreflightRuleFileSet,
    normalizeRuleFileList
} from './rule-pack-selection';
import {
    collectOrderedTimelineEvents,
    findLatestTimelineEvent,
    getLatestPostPreflightRulePackEventAfter,
    getLatestTaskModeSequence,
    getTaskTimelinePath,
    normalizeTimelinePathDetail
} from './rule-pack-timeline';
import {
    type PostPreflightRulePackRebindDecision,
    type PostPreflightSequenceEvidence
} from './rule-pack-types';

function stripVolatilePreflightFields(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(stripVolatilePreflightFields);
    }
    if (!isRecord(value)) {
        return value;
    }

    const sanitizedEntries = Object.entries(value)
        .filter(([key]) => key !== 'timestamp_utc')
        .sort(([left], [right]) => left.localeCompare(right))
        .map(function ([key, nestedValue]) {
            return [key, stripVolatilePreflightFields(nestedValue)] as const;
        });

    return Object.fromEntries(sanitizedEntries);
}

function buildChangedFileContentBindingSha256(repoRoot: string, changedFiles: unknown): string | null {
    const normalizedChangedFiles = Array.isArray(changedFiles)
        ? [...new Set(changedFiles.map(function (entry) {
            return normalizePath(String(entry || '').trim());
        }).filter(Boolean))].sort()
        : [];

    return stringSha256(JSON.stringify(normalizedChangedFiles.map(function (changedFile) {
        const resolvedPath = resolvePathInsideRepo(changedFile, repoRoot, { allowMissing: true });
        return {
            path: changedFile,
            sha256: resolvedPath ? fileSha256(resolvedPath) : null
        };
    })));
}

export function buildRulePackBindingSha256(options: {
    repoRoot: string;
    preflightPath: string | null;
    preflightPayload?: unknown;
    effectiveDepth: number | null;
    requiredRuleFiles: string[];
    requiredReviews: Record<string, boolean> | null;
}): string | null {
    if (!options.preflightPath) {
        return null;
    }

    return stringSha256(JSON.stringify({
        preflight_path: normalizePath(options.preflightPath),
        preflight_payload: stripVolatilePreflightFields(options.preflightPayload),
        changed_file_contents_sha256: buildChangedFileContentBindingSha256(
            options.repoRoot,
            isRecord(options.preflightPayload) ? options.preflightPayload.changed_files : []
        ),
        effective_depth: typeof options.effectiveDepth === 'number' ? options.effectiveDepth : null,
        required_rule_files: [...options.requiredRuleFiles].map(normalizePath).sort(),
        required_reviews: normalizeRequiredReviewRecord(options.requiredReviews)
    }));
}

export function getStageRulePackBindingSha256(stageArtifact: Record<string, unknown>): string | null {
    const explicitBindingHash = String(stageArtifact.preflight_rule_pack_binding_sha256 || '').trim().toLowerCase();
    return explicitBindingHash || null;
}

function resolveCurrentPostPreflightRulePackBinding(
    repoRoot: string,
    taskId: string,
    preflightPath: string,
    taskModePath = ''
): {
    bindingSha256: string | null;
    compatibleBindingSha256s: string[];
    violations: string[];
} {
    const validatedPreflight = validatePreflightForReview(preflightPath, taskId, taskModePath);
    const taskModeEvidence = getTaskModeEvidence(repoRoot, taskId, String(taskModePath || ''));
    const violations = [
        ...validatedPreflight.errors,
        ...getTaskModeEvidenceViolations(taskModeEvidence)
    ];

    let effectiveDepth = taskModeEvidence.effective_depth || null;
    const riskAwareDepth = validatedPreflight.preflight?.risk_aware_depth;
    if (riskAwareDepth && typeof riskAwareDepth.effective_depth === 'number') {
        effectiveDepth = riskAwareDepth.effective_depth;
    }

    const requiredRuleFiles = getRulePackRequiredFilesFromPreflight(
        repoRoot,
        validatedPreflight.required_reviews,
        effectiveDepth || 2
    );
    const legacyRequiredRuleFiles = getLegacyPostPreflightRulePackFiles(
        repoRoot,
        validatedPreflight.required_reviews,
        effectiveDepth || 2
    );
    const bindingSha256 = buildRulePackBindingSha256({
        repoRoot,
        preflightPath: normalizePath(validatedPreflight.preflight_path),
        preflightPayload: validatedPreflight.preflight,
        effectiveDepth,
        requiredRuleFiles,
        requiredReviews: validatedPreflight.required_reviews
    });
    const legacyBindingSha256 = buildRulePackBindingSha256({
        repoRoot,
        preflightPath: normalizePath(validatedPreflight.preflight_path),
        preflightPayload: validatedPreflight.preflight,
        effectiveDepth,
        requiredRuleFiles: legacyRequiredRuleFiles,
        requiredReviews: validatedPreflight.required_reviews
    });
    const compatibleBindingSha256s = [...new Set([
        bindingSha256,
        legacyBindingSha256
    ].filter((value): value is string => typeof value === 'string' && value.length > 0))];

    return {
        bindingSha256,
        compatibleBindingSha256s,
        violations
    };
}

export function getPreflightClassificationBinding(
    repoRoot: string,
    taskId: string,
    preflightPath: string
): {
    timeline_path: string;
    latest_preflight_sequence: number | null;
    latest_preflight_path: string | null;
    violations: string[];
} {
    const normalizedPreflightPath = normalizePath(preflightPath);
    const timelinePath = getTaskTimelinePath(repoRoot, taskId);
    const violations: string[] = [];
    const events = collectOrderedTimelineEvents(timelinePath, violations);
    if (violations.length > 0) {
        return {
            timeline_path: normalizePath(timelinePath),
            latest_preflight_sequence: null,
            latest_preflight_path: null,
            violations
        };
    }
    const latestPreflight = findLatestTimelineEvent(events, function (entry) {
        return entry.event_type === 'PREFLIGHT_CLASSIFIED';
    });
    if (!latestPreflight) {
        const decision = buildGateChainLaunchDecision({
            edgeId: 'preflight-to-post-preflight-rules',
            status: 'block',
            reason: 'PREFLIGHT_CLASSIFIED is missing before POST_PREFLIGHT rule-pack loading',
            context: { taskId, preflightPath },
            evidencePaths: [timelinePath]
        });
        violations.push(
            `Task timeline '${normalizePath(timelinePath)}' is missing PREFLIGHT_CLASSIFIED for '${normalizedPreflightPath}'. ` +
            'Run classify-change to completion before load-rule-pack --stage POST_PREFLIGHT or compile-gate. ' +
            formatGateChainLaunchDecision(decision)
        );
        return {
            timeline_path: normalizePath(timelinePath),
            latest_preflight_sequence: null,
            latest_preflight_path: null,
            violations
        };
    }

    const latestPreflightPath = normalizeTimelinePathDetail(
        latestPreflight.details?.output_path ?? latestPreflight.details?.outputPath
    );
    if (!latestPreflightPath) {
        violations.push(
            `Latest PREFLIGHT_CLASSIFIED evidence in '${normalizePath(timelinePath)}' is missing output_path details. ` +
            'Re-run classify-change before continuing the current task cycle.'
        );
    } else if (latestPreflightPath.toLowerCase() !== normalizedPreflightPath.toLowerCase()) {
        violations.push(
            `Current preflight artifact '${normalizedPreflightPath}' is not the latest PREFLIGHT_CLASSIFIED evidence in ` +
            `'${normalizePath(timelinePath)}'. Latest classified preflight path='${latestPreflightPath}'. ` +
            'Rejecting stale or parallel same-task overlap. Use the latest preflight artifact, then rerun downstream gates sequentially ' +
            "(classify-change -> load-rule-pack --stage POST_PREFLIGHT -> compile-gate)."
        );
    }

    return {
        timeline_path: normalizePath(timelinePath),
        latest_preflight_sequence: latestPreflight.sequence,
        latest_preflight_path: latestPreflightPath,
        violations
    };
}

export function getPostPreflightSequenceEvidence(
    repoRoot: string,
    taskId: string,
    preflightPath: string,
    options: {
        artifactPath?: string;
        taskModePath?: string;
    } = {}
): PostPreflightSequenceEvidence {
    const currentBinding = resolveCurrentPostPreflightRulePackBinding(
        repoRoot,
        taskId,
        preflightPath,
        String(options.taskModePath || '')
    );
    const binding = getPreflightClassificationBinding(repoRoot, taskId, preflightPath);
    const result: PostPreflightSequenceEvidence = {
        timeline_path: binding.timeline_path,
        latest_preflight_sequence: binding.latest_preflight_sequence,
        latest_preflight_path: binding.latest_preflight_path,
        latest_post_preflight_rule_pack_sequence: null,
        latest_post_preflight_rule_pack_path: null,
        current_preflight_rule_pack_binding_sha256: currentBinding.bindingSha256,
        latest_post_preflight_rule_pack_binding_sha256: null,
        binding_equivalent_to_current_preflight: false,
        violations: [...currentBinding.violations, ...binding.violations]
    };
    if (result.violations.length > 0) {
        return result;
    }

    const normalizedPreflightPath = normalizePath(preflightPath);
    const events = collectOrderedTimelineEvents(result.timeline_path, result.violations);
    if (result.violations.length > 0) {
        return result;
    }
    const latestTaskModeSequence = getLatestTaskModeSequence(events);

    const latestPostPreflightRulePack = findLatestTimelineEvent(events, function (entry) {
        if (entry.event_type !== 'RULE_PACK_LOADED') {
            return false;
        }
        const stage = String(entry.details?.stage || '').trim().toUpperCase();
        if (stage !== 'POST_PREFLIGHT') {
            return false;
        }
        const eventPreflightPath = normalizeTimelinePathDetail(
            entry.details?.preflight_path ?? entry.details?.preflightPath
        );
        return (eventPreflightPath || '').toLowerCase() === normalizedPreflightPath.toLowerCase();
    });

    if (!latestPostPreflightRulePack) {
        const decision = buildGateChainLaunchDecision({
            edgeId: 'post-preflight-rules-to-compile',
            status: 'block',
            reason: 'POST_PREFLIGHT RULE_PACK_LOADED is missing before compile-gate',
            context: { taskId, preflightPath },
            evidencePaths: [result.timeline_path]
        });
        result.violations.push(
            `Task timeline '${result.timeline_path}' is missing POST_PREFLIGHT RULE_PACK_LOADED evidence for '${normalizedPreflightPath}'. ` +
            'Run load-rule-pack --stage POST_PREFLIGHT after classify-change completes. These same-task transitions are not safe to parallelize. ' +
            formatGateChainLaunchDecision(decision)
        );
        return result;
    }

    result.latest_post_preflight_rule_pack_sequence = latestPostPreflightRulePack.sequence;
    result.latest_post_preflight_rule_pack_path = normalizeTimelinePathDetail(
        latestPostPreflightRulePack.details?.preflight_path ?? latestPostPreflightRulePack.details?.preflightPath
    );
    const existingArtifact = readExistingRulePackArtifact(
        resolveRulePackArtifactPath(repoRoot, taskId, String(options.artifactPath || ''))
    );
    const storedStage = isRecord(existingArtifact?.stages?.post_preflight)
        ? existingArtifact?.stages?.post_preflight as unknown as Record<string, unknown>
        : null;
    result.latest_post_preflight_rule_pack_binding_sha256 = storedStage
        ? getStageRulePackBindingSha256(storedStage)
        : null;
    result.binding_equivalent_to_current_preflight = !!(
        result.latest_post_preflight_rule_pack_binding_sha256
        && currentBinding.compatibleBindingSha256s.includes(result.latest_post_preflight_rule_pack_binding_sha256)
    );

    if (
        binding.latest_preflight_sequence != null
        && latestPostPreflightRulePack.sequence <= binding.latest_preflight_sequence
        && !result.binding_equivalent_to_current_preflight
    ) {
        const decision = buildGateChainLaunchDecision({
            edgeId: 'post-preflight-rules-to-compile',
            status: 'block',
            reason: 'POST_PREFLIGHT RULE_PACK_LOADED is not newer than the latest PREFLIGHT_CLASSIFIED',
            context: { taskId, preflightPath },
            evidencePaths: [result.timeline_path]
        });
        result.violations.push(
            `Unsafe same-task overlap detected in '${result.timeline_path}': POST_PREFLIGHT RULE_PACK_LOADED (seq ${latestPostPreflightRulePack.sequence}) ` +
            `does not occur after the latest PREFLIGHT_CLASSIFIED (seq ${binding.latest_preflight_sequence}) for '${normalizedPreflightPath}'. ` +
            'Re-run load-rule-pack --stage POST_PREFLIGHT after classify-change completes, then rerun compile-gate. ' +
            'Do not parallelize classify-change, load-rule-pack --stage POST_PREFLIGHT, and compile-gate for the same task cycle. ' +
            formatGateChainLaunchDecision(decision)
        );
    }
    if (
        latestTaskModeSequence != null
        && latestPostPreflightRulePack.sequence <= latestTaskModeSequence
    ) {
        result.violations.push(
            `Unsafe stale task-mode cycle detected in '${result.timeline_path}': POST_PREFLIGHT RULE_PACK_LOADED (seq ${latestPostPreflightRulePack.sequence}) ` +
            `does not occur after the latest TASK_MODE_ENTERED (seq ${latestTaskModeSequence}) for '${normalizedPreflightPath}'. ` +
            'Re-run load-rule-pack --stage POST_PREFLIGHT or bind-rule-pack-to-preflight in the current task-mode cycle, then rerun compile-gate.'
        );
    }

    return result;
}

export function getPostPreflightRulePackRebindDecision(
    repoRoot: string,
    taskId: string,
    preflightPath: string,
    options: {
        artifactPath?: string;
        taskModePath?: string;
    } = {}
): PostPreflightRulePackRebindDecision {
    const resolvedTaskId = assertValidTaskId(taskId);
    const artifactPath = resolveRulePackArtifactPath(repoRoot, resolvedTaskId, String(options.artifactPath || ''));
    const artifact = readExistingRulePackArtifact(artifactPath);
    const stageArtifact = isRecord(artifact?.stages?.post_preflight)
        ? artifact?.stages?.post_preflight as unknown as Record<string, unknown>
        : null;
    const emptyDecision = function (reason: string): PostPreflightRulePackRebindDecision {
        return {
            can_bind: false,
            reason,
            loaded_rule_files: [],
            required_rule_files: [],
            previous_preflight_path: null,
            previous_rule_pack_sequence: null
        };
    };

    if (!stageArtifact) {
        return emptyDecision('No prior POST_PREFLIGHT rule-pack stage exists; rule files must be read and recorded.');
    }
    const stageStatus = String(stageArtifact.status || '').trim().toUpperCase();
    const stageOutcome = String(stageArtifact.outcome || '').trim().toUpperCase();
    if (stageStatus !== 'PASSED' || stageOutcome !== 'PASS') {
        return emptyDecision('Prior POST_PREFLIGHT rule-pack evidence did not pass; rule files must be read and recorded again.');
    }

    const timelineViolations: string[] = [];
    const timelinePath = getTaskTimelinePath(repoRoot, resolvedTaskId);
    const timelineEvents = collectOrderedTimelineEvents(timelinePath, timelineViolations);
    if (timelineViolations.length > 0) {
        return emptyDecision(`Rule-pack rebinding cannot verify the current task-mode cycle: ${timelineViolations.join(' ')}`);
    }
    const latestTaskModeSequence = getLatestTaskModeSequence(timelineEvents);
    if (latestTaskModeSequence == null) {
        return emptyDecision('Rule-pack rebinding requires current task-mode evidence; read the rule files in the active task cycle.');
    }
    const latestPostPreflightRulePack = getLatestPostPreflightRulePackEventAfter(timelineEvents, latestTaskModeSequence, artifactPath);
    if (!latestPostPreflightRulePack) {
        return emptyDecision('No POST_PREFLIGHT rule-pack evidence exists for this rule-pack artifact in the current task-mode cycle; rule files must be read again.');
    }

    const loadedRuleFiles = normalizeRuleFileList(repoRoot, stageArtifact.loaded_rule_files);
    if (loadedRuleFiles.length === 0) {
        return emptyDecision('Prior POST_PREFLIGHT rule-pack evidence has no loaded rule files to reuse.');
    }

    const validatedPreflight = validatePreflightForReview(
        preflightPath,
        resolvedTaskId,
        String(options.taskModePath || '')
    );
    const taskModeEvidence = getTaskModeEvidence(repoRoot, resolvedTaskId, String(options.taskModePath || ''));
    const validationErrors = [
        ...validatedPreflight.errors,
        ...getTaskModeEvidenceViolations(taskModeEvidence)
    ];
    if (validationErrors.length > 0) {
        return emptyDecision(`Rule-pack rebinding cannot validate the current preflight/task-mode evidence: ${validationErrors.join(' ')}`);
    }

    let effectiveDepth = taskModeEvidence.effective_depth || null;
    const riskAwareDepth = validatedPreflight.preflight?.risk_aware_depth;
    if (riskAwareDepth && typeof riskAwareDepth.effective_depth === 'number') {
        effectiveDepth = riskAwareDepth.effective_depth;
    }
    const requiredRuleFiles = getRulePackRequiredFilesFromPreflight(
        repoRoot,
        validatedPreflight.required_reviews,
        effectiveDepth || 2
    );
    const previousRequiredRuleFiles = normalizeRuleFileList(repoRoot, stageArtifact.required_rule_files);
    if (!isCompatiblePostPreflightRuleFileSet(
        repoRoot,
        previousRequiredRuleFiles,
        validatedPreflight.required_reviews,
        effectiveDepth || 2
    )) {
        return {
            can_bind: false,
            reason: 'Current preflight requires a different downstream rule set; rule files must be read and recorded.',
            loaded_rule_files: loadedRuleFiles,
            required_rule_files: requiredRuleFiles,
            previous_preflight_path: String(stageArtifact.preflight_path || '').trim() || null,
            previous_rule_pack_sequence: latestPostPreflightRulePack.sequence
        };
    }
    if (
        stringifyNormalizedRequiredReviews(stageArtifact.required_reviews)
        !== stringifyNormalizedRequiredReviews(validatedPreflight.required_reviews)
    ) {
        return {
            can_bind: false,
            reason: 'Current preflight changed required review decisions; rule files must be read and recorded.',
            loaded_rule_files: loadedRuleFiles,
            required_rule_files: requiredRuleFiles,
            previous_preflight_path: String(stageArtifact.preflight_path || '').trim() || null,
            previous_rule_pack_sequence: latestPostPreflightRulePack.sequence
        };
    }
    if (!requiredRuleFiles.every(function (ruleFile) {
        return loadedRuleFiles.some(function (loadedRuleFile) {
            return loadedRuleFile.toLowerCase() === ruleFile.toLowerCase();
        });
    })) {
        return {
            can_bind: false,
            reason: 'Prior POST_PREFLIGHT evidence did not load every rule file required by the current preflight.',
            loaded_rule_files: loadedRuleFiles,
            required_rule_files: requiredRuleFiles,
            previous_preflight_path: String(stageArtifact.preflight_path || '').trim() || null,
            previous_rule_pack_sequence: latestPostPreflightRulePack.sequence
        };
    }

    const loadedRuleHashes = stageArtifact.loaded_rule_hashes;
    const staleRuleFile = findStaleLoadedRuleFile(repoRoot, loadedRuleHashes, loadedRuleFiles);
    if (staleRuleFile) {
        return {
            can_bind: false,
            reason: `Previously loaded rule file '${normalizePath(staleRuleFile)}' changed or cannot be hashed; read the rule file again.`,
            loaded_rule_files: loadedRuleFiles,
            required_rule_files: requiredRuleFiles,
            previous_preflight_path: String(stageArtifact.preflight_path || '').trim() || null,
            previous_rule_pack_sequence: latestPostPreflightRulePack.sequence
        };
    }

    return {
        can_bind: true,
        reason: 'Required downstream rule files and rule hashes are unchanged in the current task-mode cycle; only the preflight binding must be refreshed.',
        loaded_rule_files: loadedRuleFiles,
        required_rule_files: requiredRuleFiles,
        previous_preflight_path: String(stageArtifact.preflight_path || '').trim() || null,
        previous_rule_pack_sequence: latestPostPreflightRulePack.sequence
    };
}
