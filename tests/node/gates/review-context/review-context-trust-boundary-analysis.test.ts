import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    appendMandatoryTaskEvent
} from '../../../../src/gate-runtime/task-events';

import {
    buildDefaultWorkflowConfig
} from '../../../../src/core/workflow-config';
import {
    TRUST_BOUNDARY_ANALYSIS_RULE_ID,
    assessTrustBoundaryAnalysisApplicability
} from '../../../../src/core/trust-boundary-analysis';
import {
    buildQualityChecklistArtifact,
    buildQualityChecklistAnswersTemplate,
    resolveDefaultQualityChecklistArtifactPath
} from '../../../../src/gates/quality-checklist';
import {
    buildTrustBoundaryAnalysisMarkdown,
    readQualityValidationPhaseAnalysis,
    readReviewContextTrustBoundaryAnalysis
} from '../../../../src/gates/review-context/review-context-trust-boundary-analysis';
import {
    fileSha256
} from '../../../../src/gates/shared/helpers';
import {
    createGateFixture,
    writeGateFixturePreflight
} from '../../gate-fixtures';
import { runQualityChecklistCommand } from '../../../../src/cli/commands/gate-flows/quality-checklist/quality-checklist-flow';
import { handleWorkflow } from '../../../../src/cli/commands/workflow-command';
import { runClassifyChangeCommand } from '../../../../src/cli/commands/gates';
import { executeValidationRecipe } from '../../../../src/gates/project-validation/execution';
import { evaluateValidationAttempt } from '../../../../src/gates/project-validation/result-evaluation';
import type { QualityValidationPhases } from '../../../../src/gates/quality-checklist/quality-checklist-validation-phases';
import { createTempRepo, initializeGitRepo, loadTaskEntryRulePack, runEnterTaskMode, runHandshakeForTask,
    runShellSmokeForTask, seedInitAnswers, seedTaskQueue } from '../../cli/commands/gates/preflight/gates-preflight-fixtures';
import { removeTempRepoWithRetry } from '../../cli/commands/gate-test-repo-bootstrap';

