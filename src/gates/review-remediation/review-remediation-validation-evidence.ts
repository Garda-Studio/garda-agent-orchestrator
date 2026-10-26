import { countNextStepWork } from '../../core/next-step-measurement';
import { createHash } from 'node:crypto';

import { sha256RedactedJsonPayload } from '../../core/redaction';
import { isPlainRecord } from '../../core/records';
import {
    REVIEW_REMEDIATION_DELTA_CATEGORIES,
    type ReviewRemediationDeltaCategory
} from '../../policy/review-remediation-rerun-policy';
import { normalizePath } from '../shared/helpers';
import {
    type ReviewRemediationDeltaClassification
} from './review-remediation-delta';
import {
    isReviewRemediationReadableDiffPayloadRedacted,
    REVIEW_REMEDIATION_DELTA_DIFF_PAGE_MAX_BYTES,
    sha256ReviewRemediationReadableDiffPayload
} from './review-remediation-readable-diff';

export const REVIEW_REMEDIATION_VALIDATION_EVIDENCE_SCHEMA_VERSION = 1;
export const REVIEW_REMEDIATION_VALIDATION_EVIDENCE_ARTIFACT_TYPE =
    'review_remediation_selective_validation_evidence';
export const REVIEW_REMEDIATION_VALIDATION_EVIDENCE_RECEIPT_KIND =
    'selective_remediation_validation';

export type ReviewRemediationValidationRequirement =
    | 'focused'
    | 'focused_and_affected'
    | 'expanded_or_full';

export type ReviewRemediationValidationComponentRole =
    | 'focused'
    | 'affected'
    | 'expanded'
    | 'full';

export type ReviewRemediationValidationComponentSource =
    | 'intermediate_command'
    | 'full_suite_validation';

export interface ReviewRemediationValidationBindings {
    baseline_artifact_path: string;
    baseline_artifact_sha256: string;
    baseline_review_tree_state_sha256: string;
    baseline_delta_base_snapshot_sha256: string;
    delta_classification_sha256: string;
    delta_current_snapshot_sha256: string;
}

export interface ReviewRemediationValidationComponent {
    role: ReviewRemediationValidationComponentRole;
    source_kind: ReviewRemediationValidationComponentSource;
    command: string;
    command_sha256: string;
    status: 'PASSED';
    exit_code: 0;
    source_artifact_path: string;
    source_artifact_sha256: string;
    output_artifact_path: string | null;
    output_artifact_sha256: string | null;
    output_artifact_size_bytes: number | null;
    remediation_binding_sha256: string;
    component_sha256: string;
}

export interface ReviewRemediationValidationEvidence {
    schema_version: 1;
    artifact_type: typeof REVIEW_REMEDIATION_VALIDATION_EVIDENCE_ARTIFACT_TYPE;
    receipt_kind: typeof REVIEW_REMEDIATION_VALIDATION_EVIDENCE_RECEIPT_KIND;
    is_full_suite_receipt: false;
    task_id: string;
    review_type: string;
    delta_category: ReviewRemediationDeltaCategory;
    validation_requirement: ReviewRemediationValidationRequirement;
    remediation_bindings: ReviewRemediationValidationBindings;
    remediation_binding_sha256: string;
    components: ReviewRemediationValidationComponent[];
    components_sha256: string;
    validation_result_sha256: string;
}

export interface BuildReviewRemediationValidationComponentInput {
    role: ReviewRemediationValidationComponentRole;
    sourceKind: ReviewRemediationValidationComponentSource;
    command: string;
    status: 'PASSED';
    exitCode: 0;
    sourceArtifactPath: string;
    sourceArtifactSha256: string;
    outputArtifactPath?: string | null;
    outputArtifactSha256?: string | null;
    outputArtifactSizeBytes?: number | null;
}

export interface BuildReviewRemediationValidationEvidenceOptions {
    reviewsRoot: string;
    artifactStateReader: ReviewRemediationValidationArtifactStateReader;
    delta: ReviewRemediationDeltaClassification;
    components: readonly BuildReviewRemediationValidationComponentInput[];
}

export interface ReviewRemediationValidationEvidenceExpectations {
    reviewsRoot: string;
    artifactStateReader: ReviewRemediationValidationArtifactStateReader;
    taskId?: string;
    reviewType?: string;
    deltaCategory?: ReviewRemediationDeltaCategory;
    baselineArtifactSha256?: string;
    deltaClassificationSha256?: string;
}

export interface ReviewRemediationValidationArtifactState {
    sha256: string;
    size_bytes: number;
    source_kind?: ReviewRemediationValidationComponentSource;
    command?: string;
    status?: string;
    exit_code?: number;
}

export type ReviewRemediationValidationArtifactStateReader = (
    artifactPath: string
) => ReviewRemediationValidationArtifactState | null;

export interface ReviewRemediationValidationEvidenceResult {
    valid: boolean;
    evidence: ReviewRemediationValidationEvidence | null;
    violations: string[];
}

