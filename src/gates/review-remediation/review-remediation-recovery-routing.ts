import { countNextStepWork } from '../../core/next-step-measurement';
import { sha256RedactedJsonPayload } from '../../core/redaction';
import {
    getReviewExecutionDependencies,
    getReviewExecutionPreparationOrder,
    type EffectiveReviewExecutionPolicyMode
} from '../../core/review-execution-policy';
import type { CompiledReviewDependencyGraph } from '../../core/review-dependency-graph';
import { isPlainRecord } from '../../core/records';
import { validateTaskProfilePolicySnapshot } from '../../policy/task-profile-policy-snapshot';
import {
    resolveReviewRemediationRerunLanes,
    resolveReviewRemediationRerunPolicyFromSnapshot
} from '../../policy/review-remediation-rerun-policy';
import {
    collectReviewRemediationProtectedBoundarySignals,
    evaluateReviewRemediationMode,
    getReviewRemediationModeAssessmentViolations,
    resolveReviewRemediationModePolicyFromSnapshot,
    type ReviewRemediationProtectedBoundarySignal
} from '../../policy/review-remediation-mode-policy';
import type { ReviewRemediationDeltaClassification } from './review-remediation-delta';
import {
    buildReviewRemediationValidationRequirement,
    getReviewRemediationDeltaClassificationViolations,
    validateReviewRemediationValidationEvidence,
    type ReviewRemediationValidationArtifactStateReader,
    type ReviewRemediationValidationEvidence,
    type ReviewRemediationValidationRequirement
} from './review-remediation-validation-evidence';

export type ReviewRemediationRecoveryValidationRoute =
    | 'focused'
    | 'focused_and_affected'
    | 'ordinary';

export interface ReviewRemediationRecoveryCommand {
    command: string;
}

export interface ReviewRemediationReusableReceipt {
    review_type: string;
    reuse_status: 'ACCEPTED' | 'REJECTED';
    findings_satisfied: boolean;
    evidence_kind?: 'REUSED' | 'FRESH';
    reason?: string | null;
}

export type ReviewRemediationDecisionMode = 'REUSE' | 'DELTA' | 'FULL';

export interface ReviewRemediationRuntimeFixClassification {
    category: string;
    reason: string;
    blocked_before_reuse: boolean;
    invalidated_review_types: string[];
}

export type ReviewRemediationDecisionClassification =
    | {
        source: 'delta';
        delta: ReviewRemediationDeltaClassification;
        profilePolicySnapshot: unknown;
        baselineProfilePolicySnapshotSha256: string;
    }
    | {
        source: 'runtime_fix';
        classification: ReviewRemediationRuntimeFixClassification;
    };

export interface ReviewRemediationLaneDecision {
    review_type: string;
    mode: ReviewRemediationDecisionMode;
    reuse_eligible: boolean;
    satisfied: boolean;
    satisfaction_source: 'REUSED' | 'FRESH' | null;
    invalidated: boolean;
    depends_on: string[];
    invalidated_downstream_review_types: string[];
    reason_code: string;
    reason: string;
    reason_sha256: string;
}

export interface AuthoritativeReviewRemediationDecision {
    schema_version: 1;
    status: 'READY' | 'BLOCKED';
    task_id: string;
    current_review_type: string;
    classification_source: ReviewRemediationDecisionClassification['source'];
    classification_sha256: string;
    category: string;
    profile_policy_snapshot_sha256: string | null;
    policy_id: string;
    policy_legacy_fallback: boolean;
    invalidated_review_types: string[];
    preserved_review_types: string[];
    reused_review_types: string[];
    satisfied_review_types: string[];
    rejected_reuse_review_types: string[];
    dependency_edges: Array<{ review_type: string; depends_on: string[] }>;
    lane_decisions: ReviewRemediationLaneDecision[];
    blocked_reasons: string[];
    decision_sha256: string;
}

export interface ResolveAuthoritativeReviewRemediationDecisionOptions {
    taskId: string;
    currentReviewType: string;
    classification: ReviewRemediationDecisionClassification;
    requiredReviews: Record<string, boolean>;
    reviewExecutionPolicyMode: EffectiveReviewExecutionPolicyMode;
    reviewDependencyGraph?: CompiledReviewDependencyGraph | null;
    reusableReceipts?: readonly ReviewRemediationReusableReceipt[];
    modePolicyValidationInputs?: ReviewRemediationModePolicyValidationInputs | null;
}

export interface ReviewRemediationModePolicyValidationInputs {
    consecutiveDeltaReviews: number;
    protectedBoundarySignals: readonly ReviewRemediationProtectedBoundarySignal[];
    taskCriteriaChanged: boolean;
    policyChanged: boolean;
    uncertainCrossFileImpact: boolean;
}

