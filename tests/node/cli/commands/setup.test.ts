import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createBundleSourceFixture } from '../../bundle-source-fixtures';

import {
    SETUP_DEFINITIONS,
    getSetupAnswerDefaults,
    buildSetupHandoffText,
    buildSetupStepsText,
    handleSetup
} from '../../../../src/cli/commands/setup';
import { evaluateProtectedControlPlaneManifest } from '../../../../src/gates/shared';
import type { StatusSnapshot } from '../../../../src/validators/status';

import {
    DEFAULT_BUNDLE_NAME,
    UNCONFIGURED_COMPILE_GATE_COMMAND,
    resolveInitAnswersRelativePath
} from '../../../../src/core/constants';
import {
    DEFAULT_OPTIONAL_QUALITY_CHECK_RULES,
    OPTIONAL_QUALITY_CHECKS_BASELINE_VERSION,
    OPTIONAL_QUALITY_CHECKS_ENABLED_NOTICE
} from '../../../../src/core/workflow-config';
import { quoteCommandValue } from '../../../../src/core/command-quoting';
import { PROJECT_MEMORY_INIT_REFRESH_PROMPT } from '../../../../src/core/project-memory-rollout';
import { parseOptions } from '../../../../src/cli/commands/cli-helpers';

const INIT_ANSWERS_RELATIVE_PATH = resolveInitAnswersRelativePath();
const TEST_COMPILE_GATE_COMMAND = 'npm run build';

