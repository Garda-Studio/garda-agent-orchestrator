import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    buildTaskQueueFollowUpFingerprintIndex,
    getScopedDiffMetadataReadiness,
    readReviewArtifactState,
    readReviewTrust,
    reviewReceiptDomainScopeMatchesCurrentPreflight,
    scopedDiffExpectedForReview
} from '../../../../src/gates/next-step/next-step-review-artifact-readers';
import type { TaskQueueEntry } from '../../../../src/core/task-queue-read';
import { buildReviewReceipt } from '../../../../src/gate-runtime/review-context';
import {
    buildReviewFindingsValidationArtifact,
    getReviewFindingsValidationArtifactPath
} from '../../../../src/gates/review/review-findings-validation-artifact';
import { validateReviewFindingsContract } from '../../../../src/gates/review/review-findings-artifact-verdict';
import {
    computeReviewRelevantScopeFingerprint,
    computeReviewReuseCodeScopeFingerprint
} from '../../../../src/gates/review-reuse';
import type { ReviewCoverageContract } from '../../../../src/gates/review/review-coverage-ledger';
import { sha256RedactedJsonPayload } from '../../../../src/core/redaction';
import { resolveReviewContextExecutionEvidenceBindings } from '../../../../src/gates/review/review-evidence-contract';
import { REVIEW_FINDINGS_SCHEMA_VERSION } from '../../../../src/gates/review/review-findings-schema';
import { buildReviewRemediationReviewContract } from '../../../../src/gates/review-remediation/review-remediation-review-contract';
import { appendMandatoryTaskEvent } from '../../../../src/gate-runtime/task-events';
import { getReviewOutputCorrectionArtifactPath } from '../../../../src/gates/review/review-output-correction';

const TREE_STATE_SHA256 = 'b'.repeat(64);
const COVERAGE_CONTRACT_SHA256 = 'c'.repeat(64);
const SCOPE_SHA256 = 'd'.repeat(64);
const CHANGED_FILE = 'src/gates/next-step/next-step-review-artifact-readers.ts';

test('buildTaskQueueFollowUpFingerprintIndex reuses one parsed TASK snapshot across review lanes', () => {
    const perFindingFingerprint = '1'.repeat(64);
    const groupFingerprint = '2'.repeat(64);
    const itemFingerprintsSha256 = '3'.repeat(64);
    const sourceBindingSha256 = '4'.repeat(64);
    const taskEntries = new Map<string, TaskQueueEntry>([
        ['T-100', { taskId: 'T-100', status: 'IN_REVIEW', area: null, title: null, profile: null, notes: null }],
        ['T-100-F1', {
            taskId: 'T-100-F1',
            status: 'TODO',
            area: null,
            title: null,
            profile: null,
            notes: [
                `review_follow_up_fingerprint=${perFindingFingerprint}.`,
                `review_follow_up_group_fingerprint=${groupFingerprint}.`,
                `review_follow_up_lane_binding=code:2:${itemFingerprintsSha256}:${sourceBindingSha256}.`,
                'review_follow_up_lane_artifact=code:`runtime/reviews/code-follow-ups.json`.'
            ].join(' ')
        }]
    ]);

    const index = buildTaskQueueFollowUpFingerprintIndex(taskEntries, 'T-100');

    assert.equal(index?.perFindingByTask.get('T-100-F1'), perFindingFingerprint);
    assert.equal(index?.groupedFingerprintByTask.get('T-100-F1'), groupFingerprint);
    const laneBinding = index?.groupedByTask.get('T-100-F1')?.get('code');
    assert.equal(laneBinding?.itemCount, 2);
    assert.equal(laneBinding?.itemFingerprintsSha256, itemFingerprintsSha256);
    assert.equal(laneBinding?.sourceBindingSha256, sourceBindingSha256);
    assert.equal(laneBinding?.artifactPath, 'runtime/reviews/code-follow-ups.json');
});

