import * as path from 'node:path';
import {
    UNCONFIGURED_COMPILE_GATE_COMMAND,
    UNCONFIGURED_FULL_SUITE_VALIDATION_COMMAND,
    resolveBundleName
} from '../core/constants';
import { pathExists, readTextFile, writeTextFile } from '../core/filesystem';
import { captureWorkflowConfigMigration, recordWorkflowConfigMigration } from '../core/workflow-config-migration';
import { readJsonFile, writeJsonFile } from '../core/json';
import { isPlainObject } from '../core/config-merge';
import { getWorkflowConfigPath, isConfiguredCompileGateCommand, syncWorkflowConfigWithTemplate,
    writeWorkflowConfigIfChanged } from '../core/workflow-config';
import { validateInitAnswers, serializeInitAnswers } from '../schemas/init-answers';
import { convertActiveAgentEntrypointFilesToString, getActiveAgentEntrypointFiles } from '../materialization/common';
import { resolveSuggestedCompileGateCommands, resolveSuggestedFullSuiteValidationCommand } from '../materialization/project-discovery';
import { runInstall } from '../materialization/install';
import {
    seedProjectMemoryFromTemplate,
    validateSeededProjectMemory,
    writeProjectMemoryBootstrapReport
} from '../materialization/project-memory-builder';
import { applyCompileGateCommandDefaults, generateProjectMemorySummary } from '../materialization/rule-materialization';
import { runVerify } from '../validators/verify';
import { validateManifest } from '../validators/validate-manifest';
import { createAgentInitState, readAgentInitStateSafe, writeAgentInitState } from '../runtime/agent-init-state';
import { writeProtectedControlPlaneManifest } from '../gates/shared/helpers';
import { validateCompileGateCommand } from '../gates/compile/compile-gate';
import { readPreservableCompileGateCommandFromFile } from './agent-init/contract-migrations';
import { isSourceCheckoutRoot } from '../validators/workspace-layout/source-runtime';
import {
    PROJECT_MEMORY_READ_FIRST_FILE_NAMES,
    PROJECT_MEMORY_SUMMARY_RULE_RELATIVE_PATH,
    buildProjectMemoryLiveRelativePath,
    resolveProjectMemoryBootstrapReportPath
} from '../core/project-memory';
import {
    DEFAULT_ORDINARY_DOC_PATHS,
    ORDINARY_DOC_PATHS_CONFIG_KEY,
    normalizeOrdinaryDocPathPatterns,
    parseOrdinaryDocPathList
} from '../core/ordinary-doc-paths';

interface AgentInitState {
    OrchestratorVersion: string | null;
    AssistantLanguage: string | null;
    SourceOfTruth: string | null;
    AssistantLanguageConfirmed: boolean;
    ActiveAgentFilesConfirmed: boolean;
    ProjectRulesUpdated: boolean;
    SkillsPromptCompleted: boolean;
    OrdinaryDocPathsConfirmed: boolean;
    OrdinaryDocPaths: string[];
    VerificationPassed: boolean;
    ManifestValidationPassed: boolean;
    ActiveAgentFiles: string[];
    LastSeededFullSuiteCommand: string | null;
    ProjectMemoryInitialized: boolean;
    ProjectMemoryValidated: boolean;
    ProjectMemoryMode: string | null;
    ProjectMemoryDir: string | null;
    ProjectMemoryReadFirst: string[];
    ProjectMemorySummaryRule: string | null;
    ProjectMemoryBootstrapReport: string | null;
    ProjectMemoryWarnings: string[];
}

interface AgentInitInstallOptions {
    targetRoot: string;
    bundleRoot: string;
    preserveExisting: boolean;
    alignExisting: boolean;
    runInit: boolean;
    answerDependentOnly: boolean;
    skipBackups: boolean;
    assistantLanguage: string;
    assistantBrevity: string;
    sourceOfTruth: string;
    initAnswersPath: string;
}

interface AgentInitVerifyOptions {
    targetRoot: string;
    sourceOfTruth: string;
    initAnswersPath: string;
}

