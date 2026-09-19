import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { EXIT_GATE_FAILURE } from '../../../../../../src/cli/exit-codes';
import {
    runCompileGateCommand,
    runDocImpactGateCommand,
    runEnterTaskModeCommand,
    runFullSuiteValidationCommand,
    runLoadRulePackCommand,
    runRecordNoOpCommand,
    runRequiredReviewsCheckCommand,
    runTaskAuditSummaryCommand
} from '../../../../../../src/cli/commands/gates';
import { runCompletionGate } from '../../../../../../src/gates/completion';
import { appendTaskEvent } from '../../../../../../src/gate-runtime/task-events';
import { buildDefaultWorkflowConfig } from '../../../../../../src/core/workflow-config';
import {
    bindFixtureEffectiveReviewSnapshot,
    initializeGitRepo,
    writeBudgetOutputFilters
} from '../../gate-test-seed-helpers';
import { createManagedTestTempDirectory } from '../../gate-test-temp-manager';

const TEST_COMPILE_GATE_COMMAND = 'node -e "console.log(\'build ok\')"';
const CLI_EXECUTION_TIMEOUT_MS = 30_000;

function findSourceRepoRoot(): string {
    let current = path.resolve(__dirname);
    while (current !== path.dirname(current)) {
        if (fs.existsSync(path.join(current, 'package.json')) && fs.existsSync(path.join(current, 'bin', 'garda.js'))) {
            return current;
        }
        current = path.dirname(current);
    }
    throw new Error(`Cannot resolve source repo root from ${__dirname}`);
}

const SOURCE_REPO_ROOT = findSourceRepoRoot();

function writeBundleCliProxy(repoRoot: string): string {
    const cliPath = path.join(repoRoot, 'garda-agent-orchestrator', 'bin', 'garda.js');
    fs.mkdirSync(path.dirname(cliPath), { recursive: true });
    fs.writeFileSync(
        cliPath,
        `const { main } = require(${JSON.stringify(path.join(SOURCE_REPO_ROOT, 'bin', 'garda.js'))});\nvoid main();\n`,
        'utf8'
    );
    return cliPath;
}

function runCli(repoRoot: string, cliPath: string, args: string[]) {
    return spawnSync(process.execPath, [cliPath, ...args], {
        cwd: repoRoot,
        encoding: 'utf8',
        timeout: CLI_EXECUTION_TIMEOUT_MS,
        windowsHide: true
    });
}

function executePrintedCommand(repoRoot: string, command: string) {
    return spawnSync(command, {
        cwd: repoRoot,
        encoding: 'utf8',
        shell: true,
        timeout: CLI_EXECUTION_TIMEOUT_MS,
        windowsHide: true
    });
}

function combinedCliOutput(result: ReturnType<typeof spawnSync>): string {
    return `${result.stdout || ''}\n${result.stderr || ''}`;
}

function readPrintedCommand(output: string): string {
    const match = /^  Command: (.+)$/mu.exec(output);
    assert.ok(match, output);
    return match[1].trim();
}

