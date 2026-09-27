import {
    buildDashboardClientScript,
    renderDashboardBodyMarkup,
    renderDashboardPlanModalMarkup,
    UI_DASHBOARD_POLISH_STYLES,
    UI_DASHBOARD_STYLES
} from './dashboard';
import {
    getLocalUiText,
    normalizeLocalUiLanguage,
    type LocalUiLanguage
} from './ui-i18n';
import { renderUpdateAvailabilityPanel, UPDATE_AVAILABILITY_STYLES } from './ui-update-availability';

export function renderLocalUiHtml(actionsEnabled: boolean, actionToken: string, initialLanguage: LocalUiLanguage = 'en'): string {
    const language = normalizeLocalUiLanguage(initialLanguage);
    const text = getLocalUiText(language);
    const bodyMarkup = renderDashboardBodyMarkup(text, actionsEnabled)
        .replace('</header>', `${renderUpdateAvailabilityPanel(language)}</header>`);
    const planModalMarkup = renderDashboardPlanModalMarkup(text);
    const clientScript = buildDashboardClientScript({
        actionToken,
        actionsEnabled,
        initialLanguage: language
    });
    return `<!doctype html>
<html lang="${language}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${text.appTitle}</title>
<style>
${UI_DASHBOARD_STYLES}
${UI_DASHBOARD_POLISH_STYLES}
${UPDATE_AVAILABILITY_STYLES}
</style>
</head>
<body>
${bodyMarkup}
${planModalMarkup}
<script>
${clientScript}
</script>
</body>
</html>`;
}
