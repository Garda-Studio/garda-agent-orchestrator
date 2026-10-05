import { TASK_QUEUE_FILENAME } from '../../core/orchestration-constants';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildBundleRelativePath } from '../../core/constants';
import { DEFAULT_GIT_TIMEOUT_MS, spawnSyncWithTimeout } from '../../core/subprocess';
import { normalizeGitChangeClassificationEvidence } from '../../core/git-change-classification';
import { readStagedBlobFingerprints } from '../../core/staged-index-fingerprints';
import { getClassificationConfig, isSafeOrdinaryDocumentationPath } from '../preflight/classify-change';
import { buildScopeContentFingerprint } from '../compile/compile-gate';
import {
    getWorkspaceSnapshotCached,
    resolveWorkspaceSnapshotRequest,
    type WorkspaceSnapshotRequest
} from '../workspace/workspace-snapshot-cache';
import {
    detectProtectedDirtyWorkspaceDrift,
    getProtectedDirtyWorkspaceScopeFromPreflight
} from '../workspace/dirty-worktree-protection';
import { stringSha256, toPosix } from '../shared/helpers';
import { canonicalPathList, pathListSha256 } from '../shared/canonical-path-list';
import {
    type BlockerEntry,
    type FinalCloseoutDocsSummary,
    safeReadJson
} from './task-audit-summary-collectors';

const INTERNAL_CHANGELOG_PATH = buildBundleRelativePath('live/docs/changes/CHANGELOG.md');
const PROJECT_MEMORY_ROOT = buildBundleRelativePath('live/docs/project-memory/');
const BUNDLE_RUNTIME_ROOT = buildBundleRelativePath('runtime/');
const BUNDLE_LIVE_ROOT = buildBundleRelativePath('live/');

export interface StagedPostDoneScopeDecision {
    blocked: boolean;
    reason: string;
}

export function buildAuditedChangedFiles(
    repoRoot: string,
    preflightChangedFiles: string[],
    docsSummary: FinalCloseoutDocsSummary
): { changedFiles: string[]; violations: string[] } {
    const changedFiles: string[] = [];
    const seen = new Set<string>();
    const preflightPathSet = new Set(preflightChangedFiles.map((entry) => toPosix(String(entry || '').trim())).filter(Boolean));
    const classificationConfig = getClassificationConfig(repoRoot);
    const violations: string[] = [];
    const appendPath = (value: unknown): void => {
        const normalized = toPosix(String(value || '').trim());
        if (!normalized || seen.has(normalized)) {
            return;
        }
        seen.add(normalized);
        changedFiles.push(normalized);
    };

    for (const changedFile of preflightChangedFiles) {
        appendPath(changedFile);
    }
    if (docsSummary.decision === 'DOCS_UPDATED') {
        for (const docsUpdatedPath of docsSummary.docs_updated) {
            const normalized = toPosix(String(docsUpdatedPath || '').trim());
            if (!normalized || preflightPathSet.has(normalized)) {
                appendPath(normalized);
                continue;
            }
            const isAcceptedDocPath = isSafeOrdinaryDocumentationPath(normalized, classificationConfig);
            if (isAcceptedDocPath) {
                appendPath(normalized);
                continue;
            }
            if (isInternalCloseoutEvidencePath(normalized)) {
                appendPath(normalized);
                continue;
            }
            violations.push(
                `Doc impact docs_updated contains non-documentation path '${normalized}' that is not in preflight changed_files. ` +
                'Refresh preflight for implementation drift or remove the path from docs_updated.'
            );
        }
    }
    return { changedFiles, violations };
}

function isInternalCloseoutEvidencePath(normalizedPath: string): boolean {
    return normalizedPath === INTERNAL_CHANGELOG_PATH
        || normalizedPath.startsWith(PROJECT_MEMORY_ROOT);
}

function readFinalCloseoutImplementationSummary(finalCloseoutJsonPath: string): Record<string, unknown> | null {
    const closeout = safeReadJson(finalCloseoutJsonPath);
    return closeout && typeof closeout.implementation_summary === 'object' && !Array.isArray(closeout.implementation_summary)
        ? closeout.implementation_summary as Record<string, unknown>
        : null;
}

function readFinalCloseoutAuditedScopeProvenance(finalCloseoutJsonPath: string): Record<string, unknown> | null {
    const implementationSummary = readFinalCloseoutImplementationSummary(finalCloseoutJsonPath);
    const provenance = implementationSummary?.audited_scope_provenance;
    return provenance && typeof provenance === 'object' && !Array.isArray(provenance)
        ? provenance as Record<string, unknown>
        : null;
}

function normalizeChangedFiles(value: unknown): string[] {
    if (!Array.isArray(value)) {
        return [];
    }
    return canonicalPathList(value.map((entry) => toPosix(String(entry || '').trim())).filter(Boolean));
}

