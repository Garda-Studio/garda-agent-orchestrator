/**
 * Portable JSON Schema definitions for all managed config files.
 *
 * Each schema is a plain object following the JSON Schema draft-07 spec.
 * Schemas can be serialized to `.json` for external tooling or used in-process
 * for programmatic validation via {@link validateAgainstSchema}.
 */

import {
    SOURCE_OF_TRUTH_VALUES,
    BREVITY_VALUES,
    COLLECTED_VIA_VALUES
} from '../core/constants';
import { REVIEW_EXECUTION_POLICY_MODES } from '../core/review-execution-policy';
import { REVIEW_REMEDIATION_REVIEW_TYPE_ID_PATTERN } from '../policy/review-remediation-mode-policy';
import {
    DEFAULT_OPTIONAL_QUALITY_CHECKS_REVIEW_FAILURE_CADENCE_INTERVAL,
    DEFAULT_OPTIONAL_QUALITY_CHECK_RULES,
    FULL_SUITE_TIMEOUT_RETRY_COUNT_MAX,
    FULL_SUITE_VALIDATION_PLACEMENTS,
    MAX_OPTIONAL_QUALITY_CHECKS_REVIEW_FAILURE_CADENCE_INTERVAL,
    PROJECT_MEMORY_MAINTENANCE_MODES,
    PROJECT_MEMORY_READ_STRATEGIES
} from '../core/workflow-config';

const REVIEW_CAPABILITY_KEYS = [
    'code', 'db', 'security', 'refactor',
    'api', 'test', 'performance', 'infra', 'dependency'
] as const;

const OPTIONAL_QUALITY_CHECK_BASELINE_RULE_IDS = DEFAULT_OPTIONAL_QUALITY_CHECK_RULES.map((rule) => rule.id);

