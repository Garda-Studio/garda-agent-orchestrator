import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it } from 'node:test';

import { sha256RedactedJsonPayload } from '../../../../src/core/redaction';
import { buildDefaultWorkflowConfig } from '../../../../src/core/workflow-config';
import { runBuildReviewContextCommand } from '../../../../src/cli/commands/gate-build-handlers';
import { appendTaskEvent } from '../../../../src/gate-runtime/task-events';
import { runCompletionGate } from '../../../../src/gates/completion';
import { materializeReviewFindingsFollowUpTasks } from '../../../../src/gates/review/review-findings-follow-up-tasks';
import { validateReviewFindingsDispositionEvidence } from '../../../../src/gates/review/review-findings-disposition-evidence';
import { resolveLockedReviewFindingPolicyFromPreflight } from '../../../../src/gates/review/review-finding-disposition';
import {
    createTempRepo,
    getOrchestratorRoot,
    getReviewsRoot,
    loadPostPreflightRulePack,
    loadTaskEntryRulePack,
    runEnterTaskMode,
    runHandshakeForTask,
    runShellSmokeForTask,
    seedReusableReviewEvidence,
    seedInitAnswers,
    seedTaskQueue,
    writeCompilePassEvidence,
    writePreflight,
    writeReceiptBackedReviewArtifact
} from '../../cli/commands/gate-test-helpers';

function sha256Text(value: string): string {
    return createHash('sha256').update(value).digest('hex');
}

function writeJson(filePath: string, payload: unknown): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function writeCompletionWorkflowConfig(repoRoot: string): void {
    const config = buildDefaultWorkflowConfig();
    config.full_suite_validation.enabled = false;
    config.project_memory_maintenance.enabled = false;
    config.project_memory_maintenance.mode = 'check';
    config.project_memory_maintenance.run_before_final_closeout = true;
    writeJson(path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json'), config);
}

function writePassedReviewGate(repoRoot: string, taskId: string, preflightPath: string): void {
    const preflightSha256 = sha256Text(fs.readFileSync(preflightPath, 'utf8'));
    writeJson(path.join(getReviewsRoot(repoRoot), `${taskId}-review-gate.json`), {
        task_id: taskId,
        status: 'PASSED',
        outcome: 'PASS',
        preflight_hash_sha256: preflightSha256,
        required_reviews: { code: true },
        verdicts: { code: 'REVIEW PASSED' },
        review_checks: {
            code: {
                required: true,
                skipped_by_override: false,
                verdict: 'REVIEW PASSED',
                pass_token: 'REVIEW PASSED',
                receipt_valid: true,
                reviewer_execution_mode: 'delegated_subagent',
                reviewer_identity: 'agent:code-reviewer',
                reviewer_fallback_reason: null,
                trust_level: 'INDEPENDENT_AUDITED'
            }
        }
    });
    appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'REVIEW_GATE_PASSED', 'PASS', 'Review gate passed.', {
        preflight_hash_sha256: preflightSha256,
        required_reviews: { code: true }
    });
}

function writeNoDocImpact(repoRoot: string, taskId: string): void {
    writeJson(path.join(getReviewsRoot(repoRoot), `${taskId}-doc-impact.json`), {
        task_id: taskId,
        status: 'PASSED',
        outcome: 'PASS',
        decision: 'NO_DOC_UPDATES',
        rationale: 'Focused completion findings-disposition regression.'
    });
    appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'DOC_IMPACT_ASSESSED', 'PASS', 'Doc impact assessed.', {
        decision: 'NO_DOC_UPDATES'
    });
}