function tempRoot(prefix: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeJson(filePath: string, value: unknown): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function sha256File(filePath: string): string {
    return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function sha256Json(value: unknown): string {
    return createHash('sha256').update(JSON.stringify(value, null, 2) + '\n').digest('hex');
}

function findingsPreflightPayload(): Record<string, unknown> {
    return {
        detection_source: 'git_auto',
        include_untracked: true,
        changed_files: [CHANGED_FILE],
        metrics: {
            scope_sha256: SCOPE_SHA256,
            changed_files_sha256: SCOPE_SHA256
        }
    };
}

function balancedFindingsPreflightPayload(): Record<string, unknown> {
    return {
        ...findingsPreflightPayload(),
        profile_policy_snapshot: {
            review_finding_policy: {
                schema_version: 1,
                policy_id: 'balanced',
                findings: {
                    critical: 'fix_now',
                    high: 'fix_now',
                    medium: 'create_follow_up',
                    low: 'create_follow_up'
                },
                residual_risk: 'create_follow_up'
            }
        }
    };
}

function softFindingsPreflightPayload(): Record<string, unknown> {
    return {
        ...findingsPreflightPayload(),
        profile_policy_snapshot: {
            review_finding_policy: {
                schema_version: 1,
                policy_id: 'soft',
                findings: {
                    critical: 'fix_now',
                    high: 'create_follow_up',
                    medium: 'ignore',
                    low: 'ignore'
                },
                residual_risk: 'ignore'
            }
        }
    };
}

function writeFindingsReviewPackage(options: {
    reviewsRoot: string;
    taskId: string;
    reviewType: string;
    preflightPath: string;
    report: Record<string, unknown>;
    receiptOverrides?: Record<string, unknown>;
}): void {
    const contextPath = path.join(options.reviewsRoot, `${options.taskId}-${options.reviewType}-review-context.json`);
    const artifactPath = path.join(options.reviewsRoot, `${options.taskId}-${options.reviewType}.md`);
    const coverageContract: ReviewCoverageContract = {
        schema_version: 1,
        required: true,
        review_type: options.reviewType,
        obligations: [{ id: 'FILE-001', kind: 'file', target: CHANGED_FILE }],
        obligation_count: 1,
        contract_sha256: COVERAGE_CONTRACT_SHA256
    };
    const preflightPayload = findingsPreflightPayload();
    const reviewScopeSha256 = computeReviewRelevantScopeFingerprint(preflightPayload, process.cwd()).review_scope_sha256;
    const codeScopeSha256 = computeReviewReuseCodeScopeFingerprint(
        options.reviewType,
        preflightPayload,
        process.cwd()
    ).code_scope_sha256;
    const reviewExecution = buildReviewRemediationReviewContract({
        taskId: options.taskId,
        reviewType: options.reviewType,
        preflightSha256: 'a'.repeat(64),
        fullReviewScope: [CHANGED_FILE]
    });
    const reviewExecutionBindings = resolveReviewContextExecutionEvidenceBindings({
        schema_version: 4,
        review_execution: reviewExecution
    }).bindings!;
    writeJson(contextPath, {
        schema_version: 4,
        task_id: options.taskId,
        review_type: options.reviewType,
        preflight_path: options.preflightPath,
        preflight_sha256: null,
        tree_state: {
            tree_state_sha256: TREE_STATE_SHA256
        },
        coverage_contract: coverageContract,
        review_execution: reviewExecution
    });
    const contextSha256 = sha256File(contextPath);
    const report = {
        ...options.report,
        schema_version: REVIEW_FINDINGS_SCHEMA_VERSION,
        review_context_sha256: contextSha256,
        tree_state_sha256: TREE_STATE_SHA256,
        review_execution: {
            mode: reviewExecution.mode,
            contract_sha256: reviewExecution.contract_sha256,
            covered_delta_targets: [],
            inspected_prior_finding_ids: []
        },
        coverage_ledger: {
            coverage_contract_sha256: COVERAGE_CONTRACT_SHA256,
            ...(options.report.coverage_ledger as Record<string, unknown>)
        }
    };
    fs.writeFileSync(artifactPath, JSON.stringify(report, null, 2) + '\n');
    const artifactSha256 = sha256File(artifactPath);
    const validation = validateReviewFindingsContract({
        content: fs.readFileSync(artifactPath, 'utf8'),
        expectedTaskId: options.taskId,
        expectedReviewType: options.reviewType,
        expectedReviewContextSha256: contextSha256,
        expectedTreeStateSha256: TREE_STATE_SHA256,
        coverageContract,
        expectedReviewExecutionContract: reviewExecution
    });
    assert.equal(validation.valid, true, validation.violations.join(' '));
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
        preflightSha256: null,
        scopeSha256: SCOPE_SHA256,
        reviewScopeSha256,
        codeScopeSha256,
        reviewTreeStateSha256: TREE_STATE_SHA256,
        coverageContract
    });
    writeJson(validationArtifactPath, validationArtifact);
    const validationArtifactSha256 = sha256File(validationArtifactPath);
    const receipt = buildReviewReceipt({
        taskId: options.taskId,
        reviewType: options.reviewType,
        preflightSha256: null,
        scopeSha256: SCOPE_SHA256,
        reviewScopeSha256,
        codeScopeSha256,
        reviewContextSha256: contextSha256,
        reviewTreeStateSha256: TREE_STATE_SHA256,
        reviewExecutionMode: reviewExecutionBindings.review_execution_mode,
        reviewExecutionContractSha256: reviewExecutionBindings.review_execution_contract_sha256,
        reviewExecutionFullScopeSha256: reviewExecutionBindings.review_execution_full_scope_sha256,
        reviewExecutionCompleteScopeLineageSha256:
            reviewExecutionBindings.review_execution_complete_scope_lineage_sha256,
        reviewExecutionFindingReconciliationSha256:
            reviewExecutionBindings.review_execution_finding_reconciliation_sha256,
        reviewArtifactSha256: artifactSha256,
        reviewerExecutionMode: 'delegated_subagent',
        reviewerIdentity: `agent:${options.taskId}-${options.reviewType}`,
        trustLevel: 'INDEPENDENT_AUDITED'
    }) as unknown as Record<string, unknown>;
    receipt.review_output_sha256 = artifactSha256;
    receipt.review_coverage = validation.coverage_validation;
    receipt.review_findings_validation = {
        artifact_path: validationArtifactPath.replace(/\\/g, '/'),
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
        report_sha256: sha256Json(validation.report),
        validation_artifact_sha256: validationArtifactSha256,
        validation_result_sha256: validationArtifact.validation_result_sha256,
        raw_output_sha256: artifactSha256,
        review_artifact_sha256: artifactSha256,
        review_context_sha256: contextSha256,
        review_tree_state_sha256: TREE_STATE_SHA256,
        coverage_contract_sha256: COVERAGE_CONTRACT_SHA256,
        ...reviewExecutionBindings,
        reviewer_identity: `agent:${options.taskId}-${options.reviewType}`,
        reviewer_provenance_event_sha256: null
    };
    const reusedExecutionBindings = options.receiptOverrides?.reused_existing_review === true
        ? {
            reused_from_review_execution_mode: reviewExecutionBindings.review_execution_mode,
            reused_from_review_execution_contract_sha256:
                reviewExecutionBindings.review_execution_contract_sha256,
            reused_from_review_execution_full_scope_sha256:
                reviewExecutionBindings.review_execution_full_scope_sha256,
            reused_from_review_execution_complete_scope_lineage_sha256:
                reviewExecutionBindings.review_execution_complete_scope_lineage_sha256,
            reused_from_review_execution_finding_reconciliation_sha256:
                reviewExecutionBindings.review_execution_finding_reconciliation_sha256
        }
        : {};
    writeJson(path.join(options.reviewsRoot, `${options.taskId}-${options.reviewType}-receipt.json`), {
        ...receipt,
        ...reusedExecutionBindings,
        ...(options.receiptOverrides || {})
    });
}

