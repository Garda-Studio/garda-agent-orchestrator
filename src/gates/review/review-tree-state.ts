import { DEFAULT_GIT_TIMEOUT_MS, spawnSyncWithTimeout } from '../../core/subprocess';
import { getWorkspaceSnapshot } from '../compile/compile-gate';
import { isSplitCheckpointDetectionSource } from '../split-required/split-checkpoint-scope';
import {
    buildDomainScopeFingerprints,
    normalizeDomainScopeFingerprints,
    reviewLaneScopeSha256Matches,
    type DomainScopeFingerprints
} from '../scope/domain-scope-fingerprints';
import { normalizePath, stringSha256 } from '../shared/helpers';
import { getSafeWorktreePathState } from '../workspace/worktree-path-state';
import { isPlainRecord } from '../../core/records';
import { getClassificationConfig } from '../preflight/classify-change';
import { validateReviewTriggerPolicy, type ReviewTriggerPolicy } from '../../policy/review-trigger-policy';

const STAGED_DETECTION_SOURCES = new Set(['git_staged_only', 'git_staged_plus_untracked']);

type WorkspaceSnapshot = ReturnType<typeof getWorkspaceSnapshot>;

export interface ReviewTreeStateFreshnessCache {
    currentScopeSnapshots: Map<string, WorkspaceSnapshot>;
    currentTreeStates: Map<string, ReviewTreeState>;
}

export function createReviewTreeStateFreshnessCache(): ReviewTreeStateFreshnessCache {
    return {
        currentScopeSnapshots: new Map<string, WorkspaceSnapshot>(),
        currentTreeStates: new Map<string, ReviewTreeState>()
    };
}

export interface ReviewTreeStateEntry {
    path: string;
    index_status: string;
    worktree_status: string;
    has_staged_change: boolean;
    has_unstaged_change: boolean;
    stale_staged_snapshot_risk: boolean;
    staged: Record<string, unknown> | null;
    worktree: Record<string, unknown>;
}

export interface ReviewTreeState {
    schema_version: 1;
    detection_source: string;
    use_staged: boolean;
    include_untracked: boolean;
    changed_files: string[];
    changed_files_sha256: string | null;
    scope_content_sha256: string | null;
    scope_sha256: string | null;
    domain_scope_fingerprints?: DomainScopeFingerprints | null;
    review_trigger_policy?: ReviewTriggerPolicy;
    entries: ReviewTreeStateEntry[];
    stale_staged_snapshot_files: string[];
    mixed_staged_worktree_files: string[];
    tree_state_sha256: string;
}

interface GitStatusEntry {
    indexStatus: string;
    worktreeStatus: string;
}

function toLiteralPathspecs(changedFiles: string[]): string[] {
    return changedFiles.map((changedFile) => `:(literal)${changedFile}`);
}

function mergeStatusEntry(existing: GitStatusEntry | undefined, next: GitStatusEntry): GitStatusEntry {
    if (!existing) {
        return next;
    }
    const nextIsUntracked = next.indexStatus === '?' && next.worktreeStatus === '?';
    const existingIndexChanged = isChangedStatus(existing.indexStatus) && existing.indexStatus !== '?';
    const nextIndexChanged = isChangedStatus(next.indexStatus) && next.indexStatus !== '?';
    return {
        indexStatus: existingIndexChanged
            ? existing.indexStatus
            : nextIndexChanged
                ? next.indexStatus
                : nextIsUntracked
                    ? existing.indexStatus
                    : (existing.indexStatus || next.indexStatus || ' '),
        worktreeStatus: nextIsUntracked
            ? '?'
            : isChangedStatus(existing.worktreeStatus)
                ? existing.worktreeStatus
                : isChangedStatus(next.worktreeStatus)
                    ? next.worktreeStatus
                    : ' '
    };
}

