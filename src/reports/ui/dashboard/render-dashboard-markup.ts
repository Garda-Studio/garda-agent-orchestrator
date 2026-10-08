import { UI_DASHBOARD_MARKUP } from './dashboard-markup';
import type { LocalUiTextKey } from '../ui-i18n';
import { escapeHtml } from '../../static-html/common';

const TEXT_PLACEHOLDER_PATTERN = /\$\{(?:text\.([a-zA-Z0-9_]+)|actionsEnabled \? text\.noticeActionsEnabled : text\.noticeActionsDisabled)\}/g;

/** Static dashboard body markup with initial i18n strings applied. */
export function renderDashboardBodyMarkup(text: Readonly<Record<LocalUiTextKey, string>>, actionsEnabled: boolean): string {
    return UI_DASHBOARD_MARKUP.replace(TEXT_PLACEHOLDER_PATTERN, (_match, key: string | undefined) => {
        const value = key
            ? text[key as LocalUiTextKey]
            : actionsEnabled ? text.noticeActionsEnabled : text.noticeActionsDisabled;
        return escapeHtml(value);
    });
}

/** Task plan modal shell with initial i18n strings applied. */
export function renderDashboardPlanModalMarkup(text: Readonly<Record<LocalUiTextKey, string>>): string {
    return `<div class="modal-backdrop" id="plan-modal" hidden>
<section class="modal" role="dialog" aria-modal="true" aria-labelledby="plan-modal-title">
<div class="modal-head"><h2 id="plan-modal-title" data-i18n="taskPlanTitle">${escapeHtml(text.taskPlanTitle)}</h2><button type="button" id="plan-modal-close" data-i18n="close">${escapeHtml(text.close)}</button></div>
<div class="modal-body" id="plan-modal-body"></div>
</section>
</div>`;
}
