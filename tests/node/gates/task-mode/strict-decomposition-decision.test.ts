import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    buildStrictDecompositionDecisionArtifact,
    getStrictDecompositionDecisionEvidence,
    resolveStrictDecompositionDecisionArtifactPath
} from '../../../../src/gates/task-mode/strict-decomposition-decision';
import { writeJsonArtifact } from '../../../../src/cli/gate-cli/gates-artifacts';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

function workPackageContract(taskId = 'T-100') {
    return {
        schema_version: 1,
        finding_obligations: [
            {
                obligation_id: 'code:F-001',
                review_type: 'code',
                finding_id: 'F-001',
                validation_artifact_path: 'runtime/reviews/T-100-code-findings-validation.json',
                validation_artifact_sha256: HASH_A,
                validation_result_sha256: HASH_B,
                root_cause_areas: ['restore-target-safety'],
                work_package_task_ids: [`${taskId}-1`],
                downstream_review_types: ['code', 'security', 'test']
            },
            {
                obligation_id: 'test:F-001',
                review_type: 'test',
                finding_id: 'F-001',
                validation_artifact_path: 'runtime/reviews/T-100-test-findings-validation.json',
                validation_artifact_sha256: HASH_B,
                validation_result_sha256: HASH_A,
                root_cause_areas: ['restore-target-safety'],
                work_package_task_ids: [`${taskId}-1`],
                downstream_review_types: ['code', 'security', 'test']
            },
            {
                obligation_id: 'security:F-002',
                review_type: 'security',
                finding_id: 'F-002',
                validation_artifact_path: 'runtime/reviews/T-100-security-findings-validation.json',
                validation_artifact_sha256: HASH_A,
                validation_result_sha256: HASH_B,
                root_cause_areas: ['restore-target-safety', 'child-routing'],
                work_package_task_ids: [`${taskId}-1`, `${taskId}-2`],
                downstream_review_types: ['security', 'test']
            }
        ],
        work_packages: [
            {
                task_id: `${taskId}-1`,
                profile: 'strict',
                root_cause_area: 'restore-target-safety',
                objective: 'Prevent path-scoped restore from overwriting unrelated target state.',
                scope_obligations: ['Preserve every existing target obstruction before restore.'],
                validation_contract: ['Cover tracked, untracked, and symlink target obstructions.'],
                finding_obligation_ids: ['code:F-001', 'test:F-001', 'security:F-002'],
                required_review_types: ['code', 'security', 'test']
            },
            {
                task_id: `${taskId}-2`,
                profile: 'strict',
                root_cause_area: 'child-routing',
                objective: 'Keep split child routing bound to the authenticated package set.',
                scope_obligations: ['Route only children declared by the decomposition contract.'],
                validation_contract: ['Cover missing, extra, and mismatched linked child rows.'],
                finding_obligation_ids: ['security:F-002'],
                required_review_types: ['security', 'test']
            }
        ]
    };
}

function scopeOnlyWorkPackageContract(
    taskId = 'T-100',
    taskIds = [`${taskId}-1`, `${taskId}-2`],
    profile = 'strict',
    schemaVersion = 1
) {
    return {
        schema_version: schemaVersion,
        finding_obligations: [],
        work_packages: taskIds.map((childTaskId, index) => ({
            task_id: childTaskId,
            profile,
            root_cause_area: `root-cause-${index + 1}`,
            objective: `Implement independently executable root-cause package ${index + 1}.`,
            scope_obligations: [`Preserve bounded parent scope obligation ${index + 1}.`],
            validation_contract: [`Validate root-cause package ${index + 1} independently.`],
            finding_obligation_ids: [],
            required_review_types: ['code']
        }))
    };
}

