import * as path from 'node:path';

import { writeReviewArtifactJson } from '../../../../gate-runtime/review-artifacts';
import { getWorkspaceSnapshot } from '../../../../gates/compile/compile-gate';
import * as gateHelpers from '../../../../gates/shared/helpers';
import { excludeUnchangedDirtyWorkspaceBaselineFiles, normalizeChangedFiles } from './recovery-flow-shared';
import type {
    ResolvedReplayScope,
    ReviewRemediationScopeBoundary
} from './recovery-flow-types';

export function resolveCurrentRemediationChangedFiles(
    repoRoot: string,
    replayScope: ResolvedReplayScope,
    dirtyWorkspaceBaseline?: unknown
): string[] {
    const detectionSource = replayScope.useStaged
        ? (replayScope.includeUntracked ? 'git_staged_plus_untracked' : 'git_staged_only')
        : 'git_auto';
    const includeUntracked = replayScope.includeUntracked ?? !replayScope.useStaged;
    const snapshot = getWorkspaceSnapshot(repoRoot, detectionSource, includeUntracked, []);
    const currentTaskChanges = excludeUnchangedDirtyWorkspaceBaselineFiles(
        repoRoot,
        snapshot.changed_files as string[],
        dirtyWorkspaceBaseline
    );
    return normalizeChangedFiles([
        ...(replayScope.changedFiles ?? []),
        ...currentTaskChanges
    ]);
}

export function writeReviewRemediationCycleArtifact(
    repoRoot: string,
    taskId: string,
    artifact: Record<string, unknown>
): string {
    const artifactPath = gateHelpers.joinOrchestratorPath(
        repoRoot,
        path.join('runtime', 'reviews', `${taskId}-review-remediation-cycle.json`)
    );
    writeReviewArtifactJson(artifactPath, artifact);
    return artifactPath;
}

export function resolveReviewRemediationClassifyChangedFiles(
    replayScope: ResolvedReplayScope,
    scopeBoundary: ReviewRemediationScopeBoundary,
    extraChangedFiles: readonly string[] = []
): string[] | undefined {
    const normalizedExtraChangedFiles = normalizeChangedFiles(extraChangedFiles);
    if (replayScope.changedFiles === undefined && normalizedExtraChangedFiles.length === 0) {
        return undefined;
    }
    return normalizeChangedFiles([
        ...scopeBoundary.previousChangedFiles,
        ...(replayScope.changedFiles ?? []),
        ...scopeBoundary.allowedTestOnlyExpansionFiles,
        ...normalizedExtraChangedFiles
    ]);
}
