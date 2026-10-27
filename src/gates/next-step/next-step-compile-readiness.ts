import { collectImmutableTimelineEvents as collectOrderedTimelineEvents } from './next-step-timeline-readers';
import * as fs from 'node:fs';
import * as path from 'node:path';


import {
    formatCompileInfraRecoveryHintLine
} from '../compile/compile-infra-recovery-hints';
import {
    normalizeDomainScopeFingerprints
} from '../scope/domain-scope-fingerprints';
import {
    fileSha256,
    normalizePath,
    stringSha256
} from '../shared/helpers';
import {
    safeReadJson
} from '../task-audit/task-audit-summary-collectors';
import {
    getWorkspaceSnapshotCached,
    resolveWorkspaceSnapshotRequest,
    type WorkspaceSnapshotRequest
} from '../workspace/workspace-snapshot-cache';
import {
    buildCompileEvidenceDocsOnlyExtensionReadiness,
    buildDocsOnlyDeltaReadiness,
    getDocImpactDeclaredDocsUpdated,
    readCurrentGitWorkspaceSnapshot
} from '../scope/docs-only-delta-readiness';
import {
    findLatestTimelineEvent
} from './next-step-timeline-readers';
import {
    buildCurrentDomainScopeFingerprints,
    onlyNeutralCloseoutDomainChanged
} from './next-step-readiness-domain-scope';
import { isPlainRecord } from '../../core/records';
import {
    normalizeGitChangeClassificationEvidence
} from '../../core/git-change-classification';

export interface CompileReadiness {
    ready: boolean;
    reason: string;
    recoveryGate?: 'classify-change' | 'enter-task-mode';
}

function requiresProtectedTaskModeRestart(errorText: string): boolean {
    return /^Trusted protected control-plane manifest was already drifted before task start:/iu.test(errorText)
        && errorText.includes('Restart task mode with:')
        && errorText.includes('--orchestrator-work');
}

function protectedCompileFailureWasRecoveredByTaskModeRestart(
    eventsRoot: string,
    taskId: string
): boolean {
    const timelineErrors: string[] = [];
    const timeline = collectOrderedTimelineEvents(path.join(eventsRoot, `${taskId}.jsonl`), timelineErrors);
    if (timelineErrors.length > 0) {
        return false;
    }
    const latestCompileFailure = findLatestTimelineEvent(
        timeline,
        'COMPILE_GATE_FAILED'
    );
    const latestTaskMode = findLatestTimelineEvent(
        timeline,
        'TASK_MODE_ENTERED'
    );
    return !!latestCompileFailure
        && !!latestTaskMode
        && latestTaskMode.sequence > latestCompileFailure.sequence;
}

function sameSortedStringList(left: readonly string[], right: readonly string[]): boolean {
    if (left.length !== right.length) {
        return false;
    }
    const sortedLeft = [...left].sort();
    const sortedRight = [...right].sort();
    return sortedLeft.every((entry, index) => entry === sortedRight[index]);
}

