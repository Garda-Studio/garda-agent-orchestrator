import assert from 'node:assert/strict';
import test from 'node:test';
import {
    buildReviewCoverageContract, getReviewCoverageContractViolations, validateReviewCoverageLedger
} from '../../../../src/gates/review/review-coverage-ledger';
import type { QualityValidationObligation } from '../../../../src/gates/quality-checklist/quality-checklist-validation-phases';
import { sha256RedactedJsonPayload } from '../../../../src/core/redaction';
import { buildReviewFindingsValidationArtifact } from '../../../../src/gates/review/review-findings-validation-artifact';
import { buildReviewFindingsDispositionArtifact } from '../../../../src/gates/review/review-findings-disposition-artifact';
import { resolveLockedReviewFindingPolicyFromPreflight } from '../../../../src/gates/review/review-finding-disposition';
import { buildReviewRemediationBaselineArtifact } from '../../../../src/gates/review-remediation/review-remediation-baseline';

// Unit input for the contract builder; this is not native execution or review evidence.
const obligation: QualityValidationObligation = {
    id: 'a'.repeat(64), recipe_id: 'opaque', target_id: 'literal target', selector: 'declared case',
    source_identity: { path: 'RootSuite', sha256: 'b'.repeat(64), size: 17, identity: 'fixture identity' },
    snapshot_sha256: 'c'.repeat(64), execution: 'OBSERVED', attempt_id: 'fixture attempt',
    result_status: 'UNRESOLVED', result_sha256: 'd'.repeat(64)
};

function contractFor(binding: QualityValidationObligation) {
    return buildReviewCoverageContract({ reviewType: 'test', changedFiles: ['src/domain/catalog.ts'],
        validationObligations: [binding] });
}

test('frozen coverage requires every exact declared target without conventional source names', () => {
    const contract = contractFor(obligation);
    assert.deepEqual(contract.obligations.find(entry => entry.id === `VALIDATION-${obligation.id.toUpperCase()}`), {
        id: `VALIDATION-${obligation.id.toUpperCase()}`, kind: 'validation',
        target: 'opaque/literal target: declared case', source: 'RootSuite', validation_binding: obligation
    });
    assert.equal(contract.required, true);
});

test('coverage contract rejects stale source identity and replayed attempt bindings without semantic closure', () => {
    const baseline = contractFor(obligation).contract_sha256;
    assert.notEqual(contractFor({ ...obligation, source_identity: {
        ...obligation.source_identity, sha256: 'e'.repeat(64)
    } }).contract_sha256, baseline);
    assert.notEqual(contractFor({ ...obligation, attempt_id: 'different attempt' }).contract_sha256, baseline);
    assert.equal(getReviewCoverageContractViolations(contractFor(obligation), {
        reviewType: 'test', changedFiles: ['src/domain/catalog.ts'],
        validationObligations: [{ ...obligation, attempt_id: 'different attempt' }]
    }).length, 1);
    assert.equal(obligation.result_status, 'UNRESOLVED');
});

function outputFor(contract: ReturnType<typeof contractFor>, validationLocation = 'RootSuite:1') {
    return { coverage_ledger: { entries: contract.obligations.map(entry => ({
        obligation_id: entry.id, evidence: [{
            location: entry.id.startsWith('VALIDATION-') ? validationLocation : 'src/domain/catalog.ts:1',
            observation: 'The declared case retains the catalog source binding and opaque observed attempt without a semantic PASS.'
        }], finding_ids: []
    })) }, findings: { critical: [], high: [], medium: [], low: [] } };
}

test('declared target closure rejects foreign source evidence without expanding other obligation domains', () => {
    const contract = contractFor(obligation);
    assert.equal(validateReviewCoverageLedger(JSON.stringify(outputFor(contract)), contract).status, 'PASS');
    assert.equal(validateReviewCoverageLedger(JSON.stringify(outputFor(contract, 'src/domain/catalog.ts:1')), contract).status, 'FAIL');
    const wrongFile = outputFor(contract);
    wrongFile.coverage_ledger.entries[0].evidence[0].location = 'RootSuite:1';
    assert.equal(validateReviewCoverageLedger(JSON.stringify(wrongFile), contract).status, 'FAIL');
});

