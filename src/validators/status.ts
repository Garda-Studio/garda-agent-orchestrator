import { TASK_QUEUE_FILENAME } from '../core/orchestration-constants';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    UNCONFIGURED_COMPILE_GATE_COMMAND,
    resolveAgentInitStateRelativePathForTarget,
    resolveInitAnswersRelativePathForTarget
} from '../core/constants';
import { pathExists, readTextFile } from '../core/filesystem';
import { isPathInsideRoot } from '../core/paths';
import { validateInitAnswers } from '../schemas/init-answers';
import { doesAgentInitStateMatchAnswers, readAgentInitStateSafe } from '../runtime/agent-init-state';
import {
    getBundlePath,
    getCanonicalEntrypoint,
    getCommandsRulePath,
    getMissingProjectCommands,
    readUtf8IfExists,
    detectSourceBundleParity
} from './workspace-layout';
import { collectTimelineSummaryForStatus } from '../gate-runtime/timeline-summary';
import { scanProviderCompliance } from './provider-compliance';
import { evaluateProtectedControlPlaneManifest } from '../gates/shared/helpers';
import {
    collectToxinSnapshot,
    buildToxinStatusSummary
} from '../runtime/toxin-metrics';
import { assessProtectedManifest } from './protected-manifest-assessment';
import { buildTaskQueueStatusMap, readTaskQueueStatusMap } from './task-status-map';
import type { TaskQueueEntry } from '../core/task-queue-read';
import { buildRecommendedNextCommand } from './status/status-recommendations';
import { RECOMMENDED_UI_ACTIONS_COMMAND } from '../core/onboarding-contract';
import { formatFullSuitePerformanceGuidance } from '../gates/full-suite/full-suite-validation';
import { getWorkflowConfigPath, isConfiguredCompileGateCommand } from '../core/workflow-config';
import { readLatestScopeBudgetStatus } from '../core/scope-budget-status';
import {
    resolveReviewRemediationModePolicyFromProfile,
    summarizeReviewRemediationModePolicy
} from '../policy/review-remediation-mode-policy';
import type {
    AgentInitializationPendingCheckpoint,
    AgentInitializationPendingReason,
    AgentInitState,
    AgentInitStateResult,
    InitAnswers,
    InitAnswersState,
    LiveVersionPayload,
    LiveVersionState,
    StatusSnapshot,
    TaskCycleStatusSnapshot,
    TimelineSummary
} from './status/status-types';

export type { StatusSnapshot, TaskCycleStatusSnapshot } from './status/status-types';
export {
    formatStatusSnapshot,
    formatStatusSnapshotCompact,
    formatStatusSnapshotJson
} from './status/status-rendering';

export interface AgentInitializationReadinessSnapshot {
    bundlePath: string;
    primaryInitializationComplete: boolean;
    agentInitializationPendingReason: AgentInitializationPendingReason;
    missingProjectCommands: string[];
}

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function readMandatoryFullSuiteConfig(bundlePath: string): {
    enabled: boolean | null;
    command: string | null;
    performance: string | null;
} {
    const workflowConfigPath = path.join(bundlePath, 'live', 'config', 'workflow-config.json');
    if (!pathExists(workflowConfigPath)) {
        return { enabled: null, command: null, performance: null };
    }

    try {
        const parsed = JSON.parse(readTextFile(workflowConfigPath)) as Record<string, unknown>;
        const rawSection = parsed.full_suite_validation;
        if (!rawSection || typeof rawSection !== 'object' || Array.isArray(rawSection)) {
            return { enabled: null, command: null, performance: null };
        }
        const section = rawSection as Record<string, unknown>;
        const enabled = section.enabled;
        const command = typeof section.command === 'string' && section.command.trim()
            ? section.command.trim()
            : null;
        return {
            enabled: typeof enabled === 'boolean' ? enabled : null,
            command,
            performance: command ? formatFullSuitePerformanceGuidance(command) : null
        };
    } catch {
        return { enabled: null, command: null, performance: null };
    }
}