export function getAuthoritativeReviewRemediationDecisionViolations(
    value: unknown,
    options: { expectedTaskId?: string } = {}
): string[] {
    if (!isPlainRecord(value)) {
        return ['authoritative remediation decision must be an object.'];
    }
    const violations: string[] = [];
    if (value.schema_version !== 1) {
        violations.push('authoritative remediation decision schema_version must be 1.');
    }
    if (!['READY', 'BLOCKED'].includes(String(value.status || ''))) {
        violations.push('authoritative remediation decision status must be READY or BLOCKED.');
    }
    const taskId = String(value.task_id || '').trim();
    if (!taskId || value.task_id !== taskId) {
        violations.push('authoritative remediation decision task_id must be canonical.');
    }
    if (options.expectedTaskId && taskId !== options.expectedTaskId) {
        violations.push(
            `authoritative remediation decision belongs to task '${taskId || 'missing'}', not '${options.expectedTaskId}'.`
        );
    }
    const laneValues = Array.isArray(value.lane_decisions) ? value.lane_decisions : [];
    if (laneValues.length === 0) {
        violations.push('authoritative remediation decision must contain lane_decisions.');
    }
    const seenReviewTypes = new Set<string>();
    for (const laneValue of laneValues) {
        if (!isPlainRecord(laneValue)) {
            violations.push('authoritative remediation lane decision must be an object.');
            continue;
        }
        const reviewType = String(laneValue.review_type || '').trim().toLowerCase();
        if (!reviewType || laneValue.review_type !== reviewType || !/^[a-z][a-z0-9-]*$/u.test(reviewType)) {
            violations.push('authoritative remediation lane review_type must be canonical.');
        } else if (seenReviewTypes.has(reviewType)) {
            violations.push(`authoritative remediation lane '${reviewType}' is duplicated.`);
        } else {
            seenReviewTypes.add(reviewType);
        }
        if (!['REUSE', 'DELTA', 'FULL'].includes(String(laneValue.mode || ''))) {
            violations.push(`authoritative remediation lane '${reviewType || 'unknown'}' has an invalid mode.`);
        }
        if (
            typeof laneValue.reuse_eligible !== 'boolean'
            || typeof laneValue.invalidated !== 'boolean'
            || typeof laneValue.satisfied !== 'boolean'
        ) {
            violations.push(
                `authoritative remediation lane '${reviewType || 'unknown'}' must bind reuse, satisfaction, and invalidation booleans.`
            );
        }
        if (![null, 'REUSED', 'FRESH'].includes(laneValue.satisfaction_source as null | string)) {
            violations.push(
                `authoritative remediation lane '${reviewType || 'unknown'}' has an invalid satisfaction source.`
            );
        }
        if ((laneValue.satisfied === true) !== (laneValue.satisfaction_source !== null)) {
            violations.push(
                `authoritative remediation lane '${reviewType || 'unknown'}' has inconsistent satisfaction evidence.`
            );
        }
        if (!Array.isArray(laneValue.depends_on) || !Array.isArray(laneValue.invalidated_downstream_review_types)) {
            violations.push(
                `authoritative remediation lane '${reviewType || 'unknown'}' must bind dependency impact arrays.`
            );
        }
        if (!String(laneValue.reason_code || '').trim() || !String(laneValue.reason || '').trim()) {
            violations.push(`authoritative remediation lane '${reviewType || 'unknown'}' must contain a reason.`);
        }
        const laneWithoutHash = { ...laneValue };
        delete laneWithoutHash.reason_sha256;
        const expectedReasonSha256 = sha256RedactedJsonPayload(laneWithoutHash);
        if (String(laneValue.reason_sha256 || '').trim().toLowerCase() !== expectedReasonSha256) {
            violations.push(`authoritative remediation lane '${reviewType || 'unknown'}' reason hash is invalid.`);
        }
    }
    for (const field of [
        'invalidated_review_types',
        'preserved_review_types',
        'reused_review_types',
        'satisfied_review_types',
        'rejected_reuse_review_types',
        'dependency_edges',
        'blocked_reasons'
    ]) {
        if (!Array.isArray(value[field])) {
            violations.push(`authoritative remediation decision ${field} must be an array.`);
        }
    }
    const decisionWithoutHash = { ...value };
    delete decisionWithoutHash.decision_sha256;
    const expectedDecisionSha256 = sha256RedactedJsonPayload(decisionWithoutHash);
    if (String(value.decision_sha256 || '').trim().toLowerCase() !== expectedDecisionSha256) {
        violations.push('authoritative remediation decision hash is invalid.');
    }
    return violations;
}

export interface ReviewRemediationCompletedReceipt {
    schema_version: 1;
    task_id: string;
    review_type: string;
    status: 'ACCEPTED';
    findings_satisfied: true;
    review_context_sha256: string;
    delta_classification_sha256: string;
    validation_evidence_sha256: string;
    receipt_artifact_path: string;
    receipt_artifact_sha256: string;
}

export interface ReviewRemediationRecoveryNextAction {
    kind: 'validation' | 'review';
    target: string;
    command: string;
}

export interface ReviewRemediationRecoveryRoute {
    schema_version: 1;
    status: 'VALIDATION_REQUIRED' | 'REVIEW_REQUIRED' | 'COMPLETE';
    task_id: string;
    review_type: string;
    delta_category: ReviewRemediationDeltaClassification['category'];
    delta_classification_sha256: string;
    profile_policy_snapshot_sha256: string;
    policy_id: string;
    policy_legacy_fallback: boolean;
    validation_requirement: ReviewRemediationValidationRequirement;
    validation_route: ReviewRemediationRecoveryValidationRoute;
    validation_evidence_sha256: string | null;
    invalidated_review_types: string[];
    preserved_review_types: string[];
    reused_review_types: string[];
    rejected_reuse_review_types: string[];
    review_required_types: string[];
    completed_review_types: string[];
    dependency_edges: Array<{ review_type: string; depends_on: string[] }>;
    authoritative_decision: AuthoritativeReviewRemediationDecision;
    next_action: ReviewRemediationRecoveryNextAction | null;
    reason: string;
    routing_sha256: string;
}

