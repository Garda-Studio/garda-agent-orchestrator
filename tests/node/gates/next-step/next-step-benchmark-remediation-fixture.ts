import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { reviewsRoot as getReviewsRoot, fileSha256 } from './next-step-review-cycle-fixtures';
import { sha256RedactedJsonPayload } from '../../../../src/core/redaction';
import type { ReviewFindingsDispositionArtifact } from '../../../../src/gates/review/review-findings-disposition-artifact';
import type { ReviewFindingsValidationArtifact } from '../../../../src/gates/review/review-findings-validation-artifact';
import { buildReviewRemediationBaselineArtifact } from '../../../../src/gates/review-remediation/review-remediation-baseline';
import { classifyReviewRemediationDelta, type ReviewRemediationDeltaClassification } from '../../../../src/gates/review-remediation/review-remediation-delta';
import { buildReviewRemediationDeltaBase } from '../../../../src/gates/review-remediation/review-remediation-delta-contract';
import { buildDefaultReviewRemediationModePolicy } from '../../../../src/policy/review-remediation-mode-policy';

export function buildLeafTestDeltaClassification(options: {
    repoRoot: string;
    taskId: string;
    reviewType: string;
    changedFile: string;
    preflightPath: string;
    preflightSha256: string;
    profilePolicySnapshot: unknown;
    modePolicy?: ReturnType<typeof buildDefaultReviewRemediationModePolicy>;
}): ReviewRemediationDeltaClassification {
    const reviewsRoot = getReviewsRoot(options.repoRoot);
    writeRepoFile(options.repoRoot, options.changedFile, 'assert.equal(actual, expected);\n');
    const reviewArtifactPath = path.join(reviewsRoot, `${options.taskId}-${options.reviewType}.md`);
    const receiptPath = path.join(reviewsRoot, `${options.taskId}-${options.reviewType}-receipt.json`);
    const validationArtifactPath = path.join(
        reviewsRoot,
        `${options.taskId}-${options.reviewType}-findings-validation.json`
    );
    const dispositionArtifactPath = path.join(
        reviewsRoot,
        `${options.taskId}-${options.reviewType}-findings-disposition.json`
    );
    const baselinePath = path.join(
        reviewsRoot,
        `${options.taskId}-${options.reviewType}-remediation-baseline.json`
    );
    const treeSha256 = sha256RedactedJsonPayload({ task_id: options.taskId, tree: 'baseline' });
    const scopeSha256 = sha256RedactedJsonPayload({ changed_files: [options.changedFile] });
    const reviewScopeSha256 = sha256RedactedJsonPayload({ review_scope: [options.changedFile] });
    const contextSha256 = sha256RedactedJsonPayload({ review_type: options.reviewType });
    const finding = {
        id: 'F-001',
        severity: 'high' as const,
        title: 'Leaf-test assertion needs remediation',
        description: 'The focused assertion must be corrected and reviewed as an exact DELTA.',
        evidence_locations: [`${options.changedFile}:1`],
        coverage_obligation_ids: []
    };
    const validationResult = {
        status: 'accepted' as const,
        accepted: true,
        detected: true,
        violations: [],
        coverage_status: null,
        normalized_inventory: {
            finding_count: 1,
            residual_risk_count: 0,
            findings_by_severity: {
                critical: [],
                high: [finding],
                medium: [],
                low: []
            },
            residual_risks: []
        },
        evidence_diagnostics: {
            validation_note_evidence_locations: [],
            coverage_evidence_locations: [finding.evidence_locations[0]],
            finding_evidence_locations: [finding.evidence_locations[0]],
            residual_risk_evidence_locations: [],
            total_evidence_locations: 1
        },
        bindings: {
            input: { review_output_sha256: sha256RedactedJsonPayload('review-output') },
            output: {
                review_artifact_path: reviewArtifactPath.replace(/\\/gu, '/'),
                review_artifact_sha256: ''
            },
            context: {
                review_context_path: path.join(reviewsRoot, `${options.taskId}-${options.reviewType}-context.json`)
                    .replace(/\\/gu, '/'),
                review_context_sha256: contextSha256
            },
            scope: {
                preflight_path: options.preflightPath.replace(/\\/gu, '/'),
                preflight_sha256: options.preflightSha256,
                scope_sha256: scopeSha256,
                review_scope_sha256: reviewScopeSha256,
                code_scope_sha256: null
            },
            tree: { review_tree_state_sha256: treeSha256 },
            coverage_contract_sha256: sha256RedactedJsonPayload('coverage')
        }
    };
    fs.writeFileSync(reviewArtifactPath, 'authenticated failed test review\n', 'utf8');
    const reviewArtifactSha256 = fileSha256(reviewArtifactPath);
    assert.ok(reviewArtifactSha256);
    validationResult.bindings.output.review_artifact_sha256 = reviewArtifactSha256;
    const validationArtifact: ReviewFindingsValidationArtifact = {
        schema_version: 1,
        artifact_type: 'review_findings_validation',
        task_id: options.taskId,
        review_type: options.reviewType,
        validation_result: validationResult,
        validation_result_sha256: sha256RedactedJsonPayload(validationResult)
    };
    fs.writeFileSync(validationArtifactPath, `${JSON.stringify(validationArtifact, null, 2)}\n`, 'utf8');
    const validationArtifactSha256 = fileSha256(validationArtifactPath);
    assert.ok(validationArtifactSha256);
    const reviewFindingPolicy = {
        schema_version: 1 as const,
        policy_id: 'balanced' as const,
        findings: {
            critical: 'fix_now' as const,
            high: 'fix_now' as const,
            medium: 'create_follow_up' as const,
            low: 'create_follow_up' as const
        },
        residual_risk: 'create_follow_up' as const
    };
    const dispositionResult = {
        schema_version: 1 as const,
        policy_id: 'balanced' as const,
        policy_source: 'preflight_profile_policy_snapshot' as const,
        policy_diagnostics: [],
        findings: {
            critical: { action: 'fix_now' as const, ids: [], count: 0 },
            high: { action: 'fix_now' as const, ids: [finding.id], count: 1 },
            medium: { action: 'create_follow_up' as const, ids: [], count: 0 },
            low: { action: 'create_follow_up' as const, ids: [], count: 0 }
        },
        residual_risks: { action: 'create_follow_up' as const, ids: [], count: 0 },
        counts_by_action: { fix_now: 1, create_follow_up: 0, ignore: 0 },
        blocking_count: 1,
        blocking_ids: [finding.id],
        non_blocking_count: 0,
        total_count: 1,
        verdict: 'fail_for_fix_now' as const
    };
    const dispositionArtifact: ReviewFindingsDispositionArtifact = {
        schema_version: 1,
        artifact_type: 'review_findings_disposition',
        task_id: options.taskId,
        review_type: options.reviewType,
        derivation_source: 'garda_locked_policy_evaluation',
        source_validation: {
            artifact_path: validationArtifactPath.replace(/\\/gu, '/'),
            artifact_sha256: validationArtifactSha256,
            validation_result_sha256: validationArtifact.validation_result_sha256,
            status: 'accepted',
            accepted: true
        },
        policy: {
            policy_id: 'balanced',
            policy_source: 'preflight_profile_policy_snapshot',
            policy_diagnostics: [],
            review_finding_policy: reviewFindingPolicy
        },
        disposition_result: dispositionResult,
        disposition_result_sha256: sha256RedactedJsonPayload(dispositionResult),
        items: [{
            id: finding.id,
            kind: 'finding',
            severity: finding.severity,
            action: 'fix_now',
            source_rule: 'review_finding_policy.findings.high',
            policy_source: 'preflight_profile_policy_snapshot',
            blocking: true,
            materialization_status: 'requires_fix_now',
            audit_status: 'retained_in_disposition_artifact'
        }],
        summary: {
            item_count: 1,
            fix_now_count: 1,
            follow_up_pending_count: 0,
            ignored_count: 0,
            blocking_count: 1,
            non_blocking_count: 0
        }
    };
    fs.writeFileSync(dispositionArtifactPath, `${JSON.stringify(dispositionArtifact, null, 2)}\n`, 'utf8');
    const dispositionArtifactSha256 = fileSha256(dispositionArtifactPath);
    assert.ok(dispositionArtifactSha256);
    const receipt = {
        task_id: options.taskId,
        review_type: options.reviewType,
        review_artifact_sha256: reviewArtifactSha256,
        review_context_sha256: contextSha256,
        review_tree_state_sha256: treeSha256,
        review_findings_report_sha256: sha256RedactedJsonPayload('findings-report')
    };
    fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
    const receiptSha256 = fileSha256(receiptPath);
    assert.ok(receiptSha256);
    const deltaBase = buildReviewRemediationDeltaBase({
        repoRoot: options.repoRoot,
        taskId: options.taskId,
        reviewType: options.reviewType,
        reviewTreeStateSha256: treeSha256,
        changedFiles: [options.changedFile]
    });
    const baseline = buildReviewRemediationBaselineArtifact({
        taskId: options.taskId,
        reviewType: options.reviewType,
        reviewArtifactPath,
        reviewArtifactSha256,
        receiptPath,
        receiptSha256,
        receipt,
        validationArtifactPath,
        validationArtifactSha256,
        validationArtifact,
        dispositionArtifactPath,
        dispositionArtifactSha256,
        dispositionArtifact,
        profilePolicySnapshot: options.profilePolicySnapshot,
        deltaBase
    });
    fs.copyFileSync(receiptPath, baseline.bindings.receipt.snapshot_path);
    fs.copyFileSync(reviewArtifactPath, baseline.bindings.review_artifact.snapshot_path);
    fs.copyFileSync(validationArtifactPath, baseline.bindings.findings_validation.snapshot_path);
    fs.copyFileSync(dispositionArtifactPath, baseline.bindings.findings_disposition.snapshot_path);
    fs.writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`, 'utf8');
    const baselineSha256 = fileSha256(baselinePath);
    assert.ok(baselineSha256);
    writeRepoFile(
        options.repoRoot,
        options.changedFile,
        'assert.equal(actual, expected);\nassert.equal(receipt.mode, "DELTA");\n'
    );
    return classifyReviewRemediationDelta({
        repoRoot: options.repoRoot,
        taskId: options.taskId,
        reviewType: options.reviewType,
        baselineArtifactPath: baselinePath,
        baselineArtifactSha256: baselineSha256,
        currentChangedFiles: [options.changedFile],
        structuralTestChangedLinesThreshold: 20,
        modePolicy: options.modePolicy
    });
}

function writeRepoFile(repoRoot: string, relativePath: string, content: string): void {
    const filePath = path.join(repoRoot, ...relativePath.split('/'));
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
}
