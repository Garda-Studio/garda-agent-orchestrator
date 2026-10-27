import { collectImmutableTimelineEvents as collectOrderedTimelineEvents } from './next-step-timeline-readers';
import * as path from 'node:path';
import { declaredFileRole, isTestScopePath } from '../../core/file-role-bindings';
import { resolveReviewReuseClassificationConfig } from '../review-reuse/review-reuse';
import { isValidatedCompletionFinalizationFailure } from '../completion/completion-finalization-retry';

import {
    getInternalCloseoutEvidenceKind,
    normalizeDocImpactInputPath
} from '../doc-impact/doc-impact';
import {
    resolveBundleNameForTarget
} from '../../core/constants';
import {
    type ProjectMemoryImpactEvidenceStatus,
    type ProjectMemoryImpactStatus,
    PROJECT_MEMORY_IMPACT_ASSESSED_EVENT,
    assessProjectMemoryImpact,
    getProjectMemoryImpactLifecycleEvidence,
    routeProjectMemoryImpact
} from '../project-memory-impact/project-memory-impact';
import {
    collectChangedProjectMemoryFiles
} from '../project-memory-impact/project-memory-impact-update-evidence';
import {
    collectScopedChangedProjectMemoryFiles
} from '../project-memory-impact/project-memory-impact-routing';
import {
    getClassificationConfig,
    isDocumentationLikePath,
    isRuntimeCodeLikePath,
    isSafeOrdinaryDocumentationPath,
    type ResolvedClassificationConfig
} from '../preflight/classify-change';
import {
    safeReadJson
} from '../task-audit/task-audit-summary-collectors';
import {
    type TimelineEventEntry
} from '../completion/completion-evidence';
import {
    PROJECT_MEMORY_AFTER_DOC_IMPACT_VIOLATION,
    docImpactClaimsProjectMemoryEvidence
} from '../completion/completion-project-memory';
import {
    normalizePath
} from '../shared/helpers';
import {
    describePathList,
    stringSha256,
    type PreflightWorkspaceReadiness
} from './next-step-compile-full-suite-readiness';
import {
    quoteCommandValue
} from './next-step-command-formatters';
import {
    findLatestTimelineEvent
} from './next-step-timeline-readers';
import { isPlainRecord } from '../../core/records';
import { readCloseoutLinkageRecovery } from '../completion/completion-linkage-recovery';

export interface NextStepProjectMemorySummary {
    enabled: boolean;
    required: boolean;
    mode: string;
    evidence_status: ProjectMemoryImpactEvidenceStatus;
    status: ProjectMemoryImpactStatus | null;
    update_needed: boolean | null;
    affected_memory_files: string[];
    updated_memory_files: string[];
    command_updated_memory_files: string[];
    command_skipped_memory_files: string[];
    command_update_inference_error: string | null;
    compact_status: string | null;
    compact_refreshed: boolean | null;
    artifact_path: string;
    update_artifact_path: string;
    visible_summary_line: string;
}

export interface PreflightCycleReadiness {
    ready: boolean;
    reason: string;
}

export interface PreflightCycleReadinessOptions {
    allowStaleCompletionFailureForDocCloseout?: boolean;
    staleCompletionFailureDocCloseoutReason?: string;
    timelineSnapshot?: NextStepCloseoutTimelineSnapshot;
}

export interface NextStepCloseoutTimelineSnapshot {
    timelinePath: string;
    events: readonly TimelineEventEntry[];
    errors: string[];
}

function hasPassedDocImpactArtifact(docImpactPath: string | null | undefined): boolean {
    if (!docImpactPath) {
        return false;
    }
    const docImpact = safeReadJson(docImpactPath);
    if (!docImpact) {
        return false;
    }
    return String(docImpact.status || '').trim().toUpperCase() === 'PASSED'
        && String(docImpact.outcome || '').trim().toUpperCase() === 'PASS';
}

function readPassedDocImpactArtifact(
    docImpactPath: string | null | undefined
): Record<string, unknown> | null {
    if (!docImpactPath) {
        return null;
    }
    const docImpact = safeReadJson(docImpactPath);
    return docImpact
        && String(docImpact.status || '').trim().toUpperCase() === 'PASSED'
        && String(docImpact.outcome || '').trim().toUpperCase() === 'PASS'
        ? docImpact
        : null;
}

