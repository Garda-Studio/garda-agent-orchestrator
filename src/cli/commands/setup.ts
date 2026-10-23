import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    DEFAULT_ASSISTANT_LANGUAGE,
    DEFAULT_SOURCE_OF_TRUTH,
    SOURCE_OF_TRUTH_VALUES
} from '../../core/constants';
import { quoteCommandValue } from '../../core/command-quoting';
import {
    buildActiveProfileGuidance,
    buildFullSuiteDisabledGuidance,
    buildNextStepNavigatorGuidance,
    RECOMMENDED_UI_ACTIONS_COMMAND,
    buildTaskStartNavigatorPrompt
} from '../../core/onboarding-contract';
import { pathExists, readTextFile } from '../../core/filesystem';
import { getActiveAgentEntrypointFiles } from '../../materialization/common';
import { getNodeBundleCliCommand } from '../../materialization/command-constants';
import { getStatusSnapshot } from '../../validators/status';
import { readActiveProfileHint } from '../../validators/task-command';
import { buildAgentReportBlock, getAgentReportMessages } from './cli-format-output';
import {
    acquireSourceRoot,
    bold,
    cyan,
    dim,
    ensureDirectoryExists,
    getAgentInitPromptPath,
    getBundlePath,
    getInitAnswerValue,
    green,
    normalizeActiveAgentFiles,
    normalizeAssistantBrevity,
    normalizePathValue,
    normalizeSourceOfTruth,
    parseOptionalText,
    parseOptions,
    printBanner,
    printHelp,
    printStatus,
    promptSingleSelect,
    promptTextInput,
    readOptionalJsonFile,
    resolveWorkspaceDisplayVersion,
    resolvePathInsideRoot,
    supportsInteractivePrompts,
    syncBundleItems,
    type PackageJsonLike,
    type StatusSnapshot,
    tryNormalizeAssistantBrevity,
    tryNormalizeSourceOfTruth,
    yellow,
    tryParseBooleanText
} from './cli-helpers';
import {
    buildRefreshAgentInitState,
    doesAgentInitStateMatchAnswers,
    readAgentInitStateSafe,
    writeAgentInitState
} from '../../runtime/agent-init-state';
import { withLifecycleOperationLockAsync } from '../../lifecycle/common';
import { readPreservableCompileGateCommandFromFile, runContractMigrations } from '../../lifecycle/contract-migrations';
import { serializeInitAnswers } from '../../schemas/init-answers';
import { runInstall } from '../../materialization/install';
import { runInit } from '../../materialization/init';
import { hasMaterializedWorkflowConfigBaseline } from '../../core/workflow-config';
import { validateManifest } from '../../validators/validate-manifest';
import { runVerify } from '../../validators/verify';
import { writeProtectedControlPlaneManifest } from '../../gates/shared';

export const SETUP_DEFINITIONS = {
    '--target-root': { key: 'targetRoot', type: 'string' },
    '--init-answers-path': { key: 'initAnswersPath', type: 'string' },
    '--repo-url': { key: 'repoUrl', type: 'string' },
    '--branch': { key: 'branch', type: 'string' },
    '--dry-run': { key: 'dryRun', type: 'boolean' },
    '--verify': { key: 'runVerify', type: 'boolean' },
    '--no-prompt': { key: 'noPrompt', type: 'boolean' },
    '--skip-verify': { key: 'skipVerify', type: 'boolean' },
    '--skip-manifest-validation': { key: 'skipManifestValidation', type: 'boolean' },
    '--preserve-agent-state': { key: 'preserveAgentState', type: 'boolean' },
    '--assistant-language': { key: 'assistantLanguage', type: 'string' },
    '--assistant-brevity': { key: 'assistantBrevity', type: 'string' },
    '--active-agent-files': { key: 'activeAgentFiles', type: 'string' },
    '--source-of-truth': { key: 'sourceOfTruth', type: 'string' },
    '--enforce-no-auto-commit': { key: 'enforceNoAutoCommit', type: 'string' },
    '--claude-orchestrator-full-access': { key: 'claudeOrchestratorFullAccess', type: 'string' },
    '--claude-full-access': { key: 'claudeOrchestratorFullAccess', type: 'string' },
    '--token-economy-enabled': { key: 'tokenEconomyEnabled', type: 'string' },
    '--provider-minimalism': { key: 'providerMinimalism', type: 'string' }
};

