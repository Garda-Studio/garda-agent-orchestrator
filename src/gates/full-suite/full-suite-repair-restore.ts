import { TASK_QUEUE_FILENAME } from '../../core/orchestration-constants';
import { writeTaskQueueFile } from '../../core/task-queue/task-queue-repository';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
    withTaskQueueStatusSyncLock
} from '../../cli/commands/gate-flows/task/task-queue-sync';
import {
    formatActiveTaskQueueTable,
    parseCanonicalActiveTaskQueue,
    replaceTaskMdTableCell
} from '../../core/task-md-table';
import {
    formatTaskQueueStatusCell,
    readTaskQueueStatusToken
} from '../../core/task-queue/active-task-state';
import {
    appendMandatoryTaskEvent
} from '../../gate-runtime/task-events';
import {
    withFilesystemLock
} from '../../gate-runtime/timeline/task-events-locking';
import {
    joinOrchestratorPath,
    normalizePath
} from '../shared/helpers';
import {
    buildRestoreFullSuiteRepairWipCommand,
    formatFullSuiteRepairOutput
} from './full-suite-repair-contracts';
import type {
    CapturedUntrackedFileEvidence,
    FullSuiteRepairWipRestoreResult,
    ParentResumeStatusResult,
    RestoreFullSuiteRepairWipParams
} from './full-suite-repair-contracts';
import {
    hasPatchContent,
    readImmutableRegularFileSnapshot
} from './full-suite-repair-capture';
import {
    parseRepairWipManifest,
    resolveInputPathInsideRepo,
    restoreContainedUntrackedFile,
    runGitWithInput,
    validatePhysicalRepoContainment
} from './full-suite-repair-manifest';
import {
    readFullSuiteRepairTaskMaterializationEvidence
} from './full-suite-repair-materialization';
import {
    resolveFullSuiteRepairDecompositionState,
    sameRepairChildTaskIds
} from './full-suite-repair-decomposition';
import {
    inspectRestoreMutationState,
    rollbackFullSuiteRepairRestore
} from './full-suite-repair-restore-validation';

function isParentResumeStatus(status: string | null): boolean {
    return status === 'SPLIT_REQUIRED' || status === 'DECOMPOSED' || status === 'IN_PROGRESS';
}

function validateCurrentRepairHandoffForRestore(
    repoRoot: string,
    taskId: string,
    expectedChildTaskIds: readonly string[]
): string[] {
    const decomposition = resolveFullSuiteRepairDecompositionState(
        repoRoot,
        taskId,
        { allowCompletedChildren: true }
    );
    const violations = decomposition.ready
        ? []
        : [`current full-suite repair decomposition is not valid: ${decomposition.violations.join(' ')}`];
    if (
        decomposition.ready
        && !sameRepairChildTaskIds(decomposition.child_task_ids, expectedChildTaskIds)
    ) {
        violations.push('current full-suite repair decomposition child_task_ids do not match the suspended WIP manifest.');
    }
    violations.push(...validateRepairChildrenDone(repoRoot, [...expectedChildTaskIds]));
    return violations;
}

