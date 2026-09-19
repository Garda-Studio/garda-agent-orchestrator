import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { writeFileAtomically } from '../../core/filesystem';
import { sha256RedactedJsonPayload } from '../../core/redaction';
import { fileSha256 } from '../../gate-runtime/hash';
import { normalizePath } from '../shared/helpers';

export const REVIEW_OUTPUT_CORRECTION_ARTIFACT_TYPE = 'review_output_correction';
export const REVIEW_OUTPUT_CORRECTION_LAUNCH_ARTIFACT_TYPE = 'review_output_correction_launch';
export const REVIEW_OUTPUT_CORRECTION_SCHEMA_VERSION = 2;
export const REVIEW_OUTPUT_CORRECTION_REQUIRED = 'REVIEW_OUTPUT_CORRECTION_REQUIRED';
export const DEFAULT_REVIEW_OUTPUT_CORRECTION_LIMIT = 2;
export const REVIEW_OUTPUT_CORRECTION_FAIL_CLOSED_ATTESTATION_SOURCE =
    'garda_fail_closed_no_provider_session_receipt';

const MISSING_FINDINGS_FINGERPRINT_REASON =
    'Rejected review output has no semantic findings fingerprint; correction-only recovery cannot prove findings preservation.';

const REVIEW_OUTPUT_CORRECTION_TRANSPORT_EVENT_TYPES = new Set([
    'REVIEW_OUTPUT_CORRECTION_LIVE_CONTINUATION',
    'REVIEW_OUTPUT_CORRECTION_API_CONTINUATION',
    'REVIEW_OUTPUT_CORRECTION_ONLY_INVOCATION',
    'REVIEW_OUTPUT_CORRECTION_FULL_REVIEW_REQUIRED'
]);

export type ReviewOutputCorrectionState =
    | typeof REVIEW_OUTPUT_CORRECTION_REQUIRED
    | 'CORRECTION_ACCEPTED'
    | 'FULL_REVIEW_REQUIRED';

export type ReviewOutputCorrectionDiagnosticCategory = 'mechanical' | 'semantic' | 'provenance';

export type ReviewOutputCorrectionDiagnosticCode =
    | 'SCHEMA_BINDING'
    | 'TASK_BINDING'
    | 'REVIEW_TYPE_BINDING'
    | 'CONTEXT_BINDING'
    | 'TREE_BINDING'
    | 'COVERAGE_BINDING'
    | 'EXECUTION_BINDING'
    | 'FINDINGS_SEMANTICS'
    | 'PROVENANCE_BINDING'
    | 'UNCLASSIFIED_VALIDATION';

export interface ReviewOutputCorrectionDiagnostic {
    code: ReviewOutputCorrectionDiagnosticCode;
    category: ReviewOutputCorrectionDiagnosticCategory;
    message: string;
    mechanically_correctable: boolean;
}

export type ReviewOutputCorrectionTransport =
    | 'gate_normalization'
    | 'live_reviewer_continuation'
    | 'api_conversation_continuation'
    | 'correction_only_invocation'
    | 'full_reviewer_relaunch';

export interface ReviewOutputCorrectionCapabilities {
    gate_normalization: boolean;
    live_reviewer_continuation: boolean;
    api_conversation_continuation: boolean;
    correction_only_invocation: boolean;
}

export type ReviewOutputCorrectionSessionAvailability =
    | 'pending'
    | 'available'
    | 'closed'
    | 'stateless'
    | 'not_applicable';

export interface ReviewOutputCorrectionTransportAttestation {
    reviewer_identity: string;
    provider_invocation_id: string;
    attestation_source: string;
    evidence_type: 'provider_native_session_receipt' | 'fail_closed_no_provider_session_receipt';
    provider_invocation_event_sha256?: string | null;
    provider_response_event_sha256?: string | null;
    provider_response_sha256?: string | null;
    recorded_at_utc: string;
}

export interface ReviewOutputCorrectionTransportBinding {
    provider_id: string | null;
    provider_invocation_id: string | null;
    provider_capabilities: {
        live_reviewer_continuation: boolean;
        api_conversation_continuation: boolean;
        correction_only_invocation: boolean;
    };
    provider_capabilities_sha256: string;
    session_availability: ReviewOutputCorrectionSessionAvailability;
    availability_attestation: ReviewOutputCorrectionTransportAttestation | null;
}

export interface ReviewOutputCorrectionBinding {
    original_output_path: string;
    original_output_sha256: string;
    correction_input_path?: string;
    correction_input_sha256?: string;
    review_context_path: string;
    review_context_sha256: string;
    review_tree_state_sha256: string;
    reviewer_identity: string;
    reviewer_attempt_id: string;
    reviewer_invocation_event_sha256: string | null;
    findings_semantic_fingerprint: string | null;
    validation_artifact_path: string;
    validation_artifact_sha256: string;
}

export type ReviewOutputCorrectionProviderAction =
    | 'gate_normalization'
    | 'continue_delegated_reviewer'
    | 'continue_api_conversation'
    | 'launch_correction_only_reviewer'
    | 'launch_full_reviewer';

export interface ReviewOutputCorrectionHandoff {
    provider_action: ReviewOutputCorrectionProviderAction;
    launch_input_mode: 'review_output_correction_artifact_path';
    launch_input_artifact_path: string | null;
    provider_response_output_path: string | null;
    target_reviewer_identity: string | null;
    fork_context: false | null;
    result_delivery: 'record_review_result_stdin';
    instruction: string;
}

export interface ReviewOutputCorrectionArtifact {
    schema_version: 1 | typeof REVIEW_OUTPUT_CORRECTION_SCHEMA_VERSION;
    artifact_type: typeof REVIEW_OUTPUT_CORRECTION_ARTIFACT_TYPE;
    task_id: string;
    review_type: string;
    state: ReviewOutputCorrectionState;
    created_at_utc: string;
    updated_at_utc: string;
    binding: ReviewOutputCorrectionBinding;
    transport_binding?: ReviewOutputCorrectionTransportBinding;
    producer_response_attestation?: ReviewOutputCorrectionTransportAttestation;
    diagnostics: ReviewOutputCorrectionDiagnostic[];
    recovery: {
        correction_attempt: number;
        max_correction_attempts: number;
        selected_transport: ReviewOutputCorrectionTransport;
        available_transports: ReviewOutputCorrectionTransport[];
        reason: string;
        handoff?: ReviewOutputCorrectionHandoff;
    };
    artifact_sha256?: string;
}

export interface ReviewOutputMechanicalBindings {
    taskId: string;
    reviewType: string;
    reviewContextSha256: string;
    reviewTreeStateSha256: string;
    coverageContractSha256?: string | null;
    reviewExecution?: Record<string, unknown> | null;
}

export interface ReviewOutputCorrectionTransportAdapter {
    id: string;
    capabilities: ReviewOutputCorrectionCapabilities;
    probeLiveReviewerAvailability?: (
        correction: ReviewOutputCorrectionArtifact
    ) => Promise<'available' | 'closed' | 'stateless'>;
    continueReview?: (correction: ReviewOutputCorrectionArtifact) => Promise<string>;
    continueApiConversation?: (correction: ReviewOutputCorrectionArtifact) => Promise<string>;
    invokeCorrectionOnly?: (correction: ReviewOutputCorrectionArtifact) => Promise<string>;
    recordTelemetry?: (event: ReviewOutputCorrectionTransportTelemetry) => Promise<void> | void;
}

export interface ReviewOutputCorrectionTransportTelemetry {
    event:
        | 'live_continuation'
        | 'api_continuation'
        | 'correction_only_invocation'
        | 'full_reviewer_relaunch';
    task_id: string;
    review_type: string;
    adapter_id: string;
    correction_attempt: number;
    selected_transport: ReviewOutputCorrectionTransport;
    session_availability: ReviewOutputCorrectionSessionAvailability;
    reason: string;
}

export interface ReviewOutputCorrectionVerification {
    valid: boolean;
    requires_full_review: boolean;
    violations: string[];
}

export interface ReviewOutputCorrectionProducerAttestation {
    producer_identity: string;
    provider_invocation_id: string;
    provider_invocation_event_sha256: string;
    attestation_source: string;
    launch_input_sha256: string;
    fork_context: boolean | null;
}

export interface ReviewOutputCorrectionProducerInvocationEvidence {
    event_type: string;
    event_sha256: string;
    reviewer_identity: string;
    reviewer_attempt_id: string;
    provider_invocation_id: string;
    attestation_source: string;
    review_context_sha256: string;
    launch_input_sha256: string;
    delegation_started_event_type: string;
    delegation_started_event_sha256: string;
    delegation_started_reviewer_identity: string;
    delegation_started_provider_invocation_id: string;
    correction_launch_artifact_sha256: string;
    provider_response_event_type?: string;
    provider_response_event_sha256?: string;
    provider_response_sha256?: string;
}

const MECHANICAL_PATTERNS: ReadonlyArray<readonly [RegExp, ReviewOutputCorrectionDiagnosticCode]> = [
    [/schema_version/iu, 'SCHEMA_BINDING'],
    [/task_id/iu, 'TASK_BINDING'],
    [/review_type/iu, 'REVIEW_TYPE_BINDING'],
    [/review_context_sha256/iu, 'CONTEXT_BINDING'],
    [/tree_state_sha256/iu, 'TREE_BINDING'],
    [/coverage_contract_sha256/iu, 'COVERAGE_BINDING'],
    [/review_execution(?:\.|\b)|execution evidence|execution contract/iu, 'EXECUTION_BINDING']
];

