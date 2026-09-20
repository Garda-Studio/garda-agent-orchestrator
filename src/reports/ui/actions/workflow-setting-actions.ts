import { buildWorkflowConfigTab } from '../../report-data-contract';
import { compactSettingsFromConfig } from '../../../core/compact/setting-definitions';
import { getBaselineOptionalQualityCheckRule, isBaselineOptionalQualityCheckRuleId } from '../../../core/workflow-config';
import { validateCompileGateCommand } from '../../../gates/compile/compile-gate';
import {
    WORKFLOW_SETTING_DEFINITIONS,
    type WorkflowSettingOption,
    type WorkflowSettingValueType
} from '../../workflow-setting-metadata';
import { UI_ACTION_DEFAULT_TIMEOUT_MS, buildUiActionCommand } from './action-common';
import type {
    ParsedUiOptionalCheckRuleValue,
    ParsedUiSettingValue,
    UiActionDefinition,
    UiOptionalCheckRuleAction,
    UiSettingDefinition
} from './types';

const UI_SETTING_CONFIRMATION_PHRASE = 'APPLY GARDA SETTING';

function buildWarningOnlyTimeoutContinuationSetting(settings: ReturnType<typeof buildWorkflowConfigTab>['settings']): UiSettingDefinition | null {
    const timeoutBlocker = settings.find((setting) => setting.id === 'full-suite-timeout-blocker');
    if (!timeoutBlocker) {
        return null;
    }
    return {
        id: 'full-suite-timeout-warning-continuation',
        key: timeoutBlocker.key,
        label: 'Warning-only timeout continuation',
        description: 'Controls the same timeout policy as full-suite timeout blocker from the warning-only perspective. Turning this on applies --full-suite-timeout-blocker false; turning it off applies --full-suite-timeout-blocker true.',
        flag: timeoutBlocker.flag,
        value_type: 'boolean',
        options: [
            {
                value: 'true',
                label: 'On',
                description: 'Repeated full-suite timeouts continue as warning-only evidence and do not block completion.'
            },
            {
                value: 'false',
                label: 'Off',
                description: 'Repeated full-suite timeouts block task completion and propose a repair task.'
            }
        ],
        current_value: timeoutBlocker.value === false,
        confirmation_phrase: UI_SETTING_CONFIRMATION_PHRASE,
        command_value_inverts_boolean: true
    };
}

export function buildUiSettingDefinitions(repoRoot: string): UiSettingDefinition[] {
    const settings = buildWorkflowConfigTab(repoRoot).settings;
    const fullSuiteCommand = settings.find((setting) => setting.id === 'full-suite-command')?.value;
    const peerValues = Object.fromEntries(settings.map((setting) => [setting.key, setting.value]));
    const definitions = WORKFLOW_SETTING_DEFINITIONS
        .filter((definition) => definition.editable !== false)
        .map((definition) => {
            const reportSetting = settings.find((setting) => setting.id === definition.id);
            return {
                ...definition,
                options: reportSetting?.options ?? definition.options,
                current_value: reportSetting?.value,
                peer_values: peerValues,
                confirmation_phrase: UI_SETTING_CONFIRMATION_PHRASE,
                readiness: reportSetting?.readiness,
                compile_gate_full_suite_command: definition.id === 'compile-gate-command' && typeof fullSuiteCommand === 'string'
                    ? fullSuiteCommand
                    : null
            };
        });
    const warningOnlyTimeoutContinuation = buildWarningOnlyTimeoutContinuationSetting(settings);
    return warningOnlyTimeoutContinuation ? [...definitions, warningOnlyTimeoutContinuation] : definitions;
}

export function findSetting(settings: UiSettingDefinition[], settingId: unknown): UiSettingDefinition | null {
    if (typeof settingId !== 'string') {
        return null;
    }
    return settings.find((setting) => setting.id === settingId) || null;
}

function normalizeEnumListValue(value: unknown): string[] {
    const rawValues = Array.isArray(value)
        ? value
        : typeof value === 'number'
            ? [String(value)]
            : typeof value === 'string'
                ? value.split(',')
                : [];
    return [...new Set(rawValues
        .map((entry) => typeof entry === 'string' ? entry.trim() : '')
        .filter(Boolean))];
}