interface RunAgentInitOptions {
    targetRoot: string;
    bundleRoot?: string;
    initAnswersPath?: string;
    activeAgentFiles: string | string[] | null | undefined;
    projectRulesUpdated: unknown;
    skillsPrompted: unknown;
    ordinaryDocPaths?: unknown;
    installRunner?: (options: AgentInitInstallOptions) => void;
    verifyRunner?: (options: AgentInitVerifyOptions) => { passed: boolean };
    manifestRunner?: (manifestPath: string) => { passed: boolean };
}

export interface AgentInitResult {
    targetRoot: string;
    bundleRoot: string;
    initAnswersPath: string;
    agentInitStatePath: string;
    activeAgentFiles: string[];
    projectRulesUpdated: boolean;
    skillsPromptCompleted: boolean;
    verifyPassed: boolean;
    manifestPassed: boolean;
    readyForTasks: boolean;
    ordinaryDocPaths: string[];
    ordinaryDocPathsDiscovered: string[];
    ordinaryDocPathsConfirmed: boolean;
    ordinaryDocPathsNeedsConfirmation: boolean;
    ordinaryDocPathsPersisted: boolean;
    ordinaryDocPathsConfigPath: string;
    ordinaryDocPathsEditHint: string;
    projectMemoryInitialized: boolean;
    projectMemoryValidated: boolean;
    projectMemoryMode: string;
    projectMemoryDir: string;
    projectMemoryReadFirst: string[];
    projectMemorySummaryRule: string;
    projectMemoryBootstrapReport: string;
    projectMemoryWarnings: string[];
    verifyResult: { passed: boolean };
    manifestResult: { passed: boolean };
    state: AgentInitState;
}

function normalizeOptionalCommand(value: unknown): string | null {
    const text = String(value || '').trim();
    return text || null;
}

function normalizeCompileGateCommandCandidate(command: unknown, sourceLabel: string): string | null {
    const normalized = String(command || '').trim();
    if (!normalized || normalized === UNCONFIGURED_COMPILE_GATE_COMMAND) {
        return null;
    }
    try {
        validateCompileGateCommand(normalized, sourceLabel);
        return normalized;
    } catch {
        return null;
    }
}

function resolveDetectedCompileGateCommand(targetRoot: string): string | null {
    for (const candidate of resolveSuggestedCompileGateCommands(targetRoot)) {
        const command = normalizeCompileGateCommandCandidate(candidate, 'agent-init project discovery');
        if (command) {
            return command;
        }
    }
    return null;
}

function syncCompileGateCommandGuidance(bundleRoot: string, command: string): void {
    const commandsRulePath = path.join(bundleRoot, 'live', 'docs', 'agent-rules', '40-commands.md');
    if (!pathExists(commandsRulePath)) {
        return;
    }
    const currentContent = readTextFile(commandsRulePath);
    const updatedContent = applyCompileGateCommandDefaults(currentContent, '40-commands.md', [command]);
    if (updatedContent !== currentContent) {
        writeTextFile(commandsRulePath, updatedContent);
    }
}

function buildAgentInitWorkflowConfigMergeOptions(targetRoot: string) {
    return {
        preserveLegacyReviewExecutionPolicyOmission: true,
        preserveMovedProjectQualityRulesAsCustom: isSourceCheckoutRoot(targetRoot)
    };
}

function seedWorkflowConfigCompileGateCommand(targetRoot: string, bundleRoot: string): void {
    const workflowConfigPath = getWorkflowConfigPath(bundleRoot);
    const rawConfig = syncWorkflowConfigWithTemplate(bundleRoot, buildAgentInitWorkflowConfigMergeOptions(targetRoot));
    const existingSection = isPlainObject(rawConfig.compile_gate)
        ? rawConfig.compile_gate as Record<string, unknown>
        : {};
    if (isConfiguredCompileGateCommand(existingSection.command)) {
        syncCompileGateCommandGuidance(bundleRoot, String(existingSection.command));
        return;
    }

    const preservedCommand = readPreservableCompileGateCommandFromFile(path.join(
        bundleRoot,
        'live',
        'docs',
        'agent-rules',
        '40-commands.md'
    ));
    const detectedCommand = normalizeCompileGateCommandCandidate(
        preservedCommand,
        'agent-init preserved compile-gate command'
    ) || resolveDetectedCompileGateCommand(targetRoot);
    const nextConfig = {
        ...rawConfig,
        compile_gate: {
            ...existingSection,
            command: detectedCommand || UNCONFIGURED_COMPILE_GATE_COMMAND
        }
    };
    writeWorkflowConfigIfChanged(workflowConfigPath, nextConfig);
    syncCompileGateCommandGuidance(bundleRoot, detectedCommand || UNCONFIGURED_COMPILE_GATE_COMMAND);
}

