import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
    appendMandatoryTaskEvent
} from '../../gate-runtime/task-events';
import {
    joinOrchestratorPath,
    normalizePath
} from '../shared/helpers';
import {
    findManifestPaths,
    getHeadCommit,
    normalizeGitPath,
    nowIso,
    readManifest,
    resolveInputPathInsideRepo,
    resolveRepoPath,
    sha256FileRequired,
    writeJson
} from './split-required-wip-contracts';
import type {
    SplitRequiredWipListResult,
    SplitRequiredWipManifest,
    SplitRequiredWipRestoreResult,
    SplitRequiredWipRetireResult,
    SplitRequiredWipTrackedFileEvidence,
    SplitRequiredWipUntrackedFileEvidence
} from './split-required-wip-contracts';
import {
    applyAdvancedRestorePlan,
    buildGitApplyIncludeArgs,
    gitFailureMessage,
    hasPatchContent,
    normalizeSelectedPaths,
    planAdvancedRestore,
    readAuthenticatedRepoFileSnapshot,
    runGitStatus,
    selectedFiles,
    validateAdvancedManifestBlobs,
    validateNoSymlinkPaths,
    validateSequentialRestoreWorkspace,
    validateSelectedTargetsClean,
    validateTrackedTargetObstructions,
    writeExclusiveRepoFileWithRemovalHandle
} from './split-required-wip-restore-plan';
import type { AdvancedRestorePlan } from './split-required-wip-restore-plan';
import type {
    AuthenticatedRepoFileRemovalHandle,
    SplitRequiredWipRestoreArtifactSnapshots
} from './split-required-wip-restore-plan';
import {
    readAndVerifySplitRequiredWipRestoreHandoffSnapshot
} from './split-required-wip-runtime-handoff-contracts';
import type {
    SplitRequiredWipRestoreHandoffIdentity
} from './split-required-wip-runtime-handoff-contracts';

interface SplitRequiredWipRestoreParams {
    repoRoot: string;
    taskId: string;
    manifestPath: string;
    includePaths?: readonly string[];
    dryRun?: boolean;
}

const MAX_RESTORE_ARTIFACT_BYTES = 64 * 1024 * 1024;
const MAX_RESTORE_ARTIFACT_AGGREGATE_BYTES = 256 * 1024 * 1024;

function readAuthenticatedArtifactSnapshot(
    repoRoot: string,
    label: string,
    inputPath: string,
    expectedSha256: string,
    expectedBytes: number
): Buffer {
    if (!Number.isSafeInteger(expectedBytes)
        || expectedBytes < 0
        || expectedBytes > MAX_RESTORE_ARTIFACT_BYTES) {
        throw new Error(`${label} byte length exceeds the restore artifact limit.`);
    }
    const artifactPath = resolveInputPathInsideRepo(repoRoot, inputPath, label);
    const relativePath = normalizeGitPath(path.relative(repoRoot, artifactPath));
    const snapshot = readAuthenticatedRepoFileSnapshot(
        repoRoot,
        relativePath,
        MAX_RESTORE_ARTIFACT_BYTES
    );
    if (!snapshot.exists || snapshot.content === null || snapshot.identity === null) {
        throw new Error(`${label} must remain a regular file while being authenticated.`);
    }
    if (snapshot.identity.size !== expectedBytes) {
        throw new Error(`${label} identity or byte length changed while opening.`);
    }
    const actualSha256 = createHash('sha256').update(snapshot.content).digest('hex');
    if (actualSha256 !== expectedSha256) {
        throw new Error(
            `${label} sha256 mismatch: expected=${expectedSha256}; actual=${actualSha256}`
        );
    }
    return snapshot.content;
}

function validateRestoreArtifactAggregateBytes(
    manifest: SplitRequiredWipManifest,
    selectedUntrackedFiles: readonly SplitRequiredWipUntrackedFileEvidence[]
): void {
    const retainedBytes = [
        manifest.patches.staged.bytes,
        manifest.patches.unstaged.bytes,
        ...selectedUntrackedFiles.map((entry) => entry.bytes)
    ].reduce((total, value) => total + value, 0);
    if (!Number.isSafeInteger(retainedBytes)
        || retainedBytes > MAX_RESTORE_ARTIFACT_AGGREGATE_BYTES) {
        throw new Error(
            `selected restore artifacts exceed the ${MAX_RESTORE_ARTIFACT_AGGREGATE_BYTES} byte aggregate limit.`
        );
    }
}

