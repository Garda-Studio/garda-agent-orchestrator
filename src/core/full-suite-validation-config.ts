import * as fs from 'node:fs';
import * as path from 'node:path';
import { assertWorkflowTransactionReadable } from './workflow-transaction-state';
import { parseValidationReportFiles, type ValidationReportFile } from './validation-report-contract';

import { ensurePlainObject, normalizeBooleanLike, normalizeInteger } from '../schemas/shared';
import {
    isRecognizedBundleName,
    UNCONFIGURED_FULL_SUITE_VALIDATION_COMMAND
} from './constants';
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
    readonly report_files?: ValidationReportFile[];
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
    const configPath = joinOrchestratorPath(repoRoot, path.join('live', 'config', 'workflow-config.json'));
    return resolveReadableWorkflowConfigPath(repoRoot, configPath);
}

export function loadFullSuiteValidationConfig(repoRoot: string): FullSuiteValidationConfig {
    const configPath = resolveWorkflowConfigPath(repoRoot);
    assertWorkflowTransactionReadable(path.dirname(path.dirname(path.dirname(configPath))));
    const config = readWorkflowConfig(configPath);
    if (config?.full_suite_validation === undefined) {
        return { ...DEFAULT_FULL_SUITE_VALIDATION_CONFIG };
    }
    return normalizeFullSuiteConfig(ensurePlainObject(
        config.full_suite_validation,
        'workflow-config.full_suite_validation'
    ));
}

function readWorkflowConfig(configPath: string): Record<string, unknown> | undefined {
    let fileInfo: fs.Stats;
    try {
        fileInfo = fs.lstatSync(configPath);
    } catch (error) {
        if (isMissingPathError(error)) {
            assertConfigAncestorsReadable(configPath);
            return undefined;
        }
        throw new Error('workflow-config cannot be read as a regular file.');
    }
    let contents: string;
    try {
        if (!(fileInfo.isSymbolicLink() ? fs.statSync(configPath) : fileInfo).isFile()) {
            throw new Error('Not a regular file.');
        }
        contents = fs.readFileSync(configPath, 'utf8');
    } catch {
        throw new Error('workflow-config cannot be read as a regular file.');
    }
    let raw: unknown;
    try {
        raw = JSON.parse(contents);
    } catch {
        throw new Error('workflow-config contains invalid JSON.');
    }
    return ensurePlainObject(raw, 'workflow-config');
}

function resolveReadableWorkflowConfigPath(repoRoot: string, configPath: string): string {
    if (configPath !== path.resolve(repoRoot, 'live', 'config', 'workflow-config.json')) {
        return configPath;
    }
    if (fs.existsSync(path.resolve(repoRoot, 'MANIFEST.md')) && fs.existsSync(path.resolve(repoRoot, 'VERSION'))) {
        return configPath;
    }
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(repoRoot, { withFileTypes: true });
    } catch (error) {
        if (isMissingPathError(error)) {
            assertConfigAncestorsReadable(configPath);
            return configPath;
        }
        throw new Error('workflow-config cannot be read as a regular file.');
    }
    const candidates: string[] = [];
    for (const entry of entries) {
        if (isRecognizedBundleName(entry.name)) {
            const candidatePath = path.resolve(repoRoot, entry.name, 'live', 'config', 'workflow-config.json');
            assertConfigAncestorsReadable(candidatePath);
            candidates.push(candidatePath);
        }
    }
    if (candidates.length > 1) {
        throw new Error('workflow-config deployed bundle path is ambiguous.');
    }
    return candidates[0] ?? configPath;
}

