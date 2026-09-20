import * as fs from 'node:fs';
import * as path from 'node:path';
import { assertWorkflowTransactionReadable } from './workflow-transaction-state';

import { normalizeBooleanLike, normalizeInteger } from '../schemas/shared';
import { UNCONFIGURED_FULL_SUITE_VALIDATION_COMMAND } from './constants';
import { joinOrchestratorPath } from './orchestrator-paths';
import {
    FULL_SUITE_TIMEOUT_RETRY_COUNT_MAX,
    normalizeFullSuiteValidationPlacement,
    type FullSuiteValidationPlacement
} from './workflow-config';

export const OUT_OF_SCOPE_FAILURE_POLICIES = Object.freeze([
    'AUDIT_AND_BLOCK',
    'AUDIT_AND_WARN'
] as const);

export type OutOfScopeFailurePolicy = (typeof OUT_OF_SCOPE_FAILURE_POLICIES)[number];

export interface FullSuiteValidationConfig {
    readonly enabled: boolean;
    readonly command: string;
    readonly timeout_ms: number;
    readonly timeout_blocker?: boolean;
    readonly timeout_retry_count?: number;
    readonly green_summary_max_lines: number;
    readonly red_failure_chunk_lines: number;
    readonly out_of_scope_failure_policy: OutOfScopeFailurePolicy;
    readonly placement: FullSuiteValidationPlacement;
}

export const DEFAULT_FULL_SUITE_VALIDATION_CONFIG: FullSuiteValidationConfig = Object.freeze({
    enabled: false,
    command: UNCONFIGURED_FULL_SUITE_VALIDATION_COMMAND,
    timeout_ms: 900_000,
    timeout_blocker: true,
    timeout_retry_count: 1,
    green_summary_max_lines: 5,
    red_failure_chunk_lines: 50,
    out_of_scope_failure_policy: 'AUDIT_AND_BLOCK',
    placement: 'after_compile_before_reviews'
});

export function resolveWorkflowConfigPath(repoRoot: string): string {
    return joinOrchestratorPath(repoRoot, path.join('live', 'config', 'workflow-config.json'));
}

export function loadFullSuiteValidationConfig(repoRoot: string): FullSuiteValidationConfig {
    const configPath = resolveWorkflowConfigPath(repoRoot);
    assertWorkflowTransactionReadable(path.dirname(path.dirname(path.dirname(configPath))));
    if (!fs.existsSync(configPath) || !fs.statSync(configPath).isFile()) {
        return { ...DEFAULT_FULL_SUITE_VALIDATION_CONFIG };
    }

    let raw: unknown;
    try {
        raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch {
        return { ...DEFAULT_FULL_SUITE_VALIDATION_CONFIG };
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return { ...DEFAULT_FULL_SUITE_VALIDATION_CONFIG };
    }
    const config = raw as Record<string, unknown>;
    const section = config.full_suite_validation;
    if (!section || typeof section !== 'object' || Array.isArray(section)) {
        return { ...DEFAULT_FULL_SUITE_VALIDATION_CONFIG };
    }
    const record = section as Record<string, unknown>;
    return {
        enabled: record.enabled === true,
        command: typeof record.command === 'string' && record.command.trim()
            ? record.command.trim()
            : DEFAULT_FULL_SUITE_VALIDATION_CONFIG.command,
        timeout_ms: typeof record.timeout_ms === 'number' && record.timeout_ms > 0
            ? record.timeout_ms
            : DEFAULT_FULL_SUITE_VALIDATION_CONFIG.timeout_ms,
        timeout_blocker: normalizeBooleanLikeOrDefault(
            record.timeout_blocker,
            'workflow-config.full_suite_validation.timeout_blocker',
            DEFAULT_FULL_SUITE_VALIDATION_CONFIG.timeout_blocker ?? true
        ),
        timeout_retry_count: normalizeIntegerOrDefault(
            record.timeout_retry_count,
            'workflow-config.full_suite_validation.timeout_retry_count',
            DEFAULT_FULL_SUITE_VALIDATION_CONFIG.timeout_retry_count ?? 1,
            { minimum: 0, maximum: FULL_SUITE_TIMEOUT_RETRY_COUNT_MAX }
        ),
        green_summary_max_lines: typeof record.green_summary_max_lines === 'number' && record.green_summary_max_lines > 0
            ? record.green_summary_max_lines
            : DEFAULT_FULL_SUITE_VALIDATION_CONFIG.green_summary_max_lines,
        red_failure_chunk_lines: typeof record.red_failure_chunk_lines === 'number' && record.red_failure_chunk_lines > 0
            ? record.red_failure_chunk_lines
            : DEFAULT_FULL_SUITE_VALIDATION_CONFIG.red_failure_chunk_lines,
        out_of_scope_failure_policy: normalizeOutOfScopePolicy(record.out_of_scope_failure_policy),
        placement: normalizeFullSuiteValidationPlacement(record.placement, {
            rejectInvalidExplicit: true,
            errorPath: 'workflow-config.full_suite_validation.placement'
        })
    };
}

function normalizeBooleanLikeOrDefault(value: unknown, fieldName: string, fallback: boolean): boolean {
    if (value === undefined) {
        return fallback;
    }
    try {
        return normalizeBooleanLike(value, fieldName);
    } catch {
        return fallback;
    }
}

function normalizeIntegerOrDefault(
    value: unknown,
    fieldName: string,
    fallback: number,
    options: { readonly minimum?: number; readonly maximum?: number } = {}
): number {
    if (value === undefined) {
        return fallback;
    }
    try {
        return normalizeInteger(value, fieldName, options);
    } catch {
        return fallback;
    }
}

function normalizeOutOfScopePolicy(value: unknown): OutOfScopeFailurePolicy {
    const normalized = String(value || '').trim().toUpperCase().replace(/[\s-]+/g, '_');
    if (OUT_OF_SCOPE_FAILURE_POLICIES.includes(normalized as OutOfScopeFailurePolicy)) {
        return normalized as OutOfScopeFailurePolicy;
    }
    return 'AUDIT_AND_BLOCK';
}
