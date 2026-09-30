import {
    loadImportedUiLanguagePacks,
    type ImportedUiLanguagePack,
    type LocalUiLocalizedText,
    type UiLanguagePackDescriptor
} from './ui-language-pack-loader';
import { buildBackupsTabTextCatalog } from './backups-tab-text/catalog';
import { loadBackupsTabTextTranslations } from './backups-tab-text/load-translations';
import { buildCleanupSettingTextCatalog } from './cleanup-setting-text/catalog';
import { loadCleanupSettingTextTranslations } from './cleanup-setting-text/load-translations';
import { buildInitSettingTextCatalog } from './init-setting-text/catalog';
import { loadInitSettingTextTranslations } from './init-setting-text/load-translations';
import { buildProjectMemoryStatusTextCatalog } from './project-memory-status-text/catalog';
import { loadProjectMemoryStatusTextTranslations } from './project-memory-status-text/load-translations';
import { buildWorkflowSettingTextCatalog } from './workflow-setting-text/catalog';
import { loadWorkflowSettingTextTranslations } from './workflow-setting-text/load-translations';

export type { LocalUiLocalizedText };

export const DEFAULT_LOCAL_UI_LANGUAGE = 'en';

const CORE_LOCAL_UI_LANGUAGES = Object.freeze([
    { id: 'en', label: 'English', nativeLabel: 'English' }
] as const satisfies readonly UiLanguagePackDescriptor[]);

export type LocalUiLanguage = typeof CORE_LOCAL_UI_LANGUAGES[number]['id'] | string;

