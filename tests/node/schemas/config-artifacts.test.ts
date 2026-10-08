import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { appendTaskEvent } from '../../../src/gate-runtime/task-events';
import { writeTimelineSummaryIndex, type TimelineSummaryIndex } from '../../../src/gate-runtime/timeline-summary';
import { buildRuntimeRetentionPreview } from '../../../src/lifecycle/runtime-retention-policy';
import {
    getManagedConfigValidators,
    validateManagedConfigByName,
    validateOptionalSkillSelectionPolicyConfig,
    validateOutputFiltersConfig,
    validatePathsConfig,
    validateTokenEconomyConfig,
    validateProfilesConfig,
    validateReviewArtifactStorageConfig,
    validateReviewCatalogConfig,
    validateRuntimeRetentionConfig,
    validateWorkflowConfig
} from '../../../src/schemas/config-artifacts';
import {
    buildDefaultWorkflowConfig,
    DEFAULT_OPTIONAL_QUALITY_CHECKS_REVIEW_FAILURE_CADENCE_INTERVAL,
    DEFAULT_OPTIONAL_QUALITY_CHECK_RULES,
    MAX_OPTIONAL_QUALITY_CHECKS_REVIEW_FAILURE_CADENCE_INTERVAL,
    OPTIONAL_QUALITY_CHECKS_BASELINE_VERSION
} from '../../../src/core/workflow-config';
import { DEFAULT_FULL_SUITE_VALIDATION_CONFIG } from '../../../src/core/full-suite-validation-config';

const DEPRECATED_PROJECT_ONLY_OPTIONAL_QUALITY_RULE_IDS = [
    'preflight_review_scope_regressions',
    'trust_artifact_identity',
    'doc_impact_closeout_parity',
    'task_queue_parser_state',
    'review_cycle_scope_freshness',
    'zero_diff_noop_preemption'
];

test('task test-selection permission accepts explicit booleans and keeps omitted legacy config valid', () => {
    const defaults = buildDefaultWorkflowConfig();
    for (const requireOperatorConfirmation of [true, false]) {
        const result = validateWorkflowConfig({
            ...defaults,
            task_test_selection: { require_operator_confirmation: requireOperatorConfirmation }
        });
        assert.deepEqual(result.task_test_selection, { require_operator_confirmation: requireOperatorConfirmation });
    }
    const legacy: Record<string, unknown> = { ...defaults };
    delete legacy.task_test_selection;
    assert.equal(Object.hasOwn(validateWorkflowConfig(legacy), 'task_test_selection'), false);
    assert.deepEqual(validateWorkflowConfig({ ...defaults, task_test_selection: {} }).task_test_selection,
        { require_operator_confirmation: false });
});

test('task test-selection permission rejects malformed values, misspelled keys and piggyback options', () => {
    const defaults = buildDefaultWorkflowConfig();
    for (const value of [null, undefined, 'false', 'true', 0, 1, '', [], {}]) {
        assert.throws(() => validateWorkflowConfig({
            ...defaults,
            task_test_selection: { require_operator_confirmation: value }
        }), /workflow-config\.task_test_selection\.require_operator_confirmation must be a boolean/);
    }
    for (const section of [null, [], false, 'false']) {
        assert.throws(() => validateWorkflowConfig({ ...defaults, task_test_selection: section }),
            /workflow-config\.task_test_selection must be a JSON object/);
    }
    for (const section of [
        { Require_Operator_Confirmation: false },
        { require_operator_confirmaton: false },
        { require_operator_confirmation: false, enabled: false },
        { require_operator_confirmation: false, command: 'node -e ""' }
    ]) {
        assert.throws(() => validateWorkflowConfig({ ...defaults, task_test_selection: section }),
            /workflow-config\.task_test_selection/);
    }
    const legacy: Record<string, unknown> = { ...defaults };
    delete legacy.task_test_selection;
    assert.throws(() => validateWorkflowConfig({ ...legacy, Task_Test_Selection: {} }), /task_test_selection/);
});

function expectedOptionalQualityRule(
    rule: typeof DEFAULT_OPTIONAL_QUALITY_CHECK_RULES[number]
): Record<string, unknown> {
    const expected: Record<string, unknown> = {
        id: rule.id,
        title: rule.title,
        prompt: rule.prompt,
        enabled: rule.enabled
    };
    if (rule.excluded_scope_categories) {
        expected.excluded_scope_categories = rule.excluded_scope_categories;
    }
    if (rule.included_scope_categories) {
        expected.included_scope_categories = rule.included_scope_categories;
    }
    if (rule.included_changed_file_regexes) {
        expected.included_changed_file_regexes = rule.included_changed_file_regexes;
    }
    return expected;
}

function readTemplateConfig(configName: string): Record<string, unknown> {
    return JSON.parse(
        fs.readFileSync(path.join(process.cwd(), 'template', 'config', `${configName}.json`), 'utf8')
    );
}

function readMaterializedTemplateConfigIfPresent(configName: string): Record<string, unknown> | null {
    const materializedPath = path.join(
        process.cwd(),
        'garda-agent-orchestrator',
        'template',
        'config',
        `${configName}.json`
    );
    if (!fs.existsSync(materializedPath)) {
        return null;
    }
    return JSON.parse(fs.readFileSync(materializedPath, 'utf8')) as Record<string, unknown>;
}

function makeRetentionPreviewWorkspace(): {
    cleanup: () => void;
    targetRoot: string;
    bundleRoot: string;
    eventsRoot: string;
} {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-retention-preview-'));
    const targetRoot = tmpDir;
    const bundleRoot = path.join(targetRoot, 'garda-agent-orchestrator');
    const eventsRoot = path.join(bundleRoot, 'runtime', 'task-events');
    fs.mkdirSync(eventsRoot, { recursive: true });
    fs.mkdirSync(path.join(bundleRoot, 'live', 'config'), { recursive: true });
    return {
        cleanup: () => fs.rmSync(tmpDir, { recursive: true, force: true }),
        targetRoot,
        bundleRoot,
        eventsRoot
    };
}

function writeTaskQueue(
    targetRoot: string,
    tasks: Array<{ id: string; status: string; title?: string }>
): void {
    const lines = [
        '# TASK.md',
        '',
        '## Active Queue',
        '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
        '|---|---|---|---|---|---|---|---|---|'
    ];

    for (const task of tasks) {
        lines.push(
            `| ${task.id} | ${task.status} | P2 | runtime/retention | ${task.title || task.id} | gpt-5.4 | 2026-05-20 | balanced | note |`
        );
    }

    fs.writeFileSync(path.join(targetRoot, 'TASK.md'), `${lines.join('\n')}\n`, 'utf8');
}

function appendStatusEvent(bundleRoot: string, taskId: string, nextStatus: string): void {
    appendTaskEvent(bundleRoot, taskId, 'STATUS_CHANGED', 'INFO', `Status changed to ${nextStatus}.`, {
        new_status: nextStatus
    });
}

function writeTimelineSummary(
    eventsRoot: string,
    entries: TimelineSummaryIndex['entries']
): void {
    writeTimelineSummaryIndex(eventsRoot, {
        version: 2,
        updated_at_utc: new Date().toISOString(),
        entries
    });
}

function setFileAgeDays(filePath: string, ageDays: number): void {
    const timestamp = new Date(Date.now() - ageDays * 24 * 60 * 60 * 1000);
    fs.utimesSync(filePath, timestamp, timestamp);
}

test('tracked template managed configs validate successfully', () => {
    for (const configName of Object.keys(getManagedConfigValidators())) {
        const validated = validateManagedConfigByName(configName, readTemplateConfig(configName));
        assert.ok(validated);
    }
});

test('managed review catalog validator compiles the built-in compatibility catalog', () => {
    const catalog = readTemplateConfig('review-catalog');
    const result = validateReviewCatalogConfig(catalog);
    const reviewTypes = result.review_types as Array<Record<string, unknown>>;

    assert.deepEqual(catalog, { version: 1, custom_review_types: [] });
    assert.equal(reviewTypes.length, 9);
    assert.deepEqual(reviewTypes.map((definition) => definition.id), [
        'code',
        'db',
        'security',
        'refactor',
        'api',
        'test',
        'performance',
        'infra',
        'dependency'
    ]);
    assert.ok(reviewTypes.every((definition) => definition.built_in === true));
    assert.ok(reviewTypes.every((definition) => definition.enabled_by_default === true));
    assert.match(String(result.catalog_sha256), /^[a-f0-9]{64}$/u);
});

