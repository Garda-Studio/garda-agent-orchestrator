import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { getSetupAnswerDefaults } from '../../../src/cli/commands/setup';
import { buildAgentInitNextStep, buildAgentInitOutput } from '../../../src/cli/commands/agent-init';
import { runAgentInit } from '../../../src/lifecycle/agent-init';
import { getStatusSnapshot } from '../../../src/validators/status';
import { resolveInitAnswersRelativePath } from '../../../src/core/constants';
import { PROJECT_MEMORY_REQUIRED_FILE_NAMES } from '../../../src/core/project-memory';
import { buildDefaultWorkflowConfig } from '../../../src/core/workflow-config';

const INIT_ANSWERS_RELATIVE_PATH = resolveInitAnswersRelativePath();
const TEST_COMPILE_GATE_COMMAND = 'node -e "console.log(\'build ok\')"';

const MANAGED_START = '<!-- garda-agent-orchestrator:managed-start -->';
const MANAGED_END = '<!-- garda-agent-orchestrator:managed-end -->';

function writeJson(filePath: string, value: unknown) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

function writeText(filePath: string, value: string) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, value, 'utf8');
}

function readWorkflowConfig(bundleRoot: string): Record<string, unknown> {
    return JSON.parse(
        fs.readFileSync(path.join(bundleRoot, 'live', 'config', 'workflow-config.json'), 'utf8')
    ) as Record<string, unknown>;
}

function writeConfiguredWorkflowConfig(bundleRoot: string): void {
    const workflowConfig = buildDefaultWorkflowConfig();
    workflowConfig.compile_gate.command = TEST_COMPILE_GATE_COMMAND;
    writeJson(path.join(bundleRoot, 'live', 'config', 'workflow-config.json'), workflowConfig);
}

function seedProjectMemoryTemplates(bundleRoot: string) {
    for (const fileName of PROJECT_MEMORY_REQUIRED_FILE_NAMES) {
        writeText(
            path.join(bundleRoot, 'template', 'docs', 'project-memory', fileName),
            `# ${fileName}\n\n<!-- Fill with real project memory. -->\n`
        );
    }
}

function seedReadyProjectMemory(bundleRoot: string) {
    seedProjectMemoryTemplates(bundleRoot);
    for (const fileName of PROJECT_MEMORY_REQUIRED_FILE_NAMES) {
        writeText(
            path.join(bundleRoot, 'live', 'docs', 'project-memory', fileName),
            [
                `# ${fileName}`,
                '',
                '## Repository Facts',
                `Repository-specific project memory fixture for ${fileName}.`,
                'This file is intentionally different from the project-memory template seed.'
            ].join('\n')
        );
    }
}

function seedSourceCheckoutMarkers(workspaceRoot: string) {
    writeJson(path.join(workspaceRoot, 'package.json'), {
        name: 'garda-agent-orchestrator-source-fixture',
        version: '0.0.0'
    });
    writeText(path.join(workspaceRoot, 'bin', 'garda.js'), '#!/usr/bin/env node\n');
    writeText(path.join(workspaceRoot, 'src', 'index.ts'), 'export {};\n');
}

function makeCompliantEntrypoint(name: string): string {
    return [
        MANAGED_START,
        `# ${name}`,
        'This file is a redirect.',
        'Hard stop: open `.agents/workflows/start-task.md`.',
        MANAGED_END
    ].join('\n');
}

function makeActiveQueueTaskMd(rows: readonly string[]): string {
    return [
        '# TASK.md',
        '',
        '## Active Queue',
        '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
        '|---|---|---|---|---|---|---|---|---|',
        ...rows,
        ''
    ].join('\n');
}

test('runAgentInit writes finalized init answers and agent-init state', () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-agent-init-'));
    const bundleRoot = path.join(workspaceRoot, 'garda-agent-orchestrator');
    const initAnswersPath = path.join(bundleRoot, 'runtime', 'init-answers.json');

    try {
        writeJson(initAnswersPath, {
            AssistantLanguage: 'English',
            AssistantBrevity: 'concise',
            SourceOfTruth: 'Codex',
            EnforceNoAutoCommit: 'false',
            ClaudeOrchestratorFullAccess: 'false',
            TokenEconomyEnabled: 'true',
            CollectedVia: 'CLI_INTERACTIVE',
            ActiveAgentFiles: 'AGENTS.md'
        });
        fs.writeFileSync(path.join(bundleRoot, 'VERSION'), '9.9.9-test\n', 'utf8');
        fs.writeFileSync(path.join(bundleRoot, 'MANIFEST.md'), '# Manifest\n', 'utf8');
        writeJson(path.join(bundleRoot, 'live', 'config', 'profiles.json'), {
            version: 1,
            active_profile: 'balanced',
            built_in_profiles: {
                balanced: {
                    description: 'Balanced profile',
                    depth: 2,
                    review_policy: {},
                    token_economy: {
                        enabled: true,
                        strip_examples: true,
                        strip_code_blocks: false,
                        scoped_diffs: true,
                        compact_reviewer_output: true
                    },
                    skills: {}
                }
            },
            user_profiles: {}
        });
        seedReadyProjectMemory(bundleRoot);

        const result = runAgentInit({
            targetRoot: workspaceRoot,
            activeAgentFiles: 'AGENTS.md, CLAUDE.md',
            projectRulesUpdated: 'yes',
            skillsPrompted: 'yes',
            ordinaryDocPaths: 'CHANGELOG.md',
            installRunner: function () {},
            verifyRunner: function () {
                return { passed: true };
            },
            manifestRunner: function () {
                return { passed: true };
            }
        });

        assert.equal(result.readyForTasks, true);
        assert.deepEqual(result.activeAgentFiles, ['CLAUDE.md', 'AGENTS.md']);

        const persistedAnswers = JSON.parse(fs.readFileSync(initAnswersPath, 'utf8'));
        assert.equal(persistedAnswers.CollectedVia, 'AGENT_INIT_PROMPT.md');
        assert.equal(persistedAnswers.ActiveAgentFiles, 'CLAUDE.md, AGENTS.md');

        const persistedState = JSON.parse(fs.readFileSync(result.agentInitStatePath, 'utf8'));
        assert.equal(persistedState.OrchestratorVersion, '9.9.9-test');
        assert.equal(persistedState.SourceOfTruth, 'Codex');
        assert.equal(persistedState.AssistantLanguageConfirmed, true);
        assert.equal(persistedState.ActiveAgentFilesConfirmed, true);
        assert.equal(persistedState.ProjectRulesUpdated, true);
        assert.equal(persistedState.SkillsPromptCompleted, true);
        assert.equal(persistedState.OrdinaryDocPathsConfirmed, true);
        assert.deepEqual(persistedState.OrdinaryDocPaths, ['CHANGELOG.md']);
        assert.equal(persistedState.VerificationPassed, true);
        assert.equal(persistedState.ManifestValidationPassed, true);
        assert.deepEqual(persistedState.ActiveAgentFiles, ['CLAUDE.md', 'AGENTS.md']);

        const nextStepLine = buildAgentInitNextStep(result);
        assert.ok(nextStepLine.includes('node garda-agent-orchestrator/bin/garda.js profile current|list|use|create --target-root "."'));
        assert.ok(!nextStepLine.includes('node bin/garda.js profile current|list|use|create --target-root "."'));

        const output = buildAgentInitOutput(result);
        assert.ok(output.includes('RecommendedUiCommand: garda ui --actions'));
        assert.ok(output.includes('guarded allow-listed settings before or alongside choosing the first task'));
    } finally {
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
});