function promoteFindingsReviewPackageToSchema4(options: {
    reviewsRoot: string;
    taskId: string;
    reviewType: string;
}): ReturnType<typeof resolveReviewContextExecutionEvidenceBindings>['bindings'] {
    const contextPath = path.join(
        options.reviewsRoot,
        `${options.taskId}-${options.reviewType}-review-context.json`
    );
    const context = JSON.parse(fs.readFileSync(contextPath, 'utf8')) as Record<string, unknown>;
    return resolveReviewContextExecutionEvidenceBindings(context).bindings;
}

function rewriteValidationArtifactExecutionBinding(options: {
    reviewsRoot: string;
    taskId: string;
    reviewType: string;
    field: string;
    value: unknown;
}): void {
    const prefix = path.join(options.reviewsRoot, `${options.taskId}-${options.reviewType}`);
    const validationArtifactPath = getReviewFindingsValidationArtifactPath(`${prefix}.md`);
    const receiptPath = `${prefix}-receipt.json`;
    const validationArtifact = JSON.parse(
        fs.readFileSync(validationArtifactPath, 'utf8')
    ) as Record<string, unknown>;
    const validationResult = validationArtifact.validation_result as Record<string, unknown>;
    const validationBindings = validationResult.bindings as Record<string, unknown>;
    (validationBindings.execution as Record<string, unknown>)[options.field] = options.value;
    validationArtifact.validation_result_sha256 = sha256RedactedJsonPayload(validationResult);
    writeJson(validationArtifactPath, validationArtifact);
    const validationArtifactSha256 = sha256File(validationArtifactPath);
    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as Record<string, unknown>;
    Object.assign(receipt.review_output_contract as Record<string, unknown>, {
        validation_artifact_sha256: validationArtifactSha256,
        validation_result_sha256: validationArtifact.validation_result_sha256
    });
    Object.assign(receipt.review_findings_validation as Record<string, unknown>, {
        artifact_sha256: validationArtifactSha256,
        validation_result_sha256: validationArtifact.validation_result_sha256
    });
    writeJson(receiptPath, receipt);
}

test('readReviewArtifactState reports missing review artifacts without route decisions', () => {
    const reviewsRoot = tempRoot('garda-next-step-review-readers-');
    const preflightPath = path.join(reviewsRoot, 'T-100-preflight.json');

    const state = readReviewArtifactState(
        reviewsRoot,
        'T-100',
        'code',
        preflightPath,
        null,
        null
    );

    assert.equal(state.reviewType, 'code');
    assert.equal(state.ready, false);
    assert.equal(state.contextExists, false);
    assert.equal(state.artifactExists, false);
    assert.equal(state.receiptExists, false);
    assert.deepEqual(state.violations, [
        'review context artifact is missing',
        'review artifact is missing',
        'review receipt is missing'
    ]);
});

test('readReviewArtifactState derives pass state from findings JSON artifacts without legacy pass token', () => {
    const reviewsRoot = tempRoot('garda-next-step-review-json-readers-');
    const preflightPath = path.join(reviewsRoot, 'T-100-preflight.json');
    writeFindingsReviewPackage({
        reviewsRoot,
        taskId: 'T-100',
        reviewType: 'code',
        preflightPath,
        report: {
            schema_version: 1,
            task_id: 'T-100',
            review_type: 'code',
            validation_notes: [{
                id: 'N-001',
                topic: 'scope',
                note: 'Reviewed the JSON artifact reader path.',
                evidence: [{
                    location: 'src/gates/next-step/next-step-review-artifact-readers.ts:250',
                    observation: 'The findings JSON artifact reader branch was inspected.'
                }]
            }],
            coverage_ledger: {
                entries: [{
                    obligation_id: 'FILE-001',
                    evidence: [{
                        location: 'src/gates/next-step/next-step-review-artifact-readers.ts:250',
                        observation: 'The reader branch was covered.'
                    }],
                    finding_ids: []
                }]
            },
            findings: { critical: [], high: [], medium: [], low: [] },
            residual_risks: [],
            reviewer_notes: []
        }
    });

    const state = readReviewArtifactState(
        reviewsRoot,
        'T-100',
        'code',
        preflightPath,
        null,
        findingsPreflightPayload()
    );

    assert.equal(state.verdictToken, 'REVIEW PASSED');
    assert.equal(state.failed, false);
    assert.ok(!state.violations.some((violation) => violation.includes('accepted pass token')));
});