const EVIDENCE_KEYS = [
    'schema_version',
    'artifact_type',
    'receipt_kind',
    'is_full_suite_receipt',
    'task_id',
    'review_type',
    'delta_category',
    'validation_requirement',
    'remediation_bindings',
    'remediation_binding_sha256',
    'components',
    'components_sha256',
    'validation_result_sha256'
] as const;

const BINDING_KEYS = [
    'baseline_artifact_path',
    'baseline_artifact_sha256',
    'baseline_review_tree_state_sha256',
    'baseline_delta_base_snapshot_sha256',
    'delta_classification_sha256',
    'delta_current_snapshot_sha256'
] as const;

const COMPONENT_KEYS = [
    'role',
    'source_kind',
    'command',
    'command_sha256',
    'status',
    'exit_code',
    'source_artifact_path',
    'source_artifact_sha256',
    'output_artifact_path',
    'output_artifact_sha256',
    'output_artifact_size_bytes',
    'remediation_binding_sha256',
    'component_sha256'
] as const;

const COMPONENT_ROLES: readonly ReviewRemediationValidationComponentRole[] = [
    'focused',
    'affected',
    'expanded',
    'full'
];

const COMPONENT_SOURCES: readonly ReviewRemediationValidationComponentSource[] = [
    'intermediate_command',
    'full_suite_validation'
];

function isSha256(value: unknown): value is string {
    return typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);
}

function assertExactKeys(
    value: Record<string, unknown>,
    expected: readonly string[],
    label: string,
    violations: string[]
): void {
    for (const key of expected) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) {
            violations.push(`${label}.${key} is required.`);
        }
    }
    for (const key of Object.keys(value)) {
        if (!expected.includes(key)) {
            violations.push(`${label}.${key} is not allowed.`);
        }
    }
}

function withoutHash<T extends Record<string, unknown>>(value: T, hashKey: keyof T): Record<string, unknown> {
    return Object.fromEntries(Object.entries(value).filter(([key]) => (countNextStepWork('visit:review-remediation-validation-evidence:event:206'), key !== hashKey)));
}

function validateCanonicalPath(value: unknown, label: string, violations: string[]): string | null {
    if (typeof value !== 'string' || !value.trim()) {
        violations.push(`${label} must be a non-empty path.`);
        return null;
    }
    const normalized = normalizePath(value);
    if (value !== normalized) {
        violations.push(`${label} must use canonical normalized path '${normalized}'.`);
    }
    if (normalized.split('/').some((segment) => segment === '.' || segment === '..')) {
        violations.push(`${label} must not contain '.' or '..' path segments.`);
    }
    return normalized;
}

function validateTaskOwnedArtifactPath(
    value: unknown,
    label: string,
    reviewsRoot: string,
    taskId: string,
    violations: string[]
): string | null {
    const normalized = validateCanonicalPath(value, label, violations);
    if (!normalized || !reviewsRoot) {
        return null;
    }
    const rootPrefix = `${reviewsRoot.replace(/\/$/u, '')}/`;
    if (!normalized.toLowerCase().startsWith(rootPrefix.toLowerCase())) {
        violations.push(`${label} must remain inside task-owned reviews root '${reviewsRoot}'.`);
        return null;
    }
    const basename = normalized.slice(normalized.lastIndexOf('/') + 1);
    if (!basename.startsWith(`${taskId}-`)) {
        violations.push(`${label} must name an artifact owned by task '${taskId}'.`);
        return null;
    }
    return normalized;
}

function validateAuthenticatedArtifactState(options: {
    artifactPath: string | null;
    expectedSha256: unknown;
    expectedSizeBytes?: unknown;
    expectedSourceKind?: ReviewRemediationValidationComponentSource;
    expectedCommand?: string;
    expectedStatus?: 'PASSED';
    expectedExitCode?: 0;
    label: string;
    artifactStateReader: ReviewRemediationValidationArtifactStateReader;
    violations: string[];
}): void {
    if (!options.artifactPath || !isSha256(options.expectedSha256)) {
        return;
    }
    let state: ReviewRemediationValidationArtifactState | null;
    try {
        state = options.artifactStateReader(options.artifactPath);
    } catch (error: unknown) {
        options.violations.push(
            `${options.label} artifact state read failed: ${error instanceof Error ? error.message : String(error)}.`
        );
        return;
    }
    if (!state) {
        options.violations.push(`${options.label} artifact is missing or unreadable.`);
        return;
    }
    if (!isSha256(state.sha256) || state.sha256 !== options.expectedSha256) {
        options.violations.push(`${options.label} artifact sha256 does not match authenticated state.`);
    }
    if (
        options.expectedSizeBytes !== undefined
        && (!Number.isSafeInteger(state.size_bytes) || state.size_bytes !== options.expectedSizeBytes)
    ) {
        options.violations.push(`${options.label} artifact size does not match authenticated state.`);
    }
    if (
        options.expectedSourceKind !== undefined
        && state.source_kind !== options.expectedSourceKind
    ) {
        options.violations.push(`${options.label} source kind does not match authenticated state.`);
    }
    if (options.expectedCommand !== undefined && state.command !== options.expectedCommand) {
        options.violations.push(`${options.label} command does not match authenticated state.`);
    }
    if (options.expectedStatus !== undefined && state.status !== options.expectedStatus) {
        options.violations.push(`${options.label} status does not match authenticated state.`);
    }
    if (options.expectedExitCode !== undefined && state.exit_code !== options.expectedExitCode) {
        options.violations.push(`${options.label} exit code does not match authenticated state.`);
    }
}

