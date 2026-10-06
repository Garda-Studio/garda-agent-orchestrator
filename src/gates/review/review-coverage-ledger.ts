import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

import { stringSha256 } from '../../gate-runtime/hash';
import {
    extractMarkdownSectionLines,
    getFindingsBySeverity
} from '../completion/completion-verdict-markdown';
import { normalizePath } from '../shared/helpers';
import { parseSplitCheckpointDetectionSource } from '../split-required/split-checkpoint-scope';
import {
    formatReviewEvidenceDomainViolation,
    normalizeReviewEvidenceDomainPaths
} from './review-evidence-domain';

export type ReviewCoverageObligationKind = 'file' | 'boundary' | 'category';

export interface ReviewCoverageObligation {
    id: string;
    kind: ReviewCoverageObligationKind;
    target: string;
    expected_finding_ids?: string[];
}

export interface ReviewCoverageContract {
    schema_version: 1;
    required: boolean;
    review_type: string;
    obligations: ReviewCoverageObligation[];
    obligation_count: number;
    contract_sha256: string;
}

export interface ReviewCoverageValidationSummary {
    status: 'PASS' | 'FAIL';
    required: boolean;
    contract_sha256: string | null;
    obligation_count: number;
    completed_obligation_count: number;
    omitted_obligation_ids: string[];
    duplicate_obligation_ids: string[];
    unknown_obligation_ids: string[];
    finding_ids: string[];
    violations: string[];
}

export function resolveReviewCoverageEvidenceSnapshotCommit(
    preflight: Record<string, unknown> | null | undefined
): string | undefined {
    return parseSplitCheckpointDetectionSource(preflight?.detection_source)?.base_commit;
}

interface ReviewCoverageEvidenceEntry {
    location: string;
    observation: string;
}

interface ReviewCoverageLedgerEntry {
    id: string;
    evidence: ReviewCoverageEvidenceEntry[];
    result: 'finding' | 'no-finding' | null;
    finding_ids: string[];
}

const FINDING_ID_PATTERN = /^F-\d{3}$/u;
const FINDING_ID_GLOBAL_PATTERN = /\[(F-\d{3})\]/gu;
const EVIDENCE_ONLY_FINDING_ID = 'F-000';
const EVIDENCE_ONLY_FINDING_PATTERN =
    /^\[garda:evidence-only:missing-focused-validation\]\s+(?:test=tests\/[^\s;]+\.(?:test|spec)\.(?:c|m)?[jt]sx?;\s*action=run-and-record-focused-test|target=[^\s;]+;\s*action=run-and-record-focused-validation)$/iu;

const REVIEW_CATEGORY_IDS: Record<string, readonly string[]> = {
    code: [
        'scope-simplicity',
        'correctness-edge-cases',
        'regression-contract-compatibility',
        'static-hygiene',
        'security-input-validation',
        'test-adequacy',
        'documentation-impact'
    ],
    refactor: [
        'behavior-preservation',
        'contract-compatibility',
        'simplicity-complexity',
        'coupling-cohesion',
        'static-hygiene',
        'test-adequacy'
    ],
    test: [
        'strategy-scope',
        'positive-negative-paths',
        'regression-recovery',
        'isolation-flakiness',
        'execution-evidence'
    ],
    security: ['trust-boundaries', 'authorization', 'input-validation', 'secrets-data-exposure', 'adversarial-paths'],
    db: ['schema-contract', 'migration-safety', 'transactionality', 'query-correctness', 'rollback'],
    api: ['request-contract', 'response-contract', 'error-contract', 'compatibility', 'validation'],
    performance: ['hot-paths', 'complexity', 'allocation-io', 'concurrency', 'measurement'],
    infra: ['deployment-contract', 'configuration', 'failure-recovery', 'observability', 'rollback'],
    dependency: ['version-compatibility', 'transitive-impact', 'security-advisories', 'runtime-support', 'lockfile-integrity']
};

function normalizeChangedFiles(changedFiles: readonly string[]): string[] {
    return [...new Set(changedFiles
        .map((entry) => normalizePath(String(entry || '').trim()))
        .filter(Boolean))].sort();
}

