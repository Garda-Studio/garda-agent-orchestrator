import { buildDashboardClientPrelude, type DashboardClientPreludeOptions } from './dashboard-client-prelude';
import { UI_DASHBOARD_CLIENT_BOOTSTRAP } from './dashboard-client-bootstrap';
import { UI_DASHBOARD_CLIENT_CORE } from './dashboard-client-core';
import { UI_DASHBOARD_CLIENT_INIT_SETTINGS } from './dashboard-client-init-settings';
import { UI_DASHBOARD_CLIENT_BACKUPS } from './dashboard-client-backups';
import { UI_DASHBOARD_CLIENT_CLEANUP } from './dashboard-client-cleanup';
import { UI_DASHBOARD_CLIENT_INSTRUCTIONS } from './dashboard-client-instructions';
import { UI_DASHBOARD_CLIENT_QUALITY_GATE } from './dashboard-client-quality-gate';
import { UI_DASHBOARD_CLIENT_PROJECT_MEMORY } from './dashboard-client-project-memory';
import { UI_DASHBOARD_CLIENT_PROFILES } from './dashboard-client-profiles';
import { UI_DASHBOARD_CLIENT_POLISH } from './dashboard-client-polish';
import { UI_DASHBOARD_CLIENT_SESSION_ACTIONS } from './dashboard-client-session-actions';
import { UI_DASHBOARD_CLIENT_TASK_DETAIL } from './dashboard-client-task-detail';
import { UI_DASHBOARD_CLIENT_TASKS } from './dashboard-client-tasks';
import { UI_DASHBOARD_CLIENT_WORKFLOW } from './dashboard-client-workflow';
import { buildDashboardUpdatesClientScript } from './dashboard-client-updates';

export function buildDashboardClientScript(options: DashboardClientPreludeOptions): string {
    return [
        buildDashboardClientPrelude(options),
        UI_DASHBOARD_CLIENT_CORE,
        UI_DASHBOARD_CLIENT_TASKS,
        UI_DASHBOARD_CLIENT_WORKFLOW,
        UI_DASHBOARD_CLIENT_QUALITY_GATE,
        UI_DASHBOARD_CLIENT_PROFILES,
        UI_DASHBOARD_CLIENT_INIT_SETTINGS,
        UI_DASHBOARD_CLIENT_PROJECT_MEMORY,
        UI_DASHBOARD_CLIENT_BACKUPS,
        UI_DASHBOARD_CLIENT_CLEANUP,
        UI_DASHBOARD_CLIENT_INSTRUCTIONS,
        UI_DASHBOARD_CLIENT_SESSION_ACTIONS,
        UI_DASHBOARD_CLIENT_POLISH,
        UI_DASHBOARD_CLIENT_TASK_DETAIL,
        buildDashboardUpdatesClientScript(),
        UI_DASHBOARD_CLIENT_BOOTSTRAP
    ].join('\n');
}
