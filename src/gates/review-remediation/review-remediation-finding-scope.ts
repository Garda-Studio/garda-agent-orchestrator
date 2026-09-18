import { normalizePath } from '../shared/helpers';
import { parseReviewEvidenceLocation } from '../review/review-coverage-ledger';
import type {
    ReviewRemediationAcceptedFinding,
    ReviewRemediationBaselineArtifact
} from './review-remediation-baseline';

function evidencePaths(locations: readonly string[]): string[] {
    return [...new Set(locations.flatMap((location) => {
        const parsed = parseReviewEvidenceLocation(location);
        return parsed ? [normalizePath(parsed.filePath)] : [];
    }))].sort();
}

export function getReviewRemediationFindingPaths(
    baseline: ReviewRemediationBaselineArtifact,
    finding: ReviewRemediationAcceptedFinding
): string[] | null {
    const paths = evidencePaths(finding.evidence_locations);
    if (paths.length === 0) return null;
    const coverage = baseline.origin_coverage_contract;
    const obligations = new Map(coverage?.obligations.map((entry) => [entry.id, entry]) ?? []);
    for (const id of finding.coverage_obligation_ids) {
        const obligation = obligations.get(id);
        // FILE ids are lane-local. Never infer their targets from task-wide file ordering.
        if (!obligation && (coverage || /^FILE-\d{3}$/u.test(id))) return null;
        if (obligation?.kind === 'file') paths.push(normalizePath(obligation.target));
    }
    return [...new Set(paths)].sort();
}

export function buildReviewRemediationFindingScope(
    baseline: ReviewRemediationBaselineArtifact,
    changedTargets: readonly string[],
    fullReviewScope: readonly string[]
): { requiredTargets: string[]; contextFiles: string[]; fullReviewReasons: string[] } {
    const targets = new Set(changedTargets);
    const originalScope = new Set(baseline.delta_base?.changed_files ?? []);
    const currentScope = new Set(fullReviewScope);
    const fullReviewReasons: string[] = [];
    for (const item of baseline.fix_now_items) {
        const finding = item.kind === 'finding'
            ? baseline.accepted_findings.find((entry) => entry.id === item.id)
            : null;
        const paths = finding
            ? getReviewRemediationFindingPaths(baseline, finding)
            : item.kind === 'residual_risk' ? evidencePaths(item.evidence_locations) : null;
        if (!paths?.length || paths.some((filePath) => !originalScope.has(filePath) || !currentScope.has(filePath))) {
            fullReviewReasons.push(`fix-now item ${item.id} has unresolved or out-of-scope prior review targets`);
            continue;
        }
        // Mandatory reinspection is not a content change and must not affect lane selection.
        for (const filePath of paths) targets.add(filePath);
    }
    return {
        requiredTargets: [...targets].sort(),
        contextFiles: fullReviewScope.filter((filePath) => !targets.has(filePath)).sort(),
        fullReviewReasons: [...new Set(fullReviewReasons)].sort()
    };
}
