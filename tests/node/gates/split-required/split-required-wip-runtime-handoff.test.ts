import { resolveMockFilesystemPath } from './fixtures/filesystem-paths';
import assert from 'node:assert/strict';
import { runInit } from '../../../../src/materialization/init';
import * as childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import type { TestContext } from 'node:test';
import type { SpawnStreamedOptions, SpawnStreamedResult } from '../../../../src/core/subprocess';
import { runRestoreSplitRequiredWipCommand } from '../../../../src/cli/commands/gate-flows/task-mode/task-mode-split-required-wip-commands';
import type { SplitRequiredWipRestoreResult } from '../../../../src/gates/split-required/split-required-wip-contracts';

import {
    appendMandatoryTaskEvent,
    inspectTaskEventFile,
    readTaskTimelineJsonlEntries
} from '../../../../src/gate-runtime/task-events';
import {
    captureAndSuspendSplitRequiredWip,
    restoreSplitRequiredWip
} from '../../../../src/gates/split-required/split-required-wip';
import {
    prepareSplitRequiredWipRestoreHandoff,
    promotePreparedSplitRequiredWipRestoreHandoff,
    readAndVerifySplitRequiredWipRestoreHandoff,
    replaceSplitRequiredWipRestoreHandoff,
    resolveSplitRequiredWipRestoreHandoffIdentity,
    SPLIT_REQUIRED_WIP_RESTORE_HANDOFF_ENV
} from '../../../../src/gates/split-required/split-required-wip-runtime-handoff-contracts';
import type {
    SplitRequiredWipRestoreHandoffIdentity,
    SplitRequiredWipRuntimeGeneration
} from '../../../../src/gates/split-required/split-required-wip-runtime-handoff-contracts';
import {
    captureHealthyTaskTimelineAnchor,
    finalizeSplitRequiredWipRestoreHandoff
} from '../../../../src/gates/split-required/split-required-wip-runtime-handoff';
import {
    restoreSplitRequiredWipThroughRuntimeHandoff
} from '../../../../src/gates/split-required/split-required-wip-runtime-reexec';
import {
    restoreSplitRequiredWipForPreparedRuntimeHandoff
} from '../../../../src/gates/split-required/split-required-wip-operations';
import {
    applyAdvancedRestorePlan
} from '../../../../src/gates/split-required/split-required-wip-restore-plan';

const TASK_ID = 'T-WIP-RUNTIME-1';
const FRESH_RUNTIME_GENERATION: SplitRequiredWipRuntimeGeneration = {
    build_root: 'fixture/dist',
    input_fingerprint_sha256: 'a'.repeat(64),
    finalizer_sha256: 'b'.repeat(64),
    writer_sha256: 'c'.repeat(64)
};

function findProjectRoot(): string {
    let current = path.resolve(__dirname);
    while (true) {
        if (fs.existsSync(path.join(current, 'package.json'))
            && fs.existsSync(path.join(current, '.node-build', 'node-foundation-manifest.json'))) {
            return current;
        }
        const parent = path.dirname(current);
        if (parent === current) {
            throw new Error('Cannot locate the compiled Garda test runtime.');
        }
        current = parent;
    }
}

function runGit(repoRoot: string, args: string[]): string {
    return childProcess.execFileSync('git', ['-C', repoRoot, ...args], {
        encoding: 'utf8',
        timeout: 30_000,
        stdio: ['ignore', 'pipe', 'pipe']
    });
}

function fileSha256(filePath: string): string {
    return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function isExclusiveCreate(flags: fs.OpenMode): boolean {
    return typeof flags === 'number'
        ? (flags & fs.constants.O_CREAT) !== 0 && (flags & fs.constants.O_EXCL) !== 0
        : flags === 'wx' || flags === 'wx+';
}

function isReadOnlyOpen(flags: fs.OpenMode): boolean {
    return typeof flags === 'number'
        ? (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT)) === 0
        : flags === 'r' || flags === 'rs';
}

