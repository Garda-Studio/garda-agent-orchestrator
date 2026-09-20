import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import * as vm from 'node:vm';
import { UNCONFIGURED_COMPILE_GATE_COMMAND } from '../../../src/core/constants';
import { UI_DASHBOARD_CLIENT_CORE } from '../../../src/reports/ui/dashboard/dashboard-client-core';
import { UI_DASHBOARD_CLIENT_PROFILES } from '../../../src/reports/ui/dashboard/dashboard-client-profiles';
import { UI_DASHBOARD_CLIENT_QUALITY_GATE } from '../../../src/reports/ui/dashboard/dashboard-client-quality-gate';
import { UI_DASHBOARD_CLIENT_SESSION_ACTIONS } from '../../../src/reports/ui/dashboard/dashboard-client-session-actions';
import { UI_DASHBOARD_CLIENT_TASK_DETAIL } from '../../../src/reports/ui/dashboard/dashboard-client-task-detail';
import { UI_DASHBOARD_CLIENT_WORKFLOW } from '../../../src/reports/ui/dashboard/dashboard-client-workflow';
import { UI_DASHBOARD_STYLES } from '../../../src/reports/ui/dashboard/dashboard-styles';
import { renderLocalUiHtml } from '../../../src/reports/ui/ui-dashboard-html';
import {
    LOCAL_UI_LANGUAGES,
    LOCAL_UI_SETTING_TEXT,
    LOCAL_UI_TASK_CLOSURE_POLICY_TEXT,
    LOCAL_UI_TEXT
} from '../../../src/reports/ui/ui-i18n';

const DASHBOARD_ASSET_DIR = join(process.cwd(), 'src/reports/ui/dashboard');

function htmlTagById(html: string, tagName: string, id: string): string {
    const pattern = new RegExp(`<${tagName}\\b[^>]*\\bid="${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*>`, 'u');
    const match = html.match(pattern);
    assert.ok(match, `Expected <${tagName}> with id '${id}'.`);
    return match[0];
}

function htmlButtonByRuleAction(html: string, ruleId: string, action: string): string {
    const rulePattern = `data-quality-gate-rule-id="${ruleId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`;
    const actionPattern = `data-quality-gate-rule-action="${action.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`;
    const pattern = new RegExp(`<button\\b(?=[^>]*\\b${rulePattern})(?=[^>]*\\b${actionPattern})[^>]*>`, 'u');
    const match = html.match(pattern);
    assert.ok(match, `Expected quality-gate ${action} button for '${ruleId}'.`);
    return match[0];
}

function htmlTagHasDisabled(tag: string): boolean {
    return /\sdisabled(?:\s|>|=)/u.test(tag);
}

function htmlTagHasChecked(tag: string): boolean {
    return /\schecked(?:\s|>|=)/u.test(tag);
}

function renderQualityGateHtml(
    qualityGate: Record<string, unknown>,
    actionsEnabled: boolean,
    initialLanguage = 'ru'
): string {
    const qualityGateNode = {
        innerHTML: '',
        querySelectorAll: () => []
    };
    const context = {
        document: {
            querySelectorAll: () => [],
            getElementById: () => null
        },
        window: {
            localStorage: null,
            prompt: () => null
        },
        languageMetadata: LOCAL_UI_LANGUAGES,
        languagePacks: LOCAL_UI_TEXT,
        settingTextPacks: LOCAL_UI_SETTING_TEXT,
        fallbackLanguage: 'en',
        initialLanguage,
        qualityGateNode,
        qualityGateStatusNode: {
            innerHTML: '',
            classList: { toggle: () => {} }
        },
        qualityGateConfigPathNode: { textContent: '' },
        settingsEditorNode: {
            innerHTML: '',
            querySelectorAll: () => []
        },
        workflowNode: { innerHTML: '', hidden: false },
        workflowPanelTitleNode: { textContent: '' },
        workflowConfigPathNode: { textContent: '' },
        currentSettingsPayload: {
            enabled: actionsEnabled,
            settings: [],
            quality_gate: qualityGate
        },
        currentReport: null,
        currentQualityGateSettingResult: null
    };

    vm.runInNewContext(`${UI_DASHBOARD_CLIENT_CORE}\n${UI_DASHBOARD_CLIENT_WORKFLOW}\n${UI_DASHBOARD_CLIENT_QUALITY_GATE}\nrenderQualityGate(null);`, context);
    return qualityGateNode.innerHTML;
}

function renderTaskDetailHtml(
    detail: Record<string, unknown>,
    initialLanguage = 'ru',
    actionsEnabled = false
): string {
    const detailNode = {
        innerHTML: '',
        querySelectorAll: () => []
    };
    const context = {
        document: {
            querySelectorAll: () => [],
            getElementById: () => null
        },
        window: {
            localStorage: null,
            prompt: () => null
        },
        languageMetadata: LOCAL_UI_LANGUAGES,
        languagePacks: LOCAL_UI_TEXT,
        settingTextPacks: LOCAL_UI_SETTING_TEXT,
        taskClosurePolicyTextPacks: LOCAL_UI_TASK_CLOSURE_POLICY_TEXT,
        fallbackLanguage: 'en',
        initialLanguage,
        detailNode,
        actionsEnabled,
        actionToken: 'asset-test-token',
        currentTaskDetail: null,
        loadedTaskDetails: {},
        selectedTaskId: null,
        findReportTask: () => ({
            task_id: detail.task_id,
            title: 'Quality gate task',
            status: 'IN_PROGRESS',
            status_token: 'IN_PROGRESS'
        }),
        artifactList: () => '',
        fetch: async () => ({ ok: false, status: 500, json: async () => ({}) })
    };

    vm.runInNewContext(`${UI_DASHBOARD_CLIENT_CORE}\n${UI_DASHBOARD_CLIENT_TASK_DETAIL}\nrenderTaskDetail(${JSON.stringify(detail)});`, context);
    return detailNode.innerHTML;
}

test('task detail renders independent guarded F-task closure controls and effective diagnostics', () => {
    const html = renderTaskDetailHtml({
        task_id: 'T-1014-F1',
        stats: {},
        audit: {
            blockers: [],
            review_attempt_summary: { by_type: [] },
            review_findings_audit: {
                review_follow_up_task_closure_policy: {
                    ignored_low_findings_count: 2,
                    retained_current_task_count: 1,
                    prohibited_descendant_creation_count: 1,
                    remaining_blocker_count: 1
                }
            }
        },
        review_follow_up_task_closure_policy: {
            stored: { skip_low_findings: true, forbid_child_tasks: false },
            effective: { skip_low_findings: false, forbid_child_tasks: true },
            effective_source: 'task_mode_profile_policy_snapshot',
            state: 'pending_next_cycle',
            editable: true,
            editable_reason: null,
            drift_detected: true,
            diagnostics: ['Stored values apply on the next task-mode entry.']
        },
        full_suite_validation: {},
        quality_checklist: { latest: null, action_required_history: [] },
        latest_cycle_events: {},
        artifact_links: []
    }, 'ru', true);

    assert.match(html, /Политика закрытия F-задачи/u);
    assert.match(html, /Сохранённые значения/u);
    assert.match(html, /Эффективные значения/u);
    assert.match(html, /ignored_low=2/u);
    assert.match(html, /retained_current_task=1/u);
    assert.equal(htmlTagHasChecked(htmlTagById(html, 'input', 'task-closure-skip-low')), true);
    assert.equal(htmlTagHasChecked(htmlTagById(html, 'input', 'task-closure-forbid-children')), false);
    assert.equal(htmlTagHasDisabled(htmlTagById(html, 'input', 'task-closure-skip-low')), false);
    assert.match(UI_DASHBOARD_CLIENT_TASK_DETAIL, /expected_notes_sha256/u);
    assert.match(UI_DASHBOARD_CLIENT_TASK_DETAIL, /currentTaskClosurePolicyPreview = null/u);
    assert.match(UI_DASHBOARD_CLIENT_TASK_DETAIL, /UPDATE F-TASK POLICY/u);
});

test('task detail disables F-task closure controls for inapplicable ordinary tasks', () => {
    const html = renderTaskDetailHtml({
        task_id: 'T-1014',
        stats: {},
        audit: {},
        review_follow_up_task_closure_policy: {
            stored: { skip_low_findings: false, forbid_child_tasks: false },
            effective: { skip_low_findings: false, forbid_child_tasks: false },
            effective_source: 'task_metadata',
            state: 'inapplicable',
            editable: false,
            editable_reason: 'Closure controls apply only to review-generated follow-up tasks.',
            drift_detected: false,
            diagnostics: []
        },
        full_suite_validation: {},
        quality_checklist: { latest: null, action_required_history: [] },
        latest_cycle_events: {},
        artifact_links: []
    }, 'en', true);

    assert.match(html, /Available only for review-generated follow-up tasks/u);
    assert.equal(htmlTagHasDisabled(htmlTagById(html, 'input', 'task-closure-skip-low')), true);
    assert.equal(htmlTagHasDisabled(htmlTagById(html, 'input', 'task-closure-forbid-children')), true);
    assert.equal(htmlTagHasDisabled(htmlTagById(html, 'button', 'task-closure-policy-preview')), true);
    assert.equal(htmlTagHasDisabled(htmlTagById(html, 'button', 'task-closure-policy-apply')), true);
});

function renderProfilesHtml(
    profilesTab: Record<string, unknown>,
    actionsEnabled: boolean,
    initialLanguage = 'en'
): string {
    const profilesNode = {
        innerHTML: '',
        querySelector: () => null,
        querySelectorAll: () => []
    };
    const context = {
        document: {
            querySelectorAll: () => [],
            getElementById: () => null
        },
        window: {
            localStorage: null,
            prompt: () => null
        },
        languageMetadata: LOCAL_UI_LANGUAGES,
        languagePacks: LOCAL_UI_TEXT,
        settingTextPacks: LOCAL_UI_SETTING_TEXT,
        fallbackLanguage: 'en',
        initialLanguage,
        profilesNode,
        profilesStatusNode: { innerHTML: '' },
        profilesConfigPathNode: { textContent: '' },
        currentProfilesPayload: null,
        actionToken: 'test-token',
        fetch: async () => ({ json: async () => ({}) })
    };

    vm.runInNewContext(`${UI_DASHBOARD_CLIENT_CORE}\n${UI_DASHBOARD_CLIENT_WORKFLOW}\n${UI_DASHBOARD_CLIENT_PROFILES}\nrenderProfiles(${JSON.stringify({
        enabled: actionsEnabled,
        ...profilesTab
    })});`, context);
    return profilesNode.innerHTML;
}