export function readNextStepCloseoutTimelineSnapshot(
    eventsRoot: string,
    taskId: string
): NextStepCloseoutTimelineSnapshot {
    const timelinePath = path.resolve(eventsRoot, `${taskId}.jsonl`);
    const errors: string[] = [];
    const events = collectOrderedTimelineEvents(timelinePath, errors);
    return {
        timelinePath,
        events,
        errors
    };
}

function collectCloseoutTimelineEvents(
    eventsRoot: string,
    taskId: string,
    snapshot?: NextStepCloseoutTimelineSnapshot
): readonly TimelineEventEntry[] {
    const expectedTimelinePath = path.resolve(eventsRoot, `${taskId}.jsonl`);
    const resolvedSnapshotPath = snapshot
        ? path.resolve(snapshot.timelinePath)
        : null;
    if (snapshot && resolvedSnapshotPath === expectedTimelinePath) {
        return snapshot.errors.length === 0 ? snapshot.events : [];
    }
    const currentSnapshot = readNextStepCloseoutTimelineSnapshot(eventsRoot, taskId);
    return currentSnapshot.errors.length === 0 ? currentSnapshot.events : [];
}

export function isProjectMemoryEvidenceCurrentForCloseout(input: {
    eventsRoot: string;
    taskId: string;
    docImpactPath: string;
    evidenceCurrent: boolean;
    timelineSnapshot?: NextStepCloseoutTimelineSnapshot;
}): boolean {
    if (!input.evidenceCurrent) {
        return false;
    }
    const docImpact = readPassedDocImpactArtifact(input.docImpactPath);
    if (!docImpact || docImpactClaimsProjectMemoryEvidence(docImpact)) {
        return true;
    }
    const events = collectCloseoutTimelineEvents(
        input.eventsRoot,
        input.taskId,
        input.timelineSnapshot
    );
    const latestProjectMemoryImpact = findLatestTimelineEvent(
        events,
        (entry) => entry.event_type === PROJECT_MEMORY_IMPACT_ASSESSED_EVENT
    );
    const latestDocImpact = findLatestTimelineEvent(
        events,
        'DOC_IMPACT_ASSESSED'
    );
    return !latestProjectMemoryImpact
        || !latestDocImpact
        || latestProjectMemoryImpact.sequence > latestDocImpact.sequence;
}

function getProjectMemoryOrderOnlyRecoveryReason(
    eventsRoot: string,
    taskId: string,
    preflightPath: string,
    preflightSha256: string | null,
    docImpactPath: string,
    timelineSnapshot?: NextStepCloseoutTimelineSnapshot
): string | null {
    const docImpact = readPassedDocImpactArtifact(docImpactPath);
    if (
        !preflightSha256
        || !docImpact
        || docImpactClaimsProjectMemoryEvidence(docImpact)
    ) {
        return null;
    }
    const events = collectCloseoutTimelineEvents(eventsRoot, taskId, timelineSnapshot);
    const latestPreflight = findLatestTimelineEvent(
        events,
        'PREFLIGHT_CLASSIFIED'
    );
    const latestCompletionFailure = findLatestTimelineEvent(
        events,
        'COMPLETION_GATE_FAILED'
    );
    const latestProjectMemoryImpact = findLatestTimelineEvent(
        events,
        (entry) => entry.event_type === PROJECT_MEMORY_IMPACT_ASSESSED_EVENT
    );
    const latestDocImpact = findLatestTimelineEvent(
        events,
        'DOC_IMPACT_ASSESSED'
    );
    if (
        !latestPreflight
        || !latestDocImpact
        || !latestCompletionFailure
        || !docImpactTimelineDetailsMatchArtifact(
            latestDocImpact.details,
            docImpact,
            taskId,
            preflightPath,
            preflightSha256
        )
        || latestDocImpact.sequence < latestPreflight.sequence
        || latestDocImpact.sequence >= latestCompletionFailure.sequence
    ) {
        return null;
    }
    const violations = Array.isArray(latestCompletionFailure?.details?.violations)
        ? latestCompletionFailure.details.violations.map((entry) => String(entry))
        : [];
    const orderMismatchStillPresent = Boolean(
        latestCompletionFailure
        && latestProjectMemoryImpact
        && latestDocImpact
        && latestProjectMemoryImpact.sequence <= latestDocImpact.sequence
        && latestCompletionFailure.sequence > latestDocImpact.sequence
    );
    const orderMismatchRecovered = Boolean(
        latestCompletionFailure
        && latestProjectMemoryImpact
        && latestProjectMemoryImpact.sequence > latestCompletionFailure.sequence
    );
    if (
        violations.length !== 1
        || violations[0] !== PROJECT_MEMORY_AFTER_DOC_IMPACT_VIOLATION
        || !latestProjectMemoryImpact
        || !latestDocImpact
        || !latestCompletionFailure
        || (!orderMismatchStillPresent && !orderMismatchRecovered)
    ) {
        return null;
    }
    return orderMismatchRecovered
        ? 'a newer project-memory assessment repaired the sole project-memory-after-doc-impact completion violation'
        : 'the latest completion failure contains only the recoverable project-memory-after-doc-impact ordering violation';
}