function isStagedScopeProvenance(provenance: Record<string, unknown> | null): boolean {
    if (!provenance) {
        return false;
    }
    if (provenance.use_staged === true) {
        return true;
    }
    const detectionSource = String(provenance.detection_source || '').trim().toLowerCase();
    return detectionSource === 'git_staged_only' || detectionSource === 'git_staged_plus_untracked';
}

function normalizeOptionalHash(value: unknown): string | null {
    const normalized = String(value || '').trim().toLowerCase();
    return /^[0-9a-f]{64}$/u.test(normalized) ? normalized : null;
}

function changedFilesSha256(changedFiles: string[]): string | null {
    return pathListSha256(changedFiles.map((entry) => toPosix(entry)).filter(Boolean));
}

function readUnstagedChangedFiles(repoRoot: string, auditedFiles: string[]): string[] {
    if (auditedFiles.length === 0) {
        return [];
    }
    const result = spawnSyncWithTimeout('git', [
        '-C',
        String(repoRoot),
        'diff',
        '--name-only',
        '--diff-filter=ACDMRTUXB',
        '--',
        ...auditedFiles
    ], {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeoutMs: DEFAULT_GIT_TIMEOUT_MS,
        maxBuffer: 10 * 1024 * 1024
    });
    if (result.status !== 0 || result.timedOut || result.error) {
        const reason = result.timedOut
            ? `git diff timed out after ${DEFAULT_GIT_TIMEOUT_MS}ms`
            : result.error
                ? String(result.error)
                : String(result.stderr || result.stdout || `exit status ${result.status}`).trim();
        throw new Error(reason);
    }
    return canonicalPathList(String(result.stdout || '')
        .split(/\r?\n/u)
        .map((entry) => toPosix(entry.trim()))
        .filter(Boolean));
}

function evaluateCloseoutExtraScope(options: {
    repoRoot: string;
    provenance: Record<string, unknown> | null;
    workspaceSnapshotRequest?: WorkspaceSnapshotRequest;
}): StagedPostDoneScopeDecision | null {
    const authenticatedWorkspaceSnapshotRequest = options.workspaceSnapshotRequest
        ? resolveWorkspaceSnapshotRequest(options.repoRoot, options.workspaceSnapshotRequest)
        : undefined;
    const extraScope = options.provenance?.closeout_extra_scope;
    if (!extraScope || typeof extraScope !== 'object' || Array.isArray(extraScope)) {
        return null;
    }
    const extraRecord = extraScope as Record<string, unknown>;
    const extraFiles = normalizeChangedFiles(extraRecord.changed_files);
    if (extraFiles.length === 0) {
        return null;
    }
    const expectedChangedFilesSha256 = normalizeOptionalHash(extraRecord.changed_files_sha256);
    const expectedScopeContentSha256 = normalizeOptionalHash(extraRecord.scope_content_sha256);
    if (!expectedChangedFilesSha256 || !expectedScopeContentSha256) {
        return { blocked: true, reason: 'Audited closeout extra scope is missing valid list or content hashes.' };
    }

    let currentExtraSnapshot: PostDoneAuditedScopeFingerprint;
    try {
        currentExtraSnapshot = readPostDoneAuditedScopeFingerprint(
            options.repoRoot, extraFiles, extraRecord, authenticatedWorkspaceSnapshotRequest
        );
    } catch (error) {
        return {
            blocked: true,
            reason:
                'Unable to inspect audited post-DONE closeout extra scope: ' +
                `${error instanceof Error ? error.message : String(error)}. ` +
                'Do not report final closeout as ready until workspace drift can be inspected or the task is explicitly reopened/reset.'
        };
    }

    const violations = [
        expectedChangedFilesSha256 && currentExtraSnapshot.changed_files_sha256 !== expectedChangedFilesSha256
            ? 'closeout extra changed_files_sha256 differs from materialized final closeout'
            : '',
        expectedScopeContentSha256 && currentExtraSnapshot.scope_content_sha256 !== expectedScopeContentSha256
            ? 'closeout extra scope_content_sha256 differs from materialized final closeout'
            : ''
    ].filter(Boolean);
    if (violations.length === 0) {
        return { blocked: false, reason: 'Audited closeout extra scope still matches after DONE.' };
    }
    return {
        blocked: true,
        reason:
            'Tracked post-DONE workspace drift changed audited closeout extra scope: ' +
            `${extraFiles.join(', ')} (${violations.join('; ')}). ` +
            'Do not reopen classify, compile, review, full-suite, or completion gates automatically; isolate or explicitly reopen/reset the task before continuing.'
    };
}

