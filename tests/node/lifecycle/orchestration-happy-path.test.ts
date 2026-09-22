import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

import { DEFAULT_BUNDLE_NAME } from '../../../src/core/constants';
import {
    DEFAULT_OPTIONAL_QUALITY_CHECK_RULES,
    isOptionalQualityCheckRuleActiveForScope
} from '../../../src/core/workflow-config';
import { PROJECT_MEMORY_REQUIRED_FILE_NAMES } from '../../../src/core/project-memory';
import { handleSetup } from '../../../src/cli/commands/setup';
import { handleGate } from '../../../src/cli/commands/gate-command';
import { runAgentInit } from '../../../src/lifecycle/agent-init';
import { executeNextStepEffects, resolveNextStep } from '../../../src/gates/next-step';
import {
    runClassifyChangeCommand,
    runCompileGateCommand,
    runDocImpactGateCommand,
    runEnterTaskModeCommand,
    runFullSuiteValidationCommand,
    runHandshakeDiagnosticsCommand,
    runLoadRulePackCommand,
    runProjectMemoryImpactCommand,
    runQualityChecklistCommand,
    runRequiredReviewsCheckCommand,
    runShellSmokePreflightCommand
} from '../../../src/cli/commands/gates';
import { runBuildReviewContextCommand } from '../../../src/cli/commands/gate-flows/review-context/review-context-flow';
import { handleCompletionGate } from '../../../src/cli/commands/gate-task-handlers';
import {
    initializeGitRepo,
    runGit
} from '../cli/commands/gate-test-helpers';
import {
    readTaskQueueStatusFromTaskFile,
    readTaskTimelineEvents
} from '../cli/commands/gate-test-helpers';
import { runCliWithCapturedOutput } from '../cli/commands/gate-test-helpers';
import {
    buildNoFindingsJsonReviewReport
} from '../cli/commands/gates/review-result/gates-command-review-result-fixtures';

const TASK_ID = 'T-215-smoke';
const TASK_SUMMARY = 'Exercise the canonical happy path from onboarding through task completion';

function findRepoRoot(): string {
    let dir = __dirname;
    while (dir !== path.dirname(dir)) {
        if (fs.existsSync(path.join(dir, 'VERSION')) && fs.existsSync(path.join(dir, 'template'))) {
            return dir;
        }
        dir = path.dirname(dir);
    }
    throw new Error('Cannot find repo root');
}

async function captureConsoleAsync<T>(callback: () => Promise<T>): Promise<T> {
    const originalConsoleLog = console.log;
    const originalConsoleError = console.error;
    console.log = () => undefined;
    console.error = () => undefined;
    try {
        return await callback();
    } finally {
        console.log = originalConsoleLog;
        console.error = originalConsoleError;
    }
}

function createWorkspace(sourceRoot: string): string {
    const repoRootToken = path.basename(sourceRoot).replace(/[^a-zA-Z0-9._-]/g, '-');
    const baseDir = path.join(os.tmpdir(), 'garda-test-workspaces', repoRootToken);
    fs.mkdirSync(baseDir, { recursive: true });
    return fs.mkdtempSync(path.join(baseDir, 'gao-orchestration-happy-path-'));
}

function writeTextFile(filePath: string, content: string): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
}

function materializeProjectCommands(bundleRoot: string): void {
    const commandsPath = path.join(bundleRoot, 'live', 'docs', 'agent-rules', '40-commands.md');
    let content = fs.readFileSync(commandsPath, 'utf8');
    const replacements = new Map([
        ['<install dependencies command>', 'npm install --prefer-offline --no-fund --no-audit'],
        ['<local environment bootstrap command>', 'npm run bootstrap'],
        ['<start backend command>', 'npm run dev:backend'],
        ['<start frontend command>', 'npm run dev:frontend'],
        ['<start worker or background job command>', 'npm run dev:worker'],
        ['<unit test command>', 'npm test'],
        ['<integration test command>', 'npm run test:integration'],
        ['<e2e test command>', 'npm run test:e2e'],
        ['<lint command>', 'npm run lint'],
        ['<type-check command>', 'npx tsc --noEmit --pretty false'],
        ['<format check command>', 'npm run format:check'],
        ['<compile command>', 'npm run build'],
        ['<build command>', 'npm run build'],
        ['<container or artifact packaging command>', 'docker build .']
    ]);

    for (const [placeholder, replacement] of replacements) {
        content = content.replaceAll(placeholder, replacement);
    }
    fs.writeFileSync(commandsPath, content, 'utf8');
}

