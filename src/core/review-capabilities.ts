import * as fs from 'node:fs';
import * as path from 'node:path';
import { readInvocationPathObservation } from './invocation-file-observation';
import { createInvocationReadMemoKey, memoizeInvocationRead } from './invocation-read-observation';

const SKILL_ENTRYPOINT_FILES = createInvocationReadMemoKey<boolean>('review-skill-entrypoint-files');

export const REVIEW_CAPABILITY_KEYS = Object.freeze([
    'code',
    'db',
    'security',
    'refactor',
    'api',
    'test',
    'performance',
    'infra',
    'dependency'
] as const);

export const OPTIONAL_REVIEW_CAPABILITY_KEYS = Object.freeze([
    'api',
    'test',
    'performance',
    'infra',
    'dependency'
] as const);

export type ReviewCapabilityKey = (typeof REVIEW_CAPABILITY_KEYS)[number];
export type OptionalReviewCapabilityKey = (typeof OPTIONAL_REVIEW_CAPABILITY_KEYS)[number];
export type ReviewCapabilities = Record<ReviewCapabilityKey, boolean>;
export type ReviewCapabilitiesConfigMap = ReviewCapabilities & Record<string, boolean>;

interface OptionalReviewCapabilityDefinition {
    label: string;
    candidateSkillIds: readonly string[];
    githubBridgeRelativePath: string;
}

const REVIEW_CAPABILITY_DEFAULTS: Readonly<ReviewCapabilities> = Object.freeze({
    code: true,
    db: true,
    security: true,
    refactor: true,
    api: true,
    test: true,
    performance: true,
    infra: true,
    dependency: true
});

const REVIEW_SKILL_CANDIDATES: Readonly<Record<string, readonly string[]>> = Object.freeze({
    code: ['code-review'],
    db: ['db-review'],
    security: ['security-review'],
    refactor: ['refactor-review'],
    api: ['api-review', 'api-contract-review'],
    test: ['test-review', 'testing-strategy'],
    performance: ['performance-review'],
    infra: ['infra-review', 'devops-k8s'],
    dependency: ['dependency-review']
});

const OPTIONAL_REVIEW_CAPABILITY_DEFINITIONS: Readonly<Record<OptionalReviewCapabilityKey, OptionalReviewCapabilityDefinition>> = Object.freeze({
    api: Object.freeze({
        label: 'API review',
        candidateSkillIds: ['api-review', 'api-contract-review'],
        githubBridgeRelativePath: '.github/agents/api-review.md'
    }),
    test: Object.freeze({
        label: 'Test review',
        candidateSkillIds: ['test-review', 'testing-strategy'],
        githubBridgeRelativePath: '.github/agents/test-review.md'
    }),
    performance: Object.freeze({
        label: 'Performance review',
        candidateSkillIds: ['performance-review'],
        githubBridgeRelativePath: '.github/agents/performance-review.md'
    }),
    infra: Object.freeze({
        label: 'Infra review',
        candidateSkillIds: ['infra-review', 'devops-k8s'],
        githubBridgeRelativePath: '.github/agents/infra-review.md'
    }),
    dependency: Object.freeze({
        label: 'Dependency review',
        candidateSkillIds: ['dependency-review'],
        githubBridgeRelativePath: '.github/agents/dependency-review.md'
    })
});

export function getDefaultReviewCapabilities(): ReviewCapabilities {
    return { ...REVIEW_CAPABILITY_DEFAULTS };
}

export function isOptionalReviewCapabilityKey(value: string): value is OptionalReviewCapabilityKey {
    return OPTIONAL_REVIEW_CAPABILITY_KEYS.includes(value as OptionalReviewCapabilityKey);
}

export function getOptionalReviewCapabilityKeys(): OptionalReviewCapabilityKey[] {
    return [...OPTIONAL_REVIEW_CAPABILITY_KEYS];
}

export function getOptionalReviewCapabilityDefinitions(): Readonly<Record<OptionalReviewCapabilityKey, OptionalReviewCapabilityDefinition>> {
    return OPTIONAL_REVIEW_CAPABILITY_DEFINITIONS;
}

export function getReviewSkillCandidates(reviewType: string): string[] {
    const normalizedReviewType = String(reviewType || '').trim().toLowerCase();
    const candidates = REVIEW_SKILL_CANDIDATES[normalizedReviewType];
    if (!candidates) {
        return [`${normalizedReviewType}-review`].filter(Boolean);
    }
    return [...candidates];
}

export function listKnownReviewSkillDirectories(): string[] {
    const known = new Set<string>();
    for (const key of Object.keys(REVIEW_SKILL_CANDIDATES)) {
        for (const candidate of getReviewSkillCandidates(key)) {
            known.add(candidate);
        }
    }
    return [...known].sort();
}

export function hasSkillEntrypoint(skillRoot: string): boolean {
    const skillMdPath = `${skillRoot}/SKILL.md`;
    const skillJsonPath = `${skillRoot}/skill.json`;
    const isFile = (filePath: string): boolean => memoizeInvocationRead(
        SKILL_ENTRYPOINT_FILES, path.resolve(filePath), () => {
            readInvocationPathObservation(filePath);
            return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
        }
    ).value;
    return isFile(skillMdPath) || isFile(skillJsonPath);
}

function ensurePlainObject(value: unknown, label: string): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`${label} must be a JSON object.`);
    }
    return value as Record<string, unknown>;
}

export function normalizeReviewCapabilitiesConfigMap(raw: unknown): ReviewCapabilitiesConfigMap {
    const source = ensurePlainObject(raw, 'review-capabilities');
    const normalized = getDefaultReviewCapabilities() as ReviewCapabilitiesConfigMap;

    for (const [key, value] of Object.entries(source)) {
        if (typeof value !== 'boolean') {
            throw new Error(`review-capabilities.${key} must be boolean.`);
        }
        normalized[key] = value;
    }

    return normalized;
}

export function readReviewCapabilitiesConfigFile(configPath: string): ReviewCapabilitiesConfigMap {
    if (!fs.existsSync(configPath) || !fs.statSync(configPath).isFile()) {
        return getDefaultReviewCapabilities() as ReviewCapabilitiesConfigMap;
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (error: unknown) {
        throw new Error(
            `Review capabilities config at '${configPath}' is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
        );
    }

    return normalizeReviewCapabilitiesConfigMap(parsed);
}