function docImpactTimelineDetailsMatchArtifact(
    details: Record<string, unknown> | null,
    docImpact: Record<string, unknown>,
    taskId: string,
    preflightPath: string,
    preflightSha256: string
): boolean {
    if (!details) {
        return false;
    }
    const expectedDocsUpdated = Array.isArray(docImpact.docs_updated)
        ? docImpact.docs_updated.map((entry) => normalizePath(entry)).filter(Boolean).sort()
        : [];
    const actualDocsUpdated = Array.isArray(details.docs_updated)
        ? details.docs_updated.map((entry) => normalizePath(entry)).filter(Boolean).sort()
        : [];
    return String(details.task_id || '').trim() === taskId
        && normalizePath(String(details.preflight_path || '').trim()) === normalizePath(preflightPath)
        && String(details.preflight_hash_sha256 || '').trim().toLowerCase() === preflightSha256
        && String(details.decision || '').trim().toUpperCase() === String(docImpact.decision || '').trim().toUpperCase()
        && String(details.status || '').trim().toUpperCase() === String(docImpact.status || '').trim().toUpperCase()
        && String(details.outcome || '').trim().toUpperCase() === String(docImpact.outcome || '').trim().toUpperCase()
        && details.behavior_changed === docImpact.behavior_changed
        && details.changelog_updated === docImpact.changelog_updated
        && details.internal_changelog_updated === docImpact.internal_changelog_updated
        && details.project_memory_updated === docImpact.project_memory_updated
        && details.project_memory_update_not_needed === docImpact.project_memory_update_not_needed
        && stringSha256(actualDocsUpdated.join('\n')) === stringSha256(expectedDocsUpdated.join('\n'));
}

