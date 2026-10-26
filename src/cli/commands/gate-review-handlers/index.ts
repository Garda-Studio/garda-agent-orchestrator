import { captureClosedReviewGate } from '../../../gates/review-attempts/review-closed-cycle-capture';
import {
    normalizeCanonicalReviewSectionHeadings
} from '../../../gates/completion/completion';
import {
    runMaterializeReviewFollowUpTasksCommand
} from '../gate-flows/review/review-follow-up-task-flow';
import {
    parseOptions
} from '../cli-helpers';
import {
    createReviewInvocationHandlers
} from './launch/review-invocation-handlers';
import {
    createReviewResultHandlers
} from './result/review-result-handlers';
import {
    createReviewRoutingLaunchHandlers
} from './launch/review-routing-launch-handlers';
import {
    analyzeEarlyReviewMaterialization,
    assertExplicitReviewContextRuntimeIdentity,
    assertNoCurrentCycleReviewRecordedBeforeRouting,
    assertPreparedReviewerLaunchArtifact,
    assertReviewContextContractOrThrow,
    assertReviewContextRuntimeIdentityMetadataPresent,
    assertRoutingCompatibility,
    buildCopyPasteReviewerLaunchPrompt,
    buildLosslessPassReviewNormalization,
    buildMinimalPassReviewTemplateHint,
    buildPassReviewTemplateHintMessage,
    buildRecordReviewInvocationCommand,
    buildReviewerLaunchBindingSha256,
    buildReviewerLaunchInputHandoffArtifact,
    COMPLETED_REVIEWER_LAUNCH_EVIDENCE_TYPE,
    findMatchingReviewerLaunchInputPinnedEvent,
    findMatchingReviewerLaunchPreparedEvent,
    findMatchingReviewerInvocationAttestationEvent,
    findRecoverableReviewerLaunchPreparedEvent,
    findMatchingRoutingEvent,
    getCurrentPreparedReviewerLaunchMismatches,
    getReviewerScopedDiffHandoffPaths,
    getReviewTreeStateLaunchSummary,
    getReviewTreeStateSha256,
    getStringField,
    isCurrentCompletedReviewerLaunchArtifact,
    isForbiddenReviewerLaunchAttestationSource,
    isLosslessPassNormalizationEligibleViolation,
    LOCAL_REVIEWER_LAUNCH_TRUST_BOUNDARY,
    normalizeReviewerLaunchAttestationSource,
    parseReviewerIdentity,
    PREPARED_REVIEWER_LAUNCH_ATTESTATION_SOURCE,
    PREPARED_REVIEWER_LAUNCH_EVIDENCE_TYPE,
    printCopyPasteReviewerLaunchPrompt,
    readJsonFile,
    readJsonObjectIfPresent,
    resolveCanonicalPreflightArtifactPath,
    resolveCanonicalReviewPaths,
    resolveProviderLaunchMetadata,
    resolveReviewerDraftOutputPath,
    resolveReviewerHandoffBindings,
    resolveReviewerLaunchArtifactPathForWrite,
    resolveReviewerLaunchInputArtifactPath,
    resolveReviewerLaunchInputAttestation,
    REVIEWER_LAUNCH_COMPLETION_FIELD_HINTS,
    reviewContextRequiresPassValidationNotes,
    snapshotSupersededReviewerLaunchArtifact,
    stringSha256,
    toReviewerHandoffAbsolutePath
} from './support/review-handler-public-support';

