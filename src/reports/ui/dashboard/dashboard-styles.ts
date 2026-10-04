/** Shared dashboard CSS. */
export const UI_DASHBOARD_STYLES = `:root { color-scheme: light; --ink: #17202a; --muted: #667085; --line: #d9e0ea; --panel: #f6f8fb; --accent: #18715f; --blue: #2457a6; --warn: #9a5b00; --danger: #b42318; --danger-bg: #fff1f0; --ok: #17633a;
--page: #f3f6fa; --page-line: #e4eaf2; --surface: #fff; --surface-subtle: #fbfcfe; --surface-cool: #f7f9fc; --surface-disabled: #f2f4f7;
--ink-secondary: #344054; --on-accent: #fff; --code-bg: #111827; --code-ink: #f9fafb; --code-inline-bg: #edf4ff;
--accent-ink: #145447; --accent-soft: #eef8f6; --accent-soft-alt: #f3fbf8; --accent-soft-subtle: #f7fbfa; --accent-line: #b8d9d1;
--ok-ink: #17633a; --ok-ink-alt: #176333; --ok-soft: #e7f6ec; --ok-soft-alt: #eaf7ee; --ok-line: #9fd6b5; --ok-line-strong: #7bc99b;
--info-ink: #3442a0; --info-ink-alt: #244b8f; --info-soft: #eef2ff; --info-soft-alt: #eaf1ff; --info-soft-subtle: #eef4ff; --info-line: #b9cdf7; --info-line-strong: #9cb9ee; --info-line-subtle: #c7d7f2;
--warn-ink: #8a4b17; --warn-ink-alt: #7c4d00; --warn-soft: #fff4dc; --warn-soft-alt: #fff4d6; --warn-soft-subtle: #fff8e8;
--danger-ink: #9b1c1c; --danger-ink-alt: #8a1f1f; --danger-soft: #fdecec; --danger-soft-alt: #fee7e7; --danger-soft-subtle: #fff1f1; --danger-line: #efb4b4; --danger-line-strong: #d98d8d; --danger-line-alt: #f3b6b1;
--neutral-ink: #4b5563; --neutral-soft: #eef2f6; --neutral-soft-alt: #f3f5f7; --neutral-line: #d4dae3; --neutral-line-strong: #c6ccd6;
--sky-ink: #1f5f82; --sky-soft: #e6f4fb;
--backdrop: rgba(15, 23, 42, .45); --shadow-strong: rgba(15, 23, 42, .25); --shadow-soft: rgba(15, 23, 42, .06); }
* { box-sizing: border-box; }
.task-progress-card { margin-top: 16px; padding: 16px; border: 1px solid var(--line); border-radius: 12px; background: var(--panel); }
.task-progress-card h4 { margin: 12px 0 6px; }
.task-progress-card p, .task-progress-card .list { margin: 6px 0; }
.task-progress-card .task-action-unavailable { color: var(--danger); }
.task-progress-command { display: block; width: 100%; min-width: 0; margin: 8px 0; font-family: monospace; white-space: pre; }
body { margin: 0; font-family: Arial, Helvetica, sans-serif; color: var(--ink); background: var(--surface); }
header { padding: 14px 22px 12px; border-bottom: 1px solid var(--line); background: var(--surface-subtle); }
h1 { margin: 0 0 6px; font-size: 24px; line-height: 1.2; letter-spacing: 0; }
h2 { margin: 0; font-size: 18px; line-height: 1.25; letter-spacing: 0; }
h3 { margin: 0 0 8px; font-size: 15px; line-height: 1.3; letter-spacing: 0; }
p { margin: 0; }
button, input, select { font: inherit; }
button { display: inline-flex; align-items: center; justify-content: center; border: 1px solid var(--line); background: var(--surface); color: var(--ink); border-radius: 6px; padding: 7px 10px; min-height: 34px; line-height: 1.15; text-align: center; cursor: pointer; }
button:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); }
button:disabled { cursor: not-allowed; color: var(--muted); background: var(--surface-disabled); }
input, select { min-height: 34px; border: 1px solid var(--line); border-radius: 6px; padding: 6px 8px; background: var(--surface); color: var(--ink); }
code, pre { font-family: Consolas, "Courier New", monospace; }
pre { white-space: pre-wrap; word-break: break-word; overflow: auto; max-height: 70vh; padding: 10px; background: var(--code-bg); color: var(--code-ink); border-radius: 6px; }
.header-row { display: flex; justify-content: space-between; align-items: flex-start; gap: 18px; }
.meta { display: flex; flex-wrap: wrap; gap: 8px 14px; color: var(--muted); font-size: 13px; }
.header-notice { max-width: 980px; margin-top: 5px; color: var(--accent-ink); font-size: 13px; line-height: 1.35; overflow-wrap: anywhere; }
.top-controls { display: flex; flex-wrap: wrap; justify-content: flex-end; align-items: flex-start; gap: 10px; flex: 0 1 auto; width: auto; min-width: 0; }
.language-compact { display: flex; align-items: center; justify-content: flex-end; gap: 8px; width: auto; min-width: 0; color: var(--muted); font-size: 13px; }
.language-icon { flex: 0 0 auto; font-size: 18px; line-height: 1; }
.language-compact .visually-hidden { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
.language-compact select { flex: 1 1 140px; width: auto; min-width: 140px; max-width: 220px; }
.session-compact { display: flex; flex-direction: column; align-items: stretch; gap: 8px; flex: 0 0 304px; width: 304px; max-width: 100%; min-height: auto; margin-left: 0; padding: 8px 10px; border: 1px solid var(--line); border-radius: 6px; background: var(--surface); font-size: 13px; }
.session-status-line { width: 100%; line-height: 1.35; white-space: normal; font-variant-numeric: tabular-nums; }
.session-action-row { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 7px; }
.session-compact strong { color: var(--ink); }
.session-compact button { width: 100%; min-height: 28px; padding: 4px 10px; }
.session-warning { color: var(--warn); font-weight: 700; }
.session-stopping { color: var(--danger); font-weight: 700; }
nav { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 10px 12px; padding: 10px 22px 0; border-bottom: 1px solid var(--line); background: var(--surface-subtle); }
.tab-buttons { display: flex; flex: 1 1 100%; flex-wrap: wrap; gap: 8px; width: 100%; min-width: 0; overflow: visible; }
.tab-buttons button { flex: 0 1 auto; width: auto; min-width: 118px; max-width: 200px; border-bottom-left-radius: 0; border-bottom-right-radius: 0; border-bottom-color: transparent; white-space: nowrap; text-overflow: ellipsis; overflow: hidden; }
.tab-buttons button.active { color: var(--on-accent); background: var(--ok); border-color: var(--ok); }
main { padding: 16px 22px 26px; }
.tab[hidden] { display: none; }
.notice, .warnings, .panel { border: 1px solid var(--line); border-radius: 8px; background: var(--surface); }
.notice { padding: 12px; margin-bottom: 12px; background: var(--accent-soft); color: var(--accent-ink); }
.warnings { padding: 12px; margin-bottom: 12px; background: var(--warn-soft-subtle); color: var(--warn); }
.panel { overflow: hidden; }
.panel-head { padding: 12px 14px; border-bottom: 1px solid var(--line); background: var(--panel); }
.detail { padding: 14px; }
.tasks-layout { display: grid; grid-template-columns: minmax(460px, 1fr) minmax(380px, .8fr); gap: 14px; align-items: start; }
.task-list-panel, .task-detail-panel { min-width: 0; }
.toolbar { display: grid; grid-template-columns: minmax(160px, 1fr) minmax(120px, 170px) minmax(120px, 170px); gap: 8px; }
.overview { display: grid; grid-template-columns: repeat(5, minmax(120px, 1fr)); gap: 8px; margin-bottom: 12px; }
.table-wrap { overflow: auto; }
.task-list-panel table { table-layout: fixed; }
.task-list-panel th:nth-child(1) { width: 118px; }
.task-list-panel th:nth-child(2) { width: 118px; }
.task-list-panel th:nth-child(3) { width: 82px; }
.task-list-panel th:nth-child(4) { width: 132px; }
.task-list-panel th:nth-child(5) { width: auto; }
.task-list-panel th:nth-child(6) { width: 102px; }
.task-list-panel th:nth-child(7) { width: 150px; }
.task-list-panel td:nth-child(2), .task-list-panel td:nth-child(3) { padding-left: 6px; padding-right: 6px; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th, td { text-align: left; padding: 9px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
th { background: var(--panel); color: var(--ink-secondary); position: sticky; top: 0; z-index: 1; }
tr.selected { background: var(--accent-soft); }
.task-id { font-weight: 700; color: var(--accent); }
.badge { display: inline-flex; align-items: center; justify-content: center; min-width: 72px; min-height: 24px; padding: 3px 7px; border-radius: 999px; background: var(--neutral-soft); font-size: 12px; font-weight: 700; white-space: normal; text-align: center; line-height: 1.15; }
.task-list-panel .badge { width: 100%; }
.status-DONE { background: var(--ok-soft); color: var(--ok-ink); }
.status-TODO { background: var(--info-soft); color: var(--info-ink); }
.status-IN_PROGRESS, .status-IN_REVIEW { background: var(--warn-soft); color: var(--warn-ink); }
.status-BLOCKED { background: var(--danger-bg); color: var(--danger); }
.priority-P1 { background: var(--danger-soft); color: var(--danger-ink); }
.priority-P2 { background: var(--warn-soft); color: var(--warn-ink); }
.priority-P3 { background: var(--accent-soft); color: var(--accent-ink); }
.data-full { background: var(--ok-soft); color: var(--ok); }
.data-compact { background: var(--neutral-soft); color: var(--ink-secondary); }
.data-blockers { background: var(--danger-bg); color: var(--danger); }
.empty { color: var(--muted); }
.error { color: var(--danger); }
.metrics { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; margin: 12px 0; }
.metric { min-height: 50px; padding: 8px; background: var(--panel); border: 1px solid var(--line); border-radius: 6px; }
.metric span { display: block; color: var(--muted); font-size: 12px; margin-bottom: 4px; }
.metric strong { overflow-wrap: anywhere; }
.quality-gate-summary { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; margin: 0 0 14px; }
.quality-gate-block { margin-top: 14px; }
.quality-gate-detail .workflow-table { overflow-x: auto; }
.quality-gate-detail .quality-gate-rule-table table { min-width: 1120px; table-layout: fixed; }
.quality-gate-detail .quality-gate-rule-table th:nth-child(1) { width: 13%; }
.quality-gate-detail .quality-gate-rule-table th:nth-child(2) { width: 9%; }
.quality-gate-detail .quality-gate-rule-table th:nth-child(3) { width: 10%; }
.quality-gate-detail .quality-gate-rule-table th:nth-child(4) { width: 14%; }
.quality-gate-detail .quality-gate-rule-table th:nth-child(5) { width: 20%; }
.quality-gate-detail .quality-gate-rule-table th:nth-child(6) { width: 9%; }
.quality-gate-detail .quality-gate-rule-table th:nth-child(7) { width: 12%; }
.quality-gate-detail .quality-gate-rule-table th:nth-child(8) { width: 13%; min-width: 150px; }
.quality-gate-rule-table th, .quality-gate-rule-table td { overflow-wrap: anywhere; }
.quality-gate-rule-table th:nth-child(8), .quality-gate-rule-table td.quality-gate-rule-actions { position: sticky; right: 0; background: var(--surface); box-shadow: -1px 0 0 var(--line); z-index: 1; }
.quality-gate-rule-table th:nth-child(8) { z-index: 2; }
.quality-gate-rule-table code { white-space: normal; overflow-wrap: anywhere; }
.quality-gate-rule-table input, .quality-gate-rule-table select { width: 100%; min-width: 0; }
.quality-gate-rule-table input[type="checkbox"] { width: 16px; height: 16px; min-height: 0; padding: 0; }
.quality-gate-scope-control { display: grid; grid-template-columns: 18px minmax(0, 1fr); gap: 6px; align-items: center; line-height: 1.25; }
.quality-gate-rule-table .setting-buttons { margin-top: 0; }
.quality-gate-rule-table .setting-buttons button { flex: 1 1 68px; width: auto; min-width: 0; }
.quality-gate-rule-active { background: var(--ok-soft-alt); color: var(--ok-ink-alt); }
.quality-gate-rule-disabled { background: var(--neutral-soft-alt); color: var(--neutral-ink); }
.quality-gate-rule-locally_edited { background: var(--warn-soft-alt); color: var(--warn-ink-alt); }
.quality-gate-rule-deleted { background: var(--danger-soft-alt); color: var(--danger-ink-alt); }
.quality-gate-rule-new { background: var(--info-soft-alt); color: var(--info-ink-alt); }
.quality-gate-evidence-summary { margin: 8px 0; color: var(--muted); }
.quality-gate-items { margin: 6px 0 0; padding-left: 18px; }
.quality-gate-items li { margin: 2px 0; overflow-wrap: anywhere; }
.quality-gate-evidence-current, .quality-gate-effect-passed, .quality-gate-effect-helped { background: var(--ok-soft-alt); color: var(--ok-ink-alt); }
.quality-gate-evidence-stale, .quality-gate-effect-stale, .quality-gate-effect-warned { background: var(--warn-soft-alt); color: var(--warn-ink-alt); }
.quality-gate-evidence-missing, .quality-gate-effect-missing, .quality-gate-effect-disabled, .quality-gate-effect-skipped_cadence { background: var(--neutral-soft-alt); color: var(--neutral-ink); }
.quality-gate-evidence-invalid, .quality-gate-effect-invalid, .quality-gate-effect-required_rework { background: var(--danger-soft-alt); color: var(--danger-ink-alt); }
.profiles-detail { display: grid; gap: 14px; }
.profile-add-row { display: grid; grid-template-columns: minmax(130px, 1fr) minmax(130px, 1fr) minmax(180px, 1.5fr) minmax(90px, .5fr) minmax(104px, auto); gap: 8px; align-items: end; padding: 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--accent-soft-subtle); }
.profile-add-row label, .profile-fields label, .profile-policy-grid label, .profile-finding-policy label, .profile-delta-review label { display: grid; gap: 5px; min-width: 0; color: var(--muted); font-size: 12px; }
.profile-add-row input, .profile-add-row select, .profile-fields input, .profile-fields select, .profile-policy-grid select, .profile-finding-policy select { width: 100%; min-width: 0; }
.profile-section { display: grid; gap: 10px; margin-top: 14px; }
.profile-tab-groups { display: grid; gap: 10px; min-width: 0; }
.profile-tab-group { display: grid; gap: 7px; min-width: 0; }
.profile-tab-list { display: flex; flex-wrap: wrap; gap: 8px; min-width: 0; }
.profile-tab-button { flex: 1 1 168px; flex-direction: column; align-items: flex-start; justify-content: center; gap: 5px; width: auto; max-width: 260px; min-width: 0; min-height: 56px; text-align: left; white-space: normal; overflow-wrap: anywhere; }
.profile-tab-button.active { border-color: var(--accent); background: var(--accent-soft); color: var(--ink); box-shadow: inset 0 0 0 1px var(--accent); }
.profile-tab-name { font-weight: 700; overflow-wrap: anywhere; }
.profile-tab-badges { display: flex; flex-wrap: wrap; gap: 4px; min-width: 0; }
.profile-tab-badges .badge { min-width: 0; min-height: 20px; padding: 2px 6px; }
.profile-selected-panel { display: grid; gap: 10px; min-width: 0; }
.profile-card { display: grid; gap: 10px; min-width: 0; padding: 12px; border: 1px solid var(--line); border-radius: 8px; background: var(--surface); }
.profile-card-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; min-width: 0; }
.profile-card h3 { margin: 0; overflow-wrap: anywhere; }
.profile-card-meta { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
.profile-card-actions, .profile-card-footer { display: flex; flex-wrap: wrap; gap: 8px; justify-content: flex-end; }
.profile-card-actions button, .profile-card-footer button, .profile-add-row button { min-width: 112px; width: auto; }
.profile-fields { display: grid; grid-template-columns: minmax(160px, 1fr) minmax(90px, 140px); gap: 8px; }
.profile-policy-grid { display: grid; grid-template-columns: repeat(3, minmax(150px, 1fr)); gap: 8px; }
.profile-policy-grid label { padding: 8px; border: 1px solid var(--line); border-radius: 6px; background: var(--surface-subtle); }
.profile-policy-grid span { color: var(--ink); font-weight: 700; overflow-wrap: anywhere; }
.profile-policy-grid label.profile-policy-required { border-color: var(--ok-line); background: var(--ok-soft-alt); }
.profile-policy-grid label.profile-policy-auto { border-color: var(--info-line); background: var(--info-soft-subtle); }
.profile-policy-grid label.profile-policy-disabled { border-color: var(--neutral-line); background: var(--neutral-soft-alt); }
.profile-policy-grid label.profile-policy-disabled span { color: var(--muted); }
.profile-policy-grid label.profile-policy-required select { border-color: var(--ok-line-strong); }
.profile-policy-grid label.profile-policy-auto select { border-color: var(--info-line-strong); }
.profile-policy-grid label.profile-policy-disabled select { border-color: var(--neutral-line-strong); color: var(--muted); }
.review-catalog-section { display: grid; gap: 12px; padding-top: 14px; border-top: 1px solid var(--line); }
.review-catalog-summary, .review-catalog-lane-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
.review-catalog-summary h3, .review-catalog-lane h4 { margin: 0; }
.review-catalog-lanes { display: grid; gap: 10px; }
.review-catalog-lane { display: grid; gap: 10px; padding: 11px; border: 1px solid var(--line); border-radius: 8px; background: var(--surface); }
.review-catalog-lane-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 7px; }
.review-catalog-lane-grid > div { display: grid; gap: 4px; min-width: 0; padding: 7px; border: 1px solid var(--line); border-radius: 6px; background: var(--panel); }
.review-catalog-lane-grid code { overflow-wrap: anywhere; }
.review-catalog-controls { display: grid; grid-template-columns: minmax(150px, 1fr) auto minmax(180px, 1fr) auto; gap: 8px; align-items: end; }
.review-catalog-controls label, .review-catalog-definition-fields label { display: grid; gap: 5px; min-width: 0; color: var(--muted); font-size: 12px; }
.review-catalog-definition-fields { display: grid; grid-template-columns: repeat(4, minmax(150px, 1fr)); gap: 8px; margin-top: 9px; }
.review-catalog-definition-fields input, .review-catalog-definition-fields select, .review-catalog-controls input, .review-catalog-controls select { width: 100%; min-width: 0; }
.review-catalog-preview-diff { margin-top: 8px; }
.review-catalog-preview-diff ol { display: grid; gap: 8px; margin: 7px 0 0; padding-left: 22px; }
.review-catalog-preview-diff pre { max-height: 220px; margin-top: 5px; }
.profile-delta-review { display: grid; gap: 10px; min-width: 0; margin: 0; padding: 10px; border: 1px solid var(--line); border-radius: 8px; }
.profile-delta-review legend { padding: 0 6px; font-weight: 800; }
.profile-delta-review-help { margin: 0; }
.profile-delta-review-grid { display: grid; grid-template-columns: repeat(3, minmax(150px, 1fr)); gap: 8px; }
.profile-delta-review-grid label { display: flex; align-items: center; gap: 8px; padding: 8px; border: 1px solid var(--line); border-radius: 6px; background: var(--surface-subtle); color: var(--ink); font-weight: 700; }
.profile-delta-review-grid label.profile-delta-enabled { border-color: var(--info-line-strong); background: var(--info-soft-subtle); }
.profile-delta-review-grid label.profile-delta-disabled { color: var(--muted); background: var(--neutral-soft-alt); }
.profile-delta-review-grid input { flex: 0 0 auto; width: auto; }
.profile-delta-review-diagnostics ul { margin-bottom: 0; }
.profile-finding-policy { display: grid; gap: 10px; min-width: 0; margin: 0; padding: 10px; border: 1px solid var(--line); border-radius: 8px; }
.profile-finding-policy legend { padding: 0 6px; font-weight: 800; }
.profile-finding-policy-help { margin: 0; }
.profile-finding-policy-toolbar { display: grid; grid-template-columns: minmax(130px, 1fr) minmax(150px, 1fr) auto auto; gap: 8px; align-items: end; }
.profile-finding-policy-grid { display: grid; grid-template-columns: repeat(5, minmax(130px, 1fr)); gap: 8px; }
.profile-finding-policy-grid label { padding: 8px; border: 1px solid var(--line); border-radius: 6px; background: var(--surface-subtle); }
.profile-finding-policy-grid span, .profile-finding-policy-toolbar span { color: var(--ink); font-weight: 700; overflow-wrap: anywhere; }
.profile-finding-policy-grid .profile-finding-critical { border-color: var(--danger-line); background: var(--danger-soft-subtle); }
.profile-finding-policy-grid .profile-finding-critical select { border-color: var(--danger-line-strong); font-weight: 700; }
.profile-source-built-in { background: var(--info-soft); color: var(--info-ink); }
.profile-source-user { background: var(--ok-soft-alt); color: var(--ok-ink-alt); }
.profile-active { background: var(--sky-soft); color: var(--sky-ink); }
.kv { width: 100%; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
.kv div { display: grid; grid-template-columns: minmax(160px, .35fr) 1fr; border-bottom: 1px solid var(--line); }
.kv div:last-child { border-bottom: 0; }
.kv span, .kv strong { padding: 8px 10px; overflow-wrap: anywhere; }
.kv span { color: var(--muted); background: var(--panel); }
.list { margin: 8px 0 0; padding-left: 18px; }
.artifact-ok { color: var(--blue); }
.artifact-missing { color: var(--muted); }
.blocker-alert { padding: 10px; border: 1px solid var(--danger-line-alt); border-radius: 6px; background: var(--danger-bg); color: var(--danger); font-weight: 700; }
.task-command-list { display: grid; gap: 10px; margin-top: 8px; }
.task-command-card { display: grid; gap: 7px; padding: 10px; border: 1px solid var(--line); border-left: 4px solid var(--info-line-subtle); border-radius: 8px; background: var(--surface); }
.task-command-card p { color: var(--muted); }
.task-section-title { margin-top: 20px; }
.task-command-buttons { display: flex; flex-wrap: wrap; gap: 8px; }
.task-action-status { margin: 10px 0; }
.task-action-unavailable { color: var(--muted); font-size: 12px; }
.instruction-links { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
.instruction-links button { flex: 0 0 136px; width: 136px; }
.tab-head, .workflow-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
.config-path { color: var(--muted); font-size: 12px; overflow-wrap: anywhere; text-align: right; }
.tab-body { padding: 14px; }
.tab-messages { margin-bottom: 12px; }
.tab-messages[hidden] { display: none !important; }
.workflow-state { margin: 0; padding: 8px 10px; border-left: 4px solid var(--accent); background: var(--accent-soft-alt); color: var(--accent-ink); }
.setting-status:empty, .action-status:empty { display: none; margin: 0; padding: 0; }
.setting-status:not(:empty) { margin-bottom: 12px; }
.tab-body > .workflow-group:first-child,
#settings-editor > .workflow-group:first-child { margin-top: 0; }
.workflow-group { margin-top: 16px; }
.cleanup-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; margin-top: 12px; }
.cleanup-section { display: grid; gap: 8px; min-width: 0; }
.cleanup-section:first-child { grid-column: 1 / -1; }
.cleanup-policy-list { display: grid; grid-template-columns: repeat(2, minmax(220px, 1fr)); gap: 8px; }
.cleanup-policy-list div { display: grid; grid-template-columns: minmax(150px, .45fr) minmax(0, 1fr); gap: 8px; align-items: start; padding: 8px 10px; border: 1px solid var(--line); border-radius: 6px; background: var(--surface); }
.cleanup-policy-list span { color: var(--muted); }
.cleanup-policy-list code { overflow-wrap: anywhere; }
.cleanup-form { display: grid; gap: 9px; }
.cleanup-form label { display: grid; gap: 5px; color: var(--muted); font-size: 13px; }
.cleanup-form label:has(input[type="checkbox"]) { grid-template-columns: 20px 1fr; align-items: center; color: var(--ink); }
.workflow-table, .instruction-table, .action-table, .value-table, .memory-table { border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
.workflow-table table, .instruction-table table, .action-table table, .value-table table, .memory-table table { table-layout: fixed; }
.workflow-table th:nth-child(1) { width: 23%; }
.workflow-table th:nth-child(2) { width: 27%; }
.workflow-table th:nth-child(3) { width: 14%; }
.workflow-table th:nth-child(4) { width: 18%; }
.workflow-table th:nth-child(5) { width: 18%; }
.backups-table .workflow-table { overflow-x: auto; }
.backups-table .workflow-table th:nth-child(1) { width: 26%; }
.backups-table .workflow-table th:nth-child(2) { width: 18%; }
.backups-table .workflow-table th:nth-child(3) { width: 8%; }
.backups-table .workflow-table th:nth-child(4) { width: 10%; }
.backups-table .workflow-table th:nth-child(5) { width: 14%; }
.backups-table .workflow-table th:nth-child(6) { width: 24%; }
.backups-table .workflow-table td:last-child .action-buttons { margin-top: 0; }
.backups-table .workflow-table td:last-child .empty { display: block; line-height: 1.35; }
.cleanup-settings-table th:nth-child(1) { width: 22%; }
.cleanup-settings-table th:nth-child(2) { width: 28%; }
.cleanup-settings-table th:nth-child(3) { width: 16%; }
.cleanup-settings-table th:nth-child(4) { width: 34%; }
.cleanup-settings-table td:last-child .setting-buttons { margin-top: 6px; }
.cleanup-run-options { display: grid; grid-template-columns: repeat(3, minmax(120px, 1fr)); gap: 8px; margin-top: 8px; }
.cleanup-progress-panel { max-width: 720px; }
.cleanup-progress { display: block; width: 100%; height: 12px; accent-color: var(--accent); }
.cleanup-settings-table .setting-control select,
.cleanup-settings-table .setting-control input[type="number"],
.cleanup-settings-table .setting-control input[type="text"] { width: 100%; max-width: 220px; min-height: 34px; }
.cleanup-settings-table .cleanup-checkbox-control { align-content: end; grid-template-columns: 18px minmax(0, 1fr); align-items: center; color: var(--ink); }
.cleanup-settings-table .cleanup-checkbox-control input[type="checkbox"] { width: 16px; height: 16px; min-height: 0; }
.workflow-table tbody tr:nth-child(even), .instruction-table tbody tr:nth-child(even), .action-table tbody tr:nth-child(even) { background: var(--surface-subtle); }
.workflow-table td:first-child, .instruction-table td:first-child, .action-table td:first-child { border-left: 4px solid var(--info-line-subtle); background: var(--surface-cool); }
.setting-title { display: grid; gap: 4px; }
.setting-parameter { color: var(--muted); font-size: 12px; }
.description-cell { line-height: 1.45; }
.option-list { display: grid; gap: 6px; }
.option-item { display: grid; gap: 3px; padding: 6px; border-left: 3px solid var(--info-line-subtle); background: var(--surface-cool); }
.option-item code { color: var(--blue); }
.current-value { display: inline-block; max-width: 100%; white-space: normal; overflow-wrap: anywhere; }
.setting-control { display: grid; gap: 6px; min-width: 150px; }
.enum-list-control { display: grid; gap: 5px; max-height: 180px; overflow: auto; padding: 6px; border: 1px solid var(--line); border-radius: 6px; background: var(--surface); }
.enum-list-control label { display: grid; grid-template-columns: 18px 1fr; gap: 6px; align-items: start; font-size: 12px; line-height: 1.35; }
.setting-note { margin-top: 6px; color: var(--muted); font-size: 12px; line-height: 1.4; }
.setting-parameter { color: var(--muted); font-size: 12px; margin-bottom: 8px; }
.setting-options { margin: 8px 0; }
.setting-options li { margin-bottom: 5px; }
.setting-buttons, .action-buttons, .switch-buttons { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
.setting-buttons button, .action-buttons button, .switch-buttons button, #tasks button[data-task-id] { flex: 0 0 138px; width: 138px; height: 42px; overflow: hidden; }
.setting-status, .action-status { margin-top: 0; }
.action-section { margin-top: 12px; }
.action-table th:nth-child(1) { width: 20%; }
.action-table th:nth-child(2) { width: 30%; }
.action-table th:nth-child(3) { width: 14%; }
.action-table th:nth-child(4) { width: 20%; }
.action-table th:nth-child(5) { width: 16%; }
.action-kind { display: inline-flex; margin-top: 6px; min-width: 138px; min-height: 32px; align-items: center; justify-content: center; padding: 2px 7px; border-radius: 999px; background: var(--panel); color: var(--muted); font-size: 12px; font-weight: 700; text-align: center; }
.action-kind.mutates { background: var(--warn-soft); color: var(--warn-ink); }
.command-cell code, .description-cell code { background: var(--code-inline-bg); color: var(--blue); border: 1px solid var(--info-line-subtle); border-radius: 4px; padding: 1px 4px; }
.command-preview { border-bottom: 1px solid var(--line); background: var(--accent-soft-subtle); }
.command-preview-panel { display: grid; gap: 8px; max-width: 980px; }
.command-preview-panel h3 { color: var(--accent); }
.command-preview-main { padding: 9px 10px; border: 1px solid var(--accent-line); border-radius: 6px; background: var(--surface); overflow-wrap: anywhere; }
.command-preview-meta { display: grid; grid-template-columns: repeat(3, minmax(120px, 1fr)); gap: 8px; }
.command-preview-meta span { display: grid; gap: 3px; padding: 7px; background: var(--surface); border: 1px solid var(--line); border-radius: 6px; color: var(--muted); }
.command-preview-meta code { color: var(--ink); }
.instruction-table th:nth-child(1) { width: 24%; }
.instruction-table th:nth-child(2) { width: 76%; }
.value-table th:nth-child(1) { width: 25%; }
.value-table th:nth-child(2) { width: 45%; }
.value-table th:nth-child(3) { width: 30%; }
.memory-table th:nth-child(1) { width: 34%; }
.memory-table th:nth-child(2) { width: 46%; }
.memory-table th:nth-child(3) { width: 20%; }
.memory-section { margin-top: 16px; }
.memory-advisory { margin-top: 0; padding: 10px; border-left: 4px solid var(--accent); background: var(--accent-soft-subtle); }
.memory-advisory p { color: var(--muted); line-height: 1.45; }
.memory-prompt-path { margin-top: 8px; overflow-wrap: anywhere; }
.memory-file-content { margin-top: 10px; }
.memory-file-content h3 { margin-top: 18px; }
.memory-file-content pre { max-height: 55vh; }
.file-open-row { margin-top: 7px; }
.file-open-row button { min-width: 104px; }
.value-with-open { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 6px; max-width: 100%; }
button.file-open-inline, .file-open-inline { min-width: auto; width: auto; min-height: 24px; padding: 2px 8px; font-size: 12px; line-height: 1.2; }
.system-state-panel { margin-bottom: 14px; }
.system-state-panel:empty { display: none; margin: 0; }
.system-health-summary { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 12px; margin-bottom: 12px; border: 1px solid var(--line); border-left: 4px solid var(--accent); border-radius: 8px; background: var(--accent-soft-subtle); }
.system-health-summary p { margin-top: 4px; line-height: 1.4; }
.system-health-summary .badge { flex: 0 0 auto; min-width: 120px; }
.system-inline-details { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; margin-bottom: 12px; }
.system-inline-details span { padding: 8px 10px; border: 1px solid var(--line); border-radius: 6px; background: var(--surface); color: var(--muted); overflow-wrap: anywhere; }
.system-signal-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; margin-bottom: 14px; }
.system-signal { display: grid; gap: 6px; padding: 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--surface); }
.system-signal > div:first-child { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.system-signal p { color: var(--muted); line-height: 1.4; }
.system-signal code { overflow-wrap: anywhere; }
.system-config-files { margin-top: 12px; }
.ordinary-doc-row { display: grid; grid-template-columns: 20px 1fr; gap: 8px; align-items: start; }
.duration-control { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
.duration-control label { display: grid; gap: 3px; color: var(--muted); font-size: 12px; }
.duration-help { display: block; color: var(--muted); font-size: 12px; margin-top: 4px; }
.modal-backdrop { position: fixed; inset: 0; z-index: 20; display: grid; place-items: center; padding: 24px; background: var(--backdrop); }
.modal-backdrop[hidden] { display: none; }
.modal { width: min(960px, 96vw); max-height: 88vh; display: grid; grid-template-rows: auto 1fr; border-radius: 8px; border: 1px solid var(--line); background: var(--surface); box-shadow: 0 20px 80px var(--shadow-strong); overflow: hidden; }
.modal-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 14px; border-bottom: 1px solid var(--line); background: var(--panel); }
.modal-body { padding: 14px; overflow: auto; }
.plan-meta { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; margin-bottom: 12px; }
.plan-meta div { padding: 8px; border: 1px solid var(--line); border-radius: 6px; background: var(--panel); }
.plan-meta span { display: block; color: var(--muted); font-size: 12px; margin-bottom: 3px; }
.plan-content { color: var(--ink); background: var(--surface); border: 1px solid var(--line); max-height: none; }
.switch-strip { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 12px; margin-bottom: 12px; border: 1px solid var(--line); border-radius: 8px; background: var(--accent-soft-subtle); }
.switch-strip > div { min-width: 0; }
.switch-strip p { margin-top: 3px; color: var(--muted); font-size: 13px; }
.switch-strip .badge { margin-left: 6px; }
.switch-strip .badge { min-width: 156px; }
@media (max-width: 1060px) { .tasks-layout { grid-template-columns: 1fr; } .header-row { display: grid; grid-template-columns: 1fr 180px; } }
@media (max-width: 1160px) { nav { flex-wrap: wrap; } .session-compact { margin-left: 0; } }
@media (max-width: 1060px) { .profile-add-row, .profile-policy-grid, .profile-delta-review-grid, .profile-finding-policy-grid, .profile-finding-policy-toolbar, .review-catalog-definition-fields, .review-catalog-lane-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 860px) { .command-preview-meta, .cleanup-grid, .cleanup-policy-list, .plan-meta, .system-inline-details, .system-signal-grid, .profile-add-row, .profile-policy-grid, .profile-delta-review-grid, .profile-fields, .profile-finding-policy-grid, .profile-finding-policy-toolbar, .review-catalog-definition-fields, .review-catalog-lane-grid, .review-catalog-controls { grid-template-columns: 1fr; } .cleanup-section:first-child { grid-column: auto; } .system-health-summary { flex-direction: column; } .profile-card-head, .review-catalog-lane-head { flex-direction: column; } .profile-card-actions { justify-content: flex-start; } }
@media (max-width: 760px) { .overview { grid-template-columns: repeat(2, minmax(120px, 1fr)); } .toolbar { grid-template-columns: 1fr; } .session-compact { flex: 1 1 100%; max-width: none; width: 100%; min-width: 0; margin-left: 0; } .switch-strip { align-items: flex-start; flex-direction: column; } }
@media (max-width: 640px) { header, main, nav { padding-left: 14px; padding-right: 14px; } th, td { padding: 8px; } .tab-buttons { flex: 1 1 100%; width: 100%; } .metrics, .quality-gate-summary { grid-template-columns: 1fr; } .header-row { grid-template-columns: 1fr; } .top-controls { justify-content: flex-end; justify-self: end; } }`;
