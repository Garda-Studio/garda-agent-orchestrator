import { countNextStepWork } from '../../core/next-step-measurement';
import {
    buildReviewCoverageContract,
    type ReviewCoverageContract
} from '../review/review-coverage-ledger';
import { resolveReviewCoverageChangedFiles } from './review-coverage-scope';
import { resolveReviewCoverageCategoryIdsFromPreflight } from './review-context-lane';
import * as path from 'node:path';
import { currentProjectValidationAuthority } from '../project-validation/authority';
import { readValidationFile, validationDigest } from '../../core/project-validation-identity';
import { readValidationReviewObligations } from '../review/validation-obligations';
import { resolveCurrentNoOpPreflightPath } from '../task-mode/no-op';
import { getTaskModeEvidence } from '../task-mode/task-mode';
import type { ValidationEvidenceInspection } from '../project-validation/attempt-evidence';
import type { TrustBoundarySourceEvidence } from '../../core/trust-boundary-analysis';
import { assessTrustBoundaryAnalysisApplicability } from '../../core/trust-boundary-analysis';
import { readNativeCaseObligations } from '../review/native-case-semantics';
import { readExpectedRedReviewObligations, taskRequiresExpectedRed } from '../test-first/expected-red-evidence';
import { resolveValidationSemanticReviewLanes, type EffectiveReviewSnapshot } from '../../policy/effective-review-snapshot';
import { createInvocationReadMemoKey } from '../../core/invocation-read-observation';
import type { QualityValidationObligation } from '../quality-checklist/quality-checklist-validation-phases';
import { readReviewValidationNode } from './review-validation-invocation';

export interface AuthoritativeReviewCoverageScope {
    changedFiles: string[];
    categoryIds: readonly string[] | undefined;
}

export interface AuthoritativeReviewCoverageContract extends AuthoritativeReviewCoverageScope {
    contract: ReviewCoverageContract;
}

const COVERAGE_SCOPE = createInvocationReadMemoKey<AuthoritativeReviewCoverageScope>('authoritative-review-coverage-scope');
const COVERAGE_CONTRACT = createInvocationReadMemoKey<AuthoritativeReviewCoverageContract>('authoritative-review-coverage-contract');

export function resolveAuthoritativeReviewCoverageScope(options: {
    reviewType: string;
    preflight: Record<string, unknown>;
    repoRoot: string;
}): AuthoritativeReviewCoverageScope {
    return readReviewValidationNode(COVERAGE_SCOPE, () => options, () => ({
        changedFiles: resolveReviewCoverageChangedFiles(options),
        categoryIds: resolveReviewCoverageCategoryIdsFromPreflight(options.preflight, options.reviewType)
    }));
}

export function buildAuthoritativeReviewCoverageContract(options: {
    reviewType: string;
    preflight: Record<string, unknown>;
    repoRoot: string;
}): AuthoritativeReviewCoverageContract {
    const scope = resolveAuthoritativeReviewCoverageScope(options);
    return readReviewValidationNode(COVERAGE_CONTRACT, () => [options, scope], () => {
        countNextStepWork('derive:authoritative_coverage_scope');
        return { ...scope, contract: buildReviewCoverageContract({ reviewType: options.reviewType,
            changedFiles: scope.changedFiles, categoryIds: scope.categoryIds }) };
    });
}

interface AuthoritativeReviewValidationOptions {
    reviewType: string; preflight: Record<string, unknown>; repoRoot: string; preflightPath?: string; taskModePath?: string;
    inspection?: ValidationEvidenceInspection;
}

interface TaskReviewValidationObligations {
    semanticReviewLanes: Array<'code' | 'test'>;
    obligations: QualityValidationObligation[];
}

const TASK_VALIDATION_OBLIGATIONS = createInvocationReadMemoKey<TaskReviewValidationObligations>('task-review-validation-obligations-v1');
const EXPECTED_RED_OBLIGATIONS = createInvocationReadMemoKey<QualityValidationObligation[]>('expected-red-review-obligations-v1');