function isAuthenticatedHistoricalStagedHeader(options: {
    implementationSummary: Record<string, unknown> | null;
    implementationFiles: string[];
    auditedFiles: string[];
    preflight?: Record<string, unknown> | null;
}): boolean {
    const metrics = options.preflight?.metrics;
    if (!metrics || typeof metrics !== 'object' || Array.isArray(metrics)) return false;
    const preflightMetrics = metrics as Record<string, unknown>;
    const preflightFiles = normalizeChangedFiles(options.preflight?.changed_files);
    const recordedFiles = normalizeChangedFiles(options.implementationSummary?.changed_files);
    const implementationHash = changedFilesSha256(options.implementationFiles);
    // Earlier staged headers bind the reviewed index subset; extras have their own full hashes.
    return Array.isArray(options.implementationSummary?.changed_files)
        && recordedFiles.length === options.auditedFiles.length
        && recordedFiles.every((entry, index) => entry === options.auditedFiles[index])
        && preflightFiles.length === options.implementationFiles.length
        && preflightFiles.every((entry, index) => entry === options.implementationFiles[index])
        && normalizeOptionalHash(options.implementationSummary?.changed_files_sha256) === implementationHash
        && normalizeOptionalHash(preflightMetrics.changed_files_sha256) === implementationHash
        && normalizeOptionalHash(options.implementationSummary?.scope_content_sha256)
            === normalizeOptionalHash(preflightMetrics.scope_content_sha256);
}

function readHistoricalStagedContentFingerprint(options: {
    repoRoot: string;
    detectionSource: string;
    implementationFiles: string[];
    expectedContentSha256: string;
    preflight?: Record<string, unknown> | null;
}): string | null {
    if (options.detectionSource !== 'git_staged_plus_untracked') {
        return buildScopeContentFingerprint(options.repoRoot, options.detectionSource, options.implementationFiles);
    }
    const classification = normalizeGitChangeClassificationEvidence(options.preflight?.git_change_classification);
    const metrics = options.preflight?.metrics as Record<string, unknown> | undefined;
    if (!classification || options.preflight?.detection_source !== options.detectionSource
        || normalizeOptionalHash(metrics?.changed_files_sha256) !== changedFilesSha256(options.implementationFiles)
        || normalizeOptionalHash(metrics?.scope_content_sha256) !== options.expectedContentSha256) return null;
    const untrackedFiles = normalizeChangedFiles(classification.untracked_files);
    const stagedFiles = normalizeChangedFiles(classification.staged_files);
    const originalFiles = canonicalPathList([...stagedFiles, ...untrackedFiles]);
    if (stagedFiles.length + untrackedFiles.length !== originalFiles.length
        || changedFilesSha256(originalFiles) !== changedFilesSha256(options.implementationFiles)
        || changedFilesSha256(normalizeChangedFiles(classification.effective_changed_files))
            !== changedFilesSha256(options.implementationFiles)) return null;
    // Keep the original worktree representation after formerly untracked files enter the index.
    return buildScopeContentFingerprint(options.repoRoot, options.detectionSource, options.implementationFiles,
        readStagedBlobFingerprints(options.repoRoot, stagedFiles));
}

