import * as fs from 'node:fs';

import { sha256RedactedJsonPayload } from '../../core/redaction';
import { fileSha256 } from '../../gate-runtime/hash';
import type { ReviewFindingPolicy } from '../../policy/profile-resolver';
import { normalizePath } from '../shared/helpers';
import {
    getReviewCoverageContractViolations,
    parseReviewEvidenceLocation,
    type ReviewCoverageContract
} from '../review/review-coverage-ledger';
import {
    REVIEW_FINDINGS_DISPOSITION_ARTIFACT_SCHEMA_VERSION,
    REVIEW_FINDINGS_DISPOSITION_ARTIFACT_TYPE,
    type ReviewFindingsDispositionArtifact,
    type ReviewFindingsDispositionArtifactItem
} from '../review/review-findings-disposition-artifact';
import {
    REVIEW_FINDINGS_VALIDATION_ARTIFACT_SCHEMA_VERSION,
    REVIEW_FINDINGS_VALIDATION_ARTIFACT_TYPE,
    type NormalizedReviewFindingInventoryEntry,
    type NormalizedReviewResidualRiskInventoryEntry,
    type ReviewFindingsValidationArtifact
} from '../review/review-findings-validation-artifact';
import {
    getReviewRemediationDeltaBaseViolations,
    type ReviewRemediationDeltaBase
} from './review-remediation-delta-contract';

export const REVIEW_REMEDIATION_BASELINE_ARTIFACT_TYPE = 'review_findings_remediation_baseline';
export const REVIEW_REMEDIATION_BASELINE_LEGACY_SCHEMA_VERSION = 1;
export const REVIEW_REMEDIATION_BASELINE_SCHEMA_VERSION = 2;

type RemediationItemKind = 'finding' | 'residual_risk';

export interface ReviewRemediationAcceptedFinding {
    id: string;
    severity: 'critical' | 'high' | 'medium' | 'low';
    title: string;
    description: string;
    evidence_locations: string[];
    coverage_obligation_ids: string[];
}

export interface ReviewRemediationAcceptedResidualRisk {
    id: string;
    description: string;
    evidence_locations: string[];
}

export interface ReviewRemediationFixNowItem {
    id: string;
    kind: RemediationItemKind;
    severity: 'critical' | 'high' | 'medium' | 'low' | 'residual_risk';
    action: 'fix_now';
    source_rule: string;
    evidence_locations: string[];
}

export interface ReviewRemediationPathLineInventoryEntry {
    path: string;
    line: number;
    item_ids: string[];
}

export interface ReviewRemediationSnapshotBinding {
    artifact_path: string;
    artifact_sha256: string;
    snapshot_path: string;
    snapshot_sha256: string;
}

interface ReviewRemediationBaselineArtifactCommon {
    artifact_type: typeof REVIEW_REMEDIATION_BASELINE_ARTIFACT_TYPE;
    task_id: string;
    review_type: string;
    accepted_findings: ReviewRemediationAcceptedFinding[];
    accepted_residual_risks: ReviewRemediationAcceptedResidualRisk[];
    accepted_inventory_sha256: string;
    fix_now_items: ReviewRemediationFixNowItem[];
    fix_now_items_sha256: string;
    path_line_inventory: ReviewRemediationPathLineInventoryEntry[];
    path_line_inventory_sha256: string;
    origin_coverage_contract?: ReviewCoverageContract;
    bindings: {
        receipt: ReviewRemediationSnapshotBinding;
        review_artifact: ReviewRemediationSnapshotBinding;
        findings_validation: ReviewRemediationSnapshotBinding & {
            validation_result_sha256: string;
        };
        findings_disposition: ReviewRemediationSnapshotBinding & {
            disposition_result_sha256: string;
            source_validation_artifact_sha256: string;
            source_validation_result_sha256: string;
        };
        context: {
            review_context_path: string;
            review_context_sha256: string;
        };
        scope: {
            preflight_path: string;
            preflight_sha256: string;
            scope_sha256: string;
            review_scope_sha256: string;
            code_scope_sha256: string | null;
        };
        tree: {
            review_tree_state_sha256: string;
        };
        policy: {
            policy_id: string;
            policy_source: string;
            review_finding_policy: ReviewFindingPolicy;
            review_finding_policy_sha256: string;
            profile_policy_snapshot_sha256: string;
        };
        findings_report_sha256: string;
    };
}

export interface LegacyReviewRemediationBaselineArtifact extends ReviewRemediationBaselineArtifactCommon {
    schema_version: typeof REVIEW_REMEDIATION_BASELINE_LEGACY_SCHEMA_VERSION;
    delta_base?: ReviewRemediationDeltaBase;
}

export interface CurrentReviewRemediationBaselineArtifact extends ReviewRemediationBaselineArtifactCommon {
    schema_version: typeof REVIEW_REMEDIATION_BASELINE_SCHEMA_VERSION;
    delta_base: ReviewRemediationDeltaBase;
}

export type ReviewRemediationBaselineArtifact =
    | LegacyReviewRemediationBaselineArtifact
    | CurrentReviewRemediationBaselineArtifact;

export interface BuildReviewRemediationBaselineOptions {
    taskId: string;
    reviewType: string;
    reviewArtifactPath: string;
    reviewArtifactSha256: string;
    receiptPath: string;
    receiptSha256: string;
    receipt: Record<string, unknown>;
    validationArtifactPath: string;
    validationArtifactSha256: string;
    validationArtifact: ReviewFindingsValidationArtifact;
    dispositionArtifactPath: string;
    dispositionArtifactSha256: string;
    dispositionArtifact: ReviewFindingsDispositionArtifact;
    profilePolicySnapshot: unknown;
    deltaBase?: ReviewRemediationDeltaBase;
    originCoverageContract?: ReviewCoverageContract;
}