function resumeParentTaskAfterWipRestore(
    repoRoot: string,
    taskId: string,
    expectedChildTaskIds: readonly string[]
): ParentResumeStatusResult {
    const taskPath = path.join(repoRoot, TASK_QUEUE_FILENAME);
    if (!fs.existsSync(taskPath) || !fs.statSync(taskPath).isFile()) {
        return {
            outcome: 'task_file_missing',
            task_path: normalizePath(taskPath),
            task_id: taskId,
            previous_status: null,
            next_status: 'IN_PROGRESS',
            error_message: null
        };
    }

    return withTaskQueueStatusSyncLock<ParentResumeStatusResult>(
        taskPath,
        (message) => ({
            outcome: 'write_failed',
            task_path: normalizePath(taskPath),
            task_id: taskId,
            previous_status: null,
            next_status: 'IN_PROGRESS',
            error_message: message
        }),
        () => {
            const original = fs.readFileSync(taskPath, 'utf8');
            const newline = original.includes('\r\n') ? '\r\n' : '\n';
            const lines = original.split(/\r?\n/);
            const row = parseCanonicalActiveTaskQueue(original).rows.find((candidate) => candidate.taskId === taskId);
            if (!row) {
                return {
                    outcome: 'task_not_found',
                    task_path: normalizePath(taskPath),
                    task_id: taskId,
                    previous_status: null,
                    next_status: 'IN_PROGRESS',
                    error_message: null
                };
            }
            const previousStatus = readTaskQueueStatusToken(row.status);
            if (!isParentResumeStatus(previousStatus)) {
                return {
                    outcome: 'blocked_status',
                    task_path: normalizePath(taskPath),
                    task_id: taskId,
                    previous_status: previousStatus,
                    next_status: 'IN_PROGRESS',
                    error_message: `Expected parent status SPLIT_REQUIRED, DECOMPOSED, or IN_PROGRESS; found ${previousStatus || 'unknown'}.`
                };
            }
            const handoffViolations = validateCurrentRepairHandoffForRestore(
                repoRoot,
                taskId,
                expectedChildTaskIds
            );
            if (handoffViolations.length > 0) {
                return {
                    outcome: 'blocked_status',
                    task_path: normalizePath(taskPath),
                    task_id: taskId,
                    previous_status: previousStatus,
                    next_status: 'IN_PROGRESS',
                    error_message: handoffViolations.join(' ')
                };
            }
            if (previousStatus === 'IN_PROGRESS') {
                return {
                    outcome: 'already_synced',
                    task_path: normalizePath(taskPath),
                    task_id: taskId,
                    previous_status: previousStatus,
                    next_status: 'IN_PROGRESS',
                    error_message: null
                };
            }
            const updatedStatusCell = formatTaskQueueStatusCell(row.cells[1].raw, 'IN_PROGRESS');
            const updatedLine = replaceTaskMdTableCell(row.rawLine, 1, updatedStatusCell);
            if (!updatedLine) {
                return {
                    outcome: 'write_failed',
                    task_path: normalizePath(taskPath),
                    task_id: taskId,
                    previous_status: previousStatus,
                    next_status: 'IN_PROGRESS',
                    error_message: 'Failed to replace TASK.md status cell.'
                };
            }
            lines[row.lineIndex] = updatedLine;
            writeTaskQueueFile(taskPath, formatActiveTaskQueueTable(lines.join(newline)));
            return {
                outcome: 'updated',
                task_path: normalizePath(taskPath),
                task_id: taskId,
                previous_status: previousStatus,
                next_status: 'IN_PROGRESS',
                error_message: null
            };
        }
    );
}

function rollbackParentTaskStatusAfterWipRestore(
    repoRoot: string,
    taskId: string,
    parentResume: ParentResumeStatusResult
): string[] {
    if (parentResume.outcome !== 'updated' || !parentResume.previous_status) {
        return [];
    }
    const taskPath = path.join(repoRoot, TASK_QUEUE_FILENAME);
    try {
        return withTaskQueueStatusSyncLock<string[]>(
            taskPath,
            (message) => [`failed to roll back parent task status: ${message}`],
            () => {
                if (!fs.existsSync(taskPath) || !fs.statSync(taskPath).isFile()) {
                    return [`failed to roll back parent task status: TASK.md is missing at ${normalizePath(taskPath)}.`];
                }
                const original = fs.readFileSync(taskPath, 'utf8');
                const newline = original.includes('\r\n') ? '\r\n' : '\n';
                const lines = original.split(/\r?\n/);
                const row = parseCanonicalActiveTaskQueue(original).rows.find((candidate) => candidate.taskId === taskId);
                if (!row) {
                    return [`failed to roll back parent task status: task ${taskId} is missing.`];
                }
                const currentStatus = readTaskQueueStatusToken(row.status);
                if (currentStatus !== 'IN_PROGRESS') {
                    return [
                        `failed to roll back parent task status: expected IN_PROGRESS after restore sync; found ${currentStatus || 'unknown'}.`
                    ];
                }
                const previousStatus = String(parentResume.previous_status || '');
                if (!isParentResumeStatus(previousStatus) || previousStatus === 'IN_PROGRESS') {
                    return [`failed to roll back parent task status: invalid previous status ${previousStatus}.`];
                }
                const previousStatusCell = formatTaskQueueStatusCell(row.cells[1].raw, previousStatus);
                const restoredLine = replaceTaskMdTableCell(row.rawLine, 1, previousStatusCell);
                if (!restoredLine) {
                    return ['failed to roll back parent task status: TASK.md status cell replacement failed.'];
                }
                lines[row.lineIndex] = restoredLine;
                writeTaskQueueFile(taskPath, formatActiveTaskQueueTable(lines.join(newline)));
                return [];
            }
        );
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return [`failed to roll back parent task status: ${message}`];
    }
}