export { handleRequiredReviewsCheck, handleDocImpactGate } from './support/simple-handlers';
export {
    assertExplicitReviewContextRuntimeIdentity,
    assertNoCurrentCycleReviewRecordedBeforeRouting,
    assertPreparedReviewerLaunchArtifact,
    assertReviewContextContractOrThrow,
    assertReviewContextRuntimeIdentityMetadataPresent,
    assertRoutingCompatibility,
    buildCopyPasteReviewerLaunchPrompt,
    buildRecordReviewInvocationCommand,
    buildReviewerLaunchBindingSha256,
    buildReviewerLaunchInputHandoffArtifact,
    COMPLETED_REVIEWER_LAUNCH_EVIDENCE_TYPE,
    findMatchingReviewerLaunchInputPinnedEvent,
    findMatchingReviewerLaunchPreparedEvent,
    findRecoverableReviewerLaunchPreparedEvent,
    findMatchingRoutingEvent,
    getCurrentPreparedReviewerLaunchMismatches,
    getReviewerScopedDiffHandoffPaths,
    getReviewTreeStateLaunchSummary,
    getReviewTreeStateSha256,
    getStringField,
    isCurrentCompletedReviewerLaunchArtifact,
    isForbiddenReviewerLaunchAttestationSource,
    LOCAL_REVIEWER_LAUNCH_TRUST_BOUNDARY,
    normalizeReviewerLaunchAttestationSource,
    parseReviewerIdentity,
    PREPARED_REVIEWER_LAUNCH_ATTESTATION_SOURCE,
    PREPARED_REVIEWER_LAUNCH_EVIDENCE_TYPE,
    printCopyPasteReviewerLaunchPrompt,
    readJsonFile,
    readJsonObjectIfPresent,
    resolveCanonicalPreflightArtifactPath,
    resolveProviderLaunchMetadata,
    resolveReviewerDraftOutputPath,
    resolveReviewerHandoffBindings,
    resolveReviewerLaunchArtifactPathForWrite,
    resolveReviewerLaunchInputArtifactPath,
    resolveReviewerLaunchInputAttestation,
    REVIEWER_LAUNCH_COMPLETION_FIELD_HINTS,
    snapshotSupersededReviewerLaunchArtifact,
    stringSha256,
    toReviewerHandoffAbsolutePath,
    type SupersededReviewerLaunchArtifactSnapshot
} from './support/review-handler-public-support';

export let readReviewOutputFromStdin = async (): Promise<string> => {
    if (!process.stdin || process.stdin.isTTY) {
        throw new Error('ReviewOutputStdin requires piped stdin input.');
    }
    process.stdin.setEncoding('utf8');
    let content = '';
    for await (const chunk of process.stdin) {
        content += String(chunk);
    }
    return content;
};

const reviewInvocationHandlers = createReviewInvocationHandlers({
    assertExplicitReviewContextRuntimeIdentity,
    assertReviewContextContractOrThrow,
    assertRoutingCompatibility,
    findMatchingRoutingEvent,
    getReviewTreeStateSha256,
    parseReviewerIdentity,
    resolveCanonicalPreflightArtifactPath,
    resolveReviewerHandoffBindings
});

export const {
    handleRecordReviewInvocation,
    validateReviewerLaunchArtifact
} = reviewInvocationHandlers;
const {
    handleRecordReviewInvocationWithLaneHeld
} = reviewInvocationHandlers;