export interface ReviewRemediationBaselineValidationOptions {
    artifactPath: string;
    expectedArtifactSha256?: string | null;
    expectedTaskId: string;
    expectedReviewType: string;
    expectedReceiptSha256?: string | null;
    expectedReviewContextSha256?: string | null;
    expectedReviewTreeStateSha256?: string | null;
    expectedScopeSha256?: string | null;
    expectedProfilePolicySnapshotSha256?: string | null;
}

export interface ReviewRemediationBaselineValidationResult {
    valid: boolean;
    artifact: ReviewRemediationBaselineArtifact | null;
    artifact_sha256: string | null;
    violations: string[];
}

const SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeHash(value: unknown): string | null {
    const normalized = String(value || '').trim().toLowerCase();
    return SHA256_PATTERN.test(normalized) ? normalized : null;
}

function requireHash(value: unknown, subject: string): string {
    const normalized = normalizeHash(value);
    if (!normalized) {
        throw new Error(`Review remediation baseline requires ${subject} as a SHA-256 hash.`);
    }
    return normalized;
}

function requirePath(value: unknown, subject: string): string {
    const normalized = normalizePath(String(value || '').trim());
    if (!normalized) {
        throw new Error(`Review remediation baseline requires ${subject}.`);
    }
    return normalized;
}

function cloneFinding(finding: NormalizedReviewFindingInventoryEntry): ReviewRemediationAcceptedFinding {
    return {
        id: finding.id,
        severity: finding.severity,
        title: finding.title,
        description: finding.description,
        evidence_locations: [...finding.evidence_locations],
        coverage_obligation_ids: [...finding.coverage_obligation_ids]
    };
}

function cloneRisk(risk: NormalizedReviewResidualRiskInventoryEntry): ReviewRemediationAcceptedResidualRisk {
    return {
        id: risk.id,
        description: risk.description,
        evidence_locations: [...risk.evidence_locations]
    };
}

function acceptedInventory(validationArtifact: ReviewFindingsValidationArtifact): {
    findings: ReviewRemediationAcceptedFinding[];
    residualRisks: ReviewRemediationAcceptedResidualRisk[];
} {
    const inventory = validationArtifact.validation_result.normalized_inventory;
    return {
        findings: SEVERITIES.flatMap((severity) => inventory.findings_by_severity[severity])
            .filter((finding) => finding.id !== 'F-000')
            .map(cloneFinding),
        residualRisks: inventory.residual_risks.map(cloneRisk)
    };
}

function evidenceLocationsForItem(
    item: ReviewFindingsDispositionArtifactItem,
    findings: readonly ReviewRemediationAcceptedFinding[],
    residualRisks: readonly ReviewRemediationAcceptedResidualRisk[]
): string[] {
    const source = item.kind === 'finding'
        ? findings.find((candidate) => candidate.id === item.id)
        : residualRisks.find((candidate) => candidate.id === item.id);
    if (!source) {
        throw new Error(
            `Review remediation baseline fix_now item '${item.id}' is missing from the accepted validation inventory.`
        );
    }
    return [...source.evidence_locations];
}

function buildFixNowItems(
    dispositionArtifact: ReviewFindingsDispositionArtifact,
    findings: readonly ReviewRemediationAcceptedFinding[],
    residualRisks: readonly ReviewRemediationAcceptedResidualRisk[]
): ReviewRemediationFixNowItem[] {
    return dispositionArtifact.items
        .filter((item) => item.action === 'fix_now')
        .map((item) => ({
            id: item.id,
            kind: item.kind,
            severity: item.severity,
            action: 'fix_now' as const,
            source_rule: item.source_rule,
            evidence_locations: evidenceLocationsForItem(item, findings, residualRisks)
        }));
}

function buildPathLineInventory(
    items: readonly ReviewRemediationFixNowItem[]
): ReviewRemediationPathLineInventoryEntry[] {
    const entries = new Map<string, ReviewRemediationPathLineInventoryEntry>();
    for (const item of items) {
        for (const location of item.evidence_locations) {
            const parsed = parseReviewEvidenceLocation(location);
            if (!parsed) {
                throw new Error(
                    `Review remediation baseline fix_now item '${item.id}' has an invalid path-and-line location '${location}'.`
                );
            }
            const key = `${parsed.filePath}:${parsed.line}`;
            const existing = entries.get(key);
            if (existing) {
                if (!existing.item_ids.includes(item.id)) {
                    existing.item_ids.push(item.id);
                    existing.item_ids.sort();
                }
            } else {
                entries.set(key, {
                    path: parsed.filePath,
                    line: parsed.line,
                    item_ids: [item.id]
                });
            }
        }
    }
    return [...entries.values()].sort((left, right) =>
        left.path.localeCompare(right.path) || left.line - right.line
    );
}

function snapshotBinding(artifactPath: string, artifactSha256: string, snapshotPath: string): ReviewRemediationSnapshotBinding {
    const hash = requireHash(artifactSha256, `${artifactPath} artifact hash`);
    return {
        artifact_path: requirePath(artifactPath, 'artifact_path'),
        artifact_sha256: hash,
        snapshot_path: requirePath(snapshotPath, 'snapshot_path'),
        snapshot_sha256: hash
    };
}

function getProfilePolicySnapshotSha256(snapshot: unknown): string {
    if (isRecord(snapshot)) {
        const declared = normalizeHash(snapshot.snapshot_hash);
        if (declared) {
            return declared;
        }
    }
    return sha256RedactedJsonPayload(snapshot ?? null);
}

