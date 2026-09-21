import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { readGitTreeEntriesForPaths } from '../../../../src/core/git-helpers';
import {
    captureAndSuspendSplitRequiredWip,
    restoreSplitRequiredWip
} from '../../../../src/gates/split-required/split-required-wip';
import { traceGitCommands } from '../git-command-trace';

const TASK_ID = 'T-CAPTURE';

function runGit(repoRoot: string, args: string[]): string {
    return childProcess.execFileSync('git', ['-C', repoRoot, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe']
    });
}

function writeFile(repoRoot: string, relativePath: string, content: string): void {
    const filePath = path.join(repoRoot, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
}

function removeTempRoot(rootPath: string): void {
    fs.rmSync(rootPath, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 50
    });
}

function makeRepo(): string {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-split-capture-'));
    runGit(repoRoot, ['init']);
    runGit(repoRoot, ['config', 'user.email', 'test@example.invalid']);
    runGit(repoRoot, ['config', 'user.name', 'Test User']);
    runGit(repoRoot, ['config', 'core.autocrlf', 'false']);
    runGit(repoRoot, ['config', 'core.eol', 'lf']);
    writeFile(repoRoot, '.gitignore', 'garda-agent-orchestrator/runtime/\n');
    writeFile(repoRoot, 'README.md', '# Capture fixture\n');
    writeFile(repoRoot, 'src/app.ts', 'export const value = 1;\n');
    writeFile(repoRoot, 'TASK.md', [
        '# TASK.md',
        '',
        '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
        '|---|---|---|---|---|---|---|---|---|',
        `| ${TASK_ID} | IN_PROGRESS | P1 | workflow | Capture fixture | gpt-5.6 | 2026-07-31 | balanced | Test. |`,
        ''
    ].join('\n'));
    runGit(repoRoot, ['add', '.']);
    runGit(repoRoot, ['commit', '-m', 'initial']);
    return repoRoot;
}

function writePreflight(repoRoot: string, changedFiles: string[]): string {
    const preflightPath = path.join(
        repoRoot,
        'garda-agent-orchestrator',
        'runtime',
        'reviews',
        `${TASK_ID}-preflight.json`
    );
    fs.mkdirSync(path.dirname(preflightPath), { recursive: true });
    fs.writeFileSync(preflightPath, `${JSON.stringify({
        task_id: TASK_ID,
        changed_files: changedFiles,
        required_reviews: {},
        metrics: {
            changed_files_count: changedFiles.length,
            changed_lines_total: changedFiles.length
        }
    }, null, 2)}\n`, 'utf8');
    return preflightPath;
}

function capture(repoRoot: string, changedFiles: string[]) {
    return captureAndSuspendSplitRequiredWip({
        repoRoot,
        taskId: TASK_ID,
        preflightPath: writePreflight(repoRoot, changedFiles),
        guardKind: 'scope_budget',
        guardReason: 'capture boundary test'
    });
}

type CaptureCheckoutState = 'suspended' | 'restored' | 'indeterminate';

function checkoutState(result: ReturnType<typeof capture>): CaptureCheckoutState | undefined {
    return (result as ReturnType<typeof capture> & {
        checkout_state?: CaptureCheckoutState;
    }).checkout_state;
}

function restoreCapturedWip(repoRoot: string, captured: ReturnType<typeof capture>): void {
    assert.ok(captured.manifest_path);
    const restored = restoreSplitRequiredWip({
        repoRoot,
        taskId: TASK_ID,
        manifestPath: captured.manifest_path
    });
    assert.equal(restored.status, 'RESTORED', restored.violations.join('\n'));
}

function assertRetainedCaptureBlocked(
    first: ReturnType<typeof capture>,
    second: ReturnType<typeof capture>,
    violationFragment: string
): void {
    assert.equal(second.status, 'BLOCKED');
    assert.equal(checkoutState(second), 'indeterminate');
    assert.equal(second.manifest_path, first.manifest_path);
    assert.ok(second.violations.some((violation) => violation.includes(violationFragment)));
}

function captureWithClosingHeadMismatch(repoRoot: string, changedFiles: string[]): {
    result: ReturnType<typeof capture>;
    headReads: number;
    inspectionEvents: string[];
} {
    const childProcessModule = require('node:child_process') as typeof import('node:child_process');
    const fsModule = require('node:fs') as typeof import('node:fs');
    const originalExecFileSync = childProcessModule.execFileSync;
    const originalReadFileSync = fsModule.readFileSync;
    let headReads = 0;
    const inspectionEvents: string[] = [];
    childProcessModule.execFileSync = ((
        file: string,
        args?: readonly string[],
        options?: childProcess.ExecFileSyncOptions
    ) => {
        const commandArgs = Array.isArray(args) ? args.map(String) : [];
        if (file === 'git' && commandArgs.includes('rev-parse') && commandArgs.includes('HEAD')) {
            headReads += 1;
            inspectionEvents.push(`head:${headReads}`);
            if (headReads === 2) {
                return `${'f'.repeat(40)}\n`;
            }
        } else if (file === 'git' && headReads === 1) {
            inspectionEvents.push(`git:${commandArgs.join(' ')}`);
        }
        return Reflect.apply(originalExecFileSync, childProcessModule, [file, args, options]);
    }) as typeof childProcessModule.execFileSync;
    fsModule.readFileSync = ((...args: unknown[]) => {
        if (headReads === 1) {
            inspectionEvents.push('fs:readFileSync');
        }
        return Reflect.apply(originalReadFileSync, fsModule, args);
    }) as typeof fsModule.readFileSync;
    let result: ReturnType<typeof capture> | null = null;
    try {
        result = capture(repoRoot, changedFiles);
    } finally {
        childProcessModule.execFileSync = originalExecFileSync;
        fsModule.readFileSync = originalReadFileSync;
    }
    assert.ok(result);
    return { result, headReads, inspectionEvents };
}

function assertClosingHeadRecheckAfterWorkspaceInspection(
    inspectionEvents: string[],
    options: { expectContentRead: boolean }
): void {
    assert.equal(inspectionEvents[0], 'head:1');
    assert.equal(inspectionEvents.at(-1), 'head:2');
    const closingHeadIndex = inspectionEvents.indexOf('head:2');
    assert.ok(closingHeadIndex > 0);
    const beforeClosingHead = inspectionEvents.slice(0, closingHeadIndex);
    assert.ok(beforeClosingHead.some((event) => (
        event.startsWith('git:')
        && event.includes(' diff ')
        && event.includes('--cached')
        && event.includes('--name-only')
    )));
    assert.ok(beforeClosingHead.some((event) => (
        event.startsWith('git:')
        && event.includes(' diff ')
        && !event.includes('--cached')
        && event.includes('--name-only')
    )));
    assert.ok(beforeClosingHead.some((event) => (
        event.startsWith('git:') && event.includes(' ls-files ') && event.includes('--others')
    )));
    assert.equal(beforeClosingHead.includes('fs:readFileSync'), options.expectContentRead);
}