function taskValidationIdentity(options: AuthoritativeReviewValidationOptions, preflightPath: string,
    preflightSha256: string, effectiveTaskModePath: string | null): unknown[] {
    return [path.resolve(options.repoRoot), options.preflight.task_id, preflightPath,
        preflightSha256, options.preflight, effectiveTaskModePath,
        options.inspection ?? 'active'];
}

function readTaskExpectedRedObligations(options: AuthoritativeReviewValidationOptions,
    taskId: string, preflightPath: string, preflightSha256: string, identity: unknown[],
    currentObligations: readonly QualityValidationObligation[] = []): QualityValidationObligation[] {
    return readReviewValidationNode(EXPECTED_RED_OBLIGATIONS,
        () => [identity, currentObligations], () => {
            countNextStepWork('derive:expected_red_review_obligations');
            return readExpectedRedReviewObligations({ repoRoot: options.repoRoot, taskId, preflightPath,
                preflightSha256, inspection: options.inspection }, currentObligations);
        });
}

function deriveTaskValidationObligations(semanticReviewLanes: Array<'code' | 'test'>,
    obligations: readonly QualityValidationObligation[], redGreen: readonly QualityValidationObligation[]): TaskReviewValidationObligations {
    countNextStepWork('derive:resolveAuthoritativeReviewValidationObligations');
    const byId = new Map<string, QualityValidationObligation>();
    for (const item of [...obligations, ...redGreen]) {
        countNextStepWork('visit:authoritative_validation_obligation');
        byId.set(item.id, item);
    }
    return { semanticReviewLanes, obligations: [...byId.values()] };
}

export function resolveAuthoritativeReviewValidationObligations(options: AuthoritativeReviewValidationOptions) {
    countNextStepWork('select:authoritative_validation_lane');
    const taskId = String(options.preflight.task_id ?? '');
    const expectedRed = taskRequiresExpectedRed(options.repoRoot, taskId);
    const declaredOrMatrix = currentProjectValidationAuthority(options.repoRoot, options.preflight)
        || assessTrustBoundaryAnalysisApplicability(options.preflight).required;
    if (!declaredOrMatrix && !expectedRed) return undefined;
    const preflightPath = resolveCurrentNoOpPreflightPath(options.repoRoot, taskId, options.preflightPath);
    const retained = readValidationFile(options.repoRoot,
        path.relative(path.resolve(options.repoRoot), preflightPath).replace(/\\/gu, '/'));
    if (validationDigest(JSON.parse(retained.bytes.toString('utf8'))) !== validationDigest(options.preflight))
        throw new Error('Declared review coverage preflight differs from current canonical projection.');
    if (!declaredOrMatrix) {
        const lanes = resolveValidationSemanticReviewLanes(options.preflight.effective_review_snapshot as EffectiveReviewSnapshot);
        // The old expected-RED-only route never inspected retained RED for another lane.
        if (!lanes.some(lane => lane === options.reviewType)) return undefined;
        const identity = taskValidationIdentity(options, preflightPath, retained.identity.sha256,
            options.taskModePath?.trim() ? path.resolve(options.repoRoot, options.taskModePath.trim()) : null);
        const red = readTaskExpectedRedObligations(options, taskId, preflightPath, retained.identity.sha256, identity);
        // Unlike the declared branch, the original RED-only result does not deduplicate.
        return readReviewValidationNode(TASK_VALIDATION_OBLIGATIONS, () => ['red-only', identity, lanes, red], () => {
            countNextStepWork('derive:resolveAuthoritativeReviewValidationObligations');
            return { semanticReviewLanes: lanes, obligations: red };
        }).obligations;
    }
    let mode = getTaskModeEvidence(options.repoRoot, taskId, options.taskModePath ?? '');
    if (!options.taskModePath && mode.timeline_artifact_path
        && path.resolve(mode.timeline_artifact_path) !== path.resolve(mode.evidence_path ?? ''))
        mode = getTaskModeEvidence(options.repoRoot, taskId, mode.timeline_artifact_path);
    if (mode.evidence_status !== 'PASS' || !mode.evidence_path)
        throw new Error(`Declared review coverage task-mode identity rejected: ${mode.evidence_status}`);
    // Keep the live preflight facade (including REVIEW_CONTRACTS synchronization) on every call.
    const projection = readValidationReviewObligations({ ...options, taskId, preflightPath, taskModePath: mode.evidence_path });
    if (retained.identity.sha256 !== projection.preflight_sha256
        || validationDigest(JSON.parse(retained.bytes.toString('utf8'))) !== validationDigest(options.preflight))
        throw new Error('Declared review coverage preflight differs from current canonical projection.');
    const identity = taskValidationIdentity(options, preflightPath, retained.identity.sha256, path.resolve(mode.evidence_path));
    const redGreen = expectedRed ? readTaskExpectedRedObligations(options, taskId, preflightPath,
        retained.identity.sha256, identity, projection.obligations) : [];
    const graph = readReviewValidationNode(TASK_VALIDATION_OBLIGATIONS,
        () => ['declared', identity, projection, expectedRed, redGreen],
        () => deriveTaskValidationObligations(projection.semantic_review_lanes, projection.obligations, redGreen));
    return graph.semanticReviewLanes.some(lane => lane === options.reviewType) ? graph.obligations : undefined;
}

