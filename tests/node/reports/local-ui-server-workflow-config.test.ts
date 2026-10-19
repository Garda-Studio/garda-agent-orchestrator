import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import {
    startLocalUiServer
} from '../../../src/reports/ui';
import {
    cleanupLocalUiTestResources,
    makeLocalUiTempRepo,
    setLocalUiTaskResetEnabled,
    writeLocalUiRepoFixture
} from './local-ui-test-helpers';
import {
    DEFAULT_OPTIONAL_QUALITY_CHECKS_REVIEW_FAILURE_CADENCE_INTERVAL,
    MAX_OPTIONAL_QUALITY_CHECKS_REVIEW_FAILURE_CADENCE_INTERVAL
} from '../../../src/core/workflow-config';

function extractActionToken(html: string): string {
    const match = html.match(/const actionToken = "([^"]+)";/u);
    assert.ok(match, 'expected inline action token');
    return match[1];
}

const makeTempRepo = makeLocalUiTempRepo;
const writeRepo = writeLocalUiRepoFixture;

test('local UI settings use guarded workflow commands with preview confirmation and audit', async () => {
    const repoRoot = makeTempRepo();
    writeRepo(repoRoot);
    setLocalUiTaskResetEnabled(repoRoot, true);
    const executedCommands: string[] = [];
    const server = await startLocalUiServer({
        repoRoot,
        port: 0,
        actionsEnabled: true,
        actionRunner: async (action) => {
            executedCommands.push(action.command.display);
            return {
                exit_code: 0,
                signal: null,
                stdout: 'updated',
                stderr: ''
            };
        }
    });
    try {
        const actionToken = extractActionToken(await (await fetch(server.url)).text());
        const actionHeaders = {
            'content-type': 'application/json',
            'origin': server.url.slice(0, -1),
            'x-garda-action-token': actionToken
        };
        const listResponse = await fetch(`${server.url}api/settings`);
        assert.equal(listResponse.status, 200);
        const list = await listResponse.json() as {
            enabled: boolean;
            optional_quality_checks: {
                enabled: boolean;
                baseline_version?: string;
                rules: Array<{
                    id: string;
                    title: string;
                    prompt: string;
                    enabled: boolean;
                    excluded_scope_categories?: string[];
                }>;
            };
            optional_skill_selection_policy: {
                mode: string;
                effective_mode: string;
                status: string;
            };
            quality_gate: {
                enabled: boolean;
                baseline_version: string;
                shipped_baseline_version: string;
                baseline_version_label: string;
                shipped_baseline_version_label: string;
                baseline_rule_count: number;
                custom_rule_count: number;
                deleted_baseline_rule_count: number;
                rules: Array<{
                    id: string;
                    source: string;
                    present: boolean;
                    statuses: string[];
                }>;
            };
            settings: Array<{
                id: string;
                key: string;
                current_value: unknown;
                value_type: string;
                min?: number;
                max?: number;
                flag?: string;
                options: Array<{ value: string }>;
                readiness?: {
                    ready?: boolean;
                    configured_enabled?: boolean;
                    audited_enablement?: boolean;
                    disabled_reason?: string;
                    remediation_command?: string;
                    remediation_action_id?: string;
                };
            }>;
        };
        assert.equal(list.enabled, true);
        const compileGateCommandIndex = list.settings.findIndex((setting) => setting.id === 'compile-gate-command');
        const fullSuiteCommandIndex = list.settings.findIndex((setting) => setting.id === 'full-suite-command');
        assert.notEqual(compileGateCommandIndex, -1);
        assert.notEqual(fullSuiteCommandIndex, -1);
        assert.equal(compileGateCommandIndex + 1, fullSuiteCommandIndex);
        assert.ok(list.settings.some((setting) => setting.id === 'full-suite-timeout-warning-continuation'));
        assert.ok(list.settings.some((setting) => setting.id === 'full-suite-green-summary-max-lines'));
        assert.ok(list.settings.some((setting) => setting.id === 'project-memory-max-compact-summary-chars'));
        assert.ok(list.settings.some((setting) => setting.key === 'full_suite_validation.enabled'));
        assert.ok(list.settings.some((setting) => setting.id === 'optional-checks-enabled'));
        const cadenceSetting = list.settings.find((setting) => setting.id === 'optional-checks-review-failure-cadence-interval');
        assert.ok(cadenceSetting);
        assert.equal(cadenceSetting.key, 'optional_quality_checks.review_failure_cadence_interval');
        assert.equal(cadenceSetting.value_type, 'integer');
        assert.equal(cadenceSetting.current_value, DEFAULT_OPTIONAL_QUALITY_CHECKS_REVIEW_FAILURE_CADENCE_INTERVAL);
        assert.equal(cadenceSetting.min, 1);
        assert.equal(cadenceSetting.max, MAX_OPTIONAL_QUALITY_CHECKS_REVIEW_FAILURE_CADENCE_INTERVAL);
        assert.equal(cadenceSetting.flag, '--optional-checks-review-failure-cadence-interval');
        const skillSelectionSetting = list.settings.find((setting) => setting.id === 'optional-skill-selection-mode');
        assert.ok(skillSelectionSetting);
        assert.equal(skillSelectionSetting.key, 'optional_skill_selection_policy.mode');
        assert.equal(skillSelectionSetting.current_value, 'optional');
        assert.ok(skillSelectionSetting.options.some((option) => option.value === 'mandatory'));
        assert.equal(list.optional_skill_selection_policy.mode, 'optional');
        assert.equal(list.optional_skill_selection_policy.effective_mode, 'optional');
        assert.equal(list.optional_skill_selection_policy.status, 'missing');
        assert.equal(list.optional_quality_checks.enabled, true);
        assert.equal(list.quality_gate.enabled, true);
        assert.equal(list.quality_gate.baseline_version, list.quality_gate.shipped_baseline_version);
        assert.match(list.quality_gate.baseline_version_label, /^\d{4}-\d{2}-\d{2}$/u);
        assert.doesNotMatch(list.quality_gate.baseline_version_label, /\(T-\d+\)/u);
        assert.equal(list.quality_gate.baseline_version_label, list.quality_gate.shipped_baseline_version_label);
        assert.ok(list.quality_gate.baseline_rule_count >= 7);
        assert.equal(list.quality_gate.custom_rule_count, 0);
        assert.equal(list.quality_gate.deleted_baseline_rule_count, 0);
        assert.ok(list.quality_gate.rules.some((rule) => (
            rule.id === 'code_simplification'
            && rule.source === 'baseline'
            && rule.present
            && rule.statuses.includes('active')
        )));
        assert.ok(list.optional_quality_checks.rules.some((rule) => rule.id === 'code_simplification'));
        const taskResetSetting = list.settings.find((setting) => setting.key === 'task_reset.enabled');
        assert.ok(taskResetSetting);
        assert.equal(taskResetSetting.current_value, true);
        assert.equal(taskResetSetting.readiness?.ready, false);
        assert.equal(taskResetSetting.readiness?.configured_enabled, true);
        assert.equal(taskResetSetting.readiness?.audited_enablement, false);
        assert.match(taskResetSetting.readiness?.disabled_reason || '', /no matching audited workflow set record/u);
        assert.match(taskResetSetting.readiness?.remediation_command || '', /workflow set --target-root "\." --task-reset-enabled true/u);
        assert.equal(taskResetSetting.readiness?.remediation_action_id, 'task-reset-enable-audited');
        const scopeProfiles = list.settings.find((setting) => setting.id === 'scope-budget-profiles');
        assert.ok(scopeProfiles);
        assert.equal(scopeProfiles.value_type, 'enum_list');
        assert.ok(scopeProfiles.options.some((option) => option.value === 'strict'));
        assert.equal(list.settings.some((setting) => setting.id === 'scope-budget-action'), false);
        const scopeWarnLines = list.settings.find((setting) => setting.id === 'scope-budget-warn-changed-lines');
        assert.ok(scopeWarnLines);
        assert.equal(scopeWarnLines.value_type, 'integer');
        assert.equal(scopeWarnLines.current_value, 2000);
        const scopeBlockLines = list.settings.find((setting) => setting.id === 'scope-budget-block-changed-lines');
        assert.ok(scopeBlockLines);
        assert.equal(scopeBlockLines.value_type, 'integer');
        assert.equal(scopeBlockLines.current_value, 5000);

        const legacyScopeActionResponse = await fetch(`${server.url}api/settings`, {
            method: 'POST',
            headers: actionHeaders,
            body: JSON.stringify({ setting_id: 'scope-budget-action', mode: 'preview', value: 'WARN_ONLY' })
        });
        assert.equal(legacyScopeActionResponse.status, 400);
        assert.equal((await legacyScopeActionResponse.json() as { code: string }).code, 'unknown_setting');

        const compilePreviewResponse = await fetch(`${server.url}api/settings`, {
            method: 'POST',
            headers: actionHeaders,
            body: JSON.stringify({ setting_id: 'compile-gate-command', mode: 'preview', value: 'npm run typecheck' })
        });
        assert.equal(compilePreviewResponse.status, 200);
        const compilePreview = await compilePreviewResponse.json() as {
            key: string;
            proposed_value: string;
            command: string;
            changed_keys: string[];
        };
        assert.equal(compilePreview.key, 'compile_gate.command');
        assert.equal(compilePreview.proposed_value, 'npm run typecheck');
        assert.deepEqual(compilePreview.changed_keys, ['compile_gate.command']);
        assert.match(compilePreview.command, /workflow set --compile-gate-command "npm run typecheck"/u);
        assert.match(compilePreview.command, /--operator-confirmed yes --operator-confirmed-at-utc/u);

        const optionalRulePreviewResponse = await fetch(`${server.url}api/settings`, {
            method: 'POST',
            headers: actionHeaders,
            body: JSON.stringify({
                optional_rule_action: 'upsert',
                mode: 'preview',
                rule_id: 'custom_focus',
                title: 'Custom focus',
                prompt: 'Check custom concern.',
                enabled: 'true',
                exclude_test_only: true
            })
        });
        assert.equal(optionalRulePreviewResponse.status, 200);
        const optionalRulePreview = await optionalRulePreviewResponse.json() as {
            setting_id: string;
            key: string;
            proposed_value: {
                action: string;
                id: string;
                title: string;
                prompt: string;
                enabled: boolean;
                excluded_scope_categories: string[];
            };
            command: string;
            changed_keys: string[];
        };
        assert.equal(optionalRulePreview.setting_id, 'optional-check-rule-management');
        assert.equal(optionalRulePreview.key, 'optional_quality_checks.rules');
        assert.deepEqual(optionalRulePreview.changed_keys, ['optional_quality_checks.rules']);
        assert.deepEqual(optionalRulePreview.proposed_value, {
            action: 'upsert',
            id: 'custom_focus',
            title: 'Custom focus',
            prompt: 'Check custom concern.',
            enabled: true,
            excluded_scope_categories: ['test-only']
        });
        assert.match(optionalRulePreview.command, /workflow set --optional-check-rule-id custom_focus/u);
        assert.match(optionalRulePreview.command, /--optional-check-rule-title "Custom focus"/u);
        assert.match(optionalRulePreview.command, /--optional-check-rule-prompt "Check custom concern\."/u);
        assert.match(optionalRulePreview.command, /--optional-check-rule-enabled true/u);
        assert.match(optionalRulePreview.command, /--optional-check-rule-exclude-test-only true/u);

        const skillSelectionPreviewResponse = await fetch(`${server.url}api/settings`, {
            method: 'POST',
            headers: actionHeaders,
            body: JSON.stringify({ setting_id: 'optional-skill-selection-mode', mode: 'preview', value: 'mandatory' })
        });
        assert.equal(skillSelectionPreviewResponse.status, 200);
        const skillSelectionPreview = await skillSelectionPreviewResponse.json() as {
            key: string;
            proposed_value: string;
            command: string;
            changed_keys: string[];
        };
        assert.equal(skillSelectionPreview.key, 'optional_skill_selection_policy.mode');
        assert.equal(skillSelectionPreview.proposed_value, 'mandatory');
        assert.deepEqual(skillSelectionPreview.changed_keys, ['optional_skill_selection_policy.mode']);
        assert.match(skillSelectionPreview.command, /workflow set --optional-skill-selection-mode mandatory/u);
        assert.match(skillSelectionPreview.command, /--operator-confirmed yes --operator-confirmed-at-utc/u);

        const optionalRuleDeletePreviewResponse = await fetch(`${server.url}api/settings`, {
            method: 'POST',
            headers: actionHeaders,
            body: JSON.stringify({
                optional_rule_action: 'delete',
                mode: 'preview',
                rule_id: 'custom_focus'
            })
        });
        assert.equal(optionalRuleDeletePreviewResponse.status, 200);
        const optionalRuleDeletePreview = await optionalRuleDeletePreviewResponse.json() as {
            proposed_value: { action: string; id: string };
            command: string;
        };
        assert.deepEqual(optionalRuleDeletePreview.proposed_value, {
            action: 'delete',
            id: 'custom_focus'
        });
        assert.match(optionalRuleDeletePreview.command, /workflow set --optional-check-rule-delete custom_focus/u);

        const baselineRuleTogglePreviewResponse = await fetch(`${server.url}api/settings`, {
            method: 'POST',
            headers: actionHeaders,
            body: JSON.stringify({
                optional_rule_action: 'upsert',
                mode: 'preview',
                rule_id: 'code_simplification',
                title: 'Code simplification',
                prompt: 'Check whether the changed code can be simplified without weakening behavior, validation, or diagnostics.',
                enabled: 'false',
                exclude_test_only: false
            })
        });
        assert.equal(baselineRuleTogglePreviewResponse.status, 200);
        const baselineRuleTogglePreview = await baselineRuleTogglePreviewResponse.json() as {
            proposed_value: {
                id: string;
                title: string;
                enabled: boolean;
                excluded_scope_categories: string[];
            };
            command: string;
        };
        assert.deepEqual(baselineRuleTogglePreview.proposed_value, {
            action: 'upsert',
            id: 'code_simplification',
            title: 'Code simplification',
            prompt: 'Check whether the changed code can be simplified without weakening behavior, validation, or diagnostics.',
            enabled: false,
            excluded_scope_categories: []
        });
        assert.match(baselineRuleTogglePreview.command, /workflow set --optional-check-rule-id code_simplification/u);
        assert.match(baselineRuleTogglePreview.command, /--optional-check-rule-enabled false/u);
        assert.match(baselineRuleTogglePreview.command, /--optional-check-rule-exclude-test-only false/u);
        assert.doesNotMatch(baselineRuleTogglePreview.command, /--optional-check-rule-title/u);
        assert.doesNotMatch(baselineRuleTogglePreview.command, /--optional-check-rule-prompt/u);

        const baselineRuleMissingEnabledPreviewResponse = await fetch(`${server.url}api/settings`, {
            method: 'POST',
            headers: actionHeaders,
            body: JSON.stringify({
                optional_rule_action: 'upsert',
                mode: 'preview',
                rule_id: 'code_simplification'
            })
        });
        assert.equal(baselineRuleMissingEnabledPreviewResponse.status, 400);
        assert.equal((await baselineRuleMissingEnabledPreviewResponse.json() as { code: string }).code, 'invalid_setting_value');

        const baselineRuleEditPreviewResponse = await fetch(`${server.url}api/settings`, {
            method: 'POST',
            headers: actionHeaders,
            body: JSON.stringify({
                optional_rule_action: 'upsert',
                mode: 'preview',
                rule_id: 'code_simplification',
                title: 'Edited shipped title',
                prompt: 'Check whether the changed code can be simplified without weakening behavior, validation, or diagnostics.',
                enabled: 'true'
            })
        });
        assert.equal(baselineRuleEditPreviewResponse.status, 400);
        assert.equal((await baselineRuleEditPreviewResponse.json() as { code: string }).code, 'invalid_setting_value');

        const baselineRuleDeletePreviewResponse = await fetch(`${server.url}api/settings`, {
            method: 'POST',
            headers: actionHeaders,
            body: JSON.stringify({
                optional_rule_action: 'delete',
                mode: 'preview',
                rule_id: 'code_simplification'
            })
        });
        assert.equal(baselineRuleDeletePreviewResponse.status, 400);
        assert.equal((await baselineRuleDeletePreviewResponse.json() as { code: string }).code, 'invalid_setting_value');

        const invalidOptionalRulePreviewResponse = await fetch(`${server.url}api/settings`, {
            method: 'POST',
            headers: actionHeaders,
            body: JSON.stringify({
                optional_rule_action: 'upsert',
                mode: 'preview',
                rule_id: 'custom_focus',
                title: 'Custom focus'
            })
        });
        assert.equal(invalidOptionalRulePreviewResponse.status, 400);
        assert.equal((await invalidOptionalRulePreviewResponse.json() as { code: string }).code, 'invalid_setting_value');

        const invalidCompilePreviewResponse = await fetch(`${server.url}api/settings`, {
            method: 'POST',
            headers: actionHeaders,
            body: JSON.stringify({ setting_id: 'compile-gate-command', mode: 'preview', value: 'npm run typecheck &&' })
        });
        assert.equal(invalidCompilePreviewResponse.status, 400);
        assert.equal((await invalidCompilePreviewResponse.json() as { code: string }).code, 'invalid_setting_value');

        const fullSuiteCommandPreviewResponse = await fetch(`${server.url}api/settings`, {
            method: 'POST',
            headers: actionHeaders,
            body: JSON.stringify({ setting_id: 'full-suite-command', mode: 'preview', value: 'npm test -- --runInBand' })
        });
        assert.equal(fullSuiteCommandPreviewResponse.status, 200);
        const fullSuiteCommandPreview = await fullSuiteCommandPreviewResponse.json() as {
            key: string;
            proposed_value: string;
            command: string;
            changed_keys: string[];
        };
        assert.equal(fullSuiteCommandPreview.key, 'full_suite_validation.command');
        assert.equal(fullSuiteCommandPreview.proposed_value, 'npm test -- --runInBand');
        assert.deepEqual(fullSuiteCommandPreview.changed_keys, ['full_suite_validation.command']);
        assert.match(fullSuiteCommandPreview.command, /workflow set --full-suite-command "npm test -- --runInBand"/u);
        assert.match(fullSuiteCommandPreview.command, /--operator-confirmed yes --operator-confirmed-at-utc/u);

        const timeoutBlockerPreviewResponse = await fetch(`${server.url}api/settings`, {
            method: 'POST',
            headers: actionHeaders,
            body: JSON.stringify({ setting_id: 'full-suite-timeout-blocker', mode: 'preview', value: 'false' })
        });
        assert.equal(timeoutBlockerPreviewResponse.status, 200);
        const timeoutBlockerPreview = await timeoutBlockerPreviewResponse.json() as {
            key: string;
            proposed_value: boolean;
            command: string;
            changed_keys: string[];
        };
        assert.equal(timeoutBlockerPreview.key, 'full_suite_validation.timeout_blocker');
        assert.equal(timeoutBlockerPreview.proposed_value, false);
        assert.deepEqual(timeoutBlockerPreview.changed_keys, ['full_suite_validation.timeout_blocker']);
        assert.match(timeoutBlockerPreview.command, /workflow set --full-suite-timeout-blocker false/u);
        assert.match(timeoutBlockerPreview.command, /--operator-confirmed yes --operator-confirmed-at-utc/u);

        const warningOnlyContinuationPreviewResponse = await fetch(`${server.url}api/settings`, {
            method: 'POST',
            headers: actionHeaders,
            body: JSON.stringify({ setting_id: 'full-suite-timeout-warning-continuation', mode: 'preview', value: 'true' })
        });
        assert.equal(warningOnlyContinuationPreviewResponse.status, 200);
        const warningOnlyContinuationPreview = await warningOnlyContinuationPreviewResponse.json() as {
            key: string;
            proposed_value: boolean;
            command: string;
            changed_keys: string[];
        };
        assert.equal(warningOnlyContinuationPreview.key, 'full_suite_validation.timeout_blocker');
        assert.equal(warningOnlyContinuationPreview.proposed_value, true);
        assert.deepEqual(warningOnlyContinuationPreview.changed_keys, ['full_suite_validation.timeout_blocker']);
        assert.match(warningOnlyContinuationPreview.command, /workflow set --full-suite-timeout-blocker false/u);
        assert.match(warningOnlyContinuationPreview.command, /--operator-confirmed yes --operator-confirmed-at-utc/u);

        const enumListPreviewResponse = await fetch(`${server.url}api/settings`, {
            method: 'POST',
            headers: actionHeaders,
            body: JSON.stringify({ setting_id: 'scope-budget-profiles', mode: 'preview', value: ['strict', 'balanced'] })
        });
        assert.equal(enumListPreviewResponse.status, 200);
        const enumListPreview = await enumListPreviewResponse.json() as {
            proposed_value: string[];
            command: string;
            changed_keys: string[];
        };
        assert.deepEqual(enumListPreview.proposed_value, ['strict', 'balanced']);
        assert.deepEqual(enumListPreview.changed_keys, ['scope_budget_guard.profiles']);
        assert.match(enumListPreview.command, /workflow set --scope-budget-profiles strict,balanced/u);

        const invalidEnumListResponse = await fetch(`${server.url}api/settings`, {
            method: 'POST',
            headers: actionHeaders,
            body: JSON.stringify({ setting_id: 'scope-budget-profiles', mode: 'preview', value: ['strict', 'made-up'] })
        });
        assert.equal(invalidEnumListResponse.status, 400);
        assert.equal((await invalidEnumListResponse.json() as { code: string }).code, 'invalid_setting_value');

        const scopeBlockPreviewResponse = await fetch(`${server.url}api/settings`, {
            method: 'POST',
            headers: actionHeaders,
            body: JSON.stringify({ setting_id: 'scope-budget-block-changed-lines', mode: 'preview', value: 6000 })
        });
        assert.equal(scopeBlockPreviewResponse.status, 200);
        const scopeBlockPreview = await scopeBlockPreviewResponse.json() as {
            key: string;
            proposed_value: number;
            command: string;
            changed_keys: string[];
        };
        assert.equal(scopeBlockPreview.key, 'scope_budget_guard.block_changed_lines');
        assert.equal(scopeBlockPreview.proposed_value, 6000);
        assert.deepEqual(scopeBlockPreview.changed_keys, ['scope_budget_guard.block_changed_lines']);
        assert.match(scopeBlockPreview.command, /workflow set --scope-budget-block-changed-lines 6000/u);

        const invalidScopeWarnResponse = await fetch(`${server.url}api/settings`, {
            method: 'POST',
            headers: actionHeaders,
            body: JSON.stringify({ setting_id: 'scope-budget-warn-changed-lines', mode: 'preview', value: 5000 })
        });
        assert.equal(invalidScopeWarnResponse.status, 400);
        assert.equal((await invalidScopeWarnResponse.json() as { code: string }).code, 'invalid_setting_value');

        const invalidResponse = await fetch(`${server.url}api/settings`, {
            method: 'POST',
            headers: actionHeaders,
            body: JSON.stringify({ setting_id: 'full-suite-green-summary-max-lines', mode: 'preview', value: 0 })
        });
        assert.equal(invalidResponse.status, 400);
        assert.equal((await invalidResponse.json() as { code: string }).code, 'invalid_setting_value');

        const memoryLimitPreviewResponse = await fetch(`${server.url}api/settings`, {
            method: 'POST',
            headers: actionHeaders,
            body: JSON.stringify({ setting_id: 'project-memory-max-compact-summary-chars', mode: 'preview', value: 20000 })
        });
        assert.equal(memoryLimitPreviewResponse.status, 200);
        const memoryLimitPreview = await memoryLimitPreviewResponse.json() as {
            key: string;
            proposed_value: number;
            command: string;
            changed_keys: string[];
        };
        assert.equal(memoryLimitPreview.key, 'project_memory_maintenance.max_compact_summary_chars');
        assert.equal(memoryLimitPreview.proposed_value, 20000);
        assert.deepEqual(memoryLimitPreview.changed_keys, ['project_memory_maintenance.max_compact_summary_chars']);
        assert.match(memoryLimitPreview.command, /workflow set --project-memory-max-compact-summary-chars 20000/u);
        assert.doesNotMatch(memoryLimitPreview.command, /workflow-config\.json/u);

        const cadencePreviewResponse = await fetch(`${server.url}api/settings`, {
            method: 'POST',
            headers: actionHeaders,
            body: JSON.stringify({ setting_id: 'optional-checks-review-failure-cadence-interval', mode: 'preview', value: 5 })
        });
        assert.equal(cadencePreviewResponse.status, 200);
        const cadencePreview = await cadencePreviewResponse.json() as {
            status: string;
            key: string;
            proposed_value: number;
            command: string;
            changed_keys: string[];
        };
        assert.equal(cadencePreview.status, 'previewed');
        assert.equal(cadencePreview.key, 'optional_quality_checks.review_failure_cadence_interval');
        assert.equal(cadencePreview.proposed_value, 5);
        assert.deepEqual(cadencePreview.changed_keys, ['optional_quality_checks.review_failure_cadence_interval']);
        assert.match(cadencePreview.command, /workflow set --optional-checks-review-failure-cadence-interval 5/u);
        assert.doesNotMatch(cadencePreview.command, /workflow-config\.json/u);

        const invalidCadencePreviewResponse = await fetch(`${server.url}api/settings`, {
            method: 'POST',
            headers: actionHeaders,
            body: JSON.stringify({ setting_id: 'optional-checks-review-failure-cadence-interval', mode: 'preview', value: 0 })
        });
        assert.equal(invalidCadencePreviewResponse.status, 400);
        assert.match(
            ((await invalidCadencePreviewResponse.json()) as { error: string }).error,
            /Review failures between quality checks must be an integer from 1 to 100/u
        );

        const previewResponse = await fetch(`${server.url}api/settings`, {
            method: 'POST',
            headers: actionHeaders,
            body: JSON.stringify({ setting_id: 'full-suite-green-summary-max-lines', mode: 'preview', value: 7 })
        });
        assert.equal(previewResponse.status, 200);
        const preview = await previewResponse.json() as {
            status: string;
            key: string;
            proposed_value: number;
            command: string;
            changed_keys: string[];
            confirmation_phrase: string;
        };
        assert.equal(preview.status, 'previewed');
        assert.equal(preview.key, 'full_suite_validation.green_summary_max_lines');
        assert.equal(preview.proposed_value, 7);
        assert.deepEqual(preview.changed_keys, ['full_suite_validation.green_summary_max_lines']);
        assert.match(preview.command, /workflow set --full-suite-green-summary-max-lines 7/u);
        assert.match(preview.command, /--operator-confirmed yes --operator-confirmed-at-utc/u);
        assert.doesNotMatch(preview.command, /workflow-config\.json/u);
        assert.equal(preview.confirmation_phrase, 'APPLY GARDA SETTING');
        assert.deepEqual(executedCommands, []);

        const blockedResponse = await fetch(`${server.url}api/settings`, {
            method: 'POST',
            headers: actionHeaders,
            body: JSON.stringify({ setting_id: 'full-suite-green-summary-max-lines', mode: 'execute', value: 7, confirmation: 'wrong' })
        });
        assert.equal(blockedResponse.status, 409);
        assert.equal((await blockedResponse.json() as { status: string }).status, 'confirmation_required');
        assert.deepEqual(executedCommands, []);

        const optionalRuleBlockedResponse = await fetch(`${server.url}api/settings`, {
            method: 'POST',
            headers: actionHeaders,
            body: JSON.stringify({
                optional_rule_action: 'upsert',
                mode: 'execute',
                rule_id: 'custom_focus',
                title: 'Custom focus',
                prompt: 'Check custom concern.',
                enabled: 'true',
                confirmation: 'wrong'
            })
        });
        assert.equal(optionalRuleBlockedResponse.status, 409);
        assert.equal((await optionalRuleBlockedResponse.json() as { status: string }).status, 'confirmation_required');
        assert.deepEqual(executedCommands, []);

        const executeResponse = await fetch(`${server.url}api/settings`, {
            method: 'POST',
            headers: actionHeaders,
            body: JSON.stringify({ setting_id: 'full-suite-green-summary-max-lines', mode: 'execute', value: 7, confirmation: 'APPLY GARDA SETTING' })
        });
        assert.equal(executeResponse.status, 200);
        const execute = await executeResponse.json() as { status: string; stdout: string; audit_path: string };
        assert.equal(execute.status, 'executed');
        assert.equal(execute.stdout, 'updated');
        assert.equal(executedCommands.length, 1);
        assert.match(executedCommands[0], /workflow set --full-suite-green-summary-max-lines 7/u);
        assert.match(executedCommands[0], /--mutation-source local-ui/u);
        const auditLines = fs.readFileSync(execute.audit_path, 'utf8').trim().split(/\r?\n/u);
        assert.ok(auditLines.length >= 3);
        assert.match(auditLines[auditLines.length - 1], /"action_id":"setting:full-suite-green-summary-max-lines"/u);
        assert.match(auditLines[auditLines.length - 1], /"status":"executed"/u);

        const timeoutBlockerExecuteResponse = await fetch(`${server.url}api/settings`, {
            method: 'POST',
            headers: actionHeaders,
            body: JSON.stringify({
                setting_id: 'full-suite-timeout-blocker',
                mode: 'execute',
                value: 'false',
                confirmation: 'APPLY GARDA SETTING'
            })
        });
        assert.equal(timeoutBlockerExecuteResponse.status, 200);
        const timeoutBlockerExecute = await timeoutBlockerExecuteResponse.json() as { status: string; audit_path: string };
        assert.equal(timeoutBlockerExecute.status, 'executed');
        assert.equal(executedCommands.length, 2);
        assert.match(executedCommands[1], /workflow set --full-suite-timeout-blocker false/u);
        const timeoutBlockerAuditLines = fs.readFileSync(timeoutBlockerExecute.audit_path, 'utf8').trim().split(/\r?\n/u);
        assert.ok(timeoutBlockerAuditLines.length >= 3);
        assert.match(timeoutBlockerAuditLines[timeoutBlockerAuditLines.length - 1], /"action_id":"setting:full-suite-timeout-blocker"/u);
        assert.match(timeoutBlockerAuditLines[timeoutBlockerAuditLines.length - 1], /"status":"executed"/u);

        const warningOnlyContinuationExecuteResponse = await fetch(`${server.url}api/settings`, {
            method: 'POST',
            headers: actionHeaders,
            body: JSON.stringify({
                setting_id: 'full-suite-timeout-warning-continuation',
                mode: 'execute',
                value: 'false',
                confirmation: 'APPLY GARDA SETTING'
            })
        });
        assert.equal(warningOnlyContinuationExecuteResponse.status, 200);
        const warningOnlyContinuationExecute = await warningOnlyContinuationExecuteResponse.json() as { status: string; proposed_value: boolean; audit_path: string };
        assert.equal(warningOnlyContinuationExecute.status, 'executed');
        assert.equal(warningOnlyContinuationExecute.proposed_value, false);
        assert.equal(executedCommands.length, 3);
        assert.match(executedCommands[2], /workflow set --full-suite-timeout-blocker true/u);
        const warningOnlyContinuationAuditLines = fs.readFileSync(warningOnlyContinuationExecute.audit_path, 'utf8').trim().split(/\r?\n/u);
        assert.ok(warningOnlyContinuationAuditLines.length >= 3);
        assert.match(warningOnlyContinuationAuditLines[warningOnlyContinuationAuditLines.length - 1], /"action_id":"setting:full-suite-timeout-warning-continuation"/u);
        assert.match(warningOnlyContinuationAuditLines[warningOnlyContinuationAuditLines.length - 1], /"status":"executed"/u);

        const compileCommandExecuteResponse = await fetch(`${server.url}api/settings`, {
            method: 'POST',
            headers: actionHeaders,
            body: JSON.stringify({
                setting_id: 'compile-gate-command',
                mode: 'execute',
                value: 'npm run typecheck',
                confirmation: 'APPLY GARDA SETTING'
            })
        });
        assert.equal(compileCommandExecuteResponse.status, 200);
        const compileCommandExecute = await compileCommandExecuteResponse.json() as { status: string; proposed_value: string; audit_path: string };
        assert.equal(compileCommandExecute.status, 'executed');
        assert.equal(compileCommandExecute.proposed_value, 'npm run typecheck');
        assert.equal(executedCommands.length, 4);
        assert.match(executedCommands[3], /workflow set --compile-gate-command "npm run typecheck"/u);
        assert.match(executedCommands[3], /--mutation-source local-ui/u);
        const compileCommandAuditLines = fs.readFileSync(compileCommandExecute.audit_path, 'utf8').trim().split(/\r?\n/u);
        assert.ok(compileCommandAuditLines.length >= 3);
        assert.match(compileCommandAuditLines[compileCommandAuditLines.length - 1], /"action_id":"setting:compile-gate-command"/u);
        assert.match(compileCommandAuditLines[compileCommandAuditLines.length - 1], /"status":"executed"/u);

        const optionalRuleExecuteResponse = await fetch(`${server.url}api/settings`, {
            method: 'POST',
            headers: actionHeaders,
            body: JSON.stringify({
                optional_rule_action: 'upsert',
                mode: 'execute',
                rule_id: 'custom_focus',
                title: 'Custom focus',
                prompt: 'Check custom concern.',
                enabled: 'false',
                exclude_test_only: true,
                confirmation: 'APPLY GARDA SETTING'
            })
        });
        assert.equal(optionalRuleExecuteResponse.status, 200);
        const optionalRuleExecute = await optionalRuleExecuteResponse.json() as { status: string; audit_path: string };
        assert.equal(optionalRuleExecute.status, 'executed');
        assert.equal(executedCommands.length, 5);
        assert.match(executedCommands[4], /workflow set --optional-check-rule-id custom_focus/u);
        assert.match(executedCommands[4], /--optional-check-rule-enabled false/u);
        assert.match(executedCommands[4], /--optional-check-rule-exclude-test-only true/u);
        assert.match(executedCommands[4], /--mutation-source local-ui/u);
        const optionalRuleAuditLines = fs.readFileSync(optionalRuleExecute.audit_path, 'utf8').trim().split(/\r?\n/u);
        assert.ok(optionalRuleAuditLines.length >= 3);
        assert.match(optionalRuleAuditLines[optionalRuleAuditLines.length - 1], /"action_id":"setting:optional-check-rule:upsert:custom_focus"/u);
        assert.match(optionalRuleAuditLines[optionalRuleAuditLines.length - 1], /"status":"executed"/u);

        const optionalRuleDeleteExecuteResponse = await fetch(`${server.url}api/settings`, {
            method: 'POST',
            headers: actionHeaders,
            body: JSON.stringify({
                optional_rule_action: 'delete',
                mode: 'execute',
                rule_id: 'custom_focus',
                confirmation: 'APPLY GARDA SETTING'
            })
        });
        assert.equal(optionalRuleDeleteExecuteResponse.status, 200);
        const optionalRuleDeleteExecute = await optionalRuleDeleteExecuteResponse.json() as { status: string; audit_path: string };
        assert.equal(optionalRuleDeleteExecute.status, 'executed');
        assert.equal(executedCommands.length, 6);
        assert.match(executedCommands[5], /workflow set --optional-check-rule-delete custom_focus/u);
        const optionalRuleDeleteAuditLines = fs.readFileSync(optionalRuleDeleteExecute.audit_path, 'utf8').trim().split(/\r?\n/u);
        assert.ok(optionalRuleDeleteAuditLines.length >= 3);
        assert.match(optionalRuleDeleteAuditLines[optionalRuleDeleteAuditLines.length - 1], /"action_id":"setting:optional-check-rule:delete:custom_focus"/u);
        assert.match(optionalRuleDeleteAuditLines[optionalRuleDeleteAuditLines.length - 1], /"status":"executed"/u);
    } finally {
        await cleanupLocalUiTestResources({ repoRoot, server });
    }
});