function seedWorkflowConfigFullSuiteCommand(
    targetRoot: string,
    bundleRoot: string,
    previousState: AgentInitState | null
): string | null {
    const detectedCommand = resolveSuggestedFullSuiteValidationCommand(targetRoot)
        || UNCONFIGURED_FULL_SUITE_VALIDATION_COMMAND;
    const workflowConfigPath = getWorkflowConfigPath(bundleRoot);
    const rawConfig = syncWorkflowConfigWithTemplate(bundleRoot, buildAgentInitWorkflowConfigMergeOptions(targetRoot));

    const existingSection = isPlainObject(rawConfig.full_suite_validation)
        ? rawConfig.full_suite_validation as Record<string, unknown>
        : {};
    const currentCommand = normalizeOptionalCommand(existingSection.command);
    const previousSeededCommand = normalizeOptionalCommand(previousState?.LastSeededFullSuiteCommand);
    const shouldReplaceCommand = !currentCommand
        || currentCommand === UNCONFIGURED_FULL_SUITE_VALIDATION_COMMAND;

    const nextCommand = shouldReplaceCommand ? detectedCommand : currentCommand;
    const nextConfig = {
        ...rawConfig,
        full_suite_validation: {
            ...existingSection,
            enabled: existingSection.enabled === true,
            command: nextCommand,
        }
    };

    const nextSeededCommand = shouldReplaceCommand ? detectedCommand : previousSeededCommand;
    writeWorkflowConfigIfChanged(workflowConfigPath, nextConfig);
    return nextSeededCommand;
}

function resolvePathInsideTarget(targetRoot: string, relativeOrAbsolutePath: string): string {
    return path.isAbsolute(relativeOrAbsolutePath)
        ? relativeOrAbsolutePath
        : path.resolve(targetRoot, relativeOrAbsolutePath);
}

function discoverOrdinaryDocPathCandidates(targetRoot: string): string[] {
    const candidates = [
        ...DEFAULT_ORDINARY_DOC_PATHS,
        'docs/plan.md',
        'docs/planning.md',
        'docs/roadmap.md',
        'docs/todo.md',
        'docs/backlog.md',
        'PLAN.md',
        'ROADMAP.md',
        'TODO.md',
        'BACKLOG.md',
        'NOTES.md'
    ];
    const discovered = candidates.filter((candidate) => (
        DEFAULT_ORDINARY_DOC_PATHS.includes(candidate)
        || pathExists(path.join(targetRoot, candidate))
    ));
    return normalizeOrdinaryDocPathPatterns(discovered, ORDINARY_DOC_PATHS_CONFIG_KEY);
}

function readPathsConfig(pathsConfigPath: string): Record<string, unknown> {
    if (!pathExists(pathsConfigPath)) {
        return {};
    }
    const parsed = readJsonFile(pathsConfigPath);
    return isPlainObject(parsed) ? parsed as Record<string, unknown> : {};
}