function validateParentCanResumeAfterWipRestore(repoRoot: string, taskId: string): string[] {
    const taskPath = path.join(repoRoot, TASK_QUEUE_FILENAME);
    if (!fs.existsSync(taskPath) || !fs.statSync(taskPath).isFile()) {
        return [`parent status sync precheck failed: task_file_missing (${normalizePath(taskPath)}).`];
    }
    const row = parseCanonicalActiveTaskQueue(fs.readFileSync(taskPath, 'utf8')).rows.find((candidate) => candidate.taskId === taskId);
    if (!row) {
        return [`parent status sync precheck failed: task_not_found (${taskId}).`];
    }
    const previousStatus = readTaskQueueStatusToken(row.status);
    if (!isParentResumeStatus(previousStatus)) {
        return [`parent status sync precheck failed: blocked_status (Expected parent status SPLIT_REQUIRED, DECOMPOSED, or IN_PROGRESS; found ${previousStatus || 'unknown'}.)`];
    }
    return [];
}

function validateRepairChildrenDone(repoRoot: string, childTaskIds: string[]): string[] {
    const taskPath = path.join(repoRoot, TASK_QUEUE_FILENAME);
    if (childTaskIds.length < 2) {
        return ['At least two repair child task ids are required in the WIP manifest.'];
    }
    if (!fs.existsSync(taskPath) || !fs.statSync(taskPath).isFile()) {
        return [`repair children completion check failed: TASK.md missing at ${normalizePath(taskPath)}.`];
    }
    const rows = parseCanonicalActiveTaskQueue(fs.readFileSync(taskPath, 'utf8')).rows;
    const violations: string[] = [];
    for (const childTaskId of childTaskIds) {
        const row = rows.find((candidate) => candidate.taskId === childTaskId);
        if (!row) {
            violations.push(`repair child ${childTaskId} is missing from TASK.md.`);
            continue;
        }
        const status = readTaskQueueStatusToken(row.status);
        if (status !== 'DONE') {
            violations.push(`repair child ${childTaskId} must be DONE before restoring parent WIP; found ${status || 'unknown'}.`);
        }
    }
    return violations;
}

function buildRestoreTransactionBlockedResult(params: {
    repoRoot: string;
    taskId: string;
    manifestPath: string;
    restoredFiles: Set<string>;
    violations: string[];
    rollbackIncomplete: boolean;
}): FullSuiteRepairWipRestoreResult {
    return {
        status: 'BLOCKED',
        manifest_path: normalizePath(params.manifestPath),
        restored_files: params.rollbackIncomplete ? [...params.restoredFiles].sort() : [],
        violations: params.violations,
        output_lines: formatFullSuiteRepairOutput({
            repoRoot: params.repoRoot,
            taskId: params.taskId,
            gate: 'full-suite-repair-wip-restore',
            status: 'BLOCKED',
            action: 'Fix restore transaction blockers before retrying WIP restore.',
            reason: params.violations.join(' '),
            detailsPath: params.manifestPath,
            legacyLines: [
                'FULL_SUITE_REPAIR_WIP_RESTORE_BLOCKED',
                ...params.violations.map((violation) => `Violation: ${violation}`)
            ]
        })
    };
}