function validateHash(value: unknown, label: string, violations: string[]): string | null {
    if (!isSha256(value)) {
        violations.push(`${label} must be a lowercase SHA-256 hex value.`);
        return null;
    }
    return value;
}

export function buildReviewRemediationValidationRequirement(
    category: ReviewRemediationDeltaCategory
): ReviewRemediationValidationRequirement {
    if (!REVIEW_REMEDIATION_DELTA_CATEGORIES.includes(category)) {
        throw new Error(`Unknown review remediation validation category '${String(category)}'.`);
    }
    if (category === 'leaf_test') {
        return 'focused';
    }
    if (category === 'structural_test') {
        return 'focused_and_affected';
    }
    return 'expanded_or_full';
}

function requiredRoleSequences(
    requirement: ReviewRemediationValidationRequirement
): readonly (readonly ReviewRemediationValidationComponentRole[])[] {
    if (requirement === 'focused') {
        return [['focused']];
    }
    if (requirement === 'focused_and_affected') {
        return [['focused', 'affected']];
    }
    return [['expanded'], ['full']];
}

function rolesSatisfyRequirement(
    roles: readonly ReviewRemediationValidationComponentRole[],
    requirement: ReviewRemediationValidationRequirement
): boolean {
    return requiredRoleSequences(requirement).some((sequence) => (
        sequence.length === roles.length && sequence.every((role, index) => role === roles[index])
    ));
}