test('local UI dashboard renders packaged style and client assets', () => {
    const html = renderLocalUiHtml(true, 'asset-token', 'en');

    assert.match(html, /<style>\s*:root \{ color-scheme: light;/u);
    assert.match(html, /<script>[\s\S]*const actionToken = "asset-token";/u);
    assert.match(html, /data-tab="workflow-tab"/u);
    assert.match(html, /data-tab="quality-gate-tab"/u);
    assert.match(html, /function renderTasks\(report\)/u);
    assert.match(html, /function renderWorkflow\(report\)/u);
    assert.match(html, /function renderQualityGate\(report\)/u);
    assert.match(html, /function renderTaskDetail\(detail\)/u);
});

test('dashboard asset modules are readable template literals, not escaped string blobs', () => {
    const assetSources = readdirSync(DASHBOARD_ASSET_DIR)
        .filter((name) => name.endsWith('.ts'))
        .map((name) => readFileSync(join(DASHBOARD_ASSET_DIR, name), 'utf8'));

    assert.ok(assetSources.some((source) => source.includes('export const UI_DASHBOARD_STYLES = `')));
    assert.ok(assetSources.some((source) => source.includes('export const UI_DASHBOARD_CLIENT_WORKFLOW = `')));
    assert.match(UI_DASHBOARD_STYLES, /quality-gate-rule-table/u);
    assert.doesNotMatch(UI_DASHBOARD_STYLES, /min-width: 1040px/u);
    for (const source of assetSources) {
        assert.doesNotMatch(source, /export const [A-Z0-9_]+ = "(?:\\\\n|[^"]){200,}";/u);
    }
});

test('Compact tab renders settings and cache usage when switching groups without a report refresh', () => {
    const settingsEditorNode = { innerHTML: '', querySelectorAll: () => [] };
    const context = {
        document: { querySelectorAll: () => [] }, window: { localStorage: null },
        languageMetadata: LOCAL_UI_LANGUAGES, languagePacks: LOCAL_UI_TEXT, settingTextPacks: LOCAL_UI_SETTING_TEXT,
        fallbackLanguage: 'en', initialLanguage: 'ru', settingsEditorNode,
        workflowNode: { innerHTML: '', hidden: false }, workflowPanelTitleNode: { textContent: '' },
        currentSettingsPayload: null, currentWorkflowSettingGroup: 'validation',
        currentReport: { workflow_config_tab: { compact_cache: { bytes: 12345, runs: 2, available: true } } }
    };
    const payload = { enabled: true, settings: ['compact.enabled', 'compile_gate.command'].map(key => ({
        id: key === 'compact.enabled' ? 'compact-enabled' : 'compile-gate-command', key,
        label: key, description: '', current_value: true, value_type: 'boolean', options: [], flag: '--test'
    })) };
    vm.runInNewContext(`${UI_DASHBOARD_CLIENT_CORE}\n${UI_DASHBOARD_CLIENT_WORKFLOW}\nrenderSettingsEditor(${JSON.stringify(payload)});`, context);
    assert.doesNotMatch(settingsEditorNode.innerHTML, /12345 bytes/);
    vm.runInNewContext("currentWorkflowSettingGroup = 'compact'; renderSettingsEditor(currentSettingsPayload);", context);
    assert.match(settingsEditorNode.innerHTML, /12345 bytes; 2 runs/);
    assert.match(settingsEditorNode.innerHTML, /compact\.enabled/);
    assert.doesNotMatch(settingsEditorNode.innerHTML, /compile_gate\.command/);
    vm.runInNewContext("currentWorkflowSettingGroup = 'validation'; renderSettingsEditor(currentSettingsPayload);", context);
    assert.doesNotMatch(settingsEditorNode.innerHTML, /12345 bytes/);
});

test('workflow settings editor renders unconfigured compile-gate through localized fallback text', () => {
    const settingsEditorNode = {
        innerHTML: '',
        querySelectorAll: () => []
    };
    const context = {
        document: {
            querySelectorAll: () => []
        },
        window: {
            localStorage: null
        },
        languageMetadata: LOCAL_UI_LANGUAGES,
        languagePacks: LOCAL_UI_TEXT,
        settingTextPacks: LOCAL_UI_SETTING_TEXT,
        fallbackLanguage: 'en',
        initialLanguage: 'ru',
        settingsEditorNode,
        workflowNode: { innerHTML: '', hidden: false },
        workflowPanelTitleNode: { textContent: '' },
        settingStatusNode: { innerHTML: '' },
        currentSettingsPayload: null,
        currentSettingResult: null,
        currentWorkflowSettingGroup: 'validation'
    };

    vm.runInNewContext(`${UI_DASHBOARD_CLIENT_CORE}\n${UI_DASHBOARD_CLIENT_WORKFLOW}\nrenderSettingsEditor({
  enabled: true,
  settings: [{
    id: 'compile-gate-command',
    key: 'compile_gate.command',
    label: 'Compile-gate command',
    description: 'Executable compile/build/type-check command used by compile-gate.',
    current_value: '${UNCONFIGURED_COMPILE_GATE_COMMAND}',
    value_type: 'string',
    options: [],
    flag: '--compile-gate-command',
    placeholder: 'compile/build/type-check command',
    confirmation_phrase: 'APPLY GARDA SETTING'
  }]
});`, context);

    assert.match(settingsEditorNode.innerHTML, /Команда гейта компиляции/u);
    assert.match(settingsEditorNode.innerHTML, /Не задано в workflow-config/u);
    assert.match(settingsEditorNode.innerHTML, /compile-gate блокируется/u);
    const currentValue = settingsEditorNode.innerHTML.match(/<code class="current-value">([^<]+)<\/code>/u)?.[1] || '';
    assert.match(currentValue, /Не задано в workflow-config/u);
    assert.doesNotMatch(currentValue, /__COMPILE_GATE_COMMAND_UNCONFIGURED__/u);
});

test('workflow setting result renderer shows optional-rule validation errors', () => {
    const workflowNode = {
        innerHTML: '',
        hidden: true,
        setAttribute: () => {},
        getAttribute: () => null,
        scrollIntoView: () => {},
        focus: () => {}
    };
    const context = {
        document: {
            querySelectorAll: () => []
        },
        window: {
            localStorage: null
        },
        languageMetadata: LOCAL_UI_LANGUAGES,
        languagePacks: LOCAL_UI_TEXT,
        settingTextPacks: LOCAL_UI_SETTING_TEXT,
        fallbackLanguage: 'en',
        initialLanguage: 'en',
        settingsEditorNode: {
            innerHTML: '',
            querySelectorAll: () => []
        },
        workflowNode,
        workflowPanelTitleNode: { textContent: '' },
        workflowConfigPathNode: { textContent: '' },
        outputBlock: (label: string, value: string) => value ? `<pre data-label="${label}">${value}</pre>` : '',
        currentSettingsPayload: null,
        currentWorkflowSettingResult: null,
        currentWorkflowSettingGroup: 'validation'
    };

    vm.runInNewContext(`${UI_DASHBOARD_CLIENT_CORE}\n${UI_DASHBOARD_CLIENT_WORKFLOW}\nrenderWorkflowSettingResult({
  setting_id: 'optional-check-rule-management',
  key: 'optional_quality_checks.rules',
  code: 'invalid_setting_value',
  error: 'Optional quality-check rule prompt is required.'
});`, context);

    assert.equal(workflowNode.hidden, false);
    assert.match(workflowNode.innerHTML, /Optional quality-check rule/u);
    assert.match(workflowNode.innerHTML, /invalid_setting_value/u);
    assert.match(workflowNode.innerHTML, /Optional quality-check rule prompt is required\./u);
});

test('workflow settings editor omits optional-rule management controls', () => {
    const settingsEditorNode = {
        innerHTML: '',
        querySelectorAll: () => []
    };
    const context = {
        document: {
            querySelectorAll: () => []
        },
        window: {
            localStorage: null
        },
        languageMetadata: LOCAL_UI_LANGUAGES,
        languagePacks: LOCAL_UI_TEXT,
        settingTextPacks: LOCAL_UI_SETTING_TEXT,
        fallbackLanguage: 'en',
        initialLanguage: 'ru',
        settingsEditorNode,
        workflowNode: { innerHTML: '', hidden: false },
        workflowPanelTitleNode: { textContent: '' },
        settingStatusNode: { innerHTML: '' },
        currentSettingsPayload: null,
        currentSettingResult: null,
        currentWorkflowSettingGroup: 'validation'
    };

    vm.runInNewContext(`${UI_DASHBOARD_CLIENT_CORE}\n${UI_DASHBOARD_CLIENT_WORKFLOW}\nrenderSettingsEditor({
  enabled: true,
  optional_quality_checks: {
    enabled: true,
    rules: [{
      id: 'custom_focus',
      title: 'Custom focus',
      prompt: 'Check custom concern.',
      enabled: true
    }]
  },
  settings: [{
    id: 'optional-checks-enabled',
    key: 'optional_quality_checks.enabled',
    label: 'Optional quality checks',
    description: 'Controls optional checks.',
    current_value: true,
    value_type: 'boolean',
    options: [{ value: 'true', label: 'On' }, { value: 'false', label: 'Off' }],
    flag: '--optional-checks-enabled',
    confirmation_phrase: 'APPLY GARDA SETTING'
  }]
});`, context);

    assert.match(settingsEditorNode.innerHTML, /optional_quality_checks\.enabled/u);
    assert.doesNotMatch(settingsEditorNode.innerHTML, /data-optional-rule-action=/u);
    assert.doesNotMatch(settingsEditorNode.innerHTML, /optional-rules-editor/u);
    assert.doesNotMatch(settingsEditorNode.innerHTML, /Добавить правило/u);
    assert.doesNotMatch(settingsEditorNode.innerHTML, /Сохранить правило/u);
    assert.doesNotMatch(settingsEditorNode.innerHTML, /Удалить правило/u);
    assert.doesNotMatch(settingsEditorNode.innerHTML, /Добавить документ/u);
});

