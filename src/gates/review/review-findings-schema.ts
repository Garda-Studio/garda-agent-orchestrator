import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseFocusedCommandSyntax } from './review-focused-command-tokenizer';
import { parseMavenFocusedCommand, resolveMavenFocusedTargets } from './review-focused-command-maven';

import {
    hasReviewerInlineInterpreterOption,
    REVIEWER_INLINE_INTERPRETER_COMMAND_PATTERN,
    REVIEWER_INLINE_INTERPRETER_REASON
} from './reviewer-focused-validation-policy';

import {
    createChangedFileLineCountResolver,
    formatReviewEvidenceLineCountSource,
    parseReviewEvidenceLocation,
    isEmptyReviewCoverageContract,
    type ReviewCoverageContract
} from './review-coverage-ledger';
import {
    formatReviewEvidenceDomainViolation,
    normalizeReviewEvidenceDomainPaths
} from './review-evidence-domain';
import {
    REVIEWER_FOCUSED_SELF_VALIDATION_TOPIC,
    REVIEWER_MISSING_FOCUSED_TEST_ACTION,
    REVIEWER_MISSING_FOCUSED_VALIDATION_ACTION,
    REVIEWER_MISSING_FOCUSED_VALIDATION_MARKER
} from './reviewer-execution-contract';
import {
    getReviewRemediationReviewContractViolations,
    getReviewerRemediationCoverageViolations,
    type ReviewRemediationReviewContract,
    type ReviewerRemediationCoverageDeclaration
} from '../review-remediation/review-remediation-review-contract';

export const REVIEW_FINDINGS_SCHEMA_VERSION = 2 as const;

export const REVIEW_FINDINGS_ID_PATTERN = /^F-\d{3}$/u;
export const REVIEW_RESIDUAL_RISK_ID_PATTERN = /^R-\d{3}$/u;
export const REVIEW_VALIDATION_NOTE_ID_PATTERN = /^N-\d{3}$/u;

const REVIEW_FINDINGS_FORBIDDEN_DECISION_KEYS = new Set([
    'action',
    'decision',
    'fail',
    'failed',
    'fix_now',
    'ignore',
    'outcome',
    'pass',
    'passed',
    'policy',
    'remediation',
    'result',
    'status',
    'verdict'
]);

const REPORT_KEYS = new Set([
    'schema_version',
    'task_id',
    'review_type',
    'review_context_sha256',
    'tree_state_sha256',
    'validation_notes',
    'coverage_ledger',
    'review_execution',
    'findings',
    'residual_risks',
    'reviewer_notes'
]);
const VALIDATION_NOTE_KEYS = new Set([
    'id',
    'topic',
    'note',
    'evidence',
    'command',
    'command_outcome',
    'diagnostics',
    'finding_ids'
]);
const COVERAGE_LEDGER_KEYS = new Set(['coverage_contract_sha256', 'entries']);
const COVERAGE_ENTRY_KEYS = new Set(['obligation_id', 'evidence', 'finding_ids']);
const REVIEW_EXECUTION_KEYS = new Set([
    'mode',
    'contract_sha256',
    'covered_delta_targets',
    'inspected_prior_finding_ids'
]);
const FINDINGS_KEYS = new Set(['critical', 'high', 'medium', 'low']);
const FINDING_KEYS = new Set(['id', 'title', 'description', 'evidence', 'coverage_obligation_ids']);
const RESIDUAL_RISK_KEYS = new Set(['id', 'description', 'evidence']);
const EVIDENCE_KEYS = new Set(['location', 'observation']);

export type ReviewFindingsSeverity = 'critical' | 'high' | 'medium' | 'low';
export type ReviewFocusedCommandOutcome = 'passed' | 'failed' | 'unavailable' | 'prohibited';

export interface ReviewFindingsEvidence {
    location: string;
    observation: string;
}

export interface ReviewFindingsValidationNote {
    id: string;
    topic: string;
    note: string;
    evidence: ReviewFindingsEvidence[];
    command?: string;
    command_outcome?: ReviewFocusedCommandOutcome;
    diagnostics?: string;
    finding_ids?: string[];
}

export interface ReviewFindingsCoverageLedgerEntry {
    obligation_id: string;
    evidence: ReviewFindingsEvidence[];
    finding_ids: string[];
}

export interface ReviewFindingsCoverageLedger {
    coverage_contract_sha256: string;
    entries: ReviewFindingsCoverageLedgerEntry[];
}

export interface ReviewFinding {
    id: string;
    title: string;
    description: string;
    evidence: ReviewFindingsEvidence[];
    coverage_obligation_ids: string[];
}

export interface ReviewFindingsBySeverity {
    critical: ReviewFinding[];
    high: ReviewFinding[];
    medium: ReviewFinding[];
    low: ReviewFinding[];
}

export interface ReviewResidualRisk {
    id: string;
    description: string;
    evidence: ReviewFindingsEvidence[];
}

export interface ReviewFindingsReport {
    /** Runtime validation enforces REVIEW_FINDINGS_SCHEMA_VERSION. */
    schema_version: number;
    task_id: string;
    review_type: string;
    review_context_sha256: string;
    tree_state_sha256: string;
    validation_notes: ReviewFindingsValidationNote[];
    coverage_ledger: ReviewFindingsCoverageLedger;
    /** Legacy construction input; runtime validation requires this field. */
    review_execution?: ReviewerRemediationCoverageDeclaration;
    findings: ReviewFindingsBySeverity;
    residual_risks: ReviewResidualRisk[];
    reviewer_notes: string[];
}

export interface ReviewFindingsValidationOptions {
    expectedTaskId: string;
    expectedReviewType: string;
    expectedCoverageObligationIds?: readonly string[];
    expectedCoverageContract?: ReviewCoverageContract;
    expectedChangedFilePaths?: readonly string[];
    expectedReviewContextSha256?: string;
    expectedTreeStateSha256?: string;
    repoRoot?: string;
    evidenceSnapshotCommit?: string;
    expectedReviewExecutionContract?: ReviewRemediationReviewContract;
    /** Diagnostic parsing only; never use this mode to authorize a review receipt or completion. */
    allowStructuralOnlyReviewExecution?: boolean;
}

export interface ReviewFindingsValidationResult {
    valid: boolean;
    report: (ReviewFindingsReport & { review_execution: ReviewerRemediationCoverageDeclaration }) | null;
    review_execution_authentication: 'authenticated' | 'structural_only';
    violations: string[];
}

