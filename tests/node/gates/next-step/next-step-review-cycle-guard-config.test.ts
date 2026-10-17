import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadFullSuiteValidationConfig } from '../../../../src/core/full-suite-validation-config';
import * as fx from './next-step-review-cycle-fixtures';

const {
    ALL_REVIEW_FLAGS,
    appendEvent,
    buildReviewContextScopeFixture,
    eventsRoot,
    resolveNextStep,
    EXPECTED_LOOP_LINE,
    fileSha256,
    fs,
    getLoadedRuleFileBasenames,
    hasCompletedDecomposedParentAfterSplitRequiredClear,
    hasSplitRequiredClearedEvidence,
    launchInputEvidenceFixture,
    makeTempRepo,
    markReviewEvidenceAsStrictReuse,
    materializeFinalCloseout,
    NEXT_STEP_FULL_SUITE_TEST_CONFIG,
    normalizeForTimeline,
    os,
    path,
    PROVIDER_ENV_KEYS,
    readReviewContextTreeStateSha256,
    readSplitRequiredLatchEvidence,
    requireFromTest,
    resolveReviewCycleContinuationArtifactPath,
    resolveSplitRequiredArtifactPath,
    reviewsRoot,
    runRecordReviewCycleSplitDecisionCommand,
    seedCompilePass,
    seedCompletedReviewerLaunchAndInvocation,
    seedCompletedTaskWithIndependentCodeReview,
    seedCompletionPass,
    seedCustomStartedTask,
    seedDocImpactPass,
    seedFullSuiteValidation,
    seedGitAutoCompilePass,
    seedHandshake,
    seedPostPreflightRulePack,
    seedProjectMemory,
    seedProjectMemoryImpact,
    seedReviewGatePass,
    seedRulePack,
    seedShellSmoke,
    seedSourceCheckoutRuntime,
    seedSplitRequiredLatchEvidence,
    seedStartedTask,
    seedTaskModeOnly,
    sha256Text,
    TASK_ID,
    tempRoots,
    withProviderEnv,
    writeFreshReviewContextWithoutRouting,
    writeGitAutoPreflight,
    writeJson,
    writeJsonWithSha,
    writeNoOpEvidence,
    writePreflight,
    writeProjectMemoryWorkflowConfig,
    writeReviewContextOnly,
    writeReviewCycleContinuation,
    writeReviewEvidence,
    writeStrictDecompositionDecision,
    writeStrictIndependentCodeReviewEvidence
} = fx;
void [ALL_REVIEW_FLAGS, appendEvent, buildReviewContextScopeFixture, eventsRoot, resolveNextStep, EXPECTED_LOOP_LINE, fileSha256, fs, getLoadedRuleFileBasenames, hasCompletedDecomposedParentAfterSplitRequiredClear, hasSplitRequiredClearedEvidence, launchInputEvidenceFixture, makeTempRepo, markReviewEvidenceAsStrictReuse, materializeFinalCloseout, NEXT_STEP_FULL_SUITE_TEST_CONFIG, normalizeForTimeline, os, path, PROVIDER_ENV_KEYS, readReviewContextTreeStateSha256, readSplitRequiredLatchEvidence, requireFromTest, resolveReviewCycleContinuationArtifactPath, resolveSplitRequiredArtifactPath, reviewsRoot, runRecordReviewCycleSplitDecisionCommand, seedCompilePass, seedCompletedReviewerLaunchAndInvocation, seedCompletedTaskWithIndependentCodeReview, seedCompletionPass, seedCustomStartedTask, seedDocImpactPass, seedFullSuiteValidation, seedGitAutoCompilePass, seedHandshake, seedPostPreflightRulePack, seedProjectMemory, seedProjectMemoryImpact, seedReviewGatePass, seedRulePack, seedShellSmoke, seedSourceCheckoutRuntime, seedSplitRequiredLatchEvidence, seedStartedTask, seedTaskModeOnly, sha256Text, TASK_ID, tempRoots, withProviderEnv, writeFreshReviewContextWithoutRouting, writeGitAutoPreflight, writeJson, writeJsonWithSha, writeNoOpEvidence, writePreflight, writeProjectMemoryWorkflowConfig, writeReviewContextOnly, writeReviewCycleContinuation, writeReviewEvidence, writeStrictDecompositionDecision, writeStrictIndependentCodeReviewEvidence];

