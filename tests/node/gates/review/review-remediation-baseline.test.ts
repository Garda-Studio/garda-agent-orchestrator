import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { serializeRedactedJson, sha256RedactedJsonPayload } from '../../../../src/core/redaction';
import { buildReviewCoverageContract } from '../../../../src/gates/review/review-coverage-ledger';
import type { ReviewFindingsDispositionArtifact } from '../../../../src/gates/review/review-findings-disposition-artifact';
import type { ReviewFindingsValidationArtifact } from '../../../../src/gates/review/review-findings-validation-artifact';
import {
    buildReviewRemediationBaselineArtifact,
    REVIEW_REMEDIATION_BASELINE_LEGACY_SCHEMA_VERSION,
    REVIEW_REMEDIATION_BASELINE_SCHEMA_VERSION,
    validateReviewRemediationBaselineArtifact
} from '../../../../src/gates/review-remediation/review-remediation-baseline';
import {
    buildReviewRemediationDeltaBase,
    getReviewRemediationDeltaBaseViolations,
    REVIEW_REMEDIATION_DELTA_MAX_LINES_PER_FILE,
    REVIEW_REMEDIATION_DELTA_MAX_SNAPSHOT_BYTES,
    REVIEW_REMEDIATION_DELTA_MAX_SNAPSHOT_FILES,
    REVIEW_REMEDIATION_DELTA_MAX_SNAPSHOT_LINES,
    REVIEW_REMEDIATION_DELTA_MAX_TEXT_BYTES
} from '../../../../src/gates/review-remediation/review-remediation-delta-contract';
import {
    classifyReviewRemediationDelta,
    REVIEW_REMEDIATION_DELTA_DIFF_PAGE_MAX_BYTES,
    REVIEW_REMEDIATION_DELTA_MAX_DIFF_WORK_UNITS
} from '../../../../src/gates/review-remediation/review-remediation-delta';
import {
    getReviewRemediationDeltaClassificationViolations
} from '../../../../src/gates/review-remediation/review-remediation-validation-evidence';

const temporaryRoots: string[] = [];
const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
const requireFromTest = createRequire(__filename);

function createTempRoot(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-remediation-baseline-'));
    temporaryRoots.push(root);
    return root;
}

function writeJson(filePath: string, payload: unknown): string {
    fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function buildFixture(root: string) {
    const taskId = 'T-979-35-fixture';
    const reviewType = 'code';
    const reviewArtifactPath = path.join(root, `${taskId}-code.md`);
    const receiptPath = path.join(root, `${taskId}-code-receipt.json`);
    const validationArtifactPath = path.join(root, `${taskId}-code-findings-validation.json`);
    const dispositionArtifactPath = path.join(root, `${taskId}-code-findings-disposition.json`);
    const reviewArtifactSha256 = hash('review-artifact');
    const contextSha256 = hash('context');
    const treeSha256 = hash('tree');
    const scopeSha256 = hash('scope');
    const preflightSha256 = hash('preflight');
    const reviewScopeSha256 = hash('review-scope');
    const codeScopeSha256 = hash('code-scope');
    const originCoverageContract = buildReviewCoverageContract({
        reviewType, changedFiles: ['src/example.ts', 'src/second.ts']
    });
    const validationResult = {
        status: 'accepted' as const,
        accepted: true,
        detected: true,
        violations: [],
        coverage_status: null,
        normalized_inventory: {
            finding_count: 2,
            residual_risk_count: 0,
            findings_by_severity: {
                critical: [],
                high: [{
                    id: 'F-001',
                    severity: 'high' as const,
                    title: 'Bound defect',
                    description: 'A concrete defect requires remediation.',
                    evidence_locations: ['src/example.ts:17'],
                    coverage_obligation_ids: ['FILE-001']
                }, {
                    id: 'F-002',
                    severity: 'high' as const,
                    title: 'Second bound defect',
                    description: 'A second concrete defect requires remediation.',
                    evidence_locations: ['src/second.ts:23'],
                    coverage_obligation_ids: ['FILE-002']
                }],
                medium: [],
                low: []
            },
            residual_risks: []
        },
        evidence_diagnostics: {
            validation_note_evidence_locations: [],
            coverage_evidence_locations: ['src/example.ts:17'],
            finding_evidence_locations: ['src/example.ts:17'],
            residual_risk_evidence_locations: [],
            total_evidence_locations: 2
        },
        bindings: {
            input: { review_output_sha256: hash('output') },
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
                preflight_sha256: preflightSha256,
                scope_sha256: scopeSha256,
                review_scope_sha256: reviewScopeSha256,
                code_scope_sha256: codeScopeSha256
            },
            tree: { review_tree_state_sha256: treeSha256 },
            coverage_contract_sha256: originCoverageContract.contract_sha256
        }
    };
    const validationArtifact: ReviewFindingsValidationArtifact = {
        schema_version: 1,
        artifact_type: 'review_findings_validation',
        task_id: taskId,
        review_type: reviewType,
        validation_result: validationResult,
        validation_result_sha256: sha256RedactedJsonPayload(validationResult)
    };
    const validationArtifactSha256 = sha256RedactedJsonPayload(validationArtifact);
    const dispositionResult = {
        schema_version: 1 as const,
        policy_id: 'balanced' as const,
        policy_source: 'preflight_profile_policy_snapshot' as const,
        policy_diagnostics: [],
        findings: {
            critical: { action: 'fix_now' as const, ids: [], count: 0 },
            high: { action: 'fix_now' as const, ids: ['F-001', 'F-002'], count: 2 },
            medium: { action: 'create_follow_up' as const, ids: [], count: 0 },
            low: { action: 'create_follow_up' as const, ids: [], count: 0 }
        },
        residual_risks: { action: 'create_follow_up' as const, ids: [], count: 0 },
        counts_by_action: { fix_now: 2, create_follow_up: 0, ignore: 0 },
        blocking_count: 2,
        blocking_ids: ['F-001', 'F-002'],
        non_blocking_count: 0,
        total_count: 2,
        verdict: 'fail_for_fix_now' as const
    };
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
    const dispositionArtifact: ReviewFindingsDispositionArtifact = {
        schema_version: 1,
        artifact_type: 'review_findings_disposition',
        task_id: taskId,
        review_type: reviewType,
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
        }, {
            id: 'F-002',
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
            item_count: 2,
            fix_now_count: 2,
            follow_up_pending_count: 0,
            ignored_count: 0,
            blocking_count: 2,
            non_blocking_count: 0
        }
    };
    const dispositionArtifactSha256 = sha256RedactedJsonPayload(dispositionArtifact);
    const findingsReportSha256 = hash('findings-report');
    const receipt = {
        task_id: taskId,
        review_type: reviewType,
        review_artifact_sha256: reviewArtifactSha256,
        review_context_sha256: contextSha256,
        review_tree_state_sha256: treeSha256,
        review_findings_report_sha256: findingsReportSha256
    };
    const receiptSha256 = sha256RedactedJsonPayload(receipt);
    const profilePolicySnapshotSha256 = hash('profile-policy-snapshot');
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.mkdirSync(path.join(root, 'tests', 'node', 'helpers'), { recursive: true });
    fs.mkdirSync(path.join(root, 'tests', 'node', 'snapshots'), { recursive: true });
    fs.mkdirSync(path.join(root, 'template', 'config'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'example.ts'), 'export const example = true;\n', 'utf8');
    fs.writeFileSync(path.join(root, 'src', 'second.ts'), 'export const second = true;\n', 'utf8');
    fs.writeFileSync(path.join(root, 'tests', 'node', 'example.test.ts'), 'assert.equal(example, true);\n', 'utf8');
    fs.writeFileSync(path.join(root, 'tests', 'node', 'helpers', 'shared.ts'), 'export const fixture = true;\n', 'utf8');
    fs.writeFileSync(path.join(root, 'tests', 'node', 'snapshots', 'example.snap'), 'snapshot-v1\n', 'utf8');
    fs.writeFileSync(path.join(root, 'template', 'config', 'paths.json'), '{"version":1}\n', 'utf8');
    const deltaBaseFiles = [
        'src/example.ts',
        'src/second.ts',
        'template/config/paths.json',
        'tests/node/example.test.ts',
        'tests/node/helpers/shared.ts',
        'tests/node/snapshots/example.snap'
    ];
    const deltaBase = buildReviewRemediationDeltaBase({
        repoRoot: root,
        taskId,
        reviewType,
        reviewTreeStateSha256: treeSha256,
        changedFiles: deltaBaseFiles
    });
    const builderOptions = {
        taskId,
        reviewType,
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
        originCoverageContract,
        deltaBase
    };
    const baseline = buildReviewRemediationBaselineArtifact(builderOptions);
    fs.writeFileSync(reviewArtifactPath, 'review-artifact', 'utf8');
    assert.equal(writeJson(receiptPath, receipt), receiptSha256);
    assert.equal(writeJson(validationArtifactPath, validationArtifact), validationArtifactSha256);
    assert.equal(writeJson(dispositionArtifactPath, dispositionArtifact), dispositionArtifactSha256);
    fs.copyFileSync(receiptPath, baseline.bindings.receipt.snapshot_path);
    fs.copyFileSync(reviewArtifactPath, baseline.bindings.review_artifact.snapshot_path);
    fs.copyFileSync(validationArtifactPath, baseline.bindings.findings_validation.snapshot_path);
    fs.copyFileSync(dispositionArtifactPath, baseline.bindings.findings_disposition.snapshot_path);
    const baselinePath = path.join(root, `${taskId}-code-remediation-baseline.json`);
    const baselineSha256 = writeJson(baselinePath, baseline);
    return {
        baseline,
        baselinePath,
        baselineSha256,
        taskId,
        reviewType,
        receiptSha256,
        contextSha256,
        treeSha256,
        scopeSha256,
        profilePolicySnapshotSha256,
        root,
        deltaBaseFiles,
        builderOptions
    };
}

