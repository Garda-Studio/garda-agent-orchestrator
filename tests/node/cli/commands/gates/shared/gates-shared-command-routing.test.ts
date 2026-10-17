import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
    EXIT_GATE_FAILURE} from '../../../../../../src/cli/exit-codes';
import {
    runCompileGateCommand,
    runLogTaskEventCommand,
    runRequiredReviewsCheckCommand} from '../../../../../../src/cli/commands/gates';
import { appendTaskEvent } from '../../../../../../src/gate-runtime/task-events';
import { cleanupTerminalCompileLogs, cleanupTerminalReviewTempOutputs } from '../../../../../../src/cli/gate-cli/gates-artifacts';
import { writeOptionalSkillSelectionArtifact } from '../../../../../../src/runtime/optional-skill-selection';

import {
    createTempRepo,
    removeTempRepoWithRetry,
    writeBudgetOutputFilters,
    seedTaskQueue,
    seedInitAnswers,
    getReviewsRoot,
    getOrchestratorRoot,
    runEnterTaskMode,
    writePreflight,
    writeCleanReviewArtifact,
    loadTaskEntryRulePack,
    loadPostPreflightRulePack,
    runHandshakeForTask,
    runShellSmokeForTask,
    readTaskTimelineEvents,
    runCliWithCapturedOutput,
    ageFixturePath
} from '../../gate-test-helpers';






// Manual review-context fixtures are used only by CLI routing/receipt tests that
// do not exercise production review-context construction.













function seedNodeBackendOptionalSkillFixture(repoRoot: string, policyMode: 'advisory' | 'required' | 'strict' | 'off' = 'advisory') {
    const orchestratorRoot = getOrchestratorRoot(repoRoot);
    const configDir = path.join(orchestratorRoot, 'live', 'config');
    const skillRoot = path.join(orchestratorRoot, 'live', 'skills', 'node-backend');
    fs.mkdirSync(configDir, { recursive: true });
    fs.mkdirSync(skillRoot, { recursive: true });
    fs.writeFileSync(
        path.join(configDir, 'garda.config.json'),
        JSON.stringify({
            version: 1,
            configs: {
                'optional-skill-selection-policy': 'optional-skill-selection-policy.json',
                'skill-packs': 'skill-packs.json'
            }
        }, null, 2),
        'utf8'
    );
    fs.writeFileSync(
        path.join(configDir, 'skill-packs.json'),
        JSON.stringify({ version: 1, installed_packs: ['node-backend'] }, null, 2),
        'utf8'
    );
    fs.writeFileSync(
        path.join(configDir, 'optional-skill-selection-policy.json'),
        JSON.stringify({ version: 1, mode: policyMode }, null, 2),
        'utf8'
    );
    fs.writeFileSync(
        path.join(skillRoot, 'skill.json'),
        JSON.stringify({
            id: 'node-backend',
            pack: 'node-backend',
            name: 'Node Backend',
            summary: 'Node backend API implementation helper.',
            tags: ['node', 'backend', 'api'],
            aliases: ['node-backend', 'node'],
            task_signals: ['request validation', 'api endpoint', 'node-backend'],
            changed_path_signals: ['src/api/', 'orders.ts'],
            references: [],
            cost_hint: 'low',
            priority: 50,
            autoload: 'suggest'
        }, null, 2),
        'utf8'
    );
    fs.writeFileSync(path.join(skillRoot, 'SKILL.md'), '# Node Backend\n', 'utf8');
    return path.join(skillRoot, 'SKILL.md');
}

