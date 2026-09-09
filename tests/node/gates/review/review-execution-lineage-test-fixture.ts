import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { buildReviewReceipt, type ReviewReceipt } from '../../../../src/gate-runtime/review-context';
import { sha256RedactedJsonPayload } from '../../../../src/core/redaction';
import { buildReviewCoverageContract } from '../../../../src/gates/review/review-coverage-ledger';
import { resolveReviewContextExecutionEvidenceBindings } from '../../../../src/gates/review/review-evidence-contract';
import {
    buildReviewFindingsValidationArtifact,
    getReviewFindingsValidationArtifactPath
} from '../../../../src/gates/review/review-findings-validation-artifact';
import { validateReviewFindingsContract } from '../../../../src/gates/review/review-findings-artifact-verdict';
import { REVIEW_FINDINGS_SCHEMA_VERSION } from '../../../../src/gates/review/review-findings-schema';
import {
    computeReviewRelevantScopeFingerprint,
    computeReviewReuseCodeScopeFingerprint
} from '../../../../src/gates/review-reuse';
import { buildReviewRemediationReviewContract } from '../../../../src/gates/review-remediation/review-remediation-review-contract';
import type { ReviewDependencyTimelineEvent } from '../../../../src/gates/review/review-dependencies';
import type { RuntimeReviewerIdentity } from '../../../../src/gates/review/reviewer-routing';
import { buildReviewTreeState } from '../../../../src/gates/review/review-tree-state';