function restoreFullSuiteRepairWipUnlocked(params: RestoreFullSuiteRepairWipParams): FullSuiteRepairWipRestoreResult {
    const repoRoot = path.resolve(params.repoRoot || '.');
    let manifestPath = '';
    let fullSuiteArtifactPath = '';
    let reviewsRoot = '';
    try {
        manifestPath = resolveInputPathInsideRepo(repoRoot, params.manifestPath, 'ManifestPath');
        fullSuiteArtifactPath = resolveInputPathInsideRepo(repoRoot, params.fullSuiteArtifactPath, 'FullSuiteArtifactPath');
        reviewsRoot = params.reviewsRoot
            ? resolveInputPathInsideRepo(repoRoot, params.reviewsRoot, 'ReviewsRoot')
            : joinOrchestratorPath(repoRoot, path.join('runtime', 'reviews'));
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return {
            status: 'BLOCKED',
            manifest_path: normalizePath(path.resolve(repoRoot, String(params.manifestPath || ''))),
            restored_files: [],
            violations: [message],
            output_lines: formatFullSuiteRepairOutput({
                repoRoot,
                taskId: params.taskId,
                gate: 'full-suite-repair-wip-restore',
                status: 'BLOCKED',
                action: 'Fix the restore input paths before retrying WIP restore.',
                reason: message,
                detailsPath: params.manifestPath ? path.resolve(repoRoot, String(params.manifestPath)) : null,
                legacyLines: ['FULL_SUITE_REPAIR_WIP_RESTORE_BLOCKED', `Violation: ${message}`]
            })
        };
    }
    const taskId = String(params.taskId || '').trim();
    const violations: string[] = [];
    let expectedManifestSha256 = '';
    if (!taskId) {
        violations.push('TaskId must not be empty.');
    } else {
        const decomposition = resolveFullSuiteRepairDecompositionState(
            repoRoot,
            taskId,
            { allowCompletedChildren: true }
        );
        if (!decomposition.ready) {
            violations.push(
                `current full-suite repair decomposition is not valid: ${decomposition.violations.join(' ')}`
            );
        } else {
            const materializationEvidence = readFullSuiteRepairTaskMaterializationEvidence({
                repoRoot,
                reviewsRoot,
                taskId,
                fullSuiteArtifactPath,
                childTaskId: params.childTaskId || null,
                childTaskIds: decomposition.child_task_ids
            });
            if (!materializationEvidence.materialized || !materializationEvidence.wip_manifest_path) {
                violations.push(`current full-suite repair materialization evidence is not valid: ${materializationEvidence.reason}`);
            } else {
                const evidenceManifestPath = resolveInputPathInsideRepo(repoRoot, materializationEvidence.wip_manifest_path, 'WipManifestPath');
                if (normalizePath(evidenceManifestPath) !== normalizePath(manifestPath)) {
                    violations.push('ManifestPath is not the current materialized full-suite repair WIP manifest.');
                }
                expectedManifestSha256 = String(materializationEvidence.wip_manifest_sha256 || '').trim();
            }
        }
    }
    let manifestValue: unknown = null;
    try {
        const manifestBytes = readImmutableRegularFileSnapshot({
            repoRoot,
            filePath: manifestPath,
            label: 'WIP manifest restore snapshot'
        }).content;
        const manifestSha256 = createHash('sha256').update(manifestBytes).digest('hex');
        if (!expectedManifestSha256 || manifestSha256 !== expectedManifestSha256) {
            violations.push(
                `WIP manifest changed after materialization validation: expected=${expectedManifestSha256 || 'missing'}; actual=${manifestSha256}.`
            );
        } else {
            manifestValue = JSON.parse(manifestBytes.toString('utf8')) as unknown;
        }
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        violations.push(`WIP manifest snapshot could not be read: ${message}`);
    }
    const parsedManifest = parseRepairWipManifest(repoRoot, manifestPath, manifestValue);
    const manifest = parsedManifest.manifest;
    violations.push(...parsedManifest.violations);
    if (manifest) {
        if (manifest.task_id !== taskId) {
            violations.push(`WIP manifest task_id mismatch: expected=${taskId}; actual=${manifest.task_id}.`);
        }
        violations.push(...validateRepairChildrenDone(repoRoot, manifest.child_task_ids));
        violations.push(...validateParentCanResumeAfterWipRestore(repoRoot, String(manifest.task_id || '')));
        violations.push(...inspectRestoreMutationState(repoRoot, manifest).violations);
    }
    if (violations.length > 0 || !manifest) {
        return {
            status: 'BLOCKED',
            manifest_path: normalizePath(manifestPath),
            restored_files: [],
            violations,
            output_lines: formatFullSuiteRepairOutput({
                repoRoot,
                taskId,
                gate: 'full-suite-repair-wip-restore',
                status: 'BLOCKED',
                action: 'Resolve WIP restore blockers before retrying restore.',
                reason: violations.join(' '),
                detailsPath: manifestPath,
                legacyLines: ['FULL_SUITE_REPAIR_WIP_RESTORE_BLOCKED', ...violations.map((violation) => `Violation: ${violation}`)]
            })
        };
    }
    if (params.dryRun) {
        return {
            status: 'DRY_RUN_OK',
            manifest_path: normalizePath(manifestPath),
            restored_files: [],
            violations: [],
            output_lines: formatFullSuiteRepairOutput({
                repoRoot,
                taskId,
                gate: 'full-suite-repair-wip-restore',
                status: 'DRY_RUN_OK',
                action: 'Run restore without --dry-run when ready to restore parent WIP.',
                reason: 'Dry run verified the WIP manifest can be restored.',
                command: buildRestoreFullSuiteRepairWipCommand({
                    repoRoot,
                    taskId,
                    fullSuiteArtifactPath,
                    manifestPath
                }),
                detailsPath: manifestPath,
                legacyLines: [
                    'FULL_SUITE_REPAIR_WIP_RESTORE_DRY_RUN_OK',
                    `ManifestPath: ${normalizePath(manifestPath)}`,
                    `TrackedFiles: ${manifest.tracked_files.length}`,
                    `UntrackedFiles: ${manifest.untracked_files.length}`
                ]
            })
        };
    }

    const mutationInspection = inspectRestoreMutationState(repoRoot, manifest);
    if (mutationInspection.violations.length > 0) {
        return {
            status: 'BLOCKED',
            manifest_path: normalizePath(manifestPath),
            restored_files: [],
            violations: mutationInspection.violations,
            output_lines: formatFullSuiteRepairOutput({
                repoRoot,
                taskId,
                gate: 'full-suite-repair-wip-restore',
                status: 'BLOCKED',
                action: 'Resolve WIP restore blockers before retrying restore.',
                reason: mutationInspection.violations.join(' '),
                detailsPath: manifestPath,
                legacyLines: [
                    'FULL_SUITE_REPAIR_WIP_RESTORE_BLOCKED',
                    ...mutationInspection.violations.map((violation) => `Violation: ${violation}`)
                ]
            })
        };
    }
    const patchSnapshots = mutationInspection.patchSnapshots;

    const restoredFiles = new Set<string>();
    const createdUntrackedFiles: CapturedUntrackedFileEvidence[] = [];
    let stagedApplied = false;
    let unstagedApplied = false;
    const taskPath = path.join(repoRoot, TASK_QUEUE_FILENAME);
    try {
        const restoreGuardResult = withTaskQueueStatusSyncLock<{
            outcome: 'restored' | 'handoff_changed' | 'lock_failed';
            error_message: string | null;
        }>(
            taskPath,
            (message) => ({
                outcome: 'lock_failed',
                error_message: message
            }),
            () => {
                const handoffViolations = validateCurrentRepairHandoffForRestore(
                    repoRoot,
                    manifest.task_id,
                    manifest.child_task_ids
                );
                if (handoffViolations.length > 0) {
                    return {
                        outcome: 'handoff_changed',
                        error_message: handoffViolations.join(' ')
                    };
                }
                const currentMaterializationEvidence = readFullSuiteRepairTaskMaterializationEvidence({
                    repoRoot,
                    reviewsRoot,
                    taskId: manifest.task_id,
                    fullSuiteArtifactPath,
                    childTaskId: params.childTaskId || null,
                    childTaskIds: manifest.child_task_ids
                });
                if (
                    !currentMaterializationEvidence.materialized
                    || !currentMaterializationEvidence.wip_manifest_path
                ) {
                    return {
                        outcome: 'handoff_changed',
                        error_message:
                            `current full-suite repair materialization evidence is not valid: `
                            + currentMaterializationEvidence.reason
                    };
                }
                const currentManifestPath = resolveInputPathInsideRepo(
                    repoRoot,
                    currentMaterializationEvidence.wip_manifest_path,
                    'WipManifestPath'
                );
                if (
                    normalizePath(currentManifestPath) !== normalizePath(manifestPath)
                    || String(currentMaterializationEvidence.wip_manifest_sha256 || '').trim()
                        !== expectedManifestSha256
                ) {
                    return {
                        outcome: 'handoff_changed',
                        error_message: 'Current materialization evidence no longer matches the validated WIP manifest.'
                    };
                }
                if (hasPatchContent(manifest.patches.staged)) {
                    const stagedPatch = patchSnapshots.staged;
                    if (!stagedPatch) {
                        throw new Error('staged patch validated content snapshot is unavailable.');
                    }
                    runGitWithInput(repoRoot, ['apply', '--check', '--index', '-'], stagedPatch);
                    runGitWithInput(repoRoot, ['apply', '--index', '-'], stagedPatch);
                    stagedApplied = true;
                    for (const entry of manifest.tracked_files.filter((file) => file.staged)) {
                        restoredFiles.add(entry.path);
                    }
                }
                if (hasPatchContent(manifest.patches.unstaged)) {
                    const unstagedPatch = patchSnapshots.unstaged;
                    if (!unstagedPatch) {
                        throw new Error('unstaged patch validated content snapshot is unavailable.');
                    }
                    runGitWithInput(repoRoot, ['apply', '--check', '-'], unstagedPatch);
                    runGitWithInput(repoRoot, ['apply', '-'], unstagedPatch);
                    unstagedApplied = true;
                    for (const entry of manifest.tracked_files.filter((file) => file.unstaged)) {
                        restoredFiles.add(entry.path);
                    }
                }
                for (const entry of manifest.untracked_files) {
                    restoreContainedUntrackedFile({ repoRoot, entry });
                    createdUntrackedFiles.push(entry);
                    restoredFiles.add(entry.path);
                }
                return {
                    outcome: 'restored',
                    error_message: null
                };
            }
        );
        if (restoreGuardResult.outcome !== 'restored') {
            throw new Error(
                `repair handoff changed before WIP restore: ${restoreGuardResult.outcome}`
                + `${restoreGuardResult.error_message ? ` (${restoreGuardResult.error_message})` : ''}.`
            );
        }
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        const rollbackViolations = rollbackFullSuiteRepairRestore({
            repoRoot,
            manifest,
            patchSnapshots,
            stagedApplied,
            unstagedApplied,
            createdUntrackedFiles
        });
        const restoreViolations = [`restore transaction failed: ${message}`, ...rollbackViolations];
        return buildRestoreTransactionBlockedResult({
            repoRoot,
            taskId,
            manifestPath,
            restoredFiles,
            violations: restoreViolations,
            rollbackIncomplete: rollbackViolations.length > 0
        });
    }
    let parentResume: ParentResumeStatusResult;
    try {
        parentResume = resumeParentTaskAfterWipRestore(
            repoRoot,
            manifest.task_id,
            manifest.child_task_ids
        );
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        const rollbackViolations = rollbackFullSuiteRepairRestore({
            repoRoot,
            manifest,
            patchSnapshots,
            stagedApplied,
            unstagedApplied,
            createdUntrackedFiles
        });
        return buildRestoreTransactionBlockedResult({
            repoRoot,
            taskId,
            manifestPath,
            restoredFiles,
            violations: [`parent status sync failed: ${message}`, ...rollbackViolations],
            rollbackIncomplete: rollbackViolations.length > 0
        });
    }
    if (parentResume.outcome !== 'updated' && parentResume.outcome !== 'already_synced') {
        const rollbackViolations = rollbackFullSuiteRepairRestore({
            repoRoot,
            manifest,
            patchSnapshots,
            stagedApplied,
            unstagedApplied,
            createdUntrackedFiles
        });
        const restoreViolations = [
            `parent status sync failed: ${parentResume.outcome}${parentResume.error_message ? ` (${parentResume.error_message})` : ''}`,
            ...rollbackViolations
        ];
        try {
            appendMandatoryTaskEvent(
                joinOrchestratorPath(repoRoot, ''),
                manifest.task_id,
                'FULL_SUITE_REPAIR_WIP_RESTORE_ROLLED_BACK',
                'BLOCKED',
                'Full-suite repair parent WIP restore rolled back after parent status sync failure.',
                {
                    manifest_path: normalizePath(manifestPath),
                    child_task_ids: manifest.child_task_ids,
                    restored_files: [...restoredFiles].sort(),
                    parent_status_sync: parentResume,
                    rollback_violations: rollbackViolations
                },
                { actor: 'orchestrator' }
            );
        } catch (eventError: unknown) {
            const eventMessage = eventError instanceof Error ? eventError.message : String(eventError);
            restoreViolations.push(`failed to record rolled-back restore event: ${eventMessage}`);
        }
        return buildRestoreTransactionBlockedResult({
            repoRoot,
            taskId,
            manifestPath,
            restoredFiles,
            violations: restoreViolations,
            rollbackIncomplete: rollbackViolations.length > 0
        });
    }
    try {
        appendMandatoryTaskEvent(
            joinOrchestratorPath(repoRoot, ''),
            manifest.task_id,
            'FULL_SUITE_REPAIR_WIP_RESTORED',
            'PASS',
            'Full-suite repair parent WIP restored after all repair children completed.',
            {
                manifest_path: normalizePath(manifestPath),
                child_task_ids: manifest.child_task_ids,
                restored_files: [...restoredFiles].sort(),
                parent_status_sync: parentResume
            },
            { actor: 'orchestrator' }
        );
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        const wipRollbackViolations = rollbackFullSuiteRepairRestore({
            repoRoot,
            manifest,
            patchSnapshots,
            stagedApplied,
            unstagedApplied,
            createdUntrackedFiles
        });
        const statusRollbackViolations = rollbackParentTaskStatusAfterWipRestore(
            repoRoot,
            manifest.task_id,
            parentResume
        );
        const rollbackViolations = [...wipRollbackViolations, ...statusRollbackViolations];
        return buildRestoreTransactionBlockedResult({
            repoRoot,
            taskId,
            manifestPath,
            restoredFiles,
            violations: [
                `mandatory restored-event append failed: ${message}`,
                ...rollbackViolations
            ],
            rollbackIncomplete: rollbackViolations.length > 0
        });
    }

    return {
        status: 'RESTORED',
        manifest_path: normalizePath(manifestPath),
        restored_files: [...restoredFiles].sort(),
        violations: [],
        output_lines: formatFullSuiteRepairOutput({
            repoRoot,
            taskId,
            gate: 'full-suite-repair-wip-restore',
            status: 'RESTORED',
            action: 'Continue the parent task through the navigator.',
            reason: 'Full-suite repair parent WIP restored after all repair children completed.',
            detailsPath: manifestPath,
            legacyLines: [
                'FULL_SUITE_REPAIR_WIP_RESTORED',
                `ManifestPath: ${normalizePath(manifestPath)}`,
                `RestoredFiles: ${[...restoredFiles].sort().join(', ') || 'none'}`,
                `ParentStatusSync: ${parentResume.outcome}${parentResume.error_message ? ` (${parentResume.error_message})` : ''}`
            ]
        })
    };
}

