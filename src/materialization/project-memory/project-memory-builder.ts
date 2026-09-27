import * as path from 'node:path';
import {
    PROJECT_MEMORY_DIRECTORY_RELATIVE_PATH,
    PROJECT_MEMORY_FOCUSED_FILE_NAMES,
    PROJECT_MEMORY_READ_FIRST_FILE_NAMES,
    PROJECT_MEMORY_REQUIRED_FILE_NAMES,
    PROJECT_MEMORY_RUNTIME_DIRECTORY_RELATIVE_PATH,
    PROJECT_MEMORY_SUMMARY_RULE_RELATIVE_PATH,
    buildProjectMemoryLiveRelativePath,
    normalizeProjectMemoryMarkdown,
    resolveProjectMemoryBootstrapReportPath,
    sha256Hex,
    toProjectMemoryPosixPath
} from '../../core/project-memory';
import { pathExists, readTextFile } from '../../core/filesystem';
import { bindContainedDestination, copyContainedFile, ensureContainedDirectory, writeContainedFile } from '../../core/contained-filesystem';
import { formatJson } from '../../core/json';
import {
    validateProjectMemoryBootstrap,
    type ProjectMemoryValidationOptions,
    type ProjectMemoryValidationResult
} from '../../validators/project-memory';

export interface ProjectMemorySeedOptions {
    templateRoot: string;
    liveRoot: string;
    dryRun?: boolean;
}

export interface ProjectMemorySeedResult {
    projectMemoryDir: string;
    templateProjectMemoryDir: string;
    seededDirectory: boolean;
    copiedFiles: string[];
    preservedFiles: string[];
    missingTemplateFiles: string[];
    templateUpdateNotices: ProjectMemoryTemplateUpdateNotice[];
}

export interface ProjectMemoryTemplateUpdateNotice {
    fileName: string;
    livePath: string;
    templatePath: string;
    reason: 'existing_user_owned_file_preserved';
    action: string;
}

export interface ProjectMemoryBootstrapReportOptions {
    bundleRoot: string;
    timestampIso: string;
    seedResult: ProjectMemorySeedResult;
    validation: ProjectMemoryValidationResult;
    summaryPath?: string;
}

export interface ProjectMemoryBootstrapReport {
    schema_version: 1;
    generated_at_utc: string;
    project_memory: {
        directory: string;
        runtime_directory: string;
        read_strategy: 'index_first';
        read_first: string[];
        focused_files: string[];
        required_files: string[];
    };
    seed: {
        seeded_directory: boolean;
        copied_files: string[];
        preserved_files: string[];
        missing_template_files: string[];
        template_update_notices: ProjectMemoryTemplateUpdateNotice[];
    };
    validation: {
        passed: boolean;
        mode: string;
        missing_files: string[];
        template_seed_files: string[];
        placeholder_files: string[];
        content_files: string[];
        compact_char_count: number | null;
        max_compact_summary_chars: number;
        issue_count: number;
        issues: Array<{
            code: string;
            severity: string;
            file?: string;
            message: string;
        }>;
    };
    generated_summary: {
        path: string;
        exists: boolean;
        sha256: string | null;
        char_count: number | null;
    };
}

function resolveProjectMemoryDirs(templateRoot: string, liveRoot: string): { templateDir: string; liveDir: string } {
    return {
        templateDir: path.join(templateRoot, PROJECT_MEMORY_DIRECTORY_RELATIVE_PATH),
        liveDir: path.join(liveRoot, PROJECT_MEMORY_DIRECTORY_RELATIVE_PATH)
    };
}

export function seedProjectMemoryFromTemplate(options: ProjectMemorySeedOptions): ProjectMemorySeedResult {
    const { templateRoot, liveRoot, dryRun = false } = options;
    const { templateDir, liveDir } = resolveProjectMemoryDirs(templateRoot, liveRoot);
    const seededDirectory = !pathExists(liveDir);
    const copiedFiles: string[] = [];
    const preservedFiles: string[] = [];
    const missingTemplateFiles: string[] = [];
    const templateUpdateNotices: ProjectMemoryTemplateUpdateNotice[] = [];

    if (!dryRun) {
        ensureContainedDirectory(liveRoot, liveDir);
    }

    for (const fileName of PROJECT_MEMORY_REQUIRED_FILE_NAMES) {
        const templatePath = path.join(templateDir, fileName);
        const destinationPath = path.join(liveDir, fileName);
        bindContainedDestination(path.parse(path.resolve(templateRoot)).root, templatePath);
        bindContainedDestination(liveRoot, destinationPath);
        if (pathExists(destinationPath)) {
            preservedFiles.push(fileName);
            if (pathExists(templatePath)) {
                const existingContent = readTextFile(destinationPath);
                const templateContent = readTextFile(templatePath);
                if (normalizeProjectMemoryMarkdown(existingContent) !== normalizeProjectMemoryMarkdown(templateContent)) {
                    templateUpdateNotices.push({
                        fileName,
                        livePath: getRelativePath(liveRoot, destinationPath),
                        templatePath: getRelativePath(templateRoot, templatePath),
                        reason: 'existing_user_owned_file_preserved',
                        action: 'Review the template guidance manually; the live project-memory file was not overwritten.'
                    });
                }
            }
            continue;
        }
        if (!pathExists(templatePath)) {
            missingTemplateFiles.push(fileName);
            continue;
        }
        copiedFiles.push(fileName);
        if (!dryRun) {
            copyContainedFile(liveRoot, templatePath, destinationPath);
        }
    }

    return {
        projectMemoryDir: liveDir,
        templateProjectMemoryDir: templateDir,
        seededDirectory,
        copiedFiles,
        preservedFiles,
        missingTemplateFiles,
        templateUpdateNotices
    };
}