function declaredReviewFixture(scope = 'security') {
    const repoRoot = createTempRepo(), taskId = 'T-declared-review';
    const orchestratorRoot = path.join(repoRoot, 'garda-agent-orchestrator');
    const configPath = path.join(orchestratorRoot, 'live/config/workflow-config.json');
    const source = `src/${scope}/catalog.ts`;
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(buildDefaultWorkflowConfig()));
    fs.mkdirSync(path.dirname(path.join(repoRoot, source)), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, source), 'export const evidence = 1;\n');
    fs.writeFileSync(path.join(repoRoot, 'RootSuite'), 'unknown project syntax');
    fs.writeFileSync(path.join(repoRoot, 'driver'), 'process.stdout.write("opaque observed output");');
    fs.writeFileSync(path.join(repoRoot, 'recipes.json'), JSON.stringify({ schema_version: 1, recipes: [{
        id: 'neutral', purpose: 'test', executable: process.execPath, argv: ['driver', { target: 'opaque-1' }],
        cwd: '.', environment: {}, inputs: [{ path: source, role: 'source' }, { path: 'RootSuite', role: 'test' },
            { path: 'driver', role: 'helper' }], targets: [{ id: 'opaque-1', source: 'RootSuite', selector: 'declared case' }],
        timeout_ms: 5000, max_attempts: 3, max_output_bytes: 1024, max_input_bytes: 65536,
        required_capabilities: [], result_format: 'tap'
    }] }));
    seedInitAnswers(repoRoot); seedTaskQueue(repoRoot, taskId, 'TODO', 'default', '', 'Declared review evidence');
    initializeGitRepo(repoRoot);
    handleWorkflow(['set', '--target-root', repoRoot, '--project-validation-contract', 'recipes.json',
        '--operator-confirmed', 'yes', '--operator-confirmed-at-utc', new Date().toISOString()],
    { name: 'garda-agent-orchestrator', version: '1.0.0' });
    runEnterTaskMode({ repoRoot, taskId, entryMode: 'EXPLICIT_TASK_EXECUTION', requestedDepth: 2,
        taskSummary: 'Declared review evidence', provider: 'Codex' });
    loadTaskEntryRulePack(repoRoot, taskId); runHandshakeForTask(repoRoot, taskId); runShellSmokeForTask(repoRoot, taskId);
    fs.appendFileSync(path.join(repoRoot, source), '\nexport const changed = 1;\n');
    fs.appendFileSync(path.join(repoRoot, 'RootSuite'), '\ncurrent source\n');
    const preflightPath = path.join(orchestratorRoot, 'runtime/reviews', `${taskId}-preflight.json`);
    runClassifyChangeCommand({ repoRoot, taskId, taskIntent: 'Declared review evidence',
        outputPath: preflightPath, changedFiles: [source, 'RootSuite'], emitMetrics: false });
    const trust = buildAnswers().find(answer => answer.rule_id === TRUST_BOUNDARY_ANALYSIS_RULE_ID)!;
    const matrix = trust.trust_boundary_matrix as Array<Record<string, unknown>>;
    matrix[0].negative_paths = [{ kind: 'other', scenario: 'declared case', expected_behavior: 'Reject invalid evidence.',
        evidence_files: ['RootSuite#opaque-1'] }];
    const answers = buildQualityChecklistAnswersTemplate({ repoRoot, taskId, preflightPath }).answers
        .map(answer => answer.rule_id === TRUST_BOUNDARY_ANALYSIS_RULE_ID ? trust
            : { ...answer, status: 'PASS', answer: 'Checked current scope.' });
    const artifactPath = resolveDefaultQualityChecklistArtifactPath(repoRoot, taskId);
    return { repoRoot, taskId, orchestratorRoot, artifactPath,
        cleanup: () => removeTempRepoWithRetry(repoRoot),
        publish: () => runQualityChecklistCommand({ repoRoot, taskId, preflightPath, answersJson: JSON.stringify(answers), emitMetrics: false }),
        read: () => readReviewContextTrustBoundaryAnalysis({ repoRoot, taskId,
            preflight: JSON.parse(fs.readFileSync(preflightPath, 'utf8')), preflightSha256: fileSha256(preflightPath) }),
        readNavigation: () => readQualityValidationPhaseAnalysis({ repoRoot, taskId,
            preflight: JSON.parse(fs.readFileSync(preflightPath, 'utf8')), preflightSha256: fileSha256(preflightPath) }),
        matrixRequired: () => assessTrustBoundaryAnalysisApplicability(JSON.parse(fs.readFileSync(preflightPath, 'utf8'))).required,
        execute: async (signal?: AbortSignal) => {
            const attempt = await executeValidationRecipe({ repoRoot, taskId, recipeId: 'neutral', signal });
            return evaluateValidationAttempt({ repoRoot, taskId, attemptId: attempt.attempt_id });
        },
        phases: () => (JSON.parse(fs.readFileSync(artifactPath, 'utf8')) as { validation_phases: QualityValidationPhases }).validation_phases
    };
}

function buildAnswers(): Array<Record<string, unknown>> {
    const scenario = 'fails closed for missing, replaced, foreign, and stale matrix artifacts';
    const universalAnswers = buildDefaultWorkflowConfig().optional_quality_checks.rules
        .filter((rule) => !rule.included_changed_file_regexes?.length)
        .map((rule) => ({
            rule_id: rule.id,
            status: 'PASS',
            answer: `Checked ${rule.id}.`,
            evidence_files: ['src/gates/review/review-findings-schema.ts']
        }));
    return [...universalAnswers, {
        rule_id: TRUST_BOUNDARY_ANALYSIS_RULE_ID,
        status: 'PASS',
        answer: 'Mapped the reviewer output receipt boundary.',
        evidence_files: ['tests/node/gates/review-context/review-context-trust-boundary-analysis.test.ts'],
        trust_boundary_matrix: [{
            boundary_id: 'TB-001',
            boundary: 'Mutable reviewer output to authenticated receipt',
            authority_source: 'Gate-owned launch input and receipt bindings',
            mutable_inputs: ['provider reviewer output'],
            integrity_evidence: ['launch input sha256', 'review context sha256'],
            canonical_reconstruction: 'Rebuild the receipt from immutable launch input and normalized findings.',
            toctou_replay: 'Reject prior-cycle or pre-delegation output.',
            negative_paths: [{
                kind: 'foreign',
                scenario,
                expected_behavior: 'Reject without accepted review state.',
                evidence_files: [
                    `tests/node/gates/review-context/review-context-trust-boundary-analysis.test.ts#${scenario}`
                ]
            }]
        }]
    }];
}