function escapeRegexLiteral(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function buildCaseInsensitiveLiteralPattern(value: string): string {
    return [...value]
        .map((char) => {
            const lower = char.toLowerCase();
            const upper = char.toUpperCase();
            return lower !== upper
                ? `[${escapeRegexLiteral(lower)}${escapeRegexLiteral(upper)}]`
                : escapeRegexLiteral(char);
        })
        .join('');
}

const OPTIONAL_QUALITY_CHECK_BASELINE_RULE_ID_PATTERN = `^(?:${OPTIONAL_QUALITY_CHECK_BASELINE_RULE_IDS
    .map(buildCaseInsensitiveLiteralPattern)
    .join('|')})$`;

const OPTIONAL_QUALITY_CHECK_EXCLUDED_SCOPE_CATEGORIES_SCHEMA: Record<string, unknown> = Object.freeze({
    type: 'array',
    items: {
        type: 'string',
        minLength: 1
    },
    uniqueItems: true,
    description: 'Preflight scope categories where this advisory rule is skipped. Use ["test-only"] to omit a rule from pure test changes without disabling it globally.'
});

const OPTIONAL_QUALITY_CHECK_INCLUDED_SCOPE_CATEGORIES_SCHEMA: Record<string, unknown> = Object.freeze({
    type: 'array',
    items: {
        type: 'string',
        minLength: 1
    },
    uniqueItems: true,
    description: 'Preflight scope categories where this advisory rule is active. Leave empty to keep the rule broadly active unless changed-file regexes constrain it.'
});

const OPTIONAL_QUALITY_CHECK_INCLUDED_CHANGED_FILE_REGEXES_SCHEMA: Record<string, unknown> = Object.freeze({
    type: 'array',
    items: {
        type: 'string',
        minLength: 1
    },
    uniqueItems: true,
    description: 'Case-insensitive changed-file regexes where this advisory rule is active. Use this for scope-specific rule packs such as shell and ops scripts.'
});

function buildBaselineOptionalQualityCheckRuleSchema(rule: typeof DEFAULT_OPTIONAL_QUALITY_CHECK_RULES[number]): Record<string, unknown> {
    return {
        type: 'object',
        properties: {
            id: {
                const: rule.id,
                description: 'Shipped baseline quality-check rule id.'
            },
            title: {
                const: rule.title,
                description: 'Managed shipped baseline quality-check rule title.'
            },
            prompt: {
                const: rule.prompt,
                description: 'Managed shipped baseline quality-check rule prompt.'
            },
            enabled: {
                type: 'boolean',
                description: 'Enable this shipped baseline rule.'
            },
            included_scope_categories: {
                ...OPTIONAL_QUALITY_CHECK_INCLUDED_SCOPE_CATEGORIES_SCHEMA,
                description: 'User-editable preflight scope categories where this shipped baseline advisory rule is active.'
            },
            included_changed_file_regexes: {
                ...OPTIONAL_QUALITY_CHECK_INCLUDED_CHANGED_FILE_REGEXES_SCHEMA,
                description: 'User-editable changed-file regexes where this shipped baseline advisory rule is active.'
            },
            excluded_scope_categories: {
                ...OPTIONAL_QUALITY_CHECK_EXCLUDED_SCOPE_CATEGORIES_SCHEMA,
                description: 'User-editable preflight scope categories where this shipped baseline advisory rule is skipped.'
            }
        },
        required: ['id', 'title', 'prompt'],
        additionalProperties: true
    };
}

const BASELINE_OPTIONAL_QUALITY_CHECK_RULE_SCHEMAS = DEFAULT_OPTIONAL_QUALITY_CHECK_RULES.map(
    buildBaselineOptionalQualityCheckRuleSchema
);

const CUSTOM_OPTIONAL_QUALITY_CHECK_RULE_SCHEMA: Record<string, unknown> = Object.freeze({
    type: 'object',
    properties: {
        id: {
            type: 'string',
            minLength: 1,
            not: { pattern: OPTIONAL_QUALITY_CHECK_BASELINE_RULE_ID_PATTERN },
            description: 'Stable machine id for a custom checklist rule. It must not reuse a shipped baseline rule id.'
        },
        title: {
            type: 'string',
            minLength: 1,
            description: 'Human-readable custom checklist rule title.'
        },
        prompt: {
            type: 'string',
            minLength: 1,
            description: 'Instruction the agent should evaluate for this custom advisory rule.'
        },
        enabled: {
            type: 'boolean',
            description: 'Enable this custom advisory rule.'
        },
        included_scope_categories: {
            ...OPTIONAL_QUALITY_CHECK_INCLUDED_SCOPE_CATEGORIES_SCHEMA,
            description: 'Preflight scope categories where this custom advisory rule is active.'
        },
        included_changed_file_regexes: {
            ...OPTIONAL_QUALITY_CHECK_INCLUDED_CHANGED_FILE_REGEXES_SCHEMA,
            description: 'Changed-file regexes where this custom advisory rule is active.'
        },
        excluded_scope_categories: {
            ...OPTIONAL_QUALITY_CHECK_EXCLUDED_SCOPE_CATEGORIES_SCHEMA,
            description: 'Preflight scope categories where this custom advisory rule is skipped.'
        }
    },
    required: ['id', 'title', 'prompt'],
    additionalProperties: true
});

const OPTIONAL_QUALITY_CHECK_RULES_SCHEMA: Record<string, unknown> = Object.freeze({
    type: 'array',
    minItems: DEFAULT_OPTIONAL_QUALITY_CHECK_RULES.length,
    'x-case-insensitive-unique-item-properties': ['id'],
    description: 'Checklist rules shown to the agent before mandatory review/full-suite validation. Every shipped baseline rule must be present with managed id, title, and prompt; only enabled state is user-editable for baseline rules. Custom rules may define their own title, prompt, enabled state, and metadata.',
    allOf: DEFAULT_OPTIONAL_QUALITY_CHECK_RULES.map((rule) => ({
        type: 'array',
        contains: buildBaselineOptionalQualityCheckRuleSchema(rule)
    })),
    items: {
        anyOf: [
            ...BASELINE_OPTIONAL_QUALITY_CHECK_RULE_SCHEMAS,
            CUSTOM_OPTIONAL_QUALITY_CHECK_RULE_SCHEMA
        ]
    }
});

export const reviewCapabilitiesSchema: Record<string, unknown> = Object.freeze({
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: 'garda-agent-orchestrator/review-capabilities.schema.json',
    title: 'Review Capabilities',
    description: 'Toggles for mandatory and optional review types.',
    type: 'object',
    properties: Object.fromEntries(
        REVIEW_CAPABILITY_KEYS.map((key) => [key, { type: 'boolean', description: `Enable ${key} review.` }])
    ),
    required: [...REVIEW_CAPABILITY_KEYS],
    additionalProperties: {
        type: 'boolean',
        description: 'Catalog-backed custom review lanes remain disabled until explicitly set true.'
    }
});

export const tokenEconomySchema: Record<string, unknown> = Object.freeze({
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: 'garda-agent-orchestrator/token-economy.schema.json',
    title: 'Token Economy',
    description: 'Reviewer-context compaction and token-saving settings.',
    type: 'object',
    properties: {
        enabled:                 { type: 'boolean', description: 'Enable token economy.' },
        enabled_depths:          { type: 'array', items: { type: 'integer', minimum: 0 }, description: 'Depths at which compaction is active.' },
        strip_examples:          { type: 'boolean', description: 'Strip examples from reviewer context.' },
        strip_code_blocks:       { type: 'boolean', description: 'Strip code blocks from reviewer context.' },
        scoped_diffs:            { type: 'boolean', description: 'Generate scoped diffs for specialist reviewers.' },
        compact_reviewer_output: { type: 'boolean', description: 'Compact reviewer output.' },
        fail_tail_lines:         { type: 'integer', minimum: 1, description: 'Lines of failure tail to include.' }
    },
    required: [
        'enabled', 'enabled_depths', 'strip_examples', 'strip_code_blocks',
        'scoped_diffs', 'compact_reviewer_output', 'fail_tail_lines'
    ],
    additionalProperties: true
});

export const pathsSchema: Record<string, unknown> = Object.freeze({
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: 'garda-agent-orchestrator/paths.schema.json',
    title: 'Paths Configuration',
    description: 'Classification roots, trigger regexes, and runtime paths.',
    type: 'object',
    properties: {
        metrics_path:                { type: 'string', minLength: 1, description: 'Relative path for runtime metrics.' },
        ordinary_doc_paths:          { type: 'array', items: { type: 'string', minLength: 1 }, description: 'Relative file paths or globs for ordinary documents that may skip code/test review while still remaining auditable.' },
        runtime_roots:               { type: 'array', items: { type: 'string', minLength: 1 }, description: 'Root directories for runtime code.' },
        fast_path_roots:             { type: 'array', items: { type: 'string', minLength: 1 }, description: 'Root directories eligible for fast path.' },
        fast_path_allowed_regexes:   { type: 'array', items: { type: 'string', minLength: 1 }, description: 'Allowed file patterns for fast path.' },
        fast_path_sensitive_regexes: { type: 'array', items: { type: 'string', minLength: 1 }, description: 'Sensitive file patterns that block fast path.' },
        sql_or_migration_regexes:    { type: 'array', items: { type: 'string', minLength: 1 }, description: 'SQL/migration file patterns.' },
        test_refactor_changed_lines_threshold: { type: 'integer', minimum: 1, description: 'Changed-line threshold where test-only failed-review remediation also invalidates test-scoped refactor review.' },
        triggers: {
            type: 'object',
            description: 'Regex trigger patterns per review type.',
            additionalProperties: { type: 'array', items: { type: 'string', minLength: 1 } },
            minProperties: 1
        },
        code_like_regexes: { type: 'array', items: { type: 'string', minLength: 1 }, description: 'Patterns matching code-like file extensions.' }
    },
    required: ['metrics_path', 'runtime_roots', 'fast_path_roots', 'triggers'],
    additionalProperties: true
});

export const outputFiltersSchema: Record<string, unknown> = Object.freeze({
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: 'garda-agent-orchestrator/output-filters.schema.json',
    title: 'Output Filters',
    description: 'Gate output compression profiles, passthrough ceiling, and budget-adaptive tiers.',
    type: 'object',
    properties: {
        version: { type: 'integer', minimum: 1 },
        passthrough_ceiling: {
            type: 'object',
            properties: {
                max_lines: { type: 'integer', minimum: 1 },
                strategy:  { type: 'string', minLength: 1 }
            },
            required: ['max_lines', 'strategy']
        },
        budget_profiles: {
            type: 'object',
            description: 'Token-budget-based adaptive filtering tiers.',
            properties: {
                enabled: { type: 'boolean', description: 'Enable budget-adaptive filtering.' },
                tiers: {
                    type: 'array',
                    description: 'Ordered tiers; first tier whose max_tokens >= budget wins.',
                    items: {
                        type: 'object',
                        properties: {
                            label:                          { type: 'string', minLength: 1, description: 'Tier name (e.g. tight, moderate, generous).' },
                            max_tokens:                     { description: 'Upper token bound (positive integer); null = catch-all.' },
                            passthrough_ceiling_max_lines:  { type: 'integer', minimum: 1, description: 'Passthrough ceiling override.' },
                            fail_tail_lines:                { type: 'integer', minimum: 1, description: 'Failure tail lines override.' },
                            max_matches:                    { type: 'integer', minimum: 1, description: 'Parser max_matches override.' },
                            max_parser_lines:               { type: 'integer', minimum: 1, description: 'Parser max_lines override.' },
                            truncate_line_max_chars:         { type: 'integer', minimum: 1, description: 'Line truncation max_chars override.' }
                        },
                        required: ['label', 'max_tokens']
                    },
                    minItems: 1
                }
            },
            required: ['enabled', 'tiers']
        },
        profiles: {
            type: 'object',
            description: 'Named filter profiles.',
            additionalProperties: {
                type: 'object',
                properties: {
                    description:     { type: 'string', minLength: 1 },
                    emit_when_empty: { type: 'string' },
                    operations: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                type:        { type: 'string', minLength: 1 },
                                pattern:     { type: 'string' },
                                replacement: { type: 'string' },
                                suffix:      { type: 'string' },
                                max_chars:   { type: 'integer', minimum: 1 }
                            },
                            required: ['type']
                        }
                    },
                    parser: {
                        type: 'object',
                        properties: {
                            type:        { type: 'string', minLength: 1 },
                            max_matches: { type: 'integer', minimum: 1 },
                            max_lines:   { type: 'integer', minimum: 1 }
                        },
                        required: ['type']
                    }
                },
                required: ['description']
            },
            minProperties: 1
        }
    },
    required: ['version', 'profiles'],
    additionalProperties: true
});

