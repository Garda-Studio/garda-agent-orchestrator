/** Stable selection and native-backed confirmation share one backup-operation guard. */
export const UI_DASHBOARD_CLIENT_BACKUP_SELECTION = `const selectedBackupIds = new Set();
let backupSelectionRows = [];
let backupSelectionInventoryCurrent = false;
let backupSelectionFilter = '';
let backupSelectionSort = 'newest';
function selectionText(id) {
  return localizedField(backupSelectionTextPacks, id, 'label', id);
}
function updateBackupSelectionInventory(tab) {
  const current = tab && Array.isArray(tab.rows) && Array.isArray(tab.unavailable)
    && !tab.unavailable.some(item => item.scope === 'backups:inventory');
  const identity = JSON.stringify([Boolean(current), current ? tab.rows : null]);
  if (identity !== backupInventoryIdentity) { backupInventoryRevision++; backupDeletionPreview = null; }
  backupInventoryIdentity = identity;
  backupSelectionTab = tab;
  backupSelectionInventoryCurrent = Boolean(current);
  if (!current) return;
  backupSelectionRows = tab.rows;
  const present = new Set(backupSelectionRows.map(row => row.id));
  for (const id of selectedBackupIds) if (!present.has(id) && !backupDeletionRetainedIds.has(id)) selectedBackupIds.delete(id);
}
function filteredBackupSelectionRows() {
  const needle = backupSelectionFilter.toLowerCase();
  return backupSelectionRows.filter(row => row.id.toLowerCase().includes(needle)).slice().sort((a, b) =>
    backupSelectionSort === 'id' ? a.id.localeCompare(b.id)
      : String(b.created_at).localeCompare(String(a.created_at)) || a.id.localeCompare(b.id));
}
function backupSelectionSummary() {
  const rows = backupSelectionRows.filter(row => selectedBackupIds.has(row.id));
  const known = backupSelectionInventoryCurrent && rows.length === selectedBackupIds.size
    && rows.every(row => Number.isSafeInteger(row.size_bytes) && row.size_bytes >= 0);
  const bytes = rows.reduce((sum, row) => sum + row.size_bytes, 0);
  return { count: selectedBackupIds.size, bytes: known && Number.isSafeInteger(bytes) ? bytes : null };
}
function renderBackupSelectionControls() {
  const summary = backupSelectionSummary();
  const disabled = backupSelectionInventoryCurrent ? '' : ' disabled';
  return '<section class="command-preview-panel"><label>' + safe(selectionText('filter'))
    + ' <input id="backup-selection-filter" type="search" value="' + safe(backupSelectionFilter) + '"></label> '
    + '<label>' + safe(selectionText('sort')) + ' <select id="backup-selection-sort"><option value="newest"'
    + (backupSelectionSort === 'newest' ? ' selected' : '') + '>' + safe(selectionText('newest'))
    + '</option><option value="id"' + (backupSelectionSort === 'id' ? ' selected' : '') + '>'
    + safe(selectionText('id')) + '</option></select></label> '
    + '<button type="button" id="backup-selection-all"' + disabled + '>' + safe(selectionText('all')) + '</button> '
    + '<button type="button" id="backup-selection-clear">' + safe(selectionText('clear')) + '</button>'
    + '<p role="status" aria-live="polite">' + safe(selectionText('selected')) + ': ' + summary.count + '; '
    + (summary.bytes === null ? safe(selectionText('unknownSize')) : summary.bytes + ' ' + safe(selectionText('bytes')))
    + '</p>' + (backupSelectionInventoryCurrent ? '' : '<p>' + safe(selectionText('unavailable')) + '</p>') + renderBackupDeletionControls() + '</section>';
}
function renderBackupSelectionCheckbox(row) {
  return '<label><input type="checkbox" data-backup-selection-id="' + safe(row.id) + '"'
    + (selectedBackupIds.has(row.id) ? ' checked' : '') + (backupSelectionInventoryCurrent ? '' : ' disabled')
    + '> ' + safe(selectionText('select')) + ' <code>' + safe(row.id) + '</code></label>';
}
function wireBackupSelectionControls(tab) {
  const rerender = () => renderBackupsTable(tab);
  document.getElementById('backup-selection-filter').addEventListener('input', event => {
    const start = event.target.selectionStart, end = event.target.selectionEnd;
    backupSelectionFilter = event.target.value; rerender();
    const filter = document.getElementById('backup-selection-filter');
    filter.focus();
    if (start !== null && end !== null) filter.setSelectionRange(start, end);
  });
  document.getElementById('backup-selection-sort').addEventListener('change', event => {
    backupSelectionSort = event.target.value; rerender();
    document.getElementById('backup-selection-sort').focus();
  });
  document.getElementById('backup-selection-all').addEventListener('click', () => {
    if (!backupSelectionInventoryCurrent || backupBusy) return;
    backupDeletionPreview = null;
    for (const row of filteredBackupSelectionRows()) selectedBackupIds.add(row.id);
    rerender(); document.getElementById('backup-selection-all').focus();
  });
  document.getElementById('backup-selection-clear').addEventListener('click', () => {
    if (backupBusy) return; backupDeletionPreview = null; backupDeletionRetainedIds.clear(); selectedBackupIds.clear(); rerender(); document.getElementById('backup-selection-clear').focus();
  });
  wireBackupDeletionControls();
  refreshBackupBusyControls();
  for (const input of backupsTableNode.querySelectorAll('input[data-backup-selection-id]')) {
    input.addEventListener('change', () => {
      if (!backupSelectionInventoryCurrent || backupBusy) return;
      backupDeletionPreview = null;
      const id = input.dataset.backupSelectionId;
      if (input.checked) selectedBackupIds.add(id); else { selectedBackupIds.delete(id); backupDeletionRetainedIds.delete(id); }
      rerender();
      for (const next of backupsTableNode.querySelectorAll('input[data-backup-selection-id]')) {
        if (next.dataset.backupSelectionId === id) next.focus();
      }
    });
  }
}
const backupDeletionRetainedIds = new Set();
let backupBusy = false;
let backupDeletionPreview = null;
let backupDeletionMessage = '';
let backupSelectionTab = null;
let backupInventoryIdentity = '';
let backupInventoryRevision = 0;
function cancelBackupDeletion() {
  if (backupBusy) return;
  backupDeletionPreview = null;
  renderBackupsTable(backupSelectionTab);
  document.getElementById('backup-selection-preview').focus();
}
function refreshBackupBusyControls() {
  for (const root of [backupsTableNode, backupsSettingsNode]) {
    for (const node of root.querySelectorAll('button, input, select')) {
      if (backupBusy) {
        if (node.dataset.backupBusyDisabled === undefined) node.dataset.backupBusyDisabled = String(node.disabled);
        node.disabled = true;
      }
      else if (node.dataset.backupBusyDisabled !== undefined) {
        node.disabled = node.dataset.backupBusyDisabled === 'true'; delete node.dataset.backupBusyDisabled;
      }
    }
  }
}
async function runWithBackupBusy(operation) {
  if (backupBusy) return;
  backupBusy = true; refreshBackupBusyControls();
  try { return await operation(); }
  finally { backupBusy = false; renderBackupsTable(backupSelectionTab); refreshBackupBusyControls(); }
}
async function requestBackupDeletion(mode, ids, confirmation, token, finalPoint) {
  const body = { action_id: 'backup-delete-selected', mode, snapshot_ids: ids };
  if (mode === 'execute') Object.assign(body, { confirmation, confirmation_token: token,
    confirm_final_recovery_point: finalPoint });
  const response = await fetch('/api/actions', { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-garda-action-token': actionToken }, body: JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || result.message || selectionText('rejected'));
  return result;
}
async function previewSelectedBackups() {
  if (!actionsEnabled || backupBusy || !backupSelectionInventoryCurrent || !selectedBackupIds.size) return;
  const ids = Array.from(selectedBackupIds).sort();
  const identity = backupInventoryIdentity, revision = backupInventoryRevision;
  backupDeletionPreview = null; backupDeletionMessage = '';
  await runWithBackupBusy(async () => {
    try {
      const result = await requestBackupDeletion('preview', ids);
      const exactIds = Array.isArray(result.snapshotIds) && JSON.stringify(result.snapshotIds.slice().sort()) === JSON.stringify(ids);
      if (revision !== backupInventoryRevision || identity !== backupInventoryIdentity || !backupSelectionInventoryCurrent) throw new Error(selectionText('stale'));
      if (result.status !== 'previewed' || !exactIds || result.irreversible !== true
        || result.confirmation_phrase !== 'DELETE SELECTED BACKUPS' || !/^[a-f0-9]{64}$/.test(result.confirmationToken)
        || !Number.isSafeInteger(result.totalSizeBytes) || result.totalSizeBytes < 0
        || typeof result.requiresFinalRecoveryPointConfirmation !== 'boolean') throw new Error(selectionText('rejected'));
      backupDeletionPreview = { ...result, snapshotIds: ids, inventoryIdentity: identity, inventoryRevision: revision };
      backupDeletionMessage = result.audit_error || '';
    } catch (error) { backupDeletionMessage = String(error.message || error); }
    renderBackupsTable(backupSelectionTab);
  });
  document.getElementById(backupDeletionPreview ? 'backup-selection-phrase' : 'backup-selection-result').focus();
}
async function executeSelectedBackupDeletion(phrase, finalPoint) {
  const preview = backupDeletionPreview;
  if (!actionsEnabled || backupBusy || !preview || !backupSelectionInventoryCurrent
    || preview.inventoryRevision !== backupInventoryRevision || preview.inventoryIdentity !== backupInventoryIdentity
    || JSON.stringify(preview.snapshotIds) !== JSON.stringify(Array.from(selectedBackupIds).sort()) || phrase !== 'DELETE SELECTED BACKUPS'
    || preview.requiresFinalRecoveryPointConfirmation && finalPoint !== true) return;
  backupDeletionPreview = null;
  await runWithBackupBusy(async () => {
    try {
      const result = await requestBackupDeletion('execute', preview.snapshotIds, phrase, preview.confirmationToken, finalPoint === true);
      if (!['executed', 'partial_failure'].includes(result.status) || !Array.isArray(result.removedIds)
        || !Array.isArray(result.requestedIds) || !Array.isArray(result.errors)
        || JSON.stringify(result.requestedIds.slice().sort()) !== JSON.stringify(preview.snapshotIds)
        || result.removedIds.some(id => !preview.snapshotIds.includes(id))) throw new Error(selectionText('uncertain'));
      for (const id of result.removedIds) { selectedBackupIds.delete(id); backupDeletionRetainedIds.delete(id); }
      const retained = preview.snapshotIds.filter(id => !result.removedIds.includes(id));
      for (const id of retained) backupDeletionRetainedIds.add(id);
      if (result.inventoryRefreshed === true && Array.isArray(result.inventory)) {
        backupSelectionTab = { ...backupSelectionTab, rows: result.inventory.map(row => ({
          id: row.id, created_at: row.createdAt || row.created_at, size_bytes: row.sizeBytes ?? row.size_bytes,
          size_human: String(row.sizeBytes ?? row.size_bytes) + ' ' + selectionText('bytes'),
          reason: row.reason, health: row.health, health_message: row.healthMessage
        })), unavailable: (backupSelectionTab.unavailable || []).filter(item => item.scope !== 'backups:inventory') };
        updateBackupSelectionInventory(backupSelectionTab);
      } else {
        backupSelectionTab = { ...backupSelectionTab, unavailable: [{ scope: 'backups:inventory', reason: result.inventoryError || selectionText('stale') }] };
      }
      for (const id of retained) selectedBackupIds.add(id);
      backupDeletionMessage = selectionText('removed') + ': ' + result.removedIds.join(', ')
        + '; ' + selectionText('retained') + ': ' + retained.join(', ')
        + '; ' + result.errors.map(item => item.snapshotId + ': ' + item.message).join('; ')
        + (result.inventoryError ? '; ' + result.inventoryError : '') + (result.audit_error ? '; ' + result.audit_error : '');
    } catch (error) {
      backupDeletionMessage = String(error.message || error);
      backupSelectionTab = { ...backupSelectionTab, unavailable: [{ scope: 'backups:inventory', reason: selectionText('uncertain') }] };
    }
    renderBackupsTable(backupSelectionTab);
  });
  document.getElementById('backup-selection-result').focus();
}
function renderBackupDeletionControls() {
  const preview = backupDeletionPreview;
  const disabled = !actionsEnabled || backupBusy || !backupSelectionInventoryCurrent || !selectedBackupIds.size;
  let html = '<button type="button" id="backup-selection-preview"' + (disabled ? ' disabled' : '') + '>'
    + safe(selectionText('preview')) + '</button>';
  if (preview) html += '<section aria-label="' + safe(selectionText('confirm')) + '"><p>'
    + safe(selectionText('irreversible')) + '</p><p>' + preview.snapshotIds.map(safe).join(', ') + '; '
    + preview.totalSizeBytes + ' ' + safe(selectionText('bytes')) + '; ' + safe(selectionText('lost')) + ': '
    + safe(preview.lostRecoveryPointCount) + '; ' + safe(selectionText('remaining')) + ': ' + safe(preview.remainingRecoveryPointCount)
    + '</p><p>' + (preview.warnings || []).map(safe).join('; ') + '</p>'
    + '<label>' + safe(selectionText('phrase')) + ' DELETE SELECTED BACKUPS <input id="backup-selection-phrase" type="text" autocomplete="off"></label>'
    + (preview.requiresFinalRecoveryPointConfirmation ? '<label><input id="backup-selection-final-point" type="checkbox"> ' + safe(selectionText('finalPoint')) + '</label>' : '')
    + '<button type="button" id="backup-selection-execute">' + safe(selectionText('confirm')) + '</button>'
    + '<button type="button" id="backup-selection-cancel">' + safe(selectionText('cancel')) + '</button></section>';
  return html + '<p id="backup-selection-result" tabindex="-1" role="status" aria-live="polite">' + safe(backupDeletionMessage) + '</p>';
}
function wireBackupDeletionControls() {
  document.getElementById('backup-selection-preview').addEventListener('click', previewSelectedBackups);
  if (!backupDeletionPreview) return;
  document.getElementById('backup-selection-cancel').addEventListener('click', cancelBackupDeletion);
  document.getElementById('backup-selection-execute').addEventListener('click', () => {
    const finalPoint = document.getElementById('backup-selection-final-point');
    return executeSelectedBackupDeletion(document.getElementById('backup-selection-phrase').value, Boolean(finalPoint && finalPoint.checked));
  });
}
`;
