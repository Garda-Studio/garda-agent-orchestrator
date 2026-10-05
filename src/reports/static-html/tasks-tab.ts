import { escapeHtml, formatDuration, formatNumber } from './common';
import type { ReportTaskRow } from '../report-data-contract';

export function renderTaskRow(task: ReportTaskRow, index: number): string {
    const stats = task.detail.stats;
    const eventCount = task.detail.detail_status === 'skipped'
        ? task.activity_summary?.lifecycle_event_count
        : stats?.events_count;
    return [
        `<tr data-task-index="${index}" tabindex="0">`,
        `<td><span class="task-id">${escapeHtml(task.task_id)}</span></td>`,
        `<td>${escapeHtml(task.status_token || task.status)}</td>`,
        `<td>${escapeHtml(task.priority)}</td>`,
        `<td>${escapeHtml(task.area)}</td>`,
        `<td>${escapeHtml(task.title)}</td>`,
        `<td>${escapeHtml(task.profile)}</td>`,
        `<td>${eventCount === undefined || eventCount === null ? 'skipped' : formatNumber(eventCount)}</td>`,
        `<td>${task.detail.detail_status === 'skipped' ? 'skipped' : formatDuration(stats?.wall_clock_seconds)}</td>`,
        '</tr>'
    ].join('');
}

export function renderTaskDetailTemplate(): string {
    return [
        '<template id="task-detail-template">',
        '<section class="detail">',
        '<div class="detail-head">',
        '<div>',
        '<p class="eyebrow">Task</p>',
        '<h2 data-field="title"></h2>',
        '</div>',
        '<span class="pill" data-field="status"></span>',
        '</div>',
        '<div class="metrics">',
        '<div data-metric="events"></div>',
        '<div data-metric="passes"></div>',
        '<div data-metric="fails"></div>',
        '<div data-metric="reviews"></div>',
        '<div data-metric="changed"></div>',
        '<div data-metric="duration"></div>',
        '<div data-metric="full-suite-state"></div>',
        '<div data-metric="full-suite-duration"></div>',
        '</div>',
        '<div class="detail-grid">',
        '<section>',
        '<h3>Full-suite Validation</h3>',
        '<div data-field="full-suite"></div>',
        '</section>',
        '<section>',
        '<h3>Quality Checklist</h3>',
        '<div data-field="quality-checklist"></div>',
        '</section>',
        '<section>',
        '<h3>Latest Cycle</h3>',
        '<pre data-field="latest-cycle"></pre>',
        '</section>',
        '<section>',
        '<h3>Artifacts</h3>',
        '<ul data-field="artifacts"></ul>',
        '</section>',
        '</div>',
        '<section>',
        '<h3>Unavailable</h3>',
        '<ul data-field="unavailable"></ul>',
        '</section>',
        '</section>',
        '</template>'
    ].join('');
}

export function renderTasksPanel(rows: ReportTaskRow[]): string {
    return [
        '<section class="panel active" id="tab-tasks" role="tabpanel">',
        '<p class="notice">Static HTML report: read-only snapshot. Task details load from embedded report data; restore and workflow actions require <code>garda ui</code>.</p>',
        '<div class="task-layout">',
        '<div class="table-wrap">',
        '<table>',
        '<thead><tr><th>ID</th><th>Status</th><th>Priority</th><th>Area</th><th>Title</th><th>Profile</th><th>Events</th><th>Time</th></tr></thead>',
        `<tbody>${rows.map(renderTaskRow).join('')}</tbody>`,
        '</table>',
        '</div>',
        '<div id="task-detail"></div>',
        '</div>',
        '</section>'
    ].join('');
}

