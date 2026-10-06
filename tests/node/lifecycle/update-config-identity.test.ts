import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runUpdate } from '../../../src/lifecycle/update';
import { runContractMigrations } from '../../../src/lifecycle/contract-migrations';
import { formatManifestResult, formatVerifyResult, runVerify, validateManifest } from '../../../src/validators';
import { writeProtectedControlPlaneManifest } from '../../../src/gates/shared/helpers';
import {
    getCurrentWorkflowConfigChanges,
    getWorkflowConfigWorkViolations
} from '../../../src/gates/workflow-config/workflow-config-work-changes';
import { getTaskModeEvidence } from '../../../src/gates/task-mode';
import {
    initializeGitRepo,
    runGit,
    seedTaskQueue
} from '../cli/commands/gate-test-helpers';
import { findRepoRoot, setupTestWorkspace, writeInitAnswers } from '../materialization/install-workspace-builder';

const TASK_ID = 'T-UPDATE-IDENTITY';
const CONFIG_PATH = 'garda-agent-orchestrator/live/config/workflow-config.json';

function runNativeCli(projectRoot: string, args: string[]) {
    const result = spawnSync(process.execPath, [
        path.join(projectRoot, 'garda-agent-orchestrator', 'bin', 'garda.js'),
        ...args
    ], {
        cwd: projectRoot,
        encoding: 'utf8',
        windowsHide: true,
        env: { ...process.env, GARDA_UPDATE_CHECK: '0' },
        timeout: 60_000,
        maxBuffer: 8 * 1024 * 1024
    });
    assert.equal(result.error, undefined);
    return result;
}

