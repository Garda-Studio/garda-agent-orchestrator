import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { handleNextStep } from '../../../../src/cli/commands/gate-task-handlers';
import {
    assertNextStepEffectExecutionComplete,
    createNextStepEffectExecutor,
    createNextStepEffectPlanner,
    NextStepEffectPlanStaleError
} from '../../../../src/gates/next-step/next-step-effects';
import * as fx from './next-step-review-cycle-fixtures';
import {
    buildStrictDecompositionDecisionArtifact,
    executeNextStepEffects,
    inspectNextStep
} from './next-step-test-support';

const {
    ALL_REVIEW_FLAGS,
    appendEvent,
    buildReviewContextScopeFixture,
    eventsRoot,
    buildTaskModeArtifact,
    getWorkspaceSnapshot,
    buildDefaultWorkflowConfig,
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
void [ALL_REVIEW_FLAGS, appendEvent, buildReviewContextScopeFixture, eventsRoot, buildTaskModeArtifact, getWorkspaceSnapshot, buildDefaultWorkflowConfig, resolveNextStep, formatNextStepText, EXPECTED_LOOP_LINE, fileSha256, fs, getLoadedRuleFileBasenames, hasCompletedDecomposedParentAfterSplitRequiredClear, hasSplitRequiredClearedEvidence, launchInputEvidenceFixture, makeTempRepo, markReviewEvidenceAsStrictReuse, materializeFinalCloseout, NEXT_STEP_FULL_SUITE_TEST_CONFIG, normalizeForTimeline, os, path, PROVIDER_ENV_KEYS, readReviewContextTreeStateSha256, readSplitRequiredLatchEvidence, requireFromTest, resolveReviewCycleContinuationArtifactPath, resolveSplitRequiredArtifactPath, reviewsRoot, runRecordReviewCycleSplitDecisionCommand, seedCompilePass, seedCompletedReviewerLaunchAndInvocation, seedCompletedTaskWithIndependentCodeReview, seedCompletionPass, seedCustomStartedTask, seedDocImpactPass, seedFullSuiteValidation, seedGitAutoCompilePass, seedHandshake, seedPostPreflightRulePack, seedProjectMemory, seedProjectMemoryImpact, seedReviewGatePass, seedRulePack, seedShellSmoke, seedSourceCheckoutRuntime, seedSplitRequiredLatchEvidence, seedStartedTask, seedTaskModeOnly, sha256Text, TASK_ID, tempRoots, withProviderEnv, writeFreshReviewContextWithoutRouting, writeGitAutoPreflight, writeJson, writeJsonWithSha, writeNoOpEvidence, writePreflight, writeProjectMemoryWorkflowConfig, writeReviewContextOnly, writeReviewCycleContinuation, writeReviewEvidence, writeStrictDecompositionDecision, writeStrictIndependentCodeReviewEvidence];

async function captureNextStepHandler(argv: string[]): Promise<string> {
    const chunks: string[] = [];
    const originalWrite = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
        chunks.push(String(chunk));
        return true;
    }) as typeof process.stdout.write;
    try {
        await handleNextStep(argv);
        return chunks.join('');
    } finally {
        process.stdout.write = originalWrite;
    }
}