export function evaluateStagedPostDoneAuditedScope(options: {
    repoRoot: string;
    auditedFiles: string[];
    currentChangedFiles: string[];
    finalCloseoutJsonPath: string;
    preflight?: Record<string, unknown> | null;
    workspaceSnapshotRequest?: WorkspaceSnapshotRequest;
}): StagedPostDoneScopeDecision | null {
    const authenticatedWorkspaceSnapshotRequest = options.workspaceSnapshotRequest
        ? resolveWorkspaceSnapshotRequest(options.repoRoot, options.workspaceSnapshotRequest)
        : undefined;
    const provenance = readFinalCloseoutAuditedScopeProvenance(options.finalCloseoutJsonPath);
    if (!isStagedScopeProvenance(provenance)) {
        return null;
    }

    const implementationFiles = normalizeChangedFiles(provenance?.changed_files);
    const implementationSet = new Set(implementationFiles);
    const currentImplementationFiles = canonicalPathList(options.currentChangedFiles
        .map((entry) => toPosix(entry))
        .filter((entry) => implementationSet.has(entry)));
    const expectedChangedFilesSha256 = normalizeOptionalHash(provenance?.changed_files_sha256);
    const expectedScopeContentSha256 = normalizeOptionalHash(provenance?.scope_content_sha256);
    const implementationSummary = readFinalCloseoutImplementationSummary(options.finalCloseoutJsonPath);
    const actualImplementationFilesSha256 = changedFilesSha256(implementationFiles);
    const extraScope = provenance?.closeout_extra_scope;
    const extraFiles = extraScope && typeof extraScope === 'object' && !Array.isArray(extraScope)
        ? normalizeChangedFiles((extraScope as Record<string, unknown>).changed_files)
        : [];
    const combinedFiles = canonicalPathList([...implementationFiles, ...extraFiles]);
    const auditedFiles = normalizeChangedFiles(options.auditedFiles);
    if (!expectedChangedFilesSha256 || !expectedScopeContentSha256
        || normalizeOptionalHash(implementationSummary?.scope_content_sha256) !== expectedScopeContentSha256
        || actualImplementationFilesSha256 !== expectedChangedFilesSha256
        || combinedFiles.length !== auditedFiles.length
        || !combinedFiles.every((entry, index) => entry === auditedFiles[index])) {
        return {
            blocked: true,
            reason:
                'Tracked post-DONE workspace drift changed audited staged scope file identity: ' +
                `${implementationFiles.join(', ')}. ` +
                'Do not reopen classify, compile, review, full-suite, or completion gates automatically; isolate or explicitly reopen/reset the task before continuing.'
        };
    }

    let unstagedChangedFiles: string[];
    try {
        unstagedChangedFiles = readUnstagedChangedFiles(options.repoRoot, implementationFiles);
    } catch (error) {
        return {
            blocked: true,
            reason:
                'Unable to inspect audited post-DONE staged scope drift for the completed task closeout: ' +
                `${error instanceof Error ? error.message : String(error)}. ` +
                'Do not report final closeout as ready until workspace drift can be inspected or the task is explicitly reopened/reset.'
        };
    }
    if (unstagedChangedFiles.length > 0) {
        return {
            blocked: true,
            reason:
                'Tracked post-DONE workspace drift changed audited staged implementation content: ' +
                `${unstagedChangedFiles.join(', ')}. ` +
                'Do not reopen classify, compile, review, full-suite, or completion gates automatically; isolate or explicitly reopen/reset the task before continuing.'
        };
    }
    const extraScopeDecision = evaluateCloseoutExtraScope({
        repoRoot: options.repoRoot,
        provenance,
        workspaceSnapshotRequest: authenticatedWorkspaceSnapshotRequest
    });
    if (extraScopeDecision?.blocked) {
        return extraScopeDecision;
    }

    const detectionSource = String(provenance?.detection_source || 'git_staged_only').trim().toLowerCase() || 'git_staged_only';
    const hasWorktreeBinding = implementationSummary?.worktree_scope_content_sha256 !== undefined;
    const historicalHeaderIsAuthenticated = !hasWorktreeBinding && isAuthenticatedHistoricalStagedHeader({
        implementationSummary, implementationFiles, auditedFiles, preflight: options.preflight
    });
    const expectedWorktreeContentSha256 = normalizeOptionalHash(implementationSummary?.worktree_scope_content_sha256);
    let currentAuditedScope: PostDoneAuditedScopeFingerprint;
    let historicalIndexContentSha256: string | null;
    try {
        currentAuditedScope = readPostDoneAuditedScopeFingerprint(
            options.repoRoot, auditedFiles, implementationSummary, authenticatedWorkspaceSnapshotRequest
        );
        historicalIndexContentSha256 = hasWorktreeBinding ? null : readHistoricalStagedContentFingerprint({
            repoRoot: options.repoRoot, detectionSource, implementationFiles,
            expectedContentSha256: expectedScopeContentSha256, preflight: options.preflight
        });
    } catch (error) {
        return {
            blocked: true,
            reason: 'Unable to authenticate complete audited post-DONE staged scope: ' +
                `${error instanceof Error ? error.message : String(error)}.`
        };
    }
    if ((!currentAuditedScope.changed_files_sha256
        || currentAuditedScope.changed_files_sha256 !== normalizeOptionalHash(implementationSummary?.changed_files_sha256))
            && !historicalHeaderIsAuthenticated
        || (hasWorktreeBinding && (!expectedWorktreeContentSha256
            || currentAuditedScope.scope_content_sha256 !== expectedWorktreeContentSha256))) {
        return {
            blocked: true,
            reason: 'Tracked post-DONE workspace drift changed complete audited staged scope list or content hashes: ' +
                `${auditedFiles.join(', ')}.`
        };
    }
    const includeUntracked = typeof provenance?.include_untracked === 'boolean'
        ? provenance.include_untracked
        : detectionSource !== 'git_staged_only';
    let stagedSnapshot: ReturnType<typeof getWorkspaceSnapshotCached>;
    try {
        stagedSnapshot = authenticatedWorkspaceSnapshotRequest
            ? authenticatedWorkspaceSnapshotRequest.read(detectionSource, includeUntracked, [])
            : getWorkspaceSnapshotCached(options.repoRoot, detectionSource, includeUntracked, [], {
                noCache: true,
                readOnly: true
            });
    } catch (error) {
        return {
            blocked: true,
            reason:
                'Unable to inspect audited post-DONE staged scope for the completed task closeout: ' +
                `${error instanceof Error ? error.message : String(error)}. ` +
                'Do not report final closeout as ready until workspace drift can be inspected or the task is explicitly reopened/reset.'
        };
    }

    if (stagedSnapshot.changed_files.length === 0) {
        if (currentImplementationFiles.length === 0) {
            return {
                blocked: !hasWorktreeBinding && historicalIndexContentSha256 !== expectedScopeContentSha256,
                reason: !hasWorktreeBinding && historicalIndexContentSha256 !== expectedScopeContentSha256
                    ? 'Tracked post-DONE workspace drift changed historical audited staged index content.'
                    : extraScopeDecision?.reason || 'Audited staged scope has been committed unchanged after DONE.'
            };
        }
        return {
            blocked: true,
            reason:
                'Tracked post-DONE workspace drift changed audited staged implementation content: ' +
                `${implementationFiles.join(', ')}. ` +
                'Do not reopen classify, compile, review, full-suite, or completion gates automatically; isolate or explicitly reopen/reset the task before continuing.'
        };
    }

    const stagedChangedFilesSha256 = normalizeOptionalHash(stagedSnapshot.changed_files_sha256);
    const stagedScopeContentSha256 = normalizeOptionalHash(stagedSnapshot.scope_content_sha256);
    const stagedViolations = [
        expectedChangedFilesSha256 && stagedChangedFilesSha256 !== expectedChangedFilesSha256
            ? 'staged changed_files_sha256 differs from completed preflight'
            : '',
        expectedScopeContentSha256 && stagedScopeContentSha256 !== expectedScopeContentSha256
            ? 'staged scope_content_sha256 differs from completed preflight'
            : ''
    ].filter(Boolean);
    if (stagedViolations.length > 0) {
        return {
            blocked: true,
            reason:
                'Tracked post-DONE workspace drift changed audited staged implementation content: ' +
                `${implementationFiles.join(', ')} (${stagedViolations.join('; ')}). ` +
                'Do not reopen classify, compile, review, full-suite, or completion gates automatically; isolate or explicitly reopen/reset the task before continuing.'
        };
    }

    return {
        blocked: false,
        reason: extraScopeDecision?.reason || 'Audited staged scope still matches the completed preflight after DONE.'
    };
}

