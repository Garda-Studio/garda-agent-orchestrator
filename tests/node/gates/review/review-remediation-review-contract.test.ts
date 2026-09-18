import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';

import { sha256RedactedJsonPayload } from '../../../../src/core/redaction';
import {
    buildDefaultReviewRemediationRerunPolicy,
    resolveReviewRemediationRerunLanes
} from '../../../../src/policy/review-remediation-rerun-policy';
import { buildReviewCoverageContract } from '../../../../src/gates/review/review-coverage-ledger';
import type { ReviewFindingsDispositionArtifact } from '../../../../src/gates/review/review-findings-disposition-artifact';
import type { ReviewFindingsValidationArtifact } from '../../../../src/gates/review/review-findings-validation-artifact';
import {
    buildReviewRemediationReviewContract,
    buildReviewRemediationFindingReconciliation,
    getAuthenticatedBaselineReviewScopeViolation,
    getRemediationContractClassificationBindingViolations,
    getRemediationContractDecisionBindingViolation,
    getReviewRemediationFindingReconciliationViolations,
    getReviewRemediationReviewContractViolations,
    getReviewerRemediationCoverageViolations,
    type ReviewRemediationAuthoritativeDecisionBinding,
    type ReviewRemediationReviewContract
} from '../../../../src/gates/review-remediation/review-remediation-review-contract';
import type {
    ReviewRemediationBaselineArtifact
} from '../../../../src/gates/review-remediation/review-remediation-baseline';
import {
    buildReviewRemediationBaselineArtifact
} from '../../../../src/gates/review-remediation/review-remediation-baseline';
import {
    classifyReviewRemediationDelta,
    type ReviewRemediationDeltaClassification
} from '../../../../src/gates/review-remediation/review-remediation-delta';
import { buildReviewRemediationDeltaBase } from '../../../../src/gates/review-remediation/review-remediation-delta-contract';
import { buildReviewRemediationReadableDiffEvidence } from '../../../../src/gates/review-remediation/review-remediation-readable-diff';
import type {
    ReviewRemediationDecisionClassification
} from '../../../../src/gates/review-remediation/review-remediation-recovery-routing';

const TASK_ID = 'T-992-3-contract';
const REVIEW_TYPE = 'test';
const PREFLIGHT_SHA256 = 'a'.repeat(64);

function sha256Text(value: string): string {
    return createHash('sha256').update(value).digest('hex');
}

function fullContract(): ReviewRemediationReviewContract {
    return buildReviewRemediationReviewContract({
        taskId: TASK_ID,
        reviewType: REVIEW_TYPE,
        preflightSha256: PREFLIGHT_SHA256,
        fullReviewScope: ['src/app.ts', 'tests/app.test.ts']
    });
}

function decisionBinding(options: {
    mode: 'FULL' | 'DELTA';
    preflightSha256?: string;
    classificationSha256?: string;
}): ReviewRemediationAuthoritativeDecisionBinding {
    const classificationSource = options.mode === 'FULL' ? 'runtime_fix' as const : 'delta' as const;
    const defaultClassificationSha256 = classificationSource === 'runtime_fix'
        ? sha256RedactedJsonPayload(runtimeFixClassification().classification)
        : deltaClassification().classification_sha256;
    const laneWithoutHash = {
        review_type: REVIEW_TYPE,
        mode: options.mode,
        reuse_eligible: false,
        satisfied: false,
        satisfaction_source: null,
        invalidated: true,
        depends_on: [],
        invalidated_downstream_review_types: [],
        reason_code: 'remediation-required',
        reason: 'Current review evidence must be regenerated.'
    };
    const withoutHash = {
        schema_version: 1 as const,
        status: 'READY' as const,
        task_id: TASK_ID,
        current_review_type: REVIEW_TYPE,
        preflight_sha256: options.preflightSha256 ?? PREFLIGHT_SHA256,
        classification_source: classificationSource,
        classification_sha256: options.classificationSha256 ?? defaultClassificationSha256,
        category: 'production',
        profile_policy_snapshot_sha256: null,
        policy_id: 'test-policy',
        policy_legacy_fallback: false,
        invalidated_review_types: [REVIEW_TYPE],
        preserved_review_types: [],
        reused_review_types: [],
        satisfied_review_types: [],
        rejected_reuse_review_types: [],
        dependency_edges: [{ review_type: REVIEW_TYPE, depends_on: [] }],
        lane_decisions: [{
            ...laneWithoutHash,
            reason_sha256: sha256RedactedJsonPayload(laneWithoutHash)
        }],
        blocked_reasons: []
    };
    return {
        ...withoutHash,
        decision_sha256: sha256RedactedJsonPayload(withoutHash)
    };
}

function validationAuthority(options: {
    mode: 'FULL' | 'DELTA';
    decision?: ReviewRemediationAuthoritativeDecisionBinding | null;
    classification?: ReviewRemediationDecisionClassification | null;
    taskId?: string;
    reviewType?: string;
    preflightSha256?: string;
    fullReviewScope?: readonly string[];
}) {
    const decision = options.decision ?? null;
    const classification = options.classification
        ?? (decision?.classification_source === 'runtime_fix'
            ? runtimeFixClassification()
            : decision?.classification_source === 'delta'
                ? {
                    source: 'delta' as const,
                    delta: deltaClassification(),
                    profilePolicySnapshot: null,
                    baselineProfilePolicySnapshotSha256: '8'.repeat(64)
                }
                : null);
    return {
        taskId: options.taskId ?? TASK_ID,
        reviewType: options.reviewType ?? REVIEW_TYPE,
        preflightSha256: options.preflightSha256 ?? PREFLIGHT_SHA256,
        mode: options.mode,
        fullReviewScope: options.fullReviewScope ?? ['src/app.ts', 'tests/app.test.ts'],
        persistedDecisionSha256: decision?.decision_sha256 ?? null,
        authoritativeDecisionSha256: decision?.decision_sha256 ?? null,
        authoritativeClassificationSha256: decision?.classification_sha256 ?? null,
        authoritativeDecision: decision,
        authoritativeClassification: classification
    };
}

function runtimeFixClassification(): Extract<ReviewRemediationDecisionClassification, { source: 'runtime_fix' }> {
    return {
        source: 'runtime_fix',
        classification: {
            category: 'production',
            reason: 'Runtime contract remediation fixture.',
            blocked_before_reuse: true,
            invalidated_review_types: [REVIEW_TYPE]
        }
    };
}

function deltaClassification(): ReviewRemediationDeltaClassification {
    const core: Omit<ReviewRemediationDeltaClassification, 'classification_sha256'> = {
        schema_version: 1,
        task_id: TASK_ID,
        review_type: REVIEW_TYPE,
        status: 'CLASSIFIED',
        category: 'production',
        reason: 'Production remediation fixture.',
        baseline: {
            artifact_path: 'runtime/reviews/remediation-baseline.json',
            artifact_sha256: '3'.repeat(64),
            review_tree_state_sha256: '4'.repeat(64),
            delta_base_snapshot_sha256: '5'.repeat(64)
        },
        current_snapshot_sha256: '6'.repeat(64),
        full_review_required: false,
        full_review_reasons: [],
        scope: {
            full_review_scope: [],
            full_review_scope_sha256: sha256Text(''),
            required_delta_targets: [],
            required_delta_targets_sha256: sha256Text(''),
            optional_context_files: [],
            optional_context_files_sha256: sha256Text(''),
            membership_unchanged: true
        },
        changed_files: [],
        unchanged_files: [],
        file_deltas: [],
        additions_total: 0,
        deletions_total: 0,
        changed_lines_total: 0,
        readable_diff: buildReviewRemediationReadableDiffEvidence([])
    };
    return {
        ...core,
        classification_sha256: sha256RedactedJsonPayload(core)
    };
}

function rehash(contract: ReviewRemediationReviewContract): ReviewRemediationReviewContract {
    const completeScopeLineageSha256 = sha256RedactedJsonPayload({
        task_id: contract.task_id,
        review_type: contract.review_type,
        mode: contract.mode,
        preflight_sha256: contract.preflight_sha256,
        full_review_scope_sha256: contract.full_review_scope_sha256,
        authoritative_decision_sha256: contract.authoritative_decision_sha256,
        classification_sha256: contract.classification_sha256,
        base: contract.base,
        delta: contract.delta,
        finding_reconciliation: contract.finding_reconciliation
    });
    const withoutHash = {
        ...contract,
        complete_scope_lineage_sha256: completeScopeLineageSha256
    } as unknown as Record<string, unknown>;
    delete withoutHash.contract_sha256;
    return {
        ...contract,
        complete_scope_lineage_sha256: completeScopeLineageSha256,
        contract_sha256: sha256RedactedJsonPayload(withoutHash)
    };
}