function normalizeIdentifier(value: string): string {
    return String(value || '')
        .trim()
        .replace(/[^A-Za-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .toUpperCase();
}

function classifyBoundary(filePath: string): string {
    if (/(?:^|\/)tests?\//u.test(filePath) || /\.(?:test|spec)\.[^.]+$/u.test(filePath)) {
        return 'test-behavior';
    }
    if (/(?:^|\/)(?:docs?|template\/docs)\//u.test(filePath) || /(?:^|\/)(?:README|CHANGELOG)\.md$/iu.test(filePath)) {
        return 'documentation-contract';
    }
    if (/\.(?:json|ya?ml|toml|ini)$/iu.test(filePath) || /(?:^|\/)config(?:\/|$)/u.test(filePath)) {
        return 'configuration-contract';
    }
    if (/\.(?:c|m)?[jt]sx?$/iu.test(filePath)) {
        return 'runtime-behavior';
    }
    return 'integration-surface';
}

function contractPayload(options: {
    reviewType: string;
    required: boolean;
    obligations: ReviewCoverageObligation[];
}): Omit<ReviewCoverageContract, 'contract_sha256'> {
    return {
        schema_version: 1,
        required: options.required,
        review_type: options.reviewType,
        obligations: options.obligations,
        obligation_count: options.obligations.length
    };
}

export function buildReviewCoverageContract(options: {
    reviewType: string;
    changedFiles: readonly string[];
    categoryIds?: readonly string[];
}): ReviewCoverageContract {
    const reviewType = String(options.reviewType || '').trim().toLowerCase();
    const changedFiles = normalizeChangedFiles(options.changedFiles);
    const fileObligations = changedFiles.map((filePath, index): ReviewCoverageObligation => ({
        id: `FILE-${String(index + 1).padStart(3, '0')}`,
        kind: 'file',
        target: filePath
    }));
    const boundaryObligations = [...new Set(changedFiles.map(classifyBoundary))]
        .sort()
        .map((boundary): ReviewCoverageObligation => ({
            id: `BOUNDARY-${normalizeIdentifier(boundary)}`,
            kind: 'boundary',
            target: boundary
        }));
    const categoryIds = [...new Set((options.categoryIds || REVIEW_CATEGORY_IDS[reviewType] || ['assigned-review-contract'])
        .map((entry) => String(entry || '').trim().toLowerCase())
        .filter(Boolean))].sort();
    const categoryObligations = (changedFiles.length > 0 ? categoryIds : []).map((category): ReviewCoverageObligation => ({
        id: `CATEGORY-${normalizeIdentifier(category)}`,
        kind: 'category',
        target: category
    }));
    const obligations = [...fileObligations, ...boundaryObligations, ...categoryObligations];
    const payload = contractPayload({
        reviewType,
        required: changedFiles.length > 0,
        obligations
    });
    return {
        ...payload,
        contract_sha256: stringSha256(JSON.stringify(payload)) || ''
    };
}

export function getReviewCoverageContractViolations(
    value: unknown,
    expected: {
        reviewType: string;
        changedFiles: readonly string[];
        categoryIds?: readonly string[];
    }
): string[] {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return ['Review context is missing the required coverage_contract object.'];
    }
    const actual = value as ReviewCoverageContract;
    const deterministic = buildReviewCoverageContract(expected);
    if (JSON.stringify(actual) === JSON.stringify(deterministic)) {
        return [];
    }
    return [
        `Review coverage contract does not match the deterministic current-scope contract for ` +
        `'${deterministic.review_type}'. Expected sha256=${deterministic.contract_sha256}; ` +
        `actual sha256=${String(actual.contract_sha256 || 'missing')}.`
    ];
}

export function isEmptyReviewCoverageContract(contract: ReviewCoverageContract | null | undefined): boolean {
    return !!contract
        && contract.required === false
        && contract.obligation_count === 0
        && Array.isArray(contract.obligations)
        && contract.obligations.length === 0
        && getReviewCoverageContractViolations(contract, {
            reviewType: contract.review_type,
            changedFiles: []
        }).length === 0;
}

function coverageSummaryStringArray(value: unknown): string[] | null {
    return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
        ? value as string[]
        : null;
}

export function getReviewCoverageValidationSummaryContractViolations(
    value: unknown,
    contract: ReviewCoverageContract
): string[] {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return ['coverage validation summary is missing'];
    }
    const summary = value as Partial<ReviewCoverageValidationSummary>;
    const violations: string[] = [];
    const expectedCompletedObligationCount = contract.required ? contract.obligation_count : 0;
    const omittedObligationIds = coverageSummaryStringArray(summary.omitted_obligation_ids);
    const duplicateObligationIds = coverageSummaryStringArray(summary.duplicate_obligation_ids);
    const unknownObligationIds = coverageSummaryStringArray(summary.unknown_obligation_ids);
    if (summary.status !== 'PASS') violations.push('coverage status is not PASS');
    if (String(summary.contract_sha256 || '').trim().toLowerCase() !== contract.contract_sha256) {
        violations.push('coverage contract hash mismatch');
    }
    if (summary.obligation_count !== contract.obligation_count) {
        violations.push('coverage obligation count mismatch');
    }
    if (summary.completed_obligation_count !== expectedCompletedObligationCount) {
        violations.push('coverage completed obligation count mismatch');
    }
    if (!omittedObligationIds || omittedObligationIds.length > 0) {
        violations.push('coverage contains omitted obligations');
    }
    if (!duplicateObligationIds || duplicateObligationIds.length > 0) {
        violations.push('coverage contains duplicate obligations');
    }
    if (!unknownObligationIds || unknownObligationIds.length > 0) {
        violations.push('coverage contains unknown obligations');
    }
    return violations;
}

