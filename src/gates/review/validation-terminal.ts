import { currentProjectValidationAuthority, readProjectValidationAuthority } from '../project-validation/authority';
import type { ValidationEvidenceInspection } from '../project-validation/attempt-evidence';
import { resolveValidationSemanticReviewLanes, type EffectiveReviewSnapshot } from '../../policy/effective-review-snapshot';
import { resolveAuthoritativeReviewValidationObligations } from '../review-context/review-context-coverage';
import { parseReviewEvidenceLocation } from './review-coverage-ledger';
import { toPlainRecord } from '../shared/helpers';
import { getNativeCaseResolutionViolations } from './native-case-semantics';
import type { QualityValidationObligation } from '../quality-checklist/quality-checklist-validation-phases';

interface TerminalReviewArtifact { content: string; receipt?: unknown }

function semanticViolations(lane: string, ids: string[], sources: Set<string>, artifact: TerminalReviewArtifact | undefined,
    repoRoot: string, targets: QualityValidationObligation[]): string[] {
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
    for (const id of ids) {
        const matches = entries.filter(entry => entry?.obligation_id === id);
        const findingIds = matches[0]?.finding_ids;
        if (matches.length !== 1 || !Array.isArray(findingIds) || findingIds.length > 0)
            errors.push(`${prefix}: semantic obligation ${id} remains open; finding disposal is not closure.`);
    }
    for (const risk of Array.isArray(report.residual_risks) ? report.residual_risks : []) {
        const evidence = toPlainRecord(risk)?.evidence;
        if (Array.isArray(evidence) && evidence.some(item => sources.has(
            parseReviewEvidenceLocation(String(toPlainRecord(item)?.location ?? ''))?.filePath ?? '')))
            errors.push(`${prefix}: declared-source residual risk remains open; follow-up is not closure.`);
    }
    return errors;
}

export function getValidationTerminalViolations(options: {
    repoRoot: string; taskId: string; preflight: Record<string, unknown> | null; preflightPath?: string;
    requiredReviews: Record<string, unknown>; skipReviews?: readonly string[];
    artifacts: Record<string, TerminalReviewArtifact>; inspection?: ValidationEvidenceInspection;
}): string[] {
    try {
        if (!options.preflight) return readProjectValidationAuthority(options.repoRoot)
            ? ['Declared validation terminal: current preflight is missing.'] : [];
        if (!currentProjectValidationAuthority(options.repoRoot, options.preflight)) return [];
        if (options.preflight.task_id !== options.taskId) throw new Error('Foreign terminal task identity.');
        const lanes = resolveValidationSemanticReviewLanes(options.preflight.effective_review_snapshot as EffectiveReviewSnapshot);
        const targets = resolveAuthoritativeReviewValidationObligations({ ...options, preflight: options.preflight,
            reviewType: lanes[0] });
        if (!targets?.length) throw new Error('Canonical declared obligations are unavailable.');
        const errors = targets.filter(target => target.execution !== 'OBSERVED' || (!target.case_execution && target.result_status !== 'PASSED'))
            .map(target => `Declared validation terminal: ${target.recipe_id}/${target.target_id} execution ${target.execution}, result ${target.result_status ?? 'PENDING'} is not closed.`);
        const ids = targets.map(target => `VALIDATION-${target.id.toUpperCase()}`);
        const sources = new Set(targets.map(target => target.source_identity.path));
        for (const lane of lanes) {
            if (options.requiredReviews[lane] !== true || options.skipReviews?.includes(lane))
                errors.push(`Declared validation terminal ${lane}: frozen semantic review lane cannot be omitted or skipped.`);
            errors.push(...semanticViolations(lane, ids, sources, options.artifacts[lane], options.repoRoot, targets));
        }
        return errors;
    } catch (error) {
        return [`Declared validation terminal rejected: ${error instanceof Error ? error.message : String(error)}`];
    }
}