const ENGLISH_LOCAL_UI_TEXT = Object.freeze({
    appTitle: 'Garda UI',
    loadingWorkspaceReport: 'Loading workspace report...',
    tasksTab: 'Tasks',
    qualityGateTab: 'Quality Gate',
    profilesTab: 'Profiles',
    workflowTab: 'Workflow Config',
    initSettingsTab: 'Init settings',
    projectMemoryTab: 'Project memory',
    backupsTab: 'Backups',
    instructionsTab: 'Instructions',
    cleanupSettingsTab: 'Cleanup settings',
    actionsTab: 'System state',
    noticeActionsEnabled: 'Task details are loaded on demand from the local server. The server is bound to 127.0.0.1 and stops when this CLI process exits.',
    noticeActionsDisabled: 'Task details are loaded on demand from the local server. The server is bound to 127.0.0.1 and stops when this CLI process exits.',
    languageTitle: 'Language',
    languageHelp: 'UI language is local to this browser page. Commands, task IDs, config keys, enum values, file paths, and raw outputs stay unchanged.',
    themeTitle: 'Theme',
    themeSystem: 'Match system',
    themeLight: 'Light',
    themeDark: 'Dark',
    serverStatusTitle: 'Server Status',
    loadingServerSession: 'Loading server session...',
    iAmHere: "I'm here",
    stopServer: 'Stop server',
    serverStoppedRerun: 'When this server stops, the page cannot relaunch it. Rerun',
    serverStoppedRerunTail: 'in a terminal.',
    gardaSwitchTitle: 'Garda switch',
    gardaSwitchState: 'State',
    gardaSwitchStateOn: 'On',
    gardaSwitchStateOff: 'Off',
    gardaSwitchStateUnknown: 'Unknown',
    gardaSwitchHelp: 'Turns root Garda instruction surfaces on or off for this workspace.',
    gardaSwitchActionsDisabled: 'Start with controlled actions to switch from this page:',
    gardaSwitchUnknownHelp: 'The switch state is unknown; choose the intended command after checking the workspace.',
    gardaSwitchUnavailable: 'Switch action is hidden until the current Garda state is known.',
    turnGardaOn: 'Turn on',
    turnGardaOff: 'Turn off',
    searchTasks: 'Search tasks',
    allStatuses: 'All statuses',
    allPriorities: 'All priorities',
    idColumn: 'ID',
    statusColumn: 'Status',
    priorityColumn: 'Priority',
    areaColumn: 'Area',
    titleColumn: 'Title',
    actionColumn: 'Action',
    dataColumn: 'Data',
    loading: 'Loading...',
    taskDetailTitle: 'Task Detail',
    chooseTask: 'Choose a task and click Load details.',
    dataCompact: 'Compact',
    dataFull: 'Full',
    dataOnDemand: 'On demand',
    dataBlockers: 'Blockers',
    compactDetailState: 'Closed task shown from the queue row; load details to inspect archived artifacts.',
    onDemandDetailState: 'Open task shown from TASK.md; load details when you need runtime events or artifacts.',
    fullDetailState: 'Full task artifacts loaded from the local server.',
    blockerDetailState: 'TASK.md marks this task as blocked.',
    runtimeDiagnosticsTitle: 'Runtime diagnostics',
    noRuntimeDiagnostics: 'No runtime diagnostics reported.',
    taskActionsTitle: 'Task commands',
    taskActionsHelp: 'Task-specific commands are shown here; workspace maintenance commands live in their domain tabs.',
    taskCommandNextStep: 'Next lifecycle step',
    taskCommandStats: 'Task stats',
    taskCommandEvents: 'Task events',
    taskCommandReset: 'Reset task',
    taskCommandDiscard: 'Close without execution',
    taskCommandEnableReset: 'Enable audited task reset',
    taskCommandNextStepDescription: 'Asks Garda for the next required lifecycle step for this task. It can advance workflow state and requires confirmation.',
    taskCommandResetDescription: 'Reopens this task through the guarded task-reset gate. If needed, the local UI prepares audited task-reset readiness for this confirmed action and restores the previous disabled setting.',
    taskCommandDiscardDescription: 'Closes this task as DONE through the guarded task-reset gate after clearing runtime artifacts. If needed, the local UI prepares audited task-reset readiness for this confirmed action and restores the previous disabled setting.',
    taskCommandEnableResetDescription: 'Enables task reset through audited workflow set before reset or close-without-execution actions can run.',
    taskCommandEnableResetAuditDescription: 'Repairs missing workflow-set audit evidence for task_reset.enabled=true.',
    taskCommandStatsDescription: 'Shows focused counters and runtime summary for this task.',
    taskCommandEventsDescription: 'Shows the task event timeline used by gate summaries.',
    taskCommandPreviewHelp: 'Running next-step requires confirmation.',
    taskCommandUnavailable: 'Start with `garda ui --actions` to run task commands from this page.',
    taskResetUnavailable: 'Task reset is disabled. Enable workflow setting task_reset.enabled before running a confirmed reset.',
    taskResetAuditUnavailable: 'TASK_RESET_DISABLED: task_reset.enabled is true, but audited workflow-set evidence is missing.',
    taskResetAlreadyReady: 'Audited task reset is already ready.',
    taskResetReady: 'Audited reset ready',
    taskResetNotReady: 'Audited reset not ready',
    taskResetRemediation: 'Remediation:',
    showTaskPlan: 'Show plan',
    taskPlanTitle: 'Task plan',
    planPath: 'Plan path',
    planMetadataOnly: 'Plan metadata exists, but the markdown plan file is not available.',
    close: 'Close',
    taskQueueStatus: 'Queue status',
    overviewTasks: 'Tasks',
    overviewActive: 'Active',
    overviewDone: 'Done',
    overviewBlocked: 'Blocked',
    overviewWarnings: 'Warnings',
    metaRepo: 'Repo',
    metaTasks: 'Tasks',
    metaWarnings: 'Warnings',
    warningsTitle: 'Warnings',
    noMatchingTasks: 'No matching tasks.',
    loadDetails: 'Load details',
    addProfile: 'Add profile',
    profileName: 'Profile name',
    profileCopyFrom: 'Copy from',
    profileDepth: 'Depth',
    profileTaskDecomposition: 'Guarded task decomposition',
    profileTaskDecompositionSource: 'Effective source',
    profilePolicyRequired: 'Required',
    profilePolicyAuto: 'By trigger',
    profilePolicyDisabled: 'Disabled',
    profileSetActive: 'Set active',
    profileReset: 'Reset defaults',
    profileDelete: 'Delete',
    profileSourceBuiltIn: 'Built-in',
    profileSourceUser: 'User',
    profileUserProfiles: 'User profiles',
    profileBuiltInProfiles: 'Built-in profiles',
    profileNoUserProfiles: 'No user profiles yet.',
    profileNoBuiltInProfiles: 'No built-in profiles available.',
    profileEditsDisabled: 'Profile edits are disabled. Restart with',
    profileFindingDispositionTitle: 'Finding disposition',
    profileFindingDispositionHelp: 'Choose how review findings are handled. Critical findings must always be fixed now. Changes affect future tasks only; active task snapshots stay unchanged.',
    profileFindingCopyPolicy: 'Copy policy',
    profileFindingResetPolicy: 'Reset policy',
    profileFindingPolicyPreset: 'Policy preset',
    profileFindingActionFixNow: 'Fix now',
    profileFindingActionCreateFollowUp: 'Create follow-up task',
    profileFindingActionIgnore: 'Accept without follow-up',
    profileFindingActionIgnoreHelp: 'The finding is recorded, but it does not block the task or create a follow-up task.',
    profileFindingPresetSoft: 'Lenient',
    profileFindingPresetBalanced: 'Balanced',
    profileFindingPresetStrict: 'Strict',
    profileFindingPresetCustom: 'Custom',
    profileFindingCritical: 'Critical',
    profileFindingHigh: 'High',
    profileFindingMedium: 'Medium',
    profileFindingLow: 'Low',
    profileFindingResidualRisk: 'Residual risk',
    profileFollowUpTaskProfileTitle: 'Follow-up task profile',
    profileFollowUpTaskProfileHelp: 'Choose the profile for generated F tasks. One level lighter uses strict → balanced → fast; fast stays fast. Custom and docs-only profiles safely inherit the parent.',
    profileFollowUpTaskProfileMode: 'Selection mode',
    profileFollowUpTaskProfileOneLevelLighter: 'One level lighter',
    profileFollowUpTaskProfileInheritParent: 'Same as parent',
    profileFollowUpTaskProfileFixed: 'Fixed profile',
    profileFollowUpTaskProfileFixedProfile: 'Profile to use',
    noWorkflowSettings: 'No workflow settings available.',
    initBlockTitle: 'Init',
    agentInitBlockTitle: 'Agent init',
    initCommandsTitle: 'Init commands',
    initStatusPresent: 'Loaded',
    initStatusMissing: 'File missing',
    initStatusInvalid: 'File invalid',
    fieldColumn: 'Field',
    valueColumn: 'Value',
    noInitSettings: 'No settings available.',
    projectMemoryStatusTitle: 'Project memory status',
    projectMemoryFilesTitle: 'Project memory files',
    projectMemoryOptimizationTitle: 'Project memory optimization',
    projectMemoryOptimizationBody: 'Occasionally assign an agent to optimize project-memory files. Choose a deep-reasoning agent and give it this prompt.',
    projectMemoryOptimizationPromptFile: 'Prompt file',
    ordinaryDocsTitle: 'Ordinary documents',
    ordinaryDocsHelp: 'Ordinary documents are user-owned planning, changelog, or product docs. Changes to these paths remain auditable but do not trigger extra review lanes by themselves.',
    ordinaryDocsPath: 'Document path',
    ordinaryDocsEmpty: 'No ordinary document paths configured.',
    ordinaryDocsActionsDisabled: 'Ordinary document edits are disabled. Restart with',
    addOrdinaryDoc: 'Add document',
    removeOrdinaryDoc: 'Remove',
    addOptionalCheckRule: 'Add rule',
    saveOptionalCheckRule: 'Save rule',
    removeOptionalCheckRule: 'Remove rule',
    qualityGateRuleSet: 'Quality rules',
    qualityGateBaselineVersion: 'Installed rule pack',
    qualityGateShippedBaselineVersion: 'Shipped rule pack',
    qualityGateBaselineRules: 'Baseline rules',
    qualityGateCustomRules: 'Custom rules',
    qualityGateDeletedBaselineRules: 'Deleted baseline rules',
    qualityBaselineHealth: 'Installed quality rules',
    qualityBaselineInstalled: 'Installed rule pack',
    qualityBaselineShipped: 'Shipped rule pack',
    qualityBaselineRulePackRules: 'Shipped rules',
    qualityBaselineMissingRules: 'Missing shipped rules',
    qualityGateSourceColumn: 'Source',
    qualityGateSourceBaseline: 'Baseline',
    qualityGateSourceCustom: 'Custom',
    qualityGateStatusActive: 'Active',
    qualityGateStatusDisabled: 'Disabled',
    qualityGateStatusLocallyEdited: 'Edited locally',
    qualityGateStatusDeleted: 'Deleted',
    qualityGateRulesEmpty: 'No quality rules available.',
    qualityGateNewRule: 'New rule',
    qualityGateLatestCheck: 'Latest check',
    qualityGateEvidenceState: 'Evidence',
    qualityGateEvidenceCurrent: 'Current',
    qualityGateEvidenceStale: 'Stale',
    qualityGateEvidenceMissing: 'Missing',
    qualityGateEvidenceInvalid: 'Invalid',
    qualityGateEffect: 'Effect',
    qualityGateEffectPassed: 'Passed',
    qualityGateEffectSkippedCadence: 'Skipped — not due yet',
    qualityGateEffectHelped: 'Helped',
    qualityGateEffectWarned: 'Warned',
    qualityGateEffectRequiredRework: 'Required rework',
    qualityGateEffectDisabled: 'Disabled',
    qualityGateEffectMissing: 'Not checked',
    qualityGateEffectInvalid: 'Invalid',
    qualityGateEffectStale: 'Stale',
    qualityGateActionRequiredHistory: 'Action-required history',
    qualityGateNoActionRequiredHistory: 'No recent action-required records.',
    qualityGateActionsRequired: 'Actions required',
    qualityGateActionsTaken: 'Actions taken',
    qualityGateChangedFiles: 'Changed files',
    qualityGateAnswers: 'Rule answers',
    qualityGateTimelineEvents: 'Timeline events',
    fileColumn: 'File',
    purposeColumn: 'Purpose',
    sizeColumn: 'Size',
    openColumn: 'Open',
    openMemoryFile: 'Open',
    noProjectMemoryFiles: 'No project memory files available.',
    workflowConfigPath: 'Config file',
    workflowStatus: 'Config state',
    workflowStatusPresent: 'Config loaded. Warnings are shown here only when the file cannot be read or parsed.',
    workflowStatusMissing: 'File missing; defaults shown',
    workflowStatusInvalid: 'File invalid; defaults shown',
    workflowWarningTitle: 'Config problem',
    workflowCommandPreview: 'Action status',
    workflowCommandPreviewHelp: 'Action results and audit paths appear here after execution.',
    actionsPreviewHelp: 'Action results and audit paths appear here after execution.',
    resultStatusPreviewed: 'Dry-run only',
    resultStatusExecuted: 'Applied',
    resultStatusConfirmationRequired: 'Confirmation required',
    resultStatusDisabled: 'Disabled',
    resultStatusUnavailable: 'Unavailable',
    workflowGroupValidation: 'Validation and test lifecycle',
    workflowGroupReview: 'Review order and limits',
    workflowGroupScope: 'Scope limits',
    workflowGroupMemory: 'Project memory',
    workflowGroupSafety: 'Protected controls',
    configSettingColumn: 'Setting',
    descriptionColumn: 'Description',
    currentValueColumn: 'Current value',
    optionsColumn: 'Options',
    changeColumn: 'Change',
    availableReviewTypes: 'Available review types',
    noFixedOptions: 'No fixed options',
    freeValueHelp: 'Enter a value that matches the description.',
    reviewCycleAutoSplitDependency: 'Auto-split only affects blocking mode: review_cycle_guard.action must be BLOCK_FOR_OPERATOR_DECISION. When the action is WARN_ONLY, this setting is informational.',
    minutesLabel: 'Minutes',
    secondsLabel: 'Seconds',
    durationStoredAsMs: 'Saved as milliseconds for Garda.',
    commandColumn: 'Command',
    actionEffectColumn: 'Effect',
    actionRunColumn: 'Run',
    instructionAreaColumn: 'Area',
    instructionDescriptionColumn: 'Description',
    guardedEditor: 'Guarded editor',
    guardedEditorHelp: 'Changes use audited `garda workflow set` commands. Save requires confirmation.',
    settingEditsDisabled: 'Setting edits are disabled. Restart with',
    settingEditsDisabledTail: 'to enable audited workflow commands.',
    noEditableSettings: 'No editable safe settings available.',
    current: 'Current',
    newValue: 'New value',
    parameter: 'Parameter',
    availableOptions: 'Options',
    noOptions: 'No fixed options; enter a value that matches the field description.',
    save: 'Save',
    saveDisabled: 'Save disabled',
    settingReadonly: 'Read-only from this page',
    preview: 'Dry-run',
    previewCommand: 'Dry-run',
    apply: 'Apply',
    typeToApplySetting: 'Type',
    typeToApplySettingTail: 'to apply this setting:',
    setting: 'Setting',
    changedKey: 'Changed key',
    proposed: 'Proposed',
    command: 'Command',
    audit: 'Action log',
    noInstructions: 'No instructions available.',
    noArtifacts: 'No artifacts listed.',
    missing: 'missing',
    idleShutdownDisabled: 'idle shutdown disabled.',
    stopWithCtrlC: 'Stop with Ctrl+C in the terminal.',
    shutdownIn: 'Shutdown in',
    warningIn: 'Warning in',
    idleWarning: 'Idle warning',
    stopping: 'Stopping',
    active: 'Active',
    idleThreshold: 'Idle threshold',
    lastActivity: 'Last activity',
    shutdownInPrefix: 'Shutdown in',
    shutdownInSuffix: 'seconds. Move, type, click, or press',
    shutdownInTail: 'to keep it running.',
    warningStartsInPrefix: 'Warning starts in',
    warningStartsInSuffix: 'seconds.',
    serverUnavailable: 'The local server is unavailable. Rerun',
    serverUnavailableTail: 'from a terminal.',
    actionsDisabled: 'Actions are disabled. Restart with',
    actionsDisabledTail: 'to expose allow-listed commands.',
    actionsIntro: 'Workspace actions are fixed Garda commands. Task-specific commands live in each task detail panel; backup restore commands live in the Backups tab.',
    actionsTaskMoved: 'Open a task on the Tasks tab for next-step, stats, and events commands.',
    mutatingAction: 'Writes workspace or runtime data.',
    htmlReportMutation: 'Creates or updates an HTML report under runtime reports.',
    cleanupMutation: 'Deletes or compresses runtime artifacts according to the retention policy.',
    gardaSwitchMutation: 'Moves managed root instruction files between active and inactive switch storage.',
    safeAction: 'Read-only or dry-run command.',
    action: 'Action',
    run: 'Run',
    actionUnavailable: 'Unavailable',
    typeToRunAction: 'Type',
    typeToRunActionTail: 'to run this action:',
    noReviewAttempts: 'No review attempts recorded.',
    loadingTaskPrefix: 'Loading',
    unableToLoadDetails: 'Unable to load details: HTTP',
    events: 'Events',
    gatePass: 'Gate Pass',
    gateFail: 'Gate Fail',
    fullSuiteState: 'Full-suite state',
    fullSuiteDuration: 'Full-suite duration',
    fullSuiteTitle: 'Full-suite validation',
    fullSuiteCommand: 'Command',
    fullSuitePlacement: 'Placement',
    fullSuiteFreshness: 'Freshness',
    fullSuiteTimeoutBlocker: 'Timeout blocks task',
    fullSuiteTimeoutRetryCount: 'Timeout retry count',
    fullSuiteTimeoutMaxAttempts: 'Timeout max attempts',
    fullSuiteTimeoutAttempts: 'Timeout attempts',
    fullSuiteTimeoutAttemptsExhausted: 'Timeout attempts exhausted',
    fullSuiteTimeoutWarningContinuation: 'Warning-only timeout continuation',
    fullSuiteTimeoutRepairTask: 'Timeout repair task proposal',
    fullSuiteTimeoutAttemptTimedOut: 'timed out',
    fullSuiteTimeoutAttemptCancelled: 'cancelled',
    fullSuiteTimeoutAttemptExitCode: 'exit code',
    fullSuiteTimeoutForecast: 'Timeout forecast',
    fullSuiteTimeoutForecastRecommendedPrefix: 'Recommended full-suite command timeout:',
    fullSuiteTimeoutForecastRecentRuns: 'target sample',
    fullSuiteTimeoutForecastRunsAverage: 'run(s) avg',
    fullSuiteTimeoutForecastMaximum: 'max',
    fullSuiteTimeoutForecastSafetyMargin: 'safety margin over max',
    fullSuiteTimeoutForecastMinimum: '20% but at least 30s',
    fullSuiteTimeoutForecastConfiguredReason: 'no recent matching full-suite duration history; using configured timeout',
    fullSuiteForecastExcludedSamples: 'Forecast excluded samples',
    fullSuiteForecastExclusionReasons: 'Forecast exclusion reasons',
    fullSuiteForecastExclusionTimedOut: 'timed-out runs',
    fullSuiteForecastExclusionInterruptedOrCancelled: 'interrupted or cancelled runs',
    fullSuiteForecastExclusionRetryContaminated: 'retry-contaminated runs',
    fullSuiteForecastExclusionNonPassingStatus: 'non-passing runs',
    fullSuiteForecastExclusionNonzeroExit: 'non-zero exit runs',
    fullSuiteForecastExclusionInvalidDuration: 'invalid durations',
    fullSuiteForecastExclusionOutlierDuration: 'outlier durations',
    fullSuiteConfiguredTimeout: 'Configured timeout',
    fullSuiteAverageDuration: 'Average duration',
    fullSuiteHighWatermarkDuration: 'High-watermark duration',
    fullSuiteRecommendedTimeout: 'Recommended timeout',
    fullSuiteArtifact: 'Evidence artifact',
    fullSuiteOutput: 'Output artifact',
    fullSuiteSummary: 'Summary',
    changedLines: 'Changed Lines',
    gateTimeline: 'Gate Timeline',
    gateTimelineHelp: 'This is the latest runtime cycle summary; the queue status above remains the TASK.md status.',
    blockers: 'Blockers',
    noBlockers: 'No blockers reported.',
    reviews: 'Reviews',
    artifacts: 'Artifacts',
    existingArtifacts: 'Existing artifacts',
    missingArtifacts: 'Missing artifacts',
    artifactPath: 'Artifact path'
} as const);