export const skillPacksSchema: Record<string, unknown> = Object.freeze({
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: 'garda-agent-orchestrator/skill-packs.schema.json',
    title: 'Skill Packs',
    description: 'Installed optional specialist skill packs.',
    type: 'object',
    properties: {
        version:          { type: 'integer', minimum: 1 },
        installed_packs:  { type: 'array', items: { type: 'string', minLength: 1 }, uniqueItems: true }
    },
    required: ['version', 'installed_packs'],
    additionalProperties: false
});

export const optionalSkillSelectionPolicySchema: Record<string, unknown> = Object.freeze({
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: 'garda-agent-orchestrator/optional-skill-selection-policy.schema.json',
    title: 'Optional Skill Selection Policy',
    description: 'Repo-local policy controlling preprompt-time optional skill selection. Canonical modes are off, optional, and mandatory; legacy advisory/required/strict aliases remain read-compatible. Unknown local extension fields are preserved.',
    type: 'object',
    properties: {
        version: { type: 'integer', minimum: 1 },
        mode: {
            type: 'string',
            description: 'Canonical values are off, optional, and mandatory. Legacy advisory maps to optional; legacy required and strict map to mandatory.',
            enum: ['off', 'optional', 'mandatory', 'advisory', 'required', 'strict']
        }
    },
    required: ['version', 'mode'],
    additionalProperties: true
});

export const isolationModeSchema: Record<string, unknown> = Object.freeze({
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: 'garda-agent-orchestrator/isolation-mode.schema.json',
    title: 'Isolation Mode',
    description: 'Control-plane isolation and sandbox settings.',
    type: 'object',
    properties: {
        enabled:                             { type: 'boolean' },
        enforcement:                         { type: 'string', enum: ['STRICT', 'LOG_ONLY'] },
        require_manifest_match_before_task:  { type: 'boolean' },
        refuse_on_preflight_drift:           { type: 'boolean' },
        use_sandbox:                         { type: 'boolean' },
        same_user_limitation_notice:         { type: 'string' }
    },
    required: ['enabled', 'enforcement', 'require_manifest_match_before_task', 'refuse_on_preflight_drift', 'use_sandbox'],
    additionalProperties: false
});

export const REVIEW_ARTIFACT_RETENTION_MODES = ['none', 'summary', 'full'] as const;
export type ReviewArtifactRetentionMode = typeof REVIEW_ARTIFACT_RETENTION_MODES[number];

export const REVIEW_ARTIFACT_COMPRESSION_FORMATS = ['gzip'] as const;

export const reviewArtifactStorageSchema: Record<string, unknown> = Object.freeze({
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: 'garda-agent-orchestrator/review-artifact-storage.schema.json',
    title: 'Review Artifact Storage',
    description: 'Retention modes and compression policy for review artifacts. Mode "none" reduces forensic reproducibility; mode "summary" keeps gate receipts only; mode "full" preserves everything subject to age/count retention.',
    type: 'object',
    properties: {
        version:               { type: 'integer', minimum: 1 },
        retention_mode:        { type: 'string', enum: [...REVIEW_ARTIFACT_RETENTION_MODES], description: 'Artifact retention: none = delete non-receipt artifacts, summary = keep gate receipts only, full = keep all.' },
        compress_after_days:   { type: 'integer', minimum: 0, description: 'Compress artifacts older than N days. 0 disables compression.' },
        compression_format:    { type: 'string', enum: [...REVIEW_ARTIFACT_COMPRESSION_FORMATS], description: 'Compression format for old artifacts.' },
        preserve_gate_receipts: { type: 'boolean', description: 'When true, gate receipt artifacts are never deleted regardless of retention_mode.' },
        gate_receipt_suffixes: { type: 'array', items: { type: 'string', minLength: 1 }, description: 'File suffixes that identify gate receipt artifacts.' },
        privacy_notice:        { type: 'string', description: 'Operator-facing notice explaining privacy/disk tradeoffs.' }
    },
    required: ['version', 'retention_mode', 'compress_after_days', 'compression_format', 'preserve_gate_receipts', 'gate_receipt_suffixes'],
    additionalProperties: false
});