test('readReviewArtifactState requires exact schema-4 receipt execution lineage', () => {
    const reviewsRoot = tempRoot('garda-next-step-schema4-receipt-');
    const taskId = 'T-100';
    const reviewType = 'code';
    const preflightPath = path.join(reviewsRoot, `${taskId}-preflight.json`);
    writeFindingsReviewPackage({
        reviewsRoot,
        taskId,
        reviewType,
        preflightPath,
        report: {
            schema_version: 1,
            task_id: taskId,
            review_type: reviewType,
            validation_notes: [{
                id: 'N-001',
                topic: 'execution lineage',
                note: 'Inspected schema-4 downstream trust bindings.',
                evidence: [{ location: `${CHANGED_FILE}:855`, observation: 'Receipt lineage is checked.' }]
            }],
            coverage_ledger: {
                entries: [{
                    obligation_id: 'FILE-001',
                    evidence: [{ location: `${CHANGED_FILE}:855`, observation: 'Receipt lineage is checked.' }],
                    finding_ids: []
                }]
            },
            findings: { critical: [], high: [], medium: [], low: [] },
            residual_risks: [],
            reviewer_notes: []
        }
    });
    promoteFindingsReviewPackageToSchema4({ reviewsRoot, taskId, reviewType });

    const exact = readReviewArtifactState(
        reviewsRoot,
        taskId,
        reviewType,
        preflightPath,
        null,
        findingsPreflightPayload()
    );
    assert.ok(!exact.violations.some((violation) => violation.includes('review_execution_')));

    const receiptPath = path.join(reviewsRoot, `${taskId}-${reviewType}-receipt.json`);
    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as Record<string, unknown>;
    receipt.review_execution_complete_scope_lineage_sha256 = null;
    writeJson(receiptPath, receipt);
    const missingLineage = readReviewArtifactState(
        reviewsRoot,
        taskId,
        reviewType,
        preflightPath,
        null,
        findingsPreflightPayload()
    );

    assert.equal(missingLineage.ready, false);
    assert.ok(missingLineage.violations.includes(
        'review receipt is missing valid review_execution_complete_scope_lineage_sha256'
    ));
});

test('readReviewArtifactState rejects stale protected-finding bindings in schema-4 validation evidence', () => {
    const reviewsRoot = tempRoot('garda-next-step-schema4-findings-');
    const taskId = 'T-100';
    const reviewType = 'code';
    const preflightPath = path.join(reviewsRoot, `${taskId}-preflight.json`);
    writeFindingsReviewPackage({
        reviewsRoot,
        taskId,
        reviewType,
        preflightPath,
        report: {
            schema_version: 1,
            task_id: taskId,
            review_type: reviewType,
            validation_notes: [{
                id: 'N-001',
                topic: 'protected findings',
                note: 'Inspected protected finding reconciliation bindings.',
                evidence: [{ location: `${CHANGED_FILE}:912`, observation: 'Validation lineage is checked.' }]
            }],
            coverage_ledger: {
                entries: [{
                    obligation_id: 'FILE-001',
                    evidence: [{ location: `${CHANGED_FILE}:912`, observation: 'Validation lineage is checked.' }],
                    finding_ids: []
                }]
            },
            findings: { critical: [], high: [], medium: [], low: [] },
            residual_risks: [],
            reviewer_notes: []
        }
    });
    promoteFindingsReviewPackageToSchema4({ reviewsRoot, taskId, reviewType });
    rewriteValidationArtifactExecutionBinding({
        reviewsRoot,
        taskId,
        reviewType,
        field: 'review_execution_finding_reconciliation_sha256',
        value: '9'.repeat(64)
    });

    const state = readReviewArtifactState(
        reviewsRoot,
        taskId,
        reviewType,
        preflightPath,
        null,
        findingsPreflightPayload()
    );

    assert.equal(state.ready, false);
    assert.ok(state.violations.some((violation) =>
        violation.includes('review findings validation artifact execution binding')
        && violation.includes('review_execution_finding_reconciliation_sha256')
    ));
});

test('readReviewArtifactState rejects legacy verdict tokens for current findings-only contexts', () => {
    const reviewsRoot = tempRoot('garda-next-step-review-legacy-token-readers-');
    const preflightPath = path.join(reviewsRoot, 'T-100-preflight.json');
    const contextPath = path.join(reviewsRoot, 'T-100-code-review-context.json');
    writeJson(contextPath, {
        schema_version: 3,
        task_id: 'T-100',
        review_type: 'code',
        tree_state: {
            tree_state_sha256: TREE_STATE_SHA256
        },
        coverage_contract: {
            schema_version: 1,
            required: true,
            review_type: 'code',
            obligations: [{ id: 'FILE-001', kind: 'file', target: 'src/gates/next-step/next-step-review-artifact-readers.ts' }],
            obligation_count: 1,
            contract_sha256: COVERAGE_CONTRACT_SHA256
        }
    });
    fs.writeFileSync(path.join(reviewsRoot, 'T-100-code.md'), [
        '# Review',
        '',
        'This current generated review context must not accept legacy verdict-token evidence.',
        '',
        '## Findings by Severity',
        'none',
        '',
        '## Residual Risks',
        'none',
        '',
        '## Verdict',
        'REVIEW PASSED'
    ].join('\n'));

    const state = readReviewArtifactState(
        reviewsRoot,
        'T-100',
        'code',
        preflightPath,
        null,
        findingsPreflightPayload()
    );

    assert.equal(state.verdictToken, null);
    assert.ok(state.violations.some((violation) =>
        violation.includes('must be verdict-free findings JSON')
        && violation.includes('legacy PASS/FAIL verdict-token artifacts')
    ));
});

