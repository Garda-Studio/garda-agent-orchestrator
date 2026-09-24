import * as path from 'node:path';
import { pathExists, readTextFile } from '../../core/filesystem';
import { ensureContainedDirectory, writeContainedFile } from '../../core/contained-filesystem';
import {
    applyAssistantDefaults,
    applyCompileGateCommandDefaults,
    applyContextDefaults,
    GENERATED_RULE_FILES,
    generateProjectMemorySummary,
    isBootstrapOnlyLegacyCodeStyleRule,
    RULE_FILES,
    selectRuleSource
} from '../rule-materialization';
import { syncOptionalRuleSupportFiles } from '../rule-support-files';
import {
    buildDiscoveryOverlaySection
} from '../project-discovery';
import {
    migrateContextRulesToProjectMemory,
    type ProjectMemoryMigrationResult
} from '../project-memory/project-memory-migration';
import {
    seedProjectMemoryFromTemplate,
    validateSeededProjectMemory,
    writeProjectMemoryBootstrapReport,
    type ProjectMemorySeedResult
} from '../project-memory/project-memory-builder';
import type {
    InitProjectDiscovery,
    RuleSourceMapEntry
} from './init-contracts';
import { copyDirectoryRecursive } from './init-filesystem';
import {
    MANAGED_CONFIG_NAMES,
    selectCompileGateCommandForGuidance
} from './init-config-stage';

export interface RunInitRuleStageOptions {
    targetRoot: string;
    bundleRoot: string;
    templateRoot: string;
    liveRoot: string;
    templateRuleRoot: string;
    liveRuleRoot: string;
    workflowConfigPath: string;
    dryRun: boolean;
    timestampIso: string;
    lang: string;
    brevity: string;
    discovery: InitProjectDiscovery;
    preservedCompileGateCommand: string | null;
}

export interface InitRuleStageResult {
    ruleSourceMap: RuleSourceMapEntry[];
    legacyStyleGuidanceActive: boolean;
    copiedSupportDirs: number;
    projectMemorySeed: ProjectMemorySeedResult;
    seededDirs: number;
    migrationResult: ProjectMemoryMigrationResult;
    projectMemoryValidation: ReturnType<typeof validateSeededProjectMemory>;
    projectMemoryBootstrapReport: ReturnType<typeof writeProjectMemoryBootstrapReport>;
}

function materializeRuleFiles(
    options: RunInitRuleStageOptions,
    migrationResult: ProjectMemoryMigrationResult,
    compileGateCommandForGuidance: string
): { ruleSourceMap: RuleSourceMapEntry[]; legacyStyleGuidanceActive: boolean } {
    const {
        targetRoot,
        templateRuleRoot,
        liveRuleRoot,
        dryRun,
        discovery,
        lang,
        brevity
    } = options;
    const discoveryOverlay = buildDiscoveryOverlaySection(discovery);
    const ruleSourceMap: RuleSourceMapEntry[] = [];
    let legacyStyleGuidanceActive = false;

    for (const ruleFile of RULE_FILES) {
        if (GENERATED_RULE_FILES.includes(ruleFile)) {
            continue;
        }

        const source = selectRuleSource(ruleFile, {
            targetRoot,
            liveRuleRoot,
            templateRuleRoot
        });
        if (!source) {
            throw new Error(`No source found for rule file: ${ruleFile}`);
        }

        if (
            ruleFile === '30-code-style.md'
            && migrationResult.status === 'project_memory_has_content'
            && source.origin !== 'template'
        ) {
            const templatePath = path.join(templateRuleRoot, ruleFile);
            if (pathExists(templatePath)) {
                const templateContent = readTextFile(templatePath);
                const candidateContent = readTextFile(source.path);
                if (!isBootstrapOnlyLegacyCodeStyleRule(candidateContent, templateContent)) {
                    legacyStyleGuidanceActive = true;
                }
            }
        }

        let content = readTextFile(source.path);
        if (!content || !content.trim()) {
            throw new Error(`Rule source is empty: ${source.path}`);
        }

        if (source.origin === 'template') {
            content = applyContextDefaults(content, ruleFile, discoveryOverlay);
        }
        content = applyCompileGateCommandDefaults(content, ruleFile, [compileGateCommandForGuidance]);
        content = applyAssistantDefaults(content, ruleFile, lang, brevity);

        const destPath = path.join(liveRuleRoot, ruleFile);
        if (!dryRun) {
            writeContainedFile(targetRoot, destPath, content);
        }

        ruleSourceMap.push({
            ruleFile,
            source: path.relative(targetRoot, source.path).replace(/\\/g, '/'),
            origin: source.origin,
            destination: path.relative(targetRoot, destPath).replace(/\\/g, '/')
        });
    }

    return { ruleSourceMap, legacyStyleGuidanceActive };
}