export type LocalUiTextKey = keyof typeof ENGLISH_LOCAL_UI_TEXT;

export interface LocalUiTextValidationIssue {
    languageId: string;
    key: string;
    reason: string;
}

const LOCAL_UI_TEXT_ENGLISH_MATCH_EXEMPT_KEYS = new Set<LocalUiTextKey>([
    'appTitle',
    'idColumn'
]);

function shouldAllowEnglishMatchForLocalUiText(key: LocalUiTextKey): boolean {
    return LOCAL_UI_TEXT_ENGLISH_MATCH_EXEMPT_KEYS.has(key);
}

const IMPORTED_UI_LANGUAGE_PACKS: readonly ImportedUiLanguagePack[] = loadImportedUiLanguagePacks(
    Object.keys(ENGLISH_LOCAL_UI_TEXT)
);

export const LOCAL_UI_LANGUAGES: readonly UiLanguagePackDescriptor[] = Object.freeze([
    ...CORE_LOCAL_UI_LANGUAGES,
    ...IMPORTED_UI_LANGUAGE_PACKS.map((pack) => pack.language)
]);

function buildImportedLanguageMap<T>(
    core: Readonly<Record<string, T>>,
    selector: (pack: ImportedUiLanguagePack) => T
): Readonly<Record<string, T>> {
    const merged: Record<string, T> = { ...core };
    for (const pack of IMPORTED_UI_LANGUAGE_PACKS) {
        merged[pack.language.id] = selector(pack);
    }
    return Object.freeze(merged);
}