export function getReviewRemediationDeltaClassificationViolations(
    delta: ReviewRemediationDeltaClassification
): string[] {
    const violations: string[] = [];
    if (delta.schema_version !== 1 || delta.status !== 'CLASSIFIED') {
        violations.push('delta must be a schema v1 CLASSIFIED remediation delta.');
    }
    const taskId = String(delta.task_id || '').trim();
    const reviewType = String(delta.review_type || '').trim().toLowerCase();
    if (!taskId || delta.task_id !== taskId) {
        violations.push('delta.task_id must be non-empty and canonical.');
    }
    if (!reviewType || delta.review_type !== reviewType) {
        violations.push('delta.review_type must be non-empty lowercase text.');
    }
    if (!REVIEW_REMEDIATION_DELTA_CATEGORIES.includes(delta.category)) {
        violations.push(`delta.category '${String(delta.category)}' is unsupported.`);
    }
    if (typeof delta.full_review_required !== 'boolean') {
        violations.push('delta.full_review_required must be boolean.');
    }
    if (
        !Array.isArray(delta.full_review_reasons)
        || delta.full_review_reasons.some((reason) => typeof reason !== 'string' || !reason.trim())
    ) {
        violations.push('delta.full_review_reasons must contain canonical non-empty strings.');
    } else if (delta.full_review_required !== (delta.full_review_reasons.length > 0)) {
        violations.push('delta.full_review_required must agree with full_review_reasons.');
    }
    if (delta.mode_policy_assessment !== undefined) {
        const assessment = delta.mode_policy_assessment;
        if (!isPlainRecord(assessment)) {
            violations.push('delta.mode_policy_assessment must be a JSON object.');
        } else {
            const { assessment_sha256: _, ...assessmentWithoutHash } = assessment;
            if (
                !/^[0-9a-f]{64}$/u.test(String(assessment.assessment_sha256 || ''))
                || assessment.assessment_sha256 !== sha256RedactedJsonPayload(assessmentWithoutHash)
            ) {
                violations.push('delta.mode_policy_assessment hash is invalid.');
            }
            if (!['FULL', 'DELTA'].includes(String(assessment.mode || ''))) {
                violations.push('delta.mode_policy_assessment mode must be FULL or DELTA.');
            }
            if (
                assessment.mode === 'FULL'
                && delta.full_review_required !== true
            ) {
                violations.push('delta.mode_policy_assessment FULL requires delta.full_review_required=true.');
            }
            if (
                assessment.mode === 'DELTA'
                && delta.full_review_required === true
            ) {
                violations.push('delta.mode_policy_assessment DELTA cannot accompany a FULL classification.');
            }
            if (
                !Array.isArray(assessment.full_review_reasons)
                || JSON.stringify(assessment.full_review_reasons) !== JSON.stringify(delta.full_review_reasons)
            ) {
                violations.push('delta.mode_policy_assessment reasons must match delta.full_review_reasons.');
            }
        }
    }
    const normalizePathList = (value: unknown): string[] | null => {
        if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
            return null;
        }
        const normalized = [...new Set(value.map((entry) => normalizePath(entry)).filter(Boolean))].sort();
        return JSON.stringify(normalized) === JSON.stringify(value) ? normalized : null;
    };
    const scope = delta.scope;
    const fullReviewScope = normalizePathList(scope?.full_review_scope);
    const requiredDeltaTargets = normalizePathList(scope?.required_delta_targets);
    const optionalContextFiles = normalizePathList(scope?.optional_context_files);
    if (!fullReviewScope || !requiredDeltaTargets || !optionalContextFiles) {
        violations.push('delta.scope path lists must be normalized, unique, and sorted.');
    } else {
        const combinedScope = [...new Set([...requiredDeltaTargets, ...optionalContextFiles])].sort();
        if (JSON.stringify(combinedScope) !== JSON.stringify(fullReviewScope)) {
            violations.push('delta.scope required targets and optional context must partition the full review scope.');
        }
        if (JSON.stringify(requiredDeltaTargets) !== JSON.stringify(delta.changed_files)) {
            violations.push('delta.scope.required_delta_targets must match delta.changed_files.');
        }
        if (JSON.stringify(optionalContextFiles) !== JSON.stringify(delta.unchanged_files)) {
            violations.push('delta.scope.optional_context_files must match delta.unchanged_files.');
        }
        const hashList = (value: readonly string[]): string => createHash('sha256').update(value.join('\n')).digest('hex');
        if (scope.full_review_scope_sha256 !== hashList(fullReviewScope)) {
            violations.push('delta.scope.full_review_scope_sha256 does not match full_review_scope.');
        }
        if (scope.required_delta_targets_sha256 !== hashList(requiredDeltaTargets)) {
            violations.push('delta.scope.required_delta_targets_sha256 does not match required_delta_targets.');
        }
        if (scope.optional_context_files_sha256 !== hashList(optionalContextFiles)) {
            violations.push('delta.scope.optional_context_files_sha256 does not match optional_context_files.');
        }
        if (typeof scope.membership_unchanged !== 'boolean') {
            violations.push('delta.scope.membership_unchanged must be boolean.');
        } else if (!scope.membership_unchanged && delta.full_review_required !== true) {
            violations.push(
                'delta.scope.membership_unchanged=false requires delta.full_review_required=true.'
            );
        }
    }
    const readableDiff = delta.readable_diff;
    if (
        !readableDiff
        || readableDiff.schema_version !== 1
        || readableDiff.format !== 'redacted_line_operations_v1'
        || readableDiff.page_max_bytes !== REVIEW_REMEDIATION_DELTA_DIFF_PAGE_MAX_BYTES
        || !Array.isArray(readableDiff.pages)
        || readableDiff.page_count !== readableDiff.pages.length
    ) {
        violations.push('delta.readable_diff must be canonical paged redacted-line evidence.');
    } else {
        const readableOperationsByPath = new Map<string, Set<string>>();
        for (const [index, page] of readableDiff.pages.entries()) {
            countNextStepWork('visit:review-remediation-validation-evidence:event:464');
            const { page_sha256: pageSha256, ...pageWithoutHash } = page;
            const normalizedPagePath = normalizePath(page.path);
            if (!normalizedPagePath || normalizedPagePath !== page.path) {
                violations.push(`delta.readable_diff.pages[${index}].path must be canonical.`);
            }
            const operations = readableOperationsByPath.get(normalizedPagePath) ?? new Set<string>();
            for (const line of page.lines) {
                if (line.operation === 'addition' || line.operation === 'deletion') {
                    operations.add([
                        line.operation,
                        line.baseline_line,
                        line.current_line,
                        line.source_line_sha256
                    ].join(':'));
                }
            }
            readableOperationsByPath.set(normalizedPagePath, operations);
            if (page.page_number !== index + 1 || page.page_count !== readableDiff.pages.length) {
                violations.push(`delta.readable_diff.pages[${index}] has invalid pagination.`);
            }
            if (
                !Number.isInteger(page.utf8_bytes)
                || page.utf8_bytes < 0
                || page.utf8_bytes > REVIEW_REMEDIATION_DELTA_DIFF_PAGE_MAX_BYTES
                || page.utf8_bytes !== page.lines.reduce(
                    (total, line) => total + Buffer.byteLength(String(line.text || ''), 'utf8'),
                    0
                )
            ) {
                violations.push(`delta.readable_diff.pages[${index}].utf8_bytes is invalid.`);
            }
            if (!isReviewRemediationReadableDiffPayloadRedacted(pageWithoutHash)) {
                violations.push(`delta.readable_diff.pages[${index}] must contain only redacted text.`);
            }
            if (sha256ReviewRemediationReadableDiffPayload(pageWithoutHash) !== pageSha256) {
                violations.push(`delta.readable_diff.pages[${index}].page_sha256 does not match the page payload.`);
            }
        }
        const { evidence_sha256: evidenceSha256, ...evidenceWithoutHash } = readableDiff;
        if (!isReviewRemediationReadableDiffPayloadRedacted(evidenceWithoutHash)) {
            violations.push('delta.readable_diff must contain only redacted text.');
        }
        if (sha256ReviewRemediationReadableDiffPayload(evidenceWithoutHash) !== evidenceSha256) {
            violations.push('delta.readable_diff.evidence_sha256 does not match the readable diff payload.');
        }
        const fileDeltaPaths = normalizePathList(delta.file_deltas?.map((entry) => entry.path));
        if (!fileDeltaPaths || JSON.stringify(fileDeltaPaths) !== JSON.stringify(delta.changed_files)) {
            violations.push('delta.file_deltas paths must match delta.changed_files.');
        } else {
            const changedFileSet = new Set(fileDeltaPaths);
            for (const pagePath of readableOperationsByPath.keys()) {
                if (!changedFileSet.has(pagePath)) {
                    violations.push(`delta.readable_diff path '${pagePath}' must identify a changed file.`);
                }
            }
            for (const fileDelta of delta.file_deltas) {
                const additions = fileDelta.additions;
                const deletions = fileDelta.deletions;
                const changedLines = fileDelta.changed_lines;
                if (
                    additions === null
                    || deletions === null
                    || changedLines === null
                    || !Number.isInteger(additions)
                    || additions < 0
                    || !Number.isInteger(deletions)
                    || deletions < 0
                    || !Number.isInteger(changedLines)
                    || changedLines < 0
                    || changedLines !== additions + deletions
                ) {
                    if (additions !== null || deletions !== null || changedLines !== null) {
                        violations.push(`delta.file_deltas '${fileDelta.path}' line totals must be all null or canonical non-negative integers.`);
                    }
                    continue;
                }
                const operations = readableOperationsByPath.get(fileDelta.path) ?? new Set<string>();
                const actualAdditions = [...operations].filter((entry) => entry.startsWith('addition:')).length;
                const actualDeletions = [...operations].filter((entry) => entry.startsWith('deletion:')).length;
                if (actualAdditions !== additions || actualDeletions !== deletions) {
                    violations.push(
                        `delta.readable_diff operations for '${fileDelta.path}' must match delta.file_deltas line totals.`
                    );
                }
            }
        }
    }
    validateCanonicalPath(delta.baseline?.artifact_path, 'delta.baseline.artifact_path', violations);
    validateHash(delta.baseline?.artifact_sha256, 'delta.baseline.artifact_sha256', violations);
    validateHash(
        delta.baseline?.review_tree_state_sha256,
        'delta.baseline.review_tree_state_sha256',
        violations
    );
    validateHash(
        delta.baseline?.delta_base_snapshot_sha256,
        'delta.baseline.delta_base_snapshot_sha256',
        violations
    );
    validateHash(delta.current_snapshot_sha256, 'delta.current_snapshot_sha256', violations);
    const classificationHash = validateHash(
        delta.classification_sha256,
        'delta.classification_sha256',
        violations
    );
    if (
        classificationHash
        && sha256RedactedJsonPayload(withoutHash(
            delta as unknown as Record<string, unknown>,
            'classification_sha256'
        )) !== classificationHash
    ) {
        violations.push('delta.classification_sha256 does not match the delta payload.');
    }
    return violations;
}