function readCompileGateCommandStatus(bundlePath: string): { configured: boolean; command: string | null } {
    const workflowConfigPath = getWorkflowConfigPath(bundlePath);
    if (!pathExists(workflowConfigPath)) {
        return { configured: false, command: null };
    }

    try {
        const parsed = JSON.parse(readTextFile(workflowConfigPath)) as Record<string, unknown>;
        const rawSection = parsed.compile_gate;
        if (!rawSection || typeof rawSection !== 'object' || Array.isArray(rawSection)) {
            return { configured: false, command: null };
        }
        const section = rawSection as Record<string, unknown>;
        const command = typeof section.command === 'string' && section.command.trim()
            ? section.command.trim()
            : UNCONFIGURED_COMPILE_GATE_COMMAND;
        return {
            configured: isConfiguredCompileGateCommand(command),
            command
        };
    } catch {
        return { configured: false, command: null };
    }
}

function readLatestUpdateNotice(bundlePath: string): string | null {
    const reportsDir = path.join(bundlePath, 'runtime', 'update-reports');
    if (!pathExists(reportsDir) || !fs.statSync(reportsDir).isDirectory()) {
        return null;
    }

    const latestReport = fs.readdirSync(reportsDir)
        .filter((entry) => entry.toLowerCase().endsWith('.md'))
        .map((entry) => {
            const reportPath = path.join(reportsDir, entry);
            return {
                path: reportPath,
                mtimeMs: fs.statSync(reportPath).mtimeMs
            };
        })
        .sort((left, right) => right.mtimeMs - left.mtimeMs)[0];

    if (!latestReport) {
        return null;
    }

    try {
        const lines = readTextFile(latestReport.path).split(/\r?\n/);
        const updatedVersionLine = lines.find((line) => line.startsWith('UpdatedVersion: '));
        if (updatedVersionLine) {
            return updatedVersionLine.replace(/^UpdatedVersion:\s*/, '').trim();
        }
    } catch {
        return null;
    }

    return null;
}

export function resolveInitAnswersPath(targetRoot: string, initAnswersPath?: string): string {
    let candidate = String(initAnswersPath || '').trim();
    if (!candidate) {
        candidate = resolveInitAnswersRelativePathForTarget(targetRoot);
    }
    if (!path.isAbsolute(candidate)) {
        candidate = path.join(targetRoot, candidate);
    }

    const fullPath = path.resolve(candidate);
    if (!isPathInsideRoot(targetRoot, fullPath)) {
        throw new Error(`InitAnswersPath must resolve inside TargetRoot '${targetRoot}'. Resolved path: ${fullPath}`);
    }
    return fullPath;
}

export function readInitAnswersSafe(
    targetRoot: string,
    initAnswersResolvedPath: string
): { answers: InitAnswers | null; error: string | null } {
    void targetRoot;
    if (!pathExists(initAnswersResolvedPath)) {
        return { answers: null, error: null };
    }

    try {
        const stats = fs.lstatSync(initAnswersResolvedPath);
        if (!stats.isFile()) {
            return {
                answers: null,
                error: `Init answers path is not a file: ${initAnswersResolvedPath}`
            };
        }
    } catch {
        return {
            answers: null,
            error: `Cannot stat init answers path: ${initAnswersResolvedPath}`
        };
    }

    try {
        const raw = readTextFile(initAnswersResolvedPath);
        if (!raw.trim()) {
            return {
                answers: null,
                error: `Init answers artifact is empty: ${initAnswersResolvedPath}`
            };
        }

        let parsed: unknown;
        try {
            parsed = JSON.parse(raw);
        } catch {
            return {
                answers: null,
                error: `Init answers artifact is not valid JSON: ${initAnswersResolvedPath}`
            };
        }

        return {
            answers: validateInitAnswers(parsed),
            error: null
        };
    } catch (error: unknown) {
        return {
            answers: null,
            error: getErrorMessage(error)
        };
    }
}