const EMPTY_LOCALIZED_TEXT_MAP = Object.freeze({});

const WORKFLOW_SETTING_TEXT_CATALOG = buildWorkflowSettingTextCatalog();
const WORKFLOW_SETTING_TEXT_TRANSLATIONS = loadWorkflowSettingTextTranslations();

function buildWorkflowSettingTextMap(): Readonly<Record<string, Readonly<Record<string, LocalUiLocalizedText>>>> {
    const merged: Record<string, Record<string, LocalUiLocalizedText>> = {
        en: WORKFLOW_SETTING_TEXT_CATALOG
    };

    for (const [languageId, pack] of Object.entries(WORKFLOW_SETTING_TEXT_TRANSLATIONS)) {
        merged[languageId] = pack;
    }

    for (const pack of IMPORTED_UI_LANGUAGE_PACKS) {
        const legacy = pack.LOCAL_UI_SETTING_TEXT;
        if (Object.keys(legacy).length === 0) {
            continue;
        }
        merged[pack.language.id] = {
            ...(merged[pack.language.id] || {}),
            ...legacy
        };
    }

    return Object.freeze(
        Object.fromEntries(
            Object.entries(merged).map(([languageId, pack]) => [languageId, Object.freeze(pack)])
        )
    );
}

export const LOCAL_UI_SETTING_TEXT: Readonly<Record<string, Readonly<Record<string, LocalUiLocalizedText>>>> =
    buildWorkflowSettingTextMap();