function buildBindings(delta: ReviewRemediationDeltaClassification): ReviewRemediationValidationBindings {
    return {
        baseline_artifact_path: normalizePath(delta.baseline.artifact_path),
        baseline_artifact_sha256: delta.baseline.artifact_sha256,
        baseline_review_tree_state_sha256: delta.baseline.review_tree_state_sha256,
        baseline_delta_base_snapshot_sha256: delta.baseline.delta_base_snapshot_sha256,
        delta_classification_sha256: delta.classification_sha256,
        delta_current_snapshot_sha256: delta.current_snapshot_sha256
    };
}

function buildComponent(
    input: BuildReviewRemediationValidationComponentInput,
    remediationBindingSha256: string
): ReviewRemediationValidationComponent {
    const outputPath = input.outputArtifactPath == null
        ? null
        : normalizePath(input.outputArtifactPath);
    const componentCore = {
        role: input.role,
        source_kind: input.sourceKind,
        command: input.command,
        command_sha256: sha256RedactedJsonPayload(input.command),
        status: input.status,
        exit_code: input.exitCode,
        source_artifact_path: normalizePath(input.sourceArtifactPath),
        source_artifact_sha256: input.sourceArtifactSha256,
        output_artifact_path: outputPath,
        output_artifact_sha256: input.outputArtifactSha256 ?? null,
        output_artifact_size_bytes: input.outputArtifactSizeBytes ?? null,
        remediation_binding_sha256: remediationBindingSha256
    };
    return {
        ...componentCore,
        component_sha256: sha256RedactedJsonPayload(componentCore)
    };
}

