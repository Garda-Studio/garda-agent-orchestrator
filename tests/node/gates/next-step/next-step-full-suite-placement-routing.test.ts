import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    buildDefaultWorkflowConfig,
    commitGitFixturePaths,
    formatNextStepText,
    getGitFixtureHead,
    getWorkspaceSnapshot,
    recordFullSuiteValidationDuration,
    resolveNextStep,
    type FullSuiteValidationConfig
} from './next-step-test-support';
import {
    TASK_ID,
    NEXT_STEP_FULL_SUITE_TEST_CONFIG,
    ALL_REVIEW_FLAGS,
    makeTempRepo,
    reviewsRoot,
    eventsRoot,
    writeJson,
    fileSha256,
    appendEvent,
    seedStartedTask,
    seedPostPreflightRulePack,
    normalizeForTimeline,
    writePreflight,
    seedCompilePass,
    buildReviewContextScopeFixture,
    writeReviewEvidence,
    seedReviewGatePass,
    seedDocImpactPass,
    seedFullSuiteValidation,
    seedTimedOutFullSuiteFailure,
    seedFullSuiteRetryEvidence,
    seedSplitRequiredLatchEvidence
} from './next-step-full-suite-fixtures';
import {
    buildFullSuiteValidationEvidence
} from '../../../../src/gates/review-context/review-context-validation-evidence';

function appendRepairTaskRow(repoRoot: string, taskId = `${TASK_ID}-F1`): void {
    const taskPath = path.join(repoRoot, 'TASK.md');
    const secondTaskId = `${TASK_ID}-F2`;
    const linkedParent = fs.readFileSync(taskPath, 'utf8')
        .split('\n')
        .map((line) => {
            if (!line.startsWith(`| ${TASK_ID} |`)) {
                return line;
            }
            const cells = line.split('|');
            cells[9] =
                ` Decomposition source: orchestrator (2026-06-30); child tasks: \`${taskId}\`, \`${secondTaskId}\`. `;
            return cells.join('|');
        })
        .join('\n');
    const rows = [
        `| ${taskId} | TODO | P1 | workflow/full-suite-timeout-diagnostics | Diagnose full-suite timeout | gpt-5.5 | 2026-06-30 | strict | Child of \`${TASK_ID}\`. |`,
        `| ${secondTaskId} | TODO | P1 | workflow/full-suite-timeout-repair | Repair full-suite timeout | gpt-5.5 | 2026-06-30 | strict | Child of \`${TASK_ID}\`. |`
    ];
    fs.writeFileSync(taskPath, `${linkedParent}${rows.join('\n')}\n`, 'utf8');
}

function writeCompletedRepairTaskRows(repoRoot: string, childTaskId = `${TASK_ID}-F1`): void {
    const secondChildTaskId = `${TASK_ID}-F2`;
    fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
        '# TASK.md',
        '',
        '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
        '|---|---|---|---|---|---|---|---|---|',
        `| ${TASK_ID} | SPLIT_REQUIRED | P1 | workflow/full-suite-repair-split-suspend | Parent repair task | gpt-5.5 | 2026-06-30 | strict | Decomposition source: orchestrator (2026-06-30); child tasks: \`${childTaskId}\`, \`${secondChildTaskId}\`; parent WIP suspended for full-suite repair. |`,
        `| ${childTaskId} | DONE | P1 | workflow/full-suite-timeout-diagnostics | Diagnose full-suite timeout | gpt-5.5 | 2026-06-30 | strict | Child of \`${TASK_ID}\`. Repair completed. |`,
        `| ${secondChildTaskId} | DONE | P1 | workflow/full-suite-timeout-repair | Repair full-suite timeout | gpt-5.5 | 2026-06-30 | strict | Child of \`${TASK_ID}\`. Repair completed. |`,
        ''
    ].join('\n'), 'utf8');
}

function writeRepairTaskMaterializationEvidence(
    repoRoot: string,
    childTaskId = `${TASK_ID}-F1`,
    status = 'MATERIALIZED'
): void {
    const childTaskIds = [childTaskId, `${TASK_ID}-F2`];
    const preflightPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-preflight.json`);
    const fullSuitePath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-full-suite-validation.json`);
    const createdAtUtc = '2026-06-30T00:00:00.000Z';
    const manifestRoot = path.join(
        repoRoot,
        'garda-agent-orchestrator',
        'runtime',
        'wip',
        TASK_ID,
        'full-suite-repair',
        '2026-06-30T00-00-00-000Z'
    );
    const stagedPatchPath = path.join(manifestRoot, 'staged.patch');
    const unstagedPatchPath = path.join(manifestRoot, 'unstaged.patch');
    fs.mkdirSync(manifestRoot, { recursive: true });
    fs.writeFileSync(stagedPatchPath, '', 'utf8');
    fs.writeFileSync(unstagedPatchPath, '', 'utf8');
    const manifestPath = path.join(manifestRoot, 'manifest.json');
    writeJson(manifestPath, {
        schema_version: 3,
        kind: 'full_suite_repair_wip',
        status: 'suspended',
        task_id: TASK_ID,
        child_task_ids: childTaskIds,
        created_at_utc: createdAtUtc,
        base_commit: getGitFixtureHead(repoRoot),
        preflight_path: normalizeForTimeline(preflightPath),
        preflight_sha256: fileSha256(preflightPath),
        full_suite_artifact_path: normalizeForTimeline(fullSuitePath),
        full_suite_artifact_sha256: fileSha256(fullSuitePath),
        patches: {
            staged: {
                path: normalizeForTimeline(stagedPatchPath),
                sha256: fileSha256(stagedPatchPath),
                bytes: 0,
                empty: true
            },
            unstaged: {
                path: normalizeForTimeline(unstagedPatchPath),
                sha256: fileSha256(unstagedPatchPath),
                bytes: 0,
                empty: true
            }
        },
        tracked_files: [],
        untracked_files: [],
        unrelated_untracked_files: []
    });
    writeJson(path.join(reviewsRoot(repoRoot), `${TASK_ID}-full-suite-repair-task.json`), {
        schema_version: 2,
        status,
        task_id: TASK_ID,
        child_task_ids: childTaskIds,
        created_at_utc: '2026-06-30T00:00:01.000Z',
        preflight_path: normalizeForTimeline(preflightPath),
        preflight_sha256: fileSha256(preflightPath),
        full_suite_artifact_path: normalizeForTimeline(fullSuitePath),
        full_suite_artifact_sha256: fileSha256(fullSuitePath),
        wip_manifest_path: normalizeForTimeline(manifestPath),
        wip_manifest_sha256: fileSha256(manifestPath),
        split_required_artifact_path: normalizeForTimeline(path.join(reviewsRoot(repoRoot), `${TASK_ID}-split-required.json`)),
        task_queue: {
            outcome: 'updated',
            parent_linked: true,
            child_created: true
        },
        violations: []
    });
}

function writeAfterCompileFullSuiteWorkflowConfig(repoRoot: string, command = 'npm test'): void {
    writeJson(path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json'), {
        full_suite_validation: {
            enabled: true,
            command,
            placement: 'after_compile_before_reviews'
        },
        review_execution_policy: {
            mode: 'parallel_all'
        }
    });
}

function writeFullSuiteBoundReviewContext(repoRoot: string, taskId: string, reviewType = 'code'): string {
    const preflightPath = path.join(reviewsRoot(repoRoot), `${taskId}-preflight.json`);
    const preflightSha256 = fileSha256(preflightPath);
    const reviewContextPath = path.join(reviewsRoot(repoRoot), `${taskId}-${reviewType}-review-context.json`);
    writeJson(reviewContextPath, {
        schema_version: 2,
        task_id: taskId,
        review_type: reviewType,
        preflight_path: normalizeForTimeline(preflightPath),
        preflight_sha256: preflightSha256,
        ...buildReviewContextScopeFixture(repoRoot, taskId, reviewType),
        full_suite_validation: buildFullSuiteValidationEvidence({
            repoRoot,
            taskId,
            reviewType,
            preflightPath,
            preflightSha256
        }),
        reviewer_routing: {
            actual_execution_mode: 'delegated_subagent',
            reviewer_session_id: `agent:${reviewType}-reviewer`
        }
    });
    return reviewContextPath;
}