const PROVENANCE_PATTERN = /provenance|reviewer identity|reviewer attempt|tamper|original output|context changed|tree state changed/iu;
const SEMANTIC_PATTERN = /findings?\.|finding\b|residual_risks?|evidence\b|validation_notes?|coverage_ledger\.entries/iu;

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeSha256(value: unknown): string | null {
    const normalized = String(value || '').trim().toLowerCase();
    return /^[0-9a-f]{64}$/u.test(normalized) ? normalized : null;
}

export function hasCommittedReviewOutputCorrectionTransportEvent(options: {
    timelineEvents: readonly unknown[];
    reviewType: string;
    correctionArtifactSha256: string;
    correctionPackageSha256: string;
}): boolean {
    const reviewType = String(options.reviewType || '').trim().toLowerCase();
    const correctionArtifactSha256 = normalizeSha256(options.correctionArtifactSha256);
    const correctionPackageSha256 = normalizeSha256(options.correctionPackageSha256);
    if (!reviewType || !correctionArtifactSha256 || !correctionPackageSha256) {
        return false;
    }
    return options.timelineEvents.some((value) => {
        if (!isRecord(value) || !REVIEW_OUTPUT_CORRECTION_TRANSPORT_EVENT_TYPES.has(
            String(value.event_type || '')
        )) {
            return false;
        }
        const details = isRecord(value.details) ? value.details : {};
        const integrity = isRecord(value.integrity) ? value.integrity : {};
        return normalizeSha256(integrity.event_sha256) !== null
            && String(details.review_type || details.reviewType || '').trim().toLowerCase() === reviewType
            && normalizeSha256(details.correction_artifact_sha256) === correctionArtifactSha256
            && normalizeSha256(details.correction_package_sha256) === correctionPackageSha256;
    });
}

function canonicalize(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(canonicalize);
    }
    if (!isRecord(value)) {
        return value;
    }
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function hashText(value: string): string {
    return createHash('sha256').update(value).digest('hex');
}

export function computeRawReviewOutputSha256(rawOutput: string): string {
    return hashText(rawOutput);
}