afterEach(() => {
    for (const root of temporaryRoots.splice(0)) {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

describe('review remediation baseline', () => {
    it('builds and accepts one immutable receipt-bound fix_now baseline', () => {
        const fixture = buildFixture(createTempRoot());
        const result = validateReviewRemediationBaselineArtifact({
            artifactPath: fixture.baselinePath,
            expectedArtifactSha256: fixture.baselineSha256,
            expectedTaskId: fixture.taskId,
            expectedReviewType: fixture.reviewType,
            expectedReceiptSha256: fixture.receiptSha256,
            expectedReviewContextSha256: fixture.contextSha256,
            expectedReviewTreeStateSha256: fixture.treeSha256,
            expectedScopeSha256: fixture.scopeSha256,
            expectedProfilePolicySnapshotSha256: fixture.profilePolicySnapshotSha256
        });

        assert.equal(result.valid, true, result.violations.join('\n'));
        assert.equal(result.artifact?.schema_version, REVIEW_REMEDIATION_BASELINE_SCHEMA_VERSION);
        assert.deepEqual(result.artifact?.path_line_inventory, [
            { path: 'src/example.ts', line: 17, item_ids: ['F-001'] },
            { path: 'src/second.ts', line: 23, item_ids: ['F-002'] }
        ]);
    });

    it('rejects a substituted origin FILE mapping even when its own contract hash is valid', () => {
        const fixture = buildFixture(createTempRoot());
        const forgedCoverage = buildReviewCoverageContract({
            reviewType: fixture.reviewType, changedFiles: ['src/example.ts', 'tests/node/example.test.ts']
        });
        assert.throws(() => buildReviewRemediationBaselineArtifact({
            ...fixture.builderOptions, originCoverageContract: forgedCoverage
        }), /authenticated findings-validation coverage hash/u);
        const forgedBaseline = { ...fixture.baseline, origin_coverage_contract: forgedCoverage };
        const forgedSha256 = writeJson(fixture.baselinePath, forgedBaseline);
        const result = validateReviewRemediationBaselineArtifact({
            artifactPath: fixture.baselinePath, expectedArtifactSha256: forgedSha256,
            expectedTaskId: fixture.taskId, expectedReviewType: fixture.reviewType
        });
        assert.equal(result.valid, false);
        assert.match(result.violations.join('\n'), /authenticated findings-validation coverage hash/u);
    });

    it('rejects malformed and foreign-lane origin coverage contracts', () => {
        const fixture = buildFixture(createTempRoot());
        for (const contract of [
            null,
            { ...fixture.baseline.origin_coverage_contract, obligations: [null] },
            buildReviewCoverageContract({ reviewType: 'security', changedFiles: ['src/example.ts', 'src/second.ts'] })
        ]) {
            const artifact = { ...fixture.baseline, origin_coverage_contract: contract };
            const artifactSha256 = writeJson(fixture.baselinePath, artifact);
            const result = validateReviewRemediationBaselineArtifact({
                artifactPath: fixture.baselinePath, expectedArtifactSha256: artifactSha256,
                expectedTaskId: fixture.taskId, expectedReviewType: fixture.reviewType
            });
            assert.equal(result.valid, false);
        }
    });

    it('preserves legacy baseline construction until delta capture wiring is supplied', () => {
        const fixture = buildFixture(createTempRoot());
        const { deltaBase: _deltaBase, ...legacyOptions } = fixture.builderOptions;
        const legacy = buildReviewRemediationBaselineArtifact(legacyOptions);

        assert.equal(legacy.schema_version, REVIEW_REMEDIATION_BASELINE_LEGACY_SCHEMA_VERSION);
        assert.equal(legacy.delta_base, undefined);
    });

    it('keeps legacy v1 baselines readable without inventing missing delta evidence', () => {
        const fixture = buildFixture(createTempRoot());
        const legacy = structuredClone(fixture.baseline) as unknown as Record<string, unknown>;
        legacy.schema_version = REVIEW_REMEDIATION_BASELINE_LEGACY_SCHEMA_VERSION;
        delete legacy.delta_base;
        const legacySha256 = writeJson(fixture.baselinePath, legacy);

        const validation = validateReviewRemediationBaselineArtifact({
            artifactPath: fixture.baselinePath,
            expectedArtifactSha256: legacySha256,
            expectedTaskId: fixture.taskId,
            expectedReviewType: fixture.reviewType
        });

        assert.equal(validation.valid, true, validation.violations.join('\n'));
        assert.equal(validation.artifact?.schema_version, REVIEW_REMEDIATION_BASELINE_LEGACY_SCHEMA_VERSION);
        assert.equal(validation.artifact?.delta_base, undefined);
        assert.throws(() => classifyReviewRemediationDelta({
            repoRoot: fixture.root,
            taskId: fixture.taskId,
            reviewType: fixture.reviewType,
            baselineArtifactPath: fixture.baselinePath,
            baselineArtifactSha256: legacySha256,
            currentChangedFiles: fixture.deltaBaseFiles
        }), /schema v1 baseline with delta_base evidence/iu);
    });

    it('rejects stale or foreign expected bindings', () => {
        const fixture = buildFixture(createTempRoot());
        const result = validateReviewRemediationBaselineArtifact({
            artifactPath: fixture.baselinePath,
            expectedTaskId: 'T-foreign',
            expectedReviewType: fixture.reviewType,
            expectedReceiptSha256: hash('stale-receipt'),
            expectedReviewContextSha256: hash('stale-context'),
            expectedReviewTreeStateSha256: hash('stale-tree'),
            expectedScopeSha256: hash('stale-scope'),
            expectedProfilePolicySnapshotSha256: hash('stale-policy')
        });

        assert.equal(result.valid, false);
        assert.ok(result.violations.some((violation) => violation.includes('task_id mismatch')));
        assert.ok(result.violations.some((violation) => violation.includes('receipt_sha256 mismatch')));
        assert.ok(result.violations.some((violation) => violation.includes('review_context_sha256 mismatch')));
        assert.ok(result.violations.some((violation) => violation.includes('review_tree_state_sha256 mismatch')));
        assert.ok(result.violations.some((violation) => violation.includes('scope_sha256 mismatch')));
        assert.ok(result.violations.some((violation) => violation.includes('profile_policy_snapshot_sha256 mismatch')));
    });

    it('rejects incomplete or internally inconsistent baseline data', () => {
        const fixture = buildFixture(createTempRoot());
        const tampered = structuredClone(fixture.baseline) as unknown as Record<string, unknown>;
        const bindings = tampered.bindings as Record<string, unknown>;
        const receiptBinding = bindings.receipt as Record<string, unknown>;
        delete receiptBinding.snapshot_sha256;
        const fixNowItems = tampered.fix_now_items as Array<Record<string, unknown>>;
        fixNowItems[0].evidence_locations = ['src/other.ts:22'];
        writeJson(fixture.baselinePath, tampered);

        const result = validateReviewRemediationBaselineArtifact({
            artifactPath: fixture.baselinePath,
            expectedTaskId: fixture.taskId,
            expectedReviewType: fixture.reviewType
        });

        assert.equal(result.valid, false);
        assert.ok(result.violations.some((violation) => violation.includes('bindings.receipt is incomplete')));
        assert.ok(result.violations.some((violation) => violation.includes('fix_now_items_sha256 mismatch')));
        assert.ok(result.violations.some((violation) => violation.includes('path_line_inventory does not match')));
    });

    it('rejects a hash-recomputed fix_now item that contradicts its accepted finding', () => {
        const fixture = buildFixture(createTempRoot());
        const tampered = structuredClone(fixture.baseline);
        tampered.fix_now_items[0].kind = 'residual_risk';
        tampered.fix_now_items[0].severity = 'residual_risk';
        tampered.fix_now_items[0].source_rule = 'review_finding_policy.residual_risk';
        tampered.fix_now_items_sha256 = sha256RedactedJsonPayload(tampered.fix_now_items);
        writeJson(fixture.baselinePath, tampered);

        const result = validateReviewRemediationBaselineArtifact({
            artifactPath: fixture.baselinePath,
            expectedTaskId: fixture.taskId,
            expectedReviewType: fixture.reviewType
        });

        assert.equal(result.valid, false);
        assert.ok(result.violations.some((violation) => violation.includes("fix_now item 'F-001' kind")));
        assert.ok(result.violations.some((violation) => violation.includes("fix_now item 'F-001' severity")));
        assert.ok(result.violations.some((violation) => violation.includes("fix_now item 'F-001' source_rule")));
    });

    it('rejects replaced or deleted bound evidence snapshots', () => {
        const fixture = buildFixture(createTempRoot());
        const validationSnapshotPath = fixture.baseline.bindings.findings_validation.snapshot_path;
        const receiptSnapshotPath = fixture.baseline.bindings.receipt.snapshot_path;
        fs.writeFileSync(validationSnapshotPath, '{"tampered":true}\n', 'utf8');
        fs.rmSync(receiptSnapshotPath);

        const result = validateReviewRemediationBaselineArtifact({
            artifactPath: fixture.baselinePath,
            expectedTaskId: fixture.taskId,
            expectedReviewType: fixture.reviewType
        });

        assert.equal(result.valid, false);
        assert.ok(result.violations.some((violation) =>
            violation.includes('bindings.findings_validation snapshot hash mismatch')
        ));
        assert.ok(result.violations.some((violation) =>
            violation.includes('bindings.receipt snapshot') && violation.includes('is missing')
        ));
    });

    it('rejects omission of an authenticated fix_now disposition item', () => {
        const fixture = buildFixture(createTempRoot());
        const tampered = structuredClone(fixture.baseline);
        tampered.fix_now_items = tampered.fix_now_items.filter((item) => item.id !== 'F-002');
        tampered.fix_now_items_sha256 = sha256RedactedJsonPayload(tampered.fix_now_items);
        tampered.path_line_inventory = tampered.path_line_inventory.filter((entry) =>
            !entry.item_ids.includes('F-002')
        );
        tampered.path_line_inventory_sha256 = sha256RedactedJsonPayload(tampered.path_line_inventory);
        writeJson(fixture.baselinePath, tampered);

        const result = validateReviewRemediationBaselineArtifact({
            artifactPath: fixture.baselinePath,
            expectedTaskId: fixture.taskId,
            expectedReviewType: fixture.reviewType
        });

        assert.equal(result.valid, false);
        assert.ok(result.violations.some((violation) =>
            violation.includes('does not match authenticated disposition count')
        ));
        assert.ok(result.violations.some((violation) =>
            violation.includes("missing authenticated disposition item 'F-002'")
        ));
    });

    it('rejects malformed supplied expected hashes instead of disabling the binding', () => {
        const fixture = buildFixture(createTempRoot());
        const result = validateReviewRemediationBaselineArtifact({
            artifactPath: fixture.baselinePath,
            expectedArtifactSha256: 'not-a-sha256',
            expectedTaskId: fixture.taskId,
            expectedReviewType: fixture.reviewType,
            expectedReceiptSha256: ''
        });

        assert.equal(result.valid, false);
        assert.ok(result.violations.some((violation) =>
            violation.includes('remediation baseline artifact hash expected value must be a SHA-256 hash')
        ));
        assert.ok(result.violations.some((violation) =>
            violation.includes('receipt_sha256 expected value must be a SHA-256 hash')
        ));
    });

    it('rejects a hash-recomputed accepted inventory that diverges from validation evidence', () => {
        const fixture = buildFixture(createTempRoot());
        const tampered = structuredClone(fixture.baseline);
        tampered.accepted_findings[0].title = 'Rewritten finding';
        tampered.accepted_findings[0].evidence_locations = ['src/tampered.ts:99'];
        tampered.accepted_findings[0].coverage_obligation_ids = ['FILE-TAMPERED'];
        tampered.fix_now_items[0].evidence_locations = ['src/tampered.ts:99'];
        tampered.accepted_inventory_sha256 = sha256RedactedJsonPayload({
            findings: tampered.accepted_findings,
            residualRisks: tampered.accepted_residual_risks
        });
        tampered.fix_now_items_sha256 = sha256RedactedJsonPayload(tampered.fix_now_items);
        tampered.path_line_inventory = [
            { path: 'src/second.ts', line: 23, item_ids: ['F-002'] },
            { path: 'src/tampered.ts', line: 99, item_ids: ['F-001'] }
        ];
        tampered.path_line_inventory_sha256 = sha256RedactedJsonPayload(tampered.path_line_inventory);
        writeJson(fixture.baselinePath, tampered);

        const result = validateReviewRemediationBaselineArtifact({
            artifactPath: fixture.baselinePath,
            expectedTaskId: fixture.taskId,
            expectedReviewType: fixture.reviewType
        });

        assert.equal(result.valid, false);
        assert.ok(result.violations.some((violation) =>
            violation.includes('does not match the authenticated findings-validation snapshot')
        ));
    });
});

describe('review remediation delta classification', () => {
    function classifyFixture(
        fixture: ReturnType<typeof buildFixture>,
        currentChangedFiles: string[] = fixture.deltaBaseFiles,
        threshold = 20
    ) {
        return classifyReviewRemediationDelta({
            repoRoot: fixture.root,
            taskId: fixture.taskId,
            reviewType: fixture.reviewType,
            baselineArtifactPath: fixture.baselinePath,
            baselineArtifactSha256: fixture.baselineSha256,
            currentChangedFiles,
            structuralTestChangedLinesThreshold: threshold
        });
    }

    it('keeps delta line evidence valid after durable redacted JSON serialization', () => {
        const fixture = buildFixture(createTempRoot());
        const sourcePath = path.join(fixture.root, 'src', 'example.ts');
        fs.writeFileSync(
            sourcePath,
            'const match = html.match(/const actionToken = "([^"]+)";/u);\n',
            'utf8'
        );
        fixture.baseline.delta_base = buildReviewRemediationDeltaBase({
            repoRoot: fixture.root,
            taskId: fixture.taskId,
            reviewType: fixture.reviewType,
            reviewTreeStateSha256: fixture.treeSha256,
            changedFiles: fixture.deltaBaseFiles
        });
        const serialized = serializeRedactedJson(fixture.baseline);
        fs.writeFileSync(fixture.baselinePath, serialized, 'utf8');
        fixture.baselineSha256 = hash(serialized);
        fs.appendFileSync(sourcePath, 'export const fixed = true;\n', 'utf8');

        const result = classifyFixture(fixture);

        assert.equal(result.full_review_required, false);
        assert.equal(result.changed_lines_total, 1);
    });

    it('excludes unchanged task files and reports exact post-baseline line counts', () => {
        const fixture = buildFixture(createTempRoot());
        fs.appendFileSync(path.join(fixture.root, 'src', 'example.ts'), 'export const fixed = true;\n', 'utf8');

        const result = classifyFixture(fixture);

        assert.equal(result.category, 'production');
        assert.deepEqual(result.changed_files, ['src/example.ts']);
        assert.ok(result.unchanged_files.includes('src/second.ts'));
        assert.equal(result.file_deltas[0].additions, 1);
        assert.equal(result.file_deltas[0].deletions, 0);
        assert.equal(result.changed_lines_total, 1);
        assert.equal(result.full_review_required, false);
        assert.equal(result.scope.membership_unchanged, true);
        assert.deepEqual(result.scope.required_delta_targets, ['src/example.ts']);
        assert.ok(result.scope.optional_context_files.includes('src/second.ts'));
        assert.ok(result.readable_diff.page_count > 0);
    });

    it('redacts snapshot text and rejects replaced readable evidence', () => {
        const fixture = buildFixture(createTempRoot());
        const sourcePath = path.join(fixture.root, 'src', 'example.ts');
        const secret = 'plain-text-secret-token';
        fs.writeFileSync(sourcePath, `export const apiToken = "${secret}";\n`, 'utf8');
        fixture.baseline.delta_base = buildReviewRemediationDeltaBase({
            repoRoot: fixture.root,
            taskId: fixture.taskId,
            reviewType: fixture.reviewType,
            reviewTreeStateSha256: fixture.treeSha256,
            changedFiles: fixture.deltaBaseFiles
        });
        fixture.baselineSha256 = writeJson(fixture.baselinePath, fixture.baseline);

        const baselineEntry = fixture.baseline.delta_base.entries.find((entry) => entry.path === 'src/example.ts');
        assert.ok(baselineEntry);
        assert.equal(baselineEntry.redaction_applied, true);
        assert.doesNotMatch(baselineEntry.redacted_lines?.join('') || '', new RegExp(secret, 'u'));

        const longAddedLine = `export const payload = "${'x'.repeat(REVIEW_REMEDIATION_DELTA_DIFF_PAGE_MAX_BYTES * 2)}";\n`;
        fs.appendFileSync(sourcePath, longAddedLine, 'utf8');
        const result = classifyFixture(fixture);
        const repeated = classifyFixture(fixture);

        assert.equal(result.full_review_required, false);
        assert.ok(result.readable_diff.page_count >= 3);
        assert.ok(result.readable_diff.pages.every((page) => (
            page.utf8_bytes <= REVIEW_REMEDIATION_DELTA_DIFF_PAGE_MAX_BYTES
        )));
        assert.deepEqual(result.readable_diff, repeated.readable_diff);
        assert.doesNotMatch(JSON.stringify(result.readable_diff), new RegExp(secret, 'u'));
        assert.deepEqual(getReviewRemediationDeltaClassificationViolations(result), []);

        const tampered = structuredClone(result);
        tampered.readable_diff.pages[0].lines[0].text = 'forged replacement\n';
        const violations = getReviewRemediationDeltaClassificationViolations(tampered);
        assert.ok(violations.some((violation) => (
            violation.includes('readable_diff.pages[0].page_sha256')
        )));
        assert.ok(violations.some((violation) => violation.includes('readable_diff.evidence_sha256')));

        const redactionEquivalentTamper = structuredClone(result);
        const redactedPage = redactionEquivalentTamper.readable_diff.pages.find((page) => (
            page.lines.some((line) => line.text.includes('<redacted>'))
        ));
        assert.ok(redactedPage);
        const redactedLine = redactedPage.lines.find((line) => line.text.includes('<redacted>'));
        assert.ok(redactedLine);
        redactedLine.text = redactedLine.text.replace('<redacted>', 'raw-secret');
        const { page_sha256: ignoredPageHash, ...pageWithoutHash } = redactedPage;
        void ignoredPageHash;
        redactedPage.page_sha256 = sha256RedactedJsonPayload(pageWithoutHash);
        const {
            evidence_sha256: ignoredEvidenceHash,
            ...evidenceWithoutHash
        } = redactionEquivalentTamper.readable_diff;
        void ignoredEvidenceHash;
        redactionEquivalentTamper.readable_diff.evidence_sha256 = sha256RedactedJsonPayload(
            evidenceWithoutHash
        );

        const redactionEquivalentViolations = getReviewRemediationDeltaClassificationViolations(
            redactionEquivalentTamper
        );
        assert.ok(redactionEquivalentViolations.some((violation) => (
            violation.includes('readable_diff.pages') && violation.includes('only redacted text')
        )));
        assert.ok(redactionEquivalentViolations.some((violation) => (
            violation.includes('readable_diff.pages') && violation.includes('page_sha256')
        )));
    });

    it('forces FULL when non-text content snapshot budget or path identity is invalid', () => {
        const binaryFixture = buildFixture(createTempRoot());
        fs.writeFileSync(
            path.join(binaryFixture.root, 'src', 'example.ts'),
            Buffer.from([0x00, 0x01, 0x02, 0x03])
        );
        const binaryResult = classifyFixture(binaryFixture);
        assert.equal(binaryResult.full_review_required, true);
        assert.match(binaryResult.full_review_reasons.join('\n'), /content is not an ordinary text modification/iu);

        const budgetFixture = buildFixture(createTempRoot());
        fs.writeFileSync(
            path.join(budgetFixture.root, 'src', 'example.ts'),
            Buffer.alloc(REVIEW_REMEDIATION_DELTA_MAX_TEXT_BYTES + 1, 0x61)
        );
        const budgetResult = classifyFixture(budgetFixture);
        assert.equal(budgetResult.full_review_required, true);
        assert.match(budgetResult.full_review_reasons.join('\n'), /content_size_limit_exceeded/iu);

        const replacedFixture = buildFixture(createTempRoot());
        const replacedPath = path.join(replacedFixture.root, 'src', 'example.ts');
        const fsForPatch = requireFromTest('node:fs') as {
            openSync: (filePath: fs.PathLike, ...args: unknown[]) => number;
        };
        const originalOpenSync = fsForPatch.openSync;
        let replacementAttempted = false;
        fsForPatch.openSync = (filePath: fs.PathLike, ...args: unknown[]) => {
            if (!replacementAttempted && path.resolve(String(filePath)) === path.resolve(replacedPath)) {
                replacementAttempted = true;
                fs.rmSync(replacedPath);
                fs.writeFileSync(replacedPath, 'untrusted replacement content\n', 'utf8');
            }
            return originalOpenSync(filePath, ...args);
        };
        let replacedResult: ReturnType<typeof classifyFixture>;
        try {
            replacedResult = classifyFixture(replacedFixture);
        } finally {
            fsForPatch.openSync = originalOpenSync;
        }
        assert.equal(replacementAttempted, true);
        assert.equal(replacedResult.full_review_required, true);
        assert.match(replacedResult.full_review_reasons.join('\n'), /unreviewable/iu);
    });

    it('forces FULL for scope membership new deleted and type drift', () => {
        const newFileFixture = buildFixture(createTempRoot());
        const newFile = 'src/post-baseline-added.ts';
        fs.writeFileSync(path.join(newFileFixture.root, newFile), 'export const added = true;\n', 'utf8');
        const newFileResult = classifyFixture(
            newFileFixture,
            [...newFileFixture.deltaBaseFiles, newFile]
        );
        assert.equal(newFileResult.full_review_required, true);
        assert.equal(newFileResult.scope.membership_unchanged, false);
        assert.equal(newFileResult.file_deltas.find((entry) => entry.path === newFile)?.operation, 'added');

        const deletedFixture = buildFixture(createTempRoot());
        fs.rmSync(path.join(deletedFixture.root, 'src', 'example.ts'));
        const deletedResult = classifyFixture(deletedFixture);
        assert.equal(deletedResult.full_review_required, true);
        assert.equal(deletedResult.file_deltas.find((entry) => entry.path === 'src/example.ts')?.operation, 'deleted');

        const typeFixture = buildFixture(createTempRoot());
        const typePath = path.join(typeFixture.root, 'src', 'example.ts');
        fs.rmSync(typePath);
        fs.mkdirSync(typePath);
        const typeResult = classifyFixture(typeFixture);
        assert.equal(typeResult.full_review_required, true);
        assert.equal(typeResult.file_deltas.find((entry) => entry.path === 'src/example.ts')?.operation, 'type_changed');
    });

    it('retains permission-only changes in the remediation delta', () => {
        const fixture = buildFixture(createTempRoot());
        const deltaBase = fixture.baseline.delta_base;
        const entry = deltaBase.entries.find((candidate) => candidate.path === 'src/example.ts');
        assert.ok(entry);
        entry.mode = (entry.mode ?? 0) ^ 0o100;
        deltaBase.entries_sha256 = sha256RedactedJsonPayload(deltaBase.entries);
        const { snapshot_sha256: _snapshotSha256, ...snapshotPayload } = deltaBase;
        deltaBase.snapshot_sha256 = sha256RedactedJsonPayload(snapshotPayload);
        fixture.baselineSha256 = writeJson(fixture.baselinePath, fixture.baseline);

        const result = classifyFixture(fixture);
        const fileDelta = result.file_deltas.find((candidate) => candidate.path === 'src/example.ts');

        assert.ok(fileDelta);
        assert.equal(fileDelta.operation, 'modified');
        assert.notEqual(fileDelta.baseline_mode, fileDelta.current_mode);
        assert.ok(!result.unchanged_files.includes('src/example.ts'));
    });

    it('fails closed when a current-only task path is already missing', () => {
        const fixture = buildFixture(createTempRoot());
        const currentOnlyPath = 'src/post-baseline-deleted.ts';

        const result = classifyFixture(fixture, [...fixture.deltaBaseFiles, currentOnlyPath]);

        assert.equal(result.category, 'ambiguous');
        assert.deepEqual(result.changed_files, [currentOnlyPath]);
        assert.ok(!result.unchanged_files.includes(currentOnlyPath));
        assert.equal(result.file_deltas[0].operation, 'deleted');
        assert.equal(result.file_deltas[0].category, 'ambiguous');
        assert.equal(
            result.file_deltas[0].reason,
            'path entered the current task scope after the baseline and is now missing'
        );
        assert.equal(result.changed_lines_total, null);
        assert.equal(result.full_review_required, true);
        assert.equal(result.scope.membership_unchanged, false);
    });

    it('classifies every single-domain remediation delta deterministically', () => {
        const cases = [
            {
                file: 'tests/node/example.test.ts',
                content: 'assert.equal(example, true);\nassert.equal(fixed, true);\n',
                threshold: 20,
                category: 'leaf_test'
            },
            {
                file: 'tests/node/example.test.ts',
                content: 'line-1\nline-2\nline-3\nline-4\n',
                threshold: 2,
                category: 'structural_test'
            },
            {
                file: 'tests/node/helpers/shared.ts',
                content: 'export const fixture = false;\n',
                threshold: 20,
                category: 'shared_test_helper_or_harness'
            },
            {
                file: 'template/config/paths.json',
                content: '{"version":2}\n',
                threshold: 20,
                category: 'global'
            },
            {
                file: 'tests/node/snapshots/example.snap',
                content: 'snapshot-v2\n',
                threshold: 20,
                category: 'generated_churn'
            }
        ] as const;
        for (const testCase of cases) {
            const fixture = buildFixture(createTempRoot());
            fs.writeFileSync(path.join(fixture.root, testCase.file), testCase.content, 'utf8');
            const result = classifyFixture(fixture, fixture.deltaBaseFiles, testCase.threshold);
            assert.equal(result.category, testCase.category, testCase.file);
            assert.deepEqual(result.changed_files, [testCase.file], testCase.file);
        }
    });

    it('fails closed with an exact reason for mixed delta classes', () => {
        const fixture = buildFixture(createTempRoot());
        fs.appendFileSync(path.join(fixture.root, 'src', 'example.ts'), 'export const fixed = true;\n', 'utf8');
        fs.appendFileSync(path.join(fixture.root, 'tests', 'node', 'example.test.ts'), 'assert.equal(fixed, true);\n', 'utf8');

        const result = classifyFixture(fixture);

        assert.equal(result.category, 'ambiguous');
        assert.equal(result.reason, 'mixed remediation delta classes: leaf_test, production');
        assert.deepEqual(result.changed_files, ['src/example.ts', 'tests/node/example.test.ts']);
    });

    it('bounds retained line evidence and reports the exact conservative reason', () => {
        const fixture = buildFixture(createTempRoot());
        const largeFile = 'src/large.ts';
        fs.writeFileSync(
            path.join(fixture.root, largeFile),
            'x'.repeat(REVIEW_REMEDIATION_DELTA_MAX_TEXT_BYTES + 1),
            'utf8'
        );

        const result = classifyFixture(fixture, [...fixture.deltaBaseFiles, largeFile]);

        assert.equal(result.category, 'ambiguous');
        assert.equal(
            result.file_deltas[0].reason,
            'line evidence unavailable (baseline=available, current=content_size_limit_exceeded)'
        );
        assert.match(result.reason, /content_size_limit_exceeded/iu);
        assert.equal(result.file_deltas[0].current_line_count, null);
    });

    it('bounds aggregate snapshot file and content I/O', () => {
        const root = createTempRoot();
        fs.mkdirSync(path.join(root, 'src'), { recursive: true });
        const oversizedFile = 'src/oversized.ts';
        fs.writeFileSync(
            path.join(root, oversizedFile),
            Buffer.alloc(REVIEW_REMEDIATION_DELTA_MAX_TEXT_BYTES + 1, 0x61)
        );
        const oversizedBound = buildReviewRemediationDeltaBase({
            repoRoot: root,
            taskId: 'T-oversized-byte-bound',
            reviewType: 'performance',
            reviewTreeStateSha256: hash('oversized-byte-bound'),
            changedFiles: [oversizedFile]
        });

        assert.equal(oversizedBound.entries[0].status, 'unreviewable');
        assert.equal(oversizedBound.entries[0].content_sha256, null);
        assert.equal(oversizedBound.entries[0].line_analysis, 'content_size_limit_exceeded');

        const contentFiles = Array.from(
            { length: Math.floor(REVIEW_REMEDIATION_DELTA_MAX_SNAPSHOT_BYTES / REVIEW_REMEDIATION_DELTA_MAX_TEXT_BYTES) + 1 },
            (_, index) => `src/aggregate-${index}.ts`
        );
        for (const file of contentFiles) {
            fs.writeFileSync(path.join(root, file), Buffer.alloc(REVIEW_REMEDIATION_DELTA_MAX_TEXT_BYTES, 0x61));
        }
        const byteBound = buildReviewRemediationDeltaBase({
            repoRoot: root,
            taskId: 'T-aggregate-byte-bound',
            reviewType: 'performance',
            reviewTreeStateSha256: hash('aggregate-byte-bound'),
            changedFiles: contentFiles
        });

        assert.equal(byteBound.entries.at(-1)?.content_sha256, null);
        assert.equal(byteBound.entries.at(-1)?.line_analysis, 'snapshot_byte_budget_exceeded');

        const missingFiles = Array.from(
            { length: REVIEW_REMEDIATION_DELTA_MAX_SNAPSHOT_FILES + 1 },
            (_, index) => `src/missing-${index}.ts`
        );
        assert.throws(() => buildReviewRemediationDeltaBase({
            repoRoot: root,
            taskId: 'T-aggregate-file-bound',
            reviewType: 'performance',
            reviewTreeStateSha256: hash('aggregate-file-bound'),
            changedFiles: missingFiles
        }), /accepts at most 512 changed files/iu);
    });

    it('rejects hash-recomputed persisted line evidence beyond snapshot budgets', () => {
        const fixture = buildFixture(createTempRoot());
        const perFile = structuredClone(fixture.baseline.delta_base);
        perFile.entries[0].line_hashes = Array(REVIEW_REMEDIATION_DELTA_MAX_LINES_PER_FILE + 1)
            .fill(hash('persisted-line'));
        perFile.entries[0].line_count = perFile.entries[0].line_hashes.length;
        perFile.entries_sha256 = sha256RedactedJsonPayload(perFile.entries);
        const { snapshot_sha256: _perFileSnapshotSha256, ...perFilePayload } = perFile;
        perFile.snapshot_sha256 = sha256RedactedJsonPayload(perFilePayload);

        assert.ok(getReviewRemediationDeltaBaseViolations(perFile).some((violation) =>
            violation.includes(`at most ${REVIEW_REMEDIATION_DELTA_MAX_LINES_PER_FILE} hashes`)
        ));

        const aggregate = structuredClone(fixture.baseline.delta_base);
        for (const entry of aggregate.entries.slice(0, 5)) {
            entry.line_hashes = Array(REVIEW_REMEDIATION_DELTA_MAX_LINES_PER_FILE).fill(hash('aggregate-line'));
            entry.line_count = entry.line_hashes.length;
        }
        aggregate.entries_sha256 = sha256RedactedJsonPayload(aggregate.entries);
        const { snapshot_sha256: _aggregateSnapshotSha256, ...aggregatePayload } = aggregate;
        aggregate.snapshot_sha256 = sha256RedactedJsonPayload(aggregatePayload);

        assert.ok(getReviewRemediationDeltaBaseViolations(aggregate).some((violation) =>
            violation.includes(`at most ${REVIEW_REMEDIATION_DELTA_MAX_SNAPSHOT_LINES} hashes in aggregate`)
        ));
    });

    it('keeps filesystem probe failures distinct from confirmed missing paths', () => {
        const root = createTempRoot();
        const inaccessiblePath = 'src/invalid\0path.ts';

        const deltaBase = buildReviewRemediationDeltaBase({
            repoRoot: root,
            taskId: 'T-probe-failure',
            reviewType: 'code',
            reviewTreeStateSha256: hash('probe-failure'),
            changedFiles: [inaccessiblePath]
        });

        assert.equal(deltaBase.entries[0].status, 'unreviewable');
        assert.equal(deltaBase.entries[0].line_analysis, 'unreviewable');
    });

    it('fails closed when a file is replaced after its safe path probe', () => {
        const fixture = buildFixture(createTempRoot());
        const replacedPath = path.join(fixture.root, 'src', 'example.ts');
        const fsForPatch = requireFromTest('node:fs') as {
            openSync: (filePath: fs.PathLike, ...args: unknown[]) => number;
        };
        const originalOpenSync = fsForPatch.openSync;
        let replacementAttempted = false;
        fsForPatch.openSync = (filePath: fs.PathLike, ...args: unknown[]) => {
            if (!replacementAttempted && path.resolve(String(filePath)) === path.resolve(replacedPath)) {
                replacementAttempted = true;
                fs.rmSync(replacedPath);
                fs.writeFileSync(replacedPath, 'untrusted replacement content\n', 'utf8');
            }
            return originalOpenSync(filePath, ...args);
        };

        let result: ReturnType<typeof classifyFixture>;
        try {
            result = classifyFixture(fixture);
        } finally {
            fsForPatch.openSync = originalOpenSync;
        }

        assert.equal(replacementAttempted, true);
        assert.equal(result.category, 'ambiguous');
        assert.deepEqual(result.changed_files, ['src/example.ts']);
        assert.match(result.file_deltas[0].reason, /current=unreviewable/iu);
    });

    it('bounds worst-case line comparison work and fails closed as ambiguous', () => {
        const fixture = buildFixture(createTempRoot());
        const replacement = Array.from({ length: 1000 }, (_, index) => `replacement-${index}\n`).join('');
        fs.writeFileSync(path.join(fixture.root, 'src', 'example.ts'), replacement, 'utf8');

        const result = classifyFixture(fixture);

        assert.equal(result.category, 'ambiguous');
        assert.equal(
            result.file_deltas[0].reason,
            `line comparison exceeded ${REVIEW_REMEDIATION_DELTA_MAX_DIFF_WORK_UNITS} work units`
        );
        assert.match(result.reason, /line comparison exceeded/iu);
        assert.equal(result.changed_lines_total, null);
    });

    it('keeps unchanged unreviewable content ambiguous when no content hash exists', () => {
        const fixture = buildFixture(createTempRoot());
        const oversizedFile = 'src/oversized-unchanged.ts';
        fs.writeFileSync(
            path.join(fixture.root, oversizedFile),
            Buffer.alloc(REVIEW_REMEDIATION_DELTA_MAX_TEXT_BYTES + 1, 0x61)
        );
        fixture.deltaBaseFiles.splice(0, fixture.deltaBaseFiles.length, oversizedFile);
        fixture.baseline.delta_base = buildReviewRemediationDeltaBase({
            repoRoot: fixture.root,
            taskId: fixture.taskId,
            reviewType: fixture.reviewType,
            reviewTreeStateSha256: fixture.treeSha256,
            changedFiles: fixture.deltaBaseFiles
        });
        fixture.baselineSha256 = writeJson(fixture.baselinePath, fixture.baseline);

        const result = classifyFixture(fixture);

        assert.equal(fixture.baseline.delta_base.entries[0].content_sha256, null);
        assert.equal(result.category, 'ambiguous');
        assert.deepEqual(result.changed_files, [oversizedFile]);
        assert.match(result.file_deltas[0].reason, /content_size_limit_exceeded/iu);
    });

    it('shares one line-comparison work budget across all changed files', () => {
        const fixture = buildFixture(createTempRoot());
        const files = Array.from({ length: 3 }, (_, index) => `src/aggregate-diff-${index}.ts`);
        for (const [fileIndex, file] of files.entries()) {
            fs.writeFileSync(
                path.join(fixture.root, file),
                Array.from({ length: 220 }, (_, line) => `before-${fileIndex}-${line}\n`).join(''),
                'utf8'
            );
        }
        fixture.deltaBaseFiles.splice(0, fixture.deltaBaseFiles.length, ...files);
        fixture.baseline.delta_base = buildReviewRemediationDeltaBase({
            repoRoot: fixture.root,
            taskId: fixture.taskId,
            reviewType: fixture.reviewType,
            reviewTreeStateSha256: fixture.treeSha256,
            changedFiles: fixture.deltaBaseFiles
        });
        fixture.baselineSha256 = writeJson(fixture.baselinePath, fixture.baseline);
        for (const [fileIndex, file] of files.entries()) {
            fs.writeFileSync(
                path.join(fixture.root, file),
                Array.from({ length: 220 }, (_, line) => `after-${fileIndex}-${line}\n`).join(''),
                'utf8'
            );
        }

        const result = classifyFixture(fixture);

        assert.equal(result.category, 'ambiguous');
        assert.equal(result.file_deltas[0].changed_lines, 440);
        assert.equal(result.file_deltas[1].changed_lines, 440);
        assert.equal(result.file_deltas[2].changed_lines, null);
        assert.equal(
            result.file_deltas[2].reason,
            `line comparison exceeded ${REVIEW_REMEDIATION_DELTA_MAX_DIFF_WORK_UNITS} work units`
        );
        assert.equal(result.changed_lines_total, null);
    });

    it('classifies identical-content symbolic-link retargeting instead of treating it as unchanged', (t) => {
        const fixture = buildFixture(createTempRoot());
        const linkPath = path.join(fixture.root, 'src', 'link.ts');
        fs.writeFileSync(path.join(fixture.root, 'src', 'target-a.ts'), 'same target content\n', 'utf8');
        fs.writeFileSync(path.join(fixture.root, 'src', 'target-b.ts'), 'same target content\n', 'utf8');
        try {
            fs.symlinkSync('target-a.ts', linkPath, 'file');
        } catch (error) {
            t.skip(`file symlink creation unavailable in this environment: ${error instanceof Error ? error.message : String(error)}`);
            return;
        }
        fixture.deltaBaseFiles.splice(0, fixture.deltaBaseFiles.length, 'src/link.ts');
        fixture.baseline.delta_base = buildReviewRemediationDeltaBase({
            repoRoot: fixture.root,
            taskId: fixture.taskId,
            reviewType: fixture.reviewType,
            reviewTreeStateSha256: fixture.treeSha256,
            changedFiles: fixture.deltaBaseFiles
        });
        fixture.baselineSha256 = writeJson(fixture.baselinePath, fixture.baseline);

        fs.rmSync(linkPath);
        fs.symlinkSync('target-b.ts', linkPath, 'file');
        const result = classifyFixture(fixture);

        assert.equal(result.category, 'ambiguous');
        assert.deepEqual(result.changed_files, ['src/link.ts']);
        assert.equal(result.file_deltas[0].operation, 'modified');
        assert.equal(result.file_deltas[0].reason, 'line delta is unavailable for symbolic_link -> symbolic_link');
        assert.equal(result.full_review_required, true);
    });

    it('rejects foreign and incomplete baseline evidence before reading reuse policy', () => {
        const foreignFixture = buildFixture(createTempRoot());
        assert.throws(() => classifyReviewRemediationDelta({
            repoRoot: foreignFixture.root,
            taskId: foreignFixture.taskId,
            reviewType: foreignFixture.reviewType,
            baselineArtifactPath: foreignFixture.baselinePath,
            baselineArtifactSha256: hash('forged-baseline-hash'),
            currentChangedFiles: foreignFixture.deltaBaseFiles
        }), /artifact hash mismatch/iu);
        assert.throws(() => classifyReviewRemediationDelta({
            repoRoot: foreignFixture.root,
            taskId: 'T-foreign',
            reviewType: foreignFixture.reviewType,
            baselineArtifactPath: foreignFixture.baselinePath,
            baselineArtifactSha256: foreignFixture.baselineSha256,
            currentChangedFiles: foreignFixture.deltaBaseFiles
        }), /task_id mismatch/iu);

        const incompleteFixture = buildFixture(createTempRoot());
        const incomplete = structuredClone(incompleteFixture.baseline);
        incomplete.delta_base.entries = [];
        writeJson(incompleteFixture.baselinePath, incomplete);
        assert.throws(() => classifyReviewRemediationDelta({
            repoRoot: incompleteFixture.root,
            taskId: incompleteFixture.taskId,
            reviewType: incompleteFixture.reviewType,
            baselineArtifactPath: incompleteFixture.baselinePath,
            baselineArtifactSha256: createHash('sha256').update(fs.readFileSync(incompleteFixture.baselinePath)).digest('hex'),
            currentChangedFiles: incompleteFixture.deltaBaseFiles
        }), /delta_base/iu);
    });
});
