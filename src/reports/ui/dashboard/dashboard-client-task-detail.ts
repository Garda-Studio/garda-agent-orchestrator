import {
    TASK_CLOSURE_POLICY_ACTION_ID,
    TASK_CLOSURE_POLICY_CONFIRMATION_PHRASE
} from '../actions/task-closure-policy-actions';
import { UI_DASHBOARD_CLIENT_TASK_PROGRESS } from './dashboard-client-task-progress';
import { UI_DASHBOARD_CLIENT_TASK_FINAL_REPORT } from './dashboard-client-task-final-report';

/** Browser-side dashboard script fragment (task-detail). */
export const UI_DASHBOARD_CLIENT_TASK_DETAIL = UI_DASHBOARD_CLIENT_TASK_PROGRESS + UI_DASHBOARD_CLIENT_TASK_FINAL_REPORT + `function reviewSummary(audit) {
  const attempts = audit && audit.review_attempt_summary;
  const summary = attempts && (attempts.by_type || attempts.review_types);
  if (!summary || summary.length === 0) {
    return '<p class="empty">' + safe(t('noReviewAttempts')) + '</p>';
  }
  const cycle = attempts
    ? '<p class="empty">total=' + safe(attempts.total_attempts || 0)
      + '; non-test=' + safe(attempts.total_non_test_attempts || 0)
      + '; current-scope non-test=' + safe(attempts.current_scope_non_test_attempts || 0)
      + '; fresh non-test=' + safe(attempts.fresh_non_test_attempts || 0)
      + '; reused non-test=' + safe(attempts.reused_non_test_attempts || 0) + '</p>'
    : '';
  const scopes = attempts && attempts.top_scope_hashes_by_review_type
    ? '<ul class="list">' + Object.entries(attempts.top_scope_hashes_by_review_type).map(([reviewType, hashes]) => '<li><code>' + safe(reviewType) + '</code>: scope hashes=' + safe((attempts.scope_hash_count_by_review_type && attempts.scope_hash_count_by_review_type[reviewType]) || (Array.isArray(hashes) ? hashes.length : 0)) + '</li>').join('') + '</ul>'
    : '';
  return cycle + '<ul class="list">' + summary.map(item => '<li><code>' + safe(item.review_type) + '</code>: pass=' + safe(item.pass_count) + ', fail=' + safe(item.fail_count) + ', reused=' + safe(item.reused_count) + '</li>').join('') + '</ul>' + scopes;
}
function taskCommandList(taskId) {
  const commands = [
    { id: 'task-next-step', label: t('taskCommandNextStep'), description: t('taskCommandNextStepDescription'), command: 'garda next-step "' + taskId + '" --repo-root "."', mutates: true, disabled: false, unavailable: '' },
    { id: 'task-reset-reopen', label: t('taskCommandReset'), description: t('taskCommandResetDescription'), command: 'garda gate task-reset --task-id "' + taskId + '" --reopen --confirm --repo-root "."', mutates: true, disabled: false, unavailable: '' },
    { id: 'task-reset-discard', label: t('taskCommandDiscard'), description: t('taskCommandDiscardDescription'), command: 'garda gate task-reset --task-id "' + taskId + '" --to-status DONE --confirm --repo-root "."', mutates: true, disabled: false, unavailable: '' },
    { id: 'task-stats', label: t('taskCommandStats'), description: t('taskCommandStatsDescription'), command: 'garda task "' + taskId + '" stats --target-root "."', mutates: false, disabled: false, unavailable: '' },
    { id: 'task-events', label: t('taskCommandEvents'), description: t('taskCommandEventsDescription'), command: 'garda task "' + taskId + '" events --target-root "."', mutates: false, disabled: false, unavailable: '' }
  ];
  return '<div class="task-command-list">' + commands.map(action => '<section class="task-command-card"><strong>' + safe(action.label) + '</strong><p>' + safe(action.description) + '</p><code>' + safe(action.command) + '</code>'
    + (actionsEnabled
      ? '<div class="task-command-buttons"><button type="button" data-task-action-id="' + safe(action.id) + '" data-task-action-mode="execute"' + (action.disabled ? ' disabled' : '') + '>' + safe(action.disabled ? t('actionUnavailable') : t('run')) + '</button>' + (action.mutates ? '<span class="action-kind mutates">' + safe(t('mutatingAction')) + '</span>' : '<span class="action-kind">' + safe(t('safeAction')) + '</span>') + '</div>' + (action.disabled ? '<p class="task-action-unavailable">' + safe(action.unavailable) + '</p>' : '')
      : '<p class="empty">' + inlineText(t('taskCommandUnavailable')) + '</p>')
    + '</section>').join('') + '</div>';
}
function taskClosurePolicyStateMessage(policy) {
  if (!policy) return taskClosurePolicyText('inapplicable');
  if (policy.state === 'completed') return taskClosurePolicyText('completed');
  if (policy.state === 'invalid') return taskClosurePolicyText('invalid');
  if (policy.state === 'pending_next_cycle') return taskClosurePolicyText('pendingNextCycle');
  if (policy.state === 'inapplicable') return taskClosurePolicyText('inapplicable');
  return '';
}
function taskClosurePolicyValueText(policy) {
  if (!policy) return '-';
  return 'skip_low_findings=' + Boolean(policy.skip_low_findings)
    + '; forbid_child_tasks=' + Boolean(policy.forbid_child_tasks);
}
function taskClosurePolicyPanel(detail) {
  const policy = detail.review_follow_up_task_closure_policy;
  if (!policy) return '';
  const stored = policy.stored || {};
  const effective = policy.effective || stored;
  const disabled = !actionsEnabled || !policy.editable;
  const reason = taskClosurePolicyStateMessage(policy) || policy.editable_reason || '';
  const auditPolicy = detail.audit && detail.audit.review_findings_audit
    ? detail.audit.review_findings_audit.review_follow_up_task_closure_policy
    : null;
  const diagnostics = Array.isArray(policy.diagnostics) && policy.diagnostics.length > 0
    ? '<ul class="list">' + policy.diagnostics.map(item => '<li>' + safe(item) + '</li>').join('') + '</ul>'
    : '';
  return '<section class="task-command-card task-closure-policy-card">'
    + '<h3 class="task-section-title">' + safe(taskClosurePolicyText('title')) + '</h3>'
    + '<p class="empty">' + safe(taskClosurePolicyText('help')) + '</p>'
    + '<div class="detail-table"><table><tbody>'
    + '<tr><th>' + safe(taskClosurePolicyText('storedValues')) + '</th><td><code>' + safe(taskClosurePolicyValueText(stored)) + '</code></td></tr>'
    + '<tr><th>' + safe(taskClosurePolicyText('effectiveValues')) + '</th><td><code>' + safe(taskClosurePolicyValueText(effective)) + '</code> <span class="muted">(' + safe(policy.effective_source || '-') + ')</span></td></tr>'
    + (auditPolicy ? '<tr><th>' + safe(t('audit')) + '</th><td><code>ignored_low=' + safe(auditPolicy.ignored_low_findings_count) + '; retained_current_task=' + safe(auditPolicy.retained_current_task_count) + '; prohibited_descendants=' + safe(auditPolicy.prohibited_descendant_creation_count) + '; remaining_blockers=' + safe(auditPolicy.remaining_blocker_count) + '</code></td></tr>' : '')
    + '</tbody></table></div>'
    + '<label class="profile-check"><input id="task-closure-skip-low" type="checkbox"' + (stored.skip_low_findings ? ' checked' : '') + (disabled ? ' disabled' : '') + '> ' + safe(taskClosurePolicyText('skipLowFindings')) + '</label>'
    + '<label class="profile-check"><input id="task-closure-forbid-children" type="checkbox"' + (stored.forbid_child_tasks ? ' checked' : '') + (disabled ? ' disabled' : '') + '> ' + safe(taskClosurePolicyText('forbidChildTasks')) + '</label>'
    + (reason ? '<p class="task-action-unavailable">' + safe(reason) + '</p>' : '')
    + diagnostics
    + '<div class="task-command-buttons">'
    + '<button type="button" id="task-closure-policy-preview"' + (disabled ? ' disabled' : '') + '>' + safe(t('preview')) + '</button>'
    + '<button type="button" id="task-closure-policy-apply"' + (disabled ? ' disabled' : '') + '>' + safe(t('apply')) + '</button>'
    + '</div><div id="task-closure-policy-status" class="task-action-status"></div>'
    + '</section>';
}
function taskClosurePolicyFormValue() {
  const skipLow = document.getElementById('task-closure-skip-low');
  const forbidChildren = document.getElementById('task-closure-forbid-children');
  return {
    skip_low_findings: Boolean(skipLow && skipLow.checked),
    forbid_child_tasks: Boolean(forbidChildren && forbidChildren.checked)
  };
}
function sameTaskClosurePolicyValue(left, right) {
  return Boolean(left && right)
    && left.skip_low_findings === right.skip_low_findings
    && left.forbid_child_tasks === right.forbid_child_tasks;
}
function renderTaskClosurePolicyResult(taskId, result) {
  const node = document.getElementById('task-closure-policy-status');
  if (!node) return;
  node.innerHTML = '<section class="command-preview-panel">'
    + '<div class="command-preview-main"><strong>' + safe(result.task_id || taskId) + '</strong></div>'
    + '<div class="command-preview-meta"><span>' + safe(t('statusColumn')) + '<code>' + safe(resultStatusText(result.status)) + '</code></span>'
    + '<span>' + safe(t('proposed')) + '<code>' + safe(JSON.stringify(result.proposed_value || {})) + '</code></span></div>'
    + (result.unavailable_reason ? '<p class="task-action-unavailable">' + safe(result.unavailable_reason) + '</p>' : '')
    + (result.audit_path ? '<p><strong>' + safe(t('audit')) + ':</strong> <code>' + safe(result.audit_path) + '</code></p>' : '')
    + '</section>';
  focusVisibleActionResult(node);
}
async function requestTaskClosurePolicy(taskId, mode) {
  const proposedValue = taskClosurePolicyFormValue();
  if (mode === 'execute' && (
    !currentTaskClosurePolicyPreview
    || currentTaskClosurePolicyPreview.task_id !== taskId
    || !sameTaskClosurePolicyValue(currentTaskClosurePolicyPreview.proposed_value, proposedValue)
  )) {
    const node = document.getElementById('task-closure-policy-status');
    if (node) node.innerHTML = '<p class="task-action-unavailable">' + safe(taskClosurePolicyText('previewRequired')) + '</p>';
    return;
  }
  const confirmation = mode === 'execute'
    ? window.prompt(t('typeToRunAction') + ' "' + ${JSON.stringify(TASK_CLOSURE_POLICY_CONFIRMATION_PHRASE)} + '" ' + t('typeToRunActionTail'))
    : null;
  if (mode === 'execute' && confirmation === null) return;
  const response = await fetch('/api/tasks/' + encodeURIComponent(taskId) + '/actions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-garda-action-token': actionToken },
    body: JSON.stringify({
      action_id: ${JSON.stringify(TASK_CLOSURE_POLICY_ACTION_ID)},
      mode,
      confirmation,
      ...proposedValue,
      expected_notes_sha256: mode === 'execute' ? currentTaskClosurePolicyPreview.expected_notes_sha256 : null
    })
  });
  const result = await response.json();
  renderTaskClosurePolicyResult(taskId, result);
  if (response.ok && result.status === 'previewed') {
    currentTaskClosurePolicyPreview = {
      task_id: taskId,
      proposed_value: proposedValue,
      expected_notes_sha256: result.expected_notes_sha256
    };
  }
  if (response.ok && result.status === 'executed') {
    currentTaskClosurePolicyPreview = null;
    const reportResponse = await fetch('/api/report');
    currentReport = await reportResponse.json();
    await loadDetail(taskId);
  }
}
function wireTaskClosurePolicyControls(taskId) {
  const previewButton = document.getElementById('task-closure-policy-preview');
  const applyButton = document.getElementById('task-closure-policy-apply');
  const skipLow = document.getElementById('task-closure-skip-low');
  const forbidChildren = document.getElementById('task-closure-forbid-children');
  const clearPreview = () => { currentTaskClosurePolicyPreview = null; };
  if (previewButton) previewButton.addEventListener('click', () => requestTaskClosurePolicy(taskId, 'preview'));
  if (applyButton) applyButton.addEventListener('click', () => requestTaskClosurePolicy(taskId, 'execute'));
  if (skipLow) skipLow.addEventListener('change', clearPreview);
  if (forbidChildren) forbidChildren.addEventListener('change', clearPreview);
}
function blockerText(item) {
  if (typeof item === 'string') {
    return item;
  }
  if (item && typeof item === 'object') {
    const gate = item.gate ? String(item.gate) : '';
    const reason = item.reason ? String(item.reason) : JSON.stringify(item);
    return gate ? gate + ': ' + reason : reason;
  }
  return String(item ?? '');
}
function auditDiagnosticsList(blockers) {
  if (!blockers || blockers.length === 0) {
    return '<p class="empty">' + safe(t('noRuntimeDiagnostics')) + '</p>';
  }
  return '<ul class="list">' + blockers.map(item => '<li>' + safe(blockerText(item)) + '</li>').join('') + '</ul>';
}
function wireTaskActionButtons(taskId) {
  for (const button of detailNode.querySelectorAll('button[data-task-action-id]')) {
    button.addEventListener('click', async () => {
      const actionId = button.dataset.taskActionId;
      const mode = button.dataset.taskActionMode;
      const confirmationPhrase = taskActionConfirmationPhrase(actionId);
      const confirmation = mode === 'execute' && confirmationPhrase
        ? window.prompt(t('typeToRunAction') + ' "' + confirmationPhrase + '" ' + t('typeToRunActionTail'))
        : null;
      if (mode === 'execute' && confirmationPhrase && confirmation === null) {
        return;
      }
      await runTaskAction(taskId, actionId, mode, confirmation);
    });
  }
}
function taskActionConfirmationPhrase(actionId) {
  if (actionId === 'task-next-step') return 'RUN TASK NEXT STEP';
  if (actionId === 'task-reset-reopen') return 'RESET TASK';
  if (actionId === 'task-reset-discard') return 'CLOSE WITHOUT EXECUTION';
  return null;
}
async function runTaskAction(taskId, actionId, mode, confirmation) {
  const response = await fetch('/api/tasks/' + encodeURIComponent(taskId) + '/actions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-garda-action-token': actionToken },
    body: JSON.stringify({ action_id: actionId, mode, confirmation })
  });
  const result = await response.json();
  const node = document.getElementById('task-action-status');
  if (!node) {
    return;
  }
  node.innerHTML = '<section class="command-preview-panel">'
    + '<div class="command-preview-main"><strong>' + safe(result.task_id || taskId) + '</strong></div>'
    + '<div class="command-preview-meta"><span>' + safe(t('statusColumn')) + '<code>' + safe(resultStatusText(result.status)) + '</code></span></div>'
    + (result.unavailable_reason ? '<p class="task-action-unavailable">' + safe(result.unavailable_reason) + '</p>' : '')
    + (result.audit_path ? '<p><strong>' + safe(t('audit')) + ':</strong> <code>' + safe(result.audit_path) + '</code></p>' : '')
    + outputBlock('stdout', result.stdout)
    + outputBlock('stderr', result.stderr)
    + '</section>';
  focusVisibleActionResult(node);
  const exitCode = Number.isFinite(Number(result.exit_code)) ? Number(result.exit_code) : null;
  if (response.ok && result.status === 'executed' && (exitCode === null || exitCode === 0) && (actionId === 'task-reset-reopen' || actionId === 'task-reset-discard')) {
    try {
      const reportResponse = await fetch('/api/report');
      currentReport = await reportResponse.json();
      await loadDetail(taskId);
    } catch {
      // Keep the command result visible if refresh fails.
    }
  }
}
function planButton(detail) {
  return detail.plan && detail.plan.available
    ? '<button type="button" id="show-task-plan">' + safe(t('showTaskPlan')) + '</button>'
    : '';
}
function renderTaskPlanModal(detail) {
  const plan = detail.plan || {};
  const task = findReportTask(detail.task_id);
  planModalBodyNode.innerHTML = '<div class="plan-meta">'
    + '<div><span>' + safe(t('idColumn')) + '</span><strong>' + safe(detail.task_id) + '</strong></div>'
    + '<div><span>' + safe(t('titleColumn')) + '</span><strong>' + safe(plan.task_title || (task && task.title) || '-') + '</strong></div>'
    + '<div><span>' + safe(t('taskQueueStatus')) + '</span><strong>' + safe(plan.task_status || (task && (task.status_token || task.status)) || '-') + '</strong></div>'
    + '</div>'
    + (plan.summary ? '<p class="empty">' + safe(plan.summary) + '</p>' : '')
    + (plan.markdown_path ? '<p><strong>' + safe(t('planPath')) + ':</strong> <code>' + safe(plan.markdown_path) + '</code></p>' : '')
    + '<pre class="plan-content">' + safe(plan.markdown || t('planMetadataOnly')) + '</pre>';
  planModalNode.hidden = false;
}
function closeTaskPlanModal() {
  planModalNode.hidden = true;
  planModalBodyNode.innerHTML = '';
}
function taskQualityChecklistEvidenceLabel(status) {
  if (status === 'stale') return t('qualityGateEvidenceStale');
  if (status === 'missing') return t('qualityGateEvidenceMissing');
  if (status === 'invalid') return t('qualityGateEvidenceInvalid');
  if (status === 'disabled') return t('qualityGateEffectDisabled');
  return t('qualityGateEvidenceCurrent');
}
function taskQualityChecklistEffectLabel(effect) {
  if (effect === 'helped') return t('qualityGateEffectHelped');
  if (effect === 'warned') return t('qualityGateEffectWarned');
  if (effect === 'required_rework') return t('qualityGateEffectRequiredRework');
  if (effect === 'disabled') return t('qualityGateEffectDisabled');
  if (effect === 'skipped_cadence') return t('qualityGateEffectSkippedCadence');
  if (effect === 'missing') return t('qualityGateEffectMissing');
  if (effect === 'invalid') return t('qualityGateEffectInvalid');
  if (effect === 'stale') return t('qualityGateEffectStale');
  return t('qualityGateEffectPassed');
}
function taskQualityChecklistItems(items) {
  if (!Array.isArray(items) || items.length === 0) {
    return '<span class="muted">-</span>';
  }
  return '<ul class="quality-gate-items">' + items.map(item => '<li>' + safe(item) + '</li>').join('') + '</ul>';
}
function taskQualityChecklistSummaryText(latest) {
  const key = latest && latest.summary_key ? latest.summary_key : latest && latest.effect ? latest.effect : 'passed';
  if (key === 'invalid') return t('qualityGateEvidenceInvalid');
  if (key === 'stale') return t('qualityGateEvidenceStale');
  if (key === 'required_rework') return t('qualityGateEffectRequiredRework') + ' (' + (latest.action_required_count || 0) + ')';
  if (key === 'warned') return t('qualityGateEffectWarned');
  if (key === 'helped') return t('qualityGateEffectHelped') + ' (' + (latest.action_taken_count || 0) + ')';
  if (key === 'disabled') return t('qualityGateEffectDisabled');
  if (key === 'skipped_cadence') return t('qualityGateEffectSkippedCadence');
  return t('qualityGateEffectPassed');
}
function taskQualityChecklistDiagnosticLabel(code) {
  if (code === 'artifact_json_invalid') return t('qualityGateEvidenceInvalid') + ': artifact JSON';
  if (code === 'status_unsupported') return t('qualityGateEvidenceInvalid') + ': ' + t('statusColumn');
  if (code === 'checklist_id_mismatch') return t('qualityGateEvidenceInvalid') + ': checklist_id';
  if (code === 'task_id_mismatch') return t('qualityGateEvidenceInvalid') + ': task_id';
  if (code === 'preflight_path_missing') return t('qualityGateEvidenceInvalid') + ': preflight_path';
  if (code === 'preflight_sha256_invalid') return t('qualityGateEvidenceInvalid') + ': preflight_sha256';
  if (code === 'workflow_config_sha256_invalid') return t('qualityGateEvidenceInvalid') + ': workflow_config_sha256';
  if (code === 'changed_file_evidence_missing') return t('qualityGateEvidenceInvalid') + ': changed_file_evidence';
  if (code === 'changed_files_missing') return t('qualityGateEvidenceInvalid') + ': changed_files';
  if (code === 'changed_files_count_missing') return t('qualityGateEvidenceInvalid') + ': changed_files_count';
  if (code === 'changed_files_sha256_invalid') return t('qualityGateEvidenceInvalid') + ': changed_files_sha256';
  if (code === 'scope_sha256_invalid') return t('qualityGateEvidenceInvalid') + ': scope_sha256';
  if (code === 'scope_content_sha256_invalid') return t('qualityGateEvidenceInvalid') + ': scope_content_sha256';
  if (code === 'path_outside_repository') return t('qualityGateEvidenceInvalid') + ': ' + t('artifactPath');
  if (code === 'referenced_artifact_missing') return t('qualityGateEvidenceMissing') + ': ' + t('artifactPath');
  if (code === 'effective_policy_changed') return t('qualityGateEvidenceStale') + ': ' + t('qualityGateRuleSet');
  if (code === 'workflow_config_hash_changed') return t('qualityGateEvidenceStale') + ': ' + t('workflowConfigPath');
  if (code === 'referenced_artifact_hash_changed') return t('qualityGateEvidenceStale') + ': ' + t('artifactPath');
  if (code === 'changed_files_mismatch') return t('qualityGateEvidenceStale') + ': ' + t('qualityGateChangedFiles');
  if (code === 'scope_binding_mismatch') return t('qualityGateEvidenceStale') + ': scope';
  if (code === 'scope_content_mismatch') return t('qualityGateEvidenceStale') + ': scope_content_sha256';
  if (code === 'newer_preflight_exists') return t('qualityGateEvidenceStale') + ': preflight';
  return t('qualityGateEvidenceStale') + ': ' + (code || 'unknown');
}
function taskQualityChecklistDiagnostics(latest) {
  const codes = latest && Array.isArray(latest.stale_reason_codes) ? latest.stale_reason_codes : [];
  const fallbackCount = latest && Array.isArray(latest.stale_reasons) ? latest.stale_reasons.length : 0;
  if (codes.length === 0 && fallbackCount === 0) {
    return '';
  }
  const items = codes.length > 0 ? codes : ['unknown'];
  return '<ul class="quality-gate-items">' + items.map(code => '<li>' + safe(taskQualityChecklistDiagnosticLabel(code)) + '</li>').join('') + '</ul>';
}
function taskQualityChecklistAnswers(answers) {
  const entries = Array.isArray(answers) ? answers : [];
  if (entries.length === 0) {
    return '';
  }
  return '<div class="quality-gate-answer-summary"><strong>' + safe(t('qualityGateAnswers')) + '</strong><ul class="quality-gate-answer-list">'
    + entries.map(answer => '<li><div class="quality-gate-answer-head"><code>' + safe(answer.rule_id || '-') + '</code>'
      + badge(answer.status || '-', 'quality-gate-answer-status', 'quality-gate-answer-status-' + classToken(answer.status))
      + '</div><p>' + safe(answer.answer || '-') + '</p>'
      + (Array.isArray(answer.evidence_files) && answer.evidence_files.length > 0 ? '<div><span class="muted">' + safe(t('qualityGateChangedFiles')) + '</span>' + taskQualityChecklistItems(answer.evidence_files) + '</div>' : '')
      + (Array.isArray(answer.actions_taken) && answer.actions_taken.length > 0 ? '<div><span class="muted">' + safe(t('qualityGateActionsTaken')) + '</span>' + taskQualityChecklistItems(answer.actions_taken) + '</div>' : '')
      + (Array.isArray(answer.actions_required) && answer.actions_required.length > 0 ? '<div><span class="muted">' + safe(t('qualityGateActionsRequired')) + '</span>' + taskQualityChecklistItems(answer.actions_required) + '</div>' : '')
      + '</li>').join('')
    + '</ul></div>';
}
function taskQualityChecklistHistory(history) {
  const entries = Array.isArray(history) ? history : [];
  if (entries.length === 0) {
    return '';
  }
  return '<h4>' + safe(t('qualityGateActionRequiredHistory')) + '</h4><ul class="list">'
    + entries.map(entry => '<li><code>' + safe(entry.timestamp_utc || '-') + '</code>: ' + taskQualityChecklistItems(entry.actions_required) + '</li>').join('')
    + '</ul>';
}
function taskQualityChecklistSummary(checklist) {
  const latest = checklist && checklist.latest ? checklist.latest : null;
  const history = checklist && Array.isArray(checklist.action_required_history) ? checklist.action_required_history : [];
  if (!latest && history.length === 0) {
    return '<p class="empty">' + safe(t('qualityGateEvidenceMissing')) + '</p>';
  }
  const latestHtml = latest
    ? '<section class="quality-gate-block quality-gate-evidence"><div class="quality-gate-summary">'
      + metric(t('qualityGateEvidenceState'), taskQualityChecklistEvidenceLabel(latest.evidence_status))
      + metric(t('qualityGateEffect'), taskQualityChecklistEffectLabel(latest.effect))
      + metric(t('statusColumn'), latest.checklist_status || '-')
      + metric(t('qualityGateAnswers'), latest.answer_count)
      + metric(t('qualityGateActionsTaken'), latest.action_taken_count)
       + metric(t('qualityGateActionsRequired'), latest.action_required_count)
      + '</div><p class="quality-gate-evidence-summary">' + safe(taskQualityChecklistSummaryText(latest)) + '</p>'
      + taskQualityChecklistDiagnostics(latest)
      + (Array.isArray(latest.actions_required) && latest.actions_required.length > 0 ? '<div><strong>' + safe(t('qualityGateActionsRequired')) + '</strong>' + taskQualityChecklistItems(latest.actions_required) + '</div>' : '')
      + (Array.isArray(latest.actions_taken) && latest.actions_taken.length > 0 ? '<div><strong>' + safe(t('qualityGateActionsTaken')) + '</strong>' + taskQualityChecklistItems(latest.actions_taken) + '</div>' : '')
      + (Array.isArray(latest.changed_files_preview) && latest.changed_files_preview.length > 0 ? '<div><strong>' + safe(t('qualityGateChangedFiles')) + '</strong>' + taskQualityChecklistItems(latest.changed_files_preview) + '</div>' : '')
      + taskQualityChecklistAnswers(latest.answers)
      + (latest.artifact_path ? '<p><strong>' + safe(t('artifacts')) + ':</strong> <code>' + safe(latest.artifact_path) + '</code></p>' : '')
      + '</section>'
    : '';
  return latestHtml + taskQualityChecklistHistory(history);
}
async function loadDetail(taskId) {
  selectedTaskId = taskId;
  detailNode.innerHTML = '<p class="empty">' + safe(t('loadingTaskPrefix')) + ' ' + safe(taskId) + '...</p>';
  renderTaskRows();
  const response = await fetch('/api/tasks/' + encodeURIComponent(taskId) + '/detail');
  if (!response.ok) {
    detailNode.innerHTML = '<p class="error">' + safe(t('unableToLoadDetails')) + ' ' + response.status + '</p>';
    return;
  }
  const detail = await response.json();
  currentTaskDetail = detail;
  loadedTaskDetails[detail.task_id] = detail;
  renderTaskDetail(detail);
  renderTaskRows();
  if (currentSettingsPayload) {
    renderSettingsEditor(currentSettingsPayload);
  }
}
function renderTaskDetail(detail) {
  const task = findReportTask(detail.task_id);
  const stats = detail.stats || {};
  const audit = detail.audit || {};
  const fullSuite = detail.full_suite_validation || {};
  const blockers = audit.blockers || [];
  const queueStatus = task ? (task.status_token || task.status) : '';
  const queueBlocked = queueStatus === 'BLOCKED';
  const dataState = queueBlocked ? t('blockerDetailState') : t('fullDetailState');
  detailNode.innerHTML = '<h2>' + safe(detail.task_id) + (task ? ' - ' + safe(task.title) : '') + '</h2>'
    + '<p class="empty">' + safe(dataState) + '</p>'
    + (queueBlocked ? '<div class="blocker-alert">' + safe(t('blockerDetailState')) + '</div>' : '')
    + '<div class="metrics">'
    + metric(t('taskQueueStatus'), queueStatus || '-')
    + metric(t('events'), stats.events_count)
    + metric(t('gatePass'), stats.gate_pass_count)
    + metric(t('gateFail'), stats.gate_fail_count)
    + metric(t('fullSuiteState'), fullSuite.state)
    + metric(t('fullSuiteDuration'), fullSuite.duration_human)
    + metric(t('changedLines'), stats.changed_lines_total)
    + metric(t('dataColumn'), t('dataFull'))
    + '</div>'
    + taskProgressCard(detail.progress)
    + taskFinalReportCard(detail)
    + taskClosurePolicyPanel(detail)
    + '<h3 class="task-section-title">' + safe(t('taskActionsTitle')) + '</h3><p class="empty">' + safe(t('taskActionsHelp')) + '</p><div class="task-command-buttons">' + planButton(detail) + '</div><div id="task-action-status" class="task-action-status"></div>' + taskCommandList(detail.task_id)
    + '<h3 class="task-section-title">' + safe(t('fullSuiteTitle')) + '</h3>' + fullSuiteSummary(fullSuite)
    + '<h3 class="task-section-title">' + safe(t('qualityGateLatestCheck')) + '</h3>' + taskQualityChecklistSummary(detail.quality_checklist)
    + '<h3 class="task-section-title">' + safe(t('gateTimeline')) + '</h3><p class="empty">' + safe(t('gateTimelineHelp')) + '</p><pre>' + safe(JSON.stringify(detail.latest_cycle_events || {}, null, 2)) + '</pre>'
    + (blockers.length > 0 ? '<h3 class="task-section-title">' + safe(t('runtimeDiagnosticsTitle')) + '</h3>' + auditDiagnosticsList(blockers) : '')
    + '<h3 class="task-section-title">' + safe(t('reviews')) + '</h3>' + reviewSummary(audit)
    + '<h3 class="task-section-title">' + safe(t('artifacts')) + '</h3>' + artifactList(detail.artifact_links);
  wireTaskActionButtons(detail.task_id);
  wireTaskProgressCopy(detail.progress);
  wireTaskFinalReport(detail);
  wireTaskClosurePolicyControls(detail.task_id);
  const showPlanButton = document.getElementById('show-task-plan');
  if (showPlanButton) {
    showPlanButton.addEventListener('click', () => renderTaskPlanModal(detail));
  }
}
`;
