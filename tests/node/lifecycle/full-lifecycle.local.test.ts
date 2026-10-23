import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    COMMIT_GUARD_START,
    MANAGED_START,
    MANAGED_END
} from '../../../src/materialization/content-builders';
import { runAgentInit } from '../../../src/lifecycle/agent-init';
import { runReinit } from '../../../src/materialization/reinit';
import { runUpdate } from '../../../src/lifecycle/update';
import { runUninstall } from '../../../src/lifecycle/uninstall';
import { getStatusSnapshot } from '../../../src/validators/status';
import { runVerify } from '../../../src/validators/verify';
import { validateManifest } from '../../../src/validators/validate-manifest';
import { PROJECT_MEMORY_REQUIRED_FILE_NAMES } from '../../../src/core/project-memory';
import { TEST_COMPILE_GATE_COMMAND, writeTestCompileFixture } from '../cli/commands/gate-test-repo-bootstrap';

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

function createRepoLocalWorkspace(repoRoot: string, prefix: string) {
    const repoRootToken = path.basename(repoRoot).replace(/[^a-zA-Z0-9._-]/g, '-');
    const baseDir = path.join(os.tmpdir(), 'garda-test-workspaces', repoRootToken);
    fs.mkdirSync(baseDir, { recursive: true });
    return fs.mkdtempSync(path.join(baseDir, `${prefix}-`));
}

function writeTextFile(filePath: string, content: string) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
}