function receiptString(receipt: Record<string, unknown>, key: string): string | null {
    const value = String(receipt[key] || '').trim();
    return value || null;
}

function assertReceiptBinding(
    receipt: Record<string, unknown>,
    key: string,
    expected: string,
    subject: string
): void {
    if (receiptString(receipt, key)?.toLowerCase() !== expected.toLowerCase()) {
        throw new Error(`Review remediation baseline ${subject} does not match the review receipt.`);
    }
}

export function getReviewRemediationBaselineArtifactPath(reviewArtifactPath: string): string {
    return String(reviewArtifactPath || '').replace(/\.md$/u, '-remediation-baseline.json');
}

export function getReviewRemediationBaselineSnapshotPath(artifactPath: string, artifactSha256: string): string {
    return String(artifactPath || '').replace(/\.json$/u, `-${artifactSha256}.json`);
}

function getOriginCoverageContractViolations(
    value: unknown,
    reviewType: string,
    expectedSha256: unknown
): string[] {
    if (!isRecord(value) || !Array.isArray(value.obligations)
        || !value.obligations.every((entry) => isRecord(entry) && typeof entry.target === 'string')) {
        return ['origin_coverage_contract has invalid shape.'];
    }
    const obligations = value.obligations as ReviewCoverageContract['obligations'];
    const violations = getReviewCoverageContractViolations(value, {
        reviewType,
        changedFiles: obligations.filter((entry) => entry.kind === 'file').map((entry) => entry.target),
        categoryIds: obligations.filter((entry) => entry.kind === 'category').map((entry) => entry.target)
    });
    if (!normalizeHash(expectedSha256) || value.contract_sha256 !== normalizeHash(expectedSha256)) {
        violations.push('origin_coverage_contract does not match the authenticated findings-validation coverage hash.');
    }
    return violations;
}

