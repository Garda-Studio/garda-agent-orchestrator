import type { FrozenValidationRecipe, ValidationFileIdentity } from '../../core/project-validation-contract';
import { validationDigest } from '../../core/project-validation-identity';
import { assessTrustBoundaryMatrix } from '../../core/trust-boundary-analysis';
import { currentProjectValidationAuthority, freezeValidationRecipe } from '../project-validation/authority';
import { readValidationEvents, type ValidationEvidenceInspection } from '../project-validation/attempt-evidence';
import { readValidationResult } from '../project-validation/evidence';

type ExecutionObservation = 'PENDING' | 'OBSERVED' | 'REJECTED';
export interface QualityValidationObligation {
    id: string; recipe_id: string; target_id: string; selector: string;
    source_identity: ValidationFileIdentity; snapshot_sha256: string;
    execution: ExecutionObservation; attempt_id: string | null;
    result_status: string | null; result_sha256: string | null;
}
export type QualityRecipeExecution = Pick<QualityValidationObligation,
    'recipe_id' | 'snapshot_sha256' | 'execution' | 'attempt_id' | 'result_status' | 'result_sha256'>;
export interface QualityValidationPhases {
    schema_version: 1; task_id: string; preflight_sha256: string; authority_sha256: string;
    structural: 'BOUND' | 'INVALID'; execution: ExecutionObservation;
    semantic: 'PENDING_INDEPENDENT_REVIEW'; matrix_sha256: string | null;
    obligations: QualityValidationObligation[]; executions: QualityRecipeExecution[];
    execution_diagnostics: string[]; sha256: string;
}

function observeExecution(repoRoot: string, taskId: string, snapshot: FrozenValidationRecipe,
    latest: ReturnType<typeof readValidationEvents>[number] | undefined, inspection?: ValidationEvidenceInspection) {
    const observation: Pick<QualityValidationObligation, 'execution' | 'attempt_id' | 'result_status' | 'result_sha256'> = {
        execution: 'PENDING', attempt_id: latest ? String(latest.details?.attempt_id) : null,
        result_status: null, result_sha256: null
    };
    if (latest?.event_type !== 'PROJECT_VALIDATION_RESULTS_EVALUATED') return { observation, diagnostic: null };
    try {
        const { snapshot: recorded, attempt, result } = readValidationResult({ repoRoot, taskId, attemptId: observation.attempt_id!, inspection });
        if (recorded.snapshot_sha256 !== snapshot.snapshot_sha256) throw new Error('Foreign validation quality snapshot');
        observation.result_status = result.status; observation.result_sha256 = result.result_sha256;
        observation.execution = attempt.exit_code === 0 && !attempt.timed_out && !attempt.cancelled && !attempt.truncated
            && !attempt.termination_signal && attempt.violations.length === 0
            && ['PASSED', 'UNRESOLVED'].includes(result.status) ? 'OBSERVED' : 'REJECTED';
        return { observation, diagnostic: observation.execution === 'REJECTED' ? `Recipe ${snapshot.recipe.id} retained ${result.status}.` : null };
    } catch (error) {
        observation.execution = 'REJECTED';
        return { observation, diagnostic: `Recipe ${snapshot.recipe.id} evidence rejected: ${String(error)}` };
    }
}

export function inspectQualityValidationPhases(options: {
    repoRoot: string; taskId: string; preflight: Record<string, unknown>;
    preflightSha256: string | null; matrixRequired: boolean; matrix: unknown; inspection?: ValidationEvidenceInspection;
}) {
    const { repoRoot, taskId, preflight } = options;
    const authority = currentProjectValidationAuthority(repoRoot, preflight);
    if (!authority) return null;
    if (preflight.task_id !== taskId) throw new Error('Foreign validation quality preflight');
    const snapshots = authority.approved.contract.recipes.map(recipe => freezeValidationRecipe(repoRoot, taskId, recipe.id));
    if (snapshots.some(snapshot => snapshot.preflight_sha256 !== options.preflightSha256))
        throw new Error('Validation quality preflight changed');
    const events = readValidationEvents(repoRoot, taskId, options.inspection);
    const start = Math.max(events.map(event => event.event_type).lastIndexOf('TASK_MODE_ENTERED'),
        events.map(event => event.event_type).lastIndexOf('PREFLIGHT_CLASSIFIED'));
    if (start < 0) throw new Error('Validation quality has no current task cycle');
    const obligations: QualityValidationObligation[] = [], diagnostics: string[] = [];
    const executions: QualityRecipeExecution[] = [];
    for (const snapshot of snapshots) {
        const recipeEvents = events.slice(start + 1).reverse().filter(event => event.details?.recipe_id === snapshot.recipe.id);
        const started = recipeEvents.find(event => event.event_type === 'PROJECT_VALIDATION_STARTED');
        const latest = started && recipeEvents.find(event => event.details?.attempt_id === started.details?.attempt_id
            && ['PROJECT_VALIDATION_STARTED', 'PROJECT_VALIDATION_COMPLETED', 'PROJECT_VALIDATION_RESULTS_EVALUATED'].includes(event.event_type));
        const { observation, diagnostic } = observeExecution(repoRoot, taskId, snapshot, latest, options.inspection);
        executions.push({ recipe_id: snapshot.recipe.id, snapshot_sha256: snapshot.snapshot_sha256, ...observation });
        if (diagnostic) diagnostics.push(diagnostic);
        for (const target of snapshot.recipe.targets) {
            const source = snapshot.inputs.find(input => input.path === target.source);
            if (!source) throw new Error('Declared validation target lacks a captured source');
            const binding = { recipe_id: snapshot.recipe.id, target_id: target.id, selector: target.selector,
                source_identity: source, snapshot_sha256: snapshot.snapshot_sha256 };
            obligations.push({ id: validationDigest(binding), ...binding, ...observation });
        }
    }
    const targets = [...new Map(snapshots.flatMap(snapshot => snapshot.recipe.targets).map(target => [JSON.stringify(target), target])).values()];
    const sources = [...new Map(obligations.map(obligation => [JSON.stringify(obligation.source_identity), obligation.source_identity])).values()];
    const matrixAssessment = options.matrixRequired ? assessTrustBoundaryMatrix(options.matrix, {
        repoRoot, recipeTargets: targets, sourceIdentities: sources
    }) : null;
    if (snapshots.some(snapshot => freezeValidationRecipe(repoRoot, taskId, snapshot.recipe.id).snapshot_sha256 !== snapshot.snapshot_sha256)
        || validationDigest(readValidationEvents(repoRoot, taskId, options.inspection)) !== validationDigest(events))
        throw new Error('Validation quality identities or timeline changed during inspection');
    const execution: ExecutionObservation = executions.some(recipe => recipe.execution === 'REJECTED') ? 'REJECTED'
        : executions.length > 0 && executions.every(recipe => recipe.execution === 'OBSERVED') ? 'OBSERVED' : 'PENDING';
    const payload = { schema_version: 1 as const, task_id: taskId, preflight_sha256: options.preflightSha256!,
        authority_sha256: authority.sha256, structural: matrixAssessment?.structural_status ?? 'BOUND' as const,
        execution, semantic: 'PENDING_INDEPENDENT_REVIEW' as const, matrix_sha256: matrixAssessment?.matrix_sha256 ?? null,
        obligations, executions, execution_diagnostics: diagnostics };
    return { matrixAssessment, phases: { ...payload, sha256: validationDigest(payload) } satisfies QualityValidationPhases };
}