function createTempRepo(): string {
    const root = createManagedTestTempDirectory('repo-');
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.mkdirSync(path.join(root, 'garda-agent-orchestrator', 'live', 'config'), { recursive: true });
    fs.mkdirSync(path.join(root, 'garda-agent-orchestrator', 'live', 'docs', 'agent-rules'), { recursive: true });
    fs.mkdirSync(path.join(root, 'garda-agent-orchestrator', 'live', 'skills', 'code-review'), { recursive: true });
    fs.mkdirSync(path.join(root, 'garda-agent-orchestrator', 'runtime'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'app.ts'), 'const a = 1;\nconst b = 2;\nconsole.log(a + b);\n', 'utf8');
    fs.writeFileSync(
        path.join(root, 'garda-agent-orchestrator', 'live', 'skills', 'code-review', 'SKILL.md'),
        '# code-review fixture\n',
        'utf8'
    );
    seedRuleFiles(root);
    const workflowConfig = buildDefaultWorkflowConfig();
    workflowConfig.compile_gate.command = TEST_COMPILE_GATE_COMMAND;
    workflowConfig.full_suite_validation.enabled = false;
    workflowConfig.full_suite_validation.command = 'npm test';
    workflowConfig.review_execution_policy = { mode: 'code_first_optional' };
    workflowConfig.project_memory_maintenance.enabled = false;
    workflowConfig.project_memory_maintenance.mode = 'check';
    fs.writeFileSync(
        path.join(root, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json'),
        JSON.stringify(workflowConfig, null, 2) + '\n',
        'utf8'
    );
    return root;
}

const PROVIDER_ENTRYPOINT_BY_SOURCE: Record<string, string> = {
    Claude: 'CLAUDE.md',
    Codex: 'AGENTS.md',
    Gemini: 'GEMINI.md',
    Qwen: 'QWEN.md',
    GitHubCopilot: '.github/copilot-instructions.md',
    Windsurf: '.windsurf/rules/rules.md',
    Junie: '.junie/guidelines.md',
    Antigravity: '.antigravity/rules.md'
};

const PROVIDER_BRIDGE_BY_SOURCE: Record<string, string> = {
    GitHubCopilot: '.github/agents/orchestrator.md',
    Windsurf: '.windsurf/agents/orchestrator.md',
    Junie: '.junie/agents/orchestrator.md',
    Antigravity: '.antigravity/agents/orchestrator.md'
};

function withDefaultTaskModeRouting<T extends { repoRoot?: string; provider?: unknown; routedTo?: unknown }>(options: T): T {
    if (String(options.provider || '').trim() || String(options.routedTo || '').trim()) {
        return options;
    }
    const repoRoot = path.resolve(String(options.repoRoot || '.'));
    const initAnswersPath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'init-answers.json');
    if (!fs.existsSync(initAnswersPath) || !fs.statSync(initAnswersPath).isFile()) {
        return options;
    }

    try {
        const payload = JSON.parse(fs.readFileSync(initAnswersPath, 'utf8')) as Record<string, unknown>;
        const sourceOfTruth = typeof payload.SourceOfTruth === 'string' ? payload.SourceOfTruth.trim() : '';
        const routedTo = PROVIDER_ENTRYPOINT_BY_SOURCE[sourceOfTruth];
        if (!sourceOfTruth || !routedTo) {
            return options;
        }
        return {
            ...options,
            provider: sourceOfTruth,
            routedTo
        };
    } catch {
        return options;
    }
}

function runEnterTaskMode(options: Parameters<typeof runEnterTaskModeCommand>[0]) {
    return runEnterTaskModeCommand(withDefaultTaskModeRouting({
        startBanner: 'Garda captures my mind',
        ...options
    }));
}

function seedRuleFiles(repoRoot: string): void {
    const rulesRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'docs', 'agent-rules');
    fs.mkdirSync(rulesRoot, { recursive: true });
    const ruleFiles = [
        '00-core.md',
        '15-project-memory.md',
        '30-code-style.md',
        '35-strict-coding-rules.md',
        '40-commands.md',
        '50-structure-and-docs.md',
        '70-security.md',
        '80-task-workflow.md',
        '90-skill-catalog.md'
    ];
    for (const ruleFile of ruleFiles) {
        fs.writeFileSync(path.join(rulesRoot, ruleFile), `# ${ruleFile}\n`, 'utf8');
    }
}

function getReviewsRoot(repoRoot: string): string {
    return path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews');
}

function getOrchestratorRoot(repoRoot: string): string {
    return path.join(repoRoot, 'garda-agent-orchestrator');
}

function writePreflight(
    repoRoot: string,
    taskId: string,
    overrides: Record<string, unknown> = {},
    outputFileName = `${taskId}-preflight.json`
): string {
    const reviewsRoot = getReviewsRoot(repoRoot);
    fs.mkdirSync(reviewsRoot, { recursive: true });
    const preflightPath = path.join(reviewsRoot, outputFileName);
    const payload = {
        task_id: taskId,
        detection_source: 'explicit_changed_files',
        mode: 'FULL_PATH',
        metrics: { changed_lines_total: 3 },
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
        triggers: {},
        changed_files: ['src/app.ts'],
        ...overrides
    };
    fs.writeFileSync(preflightPath, JSON.stringify(payload, null, 2), 'utf8');
    return preflightPath;
}

