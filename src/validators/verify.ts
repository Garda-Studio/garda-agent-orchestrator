import { TASK_QUEUE_FILENAME } from '../core/orchestration-constants';
import * as path from 'node:path';
import {
    BOOLEAN_FALSE_VALUES,
    BOOLEAN_TRUE_VALUES,
    UNCONFIGURED_COMPILE_GATE_COMMAND,
    getBundleCliCommand,
    getLegacyBundleCliCommand,
    getLegacySourceCliCommand,
    getSourceCliCommand,
    resolveBundleName
} from '../core/constants';
import { pathExists, readTextFile } from '../core/filesystem';
import { isPathInsideRoot } from '../core/paths';
import { getWorkflowConfigPath, isConfiguredCompileGateCommand } from '../core/workflow-config';
import { getManagedGitignoreEntries } from '../materialization/common';
import { validateSkillPacks, validateSkillsIndex } from '../runtime/skills';
import { getTaskModeRuleSectionMigrations } from '../materialization/rule-contracts';
import { getCompileCommands } from '../gates/compile/compile-gate';
import {
    PROJECT_COMMAND_PLACEHOLDERS,
    RULE_FILES,
    buildRequiredPaths,
    detectGitignoreViolations,
    detectManagedConfigViolations,
    detectMissingPaths,
    detectRuleFileViolations,
    detectVersionViolations,
    extractManagedBlock,
    getCanonicalEntrypoint
} from './workspace-layout';

interface VerifyInitAnswersResult {
    violations: string[];
    assistantLanguage: string | null;
    assistantBrevity: string | null;
    enforceNoAutoCommit: boolean;
    claudeOrchestratorFullAccess: boolean;
    tokenEconomyEnabled: boolean;
    providerMinimalism: boolean;
    activeAgentFiles: string[];
}

interface VerifyViolations {
    missingPaths: string[];
    initAnswersContractViolations: string[];
    versionContractViolations: string[];
    reviewCapabilitiesContractViolations: string[];
    pathsContractViolations: string[];
    tokenEconomyContractViolations: string[];
    outputFiltersContractViolations: string[];
    skillPacksConfigContractViolations: string[];
    skillsIndexConfigContractViolations: string[];
    ruleFileViolations: string[];
    templatePlaceholderViolations: string[];
    commandsContractViolations: string[];
    manifestContractViolations: string[];
    coreRuleContractViolations: string[];
    entrypointContractViolations: string[];
    taskContractViolations: string[];
    qwenSettingsViolations: string[];
    skillsIndexContractViolations: string[];
    skillPackContractViolations: string[];
    gitignoreMissing: string[];
}

interface VerifyResult {
    passed: boolean;
    targetRoot: string;
    sourceOfTruth: string;
    canonicalEntrypoint: string | null;
    bundleVersion: string | null | undefined;
    requiredPathsChecked: number;
    violations: VerifyViolations;
    totalViolationCount: number;
}