function writeAcceptedFindingValidation(repoRoot: string, taskId: string): string {
    const validationResult = {
        status: 'accepted',
        accepted: true,
        detected: true,
        violations: [],
        coverage_status: null,
        normalized_inventory: {
            finding_count: 1,
            residual_risk_count: 0,
            findings_by_severity: {
                critical: [],
                high: [],
                medium: [{
                    id: 'F-001',
                    severity: 'medium',
                    title: 'Do not use reviewer prose as package ownership.',
                    description: 'The structured decomposition contract must choose the root-cause package.',
                    evidence_locations: ['src/example.ts:1'],
                    coverage_obligation_ids: ['OBL-001']
                }],
                low: []
            },
            residual_risks: []
        },
        evidence_diagnostics: {
            validation_note_evidence_locations: [],
            coverage_evidence_locations: ['src/example.ts:1'],
            finding_evidence_locations: ['src/example.ts:1'],
            residual_risk_evidence_locations: [],
            total_evidence_locations: 1
        },
        bindings: {
            input: { review_output_sha256: null },
            output: { review_artifact_path: null, review_artifact_sha256: null },
            context: { review_context_path: null, review_context_sha256: null },
            scope: {
                preflight_path: null,
                preflight_sha256: null,
                scope_sha256: null,
                review_scope_sha256: null,
                code_scope_sha256: null
            },
            tree: { review_tree_state_sha256: null },
            coverage_contract_sha256: null
        }
    };
    const artifact = {
        schema_version: 1,
        artifact_type: 'review_findings_validation',
        task_id: taskId,
        review_type: 'code',
        validation_result: validationResult,
        validation_result_sha256: createHash('sha256')
            .update(`${JSON.stringify(validationResult, null, 2)}\n`)
            .digest('hex')
    };
    const artifactPath = path.join(repoRoot, 'runtime', 'reviews', `${taskId}-code-findings-validation.json`);
    writeJsonArtifact(artifactPath, artifact);
    return artifactPath;
}