export const runtimeRetentionSchema: Record<string, unknown> = Object.freeze({
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: 'garda-agent-orchestrator/runtime-retention.schema.json',
    title: 'Runtime Retention Policy',
    description: 'Tiered retention defaults for active evidence, healthy DONE compaction, problem-task compression, purge safety, and future daily maintenance.',
    type: 'object',
    properties: {
        version: { type: 'integer', minimum: 1 },
        active_tasks: {
            type: 'object',
            properties: {
                protect_runtime_grace_days: { type: 'integer', minimum: 0 },
                protect_current_cycle_artifacts: { type: 'boolean' }
            },
            required: ['protect_runtime_grace_days', 'protect_current_cycle_artifacts'],
            additionalProperties: false
        },
        healthy_done: {
            type: 'object',
            properties: {
                compact_after_days: { type: 'integer', minimum: 0 },
                require_ledger: { type: 'boolean' },
                retain_task_events_until_ledger_verified: { type: 'boolean' }
            },
            required: ['compact_after_days', 'require_ledger', 'retain_task_events_until_ledger_verified'],
            additionalProperties: false
        },
        problem_tasks: {
            type: 'object',
            properties: {
                compress_after_days: { type: 'integer', minimum: 0 },
                preserve_detailed_evidence: { type: 'boolean' }
            },
            required: ['compress_after_days', 'preserve_detailed_evidence'],
            additionalProperties: false
        },
        purge: {
            type: 'object',
            properties: {
                require_confirm: { type: 'boolean' }
            },
            required: ['require_confirm'],
            additionalProperties: false
        },
        daily_maintenance: {
            type: 'object',
            properties: {
                enabled: { type: 'boolean' },
                max_tasks_per_run: { type: 'integer', minimum: 1 },
                eligible_older_than_days: { type: 'integer', minimum: 0 },
                keep_latest_tasks: { type: 'integer', minimum: 0 },
                dry_run: { type: 'boolean' }
            },
            required: ['enabled', 'max_tasks_per_run'],
            additionalProperties: false
        }
    },
    required: ['version', 'active_tasks', 'healthy_done', 'problem_tasks', 'purge', 'daily_maintenance'],
    additionalProperties: false
});

export const OUT_OF_SCOPE_FAILURE_POLICIES = Object.freeze([
    'AUDIT_AND_BLOCK',
    'AUDIT_AND_WARN'
] as const);

export type OutOfScopeFailurePolicy = typeof OUT_OF_SCOPE_FAILURE_POLICIES[number];

