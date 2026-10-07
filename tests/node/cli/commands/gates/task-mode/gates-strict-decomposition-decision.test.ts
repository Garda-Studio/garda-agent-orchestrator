import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { runRecordStrictDecompositionDecisionCommand } from '../../../../../../src/cli/commands/gates';

describe('cli/gates record-strict-decomposition-decision', () => {
    function writeWorkPackageContract(repoRoot: string, profile = 'strict', schemaVersion = 1): string {
        const contractPath = path.join(repoRoot, 'runtime', 'tmp', 'T-200-work-package-contract.json');
        fs.mkdirSync(path.dirname(contractPath), { recursive: true });
        fs.writeFileSync(contractPath, `${JSON.stringify({
            schema_version: schemaVersion,
            finding_obligations: [],
            work_packages: [1, 2].map((ordinal) => ({
                task_id: `T-200-${ordinal}`,
                profile,
                root_cause_area: `root-cause-${ordinal}`,
                objective: `Implement independently executable root-cause package ${ordinal}.`,
                scope_obligations: [`Preserve bounded parent scope obligation ${ordinal}.`],
                validation_contract: [`Validate root-cause package ${ordinal} independently.`],
                finding_obligation_ids: [],
                required_review_types: ['code']
            }))
        }, null, 2)}\n`, 'utf8');
        return contractPath;
    }

    function baseOptions(repoRoot: string): Parameters<typeof runRecordStrictDecompositionDecisionCommand>[0] {
        return {
            repoRoot,
            taskId: 'T-200',
            decision: 'atomic',
            taskSummary: 'Keep a tiny strict fix atomic because the observable behavior is indivisible.',
            reason: 'The task updates one indivisible runtime contract and must not be split.',
            scopeRisk: 'Small scope with one expected code review lane and no child routing.',
            expectedReviewTypes: ['code'],
            atomicityConstraints: ['The runtime contract and its direct assertion must land together.']
        };
    }

    it('writes the decision artifact and task-event evidence', () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-strict-decomposition-cli-'));
        const result = runRecordStrictDecompositionDecisionCommand(baseOptions(repoRoot));

        assert.equal(result.exitCode, 0);
        assert.equal(result.outputLines[0], 'STRICT_DECOMPOSITION_DECISION_RECORDED');
        assert.ok(result.outputLines.some((line) => line.includes('Decision: atomic')));

        const artifactPath = path.join(repoRoot, 'runtime', 'reviews', 'T-200-strict-decomposition-decision.json');
        const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8')) as Record<string, unknown>;
        assert.equal(artifact.event_source, 'strict-decomposition-decision');
        assert.equal(artifact.decision, 'atomic');
        assert.equal(artifact.task_profile, 'strict');

        const eventsPath = path.join(repoRoot, 'runtime', 'task-events', 'T-200.jsonl');
        const events = fs.readFileSync(eventsPath, 'utf8');
        assert.match(events, /STRICT_DECOMPOSITION_DECISION_RECORDED/);
        assert.match(events, /strict-decomposition-decision/);
        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('records the actual profile for a decomposition-enabled balanced parent', () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-balanced-decomposition-cli-'));
        const result = runRecordStrictDecompositionDecisionCommand({
            ...baseOptions(repoRoot),
            taskProfile: 'balanced'
        });

        assert.equal(result.exitCode, 0);
        const artifact = JSON.parse(fs.readFileSync(
            path.join(repoRoot, 'runtime', 'reviews', 'T-200-strict-decomposition-decision.json'),
            'utf8'
        )) as { task_profile: string };
        assert.equal(artifact.task_profile, 'balanced');
        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('records split-required work packages from a contained structured contract file', () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-strict-decomposition-work-packages-'));
        const contractPath = writeWorkPackageContract(repoRoot);

        const result = runRecordStrictDecompositionDecisionCommand({
            ...baseOptions(repoRoot),
            decision: 'split-required',
            reason: 'The independent root-cause areas require separate executable child tasks.',
            workPackageContractPath: contractPath
        });

        assert.equal(result.exitCode, 0);
        assert.ok(result.outputLines.includes('WorkPackages: 2'));
        const artifactPath = path.join(repoRoot, 'runtime', 'reviews', 'T-200-strict-decomposition-decision.json');
        const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8')) as {
            proposed_children: Array<{ task_id: string }>;
            work_package_contract: { work_packages: Array<{ root_cause_area: string }> };
        };
        assert.deepEqual(artifact.proposed_children.map((entry) => entry.task_id), ['T-200-1', 'T-200-2']);
        assert.deepEqual(
            artifact.work_package_contract.work_packages.map((entry) => entry.root_cause_area),
            ['root-cause-1', 'root-cause-2']
        );
        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('records version-2 balanced split contracts through actual native admission', () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-balanced-split-cli-'));
        try {
            const result = runRecordStrictDecompositionDecisionCommand({
                ...baseOptions(repoRoot),
                decision: 'split-required',
                taskProfile: 'balanced',
                workPackageContractPath: writeWorkPackageContract(repoRoot, 'balanced', 2)
            });
            assert.equal(result.exitCode, 0);
            const artifact = JSON.parse(fs.readFileSync(
                path.join(repoRoot, 'runtime', 'reviews', 'T-200-strict-decomposition-decision.json'), 'utf8'
            )) as { proposed_children: Array<{ profile: string }>; work_package_contract: { schema_version: number } };
            assert.equal(artifact.work_package_contract.schema_version, 2);
            assert.deepEqual(artifact.proposed_children.map(child => child.profile), ['balanced', 'balanced']);
            assert.match(fs.readFileSync(path.join(repoRoot, 'runtime', 'task-events', 'T-200.jsonl'), 'utf8'), /STRICT_DECOMPOSITION_DECISION_RECORDED/);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('rejects a foreign version-2 child profile without publishing native evidence', () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-balanced-split-rejected-'));
        try {
            assert.throws(() => runRecordStrictDecompositionDecisionCommand({
                ...baseOptions(repoRoot),
                decision: 'split-required',
                taskProfile: 'balanced',
                workPackageContractPath: writeWorkPackageContract(repoRoot, 'fast', 2)
            }), /profile is required and must be balanced/);
            assert.equal(fs.existsSync(path.join(repoRoot, 'runtime', 'reviews', 'T-200-strict-decomposition-decision.json')), false);
            assert.equal(fs.existsSync(path.join(repoRoot, 'runtime', 'task-events', 'T-200.jsonl')), false);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('rejects explicit artifact and metrics paths outside the repo root', () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-strict-decomposition-cli-contained-'));
        const outsideArtifactPath = path.join(path.dirname(repoRoot), `outside-artifact-${path.basename(repoRoot)}.json`);
        const outsideMetricsPath = path.join(path.dirname(repoRoot), `outside-metrics-${path.basename(repoRoot)}.jsonl`);

        assert.throws(
            () => runRecordStrictDecompositionDecisionCommand({
                ...baseOptions(repoRoot),
                artifactPath: outsideArtifactPath
            }),
            /inside repo root/
        );
        assert.throws(
            () => runRecordStrictDecompositionDecisionCommand({
                ...baseOptions(repoRoot),
                decision: 'split-required',
                workPackageContractPath: outsideArtifactPath
            }),
            /inside repo root/
        );
        assert.throws(
            () => runRecordStrictDecompositionDecisionCommand({
                ...baseOptions(repoRoot),
                metricsPath: outsideMetricsPath
            }),
            /inside repo root/
        );

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });
});