test('buildAgentInitNextStep does not default to T-001 when active queue has no executable tasks', () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-agent-init-no-task-'));
    const bundleRoot = path.join(workspaceRoot, 'garda-agent-orchestrator');
    const initAnswersPath = path.join(bundleRoot, 'runtime', 'init-answers.json');

    try {
        writeText(
            path.join(workspaceRoot, 'TASK.md'),
            makeActiveQueueTaskMd([
                '| T-711 | 🟩 DONE | P2 | workflow | Done task | codex | 2026-06-05 | strict | done |',
                '| T-708 | 🟪 DECOMPOSED | P2 | refactor | Parent task | codex | 2026-06-05 | strict | use children |'
            ])
        );
        writeJson(initAnswersPath, {
            AssistantLanguage: 'English',
            AssistantBrevity: 'concise',
            SourceOfTruth: 'Codex',
            EnforceNoAutoCommit: 'false',
            ClaudeOrchestratorFullAccess: 'false',
            TokenEconomyEnabled: 'true',
            CollectedVia: 'CLI_INTERACTIVE',
            ActiveAgentFiles: 'AGENTS.md'
        });
        writeText(path.join(bundleRoot, 'VERSION'), '9.9.9-test\n');
        writeText(path.join(bundleRoot, 'MANIFEST.md'), '# Manifest\n');
        seedReadyProjectMemory(bundleRoot);

        const result = runAgentInit({
            targetRoot: workspaceRoot,
            activeAgentFiles: 'AGENTS.md',
            projectRulesUpdated: 'yes',
            skillsPrompted: 'yes',
            ordinaryDocPaths: 'CHANGELOG.md',
            installRunner: function () {},
            verifyRunner: function () {
                return { passed: true };
            },
            manifestRunner: function () {
                return { passed: true };
            }
        });

        const nextStepLine = buildAgentInitNextStep(result);
        assert.ok(nextStepLine.includes('Next: No executable tasks found in TASK.md Active Queue; add or reopen a task before starting task execution.'));
        assert.ok(!nextStepLine.includes('Execute task T-001'));
    } finally {
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
});

test('runAgentInit bootstraps project memory and records validation status', () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-agent-init-pm-'));
    const bundleRoot = path.join(workspaceRoot, 'garda-agent-orchestrator');
    const initAnswersPath = path.join(bundleRoot, 'runtime', 'init-answers.json');

    try {
        writeJson(initAnswersPath, {
            AssistantLanguage: 'English',
            AssistantBrevity: 'concise',
            SourceOfTruth: 'Codex',
            EnforceNoAutoCommit: 'false',
            ClaudeOrchestratorFullAccess: 'false',
            TokenEconomyEnabled: 'true',
            CollectedVia: 'CLI_INTERACTIVE',
            ActiveAgentFiles: 'AGENTS.md'
        });
        writeText(path.join(bundleRoot, 'VERSION'), '9.9.9-test\n');
        writeText(path.join(bundleRoot, 'MANIFEST.md'), '# Manifest\n');
        seedProjectMemoryTemplates(bundleRoot);

        const result = runAgentInit({
            targetRoot: workspaceRoot,
            activeAgentFiles: 'AGENTS.md',
            projectRulesUpdated: 'yes',
            skillsPrompted: 'yes',
            ordinaryDocPaths: 'CHANGELOG.md',
            installRunner: function () {},
            verifyRunner: function () {
                return { passed: true };
            },
            manifestRunner: function () {
                return { passed: true };
            }
        });

        assert.equal(result.projectMemoryInitialized, true);
        assert.equal(result.projectMemoryValidated, false);
        assert.equal(result.readyForTasks, false);
        assert.equal(result.projectMemoryMode, 'strict');
        assert.deepEqual(result.projectMemoryReadFirst, [
            'live/docs/project-memory/README.md',
            'live/docs/project-memory/compact.md'
        ]);
        assert.ok(result.projectMemoryWarnings.some((warning) => warning.includes('not project-specific')));
        assert.ok(fs.existsSync(path.join(bundleRoot, 'live', 'docs', 'project-memory', 'README.md')));
        assert.ok(fs.existsSync(path.join(bundleRoot, 'live', 'docs', 'project-memory', 'compact.md')));
        assert.ok(fs.existsSync(path.join(bundleRoot, 'live', 'docs', 'agent-rules', '15-project-memory.md')));
        const reportPath = path.join(bundleRoot, 'runtime', 'project-memory', 'bootstrap-report.json');
        assert.ok(fs.existsSync(reportPath));
        const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
        assert.equal(report.validation.passed, false);
        assert.equal(report.validation.mode, 'strict');

        const persistedState = JSON.parse(fs.readFileSync(result.agentInitStatePath, 'utf8'));
        assert.equal(persistedState.ProjectMemoryInitialized, true);
        assert.equal(persistedState.ProjectMemoryValidated, false);
        assert.equal(persistedState.ProjectMemoryMode, 'strict');
        assert.deepEqual(persistedState.ProjectMemoryReadFirst, result.projectMemoryReadFirst);
        assert.equal(persistedState.ProjectMemorySummaryRule, 'live/docs/agent-rules/15-project-memory.md');
        assert.equal(persistedState.ProjectMemoryBootstrapReport, 'runtime/project-memory/bootstrap-report.json');
    } finally {
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
});

test('runAgentInit does not declare ready when project memory bootstrap is incomplete', () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-agent-init-pm-missing-'));
    const bundleRoot = path.join(workspaceRoot, 'garda-agent-orchestrator');
    const initAnswersPath = path.join(bundleRoot, 'runtime', 'init-answers.json');

    try {
        writeJson(initAnswersPath, {
            AssistantLanguage: 'English',
            AssistantBrevity: 'concise',
            SourceOfTruth: 'Codex',
            EnforceNoAutoCommit: 'false',
            ClaudeOrchestratorFullAccess: 'false',
            TokenEconomyEnabled: 'true',
            CollectedVia: 'CLI_INTERACTIVE',
            ActiveAgentFiles: 'AGENTS.md'
        });
        writeText(path.join(bundleRoot, 'VERSION'), '9.9.9-test\n');
        writeText(path.join(bundleRoot, 'MANIFEST.md'), '# Manifest\n');

        const result = runAgentInit({
            targetRoot: workspaceRoot,
            activeAgentFiles: 'AGENTS.md',
            projectRulesUpdated: 'yes',
            skillsPrompted: 'yes',
            ordinaryDocPaths: 'CHANGELOG.md',
            installRunner: function () {},
            verifyRunner: function () {
                return { passed: true };
            },
            manifestRunner: function () {
                return { passed: true };
            }
        });

        assert.equal(result.projectMemoryInitialized, false);
        assert.equal(result.projectMemoryValidated, false);
        assert.equal(result.readyForTasks, false);
        const output = buildAgentInitOutput(result);
        assert.match(output, /ProjectMemoryWarning: Project memory template files are missing/);
        assert.match(output, /project memory bootstrap is incomplete/);
    } finally {
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
});

test('runAgentInit preserves existing project memory and recreates missing compact summary', () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-agent-init-pm-preserve-'));
    const bundleRoot = path.join(workspaceRoot, 'garda-agent-orchestrator');
    const initAnswersPath = path.join(bundleRoot, 'runtime', 'init-answers.json');
    const projectMemoryDir = path.join(bundleRoot, 'live', 'docs', 'project-memory');

    try {
        writeJson(initAnswersPath, {
            AssistantLanguage: 'English',
            AssistantBrevity: 'concise',
            SourceOfTruth: 'Codex',
            EnforceNoAutoCommit: 'false',
            ClaudeOrchestratorFullAccess: 'false',
            TokenEconomyEnabled: 'true',
            CollectedVia: 'CLI_INTERACTIVE',
            ActiveAgentFiles: 'AGENTS.md'
        });
        writeText(path.join(bundleRoot, 'VERSION'), '9.9.9-test\n');
        writeText(path.join(bundleRoot, 'MANIFEST.md'), '# Manifest\n');
        seedReadyProjectMemory(bundleRoot);
        writeText(path.join(projectMemoryDir, 'context.md'), '# Context\n\n## Domain\n\nPreserve this project fact.\n');

        const result = runAgentInit({
            targetRoot: workspaceRoot,
            activeAgentFiles: 'AGENTS.md',
            projectRulesUpdated: 'yes',
            skillsPrompted: 'yes',
            ordinaryDocPaths: 'CHANGELOG.md',
            installRunner: function () {},
            verifyRunner: function () {
                return { passed: true };
            },
            manifestRunner: function () {
                return { passed: true };
            }
        });

        assert.ok(result.projectMemoryInitialized);
        assert.equal(
            fs.readFileSync(path.join(projectMemoryDir, 'context.md'), 'utf8'),
            '# Context\n\n## Domain\n\nPreserve this project fact.\n'
        );
        assert.ok(fs.existsSync(path.join(projectMemoryDir, 'compact.md')));
        const summary = fs.readFileSync(
            path.join(bundleRoot, 'live', 'docs', 'agent-rules', '15-project-memory.md'),
            'utf8'
        );
        assert.ok(summary.includes('Preserve this project fact.'));
    } finally {
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
});