export const STATIC_HTML_TASK_CLIENT_SCRIPT = `
const tabs = Array.from(document.querySelectorAll('.tab'));
for (const tab of tabs) {
  tab.addEventListener('click', () => {
    for (const item of tabs) item.setAttribute('aria-selected', String(item === tab));
    const activePanel = document.getElementById('tab-' + tab.dataset.tab);
    for (const panel of document.querySelectorAll('.panel')) {
      const active = panel === activePanel;
      panel.classList.toggle('active', active);
      panel.hidden = !active;
    }
  });
}
function text(value) { return value === null || value === undefined || value === '' ? '-' : String(value); }
function toArtifactHref(pathValue) {
  const value = text(pathValue).replace(/\\\\/g, '/');
  if (/^[A-Za-z]:\\//.test(value)) return 'file:///' + encodeURI(value);
  if (value.startsWith('/')) return 'file://' + encodeURI(value);
  return '';
}
function metric(label, value) { return '<div class="metric"><span>' + safe(label) + '</span><strong>' + safe(value) + '</strong></div>'; }
function duration(seconds) {
  if (typeof seconds !== 'number') return '-';
  if (seconds < 60) return seconds + 's';
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? minutes + 'm' : minutes + 'm ' + rest + 's';
}
function fullSuiteDurationSeconds(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return '-';
  const roundedSeconds = Math.round(seconds * 10) / 10;
  if (roundedSeconds < 60) return roundedSeconds.toFixed(1).replace(/\\.0$/, '') + 's';
  const minutes = Math.floor(roundedSeconds / 60);
  const remainder = Math.round((roundedSeconds - minutes * 60) * 10) / 10;
  const remainderText = remainder.toFixed(1).replace(/\\.0$/, '');
  return remainder === 0 ? minutes + 'm' : minutes + 'm ' + remainderText + 's';
}
function fullSuiteForecastRows(forecast) {
  if (!forecast || typeof forecast !== 'object') return [];
  return [
    ['Configured timeout', fullSuiteDurationSeconds(forecast.configured_timeout_seconds)],
    ['Average duration', fullSuiteDurationSeconds(forecast.average_duration_seconds)],
    ['High-watermark duration', fullSuiteDurationSeconds(forecast.high_watermark_duration_seconds)],
    ['Recommended timeout', fullSuiteDurationSeconds(forecast.recommended_timeout_seconds)],
    ['Forecast excluded samples', Number.isFinite(Number(forecast.excluded_sample_count)) ? Number(forecast.excluded_sample_count) : 0],
    ['Forecast exclusion reasons', fullSuiteForecastExclusionReasonsText(forecast.excluded_sample_reasons)]
  ];
}
function fullSuiteForecastExclusionReasonsText(reasons) {
  if (!reasons || typeof reasons !== 'object') return '-';
  const entries = Object.entries(reasons).filter(([, count]) => Number(count) > 0);
  return entries.length > 0 ? entries.map(([reason, count]) => fullSuiteForecastExclusionReasonLabel(reason) + '=' + Number(count)).join(', ') : '-';
}
function fullSuiteForecastExclusionReasonLabel(reason) {
  const labels = {
    timed_out: 'timed-out runs',
    interrupted_or_cancelled: 'interrupted or cancelled runs',
    retry_contaminated: 'retry-contaminated runs',
    non_passing_status: 'non-passing runs',
    nonzero_exit: 'non-zero exit runs',
    invalid_duration: 'invalid durations',
    outlier_duration: 'outlier durations'
  };
  return labels[reason] || 'invalid durations';
}
function fullSuiteTimeoutAttemptsText(attempts) {
  if (!Array.isArray(attempts) || attempts.length === 0) return '-';
  return attempts.map(attempt => {
    const parts = ['#' + text(attempt && attempt.attempt)];
    if (attempt && attempt.timed_out) parts.push('timed out');
    if (attempt && attempt.cancelled) parts.push('cancelled');
    if (attempt && attempt.exit_code !== null && attempt.exit_code !== undefined) parts.push('exit code=' + attempt.exit_code);
    return parts.join(' ');
  }).join(', ');
}
function fullSuiteRepairTaskText(proposal) {
  if (!proposal || typeof proposal !== 'object') return '-';
  return [proposal.suggested_task_id, proposal.title].filter(Boolean).join(' - ') || '-';
}
function safe(value) {
  return text(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}
function fullSuiteRows(fullSuite) {
  if (!fullSuite) return '<p class="empty">-</p>';
  const rows = [
    ['Command', fullSuite.command],
    ['Placement', fullSuite.placement],
    ['Freshness', fullSuite.freshness],
    ['Timeout blocks task', fullSuite.timeout_blocker],
    ['Timeout retry count', fullSuite.timeout_retry_count],
    ['Timeout max attempts', fullSuite.timeout_max_attempts],
    ['Timeout attempts', fullSuiteTimeoutAttemptsText(fullSuite.timeout_attempts)],
    ['Timeout attempts exhausted', fullSuite.timeout_attempts_exhausted],
    ['Warning-only timeout continuation', fullSuite.timeout_warning_only_continuation],
    ['Timeout repair task proposal', fullSuiteRepairTaskText(fullSuite.timeout_repair_task_proposal)],
    ['Timeout forecast', fullSuite.timeout_forecast_label],
    ...fullSuiteForecastRows(fullSuite.timeout_forecast),
    ['Evidence artifact', fullSuite.artifact_path + (fullSuite.artifact_exists ? '' : ' (missing)')],
    ['Output artifact', fullSuite.output_artifact_path]
  ];
  const newline = String.fromCharCode(10);
  const summary = (fullSuite.compact_summary || []).length > 0
    ? '<h4>Summary</h4><pre>' + safe(fullSuite.compact_summary.join(newline)) + '</pre>'
    : '';
  const diagnostics = [fullSuite.mismatch_reason, ...(fullSuite.violations || []), ...(fullSuite.warnings || [])]
    .filter(Boolean);
  const diagnosticsList = diagnostics.length > 0
    ? '<ul class="list">' + diagnostics.map(item => '<li>' + safe(item) + '</li>').join('') + '</ul>'
    : '';
  return '<table><tbody>' + rows.map(([label, value]) => '<tr><th>' + safe(label) + '</th><td>' + safe(value) + '</td></tr>').join('') + '</tbody></table>' + summary + diagnosticsList;
}
function qualityChecklistList(items) {
  if (!Array.isArray(items) || items.length === 0) return '<span class="muted">-</span>';
  return '<ul>' + items.map(item => '<li>' + safe(item) + '</li>').join('') + '</ul>';
}
function qualityChecklistAnswers(answers) {
  if (!Array.isArray(answers) || answers.length === 0) return '';
  return '<h4>Rule answers</h4><ul>' + answers.map(answer => '<li><code>' + safe(answer.rule_id) + '</code> <strong>' + safe(answer.status) + '</strong><p class="meta">' + safe(answer.answer) + '</p></li>').join('') + '</ul>';
}
function qualityChecklistEffectLabel(effect) {
  const labels = {
    passed: 'Passed',
    helped: 'Helped',
    warned: 'Warned',
    required_rework: 'Required rework',
    disabled: 'Disabled',
    skipped_cadence: 'Skipped — not due yet',
    missing: 'Not checked',
    invalid: 'Invalid',
    stale: 'Stale'
  };
  return labels[effect] || effect;
}
function qualityChecklistRows(checklist) {
  const latest = checklist && checklist.latest ? checklist.latest : null;
  const history = checklist && Array.isArray(checklist.action_required_history) ? checklist.action_required_history : [];
  if (!latest && history.length === 0) return '<p class="meta">No quality checklist evidence for this task.</p>';
  const latestRows = latest ? [
    ['Status', latest.checklist_status],
    ['Evidence', latest.evidence_status],
    ['Effect', qualityChecklistEffectLabel(latest.effect)],
    ['Summary', latest.summary],
    ['Actions taken', latest.action_taken_count],
    ['Actions required', latest.action_required_count],
    ['Changed files', latest.changed_files_count],
    ['Artifact', latest.artifact_path]
  ] : [];
    const latestHtml = latest
      ? '<table><tbody>' + latestRows.map(([label, value]) => '<tr><th>' + safe(label) + '</th><td>' + safe(value) + '</td></tr>').join('') + '</tbody></table>'
      + (latest.stale_reasons && latest.stale_reasons.length > 0 ? '<h4>Diagnostics</h4>' + qualityChecklistList(latest.stale_reasons) : '')
      + (latest.actions_required && latest.actions_required.length > 0 ? '<h4>Actions required</h4>' + qualityChecklistList(latest.actions_required) : '')
      + (latest.actions_taken && latest.actions_taken.length > 0 ? '<h4>Actions taken</h4>' + qualityChecklistList(latest.actions_taken) : '')
      + qualityChecklistAnswers(latest.answers)
    : '';
  const historyHtml = history.length > 0
    ? '<h4>Action-required history</h4><ul>' + history.map(entry => '<li><code>' + safe(entry.timestamp_utc || '-') + '</code> ' + qualityChecklistList(entry.actions_required) + '</li>').join('') + '</ul>'
    : '';
  return latestHtml + historyHtml;
}
function renderList(items, formatter) {
  if (!items || items.length === 0) return '<li>none</li>';
  return items.map(formatter).join('');
}
function showTask(index) {
  const task = report.tasks_tab.rows[index];
  const stats = task.detail.stats || {};
  const template = document.getElementById('task-detail-template');
  const node = template.content.cloneNode(true);
  node.querySelector('[data-field="title"]').textContent = task.task_id + ' - ' + task.title;
  node.querySelector('[data-field="status"]').textContent = task.status_token || task.status;
  node.querySelector('[data-metric="events"]').innerHTML = metric('Events', stats.events_count);
  node.querySelector('[data-metric="passes"]').innerHTML = metric('Gate Pass', stats.gate_pass_count);
  node.querySelector('[data-metric="fails"]').innerHTML = metric('Gate Fail', stats.gate_fail_count);
  node.querySelector('[data-metric="reviews"]').innerHTML = metric('Reviews', (stats.required_reviews || []).join(', ') || '-');
  node.querySelector('[data-metric="changed"]').innerHTML = metric('Changed Lines', stats.changed_lines_total);
  node.querySelector('[data-metric="duration"]').innerHTML = metric('Wall Time', duration(stats.wall_clock_seconds));
  node.querySelector('[data-metric="full-suite-state"]').innerHTML = metric('Full-suite', task.detail.full_suite_validation && task.detail.full_suite_validation.state);
  node.querySelector('[data-metric="full-suite-duration"]').innerHTML = metric('Full-suite Duration', task.detail.full_suite_validation && task.detail.full_suite_validation.duration_human);
  node.querySelector('[data-field="full-suite"]').innerHTML = fullSuiteRows(task.detail.full_suite_validation);
  node.querySelector('[data-field="quality-checklist"]').innerHTML = qualityChecklistRows(task.detail.quality_checklist);
  node.querySelector('[data-field="latest-cycle"]').textContent = JSON.stringify(task.detail.latest_cycle_events || {}, null, 2);
  node.querySelector('[data-field="artifacts"]').innerHTML = renderList((task.detail.artifact_links || []).filter(item => item.exists).slice(0, 12), item => {
    const href = toArtifactHref(item.path);
    const pathText = safe(item.path);
    const link = href ? '<a href="' + safe(href) + '">' + pathText + '</a>' : pathText;
    return '<li><code>' + safe(item.kind) + '</code> ' + link + '</li>';
  });
  node.querySelector('[data-field="unavailable"]').innerHTML = renderList(task.detail.unavailable || [], item => '<li><strong>' + safe(item.scope) + '</strong>: ' + safe(item.reason) + '</li>');
  const detail = document.getElementById('task-detail');
  detail.replaceChildren(node);
  for (const row of document.querySelectorAll('tr[data-task-index]')) row.classList.toggle('selected', row.dataset.taskIndex === String(index));
}
for (const row of document.querySelectorAll('tr[data-task-index]')) {
  row.addEventListener('click', () => showTask(Number(row.dataset.taskIndex)));
  row.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') showTask(Number(row.dataset.taskIndex)); });
}
if (report.tasks_tab.rows.length > 0) showTask(0);
`.trim();
