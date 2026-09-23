import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createHash } from 'node:crypto';

import {
    bindAuthoritativeRemediationDecisionToPreflight,
    buildAuthenticatedRemediationReviewExecution
} from '../../../../src/cli/commands/gate-flows/review-context/review-context-flow';
import { appendTaskEvent } from '../../../../src/gate-runtime/task-events';
import {
    buildReviewCoverageAuditSummary,
    resolveAuditedReviewCoverageScope
} from '../../../../src/gates/task-audit/task-audit-summary-review-coverage';
import { buildReviewCoverageContract } from '../../../../src/gates/review/review-coverage-ledger';
import { buildReviewReceipt } from '../../../../src/gate-runtime/review-context';
import {
    buildReviewFindingsValidationArtifact,
    getReviewFindingsValidationArtifactPath
} from '../../../../src/gates/review/review-findings-validation-artifact';
import { validateReviewFindingsContract } from '../../../../src/gates/review/review-findings-artifact-verdict';
import { resolveReviewContextExecutionEvidenceBindings } from '../../../../src/gates/review/review-evidence-contract';
import { buildReviewRemediationReviewContract } from '../../../../src/gates/review-remediation/review-remediation-review-contract';
import { resolveAuthoritativeReviewRemediationDecision } from '../../../../src/gates/review-remediation/review-remediation-recovery-routing';
import { sha256RedactedJsonPayload } from '../../../../src/core/redaction';