function captureRestoreArtifactSnapshots(
    repoRoot: string,
    manifest: SplitRequiredWipManifest,
    selectedUntrackedFiles: readonly SplitRequiredWipUntrackedFileEvidence[]
): SplitRequiredWipRestoreArtifactSnapshots {
    const staged = readAuthenticatedArtifactSnapshot(
        repoRoot,
        'staged patch',
        manifest.patches.staged.path,
        manifest.patches.staged.sha256,
        manifest.patches.staged.bytes
    );
    const unstaged = readAuthenticatedArtifactSnapshot(
        repoRoot,
        'unstaged patch',
        manifest.patches.unstaged.path,
        manifest.patches.unstaged.sha256,
        manifest.patches.unstaged.bytes
    );
    const untrackedFiles = new Map<string, Buffer>();
    for (const entry of selectedUntrackedFiles) {
        untrackedFiles.set(normalizeGitPath(entry.path), readAuthenticatedArtifactSnapshot(
            repoRoot,
            `untracked artifact ${entry.path}`,
            entry.artifact_path,
            entry.sha256,
            entry.bytes
        ));
    }
    return {
        patches: { staged, unstaged },
        untrackedFiles
    };
}

function validateSelectedUntrackedArtifactReferences(
    repoRoot: string,
    selectedUntrackedFiles: readonly SplitRequiredWipUntrackedFileEvidence[]
): string[] {
    const violations: string[] = [];
    for (const entry of selectedUntrackedFiles) {
        try {
            readAuthenticatedArtifactSnapshot(
                repoRoot,
                `untracked artifact ${entry.path}`,
                entry.artifact_path,
                entry.sha256,
                entry.bytes
            );
        } catch (error: unknown) {
            violations.push(error instanceof Error ? error.message : String(error));
        }
    }
    return violations;
}

function applyPatchSnapshot(
    repoRoot: string,
    args: string[],
    content: Buffer,
    allowFailure = false
): boolean {
    const result = runGitStatus(repoRoot, [...args, '-'], process.env, content);
    if (result.status !== 0 && !allowFailure) {
        throw new Error(gitFailureMessage([...args, '-'], result));
    }
    return result.status === 0;
}

export function listSplitRequiredWip(params: {
    repoRoot: string;
    taskId: string;
}): SplitRequiredWipListResult {
    const repoRoot = path.resolve(params.repoRoot || '.');
    const taskId = String(params.taskId || '').trim();
    const manifests = findManifestPaths(repoRoot, taskId)
        .map((manifestPath) => ({ manifestPath, manifest: readManifest(manifestPath) }))
        .filter((entry): entry is { manifestPath: string; manifest: SplitRequiredWipManifest } => Boolean(entry.manifest))
        .map((entry) => ({
            manifest_path: normalizePath(entry.manifestPath),
            manifest_sha256: sha256FileRequired(entry.manifestPath),
            task_id: entry.manifest.task_id,
            guard_kind: entry.manifest.guard_kind,
            status: entry.manifest.status,
            base_commit: entry.manifest.base_commit,
            tracked_files: entry.manifest.tracked_files.map((file) => file.path).sort(),
            untracked_files: entry.manifest.untracked_files.map((file) => file.path).sort(),
            created_at_utc: entry.manifest.created_at_utc
        }));
    return {
        status: manifests.length > 0 ? 'FOUND' : 'EMPTY',
        task_id: taskId,
        manifests,
        output_lines: [
            manifests.length > 0 ? 'SPLIT_REQUIRED_WIP_FOUND' : 'SPLIT_REQUIRED_WIP_EMPTY',
            `TaskId: ${taskId}`,
            `ManifestCount: ${manifests.length}`,
            ...manifests.flatMap((entry) => [
                `ManifestPath: ${entry.manifest_path}`,
                `Status: ${entry.status}`,
                `GuardKind: ${entry.guard_kind}`,
                `TrackedFiles: ${entry.tracked_files.join(', ') || 'none'}`,
                `UntrackedFiles: ${entry.untracked_files.join(', ') || 'none'}`
            ])
        ]
    };
}

