import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import {
    buildReviewOutputCorrectionArtifact,
    buildReviewOutputCorrectionApiContinuationAcceptance,
    buildReviewOutputCorrectionCorrectionOnlyAcceptance,
    buildReviewOutputCorrectionLiveContinuationAcceptance,
    buildReviewOutputCorrectionTransportSelection,
    computeReviewOutputCorrectionProviderCapabilitiesSha256,
    readReviewOutputCorrectionArtifact,
    persistReviewOutputCorrection,
    persistReviewOutputCorrectionTransportSelection,
    REVIEW_OUTPUT_CORRECTION_FAIL_CLOSED_ATTESTATION_SOURCE
} from '../../../../src/gates/review/review-output-correction';
import type { ReviewReuseTelemetryEventLike } from '../../../../src/gates/review-reuse/review-reuse-telemetry';
import {
    buildReviewFindingsAuditSummary as buildReviewFindingsAuditSummaryBase
} from '../../../../src/gates/task-audit/task-audit-summary-review-findings';
import { sha256RedactedJsonPayload } from '../../../../src/core/redaction';
import { fileSha256 } from '../../../../src/gate-runtime/hash';

interface CorrectionEvent extends ReviewReuseTelemetryEventLike {
    event_type: string;
    timestamp_utc: string;
    details: Record<string, unknown>;
}

const CORRECTION_REQUIRED_REVIEWS = {
    api: false,
    code: false,
    security: false,
    test: false
} as const;

function buildReviewFindingsAuditSummary(
    options: Parameters<typeof buildReviewFindingsAuditSummaryBase>[0]
): ReturnType<typeof buildReviewFindingsAuditSummaryBase> {
    return buildReviewFindingsAuditSummaryBase({
        ...options,
        authorizedCorrectionReviewTypes: Object.keys(CORRECTION_REQUIRED_REVIEWS)
    });
}

function correctionEvent(eventType: string, details: Record<string, unknown>): CorrectionEvent {
    return {
        event_type: eventType,
        timestamp_utc: '2026-08-21T00:00:00.000Z',
        details
    };
}

function reviewerInvocationEvent(options: {
    taskId: string;
    reviewType: string;
    reviewerIdentity: string;
    reviewerAttemptId?: string;
    providerId: string;
    providerInvocationId: string;
    eventSha256: string;
    attestationSource?: string;
}): CorrectionEvent {
    return {
        event_type: 'REVIEWER_INVOCATION_ATTESTED',
        timestamp_utc: '2026-08-20T23:59:00.000Z',
        details: {
            task_id: options.taskId,
            review_type: options.reviewType,
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_identity: options.reviewerIdentity,
            reviewer_launch_attempt_id: options.reviewerAttemptId || 'attempt-1',
            execution_provider: options.providerId,
            provider_invocation_id: options.providerInvocationId,
            reviewer_launch_attestation_source:
                options.attestationSource || 'codex_collaboration_spawn_agent',
            reviewer_launch_artifact_sha256: 'd'.repeat(64)
        },
        integrity: {
            task_sequence: 1,
            prev_event_sha256: 'e'.repeat(64),
            event_sha256: options.eventSha256
        }
    };
}

function writeSelectedCorrectionFixture(options: {
    repoRoot?: string;
    persistInitial?: boolean;
    reviewsRoot: string;
    taskId: string;
    reviewType: string;
    reviewerIdentity: string;
    providerId: string;
    providerInvocationId: string;
    reviewerInvocationEventSha256: string;
    capabilities: {
        live_reviewer_continuation: boolean;
        api_conversation_continuation: boolean;
        correction_only_invocation: boolean;
    };
    sessionAvailability: 'available' | 'closed' | 'stateless';
    attestationSource?: string;
    correctionAttempt?: number;
    maxCorrectionAttempts?: number;
    selectTransport?: boolean;
}): {
    artifactPath: string;
    artifactSha256: string;
    previousFileSha256: string;
    selectedFileSha256: string;
    snapshotPath: string;
} {
    const artifactPath = path.join(
        options.reviewsRoot,
        `${options.taskId}-${options.reviewType}-output-correction.json`
    );
    const rejectedOutputContent = `${JSON.stringify({
        findings: {
            critical: [],
            high: [{
                id: 'F-001',
                title: 'Fixture finding',
                description: 'Preserve this semantic finding through correction.',
                evidence: [{ location: 'src/app.ts:1', observation: 'Observed behavior.' }],
                coverage_obligation_ids: ['FILE-001']
            }],
            medium: [],
            low: []
        },
        residual_risks: []
    })}\n`;
    const rejectedOutputPath = path.join(
        options.reviewsRoot,
        `${options.taskId}-${options.reviewType}-rejected-output.md`
    );
    const validationArtifactPath = path.join(
        options.reviewsRoot,
        `${options.taskId}-${options.reviewType}-validation.json`
    );
    fs.writeFileSync(rejectedOutputPath, rejectedOutputContent, 'utf8');
    fs.writeFileSync(validationArtifactPath, '{}\n', 'utf8');
    let initial = buildReviewOutputCorrectionArtifact({
        taskId: options.taskId,
        reviewType: options.reviewType,
        rejectedOutputPath,
        rejectedOutputSha256: fileSha256(rejectedOutputPath) || '',
        rejectedOutputContent,
        reviewContextPath: path.join(options.reviewsRoot, 'review-context.json'),
        reviewContextSha256: '2'.repeat(64),
        reviewTreeStateSha256: '3'.repeat(64),
        reviewerIdentity: options.reviewerIdentity,
        reviewerAttemptId: 'attempt-1',
        reviewerInvocationEventSha256: options.reviewerInvocationEventSha256,
        validationArtifactPath,
        validationArtifactSha256: fileSha256(validationArtifactPath) || '',
        violations: ['schema_version must be 2.'],
        correctionAttempt: options.correctionAttempt,
        maxCorrectionAttempts: options.maxCorrectionAttempts,
        capabilities: options.capabilities,
        providerId: options.providerId,
        providerInvocationId: options.providerInvocationId,
        sessionAvailability: 'pending',
        now: '2026-08-21T00:00:00.000Z'
    });
    if (options.persistInitial) {
        assert.ok(options.repoRoot);
        initial = persistReviewOutputCorrection({
            repoRoot: options.repoRoot,
            reviewArtifactPath: path.join(options.reviewsRoot, `${options.taskId}-${options.reviewType}.md`),
            rawOutput: rejectedOutputContent,
            artifact: initial
        }).artifact;
    } else {
        fs.writeFileSync(artifactPath, `${JSON.stringify(initial, null, 2)}\n`, 'utf8');
    }
    const previousFileSha256 = fileSha256(artifactPath) || '';
    const selected = options.selectTransport === false
        ? initial
        : initial.state === 'FULL_REVIEW_REQUIRED'
        ? initial
        : options.sessionAvailability === 'available'
            ? buildReviewOutputCorrectionLiveContinuationAcceptance({
            artifactPath,
            artifact: initial,
            reviewerIdentity: options.reviewerIdentity,
            providerInvocationId: options.providerInvocationId,
            providerInvocationEventSha256: options.reviewerInvocationEventSha256,
            providerResponseEventSha256: '6'.repeat(64),
            providerResponseSha256: '7'.repeat(64),
            attestationSource: options.attestationSource || 'codex_collaboration_followup_task',
            reason: 'Authenticated provider response accepted.',
            now: '2026-08-21T00:01:00.000Z'
            })
            : options.persistInitial && options.repoRoot
            ? persistReviewOutputCorrectionTransportSelection({
                repoRoot: options.repoRoot,
                artifactPath,
                artifact: initial,
                sessionAvailability: options.sessionAvailability,
                reviewerIdentity: options.reviewerIdentity,
                providerInvocationId: options.providerInvocationId,
                attestationSource: options.attestationSource
                    || REVIEW_OUTPUT_CORRECTION_FAIL_CLOSED_ATTESTATION_SOURCE,
                now: '2026-08-21T00:01:00.000Z'
            }).artifact
            : buildReviewOutputCorrectionTransportSelection({
                artifactPath,
                artifact: initial,
                sessionAvailability: options.sessionAvailability,
                reviewerIdentity: options.reviewerIdentity,
                providerInvocationId: options.providerInvocationId,
                attestationSource: options.attestationSource
                    || REVIEW_OUTPUT_CORRECTION_FAIL_CLOSED_ATTESTATION_SOURCE,
                now: '2026-08-21T00:01:00.000Z'
            });
    fs.writeFileSync(artifactPath, `${JSON.stringify(selected, null, 2)}\n`, 'utf8');
    const selectedFileSha256 = fileSha256(artifactPath) || '';
    const snapshotPath = path.join(
        options.reviewsRoot,
        `${options.taskId}-${options.reviewType}-output-correction-attempt-${options.correctionAttempt || 1}`
            + `-${selectedFileSha256}.json`
    );
    fs.copyFileSync(artifactPath, snapshotPath);
    return {
        artifactPath,
        artifactSha256: selected.artifact_sha256 || '',
        previousFileSha256,
        selectedFileSha256,
        snapshotPath
    };
}

function buildHistoricalLiveCorrectionAttempt(options: {
    reviewsRoot: string;
    taskId: string;
    correctionAttempt: number;
    reviewType: string;
    reviewerIdentity: string;
    providerInvocationId: string;
    reviewerInvocationEventSha256: string;
    maxCorrectionAttempts?: number;
    capabilities: {
        live_reviewer_continuation: boolean;
        api_conversation_continuation: boolean;
        correction_only_invocation: boolean;
    };
}): CorrectionEvent[] {
    const capabilitiesSha256 = computeReviewOutputCorrectionProviderCapabilitiesSha256({
        providerId: 'Codex',
        capabilities: options.capabilities
    });
    const persisted = writeSelectedCorrectionFixture({
        reviewsRoot: options.reviewsRoot,
        taskId: options.taskId,
        reviewType: options.reviewType,
        reviewerIdentity: options.reviewerIdentity,
        providerId: 'Codex',
        providerInvocationId: options.providerInvocationId,
        reviewerInvocationEventSha256: options.reviewerInvocationEventSha256,
        capabilities: options.capabilities,
        sessionAvailability: 'available',
        attestationSource: 'codex_collaboration_followup_task',
        correctionAttempt: options.correctionAttempt,
        maxCorrectionAttempts: options.maxCorrectionAttempts
    });
    const artifact = readReviewOutputCorrectionArtifact(persisted.artifactPath).artifact!;
    return [
        correctionEvent('REVIEW_OUTPUT_CORRECTION_REQUIRED', {
            task_id: options.taskId,
            review_type: options.reviewType,
            correction_attempt: options.correctionAttempt,
            correction_package_sha256: persisted.previousFileSha256,
            correction_artifact_path: persisted.artifactPath,
            reviewer_identity: options.reviewerIdentity,
            reviewer_attempt_id: 'attempt-1',
            provider_id: 'Codex',
            provider_invocation_id: options.providerInvocationId,
            provider_capabilities_sha256: capabilitiesSha256,
            reviewer_invocation_event_sha256: options.reviewerInvocationEventSha256
        }),
        correctionEvent('REVIEW_OUTPUT_CORRECTION_LIVE_CONTINUATION', {
            task_id: options.taskId,
            review_type: options.reviewType,
            correction_attempt: options.correctionAttempt,
            previous_correction_package_sha256: persisted.previousFileSha256,
            correction_package_sha256: persisted.selectedFileSha256,
            correction_artifact_path: persisted.artifactPath,
            correction_artifact_sha256: persisted.artifactSha256,
            correction_artifact_snapshot_path: persisted.snapshotPath,
            correction_artifact_snapshot_sha256: persisted.selectedFileSha256,
            provider_id: 'Codex',
            reviewer_identity: options.reviewerIdentity,
            reviewer_attempt_id: 'attempt-1',
            provider_invocation_id: options.providerInvocationId,
            reviewer_invocation_event_sha256: options.reviewerInvocationEventSha256,
            availability_attestation_source: 'codex_collaboration_followup_task',
            availability_evidence_type: 'provider_native_session_receipt',
            availability_provider_invocation_event_sha256:
                options.reviewerInvocationEventSha256,
            availability_provider_response_sha256: '7'.repeat(64),
            session_availability: 'available',
            selected_transport: 'live_reviewer_continuation',
            provider_capabilities: options.capabilities,
            provider_capabilities_sha256: capabilitiesSha256
        }),
        correctionEvent('REVIEW_OUTPUT_CORRECTION_INVOCATION_ATTESTED', {
            task_id: options.taskId,
            review_type: options.reviewType,
            correction_attempt: options.correctionAttempt,
            reviewer_invocation_event_sha256: options.reviewerInvocationEventSha256,
            original_reviewer_identity: options.reviewerIdentity,
            reviewer_attempt_id: 'attempt-1',
            correction_producer_identity: options.reviewerIdentity,
            provider_invocation_id: options.providerInvocationId,
            attestation_source: 'codex_collaboration_followup_task',
            corrected_output_sha256: '7'.repeat(64),
            provider_response_event_sha256: '6'.repeat(64),
            selected_transport: 'live_reviewer_continuation',
            correction_package_sha256: persisted.selectedFileSha256,
            provider_id: 'Codex',
            provider_capabilities_sha256: capabilitiesSha256,
            session_availability: 'available'
        }),
        correctionEvent('REVIEW_OUTPUT_CORRECTION_ACCEPTED', {
            task_id: options.taskId,
            review_type: options.reviewType,
            reviewer_identity: options.reviewerIdentity,
            reviewer_attempt_id: 'attempt-1',
            correction_producer_identity: options.reviewerIdentity,
            provider_invocation_id: options.providerInvocationId,
            attestation_source: 'codex_collaboration_followup_task',
            provider_response_event_sha256: '6'.repeat(64),
            corrected_output_sha256: '7'.repeat(64),
            selected_transport: 'live_reviewer_continuation',
            correction_artifact_path: persisted.artifactPath,
            correction_artifact_sha256: persisted.artifactSha256,
            correction_package_sha256: persisted.selectedFileSha256,
            original_output_sha256: artifact.binding.original_output_sha256,
            findings_semantic_fingerprint: artifact.binding.findings_semantic_fingerprint,
            provider_id: 'Codex',
            provider_capabilities_sha256: capabilitiesSha256,
            session_availability: 'available'
        })
    ];
}