export const workflowConfigSchema: Record<string, unknown> = Object.freeze({
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: 'garda-agent-orchestrator/workflow-config.schema.json',
    title: 'Workflow Configuration',
    description: 'Optional workflow settings including compile-gate command selection, post-task full-suite validation, project-memory maintenance, and guarded task reset.',
    type: 'object',
    properties: {
        compile_gate: {
            type: 'object',
            description: 'Compile-gate validation command. When command is omitted or equals __COMPILE_GATE_COMMAND_UNCONFIGURED__, compile-gate fails closed instead of falling back to 40-commands.md.',
            properties: {
                command: { type: 'string', minLength: 1, description: 'Command to run for compile-gate validation.' }
            },
            required: ['command'],
            additionalProperties: false
        },
        full_suite_validation: {
            type: 'object',
            description: 'Full-suite validation (complete test run after task review).',
            properties: {
                enabled:                    { type: 'boolean', description: 'Enable full-suite validation.' },
                command:                    { type: 'string', minLength: 1, description: 'Command to run for full-suite validation.' },
                timeout_ms:                 { type: 'integer', minimum: 1000, description: 'Timeout in milliseconds.' },
                timeout_blocker:            { type: 'boolean', description: 'Block task progress after repeated full-suite timeout evidence instead of continuing with warning-only evidence.' },
                timeout_retry_count:        { type: 'integer', minimum: 0, maximum: FULL_SUITE_TIMEOUT_RETRY_COUNT_MAX, description: 'Number of same-scope full-suite timeout retries allowed before blocker handling applies.' },
                green_summary_max_lines:    { type: 'integer', minimum: 1, description: 'Max lines for pass summary.' },
                red_failure_chunk_lines:    { type: 'integer', minimum: 10, description: 'Chunk size for failure output.' },
                out_of_scope_failure_policy: { type: 'string', enum: [...OUT_OF_SCOPE_FAILURE_POLICIES], description: 'Policy for handling out-of-scope failures.' },
                placement: { type: 'string', enum: [...FULL_SUITE_VALIDATION_PLACEMENTS], description: 'Lifecycle point where enabled full-suite validation should run.' },
                out_of_scope_failure_policies: { type: 'array', items: { type: 'string', enum: [...OUT_OF_SCOPE_FAILURE_POLICIES] }, uniqueItems: true, description: 'Available failure policies.' }
            },
            required: ['enabled', 'command', 'timeout_ms', 'green_summary_max_lines', 'red_failure_chunk_lines', 'out_of_scope_failure_policy']
        },
        review_execution_policy: {
            type: 'object',
            description: 'Repo-local launch ordering policy for current-cycle review preparation and downstream dependency invalidation.',
            properties: {
                mode: {
                    type: 'string',
                    enum: [...REVIEW_EXECUTION_POLICY_MODES],
                    description: 'Review execution policy mode.'
                }
            },
            required: ['mode'],
            additionalProperties: false
        },
        review_delegation: {
            type: 'object',
            description: 'Fail-closed controls for delegated reviewer subagent launch availability.',
            properties: {
                no_delegate: {
                    type: 'boolean',
                    description: 'When true, mandatory reviewer delegation is disabled and task/review gates fail closed.'
                }
            },
            required: ['no_delegate'],
            additionalProperties: false
        },
        scope_budget_guard: {
            type: 'object',
            description: 'Configurable guard that blocks oversized task scopes before compile/review loops.',
            properties: {
                enabled: { type: 'boolean', description: 'Enable scope budget checks.' },
                profiles: {
                    type: 'array',
                    items: { type: 'string', minLength: 1 },
                    minItems: 1,
                    uniqueItems: true,
                    description: 'Profiles where the guard applies.'
                },
                action: {
                    type: 'string',
                    enum: ['BLOCK_FOR_SPLIT', 'WARN_ONLY'],
                    description: 'Action when any configured budget is exceeded.'
                },
                max_files: { type: 'integer', minimum: 1, description: 'Legacy changed-file threshold. WARN_ONLY maps it to warn_files; BLOCK_FOR_SPLIT maps it to block_files.' },
                max_changed_lines: { type: 'integer', minimum: 1, description: 'Legacy changed-line threshold. WARN_ONLY maps it to warn_changed_lines; BLOCK_FOR_SPLIT maps it to block_changed_lines.' },
                max_required_reviews: { type: 'integer', minimum: 1, description: 'Legacy required-review threshold. WARN_ONLY maps it to warn_required_reviews; BLOCK_FOR_SPLIT maps it to block_required_reviews.' },
                max_review_tokens: { type: 'integer', minimum: 1, description: 'Legacy review-token threshold. WARN_ONLY maps it to warn_review_tokens; BLOCK_FOR_SPLIT maps it to block_review_tokens.' },
                warn_files: { type: 'integer', minimum: 1, description: 'Changed-file warning threshold; must be lower than block_files.' },
                block_files: { type: 'integer', minimum: 1, description: 'Changed-file blocking threshold.' },
                warn_changed_lines: { type: 'integer', minimum: 1, description: 'Changed-line warning threshold; must be lower than block_changed_lines.' },
                block_changed_lines: { type: 'integer', minimum: 1, description: 'Changed-line blocking threshold.' },
                warn_required_reviews: { type: 'integer', minimum: 1, description: 'Required review type warning threshold; must be lower than block_required_reviews.' },
                block_required_reviews: { type: 'integer', minimum: 1, description: 'Required review type blocking threshold.' },
                warn_review_tokens: { type: 'integer', minimum: 1, description: 'Estimated review-token warning threshold; must be lower than block_review_tokens.' },
                block_review_tokens: { type: 'integer', minimum: 1, description: 'Estimated review-token blocking threshold.' }
            },
            required: [
                'enabled',
                'profiles',
                'action'
            ],
            additionalProperties: false
        },
        review_cycle_guard: {
            type: 'object',
            description: 'Configurable guard that blocks runaway non-test review cycles.',
            properties: {
                enabled: { type: 'boolean', description: 'Enable review-cycle checks.' },
                action: {
                    type: 'string',
                    enum: ['BLOCK_FOR_OPERATOR_DECISION', 'WARN_ONLY'],
                    description: 'Action when any configured review-cycle limit is exceeded.'
                },
                max_failed_non_test_reviews: { type: 'integer', minimum: 1, description: 'Maximum failed non-test review attempts before guard action.' },
                max_total_non_test_reviews: { type: 'integer', minimum: 1, description: 'Maximum total non-test review attempts before guard action.' },
                excluded_review_types: {
                    type: 'array',
                    items: { type: 'string', minLength: 1 },
                    minItems: 1,
                    uniqueItems: true,
                    description: 'Review types excluded from review-cycle counting.'
                },
                auto_split_enabled: {
                    type: 'boolean',
                    description: 'When true, next-step emits an auto-split instruction artifact instead of waiting for operator input after a review-cycle block.'
                }
            },
            required: ['enabled', 'action', 'max_failed_non_test_reviews', 'max_total_non_test_reviews', 'excluded_review_types'],
            additionalProperties: false
        },
        project_memory_maintenance: {
            type: 'object',
            description: 'Repo-local project-memory maintenance settings. Fresh workspaces default to update mode while explicit existing choices are preserved.',
            properties: {
                enabled: {
                    type: 'boolean',
                    description: 'Enable project-memory maintenance checks.'
                },
                mode: {
                    type: 'string',
                    enum: [...PROJECT_MEMORY_MAINTENANCE_MODES],
                    description: 'Maintenance mode: off, check, update, or strict.'
                },
                run_before_final_closeout: {
                    type: 'boolean',
                    description: 'Run memory impact checks before final closeout when supported by task flow.'
                },
                require_user_approval_for_writes: {
                    type: 'boolean',
                    description: 'Require explicit operator approval before agent writes user-owned memory files.'
                },
                max_compact_summary_chars: {
                    type: 'integer',
                    minimum: 2000,
                    description: 'Maximum allowed characters in project-memory/compact.md.'
                },
                read_strategy: {
                    type: 'string',
                    enum: [...PROJECT_MEMORY_READ_STRATEGIES],
                    description: 'Project-memory read strategy. The current strategy requires README.md, then compact.md, then focused files.'
                },
                impact_artifact_retention_days: {
                    type: 'integer',
                    minimum: 1,
                    description: 'Days to retain future project-memory impact artifacts.'
                }
            },
            required: [
                'enabled',
                'mode',
                'run_before_final_closeout',
                'require_user_approval_for_writes',
                'max_compact_summary_chars',
                'read_strategy',
                'impact_artifact_retention_days'
            ],
            additionalProperties: false
        },
        local_commit: {
            type: 'object',
            description: 'Workspace-bound local commit permission. False or omitted denies native commits; an explicit audited enablement is required for authority.',
            properties: {
                enabled: { type: 'boolean', description: 'Allow native local commits of completed and audited task scope.' }
            },
            required: ['enabled'],
            additionalProperties: false
        },
        task_reset: {
            type: 'object',
            description: 'Guarded task-reset availability. Real reset mutations are disabled by default and require audited repo-local opt-in.',
            properties: {
                enabled: {
                    type: 'boolean',
                    description: 'Enable confirmed task-reset mutations for this repository.'
                }
            },
            required: ['enabled'],
            additionalProperties: false
        },
        auto_backup: {
            type: 'object',
            description: 'Scheduled backup maintenance settings. Disabled by default and executed only through the daily maintenance trigger.',
            properties: {
                enabled: {
                    type: 'boolean',
                    description: 'Enable scheduled auto-backups.'
                },
                interval_days: {
                    type: 'integer',
                    minimum: 1,
                    description: 'Minimum number of days between successful scheduled backups.'
                },
                keep_latest: {
                    type: 'integer',
                    minimum: 1,
                    description: 'Number of latest backups to retain after scheduled backup creation.'
                }
            },
            required: ['enabled', 'interval_days', 'keep_latest'],
            additionalProperties: false
        },
        optional_quality_checks: {
            type: 'object',
            description: 'Advisory pre-review quality checklist settings. The mode is default-enabled but does not replace compile, review, or full-suite validation.',
            properties: {
                enabled: {
                    type: 'boolean',
                    description: 'Enable advisory optional quality checks.'
                },
                baseline_version: {
                    type: 'string',
                    minLength: 1,
                    description: 'Version id for the shipped baseline quality-check rule pack used by this config.'
                },
                review_failure_cadence_interval: {
                    type: 'integer',
                    minimum: 1,
                    maximum: MAX_OPTIONAL_QUALITY_CHECKS_REVIEW_FAILURE_CADENCE_INTERVAL,
                    default: DEFAULT_OPTIONAL_QUALITY_CHECKS_REVIEW_FAILURE_CADENCE_INTERVAL,
                    description: 'Number of recorded review-failure attempts between required quality-checklist answer runs. Omit to use 3.'
                },
                rules: {
                    ...OPTIONAL_QUALITY_CHECK_RULES_SCHEMA
                }
            },
            required: ['enabled'],
            additionalProperties: true
        },
        orchestrator_work_policy: {
            type: 'object',
            description: 'Workspace self-guard policy for agent-entered protected orchestrator work.',
            properties: {
                mode: {
                    type: 'string',
                    enum: ['deny_agent_entry', 'require_operator_confirmation'],
                    description: 'deny_agent_entry blocks agent self-escalation into --orchestrator-work; require_operator_confirmation preserves source-checkout confirmation behavior.'
                }
            },
            required: ['mode'],
            additionalProperties: false
        }
    },
    additionalProperties: true
});