test('buildAgentInitOutput includes project memory paths and actionable warnings', () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-agent-init-pm-output-'));
    const bundleRoot = path.join(workspaceRoot, 'garda-agent-orchestrator');
    const initAnswersPath = path.join(bundleRoot, 'runtime', 'init-answers.json');

    try {
        writeJson(initAnswersPath, {
            AssistantLanguage: 'English',
            AssistantBrevity: 'concise',
            SourceOfTruth: 'Codex',
            EnforceNoAutoCommit: 'false',
            ClaudeOrchestratorFullAccess: 'false',
            TokenEconomyEnabled: 'true',
            CollectedVia: 'CLI_INTERACTIVE',
            ActiveAgentFiles: 'AGENTS.md'
        });
        writeText(path.join(bundleRoot, 'VERSION'), '9.9.9-test\n');
        writeText(path.join(bundleRoot, 'MANIFEST.md'), '# Manifest\n');
        seedProjectMemoryTemplates(bundleRoot);

        const result = runAgentInit({
            targetRoot: workspaceRoot,
            activeAgentFiles: 'AGENTS.md',
            projectRulesUpdated: 'yes',
            skillsPrompted: 'yes',
            ordinaryDocPaths: 'CHANGELOG.md',
            installRunner: function () {},
            verifyRunner: function () {
                return { passed: true };
            },
            manifestRunner: function () {
                return { passed: true };
            }
        });
        const output = buildAgentInitOutput(result);

        assert.match(output, /ProjectMemory: initialized=true; validated=false; mode=strict/);
        assert.match(output, /ProjectMemoryReadFirst:/);
        assert.match(output, /live\/docs\/project-memory\/README\.md/);
        assert.match(output, /ProjectMemorySummary: live\/docs\/agent-rules\/15-project-memory\.md/);
        assert.match(output, /ProjectMemoryBootstrapReport: runtime\/project-memory\/bootstrap-report\.json/);
        assert.match(output, /ProjectMemoryWarning: .*not project-specific/);
    } finally {
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
});

test('runAgentInit persists confirmed ordinary doc paths and reports edit guidance', () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-agent-init-ordinary-docs-'));
    const bundleRoot = path.join(workspaceRoot, 'garda-agent-orchestrator');
    const initAnswersPath = path.join(bundleRoot, 'runtime', 'init-answers.json');

    try {
        writeJson(initAnswersPath, {
            AssistantLanguage: 'English',
            AssistantBrevity: 'concise',
            SourceOfTruth: 'Codex',
            EnforceNoAutoCommit: 'false',
            ClaudeOrchestratorFullAccess: 'false',
            TokenEconomyEnabled: 'true',
            CollectedVia: 'CLI_INTERACTIVE',
            ActiveAgentFiles: 'AGENTS.md'
        });
        writeText(path.join(bundleRoot, 'VERSION'), '9.9.9-test\n');
        writeText(path.join(bundleRoot, 'MANIFEST.md'), '# Manifest\n');
        seedReadyProjectMemory(bundleRoot);
        writeText(path.join(workspaceRoot, 'docs', 'plan.md'), '# Plan\n');

        const result = runAgentInit({
            targetRoot: workspaceRoot,
            activeAgentFiles: 'AGENTS.md',
            projectRulesUpdated: 'yes',
            skillsPrompted: 'yes',
            ordinaryDocPaths: 'CHANGELOG.md, docs/plan.md',
            installRunner: function () {},
            verifyRunner: function () {
                return { passed: true };
            },
            manifestRunner: function () {
                return { passed: true };
            }
        });

        assert.equal(result.ordinaryDocPathsConfirmed, true);
        assert.deepEqual(result.ordinaryDocPaths, ['CHANGELOG.md', 'docs/plan.md']);
        assert.deepEqual(result.ordinaryDocPathsDiscovered, ['CHANGELOG.md', 'docs/plan.md']);
        assert.ok(result.ordinaryDocPathsEditHint.includes('ordinary_doc_paths'));
        const pathsConfig = JSON.parse(
            fs.readFileSync(path.join(bundleRoot, 'live', 'config', 'paths.json'), 'utf8')
        );
        assert.deepEqual(pathsConfig.ordinary_doc_paths, ['CHANGELOG.md', 'docs/plan.md']);
        const persistedState = JSON.parse(fs.readFileSync(result.agentInitStatePath, 'utf8'));
        assert.equal(persistedState.OrdinaryDocPathsConfirmed, true);
        assert.deepEqual(persistedState.OrdinaryDocPaths, ['CHANGELOG.md', 'docs/plan.md']);
    } finally {
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
});

test('runAgentInit requires ordinary doc path confirmation before seeding a missing config key', () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-agent-init-ordinary-docs-missing-'));
    const bundleRoot = path.join(workspaceRoot, 'garda-agent-orchestrator');
    const initAnswersPath = path.join(bundleRoot, 'runtime', 'init-answers.json');
    const pathsConfigPath = path.join(bundleRoot, 'live', 'config', 'paths.json');

    try {
        writeJson(initAnswersPath, {
            AssistantLanguage: 'English',
            AssistantBrevity: 'concise',
            SourceOfTruth: 'Codex',
            EnforceNoAutoCommit: 'false',
            ClaudeOrchestratorFullAccess: 'false',
            TokenEconomyEnabled: 'true',
            CollectedVia: 'CLI_INTERACTIVE',
            ActiveAgentFiles: 'AGENTS.md'
        });
        writeText(path.join(bundleRoot, 'VERSION'), '9.9.9-test\n');
        writeText(path.join(bundleRoot, 'MANIFEST.md'), '# Manifest\n');
        seedReadyProjectMemory(bundleRoot);
        writeJson(pathsConfigPath, {
            metrics_path: 'garda-agent-orchestrator/runtime/metrics.jsonl',
            runtime_roots: ['src/'],
            fast_path_roots: ['src/'],
            triggers: { test: ['(^|/)tests?/'] }
        });

        const result = runAgentInit({
            targetRoot: workspaceRoot,
            activeAgentFiles: 'AGENTS.md',
            projectRulesUpdated: 'yes',
            skillsPrompted: 'yes',
            installRunner: function () {},
            verifyRunner: function () {
                return { passed: true };
            },
            manifestRunner: function () {
                return { passed: true };
            }
        });

        assert.equal(result.readyForTasks, false);
        assert.equal(result.ordinaryDocPathsConfirmed, false);
        assert.equal(result.ordinaryDocPathsNeedsConfirmation, true);
        assert.equal(result.ordinaryDocPathsPersisted, false);
        const pathsConfig = JSON.parse(fs.readFileSync(pathsConfigPath, 'utf8'));
        assert.equal(Object.prototype.hasOwnProperty.call(pathsConfig, 'ordinary_doc_paths'), false);
        const persistedState = JSON.parse(fs.readFileSync(result.agentInitStatePath, 'utf8'));
        assert.equal(persistedState.OrdinaryDocPathsConfirmed, false);
        assert.deepEqual(persistedState.OrdinaryDocPaths, []);
    } finally {
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
});

