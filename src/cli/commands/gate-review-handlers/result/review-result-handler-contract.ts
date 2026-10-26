import type { ClosedReviewGateCapture } from '../../../../gates/review-attempts/review-closed-cycle-gate-hooks';
import type {
    getReviewArtifactFindingsEvidence,
    normalizeCanonicalReviewSectionHeadings
} from '../../../../gates/completion/completion';
import type {
    resolveRuntimeReviewerIdentity
} from '../../../../gates/review/reviewer-routing';
import type {
    ReviewDependencyTimelineEvent
} from '../../../../gates/review/review-dependencies';
import type {
    ParsedOptionsRecord
} from '../../shared-command-utils';

export type ReviewerExecutionMode = 'delegated_subagent';
export type RuntimeReviewerIdentity = ReturnType<typeof resolveRuntimeReviewerIdentity>;
export type ReviewFindingsEvidence = ReturnType<typeof getReviewArtifactFindingsEvidence>;

export interface ParsedReviewerIdentity {
    reviewerExecutionMode: ReviewerExecutionMode;
    reviewerIdentity: string;
    reviewerFallbackReason: string | null;
}

export interface ResolvedCanonicalReviewPaths {
    preflightPath: string;
    reviewsRoot: string;
    artifactPath: string;
    contextPath: string;
}

export interface ReviewMaterializationAnalysis {
    violations: string[];
    findingsEvidence: ReviewFindingsEvidence;
}

export interface ReviewResultHandlersDependencies {
    closedReviewGateCapture: ClosedReviewGateCapture;
    analyzeEarlyReviewMaterialization: (options: {
        artifactPath: string;
        reviewContent: string;
        verdictToken: string;
        expectedPassVerdict: string;
        requirePassValidationNotes: boolean;
    }) => ReviewMaterializationAnalysis;
    assertExplicitReviewContextRuntimeIdentity: (options: {
        repoRoot: string;
        taskId: string;
        reviewType: string;
        contextPath: string;
        reviewerRouting: Record<string, unknown> | null;
        taskModePath?: string | null;
    }) => RuntimeReviewerIdentity;
    assertReviewContextContractOrThrow: (options: {
        taskId: string;
        reviewType: string;
        contextPath: string;
        reviewContext: Record<string, unknown> | null;
        preflightPath: string;
        preflightSha256: string | null;
        preflightPayload?: Record<string, unknown> | null;
        requireStrictBindingMetadata?: boolean;
        repoRoot?: string;
    }) => void;
    assertReviewContextRuntimeIdentityMetadataPresent: (options: {
        reviewType: string;
        contextPath: string;
        reviewContext: Record<string, unknown> | null;
        reviewerRouting: Record<string, unknown> | null;
    }) => void;
    assertRoutingCompatibility: (options: {
        reviewType: string;
        runtimeIdentity: RuntimeReviewerIdentity;
        currentRouting: Record<string, unknown> | null;
        reviewerExecutionMode: ReviewerExecutionMode;
        reviewerFallbackReason: string | null;
    }) => void;
    buildLosslessPassReviewNormalization: (options: {
        reviewType: string;
        reviewContent: string;
        expectedPassVerdict: string;
        findingsEvidence: ReviewFindingsEvidence;
    }) => string | null;
    buildMinimalPassReviewTemplateHint: (reviewType: string, expectedPassVerdict: string) => string;
    buildPassReviewTemplateHintMessage: (options: {
        reviewType: string;
        verdictToken: string;
        expectedPassVerdict: string;
        reviewContent: string;
        findingsEvidence: ReviewFindingsEvidence;
    }) => string | null;
    findMatchingReviewerInvocationAttestationEvent: (
        timelineEvents: readonly ReviewDependencyTimelineEvent[],
        options: {
            taskId: string;
            reviewType: string;
            reviewerExecutionMode: ReviewerExecutionMode;
            reviewerIdentity: string;
            reviewContextSha256: string;
            reviewTreeStateSha256?: string | null;
            routingEventSha256: string;
        }
    ) => ReviewDependencyTimelineEvent | null;
    findMatchingRoutingEvent: (
        timelineEvents: readonly ReviewDependencyTimelineEvent[],
        reviewType: string,
        reviewerExecutionMode: ReviewerExecutionMode,
        reviewerIdentity: string,
        reviewerFallbackReason: string | null
    ) => ReviewDependencyTimelineEvent | null;
    getReviewTreeStateSha256: (reviewContext: Record<string, unknown>) => string;
    isLosslessPassNormalizationEligibleViolation: (violation: string) => boolean;
    parseReviewerIdentity: (options: ParsedOptionsRecord, modeRequiredMessage: string) => ParsedReviewerIdentity;
    readReviewOutputFromStdin: () => Promise<string>;
    normalizeReviewSectionHeadings: typeof normalizeCanonicalReviewSectionHeadings;
    resolveCanonicalReviewPaths: (
        repoRoot: string,
        taskId: string,
        reviewType: string,
        preflightPathValue: unknown,
        reviewContextPathValue: unknown
    ) => ResolvedCanonicalReviewPaths;
    reviewContextRequiresPassValidationNotes: (contextPath: string, repoRoot: string) => boolean;
}

export type RecordReviewResultHandler = (gateArgv: string[]) => Promise<void>;
export type RecordReviewReceiptHandler = (gateArgv: string[]) => Promise<void>;
export type RecordReviewOutputCorrectionInvocationHandler = (gateArgv: string[]) => Promise<void>;
export type RecordReviewOutputCorrectionResponseHandler = (gateArgv: string[]) => Promise<void>;
export type RecordReviewOutputCorrectionTransportHandler = (gateArgv: string[]) => Promise<void>;