test('workflow setting result renderer suppresses routine quality-gate stdout after success', () => {
    const workflowNode = {
        innerHTML: '',
        hidden: true,
        setAttribute: () => {},
        getAttribute: () => null,
        scrollIntoView: () => {},
        focus: () => {}
    };
    const context = {
        document: {
            querySelectorAll: () => []
        },
        window: {
            localStorage: null
        },
        languageMetadata: LOCAL_UI_LANGUAGES,
        languagePacks: LOCAL_UI_TEXT,
        settingTextPacks: LOCAL_UI_SETTING_TEXT,
        fallbackLanguage: 'en',
        initialLanguage: 'en',
        settingsEditorNode: {
            innerHTML: '',
            querySelectorAll: () => []
        },
        workflowNode,
        workflowPanelTitleNode: { textContent: '' },
        workflowConfigPathNode: { textContent: '' },
        outputBlock: (label: string, value: string) => value ? `<pre data-label="${label}">${value}</pre>` : '',
        currentSettingsPayload: null,
        currentWorkflowSettingResult: null,
        currentWorkflowSettingGroup: 'validation'
    };

    const script = `${UI_DASHBOARD_CLIENT_CORE}\n${UI_DASHBOARD_CLIENT_WORKFLOW}`;

    vm.runInNewContext(`${script}\nrenderWorkflowSettingResult({
  status: 'executed',
  setting_id: 'optional-check-rule-management',
  key: 'optional_quality_checks.rules',
  stdout: 'routine success output '.repeat(200),
  stderr: '',
  audit_path: 'runtime/audit.jsonl'
});`, context);

    assert.equal(workflowNode.hidden, false);
    assert.match(workflowNode.innerHTML, /Optional quality-check rule/u);
    assert.match(workflowNode.innerHTML, /runtime\/audit\.jsonl/u);
    assert.doesNotMatch(workflowNode.innerHTML, /routine success output/u);
    assert.doesNotMatch(workflowNode.innerHTML, /data-label="stdout"/u);

    vm.runInNewContext(`renderWorkflowSettingResult({
  status: 'executed',
  setting_id: 'optional-checks-enabled',
  key: 'optional_quality_checks.enabled',
  stdout: 'workflow set success output '.repeat(200),
  stderr: '',
  audit_path: 'runtime/toggle-audit.jsonl'
});`, context);

    assert.match(workflowNode.innerHTML, /Optional quality checks/u);
    assert.match(workflowNode.innerHTML, /runtime\/toggle-audit\.jsonl/u);
    assert.doesNotMatch(workflowNode.innerHTML, /workflow set success output/u);
    assert.doesNotMatch(workflowNode.innerHTML, /data-label="stdout"/u);

    vm.runInNewContext(`renderWorkflowSettingResult({
  status: 'executed',
  setting_id: 'task-reset-enabled',
  key: 'task_reset.enabled',
  changed_keys: ['task_reset.enabled'],
  stdout: 'task reset workflow set success output '.repeat(250),
  stderr: '',
  audit_path: 'runtime/task-reset-audit.jsonl'
});`, context);

    assert.match(workflowNode.innerHTML, /Task reset/u);
    assert.match(workflowNode.innerHTML, /task_reset\.enabled/u);
    assert.match(workflowNode.innerHTML, /runtime\/task-reset-audit\.jsonl/u);
    assert.doesNotMatch(workflowNode.innerHTML, /task reset workflow set success output/u);
    assert.doesNotMatch(workflowNode.innerHTML, /data-label="stdout"/u);
});

test('workflow setting result renderer keeps optional-rule diagnostics on failed execution', () => {
    const workflowNode = {
        innerHTML: '',
        hidden: true,
        setAttribute: () => {},
        getAttribute: () => null,
        scrollIntoView: () => {},
        focus: () => {}
    };
    const context = {
        document: {
            querySelectorAll: () => []
        },
        window: {
            localStorage: null
        },
        languageMetadata: LOCAL_UI_LANGUAGES,
        languagePacks: LOCAL_UI_TEXT,
        settingTextPacks: LOCAL_UI_SETTING_TEXT,
        fallbackLanguage: 'en',
        initialLanguage: 'en',
        settingsEditorNode: {
            innerHTML: '',
            querySelectorAll: () => []
        },
        workflowNode,
        workflowPanelTitleNode: { textContent: '' },
        workflowConfigPathNode: { textContent: '' },
        outputBlock: (label: string, value: string) => value ? `<pre data-label="${label}">${value}</pre>` : '',
        currentSettingsPayload: null,
        currentWorkflowSettingResult: null,
        currentWorkflowSettingGroup: 'validation'
    };

    vm.runInNewContext(`${UI_DASHBOARD_CLIENT_CORE}\n${UI_DASHBOARD_CLIENT_WORKFLOW}\nrenderWorkflowSettingResult({
  status: 'executed',
  setting_id: 'optional-check-rule-management',
  key: 'optional_quality_checks.rules',
  exit_code: 1,
  stdout: 'diagnostic stdout',
  stderr: 'diagnostic stderr'
});`, context);

    assert.match(workflowNode.innerHTML, /diagnostic stdout/u);
    assert.match(workflowNode.innerHTML, /diagnostic stderr/u);
    assert.match(workflowNode.innerHTML, /data-label="stdout"/u);
    assert.match(workflowNode.innerHTML, /data-label="stderr"/u);
});

test('quality gate tab renders baseline custom deleted and edited rule status', () => {
    const qualityGateNode = {
        innerHTML: '',
        querySelectorAll: () => []
    };
    const context = {
        document: {
            querySelectorAll: () => [],
            getElementById: () => null
        },
        window: {
            localStorage: null,
            prompt: () => null
        },
        languageMetadata: LOCAL_UI_LANGUAGES,
        languagePacks: LOCAL_UI_TEXT,
        settingTextPacks: LOCAL_UI_SETTING_TEXT,
        fallbackLanguage: 'en',
        initialLanguage: 'ru',
        qualityGateNode,
        qualityGateStatusNode: {
            innerHTML: '',
            classList: { toggle: () => {} }
        },
        qualityGateConfigPathNode: { textContent: '' },
        settingsEditorNode: {
            innerHTML: '',
            querySelectorAll: () => []
        },
        workflowNode: { innerHTML: '', hidden: false },
        workflowPanelTitleNode: { textContent: '' },
        workflowConfigPathNode: { textContent: '' },
        currentSettingsPayload: {
            enabled: false,
            settings: [],
            quality_gate: {
                config_path: 'garda-agent-orchestrator/live/config/workflow-config.json',
                status: 'present',
                enabled: true,
                baseline_version: '2026-07-08.t934',
                shipped_baseline_version: '2026-07-08.t934',
                baseline_version_label: '2026-07-08',
                shipped_baseline_version_label: '2026-07-08',
                baseline_rule_count: 1,
                custom_rule_count: 1,
                deleted_baseline_rule_count: 1,
                latest_check: {
                    artifact_path: 'garda-agent-orchestrator/runtime/reviews/T-100-quality-checklist.json',
                    artifact_exists: true,
                    evidence_status: 'current',
                    checklist_status: 'ACTION_REQUIRED',
                    outcome: 'FAIL',
                    effect: 'required_rework',
                    summary: 'Quality checklist required rework (1 action item).',
                    stale_reasons: [],
                    task_id: 'T-100',
                    timestamp_utc: '2026-05-16T00:00:00.000Z',
                    preflight_path: 'garda-agent-orchestrator/runtime/reviews/T-100-preflight.json',
                    preflight_sha256: '1'.repeat(64),
                    workflow_config_sha256: '2'.repeat(64),
                    scope_category: 'test-only',
                    changed_files_count: 2,
                    changed_files_preview: ['src/reports/report-data/quality-gate-evidence.ts'],
                    changed_files_truncated: false,
                    enabled_rule_count: 1,
                    active_rule_count: 1,
                    skipped_by_scope_rule_count: 1,
                    skipped_by_scope_rules: [{
                        rule_id: 'size_growth',
                        title: 'Size growth',
                        excluded_scope_categories: ['test-only'],
                        scope_skip_reason: 'Rule is excluded for current scope category: test-only.'
                    }],
                    answer_count: 1,
                    action_taken_count: 0,
                    action_required_count: 1,
                    actions_taken: [],
                    actions_required: ['Extract parser helpers before review.'],
                    answers: [{
                        rule_id: 'code_simplification',
                        status: 'WARN',
                        answer: 'Central parser helpers still need a smaller shape.',
                        evidence_files: ['src/reports/report-data/quality-gate-evidence.ts'],
                        actions_taken: ['Bounded answer summary rendering added.'],
                        actions_required: ['Extract parser helpers before review.']
                    }],
                    timeline_event_count: 1,
                    latest_timeline_event_utc: '2026-05-16T00:00:00.000Z'
                },
                action_required_history: [{
                    task_id: 'T-100',
                    timestamp_utc: '2026-05-16T00:00:00.000Z',
                    artifact_path: 'garda-agent-orchestrator/runtime/reviews/T-100-quality-checklist.json',
                    evidence_status: 'current',
                    action_required_count: 1,
                    actions_required: ['Extract parser helpers before review.'],
                    changed_files_count: 2,
                    changed_files_preview: ['src/reports/report-data/quality-gate-evidence.ts']
                }],
                unavailable: [],
                rules: [
                    {
                        id: 'code_simplification',
                        title: 'Code simplification',
                        prompt: 'Changed locally.',
                        enabled: true,
                        excluded_scope_categories: ['test-only'],
                        present: true,
                        source: 'baseline',
                        statuses: ['locally_edited']
                    },
                    {
                        id: 'custom_focus',
                        title: 'Custom focus',
                        prompt: 'Check custom concern.',
                        enabled: false,
                        excluded_scope_categories: ['future-scope'],
                        present: true,
                        source: 'custom',
                        statuses: ['disabled']
                    },
                    {
                        id: 'duplicated_logic_contracts',
                        title: 'Duplicated logic and contracts',
                        prompt: 'Check duplicated logic.',
                        enabled: false,
                        excluded_scope_categories: ['test-only'],
                        present: false,
                        source: 'baseline',
                        statuses: ['deleted']
                    }
                ]
            }
        },
        currentReport: null,
        currentQualityGateSettingResult: null
    };

    vm.runInNewContext(`${UI_DASHBOARD_CLIENT_CORE}\n${UI_DASHBOARD_CLIENT_WORKFLOW}\n${UI_DASHBOARD_CLIENT_QUALITY_GATE}\nrenderQualityGate(null);`, context);

    assert.doesNotMatch(qualityGateNode.innerHTML, /Поставляемый baseline/u);
    assert.doesNotMatch(qualityGateNode.innerHTML, /Текущий baseline/u);
    assert.doesNotMatch(qualityGateNode.innerHTML, /Удалённые baseline-правила/u);
    assert.doesNotMatch(qualityGateNode.innerHTML, /2026-07-08\.t934/u);
    assert.equal(context.qualityGateConfigPathNode.textContent, '');
    assert.match(qualityGateNode.innerHTML, /Установленный набор правил/u);
    assert.match(qualityGateNode.innerHTML, /Поставляемый набор правил/u);
    assert.match(qualityGateNode.innerHTML, /2026-07-08/u);
    assert.doesNotMatch(qualityGateNode.innerHTML, /\(T-934\)/u);
    assert.match(qualityGateNode.innerHTML, /Изменено локально/u);
    assert.match(qualityGateNode.innerHTML, /Пользовательское/u);
    assert.match(qualityGateNode.innerHTML, /Отключено/u);
    assert.match(qualityGateNode.innerHTML, /Удалено/u);
    assert.match(qualityGateNode.innerHTML, /quality-gate-rule-table/u);
    assert.match(qualityGateNode.innerHTML, /code_simplification/u);
    assert.doesNotMatch(qualityGateNode.innerHTML, /Последняя проверка/u);
    assert.doesNotMatch(qualityGateNode.innerHTML, /Skipped by scope/u);
    assert.doesNotMatch(qualityGateNode.innerHTML, /size_growth/u);
    assert.doesNotMatch(qualityGateNode.innerHTML, /Rule is excluded for current scope category: test-only\./u);
    assert.match(qualityGateNode.innerHTML, /test-only/u);
    assert.match(qualityGateNode.innerHTML, /Excluded scopes/u);
    assert.match(qualityGateNode.innerHTML, /Exclude test-only/u);
    assert.match(qualityGateNode.innerHTML, /Other scopes/u);
    assert.match(qualityGateNode.innerHTML, /future-scope/u);
    assert.equal(htmlTagHasChecked(htmlTagById(qualityGateNode.innerHTML, 'input', 'optional-rule-code_simplification-exclude-test-only')), true);
    assert.equal(htmlTagHasChecked(htmlTagById(qualityGateNode.innerHTML, 'input', 'optional-rule-custom_focus-exclude-test-only')), false);
    assert.equal(htmlTagHasDisabled(htmlTagById(qualityGateNode.innerHTML, 'input', 'optional-rule-custom_focus-exclude-test-only')), true);
    assert.doesNotMatch(qualityGateNode.innerHTML, /Central parser helpers still need a smaller shape\./u);
    assert.doesNotMatch(qualityGateNode.innerHTML, /Bounded answer summary rendering added\./u);
    assert.doesNotMatch(qualityGateNode.innerHTML, /Extract parser helpers before review\./u);
    assert.match(qualityGateNode.innerHTML, /garda ui --actions/u);
});

