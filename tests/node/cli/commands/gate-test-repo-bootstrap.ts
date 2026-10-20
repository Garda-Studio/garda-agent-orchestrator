/**
 * Test helpers: temporary repo creation, git bootstrap, and path utilities.
 *
 * Extracted from gate-test-helpers.ts to isolate repo-scaffold concerns
 * from rule/evidence seeding and CLI capture.  All exports are test-only.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as childProcess from 'node:child_process';
import type { TestContext } from 'node:test';

import { buildDefaultWorkflowConfig } from '../../../../src/core/workflow-config';
import {
    createManagedTestTempDirectory,
    createRunScopedTestTempDirectory,
    removeManagedTestTempDirectory,
    removeTempRepoWithRetry
} from './gate-test-temp-manager';

const DEFAULT_GIT_SETUP_RETRY_DELAYS_MS = [0, 25, 100];
const RETRYABLE_GIT_SETUP_PATTERN = /\b(?:EACCES|EBUSY|ENOTEMPTY|EPERM|Permission denied)\b|\.git[\\/]+config|could not set ['"]?core\./iu;
export const TEST_COMPILE_FIXTURE_PATH = 'garda-agent-orchestrator/runtime/compile-fixture.cjs';
export const TEST_COMPILE_GATE_COMMAND = `node ${TEST_COMPILE_FIXTURE_PATH}`;

export function writeTestCompileFixture(repoRoot: string): void {
    const filePath = path.join(repoRoot, TEST_COMPILE_FIXTURE_PATH);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "console.log('build ok');\n", 'utf8');
}

interface RunGitOptions {
    readonly spawnSync?: (
        command: string,
        args: readonly string[],
        options: childProcess.SpawnSyncOptionsWithStringEncoding
    ) => childProcess.SpawnSyncReturns<string>;
    readonly retryDelaysMs?: readonly number[];
}

function sleepSync(delayMs: number): void {
    if (delayMs <= 0) {
        return;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
}

function isGitSetupCommand(args: string[]): boolean {
    return args.some((arg) => arg === 'init');
}

function formatGitOutput(result: childProcess.SpawnSyncReturns<string>): string {
    return [
        result.error instanceof Error ? result.error.message : '',
        result.stderr || '',
        result.stdout || ''
    ].filter(Boolean).join('\n');
}

function isRetryableGitSetupFailure(args: string[], result: childProcess.SpawnSyncReturns<string>): boolean {
    return isGitSetupCommand(args) && RETRYABLE_GIT_SETUP_PATTERN.test(formatGitOutput(result));
}

export function getReviewsRoot(repoRoot: string): string {
    return path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews');
}

export function getOrchestratorRoot(repoRoot: string): string {
    return path.join(repoRoot, 'garda-agent-orchestrator');
}


export function seedRuleFiles(repoRoot: string): void {
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


function seedTempRepoScaffold(root: string): void {
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.mkdirSync(path.join(root, 'garda-agent-orchestrator', 'live', 'config'), { recursive: true });
    fs.mkdirSync(path.join(root, 'garda-agent-orchestrator', 'live', 'docs', 'agent-rules'), { recursive: true });
    fs.mkdirSync(path.join(root, 'garda-agent-orchestrator', 'runtime'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'app.ts'), 'const a = 1;\nconst b = 2;\nconsole.log(a + b);\n', 'utf8');
    
    seedRuleFiles(root);
    writeTestCompileFixture(root);
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
}

export function createTempRepo(testContext?: Pick<TestContext, 'after'>): string {
    const root = createManagedTestTempDirectory('repo-', testContext);
    seedTempRepoScaffold(root);
    return root;
}

export function createRunScopedTempRepo(): string {
    const root = createRunScopedTestTempDirectory('repo-template-');
    seedTempRepoScaffold(root);
    return root;
}

function copyTempRepo(sourceRoot: string, root: string): void {
    for (const entry of fs.readdirSync(sourceRoot)) {
        fs.cpSync(path.join(sourceRoot, entry), path.join(root, entry), { recursive: true });
    }
}

export function cloneTempRepo(
    sourceRoot: string,
    testContext?: Pick<TestContext, 'after'>
): string {
    const root = createManagedTestTempDirectory('repo-', testContext);
    copyTempRepo(sourceRoot, root);
    return root;
}

export function cloneRunScopedTempRepo(sourceRoot: string): string {
    const root = createRunScopedTestTempDirectory('repo-snapshot-');
    copyTempRepo(sourceRoot, root);
    return root;
}

export function createWindowsBatchNodeFixture(
    scriptSource: string,
    options: { forwardArgs?: boolean } = {}
): { batchPath: string; cleanup: () => void } {
    const root = createManagedTestTempDirectory('batch-');
    const jsPath = path.join(root, 'payload.js');
    const batchPath = path.join(root, 'run-fixture.cmd');
    const forwardArgs = options.forwardArgs ? ' %*' : '';
    fs.writeFileSync(jsPath, `${scriptSource}\n`, 'utf8');
    fs.writeFileSync(batchPath, `@echo off\r\n"${process.execPath}" "${jsPath}"${forwardArgs}\r\n`, 'utf8');
    return {
        batchPath,
        cleanup() {
            removeManagedTestTempDirectory(root);
        }
    };
}

export function createDependentValidationFixture(): {
    repoRoot: string;
    consumerPath: string;
    manifestPath: string;
    sourcePath: string;
    lockPath: string;
    nestedCwd: string;
    cleanup: () => void;
} {
    const repoRoot = createManagedTestTempDirectory('validation-');
    const sourcePath = path.join(repoRoot, 'src', 'feature.ts');
    const consumerPath = path.join(repoRoot, '.node-build', 'tests', 'node', 'sample.test.js');
    const manifestPath = path.join(repoRoot, '.node-build', 'node-foundation-manifest.json');
    const lockPath = path.join(repoRoot, '.node-build.lock');
    const nestedCwd = path.join(repoRoot, 'packages', 'feature');

    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
    fs.mkdirSync(path.dirname(consumerPath), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, 'tests', 'node'), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, 'scripts', 'node-foundation'), { recursive: true });
    fs.mkdirSync(nestedCwd, { recursive: true });
    fs.writeFileSync(sourcePath, 'export const feature = true;\n', 'utf8');
    fs.writeFileSync(path.join(repoRoot, 'tests', 'node', 'sample.test.ts'), 'void 0;\n', 'utf8');
    fs.writeFileSync(path.join(repoRoot, 'scripts', 'node-foundation', 'helper.ts'), 'void 0;\n', 'utf8');
    fs.writeFileSync(consumerPath, 'import test from "node:test";\nimport assert from "node:assert/strict";\n\ntest("sample", () => { assert.equal(1, 1); });\n', 'utf8');

    return {
        repoRoot,
        consumerPath,
        manifestPath,
        sourcePath,
        lockPath,
        nestedCwd,
        cleanup: () => removeManagedTestTempDirectory(repoRoot)
    };
}


export function writeNodeFoundationManifest(manifestPath: string): void {
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.writeFileSync(manifestPath, JSON.stringify({
        sourceRoots: ['src', 'tests/node', 'scripts/node-foundation'],
        files: ['tests/node/sample.test.js']
    }, null, 2) + '\n', 'utf8');
}


export function runGit(repoRoot: string, args: string[], options: RunGitOptions = {}): childProcess.SpawnSyncReturns<string> {
    const spawnSync = options.spawnSync || childProcess.spawnSync;
    const retryDelaysMs = isGitSetupCommand(args)
        ? (options.retryDelaysMs || DEFAULT_GIT_SETUP_RETRY_DELAYS_MS)
        : [0];
    let result: childProcess.SpawnSyncReturns<string> | null = null;
    for (let attempt = 0; attempt < retryDelaysMs.length; attempt += 1) {
        sleepSync(retryDelaysMs[attempt] || 0);
        result = spawnSync('git', args, {
            cwd: repoRoot,
            windowsHide: true,
            encoding: 'utf8'
        });
        if (!result.error && result.status === 0) {
            return result;
        }
        if (!isRetryableGitSetupFailure(args, result)) {
            break;
        }
    }
    assert.ok(result, `git ${args.join(' ')} did not run`);
    if (result.error && !isRetryableGitSetupFailure(args, result)) {
        throw result.error;
    }
    assert.equal(
        result.status,
        0,
        `git ${args.join(' ')} failed: ${formatGitOutput(result).trim()}`
    );
    return result;
}

export function initializeGitRepo(repoRoot: string): void {
    const gitArgs = [
        '-c', 'init.defaultBranch=main',
        '-c', 'commit.gpgsign=false',
        '-c', 'tag.gpgsign=false',
        '-c', 'core.hooksPath='
    ];

    // 1. Initialize the repository with optimization parameters
    if (!fs.existsSync(path.join(repoRoot, '.git'))) {
        runGit(repoRoot, [...gitArgs, 'init']);
    }

    // 2. Direct write of user and GPG properties to .git/config to save process spawning.
    // Auto gc/maintenance is disabled: a detached maintenance run rewrites .git/objects while
    // fixtures copy the repository, which fails the copy with ENOENT.
    const configPath = path.join(repoRoot, '.git', 'config');
    if (fs.existsSync(configPath)) {
        const userConfig = '\n[core]\n\tautocrlf = false\n\teol = lf\n\tsafecrlf = false\n[commit]\n\tgpgsign = false\n[tag]\n\tgpgsign = false\n[user]\n\tname = Garda Tests\n\temail = garda-tests@example.com\n[gc]\n\tauto = 0\n[maintenance]\n\tauto = false\n';
        fs.appendFileSync(configPath, userConfig, 'utf8');
    }

    // 3. Add and commit all seeded files
    runGit(repoRoot, ['add', '.']);
    const status = runGit(repoRoot, ['status', '--porcelain']).stdout.trim();
    if (status) {
        runGit(repoRoot, ['commit', '-m', 'test: baseline']);
    }
}


export function ageFixturePath(filePath: string, ageMs: number): void {
    const agedDate = new Date(Date.now() - ageMs);
    fs.utimesSync(filePath, agedDate, agedDate);
}

export function backdateFileMtime(filePath: string, secondsAgo = 5): void {
    const older = new Date(Date.now() - (secondsAgo * 1000));
    fs.utimesSync(filePath, older, older);
}

export {
    createManagedTestTempDirectory,
    createRunScopedTestTempDirectory,
    removeManagedTestTempDirectory,
    removeTempRepoWithRetry
};