const REVIEW_POLICY_VALUE = {
    description: 'Catalog review state: true = required, false = disabled, "auto" = optional and trigger-based.',
    oneOf: [
        { const: true, description: 'Required whenever the capability is enabled; built-in safety floors still apply.' },
        { const: false, description: 'Disabled by profile unless a mandatory built-in safety floor applies.' },
        { type: 'string', enum: ['auto'], description: 'Optional lane selected only by deterministic triggers.' }
    ]
} as const;

const REVIEW_FINDING_POLICY_ACTION = {
    type: 'string',
    enum: ['fix_now', 'create_follow_up', 'ignore'],
    description: 'Disposition action for a system-validated reviewer finding.'
} as const;

function reviewFindingPolicyPresetVariant(
    policyId: string,
    findings: { critical: string; high: string; medium: string; low: string },
    residualRisk: string
): Record<string, unknown> {
    return {
        type: 'object',
        properties: {
            policy_id: { const: policyId },
            findings: {
                type: 'object',
                properties: {
                    critical: { const: findings.critical },
                    high: { const: findings.high },
                    medium: { const: findings.medium },
                    low: { const: findings.low }
                },
                required: ['critical', 'high', 'medium', 'low']
            },
            residual_risk: { const: residualRisk }
        },
        required: ['policy_id', 'findings', 'residual_risk']
    };
}

const REVIEW_FINDING_POLICY_SCHEMA: Record<string, unknown> = Object.freeze({
    type: 'object',
    description: 'Profile-owned finding disposition policy. Missing legacy fields resolve fail-closed to strict at runtime.',
    properties: {
        schema_version: { type: 'integer', const: 1 },
        policy_id: {
            type: 'string',
            enum: ['soft', 'balanced', 'strict', 'custom'],
            description: 'Named built-in policy or custom policy marker.'
        },
        findings: {
            type: 'object',
            properties: {
                critical: { type: 'string', enum: ['fix_now'], description: 'Immutable critical safety floor.' },
                high: REVIEW_FINDING_POLICY_ACTION,
                medium: REVIEW_FINDING_POLICY_ACTION,
                low: REVIEW_FINDING_POLICY_ACTION
            },
            required: ['critical', 'high', 'medium', 'low'],
            additionalProperties: false
        },
        residual_risk: REVIEW_FINDING_POLICY_ACTION
    },
    required: ['schema_version', 'policy_id', 'findings', 'residual_risk'],
    anyOf: [
        reviewFindingPolicyPresetVariant('soft', {
            critical: 'fix_now',
            high: 'create_follow_up',
            medium: 'ignore',
            low: 'ignore'
        }, 'ignore'),
        reviewFindingPolicyPresetVariant('balanced', {
            critical: 'fix_now',
            high: 'fix_now',
            medium: 'fix_now',
            low: 'create_follow_up'
        }, 'create_follow_up'),
        reviewFindingPolicyPresetVariant('strict', {
            critical: 'fix_now',
            high: 'fix_now',
            medium: 'fix_now',
            low: 'fix_now'
        }, 'fix_now'),
        {
            type: 'object',
            properties: {
                policy_id: { const: 'custom' }
            },
            required: ['policy_id']
        }
    ],
    additionalProperties: false
});

