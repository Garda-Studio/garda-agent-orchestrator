import * as fs from 'node:fs';
import * as path from 'node:path';
import { TASK_QUEUE_FILENAME } from '../../core/orchestration-constants';
import { pathExists, readTextFile } from '../../core/filesystem';
import { formatJson } from '../../core/json';
import {
    bindContainedDestination,
    ensureContainedDirectory,
    removeContainedPath,
    writeContainedFile
} from '../../core/contained-filesystem';
import {
    INSTALL_BACKUP_CANDIDATE_PATHS,
    MANAGED_END,
    MANAGED_START,
    buildTaskContentWithExistingQueue,
    syncManagedBlockInContent
} from '../content-builders';
import {
    applyMaterializationStage,
    createCopyFileStage,
    createRemoveFileStage,
    createWriteTextFileStage
} from '../staged-side-effects';
import { withLifecycleRuntimeMutationGenerationForPath } from '../../lifecycle/runtime-mutation-generation';
import type {
    InstallFilesystemStage,
    InstallStageMetrics
} from './install-contracts';

export interface CreateInstallFilesystemStageOptions {
    targetRoot: string;
    backupRoot: string;
    dryRun: boolean;
    skipBackups: boolean;
    deploymentDate: string;
    canonicalEntryFile: string;
}

export function escapeInstallRegex(text: string): string {
    return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function createInstallFilesystemStage(
    options: CreateInstallFilesystemStageOptions
): InstallFilesystemStage {
    const {
        targetRoot,
        backupRoot,
        dryRun,
        skipBackups,
        deploymentDate,
        canonicalEntryFile
    } = options;
    const metrics: InstallStageMetrics = {
        deployed: 0,
        backedUp: 0,
        skippedExisting: 0,
        aligned: 0,
        forcedOverwrites: 0
    };
    const backedUpSet = new Set<string>();

    function applyStage(stage: Parameters<typeof applyMaterializationStage>[0]): void {
        applyMaterializationStage(stage, { dryRun });
    }

    function writeTextFile(filePath: string, content: string): void {
        applyStage(createWriteTextFileStage(filePath, content, targetRoot));
    }

    function copyFile(sourcePath: string, destinationPath: string): void {
        applyStage(createCopyFileStage(sourcePath, destinationPath, targetRoot));
    }

    function removeFile(filePath: string): void {
        applyStage(createRemoveFileStage(filePath, targetRoot));
    }

    function writeBackupManifest(timestamp: string): void {
        const preExistingPaths = INSTALL_BACKUP_CANDIDATE_PATHS
            .filter((relativePath) => pathExists(path.join(targetRoot, relativePath)))
            .sort();
        if (skipBackups || dryRun || preExistingPaths.length === 0) {
            return;
        }
        const manifestPath = path.join(backupRoot, '_install-backup.manifest.json');
        withLifecycleRuntimeMutationGenerationForPath(
            manifestPath,
            'lifecycle-install-backup-manifest-write',
            () => {
                writeContainedFile(targetRoot, manifestPath, formatJson({
                    Version: 1,
                    CreatedAt: timestamp,
                    PreExistingFiles: preExistingPaths
                }));
            }
        );
    }

    function backupFile(destPath: string, relativePath: string): void {
        if (skipBackups || !pathExists(destPath)) return;
        const key = relativePath.toLowerCase().replace(/\\/g, '/');
        if (backedUpSet.has(key)) return;
        const backupPath = path.join(backupRoot, relativePath);
        if (dryRun) {
            copyFile(destPath, backupPath);
        } else {
            withLifecycleRuntimeMutationGenerationForPath(
                backupPath,
                'lifecycle-install-backup-file-write',
                () => copyFile(destPath, backupPath)
            );
        }
        metrics.backedUp++;
        backedUpSet.add(key);
    }

    function syncManagedBlockOnDisk(
        destPath: string,
        relativePath: string,
        managedBlock: string
    ): boolean {
        if (!pathExists(destPath)) return false;
        const content = readTextFile(destPath);
        const result = syncManagedBlockInContent(content, managedBlock);
        if (!result.changed) return false;
        backupFile(destPath, relativePath);
        writeTextFile(destPath, result.content);
        return true;
    }

    function syncTaskFileOnDisk(
        destPath: string,
        relativePath: string,
        templateContent: string
    ): boolean {
        if (!pathExists(destPath)) return false;
        const content = readTextFile(destPath);
        const nextContent = buildTaskContentWithExistingQueue(templateContent, content);
        if (!nextContent || nextContent === content) return false;
        backupFile(destPath, relativePath);
        writeTextFile(destPath, nextContent);
        return true;
    }

    function removeEmptyParentDirectories(startDir: string): void {
        let current = path.resolve(startDir);
        const root = path.resolve(targetRoot);
        while (current !== root) {
            const relative = path.relative(root, current);
            if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
                return;
            }
            bindContainedDestination(targetRoot, current);
            if (
                !pathExists(current)
                || !fs.statSync(current).isDirectory()
                || fs.readdirSync(current).length > 0
            ) {
                return;
            }
            removeContainedPath(targetRoot, current);
            current = path.dirname(current);
        }
    }

    function removeManagedBlockOrFileOnDisk(
        destPath: string,
        relativePath: string
    ): boolean {
        if (!pathExists(destPath) || !fs.statSync(destPath).isFile()) return false;
        const content = readTextFile(destPath);
        const pattern = new RegExp(
            `${escapeInstallRegex(MANAGED_START)}[\\s\\S]*?${escapeInstallRegex(MANAGED_END)}`,
            'm'
        );
        if (!pattern.test(content)) return false;
        const nextContent = content.replace(pattern, '').trim();
        backupFile(destPath, relativePath);
        if (!dryRun) {
            if (nextContent) {
                writeTextFile(
                    destPath,
                    `${nextContent}${content.includes('\r\n') ? '\r\n' : '\n'}`
                );
            } else {
                removeFile(destPath);
                removeEmptyParentDirectories(path.dirname(destPath));
            }
        }
        return true;
    }

    function applyEntrypointManagedBlock(relativePath: string, managedBlock: string): void {
        const destPath = path.join(targetRoot, relativePath);
        if (!pathExists(destPath)) {
            if (!dryRun) {
                ensureContainedDirectory(targetRoot, path.dirname(destPath));
                writeTextFile(destPath, `${managedBlock}\r\n`);
            }
            metrics.deployed++;
            return;
        }
        if (syncManagedBlockOnDisk(destPath, relativePath, managedBlock)) {
            metrics.aligned++;
        }
    }

    function getTemplateContent(sourcePath: string, relativePath: string): string | null {
        if (!pathExists(sourcePath)) return null;
        let content = readTextFile(sourcePath);
        if (!content || !content.trim()) return null;
        const normalizedRelativePath = relativePath.replace(/\\/g, '/');
        if (normalizedRelativePath === TASK_QUEUE_FILENAME) {
            content = content.replaceAll('{{DEPLOYMENT_DATE}}', deploymentDate);
            content = content.replaceAll('{{CANONICAL_ENTRYPOINT}}', canonicalEntryFile);
        }
        return content;
    }

    return {
        metrics,
        writeBackupManifest,
        backupFile,
        syncManagedBlockOnDisk,
        syncTaskFileOnDisk,
        removeManagedBlockOrFileOnDisk,
        applyEntrypointManagedBlock,
        getTemplateContent,
        writeTextFile
    };
}