export interface BuildReviewRemediationRecoveryRouteOptions {
    taskId: string;
    currentReviewType: string;
    profilePolicySnapshot: unknown;
    baselineProfilePolicySnapshotSha256: string;
    delta: ReviewRemediationDeltaClassification;
    requiredReviews: Record<string, boolean>;
    reviewExecutionPolicyMode: EffectiveReviewExecutionPolicyMode;
    reviewDependencyGraph?: CompiledReviewDependencyGraph | null;
    modePolicyValidationInputs?: ReviewRemediationModePolicyValidationInputs | null;
    reusableReceipts?: readonly ReviewRemediationReusableReceipt[];
    completedReceipts?: readonly ReviewRemediationCompletedReceipt[];
    reviewContextSha256ByType?: Partial<Record<string, string>>;
    validationEvidence?: ReviewRemediationValidationEvidence | null;
    reviewsRoot?: string;
    artifactStateReader?: ReviewRemediationValidationArtifactStateReader;
    validationCommands: Record<ReviewRemediationRecoveryValidationRoute, ReviewRemediationRecoveryCommand>;
    reviewCommands: Partial<Record<string, ReviewRemediationRecoveryCommand>>;
}

function normalizeSha256(value: unknown, label: string): string {
    const normalized = String(value || '').trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/u.test(normalized)) {
        throw new Error(`${label} must be a lowercase SHA-256 hash.`);
    }
    return normalized;
}

function resolveProfilePolicySnapshotSha256(snapshot: unknown): string {
    if (isPlainRecord(snapshot) && snapshot.snapshot_hash !== undefined) {
        const validation = validateTaskProfilePolicySnapshot(snapshot);
        if (validation.status !== 'PASS' || !validation.snapshot) {
            throw new Error(
                `Review remediation recovery policy snapshot is invalid: ${validation.violations.join(' ')}`
            );
        }
        return validation.snapshot.snapshot_hash;
    }
    return sha256RedactedJsonPayload(snapshot ?? null);
}

function normalizeReviewType(value: unknown, label: string): string {
    const normalized = String(value || '').trim().toLowerCase();
    if (
        !normalized
        || value !== normalized
        || !/^[a-z][a-z0-9-]*$/u.test(normalized)
        || normalized === 'full-suite-validation'
    ) {
        throw new Error(`${label} must be a canonical review lane id.`);
    }
    return normalized;
}

function canonicalRequiredReviewTypes(
    requiredReviews: Record<string, boolean>,
    policyMode: EffectiveReviewExecutionPolicyMode,
    dependencyGraph?: CompiledReviewDependencyGraph | null
): string[] {
    const required = Object.entries(requiredReviews)
        .filter(([, enabled]) => (countNextStepWork('visit:review-remediation-recovery-routing:event:328'), enabled === true))
        .map(([reviewType]) => (countNextStepWork('visit:review-remediation-recovery-routing:event:328'), normalizeReviewType(reviewType, 'required review type')));
    if (dependencyGraph) {
        const requiredSet = new Set(required);
        const missingFromGraph = required.filter((reviewType) => !dependencyGraph.nodes.includes(reviewType));
        if (missingFromGraph.length > 0) {
            throw new Error(
                `Required remediation recovery lanes are missing from the frozen dependency graph: ${missingFromGraph.join(', ')}.`
            );
        }
        return dependencyGraph.preparation_order.filter((reviewType) => requiredSet.has(reviewType));
    }
    const order = getReviewExecutionPreparationOrder(policyMode);
    return [...new Set(required)].sort((left, right) => {
        const leftIndex = order.indexOf(left);
        const rightIndex = order.indexOf(right);
        return (leftIndex < 0 ? Number.MAX_SAFE_INTEGER : leftIndex)
            - (rightIndex < 0 ? Number.MAX_SAFE_INTEGER : rightIndex)
            || left.localeCompare(right);
    });
}

function requireCommand(command: ReviewRemediationRecoveryCommand | undefined, label: string): string {
    const value = String(command?.command || '');
    if (!value.trim() || value !== value.trim() || /[\r\n]/u.test(value)) {
        throw new Error(`${label} must provide one non-empty single-line executable command.`);
    }
    return value;
}

function validationRouteForRequirement(
    requirement: ReviewRemediationValidationRequirement
): ReviewRemediationRecoveryValidationRoute {
    return requirement === 'expanded_or_full' ? 'ordinary' : requirement;
}

function buildReasonSha256(decision: Omit<ReviewRemediationLaneDecision, 'reason_sha256'>): string {
    return sha256RedactedJsonPayload(decision as unknown as Record<string, unknown>);
}

function buildBlockedDecision(options: {
    taskId: string;
    currentReviewType: string;
    classificationSource: ReviewRemediationDecisionClassification['source'];
    classificationSha256: string;
    category: string;
    profilePolicySnapshotSha256: string | null;
    policyId: string;
    policyLegacyFallback: boolean;
    requiredReviewTypes: readonly string[];
    dependencyEdges: Array<{ review_type: string; depends_on: string[] }>;
    blockedReasons: string[];
}): AuthoritativeReviewRemediationDecision {
    const reason = `Authoritative remediation decision is blocked: ${options.blockedReasons.join(' ')}`;
    const laneDecisions = options.requiredReviewTypes.map((reviewType) => {
        const laneWithoutHash: Omit<ReviewRemediationLaneDecision, 'reason_sha256'> = {
            review_type: reviewType,
            mode: 'FULL',
            reuse_eligible: false,
            satisfied: false,
            satisfaction_source: null,
            invalidated: true,
            depends_on: options.dependencyEdges.find((edge) => edge.review_type === reviewType)?.depends_on ?? [],
            invalidated_downstream_review_types: [],
            reason_code: 'trust_boundary_blocked',
            reason
        };
        return {
            ...laneWithoutHash,
            reason_sha256: buildReasonSha256(laneWithoutHash)
        };
    });
    const decisionWithoutHash: Omit<AuthoritativeReviewRemediationDecision, 'decision_sha256'> = {
        schema_version: 1,
        status: 'BLOCKED',
        task_id: options.taskId,
        current_review_type: options.currentReviewType,
        classification_source: options.classificationSource,
        classification_sha256: options.classificationSha256,
        category: options.category,
        profile_policy_snapshot_sha256: options.profilePolicySnapshotSha256,
        policy_id: options.policyId,
        policy_legacy_fallback: options.policyLegacyFallback,
        invalidated_review_types: [...options.requiredReviewTypes],
        preserved_review_types: [],
        reused_review_types: [],
        satisfied_review_types: [],
        rejected_reuse_review_types: [],
        dependency_edges: options.dependencyEdges,
        lane_decisions: laneDecisions,
        blocked_reasons: options.blockedReasons
    };
    return {
        ...decisionWithoutHash,
        decision_sha256: sha256RedactedJsonPayload(decisionWithoutHash as unknown as Record<string, unknown>)
    };
}