test('runAgentInit requires ordinary doc path confirmation even when config key already exists', () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-agent-init-ordinary-docs-configured-'));
    const bundleRoot = path.join(workspaceRoot, 'garda-agent-orchestrator');
    const initAnswersPath = path.join(bundleRoot, 'runtime', 'init-answers.json');
    const pathsConfigPath = path.join(bundleRoot, 'live', 'config', 'paths.json');

    try {
        writeJson(initAnswersPath, {
            AssistantLanguage: 'English',
            AssistantBrevity: 'concise',
            SourceOfTruth: 'Codex',
            EnforceNoAutoCommit: 'false',
            ClaudeOrchestratorFullAccess: 'false',
            TokenEconomyEnabled: 'true',
            CollectedVia: 'CLI_INTERACTIVE',
            ActiveAgentFiles: 'AGENTS.md'
        });
        writeText(path.join(bundleRoot, 'VERSION'), '9.9.9-test\n');
        writeText(path.join(bundleRoot, 'MANIFEST.md'), '# Manifest\n');
        seedReadyProjectMemory(bundleRoot);
        writeJson(pathsConfigPath, {
            metrics_path: 'garda-agent-orchestrator/runtime/metrics.jsonl',
            ordinary_doc_paths: ['CHANGELOG.md'],
            runtime_roots: ['src/'],
            fast_path_roots: ['src/'],
            triggers: { test: ['(^|/)tests?/'] }
        });

        const result = runAgentInit({
            targetRoot: workspaceRoot,
            activeAgentFiles: 'AGENTS.md',
            projectRulesUpdated: 'yes',
            skillsPrompted: 'yes',
            installRunner: function () {},
            verifyRunner: function () {
                return { passed: true };
            },
            manifestRunner: function () {
                return { passed: true };
            }
        });

        assert.equal(result.readyForTasks, false);
        assert.equal(result.ordinaryDocPathsConfirmed, false);
        assert.equal(result.ordinaryDocPathsNeedsConfirmation, true);
        assert.equal(result.ordinaryDocPathsPersisted, false);
        assert.deepEqual(result.ordinaryDocPaths, ['CHANGELOG.md']);
        const pathsConfig = JSON.parse(fs.readFileSync(pathsConfigPath, 'utf8'));
        assert.deepEqual(pathsConfig.ordinary_doc_paths, ['CHANGELOG.md']);
        const persistedState = JSON.parse(fs.readFileSync(result.agentInitStatePath, 'utf8'));
        assert.equal(persistedState.OrdinaryDocPathsConfirmed, false);
        assert.deepEqual(persistedState.OrdinaryDocPaths, []);
    } finally {
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
});

test('runAgentInit preserves an explicit empty ordinary doc path list', () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-agent-init-ordinary-docs-empty-'));
    const bundleRoot = path.join(workspaceRoot, 'garda-agent-orchestrator');
    const initAnswersPath = path.join(bundleRoot, 'runtime', 'init-answers.json');
    const pathsConfigPath = path.join(bundleRoot, 'live', 'config', 'paths.json');

    try {
        writeJson(initAnswersPath, {
            AssistantLanguage: 'English',
            AssistantBrevity: 'concise',
            SourceOfTruth: 'Codex',
            EnforceNoAutoCommit: 'false',
            ClaudeOrchestratorFullAccess: 'false',
            TokenEconomyEnabled: 'true',
            CollectedVia: 'CLI_INTERACTIVE',
            ActiveAgentFiles: 'AGENTS.md'
        });
        writeText(path.join(bundleRoot, 'VERSION'), '9.9.9-test\n');
        writeText(path.join(bundleRoot, 'MANIFEST.md'), '# Manifest\n');
        seedReadyProjectMemory(bundleRoot);
        writeJson(pathsConfigPath, {
            ordinary_doc_paths: [],
            metrics_path: 'garda-agent-orchestrator/runtime/metrics.jsonl',
            runtime_roots: ['src/'],
            fast_path_roots: ['src/'],
            triggers: { test: ['(^|/)tests?/'] }
        });

        const result = runAgentInit({
            targetRoot: workspaceRoot,
            activeAgentFiles: 'AGENTS.md',
            projectRulesUpdated: 'yes',
            skillsPrompted: 'yes',
            ordinaryDocPaths: '',
            installRunner: function () {},
            verifyRunner: function () {
                return { passed: true };
            },
            manifestRunner: function () {
                return { passed: true };
            }
        });

        assert.equal(result.readyForTasks, true);
        assert.equal(result.ordinaryDocPathsConfirmed, true);
        assert.equal(result.ordinaryDocPathsNeedsConfirmation, false);
        assert.deepEqual(result.ordinaryDocPaths, []);
        const pathsConfig = JSON.parse(fs.readFileSync(pathsConfigPath, 'utf8'));
        assert.deepEqual(pathsConfig.ordinary_doc_paths, []);
        const persistedState = JSON.parse(fs.readFileSync(result.agentInitStatePath, 'utf8'));
        assert.equal(persistedState.OrdinaryDocPathsConfirmed, true);
        assert.deepEqual(persistedState.OrdinaryDocPaths, []);
    } finally {
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
});

test('runAgentInit rejects invalid confirmed ordinary doc paths before persistence', () => {
    const invalidCases = [
        { value: '/tmp/notes.md', expectedMessage: /relative repository path/ },
        { value: 'C:/tmp/notes.md', expectedMessage: /relative repository path/ },
        { value: '../plan.md', expectedMessage: /must not contain '\.\.' path segments/ },
        { value: '**/*.md', expectedMessage: /repository-wide wildcard/ }
    ];

    for (const invalidCase of invalidCases) {
        const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-agent-init-ordinary-docs-invalid-'));
        const bundleRoot = path.join(workspaceRoot, 'garda-agent-orchestrator');
        const initAnswersPath = path.join(bundleRoot, 'runtime', 'init-answers.json');
        const pathsConfigPath = path.join(bundleRoot, 'live', 'config', 'paths.json');

        try {
            writeJson(initAnswersPath, {
                AssistantLanguage: 'English',
                AssistantBrevity: 'concise',
                SourceOfTruth: 'Codex',
                EnforceNoAutoCommit: 'false',
                ClaudeOrchestratorFullAccess: 'false',
                TokenEconomyEnabled: 'true',
                CollectedVia: 'CLI_INTERACTIVE',
                ActiveAgentFiles: 'AGENTS.md'
            });
            writeText(path.join(bundleRoot, 'VERSION'), '9.9.9-test\n');
            writeText(path.join(bundleRoot, 'MANIFEST.md'), '# Manifest\n');
            seedReadyProjectMemory(bundleRoot);
            writeJson(pathsConfigPath, {
                ordinary_doc_paths: ['CHANGELOG.md'],
                metrics_path: 'garda-agent-orchestrator/runtime/metrics.jsonl',
                runtime_roots: ['src/'],
                fast_path_roots: ['src/'],
                triggers: { test: ['(^|/)tests?/'] }
            });

            assert.throws(() => runAgentInit({
                targetRoot: workspaceRoot,
                activeAgentFiles: 'AGENTS.md',
                projectRulesUpdated: 'yes',
                skillsPrompted: 'yes',
                ordinaryDocPaths: invalidCase.value,
                installRunner: function () {},
                verifyRunner: function () {
                    return { passed: true };
                },
                manifestRunner: function () {
                    return { passed: true };
                }
            }), invalidCase.expectedMessage);

            const pathsConfig = JSON.parse(fs.readFileSync(pathsConfigPath, 'utf8'));
            assert.deepEqual(pathsConfig.ordinary_doc_paths, ['CHANGELOG.md']);
            assert.equal(fs.existsSync(path.join(bundleRoot, 'runtime', 'agent-init-state.json')), false);
        } finally {
            fs.rmSync(workspaceRoot, { recursive: true, force: true });
        }
    }
});