function resolveInitAnswersState(targetRoot: string, initAnswersPath?: string): InitAnswersState {
    let resolvedPath: string;
    let resolveError: string | null = null;

    try {
        resolvedPath = resolveInitAnswersPath(targetRoot, initAnswersPath);
    } catch (error: unknown) {
        resolveError = getErrorMessage(error);
        resolvedPath = resolveInitAnswersPath(
            targetRoot,
            resolveInitAnswersRelativePathForTarget(targetRoot)
        );
    }

    const present = pathExists(resolvedPath) && fs.lstatSync(resolvedPath).isFile();
    if (!present) {
        return {
            resolvedPath,
            present: false,
            answers: null,
            error: resolveError
        };
    }

    const answersResult = readInitAnswersSafe(targetRoot, resolvedPath);
    return {
        resolvedPath,
        present: true,
        answers: answersResult.answers,
        error: resolveError || answersResult.error
    };
}

function readLiveVersionState(livePath: string): LiveVersionState {
    const liveVersionPath = path.join(livePath, 'version.json');
    if (!pathExists(liveVersionPath)) {
        return { payload: null, error: null };
    }

    try {
        return {
            payload: JSON.parse(readTextFile(liveVersionPath)) as LiveVersionPayload,
            error: null
        };
    } catch (error: unknown) {
        return {
            payload: null,
            error: getErrorMessage(error)
        };
    }
}

function resolveSourceOfTruth(
    answers: InitAnswers | null,
    liveVersion: LiveVersionPayload | null
): string | null {
    if (answers) {
        return answers.SourceOfTruth;
    }

    const liveSourceOfTruth = liveVersion && String(liveVersion.SourceOfTruth || '').trim();
    return liveSourceOfTruth ? liveSourceOfTruth : null;
}

function resolveCurrentActiveAgentFiles(
    answers: InitAnswers | null,
    canonicalEntrypoint: string | null
): string[] {
    if (answers?.ActiveAgentFiles) {
        return Array.isArray(answers.ActiveAgentFiles)
            ? answers.ActiveAgentFiles.slice()
            : String(answers.ActiveAgentFiles)
                .split(/[;,]/g)
                .map((item) => item.trim())
                .filter(Boolean);
    }
    return canonicalEntrypoint ? [canonicalEntrypoint] : [];
}

function resolveAssistantLanguageState(
    answers: InitAnswers | null,
    agentInitState: AgentInitState | null
): { assistantLanguage: string | null; assistantLanguageConfirmed: boolean | null } {
    const assistantLanguageConfirmed = agentInitState
        ? agentInitState.AssistantLanguageConfirmed
        : null;
    let assistantLanguage = answers ? answers.AssistantLanguage : null;

    if (assistantLanguageConfirmed === true && agentInitState?.AssistantLanguage) {
        assistantLanguage = agentInitState.AssistantLanguage;
    } else if (!assistantLanguage && agentInitState?.AssistantLanguage) {
        assistantLanguage = agentInitState.AssistantLanguage;
    }

    return { assistantLanguage, assistantLanguageConfirmed };
}