function normalizeRuntimeFixClassification(
    classification: ReviewRemediationRuntimeFixClassification,
    requiredReviewTypes: readonly string[]
): {
    category: string;
    reason: string;
    blocked: boolean;
    invalidatedReviewTypes: string[];
    classificationSha256: string;
    violations: string[];
} {
    const violations: string[] = [];
    const category = String(classification?.category || '').trim();
    const reason = String(classification?.reason || '').trim();
    if (!category || classification.category !== category) {
        violations.push('runtime fix classification category must be canonical and non-empty.');
    }
    if (!reason || classification.reason !== reason) {
        violations.push('runtime fix classification reason must be canonical and non-empty.');
    }
    const rawInvalidated = Array.isArray(classification?.invalidated_review_types)
        ? classification.invalidated_review_types
        : [];
    const invalidatedReviewTypes: string[] = [];
    for (const rawReviewType of rawInvalidated) {
        try {
            const reviewType = normalizeReviewType(rawReviewType, 'runtime fix invalidated review type');
            if (!requiredReviewTypes.includes(reviewType)) {
                violations.push(`runtime fix invalidated review type '${reviewType}' is not currently required.`);
            } else if (invalidatedReviewTypes.includes(reviewType)) {
                violations.push(`runtime fix invalidated review type '${reviewType}' is duplicated.`);
            } else {
                invalidatedReviewTypes.push(reviewType);
            }
        } catch (error: unknown) {
            violations.push(error instanceof Error ? error.message : String(error));
        }
    }
    const orderedInvalidated = requiredReviewTypes.filter((reviewType) => invalidatedReviewTypes.includes(reviewType));
    return {
        category,
        reason,
        blocked: classification?.blocked_before_reuse === true,
        invalidatedReviewTypes: orderedInvalidated,
        classificationSha256: sha256RedactedJsonPayload(classification as unknown as Record<string, unknown>),
        violations
    };
}

