import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { mergeWorkflowConfigWithTemplate, resolveWorkflowConfigTemplateDefaults } from '../../../src/core/workflow-config';
import { PROJECT_MEMORY_REQUIRED_FILE_NAMES } from '../../../src/core/project-memory';
import { UNCONFIGURED_COMPILE_GATE_COMMAND } from '../../../src/core/constants';
import { parseCanonicalActiveTaskQueue } from '../../../src/core/task-md-table';
import { runUpdate } from '../../../src/lifecycle/update';
import { runContractMigrations } from '../../../src/lifecycle/contract-migrations';
import { formatManifestResult, formatVerifyResult, runVerify, validateManifest } from '../../../src/validators';
import { writeProtectedControlPlaneManifest } from '../../../src/gates/shared/helpers';
import {
    getCurrentWorkflowConfigChanges,
    getWorkflowConfigWorkViolations
} from '../../../src/gates/workflow-config/workflow-config-work-changes';
import { getTaskModeEvidence } from '../../../src/gates/task-mode';
import { buildQualityChecklistAnswersTemplate } from '../../../src/gates/quality-checklist';
import { executeValidationRecipe } from '../../../src/gates/project-validation/execution';
import { evaluateValidationAttempt, readValidationAttemptFacts } from '../../../src/gates/project-validation/result-evaluation';
import { getProjectDiscovery } from '../../../src/materialization/project-discovery';
import {
    initializeGitRepo,
    runGit,
    seedTaskQueue
} from '../cli/commands/gate-test-helpers';
import { findRepoRoot, setupTestWorkspace, writeInitAnswers } from '../materialization/install-workspace-builder';

const TASK_ID = 'T-UPDATE-IDENTITY';
const CONFIG_PATH = 'garda-agent-orchestrator/live/config/workflow-config.json';

function runNativeCli(projectRoot: string, args: string[], sourceRoot?: string) {
    const environment: NodeJS.ProcessEnv = { ...process.env, GARDA_UPDATE_CHECK: '0' };
    delete environment.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, [
        path.join(sourceRoot || path.join(projectRoot, 'garda-agent-orchestrator'), 'bin', 'garda.js'),
        ...args
    ], {
        cwd: projectRoot,
        encoding: 'utf8',
        windowsHide: true,
        env: environment,
        timeout: sourceRoot ? 180_000 : 60_000,
        maxBuffer: 8 * 1024 * 1024
    });
    assert.equal(result.error, undefined);
    return result;
}

