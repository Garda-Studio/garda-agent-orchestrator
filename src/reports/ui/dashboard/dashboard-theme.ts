/** Dashboard theme layer: refreshed chrome for both themes, dark tokens, and theme selection. */

export const UI_THEME_STORAGE_KEY = 'garda.ui.theme';
export const UI_THEME_MODES = Object.freeze(['system', 'light', 'dark'] as const);

/**
 * Applies an explicitly chosen theme before first paint so the page never flashes the other theme.
 * "System" leaves `data-theme` unset and the prefers-color-scheme media query decides.
 */
export const UI_DASHBOARD_THEME_HEAD_SCRIPT = `(function () {
  var mode = 'system';
  try {
    var stored = window.localStorage ? window.localStorage.getItem(${JSON.stringify(UI_THEME_STORAGE_KEY)}) : null;
    if (stored === 'light' || stored === 'dark' || stored === 'system') mode = stored;
  } catch (error) {}
  var root = document.documentElement;
  root.setAttribute('data-theme-mode', mode);
  if (mode !== 'system') root.setAttribute('data-theme', mode);
})();`;

/** Browser-side theme selector wiring; runs after the dashboard prelude and core helpers. */
export const UI_DASHBOARD_CLIENT_THEME = `const themeSelectNode = document.getElementById('theme-select');
function readThemeMode() {
  const mode = document.documentElement ? document.documentElement.getAttribute('data-theme-mode') : null;
  return mode === 'light' || mode === 'dark' ? mode : 'system';
}
function applyThemeMode(mode) {
  const root = document.documentElement;
  if (!root) return;
  root.setAttribute('data-theme-mode', mode);
  if (mode === 'system') {
    root.removeAttribute('data-theme');
  } else {
    root.setAttribute('data-theme', mode);
  }
  if (themeSelectNode) themeSelectNode.value = mode;
}
if (themeSelectNode) {
  themeSelectNode.value = readThemeMode();
  themeSelectNode.addEventListener('change', () => {
    const mode = ${JSON.stringify(UI_THEME_MODES)}.includes(themeSelectNode.value) ? themeSelectNode.value : 'system';
    try {
      if (window.localStorage) window.localStorage.setItem(${JSON.stringify(UI_THEME_STORAGE_KEY)}, mode);
    } catch {}
    applyThemeMode(mode);
  });
}`;