function runGitText(repoRoot: string, args: string[], maxBuffer = 10 * 1024 * 1024): string {
    const result = spawnSyncWithTimeout('git', ['-C', String(repoRoot), ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeoutMs: DEFAULT_GIT_TIMEOUT_MS,
        maxBuffer
    });
    if (result.timedOut || result.error || result.status !== 0) {
        const reason = result.timedOut
            ? `timed out after ${DEFAULT_GIT_TIMEOUT_MS}ms`
            : result.error
                ? String(result.error)
                : String(result.stderr || result.stdout || `exit status ${result.status}`).trim();
        throw new Error(
            `Unable to collect review tree state: git ${args.join(' ')} failed in '${normalizePath(repoRoot)}' (${reason}).`
        );
    }
    return String(result.stdout || '');
}

function collectStatusEntries(repoRoot: string, changedFiles: string[]): Map<string, GitStatusEntry> {
    const entries = new Map<string, GitStatusEntry>();
    if (changedFiles.length === 0) {
        return entries;
    }
    const output = runGitText(repoRoot, [
        'status',
        '--porcelain=v1',
        '-z',
        '--untracked-files=all',
        '--',
        ...toLiteralPathspecs(changedFiles)
    ]);
    const parts = output.split('\0').filter((part) => part.length > 0);
    for (let index = 0; index < parts.length; index += 1) {
        const line = parts[index];
        if (line.length < 3) {
            continue;
        }
        const indexStatus = line[0] || ' ';
        const worktreeStatus = line[1] || ' ';
        const rawPath = line.slice(3);
        const normalizedPath = normalizePath(rawPath);
        if (!normalizedPath) {
            continue;
        }
        entries.set(normalizedPath, mergeStatusEntry(entries.get(normalizedPath), { indexStatus, worktreeStatus }));
        if ((indexStatus === 'R' || indexStatus === 'C') && index + 1 < parts.length) {
            index += 1;
        }
    }
    return entries;
}

function collectStagedEntries(repoRoot: string, changedFiles: string[]): Map<string, Record<string, unknown>> {
    const entries = new Map<string, Record<string, unknown>>();
    if (changedFiles.length === 0) {
        return entries;
    }
    const output = runGitText(repoRoot, [
        'ls-files',
        '-s',
        '--',
        ...toLiteralPathspecs(changedFiles)
    ]);
    for (const line of output.split(/\r?\n/)) {
        const match = /^(\d+)\s+([0-9a-f]{40,64})\s+\d+\t(.+)$/.exec(line);
        if (!match) {
            continue;
        }
        const filePath = normalizePath(match[3] || '');
        if (!filePath) {
            continue;
        }
        entries.set(filePath, {
            path: filePath,
            mode: match[1],
            object_id: String(match[2] || '').toLowerCase()
        });
    }
    return entries;
}

function getWorktreeState(repoRoot: string, relativeFile: string): Record<string, unknown> {
    return { ...getSafeWorktreePathState(repoRoot, relativeFile) };
}

function normalizeOptionalHash(value: unknown): string | null {
    const normalized = String(value || '').trim().toLowerCase();
    return normalized || null;
}

function isChangedStatus(status: string): boolean {
    return status !== ' ' && status !== '';
}

export function usesStagedReviewTreeScope(detectionSource: unknown): boolean {
    return STAGED_DETECTION_SOURCES.has(String(detectionSource || '').trim().toLowerCase());
}

