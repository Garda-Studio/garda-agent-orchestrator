import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { handleWorkflow } from '../../../../src/cli/commands/workflow-command';
import { buildGuardedCommandHelpText } from '../../../../src/cli/commands/cli-format-output';
import {
    DEFAULT_OPTIONAL_QUALITY_CHECKS_REVIEW_FAILURE_CADENCE_INTERVAL,
    DEFAULT_OPTIONAL_QUALITY_CHECK_RULES,
    MAX_OPTIONAL_QUALITY_CHECKS_REVIEW_FAILURE_CADENCE_INTERVAL,
    OPTIONAL_QUALITY_CHECKS_BASELINE_VERSION,
    buildDefaultWorkflowConfig,
    isGardaSelfGuardDenyAgentEntryForBundle
} from '../../../../src/core/workflow-config';
import { OPERATOR_CONFIRMATION_MAX_AGE_MS } from '../../../../src/core/operator-confirmation';
import { UNCONFIGURED_COMPILE_GATE_COMMAND } from '../../../../src/core/constants';
import { resolveTaskResetAvailability } from '../../../../src/core/task-reset-availability';
import { buildOperatorConfirmationArgs } from './operator-confirmation-test-helpers';
import { appendMandatoryTaskEvent, inspectTaskEventFile, readTaskTimelineJsonlEntries } from '../../../../src/gate-runtime/task-events';
import { stringSha256 } from '../../../../src/gate-runtime/hash';
import { runLogTaskEventCommand } from '../../../../src/cli/commands/gate-flows/completion/completion-flow';

const PACKAGE_JSON = { name: 'garda-agent-orchestrator', version: '1.0.0' };

function stripAnsi(value: string): string {
    return value.replace(/\x1B\[[0-9;?]*[ -/]*[@-~]/g, '');
}

function createBundleRoot(
    fullSuiteOverrides: Partial<Record<string, unknown>> = {},
    workflowOverrides: Partial<Record<string, unknown>> = {}
): string {
    const bundleRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-workflow-'));
    const configDir = path.join(bundleRoot, 'live', 'config');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
        path.join(configDir, 'workflow-config.json'),
        JSON.stringify({
            compile_gate: {
                command: UNCONFIGURED_COMPILE_GATE_COMMAND
            },
            full_suite_validation: {
                enabled: false,
                command: 'npm test',
                timeout_ms: 600000,
                green_summary_max_lines: 5,
                red_failure_chunk_lines: 50,
                out_of_scope_failure_policy: 'AUDIT_AND_BLOCK',
                placement: 'before_test_review',
                ...fullSuiteOverrides
            },
            review_execution_policy: {
                mode: 'code_first_optional'
            },
            task_reset: {
                enabled: false
            },
            auto_backup: {
                enabled: false,
                interval_days: 1,
                keep_latest: 10
            },
            ...workflowOverrides
        }, null, 2),
        'utf8'
    );
    return bundleRoot;
}

function captureConsole<T>(run: () => T): { result: T; output: string } {
    const originalConsoleLog = console.log;
    const lines: string[] = [];
    console.log = (...items: unknown[]) => {
        lines.push(stripAnsi(items.join(' ')));
    };
    try {
        return {
            result: run(),
            output: lines.join('\n')
        };
    } finally {
        console.log = originalConsoleLog;
    }
}

function defaultOptionalQualityCheckRuleIds(): string {
    return DEFAULT_OPTIONAL_QUALITY_CHECK_RULES.map((rule) => rule.id).join(', ');
}