function resolveAgentInitializationPendingReasons(
    primaryInitializationComplete: boolean,
    agentInitStateResult: AgentInitStateResult,
    answers: InitAnswers | null,
    sourceOfTruth: string | null,
    currentActiveAgentFiles: string[],
    missingProjectCommands: string[]
): AgentInitializationPendingCheckpoint[] {
    if (!primaryInitializationComplete) {
        return [];
    }
    if (agentInitStateResult.error) {
        return ['AGENT_STATE_INVALID'];
    }
    if (!agentInitStateResult.state) {
        return ['AGENT_HANDOFF_REQUIRED'];
    }
    if (!doesAgentInitStateMatchAnswers(agentInitStateResult.state, {
        AssistantLanguage: answers && answers.AssistantLanguage,
        SourceOfTruth: sourceOfTruth,
        ActiveAgentFiles: currentActiveAgentFiles
    })) {
        return ['AGENT_STATE_STALE'];
    }
    const pendingReasons: AgentInitializationPendingCheckpoint[] = [];
    if (!agentInitStateResult.state.AssistantLanguageConfirmed) {
        pendingReasons.push('LANGUAGE_CONFIRMATION_PENDING');
    }
    if (!agentInitStateResult.state.ActiveAgentFilesConfirmed) {
        pendingReasons.push('ACTIVE_AGENT_FILES_PENDING');
    }
    if (!agentInitStateResult.state.ProjectRulesUpdated) {
        pendingReasons.push('PROJECT_RULES_PENDING');
    }
    if (!agentInitStateResult.state.SkillsPromptCompleted) {
        pendingReasons.push('SKILLS_PROMPT_PENDING');
    }
    if (!agentInitStateResult.state.OrdinaryDocPathsConfirmed) {
        pendingReasons.push('ORDINARY_DOC_PATHS_PENDING');
    }
    if (
        !agentInitStateResult.state.ProjectMemoryInitialized
        || !agentInitStateResult.state.ProjectMemoryValidated
    ) {
        pendingReasons.push('PROJECT_MEMORY_PENDING');
    }
    if (missingProjectCommands.length > 0) {
        pendingReasons.push('PROJECT_COMMANDS_PENDING');
    }
    if (!agentInitStateResult.state.VerificationPassed || !agentInitStateResult.state.ManifestValidationPassed) {
        pendingReasons.push('VALIDATION_PENDING');
    }
    return pendingReasons;
}

export function getAgentInitializationReadinessSnapshot(
    targetRoot: string,
    initAnswersPath?: string
): AgentInitializationReadinessSnapshot {
    const resolvedTargetRoot = path.resolve(targetRoot);
    const bundlePath = getBundlePath(resolvedTargetRoot);
    const bundlePresent = pathExists(bundlePath) && fs.lstatSync(bundlePath).isDirectory();
    const livePath = path.join(bundlePath, 'live');
    const taskPath = path.join(resolvedTargetRoot, TASK_QUEUE_FILENAME);
    const usagePath = path.join(livePath, 'USAGE.md');
    const commandsRulePath = getCommandsRulePath(bundlePath);
    const commandsContent = readUtf8IfExists(commandsRulePath);
    const compileGateStatus = readCompileGateCommandStatus(bundlePath);
    const missingProjectCommands = getMissingProjectCommands(commandsContent || '');
    if (bundlePresent && !compileGateStatus.configured) {
        missingProjectCommands.push('compile_gate.command');
    }

    const agentInitStateResult: AgentInitStateResult = bundlePresent
        ? readAgentInitStateSafe(
            resolvedTargetRoot,
            resolveAgentInitStateRelativePathForTarget(resolvedTargetRoot)
        )
        : {
            statePath: path.join(bundlePath, 'runtime', 'agent-init-state.json'),
            state: null,
            error: null
        };
    const initAnswersState = resolveInitAnswersState(resolvedTargetRoot, initAnswersPath);
    const liveVersionState = readLiveVersionState(livePath);
    const answers = initAnswersState.answers;
    const sourceOfTruth = resolveSourceOfTruth(answers, liveVersionState.payload);
    const canonicalEntrypoint = sourceOfTruth ? getCanonicalEntrypoint(sourceOfTruth) : null;
    const livePresent = pathExists(livePath) && fs.lstatSync(livePath).isDirectory();
    const taskPresent = pathExists(taskPath) && fs.lstatSync(taskPath).isFile();
    const usagePresent = pathExists(usagePath) && fs.lstatSync(usagePath).isFile();
    const primaryInitializationComplete = (
        bundlePresent
        && initAnswersState.present
        && !initAnswersState.error
        && livePresent
        && taskPresent
        && usagePresent
    );
    const currentActiveAgentFiles = resolveCurrentActiveAgentFiles(answers, canonicalEntrypoint);
    const agentInitializationPendingReasons = resolveAgentInitializationPendingReasons(
        primaryInitializationComplete,
        agentInitStateResult,
        answers,
        sourceOfTruth,
        currentActiveAgentFiles,
        missingProjectCommands
    );
    const agentInitializationPendingReason = agentInitializationPendingReasons[0] || null;

    return {
        bundlePath,
        primaryInitializationComplete,
        agentInitializationPendingReason,
        missingProjectCommands
    };
}