function getPassedOrdinaryDocsOnlyDocImpactUpdatedFiles(
    repoRoot: string,
    eventsRoot: string,
    taskId: string,
    preflightPath: string,
    preflightSha256: string | null,
    docImpactPath: string | null | undefined,
    timelineSnapshot?: NextStepCloseoutTimelineSnapshot
): string[] {
    if (!docImpactPath) {
        return [];
    }
    const docImpact = safeReadJson(docImpactPath);
    if (!docImpact) {
        return [];
    }
    if (String(docImpact.task_id || '').trim() !== taskId) {
        return [];
    }
    const evidencePreflightPath = normalizePath(String(docImpact.preflight_path || '').trim());
    const expectedPreflightPath = normalizePath(preflightPath);
    if (!evidencePreflightPath || evidencePreflightPath !== expectedPreflightPath) {
        return [];
    }
    const evidencePreflightHash = String(docImpact.preflight_hash_sha256 || '').trim().toLowerCase();
    if (!preflightSha256 || !evidencePreflightHash || evidencePreflightHash !== preflightSha256) {
        return [];
    }
    const decision = String(docImpact.decision || '').trim().toUpperCase();
    const status = String(docImpact.status || '').trim().toUpperCase();
    const outcome = String(docImpact.outcome || '').trim().toUpperCase();
    if (
        decision !== 'DOCS_UPDATED'
        || status !== 'PASSED'
        || outcome !== 'PASS'
        || docImpact.behavior_changed !== false
    ) {
        return [];
    }
    const docsUpdated = Array.isArray(docImpact.docs_updated)
        ? [...new Set(docImpact.docs_updated.map((entry) => normalizePath(entry)).filter(Boolean))].sort()
        : [];
    if (docsUpdated.length === 0) {
        return [];
    }
    const classificationConfig = getClassificationConfig(repoRoot);
    if (docsUpdated.some((entry) => !isOrdinaryDocumentationDeltaPath(entry, classificationConfig))) {
        return [];
    }
    const events = collectCloseoutTimelineEvents(eventsRoot, taskId, timelineSnapshot);
    if (events.length === 0) {
        return [];
    }
    const latestPreflight = findLatestTimelineEvent(
        events,
        'PREFLIGHT_CLASSIFIED'
    );
    const latestDocImpactAssessed = findLatestTimelineEvent(
        events,
        'DOC_IMPACT_ASSESSED'
    );
    const latestCompletionFailure = findLatestTimelineEvent(
        events,
        'COMPLETION_GATE_FAILED'
    );
    if (
        !latestPreflight
        || !latestDocImpactAssessed
        || !latestCompletionFailure
        || !docImpactTimelineDetailsMatchArtifact(
            latestDocImpactAssessed.details,
            docImpact,
            taskId,
            preflightPath,
            preflightSha256
        )
        || latestDocImpactAssessed.sequence < latestPreflight.sequence
        || latestDocImpactAssessed.sequence < latestCompletionFailure.sequence
    ) {
        return [];
    }
    return docsUpdated;
}

export function buildStaleCompletionFailureDocCloseoutAllowance(
    repoRoot: string,
    eventsRoot: string,
    taskId: string,
    preflightPath: string,
    preflightSha256: string | null,
    preflightWorkspaceReadiness: PreflightWorkspaceReadiness,
    docImpactPath: string,
    timelineSnapshot?: NextStepCloseoutTimelineSnapshot
): PreflightCycleReadinessOptions {
    if (!preflightWorkspaceReadiness.ready) {
        return {};
    }
    if (readCloseoutLinkageRecovery(repoRoot, taskId, preflightPath,
        timelineSnapshot?.timelinePath || path.join(eventsRoot, `${taskId}.jsonl`))) {
        return {
            allowStaleCompletionFailureForDocCloseout: true,
            staleCompletionFailureDocCloseoutReason: 'canonical follow-up linkage is corrected and all original validation bindings remain unchanged'
        };
    }
    const projectMemoryOrderRecoveryReason = getProjectMemoryOrderOnlyRecoveryReason(
        eventsRoot,
        taskId,
        preflightPath,
        preflightSha256,
        docImpactPath,
        timelineSnapshot
    );
    if (projectMemoryOrderRecoveryReason) {
        return {
            allowStaleCompletionFailureForDocCloseout: true,
            staleCompletionFailureDocCloseoutReason: projectMemoryOrderRecoveryReason
        };
    }
    if (hasPassedDocImpactArtifact(docImpactPath)) {
        const docImpactUpdatedFiles = getPassedOrdinaryDocsOnlyDocImpactUpdatedFiles(
            repoRoot,
            eventsRoot,
            taskId,
            preflightPath,
            preflightSha256,
            docImpactPath,
            timelineSnapshot
        );
        if (docImpactUpdatedFiles.length > 0) {
            return {
                allowStaleCompletionFailureForDocCloseout: true,
                staleCompletionFailureDocCloseoutReason:
                    `latest doc-impact evidence records ordinary documentation updates ${describePathList(docImpactUpdatedFiles)} with behavior_changed=false`
            };
        }
        return {};
    }
    const acceptedDeltaFiles = [
        ...(preflightWorkspaceReadiness.acceptedDocsOnlyDeltaFiles || []),
        ...(preflightWorkspaceReadiness.acceptedCloseoutOnlyDeltaFiles || [])
    ];
    if (acceptedDeltaFiles.length > 0) {
        return {
            allowStaleCompletionFailureForDocCloseout: true,
            staleCompletionFailureDocCloseoutReason:
                `current workspace drift is limited to ordinary documentation/closeout updates ${describePathList(acceptedDeltaFiles)}`
        };
    }
    return {};
}