test('setup/status/agent-init handoff keeps ActiveAgentFiles as a single pending checkpoint until one explicit confirmation clears it', () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-agent-init-handoff-'));
    const bundleRoot = path.join(workspaceRoot, 'garda-agent-orchestrator');
    const runtimeRoot = path.join(bundleRoot, 'runtime');
    const defaults = getSetupAnswerDefaults(workspaceRoot, INIT_ANSWERS_RELATIVE_PATH, {
        sourceOfTruth: 'Codex'
    });

    try {
        assert.equal(defaults.activeAgentFiles, 'AGENTS.md');

        writeJson(path.join(runtimeRoot, 'init-answers.json'), {
            AssistantLanguage: defaults.assistantLanguage,
            AssistantBrevity: defaults.assistantBrevity,
            SourceOfTruth: defaults.sourceOfTruth,
            EnforceNoAutoCommit: String(defaults.enforceNoAutoCommit),
            ClaudeOrchestratorFullAccess: String(defaults.claudeOrchestratorFullAccess),
            TokenEconomyEnabled: String(defaults.tokenEconomyEnabled),
            CollectedVia: 'CLI_NONINTERACTIVE',
            ActiveAgentFiles: defaults.activeAgentFiles
        });
        writeJson(path.join(runtimeRoot, 'agent-init-state.json'), {
            Version: 1,
            UpdatedAt: new Date().toISOString(),
            OrchestratorVersion: '9.9.9-test',
            AssistantLanguage: 'English',
            SourceOfTruth: 'Codex',
            AssistantLanguageConfirmed: true,
            ActiveAgentFilesConfirmed: false,
            ProjectRulesUpdated: false,
            SkillsPromptCompleted: false,
            VerificationPassed: false,
            ManifestValidationPassed: false,
            ActiveAgentFiles: ['AGENTS.md']
        });

        writeText(path.join(bundleRoot, 'VERSION'), '9.9.9-test\n');
        writeText(path.join(bundleRoot, 'MANIFEST.md'), '# Manifest\n');
        seedReadyProjectMemory(bundleRoot);
        writeText(path.join(bundleRoot, 'package.json'), JSON.stringify({ name: 'garda-agent-orchestrator' }, null, 2));
        writeText(path.join(bundleRoot, 'live', 'USAGE.md'), '# Usage\n');
        writeText(path.join(bundleRoot, 'live', 'docs', 'agent-rules', '40-commands.md'), 'npm install\nnpm test\nnpm run lint\n');
        writeConfiguredWorkflowConfig(bundleRoot);
        writeText(path.join(workspaceRoot, 'TASK.md'), '# Tasks\n');
        writeText(path.join(workspaceRoot, '.agents', 'workflows', 'start-task.md'), [MANAGED_START, '# Start Task', 'Shared router.', MANAGED_END].join('\n'));
        writeText(path.join(workspaceRoot, 'AGENTS.md'), makeCompliantEntrypoint('AGENTS.md'));
        writeText(path.join(workspaceRoot, 'CLAUDE.md'), makeCompliantEntrypoint('CLAUDE.md'));

        const pendingSnapshot = getStatusSnapshot(workspaceRoot);
        assert.equal(pendingSnapshot.agentInitializationPendingReason, 'ACTIVE_AGENT_FILES_PENDING');
        assert.equal(pendingSnapshot.activeAgentFiles, 'AGENTS.md');

        const result = runAgentInit({
            targetRoot: workspaceRoot,
            activeAgentFiles: 'AGENTS.md, CLAUDE.md',
            projectRulesUpdated: 'yes',
            skillsPrompted: 'yes',
            ordinaryDocPaths: 'CHANGELOG.md',
            installRunner: function () {},
            verifyRunner: function () {
                return { passed: true };
            },
            manifestRunner: function () {
                return { passed: true };
            }
        });

        assert.equal(result.readyForTasks, true);

        const readySnapshot = getStatusSnapshot(workspaceRoot);
        assert.equal(readySnapshot.agentInitializationPendingReason, null);
        assert.equal(readySnapshot.readyForTasks, true);
        assert.equal(readySnapshot.activeAgentFiles, 'CLAUDE.md, AGENTS.md');
    } finally {
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
});

test('runAgentInit keeps workspace not-ready when required checkpoints are marked as incomplete', () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-agent-init-'));
    const bundleRoot = path.join(workspaceRoot, 'garda-agent-orchestrator');
    const initAnswersPath = path.join(bundleRoot, 'runtime', 'init-answers.json');

    try {
        writeJson(initAnswersPath, {
            AssistantLanguage: 'English',
            AssistantBrevity: 'concise',
            SourceOfTruth: 'Codex',
            EnforceNoAutoCommit: 'false',
            ClaudeOrchestratorFullAccess: 'false',
            TokenEconomyEnabled: 'true',
            CollectedVia: 'CLI_NONINTERACTIVE',
            ActiveAgentFiles: 'AGENTS.md'
        });
        fs.writeFileSync(path.join(bundleRoot, 'MANIFEST.md'), '# Manifest\n', 'utf8');
        seedReadyProjectMemory(bundleRoot);

        const result = runAgentInit({
            targetRoot: workspaceRoot,
            activeAgentFiles: 'AGENTS.md',
            projectRulesUpdated: 'no',
            skillsPrompted: 'yes',
            ordinaryDocPaths: 'CHANGELOG.md',
            installRunner: function () {},
            verifyRunner: function () {
                return { passed: true };
            },
            manifestRunner: function () {
                return { passed: true };
            }
        });

        assert.equal(result.readyForTasks, false);
        assert.equal(result.projectRulesUpdated, false);
    } finally {
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
});

test('runAgentInit treats negative skills-prompted values as incomplete prompts, not as user decline', () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-agent-init-skills-pending-'));
    const bundleRoot = path.join(workspaceRoot, 'garda-agent-orchestrator');
    const initAnswersPath = path.join(bundleRoot, 'runtime', 'init-answers.json');

    try {
        writeJson(initAnswersPath, {
            AssistantLanguage: 'English',
            AssistantBrevity: 'concise',
            SourceOfTruth: 'Codex',
            EnforceNoAutoCommit: 'false',
            ClaudeOrchestratorFullAccess: 'false',
            TokenEconomyEnabled: 'true',
            CollectedVia: 'CLI_NONINTERACTIVE',
            ActiveAgentFiles: 'AGENTS.md'
        });
        writeText(path.join(bundleRoot, 'VERSION'), '9.9.9-test\n');
        writeText(path.join(bundleRoot, 'MANIFEST.md'), '# Manifest\n');
        seedReadyProjectMemory(bundleRoot);

        for (const skillsPrompted of ['false', 'no']) {
            const result = runAgentInit({
                targetRoot: workspaceRoot,
                activeAgentFiles: 'AGENTS.md',
                projectRulesUpdated: 'yes',
                skillsPrompted,
                ordinaryDocPaths: 'CHANGELOG.md',
                installRunner: function () {},
                verifyRunner: function () {
                    return { passed: true };
                },
                manifestRunner: function () {
                    return { passed: true };
                }
            });

            assert.equal(result.readyForTasks, false);
            assert.equal(result.skillsPromptCompleted, false);
            assert.match(buildAgentInitNextStep(result), /allow a no answer, then rerun with --skills-prompted yes/);

            const persistedState = JSON.parse(fs.readFileSync(result.agentInitStatePath, 'utf8'));
            assert.equal(persistedState.SkillsPromptCompleted, false);
        }
    } finally {
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
});

test('runAgentInit seeds workflow-config full-suite command from project stack while keeping the mode disabled', () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-agent-init-seed-'));
    const bundleRoot = path.join(workspaceRoot, 'garda-agent-orchestrator');
    const initAnswersPath = path.join(bundleRoot, 'runtime', 'init-answers.json');

    try {
        writeJson(initAnswersPath, {
            AssistantLanguage: 'English',
            AssistantBrevity: 'concise',
            SourceOfTruth: 'Codex',
            EnforceNoAutoCommit: 'false',
            ClaudeOrchestratorFullAccess: 'false',
            TokenEconomyEnabled: 'true',
            CollectedVia: 'CLI_NONINTERACTIVE',
            ActiveAgentFiles: 'AGENTS.md'
        });
        writeText(path.join(bundleRoot, 'VERSION'), '9.9.9-test\n');
        writeText(path.join(bundleRoot, 'MANIFEST.md'), '# Manifest\n');
        seedReadyProjectMemory(bundleRoot);
        writeJson(path.join(bundleRoot, 'live', 'config', 'workflow-config.json'), {
            full_suite_validation: {
                enabled: false,
                command: '__FULL_SUITE_COMMAND_UNCONFIGURED__',
                timeout_ms: 600000,
                green_summary_max_lines: 5,
                red_failure_chunk_lines: 50,
                out_of_scope_failure_policy: 'AUDIT_AND_BLOCK'
            }
        });
        writeText(
            path.join(bundleRoot, 'live', 'docs', 'agent-rules', '40-commands.md'),
            [
                '# Commands',
                '',
                '### Compile Gate (Mandatory)',
                '```bash',
                '__COMPILE_GATE_COMMAND_UNCONFIGURED__',
                '```',
                ''
            ].join('\n')
        );
        writeText(path.join(workspaceRoot, 'pyproject.toml'), '[tool.pytest.ini_options]\n');

        const result = runAgentInit({
            targetRoot: workspaceRoot,
            activeAgentFiles: 'AGENTS.md',
            projectRulesUpdated: 'yes',
            skillsPrompted: 'yes',
            ordinaryDocPaths: 'CHANGELOG.md',
            installRunner: function () {},
            verifyRunner: function () {
                return { passed: true };
            },
            manifestRunner: function () {
                return { passed: true };
            }
        });

        assert.equal(result.readyForTasks, true);
        const workflowConfig = readWorkflowConfig(bundleRoot);
        const fullSuiteValidation = workflowConfig.full_suite_validation as Record<string, unknown>;
        const compileGate = workflowConfig.compile_gate as Record<string, unknown>;
        assert.equal(fullSuiteValidation.enabled, false);
        assert.equal(fullSuiteValidation.command, 'pytest');
        assert.equal(compileGate.command, 'python -m compileall .');
        assert.equal(Object.prototype.hasOwnProperty.call(workflowConfig, 'review_execution_policy'), false);
        assert.match(
            fs.readFileSync(path.join(bundleRoot, 'live', 'docs', 'agent-rules', '40-commands.md'), 'utf8'),
            /### Compile Gate \(Mandatory\)\r?\n```bash\r?\npython -m compileall \.\r?\n```/
        );

        const persistedState = JSON.parse(fs.readFileSync(result.agentInitStatePath, 'utf8'));
        assert.equal(persistedState.LastSeededFullSuiteCommand, 'pytest');
    } finally {
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
});