interface RunVerifyOptions {
    targetRoot: string;
    initAnswersPath: string;
    sourceOfTruth: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function escapeRegex(text: string): string {
    return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getMarkdownHeadingLevel(heading: string): number {
    const headingPrefixMatch = heading.trim().match(/^(#+)\s+/);
    if (!headingPrefixMatch) {
        return 0;
    }
    return headingPrefixMatch[1].length;
}

function getMarkdownSection(content: string, heading: string): string | null {
    const headingLevel = getMarkdownHeadingLevel(heading);
    if (headingLevel === 0) {
        return null;
    }

    const headingPattern = new RegExp(`^${escapeRegex(heading)}\\s*$`, 'm');
    const headingMatch = headingPattern.exec(content);
    if (!headingMatch) {
        return null;
    }

    const sectionStart = headingMatch.index;
    const searchStart = sectionStart + headingMatch[0].length;
    const remainder = content.slice(searchStart);
    const nextHeadingPattern = new RegExp(`^#{1,${headingLevel}}\\s+`, 'm');
    const nextHeadingMatch = nextHeadingPattern.exec(remainder);
    const sectionEnd = nextHeadingMatch
        ? searchStart + nextHeadingMatch.index
        : content.length;

    return content.slice(sectionStart, sectionEnd);
}

function normalizeMarkdownSectionForComparison(content: string): string {
    return String(content).replace(/\r?\n/g, '\n').trim();
}

function requiresExactTaskModeRuleSectionParity(heading: string): boolean {
    return heading === '## Integrity Priority Rules';
}

export function parseBooleanLike(value: unknown, defaultValue: boolean): boolean {
    if (value === null || value === undefined) return defaultValue;
    if (typeof value === 'boolean') return value;
    const normalized = String(value).trim().toLowerCase();
    if (BOOLEAN_TRUE_VALUES.includes(normalized)) return true;
    if (BOOLEAN_FALSE_VALUES.includes(normalized)) return false;
    return defaultValue;
}

export function readVerifyInitAnswers(targetRoot: string, initAnswersPath: string, sourceOfTruth: string): VerifyInitAnswersResult {
    const violations: string[] = [];
    const defaults: VerifyInitAnswersResult = {
        violations,
        assistantLanguage: null,
        assistantBrevity: null,
        enforceNoAutoCommit: false,
        claudeOrchestratorFullAccess: false,
        tokenEconomyEnabled: true,
        providerMinimalism: true,
        activeAgentFiles: []
    };

    let resolvedPath = '';
    try {
        let candidate = String(initAnswersPath || '').trim();
        if (!path.isAbsolute(candidate)) {
            candidate = path.join(targetRoot, candidate);
        }
        resolvedPath = path.resolve(candidate);
        if (!isPathInsideRoot(targetRoot, resolvedPath)) {
            violations.push(`InitAnswersPath must resolve inside TargetRoot '${targetRoot}'. Resolved path: ${resolvedPath}`);
            return defaults;
        }
    } catch (err: unknown) {
        violations.push(getErrorMessage(err));
        return defaults;
    }

    if (!pathExists(resolvedPath)) {
        violations.push('Init answers artifact missing: ' + resolvedPath);
        return defaults;
    }

    let raw: string;
    try {
        raw = readTextFile(resolvedPath);
    } catch {
        violations.push(`Cannot read init answers artifact: ${resolvedPath}`);
        return defaults;
    }

    if (!raw.trim()) {
        violations.push(`Init answers artifact is empty: ${resolvedPath}`);
        return defaults;
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        violations.push(`Init answers artifact is not valid JSON: ${resolvedPath}`);
        return defaults;
    }

    function getField(obj: unknown, key: string): string | undefined {
        if (!isRecord(obj)) return undefined;
        return obj[key] !== undefined ? String(obj[key]) : undefined;
    }

    const assistantLanguage = getField(parsed, 'AssistantLanguage');
    if (!assistantLanguage || !assistantLanguage.trim()) {
        violations.push(`Init answers artifact missing AssistantLanguage: ${resolvedPath}`);
    }

    const assistantBrevity = getField(parsed, 'AssistantBrevity');
    if (!assistantBrevity || !assistantBrevity.trim()) {
        violations.push(`Init answers artifact missing AssistantBrevity: ${resolvedPath}`);
    } else {
        const normalizedBrevity = assistantBrevity.trim().toLowerCase();
        if (normalizedBrevity !== 'concise' && normalizedBrevity !== 'detailed') {
            violations.push(`Init answers artifact has unsupported AssistantBrevity '${normalizedBrevity}'. Allowed values: concise, detailed.`);
        }
    }

    const artifactSourceOfTruth = getField(parsed, 'SourceOfTruth');
    if (!artifactSourceOfTruth || !artifactSourceOfTruth.trim()) {
        violations.push(`Init answers artifact missing SourceOfTruth: ${resolvedPath}`);
    } else {
        const artifactSourceKey = artifactSourceOfTruth.trim().toUpperCase().replace(/\s+/g, '');
        const expectedSourceKey = sourceOfTruth.trim().toUpperCase().replace(/\s+/g, '');
        if (artifactSourceKey !== expectedSourceKey) {
            violations.push(`Init answers SourceOfTruth '${artifactSourceOfTruth.trim()}' does not match verification SourceOfTruth '${sourceOfTruth}'.`);
        }
    }

    const enforceNoAutoCommit = parseBooleanLike(getField(parsed, 'EnforceNoAutoCommit'), false);
    const claudeOrchestratorFullAccess = parseBooleanLike(getField(parsed, 'ClaudeOrchestratorFullAccess'), false);
    const tokenEconomyEnabled = parseBooleanLike(getField(parsed, 'TokenEconomyEnabled'), true);
    const providerMinimalism = parseBooleanLike(getField(parsed, 'ProviderMinimalism'), true);

    const activeAgentFilesRaw = getField(parsed, 'ActiveAgentFiles');
    let activeAgentFiles: string[] = [];
    if (activeAgentFilesRaw) {
        activeAgentFiles = activeAgentFilesRaw
            .split(/[;,]/g)
            .map((item) => item.trim())
            .filter((item) => item.length > 0);
    }
    const canonicalEntrypoint = getCanonicalEntrypoint(sourceOfTruth);
    if (activeAgentFiles.length === 0 && canonicalEntrypoint) {
        activeAgentFiles = [canonicalEntrypoint];
    }

    return {
        violations,
        assistantLanguage: assistantLanguage ? assistantLanguage.trim() : null,
        assistantBrevity: assistantBrevity ? assistantBrevity.trim().toLowerCase() : null,
        enforceNoAutoCommit,
        claudeOrchestratorFullAccess,
        tokenEconomyEnabled,
        providerMinimalism,
        activeAgentFiles
    };
}

export function detectCommandsViolations(targetRoot: string): string[] {
    const violations: string[] = [];
    const commandsPath = path.join(targetRoot, resolveBundleName() + '/live/docs/agent-rules/40-commands.md');
    if (!pathExists(commandsPath)) return violations;
    const content = readTextFile(commandsPath);
    const requiredSnippets = [
        `${getBundleCliCommand()} gate enter-task-mode`,
        `${getBundleCliCommand()} gate load-rule-pack`,
        '### Compile Gate (Mandatory)',
        `${getBundleCliCommand()} gate classify-change`,
        `${getBundleCliCommand()} gate compile-gate`,
        `${getBundleCliCommand()} gate required-reviews-check`,
        `${getBundleCliCommand()} gate doc-impact-gate`,
        `${getBundleCliCommand()} gate completion-gate`,
        `${getBundleCliCommand()} gate log-task-event`,
        `${getBundleCliCommand()} gate task-events-summary`,
        `${getBundleCliCommand()} gate build-scoped-diff`,
        `${getBundleCliCommand()} gate build-review-context`,
        `${getBundleCliCommand()} gate validate-manifest`,
        '40-command-reference.md'
    ];
    for (const requiredSnippet of requiredSnippets) {
        const alternatives = getCommandSnippetAlternatives(requiredSnippet);
        const present = alternatives.some((alternative) => content.includes(alternative));
        if (!present) {
            violations.push(`40-commands.md must include gate contract snippet '${requiredSnippet}'.`);
        }
    }
    for (const placeholder of PROJECT_COMMAND_PLACEHOLDERS) {
        if (content.includes(placeholder)) {
            violations.push(`40-commands.md contains unresolved command placeholder: ${placeholder}`);
        }
    }
    try {
        getCompileCommands(commandsPath, { allowUnconfiguredSentinel: true });
    } catch (error) {
        violations.push('40-commands.md compile gate command contract violation: ' + (error instanceof Error ? error.message : String(error)));
    }
    const commandReferencePath = path.join(targetRoot, resolveBundleName() + '/live/docs/agent-rules/40-command-reference.md');
    if (!pathExists(commandReferencePath)) {
        violations.push('40-command-reference.md must exist when 40-commands.md defers tool-specific command tables.');
    } else {
        const appendixContent = readTextFile(commandReferencePath);
        const appendixSnippets = [
            '## Version Control (git)',
            '## Package Managers',
            '## Build, Lint, And Type-Check',
            '## Search And File Inspection',
            '## Containers And Infrastructure',
            '`rg -l --max-count=5',
            '`docker logs --tail 50',
            '`--noEmit --pretty false`',
            '`--format=compact`'
        ];
        for (const snippet of appendixSnippets) {
            if (!appendixContent.includes(snippet)) {
                violations.push(`40-command-reference.md must include command-reference snippet '${snippet}'.`);
            }
        }
    }
    return violations;
}

export function detectTaskModeRuleContractViolations(targetRoot: string): string[] {
    const violations: string[] = [];

    for (const migration of getTaskModeRuleSectionMigrations()) {
        const fullPath = path.join(targetRoot, migration.liveRelativePath);
        if (!pathExists(fullPath)) {
            continue;
        }

        const content = readTextFile(fullPath);
        const fileLabel = path.basename(migration.liveRelativePath);
        const sectionContent = getMarkdownSection(content, migration.heading);
        const templatePath = path.join(targetRoot, migration.templateRelativePath);
        if (requiresExactTaskModeRuleSectionParity(migration.heading) && pathExists(templatePath)) {
            const templateSection = getMarkdownSection(readTextFile(templatePath), migration.heading);
            if (templateSection) {
                if (
                    sectionContent == null
                    || normalizeMarkdownSectionForComparison(sectionContent)
                        !== normalizeMarkdownSectionForComparison(templateSection)
                ) {
                    violations.push(`${fileLabel} section '${migration.heading}' must stay synchronized with template source.`);
                    continue;
                }
            }
        }

        const fallbackSectionContent = sectionContent ?? '';
        for (const snippet of migration.requiredSnippets) {
            const alternatives = getCommandSnippetAlternatives(snippet);
            let present = false;
            for (const candidate of alternatives) {
                if (fallbackSectionContent.includes(candidate)) {
                    present = true;
                    break;
                }
            }
            if (!present) {
                violations.push(`${fileLabel} must include task-mode contract snippet '${snippet}'.`);
            }
        }
    }

    return violations;
}

function getCommandSnippetAlternatives(snippet: string): string[] {
    const normalizedSnippet = String(snippet || '');
    const effectiveBundlePath = getBundleCliCommand();
    if (!normalizedSnippet.includes(effectiveBundlePath)) {
        const legacyBundlePath = getLegacyBundleCliCommand();
        if (normalizedSnippet.includes(legacyBundlePath)) {
            return [
                normalizedSnippet,
                normalizedSnippet.replace(legacyBundlePath, getSourceCliCommand()),
                normalizedSnippet.replace(legacyBundlePath, getLegacySourceCliCommand())
            ];
        }
        return [normalizedSnippet];
    }

    const sourcePath = getSourceCliCommand();
    return [
        normalizedSnippet,
        normalizedSnippet.replace(effectiveBundlePath, sourcePath),
        normalizedSnippet.replace(effectiveBundlePath, getLegacySourceCliCommand()),
        normalizedSnippet.replace(effectiveBundlePath, getLegacyBundleCliCommand())
    ];
}

export function detectCoreRuleViolations(
    targetRoot: string,
    assistantLanguage: string | null,
    assistantBrevity: string | null
): string[] {
    const violations: string[] = [];
    const coreRulesPath = path.join(targetRoot, resolveBundleName() + '/live/docs/agent-rules/00-core.md');
    if (!pathExists(coreRulesPath)) {
        violations.push('00-core.md missing; core contract validation failed.');
        return violations;
    }
    const content = readTextFile(coreRulesPath);
    if (!/^Respond in .+ for explanations and assistance\.$/m.test(content)) {
        violations.push('00-core.md must define configured assistant language sentence.');
    }
    if (!/^Default response brevity: .+\.$/m.test(content)) {
        violations.push('00-core.md must define configured assistant response brevity sentence.');
    }
    if (assistantLanguage) {
        const expectedLanguageLine = `Respond in ${assistantLanguage} for explanations and assistance.`;
        const expectedLanguagePattern = new RegExp(`^${escapeRegex(expectedLanguageLine)}$`, 'm');
        if (!expectedLanguagePattern.test(content)) {
            violations.push(`00-core.md language does not match init answers artifact. Expected: '${expectedLanguageLine}'.`);
        }
    }
    if (assistantBrevity) {
        const expectedBrevityLine = `Default response brevity: ${assistantBrevity}.`;
        const expectedBrevityPattern = new RegExp(`^${escapeRegex(expectedBrevityLine)}$`, 'm');
        if (!expectedBrevityPattern.test(content)) {
            violations.push(`00-core.md response brevity does not match init answers artifact. Expected: '${expectedBrevityLine}'.`);
        }
    }
    return violations;
}

export function detectTaskViolations(targetRoot: string, canonicalEntrypoint: string | null): string[] {
    const violations: string[] = [];
    const taskPath = path.join(targetRoot, TASK_QUEUE_FILENAME);
    if (!pathExists(taskPath)) {
        violations.push('TASK.md missing.');
        return violations;
    }
    const content = readTextFile(taskPath);
    const managedBlock = extractManagedBlock(content);
    if (!managedBlock) {
        violations.push('TASK.md managed block missing.');
        return violations;
    }
    if (!/\|\s*ID\s*\|\s*Status\s*\|\s*Priority\s*\|\s*Area\s*\|\s*Title\s*\|\s*Owner\s*\|\s*Updated\s*\|\s*Profile\s*\|\s*Notes\s*\|/.test(managedBlock)) {
        violations.push('TASK.md queue header must include `Profile` column.');
    }
    if (managedBlock.includes('{{CANONICAL_ENTRYPOINT}}')) {
        violations.push('TASK.md contains unresolved `{{CANONICAL_ENTRYPOINT}}` placeholder.');
    }
    if (canonicalEntrypoint) {
        const expectedEntrypointLine = `Canonical instructions entrypoint for orchestration: \`${canonicalEntrypoint}\`.`;
        if (!managedBlock.includes(expectedEntrypointLine)) {
            violations.push(`TASK.md must reference canonical instructions entrypoint '${canonicalEntrypoint}'.`);
        }
    }
    return violations;
}

export function detectEntrypointViolations(targetRoot: string, canonicalEntrypoint: string | null): string[] {
    const violations: string[] = [];
    if (!canonicalEntrypoint) return violations;
    const entrypointPath = path.join(targetRoot, canonicalEntrypoint);
    if (!pathExists(entrypointPath)) {
        violations.push(`Canonical entrypoint missing: ${canonicalEntrypoint}`);
        return violations;
    }
    const content = readTextFile(entrypointPath);
    if (!/^# Garda Agent Orchestrator Rule Index$/m.test(content)) {
        violations.push(`${canonicalEntrypoint} must contain canonical rule index content.`);
    }
    const rulePathPattern = new RegExp(`${escapeRegex(resolveBundleName())}\\/live\\/docs\\/agent-rules\\/[0-9]{2}[-a-z]+\\.md`, 'g');
    const ruleLinks = content.match(rulePathPattern);
    const uniqueRuleLinks = ruleLinks ? Array.from(new Set(ruleLinks)) : [];
    if (uniqueRuleLinks.length < RULE_FILES.length) {
        violations.push(`${canonicalEntrypoint} has fewer rule links than expected. Found=${uniqueRuleLinks.length}, ExpectedAtLeast=${RULE_FILES.length}`);
    }
    for (const ruleLink of uniqueRuleLinks) {
        if (!pathExists(path.join(targetRoot, ruleLink))) {
            violations.push(`${canonicalEntrypoint} route target missing: ${ruleLink}`);
        }
    }
    return violations;
}

export function detectQwenSettingsViolations(targetRoot: string, canonicalEntrypoint: string | null): string[] {
    const violations: string[] = [];
    const settingsPath = path.join(targetRoot, '.qwen/settings.json');
    if (!pathExists(settingsPath)) return violations;
    let settings: unknown;
    try {
        settings = JSON.parse(readTextFile(settingsPath));
    } catch (e: unknown) {
        violations.push('.qwen/settings.json is not valid JSON: ' + getErrorMessage(e));
        return violations;
    }
    const fileNames: string[] = [];
    if (isRecord(settings)) {
        const contextValue = settings.context;
        if (isRecord(contextValue) && contextValue.fileName) {
            const rawFileNames = Array.isArray(contextValue.fileName) ? contextValue.fileName : [contextValue.fileName];
            for (const rawFileName of rawFileNames) {
                if (rawFileName && typeof rawFileName === 'string' && rawFileName.trim()) {
                    fileNames.push(rawFileName.trim());
                }
            }
        }
    }
    const uniqueFileNames = Array.from(new Set(fileNames));
    if (canonicalEntrypoint && !uniqueFileNames.includes(canonicalEntrypoint)) {
        violations.push(`.qwen/settings.json must include context.fileName entry \`${canonicalEntrypoint}\`.`);
    }
    if (!uniqueFileNames.includes(TASK_QUEUE_FILENAME)) {
        violations.push('.qwen/settings.json must include context.fileName entry `TASK.md`.');
    }
    return violations;
}

export function detectManifestContractViolations(targetRoot: string): string[] {
    const violations: string[] = [];
    const manifestPath = path.join(targetRoot, resolveBundleName() + '/MANIFEST.md');
    if (!pathExists(manifestPath)) return violations;
    const content = readTextFile(manifestPath);
    if (!content.includes('live/USAGE.md')) violations.push("MANIFEST.md must include 'live/USAGE.md'.");
    return violations;
}

function isManagedConfigMapped(targetRoot: string, configName: string): boolean {
    const rootConfigPath = path.join(targetRoot, resolveBundleName(), 'live', 'config', 'garda.config.json');
    if (!pathExists(rootConfigPath)) return false;
    try {
        const raw = JSON.parse(readTextFile(rootConfigPath));
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
        const configs = (raw as Record<string, unknown>).configs;
        if (!configs || typeof configs !== 'object' || Array.isArray(configs)) return false;
        const mappedPath = (configs as Record<string, unknown>)[configName];
        return typeof mappedPath === 'string' && mappedPath.trim().length > 0;
    } catch {
        return false;
    }
}

function detectWorkflowCompileGateCommandViolations(targetRoot: string): string[] {
    const bundlePath = path.join(targetRoot, resolveBundleName());
    const workflowConfigPath = getWorkflowConfigPath(bundlePath);
    const relativeWorkflowConfigPath = path.relative(targetRoot, workflowConfigPath).replace(/\\/g, '/');
    if (!pathExists(workflowConfigPath)) {
        return [`${relativeWorkflowConfigPath} is missing compile_gate.command; PROJECT_COMMANDS_PENDING until agent-init or workflow set records a project-specific command.`];
    }

    try {
        const parsed = JSON.parse(readTextFile(workflowConfigPath)) as Record<string, unknown>;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return [];
        }
        const rawSection = parsed.compile_gate;
        if (!rawSection || typeof rawSection !== 'object' || Array.isArray(rawSection)) {
            return [`${relativeWorkflowConfigPath} must include compile_gate.command; PROJECT_COMMANDS_PENDING until agent-init or workflow set records a project-specific command.`];
        }
        const section = rawSection as Record<string, unknown>;
        const command = typeof section.command === 'string' && section.command.trim()
            ? section.command.trim()
            : UNCONFIGURED_COMPILE_GATE_COMMAND;
        if (!isConfiguredCompileGateCommand(command)) {
            return [`${relativeWorkflowConfigPath} compile_gate.command is unconfigured; PROJECT_COMMANDS_PENDING until agent-init or workflow set records a project-specific command.`];
        }
    } catch {
        return [];
    }
    return [];
}

function collectSkillContractViolations(bundleRoot: string): Pick<VerifyViolations, 'skillPackContractViolations' | 'skillsIndexContractViolations'> {
    try {
        const skillPackValidation = validateSkillPacks(bundleRoot);
        const skillsIndexValidation = validateSkillsIndex(bundleRoot);
        return {
            skillPackContractViolations: skillPackValidation.issues,
            skillsIndexContractViolations: skillsIndexValidation.issues
        };
    } catch (error: unknown) {
        const issue = `Skill validation failed: ${getErrorMessage(error)}`;
        return {
            skillPackContractViolations: [issue],
            skillsIndexContractViolations: [issue]
        };
    }
}

export function runVerify(options: RunVerifyOptions): VerifyResult {
    const targetRoot = path.resolve(options.targetRoot);
    const sourceOfTruth = options.sourceOfTruth.trim();
    const canonicalEntrypoint = getCanonicalEntrypoint(sourceOfTruth);
    const initAnswers = readVerifyInitAnswers(targetRoot, options.initAnswersPath, sourceOfTruth);
    const requiredPaths = buildRequiredPaths({
        activeAgentFiles: initAnswers.activeAgentFiles,
        claudeOrchestratorFullAccess: initAnswers.claudeOrchestratorFullAccess
    });
    const missingPaths = detectMissingPaths(targetRoot, requiredPaths);
    const versionViolations = detectVersionViolations(targetRoot, sourceOfTruth, canonicalEntrypoint);
    const reviewCapabilitiesViolations = detectManagedConfigViolations(targetRoot, resolveBundleName() + '/live/config/review-capabilities.json');
    const pathsViolations = detectManagedConfigViolations(targetRoot, resolveBundleName() + '/live/config/paths.json');
    const tokenEconomyViolations = detectManagedConfigViolations(targetRoot, resolveBundleName() + '/live/config/token-economy.json');
    const outputFiltersViolations = detectManagedConfigViolations(targetRoot, resolveBundleName() + '/live/config/output-filters.json');
    const skillPacksConfigViolations = detectManagedConfigViolations(targetRoot, resolveBundleName() + '/live/config/skill-packs.json');
    const optionalSkillSelectionPolicyPath = resolveBundleName() + '/live/config/optional-skill-selection-policy.json';
    const optionalSkillSelectionPolicyViolations = isManagedConfigMapped(targetRoot, 'optional-skill-selection-policy')
        ? detectManagedConfigViolations(targetRoot, optionalSkillSelectionPolicyPath)
        : [];
    const isolationModeViolations = detectManagedConfigViolations(targetRoot, resolveBundleName() + '/live/config/isolation-mode.json');
    const profilesViolations = detectManagedConfigViolations(targetRoot, resolveBundleName() + '/live/config/profiles.json');
    const reviewArtifactStorageViolations = detectManagedConfigViolations(targetRoot, resolveBundleName() + '/live/config/review-artifact-storage.json');
    const runtimeRetentionViolations = detectManagedConfigViolations(targetRoot, resolveBundleName() + '/live/config/runtime-retention.json');
    const orchestratorConfigViolations = detectManagedConfigViolations(targetRoot, resolveBundleName() + '/live/config/garda.config.json');
    const skillsIndexConfigViolations = detectManagedConfigViolations(targetRoot, resolveBundleName() + '/live/config/skills-index.json');
    const ruleFileResult = detectRuleFileViolations(targetRoot);
    const taskModeViolations = detectTaskModeRuleContractViolations(targetRoot);
    const commandsViolations = detectCommandsViolations(targetRoot);
    const workflowCompileGateCommandViolations = detectWorkflowCompileGateCommandViolations(targetRoot);
    const coreRuleViolations = detectCoreRuleViolations(targetRoot, initAnswers.assistantLanguage, initAnswers.assistantBrevity);
    const taskViolations = detectTaskViolations(targetRoot, canonicalEntrypoint);
    const entrypointViolations = detectEntrypointViolations(targetRoot, canonicalEntrypoint);
    const qwenSettingsViolations = detectQwenSettingsViolations(targetRoot, canonicalEntrypoint);
    const skillContractViolations = collectSkillContractViolations(path.join(targetRoot, resolveBundleName()));
    const managedGitignoreEntries = getManagedGitignoreEntries(
        initAnswers.claudeOrchestratorFullAccess,
        initAnswers.providerMinimalism && initAnswers.activeAgentFiles.length > 0 ? initAnswers.activeAgentFiles : undefined
    );
    const gitignoreMissing = detectGitignoreViolations(targetRoot, managedGitignoreEntries);
    const manifestViolations = detectManifestContractViolations(targetRoot);

    const violations: VerifyViolations = {
        missingPaths,
        initAnswersContractViolations: initAnswers.violations,
        versionContractViolations: versionViolations.violations,
        reviewCapabilitiesContractViolations: reviewCapabilitiesViolations,
        pathsContractViolations: pathsViolations,
        tokenEconomyContractViolations: tokenEconomyViolations,
        outputFiltersContractViolations: outputFiltersViolations,
        skillPacksConfigContractViolations: skillPacksConfigViolations,
        skillsIndexConfigContractViolations: skillsIndexConfigViolations,
        ruleFileViolations: ruleFileResult.ruleFileViolations.concat(taskModeViolations),
        templatePlaceholderViolations: ruleFileResult.templatePlaceholderViolations,
        commandsContractViolations: commandsViolations.concat(workflowCompileGateCommandViolations),
        manifestContractViolations: manifestViolations.concat(
            optionalSkillSelectionPolicyViolations,
            isolationModeViolations,
            profilesViolations,
            reviewArtifactStorageViolations,
            runtimeRetentionViolations,
            orchestratorConfigViolations
        ),
        coreRuleContractViolations: coreRuleViolations,
        entrypointContractViolations: entrypointViolations,
        taskContractViolations: taskViolations,
        qwenSettingsViolations,
        ...skillContractViolations,
        gitignoreMissing
    };

    const totalViolationCount = (Object.keys(violations) as Array<keyof VerifyViolations>)
        .reduce((total, key) => total + violations[key].length, 0);

    return {
        passed: totalViolationCount === 0,
        targetRoot,
        sourceOfTruth,
        canonicalEntrypoint,
        bundleVersion: versionViolations.bundleVersion,
        requiredPathsChecked: requiredPaths.length,
        violations,
        totalViolationCount
    };
}

const VERIFY_RESULT_COUNT_LABELS: Array<[keyof VerifyViolations, string]> = [
    ['reviewCapabilitiesContractViolations', 'ReviewCapabilitiesContractViolationCount'],
    ['pathsContractViolations', 'PathsContractViolationCount'],
    ['tokenEconomyContractViolations', 'TokenEconomyContractViolationCount'],
    ['outputFiltersContractViolations', 'OutputFiltersContractViolationCount'],
    ['skillPacksConfigContractViolations', 'SkillPacksConfigContractViolationCount'],
    ['skillsIndexConfigContractViolations', 'SkillsIndexConfigContractViolationCount'],
    ['versionContractViolations', 'VersionContractViolationCount'],
    ['ruleFileViolations', 'RuleFileViolationCount'],
    ['templatePlaceholderViolations', 'TemplatePlaceholderViolationCount'],
    ['commandsContractViolations', 'CommandsContractViolationCount'],
    ['manifestContractViolations', 'ManifestContractViolationCount'],
    ['initAnswersContractViolations', 'InitAnswersContractViolationCount'],
    ['coreRuleContractViolations', 'CoreRuleContractViolationCount'],
    ['entrypointContractViolations', 'EntrypointContractViolationCount'],
    ['taskContractViolations', 'TaskContractViolationCount'],
    ['qwenSettingsViolations', 'QwenSettingsViolationCount'],
    ['skillsIndexContractViolations', 'SkillsIndexContractViolationCount'],
    ['skillPackContractViolations', 'SkillPackContractViolationCount']
];

export function formatVerifyResult(result: VerifyResult): string {
    const lines: string[] = [];
    lines.push(`TargetRoot: ${result.targetRoot}`);
    lines.push(`SourceOfTruth: ${result.sourceOfTruth}`);
    lines.push(`CanonicalEntrypoint: ${result.canonicalEntrypoint || 'n/a'}`);
    lines.push(`RequiredPathsChecked: ${result.requiredPathsChecked}`);
    lines.push(`MissingPathCount: ${result.violations.missingPaths.length}`);
    for (const [violationKey, label] of VERIFY_RESULT_COUNT_LABELS.slice(0, 6)) {
        lines.push(`${label}: ${result.violations[violationKey].length}`);
    }
    lines.push(`BundleVersion: ${result.bundleVersion || 'n/a'}`);
    for (const [violationKey, label] of VERIFY_RESULT_COUNT_LABELS.slice(6)) {
        lines.push(`${label}: ${result.violations[violationKey].length}`);
    }
    for (const violationKey of Object.keys(result.violations) as Array<keyof VerifyViolations>) {
        const items = result.violations[violationKey];
        if (items.length > 0) {
            lines.push(`${violationKey}:`);
            for (const item of items) {
                lines.push(` - ${item}`);
            }
        }
    }
    if (!result.passed) {
        lines.push('Verification failed. Resolve listed issues and rerun.');
    } else {
        lines.push('Verification: PASSED');
    }
    return lines.join('\n');
}

/**
 * Format verify result in compact mode.
 * On success: single summary line. On failure: full output (delegates to formatVerifyResult).
 */
export function formatVerifyResultCompact(result: VerifyResult): string {
    if (!result.passed) {
        return formatVerifyResult(result);
    }
    return `Verification: PASSED | paths=${result.requiredPathsChecked} | violations=0`;
}