const INIT_SETTING_TEXT_CATALOG = buildInitSettingTextCatalog();
const INIT_SETTING_TEXT_TRANSLATIONS = loadInitSettingTextTranslations();

function buildInitSettingTextMap(): Readonly<Record<string, Readonly<Record<string, LocalUiLocalizedText>>>> {
    const merged: Record<string, Record<string, LocalUiLocalizedText>> = {
        en: INIT_SETTING_TEXT_CATALOG
    };

    for (const [languageId, pack] of Object.entries(INIT_SETTING_TEXT_TRANSLATIONS)) {
        merged[languageId] = pack;
    }

    for (const pack of IMPORTED_UI_LANGUAGE_PACKS) {
        const legacy = pack.LOCAL_UI_INIT_SETTING_TEXT;
        if (Object.keys(legacy).length === 0) {
            continue;
        }
        merged[pack.language.id] = {
            ...(merged[pack.language.id] || {}),
            ...legacy
        };
    }

    return Object.freeze(
        Object.fromEntries(
            Object.entries(merged).map(([languageId, entries]) => [languageId, Object.freeze(entries)])
        )
    );
}

export const LOCAL_UI_INIT_SETTING_TEXT: Readonly<Record<string, Readonly<Record<string, LocalUiLocalizedText>>>> =
    buildInitSettingTextMap();