/** Dark values for every dashboard color token. */
const DARK_THEME_TOKENS = `color-scheme: dark;
--ink: #e6edf3; --muted: #9aa5b1; --line: #252c36; --line-strong: #343d49; --panel: #161b23; --accent: #57e7dc; --blue: #8ab4ff; --warn: #e3b341; --danger: #ff7b72; --danger-bg: rgba(255, 123, 114, .12); --ok: #3fb68b;
--page: #0b0e13; --page-line: #1b2129; --surface: #12161d; --surface-subtle: #161b23; --surface-cool: #151b24; --surface-disabled: #1c222b; --row-hover: #18202a;
--ink-secondary: #c3ccd6; --on-accent: #06140f; --code-bg: #090c11; --code-ink: #dbe4ee; --code-inline-bg: rgba(138, 180, 255, .12);
--accent-ink: #8ff3eb; --accent-soft: rgba(87, 231, 220, .12); --accent-soft-alt: rgba(87, 231, 220, .08); --accent-soft-subtle: rgba(87, 231, 220, .06); --accent-line: rgba(87, 231, 220, .35);
--ok-ink: #6fdc9f; --ok-ink-alt: #6fdc9f; --ok-soft: rgba(63, 182, 139, .16); --ok-soft-alt: rgba(63, 182, 139, .14); --ok-line: rgba(63, 182, 139, .45); --ok-line-strong: rgba(63, 182, 139, .7);
--info-ink: #a9c4ff; --info-ink-alt: #a9c4ff; --info-soft: rgba(138, 180, 255, .14); --info-soft-alt: rgba(138, 180, 255, .14); --info-soft-subtle: rgba(138, 180, 255, .1); --info-line: rgba(138, 180, 255, .4); --info-line-strong: rgba(138, 180, 255, .6); --info-line-subtle: rgba(138, 180, 255, .3);
--warn-ink: #f0c36a; --warn-ink-alt: #f0c36a; --warn-soft: rgba(227, 179, 65, .15); --warn-soft-alt: rgba(227, 179, 65, .15); --warn-soft-subtle: rgba(227, 179, 65, .1);
--danger-ink: #ffa198; --danger-ink-alt: #ffa198; --danger-soft: rgba(255, 123, 114, .14); --danger-soft-alt: rgba(255, 123, 114, .14); --danger-soft-subtle: rgba(255, 123, 114, .1); --danger-line: rgba(255, 123, 114, .4); --danger-line-strong: rgba(255, 123, 114, .6); --danger-line-alt: rgba(255, 123, 114, .4);
--neutral-ink: #b3bdc8; --neutral-soft: #1f2731; --neutral-soft-alt: #1c232c; --neutral-line: #303945; --neutral-line-strong: #3b4553;
--sky-ink: #8cc8ff; --sky-soft: rgba(88, 166, 255, .14);
--nav-active-bg: #b8ff72; --nav-active-ink: #0b0e13; --brand-mark-ink: #0b0e13;
--backdrop: rgba(0, 0, 0, .6); --shadow-strong: rgba(0, 0, 0, .55); --shadow-soft: rgba(0, 0, 0, .3); `;

const DARK_THEME_RULES: readonly (readonly [string, string])[] = [
    ['.tab-buttons button.active', 'box-shadow: 0 0 0 1px rgba(184, 255, 114, .35), 0 6px 18px rgba(184, 255, 114, .12);'],
    ['pre', 'border: 1px solid var(--line);'],
    ['.task-stage-list-completed li::before', 'box-shadow: 0 0 0 3px rgba(63, 182, 139, .2);']
];

function renderDarkTheme(rootSelector: string): string {
    return [
        `${rootSelector} { ${DARK_THEME_TOKENS}}`,
        ...DARK_THEME_RULES.map(([selector, declarations]) => `${rootSelector} ${selector} { ${declarations} }`)
    ].join('\n');
}

/** Dark theme for an explicit choice and for "System" when the OS prefers dark. */
export const UI_DASHBOARD_DARK_THEME_STYLES = [
    renderDarkTheme(':root[data-theme="dark"]'),
    `@media (prefers-color-scheme: dark) {\n${renderDarkTheme(':root:not([data-theme="light"])')}\n}`
].join('\n');