export function readCompileReadiness(
    repoRoot: string,
    reviewsRoot: string,
    eventsRoot: string,
    taskId: string,
    preflightPath: string,
    workspaceSnapshotRequest?: WorkspaceSnapshotRequest
): CompileReadiness {
    const authenticatedWorkspaceSnapshotRequest = workspaceSnapshotRequest
        ? resolveWorkspaceSnapshotRequest(repoRoot, workspaceSnapshotRequest)
        : undefined;
    const compilePath = path.join(reviewsRoot, `${taskId}-compile-gate.json`);
    if (!fileExists(compilePath)) {
        return {
            ready: false,
            reason: `Compile gate evidence missing: ${normalizePath(compilePath)}.`
        };
    }
    const evidence = safeReadJson(compilePath);
    if (!evidence) {
        return {
            ready: false,
            reason: 'Compile gate evidence is invalid JSON; rerun compile-gate.'
        };
    }
    const expectedPreflightHash = fileSha256(preflightPath);
    const evidenceStatus = String(evidence.status || '').trim().toUpperCase();
    const evidenceOutcome = String(evidence.outcome || '').trim().toUpperCase();
    if (evidence.task_id !== taskId) {
        return {
            ready: false,
            reason: `Compile gate evidence belongs to task '${String(evidence.task_id || '')}'.`
        };
    }
    if (String(evidence.event_source || '').trim() !== 'compile-gate') {
        return {
            ready: false,
            reason: 'Compile gate evidence source is invalid; rerun compile-gate.'
        };
    }
    if (evidenceStatus !== 'PASSED' || evidenceOutcome !== 'PASS') {
        const evidenceError = String(evidence.error || '').trim();
        if (requiresProtectedTaskModeRestart(evidenceError)) {
            if (protectedCompileFailureWasRecoveredByTaskModeRestart(eventsRoot, taskId)) {
                return {
                    ready: false,
                    reason:
                        'Protected compile failure predates the latest task-mode restart and is no longer current. ' +
                        'Rerun compile-gate against the refreshed task-mode and preflight cycle.'
                };
            }
            return {
                ready: false,
                reason:
                    'Compile gate requires a protected task-mode restart because the trusted control-plane manifest ' +
                    'was already drifted before task start. Restart task mode with fresh operator confirmation before retrying compile-gate.',
                recoveryGate: 'enter-task-mode'
            };
        }
        if (/\bPreflight scope drift detected\b/i.test(evidenceError)) {
            const staleFailureReason = getStaleCompileScopeDriftFailureReason({
                repoRoot,
                eventsRoot,
                taskId,
                evidence,
                preflightPath,
                expectedPreflightHash
            });
            if (staleFailureReason) {
                return {
                    ready: false,
                    reason: staleFailureReason
                };
            }
            return {
                ready: false,
                reason:
                    `Compile gate failed because the preflight scope is stale. ${evidenceError} ` +
                    'Refresh classify-change for the current scope before rerunning compile-gate.',
                recoveryGate: 'classify-change'
            };
        }
        const infraRecoveryHintLine = formatCompileInfraRecoveryHintLine(evidence.infra_recovery_hint);
        const infraRecoverySuffix = infraRecoveryHintLine
            ? ` ${infraRecoveryHintLine}`
            : '';
        // Retrying cannot help when the configured toolchain is absent; surface the operator action.
        const missingToolchain = /\S+ is required but was not found in PATH\.[\s\S]*?(?= NextStep:|$)/u.exec(evidenceError)?.[0];
        const missingToolchainSuffix = missingToolchain ? ` ${missingToolchain.trim()}` : '';
        return {
            ready: false,
            reason:
                `Compile gate did not pass. Evidence status='${evidenceStatus || 'UNKNOWN'}', ` +
                `outcome='${evidenceOutcome || 'UNKNOWN'}'.${missingToolchainSuffix}${infraRecoverySuffix}`
        };
    }
    const evidencePreflightHash = String(evidence.preflight_hash_sha256 || '').trim().toLowerCase();
    if (!expectedPreflightHash || evidencePreflightHash !== expectedPreflightHash) {
        const preflightEvidence = safeReadJson(preflightPath);
        const docsOnlyExtensionReadiness = isPlainRecord(preflightEvidence)
            ? buildCompileEvidenceDocsOnlyExtensionReadiness(repoRoot, reviewsRoot, taskId, preflightEvidence)
            : null;
        if (docsOnlyExtensionReadiness) {
            return {
                ready: true,
                reason:
                    'Compile gate evidence is current for the implementation/test/config scope after a refreshed docs-only extension preflight. ' +
                    docsOnlyExtensionReadiness.reason
            };
        }
        return {
            ready: false,
            reason: 'Compile gate evidence preflight hash does not match the current preflight; rerun compile-gate.'
        };
    }
    const detectionSource = String(evidence.scope_detection_source || '').trim();
    const changedFiles = Array.isArray(evidence.scope_changed_files)
        ? evidence.scope_changed_files.map((entry) => String(entry || '').trim()).filter(Boolean)
        : [];
    const hasAuthorizedScopeEvidence = evidence.scope_authorized_files != null
        || evidence.scope_authorized_files_count != null
        || evidence.scope_authorized_files_sha256 != null;
    const authorizedFiles = hasAuthorizedScopeEvidence && Array.isArray(evidence.scope_authorized_files)
        ? [...new Set(evidence.scope_authorized_files
            .map((entry) => normalizePath(String(entry || '').trim()))
            .filter(Boolean))].sort()
        : changedFiles;
    if (hasAuthorizedScopeEvidence) {
        const authorizedFilesCount = typeof evidence.scope_authorized_files_count === 'number'
            ? evidence.scope_authorized_files_count
            : Number.NaN;
        const authorizedFilesSha256 = String(evidence.scope_authorized_files_sha256 || '').trim().toLowerCase();
        if (
            !Array.isArray(evidence.scope_authorized_files)
            || !Number.isSafeInteger(authorizedFilesCount)
            || authorizedFilesCount !== authorizedFiles.length
            || !authorizedFilesSha256
            || authorizedFilesSha256 !== stringSha256(authorizedFiles.join('\n'))
        ) {
            return {
                ready: false,
                reason: 'Compile gate authorized scope evidence is invalid; rerun compile-gate.'
            };
        }
    }
    const compileGitClassification = normalizeGitChangeClassificationEvidence(
        evidence.scope_git_change_classification
    );
    if (evidence.scope_git_change_classification != null && !compileGitClassification) {
        return {
            ready: false,
            reason: 'Compile scope canonical Git/EOL classification evidence is invalid; rerun compile-gate.'
        };
    }
    const scopeSha256 = String(evidence.scope_sha256 || '').trim();
    const scopeContentSha256 = String(evidence.scope_content_sha256 || '').trim().toLowerCase();
    const changedFilesSha256 = String(evidence.scope_changed_files_sha256 || '').trim();
    const changedLinesTotal = Number.parseInt(String(evidence.scope_changed_lines_total || 0), 10) || 0;
    const preflightEvidence = safeReadJson(preflightPath);
    const preflightMetrics = isPlainRecord(preflightEvidence?.metrics) ? preflightEvidence.metrics : {};
    const expectedDomainScopeFingerprints = normalizeDomainScopeFingerprints(
        isPlainRecord(evidence.domain_scope_fingerprints)
            ? evidence.domain_scope_fingerprints
            : (isPlainRecord(preflightMetrics.domain_scope_fingerprints) ? preflightMetrics.domain_scope_fingerprints : null)
    );
    if (!detectionSource || !scopeSha256 || !changedFilesSha256) {
        return {
            ready: false,
            reason: 'Compile gate evidence is missing scope snapshot fields; rerun compile-gate.'
        };
    }
    const includeUntracked = evidence.scope_include_untracked == null
        ? true
        : !!evidence.scope_include_untracked;
    const currentScope = authenticatedWorkspaceSnapshotRequest
        ? authenticatedWorkspaceSnapshotRequest.read(detectionSource, includeUntracked, authorizedFiles)
        : getWorkspaceSnapshotCached(
            repoRoot,
            detectionSource,
            includeUntracked,
            authorizedFiles,
            { noCache: true, readOnly: true }
        );
    const currentGitClassification = normalizeGitChangeClassificationEvidence(
        currentScope.git_change_classification
    );
    if (currentScope.git_change_classification != null && !currentGitClassification) {
        return {
            ready: false,
            reason: 'Current workspace canonical Git/EOL classification evidence is invalid; rerun compile-gate.'
        };
    }
    const currentChangedFiles = currentGitClassification
        ? currentGitClassification.effective_changed_files
        : currentScope.changed_files;
    if (
        (compileGitClassification
            && !sameSortedStringList(compileGitClassification.effective_changed_files, changedFiles))
        || (currentGitClassification
            && !sameSortedStringList(currentGitClassification.effective_changed_files, currentScope.changed_files))
    ) {
        return {
            ready: false,
            reason: 'Compile scope canonical Git/EOL classification does not match its scope snapshot; rerun compile-gate.'
        };
    }
    if (
        currentScope.scope_sha256 !== scopeSha256
        || currentScope.changed_files_sha256 !== changedFilesSha256
        || currentScope.changed_lines_total !== changedLinesTotal
    ) {
        const currentDomainScopeFingerprints = expectedDomainScopeFingerprints
            ? buildCurrentDomainScopeFingerprints({
                repoRoot,
                detectionSource,
                includeUntracked: evidence.scope_include_untracked == null ? true : !!evidence.scope_include_untracked,
                changedFiles: currentChangedFiles
            })
            : null;
        if (onlyNeutralCloseoutDomainChanged(expectedDomainScopeFingerprints, currentDomainScopeFingerprints)) {
            return {
                ready: true,
                reason: 'Compile gate evidence is current for implementation, test, docs, and config scope; only neutral closeout evidence changed.'
            };
        }
        const currentGitSnapshot = readCurrentGitWorkspaceSnapshot(
            repoRoot,
            includeUntracked,
            workspaceSnapshotRequest
        );
        const docsOnlyDeltaReadiness = currentGitSnapshot
            ? buildDocsOnlyDeltaReadiness(
                repoRoot,
                currentGitSnapshot.changed_files,
                changedFiles,
                changedLinesTotal,
                includeUntracked,
                detectionSource,
                changedFilesSha256,
                scopeContentSha256,
                getDocImpactDeclaredDocsUpdated(path.join(reviewsRoot, `${taskId}-doc-impact.json`)),
                expectedDomainScopeFingerprints,
                workspaceSnapshotRequest
            )
            : null;
        if (docsOnlyDeltaReadiness) {
            return {
                ready: true,
                reason: `Compile gate evidence is current after accepting ordinary docs-only updates for doc-impact. ${docsOnlyDeltaReadiness.reason}`
            };
        }
        return {
            ready: false,
            reason: 'Workspace changed after compile gate; rerun compile-gate before review preparation.'
        };
    }
    return {
        ready: true,
        reason: 'Compile gate evidence is current.'
    };
}