function readJson(filePath: string): Record<string, unknown> {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function materializeProjectCommands(bundleRoot: string) {
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

function materializeProjectMemory(bundleRoot: string) {
    for (const fileName of PROJECT_MEMORY_REQUIRED_FILE_NAMES) {
        writeTextFile(
            path.join(bundleRoot, 'live', 'docs', 'project-memory', fileName),
            [
                `# ${fileName}`,
                '',
                `Full lifecycle fixture memory for ${fileName}.`,
                'This content represents agent-confirmed project facts for readiness validation.'
            ].join('\n')
        );
    }
}

function configureCompileGateCommand(bundleRoot: string) {
    writeTestCompileFixture(path.dirname(bundleRoot));
    const workflowConfigPath = path.join(bundleRoot, 'live', 'config', 'workflow-config.json');
    const workflowConfig = readJson(workflowConfigPath);
    const compileGate = workflowConfig.compile_gate;
    workflowConfig.compile_gate = {
        ...(compileGate && typeof compileGate === 'object' && !Array.isArray(compileGate) ? compileGate : {}),
        command: TEST_COMPILE_GATE_COMMAND
    };
    fs.writeFileSync(workflowConfigPath, `${JSON.stringify(workflowConfig, null, 2)}\n`, 'utf8');
}

function listChildDirectories(parentDir: string) {
    if (!fs.existsSync(parentDir)) return [];
    return fs.readdirSync(parentDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();
}

function seedLegacyWorkspace(workspaceRoot: string) {
    const legacyFiles = new Map([
        ['AGENTS.md', '# User AGENTS\n\nLegacy user instructions.\n'],
        ['TASK.md', '# User Tasks\n\n- Keep this original task list.\n'],
        ['.gitignore', 'node_modules/\n.custom-cache/\n'],
        ['.qwen/settings.json', JSON.stringify({
            context: { fileName: ['README.md'] },
            userSetting: true
        }, null, 2)],
        ['.claude/settings.local.json', JSON.stringify({
            permissions: { allow: ['Bash(git status:*)'] }
        }, null, 2)],
        ['.git/hooks/pre-commit', '#!/usr/bin/env bash\necho "user hook"\n']
    ]);

    for (const [relativePath, content] of legacyFiles) {
        writeTextFile(path.join(workspaceRoot, relativePath), content);
    }

    return legacyFiles;
}

async function runInteractiveSetup(repoRoot: string, workspaceRoot: string, answers: Record<string, unknown>) {
    const cliHelpersPath = require.resolve('../../../src/cli/commands/cli-helpers');
    const setupPath = require.resolve('../../../src/cli/commands/setup');
    const cliHelpers = require(cliHelpersPath);
    const originals = {
        supportsInteractivePrompts: cliHelpers.supportsInteractivePrompts,
        promptTextInput: cliHelpers.promptTextInput,
        promptSingleSelect: cliHelpers.promptSingleSelect
    };
    const promptTrace: string[] = [];
    const output: string[] = [];
    const selectValues = [
        answers.assistantBrevity,
        answers.sourceOfTruth,
        answers.enforceNoAutoCommit ? 'true' : 'false',
        answers.claudeOrchestratorFullAccess ? 'true' : 'false',
        answers.tokenEconomyEnabled ? 'true' : 'false'
    ];
    let selectIndex = 0;
    const packageJson = readJson(path.join(repoRoot, 'package.json'));
    const originalConsoleLog = console.log;

    delete require.cache[setupPath];
    cliHelpers.supportsInteractivePrompts = function () { return true; };
    cliHelpers.promptTextInput = async function (title: string) {
        promptTrace.push(title);
        return answers.assistantLanguage;
    };
    cliHelpers.promptSingleSelect = async function (config: { title: string; options: Array<{ value: string }> }) {
        promptTrace.push(config.title);
        const value = selectValues[selectIndex];
        selectIndex += 1;
        assert.ok(config.options.some((option: { value: string }) => option.value === value), `Unexpected prompt value '${value}' for '${config.title}'.`);
        return value;
    };
    console.log = function (...args: unknown[]) {
        output.push(args.map((value: unknown) => String(value)).join(' '));
    };

    try {
        const { handleSetup } = require(setupPath);
        await handleSetup(
            ['--target-root', workspaceRoot, '--skip-verify', '--skip-manifest-validation'],
            packageJson,
            repoRoot
        );
    } finally {
        console.log = originalConsoleLog;
        cliHelpers.supportsInteractivePrompts = originals.supportsInteractivePrompts;
        cliHelpers.promptTextInput = originals.promptTextInput;
        cliHelpers.promptSingleSelect = originals.promptSingleSelect;
        delete require.cache[setupPath];
    }

    return { promptTrace, output };
}

function injectBundleUpdate(bundleRoot: string, updateMarker: string, nextVersion: string) {
    const versionPath = path.join(bundleRoot, 'VERSION');
    const canonicalRuleIndexPath = path.join(bundleRoot, 'template', 'entrypoints', 'canonical-rule-index.md');
    const currentTemplate = fs.readFileSync(canonicalRuleIndexPath, 'utf8');
    const updatedTemplate = currentTemplate.replace(
        MANAGED_END,
        `Update marker: ${updateMarker}\r\n${MANAGED_END}`
    );

    fs.writeFileSync(versionPath, `${nextVersion}\n`, 'utf8');
    fs.writeFileSync(canonicalRuleIndexPath, updatedTemplate, 'utf8');
}

describe('full local lifecycle', () => {
    const repoRoot = findRepoRoot();

    it('runs setup, reinit, update, and uninstall entirely inside the repository', async () => {
        const workspaceRoot = createRepoLocalWorkspace(repoRoot, 'gao-full-lifecycle');
        const legacyFiles = seedLegacyWorkspace(workspaceRoot);
        const setupAnswers = {
            assistantLanguage: 'Russian',
            assistantBrevity: 'detailed',
            sourceOfTruth: 'Codex',
            enforceNoAutoCommit: true,
            claudeOrchestratorFullAccess: true,
            tokenEconomyEnabled: false
        };

        try {
            const { promptTrace, output } = await runInteractiveSetup(repoRoot, workspaceRoot, setupAnswers);
            const bundleRoot = path.join(workspaceRoot, 'garda-agent-orchestrator');
            const initAnswersPath = path.join(bundleRoot, 'runtime', 'init-answers.json');
            const setupOutput = output.join('\n');

            assert.deepEqual(promptTrace, [
                'Set communication language',
                'Set default response brevity',
                'Set primary source-of-truth entrypoint',
                'Set no-auto-commit guard mode',
                'Allow Claude Code to run Garda, git diff/log and grep without asking each time (skip if you do not use Claude Code)',
                'Set default token economy mode'
            ]);

            const persistedAnswers = readJson(initAnswersPath);
            assert.equal(persistedAnswers.AssistantLanguage, 'Russian');
            assert.equal(persistedAnswers.AssistantBrevity, 'detailed');
            assert.equal(persistedAnswers.SourceOfTruth, 'Codex');
            assert.equal(persistedAnswers.EnforceNoAutoCommit, 'true');
            assert.equal(persistedAnswers.ClaudeOrchestratorFullAccess, 'true');
            assert.equal(persistedAnswers.TokenEconomyEnabled, 'false');
            assert.equal(persistedAnswers.CollectedVia, 'CLI_INTERACTIVE');
            assert.equal(persistedAnswers.ActiveAgentFiles, 'AGENTS.md');

            assert.ok(fs.existsSync(bundleRoot));
            assert.ok(fs.existsSync(path.join(bundleRoot, 'live', 'version.json')));
            assert.ok(fs.existsSync(path.join(workspaceRoot, 'AGENTS.md')));
            assert.ok(!fs.existsSync(path.join(workspaceRoot, 'CLAUDE.md')));
            assert.ok(fs.existsSync(path.join(workspaceRoot, 'TASK.md')));
            assert.ok(fs.existsSync(path.join(workspaceRoot, '.qwen', 'settings.json')));
            assert.ok(fs.existsSync(path.join(workspaceRoot, '.claude', 'settings.local.json')));
            assert.ok(fs.existsSync(path.join(workspaceRoot, '.git', 'hooks', 'pre-commit')));
            assert.ok(setupOutput.includes('Primary setup finished. Next stage: agent initialization.'));
            assert.ok(setupOutput.includes('Agent Initialization'));
            assert.ok(setupOutput.includes('Give your agent:'));
            assert.ok(!setupOutput.includes('Workspace is ready.'));

            materializeProjectCommands(bundleRoot);
            configureCompileGateCommand(bundleRoot);
            materializeProjectMemory(bundleRoot);
            const agentInitResult = runAgentInit({
                targetRoot: workspaceRoot,
                bundleRoot,
                initAnswersPath: 'garda-agent-orchestrator/runtime/init-answers.json',
                activeAgentFiles: 'AGENTS.md, CLAUDE.md',
                projectRulesUpdated: 'yes',
                skillsPrompted: 'yes',
                ordinaryDocPaths: 'CHANGELOG.md'
            });

            assert.equal(agentInitResult.readyForTasks, true);
            assert.ok(fs.existsSync(path.join(workspaceRoot, 'CLAUDE.md')));
            const readySnapshot = getStatusSnapshot(workspaceRoot, 'garda-agent-orchestrator/runtime/init-answers.json');
            assert.equal(readySnapshot.readyForTasks, true,
                [
                    `pending=${readySnapshot.agentInitializationPendingReason || 'none'}`,
                    `parityStale=${readySnapshot.parityResult.isStale}`,
                    `providerCompliance=${readySnapshot.providerComplianceResult?.passed ?? 'n/a'}`,
                    `protectedBlocks=${readySnapshot.protectedManifestAssessment?.blocks ?? 'n/a'}`
                ].join('; '));

            // Verify workspace integrity after full setup + agent-init
            const verifyResult = runVerify({
                targetRoot: workspaceRoot,
                sourceOfTruth: 'Codex',
                initAnswersPath: 'garda-agent-orchestrator/runtime/init-answers.json'
            });
            assert.equal(verifyResult.passed, true,
                `Verify failed with ${verifyResult.totalViolationCount} violation(s): ${JSON.stringify(verifyResult.violations)}`);

            const manifestResult = validateManifest(
                path.join(bundleRoot, 'MANIFEST.md'),
                workspaceRoot
            );
            assert.equal(manifestResult.passed, true,
                `Manifest validation failed: ${JSON.stringify(manifestResult.duplicates)}`);

            const installedAgents = fs.readFileSync(path.join(workspaceRoot, 'AGENTS.md'), 'utf8');
            const installedTask = fs.readFileSync(path.join(workspaceRoot, 'TASK.md'), 'utf8');
            const installedGitignore = fs.readFileSync(path.join(workspaceRoot, '.gitignore'), 'utf8');
            const installedQwen = readJson(path.join(workspaceRoot, '.qwen', 'settings.json')) as { context: { fileName: string[] }; [k: string]: unknown };
            const installedClaude = readJson(path.join(workspaceRoot, '.claude', 'settings.local.json')) as { permissions: { allow: string[] }; [k: string]: unknown };
            const installedHook = fs.readFileSync(path.join(workspaceRoot, '.git', 'hooks', 'pre-commit'), 'utf8');

            assert.ok(installedAgents.includes(MANAGED_START));
            assert.ok(!installedAgents.includes('Legacy user instructions.'));
            assert.ok(installedTask.includes(MANAGED_START));
            assert.ok(installedTask.includes('Keep this original task list.'));
            assert.ok(installedGitignore.includes('.custom-cache/'));
            assert.ok(installedGitignore.includes('# garda-agent-orchestrator managed ignores'));
            assert.ok(installedQwen.context.fileName.includes('README.md'));
            assert.ok(installedQwen.context.fileName.includes('AGENTS.md'));
            assert.ok(installedClaude.permissions.allow.includes('Bash(git status:*)'));
            assert.ok(installedHook.includes('user hook'));
            assert.ok(installedHook.includes(COMMIT_GUARD_START));

            const installBackupsRoot = path.join(bundleRoot, 'runtime', 'backups');
            const installBackupDirs = listChildDirectories(installBackupsRoot);
            assert.equal(installBackupDirs.length, 1);
            const installBackupManifest = readJson(
                path.join(installBackupsRoot, installBackupDirs[0], '_install-backup.manifest.json')
            );
            const preExistingFilesList = installBackupManifest.PreExistingFiles as unknown[] || [];
            const preExistingFiles = new Set(
                preExistingFilesList.map((item: unknown) => String(item).replace(/\\/g, '/').toLowerCase())
            );
            for (const relativePath of legacyFiles.keys()) {
                assert.ok(
                    preExistingFiles.has(relativePath.replace(/\\/g, '/').toLowerCase()),
                    `Missing '${relativePath}' in initial backup manifest.`
                );
            }

            const reinitResult = runReinit({
                targetRoot: workspaceRoot,
                bundleRoot,
                initAnswersPath: 'garda-agent-orchestrator/runtime/init-answers.json',
                overrides: {
                    AssistantLanguage: 'English',
                    AssistantBrevity: 'concise',
                    SourceOfTruth: 'Codex',
                    EnforceNoAutoCommit: 'false',
                    ClaudeOrchestratorFullAccess: 'false',
                    TokenEconomyEnabled: 'true'
                },
                skipVerify: true,
                skipManifestValidation: true
            });

            assert.equal(reinitResult.assistantLanguage, 'English');
            assert.equal(reinitResult.assistantBrevity, 'concise');
            assert.equal(reinitResult.tokenEconomyEnabled, true);

            const reinitAnswers = readJson(initAnswersPath);
            assert.equal(reinitAnswers.AssistantLanguage, 'English');
            assert.equal(reinitAnswers.AssistantBrevity, 'concise');
            assert.equal(reinitAnswers.EnforceNoAutoCommit, 'false');
            assert.equal(reinitAnswers.ClaudeOrchestratorFullAccess, 'false');
            assert.equal(reinitAnswers.TokenEconomyEnabled, 'true');

            const coreRulePath = path.join(bundleRoot, 'live', 'docs', 'agent-rules', '00-core.md');
            const tokenEconomyPath = path.join(bundleRoot, 'live', 'config', 'token-economy.json');
            assert.ok(fs.readFileSync(coreRulePath, 'utf8').includes('English'));
            assert.equal(readJson(tokenEconomyPath).enabled, true);

            const updateMarker = 'UPDATED_FROM_LOCAL_LIFECYCLE_TEST';
            injectBundleUpdate(bundleRoot, updateMarker, '1.0.9');

            const updateResult = runUpdate({
                targetRoot: workspaceRoot,
                bundleRoot,
                initAnswersPath: 'garda-agent-orchestrator/runtime/init-answers.json',
                skipVerify: false,
                skipManifestValidation: false,
                verifyRunner: function (opts) {
                    const vr = runVerify(opts);
                    if (!vr.passed) {
                        throw new Error('Verify failed during update: ' + vr.totalViolationCount + ' violation(s)');
                    }
                },
                manifestRunner: function (opts) {
                    const mr = validateManifest(path.join(opts.targetRoot, 'garda-agent-orchestrator', 'MANIFEST.md'), opts.targetRoot);
                    if (!mr.passed) {
                        throw new Error('Manifest validation failed during update: ' + JSON.stringify(mr.duplicates));
                    }
                }
            });

            assert.equal(updateResult.installStatus, 'PASS');
            assert.equal(updateResult.rollbackStatus, 'NOT_TRIGGERED');
            assert.ok(fs.existsSync(path.join(workspaceRoot, updateResult.updateReportPath)));
            assert.ok(fs.readFileSync(path.join(workspaceRoot, 'AGENTS.md'), 'utf8').includes(updateMarker));

            const liveVersion = readJson(path.join(bundleRoot, 'live', 'version.json'));
            assert.equal(liveVersion.Version, '1.0.9');

            const taskBeforeUninstall = fs.readFileSync(path.join(workspaceRoot, 'TASK.md'), 'utf8');
            const managedTaskEnd = taskBeforeUninstall.indexOf(MANAGED_END);
            assert.notEqual(managedTaskEnd, -1);
            const retainedTaskContent = taskBeforeUninstall.slice(managedTaskEnd + MANAGED_END.length).trimStart();
            assert.ok(retainedTaskContent.startsWith('## Task Candidates\n'));

            const uninstallResult = runUninstall({
                targetRoot: workspaceRoot,
                bundleRoot,
                initAnswersPath: 'garda-agent-orchestrator/runtime/init-answers.json',
                keepPrimaryEntrypoint: false,
                keepTaskFile: false,
                keepRuntimeArtifacts: false
            });

            assert.equal(uninstallResult.result, 'SUCCESS');
            assert.ok(fs.existsSync(uninstallResult.backupRoot));
            assert.ok(!fs.existsSync(bundleRoot));
            assert.ok(fs.existsSync(path.join(workspaceRoot, 'garda-agent-orchestrator-uninstall-backups')));

            // .agents/ router directory must be removed when only orchestrator-managed content remained
            assert.ok(!fs.existsSync(path.join(workspaceRoot, '.agents')),
                'Expected .agents/ directory to be removed after uninstall');

            for (const [relativePath, originalContent] of legacyFiles) {
                const restoredPath = path.join(workspaceRoot, relativePath);
                assert.ok(fs.existsSync(restoredPath), `Expected restored file '${relativePath}'.`);

                if (relativePath === '.gitignore') {
                    const restoredContent = fs.readFileSync(restoredPath, 'utf8');
                    assert.ok(restoredContent.includes('node_modules/'),
                        'Restored .gitignore must contain original user entries');
                    assert.ok(restoredContent.includes('.custom-cache/'),
                        'Restored .gitignore must contain original user entries');
                    assert.ok(restoredContent.includes('garda-agent-orchestrator-uninstall-backups/'),
                        'Restored .gitignore must ignore uninstall backup directory');
                    assert.ok(!restoredContent.includes('garda-agent-orchestrator-uninstall-backups/**'),
                        'Redundant wildcard entry must not be present');
                    assert.ok(restoredContent.includes('# Backup artifacts created by Garda Agent Orchestrator uninstall'),
                        'Explanatory comment for uninstall backups must be present');
                } else if (relativePath === 'TASK.md') {
                    const restoredContent = fs.readFileSync(restoredPath, 'utf8');
                    assert.equal(restoredContent, retainedTaskContent);
                    assert.ok(restoredContent.endsWith(originalContent));
                    assert.ok(!restoredContent.includes(MANAGED_START));
                    assert.ok(!restoredContent.includes(MANAGED_END));
                } else {
                    assert.equal(fs.readFileSync(restoredPath, 'utf8'), originalContent);
                }
            }
        } finally {
            fs.rmSync(workspaceRoot, { recursive: true, force: true });
        }
    });
});