interface SetupOptions {
    help?: boolean;
    version?: boolean;
    targetRoot?: string;
    initAnswersPath?: string;
    repoUrl?: string;
    branch?: string;
    dryRun?: boolean;
    runVerify?: boolean;
    noPrompt?: boolean;
    skipVerify?: boolean;
    skipManifestValidation?: boolean;
    preserveAgentState?: boolean;
    assistantLanguage?: string;
    assistantBrevity?: string;
    activeAgentFiles?: string;
    sourceOfTruth?: string;
    enforceNoAutoCommit?: string;
    claudeOrchestratorFullAccess?: string;
    tokenEconomyEnabled?: string;
    providerMinimalism?: string;
}

interface SetupAnswers {
    assistantLanguage: string;
    assistantBrevity: string;
    sourceOfTruth: string;
    enforceNoAutoCommit: boolean | string;
    claudeOrchestratorFullAccess: boolean | string;
    tokenEconomyEnabled: boolean | string;
    providerMinimalism: boolean | string;
    activeAgentFiles: string | null;
}

function resolveSetupActiveAgentFiles(
    sourceOfTruth: string,
    explicitActiveAgentFiles: string | null | undefined,
    fallbackActiveAgentFiles?: unknown
): string | null {
    const candidateActiveAgentFiles = explicitActiveAgentFiles === undefined
        ? fallbackActiveAgentFiles
        : explicitActiveAgentFiles;
    return normalizeActiveAgentFiles(candidateActiveAgentFiles ?? null, sourceOfTruth);
}

export function getSetupAnswerDefaults(targetRoot: string, initAnswersPath: string, options: SetupOptions): SetupAnswers {
    const resolvedInitAnswersPath = resolvePathInsideRoot(targetRoot, initAnswersPath, 'InitAnswersPath', { allowMissing: true });
    const existingAnswers = readOptionalJsonFile(resolvedInitAnswersPath) || {};
    const sourceOfTruth = tryNormalizeSourceOfTruth(
        options.sourceOfTruth ?? getInitAnswerValue(existingAnswers, 'SourceOfTruth'),
        DEFAULT_SOURCE_OF_TRUTH
    );
    const activeAgentFiles = resolveSetupActiveAgentFiles(
        sourceOfTruth,
        options.activeAgentFiles,
        getInitAnswerValue(existingAnswers, 'ActiveAgentFiles')
    );

    return {
        assistantLanguage:
            parseOptionalText(options.assistantLanguage)
            || parseOptionalText(getInitAnswerValue(existingAnswers, 'AssistantLanguage'))
            || DEFAULT_ASSISTANT_LANGUAGE,
        assistantBrevity: tryNormalizeAssistantBrevity(
            options.assistantBrevity ?? getInitAnswerValue(existingAnswers, 'AssistantBrevity'),
            'concise'
        ),
        sourceOfTruth,
        enforceNoAutoCommit: tryParseBooleanText(
            options.enforceNoAutoCommit ?? getInitAnswerValue(existingAnswers, 'EnforceNoAutoCommit'),
            true
        ),
        claudeOrchestratorFullAccess: tryParseBooleanText(
            options.claudeOrchestratorFullAccess ?? getInitAnswerValue(existingAnswers, 'ClaudeOrchestratorFullAccess'),
            false
        ),
        tokenEconomyEnabled: tryParseBooleanText(
            options.tokenEconomyEnabled ?? getInitAnswerValue(existingAnswers, 'TokenEconomyEnabled'),
            true
        ),
        providerMinimalism: tryParseBooleanText(
            options.providerMinimalism ?? getInitAnswerValue(existingAnswers, 'ProviderMinimalism'),
            true
        ),
        activeAgentFiles
    };
}