function validateScopeBudgetTieredThreshold(setting: UiSettingDefinition, proposedValue: number): void {
    const thresholdPairs: Record<string, { peerKey: string; relation: 'warning' | 'blocking' }> = {
        'scope_budget_guard.warn_files': { peerKey: 'scope_budget_guard.block_files', relation: 'warning' },
        'scope_budget_guard.block_files': { peerKey: 'scope_budget_guard.warn_files', relation: 'blocking' },
        'scope_budget_guard.warn_changed_lines': { peerKey: 'scope_budget_guard.block_changed_lines', relation: 'warning' },
        'scope_budget_guard.block_changed_lines': { peerKey: 'scope_budget_guard.warn_changed_lines', relation: 'blocking' },
        'scope_budget_guard.warn_required_reviews': { peerKey: 'scope_budget_guard.block_required_reviews', relation: 'warning' },
        'scope_budget_guard.block_required_reviews': { peerKey: 'scope_budget_guard.warn_required_reviews', relation: 'blocking' },
        'scope_budget_guard.warn_review_tokens': { peerKey: 'scope_budget_guard.block_review_tokens', relation: 'warning' },
        'scope_budget_guard.block_review_tokens': { peerKey: 'scope_budget_guard.warn_review_tokens', relation: 'blocking' }
    };
    const pair = thresholdPairs[setting.key];
    if (!pair) {
        return;
    }
    const peerValue = setting.peer_values?.[pair.peerKey];
    if (typeof peerValue !== 'number') {
        return;
    }
    const valid = pair.relation === 'warning'
        ? proposedValue < peerValue
        : peerValue < proposedValue;
    if (!valid) {
        throw new Error(`${setting.label} must keep the warning threshold lower than the blocking threshold.`);
    }
}

export function parseUiSettingValue(setting: UiSettingDefinition, value: unknown): ParsedUiSettingValue {
    const raw = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : '';
    if (setting.value_type === 'integer') {
        if (!/^\d+$/u.test(raw)) {
            throw new Error(`${setting.label} must be an integer.`);
        }
        const parsed = Number(raw);
        const min = setting.min ?? 1;
        const max = setting.max ?? Number.MAX_SAFE_INTEGER;
        if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
            throw new Error(`${setting.label} must be an integer from ${min} to ${max}.`);
        }
        validateScopeBudgetTieredThreshold(setting, parsed);
        if (setting.key.startsWith('compact.')) {
            const compact = Object.fromEntries(Object.entries(setting.peer_values ?? {})
                .filter(([key]) => key.startsWith('compact.')).map(([key, current]) => [key.slice(8), current]));
            compact[setting.key.slice(8)] = parsed;
            compactSettingsFromConfig(compact);
        }
        return {
            command_value: String(parsed),
            proposed_value: parsed
        };
    }
    if (setting.value_type === 'boolean') {
        const normalized = raw.toLowerCase();
        if (!['true', 'false', 'on', 'off', 'yes', 'no', '1', '0'].includes(normalized)) {
            throw new Error(`${setting.label} must be on or off.`);
        }
        const enabled = ['true', 'on', 'yes', '1'].includes(normalized);
        return {
            command_value: String(setting.command_value_inverts_boolean ? !enabled : enabled),
            proposed_value: enabled
        };
    }
    if (setting.value_type === 'enum') {
        const option = setting.options.find((candidate) => candidate.value === raw);
        if (!option) {
            throw new Error(`${setting.label} must be one of: ${setting.options.map((candidate) => candidate.value).join(', ')}.`);
        }
        return {
            command_value: option.value,
            proposed_value: option.value
        };
    }
    if (setting.value_type === 'enum_list') {
        const values = normalizeEnumListValue(value);
        if (values.length === 0) {
            throw new Error(`${setting.label} must contain at least one value.`);
        }
        const allowedValues = new Set(setting.options.map((candidate) => candidate.value));
        const invalidValues = values.filter((entry) => !allowedValues.has(entry));
        if (invalidValues.length > 0) {
            throw new Error(`${setting.label} contains unsupported value(s): ${invalidValues.join(', ')}. Allowed values: ${setting.options.map((candidate) => candidate.value).join(', ')}.`);
        }
        return {
            command_value: values.join(','),
            proposed_value: values
        };
    }
    if (setting.value_type === 'string_list') {
        const values = [...new Set(raw.split(',').map((entry) => entry.trim()).filter(Boolean))];
        if (values.length === 0) {
            throw new Error(`${setting.label} must contain at least one value.`);
        }
        return {
            command_value: values.join(','),
            proposed_value: values
        };
    }
    if (!raw) {
        throw new Error(`${setting.label} must not be empty.`);
    }
    if (setting.id === 'compile-gate-command') {
        validateCompileGateCommand(raw, '--compile-gate-command', {
            fullSuiteCommand: setting.compile_gate_full_suite_command
        });
    }
    return {
        command_value: raw,
        proposed_value: raw
    };
}

