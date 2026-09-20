import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Mode, OpenMode, PathLike } from 'node:fs';
import * as fx from './next-step-review-cycle-fixtures';
import {
    normalizeReviewCycleGuardConfig
} from '../../../../src/core/review-cycle-guard';
import {
    readReviewCycleGuardAttempts
} from '../../../../src/gates/next-step/next-step-review-cycle-guard-attempts';
import {
    buildReviewFindingsValidationArtifact,
    getReviewFindingsValidationArtifactPath,
    getReviewFindingsValidationArtifactSnapshotPath
} from '../../../../src/gates/review/review-findings-validation-artifact';
import {
    validateReviewFindingsContract
} from '../../../../src/gates/review/review-findings-artifact-verdict';
import { REVIEW_FINDINGS_SCHEMA_VERSION } from '../../../../src/gates/review/review-findings-schema';
import { resolveReviewContextExecutionEvidenceBindings } from '../../../../src/gates/review/review-evidence-contract';
import {
    buildReviewRemediationReviewContract
} from '../../../../src/gates/review-remediation/review-remediation-review-contract';

const {
    ALL_REVIEW_FLAGS,
    appendEvent,
    buildReviewContextScopeFixture,
    eventsRoot,
    resolveNextStep,
    formatNextStepText,
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
void [ALL_REVIEW_FLAGS, appendEvent, buildReviewContextScopeFixture, eventsRoot, resolveNextStep, formatNextStepText, EXPECTED_LOOP_LINE, fileSha256, fs, getLoadedRuleFileBasenames, hasCompletedDecomposedParentAfterSplitRequiredClear, hasSplitRequiredClearedEvidence, launchInputEvidenceFixture, makeTempRepo, markReviewEvidenceAsStrictReuse, materializeFinalCloseout, NEXT_STEP_FULL_SUITE_TEST_CONFIG, normalizeForTimeline, os, path, PROVIDER_ENV_KEYS, readReviewContextTreeStateSha256, readSplitRequiredLatchEvidence, requireFromTest, resolveReviewCycleContinuationArtifactPath, resolveSplitRequiredArtifactPath, reviewsRoot, runRecordReviewCycleSplitDecisionCommand, seedCompilePass, seedCompletedReviewerLaunchAndInvocation, seedCompletedTaskWithIndependentCodeReview, seedCompletionPass, seedCustomStartedTask, seedDocImpactPass, seedFullSuiteValidation, seedGitAutoCompilePass, seedHandshake, seedPostPreflightRulePack, seedProjectMemory, seedProjectMemoryImpact, seedReviewGatePass, seedRulePack, seedShellSmoke, seedSourceCheckoutRuntime, seedSplitRequiredLatchEvidence, seedStartedTask, seedTaskModeOnly, sha256Text, TASK_ID, tempRoots, withProviderEnv, writeFreshReviewContextWithoutRouting, writeGitAutoPreflight, writeJson, writeJsonWithSha, writeNoOpEvidence, writePreflight, writeProjectMemoryWorkflowConfig, writeReviewContextOnly, writeReviewCycleContinuation, writeReviewEvidence, writeStrictDecompositionDecision, writeStrictIndependentCodeReviewEvidence];

describe('gates/next-step review cycle guard attempts', () => {
    it('deduplicates reviewer/context attempts and preserves latest fresh failure summary', () => {
        const repoRoot = makeTempRepo();
        const reviewContextSha256 = sha256Text('deduped-context');
        appendEvent(repoRoot, TASK_ID, 'REVIEW_RECORDED', 'PASS', {
            review_type: 'security',
            reviewer_identity: 'agent:deduped-reviewer',
            review_context_sha256: reviewContextSha256
        });
        appendEvent(repoRoot, TASK_ID, 'REVIEW_RECORDED', 'FAIL', {
            review_type: 'security',
            reviewer_identity: 'agent:deduped-reviewer',
            review_context_sha256: reviewContextSha256,
            summary: 'security retry failed'
        });

        const result = readReviewCycleGuardAttempts(
            repoRoot,
            path.join(eventsRoot(repoRoot), `${TASK_ID}.jsonl`),
            TASK_ID,
            normalizeReviewCycleGuardConfig({
                enabled: true,
                action: 'BLOCK_FOR_OPERATOR_DECISION',
                max_failed_non_test_reviews: 1,
                max_total_non_test_reviews: 3,
                excluded_review_types: ['test'],
                auto_split_enabled: false
            }),
            null
        );

        assert.equal(result.timelineValid, true);
        assert.equal(result.attempts.length, 1);
        assert.equal(result.attempts[0]?.reviewType, 'security');
        assert.equal(result.attempts[0]?.failed, true);
        assert.equal(result.latestFailedReview?.review_type, 'security');
        assert.equal(result.latestFailedReview?.summary, 'security retry failed');
    });

    it('does not block closeout when successful non-test review attempts exceed the total limit', () => {
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
                    enabled: true,
                    action: 'BLOCK_FOR_OPERATOR_DECISION',
                    max_failed_non_test_reviews: 15,
                    max_total_non_test_reviews: 2,
                    excluded_review_types: ['test'],
                    auto_split_enabled: false
                }
            }
        );
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        for (let index = 0; index < 3; index += 1) {
            appendEvent(repoRoot, TASK_ID, 'REVIEW_RECORDED', 'PASS', {
                review_type: 'code',
                reviewer_identity: `agent:code-${index}`,
                review_context_sha256: sha256Text(`code-context-${index}`)
            });
        }

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const text = formatNextStepText(result);

        assert.equal(result.next_gate, 'compile-gate');
        assert.equal(result.review_cycle_block, null);
        assert.equal(text.includes('NextGate: review-cycle-attempt-guard'), false);
        assert.equal(
            fs.existsSync(path.join(reviewsRoot(repoRoot), `${TASK_ID}-review-cycle-auto-split-prompt.md`)),
            false
        );
    });

    it('still blocks malformed timeline evidence after successful PASS attempts exceed the total limit', () => {
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
                    enabled: true,
                    action: 'BLOCK_FOR_OPERATOR_DECISION',
                    max_failed_non_test_reviews: 15,
                    max_total_non_test_reviews: 1,
                    excluded_review_types: ['test'],
                    auto_split_enabled: false
                }
            }
        );
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        for (let index = 0; index < 2; index += 1) {
            appendEvent(repoRoot, TASK_ID, 'REVIEW_RECORDED', 'PASS', {
                review_type: 'code',
                reviewer_identity: `agent:pass-before-malformed-${index}`,
                review_context_sha256: sha256Text(`pass-before-malformed-context-${index}`)
            });
        }
        appendEvent(repoRoot, TASK_ID, 'REVIEW_RECORDED', 'PASS', {
            reviewer_identity: 'agent:missing-review-type-after-pass-overflow',
            review_context_sha256: sha256Text('missing-review-type-after-pass-overflow')
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.status, 'BLOCKED');
        assert.equal(result.next_gate, 'review-cycle-attempt-guard');
        assert.ok(result.reason.includes('timeline_integrity=1>0'));
        assert.equal(result.reason.includes('total_non_test_review_count=2>1'), false);
        assert.equal(result.review_cycle_block?.total_non_test_review_count, 2);
    });

    it('blocks at the total review-cycle limit when the nearest non-test attempt fails', () => {
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
                    enabled: true,
                    action: 'BLOCK_FOR_OPERATOR_DECISION',
                    max_failed_non_test_reviews: 15,
                    max_total_non_test_reviews: 2,
                    excluded_review_types: ['test'],
                    auto_split_enabled: false
                }
            }
        );
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true, security: true });
        for (let index = 0; index < 2; index += 1) {
            appendEvent(repoRoot, TASK_ID, 'REVIEW_RECORDED', 'PASS', {
                review_type: 'code',
                reviewer_identity: `agent:code-before-fail-${index}`,
                review_context_sha256: sha256Text(`code-before-fail-context-${index}`)
            });
        }
        appendEvent(repoRoot, TASK_ID, 'REVIEW_RECORDED', 'FAIL', {
            review_type: 'security',
            reviewer_identity: 'agent:security-total-boundary',
            review_context_sha256: sha256Text('security-total-boundary-context'),
            summary: 'security failed at total review-cycle boundary'
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const text = formatNextStepText(result);

        assert.equal(result.status, 'BLOCKED');
        assert.equal(result.next_gate, 'review-cycle-attempt-guard');
        assert.ok(result.reason.includes('total_non_test_review_count=3>2'));
        assert.ok(result.reason.includes('excluded_review_types="test"'));
        assert.equal(result.review_cycle_block?.latest_failed_review?.review_type, 'security');
        assert.equal(result.review_cycle_block?.latest_failed_review?.summary, 'security failed at total review-cycle boundary');
        assert.deepEqual(result.review_cycle_block?.counts_by_review_type.code, {
            total: 2,
            passed: 2,
            failed: 0,
            pending: 0
        });
        assert.deepEqual(result.review_cycle_block?.counts_by_review_type.security, {
            total: 1,
            passed: 0,
            failed: 1,
            pending: 0
        });
        assert.ok(text.includes('NextGate: review-cycle-attempt-guard'));
        assert.ok(text.includes('LatestFailedReview: review_type="security"'));
    });

    it('blocks when the latest same-key review record fails after a later unique PASS key was inserted', () => {
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
                    enabled: true,
                    action: 'BLOCK_FOR_OPERATOR_DECISION',
                    max_failed_non_test_reviews: 15,
                    max_total_non_test_reviews: 1,
                    excluded_review_types: ['test'],
                    auto_split_enabled: false
                }
            }
        );
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        const repeatedContextSha256 = sha256Text('repeat-latest-fail-context');
        appendEvent(repoRoot, TASK_ID, 'REVIEW_RECORDED', 'PASS', {
            review_type: 'code',
            reviewer_identity: 'agent:repeat-latest-fail',
            review_context_sha256: repeatedContextSha256
        });
        appendEvent(repoRoot, TASK_ID, 'REVIEW_RECORDED', 'PASS', {
            review_type: 'code',
            reviewer_identity: 'agent:other-pass-before-repeat-fail',
            review_context_sha256: sha256Text('other-pass-before-repeat-fail-context')
        });
        appendEvent(repoRoot, TASK_ID, 'REVIEW_RECORDED', 'FAIL', {
            review_type: 'code',
            reviewer_identity: 'agent:repeat-latest-fail',
            review_context_sha256: repeatedContextSha256,
            summary: 'same reviewer/context failed after another pass key'
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.status, 'BLOCKED');
        assert.equal(result.next_gate, 'review-cycle-attempt-guard');
        assert.ok(result.reason.includes('total_non_test_review_count=2>1'));
        assert.deepEqual(result.review_cycle_block?.counts_by_review_type.code, {
            total: 2,
            passed: 1,
            failed: 1,
            pending: 0
        });
        assert.equal(
            result.review_cycle_block?.latest_failed_review?.summary,
            'same reviewer/context failed after another pass key'
        );
    });

    it('does not count pending reviewer invocation noise as completed review-cycle attempts', () => {
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
                    enabled: true,
                    action: 'BLOCK_FOR_OPERATOR_DECISION',
                    max_failed_non_test_reviews: 15,
                    max_total_non_test_reviews: 1,
                    excluded_review_types: ['test'],
                    auto_split_enabled: false
                }
            }
        );
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        for (let index = 0; index < 3; index += 1) {
            appendEvent(repoRoot, TASK_ID, 'REVIEWER_INVOCATION_ATTESTED', 'INFO', {
                review_type: 'code',
                reviewer_identity: `agent:pending-code-${index}`,
                review_context_sha256: sha256Text(`pending-code-context-${index}`)
            });
        }

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'compile-gate');
        assert.equal(result.review_cycle_block, null);
    });

    it('blocks next-step when failed non-test review attempts exceed review cycle guard failed limit', () => {
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
                    enabled: true,
                    action: 'BLOCK_FOR_OPERATOR_DECISION',
                    max_failed_non_test_reviews: 1,
                    max_total_non_test_reviews: 15,
                    excluded_review_types: ['test'],
                    auto_split_enabled: false
                }
            }
        );
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, security: true });
        for (let index = 0; index < 2; index += 1) {
            appendEvent(repoRoot, TASK_ID, 'REVIEW_RECORDED', 'FAIL', {
                review_type: 'security',
                reviewer_identity: `agent:security-${index}`,
                review_context_sha256: sha256Text(`security-context-${index}`),
                summary: `security finding ${index}`
            });
        }

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const text = formatNextStepText(result);

        assert.equal(result.next_gate, 'review-cycle-attempt-guard');
        assert.ok(result.reason.includes('failed_non_test_review_count=2>=1'));
        assert.equal(result.review_cycle_block?.latest_failed_review?.review_type, 'security');
        assert.equal(result.review_cycle_block?.latest_failed_review?.summary, 'security finding 1');
        assert.ok(text.includes('LatestFailedReview: review_type="security"'));
        assert.ok(text.includes('summary="security finding 1"'));
    });

    it('reports mixed PASS and FAIL review-cycle attempts by non-test review type and status', () => {
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
                    enabled: true,
                    action: 'BLOCK_FOR_OPERATOR_DECISION',
                    max_failed_non_test_reviews: 15,
                    max_total_non_test_reviews: 2,
                    excluded_review_types: ['test'],
                    auto_split_enabled: false
                }
            }
        );
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true, api: true });
        appendEvent(repoRoot, TASK_ID, 'REVIEW_RECORDED', 'PASS', {
            review_type: 'code',
            reviewer_identity: 'agent:mixed-code-pass',
            review_context_sha256: sha256Text('mixed-code-pass')
        });
        appendEvent(repoRoot, TASK_ID, 'REVIEW_RECORDED', 'PASS', {
            review_type: 'api',
            reviewer_identity: 'agent:mixed-api-pass',
            review_context_sha256: sha256Text('mixed-api-pass')
        });
        appendEvent(repoRoot, TASK_ID, 'REVIEW_RECORDED', 'PASS', {
            review_type: 'test',
            reviewer_identity: 'agent:mixed-test-pass',
            review_context_sha256: sha256Text('mixed-test-pass')
        });
        appendEvent(repoRoot, TASK_ID, 'REVIEW_RECORDED', 'FAIL', {
            review_type: 'code',
            reviewer_identity: 'agent:mixed-code-fail',
            review_context_sha256: sha256Text('mixed-code-fail'),
            summary: 'code failed'
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const text = formatNextStepText(result);

        assert.equal(result.next_gate, 'review-cycle-attempt-guard');
        assert.deepEqual(result.review_cycle_block?.counts_by_review_type.api, {
            total: 1,
            passed: 1,
            failed: 0,
            pending: 0
        });
        assert.deepEqual(result.review_cycle_block?.counts_by_review_type.code, {
            total: 2,
            passed: 1,
            failed: 1,
            pending: 0
        });
        assert.equal(result.review_cycle_block?.counts_by_review_type.test, undefined);
        assert.equal(result.review_cycle_block?.latest_failed_review?.summary, 'code failed');
        assert.ok(text.includes('"api": total=1; passed=1; failed=0; pending=0'));
        assert.ok(text.includes('"code": total=2; passed=1; failed=1; pending=0'));
    });

    it('counts a normal invocation and recorded review pair as one review cycle attempt', () => {
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
                    enabled: true,
                    action: 'BLOCK_FOR_OPERATOR_DECISION',
                    max_failed_non_test_reviews: 15,
                    max_total_non_test_reviews: 1,
                    excluded_review_types: ['test'],
                    auto_split_enabled: false
                }
            }
        );
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        const reviewContextSha256 = sha256Text('normal-code-context');
        const sharedDetails = {
            review_type: 'code',
            reviewer_identity: 'agent:normal-code',
            review_context_sha256: reviewContextSha256
        };
        appendEvent(repoRoot, TASK_ID, 'REVIEWER_INVOCATION_ATTESTED', 'INFO', sharedDetails);
        appendEvent(repoRoot, TASK_ID, 'REVIEW_RECORDED', 'PASS', sharedDetails);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'compile-gate');
    });

    it('does not count reused non-test review evidence toward fresh review-cycle limits', () => {
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
                    enabled: true,
                    action: 'BLOCK_FOR_OPERATOR_DECISION',
                    max_failed_non_test_reviews: 15,
                    max_total_non_test_reviews: 1,
                    excluded_review_types: ['test'],
                    auto_split_enabled: false
                }
            }
        );
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true, api: true, performance: true, security: true });
        for (const reviewType of ['code', 'api', 'performance']) {
            appendEvent(repoRoot, TASK_ID, 'REVIEW_RECORDED', 'PASS', {
                review_type: reviewType,
                reviewer_identity: `agent:reused-${reviewType}`,
                review_context_sha256: sha256Text(`reused-${reviewType}-context`),
                reused_existing_review: true
            });
        }
        appendEvent(repoRoot, TASK_ID, 'REVIEW_RECORDED', 'FAIL', {
            review_type: 'security',
            reviewer_identity: 'agent:fresh-security-fail-under-total-limit',
            review_context_sha256: sha256Text('fresh-security-fail-under-total-limit'),
            summary: 'fresh failure should not be amplified by reused reviews'
        });
        appendEvent(repoRoot, TASK_ID, 'REVIEW_RECORDED', 'FAIL', {
            review_type: 'test',
            reviewer_identity: 'agent:test-fail-excluded-after-reuse',
            review_context_sha256: sha256Text('test-fail-excluded-after-reuse'),
            summary: 'test failure is excluded from non-test guard accounting'
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const text = formatNextStepText(result);

        assert.equal(result.next_gate, 'compile-gate');
        assert.equal(result.review_cycle_block, null);
        assert.equal(text.includes('NextGate: review-cycle-attempt-guard'), false);
    });

    it('keeps scanning review-cycle timeline after total limit to report the latest failed review', () => {
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
                    enabled: true,
                    action: 'BLOCK_FOR_OPERATOR_DECISION',
                    max_failed_non_test_reviews: 15,
                    max_total_non_test_reviews: 1,
                    excluded_review_types: ['test'],
                    auto_split_enabled: false
                }
            }
        );
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        for (let index = 0; index < 2; index += 1) {
            appendEvent(repoRoot, TASK_ID, 'REVIEW_RECORDED', 'PASS', {
                review_type: 'code',
                reviewer_identity: `agent:early-stop-${index}`,
                review_context_sha256: sha256Text(`early-stop-context-${index}`)
            });
        }
        appendEvent(repoRoot, TASK_ID, 'REVIEW_RECORDED', 'PASS', {
            review_type: 'code',
            reviewer_identity: 'agent:latest-failed-after-total-block',
            review_context_sha256: sha256Text('latest-failed-after-total-block')
        });
        appendEvent(repoRoot, TASK_ID, 'REVIEW_RECORDED', 'FAIL', {
            review_type: 'security',
            reviewer_identity: 'agent:latest-security-fail',
            review_context_sha256: sha256Text('latest-security-fail'),
            summary: 'latest failure after total threshold'
        });
        appendEvent(repoRoot, TASK_ID, 'REVIEWER_INVOCATION_ATTESTED', 'INFO', {
            reviewer_identity: 'agent:malformed-after-block',
            review_context_sha256: sha256Text('malformed-after-block')
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'review-cycle-attempt-guard');
        assert.ok(result.reason.includes('total_non_test_review_count=4>1'));
        assert.equal(result.reason.includes('timeline_integrity'), false);
        assert.equal(result.review_cycle_block?.max_total_non_test_reviews, 1);
        assert.equal(result.review_cycle_block?.max_failed_non_test_reviews, 15);
        assert.equal(result.review_cycle_block?.latest_failed_review?.review_type, 'security');
        assert.equal(result.review_cycle_block?.latest_failed_review?.summary, 'latest failure after total threshold');
        assert.ok(formatNextStepText(result).includes('ReviewCycleLimits: max_total_non_test_reviews=1; max_failed_non_test_reviews=15'));
    });

    it('counts failed review records by reading immutable review artifact snapshot verdicts', () => {
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
                    enabled: true,
                    action: 'BLOCK_FOR_OPERATOR_DECISION',
                    max_failed_non_test_reviews: 1,
                    max_total_non_test_reviews: 15,
                    excluded_review_types: ['test'],
                    auto_split_enabled: false
                }
            }
        );
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, security: true });
        const artifactPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-security.md`);
        const artifactContent = '# security review\n\nSECURITY REVIEW FAILED\n';
        fs.writeFileSync(artifactPath, artifactContent, 'utf8');
        const artifactSha256 = sha256Text(artifactContent);
        const artifactSnapshotPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-security-artifact-${artifactSha256}.md`);
        fs.writeFileSync(artifactSnapshotPath, artifactContent, 'utf8');
        for (let index = 0; index < 2; index += 1) {
            appendEvent(repoRoot, TASK_ID, 'REVIEW_RECORDED', 'PASS', {
                review_type: 'security',
                reviewer_identity: `agent:legacy-security-${index}`,
                review_context_sha256: sha256Text(`legacy-security-context-${index}`),
                review_artifact_path: artifactPath,
                review_artifact_snapshot_path: artifactSnapshotPath,
                review_artifact_snapshot_sha256: artifactSha256
            });
        }

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'review-cycle-attempt-guard');
        assert.ok(result.reason.includes('failed_non_test_review_count=2>=1'));
    });

    it('validates repeated immutable review evidence with one indexed snapshot read per file', () => {
        const repoRoot = makeTempRepo();
        const runtimeReviewsRoot = reviewsRoot(repoRoot);
        const artifactContent = '# security review\n\nSECURITY REVIEW FAILED\n';
        const artifactSha256 = sha256Text(artifactContent);
        const artifactPath = path.join(runtimeReviewsRoot, `${TASK_ID}-security.md`);
        const artifactSnapshotPath = path.join(
            runtimeReviewsRoot,
            `${TASK_ID}-security-artifact-${artifactSha256}.md`
        );
        fs.writeFileSync(artifactPath, artifactContent, 'utf8');
        fs.writeFileSync(artifactSnapshotPath, artifactContent, 'utf8');
        const receipt = {
            task_id: TASK_ID,
            review_type: 'security',
            review_artifact_sha256: artifactSha256
        };
        const receiptContent = `${JSON.stringify(receipt, null, 2)}\n`;
        const receiptSha256 = sha256Text(receiptContent);
        const receiptSnapshotPath = path.join(
            runtimeReviewsRoot,
            `${TASK_ID}-security-receipt-${receiptSha256}.json`
        );
        fs.writeFileSync(receiptSnapshotPath, receiptContent, 'utf8');
        for (let index = 0; index < 2; index += 1) {
            appendEvent(repoRoot, TASK_ID, 'REVIEW_RECORDED', 'PASS', {
                review_type: 'security',
                reviewer_identity: `agent:indexed-security-${index}`,
                review_context_sha256: sha256Text(`indexed-security-context-${index}`),
                review_artifact_path: artifactPath,
                review_artifact_snapshot_path: artifactSnapshotPath,
                review_artifact_snapshot_sha256: artifactSha256,
                receipt_snapshot_path: receiptSnapshotPath,
                receipt_snapshot_sha256: receiptSha256
            });
        }

        const fsModule = requireFromTest('node:fs') as typeof fs;
        const originalReaddirSync = fsModule.readdirSync;
        const originalOpenSync = fsModule.openSync;
        let reviewDirectoryReads = 0;
        const artifactSnapshotKey = path.resolve(artifactSnapshotPath);
        const receiptSnapshotKey = path.resolve(receiptSnapshotPath);
        const immutableSnapshotReads = new Map<string, number>([
            [artifactSnapshotKey, 0],
            [receiptSnapshotKey, 0]
        ]);
        fsModule.readdirSync = ((targetPath: PathLike, options?: unknown) => {
            if (path.resolve(String(targetPath)) === path.resolve(runtimeReviewsRoot)) {
                reviewDirectoryReads += 1;
            }
            return originalReaddirSync(targetPath, options as never);
        }) as typeof fsModule.readdirSync;
        fsModule.openSync = ((targetPath: PathLike, flags: OpenMode, mode?: Mode) => {
            const snapshotKey = path.resolve(String(targetPath));
            const priorReads = immutableSnapshotReads.get(snapshotKey);
            if (priorReads !== undefined) {
                immutableSnapshotReads.set(snapshotKey, priorReads + 1);
            }
            return originalOpenSync(targetPath, flags, mode);
        }) as typeof fsModule.openSync;

        try {
            const result = readReviewCycleGuardAttempts(
                repoRoot,
                path.join(eventsRoot(repoRoot), `${TASK_ID}.jsonl`),
                TASK_ID,
                normalizeReviewCycleGuardConfig({
                    enabled: true,
                    action: 'BLOCK_FOR_OPERATOR_DECISION',
                    max_failed_non_test_reviews: 3,
                    max_total_non_test_reviews: 3,
                    excluded_review_types: ['test'],
                    auto_split_enabled: false
                }),
                null
            );

            assert.equal(result.timelineValid, true);
            assert.equal(result.attempts.length, 2);
            assert.equal(reviewDirectoryReads, 1);
            assert.equal(immutableSnapshotReads.get(artifactSnapshotKey), 1);
            assert.equal(immutableSnapshotReads.get(receiptSnapshotKey), 1);
        } finally {
            fsModule.readdirSync = originalReaddirSync;
            fsModule.openSync = originalOpenSync;
        }
    });

    it('counts verdict-free JSON review artifact snapshots with active findings as failed attempts', () => {
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
                    enabled: true,
                    action: 'BLOCK_FOR_OPERATOR_DECISION',
                    max_failed_non_test_reviews: 1,
                    max_total_non_test_reviews: 15,
                    excluded_review_types: ['test'],
                    auto_split_enabled: false
                }
            }
        );
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        const reviewType = 'code';
        const contextPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-${reviewType}-review-context.json`);
        const treeStateSha256 = sha256Text('json-review-cycle-tree-state');
        const coverageContractSha256 = sha256Text('json-review-cycle-coverage-contract');
        const coverageContract = {
            schema_version: 1,
            required: true,
            review_type: reviewType,
            obligations: [{
                id: 'FILE-001',
                kind: 'file',
                target: 'src/gates/next-step/next-step-review-cycle-guard-attempts.ts'
            }],
            obligation_count: 1,
            contract_sha256: coverageContractSha256
        };
        const preflightPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-preflight.json`);
        const reviewExecution = buildReviewRemediationReviewContract({
            taskId: TASK_ID,
            reviewType,
            preflightSha256: fileSha256(preflightPath),
            fullReviewScope: ['src/app.ts']
        });
        const reviewContext = {
            schema_version: 4,
            task_id: TASK_ID,
            review_type: reviewType,
            preflight_path: preflightPath,
            preflight_sha256: fileSha256(preflightPath),
            task_scope: { changed_files: ['src/app.ts'] },
            tree_state: {
                tree_state_sha256: treeStateSha256
            },
            coverage_contract: coverageContract,
            review_execution: reviewExecution
        };
        writeJson(contextPath, reviewContext);
        const reviewExecutionBindings = resolveReviewContextExecutionEvidenceBindings(reviewContext).bindings;
        assert.ok(reviewExecutionBindings);
        const reviewContextSha256 = fileSha256(contextPath);
        const artifactPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-${reviewType}.md`);
        const artifactContent = JSON.stringify({
            schema_version: REVIEW_FINDINGS_SCHEMA_VERSION,
            task_id: TASK_ID,
            review_type: reviewType,
            review_context_sha256: reviewContextSha256,
            tree_state_sha256: treeStateSha256,
            validation_notes: [{
                id: 'N-001',
                topic: 'review-cycle-attempt-counting',
                note: 'Reviewed review-cycle guard attempt counting for verdict-free JSON review artifacts.',
                evidence: [{
                    location: 'src/gates/next-step/next-step-review-cycle-guard-attempts.ts:240',
                    observation: 'The review-cycle guard reads immutable artifact snapshots before counting attempts.'
                }]
            }],
            coverage_ledger: {
                coverage_contract_sha256: coverageContractSha256,
                entries: [{
                    obligation_id: 'FILE-001',
                    evidence: [{
                        location: 'src/gates/next-step/next-step-review-cycle-guard-attempts.ts:240',
                        observation: 'The JSON artifact snapshot branch was covered.'
                    }],
                    finding_ids: ['F-001']
                }]
            },
            review_execution: {
                mode: reviewExecution.mode,
                contract_sha256: reviewExecution.contract_sha256,
                covered_delta_targets: [],
                inspected_prior_finding_ids: []
            },
            findings: {
                critical: [],
                high: [{
                    id: 'F-001',
                    title: 'Verdict-free failed JSON review was previously pending',
                    description: 'Active findings in a strict JSON review artifact must count as failed attempts.',
                    evidence: [{
                        location: 'src/gates/next-step/next-step-review-cycle-guard-attempts.ts:240',
                        observation: 'The guard maps active JSON findings to failed review-cycle attempts.'
                    }],
                    coverage_obligation_ids: ['FILE-001']
                }],
                medium: [],
                low: []
            },
            residual_risks: [],
            reviewer_notes: []
        });
        fs.writeFileSync(artifactPath, artifactContent, 'utf8');
        const artifactSha256 = fileSha256(artifactPath);
        const artifactSnapshotPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-${reviewType}-artifact-${artifactSha256}.md`);
        fs.writeFileSync(artifactSnapshotPath, artifactContent, 'utf8');
        const findingsValidation = validateReviewFindingsContract({
            content: artifactContent,
            expectedTaskId: TASK_ID,
            expectedReviewType: reviewType,
            expectedReviewContextSha256: reviewContextSha256,
            expectedTreeStateSha256: treeStateSha256,
            coverageContract: coverageContract as never,
            expectedReviewExecutionContract: reviewExecution
        });
        assert.equal(findingsValidation.valid, true, findingsValidation.violations.join('\n'));
        const validationArtifactPath = getReviewFindingsValidationArtifactPath(artifactPath);
        const validationArtifact = buildReviewFindingsValidationArtifact({
            taskId: TASK_ID,
            reviewType,
            validation: findingsValidation,
            reviewOutputSha256: artifactSha256,
            reviewArtifactPath: artifactPath,
            reviewArtifactSha256: artifactSha256,
            reviewContextPath: contextPath,
            reviewContextSha256,
            reviewTreeStateSha256: treeStateSha256,
            coverageContract: coverageContract as never
        });
        writeJson(validationArtifactPath, validationArtifact);
        const validationArtifactSha256 = fileSha256(validationArtifactPath);
        const validationArtifactSnapshotPath = getReviewFindingsValidationArtifactSnapshotPath(
            validationArtifactPath,
            validationArtifactSha256
        );
        writeJson(validationArtifactSnapshotPath, validationArtifact);
        const receiptPath = artifactPath.replace(/\.md$/u, '-receipt.json');
        const receipt = {
            task_id: TASK_ID,
            review_type: reviewType,
            review_output_sha256: artifactSha256,
            review_artifact_sha256: artifactSha256,
            review_context_sha256: reviewContextSha256,
            review_tree_state_sha256: treeStateSha256,
            ...reviewExecutionBindings,
            review_findings_validation: {
                artifact_path: validationArtifactPath.replace(/\\/g, '/'),
                artifact_sha256: validationArtifactSha256,
                snapshot_path: validationArtifactSnapshotPath.replace(/\\/g, '/'),
                snapshot_sha256: validationArtifactSha256,
                status: validationArtifact.validation_result.status,
                accepted: validationArtifact.validation_result.accepted,
                validation_result_sha256: validationArtifact.validation_result_sha256,
                violation_count: validationArtifact.validation_result.violations.length
            }
        };
        writeJson(receiptPath, receipt);
        const receiptSha256 = fileSha256(receiptPath);
        const receiptSnapshotPath = artifactPath.replace(/\.md$/u, `-receipt-${receiptSha256}.json`);
        writeJson(receiptSnapshotPath, receipt);
        for (let index = 0; index < 2; index += 1) {
            appendEvent(repoRoot, TASK_ID, 'REVIEW_RECORDED', 'PASS', {
                review_type: reviewType,
                reviewer_identity: `agent:json-code-${index}`,
                review_context_sha256: reviewContextSha256,
                review_tree_state_sha256: treeStateSha256,
                review_artifact_path: artifactPath,
                review_artifact_sha256: artifactSha256,
                review_artifact_snapshot_path: artifactSnapshotPath,
                review_artifact_snapshot_sha256: artifactSha256,
                review_context_path: contextPath,
                receipt_path: receiptPath,
                receipt_sha256: receiptSha256,
                receipt_snapshot_path: receiptSnapshotPath,
                receipt_snapshot_sha256: receiptSha256,
                summary: `verdict-free JSON code finding ${index}`
            });
        }

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'review-cycle-attempt-guard');
        assert.ok(result.reason.includes('failed_non_test_review_count=2>=1'));
        assert.deepEqual(result.review_cycle_block?.counts_by_review_type.code, {
            total: 2,
            passed: 0,
            failed: 2,
            pending: 0
        });
        assert.equal(
            result.review_cycle_block?.latest_failed_review?.summary,
            'verdict-free JSON code finding 1'
        );
    });

    it('treats accepted non-blocking JSON findings as passed review-cycle attempts', () => {
        for (const scenario of [
            { severity: 'medium', action: 'create_follow_up', findingId: 'F-001' },
            { severity: 'low', action: 'ignore', findingId: 'F-001' }
        ] as const) {
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
                        enabled: true,
                        action: 'BLOCK_FOR_OPERATOR_DECISION',
                        max_failed_non_test_reviews: 1,
                        max_total_non_test_reviews: 1,
                        excluded_review_types: ['test'],
                        auto_split_enabled: false
                    }
                }
            );
            seedStartedTask(repoRoot, TASK_ID);
            writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
            const reviewType = 'code';
            const contextPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-${reviewType}-review-context.json`);
            const treeStateSha256 = sha256Text(`${scenario.action}-review-cycle-tree-state`);
            const coverageContractSha256 = sha256Text(`${scenario.action}-review-cycle-coverage-contract`);
            const coverageContract = {
                schema_version: 1,
                required: true,
                review_type: reviewType,
                obligations: [{
                    id: 'FILE-001',
                    kind: 'file',
                    target: 'src/gates/next-step/next-step-review-cycle-guard-attempts.ts'
                }],
                obligation_count: 1,
                contract_sha256: coverageContractSha256
            };
            const preflightPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-preflight.json`);
            const reviewExecution = buildReviewRemediationReviewContract({
                taskId: TASK_ID,
                reviewType,
                preflightSha256: fileSha256(preflightPath),
                fullReviewScope: ['src/app.ts']
            });
            const reviewContext = {
                schema_version: 4,
                task_id: TASK_ID,
                review_type: reviewType,
                preflight_path: preflightPath,
                preflight_sha256: fileSha256(preflightPath),
                task_scope: { changed_files: ['src/app.ts'] },
                tree_state: {
                    tree_state_sha256: treeStateSha256
                },
                coverage_contract: coverageContract,
                review_execution: reviewExecution
            };
            writeJson(contextPath, reviewContext);
            const reviewExecutionBindings = resolveReviewContextExecutionEvidenceBindings(reviewContext).bindings;
            assert.ok(reviewExecutionBindings);
            const reviewContextSha256 = fileSha256(contextPath);
            const artifactPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-${reviewType}-${scenario.action}.md`);
            const findings = {
                critical: [],
                high: [],
                medium: [],
                low: []
            } as Record<'critical' | 'high' | 'medium' | 'low', Array<Record<string, unknown>>>;
            findings[scenario.severity] = [{
                id: scenario.findingId,
                title: `Non-blocking ${scenario.action} finding`,
                description: `This ${scenario.severity} finding is dispositioned to ${scenario.action}.`,
                evidence: [{
                    location: 'src/gates/next-step/next-step-review-cycle-guard-attempts.ts:240',
                    observation: 'The guard evaluates accepted findings through the receipt disposition.'
                }],
                coverage_obligation_ids: ['FILE-001']
            }];
            const artifactContent = JSON.stringify({
                schema_version: REVIEW_FINDINGS_SCHEMA_VERSION,
                task_id: TASK_ID,
                review_type: reviewType,
                review_context_sha256: reviewContextSha256,
                tree_state_sha256: treeStateSha256,
                validation_notes: [{
                    id: 'N-001',
                    topic: 'review-cycle-non-blocking-disposition',
                    note: 'Reviewed review-cycle guard attempt counting for accepted non-blocking findings.',
                    evidence: [{
                        location: 'src/gates/next-step/next-step-review-cycle-guard-attempts.ts:240',
                        observation: 'The review-cycle guard reads receipt disposition before counting JSON findings as failed.'
                    }]
                }],
                coverage_ledger: {
                    coverage_contract_sha256: coverageContractSha256,
                    entries: [{
                        obligation_id: 'FILE-001',
                        evidence: [{
                            location: 'src/gates/next-step/next-step-review-cycle-guard-attempts.ts:240',
                            observation: 'The non-blocking JSON artifact branch was covered.'
                        }],
                        finding_ids: [scenario.findingId]
                    }]
                },
                review_execution: {
                    mode: reviewExecution.mode,
                    contract_sha256: reviewExecution.contract_sha256,
                    covered_delta_targets: [],
                    inspected_prior_finding_ids: []
                },
                findings,
                residual_risks: [],
                reviewer_notes: []
            });
            fs.writeFileSync(artifactPath, artifactContent, 'utf8');
            const artifactSha256 = fileSha256(artifactPath);
            const artifactSnapshotPath = path.join(
                reviewsRoot(repoRoot),
                `${TASK_ID}-${reviewType}-artifact-${artifactSha256}.md`
            );
            fs.writeFileSync(artifactSnapshotPath, artifactContent, 'utf8');
            const findingsValidation = validateReviewFindingsContract({
                content: artifactContent,
                expectedTaskId: TASK_ID,
                expectedReviewType: reviewType,
                expectedReviewContextSha256: reviewContextSha256,
                expectedTreeStateSha256: treeStateSha256,
                coverageContract: coverageContract as never,
                expectedReviewExecutionContract: reviewExecution
            });
            assert.equal(findingsValidation.valid, true, findingsValidation.violations.join('\n'));
            const validationArtifactPath = getReviewFindingsValidationArtifactPath(artifactPath);
            const validationArtifact = buildReviewFindingsValidationArtifact({
                taskId: TASK_ID,
                reviewType,
                validation: findingsValidation,
                reviewOutputSha256: artifactSha256,
                reviewArtifactPath: artifactPath,
                reviewArtifactSha256: artifactSha256,
                reviewContextPath: contextPath,
                reviewContextSha256,
                reviewTreeStateSha256: treeStateSha256,
                coverageContract: coverageContract as never
            });
            writeJson(validationArtifactPath, validationArtifact);
            const validationArtifactSha256 = fileSha256(validationArtifactPath);
            const validationArtifactSnapshotPath = getReviewFindingsValidationArtifactSnapshotPath(
                validationArtifactPath,
                validationArtifactSha256
            );
            writeJson(validationArtifactSnapshotPath, validationArtifact);
            const mediumIds = scenario.severity === 'medium' ? [scenario.findingId] : [];
            const lowIds = scenario.severity === 'low' ? [scenario.findingId] : [];
            const reviewFindingsDisposition = {
                schema_version: 1,
                policy_id: 'custom',
                policy_source: 'preflight_profile_policy_snapshot',
                policy_diagnostics: [],
                findings: {
                    critical: { action: 'fix_now', ids: [], count: 0 },
                    high: { action: 'fix_now', ids: [], count: 0 },
                    medium: { action: scenario.severity === 'medium' ? scenario.action : 'create_follow_up', ids: mediumIds, count: mediumIds.length },
                    low: { action: scenario.severity === 'low' ? scenario.action : 'create_follow_up', ids: lowIds, count: lowIds.length }
                },
                residual_risks: { action: 'create_follow_up', ids: [], count: 0 },
                counts_by_action: {
                    fix_now: 0,
                    create_follow_up: scenario.action === 'create_follow_up' ? 1 : 0,
                    ignore: scenario.action === 'ignore' ? 1 : 0
                },
                blocking_count: 0,
                blocking_ids: [],
                non_blocking_count: 1,
                total_count: 1,
                verdict: 'pass_with_follow_up_or_ignored_findings'
            };
            const receiptPath = artifactPath.replace(/\.md$/u, '-receipt.json');
            const receipt = {
                task_id: TASK_ID,
                review_type: reviewType,
                review_output_sha256: artifactSha256,
                review_artifact_sha256: artifactSha256,
                review_context_sha256: reviewContextSha256,
                review_tree_state_sha256: treeStateSha256,
                ...reviewExecutionBindings,
                review_findings_disposition: reviewFindingsDisposition,
                review_findings_validation: {
                    artifact_path: validationArtifactPath.replace(/\\/g, '/'),
                    artifact_sha256: validationArtifactSha256,
                    snapshot_path: validationArtifactSnapshotPath.replace(/\\/g, '/'),
                    snapshot_sha256: validationArtifactSha256,
                    status: validationArtifact.validation_result.status,
                    accepted: validationArtifact.validation_result.accepted,
                    validation_result_sha256: validationArtifact.validation_result_sha256,
                    violation_count: validationArtifact.validation_result.violations.length
                }
            };
            writeJson(receiptPath, receipt);
            const receiptSha256 = fileSha256(receiptPath);
            const receiptSnapshotPath = path.join(
                reviewsRoot(repoRoot),
                `${TASK_ID}-${reviewType}-receipt-${receiptSha256}.json`
            );
            writeJson(receiptSnapshotPath, receipt);
            for (let index = 0; index < 2; index += 1) {
                appendEvent(repoRoot, TASK_ID, 'REVIEW_RECORDED', 'PASS', {
                    review_type: reviewType,
                    reviewer_identity: `agent:${scenario.action}-${index}`,
                    review_context_sha256: reviewContextSha256,
                    review_tree_state_sha256: treeStateSha256,
                    review_artifact_path: artifactPath,
                    review_artifact_sha256: artifactSha256,
                    review_artifact_snapshot_path: artifactSnapshotPath,
                    review_artifact_snapshot_sha256: artifactSha256,
                    review_context_path: contextPath,
                    receipt_path: receiptPath,
                    receipt_sha256: receiptSha256,
                    receipt_snapshot_path: receiptSnapshotPath,
                    receipt_snapshot_sha256: receiptSha256,
                    summary: `non-blocking ${scenario.action} finding ${index}`
                });
            }

            const attempts = readReviewCycleGuardAttempts(
                repoRoot,
                path.join(eventsRoot(repoRoot), `${TASK_ID}.jsonl`),
                TASK_ID,
                normalizeReviewCycleGuardConfig({
                    enabled: true,
                    action: 'BLOCK_FOR_OPERATOR_DECISION',
                    max_failed_non_test_reviews: 1,
                    max_total_non_test_reviews: 1,
                    excluded_review_types: ['test'],
                    auto_split_enabled: false
                }),
                null
            );
            assert.equal(attempts.timelineValid, true, scenario.action);
            assert.equal(attempts.latestFailedReview, null, scenario.action);
            assert.deepEqual(
                attempts.attempts.map((attempt) => ({
                    reviewType: attempt.reviewType,
                    failed: attempt.failed,
                    passed: attempt.passed
                })),
                [
                    { reviewType, failed: false, passed: true },
                    { reviewType, failed: false, passed: true }
                ],
                scenario.action
            );

            const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
            assert.equal(result.review_cycle_block, null, scenario.action);
            assert.equal(result.next_gate, 'compile-gate', scenario.action);
        }
    });

    it('keeps schema-invalid verdict-free JSON snapshots pending without timeline-integrity failure', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        const reviewType = 'code';
        const contextPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-${reviewType}-review-context.json`);
        const treeStateSha256 = sha256Text('schema-invalid-json-review-cycle-tree-state');
        writeJson(contextPath, {
            task_id: TASK_ID,
            review_type: reviewType,
            tree_state: {
                tree_state_sha256: treeStateSha256
            },
            coverage_contract: {
                schema_version: 1,
                required: true,
                review_type: reviewType,
                obligations: [{
                    id: 'FILE-001',
                    kind: 'file',
                    target: 'src/gates/next-step/next-step-review-cycle-guard-attempts.ts'
                }],
                obligation_count: 1,
                contract_sha256: sha256Text('schema-invalid-json-review-cycle-coverage-contract')
            }
        });
        const artifactContent = JSON.stringify({
            schema_version: 1,
            task_id: TASK_ID,
            review_type: reviewType,
            review_context_sha256: fileSha256(contextPath),
            tree_state_sha256: treeStateSha256,
            validation_notes: [],
            coverage_ledger: {
                coverage_contract_sha256: sha256Text('schema-invalid-json-review-cycle-coverage-contract'),
                entries: []
            },
            findings: { critical: [], high: [], medium: [], low: [] },
            residual_risks: [],
            reviewer_notes: []
        });
        const artifactPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-${reviewType}.md`);
        fs.writeFileSync(artifactPath, artifactContent, 'utf8');
        const artifactSha256 = sha256Text(artifactContent);
        const artifactSnapshotPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-${reviewType}-artifact-${artifactSha256}.md`);
        fs.writeFileSync(artifactSnapshotPath, artifactContent, 'utf8');
        appendEvent(repoRoot, TASK_ID, 'REVIEW_RECORDED', 'PASS', {
            review_type: reviewType,
            reviewer_identity: 'agent:schema-invalid-json-code',
            review_context_sha256: fileSha256(contextPath),
            review_tree_state_sha256: treeStateSha256,
            review_artifact_path: artifactPath,
            review_artifact_sha256: artifactSha256,
            review_artifact_snapshot_path: artifactSnapshotPath,
            review_artifact_snapshot_sha256: artifactSha256,
            review_context_path: contextPath
        });

        const result = readReviewCycleGuardAttempts(
            repoRoot,
            path.join(eventsRoot(repoRoot), `${TASK_ID}.jsonl`),
            TASK_ID,
            normalizeReviewCycleGuardConfig({
                enabled: true,
                action: 'BLOCK_FOR_OPERATOR_DECISION',
                max_failed_non_test_reviews: 1,
                max_total_non_test_reviews: 15,
                excluded_review_types: ['test'],
                auto_split_enabled: false
            }),
            null
        );

        assert.equal(result.timelineValid, true);
        assert.equal(result.attempts.length, 1);
        assert.equal(result.attempts[0]?.failed, false);
        assert.equal(result.attempts[0]?.passed, false);
    });

    it('keeps historical PASS verdict from immutable snapshot when mutable review artifact is later overwritten', () => {
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
                    enabled: true,
                    action: 'BLOCK_FOR_OPERATOR_DECISION',
                    max_failed_non_test_reviews: 1,
                    max_total_non_test_reviews: 15,
                    excluded_review_types: ['test'],
                    auto_split_enabled: false
                }
            }
        );
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        const artifactPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-code.md`);
        const passContent = '# code review\n\nCODE REVIEW PASSED\n';
        const passSha256 = sha256Text(passContent);
        const artifactSnapshotPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-code-artifact-${passSha256}.md`);
        fs.writeFileSync(artifactPath, passContent, 'utf8');
        fs.writeFileSync(artifactSnapshotPath, passContent, 'utf8');
        for (let index = 0; index < 2; index += 1) {
            appendEvent(repoRoot, TASK_ID, 'REVIEW_RECORDED', 'PASS', {
                review_type: 'code',
                reviewer_identity: `agent:historical-pass-${index}`,
                review_context_sha256: sha256Text(`historical-pass-context-${index}`),
                review_artifact_path: artifactPath,
                review_artifact_snapshot_path: artifactSnapshotPath,
                review_artifact_snapshot_sha256: passSha256
            });
        }
        fs.writeFileSync(artifactPath, '# code review\n\nCODE REVIEW FAILED\n', 'utf8');

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'compile-gate');
        assert.equal(result.review_cycle_block, null);
    });

    it('keeps legacy path-only PASS outcome when mutable review artifact is later overwritten', () => {
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
                    enabled: true,
                    action: 'BLOCK_FOR_OPERATOR_DECISION',
                    max_failed_non_test_reviews: 1,
                    max_total_non_test_reviews: 15,
                    excluded_review_types: ['test'],
                    auto_split_enabled: false
                }
            }
        );
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        const artifactPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-code.md`);
        fs.writeFileSync(artifactPath, '# code review\n\nCODE REVIEW PASSED\n', 'utf8');
        for (let index = 0; index < 2; index += 1) {
            appendEvent(repoRoot, TASK_ID, 'REVIEW_RECORDED', 'PASS', {
                review_type: 'code',
                reviewer_identity: `agent:legacy-path-pass-${index}`,
                review_context_sha256: sha256Text(`legacy-path-pass-context-${index}`),
                review_artifact_path: artifactPath
            });
        }
        fs.writeFileSync(artifactPath, '# code review\n\nCODE REVIEW FAILED\n', 'utf8');

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'compile-gate');
        assert.equal(result.review_cycle_block, null);
    });

    it('does not let a forged PASS snapshot override explicit failed review outcomes', () => {
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
                    enabled: true,
                    action: 'BLOCK_FOR_OPERATOR_DECISION',
                    max_failed_non_test_reviews: 1,
                    max_total_non_test_reviews: 15,
                    excluded_review_types: ['test'],
                    auto_split_enabled: false
                }
            }
        );
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, security: true });
        const passContent = '# security review\n\nSECURITY REVIEW PASSED\n';
        const passSha256 = sha256Text(passContent);
        const forgedSnapshotPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-security-artifact-${passSha256}.md`);
        fs.writeFileSync(forgedSnapshotPath, passContent, 'utf8');
        const mismatchedSnapshotSha256 = sha256Text('different snapshot content');
        for (let index = 0; index < 2; index += 1) {
            appendEvent(repoRoot, TASK_ID, 'REVIEW_RECORDED', 'FAIL', {
                review_type: 'security',
                reviewer_identity: `agent:forged-security-${index}`,
                review_context_sha256: sha256Text(`forged-security-context-${index}`),
                review_artifact_snapshot_path: forgedSnapshotPath,
                review_artifact_snapshot_sha256: mismatchedSnapshotSha256,
                summary: `explicit security failure with forged PASS snapshot ${index}`
            });
        }

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'review-cycle-attempt-guard');
        assert.ok(result.reason.includes('timeline_integrity=1>0'));
        assert.ok(result.reason.includes('failed_non_test_review_count=2>=1'));
        assert.equal(
            result.review_cycle_block?.latest_failed_review?.summary,
            'explicit security failure with forged PASS snapshot 1'
        );
    });

    it('does not block successful repeated review attempts when context hash is missing', () => {
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
                    enabled: true,
                    action: 'BLOCK_FOR_OPERATOR_DECISION',
                    max_failed_non_test_reviews: 15,
                    max_total_non_test_reviews: 1,
                    excluded_review_types: ['test'],
                    auto_split_enabled: false
                }
            }
        );
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        for (let index = 0; index < 2; index += 1) {
            appendEvent(repoRoot, TASK_ID, 'REVIEW_RECORDED', 'PASS', {
                review_type: 'code',
                reviewer_identity: 'agent:repeat-code'
            });
        }

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'compile-gate');
        assert.equal(result.review_cycle_block, null);
    });

    it('does not collapse repeated failed review attempts when reviewer identity is missing', () => {
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
                    enabled: true,
                    action: 'BLOCK_FOR_OPERATOR_DECISION',
                    max_failed_non_test_reviews: 1,
                    max_total_non_test_reviews: 15,
                    excluded_review_types: ['test'],
                    auto_split_enabled: false
                }
            }
        );
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, security: true });
        for (let index = 0; index < 2; index += 1) {
            appendEvent(repoRoot, TASK_ID, 'REVIEW_RECORDED', 'FAIL', {
                review_type: 'security',
                review_context_sha256: sha256Text('repeat-security-context')
            });
        }

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'review-cycle-attempt-guard');
        assert.ok(result.reason.includes('failed_non_test_review_count=2>=1'));
    });

    it('surfaces WARN_ONLY review cycle violations without blocking the next gate', () => {
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
                    enabled: true,
                    action: 'WARN_ONLY',
                    max_failed_non_test_reviews: 15,
                    max_total_non_test_reviews: 1,
                    excluded_review_types: ['test']
                }
            }
        );
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        for (let index = 0; index < 2; index += 1) {
            appendEvent(repoRoot, TASK_ID, 'REVIEW_RECORDED', 'PASS', {
                review_type: 'code',
                reviewer_identity: `agent:warn-code-${index}`,
                review_context_sha256: sha256Text(`warn-code-context-${index}`)
            });
        }

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const text = formatNextStepText(result);

        assert.equal(result.next_gate, 'compile-gate');
        assert.equal(result.warnings.length, 1);
        assert.ok(result.warnings[0].includes('Review cycle guard: WARN_ONLY'));
        assert.ok(result.warnings[0].includes('total_non_test_review_count=2>1'));
        assert.ok(text.includes('Warnings:'));
        assert.ok(text.includes('Review cycle guard: WARN_ONLY'));
    });

    it('does not block next-step when only excluded test review attempts exceed review cycle limits', () => {
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
                    enabled: true,
                    action: 'BLOCK_FOR_OPERATOR_DECISION',
                    max_failed_non_test_reviews: 1,
                    max_total_non_test_reviews: 1,
                    excluded_review_types: ['test']
                }
            }
        );
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, test: true });
        for (let index = 0; index < 3; index += 1) {
            appendEvent(repoRoot, TASK_ID, 'REVIEW_RECORDED', 'PASS', {
                review_type: 'test',
                reviewer_identity: `agent:test-${index}`,
                review_context_sha256: sha256Text(`test-context-${index}`)
            });
        }

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'compile-gate');
    });

    it('blocks next-step when review cycle timeline history is malformed', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        appendEvent(repoRoot, TASK_ID, 'REVIEW_RECORDED', 'INFO', {
            reviewer_identity: 'agent:missing-review-type',
            review_context_sha256: sha256Text('missing-review-type')
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'review-cycle-attempt-guard');
        assert.ok(result.reason.includes('timeline_integrity=1>0'));
    });

    it('blocks cumulative review churn across changing scope hashes', () => {
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
                    enabled: true,
                    action: 'BLOCK_FOR_OPERATOR_DECISION',
                    max_failed_non_test_reviews: 15,
                    max_total_non_test_reviews: 30,
                    excluded_review_types: ['test'],
                    auto_split_enabled: false
                }
            }
        );
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true }, { includeDomainScopeFingerprints: true });
        const preflight = JSON.parse(fs.readFileSync(path.join(reviewsRoot(repoRoot), `${TASK_ID}-preflight.json`), 'utf8'));
        const currentCodeScopeSha256 = preflight.metrics.domain_scope_fingerprints.legacy.code_review_scope_sha256;
        const currentReviewScopeSha256 = preflight.metrics.domain_scope_fingerprints.legacy.review_scope_sha256;
        for (let index = 0; index < 48; index += 1) {
            const scopeBucket = index % 20;
            appendEvent(repoRoot, TASK_ID, 'REVIEW_RECORDED', 'FAIL', {
                review_type: 'code',
                reviewer_identity: `agent:t0043-code-${index}`,
                review_context_sha256: sha256Text(`t0043-code-context-${index}`),
                code_scope_sha256: scopeBucket === 0 ? currentCodeScopeSha256 : sha256Text(`t0043-scope-${scopeBucket}`),
                reused_existing_review: [5, 17, 31].includes(index),
                summary: `T-004-3 failed code review attempt ${index}`
            });
        }
        for (let index = 0; index < 6; index += 1) {
            appendEvent(repoRoot, TASK_ID, 'REVIEW_RECORDED', 'FAIL', {
                review_type: 'test',
                reviewer_identity: `agent:t0043-test-${index}`,
                review_context_sha256: sha256Text(`t0043-test-context-${index}`),
                review_scope_sha256: currentReviewScopeSha256,
                summary: `T-004-3 excluded test review attempt ${index}`
            });
        }

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const text = formatNextStepText(result);

        assert.equal(result.next_gate, 'review-cycle-attempt-guard');
        assert.ok(result.reason.includes('failed_non_test_review_count=45>=15'));
        assert.ok(result.reason.includes('total_non_test_review_count=45>30'));
        assert.ok(result.reason.includes('cumulative_total_attempts=54'));
        assert.ok(result.reason.includes('cumulative_non_test_reviews=45'));
        assert.ok(result.reason.includes('current_scope_non_test_reviews=3'));
        assert.ok(result.reason.includes('fresh_non_test_reviews=45'));
        assert.ok(result.reason.includes('reused_non_test_reviews=3'));
        assert.ok(result.reason.includes('fresh_reused_by_type=code:fresh=45,reused=3|test:fresh=6,reused=0'));
        assert.ok(result.reason.includes('top_scope_hashes_by_type=code:unique=20'));
        assert.equal(result.review_cycle_block?.cumulative_total_non_test_review_count, 45);
        assert.equal(result.review_cycle_block?.current_scope_total_non_test_review_count, 3);
        assert.equal(result.review_cycle_block?.fresh_non_test_review_count, 45);
        assert.equal(result.review_cycle_block?.reused_non_test_review_count, 3);
        assert.equal(result.review_cycle_block?.scope_hash_count_by_review_type.code, 20);
        assert.deepEqual(result.review_cycle_block?.current_scope_counts_by_review_type.code, {
            total: 3,
            passed: 0,
            failed: 3,
            pending: 0
        });
        assert.deepEqual(result.review_cycle_block?.counts_by_review_type.code, {
            total: 45,
            passed: 0,
            failed: 45,
            pending: 0
        });
        assert.equal(result.review_cycle_block?.counts_by_review_type.test, undefined);
        assert.equal(result.review_cycle_block?.latest_failed_review?.summary, 'T-004-3 failed code review attempt 47');
        assert.ok(text.includes('ReviewCycleCumulativeCounts: total_non_test_reviews=45; failed_non_test_reviews=45; fresh_non_test_reviews=45; reused_non_test_reviews=3'));
        assert.ok(text.includes('ReviewCycleCurrentScopeCounts: total_non_test_reviews=3; failed_non_test_reviews=3'));
        assert.ok(text.includes('"code": unique=20'));
    });

});