export function resolveAuthoritativeReviewRemediationDecision(
    options: ResolveAuthoritativeReviewRemediationDecisionOptions
): AuthoritativeReviewRemediationDecision {
    const taskId = String(options.taskId || '').trim();
    const currentReviewType = normalizeReviewType(options.currentReviewType, 'current review type');
    const requiredReviewTypes = canonicalRequiredReviewTypes(
        options.requiredReviews,
        options.reviewExecutionPolicyMode,
        options.reviewDependencyGraph
    );
    const dependencyEdges = requiredReviewTypes.map((reviewType) => ({
        review_type: reviewType,
        depends_on: getReviewExecutionDependencies(
            reviewType,
            options.requiredReviews,
            options.reviewExecutionPolicyMode,
            options.reviewDependencyGraph
        ).filter((dependency) => requiredReviewTypes.includes(dependency))
    }));
    const blockedReasons: string[] = [];
    if (!taskId || options.taskId !== taskId) {
        blockedReasons.push('task id is not canonical.');
    }
    if (!requiredReviewTypes.includes(currentReviewType)) {
        blockedReasons.push(`current review type '${currentReviewType}' is not currently required.`);
    }

    let category = 'unknown';
    let classificationSha256 = sha256RedactedJsonPayload(options.classification as unknown as Record<string, unknown>);
    let profilePolicySnapshotSha256: string | null = null;
    let policyId = 'runtime_fix_full_fallback_v1';
    let policyLegacyFallback = false;
    let invalidatedReviewTypes: string[] = [];
    let authenticatedDelta = false;
    let authenticatedDeltaEligibleReviewTypes = new Set<string>();
    let fullFallbackFromDelta = false;
    let fullFallbackReason = '';

    if (options.classification.source === 'delta') {
        const delta = options.classification.delta;
        const deltaViolations = getReviewRemediationDeltaClassificationViolations(delta);
        classificationSha256 = String(delta?.classification_sha256 || '').trim().toLowerCase();
        category = String(delta?.category || '').trim() || 'unknown';
        if (deltaViolations.length > 0) {
            blockedReasons.push(...deltaViolations);
        }
        if (delta?.task_id !== taskId || delta?.review_type !== currentReviewType) {
            blockedReasons.push('remediation delta belongs to a foreign task or review type.');
        }
        try {
            profilePolicySnapshotSha256 = resolveProfilePolicySnapshotSha256(
                options.classification.profilePolicySnapshot
            );
            const baselineProfilePolicySnapshotSha256 = normalizeSha256(
                options.classification.baselineProfilePolicySnapshotSha256,
                'baseline profile policy snapshot hash'
            );
            if (profilePolicySnapshotSha256 !== baselineProfilePolicySnapshotSha256) {
                blockedReasons.push('review remediation policy snapshot does not match the authenticated baseline.');
            }
            const policyResolution = resolveReviewRemediationRerunPolicyFromSnapshot(
                options.classification.profilePolicySnapshot
            );
            const modePolicyResolution = resolveReviewRemediationModePolicyFromSnapshot(
                options.classification.profilePolicySnapshot
            );
            policyId = policyResolution.policy.policy_id;
            policyLegacyFallback = policyResolution.legacy_fallback;
            if (delta.mode_policy_assessment === undefined) {
                if (modePolicyResolution.legacy_fallback) {
                    fullFallbackFromDelta = true;
                    fullFallbackReason =
                        'legacy remediation evidence has no immutable mode-policy assessment';
                } else {
                    blockedReasons.push(
                        'authenticated remediation delta is missing its frozen mode-policy assessment.'
                    );
                }
            } else {
                blockedReasons.push(...getReviewRemediationModeAssessmentViolations({
                    assessment: delta.mode_policy_assessment,
                    policy: modePolicyResolution.policy,
                    legacyFallback: modePolicyResolution.legacy_fallback,
                    expectedProtectedBoundarySignals: collectReviewRemediationProtectedBoundarySignals({
                        changedFiles: delta.changed_files,
                        preflight: {}
                    }),
                    reviewType: delta.review_type,
                    category: delta.category,
                    changedFilesCount: delta.changed_files.length,
                    changedLinesTotal: delta.changed_lines_total
                }));
                const validationInputs = options.modePolicyValidationInputs;
                if (!validationInputs) {
                    blockedReasons.push(
                        'authenticated remediation mode assessment is missing timeline and preflight validation inputs.'
                    );
                } else {
                    const expectedAssessment = evaluateReviewRemediationMode({
                        policy: modePolicyResolution.policy,
                        legacyFallback: modePolicyResolution.legacy_fallback,
                        reviewType: delta.review_type,
                        category: delta.category,
                        changedFilesCount: delta.changed_files.length,
                        changedLinesTotal: delta.changed_lines_total,
                        consecutiveDeltaReviews: validationInputs.consecutiveDeltaReviews,
                        protectedBoundarySignals: validationInputs.protectedBoundarySignals,
                        taskCriteriaChanged: validationInputs.taskCriteriaChanged,
                        policyChanged: validationInputs.policyChanged,
                        scopeMembershipChanged: !delta.scope.membership_unchanged,
                        uncertainCrossFileImpact: validationInputs.uncertainCrossFileImpact,
                        existingFullReviewReasons: delta.full_review_reasons
                    });
                    if (
                        delta.mode_policy_assessment.assessment_sha256
                        !== expectedAssessment.assessment_sha256
                    ) {
                        blockedReasons.push(
                            'remediation mode assessment does not match authenticated timeline and preflight mode-policy inputs.'
                        );
                    }
                }
            }
            if (blockedReasons.length === 0) {
                const selection = resolveReviewRemediationRerunLanes({
                    policy: policyResolution.policy,
                    category: delta.category,
                    currentReviewType,
                    requiredReviews: options.requiredReviews,
                    reviewExecutionPolicyMode: options.reviewExecutionPolicyMode,
                    reviewDependencyGraph: options.reviewDependencyGraph
                });
                invalidatedReviewTypes = selection.ordered_rerun_lanes;
                if (delta.full_review_required || fullFallbackFromDelta) {
                    fullFallbackFromDelta = true;
                    fullFallbackReason = fullFallbackReason || delta.full_review_reasons.join('; ')
                        || 'authenticated remediation snapshot requires FULL review';
                } else {
                    authenticatedDeltaEligibleReviewTypes = new Set(
                        selection.ordered_rerun_lanes.filter((reviewType) => (
                            reviewType === currentReviewType
                            &&
                            delta.mode_policy_assessment?.delta_eligible_review_types.includes(reviewType)
                        ))
                    );
                    authenticatedDelta = authenticatedDeltaEligibleReviewTypes.size > 0;
                }
            }
        } catch (error: unknown) {
            blockedReasons.push(error instanceof Error ? error.message : String(error));
        }
    } else {
        const runtimeFix = normalizeRuntimeFixClassification(
            options.classification.classification,
            requiredReviewTypes
        );
        category = runtimeFix.category || category;
        fullFallbackReason = runtimeFix.reason;
        classificationSha256 = runtimeFix.classificationSha256;
        invalidatedReviewTypes = runtimeFix.invalidatedReviewTypes;
        blockedReasons.push(...runtimeFix.violations);
        if (runtimeFix.blocked) {
            blockedReasons.push(runtimeFix.reason || 'runtime remediation classification blocked reuse.');
        }
    }

    const receiptByReviewType = new Map<string, ReviewRemediationReusableReceipt>();
    for (const receipt of options.reusableReceipts ?? []) {
        try {
            const reviewType = normalizeReviewType(receipt.review_type, 'reusable receipt review_type');
            if (!requiredReviewTypes.includes(reviewType)) {
                blockedReasons.push(`reusable receipt '${reviewType}' is not a currently required review lane.`);
            } else if (receiptByReviewType.has(reviewType)) {
                blockedReasons.push(`reusable receipt '${reviewType}' is duplicated.`);
            } else if (!['ACCEPTED', 'REJECTED'].includes(receipt.reuse_status)) {
                blockedReasons.push(`reusable receipt '${reviewType}' has unsupported reuse_status.`);
            } else if (receipt.evidence_kind && !['REUSED', 'FRESH'].includes(receipt.evidence_kind)) {
                blockedReasons.push(`reusable receipt '${reviewType}' has unsupported evidence_kind.`);
            } else {
                receiptByReviewType.set(reviewType, receipt);
            }
        } catch (error: unknown) {
            blockedReasons.push(error instanceof Error ? error.message : String(error));
        }
    }

    if (blockedReasons.length > 0) {
        return buildBlockedDecision({
            taskId,
            currentReviewType,
            classificationSource: options.classification.source,
            classificationSha256,
            category,
            profilePolicySnapshotSha256,
            policyId,
            policyLegacyFallback,
            requiredReviewTypes,
            dependencyEdges,
            blockedReasons
        });
    }

    const invalidatedSet = new Set(invalidatedReviewTypes);
    const reusedReviewTypes: string[] = [];
    const satisfiedReviewTypes: string[] = [];
    const rejectedReuseReviewTypes: string[] = [];
    const laneDecisions = requiredReviewTypes.map((reviewType) => {
        const invalidated = invalidatedSet.has(reviewType);
        const receipt = receiptByReviewType.get(reviewType);
        let mode: ReviewRemediationDecisionMode;
        let reuseEligible: boolean;
        let satisfied = false;
        let satisfactionSource: ReviewRemediationLaneDecision['satisfaction_source'] = null;
        let reasonCode: string;
        let reason: string;
        const acceptedEvidence = receipt?.reuse_status === 'ACCEPTED' && receipt.findings_satisfied === true;
        const evidenceKind = receipt?.evidence_kind ?? 'REUSED';
        if (invalidated) {
            const deltaEligible = authenticatedDelta
                && authenticatedDeltaEligibleReviewTypes.has(reviewType);
            mode = deltaEligible ? 'DELTA' : 'FULL';
            reuseEligible = false;
            reasonCode = deltaEligible
                ? 'authenticated_delta_invalidated_lane'
                : fullFallbackFromDelta
                    ? 'authenticated_snapshot_requires_full_fallback'
                    : options.classification.source === 'delta'
                        ? 'delta_policy_requires_full_lane'
                        : 'runtime_fix_requires_full_fallback';
            reason = deltaEligible
                ? `Authenticated remediation delta '${category}' invalidated '${reviewType}'; bounded DELTA review is required.`
                : fullFallbackFromDelta
                    ? `Authenticated remediation snapshot requires FULL review for '${reviewType}': ${fullFallbackReason}.`
                    : options.classification.source === 'delta'
                        ? `Frozen remediation mode policy does not permit DELTA for invalidated lane '${reviewType}'; FULL review is required.`
                        : `Runtime remediation classification '${category}' invalidated '${reviewType}': `
                            + `${fullFallbackReason || 'authenticated DELTA authority is unavailable'}; `
                            + 'FULL review is required.';
            if (acceptedEvidence && evidenceKind === 'FRESH') {
                satisfied = true;
                satisfactionSource = 'FRESH';
                satisfiedReviewTypes.push(reviewType);
                reasonCode = deltaEligible
                    ? 'authenticated_delta_fresh_review_satisfied'
                    : 'runtime_full_fresh_review_satisfied';
                reason = deltaEligible
                    ? `Fresh authenticated review evidence satisfied bounded DELTA remediation for '${reviewType}'.`
                    : `Fresh authenticated review evidence satisfied the FULL fallback for '${reviewType}'.`;
            } else if (receipt) {
                rejectedReuseReviewTypes.push(reviewType);
            }
        } else if (acceptedEvidence) {
            reuseEligible = true;
            satisfied = true;
            satisfactionSource = evidenceKind;
            satisfiedReviewTypes.push(reviewType);
            if (evidenceKind === 'REUSED') {
                mode = 'REUSE';
                reasonCode = 'authoritative_reuse_accepted';
                reason = `Authoritative reuse validation accepted satisfied current-cycle evidence for '${reviewType}'.`;
                reusedReviewTypes.push(reviewType);
            } else {
                mode = 'FULL';
                reasonCode = 'authoritative_fresh_review_satisfied';
                reason = `Fresh authenticated FULL review evidence satisfied '${reviewType}' without reuse.`;
            }
        } else {
            mode = 'FULL';
            reuseEligible = true;
            reasonCode = receipt ? 'authoritative_reuse_rejected' : 'authoritative_reuse_pending';
            reason = receipt
                ? `Authoritative reuse validation rejected '${reviewType}': ${String(receipt.reason || 'accepted satisfied reuse evidence is unavailable')}. FULL review is required.`
                : `Authoritative reuse validation has not accepted '${reviewType}'; FULL is the fail-closed fallback until build-review-context proves reuse.`;
            if (receipt) {
                rejectedReuseReviewTypes.push(reviewType);
            }
        }
        const dependsOn = dependencyEdges.find((edge) => edge.review_type === reviewType)?.depends_on ?? [];
        const invalidatedDownstreamReviewTypes = invalidated
            ? requiredReviewTypes.filter((candidate) => {
                const candidateDependencies = dependencyEdges.find((edge) => edge.review_type === candidate)?.depends_on ?? [];
                return candidate !== reviewType
                    && invalidatedSet.has(candidate)
                    && candidateDependencies.includes(reviewType);
            })
            : [];
        const laneWithoutHash: Omit<ReviewRemediationLaneDecision, 'reason_sha256'> = {
            review_type: reviewType,
            mode,
            reuse_eligible: reuseEligible,
            satisfied,
            satisfaction_source: satisfactionSource,
            invalidated,
            depends_on: dependsOn,
            invalidated_downstream_review_types: invalidatedDownstreamReviewTypes,
            reason_code: reasonCode,
            reason
        };
        return {
            ...laneWithoutHash,
            reason_sha256: buildReasonSha256(laneWithoutHash)
        };
    });
    const decisionWithoutHash: Omit<AuthoritativeReviewRemediationDecision, 'decision_sha256'> = {
        schema_version: 1,
        status: 'READY',
        task_id: taskId,
        current_review_type: currentReviewType,
        classification_source: options.classification.source,
        classification_sha256: classificationSha256,
        category,
        profile_policy_snapshot_sha256: profilePolicySnapshotSha256,
        policy_id: policyId,
        policy_legacy_fallback: policyLegacyFallback,
        invalidated_review_types: requiredReviewTypes.filter((reviewType) => invalidatedSet.has(reviewType)),
        preserved_review_types: requiredReviewTypes.filter((reviewType) => !invalidatedSet.has(reviewType)),
        reused_review_types: reusedReviewTypes,
        satisfied_review_types: satisfiedReviewTypes,
        rejected_reuse_review_types: rejectedReuseReviewTypes,
        dependency_edges: dependencyEdges,
        lane_decisions: laneDecisions,
        blocked_reasons: []
    };
    return {
        ...decisionWithoutHash,
        decision_sha256: sha256RedactedJsonPayload(decisionWithoutHash as unknown as Record<string, unknown>)
    };
}