function seedCompletionFixture(options: {
    taskId: string;
    findingSeverity?: 'high' | 'low' | null;
}): { repoRoot: string; preflightPath: string; reviewsRoot: string } {
    const repoRoot = createTempRepo();
    seedTaskQueue(repoRoot, options.taskId, 'IN_PROGRESS');
    seedInitAnswers(repoRoot, 'Codex');
    writeCompletionWorkflowConfig(repoRoot);
    const preflightPath = writePreflight(repoRoot, options.taskId, {
        scope_category: 'code',
        required_reviews: {
            code: true,
            db: false,
            security: false,
            refactor: false,
            api: false,
            test: false,
            performance: false,
            infra: false,
            dependency: false
        },
        profile_selection: {
            task_profile: 'balanced',
            effective_profile: 'balanced'
        }
    });
    runEnterTaskMode({
        repoRoot,
        taskId: options.taskId,
        taskSummary: 'Consume validated findings dispositions during completion',
        provider: 'Codex',
        routedTo: 'AGENTS.md'
    });
    assert.equal(loadTaskEntryRulePack(repoRoot, options.taskId).exitCode, 0);
    runHandshakeForTask(repoRoot, options.taskId);
    runShellSmokeForTask(repoRoot, options.taskId);
    assert.equal(loadPostPreflightRulePack(repoRoot, options.taskId, preflightPath).exitCode, 0);
    appendTaskEvent(getOrchestratorRoot(repoRoot), options.taskId, 'IMPLEMENTATION_STARTED', 'INFO', 'Implementation started.', {
        preflight_path: preflightPath.replace(/\\/g, '/')
    });
    writeCompilePassEvidence(repoRoot, options.taskId, preflightPath);
    writeReceiptBackedReviewArtifact(
        repoRoot,
        options.taskId,
        'code',
        'REVIEW PASSED',
        undefined,
        { findingSeverity: options.findingSeverity }
    );
    writePassedReviewGate(repoRoot, options.taskId, preflightPath);
    writeNoDocImpact(repoRoot, options.taskId);
    return { repoRoot, preflightPath, reviewsRoot: getReviewsRoot(repoRoot) };
}

async function seedReusableCompletionFixture(taskId: string): Promise<{
    repoRoot: string;
    preflightPath: string;
    reviewsRoot: string;
}> {
    const repoRoot = createTempRepo();
    seedTaskQueue(repoRoot, taskId, 'IN_PROGRESS');
    seedInitAnswers(repoRoot, 'Codex');
    writeCompletionWorkflowConfig(repoRoot);
    runEnterTaskMode({
        repoRoot,
        taskId,
        taskSummary: 'Consume reusable findings dispositions during completion',
        provider: 'Codex',
        routedTo: 'AGENTS.md'
    });
    assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
    runHandshakeForTask(repoRoot, taskId);
    runShellSmokeForTask(repoRoot, taskId);

    const reviewsRoot = getReviewsRoot(repoRoot);
    const priorPreflightPath = writePreflight(repoRoot, taskId, {}, `${taskId}-prior-preflight.json`);
    const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
    seedReusableReviewEvidence(
        repoRoot,
        taskId,
        'code',
        'REVIEW PASSED',
        priorPreflightPath,
        reviewContextPath,
        'agent:code-reviewer'
    );

    const preflightPath = writePreflight(repoRoot, taskId);
    assert.equal(loadPostPreflightRulePack(repoRoot, taskId, preflightPath).exitCode, 0);
    appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'IMPLEMENTATION_STARTED', 'INFO', 'Implementation started.', {
        preflight_path: preflightPath.replace(/\\/g, '/')
    });
    writeCompilePassEvidence(repoRoot, taskId, preflightPath);
    const reuseResult = await runBuildReviewContextCommand({
        reviewType: 'code',
        depth: 2,
        preflightPath,
        outputPath: reviewContextPath,
        repoRoot
    });
    assert.equal(reuseResult.reusedReviewEvidence, true, reuseResult.outputLines.join('\n'));
    writePassedReviewGate(repoRoot, taskId, preflightPath);
    writeNoDocImpact(repoRoot, taskId);
    return { repoRoot, preflightPath, reviewsRoot };
}

function rewriteValidationBindings(options: {
    reviewsRoot: string;
    taskId: string;
    mutate: (validationResult: Record<string, unknown>) => void;
}): void {
    const artifactPath = path.join(options.reviewsRoot, `${options.taskId}-code-findings-validation.json`);
    const receiptPath = path.join(options.reviewsRoot, `${options.taskId}-code-receipt.json`);
    const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8')) as Record<string, unknown>;
    const validationResult = artifact.validation_result as Record<string, unknown>;
    options.mutate(validationResult);
    artifact.validation_result_sha256 = sha256RedactedJsonPayload(validationResult);
    const artifactText = `${JSON.stringify(artifact, null, 2)}\n`;
    const artifactSha256 = sha256Text(artifactText);
    fs.writeFileSync(artifactPath, artifactText, 'utf8');
    const snapshotPath = artifactPath.replace(/\.json$/u, `-${artifactSha256}.json`);
    fs.writeFileSync(snapshotPath, artifactText, 'utf8');

    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as Record<string, unknown>;
    const reference = receipt.review_findings_validation as Record<string, unknown>;
    reference.artifact_sha256 = artifactSha256;
    reference.snapshot_path = snapshotPath.replace(/\\/g, '/');
    reference.snapshot_sha256 = artifactSha256;
    reference.validation_result_sha256 = artifact.validation_result_sha256;
    reference.status = validationResult.status;
    reference.accepted = validationResult.accepted;
    reference.violation_count = Array.isArray(validationResult.violations) ? validationResult.violations.length : 0;
    const outputContract = receipt.review_output_contract as Record<string, unknown>;
    outputContract.validation_artifact_sha256 = artifactSha256;
    outputContract.validation_result_sha256 = artifact.validation_result_sha256;
    writeJson(receiptPath, receipt);
}