test('runAgentInit preserves npm run build from existing compile-gate guidance', () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-agent-init-preserve-npm-build-'));
    const bundleRoot = path.join(workspaceRoot, 'garda-agent-orchestrator');
    const initAnswersPath = path.join(bundleRoot, 'runtime', 'init-answers.json');

    try {
        writeJson(initAnswersPath, {
            AssistantLanguage: 'English',
            AssistantBrevity: 'concise',
            SourceOfTruth: 'Codex',
            EnforceNoAutoCommit: 'false',
            ClaudeOrchestratorFullAccess: 'false',
            TokenEconomyEnabled: 'true',
            CollectedVia: 'CLI_NONINTERACTIVE',
            ActiveAgentFiles: 'AGENTS.md'
        });
        writeText(path.join(bundleRoot, 'VERSION'), '9.9.9-test\n');
        writeText(path.join(bundleRoot, 'MANIFEST.md'), '# Manifest\n');
        seedReadyProjectMemory(bundleRoot);
        writeJson(path.join(bundleRoot, 'live', 'config', 'workflow-config.json'), {
            compile_gate: {
                command: '__COMPILE_GATE_COMMAND_UNCONFIGURED__'
            },
            full_suite_validation: {
                enabled: false,
                command: '__FULL_SUITE_COMMAND_UNCONFIGURED__',
                timeout_ms: 600000,
                green_summary_max_lines: 5,
                red_failure_chunk_lines: 50,
                out_of_scope_failure_policy: 'AUDIT_AND_BLOCK'
            }
        });
        writeText(
            path.join(bundleRoot, 'live', 'docs', 'agent-rules', '40-commands.md'),
            [
                '# Commands',
                '',
                '### Compile Gate (Mandatory)',
                '```bash',
                'npm run build',
                '```',
                ''
            ].join('\n')
        );
        writeText(path.join(workspaceRoot, 'pyproject.toml'), '[tool.pytest.ini_options]\n');

        runAgentInit({
            targetRoot: workspaceRoot,
            activeAgentFiles: 'AGENTS.md',
            projectRulesUpdated: 'yes',
            skillsPrompted: 'yes',
            ordinaryDocPaths: 'CHANGELOG.md',
            installRunner: function () {},
            verifyRunner: function () {
                return { passed: true };
            },
            manifestRunner: function () {
                return { passed: true };
            }
        });

        const workflowConfig = readWorkflowConfig(bundleRoot);
        const compileGate = workflowConfig.compile_gate as Record<string, unknown>;
        assert.equal(compileGate.command, 'npm run build');
        assert.match(
            fs.readFileSync(path.join(bundleRoot, 'live', 'docs', 'agent-rules', '40-commands.md'), 'utf8'),
            /### Compile Gate \(Mandatory\)\r?\n```bash\r?\nnpm run build\r?\n```/
        );
    } finally {
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
});

test('runAgentInit seeds a composed fast compile gate for backend and frontend workspaces', () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-agent-init-multistack-'));
    const bundleRoot = path.join(workspaceRoot, 'garda-agent-orchestrator');
    const initAnswersPath = path.join(bundleRoot, 'runtime', 'init-answers.json');

    try {
        writeJson(initAnswersPath, {
            AssistantLanguage: 'English',
            AssistantBrevity: 'concise',
            SourceOfTruth: 'Codex',
            EnforceNoAutoCommit: 'false',
            ClaudeOrchestratorFullAccess: 'false',
            TokenEconomyEnabled: 'true',
            CollectedVia: 'CLI_NONINTERACTIVE',
            ActiveAgentFiles: 'AGENTS.md'
        });
        writeText(path.join(bundleRoot, 'VERSION'), '9.9.9-test\n');
        writeText(path.join(bundleRoot, 'MANIFEST.md'), '# Manifest\n');
        seedReadyProjectMemory(bundleRoot);
        writeJson(path.join(bundleRoot, 'live', 'config', 'workflow-config.json'), {
            compile_gate: {
                command: '__COMPILE_GATE_COMMAND_UNCONFIGURED__'
            },
            full_suite_validation: {
                enabled: false,
                command: '__FULL_SUITE_COMMAND_UNCONFIGURED__',
                timeout_ms: 600000,
                green_summary_max_lines: 5,
                red_failure_chunk_lines: 50,
                out_of_scope_failure_policy: 'AUDIT_AND_BLOCK'
            }
        });
        writeText(
            path.join(bundleRoot, 'live', 'docs', 'agent-rules', '40-commands.md'),
            [
                '# Commands',
                '',
                '### Compile Gate (Mandatory)',
                '```bash',
                '__COMPILE_GATE_COMMAND_UNCONFIGURED__',
                '```',
                ''
            ].join('\n')
        );
        writeText(path.join(workspaceRoot, 'backend', 'pom.xml'), '<project />\n');
        writeJson(path.join(workspaceRoot, 'frontend', 'package.json'), {
            scripts: { build: 'vite build', test: 'vitest run' }
        });
        writeJson(path.join(workspaceRoot, 'package.json'), {
            scripts: { build: 'bash ./scripts/build.sh -f' }
        });
        writeText(path.join(workspaceRoot, 'scripts', 'build.sh'), '#!/bin/sh\n');

        runAgentInit({
            targetRoot: workspaceRoot,
            activeAgentFiles: 'AGENTS.md',
            projectRulesUpdated: 'yes',
            skillsPrompted: 'yes',
            ordinaryDocPaths: 'CHANGELOG.md',
            installRunner: function () {},
            verifyRunner: function () {
                return { passed: true };
            },
            manifestRunner: function () {
                return { passed: true };
            }
        });

        const expectedCommand = 'npm --prefix frontend run build && mvn -f backend/pom.xml compile';
        const workflowConfig = readWorkflowConfig(bundleRoot);
        const compileGate = workflowConfig.compile_gate as Record<string, unknown>;
        assert.equal(compileGate.command, expectedCommand);
        assert.match(
            fs.readFileSync(path.join(bundleRoot, 'live', 'docs', 'agent-rules', '40-commands.md'), 'utf8'),
            new RegExp(`### Compile Gate \\(Mandatory\\)\\r?\\n\`\`\`bash\\r?\\n${expectedCommand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\r?\\n\`\`\``)
        );
    } finally {
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
});