export function buildReviewTreeState(options: {
    repoRoot: string;
    detectionSource: unknown;
    includeUntracked: boolean;
    changedFiles: string[];
    metrics?: Record<string, unknown> | null;
    reviewTriggerPolicy?: ReviewTriggerPolicy;
}): ReviewTreeState {
    const reviewTriggerPolicy = options.reviewTriggerPolicy
        ? validateReviewTriggerPolicy(options.reviewTriggerPolicy)
        : undefined;
    const detectionSource = String(options.detectionSource || 'git_auto').trim().toLowerCase() || 'git_auto';
    const useStaged = usesStagedReviewTreeScope(detectionSource);
    const changedFiles = [...new Set(
        options.changedFiles.map((changedFile) => normalizePath(changedFile)).filter(Boolean)
    )].sort();
    const statusEntries = collectStatusEntries(options.repoRoot, changedFiles);
    const stagedEntries = collectStagedEntries(options.repoRoot, changedFiles);
    const entries = changedFiles.map((changedFile): ReviewTreeStateEntry => {
        const status = statusEntries.get(changedFile) || { indexStatus: ' ', worktreeStatus: ' ' };
        const isUntracked = status.indexStatus === '?' && status.worktreeStatus === '?';
        const hasStagedChange = isChangedStatus(status.indexStatus) && status.indexStatus !== '?';
        const hasUnstagedChange = isChangedStatus(status.worktreeStatus)
            && (status.worktreeStatus !== '?' || hasStagedChange);
        const staleStagedSnapshotRisk = useStaged && !isUntracked && hasUnstagedChange;
        const staged = stagedEntries.get(changedFile) || null;
        return {
            path: changedFile,
            index_status: status.indexStatus,
            worktree_status: status.worktreeStatus,
            has_staged_change: hasStagedChange,
            has_unstaged_change: hasUnstagedChange,
            stale_staged_snapshot_risk: staleStagedSnapshotRisk,
            staged,
            worktree: getWorktreeState(options.repoRoot, changedFile)
        };
    });
    const staleStagedSnapshotFiles = entries
        .filter((entry) => entry.stale_staged_snapshot_risk)
        .map((entry) => entry.path);
    const mixedStagedWorktreeFiles = entries
        .filter((entry) => entry.has_staged_change && entry.has_unstaged_change)
        .map((entry) => entry.path);
    const metrics = options.metrics || {};
    const base = {
        schema_version: 1 as const,
        detection_source: detectionSource,
        use_staged: useStaged,
        include_untracked: !!options.includeUntracked,
        changed_files: changedFiles,
        changed_files_sha256: normalizeOptionalHash(metrics.changed_files_sha256),
        scope_content_sha256: normalizeOptionalHash(metrics.scope_content_sha256),
        scope_sha256: normalizeOptionalHash(metrics.scope_sha256),
        ...(reviewTriggerPolicy ? { review_trigger_policy: reviewTriggerPolicy } : {}),
        domain_scope_fingerprints: buildDomainScopeFingerprints({
            repoRoot: options.repoRoot,
            detectionSource,
            includeUntracked: !!options.includeUntracked,
            changedFiles,
            classificationConfig: reviewTriggerPolicy
                ? getClassificationConfig(options.repoRoot, { reviewTriggerPolicy })
                : undefined
        }),
        entries,
        stale_staged_snapshot_files: staleStagedSnapshotFiles,
        mixed_staged_worktree_files: mixedStagedWorktreeFiles
    };
    return {
        ...base,
        tree_state_sha256: stringSha256(JSON.stringify(base)) || ''
    };
}

export function getReviewTreeStateBlockingViolations(treeState: ReviewTreeState): string[] {
    const violations: string[] = [];
    const outsideRepoFiles = treeState.entries
        .filter((entry) => String(entry.worktree?.status || '') === 'outside_repo')
        .map((entry) => entry.path);
    if (outsideRepoFiles.length > 0) {
        violations.push(
            `Review scope contains paths that resolve outside the repo through symlinks or junctions: ` +
            `${outsideRepoFiles.join(', ')}. ` +
            'Garda will not build reviewer context for unreviewable outside-repo content.'
        );
    }
    const unreviewableSymlinkFiles = treeState.entries
        .filter((entry) => String(entry.worktree?.status || '') === 'unreviewable_symlink')
        .map((entry) => entry.path);
    if (unreviewableSymlinkFiles.length > 0) {
        violations.push(
            `Review scope contains symlinks or junctions that do not resolve to regular in-repo files: ` +
            `${unreviewableSymlinkFiles.join(', ')}. ` +
            'Garda cannot bind reviewer-visible content for directory or special symlink targets.'
        );
    }
    if (treeState.use_staged && treeState.stale_staged_snapshot_files.length > 0) {
        const files = treeState.stale_staged_snapshot_files.join(', ');
        const verb = treeState.stale_staged_snapshot_files.length === 1 ? 'has' : 'have';
        violations.push(
            `Staged review scope is stale: ${files} ${verb} unstaged working-tree changes in addition to the staged snapshot. ` +
            'The delegated reviewer would see the index diff, not the newer working tree. ' +
            'Stage the intended fixes and rerun classify-change with --use-staged, or rebuild the review scope from the working tree. ' +
            'Garda will not stage, discard, or hide these changes automatically.'
        );
    }
    return violations;
}

function normalizeStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) {
        return [];
    }
    return [...new Set(value.map((entry) => normalizePath(entry)).filter(Boolean))].sort();
}

function cacheKey(payload: Record<string, unknown>): string {
    return stringSha256(JSON.stringify(payload)) || JSON.stringify(payload);
}

function normalizeScopeMetrics(metrics: Record<string, unknown>): Record<string, string | null> {
    return {
        changed_files_sha256: normalizeOptionalHash(metrics.changed_files_sha256),
        scope_content_sha256: normalizeOptionalHash(metrics.scope_content_sha256),
        scope_sha256: normalizeOptionalHash(metrics.scope_sha256)
    };
}

function getTreeStateHash(value: unknown): string | null {
    if (!isPlainRecord(value)) {
        return null;
    }
    const normalized = String(value.tree_state_sha256 || value.treeStateSha256 || '').trim().toLowerCase();
    return normalized || null;
}

function getOptionalBoolean(value: unknown): boolean {
    return value === true || String(value || '').trim().toLowerCase() === 'true';
}

function readStoredReviewTriggerPolicy(treeState: Record<string, unknown> | null): ReviewTriggerPolicy | undefined {
    return treeState?.review_trigger_policy === undefined
        ? undefined
        : validateReviewTriggerPolicy(treeState.review_trigger_policy);
}

function reviewDomainStillMatches(options: {
    repoRoot: string;
    reviewContext: Record<string, unknown>;
    detectionSource: string;
    includeUntracked: boolean;
    currentChangedFiles: string[];
}): boolean {
    const storedTreeState = isPlainRecord(options.reviewContext.tree_state)
        ? options.reviewContext.tree_state
        : null;
    const storedDomainFingerprints = normalizeDomainScopeFingerprints(storedTreeState?.domain_scope_fingerprints);
    if (!storedDomainFingerprints) {
        return false;
    }
    const currentDomainFingerprints = buildDomainScopeFingerprints({
        repoRoot: options.repoRoot,
        detectionSource: options.detectionSource,
        includeUntracked: options.includeUntracked,
        changedFiles: options.currentChangedFiles,
        classificationConfig: storedTreeState?.review_trigger_policy === undefined
            ? undefined
            : getClassificationConfig(options.repoRoot, {
                reviewTriggerPolicy: readStoredReviewTriggerPolicy(storedTreeState)
            })
    });
    const reviewType = String(options.reviewContext.review_type || '').trim().toLowerCase();
    return reviewLaneScopeSha256Matches(reviewType, [storedDomainFingerprints, currentDomainFingerprints]);
}

function formatPathList(paths: string[], max = 8): string {
    if (paths.length === 0) {
        return '[]';
    }
    const visible = paths.slice(0, max);
    const suffix = paths.length > max ? `, ... +${paths.length - max} more` : '';
    return `[${visible.join(', ')}${suffix}]`;
}