function writeCurrentArtifact(fixture: ReturnType<typeof createGateFixture>, preflightPath: string): string {
    const evidencePath = path.join(
        fixture.repoRoot,
        'tests',
        'node',
        'gates',
        'review-context',
        'review-context-trust-boundary-analysis.test.ts'
    );
    fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
    fs.writeFileSync(
        evidencePath,
        "test('fails closed for missing, replaced, foreign, and stale matrix artifacts', () => { assert.equal(true, true); });\n",
        'utf8'
    );
    const artifact = buildQualityChecklistArtifact({
        repoRoot: fixture.repoRoot,
        taskId: fixture.taskId,
        preflightPath,
        answers: buildAnswers()
    });
    const artifactPath = resolveDefaultQualityChecklistArtifactPath(fixture.repoRoot, fixture.taskId);
    fs.writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
    const artifactSha256 = fileSha256(artifactPath);
    appendMandatoryTaskEvent(
        fixture.orchestratorRoot,
        fixture.taskId,
        'QUALITY_CHECKLIST_RECORDED',
        artifact.outcome,
        `Quality checklist recorded: ${artifact.status}.`,
        {
            artifact_path: artifactPath.replace(/\\/gu, '/'),
            artifact_hash: artifactSha256,
            status: artifact.status,
            outcome: artifact.outcome,
            checklist_id: artifact.checklist_id,
            preflight_path: artifact.preflight_path,
            preflight_sha256: artifact.preflight_sha256
        }
    );
    return artifactPath;
}

