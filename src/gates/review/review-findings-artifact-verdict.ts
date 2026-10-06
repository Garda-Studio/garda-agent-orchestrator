import { extractReviewVerdictToken } from '../../gate-runtime/review-context';
import { isPlainRecord } from '../../core/records';
import {
    validateReviewFindingsReport,
    type ReviewFindingsReport
} from './review-findings-schema';
import {
    type ReviewRemediationReviewContract
} from '../review-remediation/review-remediation-review-contract';
import {
    validateReviewCoverageLedger,
    type ReviewCoverageContract,
    type ReviewCoverageValidationSummary
} from './review-coverage-ledger';

export interface JsonReviewFindingsArtifactValidation {
    detected: boolean;
    valid: boolean;
    report: ReviewFindingsReport | null;
    violations: string[];
    coverage_validation: ReviewCoverageValidationSummary | null;
}

export interface ReviewFindingsContractValidationOptions {
    content: string;
    expectedTaskId: string;
    expectedReviewType: string;
    expectedReviewContextSha256?: string | null;
    expectedTreeStateSha256?: string | null;
    coverageContract?: ReviewCoverageContract | null;
    repoRoot?: string | null;
    evidenceSnapshotCommit?: string | null;
    expectedReviewExecutionContract?: ReviewRemediationReviewContract;
}

export function reviewContextRequiresFindingsOnlyArtifact(reviewContext: unknown): boolean {
    if (!isPlainRecord(reviewContext)) {
        return false;
    }
    return Number(reviewContext.schema_version) >= 3;
}

function parseJsonReviewFindingsArtifactObject(content: string): Record<string, unknown> | null {
    const trimmed = String(content || '').trim();
    if (!trimmed.startsWith('{')) {
        return null;
    }
    try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (!isPlainRecord(parsed)) {
            return null;
        }
        return parsed;
    } catch {
        return null;
    }
}

export const EVIDENCE_ONLY_MISSING_FOCUSED_VALIDATION_PATTERN =
    /^\[garda:evidence-only:missing-focused-validation\]\s+test=(tests\/[^\s;]+\.(?:test|spec)\.(?:c|m)?[jt]sx?);\s*action=run-and-record-focused-test$/iu;

function findMissingFocusedValidationMarker(value: string): RegExpMatchArray | null {
    return value.match(EVIDENCE_ONLY_MISSING_FOCUSED_VALIDATION_PATTERN);
}

function findJsonReviewMissingFocusedValidationMarker(finding: { title: string; description: string }): RegExpMatchArray | null {
    return findMissingFocusedValidationMarker(finding.title)
        || findMissingFocusedValidationMarker(finding.description);
}

export function findJsonReviewMissingFocusedValidationTestPaths(report: ReviewFindingsReport): string[] {
    const findings = [
        ...report.findings.critical,
        ...report.findings.high,
        ...report.findings.medium,
        ...report.findings.low
    ];
    return [...new Set(findings
        .map((finding) => findJsonReviewMissingFocusedValidationMarker(finding)?.[1] || '')
        .filter(Boolean))];
}

export function parseJsonReviewFindingsArtifact(
    content: string,
    expectedReviewExecutionContract?: ReviewRemediationReviewContract,
    coverageContract?: ReviewCoverageContract | null
): ReviewFindingsReport | null {
    const parsed = parseJsonReviewFindingsArtifactObject(content);
    if (!parsed) {
        return null;
    }
    const validation = validateReviewFindingsReport(parsed, {
        expectedTaskId: String(parsed.task_id || '').trim(),
        expectedReviewType: String(parsed.review_type || '').trim(),
        ...(coverageContract
            ? {
                expectedCoverageObligationIds: getCoverageObligationIds(coverageContract),
                expectedCoverageContract: coverageContract,
                expectedChangedFilePaths: getCoverageChangedFilePaths(coverageContract)
            }
            : {}),
        expectedReviewExecutionContract,
        allowStructuralOnlyReviewExecution: !expectedReviewExecutionContract
    });
    return validation.report;
}

function getCoverageContractSha256(value: Record<string, unknown>): string | null {
    const ledger = value.coverage_ledger;
    if (!isPlainRecord(ledger) || typeof ledger.coverage_contract_sha256 !== 'string') {
        return null;
    }
    const normalized = ledger.coverage_contract_sha256.trim().toLowerCase();
    return normalized || null;
}

function buildCoverageContractSha256Violation(
    parsed: Record<string, unknown>,
    coverageContract: ReviewCoverageContract | null | undefined
): string | null {
    const expectedSha256 = String(coverageContract?.contract_sha256 || '').trim().toLowerCase();
    if (!expectedSha256) {
        return null;
    }
    const actualSha256 = getCoverageContractSha256(parsed);
    if (!actualSha256 || actualSha256 === expectedSha256) {
        return null;
    }
    return `coverage_ledger.coverage_contract_sha256 does not match current coverage contract '${expectedSha256}'.`;
}

function getCoverageObligationIds(contract: ReviewCoverageContract | null | undefined): string[] {
    return Array.isArray(contract?.obligations)
        ? contract.obligations
            .map((entry) => String(entry?.id || '').trim())
            .filter(Boolean)
        : [];
}