function appendPreflightClassifiedEvent(repoRoot: string, taskId: string, preflightPath: string, force = false): void {
    const normalizedPreflightPath = preflightPath.replace(/\\/g, '/');
    const existingEvents = readTaskTimelineEvents(repoRoot, taskId);
    const latestMatchingEvent = [...existingEvents].reverse().find((event) => (
        event.event_type === 'PREFLIGHT_CLASSIFIED'
        && String((event.details as Record<string, unknown> | undefined)?.output_path || '') === normalizedPreflightPath
    ));
    if (latestMatchingEvent && !force) {
        return;
    }

    const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
    const metrics = preflight.metrics && typeof preflight.metrics === 'object' && !Array.isArray(preflight.metrics)
        ? preflight.metrics as Record<string, unknown>
        : {};
    const mode = String(preflight.mode || 'FULL_PATH');
    const changedFilesCount = Array.isArray(preflight.changed_files) ? preflight.changed_files.length : 0;
    const changedLinesTotal = Number(metrics.changed_lines_total || 0);
    const zeroDiffGuard = preflight.zero_diff_guard && typeof preflight.zero_diff_guard === 'object' && !Array.isArray(preflight.zero_diff_guard)
        ? preflight.zero_diff_guard
        : (changedFilesCount === 0 && changedLinesTotal === 0
            ? { zero_diff_detected: true, status: 'BASELINE_ONLY' }
            : null);
    appendTaskEvent(
        getOrchestratorRoot(repoRoot),
        taskId,
        'PREFLIGHT_CLASSIFIED',
        'INFO',
        zeroDiffGuard
            ? `Preflight completed with mode ${mode} (zero-diff baseline only).`
            : `Preflight completed with mode ${mode}.`,
        {
            mode,
            output_path: normalizedPreflightPath,
            changed_files_count: changedFilesCount,
            changed_lines_total: changedLinesTotal,
            required_reviews: preflight.required_reviews || {},
            zero_diff_guard: zeroDiffGuard,
            effective_review_snapshot: preflight.effective_review_snapshot
        }
    );
}

function seedTaskQueue(repoRoot: string, taskId: string, status = 'TODO'): void {
    fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
        '| ID | Status | Priority | Area | Title | Assignee | Updated | Profile | Notes |',
        '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
        `| ${taskId} | ${status} | P1 | test | Update app flow | unassigned | 2026-03-28 | default | fixture |`
    ].join('\n'), 'utf8');
}

function seedInitAnswers(repoRoot: string, sourceOfTruth = 'Codex'): void {
    const initAnswersPath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'init-answers.json');
    fs.mkdirSync(path.dirname(initAnswersPath), { recursive: true });
    fs.writeFileSync(initAnswersPath, JSON.stringify({
        AssistantLanguage: 'English',
        AssistantBrevity: 'concise',
        SourceOfTruth: sourceOfTruth,
        EnforceNoAutoCommit: 'false',
        ClaudeOrchestratorFullAccess: 'false',
        TokenEconomyEnabled: 'true',
        CollectedVia: 'AGENT_INIT_PROMPT.md',
        ActiveAgentFiles: 'AGENTS.md'
    }, null, 2), 'utf8');
}

function writeHandshakeArtifact(repoRoot: string, taskId: string, provider = 'Codex'): void {
    const reviewsRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews');
    const initAnswersPath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'init-answers.json');
    let canonicalSourceOfTruth = provider;
    if (fs.existsSync(initAnswersPath) && fs.statSync(initAnswersPath).isFile()) {
        try {
            const payload = JSON.parse(fs.readFileSync(initAnswersPath, 'utf8')) as Record<string, unknown>;
            const seededSourceOfTruth = typeof payload.SourceOfTruth === 'string' ? payload.SourceOfTruth.trim() : '';
            if (seededSourceOfTruth) {
                canonicalSourceOfTruth = seededSourceOfTruth;
            }
        } catch {
            // Keep the lightweight test fixture tolerant of malformed init answers.
        }
    }
    const canonicalEntrypoint = PROVIDER_ENTRYPOINT_BY_SOURCE[canonicalSourceOfTruth] || 'AGENTS.md';
    const routedTo = PROVIDER_ENTRYPOINT_BY_SOURCE[provider] || null;
    const providerBridgeCandidate = PROVIDER_BRIDGE_BY_SOURCE[provider] || null;
    const providerBridgePath = providerBridgeCandidate && fs.existsSync(path.join(repoRoot, providerBridgeCandidate))
        ? providerBridgeCandidate
        : null;
    fs.mkdirSync(reviewsRoot, { recursive: true });
    fs.writeFileSync(path.join(reviewsRoot, `${taskId}-handshake.json`), JSON.stringify({
        schema_version: 1,
        timestamp_utc: new Date().toISOString(),
        event_source: 'handshake-diagnostics',
        task_id: taskId,
        status: 'PASSED',
        outcome: 'PASS',
        provider,
        execution_provider: provider,
        canonical_source_of_truth: canonicalSourceOfTruth,
        canonical_entrypoint: canonicalEntrypoint,
        canonical_entrypoint_exists: true,
        provider_bridge: providerBridgePath,
        provider_bridge_exists: providerBridgePath !== null,
        routed_to: routedTo,
        execution_provider_source: 'explicit_provider',
        runtime_identity_status: 'resolved',
        start_task_router_path: '.agents/workflows/start-task.md',
        start_task_router_exists: true,
        execution_context: 'materialized-bundle',
        cli_path: 'node garda-agent-orchestrator/bin/garda.js',
        effective_cwd: repoRoot.replace(/\\/g, '/'),
        workspace_root: repoRoot.replace(/\\/g, '/'),
        diagnostics: [],
        violations: []
    }, null, 2), 'utf8');
}