function validationResultPayload(
    evidence: Omit<ReviewRemediationValidationEvidence, 'validation_result_sha256'>
): Record<string, unknown> {
    return evidence as unknown as Record<string, unknown>;
}

export function buildReviewRemediationValidationEvidence(
    options: BuildReviewRemediationValidationEvidenceOptions
): ReviewRemediationValidationEvidence {
    const deltaViolations = getReviewRemediationDeltaClassificationViolations(options.delta);
    if (deltaViolations.length > 0) {
        throw new Error(`Review remediation validation delta is invalid: ${deltaViolations.join(' ')}`);
    }
    const requirement = buildReviewRemediationValidationRequirement(options.delta.category);
    const bindings = buildBindings(options.delta);
    const remediationBindingSha256 = sha256RedactedJsonPayload(bindings);
    const components = options.components.map((component) => buildComponent(
        component,
        remediationBindingSha256
    ));
    const evidenceCore: Omit<ReviewRemediationValidationEvidence, 'validation_result_sha256'> = {
        schema_version: REVIEW_REMEDIATION_VALIDATION_EVIDENCE_SCHEMA_VERSION,
        artifact_type: REVIEW_REMEDIATION_VALIDATION_EVIDENCE_ARTIFACT_TYPE,
        receipt_kind: REVIEW_REMEDIATION_VALIDATION_EVIDENCE_RECEIPT_KIND,
        is_full_suite_receipt: false,
        task_id: options.delta.task_id,
        review_type: options.delta.review_type,
        delta_category: options.delta.category,
        validation_requirement: requirement,
        remediation_bindings: bindings,
        remediation_binding_sha256: remediationBindingSha256,
        components,
        components_sha256: sha256RedactedJsonPayload(components)
    };
    const evidence: ReviewRemediationValidationEvidence = {
        ...evidenceCore,
        validation_result_sha256: sha256RedactedJsonPayload(validationResultPayload(evidenceCore))
    };
    const violations = getReviewRemediationValidationEvidenceViolations(evidence, {
        reviewsRoot: options.reviewsRoot,
        artifactStateReader: options.artifactStateReader
    });
    if (violations.length > 0) {
        throw new Error(`Review remediation validation evidence is invalid: ${violations.join(' ')}`);
    }
    return evidence;
}

function validateBindings(value: unknown, violations: string[]): ReviewRemediationValidationBindings | null {
    if (!isPlainRecord(value)) {
        violations.push('evidence.remediation_bindings must be a JSON object.');
        return null;
    }
    assertExactKeys(value, BINDING_KEYS, 'evidence.remediation_bindings', violations);
    validateCanonicalPath(
        value.baseline_artifact_path,
        'evidence.remediation_bindings.baseline_artifact_path',
        violations
    );
    for (const key of BINDING_KEYS.filter((key) => key !== 'baseline_artifact_path')) {
        validateHash(value[key], `evidence.remediation_bindings.${key}`, violations);
    }
    return value as unknown as ReviewRemediationValidationBindings;
}

