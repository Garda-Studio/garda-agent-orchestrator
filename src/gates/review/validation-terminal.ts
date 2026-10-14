import { currentProjectValidationAuthority, readProjectValidationAuthority } from '../project-validation/authority';
import type { ValidationEvidenceInspection } from '../project-validation/attempt-evidence';
import { resolveValidationSemanticReviewLanes, type EffectiveReviewSnapshot } from '../../policy/effective-review-snapshot';
import { resolveAuthoritativeReviewValidationObligations } from '../review-context/review-context-coverage';
import { parseReviewEvidenceLocation } from './review-coverage-ledger';
import { toPlainRecord } from '../shared/helpers';
import { getNativeCaseResolutionViolations } from './native-case-semantics';
import type { QualityValidationObligation } from '../quality-checklist/quality-checklist-validation-phases';
import { assessTrustBoundaryAnalysisApplicability } from '../../core/trust-boundary-analysis';
import { sha256RedactedJsonPayload } from '../../core/redaction';
import type { ReviewFindingsDispositionEvidenceCheckResult } from './review-findings-disposition-evidence';
import type { ReviewFindingsDispositionItemKind } from './review-findings-disposition-artifact';

interface TerminalReviewArtifact { content: string; receipt?: unknown }

function satisfiedDispositionIds(taskId: string, lane: string, kind: ReviewFindingsDispositionItemKind,
    evidence: ReviewFindingsDispositionEvidenceCheckResult | null | undefined): Set<string> {
    const artifact = evidence?.artifact;
    if (!evidence?.valid || evidence.violations.length || !artifact || artifact.task_id !== taskId
        || artifact.review_type !== lane || evidence.artifact_sha256 !== sha256RedactedJsonPayload(artifact)
        || artifact.summary.blocking_count > 0 || artifact.summary.fix_now_count > 0) return new Set();
    // Only invocation-local results from the canonical disposition validator reach this reader.
    // A satisfied finding disposition does not replace the separately required PASSED case resolution.
    return new Set(artifact.items.filter(item => item.kind === kind && !item.blocking
        && (item.action === 'create_follow_up' || item.action === 'ignore')).map(item => item.id));
}

function semanticViolations(options: {
    taskId: string; lane: string; ids: string[]; sources: Set<string>; artifact: TerminalReviewArtifact | undefined;
    repoRoot: string; targets: QualityValidationObligation[];
    disposition: ReviewFindingsDispositionEvidenceCheckResult | null | undefined;
}): string[] {
    const { taskId, lane, ids, sources, artifact, repoRoot, targets, disposition } = options;
    const prefix = `Declared validation terminal ${lane}`;
    let report: Record<string, unknown> | null;
    try { report = toPlainRecord(JSON.parse(artifact?.content ?? '')); }
    catch { return [`${prefix}: independent semantic report is missing or unreadable.`]; }
    const ledger = toPlainRecord(report?.coverage_ledger);
    const receipt = toPlainRecord(artifact?.receipt);
    const coverage = toPlainRecord(receipt?.review_coverage);
    const reportCoverageHash = receipt?.reused_existing_review === true
        ? toPlainRecord(receipt.review_output_contract)?.coverage_contract_sha256 : coverage?.contract_sha256;
    if (!report || coverage?.status !== 'PASS' || reportCoverageHash !== ledger?.coverage_contract_sha256)
        return [`${prefix}: independent semantic coverage is not accepted.`];
    const entries = Array.isArray(ledger?.entries) ? ledger.entries.map(toPlainRecord) : [];
    const errors: string[] = [];
    errors.push(...getNativeCaseResolutionViolations({ repoRoot, obligations: targets,
        entries: entries.map(entry => ({ obligation_id: String(entry?.obligation_id ?? ''),
            case_resolution: entry?.case_resolution })), requirePassed: true }));
    const satisfiedFindings = satisfiedDispositionIds(taskId, lane, 'finding', disposition);
    const satisfiedRisks = satisfiedDispositionIds(taskId, lane, 'residual_risk', disposition);
    for (const id of ids) {
        const matches = entries.filter(entry => entry?.obligation_id === id);
        const findingIds = matches[0]?.finding_ids;
        if (matches.length !== 1 || !Array.isArray(findingIds) || findingIds.some(id => !satisfiedFindings.has(String(id))))
            errors.push(`${prefix}: semantic obligation ${id} remains open; finding disposal is not closure.`);
    }
    for (const risk of Array.isArray(report.residual_risks) ? report.residual_risks : []) {
        const evidence = toPlainRecord(risk)?.evidence;
        if (Array.isArray(evidence) && evidence.some(item => sources.has(
            parseReviewEvidenceLocation(String(toPlainRecord(item)?.location ?? ''))?.filePath ?? ''))
            && !satisfiedRisks.has(String(toPlainRecord(risk)?.id ?? '')))
            errors.push(`${prefix}: declared-source residual risk remains open; follow-up is not closure.`);
    }
    return errors;
}

export function getValidationTerminalViolations(options: {
    repoRoot: string; taskId: string; preflight: Record<string, unknown> | null; preflightPath?: string;
    requiredReviews: Record<string, unknown>; skipReviews?: readonly string[];
    artifacts: Record<string, TerminalReviewArtifact>; inspection?: ValidationEvidenceInspection;
    dispositionEvidence?: Record<string, ReviewFindingsDispositionEvidenceCheckResult | null>;
}): string[] {
    try {
        if (!options.preflight) return readProjectValidationAuthority(options.repoRoot)
            ? ['Declared validation terminal: current preflight is missing.'] : [];
        if (!currentProjectValidationAuthority(options.repoRoot, options.preflight)
            && !assessTrustBoundaryAnalysisApplicability(options.preflight).required) return [];
        if (options.preflight.task_id !== options.taskId) throw new Error('Foreign terminal task identity.');
        const lanes = resolveValidationSemanticReviewLanes(options.preflight.effective_review_snapshot as EffectiveReviewSnapshot);
        const targets = resolveAuthoritativeReviewValidationObligations({ ...options, preflight: options.preflight,
            reviewType: lanes[0] });
        if (!targets) throw new Error('Canonical declared obligations are unavailable.');
        // The authenticated phase reader already requires current observed execution.
        // Targetless compile/typecheck facts add no case-semantic obligations.
        if (targets.length === 0) return [];
        const errors = targets.filter(target => target.execution !== 'OBSERVED' || (!target.case_execution && target.result_status !== 'PASSED'))
            .map(target => `Declared validation terminal: ${target.recipe_id}/${target.target_id} execution ${target.execution}, result ${target.result_status ?? 'PENDING'} is not closed.`);
        const ids = targets.map(target => `VALIDATION-${target.id.toUpperCase()}`);
        const sources = new Set(targets.map(target => target.source_identity.path));
        for (const lane of lanes) {
            if (options.requiredReviews[lane] !== true || options.skipReviews?.includes(lane))
                errors.push(`Declared validation terminal ${lane}: frozen semantic review lane cannot be omitted or skipped.`);
            errors.push(...semanticViolations({ taskId: options.taskId, lane, ids, sources,
                artifact: options.artifacts[lane], repoRoot: options.repoRoot, targets,
                disposition: options.dispositionEvidence?.[lane] }));
        }
        return errors;
    } catch (error) {
        return [`Declared validation terminal rejected: ${error instanceof Error ? error.message : String(error)}`];
    }
}