describe('gates/task-audit-summary review correction transport', () => {
    const tempRoots: string[] = [];

    afterEach(() => {
        for (const tempRoot of tempRoots.splice(0)) {
            fs.rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    it('binds legacy attempts to the original provider invocation without overriding explicit attempt evidence', () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-legacy-correction-audit-'));
        const reviewsRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews');
        fs.mkdirSync(reviewsRoot, { recursive: true });
        tempRoots.push(repoRoot);
        const taskId = 'T-AUDIT-LEGACY-CORRECTION';
        const capabilities = {
            live_reviewer_continuation: false,
            api_conversation_continuation: false,
            correction_only_invocation: true
        };
        const persisted = writeSelectedCorrectionFixture({
            reviewsRoot, taskId, reviewType: 'code', reviewerIdentity: 'agent:legacy-reviewer',
            providerId: 'Codex', providerInvocationId: 'attempt-1',
            reviewerInvocationEventSha256: '8'.repeat(64), capabilities,
            sessionAvailability: 'stateless', selectTransport: false
        });
        const required = correctionEvent('REVIEW_OUTPUT_CORRECTION_REQUIRED', {
            task_id: taskId, review_type: 'code', correction_attempt: 1,
            correction_package_sha256: persisted.previousFileSha256,
            correction_artifact_path: persisted.artifactPath,
            correction_artifact_sha256: persisted.artifactSha256,
            reviewer_identity: 'agent:legacy-reviewer', reviewer_attempt_id: 'attempt-1',
            provider_id: 'Codex', provider_invocation_id: 'attempt-1',
            reviewer_invocation_event_sha256: '8'.repeat(64),
            provider_capabilities_sha256: computeReviewOutputCorrectionProviderCapabilitiesSha256({
                providerId: 'Codex', capabilities
            }), session_availability: 'pending'
        });
        for (const attemptEvidence of [undefined, '', 'foreign-attempt']) {
            const original = reviewerInvocationEvent({
                taskId, reviewType: 'code', reviewerIdentity: 'agent:legacy-reviewer',
                providerId: 'Codex', providerInvocationId: 'attempt-1', eventSha256: '8'.repeat(64)
            });
            if (attemptEvidence === undefined) delete original.details.reviewer_launch_attempt_id;
            else original.details.reviewer_launch_attempt_id = attemptEvidence;
            const summary = buildReviewFindingsAuditSummary({
                repoRoot, reviewsRoot, taskId, requiredReviews: CORRECTION_REQUIRED_REVIEWS,
                currentPreflight: null, timelineEvents: [original, required], reviewAttemptSummary: null
            });
            assert.equal(summary?.correction_transports?.[0]?.evidence_valid,
                attemptEvidence === undefined, `attempt evidence: ${String(attemptEvidence)}`);
            assert.equal(summary?.status, attemptEvidence === undefined ? 'CLEAR' : 'BLOCKED');
        }
    });

    for (const correctionAttempt of [1, 2]) {
        it(`reconstructs real persisted predecessor handoffs for current and historical attempt ${correctionAttempt}`, () => {
            const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-persisted-predecessor-'));
            const reviewsRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews');
            fs.mkdirSync(reviewsRoot, { recursive: true });
            tempRoots.push(repoRoot);
            const taskId = `T-AUDIT-PERSISTED-PREDECESSOR-${correctionAttempt}`;
            const capabilities = {
                live_reviewer_continuation: false,
                api_conversation_continuation: false,
                correction_only_invocation: true
            };
            const invocation = reviewerInvocationEvent({
                taskId, reviewType: 'code', reviewerIdentity: 'agent:persisted-reviewer',
                providerId: 'Codex', providerInvocationId: '/root/persisted-reviewer',
                eventSha256: '8'.repeat(64)
            });
            const persistedOptions = {
                repoRoot, persistInitial: true, reviewsRoot, taskId, reviewType: 'code',
                reviewerIdentity: 'agent:persisted-reviewer', providerId: 'Codex',
                providerInvocationId: '/root/persisted-reviewer', reviewerInvocationEventSha256: '8'.repeat(64),
                capabilities, sessionAvailability: 'stateless' as const, correctionAttempt
            };
            if (correctionAttempt > 1) writeSelectedCorrectionFixture({
                ...persistedOptions, correctionAttempt: 1, selectTransport: false
            });
            const persisted = writeSelectedCorrectionFixture(persistedOptions);
            const details = {
                task_id: taskId, review_type: 'code', correction_attempt: correctionAttempt,
                reviewer_identity: 'agent:persisted-reviewer', reviewer_attempt_id: 'attempt-1',
                provider_id: 'Codex', provider_invocation_id: '/root/persisted-reviewer',
                reviewer_invocation_event_sha256: '8'.repeat(64)
            };
            const required = correctionEvent('REVIEW_OUTPUT_CORRECTION_REQUIRED', {
                ...details, correction_package_sha256: persisted.previousFileSha256
            });
            const selected = correctionEvent('REVIEW_OUTPUT_CORRECTION_ONLY_INVOCATION', {
                ...details, previous_correction_package_sha256: persisted.previousFileSha256,
                correction_package_sha256: persisted.selectedFileSha256,
                correction_artifact_path: persisted.artifactPath,
                correction_artifact_sha256: persisted.artifactSha256,
                correction_artifact_snapshot_path: persisted.snapshotPath,
                correction_artifact_snapshot_sha256: persisted.selectedFileSha256,
                provider_capabilities: capabilities,
                provider_capabilities_sha256: computeReviewOutputCorrectionProviderCapabilitiesSha256({
                    providerId: 'Codex', capabilities
                }), session_availability: 'stateless',
                availability_attestation_source: REVIEW_OUTPUT_CORRECTION_FAIL_CLOSED_ATTESTATION_SOURCE,
                availability_evidence_type: 'fail_closed_no_provider_session_receipt'
            });
            const nextSelection = correctionEvent('REVIEW_OUTPUT_CORRECTION_ONLY_INVOCATION', {
                ...selected.details, correction_attempt: correctionAttempt + 1,
                previous_correction_package_sha256: persisted.selectedFileSha256,
                correction_package_sha256: 'f'.repeat(64)
            });
            for (const historical of [false, true]) {
                for (const tampered of [false, true]) {
                    const selection = tampered ? {
                        ...selected, details: { ...selected.details, previous_correction_package_sha256: 'e'.repeat(64) }
                    } : selected;
                    const summary = buildReviewFindingsAuditSummary({
                        repoRoot, reviewsRoot, taskId, requiredReviews: CORRECTION_REQUIRED_REVIEWS,
                        currentPreflight: null,
                        timelineEvents: [invocation, required, selection, ...(historical ? [nextSelection] : [])],
                        reviewAttemptSummary: null
                    });
                    const violations = summary?.correction_transports?.[1]?.violations.join(' ') || '';
                    assert.equal(/not derived from its validation-rejection predecessor package/u.test(violations),
                        tampered, `historical=${historical}, tampered=${tampered}: ${violations}`);
                    assert.equal(summary?.status, 'BLOCKED');
                    assert.equal(summary?.correction_transports?.[1]?.evidence_valid, false);
                    if (!historical && !tampered) assert.match(violations, /lacks accepted provider response/u);
                }
            }
        });
    }

    it('event provenance: distinguishes transports and rejects stale, duplicate, raced, or unverifiable evidence', () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-correction-audit-'));
        const reviewsRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews');
        fs.mkdirSync(reviewsRoot, { recursive: true });
        tempRoots.push(repoRoot);
        const capabilities = {
            live_reviewer_continuation: true,
            api_conversation_continuation: false,
            correction_only_invocation: true
        };
        const capabilitiesSha256 = computeReviewOutputCorrectionProviderCapabilitiesSha256({
            providerId: 'Codex',
            capabilities
        });
        const codeReviewerInvocation = reviewerInvocationEvent({
            taskId: 'T-AUDIT-CORRECTION-TRANSPORT',
            reviewType: 'code',
            reviewerIdentity: 'agent:code-reviewer',
            providerId: 'Codex',
            providerInvocationId: '/root/code-review',
            eventSha256: '9'.repeat(64)
        });
        const persisted = writeSelectedCorrectionFixture({
            reviewsRoot,
            taskId: 'T-AUDIT-CORRECTION-TRANSPORT',
            reviewType: 'code',
            reviewerIdentity: 'agent:code-reviewer',
            providerId: 'Codex',
            providerInvocationId: '/root/code-review',
            reviewerInvocationEventSha256: '9'.repeat(64),
            capabilities,
            sessionAvailability: 'stateless'
        });
        const required = correctionEvent('REVIEW_OUTPUT_CORRECTION_REQUIRED', {
            task_id: 'T-AUDIT-CORRECTION-TRANSPORT',
            review_type: 'code',
            correction_attempt: 1,
            correction_package_sha256: persisted.previousFileSha256,
            reviewer_identity: 'agent:code-reviewer',
            reviewer_attempt_id: 'attempt-1',
            provider_id: 'Codex',
            provider_invocation_id: '/root/code-review',
            reviewer_invocation_event_sha256: '9'.repeat(64)
        });
        const selected = correctionEvent('REVIEW_OUTPUT_CORRECTION_ONLY_INVOCATION', {
            task_id: 'T-AUDIT-CORRECTION-TRANSPORT',
            review_type: 'code',
            correction_attempt: 1,
            previous_correction_package_sha256: persisted.previousFileSha256,
            correction_package_sha256: persisted.selectedFileSha256,
            correction_artifact_path: persisted.artifactPath,
            correction_artifact_sha256: persisted.artifactSha256,
            provider_id: 'Codex',
            reviewer_identity: 'agent:code-reviewer',
            reviewer_attempt_id: 'attempt-1',
            provider_invocation_id: '/root/code-review',
            reviewer_invocation_event_sha256: '9'.repeat(64),
            provider_capabilities: capabilities,
            provider_capabilities_sha256: capabilitiesSha256,
            availability_attestation_source: REVIEW_OUTPUT_CORRECTION_FAIL_CLOSED_ATTESTATION_SOURCE,
            availability_evidence_type: 'fail_closed_no_provider_session_receipt',
            session_availability: 'stateless'
        });
        const pendingSelection = buildReviewFindingsAuditSummary({
            repoRoot,
            reviewsRoot,
            taskId: 'T-AUDIT-CORRECTION-TRANSPORT',
            requiredReviews: CORRECTION_REQUIRED_REVIEWS,
            currentPreflight: null,
            timelineEvents: [codeReviewerInvocation, required, selected],
            reviewAttemptSummary: null
        });
        assert.equal(pendingSelection?.status, 'BLOCKED');
        assert.match(
            pendingSelection?.correction_transports?.[1]?.violations.join(' ') || '',
            /lacks accepted provider response provenance/iu
        );

        const futurePredecessor = buildReviewFindingsAuditSummary({
            repoRoot,
            reviewsRoot,
            taskId: 'T-AUDIT-CORRECTION-TRANSPORT',
            requiredReviews: CORRECTION_REQUIRED_REVIEWS,
            currentPreflight: null,
            timelineEvents: [codeReviewerInvocation, selected, required],
            reviewAttemptSummary: null
        });
        assert.equal(futurePredecessor?.status, 'BLOCKED');
        assert.match(
            futurePredecessor?.correction_transports?.[0]?.violations.join(' ') || '',
            /stale or lacks its validation-rejection predecessor/iu
        );

        const duplicateRejection = buildReviewFindingsAuditSummary({
            repoRoot,
            reviewsRoot,
            taskId: 'T-AUDIT-CORRECTION-TRANSPORT',
            requiredReviews: CORRECTION_REQUIRED_REVIEWS,
            currentPreflight: null,
            timelineEvents: [codeReviewerInvocation, required, required, selected],
            reviewAttemptSummary: null
        });
        assert.equal(duplicateRejection?.status, 'BLOCKED');
        assert.match(
            duplicateRejection?.correction_transports?.[1]?.violations.join(' ') || '',
            /duplicate or replayed for the same correction package/iu
        );

        const duplicateTelemetryCount = 24;
        const duplicateWorkMetricsCapture: {
            value?: { selection_candidates_examined: number };
        } = {};
        const duplicateTelemetryScale = buildReviewFindingsAuditSummary({
            repoRoot,
            reviewsRoot,
            taskId: 'T-AUDIT-CORRECTION-TRANSPORT',
            requiredReviews: CORRECTION_REQUIRED_REVIEWS,
            currentPreflight: null,
            timelineEvents: [
                codeReviewerInvocation,
                ...Array.from({ length: duplicateTelemetryCount }, () => selected),
                ...Array.from({ length: duplicateTelemetryCount }, () => required)
            ],
            reviewAttemptSummary: null,
            _testHooks: {
                onCorrectionTransportWorkMetrics(metrics) {
                    duplicateWorkMetricsCapture.value = {
                        selection_candidates_examined: metrics.selection_candidates_examined
                    };
                }
            }
        });
        assert.equal(duplicateTelemetryScale?.status, 'BLOCKED');
        const duplicateWorkMetrics = duplicateWorkMetricsCapture.value;
        assert.ok(duplicateWorkMetrics);
        assert.equal(
            duplicateWorkMetrics.selection_candidates_examined,
            duplicateTelemetryCount,
            'Only the first rejection for one package may scan its package-indexed selection candidates.'
        );

        const forgedPredecessorPackageSha256 = 'a'.repeat(64);
        const forgedPredecessor = buildReviewFindingsAuditSummary({
            repoRoot,
            reviewsRoot,
            taskId: 'T-AUDIT-CORRECTION-TRANSPORT',
            requiredReviews: CORRECTION_REQUIRED_REVIEWS,
            currentPreflight: null,
            timelineEvents: [
                codeReviewerInvocation,
                correctionEvent('REVIEW_OUTPUT_CORRECTION_REQUIRED', {
                    ...required.details,
                    correction_package_sha256: forgedPredecessorPackageSha256
                }),
                correctionEvent('REVIEW_OUTPUT_CORRECTION_ONLY_INVOCATION', {
                    ...selected.details,
                    previous_correction_package_sha256: forgedPredecessorPackageSha256
                })
            ],
            reviewAttemptSummary: null
        });
        assert.equal(forgedPredecessor?.status, 'BLOCKED');
        assert.match(
            forgedPredecessor?.correction_transports?.[1]?.violations.join(' ') || '',
            /not derived from its validation-rejection predecessor package/iu
        );

        const forgedRejectionAttempt = buildReviewFindingsAuditSummary({
            repoRoot,
            reviewsRoot,
            taskId: 'T-AUDIT-CORRECTION-TRANSPORT',
            requiredReviews: CORRECTION_REQUIRED_REVIEWS,
            currentPreflight: null,
            timelineEvents: [
                codeReviewerInvocation,
                correctionEvent('REVIEW_OUTPUT_CORRECTION_REQUIRED', {
                    ...required.details,
                    reviewer_attempt_id: 'attempt-2'
                }),
                selected
            ],
            reviewAttemptSummary: null
        });
        assert.equal(forgedRejectionAttempt?.status, 'BLOCKED');
        assert.match(
            forgedRejectionAttempt?.correction_transports?.[0]?.violations.join(' ') || '',
            /does not match a trusted original reviewer invocation/iu
        );

        const terminalTaskId = 'T-AUDIT-TERMINAL-REJECTION';
        const terminalReviewerInvocation = reviewerInvocationEvent({
            taskId: terminalTaskId,
            reviewType: 'code',
            reviewerIdentity: 'agent:terminal-code-reviewer',
            providerId: 'Codex',
            providerInvocationId: '/root/terminal-code-review',
            eventSha256: '8'.repeat(64)
        });
        const terminalPersisted = writeSelectedCorrectionFixture({
            reviewsRoot,
            taskId: terminalTaskId,
            reviewType: 'code',
            reviewerIdentity: 'agent:terminal-code-reviewer',
            providerId: 'Codex',
            providerInvocationId: '/root/terminal-code-review',
            reviewerInvocationEventSha256: '8'.repeat(64),
            capabilities,
            sessionAvailability: 'stateless',
            selectTransport: false
        });
        const terminalRequired = correctionEvent('REVIEW_OUTPUT_CORRECTION_REQUIRED', {
            task_id: terminalTaskId,
            review_type: 'code',
            correction_attempt: 1,
            correction_package_sha256: terminalPersisted.previousFileSha256,
            correction_artifact_path: terminalPersisted.artifactPath,
            correction_artifact_sha256: terminalPersisted.artifactSha256,
            reviewer_identity: 'agent:terminal-code-reviewer',
            reviewer_attempt_id: 'attempt-1',
            provider_id: 'Codex',
            provider_invocation_id: '/root/terminal-code-review',
            reviewer_invocation_event_sha256: '8'.repeat(64),
            provider_capabilities_sha256: capabilitiesSha256,
            session_availability: 'pending'
        });
        const terminalRejection = buildReviewFindingsAuditSummary({
            repoRoot,
            reviewsRoot,
            taskId: terminalTaskId,
            requiredReviews: CORRECTION_REQUIRED_REVIEWS,
            currentPreflight: null,
            timelineEvents: [terminalReviewerInvocation, terminalRequired],
            reviewAttemptSummary: null
        });
        assert.equal(terminalRejection?.correction_transports?.[0]?.evidence_valid, true);

        const forgedTerminalRejection = buildReviewFindingsAuditSummary({
            repoRoot,
            reviewsRoot,
            taskId: terminalTaskId,
            requiredReviews: CORRECTION_REQUIRED_REVIEWS,
            currentPreflight: null,
            timelineEvents: [
                terminalReviewerInvocation,
                correctionEvent('REVIEW_OUTPUT_CORRECTION_REQUIRED', {
                    ...terminalRequired.details,
                    correction_package_sha256: 'a'.repeat(64)
                })
            ],
            reviewAttemptSummary: null
        });
        assert.equal(forgedTerminalRejection?.status, 'BLOCKED');
        assert.match(
            forgedTerminalRejection?.correction_transports?.[0]?.violations.join(' ') || '',
            /does not match its canonical task-owned correction artifact/iu
        );

        const mismatchedAttempt = buildReviewFindingsAuditSummary({
            repoRoot,
            reviewsRoot,
            taskId: 'T-AUDIT-CORRECTION-TRANSPORT',
            requiredReviews: CORRECTION_REQUIRED_REVIEWS,
            currentPreflight: null,
            timelineEvents: [
                codeReviewerInvocation,
                correctionEvent('REVIEW_OUTPUT_CORRECTION_REQUIRED', {
                    ...required.details,
                    correction_attempt: 2
                }),
                correctionEvent('REVIEW_OUTPUT_CORRECTION_ONLY_INVOCATION', {
                    ...selected.details,
                    correction_attempt: 2
                })
            ],
            reviewAttemptSummary: null
        });
        assert.equal(mismatchedAttempt?.status, 'BLOCKED');
        assert.match(
            mismatchedAttempt?.correction_transports?.[1]?.violations.join(' ') || '',
            /persisted correction artifact does not match transport event correction attempt/iu
        );

        const forgedLive = buildReviewFindingsAuditSummary({
            repoRoot,
            reviewsRoot,
            taskId: 'T-AUDIT-CORRECTION-TRANSPORT',
            requiredReviews: CORRECTION_REQUIRED_REVIEWS,
            currentPreflight: null,
            timelineEvents: [
                codeReviewerInvocation,
                required,
                correctionEvent('REVIEW_OUTPUT_CORRECTION_LIVE_CONTINUATION', {
                    ...selected.details,
                    availability_attestation_source: 'codex_collaboration_followup_task',
                    availability_evidence_type: 'caller_claim',
                    session_availability: 'available'
                })
            ],
            reviewAttemptSummary: null
        });
        assert.equal(forgedLive?.status, 'BLOCKED');
        assert.match(
            forgedLive?.correction_transports?.[1]?.violations.join(' ') || '',
            /lacks an authenticated provider-owned session receipt/iu
        );

        const persistedLive = writeSelectedCorrectionFixture({
            reviewsRoot,
            taskId: 'T-AUDIT-CORRECTION-TRANSPORT',
            reviewType: 'security',
            reviewerIdentity: 'agent:security-reviewer',
            providerId: 'Codex',
            providerInvocationId: '/root/security-review',
            reviewerInvocationEventSha256: '6'.repeat(64),
            capabilities,
            sessionAvailability: 'available',
            attestationSource: 'codex_collaboration_followup_task'
        });
        const persistedLiveArtifact = readReviewOutputCorrectionArtifact(persistedLive.artifactPath).artifact!;
        const liveRequired = correctionEvent('REVIEW_OUTPUT_CORRECTION_REQUIRED', {
            task_id: 'T-AUDIT-CORRECTION-TRANSPORT',
            review_type: 'security',
            correction_attempt: 1,
            correction_package_sha256: persistedLive.previousFileSha256,
            reviewer_identity: 'agent:security-reviewer',
            reviewer_attempt_id: 'attempt-1',
            provider_id: 'Codex',
            provider_invocation_id: '/root/security-review',
            reviewer_invocation_event_sha256: '6'.repeat(64)
        });
        const liveSelection = correctionEvent('REVIEW_OUTPUT_CORRECTION_LIVE_CONTINUATION', {
            task_id: 'T-AUDIT-CORRECTION-TRANSPORT',
            review_type: 'security',
            correction_attempt: 1,
            previous_correction_package_sha256: persistedLive.previousFileSha256,
            correction_package_sha256: persistedLive.selectedFileSha256,
            correction_artifact_path: persistedLive.artifactPath,
            correction_artifact_sha256: persistedLive.artifactSha256,
            provider_id: 'Codex',
            reviewer_identity: 'agent:security-reviewer',
            reviewer_attempt_id: 'attempt-1',
            provider_invocation_id: '/root/security-review',
            reviewer_invocation_event_sha256: '6'.repeat(64),
            availability_attestation_source: 'codex_collaboration_followup_task',
            availability_evidence_type: 'provider_native_session_receipt',
            availability_provider_invocation_event_sha256: '6'.repeat(64),
            availability_provider_response_sha256: '7'.repeat(64),
            session_availability: 'available',
            selected_transport: 'live_reviewer_continuation',
            provider_capabilities: capabilities,
            provider_capabilities_sha256: computeReviewOutputCorrectionProviderCapabilitiesSha256({
                providerId: 'Codex',
                capabilities
            })
        });
        const liveAcceptance = correctionEvent('REVIEW_OUTPUT_CORRECTION_ACCEPTED', {
            task_id: 'T-AUDIT-CORRECTION-TRANSPORT',
            review_type: 'security',
            reviewer_identity: 'agent:security-reviewer',
            reviewer_attempt_id: 'attempt-1',
            correction_producer_identity: 'agent:security-reviewer',
            provider_invocation_id: '/root/security-review',
            attestation_source: 'codex_collaboration_followup_task',
            provider_response_event_sha256: '6'.repeat(64),
            corrected_output_sha256: '7'.repeat(64),
            selected_transport: 'live_reviewer_continuation',
            correction_artifact_path: persistedLive.artifactPath,
            correction_artifact_sha256: persistedLive.artifactSha256,
            correction_package_sha256: persistedLive.selectedFileSha256,
            original_output_sha256: persistedLiveArtifact.binding.original_output_sha256,
            findings_semantic_fingerprint: persistedLiveArtifact.binding.findings_semantic_fingerprint,
            provider_id: 'Codex',
            provider_capabilities_sha256: computeReviewOutputCorrectionProviderCapabilitiesSha256({
                providerId: 'Codex',
                capabilities
            }),
            session_availability: 'available'
        });
        const liveInvocation = correctionEvent('REVIEW_OUTPUT_CORRECTION_INVOCATION_ATTESTED', {
            task_id: 'T-AUDIT-CORRECTION-TRANSPORT',
            review_type: 'security',
            correction_attempt: 1,
            reviewer_invocation_event_sha256: '6'.repeat(64),
            original_reviewer_identity: 'agent:security-reviewer',
            reviewer_attempt_id: 'attempt-1',
            correction_producer_identity: 'agent:security-reviewer',
            provider_invocation_id: '/root/security-review',
            attestation_source: 'codex_collaboration_followup_task',
            corrected_output_sha256: '7'.repeat(64),
            provider_response_event_sha256: '6'.repeat(64),
            selected_transport: 'live_reviewer_continuation',
            correction_package_sha256: persistedLive.selectedFileSha256,
            provider_id: 'Codex',
            provider_capabilities_sha256: computeReviewOutputCorrectionProviderCapabilitiesSha256({
                providerId: 'Codex',
                capabilities
            }),
            session_availability: 'available'
        });
        const securityReviewerInvocation = reviewerInvocationEvent({
            taskId: 'T-AUDIT-CORRECTION-TRANSPORT',
            reviewType: 'security',
            reviewerIdentity: 'agent:security-reviewer',
            providerId: 'Codex',
            providerInvocationId: '/root/security-review',
            eventSha256: '6'.repeat(64)
        });
        const authenticatedLive = buildReviewFindingsAuditSummary({
            repoRoot,
            reviewsRoot,
            taskId: 'T-AUDIT-CORRECTION-TRANSPORT',
            requiredReviews: CORRECTION_REQUIRED_REVIEWS,
            currentPreflight: null,
            timelineEvents: [
                securityReviewerInvocation,
                liveRequired,
                liveSelection,
                liveInvocation,
                liveAcceptance
            ],
            reviewAttemptSummary: null
        });
        assert.notEqual(authenticatedLive?.status, 'BLOCKED');
        assert.equal(authenticatedLive?.correction_transports?.[1]?.evidence_valid, true);
        assert.equal(
            authenticatedLive?.correction_transports?.find((entry) => entry.transport === 'invocation_attestation')
                ?.evidence_valid,
            true
        );
        assert.equal(
            authenticatedLive?.correction_transports?.find((entry) => entry.transport === 'acceptance')?.evidence_valid,
            true
        );

        const invalidOriginalInvocations: Array<CorrectionEvent | null> = [
            null,
            {
                ...securityReviewerInvocation,
                details: {
                    ...securityReviewerInvocation.details,
                    task_id: 'T-FOREIGN-CORRECTION-TRANSPORT'
                }
            },
            {
                ...securityReviewerInvocation,
                details: {
                    ...securityReviewerInvocation.details,
                    reviewer_identity: 'agent:foreign-reviewer'
                }
            },
            {
                ...securityReviewerInvocation,
                details: {
                    ...securityReviewerInvocation.details,
                    execution_provider: 'ForeignProvider'
                }
            },
            {
                ...securityReviewerInvocation,
                details: {
                    ...securityReviewerInvocation.details,
                    provider_invocation_id: 'provider-foreign-review'
                }
            },
            {
                ...securityReviewerInvocation,
                details: {
                    ...securityReviewerInvocation.details,
                    reviewer_launch_attestation_source: 'manual'
                }
            }
        ];
        for (const invalidOriginalInvocation of invalidOriginalInvocations) {
            const untrustedOriginalInvocationSummary = buildReviewFindingsAuditSummary({
                repoRoot,
                reviewsRoot,
                taskId: 'T-AUDIT-CORRECTION-TRANSPORT',
                requiredReviews: CORRECTION_REQUIRED_REVIEWS,
                currentPreflight: null,
                timelineEvents: [
                    ...(invalidOriginalInvocation ? [invalidOriginalInvocation] : []),
                    liveRequired,
                    liveSelection,
                    liveInvocation,
                    liveAcceptance
                ],
                reviewAttemptSummary: null
            });
            const untrustedOriginalInvocationViolations = untrustedOriginalInvocationSummary
                ?.correction_transports
                ?.flatMap((entry) => entry.violations)
                .join(' ') || '';
            assert.equal(untrustedOriginalInvocationSummary?.status, 'BLOCKED');
            assert.match(
                untrustedOriginalInvocationViolations,
                /does not match a trusted original reviewer invocation/iu
            );
        }

        const foreignProviderCapabilitiesSha256 =
            computeReviewOutputCorrectionProviderCapabilitiesSha256({
                providerId: 'ForeignProvider',
                capabilities
            });
        const forgedProviderSelection = correctionEvent(
            'REVIEW_OUTPUT_CORRECTION_LIVE_CONTINUATION',
            {
                ...liveSelection.details,
                provider_id: 'ForeignProvider',
                provider_capabilities_sha256: foreignProviderCapabilitiesSha256
            }
        );
        const forgedProviderInvocation = correctionEvent(
            'REVIEW_OUTPUT_CORRECTION_INVOCATION_ATTESTED',
            {
                ...liveInvocation.details,
                provider_id: 'ForeignProvider',
                provider_capabilities_sha256: foreignProviderCapabilitiesSha256
            }
        );
        const forgedProviderAcceptance = correctionEvent(
            'REVIEW_OUTPUT_CORRECTION_ACCEPTED',
            {
                ...liveAcceptance.details,
                provider_id: 'ForeignProvider',
                provider_capabilities_sha256: foreignProviderCapabilitiesSha256
            }
        );
        const forgedProviderSummary = buildReviewFindingsAuditSummary({
            repoRoot,
            reviewsRoot,
            taskId: 'T-AUDIT-CORRECTION-TRANSPORT',
            requiredReviews: CORRECTION_REQUIRED_REVIEWS,
            currentPreflight: null,
            timelineEvents: [
                securityReviewerInvocation,
                liveRequired,
                forgedProviderSelection,
                forgedProviderInvocation,
                forgedProviderAcceptance
            ],
            reviewAttemptSummary: null
        });
        const forgedProviderViolations = forgedProviderSummary?.correction_transports
            ?.flatMap((entry) => entry.violations)
            .join(' ') || '';
        assert.equal(forgedProviderSummary?.status, 'BLOCKED');
        assert.match(
            forgedProviderViolations,
            /does not match a trusted original reviewer invocation/iu
        );

        const futureOriginalInvocationSummary = buildReviewFindingsAuditSummary({
            repoRoot,
            reviewsRoot,
            taskId: 'T-AUDIT-CORRECTION-TRANSPORT',
            requiredReviews: CORRECTION_REQUIRED_REVIEWS,
            currentPreflight: null,
            timelineEvents: [
                liveRequired,
                liveSelection,
                liveInvocation,
                liveAcceptance,
                securityReviewerInvocation
            ],
            reviewAttemptSummary: null
        });
        assert.equal(futureOriginalInvocationSummary?.status, 'BLOCKED');
        assert.match(
            futureOriginalInvocationSummary?.correction_transports?.[0]?.violations.join(' ') || '',
            /does not match a trusted original reviewer invocation/iu
        );

        const duplicateOriginalInvocationSummary = buildReviewFindingsAuditSummary({
            repoRoot,
            reviewsRoot,
            taskId: 'T-AUDIT-CORRECTION-TRANSPORT',
            requiredReviews: CORRECTION_REQUIRED_REVIEWS,
            currentPreflight: null,
            timelineEvents: [
                securityReviewerInvocation,
                securityReviewerInvocation,
                liveRequired,
                liveSelection,
                liveInvocation,
                liveAcceptance
            ],
            reviewAttemptSummary: null
        });
        assert.equal(duplicateOriginalInvocationSummary?.status, 'BLOCKED');
        assert.match(
            duplicateOriginalInvocationSummary?.correction_transports?.[0]?.violations.join(' ') || '',
            /does not match a trusted original reviewer invocation/iu
        );

        for (const eventIndex of [0, 1, 2, 3]) {
            for (const invalidTaskId of [undefined, 'T-FOREIGN-CORRECTION-TRANSPORT']) {
                const validEvents = [liveRequired, liveSelection, liveInvocation, liveAcceptance];
                const invalidTaskEvent = correctionEvent(validEvents[eventIndex].event_type, {
                    ...validEvents[eventIndex].details,
                    task_id: invalidTaskId
                });
                const taskOwnershipSummary = buildReviewFindingsAuditSummary({
                    repoRoot,
                    reviewsRoot,
                    taskId: 'T-AUDIT-CORRECTION-TRANSPORT',
                    requiredReviews: CORRECTION_REQUIRED_REVIEWS,
                    currentPreflight: null,
                    timelineEvents: [
                        securityReviewerInvocation,
                        ...validEvents.map((event, index) => (
                            index === eventIndex ? invalidTaskEvent : event
                        ))
                    ],
                    reviewAttemptSummary: null
                });
                const taskOwnershipViolations = taskOwnershipSummary?.correction_transports
                    ?.flatMap((entry) => entry.violations)
                    .join(' ') || '';
                assert.equal(taskOwnershipSummary?.status, 'BLOCKED');
                assert.match(taskOwnershipViolations, /not bound to the audited task/iu);
            }
        }

        const foreignSelection = correctionEvent('REVIEW_OUTPUT_CORRECTION_LIVE_CONTINUATION', {
            ...liveSelection.details,
            task_id: 'T-FOREIGN-CORRECTION-TRANSPORT'
        });
        const foreignSelectionDoesNotConsumePredecessor = buildReviewFindingsAuditSummary({
            repoRoot,
            reviewsRoot,
            taskId: 'T-AUDIT-CORRECTION-TRANSPORT',
            requiredReviews: CORRECTION_REQUIRED_REVIEWS,
            currentPreflight: null,
            timelineEvents: [
                securityReviewerInvocation,
                liveRequired,
                foreignSelection,
                liveSelection,
                liveInvocation,
                liveAcceptance
            ],
            reviewAttemptSummary: null
        });
        assert.equal(foreignSelectionDoesNotConsumePredecessor?.status, 'BLOCKED');
        assert.equal(foreignSelectionDoesNotConsumePredecessor?.correction_transports?.[2]?.evidence_valid, true);

        const forgedCurrentAttempt = buildReviewFindingsAuditSummary({
            repoRoot,
            reviewsRoot,
            taskId: 'T-AUDIT-CORRECTION-TRANSPORT',
            requiredReviews: CORRECTION_REQUIRED_REVIEWS,
            currentPreflight: null,
            timelineEvents: [
                securityReviewerInvocation,
                liveRequired,
                correctionEvent('REVIEW_OUTPUT_CORRECTION_LIVE_CONTINUATION', {
                    ...liveSelection.details,
                    reviewer_attempt_id: 'forged-attempt'
                }),
                liveInvocation,
                liveAcceptance
            ],
            reviewAttemptSummary: null
        });
        assert.equal(forgedCurrentAttempt?.status, 'BLOCKED');
        assert.match(
            forgedCurrentAttempt?.correction_transports?.[1]?.violations.join(' ') || '',
            /does not match a trusted original reviewer invocation/iu
        );

        for (const forgedInvocationDetails of [
            { correction_attempt: 2 },
            { reviewer_invocation_event_sha256: '5'.repeat(64) },
            { reviewer_attempt_id: 'forged-attempt' }
        ]) {
            const forgedInvocationBinding = buildReviewFindingsAuditSummary({
                repoRoot,
                reviewsRoot,
                taskId: 'T-AUDIT-CORRECTION-TRANSPORT',
                requiredReviews: CORRECTION_REQUIRED_REVIEWS,
                currentPreflight: null,
                timelineEvents: [
                    securityReviewerInvocation,
                    liveRequired,
                    liveSelection,
                    correctionEvent('REVIEW_OUTPUT_CORRECTION_INVOCATION_ATTESTED', {
                        ...liveInvocation.details,
                        ...forgedInvocationDetails
                    }),
                    liveAcceptance
                ],
                reviewAttemptSummary: null
            });
            assert.equal(forgedInvocationBinding?.status, 'BLOCKED');
            assert.match(
                forgedInvocationBinding?.correction_transports?.[1]?.violations.join(' ') || '',
                /not bound to its provider invocation attestation/iu
            );
        }

        for (const responseProvenanceMutation of [
            {
                label: 'cross-session selection',
                eventIndex: 1,
                details: { session_availability: 'closed' }
            },
            {
                label: 'cross-provider invocation',
                eventIndex: 2,
                details: { provider_id: 'ForeignProvider' }
            },
            {
                label: 'cross-session invocation',
                eventIndex: 2,
                details: { session_availability: 'closed' }
            },
            {
                label: 'cross-provider-invocation invocation',
                eventIndex: 2,
                details: { provider_invocation_id: 'provider-foreign-review' }
            },
            {
                label: 'forged response-event invocation',
                eventIndex: 2,
                details: { provider_response_event_sha256: '4'.repeat(64) }
            },
            {
                label: 'forged corrected-output invocation',
                eventIndex: 2,
                details: { corrected_output_sha256: '5'.repeat(64) }
            },
            {
                label: 'cross-attempt acceptance',
                eventIndex: 3,
                details: { reviewer_attempt_id: 'attempt-2' }
            },
            {
                label: 'cross-provider acceptance',
                eventIndex: 3,
                details: { provider_id: 'ForeignProvider' }
            },
            {
                label: 'cross-session acceptance',
                eventIndex: 3,
                details: { session_availability: 'closed' }
            },
            {
                label: 'cross-provider-invocation acceptance',
                eventIndex: 3,
                details: { provider_invocation_id: 'provider-foreign-review' }
            },
            {
                label: 'forged response-event acceptance',
                eventIndex: 3,
                details: { provider_response_event_sha256: '4'.repeat(64) }
            },
            {
                label: 'forged corrected-output acceptance',
                eventIndex: 3,
                details: { corrected_output_sha256: '5'.repeat(64) }
            }
        ]) {
            const responseEvents = [liveRequired, liveSelection, liveInvocation, liveAcceptance];
            const forgedResponseEvent = correctionEvent(
                responseEvents[responseProvenanceMutation.eventIndex].event_type,
                {
                    ...responseEvents[responseProvenanceMutation.eventIndex].details,
                    ...responseProvenanceMutation.details
                }
            );
            const forgedResponseProvenance = buildReviewFindingsAuditSummary({
                repoRoot,
                reviewsRoot,
                taskId: 'T-AUDIT-CORRECTION-TRANSPORT',
                requiredReviews: CORRECTION_REQUIRED_REVIEWS,
                currentPreflight: null,
                timelineEvents: [
                    securityReviewerInvocation,
                    ...responseEvents.map((event, index) => (
                        index === responseProvenanceMutation.eventIndex ? forgedResponseEvent : event
                    ))
                ],
                reviewAttemptSummary: null
            });
            assert.equal(
                forgedResponseProvenance?.status,
                'BLOCKED',
                responseProvenanceMutation.label
            );
        }

        const duplicateLiveSelection = buildReviewFindingsAuditSummary({
            repoRoot,
            reviewsRoot,
            taskId: 'T-AUDIT-CORRECTION-TRANSPORT',
            requiredReviews: CORRECTION_REQUIRED_REVIEWS,
            currentPreflight: null,
            timelineEvents: [
                securityReviewerInvocation,
                liveRequired,
                liveSelection,
                liveSelection,
                liveInvocation,
                liveAcceptance
            ],
            reviewAttemptSummary: null
        });
        assert.equal(duplicateLiveSelection?.status, 'BLOCKED');

        const duplicateLiveInvocation = buildReviewFindingsAuditSummary({
            repoRoot,
            reviewsRoot,
            taskId: 'T-AUDIT-CORRECTION-TRANSPORT',
            requiredReviews: CORRECTION_REQUIRED_REVIEWS,
            currentPreflight: null,
            timelineEvents: [
                securityReviewerInvocation,
                liveRequired,
                liveSelection,
                liveInvocation,
                liveInvocation,
                liveAcceptance
            ],
            reviewAttemptSummary: null
        });
        assert.equal(duplicateLiveInvocation?.status, 'BLOCKED');
        assert.match(
            duplicateLiveInvocation?.correction_transports?.[1]?.violations.join(' ') || '',
            /package is not bound to its provider invocation attestation/iu
        );

        const acceptanceBeforeInvocation = buildReviewFindingsAuditSummary({
            repoRoot,
            reviewsRoot,
            taskId: 'T-AUDIT-CORRECTION-TRANSPORT',
            requiredReviews: CORRECTION_REQUIRED_REVIEWS,
            currentPreflight: null,
            timelineEvents: [
                securityReviewerInvocation,
                liveRequired,
                liveSelection,
                liveAcceptance,
                liveInvocation
            ],
            reviewAttemptSummary: null
        });
        assert.equal(acceptanceBeforeInvocation?.status, 'BLOCKED');
        assert.match(
            acceptanceBeforeInvocation?.correction_transports?.[1]?.violations.join(' ') || '',
            /package is not bound to its provider invocation attestation/iu
        );

        const forgedLiveArtifactHash = buildReviewFindingsAuditSummary({
            repoRoot,
            reviewsRoot,
            taskId: 'T-AUDIT-CORRECTION-TRANSPORT',
            requiredReviews: CORRECTION_REQUIRED_REVIEWS,
            currentPreflight: null,
            timelineEvents: [
                securityReviewerInvocation,
                liveRequired,
                correctionEvent('REVIEW_OUTPUT_CORRECTION_LIVE_CONTINUATION', {
                    ...liveSelection.details,
                    correction_artifact_sha256: 'f'.repeat(64)
                }),
                liveInvocation,
                liveAcceptance
            ],
            reviewAttemptSummary: null
        });
        assert.equal(forgedLiveArtifactHash?.status, 'BLOCKED');
        assert.match(
            forgedLiveArtifactHash?.correction_transports?.[1]?.violations.join(' ') || '',
            /not bound to its selected package snapshot/iu
        );

        const orphanLiveAcceptance = buildReviewFindingsAuditSummary({
            repoRoot,
            reviewsRoot,
            taskId: 'T-AUDIT-CORRECTION-TRANSPORT',
            requiredReviews: CORRECTION_REQUIRED_REVIEWS,
            currentPreflight: null,
            timelineEvents: [liveAcceptance],
            reviewAttemptSummary: null
        });
        assert.equal(orphanLiveAcceptance?.status, 'BLOCKED');
        assert.match(
            orphanLiveAcceptance?.correction_transports?.[0]?.violations.join(' ') || '',
            /acceptance lacks exactly one matching prior transport selection/iu
        );

        for (const malformedAttempt of ['1', true]) {
            const malformedAttemptAudit = buildReviewFindingsAuditSummary({
                repoRoot,
                reviewsRoot,
                taskId: 'T-AUDIT-CORRECTION-TRANSPORT',
                requiredReviews: CORRECTION_REQUIRED_REVIEWS,
                currentPreflight: null,
                timelineEvents: [
                    securityReviewerInvocation,
                    liveRequired,
                    correctionEvent('REVIEW_OUTPUT_CORRECTION_LIVE_CONTINUATION', {
                        ...liveSelection.details,
                        correction_attempt: malformedAttempt
                    }),
                    liveAcceptance
                ],
                reviewAttemptSummary: null
            });
            assert.equal(malformedAttemptAudit?.status, 'BLOCKED');
            assert.match(
                malformedAttemptAudit?.correction_transports?.[1]?.violations.join(' ') || '',
                /lacks a positive correction attempt/iu
            );
        }

        const outOfOrderLiveAcceptance = buildReviewFindingsAuditSummary({
            repoRoot,
            reviewsRoot,
            taskId: 'T-AUDIT-CORRECTION-TRANSPORT',
            requiredReviews: CORRECTION_REQUIRED_REVIEWS,
            currentPreflight: null,
            timelineEvents: [
                securityReviewerInvocation,
                liveRequired,
                liveAcceptance,
                liveSelection,
                liveInvocation
            ],
            reviewAttemptSummary: null
        });
        assert.equal(outOfOrderLiveAcceptance?.status, 'BLOCKED');
        assert.match(
            outOfOrderLiveAcceptance?.correction_transports?.[1]?.violations.join(' ') || '',
            /acceptance is not bound to the current attempt and persisted artifact/iu
        );

        const duplicateLiveAcceptance = buildReviewFindingsAuditSummary({
            repoRoot,
            reviewsRoot,
            taskId: 'T-AUDIT-CORRECTION-TRANSPORT',
            requiredReviews: CORRECTION_REQUIRED_REVIEWS,
            currentPreflight: null,
            timelineEvents: [
                securityReviewerInvocation,
                liveRequired,
                liveSelection,
                liveInvocation,
                liveAcceptance,
                liveAcceptance
            ],
            reviewAttemptSummary: null
        });
        assert.equal(duplicateLiveAcceptance?.status, 'BLOCKED');
        assert.match(
            duplicateLiveAcceptance?.correction_transports?.[1]?.violations.join(' ') || '',
            /acceptance is not bound to the current attempt and persisted artifact/iu
        );

        const replayedLiveAcceptance = buildReviewFindingsAuditSummary({
            repoRoot,
            reviewsRoot,
            taskId: 'T-AUDIT-CORRECTION-TRANSPORT',
            requiredReviews: CORRECTION_REQUIRED_REVIEWS,
            currentPreflight: null,
            timelineEvents: [
                securityReviewerInvocation,
                liveRequired,
                liveSelection,
                liveInvocation,
                correctionEvent('REVIEW_OUTPUT_CORRECTION_ACCEPTED', {
                    ...liveAcceptance.details,
                    correction_package_sha256: 'f'.repeat(64)
                })
            ],
            reviewAttemptSummary: null
        });
        assert.equal(replayedLiveAcceptance?.status, 'BLOCKED');
        assert.match(
            replayedLiveAcceptance?.correction_transports?.[1]?.violations.join(' ') || '',
            /acceptance is not bound to the current attempt and persisted artifact/iu
        );

        const forgedLivePackage = buildReviewFindingsAuditSummary({
            repoRoot,
            reviewsRoot,
            taskId: 'T-AUDIT-CORRECTION-TRANSPORT',
            requiredReviews: CORRECTION_REQUIRED_REVIEWS,
            currentPreflight: null,
            timelineEvents: [
                securityReviewerInvocation,
                liveRequired,
                correctionEvent('REVIEW_OUTPUT_CORRECTION_LIVE_CONTINUATION', {
                    ...liveSelection.details,
                    correction_package_sha256: 'f'.repeat(64)
                }),
                liveInvocation,
                correctionEvent('REVIEW_OUTPUT_CORRECTION_ACCEPTED', {
                    ...liveAcceptance.details,
                    correction_package_sha256: 'f'.repeat(64)
                })
            ],
            reviewAttemptSummary: null
        });
        assert.equal(forgedLivePackage?.status, 'BLOCKED');
        assert.match(
            forgedLivePackage?.correction_transports?.[1]?.violations.join(' ') || '',
            /package is not bound to its provider invocation attestation/iu
        );

        const invalidEvents = [
            correctionEvent('REVIEW_OUTPUT_CORRECTION_ONLY_INVOCATION', {
                ...selected.details,
                correction_package_sha256: 'c'.repeat(64)
            }),
            correctionEvent('REVIEW_OUTPUT_CORRECTION_ONLY_INVOCATION', {
                ...selected.details,
                previous_correction_package_sha256: 'd'.repeat(64),
                correction_package_sha256: 'e'.repeat(64)
            }),
            correctionEvent('REVIEW_OUTPUT_CORRECTION_ONLY_INVOCATION', {
                ...selected.details,
                previous_correction_package_sha256: 'f'.repeat(64),
                correction_package_sha256: '0'.repeat(64),
                provider_capabilities_sha256: '1'.repeat(64)
            })
        ];
        const invalid = buildReviewFindingsAuditSummary({
            repoRoot,
            reviewsRoot,
            taskId: 'T-AUDIT-CORRECTION-TRANSPORT',
            requiredReviews: CORRECTION_REQUIRED_REVIEWS,
            currentPreflight: null,
            timelineEvents: [codeReviewerInvocation, required, selected, ...invalidEvents],
            reviewAttemptSummary: null
        });
        const violations = invalid?.correction_transports
            ?.flatMap((entry) => entry.violations)
            .join(' ') || '';
        assert.equal(invalid?.status, 'BLOCKED');
        assert.match(violations, /duplicate or raced/iu);
        assert.match(violations, /stale/iu);
        assert.match(violations, /capability hash is unverifiable/iu);
    });

    it('artifact integrity: reconstructs historical attempts from snapshots and rejects forged evidence', () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-correction-audit-history-'));
        const reviewsRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews');
        fs.mkdirSync(reviewsRoot, { recursive: true });
        tempRoots.push(repoRoot);
        const taskId = 'T-AUDIT-CORRECTION-HISTORY';
        const reviewType = 'code';
        const capabilities = {
            live_reviewer_continuation: true,
            api_conversation_continuation: false,
            correction_only_invocation: true
        };
        const originalReviewerInvocation = reviewerInvocationEvent({
            taskId,
            reviewType,
            reviewerIdentity: 'agent:code-reviewer',
            providerId: 'Codex',
            providerInvocationId: '/root/code-review',
            eventSha256: '9'.repeat(64)
        });
        const buildAttempt = (
            correctionAttempt: number,
            lane: {
                reviewType: string;
                reviewerIdentity: string;
                providerInvocationId: string;
                reviewerInvocationEventSha256: string;
            } = {
                reviewType,
                reviewerIdentity: 'agent:code-reviewer',
                providerInvocationId: '/root/code-review',
                reviewerInvocationEventSha256: '9'.repeat(64)
            }
        ) => buildHistoricalLiveCorrectionAttempt({
            reviewsRoot,
            taskId,
            reviewType: lane.reviewType,
            reviewerIdentity: lane.reviewerIdentity,
            providerInvocationId: lane.providerInvocationId,
            reviewerInvocationEventSha256: lane.reviewerInvocationEventSha256,
            capabilities,
            correctionAttempt
        });

        const firstAttempt = buildAttempt(1);
        const interleavedReviewType = 'security';
        const interleavedReviewerInvocation = reviewerInvocationEvent({
            taskId,
            reviewType: interleavedReviewType,
            reviewerIdentity: 'agent:security-reviewer',
            providerId: 'Codex',
            providerInvocationId: '/root/security-review',
            eventSha256: '8'.repeat(64)
        });
        const interleavedAttempt = buildAttempt(1, {
            reviewType: interleavedReviewType,
            reviewerIdentity: 'agent:security-reviewer',
            providerInvocationId: '/root/security-review',
            reviewerInvocationEventSha256: '8'.repeat(64)
        });
        const secondAttempt = buildAttempt(2);
        const summary = buildReviewFindingsAuditSummary({
            repoRoot,
            reviewsRoot,
            taskId,
            requiredReviews: CORRECTION_REQUIRED_REVIEWS,
            currentPreflight: null,
            timelineEvents: [
                originalReviewerInvocation,
                interleavedReviewerInvocation,
                ...firstAttempt,
                ...interleavedAttempt,
                ...secondAttempt
            ],
            reviewAttemptSummary: null
        });

        assert.notEqual(
            summary?.status,
            'BLOCKED',
            JSON.stringify(summary?.correction_transports, null, 2)
        );
        assert.equal(summary?.correction_transports?.every((entry) => entry.evidence_valid), true);
        assert.deepEqual(
            summary?.correction_transports
                ?.filter((entry) => entry.transport === 'live_reviewer_continuation')
                .map((entry) => `${entry.review_type}:${entry.correction_attempt}`),
            ['code:1', 'security:1', 'code:2']
        );

        for (const historicalArtifactMutation of [
            {
                label: 'non-canonical current artifact path',
                details: { correction_artifact_path: path.join(repoRoot, 'outside.json') },
                violation: /does not reference its canonical artifact path/iu
            },
            {
                label: 'non-canonical content-addressed snapshot path',
                details: { correction_artifact_snapshot_path: path.join(repoRoot, 'outside-snapshot.json') },
                violation: /lacks its content-addressed artifact snapshot/iu
            },
            {
                label: 'mismatched content-addressed snapshot hash',
                details: { correction_artifact_snapshot_sha256: 'f'.repeat(64) },
                violation: /lacks its content-addressed artifact snapshot/iu
            },
            {
                label: 'path traversal in historical package hash',
                details: { correction_package_sha256: 'not-a-sha/../../outside' },
                violation: /lacks a canonical content-addressed package hash/iu
            },
            {
                label: 'forged historical availability attestation',
                details: { availability_evidence_type: 'caller_claim' },
                violation: /snapshot does not match transport telemetry/iu
            }
        ]) {
            const mutatedHistoricalSelection = correctionEvent(firstAttempt[1].event_type, {
                ...firstAttempt[1].details,
                ...historicalArtifactMutation.details
            });
            const historicalArtifactSummary = buildReviewFindingsAuditSummary({
                repoRoot,
                reviewsRoot,
                taskId,
                requiredReviews: CORRECTION_REQUIRED_REVIEWS,
                currentPreflight: null,
                timelineEvents: [
                    originalReviewerInvocation,
                    firstAttempt[0],
                    mutatedHistoricalSelection,
                    ...firstAttempt.slice(2),
                    ...secondAttempt
                ],
                reviewAttemptSummary: null
            });
            const historicalTransport = historicalArtifactSummary?.correction_transports?.find(
                (entry) => entry.transport === 'live_reviewer_continuation'
                    && entry.correction_attempt === 1
            );
            assert.equal(historicalArtifactSummary?.status, 'BLOCKED', historicalArtifactMutation.label);
            assert.equal(historicalTransport?.evidence_valid, false, historicalArtifactMutation.label);
            assert.match(
                historicalTransport?.violations.join(' ') || '',
                historicalArtifactMutation.violation,
                historicalArtifactMutation.label
            );
        }

        const forgedHistoricalPredecessorPackageSha256 = 'b'.repeat(64);
        const forgedHistoricalPredecessor = buildReviewFindingsAuditSummary({
            repoRoot,
            reviewsRoot,
            taskId,
            requiredReviews: CORRECTION_REQUIRED_REVIEWS,
            currentPreflight: null,
            timelineEvents: [
                originalReviewerInvocation,
                correctionEvent('REVIEW_OUTPUT_CORRECTION_REQUIRED', {
                    ...firstAttempt[0].details,
                    correction_package_sha256: forgedHistoricalPredecessorPackageSha256
                }),
                correctionEvent(firstAttempt[1].event_type, {
                    ...firstAttempt[1].details,
                    previous_correction_package_sha256: forgedHistoricalPredecessorPackageSha256
                }),
                ...firstAttempt.slice(2),
                ...secondAttempt
            ],
            reviewAttemptSummary: null
        });
        const forgedHistoricalPredecessorViolations = forgedHistoricalPredecessor
            ?.correction_transports
            ?.flatMap((entry) => entry.violations)
            .join(' ') || '';
        assert.equal(forgedHistoricalPredecessor?.status, 'BLOCKED');
        assert.match(
            forgedHistoricalPredecessorViolations,
            /not derived from its validation-rejection predecessor package/iu
        );
        const forgedHistoricalPredecessorResponses = forgedHistoricalPredecessor
            ?.correction_transports
            ?.filter((entry) => (
                entry.correction_package_sha256 === firstAttempt[1].details.correction_package_sha256
                && (entry.transport === 'invocation_attestation' || entry.transport === 'acceptance')
            )) || [];
        assert.equal(forgedHistoricalPredecessorResponses.length, 2);
        assert.equal(
            forgedHistoricalPredecessorResponses.every((entry) => !entry.evidence_valid),
            true
        );

        for (const eventIndex of [0, 1, 2, 3]) {
            for (const invalidTaskId of [undefined, 'T-FOREIGN-CORRECTION-HISTORY']) {
                const invalidHistoricalEvent = correctionEvent(firstAttempt[eventIndex].event_type, {
                    ...firstAttempt[eventIndex].details,
                    task_id: invalidTaskId
                });
                const invalidHistoricalTaskSummary = buildReviewFindingsAuditSummary({
                    repoRoot,
                    reviewsRoot,
                    taskId,
                    requiredReviews: CORRECTION_REQUIRED_REVIEWS,
                    currentPreflight: null,
                    timelineEvents: [
                        originalReviewerInvocation,
                        ...firstAttempt.map((event, index) => (
                            index === eventIndex ? invalidHistoricalEvent : event
                        )),
                        ...secondAttempt
                    ],
                    reviewAttemptSummary: null
                });
                const invalidHistoricalTaskViolations = invalidHistoricalTaskSummary?.correction_transports
                    ?.flatMap((entry) => entry.violations)
                    .join(' ') || '';
                assert.equal(invalidHistoricalTaskSummary?.status, 'BLOCKED');
                assert.match(invalidHistoricalTaskViolations, /not bound to the audited task/iu);
            }
        }

        const retrySummary = buildReviewFindingsAuditSummary({
            repoRoot,
            reviewsRoot,
            taskId,
            requiredReviews: CORRECTION_REQUIRED_REVIEWS,
            currentPreflight: null,
            timelineEvents: [
                originalReviewerInvocation,
                ...firstAttempt.slice(0, 3),
                ...secondAttempt
            ],
            reviewAttemptSummary: null
        });
        assert.notEqual(retrySummary?.status, 'BLOCKED');
        assert.equal(retrySummary?.correction_transports?.every((entry) => entry.evidence_valid), true);

        const outOfOrderRetrySummary = buildReviewFindingsAuditSummary({
            repoRoot,
            reviewsRoot,
            taskId,
            requiredReviews: CORRECTION_REQUIRED_REVIEWS,
            currentPreflight: null,
            timelineEvents: [
                originalReviewerInvocation,
                ...firstAttempt.slice(0, 2),
                secondAttempt[0],
                firstAttempt[2],
                ...secondAttempt.slice(1)
            ],
            reviewAttemptSummary: null
        });
        assert.equal(outOfOrderRetrySummary?.status, 'BLOCKED');
        assert.match(
            outOfOrderRetrySummary?.correction_transports?.[1]?.violations.join(' ') || '',
            /lacks a consecutive rejected-output retry/iu
        );

        const forgedRetryRequired = correctionEvent('REVIEW_OUTPUT_CORRECTION_REQUIRED', {
            ...secondAttempt[0].details,
            reviewer_identity: 'agent:unrelated-reviewer'
        });
        const forgedRetrySummary = buildReviewFindingsAuditSummary({
            repoRoot,
            reviewsRoot,
            taskId,
            requiredReviews: CORRECTION_REQUIRED_REVIEWS,
            currentPreflight: null,
            timelineEvents: [
                originalReviewerInvocation,
                ...firstAttempt.slice(0, 3),
                forgedRetryRequired,
                ...secondAttempt.slice(1)
            ],
            reviewAttemptSummary: null
        });
        assert.equal(forgedRetrySummary?.status, 'BLOCKED');
        assert.match(
            forgedRetrySummary?.correction_transports?.[1]?.violations.join(' ') || '',
            /invocation lacks a consecutive rejected-output retry/iu
        );

        const forgedRetryPackageRequired = correctionEvent('REVIEW_OUTPUT_CORRECTION_REQUIRED', {
            ...secondAttempt[0].details,
            correction_package_sha256: 'a'.repeat(64)
        });
        const forgedRetryPackageSummary = buildReviewFindingsAuditSummary({
            repoRoot,
            reviewsRoot,
            taskId,
            requiredReviews: CORRECTION_REQUIRED_REVIEWS,
            currentPreflight: null,
            timelineEvents: [
                originalReviewerInvocation,
                ...firstAttempt.slice(0, 3),
                forgedRetryPackageRequired,
                ...secondAttempt.slice(1)
            ],
            reviewAttemptSummary: null
        });
        const firstHistoricalTransport = forgedRetryPackageSummary?.correction_transports?.find(
            (entry) => entry.transport === 'live_reviewer_continuation'
                && entry.correction_attempt === 1
        );
        assert.equal(firstHistoricalTransport?.evidence_valid, false);
        assert.match(
            firstHistoricalTransport?.violations.join(' ') || '',
            /lacks a consecutive rejected-output retry/iu
        );

        for (const retryContinuityMutation of [
            {
                label: 'non-consecutive correction attempt',
                details: { correction_attempt: 3 }
            },
            {
                label: 'cross-attempt rejection replay',
                details: { reviewer_attempt_id: 'attempt-2' }
            },
            {
                label: 'cross-provider-invocation rejection replay',
                details: { provider_invocation_id: '/root/foreign-review' }
            },
            {
                label: 'non-canonical rejection artifact path',
                details: {
                    correction_artifact_path: path.join(
                        reviewsRoot,
                        `${taskId}-security-output-correction.json`
                    )
                }
            }
        ]) {
            const mutatedRetryRejection = correctionEvent(
                'REVIEW_OUTPUT_CORRECTION_REQUIRED',
                {
                    ...secondAttempt[0].details,
                    ...retryContinuityMutation.details
                }
            );
            const mutatedRetrySummary = buildReviewFindingsAuditSummary({
                repoRoot,
                reviewsRoot,
                taskId,
                requiredReviews: CORRECTION_REQUIRED_REVIEWS,
                currentPreflight: null,
                timelineEvents: [
                    originalReviewerInvocation,
                    ...firstAttempt.slice(0, 3),
                    mutatedRetryRejection,
                    ...secondAttempt.slice(1)
                ],
                reviewAttemptSummary: null
            });
            const mutatedHistoricalTransport = mutatedRetrySummary?.correction_transports?.find(
                (entry) => entry.transport === 'live_reviewer_continuation'
                    && entry.correction_attempt === 1
            );
            assert.equal(mutatedRetrySummary?.status, 'BLOCKED', retryContinuityMutation.label);
            assert.equal(
                mutatedHistoricalTransport?.evidence_valid,
                false,
                retryContinuityMutation.label
            );
            assert.match(
                mutatedHistoricalTransport?.violations.join(' ') || '',
                /lacks a consecutive rejected-output retry/iu,
                retryContinuityMutation.label
            );
        }

        const forgedNextSelectionPredecessor = correctionEvent(
            'REVIEW_OUTPUT_CORRECTION_LIVE_CONTINUATION',
            {
                ...secondAttempt[1].details,
                previous_correction_package_sha256: 'b'.repeat(64)
            }
        );
        const forgedNextSelectionPredecessorSummary = buildReviewFindingsAuditSummary({
            repoRoot,
            reviewsRoot,
            taskId,
            requiredReviews: CORRECTION_REQUIRED_REVIEWS,
            currentPreflight: null,
            timelineEvents: [
                originalReviewerInvocation,
                ...firstAttempt.slice(0, 3),
                secondAttempt[0],
                forgedNextSelectionPredecessor,
                ...secondAttempt.slice(2)
            ],
            reviewAttemptSummary: null
        });
        const predecessorBoundHistoricalTransport = forgedNextSelectionPredecessorSummary
            ?.correction_transports?.find(
                (entry) => entry.transport === 'live_reviewer_continuation'
                    && entry.correction_attempt === 1
            );
        assert.equal(forgedNextSelectionPredecessorSummary?.status, 'BLOCKED');
        assert.equal(predecessorBoundHistoricalTransport?.evidence_valid, false);
        assert.match(
            predecessorBoundHistoricalTransport?.violations.join(' ') || '',
            /lacks a consecutive rejected-output retry/iu
        );

        const untrustedHistoricalInvocation = correctionEvent(
            'REVIEW_OUTPUT_CORRECTION_INVOCATION_ATTESTED',
            {
                ...firstAttempt[2].details,
                attestation_source: 'manual'
            }
        );
        const untrustedHistoricalRetrySummary = buildReviewFindingsAuditSummary({
            repoRoot,
            reviewsRoot,
            taskId,
            requiredReviews: CORRECTION_REQUIRED_REVIEWS,
            currentPreflight: null,
            timelineEvents: [
                originalReviewerInvocation,
                ...firstAttempt.slice(0, 2),
                untrustedHistoricalInvocation,
                ...secondAttempt
            ],
            reviewAttemptSummary: null
        });
        assert.equal(untrustedHistoricalRetrySummary?.status, 'BLOCKED');
        assert.match(
            untrustedHistoricalRetrySummary?.correction_transports?.[1]?.violations.join(' ') || '',
            /not bound to its provider invocation attestation/iu
        );

        const forgedHistoricalReviewerInvocation = correctionEvent(
            'REVIEW_OUTPUT_CORRECTION_INVOCATION_ATTESTED',
            {
                ...firstAttempt[2].details,
                reviewer_invocation_event_sha256: 'a'.repeat(64)
            }
        );
        const forgedHistoricalReviewerInvocationSummary = buildReviewFindingsAuditSummary({
            repoRoot,
            reviewsRoot,
            taskId,
            requiredReviews: CORRECTION_REQUIRED_REVIEWS,
            currentPreflight: null,
            timelineEvents: [
                originalReviewerInvocation,
                ...firstAttempt.slice(0, 2),
                forgedHistoricalReviewerInvocation,
                firstAttempt[3],
                ...secondAttempt
            ],
            reviewAttemptSummary: null
        });
        assert.equal(forgedHistoricalReviewerInvocationSummary?.status, 'BLOCKED');
        assert.match(
            forgedHistoricalReviewerInvocationSummary
                ?.correction_transports?.[1]?.violations.join(' ') || '',
            /not bound to its provider invocation attestation/iu
        );

        const forgedHistoricalReviewerAttempt = correctionEvent(
            'REVIEW_OUTPUT_CORRECTION_INVOCATION_ATTESTED',
            {
                ...firstAttempt[2].details,
                reviewer_attempt_id: 'forged-attempt'
            }
        );
        const forgedHistoricalReviewerAttemptSummary = buildReviewFindingsAuditSummary({
            repoRoot,
            reviewsRoot,
            taskId,
            requiredReviews: CORRECTION_REQUIRED_REVIEWS,
            currentPreflight: null,
            timelineEvents: [
                originalReviewerInvocation,
                ...firstAttempt.slice(0, 2),
                forgedHistoricalReviewerAttempt,
                firstAttempt[3],
                ...secondAttempt
            ],
            reviewAttemptSummary: null
        });
        assert.equal(forgedHistoricalReviewerAttemptSummary?.status, 'BLOCKED');
        assert.match(
            forgedHistoricalReviewerAttemptSummary
                ?.correction_transports?.[1]?.violations.join(' ') || '',
            /not bound to its provider invocation attestation/iu
        );

        const forgedHistoricalInvocation = correctionEvent('REVIEW_OUTPUT_CORRECTION_INVOCATION_ATTESTED', {
            ...firstAttempt[2].details,
            correction_package_sha256: 'f'.repeat(64)
        });
        const forgedHistoricalPackageSummary = buildReviewFindingsAuditSummary({
            repoRoot,
            reviewsRoot,
            taskId,
            requiredReviews: CORRECTION_REQUIRED_REVIEWS,
            currentPreflight: null,
            timelineEvents: [
                originalReviewerInvocation,
                ...firstAttempt.slice(0, 2),
                forgedHistoricalInvocation,
                ...secondAttempt
            ],
            reviewAttemptSummary: null
        });
        assert.equal(forgedHistoricalPackageSummary?.status, 'BLOCKED');
        assert.match(
            forgedHistoricalPackageSummary?.correction_transports?.[1]?.violations.join(' ') || '',
            /not bound to its provider invocation attestation/iu
        );

        const forgedHistoricalSelection = correctionEvent('REVIEW_OUTPUT_CORRECTION_LIVE_CONTINUATION', {
            ...firstAttempt[1].details,
            correction_artifact_sha256: 'a'.repeat(64)
        });
        const forgedHistoricalAcceptance = correctionEvent('REVIEW_OUTPUT_CORRECTION_ACCEPTED', {
            ...firstAttempt[3].details,
            correction_artifact_sha256: 'a'.repeat(64)
        });
        const forgedHistoricalArtifactSummary = buildReviewFindingsAuditSummary({
            repoRoot,
            reviewsRoot,
            taskId,
            requiredReviews: CORRECTION_REQUIRED_REVIEWS,
            currentPreflight: null,
            timelineEvents: [
                originalReviewerInvocation,
                firstAttempt[0],
                forgedHistoricalSelection,
                firstAttempt[2],
                forgedHistoricalAcceptance,
                ...secondAttempt
            ],
            reviewAttemptSummary: null
        });
        assert.equal(forgedHistoricalArtifactSummary?.status, 'BLOCKED');
        assert.match(
            forgedHistoricalArtifactSummary?.correction_transports?.[1]?.violations.join(' ') || '',
            /snapshot does not match transport telemetry/iu
        );

        const forgedHistoricalAcceptanceOnly = correctionEvent('REVIEW_OUTPUT_CORRECTION_ACCEPTED', {
            ...firstAttempt[3].details,
            correction_artifact_sha256: 'b'.repeat(64)
        });
        const forgedHistoricalAcceptanceSummary = buildReviewFindingsAuditSummary({
            repoRoot,
            reviewsRoot,
            taskId,
            requiredReviews: CORRECTION_REQUIRED_REVIEWS,
            currentPreflight: null,
            timelineEvents: [
                originalReviewerInvocation,
                ...firstAttempt.slice(0, 3),
                forgedHistoricalAcceptanceOnly,
                ...secondAttempt
            ],
            reviewAttemptSummary: null
        });
        assert.equal(forgedHistoricalAcceptanceSummary?.status, 'BLOCKED');
        assert.match(
            forgedHistoricalAcceptanceSummary?.correction_transports?.[1]?.violations.join(' ') || '',
            /acceptance is not bound to its transport and invocation/iu
        );

        const forgedHistoricalAttestation = correctionEvent('REVIEW_OUTPUT_CORRECTION_LIVE_CONTINUATION', {
            ...firstAttempt[1].details,
            availability_provider_response_sha256: 'a'.repeat(64)
        });
        const forgedHistoricalAttestationSummary = buildReviewFindingsAuditSummary({
            repoRoot,
            reviewsRoot,
            taskId,
            requiredReviews: CORRECTION_REQUIRED_REVIEWS,
            currentPreflight: null,
            timelineEvents: [
                originalReviewerInvocation,
                firstAttempt[0],
                forgedHistoricalAttestation,
                firstAttempt[2],
                firstAttempt[3],
                ...secondAttempt
            ],
            reviewAttemptSummary: null
        });
        assert.equal(forgedHistoricalAttestationSummary?.status, 'BLOCKED');
        assert.match(
            forgedHistoricalAttestationSummary?.correction_transports?.[1]?.violations.join(' ') || '',
            /snapshot does not match transport telemetry/iu
        );
    });

    it('reconstruction scale: bounds evidence visits and correction artifact reads per attempt', () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-correction-audit-scale-'));
        const reviewsRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews');
        fs.mkdirSync(reviewsRoot, { recursive: true });
        tempRoots.push(repoRoot);
        const taskId = 'T-AUDIT-CORRECTION-SCALE';
        const reviewType = 'code';
        const reviewerIdentity = 'agent:code-reviewer';
        const providerInvocationId = '/root/code-review';
        const reviewerInvocationEventSha256 = '9'.repeat(64);
        const correctionAttemptCount = 24;
        const capabilities = {
            live_reviewer_continuation: true,
            api_conversation_continuation: false,
            correction_only_invocation: true
        };
        const timelineEvents: CorrectionEvent[] = [reviewerInvocationEvent({
            taskId,
            reviewType,
            reviewerIdentity,
            providerId: 'Codex',
            providerInvocationId,
            eventSha256: reviewerInvocationEventSha256
        })];
        for (let correctionAttempt = 1; correctionAttempt <= correctionAttemptCount; correctionAttempt += 1) {
            timelineEvents.push(...buildHistoricalLiveCorrectionAttempt({
                reviewsRoot,
                taskId,
                correctionAttempt,
                reviewType,
                reviewerIdentity,
                providerInvocationId,
                reviewerInvocationEventSha256,
                maxCorrectionAttempts: correctionAttemptCount,
                capabilities
            }));
        }
        const workMetricsCapture: { value?: {
            timeline_events_indexed: number;
            evidence_events_windowed: number;
            evidence_candidates_examined: number;
            selection_candidates_examined: number;
            artifact_reads: number;
            artifact_read_cache_hits: number;
            artifact_hash_reads: number;
            artifact_hash_cache_hits: number;
        } } = {};

        const summary = buildReviewFindingsAuditSummary({
            repoRoot,
            reviewsRoot,
            taskId,
            requiredReviews: CORRECTION_REQUIRED_REVIEWS,
            currentPreflight: null,
            timelineEvents,
            reviewAttemptSummary: null,
            _testHooks: {
                onCorrectionTransportWorkMetrics(metrics) {
                    workMetricsCapture.value = { ...metrics };
                }
            }
        });

        assert.notEqual(
            summary?.status,
            'BLOCKED',
            JSON.stringify(summary?.correction_transports, null, 2)
        );
        assert.equal(summary?.correction_transports?.every((entry) => entry.evidence_valid), true);
        const workMetrics = workMetricsCapture.value;
        assert.ok(workMetrics);
        assert.equal(workMetrics.timeline_events_indexed, timelineEvents.length);
        assert.equal(workMetrics.evidence_events_windowed, (correctionAttemptCount * 3) - 1);
        assert.equal(
            workMetrics.evidence_candidates_examined,
            workMetrics.evidence_events_windowed,
            'Each accepted response, invocation attestation, and retry rejection must be examined once.'
        );
        assert.equal(
            workMetrics.selection_candidates_examined,
            correctionAttemptCount,
            'Each validation rejection must inspect only its package-indexed successor.'
        );
        assert.equal(
            workMetrics.artifact_reads,
            correctionAttemptCount + 1,
            'Each immutable snapshot and the one canonical current artifact must be read once.'
        );
        assert.equal(workMetrics.artifact_hash_reads, correctionAttemptCount);
    });

    it('reconstruction boundary: rejects escaped review types and binds FULL relaunch artifacts', () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-correction-audit-types-'));
        const reviewsRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews');
        fs.mkdirSync(reviewsRoot, { recursive: true });
        tempRoots.push(repoRoot);
        const apiCapabilities = {
            live_reviewer_continuation: false,
            api_conversation_continuation: true,
            correction_only_invocation: true
        };
        const correctionOnlyCapabilities = {
            live_reviewer_continuation: true,
            api_conversation_continuation: false,
            correction_only_invocation: true
        };
        const fullRelaunchCapabilities = {
            live_reviewer_continuation: false,
            api_conversation_continuation: false,
            correction_only_invocation: false
        };
        const taskId = 'T-AUDIT-CORRECTION-TRANSPORT-TYPES';
        const apiReviewerInvocation = reviewerInvocationEvent({
            taskId,
            reviewType: 'api',
            reviewerIdentity: 'agent:api-reviewer',
            providerId: 'FutureApiProvider',
            providerInvocationId: 'provider-api-1',
            eventSha256: '2'.repeat(64)
        });
        const securityReviewerInvocation = reviewerInvocationEvent({
            taskId,
            reviewType: 'security',
            reviewerIdentity: 'agent:security-reviewer',
            providerId: 'Codex',
            providerInvocationId: 'provider-security-1',
            eventSha256: '5'.repeat(64)
        });
        const testReviewerInvocation = reviewerInvocationEvent({
            taskId,
            reviewType: 'test',
            reviewerIdentity: 'agent:test-reviewer',
            providerId: 'Codex',
            providerInvocationId: 'provider-test-1',
            eventSha256: '4'.repeat(64)
        });
        const persistedApi = writeSelectedCorrectionFixture({
            reviewsRoot,
            taskId,
            reviewType: 'api',
            reviewerIdentity: 'agent:api-reviewer',
            providerId: 'FutureApiProvider',
            providerInvocationId: 'provider-api-1',
            reviewerInvocationEventSha256: '2'.repeat(64),
            capabilities: apiCapabilities,
            sessionAvailability: 'stateless'
        });
        const acceptedApi = buildReviewOutputCorrectionApiContinuationAcceptance({
            artifactPath: persistedApi.artifactPath,
            artifact: readReviewOutputCorrectionArtifact(persistedApi.artifactPath).artifact!,
            reviewerIdentity: 'agent:api-reviewer',
            providerInvocationId: 'provider-api-1',
            providerInvocationEventSha256: '2'.repeat(64),
            providerResponseEventSha256: '8'.repeat(64),
            providerResponseSha256: '9'.repeat(64),
            attestationSource: 'codex_collaboration_followup_task',
            reason: 'Authenticated API correction response accepted.',
            now: '2026-08-21T00:02:00.000Z'
        });
        fs.writeFileSync(persistedApi.artifactPath, `${JSON.stringify(acceptedApi, null, 2)}\n`, 'utf8');
        const persistedSecurity = writeSelectedCorrectionFixture({
            reviewsRoot,
            taskId,
            reviewType: 'security',
            reviewerIdentity: 'agent:security-reviewer',
            providerId: 'Codex',
            providerInvocationId: 'provider-security-1',
            reviewerInvocationEventSha256: '5'.repeat(64),
            capabilities: correctionOnlyCapabilities,
            sessionAvailability: 'closed'
        });
        const acceptedSecurity = buildReviewOutputCorrectionCorrectionOnlyAcceptance({
            artifactPath: persistedSecurity.artifactPath,
            artifact: readReviewOutputCorrectionArtifact(persistedSecurity.artifactPath).artifact!,
            reviewerIdentity: 'agent:security-correction-reviewer',
            providerInvocationId: 'provider-security-correction-1',
            providerInvocationEventSha256: 'a'.repeat(64),
            providerResponseEventSha256: 'b'.repeat(64),
            providerResponseSha256: 'c'.repeat(64),
            attestationSource: 'codex_collaboration_spawn_agent',
            reason: 'Authenticated correction-only response accepted.',
            now: '2026-08-21T00:02:00.000Z'
        });
        fs.writeFileSync(persistedSecurity.artifactPath, `${JSON.stringify(acceptedSecurity, null, 2)}\n`, 'utf8');
        const persistedFull = writeSelectedCorrectionFixture({
            reviewsRoot,
            taskId,
            reviewType: 'test',
            reviewerIdentity: 'agent:test-reviewer',
            providerId: 'Codex',
            providerInvocationId: 'provider-test-1',
            reviewerInvocationEventSha256: '4'.repeat(64),
            capabilities: fullRelaunchCapabilities,
            sessionAvailability: 'stateless',
            correctionAttempt: 2
        });
        const fullArtifact = readReviewOutputCorrectionArtifact(persistedFull.artifactPath).artifact!;
        const events = [
            correctionEvent('REVIEW_OUTPUT_CORRECTION_REQUIRED', {
                task_id: taskId,
                review_type: 'api',
                correction_attempt: 1,
                correction_package_sha256: persistedApi.previousFileSha256,
                reviewer_identity: 'agent:api-reviewer',
                reviewer_attempt_id: 'attempt-1',
                provider_id: 'FutureApiProvider',
                provider_invocation_id: 'provider-api-1',
                reviewer_invocation_event_sha256: '2'.repeat(64)
            }),
            correctionEvent('REVIEW_OUTPUT_CORRECTION_API_CONTINUATION', {
                task_id: taskId,
                review_type: 'api',
                correction_attempt: 1,
                previous_correction_package_sha256: persistedApi.previousFileSha256,
                correction_package_sha256: persistedApi.selectedFileSha256,
                correction_artifact_path: persistedApi.artifactPath,
                correction_artifact_sha256: persistedApi.artifactSha256,
                reviewer_identity: 'agent:api-reviewer',
                reviewer_attempt_id: 'attempt-1',
                provider_id: 'FutureApiProvider',
                provider_invocation_id: 'provider-api-1',
                reviewer_invocation_event_sha256: '2'.repeat(64),
                provider_capabilities: apiCapabilities,
                provider_capabilities_sha256: computeReviewOutputCorrectionProviderCapabilitiesSha256({
                    providerId: 'FutureApiProvider',
                    capabilities: apiCapabilities
                }),
                availability_attestation_source: REVIEW_OUTPUT_CORRECTION_FAIL_CLOSED_ATTESTATION_SOURCE,
                availability_evidence_type: 'fail_closed_no_provider_session_receipt',
                session_availability: 'stateless'
            }),
            correctionEvent('REVIEW_OUTPUT_CORRECTION_INVOCATION_ATTESTED', {
                task_id: taskId,
                review_type: 'api',
                correction_attempt: 1,
                reviewer_invocation_event_sha256: '2'.repeat(64),
                original_reviewer_identity: 'agent:api-reviewer',
                reviewer_attempt_id: 'attempt-1',
                correction_producer_identity: 'agent:api-reviewer',
                provider_invocation_id: 'provider-api-1',
                attestation_source: 'codex_collaboration_followup_task',
                corrected_output_sha256: '9'.repeat(64),
                provider_response_event_sha256: '8'.repeat(64),
                selected_transport: 'api_conversation_continuation',
                correction_package_sha256: persistedApi.selectedFileSha256,
                provider_id: 'FutureApiProvider',
                provider_capabilities_sha256: computeReviewOutputCorrectionProviderCapabilitiesSha256({
                    providerId: 'FutureApiProvider',
                    capabilities: apiCapabilities
                }),
                session_availability: 'stateless'
            }),
            correctionEvent('REVIEW_OUTPUT_CORRECTION_ACCEPTED', {
                task_id: taskId,
                review_type: 'api',
                reviewer_identity: 'agent:api-reviewer',
                reviewer_attempt_id: 'attempt-1',
                correction_producer_identity: 'agent:api-reviewer',
                provider_invocation_id: 'provider-api-1',
                attestation_source: 'codex_collaboration_followup_task',
                provider_response_event_sha256: '8'.repeat(64),
                corrected_output_sha256: '9'.repeat(64),
                selected_transport: 'api_conversation_continuation',
                correction_artifact_path: persistedApi.artifactPath,
                correction_artifact_sha256: acceptedApi.artifact_sha256,
                correction_package_sha256: persistedApi.selectedFileSha256,
                original_output_sha256: acceptedApi.binding.original_output_sha256,
                findings_semantic_fingerprint: acceptedApi.binding.findings_semantic_fingerprint,
                provider_id: 'FutureApiProvider',
                provider_capabilities_sha256: computeReviewOutputCorrectionProviderCapabilitiesSha256({
                    providerId: 'FutureApiProvider',
                    capabilities: apiCapabilities
                }),
                session_availability: 'stateless'
            }),
            correctionEvent('REVIEW_OUTPUT_CORRECTION_REQUIRED', {
                task_id: taskId,
                review_type: 'security',
                correction_attempt: 1,
                correction_package_sha256: persistedSecurity.previousFileSha256,
                reviewer_identity: 'agent:security-reviewer',
                reviewer_attempt_id: 'attempt-1',
                provider_id: 'Codex',
                provider_invocation_id: 'provider-security-1',
                reviewer_invocation_event_sha256: '5'.repeat(64)
            }),
            correctionEvent('REVIEW_OUTPUT_CORRECTION_ONLY_INVOCATION', {
                task_id: taskId,
                review_type: 'security',
                correction_attempt: 1,
                previous_correction_package_sha256: persistedSecurity.previousFileSha256,
                correction_package_sha256: persistedSecurity.selectedFileSha256,
                correction_artifact_path: persistedSecurity.artifactPath,
                correction_artifact_sha256: persistedSecurity.artifactSha256,
                reviewer_identity: 'agent:security-reviewer',
                reviewer_attempt_id: 'attempt-1',
                provider_id: 'Codex',
                provider_invocation_id: 'provider-security-1',
                reviewer_invocation_event_sha256: '5'.repeat(64),
                provider_capabilities: correctionOnlyCapabilities,
                provider_capabilities_sha256: computeReviewOutputCorrectionProviderCapabilitiesSha256({
                    providerId: 'Codex',
                    capabilities: correctionOnlyCapabilities
                }),
                availability_attestation_source: REVIEW_OUTPUT_CORRECTION_FAIL_CLOSED_ATTESTATION_SOURCE,
                availability_evidence_type: 'fail_closed_no_provider_session_receipt',
                session_availability: 'closed'
            }),
            correctionEvent('REVIEW_OUTPUT_CORRECTION_INVOCATION_ATTESTED', {
                task_id: taskId,
                review_type: 'security',
                correction_attempt: 1,
                reviewer_invocation_event_sha256: '5'.repeat(64),
                original_reviewer_identity: 'agent:security-reviewer',
                reviewer_attempt_id: 'attempt-1',
                correction_producer_identity: 'agent:security-correction-reviewer',
                provider_invocation_id: 'provider-security-correction-1',
                attestation_source: 'codex_collaboration_spawn_agent',
                corrected_output_sha256: 'c'.repeat(64),
                provider_response_event_sha256: 'b'.repeat(64),
                selected_transport: 'correction_only_invocation',
                correction_package_sha256: persistedSecurity.selectedFileSha256,
                provider_id: 'Codex',
                provider_capabilities_sha256: computeReviewOutputCorrectionProviderCapabilitiesSha256({
                    providerId: 'Codex',
                    capabilities: correctionOnlyCapabilities
                }),
                session_availability: 'closed'
            }),
            correctionEvent('REVIEW_OUTPUT_CORRECTION_ACCEPTED', {
                task_id: taskId,
                review_type: 'security',
                reviewer_identity: 'agent:security-reviewer',
                reviewer_attempt_id: 'attempt-1',
                correction_producer_identity: 'agent:security-correction-reviewer',
                provider_invocation_id: 'provider-security-correction-1',
                attestation_source: 'codex_collaboration_spawn_agent',
                provider_response_event_sha256: 'b'.repeat(64),
                corrected_output_sha256: 'c'.repeat(64),
                selected_transport: 'correction_only_invocation',
                correction_artifact_path: persistedSecurity.artifactPath,
                correction_artifact_sha256: acceptedSecurity.artifact_sha256,
                correction_package_sha256: persistedSecurity.selectedFileSha256,
                original_output_sha256: acceptedSecurity.binding.original_output_sha256,
                findings_semantic_fingerprint: acceptedSecurity.binding.findings_semantic_fingerprint,
                provider_id: 'Codex',
                provider_capabilities_sha256: computeReviewOutputCorrectionProviderCapabilitiesSha256({
                    providerId: 'Codex',
                    capabilities: correctionOnlyCapabilities
                }),
                session_availability: 'closed'
            }),
            correctionEvent('REVIEW_OUTPUT_CORRECTION_FULL_REVIEW_REQUIRED', {
                task_id: taskId,
                review_type: 'test',
                correction_attempt: 2,
                correction_package_sha256: persistedFull.selectedFileSha256,
                correction_artifact_path: persistedFull.artifactPath,
                correction_artifact_sha256: persistedFull.artifactSha256,
                reviewer_identity: 'agent:test-reviewer',
                reviewer_attempt_id: 'attempt-1',
                provider_id: 'Codex',
                provider_invocation_id: 'provider-test-1',
                reviewer_invocation_event_sha256: '4'.repeat(64),
                provider_capabilities: fullRelaunchCapabilities,
                provider_capabilities_sha256: computeReviewOutputCorrectionProviderCapabilitiesSha256({
                    providerId: 'Codex',
                    capabilities: fullRelaunchCapabilities
                }),
                availability_attestation_source:
                    fullArtifact.transport_binding?.availability_attestation?.attestation_source,
                availability_evidence_type:
                    fullArtifact.transport_binding?.availability_attestation?.evidence_type,
                session_availability: fullArtifact.transport_binding?.session_availability
            })
        ];
        const summary = buildReviewFindingsAuditSummary({
            repoRoot,
            reviewsRoot,
            taskId,
            requiredReviews: CORRECTION_REQUIRED_REVIEWS,
            currentPreflight: null,
            timelineEvents: [
                apiReviewerInvocation,
                securityReviewerInvocation,
                testReviewerInvocation,
                ...events
            ],
            reviewAttemptSummary: null
        });

        assert.deepEqual(
            summary?.correction_transports?.map((entry) => entry.transport),
            [
                'validation_rejection',
                'api_conversation_continuation',
                'validation_rejection',
                'correction_only_invocation',
                'full_reviewer_relaunch',
                'invocation_attestation',
                'invocation_attestation',
                'acceptance',
                'acceptance'
            ]
        );
        assert.notEqual(
            summary?.status,
            'BLOCKED',
            JSON.stringify(summary?.correction_transports, null, 2)
        );
        assert.equal(
            summary?.correction_transports?.slice(0, 4).every((entry) => entry.evidence_valid),
            true,
            JSON.stringify(summary?.correction_transports?.slice(0, 4), null, 2)
        );
        assert.equal(summary?.correction_transports?.[4]?.evidence_valid, true);
        assert.equal(summary?.correction_transports?.at(-1)?.evidence_valid, true);

        const forgedAcceptedApiSelectionAttestation = buildReviewFindingsAuditSummary({
            repoRoot,
            reviewsRoot,
            taskId,
            requiredReviews: CORRECTION_REQUIRED_REVIEWS,
            currentPreflight: null,
            timelineEvents: [
                apiReviewerInvocation,
                ...events.map((event, index) => index === 1
                    ? correctionEvent(event.event_type, {
                        ...event.details,
                        availability_attestation_source: 'codex_collaboration_followup_task',
                        availability_evidence_type: 'provider_native_session_receipt',
                        availability_provider_invocation_event_sha256: '2'.repeat(64),
                        availability_provider_response_sha256: '7'.repeat(64)
                    })
                    : event)
            ],
            reviewAttemptSummary: null
        });
        const forgedAcceptedApiTransport = forgedAcceptedApiSelectionAttestation
            ?.correction_transports
            ?.find((entry) => entry.transport === 'api_conversation_continuation');
        assert.equal(forgedAcceptedApiSelectionAttestation?.status, 'BLOCKED');
        assert.equal(forgedAcceptedApiTransport?.evidence_valid, false);
        assert.match(
            forgedAcceptedApiTransport?.violations.join(' ') || '',
            /not bound to its selected package snapshot/iu
        );

        const forgedAcceptedApiPackageSha256 = 'f'.repeat(64);
        const forgedAcceptedApiPackageSummary = buildReviewFindingsAuditSummary({
            repoRoot,
            reviewsRoot,
            taskId,
            requiredReviews: CORRECTION_REQUIRED_REVIEWS,
            currentPreflight: null,
            timelineEvents: [
                apiReviewerInvocation,
                ...events.slice(0, 4).map((event, index) => correctionEvent(event.event_type, {
                    ...event.details,
                    ...(index > 0 ? { correction_package_sha256: forgedAcceptedApiPackageSha256 } : {}),
                    ...(index === 1 ? { correction_artifact_sha256: acceptedApi.artifact_sha256 } : {})
                }))
            ],
            reviewAttemptSummary: null
        });
        const forgedAcceptedApiPackageTransport = forgedAcceptedApiPackageSummary
            ?.correction_transports
            ?.find((entry) => entry.transport === 'api_conversation_continuation');
        assert.equal(forgedAcceptedApiPackageSummary?.status, 'BLOCKED');
        assert.equal(forgedAcceptedApiPackageTransport?.evidence_valid, false);
        assert.match(
            forgedAcceptedApiPackageTransport?.violations.join(' ') || '',
            /not bound to its selected package snapshot/iu
        );

        const fullRelaunchEvent = events.at(-1)!;
        for (const fullRelaunchMutation of [
            {
                label: 'predecessor package instead of direct current package binding',
                details: { previous_correction_package_sha256: persistedFull.previousFileSha256 },
                violation: /must bind directly to its current correction package/iu
            },
            {
                label: 'mismatched current correction package hash',
                details: { correction_package_sha256: 'f'.repeat(64) },
                violation: /file hash does not match transport telemetry/iu
            },
            {
                label: 'non-canonical current artifact path',
                details: { correction_artifact_path: path.join(repoRoot, 'outside-full.json') },
                violation: /does not reference its canonical correction artifact/iu
            },
            {
                label: 'forged fail-closed availability attestation',
                details: { availability_evidence_type: 'caller_claim' },
                violation: /canonical fail-closed availability evidence|transport event provenance/iu
            }
        ]) {
            const forgedFullRelaunch = buildReviewFindingsAuditSummary({
                repoRoot,
                reviewsRoot,
                taskId,
                requiredReviews: CORRECTION_REQUIRED_REVIEWS,
                currentPreflight: null,
                timelineEvents: [
                    testReviewerInvocation,
                    correctionEvent(fullRelaunchEvent.event_type, {
                        ...fullRelaunchEvent.details,
                        ...fullRelaunchMutation.details
                    })
                ],
                reviewAttemptSummary: null
            });
            const fullRelaunchTransport = forgedFullRelaunch?.correction_transports?.find(
                (entry) => entry.transport === 'full_reviewer_relaunch'
            );
            assert.equal(forgedFullRelaunch?.status, 'BLOCKED', fullRelaunchMutation.label);
            assert.equal(fullRelaunchTransport?.evidence_valid, false, fullRelaunchMutation.label);
            assert.match(
                fullRelaunchTransport?.violations.join(' ') || '',
                fullRelaunchMutation.violation,
                fullRelaunchMutation.label
            );
        }

        for (const forgedCurrentAcceptance of [
            {
                reviewType: 'api',
                originalInvocation: apiReviewerInvocation,
                artifactPath: persistedApi.artifactPath,
                artifact: acceptedApi,
                responseAttestation: 'availability' as const,
                eventOffset: 0
            },
            {
                reviewType: 'security',
                originalInvocation: securityReviewerInvocation,
                artifactPath: persistedSecurity.artifactPath,
                artifact: acceptedSecurity,
                responseAttestation: 'producer' as const,
                eventOffset: 4
            }
        ]) {
            const forgedArtifactWithoutHash = structuredClone(forgedCurrentAcceptance.artifact);
            delete forgedArtifactWithoutHash.artifact_sha256;
            const responseAttestation = forgedCurrentAcceptance.responseAttestation === 'producer'
                ? forgedArtifactWithoutHash.producer_response_attestation
                : forgedArtifactWithoutHash.transport_binding?.availability_attestation;
            assert.ok(responseAttestation);
            responseAttestation.attestation_source = 'manual';
            const forgedArtifact = {
                ...forgedArtifactWithoutHash,
                artifact_sha256: sha256RedactedJsonPayload(forgedArtifactWithoutHash)
            };
            fs.writeFileSync(
                forgedCurrentAcceptance.artifactPath,
                `${JSON.stringify(forgedArtifact, null, 2)}\n`,
                'utf8'
            );
            const forgedArtifactRead = readReviewOutputCorrectionArtifact(
                forgedCurrentAcceptance.artifactPath
            );
            assert.match(
                forgedArtifactRead.violations.join(' '),
                forgedCurrentAcceptance.responseAttestation === 'producer'
                    ? /correction-only provider response receipt is invalid/iu
                    : /provider correction response receipt is invalid/iu,
                forgedCurrentAcceptance.reviewType
            );
            const requiredEvent = events[forgedCurrentAcceptance.eventOffset];
            const selectedEvent = events[forgedCurrentAcceptance.eventOffset + 1];
            const invocationEvent = events[forgedCurrentAcceptance.eventOffset + 2];
            const acceptanceEvent = events[forgedCurrentAcceptance.eventOffset + 3];
            const forgedAttestationSummary = buildReviewFindingsAuditSummary({
                repoRoot,
                reviewsRoot,
                taskId,
                requiredReviews: CORRECTION_REQUIRED_REVIEWS,
                currentPreflight: null,
                timelineEvents: [
                    forgedCurrentAcceptance.originalInvocation,
                    requiredEvent,
                    selectedEvent,
                    correctionEvent(invocationEvent.event_type, {
                        ...invocationEvent.details,
                        attestation_source: 'manual'
                    }),
                    correctionEvent(acceptanceEvent.event_type, {
                        ...acceptanceEvent.details,
                        attestation_source: 'manual',
                        correction_artifact_sha256: forgedArtifact.artifact_sha256
                    })
                ],
                reviewAttemptSummary: null
            });
            const forgedAttestationViolations = forgedAttestationSummary?.correction_transports
                ?.flatMap((entry) => entry.violations)
                .join(' ') || '';
            assert.equal(forgedAttestationSummary?.status, 'BLOCKED');
            assert.match(
                forgedAttestationViolations,
                /lacks an intact persisted correction artifact/iu,
                forgedCurrentAcceptance.reviewType
            );
            fs.writeFileSync(
                forgedCurrentAcceptance.artifactPath,
                `${JSON.stringify(forgedCurrentAcceptance.artifact, null, 2)}\n`,
                'utf8'
            );
        }

        const escapedReviewType = buildReviewFindingsAuditSummary({
            repoRoot,
            reviewsRoot,
            taskId,
            requiredReviews: CORRECTION_REQUIRED_REVIEWS,
            currentPreflight: null,
            timelineEvents: [
                correctionEvent('REVIEW_OUTPUT_CORRECTION_FULL_REVIEW_REQUIRED', {
                    ...events[6].details,
                    review_type: '../outside'
                })
            ],
            reviewAttemptSummary: null
        });
        assert.equal(escapedReviewType?.status, 'BLOCKED');
        assert.match(
            escapedReviewType?.correction_transports?.[0]?.violations.join(' ') || '',
            /lacks a canonical review type/iu
        );

        const deploymentReviewerInvocation = reviewerInvocationEvent({
            taskId,
            reviewType: 'deployment',
            reviewerIdentity: 'agent:deployment-reviewer',
            providerId: 'Codex',
            providerInvocationId: 'provider-deployment-1',
            eventSha256: '7'.repeat(64)
        });
        const unauthorizedReviewType = buildReviewFindingsAuditSummary({
            repoRoot,
            reviewsRoot,
            taskId,
            requiredReviews: CORRECTION_REQUIRED_REVIEWS,
            currentPreflight: null,
            timelineEvents: [
                deploymentReviewerInvocation,
                correctionEvent('REVIEW_OUTPUT_CORRECTION_REQUIRED', {
                    ...events[0].details,
                    review_type: 'deployment',
                    reviewer_identity: 'agent:deployment-reviewer',
                    provider_invocation_id: 'provider-deployment-1',
                    reviewer_invocation_event_sha256: '7'.repeat(64)
                })
            ],
            reviewAttemptSummary: null
        });
        assert.equal(unauthorizedReviewType?.status, 'BLOCKED');
        assert.match(
            unauthorizedReviewType?.correction_transports?.[0]?.violations.join(' ') || '',
            /review type is not authorized for the audited task/iu
        );
    });
});
