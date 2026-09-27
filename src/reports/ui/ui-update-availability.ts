import { UPDATE_AVAILABILITY_TEXT } from './update-availability-text';
import type { LocalUiLanguage } from './ui-i18n';

function escapeText(value: string): string {
    return value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/"/gu, '&quot;');
}

export function renderUpdateAvailabilityPanel(language: LocalUiLanguage): string {
    const text = UPDATE_AVAILABILITY_TEXT[language];
    return `<section class="update-availability" id="update-panel" aria-labelledby="update-title">
<div class="update-availability-row"><strong id="update-title">${escapeText(text.title)}</strong>
<span id="update-status" role="status" aria-live="polite">${escapeText(text.unknown)}</span>
<button type="button" id="update-check" aria-label="${escapeText(text.checkButton)}">${escapeText(text.checkButton)}</button></div>
<div id="update-command-row" hidden><span id="update-command-label">${escapeText(text.commandLabel)}</span>: <code id="update-command" dir="ltr"></code></div>
</section>`;
}

export const UPDATE_AVAILABILITY_STYLES = `
.update-availability{margin-top:12px;font-size:12px;color:var(--muted)}
.update-availability-row{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.update-availability-row button{margin-inline-start:auto}
#update-command-row{margin-top:8px}
#update-command{white-space:pre-wrap;overflow-wrap:anywhere;user-select:all}
`;
