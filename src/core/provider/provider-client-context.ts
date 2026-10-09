import { getProviderEntries } from './provider-registry';
import { getProviderClientCatalog } from './provider-client-catalog';

const CLIENT_SURFACES = ['cli', 'ide', 'desktop', 'cloud', 'unknown'] as const;
const EVIDENCE_STATES = ['unknown', 'unsupported', 'unavailable'] as const;
const MAX_TOKEN_LENGTH = 1024;
const MAX_GENERIC_RULE_PATHS = 32;
const GENERIC_CLIENT_ID = 'generic-cli';

export type ProviderClientSurface = typeof CLIENT_SURFACES[number];
export type ProviderClientEvidenceState = typeof EVIDENCE_STATES[number];
export type ProviderClientRefusalCode =
    | 'CLIENT_REQUIRED' | 'CLIENT_UNKNOWN'
    | 'HOST_CLIENT_REQUIRED' | 'HOST_CLIENT_UNKNOWN' | 'HOST_CLIENT_NOT_CONCRETE' | 'HOST_CLIENT_CONFLICT'
    | 'GENERIC_CLIENT_NAME_REQUIRED' | 'GENERIC_RULE_PATHS_REQUIRED'
    | 'NATIVE_LOADING_UNSUPPORTED' | 'NATIVE_LOADING_UNAVAILABLE'
    | 'REVIEWER_LAUNCH_UNSUPPORTED' | 'REVIEWER_LAUNCH_UNAVAILABLE';

export interface ProviderClientContextInput {
    readonly clientIdentity?: string | null;
    readonly hostClientIdentity?: string | null;
    readonly genericClientName?: string | null;
    readonly genericRulePaths?: readonly string[] | null;
    readonly surface?: ProviderClientSurface | null;
    readonly reportedVersion?: string | null;
    readonly modelProvider?: string | null;
    readonly modelId?: string | null;
    readonly sourceOfTruth?: string | null;
    readonly activeAgentFiles?: string | null;
    readonly nativeLoading?: ProviderClientEvidenceState | null;
    readonly reviewerLaunch?: ProviderClientEvidenceState | null;
}

export interface ProviderClientContext {
    readonly requestedProviderId: string | null;
    readonly clientId: string | null;
    readonly genericClient?: GenericClientDeclaration;
    readonly surface: ProviderClientSurface;
    readonly reportedVersion: string | null;
    readonly model: Readonly<{ provider: string | null; id: string | null }>;
    readonly instructions: Readonly<{ sourceOfTruth: string | null; activeAgentFiles: string | null }>;
    readonly evidence: Readonly<{ nativeLoading: ProviderClientEvidenceState; reviewerLaunch: ProviderClientEvidenceState }>;
    readonly status: 'unverified' | 'refused';
    readonly refusals: readonly ProviderClientRefusalCode[];
}

export interface GenericClientDeclaration {
    readonly name: string;
    readonly rulePaths: readonly string[];
}

export class ProviderClientContextInputError extends Error {
    constructor(readonly field: string, expected: string) {
        super(`Invalid provider client context field '${field}': expected ${expected}.`);
        this.name = 'ProviderClientContextInputError';
    }
}

interface ClientResolution {
    requestedProviderId: string | null;
    clientId: string | null;
    refusals: ProviderClientRefusalCode[];
    genericClient?: GenericClientDeclaration;
}

interface ClientIdentityDeclaration {
    readonly id: string;
    readonly requiresHostClient?: boolean;
}

const NATIVE_LOADING_REFUSALS: Readonly<Record<ProviderClientEvidenceState, readonly ProviderClientRefusalCode[]>> = {
    unknown: [], unsupported: ['NATIVE_LOADING_UNSUPPORTED'], unavailable: ['NATIVE_LOADING_UNAVAILABLE']
};
const REVIEWER_LAUNCH_REFUSALS: Readonly<Record<ProviderClientEvidenceState, readonly ProviderClientRefusalCode[]>> = {
    unknown: [], unsupported: ['REVIEWER_LAUNCH_UNSUPPORTED'], unavailable: ['REVIEWER_LAUNCH_UNAVAILABLE']
};

function requireInputRecord(input: unknown): Record<string, unknown> {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
        throw new ProviderClientContextInputError('input', 'a plain metadata object');
    }
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) {
        throw new ProviderClientContextInputError('input', 'a plain metadata object');
    }
    return input as Record<string, unknown>;
}

function readToken(input: Record<string, unknown>, field: string): string | null {
    return readTextToken(input[field], field);
}

function readTextToken(value: unknown, field: string): string | null {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string' || value.length > MAX_TOKEN_LENGTH || /[\u0000-\u001f\u007f]/.test(value)) {
        throw new ProviderClientContextInputError(field, `a string of at most ${MAX_TOKEN_LENGTH} characters without control characters`);
    }
    return value.trim() || null;
}

function readChoice<T extends string>(input: Record<string, unknown>, field: string, choices: readonly T[], fallback: T): T {
    const token = readToken(input, field)?.toLowerCase();
    if (!token) return fallback;
    const choice = choices.find((value) => value === token);
    if (!choice) throw new ProviderClientContextInputError(field, choices.join(', '));
    return choice;
}