test('readReviewArtifactState treats fix_now findings JSON artifacts as failed even without legacy fail token', () => {
    const reviewsRoot = tempRoot('garda-next-step-review-json-failed-readers-');
    const preflightPath = path.join(reviewsRoot, 'T-100-preflight.json');
    writeFindingsReviewPackage({
        reviewsRoot,
        taskId: 'T-100',
        reviewType: 'code',
        preflightPath,
        report: {
            schema_version: 1,
            task_id: 'T-100',
            review_type: 'code',
            validation_notes: [{
                id: 'N-001',
                topic: 'scope',
                note: 'Reviewed the JSON artifact reader failed-state path.',
                evidence: [{
                    location: 'src/gates/next-step/next-step-review-artifact-readers.ts:250',
                    observation: 'The findings JSON active finding branch was inspected.'
                }]
            }],
            coverage_ledger: {
                entries: [{
                    obligation_id: 'FILE-001',
                    evidence: [{
                        location: 'src/gates/next-step/next-step-review-artifact-readers.ts:250',
                        observation: 'The reader branch was covered.'
                    }],
                    finding_ids: ['F-001']
                }]
            },
            findings: {
                critical: [],
                high: [
                    {
                        id: 'F-001',
                        title: 'Downstream reader failure',
                        description: 'The downstream reader must surface this active finding.',
                        evidence: [
                            {
                                location: 'src/gates/next-step/next-step-review-artifact-readers.ts:140',
                                observation: 'JSON active findings are mapped to failed review state.'
                            }
                        ],
                        coverage_obligation_ids: ['FILE-001']
                    }
                ],
                medium: [],
                low: []
            },
            residual_risks: [
                {
                    id: 'R-001',
                    description: 'The balanced policy should route this residual risk to a follow-up instead of failed review state.',
                    evidence: [
                        {
                            location: 'src/gates/next-step/next-step-review-artifact-readers.ts:140',
                            observation: 'JSON residual risks are mapped through the locked disposition policy.'
                        }
                    ]
                }
            ],
            reviewer_notes: []
        }
    });

    const state = readReviewArtifactState(
        reviewsRoot,
        'T-100',
        'code',
        preflightPath,
        null,
        null
    );

    assert.equal(state.verdictToken, 'CODE REVIEW FAILED');
    assert.equal(state.failed, true);
    assert.ok(state.violations.some((violation) => violation.includes('validation artifact contains fix_now findings')));
});

test('readReviewArtifactState preserves historical locked balanced medium follow-up semantics', () => {
    const reviewsRoot = tempRoot('garda-next-step-review-json-balanced-readers-');
    const preflightPath = path.join(reviewsRoot, 'T-100-preflight.json');
    writeFindingsReviewPackage({
        reviewsRoot,
        taskId: 'T-100',
        reviewType: 'refactor',
        preflightPath,
        report: {
            schema_version: 1,
            task_id: 'T-100',
            review_type: 'refactor',
            validation_notes: [{
                id: 'N-001',
                topic: 'scope',
                note: 'Reviewed the JSON artifact reader balanced-policy path.',
                evidence: [{
                    location: 'src/gates/next-step/next-step-review-artifact-readers.ts:250',
                    observation: 'The findings JSON non-blocking branch was inspected.'
                }]
            }],
            coverage_ledger: {
                entries: [{
                    obligation_id: 'FILE-001',
                    evidence: [{
                        location: 'src/gates/next-step/next-step-review-artifact-readers.ts:250',
                        observation: 'The reader branch was covered.'
                    }],
                    finding_ids: ['F-001']
                }]
            },
            findings: {
                critical: [],
                high: [],
                medium: [
                    {
                        id: 'F-001',
                        title: 'Historical follow-up-only finding',
                        description: 'The locked historical balanced snapshot routes this medium finding to a follow-up.',
                        evidence: [
                            {
                                location: 'src/gates/next-step/next-step-review-artifact-readers.ts:140',
                                observation: 'JSON findings are mapped through the locked disposition policy.'
                            }
                        ],
                        coverage_obligation_ids: ['FILE-001']
                    }
                ],
                low: []
            },
            residual_risks: [],
            reviewer_notes: []
        }
    });

    const state = readReviewArtifactState(
        reviewsRoot,
        'T-100',
        'refactor',
        preflightPath,
        null,
        balancedFindingsPreflightPayload()
    );

    assert.equal(state.verdictToken, 'REFACTOR REVIEW PASSED');
    assert.equal(state.failed, false);
    assert.ok(!state.violations.some((violation) => violation.includes('fix_now findings')));
});