function isOrdinaryDocumentationDeltaPath(
    filePath: string,
    classificationConfig: ResolvedClassificationConfig
): boolean {
    return isSafeOrdinaryDocumentationPath(filePath, classificationConfig);
}

export function readPreflightCycleReadiness(
    eventsRoot: string,
    taskId: string,
    options: PreflightCycleReadinessOptions = {}
): PreflightCycleReadiness {
    const events = collectCloseoutTimelineEvents(eventsRoot, taskId, options.timelineSnapshot);
    if (events.length === 0) {
        return {
            ready: true,
            reason: 'Timeline ordering could not be checked by next-step; downstream gates will report timeline integrity.'
        };
    }

    const latestPreflight = findLatestTimelineEvent(
        events,
        'PREFLIGHT_CLASSIFIED'
    );
    if (!latestPreflight) {
        return {
            ready: true,
            reason: 'No PREFLIGHT_CLASSIFIED event exists yet.'
        };
    }

    const latestTaskMode = findLatestTimelineEvent(
        events,
        'TASK_MODE_ENTERED'
    );
    if (latestTaskMode && latestPreflight.sequence < latestTaskMode.sequence) {
        return {
            ready: false,
            reason: `Preflight evidence is older than the latest TASK_MODE_ENTERED event (preflight seq ${latestPreflight.sequence}, task-mode seq ${latestTaskMode.sequence}). Refresh classify-change for the current task-mode cycle.`
        };
    }

    const latestShellSmoke = findLatestTimelineEvent(
        events,
        'SHELL_SMOKE_PREFLIGHT_RECORDED'
    );
    if (latestShellSmoke && latestPreflight.sequence < latestShellSmoke.sequence) {
        return {
            ready: false,
            reason: `Preflight evidence is older than the latest SHELL_SMOKE_PREFLIGHT_RECORDED event (preflight seq ${latestPreflight.sequence}, shell-smoke seq ${latestShellSmoke.sequence}). Refresh classify-change before compile/review/completion.`
        };
    }

    const latestCompletionFailure = findLatestTimelineEvent(
        events,
        'COMPLETION_GATE_FAILED'
    );
    if (
        latestCompletionFailure
        && latestPreflight.sequence < latestCompletionFailure.sequence
        && !isValidatedCompletionFinalizationFailure(latestCompletionFailure)
    ) {
        if (options.allowStaleCompletionFailureForDocCloseout) {
            return {
                ready: true,
                reason:
                    `Preflight evidence predates latest COMPLETION_GATE_FAILED (preflight seq ${latestPreflight.sequence}, completion failure seq ${latestCompletionFailure.sequence}), ` +
                    `but the closeout lane remains current because ${options.staleCompletionFailureDocCloseoutReason || 'only ordinary documentation closeout evidence changed'}.`
            };
        }
        return {
            ready: false,
            reason: `Preflight evidence is older than the latest COMPLETION_GATE_FAILED event (preflight seq ${latestPreflight.sequence}, completion failure seq ${latestCompletionFailure.sequence}). Refresh classify-change for the resumed cycle.`
        };
    }

    return {
        ready: true,
        reason: 'Preflight evidence is current for the latest startup cycle.'
    };
}

function getPreflightTriggers(preflight: Record<string, unknown> | null): Record<string, unknown> {
    return isPlainRecord(preflight?.triggers) ? preflight.triggers : {};
}

function requiresSensitiveScopeDocAcknowledgement(preflight: Record<string, unknown> | null): boolean {
    const triggers = getPreflightTriggers(preflight);
    return ['api', 'security', 'infra', 'dependency', 'db'].some((trigger) => triggers[trigger] === true);
}

export function getPreflightChangedFiles(preflight: Record<string, unknown> | null): string[] {
    return Array.isArray(preflight?.changed_files)
        ? [...new Set(preflight.changed_files.map((entry) => normalizePath(entry)).filter(Boolean))].sort()
        : [];
}

function isChangelogPath(filePath: string): boolean {
    return /(^|\/)CHANGELOG/i.test(normalizePath(filePath));
}

