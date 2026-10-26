import { countNextStepWork, describeProcessInputs } from '../../core/next-step-measurement';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { createInvocationReadMemoKey, isInvocationReadObservationActive } from '../../core/invocation-read-observation';
import {
    readReviewValidationBytes, readQualityArtifactLstat,
    readQualityArtifactStat, readReviewValidationNode
} from './review-validation-invocation';
import { currentProjectValidationAuthority } from '../project-validation/authority';
import { validationDigest } from '../../core/project-validation-identity';
import { inspectQualityValidationPhases, type QualityValidationPhases } from '../quality-checklist/quality-checklist-validation-phases';
import type { ValidationEvidenceInspection } from '../project-validation/attempt-evidence';

import {
    forEachJsonlLine,
    inspectTaskEventFile
} from '../../gate-runtime/task-events';

import {
    assessTrustBoundaryAnalysisApplicability,
    assessBoundTrustBoundaryMatrix,
    TRUST_BOUNDARY_ANALYSIS_RULE_ID,
    type TrustBoundaryMatrixEntry
} from '../../core/trust-boundary-analysis';
import {
    QUALITY_CHECKLIST_ID,
    resolveDefaultQualityChecklistArtifactPath
} from '../quality-checklist';
import {
    isPathRealpathInsideRoot,
    normalizePath
} from '../shared/helpers';

export interface ReviewContextTrustBoundaryAnalysis {
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
    validation_phases?: QualityValidationPhases;
    violations: string[];
}

type ReviewContextTrustBoundaryAnalysisBase = Omit<
    ReviewContextTrustBoundaryAnalysis,
    'status' | 'matrix_sha256' | 'matrix' | 'violations'
>;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidAnalysis(
    base: ReviewContextTrustBoundaryAnalysisBase,
    violations: string[]
): ReviewContextTrustBoundaryAnalysis {
    return {
        ...base,
        status: 'invalid',
        matrix_sha256: null,
        matrix: [],
        violations
    };
}

interface QualityChecklistArtifactBinding {
    recordedArtifactSha256: string | null;
    bindingEventSha256: string | null;
    violations: string[];
}

function normalizeSha256(value: unknown): string | null {
    const normalized = String(value || '').trim().toLowerCase();
    return /^[a-f0-9]{64}$/u.test(normalized) ? normalized : null;
}

function readQualityChecklistArtifactBinding(options: {
    artifactPath: string;
    taskId: string;
    preflightSha256: string | null;
}): QualityChecklistArtifactBinding {
    const taskEventsPath = path.resolve(
        path.dirname(options.artifactPath),
        '..',
        'task-events',
        `${options.taskId}.jsonl`
    );
    const inspection = inspectTaskEventFile(taskEventsPath, options.taskId);
    if (inspection.status !== 'PASS' && inspection.status !== 'PASS_WITH_LEGACY_PREFIX') {
        return {
            recordedArtifactSha256: null,
            bindingEventSha256: null,
            violations: [`Quality-checklist task timeline integrity is not current: ${inspection.status}.`]
        };
    }

    let latestEvent: Record<string, unknown> | null = null;
    try {
        countNextStepWork('quality_timeline_parse');
        forEachJsonlLine(taskEventsPath, (rawLine: string) => {
            countNextStepWork('visit:quality_timeline_event');
            const event = JSON.parse(rawLine) as Record<string, unknown>;
            if (String(event.event_type || '').trim().toUpperCase() === 'QUALITY_CHECKLIST_RECORDED') {
                latestEvent = event;
            }
        });
    } catch (error: unknown) {
        return {
            recordedArtifactSha256: null,
            bindingEventSha256: null,
            violations: [
                `Quality-checklist task timeline is unreadable: ${error instanceof Error ? error.message : String(error)}`
            ]
        };
    }
    if (!latestEvent) {
        return {
            recordedArtifactSha256: null,
            bindingEventSha256: null,
            violations: ['Quality-checklist artifact has no gate-recorded task timeline binding.']
        };
    }

    const event = latestEvent as Record<string, unknown>;
    const details = isRecord(event.details) ? event.details : {};
    const integrity = isRecord(event.integrity) ? event.integrity : {};
    const recordedArtifactSha256 = normalizeSha256(details.artifact_hash);
    const bindingEventSha256 = normalizeSha256(integrity.event_sha256);
    const violations: string[] = [];
    if (normalizePath(details.artifact_path) !== normalizePath(options.artifactPath)) {
        violations.push('Latest quality-checklist timeline binding points to a different artifact path.');
    }
    if (details.checklist_id !== QUALITY_CHECKLIST_ID) {
        violations.push('Latest quality-checklist timeline binding belongs to a foreign checklist.');
    }
    if (normalizeSha256(details.preflight_sha256) !== normalizeSha256(options.preflightSha256)) {
        violations.push('Latest quality-checklist timeline binding is stale for the current preflight hash.');
    }
    if (!recordedArtifactSha256) {
        violations.push('Latest quality-checklist timeline binding has no valid artifact hash.');
    }
    if (!bindingEventSha256) {
        violations.push('Latest quality-checklist timeline binding has no valid integrity event hash.');
    }
    return {
        recordedArtifactSha256,
        bindingEventSha256,
        violations
    };
}