export function buildReviewRemediationBaselineArtifact(
    options: BuildReviewRemediationBaselineOptions & { deltaBase: ReviewRemediationDeltaBase }
): CurrentReviewRemediationBaselineArtifact;
export function buildReviewRemediationBaselineArtifact(
    options: BuildReviewRemediationBaselineOptions
): ReviewRemediationBaselineArtifact;
export function buildReviewRemediationBaselineArtifact(
    options: BuildReviewRemediationBaselineOptions
): ReviewRemediationBaselineArtifact {
    if (
        options.validationArtifact.validation_result.status !== 'accepted'
        || options.validationArtifact.validation_result.accepted !== true
    ) {
        throw new Error('Review remediation baseline requires accepted findings validation evidence.');
    }
    if (options.validationArtifact.task_id !== options.taskId || options.dispositionArtifact.task_id !== options.taskId) {
        throw new Error('Review remediation baseline evidence belongs to a foreign task.');
    }
    if (
        options.validationArtifact.review_type !== options.reviewType
        || options.dispositionArtifact.review_type !== options.reviewType
    ) {
        throw new Error('Review remediation baseline evidence belongs to a foreign review type.');
    }

    const validationSha256 = requireHash(options.validationArtifactSha256, 'validation artifact hash');
    const dispositionSha256 = requireHash(options.dispositionArtifactSha256, 'disposition artifact hash');
    if (options.dispositionArtifact.source_validation.artifact_sha256 !== validationSha256) {
        throw new Error('Review remediation baseline disposition evidence is inconsistent with validation evidence.');
    }
    if (
        options.dispositionArtifact.source_validation.validation_result_sha256
        !== options.validationArtifact.validation_result_sha256
    ) {
        throw new Error('Review remediation baseline disposition validation result hash is inconsistent.');
    }

    const inventory = acceptedInventory(options.validationArtifact);
    const fixNowItems = buildFixNowItems(options.dispositionArtifact, inventory.findings, inventory.residualRisks);
    if (fixNowItems.length === 0) {
        throw new Error('Review remediation baseline requires at least one fix_now disposition.');
    }
    const pathLineInventory = buildPathLineInventory(fixNowItems);
    const receiptSha256 = requireHash(options.receiptSha256, 'receipt hash');
    const reviewArtifactSha256 = requireHash(options.reviewArtifactSha256, 'review artifact hash');
    const validationResult = options.validationArtifact.validation_result;
    const scope = validationResult.bindings.scope;
    const context = validationResult.bindings.context;
    const tree = validationResult.bindings.tree;
    const findingsReportSha256 = requireHash(
        options.receipt.review_findings_report_sha256,
        'review findings report hash'
    );
    assertReceiptBinding(options.receipt, 'task_id', options.taskId, 'task');
    assertReceiptBinding(options.receipt, 'review_type', options.reviewType, 'review type');
    assertReceiptBinding(options.receipt, 'review_findings_report_sha256', findingsReportSha256, 'findings report hash');
    assertReceiptBinding(options.receipt, 'review_artifact_sha256', reviewArtifactSha256, 'review artifact hash');
    assertReceiptBinding(options.receipt, 'review_context_sha256', requireHash(context.review_context_sha256, 'context hash'), 'context hash');
    assertReceiptBinding(options.receipt, 'review_tree_state_sha256', requireHash(tree.review_tree_state_sha256, 'tree-state hash'), 'tree-state hash');

    const receiptPath = requirePath(options.receiptPath, 'receipt path');
    const reviewArtifactPath = requirePath(options.reviewArtifactPath, 'review artifact path');
    const validationArtifactPath = requirePath(options.validationArtifactPath, 'validation artifact path');
    const dispositionArtifactPath = requirePath(options.dispositionArtifactPath, 'disposition artifact path');
    const policy = options.dispositionArtifact.policy.review_finding_policy;
    if (options.originCoverageContract !== undefined) {
        const violations = getOriginCoverageContractViolations(
            options.originCoverageContract, options.reviewType, validationResult.bindings.coverage_contract_sha256
        );
        if (violations.length > 0) {
            throw new Error(`Review remediation baseline origin coverage is invalid: ${violations.join(' ')}`);
        }
    }
    if (options.deltaBase) {
        const deltaBaseViolations = getReviewRemediationDeltaBaseViolations(options.deltaBase, {
            taskId: options.taskId,
            reviewType: options.reviewType,
            reviewTreeStateSha256: tree.review_tree_state_sha256 || undefined
        });
        if (deltaBaseViolations.length > 0) {
            throw new Error(`Review remediation baseline delta_base is invalid: ${deltaBaseViolations.join(' ')}`);
        }
    }
    const artifactCommon: ReviewRemediationBaselineArtifactCommon = {
        artifact_type: REVIEW_REMEDIATION_BASELINE_ARTIFACT_TYPE,
        task_id: options.taskId,
        review_type: options.reviewType,
        accepted_findings: inventory.findings,
        accepted_residual_risks: inventory.residualRisks,
        accepted_inventory_sha256: sha256RedactedJsonPayload(inventory),
        fix_now_items: fixNowItems,
        fix_now_items_sha256: sha256RedactedJsonPayload(fixNowItems),
        path_line_inventory: pathLineInventory,
        path_line_inventory_sha256: sha256RedactedJsonPayload(pathLineInventory),
        ...(options.originCoverageContract !== undefined ? {
            origin_coverage_contract: structuredClone(options.originCoverageContract)
        } : {}),
        bindings: {
            receipt: snapshotBinding(
                receiptPath,
                receiptSha256,
                receiptPath.replace(/\.json$/u, `-${receiptSha256}.json`)
            ),
            review_artifact: snapshotBinding(
                reviewArtifactPath,
                reviewArtifactSha256,
                reviewArtifactPath.replace(/\.md$/u, `-artifact-${reviewArtifactSha256}.md`)
            ),
            findings_validation: {
                ...snapshotBinding(
                    validationArtifactPath,
                    validationSha256,
                    validationArtifactPath.replace(/\.json$/u, `-${validationSha256}.json`)
                ),
                validation_result_sha256: requireHash(
                    options.validationArtifact.validation_result_sha256,
                    'validation result hash'
                )
            },
            findings_disposition: {
                ...snapshotBinding(
                    dispositionArtifactPath,
                    dispositionSha256,
                    dispositionArtifactPath.replace(/\.json$/u, `-${dispositionSha256}.json`)
                ),
                disposition_result_sha256: requireHash(
                    options.dispositionArtifact.disposition_result_sha256,
                    'disposition result hash'
                ),
                source_validation_artifact_sha256: validationSha256,
                source_validation_result_sha256: requireHash(
                    options.validationArtifact.validation_result_sha256,
                    'validation result hash'
                )
            },
            context: {
                review_context_path: requirePath(context.review_context_path, 'review context path'),
                review_context_sha256: requireHash(context.review_context_sha256, 'review context hash')
            },
            scope: {
                preflight_path: requirePath(scope.preflight_path, 'preflight path'),
                preflight_sha256: requireHash(scope.preflight_sha256, 'preflight hash'),
                scope_sha256: requireHash(scope.scope_sha256, 'scope hash'),
                review_scope_sha256: requireHash(scope.review_scope_sha256, 'review scope hash'),
                code_scope_sha256: scope.code_scope_sha256
                    ? requireHash(scope.code_scope_sha256, 'code scope hash')
                    : null
            },
            tree: {
                review_tree_state_sha256: requireHash(tree.review_tree_state_sha256, 'tree-state hash')
            },
            policy: {
                policy_id: options.dispositionArtifact.policy.policy_id,
                policy_source: options.dispositionArtifact.policy.policy_source,
                review_finding_policy: {
                    ...policy,
                    findings: { ...policy.findings }
                },
                review_finding_policy_sha256: sha256RedactedJsonPayload(policy),
                profile_policy_snapshot_sha256: getProfilePolicySnapshotSha256(options.profilePolicySnapshot)
            },
            findings_report_sha256: findingsReportSha256
        }
    };
    if (!options.deltaBase) {
        return {
            schema_version: REVIEW_REMEDIATION_BASELINE_LEGACY_SCHEMA_VERSION,
            ...artifactCommon
        };
    }
    return {
        schema_version: REVIEW_REMEDIATION_BASELINE_SCHEMA_VERSION,
        ...artifactCommon,
        delta_base: options.deltaBase
    };
}

function validateSnapshotBinding(
    value: unknown,
    subject: string,
    violations: string[]
): value is ReviewRemediationSnapshotBinding {
    if (!isRecord(value)) {
        violations.push(`${subject} must be an object.`);
        return false;
    }
    const artifactPath = normalizePath(String(value.artifact_path || '').trim());
    const snapshotPath = normalizePath(String(value.snapshot_path || '').trim());
    const artifactSha256 = normalizeHash(value.artifact_sha256);
    const snapshotSha256 = normalizeHash(value.snapshot_sha256);
    if (!artifactPath || !snapshotPath || !artifactSha256 || !snapshotSha256) {
        violations.push(`${subject} is incomplete.`);
        return false;
    }
    if (artifactSha256 !== snapshotSha256) {
        violations.push(`${subject} artifact and snapshot hashes differ.`);
    }
    validateBoundFileHash(artifactPath, artifactSha256, `${subject} artifact`, violations);
    validateBoundFileHash(snapshotPath, snapshotSha256, `${subject} snapshot`, violations);
    return true;
}

