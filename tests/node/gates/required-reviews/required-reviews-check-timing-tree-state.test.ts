import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

import {
    validateReviewArtifactGateEligibility,
} from '../../../../src/gates/required-reviews/required-reviews-check';

type ReusedTimingMode = 'valid' | 'missing' | 'too-short' | 'duplicate' | 'forged-later' | 'stale-output';

function sha256(content: string): string {
    return crypto.createHash('sha256').update(content).digest('hex');
}

function writeText(filePath: string, content: string): string {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
    return sha256(content);
}

function writeJson(filePath: string, payload: unknown): string {
    return writeText(filePath, `${JSON.stringify(payload, null, 2)}\n`);
}

function toPosixPath(filePath: string): string {
    return filePath.replace(/\\/g, '/');
}

function buildRequiredReviewsReusedTimingFixture(mode: ReusedTimingMode) {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-required-reused-timing-'));
    const taskId = 'T-889-REG';
    const reviewType = 'code';
    const reviewsRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews');
    fs.mkdirSync(reviewsRoot, { recursive: true });
    const sourcePath = path.join(repoRoot, 'src', 'reused.ts');
    writeText(sourcePath, 'export const reused = 1;\n');
    execFileSync('git', ['init'], { cwd: repoRoot, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'tests@example.invalid'], { cwd: repoRoot, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Garda Tests'], { cwd: repoRoot, stdio: 'ignore' });
    execFileSync('git', ['add', '.'], { cwd: repoRoot, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'fixture baseline'], { cwd: repoRoot, stdio: 'ignore' });
    writeText(sourcePath, 'export const reused = 2;\n');

    const preflightPath = path.join(reviewsRoot, `${taskId}-preflight.json`);
    const preflightPayload = {
        task_id: taskId,
        detection_source: 'explicit_changed_files',
        changed_files: ['src/reused.ts'],
        include_untracked: true,
        metrics: {
            scope_sha256: 'a'.repeat(64)
        }
    };
    const preflightSha = writeJson(preflightPath, preflightPayload);

    const artifactText = [
        '# Code Review',
        '',
        'Validated `src/reused.ts` and its reuse timing trust with strict historical evidence, source receipt snapshots, and concrete gate fixture coverage. The review checked the changed export, the current tree binding, the source receipt chain, the launch timestamps, and the reused artifact identity before recording a pass.',
        '',
        '## Findings by Severity',
        'none',
        '',
        '## Residual Risks',
        'none',
        '',
        '## Verdict',
        'REVIEW PASSED',
        ''
    ].join('\n');
    const artifactPath = path.join(reviewsRoot, `${taskId}-${reviewType}.md`);
    const artifactSha = writeText(artifactPath, artifactText);
    const artifactSnapshotPath = path.join(reviewsRoot, `${taskId}-${reviewType}-artifact-${artifactSha}.md`);
    writeText(artifactSnapshotPath, artifactText);
    const reviewerPromptPath = path.join(reviewsRoot, `${taskId}-${reviewType}-reviewer-prompt.md`);
    const reviewerPromptSha = writeText(
        reviewerPromptPath,
        'Review the authenticated reused timing fixture and report findings for src/reused.ts.\n'
    );

    const currentTreeStateSha = '1'.repeat(64);
    const currentContextReuseSha = '2'.repeat(64);
    const currentReviewScopeSha = '3'.repeat(64);
    const currentCodeScopeSha = '4'.repeat(64);
    const sourceTreeStateSha = '5'.repeat(64);
    const sourceContextSha = '6'.repeat(64);
    const sourceContextReuseSha = '7'.repeat(64);
    const sourceReviewScopeSha = '8'.repeat(64);
    const sourceCodeScopeSha = '9'.repeat(64);
    const routingEventSha = 'a'.repeat(64);
    const invocationEventSha = 'b'.repeat(64);
    const historicalReviewRecordedSha = 'c'.repeat(64);
    const currentReviewRecordedSha = 'd'.repeat(64);
    const duplicateInvocationSha = 'e'.repeat(64);
    const forgedReviewRecordedSha = '0'.repeat(64);
    const reviewerIdentity = 'agent:strict-reviewer';

    const reviewContext = {
        schema_version: 2,
        task_id: taskId,
        review_type: reviewType,
        preflight_path: toPosixPath(preflightPath),
        preflight_sha256: preflightSha,
        tree_state: {
            tree_state_sha256: currentTreeStateSha,
            changed_files: ['src/reused.ts']
        },
        rule_context: {
            preferred_prompt_artifact: toPosixPath(reviewerPromptPath),
            artifact_path: toPosixPath(reviewerPromptPath),
            artifact_sha256: reviewerPromptSha
        },
        reviewer_routing: {
            source_of_truth: 'Codex',
            canonical_source_of_truth: 'Codex',
            execution_provider: 'Codex',
            execution_provider_source: 'explicit_provider',
            identity_status: 'resolved',
            actual_execution_mode: 'delegated_subagent',
            reviewer_session_id: reviewerIdentity
        }
    };
    const reviewContextPath = path.join(reviewsRoot, `${taskId}-${reviewType}-review-context.json`);
    const currentContextSha = writeJson(reviewContextPath, reviewContext);

    const reviewerProvenance = {
        schema_version: 1,
        attestation_type: 'reviewer_invocation_attestation',
        controller_event_type: 'REVIEWER_INVOCATION_ATTESTED',
        task_sequence: 4,
        prev_event_sha256: routingEventSha,
        event_sha256: invocationEventSha,
        task_id: taskId,
        review_type: reviewType,
        reviewer_execution_mode: 'delegated_subagent',
        reviewer_identity: reviewerIdentity,
        review_context_sha256: sourceContextSha,
        review_tree_state_sha256: sourceTreeStateSha,
        routing_event_sha256: routingEventSha,
        launch_prepared_at_utc: '2026-05-17T20:00:00.000Z',
        delegation_started_at_utc: '2026-05-17T20:00:01.000Z',
        launched_at_utc: '2026-05-17T20:00:01.000Z',
        launch_completed_at_utc: mode === 'too-short'
            ? '2026-05-17T20:00:04.000Z'
            : '2026-05-17T20:00:12.000Z',
        invocation_attested_at_utc: mode === 'too-short'
            ? '2026-05-17T20:00:04.500Z'
            : '2026-05-17T20:00:13.000Z'
    };

    const sourceReceipt = {
        schema_version: 2,
        task_id: taskId,
        review_type: reviewType,
        preflight_sha256: preflightSha,
        scope_sha256: 'a'.repeat(64),
        review_scope_sha256: sourceReviewScopeSha,
        code_scope_sha256: sourceCodeScopeSha,
        review_context_sha256: sourceContextSha,
        review_context_reuse_sha256: sourceContextReuseSha,
        review_tree_state_sha256: sourceTreeStateSha,
        review_artifact_sha256: artifactSha,
        reviewer_execution_mode: 'delegated_subagent',
        reviewer_identity: reviewerIdentity,
        reviewer_fallback_reason: null,
        reviewer_provenance: reviewerProvenance,
        trust_level: 'INDEPENDENT_AUDITED',
        outcome: 'PASS',
        verdict: 'pass',
        reused_existing_review: false,
        recorded_at_utc: mode === 'missing' || mode === 'forged-later'
            ? null
            : mode === 'too-short'
                ? '2026-05-17T20:00:05.000Z'
                : '2026-05-17T20:00:30.000Z',
        review_result_recorded_at_utc: mode === 'missing' || mode === 'forged-later'
            ? null
            : mode === 'too-short'
                ? '2026-05-17T20:00:05.000Z'
                : '2026-05-17T20:00:30.000Z',
        review_output_source_mtime_utc: mode === 'stale-output'
            ? '2026-05-17T19:59:59.000Z'
            : '2026-05-17T20:00:31.000Z'
    };
    const receiptPath = path.join(reviewsRoot, `${taskId}-${reviewType}-receipt.json`);
    const sourceReceiptPayload = `${JSON.stringify(sourceReceipt, null, 2)}\n`;
    const sourceReceiptSha = sha256(sourceReceiptPayload);
    const sourceReceiptSnapshotPath = path.join(reviewsRoot, `${taskId}-${reviewType}-receipt-${sourceReceiptSha}.json`);
    writeText(sourceReceiptSnapshotPath, sourceReceiptPayload);

    const currentReceipt = {
        ...sourceReceipt,
        review_context_sha256: currentContextSha,
        review_context_reuse_sha256: currentContextReuseSha,
        review_tree_state_sha256: currentTreeStateSha,
        review_scope_sha256: currentReviewScopeSha,
        code_scope_sha256: currentCodeScopeSha,
        reused_existing_review: true,
        reused_from_receipt_path: toPosixPath(receiptPath),
        reused_from_receipt_sha256: sourceReceiptSha,
        reused_from_review_context_sha256: sourceContextSha,
        reused_from_review_context_reuse_sha256: sourceContextReuseSha,
        reused_from_review_tree_state_sha256: sourceTreeStateSha,
        reused_from_review_scope_sha256: sourceReviewScopeSha,
        reused_from_code_scope_sha256: sourceCodeScopeSha,
        recorded_at_utc: '2026-05-17T20:10:00.000Z',
        review_result_recorded_at_utc: '2026-05-17T20:10:00.000Z'
    };
    const currentReceiptSha = writeJson(receiptPath, currentReceipt);
    const currentReceiptSnapshotPath = path.join(reviewsRoot, `${taskId}-${reviewType}-receipt-${currentReceiptSha}.json`);
    writeJson(currentReceiptSnapshotPath, currentReceipt);

    const duplicateEvent = {
        event_type: 'REVIEWER_INVOCATION_ATTESTED',
        sequence: 0,
        details: {
            task_id: taskId,
            review_type: 'test',
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_identity: 'agent:test-reviewer',
            review_context_sha256: sourceContextSha,
            review_tree_state_sha256: sourceTreeStateSha,
            routing_event_sha256: routingEventSha,
            provider_invocation_id: 'provider-run-reused',
            reviewer_launch_attestation_source: 'codex.spawn_agent'
        },
        integrity: {
            schema_version: 1,
            task_sequence: 2,
            prev_event_sha256: routingEventSha,
            event_sha256: duplicateInvocationSha
        }
    };
    const invocationEvent = {
        event_type: 'REVIEWER_INVOCATION_ATTESTED',
        sequence: 1,
        details: {
            task_id: taskId,
            review_type: reviewType,
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_identity: reviewerIdentity,
            review_context_sha256: sourceContextSha,
            review_tree_state_sha256: sourceTreeStateSha,
            routing_event_sha256: routingEventSha,
            provider_invocation_id: 'provider-run-reused',
            reviewer_launch_attestation_source: mode === 'too-short' ? 'controller' : 'codex.spawn_agent',
            launch_prepared_at_utc: reviewerProvenance.launch_prepared_at_utc,
            delegation_started_at_utc: reviewerProvenance.delegation_started_at_utc,
            launched_at_utc: reviewerProvenance.launched_at_utc,
            launch_completed_at_utc: reviewerProvenance.launch_completed_at_utc,
            invocation_attested_at_utc: reviewerProvenance.invocation_attested_at_utc
        },
        integrity: {
            schema_version: 1,
            task_sequence: 4,
            prev_event_sha256: routingEventSha,
            event_sha256: invocationEventSha
        }
    };
    const historicalReviewRecordedEvent = {
        event_type: 'REVIEW_RECORDED',
        outcome: 'PASS',
        sequence: 2,
        details: {
            ...sourceReceipt,
            receipt_path: toPosixPath(receiptPath),
            receipt_sha256: sourceReceiptSha,
            receipt_snapshot_path: toPosixPath(sourceReceiptSnapshotPath),
            receipt_snapshot_sha256: sourceReceiptSha,
            review_artifact_path: toPosixPath(artifactPath),
            review_artifact_sha256: artifactSha,
            review_artifact_snapshot_path: toPosixPath(artifactSnapshotPath),
            review_artifact_snapshot_sha256: artifactSha
        },
        integrity: {
            schema_version: 1,
            task_sequence: 5,
            prev_event_sha256: invocationEventSha,
            event_sha256: historicalReviewRecordedSha
        }
    };
    const currentReviewRecordedEvent = {
        event_type: 'REVIEW_RECORDED',
        outcome: 'PASS',
        sequence: mode === 'forged-later' ? 5 : 4,
        details: {
            ...currentReceipt,
            receipt_path: toPosixPath(receiptPath),
            receipt_sha256: currentReceiptSha,
            receipt_snapshot_path: toPosixPath(currentReceiptSnapshotPath),
            receipt_snapshot_sha256: currentReceiptSha,
            review_artifact_path: toPosixPath(artifactPath),
            review_artifact_sha256: artifactSha,
            review_artifact_snapshot_path: toPosixPath(artifactSnapshotPath),
            review_artifact_snapshot_sha256: artifactSha
        },
        integrity: {
            schema_version: 1,
            task_sequence: 12,
            prev_event_sha256: historicalReviewRecordedSha,
            event_sha256: currentReviewRecordedSha
        }
    };
    const forgedReviewRecordedEvent = {
        event_type: 'REVIEW_RECORDED',
        outcome: 'PASS',
        sequence: 4,
        details: {
            ...sourceReceipt,
            receipt_path: toPosixPath(receiptPath),
            receipt_sha256: sourceReceiptSha,
            receipt_snapshot_path: toPosixPath(sourceReceiptSnapshotPath),
            receipt_snapshot_sha256: sourceReceiptSha,
            review_artifact_path: toPosixPath(artifactPath),
            review_artifact_sha256: artifactSha,
            review_artifact_snapshot_path: toPosixPath(artifactSnapshotPath),
            review_artifact_snapshot_sha256: artifactSha,
            recorded_at_utc: '2026-05-17T20:00:30.000Z',
            review_result_recorded_at_utc: '2026-05-17T20:00:30.000Z'
        },
        integrity: {
            schema_version: 1,
            task_sequence: 11,
            prev_event_sha256: 'f'.repeat(64),
            event_sha256: forgedReviewRecordedSha
        }
    };
    const timelineEvents = [
        ...(mode === 'duplicate' ? [duplicateEvent] : []),
        invocationEvent,
        historicalReviewRecordedEvent,
        { event_type: 'COMPILE_GATE_PASSED', sequence: 3, details: {}, integrity: { schema_version: 1, task_sequence: 10, prev_event_sha256: historicalReviewRecordedSha, event_sha256: 'f'.repeat(64) } },
        ...(mode === 'forged-later' ? [forgedReviewRecordedEvent] : []),
        currentReviewRecordedEvent
    ];

    return {
        repoRoot,
        taskId,
        reviewType,
        preflightPath,
        preflightSha,
        preflightPayload,
        artifactPath,
        artifactText,
        artifactSha,
        reviewContextPath,
        reviewContext,
        currentContextSha,
        currentReceipt,
        timelineEvents
    };
}


describe('gates/required-reviews-check', () => {
    describe('validateReviewArtifactGateEligibility', () => {

        it('rejects current receipts whose reviewer invocation telemetry has a different tree-state binding', () => {
            const contextSha = '1'.repeat(64);
            const treeStateSha = '2'.repeat(64);
            const otherTreeStateSha = '3'.repeat(64);
            const routingEventSha = '4'.repeat(64);
            const invocationEventSha = '5'.repeat(64);
            const artifactSha = '6'.repeat(64);
            const result = validateReviewArtifactGateEligibility({
                resolvedTaskId: 'T-362',
                reviewKey: 'code',
                required: true,
                skippedByOverride: false,
                preflightPath: '/repo/garda-agent-orchestrator/runtime/reviews/T-362-preflight.json',
                preflightSha256: 'abc123',
                canonicalSourceOfTruth: 'Codex',
                executionProvider: 'Codex',
                executionProviderSource: 'explicit_provider',
                timelineEvents: [
                    { event_type: 'COMPILE_GATE_PASSED', sequence: 0, details: {}, integrity: null },
                    { event_type: 'REVIEW_PHASE_STARTED', sequence: 1, details: { review_type: 'code' }, integrity: null },
                    {
                        event_type: 'REVIEWER_DELEGATION_ROUTED',
                        sequence: 2,
                        details: {
                            review_type: 'code',
                            reviewer_execution_mode: 'delegated_subagent',
                            reviewer_session_id: 'agent:code-reviewer'
                        },
                        integrity: {
                            schema_version: 1,
                            task_sequence: 10,
                            prev_event_sha256: null,
                            event_sha256: routingEventSha
                        }
                    },
                    {
                        event_type: 'REVIEWER_INVOCATION_ATTESTED',
                        sequence: 3,
                        details: {
                            task_id: 'T-362',
                            review_type: 'code',
                            reviewer_execution_mode: 'delegated_subagent',
                            reviewer_identity: 'agent:code-reviewer',
                            review_context_sha256: contextSha,
                            review_tree_state_sha256: otherTreeStateSha,
                            routing_event_sha256: routingEventSha
                        },
                        integrity: {
                            schema_version: 1,
                            task_sequence: 11,
                            prev_event_sha256: routingEventSha,
                            event_sha256: invocationEventSha
                        }
                    }
                ],
                reviewArtifact: {
                    path: '/repo/garda-agent-orchestrator/runtime/reviews/T-362-code.md',
                    content: [
                        '# Review',
                        '',
                        'Validated current receipt tree-state binding with concrete implementation detail and a non-trivial receipt fixture.',
                        '',
                        '## Findings by Severity',
                        'none',
                        '',
                        '## Residual Risks',
                        'none',
                        '',
                        '## Verdict',
                        'REVIEW PASSED'
                    ].join('\n'),
                    reviewContextPath: '/repo/garda-agent-orchestrator/runtime/reviews/T-362-code-review-context.json',
                    reviewContext: {
                        schema_version: 2,
                        task_id: 'T-362',
                        review_type: 'code',
                        preflight_path: '/repo/garda-agent-orchestrator/runtime/reviews/T-362-preflight.json',
                        preflight_sha256: 'abc123',
                        tree_state: {
                            tree_state_sha256: treeStateSha
                        },
                        reviewer_routing: {
                            source_of_truth: 'Codex',
                            canonical_source_of_truth: 'Codex',
                            execution_provider: 'Codex',
                            execution_provider_source: 'explicit_provider',
                            identity_status: 'resolved',
                            actual_execution_mode: 'delegated_subagent',
                            reviewer_session_id: 'agent:code-reviewer'
                        }
                    },
                    reviewContextSha256: contextSha,
                    artifactSha256: artifactSha,
                    receipt: {
                        schema_version: 2,
                        task_id: 'T-362',
                        review_type: 'code',
                        preflight_sha256: 'abc123',
                        scope_sha256: null,
                        review_context_sha256: contextSha,
                        review_tree_state_sha256: treeStateSha,
                        review_artifact_sha256: artifactSha,
                        reviewer_execution_mode: 'delegated_subagent',
                        reviewer_identity: 'agent:code-reviewer',
                        reviewer_fallback_reason: null,
                        reviewer_provenance: {
                            schema_version: 1,
                            attestation_type: 'reviewer_invocation_attestation',
                            controller_event_type: 'REVIEWER_INVOCATION_ATTESTED',
                            task_sequence: 11,
                            prev_event_sha256: routingEventSha,
                            event_sha256: invocationEventSha,
                            task_id: 'T-362',
                            review_type: 'code',
                            reviewer_execution_mode: 'delegated_subagent',
                            reviewer_identity: 'agent:code-reviewer',
                            review_context_sha256: contextSha,
                            review_tree_state_sha256: treeStateSha,
                            routing_event_sha256: routingEventSha
                        },
                        trust_level: 'INDEPENDENT_AUDITED',
                        recorded_at_utc: '2026-05-02T00:00:00.000Z'
                    }
                }
            });

            assert.ok(result.violations.some((violation) => (
                violation.includes('reviewer_provenance does not match REVIEWER_INVOCATION_ATTESTED launch telemetry')
            )));
        });

        it('rejects current receipts whose reviewer provenance context binding diverges from the receipt', () => {
            const currentContextSha = '1'.repeat(64);
            const treeStateSha = '2'.repeat(64);
            const staleContextSha = '3'.repeat(64);
            const routingEventSha = '4'.repeat(64);
            const invocationEventSha = '5'.repeat(64);
            const artifactSha = '6'.repeat(64);
            const result = validateReviewArtifactGateEligibility({
                resolvedTaskId: 'T-883',
                reviewKey: 'code',
                required: true,
                skippedByOverride: false,
                preflightPath: '/repo/garda-agent-orchestrator/runtime/reviews/T-883-preflight.json',
                preflightSha256: 'abc123',
                canonicalSourceOfTruth: 'Codex',
                executionProvider: 'Codex',
                executionProviderSource: 'explicit_provider',
                timelineEvents: [
                    { event_type: 'COMPILE_GATE_PASSED', sequence: 0, details: {}, integrity: null },
                    { event_type: 'REVIEW_PHASE_STARTED', sequence: 1, details: { review_type: 'code' }, integrity: null },
                    {
                        event_type: 'REVIEWER_DELEGATION_ROUTED',
                        sequence: 2,
                        details: {
                            review_type: 'code',
                            reviewer_execution_mode: 'delegated_subagent',
                            reviewer_session_id: 'agent:code-reviewer'
                        },
                        integrity: {
                            schema_version: 1,
                            task_sequence: 10,
                            prev_event_sha256: null,
                            event_sha256: routingEventSha
                        }
                    },
                    {
                        event_type: 'REVIEWER_INVOCATION_ATTESTED',
                        sequence: 3,
                        details: {
                            task_id: 'T-883',
                            review_type: 'code',
                            reviewer_execution_mode: 'delegated_subagent',
                            reviewer_identity: 'agent:code-reviewer',
                            review_context_sha256: staleContextSha,
                            review_tree_state_sha256: treeStateSha,
                            routing_event_sha256: routingEventSha
                        },
                        integrity: {
                            schema_version: 1,
                            task_sequence: 11,
                            prev_event_sha256: routingEventSha,
                            event_sha256: invocationEventSha
                        }
                    }
                ],
                reviewArtifact: {
                    path: '/repo/garda-agent-orchestrator/runtime/reviews/T-883-code.md',
                    content: [
                        '# Review',
                        '',
                        'Validated provenance context binding with concrete implementation detail and a non-trivial receipt fixture.',
                        '',
                        '## Findings by Severity',
                        'none',
                        '',
                        '## Residual Risks',
                        'none',
                        '',
                        '## Verdict',
                        'REVIEW PASSED'
                    ].join('\n'),
                    reviewContextPath: '/repo/garda-agent-orchestrator/runtime/reviews/T-883-code-review-context.json',
                    reviewContext: {
                        schema_version: 2,
                        task_id: 'T-883',
                        review_type: 'code',
                        preflight_path: '/repo/garda-agent-orchestrator/runtime/reviews/T-883-preflight.json',
                        preflight_sha256: 'abc123',
                        tree_state: {
                            tree_state_sha256: treeStateSha
                        },
                        reviewer_routing: {
                            source_of_truth: 'Codex',
                            canonical_source_of_truth: 'Codex',
                            execution_provider: 'Codex',
                            execution_provider_source: 'explicit_provider',
                            identity_status: 'resolved',
                            actual_execution_mode: 'delegated_subagent',
                            reviewer_session_id: 'agent:code-reviewer'
                        }
                    },
                    reviewContextSha256: currentContextSha,
                    artifactSha256: artifactSha,
                    receipt: {
                        schema_version: 2,
                        task_id: 'T-883',
                        review_type: 'code',
                        preflight_sha256: 'abc123',
                        scope_sha256: null,
                        review_context_sha256: currentContextSha,
                        review_tree_state_sha256: treeStateSha,
                        review_artifact_sha256: artifactSha,
                        reviewer_execution_mode: 'delegated_subagent',
                        reviewer_identity: 'agent:code-reviewer',
                        reviewer_fallback_reason: null,
                        reviewer_provenance: {
                            schema_version: 1,
                            attestation_type: 'reviewer_invocation_attestation',
                            controller_event_type: 'REVIEWER_INVOCATION_ATTESTED',
                            task_sequence: 11,
                            prev_event_sha256: routingEventSha,
                            event_sha256: invocationEventSha,
                            task_id: 'T-883',
                            review_type: 'code',
                            reviewer_execution_mode: 'delegated_subagent',
                            reviewer_identity: 'agent:code-reviewer',
                            review_context_sha256: staleContextSha,
                            review_tree_state_sha256: treeStateSha,
                            routing_event_sha256: routingEventSha
                        },
                        trust_level: 'INDEPENDENT_AUDITED',
                        recorded_at_utc: '2026-07-01T00:00:00.000Z'
                    }
                }
            });

            assert.ok(result.violations.some((violation) => (
                violation.includes('reviewer_provenance does not match REVIEWER_INVOCATION_ATTESTED launch telemetry')
            )), JSON.stringify(result, null, 2));
        });

        it('rejects current receipts whose timing provenance diverges from invocation telemetry', () => {
            const contextSha = '1'.repeat(64);
            const treeStateSha = '2'.repeat(64);
            const routingEventSha = '4'.repeat(64);
            const invocationEventSha = '5'.repeat(64);
            const artifactSha = '6'.repeat(64);
            const result = validateReviewArtifactGateEligibility({
                resolvedTaskId: 'T-564-1',
                reviewKey: 'code',
                required: true,
                skippedByOverride: false,
                preflightPath: '/repo/garda-agent-orchestrator/runtime/reviews/T-564-1-preflight.json',
                preflightSha256: 'abc123',
                canonicalSourceOfTruth: 'Codex',
                executionProvider: 'Codex',
                executionProviderSource: 'explicit_provider',
                timelineEvents: [
                    { event_type: 'COMPILE_GATE_PASSED', sequence: 0, details: {}, integrity: null },
                    { event_type: 'REVIEW_PHASE_STARTED', sequence: 1, details: { review_type: 'code' }, integrity: null },
                    {
                        event_type: 'REVIEWER_DELEGATION_ROUTED',
                        sequence: 2,
                        details: {
                            review_type: 'code',
                            reviewer_execution_mode: 'delegated_subagent',
                            reviewer_session_id: 'agent:code-reviewer'
                        },
                        integrity: {
                            schema_version: 1,
                            task_sequence: 10,
                            prev_event_sha256: null,
                            event_sha256: routingEventSha
                        }
                    },
                    {
                        event_type: 'REVIEWER_INVOCATION_ATTESTED',
                        sequence: 3,
                        details: {
                            task_id: 'T-564-1',
                            review_type: 'code',
                            reviewer_execution_mode: 'delegated_subagent',
                            reviewer_identity: 'agent:code-reviewer',
                            review_context_sha256: contextSha,
                            review_tree_state_sha256: treeStateSha,
                            routing_event_sha256: routingEventSha,
                            launch_prepared_at_utc: '2026-05-17T21:00:00.000Z',
                            launched_at_utc: '2026-05-17T21:00:01.000Z',
                            launch_completed_at_utc: '2026-05-17T21:00:02.000Z',
                            invocation_attested_at_utc: '2026-05-17T21:00:03.000Z'
                        },
                        integrity: {
                            schema_version: 1,
                            task_sequence: 11,
                            prev_event_sha256: routingEventSha,
                            event_sha256: invocationEventSha
                        }
                    }
                ],
                reviewArtifact: {
                    path: '/repo/garda-agent-orchestrator/runtime/reviews/T-564-1-code.md',
                    content: [
                        '# Review',
                        '',
                        'Validated current receipt timing provenance binding with concrete implementation detail and a non-trivial receipt fixture.',
                        '',
                        '## Findings by Severity',
                        'none',
                        '',
                        '## Residual Risks',
                        'none',
                        '',
                        '## Verdict',
                        'REVIEW PASSED'
                    ].join('\n'),
                    reviewContextPath: '/repo/garda-agent-orchestrator/runtime/reviews/T-564-1-code-review-context.json',
                    reviewContext: {
                        schema_version: 2,
                        task_id: 'T-564-1',
                        review_type: 'code',
                        preflight_path: '/repo/garda-agent-orchestrator/runtime/reviews/T-564-1-preflight.json',
                        preflight_sha256: 'abc123',
                        tree_state: {
                            tree_state_sha256: treeStateSha
                        },
                        reviewer_routing: {
                            source_of_truth: 'Codex',
                            canonical_source_of_truth: 'Codex',
                            execution_provider: 'Codex',
                            execution_provider_source: 'explicit_provider',
                            identity_status: 'resolved',
                            actual_execution_mode: 'delegated_subagent',
                            reviewer_session_id: 'agent:code-reviewer'
                        }
                    },
                    reviewContextSha256: contextSha,
                    artifactSha256: artifactSha,
                    receipt: {
                        schema_version: 2,
                        task_id: 'T-564-1',
                        review_type: 'code',
                        preflight_sha256: 'abc123',
                        scope_sha256: null,
                        review_context_sha256: contextSha,
                        review_tree_state_sha256: treeStateSha,
                        review_artifact_sha256: artifactSha,
                        reviewer_execution_mode: 'delegated_subagent',
                        reviewer_identity: 'agent:code-reviewer',
                        reviewer_fallback_reason: null,
                        reviewer_provenance: {
                            schema_version: 1,
                            attestation_type: 'reviewer_invocation_attestation',
                            controller_event_type: 'REVIEWER_INVOCATION_ATTESTED',
                            task_sequence: 11,
                            prev_event_sha256: routingEventSha,
                            event_sha256: invocationEventSha,
                            task_id: 'T-564-1',
                            review_type: 'code',
                            reviewer_execution_mode: 'delegated_subagent',
                            reviewer_identity: 'agent:code-reviewer',
                            review_context_sha256: contextSha,
                            review_tree_state_sha256: treeStateSha,
                            routing_event_sha256: routingEventSha,
                            launch_prepared_at_utc: '2026-05-17T21:00:00.000Z',
                            launched_at_utc: '2026-05-17T21:00:01.000Z',
                            launch_completed_at_utc: '2026-05-17T21:00:59.000Z',
                            invocation_attested_at_utc: '2026-05-17T21:00:03.000Z'
                        },
                        trust_level: 'INDEPENDENT_AUDITED',
                        recorded_at_utc: '2026-05-17T21:01:00.000Z'
                    }
                }
            });

            assert.ok(result.violations.some((violation) => (
                violation.includes('reviewer_provenance does not match REVIEWER_INVOCATION_ATTESTED launch telemetry')
            )));
        });

        it('rejects receipts when latest current routing telemetry conflicts with the review context', () => {
            const contextSha = '1'.repeat(64);
            const treeStateSha = '2'.repeat(64);
            const originalRoutingEventSha = '3'.repeat(64);
            const lateRoutingEventSha = '4'.repeat(64);
            const invocationEventSha = '5'.repeat(64);
            const artifactSha = '6'.repeat(64);
            const result = validateReviewArtifactGateEligibility({
                resolvedTaskId: 'T-574',
                reviewKey: 'code',
                required: true,
                skippedByOverride: false,
                preflightPath: '/repo/garda-agent-orchestrator/runtime/reviews/T-574-preflight.json',
                preflightSha256: 'abc123',
                canonicalSourceOfTruth: 'Codex',
                executionProvider: 'Codex',
                executionProviderSource: 'explicit_provider',
                timelineEvents: [
                    { event_type: 'COMPILE_GATE_PASSED', sequence: 0, details: {}, integrity: null },
                    { event_type: 'REVIEW_PHASE_STARTED', sequence: 1, details: { review_type: 'code' }, integrity: null },
                    {
                        event_type: 'REVIEWER_DELEGATION_ROUTED',
                        sequence: 2,
                        details: {
                            review_type: 'code',
                            reviewer_execution_mode: 'delegated_subagent',
                            reviewer_session_id: 'agent:original-reviewer'
                        },
                        integrity: {
                            schema_version: 1,
                            task_sequence: 10,
                            prev_event_sha256: null,
                            event_sha256: originalRoutingEventSha
                        }
                    },
                    {
                        event_type: 'REVIEWER_INVOCATION_ATTESTED',
                        sequence: 3,
                        details: {
                            task_id: 'T-574',
                            review_type: 'code',
                            reviewer_execution_mode: 'delegated_subagent',
                            reviewer_identity: 'agent:original-reviewer',
                            review_context_sha256: contextSha,
                            review_tree_state_sha256: treeStateSha,
                            routing_event_sha256: originalRoutingEventSha
                        },
                        integrity: {
                            schema_version: 1,
                            task_sequence: 11,
                            prev_event_sha256: originalRoutingEventSha,
                            event_sha256: invocationEventSha
                        }
                    },
                    {
                        event_type: 'REVIEWER_DELEGATION_ROUTED',
                        sequence: 4,
                        details: {
                            review_type: 'code',
                            reviewer_execution_mode: 'delegated_subagent',
                            reviewer_session_id: 'agent:late-reviewer'
                        },
                        integrity: {
                            schema_version: 1,
                            task_sequence: 12,
                            prev_event_sha256: invocationEventSha,
                            event_sha256: lateRoutingEventSha
                        }
                    }
                ],
                reviewArtifact: {
                    path: '/repo/garda-agent-orchestrator/runtime/reviews/T-574-code.md',
                    content: [
                        '# Review',
                        '',
                        'Validated review gate provenance parity with completion using concrete late-routing telemetry and receipt provenance evidence.',
                        '',
                        '## Findings by Severity',
                        'none',
                        '',
                        '## Residual Risks',
                        'none',
                        '',
                        '## Verdict',
                        'REVIEW PASSED'
                    ].join('\n'),
                    reviewContextPath: '/repo/garda-agent-orchestrator/runtime/reviews/T-574-code-review-context.json',
                    reviewContext: {
                        schema_version: 2,
                        task_id: 'T-574',
                        review_type: 'code',
                        preflight_path: '/repo/garda-agent-orchestrator/runtime/reviews/T-574-preflight.json',
                        preflight_sha256: 'abc123',
                        tree_state: {
                            tree_state_sha256: treeStateSha
                        },
                        reviewer_routing: {
                            source_of_truth: 'Codex',
                            canonical_source_of_truth: 'Codex',
                            execution_provider: 'Codex',
                            execution_provider_source: 'explicit_provider',
                            identity_status: 'resolved',
                            actual_execution_mode: 'delegated_subagent',
                            reviewer_session_id: 'agent:original-reviewer'
                        }
                    },
                    reviewContextSha256: contextSha,
                    artifactSha256: artifactSha,
                    receipt: {
                        schema_version: 2,
                        task_id: 'T-574',
                        review_type: 'code',
                        preflight_sha256: 'abc123',
                        scope_sha256: null,
                        review_context_sha256: contextSha,
                        review_tree_state_sha256: treeStateSha,
                        review_artifact_sha256: artifactSha,
                        reviewer_execution_mode: 'delegated_subagent',
                        reviewer_identity: 'agent:original-reviewer',
                        reviewer_fallback_reason: null,
                        reviewer_provenance: {
                            schema_version: 1,
                            attestation_type: 'reviewer_invocation_attestation',
                            controller_event_type: 'REVIEWER_INVOCATION_ATTESTED',
                            task_sequence: 11,
                            prev_event_sha256: originalRoutingEventSha,
                            event_sha256: invocationEventSha,
                            task_id: 'T-574',
                            review_type: 'code',
                            reviewer_execution_mode: 'delegated_subagent',
                            reviewer_identity: 'agent:original-reviewer',
                            review_context_sha256: contextSha,
                            review_tree_state_sha256: treeStateSha,
                            routing_event_sha256: originalRoutingEventSha
                        },
                        trust_level: 'INDEPENDENT_AUDITED',
                        recorded_at_utc: '2026-05-18T00:00:00.000Z'
                    }
                }
            });

            assert.ok(result.violations.some((violation) => (
                violation.includes('inconsistent reviewer identity between REVIEWER_DELEGATION_ROUTED telemetry') &&
                violation.includes('agent:late-reviewer') &&
                violation.includes('agent:original-reviewer')
            )));
        });

        it('rejects hidden timing distrust with generic remediation only', () => {
            const contextSha = '1'.repeat(64);
            const treeStateSha = '2'.repeat(64);
            const routingEventSha = '4'.repeat(64);
            const invocationEventSha = '5'.repeat(64);
            const artifactSha = '6'.repeat(64);
            const result = validateReviewArtifactGateEligibility({
                resolvedTaskId: 'T-564-1',
                reviewKey: 'code',
                required: true,
                skippedByOverride: false,
                preflightPath: '/repo/garda-agent-orchestrator/runtime/reviews/T-564-1-preflight.json',
                preflightSha256: 'abc123',
                canonicalSourceOfTruth: 'Codex',
                executionProvider: 'Codex',
                executionProviderSource: 'explicit_provider',
                timelineEvents: [
                    { event_type: 'COMPILE_GATE_PASSED', sequence: 0, details: {}, integrity: null },
                    {
                        event_type: 'REVIEWER_DELEGATION_ROUTED',
                        sequence: 1,
                        details: {
                            review_type: 'code',
                            reviewer_execution_mode: 'delegated_subagent',
                            reviewer_session_id: 'agent:code-reviewer'
                        },
                        integrity: {
                            schema_version: 1,
                            task_sequence: 10,
                            prev_event_sha256: null,
                            event_sha256: routingEventSha
                        }
                    },
                    {
                        event_type: 'REVIEWER_INVOCATION_ATTESTED',
                        sequence: 2,
                        details: {
                            task_id: 'T-564-1',
                            review_type: 'code',
                            reviewer_execution_mode: 'delegated_subagent',
                            reviewer_identity: 'agent:code-reviewer',
                            review_context_sha256: contextSha,
                            review_tree_state_sha256: treeStateSha,
                            routing_event_sha256: routingEventSha,
                            launch_prepared_at_utc: '2026-05-17T21:00:00.000Z',
                            launched_at_utc: '2026-05-17T21:00:01.000Z',
                            launch_completed_at_utc: '2026-05-17T21:00:02.000Z',
                            invocation_attested_at_utc: '2026-05-17T21:00:03.000Z',
                            provider_invocation_id: 'provider-run-required',
                            reviewer_launch_attestation_source: 'codex.spawn_agent'
                        },
                        integrity: {
                            schema_version: 1,
                            task_sequence: 11,
                            prev_event_sha256: routingEventSha,
                            event_sha256: invocationEventSha
                        }
                    }
                ],
                reviewArtifact: {
                    path: '/repo/garda-agent-orchestrator/runtime/reviews/T-564-1-code.md',
                    content: [
                        '# Review',
                        '',
                        'Validated hidden timing distrust acceptance surface with concrete implementation detail and a non-trivial receipt fixture.',
                        '',
                        '## Findings by Severity',
                        'none',
                        '',
                        '## Residual Risks',
                        'none',
                        '',
                        '## Verdict',
                        'REVIEW PASSED'
                    ].join('\n'),
                    reviewContextPath: '/repo/garda-agent-orchestrator/runtime/reviews/T-564-1-code-review-context.json',
                    reviewContext: {
                        schema_version: 2,
                        task_id: 'T-564-1',
                        review_type: 'code',
                        preflight_path: '/repo/garda-agent-orchestrator/runtime/reviews/T-564-1-preflight.json',
                        preflight_sha256: 'abc123',
                        tree_state: {
                            tree_state_sha256: treeStateSha
                        },
                        reviewer_routing: {
                            source_of_truth: 'Codex',
                            canonical_source_of_truth: 'Codex',
                            execution_provider: 'Codex',
                            execution_provider_source: 'explicit_provider',
                            identity_status: 'resolved',
                            actual_execution_mode: 'delegated_subagent',
                            reviewer_session_id: 'agent:code-reviewer'
                        }
                    },
                    reviewContextSha256: contextSha,
                    artifactSha256: artifactSha,
                    receipt: {
                        schema_version: 2,
                        task_id: 'T-564-1',
                        review_type: 'code',
                        preflight_sha256: 'abc123',
                        scope_sha256: null,
                        review_context_sha256: contextSha,
                        review_tree_state_sha256: treeStateSha,
                        review_artifact_sha256: artifactSha,
                        reviewer_execution_mode: 'delegated_subagent',
                        reviewer_identity: 'agent:code-reviewer',
                        reviewer_fallback_reason: null,
                        reviewer_provenance: {
                            schema_version: 1,
                            attestation_type: 'reviewer_invocation_attestation',
                            controller_event_type: 'REVIEWER_INVOCATION_ATTESTED',
                            task_sequence: 11,
                            prev_event_sha256: routingEventSha,
                            event_sha256: invocationEventSha,
                            task_id: 'T-564-1',
                            review_type: 'code',
                            reviewer_execution_mode: 'delegated_subagent',
                            reviewer_identity: 'agent:code-reviewer',
                            review_context_sha256: contextSha,
                            review_tree_state_sha256: treeStateSha,
                            routing_event_sha256: routingEventSha,
                            launch_prepared_at_utc: '2026-05-17T21:00:00.000Z',
                            launched_at_utc: '2026-05-17T21:00:01.000Z',
                            launch_completed_at_utc: '2026-05-17T21:00:02.000Z',
                            invocation_attested_at_utc: '2026-05-17T21:00:03.000Z'
                        },
                        trust_level: 'INDEPENDENT_AUDITED',
                        reused_existing_review: false,
                        recorded_at_utc: '2026-05-17T21:01:00.000Z',
                        review_result_recorded_at_utc: '2026-05-17T21:01:00.000Z',
                        review_output_source_mtime_utc: '2026-05-17T20:59:59.000Z'
                    }
                }
            });

            const hiddenViolation = result.violations.find((violation) => (
                violation.includes("Review receipt for 'code' is not sufficiently trustworthy")
            ));
            assert.ok(hiddenViolation, JSON.stringify(result, null, 2));
            assert.match(hiddenViolation, /Launch a real subagent using built-in tools/);
            assert.equal(/timing|threshold|elapsed|duration|seconds|impossible_ordering|missing_timing/i.test(hiddenViolation), false);
        });

        it('rejects reused receipts when the current lane-domain fingerprint differs from reuse telemetry', () => {
            const fixture = buildRequiredReviewsReusedTimingFixture('valid');
            try {
                const driftedReceipt = {
                    ...fixture.currentReceipt,
                    code_scope_sha256: 'e'.repeat(64)
                };
                const result = validateReviewArtifactGateEligibility({
                    resolvedTaskId: fixture.taskId,
                    reviewKey: fixture.reviewType,
                    required: true,
                    skippedByOverride: false,
                    preflightPath: fixture.preflightPath,
                    preflightSha256: fixture.preflightSha,
                    preflightPayload: fixture.preflightPayload,
                    repoRoot: fixture.repoRoot,
                    canonicalSourceOfTruth: 'Codex',
                    executionProvider: 'Codex',
                    executionProviderSource: 'explicit_provider',
                    timelineEvents: fixture.timelineEvents,
                    reviewArtifact: {
                        path: fixture.artifactPath,
                        content: fixture.artifactText,
                        reviewContextPath: fixture.reviewContextPath,
                        reviewContext: fixture.reviewContext,
                        reviewContextSha256: fixture.currentContextSha,
                        artifactSha256: fixture.artifactSha,
                        receipt: driftedReceipt as any
                    }
                });

                assert.ok(
                    result.violations.some((violation) => (
                        violation.includes("Review 'code' is missing current-cycle REVIEW_RECORDED reuse telemetry")
                        && violation.includes('does not match strict reused evidence')
                    )),
                    JSON.stringify(result, null, 2)
                );
            } finally {
                fs.rmSync(fixture.repoRoot, { recursive: true, force: true });
            }
        });

        for (const mode of ['missing', 'too-short', 'duplicate', 'forged-later', 'stale-output'] as const) {
            it(`rejects reused receipts whose historical timing trust is ${mode}`, () => {
                const fixture = buildRequiredReviewsReusedTimingFixture(mode);
                try {
                    const result = validateReviewArtifactGateEligibility({
                        resolvedTaskId: fixture.taskId,
                        reviewKey: fixture.reviewType,
                        required: true,
                        skippedByOverride: false,
                        preflightPath: fixture.preflightPath,
                        preflightSha256: fixture.preflightSha,
                        preflightPayload: fixture.preflightPayload,
                        repoRoot: fixture.repoRoot,
                        canonicalSourceOfTruth: 'Codex',
                        executionProvider: 'Codex',
                        executionProviderSource: 'explicit_provider',
                        timelineEvents: fixture.timelineEvents,
                        reviewArtifact: {
                            path: fixture.artifactPath,
                            content: fixture.artifactText,
                            reviewContextPath: fixture.reviewContextPath,
                            reviewContext: fixture.reviewContext,
                            reviewContextSha256: fixture.currentContextSha,
                            artifactSha256: fixture.artifactSha,
                            receipt: fixture.currentReceipt as any
                        }
                    });

                    const hiddenViolation = result.violations.find((violation) => (
                        violation.includes("Review receipt for 'code' is not sufficiently trustworthy")
                    ));
                    assert.ok(hiddenViolation, JSON.stringify(result, null, 2));
                    assert.match(hiddenViolation, /Launch a real subagent using built-in tools/);
                    assert.equal(/timing|threshold|elapsed|duration|seconds|impossible_ordering|missing_timing|duplicate_provider_invocation_id|too_short/i.test(hiddenViolation), false);
                    assert.equal(
                        result.violations.some((violation) => violation.includes('strict evidence is invalid')),
                        false,
                        JSON.stringify(result, null, 2)
                    );
                } finally {
                    fs.rmSync(fixture.repoRoot, { recursive: true, force: true });
                }
            });
        }


    });

});
