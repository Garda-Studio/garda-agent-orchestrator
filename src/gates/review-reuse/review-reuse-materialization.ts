import * as fs from 'node:fs';
import { sha256RedactedJsonPayload } from '../../core/redaction';
import { stringSha256 } from '../../gate-runtime/hash';
import {
    buildReviewReceipt,
    normalizeReviewReceiptReviewerProvenance,
    type ReviewReceipt
} from '../../gate-runtime/review-context';
import {
    assertReviewArtifactFileSha256,
    withReviewArtifactLockAsync,
    writeReviewArtifactsWithRollback
} from '../../gate-runtime/review-artifacts';
import {
    emitReviewRecordedEventAsync
} from '../../gate-runtime/lifecycle-events';
import { taskEventAppendHasBlockingFailure } from '../../gate-runtime/task-events';
import * as gateHelpers from '../shared/helpers';
import {
    computeReviewContextReuseHash,
    computeReviewReuseCodeScopeFingerprint,
    computeReviewRelevantScopeFingerprint,
    getReviewContextReuseContractBindingMismatch,
    resolveReviewReceiptReuseContractBindings,
    resolveReviewContextReuseContractBindings,
    type ReviewContextReuseContractBindings
} from './review-reuse';
import {
    buildDomainScopeFingerprints,
    normalizeDomainScopeFingerprints
} from '../scope/domain-scope-fingerprints';
import type { HistoricalReviewReuseCandidate } from './review-reuse-validation';
import {
    getReviewCoverageContractViolations,
    getReviewCoverageValidationSummaryContractViolations,
    validateReviewCoverageLedger,
    type ReviewCoverageContract
} from '../review/review-coverage-ledger';
import { buildDeclaredReviewCoverageContract } from '../review-context/review-context-coverage';
import {
    type JsonReviewFindingsArtifactValidation
} from '../review/review-findings-artifact-verdict';
import {
    getReviewFindingsValidationArtifactPath,
    getReviewFindingsValidationArtifactSnapshotPath,
    validateReviewFindingsValidationArtifactForReceipt,
    type ReviewFindingsValidationArtifact
} from '../review/review-findings-validation-artifact';
import {
    getReviewFindingsDispositionArtifactPath,
    getReviewFindingsDispositionArtifactSnapshotPath,
    type ReviewFindingsDispositionArtifact
} from '../review/review-findings-disposition-artifact';
import type { ReviewFindingsReport } from '../review/review-findings-schema';
import {
    type LockedReviewFindingPolicyResolution,
    resolveLockedReviewFindingPolicyFromReceiptDispositionEvidence,
    reviewFindingsValidationArtifactHasBlockingFindings
} from '../review/review-finding-disposition';
import { validateReviewFindingsDispositionEvidence } from '../review/review-findings-disposition-evidence';
import {
    buildReviewLaneArtifactEvidence,
    isCustomReviewLaneInSnapshot,
    resolveReviewContextLaneBinding
} from '../review-context/review-context-lane';
import {
    getReviewExecutionEvidenceBindingViolations,
    resolveReviewContextExecutionEvidenceBindings,
    type ReviewExecutionEvidenceBindings
} from '../review/review-evidence-contract';

export interface MaterializeReusedReviewEvidenceOptions {
    repoRoot: string;
    taskId: string;
    reviewType: string;
    preflightPath?: string | null;
    preflightPayload: Record<string, unknown>;
    reviewContextPath: string;
    artifactPath: string;
    receiptPath: string;
    nonTestReviewScope: boolean;
    codeScopeFingerprint: ReturnType<typeof computeReviewReuseCodeScopeFingerprint>;
    reviewScopeFingerprint: ReturnType<typeof computeReviewRelevantScopeFingerprint>;
    currentPreflightHash: string | null;
    currentReviewContextSha256: string | null;
    currentReviewTreeStateSha256: string | null;
    currentContextReuseSha256: string | null;
    candidate: HistoricalReviewReuseCandidate;
    reusedFromReceiptPath: string | null;
    reusedFromReceiptSha256: string | null;
    receipt: ReviewReceipt;
    reviewerExecutionMode: string;
    reviewerIdentity: string;
    historicalReviewerProvenance: NonNullable<ReturnType<typeof normalizeReviewReceiptReviewerProvenance>>;
    expectedContextSha256: string | null;
    expectedContextReuseSha256: string | null;
    historicalSchema3ContextReuseHashMatches: boolean;
    expectedReviewTreeStateSha256: string | null;
    expectedReviewScopeSha256: string | null;
    expectedCodeScopeSha256: string | null;
    contextContractBindingsRequired: boolean;
    currentReviewContextContractBindings: ReviewContextReuseContractBindings;
    historicalReviewArtifactSha256: string;
    artifactText: string;
}