test('runAgentInit preserves legacy-compatible workflow-config omission when the file is missing on an existing bundle', () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-agent-init-missing-workflow-config-'));
    const bundleRoot = path.join(workspaceRoot, 'garda-agent-orchestrator');
    const initAnswersPath = path.join(bundleRoot, 'runtime', 'init-answers.json');

    try {
        writeJson(initAnswersPath, {
            AssistantLanguage: 'English',
            AssistantBrevity: 'concise',
            SourceOfTruth: 'Codex',
            EnforceNoAutoCommit: 'false',
            ClaudeOrchestratorFullAccess: 'false',
            TokenEconomyEnabled: 'true',
            CollectedVia: 'CLI_NONINTERACTIVE',
            ActiveAgentFiles: 'AGENTS.md'
        });
        writeText(path.join(bundleRoot, 'VERSION'), '9.9.9-test\n');
        writeText(path.join(bundleRoot, 'MANIFEST.md'), '# Manifest\n');
        seedReadyProjectMemory(bundleRoot);
        writeText(path.join(workspaceRoot, 'pyproject.toml'), '[tool.pytest.ini_options]\n');

        runAgentInit({
            targetRoot: workspaceRoot,
            activeAgentFiles: 'AGENTS.md',
            projectRulesUpdated: 'yes',
            skillsPrompted: 'yes',
            ordinaryDocPaths: 'CHANGELOG.md',
            installRunner: function () {},
            verifyRunner: function () {
                return { passed: true };
            },
            manifestRunner: function () {
                return { passed: true };
            }
        });

        const workflowConfig = readWorkflowConfig(bundleRoot);
        const fullSuiteValidation = workflowConfig.full_suite_validation as Record<string, unknown>;
        assert.equal(fullSuiteValidation.enabled, false);
        assert.equal(fullSuiteValidation.command, 'pytest');
        assert.equal(Object.prototype.hasOwnProperty.call(workflowConfig, 'review_execution_policy'), false);
    } finally {
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
});

test('runAgentInit preserves manual full-suite command overrides when they differ from the prior seeded default', () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-agent-init-manual-fsv-'));
    const bundleRoot = path.join(workspaceRoot, 'garda-agent-orchestrator');
    const initAnswersPath = path.join(bundleRoot, 'runtime', 'init-answers.json');

    try {
        writeJson(initAnswersPath, {
            AssistantLanguage: 'English',
            AssistantBrevity: 'concise',
            SourceOfTruth: 'Codex',
            EnforceNoAutoCommit: 'false',
            ClaudeOrchestratorFullAccess: 'false',
            TokenEconomyEnabled: 'true',
            CollectedVia: 'CLI_NONINTERACTIVE',
            ActiveAgentFiles: 'AGENTS.md'
        });
        writeText(path.join(bundleRoot, 'VERSION'), '9.9.9-test\n');
        writeText(path.join(bundleRoot, 'MANIFEST.md'), '# Manifest\n');
        seedReadyProjectMemory(bundleRoot);
        writeJson(path.join(bundleRoot, 'live', 'config', 'workflow-config.json'), {
            full_suite_validation: {
                enabled: false,
                command: 'python -m pytest -q',
                timeout_ms: 600000,
                green_summary_max_lines: 5,
                red_failure_chunk_lines: 50,
                out_of_scope_failure_policy: 'AUDIT_AND_BLOCK'
            },
            compile_gate: {
                command: 'python -m py_compile app.py'
            }
        });
        writeText(path.join(workspaceRoot, 'app.py'), 'print("ok")\n');
        writeJson(path.join(bundleRoot, 'runtime', 'agent-init-state.json'), {
            Version: 1,
            UpdatedAt: new Date().toISOString(),
            OrchestratorVersion: '9.9.8-test',
            AssistantLanguage: 'English',
            SourceOfTruth: 'Codex',
            AssistantLanguageConfirmed: true,
            ActiveAgentFilesConfirmed: true,
            ProjectRulesUpdated: true,
            SkillsPromptCompleted: true,
            VerificationPassed: true,
            ManifestValidationPassed: true,
            ActiveAgentFiles: ['AGENTS.md'],
            LastSeededFullSuiteCommand: 'pytest'
        });
        writeText(path.join(workspaceRoot, 'pyproject.toml'), '[tool.pytest.ini_options]\n');

        const result = runAgentInit({
            targetRoot: workspaceRoot,
            activeAgentFiles: 'AGENTS.md',
            projectRulesUpdated: 'yes',
            skillsPrompted: 'yes',
            ordinaryDocPaths: 'CHANGELOG.md',
            installRunner: function () {},
            verifyRunner: function () {
                return { passed: true };
            },
            manifestRunner: function () {
                return { passed: true };
            }
        });

        assert.equal(result.readyForTasks, true);
        const workflowConfig = readWorkflowConfig(bundleRoot);
        const fullSuiteValidation = workflowConfig.full_suite_validation as Record<string, unknown>;
        const compileGate = workflowConfig.compile_gate as Record<string, unknown>;
        assert.equal(fullSuiteValidation.command, 'python -m pytest -q');
        assert.equal(compileGate.command, 'python -m py_compile app.py');

        const persistedState = JSON.parse(fs.readFileSync(result.agentInitStatePath, 'utf8'));
        assert.equal(persistedState.LastSeededFullSuiteCommand, 'pytest');
    } finally {
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
});

