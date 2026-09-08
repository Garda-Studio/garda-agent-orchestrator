import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { syncTaskQueueStatusFromSplitRequiredToDecomposed } from '../../../../src/gates/next-step/next-step-task-queue-status-sync';
import { captureAndSuspendSplitRequiredWip } from '../../../../src/gates/split-required/split-required-wip';
import {
    initializeGitRepo,
    runGit
} from '../../cli/commands/gate-test-repo-bootstrap';
import * as fx from './next-step-review-cycle-fixtures';

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

describe('gates/next-step split-required latch finalization', () => {
    it('preserves done status after gate-owned split-required child completion', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '# TASK.md',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            '| T-652 | SPLIT_REQUIRED | P1 | workflow | Parent | gpt-5.4 | 2026-05-05 | strict | Split into child tasks `T-653` through `T-654`; do not continue the parent. |',
            '| T-653 | TODO | P1 | workflow/parser | Implement parser boundary | gpt-5.4 | 2026-05-05 | strict | Parse the bounded child contract. |',
            '| T-654 | TODO | P1 | workflow/validation | Validate transition boundary | gpt-5.4 | 2026-05-05 | strict | Verify the atomic transition contract. |',
            ''
        ].join('\n'), 'utf8');
        seedSplitRequiredLatchEvidence(repoRoot, 'T-652');
        const decomposedResult = resolveNextStep({ taskId: 'T-652', repoRoot });
        const decomposedTaskMd = fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8')
            .replace('| T-653 | TODO |', '| T-653 | DONE |')
            .replace('| T-654 | TODO |', '| T-654 | DONE |');
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), decomposedTaskMd, 'utf8');
        const doneResult = resolveNextStep({ taskId: 'T-652', repoRoot });
        const stableDoneResult = resolveNextStep({ taskId: 'T-652', repoRoot });
        const taskMd = fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8');
        const events = fs.readFileSync(path.join(eventsRoot(repoRoot), 'T-652.jsonl'), 'utf8');

        assert.equal(decomposedResult.status, 'DECOMPOSED');
        assert.equal(doneResult.status, 'DONE');
        assert.equal(stableDoneResult.status, 'DONE');
        assert.equal(stableDoneResult.next_gate, null);
        assert.ok(taskMd.includes('| T-652 | 🟩 DONE |'));
        assert.ok(events.includes('"event_type":"SPLIT_REQUIRED_CLEARED"'));
        assert.ok(events.includes('"event_type":"DECOMPOSED_PARENT_COMPLETED"'));
        assert.equal((events.match(/"event_type":"SPLIT_REQUIRED_RESTORED"/g) || []).length, 0);
    });

    it('finalizes split-required parents through parent-derived suffixed child tasks', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '# TASK.md',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            '| T-506 | SPLIT_REQUIRED | P1 | workflow | Parent | gpt-5.4 | 2026-05-05 | strict | Split into child tasks `T-506-1` and `T-506-2`; do not continue the parent. |',
            '| T-506-1 | TODO | P1 | workflow/parser | Implement parser boundary | gpt-5.4 | 2026-05-05 | strict | Parse the bounded child contract. |',
            '| T-506-2 | TODO | P1 | workflow/validation | Validate transition boundary | gpt-5.4 | 2026-05-05 | strict | Verify the atomic transition contract. |',
            ''
        ].join('\n'), 'utf8');
        seedSplitRequiredLatchEvidence(repoRoot, 'T-506');

        const decomposedResult = resolveNextStep({ taskId: 'T-506', repoRoot });
        const decomposedTaskMd = fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8')
            .replace('| T-506-1 | TODO |', '| T-506-1 | DONE |')
            .replace('| T-506-2 | TODO |', '| T-506-2 | DONE |');
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), decomposedTaskMd, 'utf8');
        const doneResult = resolveNextStep({ taskId: 'T-506', repoRoot });
        const taskMd = fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8');
        const events = fs.readFileSync(path.join(eventsRoot(repoRoot), 'T-506.jsonl'), 'utf8');

        assert.equal(decomposedResult.status, 'DECOMPOSED');
        assert.equal(doneResult.status, 'DONE');
        assert.ok(taskMd.includes('| T-506 | 🟩 DONE |'));
        assert.ok(events.includes('"event_type":"SPLIT_REQUIRED_CLEARED"'));
        assert.ok(events.includes('"event_type":"DECOMPOSED_PARENT_COMPLETED"'));
    });

    it('finalizes nested decomposed parents when parent-derived leaf children are already done', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '# TASK.md',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            '| T-700 | 🟪 DECOMPOSED | P1 | workflow | Root parent | gpt-5.5 | 2026-05-06 | strict | Execute child tasks `T-700-1` through normal gates. |',
            '| T-700-1 | 🟪 DECOMPOSED | P1 | workflow | Nested parent | gpt-5.5 | 2026-05-06 | strict | Execute child tasks `T-700-1-1` and `T-700-1-2` through normal gates. |',
            '| T-700-1-1 | 🟩 DONE | P1 | workflow | First leaf | gpt-5.5 | 2026-05-06 | strict | Complete. |',
            '| T-700-1-2 | 🟩 DONE | P1 | workflow | Second leaf | gpt-5.5 | 2026-05-06 | strict | Complete. |',
            ''
        ].join('\n'), 'utf8');

        const result = resolveNextStep({ taskId: 'T-700', repoRoot });
        const taskMd = fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8');

        assert.equal(result.status, 'DONE');
        assert.equal(result.next_gate, null);
        assert.ok(taskMd.includes('| T-700 | 🟩 DONE |'));
        assert.ok(taskMd.includes('| T-700-1 | 🟩 DONE |'));
    });

    it('transitions a reset split-required parent to decomposed when child tasks are linked', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(
            path.join(repoRoot, '.gitignore'),
            'garda-agent-orchestrator/runtime/\n',
            'utf8'
        );
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '# TASK.md',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            '| T-646 | TODO | P1 | workflow | Parent | gpt-5.4 | 2026-05-05 | strict | Split into child tasks `T-647` through `T-648`; do not continue the parent. |',
            '| T-647 | TODO | P1 | workflow/parser | Implement parser boundary | gpt-5.4 | 2026-05-05 | strict | Parse the bounded child contract. |',
            '| T-648 | TODO | P1 | workflow/validation | Validate transition boundary | gpt-5.4 | 2026-05-05 | strict | Verify the atomic transition contract. |',
            ''
        ].join('\n'), 'utf8');
        initializeGitRepo(repoRoot);
        const preflightPath = writePreflight(repoRoot, 'T-646', {
            ...ALL_REVIEW_FLAGS,
            code: true
        }, { changedFiles: ['src/app.ts'] });
        const restoredContent = 'export const value = 646;\n';
        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), restoredContent, 'utf8');
        const initialCapture = captureAndSuspendSplitRequiredWip({
            repoRoot,
            taskId: 'T-646',
            preflightPath,
            guardKind: 'scope_budget',
            guardReason: 'Initial permanent-latch capture.'
        });
        assert.equal(initialCapture.status, 'CAPTURED', initialCapture.violations.join('\n'));
        seedSplitRequiredLatchEvidence(repoRoot, 'T-646');
        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), restoredContent, 'utf8');

        const result = resolveNextStep({ taskId: 'T-646', repoRoot });
        const taskMd = fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8');
        const events = fs.readFileSync(path.join(eventsRoot(repoRoot), 'T-646.jsonl'), 'utf8');
        const appStatus = runGit(repoRoot, ['status', '--short', '--', 'src/app.ts']).stdout.trim();

        assert.equal(result.status, 'DECOMPOSED');
        assert.equal(result.next_gate, 'child-task');
        assert.equal(result.commands.length, 1);
        assert.ok(result.commands[0].command.includes('next-step "T-647"'));
        assert.ok(result.reason.includes('stayed permanent after later status/config/scope drift'));
        assert.ok(result.reason.includes('Before entering the selected child task, inspect workflow-config.full_suite_validation.command against that child scope.'));
        assert.ok(result.reason.includes('keep current-child tests covered, exclude suspended siblings, leave an already-suitable command unchanged'));
        assert.ok(taskMd.includes('| T-646 | 🟪 DECOMPOSED |'));
        assert.ok(events.includes('"event_type":"SPLIT_REQUIRED_RESTORED"'));
        assert.ok(events.includes('"event_type":"SPLIT_REQUIRED_CLEARED"'));
        assert.equal((events.match(/"event_type":"SPLIT_REQUIRED_WIP_CAPTURED"/gu) || []).length, 2);
        assert.equal(appStatus, '');
    });

    it('keeps a restored permanent latch active when parent WIP cannot be suspended', () => {
        const repoRoot = makeTempRepo();
        const taskId = 'T-649';
        fs.writeFileSync(
            path.join(repoRoot, '.gitignore'),
            'garda-agent-orchestrator/runtime/\n',
            'utf8'
        );
        fs.writeFileSync(path.join(repoRoot, 'src', 'outside.ts'), 'export const outside = 1;\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '# TASK.md',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            `| ${taskId} | TODO | P1 | workflow | Parent | gpt-5.6-terra | 2026-09-08 | balanced | Child tasks: \`${taskId}-1\` and \`${taskId}-2\`. |`,
            `| ${taskId}-1 | TODO | P1 | workflow/parser | Parser child | gpt-5.6-terra | 2026-09-08 | balanced | Implement parser boundary. |`,
            `| ${taskId}-2 | TODO | P1 | workflow/validation | Validation child | gpt-5.6-terra | 2026-09-08 | balanced | Validate transition boundary. |`,
            ''
        ].join('\n'), 'utf8');
        initializeGitRepo(repoRoot);
        const preflightPath = writePreflight(repoRoot, taskId, {
            ...ALL_REVIEW_FLAGS,
            code: true
        }, { changedFiles: ['src/app.ts'] });
        const initialCapture = captureAndSuspendSplitRequiredWip({
            repoRoot,
            taskId,
            preflightPath,
            guardKind: 'scope_budget',
            guardReason: 'Initial permanent-latch capture.'
        });
        assert.equal(initialCapture.status, 'CAPTURED', initialCapture.violations.join('\n'));
        seedSplitRequiredLatchEvidence(repoRoot, taskId);
        fs.writeFileSync(path.join(repoRoot, 'src', 'outside.ts'), 'export const outside = 2;\n', 'utf8');

        const result = resolveNextStep({ taskId, repoRoot });
        const taskMd = fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8');
        const events = fs.readFileSync(path.join(eventsRoot(repoRoot), `${taskId}.jsonl`), 'utf8');

        assert.equal(result.status, 'SPLIT_REQUIRED');
        assert.equal(result.next_gate, 'split-required-latch');
        assert.match(result.reason, /Parent WIP could not be captured and suspended before child routing/iu);
        assert.match(result.reason, /tracked changes outside current preflight scope: src\/outside\.ts/iu);
        assert.ok(taskMd.includes(`| ${taskId} | 🟫 SPLIT_REQUIRED |`));
        assert.ok(events.includes('SPLIT_REQUIRED_RESTORED'));
        assert.ok(!events.includes('SPLIT_REQUIRED_CLEARED'));
    });

    it('does not clear split-required latch for unrelated task mentions in parent notes', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '# TASK.md',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            '| T-638 | 🟫 SPLIT_REQUIRED | P1 | workflow | Parent | gpt-5.4 | 2026-05-05 | strict | Related to `T-639`. Child tasks still need to be created and linked. |',
            '| T-639 | 🟦 TODO | P1 | workflow | Related task | gpt-5.4 | 2026-05-05 | strict | Independent follow-up. |',
            ''
        ].join('\n'), 'utf8');
        seedSplitRequiredLatchEvidence(repoRoot, 'T-638');

        const result = resolveNextStep({ taskId: 'T-638', repoRoot });
        const text = formatNextStepText(result);

        assert.equal(result.status, 'SPLIT_REQUIRED');
        assert.equal(result.next_gate, 'split-required-latch');
        assert.equal(result.commands.length, 0);
        assert.ok(result.reason.includes('cannot continue through classify, compile, review, full-suite, completion, or final closeout gates'));
        assert.ok(fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8').includes('| T-638 | 🟫 SPLIT_REQUIRED |'));
        assert.ok(text.includes('Status: SPLIT_REQUIRED'));
    });

    it('does not clear split-required latch for follow-up task commands without explicit child wording', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '# TASK.md',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            '| T-636 | 🟫 SPLIT_REQUIRED | P1 | workflow | Parent | gpt-5.4 | 2026-05-05 | strict | Execute `T-637` as a separate follow-up task after this split is planned. |',
            '| T-637 | 🟦 TODO | P1 | workflow | Follow-up task | gpt-5.4 | 2026-05-05 | strict | Independent follow-up. |',
            ''
        ].join('\n'), 'utf8');
        seedSplitRequiredLatchEvidence(repoRoot, 'T-636');

        const result = resolveNextStep({ taskId: 'T-636', repoRoot });

        assert.equal(result.status, 'SPLIT_REQUIRED');
        assert.equal(result.next_gate, 'split-required-latch');
        assert.equal(result.commands.length, 0);
        assert.ok(fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8').includes('| T-636 | 🟫 SPLIT_REQUIRED |'));
    });

    it('clears split-required parent to decomposed when linked child tasks exist', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '# TASK.md',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            '| T-640 | 🟫 SPLIT_REQUIRED | P1 | workflow | Parent | gpt-5.4 | 2026-05-05 | strict | Split into child tasks `T-641` through `T-642`; do not continue the parent. |',
            '| T-641 | 🟦 TODO | P1 | workflow/parser | Implement parser boundary | gpt-5.4 | 2026-05-05 | strict | Parse the bounded child contract. |',
            '| T-642 | 🟦 TODO | P1 | workflow/validation | Validate transition boundary | gpt-5.4 | 2026-05-05 | strict | Verify the atomic transition contract. |',
            ''
        ].join('\n'), 'utf8');
        seedSplitRequiredLatchEvidence(repoRoot, 'T-640');

        const result = resolveNextStep({ taskId: 'T-640', repoRoot });
        const text = formatNextStepText(result);

        assert.equal(result.status, 'DECOMPOSED');
        assert.equal(result.next_gate, 'child-task');
        assert.equal(result.commands.length, 1);
        assert.ok(result.commands[0].command.includes('next-step "T-641"'));
        assert.ok(result.reason.includes('transitioned the parent from SPLIT_REQUIRED to DECOMPOSED'));
        assert.ok(result.reason.includes('Before entering the selected child task, inspect workflow-config.full_suite_validation.command against that child scope.'));
        assert.ok(result.reason.includes('never retarget during an active child cycle'));
        assert.ok(fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8').includes('| T-640 | 🟪 DECOMPOSED |'));
        assert.ok(text.includes('Status: DECOMPOSED'));
    });

    it('recaptures restored parent WIP before routing a linked child task', () => {
        const repoRoot = makeTempRepo();
        const taskId = 'T-644';
        fs.writeFileSync(
            path.join(repoRoot, '.gitignore'),
            'garda-agent-orchestrator/runtime/\n',
            'utf8'
        );
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '# TASK.md',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            `| ${taskId} | SPLIT_REQUIRED | P1 | workflow | Parent | gpt-5.6-terra | 2026-09-08 | balanced | Child tasks: \`${taskId}-1\` and \`${taskId}-2\`. |`,
            `| ${taskId}-1 | TODO | P1 | workflow/parser | Parser child | gpt-5.6-terra | 2026-09-08 | balanced | Implement parser boundary. |`,
            `| ${taskId}-2 | TODO | P1 | workflow/validation | Validation child | gpt-5.6-terra | 2026-09-08 | balanced | Validate transition boundary. |`,
            ''
        ].join('\n'), 'utf8');
        initializeGitRepo(repoRoot);
        const preflightPath = writePreflight(repoRoot, taskId, {
            ...ALL_REVIEW_FLAGS,
            code: true
        }, { changedFiles: ['src/app.ts'] });
        const restoredContent = 'export const value = 2;\n';
        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), restoredContent, 'utf8');
        const initialCapture = captureAndSuspendSplitRequiredWip({
            repoRoot,
            taskId,
            preflightPath,
            guardKind: 'scope_budget',
            guardReason: 'Initial split-required capture.'
        });
        assert.equal(initialCapture.status, 'CAPTURED', initialCapture.violations.join('\n'));
        seedSplitRequiredLatchEvidence(repoRoot, taskId);

        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), restoredContent, 'utf8');
        const result = resolveNextStep({ taskId, repoRoot });
        const appStatus = runGit(repoRoot, ['status', '--short', '--', 'src/app.ts']).stdout.trim();
        const captureEvents = fs.readFileSync(path.join(eventsRoot(repoRoot), `${taskId}.jsonl`), 'utf8')
            .trim()
            .split(/\r?\n/u)
            .map((line) => JSON.parse(line) as Record<string, unknown>)
            .filter((event) => event.event_type === 'SPLIT_REQUIRED_WIP_CAPTURED');
        const latestCaptureDetails = captureEvents.at(-1)?.details as Record<string, unknown> | undefined;
        const latestManifestPath = String(latestCaptureDetails?.manifest_path || '');
        const latestManifest = JSON.parse(fs.readFileSync(latestManifestPath, 'utf8')) as {
            tracked_files: Array<{ path: string; worktree_sha256: string | null }>;
        };

        assert.equal(result.status, 'DECOMPOSED');
        assert.equal(appStatus, '');
        assert.equal(captureEvents.length, 2);
        assert.notEqual(latestManifestPath, initialCapture.manifest_path);
        assert.equal(latestManifest.tracked_files.length, 1);
        assert.equal(latestManifest.tracked_files[0]?.path, 'src/app.ts');
        assert.equal(latestManifest.tracked_files[0]?.worktree_sha256, sha256Text(restoredContent));
    });

    it('keeps a split-required parent latched when WIP cannot be suspended safely', () => {
        const repoRoot = makeTempRepo();
        const taskId = 'T-645';
        fs.writeFileSync(
            path.join(repoRoot, '.gitignore'),
            'garda-agent-orchestrator/runtime/\n',
            'utf8'
        );
        fs.writeFileSync(path.join(repoRoot, 'src', 'outside.ts'), 'export const outside = 1;\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '# TASK.md',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            `| ${taskId} | SPLIT_REQUIRED | P1 | workflow | Parent | gpt-5.6-terra | 2026-09-08 | balanced | Child tasks: \`${taskId}-1\` and \`${taskId}-2\`. |`,
            `| ${taskId}-1 | TODO | P1 | workflow/parser | Parser child | gpt-5.6-terra | 2026-09-08 | balanced | Implement parser boundary. |`,
            `| ${taskId}-2 | TODO | P1 | workflow/validation | Validation child | gpt-5.6-terra | 2026-09-08 | balanced | Validate transition boundary. |`,
            ''
        ].join('\n'), 'utf8');
        initializeGitRepo(repoRoot);
        const preflightPath = writePreflight(repoRoot, taskId, {
            ...ALL_REVIEW_FLAGS,
            code: true
        }, { changedFiles: ['src/app.ts'] });
        const initialCapture = captureAndSuspendSplitRequiredWip({
            repoRoot,
            taskId,
            preflightPath,
            guardKind: 'scope_budget',
            guardReason: 'Initial split-required capture.'
        });
        assert.equal(initialCapture.status, 'CAPTURED', initialCapture.violations.join('\n'));
        seedSplitRequiredLatchEvidence(repoRoot, taskId);
        fs.writeFileSync(path.join(repoRoot, 'src', 'outside.ts'), 'export const outside = 2;\n', 'utf8');

        const result = resolveNextStep({ taskId, repoRoot });
        const taskMd = fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8');
        const events = fs.readFileSync(path.join(eventsRoot(repoRoot), `${taskId}.jsonl`), 'utf8');

        assert.equal(result.status, 'SPLIT_REQUIRED');
        assert.equal(result.next_gate, 'split-required-latch');
        assert.match(result.reason, /Parent WIP could not be captured and suspended before child routing/iu);
        assert.match(result.reason, /tracked changes outside current preflight scope: src\/outside\.ts/iu);
        assert.ok(taskMd.includes(`| ${taskId} | SPLIT_REQUIRED |`));
        assert.ok(!events.includes('SPLIT_REQUIRED_CLEARED'));
    });

    it('keeps the parent and split evidence unchanged when only one child is linked', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '# TASK.md',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            '| T-660 | SPLIT_REQUIRED | P1 | workflow | Parent | gpt-5.4 | 2026-05-05 | strict | Child tasks: `T-660-1`. |',
            '| T-660-1 | TODO | P1 | workflow/parser | Implement parser boundary | gpt-5.4 | 2026-05-05 | strict | Parse the bounded child contract. |',
            ''
        ].join('\n'), 'utf8');
        seedSplitRequiredLatchEvidence(repoRoot, 'T-660');
        const beforeEvents = fs.readFileSync(path.join(eventsRoot(repoRoot), 'T-660.jsonl'), 'utf8');

        const result = resolveNextStep({ taskId: 'T-660', repoRoot });

        assert.equal(result.status, 'SPLIT_REQUIRED');
        assert.ok(result.reason.includes('at least two meaningful'));
        assert.ok(fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8').includes('| T-660 | SPLIT_REQUIRED |'));
        assert.equal(fs.readFileSync(path.join(eventsRoot(repoRoot), 'T-660.jsonl'), 'utf8'), beforeEvents);
    });

    it('keeps the parent and split evidence unchanged when no children are linked', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '# TASK.md',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            '| T-661 | SPLIT_REQUIRED | P1 | workflow | Parent | gpt-5.4 | 2026-05-05 | strict | Split is required, but no child work packages are linked. |',
            ''
        ].join('\n'), 'utf8');
        seedSplitRequiredLatchEvidence(repoRoot, 'T-661');
        const beforeTask = fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8');
        const beforeEvents = fs.readFileSync(path.join(eventsRoot(repoRoot), 'T-661.jsonl'), 'utf8');

        const result = resolveNextStep({ taskId: 'T-661', repoRoot });

        assert.equal(result.status, 'SPLIT_REQUIRED');
        assert.ok(result.reason.includes('at least two meaningful'));
        assert.equal(fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8'), beforeTask);
        assert.equal(fs.readFileSync(path.join(eventsRoot(repoRoot), 'T-661.jsonl'), 'utf8'), beforeEvents);
    });

    it('revalidates the complete child set inside the status write lock', () => {
        const repoRoot = makeTempRepo();
        const taskPath = path.join(repoRoot, 'TASK.md');
        fs.writeFileSync(taskPath, [
            '# TASK.md',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            '| T-665 | SPLIT_REQUIRED | P1 | workflow | Parent | gpt-5.4 | 2026-05-05 | strict | Child tasks: `T-665-1`. |',
            '| T-665-1 | TODO | P1 | workflow/parser | Implement parser boundary | gpt-5.4 | 2026-05-05 | strict | Parse the bounded child contract. |',
            ''
        ].join('\n'), 'utf8');
        const beforeTask = fs.readFileSync(taskPath, 'utf8');

        const result = syncTaskQueueStatusFromSplitRequiredToDecomposed(repoRoot, 'T-665');

        assert.equal(result.outcome, 'write_failed');
        assert.match(result.error_message ?? '', /complete child task set is not valid/i);
        assert.equal(fs.readFileSync(taskPath, 'utf8'), beforeTask);
    });

    it('preserves task-not-found when child validation has no parent row to inspect', () => {
        const repoRoot = makeTempRepo();
        const taskPath = path.join(repoRoot, 'TASK.md');
        fs.writeFileSync(taskPath, [
            '# TASK.md',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            '| T-666 | TODO | P1 | workflow | Existing task | gpt-5.4 | 2026-05-05 | strict | Unrelated row. |',
            ''
        ].join('\n'), 'utf8');
        const beforeTask = fs.readFileSync(taskPath, 'utf8');

        const result = syncTaskQueueStatusFromSplitRequiredToDecomposed(repoRoot, 'T-665');

        assert.equal(result.outcome, 'task_not_found');
        assert.equal(result.error_message, null);
        assert.equal(fs.readFileSync(taskPath, 'utf8'), beforeTask);
    });

    it('rejects placeholder, duplicate-scope, and terminal child rows without partial transition evidence', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '# TASK.md',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            '| T-670 | SPLIT_REQUIRED | P1 | workflow | Parent | gpt-5.4 | 2026-05-05 | strict | Child tasks: `T-670-1`, `T-670-2`, `T-670-3`, and `T-670-4`. |',
            '| T-670-1 | TODO | P1 | workflow | First child | gpt-5.4 | 2026-05-05 | strict | Placeholder-style ordinal child. |',
            '| T-670-2 | DONE | P1 | workflow/security | Validate trust boundary | gpt-5.4 | 2026-05-05 | strict | Already terminal. |',
            '| T-670-3 | TODO | P1 | workflow/parser | Implement parser boundary | gpt-5.4 | 2026-05-05 | strict | First duplicate scope. |',
            '| T-670-4 | TODO | P1 | workflow/parser | Implement parser boundary | gpt-5.4 | 2026-05-05 | strict | Second duplicate scope. |',
            ''
        ].join('\n'), 'utf8');
        seedSplitRequiredLatchEvidence(repoRoot, 'T-670');
        const beforeEvents = fs.readFileSync(path.join(eventsRoot(repoRoot), 'T-670.jsonl'), 'utf8');

        const result = resolveNextStep({ taskId: 'T-670', repoRoot });

        assert.equal(result.status, 'SPLIT_REQUIRED');
        assert.ok(result.reason.includes('explicit operator'));
        assert.ok(fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8').includes('| T-670 | SPLIT_REQUIRED |'));
        assert.equal(fs.readFileSync(path.join(eventsRoot(repoRoot), 'T-670.jsonl'), 'utf8'), beforeEvents);
    });

});