interface ReusedReviewFindingsValidationEvidence {
    artifactPath: string;
    snapshotPath: string;
    artifactSha256: string;
    payload: ReviewFindingsValidationArtifact;
    validation: JsonReviewFindingsArtifactValidation;
    rawOutputSha256: string | null;
    policyResolution: LockedReviewFindingPolicyResolution;
    dispositionEvidence: ReusedReviewFindingsDispositionEvidence;
    historicalExecutionBindings: ReviewExecutionEvidenceBindings | null;
}

export function getReusedReviewCoverageContractViolations(options: {
    reviewType: string;
    preflight: Record<string, unknown>;
    repoRoot: string;
    coverageContract: unknown;
    preflightPath?: string;
}): string[] {
    try {
        const authoritativeCoverage = buildDeclaredReviewCoverageContract(options);
        return getReviewCoverageContractViolations(options.coverageContract, {
            reviewType: options.reviewType, changedFiles: authoritativeCoverage.changedFiles,
            categoryIds: authoritativeCoverage.categoryIds, validationObligations: authoritativeCoverage.validationObligations
        });
    } catch (error) {
        return [`Declared reused review coverage rejected: ${error instanceof Error ? error.message : String(error)}`];
    }
}

interface ReusedReviewFindingsDispositionEvidence {
    artifactPath: string;
    snapshotPath: string;
    artifactSha256: string;
    payload: ReviewFindingsDispositionArtifact;
}

function normalizeSha256(value: unknown): string | null {
    const normalized = String(value || '').trim().toLowerCase();
    return /^[0-9a-f]{64}$/u.test(normalized) ? normalized : null;
}