function parseCoverageLedgerEntries(reviewContent: string): {
    entries: ReviewCoverageLedgerEntry[];
    violations: string[];
} {
    const jsonEntries = parseJsonCoverageLedgerEntries(reviewContent);
    if (jsonEntries) {
        return jsonEntries;
    }
    const sectionLines = extractMarkdownSectionLines(String(reviewContent || '').split('\n'), 'Coverage Ledger');
    if (sectionLines.length === 0) {
        return { entries: [], violations: ["Review output is missing required section '## Coverage Ledger'."] };
    }
    const entries: ReviewCoverageLedgerEntry[] = [];
    const violations: string[] = [];
    for (const rawLine of sectionLines) {
        const trimmed = rawLine.trim();
        if (!trimmed) {
            continue;
        }
        if (!trimmed.startsWith('- ')) {
            violations.push(`Coverage ledger entry must be a JSON bullet: ${trimmed}`);
            continue;
        }
        try {
            const parsed = JSON.parse(trimmed.slice(2)) as Record<string, unknown>;
            const entryId = String(parsed.id || '').trim().toUpperCase();
            const evidenceMembers = Array.isArray(parsed.evidence) ? parsed.evidence : [];
            evidenceMembers.forEach((entry, index) => {
                const isRecord = Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry);
                const keys = isRecord ? Object.keys(entry as Record<string, unknown>).sort() : [];
                if (
                    !isRecord
                    || keys.length !== 2
                    || keys[0] !== 'location'
                    || keys[1] !== 'observation'
                    || typeof (entry as Record<string, unknown>).location !== 'string'
                    || typeof (entry as Record<string, unknown>).observation !== 'string'
                ) {
                    violations.push(
                        `Coverage ledger entry '${entryId || '<missing>'}' has malformed evidence member at index ${index}.`
                    );
                }
            });
            const evidence = Array.isArray(parsed.evidence)
                ? parsed.evidence
                    .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry))
                    .map((entry) => ({
                        location: String(entry.location || '').trim(),
                        observation: String(entry.observation || '').trim()
                    }))
                : [];
            const findingIdMembers = Array.isArray(parsed.finding_ids) ? parsed.finding_ids : [];
            if (!Array.isArray(parsed.finding_ids)) {
                violations.push(`Coverage ledger entry '${entryId || '<missing>'}' must use a finding_ids array.`);
            }
            findingIdMembers.forEach((entry, index) => {
                if (typeof entry !== 'string' || !entry.trim()) {
                    violations.push(
                        `Coverage ledger entry '${entryId || '<missing>'}' has malformed finding_ids member at index ${index}.`
                    );
                }
            });
            const findingIds = findingIdMembers
                .filter((entry): entry is string => typeof entry === 'string' && Boolean(entry.trim()))
                .map((entry) => entry.trim().toUpperCase());
            const result = parsed.result === 'finding' || parsed.result === 'no-finding'
                ? parsed.result
                : null;
            if (!result) {
                violations.push(
                    `Coverage ledger entry '${String(parsed.id || '').trim() || '<missing>'}' must use result 'finding' or 'no-finding'.`
                );
            }
            entries.push({
                id: entryId,
                evidence,
                result,
                finding_ids: findingIds
            });
        } catch {
            violations.push(`Coverage ledger entry is not valid JSON: ${trimmed}`);
        }
    }
    return { entries, violations };
}

