import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
    runClassifyChangeCommand} from '../../../../../../src/cli/commands/gates';
import {
    runCliMainWithHandling
} from '../../../../../../src/cli/main';
import { runCliWithCapturedOutput } from '../../gate-test-cli-capture';
import { computeProtectedSnapshotDigest } from '../../../../../../src/gates/shared/helpers';
import {
    getReviewsRoot,
    getOrchestratorRoot,
    createTempRepo,
    runGit,
    initializeGitRepo,
    backdateFileMtime,
    seedTaskQueue,
    seedInitAnswers,
    runEnterTaskMode,
    loadTaskEntryRulePack,
    runHandshakeForTask,
    runShellSmokeForTask,
    readTaskTimelineEvents} from '../../gate-test-helpers';

function writeDriftedProtectedManifest(
    repoRoot: string,
    changedFiles: string[] = ['garda-agent-orchestrator/live/docs/agent-rules/00-core.md'],
    options: { isSourceCheckout?: boolean } = {}
): void {
    const manifestPath = path.join(getOrchestratorRoot(repoRoot), 'runtime', 'protected-control-plane-manifest.json');
    const rulesRoot = path.join(getOrchestratorRoot(repoRoot), 'live', 'docs', 'agent-rules');
    const crypto = require('node:crypto');
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    const protectedSnapshot: Record<string, string> = {};
    for (const ruleFile of fs.readdirSync(rulesRoot).filter((entry) => entry.endsWith('.md')).sort()) {
        const relativePath = `garda-agent-orchestrator/live/docs/agent-rules/${ruleFile}`;
        const contents = fs.readFileSync(path.join(rulesRoot, ruleFile), 'utf8');
        protectedSnapshot[relativePath] = crypto.createHash('sha256').update(contents).digest('hex');
    }
    if (fs.existsSync(path.join(repoRoot, 'AGENTS.md'))) {
        const contents = fs.readFileSync(path.join(repoRoot, 'AGENTS.md'), 'utf8');
        protectedSnapshot['AGENTS.md'] = crypto.createHash('sha256').update(contents).digest('hex');
    }
    const workflowConfigPath = path.join(getOrchestratorRoot(repoRoot), 'live', 'config', 'workflow-config.json');
    if (fs.existsSync(workflowConfigPath)) {
        const contents = fs.readFileSync(workflowConfigPath, 'utf8');
        protectedSnapshot['garda-agent-orchestrator/live/config/workflow-config.json'] = crypto
            .createHash('sha256')
            .update(contents)
            .digest('hex');
    }
    for (const changedFile of changedFiles) {
        protectedSnapshot[changedFile] = '0'.repeat(64);
    }
    fs.writeFileSync(manifestPath, JSON.stringify({
        schema_version: 1,
        event_source: 'refresh-protected-control-plane-manifest',
        timestamp_utc: '2026-04-02T16:59:00.000Z',
        workspace_root: repoRoot.replace(/\\/g, '/'),
        orchestrator_root: getOrchestratorRoot(repoRoot).replace(/\\/g, '/'),
        protected_roots: ['garda-agent-orchestrator/live/docs/agent-rules/'],
        protected_snapshot: protectedSnapshot,
        protected_snapshot_sha256: computeProtectedSnapshotDigest(protectedSnapshot),
        is_source_checkout: options.isSourceCheckout === true
    }, null, 2), 'utf8');
}

function seedBaselineAgentsFile(repoRoot: string): void {
    fs.writeFileSync(path.join(repoRoot, 'AGENTS.md'), '# baseline\n', 'utf8');
}

function runWithRepoCwd<T>(repoRoot: string, callback: () => T): T {
    const previousCwd = process.cwd();
    process.chdir(repoRoot);
    try {
        return callback();
    } finally {
        process.chdir(previousCwd);
    }
}

