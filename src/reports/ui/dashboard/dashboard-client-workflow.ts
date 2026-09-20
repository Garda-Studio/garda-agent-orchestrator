/** Browser-side dashboard script fragment (workflow). */
export const UI_DASHBOARD_CLIENT_WORKFLOW = `function syncWorkflowMessagesVisibility() {
  if (!workflowNode) {
    return;
  }
  workflowNode.hidden = workflowNode.innerHTML.trim() === '';
}
function updateWorkflowPanelTitle() {
  if (!workflowPanelTitleNode) {
    return;
  }
  workflowPanelTitleNode.textContent = settingGroupLabel(currentWorkflowSettingGroup);
}
function shouldSuppressRoutineSettingStdout(successfulExecution) {
  return successfulExecution;
}
function renderWorkflow(report) {
  const tab = report.workflow_config_tab;
  setPanelConfigPath(workflowConfigPathNode, tab && tab.config_path ? tab.config_path : '');
  const unavailable = tab && tab.unavailable ? tab.unavailable : [];
  if (unavailable.length > 0) {
    workflowNode.innerHTML = '<div class="blocker-alert"><strong>' + safe(t('workflowWarningTitle')) + ':</strong> ' + safe(unavailable.map(item => item.reason).join(' ')) + '</div>';
    syncWorkflowMessagesVisibility();
    return;
  }
  const status = tab ? tab.status : 'missing';
  if (status === 'present') {
    const currentResult = typeof currentWorkflowSettingResult === 'undefined' ? null : currentWorkflowSettingResult;
    workflowNode.innerHTML = currentResult ? renderSettingResultMarkup(currentResult) : '';
  } else {
    workflowNode.innerHTML = '<p class="workflow-state">' + safe(workflowStatusText(status)) + '</p>';
  }
  syncWorkflowMessagesVisibility();
}
function renderSettingResultMarkup(result) {
  const label = localizedField(settingTextPacks, result.setting_id, 'label', result.label || result.key || result.setting_id || t('setting'));
  const status = result.status || result.code || 'error';
  const hasCurrentValue = Object.prototype.hasOwnProperty.call(result, 'current_value');
  const hasProposedValue = Object.prototype.hasOwnProperty.call(result, 'proposed_value');
  const errorText = result.error || result.message || '';
  const exitCode = typeof result.exit_code === 'number' ? result.exit_code : null;
  const successfulExecution = status === 'executed'
    && !errorText
    && !result.stderr
    && result.timed_out !== true
    && result.cancelled !== true
    && (exitCode === null || exitCode === 0);
  const suppressRoutineStdout = shouldSuppressRoutineSettingStdout(successfulExecution);
  return '<section class="command-preview-panel">'
    + '<div class="command-preview-main"><strong>' + safe(label) + '</strong></div>'
    + '<div class="command-preview-meta">'
    + '<span>' + safe(t('statusColumn')) + '<code>' + safe(resultStatusText(status)) + '</code></span>'
    + (hasCurrentValue ? '<span>' + safe(t('current')) + '<code>' + safe(JSON.stringify(result.current_value)) + '</code></span>' : '')
    + (hasProposedValue ? '<span>' + safe(t('proposed')) + '<code>' + safe(JSON.stringify(result.proposed_value)) + '</code></span>' : '')
    + '</div>'
    + (result.changed_keys && result.changed_keys.length > 0 ? '<p><strong>' + safe(t('changedKey')) + ':</strong> <code>' + safe(result.changed_keys.join(', ')) + '</code></p>' : '')
    + (result.audit_path ? '<p><strong>' + safe(t('audit')) + ':</strong> <code>' + safe(result.audit_path) + '</code></p>' : '')
    + (errorText ? '<p class="blocker-alert">' + safe(errorText) + '</p>' : '')
    + (suppressRoutineStdout ? '' : outputBlock('stdout', result.stdout))
    + outputBlock('stderr', result.stderr)
    + '</section>';
}
function renderWorkflowSettingResult(result) {
  currentWorkflowSettingResult = result;
  if (!workflowNode) {
    return;
  }
  workflowNode.innerHTML = renderSettingResultMarkup(result);
  syncWorkflowMessagesVisibility();
  if (typeof workflowNode.setAttribute === 'function' && (!workflowNode.getAttribute || workflowNode.getAttribute('tabindex') === null)) {
    workflowNode.setAttribute('tabindex', '-1');
  }
  if (typeof workflowNode.scrollIntoView === 'function') {
    workflowNode.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  if (typeof workflowNode.focus === 'function') {
    workflowNode.focus({ preventScroll: true });
  }
}
async function submitSetting(settingId, mode, value, confirmation, resultRenderer) {
  const response = await fetch('/api/settings', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-garda-action-token': actionToken },
    body: JSON.stringify({ setting_id: settingId, mode, value, confirmation })
  });
  const result = await response.json();
  if (typeof resultRenderer === 'function') {
    resultRenderer(result);
  }
  if (result && result.status === 'executed') {
    if (currentReport) {
      try {
        const reportResponse = await fetch('/api/report');
        const report = await reportResponse.json();
        currentReport = report;
        renderWorkflow(report);
      } catch {
        // Keep the successfully refreshed settings visible even if report refresh fails.
      }
    }
    await refreshSettingsPayload();
  }
}
function settingInputValue(setting) {
  if (setting && setting.id === 'compile-gate-command' && String(setting.current_value || '') === '__COMPILE_GATE_COMMAND_UNCONFIGURED__') {
    return '';
  }
  if (Array.isArray(setting.current_value)) {
    return setting.current_value.join(',');
  }
  if (typeof setting.current_value === 'boolean') {
    return String(setting.current_value);
  }
  return setting.current_value === null || setting.current_value === undefined ? '' : String(setting.current_value);
}
function settingValueList(setting) {
  if (Array.isArray(setting.current_value)) {
    return setting.current_value.map(value => String(value));
  }
  const inputValue = settingInputValue(setting);
  return inputValue.split(',').map(value => value.trim()).filter(Boolean);
}
function renderSettingOptions(setting) {
  if (!setting.options || setting.options.length === 0) {
    return '<div class="option-item"><strong>' + safe(t('noFixedOptions')) + '</strong><span>' + safe(t('freeValueHelp')) + '</span></div>';
  }
  if (setting.id === 'review-cycle-excluded-review-types') {
    const values = setting.options.map(option => String(option.value || '').trim()).filter(Boolean);
    return '<div class="option-list"><div class="option-item"><strong>' + safe(t('availableReviewTypes')) + '</strong><span><code>' + safe(values.join(', ')) + '</code></span></div></div>';
  }
  return '<div class="option-list">' + setting.options.map(option => '<div class="option-item"><strong>' + formatSettingOptionTitle(setting, option) + '</strong><span>' + inlineText(localizedOption(settingTextPacks, setting.id, option, 'description', option.description)) + '</span></div>').join('') + '</div>';
}
function settingControlId(settingId, controlScope) {
  return 'setting-input-' + (controlScope || 'workflow') + '-' + settingId;
}
function renderSettingControl(setting, disabled, controlScope) {
  const inputValue = settingInputValue(setting);
  const disabledAttr = disabled ? ' disabled' : '';
  const controlId = safe(settingControlId(setting.id, controlScope));
  if (isDurationMsSetting(setting)) {
    const parts = durationPartsFromMs(setting.current_value);
    return '<div class="duration-control" data-setting-id="' + safe(setting.id) + '"><label>' + safe(t('minutesLabel')) + '<input id="' + controlId + '-minutes" type="number" min="0" value="' + safe(parts.minutes) + '"' + disabledAttr + '></label><label>' + safe(t('secondsLabel')) + '<input id="' + controlId + '-seconds" type="number" min="0" max="59" value="' + safe(parts.seconds) + '"' + disabledAttr + '></label></div><span class="duration-help">' + safe(t('durationStoredAsMs')) + '</span>';
  }
  if (setting.value_type === 'enum_list' && setting.options && setting.options.length > 0) {
    const selected = new Set(settingValueList(setting));
    return '<div id="' + controlId + '" class="enum-list-control" role="group">' + setting.options.map(option => '<label><input type="checkbox" value="' + safe(option.value) + '"' + (selected.has(String(option.value)) ? ' checked' : '') + disabledAttr + '><span>' + formatSettingOptionTitle(setting, option) + '</span></label>').join('') + '</div>';
  }
  if (setting.options && setting.options.length > 0) {
    return '<select id="' + controlId + '"' + disabledAttr + '>' + setting.options.map(option => '<option value="' + safe(option.value) + '"' + (String(option.value) === inputValue ? ' selected' : '') + '>' + safe(localizedOption(settingTextPacks, setting.id, option, 'label', option.label)) + ' (' + safe(option.value) + ')</option>').join('') + '</select>';
  }
  if (setting.value_type === 'integer') {
    return '<input id="' + controlId + '" type="number" min="' + safe(setting.min || 1) + '" max="' + safe(setting.max || '') + '" value="' + safe(inputValue) + '"' + disabledAttr + '>';
  }
  return '<input id="' + controlId + '" type="text" value="' + safe(inputValue) + '" placeholder="' + safe(setting.placeholder || '') + '"' + disabledAttr + '>';
}
function settingGroupId(setting) {
  const key = String(setting.key || '');
  if (key.startsWith('compact.')) return 'compact';
  if (key.startsWith('compile_gate.')) return 'validation';
  if (key.startsWith('full_suite_validation.')) return 'validation';
  if (key.startsWith('optional_quality_checks.')) return 'validation';
  if (key.startsWith('optional_skill_selection_policy.')) return 'validation';
  if (key.startsWith('review_execution_policy.') || key.startsWith('review_cycle_guard.')) return 'review';
  if (key.startsWith('scope_budget_guard.')) return 'scope';
  if (key.startsWith('project_memory_maintenance.')) return 'memory';
  return 'safety';
}
function settingGroupLabel(groupId) {
  if (groupId === 'compact') return 'Compact';
  if (groupId === 'validation') return t('workflowGroupValidation');
  if (groupId === 'review') return t('workflowGroupReview');
  if (groupId === 'scope') return t('workflowGroupScope');
  if (groupId === 'memory') return t('workflowGroupMemory');
  return t('workflowGroupSafety');
}
function settingCurrentDisplay(setting) {
  if (setting && setting.id === 'compile-gate-command' && String(setting.current_value || '') === '__COMPILE_GATE_COMMAND_UNCONFIGURED__') {
    return localizedField(
      settingTextPacks,
      'compile-gate-command-fallback',
      'description',
      'Not set in workflow-config; compile-gate fails closed until workflow set records a project-specific compile/build/type-check command.'
    );
  }
  return isDurationMsSetting(setting) ? formatDurationMs(setting.current_value) : JSON.stringify(setting.current_value);
}
function settingReadinessNote(setting) {
  if (!setting || setting.id !== 'task-reset-enabled' || !setting.readiness) {
    return '';
  }
  const readiness = setting.readiness;
  const state = readiness.ready === true ? t('taskResetReady') : t('taskResetNotReady');
  const reason = readiness.disabled_reason ? '<div><code>' + safe(readiness.disabled_reason) + '</code></div>' : '';
  const remediation = readiness.remediation_command ? '<div>' + safe(t('taskResetRemediation')) + ' <code>' + safe(readiness.remediation_command) + '</code></div>' : '';
  return '<div class="setting-note"><strong>' + safe(state) + '</strong>' + reason + remediation + '</div>';
}
function settingLabelText(setting) {
  if (setting && setting.id === 'full-suite-timeout-warning-continuation') {
    return t('fullSuiteTimeoutWarningContinuation');
  }
  return localizedField(settingTextPacks, setting.id, 'label', setting.label);
}
function settingDescriptionText(setting) {
  if (setting && setting.id === 'full-suite-timeout-warning-continuation') {
    return t('fullSuiteTimeoutWarningContinuation') + ': ' + t('fullSuiteTimeoutBlocker');
  }
  return localizedField(settingTextPacks, setting.id, 'description', setting.description);
}
function renderSettingRow(setting, disabled, controlScope) {
  const label = settingLabelText(setting);
  const description = settingDescriptionText(setting);
  const dependencyNote = setting.id === 'review-cycle-auto-split-enabled'
    ? '<div class="setting-note">' + safe(t('reviewCycleAutoSplitDependency')) + '</div>'
    : '';
  const readinessNote = settingReadinessNote(setting);
  return '<tr id="setting-row-' + safe(setting.id) + '" data-setting-row-id="' + safe(setting.id) + '">'
    + '<td><div class="setting-title"><strong>' + safe(label) + '</strong><code>(' + safe(setting.key) + ')</code><span class="setting-parameter"><code>' + safe(setting.flag) + '</code></span></div></td>'
    + '<td class="description-cell">' + inlineText(description) + dependencyNote + readinessNote + '</td>'
    + '<td><code class="current-value">' + safe(settingCurrentDisplay(setting)) + '</code></td>'
    + '<td>' + renderSettingOptions(setting) + '</td>'
    + '<td><label class="setting-control"><span>' + safe(t('newValue')) + '</span>' + renderSettingControl(setting, disabled, controlScope) + '</label><div class="setting-buttons"><button type="button" data-setting-id="' + safe(setting.id) + '" data-setting-control-scope="' + safe(controlScope || 'workflow') + '" data-setting-mode="execute"' + (disabled ? ' disabled' : '') + '>' + safe(disabled ? t('saveDisabled') : t('save')) + '</button></div></td>'
    + '</tr>';
}
function optionalRuleInputId(ruleId, field) {
  return 'optional-rule-' + String(ruleId || 'new').replace(/[^a-z0-9_-]/gi, '-') + '-' + field;
}
function optionalRuleValue(rule, field) {
  if (!rule) return '';
  if (field === 'enabled') return rule.enabled === false ? 'false' : 'true';
  return rule[field] === null || rule[field] === undefined ? '' : String(rule[field]);
}
function optionalRuleExcludesTestOnly(rule) {
  return Array.isArray(rule && rule.excluded_scope_categories)
    && rule.excluded_scope_categories.map(scope => String(scope || '').trim()).includes('test-only');
}
async function submitOptionalRule(action, ruleId, title, prompt, enabled, excludeTestOnly, confirmation, resultRenderer) {
  const response = await fetch('/api/settings', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-garda-action-token': actionToken },
    body: JSON.stringify({ optional_rule_action: action, mode: 'execute', rule_id: ruleId, title, prompt, enabled, exclude_test_only: excludeTestOnly, confirmation })
  });
  const result = await response.json();
  if (typeof resultRenderer === 'function') {
    resultRenderer(result);
  }
  if (result && result.status === 'executed') {
    await refreshSettingsPayload();
  }
}
function renderValidationForecastLine(report) {
  if (currentWorkflowSettingGroup !== 'validation' || !report || !report.system_state || !report.system_state.workflow) {
    return '';
  }
  const workflow = report.system_state.workflow;
  if (!workflow.full_suite_timeout_forecast_label) {
    return '';
  }
  return '<p class="setting-note full-suite-runtime-info"><strong>' + safe(t('fullSuiteTimeoutForecast')) + ':</strong> ' + safe(workflow.full_suite_timeout_forecast_label) + '</p>';
}
function renderSettingsEditor(payload) {
  currentSettingsPayload = payload;
  const settings = payload.settings || [];
  if (settings.length === 0) {
    updateWorkflowPanelTitle();
    settingsEditorNode.innerHTML = '<p class="empty">' + safe(t('noEditableSettings')) + '</p>';
    syncWorkflowMessagesVisibility();
    return;
  }
  const disabled = !payload.enabled;
  const disabledNotice = disabled
    ? '<p class="empty">' + safe(t('settingEditsDisabled')) + ' <code>garda ui --actions</code> ' + safe(t('settingEditsDisabledTail')) + '</p>'
    : '';
  const groupOrder = ['validation', 'review', 'scope', 'compact', 'safety'];
  const availableGroups = groupOrder.filter(groupId => settings.some(setting => settingGroupId(setting) === groupId));
  if (!availableGroups.includes(currentWorkflowSettingGroup)) {
    currentWorkflowSettingGroup = availableGroups[0] || 'validation';
  }
  updateWorkflowPanelTitle();
  const reportForRuntimeInfo = typeof currentReport === 'undefined' ? null : currentReport;
  const compactCache = reportForRuntimeInfo && reportForRuntimeInfo.workflow_config_tab && reportForRuntimeInfo.workflow_config_tab.compact_cache;
  settingsEditorNode.innerHTML = disabledNotice
    + (currentWorkflowSettingGroup === 'compact' && compactCache
      ? '<p class="meta"><code>runtime/compact: ' + (compactCache.available ? safe(compactCache.bytes) + ' bytes; ' + safe(compactCache.runs) + ' runs' : 'unavailable') + '</code></p>' : '')
    + renderValidationForecastLine(reportForRuntimeInfo)
    + (() => {
      const groupSettings = settings.filter(setting => settingGroupId(setting) === currentWorkflowSettingGroup);
      if (groupSettings.length === 0) return '<p class="empty">' + safe(t('noWorkflowSettings')) + '</p>';
      return '<section class="workflow-group workflow-setting-group"><div class="workflow-table"><table><thead><tr><th>' + safe(t('configSettingColumn')) + '</th><th>' + safe(t('descriptionColumn')) + '</th><th>' + safe(t('currentValueColumn')) + '</th><th>' + safe(t('optionsColumn')) + '</th><th>' + safe(t('changeColumn')) + '</th></tr></thead><tbody>' + groupSettings.map(setting => renderSettingRow(setting, disabled, 'workflow')).join('') + '</tbody></table></div></section>';
    })();
  syncWorkflowMessagesVisibility();
  for (const button of settingsEditorNode.querySelectorAll('button[data-setting-id]')) {
    button.addEventListener('click', () => {
      const setting = settings.find(item => item.id === button.dataset.settingId);
      const mode = button.dataset.settingMode;
      const controlScope = button.dataset.settingControlScope || 'workflow';
      const input = document.getElementById(settingControlId(button.dataset.settingId, controlScope));
      const confirmation = mode === 'execute' && setting
        ? window.prompt(t('typeToApplySetting') + ' "' + setting.confirmation_phrase + '" ' + t('typeToApplySettingTail'))
        : null;
      if (mode === 'execute' && confirmation === null) {
        return;
      }
      submitSetting(button.dataset.settingId, mode, settingSubmitValue(setting, input, controlScope), confirmation, renderWorkflowSettingResult);
    });
  }
}
async function refreshSettingsPayload() {
  const response = await fetch('/api/settings');
  renderSettingsEditor(await response.json());
  renderQualityGate(currentReport);
  if (currentReport) {
    renderProjectMemory(currentReport);
  }
}
function settingSubmitValue(setting, fallbackInput, controlScope) {
  if (isDurationMsSetting(setting)) {
    const baseControlId = settingControlId(setting.id, controlScope || 'workflow');
    const minutesInput = document.getElementById(baseControlId + '-minutes');
    const secondsInput = document.getElementById(baseControlId + '-seconds');
    const minutes = Math.max(0, Math.trunc(Number(minutesInput ? minutesInput.value : 0) || 0));
    const seconds = Math.max(0, Math.min(59, Math.trunc(Number(secondsInput ? secondsInput.value : 0) || 0)));
    return String((minutes * 60 + seconds) * 1000);
  }
  if (setting && setting.value_type === 'enum_list') {
    return Array.from((fallbackInput || document).querySelectorAll('input[type="checkbox"]:checked')).map(input => input.value);
  }
  return fallbackInput ? fallbackInput.value : '';
}
`;
