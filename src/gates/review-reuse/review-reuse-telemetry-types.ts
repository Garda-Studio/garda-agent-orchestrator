// Extracted from review-reuse-telemetry.ts; keep behavior changes covered by facade tests.
export interface ReviewReuseTelemetryEventLike {
    event_type?: unknown;
    outcome?: unknown;
    sequence?: unknown;
    details?: unknown;
    integrity?: unknown;
}

export interface ReviewReuseTelemetryMatchInput {
    event: ReviewReuseTelemetryEventLike | null | undefined;
    reviewType: string;
    receiptPath: string;
    receiptSha256?: string | null;
    reviewContextSha256?: string | null;
    reviewContextReuseSha256?: string | null;
    reviewTreeStateSha256?: string | null;
    reviewScopeSha256?: string | null;
    codeScopeSha256?: string | null;
    reviewArtifactSha256?: string | null;
    reusedFromReceiptPath?: string | null;
    reusedFromReceiptSha256?: string | null;
    reusedFromReviewContextSha256?: string | null;
    reusedFromReviewContextReuseSha256?: string | null;
    reusedFromReviewTreeStateSha256?: string | null;
    reusedFromReviewScopeSha256?: string | null;
    reusedFromCodeScopeSha256?: string | null;
    minTaskSequenceExclusive?: number | null;
    minEventSequenceExclusive?: number | null;
}

export interface ReviewReuseTelemetryMatchResult {
    matched: boolean;
    hasIntegrity: boolean;
    taskSequence: number | null;
    eventSha256: string | null;
    reason: string | null;
}

export interface ReviewReuseTelemetryDetails {
    reviewType: string;
    receiptPath: string;
    receiptSha256: string;
    reviewContextSha256: string;
    reviewContextReuseSha256: string;
    reviewTreeStateSha256: string;
    reviewScopeSha256: string;
    codeScopeSha256: string;
    reviewArtifactSha256: string;
    reusedExistingReview: boolean;
    reusedFromReceiptPath: string;
    reusedFromReceiptSha256: string;
    reusedFromReviewContextSha256: string;
    reusedFromReviewContextReuseSha256: string;
    reusedFromReviewTreeStateSha256: string;
    reusedFromReviewScopeSha256: string;
    reusedFromCodeScopeSha256: string;
}

export interface HistoricalReviewRecordedTelemetryMatchInput {
    event: ReviewReuseTelemetryEventLike | null | undefined;
    repoRoot?: string | null;
    taskId?: string | null;
    reviewType: string;
    receiptPath: string;
    receiptSha256?: string | null;
    reviewContextSha256: string | null;
    reviewContextReuseSha256?: string | null;
    reviewTreeStateSha256?: string | null;
    reviewScopeSha256?: string | null;
    codeScopeSha256?: string | null;
    reviewArtifactSha256: string | null;
    reusedFromReceiptPath?: string | null;
    reusedFromReceiptSha256?: string | null;
    reusedFromReviewContextSha256?: string | null;
    reusedFromReviewContextReuseSha256?: string | null;
    reusedFromReviewTreeStateSha256?: string | null;
    reusedFromReviewScopeSha256?: string | null;
    reusedFromCodeScopeSha256?: string | null;
    reviewerExecutionMode?: string | null;
    reviewerIdentity?: string | null;
    reviewerProvenance?: Record<string, unknown> | null;
    maxTaskSequenceExclusive?: number | null;
    maxEventSequenceExclusive?: number | null;
    verifyReceiptSnapshot?: boolean;
}

export interface StrictReusedReviewEvidenceValidationInput {
    repoRoot: string;
    taskId: string;
    reviewType: string;
    events: readonly ReviewReuseTelemetryEventLike[];
    receiptPath: string;
    receiptSha256?: string | null;
    reviewContextSha256: string | null;
    reviewContextReuseSha256?: string | null;
    reviewTreeStateSha256: string | null;
    reviewScopeSha256?: string | null;
    codeScopeSha256?: string | null;
    reviewArtifactSha256: string | null;
    reusedFromReceiptPath: string | null;
    reusedFromReceiptSha256: string | null;
    reusedFromReviewContextSha256: string | null;
    reusedFromReviewContextReuseSha256?: string | null;
    reusedFromReviewTreeStateSha256: string | null;
    reusedFromReviewScopeSha256?: string | null;
    reusedFromCodeScopeSha256?: string | null;
    reviewerExecutionMode: string | null;
    reviewerIdentity: string | null;
    reviewerProvenance: Record<string, unknown> | null;
    latestCompileTaskSequence?: number | null;
    latestCompileEventSequence?: number | null;
}

export type StrictReusedReviewEvidenceValidationResult =
    | {
        valid: true;
        reason: null;
        currentReuseEventTaskSequence: number;
        currentReuseEventSha256: string;
        historicalReviewRecordedTaskSequence: number;
        historicalReviewRecordedEventSha256: string;
        historicalReviewRecordedDetails: Record<string, unknown>;
        historicalReviewerInvocationTaskSequence: number;
        historicalReviewerInvocationEventSha256: string;
    }
    | {
        valid: false;
        reason: string;
    };

export type HistoricalReviewRecordedSnapshotValidation =
    | {
        valid: true;
        reason: null;
        message: null;
        resolvedPath: string;
        expectedSha256: string;
        actualSha256: string;
    }
    | {
        valid: false;
        reason: string;
        message: string;
        resolvedPath: string | null;
        expectedSha256: string | null;
        actualSha256: string | null;
    };

export type HistoricalReviewRecordedRuntimeReviewPathValidation =
    | {
        valid: true;
        reason: null;
        message: null;
        resolvedPath: string;
    }
    | {
        valid: false;
        reason: string;
        message: string;
        resolvedPath: string | null;
    };


export type StrictEventEvidence =
    | { valid: true; taskSequence: number; eventSha256: string }
    | { valid: false; reason: string };
