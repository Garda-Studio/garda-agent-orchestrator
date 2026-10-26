import type { FrozenValidationRecipe, ValidationFileIdentity } from '../../core/project-validation-contract';
import { validationDigest } from '../../core/project-validation-identity';
import { assessBoundTrustBoundaryMatrix, assessTrustBoundaryMatrix } from '../../core/trust-boundary-analysis';
import { currentProjectValidationAuthority } from '../project-validation/authority';
import { latestValidationRecipeAttempt, readValidationEvents, readValidationRecipeSnapshot, withValidationEvidenceBatch,
    type ValidationEvidenceBatch, type ValidationEvidenceInspection } from '../project-validation/attempt-evidence';
import { readValidationResult } from '../project-validation/evidence';
import type { NativeCaseExecution } from '../review/native-case-semantics';
import { NativeCaseExecutionUnavailableError, readNativeCaseObligations } from '../review/native-case-semantics';
import { readValidationEventSnapshot } from '../project-validation/attempt-evidence';
import { readValidationFile } from '../../core/project-validation-identity';
import * as path from 'node:path';
import { createInvocationReadMemoKey } from '../../core/invocation-read-observation';
import { countNextStepWork } from '../../core/next-step-measurement';
import { readReviewValidationNode } from '../review-context/review-validation-invocation';

type ExecutionObservation = 'PENDING' | 'OBSERVED' | 'REJECTED';
export interface QualityValidationObligation {
    id: string; recipe_id: string; target_id: string; selector: string;
    source_identity: ValidationFileIdentity; snapshot_sha256: string;
    execution: ExecutionObservation; attempt_id: string | null;
    result_status: string | null; result_sha256: string | null;
    case_execution?: NativeCaseExecution;
}
export type QualityRecipeExecution = Pick<QualityValidationObligation,
    'recipe_id' | 'snapshot_sha256' | 'execution' | 'attempt_id' | 'result_status' | 'result_sha256'>;
export interface QualityValidationPhases {
    schema_version: 1; task_id: string; preflight_sha256: string; authority_sha256: string;
    structural: 'BOUND' | 'INVALID'; execution: ExecutionObservation;
    semantic: 'PENDING_INDEPENDENT_REVIEW'; matrix_sha256: string | null;
    obligations: QualityValidationObligation[]; executions: QualityRecipeExecution[];
    execution_diagnostics: string[]; sha256: string;
    execution_kind?: 'task-command';
}

interface QualityValidationPhaseInspectionOptions {
    repoRoot: string; taskId: string; preflight: Record<string, unknown>;
    preflightSha256: string | null; matrixRequired: boolean; matrix: unknown; inspection?: ValidationEvidenceInspection;
}

function inspectNativePhases(options: QualityValidationPhaseInspectionOptions) {
    const native = readValidationEventSnapshot(options.repoRoot, options.taskId, options.inspection);
    const relative = path.relative(path.resolve(options.repoRoot), native.preflight_path).replace(/\\/gu, '/');
    const retained = readValidationFile(options.repoRoot, relative);
    if (native.preflight_sha256 !== options.preflightSha256
        || validationDigest(JSON.parse(retained.bytes.toString('utf8'))) !== validationDigest(options.preflight))
        throw new Error('Native quality phases differ from the current canonical preflight.');
    const matrixAssessment = assessBoundTrustBoundaryMatrix(options.matrix, { repoRoot: options.repoRoot });
    const sources = matrixAssessment.source_evidence ?? [];
    let obligations: QualityValidationObligation[] = sources.map(source => {
        const binding = { task_id: options.taskId, preflight_sha256: native.preflight_sha256,
            source_identity: source.source_identity, case_id: source.case_id };
        return { id: validationDigest(binding), recipe_id: 'native-task-command', target_id: source.case_id,
            selector: source.selector, source_identity: source.source_identity, snapshot_sha256: native.preflight_sha256,
            execution: 'PENDING', attempt_id: null, result_status: null, result_sha256: null };
    });
    let execution: ExecutionObservation = matrixAssessment.structural_status === 'BOUND' ? 'PENDING' : 'REJECTED';
    const diagnostics = [...matrixAssessment.violations];
    if (execution !== 'REJECTED') {
        try {
            obligations = readNativeCaseObligations({ ...options, preflightPath: native.preflight_path,
                preflightSha256: native.preflight_sha256, scopeContentSha256: native.scope_content_sha256, sources });
            if (obligations.length > 0) execution = 'OBSERVED';
        } catch (error) {
            if (!(error instanceof NativeCaseExecutionUnavailableError) || error.violations.length > 0) {
                execution = 'REJECTED'; diagnostics.push(String(error));
            }
        }
    }
    return deriveNativePhases(options.taskId, native.preflight_sha256, matrixAssessment, obligations, execution, diagnostics);
}

