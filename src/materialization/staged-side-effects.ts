import * as fs from 'node:fs';
import * as path from 'node:path';

import { pathExists } from '../core/filesystem';
import {
    assertContainedDestination,
    assertExistingPathIdentity,
    bindContainedDestination,
    copyContainedFile,
    ensureContainedDirectory,
    removeBoundContainedPath,
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
    const createdParents: ReturnType<typeof bindContainedDestination>[] = [];
    const existedBefore = pathExists(filePath);
    const previousContent = existedBefore ? fs.readFileSync(filePath, 'utf8') : null;
    return {
        label: `write:${normalizeStagePath(filePath)}`,
        apply: () => {
            assertContainedDestination(destination);
            ensureContainedDirectory(root, path.dirname(filePath), (binding) => {
                createdParents.unshift(binding);
            });
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
                removeBoundContainedPath(replacement);
                removeEmptyParents(createdParents);
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
    const createdParents: ReturnType<typeof bindContainedDestination>[] = [];
    const existedBefore = pathExists(destinationPath);
    const previousContent = existedBefore ? fs.readFileSync(destinationPath) : null;
    return {
        label: `copy:${normalizeStagePath(sourcePath)}->${normalizeStagePath(destinationPath)}`,
        apply: () => {
            assertContainedDestination(destination);
            ensureContainedDirectory(root, path.dirname(destinationPath), (binding) => {
                createdParents.unshift(binding);
            });
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
                removeBoundContainedPath(replacement);
                removeEmptyParents(createdParents);
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
            removeBoundContainedPath(destination, false, () => { removed = true; });
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

function removeEmptyParents(parents: readonly ReturnType<typeof bindContainedDestination>[]): void {
    for (const binding of parents) {
        assertContainedDestination(binding);
        if (fs.readdirSync(binding.path).length !== 0) return;
        removeBoundContainedPath(binding);
    }
}