function scaffoldLegacyStyleGuidance(
    options: RunInitRuleStageOptions,
    legacyStyleGuidanceActive: boolean
): void {
    if (!legacyStyleGuidanceActive || options.dryRun) {
        return;
    }
    const styleTemplatePath = path.join(options.templateRuleRoot, '30-code-style.md');
    if (pathExists(styleTemplatePath)) {
        writeContainedFile(
            options.targetRoot,
            path.join(options.liveRuleRoot, '30-code-style.template.md'),
            readTextFile(styleTemplatePath)
        );
    }

    const conventionsTemplatePath = path.join(
        options.templateRoot,
        'docs/project-memory/conventions.md'
    );
    if (!pathExists(conventionsTemplatePath)) {
        return;
    }
    const projectMemoryDir = path.join(options.liveRoot, 'docs/project-memory');
    ensureContainedDirectory(options.targetRoot, projectMemoryDir);
    const conventionsScaffoldPath = path.join(projectMemoryDir, 'conventions.template.md');
    if (!pathExists(conventionsScaffoldPath)) {
        writeContainedFile(
            options.targetRoot,
            conventionsScaffoldPath,
            readTextFile(conventionsTemplatePath)
        );
    }
    const markerPath = path.join(projectMemoryDir, '.legacy-style-contract');
    if (!pathExists(markerPath)) {
        writeContainedFile(
            options.targetRoot,
            markerPath,
            'This workspace retains legacy code-style conventions. Review conventions.template.md to adopt the updated contract.'
        );
    }
}

function copySupportDirectories(options: RunInitRuleStageOptions): number {
    const supportDirectories = [
        'config',
        'skills',
        'schemas',
        'docs/changes',
        'docs/reviews',
        'docs/tasks'
    ];
    const managedConfigFileNames = new Set(
        MANAGED_CONFIG_NAMES.map((configName) => `${configName}.json`.toLowerCase())
    );
    let copiedSupportDirs = 0;

    for (const relDir of supportDirectories) {
        const srcDir = path.join(options.templateRoot, relDir);
        if (!pathExists(srcDir)) {
            continue;
        }

        const destDir = path.join(options.liveRoot, relDir);
        if (!options.dryRun) {
            ensureContainedDirectory(options.targetRoot, destDir);
            copyDirectoryRecursive(
                srcDir,
                destDir,
                {
                    destinationRoot: options.targetRoot,
                    shouldCopyFile: relDir === 'config'
                        ? (_srcPath, destPath) => !(
                            managedConfigFileNames.has(path.basename(destPath).toLowerCase())
                            && pathExists(destPath)
                        )
                        : undefined
                }
            );
        }
        copiedSupportDirs++;
    }

    return copiedSupportDirs;
}

export function runInitRuleStage(
    options: RunInitRuleStageOptions
): InitRuleStageResult {
    const compileGateCommandForGuidance = selectCompileGateCommandForGuidance(
        options.workflowConfigPath,
        options.discovery,
        options.preservedCompileGateCommand
    );
    const projectMemorySeed = seedProjectMemoryFromTemplate({
        templateRoot: options.templateRoot,
        liveRoot: options.liveRoot,
        dryRun: options.dryRun
    });
    const migrationResult = migrateContextRulesToProjectMemory({
        bundleRoot: options.bundleRoot,
        targetRoot: options.targetRoot,
        templateRoot: options.templateRoot,
        dryRun: options.dryRun
    });
    const materializedRules = materializeRuleFiles(
        options,
        migrationResult,
        compileGateCommandForGuidance
    );
    syncOptionalRuleSupportFiles({
        bundleRoot: options.bundleRoot,
        dryRun: options.dryRun
    });
    scaffoldLegacyStyleGuidance(options, materializedRules.legacyStyleGuidanceActive);
    const copiedSupportDirs = copySupportDirectories(options);

    const projectMemorySummary = generateProjectMemorySummary(
        projectMemorySeed.projectMemoryDir,
        options.timestampIso
    );
    const projectMemorySummaryDest = path.join(
        options.liveRuleRoot,
        '15-project-memory.md'
    );
    if (!options.dryRun) {
        writeContainedFile(options.targetRoot, projectMemorySummaryDest, projectMemorySummary);
    }
    materializedRules.ruleSourceMap.push({
        ruleFile: '15-project-memory.md',
        source: 'docs/project-memory/*',
        origin: 'generated',
        destination: path.relative(options.targetRoot, projectMemorySummaryDest).replace(/\\/g, '/')
    });

    const projectMemoryValidation = validateSeededProjectMemory(
        projectMemorySeed,
        { mode: 'check' }
    );
    const projectMemoryBootstrapReport = writeProjectMemoryBootstrapReport({
        bundleRoot: options.bundleRoot,
        timestampIso: options.timestampIso,
        seedResult: projectMemorySeed,
        validation: projectMemoryValidation,
        summaryPath: projectMemorySummaryDest,
        dryRun: options.dryRun
    });

    return {
        ruleSourceMap: materializedRules.ruleSourceMap,
        legacyStyleGuidanceActive: materializedRules.legacyStyleGuidanceActive,
        copiedSupportDirs,
        projectMemorySeed,
        seededDirs: projectMemorySeed.seededDirectory ? 1 : 0,
        migrationResult,
        projectMemoryValidation,
        projectMemoryBootstrapReport
    };
}