function parseJsonCoverageLedgerEntries(reviewContent: string): {
    entries: ReviewCoverageLedgerEntry[];
    violations: string[];
} | null {
    let parsed: unknown;
    try {
        parsed = JSON.parse(String(reviewContent || ''));
    } catch {
        return null;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return null;
    }
    const ledger = (parsed as Record<string, unknown>).coverage_ledger;
    if (!ledger || typeof ledger !== 'object' || Array.isArray(ledger)) {
        return null;
    }
    const rawEntries = (ledger as Record<string, unknown>).entries;
    if (!Array.isArray(rawEntries)) {
        return {
            entries: [],
            violations: ['JSON coverage_ledger.entries must be an array.']
        };
    }
    const entries: ReviewCoverageLedgerEntry[] = [];
    const violations: string[] = [];
    rawEntries.forEach((entry, entryIndex) => {
        const isRecord = Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry);
        if (!isRecord) {
            violations.push(`JSON coverage ledger entry at index ${entryIndex} must be an object.`);
            return;
        }
        const record = entry as Record<string, unknown>;
        const entryId = String(record.obligation_id || record.id || '').trim().toUpperCase();
        const evidenceMembers = Array.isArray(record.evidence) ? record.evidence : [];
        if (!entryId) {
            violations.push(`JSON coverage ledger entry at index ${entryIndex} is missing obligation_id.`);
        }
        if (!Array.isArray(record.evidence)) {
            violations.push(`JSON coverage ledger entry '${entryId || '<missing>'}' must use an evidence array.`);
        }
        evidenceMembers.forEach((evidenceEntry, evidenceIndex) => {
            const evidenceRecord = Boolean(evidenceEntry) && typeof evidenceEntry === 'object' && !Array.isArray(evidenceEntry)
                ? evidenceEntry as Record<string, unknown>
                : null;
            if (
                !evidenceRecord
                || typeof evidenceRecord.location !== 'string'
                || typeof evidenceRecord.observation !== 'string'
            ) {
                violations.push(
                    `JSON coverage ledger entry '${entryId || '<missing>'}' has malformed evidence member at index ${evidenceIndex}.`
                );
            }
        });
        const evidence = evidenceMembers
            .filter((evidenceEntry): evidenceEntry is Record<string, unknown> => (
                Boolean(evidenceEntry) && typeof evidenceEntry === 'object' && !Array.isArray(evidenceEntry)
            ))
            .map((evidenceEntry) => ({
                location: String(evidenceEntry.location || '').trim(),
                observation: String(evidenceEntry.observation || '').trim()
            }));
        if (!Array.isArray(record.finding_ids)) {
            violations.push(`JSON coverage ledger entry '${entryId || '<missing>'}' must use a finding_ids array.`);
        }
        const findingIds = (Array.isArray(record.finding_ids) ? record.finding_ids : [])
            .filter((findingId): findingId is string => typeof findingId === 'string' && Boolean(findingId.trim()))
            .map((findingId) => findingId.trim().toUpperCase());
        entries.push({
            id: entryId,
            evidence,
            result: findingIds.length > 0 ? 'finding' : 'no-finding',
            finding_ids: findingIds
        });
    });
    return { entries, violations };
}

export interface ReviewEvidenceLineCount {
    count: number;
    source: 'current' | 'head' | 'bound-snapshot';
}