function restoreSplitRequiredWipCore(
    params: SplitRequiredWipRestoreParams,
    deferRestoredEvent: boolean,
    verifiedManifest?: SplitRequiredWipManifest
): SplitRequiredWipRestoreResult {
    const repoRoot = path.resolve(params.repoRoot || '.');
    let manifestPath = '';
    try {
        manifestPath = resolveInputPathInsideRepo(repoRoot, params.manifestPath, 'ManifestPath');
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return {
            status: 'BLOCKED',
            manifest_path: normalizePath(path.resolve(repoRoot, String(params.manifestPath || ''))),
            restored_files: [],
            selected_paths: [],
            violations: [message],
            output_lines: ['SPLIT_REQUIRED_WIP_RESTORE_BLOCKED', `Violation: ${message}`]
        };
    }
    const selectedPaths = normalizeSelectedPaths(params.includePaths || []);
    const manifest = verifiedManifest || readManifest(manifestPath);
    const violations: string[] = [];
    let advancedHead = false;
    let advancedPlan: AdvancedRestorePlan | null = null;
    let artifactSnapshots: SplitRequiredWipRestoreArtifactSnapshots | null = null;
    let selectedTrackedFiles: SplitRequiredWipTrackedFileEvidence[] = [];
    let selectedUntrackedFiles: SplitRequiredWipUntrackedFileEvidence[] = [];
    if (!manifest) {
        violations.push('WIP manifest is missing or invalid.');
    } else {
        if (manifest.task_id !== String(params.taskId || '').trim()) {
            violations.push(`WIP manifest task_id mismatch: expected=${params.taskId}; actual=${manifest.task_id}.`);
        }
        if (manifest.status !== 'suspended') {
            violations.push(`WIP manifest status must be suspended; found ${manifest.status}.`);
        }
        const currentHead = getHeadCommit(repoRoot);
        advancedHead = Boolean(manifest.base_commit && currentHead !== manifest.base_commit);
        const restorablePaths = new Set([
            ...manifest.tracked_files.map((entry) => normalizeGitPath(entry.path)),
            ...manifest.untracked_files.map((entry) => normalizeGitPath(entry.path))
        ]);
        for (const selectedPath of selectedPaths) {
            if (!restorablePaths.has(selectedPath)) {
                violations.push(`selected path is not present in WIP manifest: ${selectedPath}`);
            }
        }
        selectedTrackedFiles = selectedFiles(manifest.tracked_files, selectedPaths);
        selectedUntrackedFiles = selectedFiles(manifest.untracked_files, selectedPaths);
        const effectiveSelectedPaths = new Set(
            [...selectedTrackedFiles, ...selectedUntrackedFiles]
                .map((entry) => normalizeGitPath(entry.path))
        );
        violations.push(...validateNoSymlinkPaths(repoRoot, effectiveSelectedPaths));
        if (violations.length === 0) {
            try {
                validateRestoreArtifactAggregateBytes(manifest, selectedUntrackedFiles);
                artifactSnapshots = captureRestoreArtifactSnapshots(
                    repoRoot,
                    manifest,
                    params.dryRun ? [] : selectedUntrackedFiles
                );
            } catch (error: unknown) {
                violations.push(error instanceof Error ? error.message : String(error));
            }
        }
        if (advancedHead) {
            if (selectedPaths.size === 0) {
                violations.push('advanced restore requires at least one explicit include-path authorization.');
            }
            const ancestry = runGitStatus(repoRoot, ['merge-base', '--is-ancestor', manifest.base_commit, currentHead]);
            if (ancestry.status === 1) {
                violations.push(`manifest base commit is not an ancestor of current HEAD: manifest=${manifest.base_commit}; current=${currentHead}`);
            } else if (ancestry.status !== 0) {
                violations.push(gitFailureMessage(['merge-base', '--is-ancestor', manifest.base_commit, currentHead], ancestry));
            }
            violations.push(...validateSelectedTargetsClean(repoRoot, selectedPaths));
            violations.push(...validateTrackedTargetObstructions(repoRoot, selectedTrackedFiles));
            violations.push(...validateAdvancedManifestBlobs(repoRoot, manifest, selectedTrackedFiles));
        } else {
            // An explicit subset owns only its targets; earlier parent restoration stays authenticated.
            if (selectedPaths.size > 0) {
                violations.push(...validateSelectedTargetsClean(repoRoot, selectedPaths));
                violations.push(...validateTrackedTargetObstructions(repoRoot, selectedTrackedFiles));
            }
            violations.push(...validateSequentialRestoreWorkspace(repoRoot, manifest, {
                allowUnrelatedTrackedChanges: selectedPaths.size > 0,
                stagedPatchSnapshot: artifactSnapshots?.patches.staged
            }));
        }
        if (params.dryRun && violations.length === 0) {
            violations.push(...validateSelectedUntrackedArtifactReferences(repoRoot, selectedUntrackedFiles));
        }
        for (const entry of selectedUntrackedFiles) {
            if (fs.existsSync(resolveRepoPath(repoRoot, entry.path))) {
                violations.push(`untracked restore target already exists: ${entry.path}`);
            }
        }
        if (advancedHead && violations.length === 0) {
            const planned = planAdvancedRestore(
                repoRoot,
                manifest,
                selectedPaths,
                selectedTrackedFiles,
                artifactSnapshots || undefined
            );
            advancedPlan = planned.plan;
            violations.push(...planned.violations);
        }
    }
    if (violations.length > 0 || !manifest) {
        return {
            status: 'BLOCKED',
            manifest_path: normalizePath(manifestPath),
            restored_files: [],
            selected_paths: [...selectedPaths].sort(),
            violations,
            output_lines: ['SPLIT_REQUIRED_WIP_RESTORE_BLOCKED', ...violations.map((violation) => `Violation: ${violation}`)]
        };
    }
    if (params.dryRun) {
        if (advancedPlan) {
            fs.rmSync(advancedPlan.tempRoot, { recursive: true, force: true });
        }
        return {
            status: 'DRY_RUN_OK',
            manifest_path: normalizePath(manifestPath),
            restored_files: [],
            selected_paths: [...selectedPaths].sort(),
            violations: [],
            output_lines: [
                'SPLIT_REQUIRED_WIP_RESTORE_DRY_RUN_OK',
                `ManifestPath: ${normalizePath(manifestPath)}`,
                `SelectedPaths: ${[...selectedPaths].sort().join(', ') || 'all'}`,
                `TrackedFiles: ${selectedTrackedFiles.map((entry) => entry.path).join(', ') || 'none'}`,
                `UntrackedFiles: ${selectedUntrackedFiles.map((entry) => entry.path).join(', ') || 'none'}`
            ]
        };
    }

    const restoredFiles = new Set<string>();
    if (advancedHead && advancedPlan) {
        const advancedViolations = applyAdvancedRestorePlan(
            repoRoot,
            advancedPlan,
            selectedTrackedFiles,
            selectedUntrackedFiles,
            artifactSnapshots || undefined
        );
        fs.rmSync(advancedPlan.tempRoot, { recursive: true, force: true });
        if (advancedViolations.length > 0) {
            return {
                status: 'BLOCKED',
                manifest_path: normalizePath(manifestPath),
                restored_files: [],
                selected_paths: [...selectedPaths].sort(),
                violations: advancedViolations,
                output_lines: ['SPLIT_REQUIRED_WIP_RESTORE_BLOCKED', ...advancedViolations.map((violation) => `Violation: ${violation}`)]
            };
        }
        for (const entry of [...selectedTrackedFiles, ...selectedUntrackedFiles]) {
            restoredFiles.add(entry.path);
        }
    }
    const includeArgs = buildGitApplyIncludeArgs(selectedPaths);
    let stagedApplied = false;
    let unstagedApplied = false;
    const createdUntrackedFiles = new Map<string, AuthenticatedRepoFileRemovalHandle>();
    try {
        if (advancedHead) {
            // Advanced restore was applied transactionally from the validated temporary plan above.
        } else if (hasPatchContent(manifest.patches.staged)) {
            if (!artifactSnapshots) {
                throw new Error('authenticated restore artifact snapshots are missing.');
            }
            applyPatchSnapshot(repoRoot, ['apply', ...includeArgs, '--check', '--index'], artifactSnapshots.patches.staged);
            applyPatchSnapshot(repoRoot, ['apply', ...includeArgs, '--index'], artifactSnapshots.patches.staged);
            stagedApplied = true;
            for (const entry of selectedTrackedFiles.filter((file) => file.staged)) {
                restoredFiles.add(entry.path);
            }
        }
        if (!advancedHead && hasPatchContent(manifest.patches.unstaged)) {
            if (!artifactSnapshots) {
                throw new Error('authenticated restore artifact snapshots are missing.');
            }
            applyPatchSnapshot(repoRoot, ['apply', ...includeArgs, '--check'], artifactSnapshots.patches.unstaged);
            applyPatchSnapshot(repoRoot, ['apply', ...includeArgs], artifactSnapshots.patches.unstaged);
            unstagedApplied = true;
            for (const entry of selectedTrackedFiles.filter((file) => file.unstaged)) {
                restoredFiles.add(entry.path);
            }
        }
        for (const entry of advancedHead ? [] : selectedUntrackedFiles) {
            const normalizedPath = normalizeGitPath(entry.path);
            const content = artifactSnapshots?.untrackedFiles.get(normalizedPath);
            if (content === undefined) {
                throw new Error(`authenticated untracked artifact snapshot is missing: ${entry.path}`);
            }
            const removalHandle = writeExclusiveRepoFileWithRemovalHandle(
                repoRoot,
                normalizedPath,
                content
            );
            createdUntrackedFiles.set(normalizedPath, removalHandle);
            restoredFiles.add(entry.path);
        }
    } catch (error: unknown) {
        const rollbackFailures: string[] = [];
        for (const removalHandle of [...createdUntrackedFiles.values()].reverse()) {
            try {
                removalHandle.remove();
            } catch (rollbackError: unknown) {
                rollbackFailures.push(
                    rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
                );
            } finally {
                try {
                    removalHandle.close();
                } catch (closeError: unknown) {
                    rollbackFailures.push(
                        closeError instanceof Error ? closeError.message : String(closeError)
                    );
                }
            }
        }
        if (!advancedHead && unstagedApplied && artifactSnapshots
            && !applyPatchSnapshot(
                repoRoot,
                ['apply', ...includeArgs, '--reverse'],
                artifactSnapshots.patches.unstaged,
                true
            )) {
            rollbackFailures.push('failed to reverse the applied unstaged patch');
        }
        if (!advancedHead && stagedApplied && artifactSnapshots
            && !applyPatchSnapshot(
                repoRoot,
                ['apply', ...includeArgs, '--reverse', '--index'],
                artifactSnapshots.patches.staged,
                true
            )) {
            rollbackFailures.push('failed to reverse the applied staged patch');
        }
        const message = error instanceof Error ? error.message : String(error);
        const rollbackSuffix = rollbackFailures.length === 0
            ? ''
            : `; rollback failures: ${rollbackFailures.join(' | ')}`;
        return {
            status: 'BLOCKED',
            manifest_path: normalizePath(manifestPath),
            restored_files: [],
            selected_paths: [...selectedPaths].sort(),
            violations: [`patch restore failed: ${message}${rollbackSuffix}`],
            output_lines: [
                'SPLIT_REQUIRED_WIP_RESTORE_BLOCKED',
                `Violation: patch restore failed: ${message}${rollbackSuffix}`
            ]
        };
    }
    for (const removalHandle of createdUntrackedFiles.values()) {
        removalHandle.close();
    }
    if (!deferRestoredEvent) {
        appendMandatoryTaskEvent(
            joinOrchestratorPath(repoRoot, ''),
            manifest.task_id,
            'SPLIT_REQUIRED_WIP_RESTORED',
            'PASS',
            'Split-required WIP restored by explicit command.',
            {
                manifest_path: normalizePath(manifestPath),
                restored_files: [...restoredFiles].sort(),
                selected_paths: [...selectedPaths].sort()
            },
            { actor: 'orchestrator' }
        );
    }

    return {
        status: 'RESTORED',
        manifest_path: normalizePath(manifestPath),
        restored_files: [...restoredFiles].sort(),
        selected_paths: [...selectedPaths].sort(),
        violations: [],
        output_lines: [
            deferRestoredEvent
                ? 'SPLIT_REQUIRED_WIP_FILES_RESTORED_EVENT_PENDING'
                : 'SPLIT_REQUIRED_WIP_RESTORED',
            `ManifestPath: ${normalizePath(manifestPath)}`,
            `SelectedPaths: ${[...selectedPaths].sort().join(', ') || 'all'}`,
            `RestoredFiles: ${[...restoredFiles].sort().join(', ') || 'none'}`
        ]
    };
}

