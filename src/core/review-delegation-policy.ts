import * as path from 'node:path';

import { resolveBundleName } from './constants';
import { cloneJsonValue, isPlainObject } from './config-merge';
import { pathExists } from './filesystem';
import { readJsonFile } from './json';
import { assertWorkflowTransactionReadable } from './workflow-transaction-state';

export const GARDA_NO_DELEGATE_ENV = 'GARDA_NO_DELEGATE';

const TRUE_TOKENS = new Set(['1', 'true', 'yes', 'y', 'on']);
const FALSE_TOKENS = new Set(['0', 'false', 'no', 'n', 'off']);

export type ReviewDelegationPolicySource = 'env' | 'config' | 'none';

export interface ReviewDelegationConfig {
    no_delegate: boolean;
    [key: string]: unknown;
}

export interface ReviewDelegationPolicyResult {
    active: boolean;
    source: ReviewDelegationPolicySource;
    env_var: typeof GARDA_NO_DELEGATE_ENV;
    config_path: string | null;
    reason: string | null;
    remediation: string | null;
}

export const DEFAULT_REVIEW_DELEGATION_CONFIG: ReviewDelegationConfig = Object.freeze({
    no_delegate: false
});

export function normalizeReviewDelegationConfig(input: unknown): ReviewDelegationConfig {
    if (!isPlainObject(input)) {
        return cloneJsonValue(DEFAULT_REVIEW_DELEGATION_CONFIG);
    }
    return {
        ...cloneJsonValue(input),
        no_delegate: parseBooleanLike(input.no_delegate) === true
    };
}

export function isTruthyNoDelegateEnvValue(value: unknown): boolean {
    return TRUE_TOKENS.has(String(value ?? '').trim().toLowerCase());
}

export function resolveReviewDelegationConfigPath(repoRoot: string): string {
    return path.join(path.resolve(repoRoot), resolveBundleName(), 'live', 'config', 'workflow-config.json');
}

function parseBooleanLike(value: unknown): boolean | null {
    if (typeof value === 'boolean') {
        return value;
    }
    if (typeof value === 'number' && Number.isInteger(value) && (value === 0 || value === 1)) {
        return value === 1;
    }
    const normalized = String(value ?? '').trim().toLowerCase();
    if (TRUE_TOKENS.has(normalized)) {
        return true;
    }
    if (FALSE_TOKENS.has(normalized)) {
        return false;
    }
    return null;
}

type WorkflowConfigReadResult =
    | { status: 'ok'; value: Record<string, unknown> }
    | { status: 'missing' }
    | { status: 'invalid'; reason: string };

function readWorkflowConfigObject(configPath: string): WorkflowConfigReadResult {
    assertWorkflowTransactionReadable(path.dirname(path.dirname(path.dirname(configPath))));
    if (!pathExists(configPath)) {
        return { status: 'missing' };
    }
    try {
        const parsed = readJsonFile(configPath);
        if (!isPlainObject(parsed)) {
            return {
                status: 'invalid',
                reason: 'workflow-config.json must be a JSON object'
            };
        }
        return { status: 'ok', value: parsed };
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return {
            status: 'invalid',
            reason: `workflow-config.json could not be parsed: ${message}`
        };
    }
}

function workflowConfigInputResult(input: unknown): WorkflowConfigReadResult {
    if (isPlainObject(input)) {
        return { status: 'ok', value: input };
    }
    return {
        status: 'invalid',
        reason: 'provided workflow config must be a JSON object'
    };
}

function failClosedConfigPolicy(configPath: string, reason: string): ReviewDelegationPolicyResult {
    return {
        active: true,
        source: 'config',
        env_var: GARDA_NO_DELEGATE_ENV,
        config_path: configPath,
        reason: `workflow-config review delegation policy is unavailable or invalid (${reason}); delegated reviewer subagent launches are disabled fail-closed.`,
        remediation: 'Repair workflow-config.json through the audited workflow configuration path before starting mandatory review workflows.'
    };
}

