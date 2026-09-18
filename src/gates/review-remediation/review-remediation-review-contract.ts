import { sha256RedactedJsonPayload } from '../../core/redaction';
import { isPlainRecord } from '../../core/records';
import { normalizePath } from '../shared/helpers';
import {
    buildReviewRemediationFindingScope,
    getReviewRemediationFindingPaths
} from './review-remediation-finding-scope';
import {
    validateReviewRemediationBaselineArtifact,
    type ReviewRemediationBaselineArtifact
} from './review-remediation-baseline';
import type { ReviewRemediationDeltaClassification } from './review-remediation-delta';
import {
    getAuthoritativeReviewRemediationDecisionViolations,
    type AuthoritativeReviewRemediationDecision,
    type ReviewRemediationDecisionClassification
} from './review-remediation-recovery-routing';
import { getReviewRemediationDeltaClassificationViolations } from './review-remediation-validation-evidence';

export const REVIEW_REMEDIATION_REVIEW_CONTRACT_SCHEMA_VERSION = 1 as const;
export type ReviewRemediationReviewMode = 'FULL' | 'DELTA';

export interface ReviewRemediationReviewContractBase {
    baseline_artifact_path: string;
    baseline_artifact_sha256: string;
    review_receipt_sha256: string;
    review_receipt_snapshot_sha256: string;
    review_context_sha256: string;
    review_tree_state_sha256: string;
    review_scope_sha256: string;
    scope_sha256: string;
    delta_base_snapshot_sha256: string;
}

export interface ReviewRemediationReviewContractDelta {
    origin_review_type: string;
    classification_sha256: string;
    current_snapshot_sha256: string;
    required_delta_targets: string[];
    required_delta_targets_sha256: string;
    context_files: string[];
    context_files_sha256: string;
}

export interface ReviewRemediationFindingReconciliationContract {
    baseline_finding_ids: string[];
    baseline_finding_ids_sha256: string;
    resolvable_finding_ids: string[];
    resolvable_finding_ids_sha256: string;
    protected_open_finding_ids: string[];
    protected_open_finding_ids_sha256: string;
    protected_fix_now_finding_ids: string[];
    protected_fix_now_finding_ids_sha256: string;
}

export interface ReviewRemediationReviewContract {
    schema_version: typeof REVIEW_REMEDIATION_REVIEW_CONTRACT_SCHEMA_VERSION;
    task_id: string;
    review_type: string;
    mode: ReviewRemediationReviewMode;
    source: 'initial_full' | 'remediation_full' | 'remediation_delta';
    preflight_sha256: string;
    authoritative_decision_sha256: string | null;
    classification_sha256: string | null;
    full_review_scope: string[];
    full_review_scope_sha256: string;
    base: ReviewRemediationReviewContractBase | null;
    delta: ReviewRemediationReviewContractDelta | null;
    finding_reconciliation: ReviewRemediationFindingReconciliationContract;
    complete_scope_lineage_sha256: string;
    contract_sha256: string;
}

export interface ReviewRemediationReviewContractValidationAuthority {
    taskId: string;
    reviewType: string;
    preflightSha256: string;
    mode: ReviewRemediationReviewMode;
    fullReviewScope: readonly string[];
    persistedDecisionSha256: string | null;
    authoritativeDecisionSha256: string | null;
    authoritativeClassificationSha256: string | null;
    authoritativeDecision: ReviewRemediationAuthoritativeDecisionBinding | null;
    authoritativeClassification: ReviewRemediationDecisionClassification | null;
}

export interface ReviewerRemediationCoverageDeclaration {
    mode: ReviewRemediationReviewMode;
    contract_sha256: string;
    covered_delta_targets: string[];
    inspected_prior_finding_ids: string[];
}

export interface ReviewRemediationAuthoritativeDecisionBinding
    extends AuthoritativeReviewRemediationDecision {
    preflight_sha256: string;
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const REVIEW_CONTRACT_KEYS = [
    'authoritative_decision_sha256',
    'base',
    'classification_sha256',
    'complete_scope_lineage_sha256',
    'contract_sha256',
    'delta',
    'finding_reconciliation',
    'full_review_scope',
    'full_review_scope_sha256',
    'mode',
    'preflight_sha256',
    'review_type',
    'schema_version',
    'source',
    'task_id'
] as const;
const REVIEW_CONTRACT_BASE_KEYS = [
    'baseline_artifact_path',
    'baseline_artifact_sha256',
    'delta_base_snapshot_sha256',
    'review_context_sha256',
    'review_receipt_sha256',
    'review_receipt_snapshot_sha256',
    'review_scope_sha256',
    'review_tree_state_sha256',
    'scope_sha256'
] as const;
const REVIEW_CONTRACT_DELTA_KEYS = [
    'classification_sha256',
    'context_files',
    'context_files_sha256',
    'current_snapshot_sha256',
    'origin_review_type',
    'required_delta_targets',
    'required_delta_targets_sha256'
] as const;
const REVIEW_CONTRACT_RECONCILIATION_KEYS = [
    'baseline_finding_ids',
    'baseline_finding_ids_sha256',
    'protected_fix_now_finding_ids',
    'protected_fix_now_finding_ids_sha256',
    'protected_open_finding_ids',
    'protected_open_finding_ids_sha256',
    'resolvable_finding_ids',
    'resolvable_finding_ids_sha256'
] as const;
const REVIEWER_REMEDIATION_COVERAGE_KEYS = [
    'contract_sha256',
    'covered_delta_targets',
    'inspected_prior_finding_ids',
    'mode'
] as const;

function hasExactKeys(value: Record<string, unknown>, expectedKeys: readonly string[]): boolean {
    return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expectedKeys].sort());
}

