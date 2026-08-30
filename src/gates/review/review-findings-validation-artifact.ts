import * as fs from 'node:fs';

import { sha256RedactedJsonPayload } from '../../core/redaction';
import {
    readReviewArtifactFileSha256,
    readReviewArtifactJsonFile
} from '../../gate-runtime/review-artifacts';
import { normalizePath } from '../shared/helpers';
import type { ReviewCoverageContract, ReviewCoverageValidationSummary } from './review-coverage-ledger';
import type { JsonReviewFindingsArtifactValidation } from './review-findings-artifact-verdict';
import type {
    ReviewFinding,
    ReviewFindingsEvidence,
    ReviewFindingsReport,
    ReviewFindingsSeverity
} from './review-findings-schema';
import {
    getReviewExecutionEvidenceBindingViolations,
    getReviewExecutionEvidenceContractViolations,
    resolveReviewContextExecutionEvidenceBindings,
    type ReviewExecutionEvidenceBindings
} from './review-evidence-contract';

export const REVIEW_FINDINGS_VALIDATION_ARTIFACT_TYPE = 'review_findings_validation';
export const REVIEW_FINDINGS_VALIDATION_ARTIFACT_SCHEMA_VERSION = 1;

export type ReviewFindingsValidationStatus = 'accepted' | 'rejected';

export interface ReviewFindingsValidationBindingInput {
    review_output_sha256: string | null;
}

export interface ReviewFindingsValidationBindingOutput {
    review_artifact_path: string | null;
    review_artifact_sha256: string | null;
}

export interface ReviewFindingsValidationBindingContext {
    review_context_path: string | null;
    review_context_sha256: string | null;
}

export interface ReviewFindingsValidationBindingScope {
    preflight_path: string | null;
    preflight_sha256: string | null;
    scope_sha256: string | null;
    review_scope_sha256: string | null;
    code_scope_sha256: string | null;
}

export interface ReviewFindingsValidationBindingTree {
    review_tree_state_sha256: string | null;
}

export interface ReviewFindingsValidationBindings {
    input: ReviewFindingsValidationBindingInput;
    output: ReviewFindingsValidationBindingOutput;
    context: ReviewFindingsValidationBindingContext;
    scope: ReviewFindingsValidationBindingScope;
    tree: ReviewFindingsValidationBindingTree;
    coverage_contract_sha256: string | null;
    execution?: ReviewExecutionEvidenceBindings | null;
}

export interface NormalizedReviewFindingInventoryEntry {
    id: string;
    severity: ReviewFindingsSeverity;
    title: string;
    description: string;
    evidence_locations: string[];
    coverage_obligation_ids: string[];
}

export interface NormalizedReviewResidualRiskInventoryEntry {
    id: string;
    description: string;
    evidence_locations: string[];
}

export interface NormalizedReviewFindingsInventory {
    finding_count: number;
    residual_risk_count: number;
    findings_by_severity: Record<ReviewFindingsSeverity, NormalizedReviewFindingInventoryEntry[]>;
    residual_risks: NormalizedReviewResidualRiskInventoryEntry[];
}

export interface ReviewFindingsEvidenceDiagnostics {
    validation_note_evidence_locations: string[];
    coverage_evidence_locations: string[];
    finding_evidence_locations: string[];
    residual_risk_evidence_locations: string[];
    total_evidence_locations: number;
}

export interface ReviewFindingsValidationResultCore {
    status: ReviewFindingsValidationStatus;
    accepted: boolean;
    detected: boolean;
    violations: string[];
    coverage_status: ReviewCoverageValidationSummary | null;
    normalized_inventory: NormalizedReviewFindingsInventory;
    evidence_diagnostics: ReviewFindingsEvidenceDiagnostics;
    bindings: ReviewFindingsValidationBindings;
}

export interface ReviewFindingsValidationArtifact {
    schema_version: 1;
    artifact_type: typeof REVIEW_FINDINGS_VALIDATION_ARTIFACT_TYPE;
    task_id: string;
    review_type: string;
    validation_result: ReviewFindingsValidationResultCore;
    validation_result_sha256: string;
}