describe('gates/next-step', () => {
    it('runs enabled full-suite validation before launching mandatory test review', () => {

        const repoRoot = makeTempRepo();

        writeJson(path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json'), {

            full_suite_validation: {

                enabled: true,

                command: 'npm test',

                placement: 'before_test_review'

            },

            review_execution_policy: {

                mode: 'code_first_optional'

            }

        });

        seedStartedTask(repoRoot, TASK_ID);

        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true, test: true });

        seedCompilePass(repoRoot, TASK_ID);

        writeReviewEvidence(repoRoot, TASK_ID, 'code');



        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });



        assert.equal(result.next_gate, 'full-suite-validation');

        assert.equal(result.review.next_review_type, 'test', result.reason);

        assert.match(result.title, /before test review/);

        assert.ok(result.commands[0].command.includes('gate full-suite-validation'));

        assert.ok(!result.commands[0].command.includes('--review-type "test"'));

    });



    it('runs after-compile full-suite validation before launching any reviewer', () => {

        const repoRoot = makeTempRepo();

        writeJson(path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json'), {

            full_suite_validation: {

                enabled: true,

                command: 'npm run test:sharded',

                placement: 'after_compile_before_reviews'

            },

            review_execution_policy: {

                mode: 'parallel_all'

            }

        });

        seedStartedTask(repoRoot, TASK_ID);

        writePreflight(repoRoot, TASK_ID, {

            ...ALL_REVIEW_FLAGS,

            code: true,

            security: true,

            test: true

        }, { reviewPolicyMode: 'parallel_all' });

        seedCompilePass(repoRoot, TASK_ID);



        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        const text = formatNextStepText(result);



        assert.equal(result.next_gate, 'full-suite-validation');

        assert.equal(result.full_suite_validation.placement, 'after_compile_before_reviews');

        assert.match(result.title, /after compile before reviews/);

        assert.ok(result.commands[0].command.includes('gate full-suite-validation'));

        assert.ok(!result.commands[0].command.includes('build-review-context'));

        assert.ok(text.includes('FullSuite: enabled=true; placement=after_compile_before_reviews;'));
        assert.ok(text.includes('FullSuitePerformance: mode=optimized_sharded; optimized=true; boundary=mandatory_full_suite_not_smoke_or_fast; optimized_command="npm run test:sharded"'));
        assert.doesNotMatch(text, /fallback_command=/u);

    });

    it('rebuilds stale review context built before the latest after-compile full-suite pass', () => {

        const repoRoot = makeTempRepo();

        writeAfterCompileFullSuiteWorkflowConfig(repoRoot);

        seedStartedTask(repoRoot, TASK_ID);

        writePreflight(repoRoot, TASK_ID, {

            ...ALL_REVIEW_FLAGS,

            code: true,

            security: true,

            test: true

        }, { reviewPolicyMode: 'parallel_all' });

        seedCompilePass(repoRoot, TASK_ID);

        writeFullSuiteBoundReviewContext(repoRoot, TASK_ID, 'code');

        seedFullSuiteValidation(repoRoot, TASK_ID, 'PASSED');



        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });



        assert.equal(result.next_gate, 'build-review-context');

        assert.equal(result.review.next_review_type, 'code');

        assert.match(result.reason, /review context full-suite validation binding is stale/);

        assert.match(result.reason, /full-suite-validation\.json/);

        assert.ok(result.commands[0].command.includes('gate build-review-context'));

        assert.ok(result.commands[0].command.includes('--review-type "code"'));

    });

    it('rebuilds legacy schema-1 review context missing required after-compile full-suite binding', () => {

        const repoRoot = makeTempRepo();

        writeAfterCompileFullSuiteWorkflowConfig(repoRoot);

        seedStartedTask(repoRoot, TASK_ID);

        writePreflight(repoRoot, TASK_ID, {

            ...ALL_REVIEW_FLAGS,

            code: true,

            security: true,

            test: true

        }, { reviewPolicyMode: 'parallel_all' });

        seedCompilePass(repoRoot, TASK_ID);

        seedFullSuiteValidation(repoRoot, TASK_ID, 'PASSED');

        const reviewContextPath = writeFullSuiteBoundReviewContext(repoRoot, TASK_ID, 'code');

        const reviewContext = JSON.parse(fs.readFileSync(reviewContextPath, 'utf8')) as Record<string, unknown>;

        reviewContext.schema_version = 1;

        delete reviewContext.full_suite_validation;

        writeJson(reviewContextPath, reviewContext);



        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });



        assert.equal(result.next_gate, 'build-review-context');

        assert.equal(result.review.next_review_type, 'code');

        assert.match(result.reason, /review-context artifact is stale/);

        assert.match(result.reason, /full-suite validation binding is missing/);

        assert.ok(result.commands[0].command.includes('gate build-review-context'));

    });

    it('launches reviewer routing without rebuilding when review context is bound to current after-compile full-suite evidence', () => {

        const repoRoot = makeTempRepo();

        writeAfterCompileFullSuiteWorkflowConfig(repoRoot);

        seedStartedTask(repoRoot, TASK_ID);

        writePreflight(repoRoot, TASK_ID, {

            ...ALL_REVIEW_FLAGS,

            code: true,

            security: true,

            test: true

        }, { reviewPolicyMode: 'parallel_all' });

        seedCompilePass(repoRoot, TASK_ID);

        seedFullSuiteValidation(repoRoot, TASK_ID, 'PASSED');

        writeFullSuiteBoundReviewContext(repoRoot, TASK_ID, 'code');



        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });



        assert.equal(result.next_gate, 'record-review-routing');

        assert.equal(result.review.next_review_type, 'code');

        assert.doesNotMatch(result.reason, /full-suite validation binding is stale/);

        assert.ok(result.commands[0].command.includes('gate record-review-routing'));

        assert.ok(!result.commands[0].command.includes('build-review-context'));

    });

    it('reruns after-compile full-suite when workflow config command changes after evidence was recorded', () => {

        const repoRoot = makeTempRepo();

        writeAfterCompileFullSuiteWorkflowConfig(repoRoot, 'npm test');

        seedStartedTask(repoRoot, TASK_ID);

        writePreflight(repoRoot, TASK_ID, {

            ...ALL_REVIEW_FLAGS,

            code: true,

            security: true,

            test: true

        }, { reviewPolicyMode: 'parallel_all' });

        seedCompilePass(repoRoot, TASK_ID);

        seedFullSuiteValidation(repoRoot, TASK_ID, 'PASSED');

        writeFullSuiteBoundReviewContext(repoRoot, TASK_ID, 'code');

        writeAfterCompileFullSuiteWorkflowConfig(repoRoot, 'npm run test:changed');
        commitGitFixturePaths(repoRoot, ['garda-agent-orchestrator/live/config/workflow-config.json']);



        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });



        assert.equal(result.next_gate, 'full-suite-validation');

        assert.match(result.title, /after compile before reviews/);

        assert.ok(result.commands[0].command.includes('gate full-suite-validation'));

        assert.ok(result.commands[0].command.includes('--preflight-path'));

        assert.ok(!result.commands[0].command.includes('build-review-context'));

    });

    it('reruns after-compile full-suite when workflow config command changes after failed evidence was recorded', () => {

        const repoRoot = makeTempRepo();

        writeAfterCompileFullSuiteWorkflowConfig(repoRoot, 'npm test');

        seedStartedTask(repoRoot, TASK_ID);

        writePreflight(repoRoot, TASK_ID, {

            ...ALL_REVIEW_FLAGS,

            code: true,

            security: true,

            test: true

        }, { reviewPolicyMode: 'parallel_all' });

        seedCompilePass(repoRoot, TASK_ID);

        seedFullSuiteValidation(repoRoot, TASK_ID, 'FAILED');

        writeAfterCompileFullSuiteWorkflowConfig(repoRoot, 'npm run test:changed');
        commitGitFixturePaths(repoRoot, ['garda-agent-orchestrator/live/config/workflow-config.json']);



        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });



        assert.equal(result.next_gate, 'full-suite-validation');

        assert.match(result.title, /after compile before reviews/);

        assert.ok(result.commands[0].command.includes('gate full-suite-validation'));

        assert.ok(result.commands[0].command.includes('--preflight-path'));

        assert.ok(!result.commands[0].command.includes('implementation'));

        assert.ok(!result.reason.includes('already failed for the current compiled scope'));

    });

    it('keeps the frozen before-test placement when live workflow config placement changes', () => {

        const repoRoot = makeTempRepo();

        writeJson(path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json'), {

            full_suite_validation: {

                enabled: true,

                command: 'npm test',

                placement: 'before_test_review'

            },

            review_execution_policy: {

                mode: 'parallel_all'

            }

        });

        seedStartedTask(repoRoot, TASK_ID);

        writePreflight(repoRoot, TASK_ID, {

            ...ALL_REVIEW_FLAGS,

            code: true,

            security: true,

            test: true

        }, { reviewPolicyMode: 'parallel_all' });

        seedCompilePass(repoRoot, TASK_ID);

        seedFullSuiteValidation(repoRoot, TASK_ID, 'PASSED');

        writeFullSuiteBoundReviewContext(repoRoot, TASK_ID, 'code');

        writeAfterCompileFullSuiteWorkflowConfig(repoRoot, 'npm test');
        commitGitFixturePaths(repoRoot, ['garda-agent-orchestrator/live/config/workflow-config.json']);



        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });



        assert.equal(result.next_gate, 'build-review-context');

        assert.ok(result.commands[0].command.includes('--review-type "code"'));

        assert.ok(!result.commands[0].command.includes('gate full-suite-validation'));

    });

    it('rebuilds review context when workflow config placement changes from after-compile to before-completion', () => {

        const repoRoot = makeTempRepo();

        writeAfterCompileFullSuiteWorkflowConfig(repoRoot, 'npm test');

        seedStartedTask(repoRoot, TASK_ID);

        writePreflight(repoRoot, TASK_ID, {

            ...ALL_REVIEW_FLAGS,

            code: true,

            security: true,

            test: true

        }, { reviewPolicyMode: 'parallel_all' });

        seedCompilePass(repoRoot, TASK_ID);

        seedFullSuiteValidation(repoRoot, TASK_ID, 'PASSED');

        writeFullSuiteBoundReviewContext(repoRoot, TASK_ID, 'code');

        writeJson(path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json'), {

            full_suite_validation: {

                enabled: true,

                command: 'npm test',

                placement: 'before_completion'

            },

            review_execution_policy: {

                mode: 'parallel_all'

            }

        });
        commitGitFixturePaths(repoRoot, ['garda-agent-orchestrator/live/config/workflow-config.json']);



        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });



        assert.equal(result.next_gate, 'build-review-context');

        assert.equal(result.review.next_review_type, 'code');

        assert.match(result.reason, /full-suite validation binding is stale/);

        assert.match(result.reason, /workflow-config placement 'before_completion'/);

        assert.ok(result.commands[0].command.includes('gate build-review-context'));

    });

    it('routes dead stale run markers directly to confirmed cleanup before starting a fresh full-suite run', () => {

        const repoRoot = makeTempRepo();

        writeJson(path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json'), {

            full_suite_validation: {

                enabled: true,

                command: 'npm run test:sharded',

                placement: 'after_compile_before_reviews'

            },

            review_execution_policy: {

                mode: 'parallel_all'

            }

        });

        seedStartedTask(repoRoot, TASK_ID);

        writePreflight(repoRoot, TASK_ID, {

            ...ALL_REVIEW_FLAGS,

            code: true,

            security: true,

            test: true

        }, { reviewPolicyMode: 'parallel_all' });

        seedCompilePass(repoRoot, TASK_ID);

        const preflightPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-preflight.json`);
        const markerPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-full-suite-run-marker.json`);
        fs.writeFileSync(markerPath, `${JSON.stringify({
            schema_version: 1,
            task_id: TASK_ID,
            status: 'running',
            started_at_utc: '2026-06-07T01:01:00.000Z',
            updated_at_utc: '2026-06-07T01:01:00.000Z',
            repo_root: repoRoot,
            cwd: repoRoot,
            command: 'npm run test:sharded',
            timeout_ms: 600000,
            gate_pid: 999999,
            child_pid: null,
            child_command: null,
            child_args: [],
            child_shell: null,
            preflight_path: preflightPath,
            preflight_sha256: '0'.repeat(64),
            cycle_binding: {
                task_id: TASK_ID,
                preflight_path: preflightPath,
                preflight_sha256: '0'.repeat(64),
                compile_gate_timestamp: null,
                scope_binding: null
            }
        }, null, 2)}\n`, 'utf8');

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'full-suite-validation');
        assert.match(result.title, /Recover interrupted full-suite validation run/);
        assert.match(result.reason, /marker is stale for the current cycle/);
        assert.match(result.reason, /preflight_sha256 mismatch/);
        assert.ok(result.commands[0].command.includes('gate full-suite-run-marker-recovery'));
        assert.ok(!result.commands[0].command.includes('--clear-dead-marker'));
        assert.ok(!result.commands[0].command.includes('--operator-confirmed yes'));
        assert.ok(!result.commands[0].command.includes('gate full-suite-validation'));
    });



    it('blocks reviewer launch after current after-compile full-suite failure', () => {

        const repoRoot = makeTempRepo();

        writeJson(path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json'), {

            full_suite_validation: {

                enabled: true,

                command: 'npm test',

                placement: 'after_compile_before_reviews'

            },

            review_execution_policy: {

                mode: 'parallel_all'

            }

        });

        seedStartedTask(repoRoot, TASK_ID);

        writePreflight(repoRoot, TASK_ID, {

            ...ALL_REVIEW_FLAGS,

            code: true,

            security: true,

            test: true

        }, { reviewPolicyMode: 'parallel_all' });

        seedCompilePass(repoRoot, TASK_ID);

        seedFullSuiteValidation(repoRoot, TASK_ID, 'FAILED');



        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });



        assert.equal(result.next_gate, 'implementation');

        assert.match(result.title, /Fix full-suite failures/);

        assert.ok(!result.commands[0].command.includes('build-review-context'));

        assert.ok(!result.commands[0].command.includes('--review-type'));

    });

    it('blocks reviewer launch with a repair-task proposal after exhausted full-suite timeout blocker', () => {

        const repoRoot = makeTempRepo();

        writeJson(path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json'), {

            full_suite_validation: {

                enabled: true,

                command: 'npm test',

                placement: 'after_compile_before_reviews'

            },

            review_execution_policy: {

                mode: 'parallel_all'

            }

        });

        seedStartedTask(repoRoot, TASK_ID);

        writePreflight(repoRoot, TASK_ID, {

            ...ALL_REVIEW_FLAGS,

            code: true,

            test: true

        }, { reviewPolicyMode: 'parallel_all' });

        seedCompilePass(repoRoot, TASK_ID);

        seedFullSuiteValidation(repoRoot, TASK_ID, 'FAILED');

        const fullSuitePath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-full-suite-validation.json`);
        const artifact = JSON.parse(fs.readFileSync(fullSuitePath, 'utf8')) as Record<string, unknown>;
        artifact.timed_out = true;
        artifact.timeout_policy = {
            timeout_blocker: true,
            timeout_retry_count: 1,
            max_attempts: 2,
            attempts: [
                { attempt: 1, exit_code: 1, timed_out: true },
                { attempt: 2, exit_code: 1, timed_out: true }
            ],
            attempts_exhausted: true,
            warning_only_continuation: false,
            repair_task_proposal: {
                suggested_task_id: `${TASK_ID}-F1`,
                title: 'Fix full-suite timeout blocker',
                area: 'workflow/full-suite-timeout',
                rationale: 'Full-suite validation timed out after configured retries.'
            }
        };
        writeJson(fullSuitePath, artifact);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'full-suite-timeout-repair-task');

        assert.match(result.title, /repair task handoff/i);

        assert.match(result.reason, new RegExp(`${TASK_ID}-F1`));

        assert.ok(!result.commands[0].command.includes('build-review-context'));

        assert.ok(!result.commands[0].command.includes('--review-type'));

        assert.ok(result.commands[0].command.includes('gate materialize-full-suite-repair-task'));

    });

    it('blocks reviewer launch until an exhausted WARNED full-suite timeout repair task is materialized', () => {

        const repoRoot = makeTempRepo();

        writeJson(path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json'), {

            full_suite_validation: {

                enabled: true,

                command: 'npm test',

                placement: 'after_compile_before_reviews'

            },

            review_execution_policy: {

                mode: 'parallel_all'

            }

        });

        seedStartedTask(repoRoot, TASK_ID);

        writePreflight(repoRoot, TASK_ID, {

            ...ALL_REVIEW_FLAGS,

            code: true,

            test: true

        }, { reviewPolicyMode: 'parallel_all' });

        seedCompilePass(repoRoot, TASK_ID);

        const timelinePath = path.join(eventsRoot(repoRoot), `${TASK_ID}.jsonl`);
        const timelineEvents = fs.readFileSync(timelinePath, 'utf8')
            .split('\n')
            .filter((line) => line.trim())
            .map((line) => JSON.parse(line) as Record<string, unknown>);
        const latestCompile = [...timelineEvents]
            .reverse()
            .find((event) => event.event_type === 'COMPILE_GATE_PASSED');
        const preflightPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-preflight.json`);
        const cycleBinding = {
            task_id: TASK_ID,
            preflight_path: normalizeForTimeline(preflightPath),
            preflight_sha256: fileSha256(preflightPath),
            compile_gate_timestamp: String(latestCompile?.timestamp_utc || '')
        };
        const timeoutPolicy = {
            timeout_blocker: true,
            timeout_retry_count: 1,
            max_attempts: 2,
            attempts: [
                { attempt: 1, exit_code: 1, timed_out: true },
                { attempt: 2, exit_code: 1, timed_out: true }
            ],
            attempts_exhausted: true,
            warning_only_continuation: false,
            repair_task_proposal: {
                suggested_task_id: `${TASK_ID}-F1`,
                title: 'Fix full-suite timeout blocker',
                area: 'workflow/full-suite-timeout',
                rationale: 'Full-suite validation timed out after configured retries.'
            }
        };
        writeJson(path.join(reviewsRoot(repoRoot), `${TASK_ID}-full-suite-validation.json`), {
            task_id: TASK_ID,
            status: 'WARNED',
            enabled: true,
            command: 'npm test',
            placement: 'after_compile_before_reviews',
            exit_code: 1,
            timed_out: true,
            cycle_binding: cycleBinding,
            timeout_policy: timeoutPolicy,
            output_artifact_path: path.join(reviewsRoot(repoRoot), `${TASK_ID}-full-suite-output.log`)
        });
        appendEvent(repoRoot, TASK_ID, 'FULL_SUITE_VALIDATION_WARNED', 'WARN', {
            cycle_binding: cycleBinding,
            timeout_policy: timeoutPolicy
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'full-suite-timeout-repair-task');

        assert.match(result.reason, new RegExp(`${TASK_ID}-F1`));

        assert.ok(!result.commands[0].command.includes('build-review-context'));

        assert.ok(!result.commands[0].command.includes('--review-type'));

        appendRepairTaskRow(repoRoot);

        const afterRepairTask = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(afterRepairTask.next_gate, 'full-suite-timeout-repair-task', afterRepairTask.reason);

        writeRepairTaskMaterializationEvidence(repoRoot, `${TASK_ID}-F1`, 'BLOCKED');

        const afterBlockedArtifact = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(afterBlockedArtifact.next_gate, 'full-suite-timeout-repair-task', afterBlockedArtifact.reason);

        writeRepairTaskMaterializationEvidence(repoRoot);

        const afterMaterializationArtifact = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(afterMaterializationArtifact.next_gate, 'build-review-context', afterMaterializationArtifact.reason);

        assert.ok(afterMaterializationArtifact.commands[0].command.includes('--review-type "code"'), afterMaterializationArtifact.commands[0].command);

    });

    it('routes completed full-suite repair child to restore suspended parent WIP before closing the parent', () => {
        const repoRoot = makeTempRepo();

        writeJson(path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json'), {
            ...buildDefaultWorkflowConfig(),
            full_suite_validation: {
                ...NEXT_STEP_FULL_SUITE_TEST_CONFIG,
                placement: 'after_compile_before_reviews'
            },
            review_execution_policy: {
                mode: 'strict_sequential'
            }
        });
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, {
            ...ALL_REVIEW_FLAGS,
            code: true,
            test: true
        });
        seedCompilePass(repoRoot, TASK_ID);
        seedFullSuiteValidation(repoRoot, TASK_ID);
        writeRepairTaskMaterializationEvidence(repoRoot);
        writeCompletedRepairTaskRows(repoRoot);
        seedSplitRequiredLatchEvidence(repoRoot, TASK_ID);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.status, 'BLOCKED');
        assert.equal(result.next_gate, 'restore-full-suite-repair-wip', result.reason);
        assert.match(result.reason, /All linked full-suite repair children are DONE/);
        assert.ok(result.commands.some((command) => command.command.includes('restore-full-suite-repair-wip')));
        assert.ok(result.commands.some((command) => command.command.includes('--dry-run')));
        assert.ok(result.commands.every((command) => command.command.includes(`--task-id "${TASK_ID}"`)));
        assert.ok(result.commands.every((command) => !command.command.includes('--child-task-id')));
        assert.ok(result.commands.every((command) => command.command.includes(`${TASK_ID}-full-suite-validation.json`)));
        const formatted = formatNextStepText(result);
        assert.match(formatted, /Command: none/);
        assert.match(formatted, /CommandReference: choose one of the 2 Commands entries below/);
        assert.doesNotMatch(formatted, /Command: inspect diagnostics; no executable command is available/);
        assert.ok(!result.reason.includes('completed because all explicit children are DONE'));

        const secondChildTaskId = `${TASK_ID}-F2`;
        const taskPath = path.join(repoRoot, 'TASK.md');
        const duplicateScopeTaskQueue = fs.readFileSync(taskPath, 'utf8').replace(
            `| ${secondChildTaskId} | DONE | P1 | workflow/full-suite-timeout-repair | Repair full-suite timeout |`,
            `| ${secondChildTaskId} | DONE | P1 | workflow/full-suite-timeout-diagnostics | Diagnose full-suite timeout |`
        );
        fs.writeFileSync(taskPath, duplicateScopeTaskQueue, 'utf8');

        const invalidDecompositionResult = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.notEqual(invalidDecompositionResult.next_gate, 'restore-full-suite-repair-wip');
        assert.ok(
            invalidDecompositionResult.commands.every(
                (command) => !command.command.includes('restore-full-suite-repair-wip')
            )
        );
    });

    it('accepts current warning-only full-suite timeout evidence and continues to reviewer launch', () => {

        const repoRoot = makeTempRepo();

        writeJson(path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json'), {

            full_suite_validation: {

                enabled: true,

                command: 'npm test',

                placement: 'after_compile_before_reviews'

            },

            review_execution_policy: {

                mode: 'parallel_all'

            }

        });

        seedStartedTask(repoRoot, TASK_ID);

        writePreflight(repoRoot, TASK_ID, {

            ...ALL_REVIEW_FLAGS,

            code: true,

            test: true

        }, { reviewPolicyMode: 'parallel_all' });

        seedCompilePass(repoRoot, TASK_ID);

        const timelinePath = path.join(eventsRoot(repoRoot), `${TASK_ID}.jsonl`);
        const timelineEvents = fs.readFileSync(timelinePath, 'utf8')
            .split('\n')
            .filter((line) => line.trim())
            .map((line) => JSON.parse(line) as Record<string, unknown>);
        const latestCompile = [...timelineEvents]
            .reverse()
            .find((event) => event.event_type === 'COMPILE_GATE_PASSED');
        const preflightPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-preflight.json`);
        const cycleBinding = {
            task_id: TASK_ID,
            preflight_path: normalizeForTimeline(preflightPath),
            preflight_sha256: fileSha256(preflightPath),
            compile_gate_timestamp: String(latestCompile?.timestamp_utc || '')
        };
        writeJson(path.join(reviewsRoot(repoRoot), `${TASK_ID}-full-suite-validation.json`), {
            task_id: TASK_ID,
            status: 'WARNED',
            enabled: true,
            command: 'npm test',
            placement: 'after_compile_before_reviews',
            exit_code: 1,
            timed_out: true,
            cycle_binding: cycleBinding,
            output_artifact_path: path.join(reviewsRoot(repoRoot), `${TASK_ID}-full-suite-output.log`),
            timeout_policy: {
                timeout_blocker: false,
                timeout_retry_count: 0,
                max_attempts: 1,
                attempts: [
                    { attempt: 1, exit_code: 1, timed_out: true }
                ],
                attempts_exhausted: true,
                warning_only_continuation: true,
                repair_task_proposal: null
            }
        });
        appendEvent(repoRoot, TASK_ID, 'FULL_SUITE_VALIDATION_WARNED', 'WARN', {
            cycle_binding: cycleBinding,
            timeout_policy: {
                timeout_blocker: false,
                warning_only_continuation: true
            }
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.notEqual(result.next_gate, 'full-suite-validation', result.reason);

        assert.ok(result.commands[0].command.includes('build-review-context'), result.reason);

        assert.ok(result.commands[0].command.includes('--review-type "code"'), result.commands[0].command);

    });

    it('does not accept warning-only timeout artifacts without durable lifecycle warning evidence', () => {

        const repoRoot = makeTempRepo();

        writeJson(path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json'), {

            full_suite_validation: {

                enabled: true,

                command: 'npm test',

                placement: 'after_compile_before_reviews'

            },

            review_execution_policy: {

                mode: 'parallel_all'

            }

        });

        seedStartedTask(repoRoot, TASK_ID);

        writePreflight(repoRoot, TASK_ID, {

            ...ALL_REVIEW_FLAGS,

            code: true,

            test: true

        }, { reviewPolicyMode: 'parallel_all' });

        seedCompilePass(repoRoot, TASK_ID);

        const timelinePath = path.join(eventsRoot(repoRoot), `${TASK_ID}.jsonl`);
        const timelineEvents = fs.readFileSync(timelinePath, 'utf8')
            .split('\n')
            .filter((line) => line.trim())
            .map((line) => JSON.parse(line) as Record<string, unknown>);
        const latestCompile = [...timelineEvents]
            .reverse()
            .find((event) => event.event_type === 'COMPILE_GATE_PASSED');
        const preflightPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-preflight.json`);
        const cycleBinding = {
            task_id: TASK_ID,
            preflight_path: normalizeForTimeline(preflightPath),
            preflight_sha256: fileSha256(preflightPath),
            compile_gate_timestamp: String(latestCompile?.timestamp_utc || '')
        };
        writeJson(path.join(reviewsRoot(repoRoot), `${TASK_ID}-full-suite-validation.json`), {
            task_id: TASK_ID,
            status: 'WARNED',
            enabled: true,
            command: 'npm test',
            placement: 'after_compile_before_reviews',
            exit_code: 1,
            timed_out: true,
            cycle_binding: cycleBinding,
            output_artifact_path: path.join(reviewsRoot(repoRoot), `${TASK_ID}-full-suite-output.log`),
            timeout_policy: {
                timeout_blocker: false,
                timeout_retry_count: 0,
                max_attempts: 1,
                attempts: [
                    { attempt: 1, exit_code: 1, timed_out: true }
                ],
                attempts_exhausted: true,
                warning_only_continuation: true,
                repair_task_proposal: null
            }
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'full-suite-validation');

        assert.match(result.title, /Run full-suite validation/);

        assert.ok(result.commands[0].command.includes('gate full-suite-validation'));

        assert.ok(!result.commands[0].command.includes('build-review-context'));

    });

    it('does not accept warning-only timeout artifacts when durable lifecycle warning omits timeout policy', () => {

        const repoRoot = makeTempRepo();

        writeJson(path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json'), {

            full_suite_validation: {

                enabled: true,

                command: 'npm test',

                placement: 'after_compile_before_reviews'

            },

            review_execution_policy: {

                mode: 'parallel_all'

            }

        });

        seedStartedTask(repoRoot, TASK_ID);

        writePreflight(repoRoot, TASK_ID, {

            ...ALL_REVIEW_FLAGS,

            code: true,

            test: true

        }, { reviewPolicyMode: 'parallel_all' });

        seedCompilePass(repoRoot, TASK_ID);

        const timelinePath = path.join(eventsRoot(repoRoot), `${TASK_ID}.jsonl`);
        const timelineEvents = fs.readFileSync(timelinePath, 'utf8')
            .split('\n')
            .filter((line) => line.trim())
            .map((line) => JSON.parse(line) as Record<string, unknown>);
        const latestCompile = [...timelineEvents]
            .reverse()
            .find((event) => event.event_type === 'COMPILE_GATE_PASSED');
        const preflightPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-preflight.json`);
        const cycleBinding = {
            task_id: TASK_ID,
            preflight_path: normalizeForTimeline(preflightPath),
            preflight_sha256: fileSha256(preflightPath),
            compile_gate_timestamp: String(latestCompile?.timestamp_utc || '')
        };
        writeJson(path.join(reviewsRoot(repoRoot), `${TASK_ID}-full-suite-validation.json`), {
            task_id: TASK_ID,
            status: 'WARNED',
            enabled: true,
            command: 'npm test',
            placement: 'after_compile_before_reviews',
            exit_code: 1,
            timed_out: true,
            cycle_binding: cycleBinding,
            output_artifact_path: path.join(reviewsRoot(repoRoot), `${TASK_ID}-full-suite-output.log`),
            timeout_policy: {
                timeout_blocker: false,
                timeout_retry_count: 0,
                max_attempts: 1,
                attempts: [
                    { attempt: 1, exit_code: 1, timed_out: true }
                ],
                attempts_exhausted: true,
                warning_only_continuation: true,
                repair_task_proposal: null
            }
        });
        appendEvent(repoRoot, TASK_ID, 'FULL_SUITE_VALIDATION_WARNED', 'WARN', {
            cycle_binding: cycleBinding
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'full-suite-validation');

        assert.match(result.title, /Run full-suite validation/);

        assert.ok(result.commands[0].command.includes('gate full-suite-validation'));

        assert.ok(!result.commands[0].command.includes('build-review-context'));

    });

    it('does not accept timed-out WARNED lifecycle evidence without explicit timeout policy metadata', () => {

        const repoRoot = makeTempRepo();

        writeJson(path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json'), {

            full_suite_validation: {

                enabled: true,

                command: 'npm test',

                placement: 'after_compile_before_reviews'

            },

            review_execution_policy: {

                mode: 'parallel_all'

            }

        });

        seedStartedTask(repoRoot, TASK_ID);

        writePreflight(repoRoot, TASK_ID, {

            ...ALL_REVIEW_FLAGS,

            code: true,

            test: true

        }, { reviewPolicyMode: 'parallel_all' });

        seedCompilePass(repoRoot, TASK_ID);

        const timelinePath = path.join(eventsRoot(repoRoot), `${TASK_ID}.jsonl`);
        const timelineEvents = fs.readFileSync(timelinePath, 'utf8')
            .split('\n')
            .filter((line) => line.trim())
            .map((line) => JSON.parse(line) as Record<string, unknown>);
        const latestCompile = [...timelineEvents]
            .reverse()
            .find((event) => event.event_type === 'COMPILE_GATE_PASSED');
        const preflightPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-preflight.json`);
        const cycleBinding = {
            task_id: TASK_ID,
            preflight_path: normalizeForTimeline(preflightPath),
            preflight_sha256: fileSha256(preflightPath),
            compile_gate_timestamp: String(latestCompile?.timestamp_utc || '')
        };
        writeJson(path.join(reviewsRoot(repoRoot), `${TASK_ID}-full-suite-validation.json`), {
            task_id: TASK_ID,
            status: 'WARNED',
            enabled: true,
            command: 'npm test',
            placement: 'after_compile_before_reviews',
            exit_code: 1,
            timed_out: true,
            cycle_binding: cycleBinding,
            output_artifact_path: path.join(reviewsRoot(repoRoot), `${TASK_ID}-full-suite-output.log`)
        });
        appendEvent(repoRoot, TASK_ID, 'FULL_SUITE_VALIDATION_WARNED', 'WARN', {
            cycle_binding: cycleBinding
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'full-suite-validation');

        assert.match(result.title, /Run full-suite validation/);

        assert.ok(result.commands[0].command.includes('gate full-suite-validation'));

        assert.ok(!result.commands[0].command.includes('build-review-context'));

    });

    it('routes targeted diagnostic pass after failed full-suite to mandatory full-suite retry', () => {

        const repoRoot = makeTempRepo();

        writeJson(path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json'), {

            full_suite_validation: {

                enabled: true,

                command: 'npm test',

                placement: 'after_compile_before_reviews'

            },

            review_execution_policy: {

                mode: 'parallel_all'

            }

        });

        seedStartedTask(repoRoot, TASK_ID);

        writePreflight(repoRoot, TASK_ID, {

            ...ALL_REVIEW_FLAGS,

            code: true,

            security: true,

            test: true

        }, { reviewPolicyMode: 'parallel_all' });

        seedCompilePass(repoRoot, TASK_ID);

        seedFullSuiteValidation(repoRoot, TASK_ID, 'FAILED');

        const diagnosticArtifactPath = path.join(
            reviewsRoot(repoRoot),
            `${TASK_ID}-intermediate-command-targeted-test-diagnostic.json`
        );
        writeJson(diagnosticArtifactPath, {
            task_id: TASK_ID,
            command_source: 'targeted-test',
            command: 'npm test -- tests/node/gates/next-step/next-step-full-suite-placement-routing.test.ts',
            status: 'PASSED',
            exit_code: 0
        });
        appendEvent(repoRoot, TASK_ID, 'INTERMEDIATE_COMMAND_RUN', 'PASSED', {
            command_source: 'targeted-test',
            command: 'npm test -- tests/node/gates/next-step/next-step-full-suite-placement-routing.test.ts',
            artifact_path: normalizeForTimeline(diagnosticArtifactPath),
            exit_code: 0
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'full-suite-validation');

        assert.match(result.title, /targeted diagnostics/);

        assert.match(result.reason, /Targeted diagnostics are recovery guidance only/);

        assert.match(result.reason, /intermediate-command-targeted-test-diagnostic\.json/);

        assert.ok(result.commands[0].command.includes('gate full-suite-validation'));

        assert.ok(!result.commands[0].command.includes('build-review-context'));

        assert.ok(!result.commands[0].command.includes('--review-type'));

    });



    it('retries after-compile full-suite when focused transient evidence is bound to the current failure', () => {

        const repoRoot = makeTempRepo();

        writeJson(path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json'), {

            full_suite_validation: {

                enabled: true,

                command: 'npm test',

                placement: 'after_compile_before_reviews'

            },

            review_execution_policy: {

                mode: 'parallel_all'

            }

        });

        seedStartedTask(repoRoot, TASK_ID);

        writePreflight(repoRoot, TASK_ID, {

            ...ALL_REVIEW_FLAGS,

            code: true,

            security: true,

            test: true

        }, { reviewPolicyMode: 'parallel_all' });

        seedCompilePass(repoRoot, TASK_ID);

        seedFullSuiteValidation(repoRoot, TASK_ID, 'FAILED');

        seedFullSuiteRetryEvidence(repoRoot, TASK_ID, 'transient');



        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });



        assert.equal(result.next_gate, 'full-suite-validation');

        assert.match(result.title, /focused transient evidence/);

        assert.match(result.reason, /manual-validation\/T-NEXT-1\/full-suite-retry-evidence\.json/);

        assert.match(result.reason, /does not replace mandatory full-suite evidence/);

        assert.ok(result.commands[0].command.includes('gate full-suite-validation'));

        assert.ok(!result.commands[0].command.includes('build-review-context'));

        assert.ok(!result.commands[0].command.includes('--review-type'));

    });



    it('rejects malformed focused retry evidence instead of coercing exit code to success', () => {

        const repoRoot = makeTempRepo();

        writeJson(path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json'), {

            full_suite_validation: {

                enabled: true,

                command: 'npm test',

                placement: 'after_compile_before_reviews'

            },

            review_execution_policy: {

                mode: 'parallel_all'

            }

        });

        seedStartedTask(repoRoot, TASK_ID);

        writePreflight(repoRoot, TASK_ID, {

            ...ALL_REVIEW_FLAGS,

            code: true,

            security: true,

            test: true

        }, { reviewPolicyMode: 'parallel_all' });

        seedCompilePass(repoRoot, TASK_ID);

        seedFullSuiteValidation(repoRoot, TASK_ID, 'FAILED');

        seedFullSuiteRetryEvidence(repoRoot, TASK_ID, 'transient', {

            command: 'npm test -- tests/node/gates/next-step/next-step-full-suite-routing.test.ts',

            exit_code: null,

            status: 'FAILED'

        });



        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });



        assert.equal(result.next_gate, 'implementation');

        assert.match(result.title, /Fix full-suite failures/);

        assert.doesNotMatch(result.title, /focused transient evidence/);

        assert.doesNotMatch(result.reason, /full-suite-retry-evidence/);

        assert.ok(!result.commands[0].command.includes('build-review-context'));

    });



    it('rejects contradictory focused retry evidence with pass status and nonzero exit code', () => {

        const repoRoot = makeTempRepo();

        writeJson(path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json'), {

            full_suite_validation: {

                enabled: true,

                command: 'npm test',

                placement: 'after_compile_before_reviews'

            },

            review_execution_policy: {

                mode: 'parallel_all'

            }

        });

        seedStartedTask(repoRoot, TASK_ID);

        writePreflight(repoRoot, TASK_ID, {

            ...ALL_REVIEW_FLAGS,

            code: true,

            security: true,

            test: true

        }, { reviewPolicyMode: 'parallel_all' });

        seedCompilePass(repoRoot, TASK_ID);

        seedFullSuiteValidation(repoRoot, TASK_ID, 'FAILED');

        seedFullSuiteRetryEvidence(repoRoot, TASK_ID, 'transient', {

            command: 'npm test -- tests/node/gates/next-step/next-step-full-suite-routing.test.ts',

            exit_code: 1,

            status: 'PASSED'

        });



        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });



        assert.equal(result.next_gate, 'implementation');

        assert.match(result.title, /Fix full-suite failures/);

        assert.doesNotMatch(result.reason, /full-suite-retry-evidence/);

    });



    it('rejects focused retry evidence without an auditable command', () => {

        const repoRoot = makeTempRepo();

        writeJson(path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json'), {

            full_suite_validation: {

                enabled: true,

                command: 'npm test',

                placement: 'after_compile_before_reviews'

            },

            review_execution_policy: {

                mode: 'parallel_all'

            }

        });

        seedStartedTask(repoRoot, TASK_ID);

        writePreflight(repoRoot, TASK_ID, {

            ...ALL_REVIEW_FLAGS,

            code: true,

            security: true,

            test: true

        }, { reviewPolicyMode: 'parallel_all' });

        seedCompilePass(repoRoot, TASK_ID);

        seedFullSuiteValidation(repoRoot, TASK_ID, 'FAILED');

        seedFullSuiteRetryEvidence(repoRoot, TASK_ID, 'transient', {

            status: 'PASSED'

        });



        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });



        assert.equal(result.next_gate, 'implementation');

        assert.match(result.title, /Fix full-suite failures/);

        assert.doesNotMatch(result.reason, /full-suite-retry-evidence/);

    });



    it('retries after-compile full-suite timeout when duration history recommends a longer timeout', () => {

        const repoRoot = makeTempRepo();

        const fullSuiteConfig: FullSuiteValidationConfig = {

            ...NEXT_STEP_FULL_SUITE_TEST_CONFIG,

            placement: 'after_compile_before_reviews'

        };

        writeJson(path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json'), {

            full_suite_validation: fullSuiteConfig,

            review_execution_policy: {

                mode: 'parallel_all'

            }

        });

        seedStartedTask(repoRoot, TASK_ID);

        writePreflight(repoRoot, TASK_ID, {

            ...ALL_REVIEW_FLAGS,

            code: true,

            security: true,

            test: true

        }, { reviewPolicyMode: 'parallel_all' });

        seedCompilePass(repoRoot, TASK_ID);

        recordFullSuiteValidationDuration(repoRoot, fullSuiteConfig, {
            timestamp_utc: '2099-01-01T00:00:00.000Z',
            task_id: 'T-OLD-SLOW-PASS',
            status: 'PASSED',
            duration_ms: 400_000,
            timed_out: false,
            exit_code: 0
        });

        seedTimedOutFullSuiteFailure(repoRoot, TASK_ID, fullSuiteConfig);



        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });



        assert.equal(result.next_gate, 'full-suite-validation');

        assert.match(result.title, /Retry full-suite validation/);

        assert.match(result.reason, /timed out/);

        assert.match(result.reason, /recommends a longer timeout/);

        assert.ok(result.commands[0].command.includes('gate full-suite-validation'));

        assert.ok(!result.commands[0].command.includes('build-review-context'));

        assert.ok(!result.commands[0].command.includes('--review-type'));

    });



    it('allows mandatory test review before full-suite when placement is before completion', () => {

        const repoRoot = makeTempRepo();

        writeJson(path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json'), {

            full_suite_validation: {

                enabled: true,

                command: 'npm test',

                placement: 'before_completion'

            },

            review_execution_policy: {

                mode: 'code_first_optional'

            }

        });

        seedStartedTask(repoRoot, TASK_ID);

        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true, test: true });

        seedCompilePass(repoRoot, TASK_ID);

        writeReviewEvidence(repoRoot, TASK_ID, 'code');



        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });



        assert.equal(result.next_gate, 'build-review-context');

        assert.equal(result.review.next_review_type, 'test', result.reason);

        assert.equal(result.full_suite_validation.placement, 'before_completion');

        assert.ok(result.commands[0].command.includes('--review-type "test"'));

        assert.ok(!result.commands[0].command.includes('gate full-suite-validation'));

    });



    it('surfaces recent full-suite duration timeout guidance before running the suite', () => {

        const repoRoot = makeTempRepo();

        writeJson(path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json'), {

            full_suite_validation: NEXT_STEP_FULL_SUITE_TEST_CONFIG,

            review_execution_policy: {

                mode: 'code_first_optional'

            }

        });

        recordFullSuiteValidationDuration(repoRoot, NEXT_STEP_FULL_SUITE_TEST_CONFIG, {

            timestamp_utc: '2099-01-01T00:00:00.000Z',

            task_id: 'T-OLD-1',

            status: 'PASSED',

            duration_ms: 100_000,

            timed_out: false,

            exit_code: 0

        });

        recordFullSuiteValidationDuration(repoRoot, NEXT_STEP_FULL_SUITE_TEST_CONFIG, {

            timestamp_utc: '2099-01-01T00:01:00.000Z',

            task_id: 'T-OLD-2',

            status: 'FAILED',

            duration_ms: 200_000,

            timed_out: false,

            exit_code: 1

        });

        seedStartedTask(repoRoot, TASK_ID);

        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true, test: true });

        seedCompilePass(repoRoot, TASK_ID);

        writeReviewEvidence(repoRoot, TASK_ID, 'code');



        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        const text = formatNextStepText(result);



        assert.equal(result.next_gate, 'full-suite-validation');

        assert.match(result.reason, /Recommended full-suite command timeout: 130s/);

        assert.match(result.reason, /target sample 5 recent run\(s\); eligible 1 run\(s\) avg 100s/);

        assert.match(result.reason, /max 100s/);

        assert.ok(text.includes('FullSuiteTimeout: Recommended full-suite command timeout: 130s'));

    });



    it('keeps parallel non-test reviews launchable while test review waits for full-suite validation', () => {

        const repoRoot = makeTempRepo();

        writeJson(path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json'), {

            full_suite_validation: {

                enabled: true,

                command: 'npm test',

                placement: 'before_test_review'

            },

            review_execution_policy: {

                mode: 'parallel_all'

            }

        });

        seedStartedTask(repoRoot, TASK_ID);

        writePreflight(repoRoot, TASK_ID, {

            ...ALL_REVIEW_FLAGS,

            code: true,

            security: true,

            refactor: true,

            test: true

        }, { reviewPolicyMode: 'parallel_all' });

        seedCompilePass(repoRoot, TASK_ID);



        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        const text = formatNextStepText(result);



        assert.equal(result.next_gate, 'build-review-context');

        assert.equal(result.review.next_review_type, 'code');

        assert.deepEqual(result.review.launchable_review_types, ['code', 'security', 'refactor']);

        assert.deepEqual(result.review.blocked_review_lanes, [

            {

                review_type: 'test',

                blocked_by: ['full-suite-validation'],

                reason: 'Waiting for current full-suite validation evidence before launching test review.'

            }

        ]);

        assert.ok(text.includes('ReviewLaunchableBatch: code, security, refactor'));

        assert.ok(text.includes('BlockedReviewLanes: test blocked by full-suite-validation'));

        assert.ok(!result.commands[0].command.includes('gate full-suite-validation'));

        assert.ok(result.commands[0].command.includes('--review-type "code"'));

    });



    it('launches parallel test review after current full-suite validation passes', () => {

        const repoRoot = makeTempRepo();

        writeJson(path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json'), {

            full_suite_validation: {

                enabled: true,

                command: 'npm test',

                placement: 'before_test_review'

            },

            review_execution_policy: {

                mode: 'parallel_all'

            }

        });

        seedStartedTask(repoRoot, TASK_ID);

        writePreflight(repoRoot, TASK_ID, {

            ...ALL_REVIEW_FLAGS,

            code: true,

            security: true,

            refactor: true,

            test: true

        }, { reviewPolicyMode: 'parallel_all' });

        seedCompilePass(repoRoot, TASK_ID);

        seedFullSuiteValidation(repoRoot, TASK_ID, 'PASSED');



        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });



        assert.equal(result.next_gate, 'build-review-context');

        assert.deepEqual(result.review.launchable_review_types, ['code', 'security', 'refactor', 'test']);

        assert.deepEqual(result.review.blocked_review_lanes, []);

    });



    it('uses current early full-suite pass before continuing to mandatory test review', () => {

        const repoRoot = makeTempRepo();

        writeJson(path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json'), {

            full_suite_validation: {

                enabled: true,

                command: 'npm test',

                placement: 'before_test_review'

            },

            review_execution_policy: {

                mode: 'code_first_optional'

            }

        });

        seedStartedTask(repoRoot, TASK_ID);

        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true, test: true });

        seedCompilePass(repoRoot, TASK_ID);

        writeReviewEvidence(repoRoot, TASK_ID, 'code');

        seedFullSuiteValidation(repoRoot, TASK_ID, 'PASSED');



        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });



        assert.equal(result.next_gate, 'build-review-context');

        assert.equal(result.review.next_review_type, 'test', result.reason);

        assert.ok(result.commands[0].command.includes('--review-type "test"'));

    });



    it('blocks mandatory test review after current early full-suite failure', () => {

        const repoRoot = makeTempRepo();

        writeJson(path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json'), {

            full_suite_validation: {

                enabled: true,

                command: 'npm test',

                placement: 'before_test_review'

            },

            review_execution_policy: {

                mode: 'code_first_optional'

            }

        });

        seedStartedTask(repoRoot, TASK_ID);

        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true, test: true });

        seedCompilePass(repoRoot, TASK_ID);

        writeReviewEvidence(repoRoot, TASK_ID, 'code');

        seedFullSuiteValidation(repoRoot, TASK_ID, 'FAILED');



        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });



        assert.equal(result.next_gate, 'implementation');

        assert.equal(result.review.next_review_type, 'test', result.reason);

        assert.match(result.title, /Fix full-suite failures/);

        assert.ok(!result.commands[0].command.includes('--review-type "test"'));

        assert.ok(!result.commands[0].command.includes('build-review-context'));

    });



    it('reruns full-suite before test review when workflow config command changes after failed evidence was recorded', () => {

        const repoRoot = makeTempRepo();

        writeJson(path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json'), {

            full_suite_validation: {

                enabled: true,

                command: 'npm test',

                placement: 'before_test_review'

            },

            review_execution_policy: {

                mode: 'code_first_optional'

            }

        });

        seedStartedTask(repoRoot, TASK_ID);

        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true, test: true });

        seedCompilePass(repoRoot, TASK_ID);

        writeReviewEvidence(repoRoot, TASK_ID, 'code');

        seedFullSuiteValidation(repoRoot, TASK_ID, 'FAILED');

        writeJson(path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json'), {

            full_suite_validation: {

                enabled: true,

                command: 'npm run test:changed',

                placement: 'before_test_review'

            },

            review_execution_policy: {

                mode: 'code_first_optional'

            }

        });
        commitGitFixturePaths(repoRoot, ['garda-agent-orchestrator/live/config/workflow-config.json']);



        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });



        assert.equal(result.next_gate, 'full-suite-validation');

        assert.equal(result.review.next_review_type, 'test', result.reason);

        assert.match(result.title, /before test review/);

        assert.ok(result.commands[0].command.includes('gate full-suite-validation'));

        assert.ok(!result.commands[0].command.includes('--review-type "test"'));

        assert.ok(!result.commands[0].command.includes('build-review-context'));

        assert.ok(!result.commands[0].command.includes('implementation'));

        assert.ok(!result.reason.includes('already failed for the current compiled scope'));

    });



    it('retries early full-suite before test review when focused evidence clears a transient failure', () => {

        const repoRoot = makeTempRepo();

        writeJson(path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json'), {

            full_suite_validation: {

                enabled: true,

                command: 'npm test',

                placement: 'before_test_review'

            },

            review_execution_policy: {

                mode: 'code_first_optional'

            }

        });

        seedStartedTask(repoRoot, TASK_ID);

        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true, test: true });

        seedCompilePass(repoRoot, TASK_ID);

        writeReviewEvidence(repoRoot, TASK_ID, 'code');

        seedFullSuiteValidation(repoRoot, TASK_ID, 'FAILED');

        seedFullSuiteRetryEvidence(repoRoot, TASK_ID, 'out_of_scope');



        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });



        assert.equal(result.next_gate, 'full-suite-validation');

        assert.equal(result.review.next_review_type, 'test', result.reason);

        assert.match(result.title, /focused transient evidence/);

        assert.match(result.reason, /reason_kind=out_of_scope/);

        assert.ok(result.commands[0].command.includes('gate full-suite-validation'));

        assert.ok(!result.commands[0].command.includes('--review-type "test"'));

        assert.ok(!result.commands[0].command.includes('build-review-context'));

    });



    it('retries early full-suite timeout before mandatory test review when duration history recommends a longer timeout', () => {

        const repoRoot = makeTempRepo();

        writeJson(path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json'), {

            full_suite_validation: NEXT_STEP_FULL_SUITE_TEST_CONFIG,

            review_execution_policy: {

                mode: 'code_first_optional'

            }

        });

        seedStartedTask(repoRoot, TASK_ID);

        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true, test: true });

        seedCompilePass(repoRoot, TASK_ID);

        writeReviewEvidence(repoRoot, TASK_ID, 'code');

        recordFullSuiteValidationDuration(repoRoot, NEXT_STEP_FULL_SUITE_TEST_CONFIG, {
            timestamp_utc: '2099-01-01T00:00:00.000Z',
            task_id: 'T-OLD-SLOW-PASS',
            status: 'PASSED',
            duration_ms: 400_000,
            timed_out: false,
            exit_code: 0
        });

        seedTimedOutFullSuiteFailure(repoRoot, TASK_ID, NEXT_STEP_FULL_SUITE_TEST_CONFIG);



        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });



        assert.equal(result.next_gate, 'full-suite-validation');

        assert.equal(result.review.next_review_type, 'test', result.reason);

        assert.match(result.title, /Retry full-suite validation/);

        assert.match(result.reason, /timed out/);

        assert.match(result.reason, /recommends a longer timeout/);

        assert.ok(result.commands[0].command.includes('gate full-suite-validation'));

        assert.ok(!result.commands[0].command.includes('--review-type "test"'));

        assert.ok(!result.commands[0].command.includes('build-review-context'));

    });



    it('reruns full-suite before test review when prior full-suite pass is stale after a newer compile', () => {

        const repoRoot = makeTempRepo();

        writeJson(path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json'), {

            full_suite_validation: {

                enabled: true,

                command: 'npm test',

                placement: 'before_test_review'

            },

            review_execution_policy: {

                mode: 'code_first_optional'

            }

        });

        seedStartedTask(repoRoot, TASK_ID);

        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true, test: true });

        seedCompilePass(repoRoot, TASK_ID, '2026-04-27T00:00:01.000Z');

        writeReviewEvidence(repoRoot, TASK_ID, 'code');

        seedFullSuiteValidation(repoRoot, TASK_ID, 'PASSED', '2026-04-27T00:00:02.000Z');

        seedCompilePass(repoRoot, TASK_ID, '2026-04-27T00:00:03.000Z');

        writeReviewEvidence(repoRoot, TASK_ID, 'code');



        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });



        assert.equal(result.next_gate, 'full-suite-validation');

        assert.equal(result.review.next_review_type, 'test', result.reason);

        assert.match(result.title, /before test review/);

        assert.ok(result.commands[0].command.includes('gate full-suite-validation'));

        assert.ok(!result.commands[0].command.includes('--review-type "test"'));

    });



    it('keeps current-cycle code review recovery ahead of test-lane full-suite refresh after a newer compile', () => {

        const repoRoot = makeTempRepo();

        writeJson(path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json'), {

            full_suite_validation: {

                enabled: true,

                command: 'npm test',

                placement: 'before_test_review'

            },

            review_execution_policy: {

                mode: 'code_first_optional'

            }

        });

        seedStartedTask(repoRoot, TASK_ID);

        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true, test: true });

        seedCompilePass(repoRoot, TASK_ID, '2099-01-01T00:00:01.000Z');

        writeReviewEvidence(repoRoot, TASK_ID, 'code');

        seedFullSuiteValidation(repoRoot, TASK_ID, 'PASSED', '2099-01-01T00:00:02.000Z');

        const compileArtifactPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-compile-gate.json`);

        const compileArtifact = JSON.parse(fs.readFileSync(compileArtifactPath, 'utf8')) as Record<string, unknown>;

        const fullSuitePath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-full-suite-validation.json`);

        const fullSuiteArtifact = JSON.parse(fs.readFileSync(fullSuitePath, 'utf8')) as Record<string, unknown>;

        const scopeBinding = {

            changed_files_sha256: compileArtifact.scope_changed_files_sha256,

            scope_sha256: compileArtifact.scope_sha256,

            scope_content_sha256: compileArtifact.scope_content_sha256

        };

        (fullSuiteArtifact.cycle_binding as Record<string, unknown>).scope_binding = scopeBinding;

        writeJson(fullSuitePath, fullSuiteArtifact);

        const timelinePath = path.join(eventsRoot(repoRoot), `${TASK_ID}.jsonl`);

        const updatedTimeline = fs.readFileSync(timelinePath, 'utf8')

            .split('\n')

            .map((line) => {

                if (!line.trim()) return line;

                const parsed = JSON.parse(line) as Record<string, unknown>;

                if (parsed.event_type === 'FULL_SUITE_VALIDATION_PASSED') {

                    ((parsed.details as Record<string, unknown>).cycle_binding as Record<string, unknown>).scope_binding = scopeBinding;

                    return JSON.stringify(parsed);

                }

                return line;

            })

            .join('\n');

        fs.writeFileSync(timelinePath, updatedTimeline, 'utf8');

        seedCompilePass(repoRoot, TASK_ID, '2099-01-01T00:00:03.000Z');

        writeReviewEvidence(repoRoot, TASK_ID, 'code');



        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });



        assert.equal(result.next_gate, 'record-review-routing');
        assert.equal(result.review.next_review_type, 'code', result.reason);
        assert.ok(result.commands[0].command.includes('record-review-routing'));
        assert.ok(!result.commands[0].command.includes('gate full-suite-validation'));

    });



    it('reruns full-suite before test review when prior full-suite failure is stale after a newer compile', () => {

        const repoRoot = makeTempRepo();

        writeJson(path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json'), {

            full_suite_validation: {

                enabled: true,

                command: 'npm test',

                placement: 'before_test_review'

            },

            review_execution_policy: {

                mode: 'code_first_optional'

            }

        });

        seedStartedTask(repoRoot, TASK_ID);

        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true, test: true });

        seedCompilePass(repoRoot, TASK_ID, '2099-01-01T00:00:01.000Z');

        writeReviewEvidence(repoRoot, TASK_ID, 'code');

        seedFullSuiteValidation(repoRoot, TASK_ID, 'FAILED', '2099-01-01T00:00:02.000Z');

        seedFullSuiteRetryEvidence(repoRoot, TASK_ID, 'transient');

        seedCompilePass(repoRoot, TASK_ID, '2099-01-01T00:00:03.000Z');

        writeReviewEvidence(repoRoot, TASK_ID, 'code');



        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });



        assert.equal(result.next_gate, 'full-suite-validation');

        assert.equal(result.review.next_review_type, 'test', result.reason);

        assert.match(result.title, /before test review/);

        assert.doesNotMatch(result.title, /focused transient evidence/);

        assert.doesNotMatch(result.reason, /full-suite-retry-evidence/);

        assert.ok(result.commands[0].command.includes('gate full-suite-validation'));

        assert.ok(!result.commands[0].command.includes('--review-type "test"'));

        assert.ok(!result.commands[0].command.includes('implementation'));

    });



    it('surfaces effective full-suite config before completion', () => {

        const repoRoot = makeTempRepo();

        writeJson(path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json'), {

            full_suite_validation: {

                enabled: true,

                command: 'npm test',

                placement: 'before_completion'

            },

            review_execution_policy: {

                mode: 'code_first_optional'

            }

        });

        seedStartedTask(repoRoot, TASK_ID);

        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS });

        seedCompilePass(repoRoot, TASK_ID);

        writeJson(path.join(reviewsRoot(repoRoot), `${TASK_ID}-review-gate.json`), { task_id: TASK_ID, status: 'PASSED' });

        writeJson(path.join(reviewsRoot(repoRoot), `${TASK_ID}-doc-impact.json`), { task_id: TASK_ID, decision: 'NO_DOC_UPDATES' });

        appendEvent(repoRoot, TASK_ID, 'REVIEW_GATE_PASSED');

        appendEvent(repoRoot, TASK_ID, 'DOC_IMPACT_ASSESSED');



        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });



        assert.equal(result.next_gate, 'full-suite-validation');

        assert.equal(result.full_suite_validation.enabled, true);

        assert.equal(result.full_suite_validation.command, 'npm test');

        assert.equal(result.full_suite_validation.placement, 'before_completion');

        assert.match(result.title, /before completion/);

        assert.ok(result.reason.includes('workflow-config.json'));

    });



    it('routes to completion when full-suite validation is disabled after docs pass', () => {

        const repoRoot = makeTempRepo();

        seedStartedTask(repoRoot, TASK_ID);

        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS });

        seedCompilePass(repoRoot, TASK_ID);

        seedReviewGatePass(repoRoot, TASK_ID);

        seedDocImpactPass(repoRoot, TASK_ID);



        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });



        assert.equal(result.full_suite_validation.enabled, false);

        assert.equal(result.next_gate, 'completion-gate');

        assert.ok(result.commands[0].command.includes('gate completion-gate'));

    });



    it('records full-suite as not required for docs-only scopes when full-suite config is enabled', () => {

        const repoRoot = makeTempRepo();

        const defaultWorkflowConfig = buildDefaultWorkflowConfig();

        writeJson(path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json'), {

            ...defaultWorkflowConfig,

            full_suite_validation: {

                ...defaultWorkflowConfig.full_suite_validation,

                enabled: true,

                command: 'npm test',

                placement: 'after_compile_before_reviews'

            },

            review_execution_policy: {

                mode: 'code_first_optional'

            },

            project_memory_maintenance: {

                ...defaultWorkflowConfig.project_memory_maintenance,

                enabled: false

            }

        });

        seedStartedTask(repoRoot, TASK_ID);

        const docsPath = path.join(repoRoot, 'docs', 'runbook.md');

        fs.mkdirSync(path.dirname(docsPath), { recursive: true });

        fs.writeFileSync(docsPath, '# Runbook\n', 'utf8');

        const preflightPath = writePreflight(repoRoot, TASK_ID, {}, {
            changedFiles: ['docs/runbook.md'],
            scopeCategory: 'docs-only'
        });

        const docsSnapshot = getWorkspaceSnapshot(repoRoot, 'explicit_changed_files', true, ['docs/runbook.md']);

        const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;

        preflight.detection_source = docsSnapshot.detection_source;

        preflight.scope_category = 'docs-only';

        preflight.changed_files = docsSnapshot.changed_files;

        preflight.metrics = {

            changed_lines_total: docsSnapshot.changed_lines_total,

            changed_files_sha256: docsSnapshot.changed_files_sha256,

            scope_content_sha256: docsSnapshot.scope_content_sha256,

            scope_sha256: docsSnapshot.scope_sha256

        };

        preflight.required_reviews = { ...ALL_REVIEW_FLAGS };

        preflight.triggers = {

            runtime_code_changed: false,

            test: false,

            db: false,

            security: false,

            api: false,

            performance: false,

            infra: false,

            dependency: false,

            refactor: false

        };

        writeJson(preflightPath, preflight);

        seedPostPreflightRulePack(repoRoot, TASK_ID, preflightPath);

        seedCompilePass(repoRoot, TASK_ID);

        seedReviewGatePass(repoRoot, TASK_ID);

        seedDocImpactPass(repoRoot, TASK_ID);



        const beforeSkip = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(beforeSkip.next_gate, 'full-suite-validation', beforeSkip.reason);

        assert.equal(beforeSkip.full_suite_validation.placement, 'after_compile_before_reviews');

        assert.match(beforeSkip.title, /not required/i);

        assert.ok(beforeSkip.commands[0].command.includes('gate full-suite-validation'));

        assert.equal(beforeSkip.commands[0].label, 'Record full-suite not required');



        seedFullSuiteValidation(repoRoot, TASK_ID, 'SKIPPED', '2099-01-01T00:00:05.000Z');

        const afterSkip = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(afterSkip.next_gate, 'completion-gate', afterSkip.reason);

        assert.ok(afterSkip.commands[0].command.includes('gate completion-gate'));

    });



    it('rejects stale full-suite not-required artifacts for docs-only scopes', () => {

        const repoRoot = makeTempRepo();

        const defaultWorkflowConfig = buildDefaultWorkflowConfig();

        writeJson(path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json'), {

            ...defaultWorkflowConfig,

            full_suite_validation: {

                ...defaultWorkflowConfig.full_suite_validation,

                enabled: true,

                command: 'npm test'

            },

            review_execution_policy: {

                mode: 'code_first_optional'

            },

            project_memory_maintenance: {

                ...defaultWorkflowConfig.project_memory_maintenance,

                enabled: false

            }

        });

        seedStartedTask(repoRoot, TASK_ID);

        const docsPath = path.join(repoRoot, 'docs', 'runbook.md');

        fs.mkdirSync(path.dirname(docsPath), { recursive: true });

        fs.writeFileSync(docsPath, '# Runbook\n', 'utf8');

        const preflightPath = writePreflight(repoRoot, TASK_ID, {}, {
            changedFiles: ['docs/runbook.md'],
            scopeCategory: 'docs-only'
        });

        const docsSnapshot = getWorkspaceSnapshot(repoRoot, 'explicit_changed_files', true, ['docs/runbook.md']);

        const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;

        preflight.detection_source = docsSnapshot.detection_source;

        preflight.scope_category = 'docs-only';

        preflight.changed_files = docsSnapshot.changed_files;

        preflight.metrics = {

            changed_lines_total: docsSnapshot.changed_lines_total,

            changed_files_sha256: docsSnapshot.changed_files_sha256,

            scope_content_sha256: docsSnapshot.scope_content_sha256,

            scope_sha256: docsSnapshot.scope_sha256

        };

        preflight.required_reviews = { ...ALL_REVIEW_FLAGS };

        preflight.triggers = {

            runtime_code_changed: false,

            test: false,

            db: false,

            security: false,

            api: false,

            performance: false,

            infra: false,

            dependency: false,

            refactor: false

        };

        writeJson(preflightPath, preflight);

        seedPostPreflightRulePack(repoRoot, TASK_ID, preflightPath);

        seedCompilePass(repoRoot, TASK_ID);

        seedReviewGatePass(repoRoot, TASK_ID);

        seedDocImpactPass(repoRoot, TASK_ID);

        seedFullSuiteValidation(repoRoot, TASK_ID, 'SKIPPED');

        const fullSuitePath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-full-suite-validation.json`);

        const fullSuiteArtifact = JSON.parse(fs.readFileSync(fullSuitePath, 'utf8')) as Record<string, unknown>;

        (fullSuiteArtifact.cycle_binding as Record<string, unknown>).compile_gate_timestamp = '2000-01-01T00:00:00.000Z';

        writeJson(fullSuitePath, fullSuiteArtifact);

        seedReviewGatePass(repoRoot, TASK_ID);



        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });



        assert.equal(result.next_gate, 'full-suite-validation', result.reason);

        assert.match(result.title, /not required/i);

        assert.equal(result.commands[0].label, 'Record full-suite not required');

    });

});