function writeJson(filePath: string, value: unknown): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function fileSha256(filePath: string): string {
    return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function jsonSha256(value: unknown): string {
    return createHash('sha256').update(`${JSON.stringify(value, null, 2)}\n`).digest('hex');
}

function preflightScopeSha256(preflight: Record<string, unknown>): string {
    const metrics = preflight.metrics as Record<string, unknown> | undefined;
    const value = String(metrics?.scope_sha256 || metrics?.changed_files_sha256 || '').trim().toLowerCase();
    return /^[a-f0-9]{64}$/u.test(value) ? value : 'd'.repeat(64);
}

export interface Schema4ReviewPackage {
    artifactPath: string;
    artifactSha256: string;
    context: Record<string, unknown>;
    contextPath: string;
    contextSha256: string;
    receipt: ReviewReceipt;
    receiptPath: string;
    validationArtifactPath: string;
    delegationEvents: ReviewDependencyTimelineEvent[];
}

export function codexRuntimeReviewerIdentityFixture(): RuntimeReviewerIdentity {
    return {
        canonical_source_of_truth: 'Codex',
        canonical_entrypoint: 'AGENTS.md',
        execution_entrypoint: 'AGENTS.md',
        execution_provider: 'Codex',
        execution_provider_source: 'explicit_provider',
        task_mode_identity_backfilled: false,
        routed_to: null,
        provider_bridge: null,
        identity_status: 'resolved',
        capability_level: 'delegation_required',
        delegation_required: true,
        fallback_allowed: false,
        fallback_reason_required: false,
        expected_execution_mode: 'delegated_subagent',
        no_delegate_mode: {
            active: false,
            source: 'none',
            env_var: 'GARDA_NO_DELEGATE',
            config_path: null,
            reason: null,
            remediation: null
        },
        reviewer_subagent_launch_status: 'launchable',
        reviewer_subagent_launch_route: 'AGENTS.md',
        reviewer_subagent_launch_reason: 'Codex delegated reviewer launch is available.',
        reviewer_subagent_launch_remediation: null,
        note: '',
        violations: []
    };
}

export function writeSchema4ReviewPackage(options: {
    reviewsRoot: string;
    repoRoot: string;
    taskId: string;
    reviewType: string;
    preflightPath: string;
    preflight: Record<string, unknown>;
    mediumFindings?: readonly string[];
    residualRisks?: readonly string[];
}): Schema4ReviewPackage {
    const changedFiles = Array.isArray(options.preflight.changed_files)
        ? options.preflight.changed_files.map(String)
        : [];
    const treeState = fs.existsSync(path.join(options.repoRoot, '.git'))
        ? buildReviewTreeState({
            repoRoot: options.repoRoot,
            detectionSource: options.preflight.detection_source,
            includeUntracked: options.preflight.include_untracked !== false,
            changedFiles,
            metrics: options.preflight.metrics as Record<string, unknown> | undefined
        })
        : { tree_state_sha256: 'b'.repeat(64) };
    const treeStateSha256 = treeState.tree_state_sha256;
    const evidenceFile = changedFiles[0] || 'src/example.ts';
    const preflightSha256 = fileSha256(options.preflightPath);
    const coverageContract = buildReviewCoverageContract({
        reviewType: options.reviewType,
        changedFiles
    });
    const reviewExecution = buildReviewRemediationReviewContract({
        taskId: options.taskId,
        reviewType: options.reviewType,
        preflightSha256,
        fullReviewScope: changedFiles
    });
    const contextPath = path.join(
        options.reviewsRoot,
        `${options.taskId}-${options.reviewType}-review-context.json`
    );
    const promptArtifactPath = path.join(
        options.reviewsRoot,
        `${options.taskId}-${options.reviewType}-review-prompt.md`
    );
    fs.writeFileSync(promptArtifactPath, `Review ${evidenceFile} for authenticated execution lineage.\n`, 'utf8');
    const promptArtifactSha256 = fileSha256(promptArtifactPath);
    const context: Record<string, unknown> = {
        schema_version: 4,
        task_id: options.taskId,
        review_type: options.reviewType,
        preflight_path: options.preflightPath,
        preflight_sha256: preflightSha256,
        task_scope: {
            changed_files: changedFiles,
            diff: { available: true, source: 'test-fixture', char_count: 120 }
        },
        coverage_scope: {
            changed_files: changedFiles
        },
        tree_state: treeState,
        coverage_contract: coverageContract,
        review_execution: reviewExecution,
        reviewer_routing: {
            source_of_truth: 'Codex',
            canonical_source_of_truth: 'Codex',
            execution_provider: 'Codex',
            execution_provider_source: 'explicit_provider',
            identity_status: 'resolved',
            actual_execution_mode: 'delegated_subagent',
            reviewer_session_id: `agent:${options.taskId}-${options.reviewType}`
        },
        rule_context: {
            artifact_path: promptArtifactPath.replace(/\\/gu, '/'),
            preferred_prompt_artifact: promptArtifactPath.replace(/\\/gu, '/'),
            artifact_sha256: promptArtifactSha256
        }
    };
    writeJson(contextPath, context);
    const contextSha256 = fileSha256(contextPath);
    const report = {
        schema_version: REVIEW_FINDINGS_SCHEMA_VERSION,
        task_id: options.taskId,
        review_type: options.reviewType,
        review_context_sha256: contextSha256,
        tree_state_sha256: treeStateSha256,
        validation_notes: [{
            id: 'N-001',
            topic: 'execution lineage',
            note: 'Inspected schema-4 execution lineage at the downstream authorization consumer.',
            evidence: [{
                location: `${evidenceFile}:1`,
                observation: 'The downstream consumer received hash-bound review evidence.'
            }]
        }],
        coverage_ledger: {
            coverage_contract_sha256: coverageContract.contract_sha256,
            entries: coverageContract.obligations.map((obligation, index) => ({
                obligation_id: obligation.id,
                evidence: [{
                    location: `${evidenceFile}:1`,
                    observation: `Execution lineage was checked for ${obligation.id}.`
                }],
                finding_ids: index === 0
                    ? (options.mediumFindings || []).map((_, findingIndex) =>
                        `F-${String(findingIndex + 1).padStart(3, '0')}`)
                    : []
            }))
        },
        review_execution: {
            mode: reviewExecution.mode,
            contract_sha256: reviewExecution.contract_sha256,
            covered_delta_targets: [],
            inspected_prior_finding_ids: []
        },
        findings: {
            critical: [],
            high: [],
            medium: (options.mediumFindings || []).map((description, index) => ({
                id: `F-${String(index + 1).padStart(3, '0')}`,
                title: `Medium execution-lineage finding ${index + 1}`,
                description,
                evidence: [{
                    location: `${evidenceFile}:1`,
                    observation: 'The finding remains active for locked-policy disposition.'
                }],
                coverage_obligation_ids: coverageContract.obligations.length > 0
                    ? [coverageContract.obligations[0].id]
                    : []
            })),
            low: []
        },
        residual_risks: (options.residualRisks || []).map((description, index) => ({
            id: `R-${String(index + 1).padStart(3, '0')}`,
            description,
            evidence: [{
                location: `${evidenceFile}:1`,
                observation: 'The residual risk remains active for downstream review authorization.'
            }]
        })),
        reviewer_notes: []
    };
    const artifactPath = path.join(options.reviewsRoot, `${options.taskId}-${options.reviewType}.md`);
    writeJson(artifactPath, report);
    const artifactSha256 = fileSha256(artifactPath);
    const validation = validateReviewFindingsContract({
        content: fs.readFileSync(artifactPath, 'utf8'),
        expectedTaskId: options.taskId,
        expectedReviewType: options.reviewType,
        expectedReviewContextSha256: contextSha256,
        expectedTreeStateSha256: treeStateSha256,
        coverageContract,
        expectedReviewExecutionContract: reviewExecution
    });
    if (!validation.valid) {
        throw new Error(validation.violations.join('; '));
    }
    const scopeSha256 = preflightScopeSha256(options.preflight);
    const reviewScopeSha256 = computeReviewRelevantScopeFingerprint(
        options.preflight,
        options.repoRoot
    ).review_scope_sha256;
    const codeScopeSha256 = computeReviewReuseCodeScopeFingerprint(
        options.reviewType,
        options.preflight,
        options.repoRoot
    ).code_scope_sha256;
    const validationArtifactPath = getReviewFindingsValidationArtifactPath(artifactPath);
    const validationArtifact = buildReviewFindingsValidationArtifact({
        taskId: options.taskId,
        reviewType: options.reviewType,
        validation,
        reviewOutputSha256: artifactSha256,
        reviewArtifactPath: artifactPath,
        reviewArtifactSha256: artifactSha256,
        reviewContextPath: contextPath,
        reviewContextSha256: contextSha256,
        preflightPath: options.preflightPath,
        preflightSha256,
        scopeSha256,
        reviewScopeSha256,
        codeScopeSha256,
        reviewTreeStateSha256: treeStateSha256,
        coverageContract
    });
    writeJson(validationArtifactPath, validationArtifact);
    const validationArtifactSha256 = fileSha256(validationArtifactPath);
    const executionBindings = resolveReviewContextExecutionEvidenceBindings(context).bindings;
    if (!executionBindings) {
        throw new Error('Schema-4 review context did not produce execution bindings.');
    }
    const receipt = buildReviewReceipt({
        taskId: options.taskId,
        reviewType: options.reviewType,
        preflightSha256,
        scopeSha256,
        reviewScopeSha256,
        codeScopeSha256,
        reviewContextSha256: contextSha256,
        reviewTreeStateSha256: treeStateSha256,
        reviewExecutionMode: executionBindings.review_execution_mode,
        reviewExecutionContractSha256: executionBindings.review_execution_contract_sha256,
        reviewExecutionFullScopeSha256: executionBindings.review_execution_full_scope_sha256,
        reviewExecutionCompleteScopeLineageSha256:
            executionBindings.review_execution_complete_scope_lineage_sha256,
        reviewExecutionFindingReconciliationSha256:
            executionBindings.review_execution_finding_reconciliation_sha256,
        reviewArtifactSha256: artifactSha256,
        reviewerExecutionMode: 'delegated_subagent',
        reviewerIdentity: `agent:${options.taskId}-${options.reviewType}`,
        trustLevel: 'INDEPENDENT_AUDITED'
    }) as ReviewReceipt & Record<string, unknown>;
    const routingEventSha256 = 'c'.repeat(64);
    const invocationEventSha256 = 'd'.repeat(64);
    const reviewerIdentity = `agent:${options.taskId}-${options.reviewType}`;
    const launchPreparedAtUtc = '2026-05-19T10:00:00.000Z';
    const launchedAtUtc = '2026-05-19T10:00:05.000Z';
    const launchCompletedAtUtc = '2026-05-19T10:00:16.000Z';
    const invocationAttestedAtUtc = '2026-05-19T10:00:20.000Z';
    receipt.reviewer_provenance = {
        schema_version: 1,
        attestation_type: 'reviewer_invocation_attestation',
        controller_event_type: 'REVIEWER_INVOCATION_ATTESTED',
        task_sequence: 3,
        prev_event_sha256: routingEventSha256,
        event_sha256: invocationEventSha256,
        task_id: options.taskId,
        review_type: options.reviewType,
        reviewer_execution_mode: 'delegated_subagent',
        reviewer_identity: reviewerIdentity,
        review_context_sha256: contextSha256,
        review_tree_state_sha256: treeStateSha256,
        routing_event_sha256: routingEventSha256,
        launch_prepared_at_utc: launchPreparedAtUtc,
        delegation_started_at_utc: launchedAtUtc,
        launched_at_utc: launchedAtUtc,
        launch_completed_at_utc: launchCompletedAtUtc,
        invocation_attested_at_utc: invocationAttestedAtUtc
    };
    receipt.review_output_sha256 = artifactSha256;
    receipt.review_coverage = validation.coverage_validation;
    receipt.review_findings_validation = {
        artifact_path: validationArtifactPath.replace(/\\/gu, '/'),
        artifact_sha256: validationArtifactSha256,
        snapshot_path: null,
        snapshot_sha256: null,
        status: validationArtifact.validation_result.status,
        accepted: validationArtifact.validation_result.accepted,
        validation_result_sha256: validationArtifact.validation_result_sha256,
        violation_count: validationArtifact.validation_result.violations.length
    };
    receipt.review_output_contract = {
        schema_version: 1,
        format: 'findings_json',
        report_sha256: jsonSha256(validation.report),
        validation_artifact_sha256: validationArtifactSha256,
        validation_result_sha256: validationArtifact.validation_result_sha256,
        raw_output_sha256: artifactSha256,
        review_artifact_sha256: artifactSha256,
        review_context_sha256: contextSha256,
        review_tree_state_sha256: treeStateSha256,
        coverage_contract_sha256: coverageContract.contract_sha256,
        ...executionBindings,
        reviewer_identity: reviewerIdentity,
        reviewer_provenance_event_sha256: invocationEventSha256
    };
    const receiptPath = path.join(options.reviewsRoot, `${options.taskId}-${options.reviewType}-receipt.json`);
    writeJson(receiptPath, receipt);
    return {
        artifactPath,
        artifactSha256,
        context,
        contextPath,
        contextSha256,
        receipt,
        receiptPath,
        validationArtifactPath,
        delegationEvents: [{
            event_type: 'REVIEWER_DELEGATION_ROUTED',
            sequence: 2,
            details: {
                review_type: options.reviewType,
                reviewer_execution_mode: 'delegated_subagent',
                reviewer_session_id: reviewerIdentity
            },
            integrity: {
                schema_version: 1,
                task_sequence: 2,
                prev_event_sha256: null,
                event_sha256: routingEventSha256
            }
        }, {
            event_type: 'REVIEWER_INVOCATION_ATTESTED',
            sequence: 3,
            details: {
                task_id: options.taskId,
                review_type: options.reviewType,
                reviewer_execution_mode: 'delegated_subagent',
                reviewer_identity: reviewerIdentity,
                reviewer_session_id: reviewerIdentity,
                review_context_sha256: contextSha256,
                review_tree_state_sha256: treeStateSha256,
                routing_event_sha256: routingEventSha256,
                provider_invocation_id: `${options.taskId}-${options.reviewType}-invocation`,
                reviewer_launch_attestation_source: 'provider_native',
                launch_prepared_at_utc: launchPreparedAtUtc,
                delegation_started_at_utc: launchedAtUtc,
                launched_at_utc: launchedAtUtc,
                launch_completed_at_utc: launchCompletedAtUtc,
                invocation_attested_at_utc: invocationAttestedAtUtc
            },
            integrity: {
                schema_version: 1,
                task_sequence: 3,
                prev_event_sha256: routingEventSha256,
                event_sha256: invocationEventSha256
            }
        }]
    };
}

export function rewriteValidationExecutionBinding(options: {
    reviewPackage: Schema4ReviewPackage;
    field: string;
    value: unknown;
}): ReviewReceipt {
    const validationArtifact = JSON.parse(
        fs.readFileSync(options.reviewPackage.validationArtifactPath, 'utf8')
    ) as Record<string, unknown>;
    const validationResult = validationArtifact.validation_result as Record<string, unknown>;
    const bindings = validationResult.bindings as Record<string, unknown>;
    (bindings.execution as Record<string, unknown>)[options.field] = options.value;
    validationArtifact.validation_result_sha256 = sha256RedactedJsonPayload(validationResult);
    writeJson(options.reviewPackage.validationArtifactPath, validationArtifact);
    const validationArtifactSha256 = fileSha256(options.reviewPackage.validationArtifactPath);
    const receipt = JSON.parse(fs.readFileSync(options.reviewPackage.receiptPath, 'utf8')) as ReviewReceipt & Record<string, unknown>;
    Object.assign(receipt.review_output_contract as Record<string, unknown>, {
        validation_artifact_sha256: validationArtifactSha256,
        validation_result_sha256: validationArtifact.validation_result_sha256
    });
    Object.assign(receipt.review_findings_validation as Record<string, unknown>, {
        artifact_sha256: validationArtifactSha256,
        validation_result_sha256: validationArtifact.validation_result_sha256
    });
    writeJson(options.reviewPackage.receiptPath, receipt);
    return receipt;
}