describe('gates/completion — findings disposition evidence', () => {
    it('accepts intact validated findings and disposition evidence', () => {
        const fixture = seedCompletionFixture({ taskId: 'T-979-30-valid-findings-disposition' });
        try {
            const result = runCompletionGate({
                repoRoot: fixture.repoRoot,
                preflightPath: fixture.preflightPath,
                taskId: 'T-979-30-valid-findings-disposition'
            });
            assert.equal(result.status, 'PASSED', JSON.stringify(result.violations, null, 2));
        } finally {
            fs.rmSync(fixture.repoRoot, { recursive: true, force: true });
        }
    });

    it('accepts reusable disposition evidence from its hash-bound snapshot', async () => {
        const taskId = 'T-979-30-reused-findings-disposition';
        const fixture = await seedReusableCompletionFixture(taskId);
        try {
            const receiptPath = path.join(fixture.reviewsRoot, `${taskId}-code-receipt.json`);
            const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as Record<string, unknown>;
            assert.equal(receipt.reused_existing_review, true);
            const dispositionReference = receipt.review_findings_disposition_artifact as Record<string, unknown>;
            const dispositionArtifactPath = String(dispositionReference.artifact_path);
            const dispositionSnapshotPath = String(dispositionReference.snapshot_path);
            assert.equal(fs.existsSync(dispositionSnapshotPath), true);
            fs.rmSync(dispositionArtifactPath);

            const result = runCompletionGate({ repoRoot: fixture.repoRoot, preflightPath: fixture.preflightPath, taskId });
            assert.equal(result.status, 'PASSED', JSON.stringify(result.violations, null, 2));
        } finally {
            fs.rmSync(fixture.repoRoot, { recursive: true, force: true });
        }
    });

    it('rejects missing disposition evidence after the review gate passed', () => {
        const taskId = 'T-979-30-missing-findings-disposition';
        const fixture = seedCompletionFixture({ taskId });
        try {
            fs.rmSync(path.join(fixture.reviewsRoot, `${taskId}-code-findings-disposition.json`));
            const result = runCompletionGate({ repoRoot: fixture.repoRoot, preflightPath: fixture.preflightPath, taskId });
            assert.equal(result.status, 'FAILED');
            assert.ok(
                result.violations.some((violation: string) => (
                    violation.includes('Review findings disposition artifact') && violation.includes('is missing')
                )),
                result.violations.join('\n')
            );
        } finally {
            fs.rmSync(fixture.repoRoot, { recursive: true, force: true });
        }
    });

    it('rejects a hash-consistent validation artifact whose result is rejected', () => {
        const taskId = 'T-979-30-rejected-findings-validation';
        const fixture = seedCompletionFixture({ taskId });
        try {
            rewriteValidationBindings({
                reviewsRoot: fixture.reviewsRoot,
                taskId,
                mutate: (validationResult) => {
                    validationResult.status = 'rejected';
                    validationResult.accepted = false;
                    validationResult.violations = ['Fixture validation rejection.'];
                }
            });
            const result = runCompletionGate({ repoRoot: fixture.repoRoot, preflightPath: fixture.preflightPath, taskId });
            assert.equal(result.status, 'FAILED');
            assert.ok(
                result.violations.some((violation: string) => (
                    violation.includes('is rejected') && violation.includes('Fixture validation rejection')
                )),
                result.violations.join('\n')
            );
        } finally {
            fs.rmSync(fixture.repoRoot, { recursive: true, force: true });
        }
    });

    it('rejects unsatisfied fix_now dispositions', () => {
        const taskId = 'T-979-30-unsatisfied-fix-now';
        const fixture = seedCompletionFixture({ taskId, findingSeverity: 'high' });
        try {
            const result = runCompletionGate({ repoRoot: fixture.repoRoot, preflightPath: fixture.preflightPath, taskId });
            assert.equal(result.status, 'FAILED');
            assert.ok(
                result.violations.some((violation: string) => violation.includes('contains 1 unsatisfied fix_now finding')),
                result.violations.join('\n')
            );
        } finally {
            fs.rmSync(fixture.repoRoot, { recursive: true, force: true });
        }
    });

    it('blocks missing follow-ups and passes after materialization', () => {
        const taskId = 'T-979-30-pending-follow-up';
        const fixture = seedCompletionFixture({ taskId, findingSeverity: 'low' });
        try {
            const blocked = runCompletionGate({ repoRoot: fixture.repoRoot, preflightPath: fixture.preflightPath, taskId });
            assert.equal(blocked.status, 'FAILED');
            assert.ok(
                blocked.violations.some((violation: string) => (
                    violation.includes('Review findings follow-up artifact') && violation.includes('is missing')
                )),
                blocked.violations.join('\n')
            );

            const materialized = materializeReviewFindingsFollowUpTasks({
                repoRoot: fixture.repoRoot,
                taskId,
                reviewType: 'code'
            });
            assert.ok(
                materialized.status === 'MATERIALIZED' || materialized.status === 'ALREADY_MATERIALIZED',
                materialized.violations.join('\n')
            );
            const passed = runCompletionGate({ repoRoot: fixture.repoRoot, preflightPath: fixture.preflightPath, taskId });
            assert.equal(passed.status, 'PASSED', JSON.stringify(passed.violations, null, 2));
        } finally {
            fs.rmSync(fixture.repoRoot, { recursive: true, force: true });
        }
    });

    it('lets reuse defer grouped follow-up materialization but keeps closeout and per-finding mode strict', () => {
        const taskId = 'T-979-30-grouped-follow-up-reuse';
        const fixture = seedCompletionFixture({ taskId, findingSeverity: 'low' });
        try {
            const receiptPath = path.join(fixture.reviewsRoot, `${taskId}-code-receipt.json`);
            const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as Record<string, unknown>;
            const validationPath = path.join(fixture.reviewsRoot, `${taskId}-code-findings-validation.json`);
            const validationText = fs.readFileSync(validationPath, 'utf8');
            const check = (allowPendingGroupedFollowUp: boolean) => validateReviewFindingsDispositionEvidence({
                repoRoot: fixture.repoRoot,
                receipt,
                receiptPath,
                reviewArtifactPath: path.join(fixture.reviewsRoot, `${taskId}-code.md`),
                expectedTaskId: taskId,
                expectedReviewType: 'code',
                validationArtifact: JSON.parse(validationText),
                validationArtifactPath: validationPath.replace(/\\/gu, '/'),
                validationArtifactSha256: sha256Text(validationText),
                policyResolution: resolveLockedReviewFindingPolicyFromPreflight(JSON.parse(fs.readFileSync(fixture.preflightPath, 'utf8'))),
                allowPendingGroupedFollowUp
            });
            const missingFollowUp = (violations: string[]) => violations.some((violation) => (
                violation.includes('Review findings follow-up artifact') && violation.includes('is missing')));

            assert.ok(missingFollowUp(check(true).violations), 'per-finding mode keeps the materialization requirement');

            const preflight = JSON.parse(fs.readFileSync(fixture.preflightPath, 'utf8')) as Record<string, unknown>;
            preflight.profile_policy_snapshot = {
                ...(preflight.profile_policy_snapshot as Record<string, unknown> || {}),
                review_follow_up_policy: { schema_version: 1, materialization_mode: 'grouped_by_parent' }
            };
            writeJson(fixture.preflightPath, preflight);
            const deferred = check(true);
            assert.equal(missingFollowUp(deferred.violations), false, deferred.violations.join('\n'));
            assert.ok(missingFollowUp(check(false).violations), 'closeout callers still require the grouped artifact');
        } finally {
            fs.rmSync(fixture.repoRoot, { recursive: true, force: true });
        }
    });

    it('rejects stale scope and tree bindings with exact diagnostics', () => {
        const taskId = 'T-979-30-stale-findings-bindings';
        const fixture = seedCompletionFixture({ taskId });
        try {
            rewriteValidationBindings({
                reviewsRoot: fixture.reviewsRoot,
                taskId,
                mutate: (validationResult) => {
                    const bindings = validationResult.bindings as Record<string, Record<string, unknown>>;
                    bindings.scope.review_scope_sha256 = '0'.repeat(64);
                    bindings.tree.review_tree_state_sha256 = 'b'.repeat(64);
                }
            });
            const result = runCompletionGate({ repoRoot: fixture.repoRoot, preflightPath: fixture.preflightPath, taskId });
            assert.equal(result.status, 'FAILED');
            assert.ok(
                result.violations.some((violation: string) => violation.includes('review_scope_sha256 mismatch')),
                result.violations.join('\n')
            );
            assert.ok(
                result.violations.some((violation: string) => violation.includes('review_tree_state_sha256 mismatch')),
                result.violations.join('\n')
            );
        } finally {
            fs.rmSync(fixture.repoRoot, { recursive: true, force: true });
        }
    });
});