function getRelativePath(basePath: string, filePath: string): string {
    return toProjectMemoryPosixPath(path.relative(basePath, filePath));
}

function readSummaryMetadata(summaryPath: string): { exists: boolean; sha256: string | null; char_count: number | null } {
    if (!pathExists(summaryPath)) {
        return { exists: false, sha256: null, char_count: null };
    }
    const content = readTextFile(summaryPath);
    return {
        exists: true,
        sha256: sha256Hex(content),
        char_count: content.length
    };
}

export function validateSeededProjectMemory(
    seedResult: ProjectMemorySeedResult,
    options: ProjectMemoryValidationOptions = {}
): ProjectMemoryValidationResult {
    return validateProjectMemoryBootstrap(seedResult.projectMemoryDir, {
        ...options,
        templateProjectMemoryDir: options.templateProjectMemoryDir ?? seedResult.templateProjectMemoryDir
    });
}

export function buildProjectMemoryBootstrapReport(
    options: ProjectMemoryBootstrapReportOptions
): ProjectMemoryBootstrapReport {
    const { bundleRoot, timestampIso, seedResult, validation } = options;
    const summaryPath = options.summaryPath || path.join(bundleRoot, PROJECT_MEMORY_SUMMARY_RULE_RELATIVE_PATH);
    const summaryMetadata = readSummaryMetadata(summaryPath);

    return {
        schema_version: 1,
        generated_at_utc: timestampIso,
        project_memory: {
            directory: buildProjectMemoryLiveRelativePath(),
            runtime_directory: PROJECT_MEMORY_RUNTIME_DIRECTORY_RELATIVE_PATH,
            read_strategy: 'index_first',
            read_first: PROJECT_MEMORY_READ_FIRST_FILE_NAMES.map((fileName) => buildProjectMemoryLiveRelativePath(fileName)),
            focused_files: PROJECT_MEMORY_FOCUSED_FILE_NAMES.map((fileName) => buildProjectMemoryLiveRelativePath(fileName)),
            required_files: PROJECT_MEMORY_REQUIRED_FILE_NAMES.map((fileName) => buildProjectMemoryLiveRelativePath(fileName))
        },
        seed: {
            seeded_directory: seedResult.seededDirectory,
            copied_files: [...seedResult.copiedFiles],
            preserved_files: [...seedResult.preservedFiles],
            missing_template_files: [...seedResult.missingTemplateFiles],
            template_update_notices: seedResult.templateUpdateNotices.map((notice) => ({ ...notice }))
        },
        validation: {
            passed: validation.passed,
            mode: validation.mode,
            missing_files: [...validation.missingFiles],
            template_seed_files: [...validation.templateSeedFiles],
            placeholder_files: [...validation.placeholderFiles],
            content_files: [...validation.contentFiles],
            compact_char_count: validation.compactCharCount,
            max_compact_summary_chars: validation.maxCompactSummaryChars,
            issue_count: validation.issues.length,
            issues: validation.issues.map((issue) => ({ ...issue }))
        },
        generated_summary: {
            path: getRelativePath(bundleRoot, summaryPath),
            exists: summaryMetadata.exists,
            sha256: summaryMetadata.sha256,
            char_count: summaryMetadata.char_count
        }
    };
}

export function writeProjectMemoryBootstrapReport(
    options: ProjectMemoryBootstrapReportOptions & { dryRun?: boolean }
): { path: string; report: ProjectMemoryBootstrapReport } {
    const reportPath = resolveProjectMemoryBootstrapReportPath(options.bundleRoot);
    bindContainedDestination(options.bundleRoot, reportPath);
    const report = buildProjectMemoryBootstrapReport(options);
    if (!options.dryRun) {
        writeContainedFile(options.bundleRoot, reportPath, formatJson(report));
    }
    return { path: reportPath, report };
}