function captureDirectories(repoRoot: string): string[] {
    const captureRoot = path.join(
        repoRoot,
        'garda-agent-orchestrator',
        'runtime',
        'wip',
        TASK_ID,
        'split-required'
    );
    if (!fs.existsSync(captureRoot)) {
        return [];
    }
    return fs.readdirSync(captureRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();
}

describe('split-required WIP capture boundary', () => {
    it('sizes missing-tree metadata batches from UTF-8 request bytes', (context) => {
        const repoRoot = makeRepo();
        context.after(() => removeTempRoot(repoRoot));
        const deepPrefix = Array.from(
            { length: 14 },
            (_, index) => `segment-${index}-${'x'.repeat(80)}`
        ).join('/');
        const missingPaths = Array.from(
            { length: 1024 },
            (_, index) => `${deepPrefix}/missing-${index}/file.ts`
        );

        assert.deepEqual(readGitTreeEntriesForPaths(repoRoot, 'HEAD', missingPaths), new Map());
    });

    it('keeps Git subprocess count constant as the tracked capture grows', (context) => {
        const measure = (count: number) => {
            const repoRoot = makeRepo();
            context.after(() => removeTempRoot(repoRoot));
            const changedFiles = Array.from({ length: count }, (_, index) => `src/batch file ${index}.ts`);
            for (const [index, relativePath] of changedFiles.entries()) {
                writeFile(repoRoot, relativePath, `export const batch${index} = 1;\n`);
            }
            runGit(repoRoot, ['add', '.']);
            runGit(repoRoot, ['commit', '-m', `seed ${count} batch files`]);
            for (const [index, relativePath] of changedFiles.entries()) {
                writeFile(repoRoot, relativePath, `export const batch${index} = 2;\n`);
            }

            const traced = traceGitCommands(() => capture(repoRoot, changedFiles));
            assert.equal(traced.value.status, 'CAPTURED', traced.value.violations.join('\n'));
            return traced.commands;
        };

        const singleFileCommands = measure(1);
        const multiFileCommands = measure(12);
        assert.equal(multiFileCommands.length, singleFileCommands.length);
        assert.equal(multiFileCommands.some((args) => args[0] === 'ls-tree'), false);
        const treeBatchCommands = multiFileCommands.filter((args) => args[0] === 'cat-file');
        assert.equal(treeBatchCommands.length, 2);
        assert.ok(treeBatchCommands.some((args) => args.some((arg) => arg.startsWith('--batch-check='))));
        assert.ok(treeBatchCommands.some((args) => args.includes('--batch')));
        assert.equal(
            multiFileCommands.some((args) => args[0] === 'rev-parse' && args.some((arg) => arg.includes(':src/'))),
            false
        );
    });

    it('captures and restores exact staged unstaged and authorized untracked WIP', (context) => {
        const repoRoot = makeRepo();
        context.after(() => removeTempRoot(repoRoot));
        writeFile(repoRoot, 'src/app.ts', 'export const value = 2;\n');
        runGit(repoRoot, ['add', 'src/app.ts']);
        writeFile(repoRoot, 'src/app.ts', 'export const value = 3;\n');
        writeFile(repoRoot, 'src/new.ts', 'export const added = true;\n');

        const captured = capture(repoRoot, ['src/app.ts', 'src/new.ts']);

        assert.equal(captured.status, 'CAPTURED', captured.violations.join('\n'));
        assert.ok(captured.manifest_path);
        assert.deepEqual(captured.tracked_files, ['src/app.ts']);
        assert.deepEqual(captured.untracked_files, ['src/new.ts']);
        assert.equal(fs.readFileSync(path.join(repoRoot, 'src/app.ts'), 'utf8'), 'export const value = 1;\n');
        assert.equal(fs.existsSync(path.join(repoRoot, 'src/new.ts')), false);
        assert.equal(runGit(repoRoot, ['diff', '--cached', '--name-only']).trim(), '');
        assert.equal(runGit(repoRoot, ['diff', '--name-only']).trim(), '');

        const manifest = JSON.parse(
            fs.readFileSync(captured.manifest_path, 'utf8')
        ) as {
            kind: string;
            patches: {
                staged: { bytes: number; empty: boolean };
                unstaged: { bytes: number; empty: boolean };
            };
            tracked_files: Array<{
                path: string;
                head_sha256: string | null;
                worktree_sha256: string | null;
                staged: boolean;
                unstaged: boolean;
            }>;
            untracked_files: Array<{ path: string; artifact_path: string }>;
        };
        assert.equal(manifest.kind, 'split_required_wip');
        assert.equal(manifest.patches.staged.empty, false);
        assert.ok(manifest.patches.staged.bytes > 0);
        assert.equal(manifest.patches.unstaged.empty, false);
        assert.ok(manifest.patches.unstaged.bytes > 0);
        assert.equal(manifest.tracked_files.length, 1);
        assert.equal(manifest.tracked_files[0]?.path, 'src/app.ts');
        assert.ok(manifest.tracked_files[0]?.head_sha256);
        assert.ok(manifest.tracked_files[0]?.worktree_sha256);
        assert.equal(manifest.tracked_files[0]?.staged, true);
        assert.equal(manifest.tracked_files[0]?.unstaged, true);
        assert.equal(manifest.untracked_files[0]?.path, 'src/new.ts');
        assert.equal(
            fs.readFileSync(manifest.untracked_files[0]!.artifact_path, 'utf8'),
            'export const added = true;\n'
        );

        const restored = restoreSplitRequiredWip({
            repoRoot,
            taskId: TASK_ID,
            manifestPath: captured.manifest_path
        });

        assert.equal(restored.status, 'RESTORED', restored.violations.join('\n'));
        assert.equal(fs.readFileSync(path.join(repoRoot, 'src/app.ts'), 'utf8'), 'export const value = 3;\n');
        assert.equal(fs.readFileSync(path.join(repoRoot, 'src/new.ts'), 'utf8'), 'export const added = true;\n');
        assert.match(runGit(repoRoot, ['diff', '--cached', '--', 'src/app.ts']), /\+export const value = 2;/u);
        assert.match(
            runGit(repoRoot, ['diff', '--', 'src/app.ts']),
            /[-]export const value = 2;[\s\S]*[+]export const value = 3;/u
        );
    });

    it('reports suspended checkout state for captured and idempotently recaptured WIP', (context) => {
        const repoRoot = makeRepo();
        context.after(() => removeTempRoot(repoRoot));
        writeFile(repoRoot, 'src/app.ts', 'export const value = 2;\n');

        const first = capture(repoRoot, ['src/app.ts']);
        const second = capture(repoRoot, ['src/app.ts']);

        assert.equal(first.status, 'CAPTURED', first.violations.join('\n'));
        assert.equal(checkoutState(first), 'suspended');
        assert.equal(second.status, 'ALREADY_CAPTURED', second.violations.join('\n'));
        assert.equal(checkoutState(second), 'suspended');
        assert.equal(second.manifest_path, first.manifest_path);
        assert.equal(fs.readFileSync(path.join(repoRoot, 'src/app.ts'), 'utf8'), 'export const value = 1;\n');
    });

    it('blocks recapture when a retained manifest has indeterminate checkout state', (context) => {
        const repoRoot = makeRepo();
        context.after(() => removeTempRoot(repoRoot));
        writeFile(repoRoot, 'src/app.ts', 'export const value = 2;\n');

        const first = capture(repoRoot, ['src/app.ts']);
        assert.equal(first.status, 'CAPTURED', first.violations.join('\n'));
        assert.ok(first.manifest_path);
        writeFile(repoRoot, 'src/app.ts', 'export const value = 3;\n');

        const second = capture(repoRoot, ['src/app.ts']);

        assert.equal(second.status, 'BLOCKED');
        assert.equal(checkoutState(second), 'indeterminate');
        assert.equal(second.manifest_path, first.manifest_path);
        assert.ok(second.violations.some((violation) => violation.includes('neither verified suspended nor restored')));
        assert.equal(fs.readFileSync(path.join(repoRoot, 'src/app.ts'), 'utf8'), 'export const value = 3;\n');
    });

    it('blocks a stale HEAD identity during retained-state inspection', (context) => {
        const repoRoot = makeRepo();
        context.after(() => removeTempRoot(repoRoot));
        writeFile(repoRoot, 'src/app.ts', 'export const value = 2;\n');
        const first = capture(repoRoot, ['src/app.ts']);
        assert.equal(first.status, 'CAPTURED', first.violations.join('\n'));

        const second = captureWithClosingHeadMismatch(repoRoot, ['src/app.ts']);

        assert.equal(second.headReads, 2);
        assertClosingHeadRecheckAfterWorkspaceInspection(second.inspectionEvents, { expectContentRead: false });
        assertRetainedCaptureBlocked(first, second.result, 'identity changed during inspection');
    });

    it('blocks a stale HEAD identity during restored-state inspection', (context) => {
        const repoRoot = makeRepo();
        context.after(() => removeTempRoot(repoRoot));
        writeFile(repoRoot, 'src/app.ts', 'export const value = 2;\n');
        const first = capture(repoRoot, ['src/app.ts']);
        assert.equal(first.status, 'CAPTURED', first.violations.join('\n'));
        restoreCapturedWip(repoRoot, first);

        const second = captureWithClosingHeadMismatch(repoRoot, ['src/app.ts']);

        assert.equal(second.headReads, 2);
        assertClosingHeadRecheckAfterWorkspaceInspection(second.inspectionEvents, { expectContentRead: true });
        assertRetainedCaptureBlocked(first, second.result, 'identity changed during inspection');
    });

    it('excludes only the canonical legacy task-queue lock owner artifact', (context) => {
        const repoRoot = makeRepo();
        context.after(() => removeTempRoot(repoRoot));
        const lockOwnerPath = path.join(repoRoot, 'TASK.md.garda-status-sync.lock', 'owner.json');
        writeFile(repoRoot, 'src/app.ts', 'export const value = 2;\n');
        writeFile(repoRoot, 'TASK.md.garda-status-sync.lock/owner.json', '{"pid":123}\n');

        const captured = capture(repoRoot, ['src/app.ts']);

        assert.equal(captured.status, 'CAPTURED', captured.violations.join('\n'));
        assert.equal(checkoutState(captured), 'suspended');
        assert.deepEqual(captured.untracked_files, []);
        assert.equal(fs.readFileSync(lockOwnerPath, 'utf8'), '{"pid":123}\n');
    });

    it('blocks foreign files under the legacy task-queue lock directory as visible WIP', (context) => {
        const repoRoot = makeRepo();
        context.after(() => removeTempRoot(repoRoot));
        writeFile(repoRoot, 'src/app.ts', 'export const value = 2;\n');
        const first = capture(repoRoot, ['src/app.ts']);
        assert.equal(first.status, 'CAPTURED', first.violations.join('\n'));
        writeFile(repoRoot, 'TASK.md.garda-status-sync.lock/payload.txt', 'unowned\n');

        const second = capture(repoRoot, ['src/app.ts']);

        assertRetainedCaptureBlocked(first, second, 'visible untracked WIP path set');
        assert.equal(
            fs.readFileSync(path.join(repoRoot, 'TASK.md.garda-status-sync.lock', 'payload.txt'), 'utf8'),
            'unowned\n'
        );
    });

    it('rejects restored WIP with the captured content in a different staging mode', (context) => {
        const repoRoot = makeRepo();
        context.after(() => removeTempRoot(repoRoot));
        writeFile(repoRoot, 'src/app.ts', 'export const value = 2;\n');
        runGit(repoRoot, ['add', 'src/app.ts']);
        const first = capture(repoRoot, ['src/app.ts']);
        assert.equal(first.status, 'CAPTURED', first.violations.join('\n'));
        restoreCapturedWip(repoRoot, first);
        runGit(repoRoot, ['reset', 'HEAD', '--', 'src/app.ts']);

        const second = capture(repoRoot, ['src/app.ts']);

        assertRetainedCaptureBlocked(first, second, 'staged WIP path set');
    });

    it('rejects restored WIP with a mismatched tracked path set', (context) => {
        const repoRoot = makeRepo();
        context.after(() => removeTempRoot(repoRoot));
        writeFile(repoRoot, 'src/app.ts', 'export const value = 2;\n');
        const changedFiles = ['README.md', 'src/app.ts'];
        const first = capture(repoRoot, changedFiles);
        assert.equal(first.status, 'CAPTURED', first.violations.join('\n'));
        restoreCapturedWip(repoRoot, first);
        writeFile(repoRoot, 'README.md', '# Unexpected tracked WIP\n');

        const second = capture(repoRoot, changedFiles);

        assertRetainedCaptureBlocked(first, second, 'tracked WIP path set');
    });

    it('rejects a retained suspended checkout with an unexpected untracked path', (context) => {
        const repoRoot = makeRepo();
        context.after(() => removeTempRoot(repoRoot));
        writeFile(repoRoot, 'src/app.ts', 'export const value = 2;\n');
        const changedFiles = ['src/app.ts', 'src/unexpected.ts'];
        const first = capture(repoRoot, changedFiles);
        assert.equal(first.status, 'CAPTURED', first.violations.join('\n'));
        writeFile(repoRoot, 'src/unexpected.ts', 'export const unexpected = true;\n');

        const second = capture(repoRoot, changedFiles);

        assertRetainedCaptureBlocked(first, second, 'visible untracked WIP path set');
    });

    it('rejects restored WIP with changed untracked content', (context) => {
        const repoRoot = makeRepo();
        context.after(() => removeTempRoot(repoRoot));
        writeFile(repoRoot, 'src/new.ts', 'export const added = true;\n');
        const first = capture(repoRoot, ['src/new.ts']);
        assert.equal(first.status, 'CAPTURED', first.violations.join('\n'));
        restoreCapturedWip(repoRoot, first);
        writeFile(repoRoot, 'src/new.ts', 'export const added = false;\n');

        const second = capture(repoRoot, ['src/new.ts']);

        assertRetainedCaptureBlocked(first, second, 'restored untracked WIP content changed');
    });

    it('reports restored checkout state when rollback succeeds but capture cleanup fails', (context) => {
        const repoRoot = makeRepo();
        context.after(() => removeTempRoot(repoRoot));
        writeFile(repoRoot, 'src/app.ts', 'export const value = 2;\n');
        writeFile(repoRoot, 'src/new.ts', 'export const added = true;\n');

        const fsModule = require('node:fs') as typeof import('node:fs');
        const originalRenameSync = fsModule.renameSync;
        const originalRmSync = fsModule.rmSync;
        const untrackedPath = path.join(repoRoot, 'src', 'new.ts');
        let suspensionFailureInjected = false;
        let cleanupFailureInjected = false;
        fsModule.renameSync = ((oldPath: fs.PathLike, newPath: fs.PathLike) => {
            if (path.resolve(String(oldPath)) === untrackedPath) {
                suspensionFailureInjected = true;
                throw new Error('injected untracked suspension failure');
            }
            return Reflect.apply(originalRenameSync, fsModule, [oldPath, newPath]);
        }) as typeof fsModule.renameSync;
        fsModule.rmSync = ((targetPath: fs.PathLike, options?: fs.RmDirOptions) => {
            const normalizedPath = path.resolve(String(targetPath));
            if (normalizedPath.includes(`${path.sep}runtime${path.sep}wip${path.sep}${TASK_ID}${path.sep}split-required${path.sep}`)) {
                cleanupFailureInjected = true;
                throw new Error('injected capture cleanup failure');
            }
            return Reflect.apply(originalRmSync, fsModule, [targetPath, options]);
        }) as typeof fsModule.rmSync;
        let captured: ReturnType<typeof capture> | null = null;
        try {
            captured = capture(repoRoot, ['src/app.ts', 'src/new.ts']);
        } finally {
            fsModule.renameSync = originalRenameSync;
            fsModule.rmSync = originalRmSync;
        }

        assert.equal(suspensionFailureInjected, true);
        assert.equal(cleanupFailureInjected, true);
        assert.equal(captured?.status, 'BLOCKED');
        assert.equal(captured ? checkoutState(captured) : undefined, 'restored');
        assert.ok(captured?.manifest_path);
        assert.equal(fs.existsSync(captured!.manifest_path!), true);
        assert.ok(captured?.violations.some((violation) => violation.includes('capture cleanup failed')));
        assert.equal(fs.readFileSync(path.join(repoRoot, 'src/app.ts'), 'utf8'), 'export const value = 2;\n');
        assert.equal(fs.readFileSync(untrackedPath, 'utf8'), 'export const added = true;\n');
    });

    it('reports indeterminate checkout state when rollback failure leaves partial WIP', (context) => {
        const repoRoot = makeRepo();
        context.after(() => removeTempRoot(repoRoot));
        writeFile(repoRoot, 'src/app.ts', 'export const value = 2;\n');
        writeFile(repoRoot, 'src/new.ts', 'export const added = true;\n');

        const fsModule = require('node:fs') as typeof import('node:fs');
        const originalUnlinkSync = fsModule.unlinkSync;
        const originalWriteFileSync = fsModule.writeFileSync;
        const untrackedPath = path.join(repoRoot, 'src', 'new.ts');
        let suspensionFailureInjected = false;
        let rollbackFailureInjected = false;
        fsModule.unlinkSync = ((targetPath: fs.PathLike) => {
            const normalizedPath = path.resolve(String(targetPath));
            if (normalizedPath.includes(`${path.sep}suspended-untracked${path.sep}`)) {
                suspensionFailureInjected = true;
                throw new Error('injected suspended snapshot cleanup failure');
            }
            return Reflect.apply(originalUnlinkSync, fsModule, [targetPath]);
        }) as typeof fsModule.unlinkSync;
        fsModule.writeFileSync = ((filePath: fs.PathOrFileDescriptor, data: string | NodeJS.ArrayBufferView, options?: fs.WriteFileOptions) => {
            if (typeof filePath !== 'number' && path.resolve(String(filePath)) === untrackedPath) {
                rollbackFailureInjected = true;
                throw new Error('injected untracked rollback failure');
            }
            return Reflect.apply(originalWriteFileSync, fsModule, [filePath, data, options]);
        }) as typeof fsModule.writeFileSync;
        let captured: ReturnType<typeof capture> | null = null;
        try {
            captured = capture(repoRoot, ['src/app.ts', 'src/new.ts']);
        } finally {
            fsModule.unlinkSync = originalUnlinkSync;
            fsModule.writeFileSync = originalWriteFileSync;
        }

        assert.equal(suspensionFailureInjected, true);
        assert.equal(rollbackFailureInjected, true);
        assert.equal(captured?.status, 'BLOCKED');
        assert.equal(captured ? checkoutState(captured) : undefined, 'indeterminate');
        assert.ok(captured?.manifest_path);
        assert.ok(captured?.violations.some((violation) => violation.includes('failed to restore untracked WIP')));
        assert.equal(fs.readFileSync(path.join(repoRoot, 'src/app.ts'), 'utf8'), 'export const value = 2;\n');
        assert.equal(fs.existsSync(untrackedPath), false);
    });

    it('reports suspended checkout state when rollback failure leaves the captured checkout suspended', (context) => {
        const repoRoot = makeRepo();
        context.after(() => removeTempRoot(repoRoot));
        writeFile(repoRoot, 'src/app.ts', 'export const value = 2;\n');

        const fsModule = require('node:fs') as typeof import('node:fs');
        const childProcessModule = require('node:child_process') as typeof import('node:child_process');
        const originalMkdirSync = fsModule.mkdirSync;
        const originalExecFileSync = childProcessModule.execFileSync;
        let transactionFailureInjected = false;
        let rollbackFailureInjected = false;
        fsModule.mkdirSync = ((directoryPath: fs.PathLike, options?: fs.MakeDirectoryOptions) => {
            const normalizedPath = path.resolve(String(directoryPath));
            if (normalizedPath.endsWith(`${path.sep}garda-agent-orchestrator${path.sep}runtime${path.sep}task-events`)) {
                transactionFailureInjected = true;
                throw new Error('injected captured-event append failure');
            }
            return Reflect.apply(originalMkdirSync, fsModule, [directoryPath, options]);
        }) as typeof fsModule.mkdirSync;
        childProcessModule.execFileSync = ((
            file: string,
            args?: readonly string[],
            options?: childProcess.ExecFileSyncOptions
        ) => {
            const commandArgs = Array.isArray(args) ? args.map(String) : [];
            if (transactionFailureInjected && file === 'git' && commandArgs.includes('apply')) {
                rollbackFailureInjected = true;
                throw new Error('injected tracked rollback failure');
            }
            return Reflect.apply(originalExecFileSync, childProcessModule, [file, args, options]);
        }) as typeof childProcessModule.execFileSync;
        let captured: ReturnType<typeof capture> | null = null;
        try {
            captured = capture(repoRoot, ['src/app.ts']);
        } finally {
            fsModule.mkdirSync = originalMkdirSync;
            childProcessModule.execFileSync = originalExecFileSync;
        }

        assert.equal(transactionFailureInjected, true);
        assert.equal(rollbackFailureInjected, true);
        assert.equal(captured?.status, 'BLOCKED');
        assert.equal(captured ? checkoutState(captured) : undefined, 'suspended');
        assert.ok(captured?.manifest_path);
        assert.ok(captured?.violations.some((violation) => violation.includes('failed to restore tracked WIP')));
        assert.equal(fs.readFileSync(path.join(repoRoot, 'src/app.ts'), 'utf8'), 'export const value = 1;\n');
    });

    it('reports indeterminate checkout state when concurrent HEAD change causes rollback failure', (context) => {
        const repoRoot = makeRepo();
        context.after(() => removeTempRoot(repoRoot));
        writeFile(repoRoot, 'src/app.ts', 'export const value = 2;\n');

        const fsModule = require('node:fs') as typeof import('node:fs');
        const originalMkdirSync = fsModule.mkdirSync;
        let headChangeInjected = false;
        fsModule.mkdirSync = ((directoryPath: fs.PathLike, options?: fs.MakeDirectoryOptions) => {
            const normalizedPath = path.resolve(String(directoryPath));
            if (normalizedPath.endsWith(`${path.sep}garda-agent-orchestrator${path.sep}runtime${path.sep}task-events`)) {
                runGit(repoRoot, ['commit', '--allow-empty', '--no-verify', '-m', 'concurrent head move after suspension']);
                headChangeInjected = true;
                throw new Error('injected captured-event append failure');
            }
            return Reflect.apply(originalMkdirSync, fsModule, [directoryPath, options]);
        }) as typeof fsModule.mkdirSync;
        let captured: ReturnType<typeof capture> | null = null;
        try {
            captured = capture(repoRoot, ['src/app.ts']);
        } finally {
            fsModule.mkdirSync = originalMkdirSync;
        }

        assert.equal(headChangeInjected, true);
        assert.equal(captured?.status, 'BLOCKED');
        assert.equal(captured ? checkoutState(captured) : undefined, 'indeterminate');
        assert.ok(captured?.manifest_path);
        assert.ok(captured?.violations.some((violation) => violation.includes('checkout state identity mismatch')));
        assert.equal(fs.readFileSync(path.join(repoRoot, 'src/app.ts'), 'utf8'), 'export const value = 1;\n');
    });

    it('returns indeterminate checkout state when rollback-state inspection fails', (context) => {
        const repoRoot = makeRepo();
        context.after(() => removeTempRoot(repoRoot));
        writeFile(repoRoot, 'src/app.ts', 'export const value = 2;\n');

        const fsModule = require('node:fs') as typeof import('node:fs');
        const childProcessModule = require('node:child_process') as typeof import('node:child_process');
        const originalMkdirSync = fsModule.mkdirSync;
        const originalExecFileSync = childProcessModule.execFileSync;
        let transactionFailureInjected = false;
        let rollbackFailureInjected = false;
        let inspectionFailureInjected = false;
        fsModule.mkdirSync = ((directoryPath: fs.PathLike, options?: fs.MakeDirectoryOptions) => {
            const normalizedPath = path.resolve(String(directoryPath));
            if (normalizedPath.endsWith(`${path.sep}garda-agent-orchestrator${path.sep}runtime${path.sep}task-events`)) {
                transactionFailureInjected = true;
                throw new Error('injected captured-event append failure');
            }
            return Reflect.apply(originalMkdirSync, fsModule, [directoryPath, options]);
        }) as typeof fsModule.mkdirSync;
        childProcessModule.execFileSync = ((
            file: string,
            args?: readonly string[],
            options?: childProcess.ExecFileSyncOptions
        ) => {
            const commandArgs = Array.isArray(args) ? args.map(String) : [];
            if (rollbackFailureInjected && file === 'git' && commandArgs.includes('rev-parse')) {
                inspectionFailureInjected = true;
                throw new Error('injected checkout-state inspection failure');
            }
            if (transactionFailureInjected && file === 'git' && commandArgs.includes('apply')) {
                rollbackFailureInjected = true;
                throw new Error('injected tracked rollback failure');
            }
            return Reflect.apply(originalExecFileSync, childProcessModule, [file, args, options]);
        }) as typeof childProcessModule.execFileSync;
        let captured: ReturnType<typeof capture> | null = null;
        try {
            captured = capture(repoRoot, ['src/app.ts']);
        } finally {
            fsModule.mkdirSync = originalMkdirSync;
            childProcessModule.execFileSync = originalExecFileSync;
        }

        assert.equal(transactionFailureInjected, true);
        assert.equal(rollbackFailureInjected, true);
        assert.equal(inspectionFailureInjected, true);
        assert.equal(captured?.status, 'BLOCKED');
        assert.equal(captured ? checkoutState(captured) : undefined, 'indeterminate');
        assert.ok(captured?.manifest_path);
        assert.ok(captured?.violations.some((violation) => violation.includes('checkout state inspection failed')));
        assert.equal(fs.readFileSync(path.join(repoRoot, 'src/app.ts'), 'utf8'), 'export const value = 1;\n');
    });

    it('contains post-rollback verification failure and reports indeterminate checkout state', (context) => {
        const repoRoot = makeRepo();
        context.after(() => removeTempRoot(repoRoot));
        writeFile(repoRoot, 'src/app.ts', 'export const value = 2;\n');

        const fsModule = require('node:fs') as typeof import('node:fs');
        const childProcessModule = require('node:child_process') as typeof import('node:child_process');
        const originalMkdirSync = fsModule.mkdirSync;
        const originalExecFileSync = childProcessModule.execFileSync;
        let transactionFailureInjected = false;
        let verificationFailureInjected = false;
        fsModule.mkdirSync = ((directoryPath: fs.PathLike, options?: fs.MakeDirectoryOptions) => {
            const normalizedPath = path.resolve(String(directoryPath));
            if (normalizedPath.endsWith(`${path.sep}garda-agent-orchestrator${path.sep}runtime${path.sep}task-events`)) {
                transactionFailureInjected = true;
                throw new Error('injected captured-event append failure');
            }
            return Reflect.apply(originalMkdirSync, fsModule, [directoryPath, options]);
        }) as typeof fsModule.mkdirSync;
        childProcessModule.execFileSync = ((
            file: string,
            args?: readonly string[],
            options?: childProcess.ExecFileSyncOptions
        ) => {
            const commandArgs = Array.isArray(args) ? args.map(String) : [];
            if (transactionFailureInjected
                && file === 'git'
                && commandArgs.includes('diff')
                && commandArgs.includes('--name-only')) {
                verificationFailureInjected = true;
                throw new Error('injected post-rollback verification failure');
            }
            return Reflect.apply(originalExecFileSync, childProcessModule, [file, args, options]);
        }) as typeof childProcessModule.execFileSync;
        let captured: ReturnType<typeof capture> | null = null;
        try {
            captured = capture(repoRoot, ['src/app.ts']);
        } finally {
            fsModule.mkdirSync = originalMkdirSync;
            childProcessModule.execFileSync = originalExecFileSync;
        }

        assert.equal(transactionFailureInjected, true);
        assert.equal(verificationFailureInjected, true);
        assert.equal(captured?.status, 'BLOCKED');
        assert.equal(captured ? checkoutState(captured) : undefined, 'indeterminate');
        assert.ok(captured?.manifest_path);
        assert.ok(captured?.violations.some((violation) => violation.includes('failed to verify restored WIP')));
        assert.ok(captured?.violations.some((violation) => violation.includes('checkout state inspection failed')));
        assert.equal(fs.readFileSync(path.join(repoRoot, 'src/app.ts'), 'utf8'), 'export const value = 2;\n');
    });

    it('recaptures restored WIP instead of reusing a manifest whose files are present', (context) => {
        const repoRoot = makeRepo();
        context.after(() => removeTempRoot(repoRoot));
        writeFile(repoRoot, 'src/app.ts', 'export const value = 2;\n');
        writeFile(repoRoot, 'src/new.ts', 'export const added = true;\n');

        const first = capture(repoRoot, ['src/app.ts', 'src/new.ts']);
        assert.equal(first.status, 'CAPTURED', first.violations.join('\n'));
        assert.ok(first.manifest_path);
        const restored = restoreSplitRequiredWip({
            repoRoot,
            taskId: TASK_ID,
            manifestPath: first.manifest_path
        });
        assert.equal(restored.status, 'RESTORED', restored.violations.join('\n'));
        assert.equal(fs.readFileSync(path.join(repoRoot, 'src/app.ts'), 'utf8'), 'export const value = 2;\n');
        assert.equal(fs.readFileSync(path.join(repoRoot, 'src/new.ts'), 'utf8'), 'export const added = true;\n');

        const second = capture(repoRoot, ['src/app.ts', 'src/new.ts']);

        assert.equal(second.status, 'CAPTURED', second.violations.join('\n'));
        assert.ok(second.manifest_path);
        assert.notEqual(second.manifest_path, first.manifest_path);
        assert.deepEqual(second.untracked_files, ['src/new.ts']);
        assert.equal(fs.readFileSync(path.join(repoRoot, 'src/app.ts'), 'utf8'), 'export const value = 1;\n');
        assert.equal(fs.existsSync(path.join(repoRoot, 'src/new.ts')), false);
    });

    it('does not reuse a capture when a dangling symlink is reported at an untracked path', (context) => {
        const repoRoot = makeRepo();
        context.after(() => removeTempRoot(repoRoot));
        writeFile(repoRoot, 'src/new.ts', 'export const added = true;\n');
        const first = capture(repoRoot, ['src/new.ts']);
        assert.equal(first.status, 'CAPTURED', first.violations.join('\n'));
        assert.ok(first.manifest_path);

        const linkPath = path.join(repoRoot, 'src', 'new.ts');
        writeFile(repoRoot, 'src/new.ts', 'dangling symlink placeholder\n');
        const fsModule = require('node:fs') as typeof import('node:fs');
        const mutableFsModule = fsModule as { lstatSync: typeof fs.lstatSync };
        const originalLstatSync = fsModule.lstatSync;
        mutableFsModule.lstatSync = ((targetPath: fs.PathLike) => {
            const stats = Reflect.apply(originalLstatSync, fsModule, [targetPath]) as fs.Stats;
            if (path.resolve(String(targetPath)) !== linkPath) {
                return stats;
            }
            return new Proxy(stats, {
                get(target, property, receiver) {
                    if (property === 'isSymbolicLink') {
                        return () => true;
                    }
                    return Reflect.get(target, property, receiver);
                }
            });
        }) as typeof fsModule.lstatSync;
        let second: ReturnType<typeof capture> | null = null;
        try {
            second = capture(repoRoot, ['src/new.ts']);
        } finally {
            mutableFsModule.lstatSync = originalLstatSync;
        }

        assert.ok(second);
        assertRetainedCaptureBlocked(first, second, 'checkout state inspection failed');
    });

    it('blocks a preflight without task identity before workspace mutation', (context) => {
        const repoRoot = makeRepo();
        context.after(() => removeTempRoot(repoRoot));
        writeFile(repoRoot, 'src/app.ts', 'export const value = 2;\n');
        const preflightPath = writePreflight(repoRoot, ['src/app.ts']);
        const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
        delete preflight.task_id;
        fs.writeFileSync(preflightPath, `${JSON.stringify(preflight, null, 2)}\n`, 'utf8');

        const captured = captureAndSuspendSplitRequiredWip({
            repoRoot,
            taskId: TASK_ID,
            preflightPath,
            guardKind: 'scope_budget',
            guardReason: 'capture boundary test'
        });

        assert.equal(captured.status, 'BLOCKED');
        assert.ok(captured.violations.some(
            (violation) => violation.includes('Preflight task_id must be a non-empty string')
        ));
        assert.equal(fs.readFileSync(path.join(repoRoot, 'src/app.ts'), 'utf8'), 'export const value = 2;\n');
        assert.deepEqual(captureDirectories(repoRoot), []);
    });

    it('blocks tracked changes outside the authorized preflight scope without mutation', (context) => {
        const repoRoot = makeRepo();
        context.after(() => removeTempRoot(repoRoot));
        writeFile(repoRoot, 'src/app.ts', 'export const value = 2;\n');
        writeFile(repoRoot, 'README.md', '# Out of scope\n');

        const captured = capture(repoRoot, ['src/app.ts']);

        assert.equal(captured.status, 'BLOCKED');
        assert.ok(captured.violations.some(
            (violation) => violation.includes('tracked changes outside current preflight scope: README.md')
        ));
        assert.equal(fs.readFileSync(path.join(repoRoot, 'src/app.ts'), 'utf8'), 'export const value = 2;\n');
        assert.equal(fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf8'), '# Out of scope\n');
        assert.deepEqual(captureDirectories(repoRoot), []);
    });

    it('rejects capture storage redirected through a symlink or junction', (context) => {
        const repoRoot = makeRepo();
        const externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-split-capture-external-'));
        context.after(() => removeTempRoot(repoRoot));
        context.after(() => removeTempRoot(externalRoot));
        writeFile(repoRoot, 'src/app.ts', 'export const value = 2;\n');
        const runtimeRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime');
        const wipRoot = path.join(runtimeRoot, 'wip');
        fs.mkdirSync(runtimeRoot, { recursive: true });
        fs.symlinkSync(externalRoot, wipRoot, process.platform === 'win32' ? 'junction' : 'dir');

        const captured = capture(repoRoot, ['src/app.ts']);

        assert.equal(captured.status, 'BLOCKED');
        assert.ok(captured.violations.some(
            (violation) => violation.includes('symbolic link, junction, or non-directory')
        ));
        assert.equal(fs.readFileSync(path.join(repoRoot, 'src/app.ts'), 'utf8'), 'export const value = 2;\n');
        assert.deepEqual(fs.readdirSync(externalRoot), []);
    });

    it('rejects tracked WIP reached through a linked source ancestor', (context) => {
        const repoRoot = makeRepo();
        const externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-split-source-external-'));
        context.after(() => removeTempRoot(repoRoot));
        context.after(() => removeTempRoot(externalRoot));
        writeFile(repoRoot, 'src/app.ts', 'export const value = 2;\n');
        writeFile(externalRoot, 'app.ts', 'export const value = 2;\n');

        const fsModule = require('node:fs') as typeof import('node:fs');
        const originalMkdirSync = fsModule.mkdirSync;
        let injected = false;
        fsModule.mkdirSync = ((directoryPath: fs.PathLike, options?: fs.MakeDirectoryOptions) => {
            const result = Reflect.apply(originalMkdirSync, fsModule, [directoryPath, options]);
            const normalizedPath = path.resolve(String(directoryPath));
            if (!injected
                && path.basename(path.dirname(normalizedPath)) === 'split-required'
                && normalizedPath.includes(`${path.sep}runtime${path.sep}wip${path.sep}${TASK_ID}${path.sep}`)) {
                fs.rmSync(path.join(repoRoot, 'src'), { recursive: true, force: true });
                fs.symlinkSync(
                    externalRoot,
                    path.join(repoRoot, 'src'),
                    process.platform === 'win32' ? 'junction' : 'dir'
                );
                injected = true;
            }
            return result;
        }) as typeof fsModule.mkdirSync;
        let captured: ReturnType<typeof capture> | null = null;
        try {
            captured = capture(repoRoot, ['src/app.ts']);
        } finally {
            fsModule.mkdirSync = originalMkdirSync;
        }

        assert.equal(injected, true);
        assert.equal(captured?.status, 'BLOCKED');
        assert.ok(captured?.violations.some(
            (violation) => violation.includes('tracked capture source path ancestry contains a symbolic link')
        ));
        assert.equal(fs.readFileSync(path.join(externalRoot, 'app.ts'), 'utf8'), 'export const value = 2;\n');
        assert.equal(fs.lstatSync(path.join(repoRoot, 'src')).isSymbolicLink(), true);
    });

    it('captures task-owned ignored temp WIP and excludes ignored runtime artifacts', (context) => {
        const repoRoot = makeRepo();
        context.after(() => removeTempRoot(repoRoot));
        const scopedPath = 'src/scoped.ts';
        const taskOwnedPath = `garda-agent-orchestrator/runtime/tmp/${TASK_ID}/notes.json`;
        const runtimeArtifactPath = `garda-agent-orchestrator/runtime/reviews/${TASK_ID}-review.json`;
        writeFile(repoRoot, scopedPath, 'export const scoped = true;\n');
        writeFile(repoRoot, taskOwnedPath, '{\"taskOwned\":true}\n');
        writeFile(repoRoot, runtimeArtifactPath, '{\"review\":true}\n');

        const captured = capture(repoRoot, [scopedPath, runtimeArtifactPath]);

        assert.equal(captured.status, 'CAPTURED', captured.violations.join('\n'));
        assert.ok(captured.manifest_path);
        assert.deepEqual(captured.untracked_files, [taskOwnedPath, scopedPath].sort());
        assert.equal(fs.existsSync(path.join(repoRoot, scopedPath)), false);
        assert.equal(fs.existsSync(path.join(repoRoot, taskOwnedPath)), false);
        assert.equal(fs.existsSync(path.join(repoRoot, runtimeArtifactPath)), true);
        const manifest = JSON.parse(fs.readFileSync(captured.manifest_path, 'utf8')) as {
            ignored_runtime_artifacts: string[];
        };
        assert.deepEqual(manifest.ignored_runtime_artifacts, [runtimeArtifactPath]);

        const restored = restoreSplitRequiredWip({
            repoRoot,
            taskId: TASK_ID,
            manifestPath: captured.manifest_path
        });

        assert.equal(restored.status, 'RESTORED', restored.violations.join('\n'));
        assert.equal(fs.readFileSync(path.join(repoRoot, scopedPath), 'utf8'), 'export const scoped = true;\n');
        assert.equal(fs.readFileSync(path.join(repoRoot, taskOwnedPath), 'utf8'), '{\"taskOwned\":true}\n');
        assert.equal(fs.readFileSync(path.join(repoRoot, runtimeArtifactPath), 'utf8'), '{\"review\":true}\n');
    });

    it('blocks suspension when HEAD changes after immutable capture preparation', (context) => {
        const repoRoot = makeRepo();
        context.after(() => removeTempRoot(repoRoot));
        writeFile(repoRoot, 'src/app.ts', 'export const value = 2;\n');

        const fsModule = require('node:fs') as typeof import('node:fs');
        const originalReadFileSync = fsModule.readFileSync;
        let manifestReads = 0;
        let injected = false;
        fsModule.readFileSync = ((...args: unknown[]) => {
            const normalizedPath = typeof args[0] === 'number' ? '' : path.resolve(String(args[0]));
            if (path.basename(normalizedPath) === 'manifest.json'
                && normalizedPath.includes(`${path.sep}runtime${path.sep}wip${path.sep}${TASK_ID}${path.sep}`)) {
                manifestReads += 1;
                if (manifestReads === 2) {
                    runGit(repoRoot, ['commit', '--allow-empty', '--no-verify', '-m', 'concurrent head move']);
                    injected = true;
                }
            }
            return Reflect.apply(originalReadFileSync, fsModule, args) as unknown;
        }) as typeof fsModule.readFileSync;
        let captured: ReturnType<typeof capture> | null = null;
        try {
            captured = capture(repoRoot, ['src/app.ts']);
        } finally {
            fsModule.readFileSync = originalReadFileSync;
        }

        assert.equal(injected, true);
        assert.equal(captured?.status, 'BLOCKED');
        assert.ok(captured?.violations.some(
            (violation) => violation.includes('repository HEAD changed during split-required WIP capture')
        ));
        assert.equal(fs.readFileSync(path.join(repoRoot, 'src/app.ts'), 'utf8'), 'export const value = 2;\n');
        assert.deepEqual(captureDirectories(repoRoot), []);
    });

    it('blocks suspension when an untracked source is replaced with equal content', (context) => {
        const repoRoot = makeRepo();
        context.after(() => removeTempRoot(repoRoot));
        const relativePath = 'src/replaced.ts';
        const sourcePath = path.join(repoRoot, relativePath);
        writeFile(repoRoot, relativePath, 'export const replaced = true;\n');

        const fsModule = require('node:fs') as typeof import('node:fs');
        const originalReadFileSync = fsModule.readFileSync;
        const originalUnlinkSync = fsModule.unlinkSync;
        const originalWriteFileSync = fsModule.writeFileSync;
        let artifactReads = 0;
        let injected = false;
        fsModule.readFileSync = ((...args: unknown[]) => {
            const normalizedPath = typeof args[0] === 'number' ? '' : path.resolve(String(args[0]));
            if (normalizedPath.includes(`${path.sep}runtime${path.sep}wip${path.sep}${TASK_ID}${path.sep}`)
                && normalizedPath.endsWith(`${path.sep}untracked${path.sep}src${path.sep}replaced.ts`)) {
                artifactReads += 1;
                if (artifactReads === 2) {
                    originalUnlinkSync(sourcePath);
                    originalWriteFileSync(sourcePath, 'export const replaced = true;\n', 'utf8');
                    injected = true;
                }
            }
            return Reflect.apply(originalReadFileSync, fsModule, args) as unknown;
        }) as typeof fsModule.readFileSync;
        let captured: ReturnType<typeof capture> | null = null;
        try {
            captured = capture(repoRoot, [relativePath]);
        } finally {
            fsModule.readFileSync = originalReadFileSync;
        }

        assert.equal(injected, true);
        assert.equal(captured?.status, 'BLOCKED');
        assert.ok(captured?.violations.some(
            (violation) => violation.includes('source identity changed after capture')
        ));
        assert.equal(fs.readFileSync(sourcePath, 'utf8'), 'export const replaced = true;\n');
        assert.deepEqual(captureDirectories(repoRoot), []);
    });

    it('removes an incomplete capture when immutable manifest creation fails', (context) => {
        const repoRoot = makeRepo();
        context.after(() => removeTempRoot(repoRoot));
        writeFile(repoRoot, 'src/app.ts', 'export const value = 2;\n');

        const fsModule = require('node:fs') as typeof import('node:fs');
        const originalWriteFileSync = fsModule.writeFileSync;
        let injected = false;
        fsModule.writeFileSync = ((
            filePath: fs.PathOrFileDescriptor,
            data: string | NodeJS.ArrayBufferView,
            options?: fs.WriteFileOptions
        ) => {
            const normalizedPath = typeof filePath === 'number'
                ? ''
                : path.resolve(String(filePath));
            if (!injected
                && path.basename(normalizedPath) === 'manifest.json'
                && normalizedPath.includes(`${path.sep}runtime${path.sep}wip${path.sep}${TASK_ID}${path.sep}`)) {
                injected = true;
                throw new Error('injected immutable manifest write failure');
            }
            return Reflect.apply(originalWriteFileSync, fsModule, [filePath, data, options]);
        }) as typeof fsModule.writeFileSync;
        let captured: ReturnType<typeof capture> | null = null;
        try {
            captured = capture(repoRoot, ['src/app.ts']);
        } finally {
            fsModule.writeFileSync = originalWriteFileSync;
        }

        assert.equal(injected, true);
        assert.equal(captured?.status, 'BLOCKED');
        assert.ok(captured?.violations.some(
            (violation) => violation.includes('injected immutable manifest write failure')
        ));
        assert.equal(fs.readFileSync(path.join(repoRoot, 'src/app.ts'), 'utf8'), 'export const value = 2;\n');
        assert.deepEqual(captureDirectories(repoRoot), []);
    });

    it('restores staged and unstaged WIP when tracked suspension fails after reset', (context) => {
        const repoRoot = makeRepo();
        context.after(() => removeTempRoot(repoRoot));
        writeFile(repoRoot, 'src/app.ts', 'export const value = 2;\n');
        runGit(repoRoot, ['add', 'src/app.ts']);
        writeFile(repoRoot, 'src/app.ts', 'export const value = 3;\n');

        const childProcessModule = require('node:child_process') as typeof import('node:child_process');
        const originalExecFileSync = childProcessModule.execFileSync;
        let injected = false;
        childProcessModule.execFileSync = ((
            file: string,
            args?: readonly string[],
            options?: childProcess.ExecFileSyncOptions
        ) => {
            const commandArgs = Array.isArray(args) ? args.map(String) : [];
            if (!injected
                && file === 'git'
                && commandArgs.includes('checkout')
                && commandArgs.includes('src/app.ts')) {
                injected = true;
                throw new Error('injected split capture checkout failure');
            }
            return Reflect.apply(originalExecFileSync, childProcessModule, [file, args, options]);
        }) as typeof childProcessModule.execFileSync;
        let captured: ReturnType<typeof capture> | null = null;
        try {
            captured = capture(repoRoot, ['src/app.ts']);
        } finally {
            childProcessModule.execFileSync = originalExecFileSync;
        }

        assert.equal(injected, true);
        assert.equal(captured?.status, 'BLOCKED');
        assert.ok(captured?.violations.some(
            (violation) => violation.includes('split capture checkout failure')
        ));
        assert.equal(fs.readFileSync(path.join(repoRoot, 'src/app.ts'), 'utf8'), 'export const value = 3;\n');
        assert.match(runGit(repoRoot, ['diff', '--cached', '--', 'src/app.ts']), /\+export const value = 2;/u);
        assert.match(
            runGit(repoRoot, ['diff', '--', 'src/app.ts']),
            /[-]export const value = 2;[\s\S]*[+]export const value = 3;/u
        );
        assert.deepEqual(captureDirectories(repoRoot), []);
    });

    it('restores already removed untracked WIP when a later removal fails', (context) => {
        const repoRoot = makeRepo();
        context.after(() => removeTempRoot(repoRoot));
        writeFile(repoRoot, 'src/a-helper.ts', 'export const first = true;\n');
        writeFile(repoRoot, 'src/b-helper.ts', 'export const second = true;\n');
        const fsModule = require('node:fs') as typeof import('node:fs');
        const originalUnlinkSync = fsModule.unlinkSync;
        let injected = false;
        fsModule.unlinkSync = ((filePath: fs.PathLike) => {
            const normalizedPath = path.resolve(String(filePath));
            if (!injected
                && normalizedPath.endsWith(
                    `${path.sep}suspended-untracked${path.sep}src${path.sep}b-helper.ts`
                )) {
                injected = true;
                throw new Error('injected second split capture removal failure');
            }
            return originalUnlinkSync(filePath);
        }) as typeof fsModule.unlinkSync;
        let captured: ReturnType<typeof capture> | null = null;
        try {
            captured = capture(repoRoot, ['src/a-helper.ts', 'src/b-helper.ts']);
        } finally {
            fsModule.unlinkSync = originalUnlinkSync;
        }

        assert.equal(injected, true);
        assert.equal(captured?.status, 'BLOCKED');
        assert.ok(captured?.violations.some(
            (violation) => violation.includes('second split capture removal failure')
        ));
        assert.equal(
            fs.readFileSync(path.join(repoRoot, 'src', 'a-helper.ts'), 'utf8'),
            'export const first = true;\n'
        );
        assert.equal(
            fs.readFileSync(path.join(repoRoot, 'src', 'b-helper.ts'), 'utf8'),
            'export const second = true;\n'
        );
        assert.deepEqual(captureDirectories(repoRoot), []);
    });
});