test('tracked workflow template ships current optional quality baseline', () => {
    const workflowConfig = readTemplateConfig('workflow-config');
    const optionalQualityChecks = workflowConfig.optional_quality_checks as Record<string, unknown>;
    assert.equal(optionalQualityChecks.baseline_version, OPTIONAL_QUALITY_CHECKS_BASELINE_VERSION);
    assert.deepEqual(
        optionalQualityChecks.rules,
        DEFAULT_OPTIONAL_QUALITY_CHECK_RULES.map(expectedOptionalQualityRule)
    );
});

test('tracked workflow timeout default stays in runtime and template parity', () => {
    const workflowConfig = readTemplateConfig('workflow-config');
    const fullSuiteValidation = workflowConfig.full_suite_validation as Record<string, unknown>;
    const defaultWorkflowConfig = buildDefaultWorkflowConfig();

    assert.equal(fullSuiteValidation.timeout_ms, 900_000);
    assert.equal(
        defaultWorkflowConfig.full_suite_validation.timeout_ms,
        fullSuiteValidation.timeout_ms
    );
    assert.equal(
        DEFAULT_FULL_SUITE_VALIDATION_CONFIG.timeout_ms,
        fullSuiteValidation.timeout_ms
    );
});

test('materialized workflow template keeps tracked defaults parity when present', () => {
    const workflowConfig = readMaterializedTemplateConfigIfPresent('workflow-config');
    if (!workflowConfig) {
        return;
    }
    const fullSuiteValidation = workflowConfig.full_suite_validation as Record<string, unknown>;
    const optionalQualityChecks = workflowConfig.optional_quality_checks as Record<string, unknown>;
    assert.equal(fullSuiteValidation.timeout_ms, DEFAULT_FULL_SUITE_VALIDATION_CONFIG.timeout_ms);
    assert.equal(optionalQualityChecks.baseline_version, OPTIONAL_QUALITY_CHECKS_BASELINE_VERSION);
    assert.deepEqual(
        optionalQualityChecks.rules,
        DEFAULT_OPTIONAL_QUALITY_CHECK_RULES.map(expectedOptionalQualityRule)
    );
});

test('tracked workflow template excludes deprecated project-only optional quality baseline ids', () => {
    const workflowConfig = readTemplateConfig('workflow-config');
    const optionalQualityChecks = workflowConfig.optional_quality_checks as Record<string, unknown>;
    const templateRuleIds = new Set((optionalQualityChecks.rules as Array<{ id: string }>).map((rule) => rule.id));
    const defaultRuleIds = new Set(DEFAULT_OPTIONAL_QUALITY_CHECK_RULES.map((rule) => rule.id));

    for (const deprecatedRuleId of DEPRECATED_PROJECT_ONLY_OPTIONAL_QUALITY_RULE_IDS) {
        assert.equal(defaultRuleIds.has(deprecatedRuleId), false);
        assert.equal(templateRuleIds.has(deprecatedRuleId), false);
    }
});

test('validateTokenEconomyConfig canonicalizes integer arrays and boolean-like values', () => {
    const normalized = validateTokenEconomyConfig({
        enabled: 'yes',
        enabled_depths: ['3', 1, '2', 2],
        strip_examples: 'true',
        strip_code_blocks: 1,
        scoped_diffs: 'no',
        compact_reviewer_output: false,
        fail_tail_lines: '25'
    });

    assert.equal(normalized.enabled, true);
    assert.deepEqual(normalized.enabled_depths, [1, 2, 3]);
    assert.equal(normalized.scoped_diffs, false);
    assert.equal(normalized.fail_tail_lines, 25);
});

test('validateWorkflowConfig canonicalizes scope budget guard values before guard normalization', () => {
    const normalized = validateWorkflowConfig({
        full_suite_validation: {
            enabled: false,
            command: 'npm test',
            timeout_ms: 600000,
            green_summary_max_lines: 5,
            red_failure_chunk_lines: 50,
            out_of_scope_failure_policy: 'AUDIT_AND_BLOCK',
            placement: 'before completion'
        },
        review_execution_policy: {
            mode: 'code_first_optional'
        },
        scope_budget_guard: {
            enabled: 'false',
            profiles: ['Strict', 'balanced'],
            action: 'warn only',
            max_files: '7',
            max_changed_lines: '300',
            max_required_reviews: '3',
            max_review_tokens: '5000',
            warn_files: '7',
            block_files: '50',
            warn_changed_lines: '300',
            block_changed_lines: '5000',
            warn_required_reviews: '3',
            block_required_reviews: '8',
            warn_review_tokens: '5000',
            block_review_tokens: '100000'
        },
        review_cycle_guard: {
            enabled: 'true',
            action: 'warn only',
            max_failed_non_test_reviews: '4',
            max_total_non_test_reviews: '9',
            excluded_review_types: ['Test', 'test'],
            auto_split_enabled: 'true'
        },
        project_memory_maintenance: {
            enabled: 'true',
            mode: 'UPDATE',
            run_before_final_closeout: 'false',
            require_user_approval_for_writes: 'yes',
            max_compact_summary_chars: '9000',
            read_strategy: 'INDEX_FIRST',
            impact_artifact_retention_days: '45'
        },
        task_reset: {
            enabled: 'yes'
        }
    });

    const guard = normalized.scope_budget_guard as Record<string, unknown>;
    assert.equal(guard.enabled, false);
    assert.deepEqual(guard.profiles, ['strict', 'balanced']);
    assert.equal(guard.action, 'WARN_ONLY');
    assert.equal(guard.max_files, 7);
    assert.equal(guard.max_changed_lines, 300);
    assert.equal(guard.max_required_reviews, 3);
    assert.equal(guard.max_review_tokens, 5000);
    assert.equal(guard.warn_files, 7);
    assert.equal(guard.block_files, 50);
    assert.equal(guard.warn_changed_lines, 300);
    assert.equal(guard.block_changed_lines, 5000);
    assert.equal(guard.warn_required_reviews, 3);
    assert.equal(guard.block_required_reviews, 8);
    assert.equal(guard.warn_review_tokens, 5000);
    assert.equal(guard.block_review_tokens, 100000);

    const reviewCycleGuard = normalized.review_cycle_guard as Record<string, unknown>;
    assert.equal(reviewCycleGuard.enabled, true);
    assert.equal(reviewCycleGuard.action, 'WARN_ONLY');
    assert.equal(reviewCycleGuard.max_failed_non_test_reviews, 4);
    assert.equal(reviewCycleGuard.max_total_non_test_reviews, 9);
    assert.deepEqual(reviewCycleGuard.excluded_review_types, ['test']);
    assert.equal(reviewCycleGuard.auto_split_enabled, true);

    const projectMemory = normalized.project_memory_maintenance as Record<string, unknown>;
    assert.equal(projectMemory.enabled, true);
    assert.equal(projectMemory.mode, 'update');
    assert.equal(projectMemory.run_before_final_closeout, false);
    assert.equal(projectMemory.require_user_approval_for_writes, true);
    assert.equal(projectMemory.max_compact_summary_chars, 9000);
    assert.equal(projectMemory.read_strategy, 'index_first');
    assert.equal(projectMemory.impact_artifact_retention_days, 45);

    const taskReset = normalized.task_reset as Record<string, unknown>;
    assert.equal(taskReset.enabled, true);

    const fullSuiteValidation = normalized.full_suite_validation as Record<string, unknown>;
    assert.equal(fullSuiteValidation.placement, 'before_completion');
    assert.equal(fullSuiteValidation.timeout_blocker, true);
    assert.equal(fullSuiteValidation.timeout_retry_count, 1);
});

test('validateWorkflowConfig preserves legacy BLOCK_FOR_SPLIT max-only minimum thresholds', () => {
    const config = buildDefaultWorkflowConfig() as unknown as Record<string, unknown>;
    config.scope_budget_guard = {
        enabled: true,
        profiles: ['strict'],
        action: 'BLOCK_FOR_SPLIT',
        max_files: 1,
        max_changed_lines: 1,
        max_required_reviews: 1,
        max_review_tokens: 1
    };

    const normalized = validateWorkflowConfig(config);
    const guard = normalized.scope_budget_guard as Record<string, unknown>;
    assert.equal(guard.action, 'BLOCK_FOR_SPLIT');
    assert.equal(guard.max_files, 1);
    assert.equal(guard.max_changed_lines, 1);
    assert.equal(guard.max_required_reviews, 1);
    assert.equal(guard.max_review_tokens, 1);
    assert.equal(guard.warn_files, 0);
    assert.equal(guard.block_files, 1);
    assert.equal(guard.warn_changed_lines, 0);
    assert.equal(guard.block_changed_lines, 1);
    assert.equal(guard.warn_required_reviews, 0);
    assert.equal(guard.block_required_reviews, 1);
    assert.equal(guard.warn_review_tokens, 0);
    assert.equal(guard.block_review_tokens, 1);
});

