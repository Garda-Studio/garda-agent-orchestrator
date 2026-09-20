import { INSTRUCTIONS_REPORT_UI_TAB_CONTRACT } from './instructions-report-ui-tab';

const instructionsTabId = `${INSTRUCTIONS_REPORT_UI_TAB_CONTRACT.id}-tab`;
const instructionsLabelKey = INSTRUCTIONS_REPORT_UI_TAB_CONTRACT.label.key;
const instructionsLabelPlaceholder = `\${text.${instructionsLabelKey}}`;

/** Static dashboard body markup; placeholders are filled at render time. */
export const UI_DASHBOARD_MARKUP = `<header>
<div class="header-row">
<div>
<h1 data-i18n="appTitle">\${text.appTitle}</h1>
<div class="meta" id="meta" data-i18n="loadingWorkspaceReport">\${text.loadingWorkspaceReport}</div>
<div class="header-notice" id="ui-notice">\${actionsEnabled ? text.noticeActionsEnabled : text.noticeActionsDisabled}</div>
</div>
<div class="top-controls" id="top-controls">
<div class="session-compact" id="server-status-panel">
<div class="session-status-line" id="session-summary" data-i18n="loadingServerSession">\${text.loadingServerSession}</div>
<input id="session-countdown" type="range" min="0" max="60" value="60" disabled hidden>
<div class="session-action-row">
<button type="button" id="session-activity" data-i18n="iAmHere">\${text.iAmHere}</button>
<button type="button" id="session-shutdown" data-i18n="stopServer">\${text.stopServer}</button>
</div>
</div>
<label class="language-compact"><span class="language-icon" aria-hidden="true">&#127760;</span><span class="visually-hidden" data-i18n="languageTitle">\${text.languageTitle}</span><select id="language-select" data-i18n-aria-label="languageTitle"></select></label>
</div>
</div>
</header>
<nav>
<div class="tab-buttons">
<button type="button" class="active" data-tab="tasks-tab" data-i18n="tasksTab">\${text.tasksTab}</button>
<button type="button" data-tab="quality-gate-tab" data-i18n="qualityGateTab">\${text.qualityGateTab}</button>
<button type="button" data-tab="profiles-tab" data-i18n="profilesTab">\${text.profilesTab}</button>
<button type="button" data-tab="workflow-tab" data-setting-group="validation" data-i18n="workflowGroupValidation">\${text.workflowGroupValidation}</button>
<button type="button" data-tab="workflow-tab" data-setting-group="review" data-i18n="workflowGroupReview">\${text.workflowGroupReview}</button>
<button type="button" data-tab="workflow-tab" data-setting-group="scope" data-i18n="workflowGroupScope">\${text.workflowGroupScope}</button>
<button type="button" data-tab="workflow-tab" data-setting-group="safety" data-i18n="workflowGroupSafety">\${text.workflowGroupSafety}</button>
<button type="button" data-tab="workflow-tab" data-setting-group="compact">Compact</button>
<button type="button" data-tab="init-settings-tab" data-i18n="initSettingsTab">\${text.initSettingsTab}</button>
<button type="button" data-tab="project-memory-tab" data-i18n="projectMemoryTab">\${text.projectMemoryTab}</button>
<button type="button" data-tab="backups-tab" data-i18n="backupsTab">\${text.backupsTab}</button>
<button type="button" data-tab="cleanup-settings-tab" data-i18n="cleanupSettingsTab">\${text.cleanupSettingsTab}</button>
<button type="button" data-tab="${instructionsTabId}" data-i18n="${instructionsLabelKey}">${instructionsLabelPlaceholder}</button>
<button type="button" data-tab="actions-tab" data-i18n="actionsTab">\${text.actionsTab}</button>
</div>
</nav>
<main>
<section class="warnings" id="warnings" hidden></section>
<section class="tab" id="tasks-tab">
<div class="overview" id="overview"></div>
<div class="tasks-layout">
<section class="panel task-list-panel">
<div class="panel-head tab-head"><h2 data-i18n="tasksTab">\${text.tasksTab}</h2><span class="config-path" id="tasks-config-path"></span></div>
<div class="panel-head">
<div class="toolbar">
<input id="task-search" type="search" placeholder="\${text.searchTasks}" data-i18n-placeholder="searchTasks">
<select id="status-filter"><option value="">\${text.allStatuses}</option></select>
<select id="priority-filter"><option value="">\${text.allPriorities}</option></select>
</div>
</div>
<div class="table-wrap">
<table>
<thead><tr><th data-i18n="idColumn">\${text.idColumn}</th><th data-i18n="statusColumn">\${text.statusColumn}</th><th data-i18n="priorityColumn">\${text.priorityColumn}</th><th data-i18n="areaColumn">\${text.areaColumn}</th><th data-i18n="titleColumn">\${text.titleColumn}</th><th data-i18n="dataColumn">\${text.dataColumn}</th><th data-i18n="actionColumn">\${text.actionColumn}</th></tr></thead>
<tbody id="tasks"><tr><td colspan="7" class="empty" data-i18n="loading">\${text.loading}</td></tr></tbody>
</table>
</div>
</section>
<section class="panel task-detail-panel" id="task-detail-panel">
<div class="panel-head"><h2 data-i18n="taskDetailTitle">\${text.taskDetailTitle}</h2></div>
<div class="detail" id="detail"><p class="empty" data-i18n="chooseTask">\${text.chooseTask}</p></div>
</section>
</div>
</section>
<section class="panel tab" id="profiles-tab" hidden>
<div class="panel-head tab-head"><h2 data-i18n="profilesTab">\${text.profilesTab}</h2><span class="config-path" id="profiles-config-path"></span></div>
<div class="detail tab-body profiles-detail">
<section id="profiles-status" class="action-status empty"></section>
<section id="profiles"><p class="empty" data-i18n="loading">\${text.loading}</p></section>
</div>
</section>
<section class="panel tab" id="quality-gate-tab" hidden>
<div class="panel-head tab-head"><h2 data-i18n="qualityGateTab">\${text.qualityGateTab}</h2><span class="config-path" id="quality-gate-config-path"></span></div>
<div class="detail tab-body quality-gate-detail">
<section id="quality-gate-status" class="action-status empty"></section>
<section id="quality-gate"><p class="empty" data-i18n="loading">\${text.loading}</p></section>
</div>
</section>
<section class="panel tab" id="workflow-tab" hidden>
<div class="panel-head tab-head"><h2 id="workflow-panel-title"></h2><span class="config-path" id="workflow-config-path"></span></div>
<div class="detail tab-body">
<div id="workflow" class="tab-messages" hidden></div>
<div id="settings-editor"></div>
</div>
</section>
<section class="panel tab" id="init-settings-tab" hidden>
<div class="panel-head tab-head"><h2 data-i18n="initSettingsTab">\${text.initSettingsTab}</h2><span class="config-path" id="init-settings-config-path"></span></div>
<div class="detail tab-body" id="init-settings"><p class="empty" data-i18n="loading">\${text.loading}</p></div>
</section>
<section class="panel tab" id="project-memory-tab" hidden>
<div class="panel-head tab-head"><h2 data-i18n="projectMemoryTab">\${text.projectMemoryTab}</h2><span class="config-path" id="project-memory-config-path"></span></div>
<div class="detail tab-body" id="project-memory"><p class="empty" data-i18n="loading">\${text.loading}</p></div>
</section>
<section class="panel tab" id="backups-tab" hidden>
<div class="panel-head tab-head"><h2 data-i18n="backupsTab">\${text.backupsTab}</h2><span class="config-path" id="backups-config-path"></span></div>
<div class="detail tab-body backups-detail">
<div id="backup-action-status" class="action-status empty"></div>
<section id="backups-settings" class="backups-settings"></section>
<section id="backups-table" class="backups-table"></section>
</div>
</section>
<section class="panel tab" id="cleanup-settings-tab" hidden>
<div class="panel-head tab-head"><h2 data-i18n="cleanupSettingsTab">\${text.cleanupSettingsTab}</h2><span class="config-path" id="cleanup-config-path"></span></div>
<div class="detail tab-body cleanup-detail">
<div id="cleanup-status" class="action-status empty"></div>
<section id="cleanup-settings" class="cleanup-settings"><p class="empty" data-i18n="loading">\${text.loading}</p></section>
</div>
</section>
<section class="panel tab" id="${instructionsTabId}" hidden>
<div class="panel-head tab-head"><h2 data-i18n="${instructionsLabelKey}">${instructionsLabelPlaceholder}</h2></div>
<div class="detail tab-body" id="${INSTRUCTIONS_REPORT_UI_TAB_CONTRACT.id}"><p class="empty" data-i18n="loading">\${text.loading}</p></div>
</section>
<section class="panel tab" id="actions-tab" hidden>
<div class="panel-head tab-head"><h2 data-i18n="actionsTab">\${text.actionsTab}</h2></div>
<div class="detail tab-body">
<section id="system-state-panel" class="system-state-panel"></section>
<section class="switch-strip" id="garda-switch-panel" hidden></section>
<section class="action-status empty" id="action-status"></section>
<div id="actions" hidden></div>
</div>
</section>
</main>`;
