import { LOCAL_UI_TASK_PROGRESS_TEXT } from '../ui-i18n';

/** Browser-side presentation of the task-owned progress read model. */
export const UI_DASHBOARD_CLIENT_TASK_PROGRESS = `const taskProgressTextPacks = ${JSON.stringify(LOCAL_UI_TASK_PROGRESS_TEXT).replace(/</gu, '\\u003c')};
function taskProgressText(key) {
  return (taskProgressTextPacks[currentLanguage] && taskProgressTextPacks[currentLanguage][key])
    || taskProgressTextPacks[fallbackLanguage][key] || key;
}
function taskProgressStateLabel(state) {
  const states = ['active', 'blocked', 'stale', 'unknown', 'incomplete', 'completed', 'unavailable', 'available', 'missing', 'pending', 'failed'];
  return taskProgressText(states.includes(state) ? state : 'unknown');
}
function taskProgressStages(stages, emptyKey, variant) {
  if (!Array.isArray(stages) || stages.length === 0) {
    return '<p class="empty">' + safe(taskProgressText(emptyKey)) + '</p>';
  }
  return '<ul class="list task-stage-list task-stage-list-' + variant + '">' + stages.map(stage => '<li><code>' + safe(stage.gate) + '</code>'
    + (stage.status ? ' — ' + safe(taskProgressStateLabel(stage.status)) : '')
    + (stage.timestamp_utc ? ' <time datetime="' + safe(stage.timestamp_utc) + '">' + safe(stage.timestamp_utc) + '</time>' : '')
    + '</li>').join('') + '</ul>';
}
function taskProgressNextAction(action) {
  if (!action) return '<p class="empty">' + safe(taskProgressText('noNextAction')) + '</p>';
  return '<p>' + safe(action.label) + (action.gate ? ' <code>' + safe(action.gate) + '</code>' : '') + '</p>'
    + (action.command ? '<label id="task-progress-command-title" for="task-progress-command">' + safe(taskProgressText('command')) + '</label>'
      + '<textarea id="task-progress-command" class="task-progress-command" rows="3" readonly spellcheck="false">' + safe(action.command) + '</textarea>'
      + '<button type="button" id="task-progress-copy">' + safe(taskProgressText('copy')) + '</button>'
      + '<p id="task-progress-copy-status" role="status" aria-live="polite" aria-atomic="true"></p>' : '');
}
function taskProgressCard(progress) {
  const model = progress || {};
  const report = model.final_report || {};
  const diagnostics = Array.isArray(model.diagnostics) ? model.diagnostics : [];
  const progressState = model.state || 'unavailable';
  return '<section class="command-preview-panel task-progress-card" data-progress-state="' + safe(progressState) + '" aria-labelledby="task-progress-title">'
    + '<h3 id="task-progress-title" class="task-section-title">' + safe(taskProgressText('title')) + '</h3>'
    + '<p>' + safe(taskProgressStateLabel(progressState)) + '</p>'
    + '<p class="empty">' + safe(taskProgressText('help')) + '</p>'
    + '<h4>' + safe(taskProgressText('completedStages')) + '</h4>' + taskProgressStages(model.completed_stages, 'noCompletedStages', 'completed')
    + '<h4>' + safe(taskProgressText('currentStage')) + '</h4>'
      + (model.current_stage ? '<p class="task-stage-current"><code>' + safe(model.current_stage) + '</code></p>' : '<p>' + safe(taskProgressText('noCurrentStage')) + '</p>')
    + '<h4>' + safe(taskProgressText('remainingStages')) + '</h4>' + taskProgressStages(model.remaining_stages, 'noRemainingStages', 'remaining')
    + '<h4>' + safe(t('blockers')) + '</h4>'
      + (model.blocker ? '<p class="task-action-unavailable">' + (model.blocker.gate ? '<code>' + safe(model.blocker.gate) + '</code>: ' : '') + safe(model.blocker.reason) + '</p>' : '<p class="empty">' + safe(t('noBlockers')) + '</p>')
    + '<h4>' + safe(taskProgressText('nextAction')) + '</h4>' + taskProgressNextAction(model.next_action)
    + '<h4>' + safe(taskProgressText('finalReport')) + '</h4><p>' + safe(taskProgressStateLabel(report.state || 'unavailable'))
      + (report.path ? ' <code>' + safe(report.path) + '</code>' : '') + '</p>'
    + (diagnostics.length ? '<h4>' + safe(t('runtimeDiagnosticsTitle')) + '</h4><ul class="list">' + diagnostics.map(item => '<li>' + safe(item) + '</li>').join('') + '</ul>' : '')
    + '</section>';
}
function wireTaskProgressCopy(progress) {
  const command = progress && progress.next_action && progress.next_action.command;
  const field = document.getElementById('task-progress-command');
  const button = document.getElementById('task-progress-copy');
  const status = document.getElementById('task-progress-copy-status');
  if (!command || !field || !button || !status) return;
  field.value = command;
  button.addEventListener('click', async () => {
    try {
      if (typeof navigator === 'undefined' || !navigator.clipboard || !navigator.clipboard.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(command);
      status.textContent = taskProgressText('copied');
    } catch {
      field.focus();
      field.select();
      status.textContent = taskProgressText('selectToCopy');
    }
  });
}
`;
