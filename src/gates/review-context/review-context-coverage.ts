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
import { readNativeCaseObligations } from '../review/native-case-semantics';

export interface AuthoritativeReviewCoverageScope {
    changedFiles: string[];
    categoryIds: readonly string[] | undefined;
}

export interface AuthoritativeReviewCoverageContract extends AuthoritativeReviewCoverageScope {
    contract: ReviewCoverageContract;
}

export function resolveAuthoritativeReviewCoverageScope(options: {
    reviewType: string;
    preflight: Record<string, unknown>;
    repoRoot: string;
}): AuthoritativeReviewCoverageScope {
    const changedFiles = resolveReviewCoverageChangedFiles({
        reviewType: options.reviewType,
        preflight: options.preflight,
        repoRoot: options.repoRoot
    });
    const categoryIds = resolveReviewCoverageCategoryIdsFromPreflight(
        options.preflight,
        options.reviewType
    );
    return {
        changedFiles,
        categoryIds
    };
}

export function buildAuthoritativeReviewCoverageContract(options: {
    reviewType: string;
    preflight: Record<string, unknown>;
    repoRoot: string;
}): AuthoritativeReviewCoverageContract {
    const scope = resolveAuthoritativeReviewCoverageScope(options);
    return {
        ...scope,
        contract: buildReviewCoverageContract({
            reviewType: options.reviewType,
            changedFiles: scope.changedFiles,
            categoryIds: scope.categoryIds
        })
    };
}

export function resolveAuthoritativeReviewValidationObligations(options: {
    reviewType: string; preflight: Record<string, unknown>; repoRoot: string; preflightPath?: string; taskModePath?: string;
    inspection?: ValidationEvidenceInspection;
}) {
    if (!currentProjectValidationAuthority(options.repoRoot, options.preflight)) return undefined;
    const taskId = String(options.preflight.task_id ?? '');
    const preflightPath = resolveCurrentNoOpPreflightPath(options.repoRoot, taskId, options.preflightPath);
    let mode = getTaskModeEvidence(options.repoRoot, taskId, options.taskModePath ?? '');
    if (!options.taskModePath && mode.timeline_artifact_path
        && path.resolve(mode.timeline_artifact_path) !== path.resolve(mode.evidence_path ?? ''))
        mode = getTaskModeEvidence(options.repoRoot, taskId, mode.timeline_artifact_path);
    if (mode.evidence_status !== 'PASS' || !mode.evidence_path)
        throw new Error(`Declared review coverage task-mode identity rejected: ${mode.evidence_status}`);
    const projection = readValidationReviewObligations({ ...options, taskId, preflightPath, taskModePath: mode.evidence_path });
    const retained = readValidationFile(options.repoRoot,
        path.relative(path.resolve(options.repoRoot), preflightPath).replace(/\\/gu, '/'));
    if (retained.identity.sha256 !== projection.preflight_sha256
        || validationDigest(JSON.parse(retained.bytes.toString('utf8'))) !== validationDigest(options.preflight))
        throw new Error('Declared review coverage preflight differs from current canonical projection.');
    return projection.semantic_review_lanes.some(lane => lane === options.reviewType) ? projection.obligations : undefined;
}

export function buildDeclaredReviewCoverageContract(options: Parameters<typeof resolveAuthoritativeReviewValidationObligations>[0]) {
    const scope = resolveAuthoritativeReviewCoverageScope(options);
    const validationObligations = resolveAuthoritativeReviewValidationObligations(options);
    return { ...scope, validationObligations, contract: buildReviewCoverageContract({
        reviewType: options.reviewType, changedFiles: scope.changedFiles, categoryIds: scope.categoryIds, validationObligations
    }) };
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
