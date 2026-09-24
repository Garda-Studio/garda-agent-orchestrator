import * as fs from 'node:fs';
import * as path from 'node:path';
import { TASK_QUEUE_FILENAME } from '../../core/orchestration-constants';
import { pathExists } from '../../core/filesystem';
import { bindContainedDestination, copyContainedFile, ensureContainedDirectory } from '../../core/contained-filesystem';
import {
    ALL_AGENT_ENTRYPOINT_FILES
} from '../../core/constants';
import {
    getGitHubSkillBridgeProfileDefinitions,
    getLegacyManagedGitignoreEntries,
    getProviderOrchestratorProfileDefinitions,
    SHARED_START_TASK_WORKFLOW_RELATIVE_PATH
} from '../common';
import type { SourceInventory } from './init-contracts';

export interface CopyDirectoryOptions {
    shouldCopyFile?: (srcPath: string, destPath: string) => boolean;
    destinationRoot?: string;
}

export function copyDirectoryRecursive(
    srcDir: string,
    destDir: string,
    options?: CopyDirectoryOptions
): void {
    const destinationRoot = options?.destinationRoot ?? path.parse(path.resolve(destDir)).root;
    const sourceRoot = path.parse(path.resolve(srcDir)).root;
    const directories: string[] = [];
    const files: Array<{ source: string; destination: string }> = [];
    const stack = [{ source: srcDir, destination: destDir }];
    while (stack.length > 0) {
        const current = stack.pop()!;
        bindContainedDestination(sourceRoot, current.source);
        bindContainedDestination(destinationRoot, current.destination);
        const sourceStat = fs.lstatSync(current.source);
        if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
            throw new Error(`Copy source is not an ordinary directory: ${current.source}`);
        }
        directories.push(current.destination);
        for (const entry of fs.readdirSync(current.source, { withFileTypes: true })) {
            const source = path.join(current.source, entry.name);
            const destination = path.join(current.destination, entry.name);
            if (entry.isDirectory()) {
                stack.push({ source, destination });
                continue;
            }
            bindContainedDestination(sourceRoot, source);
            bindContainedDestination(destinationRoot, destination);
            const stat = fs.lstatSync(source);
            if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
                throw new Error(`Copy source is linked or not an ordinary file: ${source}`);
            }
            if (!options?.shouldCopyFile || options.shouldCopyFile(source, destination)) {
                files.push({ source, destination });
            }
        }
    }
    for (const directory of directories.sort((left, right) => left.length - right.length)) {
        ensureContainedDirectory(destinationRoot, directory);
    }
    for (const file of files) copyContainedFile(destinationRoot, file.source, file.destination);
}

function collectMarkdownFiles(rootPath: string, targetRoot: string): string[] {
    if (!pathExists(rootPath)) {
        return [];
    }

    const discovered: string[] = [];
    const stack: string[] = [rootPath];

    while (stack.length > 0) {
        const currentPath = stack.pop();
        if (!currentPath) {
            continue;
        }
        const entries = fs.readdirSync(currentPath, { withFileTypes: true });

        for (const entry of entries) {
            const fullPath = path.join(currentPath, entry.name);
            if (entry.isDirectory()) {
                stack.push(fullPath);
                continue;
            }

            if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== '.md') {
                continue;
            }

            discovered.push(path.relative(targetRoot, fullPath).replace(/\\/g, '/'));
        }
    }

    return discovered.sort();
}

export function collectSourceInventory(targetRoot: string): SourceInventory {
    const entrypointCandidates = new Set([
        ...ALL_AGENT_ENTRYPOINT_FILES,
        TASK_QUEUE_FILENAME,
        SHARED_START_TASK_WORKFLOW_RELATIVE_PATH,
        '.qwen/settings.json',
        ...getLegacyManagedGitignoreEntries()
    ]);

    for (const profile of getProviderOrchestratorProfileDefinitions()) {
        entrypointCandidates.add(profile.orchestratorRelativePath);
    }
    for (const profile of getGitHubSkillBridgeProfileDefinitions()) {
        entrypointCandidates.add(profile.relativePath);
    }

    const sortedEntrypoints = [...entrypointCandidates].sort();
    const legacyRuleRoot = path.join(targetRoot, 'docs', 'agent-rules');
    const docsRoot = path.join(targetRoot, 'docs');

    return {
        projectRoot: targetRoot.replace(/\\/g, '/'),
        legacyEntrypoints: sortedEntrypoints.map((relativePath) => ({
            path: relativePath.replace(/\\/g, '/'),
            exists: pathExists(path.join(targetRoot, relativePath))
        })),
        legacyRuleRoot: 'docs/agent-rules',
        legacyRuleFiles: collectMarkdownFiles(legacyRuleRoot, targetRoot),
        docsMarkdownFiles: collectMarkdownFiles(docsRoot, targetRoot)
    };
}

export function buildSourceInventoryLines(
    inventory: SourceInventory,
    timestampIso: string
): string[] {
    return [
        '# Source Inventory', '',
        `Generated at: ${timestampIso}`,
        `Project root: ${inventory.projectRoot}`, '',
        '## Legacy Entrypoints',
        ...inventory.legacyEntrypoints.map((entry) => `- \`${entry.path}\` : ${entry.exists ? 'FOUND' : 'MISSING'}`),
        '',
        '## Legacy Rule Sources',
        `- \`${inventory.legacyRuleRoot}\` : ${inventory.legacyRuleFiles.length > 0 ? 'FOUND' : 'MISSING'} (files=${inventory.legacyRuleFiles.length})`,
        ...inventory.legacyRuleFiles.slice(0, 20).map((filePath) => `- \`${filePath}\``),
        '',
        '## Documentation Snapshot',
        `- Markdown files in \`docs/\`: ${inventory.docsMarkdownFiles.length}`,
        ...inventory.docsMarkdownFiles.slice(0, 20).map((filePath) => `- \`${filePath}\``)
    ];
}