function resolveCompletedReviewTypes(
    options: {
        receipts: readonly ReviewRemediationCompletedReceipt[];
        taskId: string;
        requiredReviewTypes: readonly string[];
        reusedReviewTypes: ReadonlySet<string>;
        expectedDeltaClassificationSha256: string;
        expectedValidationEvidenceSha256: string;
        reviewContextSha256ByType: Partial<Record<string, string>>;
        reviewsRoot: string;
        artifactStateReader: ReviewRemediationValidationArtifactStateReader;
    }
): string[] {
    const completed: string[] = [];
    for (const receipt of options.receipts) {
        const reviewType = normalizeReviewType(receipt.review_type, 'completed receipt review_type');
        if (completed.includes(reviewType)) {
            throw new Error(`Completed receipt '${reviewType}' is duplicated.`);
        }
        if (!options.requiredReviewTypes.includes(reviewType)) {
            throw new Error(`Completed review '${reviewType}' is not currently required.`);
        }
        if (options.reusedReviewTypes.has(reviewType)) {
            throw new Error(`Completed review '${reviewType}' cannot also be a reused receipt.`);
        }
        if (
            receipt.schema_version !== 1
            || receipt.task_id !== options.taskId
            || receipt.status !== 'ACCEPTED'
            || receipt.findings_satisfied !== true
        ) {
            throw new Error(`Completed receipt '${reviewType}' is not accepted satisfied evidence for this task.`);
        }
        const reviewContextSha256 = normalizeSha256(
            receipt.review_context_sha256,
            `completed receipt '${reviewType}' review_context_sha256`
        );
        const expectedReviewContextSha256 = normalizeSha256(
            options.reviewContextSha256ByType[reviewType],
            `current review context '${reviewType}' hash`
        );
        if (reviewContextSha256 !== expectedReviewContextSha256) {
            throw new Error(`Completed receipt '${reviewType}' is not bound to the current review context.`);
        }
        if (
            normalizeSha256(
                receipt.delta_classification_sha256,
                `completed receipt '${reviewType}' delta_classification_sha256`
            ) !== options.expectedDeltaClassificationSha256
            || normalizeSha256(
                receipt.validation_evidence_sha256,
                `completed receipt '${reviewType}' validation_evidence_sha256`
            ) !== options.expectedValidationEvidenceSha256
        ) {
            throw new Error(`Completed receipt '${reviewType}' is not bound to the current remediation cycle.`);
        }
        const receiptArtifactPath = String(receipt.receipt_artifact_path || '').replace(/\\/gu, '/');
        const reviewsRoot = options.reviewsRoot.replace(/\\/gu, '/').replace(/\/$/u, '');
        if (
            receipt.receipt_artifact_path !== receiptArtifactPath
            || !receiptArtifactPath.startsWith(`${reviewsRoot}/`)
            || !receiptArtifactPath.slice(reviewsRoot.length + 1).startsWith(`${options.taskId}-`)
            || receiptArtifactPath.split('/').some((segment) => segment === '.' || segment === '..')
        ) {
            throw new Error(`Completed receipt '${reviewType}' artifact path is not task-owned.`);
        }
        const receiptArtifactSha256 = normalizeSha256(
            receipt.receipt_artifact_sha256,
            `completed receipt '${reviewType}' receipt_artifact_sha256`
        );
        const artifactState = options.artifactStateReader(receiptArtifactPath);
        if (!artifactState || artifactState.sha256 !== receiptArtifactSha256) {
            throw new Error(`Completed receipt '${reviewType}' does not match authenticated artifact state.`);
        }
        completed.push(reviewType);
    }
    return options.requiredReviewTypes.filter((reviewType) => completed.includes(reviewType));
}