const PROJECT_MEMORY_STATUS_TEXT_CATALOG = buildProjectMemoryStatusTextCatalog();
const PROJECT_MEMORY_STATUS_TEXT_TRANSLATIONS = loadProjectMemoryStatusTextTranslations();

function buildProjectMemoryStatusTextMap(): Readonly<Record<string, Readonly<Record<string, LocalUiLocalizedText>>>> {
    const merged: Record<string, Record<string, LocalUiLocalizedText>> = {
        en: PROJECT_MEMORY_STATUS_TEXT_CATALOG
    };

    for (const [languageId, pack] of Object.entries(PROJECT_MEMORY_STATUS_TEXT_TRANSLATIONS)) {
        merged[languageId] = pack;
    }

    return Object.freeze(
        Object.fromEntries(
            Object.entries(merged).map(([languageId, entries]) => [languageId, Object.freeze(entries)])
        )
    );
}

export const LOCAL_UI_PROJECT_MEMORY_STATUS_TEXT: Readonly<Record<string, Readonly<Record<string, LocalUiLocalizedText>>>> =
    buildProjectMemoryStatusTextMap();

const CLEANUP_SETTING_TEXT_CATALOG = buildCleanupSettingTextCatalog();
const CLEANUP_SETTING_TEXT_TRANSLATIONS = loadCleanupSettingTextTranslations();

function buildCleanupSettingTextMap(): Readonly<Record<string, Readonly<Record<string, LocalUiLocalizedText>>>> {
    const merged: Record<string, Record<string, LocalUiLocalizedText>> = {
        en: CLEANUP_SETTING_TEXT_CATALOG
    };

    for (const [languageId, pack] of Object.entries(CLEANUP_SETTING_TEXT_TRANSLATIONS)) {
        merged[languageId] = pack;
    }

    return Object.freeze(
        Object.fromEntries(
            Object.entries(merged).map(([languageId, entries]) => [languageId, Object.freeze(entries)])
        )
    );
}

export const LOCAL_UI_CLEANUP_SETTING_TEXT: Readonly<Record<string, Readonly<Record<string, LocalUiLocalizedText>>>> =
    buildCleanupSettingTextMap();

const BACKUPS_TAB_TEXT_CATALOG = buildBackupsTabTextCatalog();
const BACKUPS_TAB_TEXT_TRANSLATIONS = loadBackupsTabTextTranslations();

function buildBackupsTabTextMap(): Readonly<Record<string, Readonly<Record<string, LocalUiLocalizedText>>>> {
    const merged: Record<string, Record<string, LocalUiLocalizedText>> = {
        en: BACKUPS_TAB_TEXT_CATALOG
    };

    for (const [languageId, pack] of Object.entries(BACKUPS_TAB_TEXT_TRANSLATIONS)) {
        merged[languageId] = pack;
    }

    return Object.freeze(
        Object.fromEntries(
            Object.entries(merged).map(([languageId, entries]) => [languageId, Object.freeze(entries)])
        )
    );
}

export const LOCAL_UI_BACKUPS_TAB_TEXT: Readonly<Record<string, Readonly<Record<string, LocalUiLocalizedText>>>> =
    buildBackupsTabTextMap();

const CORE_LOCAL_UI_PROJECT_MEMORY_TEXT: Readonly<Record<string, Readonly<Record<string, LocalUiLocalizedText>>>> = Object.freeze({
    en: {
        'garda-agent-orchestrator/live/docs/project-memory/README.md': { label: 'README.md', description: 'Memory index, ownership rules, and reading order.' },
        'garda-agent-orchestrator/live/docs/project-memory/compact.md': { label: 'compact.md', description: 'Short project map and routing hints for task start.' },
        'garda-agent-orchestrator/live/docs/project-memory/context.md': { label: 'context.md', description: 'Domain, project goals, and overall scope.' },
        'garda-agent-orchestrator/live/docs/project-memory/stack.md': { label: 'stack.md', description: 'Languages, frameworks, infrastructure, dependencies, and fallbacks for custom stacks.' },
        'garda-agent-orchestrator/live/docs/project-memory/architecture.md': { label: 'architecture.md', description: 'Architecture, component boundaries, and integration points.' },
        'garda-agent-orchestrator/live/docs/project-memory/module-map.md': { label: 'module-map.md', description: 'Repository areas, path ownership, and where to look for typical changes.' },
        'garda-agent-orchestrator/live/docs/project-memory/commands.md': { label: 'commands.md', description: 'Build, test, dev, release, and verification commands.' },
        'garda-agent-orchestrator/live/docs/project-memory/conventions.md': { label: 'conventions.md', description: 'Coding standards, naming rules, and workflow conventions outside agent-rules.' },
        'garda-agent-orchestrator/live/docs/project-memory/decisions.md': { label: 'decisions.md', description: 'Architectural and process decisions with rationale.' },
        'garda-agent-orchestrator/live/docs/project-memory/risks.md': { label: 'risks.md', description: 'Known risks, fragile paths, security notes, and compatibility constraints.' }
    }
});