test('readReviewArtifactState treats ignored findings and residual risks JSON artifacts as non-blocking pass', () => {
    const reviewsRoot = tempRoot('garda-next-step-review-json-soft-readers-');
    const preflightPath = path.join(reviewsRoot, 'T-100-preflight.json');
    writeFindingsReviewPackage({
        reviewsRoot,
        taskId: 'T-100',
        reviewType: 'refactor',
        preflightPath,
        report: {
            schema_version: 1,
            task_id: 'T-100',
            review_type: 'refactor',
            validation_notes: [{
                id: 'N-001',
                topic: 'scope',
                note: 'Reviewed the JSON artifact reader soft-policy path.',
                evidence: [{
                    location: 'src/gates/next-step/next-step-review-artifact-readers.ts:250',
                    observation: 'The findings JSON ignore branch was inspected.'
                }]
            }],
            coverage_ledger: {
                entries: [{
                    obligation_id: 'FILE-001',
                    evidence: [{
                        location: 'src/gates/next-step/next-step-review-artifact-readers.ts:250',
                        observation: 'The reader ignore branch was covered.'
                    }],
                    finding_ids: ['F-001']
                }]
            },
            findings: {
                critical: [],
                high: [],
                medium: [],
                low: [
                    {
                        id: 'F-001',
                        title: 'Ignored low finding',
                        description: 'The soft policy should route this low finding to ignore instead of failed review state.',
                        evidence: [
                            {
                                location: 'src/gates/next-step/next-step-review-artifact-readers.ts:140',
                                observation: 'JSON findings are mapped through the locked ignore disposition policy.'
                            }
                        ],
                        coverage_obligation_ids: ['FILE-001']
                    }
                ]
            },
            residual_risks: [
                {
                    id: 'R-001',
                    description: 'The soft policy should route this residual risk to ignore instead of failed review state.',
                    evidence: [
                        {
                            location: 'src/gates/next-step/next-step-review-artifact-readers.ts:140',
                            observation: 'JSON residual risks are mapped through the locked ignore disposition policy.'
                        }
                    ]
                }
            ],
            reviewer_notes: []
        }
    });

    const state = readReviewArtifactState(
        reviewsRoot,
        'T-100',
        'refactor',
        preflightPath,
        null,
        softFindingsPreflightPayload()
    );

    assert.equal(state.verdictToken, 'REFACTOR REVIEW PASSED');
    assert.equal(state.failed, false);
    assert.ok(!state.violations.some((violation) => violation.includes('fix_now findings')));
    assert.ok(!state.violations.some((violation) => violation.includes('fix_now residual risks')));
});

test('readReviewArtifactState uses receipt disposition for reused findings JSON artifacts', () => {
    const reviewsRoot = tempRoot('garda-next-step-review-json-reused-disposition-readers-');
    const preflightPath = path.join(reviewsRoot, 'T-100-preflight.json');
    const receiptDisposition = {
        schema_version: 1,
        policy_id: 'balanced',
        policy_source: 'preflight_profile_policy_snapshot',
        policy_diagnostics: [],
        findings: {
            critical: { action: 'fix_now', ids: [], count: 0 },
            high: { action: 'fix_now', ids: [], count: 0 },
            medium: { action: 'create_follow_up', ids: ['F-001'], count: 1 },
            low: { action: 'create_follow_up', ids: [], count: 0 }
        },
        residual_risks: { action: 'create_follow_up', ids: [], count: 0 },
        counts_by_action: { fix_now: 0, create_follow_up: 1, ignore: 0 },
        blocking_count: 0,
        blocking_ids: [],
        non_blocking_count: 1,
        total_count: 1,
        verdict: 'pass_with_follow_up_or_ignored_findings'
    };
    writeFindingsReviewPackage({
        reviewsRoot,
        taskId: 'T-100',
        reviewType: 'code',
        preflightPath,
        receiptOverrides: {
            reused_existing_review: true,
            reused_from_receipt_path: path.join(reviewsRoot, 'historical-code-receipt.json').replace(/\\/g, '/'),
            reused_from_receipt_sha256: 'f'.repeat(64),
            reused_from_review_context_sha256: null,
            reused_from_review_tree_state_sha256: TREE_STATE_SHA256,
            reused_from_review_scope_sha256: computeReviewRelevantScopeFingerprint(
                findingsPreflightPayload(),
                process.cwd()
            ).review_scope_sha256,
            reused_from_code_scope_sha256: computeReviewReuseCodeScopeFingerprint(
                'code',
                findingsPreflightPayload(),
                process.cwd()
            ).code_scope_sha256,
            review_findings_disposition: receiptDisposition
        },
        report: {
            schema_version: 1,
            task_id: 'T-100',
            review_type: 'code',
            validation_notes: [{
                id: 'N-001',
                topic: 'scope',
                note: 'Reviewed the JSON artifact reader reused-disposition path.',
                evidence: [{
                    location: 'src/gates/next-step/next-step-review-artifact-readers.ts:250',
                    observation: 'The findings JSON reused branch was inspected.'
                }]
            }],
            coverage_ledger: {
                entries: [{
                    obligation_id: 'FILE-001',
                    evidence: [{
                        location: 'src/gates/next-step/next-step-review-artifact-readers.ts:250',
                        observation: 'The reused receipt disposition branch was covered.'
                    }],
                    finding_ids: ['F-001']
                }]
            },
            findings: {
                critical: [],
                high: [],
                medium: [
                    {
                        id: 'F-001',
                        title: 'Historical follow-up finding',
                        description: 'A reused receipt with a balanced policy should keep this medium finding non-blocking even when current preflight falls back to strict.',
                        evidence: [
                            {
                                location: 'src/gates/next-step/next-step-review-artifact-readers.ts:140',
                                observation: 'Reused JSON findings are mapped through the receipt disposition policy.'
                            }
                        ],
                        coverage_obligation_ids: ['FILE-001']
                    }
                ],
                low: []
            },
            residual_risks: [],
            reviewer_notes: []
        }
    });
    const receiptPath = path.join(reviewsRoot, 'T-100-code-receipt.json');
    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as Record<string, unknown>;
    receipt.reused_from_review_context_sha256 = receipt.review_context_sha256;
    writeJson(receiptPath, receipt);

    const state = readReviewArtifactState(
        reviewsRoot,
        'T-100',
        'code',
        preflightPath,
        null,
        findingsPreflightPayload()
    );

    assert.equal(state.reusedExistingReview, true);
    assert.equal(state.verdictToken, 'REVIEW PASSED');
    assert.equal(state.failed, false);
    assert.ok(!state.violations.some((violation) => violation.includes('fix_now findings')));
});