function syncOrdinaryDocPathsConfig(
    targetRoot: string,
    bundleRoot: string,
    ordinaryDocPathsOption: unknown,
    previousState: AgentInitState | null
): {
    paths: string[];
    discovered: string[];
    confirmed: boolean;
    needsConfirmation: boolean;
    persisted: boolean;
    configPath: string;
    editHint: string;
} {
    const pathsConfigPath = path.join(bundleRoot, 'live', 'config', 'paths.json');
    const discovered = discoverOrdinaryDocPathCandidates(targetRoot);
    const rawConfig = readPathsConfig(pathsConfigPath);
    const hasConfirmedOption = ordinaryDocPathsOption !== undefined && ordinaryDocPathsOption !== null;
    const hasConfiguredKey = rawConfig[ORDINARY_DOC_PATHS_CONFIG_KEY] !== undefined;
    const previousConfirmed = previousState?.OrdinaryDocPathsConfirmed === true;
    const existingPaths = rawConfig[ORDINARY_DOC_PATHS_CONFIG_KEY] === undefined
        ? []
        : normalizeOrdinaryDocPathPatterns(
            rawConfig[ORDINARY_DOC_PATHS_CONFIG_KEY],
            `paths.${ORDINARY_DOC_PATHS_CONFIG_KEY}`,
            { allowScalar: true }
        );
    let paths: string[];
    if (hasConfirmedOption) {
        paths = parseOrdinaryDocPathList(ordinaryDocPathsOption, ORDINARY_DOC_PATHS_CONFIG_KEY);
    } else if (previousConfirmed && hasConfiguredKey) {
        paths = existingPaths;
    } else if (previousConfirmed) {
        paths = previousState!.OrdinaryDocPaths;
    } else {
        paths = hasConfiguredKey ? existingPaths : discovered;
    }

    const confirmed = hasConfirmedOption || previousConfirmed;
    const needsConfirmation = !confirmed;

    let persisted = false;
    if (hasConfirmedOption || (previousConfirmed && !hasConfiguredKey)) {
        writeJsonFile(pathsConfigPath, {
            ...rawConfig,
            [ORDINARY_DOC_PATHS_CONFIG_KEY]: paths
        });
        persisted = true;
    }

    return {
        paths,
        discovered,
        confirmed,
        needsConfirmation,
        persisted,
        configPath: pathsConfigPath,
        editHint: `Edit ${path.join('garda-agent-orchestrator', 'live', 'config', 'paths.json')} field ${ORDINARY_DOC_PATHS_CONFIG_KEY}.`
    };
}

function parseBooleanYesNo(value: unknown, fieldName: string): boolean {
    if (value === true || value === false) {
        return value;
    }

    const normalized = String(value || '').trim().toLowerCase();
    if (normalized === 'yes' || normalized === 'true' || normalized === '1') {
        return true;
    }
    if (normalized === 'no' || normalized === 'false' || normalized === '0') {
        return false;
    }
    throw new Error(`${fieldName} must be yes or no.`);
}

function toBundleRelativePath(bundleRoot: string, filePath: string): string {
    return path.relative(bundleRoot, filePath).replace(/\\/g, '/');
}

function buildProjectMemoryWarnings(seedResult: ReturnType<typeof seedProjectMemoryFromTemplate>, validation: ReturnType<typeof validateSeededProjectMemory>): string[] {
    const warnings: string[] = [];
    const addWarning = (warning: string): void => {
        if (!warnings.includes(warning)) {
            warnings.push(warning);
        }
    };

    if (seedResult.missingTemplateFiles.length > 0) {
        addWarning(`Project memory template files are missing: ${seedResult.missingTemplateFiles.join(', ')}. Restore template/docs/project-memory and rerun agent-init.`);
    }
    for (const issue of validation.issues) {
        if (issue.code === 'project_memory_placeholder_heavy') {
            addWarning('Project memory is seeded but not project-specific. Finish AGENT_INIT_PROMPT memory enrichment before declaring the workspace ready.');
            continue;
        }
        const fileSuffix = issue.file ? ` ${issue.file}` : '';
        addWarning(`${issue.code}${fileSuffix}: ${issue.message}`);
    }

    return warnings;
}

function bootstrapProjectMemory(bundleRoot: string, timestampIso: string) {
    const templateRoot = path.join(bundleRoot, 'template');
    const liveRoot = path.join(bundleRoot, 'live');
    const seedResult = seedProjectMemoryFromTemplate({ templateRoot, liveRoot });
    const summaryPath = path.join(bundleRoot, PROJECT_MEMORY_SUMMARY_RULE_RELATIVE_PATH);
    const summary = generateProjectMemorySummary(seedResult.projectMemoryDir, timestampIso);
    writeTextFile(summaryPath, summary);
    const validation = validateSeededProjectMemory(seedResult, { mode: 'strict' });
    const reportResult = writeProjectMemoryBootstrapReport({
        bundleRoot,
        timestampIso,
        seedResult,
        validation,
        summaryPath
    });
    const missingOrUnseededFiles = new Set([
        ...seedResult.missingTemplateFiles,
        ...validation.missingFiles
    ]);

    const initialized = missingOrUnseededFiles.size === 0;
    const validated = validation.passed && validation.issues.length === 0;

    return {
        // Contract: initialized is file presence after seed/preserve; validated is strict content readiness.
        initialized,
        validated,
        mode: validation.mode,
        dir: buildProjectMemoryLiveRelativePath(),
        readFirst: PROJECT_MEMORY_READ_FIRST_FILE_NAMES.map((fileName) => buildProjectMemoryLiveRelativePath(fileName)),
        summaryRule: PROJECT_MEMORY_SUMMARY_RULE_RELATIVE_PATH,
        bootstrapReport: toBundleRelativePath(bundleRoot, reportResult.path || resolveProjectMemoryBootstrapReportPath(bundleRoot)),
        warnings: buildProjectMemoryWarnings(seedResult, validation),
        seedResult,
        validation
    };
}