function rehashDecision(
    decision: ReviewRemediationAuthoritativeDecisionBinding,
    changes: Partial<ReviewRemediationAuthoritativeDecisionBinding>
): ReviewRemediationAuthoritativeDecisionBinding {
    const withoutHash = { ...decision, ...changes } as Record<string, unknown>;
    delete withoutHash.decision_sha256;
    return {
        ...decision,
        ...changes,
        decision_sha256: sha256RedactedJsonPayload(withoutHash)
    };
}

function writeJson(filePath: string, payload: unknown): string {
    fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function createAuthenticatedDeltaFixture(options: {
    changedFile?: 'source' | 'test';
    withFileObligation?: boolean;
    withOriginCoverage?: boolean;
    findingEvidence?: string[];
    fileObligationIds?: string[];
} = {}): {
    root: string;
    delta: ReviewRemediationDeltaClassification;
} {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-contract-'));
    const reviewArtifactPath = path.join(root, `${TASK_ID}-${REVIEW_TYPE}.md`);
    const receiptPath = path.join(root, `${TASK_ID}-${REVIEW_TYPE}-receipt.json`);
    const validationArtifactPath = path.join(root, `${TASK_ID}-${REVIEW_TYPE}-validation.json`);
    const dispositionArtifactPath = path.join(root, `${TASK_ID}-${REVIEW_TYPE}-disposition.json`);
    const contextSha256 = sha256Text('context');
    const treeSha256 = sha256Text('tree');
    const scopeSha256 = sha256Text('scope');
    const reviewScopeSha256 = sha256Text('review-scope');
    const reviewArtifactSha256 = sha256Text('review-artifact');
    const findingsReportSha256 = sha256Text('findings-report');
    const profilePolicySnapshotSha256 = sha256Text('profile-policy-snapshot');
    const originCoverageContract = buildReviewCoverageContract({
        reviewType: REVIEW_TYPE,
        changedFiles: ['src/app.ts']
    });
    const sourcePath = path.join(root, 'src', 'app.ts');
    const testPath = path.join(root, 'tests', 'app.test.ts');
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
    fs.mkdirSync(path.dirname(testPath), { recursive: true });
    fs.writeFileSync(sourcePath, 'export const value = 1;\n', 'utf8');
    fs.writeFileSync(testPath, 'assert.equal(value, 1);\n', 'utf8');
    fs.writeFileSync(reviewArtifactPath, 'review-artifact', 'utf8');

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
                high: [{
                    id: 'F-001',
                    severity: 'high' as const,
                    title: 'Bound source defect',
                    description: 'The source change resolves the authenticated finding.',
                    evidence_locations: options.findingEvidence ?? ['src/app.ts:1'],
                    coverage_obligation_ids: options.fileObligationIds ?? (options.withFileObligation ? ['FILE-001'] : [])
                }],
                medium: [],
                low: []
            },
            residual_risks: []
        },
        evidence_diagnostics: {
            validation_note_evidence_locations: [],
            coverage_evidence_locations: ['src/app.ts:1'],
            finding_evidence_locations: ['src/app.ts:1'],
            residual_risk_evidence_locations: [],
            total_evidence_locations: 1
        },
        bindings: {
            input: { review_output_sha256: sha256Text('output') },
            output: {
                review_artifact_path: reviewArtifactPath.replace(/\\/gu, '/'),
                review_artifact_sha256: reviewArtifactSha256
            },
            context: {
                review_context_path: path.join(root, 'context.json').replace(/\\/gu, '/'),
                review_context_sha256: contextSha256
            },
            scope: {
                preflight_path: path.join(root, 'preflight.json').replace(/\\/gu, '/'),
                preflight_sha256: PREFLIGHT_SHA256,
                scope_sha256: scopeSha256,
                review_scope_sha256: reviewScopeSha256,
                code_scope_sha256: null
            },
            tree: { review_tree_state_sha256: treeSha256 },
            coverage_contract_sha256: originCoverageContract.contract_sha256
        }
    };
    const validationArtifact: ReviewFindingsValidationArtifact = {
        schema_version: 1,
        artifact_type: 'review_findings_validation',
        task_id: TASK_ID,
        review_type: REVIEW_TYPE,
        validation_result: validationResult,
        validation_result_sha256: sha256RedactedJsonPayload(validationResult)
    };
    const validationArtifactSha256 = writeJson(validationArtifactPath, validationArtifact);
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
            high: { action: 'fix_now' as const, ids: ['F-001'], count: 1 },
            medium: { action: 'create_follow_up' as const, ids: [], count: 0 },
            low: { action: 'create_follow_up' as const, ids: [], count: 0 }
        },
        residual_risks: { action: 'create_follow_up' as const, ids: [], count: 0 },
        counts_by_action: { fix_now: 1, create_follow_up: 0, ignore: 0 },
        blocking_count: 1,
        blocking_ids: ['F-001'],
        non_blocking_count: 0,
        total_count: 1,
        verdict: 'fail_for_fix_now' as const
    };
    const dispositionArtifact: ReviewFindingsDispositionArtifact = {
        schema_version: 1,
        artifact_type: 'review_findings_disposition',
        task_id: TASK_ID,
        review_type: REVIEW_TYPE,
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
            id: 'F-001',
            kind: 'finding',
            severity: 'high',
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
    const dispositionArtifactSha256 = writeJson(dispositionArtifactPath, dispositionArtifact);
    const receipt = {
        task_id: TASK_ID,
        review_type: REVIEW_TYPE,
        review_artifact_sha256: reviewArtifactSha256,
        review_context_sha256: contextSha256,
        review_tree_state_sha256: treeSha256,
        review_findings_report_sha256: findingsReportSha256
    };
    const receiptSha256 = writeJson(receiptPath, receipt);
    const deltaBase = buildReviewRemediationDeltaBase({
        repoRoot: root,
        taskId: TASK_ID,
        reviewType: REVIEW_TYPE,
        reviewTreeStateSha256: treeSha256,
        changedFiles: ['src/app.ts', 'tests/app.test.ts']
    });
    const baseline = buildReviewRemediationBaselineArtifact({
        taskId: TASK_ID,
        reviewType: REVIEW_TYPE,
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
        profilePolicySnapshot: { snapshot_hash: profilePolicySnapshotSha256 },
        ...(options.withOriginCoverage ? { originCoverageContract } : {}),
        deltaBase
    });
    fs.copyFileSync(receiptPath, baseline.bindings.receipt.snapshot_path);
    fs.copyFileSync(reviewArtifactPath, baseline.bindings.review_artifact.snapshot_path);
    fs.copyFileSync(validationArtifactPath, baseline.bindings.findings_validation.snapshot_path);
    fs.copyFileSync(dispositionArtifactPath, baseline.bindings.findings_disposition.snapshot_path);
    const baselinePath = path.join(root, `${TASK_ID}-${REVIEW_TYPE}-remediation-baseline.json`);
    const baselineSha256 = writeJson(baselinePath, baseline);

    if (options.changedFile === 'test') {
        fs.writeFileSync(testPath, 'assert.equal(value, 2);\n', 'utf8');
    } else {
        fs.writeFileSync(sourcePath, 'export const value = 2;\n', 'utf8');
    }
    return {
        root,
        delta: classifyReviewRemediationDelta({
            repoRoot: root,
            taskId: TASK_ID,
            reviewType: REVIEW_TYPE,
            baselineArtifactPath: baselinePath,
            baselineArtifactSha256: baselineSha256,
            currentChangedFiles: ['src/app.ts', 'tests/app.test.ts']
        })
    };
}

function reconciliationBaseline(): ReviewRemediationBaselineArtifact {
    return {
        accepted_findings: [{
            id: 'F-001',
            severity: 'high',
            title: 'Single-file finding',
            description: 'Covered by one exact delta target.',
            evidence_locations: ['src/covered.ts:10'],
            coverage_obligation_ids: []
        }, {
            id: 'F-002',
            severity: 'high',
            title: 'Multi-file finding',
            description: 'Requires both evidence files to be covered.',
            evidence_locations: ['src/covered.ts:20', 'src/uncovered.ts:30'],
            coverage_obligation_ids: []
        }],
        fix_now_items: [{
            id: 'F-002',
            kind: 'finding',
            severity: 'high',
            action: 'fix_now',
            source_rule: 'review_finding_policy.findings.high',
            evidence_locations: ['src/covered.ts:20', 'src/uncovered.ts:30']
        }],
        delta_base: {
            changed_files: ['src/covered.ts', 'src/uncovered.ts']
        }
    } as unknown as ReviewRemediationBaselineArtifact;
}