function getDocImpactChangedFiles(
    preflight: Record<string, unknown> | null,
    repoRoot: string,
    classificationConfig: ResolvedClassificationConfig
): string[] {
    return getPreflightChangedFiles(preflight)
        .map((filePath) => normalizeDocImpactInputPath(filePath, repoRoot))
        .filter((filePath) => (
            !declaredFileRole(filePath, classificationConfig.file_roles)
            && isDocumentationLikePath(filePath, classificationConfig.ordinary_doc_paths)
            && !isRuntimeCodeLikePath(filePath, classificationConfig.code_like_regexes, classificationConfig.runtime_roots)
        ));
}

function hasNonDocumentationPreflightScope(
    preflight: Record<string, unknown> | null,
    classificationConfig: ResolvedClassificationConfig
): boolean {
    return getPreflightChangedFiles(preflight).some((filePath) => (
        declaredFileRole(filePath, classificationConfig.file_roles) === 'source'
        || (!isTestScopePath(filePath, classificationConfig.test_trigger_regexes, classificationConfig.file_roles)
            && !isDocumentationLikePath(filePath, classificationConfig.ordinary_doc_paths))
    ));
}

export interface DocImpactCommandPlan {
    command: string;
    requiresProjectMemoryBeforeAssessment: boolean;
}

function buildInternalCloseoutFields(
    changedFiles: string[],
    repoRoot: string,
    requiresInternalBehaviorEvidence: boolean
): string[] {
    const evidenceKinds = new Set(changedFiles.map((filePath) => getInternalCloseoutEvidenceKind(filePath, repoRoot)));
    const fields: string[] = [];
    if (evidenceKinds.has('internal-changelog')) fields.push('--internal-changelog-updated true');
    if (evidenceKinds.has('project-memory')) {
        fields.push('--project-memory-updated true');
    } else if (requiresInternalBehaviorEvidence) {
        const memoryImpact = routeProjectMemoryImpact(changedFiles);
        fields.push(memoryImpact.affectedFileNames.length > 0
            ? '--project-memory-updated true'
            : '--project-memory-update-not-needed true');
    }
    return fields;
}

export function buildDocImpactCommandPlan(
    cliPrefix: string,
    taskId: string,
    preflightCommandPath: string,
    preflight: Record<string, unknown> | null,
    repoRoot: string,
    additionalDocsUpdated: string[] = []
): DocImpactCommandPlan {
    const classificationConfig = resolveReviewReuseClassificationConfig(preflight || {}, repoRoot);
    const additionalPaths = additionalDocsUpdated
        .map((entry) => normalizeDocImpactInputPath(entry, repoRoot)).filter(Boolean);
    const changedFiles = [...getPreflightChangedFiles(preflight), ...additionalPaths]
        .map((entry) => normalizeDocImpactInputPath(entry, repoRoot));
    const docsUpdated = [...new Set([
        ...getDocImpactChangedFiles(preflight, repoRoot, classificationConfig),
        ...additionalPaths
    ].filter((entry) => getInternalCloseoutEvidenceKind(entry, repoRoot) === null
        && !declaredFileRole(entry, classificationConfig.file_roles)))].sort();
    const changelogUpdated = docsUpdated.some((filePath) => isChangelogPath(filePath));
    const behaviorChanged = hasNonDocumentationPreflightScope(preflight, classificationConfig);
    const internalOnlyBehaviorChanged = docsUpdated.length === 0
        && String(preflight?.scope_category || '').trim().toLowerCase() !== 'test-only'
        && behaviorChanged;
    const requiresInternalBehaviorEvidence = (behaviorChanged || internalOnlyBehaviorChanged) && !changelogUpdated;
    const parts = [
        `${cliPrefix} gate doc-impact-gate`,
        `--task-id ${quoteCommandValue(taskId)}`,
        `--preflight-path ${quoteCommandValue(preflightCommandPath)}`
    ];
    if (docsUpdated.length > 0) {
        parts.push('--decision "DOCS_UPDATED"');
        parts.push(`--behavior-changed ${behaviorChanged ? 'true' : 'false'}`);
        for (const docPath of docsUpdated) {
            parts.push(`--docs-updated ${quoteCommandValue(docPath)}`);
        }
        parts.push(`--changelog-updated ${changelogUpdated ? 'true' : 'false'}`);
    } else {
        parts.push('--decision "NO_DOC_UPDATES"');
        parts.push(`--behavior-changed ${internalOnlyBehaviorChanged ? 'true' : 'false'}`);
        parts.push('--changelog-updated false');
    }
    parts.push(...buildInternalCloseoutFields(changedFiles, repoRoot, requiresInternalBehaviorEvidence));
    if (requiresSensitiveScopeDocAcknowledgement(preflight)) {
        parts.push('--sensitive-scope-reviewed true');
    }
    parts.push(docsUpdated.length > 0
        ? behaviorChanged
            ? changelogUpdated
                ? '--rationale "Changelog and implementation files changed in the current preflight; recording documentation impact as behavior-changing by default. Adjust only if the changelog entry is not user-visible behavior."'
                : '--rationale "Implementation and documentation changed in the current preflight; record behavior impact with current internal evidence when the public changelog is unchanged."'
            : '--rationale "Documentation or changelog files were changed in the current preflight; next-step records them without requiring a fresh code/test review when non-doc scope is unchanged."'
        : internalOnlyBehaviorChanged
            ? '--rationale "Implementation files changed with no user-facing documentation paths; recording internal-only behavior evidence. Update task-scoped project memory before running if this command reports missing internal evidence."'
            : '--rationale "No user-facing documentation impact detected by next-step; adjust this command before running if docs or behavior changed."');
    parts.push('--repo-root "."');
    return {
        command: parts.join(' '),
        requiresProjectMemoryBeforeAssessment: requiresInternalBehaviorEvidence
    };
}

