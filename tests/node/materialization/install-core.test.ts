import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { runInstall } from '../../../src/materialization/install';
import {
    getLegacyUninstallBackupGitignoreEntry,
    UNINSTALL_BACKUP_GITIGNORE_COMMENT,
    getUninstallBackupGitignoreEntry,
    buildCommitGuardManagedBlock
} from '../../../src/materialization/content-builders';
import {
    findRepoRoot,
    setupTestWorkspace,
    writeInitAnswers,
    seedLifecycleOperationLock,
    CapturedInitRunnerOptions
} from './install-workspace-builder';

describe('runInstall — core deploy and invariants', () => {
    const repoRoot = findRepoRoot();

    function getLegacyBundleNameFixture(): string {
        return ['ai', 'agent', 'orchestrator'].join('-');
    }

    function buildLegacyCommitGuardBlock(): string {
        const legacyBundleName = getLegacyBundleNameFixture();
        return [
            `# ${legacyBundleName}:commit-guard-start`,
            'if [ -n "${CODEX_HOME:-}" ]; then',
            `  echo "  node ${legacyBundleName}/bin/garda.js gate human-commit --operator-confirmed yes --message \\"<message>\\""`,
            '  exit 1',
            'fi',
            `# ${legacyBundleName}:commit-guard-end`
        ].join('\n');
    }

    it('deploys TASK.md and creates entrypoint files', () => {
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

            assert.ok(result.filesDeployed >= 1);
            assert.ok(fs.existsSync(path.join(projectRoot, 'TASK.md')));
            assert.ok(fs.existsSync(path.join(projectRoot, 'CLAUDE.md')));
            assert.ok(result.liveVersionWritten);
            assert.ok(result.protectedControlPlaneManifestWritten);
            assert.ok(fs.existsSync(path.join(bundleRoot, 'live', 'version.json')));
            assert.ok(fs.existsSync(path.join(bundleRoot, 'runtime', 'protected-control-plane-manifest.json')));
            assert.equal(result.canonicalEntrypoint, 'CLAUDE.md');
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('creates redirect entrypoint for active agent files', () => {
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
                ActiveAgentFiles: 'CLAUDE.md, AGENTS.md'
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

            assert.ok(fs.existsSync(path.join(projectRoot, 'AGENTS.md')));
            const agentsContent = fs.readFileSync(path.join(projectRoot, 'AGENTS.md'), 'utf8');
            assert.ok(agentsContent.includes('redirect'));
            assert.ok(agentsContent.includes('CLAUDE.md'));
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('does not create .qwen/settings.json when qwen is not already configured', () => {
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

            runInstall({
                targetRoot: projectRoot,
                bundleRoot,
                runInit: false,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Claude',
                initAnswersPath: answersPath
            });

            assert.ok(!fs.existsSync(path.join(projectRoot, '.qwen', 'settings.json')));
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('fails when another live lifecycle operation lock exists', () => {
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
            const lockPath = seedLifecycleOperationLock(projectRoot, process.pid);

            assert.throws(() => runInstall({
                targetRoot: projectRoot,
                bundleRoot,
                runInit: false,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Claude',
                initAnswersPath: answersPath
            }), /Another lifecycle operation is already running/);
            assert.ok(fs.existsSync(lockPath), 'live lock must be preserved');
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('reclaims stale lifecycle operation locks before install', () => {
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
            const lockPath = seedLifecycleOperationLock(projectRoot, 99999999);

            const result = runInstall({
                targetRoot: projectRoot,
                bundleRoot,
                runInit: false,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Claude',
                initAnswersPath: answersPath
            });

            assert.ok(result.liveVersionWritten);
            assert.ok(!fs.existsSync(lockPath), 'stale lock should be removed after successful install');
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('updates existing .qwen/settings.json in place', () => {
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

            fs.mkdirSync(path.join(projectRoot, '.qwen'), { recursive: true });
            fs.writeFileSync(
                path.join(projectRoot, '.qwen', 'settings.json'),
                JSON.stringify({ context: { fileName: ['README.md'] } }, null, 2)
            );

            runInstall({
                targetRoot: projectRoot,
                bundleRoot,
                runInit: false,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Claude',
                initAnswersPath: answersPath
            });

            const settings = JSON.parse(fs.readFileSync(path.join(projectRoot, '.qwen', 'settings.json'), 'utf8'));
            assert.ok(settings.context.fileName.includes('README.md'));
            assert.ok(settings.context.fileName.includes('TASK.md'));
            assert.ok(settings.context.fileName.includes('CLAUDE.md'));
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('supports Qwen as canonical source-of-truth and keeps QWEN.md in qwen context', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        try {
            const answersPath = writeInitAnswers(bundleRoot, {
                AssistantLanguage: 'English',
                AssistantBrevity: 'concise',
                SourceOfTruth: 'Qwen',
                EnforceNoAutoCommit: 'false',
                ClaudeOrchestratorFullAccess: 'false',
                TokenEconomyEnabled: 'true',
                CollectedVia: 'CLI_NONINTERACTIVE',
                ActiveAgentFiles: 'QWEN.md, AGENTS.md'
            });

            fs.mkdirSync(path.join(projectRoot, '.qwen'), { recursive: true });
            fs.writeFileSync(
                path.join(projectRoot, '.qwen', 'settings.json'),
                JSON.stringify({ context: { fileName: ['README.md'] } }, null, 2)
            );

            const result = runInstall({
                targetRoot: projectRoot,
                bundleRoot,
                runInit: false,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Qwen',
                initAnswersPath: answersPath
            });

            assert.equal(result.canonicalEntrypoint, 'QWEN.md');
            assert.ok(fs.existsSync(path.join(projectRoot, 'QWEN.md')));
            assert.ok(fs.existsSync(path.join(projectRoot, 'AGENTS.md')));
            const qwenEntrypoint = fs.readFileSync(path.join(projectRoot, 'QWEN.md'), 'utf8');
            assert.ok(qwenEntrypoint.includes('# QWEN.md'));
            assert.ok(qwenEntrypoint.includes('Rule Index'));
            const settings = JSON.parse(fs.readFileSync(path.join(projectRoot, '.qwen', 'settings.json'), 'utf8'));
            assert.ok(settings.context.fileName.includes('TASK.md'));
            assert.ok(settings.context.fileName.includes('QWEN.md'));
            const gitignore = fs.readFileSync(path.join(projectRoot, '.gitignore'), 'utf8');
            assert.ok(gitignore.includes('QWEN.md'));
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('writes live/version.json with correct metadata', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        try {
            const answersPath = writeInitAnswers(bundleRoot, {
                AssistantLanguage: 'Russian',
                AssistantBrevity: 'detailed',
                SourceOfTruth: 'Codex',
                EnforceNoAutoCommit: 'false',
                ClaudeOrchestratorFullAccess: 'false',
                TokenEconomyEnabled: 'false',
                CollectedVia: 'CLI_NONINTERACTIVE'
            });

            runInstall({
                targetRoot: projectRoot,
                bundleRoot,
                runInit: false,
                assistantLanguage: 'Russian',
                assistantBrevity: 'detailed',
                sourceOfTruth: 'Codex',
                initAnswersPath: answersPath
            });

            const version = JSON.parse(fs.readFileSync(path.join(bundleRoot, 'live', 'version.json'), 'utf8'));
            assert.equal(version.SourceOfTruth, 'Codex');
            assert.equal(version.CanonicalEntrypoint, 'AGENTS.md');
            assert.equal(version.AssistantLanguage, 'Russian');
            assert.equal(version.AssistantBrevity, 'detailed');
            assert.equal(version.TokenEconomyEnabled, false);
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('throws when parameter mismatch with init answers', () => {
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

            assert.throws(() => runInstall({
                targetRoot: projectRoot,
                bundleRoot,
                runInit: false,
                assistantLanguage: 'Russian',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Claude',
                initAnswersPath: answersPath
            }), /does not match/);
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('answer-dependent mode only syncs TASK.md managed block', () => {
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

            runInstall({
                targetRoot: projectRoot,
                bundleRoot,
                runInit: false,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Claude',
                initAnswersPath: answersPath
            });

            fs.writeFileSync(
                path.join(projectRoot, 'TASK.md'),
                [
                    '<!-- garda-agent-orchestrator:managed-start -->',
                    '# TASK.md',
                    '',
                    'Old generated header.',
                    '',
                    '## Active Queue',
                    '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
                    '|---|---|---|---|---|---|---|---|---|',
                    '| T-839 | 🟦 TODO | P1 | answer-dependent | Keep answer-dependent row | gpt-5.4 | 2026-06-24 | strict | keep row |',
                    '<!-- garda-agent-orchestrator:managed-end -->',
                    '',
                    '## Operator Notes',
                    'keep answer-dependent notes'
                ].join('\n'),
                'utf8'
            );

            const result = runInstall({
                targetRoot: projectRoot,
                bundleRoot,
                runInit: false,
                answerDependentOnly: true,
                skipBackups: true,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Claude',
                initAnswersPath: answersPath
            });

            const taskContent = fs.readFileSync(path.join(projectRoot, 'TASK.md'), 'utf8');
            assert.ok(result.answerDependentOnly);
            assert.ok(result.filesAligned > 0, 'answer-dependent TASK.md sync should merge in place');
            assert.ok(taskContent.includes('Canonical instructions entrypoint for orchestration: `CLAUDE.md`.'));
            assert.match(taskContent, /\| T-839 \| 🟦 TODO \| P1\s+\| answer-dependent \| Keep answer-dependent row \| gpt-5\.4 \| 2026-06-24 \| strict\s+\| keep row \|/);
            assert.ok(taskContent.includes('## Operator Notes'));
            assert.ok(taskContent.includes('keep answer-dependent notes'));
            assert.ok(!taskContent.includes('| T-001 |'));
            assert.ok(!taskContent.includes('Old generated header.'));
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('migrates legacy TASK.md Depth column during install sync', () => {
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

            fs.writeFileSync(
                path.join(projectRoot, 'TASK.md'),
                [
                    '<!-- garda-agent-orchestrator:managed-start -->',
                    '# TASK.md',
                    '',
                    'Canonical instructions entrypoint for orchestration: `CLAUDE.md`.',
                    '## Active Queue',
                    '| ID | Status | Priority | Area | Title | Owner | Updated | Depth | Notes |',
                    '|---|---|---|---|---|---|---|---|---|',
                    '| T-777 | 🟨 IN_PROGRESS | P1 | legacy | Keep migrated row | me | 2026-01-01 | 2 | preserved-note |',
                    '<!-- garda-agent-orchestrator:managed-end -->',
                    '',
                    '## User Notes',
                    'keep-this-section'
                ].join('\n'),
                'utf8'
            );

            const result = runInstall({
                targetRoot: projectRoot,
                bundleRoot,
                runInit: false,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Claude',
                initAnswersPath: answersPath
            });

            const taskContent = fs.readFileSync(path.join(projectRoot, 'TASK.md'), 'utf8');
            assert.ok(result.filesAligned > 0, 'TASK.md should be synced in place');
            assert.match(taskContent, /\| ID\s+\| Status\s+\| Priority \| Area\s+\| Title\s+\| Owner \| Updated\s+\| Profile \| Notes\s+\|/);
            assert.ok(!taskContent.includes('| ID | Status | Priority | Area | Title | Owner | Updated | Depth | Notes |'));
            assert.match(taskContent, /\| T-777 \| 🟨 IN_PROGRESS \| P1\s+\| legacy \| Keep migrated row \| me\s+\| 2026-01-01 \| default \| requested_depth=2; preserved-note \|/);
            assert.ok(taskContent.includes('requested_depth=2; preserved-note'));
            assert.ok(!taskContent.includes('| T-777 | 🟨 IN_PROGRESS | P1 | legacy | Keep migrated row | me | 2026-01-01 | 2 | preserved-note |'));
            assert.ok(taskContent.includes('## User Notes'));
            assert.ok(taskContent.includes('keep-this-section'));
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('preserves TASK.md queue and lower local block when managed-end is missing during install sync', () => {
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

            fs.writeFileSync(
                path.join(projectRoot, 'TASK.md'),
                [
                    '<!-- garda-agent-orchestrator:managed-start -->',
                    '# TASK.md',
                    '',
                    'Old generated header.',
                    '',
                    '## Active Queue',
                    '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
                    '|---|---|---|---|---|---|---|---|---|',
                    '| T-237 | 🟦 TODO | P0 | reliability | Keep live queue | gpt-5.4 | 2026-04-24 | balanced | preserve me |',
                    '',
                    '',
                    '## Блок очереди',
                    '',
                    '- `T-237` — нижний блок должен сохраниться.'
                ].join('\n'),
                'utf8'
            );

            const result = runInstall({
                targetRoot: projectRoot,
                bundleRoot,
                runInit: false,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Claude',
                initAnswersPath: answersPath
            });

            const taskContent = fs.readFileSync(path.join(projectRoot, 'TASK.md'), 'utf8');
            assert.ok(result.filesAligned > 0, 'TASK.md should be synced in place');
            assert.ok(taskContent.includes('Canonical instructions entrypoint for orchestration: `CLAUDE.md`.'));
            assert.match(taskContent, /\| T-237 \| 🟦 TODO \| P0\s+\| reliability \| Keep live queue \| gpt-5\.4 \| 2026-04-24 \| balanced \| preserve me \|/);
            assert.ok(taskContent.includes('## Блок очереди'));
            assert.ok(taskContent.includes('- `T-237` — нижний блок должен сохраниться.'));
            assert.ok(taskContent.includes('garda-agent-orchestrator:managed-end'));
            assert.ok(!taskContent.includes('Old generated header.'));
            assert.ok(!taskContent.includes('| T-001 |'));
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('merges existing TASK.md content instead of replacing it during overwrite install', () => {
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

            fs.writeFileSync(
                path.join(projectRoot, 'TASK.md'),
                [
                    '<!-- garda-agent-orchestrator:managed-start -->',
                    '# TASK.md',
                    '',
                    'Old generated header.',
                    '',
                    '## Active Queue',
                    '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
                    '|---|---|---|---|---|---|---|---|---|',
                    '| T-838 | 🟦 TODO | P1 | install/task-md-queue-merge | Preserve operator queue | gpt-5.4 | 2026-06-24 | strict | keep row |',
                    '<!-- garda-agent-orchestrator:managed-end -->',
                    '',
                    '## Operator Notes',
                    'keep this local planning section'
                ].join('\n'),
                'utf8'
            );

            const result = runInstall({
                targetRoot: projectRoot,
                bundleRoot,
                preserveExisting: false,
                runInit: false,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Claude',
                initAnswersPath: answersPath
            });

            const taskContent = fs.readFileSync(path.join(projectRoot, 'TASK.md'), 'utf8');
            assert.ok(result.filesAligned > 0, 'TASK.md should be merged in place');
            assert.ok(result.filesDeployed > 0, 'overwrite install should still report deployment');
            assert.ok(taskContent.includes('Canonical instructions entrypoint for orchestration: `CLAUDE.md`.'));
            assert.match(taskContent, /\| T-838 \| 🟦 TODO \| P1\s+\| install\/task-md-queue-merge \| Preserve operator queue \| gpt-5\.4 \| 2026-06-24 \| strict\s+\| keep row \|/);
            assert.ok(taskContent.includes('## Operator Notes'));
            assert.ok(taskContent.includes('keep this local planning section'));
            assert.ok(!taskContent.includes('| T-001 |'));
            assert.ok(!taskContent.includes('Old generated header.'));
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('creates commit guard hook when enforceNoAutoCommit is true', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        try {
            const answersPath = writeInitAnswers(bundleRoot, {
                AssistantLanguage: 'English',
                AssistantBrevity: 'concise',
                SourceOfTruth: 'Claude',
                EnforceNoAutoCommit: 'true',
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

            assert.ok(result.preCommitHookUpdated);
            const hookContent = fs.readFileSync(
                path.join(projectRoot, '.git', 'hooks', 'pre-commit'), 'utf8'
            );
            assert.ok(hookContent.includes('commit-guard'));
            assert.ok(hookContent.includes('GARDA_ALLOW_COMMIT'));
            if (process.platform !== 'win32') {
                assert.equal(fs.statSync(path.join(projectRoot, '.git', 'hooks', 'pre-commit')).mode & 0o111, 0o111);
            }
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('replaces legacy commit guard hook blocks instead of leaking stale helper paths', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        try {
            const hookPath = path.join(projectRoot, '.git', 'hooks', 'pre-commit');
            const legacyBundleName = getLegacyBundleNameFixture();
            fs.mkdirSync(path.dirname(hookPath), { recursive: true });
            fs.writeFileSync(
                hookPath,
                [
                    '#!/usr/bin/env bash',
                    '',
                    buildLegacyCommitGuardBlock(),
                    '',
                    'echo "user hook remains"'
                ].join('\n'),
                'utf8'
            );
            const answersPath = writeInitAnswers(bundleRoot, {
                AssistantLanguage: 'English',
                AssistantBrevity: 'concise',
                SourceOfTruth: 'Claude',
                EnforceNoAutoCommit: 'true',
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

            const hookContent = fs.readFileSync(hookPath, 'utf8');
            const expectedGuard = buildCommitGuardManagedBlock();
            assert.ok(result.preCommitHookUpdated);
            assert.ok(hookContent.includes(expectedGuard));
            assert.ok(hookContent.includes('echo "user hook remains"'));
            assert.ok(!hookContent.includes(legacyBundleName));
            assert.ok(!hookContent.includes(`${legacyBundleName}/bin/garda.js`));
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('updates .gitignore', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        try {
            const answersPath = writeInitAnswers(bundleRoot, {
                AssistantLanguage: 'English',
                AssistantBrevity: 'concise',
                SourceOfTruth: 'Claude',
                EnforceNoAutoCommit: 'false',
                ClaudeOrchestratorFullAccess: 'false',
                TokenEconomyEnabled: 'true',
                ProviderMinimalism: 'false',
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

            assert.ok(result.gitignoreEntriesAdded > 0);
            const gitignore = fs.readFileSync(path.join(projectRoot, '.gitignore'), 'utf8');
            assert.ok(gitignore.includes('garda-agent-orchestrator/'));
            assert.ok(gitignore.includes('.agentignore'));
            assert.ok(gitignore.includes('TASK.md'));
            assert.ok(gitignore.includes('AGENTS.md'));
            assert.ok(gitignore.includes('GEMINI.md'));
            assert.ok(gitignore.includes('.antigravity/'));
            assert.ok(gitignore.includes('.windsurf/'));
            assert.ok(gitignore.includes('.junie/'));
            assert.ok(!gitignore.includes('.antigravity/rules.md'));
            assert.ok(!gitignore.includes('.windsurf/rules/rules.md'));
            assert.ok(!gitignore.includes('.junie/guidelines.md'));
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('creates active .agentignore block while preserving user content', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        try {
            const answersPath = writeInitAnswers(bundleRoot, {
                AssistantLanguage: 'English',
                AssistantBrevity: 'concise',
                SourceOfTruth: 'Claude',
                EnforceNoAutoCommit: 'false',
                ClaudeOrchestratorFullAccess: 'false',
                TokenEconomyEnabled: 'true',
                ProviderMinimalism: 'true',
                CollectedVia: 'CLI_NONINTERACTIVE'
            });
            fs.writeFileSync(path.join(projectRoot, '.agentignore'), 'node_modules/\n', 'utf8');

            const first = runInstall({
                targetRoot: projectRoot,
                bundleRoot,
                runInit: false,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Claude',
                initAnswersPath: answersPath
            });
            const second = runInstall({
                targetRoot: projectRoot,
                bundleRoot,
                runInit: false,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Claude',
                initAnswersPath: answersPath
            });

            const agentignore = fs.readFileSync(path.join(projectRoot, '.agentignore'), 'utf8');
            assert.equal(first.agentignoreUpdated, true);
            assert.equal(second.agentignoreUpdated, false);
            assert.ok(agentignore.startsWith('node_modules/'));
            assert.equal((agentignore.match(/# Garda active-mode agent ignore/g) || []).length, 1);
            assert.ok(agentignore.includes('garda-agent-orchestrator/runtime/scoped-diffs/'));
            assert.ok(!agentignore.includes('garda-agent-orchestrator/bin/garda.js'));
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('blocks malformed .agentignore managed markers during install', () => {
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
            fs.writeFileSync(path.join(projectRoot, '.agentignore'), '<!-- garda-agent-orchestrator:managed-start -->\n', 'utf8');

            assert.throws(() => runInstall({
                targetRoot: projectRoot,
                bundleRoot,
                runInit: false,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Claude',
                initAnswersPath: answersPath
            }), /\.agentignore: managed block markers are incomplete/);
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('replaces an existing managed .gitignore block instead of appending a second header', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        try {
            const answersPath = writeInitAnswers(bundleRoot, {
                AssistantLanguage: 'English',
                AssistantBrevity: 'concise',
                SourceOfTruth: 'Claude',
                EnforceNoAutoCommit: 'false',
                ClaudeOrchestratorFullAccess: 'false',
                TokenEconomyEnabled: 'true',
                ProviderMinimalism: 'false',
                CollectedVia: 'CLI_NONINTERACTIVE'
            });

            fs.writeFileSync(
                path.join(projectRoot, '.gitignore'),
                [
                    'node_modules/',
                    '# garda-agent-orchestrator managed ignores',
                    'AGENTS.md',
                    'TASK.md',
                    '.antigravity/rules.md'
                ].join('\n'),
                'utf8'
            );

            runInstall({
                targetRoot: projectRoot,
                bundleRoot,
                runInit: false,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Claude',
                initAnswersPath: answersPath
            });

            const gitignore = fs.readFileSync(path.join(projectRoot, '.gitignore'), 'utf8');
            assert.equal((gitignore.match(/# garda-agent-orchestrator managed ignores/g) || []).length, 1);
            assert.ok(gitignore.includes('node_modules/'));
            assert.ok(gitignore.includes('.antigravity/'));
            assert.ok(!gitignore.includes('.antigravity/rules.md'));
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('migrates legacy uninstall backup .gitignore entries during install', () => {
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

            fs.writeFileSync(
                path.join(projectRoot, '.gitignore'),
                [
                    'node_modules/',
                    getUninstallBackupGitignoreEntry(),
                    getLegacyUninstallBackupGitignoreEntry(),
                    '# garda-agent-orchestrator managed ignores',
                    'TASK.md'
                ].join('\n'),
                'utf8'
            );

            runInstall({
                targetRoot: projectRoot,
                bundleRoot,
                runInit: false,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Claude',
                initAnswersPath: answersPath
            });

            const gitignore = fs.readFileSync(path.join(projectRoot, '.gitignore'), 'utf8');
            const lines = gitignore.split(/\r?\n/);
            assert.equal(lines.filter((line: string) => line === UNINSTALL_BACKUP_GITIGNORE_COMMENT).length, 1);
            assert.equal(lines.filter((line: string) => line === getUninstallBackupGitignoreEntry()).length, 1);
            assert.equal(lines.includes(getLegacyUninstallBackupGitignoreEntry()), false);
            assert.equal((gitignore.match(/# garda-agent-orchestrator managed ignores/g) || []).length, 1);
            assert.ok(lines.indexOf(getUninstallBackupGitignoreEntry()) < lines.indexOf('# garda-agent-orchestrator managed ignores'));
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('dry-run does not write any files to disk', () => {
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
                initAnswersPath: answersPath,
                dryRun: true
            });

            assert.ok(result.filesDeployed >= 0);
            assert.equal(result.initInvoked, false);
            assert.equal(result.liveVersionWritten, false);
            assert.equal(result.backupRoot, null);
            assert.ok(!fs.existsSync(path.join(projectRoot, 'TASK.md')));
            assert.ok(!fs.existsSync(path.join(projectRoot, 'CLAUDE.md')));
            assert.ok(!fs.existsSync(path.join(bundleRoot, 'live', 'version.json')));
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('dry-run with existing bundle does not mutate bundle contents', () => {
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

            runInstall({
                targetRoot: projectRoot,
                bundleRoot,
                runInit: false,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Claude',
                initAnswersPath: answersPath
            });

            const snapshotDir = (dir: string) => {
                const result: Record<string, { size: number; mtime: number }> = {};
                for (const entry of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
                    const full = path.join(entry.parentPath || dir, entry.name);
                    const rel = path.relative(dir, full);
                    if (entry.isFile()) {
                        const stat = fs.statSync(full);
                        result[rel] = { size: stat.size, mtime: stat.mtimeMs };
                    }
                }
                return result;
            };

            const bundleSnapshotBefore = snapshotDir(bundleRoot);
            const projectSnapshotBefore = snapshotDir(projectRoot);

            const dryResult = runInstall({
                targetRoot: projectRoot,
                bundleRoot,
                runInit: false,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Claude',
                initAnswersPath: answersPath,
                dryRun: true
            });

            const bundleSnapshotAfter = snapshotDir(bundleRoot);
            const projectSnapshotAfter = snapshotDir(projectRoot);

            assert.deepStrictEqual(
                Object.keys(bundleSnapshotBefore).sort(),
                Object.keys(bundleSnapshotAfter).sort(),
                'Bundle file list must not change during dry-run'
            );

            assert.deepStrictEqual(
                Object.keys(projectSnapshotBefore).sort(),
                Object.keys(projectSnapshotAfter).sort(),
                'Project file list must not change during dry-run'
            );

            assert.equal(dryResult.filesDeployed, 0);
            assert.equal(dryResult.backupRoot, null);
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('backs up and fully replaces conflicting legacy entrypoint files', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        try {
            const legacyEntrypointPath = path.join(projectRoot, 'AGENTS.md');
            fs.writeFileSync(
                legacyEntrypointPath,
                '# Legacy agent instructions\n\nDo not overwrite this file in place.\n',
                'utf8'
            );

            const answersPath = writeInitAnswers(bundleRoot, {
                AssistantLanguage: 'English',
                AssistantBrevity: 'concise',
                SourceOfTruth: 'Codex',
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
                sourceOfTruth: 'Codex',
                initAnswersPath: answersPath
            });

            const installedContent = fs.readFileSync(legacyEntrypointPath, 'utf8');
            assert.ok(installedContent.includes('garda-agent-orchestrator:managed-start'));
            assert.ok(!installedContent.includes('Legacy agent instructions'));

            const backupPath = path.join(result.backupRoot!, 'AGENTS.md');
            assert.ok(fs.existsSync(backupPath));
            assert.ok(fs.readFileSync(backupPath, 'utf8').includes('Legacy agent instructions'));
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('creates unique backup roots when multiple installs happen in the same timestamp window', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        const RealDate = Date;
        const fixedNow = new RealDate('2026-03-22T12:00:00.123Z');

        class MockDate extends RealDate {
            constructor(...args: unknown[]) {
                if (args.length > 0) {
                    super(...(args as [string]));
                    return;
                }
                super(fixedNow.getTime());
            }

            static now() {
                return fixedNow.getTime();
            }

            static parse(value: string) {
                return RealDate.parse(value);
            }

            static UTC(...args: unknown[]) {
                return RealDate.UTC(...(args as [number]));
            }
        }

        try {
            const answersPath = writeInitAnswers(bundleRoot, {
                AssistantLanguage: 'English',
                AssistantBrevity: 'concise',
                SourceOfTruth: 'Codex',
                EnforceNoAutoCommit: 'false',
                ClaudeOrchestratorFullAccess: 'false',
                TokenEconomyEnabled: 'true',
                CollectedVia: 'CLI_NONINTERACTIVE'
            });

            global.Date = MockDate as unknown as DateConstructor;

            const legacyEntrypointPath = path.join(projectRoot, 'AGENTS.md');
            fs.writeFileSync(legacyEntrypointPath, '# First legacy instructions\n', 'utf8');
            const firstInstall = runInstall({
                targetRoot: projectRoot,
                bundleRoot,
                runInit: false,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Codex',
                initAnswersPath: answersPath
            });

            fs.writeFileSync(legacyEntrypointPath, '# Second legacy instructions\n', 'utf8');
            const secondInstall = runInstall({
                targetRoot: projectRoot,
                bundleRoot,
                runInit: false,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Codex',
                initAnswersPath: answersPath
            });

            assert.notEqual(firstInstall.backupRoot, secondInstall.backupRoot);
            assert.ok(fs.readFileSync(path.join(firstInstall.backupRoot!, 'AGENTS.md'), 'utf8').includes('First legacy instructions'));
            assert.ok(fs.readFileSync(path.join(secondInstall.backupRoot!, 'AGENTS.md'), 'utf8').includes('Second legacy instructions'));
        } finally {
            global.Date = RealDate;
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('passes gitignore-scoping init inputs to initRunner when install invokes init', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        try {
            const answersPath = writeInitAnswers(bundleRoot, {
                AssistantLanguage: 'English',
                AssistantBrevity: 'concise',
                SourceOfTruth: 'Claude',
                EnforceNoAutoCommit: 'false',
                ClaudeOrchestratorFullAccess: 'true',
                TokenEconomyEnabled: 'true',
                ProviderMinimalism: 'false',
                CollectedVia: 'CLI_NONINTERACTIVE',
                ActiveAgentFiles: 'CLAUDE.md, AGENTS.md'
            });
            let captured: CapturedInitRunnerOptions | undefined;
            let capturedCalled = false;

            runInstall({
                targetRoot: projectRoot,
                bundleRoot,
                runInit: true,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Claude',
                initAnswersPath: answersPath,
                initRunner(options) {
                    captured = options;
                    capturedCalled = true;
                }
            });

            assert.equal(capturedCalled, true, 'initRunner should receive install-provided init options');
            const capturedOptions = captured!;
            assert.equal(capturedOptions.claudeOrchestratorFullAccess, true);
            assert.equal(capturedOptions.providerMinimalism, false);
            assert.equal(capturedOptions.activeAgentFilesSeed, 'CLAUDE.md, AGENTS.md');
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });
});