describe('cli/commands/gates — dirty-workspace and isolation', () => {
    it('blocks classify-change when workspace was already dirty before task-mode entry without explicit isolation', { concurrency: false }, () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-900dirty';
        const appPath = path.join(repoRoot, 'src', 'app.ts');
        seedBaselineAgentsFile(repoRoot);
        fs.writeFileSync(path.join(repoRoot, '.gitignore'), 'TASK.md\ngarda-agent-orchestrator/runtime/\n', 'utf8');
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        fs.writeFileSync(appPath, 'const changedA = 20;\nconst changedB = 30;\nconsole.log(changedA + changedB);\n', 'utf8');
        backdateFileMtime(appPath);

        runWithRepoCwd(repoRoot, () => {
            runEnterTaskMode({
                repoRoot,
                taskId,
                taskSummary: 'Clarify dirty workspace preflight guard'
            });
            const rulePackResult = loadTaskEntryRulePack(repoRoot, taskId);
            assert.equal(rulePackResult.exitCode, 0);
            runHandshakeForTask(repoRoot, taskId);
            runShellSmokeForTask(repoRoot, taskId);

            assert.throws(
                () => runClassifyChangeCommand({
                    repoRoot,
                    taskId,
                    taskIntent: 'Clarify dirty workspace preflight guard',
                    emitMetrics: false
                }),
                /Workspace already contained modified files before task-mode entry: src\/app\.ts\..*--use-staged/
            );
        });

        const events = readTaskTimelineEvents(repoRoot, taskId);
        const eventTypes = events.map((event) => event.event_type);
        assert.ok(eventTypes.includes('PREFLIGHT_STARTED'));
        assert.ok(eventTypes.includes('PREFLIGHT_FAILED'));
        const preflightFailedEvent = [...events].reverse().find((event) => event.event_type === 'PREFLIGHT_FAILED');
        assert.ok(preflightFailedEvent);
        const preflightFailedDetails = preflightFailedEvent.details as Record<string, unknown>;
        assert.equal(
            preflightFailedDetails.preflight_failure_reason_code,
            'dirty_baseline_requires_explicit_scope'
        );
        assert.deepEqual(preflightFailedDetails.pre_task_modified_files, ['src/app.ts']);
        assert.deepEqual(preflightFailedDetails.dirty_workspace_baseline_changed_files, ['src/app.ts']);
        assert.deepEqual(preflightFailedDetails.current_workspace_changed_files, ['src/app.ts']);
        assert.equal(preflightFailedDetails.explicit_changed_files_provided, false);
        assert.equal(preflightFailedDetails.use_staged, false);
        assert.equal(preflightFailedDetails.include_untracked, true);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('allows classify-change when pre-existing dirty files are explicitly isolated with --use-staged', { concurrency: false }, () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-900dirty-staged';
        const appPath = path.join(repoRoot, 'src', 'app.ts');
        seedBaselineAgentsFile(repoRoot);
        fs.writeFileSync(path.join(repoRoot, '.gitignore'), 'TASK.md\ngarda-agent-orchestrator/runtime/\n', 'utf8');
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        fs.writeFileSync(appPath, 'const a = 5;\nconst b = 8;\nconsole.log(a + b);\n', 'utf8');
        backdateFileMtime(appPath);
        runGit(repoRoot, ['add', 'src/app.ts']);

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Allow staged isolation for dirty workspace'
        });
        const rulePackResult = loadTaskEntryRulePack(repoRoot, taskId);
        assert.equal(rulePackResult.exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        const result = runClassifyChangeCommand({
            repoRoot,
            taskId,
            taskIntent: 'Allow staged isolation for dirty workspace',
            useStaged: true,
            emitMetrics: false
        });

        const payload = JSON.parse(result.outputText);
        assert.equal(payload.task_id, taskId);
        assert.deepEqual(payload.changed_files, ['src/app.ts']);
        assert.equal(payload.detection_source, 'git_staged_only');
        assert.equal(payload.triggers.dirty_workspace_staged_baseline_trust_status, 'PASS');
        assert.deepEqual(payload.triggers.dirty_workspace_staged_baseline_trust_violations, []);
        assert.match(
            payload.triggers.dirty_workspace_staged_baseline_trust_input_sha256,
            /^[0-9a-f]{64}$/
        );

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('propagates staged trust failures into classify-change triggers and preflight errors', { concurrency: false }, () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-900dirty-staged-trust-fail';
        const appPath = path.join(repoRoot, 'src', 'app.ts');
        seedBaselineAgentsFile(repoRoot);
        fs.writeFileSync(path.join(repoRoot, '.gitignore'), 'TASK.md\ngarda-agent-orchestrator/runtime/\n', 'utf8');
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        fs.writeFileSync(appPath, 'const a = 34;\nconst b = 55;\nconsole.log(a + b);\n', 'utf8');
        backdateFileMtime(appPath);
        runGit(repoRoot, ['add', 'src/app.ts']);

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Reject forged staged dirty baseline trust evidence'
        });
        const taskModePath = path.join(getReviewsRoot(repoRoot), `${taskId}-task-mode.json`);
        const taskMode = JSON.parse(fs.readFileSync(taskModePath, 'utf8'));
        taskMode.dirty_workspace_baseline.staged_trust = null;
        fs.writeFileSync(taskModePath, JSON.stringify(taskMode, null, 2), 'utf8');
        const rulePackResult = loadTaskEntryRulePack(repoRoot, taskId);
        assert.equal(rulePackResult.exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        const outputPath = path.join(getReviewsRoot(repoRoot), `${taskId}-preflight.json`);
        assert.throws(
            () => runClassifyChangeCommand({
                repoRoot,
                taskId,
                taskIntent: 'Reject forged staged dirty baseline trust evidence',
                useStaged: true,
                outputPath,
                emitMetrics: false
            }),
            /Missing staged dirty-baseline trust evidence for staged baseline files: src\/app\.ts/
        );

        assert.equal(fs.existsSync(outputPath), false);
        const events = readTaskTimelineEvents(repoRoot, taskId);
        const preflightFailedEvent = [...events].reverse().find((event) => event.event_type === 'PREFLIGHT_FAILED');
        assert.ok(preflightFailedEvent);
        const preflightFailedDetails = preflightFailedEvent.details as Record<string, unknown>;
        assert.equal(
            preflightFailedDetails.error,
            'Missing staged dirty-baseline trust evidence for staged baseline files: src/app.ts.'
        );

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('keeps staged deletion paths in classify-change --use-staged when the path is recreated untracked', { concurrency: false }, () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-900dirty-staged-delete-recreate';
        const appPath = path.join(repoRoot, 'src', 'app.ts');
        seedBaselineAgentsFile(repoRoot);
        fs.writeFileSync(path.join(repoRoot, '.gitignore'), 'TASK.md\ngarda-agent-orchestrator/runtime/\n', 'utf8');
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        runGit(repoRoot, ['rm', 'src/app.ts']);
        fs.mkdirSync(path.dirname(appPath), { recursive: true });
        fs.writeFileSync(appPath, 'const replacement = 42;\nconsole.log(replacement);\n', 'utf8');
        backdateFileMtime(appPath);

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Keep staged deletion in staged-only preflight scope'
        });
        const rulePackResult = loadTaskEntryRulePack(repoRoot, taskId);
        assert.equal(rulePackResult.exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        const outputPath = path.join(getReviewsRoot(repoRoot), `${taskId}-preflight.json`);
        const result = runClassifyChangeCommand({
            repoRoot,
            taskId,
            taskIntent: 'Keep staged deletion in staged-only preflight scope',
            useStaged: true,
            outputPath,
            emitMetrics: false
        });

        const payload = JSON.parse(result.outputText);
        const preflight = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
        assert.equal(payload.task_id, taskId);
        assert.equal(payload.detection_source, 'git_staged_only');
        assert.deepEqual(payload.changed_files, ['src/app.ts']);
        assert.deepEqual(preflight.changed_files, ['src/app.ts']);
        assert.equal(preflight.triggers.dirty_workspace_protected_files.length, 0);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('keeps pre-existing unrelated untracked files protected when isolate scope uses --use-staged', { concurrency: false }, () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-900dirty-staged-untracked';
        const appPath = path.join(repoRoot, 'src', 'app.ts');
        const unrelatedUntrackedPath = path.join(repoRoot, 'src', 'scratch-note.ts');
        seedBaselineAgentsFile(repoRoot);
        fs.writeFileSync(path.join(repoRoot, '.gitignore'), 'TASK.md\ngarda-agent-orchestrator/runtime/\n', 'utf8');
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        fs.writeFileSync(appPath, 'const a = 13;\nconst b = 21;\nconsole.log(a + b);\n', 'utf8');
        fs.writeFileSync(unrelatedUntrackedPath, 'export const scratch = "local-only";\n', 'utf8');
        backdateFileMtime(appPath);
        backdateFileMtime(unrelatedUntrackedPath);
        runGit(repoRoot, ['add', 'src/app.ts']);

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Keep unrelated untracked file protected during staged scope isolation'
        });
        const rulePackResult = loadTaskEntryRulePack(repoRoot, taskId);
        assert.equal(rulePackResult.exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        const outputPath = path.join(getReviewsRoot(repoRoot), `${taskId}-preflight.json`);
        const result = runClassifyChangeCommand({
            repoRoot,
            taskId,
            taskIntent: 'Keep unrelated untracked file protected during staged scope isolation',
            useStaged: true,
            outputPath,
            emitMetrics: false
        });

        const payload = JSON.parse(result.outputText);
        const preflight = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
        assert.equal(payload.task_id, taskId);
        assert.deepEqual(payload.changed_files, ['src/app.ts']);
        assert.equal(payload.detection_source, 'git_staged_only');
        assert.deepEqual(preflight.triggers.dirty_workspace_protected_files, ['src/scratch-note.ts']);
        assert.deepEqual(preflight.triggers.dirty_workspace_task_owned_files, ['src/app.ts']);
        assert.deepEqual(preflight.triggers.dirty_workspace_untouched_baseline_files, ['src/scratch-note.ts']);
        assert.equal(preflight.triggers.dirty_workspace_protection_status, 'PASS');
        assert.equal(
            preflight.triggers.dirty_workspace_protection_assessment,
            'INFO_IGNORED_PROTECTED_LOCAL_BASELINE'
        );

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('blocks classify-change when the trusted protected manifest is already drifted before task start', { concurrency: false }, () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-900manifest-drift';
        const outputPath = path.join(repoRoot, 'preflight-manifest-drift.json');
        seedBaselineAgentsFile(repoRoot);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        writeDriftedProtectedManifest(repoRoot);

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Reject ordinary task start on trusted manifest drift'
        });
        const rulePackResult = loadTaskEntryRulePack(repoRoot, taskId);
        assert.equal(rulePackResult.exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        assert.throws(
            () => runClassifyChangeCommand({
                repoRoot,
                changedFiles: ['src/app.ts'],
                taskId,
                taskIntent: 'Reject ordinary task start on trusted manifest drift',
                outputPath,
                emitMetrics: false
            }),
            /Trusted protected control-plane manifest drift detected before preflight classification/
        );
        assert.equal(fs.existsSync(outputPath), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('allows clean source-checkout inherited protected manifest drift without forcing orchestrator-work', { concurrency: false }, () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-900manifest-source-checkout-inherited';
        const outputPath = path.join(repoRoot, 'preflight-manifest-source-checkout-inherited.json');
        seedBaselineAgentsFile(repoRoot);
        fs.writeFileSync(path.join(repoRoot, 'package.json'), JSON.stringify({
            name: 'garda-agent-orchestrator',
            version: '0.0.0-test'
        }, null, 2) + '\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, '.gitignore'), 'TASK.md\ngarda-agent-orchestrator/runtime/\n', 'utf8');
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        writeDriftedProtectedManifest(repoRoot, ['garda-agent-orchestrator/live/docs/agent-rules/00-core.md'], {
            isSourceCheckout: true
        });

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Allow inherited source-checkout manifest drift on clean task start'
        });
        const rulePackResult = loadTaskEntryRulePack(repoRoot, taskId);
        assert.equal(rulePackResult.exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        const result = runClassifyChangeCommand({
            repoRoot,
            changedFiles: [],
            taskId,
            taskIntent: 'Allow inherited source-checkout manifest drift on clean task start',
            outputPath,
            emitMetrics: false
        });

        const payload = JSON.parse(result.outputText);
        assert.equal(payload.task_id, taskId);
        assert.equal(payload.scope_category, 'empty');
        assert.deepEqual(payload.changed_files, []);
        assert.equal(payload.triggers.protected_control_plane_manifest_status, 'DRIFT');
        assert.deepEqual(
            payload.triggers.protected_control_plane_manifest_changed_files,
            ['garda-agent-orchestrator/live/docs/agent-rules/00-core.md']
        );
        assert.equal(
            payload.triggers.protected_control_plane_manifest_baseline_allowance_status,
            'SOURCE_CHECKOUT_INHERITED_DRIFT'
        );
        assert.equal(
            payload.triggers.protected_control_plane_manifest_assessment,
            'INFO_SOURCE_CHECKOUT_INHERITED_DRIFT'
        );
        assert.equal(fs.existsSync(outputPath), true);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('allows classify-change when trusted protected manifest drift is inherited from the dirty baseline only', { concurrency: false }, () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-900manifest-drift-baseline-only';
        const outputPath = path.join(repoRoot, 'preflight-manifest-drift-baseline-only.json');
        const protectedRulePath = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'docs', 'agent-rules', '00-core.md');
        seedBaselineAgentsFile(repoRoot);
        fs.writeFileSync(path.join(repoRoot, '.gitignore'), 'TASK.md\ngarda-agent-orchestrator/runtime/\n', 'utf8');
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        fs.writeFileSync(protectedRulePath, '# baseline protected drift\n', 'utf8');
        writeDriftedProtectedManifest(repoRoot);

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Allow inherited protected manifest drift on an ordinary scoped task'
        });
        const rulePackResult = loadTaskEntryRulePack(repoRoot, taskId);
        assert.equal(rulePackResult.exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        const result = runClassifyChangeCommand({
            repoRoot,
            changedFiles: ['src/app.ts'],
            taskId,
            taskIntent: 'Allow inherited protected manifest drift on an ordinary scoped task',
            outputPath,
            emitMetrics: false
        });

        const payload = JSON.parse(result.outputText);
        assert.equal(payload.task_id, taskId);
        assert.equal(payload.triggers.protected_control_plane_manifest_status, 'DRIFT');
        assert.deepEqual(
            payload.triggers.dirty_workspace_protected_files,
            ['garda-agent-orchestrator/live/docs/agent-rules/00-core.md']
        );
        assert.equal(
            payload.triggers.protected_control_plane_manifest_baseline_allowance_status,
            'INHERITED_BASELINE_ONLY'
        );
        assert.equal(
            payload.triggers.protected_control_plane_manifest_assessment,
            'INFO_TASK_CONTEXT_ALLOWED_DRIFT'
        );
        assert.equal(fs.existsSync(outputPath), true);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('prepare-isolation prints same-user notice and records sandbox preparation telemetry', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-905i';
        const orchestratorRoot = getOrchestratorRoot(repoRoot);
        const configPath = path.join(orchestratorRoot, 'live', 'config', 'isolation-mode.json');
        const notice = 'Custom same-user notice for prepare-isolation regression coverage.';
        const originalConsoleLog = console.log;
        const capturedLogs: string[] = [];
        const previousCwd = process.cwd();
        const previousExitCode = process.exitCode;

        seedTaskQueue(repoRoot, taskId);
        fs.mkdirSync(path.dirname(configPath), { recursive: true });
        fs.writeFileSync(configPath, JSON.stringify({
            enabled: true,
            enforcement: 'LOG_ONLY',
            require_manifest_match_before_task: true,
            refuse_on_preflight_drift: true,
            use_sandbox: true,
            same_user_limitation_notice: notice
        }, null, 2) + '\n', 'utf8');

        process.exitCode = 0;
        console.log = (...args: unknown[]) => {
            capturedLogs.push(args.map((value) => String(value)).join(' '));
        };

        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate',
                'prepare-isolation',
                '--task-id', taskId,
                '--repo-root', repoRoot
            ]);
        } finally {
            console.log = originalConsoleLog;
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        const output = capturedLogs.join('\n');
        assert.ok(output.includes('ISOLATION_SANDBOX_PREPARED'));
        assert.ok(output.includes(`SameUserNotice: ${notice}`));

        const timelineEvents = readTaskTimelineEvents(repoRoot, taskId);
        const preparationEvent = timelineEvents.find((event) => event.event_type === 'ISOLATION_SANDBOX_PREPARED');
        assert.ok(preparationEvent, 'sandbox preparation event must be appended to the task timeline');
        assert.equal(preparationEvent?.outcome, 'PASS');

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('classifies a linked clean child from its authenticated split checkpoint scope', { concurrency: false }, async () => {
        const repoRoot = createTempRepo();
        const parentTaskId = 'T-901-checkpoint';
        const taskId = 'T-901-checkpoint-1';
        const appPath = path.join(repoRoot, 'src', 'app.ts');
        seedBaselineAgentsFile(repoRoot);
        fs.writeFileSync(path.join(repoRoot, '.gitignore'), 'TASK.md\ngarda-agent-orchestrator/runtime/\n', 'utf8');
        fs.writeFileSync(appPath, 'export const value = 1;\n', 'utf8');
        initializeGitRepo(repoRoot);
        fs.writeFileSync(appPath, 'export const value = 2;\n', 'utf8');
        runGit(repoRoot, ['add', 'src/app.ts']);
        runGit(repoRoot, ['commit', '-m', `checkpoint(split): preserve ${parentTaskId} dirty diff before decomposition`]);
        const checkpointCommit = require('node:child_process')
            .execFileSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' })
            .trim();
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '| ID | Status | Priority | Area | Title | Assignee | Updated | Profile | Notes |',
            '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
            `| ${parentTaskId} | DECOMPOSED | P1 | workflow | Parent | unassigned | 2026-07-12 | default | Split checkpoint \`${checkpointCommit}\` preserves parent work. Children: none. Child tasks: \`${taskId}\`. |`,
            `| ${taskId} | TODO | P1 | workflow | Child | unassigned | 2026-07-12 | default | Child of \`${parentTaskId}\`. Checkpoint: \`${checkpointCommit}\`. Checkpoint files: \`src/app.ts\`. |`
        ].join('\n'), 'utf8');
        seedInitAnswers(repoRoot);
        let detectionSource = '';

        runWithRepoCwd(repoRoot, () => {
            runEnterTaskMode({
                repoRoot,
                taskId,
                taskSummary: 'Review split checkpoint scope'
            });
            assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
            runHandshakeForTask(repoRoot, taskId);
            runShellSmokeForTask(repoRoot, taskId);

            const result = runClassifyChangeCommand({
                repoRoot,
                taskId,
                taskIntent: 'Review split checkpoint scope',
                emitMetrics: false
            });
            const preflight = JSON.parse(result.outputText) as Record<string, unknown>;
            const scope = preflight.split_checkpoint_scope as Record<string, unknown>;
            detectionSource = String(preflight.detection_source || '');
            assert.deepEqual(preflight.changed_files, ['src/app.ts']);
            assert.ok(detectionSource.startsWith('git_split_checkpoint:'));
            assert.equal(scope.parent_task_id, parentTaskId);
            assert.equal(scope.checkpoint_commit, checkpointCommit);
            assert.deepEqual(scope.changed_files, ['src/app.ts']);
            assert.equal((preflight.zero_diff_guard as Record<string, unknown>).status, 'DIFF_PRESENT');

            const explicitResult = runClassifyChangeCommand({
                repoRoot,
                taskId,
                taskIntent: 'Review split checkpoint scope',
                detectionSource: preflight.detection_source,
                changedFiles: ['src/app.ts'],
                outputPath: path.join(repoRoot, 'explicit-split-preflight.json'),
                emitMetrics: false
            });
            const explicitPreflight = JSON.parse(explicitResult.outputText) as Record<string, unknown>;
            const explicitScope = explicitPreflight.split_checkpoint_scope as Record<string, unknown>;
            assert.equal(explicitPreflight.detection_source, preflight.detection_source);
            assert.deepEqual(explicitPreflight.changed_files, ['src/app.ts']);
            assert.equal(explicitScope.checkpoint_commit, checkpointCommit);
        });

        const cliResult = await runCliWithCapturedOutput([
            'gate',
            'classify-change',
            '--repo-root', repoRoot,
            '--task-id', taskId,
            '--task-intent', 'Review split checkpoint scope through CLI parser',
            '--detection-source', detectionSource,
            '--changed-file', 'src/app.ts',
            '--output-path', path.join(repoRoot, 'cli-explicit-split-preflight.json')
        ], { cwd: repoRoot });
        assert.equal(cliResult.exitCode, 0, cliResult.errors.join('\n'));
        const cliPreflight = JSON.parse(cliResult.logs.join('\n')) as Record<string, unknown>;
        assert.equal(cliPreflight.detection_source, detectionSource);
        assert.deepEqual(cliPreflight.changed_files, ['src/app.ts']);

        const unsupportedResult = await runCliWithCapturedOutput([
            'gate',
            'classify-change',
            '--repo-root', repoRoot,
            '--task-id', taskId,
            '--detection-source', 'manual_override',
            '--changed-file', 'src/app.ts'
        ], { cwd: repoRoot });
        assert.notEqual(unsupportedResult.exitCode, 0);
        assert.match(
            unsupportedResult.errors.join('\n'),
            /Unsupported classify-change detection source override 'manual_override'/u
        );

        const mismatchedDetectionSource = detectionSource.replace(
            checkpointCommit,
            '0'.repeat(checkpointCommit.length)
        );
        const mismatchedRangeResult = await runCliWithCapturedOutput([
            'gate',
            'classify-change',
            '--repo-root', repoRoot,
            '--task-id', taskId,
            '--detection-source', mismatchedDetectionSource,
            '--changed-file', 'src/app.ts'
        ], { cwd: repoRoot });
        assert.notEqual(mismatchedRangeResult.exitCode, 0);
        assert.match(
            mismatchedRangeResult.errors.join('\n'),
            /Split checkpoint preflight range does not match the authenticated task checkpoint scope/u
        );

        const mismatchedFilesResult = await runCliWithCapturedOutput([
            'gate',
            'classify-change',
            '--repo-root', repoRoot,
            '--task-id', taskId,
            '--detection-source', detectionSource,
            '--changed-file', 'src/other.ts'
        ], { cwd: repoRoot });
        assert.notEqual(mismatchedFilesResult.exitCode, 0);
        assert.match(
            mismatchedFilesResult.errors.join('\n'),
            /Split checkpoint preflight changed_files do not match the authenticated task checkpoint scope/u
        );

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });
});