function stripAnsi(value: string): string {
    return value.replace(/\x1B\[[0-9;?]*[ -/]*[@-~]/g, '');
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

    const workflowConfigPath = path.join(bundleRoot, 'live', 'config', 'workflow-config.json');
    const workflowConfig = JSON.parse(fs.readFileSync(workflowConfigPath, 'utf8')) as Record<string, unknown>;
    const compileGate = workflowConfig.compile_gate && typeof workflowConfig.compile_gate === 'object' && !Array.isArray(workflowConfig.compile_gate)
        ? { ...workflowConfig.compile_gate as Record<string, unknown> }
        : {};
    compileGate.command = TEST_COMPILE_GATE_COMMAND;
    workflowConfig.compile_gate = compileGate;
    fs.writeFileSync(workflowConfigPath, JSON.stringify(workflowConfig, null, 2), 'utf8');
}

function extractMarkdownSection(content: string, heading: string): string {
    const headingMatch = heading.match(/^(#+)\s+/);
    assert.ok(headingMatch, `Heading must be markdown-formatted: ${heading}`);
    const headingLevel = headingMatch[1].length;
    const startPattern = new RegExp(`^${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm');
    const startMatch = startPattern.exec(content);
    assert.ok(startMatch, `Missing heading: ${heading}`);
    const sectionStart = startMatch.index;
    const searchStart = sectionStart + startMatch[0].length;
    const remainder = content.slice(searchStart);
    const nextHeadingPattern = new RegExp(`^#{1,${headingLevel}}\\s+`, 'm');
    const nextHeadingMatch = nextHeadingPattern.exec(remainder);
    const sectionEnd = nextHeadingMatch
        ? searchStart + nextHeadingMatch.index
        : content.length;
    return content.slice(sectionStart, sectionEnd).trim();
}

function readInitReport(workspaceRoot: string): string {
    return fs.readFileSync(
        path.join(workspaceRoot, DEFAULT_BUNDLE_NAME, 'live', 'init-report.md'),
        'utf8'
    );
}

async function captureConsoleLogs(callback: () => Promise<void>): Promise<string[]> {
    const originalLog = console.log;
    const lines: string[] = [];
    console.log = (...args: unknown[]) => {
        lines.push(args.map((entry) => String(entry)).join(' '));
    };
    try {
        await callback();
        return lines;
    } finally {
        console.log = originalLog;
    }
}

function withColorEnv<T>(env: { NO_COLOR?: string | undefined; FORCE_COLOR?: string | undefined }, action: () => T): T {
    const previousNoColor = process.env.NO_COLOR;
    const previousForceColor = process.env.FORCE_COLOR;
    try {
        if (env.NO_COLOR === undefined) {
            delete process.env.NO_COLOR;
        } else {
            process.env.NO_COLOR = env.NO_COLOR;
        }
        if (env.FORCE_COLOR === undefined) {
            delete process.env.FORCE_COLOR;
        } else {
            process.env.FORCE_COLOR = env.FORCE_COLOR;
        }
        return action();
    } finally {
        if (previousNoColor === undefined) {
            delete process.env.NO_COLOR;
        } else {
            process.env.NO_COLOR = previousNoColor;
        }
        if (previousForceColor === undefined) {
            delete process.env.FORCE_COLOR;
        } else {
            process.env.FORCE_COLOR = previousForceColor;
        }
    }
}

function hasAnsi(text: string): boolean {
    return /\u001b\[[0-9;]*m/.test(text);
}

test('SETUP_DEFINITIONS includes all expected flags', () => {
    assert.ok(SETUP_DEFINITIONS['--target-root']);
    assert.ok(SETUP_DEFINITIONS['--init-answers-path']);
    assert.ok(SETUP_DEFINITIONS['--repo-url']);
    assert.ok(SETUP_DEFINITIONS['--branch']);
    assert.ok(SETUP_DEFINITIONS['--dry-run']);
    assert.equal(SETUP_DEFINITIONS['--dry-run'].type, 'boolean');
    assert.ok(SETUP_DEFINITIONS['--no-prompt']);
    assert.ok(SETUP_DEFINITIONS['--skip-verify']);
    assert.ok(SETUP_DEFINITIONS['--skip-manifest-validation']);
    assert.ok(SETUP_DEFINITIONS['--preserve-agent-state']);
    assert.ok(SETUP_DEFINITIONS['--assistant-language']);
    assert.ok(SETUP_DEFINITIONS['--assistant-brevity']);
    assert.ok(SETUP_DEFINITIONS['--active-agent-files']);
    assert.ok(SETUP_DEFINITIONS['--source-of-truth']);
    assert.ok(SETUP_DEFINITIONS['--enforce-no-auto-commit']);
    assert.ok(SETUP_DEFINITIONS['--claude-orchestrator-full-access']);
    assert.ok(SETUP_DEFINITIONS['--claude-full-access']);
    assert.equal(SETUP_DEFINITIONS['--claude-full-access'].key, 'claudeOrchestratorFullAccess');
    assert.ok(SETUP_DEFINITIONS['--token-economy-enabled']);
    assert.ok(SETUP_DEFINITIONS['--provider-minimalism']);
});

test('parseOptions works with SETUP_DEFINITIONS', () => {
    const { options } = parseOptions([
        '--target-root', '/workspace',
        '--no-prompt',
        '--preserve-agent-state',
        '--source-of-truth', 'Claude',
        '--assistant-language', 'English',
        '--assistant-brevity', 'concise',
        '--enforce-no-auto-commit', 'true',
        '--token-economy-enabled', 'false',
        '--provider-minimalism', 'false'
    ], SETUP_DEFINITIONS);

    assert.equal(options.targetRoot, '/workspace');
    assert.equal(options.noPrompt, true);
    assert.equal(options.preserveAgentState, true);
    assert.equal(options.sourceOfTruth, 'Claude');
    assert.equal(options.assistantLanguage, 'English');
    assert.equal(options.assistantBrevity, 'concise');
    assert.equal(options.enforceNoAutoCommit, 'true');
    assert.equal(options.tokenEconomyEnabled, 'false');
    assert.equal(options.providerMinimalism, 'false');
});

test('--claude-full-access aliases to claudeOrchestratorFullAccess', () => {
    const { options } = parseOptions(['--claude-full-access', 'yes'], SETUP_DEFINITIONS);
    assert.equal(options.claudeOrchestratorFullAccess, 'yes');
});

test('getSetupAnswerDefaults returns sensible defaults for empty workspace', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-defaults-'));
    try {
        const defaults = getSetupAnswerDefaults(tmpDir, INIT_ANSWERS_RELATIVE_PATH, {});
        assert.equal(defaults.assistantLanguage, 'English');
        assert.equal(defaults.assistantBrevity, 'concise');
        assert.equal(defaults.sourceOfTruth, 'Codex');
        assert.equal(defaults.enforceNoAutoCommit, true);
        assert.equal(defaults.claudeOrchestratorFullAccess, false);
        assert.equal(defaults.tokenEconomyEnabled, true);
        assert.equal(defaults.providerMinimalism, true);
        assert.equal(defaults.activeAgentFiles, 'AGENTS.md');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('getSetupAnswerDefaults respects CLI options over defaults', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-defaults-'));
    try {
        const defaults = getSetupAnswerDefaults(tmpDir, INIT_ANSWERS_RELATIVE_PATH, {
            assistantLanguage: 'Russian',
            assistantBrevity: 'detailed',
            sourceOfTruth: 'Codex',
            enforceNoAutoCommit: 'false',
            claudeOrchestratorFullAccess: 'true',
            tokenEconomyEnabled: 'false',
            providerMinimalism: 'false'
        });
        assert.equal(defaults.assistantLanguage, 'Russian');
        assert.equal(defaults.assistantBrevity, 'detailed');
        assert.equal(defaults.sourceOfTruth, 'Codex');
        assert.equal(defaults.enforceNoAutoCommit, false);
        assert.equal(defaults.claudeOrchestratorFullAccess, true);
        assert.equal(defaults.tokenEconomyEnabled, false);
        assert.equal(defaults.providerMinimalism, false);
        assert.equal(defaults.activeAgentFiles, 'AGENTS.md');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('getSetupAnswerDefaults reads existing init answers file', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-defaults-'));
    const answersDir = path.join(tmpDir, DEFAULT_BUNDLE_NAME, 'runtime');
    fs.mkdirSync(answersDir, { recursive: true });
    fs.writeFileSync(
        path.join(answersDir, 'init-answers.json'),
        JSON.stringify({
            AssistantLanguage: 'Deutsch',
            AssistantBrevity: 'detailed',
            SourceOfTruth: 'Gemini',
            EnforceNoAutoCommit: 'true',
            ClaudeOrchestratorFullAccess: 'true',
            TokenEconomyEnabled: 'false',
            ProviderMinimalism: 'false'
        }),
        'utf8'
    );

    try {
        const defaults = getSetupAnswerDefaults(tmpDir, INIT_ANSWERS_RELATIVE_PATH, {});
        assert.equal(defaults.assistantLanguage, 'Deutsch');
        assert.equal(defaults.assistantBrevity, 'detailed');
        assert.equal(defaults.sourceOfTruth, 'Gemini');
        assert.equal(defaults.enforceNoAutoCommit, true);
        assert.equal(defaults.claudeOrchestratorFullAccess, true);
        assert.equal(defaults.tokenEconomyEnabled, false);
        assert.equal(defaults.providerMinimalism, false);
        assert.equal(defaults.activeAgentFiles, 'GEMINI.md');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('getSetupAnswerDefaults CLI options override existing init answers', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-defaults-'));
    const answersDir = path.join(tmpDir, DEFAULT_BUNDLE_NAME, 'runtime');
    fs.mkdirSync(answersDir, { recursive: true });
    fs.writeFileSync(
        path.join(answersDir, 'init-answers.json'),
        JSON.stringify({
            AssistantLanguage: 'Deutsch',
            AssistantBrevity: 'detailed',
            SourceOfTruth: 'Gemini',
            EnforceNoAutoCommit: 'true',
            ClaudeOrchestratorFullAccess: 'false',
            TokenEconomyEnabled: 'true'
        }),
        'utf8'
    );

    try {
        const defaults = getSetupAnswerDefaults(tmpDir, INIT_ANSWERS_RELATIVE_PATH, {
            sourceOfTruth: 'Claude'
        });
        assert.equal(defaults.assistantLanguage, 'Deutsch');
        assert.equal(defaults.sourceOfTruth, 'Claude');
        assert.equal(defaults.activeAgentFiles, 'CLAUDE.md');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('getSetupAnswerDefaults normalizes numbered active agent file selections', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-defaults-'));
    try {
        const defaults = getSetupAnswerDefaults(tmpDir, INIT_ANSWERS_RELATIVE_PATH, {
            sourceOfTruth: 'Claude',
            activeAgentFiles: '1, 2, 8'
        });
        assert.equal(defaults.activeAgentFiles, 'CLAUDE.md, AGENTS.md, .antigravity/rules.md');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('getSetupAnswerDefaults preserves existing active agent files by default', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-defaults-'));
    const answersDir = path.join(tmpDir, DEFAULT_BUNDLE_NAME, 'runtime');
    fs.mkdirSync(answersDir, { recursive: true });
    fs.writeFileSync(
        path.join(answersDir, 'init-answers.json'),
        JSON.stringify({
            AssistantLanguage: 'English',
            AssistantBrevity: 'concise',
            SourceOfTruth: 'Codex',
            EnforceNoAutoCommit: 'true',
            ClaudeOrchestratorFullAccess: 'false',
            TokenEconomyEnabled: 'true',
            ActiveAgentFiles: 'CLAUDE.md, AGENTS.md'
        }),
        'utf8'
    );

    try {
        const defaults = getSetupAnswerDefaults(tmpDir, INIT_ANSWERS_RELATIVE_PATH, {});
        assert.equal(defaults.sourceOfTruth, 'Codex');
        assert.equal(defaults.activeAgentFiles, 'CLAUDE.md, AGENTS.md');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('getSetupAnswerDefaults reconciles preserved active agent files with an explicit source-of-truth override', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-defaults-'));
    const answersDir = path.join(tmpDir, DEFAULT_BUNDLE_NAME, 'runtime');
    fs.mkdirSync(answersDir, { recursive: true });
    fs.writeFileSync(
        path.join(answersDir, 'init-answers.json'),
        JSON.stringify({
            AssistantLanguage: 'English',
            AssistantBrevity: 'concise',
            SourceOfTruth: 'Codex',
            EnforceNoAutoCommit: 'true',
            ClaudeOrchestratorFullAccess: 'false',
            TokenEconomyEnabled: 'true',
            ActiveAgentFiles: 'CLAUDE.md, AGENTS.md, .antigravity/rules.md'
        }),
        'utf8'
    );

    try {
        const defaults = getSetupAnswerDefaults(tmpDir, INIT_ANSWERS_RELATIVE_PATH, {
            sourceOfTruth: 'Gemini'
        });
        assert.equal(defaults.sourceOfTruth, 'Gemini');
        assert.equal(defaults.activeAgentFiles, 'CLAUDE.md, AGENTS.md, GEMINI.md, .antigravity/rules.md');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('handleSetup --no-prompt preserves existing active agent files and rematerializes their entrypoints', async (context) => {
    const repoRoot = createBundleSourceFixture(context);
    const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-setup-preserve-active-files-'));
    const answersDir = path.join(workspaceRoot, DEFAULT_BUNDLE_NAME, 'runtime');
    fs.mkdirSync(answersDir, { recursive: true });
    fs.writeFileSync(
        path.join(answersDir, 'init-answers.json'),
        JSON.stringify({
            AssistantLanguage: 'English',
            AssistantBrevity: 'concise',
            SourceOfTruth: 'Codex',
            EnforceNoAutoCommit: 'false',
            ClaudeOrchestratorFullAccess: 'false',
            TokenEconomyEnabled: 'true',
            ProviderMinimalism: 'false',
            CollectedVia: 'CLI_NONINTERACTIVE',
            ActiveAgentFiles: 'CLAUDE.md, AGENTS.md, .antigravity/rules.md'
        }),
        'utf8'
    );

    try {
        await handleSetup(
            ['--target-root', workspaceRoot, '--no-prompt', '--skip-verify', '--skip-manifest-validation'],
            packageJson,
            repoRoot
        );

        const persistedAnswers = JSON.parse(
            fs.readFileSync(path.join(workspaceRoot, DEFAULT_BUNDLE_NAME, 'runtime', 'init-answers.json'), 'utf8')
        );
        const workflowConfig = JSON.parse(
            fs.readFileSync(path.join(workspaceRoot, DEFAULT_BUNDLE_NAME, 'live', 'config', 'workflow-config.json'), 'utf8')
        );
        assert.equal(persistedAnswers.ActiveAgentFiles, 'CLAUDE.md, AGENTS.md, .antigravity/rules.md');
        assert.equal(persistedAnswers.ProviderMinimalism, 'false');
        assert.deepEqual(workflowConfig.review_execution_policy, {
            mode: 'strict_sequential'
        });
        assert.ok(fs.existsSync(path.join(workspaceRoot, 'CLAUDE.md')));
        assert.ok(fs.existsSync(path.join(workspaceRoot, 'AGENTS.md')));
        assert.ok(fs.existsSync(path.join(workspaceRoot, '.antigravity', 'rules.md')));
    } finally {
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
});

test('handleSetup runs contract migrations before verify so stale live task workflow snippets do not block refresh', async (context) => {
    const repoRoot = createBundleSourceFixture(context);
    const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-setup-contract-migrations-'));
    const bundleRoot = path.join(workspaceRoot, DEFAULT_BUNDLE_NAME);
    const staleWorkflowPath = path.join(bundleRoot, 'live', 'docs', 'agent-rules', '80-task-workflow.md');
    const taskAuditSnippet = 'gate task-audit-summary --task-id "<task-id>" --as-json';

    try {
        fs.mkdirSync(path.join(workspaceRoot, '.git'), { recursive: true });

        await captureConsoleLogs(async () => {
            await handleSetup(
                ['--target-root', workspaceRoot, '--no-prompt', '--skip-verify', '--skip-manifest-validation', '--source-of-truth', 'Codex'],
                packageJson,
                repoRoot
            );
        });

        materializeProjectCommands(bundleRoot);
        const staleWorkflow = fs.readFileSync(staleWorkflowPath, 'utf8')
            .replace(/^.*gate task-audit-summary --task-id "<task-id>" --as-json.*\r?\n?/gm, '');
        fs.writeFileSync(staleWorkflowPath, staleWorkflow, 'utf8');
        assert.ok(!fs.readFileSync(staleWorkflowPath, 'utf8').includes(taskAuditSnippet));

        const verifyOutput = await captureConsoleLogs(async () => {
            await handleSetup(
                ['--target-root', workspaceRoot, '--no-prompt', '--verify', '--skip-manifest-validation', '--preserve-agent-state'],
                packageJson,
                repoRoot
            );
        });

        const refreshedWorkflow = fs.readFileSync(staleWorkflowPath, 'utf8');
        assert.ok(refreshedWorkflow.includes(taskAuditSnippet));
        assert.ok(verifyOutput.includes('Verify: PASS'), verifyOutput.join('\n'));

        const protectedManifestEvidence = evaluateProtectedControlPlaneManifest(workspaceRoot, null, true);
        assert.equal(protectedManifestEvidence.status, 'MATCH', JSON.stringify(protectedManifestEvidence));
    } finally {
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
});

test('handleSetup preserves project-specific compile gate command during contract migration refresh', async (context) => {
    const repoRoot = createBundleSourceFixture(context);
    const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-setup-compile-gate-preserve-'));
    const bundleRoot = path.join(workspaceRoot, DEFAULT_BUNDLE_NAME);
    const commandsPath = path.join(bundleRoot, 'live', 'docs', 'agent-rules', '40-commands.md');

    try {
        fs.mkdirSync(path.join(workspaceRoot, '.git'), { recursive: true });
        fs.writeFileSync(path.join(workspaceRoot, 'settings.gradle'), 'pluginManagement { repositories { gradlePluginPortal() } }\n', 'utf8');
        fs.writeFileSync(path.join(workspaceRoot, 'build.gradle'), 'plugins { id "java" }\n', 'utf8');
        fs.writeFileSync(path.join(workspaceRoot, 'gradlew.bat'), '@echo off\r\n', 'utf8');

        await captureConsoleLogs(async () => {
            await handleSetup(
                ['--target-root', workspaceRoot, '--no-prompt', '--skip-verify', '--skip-manifest-validation', '--source-of-truth', 'Codex'],
                packageJson,
                repoRoot
            );
        });

        fs.writeFileSync(commandsPath, [
            '# Commands',
            '',
            '## Agent Gates',
            '```bash',
            'node garda-agent-orchestrator/bin/garda.js gate classify-change --changed-file "src/example.ts"',
            '```',
            '',
            '### Compile Gate (Mandatory)',
            '```bash',
            '.\\gradlew.bat clean testClasses --console=plain',
            '```',
            '',
            'Rules:',
            '- First non-empty non-comment line from this block is the compile gate command.'
        ].join('\n'), 'utf8');

        await captureConsoleLogs(async () => {
            await handleSetup(
                ['--target-root', workspaceRoot, '--no-prompt', '--skip-verify', '--skip-manifest-validation', '--preserve-agent-state'],
                packageJson,
                repoRoot
            );
        });

        const commandsContent = fs.readFileSync(commandsPath, 'utf8');
        const compileSection = extractMarkdownSection(commandsContent, '### Compile Gate (Mandatory)');
        const workflowConfig = JSON.parse(fs.readFileSync(
            path.join(bundleRoot, 'live', 'config', 'workflow-config.json'),
            'utf8'
        ));
        assert.ok(compileSection.includes('.\\gradlew.bat clean testClasses --console=plain'));
        assert.equal(workflowConfig.compile_gate.command, '.\\gradlew.bat clean testClasses --console=plain');
        assert.ok(!/```bash\r?\nnpm run build\r?\n```/.test(compileSection));
        assert.ok(compileSection.includes('must be a compile/build/type-check command'));
        assert.ok(compileSection.includes('Do not use full-suite test commands here'));
    } finally {
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
});

test('handleSetup preserves explicit workflow-config full-suite settings across repeated refreshes', async (context) => {
    const repoRoot = createBundleSourceFixture(context);
    const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-setup-workflow-config-preserve-'));
    const workflowConfigPath = path.join(workspaceRoot, DEFAULT_BUNDLE_NAME, 'live', 'config', 'workflow-config.json');

    try {
        fs.mkdirSync(path.join(workspaceRoot, '.git'), { recursive: true });

        await handleSetup(
            ['--target-root', workspaceRoot, '--no-prompt', '--skip-verify', '--skip-manifest-validation', '--source-of-truth', 'Codex'],
            packageJson,
            repoRoot
        );

        fs.writeFileSync(
            workflowConfigPath,
            JSON.stringify({
                full_suite_validation: {
                    enabled: true,
                    command: 'npm run test:full',
                    timeout_ms: 123456,
                    green_summary_max_lines: 7,
                    red_failure_chunk_lines: 42,
                    out_of_scope_failure_policy: 'AUDIT_AND_WARN'
                },
                review_execution_policy: {
                    mode: 'strict_sequential'
                }
            }, null, 2),
            'utf8'
        );

        const refreshOutput = await captureConsoleLogs(async () => {
            await handleSetup(
                ['--target-root', workspaceRoot, '--no-prompt', '--skip-verify', '--skip-manifest-validation', '--preserve-agent-state'],
                packageJson,
                repoRoot
            );
        });

        const workflowConfig = JSON.parse(fs.readFileSync(workflowConfigPath, 'utf8'));
        assert.deepEqual(workflowConfig.full_suite_validation, {
            enabled: true,
            command: 'npm run test:full',
            timeout_ms: 123456,
            green_summary_max_lines: 7,
            red_failure_chunk_lines: 42,
            timeout_blocker: true,
            timeout_retry_count: 1,
            out_of_scope_failure_policy: 'AUDIT_AND_WARN',
            placement: 'after_compile_before_reviews'
        });
        assert.deepEqual(workflowConfig.review_execution_policy, {
            mode: 'strict_sequential'
        });
        const initReport = readInitReport(workspaceRoot);
        const refreshText = refreshOutput.join('\n');
        assert.ok(refreshText.includes(`WorkflowConfigMerge: existing_values_preserved_and_missing_keys_filled path=${DEFAULT_BUNDLE_NAME}/live/config/workflow-config.json full_suite_validation.enabled=true`));
        assert.ok(refreshText.includes('review_cycle_guard.max_failed_non_test_reviews=10 review_cycle_guard.max_total_non_test_reviews=30 review_cycle_guard.limit_status=missing_keys_filled_from_template'));
        assert.ok(initReport.includes('Workflow config merge status: existing_values_preserved_and_missing_keys_filled'));
        assert.ok(initReport.includes(`path=${DEFAULT_BUNDLE_NAME}/live/config/workflow-config.json`));
        assert.ok(initReport.includes('full_suite_validation.enabled=true'));
        assert.ok(initReport.includes('review_cycle_guard.max_total_non_test_reviews=30'));
        assert.ok(!refreshText.includes('ProjectMemoryMaintenance: Project memory maintenance: update read_strategy=index_first'));
        assert.ok(!refreshText.includes(`ProjectMemoryRefreshHandoff: ${PROJECT_MEMORY_INIT_REFRESH_PROMPT}`));
        assert.ok(initReport.includes(`Project memory init/refresh prompt: ${PROJECT_MEMORY_INIT_REFRESH_PROMPT}`));
    } finally {
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
});

test('handleSetup migrates exact legacy generated project-memory maintenance default during refresh', async (context) => {
    const repoRoot = createBundleSourceFixture(context);
    const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-setup-project-memory-legacy-default-'));
    const workflowConfigPath = path.join(workspaceRoot, DEFAULT_BUNDLE_NAME, 'live', 'config', 'workflow-config.json');

    try {
        fs.mkdirSync(path.join(workspaceRoot, '.git'), { recursive: true });

        await handleSetup(
            ['--target-root', workspaceRoot, '--no-prompt', '--skip-verify', '--skip-manifest-validation', '--source-of-truth', 'Codex'],
            packageJson,
            repoRoot
        );

        fs.writeFileSync(
            workflowConfigPath,
            JSON.stringify({
                full_suite_validation: {
                    enabled: true,
                    command: 'npm run test:full',
                    timeout_ms: 123456,
                    green_summary_max_lines: 7,
                    red_failure_chunk_lines: 42,
                    out_of_scope_failure_policy: 'AUDIT_AND_WARN'
                },
                project_memory_maintenance: {
                    enabled: false,
                    mode: 'check',
                    run_before_final_closeout: true,
                    require_user_approval_for_writes: true,
                    max_compact_summary_chars: 12000,
                    read_strategy: 'index_first',
                    impact_artifact_retention_days: 30
                }
            }, null, 2),
            'utf8'
        );

        const refreshOutput = await captureConsoleLogs(async () => {
            await handleSetup(
                ['--target-root', workspaceRoot, '--no-prompt', '--skip-verify', '--skip-manifest-validation', '--preserve-agent-state'],
                packageJson,
                repoRoot
            );
        });

        const workflowConfig = JSON.parse(fs.readFileSync(workflowConfigPath, 'utf8'));
        assert.equal(workflowConfig.project_memory_maintenance.enabled, true);
        assert.equal(workflowConfig.project_memory_maintenance.mode, 'update');

        const initReport = readInitReport(workspaceRoot);
        const refreshText = refreshOutput.join('\n');
        assert.ok(refreshText.includes(`WorkflowConfigMerge: existing_values_preserved_and_missing_keys_filled path=${DEFAULT_BUNDLE_NAME}/live/config/workflow-config.json full_suite_validation.enabled=true project_memory_maintenance.enabled=true project_memory_maintenance.mode=update`));
        assert.ok(!refreshText.includes('ProjectMemoryMaintenance: Project memory maintenance: update read_strategy=index_first'));
        assert.ok(initReport.includes('Workflow config merge status: existing_values_preserved_and_missing_keys_filled'));
        assert.ok(initReport.includes('project_memory_maintenance.mode=update'));
    } finally {
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
});

test('handleSetup migrates exact legacy scope-budget guard default during refresh', async (context) => {
    const repoRoot = createBundleSourceFixture(context);
    const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-setup-scope-budget-legacy-default-'));
    const workflowConfigPath = path.join(workspaceRoot, DEFAULT_BUNDLE_NAME, 'live', 'config', 'workflow-config.json');

    try {
        fs.mkdirSync(path.join(workspaceRoot, '.git'), { recursive: true });

        await handleSetup(
            ['--target-root', workspaceRoot, '--no-prompt', '--skip-verify', '--skip-manifest-validation', '--source-of-truth', 'Codex'],
            packageJson,
            repoRoot
        );

        fs.writeFileSync(
            workflowConfigPath,
            JSON.stringify({
                full_suite_validation: {
                    enabled: true,
                    command: 'npm run test:full',
                    timeout_ms: 123456,
                    green_summary_max_lines: 7,
                    red_failure_chunk_lines: 42,
                    out_of_scope_failure_policy: 'AUDIT_AND_WARN'
                },
                scope_budget_guard: {
                    enabled: true,
                    profiles: ['strict'],
                    action: 'BLOCK_FOR_SPLIT',
                    max_files: 12,
                    max_changed_lines: 1200,
                    max_required_reviews: 5,
                    max_review_tokens: 50000
                }
            }, null, 2),
            'utf8'
        );

        await captureConsoleLogs(async () => {
            await handleSetup(
                ['--target-root', workspaceRoot, '--no-prompt', '--skip-verify', '--skip-manifest-validation', '--preserve-agent-state'],
                packageJson,
                repoRoot
            );
        });

        const workflowConfig = JSON.parse(fs.readFileSync(workflowConfigPath, 'utf8'));
        assert.equal(workflowConfig.scope_budget_guard.action, 'WARN_ONLY');
        assert.equal(workflowConfig.scope_budget_guard.max_files, 20);
        assert.equal(workflowConfig.scope_budget_guard.max_changed_lines, 2000);
        assert.equal(workflowConfig.scope_budget_guard.warn_changed_lines, 2000);
        assert.equal(workflowConfig.scope_budget_guard.block_changed_lines, 5000);
        assert.equal(workflowConfig.scope_budget_guard.max_required_reviews, 5);
    } finally {
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
});

test('handleSetup preserves custom scope-budget guard settings during refresh', async (context) => {
    const repoRoot = createBundleSourceFixture(context);
    const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-setup-scope-budget-custom-'));
    const workflowConfigPath = path.join(workspaceRoot, DEFAULT_BUNDLE_NAME, 'live', 'config', 'workflow-config.json');

    try {
        fs.mkdirSync(path.join(workspaceRoot, '.git'), { recursive: true });

        await handleSetup(
            ['--target-root', workspaceRoot, '--no-prompt', '--skip-verify', '--skip-manifest-validation', '--source-of-truth', 'Codex'],
            packageJson,
            repoRoot
        );

        fs.writeFileSync(
            workflowConfigPath,
            JSON.stringify({
                full_suite_validation: {
                    enabled: true,
                    command: 'npm run test:full',
                    timeout_ms: 123456,
                    green_summary_max_lines: 7,
                    red_failure_chunk_lines: 42,
                    out_of_scope_failure_policy: 'AUDIT_AND_WARN'
                },
                scope_budget_guard: {
                    enabled: true,
                    profiles: ['strict', 'balanced'],
                    action: 'BLOCK_FOR_SPLIT',
                    max_files: 7,
                    max_changed_lines: 300,
                    max_required_reviews: 3,
                    max_review_tokens: 5000
                }
            }, null, 2),
            'utf8'
        );

        await captureConsoleLogs(async () => {
            await handleSetup(
                ['--target-root', workspaceRoot, '--no-prompt', '--skip-verify', '--skip-manifest-validation', '--preserve-agent-state'],
                packageJson,
                repoRoot
            );
        });

        const workflowConfig = JSON.parse(fs.readFileSync(workflowConfigPath, 'utf8'));
        assert.deepEqual(workflowConfig.scope_budget_guard, {
            enabled: true,
            profiles: ['strict', 'balanced'],
            action: 'BLOCK_FOR_SPLIT',
            max_files: 7,
            max_changed_lines: 300,
            max_required_reviews: 3,
            max_review_tokens: 5000,
            warn_files: 6,
            block_files: 7,
            warn_changed_lines: 299,
            block_changed_lines: 300,
            warn_required_reviews: 2,
            block_required_reviews: 3,
            warn_review_tokens: 4999,
            block_review_tokens: 5000
        });
    } finally {
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
});

test('handleSetup preserves disabled scope-budget guard settings during refresh', async (context) => {
    const repoRoot = createBundleSourceFixture(context);
    const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-setup-scope-budget-disabled-'));
    const workflowConfigPath = path.join(workspaceRoot, DEFAULT_BUNDLE_NAME, 'live', 'config', 'workflow-config.json');

    try {
        fs.mkdirSync(path.join(workspaceRoot, '.git'), { recursive: true });

        await handleSetup(
            ['--target-root', workspaceRoot, '--no-prompt', '--skip-verify', '--skip-manifest-validation', '--source-of-truth', 'Codex'],
            packageJson,
            repoRoot
        );

        fs.writeFileSync(
            workflowConfigPath,
            JSON.stringify({
                full_suite_validation: {
                    enabled: true,
                    command: 'npm run test:full',
                    timeout_ms: 123456,
                    green_summary_max_lines: 7,
                    red_failure_chunk_lines: 42,
                    out_of_scope_failure_policy: 'AUDIT_AND_WARN'
                },
                scope_budget_guard: {
                    enabled: false,
                    profiles: ['strict'],
                    action: 'BLOCK_FOR_SPLIT',
                    max_files: 12,
                    max_changed_lines: 1200,
                    max_required_reviews: 5,
                    max_review_tokens: 50000
                }
            }, null, 2),
            'utf8'
        );

        await captureConsoleLogs(async () => {
            await handleSetup(
                ['--target-root', workspaceRoot, '--no-prompt', '--skip-verify', '--skip-manifest-validation', '--preserve-agent-state'],
                packageJson,
                repoRoot
            );
        });

        const workflowConfig = JSON.parse(fs.readFileSync(workflowConfigPath, 'utf8'));
        assert.deepEqual(workflowConfig.scope_budget_guard, {
            enabled: false,
            profiles: ['strict'],
            action: 'BLOCK_FOR_SPLIT',
            max_files: 12,
            max_changed_lines: 1200,
            max_required_reviews: 5,
            max_review_tokens: 50000,
            warn_files: 11,
            block_files: 12,
            warn_changed_lines: 1199,
            block_changed_lines: 1200,
            warn_required_reviews: 4,
            block_required_reviews: 5,
            warn_review_tokens: 49999,
            block_review_tokens: 50000
        });
    } finally {
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
});

test('handleSetup migrates exact legacy review-cycle guard default during refresh', async (context) => {
    const repoRoot = createBundleSourceFixture(context);
    const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-setup-review-cycle-legacy-default-'));
    const workflowConfigPath = path.join(workspaceRoot, DEFAULT_BUNDLE_NAME, 'live', 'config', 'workflow-config.json');

    try {
        fs.mkdirSync(path.join(workspaceRoot, '.git'), { recursive: true });

        await handleSetup(
            ['--target-root', workspaceRoot, '--no-prompt', '--skip-verify', '--skip-manifest-validation', '--source-of-truth', 'Codex'],
            packageJson,
            repoRoot
        );

        fs.writeFileSync(
            workflowConfigPath,
            JSON.stringify({
                full_suite_validation: {
                    enabled: true,
                    command: 'npm run test:full',
                    timeout_ms: 123456,
                    green_summary_max_lines: 7,
                    red_failure_chunk_lines: 42,
                    out_of_scope_failure_policy: 'AUDIT_AND_WARN'
                },
                review_cycle_guard: {
                    enabled: true,
                    action: 'BLOCK_FOR_OPERATOR_DECISION',
                    max_failed_non_test_reviews: 15,
                    max_total_non_test_reviews: 15,
                    excluded_review_types: ['test'],
                    auto_split_enabled: false
                }
            }, null, 2),
            'utf8'
        );

        const refreshOutput = await captureConsoleLogs(async () => {
            await handleSetup(
                ['--target-root', workspaceRoot, '--no-prompt', '--skip-verify', '--skip-manifest-validation', '--preserve-agent-state'],
                packageJson,
                repoRoot
            );
        });

        const workflowConfig = JSON.parse(fs.readFileSync(workflowConfigPath, 'utf8'));
        assert.equal(workflowConfig.review_cycle_guard.max_failed_non_test_reviews, 10);
        assert.equal(workflowConfig.review_cycle_guard.max_total_non_test_reviews, 30);
        assert.equal(workflowConfig.review_cycle_guard.auto_split_enabled, true);

        const initReport = readInitReport(workspaceRoot);
        const refreshText = refreshOutput.join('\n');
        assert.ok(refreshText.includes('review_cycle_guard.max_failed_non_test_reviews=10 review_cycle_guard.max_total_non_test_reviews=30 review_cycle_guard.limit_status=migrated_from_old_default'));
        assert.ok(initReport.includes('review_cycle_guard.max_failed_non_test_reviews=10'));
        assert.ok(initReport.includes('review_cycle_guard.max_total_non_test_reviews=30'));
        assert.ok(initReport.includes('review_cycle_guard.limit_status=migrated_from_old_default'));
    } finally {
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
});

test('handleSetup preserves custom review-cycle guard limits during refresh', async (context) => {
    const repoRoot = createBundleSourceFixture(context);
    const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-setup-review-cycle-custom-'));
    const workflowConfigPath = path.join(workspaceRoot, DEFAULT_BUNDLE_NAME, 'live', 'config', 'workflow-config.json');

    try {
        fs.mkdirSync(path.join(workspaceRoot, '.git'), { recursive: true });

        await handleSetup(
            ['--target-root', workspaceRoot, '--no-prompt', '--skip-verify', '--skip-manifest-validation', '--source-of-truth', 'Codex'],
            packageJson,
            repoRoot
        );

        fs.writeFileSync(
            workflowConfigPath,
            JSON.stringify({
                full_suite_validation: {
                    enabled: true,
                    command: 'npm run test:full',
                    timeout_ms: 123456,
                    green_summary_max_lines: 7,
                    red_failure_chunk_lines: 42,
                    out_of_scope_failure_policy: 'AUDIT_AND_WARN'
                },
                review_cycle_guard: {
                    enabled: true,
                    action: 'BLOCK_FOR_OPERATOR_DECISION',
                    max_failed_non_test_reviews: 12,
                    max_total_non_test_reviews: 15,
                    excluded_review_types: ['test'],
                    auto_split_enabled: true
                }
            }, null, 2),
            'utf8'
        );

        const refreshOutput = await captureConsoleLogs(async () => {
            await handleSetup(
                ['--target-root', workspaceRoot, '--no-prompt', '--skip-verify', '--skip-manifest-validation', '--preserve-agent-state'],
                packageJson,
                repoRoot
            );
        });

        const workflowConfig = JSON.parse(fs.readFileSync(workflowConfigPath, 'utf8'));
        assert.equal(workflowConfig.review_cycle_guard.max_failed_non_test_reviews, 12);
        assert.equal(workflowConfig.review_cycle_guard.max_total_non_test_reviews, 15);
        assert.equal(workflowConfig.review_cycle_guard.auto_split_enabled, true);

        const initReport = readInitReport(workspaceRoot);
        const refreshText = refreshOutput.join('\n');
        assert.ok(refreshText.includes('review_cycle_guard.max_failed_non_test_reviews=12 review_cycle_guard.max_total_non_test_reviews=15 review_cycle_guard.limit_status=custom_preserved'));
        assert.ok(initReport.includes('review_cycle_guard.max_failed_non_test_reviews=12'));
        assert.ok(initReport.includes('review_cycle_guard.max_total_non_test_reviews=15'));
        assert.ok(initReport.includes('review_cycle_guard.limit_status=custom_preserved'));
    } finally {
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
});

test('handleSetup reports workflow-config template fallback when preserved refresh finds a missing live config', async (context) => {
    const repoRoot = createBundleSourceFixture(context);
    const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-setup-workflow-config-missing-diagnostic-'));
    const workflowConfigPath = path.join(workspaceRoot, DEFAULT_BUNDLE_NAME, 'live', 'config', 'workflow-config.json');

    try {
        fs.mkdirSync(path.join(workspaceRoot, '.git'), { recursive: true });

        await captureConsoleLogs(async () => {
            await handleSetup(
                ['--target-root', workspaceRoot, '--no-prompt', '--skip-verify', '--skip-manifest-validation', '--source-of-truth', 'Codex'],
                packageJson,
                repoRoot
            );
        });

        fs.rmSync(workflowConfigPath, { force: true });

        const refreshOutput = await captureConsoleLogs(async () => {
            await handleSetup(
                ['--target-root', workspaceRoot, '--no-prompt', '--skip-verify', '--skip-manifest-validation', '--preserve-agent-state'],
                packageJson,
                repoRoot
            );
        });

        const workflowConfig = JSON.parse(fs.readFileSync(workflowConfigPath, 'utf8'));
        assert.equal(workflowConfig.full_suite_validation.enabled, false);
        assert.equal(workflowConfig.review_cycle_guard.max_failed_non_test_reviews, 10);
        assert.equal(workflowConfig.review_cycle_guard.max_total_non_test_reviews, 30);
        const initReport = readInitReport(workspaceRoot);
        const refreshText = refreshOutput.join('\n');
        assert.ok(refreshText.includes(`WorkflowConfigMerge: live_config_missing_template_applied path=${DEFAULT_BUNDLE_NAME}/live/config/workflow-config.json full_suite_validation.enabled=false`));
        assert.ok(refreshText.includes('review_cycle_guard.max_failed_non_test_reviews=10 review_cycle_guard.max_total_non_test_reviews=30 review_cycle_guard.limit_status=template_default_applied'));
        assert.ok(initReport.includes('Workflow config merge status: live_config_missing_template_applied'));
        assert.ok(initReport.includes(`path=${DEFAULT_BUNDLE_NAME}/live/config/workflow-config.json`));
        assert.ok(initReport.includes('full_suite_validation.enabled=false'));
    } finally {
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
});

test('handleSetup reports workflow-config template fallback when preserved refresh finds invalid JSON', async (context) => {
    const repoRoot = createBundleSourceFixture(context);
    const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-setup-workflow-config-invalid-diagnostic-'));
    const workflowConfigPath = path.join(workspaceRoot, DEFAULT_BUNDLE_NAME, 'live', 'config', 'workflow-config.json');

    try {
        fs.mkdirSync(path.join(workspaceRoot, '.git'), { recursive: true });

        await captureConsoleLogs(async () => {
            await handleSetup(
                ['--target-root', workspaceRoot, '--no-prompt', '--skip-verify', '--skip-manifest-validation', '--source-of-truth', 'Codex'],
                packageJson,
                repoRoot
            );
        });

        fs.writeFileSync(workflowConfigPath, '{"full_suite_validation":', 'utf8');

        const refreshOutput = await captureConsoleLogs(async () => {
            await handleSetup(
                ['--target-root', workspaceRoot, '--no-prompt', '--skip-verify', '--skip-manifest-validation', '--preserve-agent-state'],
                packageJson,
                repoRoot
            );
        });

        const workflowConfig = JSON.parse(fs.readFileSync(workflowConfigPath, 'utf8'));
        assert.equal(workflowConfig.full_suite_validation.enabled, false);
        const initReport = readInitReport(workspaceRoot);
        const refreshText = refreshOutput.join('\n');
        assert.ok(refreshText.includes(`WorkflowConfigMerge: live_config_invalid_json_template_applied path=${DEFAULT_BUNDLE_NAME}/live/config/workflow-config.json full_suite_validation.enabled=false`));
        assert.ok(initReport.includes('Workflow config merge status: live_config_invalid_json_template_applied'));
        assert.ok(initReport.includes(`path=${DEFAULT_BUNDLE_NAME}/live/config/workflow-config.json`));
        assert.ok(initReport.includes('full_suite_validation.enabled=false'));
    } finally {
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
});

test('handleSetup reports workflow-config template fallback when preserved refresh finds a non-object config', async (context) => {
    const repoRoot = createBundleSourceFixture(context);
    const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-setup-workflow-config-non-object-diagnostic-'));
    const workflowConfigPath = path.join(workspaceRoot, DEFAULT_BUNDLE_NAME, 'live', 'config', 'workflow-config.json');

    try {
        fs.mkdirSync(path.join(workspaceRoot, '.git'), { recursive: true });

        await captureConsoleLogs(async () => {
            await handleSetup(
                ['--target-root', workspaceRoot, '--no-prompt', '--skip-verify', '--skip-manifest-validation', '--source-of-truth', 'Codex'],
                packageJson,
                repoRoot
            );
        });

        fs.writeFileSync(workflowConfigPath, '[]', 'utf8');

        const refreshOutput = await captureConsoleLogs(async () => {
            await handleSetup(
                ['--target-root', workspaceRoot, '--no-prompt', '--skip-verify', '--skip-manifest-validation', '--preserve-agent-state'],
                packageJson,
                repoRoot
            );
        });

        const workflowConfig = JSON.parse(fs.readFileSync(workflowConfigPath, 'utf8'));
        assert.equal(workflowConfig.full_suite_validation.enabled, false);
        const initReport = readInitReport(workspaceRoot);
        const refreshText = refreshOutput.join('\n');
        assert.ok(refreshText.includes(`WorkflowConfigMerge: live_config_non_object_template_applied path=${DEFAULT_BUNDLE_NAME}/live/config/workflow-config.json full_suite_validation.enabled=false`));
        assert.ok(initReport.includes('Workflow config merge status: live_config_non_object_template_applied'));
        assert.ok(initReport.includes(`path=${DEFAULT_BUNDLE_NAME}/live/config/workflow-config.json`));
        assert.ok(initReport.includes('full_suite_validation.enabled=false'));
    } finally {
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
});

test('handleSetup materializes strict_sequential review_execution_policy for a fresh workspace', async (context) => {
    const repoRoot = createBundleSourceFixture(context);
    const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-setup-workflow-config-fresh-default-'));
    const workflowConfigPath = path.join(workspaceRoot, DEFAULT_BUNDLE_NAME, 'live', 'config', 'workflow-config.json');

    try {
        fs.mkdirSync(path.join(workspaceRoot, '.git'), { recursive: true });

        await handleSetup(
            ['--target-root', workspaceRoot, '--no-prompt', '--skip-verify', '--skip-manifest-validation', '--source-of-truth', 'Codex'],
            packageJson,
            repoRoot
        );

        const workflowConfig = JSON.parse(fs.readFileSync(workflowConfigPath, 'utf8'));
        assert.deepEqual(workflowConfig.review_execution_policy, {
            mode: 'strict_sequential'
        });
        assert.equal(workflowConfig.compile_gate.command, UNCONFIGURED_COMPILE_GATE_COMMAND);
        assert.equal(workflowConfig.scope_budget_guard.action, 'WARN_ONLY');
        assert.equal(workflowConfig.scope_budget_guard.max_files, 20);
        assert.equal(workflowConfig.scope_budget_guard.max_changed_lines, 2000);
        assert.equal(workflowConfig.scope_budget_guard.warn_changed_lines, 2000);
        assert.equal(workflowConfig.scope_budget_guard.block_changed_lines, 5000);
        assert.equal(workflowConfig.scope_budget_guard.max_required_reviews, 5);
        assert.equal(workflowConfig.review_cycle_guard.max_failed_non_test_reviews, 10);
        assert.equal(workflowConfig.review_cycle_guard.max_total_non_test_reviews, 30);
        assert.equal(workflowConfig.review_cycle_guard.auto_split_enabled, true);
        assert.equal(workflowConfig.optional_quality_checks.enabled, true);
        assert.equal(workflowConfig.optional_quality_checks.baseline_version, OPTIONAL_QUALITY_CHECKS_BASELINE_VERSION);
        assert.deepEqual(
            workflowConfig.optional_quality_checks.rules.map((rule: { id: string }) => rule.id),
            DEFAULT_OPTIONAL_QUALITY_CHECK_RULES.map((rule) => rule.id)
        );
    } finally {
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
});

test('handleSetup prints optional quality checks notice once when workflow config is seeded', async (context) => {
    const repoRoot = createBundleSourceFixture(context);
    const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-setup-optional-checks-notice-'));

    try {
        fs.mkdirSync(path.join(workspaceRoot, '.git'), { recursive: true });

        const firstOutput = await captureConsoleLogs(async () => {
            await handleSetup(
                ['--target-root', workspaceRoot, '--no-prompt', '--skip-verify', '--skip-manifest-validation', '--source-of-truth', 'Codex'],
                packageJson,
                repoRoot
            );
        });
        assert.equal(firstOutput.includes(OPTIONAL_QUALITY_CHECKS_ENABLED_NOTICE), true);

        const refreshOutput = await captureConsoleLogs(async () => {
            await handleSetup(
                ['--target-root', workspaceRoot, '--no-prompt', '--skip-verify', '--skip-manifest-validation', '--preserve-agent-state'],
                packageJson,
                repoRoot
            );
        });
        assert.equal(refreshOutput.includes(OPTIONAL_QUALITY_CHECKS_ENABLED_NOTICE), false);
    } finally {
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
});

test('handleSetup preserves custom optional quality check rules across refreshes', async (context) => {
    const repoRoot = createBundleSourceFixture(context);
    const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-setup-optional-checks-refresh-'));
    const workflowConfigPath = path.join(workspaceRoot, DEFAULT_BUNDLE_NAME, 'live', 'config', 'workflow-config.json');

    try {
        fs.mkdirSync(path.join(workspaceRoot, '.git'), { recursive: true });

        await handleSetup(
            ['--target-root', workspaceRoot, '--no-prompt', '--skip-verify', '--skip-manifest-validation', '--source-of-truth', 'Codex'],
            packageJson,
            repoRoot
        );

        const customRule = {
            id: 'custom_quality_rule',
            title: 'Custom quality rule',
            prompt: 'Check the local custom quality rule.',
            enabled: true
        };
        const workflowConfig = JSON.parse(fs.readFileSync(workflowConfigPath, 'utf8'));
        const installedOptionalQualityChecks = workflowConfig.optional_quality_checks;
        workflowConfig.optional_quality_checks = {
            enabled: false,
            rules: [customRule]
        };
        fs.writeFileSync(workflowConfigPath, JSON.stringify(workflowConfig, null, 2), 'utf8');

        const refreshOutput = await captureConsoleLogs(async () => {
            await handleSetup(
                ['--target-root', workspaceRoot, '--no-prompt', '--skip-verify', '--skip-manifest-validation', '--preserve-agent-state'],
                packageJson,
                repoRoot
            );
        });

        const refreshedConfig = JSON.parse(fs.readFileSync(workflowConfigPath, 'utf8'));
        assert.deepEqual(refreshedConfig.optional_quality_checks, {
            enabled: false,
            baseline_version: installedOptionalQualityChecks.baseline_version,
            review_failure_cadence_interval:
                installedOptionalQualityChecks.review_failure_cadence_interval,
            rules: [
                customRule,
                ...installedOptionalQualityChecks.rules
            ]
        });
        assert.equal(refreshOutput.includes(OPTIONAL_QUALITY_CHECKS_ENABLED_NOTICE), false);
    } finally {
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
});

test('handleSetup preserves legacy workflow-config omission for review_execution_policy across repeated refreshes', async (context) => {
    const repoRoot = createBundleSourceFixture(context);
    const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-setup-workflow-config-legacy-compat-'));
    const workflowConfigPath = path.join(workspaceRoot, DEFAULT_BUNDLE_NAME, 'live', 'config', 'workflow-config.json');

    try {
        fs.mkdirSync(path.join(workspaceRoot, '.git'), { recursive: true });

        await handleSetup(
            ['--target-root', workspaceRoot, '--no-prompt', '--skip-verify', '--skip-manifest-validation', '--source-of-truth', 'Codex'],
            packageJson,
            repoRoot
        );

        fs.writeFileSync(
            workflowConfigPath,
            JSON.stringify({
                full_suite_validation: {
                    enabled: true,
                    command: 'npm run test:full',
                    timeout_ms: 123456,
                    green_summary_max_lines: 7,
                    red_failure_chunk_lines: 42,
                    out_of_scope_failure_policy: 'AUDIT_AND_WARN'
                }
            }, null, 2),
            'utf8'
        );

        await handleSetup(
            ['--target-root', workspaceRoot, '--no-prompt', '--skip-verify', '--skip-manifest-validation', '--preserve-agent-state'],
            packageJson,
            repoRoot
        );

        const workflowConfig = JSON.parse(fs.readFileSync(workflowConfigPath, 'utf8'));
        assert.deepEqual(workflowConfig.full_suite_validation, {
            enabled: true,
            command: 'npm run test:full',
            timeout_ms: 123456,
            green_summary_max_lines: 7,
            red_failure_chunk_lines: 42,
            timeout_blocker: true,
            timeout_retry_count: 1,
            out_of_scope_failure_policy: 'AUDIT_AND_WARN',
            placement: 'after_compile_before_reviews'
        });
        assert.equal(Object.prototype.hasOwnProperty.call(workflowConfig, 'review_execution_policy'), false);
    } finally {
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
});

test('buildSetupHandoffText includes agent initialization section', () => {
    const snapshot = {
        bundlePath: '/workspace/garda-agent-orchestrator',
        activeAgentFiles: 'CLAUDE.md, AGENTS.md'
    };
    const text = stripAnsi(buildSetupHandoffText(snapshot as unknown as StatusSnapshot));
    assert.ok(text.includes('GARDA_AGENT_REPORT'));
    assert.ok(text.includes('Agent Initialization'));
    assert.ok(text.includes('Primary setup is complete'));
    assert.ok(text.includes('Next stage: launch your agent'));
    assert.ok(text.includes('CLAUDE.md, AGENTS.md'));
    assert.ok(text.includes('AGENT_INIT_PROMPT.md'));
    assert.ok(text.includes('Execute task <task-id> from TASK.md strictly through the orchestrator.'));
    assert.ok(text.includes('Use `next-step` as the navigator'));
    assert.ok(text.includes('launch a sub-agent using your internal tools'));
    assert.ok(text.includes('profile current|list|use|create'));
    assert.ok(!text.includes('start marker'));
    assert.ok(!text.includes('Garda captures my mind'));
    assert.ok(!text.includes('Mandatory orchestrator flow:'));
    assert.ok(!text.includes('Project memory maintenance: update read_strategy=index_first'));
    assert.ok(!text.includes(`Project memory init/refresh prompt: ${PROJECT_MEMORY_INIT_REFRESH_PROMPT}`));
    assert.ok(text.includes('RecommendedUiCommand: garda ui --actions'));
    assert.ok(text.includes('guarded allow-listed settings'));
    assert.match(text.trimEnd(), /RecommendedNextCommand: Give your agent ".*AGENT_INIT_PROMPT\.md" and complete the agent-init flow, then run .* agent-init --target-root ".*"$/);
});

test('buildSetupHandoffText quotes target root in recommended agent-init command', () => {
    const targetRoot = 'C:\\workspace\\project $(Invoke-Expression bad) `tick` \'single\' "double"';
    const text = stripAnsi(buildSetupHandoffText({
        bundlePath: path.join(targetRoot, 'garda-agent-orchestrator'),
        activeAgentFiles: 'AGENTS.md'
    } as unknown as StatusSnapshot));
    const quotedTargetRoot = quoteCommandValue(targetRoot);

    assert.ok(text.includes(`agent-init --target-root ${quotedTargetRoot}`));
    assert.ok(!text.includes(`agent-init --target-root "${targetRoot}"`));
});

test('buildSetupHandoffText renders scannable plain human sections', () => {
    const text = withColorEnv({ NO_COLOR: undefined, FORCE_COLOR: undefined }, () => buildSetupHandoffText({
        bundlePath: '/workspace/garda-agent-orchestrator',
        activeAgentFiles: 'AGENTS.md',
        assistantLanguage: 'English',
        assistantLanguageConfirmed: true,
        mandatoryFullSuiteEnabled: true
    } as unknown as StatusSnapshot));

    assert.equal(hasAnsi(text), false);
    assert.ok(text.includes('GARDA_AGENT_REPORT'));
    assert.ok(text.includes('Agent Initialization'));
    assert.ok(text.includes('First Task Command'));
    assert.ok(text.includes('Active Profile'));
    assert.ok(text.includes('Workspace UI'));
    assert.ok(!text.includes('Mandatory Flow'));
    assert.ok(!text.includes('Project Memory Refresh'));
    assert.ok(text.includes('Give your agent:'));
    assert.ok(text.includes('AGENT_INIT_PROMPT.md"'));
    assert.ok(text.includes('Execute task <task-id> from TASK.md strictly through the orchestrator.'));
    assert.ok(text.includes('next-step "<task-id>"'));
    assert.match(text.trimEnd(), /and complete the agent-init flow, then run .* agent-init --target-root ".*"$/);
});

test('buildSetupHandoffText colors human setup handoff when FORCE_COLOR is set', () => {
    const text = withColorEnv({ NO_COLOR: undefined, FORCE_COLOR: '1' }, () => buildSetupHandoffText({
        bundlePath: '/workspace/garda-agent-orchestrator',
        activeAgentFiles: 'AGENTS.md',
        assistantLanguage: 'English',
        assistantLanguageConfirmed: true,
        mandatoryFullSuiteEnabled: true
    } as unknown as StatusSnapshot));

    assert.equal(hasAnsi(text), true);
    assert.ok(text.includes('\u001b[36mAgent Initialization\u001b[0m'));
    assert.ok(text.includes('\u001b[32mPrimary setup is complete.\u001b[0m'));
    assert.ok(text.includes('\u001b[33mNext stage: launch your agent and give it the init prompt.\u001b[0m'));
    assert.ok(text.includes('Execute task <task-id> from TASK.md strictly through the orchestrator.'));
    assert.ok(text.includes('AGENT_INIT_PROMPT.md"'));
});

test('buildSetupHandoffText honors NO_COLOR over FORCE_COLOR', () => {
    const text = withColorEnv({ NO_COLOR: '1', FORCE_COLOR: '1' }, () => buildSetupHandoffText({
        bundlePath: '/workspace/garda-agent-orchestrator',
        activeAgentFiles: 'AGENTS.md',
        assistantLanguage: 'English',
        assistantLanguageConfirmed: true,
        mandatoryFullSuiteEnabled: true
    } as unknown as StatusSnapshot));
    const normalizedText = stripAnsi(text);

    assert.equal(hasAnsi(text), false);
    assert.ok(normalizedText.includes('Primary setup is complete.'));
    assert.ok(normalizedText.includes('Next stage: launch your agent and give it the init prompt.'));
    assert.ok(!normalizedText.includes(`Project memory init/refresh prompt: ${PROJECT_MEMORY_INIT_REFRESH_PROMPT}`));
    assert.ok(normalizedText.includes('RecommendedNextCommand: Give your agent'));
});

test('buildSetupHandoffText renders compact report labels in English while preserving assistant language', () => {
    const snapshot = {
        bundlePath: '/workspace/garda-agent-orchestrator',
        activeAgentFiles: 'AGENTS.md',
        assistantLanguage: 'Russian',
        assistantLanguageConfirmed: false,
        mandatoryFullSuiteEnabled: true,
        latestUpdateNotice: '1.2.3'
    };
    const text = buildSetupHandoffText(snapshot as unknown as StatusSnapshot);
    assert.ok(text.includes('Setup handoff'));
    assert.ok(text.includes('Language: Russian (pending confirmation)'));
    assert.ok(text.includes('Mandatory full-suite: enabled'));
    assert.ok(text.includes('Latest update notice: 1.2.3'));
});

test('buildSetupHandoffText does not infer a locale from German assistant language', () => {
    const snapshot = {
        bundlePath: '/workspace/garda-agent-orchestrator',
        activeAgentFiles: 'AGENTS.md',
        assistantLanguage: 'Deutsch',
        assistantLanguageConfirmed: true,
        mandatoryFullSuiteEnabled: false,
        latestUpdateNotice: '1.2.3'
    };
    const text = buildSetupHandoffText(snapshot as unknown as StatusSnapshot);
    assert.ok(text.includes('Setup handoff'));
    assert.ok(text.includes('Language: Deutsch (normalized)'));
    assert.ok(text.includes('Review mode: mandatory orchestrator gates'));
    assert.ok(text.includes('Optional skills: ask during AGENT_INIT_PROMPT'));
    assert.ok(text.includes('Mandatory full-suite: disabled'));
    assert.ok(text.includes('Latest update notice: 1.2.3'));
});

test('buildSetupHandoffText reports the active profile and profile commands', () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-handoff-profile-'));
    try {
        const bundlePath = path.join(workspace, 'garda-agent-orchestrator');
        const profilesPath = path.join(bundlePath, 'live', 'config', 'profiles.json');
        fs.mkdirSync(path.dirname(profilesPath), { recursive: true });
        fs.writeFileSync(
            profilesPath,
            JSON.stringify({
                version: 1,
                active_profile: 'strict',
                built_in_profiles: {
                    strict: {
                        description: 'Strict profile',
                        depth: 3,
                        review_policy: {},
                        token_economy: {
                            enabled: true,
                            strip_examples: true,
                            strip_code_blocks: true,
                            scoped_diffs: true,
                            compact_reviewer_output: true
                        },
                        skills: {}
                    }
                },
                user_profiles: {}
            }, null, 2),
            'utf8'
        );

        const text = buildSetupHandoffText({
            bundlePath,
            activeAgentFiles: 'CLAUDE.md'
        } as unknown as StatusSnapshot);
        assert.ok(text.includes('Current active profile: strict.'));
        assert.ok(text.includes('node garda-agent-orchestrator/bin/garda.js profile current|list|use|create --target-root "."'));
        assert.ok(!text.includes('default depth=3'));
    } finally {
        fs.rmSync(workspace, { recursive: true, force: true });
    }
});

test('buildSetupHandoffText omits active agent files when null', () => {
    const snapshot = {
        bundlePath: '/workspace/garda-agent-orchestrator',
        activeAgentFiles: null
    };
    const text = buildSetupHandoffText(snapshot as unknown as StatusSnapshot);
    assert.ok(!text.includes('Active agent files'));
    assert.ok(text.includes('Agent Initialization'));
});

test('buildSetupStepsText includes step markers for interactive', () => {
    const text = buildSetupStepsText('/workspace', true, true);
    assert.ok(text.includes('You will be asked 6 control questions'));
    assert.ok(text.includes('[1/3] Deploy bundle'));
    assert.ok(text.includes('[2/3] Collect or reuse init answers'));
    assert.ok(text.includes('[3/3] Run install and prepare agent handoff'));
});

test('buildSetupStepsText shows non-interactive message for no-prompt', () => {
    const text = buildSetupStepsText('/workspace', false, false);
    assert.ok(text.includes('Running in non-interactive mode'));
});

test('buildSetupStepsText shows fallback message for non-TTY interactive', () => {
    const text = buildSetupStepsText('/workspace', false, true);
    assert.ok(text.includes('Interactive prompts are unavailable'));
});

test('buildSetupStepsText includes project path', () => {
    const text = buildSetupStepsText('/workspace', true, true);
    assert.ok(text.includes('Project: /workspace'));
});

test('buildSetupStepsText includes bundle path', () => {
    const text = buildSetupStepsText('/workspace', true, true);
    assert.ok(text.includes('BundlePath:'));
});
