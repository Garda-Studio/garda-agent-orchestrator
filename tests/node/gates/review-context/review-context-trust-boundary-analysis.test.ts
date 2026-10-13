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
import { readValidationReviewObligations } from '../../../../src/gates/review/validation-obligations';
import { buildReviewContext, getRulePack } from '../../../../src/gates/review-context/build-review-context';
import { getReviewContextContractViolations, buildReviewContextPreflightDiffExpectations } from '../../../../src/gates/review-context/review-context-contract';
import { buildReviewCoverageContract } from '../../../../src/gates/review/review-coverage-ledger';
import { buildAuthoritativeReviewCoverageContract } from '../../../../src/gates/review-context/review-context-coverage';
import type { QualityValidationPhases } from '../../../../src/gates/quality-checklist/quality-checklist-validation-phases';
import { createTempRepo, initializeGitRepo, loadTaskEntryRulePack, runEnterTaskMode, runHandshakeForTask,
    runShellSmokeForTask, seedInitAnswers, seedTaskQueue } from '../../cli/commands/gates/preflight/gates-preflight-fixtures';
import { removeTempRepoWithRetry } from '../../cli/commands/gate-test-repo-bootstrap';

function declaredReviewFixture(scope = 'security', options: { declared?: boolean; preflightFilename?: string; unchangedTarget?: boolean; taskModeFilename?: string } = {}) {
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
    if (options.declared !== false) handleWorkflow(['set', '--target-root', repoRoot, '--project-validation-contract', 'recipes.json',
        '--operator-confirmed', 'yes', '--operator-confirmed-at-utc', new Date().toISOString()],
    { name: 'garda-agent-orchestrator', version: '1.0.0' });
    const taskModePath = path.join(orchestratorRoot, 'runtime/reviews', options.taskModeFilename ?? `${taskId}-task-mode.json`);
    runEnterTaskMode({ repoRoot, taskId, entryMode: 'EXPLICIT_TASK_EXECUTION', requestedDepth: 2,
        artifactPath: taskModePath, taskSummary: 'Declared review evidence', provider: 'Codex' });
    loadTaskEntryRulePack(repoRoot, taskId, taskModePath); runHandshakeForTask(repoRoot, taskId); runShellSmokeForTask(repoRoot, taskId);
    fs.appendFileSync(path.join(repoRoot, source), '\nexport const changed = 1;\n');
    if (!options.unchangedTarget) fs.appendFileSync(path.join(repoRoot, 'RootSuite'), '\ncurrent source\n');
    const preflightPath = path.join(orchestratorRoot, 'runtime/reviews', options.preflightFilename ?? `${taskId}-preflight.json`);
    runClassifyChangeCommand({ repoRoot, taskId, taskModePath, taskIntent: 'Declared review evidence',
        outputPath: preflightPath, changedFiles: options.unchangedTarget ? [source] : [source, 'RootSuite'], emitMetrics: false });
    const trust = buildAnswers().find(answer => answer.rule_id === TRUST_BOUNDARY_ANALYSIS_RULE_ID)!;
    const matrix = trust.trust_boundary_matrix as Array<Record<string, unknown>>;
    matrix[0].negative_paths = [{ kind: 'other', scenario: 'declared case', expected_behavior: 'Reject invalid evidence.',
        evidence_files: ['RootSuite#opaque-1'] }];
    const answers = buildQualityChecklistAnswersTemplate({ repoRoot, taskId, preflightPath }).answers
        .map(answer => answer.rule_id === TRUST_BOUNDARY_ANALYSIS_RULE_ID ? trust
            : { ...answer, status: 'PASS', answer: 'Checked current scope.' });
    const artifactPath = resolveDefaultQualityChecklistArtifactPath(repoRoot, taskId);
    return { repoRoot, taskId, orchestratorRoot, artifactPath, preflightPath, taskModePath,
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
    it('rejects missing or changed retained evidence and blocks DONE execution', async () => {
        const f = declaredReviewFixture('domain', { unchangedTarget: true, preflightFilename: 'retained-custom.json', taskModeFilename: 'retained-mode.json' });
        try {
            await f.execute(); f.publish();
            const current = { repoRoot: f.repoRoot, taskId: f.taskId, preflightPath: f.preflightPath, taskModePath: f.taskModePath };
            const active = readValidationReviewObligations(current);
            const retained = { ...current, inspection: 'retained_completed' as const };
            // Model closed lifecycle metadata only; this fixture is not delegated review or native task acceptance evidence.
            seedTaskQueue(f.repoRoot, f.taskId, 'DONE', 'default', '', 'Declared review evidence');
            assert.throws(() => readValidationReviewObligations(retained));
            appendMandatoryTaskEvent(f.orchestratorRoot, f.taskId, 'COMPLETION_GATE_PASSED', 'PASS',
                'Closed-state inspection fixture.', { status: 'PASSED', outcome: 'PASS', preflight_path: f.preflightPath, violations: [] });
            assert.deepEqual(readValidationReviewObligations(retained), active);
            assert.equal(active.obligations[0].result_status, 'UNRESOLVED');
            assert.throws(() => readValidationReviewObligations(current), /active native task/u);
            await assert.rejects(executeValidationRecipe({ repoRoot: f.repoRoot, taskId: f.taskId, recipeId: 'neutral' }), /active native task/u);
            await assert.rejects(evaluateValidationAttempt({ repoRoot: f.repoRoot, taskId: f.taskId,
                attemptId: active.obligations[0].attempt_id! }), /active native task/u);
            fs.appendFileSync(path.join(f.repoRoot, 'RootSuite'), '\nchanged after closure');
            assert.throws(() => readValidationReviewObligations(retained));
        } finally { await f.cleanup(); }
    });

    it('legacy coverage inspection preserves pending declared evidence without claiming target closure', async () => {
        const f = declaredReviewFixture('domain');
        try {
            const preflight = JSON.parse(fs.readFileSync(f.preflightPath, 'utf8'));
            const coverage = buildAuthoritativeReviewCoverageContract({ reviewType: 'code', preflight, repoRoot: f.repoRoot });
            assert.equal(coverage.contract.obligations.some(entry => entry.kind === 'validation'), false);
        } finally { await f.cleanup(); }
    });

    it('binds native declared context coverage and rejects missing or stale targets on a custom preflight', async () => {
        const f = declaredReviewFixture('domain', { unchangedTarget: true, preflightFilename: 'current-custom.json', taskModeFilename: 'current-mode.json' });
        try {
            await f.execute(); f.publish();
            fs.writeFileSync(path.join(f.orchestratorRoot, 'runtime/reviews', `${f.taskId}-task-mode.json`), JSON.stringify({ task_id: 'foreign', profile_policy_snapshot_required: true }));
            const preflight = JSON.parse(fs.readFileSync(f.preflightPath, 'utf8'));
            const lane = preflight.effective_review_snapshot.lanes.find((entry: { id: string }) => entry.id === 'code');
            for (const rule of getRulePack('code').full) {
                const target = path.join(f.orchestratorRoot, 'live/docs/agent-rules', rule);
                fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, `# ${rule}\n`);
            }
            for (const id of lane.definition.skill_ids) {
                const target = path.join(f.orchestratorRoot, 'live/skills', id, 'SKILL.md');
                fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, `# ${id}\nFixture review skill.\n`);
            }
            const contextPath = path.join(f.orchestratorRoot, 'runtime/reviews', `${f.taskId}-code-review-context.json`);
            const context = buildReviewContext({ repoRoot: f.repoRoot, reviewType: 'code', depth: 2,
                preflightPath: f.preflightPath, taskModePath: f.taskModePath, outputPath: contextPath, scopedDiffMetadataPath: '',
                tokenEconomyConfigPath: '', tokenEconomyConfigData: { enabled: false } });
            const bindings = context.coverage_contract.obligations.filter(entry => entry.kind === 'validation');
            assert.deepEqual(bindings.map(entry => entry.validation_binding), f.phases().obligations);
            assert.equal(bindings[0].source, 'RootSuite');
            assert.ok(!context.coverage_scope.changed_files.includes('RootSuite'));
            const inspect = (candidate: typeof context) => getReviewContextContractViolations({
                contextPath, reviewContext: candidate, expectedTaskId: f.taskId, expectedReviewType: 'code',
                expectedPreflightPath: f.preflightPath, expectedPreflightSha256: fileSha256(f.preflightPath),
                expectedPreflightPayload: preflight, repoRoot: f.repoRoot,
                ...buildReviewContextPreflightDiffExpectations(preflight, 'code') });
            assert.deepEqual(inspect(context), []);
            for (const mutation of ['omitted', 'stale']) {
                const altered = structuredClone(context);
                const targets = structuredClone(f.phases().obligations);
                if (mutation === 'omitted') targets.length = 0;
                else targets[0].attempt_id = 'borrowed';
                altered.coverage_contract = buildReviewCoverageContract({ reviewType: 'code',
                    changedFiles: context.coverage_scope.changed_files, validationObligations: targets });
                assert.ok(inspect(altered).some(violation => /coverage contract/u.test(violation)), mutation);
            }
        } finally { await f.cleanup(); }
    });

    it('projects authentic declared targets and rejects stale or superseded evidence without promoting opaque results', async () => {
        const f = declaredReviewFixture('domain', { preflightFilename: 'custom-current-preflight.json' });
        try {
            const projection = readValidationReviewObligations;
            f.publish();
            assert.throws(() => projection(f), /required trust-boundary analysis/u);
            await f.execute(); f.publish();
            const defaultPath = path.join(f.orchestratorRoot, 'runtime/reviews', `${f.taskId}-preflight.json`);
            fs.writeFileSync(defaultPath, JSON.stringify({ task_id: 'foreign' }));
            const result = projection(f);
            assert.deepEqual(result.obligations, f.phases().obligations);
            assert.equal(result.preflight_sha256, fileSha256(f.preflightPath));
            assert.equal(result.validation_phases_sha256, f.phases().sha256);
            assert.ok(result.semantic_review_lanes.length > 0);
            assert.equal(result.obligations[0].source_identity.path, 'RootSuite');
            assert.equal(result.obligations[0].result_status, 'UNRESOLVED');
            assert.equal(f.phases().semantic, 'PENDING_INDEPENDENT_REVIEW');
            assert.throws(() => projection({ ...f, preflightPath: defaultPath }), /latest native classification/u);
            const quality = fs.readFileSync(f.artifactPath);
            fs.appendFileSync(f.artifactPath, ' ');
            assert.throws(() => projection(f), /required trust-boundary analysis/u);
            fs.writeFileSync(f.artifactPath, quality);
            const original = fs.readFileSync(f.preflightPath);
            const preflight = JSON.parse(original.toString());
            preflight.required_reviews.test = !preflight.required_reviews.test;
            fs.writeFileSync(f.preflightPath, JSON.stringify(preflight));
            assert.throws(() => projection(f), /preflight/u);
            fs.writeFileSync(f.preflightPath, original);
            const controller = new AbortController(); controller.abort();
            await f.execute(controller.signal);
            assert.throws(() => projection(f), /required trust-boundary analysis/u);
        } finally { await f.cleanup(); }
    });

    it('preserves an empty validation projection for a current project without declarations', async () => {
        const f = declaredReviewFixture('domain', { declared: false });
        try {
            f.publish();
            assert.deepEqual(readValidationReviewObligations(f), { preflight_sha256: fileSha256(f.preflightPath),
                validation_phases_sha256: null, semantic_review_lanes: [], obligations: [] });
        } finally { await f.cleanup(); }
    });

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