test('workflow set binds exact committed audit records to distinct native task entries', () => {
    const bundleRoot = createBundleRoot();
    const taskId = 'T-WORKFLOW-AUDIT-1';
    const timeline = path.join(bundleRoot, 'runtime/task-events', `${taskId}.jsonl`);
    try {
        for (const command of ['node --test tests/first.test.js', 'node --test tests/second.test.js']) {
            appendMandatoryTaskEvent(bundleRoot, taskId, 'TASK_MODE_ENTERED', 'PASS', 'Start task cycle.', {}, { actor: 'gate' });
            const entry = readTaskTimelineJsonlEntries(timeline).at(-1);
            assert.ok(entry);
            const { result } = captureConsole(() => handleWorkflow([
                'set', '--bundle-root', bundleRoot, '--full-suite-command', command,
                ...buildOperatorConfirmationArgs()
            ], PACKAGE_JSON));
            assert.ok(result && result.action === 'set' && result.audit_path);
            const auditLine = fs.readFileSync(result.audit_path, 'utf8').trim().split(/\r?\n/u).at(-1);
            assert.ok(auditLine);
            const stages = readTaskTimelineJsonlEntries(timeline).slice(-2).map(({ record }) => record);
            const [prepared, binding] = stages;
            assert.equal(prepared?.event_type, 'WORKFLOW_CONFIG_MUTATION_PREPARED');
            assert.equal(prepared?.actor, 'workflow-config-set');
            assert.equal(prepared?.outcome, 'INFO');
            assert.equal(binding?.event_type, 'WORKFLOW_CONFIG_MUTATION_AUDITED');
            assert.equal(binding?.actor, 'workflow-config-set');
            assert.equal(binding?.outcome, 'PASS');
            const details = binding?.details as Record<string, unknown>;
            assert.deepEqual(prepared?.details, details);
            assert.equal(details.task_mode_entry_sha256, stringSha256(entry.rawLine.trim()));
            assert.equal(details.audit_record_sha256, stringSha256(auditLine));
            assert.equal(JSON.parse(auditLine).command_only_change, true);
        }
        assert.equal(inspectTaskEventFile(timeline, taskId).status, 'PASS');
        for (const eventType of ['WORKFLOW_CONFIG_MUTATION_AUDITED', 'workflow_config_mutation_prepared']) {
            assert.throws(() => runLogTaskEventCommand({
                repoRoot: bundleRoot, eventsRoot: path.dirname(timeline), taskId,
                eventType, outcome: 'PASS', actor: 'workflow-config-set'
            }), /reserved and cannot be emitted/u);
        }
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('workflow set persists compact settings through the audited transaction', () => {
    const bundleRoot = createBundleRoot();
    try {
        const { result } = captureConsole(() => handleWorkflow([
            'set', '--bundle-root', bundleRoot, '--compact-enabled', 'false', '--compact-preview-lines', '8',
            ...buildOperatorConfirmationArgs()
        ], PACKAGE_JSON));
        assert.ok(result && result.action === 'set');
        assert.equal(result.status, 'CHANGED');
        assert.ok(result.changed_fields?.includes('compact.enabled'));
        const config = JSON.parse(fs.readFileSync(path.join(bundleRoot, 'live/config/workflow-config.json'), 'utf8'));
        assert.equal(config.compact.enabled, false);
        assert.equal(config.compact.preview_lines, 8);
        assert.ok(result.audit_path);
    } finally { fs.rmSync(bundleRoot, { recursive: true, force: true }); }
});

test('workflow show prints repo-local full-suite settings', () => {
    const bundleRoot = createBundleRoot();

    try {
        const { result, output } = captureConsole(() => handleWorkflow(['show', '--bundle-root', bundleRoot], PACKAGE_JSON));
        assert.ok(result && result.action === 'show');
        assert.ok(output.includes('GARDA_WORKFLOW'));
        assert.ok(output.includes('Action: show'));
        assert.ok(output.includes('Scope: repo-local'));
        assert.ok(output.includes('Compile gate command: unconfigured (fail-closed)'));
        assert.ok(output.includes(`CompileGateCommand: ${UNCONFIGURED_COMPILE_GATE_COMMAND}`));
        assert.ok(output.includes('CompileGateCommandSource: unconfigured-fail-closed'));
        assert.ok(output.includes('CompileGateFallback: disabled'));
        assert.ok(output.includes('CompileGateRemediation: Set workflow-config compile_gate.command with workflow set --compile-gate-command "<compile/build/type-check command>"'));
        const mutationHints = output.split('\n').filter((line) => line.startsWith('Tip: run "workflow set') && !line.includes('--garda-self-guard'));
        assert.ok(mutationHints.length > 0);
        for (const hint of mutationHints) {
            assert.ok(hint.includes('--operator-confirmed yes --operator-confirmed-at-utc "<ISO-8601 timestamp>"'), hint);
        }
        assert.ok(output.includes('Mandatory full-suite: false'));
        assert.ok(output.includes('Review execution policy: code_first_optional'));
        assert.ok(output.includes('FullSuiteCommand: npm test'));
        assert.ok(output.includes('FullSuitePerformance: mode=standard; optimized=false; boundary=mandatory_full_suite_not_smoke_or_fast'));
        assert.ok(output.includes('FullSuiteTimeoutBlocker: true'));
        assert.ok(output.includes('FullSuiteTimeoutRetryCount: 1'));
        assert.ok(output.includes('FullSuitePlacement: before_test_review'));
        assert.ok(output.includes('Scope budget guard: tiered WARN/BLOCK'));
        assert.ok(output.includes('warn_reviews=5 block_reviews=8'));
        assert.ok(output.includes('ScopeBudgetGuardLegacyMaxMappingMode: WARN_ONLY'));
        assert.ok(output.includes('ScopeBudgetGuardBlocking: explicit block_* thresholds produce BLOCK in every legacy mapping mode'));
        assert.ok(output.includes('ScopeBudgetGuardMaxRequiredReviews: 5'));
        assert.ok(output.includes('ScopeBudgetGuardWarnChangedLines: 2000'));
        assert.ok(output.includes('ScopeBudgetGuardBlockChangedLines: 5000'));
        assert.equal(result.scope_budget_guard.max_required_reviews, 5);
        assert.equal(result.scope_budget_guard.warn_changed_lines, 2000);
        assert.equal(result.scope_budget_guard.block_changed_lines, 5000);
        assert.ok(output.includes('Review cycle guard: BLOCK_FOR_OPERATOR_DECISION'));
        assert.ok(output.includes('max_failed_non_test_reviews=10 max_total_non_test_reviews=30'));
        assert.ok(output.includes('Project memory maintenance: update read_strategy=index_first'));
        assert.ok(output.includes('Task reset: disabled'));
        assert.ok(output.includes('Auto backup: disabled interval_days=1 keep_latest=10'));
        assert.ok(output.includes(`Optional quality checks: enabled baseline=${OPTIONAL_QUALITY_CHECKS_BASELINE_VERSION} rules=${DEFAULT_OPTIONAL_QUALITY_CHECK_RULES.length} enabled_rules=${DEFAULT_OPTIONAL_QUALITY_CHECK_RULES.length} cadence_interval=${DEFAULT_OPTIONAL_QUALITY_CHECKS_REVIEW_FAILURE_CADENCE_INTERVAL}`));
        assert.ok(output.includes(`OptionalQualityChecksReviewFailureCadenceInterval: ${DEFAULT_OPTIONAL_QUALITY_CHECKS_REVIEW_FAILURE_CADENCE_INTERVAL}`));
        assert.equal(result.optional_skill_selection_policy.mode, 'optional');
        assert.equal(result.optional_skill_selection_policy.effective_mode, 'optional');
        assert.equal(result.optional_skill_selection_policy.status, 'missing');
        assert.ok(output.includes('Specialist-skill selection: optional status=missing'));
        assert.ok(output.includes('TaskResetEnabled: false'));
        assert.ok(output.includes('AutoBackupEnabled: false'));
        assert.ok(output.includes('OptionalQualityChecksEnabled: true'));
        assert.ok(output.includes(`OptionalQualityChecksBaselineVersion: ${OPTIONAL_QUALITY_CHECKS_BASELINE_VERSION}`));
        assert.ok(output.includes(`OptionalQualityChecksRuleIds: ${defaultOptionalQualityCheckRuleIds()}`));
        assert.ok(output.includes('OptionalQualityCheckRule: code_simplification enabled=true title=Code simplification'));
        assert.ok(output.includes('OptionalQualityCheckRule: test_verification_scope enabled=true title=Test and verification scope'));
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('workflow set updates optional skill selection policy without rewriting workflow config', () => {
    const bundleRoot = createBundleRoot();
    const workflowConfigPath = path.join(bundleRoot, 'live', 'config', 'workflow-config.json');
    const policyPath = path.join(bundleRoot, 'live', 'config', 'optional-skill-selection-policy.json');
    const beforeWorkflowConfig = fs.readFileSync(workflowConfigPath, 'utf8');
    fs.writeFileSync(policyPath, JSON.stringify({
        version: 1,
        mode: 'required',
        local_note: 'preserve me'
    }, null, 2), 'utf8');

    try {
        const { result, output } = captureConsole(() => handleWorkflow([
            'set',
            '--bundle-root', bundleRoot,
            '--optional-skill-selection-mode', 'mandatory',
            ...buildOperatorConfirmationArgs()
        ], PACKAGE_JSON));
        assert.ok(result && result.action === 'set');
        assert.equal(result.status, 'CHANGED');
        assert.deepEqual(result.requested_fields, ['optional_skill_selection_policy.mode']);
        assert.deepEqual(result.changed_fields, ['optional_skill_selection_policy.mode']);
        assert.equal(result.optional_skill_selection_policy.mode, 'mandatory');
        assert.equal(result.optional_skill_selection_policy.effective_mode, 'mandatory');
        assert.ok(output.includes('Specialist-skill selection: mandatory'));

        const policy = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
        assert.equal(policy.mode, 'mandatory');
        assert.equal(policy.local_note, 'preserve me');
        assert.equal(fs.readFileSync(workflowConfigPath, 'utf8'), beforeWorkflowConfig);
        assert.ok(result.audit_path);
        const auditLines = fs.readFileSync(path.join(bundleRoot, 'runtime', 'workflow-config-audit.jsonl'), 'utf8').trim().split(/\r?\n/u);
        const latestAudit = JSON.parse(auditLines[auditLines.length - 1]);
        assert.deepEqual(latestAudit.changed_fields, ['optional_skill_selection_policy.mode']);
        assert.match(latestAudit.config_path, /optional-skill-selection-policy\.json$/u);
        assert.equal(latestAudit.mutation_source, 'cli');
        assert.deepEqual(latestAudit.active_task_ids, []);
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('workflow show renders legacy optional skill selection policy with canonical primary labels', () => {
    const bundleRoot = createBundleRoot();
    const policyPath = path.join(bundleRoot, 'live', 'config', 'optional-skill-selection-policy.json');
    fs.writeFileSync(policyPath, JSON.stringify({
        version: 1,
        mode: 'required'
    }, null, 2), 'utf8');

    try {
        const { result, output } = captureConsole(() => handleWorkflow(['show', '--bundle-root', bundleRoot], PACKAGE_JSON));

        assert.ok(result && result.action === 'show');
        assert.equal(result.optional_skill_selection_policy.mode, 'required');
        assert.equal(result.optional_skill_selection_policy.effective_mode, 'mandatory');
        assert.ok(output.includes('Specialist-skill selection: mandatory (legacy config=required)'));
        assert.ok(output.includes('OptionalSkillSelectionPolicyMode: mandatory'));
        assert.ok(output.includes('OptionalSkillSelectionPolicyEffectiveMode: mandatory'));
        assert.ok(output.includes('OptionalSkillSelectionPolicyLegacyMode: required'));
        assert.ok(!output.includes('Specialist-skill selection: required'));
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('workflow set updates compile-gate command and validates full-suite separation', () => {
    const bundleRoot = createBundleRoot();
    const configPath = path.join(bundleRoot, 'live', 'config', 'workflow-config.json');

    try {
        const { result, output } = captureConsole(() => handleWorkflow([
            'set',
            '--bundle-root', bundleRoot,
            '--compile-gate-command', 'npm run typecheck',
            ...buildOperatorConfirmationArgs()
        ], PACKAGE_JSON));
        assert.ok(result && result.action === 'set');
        assert.equal(result.status, 'CHANGED');
        assert.equal(result.compile_gate.command, 'npm run typecheck');
        assert.ok(result.changed_fields.includes('compile_gate.command'));
        assert.ok(output.includes('Compile gate command: configured (npm run typecheck)'));

        const parsedConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        assert.equal(parsedConfig.compile_gate.command, 'npm run typecheck');

        const { output: showOutput } = captureConsole(() => handleWorkflow(['show', '--bundle-root', bundleRoot], PACKAGE_JSON));
        assert.ok(showOutput.includes('CompileGateCommand: npm run typecheck'));
        assert.ok(showOutput.includes('CompileGateCommandSource: workflow-config'));
        assert.ok(showOutput.includes('CompileGateFallback: disabled'));
        assert.ok(showOutput.includes('CompileGateRemediation: none'));

        assert.throws(
            () => handleWorkflow([
                'set',
                '--bundle-root', bundleRoot,
                '--compile-gate-command', 'npm test',
                ...buildOperatorConfirmationArgs()
            ], PACKAGE_JSON),
            /must not run the full test suite/i
        );
        assert.throws(
            () => handleWorkflow([
                'set',
                '--bundle-root', bundleRoot,
                '--full-suite-command', 'npm run typecheck',
                ...buildOperatorConfirmationArgs()
            ], PACKAGE_JSON),
            /matches the configured full-suite validation command/i
        );
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('workflow set updates scope budget guard settings deterministically', () => {
    const bundleRoot = createBundleRoot();
    const configPath = path.join(bundleRoot, 'live', 'config', 'workflow-config.json');

    try {
        const { result, output } = captureConsole(() => handleWorkflow([
            'set',
            '--bundle-root', bundleRoot,
            '--scope-budget-enabled', 'true',
            '--scope-budget-action', 'warn_only',
            '--scope-budget-profiles', 'strict,balanced',
            '--scope-budget-max-files', '7',
            '--scope-budget-max-changed-lines', '300',
            '--scope-budget-max-required-reviews', '3',
            '--scope-budget-max-review-tokens', '5000',
            '--scope-budget-block-files', '50',
            '--scope-budget-block-changed-lines', '5000',
            '--scope-budget-block-required-reviews', '8',
            '--scope-budget-block-review-tokens', '100000',
            ...buildOperatorConfirmationArgs()
        ], PACKAGE_JSON));
        assert.ok(result && result.action === 'set');
        assert.equal(result.status, 'CHANGED');
        assert.ok(output.includes('Scope budget guard: tiered WARN/BLOCK profiles=strict,balanced'));

        const parsedConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        assert.equal(parsedConfig.scope_budget_guard.enabled, true);
        assert.equal(parsedConfig.scope_budget_guard.action, 'WARN_ONLY');
        assert.deepEqual(parsedConfig.scope_budget_guard.profiles, ['strict', 'balanced']);
        assert.equal(parsedConfig.scope_budget_guard.max_files, 7);
        assert.equal(parsedConfig.scope_budget_guard.max_changed_lines, 300);
        assert.equal(parsedConfig.scope_budget_guard.max_required_reviews, 3);
        assert.equal(parsedConfig.scope_budget_guard.max_review_tokens, 5000);
        assert.equal(parsedConfig.scope_budget_guard.warn_files, 7);
        assert.equal(parsedConfig.scope_budget_guard.block_files, 50);
        assert.equal(parsedConfig.scope_budget_guard.warn_changed_lines, 300);
        assert.equal(parsedConfig.scope_budget_guard.block_changed_lines, 5000);
        assert.equal(parsedConfig.scope_budget_guard.warn_required_reviews, 3);
        assert.equal(parsedConfig.scope_budget_guard.block_required_reviews, 8);
        assert.equal(parsedConfig.scope_budget_guard.warn_review_tokens, 5000);
        assert.equal(parsedConfig.scope_budget_guard.block_review_tokens, 100000);
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('workflow set rejects scope budget warning thresholds that do not stay below blocking thresholds', () => {
    const bundleRoot = createBundleRoot();

    try {
        assert.throws(
            () => handleWorkflow([
                'set',
                '--bundle-root', bundleRoot,
                '--scope-budget-warn-files', '50',
                '--scope-budget-block-files', '50',
                ...buildOperatorConfirmationArgs()
            ], PACKAGE_JSON),
            /warn_files must be less than workflow-config\.scope_budget_guard\.block_files/u
        );
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('workflow set toggles optional quality checks without replacing rules', () => {
    const bundleRoot = createBundleRoot({}, {
        optional_quality_checks: {
            enabled: true,
            rules: [
                {
                    id: 'custom_review_focus',
                    title: 'Custom review focus',
                    prompt: 'Check the custom local review focus.',
                    enabled: true
                }
            ]
        }
    });
    const configPath = path.join(bundleRoot, 'live', 'config', 'workflow-config.json');

    try {
        const expectedRuleCount = DEFAULT_OPTIONAL_QUALITY_CHECK_RULES.length + 1;
        const expectedRuleIds = [
            'custom_review_focus',
            ...DEFAULT_OPTIONAL_QUALITY_CHECK_RULES.map((rule) => rule.id)
        ];
        const { result, output } = captureConsole(() => handleWorkflow([
            'set',
            '--bundle-root', bundleRoot,
            '--optional-checks', 'off',
            ...buildOperatorConfirmationArgs()
        ], PACKAGE_JSON));
        assert.ok(result && result.action === 'set');
        assert.equal(result.status, 'CHANGED');
        assert.equal(result.optional_quality_checks.enabled, false);
        assert.equal(result.optional_quality_checks.baseline_version, OPTIONAL_QUALITY_CHECKS_BASELINE_VERSION);
        assert.deepEqual(result.optional_quality_checks.rules.map((rule) => rule.id), expectedRuleIds);
        assert.ok(result.changed_fields.includes('optional_quality_checks.enabled'));
        assert.ok(output.includes(`Optional quality checks: disabled baseline=${OPTIONAL_QUALITY_CHECKS_BASELINE_VERSION} rules=${expectedRuleCount} enabled_rules=${expectedRuleCount} cadence_interval=${DEFAULT_OPTIONAL_QUALITY_CHECKS_REVIEW_FAILURE_CADENCE_INTERVAL}`));

        const parsedConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        assert.equal(parsedConfig.optional_quality_checks.enabled, false);
        assert.equal(parsedConfig.optional_quality_checks.baseline_version, OPTIONAL_QUALITY_CHECKS_BASELINE_VERSION);
        assert.equal(
            parsedConfig.optional_quality_checks.review_failure_cadence_interval,
            DEFAULT_OPTIONAL_QUALITY_CHECKS_REVIEW_FAILURE_CADENCE_INTERVAL
        );
        assert.deepEqual(parsedConfig.optional_quality_checks.rules[0], {
            id: 'custom_review_focus',
            title: 'Custom review focus',
            prompt: 'Check the custom local review focus.',
            enabled: true
        });
        assert.deepEqual(
            parsedConfig.optional_quality_checks.rules.slice(1).map((rule: { id: string }) => rule.id),
            DEFAULT_OPTIONAL_QUALITY_CHECK_RULES.map((rule) => rule.id)
        );
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('workflow set updates optional quality-check review-failure cadence interval', () => {
    const bundleRoot = createBundleRoot();
    const configPath = path.join(bundleRoot, 'live', 'config', 'workflow-config.json');

    try {
        const { result, output } = captureConsole(() => handleWorkflow([
            'set',
            '--bundle-root', bundleRoot,
            '--optional-checks-review-failure-cadence-interval', '5',
            ...buildOperatorConfirmationArgs()
        ], PACKAGE_JSON));

        assert.ok(result && result.action === 'set');
        assert.equal(result.status, 'CHANGED');
        assert.equal(result.optional_quality_checks.review_failure_cadence_interval, 5);
        assert.ok(result.changed_fields.includes('optional_quality_checks.review_failure_cadence_interval'));
        assert.ok(output.includes('OptionalQualityChecksReviewFailureCadenceInterval: 5'));
        assert.ok(output.includes('cadence_interval=5'));

        const parsedConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        assert.equal(parsedConfig.optional_quality_checks.review_failure_cadence_interval, 5);
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('workflow set rejects invalid optional quality-check review-failure cadence intervals', () => {
    const bundleRoot = createBundleRoot();

    try {
        for (const [value, expectedError] of [
            ['0', /--optional-checks-review-failure-cadence-interval must be >= 1/u],
            [String(MAX_OPTIONAL_QUALITY_CHECKS_REVIEW_FAILURE_CADENCE_INTERVAL + 1), /--optional-checks-review-failure-cadence-interval must be <= 100/u],
            ['1.5', /--optional-checks-review-failure-cadence-interval must be an integer/u]
        ] as const) {
            assert.throws(
                () => captureConsole(() => handleWorkflow([
                    'set',
                    '--bundle-root', bundleRoot,
                    '--optional-checks-review-failure-cadence-interval', value,
                    ...buildOperatorConfirmationArgs()
                ], PACKAGE_JSON)),
                expectedError
            );
        }
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('workflow set refreshes stale optional quality baseline version when writing rules', () => {
    const staleBaselineVersion = '2026-06-25.t839';
    const customRule = {
        id: 'custom_review_focus',
        title: 'Custom review focus',
        prompt: 'Check the custom local review focus.',
        enabled: true
    };
    const baselineRule = DEFAULT_OPTIONAL_QUALITY_CHECK_RULES[0];
    const legacyBaselineRuleWithoutScopeExclusions = { ...baselineRule };
    delete (legacyBaselineRuleWithoutScopeExclusions as { excluded_scope_categories?: string[] }).excluded_scope_categories;
    const bundleRoot = createBundleRoot({}, {
        optional_quality_checks: {
            enabled: true,
            baseline_version: staleBaselineVersion,
            rules: [
                customRule,
                legacyBaselineRuleWithoutScopeExclusions,
                ...DEFAULT_OPTIONAL_QUALITY_CHECK_RULES.slice(1).map((rule) => ({ ...rule }))
            ]
        }
    });
    const configPath = path.join(bundleRoot, 'live', 'config', 'workflow-config.json');

    try {
        const { result } = captureConsole(() => handleWorkflow([
            'set',
            '--bundle-root', bundleRoot,
            '--optional-check-rule-id', baselineRule.id,
            '--optional-check-rule-enabled', 'false',
            ...buildOperatorConfirmationArgs()
        ], PACKAGE_JSON));
        assert.ok(result && result.action === 'set');
        assert.equal(result.status, 'CHANGED');
        assert.ok(result.changed_fields.includes('optional_quality_checks.baseline_version'));
        assert.ok(result.changed_fields.includes('optional_quality_checks.rules'));

        const parsedConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        assert.equal(parsedConfig.optional_quality_checks.baseline_version, OPTIONAL_QUALITY_CHECKS_BASELINE_VERSION);
        assert.deepEqual(parsedConfig.optional_quality_checks.rules[0], customRule);
        const disabledBaselineRule = parsedConfig.optional_quality_checks.rules.find(
            (rule: { id: string }) => rule.id === baselineRule.id
        );
        assert.deepEqual(disabledBaselineRule, {
            id: baselineRule.id,
            title: baselineRule.title,
            prompt: baselineRule.prompt,
            enabled: false,
            excluded_scope_categories: baselineRule.excluded_scope_categories
        });
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('workflow set preserves explicit optional quality scope opt-out when refreshing stale baseline rules', () => {
    const staleBaselineVersion = '2026-06-25.t839';
    const baselineRule = DEFAULT_OPTIONAL_QUALITY_CHECK_RULES[0];
    const explicitOptOutRule = {
        ...baselineRule,
        excluded_scope_categories: []
    };
    const bundleRoot = createBundleRoot({}, {
        optional_quality_checks: {
            enabled: true,
            baseline_version: staleBaselineVersion,
            rules: [
                explicitOptOutRule,
                ...DEFAULT_OPTIONAL_QUALITY_CHECK_RULES.slice(1).map((rule) => ({ ...rule }))
            ]
        }
    });
    const configPath = path.join(bundleRoot, 'live', 'config', 'workflow-config.json');

    try {
        const { result } = captureConsole(() => handleWorkflow([
            'set',
            '--bundle-root', bundleRoot,
            '--optional-check-rule-id', baselineRule.id,
            '--optional-check-rule-enabled', 'false',
            ...buildOperatorConfirmationArgs()
        ], PACKAGE_JSON));
        assert.ok(result && result.action === 'set');
        assert.equal(result.status, 'CHANGED');

        const parsedConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        const disabledBaselineRule = parsedConfig.optional_quality_checks.rules.find(
            (rule: { id: string }) => rule.id === baselineRule.id
        );
        assert.deepEqual(disabledBaselineRule, {
            id: baselineRule.id,
            title: baselineRule.title,
            prompt: baselineRule.prompt,
            enabled: false,
            excluded_scope_categories: []
        });
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('workflow set adds edits disables and deletes optional quality-check rules', () => {
    const bundleRoot = createBundleRoot();
    const configPath = path.join(bundleRoot, 'live', 'config', 'workflow-config.json');

    try {
        const add = captureConsole(() => handleWorkflow([
            'set',
            '--bundle-root', bundleRoot,
            '--optional-check-rule-id', 'custom_focus',
            '--optional-check-rule-title', 'Custom focus',
            '--optional-check-rule-prompt', 'Check the custom concern.',
            '--optional-check-rule-enabled', 'true',
            ...buildOperatorConfirmationArgs()
        ], PACKAGE_JSON)).result;
        assert.ok(add && add.action === 'set');
        assert.equal(add.status, 'CHANGED');
        assert.ok(add.changed_fields.includes('optional_quality_checks.rules'));

        let parsedConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        let customRule = parsedConfig.optional_quality_checks.rules.find((rule: { id: string }) => rule.id === 'custom_focus');
        assert.deepEqual(customRule, {
            id: 'custom_focus',
            title: 'Custom focus',
            prompt: 'Check the custom concern.',
            enabled: true
        });

        const edit = captureConsole(() => handleWorkflow([
            'set',
            '--bundle-root', bundleRoot,
            '--optional-check-rule-id', 'custom_focus',
            '--optional-check-rule-title', 'Custom focus updated',
            '--optional-check-rule-prompt', 'Check the custom concern more carefully.',
            '--optional-check-rule-enabled', 'false',
            '--optional-check-rule-exclude-test-only', 'true',
            ...buildOperatorConfirmationArgs()
        ], PACKAGE_JSON)).result;
        assert.ok(edit && edit.action === 'set');
        assert.equal(edit.status, 'CHANGED');

        parsedConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        customRule = parsedConfig.optional_quality_checks.rules.find((rule: { id: string }) => rule.id === 'custom_focus');
        assert.deepEqual(customRule, {
            id: 'custom_focus',
            title: 'Custom focus updated',
            prompt: 'Check the custom concern more carefully.',
            enabled: false,
            excluded_scope_categories: ['test-only']
        });

        const remove = captureConsole(() => handleWorkflow([
            'set',
            '--bundle-root', bundleRoot,
            '--optional-check-rule-delete', 'custom_focus',
            ...buildOperatorConfirmationArgs()
        ], PACKAGE_JSON)).result;
        assert.ok(remove && remove.action === 'set');
        assert.equal(remove.status, 'CHANGED');

        parsedConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        assert.equal(
            parsedConfig.optional_quality_checks.rules.some((rule: { id: string }) => rule.id === 'custom_focus'),
            false
        );

        const baselineRule = DEFAULT_OPTIONAL_QUALITY_CHECK_RULES[0];
        const baselineToggle = captureConsole(() => handleWorkflow([
            'set',
            '--bundle-root', bundleRoot,
            '--optional-check-rule-id', baselineRule.id,
            '--optional-check-rule-enabled', 'false',
            ...buildOperatorConfirmationArgs()
        ], PACKAGE_JSON)).result;
        assert.ok(baselineToggle && baselineToggle.action === 'set');
        assert.equal(baselineToggle.status, 'CHANGED');
        assert.ok(baselineToggle.changed_fields.includes('optional_quality_checks.rules'));

        parsedConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        const disabledBaselineRule = parsedConfig.optional_quality_checks.rules.find((rule: { id: string }) => rule.id === baselineRule.id);
        assert.deepEqual(disabledBaselineRule, {
            ...baselineRule,
            enabled: false
        });

        const baselineUnexclude = captureConsole(() => handleWorkflow([
            'set',
            '--bundle-root', bundleRoot,
            '--optional-check-rule-id', baselineRule.id,
            '--optional-check-rule-exclude-test-only', 'false',
            ...buildOperatorConfirmationArgs()
        ], PACKAGE_JSON)).result;
        assert.ok(baselineUnexclude && baselineUnexclude.action === 'set');
        assert.equal(baselineUnexclude.status, 'CHANGED');

        parsedConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        const unexcludedBaselineRuleIndex = parsedConfig.optional_quality_checks.rules.findIndex(
            (rule: { id: string }) => rule.id === baselineRule.id
        );
        assert.ok(unexcludedBaselineRuleIndex >= 0);
        const unexcludedBaselineRule = parsedConfig.optional_quality_checks.rules[unexcludedBaselineRuleIndex];
        assert.deepEqual(unexcludedBaselineRule, {
            ...baselineRule,
            enabled: false,
            excluded_scope_categories: []
        });

        parsedConfig.optional_quality_checks.rules[unexcludedBaselineRuleIndex] = {
            ...unexcludedBaselineRule,
            title: 'Locally edited baseline title',
            prompt: 'Locally edited baseline prompt.',
            severity: 'warning'
        };
        fs.writeFileSync(configPath, JSON.stringify(parsedConfig, null, 2));

        const baselineRelimit = captureConsole(() => handleWorkflow([
            'set',
            '--bundle-root', bundleRoot,
            '--optional-check-rule-id', baselineRule.id,
            '--optional-check-rule-enabled', 'true',
            '--optional-check-rule-exclude-test-only', 'true',
            ...buildOperatorConfirmationArgs()
        ], PACKAGE_JSON)).result;
        assert.ok(baselineRelimit && baselineRelimit.action === 'set');
        assert.equal(baselineRelimit.status, 'CHANGED');

        parsedConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        const relimitedBaselineRule = parsedConfig.optional_quality_checks.rules.find((rule: { id: string }) => rule.id === baselineRule.id);
        assert.deepEqual(relimitedBaselineRule, {
            ...baselineRule,
            title: 'Locally edited baseline title',
            prompt: 'Locally edited baseline prompt.',
            enabled: true,
            excluded_scope_categories: ['test-only'],
            severity: 'warning'
        });

        parsedConfig.optional_quality_checks.rules[unexcludedBaselineRuleIndex] = {
            ...relimitedBaselineRule,
            excluded_scope_categories: ['future-scope', 'test-only']
        };
        fs.writeFileSync(configPath, JSON.stringify(parsedConfig, null, 2));

        const baselineKeepsOtherScope = captureConsole(() => handleWorkflow([
            'set',
            '--bundle-root', bundleRoot,
            '--optional-check-rule-id', baselineRule.id,
            '--optional-check-rule-exclude-test-only', 'false',
            ...buildOperatorConfirmationArgs()
        ], PACKAGE_JSON)).result;
        assert.ok(baselineKeepsOtherScope && baselineKeepsOtherScope.action === 'set');
        assert.equal(baselineKeepsOtherScope.status, 'CHANGED');

        parsedConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        const otherScopeOnlyBaselineRule = parsedConfig.optional_quality_checks.rules.find(
            (rule: { id: string }) => rule.id === baselineRule.id
        );
        assert.deepEqual(otherScopeOnlyBaselineRule.excluded_scope_categories, ['future-scope']);

        const baselineRestoresTestOnlyScope = captureConsole(() => handleWorkflow([
            'set',
            '--bundle-root', bundleRoot,
            '--optional-check-rule-id', baselineRule.id,
            '--optional-check-rule-exclude-test-only', 'true',
            ...buildOperatorConfirmationArgs()
        ], PACKAGE_JSON)).result;
        assert.ok(baselineRestoresTestOnlyScope && baselineRestoresTestOnlyScope.action === 'set');
        assert.equal(baselineRestoresTestOnlyScope.status, 'CHANGED');

        parsedConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        const restoredOtherScopeBaselineRule = parsedConfig.optional_quality_checks.rules.find(
            (rule: { id: string }) => rule.id === baselineRule.id
        );
        assert.deepEqual(restoredOtherScopeBaselineRule.excluded_scope_categories, ['future-scope', 'test-only']);

        assert.throws(
            () => captureConsole(() => handleWorkflow([
                'set',
                '--bundle-root', bundleRoot,
                '--optional-check-rule-id', baselineRule.id,
                '--optional-check-rule-title', 'Locally edited baseline title',
                '--optional-check-rule-prompt', baselineRule.prompt,
                ...buildOperatorConfirmationArgs()
            ], PACKAGE_JSON)),
            /can only change enabled state/
        );
        assert.throws(
            () => captureConsole(() => handleWorkflow([
                'set',
                '--bundle-root', bundleRoot,
                '--optional-check-rule-delete', baselineRule.id,
                ...buildOperatorConfirmationArgs()
            ], PACKAGE_JSON)),
            /cannot be deleted/
        );
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('workflow set updates review cycle guard settings deterministically', () => {
    const bundleRoot = createBundleRoot();
    const configPath = path.join(bundleRoot, 'live', 'config', 'workflow-config.json');

    try {
        const { result, output } = captureConsole(() => handleWorkflow([
            'set',
            '--bundle-root', bundleRoot,
            '--review-cycle-enabled', 'true',
            '--review-cycle-action', 'warn_only',
            '--review-cycle-max-failed-non-test-reviews', '4',
            '--review-cycle-max-total-non-test-reviews', '8',
            '--review-cycle-excluded-review-types', 'test,docs',
            '--review-cycle-auto-split-enabled', 'true',
            ...buildOperatorConfirmationArgs()
        ], PACKAGE_JSON));
        assert.ok(result && result.action === 'set');
        assert.equal(result.status, 'CHANGED');
        assert.ok(output.includes('Review cycle guard: WARN_ONLY'));
        assert.ok(output.includes('auto_split_enabled=true'));

        const parsedConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        assert.equal(parsedConfig.review_cycle_guard.enabled, true);
        assert.equal(parsedConfig.review_cycle_guard.action, 'WARN_ONLY');
        assert.equal(parsedConfig.review_cycle_guard.max_failed_non_test_reviews, 4);
        assert.equal(parsedConfig.review_cycle_guard.max_total_non_test_reviews, 8);
        assert.deepEqual(parsedConfig.review_cycle_guard.excluded_review_types, ['test', 'docs']);
        assert.equal(parsedConfig.review_cycle_guard.auto_split_enabled, true);
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('workflow set updates project memory maintenance settings deterministically', () => {
    const bundleRoot = createBundleRoot();
    const configPath = path.join(bundleRoot, 'live', 'config', 'workflow-config.json');

    try {
        const { result, output } = captureConsole(() => handleWorkflow([
            'set',
            '--bundle-root', bundleRoot,
            '--project-memory-enabled', 'true',
            '--project-memory-mode', 'update',
            '--project-memory-run-before-final-closeout', 'false',
            '--project-memory-require-user-approval-for-writes', 'false',
            '--project-memory-max-compact-summary-chars', '9000',
            '--project-memory-read-strategy', 'index_first',
            '--project-memory-impact-artifact-retention-days', '45',
            ...buildOperatorConfirmationArgs()
        ], PACKAGE_JSON));
        assert.ok(result && result.action === 'set');
        assert.equal(result.status, 'CHANGED');
        assert.ok(output.includes('Project memory maintenance: update read_strategy=index_first max_compact_summary_chars=9000'));

        const parsedConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        assert.equal(parsedConfig.project_memory_maintenance.enabled, true);
        assert.equal(parsedConfig.project_memory_maintenance.mode, 'update');
        assert.equal(parsedConfig.project_memory_maintenance.run_before_final_closeout, false);
        assert.equal(parsedConfig.project_memory_maintenance.require_user_approval_for_writes, false);
        assert.equal(parsedConfig.project_memory_maintenance.max_compact_summary_chars, 9000);
        assert.equal(parsedConfig.project_memory_maintenance.read_strategy, 'index_first');
        assert.equal(parsedConfig.project_memory_maintenance.impact_artifact_retention_days, 45);
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('workflow set updates task reset availability with audit record', () => {
    const bundleRoot = createBundleRoot();
    const configPath = path.join(bundleRoot, 'live', 'config', 'workflow-config.json');

    try {
        const { result, output } = captureConsole(() => handleWorkflow([
            'set',
            '--bundle-root', bundleRoot,
            '--task-reset-enabled', 'true',
            ...buildOperatorConfirmationArgs()
        ], PACKAGE_JSON));
        assert.ok(result && result.action === 'set');
        assert.equal(result.status, 'CHANGED');
        assert.equal(result.task_reset.enabled, true);
        assert.ok(result.changed_fields.includes('task_reset.enabled'));
        assert.ok(result.audit_path);
        assert.ok(output.includes('Task reset: enabled'));
        assert.ok(output.includes('TaskResetEnabled: true'));

        const parsedConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        assert.equal(parsedConfig.task_reset.enabled, true);
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('workflow set updates no-delegate mode with audit record', () => {
    const bundleRoot = createBundleRoot();
    const configPath = path.join(bundleRoot, 'live', 'config', 'workflow-config.json');

    try {
        const { result, output } = captureConsole(() => handleWorkflow([
            'set',
            '--bundle-root', bundleRoot,
            '--no-delegate', 'true',
            ...buildOperatorConfirmationArgs()
        ], PACKAGE_JSON));
        assert.ok(result && result.action === 'set');
        assert.equal(result.status, 'CHANGED');
        assert.equal(result.review_delegation.no_delegate, true);
        assert.ok(result.changed_fields.includes('review_delegation.no_delegate'));
        assert.ok(result.audit_path);
        assert.ok(output.includes('Review delegation: no-delegate active'));
        assert.ok(output.includes('NoDelegateMode: true'));

        const parsedConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        assert.equal(parsedConfig.review_delegation.no_delegate, true);
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('workflow set can repair task reset audit evidence when config is already enabled', () => {
    const bundleRoot = createBundleRoot();
    const configPath = path.join(bundleRoot, 'live', 'config', 'workflow-config.json');

    try {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as ReturnType<typeof buildDefaultWorkflowConfig>;
        config.task_reset.enabled = true;
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');

        const { result, output } = captureConsole(() => handleWorkflow([
            'set',
            '--bundle-root', bundleRoot,
            '--task-reset-enabled', 'true',
            ...buildOperatorConfirmationArgs()
        ], PACKAGE_JSON));
        assert.ok(result && result.action === 'set');
        assert.equal(result.status, 'NO_CHANGE');
        assert.equal(result.changed, false);
        assert.deepEqual(result.changed_fields, []);
        assert.deepEqual(result.noop_fields, ['task_reset.enabled']);
        assert.ok(result.audit_path);
        assert.ok(output.includes('Status: NO_CHANGE'));
        assert.ok(output.includes('audit evidence was refreshed'));
        assert.ok(!output.includes('no audit record was written'));
        const auditText = fs.readFileSync(result.audit_path, 'utf8');
        const auditRecord = JSON.parse(auditText) as { changed_fields?: unknown };
        assert.deepEqual(auditRecord.changed_fields, ['task_reset.enabled']);
        assert.equal(resolveTaskResetAvailability(bundleRoot).enabled, true);
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('workflow set repair task reset audit uses current config file bytes for non-canonical JSON', () => {
    const bundleRoot = createBundleRoot();
    const configPath = path.join(bundleRoot, 'live', 'config', 'workflow-config.json');

    try {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as ReturnType<typeof buildDefaultWorkflowConfig>;
        config.task_reset.enabled = true;
        fs.writeFileSync(configPath, JSON.stringify(config));

        const before = resolveTaskResetAvailability(bundleRoot);
        assert.equal(before.configuredEnabled, true);
        assert.equal(before.auditedEnablement, false);
        assert.equal(before.enabled, false);

        const { result } = captureConsole(() => handleWorkflow([
            'set',
            '--bundle-root', bundleRoot,
            '--task-reset-enabled', 'true',
            ...buildOperatorConfirmationArgs()
        ], PACKAGE_JSON));
        assert.ok(result && result.action === 'set');
        assert.equal(result.status, 'NO_CHANGE');
        assert.ok(result.audit_path);
        assert.equal(fs.readFileSync(configPath, 'utf8'), JSON.stringify(config));
        assert.equal(resolveTaskResetAvailability(bundleRoot).enabled, true);
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('workflow set updates scheduled auto-backup settings with audit record', () => {
    const bundleRoot = createBundleRoot();
    const configPath = path.join(bundleRoot, 'live', 'config', 'workflow-config.json');

    try {
        const { result, output } = captureConsole(() => handleWorkflow([
            'set',
            '--bundle-root', bundleRoot,
            '--auto-backup-enabled', 'true',
            '--auto-backup-interval-days', '3',
            '--auto-backup-keep-latest', '12',
            ...buildOperatorConfirmationArgs()
        ], PACKAGE_JSON));
        assert.ok(result && result.action === 'set');
        assert.equal(result.status, 'CHANGED');
        assert.equal(result.auto_backup.enabled, true);
        assert.equal(result.auto_backup.interval_days, 3);
        assert.equal(result.auto_backup.keep_latest, 12);
        assert.ok(result.changed_fields.includes('auto_backup.enabled'));
        assert.ok(result.changed_fields.includes('auto_backup.interval_days'));
        assert.ok(result.changed_fields.includes('auto_backup.keep_latest'));
        assert.ok(result.audit_path);
        assert.ok(output.includes('Auto backup: enabled interval_days=3 keep_latest=12'));
        assert.ok(output.includes('AutoBackupEnabled: true'));

        const parsedConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        assert.equal(parsedConfig.auto_backup.enabled, true);
        assert.equal(parsedConfig.auto_backup.interval_days, 3);
        assert.equal(parsedConfig.auto_backup.keep_latest, 12);
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('workflow set maps short on off aliases to existing boolean settings', () => {
    const defaultWorkflowConfig = buildDefaultWorkflowConfig();
    const bundleRoot = createBundleRoot({}, {
        review_cycle_guard: {
            ...defaultWorkflowConfig.review_cycle_guard,
            auto_split_enabled: false
        }
    });
    const configPath = path.join(bundleRoot, 'live', 'config', 'workflow-config.json');

    try {
        const { result } = captureConsole(() => handleWorkflow([
            'set',
            '--bundle-root', bundleRoot,
            '--full-suite', 'on',
            '--scope-budget', 'off',
            '--review-cycle', 'off',
            '--review-cycle-auto-split', 'on',
            '--project-memory', 'off',
            '--task-reset', 'on',
            '--auto-backup', 'on',
            ...buildOperatorConfirmationArgs()
        ], PACKAGE_JSON));

        assert.ok(result && result.action === 'set');
        assert.equal(result.status, 'CHANGED');
        assert.ok(result.changed_fields.includes('full_suite_validation.enabled'));
        assert.ok(result.changed_fields.includes('scope_budget_guard.enabled'));
        assert.ok(result.changed_fields.includes('review_cycle_guard.enabled'));
        assert.ok(result.changed_fields.includes('review_cycle_guard.auto_split_enabled'));
        assert.ok(result.changed_fields.includes('project_memory_maintenance.enabled'));
        assert.ok(result.changed_fields.includes('task_reset.enabled'));
        assert.ok(result.changed_fields.includes('auto_backup.enabled'));

        const parsedConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        assert.equal(parsedConfig.full_suite_validation.enabled, true);
        assert.equal(parsedConfig.scope_budget_guard.enabled, false);
        assert.equal(parsedConfig.review_cycle_guard.enabled, false);
        assert.equal(parsedConfig.review_cycle_guard.auto_split_enabled, true);
        assert.equal(parsedConfig.project_memory_maintenance.enabled, false);
        assert.equal(parsedConfig.task_reset.enabled, true);
        assert.equal(parsedConfig.auto_backup.enabled, true);
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('workflow set rejects conflicting short alias and long boolean flag values', () => {
    const pairs = [
        ['--full-suite', '--full-suite-enabled'],
        ['--scope-budget', '--scope-budget-enabled'],
        ['--review-cycle', '--review-cycle-enabled'],
        ['--review-cycle-auto-split', '--review-cycle-auto-split-enabled'],
        ['--project-memory', '--project-memory-enabled'],
        ['--task-reset', '--task-reset-enabled'],
        ['--auto-backup', '--auto-backup-enabled']
    ] as const;

    for (const [aliasFlag, canonicalFlag] of pairs) {
        const bundleRoot = createBundleRoot();
        try {
            assert.throws(
                () => handleWorkflow([
                    'set',
                    '--bundle-root', bundleRoot,
                    aliasFlag, 'on',
                    canonicalFlag, 'false',
                    ...buildOperatorConfirmationArgs()
                ], PACKAGE_JSON),
                new RegExp(`${aliasFlag} conflicts with ${canonicalFlag}`)
            );
        } finally {
            fs.rmSync(bundleRoot, { recursive: true, force: true });
        }
    }
});

test('workflow set rejects invalid boolean tokens for short aliases and canonical flags', () => {
    const pairs = [
        ['--full-suite', '--full-suite-enabled'],
        ['--scope-budget', '--scope-budget-enabled'],
        ['--review-cycle', '--review-cycle-enabled'],
        ['--review-cycle-auto-split', '--review-cycle-auto-split-enabled'],
        ['--project-memory', '--project-memory-enabled'],
        ['--task-reset', '--task-reset-enabled'],
        ['--auto-backup', '--auto-backup-enabled']
    ] as const;

    for (const flags of pairs) {
        for (const flag of flags) {
            const bundleRoot = createBundleRoot();
            try {
                assert.throws(
                    () => handleWorkflow([
                        'set',
                        '--bundle-root', bundleRoot,
                        flag, 'maybe',
                        ...buildOperatorConfirmationArgs()
                    ], PACKAGE_JSON),
                    new RegExp(`${flag} must be one of: true, false, yes, no, 1, 0, on, off`)
                );
            } finally {
                fs.rmSync(bundleRoot, { recursive: true, force: true });
            }
        }
    }
});

test('workflow set rejects invalid full-suite placement values', () => {
    const bundleRoot = createBundleRoot();
    try {
        assert.throws(
            () => handleWorkflow([
                'set',
                '--bundle-root', bundleRoot,
                '--full-suite-placement', 'after lunch',
                ...buildOperatorConfirmationArgs()
            ], PACKAGE_JSON),
            /--full-suite-placement must be one of: after_compile_before_reviews, before_test_review, before_completion/
        );
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('workflow set rejects invalid full-suite timeout retry count', () => {
    const bundleRoot = createBundleRoot();

    try {
        assert.throws(
            () => handleWorkflow([
                'set',
                '--bundle-root', bundleRoot,
                '--full-suite-timeout-retry-count', '-1',
                ...buildOperatorConfirmationArgs()
            ], PACKAGE_JSON),
            /--full-suite-timeout-retry-count must be an integer/
        );
        assert.throws(
            () => handleWorkflow([
                'set',
                '--bundle-root', bundleRoot,
                '--full-suite-timeout-retry-count', '4',
                ...buildOperatorConfirmationArgs()
            ], PACKAGE_JSON),
            /--full-suite-timeout-retry-count must be <= 3/
        );
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('workflow set enables garda self-guard without operator confirmation', () => {
    const bundleRoot = createBundleRoot({}, {
        orchestrator_work_policy: {
            mode: 'require_operator_confirmation'
        }
    });
    const configPath = path.join(bundleRoot, 'live', 'config', 'workflow-config.json');

    try {
        const { result, output } = captureConsole(() => handleWorkflow([
            'set',
            '--bundle-root', bundleRoot,
            '--garda-self-guard', 'on'
        ], PACKAGE_JSON));
        assert.ok(result && result.action === 'set');
        assert.equal(result.status, 'CHANGED');
        assert.equal(result.orchestrator_work_policy.mode, 'deny_agent_entry');
        assert.ok(result.changed_fields.includes('orchestrator_work_policy.mode'));
        assert.ok(result.audit_path);
        assert.ok(output.includes('Garda self-guard: on (deny_agent_entry)'));
        const parsedConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        assert.equal(parsedConfig.orchestrator_work_policy.mode, 'deny_agent_entry');
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('isGardaSelfGuardDenyAgentEntryForBundle centralizes source-checkout and policy checks', () => {
    const denyBundleRoot = createBundleRoot({}, {
        orchestrator_work_policy: {
            mode: 'deny_agent_entry'
        }
    });
    const confirmationBundleRoot = createBundleRoot({}, {
        orchestrator_work_policy: {
            mode: 'require_operator_confirmation'
        }
    });

    try {
        assert.equal(isGardaSelfGuardDenyAgentEntryForBundle(false, denyBundleRoot), true);
        assert.equal(isGardaSelfGuardDenyAgentEntryForBundle(true, denyBundleRoot), false);
        assert.equal(isGardaSelfGuardDenyAgentEntryForBundle(false, confirmationBundleRoot), false);
    } finally {
        fs.rmSync(denyBundleRoot, { recursive: true, force: true });
        fs.rmSync(confirmationBundleRoot, { recursive: true, force: true });
    }
});

test('workflow set requires operator confirmation to disable garda self-guard', () => {
    const bundleRoot = createBundleRoot({}, {
        orchestrator_work_policy: {
            mode: 'deny_agent_entry'
        }
    });

    try {
        assert.throws(
            () => handleWorkflow([
                'set',
                '--bundle-root', bundleRoot,
                '--garda-self-guard', 'off'
            ], PACKAGE_JSON),
            /workflow set requires explicit operator confirmation/
        );
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('workflow set rejects changed config without operator confirmation', () => {
    const bundleRoot = createBundleRoot();

    try {
        assert.throws(
            () => handleWorkflow([
                'set',
                '--bundle-root', bundleRoot,
                '--task-reset-enabled', 'true'
            ], PACKAGE_JSON),
            /workflow set requires explicit operator confirmation/
        );
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('workflow set rejects changed config without fresh operator confirmation timestamp', () => {
    const bundleRoot = createBundleRoot();

    try {
        assert.throws(
            () => handleWorkflow([
                'set',
                '--bundle-root', bundleRoot,
                '--task-reset-enabled', 'true',
                '--operator-confirmed', 'yes'
            ], PACKAGE_JSON),
            /workflow set requires --operator-confirmed-at-utc/
        );
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('workflow set rejects stale operator confirmation timestamps', () => {
    const bundleRoot = createBundleRoot();
    const staleConfirmation = new Date(Date.now() - 11 * 60 * 1000).toISOString();

    try {
        assert.throws(
            () => handleWorkflow([
                'set',
                '--bundle-root', bundleRoot,
                '--task-reset-enabled', 'true',
                '--operator-confirmed', 'yes',
                '--operator-confirmed-at-utc', staleConfirmation
            ], PACKAGE_JSON),
            /workflow set operator confirmation is stale/
        );
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('workflow set accepts operator confirmation timestamp exactly at freshness cutoff', () => {
    const bundleRoot = createBundleRoot();
    const configPath = path.join(bundleRoot, 'live', 'config', 'workflow-config.json');
    const nowMs = Date.parse('2026-01-01T00:00:00.000Z');
    const dateNow = mock.method(Date, 'now', () => nowMs);
    const boundaryConfirmation = new Date(nowMs - OPERATOR_CONFIRMATION_MAX_AGE_MS).toISOString();

    try {
        const { result } = captureConsole(() => handleWorkflow([
            'set',
            '--bundle-root', bundleRoot,
            '--task-reset-enabled', 'true',
            '--operator-confirmed', 'yes',
            '--operator-confirmed-at-utc', boundaryConfirmation
        ], PACKAGE_JSON));

        assert.ok(result && result.action === 'set');
        assert.equal(result.status, 'CHANGED');
        const parsedConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        assert.equal(parsedConfig.task_reset.enabled, true);
    } finally {
        dateNow.mock.restore();
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('workflow set rejects operator confirmation timestamp just beyond freshness cutoff', () => {
    const bundleRoot = createBundleRoot();
    const configPath = path.join(bundleRoot, 'live', 'config', 'workflow-config.json');
    const originalConfig = fs.readFileSync(configPath, 'utf8');
    const nowMs = Date.parse('2026-01-01T00:00:00.000Z');
    const dateNow = mock.method(Date, 'now', () => nowMs);
    const staleByOneMs = new Date(nowMs - OPERATOR_CONFIRMATION_MAX_AGE_MS - 1).toISOString();

    try {
        assert.throws(
            () => handleWorkflow([
                'set',
                '--bundle-root', bundleRoot,
                '--task-reset-enabled', 'true',
                '--operator-confirmed', 'yes',
                '--operator-confirmed-at-utc', staleByOneMs
            ], PACKAGE_JSON),
            /workflow set operator confirmation is stale/
        );
        assert.equal(fs.readFileSync(configPath, 'utf8'), originalConfig);
    } finally {
        dateNow.mock.restore();
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('workflow set rejects future-skewed operator confirmation timestamps', () => {
    const bundleRoot = createBundleRoot();
    const configPath = path.join(bundleRoot, 'live', 'config', 'workflow-config.json');
    const originalConfig = fs.readFileSync(configPath, 'utf8');
    const futureConfirmation = new Date(Date.now() + 2 * 60 * 1000).toISOString();

    try {
        assert.throws(
            () => handleWorkflow([
                'set',
                '--bundle-root', bundleRoot,
                '--task-reset-enabled', 'true',
                '--operator-confirmed', 'yes',
                '--operator-confirmed-at-utc', futureConfirmation
            ], PACKAGE_JSON),
            /workflow set operator confirmation timestamp is in the future/
        );
        assert.equal(fs.readFileSync(configPath, 'utf8'), originalConfig);
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('workflow help describes project-memory update as the default policy', () => {
    const helpText = stripAnsi(buildGuardedCommandHelpText('workflow'));

    assert.ok(helpText.includes('Project memory maintenance defaults to update mode'));
    assert.ok(helpText.includes('workflow set --compile-gate-command "<compile/build/type-check command>"'));
    assert.ok(helpText.includes('compile_gate.command is the executable compile-gate source'));
    assert.ok(helpText.includes('unconfigured workspaces fail closed instead of falling back to 40-commands.md'));
    assert.ok(helpText.includes('workflow set --review-cycle-enabled true --review-cycle-max-total-non-test-reviews 30'));
    assert.ok(helpText.includes('workflow set --full-suite on --operator-confirmed yes --operator-confirmed-at-utc'));
    assert.ok(helpText.includes('workflow set --full-suite-timeout-blocker true --full-suite-timeout-retry-count 1'));
    assert.ok(helpText.includes('workflow set --full-suite-placement before_test_review'));
    assert.ok(helpText.includes('--full-suite-timeout-blocker true|false'));
    assert.ok(helpText.includes('--scope-budget on|off|--scope-budget-enabled true|false'));
    assert.ok(helpText.includes('--review-cycle on|off|--review-cycle-enabled true|false'));
    assert.ok(helpText.includes('--review-cycle-auto-split on|off|--review-cycle-auto-split-enabled true|false'));
    assert.ok(helpText.includes('workflow set --no-delegate true|false'));
    assert.ok(helpText.includes('--project-memory on|off|--project-memory-enabled true|false'));
    assert.ok(helpText.includes('workflow set --project-memory on --project-memory-mode update'));
    assert.ok(helpText.includes('workflow set --task-reset on --operator-confirmed yes --operator-confirmed-at-utc'));
    assert.ok(helpText.includes('--task-reset on|off|--task-reset-enabled true|false'));
    assert.ok(helpText.includes('--auto-backup on|off|--auto-backup-enabled true|false'));
    assert.ok(helpText.includes('--optional-checks on|off|--optional-checks-enabled true|false'));
    assert.ok(helpText.includes('--optional-checks-review-failure-cadence-interval N'));
    assert.ok(helpText.includes('Short aliases map exactly to existing boolean settings'));
    assert.ok(helpText.includes('workflow set --optional-checks on --operator-confirmed yes --operator-confirmed-at-utc'));
    assert.ok(helpText.includes('workflow set --optional-checks-review-failure-cadence-interval 3'));
    assert.ok(helpText.includes('workflow set --optional-skill-selection-mode mandatory'));
    assert.ok(helpText.includes('workflow set --garda-self-guard on'));
    assert.ok(helpText.includes('workflow set changes require --operator-confirmed yes and --operator-confirmed-at-utc'));
    assert.ok(helpText.includes('Task reset mutations are disabled by default'));
    assert.ok(helpText.includes('Optional quality checks are advisory, default-enabled'));
    assert.ok(helpText.includes('Full-suite timeout blocker controls whether repeated timeout evidence blocks task progress'));
    assert.ok(!helpText.includes('Project memory maintenance is disabled by default'));
});

test('workflow validate and explain include workflow guard diagnostics', () => {
    const bundleRoot = createBundleRoot();

    try {
        const validateOutput = captureConsole(() => handleWorkflow([
            'validate',
            '--bundle-root', bundleRoot
        ], PACKAGE_JSON)).output;
        assert.ok(validateOutput.includes('Action: validate'));
        assert.ok(validateOutput.includes('Status: PASS'));
        assert.ok(validateOutput.includes('Project memory maintenance: update'));
        assert.ok(validateOutput.includes('Task reset: disabled'));
        assert.ok(validateOutput.includes(`Optional quality checks: enabled baseline=${OPTIONAL_QUALITY_CHECKS_BASELINE_VERSION} rules=${DEFAULT_OPTIONAL_QUALITY_CHECK_RULES.length} enabled_rules=${DEFAULT_OPTIONAL_QUALITY_CHECK_RULES.length} cadence_interval=${DEFAULT_OPTIONAL_QUALITY_CHECKS_REVIEW_FAILURE_CADENCE_INTERVAL}`));

        const explainOutput = captureConsole(() => handleWorkflow([
            'explain',
            '--bundle-root', bundleRoot
        ], PACKAGE_JSON)).output;
        assert.ok(explainOutput.includes('Topic: workflow-guards'));
        assert.ok(explainOutput.includes('before compile/review loops'));
        assert.ok(explainOutput.includes('Review cycle guard: stops runaway non-test review cycles'));
        assert.ok(explainOutput.includes('40-commands.md is human guidance only'));
        assert.ok(explainOutput.includes('15 failed non-test reviews and 30 total non-test reviews'));
        assert.ok(explainOutput.includes('BLOCK_FOR_OPERATOR_DECISION'));
        assert.ok(explainOutput.includes('auto_split_enabled is true'));
        assert.ok(explainOutput.includes('WARN_ONLY'));
        assert.ok(explainOutput.includes('explicit block_* thresholds produce BLOCK in every action mode'));
        assert.ok(explainOutput.includes('Task reset: confirmed reset mutations are disabled by default'));
        assert.ok(explainOutput.includes('Optional quality checks: advisory self-check rules are default-enabled'));
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('workflow defaults to show when the subcommand is omitted', () => {
    const bundleRoot = createBundleRoot({ enabled: true });

    try {
        const { result, output } = captureConsole(() => handleWorkflow(['--bundle-root', bundleRoot], PACKAGE_JSON));
        assert.ok(result && result.action === 'show');
        assert.ok(output.includes('Action: show'));
        assert.ok(output.includes('Mandatory full-suite: true'));
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('workflow show --json returns valid JSON with compact full-suite line', () => {
    const bundleRoot = createBundleRoot({ enabled: true });

    try {
        const { output } = captureConsole(() => handleWorkflow(['show', '--bundle-root', bundleRoot, '--json'], PACKAGE_JSON));
        const parsed = JSON.parse(output);
        assert.equal(parsed.action, 'show');
        assert.equal(parsed.scope, 'repo-local');
        assert.equal(parsed.compile_gate.command, UNCONFIGURED_COMPILE_GATE_COMMAND);
        assert.equal(parsed.compile_gate_summary_line, 'Compile gate command: unconfigured (fail-closed)');
        assert.equal(parsed.full_suite_validation.enabled, true);
        assert.equal(parsed.full_suite_validation.placement, 'before_test_review');
        assert.equal(parsed.full_suite_validation.timeout_blocker, true);
        assert.equal(parsed.full_suite_validation.timeout_retry_count, 1);
        assert.equal(parsed.review_execution_policy.mode, 'code_first_optional');
        assert.equal(parsed.review_cycle_guard.max_failed_non_test_reviews, 10);
        assert.equal(parsed.review_cycle_guard.max_total_non_test_reviews, 30);
        assert.equal(parsed.project_memory_maintenance.enabled, true);
        assert.equal(parsed.project_memory_maintenance.mode, 'update');
        assert.equal(parsed.task_reset.enabled, false);
        assert.equal(parsed.optional_quality_checks.enabled, true);
        assert.equal(parsed.optional_quality_checks.baseline_version, OPTIONAL_QUALITY_CHECKS_BASELINE_VERSION);
        assert.equal(
            parsed.optional_quality_checks.review_failure_cadence_interval,
            DEFAULT_OPTIONAL_QUALITY_CHECKS_REVIEW_FAILURE_CADENCE_INTERVAL
        );
        assert.equal(parsed.optional_quality_checks.rules.length, DEFAULT_OPTIONAL_QUALITY_CHECK_RULES.length);
        assert.equal(parsed.optional_quality_checks.rules[0].id, 'code_simplification');
        assert.ok(parsed.optional_quality_checks.rules.some((rule: { id: string }) => rule.id === 'test_verification_scope'));
        assert.ok(!parsed.optional_quality_checks.rules.some((rule: { id: string }) => rule.id === 'artifact_evidence_binding'));
        assert.equal(parsed.optional_skill_selection_policy.mode, 'optional');
        assert.equal(parsed.optional_skill_selection_policy.effective_mode, 'optional');
        assert.equal(parsed.optional_skill_selection_policy.status, 'missing');
        assert.equal(parsed.visible_summary_line, 'Mandatory full-suite: true placement=before_test_review mode=standard');
        assert.equal(parsed.review_execution_policy_summary_line, 'Review execution policy: code_first_optional');
        assert.equal(parsed.review_cycle_guard_summary_line, 'Review cycle guard: BLOCK_FOR_OPERATOR_DECISION max_failed_non_test_reviews=10 max_total_non_test_reviews=30 excluded=test auto_split_enabled=true');
        assert.equal(parsed.project_memory_maintenance_summary_line, 'Project memory maintenance: update read_strategy=index_first max_compact_summary_chars=12000 require_user_approval_for_writes=true');
        assert.equal(parsed.task_reset_summary_line, 'Task reset: disabled');
        assert.equal(parsed.optional_quality_checks_summary_line, `Optional quality checks: enabled baseline=${OPTIONAL_QUALITY_CHECKS_BASELINE_VERSION} rules=${DEFAULT_OPTIONAL_QUALITY_CHECK_RULES.length} enabled_rules=${DEFAULT_OPTIONAL_QUALITY_CHECK_RULES.length} cadence_interval=${DEFAULT_OPTIONAL_QUALITY_CHECKS_REVIEW_FAILURE_CADENCE_INTERVAL}`);
        assert.equal(parsed.optional_skill_selection_policy_summary_line, 'Specialist-skill selection: optional status=missing');
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('workflow set --json returns valid JSON for machine-readable automation', () => {
    const bundleRoot = createBundleRoot();
    const configPath = path.join(bundleRoot, 'live', 'config', 'workflow-config.json');

    try {
        const { output } = captureConsole(() => handleWorkflow([
            'set',
            '--bundle-root', bundleRoot,
            '--full-suite-enabled', 'true',
            '--review-execution-policy', 'strict_sequential',
            ...buildOperatorConfirmationArgs(),
            '--json'
        ], PACKAGE_JSON));
        const parsed = JSON.parse(output);
        assert.equal(parsed.action, 'set');
        assert.equal(parsed.status, 'CHANGED');
        assert.equal(parsed.compile_gate.command, UNCONFIGURED_COMPILE_GATE_COMMAND);
        assert.equal(parsed.full_suite_validation.enabled, true);
        assert.equal(parsed.full_suite_validation.placement, 'before_test_review');
        assert.equal(parsed.review_execution_policy.mode, 'strict_sequential');
        assert.equal(parsed.task_reset.enabled, false);
        assert.equal(parsed.visible_summary_line, 'Mandatory full-suite: true placement=before_test_review mode=standard');
        assert.equal(parsed.review_execution_policy_summary_line, 'Review execution policy: strict_sequential');
        assert.ok(parsed.changed_fields.includes('full_suite_validation.enabled'));
        assert.ok(parsed.changed_fields.includes('review_execution_policy.mode'));

        const parsedConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        assert.equal(parsedConfig.full_suite_validation.enabled, true);
        assert.equal(parsedConfig.review_execution_policy.mode, 'strict_sequential');
        assert.equal(parsedConfig.task_reset.enabled, false);
        assert.equal(parsedConfig.optional_quality_checks.enabled, true);
        assert.equal(parsedConfig.optional_quality_checks.baseline_version, OPTIONAL_QUALITY_CHECKS_BASELINE_VERSION);
        assert.equal(
            parsedConfig.optional_quality_checks.review_failure_cadence_interval,
            DEFAULT_OPTIONAL_QUALITY_CHECKS_REVIEW_FAILURE_CADENCE_INTERVAL
        );
        assert.equal(parsedConfig.optional_quality_checks.rules.length, DEFAULT_OPTIONAL_QUALITY_CHECK_RULES.length);
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('workflow set updates repo-local full-suite config deterministically', () => {
    const bundleRoot = createBundleRoot();
    const configPath = path.join(bundleRoot, 'live', 'config', 'workflow-config.json');

    try {
        const { result, output } = captureConsole(() => handleWorkflow([
            'set',
            '--bundle-root', bundleRoot,
            '--full-suite-enabled', 'true',
            '--full-suite-command', 'npm run test:full',
            '--full-suite-timeout-ms', '123456',
            '--full-suite-timeout-blocker', 'false',
            '--full-suite-timeout-retry-count', '0',
            '--full-suite-out-of-scope-failure-policy', 'audit_and_warn',
            '--full-suite-placement', 'before completion',
            '--review-execution-policy', 'parallel_all',
            ...buildOperatorConfirmationArgs()
        ], PACKAGE_JSON));
        assert.ok(result && result.action === 'set');
        assert.equal(result.status, 'CHANGED');
        assert.ok(output.includes('Status: CHANGED'));
        assert.ok(output.includes('Mandatory full-suite: true'));
        assert.ok(output.includes('Review execution policy: parallel_all'));

        const parsedConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        assert.equal(parsedConfig.full_suite_validation.enabled, true);
        assert.equal(parsedConfig.full_suite_validation.command, 'npm run test:full');
        assert.equal(parsedConfig.full_suite_validation.timeout_ms, 123456);
        assert.equal(parsedConfig.full_suite_validation.timeout_blocker, false);
        assert.equal(parsedConfig.full_suite_validation.timeout_retry_count, 0);
        assert.equal(parsedConfig.full_suite_validation.out_of_scope_failure_policy, 'AUDIT_AND_WARN');
        assert.equal(parsedConfig.full_suite_validation.placement, 'before_completion');
        assert.ok(result.changed_fields.includes('full_suite_validation.timeout_blocker'));
        assert.ok(result.changed_fields.includes('full_suite_validation.timeout_retry_count'));
        assert.equal(parsedConfig.review_execution_policy.mode, 'parallel_all');
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('workflow set reports NO_CHANGE when the requested value already matches', () => {
    const bundleRoot = createBundleRoot();

    try {
        const { result, output } = captureConsole(() => handleWorkflow([
            'set',
            '--bundle-root', bundleRoot,
            '--full-suite-enabled', 'false'
        ], PACKAGE_JSON));
        assert.ok(result && result.action === 'set');
        assert.equal(result.status, 'NO_CHANGE');
        assert.ok(output.includes('Status: NO_CHANGE'));
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('workflow show keeps legacy compatibility mode when review_execution_policy is omitted', () => {
    const bundleRoot = createBundleRoot();
    const configPath = path.join(bundleRoot, 'live', 'config', 'workflow-config.json');
    fs.writeFileSync(
        configPath,
        JSON.stringify({
            full_suite_validation: {
                enabled: false,
                command: 'npm test',
                timeout_ms: 600000,
                green_summary_max_lines: 5,
                red_failure_chunk_lines: 50,
                out_of_scope_failure_policy: 'AUDIT_AND_BLOCK'
            }
        }, null, 2),
        'utf8'
    );

    try {
        const { result, output } = captureConsole(() => handleWorkflow(['show', '--bundle-root', bundleRoot], PACKAGE_JSON));
        assert.ok(result && result.action === 'show');
        assert.equal(result.review_execution_policy.mode, 'legacy_test_downstream');
        assert.equal(result.review_execution_policy.configured, false);
        assert.ok(output.includes('Review execution policy: legacy_test_downstream (implicit compatibility mode)'));
        assert.ok(output.includes('ReviewExecutionPolicyConfigured: false'));
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('workflow show uses strict_sequential as the implicit mode for a fresh bundle path without workflow-config', () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-workflow-fresh-show-'));
    const bundleRoot = path.join(workspaceRoot, 'custom-bundle');
    fs.mkdirSync(bundleRoot, { recursive: true });

    try {
        const { result } = captureConsole(() => handleWorkflow(['show', '--bundle-root', bundleRoot, '--json'], PACKAGE_JSON));
        assert.ok(result && result.action === 'show');
        assert.equal(result.config_exists, false);
        assert.equal(result.review_execution_policy.mode, 'strict_sequential');
        assert.equal(result.review_execution_policy.configured, false);
    } finally {
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
});

test('workflow set preserves legacy compatibility omission when changing only full-suite fields', () => {
    const bundleRoot = createBundleRoot();
    const configPath = path.join(bundleRoot, 'live', 'config', 'workflow-config.json');
    fs.writeFileSync(
        configPath,
        JSON.stringify({
            full_suite_validation: {
                enabled: false,
                command: 'npm test',
                timeout_ms: 600000,
                green_summary_max_lines: 5,
                red_failure_chunk_lines: 50,
                out_of_scope_failure_policy: 'AUDIT_AND_BLOCK'
            }
        }, null, 2),
        'utf8'
    );

    try {
        const { result } = captureConsole(() => handleWorkflow([
            'set',
            '--bundle-root', bundleRoot,
            '--full-suite-enabled', 'true',
            ...buildOperatorConfirmationArgs()
        ], PACKAGE_JSON));

        assert.ok(result && result.action === 'set');
        assert.equal(result.review_execution_policy.mode, 'legacy_test_downstream');
        assert.equal(result.review_execution_policy.configured, false);

        const parsedConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        assert.equal(parsedConfig.full_suite_validation.enabled, true);
        assert.equal(Object.prototype.hasOwnProperty.call(parsedConfig, 'review_execution_policy'), false);
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('workflow set preserves legacy compatibility omission when config is missing in an existing materialized bundle', () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-workflow-target-'));
    const explicitBundleRoot = path.join(workspaceRoot, 'custom-bundle');
    fs.mkdirSync(path.join(explicitBundleRoot, 'live', 'config'), { recursive: true });
    fs.writeFileSync(
        path.join(explicitBundleRoot, 'live', 'version.json'),
        JSON.stringify({ version: '1.0.0' }, null, 2),
        'utf8'
    );

    try {
        const { result } = captureConsole(() => handleWorkflow([
            'set',
            '--bundle-root', explicitBundleRoot,
            '--full-suite-enabled', 'true',
            ...buildOperatorConfirmationArgs()
        ], PACKAGE_JSON));

        assert.ok(result && result.action === 'set');
        assert.equal(result.review_execution_policy.mode, 'legacy_test_downstream');
        assert.equal(result.review_execution_policy.configured, false);
        const explicitConfigPath = path.join(explicitBundleRoot, 'live', 'config', 'workflow-config.json');
        const parsed = JSON.parse(fs.readFileSync(explicitConfigPath, 'utf8'));
        assert.equal(parsed.full_suite_validation.enabled, true);
        assert.equal(Object.prototype.hasOwnProperty.call(parsed, 'review_execution_policy'), false);
    } finally {
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
});

test('workflow set with explicit --bundle-root materializes the current review_execution_policy default for a fresh bundle path', () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-workflow-target-'));
    const defaultBundleRoot = path.join(workspaceRoot, 'garda-agent-orchestrator');
    const explicitBundleRoot = path.join(workspaceRoot, 'custom-bundle');
    fs.mkdirSync(path.join(defaultBundleRoot, 'live', 'config'), { recursive: true });
    fs.mkdirSync(explicitBundleRoot, { recursive: true });
    fs.writeFileSync(
        path.join(defaultBundleRoot, 'live', 'config', 'workflow-config.json'),
        JSON.stringify({
            full_suite_validation: {
                enabled: false,
                command: 'npm run wrong-default',
                timeout_ms: 600000,
                green_summary_max_lines: 5,
                red_failure_chunk_lines: 50,
                out_of_scope_failure_policy: 'AUDIT_AND_BLOCK'
            }
        }, null, 2),
        'utf8'
    );

    try {
        const { result } = captureConsole(() => handleWorkflow([
            'set',
            '--bundle-root', explicitBundleRoot,
            '--full-suite-enabled', 'true',
            ...buildOperatorConfirmationArgs()
        ], PACKAGE_JSON));

        assert.ok(result && result.action === 'set');
        assert.equal(result.review_execution_policy.mode, 'strict_sequential');
        assert.equal(result.review_execution_policy.configured, true);
        const explicitConfigPath = path.join(explicitBundleRoot, 'live', 'config', 'workflow-config.json');
        assert.equal(fs.existsSync(explicitConfigPath), true);
        const parsed = JSON.parse(fs.readFileSync(explicitConfigPath, 'utf8'));
        assert.equal(parsed.full_suite_validation.enabled, true);
        assert.notEqual(parsed.full_suite_validation.command, 'npm run wrong-default');
        assert.deepEqual(parsed.review_execution_policy, {
            mode: 'strict_sequential'
        });
    } finally {
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
});

test('workflow set rejects missing mutation flags', () => {
    const bundleRoot = createBundleRoot();

    try {
        assert.throws(
            () => handleWorkflow(['set', '--bundle-root', bundleRoot], PACKAGE_JSON),
            /Workflow setting flags are required/
        );
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('workflow set rejects invalid review execution policy modes', () => {
    const bundleRoot = createBundleRoot();

    try {
        assert.throws(
            () => handleWorkflow([
                'set',
                '--bundle-root', bundleRoot,
                '--review-execution-policy', 'totally_serialized'
            ], PACKAGE_JSON),
            /--review-execution-policy must be one of/
        );
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('workflow set rejects invalid project memory maintenance modes', () => {
    const bundleRoot = createBundleRoot();

    try {
        assert.throws(
            () => handleWorkflow([
                'set',
                '--bundle-root', bundleRoot,
                '--project-memory-mode', 'audit'
            ], PACKAGE_JSON),
            /--project-memory-mode must be one of/
        );
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('workflow set rejects invalid optional skill selection policy modes', () => {
    const bundleRoot = createBundleRoot();

    try {
        assert.throws(
            () => handleWorkflow([
                'set',
                '--bundle-root', bundleRoot,
                '--optional-skill-selection-mode', 'always'
            ], PACKAGE_JSON),
            /--optional-skill-selection-mode must be one of/
        );
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('workflow show rejects case-drifted review_execution_policy keys', () => {
    const bundleRoot = createBundleRoot({}, {
        review_execution_policy: undefined,
        Review_Execution_Policy: {
            mode: 'parallel_all'
        }
    });

    try {
        assert.throws(
            () => handleWorkflow(['show', '--bundle-root', bundleRoot], PACKAGE_JSON),
            /must use the exact key 'review_execution_policy'/
        );
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('workflow show rejects likely typo top-level workflow-config keys', () => {
    const bundleRoot = createBundleRoot({}, {
        review_execution_policy: undefined,
        review_execution_polciy: {
            mode: 'parallel_all'
        }
    });

    try {
        assert.throws(
            () => handleWorkflow(['show', '--bundle-root', bundleRoot], PACKAGE_JSON),
            /did you mean 'review_execution_policy'/
        );
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});
