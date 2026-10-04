/** Small dashboard chrome overrides kept separate from the generated base CSS. */
export const UI_DASHBOARD_POLISH_STYLES = [
    '.top-controls { align-items: flex-start; gap: 10px; }',
    '.language-compact { display: grid; grid-template-columns: auto minmax(150px, 220px); align-items: center; gap: 4px 8px; }',
    '.language-icon { grid-column: 1; grid-row: 2; align-self: center; padding-top: 0; }',
    '.language-compact .visually-hidden { position: static; width: auto; height: auto; padding: 0; margin: 0; overflow: visible; clip: auto; white-space: normal; border: 0; grid-column: 2; color: var(--muted); font-size: 12px; line-height: 1.25; }',
    '.language-compact select { grid-column: 2; width: 100%; min-width: 150px; max-width: 220px; }',
    '.session-compact { flex: 0 0 304px; width: 304px; max-width: 100%; margin-left: 0; align-items: stretch; }',
    '.session-action-row { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }',
    '.session-action-row button { width: 100%; min-height: 34px; }',
    '.tab-buttons button { flex: 1 1 132px; max-width: 190px; min-height: 42px; white-space: normal; overflow-wrap: anywhere; line-height: 1.15; overflow: visible; }',
    'main { background: var(--page); border-top: 1px solid var(--page-line); }',
    '.notice, .warnings, .switch-strip, #action-status { width: 100%; margin-left: 0; margin-right: 0; }',
    '.tab { width: 100%; max-width: none; margin-left: 0; margin-right: 0; box-shadow: 0 8px 24px var(--shadow-soft); }',
    '.ordinary-doc-form { display: grid; grid-template-columns: minmax(220px, 1fr) auto; gap: 10px; align-items: end; margin-top: 10px; }',
    '.ordinary-doc-form label { display: grid; gap: 5px; color: var(--muted); font-size: 13px; }',
    '.ordinary-doc-form input { width: 100%; }',
    '@media (max-width: 760px) { .session-compact { flex: 1 1 100%; width: 100%; max-width: none; margin-left: 0; } .ordinary-doc-form { grid-template-columns: 1fr; } }',
    '@media (max-width: 640px) { .top-controls { justify-self: stretch; width: 100%; } .language-compact { width: 100%; grid-template-columns: auto minmax(0, 1fr); } .language-compact select { max-width: none; } }'
].join('\n');
