import { countNextStepWork } from './next-step-measurement';
import type { TrustBoundaryMatrixEntry } from './trust-boundary-analysis';
import type { TRUST_BOUNDARY_ANALYSIS_RULE_ID } from './trust-boundary-analysis';
/** Structural own-data boundary: core must not import higher-layer gate contracts. */
export interface ClosedQualityAnalysis {
    required: boolean;
    status: 'not_required' | 'missing' | 'invalid' | 'current';
    applicability_reasons: string[];
    rule_id: typeof TRUST_BOUNDARY_ANALYSIS_RULE_ID;
    artifact_path: string | null;
    artifact_sha256: string | null;
    recorded_artifact_sha256: string | null;
    binding_event_sha256: string | null;
    matrix_sha256: string | null;
    matrix: TrustBoundaryMatrixEntry[];
    validation_phases?: unknown;
    violations: string[];
}

type AnalysisBase = Omit<ClosedQualityAnalysis, 'status' | 'matrix_sha256' | 'matrix' | 'violations'>;
export type ClosedQualityEvidence = { terminal: ClosedQualityAnalysis } | {
    base: AnalysisBase;
    violations: string[];
    observedExecutionViolationIndex: number | null;
    matrixSha256: string | null;
    matrix: ClosedQualityAnalysis['matrix'];
    phases: unknown;
};

/** Module-owned reduction: no imports of readers, callbacks, native I/O or mutable policy. */
export function reduceClosedQualityAnalysis(evidence: ClosedQualityEvidence,
    requireObservedExecution: boolean): ClosedQualityAnalysis {
    countNextStepWork(requireObservedExecution ? 'derive:trust_boundary_analysis' : 'derive:quality_phase_analysis');
    if ('terminal' in evidence) return evidence.terminal;
    const violations = evidence.violations.map(value => {
        countNextStepWork('visit:quality_projection_violation'); return value;
    });
    if (requireObservedExecution && evidence.observedExecutionViolationIndex !== null) {
        violations.splice(evidence.observedExecutionViolationIndex, 0,
            'Declared validation phases require bound structure and genuine current execution before review.');
    }
    if (violations.length > 0) {
        const unique = new Set<string>();
        for (const violation of violations) {
            countNextStepWork('visit:quality_projection_violation_dedup'); unique.add(violation);
        }
        return { ...evidence.base, status: 'invalid', matrix_sha256: null, matrix: [], violations: [...unique] };
    }
    return { ...evidence.base, status: 'current', matrix_sha256: evidence.matrixSha256, matrix: evidence.matrix,
        ...(evidence.phases ? { validation_phases: evidence.phases } : {}), violations: [] };
}