function validateComponent(
    value: unknown,
    index: number,
    expectedBindingSha256: string,
    reviewsRoot: string,
    taskId: string,
    artifactStateReader: ReviewRemediationValidationArtifactStateReader,
    violations: string[]
): ReviewRemediationValidationComponent | null {
    const label = `evidence.components[${index}]`;
    if (!isPlainRecord(value)) {
        violations.push(`${label} must be a JSON object.`);
        return null;
    }
    assertExactKeys(value, COMPONENT_KEYS, label, violations);
    const role = String(value.role || '') as ReviewRemediationValidationComponentRole;
    const sourceKind = String(value.source_kind || '') as ReviewRemediationValidationComponentSource;
    if (!COMPONENT_ROLES.includes(role) || value.role !== role) {
        violations.push(`${label}.role is unsupported or noncanonical.`);
    }
    if (!COMPONENT_SOURCES.includes(sourceKind) || value.source_kind !== sourceKind) {
        violations.push(`${label}.source_kind is unsupported or noncanonical.`);
    }
    if (role === 'full' && sourceKind !== 'full_suite_validation') {
        violations.push(`${label} full role must use full_suite_validation source_kind.`);
    }
    if (role !== 'full' && sourceKind !== 'intermediate_command') {
        violations.push(`${label} non-full role must use intermediate_command source_kind.`);
    }
    if (typeof value.command !== 'string' || !value.command.trim() || value.command !== value.command.trim()) {
        violations.push(`${label}.command must be non-empty canonical text.`);
    }
    const commandHash = validateHash(value.command_sha256, `${label}.command_sha256`, violations);
    if (typeof value.command === 'string' && commandHash
        && sha256RedactedJsonPayload(value.command) !== commandHash) {
        violations.push(`${label}.command_sha256 does not match command.`);
    }
    if (value.status !== 'PASSED' || value.exit_code !== 0) {
        violations.push(`${label} must bind a PASSED result with exit_code 0.`);
    }
    const sourceArtifactPath = validateTaskOwnedArtifactPath(
        value.source_artifact_path,
        `${label}.source_artifact_path`,
        reviewsRoot,
        taskId,
        violations
    );
    validateHash(value.source_artifact_sha256, `${label}.source_artifact_sha256`, violations);
    validateAuthenticatedArtifactState({
        artifactPath: sourceArtifactPath,
        expectedSha256: value.source_artifact_sha256,
        expectedSourceKind: sourceKind,
        expectedCommand: typeof value.command === 'string' ? value.command : '',
        expectedStatus: 'PASSED',
        expectedExitCode: 0,
        label: `${label}.source_artifact`,
        artifactStateReader,
        violations
    });
    const outputValues = [
        value.output_artifact_path,
        value.output_artifact_sha256,
        value.output_artifact_size_bytes
    ];
    const nullOutputCount = outputValues.filter((entry) => entry === null).length;
    if (nullOutputCount !== 0 && nullOutputCount !== outputValues.length) {
        violations.push(`${label} output artifact fields must be all null or all present.`);
    } else if (nullOutputCount === 0) {
        const outputArtifactPath = validateTaskOwnedArtifactPath(
            value.output_artifact_path,
            `${label}.output_artifact_path`,
            reviewsRoot,
            taskId,
            violations
        );
        validateHash(value.output_artifact_sha256, `${label}.output_artifact_sha256`, violations);
        if (
            typeof value.output_artifact_size_bytes !== 'number'
            || !Number.isSafeInteger(value.output_artifact_size_bytes)
            || value.output_artifact_size_bytes < 0
        ) {
            violations.push(`${label}.output_artifact_size_bytes must be a non-negative safe integer.`);
        }
        validateAuthenticatedArtifactState({
            artifactPath: outputArtifactPath,
            expectedSha256: value.output_artifact_sha256,
            expectedSizeBytes: value.output_artifact_size_bytes,
            label: `${label}.output_artifact`,
            artifactStateReader,
            violations
        });
    }
    const bindingHash = validateHash(
        value.remediation_binding_sha256,
        `${label}.remediation_binding_sha256`,
        violations
    );
    if (bindingHash && bindingHash !== expectedBindingSha256) {
        violations.push(`${label}.remediation_binding_sha256 does not match the composite binding.`);
    }
    const componentHash = validateHash(value.component_sha256, `${label}.component_sha256`, violations);
    if (
        componentHash
        && sha256RedactedJsonPayload(withoutHash(value, 'component_sha256')) !== componentHash
    ) {
        violations.push(`${label}.component_sha256 does not match the component payload.`);
    }
    return value as unknown as ReviewRemediationValidationComponent;
}

function validateExpectation(
    actual: unknown,
    expected: unknown,
    label: string,
    violations: string[]
): void {
    if (expected !== undefined && actual !== expected) {
        violations.push(`${label} mismatch: expected '${String(expected)}', found '${String(actual)}'.`);
    }
}

