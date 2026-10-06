export function normalizeReviewEvidenceDomainPaths(paths: readonly string[]): string[] {
    return [...new Set(paths
        .map((entry) => String(entry || '').trim().replace(/\\/g, '/'))
        .filter(Boolean))]
        .sort((left, right) => left.localeCompare(right));
}

function normalizeReviewType(reviewType: string): string {
    return String(reviewType || '').trim().toLowerCase() || 'current';
}

export function formatReviewEvidenceDomainViolation(options: {
    subject: string;
    location: string;
    reviewType: string;
    admissiblePaths: readonly string[];
}): string {
    const paths = normalizeReviewEvidenceDomainPaths(options.admissiblePaths);
    const expectedPaths = paths.length > 0 ? paths.join(', ') : 'no paths';
    return `${options.subject}.location '${options.location}' is outside the `
        + `${normalizeReviewType(options.reviewType)} review evidence domain; expected path:line from one of: `
        + `${expectedPaths}. Supporting artifacts may inform observations but are not admissible location evidence.`;
}

export function buildReviewEvidenceDomainContractLines(
    reviewType: string,
    admissiblePaths: readonly string[]
): string[] {
    const paths = normalizeReviewEvidenceDomainPaths(admissiblePaths);
    const renderedPaths = paths.length > 0 ? paths.join(', ') : 'none';
    if (paths.length === 0) {
        return [
            `Evidence location domain for ${normalizeReviewType(reviewType)} review: none.`,
            '- No location citation is admissible in this domain. Do not substitute planned, unchanged, historical or supporting files.',
            '- Only an authenticated empty FULL scope permits substantive validation observations with evidence=[] and no coverage entries, findings or residual risks; do not claim source coverage.',
            '- Supporting artifacts may inform observations but are not admissible location evidence; current native launch, context, tree and receipt checks remain mandatory.'
        ];
    }
    return [
        `Evidence location domain for ${normalizeReviewType(reviewType)} review: ${renderedPaths}.`,
        '- Every evidence location in validation_notes, coverage_ledger, findings, and residual_risks must use path:line from that exact domain.',
        '- Supporting artifacts may inform observations but are not admissible location evidence; do not cite review context, manifests, receipts, compile logs, full-suite artifacts, or manual-validation logs as evidence locations.',
        '- Every FILE-* coverage obligation must cite its own target path:line. Boundary and category obligations may cite any path in the evidence location domain.'
    ];
}