function deriveNativePhases(taskId: string, preflightSha256: string,
    matrixAssessment: ReturnType<typeof assessBoundTrustBoundaryMatrix>, obligations: QualityValidationObligation[],
    execution: ExecutionObservation, diagnostics: string[]) {
    const first = obligations[0];
    const executions: QualityRecipeExecution[] = [{ recipe_id: 'native-task-command', snapshot_sha256: preflightSha256,
        execution, attempt_id: first?.attempt_id ?? null, result_status: first?.result_status ?? null,
        result_sha256: first?.result_sha256 ?? null }];
    const payload = { schema_version: 1 as const, task_id: taskId, preflight_sha256: preflightSha256,
        authority_sha256: matrixAssessment.source_bindings_sha256, structural: matrixAssessment.structural_status!, execution,
        semantic: 'PENDING_INDEPENDENT_REVIEW' as const, matrix_sha256: matrixAssessment.matrix_sha256,
        obligations, executions, execution_diagnostics: diagnostics, execution_kind: 'task-command' as const };
    return { matrixAssessment, phases: { ...payload, sha256: validationDigest(payload) } satisfies QualityValidationPhases };
}

function observeExecution(options: {
    repoRoot: string; taskId: string; snapshot: FrozenValidationRecipe;
    latest: ReturnType<typeof readValidationEvents>[number] | undefined; scopeContentSha256: string;
    inspection?: ValidationEvidenceInspection; batch: ValidationEvidenceBatch;
}) {
    const { repoRoot, taskId, snapshot, latest, scopeContentSha256, inspection, batch } = options;
    const observation: Pick<QualityValidationObligation, 'execution' | 'attempt_id' | 'result_status' | 'result_sha256'> = {
        execution: 'PENDING', attempt_id: latest ? String(latest.details?.attempt_id) : null,
        result_status: null, result_sha256: null
    };
    let caseExecution: NativeCaseExecution | undefined;
    if (latest?.event_type !== 'PROJECT_VALIDATION_RESULTS_EVALUATED') return { observation, caseExecution, diagnostic: null };
    try {
        const { snapshot: recorded, attempt, result } = readValidationResult({ repoRoot, taskId,
            attemptId: observation.attempt_id!, inspection, batch });
        if (recorded.snapshot_sha256 !== snapshot.snapshot_sha256) throw new Error('Foreign validation quality snapshot');
        observation.result_status = result.status; observation.result_sha256 = result.result_sha256;
        observation.execution = attempt.exit_code === 0 && !attempt.timed_out && !attempt.cancelled && !attempt.truncated
            && !attempt.termination_signal && attempt.violations.length === 0
            && ['PASSED', 'UNRESOLVED'].includes(result.status) ? 'OBSERVED' : 'REJECTED';
        if (observation.execution === 'OBSERVED' && result.status === 'UNRESOLVED') {
            const sequence = latest.integrity?.task_sequence;
            if (!Number.isSafeInteger(sequence) || Number(sequence) < 1) throw new Error('Recipe case evidence lacks native event sequence.');
            caseExecution = { record_path: result.attempt_path, record_sha256: result.attempt_sha256,
                output_path: attempt.output_path, output_sha256: attempt.output_sha256,
                output_size_bytes: attempt.output_bytes, output_encoding: 'base64-streams',
                event_task_sequence: Number(sequence), scope_content_sha256: scopeContentSha256,
                ...(attempt.report_capture_start_sha256 ? { report_evidence: {
                    declarations: snapshot.recipe.report_files!, start_sha256: attempt.report_capture_start_sha256,
                    evidence_directory: path.posix.dirname(attempt.output_path) } } : {}) };
        }
        return { observation, caseExecution, diagnostic: observation.execution === 'REJECTED' ? `Recipe ${snapshot.recipe.id} retained ${result.status}.` : null };
    } catch (error) {
        observation.execution = 'REJECTED';
        return { observation, caseExecution: undefined, diagnostic: `Recipe ${snapshot.recipe.id} evidence rejected: ${String(error)}` };
    }
}