function validateBoundFileHash(
    filePath: string,
    expectedSha256: string,
    subject: string,
    violations: string[]
): void {
    try {
        if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
            violations.push(`${subject} '${filePath}' is missing.`);
            return;
        }
        const actualSha256 = fileSha256(filePath);
        if (actualSha256 !== expectedSha256) {
            violations.push(
                `${subject} hash mismatch: expected ${expectedSha256}, found ${actualSha256}.`
            );
        }
    } catch (error: unknown) {
        const detail = error instanceof Error ? error.message : String(error);
        violations.push(`${subject} '${filePath}' could not be authenticated: ${detail}`);
    }
}

function validateExpectedHash(
    violations: string[],
    subject: string,
    actual: unknown,
    expected: unknown
): void {
    if (expected === undefined || expected === null) {
        return;
    }
    const expectedHash = normalizeHash(expected);
    if (!expectedHash) {
        violations.push(`${subject} expected value must be a SHA-256 hash.`);
        return;
    }
    if (normalizeHash(actual) !== expectedHash) {
        violations.push(`${subject} mismatch: expected ${expectedHash}, found ${String(actual || 'missing')}.`);
    }
}

function parseBaseline(value: unknown): ReviewRemediationBaselineArtifact | null {
    const isLegacy = isRecord(value)
        && value.schema_version === REVIEW_REMEDIATION_BASELINE_LEGACY_SCHEMA_VERSION;
    const isCurrent = isRecord(value)
        && value.schema_version === REVIEW_REMEDIATION_BASELINE_SCHEMA_VERSION;
    if (
        !isRecord(value)
        || (!isLegacy && !isCurrent)
        || value.artifact_type !== REVIEW_REMEDIATION_BASELINE_ARTIFACT_TYPE
        || !Array.isArray(value.accepted_findings)
        || !Array.isArray(value.accepted_residual_risks)
        || !Array.isArray(value.fix_now_items)
        || !Array.isArray(value.path_line_inventory)
        || (isCurrent && !isRecord(value.delta_base))
        || (value.delta_base !== undefined && !isRecord(value.delta_base))
        || !isRecord(value.bindings)
    ) {
        return null;
    }
    return value as unknown as ReviewRemediationBaselineArtifact;
}

interface AcceptedItemContract {
    kind: RemediationItemKind;
    severity: ReviewRemediationFixNowItem['severity'];
    source_rule: string;
    evidence_locations: string[];
}

function isStringArray(value: unknown): value is string[] {
    return Array.isArray(value) && value.every((entry) => typeof entry === 'string' && Boolean(entry.trim()));
}

function validateEvidenceLocations(
    value: unknown,
    subject: string,
    violations: string[]
): value is string[] {
    if (!isStringArray(value) || value.length === 0) {
        violations.push(`${subject} must contain non-empty path-and-line strings.`);
        return false;
    }
    for (const location of value) {
        if (!parseReviewEvidenceLocation(location)) {
            violations.push(`${subject} contains invalid path-and-line location '${location}'.`);
        }
    }
    return true;
}