export function buildPostDoneWorkspaceDriftBlocker(
    repoRoot: string,
    auditedChangedFiles: string[],
    preflightChangedFiles: string[],
    preflight: Record<string, unknown> | null,
    finalCloseoutJsonPath: string,
    workspaceSnapshotRequest?: WorkspaceSnapshotRequest
): BlockerEntry | null {
    const authenticatedWorkspaceSnapshotRequest = workspaceSnapshotRequest
        ? resolveWorkspaceSnapshotRequest(repoRoot, workspaceSnapshotRequest)
        : undefined;
    let currentChangedFiles: string[];
    try {
        currentChangedFiles = (authenticatedWorkspaceSnapshotRequest
            ? authenticatedWorkspaceSnapshotRequest.read('git_auto', true, [])
            : getWorkspaceSnapshotCached(repoRoot, 'git_auto', true, [], {
                noCache: true,
                readOnly: true
            })).changed_files.map((entry) => toPosix(entry)).filter(Boolean);
    } catch (error) {
        const gitMetadataPath = path.join(repoRoot, '.git');
        if (!fs.existsSync(gitMetadataPath)) {
            return null;
        }
        return {
            gate: 'post-done-drift',
            reason:
                'Unable to inspect tracked post-DONE workspace drift for the completed task closeout: ' +
                `${error instanceof Error ? error.message : String(error)}. ` +
                'Do not report final closeout as ready until workspace drift can be inspected or the task is explicitly reopened/reset.'
        };
    }
    const auditedSet = new Set(auditedChangedFiles.map((entry) => toPosix(entry)).filter(Boolean));
    const unexpectedWorkspace = getUnexpectedPostDoneWorkspaceFiles(
        repoRoot,
        currentChangedFiles,
        [...auditedSet],
        preflight
    );
    if (unexpectedWorkspace.protectedBaselineIntegrityError || unexpectedWorkspace.unexpectedFiles.length > 0) {
        const details = unexpectedWorkspace.protectedBaselineIntegrityError
            ? 'Dirty workspace protected-baseline authentication failed' + (
                unexpectedWorkspace.unexpectedFiles.length > 0
                    ? ` for: ${unexpectedWorkspace.unexpectedFiles.join(', ')}.`
                    : '.'
            )
            : `${unexpectedWorkspace.unexpectedFiles.join(', ')}.`;
        return {
            gate: 'post-done-drift',
            reason:
                'Post-DONE workspace drift exists outside the completed task closeout scope: ' +
                `${details} ` +
                'Do not reopen classify, compile, review, full-suite, or completion gates automatically; isolate or explicitly reopen/reset the task before continuing.'
        };
    }
    const stagedScopeDecision = evaluateStagedPostDoneAuditedScope({
        repoRoot,
        auditedFiles: canonicalPathList([...auditedSet]),
        currentChangedFiles,
        finalCloseoutJsonPath,
        preflight,
        workspaceSnapshotRequest: authenticatedWorkspaceSnapshotRequest
    });
    if (stagedScopeDecision) {
        return stagedScopeDecision.blocked
            ? { gate: 'post-done-drift', reason: stagedScopeDecision.reason }
            : null;
    }
    const auditedScopeBlocker = buildPostDoneAuditedScopeDriftBlocker(
        repoRoot,
        canonicalPathList([...auditedSet]),
        finalCloseoutJsonPath,
        authenticatedWorkspaceSnapshotRequest
    );
    if (auditedScopeBlocker) {
        return auditedScopeBlocker;
    }
    if (currentChangedFiles.length === 0) {
        return null;
    }
    return buildPostDoneSameScopeDriftBlocker(
        repoRoot,
        auditedChangedFiles,
        preflightChangedFiles,
        preflight,
        finalCloseoutJsonPath,
        authenticatedWorkspaceSnapshotRequest
    );
}

