import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { runInstall } from '../../../src/materialization/install';
import { runInit } from '../../../src/materialization/init';
import {
    findRepoRoot,
    setupTestWorkspace,
    writeInitAnswers
} from './install-workspace-builder';

describe('runInstall — preserve/update semantics and IDE settings', () => {
    const repoRoot = findRepoRoot();

    function assertFinalReportGuidance(bundleRoot: string) {
        for (const relativePath of [
            'docs/agent-rules/80-task-workflow.md',
            'skills/orchestration/SKILL.md',
            'skills/orchestration-depth1/SKILL.md'
        ]) {
            const content = fs.readFileSync(path.join(bundleRoot, 'live', relativePath), 'utf8');
            assert.ok(content.includes('Do not add an agent-authored output-compaction line'), relativePath);
            assert.ok(content.includes('diagnostic/statistics telemetry remain active'), relativePath);
            assert.ok(!content.includes('Suppressed output:'), relativePath);
            assert.ok(!content.includes('savings are reported in the implementation summary'), relativePath);
        }
    }

    it('preserves pre-existing extra root entrypoints when ActiveAgentFiles is narrower', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        try {
            const answersPath = writeInitAnswers(bundleRoot, {
                AssistantLanguage: 'English',
                AssistantBrevity: 'concise',
                SourceOfTruth: 'Claude',
                EnforceNoAutoCommit: 'false',
                ClaudeOrchestratorFullAccess: 'false',
                TokenEconomyEnabled: 'true',
                CollectedVia: 'CLI_NONINTERACTIVE',
                ActiveAgentFiles: 'CLAUDE.md, AGENTS.md, GEMINI.md'
            });

            runInstall({
                targetRoot: projectRoot,
                bundleRoot,
                runInit: true,
                initRunner: (options) => { runInit({ ...options, bundleRoot, lifecycleLockAlreadyHeld: true }); },
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Claude',
                initAnswersPath: answersPath
            });

            assert.ok(fs.existsSync(path.join(projectRoot, 'GEMINI.md')), 'GEMINI.md should exist after first install');
            assertFinalReportGuidance(bundleRoot);

            const answersPath2 = writeInitAnswers(bundleRoot, {
                AssistantLanguage: 'English',
                AssistantBrevity: 'concise',
                SourceOfTruth: 'Claude',
                EnforceNoAutoCommit: 'false',
                ClaudeOrchestratorFullAccess: 'false',
                TokenEconomyEnabled: 'true',
                ProviderMinimalism: 'false',
                CollectedVia: 'CLI_NONINTERACTIVE',
                ActiveAgentFiles: 'CLAUDE.md, AGENTS.md'
            });

            const result = runInstall({
                targetRoot: projectRoot,
                bundleRoot,
                preserveExisting: true,
                alignExisting: true,
                runInit: true,
                initRunner: (options) => { runInit({ ...options, bundleRoot, lifecycleLockAlreadyHeld: true }); },
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Claude',
                initAnswersPath: answersPath2
            });

            assert.ok(fs.existsSync(path.join(projectRoot, 'GEMINI.md')),
                'GEMINI.md must be preserved after update with narrower ActiveAgentFiles');
            assert.equal(result.filesPreserved, 1, 'filesPreserved should count exactly 1 for GEMINI.md');
            const geminiContent = fs.readFileSync(path.join(projectRoot, 'GEMINI.md'), 'utf8');
            assert.ok(geminiContent.includes('CLAUDE.md'),
                'Preserved GEMINI.md should redirect to canonical CLAUDE.md');
            assertFinalReportGuidance(bundleRoot);
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('preserves pre-existing provider bridge files across update', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        try {
            const answersPath = writeInitAnswers(bundleRoot, {
                AssistantLanguage: 'English',
                AssistantBrevity: 'concise',
                SourceOfTruth: 'GitHubCopilot',
                EnforceNoAutoCommit: 'false',
                ClaudeOrchestratorFullAccess: 'false',
                TokenEconomyEnabled: 'true',
                CollectedVia: 'CLI_NONINTERACTIVE',
                ActiveAgentFiles: '.github/copilot-instructions.md, CLAUDE.md'
            });

            runInstall({
                targetRoot: projectRoot,
                bundleRoot,
                runInit: false,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'GitHubCopilot',
                initAnswersPath: answersPath
            });

            const bridgePath = path.join(projectRoot, '.github', 'agents', 'orchestrator.md');
            const codeReviewBridgePath = path.join(projectRoot, '.github', 'agents', 'code-review.md');
            assert.ok(fs.existsSync(bridgePath), 'GitHub orchestrator bridge should exist after first install');
            assert.ok(fs.existsSync(codeReviewBridgePath), 'code-review bridge should exist after first install');

            const answersPath2 = writeInitAnswers(bundleRoot, {
                AssistantLanguage: 'English',
                AssistantBrevity: 'concise',
                SourceOfTruth: 'Claude',
                EnforceNoAutoCommit: 'false',
                ClaudeOrchestratorFullAccess: 'false',
                TokenEconomyEnabled: 'true',
                ProviderMinimalism: 'false',
                CollectedVia: 'CLI_NONINTERACTIVE',
                ActiveAgentFiles: 'CLAUDE.md, AGENTS.md'
            });

            const result = runInstall({
                targetRoot: projectRoot,
                bundleRoot,
                preserveExisting: true,
                alignExisting: true,
                runInit: false,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Claude',
                initAnswersPath: answersPath2
            });

            assert.ok(fs.existsSync(path.join(projectRoot, '.github', 'copilot-instructions.md')),
                'copilot-instructions.md must be preserved');
            assert.ok(fs.existsSync(bridgePath),
                'GitHub orchestrator bridge must be preserved');
            assert.ok(fs.existsSync(codeReviewBridgePath),
                'code-review skill bridge must be preserved');
            assert.ok(result.filesPreserved >= 12,
                'filesPreserved should count copilot-instructions.md + orchestrator bridge + skill bridges');

            const copilotContent = fs.readFileSync(path.join(projectRoot, '.github', 'copilot-instructions.md'), 'utf8');
            assert.ok(copilotContent.includes('CLAUDE.md'),
                'Preserved copilot-instructions.md should redirect to new canonical CLAUDE.md');
            const bridgeContent = fs.readFileSync(bridgePath, 'utf8');
            assert.ok(bridgeContent.includes('CLAUDE.md'),
                'Preserved orchestrator bridge should reference new canonical CLAUDE.md');
            const codeReviewContent = fs.readFileSync(codeReviewBridgePath, 'utf8');
            assert.ok(codeReviewContent.includes('code-review'),
                'Preserved code-review bridge should retain skill content');
            assert.ok(codeReviewContent.includes('CLAUDE.md'),
                'Preserved code-review bridge should reference new canonical CLAUDE.md');
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('removes inactive managed provider files when ProviderMinimalism is enabled', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        try {
            const answersPath = writeInitAnswers(bundleRoot, {
                AssistantLanguage: 'English',
                AssistantBrevity: 'concise',
                SourceOfTruth: 'GitHubCopilot',
                EnforceNoAutoCommit: 'false',
                ClaudeOrchestratorFullAccess: 'false',
                TokenEconomyEnabled: 'true',
                CollectedVia: 'CLI_NONINTERACTIVE',
                ActiveAgentFiles: '.github/copilot-instructions.md, CLAUDE.md'
            });

            runInstall({
                targetRoot: projectRoot,
                bundleRoot,
                runInit: false,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'GitHubCopilot',
                initAnswersPath: answersPath
            });

            assert.ok(fs.existsSync(path.join(projectRoot, '.github', 'copilot-instructions.md')));
            assert.ok(fs.existsSync(path.join(projectRoot, '.github', 'agents', 'orchestrator.md')));
            assert.ok(fs.existsSync(path.join(projectRoot, '.github', 'agents', 'code-review.md')));

            const answersPath2 = writeInitAnswers(bundleRoot, {
                AssistantLanguage: 'English',
                AssistantBrevity: 'concise',
                SourceOfTruth: 'Claude',
                EnforceNoAutoCommit: 'false',
                ClaudeOrchestratorFullAccess: 'false',
                TokenEconomyEnabled: 'true',
                CollectedVia: 'CLI_NONINTERACTIVE',
                ActiveAgentFiles: 'CLAUDE.md'
            });

            const result = runInstall({
                targetRoot: projectRoot,
                bundleRoot,
                preserveExisting: true,
                alignExisting: true,
                runInit: false,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Claude',
                initAnswersPath: answersPath2
            });

            assert.equal(result.filesPreserved, 0, 'provider minimalism should not preserve inactive providers');
            assert.ok(!fs.existsSync(path.join(projectRoot, '.github', 'copilot-instructions.md')));
            assert.ok(!fs.existsSync(path.join(projectRoot, '.github', 'agents', 'orchestrator.md')));
            assert.ok(!fs.existsSync(path.join(projectRoot, '.github', 'agents', 'code-review.md')));
            const gitignore = fs.readFileSync(path.join(projectRoot, '.gitignore'), 'utf8');
            assert.ok(!gitignore.includes('.github/copilot-instructions.md'));
            assert.ok(!gitignore.includes('.github/agents/'));
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('does not create new files for entrypoints that never existed on disk', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        try {
            const answersPath = writeInitAnswers(bundleRoot, {
                AssistantLanguage: 'English',
                AssistantBrevity: 'concise',
                SourceOfTruth: 'Claude',
                EnforceNoAutoCommit: 'false',
                ClaudeOrchestratorFullAccess: 'false',
                TokenEconomyEnabled: 'true',
                CollectedVia: 'CLI_NONINTERACTIVE',
                ActiveAgentFiles: 'CLAUDE.md'
            });

            runInstall({
                targetRoot: projectRoot,
                bundleRoot,
                runInit: false,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Claude',
                initAnswersPath: answersPath
            });

            assert.ok(!fs.existsSync(path.join(projectRoot, 'GEMINI.md')),
                'GEMINI.md should not be created when never in ActiveAgentFiles');
            assert.ok(!fs.existsSync(path.join(projectRoot, 'QWEN.md')),
                'QWEN.md should not be created when never in ActiveAgentFiles');
            assert.ok(!fs.existsSync(path.join(projectRoot, '.github', 'agents', 'orchestrator.md')),
                'GitHub bridge should not be created when Copilot was never active');
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('preserves extra entrypoints across reinit-style update with preserveExisting', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        try {
            const answersPath = writeInitAnswers(bundleRoot, {
                AssistantLanguage: 'English',
                AssistantBrevity: 'concise',
                SourceOfTruth: 'Claude',
                EnforceNoAutoCommit: 'false',
                ClaudeOrchestratorFullAccess: 'false',
                TokenEconomyEnabled: 'true',
                CollectedVia: 'CLI_NONINTERACTIVE',
                ActiveAgentFiles: 'CLAUDE.md, AGENTS.md, QWEN.md, GEMINI.md'
            });

            runInstall({
                targetRoot: projectRoot,
                bundleRoot,
                runInit: false,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Claude',
                initAnswersPath: answersPath
            });

            assert.ok(fs.existsSync(path.join(projectRoot, 'QWEN.md')));
            assert.ok(fs.existsSync(path.join(projectRoot, 'GEMINI.md')));

            const answersPath2 = writeInitAnswers(bundleRoot, {
                AssistantLanguage: 'English',
                AssistantBrevity: 'concise',
                SourceOfTruth: 'Claude',
                EnforceNoAutoCommit: 'false',
                ClaudeOrchestratorFullAccess: 'false',
                TokenEconomyEnabled: 'true',
                ProviderMinimalism: 'false',
                CollectedVia: 'CLI_NONINTERACTIVE',
                ActiveAgentFiles: 'CLAUDE.md'
            });

            const result = runInstall({
                targetRoot: projectRoot,
                bundleRoot,
                preserveExisting: true,
                alignExisting: true,
                runInit: false,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Claude',
                initAnswersPath: answersPath2
            });

            assert.ok(fs.existsSync(path.join(projectRoot, 'QWEN.md')),
                'QWEN.md must survive narrower ActiveAgentFiles');
            assert.ok(fs.existsSync(path.join(projectRoot, 'GEMINI.md')),
                'GEMINI.md must survive narrower ActiveAgentFiles');
            assert.ok(fs.existsSync(path.join(projectRoot, 'AGENTS.md')),
                'AGENTS.md must survive narrower ActiveAgentFiles');
            assert.equal(result.filesPreserved, 3,
                'Should preserve exactly QWEN.md, GEMINI.md, AGENTS.md');

            const qwenContent = fs.readFileSync(path.join(projectRoot, 'QWEN.md'), 'utf8');
            const geminiContent = fs.readFileSync(path.join(projectRoot, 'GEMINI.md'), 'utf8');
            assert.ok(qwenContent.includes('CLAUDE.md'), 'QWEN.md should redirect to canonical');
            assert.ok(geminiContent.includes('CLAUDE.md'), 'GEMINI.md should redirect to canonical');
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('does not preserve files without managed markers', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        try {
            fs.writeFileSync(path.join(projectRoot, 'GEMINI.md'), '# My custom Gemini config\n', 'utf8');

            const answersPath = writeInitAnswers(bundleRoot, {
                AssistantLanguage: 'English',
                AssistantBrevity: 'concise',
                SourceOfTruth: 'Claude',
                EnforceNoAutoCommit: 'false',
                ClaudeOrchestratorFullAccess: 'false',
                TokenEconomyEnabled: 'true',
                CollectedVia: 'CLI_NONINTERACTIVE',
                ActiveAgentFiles: 'CLAUDE.md'
            });

            const result = runInstall({
                targetRoot: projectRoot,
                bundleRoot,
                preserveExisting: true,
                runInit: false,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Claude',
                initAnswersPath: answersPath
            });

            assert.ok(fs.existsSync(path.join(projectRoot, 'GEMINI.md')));
            const content = fs.readFileSync(path.join(projectRoot, 'GEMINI.md'), 'utf8');
            assert.ok(content.includes('My custom Gemini config'),
                'User-owned file content should remain unchanged');
            assert.equal(result.filesPreserved, 0,
                'Files without managed markers do not count as preserved');
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('does not overwrite user-owned provider bridges without managed markers during cascaded preservation', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        try {
            const answersPath = writeInitAnswers(bundleRoot, {
                AssistantLanguage: 'English',
                AssistantBrevity: 'concise',
                SourceOfTruth: 'GitHubCopilot',
                EnforceNoAutoCommit: 'false',
                ClaudeOrchestratorFullAccess: 'false',
                TokenEconomyEnabled: 'true',
                CollectedVia: 'CLI_NONINTERACTIVE',
                ActiveAgentFiles: '.github/copilot-instructions.md, CLAUDE.md'
            });

            runInstall({
                targetRoot: projectRoot,
                bundleRoot,
                runInit: false,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'GitHubCopilot',
                initAnswersPath: answersPath
            });

            const bridgePath = path.join(projectRoot, '.github', 'agents', 'orchestrator.md');
            fs.writeFileSync(bridgePath, '# My custom orchestrator agent\nUser-owned content.\n', 'utf8');

            const answersPath2 = writeInitAnswers(bundleRoot, {
                AssistantLanguage: 'English',
                AssistantBrevity: 'concise',
                SourceOfTruth: 'Claude',
                EnforceNoAutoCommit: 'false',
                ClaudeOrchestratorFullAccess: 'false',
                TokenEconomyEnabled: 'true',
                CollectedVia: 'CLI_NONINTERACTIVE',
                ActiveAgentFiles: 'CLAUDE.md'
            });

            runInstall({
                targetRoot: projectRoot,
                bundleRoot,
                preserveExisting: true,
                runInit: false,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Claude',
                initAnswersPath: answersPath2
            });

            const bridgeContent = fs.readFileSync(bridgePath, 'utf8');
            assert.ok(bridgeContent.includes('My custom orchestrator agent'),
                'User-owned bridge file without managed markers must not be overwritten');
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('materializes .vscode/settings.json with IDE exclude patterns', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        try {
            const answersPath = writeInitAnswers(bundleRoot, {
                AssistantLanguage: 'English',
                AssistantBrevity: 'concise',
                SourceOfTruth: 'Claude',
                EnforceNoAutoCommit: 'false',
                ClaudeOrchestratorFullAccess: 'false',
                TokenEconomyEnabled: 'true',
                CollectedVia: 'CLI_NONINTERACTIVE'
            });

            const result = runInstall({
                targetRoot: projectRoot,
                bundleRoot,
                runInit: false,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Claude',
                initAnswersPath: answersPath
            });

            assert.equal(result.vscodeSettingsUpdated, true);
            const vscodePath = path.join(projectRoot, '.vscode', 'settings.json');
            assert.ok(fs.existsSync(vscodePath), '.vscode/settings.json should exist');
            const settings = JSON.parse(fs.readFileSync(vscodePath, 'utf8'));
            assert.equal(settings['files.exclude']['**/garda-agent-orchestrator'], true);
            assert.equal(settings['search.exclude']['**/dist'], true);
            assert.equal(settings['files.watcherExclude']['**/node_modules'], true);
            assert.equal(settings['files.exclude']['**/runtime'], true, 'runtime directory should be excluded');        
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('merges into existing .vscode/settings.json preserving user settings', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        try {
            const vscodePath = path.join(projectRoot, '.vscode', 'settings.json');
            fs.mkdirSync(path.dirname(vscodePath), { recursive: true });
            fs.writeFileSync(vscodePath, JSON.stringify({ 'editor.fontSize': 16 }, null, 2));

            const answersPath = writeInitAnswers(bundleRoot, {
                AssistantLanguage: 'English',
                AssistantBrevity: 'concise',
                SourceOfTruth: 'Claude',
                EnforceNoAutoCommit: 'false',
                ClaudeOrchestratorFullAccess: 'false',
                TokenEconomyEnabled: 'true',
                CollectedVia: 'CLI_NONINTERACTIVE'
            });

            runInstall({
                targetRoot: projectRoot,
                bundleRoot,
                runInit: false,
                preserveExisting: true,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Claude',
                initAnswersPath: answersPath
            });

            const settings = JSON.parse(fs.readFileSync(vscodePath, 'utf8'));
            assert.equal(settings['editor.fontSize'], 16, 'user settings should be preserved');
            assert.equal(settings['files.exclude']['**/garda-agent-orchestrator'], true);
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });
});