function buildAcceptedItemContracts(
    artifact: ReviewRemediationBaselineArtifact,
    violations: string[]
): Map<string, AcceptedItemContract> {
    const contracts = new Map<string, AcceptedItemContract>();
    for (const [index, value] of (artifact.accepted_findings as unknown[]).entries()) {
        const subject = `accepted_findings[${index}]`;
        if (!isRecord(value)) {
            violations.push(`${subject} must be an object.`);
            continue;
        }
        const id = typeof value.id === 'string' ? value.id.trim() : '';
        const severity = typeof value.severity === 'string' && SEVERITIES.includes(value.severity as typeof SEVERITIES[number])
            ? value.severity as typeof SEVERITIES[number]
            : null;
        if (!id || id === 'F-000') {
            violations.push(`${subject}.id must identify an ordinary accepted finding.`);
        }
        if (!severity) {
            violations.push(`${subject}.severity is invalid.`);
        }
        if (typeof value.title !== 'string' || !value.title.trim()) {
            violations.push(`${subject}.title is required.`);
        }
        if (typeof value.description !== 'string' || !value.description.trim()) {
            violations.push(`${subject}.description is required.`);
        }
        const validEvidence = validateEvidenceLocations(value.evidence_locations, `${subject}.evidence_locations`, violations);
        if (!isStringArray(value.coverage_obligation_ids)) {
            violations.push(`${subject}.coverage_obligation_ids must contain non-empty strings.`);
        }
        if (id && severity && validEvidence) {
            if (contracts.has(id)) {
                violations.push(`Accepted remediation item id '${id}' is duplicated.`);
            } else {
                contracts.set(id, {
                    kind: 'finding',
                    severity,
                    source_rule: `review_finding_policy.findings.${severity}`,
                    evidence_locations: [...value.evidence_locations as string[]]
                });
            }
        }
    }
    for (const [index, value] of (artifact.accepted_residual_risks as unknown[]).entries()) {
        const subject = `accepted_residual_risks[${index}]`;
        if (!isRecord(value)) {
            violations.push(`${subject} must be an object.`);
            continue;
        }
        const id = typeof value.id === 'string' ? value.id.trim() : '';
        if (!id) {
            violations.push(`${subject}.id is required.`);
        }
        if (typeof value.description !== 'string' || !value.description.trim()) {
            violations.push(`${subject}.description is required.`);
        }
        const validEvidence = validateEvidenceLocations(value.evidence_locations, `${subject}.evidence_locations`, violations);
        if (id && validEvidence) {
            if (contracts.has(id)) {
                violations.push(`Accepted remediation item id '${id}' is duplicated.`);
            } else {
                contracts.set(id, {
                    kind: 'residual_risk',
                    severity: 'residual_risk',
                    source_rule: 'review_finding_policy.residual_risk',
                    evidence_locations: [...value.evidence_locations as string[]]
                });
            }
        }
    }
    return contracts;
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
    return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

function validateFixNowItems(
    artifact: ReviewRemediationBaselineArtifact,
    acceptedItems: ReadonlyMap<string, AcceptedItemContract>,
    violations: string[]
): void {
    const seenIds = new Set<string>();
    for (const [index, value] of (artifact.fix_now_items as unknown[]).entries()) {
        const subject = `fix_now_items[${index}]`;
        if (!isRecord(value)) {
            violations.push(`${subject} must be an object.`);
            continue;
        }
        const id = typeof value.id === 'string' ? value.id.trim() : '';
        const accepted = acceptedItems.get(id);
        if (!id || value.action !== 'fix_now') {
            violations.push(`${subject} must have a non-empty id and action fix_now.`);
            continue;
        }
        if (seenIds.has(id)) {
            violations.push(`fix_now item '${id}' is duplicated.`);
        }
        seenIds.add(id);
        if (!accepted) {
            violations.push(`fix_now item '${id}' is missing from the accepted inventory.`);
            continue;
        }
        if (value.kind !== accepted.kind) {
            violations.push(`fix_now item '${id}' kind does not match its accepted inventory entry.`);
        }
        if (value.severity !== accepted.severity) {
            violations.push(`fix_now item '${id}' severity does not match its accepted inventory entry.`);
        }
        if (value.source_rule !== accepted.source_rule) {
            violations.push(`fix_now item '${id}' source_rule does not match its accepted inventory entry.`);
        }
        if (!validateEvidenceLocations(value.evidence_locations, `${subject}.evidence_locations`, violations)) {
            continue;
        }
        if (!sameStringArray(value.evidence_locations, accepted.evidence_locations)) {
            violations.push(`fix_now item '${id}' evidence does not match its accepted inventory entry.`);
        }
    }
}

function readAuthenticatedSnapshot(
    binding: unknown,
    subject: string,
    violations: string[]
): unknown | null {
    if (!isRecord(binding)) {
        return null;
    }
    const snapshotPath = normalizePath(String(binding.snapshot_path || '').trim());
    const snapshotSha256 = normalizeHash(binding.snapshot_sha256);
    if (!snapshotPath || !snapshotSha256) {
        return null;
    }
    try {
        if (
            !fs.existsSync(snapshotPath)
            || !fs.statSync(snapshotPath).isFile()
            || fileSha256(snapshotPath) !== snapshotSha256
        ) {
            return null;
        }
    } catch (error: unknown) {
        const detail = error instanceof Error ? error.message : String(error);
        violations.push(`${subject} snapshot '${snapshotPath}' could not be authenticated: ${detail}`);
        return null;
    }
    try {
        return JSON.parse(fs.readFileSync(snapshotPath, 'utf8')) as unknown;
    } catch {
        violations.push(`${subject} snapshot '${snapshotPath}' is not valid JSON.`);
        return null;
    }
}

function readDispositionFixNowItems(
    artifact: ReviewRemediationBaselineArtifact,
    violations: string[]
): ReviewFindingsDispositionArtifactItem[] | null {
    const binding = artifact.bindings.findings_disposition;
    const parsed = readAuthenticatedSnapshot(binding, 'bindings.findings_disposition', violations);
    if (
        !isRecord(parsed)
        || parsed.schema_version !== REVIEW_FINDINGS_DISPOSITION_ARTIFACT_SCHEMA_VERSION
        || parsed.artifact_type !== REVIEW_FINDINGS_DISPOSITION_ARTIFACT_TYPE
        || !Array.isArray(parsed.items)
    ) {
        violations.push('bindings.findings_disposition snapshot has invalid shape.');
        return null;
    }
    if (parsed.task_id !== artifact.task_id || parsed.review_type !== artifact.review_type) {
        violations.push('bindings.findings_disposition snapshot belongs to a foreign task or review type.');
    }
    validateExpectedHash(
        violations,
        'findings disposition result hash',
        parsed.disposition_result_sha256,
        binding.disposition_result_sha256
    );
    const sourceValidation = isRecord(parsed.source_validation) ? parsed.source_validation : null;
    validateExpectedHash(
        violations,
        'findings disposition snapshot source validation artifact hash',
        sourceValidation?.artifact_sha256,
        binding.source_validation_artifact_sha256
    );
    validateExpectedHash(
        violations,
        'findings disposition snapshot source validation result hash',
        sourceValidation?.validation_result_sha256,
        binding.source_validation_result_sha256
    );
    const fixNowItems: ReviewFindingsDispositionArtifactItem[] = [];
    const seenIds = new Set<string>();
    for (const [index, value] of parsed.items.entries()) {
        if (!isRecord(value) || value.action !== 'fix_now') {
            continue;
        }
        const id = typeof value.id === 'string' ? value.id.trim() : '';
        const kind = value.kind === 'finding' || value.kind === 'residual_risk' ? value.kind : null;
        const severity = typeof value.severity === 'string' ? value.severity : '';
        const sourceRule = typeof value.source_rule === 'string' ? value.source_rule.trim() : '';
        if (!id || !kind || !severity || !sourceRule) {
            violations.push(`bindings.findings_disposition.items[${index}] has an invalid fix_now shape.`);
            continue;
        }
        if (seenIds.has(id)) {
            violations.push(`bindings.findings_disposition fix_now item '${id}' is duplicated.`);
            continue;
        }
        seenIds.add(id);
        fixNowItems.push(value as unknown as ReviewFindingsDispositionArtifactItem);
    }
    const summary = isRecord(parsed.summary) ? parsed.summary : null;
    if (summary?.fix_now_count !== fixNowItems.length) {
        violations.push('bindings.findings_disposition summary fix_now_count does not match its items.');
    }
    return fixNowItems;
}

function validateAcceptedInventorySnapshotBinding(
    artifact: ReviewRemediationBaselineArtifact,
    violations: string[]
): void {
    const binding = artifact.bindings.findings_validation;
    const parsed = readAuthenticatedSnapshot(binding, 'bindings.findings_validation', violations);
    if (
        !isRecord(parsed)
        || parsed.schema_version !== REVIEW_FINDINGS_VALIDATION_ARTIFACT_SCHEMA_VERSION
        || parsed.artifact_type !== REVIEW_FINDINGS_VALIDATION_ARTIFACT_TYPE
        || !isRecord(parsed.validation_result)
    ) {
        if (parsed !== null) {
            violations.push('bindings.findings_validation snapshot has invalid shape.');
        }
        return;
    }
    if (parsed.task_id !== artifact.task_id || parsed.review_type !== artifact.review_type) {
        violations.push('bindings.findings_validation snapshot belongs to a foreign task or review type.');
    }
    const validationResult = parsed.validation_result;
    if (artifact.origin_coverage_contract !== undefined) {
        const validationBindings = isRecord(validationResult.bindings) ? validationResult.bindings : null;
        violations.push(...getOriginCoverageContractViolations(
            artifact.origin_coverage_contract, artifact.review_type, validationBindings?.coverage_contract_sha256
        ));
    }
    if (validationResult.status !== 'accepted' || validationResult.accepted !== true) {
        violations.push('bindings.findings_validation snapshot is not accepted evidence.');
    }
    validateExpectedHash(
        violations,
        'findings validation result hash',
        parsed.validation_result_sha256,
        binding.validation_result_sha256
    );
    validateExpectedHash(
        violations,
        'findings validation result payload hash',
        parsed.validation_result_sha256,
        sha256RedactedJsonPayload(validationResult)
    );
    const inventory = isRecord(validationResult.normalized_inventory)
        ? validationResult.normalized_inventory
        : null;
    const findingsBySeverity = inventory && isRecord(inventory.findings_by_severity)
        ? inventory.findings_by_severity
        : null;
    if (
        !inventory
        || !findingsBySeverity
        || !SEVERITIES.every((severity) => Array.isArray(findingsBySeverity[severity]))
        || !Array.isArray(inventory.residual_risks)
    ) {
        violations.push('bindings.findings_validation normalized inventory has invalid shape.');
        return;
    }
    const authenticatedInventory = acceptedInventory(parsed as unknown as ReviewFindingsValidationArtifact);
    const baselineInventory = {
        findings: artifact.accepted_findings,
        residualRisks: artifact.accepted_residual_risks
    };
    if (JSON.stringify(authenticatedInventory) !== JSON.stringify(baselineInventory)) {
        violations.push('Accepted remediation inventory does not match the authenticated findings-validation snapshot.');
    }
}

function validateFixNowDispositionCompleteness(
    artifact: ReviewRemediationBaselineArtifact,
    violations: string[]
): void {
    const dispositionItems = readDispositionFixNowItems(artifact, violations);
    if (!dispositionItems) {
        return;
    }
    const baselineItems = new Map<string, ReviewRemediationFixNowItem>();
    for (const value of artifact.fix_now_items as unknown[]) {
        if (isRecord(value) && typeof value.id === 'string' && value.id.trim()) {
            baselineItems.set(value.id.trim(), value as unknown as ReviewRemediationFixNowItem);
        }
    }
    if (baselineItems.size !== dispositionItems.length) {
        violations.push(
            `fix_now_items count ${baselineItems.size} does not match authenticated disposition count ${dispositionItems.length}.`
        );
    }
    for (const dispositionItem of dispositionItems) {
        const baselineItem = baselineItems.get(dispositionItem.id);
        if (!baselineItem) {
            violations.push(`fix_now_items is missing authenticated disposition item '${dispositionItem.id}'.`);
            continue;
        }
        if (
            baselineItem.kind !== dispositionItem.kind
            || baselineItem.severity !== dispositionItem.severity
            || baselineItem.source_rule !== dispositionItem.source_rule
        ) {
            violations.push(`fix_now item '${dispositionItem.id}' does not match its authenticated disposition item.`);
        }
    }
}

function validateBaselineConsistency(
    artifact: ReviewRemediationBaselineArtifact,
    violations: string[]
): void {
    const inventory = {
        findings: artifact.accepted_findings,
        residualRisks: artifact.accepted_residual_risks
    };
    validateExpectedHash(
        violations,
        'accepted_inventory_sha256',
        artifact.accepted_inventory_sha256,
        sha256RedactedJsonPayload(inventory)
    );
    validateExpectedHash(
        violations,
        'fix_now_items_sha256',
        artifact.fix_now_items_sha256,
        sha256RedactedJsonPayload(artifact.fix_now_items)
    );
    validateExpectedHash(
        violations,
        'path_line_inventory_sha256',
        artifact.path_line_inventory_sha256,
        sha256RedactedJsonPayload(artifact.path_line_inventory)
    );
    if (artifact.delta_base) {
        violations.push(...getReviewRemediationDeltaBaseViolations(artifact.delta_base, {
            taskId: artifact.task_id,
            reviewType: artifact.review_type,
            reviewTreeStateSha256: artifact.bindings.tree?.review_tree_state_sha256
        }));
    }
    if (artifact.fix_now_items.length === 0) {
        violations.push('fix_now_items must contain at least one item.');
    }
    const acceptedItems = buildAcceptedItemContracts(artifact, violations);
    validateFixNowItems(artifact, acceptedItems, violations);
    try {
        const expectedPathLines = buildPathLineInventory(artifact.fix_now_items);
        if (JSON.stringify(expectedPathLines) !== JSON.stringify(artifact.path_line_inventory)) {
            violations.push('path_line_inventory does not match fix_now item evidence.');
        }
    } catch (error: unknown) {
        violations.push(error instanceof Error ? error.message : String(error));
    }
    const bindings = artifact.bindings;
    validateSnapshotBinding(bindings.receipt, 'bindings.receipt', violations);
    validateSnapshotBinding(bindings.review_artifact, 'bindings.review_artifact', violations);
    validateSnapshotBinding(bindings.findings_validation, 'bindings.findings_validation', violations);
    validateSnapshotBinding(bindings.findings_disposition, 'bindings.findings_disposition', violations);
    validateAcceptedInventorySnapshotBinding(artifact, violations);
    validateFixNowDispositionCompleteness(artifact, violations);
    validateExpectedHash(
        violations,
        'findings disposition source validation artifact hash',
        isRecord(bindings.findings_disposition)
            ? bindings.findings_disposition.source_validation_artifact_sha256
            : null,
        isRecord(bindings.findings_validation)
            ? bindings.findings_validation.artifact_sha256
            : null
    );
    validateExpectedHash(
        violations,
        'findings disposition source validation result hash',
        isRecord(bindings.findings_disposition)
            ? bindings.findings_disposition.source_validation_result_sha256
            : null,
        isRecord(bindings.findings_validation)
            ? bindings.findings_validation.validation_result_sha256
            : null
    );
    if (!isRecord(bindings.policy)) {
        violations.push('bindings.policy must be an object.');
    } else {
        validateExpectedHash(
            violations,
            'review_finding_policy_sha256',
            bindings.policy.review_finding_policy_sha256,
            sha256RedactedJsonPayload(bindings.policy.review_finding_policy)
        );
    }
    const requiredHashes = [
        ['bindings.context.review_context_sha256', bindings.context?.review_context_sha256],
        ['bindings.scope.preflight_sha256', bindings.scope?.preflight_sha256],
        ['bindings.scope.scope_sha256', bindings.scope?.scope_sha256],
        ['bindings.scope.review_scope_sha256', bindings.scope?.review_scope_sha256],
        ['bindings.tree.review_tree_state_sha256', bindings.tree?.review_tree_state_sha256],
        ['bindings.policy.profile_policy_snapshot_sha256', bindings.policy?.profile_policy_snapshot_sha256],
        ['bindings.findings_report_sha256', bindings.findings_report_sha256]
    ] as const;
    for (const [subject, value] of requiredHashes) {
        if (!normalizeHash(value)) {
            violations.push(`${subject} must be a SHA-256 hash.`);
        }
    }
}

export function validateReviewRemediationBaselineArtifact(
    options: ReviewRemediationBaselineValidationOptions
): ReviewRemediationBaselineValidationResult {
    const artifactPath = normalizePath(options.artifactPath);
    if (!fs.existsSync(artifactPath) || !fs.statSync(artifactPath).isFile()) {
        return {
            valid: false,
            artifact: null,
            artifact_sha256: null,
            violations: [`Review remediation baseline '${artifactPath}' is missing.`]
        };
    }
    const artifactSha256 = fileSha256(artifactPath);
    const violations: string[] = [];
    validateExpectedHash(violations, 'remediation baseline artifact hash', artifactSha256, options.expectedArtifactSha256);
    let parsed: unknown;
    try {
        parsed = JSON.parse(fs.readFileSync(artifactPath, 'utf8')) as unknown;
    } catch {
        return {
            valid: false,
            artifact: null,
            artifact_sha256: artifactSha256,
            violations: [...violations, `Review remediation baseline '${artifactPath}' is not valid JSON.`]
        };
    }
    const artifact = parseBaseline(parsed);
    if (!artifact) {
        return {
            valid: false,
            artifact: null,
            artifact_sha256: artifactSha256,
            violations: [...violations, `Review remediation baseline '${artifactPath}' has invalid shape.`]
        };
    }
    if (artifact.task_id !== options.expectedTaskId) {
        violations.push(
            `Review remediation baseline task_id mismatch: expected ${options.expectedTaskId}, found ${artifact.task_id || 'missing'}.`
        );
    }
    if (artifact.review_type !== options.expectedReviewType) {
        violations.push(
            `Review remediation baseline review_type mismatch: expected ${options.expectedReviewType}, found ${artifact.review_type || 'missing'}.`
        );
    }
    validateBaselineConsistency(artifact, violations);
    validateExpectedHash(violations, 'receipt_sha256', artifact.bindings.receipt?.artifact_sha256, options.expectedReceiptSha256);
    validateExpectedHash(
        violations,
        'review_context_sha256',
        artifact.bindings.context?.review_context_sha256,
        options.expectedReviewContextSha256
    );
    validateExpectedHash(
        violations,
        'review_tree_state_sha256',
        artifact.bindings.tree?.review_tree_state_sha256,
        options.expectedReviewTreeStateSha256
    );
    validateExpectedHash(violations, 'scope_sha256', artifact.bindings.scope?.scope_sha256, options.expectedScopeSha256);
    validateExpectedHash(
        violations,
        'profile_policy_snapshot_sha256',
        artifact.bindings.policy?.profile_policy_snapshot_sha256,
        options.expectedProfilePolicySnapshotSha256
    );
    return {
        valid: violations.length === 0,
        artifact,
        artifact_sha256: artifactSha256,
        violations
    };
}
