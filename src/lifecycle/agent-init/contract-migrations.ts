import * as fs from 'node:fs';
import * as path from 'node:path';
import { UNCONFIGURED_COMPILE_GATE_COMMAND, resolveBundleName } from '../../core/constants';
import { pathExists, readTextFile } from '../../core/filesystem';
import { isPlainObject } from '../../core/config-merge';
import { writeJsonFile } from '../../core/json';
import {
    getWorkflowConfigPath,
    isConfiguredCompileGateCommand,
    readWorkflowConfigForMerge
} from '../../core/workflow-config';
import { getTaskModeRuleSectionMigrations, RuleContractSectionMigration } from '../../materialization/rule-contracts';
import { validateCompileGateCommand } from '../../gates/compile/compile-gate';

export interface ContractMigrationResult {
    appliedCount: number;
    appliedFiles: string[];
}

export interface ContractMigrationOptions {
    rootPath: string;
    preservedCompileGateCommand?: string | null;
}

function escapeRegex(text: string): string {
    return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function detectNewline(content: string): string {
    return content.includes('\r\n') ? '\r\n' : '\n';
}

function normalizeNewlines(content: string, newline: string): string {
    return content.replace(/\r?\n/g, newline);
}

function getHeadingLevel(heading: string): number {
    const headingPrefixMatch = heading.trim().match(/^(#+)\s+/);
    if (!headingPrefixMatch) {
        throw new Error(`Contract migration heading must be a markdown heading: '${heading}'.`);
    }
    return headingPrefixMatch[1].length;
}

function getSectionBounds(content: string, heading: string): { start: number; end: number } | null {
    const headingPattern = new RegExp(`^${escapeRegex(heading)}\\s*$`, 'm');
    const headingMatch = headingPattern.exec(content);
    if (!headingMatch) {
        return null;
    }

    const headingLevel = getHeadingLevel(heading);

    const sectionStart = headingMatch.index;
    const searchStart = sectionStart + headingMatch[0].length;
    const remainder = content.slice(searchStart);
    const nextHeadingPattern = new RegExp(`^#{1,${headingLevel}}\\s+`, 'm');
    const nextHeadingMatch = nextHeadingPattern.exec(remainder);
    const sectionEnd = nextHeadingMatch
        ? searchStart + nextHeadingMatch.index
        : content.length;

    return { start: sectionStart, end: sectionEnd };
}

function extractSectionOrThrow(content: string, heading: string, sourcePath: string): string {
    const bounds = getSectionBounds(content, heading);
    if (!bounds) {
        throw new Error(`Contract migration template section '${heading}' not found in '${sourcePath}'.`);
    }
    return content.slice(bounds.start, bounds.end).trim();
}

function getMissingSectionSnippets(content: string, migration: RuleContractSectionMigration): string[] {
    const bounds = getSectionBounds(content, migration.heading);
    if (!bounds) {
        return [...migration.requiredSnippets];
    }

    const sectionContent = content.slice(bounds.start, bounds.end);
    return migration.requiredSnippets.filter((snippet) => !sectionContent.includes(snippet));
}

function normalizeComparableSection(content: string): string {
    return normalizeNewlines(content, '\n').trim();
}

function requiresExactSectionParity(migration: RuleContractSectionMigration): boolean {
    return migration.heading === '## Integrity Priority Rules';
}

function isCompileGateSectionMigration(migration: RuleContractSectionMigration): boolean {
    return migration.heading === '### Compile Gate (Mandatory)'
        && migration.liveRelativePath.endsWith('/live/docs/agent-rules/40-commands.md');
}

function extractFirstFenceCommand(sectionContent: string): string | null {
    const lines = normalizeNewlines(sectionContent, '\n').split('\n');
    let inFence = false;
    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('```')) {
            if (inFence) {
                return null;
            }
            inFence = true;
            continue;
        }
        if (!inFence || !trimmed || trimmed.startsWith('#')) {
            continue;
        }
        return trimmed;
    }
    return null;
}

function isReplaceableCompileGatePlaceholder(command: string): boolean {
    const normalized = command.trim();
    return normalized === UNCONFIGURED_COMPILE_GATE_COMMAND || /^<[^>]+>$/.test(normalized);
}

function normalizePreservableCompileGateCommand(command: string | null | undefined, sourcePath: string): string | null {
    const normalized = String(command || '').trim();
    if (!normalized || isReplaceableCompileGatePlaceholder(normalized)) {
        return null;
    }

    try {
        validateCompileGateCommand(normalized, sourcePath);
        return normalized;
    } catch {
        return null;
    }
}

export function extractPreservableCompileGateCommandFromContent(
    content: string,
    sourcePath: string
): string | null {
    const bounds = getSectionBounds(content, '### Compile Gate (Mandatory)');
    if (!bounds) {
        return null;
    }

    return normalizePreservableCompileGateCommand(
        extractFirstFenceCommand(content.slice(bounds.start, bounds.end)),
        sourcePath
    );
}

export function readPreservableCompileGateCommandFromFile(filePath: string): string | null {
    if (!pathExists(filePath)) {
        return null;
    }
    return extractPreservableCompileGateCommandFromContent(readTextFile(filePath), filePath);
}

function getPreservableCompileGateCommand(currentContent: string, migration: RuleContractSectionMigration, livePath: string): string | null {
    const bounds = getSectionBounds(currentContent, migration.heading);
    if (!bounds) {
        return null;
    }

    return normalizePreservableCompileGateCommand(
        extractFirstFenceCommand(currentContent.slice(bounds.start, bounds.end)),
        livePath
    );
}

function applyCompileGateCommandToSection(sectionContent: string, command: string): string {
    const normalizedCommand = command.trim();
    if (!normalizedCommand) {
        return sectionContent;
    }

    const sectionPattern = /(^### Compile Gate \(Mandatory\)[\s\S]*?```[^\r\n]*(?:\r?\n))([\s\S]*?)(\r?\n```)/m;
    const match = sectionPattern.exec(sectionContent);
    if (!match) {
        return sectionContent;
    }

    return sectionContent.replace(sectionPattern, (_match, head: string, _old: string, tail: string) => `${head}${normalizedCommand}${tail}`);
}

function syncWorkflowConfigCompileGateCommand(rootPath: string, command: string | null): void {
    const normalizedCommand = normalizePreservableCompileGateCommand(command, 'workflow-config.compile_gate.command');
    if (!normalizedCommand) {
        return;
    }

    const workflowConfigPath = getWorkflowConfigPath(path.join(rootPath, resolveBundleName()));
    const readResult = readWorkflowConfigForMerge(workflowConfigPath);
    if (!readResult.config) {
        return;
    }

    const nextConfig = readResult.config;
    const compileGate = isPlainObject(nextConfig.compile_gate)
        ? { ...nextConfig.compile_gate }
        : {};
    if (isConfiguredCompileGateCommand(compileGate.command)) {
        return;
    }

    compileGate.command = normalizedCommand;
    nextConfig.compile_gate = compileGate;
    writeJsonFile(workflowConfigPath, nextConfig);
}

function replaceOrAppendSection(content: string, heading: string, replacement: string, newline: string): string {
    const normalizedReplacement = normalizeNewlines(replacement, newline).trimEnd();
    const bounds = getSectionBounds(content, heading);
    if (!bounds) {
        const trimmedContent = content.trimEnd();
        if (!trimmedContent) {
            return `${normalizedReplacement}${newline}`;
        }
        return `${trimmedContent}${newline}${newline}${normalizedReplacement}${newline}`;
    }

    const before = content.slice(0, bounds.start).trimEnd();
    const after = content.slice(bounds.end).trimStart();
    let result = before ? `${before}${newline}${newline}` : '';
    result += normalizedReplacement;
    if (after) {
        result += `${newline}${newline}${after}`;
    } else {
        result += newline;
    }
    return result;
}

function applySectionMigration(
    rootPath: string,
    migration: RuleContractSectionMigration,
    preservedCompileGateCommand: string | null
): boolean {
    const livePath = path.join(rootPath, migration.liveRelativePath);
    if (!pathExists(livePath)) {
        return false;
    }

    const templatePath = path.join(rootPath, migration.templateRelativePath);
    if (!pathExists(templatePath)) {
        throw new Error(`Contract migration template file not found: ${templatePath}`);
    }

    const currentContent = readTextFile(livePath);
    const templateContent = readTextFile(templatePath);
    let templateSection = extractSectionOrThrow(templateContent, migration.heading, templatePath);
    if (isCompileGateSectionMigration(migration)) {
        const preservedCommand = normalizePreservableCompileGateCommand(preservedCompileGateCommand, livePath)
            ?? getPreservableCompileGateCommand(currentContent, migration, livePath);
        if (preservedCommand) {
            syncWorkflowConfigCompileGateCommand(rootPath, preservedCommand);
            templateSection = applyCompileGateCommandToSection(templateSection, preservedCommand);
        }
    }
    if (!requiresExactSectionParity(migration)) {
        if (getMissingSectionSnippets(currentContent, migration).length === 0) {
            return false;
        }
    } else {
        const currentBounds = getSectionBounds(currentContent, migration.heading);
        if (currentBounds) {
            const currentSection = currentContent.slice(currentBounds.start, currentBounds.end);
            if (normalizeComparableSection(currentSection) === normalizeComparableSection(templateSection)) {
                return false;
            }
        }
    }

    const newline = detectNewline(currentContent || templateContent);
    const updatedContent = replaceOrAppendSection(currentContent, migration.heading, templateSection, newline);

    if (updatedContent === currentContent) {
        return false;
    }

    fs.writeFileSync(livePath, updatedContent, 'utf8');
    return true;
}

export function runContractMigrations(options: ContractMigrationOptions): ContractMigrationResult {
    const rootPath = path.resolve(options.rootPath);
    const preservedCompileGateCommand = options.preservedCompileGateCommand ?? null;
    const appliedFiles = new Set<string>();
    const orderedMigrations = [...getTaskModeRuleSectionMigrations()].sort((left, right) => {
        if (left.liveRelativePath !== right.liveRelativePath) {
            return left.liveRelativePath.localeCompare(right.liveRelativePath);
        }

        // Replace broader parent sections before inserting narrower subsections.
        // Otherwise a later parent-section migration can erase a newly inserted child block.
        return getHeadingLevel(left.heading) - getHeadingLevel(right.heading);
    });

    for (const migration of orderedMigrations) {
        if (applySectionMigration(rootPath, migration, preservedCompileGateCommand)) {
            appliedFiles.add(migration.liveRelativePath);
        }
    }

    const appliedFileList = Array.from(appliedFiles).sort();
    return {
        appliedCount: appliedFileList.length,
        appliedFiles: appliedFileList
    };
}