describe('gates/strict-decomposition-decision', () => {
    function profiledSplitOptions(profile: string, schemaVersion = 2) {
        return {
            taskId: 'T-100',
            decision: 'split-required',
            taskProfile: profile,
            taskSummary: 'Split independently executable packages under the frozen parent profile.',
            reason: 'Separate root causes need bounded sequential child execution.',
            scopeRisk: 'Keep profile authority, exact child identity and native transitions bound.',
            expectedReviewTypes: ['code'],
            atomicityConstraints: ['Retain the immutable child profile through every boundary.'],
            workPackageContract: scopeOnlyWorkPackageContract('T-100', undefined, profile, schemaVersion)
        };
    }

    it('binds version-2 work packages and proposed children to the immutable parent profile', () => {
        for (const profile of ['balanced', 'strict', 'custom-review']) {
            const artifact = buildStrictDecompositionDecisionArtifact(profiledSplitOptions(profile));

            assert.equal(artifact.work_package_contract?.schema_version, 2);
            assert.deepEqual(artifact.proposed_children, [
                { task_id: 'T-100-1', profile },
                { task_id: 'T-100-2', profile }
            ]);
        }
    });

    it('preserves supported Unicode parent profile names in version-2 split contracts', () => {
        const profile = 'проверка-2';
        const artifact = buildStrictDecompositionDecisionArtifact(profiledSplitOptions(profile));

        assert.equal(artifact.task_profile, profile);
        assert.deepEqual(artifact.proposed_children, [
            { task_id: 'T-100-1', profile },
            { task_id: 'T-100-2', profile }
        ]);
    });

    it('rejects unsupported version-2 parent profile names at the canonical profile boundary', () => {
        assert.throws(
            () => buildStrictDecompositionDecisionArtifact(profiledSplitOptions('invalid-profile-')),
            /Invalid profile name/
        );
    });

    it('rejects missing or foreign version-2 work-package profiles', () => {
        const options = profiledSplitOptions('balanced');
        options.workPackageContract.work_packages[0].profile = 'strict';
        assert.throws(() => buildStrictDecompositionDecisionArtifact(options), /profile is required and must be balanced/);
        delete (options.workPackageContract.work_packages[0] as { profile?: string }).profile;
        assert.throws(() => buildStrictDecompositionDecisionArtifact(options), /profile is required and must be balanced/);
        (options.workPackageContract.work_packages[0] as { profile?: unknown }).profile = ['balanced'];
        assert.throws(() => buildStrictDecompositionDecisionArtifact(options), /profile is required and must be balanced/);
    });

    it('rejects unsupported work-package versions instead of inferring profile authority', () => {
        assert.throws(
            () => buildStrictDecompositionDecisionArtifact(profiledSplitOptions('balanced', 3)),
            /schema_version must equal 1 or 2/
        );
    });

    it('preserves legacy version-1 strict children for a balanced parent', () => {
        const options = profiledSplitOptions('balanced', 1);
        options.workPackageContract = scopeOnlyWorkPackageContract();
        const artifact = buildStrictDecompositionDecisionArtifact(options);
        assert.deepEqual(artifact.proposed_children.map(child => child.profile), ['strict', 'strict']);
    });

    it('rejects tampered version-2 proposed child profiles and foreign parent bindings', () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'decomposition-v2-profile-'));
        try {
            const options = profiledSplitOptions('balanced');
            const artifact = buildStrictDecompositionDecisionArtifact(options);
            const artifactPath = resolveStrictDecompositionDecisionArtifactPath(repoRoot, 'T-100');
            writeJsonArtifact(artifactPath, artifact);
            assert.equal(getStrictDecompositionDecisionEvidence(repoRoot, 'T-100', '', options.taskSummary, 'balanced').evidence_status, 'PASS');
            assert.equal(getStrictDecompositionDecisionEvidence(repoRoot, 'T-100', '', options.taskSummary, 'strict').evidence_status, 'EVIDENCE_TASK_PROFILE_MISMATCH');
            artifact.proposed_children[0].profile = 'fast';
            writeJsonArtifact(artifactPath, artifact);
            assert.match(getStrictDecompositionDecisionEvidence(repoRoot, 'T-100', '', options.taskSummary, 'balanced').evidence_status, /Proposed child profile must be balanced/);
            (artifact.proposed_children[0] as { profile: unknown }).profile = ['balanced'];
            writeJsonArtifact(artifactPath, artifact);
            assert.match(getStrictDecompositionDecisionEvidence(repoRoot, 'T-100', '', options.taskSummary, 'balanced').evidence_status, /Proposed child profile must be balanced/);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('builds split-required evidence with strict parent-derived children', () => {
        const artifact = buildStrictDecompositionDecisionArtifact({
            taskId: 'T-100',
            decision: 'split_required',
            taskSummary: 'Implement a risky strict workflow change with several review lanes.',
            reason: 'The scope spans multiple lifecycle contracts and should be split before implementation.',
            scopeRisk: 'The change touches review routing, task queue metadata, and lifecycle evidence.',
            expectedReviewTypes: ['code', 'security', 'test'],
            atomicityConstraints: ['Keep artifact schema and recorder validation together.'],
            proposedChildTaskIds: ['T-100-1', 'T-100-2'],
            workPackageContract: workPackageContract()
        });

        assert.equal(artifact.decision, 'split-required');
        assert.equal(artifact.task_profile, 'strict');
        assert.deepEqual(artifact.expected_review_types, ['code', 'security', 'test']);
        assert.deepEqual(artifact.proposed_children, [
            { task_id: 'T-100-1', profile: 'strict' },
            { task_id: 'T-100-2', profile: 'strict' }
        ]);
        assert.equal(artifact.work_package_contract?.work_packages.length, 2);
        assert.deepEqual(
            artifact.work_package_contract?.work_packages[0].finding_obligation_ids,
            ['code:F-001', 'test:F-001', 'security:F-002']
        );
        assert.deepEqual(
            artifact.work_package_contract?.finding_obligations[2].work_package_task_ids,
            ['T-100-1', 'T-100-2']
        );
    });

    it('requires every work package to declare the strict profile explicitly', () => {
        const contract = workPackageContract();
        delete (contract.work_packages[0] as { profile?: string }).profile;

        assert.throws(
            () => buildStrictDecompositionDecisionArtifact({
                taskId: 'T-100',
                decision: 'split-required',
                taskSummary: 'Implement a risky strict workflow change with several review lanes.',
                reason: 'The scope spans multiple lifecycle contracts and should be split before implementation.',
                scopeRisk: 'The change touches review routing, task queue metadata, and lifecycle evidence.',
                expectedReviewTypes: ['code', 'security', 'test'],
                atomicityConstraints: ['Keep artifact schema and recorder validation together.'],
                workPackageContract: contract
            }),
            /profile is required and must be strict/
        );
    });

    it('rejects duplicate root-cause packages instead of creating one child per finding', () => {
        const contract = workPackageContract();
        contract.work_packages[1].root_cause_area = 'restore-target-safety';

        assert.throws(
            () => buildStrictDecompositionDecisionArtifact({
                taskId: 'T-100',
                decision: 'split-required',
                taskSummary: 'Implement a risky strict workflow change with several review lanes.',
                reason: 'The scope spans multiple lifecycle contracts and should be split before implementation.',
                scopeRisk: 'The change touches review routing, task queue metadata, and lifecycle evidence.',
                expectedReviewTypes: ['code', 'security', 'test'],
                atomicityConstraints: ['Keep artifact schema and recorder validation together.'],
                workPackageContract: contract
            }),
            /unique root_cause_area/
        );
    });

    it('rejects finding root-cause areas without a matching work package', () => {
        const contract = workPackageContract();
        contract.finding_obligations[0].root_cause_areas.push('missing-root-cause');

        assert.throws(
            () => buildStrictDecompositionDecisionArtifact({
                taskId: 'T-100',
                decision: 'split-required',
                taskSummary: 'Implement a risky strict workflow change with several review lanes.',
                reason: 'The scope spans multiple lifecycle contracts and should be split before implementation.',
                scopeRisk: 'The change touches review routing, task queue metadata, and lifecycle evidence.',
                expectedReviewTypes: ['code', 'security', 'test'],
                atomicityConstraints: ['Keep artifact schema and recorder validation together.'],
                workPackageContract: contract
            }),
            /root_cause_areas must all map to work packages: missing-root-cause/
        );
    });

    it('rejects uncovered finding obligations and orphan work packages', () => {
        const uncoveredContract = workPackageContract();
        uncoveredContract.work_packages[0].finding_obligation_ids = ['code:F-001', 'test:F-001'];
        assert.throws(
            () => buildStrictDecompositionDecisionArtifact({
                taskId: 'T-100',
                decision: 'split-required',
                taskSummary: 'Implement a risky strict workflow change with several review lanes.',
                reason: 'The scope spans multiple lifecycle contracts and should be split before implementation.',
                scopeRisk: 'The change touches review routing, task queue metadata, and lifecycle evidence.',
                expectedReviewTypes: ['code', 'security', 'test'],
                atomicityConstraints: ['Keep artifact schema and recorder validation together.'],
                workPackageContract: uncoveredContract
            }),
            /finding_obligation_ids must exactly match/
        );

        const orphanContract = workPackageContract();
        orphanContract.work_packages[1].scope_obligations = [];
        assert.throws(
            () => buildStrictDecompositionDecisionArtifact({
                taskId: 'T-100',
                decision: 'split-required',
                taskSummary: 'Implement a risky strict workflow change with several review lanes.',
                reason: 'The scope spans multiple lifecycle contracts and should be split before implementation.',
                scopeRisk: 'The change touches review routing, task queue metadata, and lifecycle evidence.',
                expectedReviewTypes: ['code', 'security', 'test'],
                atomicityConstraints: ['Keep artifact schema and recorder validation together.'],
                workPackageContract: orphanContract
            }),
            /scope_obligation is required/i
        );
    });

    it('rejects evidence when a current validated finding is absent from the package contract', () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'strict-decomposition-uncovered-finding-'));
        writeAcceptedFindingValidation(repoRoot, 'T-100');
        const contract = workPackageContract();
        contract.finding_obligations = [];
        contract.work_packages[0].finding_obligation_ids = [];
        contract.work_packages[1].finding_obligation_ids = [];
        const artifact = buildStrictDecompositionDecisionArtifact({
            taskId: 'T-100',
            decision: 'split-required',
            taskSummary: 'Implement a risky strict workflow change with several review lanes.',
            reason: 'The scope spans multiple lifecycle contracts and should be split before implementation.',
            scopeRisk: 'The change touches review routing, task queue metadata, and lifecycle evidence.',
            expectedReviewTypes: ['code', 'security', 'test'],
            atomicityConstraints: ['Keep artifact schema and recorder validation together.'],
            workPackageContract: contract
        });
        writeJsonArtifact(resolveStrictDecompositionDecisionArtifactPath(repoRoot, 'T-100'), artifact);

        const evidence = getStrictDecompositionDecisionEvidence(repoRoot, 'T-100');

        assert.match(evidence.evidence_status, /uncovered current validated findings: code:F-001/);
        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('resolves canonical finding artifacts from a materialized orchestrator root', () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'strict-decomposition-materialized-'));
        const orchestratorRoot = path.join(repoRoot, 'garda-agent-orchestrator');
        fs.mkdirSync(orchestratorRoot, { recursive: true });
        fs.writeFileSync(path.join(orchestratorRoot, 'MANIFEST.md'), '# manifest\n', 'utf8');
        fs.writeFileSync(path.join(orchestratorRoot, 'VERSION'), '1.0.0\n', 'utf8');
        const findingArtifactPath = writeAcceptedFindingValidation(orchestratorRoot, 'T-100');
        const findingArtifact = JSON.parse(fs.readFileSync(findingArtifactPath, 'utf8')) as {
            validation_result_sha256: string;
        };
        const contract = workPackageContract();
        contract.finding_obligations = [contract.finding_obligations[0]];
        contract.finding_obligations[0].validation_artifact_sha256 = createHash('sha256')
            .update(fs.readFileSync(findingArtifactPath))
            .digest('hex');
        contract.finding_obligations[0].validation_result_sha256 = findingArtifact.validation_result_sha256;
        contract.finding_obligations[0].downstream_review_types = ['code'];
        contract.work_packages[0].finding_obligation_ids = ['code:F-001'];
        contract.work_packages[0].required_review_types = ['code'];
        contract.work_packages[1].finding_obligation_ids = [];
        contract.work_packages[1].required_review_types = ['code'];
        const artifact = buildStrictDecompositionDecisionArtifact({
            taskId: 'T-100',
            decision: 'split-required',
            taskSummary: 'Preserve findings in a materialized workspace.',
            reason: 'Two independently executable root causes require bounded work packages.',
            scopeRisk: 'Canonical finding sources must bind to the deployed orchestrator root.',
            expectedReviewTypes: ['code'],
            atomicityConstraints: ['Keep finding source validation and routing together.'],
            workPackageContract: contract
        });
        writeJsonArtifact(resolveStrictDecompositionDecisionArtifactPath(repoRoot, 'T-100'), artifact);

        const evidence = getStrictDecompositionDecisionEvidence(
            repoRoot,
            'T-100',
            '',
            'Preserve findings in a materialized workspace.'
        );

        assert.equal(evidence.evidence_status, 'PASS');
        assert.deepEqual(evidence.finding_obligation_ids, ['code:F-001']);
        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('rejects split children that are not parent-derived', () => {
        assert.throws(
            () => buildStrictDecompositionDecisionArtifact({
                taskId: 'T-100',
                decision: 'split-required',
                taskSummary: 'Implement a risky strict workflow change with several review lanes.',
                reason: 'The scope spans multiple lifecycle contracts and should be split before implementation.',
                scopeRisk: 'The change touches review routing, task queue metadata, and lifecycle evidence.',
                expectedReviewTypes: ['code'],
                atomicityConstraints: ['Keep artifact schema and recorder validation together.'],
                proposedChildTaskIds: ['T-101', 'T-100-1']
            }),
            /parent-derived/
        );
    });

    it('rejects split-required decisions with fewer than two meaningful children', () => {
        assert.throws(
            () => buildStrictDecompositionDecisionArtifact({
                taskId: 'T-100',
                decision: 'split-required',
                taskSummary: 'Implement a risky strict workflow change with several review lanes.',
                reason: 'The scope spans multiple lifecycle contracts and should be split before implementation.',
                scopeRisk: 'The change touches review routing, task queue metadata, and lifecycle evidence.',
                expectedReviewTypes: ['code'],
                atomicityConstraints: ['Keep artifact schema and recorder validation together.'],
                proposedChildTaskIds: ['T-100-1']
            }),
            /at least two/
        );
    });

    it('rejects duplicate proposed child identifiers before recording split evidence', () => {
        assert.throws(
            () => buildStrictDecompositionDecisionArtifact({
                taskId: 'T-100',
                decision: 'split-required',
                taskSummary: 'Implement a risky strict workflow change with several review lanes.',
                reason: 'The scope spans multiple lifecycle contracts and should be split before implementation.',
                scopeRisk: 'The change touches review routing, task queue metadata, and lifecycle evidence.',
                expectedReviewTypes: ['code'],
                atomicityConstraints: ['Keep artifact schema and recorder validation together.'],
                proposedChildTaskIds: ['T-100-1', 'T-100-1']
            }),
            /unique/
        );
    });

    it('detects current and stale decision evidence by task summary binding', () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'strict-decomposition-evidence-'));
        const taskSummary = 'Implement a risky strict workflow change with several review lanes.';
        const artifact = buildStrictDecompositionDecisionArtifact({
            taskId: 'T-100',
            decision: 'single-cycle',
            taskSummary,
            reason: 'The scope is localized enough to stay in one strict cycle.',
            scopeRisk: 'The change affects one command surface and a focused validator.',
            expectedReviewTypes: ['code'],
            atomicityConstraints: ['Keep command and validator together.']
        });
        const artifactPath = resolveStrictDecompositionDecisionArtifactPath(repoRoot, 'T-100');
        writeJsonArtifact(artifactPath, artifact);

        const current = getStrictDecompositionDecisionEvidence(repoRoot, 'T-100', '', taskSummary);
        assert.equal(current.evidence_status, 'PASS');
        assert.equal(current.decision, 'single-cycle');

        const stale = getStrictDecompositionDecisionEvidence(repoRoot, 'T-100', '', 'Different task summary text.');
        assert.equal(stale.evidence_status, 'EVIDENCE_TASK_SUMMARY_MISMATCH');
        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('rejects foreign parent profile evidence while supporting balanced parents and strict children', () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'strict-decomposition-balanced-profile-'));
        const taskSummary = 'Decompose a balanced parent whose frozen profile enables guarded decomposition.';
        const artifact = buildStrictDecompositionDecisionArtifact({
            taskId: 'T-100',
            decision: 'single-cycle',
            taskProfile: 'balanced',
            taskSummary,
            reason: 'The frozen balanced capability requires the same explicit lifecycle decision.',
            scopeRisk: 'The task crosses policy, routing, UI, and evidence boundaries.',
            expectedReviewTypes: ['code'],
            atomicityConstraints: ['Keep the frozen capability and routing contract together.']
        });
        assert.equal(artifact.task_profile, 'balanced');
        writeJsonArtifact(resolveStrictDecompositionDecisionArtifactPath(repoRoot, 'T-100'), artifact);

        assert.equal(
            getStrictDecompositionDecisionEvidence(repoRoot, 'T-100', '', taskSummary, 'balanced').evidence_status,
            'PASS'
        );
        assert.equal(
            getStrictDecompositionDecisionEvidence(repoRoot, 'T-100', '', taskSummary, 'strict').evidence_status,
            'EVIDENCE_TASK_PROFILE_MISMATCH'
        );
        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('accepts legacy non-split evidence without work package contract fields', () => {
        for (const decision of ['atomic', 'single-cycle'] as const) {
            const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), `strict-decomposition-legacy-${decision}-`));
            const taskSummary = `Keep a legacy ${decision} strict decision valid.`;
            const artifact = buildStrictDecompositionDecisionArtifact({
                taskId: 'T-100',
                decision,
                taskSummary,
                reason: 'The existing non-split decision remains bounded and reviewable.',
                scopeRisk: 'Compatibility must not force an unrelated decomposition decision refresh.',
                expectedReviewTypes: ['code'],
                atomicityConstraints: ['Keep legacy non-split evidence readable.']
            }) as unknown as Record<string, unknown>;
            delete artifact.work_package_contract;
            delete artifact.work_package_contract_sha256;
            writeJsonArtifact(resolveStrictDecompositionDecisionArtifactPath(repoRoot, 'T-100'), artifact);

            const evidence = getStrictDecompositionDecisionEvidence(repoRoot, 'T-100', '', taskSummary);

            assert.equal(evidence.evidence_status, 'PASS');
            assert.equal(evidence.decision, decision);
            assert.equal(evidence.work_package_contract_sha256, null);
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('reports missing and invalid JSON decision evidence', () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'strict-decomposition-invalid-evidence-'));
        const missing = getStrictDecompositionDecisionEvidence(repoRoot, 'T-100');
        assert.equal(missing.evidence_status, 'EVIDENCE_FILE_MISSING');

        const artifactPath = resolveStrictDecompositionDecisionArtifactPath(repoRoot, 'T-100');
        fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
        fs.writeFileSync(artifactPath, '{not valid json', 'utf8');

        const invalid = getStrictDecompositionDecisionEvidence(repoRoot, 'T-100');
        assert.equal(invalid.evidence_status, 'EVIDENCE_INVALID_JSON');
        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('rejects explicit evidence artifact paths outside the repo root', () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'strict-decomposition-contained-'));
        const outsidePath = path.join(path.dirname(repoRoot), `outside-${path.basename(repoRoot)}.json`);

        assert.throws(
            () => resolveStrictDecompositionDecisionArtifactPath(repoRoot, 'T-100', outsidePath),
            /inside repo root/
        );
        assert.throws(
            () => getStrictDecompositionDecisionEvidence(repoRoot, 'T-100', outsidePath),
            /inside repo root/
        );

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('rejects proposed children that do not preserve strict profile metadata', () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'strict-decomposition-child-profile-'));
        const artifact = buildStrictDecompositionDecisionArtifact({
            taskId: 'T-100',
            decision: 'split-required',
            taskSummary: 'Implement a risky strict workflow change with several review lanes.',
            reason: 'The scope spans multiple lifecycle contracts and should be split before implementation.',
            scopeRisk: 'The change touches review routing, task queue metadata, and lifecycle evidence.',
            expectedReviewTypes: ['code'],
            atomicityConstraints: ['Keep artifact schema and recorder validation together.'],
            proposedChildTaskIds: ['T-100-1', 'T-100-2'],
            workPackageContract: scopeOnlyWorkPackageContract()
        });
        const artifactPath = resolveStrictDecompositionDecisionArtifactPath(repoRoot, 'T-100');
        writeJsonArtifact(artifactPath, {
            ...artifact,
            proposed_children: [
                { task_id: 'T-100-1', profile: 'balanced' },
                { task_id: 'T-100-2', profile: 'strict' }
            ]
        });

        const evidence = getStrictDecompositionDecisionEvidence(repoRoot, 'T-100');
        assert.match(evidence.evidence_status, /Proposed child profile must be strict/);
        fs.rmSync(repoRoot, { recursive: true, force: true });
    });
});