test('local UI settings reject cross-origin missing-token and non-json posts', async () => {
    const repoRoot = makeTempRepo();
    writeRepo(repoRoot);
    const server = await startLocalUiServer({
        repoRoot,
        port: 0,
        actionsEnabled: true,
        actionRunner: async () => ({
            exit_code: 0,
            signal: null,
            stdout: 'unexpected',
            stderr: ''
        })
    });
    try {
        const actionToken = extractActionToken(await (await fetch(server.url)).text());
        const body = JSON.stringify({
            setting_id: 'full-suite-green-summary-max-lines',
            mode: 'preview',
            value: 7
        });
        const missingToken = await fetch(`${server.url}api/settings`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'origin': server.url.slice(0, -1)
            },
            body
        });
        assert.equal(missingToken.status, 403);
        assert.equal((await missingToken.json() as { code: string }).code, 'action_boundary_rejected');

        const crossOrigin = await fetch(`${server.url}api/settings`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'origin': 'http://example.test',
                'x-garda-action-token': actionToken
            },
            body
        });
        assert.equal(crossOrigin.status, 403);
        assert.equal((await crossOrigin.json() as { code: string }).code, 'action_boundary_rejected');

        const nonJson = await fetch(`${server.url}api/settings`, {
            method: 'POST',
            headers: {
                'content-type': 'text/plain',
                'origin': server.url.slice(0, -1),
                'x-garda-action-token': actionToken
            },
            body
        });
        assert.equal(nonJson.status, 403);
        assert.equal((await nonJson.json() as { code: string }).code, 'action_boundary_rejected');
    } finally {
        await cleanupLocalUiTestResources({ repoRoot, server });
    }
});