interface DeclaredCoverageGraph extends AuthoritativeReviewCoverageContract {
    validationObligations: ReturnType<typeof resolveAuthoritativeReviewValidationObligations>;
}
const DECLARED_COVERAGE_CONTRACT = createInvocationReadMemoKey<DeclaredCoverageGraph>('declared-review-coverage-contract');

export function buildDeclaredReviewCoverageContract(options: Parameters<typeof resolveAuthoritativeReviewValidationObligations>[0]): DeclaredCoverageGraph {
    const scope = resolveAuthoritativeReviewCoverageScope(options);
    // Keep the live validation facade and its registry synchronization before the pure node.
    const validationObligations = resolveAuthoritativeReviewValidationObligations(options);
    return readReviewValidationNode(DECLARED_COVERAGE_CONTRACT, () => [options, scope, validationObligations], () => {
        countNextStepWork('derive:coverage_contract');
        return { ...scope, validationObligations, contract: buildReviewCoverageContract({
            reviewType: options.reviewType, changedFiles: scope.changedFiles, categoryIds: scope.categoryIds, validationObligations
        }) };
    });
}

/** Common native contract primitive. Ordinary routing is activated by the linked consumer package. */
export function buildNativeCaseReviewCoverageContract(options: {
    reviewType: string; preflight: Record<string, unknown>; repoRoot: string; preflightPath: string;
    preflightSha256: string; sources: readonly TrustBoundarySourceEvidence[]; inspection?: ValidationEvidenceInspection;
}) {
    const relative = path.relative(path.resolve(options.repoRoot),
        path.resolve(options.repoRoot, options.preflightPath)).replace(/\\/gu, '/');
    const retained = readValidationFile(options.repoRoot, relative);
    if (retained.identity.sha256 !== options.preflightSha256
        || validationDigest(JSON.parse(retained.bytes.toString('utf8'))) !== validationDigest(options.preflight))
        throw new Error('Native case coverage preflight differs from actual retained classification.');
    const scope = resolveAuthoritativeReviewCoverageScope(options);
    const validationObligations = readNativeCaseObligations({ ...options, taskId: String(options.preflight.task_id),
        scopeContentSha256: String((options.preflight.metrics as Record<string, unknown>)?.scope_content_sha256) });
    return { ...scope, validationObligations, contract: buildReviewCoverageContract({
        reviewType: options.reviewType, changedFiles: scope.changedFiles, categoryIds: scope.categoryIds, validationObligations
    }) };
}