function readProviderComplianceResult(
    targetRoot: string,
    bundlePresent: boolean,
    currentActiveAgentFiles: string[],
    activeTaskId?: string
): StatusSnapshot['providerComplianceResult'] {
    if (!bundlePresent || currentActiveAgentFiles.length === 0) {
        return null;
    }

    try {
        return scanProviderCompliance(targetRoot, currentActiveAgentFiles, activeTaskId
            ? { handshakeArtifactTaskId: activeTaskId }
            : undefined);
    } catch {
        return null;
    }
}

function readProtectedManifestEvidence(
    targetRoot: string,
    bundlePresent: boolean
): StatusSnapshot['protectedManifestEvidence'] {
    if (!bundlePresent) {
        return null;
    }

    try {
        return evaluateProtectedControlPlaneManifest(targetRoot, null, true);
    } catch {
        return null;
    }
}

function readTimelineSummary(
    bundlePath: string,
    bundlePresent: boolean,
    taskStatuses: ReadonlyMap<string, string>,
    taskId?: string
): TimelineSummary {
    if (!bundlePresent) {
        return {
            taskCount: 0,
            healthy: 0,
            warnings: [],
            warningDetails: []
        };
    }
    return collectTimelineSummaryForStatus(bundlePath, {
        taskStatuses,
        taskIds: taskId === undefined ? undefined : new Set([taskId])
    });
}

function readActiveProfile(bundlePath: string, bundlePresent: boolean): string | null {
    if (!bundlePresent) {
        return null;
    }

    const profilesConfigPath = path.join(bundlePath, 'live', 'config', 'profiles.json');
    if (!pathExists(profilesConfigPath)) {
        return null;
    }

    try {
        const profilesRaw = JSON.parse(readTextFile(profilesConfigPath)) as Record<string, unknown>;
        if (typeof profilesRaw.active_profile === 'string' && profilesRaw.active_profile.trim()) {
            return profilesRaw.active_profile.trim();
        }
    } catch {
        return null;
    }

    return null;
}

function readReviewRemediationModePolicyStatus(
    bundlePath: string,
    bundlePresent: boolean,
    activeProfile: string | null
): StatusSnapshot['reviewRemediationModePolicy'] {
    if (!bundlePresent || !activeProfile) return null;
    const profilesConfigPath = path.join(bundlePath, 'live', 'config', 'profiles.json');
    try {
        const profilesRaw = JSON.parse(readTextFile(profilesConfigPath)) as Record<string, unknown>;
        const builtIn = profilesRaw.built_in_profiles && typeof profilesRaw.built_in_profiles === 'object'
            && !Array.isArray(profilesRaw.built_in_profiles)
            ? profilesRaw.built_in_profiles as Record<string, unknown>
            : {};
        const user = profilesRaw.user_profiles && typeof profilesRaw.user_profiles === 'object'
            && !Array.isArray(profilesRaw.user_profiles)
            ? profilesRaw.user_profiles as Record<string, unknown>
            : {};
        const entry = (builtIn[activeProfile] ?? user[activeProfile]) as Record<string, unknown> | undefined;
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
        const summary = summarizeReviewRemediationModePolicy(
            resolveReviewRemediationModePolicyFromProfile(entry.review_remediation_mode_policy, activeProfile)
        );
        return {
            configured: summary.configured,
            legacyFullOnly: summary.legacy_full_only,
            policyId: summary.policy_id,
            deltaEligibleReviewTypes: [...summary.delta_eligible_review_types],
            diagnostics: [...summary.diagnostics]
        };
    } catch (error: unknown) {
        return {
            configured: false,
            legacyFullOnly: true,
            policyId: null,
            deltaEligibleReviewTypes: [],
            diagnostics: [
                `Active profile remediation mode policy is invalid; resolved status fail-closed to FULL-only: ` +
                `${error instanceof Error ? error.message : String(error)}`
            ]
        };
    }
}