export interface PostDoneUnexpectedWorkspaceResult {
    unexpectedFiles: string[];
    protectedBaselineIntegrityError: boolean;
}

export interface PostDoneAuditedScopeFingerprint {
    changed_files: string[];
    changed_files_sha256: string | null;
    scope_content_sha256: string | null;
}

export function buildPostDoneAuditedScopeFingerprint(
    repoRoot: string,
    auditedFiles: string[],
    workspaceSnapshotRequest?: WorkspaceSnapshotRequest
): PostDoneAuditedScopeFingerprint {
    if (workspaceSnapshotRequest) {
        resolveWorkspaceSnapshotRequest(repoRoot, workspaceSnapshotRequest);
    }
    const changedFiles = canonicalPathList(auditedFiles.map((entry) => toPosix(entry)).filter(Boolean));
    return {
        changed_files: changedFiles,
        changed_files_sha256: pathListSha256(changedFiles),
        scope_content_sha256: buildScopeContentFingerprint(repoRoot, 'explicit_changed_files', changedFiles)
    };
}

export function readPostDoneAuditedScopeFingerprint(
    repoRoot: string,
    auditedFiles: string[],
    implementationSummary: Record<string, unknown> | null,
    workspaceSnapshotRequest?: WorkspaceSnapshotRequest
): PostDoneAuditedScopeFingerprint {
    const authenticatedWorkspaceSnapshotRequest = workspaceSnapshotRequest
        ? resolveWorkspaceSnapshotRequest(repoRoot, workspaceSnapshotRequest)
        : undefined;
    const normalizedAuditedFiles = normalizeChangedFiles(auditedFiles);
    const recordedList = implementationSummary?.changed_files;
    // Historical closeouts may omit the list, but its hash must authenticate the complete audited scope.
    const recordedChangedFiles = recordedList === undefined
        ? normalizedAuditedFiles
        : normalizeChangedFiles(recordedList);
    const recordedChangedFilesSha256 = normalizeOptionalHash(implementationSummary?.changed_files_sha256);
    const recordedFileListIsAuthenticated = (recordedList === undefined || Array.isArray(recordedList))
        && !!recordedChangedFilesSha256
        && recordedChangedFilesSha256 === changedFilesSha256(recordedChangedFiles)
        && recordedChangedFiles.length === normalizedAuditedFiles.length
        && recordedChangedFiles.every((entry, index) => entry === normalizedAuditedFiles[index]);
    if (recordedFileListIsAuthenticated) {
        return buildPostDoneAuditedScopeFingerprint(
            repoRoot,
            normalizedAuditedFiles,
            authenticatedWorkspaceSnapshotRequest
        );
    }
    // Failed authentication must not fall back to the smaller Git diff remaining after a commit.
    return {
        changed_files: normalizedAuditedFiles,
        changed_files_sha256: null,
        scope_content_sha256: null
    };
}

export function getUnexpectedPostDoneWorkspaceFiles(
    repoRoot: string,
    currentChangedFiles: string[],
    auditedChangedFiles: string[],
    preflight: Record<string, unknown> | null
): PostDoneUnexpectedWorkspaceResult {
    const auditedSet = new Set(auditedChangedFiles.map((entry) => toPosix(entry)).filter(Boolean));
    const triggers = preflight?.triggers && typeof preflight.triggers === 'object' && !Array.isArray(preflight.triggers)
        ? preflight.triggers as Record<string, unknown>
        : null;
    const unchangedProtectedFiles = new Set<string>();
    const changedProtectedFiles = new Set<string>();
    let protectedBaselineIntegrityError = false;
    if (String(triggers?.dirty_workspace_protection_status || '').trim().toUpperCase() === 'PASS') {
        const protection = detectProtectedDirtyWorkspaceDrift(
            repoRoot,
            getProtectedDirtyWorkspaceScopeFromPreflight(preflight)
        );
        const recordedProtectedFilesSha256 = normalizeOptionalHash(triggers?.dirty_workspace_protected_files_sha256);
        const currentProtectedFilesSha256 = stringSha256(protection.protected_files.join('\n'));
        if (
            !recordedProtectedFilesSha256
            || recordedProtectedFilesSha256 !== currentProtectedFilesSha256
        ) {
            protectedBaselineIntegrityError = true;
            for (const protectedFile of protection.protected_files) {
                changedProtectedFiles.add(protectedFile);
            }
        } else {
            for (const protectedFile of protection.protected_files) {
                const baselineHash = normalizeOptionalHash(protection.baseline_file_hashes[protectedFile]);
                const currentHash = normalizeOptionalHash(protection.current_file_hashes[protectedFile]);
                if (baselineHash && currentHash === baselineHash) {
                    unchangedProtectedFiles.add(protectedFile);
                } else {
                    changedProtectedFiles.add(protectedFile);
                }
            }
        }
    }
    return {
        unexpectedFiles: canonicalPathList([...currentChangedFiles, ...changedProtectedFiles]
            .map((entry) => toPosix(entry))
            .filter((entry) => entry && !auditedSet.has(entry) && !unchangedProtectedFiles.has(entry))),
        protectedBaselineIntegrityError
    };
}

