import * as fs from 'node:fs';
import * as path from 'node:path';
import { TASK_QUEUE_FILENAME } from '../../core/orchestration-constants';
import { withTaskQueueTransaction, writeTaskQueueFile } from '../../core/task-queue/task-queue-repository';
import { ensureDirectory, pathExists, readTextFile } from '../../core/filesystem';
import {
    buildTaskContentWithExistingQueue,
    getTaskQueueTableRange,
    setTaskQueueRowsInManagedBlock
} from '../content-builders';
import type { InstallFilesystemStage } from './install-contracts';

export interface RunInstallTaskStageOptions {
    sourceRoot: string;
    targetRoot: string;
    dryRun: boolean;
    preserveExisting: boolean;
    answerDependentOnly: boolean;
    filesystem: InstallFilesystemStage;
}

function inspectSafeTaskFile(taskPath: string, targetRoot: string): boolean {
    const resolvedTargetRoot = path.resolve(targetRoot);
    const resolvedTaskPath = path.resolve(taskPath);
    const relativePath = path.relative(resolvedTargetRoot, resolvedTaskPath);
    if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
        throw new Error(`GARDA_INSTALL_BLOCKED: TASK.md escapes target root: ${taskPath}`);
    }

    let stats: fs.Stats;
    try {
        stats = fs.lstatSync(taskPath);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return false;
        }
        throw error;
    }
    if (stats.isSymbolicLink() || !stats.isFile()) {
        throw new Error(`GARDA_INSTALL_BLOCKED: TASK.md must be a regular file inside target root: ${taskPath}`);
    }
    return true;
}

function buildTaskContentPreservingExplicitEmptyQueue(
    templateContent: string,
    existingContent: string
): string | null {
    const nextContent = buildTaskContentWithExistingQueue(templateContent, existingContent);
    if (!nextContent) return null;

    const existingQueue = getTaskQueueTableRange(existingContent);
    if (existingQueue && existingQueue.rowsStartIndex === existingQueue.rowsEndIndex) {
        return setTaskQueueRowsInManagedBlock(nextContent, []);
    }
    return nextContent;
}

export function runInstallTaskStage(options: RunInstallTaskStageOptions): void {
    if (options.dryRun) return runInstallTaskStageLocked(options);
    ensureDirectory(options.targetRoot);
    const taskPath = path.join(options.targetRoot, TASK_QUEUE_FILENAME);
    return withTaskQueueTransaction(taskPath, (message) => { throw new Error(message); }, () => (
        runInstallTaskStageLocked({
            ...options,
            filesystem: {
                ...options.filesystem,
                writeTextFile: (filePath, content) => {
                    if (path.resolve(filePath) !== path.resolve(taskPath)) {
                        throw new Error('Task installation attempted to write a non-queue path.');
                    }
                    writeTaskQueueFile(filePath, content);
                }
            }
        })
    ));
}

function runInstallTaskStageLocked(options: RunInstallTaskStageOptions): void {
    const {
        sourceRoot,
        targetRoot,
        dryRun,
        preserveExisting,
        answerDependentOnly,
        filesystem
    } = options;
    const { metrics } = filesystem;

    if (!answerDependentOnly) {
        for (const relativePath of [TASK_QUEUE_FILENAME]) {
            const sourcePath = path.join(sourceRoot, relativePath);
            if (!pathExists(sourcePath)) continue;
            const destPath = path.join(targetRoot, relativePath);
            const destDir = path.dirname(destPath);
            if (!pathExists(destDir) && !dryRun) {
                ensureDirectory(destDir);
            }

            if (inspectSafeTaskFile(destPath, targetRoot)) {
                if (!dryRun) {
                    filesystem.backupFile(destPath, relativePath);
                }
                const templateContent = filesystem.getTemplateContent(sourcePath, relativePath);
                if (templateContent !== null) {
                    const existingContent = readTextFile(destPath);
                    const nextContent = buildTaskContentPreservingExplicitEmptyQueue(
                        templateContent,
                        existingContent
                    );
                    if (preserveExisting) metrics.skippedExisting++;
                    if (nextContent && nextContent !== existingContent) {
                        if (!dryRun) {
                            filesystem.writeTextFile(destPath, nextContent);
                        }
                        metrics.aligned++;
                    }
                    if (!preserveExisting) metrics.deployed++;
                }
                continue;
            }

            const content = filesystem.getTemplateContent(sourcePath, relativePath);
            if (content && !dryRun) {
                filesystem.writeTextFile(destPath, content);
            }
            metrics.deployed++;
        }
        return;
    }

    const taskSourcePath = path.join(sourceRoot, TASK_QUEUE_FILENAME);
    const taskDestPath = path.join(targetRoot, TASK_QUEUE_FILENAME);
    if (!pathExists(taskSourcePath)) {
        return;
    }
    if (inspectSafeTaskFile(taskDestPath, targetRoot)) {
        if (!dryRun) {
            filesystem.backupFile(taskDestPath, TASK_QUEUE_FILENAME);
        }
        const templateContent = filesystem.getTemplateContent(
            taskSourcePath,
            TASK_QUEUE_FILENAME
        );
        if (templateContent !== null) {
            if (dryRun) {
                const existingContent = readTextFile(taskDestPath);
                const nextContent = buildTaskContentPreservingExplicitEmptyQueue(
                    templateContent,
                    existingContent
                );
                if (nextContent && nextContent !== existingContent) {
                    metrics.aligned++;
                }
            } else {
                const existingContent = readTextFile(taskDestPath);
                const nextContent = buildTaskContentPreservingExplicitEmptyQueue(
                    templateContent,
                    existingContent
                );
                if (nextContent && nextContent !== existingContent) {
                    filesystem.writeTextFile(taskDestPath, nextContent);
                    metrics.aligned++;
                }
            }
        }
        return;
    }
    if (!dryRun) {
        ensureDirectory(path.dirname(taskDestPath));
        const content = filesystem.getTemplateContent(taskSourcePath, TASK_QUEUE_FILENAME);
        if (content) {
            filesystem.writeTextFile(taskDestPath, content);
        }
    }
    metrics.deployed++;
}