function reviewRemediationModePolicySchemaVariant(
    schemaVersion: 1 | 2,
    eligibleReviewTypes: readonly string[],
    minEligibleReviewTypes: number
): Record<string, unknown> {
    return {
        type: 'object',
        properties: {
            schema_version: { type: 'integer', const: schemaVersion },
            policy_id: { type: 'string', const: 'conservative_review_remediation_mode_v1' },
            initial_review_mode: { type: 'string', const: 'FULL' },
            delta_eligible_review_types: {
                type: 'array',
                minItems: minEligibleReviewTypes,
                uniqueItems: true,
                items: schemaVersion === 1
                    ? { type: 'string', enum: [...eligibleReviewTypes] }
                    : { type: 'string', pattern: REVIEW_REMEDIATION_REVIEW_TYPE_ID_PATTERN }
            },
            force_full_categories: {
                type: 'array',
                minItems: 3,
                maxItems: 3,
                uniqueItems: true,
                items: { type: 'string', enum: ['ambiguous', 'generated_churn', 'global'] }
            },
            max_delta_changed_files: { type: 'integer', minimum: 1, maximum: 5 },
            max_delta_changed_lines: { type: 'integer', minimum: 1, maximum: 400 },
            max_consecutive_delta_reviews: { type: 'integer', minimum: 1, maximum: 3 }
        },
        required: [
            'schema_version',
            'policy_id',
            'initial_review_mode',
            'delta_eligible_review_types',
            'force_full_categories',
            'max_delta_changed_files',
            'max_delta_changed_lines',
            'max_consecutive_delta_reviews'
        ],
        additionalProperties: false
    };
}

const REVIEW_REMEDIATION_MODE_POLICY_SCHEMA: Record<string, unknown> = Object.freeze({
    description: 'Explicit conservative FULL/DELTA remediation policy. A missing policy preserves legacy FULL-only behavior.',
    oneOf: [
        reviewRemediationModePolicySchemaVariant(1, ['code', 'refactor', 'test'], 1),
        reviewRemediationModePolicySchemaVariant(2, [...REVIEW_CAPABILITY_KEYS].sort(), 0)
    ]
});

const PROFILE_ENTRY_SCHEMA: Record<string, unknown> = Object.freeze({
    type: 'object',
    description: 'A single workspace profile defining policy overlays.',
    properties: {
        description: { type: 'string', minLength: 1, description: 'Human-readable profile description.' },
        depth: { type: 'integer', minimum: 1, maximum: 3, description: 'Default task depth (1–3).' },
        task_decomposition: {
            type: 'object',
            description: 'Whether the task-start workflow asks for guarded decomposition before implementation.',
            properties: {
                enabled: { type: 'boolean' }
            },
            required: ['enabled'],
            additionalProperties: false
        },
        review_policy: {
            type: 'object',
            description: 'Catalog review states keyed by canonical review id. Unknown ids are rejected against review-catalog.json by profile validation.',
            properties: {
                code:     REVIEW_POLICY_VALUE,
                db:       REVIEW_POLICY_VALUE,
                security: REVIEW_POLICY_VALUE,
                refactor: REVIEW_POLICY_VALUE
            },
            additionalProperties: REVIEW_POLICY_VALUE
        },
        review_finding_policy: REVIEW_FINDING_POLICY_SCHEMA,
        review_remediation_mode_policy: REVIEW_REMEDIATION_MODE_POLICY_SCHEMA,
        review_follow_up_policy: {
            type: 'object',
            description: 'Deferred finding task materialization and child-profile policy.',
            properties: {
                schema_version: { type: 'integer', const: 1 },
                materialization_mode: { type: 'string', enum: ['per_finding', 'grouped_by_parent'] },
                task_profile: {
                    type: 'object',
                    oneOf: [
                        {
                            type: 'object',
                            properties: {
                                mode: { const: 'one_level_lighter' },
                                fixed_profile: { type: 'null' }
                            },
                            required: ['mode', 'fixed_profile'],
                            additionalProperties: false
                        },
                        {
                            type: 'object',
                            properties: {
                                mode: { const: 'inherit_parent' },
                                fixed_profile: { type: 'null' }
                            },
                            required: ['mode', 'fixed_profile'],
                            additionalProperties: false
                        },
                        {
                            type: 'object',
                            properties: {
                                mode: { const: 'fixed_profile' },
                                fixed_profile: { type: 'string', minLength: 1, maxLength: 64 }
                            },
                            required: ['mode', 'fixed_profile'],
                            additionalProperties: false
                        }
                    ]
                }
            },
            required: ['schema_version', 'materialization_mode'],
            additionalProperties: false
        },
        review_dependency_graph: {
            type: 'object',
            description: 'Optional per-profile review dependency DAG. Every active catalog lane must appear once in preparation_order.',
            properties: {
                preparation_order: {
                    type: 'array',
                    maxItems: 64,
                    uniqueItems: true,
                    items: { type: 'string', pattern: '^(?!full-suite-validation$)[a-z][a-z0-9-]*$' }
                },
                dependencies: {
                    type: 'object',
                    maxProperties: 64,
                    propertyNames: { pattern: '^(?!full-suite-validation$)[a-z][a-z0-9-]*$' },
                    additionalProperties: {
                        type: 'array',
                        maxItems: 64,
                        uniqueItems: true,
                        items: { type: 'string', pattern: '^(?!full-suite-validation$)[a-z][a-z0-9-]*$' }
                    }
                }
            },
            required: ['preparation_order', 'dependencies'],
            additionalProperties: false
        },
        token_economy: {
            type: 'object',
            description: 'Token economy overrides.',
            properties: {
                enabled:                 { type: 'boolean' },
                strip_examples:          { type: 'boolean' },
                strip_code_blocks:       { type: 'boolean' },
                scoped_diffs:            { type: 'boolean' },
                compact_reviewer_output: { type: 'boolean' }
            },
            additionalProperties: false
        },
        skills: {
            type: 'object',
            description: 'Skill behaviour overrides.',
            properties: {
                auto_suggest: { type: 'boolean', description: 'Whether to auto-suggest skill packs for this profile.' }
            },
            additionalProperties: false
        }
    },
    required: ['description', 'depth', 'review_policy', 'token_economy', 'skills'],
    additionalProperties: false
});