const reviewRoutingLaunchHandlers = createReviewRoutingLaunchHandlers({
    assertExplicitReviewContextRuntimeIdentity,
    assertNoCurrentCycleReviewRecordedBeforeRouting,
    assertPreparedReviewerLaunchArtifact,
    assertReviewContextContractOrThrow,
    assertRoutingCompatibility,
    buildCopyPasteReviewerLaunchPrompt,
    buildRecordReviewInvocationCommand,
    buildReviewerLaunchBindingSha256,
    buildReviewerLaunchInputHandoffArtifact,
    COMPLETED_REVIEWER_LAUNCH_EVIDENCE_TYPE,
    findMatchingReviewerLaunchInputPinnedEvent,
    findMatchingReviewerLaunchPreparedEvent,
    findRecoverableReviewerLaunchPreparedEvent,
    findMatchingRoutingEvent,
    getCurrentPreparedReviewerLaunchMismatches,
    getReviewTreeStateLaunchSummary,
    getReviewTreeStateSha256,
    getReviewerScopedDiffHandoffPaths,
    getStringField,
    handleRecordReviewInvocation,
    handleRecordReviewInvocationWithLaneHeld,
    isCurrentCompletedReviewerLaunchArtifact,
    isForbiddenReviewerLaunchAttestationSource,
    LOCAL_REVIEWER_LAUNCH_TRUST_BOUNDARY,
    normalizeReviewerLaunchAttestationSource,
    parseReviewerIdentity,
    PREPARED_REVIEWER_LAUNCH_ATTESTATION_SOURCE,
    PREPARED_REVIEWER_LAUNCH_EVIDENCE_TYPE,
    printCopyPasteReviewerLaunchPrompt,
    readJsonFile,
    readJsonObjectIfPresent,
    resolveCanonicalPreflightArtifactPath,
    resolveProviderLaunchMetadata,
    resolveReviewerHandoffBindings,
    resolveReviewerDraftOutputPath,
    resolveReviewerLaunchArtifactPathForWrite,
    resolveReviewerLaunchInputArtifactPath,
    resolveReviewerLaunchInputAttestation,
    REVIEWER_LAUNCH_COMPLETION_FIELD_HINTS,
    snapshotSupersededReviewerLaunchArtifact,
    stringSha256,
    toReviewerHandoffAbsolutePath
});

export const {
    handleRecordReviewRouting,
    handlePrepareReviewerLaunch,
    handleRecordReviewerDelegationStarted,
    handleRecordReviewerLaunchFailed,
    handleCompleteReviewerLaunch
} = reviewRoutingLaunchHandlers;

const reviewResultHandlers = createReviewResultHandlers({
    closedReviewGateCapture: captureClosedReviewGate,
    analyzeEarlyReviewMaterialization,
    assertExplicitReviewContextRuntimeIdentity,
    assertReviewContextContractOrThrow,
    assertReviewContextRuntimeIdentityMetadataPresent,
    assertRoutingCompatibility,
    buildLosslessPassReviewNormalization,
    buildMinimalPassReviewTemplateHint,
    buildPassReviewTemplateHintMessage,
    findMatchingReviewerInvocationAttestationEvent,
    findMatchingRoutingEvent,
    getReviewTreeStateSha256,
    isLosslessPassNormalizationEligibleViolation,
    normalizeReviewSectionHeadings: normalizeCanonicalReviewSectionHeadings,
    parseReviewerIdentity,
    readReviewOutputFromStdin: () => readReviewOutputFromStdin(),
    resolveCanonicalReviewPaths,
    reviewContextRequiresPassValidationNotes
});

export const {
    handleRecordReviewResult,
    handleRecordReviewReceipt,
    handleRecordReviewOutputCorrectionTransport,
    handleRecordReviewOutputCorrectionResponse,
    handleRecordReviewOutputCorrectionInvocation
} = reviewResultHandlers;

export async function handleMaterializeReviewFollowUpTasks(gateArgv: string[]): Promise<void> {
    const { options } = parseOptions(gateArgv, {
        '--task-id': { key: 'taskId', type: 'string' },
        '--review-type': { key: 'reviewType', type: 'string' },
        '--disposition-artifact-path': { key: 'dispositionArtifactPath', type: 'string' },
        '--receipt-path': { key: 'receiptPath', type: 'string' },
        '--artifact-path': { key: 'artifactPath', type: 'string' },
        '--reviews-root': { key: 'reviewsRoot', type: 'string' },
        '--repo-root': { key: 'repoRoot', type: 'string' }
    });
    const result = runMaterializeReviewFollowUpTasksCommand(options);
    process.stdout.write(`${result.outputLines.join('\n')}\n`);
    if (result.exitCode !== 0) {
        process.exitCode = result.exitCode;
    }
}