function writeJson(filePath: string, value: unknown): void {
    fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function fileSha256(filePath: string): string {
    return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

test('review coverage audit uses authenticated DELTA targets and rejects unauthenticated narrowing', () => {
    const fullChangedFiles = ['src/example.ts', 'tests/example.test.ts'];
    const deltaExecution = {
        mode: 'DELTA',
        delta: { required_delta_targets: ['tests/example.test.ts'] }
    } as ReturnType<typeof buildReviewRemediationReviewContract>;
    const deltaScope = resolveAuditedReviewCoverageScope({
        fullChangedFiles,
        reviewExecution: deltaExecution,
        executionAuthorityValid: true
    });
    assert.deepEqual(deltaScope, ['tests/example.test.ts']);
    assert.notEqual(
        buildReviewCoverageContract({ reviewType: 'test', changedFiles: deltaScope }).contract_sha256,
        buildReviewCoverageContract({ reviewType: 'test', changedFiles: fullChangedFiles }).contract_sha256
    );
    assert.deepEqual(resolveAuditedReviewCoverageScope({
        fullChangedFiles,
        reviewExecution: deltaExecution,
        executionAuthorityValid: false
    }), fullChangedFiles);
    assert.deepEqual(resolveAuditedReviewCoverageScope({
        fullChangedFiles,
        reviewExecution: { ...deltaExecution, mode: 'FULL' },
        executionAuthorityValid: true
    }), fullChangedFiles);
});

test('review coverage audit exposes complete and omitted obligation diagnostics', () => {
    const reviewsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-coverage-audit-'));
    const taskId = 'T-976-audit';
    const contract = buildReviewCoverageContract({ reviewType: 'code', changedFiles: ['src/example.ts'] });
    const omittedId = contract.obligations[1].id;
    fs.writeFileSync(path.join(reviewsRoot, `${taskId}-preflight.json`), JSON.stringify({
        changed_files: ['src/example.ts']
    }), 'utf8');
    fs.writeFileSync(path.join(reviewsRoot, `${taskId}-code-review-context.json`), JSON.stringify({
        schema_version: 3,
        coverage_contract: contract
    }), 'utf8');
    fs.writeFileSync(path.join(reviewsRoot, `${taskId}-code-receipt.json`), JSON.stringify({
        review_coverage: {
            status: 'FAIL',
            contract_sha256: contract.contract_sha256,
            obligation_count: contract.obligation_count,
            completed_obligation_count: contract.obligation_count - 1,
            omitted_obligation_ids: [omittedId],
            duplicate_obligation_ids: [],
            unknown_obligation_ids: [],
            finding_ids: ['F-001']
        }
    }), 'utf8');

    const incomplete = buildReviewCoverageAuditSummary({
        reviewsRoot,
        taskId,
        requiredReviews: { code: true }
    });
    assert.equal(incomplete.status, 'INCOMPLETE');
    assert.deepEqual(incomplete.omitted_obligation_ids, [`code:${omittedId}`]);
    assert.match(incomplete.visible_summary_line, new RegExp(`obligations=${contract.obligation_count - 1}\\/${contract.obligation_count}`));
    assert.match(incomplete.visible_summary_line, new RegExp(`omitted=code:${omittedId}`));
    assert.ok(incomplete.entries[0]?.violations.includes('receipt coverage status is not PASS'));

    const receiptPath = path.join(reviewsRoot, `${taskId}-code-receipt.json`);
    fs.writeFileSync(receiptPath, JSON.stringify({
        review_coverage: {
            status: 'PASS',
            contract_sha256: contract.contract_sha256,
            obligation_count: contract.obligation_count,
            completed_obligation_count: contract.obligation_count,
            omitted_obligation_ids: [],
            duplicate_obligation_ids: [],
            unknown_obligation_ids: [],
            finding_ids: ['F-001', 'F-002']
        }
    }), 'utf8');
    const complete = buildReviewCoverageAuditSummary({
        reviewsRoot,
        taskId,
        requiredReviews: { code: true }
    });
    assert.equal(complete.status, 'COMPLETE');
    assert.match(complete.visible_summary_line, new RegExp(`obligations=${contract.obligation_count}\\/${contract.obligation_count}`));

    fs.writeFileSync(receiptPath, JSON.stringify({
        review_coverage: {
            status: 'PASS',
            contract_sha256: 'forged',
            obligation_count: contract.obligation_count,
            completed_obligation_count: contract.obligation_count,
            omitted_obligation_ids: [],
            duplicate_obligation_ids: [],
            unknown_obligation_ids: []
        }
    }), 'utf8');
    const mismatched = buildReviewCoverageAuditSummary({
        reviewsRoot,
        taskId,
        requiredReviews: { code: true }
    });
    assert.equal(mismatched.status, 'INCOMPLETE');
    assert.ok(mismatched.entries[0]?.violations.includes('receipt coverage contract hash mismatch'));

    fs.rmSync(reviewsRoot, { recursive: true, force: true });
});

test('review coverage audit accepts a current contract whose ledger is not required', () => {
    const reviewsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-coverage-not-required-'));
    const taskId = 'T-979-coverage-not-required';
    const contract = buildReviewCoverageContract({ reviewType: 'code', changedFiles: [] });
    fs.writeFileSync(path.join(reviewsRoot, `${taskId}-preflight.json`), JSON.stringify({
        changed_files: ['tests/example.test.ts']
    }), 'utf8');
    fs.writeFileSync(path.join(reviewsRoot, `${taskId}-code-review-context.json`), JSON.stringify({
        schema_version: 3,
        coverage_contract: contract
    }), 'utf8');
    fs.writeFileSync(path.join(reviewsRoot, `${taskId}-code-receipt.json`), JSON.stringify({
        review_coverage: {
            status: 'PASS',
            required: false,
            contract_sha256: contract.contract_sha256,
            obligation_count: contract.obligation_count,
            completed_obligation_count: 0,
            omitted_obligation_ids: [],
            duplicate_obligation_ids: [],
            unknown_obligation_ids: [],
            finding_ids: []
        }
    }), 'utf8');

    const summary = buildReviewCoverageAuditSummary({
        reviewsRoot,
        taskId,
        requiredReviews: { code: true }
    });

    assert.equal(summary.status, 'COMPLETE');
    assert.deepEqual(summary.omitted_obligation_ids, []);
    assert.deepEqual(summary.entries[0]?.violations, []);
    fs.rmSync(reviewsRoot, { recursive: true, force: true });
});

test('review coverage audit preserves legacy context compatibility', () => {
    const reviewsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-coverage-legacy-'));
    const taskId = 'T-976-legacy';
    const preflightPath = path.join(reviewsRoot, `${taskId}-preflight.json`);
    const contextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
    const receiptPath = path.join(reviewsRoot, `${taskId}-code-receipt.json`);
    const preflightText = JSON.stringify({ changed_files: ['src/example.ts'] });
    const contextText = JSON.stringify({
        schema_version: 2
    });
    fs.writeFileSync(preflightPath, preflightText, 'utf8');
    fs.writeFileSync(contextPath, contextText, 'utf8');
    const preflightSha256 = createHash('sha256').update(preflightText).digest('hex');
    const contextSha256 = createHash('sha256').update(contextText).digest('hex');
    fs.writeFileSync(receiptPath, JSON.stringify({
        preflight_sha256: preflightSha256,
        review_context_sha256: contextSha256
    }), 'utf8');

    const summary = buildReviewCoverageAuditSummary({
        reviewsRoot,
        taskId,
        requiredReviews: { code: true },
        orderedEvents: [{
            event_type: 'REVIEW_RECORDED',
            details: {
                review_type: 'code',
                preflight_sha256: preflightSha256,
                review_context_sha256: contextSha256
            }
        }]
    });
    assert.equal(summary.status, 'COMPLETE');
    assert.equal(summary.entries[0]?.status, 'LEGACY_NOT_REQUIRED');

    fs.writeFileSync(contextPath, JSON.stringify({ schema_version: 1 }), 'utf8');
    const downgraded = buildReviewCoverageAuditSummary({
        reviewsRoot,
        taskId,
        requiredReviews: { code: true },
        orderedEvents: []
    });
    assert.equal(downgraded.status, 'INCOMPLETE');
    assert.ok(downgraded.entries[0]?.violations.some((entry) => entry.includes('legacy review coverage exemption')));
    assert.ok(downgraded.omitted_obligation_ids.includes('code:FILE-001'));

    fs.rmSync(reviewsRoot, { recursive: true, force: true });
});

test('review coverage audit rejects missing or invalid context instead of treating it as legacy', () => {
    const reviewsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-coverage-invalid-context-'));
    const taskId = 'T-976-invalid-context';
    fs.writeFileSync(path.join(reviewsRoot, `${taskId}-code-review-context.json`), JSON.stringify({
        schema_version: null
    }), 'utf8');

    const summary = buildReviewCoverageAuditSummary({
        reviewsRoot,
        taskId,
        requiredReviews: { code: true }
    });

    assert.equal(summary.status, 'INCOMPLETE');
    assert.ok(summary.entries[0]?.violations.some((entry) => entry.includes('invalid schema version')));
    fs.rmSync(reviewsRoot, { recursive: true, force: true });
});

test('review coverage audit lists every contract obligation when the receipt is missing', () => {
    const reviewsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-coverage-missing-receipt-'));
    const taskId = 'T-976-missing-receipt';
    const contract = buildReviewCoverageContract({
        reviewType: 'code',
        changedFiles: ['src/example.ts']
    });
    fs.writeFileSync(path.join(reviewsRoot, `${taskId}-preflight.json`), JSON.stringify({
        changed_files: ['src/example.ts']
    }), 'utf8');
    fs.writeFileSync(path.join(reviewsRoot, `${taskId}-code-review-context.json`), JSON.stringify({
        schema_version: 3,
        coverage_contract: contract
    }), 'utf8');

    const summary = buildReviewCoverageAuditSummary({
        reviewsRoot,
        taskId,
        requiredReviews: { code: true }
    });

    assert.equal(summary.status, 'INCOMPLETE');
    const expectedOmitted = contract.obligations.map((entry) => `code:${entry.id}`).sort();
    assert.deepEqual(summary.omitted_obligation_ids, expectedOmitted);
    assert.ok(expectedOmitted.every((entry) => summary.visible_summary_line.includes(entry)));
    fs.rmSync(reviewsRoot, { recursive: true, force: true });
});

test('review coverage audit rejects a forged context and receipt that omit authoritative scope', () => {
    const reviewsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-coverage-forged-scope-'));
    const taskId = 'T-976-forged-scope';
    const forgedContract = buildReviewCoverageContract({ reviewType: 'code', changedFiles: [] });
    fs.writeFileSync(path.join(reviewsRoot, `${taskId}-preflight.json`), JSON.stringify({
        changed_files: ['src/example.ts']
    }), 'utf8');
    fs.writeFileSync(path.join(reviewsRoot, `${taskId}-code-review-context.json`), JSON.stringify({
        schema_version: 3,
        coverage_contract: forgedContract
    }), 'utf8');
    fs.writeFileSync(path.join(reviewsRoot, `${taskId}-code-receipt.json`), JSON.stringify({
        review_coverage: {
            status: 'PASS',
            contract_sha256: forgedContract.contract_sha256,
            obligation_count: 0,
            completed_obligation_count: 0,
            omitted_obligation_ids: [],
            duplicate_obligation_ids: [],
            unknown_obligation_ids: []
        }
    }), 'utf8');

    const summary = buildReviewCoverageAuditSummary({
        reviewsRoot,
        taskId,
        requiredReviews: { code: true }
    });

    assert.equal(summary.status, 'INCOMPLETE');
    assert.ok(summary.entries[0]?.violations.some((entry) => entry.includes('does not match')));
    assert.ok(summary.omitted_obligation_ids.includes('code:FILE-001'));
    fs.rmSync(reviewsRoot, { recursive: true, force: true });
});

test('review coverage audit preserves deleted-file obligations in authoritative scope', () => {
    const reviewsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-coverage-deleted-file-'));
    const taskId = 'T-976-deleted-file';
    const deletedPath = 'src/deleted-example.ts';
    const contract = buildReviewCoverageContract({ reviewType: 'code', changedFiles: [deletedPath] });
    const contextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
    const receiptPath = path.join(reviewsRoot, `${taskId}-code-receipt.json`);
    fs.writeFileSync(path.join(reviewsRoot, `${taskId}-preflight.json`), JSON.stringify({
        changed_files: [deletedPath]
    }), 'utf8');
    fs.writeFileSync(contextPath, JSON.stringify({
        schema_version: 3,
        coverage_contract: contract
    }), 'utf8');
    fs.writeFileSync(receiptPath, JSON.stringify({
        review_coverage: {
            status: 'PASS',
            contract_sha256: contract.contract_sha256,
            obligation_count: contract.obligation_count,
            completed_obligation_count: contract.obligation_count,
            omitted_obligation_ids: [],
            duplicate_obligation_ids: [],
            unknown_obligation_ids: []
        }
    }), 'utf8');

    const complete = buildReviewCoverageAuditSummary({
        reviewsRoot,
        taskId,
        requiredReviews: { code: true }
    });
    assert.equal(complete.status, 'COMPLETE');
    assert.match(complete.visible_summary_line, new RegExp(`obligations=${contract.obligation_count}\\/${contract.obligation_count}`));

    const forgedContract = buildReviewCoverageContract({ reviewType: 'code', changedFiles: [] });
    fs.writeFileSync(contextPath, JSON.stringify({
        schema_version: 3,
        coverage_contract: forgedContract
    }), 'utf8');
    fs.writeFileSync(receiptPath, JSON.stringify({
        review_coverage: {
            status: 'PASS',
            contract_sha256: forgedContract.contract_sha256,
            obligation_count: 0,
            completed_obligation_count: 0,
            omitted_obligation_ids: [],
            duplicate_obligation_ids: [],
            unknown_obligation_ids: []
        }
    }), 'utf8');

    const forged = buildReviewCoverageAuditSummary({
        reviewsRoot,
        taskId,
        requiredReviews: { code: true }
    });
    assert.equal(forged.status, 'INCOMPLETE');
    assert.ok(forged.entries[0]?.violations.some((entry) => entry.includes('does not match')));
    assert.ok(forged.omitted_obligation_ids.includes('code:FILE-001'));
    fs.rmSync(reviewsRoot, { recursive: true, force: true });
});

test('review coverage audit rejects stale schema-4 findings-validation execution lineage', () => {
    const reviewsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-coverage-execution-lineage-'));
    const taskId = 'T-992-audit-lineage';
    const reviewType = 'code';
    const changedFile = 'src/example.ts';
    const treeStateSha256 = 'b'.repeat(64);
    const scopeSha256 = 'd'.repeat(64);
    const preflightPath = path.join(reviewsRoot, `${taskId}-preflight.json`);
    const contextPath = path.join(reviewsRoot, `${taskId}-${reviewType}-review-context.json`);
    const reviewArtifactPath = path.join(reviewsRoot, `${taskId}-${reviewType}.md`);
    const receiptPath = path.join(reviewsRoot, `${taskId}-${reviewType}-receipt.json`);
    const preflight = {
        changed_files: [changedFile, 'tests/example.test.ts', 'docs/example.md']
    };
    writeJson(preflightPath, preflight);
    const preflightSha256 = fileSha256(preflightPath);
    const coverageContract = buildReviewCoverageContract({ reviewType, changedFiles: [changedFile] });
    const reviewExecution = buildReviewRemediationReviewContract({
        taskId,
        reviewType,
        preflightSha256,
        fullReviewScope: [changedFile]
    });
    const context = {
        schema_version: 4,
        task_id: taskId,
        review_type: reviewType,
        preflight_path: preflightPath,
        preflight_sha256: preflightSha256,
        tree_state: { tree_state_sha256: treeStateSha256 },
        coverage_contract: coverageContract,
        review_execution: reviewExecution
    };
    writeJson(contextPath, context);
    const contextSha256 = fileSha256(contextPath);
    const report = {
        schema_version: 2,
        task_id: taskId,
        review_type: reviewType,
        review_context_sha256: contextSha256,
        tree_state_sha256: treeStateSha256,
        validation_notes: [{
            id: 'N-001',
            topic: 'execution lineage',
            note: 'Inspected task-audit execution lineage.',
            evidence: [{ location: `${changedFile}:1`, observation: 'Audit input was inspected.' }]
        }],
        coverage_ledger: {
            coverage_contract_sha256: coverageContract.contract_sha256,
            entries: coverageContract.obligations.map((obligation) => ({
                obligation_id: obligation.id,
                evidence: [{
                    location: `${changedFile}:1`,
                    observation: `Schema-4 audit execution lineage was checked for ${obligation.id}.`
                }],
                finding_ids: []
            }))
        },
        review_execution: {
            mode: reviewExecution.mode,
            contract_sha256: reviewExecution.contract_sha256,
            covered_delta_targets: [],
            inspected_prior_finding_ids: []
        },
        findings: { critical: [], high: [], medium: [], low: [] },
        residual_risks: [],
        reviewer_notes: []
    };
    writeJson(reviewArtifactPath, report);
    const reviewArtifactSha256 = fileSha256(reviewArtifactPath);
    const validation = validateReviewFindingsContract({
        content: fs.readFileSync(reviewArtifactPath, 'utf8'),
        expectedTaskId: taskId,
        expectedReviewType: reviewType,
        expectedReviewContextSha256: contextSha256,
        expectedTreeStateSha256: treeStateSha256,
        coverageContract,
        expectedReviewExecutionContract: reviewExecution
    });
    assert.equal(validation.valid, true, validation.violations.join(' '));
    const validationArtifactPath = getReviewFindingsValidationArtifactPath(reviewArtifactPath);
    const validationArtifact = buildReviewFindingsValidationArtifact({
        taskId,
        reviewType,
        validation,
        reviewOutputSha256: reviewArtifactSha256,
        reviewArtifactPath,
        reviewArtifactSha256,
        reviewContextPath: contextPath,
        reviewContextSha256: contextSha256,
        preflightPath,
        preflightSha256,
        scopeSha256,
        reviewScopeSha256: 'e'.repeat(64),
        codeScopeSha256: 'f'.repeat(64),
        reviewTreeStateSha256: treeStateSha256,
        coverageContract
    });
    writeJson(validationArtifactPath, validationArtifact);
    let validationArtifactSha256 = fileSha256(validationArtifactPath);
    const executionBindings = resolveReviewContextExecutionEvidenceBindings(context).bindings!;
    const receipt = buildReviewReceipt({
        taskId,
        reviewType,
        preflightSha256,
        scopeSha256,
        reviewScopeSha256: 'e'.repeat(64),
        codeScopeSha256: 'f'.repeat(64),
        reviewContextSha256: contextSha256,
        reviewTreeStateSha256: treeStateSha256,
        reviewExecutionMode: executionBindings.review_execution_mode,
        reviewExecutionContractSha256: executionBindings.review_execution_contract_sha256,
        reviewExecutionFullScopeSha256: executionBindings.review_execution_full_scope_sha256,
        reviewExecutionCompleteScopeLineageSha256: executionBindings.review_execution_complete_scope_lineage_sha256,
        reviewExecutionFindingReconciliationSha256: executionBindings.review_execution_finding_reconciliation_sha256,
        reviewArtifactSha256,
        reviewerExecutionMode: 'delegated_subagent',
        reviewerIdentity: 'agent:audit-lineage',
        trustLevel: 'INDEPENDENT_AUDITED'
    }) as unknown as Record<string, unknown>;
    receipt.review_output_sha256 = reviewArtifactSha256;
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
        coverage_contract_sha256: coverageContract.contract_sha256,
        validation_artifact_sha256: validationArtifactSha256,
        validation_result_sha256: validationArtifact.validation_result_sha256,
        ...executionBindings
    };
    writeJson(receiptPath, receipt);

    const exact = buildReviewCoverageAuditSummary({ reviewsRoot, taskId, requiredReviews: { code: true } });
    assert.equal(exact.status, 'COMPLETE');
    assert.equal(exact.entries[0]?.review_execution_mode, 'FULL');
    assert.equal(exact.entries[0]?.review_execution_source, 'initial_full');
    assert.deepEqual(exact.review_execution_modes, {
        full_count: 1,
        delta_count: 0,
        legacy_unknown_count: 0
    });
    assert.match(exact.visible_summary_line, /modes=FULL:1,DELTA:0,legacy_unknown:0/u);

    const forgedExecution = buildReviewRemediationReviewContract({
        taskId,
        reviewType,
        preflightSha256,
        fullReviewScope: ['src/forged.ts']
    });
    writeJson(contextPath, { ...context, review_execution: forgedExecution });
    const forgedContext = buildReviewCoverageAuditSummary({
        reviewsRoot,
        taskId,
        requiredReviews: { code: true }
    });
    assert.equal(forgedContext.status, 'INCOMPLETE');
    assert.ok(forgedContext.entries[0]?.violations.some((violation) =>
        violation.includes('review context execution authority')
        && violation.includes('full review scope')
    ), JSON.stringify(forgedContext.entries[0]?.violations));
    writeJson(contextPath, context);

    const validationResult = validationArtifact.validation_result as unknown as Record<string, unknown>;
    const validationBindings = validationResult.bindings as Record<string, unknown>;
    (validationBindings.execution as Record<string, unknown>).review_execution_finding_reconciliation_sha256 = '0'.repeat(64);
    validationArtifact.validation_result_sha256 = sha256RedactedJsonPayload(validationResult);
    writeJson(validationArtifactPath, validationArtifact);
    validationArtifactSha256 = fileSha256(validationArtifactPath);
    Object.assign(receipt.review_findings_validation as Record<string, unknown>, {
        artifact_sha256: validationArtifactSha256,
        validation_result_sha256: validationArtifact.validation_result_sha256
    });
    Object.assign(receipt.review_output_contract as Record<string, unknown>, {
        validation_artifact_sha256: validationArtifactSha256,
        validation_result_sha256: validationArtifact.validation_result_sha256
    });
    writeJson(receiptPath, receipt);

    const stale = buildReviewCoverageAuditSummary({ reviewsRoot, taskId, requiredReviews: { code: true } });
    assert.equal(stale.status, 'INCOMPLETE');
    assert.ok(stale.entries[0]?.violations.some((violation) =>
        violation.includes('review_execution_finding_reconciliation_sha256')
    ));
    fs.rmSync(reviewsRoot, { recursive: true, force: true });
});

test('review coverage audit validates remediation execution against the task-wide preflight scope', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-coverage-remediation-scope-'));
    const bundleRoot = path.join(root, 'garda-agent-orchestrator');
    const reviewsRoot = path.join(bundleRoot, 'runtime', 'reviews');
    const taskId = 'T-1013-remediation-scope';
    const reviewType = 'code';
    const laneFile = 'src/example.ts';
    const taskWideScope = [laneFile, 'tests/example.test.ts', 'docs/example.md'];
    fs.mkdirSync(reviewsRoot, { recursive: true });
    const preflightPath = path.join(reviewsRoot, `${taskId}-preflight.json`);
    writeJson(preflightPath, { changed_files: taskWideScope });
    const preflightSha256 = fileSha256(preflightPath);
    const classification = {
        source: 'runtime_fix' as const,
        classification: {
            category: 'production',
            reason: 'Production remediation requires a fresh code review.',
            blocked_before_reuse: false,
            invalidated_review_types: [reviewType]
        }
    };
    const decision = bindAuthoritativeRemediationDecisionToPreflight(
        resolveAuthoritativeReviewRemediationDecision({
            taskId,
            currentReviewType: reviewType,
            classification,
            requiredReviews: { code: true },
            reviewExecutionPolicyMode: 'strict_sequential'
        }),
        preflightSha256
    );
    appendTaskEvent(bundleRoot, taskId, 'REVIEW_CYCLE_RESTARTED', 'PASS', 'Review cycle restarted.', {
        task_id: taskId,
        event_type: 'REVIEW_CYCLE_RESTARTED',
        status: 'PASSED',
        preflight_sha256: preflightSha256,
        authoritative_review_decision: decision,
        authoritative_review_classification: classification
    });
    const remediationExecution = buildAuthenticatedRemediationReviewExecution({
        taskId,
        reviewType,
        preflightSha256,
        fullReviewScope: taskWideScope,
        authoritativeDecision: decision,
        authoritativeClassification: classification
    }).contract;
    const contextPath = path.join(reviewsRoot, `${taskId}-${reviewType}-review-context.json`);
    const coverageContract = buildReviewCoverageContract({ reviewType, changedFiles: [laneFile] });
    writeJson(contextPath, {
        schema_version: 4,
        task_id: taskId,
        review_type: reviewType,
        coverage_contract: coverageContract,
        review_execution: remediationExecution
    });

    const valid = buildReviewCoverageAuditSummary({ reviewsRoot, taskId, requiredReviews: { code: true } });
    assert.ok(valid.entries[0]?.violations.every((violation) =>
        !violation.includes('review context execution authority')
    ), JSON.stringify(valid.entries[0]?.violations));

    const forgedExecution = buildAuthenticatedRemediationReviewExecution({
        taskId,
        reviewType,
        preflightSha256,
        fullReviewScope: [laneFile],
        authoritativeDecision: decision,
        authoritativeClassification: classification
    }).contract;
    writeJson(contextPath, {
        schema_version: 4,
        task_id: taskId,
        review_type: reviewType,
        coverage_contract: coverageContract,
        review_execution: forgedExecution
    });
    const forged = buildReviewCoverageAuditSummary({ reviewsRoot, taskId, requiredReviews: { code: true } });
    assert.ok(forged.entries[0]?.violations.some((violation) =>
        violation.includes('review context execution authority')
        && violation.includes('full review scope')
    ), JSON.stringify(forged.entries[0]?.violations));
    fs.rmSync(root, { recursive: true, force: true });
});
