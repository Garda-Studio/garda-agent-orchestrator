import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';

import { fileSha256 } from '../../../../src/gate-runtime/hash';
import { sha256RedactedJsonPayload } from '../../../../src/core/redaction';
import {
    buildReviewOutputCorrectionApiContinuationAcceptance,
    buildReviewOutputCorrectionArtifact,
    buildReviewOutputCorrectionLiveContinuationAcceptance,
    buildReviewOutputCorrectionTransportSelection,
    classifyReviewOutputCorrectionDiagnostics,
    computeRawReviewOutputSha256,
    computeReviewFindingsSemanticFingerprint,
    executeReviewOutputCorrectionWithAdapter,
    hasCommittedReviewOutputCorrectionTransportEvent,
    normalizeReviewOutputMechanically,
    persistReviewOutputCorrection,
    persistReviewOutputCorrectionTransportSelection,
    readReviewOutputCorrectionArtifact,
    resolveReviewOutputCorrectionTransport,
    verifyCorrectedReviewOutput,
    REVIEW_OUTPUT_CORRECTION_FAIL_CLOSED_ATTESTATION_SOURCE
} from '../../../../src/gates/review/review-output-correction';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const SHA_C = 'c'.repeat(64);
const SHA_D = 'd'.repeat(64);

function findingsOutput(overrides: Record<string, unknown> = {}): string {
    return `${JSON.stringify({
        schema_version: 1,
        task_id: 'wrong-task',
        review_type: 'wrong-lane',
        review_context_sha256: SHA_A,
        tree_state_sha256: SHA_B,
        validation_notes: [],
        coverage_ledger: {
            coverage_contract_sha256: SHA_C,
            entries: []
        },
        review_execution: {
            mode: 'FULL',
            contract_sha256: SHA_A,
            covered_delta_targets: [],
            inspected_prior_finding_ids: []
        },
        findings: {
            critical: [],
            high: [{
                id: 'F-001',
                title: 'Bound finding',
                description: 'The semantic finding must survive correction unchanged.',
                evidence: [{ location: 'src/app.ts:1', observation: 'Observed behavior.' }],
                coverage_obligation_ids: ['FILE-001']
            }],
            medium: [],
            low: []
        },
        residual_risks: [],
        reviewer_notes: [],
        ...overrides
    }, null, 2)}\n`;
}

