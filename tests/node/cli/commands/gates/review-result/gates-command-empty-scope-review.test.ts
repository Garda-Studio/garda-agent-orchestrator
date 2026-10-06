import test from 'node:test';

import {
    assert, fs, path, createTempRepo, seedTaskQueue, seedInitAnswers,
    initializeGitRepo, writePreflight, runEnterTaskMode, loadTaskEntryRulePack,
    runHandshakeForTask, runShellSmokeForTask, writeCompilePassEvidence,
    getReviewsRoot, buildReviewContext, buildNoFindingsJsonReviewReport,
    runCliWithCapturedOutput, readTaskTimelineEvents, fileSha256
} from './gates-command-review-result-fixtures';
import {
    prepareReviewerLaunchForTest,
    recordReviewerDelegationStartedForTest
} from '../review-launch/gates-command-review-launch-fixtures';
import {
    buildReviewDependencyDiagnostics,
    type ReviewDependencyTimelineEvent
} from '../../../../../../src/gates/review/review-dependencies';

const TASK_ID = 'T-969-3';
const REVIEWER_IDENTITY = 'agent:empty-scope-test-provider';
const PROVIDER_INVOCATION_ID = 'test-empty-scope-invocation';

async function runNativeGate(repoRoot: string, args: string[]): Promise<void> {
    const result = await runCliWithCapturedOutput(['gate', ...args, '--repo-root', repoRoot], { cwd: repoRoot });
    assert.equal(result.exitCode, 0, result.errors.join('\n'));
}

function resolveFixturePath(repoRoot: string, filePath: string): string {
    return path.isAbsolute(filePath) ? filePath : path.resolve(repoRoot, filePath);
}