export function parseReviewEvidenceLocation(location: string): { filePath: string; line: number } | null {
    const match = /^(.*?)(?::(\d+)|#L(\d+))$/u.exec(String(location || '').trim());
    if (!match) {
        return null;
    }
    const line = Number(match[2] || match[3]);
    const filePath = normalizePath(match[1]);
    return filePath && Number.isSafeInteger(line) && line > 0 ? { filePath, line } : null;
}

function countReviewEvidenceLines(content: string): number {
    const lines = content.replace(/\r\n?/gu, '\n').split('\n');
    if (lines.at(-1) === '') {
        lines.pop();
    }
    return lines.length;
}

export function createChangedFileLineCountResolver(
    options: { repoRoot?: string; evidenceSnapshotCommit?: string } = {}
): (filePath: string) => ReviewEvidenceLineCount | null {
    const lineCountCache = new Map<string, ReviewEvidenceLineCount | null>();
    return (filePath: string): ReviewEvidenceLineCount | null => {
        if (!options.repoRoot) {
            return null;
        }
        if (lineCountCache.has(filePath)) {
            return lineCountCache.get(filePath) || null;
        }
        const repoRoot = path.resolve(options.repoRoot);
        const resolvedPath = path.resolve(repoRoot, filePath);
        const relativePath = path.relative(repoRoot, resolvedPath);
        if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
            lineCountCache.set(filePath, null);
            return null;
        }
        try {
            const result = {
                count: countReviewEvidenceLines(fs.readFileSync(resolvedPath, 'utf8')),
                source: 'current' as const
            };
            lineCountCache.set(filePath, result);
            return result;
        } catch {
            try {
                const evidenceSnapshotCommit = String(options.evidenceSnapshotCommit || '').trim();
                const hasBoundSnapshot = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(evidenceSnapshotCommit);
                const snapshotContent = execFileSync(
                    'git',
                    ['show', `${hasBoundSnapshot ? evidenceSnapshotCommit : 'HEAD'}:${filePath}`],
                    {
                        cwd: repoRoot,
                        encoding: 'utf8',
                        stdio: ['ignore', 'pipe', 'ignore']
                    }
                );
                const result = {
                    count: countReviewEvidenceLines(snapshotContent),
                    source: hasBoundSnapshot ? 'bound-snapshot' as const : 'head' as const
                };
                lineCountCache.set(filePath, result);
                return result;
            } catch {
                lineCountCache.set(filePath, null);
                return null;
            }
        }
    };
}

export function formatReviewEvidenceLineCountSource(source: ReviewEvidenceLineCount['source']): string {
    return source === 'head'
        ? 'deleted-file HEAD snapshot'
        : source === 'bound-snapshot'
        ? 'authenticated pre-change snapshot'
        : 'current file';
}

const REVIEW_STATUS_PREFIX_PATTERNS = Object.freeze([
    /^(?:reviewed|checked|validated|inspected)\s+(?:the\s+)?(?:whole\s+)?(?:file|scope|code)\b/u,
    /^(?:(?:after|following|during)\s+(?:the\s+)?(?:review|inspection|validation|check),?\s+)?(?:(?:the|all)\s+)?(?:(?:changed|entire|whole)\s+)?(?:files?|scope|code|implementation|changes?)\s+(?:was|were|is|are|has\s+been|have\s+been)\s+(?:(?:carefully|fully|thoroughly|completely)\s+)*(?:reviewed|checked|validated|inspected)\b/u,
    /^(?:we|i)\s+(?:(?:carefully|fully|thoroughly|completely)\s+)*(?:reviewed|checked|validated|inspected)\s+(?:the\s+)?(?:changed\s+)?(?:file|scope|code|implementation|changes?)\b/u
]);
const GENERIC_REVIEW_STATUS_WORDS = new Set([
    'a',
    'after',
    'all',
    'and',
    'as',
    'api',
    'been',
    'behavior',
    'by',
    'carefully',
    'change',
    'changed',
    'changes',
    'check',
    'checked',
    'code',
    'complete',
    'completed',
    'completely',
    'compatibility',
    'correct',
    'correctly',
    'correctness',
    'coverage',
    'during',
    'entire',
    'everything',
    'expected',
    'for',
    'file',
    'files',
    'fine',
    'following',
    'fully',
    'good',
    'has',
    'have',
    'i',
    'implementation',
    'inspection',
    'inspected',
    'is',
    'it',
    'looks',
    'manually',
    'maintainability',
    'no',
    'none',
    'ok',
    'okay',
    'overall',
    'passed',
    'passes',
    'performance',
    'problem',
    'problems',
    'quality',
    'reliability',
    'review',
    'reviewed',
    'reviewer',
    'robustness',
    'scope',
    'security',
    'safety',
    'style',
    'successfully',
    'that',
    'the',
    'these',
    'this',
    'those',
    'thoroughly',
    'test',
    'testing',
    'validated',
    'validation',
    'was',
    'we',
    'were',
    'whole',
    'without',
    'work',
    'worked',
    'works'
]);
const GENERIC_NO_DEFECT_SUFFIX_PATTERN =
    /^(?:(?:(?:and|with)\s+)?no(?:\s+[a-z0-9_-]+){0,4}\s+(?:defects?|findings?|issues?|problems?)(?:\s+(?:were\s+)?(?:detected|found|identified))?|(?:and\s+)?(?:detected|found|identified)\s+no(?:\s+[a-z0-9_-]+){0,4}\s+(?:defects?|findings?|issues?|problems?)|(?:and\s+)?there\s+(?:was|were)\s+no(?:\s+[a-z0-9_-]+){0,4}\s+(?:defects?|findings?|issues?|problems?)(?:\s+(?:detected|found|identified))?|without(?:\s+any)?(?:\s+[a-z0-9_-]+){0,4}\s+(?:defects?|findings?|issues?|problems?))$/u;