function getReceiptRecordString(receipt: ReviewReceipt, key: string): string | null {
    const value = (receipt as unknown as Record<string, unknown>)[key];
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function getReceiptOutputContract(receipt: ReviewReceipt): Record<string, unknown> | null {
    const contract = (receipt as unknown as Record<string, unknown>).review_output_contract;
    return contract && typeof contract === 'object' && !Array.isArray(contract)
        ? contract as Record<string, unknown>
        : null;
}

function getReceiptOutputContractString(receipt: ReviewReceipt, key: string): string | null {
    const value = getReceiptOutputContract(receipt)?.[key];
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function validateReusedReviewContextContractBindings(
    options: MaterializeReusedReviewEvidenceOptions,
    currentReviewContext: Record<string, unknown>
): string | null {
    if (!options.contextContractBindingsRequired) {
        return null;
    }
    const currentBindings = resolveReviewContextReuseContractBindings(currentReviewContext);
    const historicalBindings = resolveReviewReceiptReuseContractBindings(
        options.receipt as unknown as Record<string, unknown>
    );
    return getReviewContextReuseContractBindingMismatch(historicalBindings, currentBindings);
}

function getReviewContextTreeStateSha256(reviewContext: Record<string, unknown>): string | null {
    const treeState = reviewContext.tree_state
        && typeof reviewContext.tree_state === 'object'
        && !Array.isArray(reviewContext.tree_state)
        ? reviewContext.tree_state as Record<string, unknown>
        : null;
    return normalizeSha256(treeState?.tree_state_sha256 ?? treeState?.treeStateSha256);
}

export type ReviewContextMaterializationSnapshotExpectations = Pick<
    MaterializeReusedReviewEvidenceOptions,
    | 'currentReviewContextSha256'
    | 'currentReviewTreeStateSha256'
    | 'currentContextReuseSha256'
    | 'currentReviewContextContractBindings'
>;

export function validateReviewContextMaterializationSnapshot(
    expectations: ReviewContextMaterializationSnapshotExpectations,
    currentReviewContextText: string,
    currentReviewContext: Record<string, unknown>
): string | null {
    const currentReviewContextSha256 = stringSha256(currentReviewContextText);
    if (
        !expectations.currentReviewContextSha256
        || currentReviewContextSha256 !== expectations.currentReviewContextSha256
    ) {
        return (
            'current review context changed before reused evidence materialization: ' +
            `expected review_context_sha256=${expectations.currentReviewContextSha256 || 'missing'}; ` +
            `current=${currentReviewContextSha256 || 'missing'}`
        );
    }
    const currentContextReuseSha256 = computeReviewContextReuseHash(currentReviewContext);
    if (
        !expectations.currentContextReuseSha256
        || currentContextReuseSha256 !== expectations.currentContextReuseSha256
    ) {
        return (
            'current review context reuse contract changed before reused evidence materialization: ' +
            `expected review_context_reuse_sha256=${expectations.currentContextReuseSha256 || 'missing'}; ` +
            `current=${currentContextReuseSha256 || 'missing'}`
        );
    }
    const currentReviewTreeStateSha256 = getReviewContextTreeStateSha256(currentReviewContext);
    if (
        !expectations.currentReviewTreeStateSha256
        || currentReviewTreeStateSha256 !== expectations.currentReviewTreeStateSha256
    ) {
        return (
            'current review tree state changed before reused evidence materialization: ' +
            `expected review_tree_state_sha256=${expectations.currentReviewTreeStateSha256 || 'missing'}; ` +
            `current=${currentReviewTreeStateSha256 || 'missing'}`
        );
    }
    const currentBindings = resolveReviewContextReuseContractBindings(currentReviewContext);
    if (
        currentBindings.coverageContractSha256
            !== expectations.currentReviewContextContractBindings.coverageContractSha256
        || currentBindings.ruleContextSha256
            !== expectations.currentReviewContextContractBindings.ruleContextSha256
        || currentBindings.reviewExecutionContractSha256
            !== expectations.currentReviewContextContractBindings.reviewExecutionContractSha256
        || currentBindings.reviewExecutionMode
            !== expectations.currentReviewContextContractBindings.reviewExecutionMode
        || currentBindings.reviewExecutionFullScopeSha256
            !== expectations.currentReviewContextContractBindings.reviewExecutionFullScopeSha256
    ) {
        return 'current review context contract bindings changed before reused evidence materialization';
    }
    return null;
}

function summarizeReviewFindingsReport(report: ReviewFindingsReport): Record<string, unknown> {
    return {
        finding_counts: {
            critical: report.findings.critical.length,
            high: report.findings.high.length,
            medium: report.findings.medium.length,
            low: report.findings.low.length
        },
        residual_risk_count: report.residual_risks.length,
        coverage_entry_count: report.coverage_ledger.entries.length
    };
}

function summarizeReviewFindingsValidationEvidence(
    evidence: ReusedReviewFindingsValidationEvidence
): Record<string, unknown> {
    return {
        artifact_path: gateHelpers.normalizePath(evidence.artifactPath),
        artifact_sha256: evidence.artifactSha256,
        snapshot_path: gateHelpers.normalizePath(evidence.snapshotPath),
        snapshot_sha256: evidence.artifactSha256,
        status: evidence.payload.validation_result.status,
        accepted: evidence.payload.validation_result.accepted,
        validation_result_sha256: evidence.payload.validation_result_sha256,
        violation_count: evidence.payload.validation_result.violations.length
    };
}

function summarizeReviewFindingsDispositionEvidence(
    evidence: ReusedReviewFindingsDispositionEvidence
): Record<string, unknown> {
    return {
        artifact_path: gateHelpers.normalizePath(evidence.artifactPath),
        artifact_sha256: evidence.artifactSha256,
        snapshot_path: gateHelpers.normalizePath(evidence.snapshotPath),
        snapshot_sha256: evidence.artifactSha256,
        disposition_result_sha256: evidence.payload.disposition_result_sha256,
        policy_id: evidence.payload.policy.policy_id,
        policy_source: evidence.payload.policy.policy_source,
        item_count: evidence.payload.summary.item_count,
        fix_now_count: evidence.payload.summary.fix_now_count,
        follow_up_pending_count: evidence.payload.summary.follow_up_pending_count,
        ignored_count: evidence.payload.summary.ignored_count,
        blocking_count: evidence.payload.summary.blocking_count
    };
}

function getReceiptBoundFindingsReviewArtifactPath(receipt: ReviewReceipt | null | undefined): string | null {
    if (!receipt) {
        return null;
    }
    const receiptRecord = receipt as unknown as Record<string, unknown>;
    const reference = receiptRecord.review_findings_validation
        && typeof receiptRecord.review_findings_validation === 'object'
        && !Array.isArray(receiptRecord.review_findings_validation)
        ? receiptRecord.review_findings_validation as Record<string, unknown>
        : null;
    const artifactPath = typeof reference?.artifact_path === 'string'
        ? gateHelpers.normalizePath(reference.artifact_path)
        : null;
    if (!artifactPath?.endsWith('-findings-validation.json')) {
        return null;
    }
    return artifactPath.replace(/-findings-validation\.json$/u, '.md');
}

export async function materializeReusedReviewEvidence(
    options: MaterializeReusedReviewEvidenceOptions
): Promise<{ materialized: boolean; reason: string | null }> {
    const { result } = await withReviewArtifactLockAsync(
        options.reviewContextPath,
        () => materializeReusedReviewEvidenceUnderContextLock(options)
    );
    return result;
}

async function materializeReusedReviewEvidenceUnderContextLock(
    options: MaterializeReusedReviewEvidenceOptions
): Promise<{ materialized: boolean; reason: string | null }> {
    const currentReviewContextText = fs.readFileSync(options.reviewContextPath, 'utf8');
    const currentReviewContext = JSON.parse(currentReviewContextText) as Record<string, unknown>;
    const currentReviewContextSnapshotViolation = validateReviewContextMaterializationSnapshot(
        options,
        currentReviewContextText,
        currentReviewContext
    );
    if (currentReviewContextSnapshotViolation) {
        return {
            materialized: false,
            reason: currentReviewContextSnapshotViolation
        };
    }
    const currentReviewContextSchemaVersion = Number(currentReviewContext.schema_version);
    if (!Number.isInteger(currentReviewContextSchemaVersion) || currentReviewContextSchemaVersion < 3) {
        return {
            materialized: false,
            reason: 'reused review current context must use schema_version 3 or newer; legacy contexts cannot be rematerialized'
        };
    }
    const contextContractBindingViolation = validateReusedReviewContextContractBindings(
        options,
        currentReviewContext
    );
    if (contextContractBindingViolation) {
        return {
            materialized: false,
            reason: contextContractBindingViolation
        };
    }
    if (currentReviewContextSchemaVersion >= 3) {
        const coverageContractViolations = getReusedReviewCoverageContractViolations({
            reviewType: options.reviewType,
            preflight: options.preflightPayload,
            repoRoot: options.repoRoot,
            preflightPath: options.preflightPath ?? undefined,
            coverageContract: currentReviewContext.coverage_contract
        });
        if (coverageContractViolations.length > 0) {
            return {
                materialized: false,
                reason: `reused review coverage contract validation failed: ${coverageContractViolations.join(' ')}`
            };
        }
        const findingsValidationEvidence = buildReusedReviewFindingsValidationEvidence(options);
        if ('reason' in findingsValidationEvidence) {
            return {
                materialized: false,
                reason: findingsValidationEvidence.reason
            };
        }
        const reviewCoverage = validateReviewCoverageLedger(
            options.artifactText,
            currentReviewContext.coverage_contract as ReviewCoverageContract,
            { repoRoot: options.repoRoot }
        );
        if (!reviewCoverage || reviewCoverage.status !== 'PASS') {
            return {
                materialized: false,
                reason: `reused review coverage validation failed: ${reviewCoverage?.violations.join(' ') || 'coverage ledger validation is missing'}`
            };
        }
        const coverageCompatibilityViolations = getReviewCoverageValidationSummaryContractViolations(
            reviewCoverage,
            currentReviewContext.coverage_contract as ReviewCoverageContract
        );
        if (coverageCompatibilityViolations.length > 0) {
            return {
                materialized: false,
                reason: `reused review coverage contract does not match the current review context: ${coverageCompatibilityViolations.join('; ')}`
            };
        }
        const refreshedReceipt = buildReusedReviewReceipt(options, currentReviewContext);
        (refreshedReceipt as unknown as Record<string, unknown>).review_coverage = reviewCoverage;
        attachReusedReviewFindingsReceiptEvidence(
            refreshedReceipt,
            findingsValidationEvidence.evidence,
            currentReviewContext
        );
        return persistReusedReviewEvidence(options, refreshedReceipt, findingsValidationEvidence.evidence);
    }
    return persistReusedReviewEvidence(options, buildReusedReviewReceipt(options, currentReviewContext));
}

async function persistReusedReviewEvidence(
    options: MaterializeReusedReviewEvidenceOptions,
    refreshedReceipt: ReviewReceipt,
    findingsValidationEvidence: ReusedReviewFindingsValidationEvidence | null = null
): Promise<{ materialized: boolean; reason: string | null }> {
    const receiptPayloadSha256 = sha256RedactedJsonPayload(refreshedReceipt);
    const receiptSnapshotPath = options.artifactPath.replace(/\.md$/, `-receipt-${receiptPayloadSha256}.json`);
    const artifactSnapshotPath = options.artifactPath.replace(
        /\.md$/,
        `-artifact-${options.historicalReviewArtifactSha256}.md`
    );
    const orchestratorRoot = gateHelpers.joinOrchestratorPath(options.repoRoot, '');

    try {
        await writeReviewArtifactsWithRollback([
            {
                artifactPath: options.artifactPath,
                contentType: 'text',
                content: options.artifactText
            },
            {
                artifactPath: artifactSnapshotPath,
                contentType: 'text',
                content: options.artifactText
            },
            {
                artifactPath: options.receiptPath,
                contentType: 'json',
                payload: refreshedReceipt
            },
            {
                artifactPath: receiptSnapshotPath,
                contentType: 'json',
                payload: refreshedReceipt
            },
            ...(findingsValidationEvidence
                ? [
                    {
                        artifactPath: findingsValidationEvidence.artifactPath,
                        contentType: 'json' as const,
                        payload: findingsValidationEvidence.payload
                    },
                    {
                        artifactPath: findingsValidationEvidence.snapshotPath,
                        contentType: 'json' as const,
                        payload: findingsValidationEvidence.payload
                    },
                    {
                        artifactPath: findingsValidationEvidence.dispositionEvidence.artifactPath,
                        contentType: 'json' as const,
                        payload: findingsValidationEvidence.dispositionEvidence.payload
                    },
                    {
                        artifactPath: findingsValidationEvidence.dispositionEvidence.snapshotPath,
                        contentType: 'json' as const,
                        payload: findingsValidationEvidence.dispositionEvidence.payload
                    }
                ]
                : [])
        ], async () => {
            assertReviewArtifactFileSha256(
                options.reviewContextPath,
                options.currentReviewContextSha256,
                'Current review context'
            );
            assertReviewArtifactFileSha256(
                options.artifactPath,
                options.historicalReviewArtifactSha256,
                'Reused review artifact'
            );
            assertReviewArtifactFileSha256(
                artifactSnapshotPath,
                options.historicalReviewArtifactSha256,
                'Reused review artifact snapshot'
            );
            assertReviewArtifactFileSha256(options.receiptPath, receiptPayloadSha256, 'Reused review receipt');
            assertReviewArtifactFileSha256(receiptSnapshotPath, receiptPayloadSha256, 'Reused review receipt snapshot');
            if (findingsValidationEvidence) {
                assertReviewArtifactFileSha256(
                    findingsValidationEvidence.artifactPath,
                    findingsValidationEvidence.artifactSha256,
                    'Reused review findings validation artifact'
                );
                assertReviewArtifactFileSha256(
                    findingsValidationEvidence.snapshotPath,
                    findingsValidationEvidence.artifactSha256,
                    'Reused review findings validation snapshot'
                );
                assertReviewArtifactFileSha256(
                    findingsValidationEvidence.dispositionEvidence.artifactPath,
                    findingsValidationEvidence.dispositionEvidence.artifactSha256,
                    'Reused review findings disposition artifact'
                );
                assertReviewArtifactFileSha256(
                    findingsValidationEvidence.dispositionEvidence.snapshotPath,
                    findingsValidationEvidence.dispositionEvidence.artifactSha256,
                    'Reused review findings disposition snapshot'
                );
            }
            const recordedEvent = await emitReviewRecordedEventAsync(
                orchestratorRoot,
                options.taskId,
                options.reviewType,
                buildReuseRecordedEventDetails({
                    options,
                    refreshedReceipt,
                    receiptPayloadSha256,
                    receiptSnapshotPath,
                    artifactSnapshotPath
                })
            );
            if (!recordedEvent || taskEventAppendHasBlockingFailure(recordedEvent, false)) {
                throw new Error('REVIEW_RECORDED telemetry could not be persisted for review reuse.');
            }
        });
        return { materialized: true, reason: null };
    } catch {
        return {
            materialized: false,
            reason: 'current-cycle REVIEW_RECORDED reuse telemetry could not be persisted'
        };
    }
}

function buildReusedReviewFindingsValidationEvidence(
    options: MaterializeReusedReviewEvidenceOptions
): { evidence: ReusedReviewFindingsValidationEvidence } | { reason: string } {
    if (!options.receipt) {
        return { reason: 'reused review findings validation failed: source receipt is missing.' };
    }
    const sourceReviewArtifactPath = getReceiptBoundFindingsReviewArtifactPath(options.receipt)
        || options.candidate.sourceArtifactPath
        || options.artifactPath;
    const sourceValidation = validateReviewFindingsValidationArtifactForReceipt({
        receipt: options.receipt as unknown as Record<string, unknown>,
        reviewArtifactPath: sourceReviewArtifactPath,
        expectedTaskId: options.taskId,
        expectedReviewType: options.reviewType,
        expectedReviewOutputSha256: getReceiptRecordString(options.receipt, 'review_output_sha256')
            || getReceiptOutputContractString(options.receipt, 'raw_output_sha256'),
        expectedReviewArtifactSha256: options.historicalReviewArtifactSha256,
        expectedReviewContextSha256: options.expectedContextSha256,
        expectedPreflightSha256: getReceiptRecordString(options.receipt, 'preflight_sha256'),
        expectedScopeSha256: getReceiptRecordString(options.receipt, 'scope_sha256'),
        expectedReviewScopeSha256: options.expectedReviewScopeSha256,
        expectedCodeScopeSha256: options.expectedCodeScopeSha256,
        expectedReviewTreeStateSha256: options.expectedReviewTreeStateSha256,
        expectedCoverageContractSha256: getReceiptOutputContractString(options.receipt, 'coverage_contract_sha256'),
        requireAccepted: true,
        preferSnapshot: true,
        allowLegacyMissingExecutionBinding: options.historicalSchema3ContextReuseHashMatches
    });
    if (!sourceValidation.valid || !sourceValidation.artifact) {
        return { reason: `reused review findings validation failed: ${sourceValidation.violations.join(' ')}` };
    }
    if (!sourceValidation.reference || !sourceValidation.artifact_sha256) {
        return { reason: 'reused review findings validation failed: source receipt evidence is incomplete.' };
    }
    const historicalValidationBindings = sourceValidation.artifact.validation_result.bindings;
    const historicalExecutionBindingDeclared = Object.prototype.hasOwnProperty.call(
        historicalValidationBindings,
        'execution'
    );
    const historicalExecutionBindings = historicalValidationBindings.execution ?? null;
    if (historicalExecutionBindingDeclared) {
        const historicalExecutionViolations = getReviewExecutionEvidenceBindingViolations({
            expectedEvidence: historicalExecutionBindings,
            evidence: historicalExecutionBindings,
            evidenceLabel: 'historical review findings validation artifact execution binding',
            expectedEvidenceLabel: 'historical review findings validation artifact execution binding'
        });
        if (!historicalExecutionBindings || historicalExecutionViolations.length > 0) {
            return {
                reason: `reused review findings validation failed: ${historicalExecutionViolations.join(' ')}`
            };
        }
    }
    const validationArtifactPath = getReviewFindingsValidationArtifactPath(options.artifactPath);
    if (gateHelpers.normalizePath(sourceValidation.reference.artifact_path) !== gateHelpers.normalizePath(validationArtifactPath)) {
        return { reason: 'reused review findings validation failed: source artifact path does not match the current review lane.' };
    }
    const policyResolution = resolveLockedReviewFindingPolicyFromReceiptDispositionEvidence(
        options.receipt as unknown as Record<string, unknown>
    );
    if (reviewFindingsValidationArtifactHasBlockingFindings(sourceValidation.artifact, policyResolution)) {
        return { reason: 'reused review findings validation contains policy-blocking active findings or residual risks' };
    }
    const receiptRecord = options.receipt as unknown as Record<string, unknown>;
    const sourceReport = receiptRecord.review_findings_report
        && typeof receiptRecord.review_findings_report === 'object'
        && !Array.isArray(receiptRecord.review_findings_report)
        ? receiptRecord.review_findings_report as ReviewFindingsReport
        : null;
    if (!sourceReport) {
        return { reason: 'reused review findings validation failed: source receipt is missing review_findings_report.' };
    }
    const validation: JsonReviewFindingsArtifactValidation = {
        detected: true,
        valid: true,
        report: sourceReport,
        violations: [],
        coverage_validation: sourceValidation.artifact.validation_result.coverage_status
    };
    const rawOutputSha256 = normalizeSha256(getReceiptRecordString(options.receipt, 'review_output_sha256'))
        || normalizeSha256(getReceiptOutputContractString(options.receipt, 'raw_output_sha256'))
        || normalizeSha256(options.historicalReviewArtifactSha256);
    const disposition = validateReviewFindingsDispositionEvidence({
        repoRoot: options.repoRoot,
        receipt: options.receipt as unknown as Record<string, unknown>,
        receiptPath: options.candidate.telemetryReceiptPath,
        reviewArtifactPath: sourceReviewArtifactPath,
        expectedTaskId: options.taskId,
        expectedReviewType: options.reviewType,
        validationArtifact: sourceValidation.artifact,
        validationArtifactPath: sourceValidation.reference.artifact_path,
        validationArtifactSha256: sourceValidation.artifact_sha256,
        policyResolution,
        expectedReceiptPath: options.reusedFromReceiptPath,
        expectedReceiptSha256: options.reusedFromReceiptSha256,
        preferSnapshot: true
    });
    if (!disposition.valid || !disposition.artifact || !disposition.artifact_sha256) {
        return {
            reason: `reused review findings disposition evidence is not satisfied: ${disposition.violations.join(' ')}`
        };
    }
    const dispositionArtifactPath = getReviewFindingsDispositionArtifactPath(options.artifactPath);
    const dispositionEvidence: ReusedReviewFindingsDispositionEvidence = {
        artifactPath: dispositionArtifactPath,
        snapshotPath: getReviewFindingsDispositionArtifactSnapshotPath(
            dispositionArtifactPath,
            disposition.artifact_sha256
        ),
        artifactSha256: disposition.artifact_sha256,
        payload: disposition.artifact
    };
    return {
        evidence: {
            artifactPath: validationArtifactPath,
            snapshotPath: getReviewFindingsValidationArtifactSnapshotPath(
                validationArtifactPath,
                sourceValidation.artifact_sha256
            ),
            artifactSha256: sourceValidation.artifact_sha256,
            payload: sourceValidation.artifact,
            validation,
            rawOutputSha256,
            policyResolution,
            dispositionEvidence,
            historicalExecutionBindings
        }
    };
}

function attachReusedReviewFindingsReceiptEvidence(
    refreshedReceipt: ReviewReceipt,
    evidence: ReusedReviewFindingsValidationEvidence,
    currentReviewContext: Record<string, unknown>
): void {
    const report = evidence.validation.report;
    if (!report) {
        return;
    }
    const receiptRecord = refreshedReceipt as unknown as Record<string, unknown>;
    const executionBindings = resolveReviewContextExecutionEvidenceBindings(currentReviewContext).bindings;
    const historicalExecutionBindings = evidence.historicalExecutionBindings;
    if (historicalExecutionBindings) {
        receiptRecord.reused_from_review_execution_mode = historicalExecutionBindings.review_execution_mode;
        receiptRecord.reused_from_review_execution_contract_sha256 =
            historicalExecutionBindings.review_execution_contract_sha256;
        receiptRecord.reused_from_review_execution_full_scope_sha256 =
            historicalExecutionBindings.review_execution_full_scope_sha256;
        receiptRecord.reused_from_review_execution_complete_scope_lineage_sha256 =
            historicalExecutionBindings.review_execution_complete_scope_lineage_sha256;
        receiptRecord.reused_from_review_execution_finding_reconciliation_sha256 =
            historicalExecutionBindings.review_execution_finding_reconciliation_sha256;
    }
    const reportSha256 = sha256RedactedJsonPayload(report);
    receiptRecord.review_output_sha256 = evidence.rawOutputSha256;
    receiptRecord.review_output_format = 'findings_json';
    receiptRecord.review_output_schema_version = report.schema_version;
    receiptRecord.review_findings_report_sha256 = reportSha256;
    receiptRecord.review_findings_report = report;
    receiptRecord.review_findings_summary = summarizeReviewFindingsReport(report);
    receiptRecord.review_findings_validation = summarizeReviewFindingsValidationEvidence(evidence);
    receiptRecord.review_findings_disposition = evidence.dispositionEvidence.payload.disposition_result;
    receiptRecord.review_findings_disposition_artifact =
        summarizeReviewFindingsDispositionEvidence(evidence.dispositionEvidence);
    receiptRecord.review_output_contract = {
        schema_version: 1,
        format: 'findings_json',
        report_sha256: reportSha256,
        validation_artifact_sha256: evidence.artifactSha256,
        validation_result_sha256: evidence.payload.validation_result_sha256,
        disposition_artifact_sha256: evidence.dispositionEvidence.artifactSha256,
        disposition_result_sha256: evidence.dispositionEvidence.payload.disposition_result_sha256,
        raw_output_sha256: evidence.rawOutputSha256,
        review_artifact_sha256: refreshedReceipt.review_artifact_sha256,
        review_context_sha256: refreshedReceipt.reused_from_review_context_sha256 ?? refreshedReceipt.review_context_sha256,
        review_tree_state_sha256: refreshedReceipt.reused_from_review_tree_state_sha256 ?? refreshedReceipt.review_tree_state_sha256 ?? null,
        coverage_contract_sha256: report.coverage_ledger.coverage_contract_sha256,
        ...(executionBindings || {}),
        reviewer_identity: refreshedReceipt.reviewer_identity,
        reviewer_provenance_event_sha256: refreshedReceipt.reviewer_provenance?.event_sha256 ?? null
    };
}

function buildReusedReviewReceipt(
    options: MaterializeReusedReviewEvidenceOptions,
    currentReviewContext: Record<string, unknown>
): ReviewReceipt {
    const currentDomainScopeFingerprints = buildDomainScopeFingerprints({
        repoRoot: options.repoRoot,
        detectionSource: String(options.preflightPayload.detection_source || 'git_auto'),
        includeUntracked: options.preflightPayload.include_untracked !== false,
        changedFiles: Array.isArray(options.preflightPayload.changed_files)
            ? options.preflightPayload.changed_files as string[]
            : []
    });
    const contractBindings = resolveReviewContextReuseContractBindings(currentReviewContext);
    const refreshedReceipt = buildReviewReceipt({
        taskId: options.taskId,
        reviewType: options.reviewType,
        preflightSha256: options.currentPreflightHash,
        scopeSha256: String(
            (options.preflightPayload.metrics as Record<string, unknown> | undefined)?.scope_sha256
            || (options.preflightPayload.metrics as Record<string, unknown> | undefined)?.changed_files_sha256
            || ''
        ).trim() || null,
        reviewScopeSha256: String(options.reviewScopeFingerprint.review_scope_sha256 || '').trim().toLowerCase() || null,
        codeScopeSha256: options.nonTestReviewScope
            ? String(options.codeScopeFingerprint.code_scope_sha256 || '').trim().toLowerCase() || null
            : null,
        domainScopeFingerprints: currentDomainScopeFingerprints,
        reviewContextSha256: options.currentReviewContextSha256,
        reviewTreeStateSha256: options.currentReviewTreeStateSha256,
        reviewContextReuseSha256: options.currentContextReuseSha256,
        reviewCoverageContractSha256: contractBindings.coverageContractSha256,
        reviewRuleContextSha256: contractBindings.ruleContextSha256,
        reviewArtifactSha256: options.historicalReviewArtifactSha256,
        reviewerExecutionMode: options.reviewerExecutionMode,
        reviewerIdentity: options.reviewerIdentity,
        reviewerFallbackReason: options.receipt.reviewer_fallback_reason ?? null,
        reviewerProvenance: options.historicalReviewerProvenance,
        trustLevel: 'INDEPENDENT_AUDITED',
        reusedExistingReview: true,
        reusedFromReceiptPath: options.reusedFromReceiptPath,
        reusedFromReceiptSha256: options.reusedFromReceiptSha256,
        reusedFromReviewContextSha256: options.expectedContextSha256,
        reusedFromReviewContextReuseSha256: options.expectedContextReuseSha256,
        reusedFromReviewTreeStateSha256: options.expectedReviewTreeStateSha256,
        reusedFromReviewScopeSha256: options.expectedReviewScopeSha256,
        reusedFromCodeScopeSha256: options.expectedCodeScopeSha256,
        reusedFromDomainScopeFingerprints: normalizeDomainScopeFingerprints(options.receipt.domain_scope_fingerprints)
    });
    const refreshedReceiptRecord = refreshedReceipt as unknown as Record<string, unknown>;
    if (options.historicalSchema3ContextReuseHashMatches) {
        refreshedReceiptRecord.reused_from_review_context_schema_version = 3;
    }
    const executionBindings = resolveReviewContextExecutionEvidenceBindings(currentReviewContext).bindings;
    if (executionBindings) {
        Object.assign(refreshedReceiptRecord, executionBindings);
    } else {
        refreshedReceiptRecord.review_execution_contract_sha256 = contractBindings.reviewExecutionContractSha256;
        refreshedReceiptRecord.review_execution_mode = contractBindings.reviewExecutionMode;
        refreshedReceiptRecord.review_execution_full_scope_sha256 = contractBindings.reviewExecutionFullScopeSha256;
    }
    if (isCustomReviewLaneInSnapshot(options.preflightPayload, options.reviewType)) {
        Object.assign(
            refreshedReceipt,
            buildReviewLaneArtifactEvidence(
                resolveReviewContextLaneBinding(options.preflightPayload, options.reviewType)
            )
        );
    }
    return refreshedReceipt;
}

function buildReuseRecordedEventDetails(input: {
    options: MaterializeReusedReviewEvidenceOptions;
    refreshedReceipt: ReviewReceipt;
    receiptPayloadSha256: string;
    receiptSnapshotPath: string;
    artifactSnapshotPath: string;
}): Record<string, unknown> {
    return {
        ...input.refreshedReceipt,
        reused_existing_review: true,
        reuse_event_type: 'REVIEW_EVIDENCE_REUSED',
        reused_from_receipt_path: input.options.reusedFromReceiptPath,
        reused_from_receipt_sha256: input.options.reusedFromReceiptSha256,
        reused_from_review_context_sha256: input.options.expectedContextSha256,
        reused_from_review_context_reuse_sha256: input.options.expectedContextReuseSha256,
        reused_from_review_tree_state_sha256: input.options.expectedReviewTreeStateSha256,
        reused_from_review_scope_sha256: input.options.expectedReviewScopeSha256,
        reused_from_code_scope_sha256: input.options.expectedCodeScopeSha256,
        receipt_path: gateHelpers.normalizePath(input.options.receiptPath),
        receipt_sha256: input.receiptPayloadSha256,
        receipt_snapshot_path: gateHelpers.normalizePath(input.receiptSnapshotPath),
        receipt_snapshot_sha256: input.receiptPayloadSha256,
        review_artifact_path: gateHelpers.normalizePath(input.options.artifactPath),
        review_artifact_snapshot_path: gateHelpers.normalizePath(input.artifactSnapshotPath),
        review_artifact_snapshot_sha256: input.options.historicalReviewArtifactSha256,
        review_context_path: gateHelpers.normalizePath(input.options.reviewContextPath),
        review_context_sha256: input.options.currentReviewContextSha256
    };
}