interface QualityAnalysisOptions {
    repoRoot: string;
    taskId: string | null;
    preflight: Record<string, unknown>;
    preflightSha256: string | null;
    inspection?: ValidationEvidenceInspection;
}

type BoundQualityEvidence = {
    terminal: ReviewContextTrustBoundaryAnalysis;
} | {
    base: ReviewContextTrustBoundaryAnalysisBase;
    violations: string[];
    observedExecutionViolationIndex: number | null;
    matrixSha256: string | null;
    matrix: TrustBoundaryMatrixEntry[];
    phases: QualityValidationPhases | null;
};

const QUALITY_EVIDENCE = createInvocationReadMemoKey<BoundQualityEvidence>('bound-quality-evidence-v1');
const QUALITY_ANALYSIS = createInvocationReadMemoKey<ReviewContextTrustBoundaryAnalysis>('bound-quality-analysis-v1');

function qualityEvidenceIdentity(options: QualityAnalysisOptions): unknown[] {
    return [path.resolve(options.repoRoot), options.taskId, options.preflightSha256,
        options.preflight, options.inspection ?? 'active'];
}

function captureBoundQualityEvidence(options: QualityAnalysisOptions): BoundQualityEvidence {
    countNextStepWork('derive:readBoundQualityAnalysis');
    const applicability = assessTrustBoundaryAnalysisApplicability(options.preflight);
    const base: ReviewContextTrustBoundaryAnalysisBase = {
        required: applicability.required,
        applicability_reasons: applicability.reasons,
        rule_id: TRUST_BOUNDARY_ANALYSIS_RULE_ID,
        artifact_path: null,
        artifact_sha256: null,
        recorded_artifact_sha256: null,
        binding_event_sha256: null
    };
    let declared = false;
    try {
        declared = currentProjectValidationAuthority(options.repoRoot, options.preflight) !== null;
    }
    catch (error) { return { terminal: invalidAnalysis({ ...base, required: true }, [`Declared validation authority rejected: ${String(error)}`]) }; }
    if (declared) {
        base.required = true;
        base.applicability_reasons = [...base.applicability_reasons, 'declared-validation-contract'];
    }
    if (!base.required) {
        return { terminal: {
            ...base,
            status: 'not_required',
            matrix_sha256: null,
            matrix: [],
            violations: []
        } };
    }
    if (!options.taskId) {
        return { terminal: invalidAnalysis(base, ['Applicable trust-boundary analysis has no task id.']) };
    }
    const artifactPath = resolveDefaultQualityChecklistArtifactPath(options.repoRoot, options.taskId);
    const binding = readQualityChecklistArtifactBinding({
        artifactPath,
        taskId: options.taskId,
        preflightSha256: options.preflightSha256
    });
    const boundBase: ReviewContextTrustBoundaryAnalysisBase = {
        ...base,
        artifact_path: normalizePath(artifactPath),
        artifact_sha256: null,
        recorded_artifact_sha256: binding.recordedArtifactSha256,
        binding_event_sha256: binding.bindingEventSha256
    };
    let artifactEntryExists = false;
    try {
        readQualityArtifactLstat(artifactPath);
        artifactEntryExists = true;
    } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
            return { terminal: invalidAnalysis(boundBase, [
                `Quality-checklist artifact path is unreadable: ${error instanceof Error ? error.message : String(error)}`
            ]) };
        }
    }
    if (!artifactEntryExists) {
        return { terminal: {
            ...boundBase,
            status: 'missing',
            matrix_sha256: null,
            matrix: [],
            violations: [
                'Applicable trust-boundary analysis has no quality-checklist artifact.',
                ...binding.violations
            ]
        } };
    }
    if (!isPathRealpathInsideRoot(artifactPath, options.repoRoot)) {
        return { terminal: invalidAnalysis(boundBase, ['Quality-checklist artifact escapes the repository through a symlink or junction.']) };
    }
    let artifactIsFile = false;
    try {
        artifactIsFile = readQualityArtifactStat(artifactPath).isFile();
    } catch (error: unknown) {
        return { terminal: invalidAnalysis(boundBase, [
            `Quality-checklist artifact metadata is unreadable: ${error instanceof Error ? error.message : String(error)}`
        ]) };
    }
    if (!artifactIsFile) {
        return { terminal: invalidAnalysis(boundBase, ['Quality-checklist artifact must be a regular file.']) };
    }
    let artifactBytes: Buffer;
    try {
        artifactBytes = readReviewValidationBytes(artifactPath);
    } catch (error: unknown) {
        return { terminal: invalidAnalysis(boundBase, [
            `Quality-checklist artifact is unreadable: ${error instanceof Error ? error.message : String(error)}`
        ]) };
    }
    const artifactSha256 = createHash('sha256').update(artifactBytes).digest('hex');
    const hashedBoundBase: ReviewContextTrustBoundaryAnalysisBase = {
        ...boundBase,
        artifact_sha256: artifactSha256
    };
    let artifact: Record<string, unknown>;
    try {
        const parsed = JSON.parse(artifactBytes.toString('utf8'));
        if (!isRecord(parsed)) {
            return { terminal: invalidAnalysis(hashedBoundBase, ['Quality-checklist artifact must be a JSON object.']) };
        }
        artifact = parsed;
    } catch (error: unknown) {
        return { terminal: invalidAnalysis(hashedBoundBase, [
            `Quality-checklist artifact is unreadable: ${error instanceof Error ? error.message : String(error)}`
        ]) };
    }
    const violations: string[] = [...binding.violations];
    if (binding.recordedArtifactSha256 && artifactSha256 !== binding.recordedArtifactSha256) {
        violations.push('Quality-checklist artifact sha256 does not match its gate-recorded task timeline binding.');
    }
    if (artifact.task_id !== options.taskId || artifact.checklist_id !== QUALITY_CHECKLIST_ID) {
        violations.push('Quality-checklist artifact belongs to a foreign task or checklist.');
    }
    const expectedPreflightSha256 = String(options.preflightSha256 || '').trim().toLowerCase();
    const artifactPreflightSha256 = String(artifact.preflight_sha256 || '').trim().toLowerCase();
    if (!expectedPreflightSha256 || artifactPreflightSha256 !== expectedPreflightSha256) {
        violations.push('Quality-checklist artifact is missing or stale for the current preflight hash.');
    }
    const rule = Array.isArray(artifact.rules)
        ? artifact.rules.find((entry) => (
            isRecord(entry) && String(entry.id || '').trim().toLowerCase() === TRUST_BOUNDARY_ANALYSIS_RULE_ID
        ))
        : null;
    if (applicability.required && (!isRecord(rule) || rule.scope_applicability !== 'active')) {
        violations.push('Applicable trust-boundary rule is missing or not active in the quality-checklist artifact.');
    }
    const answer = Array.isArray(artifact.answers)
        ? artifact.answers.find((entry) => (
            isRecord(entry) && String(entry.rule_id || '').trim().toLowerCase() === TRUST_BOUNDARY_ANALYSIS_RULE_ID
        ))
        : null;
    if (applicability.required && !isRecord(answer)) {
        violations.push('Applicable trust-boundary rule has no recorded answer.');
    }
    let validation: ReturnType<typeof inspectQualityValidationPhases> = null;
    try {
        validation = inspectQualityValidationPhases({ ...options, taskId: options.taskId,
            matrixRequired: applicability.required, matrix: answer?.trust_boundary_matrix });
    } catch (error) { violations.push(`Declared validation phases rejected: ${String(error)}`); }
    const status = String(artifact.status || '').trim().toUpperCase();
    let observedExecutionViolationIndex: number | null = null;
    if (declared || validation) {
        if (!validation || !isRecord(artifact.validation_phases)
            || validationDigest(artifact.validation_phases) !== validationDigest(validation.phases))
            violations.push('Quality-checklist validation phases are missing, changed or stale for the current canonical obligations.');
        if (status !== 'PENDING_VALIDATION') violations.push('Declared validation phases require PENDING_VALIDATION quality evidence.');
        if (validation && (validation.phases.structural !== 'BOUND' || validation.phases.execution === 'REJECTED'))
            violations.push('Declared validation phases require bound structure and genuine current execution before review.');
        else if (validation && validation.phases.execution !== 'OBSERVED')
            observedExecutionViolationIndex = violations.length;
    } else if (status !== 'PASS' && status !== 'WARN') {
        violations.push(`Quality-checklist artifact status '${status || '<missing>'}' is not reviewer-ready.`);
    }
    const matrixAssessment = validation?.matrixAssessment ?? (applicability.required
        ? assessBoundTrustBoundaryMatrix(answer?.trust_boundary_matrix, { repoRoot: options.repoRoot }) : null);
    violations.push(...(matrixAssessment?.violations ?? []));
    return { base: hashedBoundBase, violations, observedExecutionViolationIndex,
        matrixSha256: matrixAssessment?.matrix_sha256 ?? null, matrix: matrixAssessment?.matrix ?? [],
        phases: validation?.phases ?? null };
}