describe('review output correction contract', () => {
    it('recognizes only a committed transport event bound to the persisted correction package', () => {
        const matchingEvent = {
            event_type: 'REVIEW_OUTPUT_CORRECTION_ONLY_INVOCATION',
            details: {
                review_type: 'code',
                correction_artifact_sha256: SHA_A,
                correction_package_sha256: SHA_B
            },
            integrity: { event_sha256: SHA_C }
        };
        const matches = (timelineEvents: readonly unknown[]) => (
            hasCommittedReviewOutputCorrectionTransportEvent({
                timelineEvents,
                reviewType: 'code',
                correctionArtifactSha256: SHA_A,
                correctionPackageSha256: SHA_B
            })
        );

        assert.equal(matches([matchingEvent]), true);
        assert.equal(matches([{ ...matchingEvent, integrity: undefined }]), false);
        assert.equal(matches([{
            ...matchingEvent,
            details: { ...matchingEvent.details, correction_package_sha256: SHA_D }
        }]), false);
        assert.equal(matches([{
            ...matchingEvent,
            event_type: 'REVIEW_OUTPUT_CORRECTION_REQUIRED'
        }]), false);
    });

    it('normalizes only mechanically derivable bindings without changing finding semantics', () => {
        const content = findingsOutput();
        const diagnostics = classifyReviewOutputCorrectionDiagnostics([
            "schema_version must be 2.",
            "task_id 'wrong-task' does not match expected task 'T-1'.",
            "review_type 'wrong-lane' does not match expected review 'code'.",
            'review_context_sha256 does not match the current review context.',
            'tree_state_sha256 does not match the current review tree state.'
        ]);
        const before = computeReviewFindingsSemanticFingerprint(content);
        const normalized = normalizeReviewOutputMechanically({
            content,
            diagnostics,
            bindings: {
                taskId: 'T-1',
                reviewType: 'code',
                reviewContextSha256: SHA_B,
                reviewTreeStateSha256: SHA_C,
                coverageContractSha256: SHA_A,
                reviewExecution: {
                    mode: 'FULL',
                    contract_sha256: SHA_C,
                    covered_delta_targets: [],
                    inspected_prior_finding_ids: []
                }
            }
        });

        assert.equal(normalized.normalized, true);
        assert.equal(normalized.fingerprint, before);
        assert.equal(computeReviewFindingsSemanticFingerprint(normalized.content), before);
        const parsed = JSON.parse(normalized.content) as Record<string, unknown>;
        assert.equal(parsed.schema_version, 2);
        assert.equal(parsed.task_id, 'T-1');
        assert.equal(parsed.review_type, 'code');
        assert.equal(parsed.review_context_sha256, SHA_B);
        assert.equal(parsed.tree_state_sha256, SHA_C);
    });

    it('does not gate-normalize semantic violations', () => {
        const diagnostics = classifyReviewOutputCorrectionDiagnostics([
            'findings.high[0].description is required.'
        ]);
        const normalized = normalizeReviewOutputMechanically({
            content: findingsOutput(),
            diagnostics,
            bindings: {
                taskId: 'T-1',
                reviewType: 'code',
                reviewContextSha256: SHA_A,
                reviewTreeStateSha256: SHA_B
            }
        });
        assert.equal(diagnostics[0].category, 'semantic');
        assert.equal(normalized.normalized, false);
    });

    it('binds the complete finding objects while allowing validation-only report repair', () => {
        const baseline = JSON.parse(findingsOutput()) as Record<string, unknown>;
        const mutate = (apply: (report: Record<string, unknown>) => void): string => {
            const report = structuredClone(baseline);
            apply(report);
            return computeReviewFindingsSemanticFingerprint(`${JSON.stringify(report)}\n`)!;
        };
        const baselineFingerprint = computeReviewFindingsSemanticFingerprint(findingsOutput());
        assert.equal(mutate((report) => {
            report.validation_notes = [{ id: 'N-001', topic: 'changed', note: 'Changed validation evidence.' }];
        }), baselineFingerprint);
        assert.equal(mutate((report) => {
            const ledger = report.coverage_ledger as Record<string, unknown>;
            ledger.entries = [{ obligation_id: 'FILE-001', evidence: [], finding_ids: ['F-001'] }];
        }), baselineFingerprint);
        assert.notEqual(mutate((report) => {
            const findings = report.findings as Record<string, unknown[]>;
            const finding = findings.high[0] as Record<string, unknown>;
            finding.evidence = [{ location: 'src/app.ts:1', observation: 'Changed evidence.' }];
        }), baselineFingerprint);
        assert.notEqual(mutate((report) => {
            const findings = report.findings as Record<string, unknown[]>;
            const finding = findings.high[0] as Record<string, unknown>;
            finding.coverage_obligation_ids = ['FILE-002'];
        }), baselineFingerprint);
        assert.equal(mutate((report) => {
            report.residual_risks = ['Changed residual risk.'];
        }), baselineFingerprint);
        assert.equal(mutate((report) => {
            report.reviewer_notes = ['Changed reviewer note.'];
        }), baselineFingerprint);
    });

    it('requires a full review when rejected output has no semantic findings fingerprint', () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-correction-no-findings-'));
        try {
            const reviewsRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews');
            fs.mkdirSync(reviewsRoot, { recursive: true });
            const rejectedOutputPath = path.join(reviewsRoot, 'rejected.md');
            const contextPath = path.join(reviewsRoot, 'context.json');
            const validationPath = path.join(reviewsRoot, 'validation.json');
            fs.writeFileSync(rejectedOutputPath, '{ malformed reviewer output\n', 'utf8');
            fs.writeFileSync(contextPath, '{}\n', 'utf8');
            fs.writeFileSync(validationPath, '{}\n', 'utf8');
            const artifact = buildReviewOutputCorrectionArtifact({
                taskId: 'T-1',
                reviewType: 'code',
                rejectedOutputPath,
                rejectedOutputSha256: fileSha256(rejectedOutputPath)!,
                reviewContextPath: contextPath,
                reviewContextSha256: SHA_A,
                reviewTreeStateSha256: SHA_B,
                reviewerIdentity: 'agent:/root/code-review',
                reviewerAttemptId: 'attempt-1',
                reviewerInvocationEventSha256: SHA_D,
                validationArtifactPath: validationPath,
                validationArtifactSha256: fileSha256(validationPath)!,
                violations: ['review output must be a JSON object.'],
                capabilities: { live_reviewer_continuation: true }
            });

            assert.equal(artifact.binding.findings_semantic_fingerprint, null);
            assert.equal(artifact.state, 'FULL_REVIEW_REQUIRED');
            assert.equal(artifact.recovery.selected_transport, 'full_reviewer_relaunch');
            const verification = verifyCorrectedReviewOutput({
                artifact,
                correctedOutput: findingsOutput(),
                reviewContextSha256: SHA_A,
                reviewTreeStateSha256: SHA_B,
                originalReviewerIdentity: 'agent:/root/code-review',
                originalReviewerAttemptId: 'attempt-1',
                correctionArtifactSha256: SHA_A,
                producerAttestation: {
                    producer_identity: 'agent:/root/correction-review',
                    provider_invocation_id: 'correction-invocation-1',
                    provider_invocation_event_sha256: SHA_D,
                    attestation_source: 'codex_collaboration_spawn_agent',
                    launch_input_sha256: SHA_A,
                    fork_context: false
                },
                producerInvocationEvidence: {
                    event_type: 'REVIEWER_INVOCATION_ATTESTED',
                    event_sha256: SHA_D,
                    reviewer_identity: 'agent:/root/correction-review',
                    reviewer_attempt_id: 'correction-attempt-1',
                    provider_invocation_id: 'correction-invocation-1',
                    attestation_source: 'codex_collaboration_spawn_agent',
                    review_context_sha256: SHA_A,
                    launch_input_sha256: SHA_A,
                    delegation_started_event_type: 'REVIEWER_DELEGATION_STARTED',
                    delegation_started_event_sha256: SHA_C,
                    delegation_started_reviewer_identity: 'agent:/root/correction-review',
                    delegation_started_provider_invocation_id: 'correction-invocation-1',
                    correction_launch_artifact_sha256: SHA_B
                }
            });
            assert.equal(verification.requires_full_review, true);
            assert.match(verification.violations.join(' '), /cannot prove findings preservation/iu);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('selects live, API, bounded correction-only, and full-review fallback deterministically', () => {
        const diagnostics = classifyReviewOutputCorrectionDiagnostics(['findings.high[0].description is required.']);
        assert.equal(resolveReviewOutputCorrectionTransport({
            diagnostics,
            correctionAttempt: 1,
            capabilities: {
                gate_normalization: false,
                live_reviewer_continuation: true,
                api_conversation_continuation: true,
                correction_only_invocation: true
            }
        }).transport, 'live_reviewer_continuation');
        assert.equal(resolveReviewOutputCorrectionTransport({
            diagnostics,
            correctionAttempt: 1,
            capabilities: {
                gate_normalization: false,
                live_reviewer_continuation: false,
                api_conversation_continuation: true,
                correction_only_invocation: true
            }
        }).transport, 'api_conversation_continuation');
        assert.equal(resolveReviewOutputCorrectionTransport({
            diagnostics,
            correctionAttempt: 1,
            capabilities: {
                gate_normalization: false,
                live_reviewer_continuation: false,
                api_conversation_continuation: false,
                correction_only_invocation: true
            }
        }).transport, 'correction_only_invocation');
        assert.equal(resolveReviewOutputCorrectionTransport({
            diagnostics,
            correctionAttempt: 3,
            maxCorrectionAttempts: 2,
            capabilities: {
                gate_normalization: false,
                live_reviewer_continuation: true,
                api_conversation_continuation: true,
                correction_only_invocation: true
            }
        }).transport, 'full_reviewer_relaunch');
    });

    it('rejects tampered provider capability evidence and falls back when the original session is closed', () => {
        const artifactPath = path.join(os.tmpdir(), 'T-1-code-output-correction.json');
        const artifact = buildReviewOutputCorrectionArtifact({
            taskId: 'T-1',
            reviewType: 'code',
            rejectedOutputPath: path.join(os.tmpdir(), 'rejected.md'),
            rejectedOutputSha256: SHA_A,
            rejectedOutputContent: findingsOutput(),
            reviewContextPath: path.join(os.tmpdir(), 'context.json'),
            reviewContextSha256: SHA_A,
            reviewTreeStateSha256: SHA_B,
            reviewerIdentity: 'agent:/root/code-review',
            reviewerAttemptId: 'attempt-1',
            reviewerInvocationEventSha256: SHA_D,
            validationArtifactPath: path.join(os.tmpdir(), 'validation.json'),
            validationArtifactSha256: SHA_C,
            violations: ['findings.high[0].description is required.'],
            capabilities: {
                live_reviewer_continuation: true,
                correction_only_invocation: true
            },
            providerId: 'Codex',
            providerInvocationId: '/root/code-review'
        });
        assert.equal(artifact.transport_binding?.session_availability, 'pending');
        assert.equal(artifact.recovery.selected_transport, 'live_reviewer_continuation');

        const forgedLiveSource = verifyCorrectedReviewOutput({
            artifact,
            correctedOutput: findingsOutput(),
            reviewContextSha256: SHA_A,
            reviewTreeStateSha256: SHA_B,
            originalReviewerIdentity: 'agent:/root/code-review',
            originalReviewerAttemptId: 'attempt-1',
            correctionArtifactSha256: SHA_C,
            producerAttestation: {
                producer_identity: 'agent:/root/code-review',
                provider_invocation_id: '/root/code-review',
                provider_invocation_event_sha256: SHA_D,
                attestation_source: 'codex_collaboration_followup_task',
                launch_input_sha256: SHA_C,
                fork_context: null
            },
            producerInvocationEvidence: {
                event_type: 'REVIEWER_INVOCATION_ATTESTED',
                event_sha256: SHA_D,
                reviewer_identity: 'agent:/root/code-review',
                reviewer_attempt_id: 'attempt-1',
                provider_invocation_id: '/root/code-review',
                attestation_source: 'codex_collaboration_spawn_agent',
                review_context_sha256: SHA_A,
                launch_input_sha256: SHA_A,
                delegation_started_event_type: 'REVIEWER_DELEGATION_STARTED',
                delegation_started_event_sha256: SHA_C,
                delegation_started_reviewer_identity: 'agent:/root/code-review',
                delegation_started_provider_invocation_id: '/root/code-review',
                correction_launch_artifact_sha256: ''
            }
        });
        assert.match(
            forgedLiveSource.violations.join(' '),
            /attestation source does not match provider-owned invocation evidence/iu
        );
        assert.match(
            forgedLiveSource.violations.join(' '),
            /provider-owned response receipt bound to its bytes/iu
        );

        const selected = buildReviewOutputCorrectionTransportSelection({
            artifactPath,
            artifact,
            sessionAvailability: 'closed',
            reviewerIdentity: 'agent:/root/code-review',
            providerInvocationId: '/root/code-review',
            attestationSource: REVIEW_OUTPUT_CORRECTION_FAIL_CLOSED_ATTESTATION_SOURCE,
            now: '2026-08-20T00:01:00.000Z'
        });
        assert.equal(selected.transport_binding?.session_availability, 'closed');
        assert.equal(selected.recovery.selected_transport, 'correction_only_invocation');
        assert.equal(
            selected.transport_binding?.availability_attestation?.provider_invocation_id,
            '/root/code-review'
        );
        assert.equal(
            selected.transport_binding?.availability_attestation?.evidence_type,
            'fail_closed_no_provider_session_receipt'
        );
        const liveSelected = buildReviewOutputCorrectionLiveContinuationAcceptance({
            artifactPath,
            artifact,
            reviewerIdentity: 'agent:/root/code-review',
            providerInvocationId: '/root/code-review',
            providerInvocationEventSha256: SHA_D,
            providerResponseEventSha256: SHA_B,
            providerResponseSha256: SHA_C,
            attestationSource: 'codex_collaboration_spawn_agent',
            reason: 'Authenticated corrected response accepted.'
        });
        assert.equal(liveSelected.transport_binding?.session_availability, 'available');
        assert.equal(liveSelected.recovery.selected_transport, 'live_reviewer_continuation');
        assert.equal(liveSelected.state, 'CORRECTION_ACCEPTED');
        assert.equal(
            liveSelected.transport_binding?.availability_attestation?.evidence_type,
            'provider_native_session_receipt'
        );
        assert.equal(
            liveSelected.transport_binding?.availability_attestation?.provider_invocation_event_sha256,
            SHA_D
        );
        assert.equal(
            liveSelected.transport_binding?.availability_attestation?.provider_response_sha256,
            SHA_C
        );
        assert.equal(
            liveSelected.transport_binding?.availability_attestation?.provider_response_event_sha256,
            SHA_B
        );
        assert.throws(() => buildReviewOutputCorrectionLiveContinuationAcceptance({
            artifactPath,
            artifact,
            reviewerIdentity: 'agent:/root/code-review',
            providerInvocationId: '/root/code-review',
            providerInvocationEventSha256: SHA_D,
            providerResponseEventSha256: SHA_B,
            providerResponseSha256: SHA_C,
            attestationSource: REVIEW_OUTPUT_CORRECTION_FAIL_CLOSED_ATTESTATION_SOURCE,
            reason: 'Untrusted response.'
        }), /provider\/controller-owned live-session attestation source/iu);
        assert.throws(() => buildReviewOutputCorrectionTransportSelection({
            artifactPath,
            artifact: {
                ...artifact,
                transport_binding: artifact.transport_binding
                    ? {
                        ...artifact.transport_binding,
                        provider_capabilities_sha256: SHA_A
                    }
                    : undefined
            },
            sessionAvailability: 'closed',
            reviewerIdentity: 'agent:/root/code-review',
            providerInvocationId: '/root/code-review',
            attestationSource: REVIEW_OUTPUT_CORRECTION_FAIL_CLOSED_ATTESTATION_SOURCE
        }), /capability evidence is invalid/iu);
    });

    it('upgrades an authenticated v1 artifact before emitting a correction-only handoff', () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-correction-v1-upgrade-'));
        try {
            const reviewsRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews');
            fs.mkdirSync(reviewsRoot, { recursive: true });
            const reviewArtifactPath = path.join(reviewsRoot, 'T-1-code.md');
            const rejectedOutputPath = path.join(reviewsRoot, 'placeholder.md');
            const contextPath = path.join(reviewsRoot, 'T-1-code-review-context.json');
            const validationPath = path.join(reviewsRoot, 'T-1-code-findings-validation.json');
            const rawOutput = findingsOutput();
            fs.writeFileSync(rejectedOutputPath, rawOutput, 'utf8');
            fs.writeFileSync(contextPath, '{}\n', 'utf8');
            fs.writeFileSync(validationPath, '{}\n', 'utf8');
            const initial = buildReviewOutputCorrectionArtifact({
                taskId: 'T-1',
                reviewType: 'code',
                rejectedOutputPath,
                rejectedOutputSha256: fileSha256(rejectedOutputPath)!,
                rejectedOutputContent: rawOutput,
                reviewContextPath: contextPath,
                reviewContextSha256: SHA_A,
                reviewTreeStateSha256: SHA_B,
                reviewerIdentity: 'agent:/root/code-review',
                reviewerAttemptId: 'attempt-1',
                reviewerInvocationEventSha256: SHA_D,
                validationArtifactPath: validationPath,
                validationArtifactSha256: fileSha256(validationPath)!,
                violations: ['findings.high[0].description is required.'],
                capabilities: {
                    live_reviewer_continuation: true,
                    correction_only_invocation: true
                },
                providerId: 'Codex',
                providerInvocationId: '/root/code-review'
            });
            const persisted = persistReviewOutputCorrection({
                repoRoot,
                reviewArtifactPath,
                rawOutput,
                artifact: initial
            });
            const v1Artifact = structuredClone(persisted.artifact);
            v1Artifact.schema_version = 1;
            delete v1Artifact.binding.correction_input_path;
            delete v1Artifact.binding.correction_input_sha256;
            delete v1Artifact.artifact_sha256;
            v1Artifact.artifact_sha256 = sha256RedactedJsonPayload(v1Artifact);
            fs.writeFileSync(persisted.artifactPath, `${JSON.stringify(v1Artifact, null, 2)}\n`, 'utf8');

            const legacy = readReviewOutputCorrectionArtifact(persisted.artifactPath);
            assert.deepEqual(legacy.violations, []);
            assert.equal(legacy.artifact?.schema_version, 1);

            const selected = persistReviewOutputCorrectionTransportSelection({
                repoRoot,
                artifactPath: persisted.artifactPath,
                artifact: legacy.artifact!,
                sessionAvailability: 'closed',
                reviewerIdentity: 'agent:/root/code-review',
                providerInvocationId: '/root/code-review',
                attestationSource: REVIEW_OUTPUT_CORRECTION_FAIL_CLOSED_ATTESTATION_SOURCE,
                now: '2026-08-20T00:01:00.000Z'
            });
            assert.equal(selected.artifact.schema_version, 2);
            assert.equal(
                selected.artifact.binding.correction_input_path,
                selected.artifact.binding.original_output_path
            );
            assert.equal(
                selected.artifact.binding.correction_input_sha256,
                selected.artifact.binding.original_output_sha256
            );
            assert.match(
                selected.artifact.recovery.handoff?.instruction || '',
                /binding\.correction_input_path/u
            );
            assert.match(
                selected.artifact.recovery.handoff?.provider_response_output_path || '',
                /\.attempt-1\.provider-response\.json$/u
            );
            assert.deepEqual(
                readReviewOutputCorrectionArtifact(persisted.artifactPath).violations,
                []
            );
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('requires a provider-bound response receipt for API-only stateless correction packages', () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-correction-api-only-'));
        try {
            const reviewsRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews');
            fs.mkdirSync(reviewsRoot, { recursive: true });
            const reviewArtifactPath = path.join(reviewsRoot, 'T-1-code.md');
            const rejectedOutputPath = path.join(reviewsRoot, 'placeholder.md');
            const contextPath = path.join(reviewsRoot, 'T-1-code-review-context.json');
            const validationPath = path.join(reviewsRoot, 'T-1-code-findings-validation.json');
            const rawOutput = findingsOutput();
            fs.writeFileSync(rejectedOutputPath, rawOutput, 'utf8');
            fs.writeFileSync(contextPath, '{}\n', 'utf8');
            fs.writeFileSync(validationPath, '{}\n', 'utf8');
            const artifact = buildReviewOutputCorrectionArtifact({
                taskId: 'T-1',
                reviewType: 'code',
                rejectedOutputPath,
                rejectedOutputSha256: fileSha256(rejectedOutputPath)!,
                reviewContextPath: contextPath,
                reviewContextSha256: SHA_A,
                reviewTreeStateSha256: SHA_B,
                reviewerIdentity: 'agent:/root/code-review',
                reviewerAttemptId: 'attempt-1',
                reviewerInvocationEventSha256: SHA_D,
                validationArtifactPath: validationPath,
                validationArtifactSha256: fileSha256(validationPath)!,
                violations: ['findings.high[0].description is required.'],
                capabilities: {
                    live_reviewer_continuation: false,
                    api_conversation_continuation: true,
                    correction_only_invocation: true
                },
                providerId: 'Codex',
                providerInvocationId: '/root/code-review'
            });
            const persisted = persistReviewOutputCorrection({
                repoRoot,
                reviewArtifactPath,
                rawOutput,
                artifact
            });
            const loaded = readReviewOutputCorrectionArtifact(persisted.artifactPath);
            assert.deepEqual(loaded.violations, []);
            assert.equal(loaded.artifact?.recovery.selected_transport, 'api_conversation_continuation');
            assert.equal(loaded.artifact?.transport_binding?.session_availability, 'stateless');
            assert.equal(loaded.artifact?.transport_binding?.availability_attestation, null);

            const correctionArtifactSha256 = fileSha256(persisted.artifactPath)!;
            const verifyApiCorrection = (
                producerInvocationEvidence:
                    Parameters<typeof verifyCorrectedReviewOutput>[0]['producerInvocationEvidence']
            ) => verifyCorrectedReviewOutput({
                artifact: loaded.artifact!,
                correctedOutput: findingsOutput(),
                reviewContextSha256: SHA_A,
                reviewTreeStateSha256: SHA_B,
                originalReviewerIdentity: 'agent:/root/code-review',
                originalReviewerAttemptId: 'attempt-1',
                correctionArtifactSha256,
                producerAttestation: {
                    producer_identity: 'agent:/root/code-review',
                    provider_invocation_id: '/root/code-review',
                    provider_invocation_event_sha256: SHA_D,
                    attestation_source: 'codex_collaboration_spawn_agent',
                    launch_input_sha256: correctionArtifactSha256,
                    fork_context: null
                },
                producerInvocationEvidence
            });
            const invocationEvidence = {
                event_type: 'REVIEWER_INVOCATION_ATTESTED',
                event_sha256: SHA_D,
                reviewer_identity: 'agent:/root/code-review',
                reviewer_attempt_id: 'attempt-1',
                provider_invocation_id: '/root/code-review',
                attestation_source: 'codex_collaboration_spawn_agent',
                review_context_sha256: SHA_A,
                launch_input_sha256: '',
                delegation_started_event_type: 'REVIEWER_DELEGATION_STARTED',
                delegation_started_event_sha256: SHA_C,
                delegation_started_reviewer_identity: 'agent:/root/code-review',
                delegation_started_provider_invocation_id: '/root/code-review',
                correction_launch_artifact_sha256: ''
            };
            const missingResponseReceipt = verifyApiCorrection(invocationEvidence);
            assert.equal(missingResponseReceipt.valid, false);
            assert.match(
                missingResponseReceipt.violations.join(' '),
                /provider-owned response receipt bound to its bytes/iu
            );

            const correctedOutputSha256 = computeRawReviewOutputSha256(findingsOutput());
            const verification = verifyApiCorrection({
                ...invocationEvidence,
                provider_response_event_type: 'REVIEW_OUTPUT_CORRECTION_API_CONTINUATION',
                provider_response_event_sha256: SHA_B,
                provider_response_sha256: correctedOutputSha256
            });
            assert.deepEqual(verification.violations, []);
            assert.equal(verification.valid, true);

            const accepted = buildReviewOutputCorrectionApiContinuationAcceptance({
                artifactPath: persisted.artifactPath,
                artifact: loaded.artifact!,
                reviewerIdentity: 'agent:/root/code-review',
                providerInvocationId: '/root/code-review',
                providerInvocationEventSha256: SHA_D,
                providerResponseEventSha256: SHA_B,
                providerResponseSha256: correctedOutputSha256,
                attestationSource: 'codex_collaboration_spawn_agent',
                reason: 'Authenticated API correction response accepted.'
            });
            assert.equal(accepted.state, 'CORRECTION_ACCEPTED');
            assert.equal(accepted.recovery.selected_transport, 'api_conversation_continuation');
            assert.equal(accepted.transport_binding?.session_availability, 'stateless');
            assert.equal(
                accepted.transport_binding?.availability_attestation?.provider_response_event_sha256,
                SHA_B
            );
            assert.equal(
                accepted.transport_binding?.availability_attestation?.provider_response_sha256,
                correctedOutputSha256
            );
            fs.writeFileSync(persisted.artifactPath, `${JSON.stringify(accepted, null, 2)}\n`, 'utf8');
            assert.deepEqual(readReviewOutputCorrectionArtifact(persisted.artifactPath).violations, []);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('rejects exhausted recovery and serializes concurrent live, closed, stateless, and API transports offline', async () => {
        const makeArtifact = (correctionAttempt = 1) => buildReviewOutputCorrectionArtifact({
            taskId: 'T-1',
            reviewType: 'code',
            rejectedOutputPath: 'rejected.md',
            rejectedOutputSha256: SHA_A,
            rejectedOutputContent: findingsOutput(),
            reviewContextPath: 'context.json',
            reviewContextSha256: SHA_A,
            reviewTreeStateSha256: SHA_B,
            reviewerIdentity: 'agent:/root/code-review',
            reviewerAttemptId: 'attempt-1',
            reviewerInvocationEventSha256: SHA_D,
            validationArtifactPath: 'validation.json',
            validationArtifactSha256: SHA_C,
            violations: ['findings.high[0].description is required.'],
            correctionAttempt,
            maxCorrectionAttempts: 2,
            capabilities: {
                live_reviewer_continuation: true,
                api_conversation_continuation: true,
                correction_only_invocation: true
            }
        });
        const events: string[] = [];
        const live = await executeReviewOutputCorrectionWithAdapter({
            artifact: makeArtifact(),
            adapter: {
                id: 'offline-live',
                capabilities: {
                    gate_normalization: false,
                    live_reviewer_continuation: true,
                    api_conversation_continuation: false,
                    correction_only_invocation: true
                },
                probeLiveReviewerAvailability: async () => 'available',
                continueReview: async () => 'live-output',
                recordTelemetry: (event) => { events.push(event.event); }
            }
        });
        assert.equal(live, 'live-output');

        const api = await executeReviewOutputCorrectionWithAdapter({
            artifact: makeArtifact(),
            adapter: {
                id: 'offline-api-after-close',
                capabilities: {
                    gate_normalization: false,
                    live_reviewer_continuation: true,
                    api_conversation_continuation: true,
                    correction_only_invocation: true
                },
                probeLiveReviewerAvailability: async () => 'closed',
                continueApiConversation: async () => 'api-output',
                recordTelemetry: (event) => { events.push(event.event); }
            }
        });
        assert.equal(api, 'api-output');

        let correctionOnlyCalls = 0;
        let releaseCorrection!: () => void;
        const correctionWait = new Promise<void>((resolve) => { releaseCorrection = resolve; });
        const concurrentOptions = {
            artifact: makeArtifact(),
            adapter: {
                id: 'offline-stateless-concurrent',
                capabilities: {
                    gate_normalization: false,
                    live_reviewer_continuation: true,
                    api_conversation_continuation: false,
                    correction_only_invocation: true
                },
                probeLiveReviewerAvailability: async () => 'stateless' as const,
                invokeCorrectionOnly: async () => {
                    correctionOnlyCalls += 1;
                    await correctionWait;
                    return 'correction-only-output';
                },
                recordTelemetry: (event: { event: string }) => { events.push(event.event); }
            }
        };
        const first = executeReviewOutputCorrectionWithAdapter(concurrentOptions);
        const second = executeReviewOutputCorrectionWithAdapter(concurrentOptions);
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(correctionOnlyCalls, 1);
        releaseCorrection();
        assert.deepEqual(await Promise.all([first, second]), [
            'correction-only-output',
            'correction-only-output'
        ]);
        assert.deepEqual(events, [
            'live_continuation',
            'api_continuation',
            'correction_only_invocation'
        ]);

        const boundedEvents: string[] = [];
        await assert.rejects(() => executeReviewOutputCorrectionWithAdapter({
            artifact: makeArtifact(3),
            adapter: {
                id: 'offline-bounded',
                capabilities: {
                    gate_normalization: false,
                    live_reviewer_continuation: true,
                    api_conversation_continuation: true,
                    correction_only_invocation: true
                },
                probeLiveReviewerAvailability: async () => 'available',
                continueReview: async () => 'must-not-run',
                recordTelemetry: (event) => { boundedEvents.push(event.event); }
            }
        }), /full_reviewer_relaunch/iu);
        assert.deepEqual(boundedEvents, ['full_reviewer_relaunch']);
    });

    it('persists bound raw output and rejects tamper, provenance drift, and finding changes', () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-correction-'));
        try {
            const reviewsRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews');
            fs.mkdirSync(reviewsRoot, { recursive: true });
            const reviewArtifactPath = path.join(reviewsRoot, 'T-1-code.md');
            const contextPath = path.join(reviewsRoot, 'T-1-code-review-context.json');
            const validationPath = path.join(reviewsRoot, 'T-1-code-findings-validation.json');
            fs.writeFileSync(contextPath, '{}\n', 'utf8');
            fs.writeFileSync(validationPath, '{}\n', 'utf8');
            const rawOutput = findingsOutput();
            const placeholderOutputPath = path.join(reviewsRoot, 'placeholder.md');
            fs.writeFileSync(placeholderOutputPath, rawOutput, 'utf8');
            const artifact = buildReviewOutputCorrectionArtifact({
                taskId: 'T-1',
                reviewType: 'code',
                rejectedOutputPath: placeholderOutputPath,
                rejectedOutputSha256: fileSha256(placeholderOutputPath)!,
                reviewContextPath: contextPath,
                reviewContextSha256: SHA_A,
                reviewTreeStateSha256: SHA_B,
                reviewerIdentity: 'agent:/root/code-review',
                reviewerAttemptId: 'attempt-1',
                reviewerInvocationEventSha256: SHA_D,
                validationArtifactPath: validationPath,
                validationArtifactSha256: fileSha256(validationPath)!,
                violations: ['findings.high[0].description is required.'],
                capabilities: { correction_only_invocation: true },
                now: '2026-08-20T00:00:00.000Z'
            });
            const persisted = persistReviewOutputCorrection({
                repoRoot,
                reviewArtifactPath,
                rawOutput,
                artifact
            });
            const loaded = readReviewOutputCorrectionArtifact(persisted.artifactPath);
            assert.deepEqual(loaded.violations, []);
            assert.ok(loaded.artifact);
            assert.equal(loaded.artifact!.state, 'REVIEW_OUTPUT_CORRECTION_REQUIRED');
            assert.equal(loaded.artifact!.recovery.handoff?.provider_action, 'launch_correction_only_reviewer');
            assert.equal(
                loaded.artifact!.recovery.handoff?.launch_input_artifact_path,
                persisted.artifactPath.replace(/\\/gu, '/')
            );
            assert.equal(loaded.artifact!.recovery.handoff?.fork_context, false);
            assert.equal(loaded.artifact!.schema_version, 2);
            assert.equal(
                loaded.artifact!.binding.correction_input_path,
                persisted.rejectedOutputPath.replace(/\\/gu, '/')
            );
            assert.equal(
                loaded.artifact!.binding.correction_input_sha256,
                fileSha256(persisted.rejectedOutputPath)
            );
            assert.match(
                loaded.artifact!.recovery.handoff?.provider_response_output_path || '',
                /\.attempt-1\.provider-response\.json$/u
            );
            const correctionInstruction = loaded.artifact!.recovery.handoff?.instruction || '';
            assert.match(correctionInstruction, /binding\.correction_input_path/u);
            assert.match(correctionInstruction, /recovery\.handoff\.provider_response_output_path/u);
            assert.match(correctionInstruction, /without a wrapper or prose/u);
            assert.match(correctionInstruction, /must not run Garda/u);
            assert.match(correctionInstruction, /must not record its own result/u);

            const correctedOutput = findingsOutput({
                    schema_version: 2,
                    task_id: 'T-1',
                    review_type: 'code',
                    validation_notes: [{
                        id: 'N-001',
                        topic: 'corrected-validation-evidence',
                        note: 'Required validation evidence was supplied without changing findings.'
                    }],
                    reviewer_notes: ['Validation-only correction completed.']
                });
            const valid = verifyCorrectedReviewOutput({
                artifact: loaded.artifact!,
                correctedOutput,
                reviewContextSha256: SHA_A,
                reviewTreeStateSha256: SHA_B,
                originalReviewerIdentity: 'agent:/root/code-review',
                originalReviewerAttemptId: 'attempt-1',
                correctionArtifactSha256: fileSha256(persisted.artifactPath)!,
                producerAttestation: {
                    producer_identity: 'agent:/root/correction-review',
                    provider_invocation_id: 'correction-invocation-1',
                    provider_invocation_event_sha256: SHA_D,
                    attestation_source: 'codex_collaboration_spawn_agent',
                    launch_input_sha256: fileSha256(persisted.artifactPath)!,
                    fork_context: false
                },
                producerInvocationEvidence: {
                    event_type: 'REVIEWER_INVOCATION_ATTESTED',
                    event_sha256: SHA_D,
                    reviewer_identity: 'agent:/root/correction-review',
                    reviewer_attempt_id: 'correction-attempt-1',
                    provider_invocation_id: 'correction-invocation-1',
                    attestation_source: 'codex_collaboration_spawn_agent',
                    review_context_sha256: SHA_A,
                    launch_input_sha256: fileSha256(persisted.artifactPath)!,
                    delegation_started_event_type: 'REVIEWER_DELEGATION_STARTED',
                    delegation_started_event_sha256: SHA_C,
                    delegation_started_reviewer_identity: 'agent:/root/correction-review',
                    delegation_started_provider_invocation_id: 'correction-invocation-1',
                    correction_launch_artifact_sha256: SHA_B,
                    provider_response_event_type: 'REVIEW_OUTPUT_CORRECTION_INVOCATION_ATTESTED',
                    provider_response_event_sha256: SHA_C,
                    provider_response_sha256: computeRawReviewOutputSha256(correctedOutput)
                }
            });
            assert.equal(valid.valid, true);
            assert.notEqual(
                valid.valid && 'agent:/root/correction-review',
                'agent:/root/code-review',
                'a correction-only producer is distinct from the original review owner'
            );

            const unattested = verifyCorrectedReviewOutput({
                artifact: loaded.artifact!,
                correctedOutput: findingsOutput(),
                reviewContextSha256: SHA_A,
                reviewTreeStateSha256: SHA_B,
                originalReviewerIdentity: 'agent:/root/code-review',
                originalReviewerAttemptId: 'attempt-1',
                correctionArtifactSha256: fileSha256(persisted.artifactPath)!,
                producerAttestation: {
                    producer_identity: 'agent:pending:T-1-code',
                    provider_invocation_id: '<provider invocation>',
                    provider_invocation_event_sha256: '',
                    attestation_source: 'manual',
                    launch_input_sha256: SHA_C,
                    fork_context: null
                },
                producerInvocationEvidence: null
            });
            assert.equal(unattested.requires_full_review, true);
            assert.match(unattested.violations.join(' '), /producer identity/iu);
            assert.match(unattested.violations.join(' '), /provider invocation id/iu);
            assert.match(unattested.violations.join(' '), /launch input/iu);

            const changedFinding = JSON.parse(findingsOutput()) as Record<string, unknown>;
            const changedFindings = changedFinding.findings as Record<string, unknown[]>;
            (changedFindings.high[0] as Record<string, unknown>).description = 'Changed semantic content.';
            const invalid = verifyCorrectedReviewOutput({
                artifact: loaded.artifact!,
                correctedOutput: `${JSON.stringify(changedFinding)}\n`,
                reviewContextSha256: SHA_C,
                reviewTreeStateSha256: SHA_B,
                originalReviewerIdentity: 'agent:/root/other-review',
                originalReviewerAttemptId: 'attempt-2',
                correctionArtifactSha256: fileSha256(persisted.artifactPath)!,
                producerAttestation: {
                    producer_identity: 'agent:/root/correction-review',
                    provider_invocation_id: 'correction-invocation-2',
                    provider_invocation_event_sha256: SHA_D,
                    attestation_source: 'codex_collaboration_spawn_agent',
                    launch_input_sha256: fileSha256(persisted.artifactPath)!,
                    fork_context: false
                },
                producerInvocationEvidence: {
                    event_type: 'REVIEWER_INVOCATION_ATTESTED',
                    event_sha256: SHA_D,
                    reviewer_identity: 'agent:/root/correction-review',
                    reviewer_attempt_id: 'correction-attempt-2',
                    provider_invocation_id: 'correction-invocation-2',
                    attestation_source: 'codex_collaboration_spawn_agent',
                    review_context_sha256: SHA_A,
                    launch_input_sha256: fileSha256(persisted.artifactPath)!,
                    delegation_started_event_type: 'REVIEWER_DELEGATION_STARTED',
                    delegation_started_event_sha256: SHA_C,
                    delegation_started_reviewer_identity: 'agent:/root/correction-review',
                    delegation_started_provider_invocation_id: 'correction-invocation-2',
                    correction_launch_artifact_sha256: SHA_B
                }
            });
            assert.equal(invalid.requires_full_review, true);
            assert.match(invalid.violations.join(' '), /context changed/iu);
            assert.match(invalid.violations.join(' '), /semantic findings fingerprint/iu);

            fs.appendFileSync(persisted.rejectedOutputPath, 'tampered', 'utf8');
            assert.match(
                readReviewOutputCorrectionArtifact(persisted.artifactPath).violations.join(' '),
                /original output binding.*tampered/iu
            );
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('preserves the first rejected-output binding across repeated correction attempts', () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-correction-lineage-'));
        try {
            const reviewsRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews');
            fs.mkdirSync(reviewsRoot, { recursive: true });
            const reviewArtifactPath = path.join(reviewsRoot, 'T-1-code.md');
            const contextPath = path.join(reviewsRoot, 'T-1-code-review-context.json');
            const validationPath = path.join(reviewsRoot, 'T-1-code-findings-validation.json');
            fs.writeFileSync(contextPath, '{}\n', 'utf8');
            fs.writeFileSync(validationPath, '{}\n', 'utf8');
            const firstRejectedOutput = findingsOutput();
            const firstArtifact = buildReviewOutputCorrectionArtifact({
                taskId: 'T-1',
                reviewType: 'code',
                rejectedOutputPath: reviewArtifactPath,
                rejectedOutputSha256: SHA_A,
                rejectedOutputContent: firstRejectedOutput,
                reviewContextPath: contextPath,
                reviewContextSha256: SHA_A,
                reviewTreeStateSha256: SHA_B,
                reviewerIdentity: 'agent:/root/code-review',
                reviewerAttemptId: 'attempt-1',
                reviewerInvocationEventSha256: SHA_D,
                validationArtifactPath: validationPath,
                validationArtifactSha256: fileSha256(validationPath)!,
                violations: ['findings.high[0].description is required.'],
                correctionAttempt: 1,
                capabilities: { correction_only_invocation: true }
            });
            const firstPersisted = persistReviewOutputCorrection({
                repoRoot,
                reviewArtifactPath,
                rawOutput: firstRejectedOutput,
                artifact: firstArtifact
            });
            const firstBinding = firstPersisted.artifact.binding;
            const firstResponsePath = firstPersisted.artifact.recovery.handoff?.provider_response_output_path;
            const secondRejectedOutput = findingsOutput({
                reviewer_notes: ['The correction still contains a validation-only defect.']
            });
            const secondArtifact = buildReviewOutputCorrectionArtifact({
                taskId: 'T-1',
                reviewType: 'code',
                rejectedOutputPath: reviewArtifactPath,
                rejectedOutputSha256: SHA_C,
                rejectedOutputContent: secondRejectedOutput,
                reviewContextPath: contextPath,
                reviewContextSha256: SHA_A,
                reviewTreeStateSha256: SHA_B,
                reviewerIdentity: 'agent:/root/code-review',
                reviewerAttemptId: 'attempt-1',
                reviewerInvocationEventSha256: SHA_D,
                validationArtifactPath: validationPath,
                validationArtifactSha256: fileSha256(validationPath)!,
                violations: ['validation_notes[0].note is required.'],
                correctionAttempt: 2,
                capabilities: { correction_only_invocation: true }
            });
            const secondPersisted = persistReviewOutputCorrection({
                repoRoot,
                reviewArtifactPath,
                rawOutput: secondRejectedOutput,
                artifact: secondArtifact
            });

            assert.notEqual(secondPersisted.rejectedOutputPath, firstPersisted.rejectedOutputPath);
            assert.equal(secondPersisted.artifact.binding.original_output_path, firstBinding.original_output_path);
            assert.equal(secondPersisted.artifact.binding.original_output_sha256, firstBinding.original_output_sha256);
            assert.equal(
                secondPersisted.artifact.binding.correction_input_path,
                secondPersisted.rejectedOutputPath.replace(/\\/gu, '/')
            );
            assert.equal(
                secondPersisted.artifact.binding.correction_input_sha256,
                fileSha256(secondPersisted.rejectedOutputPath)
            );
            assert.notEqual(
                secondPersisted.artifact.recovery.handoff?.provider_response_output_path,
                firstResponsePath
            );
            assert.match(
                secondPersisted.artifact.recovery.handoff?.provider_response_output_path || '',
                /\.attempt-2\.provider-response\.json$/u
            );
            assert.match(
                secondPersisted.artifact.recovery.handoff?.instruction || '',
                /binding\.correction_input_path/u
            );
            assert.equal(
                secondPersisted.artifact.binding.findings_semantic_fingerprint,
                firstBinding.findings_semantic_fingerprint
            );
            assert.equal(fs.readFileSync(firstBinding.original_output_path, 'utf8'), firstRejectedOutput);
            assert.equal(fs.readFileSync(secondPersisted.rejectedOutputPath, 'utf8'), secondRejectedOutput);
            assert.deepEqual(readReviewOutputCorrectionArtifact(secondPersisted.artifactPath).violations, []);

            fs.appendFileSync(secondPersisted.rejectedOutputPath, 'tampered', 'utf8');
            assert.match(
                readReviewOutputCorrectionArtifact(secondPersisted.artifactPath).violations.join(' '),
                /latest input binding.*tampered/iu
            );
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('rejects correction artifact writes through an out-of-repo symlink or junction', () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-correction-link-root-'));
        const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-correction-link-outside-'));
        try {
            const runtimeRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime');
            const linkedReviewsRoot = path.join(runtimeRoot, 'reviews');
            fs.mkdirSync(runtimeRoot, { recursive: true });
            fs.symlinkSync(outsideRoot, linkedReviewsRoot, process.platform === 'win32' ? 'junction' : 'dir');
            const sourceRoot = path.join(repoRoot, 'source');
            fs.mkdirSync(sourceRoot, { recursive: true });
            const rejectedOutputPath = path.join(sourceRoot, 'rejected.md');
            const contextPath = path.join(sourceRoot, 'context.json');
            const validationPath = path.join(sourceRoot, 'validation.json');
            fs.writeFileSync(rejectedOutputPath, findingsOutput(), 'utf8');
            fs.writeFileSync(contextPath, '{}\n', 'utf8');
            fs.writeFileSync(validationPath, '{}\n', 'utf8');
            const artifact = buildReviewOutputCorrectionArtifact({
                taskId: 'T-1',
                reviewType: 'code',
                rejectedOutputPath,
                rejectedOutputSha256: fileSha256(rejectedOutputPath)!,
                reviewContextPath: contextPath,
                reviewContextSha256: SHA_A,
                reviewTreeStateSha256: SHA_B,
                reviewerIdentity: 'agent:/root/code-review',
                reviewerAttemptId: 'attempt-1',
                reviewerInvocationEventSha256: SHA_D,
                validationArtifactPath: validationPath,
                validationArtifactSha256: fileSha256(validationPath)!,
                violations: ['findings.high[0].description is required.'],
                capabilities: { correction_only_invocation: true }
            });

            assert.throws(() => persistReviewOutputCorrection({
                repoRoot,
                reviewArtifactPath: path.join(linkedReviewsRoot, 'T-1-code.md'),
                rawOutput: findingsOutput(),
                artifact
            }), /symlink or junction outside repo root/iu);
            assert.deepEqual(fs.readdirSync(outsideRoot), []);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
            fs.rmSync(outsideRoot, { recursive: true, force: true });
        }
    });

    it('executes an offline fake API continuation adapter without network access', async () => {
        const artifact = {
            schema_version: 1 as const,
            artifact_type: 'review_output_correction' as const,
            task_id: 'T-1',
            review_type: 'api',
            state: 'REVIEW_OUTPUT_CORRECTION_REQUIRED' as const,
            created_at_utc: '2026-08-20T00:00:00.000Z',
            updated_at_utc: '2026-08-20T00:00:00.000Z',
            binding: {
                original_output_path: 'rejected.md',
                original_output_sha256: SHA_A,
                review_context_path: 'context.json',
                review_context_sha256: SHA_A,
                review_tree_state_sha256: SHA_B,
                reviewer_identity: 'api:conversation-1',
                reviewer_attempt_id: 'attempt-1',
                reviewer_invocation_event_sha256: SHA_D,
                findings_semantic_fingerprint: SHA_C,
                validation_artifact_path: 'validation.json',
                validation_artifact_sha256: SHA_B
            },
            diagnostics: classifyReviewOutputCorrectionDiagnostics(['findings.high[0].description is required.']),
            recovery: {
                correction_attempt: 1,
                max_correction_attempts: 2,
                selected_transport: 'api_conversation_continuation' as const,
                available_transports: ['api_conversation_continuation' as const, 'full_reviewer_relaunch' as const],
                reason: 'API conversation is available.'
            }
        };
        const result = await executeReviewOutputCorrectionWithAdapter({
            artifact,
            adapter: {
                id: 'offline-fake',
                capabilities: {
                    gate_normalization: false,
                    live_reviewer_continuation: false,
                    api_conversation_continuation: true,
                    correction_only_invocation: false
                },
                continueApiConversation: async () => 'corrected-output'
            }
        });
        assert.equal(result, 'corrected-output');
    });
});