test('validateWorkflowConfig rejects scope budget warning thresholds at or above blocking thresholds', () => {
    assert.throws(
        () => validateWorkflowConfig({
            full_suite_validation: {
                enabled: false,
                command: 'npm test',
                timeout_ms: 600000,
                green_summary_max_lines: 5,
                red_failure_chunk_lines: 50,
                out_of_scope_failure_policy: 'AUDIT_AND_BLOCK',
                placement: 'before_completion'
            },
            review_execution_policy: {
                mode: 'code_first_optional'
            },
            scope_budget_guard: {
                enabled: true,
                profiles: ['strict'],
                action: 'WARN_ONLY',
                max_files: 20,
                max_changed_lines: 2000,
                max_required_reviews: 5,
                max_review_tokens: 50000,
                warn_files: 50,
                block_files: 50,
                warn_changed_lines: 2000,
                block_changed_lines: 5000,
                warn_required_reviews: 5,
                block_required_reviews: 8,
                warn_review_tokens: 50000,
                block_review_tokens: 100000
            }
        }),
        /warn_files must be less than workflow-config\.scope_budget_guard\.block_files/u
    );
});

test('validateWorkflowConfig validates custom optional quality checks and duplicate ids', () => {
    const baseConfig = {
        full_suite_validation: {
            enabled: false,
            command: 'npm test',
            timeout_ms: 600000,
            green_summary_max_lines: 5,
            red_failure_chunk_lines: 50,
            out_of_scope_failure_policy: 'AUDIT_AND_BLOCK'
        },
        review_execution_policy: {
            mode: 'code_first_optional'
        }
    };

    const normalized = validateWorkflowConfig({
        ...baseConfig,
        optional_quality_checks: {
            enabled: 'false',
            audit_history: [
                {
                    at: '2026-06-24T00:00:00.000Z',
                    action: 'operator-edited'
                }
            ],
            rules: [
                {
                    id: 'Custom_Rule',
                    title: 'Custom rule',
                    prompt: 'Check custom local quality criteria.',
                    local_note: 'operator-owned'
                }
            ]
        }
    });
    const optionalQualityChecks = normalized.optional_quality_checks as Record<string, unknown>;
    const optionalQualityCheckRules = optionalQualityChecks.rules as Array<Record<string, unknown>>;
    assert.equal(optionalQualityChecks.enabled, false);
    assert.equal(optionalQualityChecks.baseline_version, OPTIONAL_QUALITY_CHECKS_BASELINE_VERSION);
    assert.equal(
        optionalQualityChecks.review_failure_cadence_interval,
        DEFAULT_OPTIONAL_QUALITY_CHECKS_REVIEW_FAILURE_CADENCE_INTERVAL
    );
    assert.deepEqual(optionalQualityCheckRules[0], {
        id: 'custom_rule',
        title: 'Custom rule',
        prompt: 'Check custom local quality criteria.',
        enabled: true,
        local_note: 'operator-owned'
    });
    assert.deepEqual(
        optionalQualityCheckRules.slice(1).map((rule) => rule.id),
        DEFAULT_OPTIONAL_QUALITY_CHECK_RULES.map((rule) => rule.id)
    );
    assert.deepEqual(
        optionalQualityCheckRules.slice(1),
        DEFAULT_OPTIONAL_QUALITY_CHECK_RULES.map(expectedOptionalQualityRule)
    );
    assert.deepEqual(optionalQualityChecks.audit_history, [
        {
            at: '2026-06-24T00:00:00.000Z',
            action: 'operator-edited'
        }
    ]);

    const defaulted = validateWorkflowConfig({
        ...baseConfig,
        optional_quality_checks: {
            enabled: true
        }
    });
    const defaultedOptionalQualityChecks = defaulted.optional_quality_checks as Record<string, unknown>;
    const defaultedRules = defaultedOptionalQualityChecks.rules as Array<Record<string, unknown>>;
    assert.equal(defaultedOptionalQualityChecks.enabled, true);
    assert.equal(defaultedOptionalQualityChecks.baseline_version, OPTIONAL_QUALITY_CHECKS_BASELINE_VERSION);
    assert.equal(
        defaultedOptionalQualityChecks.review_failure_cadence_interval,
        DEFAULT_OPTIONAL_QUALITY_CHECKS_REVIEW_FAILURE_CADENCE_INTERVAL
    );
    assert.deepEqual(
        defaultedRules.map((rule) => rule.id),
        DEFAULT_OPTIONAL_QUALITY_CHECK_RULES.map((rule) => rule.id)
    );
    assert.deepEqual(
        [
            'classifier_intent_edge_cases',
            'config_materialization_parity',
            'control_plane_action_safety',
            'artifact_evidence_binding',
            'gate_routing_self_regression'
        ].filter((id) => defaultedRules.some((rule) => rule.id === id)),
        []
    );

    const customCadence = validateWorkflowConfig({
        ...baseConfig,
        optional_quality_checks: {
            enabled: true,
            review_failure_cadence_interval: 5
        }
    });
    assert.equal(
        (customCadence.optional_quality_checks as Record<string, unknown>).review_failure_cadence_interval,
        5
    );

    const baselineRule = DEFAULT_OPTIONAL_QUALITY_CHECK_RULES[0];
    const preservedBaseline = validateWorkflowConfig({
        ...baseConfig,
        optional_quality_checks: {
            enabled: true,
            rules: [
                {
                    id: baselineRule.id,
                    title: 'Locally edited shipped title',
                    prompt: 'Locally edited shipped prompt.',
                    enabled: false,
                    local_note: 'operator-owned'
                }
            ]
        }
    });
    const preservedBaselineRules =
        (preservedBaseline.optional_quality_checks as { rules: Array<Record<string, unknown>> }).rules;
    assert.deepEqual(
        preservedBaselineRules[0],
        {
            id: baselineRule.id,
            title: 'Locally edited shipped title',
            prompt: 'Locally edited shipped prompt.',
            enabled: false,
            excluded_scope_categories: baselineRule.excluded_scope_categories,
            local_note: 'operator-owned'
        }
    );
    assert.deepEqual(
        preservedBaselineRules.map((rule) => rule.id),
        DEFAULT_OPTIONAL_QUALITY_CHECK_RULES.map((rule) => rule.id)
    );

    assert.throws(
        () => validateWorkflowConfig({
            ...baseConfig,
            optional_quality_checks: {
                enabled: true,
                rules: []
            }
        }),
        /optional_quality_checks\.rules must contain at least one rule/
    );

    assert.throws(
        () => validateWorkflowConfig({
            ...baseConfig,
            optional_quality_checks: {
                enabled: true,
                rules: [
                    {
                        id: 'duplicate',
                        title: 'First',
                        prompt: 'First prompt.'
                    },
                    {
                        id: 'Duplicate',
                        title: 'Second',
                        prompt: 'Second prompt.'
                    }
                ]
            }
        }),
        /optional_quality_checks\.rules has duplicate id 'duplicate'/
    );

    assert.throws(
        () => validateWorkflowConfig({
            ...baseConfig,
            optional_quality_checks: {
                enabled: true,
                review_failure_cadence_interval: '5'
            }
        }),
        /workflow-config\.optional_quality_checks\.review_failure_cadence_interval must be an integer/u
    );

    assert.throws(
        () => validateWorkflowConfig({
            ...baseConfig,
            optional_quality_checks: {
                enabled: true,
                review_failure_cadence_interval: 0
            }
        }),
        /workflow-config\.optional_quality_checks\.review_failure_cadence_interval must be >= 1/u
    );

    assert.throws(
        () => validateWorkflowConfig({
            ...baseConfig,
            optional_quality_checks: {
                enabled: true,
                review_failure_cadence_interval: MAX_OPTIONAL_QUALITY_CHECKS_REVIEW_FAILURE_CADENCE_INTERVAL + 1
            }
        }),
        /workflow-config\.optional_quality_checks\.review_failure_cadence_interval must be <= 100/u
    );
});

test('validateWorkflowConfig rejects malformed optional quality changed-file regexes', () => {
    assert.throws(
        () => validateWorkflowConfig({
            full_suite_validation: {
                enabled: false,
                command: 'npm test',
                timeout_ms: 600000,
                green_summary_max_lines: 5,
                red_failure_chunk_lines: 50,
                out_of_scope_failure_policy: 'AUDIT_AND_BLOCK'
            },
            review_execution_policy: {
                mode: 'code_first_optional'
            },
            optional_quality_checks: {
                enabled: true,
                rules: [
                    {
                        id: 'custom_ops',
                        title: 'Custom ops',
                        prompt: 'Check custom ops paths.',
                        included_changed_file_regexes: ['[']
                    }
                ]
            }
        }),
        /workflow-config\.optional_quality_checks\.rules\[0\]\.included_changed_file_regexes\[0\] must be a valid JavaScript regular expression/u
    );
});