test('readReviewArtifactState rejects malformed findings JSON instead of deriving a clean pass', () => {
    const fixtureRoot = tempRoot('garda-next-step-review-json-invalid-readers-');
    const reviewsRoot = path.join(fixtureRoot, 'runtime', 'reviews');
    const preflightPath = path.join(reviewsRoot, 'T-100-preflight.json');
    const contextPath = path.join(reviewsRoot, 'T-100-code-review-context.json');
    const artifactPath = path.join(reviewsRoot, 'T-100-code.md');
    const coverageContract: ReviewCoverageContract = {
        schema_version: 1,
        required: true,
        review_type: 'code',
        obligations: [{ id: 'FILE-001', kind: 'file', target: 'src/gates/next-step/next-step-review-artifact-readers.ts' }],
        obligation_count: 1,
        contract_sha256: COVERAGE_CONTRACT_SHA256
    };
    writeJson(contextPath, {
        schema_version: 3,
        task_id: 'T-100',
        review_type: 'code',
        preflight_path: preflightPath,
        preflight_sha256: null,
        tree_state: {
            tree_state_sha256: TREE_STATE_SHA256
        },
        coverage_contract: coverageContract
    });
    const contextSha256 = sha256File(contextPath);
    fs.writeFileSync(artifactPath, JSON.stringify({
        schema_version: 1,
        task_id: 'T-100',
        review_type: 'code',
        review_context_sha256: contextSha256,
        tree_state_sha256: TREE_STATE_SHA256,
        validation_notes: [],
        coverage_ledger: {
            coverage_contract_sha256: COVERAGE_CONTRACT_SHA256,
            entries: [{
                obligation_id: 'FILE-001',
                evidence: [{
                    location: 'src/gates/next-step/next-step-review-artifact-readers.ts:250',
                    observation: 'The invalid findings JSON branch was inspected.'
                }],
                finding_ids: []
            }]
        },
        findings: { critical: [], high: [], medium: [], low: [] },
        residual_risks: [],
        reviewer_notes: []
    }, null, 2) + '\n');
    const validation = validateReviewFindingsContract({
        content: fs.readFileSync(artifactPath, 'utf8'),
        expectedTaskId: 'T-100',
        expectedReviewType: 'code',
        expectedReviewContextSha256: contextSha256,
        expectedTreeStateSha256: TREE_STATE_SHA256,
        coverageContract
    });
    assert.equal(validation.valid, false);
    const rejectedValidationArtifact = buildReviewFindingsValidationArtifact({
        taskId: 'T-100',
        reviewType: 'code',
        validation,
        reviewOutputSha256: sha256File(artifactPath),
        reviewArtifactPath: artifactPath,
        reviewArtifactSha256: null,
        reviewContextPath: contextPath,
        reviewContextSha256: contextSha256,
        preflightPath,
        preflightSha256: null,
        scopeSha256: SCOPE_SHA256,
        reviewScopeSha256: null,
        codeScopeSha256: null,
        reviewTreeStateSha256: TREE_STATE_SHA256,
        coverageContract
    });
    writeJson(getReviewFindingsValidationArtifactPath(artifactPath), rejectedValidationArtifact);

    const state = readReviewArtifactState(
        reviewsRoot,
        'T-100',
        'code',
        preflightPath,
        null,
        findingsPreflightPayload()
    );

    assert.equal(state.verdictToken, 'CODE REVIEW FAILED');
    assert.equal(state.failed, true);
    assert.equal(state.failureKind, 'review-correction-full-review-required');
    assert.equal(state.reviewFindingsValidationRejected, true);
    assert.ok(state.violations.some((violation) => violation.includes('review findings validation artifact is rejected')));

    const correctionPath = getReviewOutputCorrectionArtifactPath(artifactPath);
    writeJson(correctionPath, { state: 'FULL_REVIEW_REQUIRED' });
    const readState = () => readReviewArtifactState(
        reviewsRoot, 'T-100', 'code', preflightPath, null, findingsPreflightPayload()
    );
    const restartDetails = {
        task_id: 'T-100', event_type: 'REVIEW_CYCLE_RESTARTED', status: 'PASSED',
        invalidated_review_types: ['code']
    };
    const restart = (details = restartDetails, actor = 'orchestrator') => appendMandatoryTaskEvent(
        fixtureRoot, 'T-100', 'REVIEW_CYCLE_RESTARTED', 'PASS', 'Restart fixture.', details, { actor }
    );
    restart();
    assert.equal(readState().failed, true, 'A restart before this correction cannot supersede it.');
    appendMandatoryTaskEvent(fixtureRoot, 'T-100', 'REVIEW_OUTPUT_CORRECTION_FULL_REVIEW_REQUIRED', 'FAIL',
        'Correction fallback fixture.', {
            task_id: 'T-100', review_type: 'code',
            correction_artifact_path: correctionPath,
            correction_artifact_sha256: 'a'.repeat(64),
            correction_package_sha256: sha256File(correctionPath)
        }, { actor: 'orchestrator' });
    restart(restartDetails, 'reviewer');
    assert.equal(readState().failed, true, 'A reviewer cannot supersede its own rejected output.');
    restart({ ...restartDetails, invalidated_review_types: ['security'] });
    assert.equal(readState().failed, true, 'An unrelated lane restart cannot supersede code evidence.');
    restart();
    const restarted = readState();
    assert.equal(restarted.failed, false);
    assert.equal(restarted.failureKind, null);
    assert.equal(restarted.receiptContractCurrent, false);
    assert.notEqual(restarted.verdictToken, 'REVIEW PASSED');
    assert.equal(fs.existsSync(correctionPath), true, 'Rejected evidence remains available for audit.');
    writeJson(correctionPath, { state: 'FULL_REVIEW_REQUIRED', changed: true });
    assert.equal(readState().failed, true, 'Replaced correction bytes cannot inherit the old restart.');
    writeJson(correctionPath, { state: 'FULL_REVIEW_REQUIRED' });
    for (const eventType of [
        'REVIEW_OUTPUT_CORRECTION_REQUIRED',
        'REVIEW_OUTPUT_CORRECTION_ONLY_INVOCATION',
        'REVIEW_OUTPUT_CORRECTION_API_CONTINUATION',
        'REVIEW_OUTPUT_CORRECTION_LIVE_CONTINUATION'
    ]) {
        writeJson(correctionPath, { state: 'REVIEW_OUTPUT_CORRECTION_REQUIRED', transport: eventType });
        const details = {
            task_id: 'T-100', review_type: 'code', correction_artifact_path: correctionPath,
            correction_package_sha256: sha256File(correctionPath)
        };
        appendMandatoryTaskEvent(fixtureRoot, 'T-100', eventType, 'FAIL',
            'Wrong correction outcome fixture.', details, { actor: 'orchestrator' });
        restart();
        assert.equal(readState().failed, true, 'A wrong outcome cannot authenticate pending correction supersession.');
        appendMandatoryTaskEvent(fixtureRoot, 'T-100', eventType, 'INFO',
            'Pending correction fixture.', details, { actor: 'orchestrator' });
        restart(restartDetails, 'reviewer');
        assert.equal(readState().failed, true, 'Pending correction still requires an orchestrator restart.');
        restart({ ...restartDetails, invalidated_review_types: ['security'] });
        assert.equal(readState().failed, true, 'Pending correction still requires the affected lane.');
        restart();
        assert.equal(readState().failed, false, eventType);
        assert.equal(readState().receiptContractCurrent, false, 'Supersession does not produce an accepted receipt.');
    }
    const timelinePath = path.join(fixtureRoot, 'runtime', 'task-events', 'T-100.jsonl');
    fs.appendFileSync(timelinePath, '{broken timeline}\n');
    assert.equal(readState().failed, true, 'A broken chain cannot authenticate supersession.');
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

test('getScopedDiffMetadataReadiness rejects missing and empty scoped diff metadata', () => {
    const reviewsRoot = tempRoot('garda-next-step-scoped-readers-');
    const metadataPath = path.join(reviewsRoot, 'T-100-code-scoped.json');
    const preflightPath = path.join(reviewsRoot, 'T-100-preflight.json');

    const missing = getScopedDiffMetadataReadiness({
        metadataPath,
        preflight: null,
        preflightPath,
        preflightSha256: null,
        reviewType: 'code'
    });
    assert.equal(missing.ready, false);
    assert.match(missing.reason, /Scoped diff metadata is missing/);

    fs.writeFileSync(metadataPath, JSON.stringify({ output_diff_line_count: 0 }));
    const empty = getScopedDiffMetadataReadiness({
        metadataPath,
        preflight: null,
        preflightPath,
        preflightSha256: null,
        reviewType: 'code'
    });
    assert.equal(empty.ready, false);
    assert.match(empty.reason, /has no output diff lines/);
});

test('review receipt domain matching fails closed for mismatched review type or missing scope', () => {
    assert.equal(reviewReceiptDomainScopeMatchesCurrentPreflight(
        { review_type: 'code' },
        { review_type: 'test' },
        { metrics: {} }
    ), false);
    assert.equal(reviewReceiptDomainScopeMatchesCurrentPreflight(
        { review_type: 'code' },
        null,
        { metrics: {} }
    ), false);
});

test('reader helpers expose scoped diff expectation and trust summary surfaces', () => {
    const reviewsRoot = tempRoot('garda-next-step-trust-readers-');
    assert.equal(scopedDiffExpectedForReview({ preflight: null, reviewType: 'code' }), false);

    const summary = readReviewTrust(reviewsRoot, 'T-100', ['code'], 'mixed');
    assert.ok(summary);
    assert.equal(summary.status, 'UNAVAILABLE');
});