function inspectDeclaredPhases(options: QualityValidationPhaseInspectionOptions,
    authority: NonNullable<ReturnType<typeof currentProjectValidationAuthority>>, batch: ValidationEvidenceBatch) {
    const { repoRoot, taskId, preflight } = options;
    const snapshots = authority.approved.contract.recipes.map(recipe =>
        readValidationRecipeSnapshot(repoRoot, taskId, recipe.id, options.inspection, batch));
    if (snapshots.some(snapshot => snapshot.preflight_sha256 !== options.preflightSha256))
        throw new Error('Validation quality preflight changed');
    const events = readValidationEvents(repoRoot, taskId, options.inspection, batch);
    const start = Math.max(events.map(event => event.event_type).lastIndexOf('TASK_MODE_ENTERED'),
        events.map(event => event.event_type).lastIndexOf('PREFLIGHT_CLASSIFIED'));
    if (start < 0) throw new Error('Validation quality has no current task cycle');
    const obligations: QualityValidationObligation[] = [], diagnostics: string[] = [];
    const executions: QualityRecipeExecution[] = [];
    for (const snapshot of snapshots) {
        countNextStepWork('visit:quality_validation_recipe');
        const latest = latestValidationRecipeAttempt(events.slice(start + 1), snapshot.recipe.id);
        const { observation, caseExecution, diagnostic } = observeExecution({ repoRoot, taskId, snapshot, latest,
            scopeContentSha256: String((preflight.metrics as Record<string, unknown>)?.scope_content_sha256 ?? ''),
            inspection: options.inspection, batch });
        executions.push({ recipe_id: snapshot.recipe.id, snapshot_sha256: snapshot.snapshot_sha256, ...observation });
        if (diagnostic) diagnostics.push(diagnostic);
        obligations.push(...deriveRecipeObligations(snapshot, observation, caseExecution));
    }
    const sources = [...new Map(obligations.map(obligation => [JSON.stringify(obligation.source_identity), obligation.source_identity])).values()];
    const referencedPaths = new Set(assessTrustBoundaryMatrix(options.matrix).matrix.flatMap(boundary =>
        boundary.negative_paths.flatMap(negative => negative.evidence_files
            .map(reference => reference.slice(0, reference.indexOf('#'))))));
    const matrixAssessment = options.matrixRequired ? assessBoundTrustBoundaryMatrix(options.matrix, {
        repoRoot, expectedSources: sources.filter(source => referencedPaths.has(source.path))
    }) : null;
    return deriveDeclaredPhases(options, authority.sha256, obligations, executions, diagnostics, matrixAssessment);
}

function deriveRecipeObligations(snapshot: FrozenValidationRecipe,
    observation: ReturnType<typeof observeExecution>['observation'], caseExecution: NativeCaseExecution | undefined): QualityValidationObligation[] {
    return snapshot.recipe.targets.map(target => {
        countNextStepWork('visit:quality_validation_target');
        const source = snapshot.inputs.find(input => input.path === target.source);
        if (!source) throw new Error('Declared validation target lacks a captured source');
        const binding = { recipe_id: snapshot.recipe.id, target_id: target.id, selector: target.selector,
            source_identity: source, snapshot_sha256: snapshot.snapshot_sha256 };
        return { id: validationDigest({ ...binding, ...(caseExecution ? { case_execution: caseExecution } : {}) }),
            ...binding, ...observation, ...(caseExecution ? { case_execution: caseExecution } : {}) };
    });
}

function deriveDeclaredPhases(options: QualityValidationPhaseInspectionOptions, authoritySha256: string,
    obligations: QualityValidationObligation[], executions: QualityRecipeExecution[], diagnostics: string[],
    matrixAssessment: ReturnType<typeof assessBoundTrustBoundaryMatrix> | null) {
    if (matrixAssessment) {
        for (const source of matrixAssessment.source_evidence ?? []) {
            if (!obligations.some(target => target.source_identity.path === source.source_identity.path
                && target.target_id === source.case_id))
                matrixAssessment.violations.push(`Matrix-selected case ${source.source_identity.path}#${source.case_id} has no declared validation target.`);
        }
        if (matrixAssessment.violations.length) matrixAssessment.structural_status = 'INVALID';
    }
    const execution: ExecutionObservation = executions.some(recipe => recipe.execution === 'REJECTED') ? 'REJECTED'
        : executions.length > 0 && executions.every(recipe => recipe.execution === 'OBSERVED') ? 'OBSERVED' : 'PENDING';
    const payload = { schema_version: 1 as const, task_id: options.taskId, preflight_sha256: options.preflightSha256!,
        authority_sha256: authoritySha256, structural: matrixAssessment?.structural_status ?? 'BOUND' as const,
        execution, semantic: 'PENDING_INDEPENDENT_REVIEW' as const, matrix_sha256: matrixAssessment?.matrix_sha256 ?? null,
        obligations, executions, execution_diagnostics: diagnostics };
    return { matrixAssessment, phases: { ...payload, sha256: validationDigest(payload) } satisfies QualityValidationPhases };
}

function captureQualityValidationPhases(options: QualityValidationPhaseInspectionOptions) {
    countNextStepWork('derive:quality_validation_phases');
    const authority = currentProjectValidationAuthority(options.repoRoot, options.preflight);
    if (!authority) return options.matrixRequired ? inspectNativePhases(options) : null;
    if (options.preflight.task_id !== options.taskId) throw new Error('Foreign validation quality preflight');
    return withValidationEvidenceBatch({ ...options, recipeIds: authority.approved.contract.recipes.map(recipe => recipe.id) },
        batch => inspectDeclaredPhases(options, authority, batch));
}

const QUALITY_PHASES = createInvocationReadMemoKey<ReturnType<typeof captureQualityValidationPhases>>('quality-validation-phases-v1');

export function inspectQualityValidationPhases(options: QualityValidationPhaseInspectionOptions) {
    return readReviewValidationNode(QUALITY_PHASES, () => [
        path.resolve(options.repoRoot), options.taskId, options.preflightSha256, options.preflight,
        options.matrixRequired, options.matrix, options.inspection ?? 'active'
    ], () => captureQualityValidationPhases(options));
}