export interface ReviewResultHandlers {
    handleRecordReviewResult: RecordReviewResultHandler;
    handleRecordReviewReceipt: RecordReviewReceiptHandler;
    handleRecordReviewOutputCorrectionInvocation: RecordReviewOutputCorrectionInvocationHandler;
    handleRecordReviewOutputCorrectionResponse: RecordReviewOutputCorrectionResponseHandler;
    handleRecordReviewOutputCorrectionTransport: RecordReviewOutputCorrectionTransportHandler;
}

export function recordReviewOutputCorrectionResponseOptionDefinitions(): Record<
string,
{ key: string; type: 'string' }
> {
    return {
        '--task-id': { key: 'taskId', type: 'string' },
        '--review-type': { key: 'reviewType', type: 'string' },
        '--correction-artifact-path': { key: 'correctionArtifactPath', type: 'string' },
        '--review-output-path': { key: 'reviewOutputPath', type: 'string' },
        '--reviewer-identity': { key: 'reviewerIdentity', type: 'string' },
        '--provider-invocation-id': { key: 'providerInvocationId', type: 'string' },
        '--attestation-source': { key: 'attestationSource', type: 'string' },
        '--repo-root': { key: 'repoRoot', type: 'string' }
    };
}

export function recordReviewOutputCorrectionTransportOptionDefinitions(): Record<
string,
{ key: string; type: 'string' }
> {
    return {
        '--task-id': { key: 'taskId', type: 'string' },
        '--review-type': { key: 'reviewType', type: 'string' },
        '--correction-artifact-path': { key: 'correctionArtifactPath', type: 'string' },
        '--session-availability': { key: 'sessionAvailability', type: 'string' },
        '--reviewer-identity': { key: 'reviewerIdentity', type: 'string' },
        '--provider-invocation-id': { key: 'providerInvocationId', type: 'string' },
        '--attestation-source': { key: 'attestationSource', type: 'string' },
        '--repo-root': { key: 'repoRoot', type: 'string' }
    };
}

export function recordReviewOutputCorrectionInvocationOptionDefinitions(): Record<
string,
{ key: string; type: 'string' | 'boolean' }
> {
    return {
        '--task-id': { key: 'taskId', type: 'string' },
        '--review-type': { key: 'reviewType', type: 'string' },
        '--correction-artifact-path': { key: 'correctionArtifactPath', type: 'string' },
        '--correction-producer-identity': { key: 'correctionProducerIdentity', type: 'string' },
        '--provider-invocation-id': { key: 'providerInvocationId', type: 'string' },
        '--attestation-source': { key: 'attestationSource', type: 'string' },
        '--launch-input-sha256': { key: 'launchInputSha256', type: 'string' },
        '--fork-context': { key: 'forkContext', type: 'boolean' },
        '--repo-root': { key: 'repoRoot', type: 'string' }
    };
}

export function recordReviewResultOptionDefinitions(): Record<string, { key: string; type: 'string' | 'boolean' }> {
    return {
        '--task-id': { key: 'taskId', type: 'string' },
        '--review-type': { key: 'reviewType', type: 'string' },
        '--preflight-path': { key: 'preflightPath', type: 'string' },
        '--task-mode-path': { key: 'taskModePath', type: 'string' },
        '--review-output-path': { key: 'reviewOutputPath', type: 'string' },
        '--review-output-stdin': { key: 'reviewOutputStdin', type: 'boolean' },
        '--review-context-path': { key: 'reviewContextPath', type: 'string' },
        '--reviewer-execution-mode': { key: 'reviewerExecutionMode', type: 'string' },
        '--reviewer-identity': { key: 'reviewerIdentity', type: 'string' },
        '--reviewer-fallback-reason': { key: 'reviewerFallbackReason', type: 'string' },
        '--correction-producer-identity': { key: 'correctionProducerIdentity', type: 'string' },
        '--correction-provider-invocation-id': { key: 'correctionProviderInvocationId', type: 'string' },
        '--correction-provider-invocation-event-sha256': {
            key: 'correctionProviderInvocationEventSha256',
            type: 'string'
        },
        '--correction-attestation-source': { key: 'correctionAttestationSource', type: 'string' },
        '--correction-launch-input-sha256': { key: 'correctionLaunchInputSha256', type: 'string' },
        '--correction-fork-context': { key: 'correctionForkContext', type: 'boolean' },
        '--repo-root': { key: 'repoRoot', type: 'string' }
    };
}

export function recordReviewReceiptOptionDefinitions(): Record<string, { key: string; type: 'string' }> {
    return {
        '--task-id': { key: 'taskId', type: 'string' },
        '--review-type': { key: 'reviewType', type: 'string' },
        '--preflight-path': { key: 'preflightPath', type: 'string' },
        '--review-context-path': { key: 'reviewContextPath', type: 'string' },
        '--task-mode-path': { key: 'taskModePath', type: 'string' },
        '--reviewer-execution-mode': { key: 'reviewerExecutionMode', type: 'string' },
        '--reviewer-identity': { key: 'reviewerIdentity', type: 'string' },
        '--reviewer-fallback-reason': { key: 'reviewerFallbackReason', type: 'string' },
        '--repo-root': { key: 'repoRoot', type: 'string' }
    };
}