const GENERIC_NO_DEFECT_DECLARATION_PATTERN =
    /^(?:no(?:\s+[a-z0-9_-]+){0,4}\s+(?:defects?|findings?|issues?|problems?)(?:\s+(?:were\s+)?(?:detected|found|identified))?|(?:we|i)\s+(?:detected|found|identified)\s+no(?:\s+[a-z0-9_-]+){0,4}\s+(?:defects?|findings?|issues?|problems?)|there\s+(?:was|were)\s+no(?:\s+[a-z0-9_-]+){0,4}\s+(?:defects?|findings?|issues?|problems?)(?:\s+(?:detected|found|identified))?)(?:\s+(?:(?:after|following)\s+(?:(?:the\s+)?(?:review|inspection|validation|check)|(?:reviewing|checking|inspecting|validating)(?:\s+(?:the\s+)?(?:file|scope|code|implementation|changes?))?)|during\s+(?:the\s+)?(?:review|inspection|validation|check)))?$/u;

function extractReviewStatusWords(value: string): string[] {
    return value
        .replace(/^[\s,;:—–-]+|[.!?]+$/gu, '')
        .split(/[^a-z0-9_-]+/u)
        .filter(Boolean);
}

function usesOnlyGenericReviewStatusVocabulary(normalized: string): boolean {
    const words = extractReviewStatusWords(normalized);
    return words.length > 0
        && words.every((word) => GENERIC_REVIEW_STATUS_WORDS.has(word));
}

function isGenericReviewStatusDeclaration(normalized: string): boolean {
    const normalizedDeclaration = normalized.replace(/^[\s,;:—–-]+|[.!?]+$/gu, '');
    if (
        usesOnlyGenericReviewStatusVocabulary(normalized)
        || GENERIC_NO_DEFECT_DECLARATION_PATTERN.test(normalizedDeclaration)
    ) {
        return true;
    }
    const prefix = REVIEW_STATUS_PREFIX_PATTERNS
        .map((pattern) => normalized.match(pattern))
        .find((match): match is RegExpMatchArray => match !== null);
    if (!prefix) {
        return false;
    }
    const normalizedSuffix = normalized
        .slice(prefix[0].length)
        .replace(/^[\s,;:—–-]+|[.!?]+$/gu, '');
    const suffixWords = extractReviewStatusWords(normalizedSuffix);
    return suffixWords.length === 0
        || suffixWords.every((word) => GENERIC_REVIEW_STATUS_WORDS.has(word))
        || GENERIC_NO_DEFECT_SUFFIX_PATTERN.test(normalizedSuffix);
}

function isGenericObservation(observation: string): boolean {
    const normalized = String(observation || '').trim().toLowerCase();
    return normalized.length < 24
        || normalized.split(/\s+/u).length < 4
        || isGenericReviewStatusDeclaration(normalized)
        || /\b(?:no issues|looks good|full scope|all files|everything)\b/u.test(normalized);
}

function collectFindingIds(reviewContent: string): { ids: string[]; violations: string[] } {
    const jsonFindingIds = collectJsonFindingIds(reviewContent);
    if (jsonFindingIds) {
        return jsonFindingIds;
    }
    const findingsLines = extractMarkdownSectionLines(String(reviewContent || '').split('\n'), 'Findings by Severity');
    const findingsBySeverity = getFindingsBySeverity(findingsLines);
    const ids: string[] = [];
    const violations: string[] = [];
    for (const finding of Object.values(findingsBySeverity).flat()) {
        const findingIds = [...finding.matchAll(FINDING_ID_GLOBAL_PATTERN)].map((match) => match[1]);
        if (findingIds.length === 0 && EVIDENCE_ONLY_FINDING_PATTERN.test(finding.trim())) {
            ids.push(EVIDENCE_ONLY_FINDING_ID);
            continue;
        }
        if (findingIds.includes(EVIDENCE_ONLY_FINDING_ID)) {
            violations.push(
                `Finding identifier '${EVIDENCE_ONLY_FINDING_ID}' is reserved for the exact canonical evidence-only marker.`
            );
        }
        if (findingIds.length !== 1) {
            violations.push(
                `Every active finding must contain exactly one identifier like [F-001]: ${finding}`
            );
            continue;
        }
        ids.push(findingIds[0]);
    }
    const duplicateIds = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))].sort();
    for (const duplicateId of duplicateIds) {
        violations.push(`Finding identifier '${duplicateId}' is used by more than one active finding.`);
    }
    return { ids: [...new Set(ids)].sort(), violations };
}