/** Refreshed dashboard chrome shared by both themes; appended after the base and polish layers. */
export const UI_DASHBOARD_REFRESH_STYLES = `:root { --line-strong: #c9d0d9; --row-hover: #f6f8fb; --nav-active-bg: #17202a; --nav-active-ink: #fff; --brand-mark-ink: #0b0e13;
--font-ui: "Segoe UI Variable Text", "Segoe UI", system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif;
--font-mono: "Cascadia Mono", "Cascadia Code", "JetBrains Mono", ui-monospace, Consolas, "Courier New", monospace; }
body { font-family: var(--font-ui); font-size: 14px; line-height: 1.5; background: var(--page); -webkit-font-smoothing: antialiased; }
code, pre, textarea.task-progress-command { font-family: var(--font-mono); }
button, input, select { border-radius: 8px; border-color: var(--line-strong); }
button { min-height: 32px; padding: 6px 12px; font-weight: 500; transition: border-color .12s ease, color .12s ease, background-color .12s ease; }
button:disabled { border-color: var(--line); }
input:focus-visible, select:focus-visible, button:focus-visible, textarea:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
header { padding: 14px 24px 12px; background: var(--surface); border-bottom: 1px solid var(--line); }
.header-row { align-items: center; }
h1 { display: flex; align-items: center; gap: 10px; font-size: 19px; font-weight: 650; letter-spacing: -0.01em; }
h1::before { content: "G"; display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px; border-radius: 7px; background: linear-gradient(135deg, #b8ff72, #57e7dc); color: var(--brand-mark-ink); font-size: 15px; font-weight: 800; letter-spacing: 0; flex: 0 0 auto; }
.meta { margin-top: 2px; font-size: 12.5px; }
.header-notice { color: var(--muted); font-size: 12.5px; margin-top: 3px; }
.top-controls { align-items: center; gap: 10px; }
.session-compact { flex: 0 1 auto; width: auto; flex-direction: row; align-items: center; gap: 10px; padding: 5px 6px 5px 12px; border-radius: 10px; background: var(--surface-subtle); }
.session-status-line { width: auto; white-space: nowrap; font-size: 12.5px; color: var(--muted); }
.session-action-row { display: flex; gap: 6px; }
.session-compact button, .session-action-row button { width: auto; min-height: 28px; padding: 3px 10px; font-size: 12.5px; }
.language-compact { display: flex; align-items: center; gap: 6px; }
.language-compact .visually-hidden { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
.language-compact select { width: auto; min-width: 0; max-width: 180px; min-height: 32px; padding: 4px 8px; font-size: 13px; }
.language-icon { font-size: 16px; color: var(--muted); }
.update-availability { margin-top: 10px; padding-top: 10px; border-top: 1px dashed var(--line); }
.update-availability-row button { min-height: 28px; padding: 3px 10px; font-size: 12.5px; }
nav { padding: 8px 24px; background: var(--surface); border-bottom: 1px solid var(--line); }
.tab-buttons { gap: 2px; }
.tab-buttons button { flex: 0 0 auto; min-width: 0; max-width: none; min-height: 34px; padding: 6px 10px; border: 1px solid transparent; border-radius: 8px; background: transparent; color: var(--muted); font-size: 13.5px; white-space: nowrap; overflow: visible; }
.tab-buttons button:hover:not(:disabled) { background: var(--surface-disabled); border-color: transparent; color: var(--ink); }
.tab-buttons button.active, .tab-buttons button.active:hover:not(:disabled) { background: var(--nav-active-bg); border-color: var(--nav-active-bg); color: var(--nav-active-ink); font-weight: 600; }
main { padding: 20px 24px 32px; background: var(--page); border-top: 0; }
.tab { box-shadow: none; }
.notice, .warnings, .panel { border-radius: 12px; border-color: var(--line); }
.panel-head { padding: 14px 16px; background: var(--surface); }
.panel-head h2, .tab-head h2 { font-size: 16px; font-weight: 650; }
.detail { padding: 16px; }
.overview { gap: 12px; margin-bottom: 16px; }
.metrics { gap: 10px; }
.metric { min-height: 0; padding: 12px 14px; border-radius: 10px; background: var(--surface); }
.overview .metric { padding: 14px 16px; }
.metric span { font-size: 12px; margin-bottom: 2px; }
.metric strong { font-size: 18px; font-weight: 650; font-variant-numeric: tabular-nums; letter-spacing: -0.01em; }
.overview .metric strong { font-size: 24px; }
.tasks-layout { grid-template-columns: minmax(560px, 1.6fr) minmax(360px, 1fr); gap: 16px; }
.task-list-panel th:nth-child(1) { width: 112px; }
.task-list-panel th:nth-child(2) { width: 100px; }
.task-list-panel th:nth-child(3) { width: 76px; }
.task-list-panel th:nth-child(4) { width: 140px; }
.task-list-panel th:nth-child(6) { width: 92px; }
.task-list-panel th:nth-child(7) { width: 112px; }
.task-list-panel .badge { width: auto; }
#tasks button[data-task-id] { flex: 0 0 auto; width: auto; height: auto; min-height: 30px; padding: 4px 10px; font-size: 12.5px; white-space: nowrap; }
table { font-size: 13.5px; }
th, td { padding: 10px 12px; }
th { background: var(--surface-subtle); color: var(--muted); font-size: 11.5px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; }
tbody tr:hover { background: var(--row-hover); }
tr.selected, tr.selected:hover { background: var(--accent-soft); }
#tasks td:nth-child(1) { white-space: nowrap; font-family: var(--font-mono); font-size: 12.5px; }
#tasks td:nth-child(4) { overflow-wrap: anywhere; color: var(--muted); font-family: var(--font-mono); font-size: 12px; }
#tasks td:nth-child(5) { font-weight: 500; }
.badge { min-width: 0; min-height: 22px; padding: 2px 9px; font-size: 11.5px; font-weight: 650; letter-spacing: .02em; }
.task-id { font-weight: 600; }
.detail > h2 { font-size: 17px; line-height: 1.35; }
pre { border-radius: 10px; }
.task-progress-card { padding: 16px 18px; border-radius: 12px; background: var(--surface-subtle); }
.task-progress-card > .task-section-title, .task-progress-card > h3 { margin-top: 0; }
.task-progress-card h4 { margin: 14px 0 6px; font-size: 12px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; color: var(--muted); }
.task-progress-card[data-progress-state] > h3 + p { display: inline-flex; align-self: start; justify-self: start; padding: 3px 10px; border-radius: 999px; background: var(--neutral-soft); color: var(--neutral-ink); font-size: 12px; font-weight: 650; }
.task-progress-card[data-progress-state="completed"] > h3 + p, .task-progress-card[data-progress-state="active"] > h3 + p { background: var(--ok-soft); color: var(--ok-ink); }
.task-progress-card[data-progress-state="blocked"] > h3 + p, .task-progress-card[data-progress-state="stale"] > h3 + p, .task-progress-card[data-progress-state="incomplete"] > h3 + p { background: var(--warn-soft); color: var(--warn-ink); }
.task-progress-card[data-progress-state="failed"] > h3 + p { background: var(--danger-soft); color: var(--danger-ink); }
.task-stage-list { list-style: none; margin: 4px 0 0; padding: 0; display: grid; gap: 2px; }
.task-stage-list li { position: relative; padding: 3px 0 3px 26px; }
.task-stage-list li::before { content: ""; position: absolute; left: 4px; top: 9px; width: 12px; height: 12px; border-radius: 50%; box-sizing: border-box; }
.task-stage-list li:not(:last-child)::after { content: ""; position: absolute; left: 9px; top: 23px; bottom: -5px; width: 2px; border-radius: 1px; background: var(--line); }
.task-stage-list-completed li::before { background: var(--ok); box-shadow: 0 0 0 3px var(--ok-soft); }
.task-stage-list-completed li:not(:last-child)::after { background: var(--ok-line); }
.task-stage-list-remaining li::before { border: 2px solid var(--line-strong); background: var(--surface); }
.task-stage-list time { margin-left: 8px; color: var(--muted); font-family: var(--font-mono); font-size: 11.5px; }
.task-stage-current { display: flex; align-items: center; gap: 10px; }
.task-stage-current code { padding: 3px 10px; border-radius: 999px; background: var(--accent-soft); color: var(--accent-ink); border: 1px solid var(--accent-line); }
.task-stage-current::before { content: ""; width: 12px; height: 12px; margin-left: 4px; border-radius: 50%; background: var(--accent); box-shadow: 0 0 0 4px var(--accent-soft); flex: 0 0 auto; }
@media (max-width: 1060px) { .tasks-layout { grid-template-columns: 1fr; } }
@media (max-width: 760px) { header, nav, main { padding-left: 14px; padding-right: 14px; } .session-compact { flex-wrap: wrap; } .session-status-line { white-space: normal; } }`;