function getCurrentScopeSnapshot(options: {
    repoRoot: string;
    detectionSource: string;
    includeUntracked: boolean;
    storedChangedFiles: string[];
    freshnessCache?: ReviewTreeStateFreshnessCache | null;
}) {
    const normalizedStoredChangedFiles = normalizeStringArray(options.storedChangedFiles);
    const key = cacheKey({
        repo_root: normalizePath(options.repoRoot),
        detection_source: options.detectionSource,
        include_untracked: options.includeUntracked,
        stored_changed_files: normalizedStoredChangedFiles
    });
    const cached = options.freshnessCache?.currentScopeSnapshots.get(key);
    if (cached) {
        return cached;
    }
    const snapshot = getWorkspaceSnapshot(
        options.repoRoot,
        options.detectionSource,
        options.includeUntracked,
        options.detectionSource === 'explicit_changed_files' || isSplitCheckpointDetectionSource(options.detectionSource)
            ? normalizedStoredChangedFiles
            : []
    );
    options.freshnessCache?.currentScopeSnapshots.set(key, snapshot);
    return snapshot;
}

function getCurrentReviewTreeState(options: {
    repoRoot: string;
    detectionSource: string;
    includeUntracked: boolean;
    currentChangedFiles: string[];
    metrics: Record<string, unknown>;
    reviewTriggerPolicy?: ReviewTriggerPolicy;
    freshnessCache?: ReviewTreeStateFreshnessCache | null;
}): ReviewTreeState {
    const normalizedChangedFiles = normalizeStringArray(options.currentChangedFiles);
    const normalizedMetrics = normalizeScopeMetrics(options.metrics);
    const key = cacheKey({
        repo_root: normalizePath(options.repoRoot),
        detection_source: options.detectionSource,
        include_untracked: options.includeUntracked,
        current_changed_files: normalizedChangedFiles,
        metrics: normalizedMetrics,
        review_trigger_policy: options.reviewTriggerPolicy
    });
    const cached = options.freshnessCache?.currentTreeStates.get(key);
    if (cached) {
        return cached;
    }
    const treeState = buildReviewTreeState({
        repoRoot: options.repoRoot,
        detectionSource: options.detectionSource,
        includeUntracked: options.includeUntracked,
        changedFiles: normalizedChangedFiles,
        metrics: normalizedMetrics,
        reviewTriggerPolicy: options.reviewTriggerPolicy
    });
    options.freshnessCache?.currentTreeStates.set(key, treeState);
    return treeState;
}

export function getReviewTreeStateFreshnessCacheStats(cache: ReviewTreeStateFreshnessCache): {
    current_scope_snapshot_count: number;
    current_tree_state_count: number;
} {
    return {
        current_scope_snapshot_count: cache.currentScopeSnapshots.size,
        current_tree_state_count: cache.currentTreeStates.size
    };
}