function nativeCli(projectRoot: string, args: string[], sourceRoot?: string): string {
    const result = runNativeCli(projectRoot, args, sourceRoot);
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

interface ProjectSetupScenario {
    sourceRoot: string;
    files: Record<string, string>;
    compileCommand: string;
    suiteCommand: string;
    deferTaskEntry: boolean;
}

function enterFixtureTask(projectRoot: string): void {
    nativeCli(projectRoot, ['gate', 'enter-task-mode', '--task-id', TASK_ID,
        '--entry-mode', 'EXPLICIT_TASK_EXECUTION', '--requested-depth', '2',
        '--task-summary', 'Update app flow', '--provider', 'Codex', '--repo-root', '.']);
    refreshNativeTaskStartup(projectRoot);
}

function createActiveUpdateWorkspace(serialize: (value: unknown) => string, scenario?: ProjectSetupScenario) {
    const sourceRoot = findRepoRoot();
    const installSource = scenario?.sourceRoot || sourceRoot;
    const { projectRoot, bundleRoot } = setupTestWorkspace(installSource);
    try {
        const packageFiles = JSON.parse(fs.readFileSync(path.join(installSource, 'package.json'), 'utf8')).files as string[];
        for (const item of packageFiles) {
            const source = path.join(installSource, item);
            if (fs.existsSync(source)) {
                fs.mkdirSync(path.dirname(path.join(bundleRoot, item)), { recursive: true });
                fs.cpSync(source, path.join(bundleRoot, item), { recursive: true, preserveTimestamps: true });
            }
        }
        fs.rmSync(path.join(projectRoot, '.git'), { recursive: true, force: true });
        fs.mkdirSync(path.join(projectRoot, 'src'));
        fs.writeFileSync(path.join(projectRoot, 'src', 'app.js'), 'module.exports = { enabled: false };\n');
        for (const [file, content] of Object.entries(scenario?.files || {})) {
            fs.mkdirSync(path.dirname(path.join(projectRoot, file)), { recursive: true });
            fs.writeFileSync(path.join(projectRoot, file), content);
        }
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
        fs.writeFileSync(configPath, JSON.stringify({
            compile_gate: { command: scenario
                ? scenario.deferTaskEntry ? UNCONFIGURED_COMPILE_GATE_COMMAND : scenario.compileCommand
                : 'node --check src/app.js' },
            ...(scenario && !scenario.deferTaskEntry
                ? { full_suite_validation: { enabled: true, command: scenario.suiteCommand } } : {})
        }));
        if (scenario) {
            // Let the real installer establish its ignore policy before the first project commit.
            runGit(projectRoot, ['-c', 'init.defaultBranch=main', 'init']);
            for (const [key, value] of Object.entries({
                'user.name': 'Garda Tests', 'user.email': 'garda-tests@example.com',
                'commit.gpgsign': 'false', 'core.autocrlf': 'false'
            })) runGit(projectRoot, ['config', key, value]);
        } else initializeGitRepo(projectRoot);
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
        if (scenario) {
            nativeCli(projectRoot, ['install', '--target-root', '.', '--init-answers-path', answersPath], installSource);
            if (!scenario.deferTaskEntry) {
                writeProjectMemoryFromInstructions(projectRoot);
                nativeCli(projectRoot, ['agent-init', '--target-root', '.', '--active-agent-files', 'AGENTS.md',
                    '--project-rules-updated', 'yes', '--skills-prompted', 'yes', '--ordinary-doc-paths', 'CHANGELOG.md']);
            }
            nativeCli(projectRoot, ['workflow', 'set', '--target-root', '.',
                ...(!scenario.deferTaskEntry ? ['--compile-gate-command', scenario.compileCommand,
                    '--full-suite-command', scenario.suiteCommand, '--full-suite-enabled', 'true'] : []),
                '--local-commit-enabled', 'true',
                '--operator-confirmed', 'yes', '--operator-confirmed-at-utc', new Date().toISOString()]);
        } else {
            const initialUpdate = runUpdate(updateOptions);
            assert.equal(initialUpdate.materializationStatus, 'PASS');
            assert.equal(initialUpdate.contractMigrationStatus, 'PASS');
            assert.equal(initialUpdate.verifyStatus, 'PASS');
            assert.equal(initialUpdate.manifestValidationStatus, 'PASS');
            fs.writeFileSync(configPath, serialize(JSON.parse(fs.readFileSync(configPath, 'utf8'))));
            writeProtectedControlPlaneManifest(projectRoot);
        }
        seedTaskQueue(projectRoot, TASK_ID, 'TODO', 'balanced');
        if (scenario) {
            const queuePath = path.join(projectRoot, 'TASK.md');
            fs.writeFileSync(queuePath, '# TASK.md\n\n## Active Queue\n\n' + fs.readFileSync(queuePath, 'utf8')
                + '\n| T-KEEP-OTHER | TODO | P2 | domain | Preserve unrelated work | queue-owner | 2026-04-17 | balanced | Keep operator notes and exact metadata. |'
                + '\n\n## Operator Notes\n\nKeep the staged rate change and the unstaged purchase expectation.\n');
            assert.equal(runGit(projectRoot, ['ls-files', '--', 'TASK.md', 'garda-agent-orchestrator']).stdout, '',
                'Installer-owned local state must not be tracked as project source.');
        }
        runGit(projectRoot, ['add', '.']);
        runGit(projectRoot, ['-c', 'core.hooksPath=', 'commit', '-m', 'test: materialized update baseline']);

        if (!scenario?.deferTaskEntry) enterFixtureTask(projectRoot);
        return { projectRoot, bundleRoot, configPath, updateOptions };
    } catch (error) {
        fs.rmSync(projectRoot, { recursive: true, force: true });
        throw error;
    }
}

describe('real update preserves the active task configuration identity', () => {
    it('finalizes ordinary agent onboarding without replacing active configured commands', () => {
        const fixture = createActiveUpdateWorkspace(value => JSON.stringify(value, null, 2) + '\n');
        try {
            for (const name of PROJECT_MEMORY_REQUIRED_FILE_NAMES) {
                fs.writeFileSync(path.join(fixture.bundleRoot, 'live/docs/project-memory', name),
                    `# Native onboarding fixture: ${name}\n\n`
                    + 'The project source is src/app.js, a CommonJS module exporting an enabled flag. '
                    + 'The configured compile check is node --check src/app.js. '
                    + 'The existing TASK.md queue and active task remain authoritative during onboarding.\n');
            }
            const modePath = path.join(fixture.bundleRoot, 'runtime', 'reviews', `${TASK_ID}-task-mode.json`);
            const mode = fs.readFileSync(modePath);
            const before = JSON.parse(fs.readFileSync(fixture.configPath, 'utf8'));
            const result = runNativeCli(fixture.projectRoot, ['agent-init', '--target-root', '.',
                '--active-agent-files', 'AGENTS.md', '--project-rules-updated', 'yes',
                '--skills-prompted', 'yes', '--ordinary-doc-paths', 'CHANGELOG.md']);
            const after = JSON.parse(fs.readFileSync(fixture.configPath, 'utf8'));
            const expected = mergeWorkflowConfigWithTemplate(resolveWorkflowConfigTemplateDefaults(JSON.parse(fs.readFileSync(
                path.join(fixture.bundleRoot, 'template/config/workflow-config.json'), 'utf8'))), before,
            { preserveLegacyReviewExecutionPolicyOmission: true });
            const changed = [...new Set([...Object.keys(expected), ...Object.keys(after)])]
                .filter(key => !isDeepStrictEqual(expected[key], after[key]));
            assert.equal(result.status, 0, result.stdout + result.stderr + '\nUnexpected fields: ' + changed.join(', '));
            assert.deepEqual(fs.readFileSync(modePath), mode);
            assert.equal(after.compile_gate.command, before.compile_gate.command);
            assert.equal(after.full_suite_validation.command, before.full_suite_validation.command);
            assert.equal(after.full_suite_validation.enabled, before.full_suite_validation.enabled);
            assert.deepEqual(after.project_validation, before.project_validation);
        } finally { fs.rmSync(fixture.projectRoot, { recursive: true, force: true }); }
    });

    it('continues an active task when update materializes a previously absent default', () => {
        const fixture = createActiveUpdateWorkspace((value) => {
            const config = value as Record<string, unknown>;
            delete config.task_test_selection;
            return JSON.stringify(config, null, 2) + '\n';
        });
        try {
            const modePath = path.join(fixture.bundleRoot, 'runtime', 'reviews', `${TASK_ID}-task-mode.json`);
            const originalMode = fs.readFileSync(modePath);
            const workPath = path.join(fixture.projectRoot, 'src', 'app.js');
            const work = 'module.exports = { enabled: true };\n';
            fs.writeFileSync(workPath, work);
            const update = runUpdate(fixture.updateOptions);
            assert.equal(update.materializationStatus, 'PASS');
            assert.equal(update.verifyStatus, 'PASS');
            assert.equal(fs.readFileSync(workPath, 'utf8'), work);
            assert.deepEqual(fs.readFileSync(modePath), originalMode);
            assert.deepEqual(JSON.parse(fs.readFileSync(fixture.configPath, 'utf8')).task_test_selection,
                { require_operator_confirmation: false });
            const mode = getTaskModeEvidence(fixture.projectRoot, TASK_ID);
            const changes = getCurrentWorkflowConfigChanges(fixture.projectRoot, mode.workflow_config_file_hashes);
            assert.deepEqual(getWorkflowConfigWorkViolations({
                repoRoot: fixture.projectRoot,
                changedFiles: changes.changed_files,
                taskModeEvidence: mode,
                phaseLabel: 'updated defaults resume',
                baselineFileHashes: changes.baseline_file_hashes,
                currentFileHashes: changes.current_file_hashes
            }), []);
            if (readNextStep(fixture.projectRoot).next_gate === 'load-rule-pack') {
                refreshNativeTaskStartup(fixture.projectRoot);
            }
            const resumed = readNextStep(fixture.projectRoot);
            assert.equal(resumed.next_gate, 'classify-change', resumed.reason);
            const migratedConfig = fs.readFileSync(fixture.configPath);
            const auditPath = path.join(fixture.bundleRoot, 'runtime', 'workflow-config-audit.jsonl');
            const audit = fs.readFileSync(auditPath);
            fs.appendFileSync(fixture.configPath, '\n');
            const manualEdit = readNextStep(fixture.projectRoot);
            assert.notEqual(manualEdit.next_gate, 'classify-change', 'a signed migration must not bless a later manual edit');
            fs.writeFileSync(fixture.configPath, migratedConfig);
            const records = audit.toString('utf8').trim().split('\n');
            const last = JSON.parse(records.at(-1)!);
            last.before_sha256 = 'f'.repeat(64);
            records[records.length - 1] = JSON.stringify(last);
            fs.writeFileSync(auditPath, records.join('\n') + '\n');
            assert.notEqual(readNextStep(fixture.projectRoot).next_gate, 'classify-change', 'edited migration provenance must fail closed');
            fs.writeFileSync(auditPath, audit);
            const repeat = runUpdate(fixture.updateOptions);
            assert.equal(repeat.materializationStatus, 'PASS');
            assert.deepEqual(fs.readFileSync(fixture.configPath), migratedConfig);
            assert.deepEqual(fs.readFileSync(auditPath), audit);
            assert.deepEqual(fs.readFileSync(modePath), originalMode);
            assert.equal(fs.readFileSync(workPath, 'utf8'), work);
        } finally {
            fs.rmSync(fixture.projectRoot, { recursive: true, force: true });
        }
    });

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

function projectSetupScenario(sourceRoot: string, deferTaskEntry: boolean): ProjectSetupScenario {
    const compileCommand = 'node tools/project-driver.cjs prepare';
    const suiteCommand = 'node tools/project-driver.cjs judge';
    return { sourceRoot, deferTaskEntry, compileCommand, suiteCommand, files: {
        'PROJECT.md': ['# Project conventions', 'Source rules: units/order.widget',
            'Selected cases: checks/order.case', 'Compile command: ' + compileCommand,
            'Test command: ' + suiteCommand,
            'Use these repository conventions ahead of vendor language examples.'].join('\n'),
        'units/order.widget': '{"rate":0.2}\n',
        'checks/order.case': '[{"id":"purchase","net":100,"expected":120}]\n',
        'notes/domain.md': '# Existing user note\nPreserve exact order validation rules.\n',
        'tools/project-driver.cjs': [
            'const fs = require("node:fs");',
            'const rules = JSON.parse(fs.readFileSync("units/order.widget", "utf8"));',
            'if (!Number.isFinite(rules.rate)) throw new Error("Invalid rate");',
            'if (process.argv[2] === "prepare") console.log("PREPARE OK");',
            'else if (process.argv[2] === "judge") {',
            ' const cases = JSON.parse(fs.readFileSync("checks/order.case", "utf8"))',
            '  .filter(item => !process.argv[3] || item.id === process.argv[3]);',
            ' if (!cases.length) throw new Error("No selected cases");',
            ' for (const item of cases) { const actual = item.net * (1 + rules.rate);',
            '  const passed = actual === item.expected;',
            '  console.log(JSON.stringify({case:item.id,outcome:passed ? "PASSED" : "FAILED",actual}));',
            '  if (!passed) process.exitCode = 1; }',
            '} else throw new Error("Unknown project action");'
        ].join('\n')
    } };
}

function readProjectSetupInstructions(projectRoot: string) {
    const lines = fs.readFileSync(path.join(projectRoot, 'PROJECT.md'), 'utf8').split('\n');
    const read = (prefix: string): string => {
        const line = lines.find(candidate => candidate.startsWith(prefix));
        assert.ok(line, 'The agent must inspect the repository-owned instruction: ' + prefix);
        return line.slice(prefix.length);
    };
    return { source: read('Source rules: '), test: read('Selected cases: '),
        compile: read('Compile command: '), suite: read('Test command: ') };
}

function writeProjectMemoryFromInstructions(projectRoot: string): void {
    const setup = readProjectSetupInstructions(projectRoot);
    for (const name of PROJECT_MEMORY_REQUIRED_FILE_NAMES) {
        fs.writeFileSync(path.join(projectRoot, 'garda-agent-orchestrator/live/docs/project-memory', name),
            '# Project map: ' + name + '\n\nProject conventions are owned by PROJECT.md. '
            + 'Rules in ' + setup.source + ' contain the finite order rate; cases in ' + setup.test
            + ' define purchase inputs and expected totals. tools/project-driver.cjs is the existing executor. '
            + 'Compile uses ' + setup.compile + '; all cases use ' + setup.suite
            + '. Project-defined file roles take precedence over vendor extension examples. '
            + 'The active canonical TASK.md, authentic permissions and user WIP must survive ordinary updates.\n');
    }
}

function completeAgentProjectSetup(projectRoot: string, stage: 'fresh' | 'updated') {
    const bundleRoot = path.join(projectRoot, 'garda-agent-orchestrator');
    const prompt = fs.readFileSync(path.join(bundleRoot, 'AGENT_INIT_PROMPT.md'), 'utf8');
    const guidance = fs.readFileSync(path.join(bundleRoot, 'live/project-discovery.md'), 'utf8');
    assert.match(prompt, /agent, not the user, inspects repository-owned instructions/iu);
    assert.match(prompt, /workflow set --compile-gate-command/u);
    assert.match(prompt, /exact.*source.*test.*file_roles/iu);
    assert.match(prompt, /Actually execute the selected applicable checks/u);
    assert.match(prompt, /same setup check during normal continuation after an update/iu);
    assert.match(guidance, /Coverage: unverified/u);
    assert.match(guidance, /agent must inspect repository-owned instructions/iu);
    const config = JSON.parse(fs.readFileSync(path.join(projectRoot, CONFIG_PATH), 'utf8'));
    const missingCommands = config.compile_gate.command === UNCONFIGURED_COMPILE_GATE_COMMAND;
    const missingRoles = config.project_validation === undefined;
    assert.equal(missingCommands, stage === 'fresh', 'The agent must detect the actual command binding state.');
    assert.equal(missingRoles, true, 'This project requires ordinary agent completion of absent roles.');
    if (missingCommands) {
        const status = JSON.parse(nativeCli(projectRoot, ['status', '--target-root', '.', '--json']));
        assert.equal(status.readyForTasks, false);
        assert.ok(status.missingProjectCommands.includes('compile_gate.command'));
        assert.match(status.recommendedNextCommand, /AGENT_INIT_PROMPT\.md/u);
    }
    // Model the agent following the emitted ordinary guidance, using repository-owned evidence.
    const setup = readProjectSetupInstructions(projectRoot);
    assert.equal(getProjectDiscovery(projectRoot).suggestedFullSuiteValidationCommand, null);
    assert.ok(fs.existsSync(path.join(projectRoot, setup.source)));
    assert.ok(fs.existsSync(path.join(projectRoot, setup.test)));
    const declaration = 'garda-agent-orchestrator/runtime/manual-validation/agent-project-bindings.json';
    fs.mkdirSync(path.dirname(path.join(projectRoot, declaration)), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, declaration), JSON.stringify({ schema_version: 1, recipes: [{
        id: 'purchase-check', purpose: 'test', executable: process.execPath,
        argv: ['tools/project-driver.cjs', 'judge', { target: 'purchase' }], cwd: '.', environment: {},
        inputs: [{ path: setup.source, role: 'source' }, { path: setup.test, role: 'test' },
            { path: 'tools/project-driver.cjs', role: 'helper' }],
        targets: [{ id: 'purchase', source: setup.test, selector: 'purchase' }],
        timeout_ms: 5000, max_attempts: 3, max_output_bytes: 4096, max_input_bytes: 65536,
        required_capabilities: [], result_format: 'opaque'
    }] }));
    nativeCli(projectRoot, ['workflow', 'set', '--target-root', '.',
        '--compile-gate-command', setup.compile, '--full-suite-command', setup.suite,
        '--full-suite-enabled', 'true', '--project-validation-contract', declaration,
        '--operator-confirmed', 'yes', '--operator-confirmed-at-utc', new Date().toISOString()]);
    nativeCli(projectRoot, ['agent-init', '--target-root', '.', '--active-agent-files', 'AGENTS.md',
        '--project-rules-updated', 'yes', '--skills-prompted', 'yes', '--ordinary-doc-paths', 'CHANGELOG.md']);
    const ready = JSON.parse(nativeCli(projectRoot, ['status', '--target-root', '.', '--json']));
    assert.equal(ready.readyForTasks, true, JSON.stringify(ready));
    assert.deepEqual(ready.missingProjectCommands, []);
    return setup;
}

function writeProjectWorkInProgress(projectRoot: string): void {
    fs.writeFileSync(path.join(projectRoot, 'units/order.widget'), '{"rate":0.25}\n');
    runGit(projectRoot, ['add', '--', 'units/order.widget']);
    fs.writeFileSync(path.join(projectRoot, 'checks/order.case'),
        '[{"id":"purchase","net":100,"expected":125}]\n');
}

function captureProjectContinuity(projectRoot: string) {
    const bundle = 'garda-agent-orchestrator/';
    const preserved = ['units/order.widget', 'checks/order.case', 'PROJECT.md', 'notes/domain.md',
        bundle + 'live/config/paths.json',
        bundle + 'live/config/local-commit-enablement-receipt.json',
        ...PROJECT_MEMORY_REQUIRED_FILE_NAMES.map(name => bundle + 'live/docs/project-memory/' + name)];
    const modePath = path.join(projectRoot, bundle, 'runtime/reviews', TASK_ID + '-task-mode.json');
    const timelinePath = path.join(projectRoot, bundle, 'runtime/task-events', TASK_ID + '.jsonl');
    const taskContent = fs.readFileSync(path.join(projectRoot, 'TASK.md'), 'utf8');
    const queue = parseCanonicalActiveTaskQueue(taskContent);
    assert.equal(queue.found, true, queue.unavailableReason || 'The canonical queue must remain present.');
    assert.deepEqual(queue.rows.map(row => row.taskId), [TASK_ID, 'T-KEEP-OTHER']);
    const operatorNotes = taskContent.slice(taskContent.indexOf('## Operator Notes'));
    assert.match(operatorNotes, /^## Operator Notes\n/u);
    return { files: preserved.map(file => ({ path: file, bytes: fs.readFileSync(path.join(projectRoot, file)) })),
        queueRows: queue.rows.map(row => row.rawLine), operatorNotes,
        mode: fs.readFileSync(modePath), timeline: fs.readFileSync(timelinePath),
        head: runGit(projectRoot, ['rev-parse', 'HEAD']).stdout,
        staged: runGit(projectRoot, ['diff', '--cached', '--binary', '--', 'units/order.widget', 'checks/order.case']).stdout,
        unstaged: runGit(projectRoot, ['diff', '--binary', '--', 'units/order.widget', 'checks/order.case']).stdout };
}

function assertProjectContinuity(projectRoot: string, before: ReturnType<typeof captureProjectContinuity>): void {
    const after = captureProjectContinuity(projectRoot);
    for (const file of before.files) assert.deepEqual(fs.readFileSync(path.join(projectRoot, file.path)), file.bytes, file.path);
    assert.deepEqual(after.mode, before.mode, 'An ordinary update must not replace the active task entry.');
    assert.deepEqual(after.timeline.subarray(0, before.timeline.length), before.timeline);
    assert.equal(after.head, before.head);
    assert.equal(after.staged, before.staged);
    assert.equal(after.unstaged, before.unstaged);
    assert.deepEqual(after.queueRows, before.queueRows, 'Preserve every task row, field and operator note.');
    assert.equal(after.operatorNotes, before.operatorNotes);
}

function extractPinnedPreviousRuntime(): { sourceRoot: string; temporaryRoot: string } {
    const fixtureRoot = path.join(findRepoRoot(), 'tests/fixtures/npm');
    const lock = JSON.parse(fs.readFileSync(path.join(fixtureRoot, 'garda-agent-orchestrator-e2402152.lock.json'), 'utf8'));
    assert.equal(lock.name, 'garda-agent-orchestrator');
    assert.equal(lock.source_commit, 'e2402152aecdcd6714f16dac70ad6f44511e3b8f');
    assert.equal(lock.filename, 'garda-agent-orchestrator-e2402152.tgz');
    const archivePath = path.join(fixtureRoot, lock.filename);
    const archive = fs.readFileSync(archivePath);
    assert.equal(`sha512-${createHash('sha512').update(archive).digest('base64')}`, lock.integrity);
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-pinned-upgrade-'));
    try {
        const result = spawnSync('tar', ['-xzf', archivePath, '-C', temporaryRoot], {
            encoding: 'utf8', windowsHide: true, timeout: 60_000, maxBuffer: 1024 * 1024
        });
        assert.equal(result.error, undefined);
        assert.equal(result.status, 0, result.stderr);
        const sourceRoot = path.join(temporaryRoot, 'package');
        assert.equal(JSON.parse(fs.readFileSync(path.join(sourceRoot, 'package.json'), 'utf8')).version, lock.version);
        assert.equal(createHash('sha256').update(fs.readFileSync(path.join(sourceRoot,
            'dist/publish-runtime-manifest.json'))).digest('hex'), lock.runtime_manifest_sha256);
        return { sourceRoot, temporaryRoot };
    } catch (error) {
        fs.rmSync(temporaryRoot, { recursive: true, force: true });
        throw error;
    }
}

function updateProjectFromCurrentSource(projectRoot: string): { updateApplied: boolean; updateAvailable: boolean } {
    const result = JSON.parse(nativeCli(projectRoot, ['update', '--target-root', '.',
        '--source-path', findRepoRoot(), '--trust-override', '--no-prompt', '--json'], findRepoRoot()));
    assert.equal(result.targetRoot, projectRoot);
    assert.equal(typeof result.updateApplied, 'boolean');
    assert.equal(typeof result.updateAvailable, 'boolean');
    assert.ok(result.updateApplied || !result.updateAvailable, 'An available update must actually be applied.');
    return result;
}

function classifyConfiguredProjectRoles(projectRoot: string): string {
    const setup = readProjectSetupInstructions(projectRoot);
    if (readNextStep(projectRoot).next_gate === 'load-rule-pack') refreshNativeTaskStartup(projectRoot);
    const next = readNextStep(projectRoot);
    assert.equal(next.next_gate, 'classify-change', next.reason);
    const preflightPath = path.join(projectRoot, 'garda-agent-orchestrator/runtime/reviews', TASK_ID + '-preflight.json');
    nativeCli(projectRoot, ['gate', 'classify-change', '--task-id', TASK_ID,
        '--task-intent', 'Update app flow', '--changed-file', setup.source, '--changed-file', setup.test,
        '--output-path', preflightPath, '--repo-root', '.']);
    const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8'));
    assert.deepEqual(preflight.metrics.domain_scope_fingerprints.domains.implementation.changed_files, [setup.source]);
    assert.deepEqual(preflight.metrics.domain_scope_fingerprints.domains.test.changed_files, [setup.test]);
    assert.equal(preflight.required_reviews.code, true);
    assert.equal(preflight.required_reviews.test, true);
    nativeCli(projectRoot, ['gate', 'load-rule-pack', '--task-id', TASK_ID, '--stage', 'POST_PREFLIGHT',
        '--preflight-path', preflightPath,
        ...['00-core.md', '15-project-memory.md', '40-commands.md', '80-task-workflow.md', '90-skill-catalog.md',
            '30-code-style.md', '35-strict-coding-rules.md', '70-security.md']
            .flatMap(file => ['--loaded-rule-file', 'garda-agent-orchestrator/live/docs/agent-rules/' + file]),
        '--repo-root', '.']);
    return preflightPath;
}

async function observeConfiguredProjectCase(projectRoot: string): Promise<void> {
    const attempt = await executeValidationRecipe({ repoRoot: projectRoot, taskId: TASK_ID, recipeId: 'purchase-check' });
    assert.equal(attempt.exit_code, 0);
    assert.deepEqual(attempt.violations, []);
    assert.match(readValidationAttemptFacts(projectRoot, TASK_ID, attempt.attempt_id).decoded.flat().join('\n'),
        /"case":"purchase","outcome":"PASSED","actual":125/u);
    assert.equal((await evaluateValidationAttempt({ repoRoot: projectRoot, taskId: TASK_ID,
        attemptId: attempt.attempt_id })).status, 'UNRESOLVED');
}

function publishConfiguredProjectChecklist(projectRoot: string, preflightPath: string): void {
    const answers = buildQualityChecklistAnswersTemplate({ repoRoot: projectRoot, taskId: TASK_ID, preflightPath });
    const answersPath = path.join(projectRoot, 'garda-agent-orchestrator/runtime/tmp/agent-setup-checklist.json');
    fs.mkdirSync(path.dirname(answersPath), { recursive: true });
    fs.writeFileSync(answersPath, JSON.stringify({ ...answers, answers: answers.answers.map(answer => ({
        ...answer, status: 'PASS', answer: 'Inspected PROJECT.md and exact source/test roles; actual admitted purchase execution returned 125. Existing case semantics remain pending independent code/test review.'
    })) }));
    nativeCli(projectRoot, ['gate', 'quality-checklist', '--task-id', TASK_ID,
        '--preflight-path', preflightPath, '--answers-path', answersPath, '--repo-root', '.']);
}

async function verifyConfiguredProjectChecks(projectRoot: string): Promise<void> {
    const setup = readProjectSetupInstructions(projectRoot);
    const preflightPath = classifyConfiguredProjectRoles(projectRoot);
    await observeConfiguredProjectCase(projectRoot);
    publishConfiguredProjectChecklist(projectRoot, preflightPath);
    nativeCli(projectRoot, ['gate', 'compile-gate', '--task-id', TASK_ID, '--preflight-path', preflightPath, '--repo-root', '.']);
    nativeCli(projectRoot, ['gate', 'full-suite-validation', '--task-id', TASK_ID,
        '--preflight-path', preflightPath, '--repo-root', '.']);
    const suite = JSON.parse(fs.readFileSync(path.join(projectRoot,
        'garda-agent-orchestrator/runtime/reviews', TASK_ID + '-full-suite-validation.json'), 'utf8'));
    assert.equal(suite.command, setup.suite);
    assert.equal(suite.exit_code, 0);
    assert.equal(suite.status, 'PASSED');
}

describe('ordinary agent command and role completion', () => {
    it('infers fresh project commands and roles and actually executes the configured native checks', async () => {
        const scenario = projectSetupScenario(findRepoRoot(), true);
        const fixture = createActiveUpdateWorkspace(JSON.stringify, scenario);
        try {
            const before = JSON.parse(fs.readFileSync(fixture.configPath, 'utf8'));
            assert.notEqual(before.compile_gate.command, scenario.compileCommand);
            assert.notEqual(before.full_suite_validation.command, scenario.suiteCommand);
            writeProjectMemoryFromInstructions(fixture.projectRoot);
            const setup = completeAgentProjectSetup(fixture.projectRoot, 'fresh');
            const configured = JSON.parse(fs.readFileSync(fixture.configPath, 'utf8'));
            assert.equal(configured.compile_gate.command, setup.compile);
            assert.equal(configured.full_suite_validation.command, setup.suite);
            enterFixtureTask(fixture.projectRoot);
            writeProjectWorkInProgress(fixture.projectRoot);
            await verifyConfiguredProjectChecks(fixture.projectRoot);
        } finally { fs.rmSync(fixture.projectRoot, { recursive: true, force: true }); }
    });

    it('completes bindings after ordinary update of the pinned older runtime without losing active work', async context => {
        const previous = extractPinnedPreviousRuntime();
        context.after(() => fs.rmSync(previous.temporaryRoot, { recursive: true, force: true }));
        const fixture = createActiveUpdateWorkspace(JSON.stringify, projectSetupScenario(previous.sourceRoot, false));
        try {
            const runtimeManifestPath = path.join(fixture.bundleRoot, 'dist/publish-runtime-manifest.json');
            const previousRuntime = fs.readFileSync(runtimeManifestPath);
            assert.notDeepEqual(previousRuntime,
                fs.readFileSync(path.join(findRepoRoot(), 'dist/publish-runtime-manifest.json')),
                'An archived-runtime run must not use another copy of the current runtime.');
            const originalConfig = JSON.parse(fs.readFileSync(fixture.configPath, 'utf8'));
            assert.equal(originalConfig.project_validation, undefined);
            writeProjectMemoryFromInstructions(fixture.projectRoot);
            writeProjectWorkInProgress(fixture.projectRoot);
            const beforeUpdate = captureProjectContinuity(fixture.projectRoot);
            const update = updateProjectFromCurrentSource(fixture.projectRoot);
            assert.equal(update.updateApplied, true);
            assert.notDeepEqual(fs.readFileSync(runtimeManifestPath), previousRuntime);
            assert.deepEqual(fs.readFileSync(runtimeManifestPath),
                fs.readFileSync(path.join(findRepoRoot(), 'dist/publish-runtime-manifest.json')));
            assertProjectContinuity(fixture.projectRoot, beforeUpdate);
            completeAgentProjectSetup(fixture.projectRoot, 'updated');
            const configured = JSON.parse(fs.readFileSync(fixture.configPath, 'utf8'));
            assert.equal(configured.compile_gate.command, originalConfig.compile_gate.command);
            assert.equal(configured.full_suite_validation.command, originalConfig.full_suite_validation.command);
            assert.ok(configured.project_validation);
            await verifyConfiguredProjectChecks(fixture.projectRoot);
            assertProjectContinuity(fixture.projectRoot, beforeUpdate);
            const beforeRepeat = captureProjectContinuity(fixture.projectRoot);
            const completedBindings = fs.readFileSync(fixture.configPath);
            updateProjectFromCurrentSource(fixture.projectRoot);
            assert.deepEqual(fs.readFileSync(fixture.configPath), completedBindings);
            assertProjectContinuity(fixture.projectRoot, beforeRepeat);
        } finally { fs.rmSync(fixture.projectRoot, { recursive: true, force: true }); }
    });
});