export function buildDocImpactCommand(
    cliPrefix: string,
    taskId: string,
    preflightCommandPath: string,
    preflight: Record<string, unknown> | null,
    repoRoot: string,
    additionalDocsUpdated: string[] = []
): string {
    return buildDocImpactCommandPlan(
        cliPrefix,
        taskId,
        preflightCommandPath,
        preflight,
        repoRoot,
        additionalDocsUpdated
    ).command;
}

export function buildDocImpactCompatibilityHint(): string {
    return [
        'Compatible doc-impact choices:',
        'Decision values are exact: --decision "DOCS_UPDATED" or --decision "NO_DOC_UPDATES"; use --docs-updated only with DOCS_UPDATED.',
        'no user-facing docs -> --decision "NO_DOC_UPDATES" --behavior-changed false --changelog-updated false;',
        'docs only -> --decision "DOCS_UPDATED" --behavior-changed false --changelog-updated false plus --docs-updated for each user-facing doc;',
        'changelog/docs maintenance only -> --decision "DOCS_UPDATED" --behavior-changed false --changelog-updated true plus --docs-updated "CHANGELOG.md";',
        'changelog plus implementation scope -> next-step defaults to --decision "DOCS_UPDATED" --behavior-changed true --changelog-updated true;',
        'user-facing behavior changed -> --decision "DOCS_UPDATED" --behavior-changed true --changelog-updated true plus docs/changelog evidence;',
        'internal-only runtime behavior changed -> --decision "NO_DOC_UPDATES" --behavior-changed true plus --internal-changelog-updated true, --project-memory-updated true, or --project-memory-update-not-needed true when project-memory-impact records NO_UPDATE_NEEDED.'
    ].join(' ');
}