export const profilesSchema: Record<string, unknown> = Object.freeze({
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: 'garda-agent-orchestrator/profiles.schema.json',
    title: 'Workspace Profiles',
    description: 'Built-in and user-defined workspace profiles with an active-profile pointer.',
    type: 'object',
    properties: {
        version:          { type: 'integer', minimum: 1, description: 'Schema version.' },
        active_profile:   { type: 'string', minLength: 1, description: 'Name of the currently active profile.' },
        built_in_profiles: {
            type: 'object',
            description: 'Default built-in profiles shipped with the orchestrator. Protected from deletion by CLI commands.',
            additionalProperties: PROFILE_ENTRY_SCHEMA,
            minProperties: 1
        },
        user_profiles: {
            type: 'object',
            description: 'User-defined custom profiles.',
            additionalProperties: PROFILE_ENTRY_SCHEMA
        }
    },
    required: ['version', 'active_profile', 'built_in_profiles', 'user_profiles'],
    additionalProperties: false
});

const INIT_ANSWERS_BOOLEAN_LIKE = {
    type: 'string',
    description: 'Boolean-like value serialized as a string ("true" or "false").',
    enum: ['true', 'false']
} as const;

export const initAnswersSchema: Record<string, unknown> = Object.freeze({
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: 'garda-agent-orchestrator/init-answers.schema.json',
    title: 'Init Answers',
    description: 'Portable schema for the init-answers.json configuration collected during workspace initialization.',
    type: 'object',
    properties: {
        AssistantLanguage: { type: 'string', minLength: 1, description: 'Natural language for assistant responses (e.g. "English").' },
        AssistantBrevity:  { type: 'string', enum: [...BREVITY_VALUES], description: 'Response brevity preference.' },
        SourceOfTruth:     { type: 'string', enum: [...SOURCE_OF_TRUTH_VALUES], description: 'Selected agent provider whose entrypoint file is the canonical source of truth.' },
        EnforceNoAutoCommit:        { ...INIT_ANSWERS_BOOLEAN_LIKE },
        ClaudeOrchestratorFullAccess: { ...INIT_ANSWERS_BOOLEAN_LIKE },
        TokenEconomyEnabled:        { ...INIT_ANSWERS_BOOLEAN_LIKE },
        ProviderMinimalism:         { ...INIT_ANSWERS_BOOLEAN_LIKE, description: 'When true (default), materialize only the canonical active provider entrypoint; additional providers require explicit ActiveAgentFiles.' },
        CollectedVia:      { type: 'string', enum: [...COLLECTED_VIA_VALUES], description: 'How the answers were collected.' },
        ActiveAgentFiles:  { type: 'string', minLength: 1, description: 'Comma-separated list of active canonical agent entrypoint files.' }
    },
    required: [
        'AssistantLanguage', 'AssistantBrevity', 'SourceOfTruth',
        'EnforceNoAutoCommit', 'ClaudeOrchestratorFullAccess', 'TokenEconomyEnabled',
        'CollectedVia'
    ],
    additionalProperties: false
});

export const gardaConfigSchema: Record<string, unknown> = Object.freeze({
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: 'garda-agent-orchestrator/garda.config.schema.json',
    title: 'Garda Agent Orchestrator Configuration',
    description: 'Root configuration manifest referencing individual config files.',
    type: 'object',
    properties: {
        $schema: { type: 'string' },
        version: { type: 'integer', minimum: 1, description: 'Config schema version.' },
        configs: {
            type: 'object',
            description: 'Map from config name to relative path within the bundle config directory.',
            properties: {
                'review-capabilities': { type: 'string', minLength: 1 },
                'token-economy':       { type: 'string', minLength: 1 },
                paths:                 { type: 'string', minLength: 1 },
                'output-filters':      { type: 'string', minLength: 1 },
                'skill-packs':         { type: 'string', minLength: 1 },
                'optional-skill-selection-policy': { type: 'string', minLength: 1 },
                'isolation-mode':      { type: 'string', minLength: 1 },
                profiles:              { type: 'string', minLength: 1 },
                'review-artifact-storage': { type: 'string', minLength: 1 },
                'runtime-retention':   { type: 'string', minLength: 1 },
                'workflow-config':     { type: 'string', minLength: 1 }
            },
            required: [
                'review-capabilities', 'token-economy', 'paths',
                'output-filters', 'skill-packs', 'isolation-mode', 'profiles',
                'review-artifact-storage', 'runtime-retention'
            ],
            additionalProperties: false
        }
    },
    required: ['version', 'configs'],
    additionalProperties: true
});

export interface ConfigSchemaEntry {
    name: string;
    schema: Record<string, unknown>;
    fileName: string;
}

export const CONFIG_SCHEMAS: readonly ConfigSchemaEntry[] = Object.freeze([
    { name: 'review-capabilities', schema: reviewCapabilitiesSchema, fileName: 'review-capabilities.json' },
    { name: 'token-economy',       schema: tokenEconomySchema,       fileName: 'token-economy.json' },
    { name: 'paths',               schema: pathsSchema,              fileName: 'paths.json' },
    { name: 'output-filters',      schema: outputFiltersSchema,      fileName: 'output-filters.json' },
    { name: 'skill-packs',         schema: skillPacksSchema,         fileName: 'skill-packs.json' },
    { name: 'optional-skill-selection-policy', schema: optionalSkillSelectionPolicySchema, fileName: 'optional-skill-selection-policy.json' },
    { name: 'isolation-mode',      schema: isolationModeSchema,      fileName: 'isolation-mode.json' },
    { name: 'profiles',            schema: profilesSchema,           fileName: 'profiles.json' },
    { name: 'review-artifact-storage', schema: reviewArtifactStorageSchema, fileName: 'review-artifact-storage.json' },
    { name: 'runtime-retention',   schema: runtimeRetentionSchema,   fileName: 'runtime-retention.json' },
    { name: 'workflow-config',     schema: workflowConfigSchema,     fileName: 'workflow-config.json' }
]);

export const OPTIONAL_ROOT_CONFIG_NAMES = new Set<string>([
    'optional-skill-selection-policy',
    'workflow-config'
]);

export function getConfigSchemas(): readonly ConfigSchemaEntry[] {
    return CONFIG_SCHEMAS;
}

export function getConfigSchemaByName(name: string): ConfigSchemaEntry | undefined {
    return CONFIG_SCHEMAS.find((entry) => entry.name === name);
}