function materializeProjectMemory(bundleRoot: string): void {
    for (const fileName of PROJECT_MEMORY_REQUIRED_FILE_NAMES) {
        writeTextFile(
            path.join(bundleRoot, 'live', 'docs', 'project-memory', fileName),
            [
                `# ${fileName}`,
                '',
                `Happy-path fixture memory for ${fileName}.`,
                'This content represents project-specific memory confirmed during agent initialization.'
            ].join('\n')
        );
    }
}

function seedFixtureProject(workspaceRoot: string): void {
    writeTextFile(path.join(workspaceRoot, 'package.json'), JSON.stringify({
        name: 'garda-orchestration-happy-path-fixture',
        private: true,
        scripts: {
            build: 'node scripts/build-check.cjs',
            test: 'node scripts/full-suite-check.cjs'
        }
    }, null, 2) + '\n');
    writeTextFile(path.join(workspaceRoot, 'src', 'app.ts'), [
        'export function renderStatus() {',
        '    return "ready";',
        '}',
        ''
    ].join('\n'));
    writeTextFile(path.join(workspaceRoot, 'tests', 'app.test.ts'), [
        'import assert from "node:assert/strict";',
        'import test from "node:test";',
        '',
        'test("status starts ready", () => {',
        '    assert.equal("ready", "ready");',
        '});',
        ''
    ].join('\n'));
    writeTextFile(path.join(workspaceRoot, 'scripts', 'build-check.cjs'), [
        'const fs = require("node:fs");',
        'for (const file of ["src/app.ts", "tests/app.test.ts"]) {',
        '  if (!fs.existsSync(file)) throw new Error(`Missing ${file}`);',
        '}',
        'console.log("build ok");',
        ''
    ].join('\n'));
    writeTextFile(path.join(workspaceRoot, 'scripts', 'full-suite-check.cjs'), [
        'const fs = require("node:fs");',
        'const text = fs.readFileSync("tests/app.test.ts", "utf8");',
        'if (!text.includes("status handles completed path")) {',
        '  throw new Error("Expected completed-path test update");',
        '}',
        'console.log("full suite ok");',
        ''
    ].join('\n'));
}

function seedSetupAnswers(workspaceRoot: string): void {
    writeTextFile(path.join(workspaceRoot, DEFAULT_BUNDLE_NAME, 'runtime', 'init-answers.json'), JSON.stringify({
        AssistantLanguage: 'English',
        AssistantBrevity: 'concise',
        SourceOfTruth: 'Codex',
        EnforceNoAutoCommit: 'false',
        ClaudeOrchestratorFullAccess: 'false',
        TokenEconomyEnabled: 'true',
        ProviderMinimalism: 'false',
        CollectedVia: 'CLI_NONINTERACTIVE',
        ActiveAgentFiles: 'AGENTS.md'
    }, null, 2) + '\n');
}

function seedTaskQueue(repoRoot: string): void {
    fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
        '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
        '|---|---|---|---|---|---|---|---|---|',
        `| ${TASK_ID} | 🟦 TODO | P1 | testing/orchestration-happy-path-e2e | ${TASK_SUMMARY} | gpt-5.4 | 2026-05-16 | balanced | Fixture task for the integrated orchestration happy-path smoke. |`,
        ''
    ].join('\n'), 'utf8');
}

function configureWorkflow(bundleRoot: string): void {
    const configPath = path.join(bundleRoot, 'live', 'config', 'workflow-config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
        full_suite_validation: {
            enabled?: boolean;
            command?: string;
            timeout_ms?: number;
        };
        project_memory_maintenance: {
            enabled?: boolean;
            mode?: string;
            run_before_final_closeout?: boolean;
        };
    };
    config.full_suite_validation.enabled = true;
    config.full_suite_validation.command = 'npm test';
    config.full_suite_validation.timeout_ms = 120000;
    (config as typeof config & { compile_gate: { command?: string } }).compile_gate.command = 'npm run build';
    config.project_memory_maintenance.enabled = true;
    config.project_memory_maintenance.mode = 'check';
    config.project_memory_maintenance.run_before_final_closeout = true;
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
}

