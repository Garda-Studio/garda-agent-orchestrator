/** Browser-side dashboard script fragment (init-settings). */
export const UI_DASHBOARD_CLIENT_INIT_SETTINGS = `function localizedValueRow(row) {
  return {
    label: localizedField(initSettingTextPacks, row.id, 'label', row.label),
    description: localizedField(initSettingTextPacks, row.id, 'description', row.description)
  };
}
function renderJsonValue(value) {
  if (Array.isArray(value)) {
    return value.length === 0 ? '-' : value.join(', ');
  }
  if (value === null || value === undefined || value === '') {
    return '-';
  }
  if (typeof value === 'object') {
    return JSON.stringify(value);
  }
  return String(value);
}
function fileViewerHref(pathValue) {
  return '/files?path=' + encodeURIComponent(pathValue) + '&action_token=' + encodeURIComponent(actionToken);
}
const filePreviewRequests = new WeakMap();
async function openReadOnlyFile(pathValue, targetId) {
  const target = document.getElementById(targetId);
  if (!target) return;
  const request = {};
  filePreviewRequests.set(target, request);
  const isCurrentRequest = () => filePreviewRequests.get(target) === request
    && document.getElementById(targetId) === target;
  target.hidden = false;
  target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  target.innerHTML = '<h3><code>' + safe(pathValue) + '</code></h3><p class="empty">' + safe(t('loading')) + '</p>';
  try {
    const response = await fetch(fileViewerHref(pathValue));
    const body = await response.text();
    if (!isCurrentRequest()) return;
    target.innerHTML = '<h3><code>' + safe(pathValue) + '</code></h3><pre>' + safe(body) + '</pre>';
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) {
    if (!isCurrentRequest()) return;
    target.innerHTML = '<h3><code>' + safe(pathValue) + '</code></h3><p class="error">' + safe(error && error.message ? error.message : error) + '</p>';
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}
function openFileButton(pathValue, targetId) {
  return '<button type="button" class="file-open-inline" data-file-path="' + safe(pathValue) + '" data-file-target="' + safe(targetId) + '">' + safe(t('openMemoryFile')) + '</button>';
}
function wireFileButtons(rootNode) {
  for (const button of rootNode.querySelectorAll('button[data-file-path]')) {
    button.addEventListener('click', () => {
      openReadOnlyFile(button.dataset.filePath, button.dataset.fileTarget);
    });
  }
}
function renderValueTable(rows) {
  if (!rows || rows.length === 0) {
    return '<p class="empty">' + safe(t('noInitSettings')) + '</p>';
  }
  return '<div class="value-table"><table><thead><tr><th>' + safe(t('fieldColumn')) + '</th><th>' + safe(t('descriptionColumn')) + '</th><th>' + safe(t('valueColumn')) + '</th></tr></thead><tbody>'
    + rows.map(row => {
      const localized = localizedValueRow(row);
      const valueOpenControl = row.file_path ? openFileButton(row.file_path, 'init-file-content') : '';
      return '<tr><td><strong>' + safe(localized.label) + '</strong><br><code>' + safe(row.id) + '</code></td><td class="description-cell">' + inlineText(localized.description) + '</td><td><span class="value-with-open"><code class="current-value">' + safe(renderJsonValue(row.value)) + '</code>' + valueOpenControl + '</span></td></tr>';
    }).join('')
    + '</tbody></table></div>';
}
function initStatusText(status) {
  if (status === 'present') return t('initStatusPresent');
  if (status === 'missing') return t('initStatusMissing');
  if (status === 'invalid') return t('initStatusInvalid');
  return String(status || 'unknown');
}
function renderInitStatusNotice(status) {
  if (status === 'present') {
    return '';
  }
  return '<p class="workflow-state">' + safe(initStatusText(status)) + '</p>';
}
function renderInitSettings(report) {
  const tab = report.init_settings_tab || {};
  const commands = tab.commands || [];
  setPanelConfigPath(initSettingsConfigPathNode, [
    tab.init_answers_path,
    tab.agent_init_state_path,
    tab.ordinary_docs && tab.ordinary_docs.config_path
  ]);
  initSettingsNode.innerHTML = '<section class="workflow-group">' + renderInitStatusNotice(tab.init_answers_status) + renderValueTable(tab.init_answers || []) + '</section>'
    + '<section class="workflow-group"><h3>' + safe(t('agentInitBlockTitle')) + '</h3>' + renderInitStatusNotice(tab.agent_init_state_status) + renderValueTable(tab.agent_init_state || []) + '</section>'
    + renderOrdinaryDocs(tab.ordinary_docs || { paths: [], config_path: '-', status: 'missing' })
    + '<section class="workflow-group"><h3>' + safe(t('initCommandsTitle')) + '</h3><div class="action-table"><table><thead><tr><th>' + safe(t('action')) + '</th><th>' + safe(t('descriptionColumn')) + '</th><th>' + safe(t('commandColumn')) + '</th></tr></thead><tbody>'
    + commands.map(command => '<tr><td><strong>' + safe(localizedField(initSettingTextPacks, command.id, 'title', command.title)) + '</strong></td><td class="description-cell">' + inlineText(localizedField(initSettingTextPacks, command.id, 'description', command.description)) + '</td><td class="command-cell"><code>' + safe(command.command) + '</code></td></tr>').join('')
    + '</tbody></table></div></section><section id="init-file-content" class="memory-file-content" hidden></section>';
  wireOrdinaryDocsControls(tab.ordinary_docs || { paths: [] });
  wireFileButtons(initSettingsNode);
}
function renderOrdinaryDocs(info) {
  const rows = (info.paths || []).map(pathValue => '<tr><td><label class="ordinary-doc-row"><input type="checkbox" value="' + safe(pathValue) + '"' + (!actionsEnabled ? ' disabled' : '') + '><code>' + safe(pathValue) + '</code></label></td></tr>').join('');
  const table = rows
    ? '<div class="value-table"><table><thead><tr><th>' + safe(t('fileColumn')) + '</th></tr></thead><tbody>' + rows + '</tbody></table></div><div class="setting-buttons"><button type="button" data-ordinary-doc-operation="remove-selected" data-ordinary-doc-mode="execute"' + (!actionsEnabled ? ' disabled' : '') + '>' + safe(t('removeOrdinaryDoc')) + '</button></div>'
    : '<p class="empty">' + safe(t('ordinaryDocsEmpty')) + '</p>';
  const disabledText = !actionsEnabled ? '<p class="empty">' + safe(t('ordinaryDocsActionsDisabled')) + ' <code>garda ui --actions</code></p>' : '';
  return '<section class="workflow-group ordinary-docs"><h3>' + safe(t('ordinaryDocsTitle')) + '</h3>'
    + '<p class="empty">' + safe(t('ordinaryDocsHelp')) + '</p>'
    + table
    + '<div id="ordinary-docs-status" class="action-status empty"></div>'
    + '<div class="ordinary-doc-form"><label><span>' + safe(t('ordinaryDocsPath')) + '</span><input id="ordinary-doc-path" type="text" placeholder="docs/plan.md"' + (!actionsEnabled ? ' disabled' : '') + '></label><div class="setting-buttons"><button type="button" data-ordinary-doc-operation="add" data-ordinary-doc-mode="execute"' + (!actionsEnabled ? ' disabled' : '') + '>' + safe(t('addOrdinaryDoc')) + '</button></div></div>'
    + disabledText
    + '</section>';
}
function renderOrdinaryDocsResult(result) {
  const node = document.getElementById('ordinary-docs-status');
  if (!node) return;
  node.innerHTML = '<section class="command-preview-panel">'
    + '<div class="command-preview-meta"><span>' + safe(t('statusColumn')) + '<code>' + safe(resultStatusText(result.status)) + '</code></span><span>' + safe(t('fileColumn')) + '<code>' + safe(result.path || '-') + '</code></span></div>'
    + (result.audit_path ? '<p><strong>' + safe(t('audit')) + ':</strong> <code>' + safe(result.audit_path) + '</code></p>' : '')
    + '</section>';
}
async function submitOrdinaryDocs(operation, mode, pathValue, confirmation) {
  const response = await fetch('/api/ordinary-docs', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-garda-action-token': actionToken },
    body: JSON.stringify({ operation, mode, path: pathValue, confirmation })
  });
  const result = await response.json();
  renderOrdinaryDocsResult(result);
  if (result && result.status === 'executed') {
    const reportResponse = await fetch('/api/report');
    currentReport = await reportResponse.json();
    renderInitSettings(currentReport);
  }
}
function wireOrdinaryDocsControls(info) {
  for (const button of initSettingsNode.querySelectorAll('button[data-ordinary-doc-operation]')) {
    button.addEventListener('click', async () => {
      const operation = button.dataset.ordinaryDocOperation;
      const input = document.getElementById('ordinary-doc-path');
      const selectedPaths = Array.from(initSettingsNode.querySelectorAll('.ordinary-doc-row input[type="checkbox"]:checked')).map(item => item.value);
      const paths = operation === 'add' ? [input ? input.value : ''] : selectedPaths;
      const confirmation = paths.length > 0
        ? window.prompt(t('typeToApplySetting') + ' "APPLY ORDINARY DOCS" ' + t('typeToApplySettingTail'))
        : null;
      if (confirmation === null) {
        return;
      }
      for (const pathValue of paths) {
        await submitOrdinaryDocs(operation === 'add' ? 'add' : 'remove', 'execute', pathValue, confirmation);
      }
    });
  }
}
`;