function getCoverageChangedFilePaths(contract: ReviewCoverageContract | null | undefined): string[] {
    return Array.isArray(contract?.obligations)
        ? contract.obligations
            .filter((entry) => entry?.kind === 'file')
            .map((entry) => String(entry?.target || '').trim())
            .filter(Boolean)
        : [];
}

export function validateReviewFindingsContract(
    options: ReviewFindingsContractValidationOptions
): JsonReviewFindingsArtifactValidation {
    const parsed = parseJsonReviewFindingsArtifactObject(options.content);
    if (!parsed) {
        return {
            detected: false,
            valid: false,
            report: null,
            violations: [],
            coverage_validation: null
        };
    }

    const validation = validateReviewFindingsReport(parsed, {
        expectedTaskId: options.expectedTaskId,
        expectedReviewType: options.expectedReviewType,
        expectedCoverageObligationIds: getCoverageObligationIds(options.coverageContract),
        expectedCoverageContract: options.coverageContract || undefined,
        expectedChangedFilePaths: getCoverageChangedFilePaths(options.coverageContract),
        expectedReviewContextSha256: options.expectedReviewContextSha256 || undefined,
        expectedTreeStateSha256: options.expectedTreeStateSha256 || undefined,
        repoRoot: options.repoRoot || undefined,
        evidenceSnapshotCommit: options.evidenceSnapshotCommit || undefined,
        expectedReviewExecutionContract: options.expectedReviewExecutionContract
    });
    const coverageContractSha256Violation = buildCoverageContractSha256Violation(parsed, options.coverageContract);
    const coverageValidation = options.coverageContract
        ? validateReviewCoverageLedger(options.content, options.coverageContract, {
            repoRoot: options.repoRoot || undefined,
            evidenceSnapshotCommit: options.evidenceSnapshotCommit || undefined
        })
        : null;
    const coverageViolations = coverageValidation?.status === 'FAIL'
        ? coverageValidation.violations
        : [];
    const violations = [
        ...validation.violations,
        ...(coverageContractSha256Violation ? [coverageContractSha256Violation] : []),
        ...coverageViolations
    ];

    return {
        detected: true,
        valid: violations.length === 0,
        report: violations.length === 0 ? validation.report : null,
        violations,
        coverage_validation: coverageValidation
    };
}

export function jsonReviewFindingsArtifactContainsOnlyMissingFocusedValidation(report: ReviewFindingsReport): boolean {
    const findings = [
        ...report.findings.critical,
        ...report.findings.high,
        ...report.findings.medium,
        ...report.findings.low
    ];
    return findings.length > 0
        && report.residual_risks.length === 0
        && findings.every((finding) =>
            finding.id === 'F-000'
            && Boolean(findJsonReviewMissingFocusedValidationMarker(finding))
        );
}

export function validateJsonReviewFindingsArtifact(options: {
    content: string;
    expectedTaskId: string;
    expectedReviewType: string;
    expectedReviewContextSha256?: string | null;
    expectedTreeStateSha256?: string | null;
    coverageContract?: ReviewCoverageContract | null;
    repoRoot?: string | null;
    evidenceSnapshotCommit?: string | null;
    expectedReviewExecutionContract?: ReviewRemediationReviewContract;
}): JsonReviewFindingsArtifactValidation {
    return validateReviewFindingsContract(options);
}

export function jsonReviewFindingsArtifactHasActiveFindings(report: ReviewFindingsReport): boolean {
    return report.findings.critical.length > 0
        || report.findings.high.length > 0
        || report.findings.medium.length > 0
        || report.findings.low.length > 0
        || report.residual_risks.length > 0;
}

export function resolveReviewFindingsArtifactVerdictToken(options: {
    content: string;
    passToken: string | null;
    failToken: string | null;
    reviewType: string;
    expectedTaskId?: string;
    expectedReviewContextSha256?: string | null;
    expectedTreeStateSha256?: string | null;
    coverageContract?: ReviewCoverageContract | null;
    repoRoot?: string | null;
    evidenceSnapshotCommit?: string | null;
    expectedReviewExecutionContract?: ReviewRemediationReviewContract;
}): string | null {
    const parsedJsonArtifact = parseJsonReviewFindingsArtifactObject(options.content);
    if (!parsedJsonArtifact) {
        return extractReviewVerdictToken(
            options.content,
            options.passToken,
            options.failToken,
            options.reviewType
        );
    }
    const validation = validateJsonReviewFindingsArtifact({
        content: options.content,
        expectedTaskId: options.expectedTaskId || String(parsedJsonArtifact.task_id || '').trim(),
        expectedReviewType: options.reviewType,
        expectedReviewContextSha256: options.expectedReviewContextSha256 || undefined,
        expectedTreeStateSha256: options.expectedTreeStateSha256 || undefined,
        coverageContract: options.coverageContract || null,
        repoRoot: options.repoRoot || undefined,
        evidenceSnapshotCommit: options.evidenceSnapshotCommit || undefined,
        expectedReviewExecutionContract: options.expectedReviewExecutionContract
    });
    if (!validation.report) {
        return null;
    }
    return jsonReviewFindingsArtifactHasActiveFindings(validation.report)
        ? options.failToken || null
        : options.passToken || null;
}