export const LOCAL_UI_PROJECT_MEMORY_TEXT: Readonly<Record<string, Readonly<Record<string, LocalUiLocalizedText>>>> = buildImportedLanguageMap(
    CORE_LOCAL_UI_PROJECT_MEMORY_TEXT,
    (pack) => pack.LOCAL_UI_PROJECT_MEMORY_TEXT
);

const CORE_LOCAL_UI_ACTION_TEXT: Readonly<Record<string, Readonly<Record<string, LocalUiLocalizedText>>>> = Object.freeze({
    en: {
        status: {
            label: 'Status',
            description: 'Run the read-only Garda status command for this workspace.'
        },
        doctor: {
            label: 'Doctor',
            description: 'Run read-only Garda diagnostics for init answers, manifests, generated files, locks, and package state.'
        },
        'status-why-blocked': {
            label: 'Why blocked',
            description: 'Explain why visible tasks are blocked without changing files.'
        },
        'repair-inspect': {
            label: 'Inspect runtime state',
            description: 'Inspect canonical and derived runtime state without rebuilding or deleting files.'
        },
        'repair-rebuild-indexes': {
            label: 'Rebuild indexes',
            description: 'Rebuild derived task timeline and review indexes from canonical runtime evidence.'
        },
        'repair-protected-manifest': {
            label: 'Update manifest',
            description: 'Refresh the trusted protected control-plane manifest from the current workspace snapshot.'
        },
        'repair-locks-cleanup-stale': {
            label: 'Clean up stale locks',
            description: 'Remove only task-event and review-artifact locks that Garda classifies as stale.'
        },
        'backup-create-manual': {
            label: 'Create manual backup',
            description: 'Create a manual rollback backup snapshot.'
        }
    }
});

export const LOCAL_UI_ACTION_TEXT: Readonly<Record<string, Readonly<Record<string, LocalUiLocalizedText>>>> = buildImportedLanguageMap(
    CORE_LOCAL_UI_ACTION_TEXT,
    (pack) => pack.LOCAL_UI_ACTION_TEXT
);

const CORE_LOCAL_UI_ACTION_CATEGORY_TEXT = Object.freeze({
    en: {
        Inspection: 'Inspection',
        Repair: 'Repair'
    }
} satisfies Readonly<Record<string, Readonly<Record<string, string>>>>);

export const LOCAL_UI_ACTION_CATEGORY_TEXT: Readonly<Record<string, Readonly<Record<string, string>>>> = buildImportedLanguageMap(
    CORE_LOCAL_UI_ACTION_CATEGORY_TEXT,
    (pack) => pack.LOCAL_UI_ACTION_CATEGORY_TEXT
);

const CORE_LOCAL_UI_INSTRUCTION_TEXT = Object.freeze({
    en: EMPTY_LOCALIZED_TEXT_MAP
} satisfies Readonly<Record<string, Readonly<Record<string, LocalUiLocalizedText>>>>);

export const LOCAL_UI_INSTRUCTION_TEXT: Readonly<Record<string, Readonly<Record<string, LocalUiLocalizedText>>>> = buildImportedLanguageMap(
    CORE_LOCAL_UI_INSTRUCTION_TEXT,
    (pack) => pack.LOCAL_UI_INSTRUCTION_TEXT
);

export const LOCAL_UI_TEXT: Readonly<Record<string, Readonly<Record<LocalUiTextKey, string>>>> = buildImportedLanguageMap(
    {
        en: ENGLISH_LOCAL_UI_TEXT
    },
    (pack) => pack.LOCAL_UI_TEXT as Readonly<Record<LocalUiTextKey, string>>
);

export const ENGLISH_LOCAL_UI_TASK_CLOSURE_POLICY_TEXT = Object.freeze({
    title: 'F-task closure policy',
    help: 'These task-level values are persisted in TASK.md. An active task cycle keeps its frozen effective values until the next task-mode entry.',
    skipLowFindings: 'Skip accepted low findings',
    forbidChildTasks: 'Forbid generated child tasks',
    inapplicable: 'Available only for review-generated follow-up tasks with valid provenance.',
    completed: 'Completed tasks cannot be changed retroactively.',
    invalid: 'Policy metadata is invalid and fails closed.',
    pendingNextCycle: 'Stored values differ from the frozen current-cycle policy and apply on the next task-mode entry.',
    previewRequired: 'Preview the selected values before applying them.',
    storedValues: 'Stored values',
    effectiveValues: 'Effective values'
} as const);