test('task detail quality checklist diagnostics localize effective policy changes', () => {
    const html = renderTaskDetailHtml({
        task_id: 'T-908',
        stats: {},
        audit: {
            blockers: [],
            review_attempt_summary: {
                total_attempts: 0,
                total_non_test_attempts: 0,
                current_scope_non_test_attempts: 0,
                fresh_non_test_attempts: 0,
                reused_non_test_attempts: 0,
                by_type: []
            }
        },
        full_suite_validation: {
            state: 'not_run',
            duration_human: null
        },
        quality_checklist: {
            latest: {
                artifact_path: 'garda-agent-orchestrator/runtime/reviews/T-908-quality-checklist.json',
                artifact_exists: true,
                evidence_status: 'stale',
                checklist_status: 'PASS',
                outcome: 'PASS',
                effect: 'stale',
                summary_key: 'stale',
                summary: 'Quality checklist artifact is stale: Workflow config effective quality policy changed.',
                stale_reason_codes: ['effective_policy_changed'],
                stale_reasons: ['Workflow config effective quality policy changed after the quality checklist was recorded.'],
                timestamp_utc: '2026-07-03T00:00:00.000Z',
                changed_files_count: 1,
                changed_files_preview: ['src/reports/report-data/quality-gate-evidence.ts'],
                answer_count: 1,
                action_taken_count: 0,
                action_required_count: 0,
                actions_taken: [],
                actions_required: [],
                answers: []
            },
            action_required_history: []
        },
        latest_cycle_events: {},
        artifact_links: []
    }, 'ru');

    assert.match(html, /Устарело/u);
    assert.match(html, /Правила качества/u);
    assert.doesNotMatch(html, /effective_policy_changed/u);
    assert.doesNotMatch(html, /Workflow config effective quality policy changed/u);
});