test('validateWorkflowConfig defaults missing full-suite placement but rejects invalid values', () => {
    const baseConfig = {
        full_suite_validation: {
            enabled: false,
            command: 'npm test',
            timeout_ms: 600000,
            green_summary_max_lines: 5,
            red_failure_chunk_lines: 50,
            out_of_scope_failure_policy: 'AUDIT_AND_BLOCK'
        },
        review_execution_policy: {
            mode: 'code_first_optional'
        }
    };

    const normalized = validateWorkflowConfig(baseConfig);
    assert.equal(
        (normalized.full_suite_validation as Record<string, unknown>).placement,
        'after_compile_before_reviews'
    );

    assert.throws(
        () => validateWorkflowConfig({
            ...baseConfig,
            full_suite_validation: {
                ...baseConfig.full_suite_validation,
                placement: 'after lunch'
            }
        }),
        /full_suite_validation\.placement must be one of/
    );
});

test('validateWorkflowConfig defaults and validates full-suite timeout policy fields', () => {
    const baseConfig = {
        full_suite_validation: {
            enabled: false,
            command: 'npm test',
            timeout_ms: 600000,
            green_summary_max_lines: 5,
            red_failure_chunk_lines: 50,
            out_of_scope_failure_policy: 'AUDIT_AND_BLOCK'
        },
        review_execution_policy: {
            mode: 'code_first_optional'
        }
    };

    const defaulted = validateWorkflowConfig(baseConfig);
    const defaultedFullSuite = defaulted.full_suite_validation as Record<string, unknown>;
    assert.equal(defaultedFullSuite.timeout_blocker, true);
    assert.equal(defaultedFullSuite.timeout_retry_count, 1);

    const normalized = validateWorkflowConfig({
        ...baseConfig,
        full_suite_validation: {
            ...baseConfig.full_suite_validation,
            timeout_blocker: 'no',
            timeout_retry_count: '0'
        }
    });
    const fullSuite = normalized.full_suite_validation as Record<string, unknown>;
    assert.equal(fullSuite.timeout_blocker, false);
    assert.equal(fullSuite.timeout_retry_count, 0);

    assert.throws(
        () => validateWorkflowConfig({
            ...baseConfig,
            full_suite_validation: {
                ...baseConfig.full_suite_validation,
                timeout_retry_count: -1
            }
        }),
        /full_suite_validation\.timeout_retry_count must be >= 0/
    );

    assert.throws(
        () => validateWorkflowConfig({
            ...baseConfig,
            full_suite_validation: {
                ...baseConfig.full_suite_validation,
                timeout_retry_count: 4
            }
        }),
        /full_suite_validation\.timeout_retry_count must be <= 3/
    );
});

test('validateWorkflowConfig accepts compile_gate command and legacy omission', () => {
    const baseConfig = {
        full_suite_validation: {
            enabled: false,
            command: 'npm test',
            timeout_ms: 600000,
            green_summary_max_lines: 5,
            red_failure_chunk_lines: 50,
            out_of_scope_failure_policy: 'AUDIT_AND_BLOCK'
        },
        review_execution_policy: {
            mode: 'code_first_optional'
        }
    };

    const legacy = validateWorkflowConfig(baseConfig);
    assert.equal(Object.prototype.hasOwnProperty.call(legacy, 'compile_gate'), false);

    const configured = validateWorkflowConfig({
        ...baseConfig,
        compile_gate: {
            command: ' npm run build '
        }
    });
    assert.deepEqual(configured.compile_gate, {
        command: 'npm run build'
    });

    assert.throws(
        () => validateWorkflowConfig({
            ...baseConfig,
            compile_gate: {
                command: ''
            }
        }),
        /workflow-config\.compile_gate\.command/
    );
});

test('validateWorkflowConfig rejects unknown task reset keys', () => {
    assert.throws(
        () => validateWorkflowConfig({
            full_suite_validation: {
                enabled: false,
                command: 'npm test',
                timeout_ms: 600000,
                green_summary_max_lines: 5,
                red_failure_chunk_lines: 50,
                out_of_scope_failure_policy: 'AUDIT_AND_BLOCK'
            },
            review_execution_policy: {
                mode: 'code_first_optional'
            },
            task_reset: {
                enabled: false,
                force: true
            }
        }),
        /workflow-config\.task_reset\.force is not allowed/
    );
});

test('validateWorkflowConfig rejects invalid project memory maintenance values', () => {
    const makeConfig = (projectMemory: Record<string, unknown>) => ({
        full_suite_validation: {
            enabled: false,
            command: 'npm test',
            timeout_ms: 600000,
            green_summary_max_lines: 5,
            red_failure_chunk_lines: 50,
            out_of_scope_failure_policy: 'AUDIT_AND_BLOCK'
        },
        review_execution_policy: {
            mode: 'code_first_optional'
        },
        project_memory_maintenance: projectMemory
    });

    assert.throws(
        () => validateWorkflowConfig(makeConfig({
            enabled: true,
            mode: 'audit',
            run_before_final_closeout: true,
            require_user_approval_for_writes: true,
            max_compact_summary_chars: 9000,
            read_strategy: 'index_first',
            impact_artifact_retention_days: 30
        })),
        /project_memory_maintenance\.mode must be one of/
    );
    assert.throws(
        () => validateWorkflowConfig(makeConfig({
            enabled: true,
            mode: 'check',
            run_before_final_closeout: true,
            require_user_approval_for_writes: true,
            max_compact_summary_chars: 1999,
            read_strategy: 'index_first',
            impact_artifact_retention_days: 30
        })),
        /max_compact_summary_chars must be >= 2000/
    );
    assert.throws(
        () => validateWorkflowConfig(makeConfig({
            enabled: true,
            mode: 'check',
            run_before_final_closeout: true,
            require_user_approval_for_writes: true,
            max_compact_summary_chars: 9000,
            read_strategy: 'full_scan',
            impact_artifact_retention_days: 30
        })),
        /project_memory_maintenance\.read_strategy must be one of/
    );
});

test('validateOutputFiltersConfig accepts context-driven parser controls from the tracked template', () => {
    const normalized = validateOutputFiltersConfig(readTemplateConfig('output-filters'));

    assert.equal(normalized.version, 2);
    const profiles = (normalized as Record<string, unknown>).profiles as Record<string, { parser: { tail_count: { context_key: string } } }>;
    assert.equal(
        profiles.compile_failure_console.parser.tail_count.context_key,
        'fail_tail_lines'
    );
});

test('validatePathsConfig rejects invalid ordinary doc path patterns', () => {
    const makeConfig = (ordinaryDocPaths: string[]) => ({
        metrics_path: 'garda-agent-orchestrator/runtime/metrics.jsonl',
        runtime_roots: ['src/'],
        fast_path_roots: ['src/'],
        triggers: { test: ['(^|/)tests?/'] },
        ordinary_doc_paths: ordinaryDocPaths
    });

    assert.throws(
        () => validatePathsConfig(makeConfig(['/tmp/notes.md'])),
        /relative repository path/
    );
    assert.throws(
        () => validatePathsConfig(makeConfig(['../plan.md'])),
        /must not contain '\.\.' path segments/
    );
    assert.throws(
        () => validatePathsConfig(makeConfig(['**/*.md'])),
        /repository-wide wildcard/
    );
});


test('validateProfilesConfig validates template profiles.json', () => {
    const normalized = validateProfilesConfig(readTemplateConfig('profiles'));
    assert.equal(normalized.version, 1);
    assert.equal(normalized.active_profile, 'balanced');

    const builtIn = normalized.built_in_profiles as Record<string, Record<string, unknown>>;
    assert.ok(builtIn.balanced);
    assert.ok(builtIn.fast);
    assert.ok(builtIn.strict);
    assert.ok(builtIn['docs-only']);
    assert.equal(Object.keys(builtIn).length, 4);
    const balancedFindingPolicy = builtIn.balanced.review_finding_policy as Record<string, unknown>;
    assert.equal(
        (balancedFindingPolicy.findings as Record<string, unknown>).medium,
        'fix_now'
    );
    assert.equal(
        (builtIn.balanced.review_follow_up_policy as Record<string, unknown>).materialization_mode,
        'grouped_by_parent'
    );
    assert.equal(
        (builtIn.fast.review_follow_up_policy as Record<string, unknown>).materialization_mode,
        'grouped_by_parent'
    );
    const fastFindingPolicy = builtIn.fast.review_finding_policy as Record<string, unknown>;
    assert.equal(fastFindingPolicy.policy_id, 'custom');
    assert.equal(
        (fastFindingPolicy.findings as Record<string, unknown>).high,
        'fix_now'
    );
    assert.equal(
        (builtIn.balanced.review_remediation_mode_policy as Record<string, unknown>).policy_id,
        'conservative_review_remediation_mode_v1'
    );
    assert.deepEqual(
        (builtIn.balanced.review_remediation_mode_policy as Record<string, unknown>).delta_eligible_review_types,
        ['api', 'code', 'db', 'dependency', 'infra', 'performance', 'refactor', 'security', 'test']
    );
    assert.deepEqual(builtIn.balanced.task_decomposition, { enabled: true });

    const user = normalized.user_profiles as Record<string, unknown>;
    assert.equal(Object.keys(user).length, 0);
});

