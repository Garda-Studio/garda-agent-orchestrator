import '../../../../src/bin/garda/derivation-source-receipts';
import { captureClosedReviewGate, prepareClosedReviewCurrentIndex } from '../../../../src/gates/review-attempts/review-closed-cycle-capture';
import { publishClosedReviewHistory } from '../../../../src/gates/review-attempts/review-closed-cycle-storage';
import { readTaskTimelineClosedReviewQuery } from '../../../../src/gate-runtime/timeline/task-events-integrity';
import { getReviewExecutionPreparationOrder } from '../../../../src/core/review-execution-policy';
import { classifyHistoryRemediation } from './next-step-authenticated-remediation-fixture';
import { buildDefaultReviewRemediationModePolicy } from '../../../../src/policy/review-remediation-mode-policy';
import { runProjectMemoryImpactCommand } from '../../../../src/cli/commands/gate-flows/completion/project-memory-flow';
import { runDocImpactGateCommand } from '../../../../src/cli/commands/gate-flows/review/review-flow';
import { handleCompletionGate } from '../../../../src/cli/commands/gate-task-handlers';
import { retainHistoryCorrectionAttempt } from './next-step-authenticated-correction-fixture';
import { appendRestartCompletedEvidence } from '../../../../src/cli/commands/gate-flows/recovery/recovery-flow-restart-evidence';
import { DEFAULT_REVIEW_CYCLE_GUARD_CONFIG } from '../../../../src/core/review-cycle-guard';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as fixture from '../../cli/commands/gates/review-cycle/gates-review-cycle-fixtures';
import { buildReviewRemediationBaselineArtifact, validateReviewRemediationBaselineArtifact } from '../../../../src/gates/review-remediation/review-remediation-baseline';
import { buildReviewRemediationDeltaBase } from '../../../../src/gates/review-remediation/review-remediation-delta-contract';
import { bindAuthoritativeRemediationDecisionToPreflight, buildAuthenticatedRemediationReviewExecution } from '../../../../src/cli/commands/gate-flows/review-context/review-context-flow';
import { resolveAuthoritativeReviewRemediationDecision } from '../../../../src/gates/review-remediation/review-remediation-recovery-routing';
import type { ReviewFindingsValidationArtifact } from '../../../../src/gates/review/review-findings-validation-artifact';
import type { ReviewFindingsDispositionArtifact } from '../../../../src/gates/review/review-findings-disposition-artifact';
import type { ReviewCoverageContract } from '../../../../src/gates/review/review-coverage-ledger';

export interface AuthenticatedHistoryFixture {
    repoRoot: string; taskId: string; preflightPath: string; files: string[]; lanes: string[];
    timelineBytes: number; historicalArtifacts: string[]; artifactCycles: Record<string, number>; correctionProofs: string[]; correctionPackages: Record<string, string>; baselinePath: string; contextPath: string;
    testBaselinePath?: string; testExecution?: ReturnType<typeof buildAuthenticatedRemediationReviewExecution>;
}
const readJson = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'));
const verdict = (lane: string, passed: boolean) => (lane === 'code' ? 'REVIEW' : lane.toUpperCase() + ' REVIEW') + (passed ? ' PASSED' : ' FAILED');

function retainBaseline(state: AuthenticatedHistoryFixture, lane: string): string {
    const root = fixture.getReviewsRoot(state.repoRoot), prefix = path.join(root, `${state.taskId}-${lane}`);
    const receiptPath = prefix + '-receipt.json', artifactPath = prefix + '.md';
    const validationPath = prefix + '-findings-validation.json', dispositionPath = prefix + '-findings-disposition.json';
    const receipt = readJson(receiptPath), context = readJson(prefix + '-review-context.json');
    const baseline = buildReviewRemediationBaselineArtifact({ taskId: state.taskId, reviewType: lane,
        reviewArtifactPath: artifactPath, reviewArtifactSha256: fixture.fileSha256(artifactPath)!,
        receiptPath, receiptSha256: fixture.fileSha256(receiptPath)!, receipt,
        validationArtifactPath: validationPath, validationArtifactSha256: fixture.fileSha256(validationPath)!,
        validationArtifact: readJson(validationPath) as ReviewFindingsValidationArtifact,
        dispositionArtifactPath: dispositionPath, dispositionArtifactSha256: fixture.fileSha256(dispositionPath)!,
        dispositionArtifact: readJson(dispositionPath) as ReviewFindingsDispositionArtifact,
        profilePolicySnapshot: readJson(state.preflightPath).profile_policy_snapshot,
        originCoverageContract: context.coverage_contract as ReviewCoverageContract,
        deltaBase: buildReviewRemediationDeltaBase({ repoRoot: state.repoRoot, taskId: state.taskId,
            reviewType: lane, reviewTreeStateSha256: receipt.review_tree_state_sha256, changedFiles: state.files })
    });
    const mutable = prefix + '-remediation-baseline.json';
    fs.writeFileSync(mutable, JSON.stringify(baseline, null, 2) + '\n');
    const retained = prefix + '-remediation-baseline-' + fixture.fileSha256(mutable) + '.json';
    fs.copyFileSync(mutable, retained);
    fs.copyFileSync(prefix + '-review-context.json', prefix + '-review-context-' + fixture.fileSha256(prefix + '-review-context.json') + '.json');
    assert.equal(validateReviewRemediationBaselineArtifact({ artifactPath: retained, expectedTaskId: state.taskId,
        expectedReviewType: lane, expectedArtifactSha256: fixture.fileSha256(retained) }).valid, true);
    state.historicalArtifacts.push(baseline.bindings.receipt.snapshot_path, baseline.bindings.review_artifact.snapshot_path,
        baseline.bindings.findings_validation.snapshot_path, baseline.bindings.findings_disposition.snapshot_path, retained);
    return retained;
}

