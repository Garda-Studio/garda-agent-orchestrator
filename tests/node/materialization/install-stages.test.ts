import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { getRequiredReviewSkillBridgeHostEntry } from '../../../src/core/provider-registry';
import {
    extractManagedBlockFromContent,
    getTaskQueueRowsFromManagedBlock,
    MANAGED_END,
    MANAGED_START,
    setTaskQueueRowsInManagedBlock
} from '../../../src/materialization/content-builders';
import {
    runInstallPrimaryEntrypointStage,
    runInstallProviderEntrypointStage
} from '../../../src/materialization/install/install-entrypoint-stage';
import { runInstallFinalizationStage } from '../../../src/materialization/install/install-finalization-stage';
import { createInstallFilesystemStage } from '../../../src/materialization/install/install-filesystem-stage';
import {
    runInstallEditorSettingsStage,
    runInstallIgnoreStage
} from '../../../src/materialization/install/install-settings-stage';
import { runInstallTaskStage } from '../../../src/materialization/install/install-task-stage';

function findRepoRoot(): string {
    let current = __dirname;
    while (current !== path.dirname(current)) {
        if (
            fs.existsSync(path.join(current, 'VERSION'))
            && fs.existsSync(path.join(current, 'template'))
        ) {
            return current;
        }
        current = path.dirname(current);
    }
    throw new Error('Cannot find repo root');
}

function createFilesystemStage(targetRoot: string, dryRun = false) {
    return createInstallFilesystemStage({
        targetRoot,
        backupRoot: path.join(targetRoot, 'runtime', 'backups', 'install-stage-test'),
        dryRun,
        skipBackups: false,
        deploymentDate: '2026-07-30',
        canonicalEntryFile: 'AGENTS.md'
    });
}

function writeLegacyManagedEntrypoint(targetRoot: string, relativePath: string): void {
    const entrypointPath = path.join(targetRoot, relativePath);
    fs.mkdirSync(path.dirname(entrypointPath), { recursive: true });
    fs.writeFileSync(
        entrypointPath,
        `${MANAGED_START}\nlegacy managed content\n${MANAGED_END}\n`,
        'utf8'
    );
}