test('validateProfilesConfig requires task_decomposition to be exactly enabled boolean', () => {
    const withUnknownKey = structuredClone(readTemplateConfig('profiles'));
    (
        withUnknownKey.built_in_profiles as Record<string, Record<string, unknown>>
    ).balanced.task_decomposition = { enabled: true, mode: 'guarded' };
    assert.throws(
        () => validateProfilesConfig(withUnknownKey),
        /task_decomposition must be exactly/u
    );

    const withNonBoolean = structuredClone(readTemplateConfig('profiles'));
    (
        withNonBoolean.built_in_profiles as Record<string, Record<string, unknown>>
    ).balanced.task_decomposition = { enabled: 'true' };
    assert.throws(
        () => validateProfilesConfig(withNonBoolean),
        /task_decomposition\.enabled must be a boolean/u
    );
});

test('validateProfilesConfig normalizes boolean-like review_policy values', () => {
    const normalized = validateProfilesConfig({
        version: 1,
        active_profile: 'test',
        built_in_profiles: {
            test: {
                description: 'Test profile',
                depth: 2,
                review_policy: { code: 'yes', db: 'auto', security: 'false' },
                review_finding_policy: {
                    schema_version: 1,
                    policy_id: 'custom',
                    findings: {
                        critical: 'fix_now',
                        high: 'create_follow_up',
                        medium: 'ignore',
                        low: 'ignore'
                    },
                    residual_risk: 'ignore'
                },
                token_economy: { enabled: 'true' },
                skills: { auto_suggest: 1 }
            }
        },
        user_profiles: {}
    });

    const builtIn = normalized.built_in_profiles as Record<string, Record<string, unknown>>;
    const policy = builtIn.test.review_policy as Record<string, unknown>;
    assert.equal(policy.code, true);
    assert.equal(policy.db, 'auto');
    assert.equal(policy.security, false);
    const findingPolicy = builtIn.test.review_finding_policy as Record<string, unknown>;
    assert.equal(findingPolicy.policy_id, 'custom');
    assert.equal((findingPolicy.findings as Record<string, unknown>).critical, 'fix_now');
    assert.equal(findingPolicy.residual_risk, 'ignore');
});

test('validateProfilesConfig allows legacy profiles without review_finding_policy for fail-closed runtime migration', () => {
    const normalized = validateProfilesConfig({
        version: 1,
        active_profile: 'legacy',
        built_in_profiles: {
            legacy: {
                description: 'Legacy profile',
                depth: 2,
                review_policy: { code: true },
                token_economy: { enabled: true },
                skills: { auto_suggest: true }
            }
        },
        user_profiles: {}
    });

    const builtIn = normalized.built_in_profiles as Record<string, Record<string, unknown>>;
    assert.equal(builtIn.legacy.review_finding_policy, undefined);
    assert.equal(builtIn.legacy.review_follow_up_policy, undefined);
    assert.equal(builtIn.legacy.review_remediation_mode_policy, undefined);
});

test('validateProfilesConfig accepts explicit disables and stable custom lanes while rejecting malformed lane ids', () => {
    const profiles = structuredClone(readTemplateConfig('profiles'));
    const policy = (
        profiles.built_in_profiles as Record<string, Record<string, unknown>>
    ).balanced.review_remediation_mode_policy as Record<string, unknown>;
    policy.delta_eligible_review_types = [];
    const normalized = validateProfilesConfig(profiles);
    assert.deepEqual(
        (normalized.built_in_profiles as Record<string, Record<string, unknown>>)
            .balanced.review_remediation_mode_policy,
        policy
    );

    policy.delta_eligible_review_types = ['custom-quality'];
    assert.deepEqual(
        ((validateProfilesConfig(profiles).built_in_profiles as Record<string, Record<string, unknown>>)
            .balanced.review_remediation_mode_policy as Record<string, unknown>).delta_eligible_review_types,
        ['custom-quality']
    );

    policy.delta_eligible_review_types = ['custom_lane'];
    assert.throws(
        () => validateProfilesConfig(profiles),
        /invalid or unsupported.*review lane identifiers/u
    );
});

test('validateProfilesConfig rejects unknown grouped follow-up modes and keys', () => {
    const invalidMode = structuredClone(readTemplateConfig('profiles'));
    const policy = (
        invalidMode.built_in_profiles as Record<string, Record<string, unknown>>
    ).balanced.review_follow_up_policy as Record<string, unknown>;
    policy.materialization_mode = 'group_across_tasks';
    assert.throws(
        () => validateProfilesConfig(invalidMode),
        /must be one of: per_finding, grouped_by_parent/
    );

    const unknownKey = structuredClone(readTemplateConfig('profiles'));
    const unknownPolicy = (
        unknownKey.built_in_profiles as Record<string, Record<string, unknown>>
    ).balanced.review_follow_up_policy as Record<string, unknown>;
    unknownPolicy.cross_cycle = true;
    assert.throws(() => validateProfilesConfig(unknownKey), /cross_cycle is not allowed/);
});

test('validateProfilesConfig rejects review_finding_policy that weakens critical finding disposition', () => {
    assert.throws(() => {
        validateProfilesConfig({
            version: 1,
            active_profile: 'bad',
            built_in_profiles: {
                bad: {
                    description: 'Bad finding policy',
                    depth: 2,
                    review_policy: { code: true },
                    review_finding_policy: {
                        schema_version: 1,
                        policy_id: 'custom',
                        findings: {
                            critical: 'ignore',
                            high: 'create_follow_up',
                            medium: 'ignore',
                            low: 'ignore'
                        },
                        residual_risk: 'ignore'
                    },
                    token_economy: { enabled: true },
                    skills: { auto_suggest: true }
                }
            },
            user_profiles: {}
        });
    }, /critical is immutable and must be fix_now/);
});

test('validateProfilesConfig rejects unknown finding-policy keys and actions', () => {
    const withUnknownPolicyKey = structuredClone(readTemplateConfig('profiles'));
    const unknownPolicy = (
        withUnknownPolicyKey.built_in_profiles as Record<string, Record<string, unknown>>
    ).balanced.review_finding_policy as Record<string, unknown>;
    unknownPolicy.unexpected = true;
    assert.throws(
        () => validateProfilesConfig(withUnknownPolicyKey),
        /unexpected is not allowed/
    );

    const withUnknownFindingKey = structuredClone(readTemplateConfig('profiles'));
    const unknownFindings = (
        (
            withUnknownFindingKey.built_in_profiles as Record<string, Record<string, unknown>>
        ).balanced.review_finding_policy as Record<string, unknown>
    ).findings as Record<string, unknown>;
    unknownFindings.informational = 'ignore';
    assert.throws(
        () => validateProfilesConfig(withUnknownFindingKey),
        /informational is not allowed/
    );

    const withUnknownAction = structuredClone(readTemplateConfig('profiles'));
    const actionFindings = (
        (
            withUnknownAction.built_in_profiles as Record<string, Record<string, unknown>>
        ).balanced.review_finding_policy as Record<string, unknown>
    ).findings as Record<string, unknown>;
    actionFindings.low = 'defer_silently';
    assert.throws(
        () => validateProfilesConfig(withUnknownAction),
        /must be one of: fix_now, create_follow_up, ignore/
    );
});

test('validateProfilesConfig rejects named review_finding_policy preset mismatches', () => {
    assert.throws(() => {
        validateProfilesConfig({
            version: 1,
            active_profile: 'bad',
            built_in_profiles: {
                bad: {
                    description: 'Bad named finding policy',
                    depth: 2,
                    review_policy: { code: true },
                    review_finding_policy: {
                        schema_version: 1,
                        policy_id: 'balanced',
                        findings: {
                            critical: 'fix_now',
                            high: 'create_follow_up',
                            medium: 'create_follow_up',
                            low: 'create_follow_up'
                        },
                        residual_risk: 'create_follow_up'
                    },
                    token_economy: { enabled: true },
                    skills: { auto_suggest: true }
                }
            },
            user_profiles: {}
        });
    }, /findings\.high must match balanced preset/);
});