function readToxinMetricsSummary(
    targetRoot: string,
    bundlePath: string,
    bundlePresent: boolean,
    readOnly: boolean
): StatusSnapshot['toxinMetricsSummary'] {
    if (!bundlePresent) {
        return null;
    }

    try {
        const toxinSnapshot = collectToxinSnapshot(targetRoot, { bundleRoot: bundlePath, readOnly });
        return buildToxinStatusSummary(toxinSnapshot);
    } catch {
        return null;
    }
}

function readScopeBudgetGuardStatus(
    targetRoot: string,
    bundlePath: string,
    bundlePresent: boolean,
    taskStatuses: Map<string, string>
): StatusSnapshot['scopeBudgetGuardStatus'] {
    if (!bundlePresent) {
        return null;
    }
    try {
        return readLatestScopeBudgetStatus({
            targetRoot,
            bundleRoot: bundlePath,
            preflightPath: resolveScopeBudgetPreflightPath(bundlePath, taskStatuses)
        });
    } catch {
        return null;
    }
}

function resolveScopeBudgetPreflightPath(bundlePath: string, taskStatuses: Map<string, string>): string | null {
    for (const status of ['IN_PROGRESS', 'IN_REVIEW', 'TODO']) {
        for (const [taskId, taskStatus] of taskStatuses.entries()) {
            if (taskStatus === status) {
                return path.join(bundlePath, 'runtime', 'reviews', `${taskId}-preflight.json`);
            }
        }
    }
    return null;
}