export async function collectSetupAnswersInteractively(
    targetRoot: string,
    initAnswersPath: string,
    options: SetupOptions
): Promise<SetupAnswers> {
    const defaults = getSetupAnswerDefaults(targetRoot, initAnswersPath, options);

    const assistantLanguage = await promptTextInput('Set communication language', defaults.assistantLanguage);
    const assistantBrevity = await promptSingleSelect({
        title: 'Set default response brevity',
        defaultLabel: defaults.assistantBrevity,
        defaultValue: defaults.assistantBrevity,
        options: [
            { label: 'concise', value: 'concise' },
            { label: 'detailed', value: 'detailed' }
        ]
    });
    const sourceOfTruth = await promptSingleSelect({
        title: 'Set primary source-of-truth entrypoint',
        defaultLabel: defaults.sourceOfTruth,
        defaultValue: defaults.sourceOfTruth,
        options: [...SOURCE_OF_TRUTH_VALUES].map(function (v) { return { label: v, value: v }; })
    });
    const enforceNoAutoCommit = await promptSingleSelect({
        title: 'Set no-auto-commit guard mode',
        defaultLabel: defaults.enforceNoAutoCommit ? 'Yes' : 'No',
        defaultValue: defaults.enforceNoAutoCommit ? 'true' : 'false',
        options: [
            { label: 'No', value: 'false' },
            { label: 'Yes', value: 'true' }
        ]
    });
    const claudeOrchestratorFullAccess = await promptSingleSelect({
        title: 'Allow Claude Code to run Garda, git diff/log and grep without asking each time (skip if you do not use Claude Code)',
        defaultLabel: defaults.claudeOrchestratorFullAccess ? 'Yes' : 'No',
        defaultValue: defaults.claudeOrchestratorFullAccess ? 'true' : 'false',
        options: [
            { label: 'No', value: 'false' },
            { label: 'Yes', value: 'true' }
        ]
    });
    const tokenEconomyEnabled = await promptSingleSelect({
        title: 'Set default token economy mode',
        defaultLabel: defaults.tokenEconomyEnabled ? 'Yes' : 'No',
        defaultValue: defaults.tokenEconomyEnabled ? 'true' : 'false',
        options: [
            { label: 'No', value: 'false' },
            { label: 'Yes', value: 'true' }
        ]
    });

    const activeAgentFiles = resolveSetupActiveAgentFiles(sourceOfTruth, options.activeAgentFiles);

    return {
        assistantLanguage,
        assistantBrevity,
        sourceOfTruth,
        enforceNoAutoCommit,
        claudeOrchestratorFullAccess,
        tokenEconomyEnabled,
        providerMinimalism: defaults.providerMinimalism,
        activeAgentFiles
    };
}

export function printSetupHandoff(snapshot: StatusSnapshot): void {
    console.log(buildSetupHandoffText(snapshot));
}

function formatSetupHandoffHeading(title: string): string {
    return cyan(title);
}

function formatSetupHandoffLabel(label: string): string {
    return dim(label);
}

export function buildSetupHandoffText(snapshot: StatusSnapshot): string {
    const initPromptPath = getAgentInitPromptPath(snapshot.bundlePath);
    const activeProfileHint = readActiveProfileHint(snapshot.bundlePath);
    const reportMessages = getAgentReportMessages();
    const activeProfileSummary = activeProfileHint.activeProfile || null;
    const reviewModeSummary = reportMessages.summaries.mandatoryOrchestratorGates;
    const optionalSkillsSummary = reportMessages.summaries.askDuringAgentInit;
    const deployedCliCommand = getNodeBundleCliCommand();
    const activeProfileLine = buildActiveProfileGuidance(activeProfileHint.activeProfile, deployedCliCommand);
    const firstTaskPrompt = buildTaskStartNavigatorPrompt();
    const lines = [
        buildAgentReportBlock({
            context: 'setup_handoff',
            assistantLanguage: snapshot.assistantLanguage,
            assistantLanguageConfirmed: snapshot.assistantLanguageConfirmed,
            profileSummary: activeProfileSummary,
            reviewModeSummary,
            optionalSkillsSummary,
            mandatoryFullSuiteEnabled: snapshot.mandatoryFullSuiteEnabled,
            nextCommand: `Give your agent "${initPromptPath}"`,
            nextTaskPrompt: firstTaskPrompt,
            latestUpdateNotice: snapshot.latestUpdateNotice
        }),
        ''
    ];
    lines.push('');
    lines.push(formatSetupHandoffHeading('Agent Initialization'));
    lines.push(`  ${green('Primary setup is complete.')}`);
    lines.push(`  ${yellow('Next stage: launch your agent and give it the init prompt.')}`);
    if (snapshot.activeAgentFiles) {
        lines.push(`  ${formatSetupHandoffLabel('Active agent files:')} ${snapshot.activeAgentFiles}`);
    }
    lines.push(`  ${formatSetupHandoffLabel('Give your agent:')} "${initPromptPath}"`);
    lines.push(`  ${formatSetupHandoffLabel('Agent-init checks:')} validate language; confirm active agent files; update live project rules; ask about specialist skills; run the code-level agent-init gate.`);
    lines.push('');
    lines.push(formatSetupHandoffHeading('First Task Command'));
    lines.push(`  ${yellow('After agent-init passes, pick a task row from TASK.md and tell the agent:')}`);
    lines.push(`  ${firstTaskPrompt}`);
    lines.push(`  ${buildNextStepNavigatorGuidance(deployedCliCommand)}`);
    lines.push('');
    lines.push(formatSetupHandoffHeading('Active Profile'));
    lines.push(`  ${activeProfileLine}`);
    if (snapshot.mandatoryFullSuiteEnabled === false) {
        lines.push(`  ${buildFullSuiteDisabledGuidance(deployedCliCommand)}`);
    }
    lines.push('');
    lines.push(formatSetupHandoffHeading('Workspace UI'));
    lines.push(`  ${formatSetupHandoffLabel('RecommendedUiCommand:')} ${RECOMMENDED_UI_ACTIONS_COMMAND}`);
    lines.push('  After agent-init passes, run this to inspect workspace state and guarded allow-listed settings; mutating actions still require explicit confirmation.');
    lines.push(`RecommendedNextCommand: Give your agent "${initPromptPath}" and complete the agent-init flow, then run ${deployedCliCommand} agent-init --target-root ${quoteCommandValue(path.dirname(snapshot.bundlePath))}`);
    return lines.join('\n');
}