test('validateProfilesConfig rejects active_profile pointing to nonexistent profile', () => {
    assert.throws(() => {
        validateProfilesConfig({
            version: 1,
            active_profile: 'nonexistent',
            built_in_profiles: {
                balanced: {
                    description: 'Test', depth: 2,
                    review_policy: { code: true },
                    token_economy: { enabled: true },
                    skills: { auto_suggest: true }
                }
            },
            user_profiles: {}
        });
    }, /does not match any/);
});

test('validateProfilesConfig rejects user profile name conflicting with built-in', () => {
    assert.throws(() => {
        validateProfilesConfig({
            version: 1,
            active_profile: 'balanced',
            built_in_profiles: {
                balanced: {
                    description: 'Test', depth: 2,
                    review_policy: { code: true },
                    token_economy: { enabled: true },
                    skills: { auto_suggest: true }
                }
            },
            user_profiles: {
                balanced: {
                    description: 'Conflict', depth: 1,
                    review_policy: { code: false },
                    token_economy: { enabled: false },
                    skills: { auto_suggest: false }
                }
            }
        });
    }, /conflicts with a built-in/);
});

test('validateOptionalSkillSelectionPolicyConfig validates the tracked template', () => {
    const normalized = validateOptionalSkillSelectionPolicyConfig(readTemplateConfig('optional-skill-selection-policy'));
    assert.equal(normalized.version, 1);
    assert.equal(normalized.mode, 'optional');
});

test('validateManagedConfigByName handles optional-skill-selection-policy', () => {
    const config = readTemplateConfig('optional-skill-selection-policy');
    const result = validateManagedConfigByName('optional-skill-selection-policy', config);
    assert.equal(result.mode, 'optional');
});

test('validateProfilesConfig rejects empty built_in_profiles', () => {
    assert.throws(() => {
        validateProfilesConfig({
            version: 1,
            active_profile: 'any',
            built_in_profiles: {},
            user_profiles: {}
        });
    }, /at least one profile/);
});

test('validateProfilesConfig rejects depth outside 1-3 range', () => {
    assert.throws(() => {
        validateProfilesConfig({
            version: 1,
            active_profile: 'bad',
            built_in_profiles: {
                bad: {
                    description: 'Bad depth', depth: 5,
                    review_policy: { code: true },
                    token_economy: { enabled: true },
                    skills: { auto_suggest: true }
                }
            },
            user_profiles: {}
        });
    }, /must be <= 3/);
});

test('validateProfilesConfig allows active_profile to reference a user profile', () => {
    const normalized = validateProfilesConfig({
        version: 1,
        active_profile: 'custom',
        built_in_profiles: {
            balanced: {
                description: 'Built-in', depth: 2,
                review_policy: { code: true },
                token_economy: { enabled: true },
                skills: { auto_suggest: true }
            }
        },
        user_profiles: {
            custom: {
                description: 'Custom', depth: 1,
                review_policy: { code: false },
                token_economy: { enabled: false },
                skills: { auto_suggest: false }
            }
        }
    });

    assert.equal(normalized.active_profile, 'custom');
    const user = normalized.user_profiles as Record<string, Record<string, unknown>>;
    assert.ok(user.custom);
});

test('validateProfilesConfig rejects unknown token_economy keys', () => {
    assert.throws(() => {
        validateProfilesConfig({
            version: 1,
            active_profile: 'bad',
            built_in_profiles: {
                bad: {
                    description: 'Bad key', depth: 2,
                    review_policy: { code: true },
                    token_economy: { enabled: true, unknown_key: true },
                    skills: { auto_suggest: true }
                }
            },
            user_profiles: {}
        });
    }, /not a recognized token_economy key/);
});

test('validateProfilesConfig rejects unknown skills keys', () => {
    assert.throws(() => {
        validateProfilesConfig({
            version: 1,
            active_profile: 'bad',
            built_in_profiles: {
                bad: {
                    description: 'Bad key', depth: 2,
                    review_policy: { code: true },
                    token_economy: { enabled: true },
                    skills: { auto_suggest: true, unknown_skill: false }
                }
            },
            user_profiles: {}
        });
    }, /not a recognized skills key/);
});


test('validateReviewArtifactStorageConfig normalizes valid config', () => {
    const input = {
        version: 1,
        retention_mode: 'summary',
        compress_after_days: 14,
        compression_format: 'gzip',
        preserve_gate_receipts: true,
        gate_receipt_suffixes: ['-task-mode.json', '-preflight.json'],
        privacy_notice: 'Test notice.'
    };
    const result = validateReviewArtifactStorageConfig(input);
    assert.equal(result.version, 1);
    assert.equal(result.retention_mode, 'summary');
    assert.equal(result.compress_after_days, 14);
    assert.equal(result.compression_format, 'gzip');
    assert.equal(result.preserve_gate_receipts, true);
    assert.deepEqual(result.gate_receipt_suffixes, ['-task-mode.json', '-preflight.json']);
    assert.equal(result.privacy_notice, 'Test notice.');
});

test('validateReviewArtifactStorageConfig accepts none mode', () => {
    const result = validateReviewArtifactStorageConfig({
        version: 1,
        retention_mode: 'none',
        compress_after_days: 0,
        compression_format: 'gzip',
        preserve_gate_receipts: false,
        gate_receipt_suffixes: ['-task-mode.json']
    });
    assert.equal(result.retention_mode, 'none');
    assert.equal(result.preserve_gate_receipts, false);
});

test('validateReviewArtifactStorageConfig accepts full mode', () => {
    const result = validateReviewArtifactStorageConfig({
        version: 1,
        retention_mode: 'full',
        compress_after_days: 7,
        compression_format: 'gzip',
        preserve_gate_receipts: true,
        gate_receipt_suffixes: ['-task-mode.json']
    });
    assert.equal(result.retention_mode, 'full');
});

test('validateReviewArtifactStorageConfig rejects invalid retention_mode', () => {
    assert.throws(() => {
        validateReviewArtifactStorageConfig({
            version: 1,
            retention_mode: 'invalid',
            compress_after_days: 7,
            compression_format: 'gzip',
            preserve_gate_receipts: true,
            gate_receipt_suffixes: ['-task-mode.json']
        });
    }, /retention_mode must be one of/);
});

test('validateReviewArtifactStorageConfig rejects invalid compression_format', () => {
    assert.throws(() => {
        validateReviewArtifactStorageConfig({
            version: 1,
            retention_mode: 'full',
            compress_after_days: 7,
            compression_format: 'brotli',
            preserve_gate_receipts: true,
            gate_receipt_suffixes: ['-task-mode.json']
        });
    }, /compression_format must be one of/);
});

test('validateReviewArtifactStorageConfig rejects negative compress_after_days', () => {
    assert.throws(() => {
        validateReviewArtifactStorageConfig({
            version: 1,
            retention_mode: 'full',
            compress_after_days: -1,
            compression_format: 'gzip',
            preserve_gate_receipts: true,
            gate_receipt_suffixes: ['-task-mode.json']
        });
    }, /must be >= 0/);
});

test('validateReviewArtifactStorageConfig rejects empty gate_receipt_suffixes', () => {
    assert.throws(() => {
        validateReviewArtifactStorageConfig({
            version: 1,
            retention_mode: 'full',
            compress_after_days: 7,
            compression_format: 'gzip',
            preserve_gate_receipts: true,
            gate_receipt_suffixes: []
        });
    }, /must not be empty/);
});

test('validateReviewArtifactStorageConfig normalizes case of retention_mode', () => {
    const result = validateReviewArtifactStorageConfig({
        version: 1,
        retention_mode: 'SUMMARY',
        compress_after_days: 0,
        compression_format: 'GZIP',
        preserve_gate_receipts: true,
        gate_receipt_suffixes: ['-task-mode.json']
    });
    assert.equal(result.retention_mode, 'summary');
    assert.equal(result.compression_format, 'gzip');
});

test('validateReviewArtifactStorageConfig validates template config', () => {
    const config = readTemplateConfig('review-artifact-storage');
    const result = validateReviewArtifactStorageConfig(config);
    assert.equal(result.retention_mode, 'full');
    assert.equal(result.compress_after_days, 7);
});