function findExplicitClient(identity: string | null): ClientIdentityDeclaration | null {
    if (!identity) return null;
    const token = identity.toLowerCase();
    // Instruction-file and model aliases are deliberately excluded from client identity.
    const legacy = getProviderEntries().find((entry) => (
        [entry.id, entry.displayLabel, entry.reviewerLaunchLabel].some((value) => value?.toLowerCase() === token)
    )) ?? null;
    if (legacy) return legacy;
    const declared = getProviderClientCatalog().find(entry => (
        [entry.desktopId, entry.clientId, entry.displayLabel].some(value => value.toLowerCase() === token)
    ));
    return declared ? { id: declared.clientId } : null;
}

function readGenericRulePaths(record: Record<string, unknown>): readonly string[] {
    const value = record.genericRulePaths;
    if (value === undefined || value === null) return Object.freeze([]);
    if (!Array.isArray(value) || value.length > MAX_GENERIC_RULE_PATHS) {
        throw new ProviderClientContextInputError('genericRulePaths', `an array of at most ${MAX_GENERIC_RULE_PATHS} path strings`);
    }
    const paths = Array.from(value, (entry: unknown, index: number) => {
        const field = `genericRulePaths[${index}]`;
        const token = readTextToken(entry, field);
        if (!token) throw new ProviderClientContextInputError(field, 'a nonempty path string');
        return token;
    });
    return Object.freeze([...new Set(paths)]);
}

function resolveGenericDeclaration(resolution: ClientResolution, record: Record<string, unknown>): ClientResolution {
    if (resolution.clientId !== GENERIC_CLIENT_ID && resolution.requestedProviderId !== GENERIC_CLIENT_ID) return resolution;
    const name = readToken(record, 'genericClientName'), rulePaths = readGenericRulePaths(record);
    if (!name || !rulePaths.length) {
        const refusals = [...resolution.refusals];
        if (!name) refusals.push('GENERIC_CLIENT_NAME_REQUIRED');
        if (!rulePaths.length) refusals.push('GENERIC_RULE_PATHS_REQUIRED');
        return { ...resolution, clientId: null, refusals };
    }
    if (resolution.clientId !== GENERIC_CLIENT_ID) return resolution;
    return { ...resolution, genericClient: Object.freeze({ name, rulePaths }) };
}

function resolveClient(identity: string | null, hostIdentity: string | null): ClientResolution {
    const requested = findExplicitClient(identity);
    if (!requested) {
        return { requestedProviderId: null, clientId: null, refusals: [identity ? 'CLIENT_UNKNOWN' : 'CLIENT_REQUIRED'] };
    }
    const result: ClientResolution = { requestedProviderId: requested.id, clientId: null, refusals: [] };
    const host = findExplicitClient(hostIdentity);
    if (requested.requiresHostClient) {
        if (!hostIdentity) result.refusals.push('HOST_CLIENT_REQUIRED');
        else if (!host) result.refusals.push('HOST_CLIENT_UNKNOWN');
        else if (host.requiresHostClient) result.refusals.push('HOST_CLIENT_NOT_CONCRETE');
        else result.clientId = host.id;
    } else if (hostIdentity && host?.id !== requested.id) {
        result.refusals.push('HOST_CLIENT_CONFLICT');
    } else {
        result.clientId = requested.id;
    }
    return result;
}

/** Pure metadata resolution only: this API never authenticates native loading or reviewer launch. */
export function resolveProviderClientContext(input: unknown): ProviderClientContext {
    const record = requireInputRecord(input);
    const resolution = resolveGenericDeclaration(resolveClient(readToken(record, 'clientIdentity'), readToken(record, 'hostClientIdentity')), record);
    const surface = readChoice(record, 'surface', CLIENT_SURFACES, 'unknown');
    const nativeLoading = readChoice(record, 'nativeLoading', EVIDENCE_STATES, 'unknown');
    const reviewerLaunch = readChoice(record, 'reviewerLaunch', EVIDENCE_STATES, 'unknown');
    const refusals = [...resolution.refusals, ...NATIVE_LOADING_REFUSALS[nativeLoading], ...REVIEWER_LAUNCH_REFUSALS[reviewerLaunch]];
    return Object.freeze({
        requestedProviderId: resolution.requestedProviderId, clientId: resolution.clientId, surface,
        ...(resolution.genericClient ? { genericClient: resolution.genericClient } : {}),
        reportedVersion: readToken(record, 'reportedVersion'),
        model: Object.freeze({ provider: readToken(record, 'modelProvider'), id: readToken(record, 'modelId') }),
        instructions: Object.freeze({ sourceOfTruth: readToken(record, 'sourceOfTruth'), activeAgentFiles: readToken(record, 'activeAgentFiles') }),
        evidence: Object.freeze({ nativeLoading, reviewerLaunch }),
        status: refusals.length ? 'refused' : 'unverified',
        refusals: Object.freeze(refusals)
    });
}