describe('gates/next-step review cycle guard config', () => {
    it('blocks next-step when scope budget workflow config is invalid', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(
            path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json'),
            JSON.stringify({
                full_suite_validation: {
                    enabled: false,
                    command: 'npm test',
                    timeout_ms: 600000,
                    green_summary_max_lines: 5,
                    red_failure_chunk_lines: 50,
                    out_of_scope_failure_policy: 'AUDIT_AND_BLOCK'
                },
                review_execution_policy: {
                    mode: 'code_first_optional'
                },
                scope_budget_guard: {
                    enabled: true,
                    profiles: ['strict'],
                    action: 'BLOCK_SOMEHOW',
                    max_files: 12,
                    max_changed_lines: 1200,
                    max_required_reviews: 6,
                    max_review_tokens: 20000
                }
            }, null, 2),
            'utf8'
        );
        seedStartedTask(repoRoot, TASK_ID);
        const preflightPath = writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'workflow-config-validation');
        assert.ok(result.reason.includes('workflow-config.scope_budget_guard.action'));
        assert.ok(result.commands[0].command.includes('workflow validate'));
        assert.equal(result.full_suite_validation.config_source, 'effective_workflow_config');
        assert.equal(result.full_suite_validation.command, 'npm test');
        assert.equal(preflightPath.endsWith(`${TASK_ID}-preflight.json`), true);
    });

    it('blocks next-step when present workflow config is not an object', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        fs.writeFileSync(
            path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json'),
            JSON.stringify(['not-a-workflow-config'], null, 2),
            'utf8'
        );

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'workflow-config-validation');
        assert.ok(result.reason.includes('must be a JSON object'));
        assert.ok(result.commands[0].command.includes('workflow validate'));
        assert.equal(result.status, 'BLOCKED');
        assert.equal(result.audit_status, 'INCOMPLETE');
        assert.equal(result.full_suite_validation.config_source, 'unavailable_workflow_config');
        assert.equal(result.full_suite_validation.enabled, null);
        assert.equal(result.full_suite_validation.command, null);
        assert.equal(result.full_suite_validation.placement, null);
        assert.equal(result.full_suite_validation.config_path, null);
        assert.deepEqual(result.review.launchable_review_types, []);
        assert.match(fx.formatNextStepText(result), /FullSuite: unavailable/);
        assert.throws(() => loadFullSuiteValidationConfig(repoRoot), /must be a JSON object/);
        assert.deepEqual(JSON.parse(fs.readFileSync(path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json'), 'utf8')), ['not-a-workflow-config']);
    });

    it('blocks next-step when present workflow config contains invalid JSON', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        const configPath = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json');
        const original = '{"full_suite_validation":';
        fs.writeFileSync(configPath, original, 'utf8');

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.status, 'BLOCKED');
        assert.equal(result.next_gate, 'workflow-config-validation');
        assert.match(result.reason, /not valid JSON/);
        assert.equal(result.commands.length, 1);
        assert.match(result.commands[0].command, /workflow validate/);
        assert.equal(result.audit_status, 'INCOMPLETE');
        assert.equal(result.full_suite_validation.config_source, 'unavailable_workflow_config');
        assert.equal(result.full_suite_validation.enabled, null);
        assert.equal(result.full_suite_validation.command, null);
        assert.deepEqual(result.review.launchable_review_types, []);
        assert.match(fx.formatNextStepText(result), /FullSuite: unavailable/);
        assert.throws(() => loadFullSuiteValidationConfig(repoRoot), /invalid JSON/);
        assert.equal(fs.readFileSync(configPath, 'utf8'), original);
    });

    it('keeps legacy next-step defaults when workflow config is missing unrelated sections', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(
            path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json'),
            JSON.stringify({
                review_execution_policy: {
                    mode: 'code_first_optional'
                },
                scope_budget_guard: {
                    enabled: true,
                    profiles: ['strict'],
                    action: 'BLOCK_FOR_SPLIT',
                    max_files: 12,
                    max_changed_lines: 1200,
                    max_required_reviews: 6,
                    max_review_tokens: 20000
                }
            }, null, 2),
            'utf8'
        );
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.notEqual(result.next_gate, 'workflow-config-validation');
        assert.ok(!result.reason.includes('workflow-config.full_suite_validation'));
    });

    it('does not scan review cycle timeline when the guard is disabled', () => {
        const repoRoot = makeTempRepo();
        writeJson(
            path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json'),
            {
                full_suite_validation: {
                    enabled: false,
                    command: 'npm test',
                    timeout_ms: 600000,
                    green_summary_max_lines: 5,
                    red_failure_chunk_lines: 50,
                    out_of_scope_failure_policy: 'AUDIT_AND_BLOCK'
                },
                review_execution_policy: {
                    mode: 'code_first_optional'
                },
                review_cycle_guard: {
                    enabled: false,
                    action: 'BLOCK_FOR_OPERATOR_DECISION',
                    max_failed_non_test_reviews: 1,
                    max_total_non_test_reviews: 1,
                    excluded_review_types: ['test']
                }
            }
        );
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        appendEvent(repoRoot, TASK_ID, 'REVIEWER_INVOCATION_ATTESTED', 'INFO', {
            reviewer_identity: 'agent:missing-review-type',
            review_context_sha256: sha256Text('missing-review-type')
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'compile-gate');
    });

});