export type LocalUiTaskClosurePolicyTextKey = keyof typeof ENGLISH_LOCAL_UI_TASK_CLOSURE_POLICY_TEXT;

export const LOCAL_UI_TASK_CLOSURE_POLICY_TEXT: Readonly<
    Record<string, Readonly<Record<LocalUiTaskClosurePolicyTextKey, string>>>
> = buildImportedLanguageMap(
    { en: ENGLISH_LOCAL_UI_TASK_CLOSURE_POLICY_TEXT },
    (pack) => Object.freeze({
        ...ENGLISH_LOCAL_UI_TASK_CLOSURE_POLICY_TEXT,
        ...pack.LOCAL_UI_TASK_CLOSURE_POLICY_TEXT
    })
);

export function formatLocalUiLanguageCliChoices(): string {
    return LOCAL_UI_LANGUAGES.map((language) => language.id).join('|');
}

const ENGLISH_LOCAL_UI_TASK_PROGRESS_TEXT = Object.freeze({
    title: 'Task progress',
    help: 'Recorded progress and the next required action. Remaining checks can still fail.',
    completedStages: 'Completed stages',
    currentStage: 'Current stage',
    remainingStages: 'Remaining stages',
    noCompletedStages: 'No confirmed completed stages.',
    noCurrentStage: 'No current stage reported.',
    noRemainingStages: 'No remaining stages reported.',
    nextAction: 'Next action',
    noNextAction: 'No next action reported.',
    command: 'Next command',
    copy: 'Copy command',
    copied: 'Command copied.',
    selectToCopy: 'Command selected. Copy it using your browser or keyboard.',
    finalReport: 'Final report',
    active: 'In progress',
    blocked: 'Blocked',
    stale: 'Stale evidence',
    unknown: 'Unknown progress',
    incomplete: 'Incomplete evidence',
    completed: 'Completed',
    unavailable: 'Unavailable',
    available: 'Available',
    missing: 'Missing',
    pending: 'Pending',
    failed: 'Failed'
} as const);

export const LOCAL_UI_TASK_PROGRESS_TEXT = buildImportedLanguageMap(
    { en: ENGLISH_LOCAL_UI_TASK_PROGRESS_TEXT as Readonly<Record<string, string>> },
    (pack) => Object.freeze({ ...ENGLISH_LOCAL_UI_TASK_PROGRESS_TEXT, ...pack.LOCAL_UI_TASK_PROGRESS_TEXT })
);

export function isLocalUiLanguage(value: unknown): value is LocalUiLanguage {
    return typeof value === 'string'
        && LOCAL_UI_LANGUAGES.some((language) => language.id === value);
}

export function findLocalUiLanguage(value: unknown): LocalUiLanguage | null {
    if (typeof value !== 'string') {
        return null;
    }
    const normalized = value.trim();
    const match = LOCAL_UI_LANGUAGES.find((language) => language.id.toLowerCase() === normalized.toLowerCase());
    return match?.id ?? null;
}

export function normalizeLocalUiLanguage(value: unknown): LocalUiLanguage {
    return isLocalUiLanguage(value)
        ? value
        : DEFAULT_LOCAL_UI_LANGUAGE;
}

export function getLocalUiText(language: unknown): Readonly<Record<LocalUiTextKey, string>> {
    return LOCAL_UI_TEXT[normalizeLocalUiLanguage(language)] || LOCAL_UI_TEXT[DEFAULT_LOCAL_UI_LANGUAGE];
}

export function validateLocalUiTextLanguagePack(
    languageId: string,
    pack: Readonly<Record<string, string>>,
    englishPack: Readonly<Record<LocalUiTextKey, string>> = LOCAL_UI_TEXT.en
): LocalUiTextValidationIssue[] {
    const issues: LocalUiTextValidationIssue[] = [];
    const englishKeys = Object.keys(englishPack).sort() as LocalUiTextKey[];
    const keys = Object.keys(pack).sort();
    for (const key of englishKeys) {
        if (!keys.includes(key)) {
            issues.push({ languageId, key, reason: 'missing local UI text key' });
            continue;
        }
        const actual = pack[key];
        if (!actual?.trim()) {
            issues.push({ languageId, key, reason: 'empty local UI text value' });
            continue;
        }
        if (
            languageId !== DEFAULT_LOCAL_UI_LANGUAGE
            && actual === englishPack[key]
            && !shouldAllowEnglishMatchForLocalUiText(key)
        ) {
            issues.push({ languageId, key, reason: 'local UI text still matches English source' });
        }
    }
    for (const extraKey of keys) {
        if (!englishKeys.includes(extraKey as LocalUiTextKey)) {
            issues.push({ languageId, key: extraKey, reason: 'unexpected extra local UI text key' });
        }
    }
    return issues;
}

export function assertLocalUiLanguagePacksComplete(): void {
    for (const language of LOCAL_UI_LANGUAGES) {
        const issues = validateLocalUiTextLanguagePack(language.id, LOCAL_UI_TEXT[language.id]);
        if (issues.length > 0) {
            const summary = issues
                .slice(0, 12)
                .map((issue) => `${issue.key}: ${issue.reason}`)
                .join('; ');
            throw new Error(`Local UI language pack '${language.id}' is incomplete (${issues.length} issue(s)). ${summary}`);
        }
    }
}

assertLocalUiLanguagePacksComplete();