function configureReviewCapabilities(bundleRoot: string): void {
    writeTextFile(path.join(bundleRoot, 'live', 'config', 'review-capabilities.json'), JSON.stringify({
        code: true,
        db: true,
        security: true,
        refactor: true,
        api: true,
        test: true,
        performance: true,
        infra: true,
        dependency: true
    }, null, 2) + '\n');
}

function seedFixtureTestReviewSkill(bundleRoot: string): void {
    const sourcePath = path.join(
        findRepoRoot(),
        'template',
        'skill-packs',
        'quality-architecture',
        'skills',
        'testing-strategy',
        'SKILL.md'
    );
    writeTextFile(
        path.join(bundleRoot, 'live', 'skills', 'testing-strategy', 'SKILL.md'),
        fs.readFileSync(sourcePath, 'utf8')
    );
}

function disableFixtureTaskDecomposition(bundleRoot: string): void {
    const profilesPath = path.join(bundleRoot, 'live', 'config', 'profiles.json');
    const profiles = JSON.parse(fs.readFileSync(profilesPath, 'utf8')) as {
        built_in_profiles: Record<string, { task_decomposition?: { enabled?: boolean } }>;
    };
    profiles.built_in_profiles.balanced.task_decomposition = { enabled: false };
    fs.writeFileSync(profilesPath, `${JSON.stringify(profiles, null, 2)}\n`, 'utf8');
}

function applyTinyFixtureDiff(workspaceRoot: string): void {
    writeTextFile(path.join(workspaceRoot, 'tests', 'app.test.ts'), [
        'import assert from "node:assert/strict";',
        'import test from "node:test";',
        '',
        'test("status starts ready", () => {',
        '    assert.equal("ready", "ready");',
        '});',
        '',
        'test("status handles completed path", () => {',
        '    assert.equal(["ready", "done"].includes("done"), true);',
        '});',
        ''
    ].join('\n'));
}

