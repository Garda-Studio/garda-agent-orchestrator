import * as fs from 'node:fs';
import * as path from 'node:path';

import { pathExists } from '../core/filesystem';
import {
    assertContainedDestination,
    assertExistingPathIdentity,
    bindContainedDestination,
    copyContainedFile,
    removeContainedPath,
    writeContainedFile
} from '../core/contained-filesystem';

export interface MaterializationStage {
    readonly label: string;
    readonly apply: () => void;
    readonly rollback?: () => void;
}

export interface MaterializationStageExecution {
    readonly label: string;
    readonly status: 'applied' | 'dry-run';
}

export interface ApplyMaterializationStageOptions {
    readonly dryRun?: boolean;
}

export function applyMaterializationStage(
    stage: MaterializationStage,
    options: ApplyMaterializationStageOptions = {}
): MaterializationStageExecution {
    if (options.dryRun) {
        return { label: stage.label, status: 'dry-run' };
    }

    try {
        stage.apply();
        return { label: stage.label, status: 'applied' };
    } catch (error: unknown) {
        try {
            stage.rollback?.();
        } catch (rollbackError: unknown) {
            const applyMessage = error instanceof Error ? error.message : String(error);
            const rollbackMessage = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
            throw new Error(
                `Materialization stage '${stage.label}' failed: ${applyMessage}; rollback failed: ${rollbackMessage}`
            );
        }
        throw error;
    }
}

export function createWriteTextFileStage(filePath: string, content: string, root = path.parse(filePath).root): MaterializationStage {
    const destination = bindContainedDestination(root, filePath);
    const parent = bindContainedDestination(root, path.dirname(filePath));
    let replacementOccurred = false;
    let replacement: ReturnType<typeof bindContainedDestination> | null = null;
    const existedBefore = pathExists(filePath);
    const previousContent = existedBefore ? fs.readFileSync(filePath, 'utf8') : null;
    const existingParentBoundary = findExistingParent(path.dirname(filePath));
    return {
        label: `write:${normalizeStagePath(filePath)}`,
        apply: () => {
            assertContainedDestination(destination);
            writeContainedFile(root, filePath, content, () => {
                replacementOccurred = true;
                replacement = bindContainedDestination(root, filePath);
            });
        },
        rollback: () => {
            if (!replacementOccurred) return;
            if (!replacement) throw new Error(`Cannot authenticate written destination for rollback: ${filePath}`);
            assertContainedDestination(replacement);
            assertExistingPathIdentity(parent);
            if (existedBefore) {
                writeContainedFile(root, filePath, previousContent ?? '');
            } else {
                removeContainedPath(root, filePath);
                removeEmptyParents(root, path.dirname(filePath), existingParentBoundary);
            }
        }
    };
}

export function createCopyFileStage(
    sourcePath: string, destinationPath: string, root = path.parse(destinationPath).root
): MaterializationStage {
    const destination = bindContainedDestination(root, destinationPath);
    const parent = bindContainedDestination(root, path.dirname(destinationPath));
    let replacementOccurred = false;
    let replacement: ReturnType<typeof bindContainedDestination> | null = null;
    const existedBefore = pathExists(destinationPath);
    const previousContent = existedBefore ? fs.readFileSync(destinationPath) : null;
    const existingParentBoundary = findExistingParent(path.dirname(destinationPath));
    return {
        label: `copy:${normalizeStagePath(sourcePath)}->${normalizeStagePath(destinationPath)}`,
        apply: () => {
            assertContainedDestination(destination);
            copyContainedFile(root, sourcePath, destinationPath, () => {
                replacementOccurred = true;
                replacement = bindContainedDestination(root, destinationPath);
            });
        },
        rollback: () => {
            if (!replacementOccurred) return;
            if (!replacement) throw new Error(`Cannot authenticate copied destination for rollback: ${destinationPath}`);
            assertContainedDestination(replacement);
            assertExistingPathIdentity(parent);
            if (existedBefore && previousContent) {
                writeContainedFile(root, destinationPath, previousContent);
            } else {
                removeContainedPath(root, destinationPath);
                removeEmptyParents(root, path.dirname(destinationPath), existingParentBoundary);
            }
        }
    };
}

export function createRemoveFileStage(filePath: string, root = path.parse(filePath).root): MaterializationStage {
    const destination = bindContainedDestination(root, filePath);
    const parent = bindContainedDestination(root, path.dirname(filePath));
    let removed = false;
    const existedBefore = pathExists(filePath);
    const previousContent = existedBefore && fs.statSync(filePath).isFile()
        ? fs.readFileSync(filePath)
        : null;
    return {
        label: `remove:${normalizeStagePath(filePath)}`,
        apply: () => {
            assertContainedDestination(destination);
            removeContainedPath(root, filePath, false, () => { removed = true; });
        },
        rollback: () => {
            if (!removed) return;
            assertExistingPathIdentity(parent);
            if (existedBefore && previousContent) {
                assertAbsentForRollback(filePath);
                writeContainedFile(root, filePath, previousContent);
            }
        }
    };
}

function assertAbsentForRollback(filePath: string): void {
    try {
        fs.lstatSync(filePath);
    } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
    }
    throw new Error(`Destination was replaced before rollback: ${filePath}`);
}

function normalizeStagePath(filePath: string): string {
    return path.resolve(filePath).replace(/\\/g, '/');
}

function findExistingParent(startDir: string): string {
    let current = path.resolve(startDir);
    while (!pathExists(current)) {
        const next = path.dirname(current);
        if (next === current) {
            return current;
        }
        current = next;
    }
    return current;
}

function removeEmptyParents(root: string, startDir: string, boundaryDir: string): void {
    let current = path.resolve(startDir);
    const boundary = path.resolve(boundaryDir);
    while (true) {
        bindContainedDestination(root, current);
        if (!pathExists(current) || !fs.statSync(current).isDirectory() || fs.readdirSync(current).length !== 0) {
            return;
        }
        if (current === boundary) {
            return;
        }
        const next = path.dirname(current);
        if (next === current) {
            return;
        }
        removeContainedPath(root, current);
        current = next;
    }
}