/** Pure mode projection; a soft result can never authorize a strict consumer. */
function deriveBoundQualityAnalysis(evidence: BoundQualityEvidence, requireObservedExecution: boolean): ReviewContextTrustBoundaryAnalysis {
    countNextStepWork(requireObservedExecution ? 'derive:trust_boundary_analysis' : 'derive:quality_phase_analysis');
    if ('terminal' in evidence) return evidence.terminal;
    const violations = [...evidence.violations];
    if (requireObservedExecution && evidence.observedExecutionViolationIndex !== null) {
        violations.splice(evidence.observedExecutionViolationIndex, 0,
            'Declared validation phases require bound structure and genuine current execution before review.');
    }
    if (violations.length > 0) {
        return invalidAnalysis(evidence.base, [...new Set(violations)]);
    }
    return {
        ...evidence.base,
        status: 'current',
        matrix_sha256: evidence.matrixSha256,
        matrix: evidence.matrix,
        ...(evidence.phases ? { validation_phases: evidence.phases } : {}),
        violations: []
    };
}

function readBoundQualityAnalysis(options: QualityAnalysisOptions, requireObservedExecution: boolean): ReviewContextTrustBoundaryAnalysis {
    // Inspect caller descriptors before projecting fields: projection must not invoke getters.
    if (!isInvocationReadObservationActive() || describeProcessInputs(options).opaque)
        return deriveBoundQualityAnalysis(captureBoundQualityEvidence(options), requireObservedExecution);
    return readReviewValidationNode(QUALITY_ANALYSIS,
        () => [qualityEvidenceIdentity(options), requireObservedExecution], () => {
            const evidence = readReviewValidationNode(QUALITY_EVIDENCE, () => qualityEvidenceIdentity(options),
                () => captureBoundQualityEvidence(options));
            return deriveBoundQualityAnalysis(evidence, requireObservedExecution);
        });
}