function assertNextGate(repoRoot: string, expectedGate: string): void {
    let nextStep = resolveNextStep({ taskId: TASK_ID, repoRoot });
    for (let effectBatch = 0; effectBatch < 16 && nextStep.next_gate === 'next-step-effect'; effectBatch += 1) {
        const planSha256 = (nextStep.commands[0]?.command || '')
            .match(/--effect-plan-sha256\s+["']?([a-f0-9]{64})/u)?.[1] || '';
        assert.match(planSha256, /^[a-f0-9]{64}$/u, nextStep.reason);
        nextStep = executeNextStepEffects({ taskId: TASK_ID, repoRoot }, planSha256);
    }
    assert.equal(nextStep.next_gate, expectedGate, nextStep.reason);
}

function assertGatePassed(result: { exitCode: number; outputLines?: string[]; outputText?: string }, label: string): void {
    assert.equal(
        result.exitCode,
        0,
        `${label} failed:\n${result.outputLines?.join('\n') || result.outputText || ''}`
    );
}

function buildQualityChecklistAnswersJson(): string {
    const scopeCategory = 'test-only';
    const changedFiles = ['tests/app.test.ts'];
    const answersByRuleId: Record<string, {
        answer: string;
        evidence_files: string[];
    }> = {
        code_simplification: {
            answer: 'The fixture change is intentionally tiny and keeps the lifecycle sequence direct.',
            evidence_files: ['tests/app.test.ts']
        },
        project_style_fit: {
            answer: 'The fixture follows the existing node:test style and local helper flow.',
            evidence_files: ['tests/app.test.ts']
        },
        unnecessary_abstraction: {
            answer: 'No abstraction is added in the fixture change.',
            evidence_files: ['tests/app.test.ts']
        },
        size_growth: {
            answer: 'The file growth is limited to one focused assertion.',
            evidence_files: ['tests/app.test.ts']
        },
        hardcoded_values_contracts: {
            answer: 'The literal values are fixture assertions and do not introduce shared contracts.',
            evidence_files: ['tests/app.test.ts']
        },
        duplicated_logic_contracts: {
            answer: 'No duplicated production logic is introduced.',
            evidence_files: ['tests/app.test.ts']
        },
        test_verification_scope: {
            answer: 'The lifecycle fixture verifies the changed test through compile and full-suite gates.',
            evidence_files: ['tests/app.test.ts', 'scripts/full-suite-check.cjs']
        }
    };
    return JSON.stringify(DEFAULT_OPTIONAL_QUALITY_CHECK_RULES
        .filter((rule) => isOptionalQualityCheckRuleActiveForScope(rule, scopeCategory, changedFiles))
        .map((rule) => ({
            rule_id: rule.id,
            status: 'PASS',
            answer: answersByRuleId[rule.id]?.answer
                ?? `The fixture has no ${rule.title.toLowerCase()} risk beyond the focused test-only change.`,
            evidence_files: answersByRuleId[rule.id]?.evidence_files ?? ['tests/app.test.ts'],
            actions_taken: [],
            actions_required: []
        })));
}

async function runReviewGateCommand(repoRoot: string, args: string[]): Promise<void> {
    const previousExitCode = process.exitCode;
    try {
        process.exitCode = 0;
        await captureConsoleAsync(async () => {
            await handleGate([...args, '--repo-root', repoRoot]);
        });
        assert.equal(process.exitCode ?? 0, 0, `gate ${args[0]} failed`);
    } finally {
        process.exitCode = previousExitCode;
    }
}

async function runCompletion(repoRoot: string, preflightPath: string): Promise<void> {
    const previousExitCode = process.exitCode;
    try {
        process.exitCode = 0;
        await captureConsoleAsync(async () => {
            await handleCompletionGate([
                '--preflight-path', preflightPath,
                '--task-id', TASK_ID,
                '--repo-root', repoRoot
            ]);
        });
        assert.equal(process.exitCode ?? 0, 0);
    } finally {
        process.exitCode = previousExitCode;
    }
}

test('orchestration happy path reaches DONE from setup through task audit', { concurrency: false }, async () => {
    const sourceRoot = findRepoRoot();
    const packageJson = JSON.parse(fs.readFileSync(path.join(sourceRoot, 'package.json'), 'utf8'));
    const workspaceRoot = createWorkspace(sourceRoot);
    const bundleRoot = path.join(workspaceRoot, DEFAULT_BUNDLE_NAME);
    const preflightPath = path.join(bundleRoot, 'runtime', 'reviews', `${TASK_ID}-preflight.json`);
    const reviewContextPath = path.join(bundleRoot, 'runtime', 'reviews', `${TASK_ID}-test-review-context.json`);
    let reviewOutputPath = '';
    const materializedReviewOutputPath = path.join(bundleRoot, 'runtime', 'reviews', `${TASK_ID}-test-review-output.md`);
    const reviewerLaunchArtifactPath = path.join(bundleRoot, 'runtime', 'tmp', 'reviews', TASK_ID, 'test', 'reviewer-launch.json');
    const reviewerLaunchInputArtifactPath = path.join(bundleRoot, 'runtime', 'tmp', 'reviews', TASK_ID, 'test', 'reviewer-launch-input.json');
    const reviewReceiptPath = path.join(bundleRoot, 'runtime', 'reviews', `${TASK_ID}-test-receipt.json`);
    const plannedReviewerIdentity = `agent:pending:${TASK_ID}-test`;
    const resolvedReviewerIdentity = 'agent:e2e-provider-resolved-test-reviewer';
    const providerInvocationId = 'provider-e2e-test-reviewer-001';
    const attestationSource = 'test_provider_controller';

    try {
        runGit(workspaceRoot, ['init']);
        seedSetupAnswers(workspaceRoot);
        await captureConsoleAsync(async () => {
            await handleSetup(
                ['--target-root', workspaceRoot, '--no-prompt', '--skip-verify', '--skip-manifest-validation', '--source-of-truth', 'Codex'],
                packageJson,
                sourceRoot
            );
        });
        materializeProjectCommands(bundleRoot);
        materializeProjectMemory(bundleRoot);
        seedFixtureProject(workspaceRoot);
        configureWorkflow(bundleRoot);
        configureReviewCapabilities(bundleRoot);
        seedFixtureTestReviewSkill(bundleRoot);
        disableFixtureTaskDecomposition(bundleRoot);
        const agentInitResult = runAgentInit({
            targetRoot: workspaceRoot,
            activeAgentFiles: 'AGENTS.md',
            projectRulesUpdated: 'yes',
            skillsPrompted: 'yes',
            ordinaryDocPaths: 'CHANGELOG.md',
            verifyRunner: () => ({ passed: true }),
            manifestRunner: () => ({ passed: true })
        });
        assert.equal(agentInitResult.readyForTasks, true, JSON.stringify(agentInitResult.state, null, 2));
        seedTaskQueue(workspaceRoot);
        initializeGitRepo(workspaceRoot);

        const prepromptResult = await runCliWithCapturedOutput(
            ['preprompt', 'task', '--task-id', TASK_ID, '--json'],
            { cwd: workspaceRoot }
        );
        assert.equal(prepromptResult.exitCode, 0, prepromptResult.errors.join('\n'));
        const preprompt = JSON.parse(prepromptResult.logs.join('\n')) as Record<string, unknown>;
        assert.equal((preprompt.task as Record<string, unknown>).id, TASK_ID);
        assert.equal((preprompt.commands as Record<string, unknown>).startup_pending, true);

        assertNextGate(workspaceRoot, 'enter-task-mode');
        assertGatePassed(runEnterTaskModeCommand({
            repoRoot: workspaceRoot,
            taskId: TASK_ID,
            entryMode: 'EXPLICIT_TASK_EXECUTION',
            requestedDepth: 2,
            taskSummary: TASK_SUMMARY,
            provider: 'Codex',
            routedTo: 'AGENTS.md',
            emitMetrics: false
        }), 'enter-task-mode');

        assertNextGate(workspaceRoot, 'load-rule-pack');
        assertGatePassed(runLoadRulePackCommand({
            repoRoot: workspaceRoot,
            taskId: TASK_ID,
            stage: 'TASK_ENTRY',
            loadedRuleFiles: [
                'garda-agent-orchestrator/live/docs/agent-rules/00-core.md',
                'garda-agent-orchestrator/live/docs/agent-rules/15-project-memory.md',
                'garda-agent-orchestrator/live/docs/agent-rules/40-commands.md',
                'garda-agent-orchestrator/live/docs/agent-rules/80-task-workflow.md',
                'garda-agent-orchestrator/live/docs/agent-rules/90-skill-catalog.md'
            ],
            emitMetrics: false
        }), 'load-rule-pack TASK_ENTRY');

        assertNextGate(workspaceRoot, 'handshake-diagnostics');
        assertGatePassed(runHandshakeDiagnosticsCommand({
            repoRoot: workspaceRoot,
            taskId: TASK_ID,
            provider: 'Codex',
            emitMetrics: false
        }), 'handshake-diagnostics');

        assertNextGate(workspaceRoot, 'shell-smoke-preflight');
        assertGatePassed(runShellSmokePreflightCommand({
            repoRoot: workspaceRoot,
            taskId: TASK_ID,
            provider: 'Codex',
            routedTo: 'AGENTS.md',
            emitMetrics: false
        }), 'shell-smoke-preflight');

        applyTinyFixtureDiff(workspaceRoot);
        assertNextGate(workspaceRoot, 'classify-change');
        const classifyResult = runClassifyChangeCommand({
            repoRoot: workspaceRoot,
            taskId: TASK_ID,
            taskIntent: TASK_SUMMARY,
            outputPath: preflightPath,
            emitMetrics: false
        });
        const preflight = JSON.parse(classifyResult.outputText) as Record<string, unknown>;
        assert.deepEqual(preflight.changed_files, ['tests/app.test.ts']);
        assert.equal((preflight.required_reviews as Record<string, unknown>).test, true);

        assertNextGate(workspaceRoot, 'load-rule-pack');
        assertGatePassed(runLoadRulePackCommand({
            repoRoot: workspaceRoot,
            taskId: TASK_ID,
            stage: 'POST_PREFLIGHT',
            preflightPath,
            loadedRuleFiles: [
                'garda-agent-orchestrator/live/docs/agent-rules/00-core.md',
                'garda-agent-orchestrator/live/docs/agent-rules/15-project-memory.md',
                'garda-agent-orchestrator/live/docs/agent-rules/30-code-style.md',
                'garda-agent-orchestrator/live/docs/agent-rules/35-strict-coding-rules.md',
                'garda-agent-orchestrator/live/docs/agent-rules/40-commands.md',
                'garda-agent-orchestrator/live/docs/agent-rules/50-structure-and-docs.md',
                'garda-agent-orchestrator/live/docs/agent-rules/70-security.md',
                'garda-agent-orchestrator/live/docs/agent-rules/80-task-workflow.md',
                'garda-agent-orchestrator/live/docs/agent-rules/90-skill-catalog.md'
            ],
            emitMetrics: false
        }), 'load-rule-pack POST_PREFLIGHT');

        const qualityChecklistAnswersPath = path.join(
            bundleRoot,
            'runtime',
            'tmp',
            `${TASK_ID}-quality-checklist-answers.json`
        );
        assertNextGate(workspaceRoot, 'quality-checklist');
        assert.equal(fs.existsSync(qualityChecklistAnswersPath), true);

        const qualityChecklistAnswersTemplate = JSON.parse(
            fs.readFileSync(qualityChecklistAnswersPath, 'utf8')
        ) as { answers: Array<Record<string, unknown>> };
        const answersByRuleId = new Map(
            (JSON.parse(buildQualityChecklistAnswersJson()) as Array<Record<string, unknown>>)
                .map((answer) => [String(answer.rule_id), answer])
        );
        qualityChecklistAnswersTemplate.answers = qualityChecklistAnswersTemplate.answers.map((answer) => ({
            ...answer,
            ...answersByRuleId.get(String(answer.rule_id))
        }));
        fs.writeFileSync(
            qualityChecklistAnswersPath,
            JSON.stringify(qualityChecklistAnswersTemplate, null, 2) + '\n',
            'utf8'
        );

        assertNextGate(workspaceRoot, 'quality-checklist');
        assertGatePassed(runQualityChecklistCommand({
            repoRoot: workspaceRoot,
            taskId: TASK_ID,
            preflightPath,
            answersPath: qualityChecklistAnswersPath,
            emitMetrics: false
        }), 'quality-checklist');

        assertNextGate(workspaceRoot, 'compile-gate');
        assertGatePassed(await runCompileGateCommand({
            repoRoot: workspaceRoot,
            taskId: TASK_ID,
            preflightPath,
            commandsPath: path.join(bundleRoot, 'live', 'docs', 'agent-rules', '40-commands.md'),
            emitMetrics: false
        }), 'compile-gate');

        assertNextGate(workspaceRoot, 'full-suite-validation');
        assertGatePassed(await runFullSuiteValidationCommand({
            repoRoot: workspaceRoot,
            taskId: TASK_ID,
            preflightPath
        }), 'full-suite-validation');

        assertNextGate(workspaceRoot, 'build-review-context');
        const reviewContextResult = await runBuildReviewContextCommand({
            repoRoot: workspaceRoot,
            reviewType: 'test',
            depth: 2,
            preflightPath,
            outputPath: reviewContextPath,
            scopedDiffMetadataPath: path.join(bundleRoot, 'runtime', 'reviews', `${TASK_ID}-test-scoped.json`)
        });
        assert.equal(reviewContextResult.reusedReviewEvidence, false);
        assert.equal(fs.existsSync(reviewContextPath), true);

        assertNextGate(workspaceRoot, 'record-review-routing');
        await runReviewGateCommand(workspaceRoot, [
            'record-review-routing',
            '--task-id', TASK_ID,
            '--review-type', 'test',
            '--review-context-path', reviewContextPath,
            '--reviewer-execution-mode', 'delegated_subagent'
        ]);
        const routedReviewContext = JSON.parse(fs.readFileSync(reviewContextPath, 'utf8')) as Record<string, unknown>;
        const routedMetadata = routedReviewContext.reviewer_routing as Record<string, unknown>;
        assert.equal(routedMetadata.reviewer_session_id, plannedReviewerIdentity);

        assertNextGate(workspaceRoot, 'prepare-reviewer-launch');
        await runReviewGateCommand(workspaceRoot, [
            'prepare-reviewer-launch',
            '--task-id', TASK_ID,
            '--review-type', 'test',
            '--review-context-path', reviewContextPath,
            '--reviewer-execution-mode', 'delegated_subagent',
            '--reviewer-launch-artifact-path', reviewerLaunchArtifactPath
        ]);
        const preparedLaunchArtifact = JSON.parse(fs.readFileSync(reviewerLaunchArtifactPath, 'utf8')) as Record<string, unknown>;
        assert.equal(preparedLaunchArtifact.reviewer_identity, plannedReviewerIdentity);
        assert.equal(preparedLaunchArtifact.planned_reviewer_identity, plannedReviewerIdentity);
        assert.equal(String(preparedLaunchArtifact.record_invocation_command || '').includes(plannedReviewerIdentity), true);
        reviewOutputPath = String(preparedLaunchArtifact.review_output_path || '').trim();
        assert.notEqual(reviewOutputPath, '', 'Expected the prepared launch to pin an attempt-specific review output path.');

        assertNextGate(workspaceRoot, 'record-reviewer-delegation-started');
        const preparedReviewerLaunchInputArtifactSha256 = createHash('sha256')
            .update(fs.readFileSync(reviewerLaunchInputArtifactPath))
            .digest('hex');
        await runReviewGateCommand(workspaceRoot, [
            'record-reviewer-delegation-started',
            '--task-id', TASK_ID,
            '--review-type', 'test',
            '--review-context-path', reviewContextPath,
            '--reviewer-execution-mode', 'delegated_subagent',
            '--reviewer-identity', resolvedReviewerIdentity,
            '--reviewer-launch-artifact-path', reviewerLaunchArtifactPath,
            '--provider-invocation-id', providerInvocationId,
            '--attestation-source', attestationSource,
            '--launch-input-mode', 'launch_artifact_path',
            '--launch-input-artifact-path', reviewerLaunchInputArtifactPath,
            '--launch-input-sha256', preparedReviewerLaunchInputArtifactSha256,
            '--fresh-context',
            '--fork-context', 'false'
        ]);
        const startedLaunchArtifact = JSON.parse(fs.readFileSync(reviewerLaunchArtifactPath, 'utf8')) as Record<string, unknown>;
        assert.equal(startedLaunchArtifact.reviewer_identity, resolvedReviewerIdentity);
        assert.equal(startedLaunchArtifact.planned_reviewer_identity, plannedReviewerIdentity);
        assert.equal(String(startedLaunchArtifact.record_invocation_command || '').includes(resolvedReviewerIdentity), true);
        assert.equal(String(startedLaunchArtifact.record_invocation_command || '').includes(plannedReviewerIdentity), false);
        await new Promise((resolve) => setTimeout(resolve, 10_100));

        assertNextGate(workspaceRoot, 'complete-reviewer-launch');
        writeTextFile(
            reviewOutputPath,
            `${JSON.stringify(buildNoFindingsJsonReviewReport(reviewContextPath, TASK_ID, 'test'), null, 2)}\n`
        );
        await runReviewGateCommand(workspaceRoot, [
            'complete-reviewer-launch',
            '--task-id', TASK_ID,
            '--review-type', 'test',
            '--review-context-path', reviewContextPath,
            '--reviewer-execution-mode', 'delegated_subagent',
            '--reviewer-identity', resolvedReviewerIdentity,
            '--reviewer-launch-artifact-path', reviewerLaunchArtifactPath,
            '--provider-invocation-id', providerInvocationId,
            '--attestation-source', attestationSource,
            '--launch-input-mode', 'launch_artifact_path',
            '--launch-input-artifact-path', reviewerLaunchInputArtifactPath,
            '--launch-input-sha256', preparedReviewerLaunchInputArtifactSha256,
            '--fresh-context',
            '--fork-context', 'false',
            '--record-invocation'
        ]);
        const completedLaunchArtifact = JSON.parse(fs.readFileSync(reviewerLaunchArtifactPath, 'utf8')) as Record<string, unknown>;
        assert.equal(completedLaunchArtifact.attestation_state, 'launched');
        assert.equal(completedLaunchArtifact.reviewer_identity, resolvedReviewerIdentity);
        assert.equal(completedLaunchArtifact.planned_reviewer_identity, plannedReviewerIdentity);
        assert.ok(readTaskTimelineEvents(workspaceRoot, TASK_ID).some((event) => {
            if (String(event.event_type || '').trim() !== 'REVIEWER_INVOCATION_ATTESTED') {
                return false;
            }
            const details = event.details && typeof event.details === 'object'
                ? event.details as Record<string, unknown>
                : {};
            return String(details.reviewer_identity || details.reviewer_session_id || '').trim() === resolvedReviewerIdentity;
        }), 'Expected complete-reviewer-launch --record-invocation to record resolved reviewer invocation telemetry.');

        assertNextGate(workspaceRoot, 'record-review-result');
        assertNextGate(workspaceRoot, 'record-review-result');
        await runReviewGateCommand(workspaceRoot, [
            'record-review-result',
            '--task-id', TASK_ID,
            '--review-type', 'test',
            '--preflight-path', preflightPath,
            '--review-context-path', reviewContextPath,
            '--review-output-path', reviewOutputPath,
            '--reviewer-execution-mode', 'delegated_subagent',
            '--reviewer-identity', resolvedReviewerIdentity
        ]);
        assert.ok(fs.existsSync(reviewReceiptPath), `Expected review receipt at ${reviewReceiptPath}.`);
        if (resolveNextStep({ taskId: TASK_ID, repoRoot: workspaceRoot }).next_gate === 'record-review-result') {
            await runReviewGateCommand(workspaceRoot, [
                'record-review-result',
                '--task-id', TASK_ID,
                '--review-type', 'test',
                '--preflight-path', preflightPath,
                '--review-context-path', reviewContextPath,
                '--review-output-path', materializedReviewOutputPath,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', resolvedReviewerIdentity
            ]);
        }

        assertNextGate(workspaceRoot, 'required-reviews-check');
        assertGatePassed(runRequiredReviewsCheckCommand({
            repoRoot: workspaceRoot,
            taskId: TASK_ID,
            preflightPath,
            reviewAuthorshipAttestationJson: '{"test":true}',
            emitMetrics: false
        }), 'required-reviews-check');

        assertNextGate(workspaceRoot, 'doc-impact-gate');
        assertGatePassed(runDocImpactGateCommand({
            repoRoot: workspaceRoot,
            taskId: TASK_ID,
            preflightPath,
            decision: 'NO_DOC_UPDATES',
            behaviorChanged: false,
            changelogUpdated: false,
            rationale: 'The fixture change adds test coverage only and does not change user-facing documentation.',
            emitMetrics: false
        }), 'doc-impact-gate');

        assertNextGate(workspaceRoot, 'project-memory-impact');
        assertGatePassed(runProjectMemoryImpactCommand({
            repoRoot: workspaceRoot,
            taskId: TASK_ID,
            preflightPath
        }), 'project-memory-impact');

        assertNextGate(workspaceRoot, 'completion-gate');
        await runCompletion(workspaceRoot, preflightPath);

        const completedNextStep = resolveNextStep({ taskId: TASK_ID, repoRoot: workspaceRoot });
        assert.equal(completedNextStep.status, 'DONE', completedNextStep.reason);
        assert.equal(completedNextStep.next_gate, null, completedNextStep.reason);
        assert.ok(completedNextStep.final_report, 'Expected final report to be ready immediately after completion-gate.');
        const finalCloseout = JSON.parse(
            fs.readFileSync(path.join(bundleRoot, 'runtime', 'reviews', `${TASK_ID}-final-closeout.json`), 'utf8')
        ) as Record<string, unknown>;
        assert.equal(finalCloseout.status, 'READY');
        assert.equal(fs.existsSync(path.join(bundleRoot, 'runtime', 'reviews', `${TASK_ID}-final-closeout.md`)), true);
        assert.equal(fs.existsSync(path.join(bundleRoot, 'runtime', 'reviews', `${TASK_ID}-final-user-report.md`)), true);
        assert.equal(readTaskQueueStatusFromTaskFile(workspaceRoot, TASK_ID), 'DONE');

        const eventTypes = readTaskTimelineEvents(workspaceRoot, TASK_ID).map((event) => String(event.event_type));
        const expectedOrder = [
            'TASK_MODE_ENTERED',
            'RULE_PACK_LOADED',
            'HANDSHAKE_DIAGNOSTICS_RECORDED',
            'SHELL_SMOKE_PREFLIGHT_RECORDED',
            'PREFLIGHT_CLASSIFIED',
            'RULE_PACK_LOADED',
            'COMPILE_GATE_PASSED',
            'FULL_SUITE_VALIDATION_PASSED',
            'REVIEW_PHASE_STARTED',
            'REVIEWER_DELEGATION_ROUTED',
            'REVIEWER_LAUNCH_PREPARED',
            'REVIEWER_DELEGATION_STARTED',
            'REVIEWER_INVOCATION_ATTESTED',
            'REVIEW_RECORDED',
            'REVIEW_GATE_PASSED',
            'DOC_IMPACT_ASSESSED',
            'PROJECT_MEMORY_IMPACT_ASSESSED',
            'COMPLETION_GATE_PASSED'
        ];
        let cursor = -1;
        for (const eventType of expectedOrder) {
            const index = eventTypes.indexOf(eventType, cursor + 1);
            assert.notEqual(index, -1, `Missing event '${eventType}' after index ${cursor}. Events: ${eventTypes.join(', ')}`);
            cursor = index;
        }

        runGit(workspaceRoot, ['status', '--short']);
    } finally {
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
});