function isMissingPathError(error: unknown): boolean {
    return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function assertConfigAncestorsReadable(configPath: string): void {
    let ancestor = path.dirname(configPath);
    while (true) {
        let fileInfo: fs.Stats;
        try {
            fileInfo = fs.lstatSync(ancestor);
        } catch (error) {
            const parent = path.dirname(ancestor);
            if (!isMissingPathError(error) || parent === ancestor) {
                throw new Error('workflow-config cannot be read as a regular file.');
            }
            ancestor = parent;
            continue;
        }
        try {
            if (!(fileInfo.isSymbolicLink() ? fs.statSync(ancestor) : fileInfo).isDirectory()) {
                throw new Error('Not a directory.');
            }
        } catch {
            throw new Error('workflow-config cannot be read as a regular file.');
        }
        return;
    }
}

function normalizeFullSuiteConfig(record: Record<string, unknown>): FullSuiteValidationConfig {
    const defaults = DEFAULT_FULL_SUITE_VALIDATION_CONFIG;
    const field = (name: string): string => `workflow-config.full_suite_validation.${name}`;
    return {
        enabled: normalizeBooleanLikeOrDefault(record.enabled, field('enabled'), defaults.enabled),
        command: normalizeCommand(record.command),
        ...(record.report_files !== undefined ? { report_files: parseValidationReportFiles(record.report_files) } : {}),
        timeout_ms: normalizeIntegerOrDefault(record.timeout_ms, field('timeout_ms'), defaults.timeout_ms, { minimum: 1 }),
        timeout_blocker: normalizeBooleanLikeOrDefault(
            record.timeout_blocker, field('timeout_blocker'), defaults.timeout_blocker ?? true
        ),
        timeout_retry_count: normalizeIntegerOrDefault(
            record.timeout_retry_count, field('timeout_retry_count'), defaults.timeout_retry_count ?? 1,
            { minimum: 0, maximum: FULL_SUITE_TIMEOUT_RETRY_COUNT_MAX }
        ),
        green_summary_max_lines: normalizeIntegerOrDefault(
            record.green_summary_max_lines, field('green_summary_max_lines'), defaults.green_summary_max_lines, { minimum: 1 }
        ),
        red_failure_chunk_lines: normalizeIntegerOrDefault(
            record.red_failure_chunk_lines, field('red_failure_chunk_lines'), defaults.red_failure_chunk_lines, { minimum: 1 }
        ),
        out_of_scope_failure_policy: normalizeOutOfScopePolicy(record.out_of_scope_failure_policy),
        placement: normalizePlacement(record.placement)
    };
}

function normalizeBooleanLikeOrDefault(value: unknown, fieldName: string, fallback: boolean): boolean {
    if (value === undefined) {
        return fallback;
    }
    if (!['boolean', 'number', 'string'].includes(typeof value)) {
        throw new Error(`${fieldName} must be boolean-like.`);
    }
    return normalizeBooleanLike(value, fieldName);
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
    if (typeof value !== 'number' && typeof value !== 'string') {
        throw new Error(`${fieldName} must be an integer.`);
    }
    return normalizeInteger(value, fieldName, { maximum: Number.MAX_SAFE_INTEGER, ...options });
}

function normalizeCommand(value: unknown): string {
    if (value === undefined) {
        return DEFAULT_FULL_SUITE_VALIDATION_CONFIG.command;
    }
    if (typeof value !== 'string' || !value.trim()) {
        throw new Error('workflow-config.full_suite_validation.command must be a non-empty string.');
    }
    return value.trim();
}

function normalizePlacement(value: unknown): FullSuiteValidationPlacement {
    if (value !== undefined && typeof value !== 'string') {
        throw new Error('workflow-config.full_suite_validation.placement must be a string.');
    }
    return normalizeFullSuiteValidationPlacement(value, {
        rejectInvalidExplicit: true,
        errorPath: 'workflow-config.full_suite_validation.placement'
    });
}

function normalizeOutOfScopePolicy(value: unknown): OutOfScopeFailurePolicy {
    if (value === undefined) {
        return DEFAULT_FULL_SUITE_VALIDATION_CONFIG.out_of_scope_failure_policy;
    }
    const normalized = typeof value === 'string' ? value.trim().toUpperCase().replace(/[\s-]+/g, '_') : '';
    if (OUT_OF_SCOPE_FAILURE_POLICIES.includes(normalized as OutOfScopeFailurePolicy)) {
        return normalized as OutOfScopeFailurePolicy;
    }
    throw new Error('workflow-config.full_suite_validation.out_of_scope_failure_policy must be AUDIT_AND_BLOCK or AUDIT_AND_WARN.');
}