function collectJsonFindingIds(reviewContent: string): { ids: string[]; violations: string[] } | null {
    let parsed: unknown;
    try {
        parsed = JSON.parse(String(reviewContent || ''));
    } catch {
        return null;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return null;
    }
    const findings = (parsed as Record<string, unknown>).findings;
    if (!findings || typeof findings !== 'object' || Array.isArray(findings)) {
        return null;
    }
    const ids: string[] = [];
    const violations: string[] = [];
    for (const severity of ['critical', 'high', 'medium', 'low'] as const) {
        const entries = (findings as Record<string, unknown>)[severity];
        if (!Array.isArray(entries)) {
            violations.push(`JSON findings.${severity} must be an array.`);
            continue;
        }
        entries.forEach((entry, index) => {
            const record = Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry)
                ? entry as Record<string, unknown>
                : null;
            const id = String(record?.id || '').trim().toUpperCase();
            if (!FINDING_ID_PATTERN.test(id)) {
                violations.push(`JSON findings.${severity}[${index}].id must use an identifier like F-001.`);
                return;
            }
            if (id === EVIDENCE_ONLY_FINDING_ID) {
                const markerTextCandidates = [
                    typeof record?.title === 'string' ? record.title.trim() : '',
                    typeof record?.description === 'string' ? record.description.trim() : ''
                ].filter(Boolean);
                if (!markerTextCandidates.some((candidate) => EVIDENCE_ONLY_FINDING_PATTERN.test(candidate))) {
                    violations.push(
                        `Finding identifier '${EVIDENCE_ONLY_FINDING_ID}' is reserved for the exact canonical evidence-only marker.`
                    );
                    return;
                }
            }
            ids.push(id);
        });
    }
    const duplicateIds = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))].sort();
    for (const duplicateId of duplicateIds) {
        violations.push(`Finding identifier '${duplicateId}' is used by more than one active finding.`);
    }
    return { ids: [...new Set(ids)].sort(), violations };
}