function buildUiSettingCommand(
    repoRoot: string,
    setting: UiSettingDefinition,
    commandValue: string,
    timestampUtc: string
): ReturnType<typeof buildUiActionCommand> {
    const args = [
        'workflow',
        'set',
        setting.flag,
        commandValue,
        '--target-root',
        repoRoot,
        '--operator-confirmed',
        'yes',
        '--operator-confirmed-at-utc',
        timestampUtc,
        '--mutation-source',
        'local-ui'
    ];
    return buildUiActionCommand(repoRoot, args);
}

export function buildUiSettingAction(
    repoRoot: string,
    setting: UiSettingDefinition,
    commandValue: string,
    timestampUtc: string
): UiActionDefinition {
    return {
        id: `setting:${setting.id}`,
        category: 'Workflow Config',
        label: setting.label,
        description: setting.description,
        mutates: true,
        enabled: true,
        unavailable_reason: null,
        requires_confirmation: true,
        confirmation_phrase: setting.confirmation_phrase,
        timeout_ms: UI_ACTION_DEFAULT_TIMEOUT_MS,
        command: buildUiSettingCommand(repoRoot, setting, commandValue, timestampUtc)
    };
}

function normalizeRuleId(value: unknown): string {
    const ruleId = typeof value === 'string' ? value.trim().toLowerCase() : '';
    if (!ruleId) {
        throw new Error('Optional quality-check rule id must not be empty.');
    }
    return ruleId;
}

function normalizeOptionalText(value: unknown): string | null {
    if (value === undefined || value === null) {
        return null;
    }
    const text = typeof value === 'string' ? value.trim() : '';
    if (!text) {
        throw new Error('Optional quality-check rule title and prompt must not be empty.');
    }
    return text;
}

function normalizeOptionalRuleEnabled(value: unknown): boolean | null {
    if (value === undefined || value === null || value === '') {
        return null;
    }
    const raw = typeof value === 'boolean' ? String(value) : typeof value === 'string' ? value.trim().toLowerCase() : '';
    if (['true', 'on', 'yes', '1'].includes(raw)) {
        return true;
    }
    if (['false', 'off', 'no', '0'].includes(raw)) {
        return false;
    }
    throw new Error('Optional quality-check rule enabled must be on or off.');
}

function normalizeOptionalRuleExcludeTestOnly(value: unknown): boolean | null {
    if (value === undefined || value === null || value === '') {
        return null;
    }
    const raw = typeof value === 'boolean' ? String(value) : typeof value === 'string' ? value.trim().toLowerCase() : '';
    if (['true', 'on', 'yes', '1'].includes(raw)) {
        return true;
    }
    if (['false', 'off', 'no', '0'].includes(raw)) {
        return false;
    }
    throw new Error('Optional quality-check rule test-only exclusion must be on or off.');
}

function optionalCheckRuleScopeCommandArgs(excludeTestOnly: boolean | null): string[] {
    return excludeTestOnly === null
        ? []
        : ['--optional-check-rule-exclude-test-only', String(excludeTestOnly)];
}

function optionalCheckRuleScopeProposedValue(excludeTestOnly: boolean | null): Record<string, unknown> {
    return excludeTestOnly === null
        ? {}
        : { excluded_scope_categories: excludeTestOnly ? ['test-only'] : [] };
}