for (const setting of [
    { name: 'manual', command: 'python -m pytest -q', seeded: 'pytest' },
    { name: 'previously seeded', command: 'pytest', seeded: 'pytest' },
    { name: 'legacy configured', command: 'npm test', seeded: null }
]) test(`runAgentInit preserves ${setting.name} full-suite commands across later detected stack changes`, () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-agent-init-manual-fsv-stack-change-'));
    const bundleRoot = path.join(workspaceRoot, 'garda-agent-orchestrator');
    const initAnswersPath = path.join(bundleRoot, 'runtime', 'init-answers.json');

    try {
        writeJson(initAnswersPath, {
            AssistantLanguage: 'English',
            AssistantBrevity: 'concise',
            SourceOfTruth: 'Codex',
            EnforceNoAutoCommit: 'false',
            ClaudeOrchestratorFullAccess: 'false',
            TokenEconomyEnabled: 'true',
            CollectedVia: 'CLI_NONINTERACTIVE',
            ActiveAgentFiles: 'AGENTS.md'
        });
        writeText(path.join(bundleRoot, 'VERSION'), '9.9.9-test\n');
        writeText(path.join(bundleRoot, 'MANIFEST.md'), '# Manifest\n');
        seedReadyProjectMemory(bundleRoot);
        writeJson(path.join(bundleRoot, 'live', 'config', 'workflow-config.json'), {
            full_suite_validation: {
                enabled: false,
                command: setting.command,
                timeout_ms: 600000,
                green_summary_max_lines: 5,
                red_failure_chunk_lines: 50,
                out_of_scope_failure_policy: 'AUDIT_AND_BLOCK'
            }
        });
        writeJson(path.join(bundleRoot, 'runtime', 'agent-init-state.json'), {
            Version: 1,
            UpdatedAt: new Date().toISOString(),
            OrchestratorVersion: '9.9.8-test',
            AssistantLanguage: 'English',
            SourceOfTruth: 'Codex',
            AssistantLanguageConfirmed: true,
            ActiveAgentFilesConfirmed: true,
            ProjectRulesUpdated: true,
            SkillsPromptCompleted: true,
            VerificationPassed: true,
            ManifestValidationPassed: true,
            ActiveAgentFiles: ['AGENTS.md'],
            LastSeededFullSuiteCommand: setting.seeded
        });
        writeJson(path.join(workspaceRoot, 'package.json'), {
            packageManager: 'pnpm@9.0.0',
            scripts: {
                test: 'vitest run'
            }
        });
        writeText(path.join(workspaceRoot, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n');

        const result = runAgentInit({
            targetRoot: workspaceRoot,
            activeAgentFiles: 'AGENTS.md',
            projectRulesUpdated: 'yes',
            skillsPrompted: 'yes',
            ordinaryDocPaths: 'CHANGELOG.md',
            installRunner: function () {},
            verifyRunner: function () {
                return { passed: true };
            },
            manifestRunner: function () {
                return { passed: true };
            }
        });

        assert.equal(result.readyForTasks, true);
        const workflowConfig = readWorkflowConfig(bundleRoot);
        const fullSuiteValidation = workflowConfig.full_suite_validation as Record<string, unknown>;
        assert.equal(fullSuiteValidation.command, setting.command);

        const persistedState = JSON.parse(fs.readFileSync(result.agentInitStatePath, 'utf8'));
        assert.equal(persistedState.LastSeededFullSuiteCommand, setting.seeded);
    } finally {
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
});

test('runAgentInit preserves existing workflow-config toggles while seeding only the detected command', () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-agent-init-workflow-config-preserve-'));
    const bundleRoot = path.join(workspaceRoot, 'garda-agent-orchestrator');
    const initAnswersPath = path.join(bundleRoot, 'runtime', 'init-answers.json');

    try {
        writeJson(initAnswersPath, {
            AssistantLanguage: 'English',
            AssistantBrevity: 'concise',
            SourceOfTruth: 'Codex',
            EnforceNoAutoCommit: 'false',
            ClaudeOrchestratorFullAccess: 'false',
            TokenEconomyEnabled: 'true',
            CollectedVia: 'CLI_NONINTERACTIVE',
            ActiveAgentFiles: 'AGENTS.md'
        });
        writeText(path.join(bundleRoot, 'VERSION'), '9.9.9-test\n');
        writeText(path.join(bundleRoot, 'MANIFEST.md'), '# Manifest\n');
        seedReadyProjectMemory(bundleRoot);
        writeJson(path.join(bundleRoot, 'live', 'config', 'workflow-config.json'), {
            compile_gate: {
                command: TEST_COMPILE_GATE_COMMAND
            },
            full_suite_validation: {
                enabled: true,
                command: '__FULL_SUITE_COMMAND_UNCONFIGURED__',
                timeout_ms: 600000,
                green_summary_max_lines: 5,
                red_failure_chunk_lines: 50,
                out_of_scope_failure_policy: 'AUDIT_AND_WARN',
                auto_open_report: true
            },
            review_execution_policy: {
                mode: 'strict_sequential'
            }
        });
        writeText(
            path.join(bundleRoot, 'live', 'docs', 'agent-rules', '40-commands.md'),
            [
                '# Commands',
                '',
                '### Compile Gate (Mandatory)',
                '```bash',
                '__COMPILE_GATE_COMMAND_UNCONFIGURED__',
                '```',
                ''
            ].join('\n')
        );
        writeText(path.join(workspaceRoot, 'pyproject.toml'), '[tool.pytest.ini_options]\n');

        runAgentInit({
            targetRoot: workspaceRoot,
            activeAgentFiles: 'AGENTS.md',
            projectRulesUpdated: 'yes',
            skillsPrompted: 'yes',
            ordinaryDocPaths: 'CHANGELOG.md',
            installRunner: function () {},
            verifyRunner: function () {
                return { passed: true };
            },
            manifestRunner: function () {
                return { passed: true };
            }
        });

        const workflowConfig = readWorkflowConfig(bundleRoot);
        const compileGate = workflowConfig.compile_gate as Record<string, unknown>;
        const fullSuiteValidation = workflowConfig.full_suite_validation as Record<string, unknown>;
        assert.equal(compileGate.command, TEST_COMPILE_GATE_COMMAND);
        assert.equal(fullSuiteValidation.enabled, true);
        assert.equal(fullSuiteValidation.command, 'pytest');
        assert.equal(fullSuiteValidation.out_of_scope_failure_policy, 'AUDIT_AND_WARN');
        assert.equal(fullSuiteValidation.auto_open_report, true);
        assert.deepEqual(workflowConfig.review_execution_policy, {
            mode: 'strict_sequential'
        });
        assert.match(
            fs.readFileSync(path.join(bundleRoot, 'live', 'docs', 'agent-rules', '40-commands.md'), 'utf8'),
            /### Compile Gate \(Mandatory\)\r?\n```bash\r?\nnode -e "console\.log\('build ok'\)"\r?\n```/
        );
    } finally {
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
});

test('runAgentInit migrates moved Garda baseline rules to self-host custom rules in source checkouts', () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-agent-init-source-rules-'));
    const bundleRoot = path.join(workspaceRoot, 'garda-agent-orchestrator');
    const initAnswersPath = path.join(bundleRoot, 'runtime', 'init-answers.json');

    try {
        seedSourceCheckoutMarkers(workspaceRoot);
        writeJson(initAnswersPath, {
            AssistantLanguage: 'English',
            AssistantBrevity: 'concise',
            SourceOfTruth: 'Codex',
            EnforceNoAutoCommit: 'false',
            ClaudeOrchestratorFullAccess: 'false',
            TokenEconomyEnabled: 'true',
            CollectedVia: 'CLI_NONINTERACTIVE',
            ActiveAgentFiles: 'AGENTS.md'
        });
        writeText(path.join(bundleRoot, 'VERSION'), '9.9.9-test\n');
        writeText(path.join(bundleRoot, 'MANIFEST.md'), '# Manifest\n');
        seedReadyProjectMemory(bundleRoot);
        writeJson(path.join(bundleRoot, 'live', 'config', 'workflow-config.json'), {
            optional_quality_checks: {
                enabled: true,
                baseline_version: '2026-06-26.t843',
                rules: [
                    {
                        id: 'artifact_evidence_binding',
                        title: 'Artifact evidence binding',
                        prompt: 'Check old artifact rule.',
                        enabled: false
                    }
                ]
            }
        });

        runAgentInit({
            targetRoot: workspaceRoot,
            activeAgentFiles: 'AGENTS.md',
            projectRulesUpdated: 'yes',
            skillsPrompted: 'yes',
            ordinaryDocPaths: 'CHANGELOG.md',
            installRunner: function () {},
            verifyRunner: function () {
                return { passed: true };
            },
            manifestRunner: function () {
                return { passed: true };
            }
        });

        const workflowConfig = readWorkflowConfig(bundleRoot);
        const optionalQualityChecks = workflowConfig.optional_quality_checks as Record<string, unknown>;
        const ruleIds = (optionalQualityChecks.rules as Array<{ id: string }>).map((rule) => rule.id);
        assert.equal(ruleIds.includes('artifact_evidence_binding'), false);
        assert.ok(ruleIds.includes('custom_garda_artifact_evidence_binding'));
        const movedCustomRule = (optionalQualityChecks.rules as Array<{ id: string; enabled: boolean }>).find(
            (rule) => rule.id === 'custom_garda_artifact_evidence_binding'
        );
        assert.equal(movedCustomRule?.enabled, false);
    } finally {
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
});

test('runAgentInit materializes moved Garda custom rules for fresh source-checkout workflow config', () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-agent-init-source-rules-fresh-'));
    const bundleRoot = path.join(workspaceRoot, 'garda-agent-orchestrator');
    const initAnswersPath = path.join(bundleRoot, 'runtime', 'init-answers.json');

    try {
        seedSourceCheckoutMarkers(workspaceRoot);
        writeJson(initAnswersPath, {
            AssistantLanguage: 'English',
            AssistantBrevity: 'concise',
            SourceOfTruth: 'Codex',
            EnforceNoAutoCommit: 'false',
            ClaudeOrchestratorFullAccess: 'false',
            TokenEconomyEnabled: 'true',
            CollectedVia: 'CLI_NONINTERACTIVE',
            ActiveAgentFiles: 'AGENTS.md'
        });
        writeText(path.join(bundleRoot, 'VERSION'), '9.9.9-test\n');
        writeText(path.join(bundleRoot, 'MANIFEST.md'), '# Manifest\n');
        seedReadyProjectMemory(bundleRoot);

        runAgentInit({
            targetRoot: workspaceRoot,
            activeAgentFiles: 'AGENTS.md',
            projectRulesUpdated: 'yes',
            skillsPrompted: 'yes',
            ordinaryDocPaths: 'CHANGELOG.md',
            installRunner: function () {},
            verifyRunner: function () {
                return { passed: true };
            },
            manifestRunner: function () {
                return { passed: true };
            }
        });

        const workflowConfig = readWorkflowConfig(bundleRoot);
        const optionalQualityChecks = workflowConfig.optional_quality_checks as Record<string, unknown>;
        const ruleIds = (optionalQualityChecks.rules as Array<{ id: string }>).map((rule) => rule.id);
        assert.ok(ruleIds.includes('custom_garda_classifier_intent_edge_cases'));
        assert.ok(ruleIds.includes('custom_garda_config_materialization_parity'));
        assert.ok(ruleIds.includes('custom_garda_control_plane_action_safety'));
        assert.ok(ruleIds.includes('custom_garda_artifact_evidence_binding'));
        assert.ok(ruleIds.includes('custom_garda_gate_routing_self_regression'));
    } finally {
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
});