describe('install materialization stages', () => {
    const repoRoot = findRepoRoot();

    it('materializes TASK.md through the task-stage filesystem contract', () => {
        const targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-install-task-stage-'));
        const sourceRoot = path.join(targetRoot, 'bundle-template');
        try {
            fs.mkdirSync(sourceRoot, { recursive: true });
            fs.copyFileSync(
                path.join(repoRoot, 'template', 'TASK.md'),
                path.join(sourceRoot, 'TASK.md')
            );
            const filesystem = createFilesystemStage(targetRoot);

            runInstallTaskStage({
                sourceRoot,
                targetRoot,
                dryRun: false,
                preserveExisting: true,
                answerDependentOnly: false,
                filesystem
            });

            const taskContent = fs.readFileSync(
                path.join(targetRoot, 'TASK.md'),
                'utf8'
            );
            assert.equal(taskContent.includes('{{DEPLOYMENT_DATE}}'), false);
            assert.equal(taskContent.includes('{{CANONICAL_ENTRYPOINT}}'), false);
            assert.match(taskContent, /2026-07-30/);
            assert.match(taskContent, /AGENTS\.md/);
            assert.equal(filesystem.metrics.deployed, 1);
        } finally {
            fs.rmSync(targetRoot, { recursive: true, force: true });
        }
    });

    it('backs up existing TASK.md before task-stage materialization', () => {
        const targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-install-task-backup-stage-'));
        const sourceRoot = path.join(targetRoot, 'bundle-template');
        const existingTaskContent = '# Operator queue\n\n| ID | Status |\n|---|---|\n| T-1 | TODO |\n';
        try {
            fs.mkdirSync(sourceRoot, { recursive: true });
            fs.copyFileSync(
                path.join(repoRoot, 'template', 'TASK.md'),
                path.join(sourceRoot, 'TASK.md')
            );
            fs.writeFileSync(path.join(targetRoot, 'TASK.md'), existingTaskContent, 'utf8');
            const filesystem = createFilesystemStage(targetRoot);

            runInstallTaskStage({
                sourceRoot,
                targetRoot,
                dryRun: false,
                preserveExisting: true,
                answerDependentOnly: false,
                filesystem
            });

            assert.equal(
                fs.readFileSync(
                    path.join(targetRoot, 'runtime', 'backups', 'install-stage-test', 'TASK.md'),
                    'utf8'
                ),
                existingTaskContent
            );
            assert.equal(filesystem.metrics.backedUp, 1);
        } finally {
            fs.rmSync(targetRoot, { recursive: true, force: true });
        }
    });

    it('rejects external and dangling TASK.md symlinks before backup in both task-stage branches', (t) => {
        let checkedCases = 0;
        for (const answerDependentOnly of [false, true]) {
            for (const targetExists of [true, false]) {
                const targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-install-task-symlink-stage-'));
                const externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-install-task-external-'));
                const sourceRoot = path.join(targetRoot, 'bundle-template');
                const externalTaskPath = path.join(externalRoot, 'external-TASK.md');
                const taskPath = path.join(targetRoot, 'TASK.md');
                try {
                    fs.mkdirSync(sourceRoot, { recursive: true });
                    fs.copyFileSync(
                        path.join(repoRoot, 'template', 'TASK.md'),
                        path.join(sourceRoot, 'TASK.md')
                    );
                    if (targetExists) {
                        fs.writeFileSync(externalTaskPath, '# External private content\n', 'utf8');
                    }
                    try {
                        fs.symlinkSync(externalTaskPath, taskPath, 'file');
                    } catch (error) {
                        if ((error as NodeJS.ErrnoException).code === 'EPERM') {
                            t.skip('Creating file symlinks requires an unavailable Windows privilege.');
                            return;
                        }
                        throw error;
                    }
                    const filesystem = createFilesystemStage(targetRoot);

                    assert.throws(
                        () => runInstallTaskStage({
                            sourceRoot,
                            targetRoot,
                            dryRun: false,
                            preserveExisting: true,
                            answerDependentOnly,
                            filesystem
                        }),
                        /GARDA_INSTALL_BLOCKED: TASK\.md must be a regular file inside target root/
                    );
                    assert.equal(
                        fs.existsSync(
                            path.join(targetRoot, 'runtime', 'backups', 'install-stage-test', 'TASK.md')
                        ),
                        false
                    );
                    if (targetExists) {
                        assert.equal(fs.readFileSync(externalTaskPath, 'utf8'), '# External private content\n');
                    } else {
                        assert.equal(fs.existsSync(externalTaskPath), false);
                    }
                    assert.equal(filesystem.metrics.backedUp, 0);
                    assert.equal(fs.lstatSync(taskPath).isSymbolicLink(), true);
                    assert.equal(fs.readlinkSync(taskPath), externalTaskPath);
                    checkedCases += 1;
                } finally {
                    fs.rmSync(targetRoot, { recursive: true, force: true });
                    fs.rmSync(externalRoot, { recursive: true, force: true });
                }
            }
        }
        assert.equal(checkedCases, 4);
    });

    it('preserves an intentionally empty managed queue in both task-stage branches', () => {
        for (const answerDependentOnly of [false, true]) {
            const targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-install-task-empty-queue-stage-'));
            const sourceRoot = path.join(targetRoot, 'bundle-template');
            const taskPath = path.join(targetRoot, 'TASK.md');
            try {
                fs.mkdirSync(sourceRoot, { recursive: true });
                const templateContent = fs.readFileSync(
                    path.join(repoRoot, 'template', 'TASK.md'),
                    'utf8'
                );
                fs.writeFileSync(path.join(sourceRoot, 'TASK.md'), templateContent, 'utf8');
                const operatorSuffix = '\n## Operator Notes\n\nKeep this suffix.\n';
                const emptyQueueContent = `${setTaskQueueRowsInManagedBlock(templateContent, [])}${operatorSuffix}`;
                fs.writeFileSync(taskPath, emptyQueueContent, 'utf8');
                const filesystem = createFilesystemStage(targetRoot);

                runInstallTaskStage({
                    sourceRoot,
                    targetRoot,
                    dryRun: false,
                    preserveExisting: true,
                    answerDependentOnly,
                    filesystem
                });

                const installedContent = fs.readFileSync(taskPath, 'utf8');
                const installedBlock = extractManagedBlockFromContent(
                    installedContent,
                    MANAGED_START,
                    MANAGED_END
                );
                assert.ok(installedBlock);
                assert.deepEqual(getTaskQueueRowsFromManagedBlock(installedBlock), []);
                assert.ok(installedContent.endsWith(operatorSuffix));
                assert.equal(
                    fs.readFileSync(
                        path.join(targetRoot, 'runtime', 'backups', 'install-stage-test', 'TASK.md'),
                        'utf8'
                    ),
                    emptyQueueContent
                );
            } finally {
                fs.rmSync(targetRoot, { recursive: true, force: true });
            }
        }
    });

    it('preserves realistic queue rows and operator suffix in both task-stage branches', () => {
        const operatorRows = [
            '| T-501 | 🟨 IN_PROGRESS | P0 | lifecycle | Preserve first row | codex | 2026-08-06 | strict | First note stays byte-stable. |',
            '| T-502-F1 | 🟦 TODO | P2 | review/follow-up | Keep follow-up status | codex | 2026-08-06 | balanced | Notes include commas, hashes, and `inline code`. |',
            '| T-503 | 🟩 DONE | P3 | docs | Preserve completed row | codex | 2026-08-05 | docs-only | Final row remains last. |'
        ];
        const operatorSuffix = '\n## Operator Notes\n\nKeep this suffix across reinitialization.\n';

        for (const answerDependentOnly of [false, true]) {
            const targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-install-task-realistic-queue-stage-'));
            const sourceRoot = path.join(targetRoot, 'bundle-template');
            const taskPath = path.join(targetRoot, 'TASK.md');
            try {
                fs.mkdirSync(sourceRoot, { recursive: true });
                const templateContent = fs.readFileSync(
                    path.join(repoRoot, 'template', 'TASK.md'),
                    'utf8'
                );
                fs.writeFileSync(path.join(sourceRoot, 'TASK.md'), templateContent, 'utf8');
                const operatorManagedContent = setTaskQueueRowsInManagedBlock(
                    templateContent,
                    operatorRows
                );
                const operatorManagedBlock = extractManagedBlockFromContent(
                    operatorManagedContent,
                    MANAGED_START,
                    MANAGED_END
                );
                assert.ok(operatorManagedBlock);
                const originalOperatorRows = getTaskQueueRowsFromManagedBlock(operatorManagedBlock);
                const operatorTaskContent = `${operatorManagedContent}${operatorSuffix}`;
                fs.writeFileSync(taskPath, operatorTaskContent, 'utf8');
                const filesystem = createFilesystemStage(targetRoot);

                runInstallTaskStage({
                    sourceRoot,
                    targetRoot,
                    dryRun: false,
                    preserveExisting: true,
                    answerDependentOnly,
                    filesystem
                });

                const installedContent = fs.readFileSync(taskPath, 'utf8');
                const installedBlock = extractManagedBlockFromContent(
                    installedContent,
                    MANAGED_START,
                    MANAGED_END
                );
                assert.ok(installedBlock);
                assert.deepEqual(
                    getTaskQueueRowsFromManagedBlock(installedBlock),
                    originalOperatorRows,
                    `queue rows must remain byte-stable when answerDependentOnly=${answerDependentOnly}`
                );
                assert.ok(installedContent.endsWith(operatorSuffix));
                assert.equal(
                    fs.readFileSync(
                        path.join(targetRoot, 'runtime', 'backups', 'install-stage-test', 'TASK.md'),
                        'utf8'
                    ),
                    operatorTaskContent
                );
            } finally {
                fs.rmSync(targetRoot, { recursive: true, force: true });
            }
        }
    });

    it('does not create TASK.md backups during dry-run in either task-stage branch', () => {
        for (const answerDependentOnly of [false, true]) {
            const targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-install-task-dry-run-stage-'));
            const sourceRoot = path.join(targetRoot, 'bundle-template');
            const taskPath = path.join(targetRoot, 'TASK.md');
            const existingTaskContent = '# Operator queue\n\nDry-run content must remain unchanged.\n';
            try {
                fs.mkdirSync(sourceRoot, { recursive: true });
                fs.copyFileSync(
                    path.join(repoRoot, 'template', 'TASK.md'),
                    path.join(sourceRoot, 'TASK.md')
                );
                fs.writeFileSync(taskPath, existingTaskContent, 'utf8');
                const filesystem = createFilesystemStage(targetRoot, true);

                runInstallTaskStage({
                    sourceRoot,
                    targetRoot,
                    dryRun: true,
                    preserveExisting: true,
                    answerDependentOnly,
                    filesystem
                });

                assert.equal(fs.readFileSync(taskPath, 'utf8'), existingTaskContent);
                assert.equal(
                    fs.existsSync(
                        path.join(targetRoot, 'runtime', 'backups', 'install-stage-test', 'TASK.md')
                    ),
                    false
                );
                assert.equal(filesystem.metrics.backedUp, 0);
            } finally {
                fs.rmSync(targetRoot, { recursive: true, force: true });
            }
        }
    });

    it('materializes canonical, redirect, and shared router entrypoints through explicit stages', () => {
        const targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-install-entry-stage-'));
        try {
            const filesystem = createFilesystemStage(targetRoot);
            runInstallPrimaryEntrypointStage({
                sourceRoot: path.join(repoRoot, 'template'),
                canonicalEntryFile: 'AGENTS.md',
                redirectEntryFiles: ['CLAUDE.md'],
                providerBridgePaths: [],
                filesystem
            });
            const providerResult = runInstallProviderEntrypointStage({
                targetRoot,
                canonicalEntryFile: 'AGENTS.md',
                redirectEntryFiles: ['CLAUDE.md'],
                providerOrchestratorProfiles: [],
                githubSkillBridgeProfiles: [],
                providerMinimalism: false,
                reviewSkillBridgeHostEntrypoint:
                    getRequiredReviewSkillBridgeHostEntry().entrypointFile,
                providerBridgePaths: [],
                filesystem
            });

            assert.match(
                fs.readFileSync(path.join(targetRoot, 'AGENTS.md'), 'utf8'),
                /garda-agent-orchestrator:managed-start/
            );
            assert.match(
                fs.readFileSync(path.join(targetRoot, 'CLAUDE.md'), 'utf8'),
                /This file is a redirect\./
            );
            assert.ok(fs.existsSync(path.join(
                targetRoot,
                '.agents',
                'workflows',
                'start-task.md'
            )));
            assert.equal(providerResult.preserved, 0);
        } finally {
            fs.rmSync(targetRoot, { recursive: true, force: true });
        }
    });

    it('preserves an existing managed provider entrypoint when minimalism is disabled', () => {
        const targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-install-preserve-stage-'));
        const legacyEntrypoint = 'GEMINI.md';
        try {
            writeLegacyManagedEntrypoint(targetRoot, legacyEntrypoint);
            const filesystem = createFilesystemStage(targetRoot);

            const result = runInstallProviderEntrypointStage({
                targetRoot,
                canonicalEntryFile: 'AGENTS.md',
                redirectEntryFiles: [],
                providerOrchestratorProfiles: [],
                githubSkillBridgeProfiles: [],
                providerMinimalism: false,
                reviewSkillBridgeHostEntrypoint:
                    getRequiredReviewSkillBridgeHostEntry().entrypointFile,
                providerBridgePaths: [],
                filesystem
            });

            const content = fs.readFileSync(
                path.join(targetRoot, legacyEntrypoint),
                'utf8'
            );
            assert.equal(result.preserved, 1);
            assert.match(content, /This file is a redirect\./);
            assert.match(content, /AGENTS\.md/);
            assert.equal(content.includes('legacy managed content'), false);
        } finally {
            fs.rmSync(targetRoot, { recursive: true, force: true });
        }
    });

    it('removes a stale managed provider entrypoint when minimalism is enabled', () => {
        const targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-install-minimal-stage-'));
        const staleEntrypoint = 'GEMINI.md';
        try {
            writeLegacyManagedEntrypoint(targetRoot, staleEntrypoint);
            const filesystem = createFilesystemStage(targetRoot);

            const result = runInstallProviderEntrypointStage({
                targetRoot,
                canonicalEntryFile: 'AGENTS.md',
                redirectEntryFiles: [],
                providerOrchestratorProfiles: [],
                githubSkillBridgeProfiles: [],
                providerMinimalism: true,
                reviewSkillBridgeHostEntrypoint:
                    getRequiredReviewSkillBridgeHostEntry().entrypointFile,
                providerBridgePaths: [],
                filesystem
            });

            assert.equal(result.preserved, 0);
            assert.equal(
                fs.existsSync(path.join(targetRoot, staleEntrypoint)),
                false
            );
            assert.equal(filesystem.metrics.aligned, 1);
        } finally {
            fs.rmSync(targetRoot, { recursive: true, force: true });
        }
    });

    it('materializes editor and ignore settings through separate stage contracts', () => {
        const targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-install-settings-stage-'));
        const bundleRoot = path.join(targetRoot, 'garda-agent-orchestrator');
        try {
            fs.mkdirSync(bundleRoot, { recursive: true });
            const filesystem = createFilesystemStage(targetRoot);
            const editorResult = runInstallEditorSettingsStage({
                targetRoot,
                dryRun: false,
                preserveExisting: true,
                canonicalEntryFile: 'AGENTS.md',
                enableClaudeOrchestratorFullAccess: true,
                filesystem
            });
            const ignoreResult = runInstallIgnoreStage({
                targetRoot,
                bundleRoot,
                dryRun: false,
                activeEntryFiles: ['AGENTS.md'],
                providerOrchestratorProfiles: [],
                enableClaudeOrchestratorFullAccess: true,
                providerMinimalism: true,
                qwenExists: editorResult.qwenExists,
                filesystem
            });

            assert.equal(editorResult.qwenSettingsParseMode, 'not-present');
            assert.equal(editorResult.claudeLocalSettingsUpdated, true);
            assert.equal(editorResult.vscodeSettingsUpdated, true);
            assert.ok(fs.existsSync(path.join(
                targetRoot,
                '.claude',
                'settings.local.json'
            )));
            assert.ok(fs.existsSync(path.join(
                targetRoot,
                '.vscode',
                'settings.json'
            )));
            assert.ok(ignoreResult.gitignoreEntriesAdded > 0);
            assert.equal(ignoreResult.agentignoreUpdated, true);
        } finally {
            fs.rmSync(targetRoot, { recursive: true, force: true });
        }
    });

    it('invokes init and writes version evidence through the finalization stage', () => {
        const targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-install-final-stage-'));
        const liveVersionPath = path.join(
            targetRoot,
            'garda-agent-orchestrator',
            'live',
            'version.json'
        );
        let capturedSourceOfTruth = '';
        try {
            const result = runInstallFinalizationStage({
                targetRoot,
                normalizedTarget: path.resolve(targetRoot),
                liveVersionPath,
                dryRun: false,
                switchModeBeforeInstall: 'on',
                bundleVersion: '1.2.0',
                resolvedInitPath: path.join(targetRoot, 'runtime', 'init-answers.json'),
                sourceOfTruth: 'Codex',
                canonicalEntryFile: 'AGENTS.md',
                activeEntryFiles: ['AGENTS.md'],
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                enforceNoAutoCommit: false,
                enableClaudeOrchestratorFullAccess: false,
                tokenEconomyEnabled: true,
                providerMinimalism: true,
                runInit: true,
                initRunner: (options) => {
                    capturedSourceOfTruth = options.sourceOfTruth;
                    return { workflowConfigMergeStatus: 'stage-test' };
                },
                activeEntryFilesSeed: 'AGENTS.md',
                preserveLegacyReviewExecutionPolicyOmission: false
            });

            const version = JSON.parse(
                fs.readFileSync(liveVersionPath, 'utf8')
            ) as Record<string, unknown>;
            assert.equal(capturedSourceOfTruth, 'Codex');
            assert.equal(result.initInvoked, true);
            assert.equal(
                result.initResult?.workflowConfigMergeStatus,
                'stage-test'
            );
            assert.equal(result.liveVersionWritten, true);
            assert.equal(result.protectedControlPlaneManifestWritten, true);
            assert.equal(version.CanonicalEntrypoint, 'AGENTS.md');
            assert.equal(version.ActiveAgentFiles, 'AGENTS.md');
        } finally {
            fs.rmSync(targetRoot, { recursive: true, force: true });
        }
    });
});