export interface BuildReviewFindingsValidationArtifactOptions {
    taskId: string;
    reviewType: string;
    validation: JsonReviewFindingsArtifactValidation;
    reviewOutputSha256?: string | null;
    reviewArtifactPath?: string | null;
    reviewArtifactSha256?: string | null;
    reviewContextPath?: string | null;
    reviewContextSha256?: string | null;
    preflightPath?: string | null;
    preflightSha256?: string | null;
    scopeSha256?: string | null;
    reviewScopeSha256?: string | null;
    codeScopeSha256?: string | null;
    reviewTreeStateSha256?: string | null;
    coverageContract?: ReviewCoverageContract | null;
}

export interface ReviewFindingsValidationArtifactCheckOptions {
    artifactPath: string;
    expectedTaskId: string;
    expectedReviewType: string;
    expectedReviewOutputSha256?: string | null;
    expectedReviewArtifactPath?: string | null;
    expectedReviewArtifactSha256?: string | null;
    expectedReviewContextPath?: string | null;
    expectedReviewContextSha256?: string | null;
    expectedPreflightPath?: string | null;
    expectedPreflightSha256?: string | null;
    expectedScopeSha256?: string | null;
    expectedReviewScopeSha256?: string | null;
    expectedCodeScopeSha256?: string | null;
    expectedReviewTreeStateSha256?: string | null;
    expectedCoverageContractSha256?: string | null;
    expectedReviewContext?: Record<string, unknown> | null;
    requireAccepted?: boolean;
    expectedArtifactSha256?: string | null;
    expectedValidationResultSha256?: string | null;
}

export interface ReviewFindingsValidationArtifactCheckResult {
    valid: boolean;
    accepted: boolean;
    artifact: ReviewFindingsValidationArtifact | null;
    artifact_sha256: string | null;
    violations: string[];
}

export interface ReviewFindingsValidationReceiptReference {
    artifact_path: string;
    artifact_sha256: string;
    snapshot_path: string | null;
    snapshot_sha256: string | null;
    status: ReviewFindingsValidationStatus;
    accepted: boolean;
    validation_result_sha256: string;
    violation_count: number;
}

export interface ReviewFindingsValidationReceiptCheckOptions {
    receipt: Record<string, unknown>;
    reviewArtifactPath: string;
    expectedTaskId: string;
    expectedReviewType: string;
    expectedReviewOutputSha256?: string | null;
    expectedReviewArtifactSha256?: string | null;
    expectedReviewContextPath?: string | null;
    expectedReviewContextSha256?: string | null;
    expectedPreflightPath?: string | null;
    expectedPreflightSha256?: string | null;
    expectedScopeSha256?: string | null;
    expectedReviewScopeSha256?: string | null;
    expectedCodeScopeSha256?: string | null;
    expectedReviewTreeStateSha256?: string | null;
    expectedCoverageContractSha256?: string | null;
    expectedReviewContext?: Record<string, unknown> | null;
    requireAccepted?: boolean;
    preferSnapshot?: boolean;
    allowLegacyMissingExecutionBinding?: boolean;
}

export interface ReviewFindingsValidationReceiptCheckResult extends ReviewFindingsValidationArtifactCheckResult {
    reference: ReviewFindingsValidationReceiptReference | null;
}