function appendRestart(state: AuthenticatedHistoryFixture, cycle: number, expectDelta: boolean): void {
    const classified = state.lanes.length === 3 ? classifyHistoryRemediation(state, state.testBaselinePath!, expectDelta) : null;
    const classification = classified?.classification || { source: 'runtime_fix' as const, classification: { category: 'production',
        reason: `Retained full-review remediation cycle ${cycle}.`, blocked_before_reuse: false,
        invalidated_review_types: state.lanes } };
    const decision = bindAuthoritativeRemediationDecisionToPreflight(resolveAuthoritativeReviewRemediationDecision({
        taskId: state.taskId, currentReviewType: classified ? 'test' : state.lanes[0], classification,
        modePolicyValidationInputs: classified?.inputs,
        requiredReviews: Object.fromEntries(state.lanes.map(lane => [lane, true])), reviewExecutionPolicyMode: 'strict_sequential'
    }), fixture.fileSha256(state.preflightPath)!);
    assert.equal(decision.status, 'READY', JSON.stringify(decision));
    if (expectDelta && classified) {
        state.testExecution = buildAuthenticatedRemediationReviewExecution({ taskId: state.taskId, reviewType: 'test',
            preflightSha256: fixture.fileSha256(state.preflightPath)!, fullReviewScope: state.files,
            authoritativeDecision: decision, authoritativeClassification: classification });
        assert.equal(state.testExecution.contract.mode, 'DELTA');
        assert.equal(path.resolve(state.testExecution.contract.base!.baseline_artifact_path), path.resolve(state.testBaselinePath!));
        assert.deepEqual(state.testExecution.contract.delta!.required_delta_targets, [state.files[1]]);
    }
    const root = fixture.getReviewsRoot(state.repoRoot);
    appendRestartCompletedEvidence({ repoRoot: state.repoRoot, taskId: state.taskId, eventType: 'REVIEW_CYCLE_RESTARTED',
        artifactSuffix: '-review-cycle-restart.json', message: 'Historical review cycle closed by authenticated restart.',
        taskModePath: path.join(root, state.taskId + '-task-mode.json'), preflightPath: state.preflightPath,
        compileEvidencePath: path.join(root, state.taskId + '-compile-gate.json'), detectionSource: 'explicit',
        plannedChangedFilesCount: state.files.length, detectedChangedFilesCount: state.files.length, elapsedMs: 1,
        restartReason: 'coherent_cycle_restart_after_downstream_boundary_or_invalid_preflight_order',
        nextStepSummary: 'Continue with current review evidence.', extraDetails: {
            invalidated_review_types: decision.invalidated_review_types,
            authoritative_review_decision: decision, authoritative_review_classification: classification } });
}

