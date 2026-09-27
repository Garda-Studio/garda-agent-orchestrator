import { UPDATE_AVAILABILITY_TEXT } from '../update-availability-text';

export function buildDashboardUpdatesClientScript(): string {
    return `const updateAvailabilityPacks = ${JSON.stringify(UPDATE_AVAILABILITY_TEXT)};
let currentUpdateAvailability = {status:'unknown',currentVersion:null,latestVersion:null,updateCommand:null};
let updateCheckPending = false;
let updateCheckWasManual = false;
function renderUpdateAvailability() {
  const pack = updateAvailabilityPacks[currentLanguage];
  const view = currentUpdateAvailability;
  const button = document.getElementById('update-check');
  if (!button) return;
  document.getElementById('update-title').textContent = pack.title;
  button.textContent = pack.checkButton;
  button.setAttribute('aria-label', pack.checkButton);
  button.disabled = updateCheckPending;
  const status = updateCheckPending ? 'checking' : view.status;
  let message = pack.unknown;
  if (status === 'checking') message = pack.checking;
  else if (status === 'disabled') message = pack.automaticDisabled;
  else if (status === 'available') message = pack.available;
  else if (status === 'up_to_date') message = pack.upToDate;
  else if (status === 'unavailable' && updateCheckWasManual) message = pack.error;
  else if (view.currentVersion) message = pack.installed;
  document.getElementById('update-status').textContent = message.replace('{current}', view.currentVersion || '').replace('{latest}', view.latestVersion || '');
  document.getElementById('update-command-label').textContent = pack.commandLabel;
  document.getElementById('update-command').textContent = view.updateCommand || '';
  document.getElementById('update-command-row').hidden = status !== 'available' || !view.updateCommand;
}
async function refreshUpdateAvailability(manual) {
  if (updateCheckPending) return;
  updateCheckPending = true;
  updateCheckWasManual = manual;
  renderUpdateAvailability();
  try {
    const response = await fetch(manual ? '/api/update-availability/check' : '/api/update-availability', manual ? {
      method:'POST', headers:{'Content-Type':'application/json','X-Garda-Action-Token':actionToken}, body:'{}'
    } : {});
    if (!response.ok) throw new Error('Update check unavailable.');
    currentUpdateAvailability = await response.json();
  } catch {
    currentUpdateAvailability = {status:'unavailable',currentVersion:currentUpdateAvailability.currentVersion,latestVersion:null,updateCommand:null};
  } finally {
    updateCheckPending = false;
    renderUpdateAvailability();
  }
}`;
}