function collectStatusSnapshot(
    targetRoot: string,
    initAnswersPath?: string,
    taskQueueEntries?: ReadonlyMap<string, TaskQueueEntry>,
    options: {
        taskId?: string;
        includeGlobalRuntimeMetrics: boolean;
        readOnly?: boolean;
    } = { includeGlobalRuntimeMetrics: true }
): StatusSnapshot {
    const resolvedTargetRoot = path.resolve(targetRoot);
    const bundlePath = getBundlePath(resolvedTargetRoot);
    const bundlePresent = pathExists(bundlePath) && fs.lstatSync(bundlePath).isDirectory();
    const taskPath = path.join(resolvedTargetRoot, TASK_QUEUE_FILENAME);
    const livePath = path.join(bundlePath, 'live');
    const usagePath = path.join(livePath, 'USAGE.md');
    const commandsRulePath = getCommandsRulePath(bundlePath);
    const commandsContent = readUtf8IfExists(commandsRulePath);
    const compileGateStatus = readCompileGateCommandStatus(bundlePath);
    const missingProjectCommands = getMissingProjectCommands(commandsContent || '');
    if (bundlePresent && !compileGateStatus.configured) {
        missingProjectCommands.push('compile_gate.command');
    }
    const agentInitStateResult: AgentInitStateResult = bundlePresent
        ? readAgentInitStateSafe(
            resolvedTargetRoot,
            resolveAgentInitStateRelativePathForTarget(resolvedTargetRoot)
        )
        : {
            statePath: path.join(bundlePath, 'runtime', 'agent-init-state.json'),
            state: null,
            error: null
        };
    const initAnswersState = resolveInitAnswersState(resolvedTargetRoot, initAnswersPath);
    const liveVersionState = readLiveVersionState(livePath);
    const answers = initAnswersState.answers;
    const collectedVia = answers ? answers.CollectedVia || null : null;
    const sourceOfTruth = resolveSourceOfTruth(answers, liveVersionState.payload);
    const canonicalEntrypoint = sourceOfTruth ? getCanonicalEntrypoint(sourceOfTruth) : null;
    const livePresent = pathExists(livePath) && fs.lstatSync(livePath).isDirectory();
    const taskPresent = pathExists(taskPath) && fs.lstatSync(taskPath).isFile();
    const usagePresent = pathExists(usagePath) && fs.lstatSync(usagePath).isFile();
    const primaryInitializationComplete = (
        bundlePresent
        && initAnswersState.present
        && !initAnswersState.error
        && livePresent
        && taskPresent
        && usagePresent
    );
    const parityResult = detectSourceBundleParity(resolvedTargetRoot);
    const currentActiveAgentFiles = resolveCurrentActiveAgentFiles(answers, canonicalEntrypoint);
    const { assistantLanguage, assistantLanguageConfirmed } = resolveAssistantLanguageState(
        answers,
        agentInitStateResult.state
    );
    const agentInitializationPendingReasons = resolveAgentInitializationPendingReasons(
        primaryInitializationComplete,
        agentInitStateResult,
        answers,
        sourceOfTruth,
        currentActiveAgentFiles,
        missingProjectCommands
    );
    const agentInitializationPendingReason = agentInitializationPendingReasons[0] || null;
    const providerComplianceResult = readProviderComplianceResult(
        resolvedTargetRoot,
        bundlePresent,
        currentActiveAgentFiles,
        options.taskId
    );
    const protectedManifestEvidence = readProtectedManifestEvidence(resolvedTargetRoot, bundlePresent);
    const protectedManifestAssessment = assessProtectedManifest({
        evidence: protectedManifestEvidence,
        parityResult,
        allowSourceCheckoutInfo: true
    });
    const agentInitializationComplete = primaryInitializationComplete && agentInitializationPendingReason === null;
    const compliancePassed = providerComplianceResult === null || providerComplianceResult.passed;
    const protectedManifestOk = protectedManifestAssessment === null || !protectedManifestAssessment.blocks;
    const readyForTasks = agentInitializationComplete && !parityResult.isStale && compliancePassed && protectedManifestOk;
    const recommendedNextCommand = buildRecommendedNextCommand({
        readyForTasks,
        bundlePath,
        parityResult,
        protectedManifestAssessment,
        primaryInitializationComplete,
        agentInitializationPendingReason,
        bundlePresent,
        initAnswersPresent: initAnswersState.present,
        initAnswersError: initAnswersState.error,
        resolvedTargetRoot,
        initAnswersPath
    });
    const activeAgentFilesValue = currentActiveAgentFiles.length > 0
        ? currentActiveAgentFiles.join(', ')
        : null;
    const taskStatuses = taskQueueEntries
        ? buildTaskQueueStatusMap(taskQueueEntries)
        : readTaskQueueStatusMap(taskPath, taskPresent);
    const timelineSummary = readTimelineSummary(bundlePath, bundlePresent, taskStatuses, options.taskId);
    const activeProfile = readActiveProfile(bundlePath, bundlePresent);
    const reviewRemediationModePolicy = readReviewRemediationModePolicyStatus(
        bundlePath,
        bundlePresent,
        activeProfile
    );
    const toxinMetricsSummary = options.includeGlobalRuntimeMetrics
        ? readToxinMetricsSummary(resolvedTargetRoot, bundlePath, bundlePresent, options.readOnly === true)
        : null;
    const scopeBudgetGuardStatus = options.includeGlobalRuntimeMetrics
        ? readScopeBudgetGuardStatus(resolvedTargetRoot, bundlePath, bundlePresent, taskStatuses)
        : null;
    const mandatoryFullSuiteConfig = bundlePresent
        ? readMandatoryFullSuiteConfig(bundlePath)
        : { enabled: null, command: null, performance: null };
    const latestUpdateNotice = bundlePresent ? readLatestUpdateNotice(bundlePath) : null;

    let enforceNoAutoCommit: boolean | null = null;
    if (liveVersionState.payload && typeof liveVersionState.payload.EnforceNoAutoCommit === 'boolean') {
        enforceNoAutoCommit = liveVersionState.payload.EnforceNoAutoCommit;
    } else if (answers && typeof answers.EnforceNoAutoCommit === 'boolean') {
        enforceNoAutoCommit = answers.EnforceNoAutoCommit;
    }

    return {
        targetRoot: resolvedTargetRoot,
        enforceNoAutoCommit,
        bundlePath,
        initAnswersResolvedPath: initAnswersState.resolvedPath,
        initAnswersPathForDisplay: initAnswersPath || resolveInitAnswersRelativePathForTarget(resolvedTargetRoot),
        bundlePresent,
        initAnswersPresent: initAnswersState.present,
        initAnswersError: initAnswersState.error,
        taskPresent,
        livePresent,
        usagePresent,
        commandsRulePath,
        missingProjectCommands,
        assistantLanguage,
        assistantLanguageConfirmed,
        sourceOfTruth,
        canonicalEntrypoint,
        collectedVia,
        agentInitStatePath: agentInitStateResult.statePath,
        agentInitStateError: agentInitStateResult.error,
        agentInitState: agentInitStateResult.state,
        agentInitializationPendingReasons,
        activeAgentFiles: activeAgentFilesValue,
        liveVersionError: liveVersionState.error,
        primaryInitializationComplete,
        agentInitializationPendingReason,
        agentInitializationComplete,
        readyForTasks,
        recommendedUiCommand: RECOMMENDED_UI_ACTIONS_COMMAND,
        recommendedNextCommand,
        activeProfile,
        reviewRemediationModePolicy,
        timelineTaskCount: timelineSummary.taskCount,
        timelineHealthy: timelineSummary.healthy,
        timelineWarnings: timelineSummary.warnings,
        timelineWarningDetails: timelineSummary.warningDetails,
        parityResult,
        providerComplianceResult,
        protectedManifestEvidence,
        protectedManifestAssessment,
        toxinMetricsSummary,
        scopeBudgetGuardStatus,
        mandatoryFullSuiteEnabled: mandatoryFullSuiteConfig.enabled,
        mandatoryFullSuiteCommand: mandatoryFullSuiteConfig.command,
        mandatoryFullSuitePerformance: mandatoryFullSuiteConfig.performance,
        latestUpdateNotice
    };
}