test('quality gate rule table renders long localized disabled rows in responsive layout', () => {
    const longRuleId = 'baseline_quality_rule_with_long_unbroken_identifier_for_wrap_regression_0123456789';
    const longTitle = 'LongUnbrokenQualityGateRuleTitleThatMustStayInsideTheRulesTableWithoutExpandingTheTab';
    const longPrompt = 'LongUnbrokenQualityGateRulePromptThatExercisesOverflowWrappingForTheRuleDescriptionCellAndInputValue';
    const html = renderQualityGateHtml({
        config_path: 'garda-agent-orchestrator/live/config/workflow-config.json',
        status: 'present',
        enabled: true,
        baseline_rule_count: 1,
        custom_rule_count: 0,
        unavailable: [],
        rules: [{
            id: longRuleId,
            title: longTitle,
            prompt: longPrompt,
            enabled: false,
            present: true,
            source: 'baseline',
            statuses: ['disabled']
        }]
    }, false, 'ru');

    assert.match(html, /workflow-table quality-gate-rule-table/u);
    assert.match(html, new RegExp(longRuleId, 'u'));
    assert.match(html, new RegExp(longTitle, 'u'));
    assert.match(html, new RegExp(longPrompt, 'u'));
    assert.match(html, /Базовое/u);
    assert.match(html, /Отключено/u);
    assert.match(html, /Сохранение отключено/u);
    assert.match(UI_DASHBOARD_STYLES, /\.quality-gate-rule-table th, \.quality-gate-rule-table td \{ overflow-wrap: anywhere; \}/u);
    assert.match(UI_DASHBOARD_STYLES, /\.quality-gate-rule-table input, \.quality-gate-rule-table select \{ width: 100%; min-width: 0; \}/u);
    assert.match(UI_DASHBOARD_STYLES, /\.quality-gate-detail \.quality-gate-rule-table th:nth-child\(8\) \{ width: 13%; min-width: 150px; \}/u);
    assert.match(UI_DASHBOARD_STYLES, /\.quality-gate-rule-table th:nth-child\(8\), \.quality-gate-rule-table td\.quality-gate-rule-actions \{ position: sticky; right: 0;/u);
    assert.match(html, /class="quality-gate-rule-actions"/u);
});

test('quality gate rule table renders new custom row before custom rules and baseline rules', () => {
    const html = renderQualityGateHtml({
        config_path: 'garda-agent-orchestrator/live/config/workflow-config.json',
        status: 'present',
        enabled: true,
        baseline_rule_count: 1,
        custom_rule_count: 1,
        unavailable: [],
        rules: [
            {
                id: 'code_simplification',
                title: 'Code simplification',
                prompt: 'Check simplification.',
                enabled: true,
                excluded_scope_categories: ['test-only'],
                present: true,
                source: 'baseline',
                statuses: ['active']
            },
            {
                id: 'custom_focus',
                title: 'Custom focus',
                prompt: 'Check custom concern.',
                enabled: true,
                present: true,
                source: 'custom',
                statuses: ['active']
            }
        ]
    }, true);

    const newRuleIndex = html.indexOf('data-optional-rule-id="quality-gate-new"');
    const customRuleIndex = html.indexOf('data-optional-rule-id="custom_focus"');
    const baselineRuleIndex = html.indexOf('data-optional-rule-id="code_simplification"');
    assert.ok(newRuleIndex >= 0, 'Expected the new custom rule row to render.');
    assert.ok(customRuleIndex >= 0, 'Expected the custom rule row to render.');
    assert.ok(baselineRuleIndex >= 0, 'Expected the baseline rule row to render.');
    assert.ok(newRuleIndex < customRuleIndex, 'Expected the new custom rule row before existing custom rules.');
    assert.ok(customRuleIndex < baselineRuleIndex, 'Expected custom rules before baseline rules.');
});

test('system state renders quality baseline diagnostics with localized labels', () => {
    const systemStateNode = {
        innerHTML: '',
        querySelectorAll: () => []
    };
    const context = {
        document: {
            querySelectorAll: () => [],
            getElementById: (id: string) => id === 'system-state-panel' ? systemStateNode : null
        },
        window: {
            localStorage: null,
            prompt: () => null
        },
        languageMetadata: LOCAL_UI_LANGUAGES,
        languagePacks: LOCAL_UI_TEXT,
        settingTextPacks: LOCAL_UI_SETTING_TEXT,
        actionTextPacks: {},
        actionCategoryTextPacks: {},
        fallbackLanguage: 'en',
        initialLanguage: 'ru',
        actionToken: '',
        currentActionsPayload: null,
        currentReport: null,
        gardaSwitchNode: null,
        actionStatusNode: { innerHTML: '' },
        sessionSummaryNode: { innerHTML: '' },
        sessionCountdownNode: { max: '', value: '' },
        sessionPollTimer: null,
        lastActivityPingAt: 0,
        fetch: async () => ({ json: async () => ({}) }),
        setInterval: () => 0,
        clearInterval: () => {}
    };

    vm.runInNewContext(`${UI_DASHBOARD_CLIENT_CORE}\n${UI_DASHBOARD_CLIENT_SESSION_ACTIONS}\nrenderSystemState({
        generated_at_utc: '2026-05-16T00:00:00.000Z',
        system_state: {
            overall: { status: 'attention', label: 'Needs attention', summary: 'One or more System State signals need attention.', generated_at_utc: '2026-05-16T00:00:00.000Z' },
            garda: null,
            ui_actions: null,
            task_queue: null,
            workflow: null,
            quality_baseline: {
                id: 'quality-baseline',
                label: 'Installed quality rules',
                status: 'attention',
                summary: 'Installed quality rule-pack version is older than the shipped baseline.',
                remediation: 'Run update or workflow validation.',
                value: {
                    installed_baseline_version: '2026-06-25.t842',
                    shipped_baseline_version: '2026-07-08.t934',
                    installed_baseline_rule_count: 9,
                    shipped_baseline_rule_count: 12,
                    missing_shipped_rule_ids: ['duplicated_logic_contracts']
                },
                source_path: 'garda-agent-orchestrator/live/config/workflow-config.json'
            },
            project_memory: null,
            protected_manifest: null,
            runtime: {},
            configuration_files: [],
            signals: []
        }
    });`, context);

    assert.match(systemStateNode.innerHTML, /Установленные правила качества/u);
    assert.match(systemStateNode.innerHTML, /Установленный набор правил/u);
    assert.match(systemStateNode.innerHTML, /Поставляемый набор правил/u);
    assert.match(systemStateNode.innerHTML, /2026-06-25/u);
    assert.match(systemStateNode.innerHTML, /2026-07-08/u);
    assert.doesNotMatch(systemStateNode.innerHTML, /\(T-842\)|\(T-934\)/u);
    assert.doesNotMatch(systemStateNode.innerHTML, /2026-06-25\.t842/u);
    assert.match(systemStateNode.innerHTML, /Отсутствующие поставляемые правила/u);
    assert.match(systemStateNode.innerHTML, /duplicated_logic_contracts/u);
});

test('system state hides scope-budget signal card and excludes it from overall health', () => {
    const systemStateNode = {
        innerHTML: '',
        querySelectorAll: () => []
    };
    const context = {
        document: {
            querySelectorAll: () => [],
            getElementById: (id: string) => id === 'system-state-panel' ? systemStateNode : null
        },
        window: {
            localStorage: null,
            prompt: () => null
        },
        languageMetadata: LOCAL_UI_LANGUAGES,
        languagePacks: LOCAL_UI_TEXT,
        settingTextPacks: LOCAL_UI_SETTING_TEXT,
        actionTextPacks: {},
        actionCategoryTextPacks: {},
        fallbackLanguage: 'en',
        initialLanguage: 'ru',
        actionToken: '',
        currentActionsPayload: null,
        currentReport: null,
        gardaSwitchNode: null,
        actionStatusNode: { innerHTML: '' },
        sessionSummaryNode: { innerHTML: '' },
        sessionCountdownNode: { max: '', value: '' },
        sessionPollTimer: null,
        lastActivityPingAt: 0,
        fetch: async () => ({ json: async () => ({}) }),
        setInterval: () => 0,
        clearInterval: () => {}
    };

    vm.runInNewContext(`${UI_DASHBOARD_CLIENT_CORE}\n${UI_DASHBOARD_CLIENT_SESSION_ACTIONS}\nrenderSystemState({
        generated_at_utc: '2026-05-16T00:00:00.000Z',
        system_state: {
            overall: { status: 'ok', label: 'Healthy', summary: 'Core System State signals look healthy.', generated_at_utc: '2026-05-16T00:00:00.000Z' },
            garda: null,
            ui_actions: null,
            task_queue: null,
            workflow: null,
            quality_baseline: null,
            project_memory: null,
            protected_manifest: null,
            runtime: {},
            configuration_files: [],
            signals: [
                {
                    id: 'scope-budget',
                    label: 'Scope budget guard',
                    status: 'error',
                    summary: 'Scope budget exceeded for the active task.',
                    remediation: null,
                    value: {}
                },
                {
                    id: 'workflow-readiness',
                    label: 'Workflow readiness',
                    status: 'ok',
                    summary: 'Workflow configuration is valid.',
                    remediation: null,
                    value: {}
                }
            ]
        }
    });`, context);

    assert.doesNotMatch(systemStateNode.innerHTML, /Scope budget guard/u);
    assert.doesNotMatch(systemStateNode.innerHTML, /Scope budget exceeded for the active task\./u);
    assert.match(systemStateNode.innerHTML, /Workflow configuration is valid\./u);
    assert.match(systemStateNode.innerHTML, /Core System State signals look healthy\./u);
    assert.doesNotMatch(systemStateNode.innerHTML, /data-blockers/u);
});

test('quality gate tab keeps baseline rule content immutable while enabled state remains editable', () => {
    const html = renderQualityGateHtml({
        config_path: 'garda-agent-orchestrator/live/config/workflow-config.json',
        status: 'present',
        enabled: true,
        baseline_version: '2026-07-08.t934',
        shipped_baseline_version: '2026-07-08.t934',
        baseline_version_label: '2026-07-08',
        shipped_baseline_version_label: '2026-07-08',
        baseline_rule_count: 2,
        custom_rule_count: 1,
        deleted_baseline_rule_count: 0,
        latest_check: {
            evidence_status: 'missing',
            stale_reasons: [],
            actions_taken: [],
            actions_required: [],
            answers: []
        },
        action_required_history: [],
        unavailable: [],
        rules: [
            {
                id: 'code_simplification',
                title: 'Code simplification',
                prompt: 'Check simplification.',
                enabled: true,
                excluded_scope_categories: ['test-only'],
                present: true,
                source: 'baseline',
                statuses: ['active']
            },
            {
                id: 'project_style_fit',
                title: 'Project style fit',
                prompt: 'Check local style fit.',
                enabled: true,
                present: true,
                source: 'baseline',
                statuses: ['active']
            },
            {
                id: 'custom_focus',
                title: 'Custom focus',
                prompt: 'Check custom concern.',
                enabled: false,
                present: true,
                source: 'custom',
                statuses: ['disabled']
            }
        ]
    }, true);

    assert.equal(htmlTagHasDisabled(htmlTagById(html, 'input', 'optional-rule-code_simplification-title')), true);
    assert.equal(htmlTagHasDisabled(htmlTagById(html, 'input', 'optional-rule-code_simplification-prompt')), true);
    assert.equal(htmlTagHasDisabled(htmlTagById(html, 'select', 'optional-rule-code_simplification-enabled')), false);
    assert.equal(htmlTagHasDisabled(htmlTagById(html, 'input', 'optional-rule-code_simplification-exclude-test-only')), false);
    assert.equal(htmlTagHasChecked(htmlTagById(html, 'input', 'optional-rule-code_simplification-exclude-test-only')), true);
    assert.equal(htmlTagHasChecked(htmlTagById(html, 'input', 'optional-rule-project_style_fit-exclude-test-only')), false);
    assert.match(html, /<td class="quality-gate-rule-actions">/u);
    assert.equal(htmlTagHasDisabled(htmlButtonByRuleAction(html, 'code_simplification', 'upsert')), false);
    assert.match(htmlButtonByRuleAction(html, 'code_simplification', 'upsert'), /data-quality-gate-rule-source="baseline"/u);
    assert.equal(htmlTagHasDisabled(htmlButtonByRuleAction(html, 'code_simplification', 'delete')), true);

    assert.equal(htmlTagHasDisabled(htmlTagById(html, 'input', 'optional-rule-custom_focus-title')), false);
    assert.equal(htmlTagHasDisabled(htmlTagById(html, 'input', 'optional-rule-custom_focus-prompt')), false);
    assert.equal(htmlTagHasDisabled(htmlTagById(html, 'select', 'optional-rule-custom_focus-enabled')), false);
    assert.equal(htmlTagHasDisabled(htmlTagById(html, 'input', 'optional-rule-custom_focus-exclude-test-only')), false);
    assert.equal(htmlTagHasChecked(htmlTagById(html, 'input', 'optional-rule-custom_focus-exclude-test-only')), false);
    assert.match(htmlButtonByRuleAction(html, 'custom_focus', 'upsert'), /data-quality-gate-rule-source="custom"/u);
    assert.equal(htmlTagHasDisabled(htmlButtonByRuleAction(html, 'custom_focus', 'delete')), false);
    assert.equal(htmlTagHasChecked(htmlTagById(html, 'input', 'optional-rule-quality-gate-new-exclude-test-only')), false);
});

test('profiles tab renders required auto disabled policy controls without trigger editors', () => {
    const profilesTab = {
        status: 'present',
        config_path: 'garda-agent-orchestrator/live/config/profiles.json',
        active_profile: 'custom-review',
        unavailable: [],
        finding_policy_actions: ['fix_now', 'create_follow_up', 'ignore'],
        finding_policy_presets: {
            soft: {
                schema_version: 1,
                policy_id: 'soft',
                findings: { critical: 'fix_now', high: 'create_follow_up', medium: 'ignore', low: 'ignore' },
                residual_risk: 'ignore'
            },
            balanced: {
                schema_version: 1,
                policy_id: 'balanced',
                findings: { critical: 'fix_now', high: 'fix_now', medium: 'fix_now', low: 'create_follow_up' },
                residual_risk: 'create_follow_up'
            },
            strict: {
                schema_version: 1,
                policy_id: 'strict',
                findings: { critical: 'fix_now', high: 'fix_now', medium: 'fix_now', low: 'fix_now' },
                residual_risk: 'fix_now'
            }
        },
        review_types: [
            { id: 'code', label: 'Code' },
            { id: 'test', label: 'Test' },
            { id: 'performance', label: 'Performance' }
        ],
        profiles: [
            {
                name: 'custom-review',
                source: 'user',
                protected: false,
                active: true,
                description: 'Custom profile',
                depth: 2,
                task_decomposition: {
                    enabled: false,
                    configured: true,
                    provenance: 'explicit_profile_config'
                },
                review_policy: {
                    code: true,
                    test: 'auto',
                    performance: false
                },
                review_finding_policy: {
                    schema_version: 1,
                    policy_id: 'custom',
                    findings: { critical: 'fix_now', high: 'fix_now', medium: 'create_follow_up', low: 'ignore' },
                    residual_risk: 'create_follow_up'
                },
                review_follow_up_policy: {
                    schema_version: 1,
                    materialization_mode: 'grouped_by_parent',
                    task_profile: { mode: 'one_level_lighter', fixed_profile: null }
                },
                review_follow_up_task_profile_assignment: {
                    parent_profile: 'custom-review',
                    profile: 'custom-review',
                    source: 'safe_inherit_parent',
                    configured_mode: 'one_level_lighter',
                    diagnostics: ['Custom profiles safely inherit the parent.']
                },
                review_remediation_mode_policy: {
                    configured: true,
                    legacy_full_only: false,
                    policy_id: 'conservative_review_remediation_mode_v1',
                    initial_review_mode: 'FULL',
                    delta_eligible_review_types: ['code', 'test'],
                    max_delta_changed_files: 4,
                    max_delta_changed_lines: 240,
                    max_consecutive_delta_reviews: 3,
                    diagnostics: ['Explicit DELTA policy.']
                }
            },
            {
                name: 'balanced',
                source: 'built_in',
                protected: true,
                active: false,
                description: 'Default profile',
                depth: 2,
                review_policy: {
                    code: true,
                    test: true,
                    performance: 'auto'
                },
                review_finding_policy: {
                    schema_version: 1,
                    policy_id: 'balanced',
                    findings: { critical: 'fix_now', high: 'fix_now', medium: 'fix_now', low: 'create_follow_up' },
                    residual_risk: 'create_follow_up'
                },
                review_remediation_mode_policy: {
                    configured: false,
                    legacy_full_only: true,
                    policy_id: 'conservative_review_remediation_mode_v1',
                    initial_review_mode: 'FULL',
                    delta_eligible_review_types: [],
                    max_delta_changed_files: 4,
                    max_delta_changed_lines: 240,
                    max_consecutive_delta_reviews: 3,
                    diagnostics: ['Legacy profile remains FULL-only.']
                }
            }
        ]
    };
    const html = renderProfilesHtml(profilesTab, true);
    const russianHtml = renderProfilesHtml(profilesTab, true, 'ru');
    const legacyHtml = renderProfilesHtml({
        ...profilesTab,
        active_profile: 'balanced',
        profiles: profilesTab.profiles.map(profile => ({
            ...profile,
            active: profile.name === 'balanced'
        }))
    }, true);
    const configuredFullOnlyHtml = renderProfilesHtml({
        ...profilesTab,
        profiles: profilesTab.profiles.map(profile => profile.name === 'custom-review'
            ? {
                ...profile,
                review_remediation_mode_policy: {
                    ...profile.review_remediation_mode_policy,
                    delta_eligible_review_types: []
                }
            }
            : profile)
    }, true);

    const addProfileIndex = html.indexOf('class="profile-add-row"');
    const userProfileTabIndex = html.indexOf('data-profile-tab="custom-review"');
    const builtInProfileTabIndex = html.indexOf('data-profile-tab="balanced"');
    const selectedProfileIndex = html.indexOf('data-profile-name="custom-review"');
    assert.ok(addProfileIndex >= 0, 'Expected add-profile row to render first.');
    assert.ok(userProfileTabIndex >= 0, 'Expected user profile tab to render.');
    assert.ok(builtInProfileTabIndex >= 0, 'Expected built-in profile tab to render.');
    assert.ok(selectedProfileIndex >= 0, 'Expected selected profile card to render.');
    assert.ok(addProfileIndex < userProfileTabIndex, 'Expected add-profile row before profile tabs.');
    assert.ok(userProfileTabIndex < builtInProfileTabIndex, 'Expected user profile tabs before built-in profile tabs.');
    assert.ok(builtInProfileTabIndex < selectedProfileIndex, 'Expected selected profile editor after local profile tabs.');
    assert.doesNotMatch(html, /data-profile-name="balanced"/u);
    assert.match(html, /class="profile-tab-button active"[^>]*data-profile-tab="custom-review"/u);
    assert.match(html, /<label class="profile-policy-required">[\s\S]*id="profile-custom-review-review-code"/u);
    assert.match(html, /<label class="profile-policy-auto">[\s\S]*id="profile-custom-review-review-test"/u);
    assert.match(html, /<label class="profile-policy-disabled">[\s\S]*id="profile-custom-review-review-performance"/u);
    assert.match(UI_DASHBOARD_STYLES, /\.profile-policy-grid label\.profile-policy-required/u);
    assert.match(UI_DASHBOARD_STYLES, /\.profile-policy-grid label\.profile-policy-auto/u);
    assert.match(UI_DASHBOARD_STYLES, /\.profile-policy-grid label\.profile-policy-disabled/u);
    assert.match(html, /id="profile-custom-review-review-code"[\s\S]*<option value="required" selected>[\s\S]*?<\/option>[\s\S]*<option value="auto">[\s\S]*?<\/option>[\s\S]*<option value="disabled">[\s\S]*?<\/option>/u);
    assert.match(html, /id="profile-custom-review-review-test"[\s\S]*<option value="required">[\s\S]*?<\/option>[\s\S]*<option value="auto" selected>[\s\S]*?<\/option>[\s\S]*<option value="disabled">[\s\S]*?<\/option>/u);
    assert.match(html, /id="profile-custom-review-review-performance"[\s\S]*<option value="required">[\s\S]*?<\/option>[\s\S]*<option value="auto">[\s\S]*?<\/option>[\s\S]*<option value="disabled" selected>[\s\S]*?<\/option>/u);
    assert.match(html, /<fieldset class="profile-finding-policy"><legend>Finding disposition<\/legend>/u);
    assert.match(html, /Changes affect future tasks only/u);
    assert.match(html, /<span>Policy preset<\/span>/u);
    assert.match(html, /<span>Critical<\/span><select[^>]*aria-label="Critical"/u);
    assert.match(html, /<span>High<\/span><select[^>]*aria-label="High"/u);
    assert.match(html, /<span>Medium<\/span><select[^>]*aria-label="Medium"/u);
    assert.match(html, /<span>Low<\/span><select[^>]*aria-label="Low"/u);
    assert.match(html, /<span>Residual risk<\/span><select[^>]*aria-label="Residual risk"/u);
    assert.doesNotMatch(html, /<span>policy_id<\/span>|aria-label="(?:critical|high|medium|low|residual_risk)"/u);
    assert.match(html, /id="profile-custom-review-finding-critical"[^>]* disabled[^>]*>[\s\S]*<option value="fix_now" selected>Fix now<\/option>/u);
    assert.match(html, /<option value="create_follow_up">Create follow-up task<\/option>/u);
    assert.match(html, /<option value="ignore">Accept without follow-up<\/option>/u);
    assert.match(html, /id="profile-custom-review-finding-preset"[\s\S]*<option value="soft">Lenient<\/option>[\s\S]*<option value="balanced">Balanced<\/option>[\s\S]*<option value="strict">Strict<\/option>[\s\S]*<option value="custom" selected>Custom<\/option>/u);
    assert.doesNotMatch(html, />(?:fix_now|create_follow_up|ignore)<\/option>/u);
    assert.match(russianHtml, /<option value="fix_now" selected>Исправить сейчас<\/option>/u);
    assert.match(russianHtml, /<option value="create_follow_up">Создать отдельную задачу<\/option>/u);
    assert.match(russianHtml, /<option value="ignore">Принять без отдельной задачи<\/option>/u);
    assert.match(russianHtml, /<option value="custom" selected>Пользовательский<\/option>/u);
    assert.match(russianHtml, /Замечание сохраняется, но не блокирует задачу/u);
    assert.match(html, /<span>Guarded task decomposition<\/span>/u);
    assert.match(html, /<strong>Effective source:<\/strong> <code>explicit_profile_config<\/code>/u);
    assert.match(russianHtml, /<span>Контролируемая декомпозиция задач<\/span>/u);
    assert.match(russianHtml, /<strong>Фактический источник:<\/strong> <code>explicit_profile_config<\/code>/u);
    assert.match(html, /class="empty profile-follow-up-task-profile-effective"><strong>Current value:<\/strong> <code>custom-review<\/code> \(Same as parent\)/u);
    assert.match(russianHtml, /class="empty profile-follow-up-task-profile-effective"><strong>Текущее значение:<\/strong> <code>custom-review<\/code> \(Как у родителя\)/u);
    assert.match(html, /<fieldset class="profile-delta-review"><legend>DELTA · Reviews<\/legend>/u);
    assert.match(html, /<strong>Effective source:<\/strong> <code>explicit_profile_config<\/code>/u);
    assert.match(html, /id="profile-custom-review-delta-review-code" type="checkbox" checked/u);
    assert.match(html, /id="profile-custom-review-delta-review-test" type="checkbox" checked/u);
    assert.match(html, /id="profile-custom-review-delta-review-performance" type="checkbox">/u);
    assert.match(html, /<summary>Runtime diagnostics<\/summary>[\s\S]*Explicit DELTA policy\./u);
    assert.match(russianHtml, /<fieldset class="profile-delta-review"><legend>DELTA · Ревью<\/legend>/u);
    assert.match(russianHtml, /<strong>Фактический источник:<\/strong> <code>explicit_profile_config<\/code>/u);
    assert.match(configuredFullOnlyHtml, /<fieldset class="profile-delta-review">[\s\S]*?<strong>Current value:<\/strong> <code>FULL<\/code><\/p>/u);
    assert.match(legacyHtml, /<strong>Effective source:<\/strong> <code>legacy_full_only<\/code>[\s\S]*<strong>Current value:<\/strong> <code>FULL<\/code>/u);
    assert.doesNotMatch(legacyHtml, /id="profile-balanced-delta-review-(?:code|test|performance)"[^>]* checked/u);
    assert.match(UI_DASHBOARD_STYLES, /\.profile-delta-review-grid label\.profile-delta-enabled/u);
    assert.match(UI_DASHBOARD_STYLES, /\.profile-delta-review-grid label\.profile-delta-disabled/u);
    assert.match(html, /data-profile-policy-action="copy" data-profile-name="custom-review"/u);
    assert.match(html, /data-profile-policy-action="reset" data-profile-name="custom-review"/u);
    assert.match(html, /data-profile-policy-action="apply" data-profile-name="custom-review"/u);
    assert.match(UI_DASHBOARD_CLIENT_PROFILES, /presetInput\.value = 'custom'/u);
    assert.match(UI_DASHBOARD_STYLES, /\.profile-finding-policy-grid \.profile-finding-critical/u);
    assert.doesNotMatch(html, /data-profile-trigger|profileTrigger|review_trigger/u);
});

test('follow-up task profile controls toggle fixed selection and serialize the selected mode', () => {
    type BrowserElement = {
        value: string;
        checked: boolean;
        disabled: boolean;
        dataset: Record<string, string>;
        listeners: Record<string, () => void>;
        addEventListener: (event: string, listener: () => void) => void;
        closest: () => { dataset: { profileName: string } };
    };
    const profileName = 'balanced';
    const createElement = (value = ''): BrowserElement => ({
        value,
        checked: false,
        disabled: false,
        dataset: {},
        listeners: {},
        addEventListener(event: string, listener: () => void) {
            this.listeners[event] = listener;
        },
        closest: () => ({ dataset: { profileName } })
    });
    const description = createElement('Balanced profile');
    const depth = createElement('2');
    const taskDecomposition = createElement();
    const mode = createElement('one_level_lighter');
    const fixedProfile = createElement('fast');
    fixedProfile.disabled = true;
    const elementsById: Record<string, BrowserElement> = {
        [`profile-${profileName}-description`]: description,
        [`profile-${profileName}-depth`]: depth,
        [`profile-${profileName}-task-decomposition`]: taskDecomposition,
        [`profile-${profileName}-follow-up-mode`]: mode,
        [`profile-${profileName}-follow-up-fixed-profile`]: fixedProfile
    };
    const context: Record<string, unknown> = {
        currentProfilesPayload: {
            review_types: [],
            profiles: [{
                name: profileName,
                review_follow_up_policy: { materialization_mode: 'grouped_by_parent' }
            }]
        },
        profilesNode: {
            querySelector: (selector: string) => selector.includes('follow-up-mode') ? mode : null
        },
        document: {
            getElementById: (id: string) => elementsById[id] || null
        },
        serialized: [] as string[]
    };

    vm.runInNewContext(
        `${UI_DASHBOARD_CLIENT_PROFILES}\nattachProfileFollowUpTaskProfileHandlers();`,
        context
    );

    mode.value = 'fixed_profile';
    mode.listeners.change();
    assert.equal(fixedProfile.disabled, false);
    vm.runInNewContext(`serialized.push(JSON.stringify(readProfileForm('${profileName}')));`, context);

    mode.value = 'inherit_parent';
    mode.listeners.change();
    assert.equal(fixedProfile.disabled, true);
    vm.runInNewContext(`serialized.push(JSON.stringify(readProfileForm('${profileName}')));`, context);

    const [fixedPayload, inheritedPayload] = (context.serialized as string[]).map((value) => JSON.parse(value));
    assert.deepEqual(fixedPayload.review_follow_up_policy.task_profile, {
        mode: 'fixed_profile',
        fixed_profile: 'fast'
    });
    assert.deepEqual(fixedPayload.task_decomposition, { enabled: false });
    assert.deepEqual(inheritedPayload.review_follow_up_policy.task_profile, {
        mode: 'inherit_parent',
        fixed_profile: null
    });
    assert.deepEqual(inheritedPayload.task_decomposition, { enabled: false });
});

test('profile DELTA controls serialize each review lane and preserve legacy FULL-only state until enabled', () => {
    const profileName = 'balanced';
    const element = (value = '', checked = false) => ({ value, checked });
    const elementsById: Record<string, { value: string; checked: boolean }> = {
        [`profile-${profileName}-description`]: element('Balanced'),
        [`profile-${profileName}-depth`]: element('2'),
        [`profile-${profileName}-task-decomposition`]: element('', true),
        [`profile-${profileName}-follow-up-mode`]: element('one_level_lighter'),
        [`profile-${profileName}-follow-up-fixed-profile`]: element(''),
        [`profile-${profileName}-review-code`]: element('auto'),
        [`profile-${profileName}-review-test`]: element('required'),
        [`profile-${profileName}-review-performance`]: element('disabled'),
        [`profile-${profileName}-delta-review-code`]: element('', true),
        [`profile-${profileName}-delta-review-test`]: element('', false),
        [`profile-${profileName}-delta-review-performance`]: element('', true)
    };
    const remediationSummary = {
        configured: true,
        legacy_full_only: false,
        delta_eligible_review_types: ['code', 'performance']
    };
    const context: Record<string, unknown> = {
        currentProfilesPayload: {
            review_types: [{ id: 'code' }, { id: 'test' }, { id: 'performance' }],
            profiles: [{
                name: profileName,
                review_follow_up_policy: { materialization_mode: 'grouped_by_parent' },
                review_remediation_mode_policy: remediationSummary
            }]
        },
        document: {
            getElementById: (id: string) => elementsById[id] || null
        },
        serialized: [] as string[]
    };

    vm.runInNewContext(
        `${UI_DASHBOARD_CLIENT_PROFILES}\nserialized.push(JSON.stringify(readProfileForm('${profileName}')));`,
        context
    );
    const configuredPayload = JSON.parse((context.serialized as string[])[0]);
    assert.deepEqual(configuredPayload.review_remediation_mode_policy, {
        delta_eligible_review_types: ['code', 'performance']
    });

    remediationSummary.configured = false;
    remediationSummary.legacy_full_only = true;
    elementsById[`profile-${profileName}-delta-review-code`].checked = false;
    elementsById[`profile-${profileName}-delta-review-performance`].checked = false;
    vm.runInNewContext(`serialized.push(JSON.stringify(readProfileForm('${profileName}')));`, context);
    const legacyPayload = JSON.parse((context.serialized as string[])[1]);
    assert.equal(Object.hasOwn(legacyPayload, 'review_remediation_mode_policy'), false);

    elementsById[`profile-${profileName}-delta-review-test`].checked = true;
    vm.runInNewContext(`serialized.push(JSON.stringify(readProfileForm('${profileName}')));`, context);
    const enabledLegacyPayload = JSON.parse((context.serialized as string[])[2]);
    assert.deepEqual(enabledLegacyPayload.review_remediation_mode_policy, {
        delta_eligible_review_types: ['test']
    });
});

test('task detail renders skipped quality-check cadence as a neutral localized state', () => {
    const detail = {
        task_id: 'T-909',
        stats: {},
        audit: {},
        full_suite_validation: {},
        quality_checklist: {
            latest: {
                evidence_status: 'current',
                checklist_status: 'SKIPPED_CADENCE',
                effect: 'skipped_cadence',
                summary_key: 'skipped_cadence',
                answer_count: 0,
                action_taken_count: 0,
                action_required_count: 0,
                stale_reason_codes: [],
                stale_reasons: []
            },
            action_required_history: []
        },
        latest_cycle_events: {},
        artifact_links: []
    };

    const englishHtml = renderTaskDetailHtml(detail, 'en');
    const russianHtml = renderTaskDetailHtml(detail, 'ru');
    assert.match(englishHtml, /Skipped — not due yet/u);
    assert.doesNotMatch(englishHtml, />Passed</u);
    assert.match(russianHtml, /Пропущено — пока не требуется/u);
});

test('profile finding policy handlers apply presets and submit copy reset and custom payloads', () => {
    type BrowserElement = {
        value: string;
        dataset: Record<string, string>;
        listeners: Record<string, () => void>;
        addEventListener: (event: string, listener: () => void) => void;
        closest: () => { dataset: { profileName: string } };
    };
    const profileName = 'custom-review';
    const createElement = (value = '', dataset: Record<string, string> = {}): BrowserElement => {
        const element = {
            value,
            dataset,
            listeners: {} as Record<string, () => void>,
            addEventListener(event: string, listener: () => void) {
                this.listeners[event] = listener;
            },
            closest: () => ({ dataset: { profileName } })
        };
        return element;
    };
    const preset = createElement('strict');
    const critical = createElement('fix_now', { profileFindingAction: 'critical' });
    const high = createElement('create_follow_up', { profileFindingAction: 'high' });
    const medium = createElement('create_follow_up', { profileFindingAction: 'medium' });
    const low = createElement('ignore', { profileFindingAction: 'low' });
    const residualRisk = createElement('ignore', { profileFindingAction: 'residual_risk' });
    const copyFrom = createElement('balanced');
    const copy = createElement('', { profileName, profilePolicyAction: 'copy' });
    const reset = createElement('', { profileName, profilePolicyAction: 'reset' });
    const apply = createElement('', { profileName, profilePolicyAction: 'apply' });
    const elementsById: Record<string, BrowserElement> = {
        [`profile-${profileName}-finding-preset`]: preset,
        [`profile-${profileName}-finding-critical`]: critical,
        [`profile-${profileName}-finding-high`]: high,
        [`profile-${profileName}-finding-medium`]: medium,
        [`profile-${profileName}-finding-low`]: low,
        [`profile-${profileName}-finding-residual_risk`]: residualRisk,
        [`profile-${profileName}-finding-copy-from`]: copyFrom
    };
    const submitted: string[] = [];
    const context = {
        currentProfilesPayload: {
            finding_policy_presets: {
                strict: {
                    findings: {
                        critical: 'fix_now',
                        high: 'fix_now',
                        medium: 'fix_now',
                        low: 'fix_now'
                    },
                    residual_risk: 'fix_now'
                }
            }
        },
        profilesNode: {
            querySelectorAll: (selector: string) => {
                if (selector.endsWith('select[id$="-finding-preset"]')) return [preset];
                if (selector.endsWith('select[data-profile-finding-action]')) {
                    return [critical, high, medium, low, residualRisk];
                }
                if (selector === 'button[data-profile-policy-action]') return [copy, reset, apply];
                return [];
            }
        },
        document: {
            getElementById: (id: string) => elementsById[id] || null
        },
        submitted
    };

    vm.runInNewContext(
        `${UI_DASHBOARD_CLIENT_PROFILES}\nsubmitProfileAction = payload => submitted.push(JSON.stringify(payload));\nattachProfileFindingPolicyHandlers();`,
        context
    );

    preset.listeners.change();
    assert.deepEqual(
        [critical.value, high.value, medium.value, low.value, residualRisk.value],
        ['fix_now', 'fix_now', 'fix_now', 'fix_now', 'fix_now']
    );
    apply.listeners.click();

    high.value = 'create_follow_up';
    high.listeners.change();
    assert.equal(preset.value, 'custom');

    copy.listeners.click();
    reset.listeners.click();
    apply.listeners.click();

    assert.deepEqual(submitted.map((payload) => JSON.parse(payload)), [
        { operation: 'policy', profile_name: profileName, policy_preset: 'strict' },
        { operation: 'policy', profile_name: profileName, policy_copy_from: 'balanced' },
        { operation: 'policy', profile_name: profileName, policy_reset: true },
        {
            operation: 'policy',
            profile_name: profileName,
            policy_preset: 'custom',
            policy_actions: {
                critical: 'fix_now',
                high: 'create_follow_up',
                medium: 'fix_now',
                low: 'fix_now',
                residual_risk: 'fix_now'
            }
        }
    ]);
});

test('profile browser action previews before confirmation and binds execute to the preview hash', async () => {
    const requests: Array<Record<string, unknown>> = [];
    const events: string[] = [];
    const previewSha256 = 'a'.repeat(64);
    const context = {
        actionToken: 'test-token',
        currentProfileActionResult: null,
        profilesStatusNode: { innerHTML: '' },
        renderSettingResultMarkup: (result: { status: string }) => {
            events.push(`render:${result.status}`);
            return '';
        },
        t: (key: string) => key,
        window: {
            prompt: () => {
                events.push('prompt');
                return 'APPLY PROFILE CHANGE';
            }
        },
        fetch: async (_url: string, options: { body: string }) => {
            const payload = JSON.parse(options.body) as Record<string, unknown>;
            requests.push(payload);
            events.push(`request:${payload.mode}`);
            return {
                json: async () => requests.length === 1
                    ? { status: 'previewed', preview_sha256: previewSha256 }
                    : { status: 'confirmation_required' }
            };
        }
    };

    await vm.runInNewContext(
        `${UI_DASHBOARD_CLIENT_PROFILES}\nsubmitProfileAction({ operation: 'select', profile_name: 'balanced' });`,
        context
    );

    assert.equal(requests.length, 2);
    assert.equal(requests[0].mode, 'preview');
    assert.equal(requests[0].preview_sha256, undefined);
    assert.equal(requests[1].mode, 'execute');
    assert.equal(requests[1].confirmation, 'APPLY PROFILE CHANGE');
    assert.equal(requests[1].preview_sha256, previewSha256);
    assert.deepEqual(events, [
        'request:preview',
        'render:previewed',
        'prompt',
        'request:execute',
        'render:confirmation_required'
    ]);
});

test('profiles UI renders compact review catalog state and disables guarded controls without actions', () => {
    const reviewCatalog = {
        status: 'present',
        catalog_path: 'garda-agent-orchestrator/live/config/review-catalog.json',
        capabilities_path: 'garda-agent-orchestrator/live/config/review-capabilities.json',
        profiles_path: 'garda-agent-orchestrator/live/config/profiles.json',
        catalog_exists: true,
        catalog_sha256: 'a'.repeat(64),
        state_sha256: 'b'.repeat(64),
        active_profile: 'balanced',
        selected_profile: 'balanced',
        profile_names: ['balanced'],
        known_skill_ids: ['architecture-review', 'code-review'],
        validation: { status: 'PASS', issues: [] },
        migration: { status: 'current', required: false, reason: 'Catalog is current.' },
        lanes: [
            {
                id: 'code',
                display_label: 'Code review',
                source: 'built_in',
                built_in: true,
                enabled_by_default: true,
                capability_enabled: true,
                skill_ids: ['code-review'],
                trigger: { mode: 'compatibility', signal_ids: [] },
                coverage_category_ids: ['code-quality'],
                reviewer_role: { role_id: 'code-reviewer', focus_tags: ['code-quality'] },
                verdict_tokens: { pass: 'REVIEW PASSED', fail: 'REVIEW FAILED' },
                profile: {
                    name: 'balanced',
                    state: 'required',
                    state_source: 'profile',
                    active: true,
                    inactive_reason: null,
                    dependencies: [],
                    explanation: ['code uses built-in compatibility triggers']
                }
            },
            {
                id: 'architecture',
                display_label: 'Architecture review',
                source: 'custom',
                built_in: false,
                enabled_by_default: false,
                capability_enabled: false,
                skill_ids: ['architecture-review'],
                trigger: { mode: 'signals', signal_ids: ['architecture'] },
                coverage_category_ids: ['maintainability'],
                reviewer_role: { role_id: 'architecture-reviewer', focus_tags: ['maintainability'] },
                verdict_tokens: { pass: 'ARCHITECTURE REVIEW PASSED', fail: 'ARCHITECTURE REVIEW FAILED' },
                profile: {
                    name: 'balanced',
                    state: 'disabled',
                    state_source: 'profile',
                    active: false,
                    inactive_reason: 'profile_disabled',
                    dependencies: ['code'],
                    explanation: ['architecture trigger uses signals: architecture']
                }
            }
        ]
    };
    const payload = {
        status: 'present',
        config_path: 'garda-agent-orchestrator/live/config/profiles.json',
        active_profile: 'balanced',
        unavailable: [],
        finding_policy_actions: [],
        finding_policy_presets: {},
        review_types: [],
        profiles: [],
        review_catalog: reviewCatalog
    };
    const html = renderProfilesHtml(payload, true);
    const disabledHtml = renderProfilesHtml(payload, false);
    const russianHtml = renderProfilesHtml(payload, true, 'ru');

    assert.match(html, /data-review-catalog-id="architecture"/u);
    assert.match(html, /disabled_by_default/u);
    assert.match(html, /immutable.*verdict_tokens/u);
    assert.match(html, /future_tasks_only/u);
    assert.match(html, /review_dependency_graph/u);
    assert.match(html, /signals: architecture/u);
    assert.match(html, /<strong>dependencies<\/strong><code>code<\/code>/u);
    assert.match(html, /data-review-catalog-action="enable"/u);
    assert.doesNotMatch(html, /data-review-catalog-id="code"[^>]*data-review-catalog-action/u);
    assert.doesNotMatch(html, /prompt_body|reviewer_prompt|secret/u);
    assert.match(disabledHtml, /data-review-catalog-action="enable"[^>]* disabled/u);
    assert.match(russianHtml, /Пользовательское/u);
    assert.match(UI_DASHBOARD_STYLES, /\.review-catalog-lane-grid/u);
});

test('review catalog browser action shows semantic diff before bound confirmation', async () => {
    const requests: Array<Record<string, unknown>> = [];
    const events: string[] = [];
    const stateSha256 = 'a'.repeat(64);
    const planSha256 = 'b'.repeat(64);
    const profilesStatusNode = { innerHTML: '' };
    const context = {
        actionToken: 'test-token',
        currentProfileActionResult: null,
        currentProfilesPayload: null,
        profilesStatusNode,
        safe: (value: unknown) => String(value),
        badge: (value: unknown) => `<span>${String(value)}</span>`,
        t: (key: string) => key,
        window: {
            prompt: () => {
                events.push('prompt');
                return 'APPLY REVIEW CATALOG CHANGE';
            }
        },
        fetch: async (_url: string, options: { body: string }) => {
            const payload = JSON.parse(options.body) as Record<string, unknown>;
            requests.push(payload);
            events.push(`request:${payload.mode}`);
            return {
                ok: true,
                json: async () => requests.length === 1
                    ? {
                        status: 'previewed',
                        mode: 'preview',
                        review_id: 'architecture',
                        before_state_sha256: stateSha256,
                        plan_sha256: planSha256,
                        confirmation_phrase: 'APPLY REVIEW CATALOG CHANGE',
                        diff: [{ path: 'review-capabilities.architecture', before: false, after: true }]
                    }
                    : { status: 'confirmation_required', mode: 'execute', review_id: 'architecture', diff: [] }
            };
        }
    };

    await vm.runInNewContext(
        `${UI_DASHBOARD_CLIENT_PROFILES}\nsubmitReviewCatalogAction({ operation: 'enable', review_id: 'architecture' });`,
        context
    );

    assert.equal(requests.length, 2);
    assert.equal(requests[0].mode, 'preview');
    assert.equal(requests[1].mode, 'execute');
    assert.equal(requests[1].confirmation, 'APPLY REVIEW CATALOG CHANGE');
    assert.equal(requests[1].expected_state_sha256, stateSha256);
    assert.equal(requests[1].expected_plan_sha256, planSha256);
    assert.match(profilesStatusNode.innerHTML, /review-catalog-result/u);
    assert.deepEqual(events, ['request:preview', 'prompt', 'request:execute']);
});

test('profile browser action stops before confirmation when preview hash is invalid', async () => {
    const requests: Array<Record<string, unknown>> = [];
    let promptCalls = 0;
    const context = {
        actionToken: 'test-token',
        currentProfileActionResult: null,
        profilesStatusNode: { innerHTML: '' },
        renderSettingResultMarkup: () => '',
        t: (key: string) => key,
        window: {
            prompt: () => {
                promptCalls += 1;
                return 'APPLY PROFILE CHANGE';
            }
        },
        fetch: async (_url: string, options: { body: string }) => {
            requests.push(JSON.parse(options.body) as Record<string, unknown>);
            return {
                json: async () => ({ status: 'previewed', preview_sha256: 'not-a-sha256' })
            };
        }
    };

    await vm.runInNewContext(
        `${UI_DASHBOARD_CLIENT_PROFILES}\nsubmitProfileAction({ operation: 'select', profile_name: 'balanced' });`,
        context
    );

    assert.equal(requests.length, 1);
    assert.equal(requests[0].mode, 'preview');
    assert.equal(promptCalls, 0);
});