function safeParseJsonObject(content: string): Record<string, unknown> | null {
    try {
        const parsed = JSON.parse(content) as unknown;
        return isRecord(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

export function computeReviewFindingsSemanticFingerprint(content: string): string | null {
    const parsed = safeParseJsonObject(content);
    const findings = isRecord(parsed?.findings) ? parsed.findings : null;
    if (!findings) {
        return null;
    }
    return sha256RedactedJsonPayload(canonicalize(findings));
}

export function buildReviewOutputCorrectionHandoff(options: {
    transport: ReviewOutputCorrectionTransport;
    reviewerIdentity: string;
    correctionArtifactPath?: string | null;
    correctionAttempt?: number;
}): ReviewOutputCorrectionHandoff {
    const launchInputArtifactPath = options.correctionArtifactPath
        ? normalizePath(options.correctionArtifactPath)
        : null;
    const common = {
        launch_input_mode: 'review_output_correction_artifact_path' as const,
        launch_input_artifact_path: launchInputArtifactPath,
        provider_response_output_path: null,
        result_delivery: 'record_review_result_stdin' as const
    };
    if (options.transport === 'live_reviewer_continuation') {
        return {
            ...common,
            provider_action: 'continue_delegated_reviewer',
            target_reviewer_identity: options.reviewerIdentity,
            fork_context: null,
            instruction:
                'Continue the named delegated reviewer with only ReviewerCorrectionInputArtifactPath. ' +
                'The reviewer must apply the bound validator diagnostics without changing findings, return exactly one corrected JSON object, ' +
                'and stop; then pipe that object to the navigator-provided record-review-result command.'
        };
    }
    if (options.transport === 'api_conversation_continuation') {
        return {
            ...common,
            provider_action: 'continue_api_conversation',
            target_reviewer_identity: options.reviewerIdentity,
            fork_context: null,
            instruction:
                'Continue the bound provider conversation with only ReviewerCorrectionInputArtifactPath. ' +
                'Return exactly one corrected JSON object without changing findings, then pipe it to the navigator-provided record-review-result command.'
        };
    }
    if (options.transport === 'correction_only_invocation') {
        const correctionAttempt = Math.max(1, options.correctionAttempt || 1);
        const providerResponseOutputPath = options.correctionArtifactPath
            ? normalizePath(`${options.correctionArtifactPath}.attempt-${correctionAttempt}.provider-response.json`)
            : null;
        return {
            ...common,
            provider_response_output_path: providerResponseOutputPath,
            provider_action: 'launch_correction_only_reviewer',
            target_reviewer_identity: null,
            fork_context: false,
            instruction:
                'Launch one clean-context correction-only reviewer with only ReviewerCorrectionInputArtifactPath. ' +
                'The reviewer must read the latest rejected review JSON from binding.correction_input_path, apply only the bound diagnostics, ' +
                'and preserve the findings object exactly. It must write exactly one corrected review JSON object, without a wrapper or prose, ' +
                'to recovery.handoff.provider_response_output_path, return those same bytes, and stop. ' +
                'The reviewer must not run Garda, invoke workflow gates, or modify any other source, task, review, receipt, or control artifact. ' +
                'The main agent must wait for the reviewer, rerun next-step, and use the navigator-provided commands; ' +
                'the reviewer must not record its own result.'
        };
    }
    return {
        ...common,
        provider_action: options.transport === 'gate_normalization'
            ? 'gate_normalization'
            : 'launch_full_reviewer',
        target_reviewer_identity: null,
        fork_context: options.transport === 'full_reviewer_relaunch' ? false : null,
        instruction: options.transport === 'gate_normalization'
            ? 'No provider action is required; the gate owns deterministic normalization.'
            : 'Correction-only recovery is unavailable; restart the review cycle and launch one fresh full reviewer.'
    };
}

export function classifyReviewOutputCorrectionDiagnostics(
    violations: readonly string[]
): ReviewOutputCorrectionDiagnostic[] {
    return violations.map((rawViolation) => {
        const message = String(rawViolation || '').trim() || 'Review output validation failed without details.';
        const mechanical = MECHANICAL_PATTERNS.find(([pattern]) => pattern.test(message));
        if (mechanical && !SEMANTIC_PATTERN.test(message.replace(mechanical[0], ''))) {
            return {
                code: mechanical[1],
                category: 'mechanical' as const,
                message,
                mechanically_correctable: true
            };
        }
        if (PROVENANCE_PATTERN.test(message)) {
            return {
                code: 'PROVENANCE_BINDING' as const,
                category: 'provenance' as const,
                message,
                mechanically_correctable: false
            };
        }
        if (SEMANTIC_PATTERN.test(message)) {
            return {
                code: 'FINDINGS_SEMANTICS' as const,
                category: 'semantic' as const,
                message,
                mechanically_correctable: false
            };
        }
        return {
            code: 'UNCLASSIFIED_VALIDATION' as const,
            category: 'semantic' as const,
            message,
            mechanically_correctable: false
        };
    });
}

export function normalizeReviewOutputMechanically(options: {
    content: string;
    diagnostics: readonly ReviewOutputCorrectionDiagnostic[];
    bindings: ReviewOutputMechanicalBindings;
}): { normalized: boolean; content: string; fingerprint: string | null } {
    if (
        options.diagnostics.length === 0
        || options.diagnostics.some((diagnostic) => !diagnostic.mechanically_correctable)
    ) {
        return {
            normalized: false,
            content: options.content,
            fingerprint: computeReviewFindingsSemanticFingerprint(options.content)
        };
    }
    const parsed = safeParseJsonObject(options.content);
    if (!parsed) {
        return { normalized: false, content: options.content, fingerprint: null };
    }
    const originalFingerprint = computeReviewFindingsSemanticFingerprint(options.content);
    parsed.schema_version = 2;
    parsed.task_id = options.bindings.taskId;
    parsed.review_type = options.bindings.reviewType;
    parsed.review_context_sha256 = options.bindings.reviewContextSha256;
    parsed.tree_state_sha256 = options.bindings.reviewTreeStateSha256;
    if (isRecord(parsed.coverage_ledger) && normalizeSha256(options.bindings.coverageContractSha256)) {
        parsed.coverage_ledger.coverage_contract_sha256 = normalizeSha256(options.bindings.coverageContractSha256);
    }
    if (options.bindings.reviewExecution) {
        parsed.review_execution = structuredClone(options.bindings.reviewExecution);
    }
    const normalizedContent = `${JSON.stringify(parsed, null, 2)}\n`;
    if (computeReviewFindingsSemanticFingerprint(normalizedContent) !== originalFingerprint) {
        throw new Error('Gate-owned mechanical normalization changed the findings semantic fingerprint.');
    }
    return { normalized: normalizedContent !== options.content, content: normalizedContent, fingerprint: originalFingerprint };
}

export function resolveReviewOutputCorrectionTransport(options: {
    diagnostics: readonly ReviewOutputCorrectionDiagnostic[];
    capabilities: ReviewOutputCorrectionCapabilities;
    correctionAttempt: number;
    maxCorrectionAttempts?: number;
    forceFullReviewReasons?: readonly string[];
    sessionAvailability?: ReviewOutputCorrectionSessionAvailability;
}): { transport: ReviewOutputCorrectionTransport; reason: string; available: ReviewOutputCorrectionTransport[] } {
    const limit = options.maxCorrectionAttempts ?? DEFAULT_REVIEW_OUTPUT_CORRECTION_LIMIT;
    const available: ReviewOutputCorrectionTransport[] = [];
    if (options.capabilities.gate_normalization) available.push('gate_normalization');
    if (options.capabilities.live_reviewer_continuation) available.push('live_reviewer_continuation');
    if (options.capabilities.api_conversation_continuation) available.push('api_conversation_continuation');
    if (options.capabilities.correction_only_invocation) available.push('correction_only_invocation');
    available.push('full_reviewer_relaunch');
    const forceReasons = (options.forceFullReviewReasons || []).map((reason) => reason.trim()).filter(Boolean);
    if (forceReasons.length > 0) {
        return { transport: 'full_reviewer_relaunch', reason: forceReasons.join(' '), available };
    }
    if (options.correctionAttempt > limit) {
        return {
            transport: 'full_reviewer_relaunch',
            reason: `Correction recovery exhausted its bound of ${limit} attempt(s).`,
            available
        };
    }
    const mechanicalOnly = options.diagnostics.length > 0
        && options.diagnostics.every((diagnostic) => diagnostic.mechanically_correctable);
    if (mechanicalOnly && options.capabilities.gate_normalization) {
        return { transport: 'gate_normalization', reason: 'All violations are mechanically derivable bindings.', available };
    }
    if (
        options.capabilities.live_reviewer_continuation
        && !['closed', 'stateless', 'not_applicable'].includes(options.sessionAvailability || 'available')
    ) {
        return {
            transport: 'live_reviewer_continuation',
            reason: options.sessionAvailability === 'pending'
                ? 'The provider declares live continuation; controller availability must be attested.'
                : 'The original delegated reviewer session is available.',
            available
        };
    }
    if (options.capabilities.api_conversation_continuation) {
        return { transport: 'api_conversation_continuation', reason: 'The provider supports bound conversation continuation.', available };
    }
    if (options.capabilities.correction_only_invocation) {
        return { transport: 'correction_only_invocation', reason: 'Use one bounded correction-only invocation.', available };
    }
    return {
        transport: 'full_reviewer_relaunch',
        reason: 'No authenticated correction transport is available.',
        available
    };
}

export function computeReviewOutputCorrectionProviderCapabilitiesSha256(options: {
    providerId: string | null;
    capabilities: Pick<
    ReviewOutputCorrectionCapabilities,
    'live_reviewer_continuation' | 'api_conversation_continuation' | 'correction_only_invocation'
    >;
}): string {
    return sha256RedactedJsonPayload({
        provider_id: String(options.providerId || '').trim() || null,
        live_reviewer_continuation: options.capabilities.live_reviewer_continuation === true,
        api_conversation_continuation: options.capabilities.api_conversation_continuation === true,
        correction_only_invocation: options.capabilities.correction_only_invocation === true
    });
}

export function getReviewOutputCorrectionArtifactPath(reviewArtifactPath: string): string {
    return String(reviewArtifactPath || '').replace(/\.md$/u, '-output-correction.json');
}

export function getReviewOutputCorrectionLaunchArtifactPath(reviewArtifactPath: string): string {
    return String(reviewArtifactPath || '').replace(/\.md$/u, '-output-correction-launch.json');
}

function getCorrectionLaunchPathFromCorrectionArtifactPath(correctionArtifactPath: string): string {
    const normalized = String(correctionArtifactPath || '');
    if (!/-output-correction\.json$/u.test(normalized)) {
        throw new Error('Review output correction artifact path has an invalid canonical suffix.');
    }
    return normalized.replace(/-output-correction\.json$/u, '-output-correction-launch.json');
}

export function getRejectedReviewOutputArtifactPath(reviewArtifactPath: string, outputSha256: string): string {
    return String(reviewArtifactPath || '').replace(/\.md$/u, `-rejected-output-${outputSha256}.md`);
}

function withArtifactSha256(
    artifact: Omit<ReviewOutputCorrectionArtifact, 'artifact_sha256'>
): ReviewOutputCorrectionArtifact {
    const unhashed = { ...artifact } as ReviewOutputCorrectionArtifact;
    delete unhashed.artifact_sha256;
    return {
        ...unhashed,
        artifact_sha256: sha256RedactedJsonPayload(unhashed)
    };
}

export function buildReviewOutputCorrectionArtifact(options: {
    taskId: string;
    reviewType: string;
    rejectedOutputPath: string;
    rejectedOutputSha256: string;
    rejectedOutputContent?: string;
    reviewContextPath: string;
    reviewContextSha256: string;
    reviewTreeStateSha256: string;
    reviewerIdentity: string;
    reviewerAttemptId: string;
    reviewerInvocationEventSha256: string | null;
    validationArtifactPath: string;
    validationArtifactSha256: string;
    violations: readonly string[];
    correctionAttempt?: number;
    maxCorrectionAttempts?: number;
    capabilities?: Partial<ReviewOutputCorrectionCapabilities>;
    providerId?: string | null;
    providerInvocationId?: string | null;
    sessionAvailability?: ReviewOutputCorrectionSessionAvailability;
    now?: string;
}): ReviewOutputCorrectionArtifact {
    const diagnostics = classifyReviewOutputCorrectionDiagnostics(options.violations);
    const correctionAttempt = Math.max(1, options.correctionAttempt || 1);
    const maxCorrectionAttempts = Math.max(1, options.maxCorrectionAttempts || DEFAULT_REVIEW_OUTPUT_CORRECTION_LIMIT);
    const rejectedContent = options.rejectedOutputContent ?? (
        fs.existsSync(options.rejectedOutputPath)
            ? fs.readFileSync(options.rejectedOutputPath, 'utf8')
            : ''
    );
    const findingsSemanticFingerprint = rejectedContent
        ? computeReviewFindingsSemanticFingerprint(rejectedContent)
        : null;
    const capabilities: ReviewOutputCorrectionCapabilities = {
        gate_normalization: options.capabilities?.gate_normalization === true,
        live_reviewer_continuation: options.capabilities?.live_reviewer_continuation === true,
        api_conversation_continuation: options.capabilities?.api_conversation_continuation === true,
        correction_only_invocation: options.capabilities?.correction_only_invocation !== false
    };
    const providerCapabilities = {
        live_reviewer_continuation: capabilities.live_reviewer_continuation,
        api_conversation_continuation: capabilities.api_conversation_continuation,
        correction_only_invocation: capabilities.correction_only_invocation
    };
    const sessionAvailability = options.sessionAvailability || (
        capabilities.live_reviewer_continuation
            ? 'pending'
            : capabilities.api_conversation_continuation ? 'stateless' : 'not_applicable'
    );
    const recovery = resolveReviewOutputCorrectionTransport({
        diagnostics,
        capabilities,
        correctionAttempt,
        maxCorrectionAttempts,
        sessionAvailability,
        forceFullReviewReasons: findingsSemanticFingerprint
            ? []
            : [MISSING_FINDINGS_FINGERPRINT_REASON]
    });
    const timestamp = options.now || new Date().toISOString();
    const artifact: Omit<ReviewOutputCorrectionArtifact, 'artifact_sha256'> = {
        schema_version: REVIEW_OUTPUT_CORRECTION_SCHEMA_VERSION,
        artifact_type: REVIEW_OUTPUT_CORRECTION_ARTIFACT_TYPE,
        task_id: options.taskId,
        review_type: options.reviewType,
        state: recovery.transport === 'full_reviewer_relaunch'
            ? 'FULL_REVIEW_REQUIRED'
            : REVIEW_OUTPUT_CORRECTION_REQUIRED,
        created_at_utc: timestamp,
        updated_at_utc: timestamp,
        binding: {
            original_output_path: normalizePath(options.rejectedOutputPath),
            original_output_sha256: options.rejectedOutputSha256.toLowerCase(),
            correction_input_path: normalizePath(options.rejectedOutputPath),
            correction_input_sha256: options.rejectedOutputSha256.toLowerCase(),
            review_context_path: normalizePath(options.reviewContextPath),
            review_context_sha256: options.reviewContextSha256.toLowerCase(),
            review_tree_state_sha256: options.reviewTreeStateSha256.toLowerCase(),
            reviewer_identity: options.reviewerIdentity,
            reviewer_attempt_id: options.reviewerAttemptId,
            reviewer_invocation_event_sha256: normalizeSha256(options.reviewerInvocationEventSha256),
            findings_semantic_fingerprint: findingsSemanticFingerprint,
            validation_artifact_path: normalizePath(options.validationArtifactPath),
            validation_artifact_sha256: options.validationArtifactSha256.toLowerCase()
        },
        transport_binding: {
            provider_id: String(options.providerId || '').trim() || null,
            provider_invocation_id: String(options.providerInvocationId || '').trim() || null,
            provider_capabilities: providerCapabilities,
            provider_capabilities_sha256: computeReviewOutputCorrectionProviderCapabilitiesSha256({
                providerId: options.providerId || null,
                capabilities: providerCapabilities
            }),
            session_availability: sessionAvailability,
            availability_attestation: null
        },
        diagnostics,
        recovery: {
            correction_attempt: correctionAttempt,
            max_correction_attempts: maxCorrectionAttempts,
            selected_transport: recovery.transport,
            available_transports: recovery.available,
            reason: recovery.reason,
            handoff: buildReviewOutputCorrectionHandoff({
                transport: recovery.transport,
                reviewerIdentity: options.reviewerIdentity,
                correctionAttempt
            })
        }
    };
    return withArtifactSha256(artifact);
}

function assertFailClosedCorrectionAttestationSource(value: string): string {
    const normalized = String(value || '').trim().toLowerCase();
    if (normalized !== REVIEW_OUTPUT_CORRECTION_FAIL_CLOSED_ATTESTATION_SOURCE) {
        throw new Error(
            'Closed or stateless correction transport must use the canonical fail-closed attestation source.'
        );
    }
    return normalized;
}

export function isProviderOwnedReviewOutputCorrectionSessionAttestationSource(value: string): boolean {
    const normalized = String(value || '').trim().toLowerCase();
    return Boolean(normalized)
        && normalized !== REVIEW_OUTPUT_CORRECTION_FAIL_CLOSED_ATTESTATION_SOURCE
        && !/^(?:unknown|n\/a|na|null|none|manual|mock|test|placeholder|<.*>)$/iu.test(normalized)
        && /(?:followup|session|conversation|continuation|resume|spawn|subagent|task|tool|launch|run|invocation)/iu.test(
            normalized
        );
}

function assertProviderOwnedCorrectionSessionAttestationSource(value: string): string {
    const normalized = String(value || '').trim().toLowerCase();
    if (!isProviderOwnedReviewOutputCorrectionSessionAttestationSource(normalized)) {
        throw new Error(
            'Live correction transport requires a provider/controller-owned live-session attestation source.'
        );
    }
    return normalized;
}

export function requiresReviewOutputCorrectionFailClosedAvailabilityEvidence(options: {
    sessionAvailability: ReviewOutputCorrectionSessionAvailability;
    selectedTransport: ReviewOutputCorrectionTransport;
    providerCapabilities: Pick<
        ReviewOutputCorrectionTransportBinding['provider_capabilities'],
        'live_reviewer_continuation'
    >;
}
): boolean {
    if (options.sessionAvailability === 'closed') return true;
    if (options.sessionAvailability !== 'stateless') return false;
    return !(
        options.selectedTransport === 'api_conversation_continuation'
        && !options.providerCapabilities.live_reviewer_continuation
    );
}

function artifactRequiresFailClosedAvailabilityEvidence(
    artifact: ReviewOutputCorrectionArtifact
): boolean {
    const binding = artifact.transport_binding;
    if (!binding) return false;
    if (
        artifact.state === 'CORRECTION_ACCEPTED'
        && artifact.recovery.selected_transport === 'api_conversation_continuation'
        && binding.availability_attestation?.evidence_type === 'provider_native_session_receipt'
    ) {
        return false;
    }
    return requiresReviewOutputCorrectionFailClosedAvailabilityEvidence({
        sessionAvailability: binding.session_availability,
        selectedTransport: artifact.recovery.selected_transport,
        providerCapabilities: binding.provider_capabilities
    });
}

export function buildReviewOutputCorrectionTransportSelection(options: {
    artifactPath: string;
    artifact: ReviewOutputCorrectionArtifact;
    sessionAvailability: Extract<ReviewOutputCorrectionSessionAvailability, 'closed' | 'stateless'>;
    reviewerIdentity: string;
    providerInvocationId: string;
    attestationSource: string;
    now?: string;
}): ReviewOutputCorrectionArtifact {
    if (options.artifact.state !== REVIEW_OUTPUT_CORRECTION_REQUIRED) {
        throw new Error('Correction transport selection requires a pending correction package.');
    }
    const binding = options.artifact.transport_binding;
    if (!binding) {
        throw new Error('Correction transport selection requires provider capability evidence.');
    }
    if (binding.session_availability !== 'pending') {
        throw new Error('Correction transport availability is already frozen for this correction attempt.');
    }
    const expectedCapabilitiesSha256 = computeReviewOutputCorrectionProviderCapabilitiesSha256({
        providerId: binding.provider_id,
        capabilities: binding.provider_capabilities
    });
    if (binding.provider_capabilities_sha256 !== expectedCapabilitiesSha256) {
        throw new Error('Correction transport provider capability evidence is invalid.');
    }
    if (options.reviewerIdentity !== options.artifact.binding.reviewer_identity) {
        throw new Error('Correction transport availability must attest the original reviewer identity.');
    }
    if (
        !binding.provider_invocation_id
        || options.providerInvocationId !== binding.provider_invocation_id
    ) {
        throw new Error('Correction transport availability does not match the original provider invocation.');
    }
    const attestationSource = assertFailClosedCorrectionAttestationSource(options.attestationSource);
    const capabilities: ReviewOutputCorrectionCapabilities = {
        gate_normalization: false,
        ...binding.provider_capabilities
    };
    const recovery = resolveReviewOutputCorrectionTransport({
        diagnostics: options.artifact.diagnostics,
        capabilities,
        correctionAttempt: options.artifact.recovery.correction_attempt,
        maxCorrectionAttempts: options.artifact.recovery.max_correction_attempts,
        sessionAvailability: options.sessionAvailability
    });
    const timestamp = options.now || new Date().toISOString();
    const correctionInputPath = options.artifact.binding.correction_input_path
        || options.artifact.binding.original_output_path;
    const correctionInputSha256 = normalizeSha256(
        options.artifact.binding.correction_input_sha256
    ) || normalizeSha256(options.artifact.binding.original_output_sha256);
    if (!correctionInputSha256) {
        throw new Error('Correction transport selection requires an authenticated correction input binding.');
    }
    const updatedWithoutHash: Omit<ReviewOutputCorrectionArtifact, 'artifact_sha256'> = {
        ...options.artifact,
        schema_version: REVIEW_OUTPUT_CORRECTION_SCHEMA_VERSION,
        updated_at_utc: timestamp,
        binding: {
            ...options.artifact.binding,
            correction_input_path: correctionInputPath,
            correction_input_sha256: correctionInputSha256
        },
        transport_binding: {
            ...binding,
            session_availability: options.sessionAvailability,
            availability_attestation: {
                reviewer_identity: options.reviewerIdentity,
                provider_invocation_id: options.providerInvocationId,
                attestation_source: attestationSource,
                evidence_type: 'fail_closed_no_provider_session_receipt',
                recorded_at_utc: timestamp
            }
        },
        state: recovery.transport === 'full_reviewer_relaunch'
            ? 'FULL_REVIEW_REQUIRED' as const
            : REVIEW_OUTPUT_CORRECTION_REQUIRED,
        recovery: {
            ...options.artifact.recovery,
            selected_transport: recovery.transport,
            available_transports: recovery.available,
            reason: recovery.reason,
            handoff: buildReviewOutputCorrectionHandoff({
                transport: recovery.transport,
                reviewerIdentity: options.artifact.binding.reviewer_identity,
                correctionArtifactPath: options.artifactPath,
                correctionAttempt: options.artifact.recovery.correction_attempt
            })
        }
    };
    return withArtifactSha256(updatedWithoutHash);
}

interface ReviewOutputCorrectionProviderContinuationAcceptanceOptions {
    artifactPath: string;
    artifact: ReviewOutputCorrectionArtifact;
    reviewerIdentity: string;
    providerInvocationId: string;
    providerInvocationEventSha256: string;
    providerResponseEventSha256: string;
    providerResponseSha256: string;
    attestationSource: string;
    reason: string;
    now?: string;
}

function buildReviewOutputCorrectionProviderContinuationAcceptance(
    options: ReviewOutputCorrectionProviderContinuationAcceptanceOptions,
    selectedTransport: 'live_reviewer_continuation' | 'api_conversation_continuation'
): ReviewOutputCorrectionArtifact {
    const binding = options.artifact.transport_binding;
    const invocationEventSha256 = normalizeSha256(options.providerInvocationEventSha256);
    const providerResponseEventSha256 = normalizeSha256(options.providerResponseEventSha256);
    const providerResponseSha256 = normalizeSha256(options.providerResponseSha256);
    const isLiveContinuation = selectedTransport === 'live_reviewer_continuation';
    const providerCapability = isLiveContinuation
        ? binding?.provider_capabilities.live_reviewer_continuation
        : binding?.provider_capabilities.api_conversation_continuation;
    const expectedSessionAvailability: ReviewOutputCorrectionSessionAvailability = isLiveContinuation
        ? 'pending'
        : 'stateless';
    if (
        options.artifact.state !== REVIEW_OUTPUT_CORRECTION_REQUIRED
        || options.artifact.recovery.selected_transport !== selectedTransport
        || !binding
        || binding.session_availability !== expectedSessionAvailability
        || providerCapability !== true
    ) {
        throw new Error(
            `Provider correction acceptance requires a pending '${selectedTransport}' correction package.`
        );
    }
    if (
        options.reviewerIdentity !== options.artifact.binding.reviewer_identity
        || options.providerInvocationId !== binding.provider_invocation_id
        || invocationEventSha256 !== options.artifact.binding.reviewer_invocation_event_sha256
    ) {
        throw new Error('Provider correction acceptance does not match the original provider-owned reviewer invocation.');
    }
    if (!providerResponseEventSha256 || !providerResponseSha256) {
        throw new Error('Provider correction acceptance requires a provider-attested hashed correction response.');
    }
    const attestationSource = assertProviderOwnedCorrectionSessionAttestationSource(options.attestationSource);
    const timestamp = options.now || new Date().toISOString();
    return withArtifactSha256({
        ...options.artifact,
        state: 'CORRECTION_ACCEPTED',
        updated_at_utc: timestamp,
        transport_binding: {
            ...binding,
            session_availability: isLiveContinuation ? 'available' : 'stateless',
            availability_attestation: {
                reviewer_identity: options.reviewerIdentity,
                provider_invocation_id: options.providerInvocationId,
                provider_invocation_event_sha256: invocationEventSha256,
                provider_response_event_sha256: providerResponseEventSha256,
                provider_response_sha256: providerResponseSha256,
                attestation_source: attestationSource,
                evidence_type: 'provider_native_session_receipt',
                recorded_at_utc: timestamp
            }
        },
        recovery: {
            ...options.artifact.recovery,
            selected_transport: selectedTransport,
            reason: options.reason,
            handoff: buildReviewOutputCorrectionHandoff({
                transport: selectedTransport,
                reviewerIdentity: options.reviewerIdentity,
                correctionArtifactPath: options.artifactPath,
                correctionAttempt: options.artifact.recovery.correction_attempt
            })
        }
    });
}

export function buildReviewOutputCorrectionLiveContinuationAcceptance(
    options: ReviewOutputCorrectionProviderContinuationAcceptanceOptions
): ReviewOutputCorrectionArtifact {
    return buildReviewOutputCorrectionProviderContinuationAcceptance(
        options,
        'live_reviewer_continuation'
    );
}

export function buildReviewOutputCorrectionApiContinuationAcceptance(
    options: ReviewOutputCorrectionProviderContinuationAcceptanceOptions
): ReviewOutputCorrectionArtifact {
    return buildReviewOutputCorrectionProviderContinuationAcceptance(
        options,
        'api_conversation_continuation'
    );
}

export function buildReviewOutputCorrectionCorrectionOnlyAcceptance(
    options: ReviewOutputCorrectionProviderContinuationAcceptanceOptions
): ReviewOutputCorrectionArtifact {
    const binding = options.artifact.transport_binding;
    const invocationEventSha256 = normalizeSha256(options.providerInvocationEventSha256);
    const providerResponseEventSha256 = normalizeSha256(options.providerResponseEventSha256);
    const providerResponseSha256 = normalizeSha256(options.providerResponseSha256);
    if (
        options.artifact.state !== REVIEW_OUTPUT_CORRECTION_REQUIRED
        || options.artifact.recovery.selected_transport !== 'correction_only_invocation'
        || !binding
        || !['closed', 'stateless', 'not_applicable'].includes(binding.session_availability)
        || binding.provider_capabilities.correction_only_invocation !== true
    ) {
        throw new Error('Correction-only acceptance requires a pending correction-only package.');
    }
    if (
        !/^agent:[^\s<>]+$/u.test(options.reviewerIdentity)
        || /^agent:pending:/iu.test(options.reviewerIdentity)
        || options.reviewerIdentity === options.artifact.binding.reviewer_identity
        || !options.providerInvocationId
        || !invocationEventSha256
    ) {
        throw new Error('Correction-only acceptance does not match a fresh provider-owned reviewer invocation.');
    }
    if (!providerResponseEventSha256 || !providerResponseSha256) {
        throw new Error('Correction-only acceptance requires a provider-attested hashed correction response.');
    }
    const attestationSource = assertProviderOwnedCorrectionSessionAttestationSource(options.attestationSource);
    const timestamp = options.now || new Date().toISOString();
    return withArtifactSha256({
        ...options.artifact,
        state: 'CORRECTION_ACCEPTED',
        updated_at_utc: timestamp,
        producer_response_attestation: {
            reviewer_identity: options.reviewerIdentity,
            provider_invocation_id: options.providerInvocationId,
            provider_invocation_event_sha256: invocationEventSha256,
            provider_response_event_sha256: providerResponseEventSha256,
            provider_response_sha256: providerResponseSha256,
            attestation_source: attestationSource,
            evidence_type: 'provider_native_session_receipt',
            recorded_at_utc: timestamp
        },
        recovery: {
            ...options.artifact.recovery,
            reason: options.reason,
            handoff: buildReviewOutputCorrectionHandoff({
                transport: 'correction_only_invocation',
                reviewerIdentity: options.artifact.binding.reviewer_identity,
                correctionArtifactPath: options.artifactPath,
                correctionAttempt: options.artifact.recovery.correction_attempt
            })
        }
    });
}

function writePreparedCorrectionOnlyLaunchArtifact(options: {
    artifactPath: string;
    correctionLaunchArtifactPath: string;
    artifact: ReviewOutputCorrectionArtifact;
}): string | null {
    const artifactFileSha256 = fileSha256(options.artifactPath) || '';
    if (
        options.artifact.state !== REVIEW_OUTPUT_CORRECTION_REQUIRED
        || options.artifact.recovery.selected_transport !== 'correction_only_invocation'
        || options.artifact.transport_binding?.session_availability === 'pending'
        || !/^[0-9a-f]{64}$/u.test(artifactFileSha256)
    ) {
        return null;
    }
    writeFileAtomically(options.correctionLaunchArtifactPath, `${JSON.stringify({
        schema_version: 1,
        artifact_type: REVIEW_OUTPUT_CORRECTION_LAUNCH_ARTIFACT_TYPE,
        state: 'prepared',
        task_id: options.artifact.task_id,
        review_type: options.artifact.review_type,
        correction_artifact_path: normalizePath(options.artifactPath),
        correction_artifact_sha256: artifactFileSha256,
        launch_input_sha256: artifactFileSha256,
        original_reviewer_identity: options.artifact.binding.reviewer_identity,
        original_reviewer_attempt_id: options.artifact.binding.reviewer_attempt_id,
        review_context_sha256: options.artifact.binding.review_context_sha256,
        review_tree_state_sha256: options.artifact.binding.review_tree_state_sha256,
        provider_id: options.artifact.transport_binding?.provider_id || null,
        provider_capabilities_sha256:
            options.artifact.transport_binding?.provider_capabilities_sha256 || null,
        session_availability: options.artifact.transport_binding?.session_availability || 'not_applicable',
        provider_response_output_path:
            options.artifact.recovery.handoff?.provider_response_output_path || null,
        prepared_at_utc: options.artifact.updated_at_utc
    }, null, 2)}\n`, { encoding: 'utf8' });
    return options.correctionLaunchArtifactPath;
}

function assertPathInsideRepo(repoRoot: string, targetPath: string, label: string): string {
    const root = path.resolve(repoRoot);
    const target = path.resolve(targetPath);
    const relative = path.relative(root, target);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error(`${label} must resolve to a file inside repo root.`);
    }
    const realRoot = fs.realpathSync.native(root);
    let existingAncestor = target;
    while (!fs.existsSync(existingAncestor)) {
        const parent = path.dirname(existingAncestor);
        if (parent === existingAncestor) {
            throw new Error(`${label} has no existing ancestor inside repo root.`);
        }
        existingAncestor = parent;
    }
    const realAncestor = fs.realpathSync.native(existingAncestor);
    const realTarget = path.resolve(realAncestor, path.relative(existingAncestor, target));
    const realRelative = path.relative(realRoot, realTarget);
    if (!realRelative || realRelative.startsWith('..') || path.isAbsolute(realRelative)) {
        throw new Error(`${label} must not traverse a symlink or junction outside repo root.`);
    }
    return target;
}

export function persistReviewOutputCorrection(options: {
    repoRoot: string;
    reviewArtifactPath: string;
    rawOutput: string;
    artifact: Omit<ReviewOutputCorrectionArtifact, 'artifact_sha256'> | ReviewOutputCorrectionArtifact;
}): {
    artifactPath: string;
    rejectedOutputPath: string;
    correctionLaunchArtifactPath: string | null;
    artifact: ReviewOutputCorrectionArtifact;
} {
    const rawOutputSha256 = computeRawReviewOutputSha256(options.rawOutput);
    const rejectedOutputPath = assertPathInsideRepo(
        options.repoRoot,
        getRejectedReviewOutputArtifactPath(options.reviewArtifactPath, rawOutputSha256),
        'Rejected review output path'
    );
    const artifactPath = assertPathInsideRepo(
        options.repoRoot,
        getReviewOutputCorrectionArtifactPath(options.reviewArtifactPath),
        'Review output correction artifact path'
    );
    const correctionLaunchArtifactPath = assertPathInsideRepo(
        options.repoRoot,
        getReviewOutputCorrectionLaunchArtifactPath(options.reviewArtifactPath),
        'Review output correction launch artifact path'
    );
    const artifactWithoutHash = { ...options.artifact } as ReviewOutputCorrectionArtifact;
    delete artifactWithoutHash.artifact_sha256;
    const previousCorrection = fs.existsSync(artifactPath)
        ? readReviewOutputCorrectionArtifact(artifactPath)
        : { artifact: null, violations: [] as string[] };
    const previousArtifact = previousCorrection.violations.length === 0
        ? previousCorrection.artifact
        : null;
    const preservesPreviousAttempt = Boolean(
        artifactWithoutHash.recovery.correction_attempt > 1
        && previousArtifact?.state === REVIEW_OUTPUT_CORRECTION_REQUIRED
        && previousArtifact.task_id === artifactWithoutHash.task_id
        && previousArtifact.review_type === artifactWithoutHash.review_type
        && previousArtifact.binding.review_context_sha256 === artifactWithoutHash.binding.review_context_sha256
        && previousArtifact.binding.review_tree_state_sha256 === artifactWithoutHash.binding.review_tree_state_sha256
        && previousArtifact.binding.reviewer_identity === artifactWithoutHash.binding.reviewer_identity
        && previousArtifact.binding.reviewer_attempt_id === artifactWithoutHash.binding.reviewer_attempt_id
        && previousArtifact.recovery.correction_attempt + 1 === artifactWithoutHash.recovery.correction_attempt
    );
    if (artifactWithoutHash.recovery.correction_attempt > 1 && !preservesPreviousAttempt) {
        throw new Error(
            'Repeated review output correction cannot preserve the authenticated original rejected-output binding.'
        );
    }
    const preservedOriginalOutputPath = preservesPreviousAttempt && previousArtifact
        ? assertPathInsideRepo(
            options.repoRoot,
            previousArtifact.binding.original_output_path,
            'Original rejected review output path'
        )
        : rejectedOutputPath;
    const preservedOriginalOutputSha256 = preservesPreviousAttempt && previousArtifact
        ? previousArtifact.binding.original_output_sha256
        : rawOutputSha256;
    const findingsSemanticFingerprint = preservesPreviousAttempt && previousArtifact
        ? previousArtifact.binding.findings_semantic_fingerprint
        : computeReviewFindingsSemanticFingerprint(options.rawOutput);
    writeFileAtomically(rejectedOutputPath, options.rawOutput, { encoding: 'utf8' });
    artifactWithoutHash.binding = {
        ...artifactWithoutHash.binding,
        original_output_path: normalizePath(preservedOriginalOutputPath),
        original_output_sha256: preservedOriginalOutputSha256,
        correction_input_path: normalizePath(rejectedOutputPath),
        correction_input_sha256: rawOutputSha256,
        findings_semantic_fingerprint: findingsSemanticFingerprint
    };
    artifactWithoutHash.recovery = {
        ...artifactWithoutHash.recovery,
        handoff: buildReviewOutputCorrectionHandoff({
            transport: artifactWithoutHash.recovery.selected_transport,
            reviewerIdentity: artifactWithoutHash.binding.reviewer_identity,
            correctionArtifactPath: artifactPath,
            correctionAttempt: artifactWithoutHash.recovery.correction_attempt
        })
    };
    if (!findingsSemanticFingerprint) {
        artifactWithoutHash.state = 'FULL_REVIEW_REQUIRED';
        artifactWithoutHash.recovery = {
            ...artifactWithoutHash.recovery,
            selected_transport: 'full_reviewer_relaunch',
            reason: MISSING_FINDINGS_FINGERPRINT_REASON,
            handoff: buildReviewOutputCorrectionHandoff({
                transport: 'full_reviewer_relaunch',
                reviewerIdentity: artifactWithoutHash.binding.reviewer_identity,
                correctionArtifactPath: artifactPath,
                correctionAttempt: artifactWithoutHash.recovery.correction_attempt
            })
        };
    }
    const artifact = withArtifactSha256(artifactWithoutHash);
    writeFileAtomically(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, { encoding: 'utf8' });
    const preparedLaunchArtifactPath = writePreparedCorrectionOnlyLaunchArtifact({
        artifactPath,
        correctionLaunchArtifactPath,
        artifact
    });
    return {
        artifactPath,
        rejectedOutputPath,
        correctionLaunchArtifactPath: preparedLaunchArtifactPath,
        artifact
    };
}

export function persistReviewOutputCorrectionTransportSelection(options: {
    repoRoot: string;
    artifactPath: string;
    artifact: ReviewOutputCorrectionArtifact;
    sessionAvailability: Extract<ReviewOutputCorrectionSessionAvailability, 'closed' | 'stateless'>;
    reviewerIdentity: string;
    providerInvocationId: string;
    attestationSource: string;
    now?: string;
}): {
    artifact: ReviewOutputCorrectionArtifact;
    artifactPath: string;
    correctionLaunchArtifactPath: string | null;
    previousArtifactFileSha256: string;
    artifactFileSha256: string;
} {
    const artifactPath = assertPathInsideRepo(
        options.repoRoot,
        options.artifactPath,
        'Review output correction artifact path'
    );
    const artifactFileSha256 = fileSha256(artifactPath) || '';
    const current = readReviewOutputCorrectionArtifact(artifactPath);
    if (
        current.violations.length > 0
        || !current.artifact
        || current.artifact.artifact_sha256 !== options.artifact.artifact_sha256
        || !/^[0-9a-f]{64}$/u.test(artifactFileSha256)
    ) {
        throw new Error('Correction transport selection requires the current intact correction package.');
    }
    const updated = buildReviewOutputCorrectionTransportSelection({
        artifactPath,
        artifact: current.artifact,
        sessionAvailability: options.sessionAvailability,
        reviewerIdentity: options.reviewerIdentity,
        providerInvocationId: options.providerInvocationId,
        attestationSource: options.attestationSource,
        now: options.now
    });
    writeFileAtomically(artifactPath, `${JSON.stringify(updated, null, 2)}\n`, { encoding: 'utf8' });
    const updatedFileSha256 = fileSha256(artifactPath) || '';
    if (!/^[0-9a-f]{64}$/u.test(updatedFileSha256)) {
        throw new Error('Correction transport selection could not hash the updated correction package.');
    }
    const correctionLaunchArtifactPath = assertPathInsideRepo(
        options.repoRoot,
        getCorrectionLaunchPathFromCorrectionArtifactPath(artifactPath),
        'Review output correction launch artifact path'
    );
    return {
        artifact: updated,
        artifactPath,
        correctionLaunchArtifactPath: writePreparedCorrectionOnlyLaunchArtifact({
            artifactPath,
            correctionLaunchArtifactPath,
            artifact: updated
        }),
        previousArtifactFileSha256: artifactFileSha256,
        artifactFileSha256: updatedFileSha256
    };
}

export function readReviewOutputCorrectionArtifact(artifactPath: string): {
    artifact: ReviewOutputCorrectionArtifact | null;
    violations: string[];
} {
    if (!fs.existsSync(artifactPath) || !fs.statSync(artifactPath).isFile()) {
        return { artifact: null, violations: [`Review output correction artifact is missing: ${normalizePath(artifactPath)}.`] };
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(fs.readFileSync(artifactPath, 'utf8')) as unknown;
    } catch {
        return { artifact: null, violations: [`Review output correction artifact is not valid JSON: ${normalizePath(artifactPath)}.`] };
    }
    if (!isRecord(parsed)) {
        return { artifact: null, violations: ['Review output correction artifact must be a JSON object.'] };
    }
    const artifact = parsed as unknown as ReviewOutputCorrectionArtifact;
    const violations: string[] = [];
    if (
        ![1, REVIEW_OUTPUT_CORRECTION_SCHEMA_VERSION].includes(artifact.schema_version)
        || artifact.artifact_type !== REVIEW_OUTPUT_CORRECTION_ARTIFACT_TYPE
        || !isRecord(artifact.binding)
        || !isRecord(artifact.recovery)
        || !Array.isArray(artifact.diagnostics)
    ) {
        violations.push('Review output correction artifact has invalid shape.');
        return { artifact: null, violations };
    }
    if (artifact.transport_binding !== undefined) {
        if (
            !isRecord(artifact.transport_binding)
            || !isRecord(artifact.transport_binding.provider_capabilities)
            || !['pending', 'available', 'closed', 'stateless', 'not_applicable'].includes(
                String(artifact.transport_binding.session_availability || '')
            )
            || artifact.transport_binding.provider_capabilities_sha256
                !== computeReviewOutputCorrectionProviderCapabilitiesSha256({
                    providerId: artifact.transport_binding.provider_id,
                    capabilities: artifact.transport_binding.provider_capabilities
                })
        ) {
            violations.push('Review output correction transport capability binding is invalid.');
        }
        const transportAttestation = artifact.transport_binding.availability_attestation;
        const providerContinuationAccepted = artifact.state === 'CORRECTION_ACCEPTED'
            && ['live_reviewer_continuation', 'api_conversation_continuation'].includes(
                artifact.recovery.selected_transport
            );
        const acceptedContinuationSessionAvailability =
            artifact.recovery.selected_transport === 'live_reviewer_continuation'
                ? 'available'
                : 'stateless';
        if (
            providerContinuationAccepted
            && (
                artifact.transport_binding.session_availability
                    !== acceptedContinuationSessionAvailability
                || (
                    artifact.recovery.selected_transport === 'live_reviewer_continuation'
                    && artifact.transport_binding.provider_capabilities.live_reviewer_continuation !== true
                )
                || (
                    artifact.recovery.selected_transport === 'api_conversation_continuation'
                    && artifact.transport_binding.provider_capabilities.api_conversation_continuation !== true
                )
                || !transportAttestation
                || transportAttestation.reviewer_identity !== artifact.binding.reviewer_identity
                || transportAttestation.provider_invocation_id
                    !== artifact.transport_binding.provider_invocation_id
                || transportAttestation.evidence_type !== 'provider_native_session_receipt'
                || normalizeSha256(transportAttestation.provider_invocation_event_sha256)
                    !== artifact.binding.reviewer_invocation_event_sha256
                || !normalizeSha256(transportAttestation.provider_response_event_sha256)
                || !normalizeSha256(transportAttestation.provider_response_sha256)
                || !isProviderOwnedReviewOutputCorrectionSessionAttestationSource(
                    transportAttestation.attestation_source
                )
            )
        ) {
            violations.push('Persisted provider correction response receipt is invalid.');
        }
        if (
            artifactRequiresFailClosedAvailabilityEvidence(artifact)
            && (
                !transportAttestation
                || transportAttestation.attestation_source
                    !== REVIEW_OUTPUT_CORRECTION_FAIL_CLOSED_ATTESTATION_SOURCE
                || transportAttestation.evidence_type !== 'fail_closed_no_provider_session_receipt'
            )
        ) {
            violations.push('Correction transport fail-closed availability evidence is invalid.');
        }
        const correctionOnlyAccepted = artifact.state === 'CORRECTION_ACCEPTED'
            && artifact.recovery.selected_transport === 'correction_only_invocation';
        const producerResponseAttestation = artifact.producer_response_attestation;
        if (
            correctionOnlyAccepted
            && (
                !producerResponseAttestation
                || producerResponseAttestation.reviewer_identity === artifact.binding.reviewer_identity
                || !/^agent:[^\s<>]+$/u.test(producerResponseAttestation.reviewer_identity)
                || /^agent:pending:/iu.test(producerResponseAttestation.reviewer_identity)
                || !producerResponseAttestation.provider_invocation_id
                || producerResponseAttestation.evidence_type !== 'provider_native_session_receipt'
                || !normalizeSha256(producerResponseAttestation.provider_invocation_event_sha256)
                || !normalizeSha256(producerResponseAttestation.provider_response_event_sha256)
                || !normalizeSha256(producerResponseAttestation.provider_response_sha256)
                || !isProviderOwnedReviewOutputCorrectionSessionAttestationSource(
                    producerResponseAttestation.attestation_source
                )
            )
        ) {
            violations.push('Persisted correction-only provider response receipt is invalid.');
        }
    }
    const declaredSha256 = normalizeSha256(artifact.artifact_sha256);
    const unhashed = { ...artifact };
    delete unhashed.artifact_sha256;
    if (!declaredSha256 || sha256RedactedJsonPayload(unhashed) !== declaredSha256) {
        violations.push('Review output correction artifact checksum is invalid.');
    }
    const originalOutputSha256 = normalizeSha256(artifact.binding.original_output_sha256);
    if (
        !originalOutputSha256
        || !fs.existsSync(artifact.binding.original_output_path)
        || fileSha256(artifact.binding.original_output_path) !== originalOutputSha256
    ) {
        violations.push('Review output correction original output binding is missing or tampered.');
    }
    if (artifact.schema_version >= 2) {
        const correctionInputSha256 = normalizeSha256(artifact.binding.correction_input_sha256);
        if (
            !correctionInputSha256
            || !artifact.binding.correction_input_path
            || !fs.existsSync(artifact.binding.correction_input_path)
            || fileSha256(artifact.binding.correction_input_path) !== correctionInputSha256
        ) {
            violations.push('Review output correction latest input binding is missing or tampered.');
        }
    }
    const validationArtifactSha256 = normalizeSha256(artifact.binding.validation_artifact_sha256);
    if (
        !validationArtifactSha256
        || !fs.existsSync(artifact.binding.validation_artifact_path)
        || fileSha256(artifact.binding.validation_artifact_path) !== validationArtifactSha256
    ) {
        violations.push('Review output correction validation evidence binding is missing or tampered.');
    }
    return { artifact, violations };
}

export function buildReviewOutputCorrectionStateTransition(options: {
    artifactPath: string;
    artifact: ReviewOutputCorrectionArtifact;
    state: ReviewOutputCorrectionState;
    reason: string;
    now?: string;
}): ReviewOutputCorrectionArtifact {
    const updatedWithoutHash = {
        ...options.artifact,
        state: options.state,
        updated_at_utc: options.now || new Date().toISOString(),
        recovery: {
            ...options.artifact.recovery,
            ...(options.state === 'FULL_REVIEW_REQUIRED'
                ? {
                    selected_transport: 'full_reviewer_relaunch' as const,
                    handoff: buildReviewOutputCorrectionHandoff({
                        transport: 'full_reviewer_relaunch',
                        reviewerIdentity: options.artifact.binding.reviewer_identity,
                        correctionArtifactPath: options.artifactPath,
                        correctionAttempt: options.artifact.recovery.correction_attempt
                    })
                }
                : {}),
            reason: options.reason
        }
    };
    delete updatedWithoutHash.artifact_sha256;
    return withArtifactSha256(updatedWithoutHash);
}

export function updateReviewOutputCorrectionState(options: {
    artifactPath: string;
    artifact: ReviewOutputCorrectionArtifact;
    state: ReviewOutputCorrectionState;
    reason: string;
    now?: string;
}): ReviewOutputCorrectionArtifact {
    const updated = buildReviewOutputCorrectionStateTransition(options);
    writeFileAtomically(options.artifactPath, `${JSON.stringify(updated, null, 2)}\n`, { encoding: 'utf8' });
    return updated;
}

export function verifyCorrectedReviewOutput(options: {
    artifact: ReviewOutputCorrectionArtifact;
    correctedOutput: string;
    reviewContextSha256: string;
    reviewTreeStateSha256: string;
    originalReviewerIdentity: string;
    originalReviewerAttemptId: string;
    correctionArtifactSha256: string;
    producerAttestation: ReviewOutputCorrectionProducerAttestation;
    producerInvocationEvidence: ReviewOutputCorrectionProducerInvocationEvidence | null;
}): ReviewOutputCorrectionVerification {
    const violations: string[] = [];
    const binding = options.artifact.binding;
    const transportBinding = options.artifact.transport_binding;
    const producer = options.producerAttestation;
    const invocationEvidence = options.producerInvocationEvidence;
    if (binding.review_context_sha256 !== options.reviewContextSha256.toLowerCase()) {
        violations.push('Review context changed after correction was requested.');
    }
    if (binding.review_tree_state_sha256 !== options.reviewTreeStateSha256.toLowerCase()) {
        violations.push('Review tree state changed after correction was requested.');
    }
    if (binding.reviewer_identity !== options.originalReviewerIdentity) {
        violations.push('Reviewer identity does not match the rejected output provenance.');
    }
    if (binding.reviewer_attempt_id !== options.originalReviewerAttemptId) {
        violations.push('Reviewer attempt does not match the rejected output provenance.');
    }
    if (options.artifact.state !== REVIEW_OUTPUT_CORRECTION_REQUIRED) {
        violations.push('Review output correction is not in a pending correction state.');
    }
    if (!transportBinding) {
        violations.push('Correction transport provider capability evidence is missing.');
    } else {
        const expectedCapabilitiesSha256 = computeReviewOutputCorrectionProviderCapabilitiesSha256({
            providerId: transportBinding.provider_id,
            capabilities: transportBinding.provider_capabilities
        });
        if (transportBinding.provider_capabilities_sha256 !== expectedCapabilitiesSha256) {
            violations.push('Correction transport provider capability evidence is invalid.');
        }
        if (
            options.artifact.recovery.selected_transport === 'live_reviewer_continuation'
            && !['pending', 'available'].includes(transportBinding.session_availability)
        ) {
            violations.push('Live reviewer continuation has invalid session availability state.');
        }
        if (
            artifactRequiresFailClosedAvailabilityEvidence(options.artifact)
            && (
                transportBinding.availability_attestation?.attestation_source
                    !== REVIEW_OUTPUT_CORRECTION_FAIL_CLOSED_ATTESTATION_SOURCE
                || transportBinding.availability_attestation?.evidence_type
                    !== 'fail_closed_no_provider_session_receipt'
            )
        ) {
            violations.push('Correction transport fail-closed availability evidence is invalid.');
        }
        if (
            (
                ['available', 'closed'].includes(transportBinding.session_availability)
                || (
                    transportBinding.session_availability === 'stateless'
                    && transportBinding.provider_capabilities.live_reviewer_continuation
                )
            )
            && (
                !transportBinding.availability_attestation
                || transportBinding.availability_attestation.reviewer_identity !== binding.reviewer_identity
                || transportBinding.availability_attestation.provider_invocation_id
                    !== transportBinding.provider_invocation_id
            )
        ) {
            violations.push('Correction transport availability attestation is missing or does not match the original invocation.');
        }
    }
    if (
        !/^agent:[^\s<>]+$/u.test(producer.producer_identity)
        || /^agent:pending:/iu.test(producer.producer_identity)
    ) {
        violations.push('Correction producer identity must be a resolved provider-owned agent identity.');
    }
    if (
        !producer.provider_invocation_id
        || /^(?:unknown|n\/a|na|null|none|manual|mock|test|placeholder|<.*>)$/iu.test(producer.provider_invocation_id)
    ) {
        violations.push('Correction provider invocation id must identify the actual provider invocation.');
    }
    if (!normalizeSha256(producer.provider_invocation_event_sha256)) {
        violations.push('Correction producer must reference provider-owned reviewer invocation evidence.');
    }
    if (
        !producer.attestation_source
        || /^(?:garda_prepare_reviewer_launch|orchestrator_mock|manual|mock|test|placeholder)$/iu.test(
            producer.attestation_source
        )
        || !/(?:spawn|subagent|task|tool|launch|run|invocation)/iu.test(producer.attestation_source)
    ) {
        violations.push('Correction attestation source must be provider/controller-owned invocation evidence.');
    }
    if (
        !normalizeSha256(options.correctionArtifactSha256)
        || normalizeSha256(producer.launch_input_sha256) !== normalizeSha256(options.correctionArtifactSha256)
    ) {
        violations.push('Correction producer launch input does not match the persisted correction package.');
    }
    if (!invocationEvidence) {
        violations.push('Correction producer invocation is not present in provider-owned task telemetry.');
    } else {
        if (invocationEvidence.event_type !== 'REVIEWER_INVOCATION_ATTESTED') {
            violations.push('Correction producer evidence is not a reviewer invocation attestation.');
        }
        if (
            invocationEvidence.event_sha256 !== normalizeSha256(producer.provider_invocation_event_sha256)
        ) {
            violations.push('Correction producer invocation evidence hash does not match the claimed provider event.');
        }
        if (invocationEvidence.reviewer_identity !== producer.producer_identity) {
            violations.push('Correction producer identity does not match provider-owned invocation evidence.');
        }
        if (invocationEvidence.provider_invocation_id !== producer.provider_invocation_id) {
            violations.push('Correction provider invocation id does not match provider-owned invocation evidence.');
        }
        if (invocationEvidence.attestation_source !== producer.attestation_source) {
            violations.push('Correction attestation source does not match provider-owned invocation evidence.');
        }
        if (invocationEvidence.review_context_sha256 !== binding.review_context_sha256) {
            violations.push('Correction producer invocation context does not match the rejected review context.');
        }
    }
    if (
        ['live_reviewer_continuation', 'api_conversation_continuation'].includes(
            options.artifact.recovery.selected_transport
        )
        && producer.producer_identity !== binding.reviewer_identity
    ) {
        violations.push('Correction continuation producer does not match the original reviewer identity.');
    }
    if (
        ['live_reviewer_continuation', 'api_conversation_continuation'].includes(
            options.artifact.recovery.selected_transport
        )
        && transportBinding?.provider_invocation_id
        && producer.provider_invocation_id !== transportBinding.provider_invocation_id
    ) {
        violations.push('Correction continuation provider invocation does not match transport capability evidence.');
    }
    if (
        ['live_reviewer_continuation', 'api_conversation_continuation'].includes(
            options.artifact.recovery.selected_transport
        )
        && (
            !invocationEvidence
            || invocationEvidence.event_sha256 !== binding.reviewer_invocation_event_sha256
            || invocationEvidence.reviewer_attempt_id !== binding.reviewer_attempt_id
        )
    ) {
        violations.push('Correction continuation is not bound to the original provider-owned reviewer invocation.');
    }
    if (
        [
            'live_reviewer_continuation',
            'api_conversation_continuation',
            'correction_only_invocation'
        ].includes(options.artifact.recovery.selected_transport)
    ) {
        const correctedOutputSha256 = computeRawReviewOutputSha256(options.correctedOutput);
        const expectedResponseEventType = options.artifact.recovery.selected_transport
            === 'live_reviewer_continuation'
            ? 'REVIEW_OUTPUT_CORRECTION_LIVE_CONTINUATION'
            : options.artifact.recovery.selected_transport === 'api_conversation_continuation'
                ? 'REVIEW_OUTPUT_CORRECTION_API_CONTINUATION'
                : 'REVIEW_OUTPUT_CORRECTION_INVOCATION_ATTESTED';
        if (
            invocationEvidence?.provider_response_event_type !== expectedResponseEventType
            || !normalizeSha256(invocationEvidence.provider_response_event_sha256)
            || invocationEvidence.provider_response_sha256 !== correctedOutputSha256
        ) {
            violations.push('Provider correction output lacks a provider-owned response receipt bound to its bytes.');
        }
    }
    if (options.artifact.recovery.selected_transport === 'correction_only_invocation') {
        if (producer.producer_identity === binding.reviewer_identity) {
            violations.push('Correction-only invocation must use a fresh reviewer identity.');
        }
        if (producer.fork_context !== false) {
            violations.push('Correction-only invocation must attest fork_context=false.');
        }
        if (invocationEvidence?.launch_input_sha256 !== normalizeSha256(options.correctionArtifactSha256)) {
            violations.push('Correction-only invocation was not launched from the persisted correction package.');
        }
        if (
            invocationEvidence?.delegation_started_event_type !== 'REVIEWER_DELEGATION_STARTED'
            || !normalizeSha256(invocationEvidence.delegation_started_event_sha256)
        ) {
            violations.push('Correction-only invocation lacks an independently persisted delegation-start event.');
        }
        if (invocationEvidence?.delegation_started_reviewer_identity !== producer.producer_identity) {
            violations.push('Correction-only delegation identity does not match the correction producer.');
        }
        if (invocationEvidence?.delegation_started_provider_invocation_id !== producer.provider_invocation_id) {
            violations.push('Correction-only delegation provider invocation does not match the correction producer.');
        }
        if (!normalizeSha256(invocationEvidence?.correction_launch_artifact_sha256)) {
            violations.push('Correction-only invocation lacks a gate-owned launch artifact binding.');
        }
    }
    if (options.artifact.recovery.correction_attempt > options.artifact.recovery.max_correction_attempts) {
        violations.push('Bounded review output correction attempts are exhausted.');
    }
    const correctedFingerprint = computeReviewFindingsSemanticFingerprint(options.correctedOutput);
    if (!binding.findings_semantic_fingerprint) {
        violations.push(MISSING_FINDINGS_FINGERPRINT_REASON);
    } else if (correctedFingerprint !== binding.findings_semantic_fingerprint) {
        violations.push('Corrected output changed the semantic findings fingerprint.');
    }
    return {
        valid: violations.length === 0,
        requires_full_review: violations.length > 0,
        violations
    };
}

const correctionTransportExecutions = new Map<string, Promise<string>>();

async function executeReviewOutputCorrectionWithAdapterUnlocked(options: {
    artifact: ReviewOutputCorrectionArtifact;
    adapter: ReviewOutputCorrectionTransportAdapter;
}): Promise<string> {
    const sessionAvailability: ReviewOutputCorrectionSessionAvailability =
        options.adapter.capabilities.live_reviewer_continuation
            ? options.adapter.probeLiveReviewerAvailability
                ? await options.adapter.probeLiveReviewerAvailability(options.artifact)
                : 'stateless'
            : options.adapter.capabilities.api_conversation_continuation ? 'stateless' : 'not_applicable';
    const selection = resolveReviewOutputCorrectionTransport({
        diagnostics: options.artifact.diagnostics,
        capabilities: options.adapter.capabilities,
        correctionAttempt: options.artifact.recovery.correction_attempt,
        maxCorrectionAttempts: options.artifact.recovery.max_correction_attempts,
        sessionAvailability,
        forceFullReviewReasons: options.artifact.state === 'FULL_REVIEW_REQUIRED'
            ? [options.artifact.recovery.reason]
            : []
    });
    const transport = selection.transport;
    const telemetryEvent = {
        task_id: options.artifact.task_id,
        review_type: options.artifact.review_type,
        adapter_id: options.adapter.id,
        correction_attempt: options.artifact.recovery.correction_attempt,
        selected_transport: transport,
        session_availability: sessionAvailability,
        reason: selection.reason
    };
    if (transport === 'live_reviewer_continuation' && options.adapter.continueReview) {
        await options.adapter.recordTelemetry?.({ ...telemetryEvent, event: 'live_continuation' });
        return options.adapter.continueReview(options.artifact);
    }
    if (transport === 'api_conversation_continuation' && options.adapter.continueApiConversation) {
        await options.adapter.recordTelemetry?.({ ...telemetryEvent, event: 'api_continuation' });
        return options.adapter.continueApiConversation(options.artifact);
    }
    if (transport === 'correction_only_invocation' && options.adapter.invokeCorrectionOnly) {
        await options.adapter.recordTelemetry?.({ ...telemetryEvent, event: 'correction_only_invocation' });
        return options.adapter.invokeCorrectionOnly(options.artifact);
    }
    if (transport === 'full_reviewer_relaunch') {
        await options.adapter.recordTelemetry?.({ ...telemetryEvent, event: 'full_reviewer_relaunch' });
    }
    throw new Error(`Correction adapter '${options.adapter.id}' cannot execute selected transport '${transport}'.`);
}

export async function executeReviewOutputCorrectionWithAdapter(options: {
    artifact: ReviewOutputCorrectionArtifact;
    adapter: ReviewOutputCorrectionTransportAdapter;
}): Promise<string> {
    const key = [
        options.artifact.task_id,
        options.artifact.review_type,
        options.artifact.recovery.correction_attempt,
        options.artifact.binding.original_output_sha256,
        options.adapter.id
    ].join(':');
    const current = correctionTransportExecutions.get(key);
    if (current) {
        return current;
    }
    const execution = executeReviewOutputCorrectionWithAdapterUnlocked(options);
    correctionTransportExecutions.set(key, execution);
    try {
        return await execution;
    } finally {
        if (correctionTransportExecutions.get(key) === execution) {
            correctionTransportExecutions.delete(key);
        }
    }
}