export const reviewFindingsReportJsonSchema = {
    $id: 'garda-agent-orchestrator/review-findings-report.schema.json',
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    additionalProperties: false,
    required: [
        'schema_version',
        'task_id',
        'review_type',
        'review_context_sha256',
        'tree_state_sha256',
        'validation_notes',
        'coverage_ledger',
        'review_execution',
        'findings',
        'residual_risks',
        'reviewer_notes'
    ],
    properties: {
        schema_version: { const: REVIEW_FINDINGS_SCHEMA_VERSION },
        task_id: { type: 'string', minLength: 1 },
        review_type: { type: 'string', minLength: 1 },
        review_context_sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
        tree_state_sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
        validation_notes: {
            type: 'array',
            minItems: 1,
            items: { $ref: '#/definitions/validation_note' }
        },
        coverage_ledger: { $ref: '#/definitions/coverage_ledger' },
        review_execution: { $ref: '#/definitions/review_execution' },
        findings: { $ref: '#/definitions/findings_by_severity' },
        residual_risks: {
            type: 'array',
            items: { $ref: '#/definitions/residual_risk' }
        },
        reviewer_notes: { type: 'array', items: { type: 'string' } }
    },
    definitions: {
        evidence: {
            type: 'object',
            additionalProperties: false,
            required: ['location', 'observation'],
            properties: {
                location: { type: 'string', minLength: 1 },
                observation: { type: 'string', minLength: 1 }
            }
        },
        validation_note: {
            type: 'object',
            additionalProperties: false,
            required: ['id', 'topic', 'note', 'evidence'],
            properties: {
                id: { type: 'string', pattern: '^N-\\d{3}$' },
                topic: { type: 'string', minLength: 1 },
                note: { type: 'string', minLength: 1 },
                evidence: {
                    type: 'array',
                    minItems: 0,
                    items: { $ref: '#/definitions/evidence' }
                },
                command: { type: 'string', minLength: 1 },
                command_outcome: { enum: ['passed', 'failed', 'unavailable', 'prohibited'] },
                diagnostics: { type: 'string', minLength: 1 },
                finding_ids: {
                    type: 'array',
                    items: { type: 'string', pattern: '^F-\\d{3}$' },
                    uniqueItems: true
                }
            }
        },
        coverage_ledger: {
            type: 'object',
            additionalProperties: false,
            required: ['coverage_contract_sha256', 'entries'],
            properties: {
                coverage_contract_sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
                entries: {
                    type: 'array',
                    items: { $ref: '#/definitions/coverage_entry' }
                }
            }
        },
        coverage_entry: {
            type: 'object',
            additionalProperties: false,
            required: ['obligation_id', 'evidence', 'finding_ids'],
            properties: {
                obligation_id: { type: 'string', minLength: 1 },
                evidence: {
                    type: 'array',
                    minItems: 1,
                    items: { $ref: '#/definitions/evidence' }
                },
                finding_ids: {
                    type: 'array',
                    items: { type: 'string', pattern: '^F-\\d{3}$' }
                }
            }
        },
        review_execution: {
            type: 'object',
            additionalProperties: false,
            required: [
                'mode',
                'contract_sha256',
                'covered_delta_targets',
                'inspected_prior_finding_ids'
            ],
            properties: {
                mode: { enum: ['FULL', 'DELTA'] },
                contract_sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
                covered_delta_targets: {
                    type: 'array',
                    items: { type: 'string', minLength: 1 },
                    uniqueItems: true
                },
                inspected_prior_finding_ids: {
                    type: 'array',
                    items: { type: 'string', pattern: '^F-\\d{3}$' },
                    uniqueItems: true
                }
            }
        },
        findings_by_severity: {
            type: 'object',
            additionalProperties: false,
            required: ['critical', 'high', 'medium', 'low'],
            properties: {
                critical: {
                    type: 'array',
                    items: { $ref: '#/definitions/finding' }
                },
                high: {
                    type: 'array',
                    items: { $ref: '#/definitions/finding' }
                },
                medium: {
                    type: 'array',
                    items: { $ref: '#/definitions/finding' }
                },
                low: {
                    type: 'array',
                    items: { $ref: '#/definitions/finding' }
                }
            }
        },
        finding: {
            type: 'object',
            additionalProperties: false,
            required: ['id', 'title', 'description', 'evidence', 'coverage_obligation_ids'],
            properties: {
                id: { type: 'string', pattern: '^F-\\d{3}$' },
                title: { type: 'string', minLength: 1 },
                description: { type: 'string', minLength: 1 },
                evidence: {
                    type: 'array',
                    minItems: 1,
                    items: { $ref: '#/definitions/evidence' }
                },
                coverage_obligation_ids: {
                    type: 'array',
                    minItems: 1,
                    items: { type: 'string', minLength: 1 }
                }
            }
        },
        residual_risk: {
            type: 'object',
            additionalProperties: false,
            required: ['id', 'description', 'evidence'],
            properties: {
                id: { type: 'string', pattern: '^R-\\d{3}$' },
                description: { type: 'string', minLength: 1 },
                evidence: {
                    type: 'array',
                    minItems: 1,
                    items: { $ref: '#/definitions/evidence' }
                }
            }
        }
    }
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeString(value: unknown): string | null {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeSha256(value: unknown): string | null {
    const normalized = normalizeString(value);
    return normalized && /^[a-f0-9]{64}$/u.test(normalized) ? normalized : null;
}

function pushUnknownKeyViolations(
    subject: string,
    input: Record<string, unknown>,
    allowedKeys: ReadonlySet<string>,
    violations: string[]
): void {
    for (const key of Object.keys(input)) {
        if (!allowedKeys.has(key)) {
            violations.push(`${subject} contains unknown field '${key}'.`);
        }
    }
}

function collectForbiddenDecisionKeys(value: unknown, path: string, violations: string[]): void {
    if (Array.isArray(value)) {
        value.forEach((entry, index) => collectForbiddenDecisionKeys(entry, `${path}[${index}]`, violations));
        return;
    }
    if (!isRecord(value)) {
        return;
    }
    for (const [key, nestedValue] of Object.entries(value)) {
        if (REVIEW_FINDINGS_FORBIDDEN_DECISION_KEYS.has(key.toLowerCase())) {
            violations.push(`${path}.${key} is a reviewer-owned verdict/remediation decision field and is forbidden.`);
        }
        collectForbiddenDecisionKeys(nestedValue, `${path}.${key}`, violations);
    }
}

function parseEvidenceArray(
    value: unknown,
    subject: string,
    violations: string[],
    allowEmptyEvidence = false
): ReviewFindingsEvidence[] {
    if (!Array.isArray(value)) {
        violations.push(`${subject}.evidence must be an array.`);
        return [];
    }
    const evidence: ReviewFindingsEvidence[] = [];
    value.forEach((entry, index) => {
        const entrySubject = `${subject}.evidence[${index}]`;
        if (!isRecord(entry)) {
            violations.push(`${entrySubject} must be an object.`);
            return;
        }
        pushUnknownKeyViolations(entrySubject, entry, EVIDENCE_KEYS, violations);
        const location = normalizeString(entry.location);
        const observation = normalizeString(entry.observation);
        if (!location) {
            violations.push(`${entrySubject}.location is required.`);
        }
        if (!observation) {
            violations.push(`${entrySubject}.observation is required.`);
        }
        if (location && observation) {
            evidence.push({ location, observation });
        }
    });
    if (evidence.length === 0 && !allowEmptyEvidence) {
        violations.push(`${subject}.evidence must contain at least one concrete evidence item.`);
    }
    return evidence;
}

function parseStringArray(value: unknown, subject: string, violations: string[]): string[] {
    if (!Array.isArray(value)) {
        violations.push(`${subject} must be an array.`);
        return [];
    }
    const entries: string[] = [];
    value.forEach((entry, index) => {
        const normalized = normalizeString(entry);
        if (!normalized) {
            violations.push(`${subject}[${index}] must be a non-empty string.`);
            return;
        }
        entries.push(normalized);
    });
    return entries;
}

interface ParsedValidationNoteFields {
    subject: string;
    id: string | null;
    topic: string | null;
    note: string | null;
    evidence: ReviewFindingsEvidence[];
    command: string | null;
    commandOutcome: string | null;
    diagnostics: string | null;
    findingIds: string[];
    isFocusedSelfValidation: boolean;
    hasFocusedCommandFields: boolean;
    requiresFocusedCommandFields: boolean;
    allowsEmptyEvidence: boolean;
}

function readValidationNoteFields(
    entry: Record<string, unknown>,
    subject: string,
    violations: string[],
    emptyReviewScope = false
): ParsedValidationNoteFields {
    pushUnknownKeyViolations(subject, entry, VALIDATION_NOTE_KEYS, violations);
    const topic = normalizeString(entry.topic);
    const command = typeof entry.command === 'string' && entry.command.trim() ? entry.command : null;
    const commandOutcome = normalizeString(entry.command_outcome)?.toLowerCase() || null;
    const diagnostics = normalizeString(entry.diagnostics);
    const findingIds = entry.finding_ids === undefined
        ? []
        : parseStringArray(entry.finding_ids, `${subject}.finding_ids`, violations);
    const isFocusedSelfValidation = topic?.toLowerCase() === REVIEWER_FOCUSED_SELF_VALIDATION_TOPIC;
    const hasFocusedCommandFields = command !== null
        || commandOutcome !== null
        || diagnostics !== null
        || entry.finding_ids !== undefined;
    const allowsEmptyEvidence = emptyReviewScope && !isFocusedSelfValidation && !hasFocusedCommandFields;
    return {
        subject,
        id: normalizeString(entry.id),
        topic,
        note: normalizeString(entry.note),
        evidence: parseEvidenceArray(entry.evidence, subject, violations, allowsEmptyEvidence),
        command,
        commandOutcome,
        diagnostics,
        findingIds,
        isFocusedSelfValidation,
        hasFocusedCommandFields,
        requiresFocusedCommandFields: isFocusedSelfValidation || hasFocusedCommandFields,
        allowsEmptyEvidence
    };
}

function validateValidationNoteIdentity(fields: ParsedValidationNoteFields, violations: string[]): void {
    if (!fields.id || !REVIEW_VALIDATION_NOTE_ID_PATTERN.test(fields.id)) {
        violations.push(`${fields.subject}.id must match N-###.`);
    }
    if (!fields.topic) {
        violations.push(`${fields.subject}.topic is required.`);
    }
    if (!fields.note) {
        violations.push(`${fields.subject}.note is required.`);
    }
}

function validateFocusedValidationNoteMetadata(
    fields: ParsedValidationNoteFields,
    violations: string[]
): void {
    if (fields.hasFocusedCommandFields && !fields.isFocusedSelfValidation) {
        violations.push(
            `${fields.subject}.topic must be '${REVIEWER_FOCUSED_SELF_VALIDATION_TOPIC}' when focused command evidence is recorded.`
        );
    }
    if (!fields.command) {
        violations.push(`${fields.subject}.command is required when focused command evidence is recorded.`);
    }
    if (!fields.commandOutcome || !['passed', 'failed', 'unavailable', 'prohibited'].includes(fields.commandOutcome)) {
        violations.push(`${fields.subject}.command_outcome must be passed, failed, unavailable, or prohibited.`);
    }
    if (!fields.diagnostics) {
        violations.push(`${fields.subject}.diagnostics is required when focused command evidence is recorded.`);
    } else if (!isActionableFocusedDiagnostics(fields.diagnostics)) {
        violations.push(
            `${fields.subject}.diagnostics must contain concrete, actionable command result detail rather than a placeholder.`
        );
    }
}

function validateFocusedValidationNoteFindingLinks(
    fields: ParsedValidationNoteFields,
    violations: string[]
): void {
    const invalidFindingId = fields.findingIds.find((findingId) => (
        !REVIEW_FINDINGS_ID_PATTERN.test(findingId) || findingId === 'F-000'
    ));
    if (invalidFindingId) {
        violations.push(`${fields.subject}.finding_ids may contain only ordinary F-### finding ids, excluding F-000.`);
    }
    if (fields.commandOutcome === 'failed' && fields.findingIds.length === 0) {
        violations.push(
            `${fields.subject} requires an ordinary severity finding when a focused command fails; `
            + 'finding_ids must link that failure to at least one ordinary finding.'
        );
    }
    if (fields.commandOutcome && fields.commandOutcome !== 'failed' && fields.findingIds.length > 0) {
        violations.push(`${fields.subject}.finding_ids is allowed only when command_outcome is failed.`);
    }
}

function validateFocusedValidationNoteCommand(
    fields: ParsedValidationNoteFields,
    violations: string[],
    repoRoot?: string,
    expectedTaskId?: string
): void {
    if (!fields.command) {
        return;
    }
    const commandInspection = inspectReviewerFocusedValidationCommand(fields.command, repoRoot);
    violations.push(...commandInspection.violations);
    if (
        commandInspection.target
        && fields.commandOutcome !== 'passed'
        && !focusedEvidenceExplainsTargetRelevance(fields.evidence, commandInspection.target, expectedTaskId)
    ) {
        violations.push(
            'Reviewer focused self-validation authenticated changed-file evidence must name the exact focused command target and why it is relevant in one clause: that same clause must include the current task id or affected/changed/modified/new/updated plus a relationship verb such as validates/covers/exercises/asserts. Semicolons, newlines, sentence punctuation, and contrastive conjunctions but/however/whereas/while start a new clause. Keep evidence.location inside the assigned lane domain and put the target path in evidence.observation when necessary, rather than only in note, command, or diagnostics.'
        );
    }
}

function validateFocusedValidationNote(
    fields: ParsedValidationNoteFields,
    violations: string[],
    repoRoot?: string,
    expectedTaskId?: string
): void {
    if (!fields.requiresFocusedCommandFields) {
        return;
    }
    validateFocusedValidationNoteMetadata(fields, violations);
    validateFocusedValidationNoteFindingLinks(fields, violations);
    validateFocusedValidationNoteCommand(fields, violations, repoRoot, expectedTaskId);
}

function buildValidationNote(fields: ParsedValidationNoteFields): ReviewFindingsValidationNote | null {
    if (
        !fields.id
        || !fields.topic
        || !fields.note
        || (fields.evidence.length === 0 && !fields.allowsEmptyEvidence)
        || (fields.requiresFocusedCommandFields
            && (!fields.command || !fields.commandOutcome || !fields.diagnostics))
    ) {
        return null;
    }
    const baseNote = {
        id: fields.id,
        topic: fields.topic,
        note: fields.note,
        evidence: fields.evidence
    };
    if (!fields.requiresFocusedCommandFields) {
        return baseNote;
    }
    return {
        ...baseNote,
        command: fields.command as string,
        command_outcome: fields.commandOutcome as ReviewFocusedCommandOutcome,
        diagnostics: fields.diagnostics as string,
        ...(fields.findingIds.length > 0 ? { finding_ids: fields.findingIds } : {})
    };
}

function parseValidationNotes(
    value: unknown,
    violations: string[],
    repoRoot?: string,
    expectedTaskId?: string,
    emptyReviewScope = false
): ReviewFindingsValidationNote[] {
    if (!Array.isArray(value)) {
        violations.push('validation_notes must be an array.');
        return [];
    }
    const notes: ReviewFindingsValidationNote[] = [];
    const ids: string[] = [];
    value.forEach((entry, index) => {
        const subject = `validation_notes[${index}]`;
        if (!isRecord(entry)) {
            violations.push(`${subject} must be an object.`);
            return;
        }
        const fields = readValidationNoteFields(entry, subject, violations, emptyReviewScope);
        validateValidationNoteIdentity(fields, violations);
        validateFocusedValidationNote(fields, violations, repoRoot, expectedTaskId);
        if (fields.id && REVIEW_VALIDATION_NOTE_ID_PATTERN.test(fields.id)) {
            ids.push(fields.id);
        }
        const note = buildValidationNote(fields);
        if (note) {
            notes.push(note);
        }
    });
    pushDuplicateViolations('validation note', ids, violations);
    if (notes.length === 0) {
        violations.push('validation_notes must contain at least one validation note.');
    }
    return notes;
}

function escapeFocusedPatternLiteral(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

const MISSING_FOCUSED_TARGET_CAPTURE_PATTERN =
    '([^\\s;\\r\\n](?:[^;\\r\\n]*[^\\s;\\r\\n])?)';
const MISSING_FOCUSED_VALIDATION_MARKER_PATTERN = new RegExp(
    `^${escapeFocusedPatternLiteral(REVIEWER_MISSING_FOCUSED_VALIDATION_MARKER)}\\s+`
    + `(?:test=${MISSING_FOCUSED_TARGET_CAPTURE_PATTERN};\\s*`
    + `action=${escapeFocusedPatternLiteral(REVIEWER_MISSING_FOCUSED_TEST_ACTION)}`
    + `|target=${MISSING_FOCUSED_TARGET_CAPTURE_PATTERN};\\s*`
    + `action=${escapeFocusedPatternLiteral(REVIEWER_MISSING_FOCUSED_VALIDATION_ACTION)})$`,
    'u'
);
const MISSING_FOCUSED_VALIDATION_CLAIM_PATTERN =
    /\b(?:missing|absent|no)\s+(?:prior\s+)?focused\s+(?:(?:test|check|validation)\s+)?(?:execution|run|evidence)\b|\bfocused\s+(?:test|check|validation|execution)(?:\s+(?:execution|run|evidence))?\b.{0,48}\b(?:missing|absent|unavailable|prohibited|not\s+(?:run|executed))\b|\b(?:could\s+not|cannot|can't|unable\s+to)\s+(?:run|execute)\b.{0,48}\bfocused\s+(?:test|check|validation)\b/iu;
const REVIEWER_UNSAFE_FOCUSED_COMMAND_PATTERNS: ReadonlyArray<{ pattern: RegExp; reason: string; unquotedOnly?: boolean }> = [
    {
        pattern: /^\s*(?:(?:curl|wget|ssh|scp|sftp|ftp|telnet|nc|netcat|invoke-webrequest|invoke-restmethod|iwr|irm)\b|git\s+(?:clone|fetch|pull|push)\b|(?:npm|pnpm|yarn|bun)\s+(?:install|add|update|publish)\b|pip\s+install\b)/iu,
        reason: 'access network services or install/publish dependencies'
    },
    {
        pattern: /^\s*(?:(?:rm|del|erase|cp|mv|tee|touch|mkdir|md|set-content|add-content|out-file|new-item|remove-item|copy-item|move-item|apply_patch)\b|git\s+(?:add|commit|checkout|switch|reset|restore|clean|stash)\b|sed\s+-i\b)|\brequire\([^)]*(?:node:)?fs[^)]*\)\s*\.\s*(?:promises\s*\.\s*)?(?:writefile|writefilesync|appendfile|appendfilesync|mkdir|mkdirsync|unlink|unlinksync|rm|rmsync|rename|renamesync)\b|(?<![=<>-])>{1,2}(?![=&])/iu,
        reason: 'mutate source, control, or handoff artifacts'
    },
    {
        pattern: /(?:^|\s)(?:--fix|--write|--update|--update-snapshot|--update-snapshots|--updatesnapshot|--snapshot-update|--accept|--bless|--rewrite|--overwrite)(?:=|\s|$)|(?:^|\s)-(?:u|w)(?=\s|$)/iu,
        reason: 'use validation-runner flags that may mutate source files or snapshots'
    },
    {
        pattern: /^\s*(?:(?:npx|bunx)\b|(?:npm|pnpm|yarn|bun)\s+(?:exec|dlx|x)\b)/iu,
        reason: 'use package-execution wrappers that may fetch dependencies implicitly'
    },
    {
        pattern: /(?:^|[/\\])\.\.(?:[/\\]|$)|(?:^|[\s"'=])[a-z]:|(?:^|[\s"'=])\/(?!\/)/iu,
        reason: 'escape authenticated repository scope with absolute or traversal paths'
    },
    {
        pattern: REVIEWER_INLINE_INTERPRETER_COMMAND_PATTERN,
        reason: REVIEWER_INLINE_INTERPRETER_REASON
    },
    {
        pattern: /\$\(|`/u,
        reason: 'run shell command substitutions inside a focused validation attempt'
    },
    {
        pattern: /\$[\p{L}\p{N}_{?@*#!$-]|%[^%\r\n]*%|%[0-9*~]/iu,
        reason: 'use shell variable, brace, bracket, or home expansions inside a focused validation attempt'
    },
    {
        pattern: /\{[^}]*\}|\[[^\]]*\]|(?:^|\s)~(?:[/\\]|\s|$)/iu,
        reason: 'use shell variable, brace, bracket, or home expansions inside a focused validation attempt',
        unquotedOnly: true
    },
    {
        pattern: /![a-z_][a-z0-9_]*!/iu,
        reason: 'use shell redirection, process expansion, escaping, or response-file expansion inside a focused validation attempt'
    },
    {
        pattern: /[<>^]/iu,
        reason: 'use shell redirection, process expansion, escaping, or response-file expansion inside a focused validation attempt',
        unquotedOnly: true
    },
    {
        pattern: /^\s*(?:(?:npm(?:\.cmd|\.exe)?|pnpm|yarn|bun)(?:\s+--?[^\s]+)*\s+(?:run\s+)?(?:build|test|check|lint)(?:\s+--?[^\s]+)*|(?:mvnw?|gradlew?|dotnet)\s+(?:build|test)|pytest)\s*$/iu,
        reason: 'run a broad build, full suite, or gate-owned validation command'
    },
    {
        pattern: /^\s*node(?:\.exe)?\s+(?:--test|scripts[/\\]node-foundation[/\\]build-scripts\.cjs\s+test\.js)\s*$/iu,
        reason: 'run a broad build, full suite, or gate-owned validation command'
    },
    {
        pattern: /^\s*(?:(?:nohup|start|start-process|start-job|systemctl|service)\b|docker(?:\s+compose)?\s+up\b)|&\s*$/iu,
        reason: 'start background processes or services'
    },
    {
        pattern: /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u,
        reason: 'use ambiguous shell control characters'
    },
    {
        pattern: /[\u2018\u2019\u201c\u201d]/u,
        reason: 'use ambiguous typographic shell quotes'
    },
    {
        pattern: /[\r\n]/u,
        reason: 'chain or pipe multiple commands in one focused validation attempt'
    }
];
const REVIEWER_MUTATING_FOCUSED_OPTION_NAMES = new Set([
    '--accept', '--bless', '--fix', '--overwrite', '--rewrite', '--snapshot-update', '--update',
    '--update-snapshot', '--update-snapshots', '--updatesnapshot', '--write', '-u', '-w'
]);
const REVIEWER_OUTPUT_FOCUSED_OPTION_NAMES = new Set([
    '--coverage', '--coverage-directory', '--coveragedirectory', '--emitdeclarationonly', '--junitxml',
    '--output', '--output-file', '--outputfile', '--reporter-output', '--test-reporter-destination', '-o'
]);
const REVIEWER_INTERACTIVE_FOCUSED_OPTION_NAMES = new Set([
    '--debug', '--inspect', '--inspect-brk', '--open', '--serve', '--ui', '--watch', '--watch-all', '--watchall'
]);
const REVIEWER_SAFE_FOCUSED_OPTION_NAMES = new Set([
    '--', '--bail', '--color', '--filter', '--grep', '--match', '--maxworkers', '--no-cache', '--no-color',
    '--no-warnings', '--noemit', '--pattern', '--pretty', '--run', '--runinband', '--silent', '--test',
    '--test-name-pattern', '--test-only', '--testnamepattern', '--threads', '--verbose', '-g', '-k', '-m', '-p', '-t'
]);

function focusedCommandTokenBasename(token: string): string {
    return token.replace(/\\/gu, '/').split('/').pop()?.toLowerCase() || '';
}

function reviewerCommandInvokesGarda(command: string): boolean {
    const tokens = getFocusedCommandTokens(command);
    const firstToken = tokens[0] || '';
    const firstBasename = focusedCommandTokenBasename(firstToken);
    if (/^garda(?:\.cmd|\.exe)?$/u.test(firstBasename) || firstBasename === 'garda.js') {
        return true;
    }
    if (/^node(?:\.exe)?$/u.test(firstBasename)) {
        const scriptIndex = parseFocusedCommandOptions(tokens).programIndex;
        return scriptIndex >= 0
            && !getFocusedRuntimeInvocation(tokens).nodeValidationMode
            && focusedCommandTokenBasename(tokens[scriptIndex]) === 'garda.js';
    }
    if (!/^(?:npx|bunx|npm(?:\.cmd|\.exe)?|pnpm|yarn|bun)$/u.test(firstBasename)) {
        return false;
    }
    let packageTargetIndex = findNextFocusedCommandToken(tokens, 1);
    if (packageTargetIndex >= 0 && /^(?:exec|dlx|x)$/iu.test(tokens[packageTargetIndex])) {
        packageTargetIndex = findNextFocusedCommandToken(tokens, packageTargetIndex + 1);
    }
    return packageTargetIndex >= 0
        && /^garda(?:\.cmd|\.exe)?$/u.test(focusedCommandTokenBasename(tokens[packageTargetIndex]));
}

function getUnsafeFocusedCommandReason(command: string): string | null {
    if (reviewerCommandInvokesGarda(command)) return 'invoke Garda navigation, gate, or result commands';
    const syntax = parseFocusedCommandSyntax(command);
    const scopedOperands = getFocusedNodeLoaderOperands(syntax.tokens)
        .filter(({ value }) => value.startsWith('@') && value.includes('/')
            && isSafeRepositoryRelativeFocusedTarget(value) && REVIEWER_NODE_LOADER_MODULE_PATTERN.test(value));
    const scopedIndexes = new Set(scopedOperands.map(({ valueIndex }) => valueIndex));
    const unsafeResponse = syntax.tokens.some((token, index) => /^@/u.test(token) && !scopedIndexes.has(index));
    return REVIEWER_UNSAFE_FOCUSED_COMMAND_PATTERNS.find(({ pattern, unquotedOnly }) => pattern.test(unquotedOnly ? syntax.unquotedText : command))?.reason
        || getUnsafeFocusedCommandShellReason(command, new Set(scopedOperands.map(({ value }) => value)))
        || (unsafeResponse ? 'use shell redirection, process expansion, escaping, or response-file expansion inside a focused validation attempt' : null)
        || syntax.invalidSyntaxReason
        || getUnsafeFocusedCommandTokenReason(command)
        || null;
}

function getUnsafeFocusedCommandShellReason(command: string, scopedLoaders: ReadonlySet<string>): string | null {
    let quote: string | null = null;
    for (let index = 0; index < command.length; index += 1) {
        const character = command[index];
        // Escaped quotes differ across supported shells; do not guess their boundaries.
        if (character === '\\' && /["']/u.test(command[index + 1] || '')) {
            return 'use ambiguous escaped shell quotes';
        }
        if (character === '!' && (quote !== null || command[index + 1] !== '(')) {
            return 'use shell history or delayed expansions inside a focused validation attempt';
        }
        if (quote !== null) {
            if (character === quote) {
                quote = null;
            }
            continue;
        }
        if (character === '\\' && /[\s.]/u.test(command[index + 1] || '')) {
            return 'use ambiguous unquoted shell escaping';
        }
        if (/\s/u.test(character) && character !== ' ' && character !== '\t') {
            return 'use ambiguous shell whitespace';
        }
        if (character === '~') {
            return 'use unquoted shell home expansions inside a focused validation attempt';
        }
        if (character === '#' || (character === '@' && command[index + 1] !== '('
            && ![...scopedLoaders].some((value) => command.startsWith(value, index)))) {
            return 'use unquoted shell comment or splatting syntax; use shell redirection, process expansion, escaping, or response-file expansion inside a focused validation attempt';
        }
        if (character === '$' && /["']/u.test(command[index + 1] || '')) {
            return 'use shell quoted-string expansions inside a focused validation attempt';
        }
        if (character === '"') {
            quote = character;
        } else if (character === "'") {
            return 'use shell-dependent single quoting without an execution-shell binding';
        } else if (/[;&|]/u.test(character)) {
            return 'chain or pipe multiple commands in one focused validation attempt';
        } else if (/[()*?]/u.test(character)) {
            return 'use unquoted shell wildcard or grouping syntax inside a focused validation attempt';
        }
    }
    return quote === null ? null : 'use unterminated shell quoting';
}

function normalizeFocusedTargetPath(value: string): string {
    return value.replace(/\\/gu, '/').replace(/^(?:\.\/)+/u, '');
}

const REVIEWER_FOCUSED_EXECUTION_SIGNAL_PATTERN =
    /(?:^|[\s/\\._:-])(?:test|spec|check|lint|validat|verif|audit|bench)[a-z0-9]*(?=$|[\s/\\._:=#-])|(?:^|[\s/\\._:-])(?:vitest|jest|mocha|ava|tap|pytest|rspec|phpunit|playwright|cypress|spectral|ajv|eslint|tsc|hyperfine)(?=$|[\s/\\._:=#-])/iu;
const REVIEWER_GENERIC_FOCUSED_COMMAND_TOKEN_PATTERN =
    /^(?:node(?:\.exe)?|deno|bun|python(?:3)?|pytest|ruby|perl|php|tsx|ts-node|npx|npm(?:\.cmd|\.exe)?|pnpm|yarn|mvnw?|gradlew?|dotnet|go|cargo|make|just|java|openssl|spectral|ajv|eslint|tsc|vitest|jest|mocha|ava|tap|rspec|phpunit|playwright|cypress|hyperfine|powershell|pwsh|bash|sh|zsh|run|exec|test|tests|spec|check|lint|validate|validation|verify|audit|bench|build)$/iu;
const REVIEWER_DIRECT_VALIDATION_RUNNER_PATTERN =
    /^(?:pytest|spectral|ajv|eslint|tsc|vitest|jest|mocha|ava|tap|rspec|phpunit|playwright|cypress|hyperfine)$/iu;
const REVIEWER_DIRECT_VALIDATION_RUNNER_SUBCOMMANDS: Readonly<Record<string, readonly string[]>> = {
    ajv: ['validate'],
    cypress: ['run'],
    playwright: ['test'],
    spectral: ['lint'],
    vitest: ['run']
};
const REVIEWER_GENERIC_RUNTIME_PATTERN =
    /^(?:node(?:\.exe)?|deno|python(?:3)?|ruby|perl|php|tsx|ts-node|java|powershell|pwsh|bash|sh|zsh)$/iu;
const REVIEWER_PACKAGE_MANAGER_PATTERN = /^(?:npm(?:\.cmd|\.exe)?|pnpm|yarn|bun)$/iu;
const REVIEWER_PACKAGE_EXEC_WRAPPER_PATTERN = /^(?:npx|bunx)$/iu;
const REVIEWER_BUILD_OR_VALIDATION_TOOL_PATTERN = /^(?:mvnw?|gradlew?|dotnet|go|cargo|make|just|openssl)$/iu;
const REVIEWER_NODE_FOUNDATION_TEST_WRAPPER_PATTERN = /^scripts\/node-foundation\/build-scripts\.cjs$/iu;
const REVIEWER_DIRECT_TEST_TARGET_PATTERN =
    /^(?:tests?\/.*|(?:.*\/)?[^/]+\.(?:test|spec)\.(?:c|m)?[jt]sx?)$/iu;
const REVIEWER_FOCUSED_FILE_TARGET_PATTERN =
    /(?:^|\/)[^/]+\.[a-z0-9][a-z0-9._-]*(?:(?:::|#).*)?$/iu;
const REVIEWER_EXTENSIONLESS_FILE_TARGET_PATTERN =
    /(?:^|\/)(?:Brewfile|Dockerfile|Gemfile|Jenkinsfile|Justfile|LICENSE|Makefile|NOTICE|Procfile|Rakefile|Vagrantfile)$/iu;
const REVIEWER_NON_ACTIONABLE_DIAGNOSTICS_PATTERN =
    /^(?:n\/?a|none|null|unknown|tbd|todo|not applicable|unavailable|prohibited|blocked|failed|failure|error|-)\.?$/iu;
const REVIEWER_GENERIC_DIAGNOSTICS_SENTENCE_PATTERN =
    /^(?:(?:the|a)\s+)?(?:focused\s+)?(?:command|check|test|validation|attempt|execution|runner|runtime|target)(?:\s+(?:command|check|test|validation|attempt|execution|runner|runtime|result|outcome|target))?\s+(?:(?:is|was|has been)\s+)?(?:unavailable|prohibited|blocked|failed|passed|errored|an? error)\.?$/iu;
const REVIEWER_FOCUSED_OPTION_WITH_VALUE_PATTERN =
    /^(?:-k|-m|-t|-g|--grep|--filter|--test-name-pattern|--testnamepattern|--config|--project|--selectprojects|--testpathignorepatterns|--testpathpattern|--include|--exclude|--match|--pattern)$/iu;
const REVIEWER_FOCUSED_LITERAL_SELECTOR_OPTION_PATTERN =
    /^(?:-k|-t|-g|--grep|--filter|--test-name-pattern|--testnamepattern|--testpathignorepatterns|--testpathpattern|--match|--pattern)$/iu;
const REVIEWER_FOCUSED_OPTION_WITH_SCALAR_VALUE_PATTERN =
    /^(?:--bail|--color|--maxworkers|--pretty|--threads|--verbose)$/iu;
const REVIEWER_FOCUSED_SCALAR_OPTION_VALUE_PATTERN = /^(?:false|true|\d+)$/iu;
const REVIEWER_NODE_LOADER_OPTION_NAMES = new Set([
    '--import', '--require', '-r', '--loader', '--experimental-loader'
]);
const REVIEWER_NODE_LOADER_MODULE_PATTERN = /^(?:[a-z0-9_.-][a-z0-9_./ -]*|@[a-z0-9_.-]+\/[a-z0-9_./ -]+)$/iu;
const REVIEWER_GENERIC_DIAGNOSTICS_WORDS = new Set([
    'a', 'an', 'attempt', 'be', 'been', 'blocked', 'can', 'check', 'command', 'could', 'error', 'errored',
    'execute', 'executed', 'execution', 'failed', 'failure', 'focused', 'had', 'has', 'have', 'is', 'not',
    'outcome', 'passed', 'prohibited', 'result', 'run', 'runner', 'runtime', 'target', 'test', 'the', 'unknown',
    'unavailable', 'validation', 'was', 'were'
]);
const REVIEWER_CONCRETE_DIAGNOSTIC_COUNT_PATTERN =
    /\b\d+\s+(?:assertions?|cases?|checks?|errors?|failures?|tests?)\b/iu;

function getFocusedCommandTokens(command: string): string[] {
    return parseFocusedCommandSyntax(command).tokens;
}

function normalizeFocusedOptionName(token: string): string {
    return token.toLowerCase().split('=', 1)[0];
}

interface FocusedNodeLoaderOperand {
    optionIndex: number;
    valueIndex: number | null;
    value: string;
}

function getFocusedNodeLoaderOperands(tokens: readonly string[]): FocusedNodeLoaderOperand[] {
    if (!/^node(?:\.exe)?$/iu.test(tokens[0] || '')) return [];
    const operands: FocusedNodeLoaderOperand[] = [];
    for (let index = 1; index < tokens.length; index += 1) {
        const token = tokens[index];
        if (token === '--' || !token.startsWith('-')) break;
        if (REVIEWER_NODE_LOADER_OPTION_NAMES.has(normalizeFocusedOptionName(token))) {
            const equalsIndex = token.indexOf('=');
            const valueIndex = equalsIndex < 0 && tokens[index + 1] && !tokens[index + 1].startsWith('-')
                ? index + 1 : null;
            operands.push({
                optionIndex: index,
                valueIndex,
                value: normalizeFocusedTargetPath(equalsIndex >= 0 ? token.slice(equalsIndex + 1) : valueIndex == null ? '' : tokens[valueIndex])
            });
            if (valueIndex != null) index = valueIndex;
        } else if (!token.includes('=') && (
            REVIEWER_FOCUSED_OPTION_WITH_VALUE_PATTERN.test(token)
            || REVIEWER_FOCUSED_OPTION_WITH_SCALAR_VALUE_PATTERN.test(token)
                && REVIEWER_FOCUSED_SCALAR_OPTION_VALUE_PATTERN.test(tokens[index + 1] || '')
        )) {
            index += 1;
        }
    }
    return operands;
}

function getUnsafeNodeLoaderReason(tokens: readonly string[], operands: readonly FocusedNodeLoaderOperand[]): string | null {
    if (operands.length === 0) return null;
    const runnerIndex = parseFocusedCommandOptions(tokens).programIndex;
    const runtimeOptions = [...parseFocusedCommandOptions(tokens).optionIndexes]
        .filter((index) => runnerIndex < 0 || index < runnerIndex).map((index) => tokens[index]);
    if (runtimeOptions.includes('--check') || (!runtimeOptions.includes('--test')
        && !REVIEWER_DIRECT_TEST_TARGET_PATTERN.test(tokens[runnerIndex] || ''))) {
        return 'use unrecognized validation-runner options outside a focused Node test';
    }
    return operands.some(({ value }) => !value || !isSafeRepositoryRelativeFocusedTarget(value)
        || !REVIEWER_NODE_LOADER_MODULE_PATTERN.test(value))
        ? 'use Node loader options without a supported repository-relative module operand'
        : null;
}

function isSafeNodeSyntaxCheckToken(
    tokens: readonly string[], optionIndex: number,
    options: FocusedCommandOptionParseResult, programIndex: number
): boolean {
    return /^node(?:\.exe)?$/iu.test(tokens[0] || '')
        && tokens[optionIndex] === '--check'
        && optionIndex > 0
        && ((!options.optionIndexes.has(optionIndex) && options.consumedIndexes.has(optionIndex))
            || (optionIndex < programIndex
                && (options.terminatorIndex < 0 || optionIndex < options.terminatorIndex)));
}

function getUnsafeFocusedCommandTokenReason(command: string): string | null {
    const tokens = getFocusedCommandTokens(command);
    const mavenCommand = parseMavenFocusedCommand(tokens);
    if (mavenCommand) return mavenCommand.unsafeReason;
    const options = parseFocusedCommandOptions(tokens);
    const loaderOperands = getFocusedNodeLoaderOperands(tokens);
    const loaderReason = getUnsafeNodeLoaderReason(tokens, loaderOperands);
    if (loaderReason) return loaderReason;
    const valueIndexes = new Set([...options.consumedIndexes].filter((index) => !options.optionIndexes.has(index)));
    const optionTokens = tokens.filter((_, index) => !valueIndexes.has(index));
    // Quoted fragments can conceal path prefixes until their tokens are reconstructed.
    if (tokens.some((token, index) => !options.literalSelectorValueIndexes.has(index)
        && /^(?:\/|[a-z]:)|(?:^|\/)\.\.(?:\/|$)/iu.test(normalizeFocusedTargetPath(token)))) {
        return 'escape authenticated repository scope with absolute or traversal paths';
    }
    const firstToken = tokens[0] || '';
    const optionNames = optionTokens.filter((token) => token.startsWith('-')).map(normalizeFocusedOptionName);
    if (REVIEWER_PACKAGE_EXEC_WRAPPER_PATTERN.test(firstToken)) {
        return 'use package-execution wrappers that may fetch dependencies implicitly';
    }
    if (
        REVIEWER_PACKAGE_MANAGER_PATTERN.test(firstToken)
        && tokens.slice(1).some((token) => /^(?:exec|dlx|x)$/iu.test(token))
    ) {
        return 'use package-execution wrappers that may fetch dependencies implicitly';
    }
    if (hasReviewerInlineInterpreterOption(firstToken, optionTokens)) {
        return REVIEWER_INLINE_INTERPRETER_REASON;
    }
    if (optionNames.some((option) => REVIEWER_MUTATING_FOCUSED_OPTION_NAMES.has(option))) {
        return 'use validation-runner flags that may mutate source files or snapshots';
    }
    if (optionNames.some((option) => REVIEWER_OUTPUT_FOCUSED_OPTION_NAMES.has(option))) {
        return 'use validation-runner flags that may write output artifacts';
    }
    if (optionNames.some((option) => REVIEWER_INTERACTIVE_FOCUSED_OPTION_NAMES.has(option))) {
        return 'use interactive, watching, serving, or debugger validation-runner flags';
    }
    if (/^tsc$/iu.test(firstToken) && !optionNames.includes('--noemit')) {
        return 'run TypeScript compilation without --noEmit, which may write output artifacts';
    }
    const programIndex = options.programIndex;
    if (tokens.some((token, index) => token.startsWith('-')
        && !valueIndexes.has(index)
        && !loaderOperands.some((operand) => operand.optionIndex === index)
        && !REVIEWER_SAFE_FOCUSED_OPTION_NAMES.has(normalizeFocusedOptionName(token))
        && !isSafeNodeSyntaxCheckToken(tokens, index, options, programIndex))) {
        return 'use unrecognized validation-runner options whose side effects are not authenticated';
    }
    return null;
}

function findNextFocusedCommandToken(tokens: readonly string[], startIndex: number): number {
    for (let index = startIndex; index < tokens.length; index += 1) {
        if (tokens[index] !== '--' && !tokens[index].startsWith('-')) {
            return index;
        }
    }
    return -1;
}

function isFocusedExecutionSignalToken(token: string): boolean {
    return REVIEWER_FOCUSED_EXECUTION_SIGNAL_PATTERN.test(token);
}

function isFocusedNodeValidationOption(firstToken: string, token: string): boolean {
    return /^node(?:\.exe)?$/iu.test(firstToken) && (token === '--test' || token === '--check');
}

interface FocusedRuntimeInvocation {
    hasValidationRunner: boolean;
    nodeValidationMode: boolean;
    runnerTokenIndexes: readonly number[];
}

function getFocusedRuntimeInvocation(tokens: readonly string[]): FocusedRuntimeInvocation {
    const firstToken = tokens[0] || '';
    const options = parseFocusedCommandOptions(tokens);
    const programIndex = options.programIndex;
    const optionEnd = Math.min(
        options.terminatorIndex >= 0 ? options.terminatorIndex : tokens.length,
        programIndex >= 0 ? programIndex : tokens.length
    );
    const prefixOptions = [...options.optionIndexes].filter((index) => index > 0 && index < optionEnd);
    const moduleFlagIndex = prefixOptions.find((index) => tokens[index] === '-m');
    if (moduleFlagIndex !== undefined) {
        return {
            hasValidationRunner: /^python(?:3)?$/iu.test(firstToken)
                && REVIEWER_DIRECT_VALIDATION_RUNNER_PATTERN.test(tokens[moduleFlagIndex + 1] || ''),
            nodeValidationMode: false,
            runnerTokenIndexes: [0, moduleFlagIndex, moduleFlagIndex + 1]
        };
    }
    if (prefixOptions.some((index) => isFocusedNodeValidationOption(firstToken, tokens[index]))) {
        return { hasValidationRunner: true, nodeValidationMode: true, runnerTokenIndexes: [0] };
    }
    if (programIndex < 0) {
        return { hasValidationRunner: false, nodeValidationMode: false, runnerTokenIndexes: [0] };
    }
    const program = normalizeFocusedTargetPath(tokens[programIndex]);
    const runnerTokenIndexes = [0];
    if (!REVIEWER_DIRECT_TEST_TARGET_PATTERN.test(program)) {
        runnerTokenIndexes.push(programIndex);
    }
    if (REVIEWER_NODE_FOUNDATION_TEST_WRAPPER_PATTERN.test(program)) {
        const commandIndex = programIndex + 1;
        if (commandIndex < tokens.length) runnerTokenIndexes.push(commandIndex);
        return {
            hasValidationRunner: commandIndex < tokens.length
                && !tokens[commandIndex].startsWith('-') && isFocusedExecutionSignalToken(tokens[commandIndex]),
            nodeValidationMode: false,
            runnerTokenIndexes
        };
    }
    return {
        hasValidationRunner: !program.startsWith('-')
            && !REVIEWER_DIRECT_VALIDATION_RUNNER_PATTERN.test(program)
            && isFocusedExecutionSignalToken(program),
        nodeValidationMode: false,
        runnerTokenIndexes
    };
}

function isActionableFocusedDiagnostics(diagnostics: string): boolean {
    const normalized = diagnostics.trim();
    const words = (normalized.match(/[a-z0-9]+/giu) || []).map((word) => word.toLowerCase());
    const detailWords = words.filter((word) => (
        !REVIEWER_GENERIC_DIAGNOSTICS_WORDS.has(word)
        && !/^\d+$/u.test(word)
    ));
    const hasConcreteCount = REVIEWER_CONCRETE_DIAGNOSTIC_COUNT_PATTERN.test(normalized);
    return normalized.length >= 12
        && words.length >= 3
        && (detailWords.length >= 2 || hasConcreteCount)
        && !REVIEWER_NON_ACTIONABLE_DIAGNOSTICS_PATTERN.test(normalized)
        && !REVIEWER_GENERIC_DIAGNOSTICS_SENTENCE_PATTERN.test(normalized);
}

function focusedCommandHasValidationRunner(command: string): boolean {
    const tokens = getFocusedCommandTokens(command);
    const mavenCommand = parseMavenFocusedCommand(tokens);
    if (mavenCommand) return !mavenCommand.unsafeReason;
    const firstToken = tokens[0] || '';
    if (REVIEWER_DIRECT_VALIDATION_RUNNER_PATTERN.test(firstToken)) {
        return true;
    }
    if (REVIEWER_GENERIC_RUNTIME_PATTERN.test(firstToken)) {
        return getFocusedRuntimeInvocation(tokens).hasValidationRunner;
    }
    if (REVIEWER_PACKAGE_MANAGER_PATTERN.test(firstToken) || REVIEWER_PACKAGE_EXEC_WRAPPER_PATTERN.test(firstToken)) {
        let runnerIndex = findNextFocusedCommandToken(tokens, 1);
        if (runnerIndex < 0) {
            return false;
        }
        if (/^(?:run|exec|dlx|x)$/iu.test(tokens[runnerIndex])) {
            runnerIndex = findNextFocusedCommandToken(tokens, runnerIndex + 1);
        }
        return runnerIndex >= 0 && (
            REVIEWER_DIRECT_VALIDATION_RUNNER_PATTERN.test(tokens[runnerIndex])
            || isFocusedExecutionSignalToken(tokens[runnerIndex])
        );
    }
    if (REVIEWER_BUILD_OR_VALIDATION_TOOL_PATTERN.test(firstToken)) {
        const runnerIndex = findNextFocusedCommandToken(tokens, 1);
        return runnerIndex >= 0 && isFocusedExecutionSignalToken(tokens[runnerIndex]);
    }
    const localProgramPath = firstToken.replace(/\\/gu, '/');
    return /(?:^|\/)\.?[^/]*[a-z0-9][^/]*$/iu.test(localProgramPath)
        && localProgramPath.includes('/')
        && isFocusedExecutionSignalToken(localProgramPath);
}

function isPathInsideFocusedRepository(repoRoot: string, candidatePath: string): boolean {
    const relativePath = path.relative(repoRoot, candidatePath);
    return relativePath !== '..'
        && !relativePath.startsWith(`..${path.sep}`)
        && !path.isAbsolute(relativePath);
}

function isExistingFocusedTargetFile(token: string, repoRoot?: string): boolean {
    if (!repoRoot) {
        return false;
    }
    try {
        const realRepoRoot = fs.realpathSync(repoRoot);
        const candidatePath = path.resolve(realRepoRoot, token);
        if (!isPathInsideFocusedRepository(realRepoRoot, candidatePath)) {
            return false;
        }
        const candidateStats = fs.lstatSync(candidatePath);
        return candidateStats.isFile()
            && !candidateStats.isSymbolicLink()
            && isPathInsideFocusedRepository(realRepoRoot, fs.realpathSync(candidatePath));
    } catch {
        return false;
    }
}

function isConcreteFocusedTargetToken(token: string, repoRoot?: string): boolean {
    const normalizedToken = normalizeFocusedTargetPath(token);
    if (
        !normalizedToken
        || normalizedToken === '.'
        || normalizedToken === '...'
        || normalizedToken === '--'
        || normalizedToken.startsWith('-')
        || /[*?\[\]{}$%]/u.test(normalizedToken)
        || normalizedToken.startsWith('~')
        || normalizedToken.startsWith('@')
        || REVIEWER_GENERIC_FOCUSED_COMMAND_TOKEN_PATTERN.test(normalizedToken)
    ) {
        return false;
    }
    if (!isSafeRepositoryRelativeFocusedTarget(normalizedToken)) {
        return false;
    }
    if (repoRoot) {
        return isExistingFocusedTargetFile(normalizedToken, repoRoot);
    }
    return REVIEWER_FOCUSED_FILE_TARGET_PATTERN.test(normalizedToken)
        || REVIEWER_EXTENSIONLESS_FILE_TARGET_PATTERN.test(normalizedToken);
}

function isDirectValidationRunnerSubcommand(runner: string, token: string): boolean {
    return (REVIEWER_DIRECT_VALIDATION_RUNNER_SUBCOMMANDS[runner.toLowerCase()] || [])
        .includes(token.toLowerCase());
}

function consumeGenericRuntimeTokens(tokens: readonly string[], consumedIndexes: Set<number>): void {
    for (const index of getFocusedRuntimeInvocation(tokens).runnerTokenIndexes) consumedIndexes.add(index);
}

function consumePackageManagerTokens(tokens: readonly string[], consumedIndexes: Set<number>): void {
    consumedIndexes.add(0);
    let runnerIndex = findNextFocusedCommandToken(tokens, 1);
    if (runnerIndex >= 0 && /^(?:run|exec|dlx|x)$/iu.test(tokens[runnerIndex])) {
        consumedIndexes.add(runnerIndex);
        runnerIndex = findNextFocusedCommandToken(tokens, runnerIndex + 1);
    }
    if (runnerIndex >= 0) {
        consumedIndexes.add(runnerIndex);
    }
}

function getFocusedRunnerTokenIndexes(tokens: readonly string[]): Set<number> {
    const consumedIndexes = new Set<number>();
    const firstToken = tokens[0] || '';
    if (REVIEWER_DIRECT_VALIDATION_RUNNER_PATTERN.test(firstToken)) {
        consumedIndexes.add(0);
        if (isDirectValidationRunnerSubcommand(firstToken, tokens[1] || '')) {
            consumedIndexes.add(1);
        }
    } else if (REVIEWER_GENERIC_RUNTIME_PATTERN.test(firstToken)) {
        consumeGenericRuntimeTokens(tokens, consumedIndexes);
    } else if (REVIEWER_PACKAGE_MANAGER_PATTERN.test(firstToken) || REVIEWER_PACKAGE_EXEC_WRAPPER_PATTERN.test(firstToken)) {
        consumePackageManagerTokens(tokens, consumedIndexes);
    } else if (REVIEWER_BUILD_OR_VALIDATION_TOOL_PATTERN.test(firstToken)) {
        consumedIndexes.add(0);
        const runnerIndex = findNextFocusedCommandToken(tokens, 1);
        if (runnerIndex >= 0) {
            consumedIndexes.add(runnerIndex);
        }
    } else if (!REVIEWER_DIRECT_TEST_TARGET_PATTERN.test(firstToken)) {
        consumedIndexes.add(0);
    }
    return consumedIndexes;
}

interface FocusedCommandOptionParseResult {
    consumedIndexes: ReadonlySet<number>;
    literalSelectorValueIndexes: ReadonlySet<number>;
    optionIndexes: ReadonlySet<number>;
    terminatorIndex: number;
    programIndex: number;
    positionalBoundaryIndex: number;
}

function parseFocusedCommandOptions(tokens: readonly string[]): FocusedCommandOptionParseResult {
    const consumedIndexes = new Set<number>();
    const literalSelectorValueIndexes = new Set<number>();
    const optionIndexes = new Set<number>();
    const firstToken = tokens[0] || '';
    const loaderOperands = getFocusedNodeLoaderOperands(tokens);
    let forwardingDelimiterAvailable = REVIEWER_PACKAGE_MANAGER_PATTERN.test(firstToken);
    let nodeValidationOptionPresent = false;
    let programIndex = -1;
    let terminatorIndex = -1;
    let positionalBoundaryIndex = -1;
    for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index];
        if (token === '--') {
            if (!forwardingDelimiterAvailable) {
                terminatorIndex = index;
                positionalBoundaryIndex = index;
                if (programIndex < 0 && index + 1 < tokens.length) programIndex = index + 1;
                break;
            }
            forwardingDelimiterAvailable = false;
            continue;
        }
        if (index > 0 && programIndex < 0) {
            if (!token.startsWith('-')) {
                programIndex = index;
                if (nodeValidationOptionPresent) {
                    positionalBoundaryIndex = index;
                    break;
                }
            } else if (isFocusedNodeValidationOption(firstToken, token)) {
                nodeValidationOptionPresent = true;
            }
        }
        if (token.startsWith('-')) optionIndexes.add(index);
        const loader = loaderOperands.find((operand) => operand.optionIndex === index);
        if (loader) {
            consumedIndexes.add(index);
            if (loader.valueIndex != null) {
                consumedIndexes.add(loader.valueIndex);
                index = loader.valueIndex;
            }
            continue;
        }
        if (token.includes('=')
            && REVIEWER_FOCUSED_LITERAL_SELECTOR_OPTION_PATTERN.test(normalizeFocusedOptionName(token))) {
            literalSelectorValueIndexes.add(index);
        }
        if (
            REVIEWER_FOCUSED_OPTION_WITH_VALUE_PATTERN.test(token)
            && !token.includes('=')
            && index + 1 < tokens.length
        ) {
            consumedIndexes.add(index);
            consumedIndexes.add(index + 1);
            if (REVIEWER_FOCUSED_LITERAL_SELECTOR_OPTION_PATTERN.test(token)) {
                literalSelectorValueIndexes.add(index + 1);
            }
            index += 1;
            continue;
        }
        if (
            REVIEWER_FOCUSED_OPTION_WITH_SCALAR_VALUE_PATTERN.test(token)
            && !token.includes('=')
            && REVIEWER_FOCUSED_SCALAR_OPTION_VALUE_PATTERN.test(tokens[index + 1] || '')
        ) {
            consumedIndexes.add(index);
            consumedIndexes.add(index + 1);
            index += 1;
        }
    }
    return { consumedIndexes, literalSelectorValueIndexes, optionIndexes, terminatorIndex, programIndex, positionalBoundaryIndex };
}

interface FocusedCommandTargetParseResult {
    targets: string[];
    invalidPositionalTokens: string[];
}

function parseFocusedCommandTargets(command: string, repoRoot?: string): FocusedCommandTargetParseResult {
    const tokens = getFocusedCommandTokens(command);
    const mavenCommand = parseMavenFocusedCommand(tokens);
    if (mavenCommand) return {
        targets: resolveMavenFocusedTargets(mavenCommand, repoRoot, isSafeRepositoryRelativeFocusedTarget),
        invalidPositionalTokens: mavenCommand.unsafeReason ? tokens.slice(1) : []
    };
    const options = parseFocusedCommandOptions(tokens);
    const consumedIndexes = new Set(options.consumedIndexes);
    const optionTerminatorIndex = options.terminatorIndex;
    const positionalBoundaryIndex = options.positionalBoundaryIndex;
    const runnerTokens = optionTerminatorIndex >= 0 ? tokens.slice(0, optionTerminatorIndex) : tokens;
    const runnerInput = REVIEWER_GENERIC_RUNTIME_PATTERN.test(tokens[0] || '') ? tokens : runnerTokens;
    for (const index of getFocusedRunnerTokenIndexes(runnerInput)) {
        consumedIndexes.add(index);
    }
    const positionalTokens = tokens.filter((token, index) => (
        !consumedIndexes.has(index)
        && index !== optionTerminatorIndex
        && ((positionalBoundaryIndex >= 0 && index > positionalBoundaryIndex)
            || (token !== '--' && !token.startsWith('-')))
    ));
    return {
        targets: positionalTokens
            .filter((token) => isConcreteFocusedTargetToken(token, repoRoot))
            .map(normalizeFocusedTargetPath),
        invalidPositionalTokens: positionalTokens.filter((token) => !isConcreteFocusedTargetToken(token, repoRoot))
    };
}

function getFocusedCommandTargetTokens(command: string, repoRoot?: string): string[] {
    return parseFocusedCommandTargets(command, repoRoot).targets;
}

function focusedCommandHasConcreteTarget(command: string, repoRoot?: string): boolean {
    const parsedTargets = parseFocusedCommandTargets(command, repoRoot);
    return parsedTargets.targets.length === 1 && parsedTargets.invalidPositionalTokens.length === 0;
}

function focusedCommandExecutesValidation(command: string, repoRoot?: string): boolean {
    return focusedCommandHasValidationRunner(command)
        && focusedCommandHasConcreteTarget(command, repoRoot);
}

export function inspectReviewerFocusedValidationCommand(command: string, repoRoot?: string): {
    syntax_supported: boolean;
    target: string | null;
    violations: string[];
} {
    const violations: string[] = [];
    const unsafeReason = getUnsafeFocusedCommandReason(command);
    if (unsafeReason) {
        violations.push(`Reviewer focused self-validation must not ${unsafeReason}.`);
    }
    const executesValidation = focusedCommandExecutesValidation(command, repoRoot);
    if (!executesValidation) {
        violations.push('Reviewer focused self-validation must execute a focused test or validation command rather than only inspect or print a prospective target.');
    }
    return {
        syntax_supported: violations.length === 0,
        target: executesValidation ? getFocusedCommandTargetTokens(command, repoRoot)[0] : null,
        violations
    };
}

function focusedCommandExecutesMarkerTarget(command: string, markerTarget: string, repoRoot?: string): boolean {
    const normalizedTarget = normalizeFocusedTargetPath(markerTarget);
    const parsedTargets = parseFocusedCommandTargets(command, repoRoot);
    if (
        parsedTargets.targets.length !== 1
        || parsedTargets.invalidPositionalTokens.length > 0
        || parsedTargets.targets[0] !== normalizedTarget
    ) {
        return false;
    }
    const tokens = getFocusedCommandTokens(command);
    const invocation = getFocusedRuntimeInvocation(tokens);
    const programIndex = parseFocusedCommandOptions(tokens).programIndex;
    const moduleRunner = invocation.hasValidationRunner
        && invocation.runnerTokenIndexes.some((index) => tokens[index] === '-m');
    const directTarget = normalizeFocusedTargetPath(tokens[0] || '') === normalizedTarget
        || (REVIEWER_GENERIC_RUNTIME_PATTERN.test(tokens[0] || '')
            && !invocation.nodeValidationMode && !moduleRunner
            && normalizeFocusedTargetPath(tokens[programIndex] || '') === normalizedTarget);
    if (directTarget && (!/\.(?:[cm]?[jt]sx?|py|rb|php|sh|ps1)$/iu.test(normalizedTarget)
        || !REVIEWER_DIRECT_TEST_TARGET_PATTERN.test(normalizedTarget))) return false;
    return focusedCommandHasValidationRunner(command);
}

const FOCUSED_EVIDENCE_CHANGED_BEHAVIOR_PATTERN =
    /\b(?:affected|changed|modified|new|updated)\b/u;
const FOCUSED_EVIDENCE_RELATIONSHIP_PATTERN =
    /\b(?:assert(?:s|ed|ing)?|consume(?:s|d|ing)?|cover(?:s|ed|ing)?|exercise(?:s|d|ing)?|guard(?:s|ed|ing)?|motivat(?:e|es|ed|ing)|own(?:s|ed|ing)?|validat(?:e|es|ed|ing)|verif(?:y|ies|ied|ying))\b/u;

function focusedEvidenceExplainsTargetRelevance(
    evidence: readonly ReviewFindingsEvidence[],
    markerTarget: string,
    expectedTaskId?: string
): boolean {
    const normalizedTarget = normalizeFocusedTargetPath(markerTarget);
    const escapedTarget = normalizedTarget.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    const exactTargetPattern = new RegExp(
        `(?<![a-z0-9._/\\-])${escapedTarget}(?![a-z0-9_/\\-]|\\.[a-z0-9])`,
        'u'
    );
    const expectedTaskPattern = expectedTaskId
        ? new RegExp(
            `(?<![a-z0-9-])${expectedTaskId.toLowerCase().replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}(?![a-z0-9-])`,
            'u'
        )
        : null;
    return evidence.some((entry) => {
        const normalizedObservation = entry.observation.replace(/\\/gu, '/');
        const location = parseReviewEvidenceLocation(entry.location);
        const locationNamesExactTarget = location?.filePath === normalizedTarget;
        const targetMarker = '\u0000focused-target\u0000';
        const observationWithTargetMarker = normalizedObservation.replace(exactTargetPattern, targetMarker);
        if (observationWithTargetMarker === normalizedObservation && !locationNamesExactTarget) {
            return false;
        }
        const clauses = (locationNamesExactTarget && observationWithTargetMarker === normalizedObservation
            ? `${targetMarker} ${normalizedObservation}`
            : observationWithTargetMarker).split(
            /(?:[\n.;!?]+|,?\s+\b(?:but|however|whereas|while)\b[,;:]?\s+)/u
        );
        return clauses.some((clause) => {
            if (!clause.includes(targetMarker)) {
                return false;
            }
            const rationale = clause.replace(targetMarker, ' ').toLowerCase();
            const namesExpectedTask = expectedTaskPattern?.test(rationale) || false;
            return (FOCUSED_EVIDENCE_CHANGED_BEHAVIOR_PATTERN.test(rationale) || namesExpectedTask)
                && FOCUSED_EVIDENCE_RELATIONSHIP_PATTERN.test(rationale);
        });
    });
}

function focusedAttemptBindsTargetToEvidence(
    note: ReviewFindingsValidationNote,
    markerTarget: string,
    expectedTaskId?: string
): boolean {
    return focusedEvidenceExplainsTargetRelevance(note.evidence, markerTarget, expectedTaskId);
}

function isSafeRepositoryRelativeFocusedTarget(markerTarget: string): boolean {
    const normalizedTarget = markerTarget.replace(/\\/gu, '/');
    if (normalizedTarget.startsWith('/') || /^[a-z]:/iu.test(normalizedTarget)) {
        return false;
    }
    const segments = normalizedTarget.split('/');
    return segments.length > 0 && segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

function validateFailedFocusedFindingLinks(
    validationNotes: readonly ReviewFindingsValidationNote[],
    allFindings: readonly ReviewFinding[],
    violations: string[]
): void {
    const ordinaryFindingsById = new Map<string, ReviewFinding>(allFindings
        .filter((finding) => finding.id !== 'F-000')
        .map((finding): [string, ReviewFinding] => [finding.id, finding]));
    for (const note of validationNotes.filter((entry) => entry.command_outcome === 'failed')) {
        for (const findingId of note.finding_ids || []) {
            const finding = ordinaryFindingsById.get(findingId);
            if (!finding) {
                violations.push(`A failed focused-self-validation command references unknown ordinary finding id '${findingId}'.`);
                continue;
            }
            const noteEvidenceLocations = new Set(note.evidence.map((entry) => (
                normalizeFocusedTargetPath(entry.location)
            )));
            if (!finding.evidence.some((entry) => noteEvidenceLocations.has(
                normalizeFocusedTargetPath(entry.location)
            ))) {
                violations.push(
                    `A failed focused-self-validation command and linked ordinary finding '${findingId}' `
                    + 'must share at least one exact changed-file evidence location.'
                );
            }
        }
    }
}

function getMissingFocusedValidationMarkerTargets(finding: ReviewFinding): string[] {
    return [finding.title, finding.description]
        .map((value) => MISSING_FOCUSED_VALIDATION_MARKER_PATTERN.exec(value))
        .filter((match): match is RegExpExecArray => Boolean(match))
        .map((match) => match[1] || match[2]);
}

function containsMissingFocusedValidationClaim(value: string): boolean {
    return MISSING_FOCUSED_VALIDATION_MARKER_PATTERN.test(value)
        || MISSING_FOCUSED_VALIDATION_CLAIM_PATTERN.test(value);
}

function validateMissingFocusedValidationClaimChannels(
    allFindings: readonly ReviewFinding[],
    residualRisks: readonly ReviewResidualRisk[],
    violations: string[]
): void {
    for (const finding of allFindings.filter((entry) => entry.id !== 'F-000')) {
        const hasCanonicalMarker = getMissingFocusedValidationMarkerTargets(finding).length > 0;
        if (!hasCanonicalMarker && (
            containsMissingFocusedValidationClaim(finding.title)
            || containsMissingFocusedValidationClaim(finding.description)
        )) {
            violations.push(
                `Finding '${finding.id}' must not report missing focused execution through an ordinary noncanonical finding; `
                + 'use F-000 with the exact canonical marker only after an unavailable or prohibited real attempt.'
            );
        }
    }
    for (const risk of residualRisks) {
        if (containsMissingFocusedValidationClaim(risk.description)) {
            violations.push(
                `Residual risk '${risk.id}' must not report missing focused execution; `
                + 'passed attempts produce no risk, failed attempts produce ordinary findings, and unavailable or prohibited attempts use canonical F-000.'
            );
        }
    }
}

function validateMissingFocusedMarkerOwnership(
    allFindings: readonly ReviewFinding[],
    violations: string[]
): ReviewFinding[] {
    const markerFindings = allFindings.filter((finding) => (
        getMissingFocusedValidationMarkerTargets(finding).length > 0
    ));
    for (const finding of markerFindings) {
        if (finding.id !== 'F-000') {
            violations.push('The missing-focused-validation marker is reserved for finding id F-000.');
        }
    }
    const evidenceOnlyFindings = allFindings.filter((finding) => finding.id === 'F-000');
    for (const finding of evidenceOnlyFindings) {
        const markerTargets = getMissingFocusedValidationMarkerTargets(finding);
        if (markerTargets.length === 0) {
            violations.push('Finding id F-000 is reserved for the exact canonical missing-focused-validation marker.');
        }
        if (new Set(markerTargets).size > 1) {
            violations.push('Finding id F-000 title and description must not declare different missing-focused-validation targets.');
        }
    }
    return evidenceOnlyFindings;
}

function getFocusedAttemptNotes(
    validationNotes: readonly ReviewFindingsValidationNote[]
): ReviewFindingsValidationNote[] {
    return validationNotes.filter((note) => (
        note.topic.trim().toLowerCase() === REVIEWER_FOCUSED_SELF_VALIDATION_TOPIC
        && Boolean(note.command)
        && Boolean(note.command_outcome)
        && Boolean(note.diagnostics)
    ));
}

interface FocusedTargetAttempts {
    commandTargetAttempts: ReviewFindingsValidationNote[];
    authenticatedTargetAttempts: ReviewFindingsValidationNote[];
}

function getFocusedTargetAttempts(
    attemptNotes: readonly ReviewFindingsValidationNote[],
    markerTarget: string,
    repoRoot?: string,
    expectedTaskId?: string
): FocusedTargetAttempts {
    const commandTargetAttempts = attemptNotes.filter((note) => (
        Boolean(note.command)
        && focusedCommandExecutesMarkerTarget(note.command as string, markerTarget, repoRoot)
    ));
    return {
        commandTargetAttempts,
        authenticatedTargetAttempts: commandTargetAttempts.filter((note) => (
            isActionableFocusedDiagnostics(note.diagnostics as string)
            && focusedAttemptBindsTargetToEvidence(note, markerTarget, expectedTaskId)
        ))
    };
}

function validateFocusedTargetAttemptOutcome(
    attempts: FocusedTargetAttempts,
    violations: string[]
): void {
    if (attempts.commandTargetAttempts.some((note) => (
        note.command_outcome === 'passed' || note.command_outcome === 'failed'
    ))) {
        violations.push(
            'F-000 missing-focused-validation is valid only when the target command outcome is unavailable or prohibited; ' +
            'it is invalid when any matching passed or failed attempt exists, because passed produces no finding and failed must be an ordinary severity finding.'
        );
        return;
    }
    if (
        attempts.authenticatedTargetAttempts.length > 0
        && !attempts.authenticatedTargetAttempts.some((note) => (
            note.command_outcome === 'unavailable' || note.command_outcome === 'prohibited'
        ))
    ) {
        violations.push(
            'F-000 missing-focused-validation is valid only when the target command outcome is unavailable or prohibited; passed produces no finding and failed must be an ordinary severity finding.'
        );
    }
}

function validateEvidenceOnlyFocusedTarget(
    markerTarget: string,
    attemptNotes: readonly ReviewFindingsValidationNote[],
    violations: string[],
    repoRoot?: string,
    expectedTaskId?: string
): void {
    if (!isSafeRepositoryRelativeFocusedTarget(markerTarget)) {
        violations.push(
            `F-000 missing-focused-validation target '${markerTarget}' must be a repository-relative path without dot segments.`
        );
        return;
    }
    const attempts = getFocusedTargetAttempts(attemptNotes, markerTarget, repoRoot, expectedTaskId);
    if (attempts.authenticatedTargetAttempts.length === 0) {
        violations.push(
            `F-000 missing-focused-validation requires the exact attempted command to execute target '${markerTarget}' through a focused test or validation runner and authenticated validation-note evidence to name that target's relevance.`
        );
    }
    validateFocusedTargetAttemptOutcome(attempts, violations);
}

function validateEvidenceOnlyFocusedFinding(
    finding: ReviewFinding,
    attemptNotes: readonly ReviewFindingsValidationNote[],
    violations: string[],
    repoRoot?: string,
    expectedTaskId?: string
): void {
    const markerTargets = [...new Set(getMissingFocusedValidationMarkerTargets(finding))];
    for (const markerTarget of markerTargets) {
        validateEvidenceOnlyFocusedTarget(markerTarget, attemptNotes, violations, repoRoot, expectedTaskId);
    }
}

function validateMissingFocusedValidationPostAttemptEvidence(
    validationNotes: readonly ReviewFindingsValidationNote[],
    findings: ReviewFindingsBySeverity | null,
    residualRisks: readonly ReviewResidualRisk[],
    violations: string[],
    repoRoot?: string,
    expectedTaskId?: string
): void {
    const allFindings = getAllFindings(findings);
    validateFailedFocusedFindingLinks(validationNotes, allFindings, violations);
    validateMissingFocusedValidationClaimChannels(allFindings, residualRisks, violations);
    const evidenceOnlyFindings = validateMissingFocusedMarkerOwnership(allFindings, violations);
    if (evidenceOnlyFindings.length === 0) {
        return;
    }
    const attemptNotes = getFocusedAttemptNotes(validationNotes);
    if (attemptNotes.length === 0) {
        violations.push(
            'F-000 missing-focused-validation requires a focused-self-validation validation note with exact command, command_outcome, and actionable diagnostics from a real attempt.'
        );
        return;
    }
    for (const finding of evidenceOnlyFindings) {
        validateEvidenceOnlyFocusedFinding(finding, attemptNotes, violations, repoRoot, expectedTaskId);
    }
}

function parseCoverageLedger(value: unknown, violations: string[]): ReviewFindingsCoverageLedger | null {
    if (!isRecord(value)) {
        violations.push('coverage_ledger must be an object.');
        return null;
    }
    pushUnknownKeyViolations('coverage_ledger', value, COVERAGE_LEDGER_KEYS, violations);
    const coverageContractSha256 = normalizeSha256(value.coverage_contract_sha256);
    if (!coverageContractSha256) {
        violations.push('coverage_ledger.coverage_contract_sha256 must be a SHA-256 hex string.');
    }
    if (!Array.isArray(value.entries)) {
        violations.push('coverage_ledger.entries must be an array.');
        return coverageContractSha256 ? { coverage_contract_sha256: coverageContractSha256, entries: [] } : null;
    }
    const entries: ReviewFindingsCoverageLedgerEntry[] = [];
    const obligationIds: string[] = [];
    value.entries.forEach((entry, index) => {
        const subject = `coverage_ledger.entries[${index}]`;
        if (!isRecord(entry)) {
            violations.push(`${subject} must be an object.`);
            return;
        }
        pushUnknownKeyViolations(subject, entry, COVERAGE_ENTRY_KEYS, violations);
        const obligationId = normalizeString(entry.obligation_id);
        if (!obligationId) {
            violations.push(`${subject}.obligation_id is required.`);
        }
        const evidence = parseEvidenceArray(entry.evidence, subject, violations);
        const findingIds = parseStringArray(entry.finding_ids, `${subject}.finding_ids`, violations);
        findingIds
            .filter((findingId) => !REVIEW_FINDINGS_ID_PATTERN.test(findingId))
            .forEach((findingId) => violations.push(`${subject}.finding_ids contains invalid finding id '${findingId}'.`));
        if (obligationId) {
            obligationIds.push(obligationId);
        }
        if (obligationId && evidence.length > 0) {
            entries.push({
                obligation_id: obligationId,
                evidence,
                finding_ids: findingIds
            });
        }
    });
    pushDuplicateViolations('coverage obligation', obligationIds, violations);
    return coverageContractSha256 ? { coverage_contract_sha256: coverageContractSha256, entries } : null;
}

function parseReviewExecutionDeclaration(
    value: unknown,
    violations: string[]
): ReviewerRemediationCoverageDeclaration | null {
    if (value === undefined) {
        violations.push('review_execution is required.');
        return null;
    }
    if (!isRecord(value)) {
        violations.push('review_execution must be an object.');
        return null;
    }
    pushUnknownKeyViolations('review_execution', value, REVIEW_EXECUTION_KEYS, violations);
    const mode = value.mode === 'FULL' || value.mode === 'DELTA' ? value.mode : null;
    if (!mode) {
        violations.push('review_execution.mode must be FULL or DELTA.');
    }
    const contractSha256 = normalizeSha256(value.contract_sha256);
    if (!contractSha256) {
        violations.push('review_execution.contract_sha256 must be a SHA-256 hex string.');
    }
    const coveredDeltaTargets = parseStringArray(
        value.covered_delta_targets,
        'review_execution.covered_delta_targets',
        violations
    );
    const inspectedPriorFindingIds = parseStringArray(
        value.inspected_prior_finding_ids,
        'review_execution.inspected_prior_finding_ids',
        violations
    );
    pushDuplicateViolations('review execution delta target', coveredDeltaTargets, violations);
    pushDuplicateViolations('review execution prior finding', inspectedPriorFindingIds, violations);
    inspectedPriorFindingIds
        .filter((findingId) => !REVIEW_FINDINGS_ID_PATTERN.test(findingId))
        .forEach((findingId) => violations.push(
            `review_execution.inspected_prior_finding_ids contains invalid finding id '${findingId}'.`
        ));
    return mode && contractSha256
        ? {
            mode,
            contract_sha256: contractSha256,
            covered_delta_targets: coveredDeltaTargets,
            inspected_prior_finding_ids: inspectedPriorFindingIds
        }
        : null;
}

function validateEvidenceLocations(
    evidenceItems: readonly ReviewFindingsEvidence[],
    subject: string,
    changedFiles: ReadonlySet<string>,
    reviewType: string,
    admissiblePaths: readonly string[],
    getChangedFileLineCount: ((filePath: string) => { count: number; source: 'current' | 'head' | 'bound-snapshot' } | null) | null,
    violations: string[]
): void {
    for (const [evidenceIndex, evidence] of evidenceItems.entries()) {
        const evidenceSubject = `${subject}.evidence[${evidenceIndex}]`;
        const location = parseReviewEvidenceLocation(evidence.location);
        if (!location || !changedFiles.has(location.filePath)) {
            violations.push(formatReviewEvidenceDomainViolation({
                subject: evidenceSubject,
                location: evidence.location,
                reviewType,
                admissiblePaths
            }));
            continue;
        }
        if (getChangedFileLineCount) {
            const lineEvidence = getChangedFileLineCount(location.filePath);
            if (lineEvidence == null) {
                violations.push(
                    `${evidenceSubject}.location '${evidence.location}' references a changed file that is unreadable in both the current repository and HEAD snapshot.`
                );
            } else if (location.line > lineEvidence.count) {
                violations.push(
                    `${evidenceSubject}.location '${evidence.location}' exceeds ` +
                    `${formatReviewEvidenceLineCountSource(lineEvidence.source)} line count ${lineEvidence.count}.`
                );
            }
        }
    }
}

function validateConcreteReviewEvidenceLocations(
    reportParts: {
        validationNotes: readonly ReviewFindingsValidationNote[];
        coverageLedger: ReviewFindingsCoverageLedger | null;
        findings: ReviewFindingsBySeverity | null;
        residualRisks: readonly ReviewResidualRisk[];
    },
    expectedChangedFilePaths: readonly string[] | undefined,
    expectedReviewType: string,
    lineValidationOptions: { repoRoot?: string; evidenceSnapshotCommit?: string },
    violations: string[]
): void {
    if (!expectedChangedFilePaths) {
        return;
    }
    const admissiblePaths = normalizeReviewEvidenceDomainPaths(expectedChangedFilePaths);
    const changedFiles = new Set(admissiblePaths);
    const getChangedFileLineCount = lineValidationOptions.repoRoot
        ? createChangedFileLineCountResolver(lineValidationOptions)
        : null;

    for (const [noteIndex, note] of reportParts.validationNotes.entries()) {
        validateEvidenceLocations(
            note.evidence,
            `validation_notes[${noteIndex}]`,
            changedFiles,
            expectedReviewType,
            admissiblePaths,
            getChangedFileLineCount,
            violations
        );
    }
    if (reportParts.coverageLedger) {
        for (const [entryIndex, entry] of reportParts.coverageLedger.entries.entries()) {
            validateEvidenceLocations(
                entry.evidence,
                `coverage_ledger.entries[${entryIndex}]`,
                changedFiles,
                expectedReviewType,
                admissiblePaths,
                getChangedFileLineCount,
                violations
            );
        }
    }
    if (reportParts.findings) {
        for (const severity of ['critical', 'high', 'medium', 'low'] as const) {
            for (const [findingIndex, finding] of reportParts.findings[severity].entries()) {
                validateEvidenceLocations(
                    finding.evidence,
                    `findings.${severity}[${findingIndex}]`,
                    changedFiles,
                    expectedReviewType,
                    admissiblePaths,
                    getChangedFileLineCount,
                    violations
                );
            }
        }
    }
    for (const [riskIndex, risk] of reportParts.residualRisks.entries()) {
        validateEvidenceLocations(
            risk.evidence,
            `residual_risks[${riskIndex}]`,
            changedFiles,
            expectedReviewType,
            admissiblePaths,
            getChangedFileLineCount,
            violations
        );
    }
}

function parseFindings(value: unknown, violations: string[]): ReviewFindingsBySeverity | null {
    if (!isRecord(value)) {
        violations.push('findings must be an object.');
        return null;
    }
    pushUnknownKeyViolations('findings', value, FINDINGS_KEYS, violations);
    const result: ReviewFindingsBySeverity = { critical: [], high: [], medium: [], low: [] };
    const ids: string[] = [];
    for (const severity of ['critical', 'high', 'medium', 'low'] as const) {
        if (!Array.isArray(value[severity])) {
            violations.push(`findings.${severity} must be an array.`);
            continue;
        }
        (value[severity] as unknown[]).forEach((entry, index) => {
            const subject = `findings.${severity}[${index}]`;
            if (!isRecord(entry)) {
                violations.push(`${subject} must be an object.`);
                return;
            }
            pushUnknownKeyViolations(subject, entry, FINDING_KEYS, violations);
            const id = normalizeString(entry.id);
            const title = normalizeString(entry.title);
            const description = normalizeString(entry.description);
            const evidence = parseEvidenceArray(entry.evidence, subject, violations);
            const coverageObligationIds = parseStringArray(
                entry.coverage_obligation_ids,
                `${subject}.coverage_obligation_ids`,
                violations
            );
            if (!id || !REVIEW_FINDINGS_ID_PATTERN.test(id)) {
                violations.push(`${subject}.id must match F-###.`);
            }
            if (!title) {
                violations.push(`${subject}.title is required.`);
            }
            if (!description) {
                violations.push(`${subject}.description is required.`);
            }
            if (coverageObligationIds.length === 0) {
                violations.push(`${subject}.coverage_obligation_ids must contain at least one obligation id.`);
            }
            if (id && REVIEW_FINDINGS_ID_PATTERN.test(id)) {
                ids.push(id);
            }
            if (id && title && description && evidence.length > 0 && coverageObligationIds.length > 0) {
                result[severity].push({ id, title, description, evidence, coverage_obligation_ids: coverageObligationIds });
            }
        });
    }
    pushDuplicateViolations('finding', ids, violations);
    return result;
}

function parseResidualRisks(value: unknown, violations: string[]): ReviewResidualRisk[] {
    if (!Array.isArray(value)) {
        violations.push('residual_risks must be an array.');
        return [];
    }
    const risks: ReviewResidualRisk[] = [];
    const ids: string[] = [];
    value.forEach((entry, index) => {
        const subject = `residual_risks[${index}]`;
        if (!isRecord(entry)) {
            violations.push(`${subject} must be an object.`);
            return;
        }
        pushUnknownKeyViolations(subject, entry, RESIDUAL_RISK_KEYS, violations);
        const id = normalizeString(entry.id);
        const description = normalizeString(entry.description);
        const evidence = parseEvidenceArray(entry.evidence, subject, violations);
        if (!id || !REVIEW_RESIDUAL_RISK_ID_PATTERN.test(id)) {
            violations.push(`${subject}.id must match R-###.`);
        }
        if (!description) {
            violations.push(`${subject}.description is required.`);
        }
        if (id && REVIEW_RESIDUAL_RISK_ID_PATTERN.test(id)) {
            ids.push(id);
        }
        if (id && description && evidence.length > 0) {
            risks.push({ id, description, evidence });
        }
    });
    pushDuplicateViolations('residual risk', ids, violations);
    return risks;
}

function parseReviewerNotes(value: unknown, violations: string[]): string[] {
    return parseStringArray(value, 'reviewer_notes', violations);
}

function pushDuplicateViolations(subject: string, ids: readonly string[], violations: string[]): void {
    const duplicates = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))].sort();
    duplicates.forEach((id) => violations.push(`Duplicate ${subject} id '${id}'.`));
}

function getAllFindings(findings: ReviewFindingsBySeverity | null): ReviewFinding[] {
    if (!findings) {
        return [];
    }
    return [...findings.critical, ...findings.high, ...findings.medium, ...findings.low];
}

function validateCrossReferences(
    report: Pick<ReviewFindingsReport, 'coverage_ledger' | 'findings'>,
    expectedCoverageObligationIds: readonly string[] | undefined,
    violations: string[],
    emptyReviewScope = false
): void {
    const coverageIds = report.coverage_ledger.entries.map((entry) => entry.obligation_id);
    if (expectedCoverageObligationIds) {
        const expected = [...new Set(expectedCoverageObligationIds)].sort();
        const actual = [...new Set(coverageIds)].sort();
        expected
            .filter((id) => !actual.includes(id))
            .forEach((id) => violations.push(`Expected coverage obligation '${id}' is missing from coverage_ledger.entries.`));
        actual
            .filter((id) => !expected.includes(id))
            .forEach((id) => violations.push(`Coverage obligation '${id}' is not part of the expected coverage contract.`));
    }

    const findings = getAllFindings(report.findings);
    const findingIds = findings.map((finding) => finding.id);
    const findingIdsReferencedByCoverage = new Set(report.coverage_ledger.entries.flatMap((entry) => entry.finding_ids));
    const coverageIdsSet = new Set(coverageIds);
    const coverageEntriesById = new Map(report.coverage_ledger.entries.map((entry) => [entry.obligation_id, entry]));
    const findingsById = new Map(findings.map((finding) => [finding.id, finding]));
    if (findings.length === 0 && !expectedCoverageObligationIds) {
        violations.push('Empty findings require expected coverage obligation ids to prove complete coverage.');
    }
    for (const finding of findings) {
        for (const obligationId of finding.coverage_obligation_ids) {
            const coverageEntry = coverageEntriesById.get(obligationId);
            if (!coverageIdsSet.has(obligationId) || !coverageEntry) {
                violations.push(`Finding '${finding.id}' references unknown coverage obligation '${obligationId}'.`);
                continue;
            }
            if (!coverageEntry.finding_ids.includes(finding.id)) {
                violations.push(`Finding '${finding.id}' references coverage obligation '${obligationId}' but that coverage ledger entry does not reference the finding.`);
            }
        }
        if (!findingIdsReferencedByCoverage.has(finding.id)) {
            violations.push(`Finding '${finding.id}' is not referenced by any coverage ledger entry.`);
        }
    }
    for (const findingId of findingIdsReferencedByCoverage) {
        if (!findingIds.includes(findingId)) {
            violations.push(`Coverage ledger references unknown finding '${findingId}'.`);
        }
    }
    for (const entry of report.coverage_ledger.entries) {
        for (const findingId of entry.finding_ids) {
            const finding = findingsById.get(findingId);
            if (finding && !finding.coverage_obligation_ids.includes(entry.obligation_id)) {
                violations.push(`Coverage ledger entry '${entry.obligation_id}' references finding '${findingId}' but that finding does not reference the coverage obligation.`);
            }
        }
    }
    if (findings.length === 0 && report.coverage_ledger.entries.length === 0 && !emptyReviewScope) {
        violations.push('Empty findings are valid only with complete coverage ledger evidence.');
    }
}

function hasAuthenticatedEmptyReviewScope(options: ReviewFindingsValidationOptions): boolean {
    const execution = options.expectedReviewExecutionContract;
    return options.allowStructuralOnlyReviewExecution !== true
        && !!normalizeSha256(options.expectedReviewContextSha256)
        && !!normalizeSha256(options.expectedTreeStateSha256)
        && isEmptyReviewCoverageContract(options.expectedCoverageContract)
        && options.expectedCoverageContract?.review_type === options.expectedReviewType.trim().toLowerCase()
        && options.expectedCoverageObligationIds?.length === 0
        && options.expectedChangedFilePaths?.length === 0
        && execution?.source === 'initial_full'
        && execution.mode === 'FULL'
        && Array.isArray(execution.full_review_scope)
        && execution.full_review_scope.length === 0;
}

export function validateReviewFindingsReport(
    value: unknown,
    options: ReviewFindingsValidationOptions
): ReviewFindingsValidationResult {
    const violations: string[] = [];
    collectForbiddenDecisionKeys(value, '$', violations);
    if (!isRecord(value)) {
        return {
            valid: false,
            report: null,
            review_execution_authentication: options.expectedReviewExecutionContract
                ? 'authenticated'
                : 'structural_only',
            violations: ['review findings report must be a JSON object.', ...violations]
        };
    }
    pushUnknownKeyViolations('report', value, REPORT_KEYS, violations);
    if (value.schema_version !== REVIEW_FINDINGS_SCHEMA_VERSION) {
        violations.push(`schema_version must be ${REVIEW_FINDINGS_SCHEMA_VERSION}.`);
    }
    const taskId = normalizeString(value.task_id);
    const reviewType = normalizeString(value.review_type)?.toLowerCase() || null;
    const reviewContextSha256 = normalizeSha256(value.review_context_sha256);
    const treeStateSha256 = normalizeSha256(value.tree_state_sha256);
    if (!taskId) {
        violations.push('task_id is required.');
    } else if (taskId !== options.expectedTaskId) {
        violations.push(`task_id '${taskId}' does not match expected task '${options.expectedTaskId}'.`);
    }
    const expectedReviewType = options.expectedReviewType.trim().toLowerCase();
    if (!reviewType) {
        violations.push('review_type is required.');
    } else if (reviewType !== expectedReviewType) {
        violations.push(`review_type '${reviewType}' does not match expected review '${expectedReviewType}'.`);
    }
    if (!reviewContextSha256) {
        violations.push('review_context_sha256 must be a SHA-256 hex string.');
    } else if (
        options.expectedReviewContextSha256
        && reviewContextSha256 !== options.expectedReviewContextSha256
    ) {
        violations.push('review_context_sha256 does not match the current review context.');
    }
    if (!treeStateSha256) {
        violations.push('tree_state_sha256 must be a SHA-256 hex string.');
    } else if (options.expectedTreeStateSha256 && treeStateSha256 !== options.expectedTreeStateSha256) {
        violations.push('tree_state_sha256 does not match the current review tree state.');
    }

    const emptyReviewScope = hasAuthenticatedEmptyReviewScope(options);
    const findings = parseFindings(value.findings, violations);
    const validationNotes = parseValidationNotes(
        value.validation_notes,
        violations,
        options.repoRoot,
        options.expectedTaskId,
        emptyReviewScope
    );
    const coverageLedger = parseCoverageLedger(value.coverage_ledger, violations);
    if (options.expectedCoverageContract && coverageLedger
        && coverageLedger.coverage_contract_sha256 !== options.expectedCoverageContract.contract_sha256) {
        violations.push('coverage_ledger.coverage_contract_sha256 does not match the authenticated coverage contract.');
    }
    const reviewExecution = parseReviewExecutionDeclaration(value.review_execution, violations);
    const expectedReviewExecutionContract = options.expectedReviewExecutionContract;
    if (!expectedReviewExecutionContract) {
        if (!options.allowStructuralOnlyReviewExecution) {
            violations.push(
                'expectedReviewExecutionContract is required to authenticate review_execution evidence.'
            );
        }
    } else {
        if (expectedReviewExecutionContract.source === 'initial_full') {
            violations.push(...getReviewRemediationReviewContractViolations(
                expectedReviewExecutionContract,
                {
                    taskId: options.expectedTaskId,
                    reviewType: expectedReviewType,
                    preflightSha256: expectedReviewExecutionContract.preflight_sha256,
                    mode: expectedReviewExecutionContract.mode,
                    fullReviewScope: expectedReviewExecutionContract.full_review_scope,
                    persistedDecisionSha256: null,
                    authoritativeDecisionSha256: null,
                    authoritativeClassificationSha256: null,
                    authoritativeDecision: null,
                    authoritativeClassification: null
                }
            ));
        }
        violations.push(...getReviewerRemediationCoverageViolations(
            reviewExecution,
            expectedReviewExecutionContract
        ));
    }
    const residualRisks = parseResidualRisks(value.residual_risks, violations);
    const reviewerNotes = parseReviewerNotes(value.reviewer_notes, violations);
    validateMissingFocusedValidationPostAttemptEvidence(
        validationNotes,
        findings,
        residualRisks,
        violations,
        options.repoRoot,
        options.expectedTaskId
    );
    validateConcreteReviewEvidenceLocations(
        { validationNotes, coverageLedger, findings, residualRisks },
        options.expectedChangedFilePaths,
        expectedReviewType,
        {
            repoRoot: options.repoRoot,
            evidenceSnapshotCommit: options.evidenceSnapshotCommit
        },
        violations
    );
    if (coverageLedger && findings) {
        validateCrossReferences({
            coverage_ledger: coverageLedger,
            findings
        }, options.expectedCoverageObligationIds, violations, emptyReviewScope);
    }

    const report = taskId && reviewType && reviewContextSha256 && treeStateSha256
        && coverageLedger && reviewExecution && findings
        ? {
            schema_version: REVIEW_FINDINGS_SCHEMA_VERSION,
            task_id: taskId,
            review_type: reviewType,
            review_context_sha256: reviewContextSha256,
            tree_state_sha256: treeStateSha256,
            validation_notes: validationNotes,
            coverage_ledger: coverageLedger,
            review_execution: reviewExecution,
            findings,
            residual_risks: residualRisks,
            reviewer_notes: reviewerNotes
        }
        : null;

    return {
        valid: violations.length === 0,
        report: violations.length === 0 ? report : null,
        review_execution_authentication: options.expectedReviewExecutionContract
            ? 'authenticated'
            : 'structural_only',
        violations
    };
}