function normalizeHash(value: unknown): string | null {
    const normalized = String(value || '').trim().toLowerCase();
    return /^[0-9a-f]{64}$/u.test(normalized) ? normalized : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeStatus(value: unknown): ReviewFindingsValidationStatus | null {
    const normalized = String(value || '').trim().toLowerCase();
    return normalized === 'accepted' || normalized === 'rejected'
        ? normalized
        : null;
}

function normalizeNonEmptyPath(value: unknown): string | null {
    const normalized = normalizePath(String(value || '').trim());
    return normalized || null;
}

function evidenceLocations(evidence: readonly ReviewFindingsEvidence[] | undefined): string[] {
    return [...new Set((evidence || [])
        .map((entry) => normalizePath(entry.location || ''))
        .filter(Boolean))]
        .sort();
}

function normalizeFinding(finding: ReviewFinding, severity: ReviewFindingsSeverity): NormalizedReviewFindingInventoryEntry {
    return {
        id: finding.id,
        severity,
        title: finding.title,
        description: finding.description,
        evidence_locations: evidenceLocations(finding.evidence),
        coverage_obligation_ids: [...new Set(finding.coverage_obligation_ids)].sort()
    };
}

function emptyInventory(): NormalizedReviewFindingsInventory {
    return {
        finding_count: 0,
        residual_risk_count: 0,
        findings_by_severity: {
            critical: [],
            high: [],
            medium: [],
            low: []
        },
        residual_risks: []
    };
}

function buildNormalizedInventory(report: ReviewFindingsReport | null): NormalizedReviewFindingsInventory {
    if (!report) {
        return emptyInventory();
    }
    const findingsBySeverity = {
        critical: report.findings.critical.map((finding) => normalizeFinding(finding, 'critical')),
        high: report.findings.high.map((finding) => normalizeFinding(finding, 'high')),
        medium: report.findings.medium.map((finding) => normalizeFinding(finding, 'medium')),
        low: report.findings.low.map((finding) => normalizeFinding(finding, 'low'))
    };
    const residualRisks = report.residual_risks
        .map((risk) => ({
            id: risk.id,
            description: risk.description,
            evidence_locations: evidenceLocations(risk.evidence)
        }))
        .sort((left, right) => left.id.localeCompare(right.id));
    return {
        finding_count: Object.values(findingsBySeverity).reduce((total, findings) => total + findings.length, 0),
        residual_risk_count: residualRisks.length,
        findings_by_severity: findingsBySeverity,
        residual_risks: residualRisks
    };
}

function collectEvidenceDiagnostics(report: ReviewFindingsReport | null): ReviewFindingsEvidenceDiagnostics {
    if (!report) {
        return {
            validation_note_evidence_locations: [],
            coverage_evidence_locations: [],
            finding_evidence_locations: [],
            residual_risk_evidence_locations: [],
            total_evidence_locations: 0
        };
    }
    const validationNoteEvidence = evidenceLocations(report.validation_notes.flatMap((note) => note.evidence));
    const coverageEvidence = evidenceLocations(report.coverage_ledger.entries.flatMap((entry) => entry.evidence));
    const findingEvidence = evidenceLocations([
        ...report.findings.critical,
        ...report.findings.high,
        ...report.findings.medium,
        ...report.findings.low
    ].flatMap((finding) => finding.evidence));
    const residualRiskEvidence = evidenceLocations(report.residual_risks.flatMap((risk) => risk.evidence));
    return {
        validation_note_evidence_locations: validationNoteEvidence,
        coverage_evidence_locations: coverageEvidence,
        finding_evidence_locations: findingEvidence,
        residual_risk_evidence_locations: residualRiskEvidence,
        total_evidence_locations: [
            ...validationNoteEvidence,
            ...coverageEvidence,
            ...findingEvidence,
            ...residualRiskEvidence
        ].length
    };
}

function buildValidationViolations(validation: JsonReviewFindingsArtifactValidation): string[] {
    const violations = [...validation.violations];
    if (!validation.detected) {
        violations.push('review output must be a JSON object.');
    }
    if (validation.detected && validation.valid === false && violations.length === 0) {
        violations.push('findings JSON report failed validation without a specific validator violation.');
    }
    return violations;
}

function buildBindings(options: BuildReviewFindingsValidationArtifactOptions): ReviewFindingsValidationBindings {
    let execution: ReviewExecutionEvidenceBindings | null = null;
    if (options.reviewContextPath) {
        try {
            const reviewContext = readReviewArtifactJsonFile(options.reviewContextPath);
            if (isRecord(reviewContext)) {
                execution = resolveReviewContextExecutionEvidenceBindings(reviewContext).bindings;
            }
        } catch {
            execution = null;
        }
    }
    return {
        input: {
            review_output_sha256: normalizeHash(options.reviewOutputSha256)
        },
        output: {
            review_artifact_path: options.reviewArtifactPath ? normalizePath(options.reviewArtifactPath) : null,
            review_artifact_sha256: normalizeHash(options.reviewArtifactSha256)
        },
        context: {
            review_context_path: options.reviewContextPath ? normalizePath(options.reviewContextPath) : null,
            review_context_sha256: normalizeHash(options.reviewContextSha256)
        },
        scope: {
            preflight_path: options.preflightPath ? normalizePath(options.preflightPath) : null,
            preflight_sha256: normalizeHash(options.preflightSha256),
            scope_sha256: normalizeHash(options.scopeSha256),
            review_scope_sha256: normalizeHash(options.reviewScopeSha256),
            code_scope_sha256: normalizeHash(options.codeScopeSha256)
        },
        tree: {
            review_tree_state_sha256: normalizeHash(options.reviewTreeStateSha256)
        },
        coverage_contract_sha256: normalizeHash(options.coverageContract?.contract_sha256),
        ...(execution ? { execution } : {})
    };
}

export function getReviewFindingsValidationArtifactPath(reviewArtifactPath: string): string {
    return String(reviewArtifactPath || '').replace(/\.md$/u, '-findings-validation.json');
}

export function getReviewFindingsValidationArtifactSnapshotPath(
    reviewFindingsValidationArtifactPath: string,
    artifactSha256: string
): string {
    return String(reviewFindingsValidationArtifactPath || '')
        .replace(/\.json$/u, `-${artifactSha256}.json`);
}

export function buildReviewFindingsValidationArtifact(
    options: BuildReviewFindingsValidationArtifactOptions
): ReviewFindingsValidationArtifact {
    const accepted = options.validation.valid && options.validation.report !== null;
    const violations = buildValidationViolations(options.validation);
    const validationResult: ReviewFindingsValidationResultCore = {
        status: accepted ? 'accepted' : 'rejected',
        accepted,
        detected: options.validation.detected,
        violations,
        coverage_status: options.validation.coverage_validation,
        normalized_inventory: buildNormalizedInventory(options.validation.report),
        evidence_diagnostics: collectEvidenceDiagnostics(options.validation.report),
        bindings: buildBindings(options)
    };
    return {
        schema_version: REVIEW_FINDINGS_VALIDATION_ARTIFACT_SCHEMA_VERSION,
        artifact_type: REVIEW_FINDINGS_VALIDATION_ARTIFACT_TYPE,
        task_id: options.taskId,
        review_type: options.reviewType,
        validation_result: validationResult,
        validation_result_sha256: sha256RedactedJsonPayload(validationResult)
    };
}

function parseValidationArtifact(value: unknown): ReviewFindingsValidationArtifact | null {
    if (!isRecord(value)) {
        return null;
    }
    const record = value;
    if (
        record.schema_version !== REVIEW_FINDINGS_VALIDATION_ARTIFACT_SCHEMA_VERSION
        || record.artifact_type !== REVIEW_FINDINGS_VALIDATION_ARTIFACT_TYPE
        || !record.validation_result
        || typeof record.validation_result !== 'object'
        || Array.isArray(record.validation_result)
        || typeof record.validation_result_sha256 !== 'string'
    ) {
        return null;
    }
    return record as unknown as ReviewFindingsValidationArtifact;
}

function validationArtifactHasRequiredShape(artifact: ReviewFindingsValidationArtifact): boolean {
    const result = artifact.validation_result;
    return isRecord(result)
        && (result.status === 'accepted' || result.status === 'rejected')
        && typeof result.accepted === 'boolean'
        && typeof result.detected === 'boolean'
        && Array.isArray(result.violations)
        && isRecord(result.normalized_inventory)
        && isRecord(result.evidence_diagnostics)
        && isRecord(result.bindings)
        && isRecord(result.bindings.input)
        && isRecord(result.bindings.output)
        && isRecord(result.bindings.context)
        && isRecord(result.bindings.scope)
        && isRecord(result.bindings.tree)
        && (result.bindings.execution == null || isRecord(result.bindings.execution));
}

function assertExpectedValue(
    violations: string[],
    subject: string,
    actual: string | null,
    expected: string | null | undefined
): void {
    const normalizedExpected = normalizeHash(expected);
    if (!normalizedExpected) {
        return;
    }
    if (actual !== normalizedExpected) {
        violations.push(`${subject} mismatch: expected ${normalizedExpected}, found ${actual || 'missing'}.`);
    }
}

function assertExpectedPath(
    violations: string[],
    subject: string,
    actual: string | null,
    expected: string | null | undefined
): void {
    const normalizedExpected = normalizeNonEmptyPath(expected);
    if (!normalizedExpected) {
        return;
    }
    const normalizedActual = normalizeNonEmptyPath(actual);
    if (normalizedActual !== normalizedExpected) {
        violations.push(`${subject} mismatch: expected ${normalizedExpected}, found ${normalizedActual || 'missing'}.`);
    }
}

export function validateReviewFindingsValidationArtifact(
    options: ReviewFindingsValidationArtifactCheckOptions
): ReviewFindingsValidationArtifactCheckResult {
    const artifactPath = normalizePath(options.artifactPath);
    if (!fs.existsSync(artifactPath) || !fs.statSync(artifactPath).isFile()) {
        return {
            valid: false,
            accepted: false,
            artifact: null,
            artifact_sha256: null,
            violations: [`Review findings validation artifact '${artifactPath}' is missing.`]
        };
    }
    const artifactSha256 = readReviewArtifactFileSha256(artifactPath);
    const violations: string[] = [];
    if (normalizeHash(options.expectedArtifactSha256) && artifactSha256 !== normalizeHash(options.expectedArtifactSha256)) {
        violations.push(
            `Review findings validation artifact '${artifactPath}' sha256 mismatch: ` +
            `expected ${normalizeHash(options.expectedArtifactSha256)}, found ${artifactSha256}.`
        );
    }
    let parsed: unknown;
    try {
        parsed = readReviewArtifactJsonFile(artifactPath);
    } catch {
        return {
            valid: false,
            accepted: false,
            artifact: null,
            artifact_sha256: artifactSha256,
            violations: [...violations, `Review findings validation artifact '${artifactPath}' is not valid JSON.`]
        };
    }
    const artifact = parseValidationArtifact(parsed);
    if (!artifact || !validationArtifactHasRequiredShape(artifact)) {
        return {
            valid: false,
            accepted: false,
            artifact: null,
            artifact_sha256: artifactSha256,
            violations: [...violations, `Review findings validation artifact '${artifactPath}' has invalid shape.`]
        };
    }
    if (artifact.task_id !== options.expectedTaskId) {
        violations.push(
            `Review findings validation artifact '${artifactPath}' task_id mismatch: ` +
            `expected ${options.expectedTaskId}, found ${artifact.task_id || 'missing'}.`
        );
    }
    if (artifact.review_type !== options.expectedReviewType) {
        violations.push(
            `Review findings validation artifact '${artifactPath}' review_type mismatch: ` +
            `expected ${options.expectedReviewType}, found ${artifact.review_type || 'missing'}.`
        );
    }
    const actualValidationResultSha256 = sha256RedactedJsonPayload(artifact.validation_result);
    if (artifact.validation_result_sha256 !== actualValidationResultSha256) {
        violations.push(
            `Review findings validation artifact '${artifactPath}' validation_result_sha256 mismatch: ` +
            `expected ${actualValidationResultSha256}, found ${artifact.validation_result_sha256 || 'missing'}.`
        );
    }
    if (
        normalizeHash(options.expectedValidationResultSha256)
        && artifact.validation_result_sha256 !== normalizeHash(options.expectedValidationResultSha256)
    ) {
        violations.push(
            `Review findings validation artifact '${artifactPath}' receipt validation_result_sha256 mismatch: ` +
            `expected ${normalizeHash(options.expectedValidationResultSha256)}, found ${artifact.validation_result_sha256 || 'missing'}.`
        );
    }
    const bindings = artifact.validation_result.bindings;
    assertExpectedValue(violations, 'review_output_sha256', bindings.input.review_output_sha256, options.expectedReviewOutputSha256);
    assertExpectedPath(violations, 'review_artifact_path', bindings.output.review_artifact_path, options.expectedReviewArtifactPath);
    assertExpectedValue(violations, 'review_artifact_sha256', bindings.output.review_artifact_sha256, options.expectedReviewArtifactSha256);
    assertExpectedPath(violations, 'review_context_path', bindings.context.review_context_path, options.expectedReviewContextPath);
    assertExpectedValue(violations, 'review_context_sha256', bindings.context.review_context_sha256, options.expectedReviewContextSha256);
    assertExpectedPath(violations, 'preflight_path', bindings.scope.preflight_path, options.expectedPreflightPath);
    assertExpectedValue(violations, 'preflight_sha256', bindings.scope.preflight_sha256, options.expectedPreflightSha256);
    assertExpectedValue(violations, 'scope_sha256', bindings.scope.scope_sha256, options.expectedScopeSha256);
    assertExpectedValue(violations, 'review_scope_sha256', bindings.scope.review_scope_sha256, options.expectedReviewScopeSha256);
    assertExpectedValue(violations, 'code_scope_sha256', bindings.scope.code_scope_sha256, options.expectedCodeScopeSha256);
    assertExpectedValue(violations, 'review_tree_state_sha256', bindings.tree.review_tree_state_sha256, options.expectedReviewTreeStateSha256);
    assertExpectedValue(violations, 'coverage_contract_sha256', bindings.coverage_contract_sha256, options.expectedCoverageContractSha256);
    violations.push(...getReviewExecutionEvidenceContractViolations({
        reviewContext: options.expectedReviewContext ?? null,
        evidence: isRecord(bindings.execution) ? bindings.execution : null,
        evidenceLabel: 'review findings validation artifact execution binding'
    }));
    if (options.requireAccepted !== false && !artifact.validation_result.accepted) {
        violations.push(
            `Review findings validation artifact '${artifactPath}' is rejected: ` +
            artifact.validation_result.violations.join(' ')
        );
    }
    return {
        valid: violations.length === 0,
        accepted: artifact.validation_result.accepted,
        artifact,
        artifact_sha256: artifactSha256,
        violations
    };
}

export function normalizeReviewFindingsValidationReceiptReference(
    value: unknown
): ReviewFindingsValidationReceiptReference | null {
    if (!isRecord(value)) {
        return null;
    }
    const artifactPath = normalizeNonEmptyPath(value.artifact_path);
    const artifactSha256 = normalizeHash(value.artifact_sha256);
    const validationResultSha256 = normalizeHash(value.validation_result_sha256);
    const status = normalizeStatus(value.status);
    if (!artifactPath || !artifactSha256 || !validationResultSha256 || !status || typeof value.accepted !== 'boolean') {
        return null;
    }
    return {
        artifact_path: artifactPath,
        artifact_sha256: artifactSha256,
        snapshot_path: normalizeNonEmptyPath(value.snapshot_path),
        snapshot_sha256: normalizeHash(value.snapshot_sha256),
        status,
        accepted: value.accepted,
        validation_result_sha256: validationResultSha256,
        violation_count: Number.isInteger(value.violation_count) ? Number(value.violation_count) : -1
    };
}

export function validateReviewFindingsValidationArtifactForReceipt(
    options: ReviewFindingsValidationReceiptCheckOptions
): ReviewFindingsValidationReceiptCheckResult {
    const reusedExistingReview = options.receipt.reused_existing_review === true;
    const reference = normalizeReviewFindingsValidationReceiptReference(options.receipt.review_findings_validation);
    const expectedArtifactPath = getReviewFindingsValidationArtifactPath(options.reviewArtifactPath);
    if (!reference) {
        return {
            valid: false,
            accepted: false,
            reference: null,
            artifact: null,
            artifact_sha256: null,
            violations: ['Review receipt is missing complete review_findings_validation evidence.']
        };
    }
    const violations: string[] = [];
    if (reference.artifact_path !== normalizePath(expectedArtifactPath)) {
        violations.push(
            `Review receipt review_findings_validation artifact_path mismatch: ` +
            `expected ${normalizePath(expectedArtifactPath)}, found ${reference.artifact_path}.`
        );
    }
    const artifactPathToRead = options.preferSnapshot && reference.snapshot_path
        ? reference.snapshot_path
        : reference.artifact_path;
    const artifactSha256ToRead = options.preferSnapshot && reference.snapshot_sha256
        ? reference.snapshot_sha256
        : reference.artifact_sha256;
    const result = validateReviewFindingsValidationArtifact({
        artifactPath: artifactPathToRead,
        expectedTaskId: options.expectedTaskId,
        expectedReviewType: options.expectedReviewType,
        expectedReviewOutputSha256: options.expectedReviewOutputSha256,
        expectedReviewArtifactPath: options.reviewArtifactPath,
        expectedReviewArtifactSha256: options.expectedReviewArtifactSha256,
        expectedReviewContextPath: options.expectedReviewContextPath,
        expectedReviewContextSha256: options.expectedReviewContextSha256,
        expectedPreflightPath: options.expectedPreflightPath,
        expectedPreflightSha256: options.expectedPreflightSha256,
        expectedScopeSha256: options.expectedScopeSha256,
        expectedReviewScopeSha256: options.expectedReviewScopeSha256,
        expectedCodeScopeSha256: options.expectedCodeScopeSha256,
        expectedReviewTreeStateSha256: options.expectedReviewTreeStateSha256,
        expectedCoverageContractSha256: options.expectedCoverageContractSha256,
        expectedReviewContext: reusedExistingReview ? null : options.expectedReviewContext,
        requireAccepted: options.requireAccepted,
        expectedArtifactSha256: artifactSha256ToRead,
        expectedValidationResultSha256: reference.validation_result_sha256
    });
    violations.push(...result.violations);
    const validationBindings = result.artifact?.validation_result.bindings;
    const validationExecution = validationBindings?.execution;
    if (result.artifact) {
        const expectedExecution = reusedExistingReview
            ? {
                review_execution_mode: options.receipt.reused_from_review_execution_mode,
                review_execution_contract_sha256: options.receipt.reused_from_review_execution_contract_sha256,
                review_execution_full_scope_sha256: options.receipt.reused_from_review_execution_full_scope_sha256,
                review_execution_complete_scope_lineage_sha256:
                    options.receipt.reused_from_review_execution_complete_scope_lineage_sha256,
                review_execution_finding_reconciliation_sha256:
                    options.receipt.reused_from_review_execution_finding_reconciliation_sha256
            }
            : {
                review_execution_mode: options.receipt.review_execution_mode,
                review_execution_contract_sha256: options.receipt.review_execution_contract_sha256,
                review_execution_full_scope_sha256: options.receipt.review_execution_full_scope_sha256,
                review_execution_complete_scope_lineage_sha256:
                    options.receipt.review_execution_complete_scope_lineage_sha256,
                review_execution_finding_reconciliation_sha256:
                    options.receipt.review_execution_finding_reconciliation_sha256
            };
        const validationExecutionDeclared = validationBindings != null
            && Object.prototype.hasOwnProperty.call(validationBindings, 'execution');
        const receiptExecutionDeclared = Object.values(expectedExecution).some((value) => (
            value != null && String(value).trim().length > 0
        ));
        const authenticatedLegacySchema3 = options.allowLegacyMissingExecutionBinding === true
            || (
                reusedExistingReview
                && Number(options.receipt.reused_from_review_context_schema_version) === 3
            );
        if (validationExecutionDeclared || receiptExecutionDeclared || !authenticatedLegacySchema3) {
            violations.push(...getReviewExecutionEvidenceBindingViolations({
                expectedEvidence: expectedExecution,
                evidence: isRecord(validationExecution) ? validationExecution : null,
                evidenceLabel: 'review findings validation artifact execution binding',
                expectedEvidenceLabel: reusedExistingReview
                    ? 'the authenticated historical review receipt execution binding'
                    : 'the authenticated review receipt execution binding'
            }));
        }
    }
    if (result.artifact) {
        if (reference.status !== result.artifact.validation_result.status) {
            violations.push(
                `Review receipt review_findings_validation status mismatch: ` +
                `expected ${result.artifact.validation_result.status}, found ${reference.status}.`
            );
        }
        if (reference.accepted !== result.artifact.validation_result.accepted) {
            violations.push(
                `Review receipt review_findings_validation accepted mismatch: ` +
                `expected ${String(result.artifact.validation_result.accepted)}, found ${String(reference.accepted)}.`
            );
        }
        if (
            reference.violation_count >= 0
            && reference.violation_count !== result.artifact.validation_result.violations.length
        ) {
            violations.push(
                `Review receipt review_findings_validation violation_count mismatch: ` +
                `expected ${result.artifact.validation_result.violations.length}, found ${reference.violation_count}.`
            );
        }
    }
    return {
        ...result,
        reference,
        valid: violations.length === 0,
        violations
    };
}

export function reviewFindingsValidationArtifactHasActiveFindings(
    artifact: ReviewFindingsValidationArtifact | null
): boolean {
    if (!artifact?.validation_result.accepted) {
        return false;
    }
    const inventory = artifact.validation_result.normalized_inventory;
    return inventory.finding_count > 0 || inventory.residual_risk_count > 0;
}

function getReviewFindingsValidationArtifactFindings(
    artifact: ReviewFindingsValidationArtifact | null
): NormalizedReviewFindingInventoryEntry[] {
    if (!artifact?.validation_result.accepted) {
        return [];
    }
    const inventory = artifact.validation_result.normalized_inventory;
    return [
        ...inventory.findings_by_severity.critical,
        ...inventory.findings_by_severity.high,
        ...inventory.findings_by_severity.medium,
        ...inventory.findings_by_severity.low
    ];
}

function isMissingFocusedValidationFinding(finding: NormalizedReviewFindingInventoryEntry): boolean {
    return finding.id === 'F-000'
        && /\[garda:evidence-only:missing-focused-validation\]\s+/iu.test(
            `${finding.title} ${finding.description}`
        );
}

export function reviewFindingsValidationArtifactContainsMissingFocusedValidation(
    artifact: ReviewFindingsValidationArtifact | null
): boolean {
    return getReviewFindingsValidationArtifactFindings(artifact)
        .some((finding) => isMissingFocusedValidationFinding(finding));
}

export function reviewFindingsValidationArtifactContainsOnlyMissingFocusedValidation(
    artifact: ReviewFindingsValidationArtifact | null
): boolean {
    if (!artifact?.validation_result.accepted) {
        return false;
    }
    const inventory = artifact.validation_result.normalized_inventory;
    const findings = getReviewFindingsValidationArtifactFindings(artifact);
    return findings.length > 0
        && inventory.residual_risk_count === 0
        && findings.every((finding) => isMissingFocusedValidationFinding(finding));
}

export function findReviewFindingsValidationMissingFocusedValidationTestPaths(
    artifact: ReviewFindingsValidationArtifact | null
): string[] {
    if (!artifact?.validation_result.accepted) {
        return [];
    }
    const findings = [
        ...artifact.validation_result.normalized_inventory.findings_by_severity.critical,
        ...artifact.validation_result.normalized_inventory.findings_by_severity.high,
        ...artifact.validation_result.normalized_inventory.findings_by_severity.medium,
        ...artifact.validation_result.normalized_inventory.findings_by_severity.low
    ];
    return [...new Set(findings
        .map((finding) => `${finding.title} ${finding.description}`.match(
            /\[garda:evidence-only:missing-focused-validation\]\s+test=(tests\/[^\s;]+\.(?:test|spec)\.(?:c|m)?[jt]sx?);\s*action=run-and-record-focused-test/iu
        )?.[1] || '')
        .filter(Boolean))]
        .sort();
}