function findCaseMismatchedReviewDelegationKey(workflowConfig: Record<string, unknown>): string | null {
    return Object.keys(workflowConfig).find((key) => (
        key.toLowerCase() === 'review_delegation'
        && key !== 'review_delegation'
    )) || null;
}

function resolveConfigNoDelegate(workflowConfig: Record<string, unknown>): { noDelegate: boolean; invalidReason: string | null } {
    const caseMismatchedKey = findCaseMismatchedReviewDelegationKey(workflowConfig);
    if (caseMismatchedKey) {
        return {
            noDelegate: true,
            invalidReason: `workflow-config.${caseMismatchedKey} must use canonical key review_delegation`
        };
    }
    const section = workflowConfig.review_delegation;
    if (section === undefined) {
        return { noDelegate: false, invalidReason: null };
    }
    if (!isPlainObject(section)) {
        return {
            noDelegate: true,
            invalidReason: 'workflow-config.review_delegation must be an object'
        };
    }
    for (const key of Object.keys(section)) {
        if (key.toLowerCase() === 'no_delegate' && key !== 'no_delegate') {
            return {
                noDelegate: true,
                invalidReason: `workflow-config.review_delegation.${key} must use canonical key no_delegate`
            };
        }
        if (key !== 'no_delegate') {
            return {
                noDelegate: true,
                invalidReason: `workflow-config.review_delegation has unknown key ${key}`
            };
        }
    }
    if (!Object.prototype.hasOwnProperty.call(section, 'no_delegate')) {
        return { noDelegate: false, invalidReason: null };
    }
    const noDelegate = parseBooleanLike(section.no_delegate);
    if (noDelegate === null) {
        return {
            noDelegate: true,
            invalidReason: 'workflow-config.review_delegation.no_delegate must be boolean-like'
        };
    }
    return { noDelegate, invalidReason: null };
}

export function resolveReviewDelegationPolicy(options: {
    repoRoot: string;
    env?: NodeJS.ProcessEnv;
    workflowConfig?: Record<string, unknown> | null;
}): ReviewDelegationPolicyResult {
    const repoRoot = path.resolve(options.repoRoot);
    const env = options.env ?? process.env;
    const configPath = resolveReviewDelegationConfigPath(repoRoot);

    if (isTruthyNoDelegateEnvValue(env[GARDA_NO_DELEGATE_ENV])) {
        return {
            active: true,
            source: 'env',
            env_var: GARDA_NO_DELEGATE_ENV,
            config_path: configPath,
            reason: `${GARDA_NO_DELEGATE_ENV} is active; delegated reviewer subagent launches are disabled for this process.`,
            remediation: `Unset ${GARDA_NO_DELEGATE_ENV} or set it to 0/false before starting mandatory review workflows.`
        };
    }

    const workflowConfigResult = options.workflowConfig === undefined
        ? readWorkflowConfigObject(configPath)
        : workflowConfigInputResult(options.workflowConfig);
    if (workflowConfigResult.status === 'invalid') {
        return failClosedConfigPolicy(configPath, workflowConfigResult.reason);
    }
    if (workflowConfigResult.status === 'missing') {
        return {
            active: false,
            source: 'none',
            env_var: GARDA_NO_DELEGATE_ENV,
            config_path: configPath,
            reason: null,
            remediation: null
        };
    }

    const configNoDelegate = resolveConfigNoDelegate(workflowConfigResult.value);
    if (configNoDelegate.invalidReason) {
        return failClosedConfigPolicy(configPath, configNoDelegate.invalidReason);
    }
    if (configNoDelegate.noDelegate === true) {
        return {
            active: true,
            source: 'config',
            env_var: GARDA_NO_DELEGATE_ENV,
            config_path: configPath,
            reason: `workflow-config review_delegation.no_delegate is true; delegated reviewer subagent launches are disabled for this workspace.`,
            remediation: 'Set review_delegation.no_delegate=false through the audited workflow configuration path before starting mandatory review workflows.'
        };
    }

    return {
        active: false,
        source: 'none',
        env_var: GARDA_NO_DELEGATE_ENV,
        config_path: configPath,
        reason: null,
        remediation: null
    };
}