test('validateManagedConfigByName handles review-artifact-storage', () => {
    const config = readTemplateConfig('review-artifact-storage');
    const result = validateManagedConfigByName('review-artifact-storage', config);
    assert.equal(result.retention_mode, 'full');
});

test('validateRuntimeRetentionConfig normalizes valid config', () => {
    const result = validateRuntimeRetentionConfig({
        version: 1,
        active_tasks: {
            protect_runtime_grace_days: '7',
            protect_current_cycle_artifacts: 'true'
        },
        healthy_done: {
            compact_after_days: '30',
            require_ledger: 'yes',
            retain_task_events_until_ledger_verified: 1
        },
        problem_tasks: {
            compress_after_days: '45',
            preserve_detailed_evidence: 'true'
        },
        purge: {
            require_confirm: 'true'
        },
        daily_maintenance: {
            enabled: 'false',
            max_tasks_per_run: '25',
            eligible_older_than_days: '30',
            keep_latest_tasks: '5',
            dry_run: 'yes'
        }
    });
    assert.equal(result.version, 1);
    assert.equal((result.active_tasks as Record<string, unknown>).protect_runtime_grace_days, 7);
    assert.equal((result.active_tasks as Record<string, unknown>).protect_current_cycle_artifacts, true);
    assert.equal((result.healthy_done as Record<string, unknown>).compact_after_days, 30);
    assert.equal((result.problem_tasks as Record<string, unknown>).compress_after_days, 45);
    assert.equal((result.purge as Record<string, unknown>).require_confirm, true);
    assert.equal((result.daily_maintenance as Record<string, unknown>).max_tasks_per_run, 25);
    assert.equal((result.daily_maintenance as Record<string, unknown>).eligible_older_than_days, 30);
    assert.equal((result.daily_maintenance as Record<string, unknown>).keep_latest_tasks, 5);
    assert.equal((result.daily_maintenance as Record<string, unknown>).dry_run, true);
});

test('validateRuntimeRetentionConfig defaults legacy daily maintenance dry_run to true', () => {
    const config = readTemplateConfig('runtime-retention') as Record<string, unknown>;
    delete ((config.daily_maintenance as Record<string, unknown>).dry_run);
    delete ((config.daily_maintenance as Record<string, unknown>).eligible_older_than_days);
    delete ((config.daily_maintenance as Record<string, unknown>).keep_latest_tasks);
    const result = validateRuntimeRetentionConfig(config);
    assert.equal((result.daily_maintenance as Record<string, unknown>).dry_run, true);
    assert.equal((result.daily_maintenance as Record<string, unknown>).eligible_older_than_days, 30);
    assert.equal((result.daily_maintenance as Record<string, unknown>).keep_latest_tasks, 0);
});

test('validateRuntimeRetentionConfig validates template config', () => {
    const config = readTemplateConfig('runtime-retention');
    const result = validateRuntimeRetentionConfig(config);
    assert.equal(result.version, 1);
    assert.equal((result.healthy_done as Record<string, unknown>).compact_after_days, 30);
    assert.equal((result.daily_maintenance as Record<string, unknown>).eligible_older_than_days, 30);
    assert.equal((result.daily_maintenance as Record<string, unknown>).keep_latest_tasks, 0);
});

test('validateManagedConfigByName handles runtime-retention', () => {
    const config = readTemplateConfig('runtime-retention');
    const result = validateManagedConfigByName('runtime-retention', config);
    assert.equal((result.problem_tasks as Record<string, unknown>).preserve_detailed_evidence, true);
});

test('buildRuntimeRetentionPreview classifies complete DONE tasks as compact ledger candidates', () => {
    const workspace = makeRetentionPreviewWorkspace();
    try {
        const taskId = 'T-401';
        writeTaskQueue(workspace.targetRoot, [{ id: taskId, status: 'DONE', title: 'Completed retention task' }]);
        appendStatusEvent(workspace.bundleRoot, taskId, 'DONE');
        appendTaskEvent(workspace.bundleRoot, taskId, 'COMPLETION_GATE_PASSED', 'PASS', 'Completion gate passed.', {});
        const taskEventPath = path.join(workspace.eventsRoot, `${taskId}.jsonl`);
        setFileAgeDays(taskEventPath, 45);
        writeTimelineSummary(workspace.eventsRoot, {
            [taskId]: {
                task_id: taskId,
                file_size_bytes: fs.statSync(taskEventPath).size,
                file_mtime_ms: Math.floor(fs.statSync(taskEventPath).mtimeMs),
                code_changed: false,
                completeness_status: 'COMPLETE',
                events_found: ['STATUS_CHANGED', 'COMPLETION_GATE_PASSED'],
                events_missing: [],
                completeness_violations: [],
                integrity_status: 'PASS',
                events_scanned: 2,
                integrity_event_count: 2,
                integrity_violations: []
            }
        });

        const preview = buildRuntimeRetentionPreview(
            workspace.targetRoot,
            workspace.bundleRoot,
            [{ path: taskEventPath, category: 'task-events' }]
        );

        assert.equal(preview.task_count, 1);
        assert.equal(preview.eligible_now_count, 0);
        assert.equal(preview.tiers.compact_ledger_candidate, 1);
        assert.equal(preview.health_states.healthy_done, 1);
        assert.deepEqual(preview.tasks[0].candidate_categories, ['task-events']);
        assert.equal(preview.tasks[0].health_state, 'healthy_done');
        assert.equal(preview.tasks[0].retention_tier, 'compact_ledger_candidate');
        assert.equal(preview.tasks[0].ledger_status, 'MISSING');
        assert.equal(preview.tasks[0].eligible_now, false);
        assert.ok(preview.tasks[0].reasons.some((reason) => reason.includes('Heavy artifacts stay authoritative until a ledger exists')));
    } finally {
        workspace.cleanup();
    }
});

test('buildRuntimeRetentionPreview classifies blocked tasks as compressed forensic candidates', () => {
    const workspace = makeRetentionPreviewWorkspace();
    try {
        const taskId = 'T-402';
        writeTaskQueue(workspace.targetRoot, [{ id: taskId, status: 'BLOCKED', title: 'Blocked retention task' }]);
        appendStatusEvent(workspace.bundleRoot, taskId, 'BLOCKED');
        appendTaskEvent(workspace.bundleRoot, taskId, 'TASK_BLOCKED', 'FAIL', 'Task is blocked.', {});
        const taskEventPath = path.join(workspace.eventsRoot, `${taskId}.jsonl`);
        setFileAgeDays(taskEventPath, 45);
        writeTimelineSummary(workspace.eventsRoot, {
            [taskId]: {
                task_id: taskId,
                file_size_bytes: fs.statSync(taskEventPath).size,
                file_mtime_ms: Math.floor(fs.statSync(taskEventPath).mtimeMs),
                code_changed: false,
                completeness_status: 'INCOMPLETE',
                events_found: ['STATUS_CHANGED', 'TASK_BLOCKED'],
                events_missing: [],
                completeness_violations: [],
                integrity_status: 'PASS',
                events_scanned: 2,
                integrity_event_count: 2,
                integrity_violations: []
            }
        });

        const preview = buildRuntimeRetentionPreview(
            workspace.targetRoot,
            workspace.bundleRoot,
            [{ path: taskEventPath, category: 'task-events' }]
        );

        assert.equal(preview.health_states.blocked, 1);
        assert.equal(preview.tiers.compressed_forensic_candidate, 1);
        assert.equal(preview.tasks[0].health_state, 'blocked');
        assert.equal(preview.tasks[0].retention_tier, 'compressed_forensic_candidate');
        assert.equal(preview.tasks[0].ledger_status, 'MISSING');
        assert.equal(preview.tasks[0].eligible_now, false);
        assert.ok(preview.tasks[0].reasons.some((reason) => reason.includes('blocked')));
        assert.ok(preview.tasks[0].reasons.some((reason) => reason.includes('preserved by policy')));
    } finally {
        workspace.cleanup();
    }
});