function buildPostDoneSameScopeDriftBlocker(
    repoRoot: string,
    auditedChangedFiles: string[],
    preflightChangedFiles: string[],
    preflight: Record<string, unknown> | null,
    finalCloseoutJsonPath: string,
    workspaceSnapshotRequest?: WorkspaceSnapshotRequest
): BlockerEntry | null {
    const authenticatedWorkspaceSnapshotRequest = workspaceSnapshotRequest
        ? resolveWorkspaceSnapshotRequest(repoRoot, workspaceSnapshotRequest)
        : undefined;
    const implementationFiles = canonicalPathList(preflightChangedFiles.map((entry) => toPosix(entry)).filter(Boolean));
    const auditedFiles = canonicalPathList(auditedChangedFiles.map((entry) => toPosix(entry)).filter(Boolean));
    if (implementationFiles.length === 0) {
        return buildPostDoneAuditedScopeDriftBlocker(
            repoRoot,
            auditedFiles,
            finalCloseoutJsonPath,
            authenticatedWorkspaceSnapshotRequest
        );
    }
    if (!preflight || typeof preflight !== 'object') {
        return null;
    }
    const metrics = preflight.metrics && typeof preflight.metrics === 'object'
        ? preflight.metrics as Record<string, unknown>
        : null;
    const expectedScopeContentSha256 = typeof metrics?.scope_content_sha256 === 'string'
        ? metrics.scope_content_sha256.trim().toLowerCase()
        : '';
    const expectedChangedLinesTotal = typeof metrics?.changed_lines_total === 'number'
        ? metrics.changed_lines_total
        : Number(metrics?.changed_lines_total);
    if (!expectedScopeContentSha256 && !Number.isFinite(expectedChangedLinesTotal)) {
        return null;
    }

    let currentImplementationSnapshot: ReturnType<typeof getWorkspaceSnapshotCached>;
    let currentScopeContentSha256: string;
    try {
        currentImplementationSnapshot = authenticatedWorkspaceSnapshotRequest
            ? authenticatedWorkspaceSnapshotRequest.read('explicit_changed_files', true, implementationFiles)
            : getWorkspaceSnapshotCached(repoRoot, 'explicit_changed_files', true, implementationFiles, {
                noCache: true,
                readOnly: true
            });
        // Committed audited files can disappear from the Git diff while protected parent WIP remains.
        currentScopeContentSha256 = buildScopeContentFingerprint(
            repoRoot, 'explicit_changed_files', implementationFiles
        ) || '';
    } catch (error) {
        const gitMetadataPath = path.join(repoRoot, '.git');
        if (!fs.existsSync(gitMetadataPath)) {
            return null;
        }
        return {
            gate: 'post-done-drift',
            reason:
                'Unable to inspect audited post-DONE implementation content for the completed task closeout: ' +
                `${error instanceof Error ? error.message : String(error)}. ` +
                'Do not report final closeout as ready until workspace drift can be inspected or the task is explicitly reopened/reset.'
        };
    }

    const contentChanged = !!expectedScopeContentSha256
        && currentScopeContentSha256 !== expectedScopeContentSha256;
    // Staging can change Git diff statistics while the selected file content is unchanged.
    const lineCountChanged = !expectedScopeContentSha256 && Number.isFinite(expectedChangedLinesTotal)
        && currentImplementationSnapshot.changed_lines_total !== expectedChangedLinesTotal;
    if (!contentChanged && !lineCountChanged) {
        return buildPostDoneAuditedScopeDriftBlocker(
            repoRoot,
            auditedFiles,
            finalCloseoutJsonPath,
            authenticatedWorkspaceSnapshotRequest
        );
    }

    const details = [
        contentChanged ? 'scope_content_sha256 differs from completed preflight' : '',
        lineCountChanged ? `changed_lines_total ${currentImplementationSnapshot.changed_lines_total} differs from completed preflight ${expectedChangedLinesTotal}` : ''
    ].filter(Boolean).join('; ');
    return {
        gate: 'post-done-drift',
        reason:
            'Tracked post-DONE workspace drift changed audited implementation content: ' +
            `${implementationFiles.join(', ')} (${details}). ` +
            'Do not reopen classify, compile, review, full-suite, or completion gates automatically; isolate or explicitly reopen/reset the task before continuing.'
    };
}