export function getReviewRemediationValidationEvidenceViolations(
    value: unknown,
    expectations: ReviewRemediationValidationEvidenceExpectations
): string[] {
    const violations: string[] = [];
    const safeExpectations = expectations || {} as ReviewRemediationValidationEvidenceExpectations;
    const artifactStateReader = typeof safeExpectations.artifactStateReader === 'function'
        ? safeExpectations.artifactStateReader
        : (): null => null;
    if (typeof safeExpectations.artifactStateReader !== 'function') {
        violations.push('expectations.artifactStateReader must be a trusted artifact-state reader.');
    }
    if (!isPlainRecord(value)) {
        return ['review remediation validation evidence must be a JSON object.'];
    }
    assertExactKeys(value, EVIDENCE_KEYS, 'evidence', violations);
    if (value.schema_version !== REVIEW_REMEDIATION_VALIDATION_EVIDENCE_SCHEMA_VERSION) {
        violations.push('evidence.schema_version must be 1.');
    }
    if (value.artifact_type !== REVIEW_REMEDIATION_VALIDATION_EVIDENCE_ARTIFACT_TYPE) {
        violations.push(
            `evidence.artifact_type must be '${REVIEW_REMEDIATION_VALIDATION_EVIDENCE_ARTIFACT_TYPE}'.`
        );
    }
    if (
        value.receipt_kind !== REVIEW_REMEDIATION_VALIDATION_EVIDENCE_RECEIPT_KIND
        || value.is_full_suite_receipt !== false
    ) {
        violations.push('evidence must be labeled as selective remediation validation, never as a full-suite receipt.');
    }
    const taskId = String(value.task_id || '').trim();
    const reviewType = String(value.review_type || '').trim().toLowerCase();
    if (!taskId || value.task_id !== taskId) {
        violations.push('evidence.task_id must be non-empty canonical text.');
    }
    if (!reviewType || value.review_type !== reviewType) {
        violations.push('evidence.review_type must be non-empty lowercase text.');
    }
    const category = value.delta_category as ReviewRemediationDeltaCategory;
    if (!REVIEW_REMEDIATION_DELTA_CATEGORIES.includes(category)) {
        violations.push(`evidence.delta_category '${String(value.delta_category)}' is unsupported.`);
    }
    let expectedRequirement: ReviewRemediationValidationRequirement | null = null;
    if (REVIEW_REMEDIATION_DELTA_CATEGORIES.includes(category)) {
        expectedRequirement = buildReviewRemediationValidationRequirement(category);
        if (value.validation_requirement !== expectedRequirement) {
            violations.push(
                `evidence.validation_requirement must be '${expectedRequirement}' for '${category}'.`
            );
        }
    }
    const reviewsRootValue = validateCanonicalPath(
        safeExpectations.reviewsRoot,
        'expectations.reviewsRoot',
        violations
    );
    const reviewsRoot = reviewsRootValue?.replace(/\/$/u, '') || '';
    const bindings = validateBindings(value.remediation_bindings, violations);
    if (bindings) {
        const baselineArtifactPath = validateTaskOwnedArtifactPath(
            bindings.baseline_artifact_path,
            'evidence.remediation_bindings.baseline_artifact_path',
            reviewsRoot,
            taskId,
            violations
        );
        validateAuthenticatedArtifactState({
            artifactPath: baselineArtifactPath,
            expectedSha256: bindings.baseline_artifact_sha256,
            label: 'evidence.remediation_bindings.baseline_artifact',
            artifactStateReader,
            violations
        });
    }
    const bindingHash = validateHash(
        value.remediation_binding_sha256,
        'evidence.remediation_binding_sha256',
        violations
    );
    if (bindings && bindingHash && sha256RedactedJsonPayload(bindings) !== bindingHash) {
        violations.push('evidence.remediation_binding_sha256 does not match remediation_bindings.');
    }
    const components: ReviewRemediationValidationComponent[] = [];
    if (!Array.isArray(value.components)) {
        violations.push('evidence.components must be an array.');
    } else {
        value.components.forEach((component, index) => {
            const validated = validateComponent(
                component,
                index,
                bindingHash || '',
                reviewsRoot || '',
                taskId,
                artifactStateReader,
                violations
            );
            if (validated) {
                components.push(validated);
            }
        });
        const roles = components.map((component) => component.role);
        if (expectedRequirement && !rolesSatisfyRequirement(roles, expectedRequirement)) {
            violations.push(
                `evidence component roles '${roles.join(', ') || 'none'}' do not satisfy '${expectedRequirement}'.`
            );
        }
    }
    const componentsHash = validateHash(value.components_sha256, 'evidence.components_sha256', violations);
    if (Array.isArray(value.components) && componentsHash
        && sha256RedactedJsonPayload(value.components) !== componentsHash) {
        violations.push('evidence.components_sha256 does not match components.');
    }
    const resultHash = validateHash(
        value.validation_result_sha256,
        'evidence.validation_result_sha256',
        violations
    );
    if (resultHash
        && sha256RedactedJsonPayload(withoutHash(value, 'validation_result_sha256')) !== resultHash) {
        violations.push('evidence.validation_result_sha256 does not match the composite payload.');
    }
    validateExpectation(value.task_id, safeExpectations.taskId, 'evidence.task_id', violations);
    validateExpectation(value.review_type, safeExpectations.reviewType, 'evidence.review_type', violations);
    validateExpectation(
        value.delta_category,
        safeExpectations.deltaCategory,
        'evidence.delta_category',
        violations
    );
    validateExpectation(
        bindings?.baseline_artifact_sha256,
        safeExpectations.baselineArtifactSha256,
        'evidence.remediation_bindings.baseline_artifact_sha256',
        violations
    );
    validateExpectation(
        bindings?.delta_classification_sha256,
        safeExpectations.deltaClassificationSha256,
        'evidence.remediation_bindings.delta_classification_sha256',
        violations
    );
    return violations;
}

export function validateReviewRemediationValidationEvidence(
    value: unknown,
    expectations: ReviewRemediationValidationEvidenceExpectations
): ReviewRemediationValidationEvidenceResult {
    const violations = getReviewRemediationValidationEvidenceViolations(value, expectations);
    return {
        valid: violations.length === 0,
        evidence: violations.length === 0
            ? value as ReviewRemediationValidationEvidence
            : null,
        violations
    };
}