describe('cli/commands/gates', () => {
    it('activate-optional-skill records telemetry only for currently selected skills', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-901-optional-skill-activate';
        try {
            seedTaskQueue(repoRoot, taskId);
            const taskPath = path.join(repoRoot, 'TASK.md');
            fs.writeFileSync(
                taskPath,
                fs.readFileSync(taskPath, 'utf8').replace(
                    'Update app flow',
                    'Implement request validation for a Node.js API endpoint'
                ),
                'utf8'
            );
            seedInitAnswers(repoRoot);
            const expectedSkillPath = seedNodeBackendOptionalSkillFixture(repoRoot, 'advisory');
            const preflightPath = writePreflight(repoRoot, taskId, {
                changed_files: ['src/api/orders.ts'],
                required_reviews: {}
            });
            writeOptionalSkillSelectionArtifact(getOrchestratorRoot(repoRoot), taskId, {
                taskText: 'Implement request validation for a Node.js API endpoint',
                changedPaths: ['src/api/orders.ts'],
                preflightPath
            });

            const result = await runCliWithCapturedOutput(
                ['gate', 'activate-optional-skill', '--task-id', taskId, '--skill-id', 'node-backend'],
                { cwd: repoRoot }
            );

            assert.equal(result.exitCode, 0);
            assert.equal(result.errors.length, 0);
            const combinedOutput = result.logs.join('\n');
            assert.ok(combinedOutput.includes('Status: ACTIVATED'));
            assert.ok(combinedOutput.includes(`SkillPath: ${expectedSkillPath.replace(/\\/g, '/')}`));

            const taskEvents = readTaskTimelineEvents(repoRoot, taskId);
            assert.ok(taskEvents.some((event) => (
                event.event_type === 'SKILL_SELECTED'
                && (event.details as Record<string, unknown> | null)?.skill_id === 'node-backend'
                && (event.details as Record<string, unknown> | null)?.trigger_reason === 'optional_skill_selection'
            )));
            assert.ok(taskEvents.every((event) => (
                event.event_type !== 'SKILL_REFERENCE_LOADED'
                || (event.details as Record<string, unknown> | null)?.trigger_reason !== 'optional_task_skill'
            )));
        } finally {
            removeTempRepoWithRetry(repoRoot);
        }
    });

    it('activate-optional-skill rejects post-diff optional-skill suggestions', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-901-optional-skill-activate-post-diff';
        try {
            seedTaskQueue(repoRoot, taskId);
            const taskPath = path.join(repoRoot, 'TASK.md');
            fs.writeFileSync(
                taskPath,
                fs.readFileSync(taskPath, 'utf8').replace(
                    'Update app flow',
                    'Implement request validation for a Node.js API endpoint'
                ),
                'utf8'
            );
            seedInitAnswers(repoRoot);
            seedNodeBackendOptionalSkillFixture(repoRoot, 'advisory');
            const preflightPath = writePreflight(repoRoot, taskId, {
                changed_files: ['src/api/orders.ts'],
                required_reviews: {}
            });
            writeOptionalSkillSelectionArtifact(getOrchestratorRoot(repoRoot), taskId, {
                taskText: 'Implement request validation for a Node.js API endpoint',
                changedPaths: ['src/api/orders.ts'],
                selectionPhase: 'post_diff',
                pathEvidenceSource: 'actual_changed_files',
                preflightPath
            });

            const result = await runCliWithCapturedOutput(
                ['gate', 'activate-optional-skill', '--task-id', taskId, '--skill-id', 'node-backend'],
                { cwd: repoRoot }
            );

            assert.equal(result.exitCode, EXIT_GATE_FAILURE);
            assert.match(result.errors.join('\n'), /post-diff changed paths for self-check only/i);
            assert.equal(
                fs.existsSync(path.join(getOrchestratorRoot(repoRoot), 'runtime', 'task-events', `${taskId}.jsonl`)),
                false
            );
        } finally {
            removeTempRepoWithRetry(repoRoot);
        }
    });

    it('decline-optional-skill records deliberate non-use for advisory selected optional skills', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-901-optional-skill-decline';
        try {
            seedTaskQueue(repoRoot, taskId);
            const taskPath = path.join(repoRoot, 'TASK.md');
            fs.writeFileSync(
                taskPath,
                fs.readFileSync(taskPath, 'utf8').replace(
                    'Update app flow',
                    'Implement request validation for a Node.js API endpoint'
                ),
                'utf8'
            );
            seedInitAnswers(repoRoot);
            seedNodeBackendOptionalSkillFixture(repoRoot, 'advisory');
            const preflightPath = writePreflight(repoRoot, taskId, {
                changed_files: ['src/api/orders.ts'],
                required_reviews: {}
            });
            writeOptionalSkillSelectionArtifact(getOrchestratorRoot(repoRoot), taskId, {
                taskText: 'Implement request validation for a Node.js API endpoint',
                changedPaths: ['src/api/orders.ts'],
                preflightPath
            });

            const result = await runCliWithCapturedOutput(
                ['gate', 'decline-optional-skill', '--task-id', taskId, '--skill-id', 'node-backend', '--reason', 'not needed after reading task scope'],
                { cwd: repoRoot }
            );

            assert.equal(result.exitCode, 0);
            assert.equal(result.errors.length, 0);
            assert.match(result.logs.join('\n'), /Status: DECLINED/u);
            const taskEvents = readTaskTimelineEvents(repoRoot, taskId);
            assert.ok(taskEvents.some((event) => (
                event.event_type === 'SKILL_DECLINED'
                && (event.details as Record<string, unknown> | null)?.skill_id === 'node-backend'
                && (event.details as Record<string, unknown> | null)?.trigger_reason === 'optional_skill_selection'
                && (event.details as Record<string, unknown> | null)?.reason === 'not needed after reading task scope'
            )));
        } finally {
            removeTempRepoWithRetry(repoRoot);
        }
    });

    it('activate-optional-skill rejects activation after an explicit advisory decline', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-901-optional-skill-activate-after-decline';
        try {
            seedTaskQueue(repoRoot, taskId);
            const taskPath = path.join(repoRoot, 'TASK.md');
            fs.writeFileSync(
                taskPath,
                fs.readFileSync(taskPath, 'utf8').replace(
                    'Update app flow',
                    'Implement request validation for a Node.js API endpoint'
                ),
                'utf8'
            );
            seedInitAnswers(repoRoot);
            seedNodeBackendOptionalSkillFixture(repoRoot, 'advisory');
            const preflightPath = writePreflight(repoRoot, taskId, {
                changed_files: ['src/api/orders.ts'],
                required_reviews: {}
            });
            writeOptionalSkillSelectionArtifact(getOrchestratorRoot(repoRoot), taskId, {
                taskText: 'Implement request validation for a Node.js API endpoint',
                changedPaths: ['src/api/orders.ts'],
                preflightPath
            });

            const declineResult = await runCliWithCapturedOutput(
                ['gate', 'decline-optional-skill', '--task-id', taskId, '--skill-id', 'node-backend', '--reason', 'not used'],
                { cwd: repoRoot }
            );
            assert.equal(declineResult.exitCode, 0);

            const result = await runCliWithCapturedOutput(
                ['gate', 'activate-optional-skill', '--task-id', taskId, '--skill-id', 'node-backend'],
                { cwd: repoRoot }
            );

            assert.equal(result.exitCode, EXIT_GATE_FAILURE);
            assert.match(result.errors.join('\n'), /activation after decline is not allowed/i);
        } finally {
            removeTempRepoWithRetry(repoRoot);
        }
    });

    it('decline-optional-skill rejects decline after current-cycle activation', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-901-optional-skill-decline-after-activation';
        try {
            seedTaskQueue(repoRoot, taskId);
            const taskPath = path.join(repoRoot, 'TASK.md');
            fs.writeFileSync(
                taskPath,
                fs.readFileSync(taskPath, 'utf8').replace(
                    'Update app flow',
                    'Implement request validation for a Node.js API endpoint'
                ),
                'utf8'
            );
            seedInitAnswers(repoRoot);
            seedNodeBackendOptionalSkillFixture(repoRoot, 'advisory');
            const preflightPath = writePreflight(repoRoot, taskId, {
                changed_files: ['src/api/orders.ts'],
                required_reviews: {}
            });
            writeOptionalSkillSelectionArtifact(getOrchestratorRoot(repoRoot), taskId, {
                taskText: 'Implement request validation for a Node.js API endpoint',
                changedPaths: ['src/api/orders.ts'],
                preflightPath
            });

            const activateResult = await runCliWithCapturedOutput(
                ['gate', 'activate-optional-skill', '--task-id', taskId, '--skill-id', 'node-backend'],
                { cwd: repoRoot }
            );
            assert.equal(activateResult.exitCode, 0);

            const result = await runCliWithCapturedOutput(
                ['gate', 'decline-optional-skill', '--task-id', taskId, '--skill-id', 'node-backend', '--reason', 'not used'],
                { cwd: repoRoot }
            );

            assert.equal(result.exitCode, EXIT_GATE_FAILURE);
            assert.match(result.errors.join('\n'), /decline is not allowed after activation/i);
        } finally {
            removeTempRepoWithRetry(repoRoot);
        }
    });

    it('decline-optional-skill rejects same-selection activation across a preflight refresh', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-901-optional-skill-decline-after-refresh-activation';
        try {
            seedTaskQueue(repoRoot, taskId);
            const taskPath = path.join(repoRoot, 'TASK.md');
            fs.writeFileSync(
                taskPath,
                fs.readFileSync(taskPath, 'utf8').replace(
                    'Update app flow',
                    'Implement request validation for a Node.js API endpoint'
                ),
                'utf8'
            );
            seedInitAnswers(repoRoot);
            seedNodeBackendOptionalSkillFixture(repoRoot, 'advisory');
            const preflightPath = writePreflight(repoRoot, taskId, {
                changed_files: ['src/api/orders.ts'],
                required_reviews: {}
            });
            writeOptionalSkillSelectionArtifact(getOrchestratorRoot(repoRoot), taskId, {
                taskText: 'Implement request validation for a Node.js API endpoint',
                changedPaths: ['src/api/orders.ts'],
                preflightPath
            });

            const activateResult = await runCliWithCapturedOutput(
                ['gate', 'activate-optional-skill', '--task-id', taskId, '--skill-id', 'node-backend'],
                { cwd: repoRoot }
            );
            assert.equal(activateResult.exitCode, 0);
            appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'PREFLIGHT_CLASSIFIED', 'PASS', 'refreshed preflight', {
                output_path: preflightPath.replace(/\\/g, '/')
            });

            const result = await runCliWithCapturedOutput(
                ['gate', 'decline-optional-skill', '--task-id', taskId, '--skill-id', 'node-backend', '--reason', 'not used'],
                { cwd: repoRoot }
            );

            assert.equal(result.exitCode, EXIT_GATE_FAILURE);
            assert.match(result.errors.join('\n'), /decline is not allowed after activation/i);
        } finally {
            removeTempRepoWithRetry(repoRoot);
        }
    });

    it('decline-optional-skill rejects mandatory selected optional skills', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-901-optional-skill-decline-mandatory';
        try {
            seedTaskQueue(repoRoot, taskId);
            const taskPath = path.join(repoRoot, 'TASK.md');
            fs.writeFileSync(
                taskPath,
                fs.readFileSync(taskPath, 'utf8').replace(
                    'Update app flow',
                    'Implement request validation for a Node.js API endpoint'
                ),
                'utf8'
            );
            seedInitAnswers(repoRoot);
            seedNodeBackendOptionalSkillFixture(repoRoot, 'required');
            const preflightPath = writePreflight(repoRoot, taskId, {
                changed_files: ['src/api/orders.ts'],
                required_reviews: {}
            });
            writeOptionalSkillSelectionArtifact(getOrchestratorRoot(repoRoot), taskId, {
                taskText: 'Implement request validation for a Node.js API endpoint',
                changedPaths: ['src/api/orders.ts'],
                preflightPath
            });

            const result = await runCliWithCapturedOutput(
                ['gate', 'decline-optional-skill', '--task-id', taskId, '--skill-id', 'node-backend', '--reason', 'not used'],
                { cwd: repoRoot }
            );

            assert.equal(result.exitCode, EXIT_GATE_FAILURE);
            assert.match(result.errors.join('\n'), /policy is mandatory/i);
        } finally {
            removeTempRepoWithRetry(repoRoot);
        }
    });

    it('activate-optional-skill rejects a stale optional-skill artifact that no longer matches the current preflight', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-901-optional-skill-activate-stale-preflight';
        try {
            seedTaskQueue(repoRoot, taskId);
            seedInitAnswers(repoRoot);
            seedNodeBackendOptionalSkillFixture(repoRoot, 'advisory');
            const preflightPath = writePreflight(repoRoot, taskId, {
                changed_files: ['src/api/orders.ts'],
                required_reviews: {}
            });
            const artifact = writeOptionalSkillSelectionArtifact(getOrchestratorRoot(repoRoot), taskId, {
                taskText: 'Implement request validation for a Node.js API endpoint',
                changedPaths: ['src/api/orders.ts'],
                preflightPath
            });
            fs.writeFileSync(
                artifact.artifactPath,
                JSON.stringify({
                    ...artifact.payload,
                    preflight_sha256: 'stale-preflight-hash'
                }, null, 2),
                'utf8'
            );

            const result = await runCliWithCapturedOutput(
                ['gate', 'activate-optional-skill', '--task-id', taskId, '--skill-id', 'node-backend'],
                { cwd: repoRoot }
            );

            assert.equal(result.exitCode, EXIT_GATE_FAILURE);
            assert.match(result.errors.join('\n'), /current preflight artifact hash/i);
        } finally {
            removeTempRepoWithRetry(repoRoot);
        }
    });

    it('activate-optional-skill rejects a stale optional-skill artifact that no longer matches the current TASK.md title', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-901-optional-skill-activate-stale-task-text';
        try {
            seedTaskQueue(repoRoot, taskId);
            const taskPath = path.join(repoRoot, 'TASK.md');
            fs.writeFileSync(
                taskPath,
                fs.readFileSync(taskPath, 'utf8').replace(
                    'Update app flow',
                    'Implement request validation for a Node.js API endpoint'
                ),
                'utf8'
            );
            seedInitAnswers(repoRoot);
            seedNodeBackendOptionalSkillFixture(repoRoot, 'advisory');
            const preflightPath = writePreflight(repoRoot, taskId, {
                changed_files: ['docs/landing.md'],
                required_reviews: {}
            });
            writeOptionalSkillSelectionArtifact(getOrchestratorRoot(repoRoot), taskId, {
                taskText: 'Implement request validation for a Node.js API endpoint',
                changedPaths: ['docs/landing.md'],
                preflightPath
            });
            fs.writeFileSync(
                taskPath,
                fs.readFileSync(taskPath, 'utf8').replace(
                    'Implement request validation for a Node.js API endpoint',
                    'Refresh landing-page copy for the marketing site'
                ),
                'utf8'
            );

            const result = await runCliWithCapturedOutput(
                ['gate', 'activate-optional-skill', '--task-id', taskId, '--skill-id', 'node-backend'],
                { cwd: repoRoot }
            );

            assert.equal(result.exitCode, EXIT_GATE_FAILURE);
            assert.match(result.errors.join('\n'), /current task summary hash/i);
        } finally {
            removeTempRepoWithRetry(repoRoot);
        }
    });

    it('applies budget tiers to review gate telemetry', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903-budget';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        const preflightPath = writePreflight(repoRoot, taskId, {
            budget_forecast: {
                task_id: taskId,
                requested_depth: 1,
                effective_depth: 1,
                depth_escalated: false,
                path_mode: 'FULL_PATH',
                changed_files_count: 1,
                changed_lines_total: 3,
                required_reviews: ['code'],
                review_budget_estimates: [],
                total_estimated_review_tokens: 400,
                compile_gate_estimated_tokens: 300,
                total_forecast_tokens: 700,
                token_economy_enabled: true,
                token_economy_active_for_depth: true,
                forecast_savings_estimate: 200,
                effective_forecast_tokens: 500
            }
        });
        const commandsPath = path.join(repoRoot, 'commands-review-budget.md');
        const outputFiltersPath = writeBudgetOutputFilters(repoRoot);
        fs.writeFileSync(commandsPath, [
            '### Compile Gate (Mandatory)',
            '```bash',
            'node -e "console.log(\'budget ok\')"',
            '```'
        ].join('\n'), 'utf8');

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Budget telemetry check'
        });
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        assert.equal(loadPostPreflightRulePack(repoRoot, taskId, preflightPath).exitCode, 0);
        await runCompileGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        writeCleanReviewArtifact(repoRoot, taskId, 'code', 'REVIEW PASSED');

        const result = runRequiredReviewsCheckCommand({
            repoRoot,
            taskId,
            preflightPath,
            codeReviewVerdict: 'REVIEW PASSED',
            reviewAuthorshipAttestationJson: '{"code":true}',
            outputFiltersPath,
            emitMetrics: false
        });

        const evidencePath = path.join(getReviewsRoot(repoRoot), `${taskId}-review-gate.json`);
        const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
        assert.equal(result.exitCode, 0);
        assert.equal(evidence.status, 'PASSED');
        assert.equal(evidence.selected_budget_tier, 'tight');

        removeTempRepoWithRetry(repoRoot);
    });

    it('keeps terminal cleanup and command audit separate from public reserved-event admission', () => {
        for (const eventType of ['TASK_DONE', 'TASK_BLOCKED'] as const) {
            const repoRoot = createTempRepo();
            const taskId = `T-904-${eventType.toLowerCase().replace(/_/gu, '-')}`;
            const activeForeignTaskId = 'T-foreign-active';
            const staleForeignTaskId = 'T-foreign-stale';
            const reviewsRoot = getReviewsRoot(repoRoot);
            fs.mkdirSync(reviewsRoot, { recursive: true });
            const reviewTempRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'tmp', 'reviews');
            const stagedReviewOutputPath = path.join(reviewTempRoot, taskId, 'code', 'review-output.md');
            const foreignReviewOutputPath = path.join(reviewTempRoot, 'scratch-output.md');
            const activeForeignReviewOutputPath = path.join(reviewTempRoot, 'session-1', activeForeignTaskId, 'code', 'review-output.md');
            const staleForeignReviewOutputPath = path.join(reviewTempRoot, `${staleForeignTaskId}-code-output.md`);
            const unattributedStaleReviewOutputPath = path.join(reviewTempRoot, 'session-42', 'review-output.md');
            const reviewTypeSegmentTaskId = 'T-904-security';
            const reviewTypeSegmentOutputPath = path.join(reviewTempRoot, `${reviewTypeSegmentTaskId}-security-output.md`);
            fs.mkdirSync(path.dirname(stagedReviewOutputPath), { recursive: true });
            fs.mkdirSync(path.dirname(activeForeignReviewOutputPath), { recursive: true });
            fs.mkdirSync(path.dirname(unattributedStaleReviewOutputPath), { recursive: true });
            fs.writeFileSync(stagedReviewOutputPath, 'temporary reviewer output\n', 'utf8');
            fs.writeFileSync(foreignReviewOutputPath, 'leave unrelated reviewer output alone\n', 'utf8');
            fs.writeFileSync(activeForeignReviewOutputPath, 'keep active foreign reviewer output\n', 'utf8');
            fs.writeFileSync(staleForeignReviewOutputPath, 'delete stale foreign reviewer output\n', 'utf8');
            fs.writeFileSync(unattributedStaleReviewOutputPath, 'retain unattributed stale reviewer output\n', 'utf8');
            fs.writeFileSync(reviewTypeSegmentOutputPath, 'retain sibling task reviewer output with review-type segment\n', 'utf8');
            ageFixturePath(activeForeignReviewOutputPath, 25 * 60 * 60 * 1000);
            ageFixturePath(staleForeignReviewOutputPath, 25 * 60 * 60 * 1000);
            ageFixturePath(unattributedStaleReviewOutputPath, 25 * 60 * 60 * 1000);
            ageFixturePath(reviewTypeSegmentOutputPath, 25 * 60 * 60 * 1000);
            appendTaskEvent(getOrchestratorRoot(repoRoot), activeForeignTaskId, 'TASK_MODE_ENTERED', 'PASS', 'foreign task started', {});
            appendTaskEvent(getOrchestratorRoot(repoRoot), activeForeignTaskId, 'STATUS_CHANGED', 'INFO', 'foreign task entered review', {
                previous_status: 'IN_PROGRESS',
                new_status: 'IN_REVIEW'
            });
            appendTaskEvent(getOrchestratorRoot(repoRoot), reviewTypeSegmentTaskId, 'TASK_MODE_ENTERED', 'PASS', 'sibling task started', {});
            appendTaskEvent(getOrchestratorRoot(repoRoot), reviewTypeSegmentTaskId, 'STATUS_CHANGED', 'INFO', 'sibling task entered review', {
                previous_status: 'IN_PROGRESS',
                new_status: 'IN_REVIEW'
            });
            fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
                '| ID | Status | Priority | Area | Title | Assignee | Updated | Profile | Notes |',
                '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
                `| ${taskId} | IN_REVIEW | P1 | test | Current review task | unassigned | 2026-03-28 | default | fixture |`,
                `| ${activeForeignTaskId} | DONE | P1 | test | Active foreign review task with stale queue status | unassigned | 2026-03-28 | default | fixture |`,
                `| ${staleForeignTaskId} | DONE | P1 | test | Stale foreign review task | unassigned | 2026-03-28 | default | fixture |`,
                `| ${reviewTypeSegmentTaskId} | DONE | P1 | test | Review-type segment active sibling with stale queue status | unassigned | 2026-03-28 | default | fixture |`
            ].join('\n'), 'utf8');
            const compileOutputPath = path.join(reviewsRoot, `${taskId}-compile-output.log`);
            fs.writeFileSync(compileOutputPath, 'temporary compile output\n', 'utf8');
            fs.writeFileSync(path.join(reviewsRoot, `${taskId}-compile-gate.json`), JSON.stringify({
                task_id: taskId,
                compile_output_path: `garda-agent-orchestrator/runtime/reviews/${taskId}-compile-output.log`
            }, null, 2), 'utf8');

            const eventsPath = path.join(getOrchestratorRoot(repoRoot), 'runtime', 'task-events', `${taskId}.jsonl`);
            assert.equal(fs.existsSync(eventsPath), false);
            assert.throws(() => runLogTaskEventCommand({
                repoRoot,
                taskId,
                eventType,
                outcome: eventType === 'TASK_DONE' ? 'PASS' : 'BLOCKED'
            }), /reserved and cannot be emitted via log-task-event/u);
            assert.equal(fs.existsSync(eventsPath), false);
            for (const retainedPath of [compileOutputPath, stagedReviewOutputPath, foreignReviewOutputPath,
                activeForeignReviewOutputPath, staleForeignReviewOutputPath, unattributedStaleReviewOutputPath,
                reviewTypeSegmentOutputPath]) {
                assert.equal(fs.existsSync(retainedPath), true);
            }

            const result = runLogTaskEventCommand({
                repoRoot,
                taskId,
                eventType: 'CLEANUP_AUDIT_NOTE',
                outcome: 'INFO',
                detailsJson: JSON.stringify({
                    command: 'docker logs api',
                    command_mode: 'scan'
                })
            });

            const payload = JSON.parse(result.outputText);
            assert.equal(result.exitCode, 0);
            assert.equal(payload.status, 'TASK_EVENT_LOGGED');
            assert.equal(payload.event_type, 'CLEANUP_AUDIT_NOTE');
            assert.equal(payload.command_policy_audit.warning_count > 0, true);
            const compileCleanup = cleanupTerminalCompileLogs(repoRoot, taskId);
            const reviewCleanup = cleanupTerminalReviewTempOutputs(repoRoot, taskId);
            assert.deepEqual(compileCleanup.errors, []);
            assert.deepEqual(reviewCleanup.errors, []);
            assert.equal(compileCleanup.deleted_paths.length, 1);
            assert.deepEqual(
                reviewCleanup.deleted_paths,
                [
                    stagedReviewOutputPath.replace(/\\/g, '/'),
                    staleForeignReviewOutputPath.replace(/\\/g, '/')
                ].sort()
            );
            assert.equal(reviewCleanup.stale_deleted_paths.length, 1);
            assert.deepEqual(
                reviewCleanup.retained_paths,
                [
                    activeForeignReviewOutputPath.replace(/\\/g, '/'),
                    foreignReviewOutputPath.replace(/\\/g, '/'),
                    unattributedStaleReviewOutputPath.replace(/\\/g, '/'),
                    reviewTypeSegmentOutputPath.replace(/\\/g, '/')
                ].sort()
            );
            assert.equal(fs.existsSync(compileOutputPath), false);
            assert.equal(fs.existsSync(stagedReviewOutputPath), false);
            assert.equal(fs.existsSync(foreignReviewOutputPath), true);
            assert.equal(fs.existsSync(activeForeignReviewOutputPath), true);
            assert.equal(fs.existsSync(staleForeignReviewOutputPath), false);
            assert.equal(fs.existsSync(unattributedStaleReviewOutputPath), true);
            assert.equal(fs.existsSync(reviewTypeSegmentOutputPath), true);

            removeTempRepoWithRetry(repoRoot);
        }
    });

    it('rejects reviewer provenance events through the public log-task-event gate', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904-log-task-event-reviewer-provenance';

        for (const eventType of [
            'REVIEWER_INVOCATION_ATTESTED',
            'reviewer_invocation_attested',
            'REVIEWER_DELEGATION_ROUTED',
            'reviewer_delegation_routed',
            'REVIEWER_LAUNCH_INPUT_PINNED',
            'reviewer_launch_input_pinned',
            'REVIEWER_DELEGATION_STARTED',
            'reviewer_delegation_started',
            'REVIEWER_LAUNCH_COMPLETED',
            'reviewer_launch_completed',
            'REVIEWER_LAUNCH_FAILED',
            'reviewer_launch_failed'
        ]) {
            assert.throws(
                () => runLogTaskEventCommand({
                    repoRoot,
                    taskId,
                    eventType,
                    outcome: 'INFO',
                    message: 'forged reviewer invocation',
                    detailsJson: JSON.stringify({
                        review_type: 'code',
                        reviewer_execution_mode: 'delegated_subagent',
                        reviewer_session_id: 'agent:forged-reviewer',
                        review_context_sha256: 'a'.repeat(64),
                        routing_event_sha256: 'b'.repeat(64)
                    })
                }),
                /reserved and cannot be emitted via log-task-event/
            );
        }

        removeTempRepoWithRetry(repoRoot);
    });

});