export function buildSetupStepsText(
    targetRoot: string,
    canUseInteractivePrompts: boolean,
    interactiveSetup: boolean
): string {
    const subtitle = canUseInteractivePrompts
        ? 'You will be asked 6 control questions.'
        : interactiveSetup
            ? 'Interactive prompts are unavailable in this terminal. Falling back to script-managed setup.'
            : 'Running in non-interactive mode with provided/default answers.';

    const lines = [];
    lines.push(`Subtitle: ${subtitle}`);
    lines.push(`Project: ${targetRoot}`);
    lines.push(`BundlePath: ${getBundlePath(targetRoot)}`);
    lines.push('');
    lines.push('Setup Steps');
    lines.push('  [1/3] Deploy bundle');
    lines.push('  [2/3] Collect or reuse init answers');
    lines.push('  [3/3] Run install and prepare agent handoff');
    return lines.join('\n');
}

// Emits GARDA_SETUP, [1/3]/[2/3]/[3/3] step markers, GARDA_SETUP_STATUS, and agent handoff if needed.
export async function handleSetup(
    commandArgv: string[],
    packageJson: PackageJsonLike,
    packageRoot: string
): Promise<void> {
    const { options: parsedOptions } = parseOptions(commandArgv, SETUP_DEFINITIONS);
    const options = parsedOptions as SetupOptions;

    if (options.help) { printHelp(packageJson); return; }
    if (options.version) { console.log(packageJson.version); return; }

    const targetRoot = normalizePathValue(options.targetRoot || '.');
    ensureDirectoryExists(targetRoot, 'Target root');
    const interactiveSetup = !options.noPrompt;
    const canUseInteractivePrompts = interactiveSetup && supportsInteractivePrompts();

    console.log('GARDA_SETUP');
    printBanner(
        packageJson,
        'Primary setup',
        canUseInteractivePrompts
            ? 'You will be asked 6 control questions.'
            : interactiveSetup
                ? 'Interactive prompts are unavailable in this terminal. Falling back to script-managed setup.'
                : 'Running in non-interactive mode with provided/default answers.',
        { versionOverride: null }
    );
    console.log(`Project: ${targetRoot}`);
    console.log(`BundlePath: ${getBundlePath(targetRoot)}`);
    console.log('');
    console.log(bold('Setup Steps'));
    console.log(`  ${green('[1/3]')} Deploy bundle`);
    console.log(`  ${green('[2/3]')} Collect or reuse init answers`);
    console.log(`  ${green('[3/3]')} Run install and prepare agent handoff`);
    console.log('');

    const source = await acquireSourceRoot(options.repoUrl, options.branch, packageRoot);
    try {
        await withLifecycleOperationLockAsync(targetRoot, 'setup', async () => {
        const bundlePath = getBundlePath(targetRoot);
        const bundleHadMaterializedLiveBeforeSetup = hasMaterializedWorkflowConfigBaseline(bundlePath);
        const preservedCompileGateCommand = options.dryRun
            ? null
            : readPreservableCompileGateCommandFromFile(path.join(
                bundlePath,
                'live',
                'docs',
                'agent-rules',
                '40-commands.md'
            ));
        const defaultInitAnswersPath = options.initAnswersPath || path.join(path.basename(bundlePath), 'runtime', 'init-answers.json');
        const promptedAnswers: SetupAnswers | null = canUseInteractivePrompts
            ? await collectSetupAnswersInteractively(
                targetRoot,
                defaultInitAnswersPath,
                options
            )
            : null;

        const sourceResolved = path.resolve(source.sourceRoot);
        const bundleResolved = path.resolve(bundlePath);
        if (sourceResolved.toLowerCase() !== bundleResolved.toLowerCase()) {
            if (fs.existsSync(bundlePath) && fs.lstatSync(bundlePath).isDirectory()) {
                syncBundleItems(source.sourceRoot, bundlePath);
            } else if (!options.dryRun) {
                syncBundleItems(source.sourceRoot, bundlePath);
            }
        }

        const effectiveBundlePath = fs.existsSync(bundlePath) ? bundlePath : source.sourceRoot;
        const initAnswersPath = defaultInitAnswersPath;
        const fallbackAnswers = getSetupAnswerDefaults(targetRoot, initAnswersPath, options);
        const resolvedAnswers = promptedAnswers || fallbackAnswers;
        const assistantLanguage = resolvedAnswers.assistantLanguage;
        const assistantBrevity = normalizeAssistantBrevity(resolvedAnswers.assistantBrevity);
        const sourceOfTruth = normalizeSourceOfTruth(resolvedAnswers.sourceOfTruth);
        const enforceNoAutoCommit = String(resolvedAnswers.enforceNoAutoCommit) === 'true';
        const claudeOrchestratorFullAccess = String(resolvedAnswers.claudeOrchestratorFullAccess) === 'true';
        const tokenEconomyEnabled = String(resolvedAnswers.tokenEconomyEnabled) === 'true';
        const providerMinimalism = String(resolvedAnswers.providerMinimalism) === 'true';
        const activeAgentFiles = resolveSetupActiveAgentFiles(
            sourceOfTruth,
            resolvedAnswers.activeAgentFiles
        ) || [];
        const collectedVia = promptedAnswers ? 'CLI_INTERACTIVE' : 'CLI_NONINTERACTIVE';
        const resolvedInitAnswersPath = resolvePathInsideRoot(targetRoot, initAnswersPath, 'InitAnswersPath', { allowMissing: true });
        const normalizedActiveAgentFiles = getActiveAgentEntrypointFiles(activeAgentFiles, sourceOfTruth);
        const previousAgentInitStateResult = readAgentInitStateSafe(targetRoot);
        const previousAgentInitState = previousAgentInitStateResult.state;
        const preserveExistingCheckpoints = doesAgentInitStateMatchAnswers(previousAgentInitState, {
            AssistantLanguage: assistantLanguage,
            SourceOfTruth: sourceOfTruth,
            ActiveAgentFiles: normalizedActiveAgentFiles
        });

        if (!options.dryRun) {
            const initAnswersDir = path.dirname(resolvedInitAnswersPath);
            if (!fs.existsSync(initAnswersDir)) {
                fs.mkdirSync(initAnswersDir, { recursive: true });
            }
            const serialized = serializeInitAnswers({
                AssistantLanguage: assistantLanguage,
                AssistantBrevity: assistantBrevity,
                SourceOfTruth: sourceOfTruth,
                EnforceNoAutoCommit: enforceNoAutoCommit,
                ClaudeOrchestratorFullAccess: claudeOrchestratorFullAccess,
                TokenEconomyEnabled: tokenEconomyEnabled,
                ProviderMinimalism: providerMinimalism,
                CollectedVia: collectedVia,
                ActiveAgentFiles: activeAgentFiles
            });
            fs.writeFileSync(resolvedInitAnswersPath, JSON.stringify(serialized, null, 2), 'utf8');
        }

        const installResult = runInstall({
            targetRoot,
            bundleRoot: effectiveBundlePath,
            assistantLanguage,
            assistantBrevity,
            sourceOfTruth,
            initAnswersPath: resolvedInitAnswersPath,
            dryRun: options.dryRun,
            initRunner: function (initOptions: Omit<Parameters<typeof runInit>[0], 'bundleRoot'>) {
                return runInit(Object.assign({
                    bundleRoot: effectiveBundlePath,
                    preserveLegacyReviewExecutionPolicyOmission: bundleHadMaterializedLiveBeforeSetup,
                    preservedCompileGateCommand
                }, initOptions));
            }
        }) as Record<string, unknown>;

        if (!options.dryRun) {
            runContractMigrations({ rootPath: targetRoot, preservedCompileGateCommand });
            writeProtectedControlPlaneManifest(targetRoot);
        }

        let manifestStatus = options.skipManifestValidation ? 'SKIPPED' : 'PASS';
        if (!options.skipManifestValidation) {
            try {
                const manifestPath = path.join(effectiveBundlePath, 'MANIFEST.md');
                const manifestResult = validateManifest(manifestPath, targetRoot);
                manifestStatus = manifestResult.passed ? 'PASS' : 'FAIL';
            } catch (_error) {
                manifestStatus = 'ERROR';
            }
        }

        let snapshot = getStatusSnapshot(targetRoot, initAnswersPath);
        let verifyStatus = options.skipVerify ? 'SKIPPED' : 'PENDING_AGENT_CONTEXT';
        if (!options.skipVerify) {
            try {
                if (snapshot.readyForTasks || options.runVerify || options.preserveAgentState) {
                    const verifyResult = runVerify({
                        targetRoot,
                        sourceOfTruth,
                        initAnswersPath: resolvedInitAnswersPath
                    });
                    verifyStatus = verifyResult.totalViolationCount > 0 ? 'FAIL' : 'PASS';
                }
            } catch (_error) {
                verifyStatus = 'PENDING_AGENT_CONTEXT';
            }
        }

        const bundleVersionPath = path.join(effectiveBundlePath, 'VERSION');
        const bundleVersion = pathExists(bundleVersionPath)
            ? (readTextFile(bundleVersionPath).trim() || null)
            : null;

        if (!options.dryRun) {
            writeAgentInitState(targetRoot, buildRefreshAgentInitState({
                previousState: previousAgentInitState,
                preserveExistingCheckpoints,
                assistantLanguage,
                sourceOfTruth,
                orchestratorVersion: bundleVersion,
                activeAgentFiles: normalizedActiveAgentFiles,
                verificationPassed: options.skipVerify ? null : verifyStatus === 'PASS',
                manifestValidationPassed: options.skipManifestValidation ? null : manifestStatus === 'PASS',
                autoConfirmPrompts: options.preserveAgentState === true,
                autoAcceptRules: options.preserveAgentState === true
            }));
            snapshot = getStatusSnapshot(targetRoot, initAnswersPath);
        }

        console.log(`Setup: ${manifestStatus === 'FAIL' ? 'FAIL' : 'PASSED'}`);
        console.log(`Verify: ${verifyStatus}`);
        console.log(`ManifestValidation: ${manifestStatus}`);
        if (typeof installResult.workflowConfigMergeStatus === 'string') {
            console.log(`WorkflowConfigMerge: ${installResult.workflowConfigMergeStatus}`);
        }
        if (typeof installResult.optionalQualityChecksNotice === 'string' && installResult.optionalQualityChecksNotice.trim()) {
            console.log(installResult.optionalQualityChecksNotice);
        }
        console.log('');
        printBanner(
            packageJson,
            'Setup complete',
            snapshot.readyForTasks
                ? 'Workspace is ready.'
                : 'Primary setup finished. Next stage: agent initialization.',
            { versionOverride: bundleVersion || resolveWorkspaceDisplayVersion(targetRoot, packageJson.version) }
        );
        printStatus(snapshot, { heading: 'GARDA_SETUP_STATUS' });
        if (!snapshot.agentInitializationComplete) {
            printSetupHandoff(snapshot);
        }
        });
    } finally {
        source.cleanup();
    }
}