describe('gates/next-step split-required latch status', () => {
    it('rejects a stale authenticated effect plan when execution consumes only its prefix', () => {
        const planner = createNextStepEffectPlanner();
        planner.run({
            kind: 'first-effect',
            summary: 'first effect',
            input: { step: 1 },
            preview: () => 'first-preview',
            execute: () => 'first-executed'
        });
        planner.run({
            kind: 'second-effect',
            summary: 'second effect',
            input: { step: 2 },
            preview: () => 'second-preview',
            execute: () => 'second-executed'
        });
        const plan = planner.pendingPlan();
        assert.ok(plan);

        const executor = createNextStepEffectExecutor(plan);
        executor.run({
            kind: 'first-effect',
            summary: 'first effect',
            input: { step: 1 },
            preview: () => 'first-preview',
            execute: () => 'first-executed'
        });

        assert.throws(
            () => assertNextStepEffectExecutionComplete(executor, plan),
            (error: unknown) => error instanceof NextStepEffectPlanStaleError
                && /executed 1 of 2 expected effects/u.test(error.message)
        );
    });

    it('rejects a stale plan when an effect is appended after the authenticated plan is exhausted', () => {
        const planner = createNextStepEffectPlanner();
        planner.run({
            kind: 'expected-effect',
            summary: 'expected effect',
            input: { step: 1 },
            preview: () => 'expected-preview',
            execute: () => 'expected-executed'
        });
        const plan = planner.pendingPlan();
        assert.ok(plan);

        let unexpectedExecuted = false;
        const executor = createNextStepEffectExecutor(plan);
        executor.run({
            kind: 'expected-effect',
            summary: 'expected effect',
            input: { step: 1 },
            preview: () => 'expected-preview',
            execute: () => 'expected-executed'
        });
        assert.equal(executor.run({
            kind: 'unexpected-effect',
            summary: 'unexpected effect',
            input: { step: 2 },
            preview: () => 'unexpected-preview',
            execute: () => {
                unexpectedExecuted = true;
                return 'unexpected-executed';
            }
        }), 'unexpected-preview');

        assert.equal(unexpectedExecuted, false);
        assert.throws(
            () => assertNextStepEffectExecutionComplete(executor, plan),
            (error: unknown) => error instanceof NextStepEffectPlanStaleError
                && /executed 1 of 1 expected effects and encountered 1 unexpected effects/u.test(error.message)
        );
    });

    it('resolves and validates split-required latch helper evidence directly', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '# TASK.md',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            '| T-681 | SPLIT_REQUIRED | P1 | workflow | Parent | gpt-5.4 | 2026-05-05 | strict | Split into child tasks `T-682`. |',
            ''
        ].join('\n'), 'utf8');
        seedSplitRequiredLatchEvidence(repoRoot, 'T-681', 'review_cycle');

        const latchEvidence = readSplitRequiredLatchEvidence({
            reviewsRoot: reviewsRoot(repoRoot),
            eventsRoot: eventsRoot(repoRoot),
            taskId: 'T-681'
        });

        assert.equal(
            resolveSplitRequiredArtifactPath(reviewsRoot(repoRoot), 'T-681'),
            path.join(reviewsRoot(repoRoot), 'T-681-split-required.json')
        );
        assert.equal(latchEvidence.valid, true);
        assert.equal(latchEvidence.guard_kind, 'review_cycle');
        assert.equal(hasSplitRequiredClearedEvidence({
            eventsRoot: eventsRoot(repoRoot),
            taskId: 'T-681',
            latchEvidence
        }), false);

        appendEvent(repoRoot, 'T-681', 'SPLIT_REQUIRED_CLEARED', 'INFO', {
            previous_status: 'SPLIT_REQUIRED',
            new_status: 'DECOMPOSED',
            reason: 'child_tasks_linked'
        });

        assert.equal(hasSplitRequiredClearedEvidence({
            eventsRoot: eventsRoot(repoRoot),
            taskId: 'T-681',
            latchEvidence
        }), true);
        assert.equal(hasCompletedDecomposedParentAfterSplitRequiredClear({
            eventsRoot: eventsRoot(repoRoot),
            taskId: 'T-681',
            latchEvidence
        }), false);

        appendEvent(repoRoot, 'T-681', 'DECOMPOSED_PARENT_COMPLETED', 'INFO', {
            previous_status: 'DECOMPOSED',
            new_status: 'DONE',
            reason: 'explicit_children_done'
        });

        assert.equal(hasCompletedDecomposedParentAfterSplitRequiredClear({
            eventsRoot: eventsRoot(repoRoot),
            taskId: 'T-681',
            latchEvidence
        }), true);
    });

    it('executes guarded effects through the CLI and rejects forged or standalone plan hashes', async () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '# TASK.md',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            `| ${TASK_ID} | TODO | P1 | workflow/scope-budget | Add decomposition guard | gpt-5.4 | 2026-05-03 | strict | Test queue entry. |`,
            ''
        ].join('\n'), 'utf8');
        fs.writeFileSync(
            path.join(repoRoot, '.gitignore'),
            'garda-agent-orchestrator/runtime/\n',
            'utf8'
        );
        const workflowConfig = buildDefaultWorkflowConfig();
        workflowConfig.scope_budget_guard.action = 'BLOCK_FOR_SPLIT';
        workflowConfig.scope_budget_guard.max_files = 12;
        workflowConfig.scope_budget_guard.warn_files = 11;
        workflowConfig.scope_budget_guard.block_files = 12;
        writeJson(path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json'), workflowConfig);
        execFileSync('git', ['init', '--quiet'], { cwd: repoRoot });
        execFileSync('git', ['add', '.'], { cwd: repoRoot });
        execFileSync('git', [
            '-c', 'user.name=Garda Test',
            '-c', 'user.email=garda-test@example.invalid',
            'commit', '--quiet', '-m', 'fixture baseline'
        ], { cwd: repoRoot });
        const changedFiles = Array.from({ length: 13 }, (_, index) => `src/file-${index}.ts`);
        for (const filePath of changedFiles) {
            fs.writeFileSync(path.join(repoRoot, filePath), 'export const value = 1;\n', 'utf8');
        }
        seedStartedTask(repoRoot, TASK_ID);
        const snapshot = getWorkspaceSnapshot(repoRoot, 'explicit_changed_files', true, changedFiles);
        const preflightPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-preflight.json`);
        writeJson(preflightPath, {
            task_id: TASK_ID,
            detection_source: snapshot.detection_source,
            mode: 'FULL_PATH',
            scope_category: 'code',
            metrics: {
                changed_files_count: snapshot.changed_files.length,
                changed_lines_total: snapshot.changed_lines_total,
                changed_files_sha256: snapshot.changed_files_sha256,
                scope_content_sha256: snapshot.scope_content_sha256,
                scope_sha256: snapshot.scope_sha256
            },
            required_reviews: { ...ALL_REVIEW_FLAGS, code: true, security: true, refactor: true, test: true },
            changed_files: changedFiles,
            review_execution_policy: {
                mode: 'code_first_optional',
                visible_summary_line: 'Review execution policy: code_first_optional'
            },
            profile_selection: {
                task_profile: 'strict',
                profile_selection_source: 'task_queue',
                effective_profile: 'strict',
                effective_profile_source: 'built_in',
                runtime_active_profile: 'balanced',
                runtime_profile_source: 'built_in'
            },
            budget_forecast: {
                total_estimated_review_tokens: 9000
            }
        });
        appendEvent(repoRoot, TASK_ID, 'PREFLIGHT_CLASSIFIED', 'INFO', {
            output_path: normalizeForTimeline(preflightPath)
        });
        seedPostPreflightRulePack(repoRoot, TASK_ID, preflightPath);
        writeStrictDecompositionDecision(repoRoot, TASK_ID, {
            decision: 'single-cycle',
            taskSummary: 'Seeded next-step task',
            expectedReviewTypes: ['code', 'security', 'refactor', 'test']
        });

        const taskPath = path.join(repoRoot, 'TASK.md');
        const taskBeforeInspection = fs.readFileSync(taskPath, 'utf8');
        const eventPath = path.join(eventsRoot(repoRoot), `${TASK_ID}.jsonl`);
        const eventsBeforeInspection = fs.readFileSync(eventPath, 'utf8');
        const latchPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-split-required.json`);

        const inspection = inspectNextStep({ taskId: TASK_ID, repoRoot });
        const effectCommand = inspection.commands[0]?.command || '';
        const planSha256 = effectCommand.match(/--effect-plan-sha256\s+["']?([a-f0-9]{64})/u)?.[1] || '';

        assert.equal(inspection.next_gate, 'next-step-effect', inspection.reason);
        assert.equal(fs.readFileSync(taskPath, 'utf8'), taskBeforeInspection);
        assert.equal(fs.readFileSync(eventPath, 'utf8'), eventsBeforeInspection);
        assert.equal(fs.existsSync(latchPath), false);
        assert.ok(changedFiles.every((filePath) => fs.existsSync(path.join(repoRoot, filePath))));
        assert.match(planSha256, /^[a-f0-9]{64}$/u);
        assert.throws(
            () => executeNextStepEffects({ taskId: TASK_ID, repoRoot }, '0'.repeat(64)),
            /effect plan is stale/iu
        );
        await assert.rejects(
            () => handleNextStep([
                '--task-id', TASK_ID,
                '--effect-plan-sha256', planSha256,
                '--repo-root', repoRoot
            ]),
            /--effect-plan-sha256 requires --execute-effects/iu
        );
        assert.equal(fs.readFileSync(taskPath, 'utf8'), taskBeforeInspection);
        assert.equal(fs.existsSync(latchPath), false);

        const cliOutput = await captureNextStepHandler([
            '--task-id', TASK_ID,
            '--execute-effects',
            '--effect-plan-sha256', planSha256,
            '--as-json',
            '--repo-root', repoRoot
        ]);
        const result = JSON.parse(cliOutput) as ReturnType<typeof executeNextStepEffects>;
        const text = formatNextStepText(result);

        assert.equal(result.status, 'SPLIT_REQUIRED', result.reason);
        assert.equal(result.next_gate, 'split-required-latch');
        assert.equal(result.commands.length, 0);
        assert.ok(result.reason.includes('configured blocking budget exceeded: changed_files_count'));
        assert.equal(result.reason.includes('13>12'), false);
        assert.ok(text.includes('Status: SPLIT_REQUIRED'));
        assert.ok(text.includes('NextGate: split-required-latch'));
        assert.ok(fs.readFileSync(taskPath, 'utf8').includes(`| ${TASK_ID} | 🟫 SPLIT_REQUIRED |`));
        assert.equal(fs.existsSync(latchPath), true);
        const latch = JSON.parse(fs.readFileSync(latchPath, 'utf8')) as Record<string, unknown>;
        assert.equal(latch.status, 'SPLIT_REQUIRED');
        assert.equal(latch.guard_kind, 'scope_budget');
        const events = fs.readFileSync(eventPath, 'utf8');
        assert.ok(events.includes('"event_type":"SPLIT_REQUIRED_LATCHED"'));
        assert.ok(events.includes('"new_status":"SPLIT_REQUIRED"'));
        const wipCapture = latch.wip_capture as Record<string, unknown> | null;
        assert.equal(wipCapture?.status, 'CAPTURED');
        assert.equal(changedFiles.every((filePath) => !fs.existsSync(path.join(repoRoot, filePath))), true);
    });

    it('warns but continues when strict-profile scope exceeds warning lines below blocking lines', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '# TASK.md',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            `| ${TASK_ID} | TODO | P1 | workflow/scope-budget | Add warning tier | gpt-5.4 | 2026-05-03 | strict | Test queue entry. |`,
            ''
        ].join('\n'), 'utf8');
        const changedFiles = ['src/warn.ts'];
        fs.mkdirSync(path.dirname(path.join(repoRoot, changedFiles[0])), { recursive: true });
        fs.writeFileSync(
            path.join(repoRoot, changedFiles[0]),
            Array.from({ length: 2500 }, (_, index) => `export const value${index} = ${index};`).join('\n') + '\n',
            'utf8'
        );
        const workflowConfig = buildDefaultWorkflowConfig();
        workflowConfig.scope_budget_guard.warn_changed_lines = 2000;
        workflowConfig.scope_budget_guard.block_changed_lines = 5000;
        writeJson(path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json'), workflowConfig);
        seedStartedTask(repoRoot, TASK_ID);
        const snapshot = getWorkspaceSnapshot(repoRoot, 'explicit_changed_files', true, changedFiles);
        const preflightPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-preflight.json`);
        writeJson(preflightPath, {
            task_id: TASK_ID,
            detection_source: snapshot.detection_source,
            mode: 'FULL_PATH',
            scope_category: 'code',
            metrics: {
                changed_files_count: snapshot.changed_files.length,
                changed_lines_total: 2500,
                changed_files_sha256: snapshot.changed_files_sha256,
                scope_content_sha256: snapshot.scope_content_sha256,
                scope_sha256: snapshot.scope_sha256
            },
            required_reviews: { ...ALL_REVIEW_FLAGS },
            changed_files: changedFiles,
            review_execution_policy: {
                mode: 'code_first_optional',
                visible_summary_line: 'Review execution policy: code_first_optional'
            },
            profile_selection: {
                task_profile: 'strict',
                profile_selection_source: 'task_queue',
                effective_profile: 'strict',
                effective_profile_source: 'built_in',
                runtime_active_profile: 'balanced',
                runtime_profile_source: 'built_in'
            },
            budget_forecast: {
                total_estimated_review_tokens: 9000
            }
        });
        appendEvent(repoRoot, TASK_ID, 'PREFLIGHT_CLASSIFIED', 'INFO', {
            output_path: normalizeForTimeline(preflightPath)
        });
        seedPostPreflightRulePack(repoRoot, TASK_ID, preflightPath);
        writeStrictDecompositionDecision(repoRoot, TASK_ID, {
            decision: 'single-cycle',
            taskSummary: 'Seeded next-step task',
            expectedReviewTypes: ['none']
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const text = formatNextStepText(result);

        assert.equal(result.next_gate, 'compile-gate', result.reason);
        assert.equal(result.warnings.length, 1);
        assert.ok(result.warnings[0].includes('Scope budget guard: WARN'));
        assert.ok(result.warnings[0].includes('changed_lines_total=2500>2000 WARN'));
        assert.ok(result.warnings[0].includes('Continuation allowed'));
        assert.ok(text.includes('Warnings:'));
        assert.equal(fs.existsSync(path.join(reviewsRoot(repoRoot), `${TASK_ID}-split-required.json`)), false);
    });

    it('does not latch companion UI i18n scopes by raw language-pack file count', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '# TASK.md',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            `| ${TASK_ID} | TODO | P1 | ui/i18n-companion | Update UI labels with generated language packs | gpt-5.4 | 2026-05-03 | strict | Small UI driver plus generated lang packs. |`,
            ''
        ].join('\n'), 'utf8');
        const changedFiles = [
            'src/reports/ui/dashboard-client-quality-gate.ts',
            'src/reports/ui/lang-packs/garda-ui-de.json',
            'src/reports/ui/lang-packs/garda-ui-en.json',
            'src/reports/ui/lang-packs/garda-ui-es.json',
            'src/reports/ui/lang-packs/garda-ui-fr.json',
            'src/reports/ui/lang-packs/garda-ui-ru.json'
        ];
        for (const filePath of changedFiles) {
            fs.mkdirSync(path.dirname(path.join(repoRoot, filePath)), { recursive: true });
            const lineCount = filePath.endsWith('.ts') ? 12 : 24;
            fs.writeFileSync(
                path.join(repoRoot, filePath),
                Array.from({ length: lineCount }, (_, index) => `line_${index + 1}`).join('\n') + '\n',
                'utf8'
            );
        }
        seedStartedTask(repoRoot, TASK_ID);
        const snapshot = getWorkspaceSnapshot(repoRoot, 'explicit_changed_files', true, changedFiles);
        const preflightPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-preflight.json`);
        writeJson(preflightPath, {
            task_id: TASK_ID,
            detection_source: snapshot.detection_source,
            mode: 'FAST_PATH',
            scope_category: 'code',
            metrics: {
                changed_files_count: changedFiles.length,
                changed_lines_total: 132,
                companion_scope_kind: 'ui-i18n',
                companion_scope_effective_changed_files_count: 1,
                companion_scope_effective_changed_lines_total: 12,
                companion_scope_exempted_files_count: 5,
                changed_files_sha256: snapshot.changed_files_sha256,
                scope_content_sha256: snapshot.scope_content_sha256,
                scope_sha256: snapshot.scope_sha256
            },
            triggers: {
                ui_i18n_companion_scope: true,
                ui_i18n_companion_reason: 'ui_i18n_companion_scope',
                ui_i18n_companion_driver_files: [changedFiles[0]],
                ui_i18n_companion_files: changedFiles.slice(1)
            },
            required_reviews: { ...ALL_REVIEW_FLAGS },
            changed_files: changedFiles,
            review_execution_policy: {
                mode: 'code_first_optional',
                visible_summary_line: 'Review execution policy: code_first_optional'
            },
            profile_selection: {
                task_profile: 'strict',
                profile_selection_source: 'task_queue',
                effective_profile: 'strict',
                effective_profile_source: 'built_in',
                runtime_active_profile: 'balanced',
                runtime_profile_source: 'built_in'
            },
            budget_forecast: {
                total_estimated_review_tokens: 3000
            }
        });
        appendEvent(repoRoot, TASK_ID, 'PREFLIGHT_CLASSIFIED', 'INFO', {
            output_path: normalizeForTimeline(preflightPath)
        });
        seedPostPreflightRulePack(repoRoot, TASK_ID, preflightPath);
        writeStrictDecompositionDecision(repoRoot, TASK_ID, {
            decision: 'single-cycle',
            taskSummary: 'Seeded next-step task',
            expectedReviewTypes: ['none']
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.notEqual(result.status, 'SPLIT_REQUIRED');
        assert.equal(result.next_gate, 'compile-gate', result.reason);
        assert.ok(result.commands[0].command.includes('gate compile-gate'));
        assert.equal(fs.existsSync(path.join(reviewsRoot(repoRoot), `${TASK_ID}-split-required.json`)), false);
        assert.equal(fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8').includes(`| ${TASK_ID} | 🟫 SPLIT_REQUIRED |`), false);
    });

    it('does not latch localization-only UI i18n scopes by raw language-pack file count', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '# TASK.md',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            `| ${TASK_ID} | TODO | P1 | ui/i18n-only | Update generated language packs | gpt-5.4 | 2026-05-03 | strict | Generated language pack refresh only. |`,
            ''
        ].join('\n'), 'utf8');
        const changedFiles = [
            'src/reports/ui/lang-packs/garda-ui-ar.json',
            'src/reports/ui/lang-packs/garda-ui-bn.json',
            'src/reports/ui/lang-packs/garda-ui-de.json',
            'src/reports/ui/lang-packs/garda-ui-en.json',
            'src/reports/ui/lang-packs/garda-ui-es.json',
            'src/reports/ui/lang-packs/garda-ui-fr.json',
            'src/reports/ui/lang-packs/garda-ui-hi.json',
            'src/reports/ui/lang-packs/garda-ui-id.json',
            'src/reports/ui/lang-packs/garda-ui-it.json',
            'src/reports/ui/lang-packs/garda-ui-ru.json'
        ];
        for (const filePath of changedFiles) {
            fs.mkdirSync(path.dirname(path.join(repoRoot, filePath)), { recursive: true });
            fs.writeFileSync(
                path.join(repoRoot, filePath),
                Array.from({ length: 50 }, (_, index) => `line_${index + 1}`).join('\n') + '\n',
                'utf8'
            );
        }
        seedStartedTask(repoRoot, TASK_ID);
        const snapshot = getWorkspaceSnapshot(repoRoot, 'explicit_changed_files', true, changedFiles);
        const preflightPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-preflight.json`);
        writeJson(preflightPath, {
            task_id: TASK_ID,
            detection_source: snapshot.detection_source,
            mode: 'FULL_PATH',
            scope_category: 'config-only',
            metrics: {
                changed_files_count: changedFiles.length,
                changed_lines_total: 500,
                review_trigger_effective_changed_files_count: 0,
                review_trigger_effective_changed_lines_total: 0,
                review_trigger_suppressed_files_count: changedFiles.length,
                companion_scope_kind: 'ui-i18n',
                companion_scope_effective_changed_files_count: 0,
                companion_scope_effective_changed_lines_total: 0,
                companion_scope_exempted_files_count: changedFiles.length,
                changed_files_sha256: snapshot.changed_files_sha256,
                scope_content_sha256: snapshot.scope_content_sha256,
                scope_sha256: snapshot.scope_sha256
            },
            triggers: {
                ui_i18n_companion_scope: false,
                ui_i18n_companion_reason: 'standalone_i18n_scope',
                ui_i18n_companion_driver_files: [],
                ui_i18n_companion_files: changedFiles,
                ui_i18n_review_trigger_suppressed: true,
                ui_i18n_review_trigger_files: [],
                ui_i18n_review_trigger_suppressed_files: changedFiles
            },
            required_reviews: { ...ALL_REVIEW_FLAGS },
            changed_files: changedFiles,
            review_execution_policy: {
                mode: 'code_first_optional',
                visible_summary_line: 'Review execution policy: code_first_optional'
            },
            profile_selection: {
                task_profile: 'strict',
                profile_selection_source: 'task_queue',
                effective_profile: 'strict',
                effective_profile_source: 'built_in',
                runtime_active_profile: 'balanced',
                runtime_profile_source: 'built_in'
            },
            budget_forecast: {
                changed_files_count: 0,
                changed_lines_total: 0,
                total_estimated_review_tokens: 0
            }
        });
        appendEvent(repoRoot, TASK_ID, 'PREFLIGHT_CLASSIFIED', 'INFO', {
            output_path: normalizeForTimeline(preflightPath)
        });
        seedPostPreflightRulePack(repoRoot, TASK_ID, preflightPath);
        writeStrictDecompositionDecision(repoRoot, TASK_ID, {
            decision: 'single-cycle',
            taskSummary: 'Seeded next-step task',
            expectedReviewTypes: ['none']
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.notEqual(result.status, 'SPLIT_REQUIRED');
        assert.equal(result.next_gate, 'compile-gate', result.reason);
        assert.ok(result.commands[0].command.includes('gate compile-gate'));
        assert.equal(fs.existsSync(path.join(reviewsRoot(repoRoot), `${TASK_ID}-split-required.json`)), false);
        assert.equal(fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8').includes(`| ${TASK_ID} | 🟫 SPLIT_REQUIRED |`), false);
    });

    it('falls back to raw line budget when companion UI i18n effective line metric is missing', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '# TASK.md',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            `| ${TASK_ID} | TODO | P1 | ui/i18n-companion | Update UI labels with generated language packs | gpt-5.4 | 2026-05-03 | strict | Small UI driver plus generated lang packs. |`,
            ''
        ].join('\n'), 'utf8');
        const changedFiles = [
            'src/reports/ui/dashboard-client-quality-gate.ts',
            'src/reports/ui/lang-packs/garda-ui-de.json',
            'src/reports/ui/lang-packs/garda-ui-en.json',
            'src/reports/ui/lang-packs/garda-ui-es.json',
            'src/reports/ui/lang-packs/garda-ui-fr.json',
            'src/reports/ui/lang-packs/garda-ui-ru.json'
        ];
        for (const filePath of changedFiles) {
            fs.mkdirSync(path.dirname(path.join(repoRoot, filePath)), { recursive: true });
            const lineCount = filePath.endsWith('.ts') ? 12 : 24;
            fs.writeFileSync(
                path.join(repoRoot, filePath),
                Array.from({ length: lineCount }, (_, index) => `line_${index + 1}`).join('\n') + '\n',
                'utf8'
            );
        }
        seedStartedTask(repoRoot, TASK_ID);
        const config = buildDefaultWorkflowConfig();
        config.full_suite_validation.enabled = false;
        config.review_execution_policy = { mode: 'code_first_optional' };
        config.scope_budget_guard.action = 'BLOCK_FOR_SPLIT';
        config.scope_budget_guard.max_files = 999999;
        config.scope_budget_guard.max_changed_lines = 120;
        config.scope_budget_guard.max_required_reviews = 999999;
        config.scope_budget_guard.max_review_tokens = 999999;
        config.scope_budget_guard.warn_changed_lines = 119;
        config.scope_budget_guard.block_changed_lines = 120;
        writeJson(path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json'), config);
        const snapshot = getWorkspaceSnapshot(repoRoot, 'explicit_changed_files', true, changedFiles);
        const preflightPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-preflight.json`);
        writeJson(preflightPath, {
            task_id: TASK_ID,
            detection_source: snapshot.detection_source,
            mode: 'FAST_PATH',
            scope_category: 'code',
            metrics: {
                changed_files_count: changedFiles.length,
                changed_lines_total: 132,
                companion_scope_kind: 'ui-i18n',
                companion_scope_effective_changed_files_count: 1,
                companion_scope_effective_changed_lines_total: null,
                companion_scope_exempted_files_count: 5,
                changed_files_sha256: snapshot.changed_files_sha256,
                scope_content_sha256: snapshot.scope_content_sha256,
                scope_sha256: snapshot.scope_sha256
            },
            triggers: {
                ui_i18n_companion_scope: true,
                ui_i18n_companion_reason: 'ui_i18n_companion_scope',
                ui_i18n_companion_driver_files: [changedFiles[0]],
                ui_i18n_companion_files: changedFiles.slice(1)
            },
            required_reviews: { ...ALL_REVIEW_FLAGS },
            changed_files: changedFiles,
            review_execution_policy: {
                mode: 'code_first_optional',
                visible_summary_line: 'Review execution policy: code_first_optional'
            },
            profile_selection: {
                task_profile: 'strict',
                profile_selection_source: 'task_queue',
                effective_profile: 'strict',
                effective_profile_source: 'built_in',
                runtime_active_profile: 'balanced',
                runtime_profile_source: 'built_in'
            },
            budget_forecast: {
                total_estimated_review_tokens: 3000
            }
        });
        appendEvent(repoRoot, TASK_ID, 'PREFLIGHT_CLASSIFIED', 'INFO', {
            output_path: normalizeForTimeline(preflightPath)
        });
        seedPostPreflightRulePack(repoRoot, TASK_ID, preflightPath);
        writeStrictDecompositionDecision(repoRoot, TASK_ID, {
            decision: 'single-cycle',
            taskSummary: 'Seeded next-step task',
            expectedReviewTypes: ['none']
        });
        writeJson(path.join(reviewsRoot(repoRoot), `${TASK_ID}-compile-gate.json`), {
            timestamp_utc: new Date().toISOString(),
            task_id: TASK_ID,
            event_source: 'compile-gate',
            status: 'PASSED',
            outcome: 'PASS',
            preflight_path: normalizeForTimeline(preflightPath),
            preflight_hash_sha256: fileSha256(preflightPath),
            scope_detection_source: snapshot.detection_source,
            scope_include_untracked: snapshot.include_untracked,
            scope_changed_files: snapshot.changed_files,
            scope_changed_files_count: snapshot.changed_files_count,
            scope_changed_lines_total: snapshot.changed_lines_total,
            scope_changed_files_sha256: snapshot.changed_files_sha256,
            scope_content_sha256: snapshot.scope_content_sha256,
            scope_sha256: snapshot.scope_sha256
        });
        appendEvent(repoRoot, TASK_ID, 'COMPILE_GATE_PASSED', 'PASS', {});

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.status, 'SPLIT_REQUIRED', result.reason);
        assert.equal(result.next_gate, 'split-required-latch');
        assert.ok(result.reason.includes('configured blocking budget exceeded: changed_lines_total'), result.reason);
        const latchPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-split-required.json`);
        assert.equal(fs.existsSync(latchPath), true);
        const latch = JSON.parse(fs.readFileSync(latchPath, 'utf8')) as {
            raw_guard_summary?: unknown;
            guard_details?: { violations?: Array<{ metric?: unknown; actual?: unknown; limit?: unknown }> };
        };
        const violation = latch.guard_details?.violations?.[0];
        assert.equal(latch.raw_guard_summary, 'Scope budget guard: BLOCK (changed_lines_total=132>120 BLOCK)');
        assert.equal(violation?.metric, 'changed_lines_total');
        assert.equal(violation?.actual, 132);
        assert.equal(violation?.limit, 120);
    });

    it('keeps split-required latch ahead of ordinary recovery after the diff shrinks', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '# TASK.md',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            `| ${TASK_ID} | SPLIT_REQUIRED | P1 | workflow/scope-budget | Add decomposition guard | gpt-5.4 | 2026-05-03 | strict | Guard latched; split into child tasks later. |`,
            ''
        ].join('\n'), 'utf8');
        seedStartedTask(repoRoot, TASK_ID);
        const preflightPath = writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        seedSplitRequiredLatchEvidence(repoRoot, TASK_ID);
        seedCompilePass(repoRoot, TASK_ID);
        seedReviewGatePass(repoRoot, TASK_ID);
        seedDocImpactPass(repoRoot, TASK_ID);
        seedCompletionPass(repoRoot, TASK_ID);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const text = formatNextStepText(result);

        assert.equal(preflightPath.endsWith(`${TASK_ID}-preflight.json`), true);
        assert.equal(result.status, 'SPLIT_REQUIRED');
        assert.equal(result.next_gate, 'split-required-latch');
        assert.equal(result.commands.length, 0);
        assert.ok(result.reason.includes('cannot continue through classify, compile, review, full-suite, completion, or final closeout gates'));
        assert.ok(text.includes('Status: SPLIT_REQUIRED'));
    });

    it('keeps restore and decomposed-parent synchronization inspection side-effect free', () => {
        const repoRoot = makeTempRepo();
        const parentTaskId = 'T-629';
        const childTaskId = 'T-630';
        const secondChildTaskId = 'T-631';
        const config = buildDefaultWorkflowConfig();
        config.full_suite_validation.enabled = false;
        config.full_suite_validation.command = 'npm test';
        config.review_execution_policy = { mode: 'code_first_optional' };
        config.scope_budget_guard.max_files = 999999;
        config.scope_budget_guard.max_changed_lines = 999999;
        config.scope_budget_guard.max_required_reviews = 999999;
        config.scope_budget_guard.max_review_tokens = 999999;
        writeJson(path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json'), config);
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '# TASK.md',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            `| ${parentTaskId} | TODO | P1 | workflow/scope-budget | Add decomposition guard | gpt-5.4 | 2026-05-03 | strict | Child tasks: \`${childTaskId}\` and \`${secondChildTaskId}\`. |`,
            `| ${childTaskId} | TODO | P1 | workflow/parser | Implement parser boundary | gpt-5.4 | 2026-05-03 | strict | Parse the bounded child contract. Child of ${parentTaskId}. |`,
            `| ${secondChildTaskId} | TODO | P1 | workflow/validation | Validate routing boundary | gpt-5.4 | 2026-05-03 | strict | Validate the independent routing contract. Child of ${parentTaskId}. |`,
            ''
        ].join('\n'), 'utf8');
        seedStartedTask(repoRoot, parentTaskId);
        writePreflight(repoRoot, parentTaskId, { ...ALL_REVIEW_FLAGS, code: true });
        seedSplitRequiredLatchEvidence(repoRoot, parentTaskId);

        const taskPath = path.join(repoRoot, 'TASK.md');
        const eventPath = path.join(eventsRoot(repoRoot), `${parentTaskId}.jsonl`);
        const taskBeforeInspection = fs.readFileSync(taskPath, 'utf8');
        const eventsBeforeInspection = fs.readFileSync(eventPath, 'utf8');

        const inspection = inspectNextStep({ taskId: parentTaskId, repoRoot });
        const planSha256 = (inspection.commands[0]?.command || '')
            .match(/--effect-plan-sha256\s+["']?([a-f0-9]{64})/u)?.[1] || '';

        assert.equal(inspection.next_gate, 'next-step-effect', inspection.reason);
        assert.match(inspection.reason, /contains 2 ordered effect\(s\)/u);
        assert.equal(fs.readFileSync(taskPath, 'utf8'), taskBeforeInspection);
        assert.equal(fs.readFileSync(eventPath, 'utf8'), eventsBeforeInspection);

        const result = executeNextStepEffects({ taskId: parentTaskId, repoRoot }, planSha256);
        const taskMd = fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8');
        const events = fs.readFileSync(path.join(eventsRoot(repoRoot), `${parentTaskId}.jsonl`), 'utf8');

        assert.equal(result.status, 'DECOMPOSED', result.reason);
        assert.equal(result.next_gate, 'child-task');
        assert.ok(result.commands[0].command.includes(`next-step "${childTaskId}"`));
        assert.ok(taskMd.includes(`| ${parentTaskId} | 🟪 DECOMPOSED |`));
        assert.ok(events.includes('"event_type":"SPLIT_REQUIRED_RESTORED"'));
        assert.ok(events.includes('"event_type":"SPLIT_REQUIRED_CLEARED"'));
    });

    it('keeps strict-decomposition WIP capture and status transition inspection side-effect free', () => {
        const repoRoot = makeTempRepo();
        const taskPath = path.join(repoRoot, 'TASK.md');
        fs.writeFileSync(taskPath, [
            '# TASK.md',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            `| ${TASK_ID} | TODO | P1 | workflow/strict-decomposition | Split parent work | gpt-5.4 | 2026-05-03 | strict | Child tasks: \`${TASK_ID}-1\` and \`${TASK_ID}-2\`. |`,
            `| ${TASK_ID}-1 | TODO | P1 | workflow/parser | Implement parser boundary | gpt-5.4 | 2026-05-03 | strict | Parse the bounded child contract. Child of ${TASK_ID}. |`,
            `| ${TASK_ID}-2 | TODO | P1 | workflow/validation | Validate routing boundary | gpt-5.4 | 2026-05-03 | strict | Validate the independent routing contract. Child of ${TASK_ID}. |`,
            ''
        ].join('\n'), 'utf8');
        fs.writeFileSync(
            path.join(repoRoot, '.gitignore'),
            'garda-agent-orchestrator/runtime/\n',
            'utf8'
        );
        seedStartedTask(repoRoot, TASK_ID);
        const proposedChildTaskIds = [`${TASK_ID}-1`, `${TASK_ID}-2`];
        writeJson(
            path.join(reviewsRoot(repoRoot), `${TASK_ID}-strict-decomposition-decision.json`),
            buildStrictDecompositionDecisionArtifact({
                taskId: TASK_ID,
                decision: 'split-required',
                taskSummary: 'Seeded next-step task',
                reason: 'The parent work is split into two independently executable child packages.',
                scopeRisk: 'The parent has active implementation WIP that must be suspended before child routing.',
                expectedReviewTypes: ['code'],
                atomicityConstraints: ['Suspend the parent before entering either child.'],
                proposedChildTaskIds,
                workPackageContract: {
                    schema_version: 1,
                    finding_obligations: [],
                    work_packages: proposedChildTaskIds.map((childTaskId, index) => ({
                        task_id: childTaskId,
                        profile: 'strict',
                        root_cause_area: `root-cause-${index + 1}`,
                        objective: `Implement child package ${index + 1}.`,
                        scope_obligations: [`Preserve child scope ${index + 1}.`],
                        validation_contract: [`Validate child package ${index + 1}.`],
                        finding_obligation_ids: [],
                        required_review_types: ['code']
                    }))
                }
            })
        );
        execFileSync('git', ['init', '--quiet'], { cwd: repoRoot });
        execFileSync('git', ['add', '.'], { cwd: repoRoot });
        execFileSync('git', [
            '-c', 'user.name=Garda Test',
            '-c', 'user.email=garda-test@example.invalid',
            'commit', '--quiet', '-m', 'fixture baseline'
        ], { cwd: repoRoot });
        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const value = 2;\n', 'utf8');
        writePreflight(
            repoRoot,
            TASK_ID,
            { ...ALL_REVIEW_FLAGS, code: true },
            { changedFiles: ['src/app.ts'] }
        );

        const eventPath = path.join(eventsRoot(repoRoot), `${TASK_ID}.jsonl`);
        const wipRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'wip', TASK_ID);
        const taskBeforeInspection = fs.readFileSync(taskPath, 'utf8');
        const eventsBeforeInspection = fs.readFileSync(eventPath, 'utf8');
        const sourceBeforeInspection = fs.readFileSync(path.join(repoRoot, 'src', 'app.ts'), 'utf8');

        const inspection = inspectNextStep({ taskId: TASK_ID, repoRoot });
        const planSha256 = (inspection.commands[0]?.command || '')
            .match(/--effect-plan-sha256\s+["']?([a-f0-9]{64})/u)?.[1] || '';

        assert.equal(inspection.next_gate, 'next-step-effect', inspection.reason);
        assert.match(inspection.reason, /contains 2 ordered effect\(s\)/u);
        assert.equal(fs.readFileSync(taskPath, 'utf8'), taskBeforeInspection);
        assert.equal(fs.readFileSync(eventPath, 'utf8'), eventsBeforeInspection);
        assert.equal(fs.readFileSync(path.join(repoRoot, 'src', 'app.ts'), 'utf8'), sourceBeforeInspection);
        assert.equal(fs.existsSync(wipRoot), false);

        const result = executeNextStepEffects({ taskId: TASK_ID, repoRoot }, planSha256);

        assert.equal(result.status, 'DECOMPOSED', result.reason);
        assert.equal(result.next_gate, 'child-task');
        assert.ok(fs.readFileSync(taskPath, 'utf8').includes(`| ${TASK_ID} | 🟪 DECOMPOSED |`));
        assert.equal(fs.existsSync(wipRoot), true);
        assert.equal(
            execFileSync('git', ['status', '--short', '--', 'src/app.ts'], {
                cwd: repoRoot,
                encoding: 'utf8'
            }).trim(),
            ''
        );
        const events = fs.readFileSync(eventPath, 'utf8');
        assert.ok(events.includes('"event_type":"SPLIT_REQUIRED_WIP_CAPTURED"'));
        assert.ok(events.includes('"event_type":"STRICT_DECOMPOSITION_SPLIT_ROUTED"'));
    });

    it('restores split-required latch after a parent status is changed to done', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '# TASK.md',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            `| ${TASK_ID} | DONE | P1 | workflow/scope-budget | Add decomposition guard | gpt-5.4 | 2026-05-03 | strict | Latch artifact still exists after a terminal status edit. |`,
            ''
        ].join('\n'), 'utf8');
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        seedSplitRequiredLatchEvidence(repoRoot, TASK_ID);
        seedCompilePass(repoRoot, TASK_ID);
        seedReviewGatePass(repoRoot, TASK_ID);
        seedDocImpactPass(repoRoot, TASK_ID);
        seedCompletionPass(repoRoot, TASK_ID);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const taskMd = fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8');
        const events = fs.readFileSync(path.join(eventsRoot(repoRoot), `${TASK_ID}.jsonl`), 'utf8');

        assert.equal(result.status, 'SPLIT_REQUIRED');
        assert.equal(result.next_gate, 'split-required-latch');
        assert.equal(result.commands.length, 0);
        assert.ok(result.reason.includes('permanent for this task attempt'));
        assert.ok(taskMd.includes(`| ${TASK_ID} | 🟫 SPLIT_REQUIRED |`));
        assert.ok(events.includes('"event_type":"SPLIT_REQUIRED_RESTORED"'));
    });

    it('does not let a hand-edited decomposed status bypass split-required clear evidence', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '# TASK.md',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            '| T-649 | DECOMPOSED | P1 | workflow | Parent | gpt-5.4 | 2026-05-05 | strict | Split into child tasks `T-650` through `T-651`; do not continue the parent. |',
            '| T-650 | DONE | P1 | workflow | Child one | gpt-5.4 | 2026-05-05 | strict | Complete. |',
            '| T-651 | DONE | P1 | workflow | Child two | gpt-5.4 | 2026-05-05 | strict | Complete. |',
            ''
        ].join('\n'), 'utf8');
        seedSplitRequiredLatchEvidence(repoRoot, 'T-649');

        const result = resolveNextStep({ taskId: 'T-649', repoRoot });
        const taskMd = fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8');
        const events = fs.readFileSync(path.join(eventsRoot(repoRoot), 'T-649.jsonl'), 'utf8');

        assert.equal(result.status, 'SPLIT_REQUIRED');
        assert.notEqual(result.status, 'DONE');
        assert.equal(result.next_gate, 'split-required-latch');
        assert.ok(result.reason.includes('permanent for this task attempt'));
        assert.ok(taskMd.includes('| T-649 | 🟫 SPLIT_REQUIRED |'));
        assert.ok(events.includes('"event_type":"SPLIT_REQUIRED_RESTORED"'));
        assert.equal(events.includes('"event_type":"SPLIT_REQUIRED_CLEARED"'), false);
        assert.equal(events.includes('"event_type":"DECOMPOSED_PARENT_COMPLETED"'), false);
    });

    it('blocks split-required parent clearing while the shared TASK.md status lock is held', () => {
        const repoRoot = makeTempRepo();
        const taskPath = path.join(repoRoot, 'TASK.md');
        const lockPath = `${taskPath}.garda-status-sync.lock`;
        const trackedWipPath = path.join(repoRoot, 'src', 'app.ts');
        const trackedWipContent = 'export const value = 2;\n';
        fs.writeFileSync(taskPath, [
            '# TASK.md',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            '| T-980 | 🟫 SPLIT_REQUIRED | P1 | workflow | Parent | gpt-5.4 | 2026-05-05 | strict | Split into child tasks `T-980-1` and `T-980-2`; do not continue the parent. |',
            '| T-980-1 | 🟦 TODO | P1 | workflow/parser | Implement parser boundary | gpt-5.4 | 2026-05-05 | strict | Parse the bounded child contract. |',
            '| T-980-2 | 🟦 TODO | P1 | workflow/validation | Validate routing boundary | gpt-5.4 | 2026-05-05 | strict | Validate the independent routing contract. |',
            ''
        ].join('\n'), 'utf8');
        execFileSync('git', ['init', '--quiet'], { cwd: repoRoot });
        execFileSync('git', ['add', 'TASK.md', 'src/app.ts'], { cwd: repoRoot });
        execFileSync('git', [
            '-c', 'user.name=Garda Test',
            '-c', 'user.email=garda-test@example.invalid',
            'commit', '--quiet', '-m', 'fixture baseline'
        ], { cwd: repoRoot });
        fs.writeFileSync(trackedWipPath, trackedWipContent, 'utf8');
        seedSplitRequiredLatchEvidence(repoRoot, 'T-980');
        fs.writeFileSync(lockPath, 'held by another status sync\n', 'utf8');

        try {
            const result = resolveNextStep({ taskId: 'T-980', repoRoot });
            const taskMd = fs.readFileSync(taskPath, 'utf8');
            const events = fs.readFileSync(path.join(eventsRoot(repoRoot), 'T-980.jsonl'), 'utf8');

            assert.equal(result.status, 'SPLIT_REQUIRED');
            assert.equal(result.next_gate, 'split-required-latch');
            assert.ok(result.reason.includes('Could not acquire TASK.md status-sync lock'));
            assert.ok(taskMd.includes('| T-980 | 🟫 SPLIT_REQUIRED |'));
            assert.equal(fs.readFileSync(trackedWipPath, 'utf8'), trackedWipContent);
            assert.equal(
                execFileSync('git', ['status', '--short', '--', 'src/app.ts'], {
                    cwd: repoRoot,
                    encoding: 'utf8'
                }).trim(),
                'M src/app.ts'
            );
            assert.equal(events.includes('"event_type":"SPLIT_REQUIRED_WIP_CAPTURED"'), false);
            assert.equal(
                fs.existsSync(path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'wip', 'T-980')),
                false
            );
        } finally {
            fs.unlinkSync(lockPath);
        }
    });

    it('blocks spoofed split-required rows with child notes but no latch evidence', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '# TASK.md',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            '| T-634 | 🟫 SPLIT_REQUIRED | P1 | workflow | Parent | gpt-5.4 | 2026-05-05 | strict | Child tasks: `T-635`. |',
            '| T-635 | 🟦 TODO | P1 | workflow | Child | gpt-5.4 | 2026-05-05 | strict | Possible child. |',
            ''
        ].join('\n'), 'utf8');

        const result = resolveNextStep({ taskId: 'T-634', repoRoot });

        assert.equal(result.status, 'BLOCKED');
        assert.equal(result.next_gate, 'split-required-latch');
        assert.match(result.reason, /latch evidence is invalid/i);
        assert.equal(result.commands.length, 0);
        assert.ok(fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8').includes('| T-634 | 🟫 SPLIT_REQUIRED |'));
    });

    it('blocks split-required latch clearing when artifact status-sync fields are inconsistent', () => {
        const repoRoot = makeTempRepo();
        const taskId = 'T-632';
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '# TASK.md',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            '| T-632 | 🟫 SPLIT_REQUIRED | P1 | workflow | Parent | gpt-5.4 | 2026-05-05 | strict | Child tasks: `T-633`. |',
            '| T-633 | 🟦 TODO | P1 | workflow | Child | gpt-5.4 | 2026-05-05 | strict | Possible child. |',
            ''
        ].join('\n'), 'utf8');
        const preflightPath = writePreflight(repoRoot, taskId, { ...ALL_REVIEW_FLAGS, code: true });
        const artifactPath = path.join(reviewsRoot(repoRoot), `${taskId}-split-required.json`);
        const artifactSha256 = writeJsonWithSha(artifactPath, {
            schema_version: 1,
            timestamp_utc: new Date().toISOString(),
            task_id: taskId,
            status: 'SPLIT_REQUIRED',
            guard_kind: 'scope_budget',
            guard_reason: 'test guard',
            raw_guard_summary: 'test guard',
            preflight_path: normalizeForTimeline(preflightPath),
            preflight_sha256: fileSha256(preflightPath),
            materialization_phase: 'complete',
            status_sync: {
                outcome: 'already_synced',
                previous_status: 'SPLIT_REQUIRED',
                next_status: 'TODO',
                error_message: null
            },
            next_actions: [],
            guard_details: {}
        });
        appendEvent(repoRoot, taskId, 'SPLIT_REQUIRED_LATCHED', 'BLOCKED', {
            status: 'SPLIT_REQUIRED',
            guard_kind: 'scope_budget',
            artifact_path: normalizeForTimeline(artifactPath),
            artifact_sha256: artifactSha256
        });

        const result = resolveNextStep({ taskId, repoRoot });

        assert.equal(result.status, 'BLOCKED');
        assert.equal(result.next_gate, 'split-required-latch');
        assert.match(result.reason, /status_sync\.next_status is not SPLIT_REQUIRED/i);
        assert.ok(fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8').includes('| T-632 | 🟫 SPLIT_REQUIRED |'));
    });

    it('does not record split-required latch event when TASK.md status sync fails', () => {
        const repoRoot = makeTempRepo();
        const taskId = 'T-644';
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '# TASK.md',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            '| T-645 | TODO | P1 | workflow | Different task | gpt-5.4 | 2026-05-03 | strict | Present row. |',
            ''
        ].join('\n'), 'utf8');
        const changedFiles = Array.from({ length: 13 }, (_, index) => `src/sync-fail-${index}.ts`);
        for (const filePath of changedFiles) {
            fs.writeFileSync(path.join(repoRoot, filePath), 'export const value = 1;\n', 'utf8');
        }
        const workflowConfig = buildDefaultWorkflowConfig();
        workflowConfig.scope_budget_guard.action = 'BLOCK_FOR_SPLIT';
        workflowConfig.scope_budget_guard.max_files = 12;
        workflowConfig.scope_budget_guard.warn_files = 11;
        workflowConfig.scope_budget_guard.block_files = 12;
        writeJson(path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json'), workflowConfig);
        writeJson(path.join(reviewsRoot(repoRoot), `${taskId}-task-mode.json`), buildTaskModeArtifact({
            taskId,
            entryMode: 'EXPLICIT_TASK_EXECUTION',
            requestedDepth: 2,
            effectiveDepth: 2,
            taskSummary: 'Missing task row split latch',
            startBanner: 'Garda captures my mind',
            provider: 'Codex',
            canonicalSourceOfTruth: 'Codex',
            executionProviderSource: 'explicit_provider',
            runtimeIdentityStatus: 'resolved',
            taskProfile: 'strict',
            profileSelectionSource: 'workspace_active',
            activeProfile: 'strict',
            profileSource: 'built_in',
            runtimeActiveProfile: 'balanced',
            runtimeProfileSource: 'built_in'
        }));
        writeJson(path.join(reviewsRoot(repoRoot), `${taskId}-handshake.json`), { task_id: taskId, status: 'PASS' });
        writeJson(path.join(reviewsRoot(repoRoot), `${taskId}-shell-smoke.json`), { task_id: taskId, status: 'PASS' });
        appendEvent(repoRoot, taskId, 'TASK_MODE_ENTERED');
        seedRulePack(repoRoot, taskId, 'TASK_ENTRY');
        appendEvent(repoRoot, taskId, 'HANDSHAKE_DIAGNOSTICS_RECORDED');
        appendEvent(repoRoot, taskId, 'SHELL_SMOKE_PREFLIGHT_RECORDED');
        const snapshot = getWorkspaceSnapshot(repoRoot, 'explicit_changed_files', true, changedFiles);
        const preflightPath = path.join(reviewsRoot(repoRoot), `${taskId}-preflight.json`);
        writeJson(preflightPath, {
            task_id: taskId,
            detection_source: snapshot.detection_source,
            mode: 'FULL_PATH',
            scope_category: 'code',
            metrics: {
                changed_files_count: snapshot.changed_files.length,
                changed_lines_total: snapshot.changed_lines_total,
                changed_files_sha256: snapshot.changed_files_sha256,
                scope_content_sha256: snapshot.scope_content_sha256,
                scope_sha256: snapshot.scope_sha256
            },
            required_reviews: { ...ALL_REVIEW_FLAGS, code: true, security: true, refactor: true, test: true },
            changed_files: changedFiles,
            review_execution_policy: {
                mode: 'code_first_optional',
                visible_summary_line: 'Review execution policy: code_first_optional'
            },
            profile_selection: {
                task_profile: 'strict',
                profile_selection_source: 'workspace_active',
                effective_profile: 'strict',
                effective_profile_source: 'built_in',
                runtime_active_profile: 'balanced',
                runtime_profile_source: 'built_in'
            },
            budget_forecast: {
                total_estimated_review_tokens: 9000
            }
        });
        appendEvent(repoRoot, taskId, 'PREFLIGHT_CLASSIFIED', 'INFO', {
            output_path: normalizeForTimeline(preflightPath)
        });
        seedPostPreflightRulePack(repoRoot, taskId, preflightPath);
        writeStrictDecompositionDecision(repoRoot, taskId, {
            decision: 'single-cycle',
            taskSummary: 'Missing task row split latch',
            expectedReviewTypes: ['code', 'security', 'refactor', 'test']
        });

        const result = resolveNextStep({ taskId, repoRoot });

        assert.equal(result.status, 'BLOCKED');
        assert.equal(result.next_gate, 'split-required-latch');
        assert.match(result.reason, /TASK\.md status sync failed/i);
        const latch = JSON.parse(fs.readFileSync(path.join(reviewsRoot(repoRoot), `${taskId}-split-required.json`), 'utf8')) as Record<string, unknown>;
        assert.deepEqual(latch.status_sync, {
            outcome: 'task_not_found',
            previous_status: null,
            next_status: 'SPLIT_REQUIRED',
            error_message: null
        });
        const events = fs.readFileSync(path.join(eventsRoot(repoRoot), `${taskId}.jsonl`), 'utf8');
        assert.equal(events.includes('"event_type":"SPLIT_REQUIRED_LATCHED"'), false);
    });

    it('regresses review-cycle auto-split TASK.md sync failure without latch event', () => {
        const repoRoot = makeTempRepo();
        const taskId = 'T-646';
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
                    auto_split_enabled: true
                }
            }
        );
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '# TASK.md',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            '| T-647 | TODO | P1 | workflow | Different task | gpt-5.4 | 2026-05-03 | strict | Present row. |',
            ''
        ].join('\n'), 'utf8');
        seedStartedTask(repoRoot, taskId);
        writePreflight(repoRoot, taskId, { ...ALL_REVIEW_FLAGS, code: true });
        appendEvent(repoRoot, taskId, 'REVIEW_RECORDED', 'FAIL', {
            review_type: 'code',
            reviewer_identity: 'agent:auto-split-code-0',
            review_context_sha256: sha256Text('auto-split-sync-fail-context-0'),
            summary: 'first code failure'
        });
        appendEvent(repoRoot, taskId, 'REVIEW_RECORDED', 'FAIL', {
            review_type: 'code',
            reviewer_identity: 'agent:auto-split-code-1',
            review_context_sha256: sha256Text('auto-split-sync-fail-context-1'),
            summary: 'second code failure'
        });

        const inspection = inspectNextStep({ taskId, repoRoot });
        const planSha256 = (inspection.commands[0]?.command || '')
            .match(/--effect-plan-sha256\s+["']?([a-f0-9]{64})/u)?.[1] || '';

        assert.equal(inspection.next_gate, 'next-step-effect', inspection.reason);
        assert.match(inspection.reason, /contains 2 ordered effect\(s\)/u);
        assert.throws(
            () => executeNextStepEffects({ taskId, repoRoot }, planSha256),
            /executed 1 of 2 expected effects/iu
        );
        const latch = JSON.parse(fs.readFileSync(path.join(reviewsRoot(repoRoot), `${taskId}-split-required.json`), 'utf8')) as Record<string, unknown>;
        assert.equal(latch.guard_kind, 'review_cycle');
        assert.deepEqual(latch.status_sync, {
            outcome: 'task_not_found',
            previous_status: null,
            next_status: 'SPLIT_REQUIRED',
            error_message: null
        });
        const events = fs.readFileSync(path.join(eventsRoot(repoRoot), `${taskId}.jsonl`), 'utf8');
        assert.equal(events.includes('"event_type":"SPLIT_REQUIRED_LATCHED"'), false);
    });

    it('rejects a stale ordered review-cycle plan when full-suite config changes', () => {
        const repoRoot = makeTempRepo();
        const taskId = 'T-648';
        const workflowConfigPath = path.join(
            repoRoot,
            'garda-agent-orchestrator',
            'live',
            'config',
            'workflow-config.json'
        );
        const workflowConfig = {
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
                auto_split_enabled: true
            }
        };
        writeJson(workflowConfigPath, workflowConfig);
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '# TASK.md',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            `| ${taskId} | WIP | P1 | workflow | Review-cycle effect plan | gpt-5.4 | 2026-05-03 | balanced | Active task. |`,
            ''
        ].join('\n'), 'utf8');
        seedStartedTask(repoRoot, taskId);
        writePreflight(repoRoot, taskId, { ...ALL_REVIEW_FLAGS, code: true });
        for (const index of [0, 1]) {
            appendEvent(repoRoot, taskId, 'REVIEW_RECORDED', 'FAIL', {
                review_type: 'code',
                reviewer_identity: `agent:auto-split-code-${index}`,
                review_context_sha256: sha256Text(`auto-split-effect-context-${index}`),
                summary: `code failure ${index + 1}`
            });
        }
        const taskPath = path.join(repoRoot, 'TASK.md');
        const taskBeforeInspection = fs.readFileSync(taskPath, 'utf8');
        const latchPath = path.join(reviewsRoot(repoRoot), `${taskId}-split-required.json`);
        const promptPath = path.join(reviewsRoot(repoRoot), `${taskId}-review-cycle-auto-split-prompt.md`);

        const inspection = inspectNextStep({ taskId, repoRoot });
        const planSha256 = (inspection.commands[0]?.command || '')
            .match(/--effect-plan-sha256\s+["']?([a-f0-9]{64})/u)?.[1] || '';

        assert.equal(inspection.next_gate, 'next-step-effect', inspection.reason);
        assert.match(inspection.reason, /contains 2 ordered effect\(s\)/u);
        assert.equal(fs.readFileSync(taskPath, 'utf8'), taskBeforeInspection);
        assert.equal(fs.existsSync(latchPath), false);
        assert.equal(fs.existsSync(promptPath), false);

        workflowConfig.full_suite_validation.command = 'npm run test:full';
        writeJson(workflowConfigPath, workflowConfig);
        execFileSync('git', ['add', '--', workflowConfigPath], { cwd: repoRoot });
        execFileSync('git', [
            '-c', 'user.name=Garda Test',
            '-c', 'user.email=garda-test@example.invalid',
            'commit', '--quiet', '-m', 'fixture full-suite config change'
        ], { cwd: repoRoot });
        assert.throws(
            () => executeNextStepEffects({ taskId, repoRoot }, planSha256),
            /effect plan is stale/iu
        );
        assert.equal(fs.existsSync(latchPath), false);
        assert.equal(fs.existsSync(promptPath), false);

        const refreshedInspection = inspectNextStep({ taskId, repoRoot });
        const refreshedPlanSha256 = (refreshedInspection.commands[0]?.command || '')
            .match(/--effect-plan-sha256\s+["']?([a-f0-9]{64})/u)?.[1] || '';
        assert.notEqual(refreshedPlanSha256, planSha256);

        const result = executeNextStepEffects({ taskId, repoRoot }, refreshedPlanSha256);

        assert.equal(result.status, 'SPLIT_REQUIRED', result.reason);
        assert.equal(result.next_gate, 'split-required-latch');
        assert.equal(fs.existsSync(latchPath), true);
        assert.equal(fs.existsSync(promptPath), true);
        assert.match(fs.readFileSync(promptPath, 'utf8'), /CurrentState:/u);
        assert.match(fs.readFileSync(promptPath, 'utf8'), /npm run test:full/u);
    });

    it('rejects a quality-checklist effect plan when workflow config changes before execution', () => {
        const repoRoot = makeTempRepo();
        const workflowConfigPath = path.join(
            repoRoot,
            'garda-agent-orchestrator',
            'live',
            'config',
            'workflow-config.json'
        );
        const workflowConfig = buildDefaultWorkflowConfig();
        workflowConfig.optional_quality_checks.enabled = true;
        writeJson(workflowConfigPath, workflowConfig);
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });

        const inspection = inspectNextStep({ taskId: TASK_ID, repoRoot });
        const planSha256 = (inspection.commands[0]?.command || '')
            .match(/--effect-plan-sha256\s+["']?([a-f0-9]{64})/u)?.[1] || '';
        const answersPath = path.join(
            repoRoot,
            'garda-agent-orchestrator',
            'runtime',
            'tmp',
            `${TASK_ID}-quality-checklist-answers.json`
        );
        const questionReferencePath = path.join(
            repoRoot,
            'garda-agent-orchestrator',
            'runtime',
            'tmp',
            `${TASK_ID}-quality-checklist-questions.md`
        );

        assert.equal(inspection.next_gate, 'next-step-effect', inspection.reason);
        assert.match(planSha256, /^[a-f0-9]{64}$/u);
        workflowConfig.optional_quality_checks.review_failure_cadence_interval += 1;
        writeJson(workflowConfigPath, workflowConfig);
        execFileSync('git', ['add', '--', workflowConfigPath], { cwd: repoRoot });
        execFileSync('git', [
            '-c', 'user.name=Garda Test',
            '-c', 'user.email=garda-test@example.invalid',
            'commit', '--quiet', '-m', 'fixture quality config change'
        ], { cwd: repoRoot });

        assert.throws(
            () => executeNextStepEffects({ taskId: TASK_ID, repoRoot }, planSha256),
            /effect plan is stale/iu
        );
        assert.equal(fs.existsSync(answersPath), false);
        assert.equal(fs.existsSync(`${answersPath}.binding.json`), false);
        assert.equal(fs.existsSync(questionReferencePath), false);
    });

    it('prevents replay of current quality-checklist input effects after guarded execution', () => {
        const repoRoot = makeTempRepo();
        const workflowConfig = buildDefaultWorkflowConfig();
        workflowConfig.optional_quality_checks.enabled = true;
        writeJson(
            path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json'),
            workflowConfig
        );
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });

        const inspection = inspectNextStep({ taskId: TASK_ID, repoRoot });
        const planSha256 = (inspection.commands[0]?.command || '')
            .match(/--effect-plan-sha256\s+["']?([a-f0-9]{64})/u)?.[1] || '';

        assert.equal(inspection.next_gate, 'next-step-effect', inspection.reason);
        assert.match(inspection.reason, /quality-checklist/iu);
        executeNextStepEffects({ taskId: TASK_ID, repoRoot }, planSha256);

        const rerun = inspectNextStep({ taskId: TASK_ID, repoRoot });

        assert.notEqual(rerun.next_gate, 'next-step-effect', rerun.reason);
        assert.equal(rerun.next_gate, 'quality-checklist', rerun.reason);
    });

});