function buildPostDoneAuditedScopeDriftBlocker(
    repoRoot: string,
    auditedFiles: string[],
    finalCloseoutJsonPath: string,
    workspaceSnapshotRequest?: WorkspaceSnapshotRequest
): BlockerEntry | null {
    const authenticatedWorkspaceSnapshotRequest = workspaceSnapshotRequest
        ? resolveWorkspaceSnapshotRequest(repoRoot, workspaceSnapshotRequest)
        : undefined;
    if (auditedFiles.length === 0) {
        return null;
    }
    const implementationSummary = readFinalCloseoutImplementationSummary(finalCloseoutJsonPath);
    const expectedScopeContentSha256 = normalizeOptionalHash(implementationSummary?.scope_content_sha256);
    const expectedChangedFilesSha256 = normalizeOptionalHash(implementationSummary?.changed_files_sha256);
    if (!expectedScopeContentSha256 || !expectedChangedFilesSha256) {
        return {
            gate: 'post-done-drift',
            reason:
                'Materialized final closeout is missing valid audited scope hashes for post-DONE authentication: ' +
                `${auditedFiles.join(', ')}. ` +
                'Both changed_files_sha256 and scope_content_sha256 must be valid SHA-256 values before committed scope can remain complete.'
        };
    }

    let currentAuditedSnapshot: PostDoneAuditedScopeFingerprint;
    try {
        currentAuditedSnapshot = readPostDoneAuditedScopeFingerprint(
            repoRoot,
            auditedFiles,
            implementationSummary,
            authenticatedWorkspaceSnapshotRequest
        );
    } catch (error) {
        const gitMetadataPath = path.join(repoRoot, '.git');
        if (!fs.existsSync(gitMetadataPath)) {
            return null;
        }
        return {
            gate: 'post-done-drift',
            reason:
                'Unable to inspect audited post-DONE closeout content: ' +
                `${error instanceof Error ? error.message : String(error)}. ` +
                'Do not report final closeout as ready until workspace drift can be inspected or the task is explicitly reopened/reset.'
        };
    }

    const contentChanged = currentAuditedSnapshot.scope_content_sha256 !== expectedScopeContentSha256;
    const fileSetChanged = currentAuditedSnapshot.changed_files_sha256 !== expectedChangedFilesSha256;
    if (!contentChanged && !fileSetChanged) {
        return null;
    }

    const details = [
        contentChanged ? 'audited scope_content_sha256 differs from materialized final closeout' : '',
        fileSetChanged ? 'audited changed_files_sha256 differs from materialized final closeout' : ''
    ].filter(Boolean).join('; ');
    return {
        gate: 'post-done-drift',
        reason:
            'Tracked post-DONE workspace drift changed audited closeout content: ' +
            `${auditedFiles.join(', ')} (${details}). ` +
            'Do not reopen classify, compile, review, full-suite, or completion gates automatically; isolate or explicitly reopen/reset the task before continuing.'
    };
}


export function isLocalControlPlaneCommitPath(filePath: string): boolean {
    const normalized = toPosix(String(filePath || '').trim()).replace(/^\.\//, '');
    if (!normalized) {
        return false;
    }
    return normalized === TASK_QUEUE_FILENAME
        || normalized.startsWith(BUNDLE_RUNTIME_ROOT)
        || normalized.startsWith(BUNDLE_LIVE_ROOT)
        || normalized === INTERNAL_CHANGELOG_PATH;
}

export function resolveCommittableChangedFiles(
    repoRoot: string,
    workspaceSnapshotRequest?: WorkspaceSnapshotRequest
): string[] | null {
    const authenticatedWorkspaceSnapshotRequest = workspaceSnapshotRequest
        ? resolveWorkspaceSnapshotRequest(repoRoot, workspaceSnapshotRequest)
        : undefined;
    try {
        const currentWorkspaceSnapshot = authenticatedWorkspaceSnapshotRequest
            ? authenticatedWorkspaceSnapshotRequest.read('git_auto', true, [])
            : getWorkspaceSnapshotCached(repoRoot, 'git_auto', true, [], {
                noCache: true,
                readOnly: true
            });
        const changedFiles = Array.isArray(currentWorkspaceSnapshot.changed_files)
            ? currentWorkspaceSnapshot.changed_files
            : [];
        return changedFiles
            .map((changedFile) => toPosix(String(changedFile || '').trim()))
            .filter((changedFile) => changedFile && !isLocalControlPlaneCommitPath(changedFile))
            .sort((left, right) => left.localeCompare(right));
    } catch {
        return null;
    }
}