/**
 * Requires exclusive operational access to repository targets, their parents and
 * restore working files. Concurrent filesystem mutation is unsupported: checks
 * provide defense in depth, not atomic publication or crash-recovery guarantees.
 */
export function restoreSplitRequiredWip(
    params: SplitRequiredWipRestoreParams
): SplitRequiredWipRestoreResult {
    return restoreSplitRequiredWipCore(params, false);
}

/** Uses the same exclusive-access contract as restoreSplitRequiredWip. */
export function restoreSplitRequiredWipForPreparedRuntimeHandoff(
    identity: SplitRequiredWipRestoreHandoffIdentity
): SplitRequiredWipRestoreResult {
    const { handoff, manifest: verifiedManifest } = readAndVerifySplitRequiredWipRestoreHandoffSnapshot(identity);
    if (handoff.status !== 'prepared') {
        throw new Error(`restore handoff must be prepared before deferred restoration; found ${handoff.status}.`);
    }
    return restoreSplitRequiredWipCore({
        repoRoot: identity.repoRoot,
        taskId: identity.taskId,
        manifestPath: identity.manifestPath,
        includePaths: identity.selectedPaths
    }, true, verifiedManifest);
}

export function retireSplitRequiredWip(params: {
    repoRoot: string;
    taskId: string;
    manifestPath: string;
    reason: string;
}): SplitRequiredWipRetireResult {
    const repoRoot = path.resolve(params.repoRoot || '.');
    let manifestPath = '';
    try {
        manifestPath = resolveInputPathInsideRepo(repoRoot, params.manifestPath, 'ManifestPath');
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return {
            status: 'BLOCKED',
            manifest_path: normalizePath(path.resolve(repoRoot, String(params.manifestPath || ''))),
            violations: [message],
            output_lines: ['SPLIT_REQUIRED_WIP_RETIRE_BLOCKED', `Violation: ${message}`]
        };
    }
    const reason = String(params.reason || '').trim();
    const manifest = readManifest(manifestPath);
    const violations: string[] = [];
    if (!manifest) {
        violations.push('WIP manifest is missing or invalid.');
    } else if (manifest.task_id !== String(params.taskId || '').trim()) {
        violations.push(`WIP manifest task_id mismatch: expected=${params.taskId}; actual=${manifest.task_id}.`);
    }
    if (!reason) {
        violations.push('Reason is required.');
    }
    if (violations.length > 0 || !manifest) {
        return {
            status: 'BLOCKED',
            manifest_path: normalizePath(manifestPath),
            violations,
            output_lines: ['SPLIT_REQUIRED_WIP_RETIRE_BLOCKED', ...violations.map((violation) => `Violation: ${violation}`)]
        };
    }
    if (manifest.status === 'retired') {
        return {
            status: 'ALREADY_RETIRED',
            manifest_path: normalizePath(manifestPath),
            violations: [],
            output_lines: ['SPLIT_REQUIRED_WIP_ALREADY_RETIRED', `ManifestPath: ${normalizePath(manifestPath)}`]
        };
    }
    const updated: SplitRequiredWipManifest = {
        ...manifest,
        status: 'retired',
        retired_at_utc: nowIso(),
        retired_reason: reason
    };
    writeJson(manifestPath, updated);
    appendMandatoryTaskEvent(
        joinOrchestratorPath(repoRoot, ''),
        manifest.task_id,
        'SPLIT_REQUIRED_WIP_RETIRED',
        'INFO',
        'Split-required WIP manifest retired by explicit command.',
        {
            manifest_path: normalizePath(manifestPath),
            manifest_sha256: sha256FileRequired(manifestPath),
            reason
        },
        { actor: 'orchestrator' }
    );
    return {
        status: 'RETIRED',
        manifest_path: normalizePath(manifestPath),
        violations: [],
        output_lines: [
            'SPLIT_REQUIRED_WIP_RETIRED',
            `ManifestPath: ${normalizePath(manifestPath)}`,
            `Reason: ${reason}`
        ]
    };
}