export function readReviewContextTrustBoundaryAnalysis(options: QualityAnalysisOptions): ReviewContextTrustBoundaryAnalysis {
    return readBoundQualityAnalysis(options, true);
}

export function readQualityValidationPhaseAnalysis(options: QualityAnalysisOptions): ReviewContextTrustBoundaryAnalysis {
    return readBoundQualityAnalysis(options, false);
}

export function assertReviewContextTrustBoundaryAnalysisReady(
    analysis: ReviewContextTrustBoundaryAnalysis
): void {
    if (!analysis.required || analysis.status === 'current') {
        return;
    }
    throw new Error(
        `Review context cannot be built because required trust-boundary analysis is '${analysis.status}'. `
        + analysis.violations.join(' ')
    );
}

export function buildTrustBoundaryAnalysisMarkdown(
    analysis: ReviewContextTrustBoundaryAnalysis
): string[] {
    if (!analysis.required) {
        return [];
    }
    const lines = [
        '## Trust-Boundary Analysis',
        `- Status: ${analysis.status}`,
        `- Rule: ${analysis.rule_id}`,
        `- Quality-checklist artifact: ${analysis.artifact_path || 'missing'}`,
        `- Artifact sha256: ${analysis.artifact_sha256 || 'missing'}`,
        `- Gate-recorded artifact sha256: ${analysis.recorded_artifact_sha256 || 'missing'}`,
        `- Binding event sha256: ${analysis.binding_event_sha256 || 'missing'}`,
        `- Matrix sha256: ${analysis.matrix_sha256 || 'missing'}`,
        `- Applicability: ${analysis.applicability_reasons.join(', ') || 'unknown'}`
    ];
    if (analysis.violations.length > 0) {
        lines.push('- Blocking matrix diagnostics:');
        for (const violation of analysis.violations) lines.push(`  - ${violation}`);
        return lines;
    }
    if (analysis.validation_phases) {
        lines.push(`- Validation phases: structural=${analysis.validation_phases.structural}; execution=${analysis.validation_phases.execution}; semantic=${analysis.validation_phases.semantic}.`);
        for (const execution of analysis.validation_phases.executions)
            lines.push(`  - Recipe ${execution.recipe_id}: ${execution.execution}; attempt=${execution.attempt_id}; result=${execution.result_status}; sha256=${execution.result_sha256}.`);
        for (const obligation of analysis.validation_phases.obligations)
            lines.push(`  - Obligation ${obligation.id}: ${obligation.recipe_id}/${obligation.target_id}; source=${obligation.source_identity.path}; source_sha256=${obligation.source_identity.sha256}; selector=${obligation.selector}; ${analysis.validation_phases.semantic}.`);
    }
    for (const entry of analysis.matrix) {
        lines.push(`- ${entry.boundary_id} — ${entry.boundary}`);
        lines.push(`  - Authority source: ${entry.authority_source}`);
        lines.push(`  - Mutable inputs: ${entry.mutable_inputs.join('; ')}`);
        lines.push(`  - Integrity evidence: ${entry.integrity_evidence.join('; ')}`);
        lines.push(`  - Canonical reconstruction: ${entry.canonical_reconstruction}`);
        lines.push(`  - TOCTOU/replay: ${entry.toctou_replay}`);
        lines.push('  - Negative paths:');
        for (const negativePath of entry.negative_paths) {
            lines.push(
                `    - [${negativePath.kind}] ${negativePath.scenario}; expected: ${negativePath.expected_behavior}; `
                + `evidence: ${negativePath.evidence_files.join(', ')}`
            );
        }
    }
    lines.push('- Reviewer instruction: use this matrix as assigned evidence, verify every listed boundary and negative path, and report any omitted or contradicted trust condition as an ordinary finding.');
    return lines;
}
