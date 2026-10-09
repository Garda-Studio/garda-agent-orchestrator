import {
    LOCAL_UI_ACTION_CATEGORY_TEXT,
    LOCAL_UI_ACTION_TEXT,
    LOCAL_UI_BACKUPS_TAB_TEXT,
    LOCAL_UI_CLEANUP_SETTING_TEXT,
    LOCAL_UI_INIT_SETTING_TEXT,
    LOCAL_UI_INSTRUCTION_TEXT,
    LOCAL_UI_LANGUAGES,
    LOCAL_UI_PROJECT_MEMORY_STATUS_TEXT,
    LOCAL_UI_PROJECT_MEMORY_TEXT,
    LOCAL_UI_SETTING_TEXT,
    LOCAL_UI_TASK_CLOSURE_POLICY_TEXT,
    LOCAL_UI_TEXT,
    type LocalUiLanguage
} from '../ui-i18n';
import { INSTRUCTIONS_REPORT_UI_TAB_CONTRACT } from './instructions-report-ui-tab';
import { escapeJsonForScript } from '../../static-html/common';
import { BACKUP_SELECTION_TEXT } from '../backup-selection-text';

export interface DashboardClientPreludeOptions {
    actionToken: string;
    actionsEnabled: boolean;
    initialLanguage: LocalUiLanguage;
}

/** Browser-side dashboard DOM bindings and i18n pack constants. */
export function buildDashboardClientPrelude(options: DashboardClientPreludeOptions): string {
    const { actionToken, actionsEnabled, initialLanguage } = options;
    return `const languagePacks = ${escapeJsonForScript(LOCAL_UI_TEXT)};
const settingTextPacks = ${escapeJsonForScript(LOCAL_UI_SETTING_TEXT)};
const actionTextPacks = ${escapeJsonForScript(LOCAL_UI_ACTION_TEXT)};
const initSettingTextPacks = ${escapeJsonForScript(LOCAL_UI_INIT_SETTING_TEXT)};
const cleanupSettingTextPacks = ${escapeJsonForScript(LOCAL_UI_CLEANUP_SETTING_TEXT)};
const backupsTabTextPacks = ${escapeJsonForScript(LOCAL_UI_BACKUPS_TAB_TEXT)};
const backupSelectionTextPacks = ${escapeJsonForScript(BACKUP_SELECTION_TEXT)};
const projectMemoryStatusTextPacks = ${escapeJsonForScript(LOCAL_UI_PROJECT_MEMORY_STATUS_TEXT)};
const projectMemoryTextPacks = ${escapeJsonForScript(LOCAL_UI_PROJECT_MEMORY_TEXT)};
const actionCategoryTextPacks = ${escapeJsonForScript(LOCAL_UI_ACTION_CATEGORY_TEXT)};
const instructionTextPacks = ${escapeJsonForScript(LOCAL_UI_INSTRUCTION_TEXT)};
const taskClosurePolicyTextPacks = ${escapeJsonForScript(LOCAL_UI_TASK_CLOSURE_POLICY_TEXT)};
const languageMetadata = ${escapeJsonForScript(LOCAL_UI_LANGUAGES)};
const fallbackLanguage = 'en';
const initialLanguage = ${escapeJsonForScript(initialLanguage)};
const tasksNode = document.getElementById('tasks');
const tasksConfigPathNode = document.getElementById('tasks-config-path');
const detailNode = document.getElementById('detail');
const metaNode = document.getElementById('meta');
const warningsNode = document.getElementById('warnings');
const overviewNode = document.getElementById('overview');
const gardaSwitchNode = document.getElementById('garda-switch-panel');
const workflowNode = document.getElementById('workflow');
const workflowPanelTitleNode = document.getElementById('workflow-panel-title');
const workflowConfigPathNode = document.getElementById('workflow-config-path');
const qualityGateNode = document.getElementById('quality-gate');
const qualityGateStatusNode = document.getElementById('quality-gate-status');
const qualityGateConfigPathNode = document.getElementById('quality-gate-config-path');
const profilesNode = document.getElementById('profiles');
const profilesStatusNode = document.getElementById('profiles-status');
const profilesConfigPathNode = document.getElementById('profiles-config-path');
const initSettingsConfigPathNode = document.getElementById('init-settings-config-path');
const projectMemoryConfigPathNode = document.getElementById('project-memory-config-path');
const backupsConfigPathNode = document.getElementById('backups-config-path');
const cleanupConfigPathNode = document.getElementById('cleanup-config-path');
const settingsEditorNode = document.getElementById('settings-editor');
const instructionsNode = document.getElementById(${escapeJsonForScript(INSTRUCTIONS_REPORT_UI_TAB_CONTRACT.id)});
const initSettingsNode = document.getElementById('init-settings');
const projectMemoryNode = document.getElementById('project-memory');
const actionsNode = document.getElementById('actions');
const actionStatusNode = document.getElementById('action-status');
const cleanupSettingsNode = document.getElementById('cleanup-settings');
const cleanupStatusNode = document.getElementById('cleanup-status');
const sessionSummaryNode = document.getElementById('session-summary');
const sessionCountdownNode = document.getElementById('session-countdown');
const sessionActivityNode = document.getElementById('session-activity');
const sessionShutdownNode = document.getElementById('session-shutdown');
const languageSelectNode = document.getElementById('language-select');
const uiNoticeNode = document.getElementById('ui-notice');
const searchNode = document.getElementById('task-search');
const statusFilterNode = document.getElementById('status-filter');
const priorityFilterNode = document.getElementById('priority-filter');
const planModalNode = document.getElementById('plan-modal');
const planModalBodyNode = document.getElementById('plan-modal-body');
const planModalCloseNode = document.getElementById('plan-modal-close');
const actionToken = ${escapeJsonForScript(actionToken)};
const actionsEnabled = ${escapeJsonForScript(actionsEnabled)};
let currentReport = null;
let currentSession = null;
let currentActionsPayload = null;
let currentActionResult = null;
let currentSettingsPayload = null;
let currentWorkflowSettingResult = null;
let currentQualityGateSettingResult = null;
let currentProfilesPayload = null;
let currentProfileActionResult = null;
let currentMemorySettingResult = null;
let currentTaskDetail = null;
let currentTaskClosurePolicyPreview = null;
let currentWorkflowSettingGroup = 'validation';
let selectedTaskId = null;
let lastActivityPingAt = 0;
let sessionPollTimer = null;
const loadedTaskDetails = {};
`;
}