function normalizeCompileEvidencePath(repoRoot: string, candidatePath: unknown): string {
    const rawPath = String(candidatePath || '').trim();
    if (!rawPath) {
        return '';
    }
    return normalizePath(path.isAbsolute(rawPath)
        ? path.resolve(rawPath)
        : path.resolve(repoRoot, rawPath));
}

function getStaleCompileScopeDriftFailureReason(params: {
    repoRoot: string;
    eventsRoot: string;
    taskId: string;
    evidence: Record<string, unknown>;
    preflightPath: string;
    expectedPreflightHash: string | null;
}): string | null {
    const staleReasons: string[] = [];
    const evidencePreflightHash = String(params.evidence.preflight_hash_sha256 || '').trim().toLowerCase();
    const expectedPreflightHash = String(params.expectedPreflightHash || '').trim().toLowerCase();
    if (evidencePreflightHash && expectedPreflightHash && evidencePreflightHash !== expectedPreflightHash) {
        staleReasons.push('compile failure preflight hash differs from the latest preflight hash');
    }

    const evidencePreflightPath = normalizeCompileEvidencePath(params.repoRoot, params.evidence.preflight_path);
    const currentPreflightPath = normalizePath(path.resolve(params.preflightPath));
    if (evidencePreflightPath && evidencePreflightPath !== currentPreflightPath) {
        staleReasons.push('compile failure preflight path differs from the latest preflight path');
    }

    const timelineErrors: string[] = [];
    const timeline = collectOrderedTimelineEvents(path.join(params.eventsRoot, `${params.taskId}.jsonl`), timelineErrors);
    const latestCompileFailure = findLatestTimelineEvent(
        timeline,
        'COMPILE_GATE_FAILED'
    );
    const latestPreflight = findLatestTimelineEvent(
        timeline,
        'PREFLIGHT_CLASSIFIED'
    );
    if (latestCompileFailure && latestPreflight && latestCompileFailure.sequence < latestPreflight.sequence) {
        staleReasons.push(
            `compile failure seq ${latestCompileFailure.sequence} predates latest preflight seq ${latestPreflight.sequence}`
        );
    }

    if (staleReasons.length === 0) {
        return null;
    }
    return (
        `Compile gate failed because an older preflight scope was stale, but that failed compile evidence is no longer current ` +
        `(${staleReasons.join('; ')}). Rerun compile-gate against the refreshed preflight before continuing.`
    );
}

function fileExists(filePath: string): boolean {
    try {
        return fs.existsSync(filePath);
    } catch {
        return false;
    }
}