function readTaskTimelineEvents(repoRoot: string, taskId: string): Array<Record<string, unknown>> {
    const timelinePath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'task-events', `${taskId}.jsonl`);
    return fs.readFileSync(timelinePath, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function loadTaskEntryRulePack(repoRoot: string, taskId: string, taskModePath = '') {
    return runLoadRulePackCommand({
        repoRoot,
        taskId,
        stage: 'TASK_ENTRY',
        taskModePath,
        loadedRuleFiles: [
            '00-core.md',
            '15-project-memory.md',
            '40-commands.md',
            '80-task-workflow.md',
            '90-skill-catalog.md'
        ],
        emitMetrics: false
    });
}

function loadPostPreflightRulePack(
    repoRoot: string,
    taskId: string,
    preflightPath: string,
    ensurePreflightClassified = true,
    artifactPath = '',
    taskModePath = ''
) {
    bindFixtureEffectiveReviewSnapshot(repoRoot, taskId, 'code', preflightPath, taskModePath);
    if (ensurePreflightClassified) {
        appendPreflightClassifiedEvent(repoRoot, taskId, preflightPath);
    }
    return runLoadRulePackCommand({
        repoRoot,
        taskId,
        stage: 'POST_PREFLIGHT',
        preflightPath,
        artifactPath,
        taskModePath,
        loadedRuleFiles: [
            '00-core.md',
            '15-project-memory.md',
            '35-strict-coding-rules.md',
            '40-commands.md',
            '50-structure-and-docs.md',
            '70-security.md',
            '80-task-workflow.md',
            '90-skill-catalog.md'
        ],
        emitMetrics: false
    });
}

function runHandshakeForTask(repoRoot: string, taskId: string, provider = 'Codex') {
    writeHandshakeArtifact(repoRoot, taskId, provider);
    const orchestratorRoot = path.join(repoRoot, 'garda-agent-orchestrator');
    const artifactPath = path.join(orchestratorRoot, 'runtime', 'reviews', `${taskId}-handshake.json`);
    const artifactContent = fs.readFileSync(artifactPath, 'utf8');
    const artifact = JSON.parse(artifactContent) as Record<string, unknown>;
    const crypto = require('node:crypto');
    const artifactHash = crypto.createHash('sha256').update(artifactContent).digest('hex');
    appendTaskEvent(
        orchestratorRoot,
        taskId,
        'HANDSHAKE_DIAGNOSTICS_RECORDED',
        'PASS',
        `Handshake diagnostics passed: provider=${provider}, context=materialized-bundle.`,
        {
            provider,
            execution_provider: artifact.execution_provider ?? provider,
            canonical_source_of_truth: artifact.canonical_source_of_truth ?? provider,
            execution_provider_source: artifact.execution_provider_source ?? 'explicit_provider',
            execution_context: 'materialized-bundle',
            cli_path: 'node garda-agent-orchestrator/bin/garda.js',
            passed: true,
            artifact_hash: artifactHash
        },
        { actor: 'gate', passThru: true }
    );
}

function writeShellSmokeArtifact(repoRoot: string, taskId: string, provider = 'Codex'): void {
    const reviewsRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews');
    fs.mkdirSync(reviewsRoot, { recursive: true });
    fs.writeFileSync(path.join(reviewsRoot, `${taskId}-shell-smoke.json`), JSON.stringify({
        schema_version: 1,
        timestamp_utc: new Date().toISOString(),
        event_source: 'shell-smoke-preflight',
        task_id: taskId,
        status: 'PASSED',
        outcome: 'PASS',
        provider,
        execution_context: 'materialized-bundle',
        effective_cwd: repoRoot.replace(/\\/g, '/'),
        workspace_root: repoRoot.replace(/\\/g, '/'),
        probes: [],
        violations: []
    }, null, 2), 'utf8');
}

function runShellSmokeForTask(repoRoot: string, taskId: string, provider = 'Codex') {
    writeShellSmokeArtifact(repoRoot, taskId, provider);
    const orchestratorRoot = path.join(repoRoot, 'garda-agent-orchestrator');
    const artifactPath = path.join(orchestratorRoot, 'runtime', 'reviews', `${taskId}-shell-smoke.json`);
    const artifactContent = fs.readFileSync(artifactPath, 'utf8');
    const crypto = require('node:crypto');
    const artifactHash = crypto.createHash('sha256').update(artifactContent).digest('hex');
    appendTaskEvent(
        orchestratorRoot,
        taskId,
        'SHELL_SMOKE_PREFLIGHT_RECORDED',
        'PASS',
        `Shell smoke preflight passed: provider=${provider}, context=materialized-bundle.`,
        { provider, execution_context: 'materialized-bundle', passed: true, artifact_hash: artifactHash },
        { actor: 'gate', passThru: true }
    );
}

function writeZeroDiffNoReviewPreflight(
    repoRoot: string,
    taskId: string,
    overrides: Record<string, unknown> = {}
): string {
    return writePreflight(repoRoot, taskId, {
        detection_source: 'git_auto',
        mode: 'FULL_PATH',
        scope_category: 'empty',
        metrics: { changed_lines_total: 0 },
        required_reviews: {
            code: false,
            db: false,
            security: false,
            refactor: false,
            api: false,
            test: false,
            performance: false,
            infra: false,
            dependency: false
        },
        triggers: {},
        changed_files: [],
        profile_guardrails: {
            zero_diff_no_reviewable_scope: true
        },
        zero_diff_guard: {
            zero_diff_detected: true,
            status: 'BASELINE_ONLY',
            completion_requires_audited_no_op: true,
            no_op_artifact_suffix: '-no-op.json',
            rationale: 'Preflight on a clean workspace is baseline-only.'
        },
        ...overrides
    });
}

function writeCompileCommands(repoRoot: string, fileName = 'commands-zero.md'): string {
    const commandsPath = path.join(repoRoot, fileName);
    fs.writeFileSync(commandsPath, [
        '### Compile Gate (Mandatory)',
        '```bash',
        'node -e "console.log(\'build ok\')"',
        '```'
    ].join('\n'), 'utf8');
    return commandsPath;
}

function assertNoDelegatedReviewArtifacts(repoRoot: string, taskId: string): void {
    const reviewsRoot = getReviewsRoot(repoRoot);
    for (const reviewType of ['code', 'test']) {
        assert.equal(fs.existsSync(path.join(reviewsRoot, `${taskId}-${reviewType}.md`)), false);
        assert.equal(fs.existsSync(path.join(reviewsRoot, `${taskId}-${reviewType}-receipt.json`)), false);
        assert.equal(fs.existsSync(path.join(reviewsRoot, `${taskId}-${reviewType}-review-context.json`)), false);
    }
}

async function setupZeroDiffReviewGateFixture(taskId: string): Promise<{
    repoRoot: string;
    preflightPath: string;
    commandsPath: string;
    outputFiltersPath: string;
}> {
    const repoRoot = createTempRepo();
    fs.writeFileSync(path.join(repoRoot, '.gitignore'), 'TASK.md\ngarda-agent-orchestrator/runtime/\n', 'utf8');
    const commandsPath = writeCompileCommands(repoRoot);
    initializeGitRepo(repoRoot);
    seedTaskQueue(repoRoot, taskId);
    seedInitAnswers(repoRoot);
    const preflightPath = writeZeroDiffNoReviewPreflight(repoRoot, taskId);
    const outputFiltersPath = writeBudgetOutputFilters(repoRoot);

    runEnterTaskMode({
        repoRoot,
        taskId,
        taskSummary: 'Close baseline-only zero-diff task without delegated reviews'
    });
    loadTaskEntryRulePack(repoRoot, taskId);
    runHandshakeForTask(repoRoot, taskId);
    runShellSmokeForTask(repoRoot, taskId);
    loadPostPreflightRulePack(repoRoot, taskId, preflightPath);

    const compileResult = await runCompileGateCommand({
        repoRoot,
        taskId,
        preflightPath,
        commandsPath,
        outputFiltersPath,
        emitMetrics: false
    });
    assert.equal(compileResult.exitCode, 0);

    return { repoRoot, preflightPath, commandsPath, outputFiltersPath };
}

describe('cli/commands/gates', () => {
    it('requires audited no-op evidence before zero-diff completion can pass', { concurrency: false }, async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903b';
        const cliPath = writeBundleCliProxy(repoRoot);
        const workflowConfigPath = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json');
        const workflowConfig = JSON.parse(fs.readFileSync(workflowConfigPath, 'utf8')) as ReturnType<typeof buildDefaultWorkflowConfig>;
        workflowConfig.full_suite_validation.enabled = true;
        fs.writeFileSync(workflowConfigPath, `${JSON.stringify(workflowConfig, null, 2)}\n`, 'utf8');
        fs.writeFileSync(path.join(repoRoot, '.gitignore'), 'TASK.md\ngarda-agent-orchestrator/runtime/\n', 'utf8');
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        const preflightPath = writePreflight(repoRoot, taskId, {
            metrics: { changed_lines_total: 0 },
            required_reviews: {
                code: false,
                db: false,
                security: false,
                refactor: false,
                api: false,
                test: false,
                performance: false,
                infra: false,
                dependency: false
            },
            profile_guardrails: {
                zero_diff_no_reviewable_scope: true
            },
            changed_files: [],
            zero_diff_guard: {
                zero_diff_detected: true,
                status: 'BASELINE_ONLY',
                completion_requires_audited_no_op: true,
                no_op_artifact_suffix: '-no-op.json',
                rationale: 'Preflight on a clean workspace is baseline-only.'
            }
        });
        const outputFiltersPath = writeBudgetOutputFilters(repoRoot);

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Implement lifecycle hardening'
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath);

        // Review gate must fail when zero-diff preflight has no no-op artifact,
        // even though this exact audit-only route does not require compile evidence.
        const failedReviewResult = runRequiredReviewsCheckCommand({
            repoRoot,
            taskId,
            preflightPath,
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(failedReviewResult.exitCode, EXIT_GATE_FAILURE);
        assert.ok(failedReviewResult.outputLines.some((line) => String(line).includes('zero-diff')));

        // Record a no-op artifact to satisfy the guard
        const noOpResult = runRecordNoOpCommand({
            repoRoot,
            taskId,
            preflightPath,
            classification: 'ALREADY_DONE',
            reason: 'Task behavior already matches the requested outcome after earlier local changes.',
            emitMetrics: false
        });
        assert.equal(noOpResult.exitCode, 0);

        // Execute the exact closeout command printed by next-step through the CLI boundary.
        const nextStepResult = runCli(repoRoot, cliPath, ['next-step', taskId, '--repo-root', '.']);
        const nextStepOutput = combinedCliOutput(nextStepResult);
        assert.equal(nextStepResult.status, 0, nextStepOutput);
        const printedCommand = readPrintedCommand(nextStepOutput);
        assert.match(printedCommand, /^node garda-agent-orchestrator\/bin\/garda\.js gate required-reviews-check /u);

        const passedReviewResult = executePrintedCommand(repoRoot, printedCommand);
        const passedReviewOutput = combinedCliOutput(passedReviewResult);
        assert.equal(passedReviewResult.status, 0, passedReviewOutput);
        assert.match(passedReviewOutput, /REVIEW_GATE_PASSED/u);
        assert.equal(
            readTaskTimelineEvents(repoRoot, taskId)
                .some((event) => event.event_type === 'COMPILE_GATE_PASSED'),
            false
        );

        const docImpactResult = runDocImpactGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            decision: 'NO_DOC_UPDATES',
            behaviorChanged: false,
            changelogUpdated: false,
            rationale: 'No public docs impact.',
            emitMetrics: false
        });
        assert.equal(docImpactResult.exitCode, 0);

        // Completion gate should pass — no-op artifact was already recorded above
        const passedCompletion = runCompletionGate({
            repoRoot,
            preflightPath,
            taskId
        });
        assert.equal(passedCompletion.outcome, 'PASS', passedCompletion.violations.join('\n'));
        assert.equal(passedCompletion.zero_diff_evidence.status, 'SATISFIED_BY_AUDITED_NO_OP');
        assert.equal(passedCompletion.full_suite_validation_evidence.status, 'NOT_REQUIRED');
        appendTaskEvent(
            getOrchestratorRoot(repoRoot),
            taskId,
            'COMPLETION_GATE_PASSED',
            'PASS',
            'Zero-diff completion gate passed with audited no-op evidence.',
            {}
        );

        const fullSuiteResult = await runFullSuiteValidationCommand({
            repoRoot,
            taskId,
            preflightPath
        });
        assert.equal(fullSuiteResult.exitCode, 0);
        assert.ok(fullSuiteResult.outputText.includes('FULL_SUITE_VALIDATION_SKIPPED'));
        assert.ok(fullSuiteResult.outputText.includes('SkipReason: ZERO_DIFF_NO_REVIEWABLE_SCOPE_NOT_REQUIRED'));

        const auditResult = runTaskAuditSummaryCommand({
            repoRoot,
            taskId
        });
        assert.equal(auditResult.exitCode, 0, auditResult.rendered);
        assert.ok(auditResult.rendered.includes('FinalReportContract: READY'));
        assert.ok(!auditResult.rendered.includes('[ ] compile-gate'));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('keeps suppressed zero-diff reviews inside the review gate until audited no-op is recorded', { concurrency: false }, async () => {
        const taskId = 'T-312-zero-review';
        const { repoRoot, preflightPath, outputFiltersPath } = await setupZeroDiffReviewGateFixture(taskId);

        const failedReviewResult = runRequiredReviewsCheckCommand({
            repoRoot,
            taskId,
            preflightPath,
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(failedReviewResult.exitCode, EXIT_GATE_FAILURE);
        const failedReviewOutput = failedReviewResult.outputLines.join('\n');
        assert.ok(failedReviewOutput.includes(`record-no-op --task-id "${taskId}"`));
        assert.ok(failedReviewOutput.includes(`--preflight-path "${preflightPath.replace(/\\/g, '/')}"`));
        assertNoDelegatedReviewArtifacts(repoRoot, taskId);

        const failedReviewGate = JSON.parse(
            fs.readFileSync(path.join(getReviewsRoot(repoRoot), `${taskId}-review-gate.json`), 'utf8')
        ) as Record<string, unknown>;
        const failedZeroDiffGuard = failedReviewGate.zero_diff_guard as Record<string, unknown>;
        assert.equal(failedZeroDiffGuard.status, 'REQUIRES_DIFF_OR_NO_OP');
        assert.equal(failedZeroDiffGuard.no_op_evidence_status, 'EVIDENCE_FILE_MISSING');

        const noOpResult = runRecordNoOpCommand({
            repoRoot,
            taskId,
            preflightPath,
            classification: 'ALREADY_DONE',
            reason: 'The current baseline already satisfies this zero-diff closeout.',
            emitMetrics: false
        });
        assert.equal(noOpResult.exitCode, 0);

        const noOpPath = path.join(getReviewsRoot(repoRoot), `${taskId}-no-op.json`);
        const missingHashNoOp = JSON.parse(fs.readFileSync(noOpPath, 'utf8')) as Record<string, unknown>;
        delete missingHashNoOp.preflight_sha256;
        fs.writeFileSync(noOpPath, JSON.stringify(missingHashNoOp, null, 2), 'utf8');

        const missingHashReviewResult = runRequiredReviewsCheckCommand({
            repoRoot,
            taskId,
            preflightPath,
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(missingHashReviewResult.exitCode, EXIT_GATE_FAILURE);
        assert.ok(missingHashReviewResult.outputLines.some((line) => line.includes('EVIDENCE_PREFLIGHT_HASH_MISSING')));

        const refreshedNoOpResult = runRecordNoOpCommand({
            repoRoot,
            taskId,
            preflightPath,
            classification: 'ALREADY_DONE',
            reason: 'The current baseline already satisfies this zero-diff closeout.',
            emitMetrics: false
        });
        assert.equal(refreshedNoOpResult.exitCode, 0);

        const passedReviewResult = runRequiredReviewsCheckCommand({
            repoRoot,
            taskId,
            preflightPath,
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(passedReviewResult.exitCode, 0);
        assertNoDelegatedReviewArtifacts(repoRoot, taskId);

        const passedReviewGate = JSON.parse(
            fs.readFileSync(path.join(getReviewsRoot(repoRoot), `${taskId}-review-gate.json`), 'utf8')
        ) as Record<string, unknown>;
        const passedZeroDiffGuard = passedReviewGate.zero_diff_guard as Record<string, unknown>;
        assert.equal(passedZeroDiffGuard.status, 'SATISFIED_BY_AUDITED_NO_OP');
        assert.equal(passedZeroDiffGuard.no_op_evidence_status, 'PASS');

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('rejects stale no-op evidence for suppressed zero-diff review gate closeout', { concurrency: false }, async () => {
        const taskId = 'T-312-stale-no-op';
        const { repoRoot, preflightPath, commandsPath, outputFiltersPath } = await setupZeroDiffReviewGateFixture(taskId);

        const noOpResult = runRecordNoOpCommand({
            repoRoot,
            taskId,
            preflightPath,
            classification: 'ALREADY_DONE',
            reason: 'The current baseline already satisfies this zero-diff closeout.',
            emitMetrics: false
        });
        assert.equal(noOpResult.exitCode, 0);

        writeZeroDiffNoReviewPreflight(repoRoot, taskId, {
            zero_diff_guard: {
                zero_diff_detected: true,
                status: 'BASELINE_ONLY',
                completion_requires_audited_no_op: true,
                no_op_artifact_suffix: '-no-op.json',
                rationale: 'A refreshed zero-diff preflight must invalidate older no-op evidence.'
            }
        });
        appendPreflightClassifiedEvent(repoRoot, taskId, preflightPath, true);
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath, false);

        const compileResult = await runCompileGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(compileResult.exitCode, 0);

        const staleReviewResult = runRequiredReviewsCheckCommand({
            repoRoot,
            taskId,
            preflightPath,
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(staleReviewResult.exitCode, EXIT_GATE_FAILURE);
        assert.ok(staleReviewResult.outputLines.some((line) => line.includes('EVIDENCE_PREFLIGHT_HASH_MISMATCH')));

        const staleReviewGate = JSON.parse(
            fs.readFileSync(path.join(getReviewsRoot(repoRoot), `${taskId}-review-gate.json`), 'utf8')
        ) as Record<string, unknown>;
        const staleZeroDiffGuard = staleReviewGate.zero_diff_guard as Record<string, unknown>;
        assert.equal(staleZeroDiffGuard.status, 'REQUIRES_DIFF_OR_NO_OP');
        assert.equal(staleZeroDiffGuard.no_op_evidence_status, 'EVIDENCE_PREFLIGHT_HASH_MISMATCH');

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('rejects foreign no-op evidence for suppressed zero-diff review gate closeout', { concurrency: false }, async () => {
        const taskId = 'T-312-foreign-no-op';
        const { repoRoot, preflightPath, outputFiltersPath } = await setupZeroDiffReviewGateFixture(taskId);

        const noOpResult = runRecordNoOpCommand({
            repoRoot,
            taskId,
            preflightPath,
            classification: 'ALREADY_DONE',
            reason: 'The current baseline already satisfies this zero-diff closeout.',
            emitMetrics: false
        });
        assert.equal(noOpResult.exitCode, 0);

        const noOpPath = path.join(getReviewsRoot(repoRoot), `${taskId}-no-op.json`);
        const noOpArtifact = JSON.parse(fs.readFileSync(noOpPath, 'utf8')) as Record<string, unknown>;
        noOpArtifact.task_id = 'T-312F';
        fs.writeFileSync(noOpPath, JSON.stringify(noOpArtifact, null, 2), 'utf8');

        const foreignReviewResult = runRequiredReviewsCheckCommand({
            repoRoot,
            taskId,
            preflightPath,
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(foreignReviewResult.exitCode, EXIT_GATE_FAILURE);
        assert.ok(foreignReviewResult.outputLines.some((line) => line.includes('EVIDENCE_TASK_MISMATCH')));

        const foreignReviewGate = JSON.parse(
            fs.readFileSync(path.join(getReviewsRoot(repoRoot), `${taskId}-review-gate.json`), 'utf8')
        ) as Record<string, unknown>;
        const foreignZeroDiffGuard = foreignReviewGate.zero_diff_guard as Record<string, unknown>;
        assert.equal(foreignZeroDiffGuard.status, 'REQUIRES_DIFF_OR_NO_OP');
        assert.equal(foreignZeroDiffGuard.no_op_evidence_status, 'EVIDENCE_TASK_MISMATCH');

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('accepts substantive audited zero-diff rationales without keyword classification', { concurrency: false }, async () => {
        const taskId = 'T-312-external-input';
        const { repoRoot, preflightPath, outputFiltersPath } = await setupZeroDiffReviewGateFixture(taskId);

        for (const reason of [
            'Waiting for external operator input before this task can continue.',
            'An audit confirmed that the intended change is already complete.',
            'Investigation established that no implementation change is required.'
        ]) {
            const noOpResult = runRecordNoOpCommand({
                repoRoot,
                taskId,
                preflightPath,
                classification: 'AUDIT_ONLY',
                reason,
                emitMetrics: false
            });
            assert.equal(noOpResult.exitCode, 0);
            assert.ok(noOpResult.outputLines.includes('NO_OP_RECORDED'));
        }

        const noOpPath = path.join(getReviewsRoot(repoRoot), `${taskId}-no-op.json`);
        const noOpArtifact = JSON.parse(fs.readFileSync(noOpPath, 'utf8')) as Record<string, unknown>;
        assert.equal(noOpArtifact.status, 'PASSED');
        assert.equal(noOpArtifact.outcome, 'PASS');

        const reviewResult = runRequiredReviewsCheckCommand({
            repoRoot,
            taskId,
            preflightPath,
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(reviewResult.exitCode, 0);

        const reviewGate = JSON.parse(
            fs.readFileSync(path.join(getReviewsRoot(repoRoot), `${taskId}-review-gate.json`), 'utf8')
        ) as Record<string, unknown>;
        const zeroDiffGuard = reviewGate.zero_diff_guard as Record<string, unknown>;
        assert.equal(zeroDiffGuard.status, 'SATISFIED_BY_AUDITED_NO_OP');
        assert.equal(zeroDiffGuard.no_op_evidence_status, 'PASS');

        const completionResult = runCompletionGate({
            repoRoot,
            preflightPath,
            taskId
        });
        assert.equal(completionResult.zero_diff_evidence.status, 'SATISFIED_BY_AUDITED_NO_OP');

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

});