test('buildRuntimeRetentionPreview classifies failed tasks as compressed forensic candidates', () => {
    const workspace = makeRetentionPreviewWorkspace();
    try {
        const taskId = 'T-403';
        writeTaskQueue(workspace.targetRoot, [{ id: taskId, status: 'DONE', title: 'Failed retention task' }]);
        appendStatusEvent(workspace.bundleRoot, taskId, 'DONE');
        appendTaskEvent(workspace.bundleRoot, taskId, 'COMPILE_GATE_FAILED', 'FAIL', 'Compile gate failed.', {});
        const taskEventPath = path.join(workspace.eventsRoot, `${taskId}.jsonl`);
        setFileAgeDays(taskEventPath, 45);
        writeTimelineSummary(workspace.eventsRoot, {
            [taskId]: {
                task_id: taskId,
                file_size_bytes: fs.statSync(taskEventPath).size,
                file_mtime_ms: Math.floor(fs.statSync(taskEventPath).mtimeMs),
                code_changed: false,
                completeness_status: 'INCOMPLETE',
                events_found: ['STATUS_CHANGED', 'COMPILE_GATE_FAILED'],
                events_missing: [],
                completeness_violations: [],
                integrity_status: 'PASS',
                events_scanned: 2,
                integrity_event_count: 2,
                integrity_violations: []
            }
        });

        const preview = buildRuntimeRetentionPreview(
            workspace.targetRoot,
            workspace.bundleRoot,
            [{ path: taskEventPath, category: 'task-events' }]
        );

        assert.equal(preview.health_states.failed, 1);
        assert.equal(preview.tasks[0].health_state, 'failed');
        assert.equal(preview.tasks[0].retention_tier, 'compressed_forensic_candidate');
        assert.equal(preview.tasks[0].ledger_status, 'MISSING');
        assert.equal(preview.tasks[0].eligible_now, false);
        assert.ok(preview.tasks[0].reasons.some((reason) => reason.includes('failed gate')));
        assert.ok(preview.tasks[0].reasons.some((reason) => reason.includes('preserved by policy')));
    } finally {
        workspace.cleanup();
    }
});

test('buildRuntimeRetentionPreview does not classify problematic DONE history as healthy_done', () => {
    const workspace = makeRetentionPreviewWorkspace();
    try {
        const taskId = 'T-403-F1';
        writeTaskQueue(workspace.targetRoot, [{ id: taskId, status: 'DONE', title: 'Problematic done retention task' }]);
        appendStatusEvent(workspace.bundleRoot, taskId, 'DONE');
        appendTaskEvent(workspace.bundleRoot, taskId, 'COMPILE_GATE_FAILED', 'FAIL', 'Compile gate failed.', {});
        appendTaskEvent(workspace.bundleRoot, taskId, 'COMPLETION_GATE_PASSED', 'PASS', 'Completion gate passed.', {});
        const taskEventPath = path.join(workspace.eventsRoot, `${taskId}.jsonl`);
        setFileAgeDays(taskEventPath, 45);
        writeTimelineSummary(workspace.eventsRoot, {
            [taskId]: {
                task_id: taskId,
                file_size_bytes: fs.statSync(taskEventPath).size,
                file_mtime_ms: Math.floor(fs.statSync(taskEventPath).mtimeMs),
                code_changed: false,
                completeness_status: 'COMPLETE',
                events_found: ['STATUS_CHANGED', 'COMPILE_GATE_FAILED', 'COMPLETION_GATE_PASSED'],
                events_missing: [],
                completeness_violations: [],
                integrity_status: 'PASS',
                events_scanned: 3,
                integrity_event_count: 3,
                integrity_violations: []
            }
        });

        const preview = buildRuntimeRetentionPreview(
            workspace.targetRoot,
            workspace.bundleRoot,
            [{ path: taskEventPath, category: 'task-events' }]
        );

        assert.equal(preview.health_states.healthy_done ?? 0, 0);
        assert.equal(preview.health_states.failed, 1);
        assert.equal(preview.tasks[0].health_state, 'failed');
        assert.equal(preview.tasks[0].retention_tier, 'compressed_forensic_candidate');
        assert.ok(preview.tasks[0].reasons.some((reason) => reason.includes('failed gate')));
    } finally {
        workspace.cleanup();
    }
});

test('buildRuntimeRetentionPreview owns lowercase follow-up review artifacts when JSON task_id differs only by case', () => {
    const workspace = makeRetentionPreviewWorkspace();
    try {
        const taskId = 'T-506-f1';
        writeTaskQueue(workspace.targetRoot, [{ id: taskId, status: 'DONE', title: 'Lowercase follow-up retention task' }]);
        const reviewRoot = path.join(workspace.bundleRoot, 'runtime', 'reviews');
        fs.mkdirSync(reviewRoot, { recursive: true });
        const reviewArtifactPath = path.join(reviewRoot, `${taskId}-reset-report.json`);
        fs.writeFileSync(reviewArtifactPath, JSON.stringify({ task_id: 'T-506-F1', status: 'PASS' }), 'utf8');
        setFileAgeDays(reviewArtifactPath, 45);

        const preview = buildRuntimeRetentionPreview(
            workspace.targetRoot,
            workspace.bundleRoot,
            [{ path: reviewArtifactPath, category: 'reviews' }]
        );

        assert.equal(preview.task_count, 1);
        assert.equal(preview.tasks[0].task_id, taskId);
        assert.deepEqual(preview.tasks[0].candidate_categories, ['reviews']);
        assert.equal(preview.tasks[0].candidate_count, 1);
    } finally {
        workspace.cleanup();
    }
});

test('buildRuntimeRetentionPreview owns review artifacts with expanded known suffixes', () => {
    const workspace = makeRetentionPreviewWorkspace();
    try {
        const taskId = 'T-507';
        writeTaskQueue(workspace.targetRoot, [{ id: taskId, status: 'DONE', title: 'Known suffix retention task' }]);
        const reviewRoot = path.join(workspace.bundleRoot, 'runtime', 'reviews');
        fs.mkdirSync(reviewRoot, { recursive: true });
        const reviewArtifactPaths = [
            path.join(reviewRoot, `${taskId}-test-review-output.md`),
            path.join(reviewRoot, `${taskId}-full-suite-validation.json`),
            path.join(reviewRoot, `${taskId}-refactor-scoped.diff`)
        ];
        fs.writeFileSync(reviewArtifactPaths[0], '# Test Review\n\nTEST REVIEW PASSED\n', 'utf8');
        fs.writeFileSync(reviewArtifactPaths[1], JSON.stringify({ status: 'PASS' }), 'utf8');
        fs.writeFileSync(reviewArtifactPaths[2], 'diff --git a/file b/file\n', 'utf8');
        for (const reviewArtifactPath of reviewArtifactPaths) {
            setFileAgeDays(reviewArtifactPath, 45);
        }

        const preview = buildRuntimeRetentionPreview(
            workspace.targetRoot,
            workspace.bundleRoot,
            reviewArtifactPaths.map((reviewArtifactPath) => ({ path: reviewArtifactPath, category: 'reviews' }))
        );

        assert.equal(preview.task_count, 1);
        assert.equal(preview.tasks[0].task_id, taskId);
        assert.deepEqual(preview.tasks[0].candidate_categories, ['reviews']);
        assert.equal(preview.tasks[0].candidate_count, 3);
    } finally {
        workspace.cleanup();
    }
});

test('buildRuntimeRetentionPreview keeps active tasks in protected evidence tier', () => {
    const workspace = makeRetentionPreviewWorkspace();
    try {
        const taskId = 'T-404';
        writeTaskQueue(workspace.targetRoot, [{ id: taskId, status: 'IN_PROGRESS', title: 'Active retention task' }]);
        appendStatusEvent(workspace.bundleRoot, taskId, 'IN_PROGRESS');
        appendTaskEvent(workspace.bundleRoot, taskId, 'TASK_MODE_ENTERED', 'PASS', 'Task mode entered.', {});
        const taskEventPath = path.join(workspace.eventsRoot, `${taskId}.jsonl`);
        setFileAgeDays(taskEventPath, 45);
        writeTimelineSummary(workspace.eventsRoot, {
            [taskId]: {
                task_id: taskId,
                file_size_bytes: fs.statSync(taskEventPath).size,
                file_mtime_ms: Math.floor(fs.statSync(taskEventPath).mtimeMs),
                code_changed: false,
                completeness_status: 'INCOMPLETE',
                events_found: ['STATUS_CHANGED', 'TASK_MODE_ENTERED'],
                events_missing: [],
                completeness_violations: [],
                integrity_status: 'PASS',
                events_scanned: 2,
                integrity_event_count: 2,
                integrity_violations: []
            }
        });

        const preview = buildRuntimeRetentionPreview(
            workspace.targetRoot,
            workspace.bundleRoot,
            [{ path: taskEventPath, category: 'task-events' }]
        );

        assert.equal(preview.health_states.active, 1);
        assert.equal(preview.tiers.active_evidence, 1);
        assert.equal(preview.tasks[0].health_state, 'active');
        assert.equal(preview.tasks[0].retention_tier, 'active_evidence');
        assert.equal(preview.tasks[0].ledger_status, 'MISSING');
        assert.equal(preview.tasks[0].eligible_now, false);
        assert.ok(preview.tasks[0].reasons.some((reason) => reason.includes('protected')));
    } finally {
        workspace.cleanup();
    }
});