export function runAgentInit(options: RunAgentInitOptions): AgentInitResult {
    const {
        targetRoot,
        bundleRoot = path.join(targetRoot, resolveBundleName()),
        initAnswersPath = path.join(resolveBundleName(), 'runtime', 'init-answers.json'),
        activeAgentFiles,
        projectRulesUpdated,
        skillsPrompted,
        ordinaryDocPaths,
        installRunner = runInstall,
        verifyRunner = runVerify,
        manifestRunner = validateManifest
    } = options;

    const normalizedTargetRoot = path.resolve(targetRoot);
    const normalizedBundleRoot = path.resolve(bundleRoot);
    const resolvedInitAnswersPath = resolvePathInsideTarget(normalizedTargetRoot, initAnswersPath);
    const previousState = readAgentInitStateSafe(normalizedTargetRoot).state as AgentInitState | null;
    const bundleVersionPath = path.join(normalizedBundleRoot, 'VERSION');
    const orchestratorVersion = pathExists(bundleVersionPath)
        ? (readTextFile(bundleVersionPath).trim() || null)
        : null;

    if (!pathExists(normalizedBundleRoot)) {
        throw new Error(`Deployed bundle not found: ${normalizedBundleRoot}`);
    }
    if (!pathExists(resolvedInitAnswersPath)) {
        throw new Error(`Init answers artifact not found: ${resolvedInitAnswersPath}`);
    }

    const answers = validateInitAnswers(readJsonFile(resolvedInitAnswersPath));
    const normalizedActiveFiles = getActiveAgentEntrypointFiles(activeAgentFiles, answers.SourceOfTruth);
    if (normalizedActiveFiles.length === 0) {
        throw new Error('ActiveAgentFiles must resolve to at least one canonical entrypoint.');
    }

    const serializedAnswers = serializeInitAnswers({
        ...answers,
        CollectedVia: 'AGENT_INIT_PROMPT.md',
        ActiveAgentFiles: convertActiveAgentEntrypointFilesToString(normalizedActiveFiles)
    });
    const workflowMigration = captureWorkflowConfigMigration(normalizedTargetRoot);
    writeJsonFile(resolvedInitAnswersPath, serializedAnswers);

    installRunner({
        targetRoot: normalizedTargetRoot,
        bundleRoot: normalizedBundleRoot,
        preserveExisting: true,
        alignExisting: true,
        runInit: false,
        answerDependentOnly: true,
        skipBackups: true,
        assistantLanguage: serializedAnswers.AssistantLanguage,
        assistantBrevity: serializedAnswers.AssistantBrevity,
        sourceOfTruth: serializedAnswers.SourceOfTruth,
        initAnswersPath: resolvedInitAnswersPath
    });

    seedWorkflowConfigCompileGateCommand(normalizedTargetRoot, normalizedBundleRoot);
    const seededFullSuiteCommand = seedWorkflowConfigFullSuiteCommand(
        normalizedTargetRoot,
        normalizedBundleRoot,
        previousState
    );
    const ordinaryDocPathsResult = syncOrdinaryDocPathsConfig(
        normalizedTargetRoot,
        normalizedBundleRoot,
        ordinaryDocPaths,
        previousState
    );
    const projectMemoryResult = bootstrapProjectMemory(normalizedBundleRoot, new Date().toISOString());

    const verifyResult = verifyRunner({
        targetRoot: normalizedTargetRoot,
        sourceOfTruth: serializedAnswers.SourceOfTruth,
        initAnswersPath: resolvedInitAnswersPath
    });
    const manifestResult = manifestRunner(path.join(normalizedBundleRoot, 'MANIFEST.md'));

    const state = createAgentInitState({
        OrchestratorVersion: orchestratorVersion,
        AssistantLanguage: serializedAnswers.AssistantLanguage,
        SourceOfTruth: serializedAnswers.SourceOfTruth,
        AssistantLanguageConfirmed: true,
        ActiveAgentFilesConfirmed: true,
        ProjectRulesUpdated: parseBooleanYesNo(projectRulesUpdated, 'ProjectRulesUpdated'),
        SkillsPromptCompleted: parseBooleanYesNo(skillsPrompted, 'SkillsPrompted'),
        OrdinaryDocPathsConfirmed: ordinaryDocPathsResult.confirmed,
        OrdinaryDocPaths: ordinaryDocPathsResult.confirmed ? ordinaryDocPathsResult.paths : [],
        VerificationPassed: verifyResult.passed,
        ManifestValidationPassed: manifestResult.passed,
        ActiveAgentFiles: normalizedActiveFiles,
        LastSeededFullSuiteCommand: seededFullSuiteCommand,
        ProjectMemoryInitialized: projectMemoryResult.initialized,
        ProjectMemoryValidated: projectMemoryResult.validated,
        ProjectMemoryMode: projectMemoryResult.mode,
        ProjectMemoryDir: projectMemoryResult.dir,
        ProjectMemoryReadFirst: projectMemoryResult.readFirst,
        ProjectMemorySummaryRule: projectMemoryResult.summaryRule,
        ProjectMemoryBootstrapReport: projectMemoryResult.bootstrapReport,
        ProjectMemoryWarnings: projectMemoryResult.warnings
    }) as AgentInitState;
    const statePath = writeAgentInitState(normalizedTargetRoot, state);
    recordWorkflowConfigMigration(normalizedTargetRoot, workflowMigration, {
        initializeUnconfiguredCommands: true
    });
    writeProtectedControlPlaneManifest(normalizedTargetRoot);

    return {
        targetRoot: normalizedTargetRoot,
        bundleRoot: normalizedBundleRoot,
        initAnswersPath: resolvedInitAnswersPath,
        agentInitStatePath: statePath,
        activeAgentFiles: normalizedActiveFiles,
        projectRulesUpdated: state.ProjectRulesUpdated,
        skillsPromptCompleted: state.SkillsPromptCompleted,
        verifyPassed: verifyResult.passed,
        manifestPassed: manifestResult.passed,
        ordinaryDocPaths: ordinaryDocPathsResult.paths,
        ordinaryDocPathsDiscovered: ordinaryDocPathsResult.discovered,
        ordinaryDocPathsConfirmed: ordinaryDocPathsResult.confirmed,
        ordinaryDocPathsNeedsConfirmation: ordinaryDocPathsResult.needsConfirmation,
        ordinaryDocPathsPersisted: ordinaryDocPathsResult.persisted,
        ordinaryDocPathsConfigPath: ordinaryDocPathsResult.configPath,
        ordinaryDocPathsEditHint: ordinaryDocPathsResult.editHint,
        projectMemoryInitialized: state.ProjectMemoryInitialized,
        projectMemoryValidated: state.ProjectMemoryValidated,
        projectMemoryMode: state.ProjectMemoryMode || projectMemoryResult.mode,
        projectMemoryDir: state.ProjectMemoryDir || projectMemoryResult.dir,
        projectMemoryReadFirst: state.ProjectMemoryReadFirst,
        projectMemorySummaryRule: state.ProjectMemorySummaryRule || projectMemoryResult.summaryRule,
        projectMemoryBootstrapReport: state.ProjectMemoryBootstrapReport || projectMemoryResult.bootstrapReport,
        projectMemoryWarnings: state.ProjectMemoryWarnings,
        readyForTasks: (
            state.AssistantLanguageConfirmed
            && state.ActiveAgentFilesConfirmed
            && state.ProjectRulesUpdated
            && state.SkillsPromptCompleted
            && state.OrdinaryDocPathsConfirmed
            && state.VerificationPassed
            && state.ManifestValidationPassed
            && state.ProjectMemoryInitialized
            && state.ProjectMemoryValidated
        ),
        verifyResult,
        manifestResult,
        state
    };
}