function withoutRoutingHash(route: Omit<ReviewRemediationRecoveryRoute, 'routing_sha256'>): Record<string, unknown> {
    return route as unknown as Record<string, unknown>;
}

export function buildReviewRemediationRecoveryRoute(
    options: BuildReviewRemediationRecoveryRouteOptions
): ReviewRemediationRecoveryRoute {
    const taskId = String(options.taskId || '').trim();
    if (!taskId || options.taskId !== taskId) {
        throw new Error('Review remediation recovery routing requires a canonical task id.');
    }
    const currentReviewType = normalizeReviewType(options.currentReviewType, 'current review type');
    const authoritativeDecision = resolveAuthoritativeReviewRemediationDecision({
        taskId,
        currentReviewType,
        classification: {
            source: 'delta',
            delta: options.delta,
            profilePolicySnapshot: options.profilePolicySnapshot,
            baselineProfilePolicySnapshotSha256: options.baselineProfilePolicySnapshotSha256
        },
        requiredReviews: options.requiredReviews,
        reviewExecutionPolicyMode: options.reviewExecutionPolicyMode,
        reviewDependencyGraph: options.reviewDependencyGraph,
        modePolicyValidationInputs: options.modePolicyValidationInputs,
        reusableReceipts: options.reusableReceipts
    });
    if (authoritativeDecision.status === 'BLOCKED') {
        throw new Error(
            `Review remediation authoritative decision is blocked: ${authoritativeDecision.blocked_reasons.join(' ')}`
        );
    }
    const profilePolicySnapshotSha256 = String(authoritativeDecision.profile_policy_snapshot_sha256);
    const requiredReviewTypes = authoritativeDecision.lane_decisions.map((entry) => entry.review_type);
    const invalidatedReviewTypes = authoritativeDecision.invalidated_review_types;
    const preservedReviewTypes = authoritativeDecision.preserved_review_types;
    const reusedSet = new Set(authoritativeDecision.reused_review_types);
    const reviewRequiredTypes = requiredReviewTypes.filter((reviewType) => !reusedSet.has(reviewType));
    const dependencyEdges = authoritativeDecision.dependency_edges
        .filter((edge) => reviewRequiredTypes.includes(edge.review_type));
    const validationRequirement = buildReviewRemediationValidationRequirement(options.delta.category);
    const validationRoute = validationRouteForRequirement(validationRequirement);
    let validationEvidenceSha256: string | null = null;
    let completedReviewTypes: string[] = [];
    let status: ReviewRemediationRecoveryRoute['status'];
    let nextAction: ReviewRemediationRecoveryNextAction | null;
    let reason: string;

    if (!options.validationEvidence) {
        status = 'VALIDATION_REQUIRED';
        nextAction = {
            kind: 'validation',
            target: validationRoute,
            command: requireCommand(
                options.validationCommands[validationRoute],
                `${validationRoute} validation route`
            )
        };
        reason = `Remediation category '${options.delta.category}' requires '${validationRequirement}' validation before any affected review lane.`;
    } else {
        if (!options.reviewsRoot || !options.artifactStateReader) {
            throw new Error('Review remediation validation evidence requires reviewsRoot and artifactStateReader.');
        }
        const validation = validateReviewRemediationValidationEvidence(options.validationEvidence, {
            reviewsRoot: options.reviewsRoot,
            artifactStateReader: options.artifactStateReader,
            taskId,
            reviewType: currentReviewType,
            deltaCategory: options.delta.category,
            baselineArtifactSha256: options.delta.baseline.artifact_sha256,
            deltaClassificationSha256: options.delta.classification_sha256
        });
        if (!validation.valid) {
            throw new Error(`Review remediation validation evidence is invalid: ${validation.violations.join(' ')}`);
        }
        validationEvidenceSha256 = sha256RedactedJsonPayload(options.validationEvidence);
        completedReviewTypes = resolveCompletedReviewTypes({
            receipts: options.completedReceipts ?? [],
            taskId,
            requiredReviewTypes,
            reusedReviewTypes: reusedSet,
            expectedDeltaClassificationSha256: options.delta.classification_sha256,
            expectedValidationEvidenceSha256: validationEvidenceSha256,
            reviewContextSha256ByType: options.reviewContextSha256ByType ?? {},
            reviewsRoot: options.reviewsRoot,
            artifactStateReader: options.artifactStateReader
        });
        const completedSet = new Set(completedReviewTypes);
        const pendingReviewTypes = reviewRequiredTypes.filter((reviewType) => !completedSet.has(reviewType));
        if (pendingReviewTypes.length === 0) {
            status = 'COMPLETE';
            nextAction = null;
            reason = 'Selective validation is satisfied and every required review lane is fresh or safely reused.';
        } else {
            const satisfiedReviewTypes = new Set([
                ...authoritativeDecision.reused_review_types,
                ...completedReviewTypes
            ]);
            const nextReviewType = pendingReviewTypes.find((reviewType) => {
                const edge = dependencyEdges.find((candidate) => candidate.review_type === reviewType);
                return (edge?.depends_on ?? []).every((dependency) => satisfiedReviewTypes.has(dependency));
            });
            if (!nextReviewType) {
                throw new Error('Review remediation dependency order has no executable next review lane.');
            }
            status = 'REVIEW_REQUIRED';
            nextAction = {
                kind: 'review',
                target: nextReviewType,
                command: requireCommand(
                    options.reviewCommands[nextReviewType],
                    `review route '${nextReviewType}'`
                )
            };
            reason = `Selective validation is satisfied; '${nextReviewType}' is the first dependency-ready review lane.`;
        }
    }

    const routeWithoutHash: Omit<ReviewRemediationRecoveryRoute, 'routing_sha256'> = {
        schema_version: 1,
        status,
        task_id: taskId,
        review_type: currentReviewType,
        delta_category: options.delta.category,
        delta_classification_sha256: options.delta.classification_sha256,
        profile_policy_snapshot_sha256: profilePolicySnapshotSha256,
        policy_id: authoritativeDecision.policy_id,
        policy_legacy_fallback: authoritativeDecision.policy_legacy_fallback,
        validation_requirement: validationRequirement,
        validation_route: validationRoute,
        validation_evidence_sha256: validationEvidenceSha256,
        invalidated_review_types: invalidatedReviewTypes,
        preserved_review_types: preservedReviewTypes,
        reused_review_types: authoritativeDecision.reused_review_types,
        rejected_reuse_review_types: authoritativeDecision.rejected_reuse_review_types,
        review_required_types: reviewRequiredTypes,
        completed_review_types: completedReviewTypes,
        dependency_edges: dependencyEdges,
        authoritative_decision: authoritativeDecision,
        next_action: nextAction,
        reason
    };
    return {
        ...routeWithoutHash,
        routing_sha256: sha256RedactedJsonPayload(withoutRoutingHash(routeWithoutHash))
    };
}