/** Native validation plus real content-addressed receipts consumed by audit history. */
export async function createAuthenticatedNextStepHistoryFixture(cycles = 16, laneCount = 3, onActive?: (state: AuthenticatedHistoryFixture) => void): Promise<AuthenticatedHistoryFixture> {
    assert.ok(Number.isInteger(cycles) && cycles > 0);
    assert.ok([1, 3, 5].includes(laneCount));
    const repoRoot = fixture.createTempRepo(), taskId = 'T-BENCH-NATIVE';
    const selectedLanes = ['code', 'refactor', 'test', 'performance', 'security'].slice(0, laneCount);
    const lanes = getReviewExecutionPreparationOrder('strict_sequential').filter(lane => selectedLanes.includes(lane));
    const files = ['src/evidence.ts', ...Array.from({ length: 63 }, (_, index) => `tests/benchmark-${index}.test.ts`)];
    fixture.seedRemediationRepoBase(repoRoot);
    fixture.writeCurrentReviewCycleValidationSource(repoRoot);
    fixture.writeReviewCapabilitiesConfig(repoRoot);
    const profilesPath = fixture.writeProfilesConfig(repoRoot), profiles = readJson(profilesPath);
    profiles.built_in_profiles.balanced.review_policy = Object.fromEntries(
        ['code', 'security', 'test', 'refactor', 'performance', 'api', 'db', 'infra', 'dependency']
            .map(lane => [lane, lanes.includes(lane)]));
    profiles.built_in_profiles.balanced.review_remediation_mode_policy = buildDefaultReviewRemediationModePolicy();
    fs.writeFileSync(profilesPath, JSON.stringify(profiles));
    const pathsPath = path.join(fixture.getOrchestratorRoot(repoRoot), 'live/config/paths.json');
    const paths = readJson(pathsPath); paths.triggers.security = ['(^|/)security/'];
    fs.writeFileSync(pathsPath, JSON.stringify(paths));
    const workflowPath = fixture.writeWorkflowConfig(repoRoot, 'strict_sequential');
    const workflow = readJson(workflowPath);
    // Fixed finite policy for every history size: the guard still evaluates all
    // evidence; the workload must reach ordinary routes even with 16 x 5 attempts.
    workflow.review_cycle_guard = { ...DEFAULT_REVIEW_CYCLE_GUARD_CONFIG, max_total_non_test_reviews: 128,
        max_failed_non_test_reviews: 128 };
    fs.writeFileSync(workflowPath, JSON.stringify(workflow));
    for (const file of files) {
        fs.mkdirSync(path.dirname(path.join(repoRoot, file)), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, file), file === 'src/evidence.ts' ? 'export const value = 1;\n' : 'assert.equal(actual, 0);\n');
    }
    fixture.initializeGitRepo(repoRoot);
    for (const file of files) fs.writeFileSync(path.join(repoRoot, file), file === 'src/evidence.ts' ? 'export const value = 2;\n' : 'assert.equal(actual, expected);\n');
    fixture.seedTaskQueue(repoRoot, taskId, 'TODO', 'balanced'); fixture.seedInitAnswers(repoRoot, 'Codex');
    const entered = fixture.runEnterTaskMode({ repoRoot, taskId, taskSummary: 'Measure authenticated review history', plannedChangedFiles: files });
    assert.equal(entered.exitCode, 0, entered.outputLines.join('\n'));
    fixture.loadTaskEntryRulePack(repoRoot, taskId); fixture.runHandshakeForTask(repoRoot, taskId); fixture.runShellSmokeForTask(repoRoot, taskId);
    const preflightPath = fixture.runExplicitPreflight(repoRoot, taskId, 'Measure authenticated review history', files);
    await fixture.prepareCurrentReviewCycleValidation(repoRoot, taskId, preflightPath);
    fixture.loadPostPreflightRulePack(repoRoot, taskId, preflightPath); fixture.writeCompilePassEvidence(repoRoot, taskId, preflightPath);
    const root = fixture.getReviewsRoot(repoRoot);
    const state: AuthenticatedHistoryFixture = { repoRoot, taskId, preflightPath, files, lanes, timelineBytes: 0,
        historicalArtifacts: [], artifactCycles: {}, correctionProofs: [], correctionPackages: {}, baselinePath: '', contextPath: path.join(root, `${taskId}-code-review-context.json`) };
    for (let cycle = 0; cycle < cycles; cycle += 1) {
        fixture.writeReceiptBackedReviewArtifact(repoRoot, taskId, 'code', verdict('code', true), undefined,
            { authenticatedNavigatorLaunch: true, skipReceipt: true,
                caseResolutions: fixture.buildCurrentReviewCycleCaseResolutions(repoRoot, taskId) });
        await retainHistoryCorrectionAttempt(state, cycle);
        for (const lane of lanes) {
            fixture.writeReceiptBackedReviewArtifact(repoRoot, taskId, lane, verdict(lane, false), undefined,
                { authenticatedNavigatorLaunch: true, findingSeverity: 'high', findingEvidenceFile: lane === 'test' ? files[1] : undefined, caseResolutions: fixture.buildCurrentReviewCycleCaseResolutions(repoRoot, taskId) });
            state.baselinePath = retainBaseline(state, lane);
            if (lane === 'test') state.testBaselinePath = state.baselinePath;
        }
        // Direct fixture writes must finish the same index-owner boundary as native writers.
        // Retaining a baseline may rewrite an existing snapshot with identical bytes but a
        // new file identity; a previously built index must not retain its old metadata.
        prepareClosedReviewCurrentIndex(repoRoot);
        const expectDelta = state.lanes.length === 3 && cycle === cycles - 1;
        if (state.lanes.length === 3) {
            for (const file of files.slice(1, expectDelta ? 2 : 6))
                fs.writeFileSync(path.join(repoRoot, file), 'assert.equal(actual, ' + (100 + cycle) + ');\n');
        }
        fixture.runHandshakeForTask(repoRoot, taskId); fixture.runShellSmokeForTask(repoRoot, taskId);
        state.preflightPath = fixture.runExplicitPreflight(repoRoot, taskId, 'Measure authenticated review history', files);
        await fixture.prepareCurrentReviewCycleValidation(repoRoot, taskId, state.preflightPath);
        fixture.loadPostPreflightRulePack(repoRoot, taskId, state.preflightPath);
        fixture.appendTaskEvent(fixture.getOrchestratorRoot(repoRoot), taskId, 'IMPLEMENTATION_STARTED', 'INFO',
            'Fixture remediation implementation entered after refreshed preflight.', { preflight_path: state.preflightPath,
                preflight_sha256: fixture.fileSha256(state.preflightPath) });
        fixture.writeCompilePassEvidence(repoRoot, taskId, state.preflightPath);
        appendRestart(state, cycle, expectDelta);
        for (const file of fs.readdirSync(fixture.getReviewsRoot(repoRoot))) {
            if (/-[a-f0-9]{64}\.(?:json|md)$/u.test(file)) {
                const absolute = path.resolve(fixture.getReviewsRoot(repoRoot), file);
                state.artifactCycles[absolute] ??= cycle;
            }
        }
    }
    for (const lane of lanes) fixture.writeReceiptBackedReviewArtifact(repoRoot, taskId, lane, verdict(lane, true), undefined,
        { authenticatedNavigatorLaunch: true,
            reviewExecutionContract: lane === 'test' ? state.testExecution?.contract : undefined,
            reviewExecutionValidationAuthority: lane === 'test' ? state.testExecution?.validationAuthority : undefined,
            beforeReceipt: lane === lanes[0] ? () => onActive?.(state) : undefined,
            caseResolutions: fixture.buildCurrentReviewCycleCaseResolutions(repoRoot, taskId) });
    const timeline = path.join(fixture.getOrchestratorRoot(repoRoot), 'runtime/task-events', taskId + '.jsonl');
    // The seed helper emits fully bound native review evidence directly. Run the same
    // authenticating producer after those completed writes; never fabricate a derived record.
    prepareClosedReviewCurrentIndex(repoRoot);
    const query = readTaskTimelineClosedReviewQuery(timeline, taskId);
    assert.equal(query?.query.sourceEventType, 'REVIEW_RECORDED');
    publishClosedReviewHistory(captureClosedReviewGate({ repoRoot, taskId, kind: 'record',
        sourceEventSha256: query!.query.source.sha256 }));
    prepareClosedReviewCurrentIndex(repoRoot);
    state.timelineBytes = fs.statSync(timeline).size;
    return state;
}