test('declared target closure rejects an omitted or duplicated exact obligation', () => {
    const contract = contractFor(obligation), missing = outputFor(contract);
    missing.coverage_ledger.entries = missing.coverage_ledger.entries.filter(entry => !entry.obligation_id.startsWith('VALIDATION-'));
    assert.equal(validateReviewCoverageLedger(JSON.stringify(missing), contract).status, 'FAIL');
    const duplicate = outputFor(contract);
    const entry = duplicate.coverage_ledger.entries.find(item => item.obligation_id.startsWith('VALIDATION-'));
    assert.ok(entry);
    duplicate.coverage_ledger.entries.push(entry);
    assert.equal(validateReviewCoverageLedger(JSON.stringify(duplicate), contract).status, 'FAIL');
});

// Synthetic in-memory constructor input only: no native launch, receipt or file is published.
function remediationInput(originCoverageContract: ReturnType<typeof contractFor>) {
    const taskId = 'T-UNIT-VALIDATION-ORIGIN', reviewType = 'test';
    const unitHash = sha256RedactedJsonPayload('in-memory validation origin fixture');
    const validationArtifact = buildReviewFindingsValidationArtifact({
        taskId, reviewType, coverageContract: originCoverageContract,
        reviewArtifactPath: 'unit/review.md', reviewArtifactSha256: unitHash,
        reviewContextPath: 'unit/context.json', reviewContextSha256: unitHash,
        reviewTreeStateSha256: unitHash, preflightPath: 'unit/preflight.json',
        preflightSha256: unitHash, scopeSha256: unitHash, reviewScopeSha256: unitHash,
        validation: { detected: true, valid: true, violations: [], coverage_validation: null,
            report: { schema_version: 2, task_id: taskId, review_type: reviewType,
                review_context_sha256: unitHash, tree_state_sha256: unitHash,
                validation_notes: [], coverage_ledger: { coverage_contract_sha256: originCoverageContract.contract_sha256,
                    entries: [] }, residual_risks: [], reviewer_notes: ['Unit constructor fixture only.'],
                findings: { critical: [], medium: [], low: [], high: [{ id: 'F-001',
                    title: 'Unit origin finding', description: 'Unit input requiring remediation.',
                    evidence: [{ location: 'src/domain/catalog.ts:1', observation: 'Unit bound source finding.' }],
                    coverage_obligation_ids: ['FILE-001'] }] }
            }
        }
    });
    const validationArtifactSha256 = sha256RedactedJsonPayload(validationArtifact);
    const dispositionArtifact = buildReviewFindingsDispositionArtifact({
        taskId, reviewType, validationArtifact, validationArtifactSha256,
        policyResolution: resolveLockedReviewFindingPolicyFromPreflight(null)
    });
    const receipt = { task_id: taskId, review_type: reviewType,
        review_artifact_sha256: unitHash, review_context_sha256: unitHash,
        review_tree_state_sha256: unitHash, review_findings_report_sha256: unitHash };
    return { taskId, reviewType, originCoverageContract, validationArtifact, validationArtifactSha256,
        validationArtifactPath: 'unit/validation.json', dispositionArtifact,
        dispositionArtifactSha256: sha256RedactedJsonPayload(dispositionArtifact),
        dispositionArtifactPath: 'unit/disposition.json', receipt,
        receiptSha256: sha256RedactedJsonPayload(receipt), receiptPath: 'unit/receipt.json',
        reviewArtifactPath: 'unit/review.md', reviewArtifactSha256: unitHash,
        profilePolicySnapshot: { snapshot_hash: unitHash }
    };
}

test('remediation origin preserves validation binding and rejects a self-consistent stale attempt', () => {
    const origin = contractFor(obligation), input = remediationInput(origin);
    assert.deepEqual(buildReviewRemediationBaselineArtifact(input).origin_coverage_contract, origin);
    const replaced = contractFor({ ...obligation, attempt_id: 'replayed attempt' });
    assert.throws(() => buildReviewRemediationBaselineArtifact({ ...input,
        originCoverageContract: replaced }), /authenticated findings-validation coverage hash/u);
});

test('remediation origin rejects a missing validation binding before reconstruction', () => {
    const input = remediationInput(contractFor(obligation));
    const malformed = structuredClone(input.originCoverageContract);
    Object.assign(malformed.obligations.find(entry => entry.kind === 'validation')!, { validation_binding: null });
    assert.throws(() => buildReviewRemediationBaselineArtifact({ ...input,
        originCoverageContract: malformed }), /invalid validation binding/u);
});