function normalizeHash(value: unknown): string {
    const normalized = String(value || '').trim().toLowerCase();
    if (!SHA256_PATTERN.test(normalized)) {
        throw new Error('Review remediation review contract requires lowercase SHA-256 bindings.');
    }
    return normalized;
}

function normalizeCanonicalPaths(values: readonly string[]): string[] {
    return [...new Set(values
        .map((entry) => normalizePath(String(entry || '').trim()).replace(/^\.\//u, ''))
        .filter(Boolean))].sort();
}

function normalizeCanonicalIds(values: readonly string[]): string[] {
    return [...new Set(values.map((entry) => String(entry || '').trim()).filter(Boolean))].sort();
}

function hashList(values: readonly string[]): string {
    return sha256RedactedJsonPayload([...values]);
}

function getClassificationBaselineBindingViolation(
    base: ReviewRemediationReviewContractBase | null,
    baseline: unknown
): string | null {
    if (!isPlainRecord(base) || !isPlainRecord(baseline)) {
        return 'DELTA review_execution base does not match the authenticated classification baseline identity.';
    }
    const expected = {
        baseline_artifact_path: normalizePath(String(baseline.artifact_path || '')),
        baseline_artifact_sha256: String(baseline.artifact_sha256 || '').trim().toLowerCase(),
        review_tree_state_sha256: String(baseline.review_tree_state_sha256 || '').trim().toLowerCase(),
        delta_base_snapshot_sha256: String(baseline.delta_base_snapshot_sha256 || '').trim().toLowerCase()
    };
    const actual = {
        baseline_artifact_path: normalizePath(String(base.baseline_artifact_path || '')),
        baseline_artifact_sha256: String(base.baseline_artifact_sha256 || ''),
        review_tree_state_sha256: String(base.review_tree_state_sha256 || ''),
        delta_base_snapshot_sha256: String(base.delta_base_snapshot_sha256 || '')
    };
    return JSON.stringify(actual) === JSON.stringify(expected)
        ? null
        : 'DELTA review_execution base does not match the authenticated classification baseline identity.';
}

function stringList(value: unknown): string[] {
    return Array.isArray(value) ? value.map(String) : [];
}

function buildCompleteScopeLineageSha256(
    contract: Pick<ReviewRemediationReviewContract,
        'task_id'
        | 'review_type'
        | 'mode'
        | 'preflight_sha256'
        | 'full_review_scope_sha256'
        | 'authoritative_decision_sha256'
        | 'classification_sha256'
        | 'base'
        | 'delta'
        | 'finding_reconciliation'>
): string {
    return sha256RedactedJsonPayload({
        task_id: contract.task_id,
        review_type: contract.review_type,
        mode: contract.mode,
        preflight_sha256: contract.preflight_sha256,
        full_review_scope_sha256: contract.full_review_scope_sha256,
        authoritative_decision_sha256: contract.authoritative_decision_sha256,
        classification_sha256: contract.classification_sha256,
        base: contract.base,
        delta: contract.delta,
        finding_reconciliation: contract.finding_reconciliation
    });
}

function requireLaneDecision(
    decision: ReviewRemediationAuthoritativeDecisionBinding,
    taskId: string,
    reviewType: string,
    preflightSha256: string
) {
    const violations = getAuthoritativeReviewRemediationDecisionViolations(decision, { expectedTaskId: taskId });
    if (normalizeHash(decision.preflight_sha256) !== preflightSha256) {
        violations.push('authoritative remediation decision preflight_sha256 is stale.');
    }
    if (violations.length > 0 || decision.status !== 'READY') {
        throw new Error(`Authoritative remediation decision is invalid: ${violations.join(' ')}`);
    }
    const lane = decision.lane_decisions.find((entry) => entry.review_type === reviewType);
    if (!lane) {
        throw new Error(`Authoritative remediation decision has no lane '${reviewType}'.`);
    }
    return lane;
}

function readAuthenticatedBaseline(
    delta: ReviewRemediationDeltaClassification
): ReviewRemediationBaselineArtifact {
    const validation = validateReviewRemediationBaselineArtifact({
        artifactPath: delta.baseline.artifact_path,
        expectedArtifactSha256: delta.baseline.artifact_sha256,
        expectedTaskId: delta.task_id,
        expectedReviewType: delta.review_type,
        expectedReviewTreeStateSha256: delta.baseline.review_tree_state_sha256
    });
    if (!validation.valid || !validation.artifact) {
        throw new Error(
            `Review remediation DELTA baseline is invalid: ${validation.violations.join(' ')}`
        );
    }
    return validation.artifact;
}

export function buildReviewRemediationFindingReconciliation(
    baseline: ReviewRemediationBaselineArtifact | null,
    deltaTargets: readonly string[]
): ReviewRemediationFindingReconciliationContract {
    const baselineFindingIds = normalizeCanonicalIds(
        baseline?.accepted_findings.map((finding) => finding.id) ?? []
    );
    const targetSet = new Set(deltaTargets);
    const resolvableFindingIds = normalizeCanonicalIds(
        baseline?.accepted_findings
            .filter((finding) => {
                const paths = getReviewRemediationFindingPaths(baseline!, finding);
                return paths !== null && paths.every((filePath) => targetSet.has(filePath));
            })
            .map((finding) => finding.id) ?? []
    );
    const resolvableSet = new Set(resolvableFindingIds);
    const protectedOpenFindingIds = baselineFindingIds.filter((findingId) => !resolvableSet.has(findingId));
    const protectedOpenSet = new Set(protectedOpenFindingIds);
    const protectedFixNowFindingIds = normalizeCanonicalIds(
        baseline?.fix_now_items
            .filter((item) => item.kind === 'finding' && protectedOpenSet.has(item.id))
            .map((item) => item.id) ?? []
    );
    return {
        baseline_finding_ids: baselineFindingIds,
        baseline_finding_ids_sha256: hashList(baselineFindingIds),
        resolvable_finding_ids: resolvableFindingIds,
        resolvable_finding_ids_sha256: hashList(resolvableFindingIds),
        protected_open_finding_ids: protectedOpenFindingIds,
        protected_open_finding_ids_sha256: hashList(protectedOpenFindingIds),
        protected_fix_now_finding_ids: protectedFixNowFindingIds,
        protected_fix_now_finding_ids_sha256: hashList(protectedFixNowFindingIds)
    };
}

export function getReviewRemediationFindingReconciliationViolations(
    value: unknown,
    baseline: ReviewRemediationBaselineArtifact | null,
    deltaTargets: readonly string[]
): string[] {
    if (!isPlainRecord(value)) {
        return ['review_execution finding reconciliation contract is missing.'];
    }
    const expected = buildReviewRemediationFindingReconciliation(baseline, deltaTargets);
    return JSON.stringify(value) === JSON.stringify(expected)
        ? []
        : [
            'review_execution finding reconciliation does not match the authenticated baseline and exact DELTA targets.'
        ];
}

export function getAuthenticatedBaselineReviewScopeViolation(
    base: ReviewRemediationReviewContractBase,
    baseline: ReviewRemediationBaselineArtifact
): string | null {
    return base.review_scope_sha256 === baseline.bindings.scope.review_scope_sha256
        ? null
        : 'DELTA review_execution base review_scope_sha256 does not match the authenticated baseline.';
}

export function getRemediationContractDecisionBindingViolation(
    contract: Pick<ReviewRemediationReviewContract,
        'authoritative_decision_sha256' | 'classification_sha256'>,
    persistedDecisionSha256: unknown,
    authoritativeDecisionSha256: unknown,
    authoritativeClassificationSha256: string
): string | null {
    const persisted = String(persistedDecisionSha256 || '').trim().toLowerCase();
    const authoritative = String(authoritativeDecisionSha256 || '').trim().toLowerCase();
    const classification = String(authoritativeClassificationSha256 || '').trim().toLowerCase();
    return SHA256_PATTERN.test(persisted)
        && SHA256_PATTERN.test(authoritative)
        && SHA256_PATTERN.test(classification)
        && persisted === authoritative
        && contract.authoritative_decision_sha256 === authoritative
        && contract.classification_sha256 === classification
        ? null
        : 'persisted remediation review execution contract is not bound to the final authoritative lane decision and classification';
}

export function getRemediationContractClassificationBindingViolations(
    contract: ReviewRemediationReviewContract,
    decision: AuthoritativeReviewRemediationDecision,
    classification: unknown
): string[] {
    if (!isPlainRecord(classification)) {
        return ['persisted remediation review execution classification is missing.'];
    }
    const violations: string[] = [];
    const source = String(classification.source || '');
    if (source !== decision.classification_source) {
        violations.push('persisted remediation classification source does not match the authoritative decision.');
    }
    if (contract.classification_sha256 !== decision.classification_sha256) {
        violations.push('review_execution classification_sha256 does not match the authoritative decision.');
    }
    if (source === 'delta') {
        if (!isPlainRecord(classification.delta)) {
            violations.push('persisted authoritative DELTA classification payload is missing.');
            return violations;
        }
        const delta = classification.delta as unknown as ReviewRemediationDeltaClassification;
        const deltaViolations = getReviewRemediationDeltaClassificationViolations(delta);
        if (deltaViolations.length > 0) {
            violations.push(
                `persisted authoritative DELTA classification is invalid: ${deltaViolations.join(' ')}`
            );
        }
        if (delta.classification_sha256 !== decision.classification_sha256) {
            violations.push('persisted DELTA classification hash does not match the authoritative decision.');
        }
        if (
            delta.task_id !== decision.task_id
            || (contract.mode === 'DELTA' && delta.review_type !== contract.review_type)
        ) {
            violations.push(
                'persisted DELTA classification does not match the authoritative task and review lane.'
            );
        }
        const deltaScope = isPlainRecord(delta.scope)
            && Array.isArray(delta.scope.full_review_scope)
            && Array.isArray(delta.scope.required_delta_targets)
            && Array.isArray(delta.scope.optional_context_files)
            ? delta.scope
            : null;
        if (deltaScope) {
            const expectedFullScope = normalizeCanonicalPaths(deltaScope.full_review_scope);
            if (JSON.stringify(contract.full_review_scope) !== JSON.stringify(expectedFullScope)) {
                violations.push(
                    'review_execution full scope does not match the authenticated DELTA classification.'
                );
            }
        }
        if (contract.mode === 'DELTA' && deltaScope) {
            const baselineBindingViolation = getClassificationBaselineBindingViolation(
                contract.base,
                delta.baseline
            );
            if (baselineBindingViolation) {
                violations.push(baselineBindingViolation);
            }
            let findingScope;
            try {
                findingScope = buildReviewRemediationFindingScope(
                    readAuthenticatedBaseline(delta), deltaScope.required_delta_targets, deltaScope.full_review_scope
                );
            } catch (error: unknown) {
                violations.push(error instanceof Error ? error.message : String(error));
                return violations;
            }
            violations.push(...findingScope.fullReviewReasons);
            const expectedTargets = normalizeCanonicalPaths(findingScope.requiredTargets);
            const expectedContextFiles = normalizeCanonicalPaths(findingScope.contextFiles);
            const expectedDelta = {
                origin_review_type: delta.review_type,
                classification_sha256: delta.classification_sha256,
                current_snapshot_sha256: delta.current_snapshot_sha256,
                required_delta_targets: expectedTargets,
                required_delta_targets_sha256: hashList(expectedTargets),
                context_files: expectedContextFiles,
                context_files_sha256: hashList(expectedContextFiles)
            };
            if (JSON.stringify(contract.delta) !== JSON.stringify(expectedDelta)) {
                violations.push(
                    'DELTA review_execution targets, context files, or snapshot do not match the authenticated classification.'
                );
            }
        } else if (contract.mode === 'DELTA') {
            violations.push('persisted authoritative DELTA classification scope is missing.');
        }
    } else if (source === 'runtime_fix') {
        if (!isPlainRecord(classification.classification)) {
            violations.push('persisted authoritative runtime-fix classification payload is missing.');
            return violations;
        }
        const classificationSha256 = sha256RedactedJsonPayload(
            classification.classification
        );
        if (classificationSha256 !== decision.classification_sha256) {
            violations.push('persisted runtime-fix classification hash does not match the authoritative decision.');
        }
    } else {
        violations.push(`persisted remediation classification source '${source || 'missing'}' is invalid.`);
    }
    return violations;
}

export function buildReviewRemediationReviewContract(options: {
    taskId: string;
    reviewType: string;
    preflightSha256: string;
    fullReviewScope: readonly string[];
    authoritativeDecision?: ReviewRemediationAuthoritativeDecisionBinding | null;
    classification?: ReviewRemediationDecisionClassification | null;
}): ReviewRemediationReviewContract {
    const taskId = String(options.taskId || '').trim();
    const reviewType = String(options.reviewType || '').trim().toLowerCase();
    const preflightSha256 = normalizeHash(options.preflightSha256);
    const fullReviewScope = normalizeCanonicalPaths(options.fullReviewScope);
    if (!taskId) {
        throw new Error('Review remediation review contract requires a non-empty task id.');
    }
    if (!/^[a-z][a-z0-9-]*$/u.test(reviewType)) {
        throw new Error('Review remediation review contract requires a canonical review type.');
    }
    const decision = options.authoritativeDecision ?? null;
    const lane = decision ? requireLaneDecision(decision, taskId, reviewType, preflightSha256) : null;
    const classification = options.classification ?? null;
    if (lane && !['FULL', 'DELTA'].includes(lane.mode)) {
        throw new Error(
            `Review remediation review contract cannot be built for lane mode '${lane.mode}'.`
        );
    }
    if ((decision === null) !== (classification === null)) {
        throw new Error(
            'Review remediation review contract requires decision and classification authority together.'
        );
    }
    if (decision && classification?.source !== decision.classification_source) {
        throw new Error(
            'Review remediation classification source does not match the authoritative decision.'
        );
    }
    if (decision && classification?.source === 'runtime_fix') {
        if (
            !isPlainRecord(classification.classification)
            || sha256RedactedJsonPayload(classification.classification) !== decision.classification_sha256
        ) {
            throw new Error(
                'Review remediation runtime-fix classification does not match the authoritative decision.'
            );
        }
    }
    const delta = classification?.source === 'delta' ? classification.delta : null;
    const mode: ReviewRemediationReviewMode = lane?.mode === 'DELTA' ? 'DELTA' : 'FULL';
    if (mode === 'DELTA' && (!delta || delta.full_review_required)) {
        throw new Error('DELTA review mode requires an authenticated non-FULL remediation delta classification.');
    }
    if (delta) {
        const deltaViolations = getReviewRemediationDeltaClassificationViolations(delta);
        if (deltaViolations.length > 0) {
            throw new Error(`Remediation delta classification is invalid: ${deltaViolations.join(' ')}`);
        }
    }
    if (
        delta
        && (
            delta.task_id !== taskId
            || (mode === 'DELTA' && delta.review_type !== reviewType)
            || !decision
            || decision.classification_sha256 !== delta.classification_sha256
        )
    ) {
        throw new Error('Remediation delta does not match the current task, review lane, or authoritative decision.');
    }
    const baseline = mode === 'DELTA' ? readAuthenticatedBaseline(delta!) : null;
    const findingScope = baseline && delta ? buildReviewRemediationFindingScope(
        baseline, delta.scope.required_delta_targets, delta.scope.full_review_scope
    ) : null;
    if (findingScope?.fullReviewReasons.length) {
        throw new Error(`DELTA review cannot cover the blocking baseline: ${findingScope.fullReviewReasons.join(' ')}`);
    }
    const requiredDeltaTargets = normalizeCanonicalPaths(findingScope?.requiredTargets ?? []);
    const contextFiles = normalizeCanonicalPaths(findingScope?.contextFiles ?? []);
    if (mode === 'DELTA') {
        const deltaFullReviewScope = normalizeCanonicalPaths(delta!.scope.full_review_scope);
        const fullScopeSet = new Set(fullReviewScope);
        const foreignTargets = requiredDeltaTargets.filter((entry) => !fullScopeSet.has(entry));
        const foreignContextFiles = contextFiles.filter((entry) => !fullScopeSet.has(entry));
        if (requiredDeltaTargets.length === 0 || foreignTargets.length > 0) {
            throw new Error(
                `DELTA review targets must be a non-empty subset of the authenticated full review scope: `
                + `${foreignTargets.join(', ') || 'no targets'}.`
            );
        }
        if (JSON.stringify(deltaFullReviewScope) !== JSON.stringify(fullReviewScope)) {
            throw new Error('DELTA classification full review scope does not match the current preflight scope.');
        }
        if (foreignContextFiles.length > 0) {
            throw new Error(
                'DELTA review context files must be a subset of the authenticated full review scope: '
                + `${foreignContextFiles.join(', ')}.`
            );
        }
    }
    const base: ReviewRemediationReviewContractBase | null = baseline && delta
        ? {
            baseline_artifact_path: normalizePath(delta.baseline.artifact_path),
            baseline_artifact_sha256: normalizeHash(delta.baseline.artifact_sha256),
            review_receipt_sha256: normalizeHash(baseline.bindings.receipt.artifact_sha256),
            review_receipt_snapshot_sha256: normalizeHash(baseline.bindings.receipt.snapshot_sha256),
            review_context_sha256: normalizeHash(baseline.bindings.context.review_context_sha256),
            review_tree_state_sha256: normalizeHash(baseline.bindings.tree.review_tree_state_sha256),
            review_scope_sha256: normalizeHash(baseline.bindings.scope.review_scope_sha256),
            scope_sha256: normalizeHash(baseline.bindings.scope.scope_sha256),
            delta_base_snapshot_sha256: normalizeHash(delta.baseline.delta_base_snapshot_sha256)
        }
        : null;
    const deltaContract: ReviewRemediationReviewContractDelta | null = delta && mode === 'DELTA'
        ? {
            origin_review_type: delta.review_type,
            classification_sha256: normalizeHash(delta.classification_sha256),
            current_snapshot_sha256: normalizeHash(delta.current_snapshot_sha256),
            required_delta_targets: requiredDeltaTargets,
            required_delta_targets_sha256: hashList(requiredDeltaTargets),
            context_files: contextFiles,
            context_files_sha256: hashList(contextFiles)
        }
        : null;
    const findingReconciliation = buildReviewRemediationFindingReconciliation(baseline, requiredDeltaTargets);
    if (mode === 'DELTA' && findingReconciliation.protected_fix_now_finding_ids.length > 0) {
        throw new Error(
            'DELTA review cannot resolve the complete blocking baseline because fix-now findings remain outside '
            + `the covered targets: ${findingReconciliation.protected_fix_now_finding_ids.join(', ')}.`
        );
    }
    const fullReviewScopeSha256 = hashList(fullReviewScope);
    const completeScopeLineageSha256 = buildCompleteScopeLineageSha256({
        task_id: taskId,
        review_type: reviewType,
        mode,
        preflight_sha256: preflightSha256,
        full_review_scope_sha256: fullReviewScopeSha256,
        authoritative_decision_sha256: decision?.decision_sha256 ?? null,
        classification_sha256: decision?.classification_sha256 ?? null,
        base,
        delta: deltaContract,
        finding_reconciliation: findingReconciliation
    });
    const withoutHash: Omit<ReviewRemediationReviewContract, 'contract_sha256'> = {
        schema_version: REVIEW_REMEDIATION_REVIEW_CONTRACT_SCHEMA_VERSION,
        task_id: taskId,
        review_type: reviewType,
        mode,
        source: mode === 'DELTA'
            ? 'remediation_delta'
            : decision
                ? 'remediation_full'
                : 'initial_full',
        preflight_sha256: preflightSha256,
        authoritative_decision_sha256: decision?.decision_sha256 ?? null,
        classification_sha256: decision?.classification_sha256 ?? null,
        full_review_scope: fullReviewScope,
        full_review_scope_sha256: fullReviewScopeSha256,
        base,
        delta: deltaContract,
        finding_reconciliation: findingReconciliation,
        complete_scope_lineage_sha256: completeScopeLineageSha256
    };
    return {
        ...withoutHash,
        contract_sha256: sha256RedactedJsonPayload(withoutHash as unknown as Record<string, unknown>)
    };
}

export function getReviewRemediationReviewContractViolations(
    value: unknown,
    expected: ReviewRemediationReviewContractValidationAuthority
): string[] {
    if (!isPlainRecord(value)) {
        return ['review_execution contract must be an object.'];
    }
    if (
        !isPlainRecord(expected)
        || !String(expected.taskId || '').trim()
        || expected.taskId !== String(expected.taskId).trim()
        || !/^[a-z][a-z0-9-]*$/u.test(String(expected.reviewType || ''))
        || !SHA256_PATTERN.test(String(expected.preflightSha256 || ''))
        || !['FULL', 'DELTA'].includes(String(expected.mode || ''))
        || !Array.isArray(expected.fullReviewScope)
        || expected.fullReviewScope.some((entry) => typeof entry !== 'string')
        || ![
            'persistedDecisionSha256',
            'authoritativeDecisionSha256',
            'authoritativeClassificationSha256',
            'authoritativeDecision',
            'authoritativeClassification'
        ]
            .every((key) => Object.prototype.hasOwnProperty.call(expected, key))
    ) {
        return [
            'review_execution validation requires complete current task, lane, preflight, mode, full-scope, '
            + 'and remediation-decision authority.'
        ];
    }
    const expectsInitialFull = expected.mode === 'FULL'
        && expected.persistedDecisionSha256 === null
        && expected.authoritativeDecisionSha256 === null
        && expected.authoritativeClassificationSha256 === null
        && expected.authoritativeDecision === null
        && expected.authoritativeClassification === null;
    const expectsRemediation = SHA256_PATTERN.test(String(expected.persistedDecisionSha256 || ''))
        && SHA256_PATTERN.test(String(expected.authoritativeDecisionSha256 || ''))
        && SHA256_PATTERN.test(String(expected.authoritativeClassificationSha256 || ''))
        && isPlainRecord(expected.authoritativeDecision)
        && isPlainRecord(expected.authoritativeClassification);
    if (!expectsInitialFull && !expectsRemediation) {
        return [
            'review_execution validation requires complete current task, lane, preflight, mode, full-scope, '
            + 'and remediation-decision authority.'
        ];
    }
    const violations: string[] = [];
    let authenticatedBaseline: ReviewRemediationBaselineArtifact | null = null;
    const contract = value as unknown as ReviewRemediationReviewContract;
    if (!hasExactKeys(value, REVIEW_CONTRACT_KEYS)) {
        violations.push('review_execution contract must contain exactly the canonical top-level fields.');
    }
    if (contract.schema_version !== REVIEW_REMEDIATION_REVIEW_CONTRACT_SCHEMA_VERSION) {
        violations.push('review_execution schema_version must be 1.');
    }
    if (!String(contract.task_id || '').trim() || contract.task_id !== String(contract.task_id).trim()) {
        violations.push('review_execution task_id must be non-empty canonical text.');
    }
    if (!/^[a-z][a-z0-9-]*$/u.test(String(contract.review_type || ''))) {
        violations.push('review_execution review_type must be non-empty canonical text.');
    }
    if (!['FULL', 'DELTA'].includes(contract.mode)) {
        violations.push('review_execution mode must be FULL or DELTA.');
    }
    const expectedSource = expected.mode === 'DELTA'
        ? 'remediation_delta'
        : expectsRemediation
            ? 'remediation_full'
            : 'initial_full';
    if (contract.source !== expectedSource) {
        violations.push(`review_execution source must be '${expectedSource}'.`);
    }
    if (!SHA256_PATTERN.test(String(contract.preflight_sha256 || ''))) {
        violations.push('review_execution preflight_sha256 is invalid.');
    }
    if (
        contract.authoritative_decision_sha256 !== null
        && !SHA256_PATTERN.test(String(contract.authoritative_decision_sha256 || ''))
    ) {
        violations.push('review_execution authoritative_decision_sha256 is invalid.');
    }
    if (
        contract.classification_sha256 !== null
        && !SHA256_PATTERN.test(String(contract.classification_sha256 || ''))
    ) {
        violations.push('review_execution classification_sha256 is invalid.');
    }
    if (expectedSource === 'initial_full') {
        if (contract.authoritative_decision_sha256 !== null || contract.classification_sha256 !== null) {
            violations.push('initial FULL review_execution must not carry remediation decision or classification lineage.');
        }
    } else {
        if (!SHA256_PATTERN.test(String(contract.authoritative_decision_sha256 || ''))) {
            violations.push('remediation review_execution authoritative_decision_sha256 is required.');
        }
        if (!SHA256_PATTERN.test(String(contract.classification_sha256 || ''))) {
            violations.push('remediation review_execution classification_sha256 is required.');
        }
        const decisionBindingViolation = getRemediationContractDecisionBindingViolation(
            contract,
            expected.persistedDecisionSha256,
            expected.authoritativeDecisionSha256,
            String(expected.authoritativeClassificationSha256 || '')
        );
        if (decisionBindingViolation) {
            violations.push(decisionBindingViolation);
        }
    }
    const authorityDecision = expectsRemediation
        ? expected.authoritativeDecision as ReviewRemediationAuthoritativeDecisionBinding
        : null;
    const authorityDecisionViolations = authorityDecision
        ? getAuthoritativeReviewRemediationDecisionViolations(authorityDecision, {
            expectedTaskId: expected.taskId
        })
        : [];
    if (
        authorityDecision
        && (
            authorityDecision.decision_sha256 !== expected.authoritativeDecisionSha256
            || authorityDecision.classification_sha256 !== expected.authoritativeClassificationSha256
        )
    ) {
        authorityDecisionViolations.push(
            'current remediation validation authority does not match its decision or classification hashes.'
        );
    }
    if (authorityDecision) {
        if (authorityDecision.status !== 'READY') {
            authorityDecisionViolations.push(
                'current remediation validation authority decision must be READY.'
            );
        }
        if (
            !SHA256_PATTERN.test(String(authorityDecision.preflight_sha256 || ''))
            || authorityDecision.preflight_sha256 !== expected.preflightSha256
        ) {
            authorityDecisionViolations.push(
                'current remediation validation authority has a stale decision preflight_sha256.'
            );
        }
        const authorityLane = Array.isArray(authorityDecision.lane_decisions)
            ? authorityDecision.lane_decisions.find((entry) => (
                isPlainRecord(entry) && entry.review_type === expected.reviewType
            ))
            : null;
        if (!authorityLane) {
            authorityDecisionViolations.push(
                `current remediation validation authority has no lane '${expected.reviewType}'.`
            );
        } else if (authorityLane.mode !== expected.mode) {
            authorityDecisionViolations.push(
                `current remediation validation authority lane mode '${authorityLane.mode}' does not match `
                + `expected '${expected.mode}'.`
            );
        }
    }
    violations.push(...authorityDecisionViolations);
    const classificationBindingViolations = authorityDecision
        ? getRemediationContractClassificationBindingViolations(
            contract,
            authorityDecision,
            expected.authoritativeClassification
        )
        : [];
    violations.push(...classificationBindingViolations);
    if (contract.task_id !== expected.taskId) {
        violations.push('review_execution task_id does not match the current task.');
    }
    if (contract.review_type !== expected.reviewType) {
        violations.push('review_execution review_type does not match the current review lane.');
    }
    if (contract.preflight_sha256 !== expected.preflightSha256) {
        violations.push('review_execution preflight_sha256 is stale.');
    }
    if (contract.mode !== expected.mode) {
        violations.push(`review_execution mode '${contract.mode}' does not match expected '${expected.mode}'.`);
    }
    if (contract.full_review_scope_sha256 !== hashList(normalizeCanonicalPaths(stringList(contract.full_review_scope)))) {
        violations.push('review_execution full review scope hash is invalid.');
    }
    if (JSON.stringify(stringList(contract.full_review_scope))
        !== JSON.stringify(normalizeCanonicalPaths(stringList(contract.full_review_scope)))) {
        violations.push('review_execution full review scope must be canonical and duplicate-free.');
    }
    const expectedFullReviewScope = normalizeCanonicalPaths(expected.fullReviewScope);
    if (JSON.stringify(contract.full_review_scope) !== JSON.stringify(expectedFullReviewScope)) {
        violations.push('review_execution full review scope does not match the authoritative current preflight scope.');
    }
    if (contract.mode === 'DELTA') {
        if (!contract.base || !contract.delta) {
            violations.push('DELTA review_execution requires base and delta lineage.');
        } else {
            if (!isPlainRecord(contract.base) || !hasExactKeys(
                contract.base as unknown as Record<string, unknown>,
                REVIEW_CONTRACT_BASE_KEYS
            )) {
                violations.push('DELTA review_execution base must contain exactly the canonical fields.');
            }
            if (!isPlainRecord(contract.delta) || !hasExactKeys(
                contract.delta as unknown as Record<string, unknown>,
                REVIEW_CONTRACT_DELTA_KEYS
            )) {
                violations.push('DELTA review_execution delta must contain exactly the canonical fields.');
            }
            const targets = normalizeCanonicalPaths(stringList(contract.delta.required_delta_targets));
            const contextFiles = normalizeCanonicalPaths(stringList(contract.delta.context_files));
            if (targets.length === 0 || contract.delta.required_delta_targets_sha256 !== hashList(targets)) {
                violations.push('DELTA review_execution target coverage hash is invalid.');
            }
            if (JSON.stringify(stringList(contract.delta.required_delta_targets)) !== JSON.stringify(targets)) {
                violations.push('DELTA review_execution targets must be canonical and duplicate-free.');
            }
            if (contract.delta.context_files_sha256 !== hashList(contextFiles)) {
                violations.push('DELTA review_execution context file hash is invalid.');
            }
            if (JSON.stringify(stringList(contract.delta.context_files)) !== JSON.stringify(contextFiles)) {
                violations.push('DELTA review_execution context files must be canonical and duplicate-free.');
            }
            const fullScope = new Set(normalizeCanonicalPaths(stringList(contract.full_review_scope)));
            if (targets.some((target) => !fullScope.has(target))) {
                violations.push('DELTA review_execution contains an out-of-scope target.');
            }
            if (contextFiles.some((contextFile) => !fullScope.has(contextFile))) {
                violations.push('DELTA review_execution contains an out-of-scope context file.');
            }
            if (contract.delta.origin_review_type !== contract.review_type) {
                violations.push('DELTA review_execution origin lane does not match the current review lane.');
            }
            if (
                contract.classification_sha256 !== contract.delta.classification_sha256
                || !SHA256_PATTERN.test(String(contract.delta.classification_sha256 || ''))
            ) {
                violations.push('DELTA review_execution classification lineage is invalid.');
            }
            for (const [label, hash] of Object.entries({
                baseline_artifact_sha256: contract.base.baseline_artifact_sha256,
                review_receipt_sha256: contract.base.review_receipt_sha256,
                review_receipt_snapshot_sha256: contract.base.review_receipt_snapshot_sha256,
                review_context_sha256: contract.base.review_context_sha256,
                review_tree_state_sha256: contract.base.review_tree_state_sha256,
                review_scope_sha256: contract.base.review_scope_sha256,
                scope_sha256: contract.base.scope_sha256,
                delta_base_snapshot_sha256: contract.base.delta_base_snapshot_sha256,
                current_snapshot_sha256: contract.delta.current_snapshot_sha256
            })) {
                if (!SHA256_PATTERN.test(String(hash || ''))) {
                    violations.push(`DELTA review_execution ${label} is invalid.`);
                }
            }
            if (authorityDecisionViolations.length === 0 && classificationBindingViolations.length === 0) {
                const baselineValidation = validateReviewRemediationBaselineArtifact({
                    artifactPath: contract.base.baseline_artifact_path,
                    expectedArtifactSha256: contract.base.baseline_artifact_sha256,
                    expectedTaskId: contract.task_id,
                    expectedReviewType: contract.delta.origin_review_type,
                    expectedReceiptSha256: contract.base.review_receipt_sha256,
                    expectedReviewContextSha256: contract.base.review_context_sha256,
                    expectedReviewTreeStateSha256: contract.base.review_tree_state_sha256,
                    expectedScopeSha256: contract.base.scope_sha256
                });
                if (!baselineValidation.valid || !baselineValidation.artifact) {
                    violations.push(
                        `DELTA review_execution base lineage is invalid: ${baselineValidation.violations.join(' ')}`
                    );
                } else if (
                    baselineValidation.artifact.bindings.receipt.snapshot_sha256
                        !== contract.base.review_receipt_snapshot_sha256
                    || baselineValidation.artifact.delta_base?.snapshot_sha256
                        !== contract.base.delta_base_snapshot_sha256
                ) {
                    violations.push(
                        'DELTA review_execution base snapshot lineage does not match the authenticated baseline.'
                    );
                } else {
                    authenticatedBaseline = baselineValidation.artifact;
                    const baselineReviewScopeViolation = getAuthenticatedBaselineReviewScopeViolation(
                        contract.base,
                        authenticatedBaseline
                    );
                    if (baselineReviewScopeViolation) {
                        violations.push(baselineReviewScopeViolation);
                    }
                }
            }
        }
    } else if (contract.base !== null || contract.delta !== null) {
        violations.push('FULL review_execution must not carry DELTA base or target lineage.');
    }
    const reconciliation = contract.finding_reconciliation;
    if (!isPlainRecord(reconciliation)) {
        violations.push('review_execution finding reconciliation contract is missing.');
    } else {
        if (!hasExactKeys(reconciliation, REVIEW_CONTRACT_RECONCILIATION_KEYS)) {
            violations.push('review_execution finding reconciliation must contain exactly the canonical fields.');
        }
        const baselineIds = normalizeCanonicalIds(stringList(reconciliation.baseline_finding_ids));
        const resolvableIds = normalizeCanonicalIds(stringList(reconciliation.resolvable_finding_ids));
        const protectedIds = normalizeCanonicalIds(stringList(reconciliation.protected_open_finding_ids));
        const protectedFixNowIds = normalizeCanonicalIds(stringList(reconciliation.protected_fix_now_finding_ids));
        if (reconciliation.baseline_finding_ids_sha256 !== hashList(baselineIds)
            || reconciliation.resolvable_finding_ids_sha256 !== hashList(resolvableIds)
            || reconciliation.protected_open_finding_ids_sha256 !== hashList(protectedIds)
            || reconciliation.protected_fix_now_finding_ids_sha256 !== hashList(protectedFixNowIds)) {
            violations.push('review_execution finding reconciliation hashes are invalid.');
        }
        if (JSON.stringify(stringList(reconciliation.baseline_finding_ids)) !== JSON.stringify(baselineIds)
            || JSON.stringify(stringList(reconciliation.resolvable_finding_ids)) !== JSON.stringify(resolvableIds)
            || JSON.stringify(stringList(reconciliation.protected_open_finding_ids)) !== JSON.stringify(protectedIds)
            || JSON.stringify(stringList(reconciliation.protected_fix_now_finding_ids))
                !== JSON.stringify(protectedFixNowIds)) {
            violations.push('review_execution finding reconciliation ids must be canonical and duplicate-free.');
        }
        const partition = normalizeCanonicalIds([...resolvableIds, ...protectedIds]);
        if (partition.length !== baselineIds.length || partition.some((entry, index) => entry !== baselineIds[index])) {
            violations.push('review_execution finding reconciliation is not a complete disjoint baseline partition.');
        }
        if (protectedFixNowIds.some((findingId) => !protectedIds.includes(findingId))) {
            violations.push('review_execution protected fix-now findings must remain in the protected-open partition.');
        }
        if (contract.mode === 'DELTA' && protectedFixNowIds.length > 0) {
            violations.push('DELTA review_execution cannot close protected fix-now findings outside covered targets.');
        }
        violations.push(...getReviewRemediationFindingReconciliationViolations(
            reconciliation,
            contract.mode === 'DELTA' ? authenticatedBaseline : null,
            contract.mode === 'DELTA' && contract.delta
                ? normalizeCanonicalPaths(stringList(contract.delta.required_delta_targets))
                : []
        ));
    }
    if (contract.complete_scope_lineage_sha256 !== buildCompleteScopeLineageSha256(contract)) {
        violations.push('review_execution complete-scope lineage hash is invalid.');
    }
    const withoutHash = { ...contract } as Record<string, unknown>;
    delete withoutHash.contract_sha256;
    if (contract.contract_sha256 !== sha256RedactedJsonPayload(withoutHash)) {
        violations.push('review_execution contract hash is invalid.');
    }
    return violations;
}

export function getReviewerRemediationCoverageViolations(
    declaration: unknown,
    contract: ReviewRemediationReviewContract
): string[] {
    if (!isPlainRecord(declaration)) {
        return ['review_execution evidence declaration is required.'];
    }
    const violations: string[] = [];
    if (!hasExactKeys(declaration, REVIEWER_REMEDIATION_COVERAGE_KEYS)) {
        violations.push(
            'review_execution evidence declaration must contain exactly the canonical fields.'
        );
    }
    if (declaration.mode !== contract.mode) {
        violations.push(`review_execution evidence mode must be '${contract.mode}'.`);
    }
    if (declaration.contract_sha256 !== contract.contract_sha256) {
        violations.push('review_execution evidence contract_sha256 does not match the launch contract.');
    }
    const rawCoveredTargets = Array.isArray(declaration.covered_delta_targets)
        && declaration.covered_delta_targets.every((entry) => typeof entry === 'string')
        ? declaration.covered_delta_targets
        : null;
    const coveredTargets = normalizeCanonicalPaths(rawCoveredTargets ?? []);
    if (!rawCoveredTargets || JSON.stringify(rawCoveredTargets) !== JSON.stringify(coveredTargets)) {
        violations.push(
            'review_execution evidence covered_delta_targets must be a present, canonical, duplicate-free string array.'
        );
    }
    const expectedTargets = contract.delta?.required_delta_targets ?? [];
    if (JSON.stringify(coveredTargets) !== JSON.stringify(expectedTargets)) {
        violations.push('review_execution evidence must exhaust every assigned delta target exactly once.');
    }
    const rawInspectedFindingIds = Array.isArray(declaration.inspected_prior_finding_ids)
        && declaration.inspected_prior_finding_ids.every((entry) => typeof entry === 'string')
        ? declaration.inspected_prior_finding_ids
        : null;
    const inspectedFindingIds = normalizeCanonicalIds(rawInspectedFindingIds ?? []);
    if (
        !rawInspectedFindingIds
        || JSON.stringify(rawInspectedFindingIds) !== JSON.stringify(inspectedFindingIds)
    ) {
        violations.push(
            'review_execution evidence inspected_prior_finding_ids must be a present, canonical, duplicate-free string array.'
        );
    }
    if (JSON.stringify(inspectedFindingIds) !== JSON.stringify(contract.finding_reconciliation.resolvable_finding_ids)) {
        violations.push(
            'review_execution evidence may inspect only, and must exhaust, prior findings covered by the current delta.'
        );
    }
    return violations;
}