export function getStatusSnapshot(
    targetRoot: string,
    initAnswersPath?: string,
    taskQueueEntries?: ReadonlyMap<string, TaskQueueEntry>,
    options: { readOnly?: boolean } = {}
): StatusSnapshot {
    return collectStatusSnapshot(targetRoot, initAnswersPath, taskQueueEntries, {
        includeGlobalRuntimeMetrics: true,
        readOnly: options.readOnly
    });
}

export function getTaskCycleStatusSnapshot(
    targetRoot: string,
    taskId: string,
    initAnswersPath?: string,
    taskQueueEntries?: ReadonlyMap<string, TaskQueueEntry>
): TaskCycleStatusSnapshot {
    const snapshot = collectStatusSnapshot(targetRoot, initAnswersPath, taskQueueEntries, {
        taskId,
        includeGlobalRuntimeMetrics: false
    });
    return {
        enforceNoAutoCommit: snapshot.enforceNoAutoCommit,
        assistantLanguage: snapshot.assistantLanguage,
        assistantLanguageConfirmed: snapshot.assistantLanguageConfirmed,
        readyForTasks: snapshot.readyForTasks,
        recommendedNextCommand: snapshot.recommendedNextCommand,
        latestUpdateNotice: snapshot.latestUpdateNotice,
        timelineWarningDetails: snapshot.timelineWarningDetails || []
    };
}