export function assertReviewTreeStateFresh(options: {
    repoRoot: string;
    reviewContext: Record<string, unknown>;
    contextPath: string;
    gateName: string;
    freshnessCache?: ReviewTreeStateFreshnessCache | null;
}): void {
    const storedTreeState = isPlainRecord(options.reviewContext.tree_state)
        ? options.reviewContext.tree_state
        : null;
    if (!storedTreeState) {
        throw new Error(
            `${options.gateName} requires review context tree_state binding for '${normalizePath(options.contextPath)}'.`
        );
    }

    const expectedHash = getTreeStateHash(storedTreeState);
    if (!expectedHash) {
        throw new Error(
            `${options.gateName} requires review context tree_state_sha256 for '${normalizePath(options.contextPath)}'.`
        );
    }
    const detectionSource = String(storedTreeState.detection_source || 'git_auto').trim().toLowerCase() || 'git_auto';
    const includeUntracked = getOptionalBoolean(storedTreeState.include_untracked);
    const storedChangedFiles = normalizeStringArray(storedTreeState.changed_files);
    const currentScopeSnapshot = getCurrentScopeSnapshot({
        repoRoot: options.repoRoot,
        detectionSource,
        includeUntracked,
        storedChangedFiles,
        freshnessCache: options.freshnessCache
    });
    const currentChangedFiles = normalizeStringArray(currentScopeSnapshot.changed_files);
    const storedChangedFileSet = new Set(storedChangedFiles);
    const currentChangedFileSet = new Set(currentChangedFiles);
    const missingFromContext = currentChangedFiles.filter((filePath) => !storedChangedFileSet.has(filePath));
    const noLongerCurrent = storedChangedFiles.filter((filePath) => !currentChangedFileSet.has(filePath));
    const allowReviewDomainDrift = reviewDomainStillMatches({
        repoRoot: options.repoRoot,
        reviewContext: options.reviewContext,
        detectionSource,
        includeUntracked,
        currentChangedFiles
    });
    if (!allowReviewDomainDrift && (missingFromContext.length > 0 || noLongerCurrent.length > 0)) {
        throw new Error(
            `${options.gateName} cannot continue because review context scope is stale for '${normalizePath(options.contextPath)}'. ` +
            `Stored changed_files=${formatPathList(storedChangedFiles)}; current ${detectionSource} snapshot=${formatPathList(currentChangedFiles)}. ` +
            `Missing from review context: ${formatPathList(missingFromContext)}. ` +
            `No longer current: ${formatPathList(noLongerCurrent)}. ` +
            'Rebuild preflight and review context for the current workspace before launching or attesting a reviewer.'
        );
    }
    const storedMetrics = {
        changed_files_sha256: normalizeOptionalHash(storedTreeState.changed_files_sha256),
        scope_content_sha256: normalizeOptionalHash(storedTreeState.scope_content_sha256),
        scope_sha256: normalizeOptionalHash(storedTreeState.scope_sha256)
    };
    const currentMetrics = {
        changed_files_sha256: normalizeOptionalHash(currentScopeSnapshot.changed_files_sha256),
        scope_content_sha256: normalizeOptionalHash(currentScopeSnapshot.scope_content_sha256),
        scope_sha256: normalizeOptionalHash(currentScopeSnapshot.scope_sha256)
    };
    const staleMetricNames = (Object.keys(storedMetrics) as Array<keyof typeof storedMetrics>)
        .filter((metricName) => !!storedMetrics[metricName] && !!currentMetrics[metricName] && storedMetrics[metricName] !== currentMetrics[metricName]);
    if (!allowReviewDomainDrift && staleMetricNames.length > 0) {
        throw new Error(
            `${options.gateName} cannot continue because review context scope fingerprints are stale for '${normalizePath(options.contextPath)}'. ` +
            staleMetricNames.map((metricName) => `${metricName}: stored=${storedMetrics[metricName]}, current=${currentMetrics[metricName]}`).join('; ') +
            '. Rebuild preflight and review context for the current workspace before launching or attesting a reviewer.'
        );
    }
    const currentTreeState = getCurrentReviewTreeState({
        repoRoot: options.repoRoot,
        detectionSource,
        includeUntracked,
        currentChangedFiles,
        metrics: storedMetrics,
        reviewTriggerPolicy: readStoredReviewTriggerPolicy(storedTreeState),
        freshnessCache: options.freshnessCache
    });
    const blockingViolations = getReviewTreeStateBlockingViolations(currentTreeState);
    if (blockingViolations.length > 0) {
        throw new Error(
            `${options.gateName} cannot continue because the current reviewer-visible tree state is stale. ` +
            blockingViolations.join(' ')
        );
    }
    if (!allowReviewDomainDrift && currentTreeState.tree_state_sha256 !== expectedHash) {
        throw new Error(
            `${options.gateName} cannot continue because review context tree_state is stale for '${normalizePath(options.contextPath)}'. ` +
            `Expected tree_state_sha256=${expectedHash}; current tree_state_sha256=${currentTreeState.tree_state_sha256}. ` +
            'Rebuild preflight and review context for the current workspace before launching or attesting a reviewer.'
        );
    }
}