describe('review-context trust-boundary handoff', () => {
    it('admits observed declared execution with exact pending semantics and rejects superseded evidence', async () => {
        const f = declaredReviewFixture();
        try {
            f.publish();
            assert.equal(JSON.parse(fs.readFileSync(f.artifactPath, 'utf8')).status, 'PENDING_VALIDATION');
            assert.equal(f.read().status, 'invalid');
            assert.equal(f.readNavigation().status, 'current');
            assert.equal(f.readNavigation().validation_phases?.execution, 'PENDING');
            const result = await f.execute();
            assert.equal(result.status, 'UNRESOLVED');
            f.publish();
            const analysis = f.read() as ReturnType<typeof f.read> & { validation_phases?: QualityValidationPhases };
            assert.equal(analysis.status, 'current');
            assert.deepEqual(analysis.validation_phases, f.phases());
            assert.equal(analysis.validation_phases?.semantic, 'PENDING_INDEPENDENT_REVIEW');
            assert.match(buildTrustBoundaryAnalysisMarkdown(analysis).join('\n'), /opaque-1.*PENDING_INDEPENDENT_REVIEW/u);
            const controller = new AbortController(); controller.abort();
            await f.execute(controller.signal);
            assert.equal(f.read().status, 'invalid');
        } finally { await f.cleanup(); }
    });

    it('requires declared execution even for a scope without a trust-matrix trigger', async () => {
        const f = declaredReviewFixture('domain');
        try {
            assert.equal(f.matrixRequired(), false);
            f.publish();
            assert.equal(f.read().required, true);
            assert.equal(f.read().status, 'invalid');
            await f.execute(); f.publish();
            assert.equal(f.read().status, 'current');
        } finally { await f.cleanup(); }
    });

    it('rejects old-schema and altered declared phases even with an authentic current artifact binding', async () => {
        const f = declaredReviewFixture();
        try {
            await f.execute(); f.publish();
            const original = JSON.parse(fs.readFileSync(f.artifactPath, 'utf8'));
            for (const mutation of ['legacy', 'semantic', 'foreign', 'preflight', 'obligation']) {
                const artifact = structuredClone(original);
                if (mutation === 'legacy') { artifact.status = 'PASS'; delete artifact.validation_phases; }
                else if (mutation === 'semantic') artifact.validation_phases.semantic = 'PASS';
                else if (mutation === 'foreign') artifact.validation_phases.task_id = 'T-foreign';
                else if (mutation === 'preflight') artifact.validation_phases.preflight_sha256 = '0'.repeat(64);
                else artifact.validation_phases.obligations = [];
                fs.writeFileSync(f.artifactPath, JSON.stringify(artifact));
                appendMandatoryTaskEvent(f.orchestratorRoot, f.taskId, 'QUALITY_CHECKLIST_RECORDED', 'INFO', 'Negative fixture binding.', {
                    artifact_path: f.artifactPath.replace(/\\/gu, '/'), artifact_hash: fileSha256(f.artifactPath),
                    checklist_id: artifact.checklist_id, preflight_sha256: artifact.preflight_sha256
                });
                assert.equal(f.read().status, 'invalid', mutation);
                assert.match(f.read().violations.join(' '), /phase/u, mutation);
            }
            assert.equal(f.read().status, 'invalid');
        } finally { await f.cleanup(); }
    });
    it('renders the authenticated current matrix into reviewer prompt content', () => {
        const fixture = createGateFixture({ taskId: 'T-review-trust-boundary' });
        try {
            const preflightPath = writeGateFixturePreflight(fixture, {
                changed_files: ['src/gates/review/review-findings-schema.ts'],
                triggers: { security: true }
            });
            writeCurrentArtifact(fixture, preflightPath);
            const analysis = readReviewContextTrustBoundaryAnalysis({
                repoRoot: fixture.repoRoot,
                taskId: fixture.taskId,
                preflight: JSON.parse(fs.readFileSync(preflightPath, 'utf8')),
                preflightSha256: fileSha256(preflightPath)
            });

            assert.equal(analysis.status, 'current');
            assert.equal(analysis.artifact_sha256, analysis.recorded_artifact_sha256);
            assert.match(String(analysis.binding_event_sha256), /^[a-f0-9]{64}$/u);
            assert.equal(analysis.matrix.length, 1);
            const promptSection = buildTrustBoundaryAnalysisMarkdown(analysis).join('\n');
            assert.match(promptSection, /Trust-Boundary Analysis/u);
            assert.match(promptSection, /Mutable reviewer output to authenticated receipt/u);
            assert.match(promptSection, /\[foreign\]/u);
            assert.match(promptSection, /verify every listed boundary and negative path/u);
        } finally {
            fixture.cleanup();
        }
    });

    it('fails closed for missing, replaced, foreign, and stale matrix artifacts', () => {
        const scenarios = ['missing', 'replaced', 'foreign', 'stale'] as const;
        for (const scenario of scenarios) {
            const fixture = createGateFixture({ taskId: `T-review-trust-${scenario}` });
            try {
                const preflightPath = writeGateFixturePreflight(fixture, {
                    changed_files: ['src/gates/review/review-findings-schema.ts'],
                    triggers: { security: true }
                });
                const artifactPath = resolveDefaultQualityChecklistArtifactPath(fixture.repoRoot, fixture.taskId);
                if (scenario !== 'missing') {
                    writeCurrentArtifact(fixture, preflightPath);
                    if (scenario === 'replaced') {
                        const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
                        const answer = artifact.answers.find((entry: Record<string, unknown>) => (
                            entry.rule_id === TRUST_BOUNDARY_ANALYSIS_RULE_ID
                        ));
                        answer.trust_boundary_matrix[0].boundary = 'Syntactically valid replacement matrix';
                        fs.writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
                    } else {
                        const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
                        if (scenario === 'foreign') artifact.task_id = 'T-foreign';
                        if (scenario === 'stale') artifact.preflight_sha256 = '0'.repeat(64);
                        fs.writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
                    }
                }
                const analysis = readReviewContextTrustBoundaryAnalysis({
                    repoRoot: fixture.repoRoot,
                    taskId: fixture.taskId,
                    preflight: JSON.parse(fs.readFileSync(preflightPath, 'utf8')),
                    preflightSha256: fileSha256(preflightPath)
                });
                assert.notEqual(analysis.status, 'current', scenario);
                assert.equal(analysis.matrix.length, 0, scenario);
                assert.ok(analysis.violations.length > 0, scenario);
                if (scenario === 'replaced') {
                    assert.match(analysis.violations.join(' '), /does not match its gate-recorded/u);
                }
            } finally {
                fixture.cleanup();
            }
        }
        assert.equal(scenarios.length, 4);
    });

    it('hashes and parses one immutable artifact byte snapshot', () => {
        const fixture = createGateFixture({ taskId: 'T-review-trust-snapshot' });
        try {
            const preflightPath = writeGateFixturePreflight(fixture, {
                changed_files: ['src/gates/review/review-findings-schema.ts'],
                triggers: { security: true }
            });
            const artifactPath = writeCurrentArtifact(fixture, preflightPath);
            const originalReadFileSync = fs.readFileSync;
            let artifactReadCount = 0;
            const readMock = mock.method(fs, 'readFileSync', (
                filePath: fs.PathOrFileDescriptor,
                options?: BufferEncoding | null
            ) => {
                const result = options
                    ? originalReadFileSync(filePath, options)
                    : originalReadFileSync(filePath);
                if (path.resolve(String(filePath)) === path.resolve(artifactPath)) {
                    artifactReadCount += 1;
                    if (artifactReadCount === 1) {
                        const replacement = JSON.parse(Buffer.isBuffer(result) ? result.toString('utf8') : result);
                        replacement.task_id = 'T-foreign-after-read';
                        fs.writeFileSync(artifactPath, `${JSON.stringify(replacement, null, 2)}\n`, 'utf8');
                    }
                }
                return result;
            });
            try {
                const analysis = readReviewContextTrustBoundaryAnalysis({
                    repoRoot: fixture.repoRoot,
                    taskId: fixture.taskId,
                    preflight: JSON.parse(originalReadFileSync(preflightPath, 'utf8')),
                    preflightSha256: fileSha256(preflightPath)
                });

                assert.equal(analysis.status, 'current');
                assert.equal(artifactReadCount, 1);
                assert.equal(readMock.mock.callCount() > 0, true);
            } finally {
                mock.restoreAll();
            }
        } finally {
            fixture.cleanup();
        }
    });

    it('rejects an external artifact junction before hashing its target', (t) => {
        const fixture = createGateFixture({ taskId: 'T-review-trust-external-junction' });
        const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-trust-outside-'));
        let linkedReviewsRoot: string | null = null;
        try {
            const preflightPath = writeGateFixturePreflight(fixture, {
                changed_files: ['src/gates/review/review-findings-schema.ts'],
                triggers: { security: true }
            });
            const artifactPath = writeCurrentArtifact(fixture, preflightPath);
            const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
            const preflightSha256 = fileSha256(preflightPath);
            const reviewsRoot = path.dirname(artifactPath);
            const outsideReviewsRoot = path.join(outsideRoot, 'reviews');
            fs.cpSync(reviewsRoot, outsideReviewsRoot, { recursive: true });
            fs.rmSync(reviewsRoot, { recursive: true, force: true });
            try {
                fs.symlinkSync(
                    outsideReviewsRoot,
                    reviewsRoot,
                    process.platform === 'win32' ? 'junction' : 'dir'
                );
                linkedReviewsRoot = reviewsRoot;
            } catch (error: unknown) {
                t.skip(`directory junction creation unavailable in this environment: ${error instanceof Error ? error.message : String(error)}`);
                return;
            }

            const analysis = readReviewContextTrustBoundaryAnalysis({
                repoRoot: fixture.repoRoot,
                taskId: fixture.taskId,
                preflight,
                preflightSha256
            });

            assert.equal(analysis.status, 'invalid');
            assert.equal(analysis.artifact_sha256, null);
            assert.match(analysis.violations.join(' '), /escapes the repository through a symlink or junction/u);
        } finally {
            if (linkedReviewsRoot) {
                fs.rmSync(linkedReviewsRoot, { recursive: true, force: true });
            }
            fixture.cleanup();
            fs.rmSync(outsideRoot, { recursive: true, force: true });
        }
    });

    it('skips unrelated low-risk changes', () => {
        const fixture = createGateFixture({ taskId: 'T-review-trust-skip' });
        try {
            const preflightPath = writeGateFixturePreflight(fixture, {
                changed_files: ['src/domain/catalog.ts'],
                triggers: {}
            });
            const analysis = readReviewContextTrustBoundaryAnalysis({
                repoRoot: fixture.repoRoot,
                taskId: fixture.taskId,
                preflight: JSON.parse(fs.readFileSync(preflightPath, 'utf8')),
                preflightSha256: fileSha256(preflightPath)
            });
            assert.equal(analysis.status, 'not_required');
            assert.deepEqual(buildTrustBoundaryAnalysisMarkdown(analysis), []);
        } finally {
            fixture.cleanup();
        }
    });
});