export function parseUiOptionalCheckRuleValue(payload: {
    optional_rule_action?: unknown;
    rule_id?: unknown;
    title?: unknown;
    prompt?: unknown;
    enabled?: unknown;
    exclude_test_only?: unknown;
}): ParsedUiOptionalCheckRuleValue {
    const action: UiOptionalCheckRuleAction = payload.optional_rule_action === 'delete' ? 'delete' : 'upsert';
    const ruleId = normalizeRuleId(payload.rule_id);
    if (action === 'delete') {
        if (isBaselineOptionalQualityCheckRuleId(ruleId)) {
            throw new Error(`Baseline optional quality-check rule '${ruleId}' cannot be deleted. Disable it instead.`);
        }
        return {
            action,
            rule_id: ruleId,
            title: null,
            prompt: null,
            enabled: null,
            exclude_test_only: null,
            proposed_value: { action, id: ruleId },
            command_args: ['--optional-check-rule-delete', ruleId]
        };
    }
    const baselineRule = getBaselineOptionalQualityCheckRule(ruleId);
    const excludeTestOnly = normalizeOptionalRuleExcludeTestOnly(payload.exclude_test_only);
    if (baselineRule) {
        const title = normalizeOptionalText(payload.title);
        const prompt = normalizeOptionalText(payload.prompt);
        if (
            (title !== null && title !== baselineRule.title)
            || (prompt !== null && prompt !== baselineRule.prompt)
        ) {
            throw new Error(`Baseline optional quality-check rule '${ruleId}' can only change enabled state and scope exclusions.`);
        }
        const enabled = normalizeOptionalRuleEnabled(payload.enabled);
        if (enabled === null) {
            throw new Error(`Baseline optional quality-check rule '${ruleId}' requires an explicit enabled state.`);
        }
        return {
            action,
            rule_id: ruleId,
            title: baselineRule.title,
            prompt: baselineRule.prompt,
            enabled,
            exclude_test_only: excludeTestOnly,
            proposed_value: {
                action,
                id: ruleId,
                title: baselineRule.title,
                prompt: baselineRule.prompt,
                enabled,
                ...optionalCheckRuleScopeProposedValue(excludeTestOnly)
            },
            command_args: [
                '--optional-check-rule-id',
                ruleId,
                '--optional-check-rule-enabled',
                String(enabled),
                ...optionalCheckRuleScopeCommandArgs(excludeTestOnly)
            ]
        };
    }
    const title = normalizeOptionalText(payload.title);
    const prompt = normalizeOptionalText(payload.prompt);
    const enabled = normalizeOptionalRuleEnabled(payload.enabled);
    if (!title) {
        throw new Error('Optional quality-check rule title is required.');
    }
    if (!prompt) {
        throw new Error('Optional quality-check rule prompt is required.');
    }
    return {
        action,
        rule_id: ruleId,
        title,
        prompt,
        enabled,
        exclude_test_only: excludeTestOnly,
        proposed_value: {
            action,
            id: ruleId,
            title,
            prompt,
            enabled: enabled ?? true,
            ...optionalCheckRuleScopeProposedValue(excludeTestOnly)
        },
        command_args: [
            '--optional-check-rule-id',
            ruleId,
            '--optional-check-rule-title',
            title,
            '--optional-check-rule-prompt',
            prompt,
            '--optional-check-rule-enabled',
            String(enabled ?? true),
            ...optionalCheckRuleScopeCommandArgs(excludeTestOnly)
        ]
    };
}

export function buildUiOptionalCheckRuleAction(
    repoRoot: string,
    value: ParsedUiOptionalCheckRuleValue,
    timestampUtc: string
): UiActionDefinition {
    const args = [
        'workflow',
        'set',
        ...value.command_args,
        '--target-root',
        repoRoot,
        '--operator-confirmed',
        'yes',
        '--operator-confirmed-at-utc',
        timestampUtc,
        '--mutation-source',
        'local-ui'
    ];
    const label = value.action === 'delete'
        ? `Remove optional check rule ${value.rule_id}`
        : `Save optional check rule ${value.rule_id}`;
    return {
        id: `setting:optional-check-rule:${value.action}:${value.rule_id}`,
        category: 'Workflow Config',
        label,
        description: 'Updates optional quality-check rules through the audited workflow set path.',
        mutates: true,
        enabled: true,
        unavailable_reason: null,
        requires_confirmation: true,
        confirmation_phrase: UI_SETTING_CONFIRMATION_PHRASE,
        timeout_ms: UI_ACTION_DEFAULT_TIMEOUT_MS,
        command: buildUiActionCommand(repoRoot, args)
    };
}

export type { WorkflowSettingOption, WorkflowSettingValueType };