function resolveProjectMemoryCommandUpdateSplit(
    repoRoot: string,
    evidence: ReturnType<typeof getProjectMemoryImpactLifecycleEvidence>,
    currentArtifact: ReturnType<typeof assessProjectMemoryImpact>['artifact'] | null = null
): { updated: string[]; skipped: string[]; error: string | null } {
    const affected = [...(currentArtifact?.affected_memory_files || evidence.affected_memory_files)]
        .map(normalizePath)
        .filter(Boolean)
        .sort();
    const updateNeeded = currentArtifact?.update_needed ?? evidence.update_needed;
    if (updateNeeded !== true || affected.length === 0) {
        return {
            updated: [...(currentArtifact?.update_evidence.updated_memory_files || evidence.updated_memory_files)]
                .map(normalizePath)
                .filter(Boolean)
                .sort(),
            skipped: [],
            error: null
        };
    }
    const evidenceUpdated = [...(currentArtifact?.update_evidence.updated_memory_files || evidence.updated_memory_files)]
        .map(normalizePath)
        .filter(Boolean)
        .sort();
    const updateEvidenceAccepted = currentArtifact
        ? currentArtifact.status === 'UPDATED' && currentArtifact.update_evidence.status === 'VALID'
        : evidence.evidence_status === 'CURRENT' && evidence.status === 'UPDATED';
    if (updateEvidenceAccepted && evidenceUpdated.length > 0) {
        const updatedSet = new Set(evidenceUpdated);
        return {
            updated: evidenceUpdated,
            skipped: affected.filter((candidate) => !updatedSet.has(candidate)),
            error: null
        };
    }
    const affectedSet = new Set(affected);
    const bundleName = resolveBundleNameForTarget(repoRoot);
    const scopedChangedMemoryFiles = currentArtifact
        ? collectScopedChangedProjectMemoryFiles(currentArtifact.changed_files, bundleName)
            .map(normalizePath)
            .filter(Boolean)
            .filter((file) => affectedSet.has(file))
            .sort()
        : [];
    const bundleRoot = path.join(repoRoot, bundleName);
    const changed = collectChangedProjectMemoryFiles(repoRoot, bundleRoot);
    if (changed.error) {
        if (scopedChangedMemoryFiles.length > 0) {
            const updatedSet = new Set(scopedChangedMemoryFiles);
            return {
                updated: scopedChangedMemoryFiles,
                skipped: affected.filter((candidate) => !updatedSet.has(candidate)),
                error: null
            };
        }
        return {
            updated: [],
            skipped: affected,
            error: changed.error
        };
    }
    const changedProjectMemoryFiles = Array.from(new Set([
        ...scopedChangedMemoryFiles,
        ...changed.files
            .map(normalizePath)
            .filter(Boolean)
    ])).sort();
    const extraChangedFiles = changedProjectMemoryFiles.filter((file) => !affectedSet.has(file));
    if (extraChangedFiles.length > 0) {
        return {
            updated: [],
            skipped: [],
            error: `Current changed project-memory files include non-candidate files: ${extraChangedFiles.join(', ')}.`
        };
    }
    const updated = changedProjectMemoryFiles
        .filter((file) => affectedSet.has(file))
        .sort();
    const updatedSet = new Set(updated);
    return {
        updated,
        skipped: affected.filter((candidate) => !updatedSet.has(candidate)),
        error: null
    };
}

export function buildProjectMemoryNextStepSummary(
    repoRoot: string,
    evidence: ReturnType<typeof getProjectMemoryImpactLifecycleEvidence>,
    context?: {
        taskId: string;
        preflightPath?: string | null;
    }
): NextStepProjectMemorySummary {
    const currentArtifact = context
        ? assessProjectMemoryImpact({
            repoRoot,
            taskId: context.taskId,
            preflightPath: context.preflightPath
        }).artifact
        : null;
    const commandUpdateSplit = resolveProjectMemoryCommandUpdateSplit(repoRoot, evidence, currentArtifact);
    return {
        enabled: evidence.enabled,
        required: evidence.required,
        mode: evidence.mode,
        evidence_status: evidence.evidence_status,
        status: evidence.status,
        update_needed: currentArtifact?.update_needed ?? evidence.update_needed,
        affected_memory_files: [...(currentArtifact?.affected_memory_files || evidence.affected_memory_files)],
        updated_memory_files: [...(currentArtifact?.update_evidence.updated_memory_files || evidence.updated_memory_files)],
        command_updated_memory_files: commandUpdateSplit.updated,
        command_skipped_memory_files: commandUpdateSplit.skipped,
        command_update_inference_error: commandUpdateSplit.error,
        compact_status: evidence.compact_status,
        compact_refreshed: evidence.compact_refreshed,
        artifact_path: evidence.artifact_path,
        update_artifact_path: evidence.update_artifact_path,
        visible_summary_line: evidence.visible_summary_line
    };
}