test('native empty-scope report preserves launch chronology and rejects stale result replay', { concurrency: false }, async () => {
    const repoRoot = createTempRepo();
    seedTaskQueue(repoRoot, TASK_ID);
    seedInitAnswers(repoRoot, 'Codex');
    const existingTestPath = 'tests/node/existing.test.ts';
    fs.mkdirSync(path.join(repoRoot, 'tests', 'node'), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, existingTestPath),
        "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('existing baseline', () => { assert.ok(true); });\n", 'utf8');
    const preflightPath = writePreflight(repoRoot, TASK_ID);
    initializeGitRepo(repoRoot);
    const entry = runEnterTaskMode({
        repoRoot, taskId: TASK_ID, provider: 'Codex',
        taskSummary: 'Review the current src/app.ts with independent code and test review.',
        plannedChangedFiles: ['src/app.ts', existingTestPath]
    });
    assert.equal(entry.exitCode, 0);
    assert.equal(loadTaskEntryRulePack(repoRoot, TASK_ID).exitCode, 0);
    runHandshakeForTask(repoRoot, TASK_ID, 'Codex');
    runShellSmokeForTask(repoRoot, TASK_ID, 'Codex');
    await runNativeGate(repoRoot, [
        'classify-change', '--task-id', TASK_ID,
        '--task-intent', 'Review the current src/app.ts with independent code and test review.',
        '--changed-file', 'src/app.ts', '--changed-file', existingTestPath, '--output-path', preflightPath
    ]);
    const postPreflightRules = ['00-core', '15-project-memory', '40-commands', '80-task-workflow', '90-skill-catalog']
        .flatMap((name) => ['--loaded-rule-file', `garda-agent-orchestrator/live/docs/agent-rules/${name}.md`]);
    await runNativeGate(repoRoot, [
        'load-rule-pack', '--task-id', TASK_ID, '--stage', 'POST_PREFLIGHT',
        '--preflight-path', preflightPath, ...postPreflightRules
    ]);
    writeCompilePassEvidence(repoRoot, TASK_ID, preflightPath);
    const reviewsRoot = getReviewsRoot(repoRoot);
    const contextPath = path.join(reviewsRoot, `${TASK_ID}-code-review-context.json`);
    buildReviewContext({
        reviewType: 'code', depth: 2, preflightPath, outputPath: contextPath, repoRoot,
        tokenEconomyConfigPath: path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'token-economy.json'),
        scopedDiffMetadataPath: path.join(reviewsRoot, `${TASK_ID}-code-scoped.json`)
    });
    const context = JSON.parse(fs.readFileSync(contextPath, 'utf8'));
    assert.deepEqual(context.review_execution.full_review_scope, []);
    assert.deepEqual(context.coverage_contract.obligations, []);
    assert.equal(context.coverage_contract.required, false);
    const outputTemplatePath = resolveFixturePath(repoRoot, context.reviewer_handoff.output_template.artifact_path);
    const outputTemplate = fs.readFileSync(outputTemplatePath, 'utf8');
    assert.doesNotMatch(outputTemplate, /<changed-file>/u);
    const jsonTemplateOffset = outputTemplate.indexOf('\n{');
    assert.ok(jsonTemplateOffset >= 0);
    assert.deepEqual(JSON.parse(outputTemplate.slice(jsonTemplateOffset + 1)).validation_notes[0].evidence, []);

    const pendingIdentity = `agent:pending:${TASK_ID}-code`;
    await runNativeGate(repoRoot, [
        'record-review-routing', '--task-id', TASK_ID, '--review-type', 'code',
        '--reviewer-execution-mode', 'delegated_subagent', '--reviewer-identity', pendingIdentity
    ]);
    const launchPath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'tmp', 'reviews', TASK_ID, 'code', 'reviewer-launch.json');
    await prepareReviewerLaunchForTest({ repoRoot, taskId: TASK_ID, reviewerIdentity: pendingIdentity, launchArtifactPath: launchPath });
    const prepared = JSON.parse(fs.readFileSync(launchPath, 'utf8'));
    const inputPath = resolveFixturePath(repoRoot, prepared.reviewer_launch_input_artifact_path);
    const inputHash = fileSha256(inputPath);
    await recordReviewerDelegationStartedForTest({
        repoRoot, taskId: TASK_ID, reviewerIdentity: REVIEWER_IDENTITY,
        launchArtifactPath: launchPath, providerInvocationId: PROVIDER_INVOCATION_ID,
        attestationSource: 'test_provider_controller'
    });
    const started = JSON.parse(fs.readFileSync(launchPath, 'utf8'));
    const report = buildNoFindingsJsonReviewReport(contextPath, TASK_ID);
    report.validation_notes = [{
        id: 'N-001', topic: 'empty-scope-review',
        note: 'The authenticated source scope is empty. Current supporting records were inspected without claiming source coverage.',
        evidence: []
    }];
    report.coverage_ledger = { coverage_contract_sha256: context.coverage_contract.contract_sha256, entries: [] };
    report.reviewer_notes = [];
    const outputPath = resolveFixturePath(repoRoot, prepared.review_output_path);
    fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    await runNativeGate(repoRoot, [
        'complete-reviewer-launch', '--task-id', TASK_ID, '--review-type', 'code',
        '--review-context-path', contextPath, '--reviewer-execution-mode', 'delegated_subagent',
        '--reviewer-identity', REVIEWER_IDENTITY, '--reviewer-launch-artifact-path', launchPath,
        '--provider-invocation-id', PROVIDER_INVOCATION_ID, '--attestation-source', 'test_provider_controller',
        '--launch-input-mode', 'launch_artifact_path', '--launch-input-artifact-path', inputPath,
        '--launch-input-sha256', inputHash, '--fork-context', 'false', '--record-invocation'
    ]);
    const completed = JSON.parse(fs.readFileSync(launchPath, 'utf8'));
    assert.equal(completed.delegation_started_at_utc, started.delegation_started_at_utc);
    assert.equal(fileSha256(inputPath), inputHash);
    const resultArgs = [
        'record-review-result', '--task-id', TASK_ID, '--review-type', 'code',
        '--preflight-path', preflightPath, '--review-output-path', outputPath,
        '--reviewer-execution-mode', 'delegated_subagent', '--reviewer-identity', REVIEWER_IDENTITY
    ];
    await runNativeGate(repoRoot, resultArgs);
    const receiptPath = path.join(reviewsRoot, `${TASK_ID}-code-receipt.json`);
    assert.ok(fs.existsSync(receiptPath));
    const acceptedReceiptHash = fileSha256(receiptPath);
    const rawEvents = readTaskTimelineEvents(repoRoot, TASK_ID);
    const preparedIndex = rawEvents.findIndex((entry) => entry.event_type === 'REVIEWER_LAUNCH_PREPARED');
    const startedIndex = rawEvents.findIndex((entry) => entry.event_type === 'REVIEWER_DELEGATION_STARTED');
    const invocationIndex = rawEvents.findIndex((entry) => entry.event_type === 'REVIEWER_INVOCATION_ATTESTED');
    const recordedIndex = rawEvents.findIndex((entry) => entry.event_type === 'REVIEW_RECORDED');
    assert.ok(preparedIndex >= 0 && startedIndex > preparedIndex);
    assert.ok(invocationIndex > startedIndex && recordedIndex > invocationIndex);
    const timelineEvents = rawEvents.map((entry, sequence) => ({ ...entry, sequence })) as ReviewDependencyTimelineEvent[];
    const dependency = buildReviewDependencyDiagnostics({
        taskId: TASK_ID, preflightPath,
        preflightPayload: JSON.parse(fs.readFileSync(preflightPath, 'utf8')),
        reviewType: 'test', timelineEvents
    });
    assert.deepEqual(dependency.requiredUpstreamReviews, ['code']);
    assert.ok(dependency.statuses[0].ready || (
        dependency.statuses[0].blockerCode === 'stale_freshness'
        && /not sufficiently trustworthy/u.test(dependency.statuses[0].reason)
    ), dependency.statuses[0].reason);
    assert.doesNotMatch(dependency.statuses[0].reason, /review artifact verdict is 'missing'/u);

    report.tree_state_sha256 = 'd'.repeat(64);
    fs.writeFileSync(path.join(reviewsRoot, `${TASK_ID}-code.md`), JSON.stringify(report), 'utf8');
    const replay = buildReviewDependencyDiagnostics({
        taskId: TASK_ID, preflightPath,
        preflightPayload: JSON.parse(fs.readFileSync(preflightPath, 'utf8')),
        reviewType: 'test', timelineEvents
    });
    assert.equal(replay.statuses[0].ready, false);
    assert.equal(replay.statuses[0].blockerCode, 'stale_freshness');
    assert.match(replay.statuses[0].reason, /hash no longer matches its receipt/u);
    assert.equal(fileSha256(receiptPath), acceptedReceiptHash);
});