function writeFile(repoRoot: string, relativePath: string, content: string): void {
    const filePath = path.join(repoRoot, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
}

function makeRepo(): string {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-split-runtime-handoff-'));
    runGit(repoRoot, ['init']);
    runGit(repoRoot, ['config', 'user.email', 'test@example.invalid']);
    runGit(repoRoot, ['config', 'user.name', 'Test User']);
    runGit(repoRoot, ['config', 'core.autocrlf', 'false']);
    runGit(repoRoot, ['config', 'core.eol', 'lf']);
    writeFile(repoRoot, '.gitignore', 'garda-agent-orchestrator/runtime/\n');
    writeFile(repoRoot, 'src/a.ts', 'export const value = 1;\n');
    writeFile(repoRoot, 'TASK.md', [
        '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
        '|---|---|---|---|---|---|---|---|---|',
        `| ${TASK_ID} | IN_PROGRESS | P1 | workflow | Runtime handoff | codex | 2026-08-31 | strict | Test. |`,
        ''
    ].join('\n'));
    runGit(repoRoot, ['add', '.']);
    runGit(repoRoot, ['commit', '-m', 'initial']);
    return repoRoot;
}

function capture(repoRoot: string, changedFiles: string[] = ['src/a.ts']): string {
    writeFile(repoRoot, 'src/a.ts', 'export const value = 2;\n');
    return captureCurrentWip(repoRoot, changedFiles);
}

function captureCurrentWip(repoRoot: string, changedFiles: string[]): string {
    const preflightPath = path.join(
        repoRoot,
        'garda-agent-orchestrator',
        'runtime',
        'reviews',
        `${TASK_ID}-preflight.json`
    );
    writeFile(repoRoot, path.relative(repoRoot, preflightPath), `${JSON.stringify({
        task_id: TASK_ID,
        changed_files: changedFiles,
        required_reviews: {},
        metrics: { changed_files_count: changedFiles.length, changed_lines_total: changedFiles.length }
    })}\n`);
    const captured = captureAndSuspendSplitRequiredWip({
        repoRoot,
        taskId: TASK_ID,
        preflightPath,
        guardKind: 'strict_decomposition',
        guardReason: 'runtime handoff fixture'
    });
    assert.equal(captured.status, 'CAPTURED', captured.violations.join('\n'));
    assert.ok(captured.manifest_path);
    return captured.manifest_path;
}

function restoredEvents(repoRoot: string): Array<Record<string, unknown>> {
    const eventFile = path.join(
        repoRoot,
        'garda-agent-orchestrator',
        'runtime',
        'task-events',
        `${TASK_ID}.jsonl`
    );
    return readTaskTimelineJsonlEntries(eventFile)
        .map((entry) => entry.record)
        .filter((record): record is Record<string, unknown> => (
            Boolean(record) && record?.event_type === 'SPLIT_REQUIRED_WIP_RESTORED'
        ));
}

function preparePendingHandoff(): {
    repoRoot: string;
    identity: SplitRequiredWipRestoreHandoffIdentity;
} {
    const repoRoot = makeRepo();
    const manifestPath = capture(repoRoot);
    const identity = resolveSplitRequiredWipRestoreHandoffIdentity({
        repoRoot,
        taskId: TASK_ID,
        manifestPath
    });
    const timelineAnchor = captureHealthyTaskTimelineAnchor(repoRoot, TASK_ID);
    prepareSplitRequiredWipRestoreHandoff(identity, timelineAnchor);
    const restored = restoreSplitRequiredWipForPreparedRuntimeHandoff(identity);
    assert.equal(restored.status, 'RESTORED');
    promotePreparedSplitRequiredWipRestoreHandoff(identity);
    return { repoRoot, identity };
}

function fakeRuntimeGeneration(): SplitRequiredWipRuntimeGeneration {
    return { ...FRESH_RUNTIME_GENERATION };
}

function makeSourceRepo(buildCommand = 'fixture'): string {
    const repoRoot = makeRepo();
    writeFile(repoRoot, 'src/index.ts', 'export {};\n');
    writeFile(repoRoot, 'package.json', JSON.stringify({ name: 'self-hosted-fixture', scripts: { build: buildCommand } }));
    writeFile(repoRoot, 'bin/garda.js', '#!/usr/bin/env node\n');
    runGit(repoRoot, ['add', '.']);
    runGit(repoRoot, ['commit', '-m', 'self-hosted shape']);
    return repoRoot;
}

function makeRealRuntimeSourceRepo(): string {
    const projectRoot = findProjectRoot();
    const compiledBuildRoot = path.join(projectRoot, '.node-build');
    const projectVersion = String((JSON.parse(fs.readFileSync(
        path.join(projectRoot, 'package.json'),
        'utf8'
    )) as { version?: unknown }).version || '').trim();
    assert.match(projectVersion, /^\d+\.\d+\.\d+$/u);
    const repoRoot = makeRepo();
    writeFile(repoRoot, 'src/index.ts', 'export {};\n');
    writeFile(repoRoot, 'package.json', JSON.stringify({
        name: 'garda-agent-orchestrator',
        version: projectVersion,
        type: 'commonjs',
        scripts: { build: 'node build-runtime.cjs' }
    }));
    writeFile(repoRoot, 'VERSION', `${projectVersion}\n`);
    fs.cpSync(path.join(projectRoot, 'bin'), path.join(repoRoot, 'bin'), { recursive: true });
    const bundleRoot = path.join(repoRoot, 'garda-agent-orchestrator');
    fs.cpSync(path.join(projectRoot, 'template'), path.join(bundleRoot, 'template'), { recursive: true });
    fs.cpSync(path.join(projectRoot, 'bin'), path.join(bundleRoot, 'bin'), { recursive: true });
    for (const relativePath of ['package.json', 'VERSION']) {
        fs.copyFileSync(path.join(projectRoot, relativePath), path.join(bundleRoot, relativePath));
    }
    const bundleIndexPath = path.join(bundleRoot, 'dist', 'src', 'index.js');
    fs.mkdirSync(path.dirname(bundleIndexPath), { recursive: true });
    fs.copyFileSync(path.join(compiledBuildRoot, 'src', 'index.js'), bundleIndexPath);
    writeFile(repoRoot, 'garda-agent-orchestrator/runtime/init-answers.json', JSON.stringify({
        AssistantLanguage: 'English',
        AssistantBrevity: 'concise',
        SourceOfTruth: 'Codex',
        EnforceNoAutoCommit: 'false',
        ClaudeOrchestratorFullAccess: 'false',
        TokenEconomyEnabled: 'true',
        CollectedVia: 'CLI_NONINTERACTIVE',
        ActiveAgentFiles: 'AGENTS.md'
    }));
    runInit({
        targetRoot: repoRoot,
        bundleRoot,
        assistantLanguage: 'English',
        assistantBrevity: 'concise',
        sourceOfTruth: 'Codex'
    });
    writeFile(repoRoot, 'build-runtime.cjs', [
        "const fs = require('node:fs');",
        "const path = require('node:path');",
        "const crypto = require('node:crypto');",
        `const sourceBuildRoot = ${JSON.stringify(compiledBuildRoot)};`,
        "const targetBuildRoot = path.join(__dirname, 'dist');",
        "fs.rmSync(targetBuildRoot, { recursive: true, force: true });",
        "fs.cpSync(path.join(sourceBuildRoot, 'src'), path.join(targetBuildRoot, 'src'), { recursive: true });",
        "const sourceManifest = JSON.parse(fs.readFileSync(path.join(sourceBuildRoot, 'node-foundation-manifest.json'), 'utf8'));",
        "const files = sourceManifest.files.filter((entry) => typeof entry === 'string' && entry.startsWith('src/'));",
        "fs.writeFileSync(path.join(targetBuildRoot, 'src', 'a.js'), 'exports.value = 2;\\n', 'utf8');",
        "if (fs.existsSync(path.join(__dirname, 'src', 'renamed file.ts'))) {",
        "    fs.writeFileSync(path.join(targetBuildRoot, 'src', 'renamed file.js'), 'exports.value = 3;\\n', 'utf8');",
        "    files.push('src/renamed file.js');",
        "}",
        "const builtAt = new Date();",
        "fs.utimesSync(path.join(targetBuildRoot, 'src', 'index.js'), builtAt, builtAt);",
        "const publishedManifest = { nodeEngineRange: sourceManifest.nodeEngineRange, sourceRoots: ['src'], files };",
        "const publishedContent = JSON.stringify(publishedManifest, null, 2) + '\\n';",
        "fs.writeFileSync(path.join(targetBuildRoot, 'publish-runtime-manifest.json'), publishedContent, 'utf8');",
        "const { buildPublishRuntimeInputFingerprint } = require(path.join(sourceBuildRoot, 'scripts', 'node-foundation', 'build.js'));",
        "const inputFingerprint = buildPublishRuntimeInputFingerprint(__dirname);",
        "fs.mkdirSync(path.join(__dirname, '.scripts-build'), { recursive: true });",
        "fs.writeFileSync(path.join(__dirname, '.scripts-build', 'publish-runtime-build-cache.json'), JSON.stringify({ ...publishedManifest, inputFingerprint, publishedManifestSha256: crypto.createHash('sha256').update(publishedContent).digest('hex') }, null, 2) + '\\n', 'utf8');",
        "fs.writeFileSync(path.join(__dirname, 'build-ran'), 'yes', 'utf8');",
        ''
    ].join('\n'));
    runGit(repoRoot, ['add', '.']);
    runGit(repoRoot, ['commit', '-m', 'real runtime source fixture']);
    return repoRoot;
}

function buildRealRuntimeSourceRepo(repoRoot: string): void {
    childProcess.execFileSync(process.execPath, [path.join(repoRoot, 'build-runtime.cjs')], {
        cwd: repoRoot,
        timeout: 30_000,
        stdio: ['ignore', 'pipe', 'pipe']
    });
}

function usePrivateRuntimeFingerprint(repoRoot: string): { cachePath: string; fingerprintSha256: string } {
    const manifestPath = path.join(repoRoot, 'dist', 'publish-runtime-manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    const existingCachePath = path.join(repoRoot, '.scripts-build', 'publish-runtime-build-cache.json');
    const inputFingerprint = (manifest.inputFingerprint
        ?? JSON.parse(fs.readFileSync(existingCachePath, 'utf8')).inputFingerprint) as { sha256: string };
    delete manifest.inputFingerprint;
    const publishedContent = `${JSON.stringify(manifest, null, 2)}\n`;
    fs.writeFileSync(manifestPath, publishedContent, 'utf8');
    const cachePath = path.join(repoRoot, '.scripts-build', 'publish-runtime-build-cache.json');
    writeFile(repoRoot, '.scripts-build/publish-runtime-build-cache.json', `${JSON.stringify({
        ...manifest,
        inputFingerprint,
        publishedManifestSha256: createHash('sha256').update(publishedContent).digest('hex')
    }, null, 2)}\n`);
    return { cachePath, fingerprintSha256: inputFingerprint.sha256 };
}

function probeRuntimeGeneration(
    repoRoot: string,
    runtimeModulePath = path.join(
        repoRoot,
        'dist',
        'src',
        'gates',
        'split-required',
        'split-required-wip-runtime-handoff.js'
    )
): childProcess.SpawnSyncReturns<string> {
    const probe = [
        'const runtime = require(process.argv[1]);',
        'try {',
        '  process.stdout.write(JSON.stringify(runtime.resolveLoadedSplitRequiredWipRuntimeGeneration(process.argv[2])));',
        '} catch (error) {',
        '  process.stderr.write(error instanceof Error ? error.message : String(error));',
        '  process.exitCode = 1;',
        '}'
    ].join('\n');
    return childProcess.spawnSync(process.execPath, ['-e', probe, runtimeModulePath, repoRoot], {
        cwd: repoRoot,
        encoding: 'utf8',
        timeout: 30_000
    });
}

function runtimeResult(overrides: Partial<SpawnStreamedResult> = {}): SpawnStreamedResult {
    return { exitCode: 0, stdout: '', stderr: '', timedOut: false, cancelled: false,
        stdoutTruncated: false, stderrTruncated: false, stdoutOriginalBytes: 0, stderrOriginalBytes: 0,
        ...overrides };
}

function mockRuntimeProcesses(
    context: TestContext,
    run: (command: string, args: string[], options?: SpawnStreamedOptions) => Promise<SpawnStreamedResult>
): void {
    const subprocess = require('../../../../src/core/process/subprocess') as typeof import('../../../../src/core/process/subprocess');
    context.mock.method(subprocess, 'spawnStreamed', run);
    context.mock.method(subprocess, 'spawnShellCommand', run);
}

describe('split-required WIP restored-runtime handoff', () => {
    for (const status of ['RESTORED', 'BLOCKED'] as const) {
        it(`awaits the restore CLI handoff and preserves arguments and ${status} exit semantics`, async (context) => {
            const runtime = require('../../../../src/gates/split-required/split-required-wip-runtime-reexec') as typeof import('../../../../src/gates/split-required/split-required-wip-runtime-reexec');
            let release = (): void => { throw new Error('Deferred handoff is not initialized.'); };
            const deferred = new Promise<void>((resolve) => { release = resolve; });
            const outputLines = [`fixture ${status}`];
            const restore = context.mock.method(runtime, 'restoreSplitRequiredWipThroughRuntimeHandoff', async (params: Parameters<typeof runtime.restoreSplitRequiredWipThroughRuntimeHandoff>[0]): Promise<SplitRequiredWipRestoreResult> => {
                assert.deepEqual(params, {
                    repoRoot: 'fixture repo', taskId: TASK_ID, manifestPath: 'fixture manifest.json',
                    includePaths: ['src/a.ts', 'src/b.ts'], dryRun: true
                });
                await deferred;
                return {
                    status, manifest_path: 'fixture manifest.json', selected_paths: [], restored_files: [],
                    violations: status === 'BLOCKED' ? ['fixture blocked'] : [], output_lines: outputLines
                };
            });
            let settled = false;
            const pending = runRestoreSplitRequiredWipCommand({
                repoRoot: 'fixture repo', taskId: ` ${TASK_ID} `, manifestPath: ' fixture manifest.json ',
                includePaths: [' src/a.ts ; src/b.ts ', ' '], dryRun: true
            }).then((result) => { settled = true; return result; });
            try {
                await Promise.resolve();
                assert.equal(restore.mock.callCount(), 1);
                assert.equal(settled, false, 'CLI must wait until the runtime handoff settles');
            } finally {
                release();
            }
            assert.deepEqual(await pending, { outputLines, exitCode: status === 'BLOCKED' ? 3 : 0 });
        });
    }

    it('durably prepares handoff intent before restoring files or permitting finalization', () => {
        const repoRoot = makeRepo();
        const manifestPath = capture(repoRoot);
        const identity = resolveSplitRequiredWipRestoreHandoffIdentity({
            repoRoot,
            taskId: TASK_ID,
            manifestPath
        });
        try {
            const timelineAnchor = captureHealthyTaskTimelineAnchor(repoRoot, TASK_ID);
            const prepared = prepareSplitRequiredWipRestoreHandoff(identity, timelineAnchor);
            assert.equal(prepared.status, 'prepared');
            assert.equal(fs.readFileSync(path.join(repoRoot, 'src/a.ts'), 'utf8'), 'export const value = 1;\n');

            const premature = finalizeSplitRequiredWipRestoreHandoff(identity, fakeRuntimeGeneration);
            assert.equal(premature.status, 'BLOCKED');
            assert.match(premature.violations.join('\n'), /not been promoted/u);
            assert.equal(restoredEvents(repoRoot).length, 0);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('anchors self-hosted restore after legitimate task events that follow WIP capture', async (context) => {
        const repoRoot = makeSourceRepo();
        const manifestPath = capture(repoRoot);
        const captureAnchor = captureHealthyTaskTimelineAnchor(repoRoot, TASK_ID);
        appendMandatoryTaskEvent(
            path.join(repoRoot, 'garda-agent-orchestrator'),
            TASK_ID,
            'STATUS_CHANGED',
            'PASS',
            'Parent task decomposed after WIP capture.',
            { from_status: 'SPLIT_REQUIRED', to_status: 'DECOMPOSED' },
            { actor: 'orchestrator', expectedPreviousState: captureAnchor }
        );
        try {
            const currentAnchor = captureHealthyTaskTimelineAnchor(repoRoot, TASK_ID);
            let finalizedHandoffPath = '';
            mockRuntimeProcesses(context, async (command) => {
                if (command !== process.execPath) return runtimeResult();
                const identity = resolveSplitRequiredWipRestoreHandoffIdentity({
                    repoRoot,
                    taskId: TASK_ID,
                    manifestPath
                });
                assert.deepEqual(identity.timelineAnchor, currentAnchor);
                assert.notDeepEqual(identity.timelineAnchor, captureAnchor);
                finalizedHandoffPath = identity.handoffPath;
                const finalized = finalizeSplitRequiredWipRestoreHandoff(identity, fakeRuntimeGeneration);
                assert.equal(finalized.status, 'RESTORED', finalized.violations.join('\n'));
                return runtimeResult({ stdout: finalized.output_lines.join('\n') });
            });

            const result = await restoreSplitRequiredWipThroughRuntimeHandoff({
                repoRoot,
                taskId: TASK_ID,
                manifestPath
            });
            const replayIdentity = resolveSplitRequiredWipRestoreHandoffIdentity({
                repoRoot,
                taskId: TASK_ID,
                manifestPath
            });

            assert.equal(result.status, 'RESTORED', result.violations.join('\n'));
            assert.equal(replayIdentity.handoffPath, finalizedHandoffPath);
            assert.equal(restoredEvents(repoRoot).length, 1);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('does not honor the removed public event-defer flag', () => {
        const repoRoot = makeRepo();
        const manifestPath = capture(repoRoot);
        try {
            const result = restoreSplitRequiredWip({
                repoRoot,
                taskId: TASK_ID,
                manifestPath,
                ...({ deferRestoredEvent: true } as Record<string, unknown>)
            });
            assert.equal(result.status, 'RESTORED');
            assert.equal(restoredEvents(repoRoot).length, 1);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('fresh runtime handoff replay records one restored event and remains idempotent', () => {
        const { repoRoot, identity } = preparePendingHandoff();
        try {
            assert.equal(restoredEvents(repoRoot).length, 0);
            const first = finalizeSplitRequiredWipRestoreHandoff(identity, fakeRuntimeGeneration);
            const second = finalizeSplitRequiredWipRestoreHandoff(identity, fakeRuntimeGeneration);
            const eventFile = path.join(
                repoRoot,
                'garda-agent-orchestrator',
                'runtime',
                'task-events',
                `${TASK_ID}.jsonl`
            );
            assert.equal(first.status, 'RESTORED');
            assert.equal(second.status, 'ALREADY_RESTORED');
            assert.equal(restoredEvents(repoRoot).length, 1);
            assert.equal(inspectTaskEventFile(eventFile, TASK_ID).status, 'PASS');
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('stale manifest mutation blocks restored runtime finalization without appending an event', () => {
        const { repoRoot, identity } = preparePendingHandoff();
        try {
            fs.appendFileSync(identity.manifestPath, ' ');
            const result = finalizeSplitRequiredWipRestoreHandoff(identity, fakeRuntimeGeneration);
            assert.equal(result.status, 'BLOCKED');
            assert.match(result.violations.join('\n'), /manifest changed/u);
            assert.equal(restoredEvents(repoRoot).length, 0);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('restores from the authenticated manifest snapshot when the file changes after verification', () => {
        const repoRoot = makeRepo();
        const manifestPath = capture(repoRoot);
        const identity = resolveSplitRequiredWipRestoreHandoffIdentity({
            repoRoot,
            taskId: TASK_ID,
            manifestPath
        });
        const timelineAnchor = captureHealthyTaskTimelineAnchor(repoRoot, TASK_ID);
        prepareSplitRequiredWipRestoreHandoff(identity, timelineAnchor);
        const maliciousPatchPath = path.join(path.dirname(manifestPath), 'changed-after-verification.patch');
        const maliciousPatch = [
            'diff --git a/src/a.ts b/src/a.ts',
            '--- a/src/a.ts',
            '+++ b/src/a.ts',
            '@@ -1 +1 @@',
            '-export const value = 1;',
            '+export const value = 9;',
            ''
        ].join('\n');
        fs.writeFileSync(maliciousPatchPath, maliciousPatch, 'utf8');
        const changedManifest = structuredClone(identity.manifest);
        changedManifest.patches.unstaged = {
            path: maliciousPatchPath,
            sha256: createHash('sha256').update(maliciousPatch).digest('hex'),
            bytes: Buffer.byteLength(maliciousPatch),
            empty: false
        };
        const fsModule = require('node:fs') as typeof import('node:fs');
        const originalLstatSync = fsModule.lstatSync;
        const authenticatedPatchPath = path.resolve(
            repoRoot,
            identity.manifest.patches.unstaged.path
        );
        let changedAfterVerification = false;
        Reflect.set(fsModule, 'lstatSync', ((filePath: fs.PathLike, options?: fs.StatSyncOptions) => {
            if (!changedAfterVerification
                && typeof filePath === 'string'
                && resolveMockFilesystemPath(filePath) === authenticatedPatchPath) {
                changedAfterVerification = true;
                fs.writeFileSync(manifestPath, `${JSON.stringify(changedManifest, null, 2)}\n`, 'utf8');
            }
            return Reflect.apply(originalLstatSync, fsModule, [filePath, options]);
        }) as typeof fsModule.lstatSync);
        try {
            const restored = restoreSplitRequiredWipForPreparedRuntimeHandoff(identity);
            assert.equal(changedAfterVerification, true);
            assert.equal(restored.status, 'RESTORED');
            assert.equal(fs.readFileSync(path.join(repoRoot, 'src/a.ts'), 'utf8'), 'export const value = 2;\n');
        } finally {
            Reflect.set(fsModule, 'lstatSync', originalLstatSync);
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('restores only authenticated patch and untracked artifact byte snapshots', () => {
        const repoRoot = makeRepo();
        writeFile(repoRoot, 'notes.txt', 'captured note\n');
        const manifestPath = capture(repoRoot, ['src/a.ts', 'notes.txt']);
        const identity = resolveSplitRequiredWipRestoreHandoffIdentity({
            repoRoot,
            taskId: TASK_ID,
            manifestPath
        });
        const patch = identity.manifest.patches.unstaged.bytes > 0
            ? identity.manifest.patches.unstaged
            : identity.manifest.patches.staged;
        const patchPath = path.resolve(repoRoot, patch.path);
        const untracked = identity.manifest.untracked_files.find((entry) => entry.path === 'notes.txt');
        assert.ok(untracked);
        const untrackedArtifactPath = path.resolve(repoRoot, untracked.artifact_path);
        const restoredUntrackedPath = path.join(repoRoot, 'notes.txt');
        const childProcessModule = require('node:child_process') as typeof import('node:child_process');
        const fsModule = require('node:fs') as typeof import('node:fs');
        const originalSpawnSync = childProcessModule.spawnSync;
        const originalOpenSync = fsModule.openSync;
        let patchChangedAfterSnapshot = false;
        let untrackedChangedAfterSnapshot = false;
        childProcessModule.spawnSync = ((command: string, args?: readonly string[], options?: childProcess.SpawnSyncOptions) => {
            if (!patchChangedAfterSnapshot
                && command === 'git'
                && Array.isArray(args)
                && args.includes('apply')
                && args.at(-1) === '-') {
                patchChangedAfterSnapshot = true;
                fs.appendFileSync(patchPath, [
                    'diff --git a/src/unexpected.ts b/src/unexpected.ts',
                    'new file mode 100644',
                    '--- /dev/null',
                    '+++ b/src/unexpected.ts',
                    '@@ -0,0 +1 @@',
                    '+export const unexpected = true;',
                    ''
                ].join('\n'));
            }
            return Reflect.apply(originalSpawnSync, childProcessModule, [command, args, options]);
        }) as typeof childProcessModule.spawnSync;
        fsModule.openSync = ((filePath: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
            if (!untrackedChangedAfterSnapshot
                && typeof filePath === 'string'
                && resolveMockFilesystemPath(filePath) === path.resolve(restoredUntrackedPath)
                && isExclusiveCreate(flags)) {
                untrackedChangedAfterSnapshot = true;
                fs.writeFileSync(untrackedArtifactPath, 'mutated artifact\n', 'utf8');
            }
            return Reflect.apply(originalOpenSync, fsModule, [filePath, flags, mode]);
        }) as typeof fsModule.openSync;
        try {
            prepareSplitRequiredWipRestoreHandoff(identity, identity.timelineAnchor);
            const restored = restoreSplitRequiredWipForPreparedRuntimeHandoff(identity);
            const pending = promotePreparedSplitRequiredWipRestoreHandoff(identity);
            const finalized = finalizeSplitRequiredWipRestoreHandoff(identity, fakeRuntimeGeneration);

            assert.equal(restored.status, 'RESTORED');
            assert.equal(pending.status, 'pending');
            assert.equal(finalized.status, 'RESTORED');
            assert.equal(patchChangedAfterSnapshot, true);
            assert.equal(untrackedChangedAfterSnapshot, true);
            assert.equal(fs.readFileSync(path.join(repoRoot, 'src/a.ts'), 'utf8'), 'export const value = 2;\n');
            assert.equal(fs.readFileSync(restoredUntrackedPath, 'utf8'), 'captured note\n');
            assert.equal(fs.existsSync(path.join(repoRoot, 'src/unexpected.ts')), false);
        } finally {
            childProcessModule.spawnSync = originalSpawnSync;
            fsModule.openSync = originalOpenSync;
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('reads only selected untracked artifacts for partial dry-run and restore', () => {
        const repoRoot = makeRepo();
        writeFile(repoRoot, 'selected-note.txt', 'selected note\n');
        writeFile(repoRoot, 'unselected-note.txt', 'unselected note\n');
        const manifestPath = capture(repoRoot, [
            'src/a.ts',
            'selected-note.txt',
            'unselected-note.txt'
        ]);
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
            untracked_files: Array<{ path: string; artifact_path: string }>;
        };
        const unselected = manifest.untracked_files.find((entry) => entry.path === 'unselected-note.txt');
        assert.ok(unselected);
        const unselectedArtifactPath = path.resolve(repoRoot, unselected.artifact_path);
        const fsModule = require('node:fs') as typeof import('node:fs');
        const originalOpenSync = fsModule.openSync;
        let unselectedArtifactReads = 0;
        fsModule.openSync = ((filePath: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
            if (typeof filePath === 'string'
                && resolveMockFilesystemPath(filePath) === unselectedArtifactPath
                && isReadOnlyOpen(flags)) {
                unselectedArtifactReads += 1;
                throw new Error('unselected artifact must not be opened');
            }
            return Reflect.apply(originalOpenSync, fsModule, [filePath, flags, mode]);
        }) as typeof fsModule.openSync;
        try {
            const restoreParams = {
                repoRoot,
                taskId: TASK_ID,
                manifestPath,
                includePaths: ['src/a.ts', 'selected-note.txt']
            };
            const dryRun = restoreSplitRequiredWip({ ...restoreParams, dryRun: true });
            const restored = restoreSplitRequiredWip(restoreParams);

            assert.equal(dryRun.status, 'DRY_RUN_OK', dryRun.violations.join('\n'));
            assert.equal(restored.status, 'RESTORED', restored.violations.join('\n'));
            assert.equal(unselectedArtifactReads, 0);
            assert.equal(fs.readFileSync(path.join(repoRoot, 'selected-note.txt'), 'utf8'), 'selected note\n');
            assert.equal(fs.existsSync(path.join(repoRoot, 'unselected-note.txt')), false);
        } finally {
            fsModule.openSync = originalOpenSync;
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('blocks an aggregate selected-artifact allocation above the restore budget', () => {
        const repoRoot = makeRepo();
        const untrackedPaths = Array.from({ length: 4 }, (_, index) => `note-${index}.txt`);
        for (const relativePath of untrackedPaths) {
            writeFile(repoRoot, relativePath, `${relativePath}\n`);
        }
        const manifestPath = capture(repoRoot, ['src/a.ts', ...untrackedPaths]);
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
            untracked_files: Array<{ bytes: number }>;
        };
        for (const entry of manifest.untracked_files) {
            entry.bytes = 64 * 1024 * 1024;
        }
        fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
        try {
            const restored = restoreSplitRequiredWip({
                repoRoot,
                taskId: TASK_ID,
                manifestPath
            });

            assert.equal(restored.status, 'BLOCKED');
            assert.match(restored.violations.join('\n'), /aggregate limit/u);
            assert.equal(untrackedPaths.some((relativePath) => fs.existsSync(path.join(repoRoot, relativePath))), false);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('blocks a replaced untracked target without deleting the competing file', () => {
        const repoRoot = makeRepo();
        writeFile(repoRoot, 'src/index.ts', 'export {};\n');
        writeFile(repoRoot, 'bin/garda.js', '#!/usr/bin/env node\n');
        writeFile(repoRoot, 'package.json', '{"name":"runtime-handoff-fixture"}\n');
        runGit(repoRoot, ['add', '.']);
        runGit(repoRoot, ['commit', '-m', 'source checkout markers']);
        writeFile(repoRoot, 'notes.txt', 'captured note\n');
        const manifestPath = capture(repoRoot, ['src/a.ts', 'notes.txt']);
        const identity = resolveSplitRequiredWipRestoreHandoffIdentity({
            repoRoot,
            taskId: TASK_ID,
            manifestPath
        });
        prepareSplitRequiredWipRestoreHandoff(identity, identity.timelineAnchor);
        const targetPath = path.join(repoRoot, 'notes.txt');
        const fsModule = require('node:fs') as typeof import('node:fs');
        const originalOpenSync = fsModule.openSync;
        let competingFileCreated = false;
        fsModule.openSync = ((filePath: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
            if (!competingFileCreated
                && typeof filePath === 'string'
                && resolveMockFilesystemPath(filePath) === path.resolve(targetPath)
                && isExclusiveCreate(flags)) {
                competingFileCreated = true;
                fs.writeFileSync(targetPath, 'competing note\n', 'utf8');
            }
            return Reflect.apply(originalOpenSync, fsModule, [filePath, flags, mode]);
        }) as typeof fsModule.openSync;
        try {
            const restored = restoreSplitRequiredWipForPreparedRuntimeHandoff(identity);

            assert.equal(restored.status, 'BLOCKED');
            assert.equal(competingFileCreated, true);
            assert.equal(fs.readFileSync(targetPath, 'utf8'), 'competing note\n');
            assert.equal(fs.readFileSync(path.join(repoRoot, 'src/a.ts'), 'utf8'), 'export const value = 1;\n');

            fsModule.openSync = originalOpenSync;
            fs.rmSync(targetPath);
            const retried = restoreSplitRequiredWipForPreparedRuntimeHandoff(identity);
            assert.equal(retried.status, 'RESTORED');
            assert.equal(fs.readFileSync(path.join(repoRoot, 'src/a.ts'), 'utf8'), 'export const value = 2;\n');
            assert.equal(fs.readFileSync(targetPath, 'utf8'), 'captured note\n');
        } finally {
            fsModule.openSync = originalOpenSync;
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('advanced restore blocks a replaced untracked target without deleting the competing file', () => {
        const repoRoot = makeRepo();
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-wip-plan-untracked-race-'));
        const gitIndexPath = runGit(repoRoot, ['rev-parse', '--git-path', 'index']).trim();
        const indexPath = path.isAbsolute(gitIndexPath)
            ? path.resolve(gitIndexPath)
            : path.resolve(repoRoot, gitIndexPath);
        const originalIndexSha256 = fileSha256(indexPath);
        const targetPath = path.join(repoRoot, 'notes.txt');
        const content = Buffer.from('captured note\n');
        const fsModule = require('node:fs') as typeof import('node:fs');
        const originalOpenSync = fsModule.openSync;
        let competingFileCreated = false;
        fsModule.openSync = ((filePath: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
            if (!competingFileCreated
                && typeof filePath === 'string'
                && resolveMockFilesystemPath(filePath) === path.resolve(targetPath)
                && isExclusiveCreate(flags)) {
                competingFileCreated = true;
                fs.writeFileSync(targetPath, 'competing note\n', 'utf8');
            }
            return Reflect.apply(originalOpenSync, fsModule, [filePath, flags, mode]);
        }) as typeof fsModule.openSync;
        try {
            const violations = applyAdvancedRestorePlan(repoRoot, {
                tempRoot,
                candidateIndexPath: indexPath,
                candidateWorktreeRoot: path.join(tempRoot, 'worktree'),
                currentHead: runGit(repoRoot, ['rev-parse', 'HEAD']).trim(),
                currentIndexSha256: originalIndexSha256,
                targetSha256: new Map([['notes.txt', null]])
            }, [], [{
                path: 'notes.txt',
                artifact_path: path.join(tempRoot, 'unused-artifact'),
                sha256: createHash('sha256').update(content).digest('hex'),
                bytes: content.length
            }], {
                patches: {
                    staged: Buffer.alloc(0),
                    unstaged: Buffer.alloc(0)
                },
                untrackedFiles: new Map([['notes.txt', content]])
            });

            assert.equal(violations.length, 1);
            assert.match(violations[0], /^three-way restore failed without retained mutations:/u);
            assert.equal(competingFileCreated, true);
            assert.equal(fs.readFileSync(targetPath, 'utf8'), 'competing note\n');
            assert.equal(fileSha256(indexPath), originalIndexSha256);
        } finally {
            fsModule.openSync = originalOpenSync;
            fs.rmSync(repoRoot, { recursive: true, force: true });
            fs.rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    it('blocks an untracked restore when its authenticated parent is replaced by a symlink', () => {
        const repoRoot = makeRepo();
        const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-wip-parent-swap-'));
        writeFile(repoRoot, 'notes/captured.txt', 'captured note\n');
        const manifestPath = capture(repoRoot, ['src/a.ts', 'notes/captured.txt']);
        const identity = resolveSplitRequiredWipRestoreHandoffIdentity({
            repoRoot,
            taskId: TASK_ID,
            manifestPath
        });
        prepareSplitRequiredWipRestoreHandoff(identity, identity.timelineAnchor);
        const parentPath = path.join(repoRoot, 'notes');
        const originalParentPath = path.join(repoRoot, '.notes-original');
        const targetPath = path.join(parentPath, 'captured.txt');
        const outsideTargetPath = path.join(outsideRoot, 'captured.txt');
        fs.mkdirSync(parentPath, { recursive: true });
        const fsModule = require('node:fs') as typeof import('node:fs');
        const originalOpenSync = fsModule.openSync;
        let parentReplaced = false;
        fsModule.openSync = ((filePath: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
            if (!parentReplaced
                && typeof filePath === 'string'
                && resolveMockFilesystemPath(filePath) === path.resolve(targetPath)
                && isExclusiveCreate(flags)) {
                parentReplaced = true;
                fs.renameSync(parentPath, originalParentPath);
                fs.symlinkSync(outsideRoot, parentPath, process.platform === 'win32' ? 'junction' : 'dir');
            }
            return Reflect.apply(originalOpenSync, fsModule, [filePath, flags, mode]);
        }) as typeof fsModule.openSync;
        try {
            const restored = restoreSplitRequiredWipForPreparedRuntimeHandoff(identity);

            assert.equal(restored.status, 'BLOCKED');
            assert.equal(parentReplaced, true);
            assert.equal(fs.existsSync(outsideTargetPath), false);
            assert.equal(fs.readFileSync(path.join(repoRoot, 'src/a.ts'), 'utf8'), 'export const value = 1;\n');
        } finally {
            fsModule.openSync = originalOpenSync;
            if (parentReplaced) {
                fs.unlinkSync(parentPath);
                fs.renameSync(originalParentPath, parentPath);
            }
            fs.rmSync(repoRoot, { recursive: true, force: true });
            fs.rmSync(outsideRoot, { recursive: true, force: true });
        }
    });

    it('blocks restored-file evidence when its parent changes during descriptor open', () => {
        const { repoRoot, identity } = preparePendingHandoff();
        const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-wip-evidence-parent-swap-'));
        const parentPath = path.join(repoRoot, 'src');
        const originalParentPath = path.join(repoRoot, '.src-original');
        const targetPath = path.join(parentPath, 'a.ts');
        writeFile(outsideRoot, 'a.ts', 'export const value = 2;\n');
        const fsModule = require('node:fs') as typeof import('node:fs');
        const originalOpenSync = fsModule.openSync;
        let parentReplaced = false;
        fsModule.openSync = ((filePath: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
            if (!parentReplaced
                && typeof filePath === 'string'
                && resolveMockFilesystemPath(filePath) === path.resolve(targetPath)
                && isReadOnlyOpen(flags)) {
                parentReplaced = true;
                fs.renameSync(parentPath, originalParentPath);
                fs.symlinkSync(outsideRoot, parentPath, process.platform === 'win32' ? 'junction' : 'dir');
            }
            return Reflect.apply(originalOpenSync, fsModule, [filePath, flags, mode]);
        }) as typeof fsModule.openSync;
        try {
            const result = finalizeSplitRequiredWipRestoreHandoff(identity, fakeRuntimeGeneration);

            assert.equal(result.status, 'BLOCKED');
            assert.equal(parentReplaced, true);
            assert.equal(restoredEvents(repoRoot).length, 0);
        } finally {
            fsModule.openSync = originalOpenSync;
            if (parentReplaced) {
                fs.unlinkSync(parentPath);
                fs.renameSync(originalParentPath, parentPath);
            }
            fs.rmSync(repoRoot, { recursive: true, force: true });
            fs.rmSync(outsideRoot, { recursive: true, force: true });
        }
    });

    it('replaced restored file blocks runtime finalization without appending an event', () => {
        const { repoRoot, identity } = preparePendingHandoff();
        try {
            writeFile(repoRoot, 'src/a.ts', 'export const value = 3;\n');
            const result = finalizeSplitRequiredWipRestoreHandoff(identity, fakeRuntimeGeneration);
            assert.equal(result.status, 'BLOCKED');
            assert.match(result.violations.join('\n'), /does not match manifest|workspace changed/u);
            assert.equal(restoredEvents(repoRoot).length, 0);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('revalidates restored workspace immediately before canonical append', () => {
        const { repoRoot, identity } = preparePendingHandoff();
        try {
            const result = finalizeSplitRequiredWipRestoreHandoff(identity, () => {
                writeFile(repoRoot, 'src/a.ts', 'export const value = 3;\n');
                return fakeRuntimeGeneration();
            });
            assert.equal(result.status, 'BLOCKED');
            assert.match(result.violations.join('\n'), /does not match manifest|workspace changed/u);
            assert.equal(restoredEvents(repoRoot).length, 0);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('foreign repository binding blocks restored runtime finalization without appending an event', () => {
        const { repoRoot, identity } = preparePendingHandoff();
        try {
            const handoff = JSON.parse(fs.readFileSync(identity.handoffPath, 'utf8')) as Record<string, unknown>;
            handoff.repo_root = path.join(repoRoot, 'foreign');
            fs.writeFileSync(identity.handoffPath, `${JSON.stringify(handoff, null, 2)}\n`, 'utf8');
            const result = finalizeSplitRequiredWipRestoreHandoff(identity, fakeRuntimeGeneration);
            assert.equal(result.status, 'BLOCKED');
            assert.match(result.violations.join('\n'), /identity does not match/u);
            assert.equal(restoredEvents(repoRoot).length, 0);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('rejects traversal task IDs before resolving a task-owned WIP root', () => {
        const repoRoot = makeRepo();
        const manifestPath = capture(repoRoot);
        try {
            assert.throws(
                () => resolveSplitRequiredWipRestoreHandoffIdentity({
                    repoRoot,
                    taskId: `${TASK_ID}/../../foreign`,
                    manifestPath
                }),
                /semantic pattern/u
            );
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('rejects a manifest changed while its authenticated identity snapshot is read', () => {
        const repoRoot = makeRepo();
        const manifestPath = capture(repoRoot);
        const fsModule = require('node:fs') as typeof import('node:fs');
        const originalReadSync = fsModule.readSync;
        let changedDuringRead = false;
        fsModule.readSync = ((descriptor: number, buffer: Buffer, offset: number, length: number, position: number | null) => {
            const result = originalReadSync(descriptor, buffer, offset, length, position);
            if (!changedDuringRead) {
                changedDuringRead = true;
                fs.appendFileSync(manifestPath, ' ');
            }
            return result;
        }) as typeof fsModule.readSync;
        try {
            assert.throws(
                () => resolveSplitRequiredWipRestoreHandoffIdentity({
                    repoRoot,
                    taskId: TASK_ID,
                    manifestPath
                }),
                /manifest changed while reading authenticated bytes/u
            );
            assert.equal(changedDuringRead, true);
        } finally {
            fsModule.readSync = originalReadSync;
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('rejects a handoff pathname replaced between identity check and descriptor open', () => {
        const { repoRoot, identity } = preparePendingHandoff();
        const fsModule = require('node:fs') as typeof import('node:fs');
        const originalOpenSync = fsModule.openSync;
        const replacementPath = `${identity.handoffPath}.replaced`;
        let replacedDuringOpen = false;
        fsModule.openSync = ((filePath: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
            if (!replacedDuringOpen
                && typeof filePath === 'string'
                && resolveMockFilesystemPath(filePath) === path.resolve(identity.handoffPath)) {
                replacedDuringOpen = true;
                fs.renameSync(identity.handoffPath, replacementPath);
                fs.copyFileSync(replacementPath, identity.handoffPath);
            }
            return Reflect.apply(originalOpenSync, fsModule, [filePath, flags, mode]);
        }) as typeof fsModule.openSync;
        try {
            const result = finalizeSplitRequiredWipRestoreHandoff(identity, fakeRuntimeGeneration);

            assert.equal(result.status, 'BLOCKED');
            assert.match(result.violations.join('\n'), /identity.*changed while opening/u);
            assert.equal(replacedDuringOpen, true);
            assert.equal(restoredEvents(repoRoot).length, 0);
        } finally {
            fsModule.openSync = originalOpenSync;
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('does not write handoff bytes through a replaced parent directory', () => {
        const { repoRoot, identity } = preparePendingHandoff();
        const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-wip-handoff-parent-swap-'));
        const parentPath = path.dirname(identity.handoffPath);
        const originalParentPath = `${parentPath}.original`;
        const originalHandoff = fs.readFileSync(identity.handoffPath);
        const handoff = readAndVerifySplitRequiredWipRestoreHandoff(identity);
        const fsModule = require('node:fs') as typeof import('node:fs');
        const originalOpenSync = fsModule.openSync;
        let parentReplaced = false;
        fsModule.openSync = ((filePath: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
            const resolvedFilePath = typeof filePath === 'string' ? resolveMockFilesystemPath(filePath) : '';
            const replaceBeforeParentOpen = process.platform === 'win32'
                && resolvedFilePath === path.resolve(parentPath)
                && isReadOnlyOpen(flags);
            const replaceAfterParentOpen = process.platform !== 'win32'
                && typeof filePath === 'string'
                && path.basename(filePath).startsWith(`${path.basename(identity.handoffPath)}.garda-replace-`)
                && isExclusiveCreate(flags);
            if (!parentReplaced && (replaceBeforeParentOpen || replaceAfterParentOpen)) {
                parentReplaced = true;
                fs.renameSync(parentPath, originalParentPath);
                fs.symlinkSync(outsideRoot, parentPath, process.platform === 'win32' ? 'junction' : 'dir');
            }
            return Reflect.apply(originalOpenSync, fsModule, [filePath, flags, mode]);
        }) as typeof fsModule.openSync;
        try {
            assert.throws(
                () => replaceSplitRequiredWipRestoreHandoff(identity.handoffPath, {
                    ...handoff,
                    created_at_utc: new Date(Date.now() + 1_000).toISOString()
                }, handoff),
                /restore parent identity changed|restore target identity changed/u
            );
            assert.equal(parentReplaced, true);
            assert.deepEqual(fs.readdirSync(outsideRoot), []);
            assert.deepEqual(
                fs.readFileSync(path.join(originalParentPath, path.basename(identity.handoffPath))),
                originalHandoff
            );
        } finally {
            fsModule.openSync = originalOpenSync;
            try {
                if (fs.lstatSync(parentPath).isSymbolicLink()) {
                    fs.unlinkSync(parentPath);
                }
            } catch (error: unknown) {
                assert.equal((error as NodeJS.ErrnoException).code, 'ENOENT');
            }
            if (!fs.existsSync(parentPath) && fs.existsSync(originalParentPath)) {
                fs.renameSync(originalParentPath, parentPath);
            }
            fs.rmSync(repoRoot, { recursive: true, force: true });
            fs.rmSync(outsideRoot, { recursive: true, force: true });
        }
    });

    it('rejects a handoff whose timeline anchor was changed after preparation', () => {
        const { repoRoot, identity } = preparePendingHandoff();
        try {
            appendMandatoryTaskEvent(
                path.join(repoRoot, 'garda-agent-orchestrator'),
                TASK_ID,
                'CONCURRENT_FIXTURE_EVENT',
                'INFO',
                'Concurrent fixture mutation.',
                {},
                { actor: 'test' }
            );
            const handoff = JSON.parse(fs.readFileSync(identity.handoffPath, 'utf8')) as Record<string, unknown>;
            handoff.timeline_anchor = captureHealthyTaskTimelineAnchor(repoRoot, TASK_ID);
            fs.writeFileSync(identity.handoffPath, `${JSON.stringify(handoff, null, 2)}\n`, 'utf8');

            const result = finalizeSplitRequiredWipRestoreHandoff(identity, fakeRuntimeGeneration);
            assert.equal(result.status, 'BLOCKED');
            assert.match(result.violations.join('\n'), /timeline anchor/u);
            assert.equal(restoredEvents(repoRoot).length, 0);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('stale timeline race blocks conditional restored event append', () => {
        const { repoRoot, identity } = preparePendingHandoff();
        try {
            appendMandatoryTaskEvent(
                path.join(repoRoot, 'garda-agent-orchestrator'),
                TASK_ID,
                'CONCURRENT_FIXTURE_EVENT',
                'INFO',
                'Concurrent fixture mutation.',
                {},
                { actor: 'test' }
            );
            const result = finalizeSplitRequiredWipRestoreHandoff(identity, fakeRuntimeGeneration);
            assert.equal(result.status, 'BLOCKED');
            assert.match(result.violations.join('\n'), /timeline changed/u);
            assert.equal(restoredEvents(repoRoot).length, 0);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('rejects a forged matching event that is not part of an authenticated timeline chain', () => {
        const { repoRoot, identity } = preparePendingHandoff();
        try {
            const eventFile = path.join(
                repoRoot,
                'garda-agent-orchestrator',
                'runtime',
                'task-events',
                `${TASK_ID}.jsonl`
            );
            fs.appendFileSync(eventFile, `${JSON.stringify({
                task_id: TASK_ID,
                event_type: 'SPLIT_REQUIRED_WIP_RESTORED',
                details: { handoff_id: identity.handoffId },
                integrity: {}
            })}\n`, 'utf8');

            const result = finalizeSplitRequiredWipRestoreHandoff(identity, fakeRuntimeGeneration);
            const handoff = JSON.parse(fs.readFileSync(identity.handoffPath, 'utf8')) as Record<string, unknown>;
            assert.equal(result.status, 'BLOCKED');
            assert.match(result.violations.join('\n'), /timeline is not safe|integrity/u);
            assert.equal(handoff.status, 'pending');
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('rejects a chain-valid restore event with mismatched immutable handoff bindings', () => {
        const { repoRoot, identity } = preparePendingHandoff();
        try {
            appendMandatoryTaskEvent(
                path.join(repoRoot, 'garda-agent-orchestrator'),
                TASK_ID,
                'SPLIT_REQUIRED_WIP_RESTORED',
                'PASS',
                'Semantically mismatched restore event fixture.',
                {
                    handoff_id: identity.handoffId,
                    handoff_path: identity.handoffPath,
                    manifest_path: identity.manifestPath,
                    manifest_sha256: 'd'.repeat(64),
                    restored_files: identity.restoredFiles,
                    selected_paths: identity.selectedPaths,
                    runtime_generation: fakeRuntimeGeneration()
                },
                {
                    actor: 'orchestrator',
                    expectedPreviousState: identity.timelineAnchor
                }
            );

            const result = finalizeSplitRequiredWipRestoreHandoff(identity, fakeRuntimeGeneration);
            const handoff = JSON.parse(fs.readFileSync(identity.handoffPath, 'utf8')) as Record<string, unknown>;
            assert.equal(result.status, 'BLOCKED');
            assert.match(result.violations.join('\n'), /immutable restore handoff bindings/u);
            assert.equal(handoff.status, 'pending');
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('rejects chain-valid restore events with a foreign actor or unsuccessful outcome', () => {
        let verifiedCases = 0;
        for (const [actor, outcome] of [['test', 'PASS'], ['orchestrator', 'FAIL']]) {
            const { repoRoot, identity } = preparePendingHandoff();
            try {
                const originalHandoff = fs.readFileSync(identity.handoffPath);
                appendMandatoryTaskEvent(path.join(repoRoot, 'garda-agent-orchestrator'), TASK_ID,
                    'SPLIT_REQUIRED_WIP_RESTORED', outcome, 'Invalid restore event authority.', {
                        handoff_id: identity.handoffId,
                        handoff_path: identity.handoffPath,
                        manifest_path: identity.manifestPath,
                        manifest_sha256: identity.manifestSha256,
                        restored_files: identity.restoredFiles,
                        selected_paths: identity.selectedPaths,
                        runtime_generation: fakeRuntimeGeneration()
                    }, { actor, expectedPreviousState: identity.timelineAnchor });
                const result = finalizeSplitRequiredWipRestoreHandoff(identity, fakeRuntimeGeneration);
                assert.equal(result.status, 'BLOCKED');
                assert.match(result.violations.join('\n'), /restore event.*authority/u);
                assert.deepEqual(fs.readFileSync(identity.handoffPath), originalHandoff);
                assert.equal(restoredEvents(repoRoot).length, 1);
                verifiedCases += 1;
            } finally {
                fs.rmSync(repoRoot, { recursive: true, force: true });
            }
        }
        assert.equal(verifiedCases, 2);
    });

    it('rejects runtime generation changes immediately before canonical append', () => {
        const { repoRoot, identity } = preparePendingHandoff();
        let generationReads = 0;
        try {
            const result = finalizeSplitRequiredWipRestoreHandoff(identity, () => {
                generationReads += 1;
                return { ...fakeRuntimeGeneration(), writer_sha256: (generationReads === 1 ? 'c' : 'd').repeat(64) };
            });
            assert.equal(result.status, 'BLOCKED');
            assert.match(result.violations.join('\n'), /runtime generation changed/u);
            assert.equal(generationReads, 2);
            assert.equal(restoredEvents(repoRoot).length, 0);
            assert.equal(readAndVerifySplitRequiredWipRestoreHandoff(identity).status, 'pending');
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('executes the real runtime build before a failing fresh finalizer', async (context) => {
        const repoRoot = makeSourceRepo('node -e "require(\'node:fs\').writeFileSync(\'build-ran\', \'yes\')"');
        const manifestPath = capture(repoRoot);
        const subprocess = require('../../../../src/core/process/subprocess') as typeof import('../../../../src/core/process/subprocess');
        const originalStreamed = subprocess.spawnStreamed;
        context.mock.method(subprocess, 'spawnStreamed', async (command: string, args: string[], options?: SpawnStreamedOptions) => {
            if (command === process.execPath) {
                assert.equal(fs.readFileSync(path.join(repoRoot, 'build-ran'), 'utf8'), 'yes');
                return runtimeResult({ exitCode: 1, stderr: 'fixture finalizer failed' });
            }
            return originalStreamed(command, args, options);
        });
        try {
            const result = await restoreSplitRequiredWipThroughRuntimeHandoff({ repoRoot, taskId: TASK_ID, manifestPath });
            assert.equal(result.status, 'BLOCKED');
            assert.match(result.violations.join('\n'), /fixture finalizer failed/u);
            assert.equal(fs.readFileSync(path.join(repoRoot, 'build-ran'), 'utf8'), 'yes');
            assert.equal(restoredEvents(repoRoot).length, 0);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('self-hosted restore delegates the event to a fresh runtime generation', async (context) => {
        const repoRoot = makeSourceRepo();
        const manifestPath = capture(repoRoot);
        const calls: string[] = [];
        mockRuntimeProcesses(context, async (command, args, options) => {
            assert.equal(options?.maxBuffer, 16 * 1024 * 1024);
            if (command !== process.execPath) {
                calls.push('build');
                assert.equal(path.basename(command).toLowerCase(), process.platform === 'win32' ? 'npm.cmd' : 'npm');
                assert.deepEqual(args, ['run', 'build']);
                assert.equal(options?.timeoutMs, 600_000);
                assert.equal(options?.env?.GARDA_BUILD_SCRIPTS_FORCE_REBUILD, '1');
                assert.equal(options?.env?.GARDA_PUBLISH_RUNTIME_FORCE_REBUILD, '1');
                assert.equal(fs.readFileSync(path.join(repoRoot, 'src/a.ts'), 'utf8'), 'export const value = 2;\n');
                return runtimeResult();
            }
            calls.push('fresh-runtime');
            assert.equal(options?.timeoutMs, 120_000);
            const identity = resolveSplitRequiredWipRestoreHandoffIdentity({ repoRoot, taskId: TASK_ID, manifestPath });
            assert.equal(options?.env?.[SPLIT_REQUIRED_WIP_RESTORE_HANDOFF_ENV], identity.handoffPath);
            assert.ok(args.includes(manifestPath));
            const finalized = finalizeSplitRequiredWipRestoreHandoff(identity, fakeRuntimeGeneration);
            assert.equal(finalized.status, 'RESTORED', finalized.violations.join('\n'));
            return runtimeResult({ stdout: finalized.output_lines.join('\n') });
        });
        try {
            const result = await restoreSplitRequiredWipThroughRuntimeHandoff({ repoRoot, taskId: TASK_ID, manifestPath });
            const details = restoredEvents(repoRoot)[0]?.details as Record<string, unknown>;
            const generation = details?.runtime_generation as Record<string, unknown>;
            assert.equal(result.status, 'RESTORED');
            assert.deepEqual(calls, ['build', 'fresh-runtime']);
            assert.equal(restoredEvents(repoRoot).length, 1);
            assert.equal(generation.input_fingerprint_sha256, FRESH_RUNTIME_GENERATION.input_fingerprint_sha256);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('completes a self-hosted restore through the real rebuilt CLI process', {
        timeout: 120_000
    }, async () => {
        const repoRoot = makeRealRuntimeSourceRepo();
        const manifestPath = capture(repoRoot);
        try {
            const result = await restoreSplitRequiredWipThroughRuntimeHandoff({
                repoRoot,
                taskId: TASK_ID,
                manifestPath
            });
            const details = restoredEvents(repoRoot)[0]?.details as Record<string, unknown>;
            const generation = details?.runtime_generation as Record<string, unknown>;
            assert.equal(result.status, 'RESTORED', result.violations.join('\n'));
            assert.equal(fs.readFileSync(path.join(repoRoot, 'build-ran'), 'utf8'), 'yes');
            assert.equal(restoredEvents(repoRoot).length, 1);
            assert.equal(path.resolve(String(generation.build_root)), path.resolve(repoRoot, 'dist'));
            assert.match(String(generation.input_fingerprint_sha256), /^[0-9a-f]{64}$/u);
            assert.equal(readAndVerifySplitRequiredWipRestoreHandoff(
                resolveSplitRequiredWipRestoreHandoffIdentity({ repoRoot, taskId: TASK_ID, manifestPath })
            ).status, 'finalized');
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    for (const diffRenames of ['true', 'false']) {
        it(`T-168 restores a staged rename through the real rebuilt CLI with diff.renames=${diffRenames}`, {
            timeout: 120_000
        }, async (context) => {
            const repoRoot = makeRealRuntimeSourceRepo();
            context.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
            runGit(repoRoot, ['config', 'diff.renames', diffRenames]);
            const sourcePath = 'src/a.ts';
            const destinationPath = 'src/renamed file.ts';
            const scope = [sourcePath, destinationPath];
            runGit(repoRoot, ['mv', sourcePath, destinationPath]);
            writeFile(repoRoot, destinationPath, 'export const value = 3;\n');
            const indexBefore = runGit(repoRoot, ['ls-files', '--stage', '-z']);
            const stagedBefore = runGit(repoRoot, ['diff', '--cached', '--binary', '--', ...scope]);
            const unstagedBefore = runGit(repoRoot, ['diff', '--binary', '--', ...scope]);
            const headBefore = runGit(repoRoot, ['rev-parse', 'HEAD']);
            const manifestPath = captureCurrentWip(repoRoot, scope);
            assert.equal(fs.existsSync(path.join(repoRoot, destinationPath)), false);
            assert.equal(fs.readFileSync(path.join(repoRoot, sourcePath), 'utf8'), 'export const value = 1;\n');

            const result = await restoreSplitRequiredWipThroughRuntimeHandoff({ repoRoot, taskId: TASK_ID, manifestPath });

            assert.equal(result.status, 'RESTORED', result.violations.join('\n'));
            assert.equal(fs.existsSync(path.join(repoRoot, sourcePath)), false);
            assert.equal(fs.readFileSync(path.join(repoRoot, destinationPath), 'utf8'), 'export const value = 3;\n');
            assert.equal(runGit(repoRoot, ['ls-files', '--stage', '-z']), indexBefore);
            assert.equal(runGit(repoRoot, ['diff', '--cached', '--binary', '--', ...scope]), stagedBefore);
            assert.equal(runGit(repoRoot, ['diff', '--binary', '--', ...scope]), unstagedBefore);
            assert.equal(runGit(repoRoot, ['rev-parse', 'HEAD']), headBefore);
            assert.equal(fs.readFileSync(path.join(repoRoot, 'build-ran'), 'utf8'), 'yes');
            assert.equal(restoredEvents(repoRoot).length, 1);
            const identity = resolveSplitRequiredWipRestoreHandoffIdentity({ repoRoot, taskId: TASK_ID, manifestPath });
            assert.equal(readAndVerifySplitRequiredWipRestoreHandoff(identity).status, 'finalized');
        });
    }

    it('rejects a generated runtime older than its source checkout', () => {
        const repoRoot = makeRealRuntimeSourceRepo();
        try {
            buildRealRuntimeSourceRepo(repoRoot);
            const sourcePath = path.join(repoRoot, 'src', 'index.ts');
            const future = new Date(Date.now() + 5_000);
            fs.utimesSync(sourcePath, future, future);

            const result = probeRuntimeGeneration(repoRoot);

            assert.equal(result.status, 1);
            assert.match(result.stderr, /GARDA_BUILD_SCRIPTS_FORCE_REBUILD/u);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('rejects a finalizer loaded from a foreign generated build root', () => {
        const repoRoot = makeRealRuntimeSourceRepo();
        try {
            buildRealRuntimeSourceRepo(repoRoot);
            const projectRoot = findProjectRoot();
            const foreignRuntimeModule = path.join(
                projectRoot,
                '.node-build',
                'src',
                'gates',
                'split-required',
                'split-required-wip-runtime-handoff.js'
            );

            const result = probeRuntimeGeneration(repoRoot, foreignRuntimeModule);

            assert.equal(result.status, 1);
            assert.match(result.stderr, /foreign or fallback runtime generation/u);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('accepts the producer private fingerprint without changing the public runtime manifest', (context) => {
        const repoRoot = makeRealRuntimeSourceRepo();
        context.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
        buildRealRuntimeSourceRepo(repoRoot);
        const { fingerprintSha256 } = usePrivateRuntimeFingerprint(repoRoot);
        const manifestPath = path.join(repoRoot, 'dist', 'publish-runtime-manifest.json');
        const publishedBefore = fs.readFileSync(manifestPath, 'utf8');

        const result = probeRuntimeGeneration(repoRoot);

        assert.equal(result.status, 0, result.stderr);
        assert.equal(JSON.parse(result.stdout).input_fingerprint_sha256, fingerprintSha256);
        assert.equal(fs.readFileSync(manifestPath, 'utf8'), publishedBefore);
        assert.equal(Object.hasOwn(JSON.parse(publishedBefore), 'inputFingerprint'), false);
    });

    it('rejects a missing private runtime fingerprint cache', (context) => {
        const repoRoot = makeRealRuntimeSourceRepo();
        context.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
        buildRealRuntimeSourceRepo(repoRoot);
        const { cachePath } = usePrivateRuntimeFingerprint(repoRoot);
        fs.rmSync(cachePath);

        const result = probeRuntimeGeneration(repoRoot);

        assert.equal(result.status, 1);
        assert.match(result.stderr, /runtime build cache is missing/u);
    });

    it('rejects a malformed private runtime fingerprint cache', (context) => {
        const repoRoot = makeRealRuntimeSourceRepo();
        context.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
        buildRealRuntimeSourceRepo(repoRoot);
        const { cachePath } = usePrivateRuntimeFingerprint(repoRoot);
        const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
        cache.inputFingerprint = 'malformed';
        fs.writeFileSync(cachePath, JSON.stringify(cache), 'utf8');

        const result = probeRuntimeGeneration(repoRoot);

        assert.equal(result.status, 1);
        assert.match(result.stderr, /runtime build cache is missing authenticated input fingerprint/u);
    });

    it('rejects a private runtime cache bound to a different public manifest', (context) => {
        const repoRoot = makeRealRuntimeSourceRepo();
        context.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
        buildRealRuntimeSourceRepo(repoRoot);
        const { cachePath } = usePrivateRuntimeFingerprint(repoRoot);
        const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
        cache.publishedManifestSha256 = 'f'.repeat(64);
        fs.writeFileSync(cachePath, JSON.stringify(cache), 'utf8');

        const result = probeRuntimeGeneration(repoRoot);

        assert.equal(result.status, 1);
        assert.match(result.stderr, /runtime build cache does not bind the current published manifest/u);
    });

    it('rejects a malformed private runtime fingerprint hash', (context) => {
        const repoRoot = makeRealRuntimeSourceRepo();
        context.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
        buildRealRuntimeSourceRepo(repoRoot);
        const { cachePath } = usePrivateRuntimeFingerprint(repoRoot);
        const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
        cache.inputFingerprint.sha256 = 'malformed';
        fs.writeFileSync(cachePath, JSON.stringify(cache), 'utf8');

        const result = probeRuntimeGeneration(repoRoot);

        assert.equal(result.status, 1);
        assert.match(result.stderr, /input fingerprint sha256 is missing or malformed/u);
    });

    it('rejects a private cache that hides a missing public finalizer module', (context) => {
        const repoRoot = makeRealRuntimeSourceRepo();
        context.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
        buildRealRuntimeSourceRepo(repoRoot);
        const { cachePath } = usePrivateRuntimeFingerprint(repoRoot);
        const manifestPath = path.join(repoRoot, 'dist', 'publish-runtime-manifest.json');
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        manifest.files = manifest.files.filter((entry: string) => (
            entry !== 'src/gates/split-required/split-required-wip-runtime-handoff.js'
        ));
        const publishedContent = `${JSON.stringify(manifest, null, 2)}\n`;
        fs.writeFileSync(manifestPath, publishedContent, 'utf8');
        const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
        cache.publishedManifestSha256 = createHash('sha256').update(publishedContent).digest('hex');
        fs.writeFileSync(cachePath, JSON.stringify(cache), 'utf8');

        const result = probeRuntimeGeneration(repoRoot);

        assert.equal(result.status, 1);
        assert.match(result.stderr, /manifest does not bind required finalizer module/u);
    });

    it('rejects a generated runtime with a malformed local cache fingerprint', () => {
        const repoRoot = makeRealRuntimeSourceRepo();
        try {
            buildRealRuntimeSourceRepo(repoRoot);
            const manifestPath = path.join(repoRoot, '.scripts-build', 'publish-runtime-build-cache.json');
            const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
                inputFingerprint: { sha256: string };
            };
            manifest.inputFingerprint.sha256 = 'malformed';
            fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

            const result = probeRuntimeGeneration(repoRoot);

            assert.equal(result.status, 1);
            assert.match(result.stderr, /input fingerprint sha256 is missing or malformed/u);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('resolves the production publish-cache fingerprint without host metadata in the published manifest', () => {
        const repoRoot = makeRealRuntimeSourceRepo();
        try {
            buildRealRuntimeSourceRepo(repoRoot);
            const manifestPath = path.join(repoRoot, 'dist', 'publish-runtime-manifest.json');
            const cachePath = path.join(repoRoot, '.scripts-build', 'publish-runtime-build-cache.json');
            const manifestBytes = fs.readFileSync(manifestPath);
            const cacheBytes = fs.readFileSync(cachePath);
            const manifest = JSON.parse(manifestBytes.toString('utf8')) as Record<string, unknown>;
            const cache = JSON.parse(cacheBytes.toString('utf8')) as {
                inputFingerprint: { sha256: string };
            };

            const result = probeRuntimeGeneration(repoRoot);

            assert.equal(result.status, 0, result.stderr);
            assert.equal(Object.hasOwn(manifest, 'inputFingerprint'), false);
            assert.equal((JSON.parse(result.stdout) as SplitRequiredWipRuntimeGeneration).input_fingerprint_sha256,
                cache.inputFingerprint.sha256);
            assert.deepEqual(fs.readFileSync(manifestPath), manifestBytes);
            assert.deepEqual(fs.readFileSync(cachePath), cacheBytes);
            const reorderedCache = JSON.parse(cacheBytes.toString('utf8')) as {
                inputFingerprint: Record<string, unknown>;
            };
            const reorderedFingerprint = Object.fromEntries(Object.entries(reorderedCache.inputFingerprint).reverse());
            reorderedFingerprint.files = (reorderedCache.inputFingerprint.files as Array<Record<string, unknown>>)
                .map((entry) => Object.fromEntries(Object.entries(entry).reverse()));
            reorderedCache.inputFingerprint = reorderedFingerprint;
            fs.writeFileSync(cachePath, JSON.stringify(reorderedCache, null, 2) + '\n');
            const reorderedBytes = fs.readFileSync(cachePath);

            const reorderedResult = probeRuntimeGeneration(repoRoot);

            assert.equal(reorderedResult.status, 0, reorderedResult.stderr);
            assert.equal((JSON.parse(reorderedResult.stdout) as SplitRequiredWipRuntimeGeneration).input_fingerprint_sha256,
                cache.inputFingerprint.sha256);
            assert.deepEqual(fs.readFileSync(cachePath), reorderedBytes);
            assert.deepEqual(fs.readFileSync(manifestPath), manifestBytes);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('rejects missing malformed and unbound local publish-cache authority', () => {
        const scenarios = [
            { kind: 'missing', expected: /runtime build cache is missing/u },
            { kind: 'invalid-json', expected: /JSON/u },
            { kind: 'invalid-record', expected: /cache.*input fingerprint/u },
            { kind: 'foreign-kind', expected: /publish-runtime fingerprint/u },
            { kind: 'coerced-sha', expected: /input fingerprint sha256/u },
            { kind: 'unbound-manifest', expected: /cache.*published manifest/u },
            { kind: 'oversized', expected: /byte limit/u }
        ];
        let rejected = 0;
        for (const { kind, expected } of scenarios) {
            const repoRoot = makeRealRuntimeSourceRepo();
            try {
                buildRealRuntimeSourceRepo(repoRoot);
                const manifestPath = path.join(repoRoot, 'dist', 'publish-runtime-manifest.json');
                const manifestBytes = fs.readFileSync(manifestPath);
                const cachePath = path.join(repoRoot, '.scripts-build', 'publish-runtime-build-cache.json');
                const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8')) as {
                    inputFingerprint: { kind: string; sha256: unknown };
                    publishedManifestSha256: string;
                };
                if (kind === 'missing') fs.unlinkSync(cachePath);
                else if (kind === 'invalid-json') fs.writeFileSync(cachePath, '{');
                else if (kind === 'invalid-record') fs.writeFileSync(cachePath, '[]');
                else if (kind === 'oversized') fs.writeFileSync(cachePath, Buffer.alloc(16 * 1024 * 1024 + 1, 32));
                else {
                    if (kind === 'foreign-kind') cache.inputFingerprint.kind = 'node-foundation';
                    if (kind === 'coerced-sha') cache.inputFingerprint.sha256 = [cache.inputFingerprint.sha256];
                    if (kind === 'unbound-manifest') cache.publishedManifestSha256 = 'd'.repeat(64);
                    fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2) + '\n', 'utf8');
                }

                const result = probeRuntimeGeneration(repoRoot);

                assert.equal(result.status, 1, kind);
                assert.match(result.stderr, expected, kind);
                assert.deepEqual(fs.readFileSync(manifestPath), manifestBytes, kind);
                assert.equal(restoredEvents(repoRoot).length, 0, kind);
                rejected += 1;
            } finally {
                fs.rmSync(repoRoot, { recursive: true, force: true });
            }
        }
        assert.equal(rejected, scenarios.length);
    });

    it('rejects a stale local cache fingerprint after a rebuild with identical published manifest bytes', () => {
        const scenarios = ['source-content', 'build-config', 'new-build-input'] as const;
        let rejected = 0;
        for (const scenario of scenarios) {
            const repoRoot = makeRealRuntimeSourceRepo();
            try {
                writeFile(repoRoot, 'tsconfig.build.json', '{"compilerOptions":{"strict":true}}\n');
                buildRealRuntimeSourceRepo(repoRoot);
                const manifestPath = path.join(repoRoot, 'dist', 'publish-runtime-manifest.json');
                const cachePath = path.join(repoRoot, '.scripts-build', 'publish-runtime-build-cache.json');
                const manifestBytes = fs.readFileSync(manifestPath);
                const oldCacheBytes = fs.readFileSync(cachePath);
                const oldCache = JSON.parse(oldCacheBytes.toString('utf8')) as {
                    inputFingerprint: { sha256: string };
                };
                if (scenario === 'source-content') {
                    writeFile(repoRoot, 'src/index.ts', 'export const revised = true;\n');
                } else if (scenario === 'build-config') {
                    writeFile(repoRoot, 'tsconfig.build.json', '{"compilerOptions":{"strict":false}}\n');
                } else {
                    writeFile(repoRoot, 'scripts/node-foundation/new-input.cjs', 'exports.changed = true;\n');
                }
                buildRealRuntimeSourceRepo(repoRoot);
                const currentCache = JSON.parse(fs.readFileSync(cachePath, 'utf8')) as {
                    inputFingerprint: { sha256: string };
                };
                assert.notEqual(currentCache.inputFingerprint.sha256, oldCache.inputFingerprint.sha256, scenario);
                assert.deepEqual(fs.readFileSync(manifestPath), manifestBytes, scenario);
                fs.writeFileSync(cachePath, oldCacheBytes);

                const result = probeRuntimeGeneration(repoRoot);

                assert.equal(result.status, 1, scenario);
                assert.match(result.stderr, /stale runtime build cache fingerprint/u, scenario);
                assert.deepEqual(fs.readFileSync(cachePath), oldCacheBytes, scenario);
                assert.deepEqual(fs.readFileSync(manifestPath), manifestBytes, scenario);
                assert.equal(restoredEvents(repoRoot).length, 0, scenario);
                rejected += 1;
            } finally {
                fs.rmSync(repoRoot, { recursive: true, force: true });
            }
        }
        assert.equal(rejected, scenarios.length);
    });

    it('rejects concurrent runtime authority edits before canonical append', () => {
        const scenarios = ['later-input-read', 'final-inventory-walk', 'file-replacement',
            'runtime-module-read', 'compiler-metadata', 'runtime-input-added',
            'runtime-file-root-created', 'runtime-directory-root-created'] as const;
        const observations: Array<Record<string, unknown>> = [];
        for (const scenario of scenarios) {
            const repoRoot = makeRealRuntimeSourceRepo();
            try {
                const manifestPath = capture(repoRoot);
                const identity = resolveSplitRequiredWipRestoreHandoffIdentity({
                    repoRoot, taskId: TASK_ID, manifestPath, includePaths: ['src/a.ts']
                });
                prepareSplitRequiredWipRestoreHandoff(identity, captureHealthyTaskTimelineAnchor(repoRoot, TASK_ID));
                assert.equal(restoreSplitRequiredWipForPreparedRuntimeHandoff(identity).status, 'RESTORED');
                promotePreparedSplitRequiredWipRestoreHandoff(identity);
                writeFile(repoRoot, 'package-lock.json', '{"generation":1}\n');
                writeFile(repoRoot, 'node_modules/typescript/package.json', '{"version":"5.9.1"}\n');
                const addedInputPath = scenario === 'runtime-input-added' ? 'src/late.json'
                    : scenario === 'runtime-file-root-created' ? 'tsconfig.build.json'
                        : scenario === 'runtime-directory-root-created' ? 'scripts/node-foundation/late.json' : '';
                if (addedInputPath) assert.equal(fs.existsSync(path.join(repoRoot, addedInputPath)), false, scenario);
                buildRealRuntimeSourceRepo(repoRoot);
                const cachePath = path.join(repoRoot, '.scripts-build', 'publish-runtime-build-cache.json');
                const publishedPath = path.join(repoRoot, 'dist', 'publish-runtime-manifest.json');
                const cacheBytes = fs.readFileSync(cachePath);
                const publishedBytes = fs.readFileSync(publishedPath);
                const handoffBytes = fs.readFileSync(identity.handoffPath);
                const probe = [
                    "const fs = require('node:fs');",
                    "const path = require('node:path');",
                    "const [root, manifestPath, taskId, scenario, addedInputPath] = process.argv.slice(1);",
                    "const runtimeRoot = path.join(root, 'dist', 'src');",
                    "const runtime = require(path.join(runtimeRoot, 'gates', 'split-required', 'split-required-wip-runtime-handoff.js'));",
                    "const contracts = require(path.join(runtimeRoot, 'gates', 'split-required', 'split-required-wip-runtime-handoff-contracts.js'));",
                    "const identity = contracts.resolveSplitRequiredWipRestoreHandoffIdentity({ repoRoot: root, taskId, manifestPath, includePaths: ['src/a.ts'] });",
                    "let mutated = false;",
                    "let generationReads = 0;",
                    "const mutate = () => {",
                    "  if (mutated) return;",
                    "  if (addedInputPath) {",
                    "    const added = path.join(root, addedInputPath);",
                    "    fs.mkdirSync(path.dirname(added), { recursive: true });",
                    "    fs.writeFileSync(added, '{}\\n');",
                    "    mutated = true;",
                    "    return;",
                    "  }",
                    "  const target = path.join(root, scenario === 'compiler-metadata' ? 'node_modules/typescript/package.json' : 'package-lock.json');",
                    "  const before = fs.statSync(target);",
                    "  if (scenario === 'file-replacement') {",
                    "    const replacement = target + '.replacement';",
                    "    fs.copyFileSync(target, replacement);",
                    "    fs.utimesSync(replacement, before.atime, before.mtime);",
                    "    fs.renameSync(replacement, target);",
                    "  } else {",
                    "    fs.writeFileSync(target, scenario === 'compiler-metadata' ? '{\"version\":\"5.9.2\"}\\n' : '{\"generation\":2}\\n');",
                    "    fs.utimesSync(target, before.atime, before.mtime);",
                    "  }",
                    "  mutated = true;",
                    "};",
                    "const installMutation = () => {",
                    "  const originalOpen = fs.openSync;",
                    "  fs.openSync = function(file, ...args) {",
                    "    const resolved = path.resolve(String(file));",
                    "    if ((scenario === 'later-input-read' || scenario === 'compiler-metadata') && resolved === path.join(root, 'src', 'a.ts')) mutate();",
                    "    if ((scenario === 'runtime-module-read' || addedInputPath) && resolved === path.join(runtimeRoot, 'gate-runtime', 'timeline', 'task-events-io.js')) mutate();",
                    "    return originalOpen.call(fs, file, ...args);",
                    "  };",
                    "  let sourceWalks = 0;",
                    "  const originalOpenDirectory = fs.opendirSync;",
                    "  fs.opendirSync = function(directory, ...args) {",
                    "    if (path.resolve(String(directory)) === path.join(root, 'src')) {",
                    "      sourceWalks += 1;",
                    "      if (sourceWalks === 2 && (scenario === 'final-inventory-walk' || scenario === 'file-replacement')) mutate();",
                    "    }",
                    "    return originalOpenDirectory.call(fs, directory, ...args);",
                    "  };",
                    "};",
                    "const result = runtime.finalizeSplitRequiredWipRestoreHandoff(identity, (repoRoot) => {",
                    "  generationReads += 1;",
                    "  if (generationReads === 2) installMutation();",
                    "  return runtime.resolveLoadedSplitRequiredWipRuntimeGeneration(repoRoot);",
                    "});",
                    "process.stdout.write(JSON.stringify({ ...result, mutated, generationReads }));"
                ].join('\n');
                const child = childProcess.spawnSync(process.execPath,
                    ['-e', probe, repoRoot, manifestPath, TASK_ID, scenario, addedInputPath],
                    { cwd: repoRoot, encoding: 'utf8', timeout: 30_000 });
                assert.equal(child.status, 0, child.stderr);
                const result = JSON.parse(child.stdout) as {
                    status: string; mutated: boolean; generationReads: number; violations: string[];
                };
                assert.equal(result.mutated, true, scenario);
                assert.equal(result.generationReads, 2, scenario);
                if (result.status === 'BLOCKED') {
                    assert.match(result.violations.join('\n'), /runtime.*changed|current input/u, scenario);
                }
                observations.push({
                    scenario,
                    status: result.status,
                    events: restoredEvents(repoRoot).length,
                    pending_preserved: fs.readFileSync(identity.handoffPath).equals(handoffBytes),
                    cache_preserved: fs.readFileSync(cachePath).equals(cacheBytes),
                    manifest_preserved: fs.readFileSync(publishedPath).equals(publishedBytes)
                });
            } finally {
                fs.rmSync(repoRoot, { recursive: true, force: true });
            }
        }
        assert.deepEqual(observations, scenarios.map(scenario => ({
            scenario, status: 'BLOCKED', events: 0, pending_preserved: true,
            cache_preserved: true, manifest_preserved: true
        })));
    });

    it('rejects forged local cache fingerprint payload and input authority', () => {
        const scenarios = ['payload-sha', 'changed-file-hash', 'omitted-files', 'foreign-host',
            'schema-version', 'coerced-count', 'path-alias'] as const;
        let rejected = 0;
        for (const scenario of scenarios) {
            const repoRoot = makeRealRuntimeSourceRepo();
            try {
                buildRealRuntimeSourceRepo(repoRoot);
                const manifestPath = path.join(repoRoot, 'dist', 'publish-runtime-manifest.json');
                const manifestBytes = fs.readFileSync(manifestPath);
                const cachePath = path.join(repoRoot, '.scripts-build', 'publish-runtime-build-cache.json');
                const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8')) as {
                    inputFingerprint: Record<string, unknown> & {
                        files: Array<{ path: string; size: number; sha256: string }>;
                    };
                };
                const fingerprint = cache.inputFingerprint;
                if (scenario === 'payload-sha') fingerprint.sha256 = 'a'.repeat(64);
                else {
                    if (scenario === 'changed-file-hash') fingerprint.files[0].sha256 = 'b'.repeat(64);
                    if (scenario === 'omitted-files') { fingerprint.files = []; fingerprint.fileCount = 0; }
                    if (scenario === 'foreign-host') fingerprint.platform = process.platform === 'win32' ? 'linux' : 'win32';
                    if (scenario === 'schema-version') fingerprint.schemaVersion = 2;
                    if (scenario === 'coerced-count') fingerprint.fileCount = [fingerprint.fileCount];
                    if (scenario === 'path-alias') fingerprint.files[0].path = `../${path.basename(repoRoot)}/${fingerprint.files[0].path}`;
                    const { sha256: _sha256, ...payload } = fingerprint;
                    fingerprint.sha256 = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
                }
                fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2) + '\n', 'utf8');
                const cacheBytes = fs.readFileSync(cachePath);

                const result = probeRuntimeGeneration(repoRoot);

                assert.equal(result.status, 1, scenario);
                assert.match(result.stderr, /runtime build cache fingerprint/u, scenario);
                assert.deepEqual(fs.readFileSync(cachePath), cacheBytes, scenario);
                assert.deepEqual(fs.readFileSync(manifestPath), manifestBytes, scenario);
                assert.equal(restoredEvents(repoRoot).length, 0, scenario);
                rejected += 1;
            } finally {
                fs.rmSync(repoRoot, { recursive: true, force: true });
            }
        }
        assert.equal(rejected, scenarios.length);
    });

    it('rejects over-budget local fingerprint authority and input discovery', () => {
        const scenarios = ['file-count', 'depth', 'metadata-bytes', 'input-bytes', 'aggregate-bytes'] as const;
        let rejected = 0;
        for (const scenario of scenarios) {
            const repoRoot = makeRealRuntimeSourceRepo();
            try {
                if (scenario === 'depth') writeFile(repoRoot, `src/${'d/'.repeat(65)}deep.json`, '{}\n');
                if (scenario === 'metadata-bytes') {
                    writeFile(repoRoot, 'node_modules/typescript/package.json',
                        JSON.stringify({ version: 'unknown', padding: ' '.repeat(1024 * 1024) }));
                }
                if (scenario === 'input-bytes' || scenario === 'aggregate-bytes') {
                    const input = Buffer.alloc((scenario === 'input-bytes' ? 65 : 50) * 1024 * 1024, 32);
                    input[0] = 123;
                    input[input.length - 1] = 125;
                    const count = scenario === 'input-bytes' ? 1 : 3;
                    for (let index = 0; index < count; index += 1) {
                        fs.writeFileSync(path.join(repoRoot, 'src', `large-${index}.json`), input);
                    }
                }
                buildRealRuntimeSourceRepo(repoRoot);
                const manifestPath = path.join(repoRoot, 'dist', 'publish-runtime-manifest.json');
                const cachePath = path.join(repoRoot, '.scripts-build', 'publish-runtime-build-cache.json');
                const manifestBytes = fs.readFileSync(manifestPath);
                if (scenario === 'file-count') {
                    const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8')) as {
                        inputFingerprint: Record<string, unknown> & { files: Array<Record<string, unknown>> };
                    };
                    cache.inputFingerprint.files = Array.from({ length: 8193 }, () => cache.inputFingerprint.files[0]);
                    cache.inputFingerprint.fileCount = cache.inputFingerprint.files.length;
                    const { sha256: _sha256, ...payload } = cache.inputFingerprint;
                    cache.inputFingerprint.sha256 = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
                    fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2) + '\n');
                }
                const cacheBytes = fs.readFileSync(cachePath);

                const result = probeRuntimeGeneration(repoRoot);

                assert.equal(result.status, 1, scenario);
                assert.match(result.stderr, /bounded inventory|depth limit|byte limit/u, scenario);
                assert.deepEqual(fs.readFileSync(cachePath), cacheBytes, scenario);
                assert.deepEqual(fs.readFileSync(manifestPath), manifestBytes, scenario);
                assert.equal(restoredEvents(repoRoot).length, 0, scenario);
                rejected += 1;
            } finally {
                fs.rmSync(repoRoot, { recursive: true, force: true });
            }
        }
        assert.equal(rejected, scenarios.length);
    });

    it('rejects a generated runtime whose manifest omits the finalizer module', () => {
        const repoRoot = makeRealRuntimeSourceRepo();
        try {
            buildRealRuntimeSourceRepo(repoRoot);
            const manifestPath = path.join(repoRoot, 'dist', 'publish-runtime-manifest.json');
            const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { files: string[] };
            manifest.files = manifest.files.filter((entry) => (
                entry !== 'src/gates/split-required/split-required-wip-runtime-handoff.js'
            ));
            fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

            const result = probeRuntimeGeneration(repoRoot);

            assert.equal(result.status, 1);
            assert.match(result.stderr, /manifest does not bind required finalizer module/u);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('rejects a generated runtime whose manifest omits the task-event writer module', () => {
        const repoRoot = makeRealRuntimeSourceRepo();
        try {
            buildRealRuntimeSourceRepo(repoRoot);
            const manifestPath = path.join(repoRoot, 'dist', 'publish-runtime-manifest.json');
            const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { files: string[] };
            manifest.files = manifest.files.filter((entry) => (
                entry !== 'src/gate-runtime/timeline/task-events-io.js'
            ));
            fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

            const result = probeRuntimeGeneration(repoRoot);

            assert.equal(result.status, 1);
            assert.match(result.stderr, /manifest does not bind required finalizer module/u);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('rejects a zero-exit fresh runtime that forges finalized handoff evidence without an event', async (context) => {
        const repoRoot = makeSourceRepo();
        const manifestPath = capture(repoRoot);
        mockRuntimeProcesses(context, async (command, _args, options) => {
            if (command !== process.execPath) return runtimeResult();
            const identity = resolveSplitRequiredWipRestoreHandoffIdentity({ repoRoot, taskId: TASK_ID, manifestPath });
            const pending = readAndVerifySplitRequiredWipRestoreHandoff(identity);
            replaceSplitRequiredWipRestoreHandoff(identity.handoffPath, {
                ...pending, status: 'finalized', finalized_at_utc: new Date().toISOString(),
                runtime_generation: fakeRuntimeGeneration(),
                event_integrity: { schema_version: 2,
                    task_sequence: (identity.timelineAnchor.last_integrity_sequence || 0) + 1,
                    prev_event_sha256: identity.timelineAnchor.last_event_sha256, event_sha256: 'd'.repeat(64) }
            }, pending);
            assert.equal(options?.env?.[SPLIT_REQUIRED_WIP_RESTORE_HANDOFF_ENV], identity.handoffPath);
            return runtimeResult();
        });
        try {
            const result = await restoreSplitRequiredWipThroughRuntimeHandoff({ repoRoot, taskId: TASK_ID, manifestPath });
            assert.equal(result.status, 'BLOCKED');
            assert.match(result.violations.join('\n'), /not bound to its canonical task event/u);
            assert.equal(restoredEvents(repoRoot).length, 0);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('authenticates finalized replay without rebuilding and rejects changed event evidence', async (context) => {
        const repoRoot = makeSourceRepo();
        const manifestPath = capture(repoRoot);
        const params = { repoRoot, taskId: TASK_ID, manifestPath };
        const identity = resolveSplitRequiredWipRestoreHandoffIdentity(params);
        prepareSplitRequiredWipRestoreHandoff(identity, identity.timelineAnchor);
        assert.equal(restoreSplitRequiredWipForPreparedRuntimeHandoff(identity).status, 'RESTORED');
        promotePreparedSplitRequiredWipRestoreHandoff(identity);
        assert.equal(finalizeSplitRequiredWipRestoreHandoff(identity, fakeRuntimeGeneration).status, 'RESTORED');
        let runtimeChildCalls = 0;
        mockRuntimeProcesses(context, async () => {
            runtimeChildCalls += 1;
            return runtimeResult({ exitCode: 1, stderr: 'fixture later build failed' });
        });
        try {
            const replayed = await restoreSplitRequiredWipThroughRuntimeHandoff(params);
            assert.equal(replayed.status, 'RESTORED', replayed.violations.join('\n'));
            assert.equal(replayed.output_lines[0], 'SPLIT_REQUIRED_WIP_ALREADY_RESTORED');
            assert.equal(runtimeChildCalls, 0);
            assert.equal(restoredEvents(repoRoot).length, 1);
            const finalized = readAndVerifySplitRequiredWipRestoreHandoff(identity);
            assert.ok(finalized.event_integrity);
            replaceSplitRequiredWipRestoreHandoff(identity.handoffPath, {
                ...finalized, event_integrity: { ...finalized.event_integrity, event_sha256: 'f'.repeat(64) }
            }, finalized);
            const forged = await restoreSplitRequiredWipThroughRuntimeHandoff(params);
            assert.equal(forged.status, 'BLOCKED');
            assert.match(forged.violations.join('\n'), /not bound to its canonical task event/u);
            assert.equal(runtimeChildCalls, 0);
            assert.equal(restoredEvents(repoRoot).length, 1);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('coalesces overlapping restores into one build and finalizer without retaining completion', async (context) => {
        const repoRoot = makeSourceRepo();
        const manifestPath = capture(repoRoot);
        const params = { repoRoot, taskId: TASK_ID, manifestPath };
        let buildCalls = 0;
        let finalizerCalls = 0;
        let signalBuildStarted = (): void => { throw new Error('Build start signal is not initialized.'); };
        let releaseBuild = (): void => { throw new Error('Build release signal is not initialized.'); };
        const buildStarted = new Promise<void>((resolve) => { signalBuildStarted = resolve; });
        const buildRelease = new Promise<void>((resolve) => { releaseBuild = resolve; });
        mockRuntimeProcesses(context, async (command) => {
            if (command !== process.execPath) {
                buildCalls += 1;
                signalBuildStarted();
                await buildRelease;
                return runtimeResult();
            }
            finalizerCalls += 1;
            const identity = resolveSplitRequiredWipRestoreHandoffIdentity(params);
            const finalized = finalizeSplitRequiredWipRestoreHandoff(identity, fakeRuntimeGeneration);
            assert.equal(finalized.status, 'RESTORED', finalized.violations.join('\n'));
            return runtimeResult({ stdout: finalized.output_lines.join('\n') });
        });
        try {
            const first = restoreSplitRequiredWipThroughRuntimeHandoff(params);
            await buildStarted;
            const second = restoreSplitRequiredWipThroughRuntimeHandoff(params);
            await Promise.resolve();
            assert.equal(buildCalls, 1);
            assert.equal(finalizerCalls, 0);
            releaseBuild();

            const results = await Promise.all([first, second]);
            assert.deepEqual(results.map((result) => result.status), ['RESTORED', 'RESTORED']);
            assert.equal(buildCalls, 1);
            assert.equal(finalizerCalls, 1);
            assert.equal(restoredEvents(repoRoot).length, 1);

            const identity = resolveSplitRequiredWipRestoreHandoffIdentity(params);
            const finalized = readAndVerifySplitRequiredWipRestoreHandoff(identity);
            assert.ok(finalized.event_integrity);
            replaceSplitRequiredWipRestoreHandoff(identity.handoffPath, {
                ...finalized,
                event_integrity: { ...finalized.event_integrity, event_sha256: 'f'.repeat(64) }
            }, finalized);
            const afterCompletion = await restoreSplitRequiredWipThroughRuntimeHandoff(params);
            assert.equal(afterCompletion.status, 'BLOCKED');
            assert.match(afterCompletion.violations.join('\n'), /not bound to its canonical task event/u);
            assert.equal(buildCalls, 1);
            assert.equal(finalizerCalls, 1);
        } finally {
            releaseBuild();
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('releases a coalesced build failure so a later restore retries once', async (context) => {
        const repoRoot = makeSourceRepo();
        const manifestPath = capture(repoRoot);
        const params = { repoRoot, taskId: TASK_ID, manifestPath };
        let buildCalls = 0;
        let finalizerCalls = 0;
        let signalBuildStarted = (): void => { throw new Error('Build start signal is not initialized.'); };
        let releaseBuild = (): void => { throw new Error('Build release signal is not initialized.'); };
        const buildStarted = new Promise<void>((resolve) => { signalBuildStarted = resolve; });
        const buildRelease = new Promise<void>((resolve) => { releaseBuild = resolve; });
        mockRuntimeProcesses(context, async (command) => {
            if (command !== process.execPath) {
                buildCalls += 1;
                if (buildCalls === 1) {
                    signalBuildStarted();
                    await buildRelease;
                    return runtimeResult({ exitCode: 1, stderr: 'fixture shared build failed' });
                }
                return runtimeResult();
            }
            finalizerCalls += 1;
            const identity = resolveSplitRequiredWipRestoreHandoffIdentity(params);
            const finalized = finalizeSplitRequiredWipRestoreHandoff(identity, fakeRuntimeGeneration);
            assert.equal(finalized.status, 'RESTORED', finalized.violations.join('\n'));
            return runtimeResult({ stdout: finalized.output_lines.join('\n') });
        });
        try {
            const first = restoreSplitRequiredWipThroughRuntimeHandoff(params);
            await buildStarted;
            const second = restoreSplitRequiredWipThroughRuntimeHandoff(params);
            await Promise.resolve();
            assert.equal(buildCalls, 1);
            releaseBuild();

            const interrupted = await Promise.all([first, second]);
            assert.deepEqual(interrupted.map((result) => result.status), ['BLOCKED', 'BLOCKED']);
            assert.equal(buildCalls, 1);
            assert.equal(finalizerCalls, 0);
            assert.equal(restoredEvents(repoRoot).length, 0);

            const retried = await restoreSplitRequiredWipThroughRuntimeHandoff(params);
            assert.equal(retried.status, 'RESTORED', retried.violations.join('\n'));
            assert.equal(buildCalls, 2);
            assert.equal(finalizerCalls, 1);
            assert.equal(restoredEvents(repoRoot).length, 1);
        } finally {
            releaseBuild();
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('recovers an appended event after final handoff persistence fails without duplicating it', (context) => {
        const { repoRoot, identity } = preparePendingHandoff();
        const contracts = require('../../../../src/gates/split-required/split-required-wip-runtime-handoff-contracts') as
            typeof import('../../../../src/gates/split-required/split-required-wip-runtime-handoff-contracts');
        const replacement = context.mock.method(contracts, 'replaceSplitRequiredWipRestoreHandoff', () => {
            throw new Error('fixture interrupted final handoff persistence');
        });
        try {
            const interrupted = finalizeSplitRequiredWipRestoreHandoff(identity, fakeRuntimeGeneration);
            assert.equal(interrupted.status, 'BLOCKED');
            assert.match(interrupted.violations.join('\n'), /interrupted final handoff persistence/u);
            assert.equal(readAndVerifySplitRequiredWipRestoreHandoff(identity).status, 'pending');
            assert.equal(restoredEvents(repoRoot).length, 1);
            replacement.mock.restore();
            const recovered = finalizeSplitRequiredWipRestoreHandoff(identity, fakeRuntimeGeneration);
            assert.equal(recovered.status, 'ALREADY_RESTORED');
            assert.equal(readAndVerifySplitRequiredWipRestoreHandoff(identity).status, 'finalized');
            assert.equal(restoredEvents(repoRoot).length, 1);
        } finally {
            replacement.mock.restore();
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('preserves pending handoff on build or finalizer timeout and retries exactly once', async (context) => {
        let verifiedCases = 0;
        for (const timedOutStage of ['build', 'finalizer']) {
            const repoRoot = makeSourceRepo();
            const manifestPath = capture(repoRoot);
            let failOnce = true;
            mockRuntimeProcesses(context, async (command, _args, options) => {
                const build = command !== process.execPath;
                assert.equal(options?.timeoutMs, build ? 600_000 : 120_000);
                assert.equal(options?.maxBuffer, 16 * 1024 * 1024);
                if (failOnce && (build ? 'build' : 'finalizer') === timedOutStage) {
                    failOnce = false;
                    return runtimeResult({ exitCode: 1, timedOut: true });
                }
                if (!build) {
                    const identity = resolveSplitRequiredWipRestoreHandoffIdentity({ repoRoot, taskId: TASK_ID, manifestPath });
                    const finalized = finalizeSplitRequiredWipRestoreHandoff(identity, fakeRuntimeGeneration);
                    assert.equal(finalized.status, 'RESTORED', finalized.violations.join('\n'));
                    return runtimeResult({ stdout: finalized.output_lines.join('\n') });
                }
                return runtimeResult();
            });
            try {
                const params = { repoRoot, taskId: TASK_ID, manifestPath };
                const interrupted = await restoreSplitRequiredWipThroughRuntimeHandoff(params);
                assert.equal(interrupted.status, 'BLOCKED');
                assert.match(interrupted.violations.join('\n'), /timed out/u);
                const identity = resolveSplitRequiredWipRestoreHandoffIdentity(params);
                assert.equal(readAndVerifySplitRequiredWipRestoreHandoff(identity).status, 'pending');
                assert.equal(restoredEvents(repoRoot).length, 0);
                const retried = await restoreSplitRequiredWipThroughRuntimeHandoff(params);
                assert.equal(retried.status, 'RESTORED', retried.violations.join('\n'));
                assert.equal(readAndVerifySplitRequiredWipRestoreHandoff(identity).status, 'finalized');
                assert.equal(restoredEvents(repoRoot).length, 1);
                verifiedCases += 1;
            } finally {
                context.mock.restoreAll();
                fs.rmSync(repoRoot, { recursive: true, force: true });
            }
        }
        assert.equal(verifiedCases, 2);
    });

    it('restored runtime build failure leaves handoff pending without appending an event', async (context) => {
        const repoRoot = makeSourceRepo();
        const manifestPath = capture(repoRoot);
        mockRuntimeProcesses(context, async () => runtimeResult({ exitCode: 1, stderr: 'fixture build failed' }));
        try {
            const result = await restoreSplitRequiredWipThroughRuntimeHandoff({ repoRoot, taskId: TASK_ID, manifestPath });
            const identity = resolveSplitRequiredWipRestoreHandoffIdentity({ repoRoot, taskId: TASK_ID, manifestPath });
            assert.equal(result.status, 'BLOCKED');
            assert.match(result.violations.join('\n'), /runtime rebuild failed/u);
            assert.equal(readAndVerifySplitRequiredWipRestoreHandoff(identity).status, 'pending');
            assert.equal(restoredEvents(repoRoot).length, 0);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('rejects secret exposure from child output and errors while preserving restore state', async (context) => {
        let verifiedCases = 0;
        for (const scenario of ['build-output', 'build-error', 'finalizer-output', 'finalizer-error', 'success']) {
            const repoRoot = makeSourceRepo();
            const manifestPath = capture(repoRoot);
            const stdout = [
                'E_DEMO diagnostic detail', 'api_token=fixture-stdout-secret',
                '-----BEGIN PRIVATE KEY-----',
                ...Array.from({ length: 25 }, () => 'fixture-private-key-material'),
                '-----END PRIVATE KEY-----'
            ].join('\n');
            const stderr = '{"password":"fixture-stderr-secret"}';
            mockRuntimeProcesses(context, async (command) => {
                const stage = command === process.execPath ? 'finalizer' : 'build';
                if (scenario === `${stage}-error`) {
                    throw new Error('E_DEMO Authorization: Bearer fixture-error-secret');
                }
                if (scenario === `${stage}-output`) {
                    return runtimeResult({ exitCode: 1, stdout, stderr });
                }
                if (stage === 'finalizer') {
                    const identity = resolveSplitRequiredWipRestoreHandoffIdentity({ repoRoot, taskId: TASK_ID, manifestPath });
                    const finalized = finalizeSplitRequiredWipRestoreHandoff(identity, fakeRuntimeGeneration);
                    assert.equal(finalized.status, 'RESTORED', finalized.violations.join('\n'));
                    return runtimeResult({ stdout: `${finalized.output_lines.join('\n')}\n${stdout}` });
                }
                return runtimeResult();
            });
            try {
                const result = await restoreSplitRequiredWipThroughRuntimeHandoff({ repoRoot, taskId: TASK_ID, manifestPath });
                const publicText = JSON.stringify({ violations: result.violations, output_lines: result.output_lines });
                assert.doesNotMatch(publicText, /fixture-(stdout-secret|stderr-secret|error-secret|private-key-material)/u);
                if (scenario === 'success') {
                    assert.doesNotMatch(publicText, /E_DEMO/u);
                    assert.equal(result.output_lines[0], 'SPLIT_REQUIRED_WIP_RESTORED');
                } else {
                    assert.match(publicText, /redacted/u);
                    assert.match(publicText, /E_DEMO/u);
                }
                assert.equal(result.status, scenario === 'success' ? 'RESTORED' : 'BLOCKED');
                assert.equal(restoredEvents(repoRoot).length, scenario === 'success' ? 1 : 0);
                const identity = resolveSplitRequiredWipRestoreHandoffIdentity({ repoRoot, taskId: TASK_ID, manifestPath });
                assert.equal(readAndVerifySplitRequiredWipRestoreHandoff(identity).status,
                    scenario === 'success' ? 'finalized' : 'pending');
                verifiedCases += 1;
            } finally {
                context.mock.restoreAll();
                fs.rmSync(repoRoot, { recursive: true, force: true });
            }
        }
        assert.equal(verifiedCases, 5);
    });

    it('bounds newline-dense failure diagnostics without splitting every child-output line', async (context) => {
        const repoRoot = makeSourceRepo();
        const manifestPath = capture(repoRoot);
        const denseOutput = `${'\n'.repeat(100_000)}fixture terminal diagnostic`;
        const originalSplit = String.prototype.split;
        context.mock.method(String.prototype, 'split', function (
            this: string,
            separator?: string | RegExp,
            limit?: number
        ): string[] {
            const text = String(this);
            if (text === denseOutput) {
                throw new Error('newline-dense diagnostic output must not be split');
            }
            return Reflect.apply(
                originalSplit,
                text,
                separator === undefined ? [] : [separator, limit]
            ) as string[];
        });
        mockRuntimeProcesses(context, async () => runtimeResult({ exitCode: 1, stderr: denseOutput }));
        try {
            const result = await restoreSplitRequiredWipThroughRuntimeHandoff({
                repoRoot,
                taskId: TASK_ID,
                manifestPath
            });
            assert.equal(result.status, 'BLOCKED');
            assert.match(result.violations.join('\n'), /fixture terminal diagnostic/u);
            assert.doesNotMatch(result.violations.join('\n'), /must not be split/u);
        } finally {
            context.mock.restoreAll();
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('rejects successful child output flooding and returns only authenticated finalization fields', async (context) => {
        const repoRoot = makeSourceRepo();
        const manifestPath = capture(repoRoot);
        mockRuntimeProcesses(context, async (command) => {
            if (command !== process.execPath) return runtimeResult();
            const identity = resolveSplitRequiredWipRestoreHandoffIdentity({ repoRoot, taskId: TASK_ID, manifestPath });
            const finalized = finalizeSplitRequiredWipRestoreHandoff(identity, fakeRuntimeGeneration);
            assert.equal(finalized.status, 'RESTORED', finalized.violations.join('\n'));
            return runtimeResult({
                stdout: `SPLIT_REQUIRED_WIP_RESTORE_BLOCKED\n${'untrusted child line\n'.repeat(4096)}${'x'.repeat(256 * 1024)}`,
                stderr: 'untrusted successful child diagnostic'
            });
        });
        try {
            const result = await restoreSplitRequiredWipThroughRuntimeHandoff({ repoRoot, taskId: TASK_ID, manifestPath });
            const identity = resolveSplitRequiredWipRestoreHandoffIdentity({ repoRoot, taskId: TASK_ID, manifestPath });
            assert.equal(result.status, 'RESTORED');
            assert.deepEqual(result.violations, []);
            assert.deepEqual(result.output_lines, [
                'SPLIT_REQUIRED_WIP_RESTORED',
                `ManifestPath: ${identity.manifestPath.replace(/\\/gu, '/')}`,
                'SelectedPaths: all',
                'RestoredFiles: src/a.ts',
                `RuntimeHandoff: ${identity.handoffPath.replace(/\\/gu, '/')}`
            ]);
            assert.equal(restoredEvents(repoRoot).length, 1);
            assert.equal(readAndVerifySplitRequiredWipRestoreHandoff(identity).status, 'finalized');
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('rejects a timed-out build and kills its descendant before allowing a successful retry', async (context) => {
        const repoRoot = makeSourceRepo('node build-tree.cjs');
        writeFile(repoRoot, 'grandchild.cjs', "setTimeout(() => process.exit(0), 15000); setInterval(() => {}, 1000);\n");
        writeFile(repoRoot, 'build-tree.cjs', [
            "const fs = require('node:fs'); const cp = require('node:child_process');",
            "const child = cp.spawn(process.execPath, ['grandchild.cjs'], { stdio: 'inherit' });",
            "fs.writeFileSync('descendant.pid', String(child.pid));",
            "setTimeout(() => process.exit(0), 15000); setInterval(() => {}, 1000);"
        ].join('\n'));
        runGit(repoRoot, ['add', 'grandchild.cjs', 'build-tree.cjs']);
        runGit(repoRoot, ['commit', '-m', 'build descendant fixture']);
        const manifestPath = capture(repoRoot);
        const subprocess = require('../../../../src/core/process/subprocess') as typeof import('../../../../src/core/process/subprocess');
        const runBuild = process.platform === 'win32' ? subprocess.spawnShellCommand : subprocess.spawnStreamed;
        let descendantPid: number | null = null;
        mockRuntimeProcesses(context, async (command, args, options) => {
            if (command === process.execPath) {
                const identity = resolveSplitRequiredWipRestoreHandoffIdentity({ repoRoot, taskId: TASK_ID, manifestPath });
                const finalized = finalizeSplitRequiredWipRestoreHandoff(identity, fakeRuntimeGeneration);
                assert.equal(finalized.status, 'RESTORED', finalized.violations.join('\n'));
                return runtimeResult({ stdout: finalized.output_lines.join('\n') });
            }
            assert.equal(options?.timeoutMs, 600_000);
            return runBuild(command, args, { ...options, timeoutMs: 3_000 });
        });
        try {
            const started = Date.now();
            const interrupted = await restoreSplitRequiredWipThroughRuntimeHandoff({ repoRoot, taskId: TASK_ID, manifestPath });
            descendantPid = Number(fs.readFileSync(path.join(repoRoot, 'descendant.pid'), 'utf8'));
            assert.equal(interrupted.status, 'BLOCKED');
            assert.match(interrupted.violations.join('\n'), /timed out/u);
            assert.ok(Date.now() - started < 12_000);
            assert.throws(() => process.kill(descendantPid!, 0), { code: 'ESRCH' });
            assert.equal(restoredEvents(repoRoot).length, 0);
            writeFile(repoRoot, 'build-tree.cjs', "require('node:fs').writeFileSync('retry-built', 'yes');\n");
            const retried = await restoreSplitRequiredWipThroughRuntimeHandoff({ repoRoot, taskId: TASK_ID, manifestPath });
            assert.equal(retried.status, 'RESTORED', retried.violations.join('\n'));
            assert.equal(fs.readFileSync(path.join(repoRoot, 'retry-built'), 'utf8'), 'yes');
            assert.equal(restoredEvents(repoRoot).length, 1);
        } finally {
            if (descendantPid !== null) {
                try { process.kill(descendantPid, 'SIGKILL'); } catch { /* Already terminated. */ }
            }
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });
});