export async function completeAuthenticatedHistoryFixture(state: AuthenticatedHistoryFixture): Promise<void> {
    const review = fixture.runRequiredReviewsCheckCommand({ ...state,
        codeReviewVerdict: 'REVIEW PASSED', securityReviewVerdict: 'SECURITY REVIEW PASSED',
        testReviewVerdict: 'TEST REVIEW PASSED', refactorReviewVerdict: 'REFACTOR REVIEW PASSED',
        performanceReviewVerdict: 'PERFORMANCE REVIEW PASSED',
        reviewAuthorshipAttestationJson: JSON.stringify(Object.fromEntries(state.lanes.map(lane => [lane, true]))),
        emitMetrics: false });
    assert.equal(review.exitCode, 0, review.outputLines.join('\n'));
    const doc = runDocImpactGateCommand({ ...state, decision: 'NO_DOC_UPDATES', behaviorChanged: false,
        changelogUpdated: false, sensitiveScopeReviewed: true,
        rationale: 'Temporary fixture changes only a local test value and assertions; it has no deployed interface or documentation contract.', emitMetrics: false });
    assert.equal(doc.exitCode, 0, doc.outputLines.join('\n'));
    const memory = runProjectMemoryImpactCommand(state);
    assert.equal(memory.exitCode, 0, memory.outputLines.join('\n'));
    const previousExitCode = process.exitCode;
    try {
        process.exitCode = 0;
        await handleCompletionGate(['--repo-root', state.repoRoot, '--task-id', state.taskId, '--preflight-path', state.preflightPath]);
        assert.equal(process.exitCode, 0, 'The real completion handler must accept and materialize the fixture.');
    } finally { process.exitCode = previousExitCode; }
    assert.ok(fs.existsSync(path.join(fixture.getReviewsRoot(state.repoRoot), state.taskId + '-final-closeout.json')));
}