export function validateReviewCoverageLedger(
    reviewContent: string,
    contract: ReviewCoverageContract,
    options: { repoRoot?: string; evidenceSnapshotCommit?: string } = {}
): ReviewCoverageValidationSummary {
    if (!contract?.required) {
        return {
            status: 'PASS',
            required: false,
            contract_sha256: contract?.contract_sha256 || null,
            obligation_count: contract?.obligations?.length || 0,
            completed_obligation_count: 0,
            omitted_obligation_ids: [],
            duplicate_obligation_ids: [],
            unknown_obligation_ids: [],
            finding_ids: [],
            violations: []
        };
    }
    const parsed = parseCoverageLedgerEntries(reviewContent);
    const findingEvidence = collectFindingIds(reviewContent);
    const violations = [...parsed.violations, ...findingEvidence.violations];
    const expectedById = new Map(contract.obligations.map((entry) => [entry.id, entry]));
    const counts = new Map<string, number>();
    for (const entry of parsed.entries) {
        counts.set(entry.id, (counts.get(entry.id) || 0) + 1);
    }
    const duplicateObligationIds = [...counts.entries()]
        .filter(([, count]) => count > 1)
        .map(([id]) => id)
        .sort();
    const unknownObligationIds = [...counts.keys()].filter((id) => !expectedById.has(id)).sort();
    const omittedObligationIds = contract.obligations
        .map((entry) => entry.id)
        .filter((id) => !counts.has(id))
        .sort();
    duplicateObligationIds.forEach((id) => violations.push(`Coverage obligation '${id}' is duplicated.`));
    unknownObligationIds.forEach((id) => violations.push(`Coverage obligation '${id}' is not part of the current contract.`));
    omittedObligationIds.forEach((id) => violations.push(`Coverage obligation '${id}' is omitted.`));

    const changedFiles = normalizeReviewEvidenceDomainPaths(
        contract.obligations.filter((entry) => entry.kind === 'file').map((entry) => entry.target)
    );
    const getChangedFileLineCount = createChangedFileLineCountResolver(options);
    const ledgerFindingIds = new Set<string>();
    for (const entry of parsed.entries) {
        const obligation = expectedById.get(entry.id);
        if (!obligation) {
            continue;
        }
        if (entry.evidence.length === 0) {
            violations.push(`Coverage obligation '${entry.id}' has no concrete evidence.`);
        }
        let hasTargetFileEvidence = obligation.kind !== 'file';
        for (const evidence of entry.evidence) {
            const location = parseReviewEvidenceLocation(evidence.location);
            if (!location || !changedFiles.includes(location.filePath)) {
                violations.push(formatReviewEvidenceDomainViolation({
                    subject: `Coverage obligation '${entry.id}' evidence`,
                    location: evidence.location,
                    reviewType: contract.review_type,
                    admissiblePaths: changedFiles
                }));
            } else if (obligation.kind === 'file' && location.filePath === obligation.target) {
                hasTargetFileEvidence = true;
            }
            if (location && changedFiles.includes(location.filePath) && options.repoRoot) {
                const lineEvidence = getChangedFileLineCount(location.filePath);
                if (lineEvidence == null) {
                    violations.push(
                        `Coverage obligation '${entry.id}' evidence file '${location.filePath}' is unreadable in both the current repository and HEAD snapshot.`
                    );
                } else if (location.line > lineEvidence.count) {
                    violations.push(
                        `Coverage obligation '${entry.id}' evidence location '${evidence.location}' exceeds ` +
                        `${formatReviewEvidenceLineCountSource(lineEvidence.source)} line count ${lineEvidence.count}.`
                    );
                }
            }
            if (isGenericObservation(evidence.observation)) {
                violations.push(`Coverage obligation '${entry.id}' contains generic evidence: '${evidence.observation}'.`);
            }
        }
        if (!hasTargetFileEvidence) {
            violations.push(
                `File coverage obligation '${entry.id}' must cite its own target '${obligation.target}:line'; `
                + 'a different admissible review-domain path cannot satisfy a FILE-* obligation.'
            );
        }
        const invalidFindingIds = entry.finding_ids.filter((id) => !FINDING_ID_PATTERN.test(id));
        invalidFindingIds.forEach((id) => violations.push(`Coverage obligation '${entry.id}' has invalid finding id '${id}'.`));
        if (entry.result === 'finding' && entry.finding_ids.length === 0) {
            violations.push(`Coverage obligation '${entry.id}' reports finding without finding_ids.`);
        }
        if (entry.result === 'no-finding' && entry.finding_ids.length > 0) {
            violations.push(`Coverage obligation '${entry.id}' reports no-finding but references finding_ids.`);
        }
        entry.finding_ids.forEach((id) => ledgerFindingIds.add(id));
        for (const expectedFindingId of obligation.expected_finding_ids || []) {
            if (!entry.finding_ids.includes(expectedFindingId)) {
                violations.push(`Coverage obligation '${entry.id}' is missing expected finding id '${expectedFindingId}'.`);
            }
        }
    }
    for (const findingId of findingEvidence.ids) {
        if (!ledgerFindingIds.has(findingId)) {
            violations.push(`Active finding '${findingId}' is not referenced by any coverage obligation.`);
        }
    }
    for (const findingId of ledgerFindingIds) {
        if (!findingEvidence.ids.includes(findingId)) {
            violations.push(`Coverage ledger references unknown active finding '${findingId}'.`);
        }
    }
    return {
        status: violations.length === 0 ? 'PASS' : 'FAIL',
        required: true,
        contract_sha256: contract.contract_sha256,
        obligation_count: contract.obligations.length,
        completed_obligation_count: contract.obligations.length - omittedObligationIds.length,
        omitted_obligation_ids: omittedObligationIds,
        duplicate_obligation_ids: duplicateObligationIds,
        unknown_obligation_ids: unknownObligationIds,
        finding_ids: findingEvidence.ids,
        violations
    };
}

export function buildReviewCoverageLedgerTemplateLines(contract: ReviewCoverageContract): string[] {
    if (!contract.required) {
        return ['None'];
    }
    const defaultLocation = contract.obligations.find((entry) => entry.kind === 'file')?.target || '<changed-file>';
    return contract.obligations.map((obligation) => `- ${JSON.stringify({
        id: obligation.id,
        evidence: [{
            location: `${obligation.kind === 'file' ? obligation.target : defaultLocation}:<line>`,
            observation: `<concrete observation for ${obligation.kind} ${obligation.target}>`
        }],
        result: '<finding|no-finding>',
        finding_ids: ['<F-001 when result=finding; otherwise empty>']
    })}`);
}
