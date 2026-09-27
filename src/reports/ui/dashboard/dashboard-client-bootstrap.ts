/** Browser-side dashboard script fragment (bootstrap). */
export const UI_DASHBOARD_CLIENT_BOOTSTRAP = `for (const tabButton of document.querySelectorAll('nav button[data-tab]')) {
  tabButton.addEventListener('click', () => {
    if (tabButton.dataset.settingGroup) {
      currentWorkflowSettingGroup = tabButton.dataset.settingGroup;
      if (currentSettingsPayload) {
        renderSettingsEditor(currentSettingsPayload);
      }
    }
    for (const button of document.querySelectorAll('nav button[data-tab]')) {
      button.classList.toggle('active', button === tabButton);
    }
    for (const tab of document.querySelectorAll('.tab')) {
      tab.hidden = tab.id !== tabButton.dataset.tab;
    }
  });
}
languageSelectNode.addEventListener('change', () => {
  currentLanguage = normalizeLanguage(languageSelectNode.value);
  try {
    if (window.localStorage) {
      window.localStorage.setItem('garda.ui.language', currentLanguage);
    }
  } catch {}
  applyLanguage();
});
searchNode.addEventListener('input', renderTaskRows);
statusFilterNode.addEventListener('change', renderTaskRows);
priorityFilterNode.addEventListener('change', renderTaskRows);
for (const eventName of ['pointerdown', 'keydown', 'wheel', 'touchstart']) {
  window.addEventListener(eventName, () => markActivity(false), { passive: true });
}
sessionActivityNode.addEventListener('click', () => markActivity(true));
sessionShutdownNode.addEventListener('click', async () => {
  renderSession(await postSession('/api/session/shutdown'));
});
planModalCloseNode.addEventListener('click', closeTaskPlanModal);
planModalNode.addEventListener('click', event => {
  if (event.target === planModalNode) {
    closeTaskPlanModal();
  }
});
refreshSession();
applyLanguage();
document.getElementById('update-check').addEventListener('click', () => refreshUpdateAvailability(true));
void refreshUpdateAvailability(false);
sessionPollTimer = setInterval(refreshSession, 1000);
fetch('/api/report').then(response => response.json()).then(renderTasks).catch(error => {
  tasksNode.innerHTML = '<tr><td colspan="7" class="error">' + safe(error && error.message ? error.message : error) + '</td></tr>';
});
refreshActionsPayload().catch(error => {
  actionsNode.innerHTML = '<p class="error">' + safe(error && error.message ? error.message : error) + '</p>';
});
refreshSettingsPayload().catch(error => {
  settingsEditorNode.innerHTML = '<p class="error">' + safe(error && error.message ? error.message : error) + '</p>';
});
refreshProfilesPayload().catch(error => {
  profilesNode.innerHTML = '<p class="error">' + safe(error && error.message ? error.message : error) + '</p>';
});
refreshBackupsSettingsEditor().catch(() => undefined);
refreshCleanupSettingsPayload().catch(error => {
  cleanupSettingsNode.innerHTML = '<p class="error">' + safe(error && error.message ? error.message : error) + '</p>';
});`;