describe('review remediation FULL/DELTA execution contract', () => {
    it('builds a deterministic explicit FULL contract with complete-scope lineage', () => {
        const first = fullContract();
        const second = fullContract();

        assert.deepEqual(first, second);
        assert.equal(first.mode, 'FULL');
        assert.equal(first.source, 'initial_full');
        assert.equal(first.base, null);
        assert.equal(first.delta, null);
        assert.deepEqual(first.full_review_scope, ['src/app.ts', 'tests/app.test.ts']);
        assert.deepEqual(getReviewRemediationReviewContractViolations(
            first,
            validationAuthority({ mode: 'FULL' })
        ), []);
    });

    it('builds and validates remediation FULL evidence with canonical reviewer coverage', () => {
        const decision = decisionBinding({ mode: 'FULL' });
        const classification = runtimeFixClassification();
        const contract = buildReviewRemediationReviewContract({
            taskId: TASK_ID,
            reviewType: REVIEW_TYPE,
            preflightSha256: PREFLIGHT_SHA256,
            fullReviewScope: ['src/app.ts', 'tests/app.test.ts'],
            authoritativeDecision: decision,
            classification
        });

        assert.equal(contract.mode, 'FULL');
        assert.equal(contract.source, 'remediation_full');
        assert.deepEqual(getReviewRemediationReviewContractViolations(
            contract,
            validationAuthority({ mode: 'FULL', decision, classification })
        ), []);
        assert.deepEqual(getReviewerRemediationCoverageViolations({
            mode: 'FULL',
            contract_sha256: contract.contract_sha256,
            covered_delta_targets: [],
            inspected_prior_finding_ids: []
        }, contract), []);
    });

    it('rejects missing or corrupted authoritative runtime-fix classification payloads', () => {
        const decision = decisionBinding({ mode: 'FULL' });
        const classification = runtimeFixClassification();
        const contract = buildReviewRemediationReviewContract({
            taskId: TASK_ID,
            reviewType: REVIEW_TYPE,
            preflightSha256: PREFLIGHT_SHA256,
            fullReviewScope: ['src/app.ts', 'tests/app.test.ts'],
            authoritativeDecision: decision,
            classification
        });

        const missingPayloadViolations = getReviewRemediationReviewContractViolations(
            contract,
            validationAuthority({
                mode: 'FULL',
                decision,
                classification: {
                    ...classification,
                    classification: null
                } as unknown as ReviewRemediationDecisionClassification
            })
        );
        assert.ok(missingPayloadViolations.some((entry) => (
            entry.includes('runtime-fix classification payload is missing')
        )));

        const corruptedPayloadViolations = getReviewRemediationReviewContractViolations(
            contract,
            validationAuthority({
                mode: 'FULL',
                decision,
                classification: {
                    ...classification,
                    classification: {
                        ...classification.classification,
                        reason: 'Corrupted runtime-fix classification.'
                    }
                }
            })
        );
        assert.ok(corruptedPayloadViolations.some((entry) => (
            entry.includes('runtime-fix classification hash does not match')
        )));
    });

    it('builds and validates remediation FULL fallback from a full-review-required DELTA classification', () => {
        const fixture = createAuthenticatedDeltaFixture();
        try {
            const { classification_sha256: _, ...deltaCore } = fixture.delta;
            const fullDeltaCore = {
                ...deltaCore,
                full_review_required: true,
                full_review_reasons: ['Authenticated remediation requires a complete review.']
            };
            const fullDelta: ReviewRemediationDeltaClassification = {
                ...fullDeltaCore,
                classification_sha256: sha256RedactedJsonPayload(fullDeltaCore)
            };
            const decision = rehashDecision(decisionBinding({
                mode: 'FULL',
                classificationSha256: fullDelta.classification_sha256
            }), { classification_source: 'delta' });
            const classification: ReviewRemediationDecisionClassification = {
                source: 'delta',
                delta: fullDelta,
                profilePolicySnapshot: null,
                baselineProfilePolicySnapshotSha256: '8'.repeat(64)
            };
            const contract = buildReviewRemediationReviewContract({
                taskId: TASK_ID,
                reviewType: REVIEW_TYPE,
                preflightSha256: PREFLIGHT_SHA256,
                fullReviewScope: ['src/app.ts', 'tests/app.test.ts'],
                authoritativeDecision: decision,
                classification
            });

            assert.equal(contract.mode, 'FULL');
            assert.equal(contract.source, 'remediation_full');
            assert.equal(contract.base, null);
            assert.equal(contract.delta, null);
            assert.deepEqual(getReviewRemediationReviewContractViolations(
                contract,
                validationAuthority({ mode: 'FULL', decision, classification })
            ), []);
        } finally {
            fs.rmSync(fixture.root, { recursive: true, force: true });
        }
    });

    it('rejects missing task and review-lane identities at construction and validation boundaries', () => {
        assert.throws(() => buildReviewRemediationReviewContract({
            taskId: '',
            reviewType: REVIEW_TYPE,
            preflightSha256: PREFLIGHT_SHA256,
            fullReviewScope: []
        }), /requires a non-empty task id/u);
        assert.throws(() => buildReviewRemediationReviewContract({
            taskId: TASK_ID,
            reviewType: '',
            preflightSha256: PREFLIGHT_SHA256,
            fullReviewScope: []
        }), /requires a canonical review type/u);

        const forged = rehash({
            ...fullContract(),
            task_id: '',
            review_type: ''
        });
        const violations = getReviewRemediationReviewContractViolations(
            forged,
            validationAuthority({ mode: 'FULL' })
        );
        assert.ok(violations.some((entry) => entry.includes('task_id must be non-empty')));
        assert.ok(violations.some((entry) => entry.includes('review_type must be non-empty')));
    });

    it('rejects a stale-preflight authoritative decision before building a contract', () => {
        assert.throws(() => buildReviewRemediationReviewContract({
            taskId: TASK_ID,
            reviewType: REVIEW_TYPE,
            preflightSha256: PREFLIGHT_SHA256,
            fullReviewScope: ['src/app.ts', 'tests/app.test.ts'],
            authoritativeDecision: decisionBinding({
                mode: 'FULL',
                preflightSha256: '9'.repeat(64)
            })
        }), /decision preflight_sha256 is stale/u);
    });

    it('requires decision and classification authority together at construction', () => {
        const decision = decisionBinding({ mode: 'FULL' });
        assert.throws(() => buildReviewRemediationReviewContract({
            taskId: TASK_ID,
            reviewType: REVIEW_TYPE,
            preflightSha256: PREFLIGHT_SHA256,
            fullReviewScope: ['src/app.ts'],
            authoritativeDecision: decision
        }), /requires decision and classification authority together/u);
        assert.throws(() => buildReviewRemediationReviewContract({
            taskId: TASK_ID,
            reviewType: REVIEW_TYPE,
            preflightSha256: PREFLIGHT_SHA256,
            fullReviewScope: ['src/app.ts'],
            classification: runtimeFixClassification()
        }), /requires decision and classification authority together/u);
    });

    it('does not build a fresh review contract for a REUSE lane decision', () => {
        const decision = decisionBinding({ mode: 'FULL' });
        const laneWithoutHash = {
            ...decision.lane_decisions[0],
            mode: 'REUSE' as const
        };
        const { reason_sha256: _, ...laneCore } = laneWithoutHash;
        const reuseDecision = rehashDecision(decision, {
            lane_decisions: [{
                ...laneCore,
                reason_sha256: sha256RedactedJsonPayload(laneCore)
            }]
        });

        assert.throws(() => buildReviewRemediationReviewContract({
            taskId: TASK_ID,
            reviewType: REVIEW_TYPE,
            preflightSha256: PREFLIGHT_SHA256,
            fullReviewScope: ['src/app.ts'],
            authoritativeDecision: reuseDecision,
            classification: runtimeFixClassification()
        }), /cannot be built for lane mode 'REUSE'/u);
    });

    it('rejects a foreign-lane DELTA classification before reading its baseline', () => {
        const source = deltaClassification();
        const { classification_sha256: _, ...foreignCore } = {
            ...source,
            review_type: 'code'
        };
        const foreign = {
            ...foreignCore,
            classification_sha256: sha256RedactedJsonPayload(foreignCore)
        };
        assert.throws(() => buildReviewRemediationReviewContract({
            taskId: TASK_ID,
            reviewType: REVIEW_TYPE,
            preflightSha256: PREFLIGHT_SHA256,
            fullReviewScope: [],
            authoritativeDecision: decisionBinding({
                mode: 'DELTA',
                classificationSha256: foreign.classification_sha256
            }),
            classification: {
                source: 'delta',
                delta: foreign,
                profilePolicySnapshot: null,
                baselineProfilePolicySnapshotSha256: '8'.repeat(64)
            }
        }), /does not match the current task, review lane, or authoritative decision/u);
    });

    it('rejects a forged DELTA payload that preserves its self-declared classification hash', () => {
        const delta = deltaClassification();
        const forged = {
            ...delta,
            current_snapshot_sha256: '7'.repeat(64)
        };
        assert.throws(() => buildReviewRemediationReviewContract({
            taskId: TASK_ID,
            reviewType: REVIEW_TYPE,
            preflightSha256: PREFLIGHT_SHA256,
            fullReviewScope: [],
            authoritativeDecision: decisionBinding({
                mode: 'DELTA',
                classificationSha256: delta.classification_sha256
            }),
            classification: { source: 'delta', delta: forged, profilePolicySnapshot: null, baselineProfilePolicySnapshotSha256: '8'.repeat(64) }
        }), /classification is invalid:.*classification_sha256 does not match the delta payload/u);
    });

    it('builds and validates an authenticated DELTA contract end to end', () => {
        const fixture = createAuthenticatedDeltaFixture();
        try {
            assert.equal(fixture.delta.full_review_required, false);
            assert.deepEqual(fixture.delta.scope.required_delta_targets, ['src/app.ts']);
            const decision = decisionBinding({
                mode: 'DELTA',
                classificationSha256: fixture.delta.classification_sha256
            });
            const contract = buildReviewRemediationReviewContract({
                taskId: TASK_ID,
                reviewType: REVIEW_TYPE,
                preflightSha256: PREFLIGHT_SHA256,
                fullReviewScope: ['src/app.ts', 'tests/app.test.ts'],
                authoritativeDecision: decision,
                classification: {
                    source: 'delta',
                    delta: fixture.delta,
                    profilePolicySnapshot: null,
                    baselineProfilePolicySnapshotSha256: '8'.repeat(64)
                }
            });

            assert.equal(contract.mode, 'DELTA');
            assert.equal(contract.source, 'remediation_delta');
            assert.deepEqual(contract.delta?.required_delta_targets, ['src/app.ts']);
            assert.deepEqual(contract.finding_reconciliation.resolvable_finding_ids, ['F-001']);
            assert.deepEqual(getReviewRemediationReviewContractViolations(
                contract,
                validationAuthority({
                    mode: 'DELTA',
                    decision,
                    classification: {
                        source: 'delta',
                        delta: fixture.delta,
                        profilePolicySnapshot: null,
                        baselineProfilePolicySnapshotSha256: '8'.repeat(64)
                    }
                })
            ), []);
        } finally {
            fs.rmSync(fixture.root, { recursive: true, force: true });
        }
    });

    it('rejects forged FULL evidence relabeled as DELTA without authenticated base lineage', () => {
        const forged = rehash({
            ...fullContract(),
            mode: 'DELTA',
            source: 'remediation_delta'
        });
        const violations = getReviewRemediationReviewContractViolations(
            forged,
            validationAuthority({ mode: 'DELTA', decision: decisionBinding({ mode: 'DELTA' }) })
        );

        assert.ok(violations.some((entry) => entry.includes('requires base and delta lineage')));
    });

    it('rejects a coherently rehashed remediation FULL contract without classification lineage', () => {
        const decision = decisionBinding({ mode: 'FULL' });
        const contract = buildReviewRemediationReviewContract({
            taskId: TASK_ID,
            reviewType: REVIEW_TYPE,
            preflightSha256: PREFLIGHT_SHA256,
            fullReviewScope: ['src/app.ts', 'tests/app.test.ts'],
            authoritativeDecision: decision,
            classification: runtimeFixClassification()
        });
        const forged = rehash({
            ...contract,
            classification_sha256: null
        });

        const violations = getReviewRemediationReviewContractViolations(
            forged,
            validationAuthority({ mode: 'FULL', decision })
        );

        assert.ok(violations.some((entry) => entry.includes('classification_sha256 is required')));
    });

    it('rejects a coherently rehashed remediation FULL contract downgraded to initial FULL', () => {
        const decision = decisionBinding({ mode: 'FULL' });
        const contract = buildReviewRemediationReviewContract({
            taskId: TASK_ID,
            reviewType: REVIEW_TYPE,
            preflightSha256: PREFLIGHT_SHA256,
            fullReviewScope: ['src/app.ts', 'tests/app.test.ts'],
            authoritativeDecision: decision,
            classification: runtimeFixClassification()
        });
        const forged = rehash({
            ...contract,
            source: 'initial_full',
            authoritative_decision_sha256: null,
            classification_sha256: null
        });

        const violations = getReviewRemediationReviewContractViolations(
            forged,
            validationAuthority({ mode: 'FULL', decision })
        );

        assert.ok(violations.some((entry) => entry.includes("source must be 'remediation_full'")));
        assert.ok(violations.some((entry) => entry.includes('not bound to the final authoritative lane decision')));
    });

    it('rejects a coherently rehashed contract paired with a stale authoritative decision preflight', () => {
        const currentDecision = decisionBinding({ mode: 'FULL' });
        const staleDecision = decisionBinding({ mode: 'FULL', preflightSha256: '9'.repeat(64) });
        const contract = buildReviewRemediationReviewContract({
            taskId: TASK_ID,
            reviewType: REVIEW_TYPE,
            preflightSha256: PREFLIGHT_SHA256,
            fullReviewScope: ['src/app.ts', 'tests/app.test.ts'],
            authoritativeDecision: currentDecision,
            classification: runtimeFixClassification()
        });
        const forged = rehash({
            ...contract,
            authoritative_decision_sha256: staleDecision.decision_sha256
        });

        const violations = getReviewRemediationReviewContractViolations(
            forged,
            validationAuthority({ mode: 'FULL', decision: staleDecision })
        );

        assert.ok(violations.some((entry) => entry.includes('stale decision preflight_sha256')));
    });

    it('rejects validation authority whose selected lane mode differs from the expected mode', () => {
        const decision = decisionBinding({ mode: 'FULL' });
        const contract = buildReviewRemediationReviewContract({
            taskId: TASK_ID,
            reviewType: REVIEW_TYPE,
            preflightSha256: PREFLIGHT_SHA256,
            fullReviewScope: ['src/app.ts', 'tests/app.test.ts'],
            authoritativeDecision: decision,
            classification: runtimeFixClassification()
        });

        const violations = getReviewRemediationReviewContractViolations(
            contract,
            validationAuthority({ mode: 'DELTA', decision })
        );

        assert.ok(violations.some((entry) => entry.includes("lane mode 'FULL' does not match expected 'DELTA'")));
    });

    it('rejects a blocked authoritative remediation decision', () => {
        const readyDecision = decisionBinding({ mode: 'FULL' });
        const blockedDecision = rehashDecision(readyDecision, { status: 'BLOCKED' });
        const contract = buildReviewRemediationReviewContract({
            taskId: TASK_ID,
            reviewType: REVIEW_TYPE,
            preflightSha256: PREFLIGHT_SHA256,
            fullReviewScope: ['src/app.ts', 'tests/app.test.ts'],
            authoritativeDecision: readyDecision,
            classification: runtimeFixClassification()
        });
        const forged = rehash({
            ...contract,
            authoritative_decision_sha256: blockedDecision.decision_sha256
        });

        const violations = getReviewRemediationReviewContractViolations(
            forged,
            validationAuthority({ mode: 'FULL', decision: blockedDecision })
        );

        assert.ok(violations.some((entry) => entry.includes('decision must be READY')));
    });

    it('rejects an authoritative DELTA classification from another task', () => {
        const current = deltaClassification();
        const { classification_sha256: _, ...foreignCore } = { ...current, task_id: 'T-foreign' };
        const foreign = {
            ...foreignCore,
            classification_sha256: sha256RedactedJsonPayload(foreignCore)
        };
        const decision = decisionBinding({
            mode: 'DELTA',
            classificationSha256: foreign.classification_sha256
        });
        const forged = rehash({
            ...fullContract(),
            mode: 'DELTA',
            source: 'remediation_delta',
            authoritative_decision_sha256: decision.decision_sha256,
            classification_sha256: foreign.classification_sha256
        });

        const violations = getReviewRemediationReviewContractViolations(forged, validationAuthority({
            mode: 'DELTA',
            decision,
            classification: {
                source: 'delta',
                delta: foreign,
                profilePolicySnapshot: null,
                baselineProfilePolicySnapshotSha256: '8'.repeat(64)
            }
        }));

        assert.ok(violations.some((entry) => entry.includes('authoritative task and review lane')));
    });

    it('rejects coherently rehashed contracts with unrecognized fields', () => {
        const forged = rehash({
            ...fullContract(),
            unexpected_parser_state: true
        } as ReviewRemediationReviewContract);

        const violations = getReviewRemediationReviewContractViolations(
            forged,
            validationAuthority({ mode: 'FULL' })
        );

        assert.ok(violations.some((entry) => entry.includes('exactly the canonical top-level fields')));
    });

    it('rejects a substituted baseline identity before dereferencing its path', () => {
        const fixture = createAuthenticatedDeltaFixture();
        try {
            const decision = decisionBinding({
                mode: 'DELTA',
                classificationSha256: fixture.delta.classification_sha256
            });
            const contract = buildReviewRemediationReviewContract({
                taskId: TASK_ID,
                reviewType: REVIEW_TYPE,
                preflightSha256: PREFLIGHT_SHA256,
                fullReviewScope: ['src/app.ts', 'tests/app.test.ts'],
                authoritativeDecision: decision,
                classification: {
                    source: 'delta',
                    delta: fixture.delta,
                    profilePolicySnapshot: null,
                    baselineProfilePolicySnapshotSha256: '8'.repeat(64)
                }
            });
            const forged = rehash({
                ...contract,
                base: contract.base
                    ? { ...contract.base, baseline_artifact_path: path.join(fixture.root, 'must-not-be-read.json') }
                    : null
            });
            const violations = getReviewRemediationReviewContractViolations(forged, validationAuthority({
                mode: 'DELTA',
                decision,
                classification: {
                    source: 'delta',
                    delta: fixture.delta,
                    profilePolicySnapshot: null,
                    baselineProfilePolicySnapshotSha256: '8'.repeat(64)
                }
            }));

            assert.ok(violations.some((entry) => entry.includes('classification baseline identity')));
            assert.ok(!violations.some((entry) => entry.includes('base lineage is invalid')));
        } finally {
            fs.rmSync(fixture.root, { recursive: true, force: true });
        }
    });

    it('returns fail-closed violations for malformed DELTA scope lists instead of throwing', () => {
        const contract = fullContract();
        const decision = decisionBinding({ mode: 'DELTA' });
        const malformed = {
            source: 'delta',
            delta: {
                ...deltaClassification(),
                scope: {}
            }
        };

        assert.doesNotThrow(() => getRemediationContractClassificationBindingViolations(
            contract,
            decision,
            malformed
        ));
        assert.ok(getRemediationContractClassificationBindingViolations(
            contract,
            decision,
            malformed
        ).some((entry) => entry.includes('classification is invalid')));
    });

    it('returns fail-closed violations for malformed authority lanes and DELTA base objects', () => {
        const validDecision = decisionBinding({ mode: 'FULL' });
        const malformedDecision = rehashDecision(validDecision, {
            lane_decisions: [null] as unknown as ReviewRemediationAuthoritativeDecisionBinding['lane_decisions']
        });
        const contract = buildReviewRemediationReviewContract({
            taskId: TASK_ID,
            reviewType: REVIEW_TYPE,
            preflightSha256: PREFLIGHT_SHA256,
            fullReviewScope: ['src/app.ts', 'tests/app.test.ts'],
            authoritativeDecision: validDecision,
            classification: runtimeFixClassification()
        });
        const rebound = rehash({
            ...contract,
            authoritative_decision_sha256: malformedDecision.decision_sha256
        });
        assert.doesNotThrow(() => getReviewRemediationReviewContractViolations(
            rebound,
            validationAuthority({ mode: 'FULL', decision: malformedDecision })
        ));
        assert.ok(getReviewRemediationReviewContractViolations(
            rebound,
            validationAuthority({ mode: 'FULL', decision: malformedDecision })
        ).some((entry) => entry.includes(`has no lane '${REVIEW_TYPE}'`)));

        const deltaDecision = decisionBinding({ mode: 'DELTA' });
        const malformedBase = rehash({
            ...fullContract(),
            mode: 'DELTA',
            source: 'remediation_delta',
            authoritative_decision_sha256: deltaDecision.decision_sha256,
            classification_sha256: deltaDecision.classification_sha256,
            base: 'not-an-object' as unknown as ReviewRemediationReviewContract['base'],
            delta: {
                origin_review_type: REVIEW_TYPE,
                classification_sha256: deltaDecision.classification_sha256,
                current_snapshot_sha256: '1'.repeat(64),
                required_delta_targets: ['src/app.ts'],
                required_delta_targets_sha256: sha256RedactedJsonPayload(['src/app.ts']),
                context_files: [],
                context_files_sha256: sha256RedactedJsonPayload([])
            }
        });
        const malformedBaseViolations = getReviewRemediationReviewContractViolations(
            malformedBase,
            validationAuthority({ mode: 'DELTA', decision: deltaDecision })
        );
        assert.ok(malformedBaseViolations.some((entry) => (
            entry.includes('base must contain exactly the canonical fields')
        )));
    });

    it('fails closed on stale task, lane, preflight, and rehashed FULL contracts carrying DELTA state', () => {
        const base = fullContract();
        const forged = rehash({
            ...base,
            base: {
                baseline_artifact_path: 'runtime/reviews/foreign.json',
                baseline_artifact_sha256: 'b'.repeat(64),
                review_receipt_sha256: 'c'.repeat(64),
                review_receipt_snapshot_sha256: 'd'.repeat(64),
                review_context_sha256: 'e'.repeat(64),
                review_tree_state_sha256: 'f'.repeat(64),
                review_scope_sha256: '1'.repeat(64),
                scope_sha256: '2'.repeat(64),
                delta_base_snapshot_sha256: '3'.repeat(64)
            }
        });
        const violations = getReviewRemediationReviewContractViolations(forged, validationAuthority({
            mode: 'DELTA',
            decision: decisionBinding({ mode: 'DELTA' }),
            taskId: 'T-foreign',
            reviewType: 'code',
            preflightSha256: '9'.repeat(64)
        }));

        assert.ok(violations.some((entry) => entry.includes('task_id')));
        assert.ok(violations.some((entry) => entry.includes('review_type')));
        assert.ok(violations.some((entry) => entry.includes('stale')));
        assert.ok(violations.some((entry) => entry.includes('does not match expected')));
        assert.ok(violations.some((entry) => entry.includes('must not carry DELTA')));
    });

    it('rejects a coherently rehashed complete scope that differs from the authoritative preflight', () => {
        const contract = fullContract();
        const shrunkenScope = ['tests/app.test.ts'];
        const shrunken = rehash({
            ...contract,
            full_review_scope: shrunkenScope,
            full_review_scope_sha256: sha256RedactedJsonPayload(shrunkenScope)
        });
        const violations = getReviewRemediationReviewContractViolations(
            shrunken,
            validationAuthority({ mode: 'FULL' })
        );
        assert.ok(violations.some((entry) => entry.includes('authoritative current preflight scope')));
    });

    it('rejects base review-scope lineage that differs from the authenticated baseline', () => {
        const base = {
            baseline_artifact_path: 'runtime/reviews/baseline.json',
            baseline_artifact_sha256: '1'.repeat(64),
            review_receipt_sha256: '2'.repeat(64),
            review_receipt_snapshot_sha256: '3'.repeat(64),
            review_context_sha256: '4'.repeat(64),
            review_tree_state_sha256: '5'.repeat(64),
            review_scope_sha256: '6'.repeat(64),
            scope_sha256: '7'.repeat(64),
            delta_base_snapshot_sha256: '8'.repeat(64)
        };
        const baseline = {
            bindings: { scope: { review_scope_sha256: '9'.repeat(64) } }
        } as unknown as ReviewRemediationBaselineArtifact;
        assert.equal(
            getAuthenticatedBaselineReviewScopeViolation(base, baseline),
            'DELTA review_execution base review_scope_sha256 does not match the authenticated baseline.'
        );
        assert.equal(getAuthenticatedBaselineReviewScopeViolation(
            { ...base, review_scope_sha256: '9'.repeat(64) },
            baseline
        ), null);
    });

    it('rejects contracts bound to a preliminary decision instead of the persisted final decision', () => {
        const preliminarySha256 = '1'.repeat(64);
        const finalSha256 = '2'.repeat(64);
        assert.equal(getRemediationContractDecisionBindingViolation(
            { authoritative_decision_sha256: preliminarySha256, classification_sha256: '3'.repeat(64) },
            preliminarySha256,
            finalSha256,
            '3'.repeat(64)
        ), 'persisted remediation review execution contract is not bound to the final authoritative lane decision and classification');
        assert.equal(getRemediationContractDecisionBindingViolation(
            { authoritative_decision_sha256: finalSha256, classification_sha256: '3'.repeat(64) },
            finalSha256,
            finalSha256,
            '3'.repeat(64)
        ), null);
    });

    it('rejects a contract whose classification hash differs from the authoritative decision', () => {
        const finalSha256 = '1'.repeat(64);
        assert.equal(getRemediationContractDecisionBindingViolation(
            {
                authoritative_decision_sha256: finalSha256,
                classification_sha256: '2'.repeat(64)
            },
            finalSha256,
            finalSha256,
            '3'.repeat(64)
        ), 'persisted remediation review execution contract is not bound to the final authoritative lane decision and classification');
        assert.equal(getRemediationContractDecisionBindingViolation(
            {
                authoritative_decision_sha256: finalSha256,
                classification_sha256: '2'.repeat(64)
            },
            finalSha256,
            finalSha256,
            undefined as unknown as string
        ), 'persisted remediation review execution contract is not bound to the final authoritative lane decision and classification');
        assert.equal(getRemediationContractDecisionBindingViolation(
            {
                authoritative_decision_sha256: finalSha256,
                classification_sha256: 'not-a-hash'
            },
            finalSha256,
            finalSha256,
            'not-a-hash'
        ), 'persisted remediation review execution contract is not bound to the final authoritative lane decision and classification');
    });

    it('fails closed when current validation authority is absent at runtime', () => {
        const missingAuthority = undefined as unknown as Parameters<
            typeof getReviewRemediationReviewContractViolations
        >[1];
        assert.deepEqual(
            getReviewRemediationReviewContractViolations(fullContract(), missingAuthority),
            [
                'review_execution validation requires complete current task, lane, preflight, mode, '
                + 'full-scope, and remediation-decision authority.'
            ]
        );
    });

    it('rejects coherently hashed DELTA context paths outside the authenticated full scope', () => {
        const base = fullContract();
        const contextFiles = ['secrets/private.env'];
        const forged = rehash({
            ...base,
            mode: 'DELTA',
            source: 'remediation_delta',
            classification_sha256: '1'.repeat(64),
            base: {
                baseline_artifact_path: 'runtime/reviews/baseline.json',
                baseline_artifact_sha256: '2'.repeat(64),
                review_receipt_sha256: '3'.repeat(64),
                review_receipt_snapshot_sha256: '4'.repeat(64),
                review_context_sha256: '5'.repeat(64),
                review_tree_state_sha256: '6'.repeat(64),
                review_scope_sha256: '7'.repeat(64),
                scope_sha256: '8'.repeat(64),
                delta_base_snapshot_sha256: '9'.repeat(64)
            },
            delta: {
                origin_review_type: REVIEW_TYPE,
                classification_sha256: '1'.repeat(64),
                current_snapshot_sha256: 'a'.repeat(64),
                required_delta_targets: ['tests/app.test.ts'],
                required_delta_targets_sha256: sha256RedactedJsonPayload(['tests/app.test.ts']),
                context_files: contextFiles,
                context_files_sha256: sha256RedactedJsonPayload(contextFiles)
            }
        });
        const violations = getReviewRemediationReviewContractViolations(
            forged,
            validationAuthority({ mode: 'DELTA', decision: decisionBinding({ mode: 'DELTA' }) })
        );

        assert.ok(violations.some((entry) => entry.includes('out-of-scope context file')));
    });

    it('rejects required DELTA targets outside the authenticated current file set', () => {
        const fixture = createAuthenticatedDeltaFixture();
        try {
            const decision = decisionBinding({
                mode: 'DELTA',
                classificationSha256: fixture.delta.classification_sha256
            });
            const classification: ReviewRemediationDecisionClassification = {
                source: 'delta',
                delta: fixture.delta,
                profilePolicySnapshot: null,
                baselineProfilePolicySnapshotSha256: '8'.repeat(64)
            };
            assert.throws(() => buildReviewRemediationReviewContract({
                taskId: TASK_ID,
                reviewType: REVIEW_TYPE,
                preflightSha256: PREFLIGHT_SHA256,
                fullReviewScope: ['tests/app.test.ts'],
                authoritativeDecision: decision,
                classification
            }), /targets must be a non-empty subset.*src\/app\.ts/u);

            const contract = buildReviewRemediationReviewContract({
                taskId: TASK_ID,
                reviewType: REVIEW_TYPE,
                preflightSha256: PREFLIGHT_SHA256,
                fullReviewScope: ['src/app.ts', 'tests/app.test.ts'],
                authoritativeDecision: decision,
                classification
            });
            const forgedScope = ['tests/app.test.ts'];
            const forged = rehash({
                ...contract,
                full_review_scope: forgedScope,
                full_review_scope_sha256: sha256RedactedJsonPayload(forgedScope)
            });
            const violations = getReviewRemediationReviewContractViolations(
                forged,
                validationAuthority({ mode: 'DELTA', decision, classification })
            );
            assert.ok(violations.some((entry) => entry.includes('out-of-scope target')));
        } finally {
            fs.rmSync(fixture.root, { recursive: true, force: true });
        }
    });

    it('rejects each independently rehashed DELTA coverage binding mismatch', () => {
        const fixture = createAuthenticatedDeltaFixture();
        try {
            const decision = decisionBinding({
                mode: 'DELTA',
                classificationSha256: fixture.delta.classification_sha256
            });
            const classification: ReviewRemediationDecisionClassification = {
                source: 'delta',
                delta: fixture.delta,
                profilePolicySnapshot: null,
                baselineProfilePolicySnapshotSha256: '8'.repeat(64)
            };
            const contract = buildReviewRemediationReviewContract({
                taskId: TASK_ID,
                reviewType: REVIEW_TYPE,
                preflightSha256: PREFLIGHT_SHA256,
                fullReviewScope: ['src/app.ts', 'tests/app.test.ts'],
                authoritativeDecision: decision,
                classification
            });
            const delta = contract.delta!;
            const mismatches = [
                {
                    label: 'current snapshot',
                    delta: { ...delta, current_snapshot_sha256: 'f'.repeat(64) }
                },
                {
                    label: 'required targets',
                    delta: {
                        ...delta,
                        required_delta_targets: ['tests/app.test.ts'],
                        required_delta_targets_sha256: sha256RedactedJsonPayload(['tests/app.test.ts'])
                    }
                },
                {
                    label: 'context files',
                    delta: {
                        ...delta,
                        context_files: ['src/app.ts'],
                        context_files_sha256: sha256RedactedJsonPayload(['src/app.ts'])
                    }
                }
            ];

            const mismatchRejections = mismatches.map((mismatch) => {
                const forged = rehash({ ...contract, delta: mismatch.delta });
                const violations = getRemediationContractClassificationBindingViolations(
                    forged,
                    decision,
                    classification
                );
                return violations.some((entry) => (
                    entry.includes('targets, context files, or snapshot do not match')
                ));
            });
            assert.deepEqual(mismatchRejections, mismatches.map(() => true));
        } finally {
            fs.rmSync(fixture.root, { recursive: true, force: true });
        }
    });

    it('rejects each independently substituted DELTA baseline identity binding', () => {
        const fixture = createAuthenticatedDeltaFixture();
        try {
            const decision = decisionBinding({
                mode: 'DELTA',
                classificationSha256: fixture.delta.classification_sha256
            });
            const classification: ReviewRemediationDecisionClassification = {
                source: 'delta',
                delta: fixture.delta,
                profilePolicySnapshot: null,
                baselineProfilePolicySnapshotSha256: '8'.repeat(64)
            };
            const contract = buildReviewRemediationReviewContract({
                taskId: TASK_ID,
                reviewType: REVIEW_TYPE,
                preflightSha256: PREFLIGHT_SHA256,
                fullReviewScope: ['src/app.ts', 'tests/app.test.ts'],
                authoritativeDecision: decision,
                classification
            });
            const base = contract.base!;
            const substitutions = [
                {
                    label: 'artifact path',
                    base: { ...base, baseline_artifact_path: `${base.baseline_artifact_path}.older` }
                },
                {
                    label: 'artifact hash',
                    base: { ...base, baseline_artifact_sha256: 'f'.repeat(64) }
                },
                {
                    label: 'tree state',
                    base: { ...base, review_tree_state_sha256: 'f'.repeat(64) }
                },
                {
                    label: 'delta snapshot',
                    base: { ...base, delta_base_snapshot_sha256: 'f'.repeat(64) }
                }
            ];

            const substitutionRejections = substitutions.map((substitution) => {
                const forged = rehash({ ...contract, base: substitution.base });
                const violations = getRemediationContractClassificationBindingViolations(
                    forged,
                    decision,
                    classification
                );
                return violations.some((entry) => (
                    entry.includes('base does not match the authenticated classification baseline identity')
                ));
            });
            assert.deepEqual(substitutionRejections, substitutions.map(() => true));
        } finally {
            fs.rmSync(fixture.root, { recursive: true, force: true });
        }
    });

    it('rejects protected fix-now findings outside DELTA targets during construction and validation', () => {
        const protectedFixture = createAuthenticatedDeltaFixture({ changedFile: 'test', withFileObligation: true });
        const coveredFixture = createAuthenticatedDeltaFixture();
        try {
            const protectedDecision = decisionBinding({
                mode: 'DELTA',
                classificationSha256: protectedFixture.delta.classification_sha256
            });
            const protectedClassification: ReviewRemediationDecisionClassification = {
                source: 'delta',
                delta: protectedFixture.delta,
                profilePolicySnapshot: null,
                baselineProfilePolicySnapshotSha256: '8'.repeat(64)
            };
            assert.deepEqual(protectedFixture.delta.scope.required_delta_targets, ['tests/app.test.ts']);
            assert.equal(protectedFixture.delta.full_review_required, true);
            assert.throws(() => buildReviewRemediationReviewContract({
                taskId: TASK_ID,
                reviewType: REVIEW_TYPE,
                preflightSha256: PREFLIGHT_SHA256,
                fullReviewScope: ['src/app.ts', 'tests/app.test.ts'],
                authoritativeDecision: protectedDecision,
                classification: protectedClassification
            }), /non-FULL remediation delta classification/u);

            const coveredDecision = decisionBinding({
                mode: 'DELTA',
                classificationSha256: coveredFixture.delta.classification_sha256
            });
            const coveredClassification: ReviewRemediationDecisionClassification = {
                source: 'delta',
                delta: coveredFixture.delta,
                profilePolicySnapshot: null,
                baselineProfilePolicySnapshotSha256: '8'.repeat(64)
            };
            const coveredContract = buildReviewRemediationReviewContract({
                taskId: TASK_ID,
                reviewType: REVIEW_TYPE,
                preflightSha256: PREFLIGHT_SHA256,
                fullReviewScope: ['src/app.ts', 'tests/app.test.ts'],
                authoritativeDecision: coveredDecision,
                classification: coveredClassification
            });
            const forgedReconciliation = {
                ...coveredContract.finding_reconciliation,
                resolvable_finding_ids: [],
                resolvable_finding_ids_sha256: sha256RedactedJsonPayload([]),
                protected_open_finding_ids: ['F-001'],
                protected_open_finding_ids_sha256: sha256RedactedJsonPayload(['F-001']),
                protected_fix_now_finding_ids: ['F-001'],
                protected_fix_now_finding_ids_sha256: sha256RedactedJsonPayload(['F-001'])
            };
            const forgedContract = rehash({
                ...coveredContract,
                finding_reconciliation: forgedReconciliation
            });
            const violations = getReviewRemediationReviewContractViolations(
                forgedContract,
                validationAuthority({
                    mode: 'DELTA',
                    decision: coveredDecision,
                    classification: coveredClassification
                })
            );
            assert.ok(violations.some((entry) => (
                entry.includes('cannot close protected fix-now findings outside covered targets')
            )));
        } finally {
            fs.rmSync(protectedFixture.root, { recursive: true, force: true });
            fs.rmSync(coveredFixture.root, { recursive: true, force: true });
        }
    });

    it('rejects each independently corrupted DELTA lineage binding and final integrity seal', () => {
        const fixture = createAuthenticatedDeltaFixture();
        try {
            const decision = decisionBinding({
                mode: 'DELTA',
                classificationSha256: fixture.delta.classification_sha256
            });
            const classification: ReviewRemediationDecisionClassification = {
                source: 'delta',
                delta: fixture.delta,
                profilePolicySnapshot: null,
                baselineProfilePolicySnapshotSha256: '8'.repeat(64)
            };
            const contract = buildReviewRemediationReviewContract({
                taskId: TASK_ID,
                reviewType: REVIEW_TYPE,
                preflightSha256: PREFLIGHT_SHA256,
                fullReviewScope: ['src/app.ts', 'tests/app.test.ts'],
                authoritativeDecision: decision,
                classification
            });
            const authority = validationAuthority({ mode: 'DELTA', decision, classification });
            const base = contract.base!;
            const lineageMutations = [
                {
                    contract: rehash({ ...contract, base: { ...base, review_receipt_sha256: 'f'.repeat(64) } }),
                    expected: 'base lineage is invalid'
                },
                {
                    contract: rehash({ ...contract, base: { ...base, review_receipt_snapshot_sha256: 'f'.repeat(64) } }),
                    expected: 'base snapshot lineage does not match'
                },
                {
                    contract: rehash({ ...contract, base: { ...base, review_context_sha256: 'f'.repeat(64) } }),
                    expected: 'base lineage is invalid'
                },
                {
                    contract: rehash({ ...contract, base: { ...base, review_scope_sha256: 'f'.repeat(64) } }),
                    expected: 'review_scope_sha256 does not match'
                },
                {
                    contract: rehash({ ...contract, base: { ...base, scope_sha256: 'f'.repeat(64) } }),
                    expected: 'base lineage is invalid'
                }
            ];
            const lineageRejections = lineageMutations.map((mutation) => (
                getReviewRemediationReviewContractViolations(mutation.contract, authority)
                    .some((entry) => entry.includes(mutation.expected))
            ));
            assert.deepEqual(lineageRejections, lineageMutations.map(() => true));

            const invalidLineage = {
                ...contract,
                complete_scope_lineage_sha256: 'f'.repeat(64)
            };
            const invalidLineageWithoutSeal = { ...invalidLineage } as Record<string, unknown>;
            delete invalidLineageWithoutSeal.contract_sha256;
            const invalidLineageWithValidSeal = {
                ...invalidLineage,
                contract_sha256: sha256RedactedJsonPayload(invalidLineageWithoutSeal)
            };
            assert.ok(getReviewRemediationReviewContractViolations(
                invalidLineageWithValidSeal,
                authority
            ).some((entry) => entry.includes('complete-scope lineage hash is invalid')));

            assert.ok(getReviewRemediationReviewContractViolations({
                ...contract,
                contract_sha256: 'f'.repeat(64)
            }, authority).some((entry) => entry.includes('contract hash is invalid')));
        } finally {
            fs.rmSync(fixture.root, { recursive: true, force: true });
        }
    });

    it('rejects missing delta-target and resolvable-prior-finding declarations', () => {
        const base = fullContract();
        const deltaContract = {
            ...base,
            mode: 'DELTA' as const,
            source: 'remediation_delta' as const,
            delta: {
                origin_review_type: REVIEW_TYPE,
                classification_sha256: '1'.repeat(64),
                current_snapshot_sha256: '2'.repeat(64),
                required_delta_targets: ['tests/app.test.ts'],
                required_delta_targets_sha256: '3'.repeat(64),
                context_files: ['src/app.ts'],
                context_files_sha256: '4'.repeat(64)
            },
            finding_reconciliation: {
                baseline_finding_ids: ['F-001', 'F-002'],
                baseline_finding_ids_sha256: '5'.repeat(64),
                resolvable_finding_ids: ['F-002'],
                resolvable_finding_ids_sha256: '6'.repeat(64),
                protected_open_finding_ids: ['F-001'],
                protected_open_finding_ids_sha256: '7'.repeat(64),
                protected_fix_now_finding_ids: [],
                protected_fix_now_finding_ids_sha256: '8'.repeat(64)
            }
        } as ReviewRemediationReviewContract;

        assert.deepEqual(getReviewerRemediationCoverageViolations({
            mode: 'DELTA',
            contract_sha256: deltaContract.contract_sha256,
            covered_delta_targets: ['tests/app.test.ts'],
            inspected_prior_finding_ids: ['F-002']
        }, deltaContract), []);

        const incomplete = getReviewerRemediationCoverageViolations({
            mode: 'DELTA',
            contract_sha256: deltaContract.contract_sha256,
            covered_delta_targets: [],
            inspected_prior_finding_ids: ['F-001']
        }, deltaContract);
        assert.ok(incomplete.some((entry) => entry.includes('exhaust every assigned delta target')));
        assert.ok(incomplete.some((entry) => entry.includes('only, and must exhaust, prior findings')));
    });

    it('rejects missing or duplicate reviewer coverage arrays even when FULL expects empty sets', () => {
        const contract = fullContract();
        const missing = getReviewerRemediationCoverageViolations({
            mode: 'FULL',
            contract_sha256: contract.contract_sha256
        }, contract);
        assert.ok(missing.some((entry) => entry.includes('covered_delta_targets must be a present')));
        assert.ok(missing.some((entry) => entry.includes('inspected_prior_finding_ids must be a present')));

        const duplicate = getReviewerRemediationCoverageViolations({
            mode: 'FULL',
            contract_sha256: contract.contract_sha256,
            covered_delta_targets: ['', ''],
            inspected_prior_finding_ids: ['F-001', 'F-001']
        }, contract);
        assert.ok(duplicate.some((entry) => entry.includes('covered_delta_targets must be a present')));
        assert.ok(duplicate.some((entry) => entry.includes('inspected_prior_finding_ids must be a present')));

        const extraField = getReviewerRemediationCoverageViolations({
            mode: 'FULL',
            contract_sha256: contract.contract_sha256,
            covered_delta_targets: [],
            inspected_prior_finding_ids: [],
            unexpected_parser_state: true
        }, contract);
        assert.ok(extraField.some((entry) => entry.includes('exactly the canonical fields')));
    });

    it('rejects reviewer coverage declarations bound to a foreign mode or contract hash', () => {
        const contract = fullContract();
        const declaration = {
            mode: 'FULL' as const,
            contract_sha256: contract.contract_sha256,
            covered_delta_targets: [],
            inspected_prior_finding_ids: []
        };

        const foreignMode = getReviewerRemediationCoverageViolations({
            ...declaration,
            mode: 'DELTA'
        }, contract);
        assert.ok(foreignMode.some((entry) => entry.includes("evidence mode must be 'FULL'")));

        const foreignContract = getReviewerRemediationCoverageViolations({
            ...declaration,
            contract_sha256: 'f'.repeat(64)
        }, contract);
        assert.ok(foreignContract.some((entry) => (
            entry.includes('contract_sha256 does not match the launch contract')
        )));
    });

    it('keeps a multi-file finding protected until every evidence path is an exact delta target', () => {
        const partial = buildReviewRemediationFindingReconciliation(
            reconciliationBaseline(),
            ['src/covered.ts']
        );
        assert.deepEqual(partial.resolvable_finding_ids, ['F-001']);
        assert.deepEqual(partial.protected_open_finding_ids, ['F-002']);
        assert.deepEqual(partial.protected_fix_now_finding_ids, ['F-002']);

        const complete = buildReviewRemediationFindingReconciliation(
            reconciliationBaseline(),
            ['src/covered.ts', 'src/uncovered.ts']
        );
        assert.deepEqual(complete.resolvable_finding_ids, ['F-001', 'F-002']);
        assert.deepEqual(complete.protected_open_finding_ids, []);
        assert.deepEqual(complete.protected_fix_now_finding_ids, []);
    });

    it('includes the original finding context without reclassifying a test-only remediation', () => {
        const fixture = createAuthenticatedDeltaFixture({
            changedFile: 'test', withFileObligation: true, withOriginCoverage: true
        });
        try {
            const decision = decisionBinding({ mode: 'DELTA', classificationSha256: fixture.delta.classification_sha256 });
            const classification: ReviewRemediationDecisionClassification = {
                source: 'delta', delta: fixture.delta, profilePolicySnapshot: null,
                baselineProfilePolicySnapshotSha256: '8'.repeat(64)
            };
            assert.equal(fixture.delta.category, 'leaf_test');
            assert.equal(fixture.delta.full_review_required, false);
            assert.deepEqual(fixture.delta.changed_files, ['tests/app.test.ts']);
            const rerun = resolveReviewRemediationRerunLanes({
                policy: buildDefaultReviewRemediationRerunPolicy(), category: fixture.delta.category,
                currentReviewType: REVIEW_TYPE, requiredReviews: { code: true, security: true, test: true },
                reviewExecutionPolicyMode: 'strict_sequential'
            });
            assert.deepEqual(rerun.ordered_rerun_lanes, ['test']);
            const contract = buildReviewRemediationReviewContract({
                taskId: TASK_ID, reviewType: REVIEW_TYPE, preflightSha256: PREFLIGHT_SHA256,
                fullReviewScope: ['src/app.ts', 'tests/app.test.ts'], authoritativeDecision: decision, classification
            });
            assert.deepEqual(contract.delta?.required_delta_targets, ['src/app.ts', 'tests/app.test.ts']);
            assert.deepEqual(contract.delta?.context_files, []);
            assert.deepEqual(contract.finding_reconciliation.resolvable_finding_ids, ['F-001']);
            assert.deepEqual(getReviewRemediationReviewContractViolations(contract,
                validationAuthority({ mode: 'DELTA', decision, classification })), []);
            assert.ok(getReviewerRemediationCoverageViolations({
                mode: 'DELTA', contract_sha256: contract.contract_sha256,
                covered_delta_targets: ['tests/app.test.ts'], inspected_prior_finding_ids: ['F-001']
            }, contract).some((entry) => entry.includes('exhaust every assigned delta target')));
            assert.ok(getReviewerRemediationCoverageViolations({
                mode: 'DELTA', contract_sha256: contract.contract_sha256,
                covered_delta_targets: ['src/app.ts', 'tests/app.test.ts'], inspected_prior_finding_ids: []
            }, contract).some((entry) => entry.includes('must exhaust, prior findings')));
            const forged = rehash({
                ...contract,
                delta: {
                    ...contract.delta!, required_delta_targets: ['tests/app.test.ts'],
                    required_delta_targets_sha256: sha256RedactedJsonPayload(['tests/app.test.ts']),
                    context_files: ['src/app.ts'], context_files_sha256: sha256RedactedJsonPayload(['src/app.ts'])
                }
            });
            assert.ok(getReviewRemediationReviewContractViolations(forged,
                validationAuthority({ mode: 'DELTA', decision, classification }))
                .some((entry) => entry.includes('do not match the authenticated classification')));
        } finally {
            fs.rmSync(fixture.root, { recursive: true, force: true });
        }
    });

    it('selects FULL early for unknown FILE ids or finding evidence outside the original task scope', () => {
        for (const options of [
            { fileObligationIds: ['FILE-999'] },
            { findingEvidence: ['src/outside.ts:1'] }
        ]) {
            const fixture = createAuthenticatedDeltaFixture({
                changedFile: 'test', withOriginCoverage: true, ...options
            });
            try {
                assert.equal(fixture.delta.category, 'leaf_test');
                assert.equal(fixture.delta.full_review_required, true);
                assert.match(fixture.delta.full_review_reasons.join('\n'), /fix-now item F-001/u);
                assert.deepEqual(fixture.delta.changed_files, ['tests/app.test.ts']);
            } finally {
                fs.rmSync(fixture.root, { recursive: true, force: true });
            }
        }
    });

    it('uses the originating lane FILE mapping, not the task-wide delta-base file order', () => {
        const baseline = reconciliationBaseline();
        baseline.accepted_findings = [{
            id: 'F-003', severity: 'high', title: 'Lane-specific obligation',
            description: 'The evidence and originating FILE obligation refer to different files.',
            evidence_locations: ['src/covered.ts:40'], coverage_obligation_ids: ['FILE-001']
        }];
        Object.assign(baseline, { origin_coverage_contract: buildReviewCoverageContract({
            reviewType: REVIEW_TYPE, changedFiles: ['src/uncovered.ts']
        }) });
        assert.deepEqual(buildReviewRemediationFindingReconciliation(baseline,
            ['src/covered.ts']).protected_open_finding_ids, ['F-003']);
        assert.deepEqual(buildReviewRemediationFindingReconciliation(baseline,
            ['src/covered.ts', 'src/uncovered.ts']).resolvable_finding_ids, ['F-003']);
    });

    it('keeps FILE obligations protected without an authenticated lane-specific path mapping', () => {
        const baseline = reconciliationBaseline();
        baseline.accepted_findings = [{
            id: 'F-003',
            severity: 'high',
            title: 'Cross-file obligation finding',
            description: 'The evidence line is local, but the authenticated finding covers a second file.',
            evidence_locations: ['src/covered.ts:40'],
            coverage_obligation_ids: ['FILE-001', 'FILE-002']
        }];
        baseline.fix_now_items = [];

        const partial = buildReviewRemediationFindingReconciliation(
            baseline,
            ['src/covered.ts']
        );
        assert.deepEqual(partial.resolvable_finding_ids, []);
        assert.deepEqual(partial.protected_open_finding_ids, ['F-003']);

        const complete = buildReviewRemediationFindingReconciliation(
            baseline,
            ['src/covered.ts', 'src/uncovered.ts']
        );
        assert.deepEqual(complete.resolvable_finding_ids, []);
        assert.deepEqual(complete.protected_open_finding_ids, ['F-003']);
    });

    it('derives a deterministic reconciliation that cannot be replaced by a coherently rehashed partition', () => {
        const expected = buildReviewRemediationFindingReconciliation(
            reconciliationBaseline(),
            ['src/covered.ts']
        );
        const forged = {
            ...expected,
            resolvable_finding_ids: ['F-001', 'F-002'],
            resolvable_finding_ids_sha256: sha256RedactedJsonPayload(['F-001', 'F-002']),
            protected_open_finding_ids: [],
            protected_open_finding_ids_sha256: sha256RedactedJsonPayload([]),
            protected_fix_now_finding_ids: [],
            protected_fix_now_finding_ids_sha256: sha256RedactedJsonPayload([])
        };
        assert.deepEqual(getReviewRemediationFindingReconciliationViolations(
            forged,
            reconciliationBaseline(),
            ['src/covered.ts']
        ), [
            'review_execution finding reconciliation does not match the authenticated baseline and exact DELTA targets.'
        ]);
        assert.deepEqual(getReviewRemediationFindingReconciliationViolations(
            expected,
            reconciliationBaseline(),
            ['src/covered.ts']
        ), []);
    });

});