function nativeCli(projectRoot: string, args: string[]): string {
    const result = runNativeCli(projectRoot, args);
    assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr}\n${result.stdout}`);
    return result.stdout;
}

function readNextStep(projectRoot: string): { next_gate: string; reason: string } {
    return JSON.parse(nativeCli(projectRoot, ['next-step', TASK_ID, '--repo-root', '.', '--as-json']));
}

function refreshNativeTaskStartup(projectRoot: string): void {
    nativeCli(projectRoot, ['gate', 'load-rule-pack', '--task-id', TASK_ID, '--stage', 'TASK_ENTRY',
        ...['00-core.md', '15-project-memory.md', '40-commands.md', '80-task-workflow.md', '90-skill-catalog.md']
            .flatMap((file) => ['--loaded-rule-file', `garda-agent-orchestrator/live/docs/agent-rules/${file}`]),
        '--repo-root', '.']);
    nativeCli(projectRoot, ['gate', 'handshake-diagnostics', '--task-id', TASK_ID, '--repo-root', '.']);
    nativeCli(projectRoot, ['gate', 'shell-smoke-preflight', '--task-id', TASK_ID, '--repo-root', '.']);
}

function createActiveUpdateWorkspace(serialize: (value: unknown) => string) {
    const sourceRoot = findRepoRoot();
    const { projectRoot, bundleRoot } = setupTestWorkspace(sourceRoot);
    try {
        const packageFiles = JSON.parse(fs.readFileSync(path.join(sourceRoot, 'package.json'), 'utf8')).files as string[];
        for (const item of packageFiles) {
            const source = path.join(sourceRoot, item);
            if (fs.existsSync(source)) {
                fs.mkdirSync(path.dirname(path.join(bundleRoot, item)), { recursive: true });
                fs.cpSync(source, path.join(bundleRoot, item), { recursive: true, preserveTimestamps: true });
            }
        }
        fs.rmSync(path.join(projectRoot, '.git'), { recursive: true, force: true });
        fs.mkdirSync(path.join(projectRoot, 'src'));
        fs.writeFileSync(path.join(projectRoot, 'src', 'app.js'), 'module.exports = { enabled: false };\n');
        seedTaskQueue(projectRoot, TASK_ID, 'TODO', 'balanced');
        const answersPath = writeInitAnswers(bundleRoot, {
            AssistantLanguage: 'English',
            AssistantBrevity: 'concise',
            SourceOfTruth: 'Codex',
            EnforceNoAutoCommit: 'false',
            ClaudeOrchestratorFullAccess: 'false',
            TokenEconomyEnabled: 'true',
            CollectedVia: 'CLI_NONINTERACTIVE'
        });
        const configPath = path.join(projectRoot, CONFIG_PATH);
        fs.mkdirSync(path.dirname(configPath), { recursive: true });
        fs.writeFileSync(configPath, JSON.stringify({ compile_gate: { command: 'node --check src/app.js' } }));
        initializeGitRepo(projectRoot);
        const updateOptions: Parameters<typeof runUpdate>[0] = {
            targetRoot: projectRoot,
            bundleRoot,
            initAnswersPath: answersPath,
            contractMigrationRunner: runContractMigrations,
            verifyRunner(verifyOptions) {
                const result = runVerify(verifyOptions);
                if (!result.passed) throw new Error(formatVerifyResult(result));
                return result;
            },
            manifestRunner(manifestOptions) {
                const result = validateManifest(path.join(bundleRoot, 'MANIFEST.md'), manifestOptions.targetRoot);
                if (!result.passed) throw new Error(formatManifestResult(result));
                return result;
            }
        };
        const initialUpdate = runUpdate(updateOptions);
        assert.equal(initialUpdate.materializationStatus, 'PASS');
        assert.equal(initialUpdate.contractMigrationStatus, 'PASS');
        assert.equal(initialUpdate.verifyStatus, 'PASS');
        assert.equal(initialUpdate.manifestValidationStatus, 'PASS');
        fs.writeFileSync(configPath, serialize(JSON.parse(fs.readFileSync(configPath, 'utf8'))));
        writeProtectedControlPlaneManifest(projectRoot);
        runGit(projectRoot, ['add', '.']);
        runGit(projectRoot, ['-c', 'core.hooksPath=', 'commit', '-m', 'test: materialized update baseline']);

        nativeCli(projectRoot, ['gate', 'enter-task-mode', '--task-id', TASK_ID,
            '--entry-mode', 'EXPLICIT_TASK_EXECUTION', '--requested-depth', '2',
            '--task-summary', 'Update app flow', '--provider', 'Codex', '--repo-root', '.']);
        refreshNativeTaskStartup(projectRoot);
        return { projectRoot, bundleRoot, configPath, updateOptions };
    } catch (error) {
        fs.rmSync(projectRoot, { recursive: true, force: true });
        throw error;
    }
}

describe('real update preserves the active task configuration identity', () => {
    for (const [format, serialize] of Object.entries({
        compact: (value: unknown) => JSON.stringify(value),
        pretty: (value: unknown) => JSON.stringify(value, null, 4) + '\r\n'
    })) {
        it(`resumes native next-step after an unchanged ${format} update and rejects manual byte edits`, () => {
            const fixture = createActiveUpdateWorkspace(serialize);
            try {
                const originalConfig = fs.readFileSync(fixture.configPath);
                const modePath = path.join(fixture.bundleRoot, 'runtime', 'reviews', `${TASK_ID}-task-mode.json`);
                const originalMode = fs.readFileSync(modePath);
                assert.equal(readNextStep(fixture.projectRoot).next_gate, 'classify-change');

                const update = runUpdate(fixture.updateOptions);

                assert.equal(update.materializationStatus, 'PASS');
                assert.equal(update.contractMigrationStatus, 'PASS');
                assert.equal(update.verifyStatus, 'PASS');
                assert.equal(update.manifestValidationStatus, 'PASS');
                assert.deepEqual(fs.readFileSync(fixture.configPath), originalConfig);
                assert.deepEqual(fs.readFileSync(modePath), originalMode);
                const resume = readNextStep(fixture.projectRoot);
                if (resume.next_gate === 'load-rule-pack') {
                    refreshNativeTaskStartup(fixture.projectRoot);
                }
                const refreshed = readNextStep(fixture.projectRoot);
                assert.equal(refreshed.next_gate, 'classify-change', refreshed.reason);
                assert.deepEqual(fs.readFileSync(modePath), originalMode);
                const mode = getTaskModeEvidence(fixture.projectRoot, TASK_ID);
                const changes = getCurrentWorkflowConfigChanges(fixture.projectRoot, mode.workflow_config_file_hashes);
                assert.deepEqual(changes.changed_files, []);

                fs.appendFileSync(fixture.configPath, '\n');
                const edited = getCurrentWorkflowConfigChanges(fixture.projectRoot, mode.workflow_config_file_hashes);
                assert.deepEqual(edited.changed_files, [CONFIG_PATH]);
                assert.ok(getWorkflowConfigWorkViolations({
                    repoRoot: fixture.projectRoot,
                    changedFiles: edited.changed_files,
                    taskModeEvidence: mode,
                    phaseLabel: 'native update resume',
                    baselineFileHashes: edited.baseline_file_hashes,
                    currentFileHashes: edited.current_file_hashes
                }).length > 0);
                const blocked = readNextStep(fixture.projectRoot);
                assert.notEqual(blocked.next_gate, 'classify-change');
                assert.match(blocked.reason, /workflow.config|protected control.plane/i);

                fs.writeFileSync(fixture.configPath, originalConfig);
                for (const [mutation, rejection] of [
                    [{ task_id: 'T-FOREIGN' }, /Task-mode entry evidence task mismatch/],
                    [{ workflow_config_file_hashes: { ...mode.workflow_config_file_hashes, [CONFIG_PATH]: 'f'.repeat(64) } }, /Workflow config files changed/]
                ] as const) {
                    fs.writeFileSync(modePath, JSON.stringify({ ...JSON.parse(originalMode.toString()), ...mutation }));
                    const rejected = runNativeCli(fixture.projectRoot, [
                        'gate', 'classify-change', '--task-id', TASK_ID,
                        '--task-intent', 'Update app flow', '--repo-root', '.'
                    ]);
                    assert.equal(rejected.status, 1, rejected.stdout + rejected.stderr);
                    assert.match(rejected.stdout + rejected.stderr, rejection);
                    fs.writeFileSync(modePath, originalMode);
                }
                assert.deepEqual(fs.readFileSync(modePath), originalMode);
                assert.deepEqual(getCurrentWorkflowConfigChanges(
                    fixture.projectRoot, mode.workflow_config_file_hashes
                ).changed_files, []);
            } finally {
                fs.rmSync(fixture.projectRoot, { recursive: true, force: true });
            }
        });
    }
});