function buildRestoreLockBlockedResult(params: {
    repoRoot: string;
    taskId: string;
    manifestPath: string;
    violation: string;
}): FullSuiteRepairWipRestoreResult {
    return {
        status: 'BLOCKED',
        manifest_path: normalizePath(params.manifestPath),
        restored_files: [],
        violations: [params.violation],
        output_lines: formatFullSuiteRepairOutput({
            repoRoot: params.repoRoot,
            taskId: params.taskId,
            gate: 'full-suite-repair-wip-restore',
            status: 'BLOCKED',
            action: 'Resolve the restore lock blocker before retrying WIP restore.',
            reason: params.violation,
            detailsPath: params.manifestPath,
            legacyLines: [
                'FULL_SUITE_REPAIR_WIP_RESTORE_BLOCKED',
                `Violation: ${params.violation}`
            ]
        })
    };
}

export function restoreFullSuiteRepairWip(params: RestoreFullSuiteRepairWipParams): FullSuiteRepairWipRestoreResult {
    const repoRoot = path.resolve(params.repoRoot || '.');
    let manifestPath = '';
    try {
        manifestPath = resolveInputPathInsideRepo(repoRoot, params.manifestPath, 'ManifestPath');
    } catch {
        return restoreFullSuiteRepairWipUnlocked(params);
    }
    const containmentViolations = validatePhysicalRepoContainment(repoRoot, manifestPath, 'ManifestPath');
    if (containmentViolations.length > 0) {
        return buildRestoreLockBlockedResult({
            repoRoot,
            taskId: params.taskId,
            manifestPath,
            violation: `restore lock containment failed: ${containmentViolations.join(' ')}`
        });
    }
    let canonicalManifestPath = '';
    try {
        if (!fs.existsSync(manifestPath) || !fs.statSync(manifestPath).isFile()) {
            return restoreFullSuiteRepairWipUnlocked(params);
        }
        canonicalManifestPath = fs.realpathSync.native(manifestPath);
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return buildRestoreLockBlockedResult({
            repoRoot,
            taskId: params.taskId,
            manifestPath,
            violation: `restore lock manifest inspection failed: ${message}`
        });
    }
    const lockPath = `${canonicalManifestPath}.restore.lock`;
    const lockContainmentViolations = validatePhysicalRepoContainment(repoRoot, lockPath, 'restore lock path');
    if (lockContainmentViolations.length > 0) {
        return buildRestoreLockBlockedResult({
            repoRoot,
            taskId: params.taskId,
            manifestPath,
            violation: `restore lock containment failed: ${lockContainmentViolations.join(' ')}`
        });
    }
    try {
        return withFilesystemLock(lockPath, {
            ownerLabel: `full-suite-repair-wip-restore:${String(params.taskId || '').trim() || 'unknown'}`,
            timeoutMs: 5000
        }, () => restoreFullSuiteRepairWipUnlocked(params)).result;
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return buildRestoreLockBlockedResult({
            repoRoot,
            taskId: params.taskId,
            manifestPath,
            violation: `restore lock acquisition failed: ${message}`
        });
    }
}
