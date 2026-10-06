import { MAX_TASK_FINAL_REPORT_BYTES } from '../task-final-report';

export const UI_DASHBOARD_CLIENT_TASK_FINAL_REPORT = `function taskFinalReportStateLabel(state) {
  return taskProgressText(['available', 'missing', 'pending', 'stale', 'legacy', 'unavailable'].includes(state) ? state : 'unavailable');
}
function taskReportSummary(detail) {
  const audit = detail.audit || {};
  const suite = detail.full_suite_validation || {};
  const files = Array.isArray(audit.changed_files) ? audit.changed_files : [];
  const timing = detail.progress && detail.progress.timing || {};
  return '<p>' + safe(t('statusColumn')) + ': ' + safe(audit.status || taskProgressText('unavailable')) + '</p>'
    + '<p>' + safe(t('fullSuiteSummary')) + ': ' + safe(suite.state || taskProgressText('unavailable')) + '</p>'
    + '<ul class="list">' + (suite.compact_summary || []).slice(0, 12).map(line => '<li>' + safe(line) + '</li>').join('') + '</ul>'
    + '<p>' + safe(t('qualityGateChangedFiles')) + ': ' + safe(files.length) + '</p><ul class="list">'
      + files.slice(0, 32).map(file => '<li><code>' + safe(file) + '</code></li>').join('') + '</ul>'
    + (files.length > 32 ? '<p>' + safe(taskProgressText('summaryTruncated')) + '</p>' : '')
    + (timing.first_event_utc ? '<p><time>' + safe(timing.first_event_utc) + '</time>'
      + (timing.last_event_utc ? ' — <time>' + safe(timing.last_event_utc) + '</time>' : '') + '</p>' : '')
    + (typeof reviewSummary === 'function' ? '<h4>' + safe(t('reviews')) + '</h4>' + reviewSummary(detail.audit) : '');
}
function taskFinalReportCard(detail) {
  const progress = detail.progress || {};
  const reference = progress.final_report || {};
  return '<section class="task-progress-card" aria-labelledby="task-final-report-title">'
    + '<h3 id="task-final-report-title">' + safe(taskProgressText('finalReport')) + '</h3>'
    + '<p>' + safe(taskProgressText('storedReportHelp')) + '</p>'
    + '<p id="task-final-report-status" role="status" aria-live="polite">' + safe(taskFinalReportStateLabel(reference.state)) + '</p>'
    + '<h4>' + safe(taskProgressText(progress.state === 'completed' ? 'recordedSummary' : 'currentSummary')) + '</h4>' + taskReportSummary(detail)
    + '<button type="button" id="task-final-report-load">' + safe(taskProgressText('loadReport')) + '</button>'
    + '<pre id="task-final-report-text" tabindex="0" hidden></pre>'
    + '<p id="task-final-report-source"></p><pre id="task-final-report-diagnostics" hidden></pre></section>';
}
function validateTaskFinalReport(report, taskId) {
  const expectedPath = 'runtime/reviews/' + taskId + '-final-user-report.md';
  const bundlePrefix = 'garda-agent-orchestrator/';
  const reportPath = report && typeof report.path === 'string' ? report.path : '';
  const canonicalPath = reportPath.slice(0, bundlePrefix.length).toLowerCase() === bundlePrefix
    ? reportPath.slice(bundlePrefix.length) : reportPath;
  if (!report || report.task_id !== taskId || canonicalPath !== expectedPath
    || !['available', 'missing', 'pending', 'stale', 'legacy', 'unavailable'].includes(report.state)
    || (report.text !== null && (typeof report.text !== 'string' || report.text.length > ${MAX_TASK_FINAL_REPORT_BYTES}))
    || !Array.isArray(report.diagnostics) || report.diagnostics.length > 8
    || report.diagnostics.some(line => typeof line !== 'string' || line.length > 512)) {
    throw new Error(taskProgressText('invalidReport'));
  }
  return report;
}
function wireTaskFinalReport(detail) {
  const button = document.getElementById('task-final-report-load');
  const status = document.getElementById('task-final-report-status');
  const text = document.getElementById('task-final-report-text');
  const source = document.getElementById('task-final-report-source');
  const diagnostics = document.getElementById('task-final-report-diagnostics');
  if (!button || !status || !text || !source || !diagnostics) return;
  button.addEventListener('click', async () => {
    if (button.disabled) return;
    button.disabled = true;
    status.textContent = t('loading');
    try {
      const response = await fetch('/api/tasks/' + encodeURIComponent(detail.task_id) + '/final-report?action_token=' + encodeURIComponent(actionToken));
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const report = validateTaskFinalReport(await response.json(), detail.task_id);
      if (!button.isConnected) return;
      status.textContent = taskFinalReportStateLabel(report.state);
      text.textContent = report.text === null ? '' : report.text;
      text.hidden = report.text === null;
      source.innerHTML = '<code>' + safe(report.path) + '</code>' + (report.text === null ? ''
        : ' <a href="/files?path=' + encodeURIComponent(report.path) + '&action_token=' + encodeURIComponent(actionToken) + '">' + safe(taskProgressText('rawReport')) + '</a>');
      diagnostics.textContent = report.diagnostics.join('\\n');
      diagnostics.hidden = report.diagnostics.length === 0;
    } catch (error) {
      if (!button.isConnected) return;
      status.textContent = taskProgressText('unavailable');
      text.textContent = '';
      text.hidden = true;
      source.innerHTML = '';
      diagnostics.textContent = error instanceof Error ? error.message : String(error);
      diagnostics.hidden = false;
    } finally {
      if (button.isConnected) button.disabled = false;
    }
  });
}
`;
