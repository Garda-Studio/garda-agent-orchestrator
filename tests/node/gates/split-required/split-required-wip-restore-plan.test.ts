import assert from 'node:assert/strict';
import * as childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import mutableFs from 'node:fs';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';

import {
    captureAndSuspendSplitRequiredWip,
    restoreSplitRequiredWip
} from '../../../../src/gates/split-required/split-required-wip';
import {
    applyAdvancedRestorePlan,
    buildGitApplyIncludeArgs,
    normalizeSelectedPaths,
    planAdvancedRestore,
    readAuthenticatedRepoFileSnapshot,
    removeRepoFileIfIdentityMatches,
    replaceAuthenticatedRepoFile,
    selectedFiles,
    validateNoSymlinkPath,
    writeExclusiveRepoFile,
    writeExclusiveRepoFileWithRemovalHandle
} from '../../../../src/gates/split-required/split-required-wip-restore-plan';
import type {
    SplitRequiredWipManifest,
    SplitRequiredWipTrackedFileEvidence,
    SplitRequiredWipUntrackedFileEvidence
} from '../../../../src/gates/split-required/split-required-wip-contracts';
import {
    prepareSplitRequiredWipRestoreHandoff,
    promotePreparedSplitRequiredWipRestoreHandoff,
    readAndVerifySplitRequiredWipRestoreHandoff,
    replaceSplitRequiredWipRestoreHandoff,
    resolveSplitRequiredWipRestoreHandoffIdentity
} from '../../../../src/gates/split-required/split-required-wip-runtime-handoff-contracts';
import {
    restoreSplitRequiredWipForPreparedRuntimeHandoff
} from '../../../../src/gates/split-required/split-required-wip-operations';
import type {
    SplitRequiredWipRestoreHandoff
} from '../../../../src/gates/split-required/split-required-wip-runtime-handoff-contracts';
import { traceGitCommands } from '../git-command-trace';

const TASK_ID = 'T-WIP-RESTORE-PLAN';

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

function sha256(filePath: string): string {
    return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function makeRepo(onCleanup: (callback: () => void) => void): string {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-wip-restore-plan-'));
    onCleanup(() => fs.rmSync(repoRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
    runGit(repoRoot, ['init']);
    runGit(repoRoot, ['config', 'user.email', 'test@example.invalid']);
    runGit(repoRoot, ['config', 'user.name', 'Test User']);
    runGit(repoRoot, ['config', 'core.autocrlf', 'false']);
    runGit(repoRoot, ['config', 'core.eol', 'lf']);
    writeFile(repoRoot, '.gitignore', 'garda-agent-orchestrator/runtime/\n');
    writeFile(repoRoot, 'TASK.md', [
        '# TASK.md',
        '',
        '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
        '|---|---|---|---|---|---|---|---|---|',
        `| ${TASK_ID} | IN_PROGRESS | P1 | workflow | Restore plan | gpt-5.5 | 2026-06-30 | strict | Test. |`,
        ''
    ].join('\n'));
    writeFile(repoRoot, 'src/a.ts', 'export const a = 1;\n');
    writeFile(repoRoot, 'src/b.ts', 'export const b = 1;\n');
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

function makeBackupRestoreFixture(
    onCleanup: (callback: () => void) => void,
    count = 2,
    originalContent = 'authenticated original\n'.repeat(400)
) {
    const repoRoot = makeRepo(onCleanup);
    const candidateWorktreeRoot = path.join(repoRoot, 'garda-agent-orchestrator/runtime/candidate');
    const originalDigest = createHash('sha256').update(originalContent).digest('hex');
    const files: SplitRequiredWipTrackedFileEvidence[] = Array.from({ length: count }, (_, index) => ({
        path: `src/backup-${index}.ts`,
        head_sha256: null,
        worktree_sha256: originalDigest,
        staged: true,
        unstaged: false
    }));
    for (const file of files) {
        writeFile(repoRoot, file.path, originalContent);
        writeFile(candidateWorktreeRoot, file.path, 'restored candidate\n');
    }
    const indexPath = path.join(repoRoot, '.git/index');
    const plan = {
        tempRoot: candidateWorktreeRoot,
        candidateWorktreeRoot,
        candidateIndexPath: path.join(candidateWorktreeRoot, 'missing.index'),
        currentHead: runGit(repoRoot, ['rev-parse', 'HEAD']).trim(),
        currentIndexSha256: sha256(indexPath),
        targetSha256: new Map(files.map(file => [file.path, originalDigest]))
    };
    return { repoRoot, files, plan, originalContent };
}

describe('split-required WIP restore planning', () => {
    for (const fileCount of [64, 96]) it(`bounds retained backup memory for ${fileCount * 4} MiB of preimages and rolls every file back`, (context) => {
        const fixture = makeBackupRestoreFixture(callback => context.after(callback), fileCount, 'x'.repeat(4 * 1024 * 1024));
        const input = JSON.stringify({
            repoRoot: fixture.repoRoot,
            files: fixture.files,
            plan: { ...fixture.plan, targetSha256: [...fixture.plan.targetSha256] }
        });
        const measure = (mode: string) => JSON.parse(childProcess.execFileSync(process.execPath, [
            '--expose-gc', '-e',
            'const worker = require(process.argv[1]); worker.measureBackupStorage(process.argv[2]);',
            require.resolve('./fixtures/backup-storage-measurement'), mode
        ], { input, encoding: 'utf8', timeout: 60_000, maxBuffer: 64 * 1024 }));
        const retained = measure('retained-baseline');
        const spooled = measure('spooled');
        const totalBytes = Buffer.byteLength(fixture.originalContent) * fixture.files.length;
        assert.ok(retained.retainedArrayBufferBytes >= totalBytes);
        // The same absolute ceiling covers both corpus sizes: one 4 MiB preimage plus
        // fixed buffer/runtime headroom. The permitted retention must not scale with totalBytes.
        assert.ok(spooled.retainedArrayBufferBytes <= 8 * 1024 * 1024, JSON.stringify(spooled));
        // Compare isolated processes with generous headroom for runtime and instrumentation overhead.
        // Unlike the fsync checkpoint, the OS high-water mark detects buffers released before sealing.
        assert.ok(spooled.peakRssKiB < retained.peakRssKiB * 0.75, JSON.stringify({ retained, spooled }));
        // Bound the whole process peak independently of corpus size, including transient buffers.
        // This budget includes Node, loaded modules, GC headroom and the active per-file preimage.
        assert.ok(spooled.peakRssKiB < 256 * 1024, JSON.stringify(spooled));
        assert.deepEqual(retained.captureIo, {
            readCalls: fixture.files.length, readBytes: totalBytes, writeCalls: 0, writeBytes: 0
        });
        // Compare capture with capture; spooled rollback reads are counted separately below.
        assert.deepEqual(spooled.captureIo, {
            readCalls: retained.captureIo.readCalls, readBytes: retained.captureIo.readBytes,
            writeCalls: totalBytes / (64 * 1024), writeBytes: totalBytes
        });
        assert.equal(spooled.spoolBytes, totalBytes);
        assert.equal(spooled.spoolWrites, totalBytes / (64 * 1024));
        assert.equal(spooled.spoolReads, 2 * totalBytes / (64 * 1024));
        assert.equal(spooled.spoolClosed, true);
        assert.match(spooled.violations.join('\n'), /failed without retained mutations/u);
        const digest = createHash('sha256').update(fixture.originalContent).digest('hex');
        for (const file of fixture.files) assert.equal(sha256(path.join(fixture.repoRoot, file.path)), digest);
        assert.equal(fs.readdirSync(fixture.repoRoot).some(name => name.startsWith('.garda-restore-backup-')), false);
        context.diagnostic(JSON.stringify({ totalBytes, retained, spooled }));
    });

    it('publishes all candidates and cleans up backup storage after a successful 384 MiB restore', (context) => {
        const fixture = makeBackupRestoreFixture(callback => context.after(callback), 96, 'x'.repeat(4 * 1024 * 1024));
        const indexPath = path.join(fixture.repoRoot, '.git/index');
        fs.copyFileSync(indexPath, fixture.plan.candidateIndexPath);
        const expectedIndexSha256 = sha256(fixture.plan.candidateIndexPath);
        const originalOpen = fs.openSync;
        const originalClose = fs.closeSync;
        let backupDescriptor: number | null = null;
        let backupClosed = false;
        context.mock.method(mutableFs, 'openSync', (...args: Parameters<typeof fs.openSync>) => {
            const descriptor = originalOpen(...args);
            if (String(args[0]).includes('.garda-restore-backup-') && args[1] === fs.constants.O_RDWR) {
                backupDescriptor = descriptor;
            }
            return descriptor;
        });
        context.mock.method(mutableFs, 'closeSync', (descriptor: number) => {
            originalClose(descriptor);
            if (descriptor === backupDescriptor) backupClosed = true;
        });

        assert.deepEqual(applyAdvancedRestorePlan(fixture.repoRoot, fixture.plan, fixture.files, []), []);
        assert.notEqual(backupDescriptor, null);
        assert.equal(backupClosed, true);
        for (const file of fixture.files) {
            assert.equal(fs.readFileSync(path.join(fixture.repoRoot, file.path), 'utf8'), 'restored candidate\n');
        }
        assert.equal(sha256(indexPath), expectedIndexSha256);
        assert.equal(fs.readdirSync(fixture.repoRoot).some(name => name.startsWith('.garda-restore-backup-')), false);
    });

    it('preserves authenticated manifest contents when the exported identity contains forged metadata', (context) => {
        const repoRoot = makeRepo(callback => context.after(callback));
        const filePath = 'src/new-handoff.ts';
        const originalContent = 'authenticated untracked content\n';
        writeFile(repoRoot, filePath, originalContent);
        const captured = captureAndSuspendSplitRequiredWip({
            repoRoot, taskId: TASK_ID,
            preflightPath: writePreflight(repoRoot, [filePath]),
            guardKind: 'scope_budget', guardReason: 'mutable handoff identity regression'
        });
        assert.equal(captured.status, 'CAPTURED', captured.violations.join('\n'));
        assert.ok(captured.manifest_path);
        const identity = resolveSplitRequiredWipRestoreHandoffIdentity({
            repoRoot, taskId: TASK_ID, manifestPath: captured.manifest_path, includePaths: [filePath]
        });
        prepareSplitRequiredWipRestoreHandoff(identity, identity.timelineAnchor);
        const manifestDigest = sha256(captured.manifest_path);
        const forgedArtifactPath = 'garda-agent-orchestrator/runtime/forged-handoff-artifact';
        const forgedContent = 'forged content from mutable identity\n';
        writeFile(repoRoot, forgedArtifactPath, forgedContent);
        Object.assign(identity.manifest.untracked_files[0], {
            artifact_path: path.join(repoRoot, forgedArtifactPath),
            sha256: sha256(path.join(repoRoot, forgedArtifactPath)),
            bytes: Buffer.byteLength(forgedContent)
        });
        const restored = restoreSplitRequiredWipForPreparedRuntimeHandoff(identity);
        assert.equal(restored.status, 'RESTORED', restored.violations.join('\n'));
        assert.equal(fs.readFileSync(path.join(repoRoot, filePath), 'utf8'), originalContent);
        assert.equal(sha256(captured.manifest_path), manifestDigest);
        const pending = promotePreparedSplitRequiredWipRestoreHandoff(identity);
        assert.equal(pending.status, 'pending');
        assert.equal(readAndVerifySplitRequiredWipRestoreHandoff(identity).status, 'pending');
        fs.writeFileSync(path.join(repoRoot, filePath), forgedContent);
        assert.throws(() => readAndVerifySplitRequiredWipRestoreHandoff(identity), /manifest|workspace changed/u);
    });

    it('rejects over-limit artifact declarations in both dry run and restore before reading payloads', (context) => {
        const repoRoot = makeRepo(callback => context.after(callback));
        const changedFiles = Array.from({ length: 5 }, (_, index) => `src/untracked-${index}.ts`);
        for (const file of changedFiles) writeFile(repoRoot, file, 'untracked content\n');
        const captured = captureAndSuspendSplitRequiredWip({
            repoRoot,
            taskId: TASK_ID,
            preflightPath: writePreflight(repoRoot, changedFiles),
            guardKind: 'scope_budget',
            guardReason: 'dry-run aggregate artifact admission parity'
        });
        assert.equal(captured.status, 'CAPTURED', captured.violations.join('\n'));
        assert.ok(captured.manifest_path);
        const manifest = JSON.parse(fs.readFileSync(captured.manifest_path, 'utf8')) as SplitRequiredWipManifest;
        // Keep one real small artifact; declare four 64 MiB artifacts so admission
        // must reject their combined size before trying to authenticate payloads.
        for (const entry of manifest.untracked_files.slice(1)) entry.bytes = 64 * 1024 * 1024;
        fs.writeFileSync(captured.manifest_path, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
        const indexDigest = sha256(path.join(repoRoot, '.git/index'));
        for (const dryRun of [true, false]) {
            const result = restoreSplitRequiredWip({
                repoRoot, taskId: TASK_ID, manifestPath: captured.manifest_path, dryRun
            });
            assert.equal(result.status, 'BLOCKED');
            assert.deepEqual(result.violations, ['selected restore artifacts exceed the 268435456 byte aggregate limit.']);
            assert.deepEqual(result.restored_files, []);
        }
        const selected = restoreSplitRequiredWip({
            repoRoot,
            taskId: TASK_ID,
            manifestPath: captured.manifest_path,
            includePaths: [manifest.untracked_files[0].path],
            dryRun: true
        });
        assert.equal(selected.status, 'DRY_RUN_OK', selected.violations.join('\n'));
        assert.equal(sha256(path.join(repoRoot, '.git/index')), indexDigest);
        for (const file of changedFiles) assert.equal(fs.existsSync(path.join(repoRoot, file)), false);
        assert.equal(JSON.parse(fs.readFileSync(captured.manifest_path, 'utf8')).status, 'suspended');
    });

    it('spools every preimage to one unnamed descriptor and restores all files on failure', (context) => {
        const fixture = makeBackupRestoreFixture(callback => context.after(callback), 24);
        const originalOpen = mutableFs.openSync;
        const originalWrite = mutableFs.writeSync;
        const originalClose = mutableFs.closeSync;
        let spoolDescriptor: number | null = null;
        let spoolOpenCount = 0;
        let spoolBytes = 0;
        let spoolClosed = false;
        context.mock.method(mutableFs, 'openSync', (file: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
            const descriptor = originalOpen(file, flags, mode);
            if (String(file).includes('.garda-restore-backup-')
                && typeof flags === 'number' && (flags & fs.constants.O_RDWR) !== 0) {
                spoolDescriptor = descriptor;
                spoolOpenCount++;
            }
            return descriptor;
        });
        context.mock.method(mutableFs, 'writeSync', (
            descriptor: number, buffer: NodeJS.ArrayBufferView, offset: number, length: number, position: number
        ) => {
            if (descriptor === spoolDescriptor && !spoolClosed) {
                assert.equal(fs.fstatSync(descriptor).nlink, 0, 'detach before writing any preimage bytes');
                assert.ok(length <= 64 * 1024, 'spool writes must be chunked');
                const written = originalWrite(descriptor, buffer, offset, Math.min(length, 4096), position);
                spoolBytes += written;
                return written;
            }
            return originalWrite(descriptor, buffer, offset, length, position);
        });
        context.mock.method(mutableFs, 'closeSync', (descriptor: number) => {
            if (descriptor === spoolDescriptor) spoolClosed = true;
            return originalClose(descriptor);
        });

        const violations = applyAdvancedRestorePlan(fixture.repoRoot, fixture.plan, fixture.files, []);

        assert.match(violations.join('\n'), /failed without retained mutations/u);
        assert.equal(spoolOpenCount, 1);
        assert.equal(spoolBytes, Buffer.byteLength(fixture.originalContent) * fixture.files.length);
        assert.equal(spoolClosed, true);
        for (const file of fixture.files) {
            assert.equal(fs.readFileSync(path.join(fixture.repoRoot, file.path), 'utf8'), fixture.originalContent);
        }
        assert.equal(fs.readdirSync(fixture.repoRoot).some(name => name.startsWith('.garda-restore-backup-')), false);
    });

    it('fails before mutation when the empty backup cannot be detached safely', (context) => {
        const fixture = makeBackupRestoreFixture(callback => context.after(callback));
        const originalUnlink = mutableFs.unlinkSync;
        let attempted = false;
        context.mock.method(mutableFs, 'unlinkSync', (file: fs.PathLike) => {
            if (String(file).includes('.garda-restore-backup-')) {
                attempted = true;
                assert.equal(fs.statSync(file).size, 0);
                throw Object.assign(new Error('injected backup detach failure'), { code: 'EIO' });
            }
            return originalUnlink(file);
        });
        const violations = applyAdvancedRestorePlan(fixture.repoRoot, fixture.plan, fixture.files, []);
        assert.equal(attempted, true);
        assert.match(violations.join('\n'), /failed before mutation:.*backup detach failure/u);
        for (const file of fixture.files) {
            assert.equal(fs.readFileSync(path.join(fixture.repoRoot, file.path), 'utf8'), fixture.originalContent);
        }
    });

    for (const failure of ['disk-full', 'no-progress', 'corrupt-readback'] as const) {
        it(`rejects backup ${failure} and closes its descriptor`, (context) => {
            const fixture = makeBackupRestoreFixture(callback => context.after(callback));
            const originalOpen = mutableFs.openSync;
            const originalRead = mutableFs.readSync;
            const originalWrite = mutableFs.writeSync;
            const originalClose = mutableFs.closeSync;
            let spoolDescriptor: number | null = null;
            let spoolClosed = false;
            let injected = false;
            context.mock.method(mutableFs, 'openSync', (file: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
                const descriptor = originalOpen(file, flags, mode);
                if (String(file).includes('.garda-restore-backup-')
                    && typeof flags === 'number' && (flags & fs.constants.O_RDWR) !== 0) spoolDescriptor = descriptor;
                return descriptor;
            });
            context.mock.method(mutableFs, 'writeSync', (
                descriptor: number, buffer: NodeJS.ArrayBufferView, offset: number, length: number, position: number
            ) => {
                if (descriptor === spoolDescriptor && !spoolClosed && failure !== 'corrupt-readback') {
                    injected = true;
                    if (failure === 'no-progress') return 0;
                    throw Object.assign(new Error('injected backup disk full'), { code: 'ENOSPC' });
                }
                return originalWrite(descriptor, buffer, offset, length, position);
            });
            context.mock.method(mutableFs, 'readSync', (
                descriptor: number, buffer: Buffer, offset: number, length: number, position: number
            ) => {
                const bytesRead = originalRead(descriptor, buffer, offset, length, position);
                if (descriptor === spoolDescriptor && !spoolClosed && failure === 'corrupt-readback' && bytesRead > 0) {
                    buffer[offset] ^= 1;
                    injected = true;
                }
                return bytesRead;
            });
            context.mock.method(mutableFs, 'closeSync', (descriptor: number) => {
                if (descriptor === spoolDescriptor) spoolClosed = true;
                return originalClose(descriptor);
            });
            const violations = applyAdvancedRestorePlan(fixture.repoRoot, fixture.plan, fixture.files, []);
            assert.equal(injected, true);
            assert.equal(spoolClosed, true);
            assert.match(violations.join('\n'), /backup (disk full|write made no forward progress|digest mismatch)/u);
            for (const file of fixture.files) {
                assert.equal(fs.readFileSync(path.join(fixture.repoRoot, file.path), 'utf8'), fixture.originalContent);
            }
        });
    }

    it('never reopens or deletes a replacement at the detached backup name', (context) => {
        const fixture = makeBackupRestoreFixture(callback => context.after(callback));
        const originalOpen = mutableFs.openSync;
        const originalUnlink = mutableFs.unlinkSync;
        let spoolPath: string | null = null;
        let replaced = false;
        context.mock.method(mutableFs, 'openSync', (file: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
            if (String(file).includes('.garda-restore-backup-')
                && typeof flags === 'number' && (flags & fs.constants.O_RDWR) !== 0) spoolPath = String(file);
            return originalOpen(file, flags, mode);
        });
        context.mock.method(mutableFs, 'unlinkSync', (file: fs.PathLike) => {
            originalUnlink(file);
            if (!replaced && spoolPath !== null && String(file).includes('.garda-restore-backup-')) {
                replaced = true;
                fs.writeFileSync(spoolPath, 'foreign replacement');
            }
        });
        const violations = applyAdvancedRestorePlan(fixture.repoRoot, fixture.plan, fixture.files, []);
        assert.match(violations.join('\n'), /failed without retained mutations/u);
        assert.equal(replaced, true);
        assert.ok(spoolPath);
        assert.equal(fs.readFileSync(spoolPath, 'utf8'), 'foreign replacement');
        for (const file of fixture.files) {
            assert.equal(fs.readFileSync(path.join(fixture.repoRoot, file.path), 'utf8'), fixture.originalContent);
        }
    });

    it('keeps advanced restore Git subprocess count constant as the selected set grows', (context) => {
        const measure = (count: number) => {
            const repoRoot = makeRepo((callback) => context.after(callback));
            const changedFiles = Array.from({ length: count }, (_, index) => `src/batch file ${index}.ts`);
            for (const [index, relativePath] of changedFiles.entries()) {
                writeFile(repoRoot, relativePath, `export const batch${index} = 1;\n`);
            }
            runGit(repoRoot, ['add', '.']);
            runGit(repoRoot, ['commit', '-m', `seed ${count} restore files`]);
            for (const [index, relativePath] of changedFiles.entries()) {
                writeFile(repoRoot, relativePath, `export const batch${index} = 2;\n`);
            }
            runGit(repoRoot, ['add', '--', ...changedFiles]);
            const captured = captureAndSuspendSplitRequiredWip({
                repoRoot,
                taskId: TASK_ID,
                preflightPath: writePreflight(repoRoot, changedFiles),
                guardKind: 'scope_budget',
                guardReason: 'advanced restore batch benchmark'
            });
            assert.equal(captured.status, 'CAPTURED', captured.violations.join('\n'));
            assert.ok(captured.manifest_path);
            writeFile(repoRoot, `src/child-${count}.ts`, `export const child${count} = true;\n`);
            runGit(repoRoot, ['add', '.']);
            runGit(repoRoot, ['commit', '-m', `advance after ${count} captured files`]);

            const traced = traceGitCommands(() => restoreSplitRequiredWip({
                repoRoot,
                taskId: TASK_ID,
                manifestPath: captured.manifest_path!,
                includePaths: changedFiles,
                dryRun: true
            }));
            assert.equal(traced.value.status, 'DRY_RUN_OK', traced.value.violations.join('\n'));
            return traced.commands;
        };

        const singleFileCommands = measure(1);
        const multiFileCommands = measure(12);
        assert.equal(multiFileCommands.length, singleFileCommands.length);
        assert.equal(multiFileCommands.filter((args) => args[0] === 'checkout-index').length, 1);
        assert.equal(multiFileCommands.some((args) => args[0] === 'ls-tree'), false);
        const catFileCommands = multiFileCommands.filter((args) => args[0] === 'cat-file');
        assert.ok(catFileCommands.length >= 5);
        assert.ok(catFileCommands.every((args) => (
            args.includes('--batch') || args.some((arg) => arg.startsWith('--batch-check='))
        )));
        assert.equal(multiFileCommands.some((args) => args[0] === 'ls-files'), false);
        assert.equal(
            multiFileCommands.some((args) => args[0] === 'diff' && args.includes('--name-only')),
            false
        );
    });

    it('restores selected paths while preserving unrelated unmerged index stages', (context) => {
        const repoRoot = makeRepo((callback) => context.after(callback));
        writeFile(repoRoot, 'src/a.ts', 'export const a = 2;\n');
        runGit(repoRoot, ['add', 'src/a.ts']);
        const captured = captureAndSuspendSplitRequiredWip({
            repoRoot,
            taskId: TASK_ID,
            preflightPath: writePreflight(repoRoot, ['src/a.ts']),
            guardKind: 'scope_budget',
            guardReason: 'unrelated conflict stage preservation'
        });
        assert.equal(captured.status, 'CAPTURED', captured.violations.join('\n'));
        assert.ok(captured.manifest_path);

        writeFile(repoRoot, 'src/child.ts', 'export const child = true;\n');
        runGit(repoRoot, ['add', 'src/child.ts']);
        runGit(repoRoot, ['commit', '-m', 'advance after capture']);
        const conflictObjectId = runGit(repoRoot, ['rev-parse', 'HEAD:src/b.ts']).trim();
        const zeroObjectId = '0'.repeat(conflictObjectId.length);
        childProcess.execFileSync(
            'git',
            ['-C', repoRoot, 'update-index', '-z', '--index-info'],
            {
                input: Buffer.from([
                    `0 ${zeroObjectId}\tsrc/b.ts\0`,
                    `100644 ${conflictObjectId} 1\tsrc/b.ts\0`,
                    `100644 ${conflictObjectId} 2\tsrc/b.ts\0`,
                    `100644 ${conflictObjectId} 3\tsrc/b.ts\0`
                ].join(''), 'utf8'),
                stdio: ['pipe', 'pipe', 'pipe']
            }
        );
        const conflictStagesBefore = runGit(repoRoot, ['ls-files', '--unmerged', '--stage', '--', 'src/b.ts']);

        const restored = restoreSplitRequiredWip({
            repoRoot,
            taskId: TASK_ID,
            manifestPath: captured.manifest_path,
            includePaths: ['src/a.ts']
        });

        assert.equal(restored.status, 'RESTORED', restored.violations.join('\n'));
        assert.equal(fs.readFileSync(path.join(repoRoot, 'src', 'a.ts'), 'utf8'), 'export const a = 2;\n');
        assert.equal(
            runGit(repoRoot, ['ls-files', '--unmerged', '--stage', '--', 'src/b.ts']),
            conflictStagesBefore
        );
    });

    it('rejects an unstaged candidate index entry that changes a tracked file into a symlink', (context) => {
        const repoRoot = makeRepo((callback) => context.after(callback));
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-wip-plan-symlink-'));
        context.after(() => fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
        const gitIndexPath = runGit(repoRoot, ['rev-parse', '--git-path', 'index']).trim();
        const indexPath = path.isAbsolute(gitIndexPath)
            ? path.resolve(gitIndexPath)
            : path.resolve(repoRoot, gitIndexPath);
        const modifiedIndexPath = path.join(tempRoot, 'modified.index');
        fs.copyFileSync(indexPath, modifiedIndexPath);
        const environment = {
            ...process.env,
            GIT_INDEX_FILE: modifiedIndexPath
        };
        const linkBlob = childProcess.execFileSync(
            'git',
            ['-C', repoRoot, 'hash-object', '-w', '--stdin'],
            {
                encoding: 'utf8',
                input: 'missing-target\n'
            }
        ).trim();
        childProcess.execFileSync(
            'git',
            ['-C', repoRoot, 'update-index', '--add', '--cacheinfo', `120000,${linkBlob},src/a.ts`],
            {
                env: environment,
                stdio: ['ignore', 'pipe', 'pipe']
            }
        );
        const unstagedPatchPath = path.join(tempRoot, 'unstaged.patch');
        fs.writeFileSync(
            unstagedPatchPath,
            childProcess.execFileSync(
                'git',
                ['-C', repoRoot, 'diff', '--cached', '--binary', '--full-index', '--', 'src/a.ts'],
                {
                    encoding: 'utf8',
                    env: environment
                }
            ),
            'utf8'
        );
        const stagedPatchPath = path.join(tempRoot, 'staged.patch');
        fs.writeFileSync(stagedPatchPath, '', 'utf8');
        const trackedFile: SplitRequiredWipTrackedFileEvidence = {
            path: 'src/a.ts',
            head_sha256: runGit(repoRoot, ['rev-parse', 'HEAD:src/a.ts']).trim(),
            worktree_sha256: sha256(path.join(repoRoot, 'src', 'a.ts')),
            staged: false,
            unstaged: true
        };
        const manifest: SplitRequiredWipManifest = {
            schema_version: 1,
            kind: 'split_required_wip',
            status: 'suspended',
            task_id: TASK_ID,
            guard_kind: 'scope_budget',
            guard_reason: 'candidate symlink validation',
            created_at_utc: '2026-06-30T00:00:00.000Z',
            base_commit: runGit(repoRoot, ['rev-parse', 'HEAD']).trim(),
            preflight_path: '',
            preflight_sha256: '',
            patches: {
                staged: {
                    path: stagedPatchPath,
                    sha256: sha256(stagedPatchPath),
                    bytes: 0,
                    empty: true
                },
                unstaged: {
                    path: unstagedPatchPath,
                    sha256: sha256(unstagedPatchPath),
                    bytes: fs.statSync(unstagedPatchPath).size,
                    empty: false
                }
            },
            tracked_files: [trackedFile],
            untracked_files: [],
            unrelated_untracked_files: [],
            ignored_runtime_artifacts: [],
            restore_commands: {
                list: '',
                preview_full: '',
                restore_full: '',
                preview_partial_template: '',
                restore_partial_template: '',
                retire: ''
            }
        };

        const result = planAdvancedRestore(
            repoRoot,
            manifest,
            new Set(['src/a.ts']),
            [trackedFile]
        );
        if (result.plan) {
            fs.rmSync(result.plan.tempRoot, { recursive: true, force: true });
        }

        assert.equal(result.plan, null);
        assert.ok(result.violations.some((violation) => violation.includes(
            'candidate index target is a symbolic link: src/a.ts'
        )));
        assert.equal(runGit(repoRoot, ['status', '--short']).trim(), '');
    });

    it('normalizes selected paths and treats Git apply includes as literals', () => {
        const selectedPaths = normalizeSelectedPaths([
            '\\src\\file[1].ts',
            'src/file[1].ts',
            'src/other?.ts'
        ]);

        assert.deepEqual([...selectedPaths], ['src/file[1].ts', 'src/other?.ts']);
        assert.deepEqual(buildGitApplyIncludeArgs(selectedPaths), [
            '--include=src/file\\[1\\].ts',
            '--include=src/other\\?.ts'
        ]);
        assert.deepEqual(
            selectedFiles([{ path: 'src/file[1].ts' }, { path: 'src/b.ts' }], selectedPaths),
            [{ path: 'src/file[1].ts' }]
        );
    });

    it('restores the index and selected files when atomic index promotion fails', (context) => {
        const repoRoot = makeRepo((callback) => context.after(callback));
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-wip-plan-candidate-'));
        context.after(() => fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
        const candidateWorktreeRoot = path.join(tempRoot, 'worktree');
        writeFile(candidateWorktreeRoot, 'src/a.ts', 'export const a = 2;\n');
        const gitIndexPath = runGit(repoRoot, ['rev-parse', '--git-path', 'index']).trim();
        const indexPath = path.isAbsolute(gitIndexPath)
            ? path.resolve(gitIndexPath)
            : path.resolve(repoRoot, gitIndexPath);
        const originalIndexSha256 = sha256(indexPath);
        const originalFileSha256 = sha256(path.join(repoRoot, 'src', 'a.ts'));
        const trackedFile: SplitRequiredWipTrackedFileEvidence = {
            path: 'src/a.ts',
            head_sha256: originalFileSha256,
            worktree_sha256: originalFileSha256,
            staged: true,
            unstaged: false
        };

        const violations = applyAdvancedRestorePlan(repoRoot, {
            tempRoot,
            candidateIndexPath: path.join(tempRoot, 'missing-candidate.index'),
            candidateWorktreeRoot,
            currentHead: runGit(repoRoot, ['rev-parse', 'HEAD']).trim(),
            currentIndexSha256: originalIndexSha256,
            targetSha256: new Map([['src/a.ts', originalFileSha256]])
        }, [trackedFile], []);

        assert.equal(violations.length, 1);
        assert.match(violations[0], /^three-way restore failed without retained mutations:/u);
        assert.equal(sha256(indexPath), originalIndexSha256);
        assert.equal(sha256(path.join(repoRoot, 'src', 'a.ts')), originalFileSha256);
        assert.equal(runGit(repoRoot, ['status', '--short']).trim(), '');
    });

    it('publishes bytes from the authenticated candidate snapshot when its path is replaced', (context) => {
        const repoRoot = makeRepo((callback) => context.after(callback));
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-wip-plan-candidate-swap-'));
        context.after(() => fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
        const candidateWorktreeRoot = path.join(tempRoot, 'worktree');
        const relativePath = 'src/a.ts';
        const candidatePath = path.join(candidateWorktreeRoot, relativePath);
        const displacedCandidatePath = `${candidatePath}.authenticated`;
        const targetPath = path.join(repoRoot, relativePath);
        const authenticatedContent = 'export const a = 2;\n';
        const forgedContent = 'export const forged = true;\n';
        writeFile(candidateWorktreeRoot, relativePath, authenticatedContent);
        const gitIndexPath = runGit(repoRoot, ['rev-parse', '--git-path', 'index']).trim();
        const indexPath = path.isAbsolute(gitIndexPath)
            ? path.resolve(gitIndexPath)
            : path.resolve(repoRoot, gitIndexPath);
        const originalIndexSha256 = sha256(indexPath);
        const originalFileSha256 = sha256(targetPath);
        const originalOpenSync = mutableFs.openSync;
        const originalCloseSync = mutableFs.closeSync;
        let candidateDescriptor: number | null = null;
        let candidateReplaced = false;
        context.mock.method(mutableFs, 'openSync', (
            filePath: fs.PathLike,
            flags: fs.OpenMode,
            mode?: fs.Mode
        ) => {
            const descriptor = originalOpenSync(filePath, flags, mode);
            if (!candidateReplaced
                && path.resolve(String(filePath)) === path.resolve(candidatePath)) {
                candidateDescriptor = descriptor;
            }
            return descriptor;
        });
        context.mock.method(mutableFs, 'closeSync', (descriptor: number) => {
            originalCloseSync(descriptor);
            if (!candidateReplaced && descriptor === candidateDescriptor) {
                candidateReplaced = true;
                // Replace the directory entry, not just bytes in the captured inode.
                fs.renameSync(candidatePath, displacedCandidatePath);
                fs.writeFileSync(candidatePath, forgedContent, 'utf8');
            }
        });
        const trackedFile: SplitRequiredWipTrackedFileEvidence = {
            path: relativePath,
            head_sha256: originalFileSha256,
            worktree_sha256: originalFileSha256,
            staged: true,
            unstaged: false
        };

        const violations = applyAdvancedRestorePlan(repoRoot, {
            tempRoot,
            candidateIndexPath: indexPath,
            candidateWorktreeRoot,
            currentHead: runGit(repoRoot, ['rev-parse', 'HEAD']).trim(),
            currentIndexSha256: originalIndexSha256,
            targetSha256: new Map([[relativePath, originalFileSha256]])
        }, [trackedFile], []);

        assert.deepEqual(violations, []);
        assert.equal(candidateReplaced, true);
        assert.equal(fs.readFileSync(targetPath, 'utf8'), authenticatedContent);
        assert.equal(fs.readFileSync(candidatePath, 'utf8'), forgedContent);
        assert.equal(fs.readFileSync(displacedCandidatePath, 'utf8'), authenticatedContent);
    });

    it('removes all advanced created targets after their parent relocates before index promotion fails', {
        skip: process.platform === 'win32' ? 'Windows prevents renaming a directory with open child handles.' : false
    }, (context) => {
        const repoRoot = makeRepo((callback) => context.after(callback));
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-wip-plan-created-parent-move-'));
        context.after(() => fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
        const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-wip-plan-created-outside-'));
        context.after(() => fs.rmSync(outsideRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
        const candidateWorktreeRoot = path.join(tempRoot, 'worktree');
        const trackedPath = 'generated/tracked.ts';
        const untrackedPath = 'generated/untracked.ts';
        const trackedContent = Buffer.from('export const tracked = true;\n', 'utf8');
        const untrackedContent = Buffer.from('export const untracked = true;\n', 'utf8');
        writeFile(candidateWorktreeRoot, trackedPath, trackedContent.toString('utf8'));
        const gitIndexPath = runGit(repoRoot, ['rev-parse', '--git-path', 'index']).trim();
        const indexPath = path.isAbsolute(gitIndexPath)
            ? path.resolve(gitIndexPath)
            : path.resolve(repoRoot, gitIndexPath);
        const originalIndexSha256 = sha256(indexPath);
        const parentPath = path.join(repoRoot, 'generated');
        const movedParentPath = path.join(outsideRoot, 'moved-generated');
        const originalCopyFileSync = mutableFs.copyFileSync;
        let parentMoved = false;
        context.mock.method(mutableFs, 'copyFileSync', (
            source: fs.PathLike,
            destination: fs.PathLike,
            mode?: number
        ) => {
            if (!parentMoved && path.resolve(String(destination)) === path.resolve(`${indexPath}.lock`)) {
                parentMoved = true;
                fs.renameSync(parentPath, movedParentPath);
            }
            return originalCopyFileSync(source, destination, mode);
        });
        const trackedFile: SplitRequiredWipTrackedFileEvidence = {
            path: trackedPath,
            head_sha256: null,
            worktree_sha256: createHash('sha256').update(trackedContent).digest('hex'),
            staged: true,
            unstaged: false
        };
        const untrackedFile: SplitRequiredWipUntrackedFileEvidence = {
            path: untrackedPath,
            artifact_path: path.join(tempRoot, 'untracked.ts'),
            sha256: createHash('sha256').update(untrackedContent).digest('hex'),
            bytes: untrackedContent.length
        };

        try {
            const violations = applyAdvancedRestorePlan(repoRoot, {
                tempRoot,
                candidateIndexPath: path.join(tempRoot, 'missing-candidate.index'),
                candidateWorktreeRoot,
                currentHead: runGit(repoRoot, ['rev-parse', 'HEAD']).trim(),
                currentIndexSha256: originalIndexSha256,
                targetSha256: new Map([
                    [trackedPath, null],
                    [untrackedPath, null]
                ])
            }, [trackedFile], [untrackedFile], {
                patches: {
                    staged: Buffer.alloc(0),
                    unstaged: Buffer.alloc(0)
                },
                untrackedFiles: new Map([[untrackedPath, untrackedContent]])
            });

            assert.equal(violations.length, 1);
            assert.match(violations[0], /^three-way restore failed without retained mutations:/u);
            assert.equal(parentMoved, true);
            assert.equal(fs.existsSync(path.join(movedParentPath, 'tracked.ts')), false);
            assert.equal(fs.existsSync(path.join(movedParentPath, 'untracked.ts')), false);
            assert.equal(sha256(indexPath), originalIndexSha256);
        } finally {
            if (!fs.existsSync(parentPath) && fs.existsSync(movedParentPath)) {
                fs.renameSync(movedParentPath, parentPath);
            }
        }
        assert.equal(runGit(repoRoot, ['status', '--short']).trim(), '');
    });

    it('preserves a concurrently changed index and rolls back selected files', (context) => {
        const repoRoot = makeRepo((callback) => context.after(callback));
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-wip-plan-index-race-'));
        context.after(() => fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
        const candidateWorktreeRoot = path.join(tempRoot, 'worktree');
        writeFile(candidateWorktreeRoot, 'src/a.ts', 'export const a = 2;\n');
        const gitIndexPath = runGit(repoRoot, ['rev-parse', '--git-path', 'index']).trim();
        const indexPath = path.isAbsolute(gitIndexPath)
            ? path.resolve(gitIndexPath)
            : path.resolve(repoRoot, gitIndexPath);
        const candidateIndexPath = path.join(tempRoot, 'candidate.index');
        const originalIndex = fs.readFileSync(indexPath);
        fs.copyFileSync(indexPath, candidateIndexPath);
        const originalFileSha256 = sha256(path.join(repoRoot, 'src', 'a.ts'));
        const racedIndex = Buffer.concat([originalIndex, Buffer.from([0])]);
        let indexRaced = false;
        const originalCopyFileSync = mutableFs.copyFileSync;
        context.mock.method(mutableFs, 'copyFileSync', (
            source: fs.PathLike,
            destination: fs.PathLike,
            mode?: number
        ) => {
            if (!indexRaced && path.resolve(String(destination)) === path.resolve(`${indexPath}.lock`)) {
                indexRaced = true;
                fs.writeFileSync(indexPath, racedIndex);
            }
            return originalCopyFileSync(source, destination, mode);
        });
        const trackedFile: SplitRequiredWipTrackedFileEvidence = {
            path: 'src/a.ts',
            head_sha256: originalFileSha256,
            worktree_sha256: originalFileSha256,
            staged: true,
            unstaged: false
        };

        try {
            const violations = applyAdvancedRestorePlan(repoRoot, {
                tempRoot,
                candidateIndexPath,
                candidateWorktreeRoot,
                currentHead: runGit(repoRoot, ['rev-parse', 'HEAD']).trim(),
                currentIndexSha256: createHash('sha256').update(originalIndex).digest('hex'),
                targetSha256: new Map([['src/a.ts', originalFileSha256]])
            }, [trackedFile], []);

            assert.equal(violations.length, 1);
            assert.match(violations[0], /repository index changed before candidate index promotion/u);
            assert.equal(indexRaced, true);
            assert.deepEqual(fs.readFileSync(indexPath), racedIndex);
            assert.equal(sha256(path.join(repoRoot, 'src', 'a.ts')), originalFileSha256);
            assert.equal(fs.existsSync(`${indexPath}.lock`), false);
        } finally {
            fs.writeFileSync(indexPath, originalIndex);
        }
        assert.equal(runGit(repoRoot, ['status', '--short']).trim(), '');
    });

    it('blocks advanced tracked restore when its parent is replaced by a symlink', (context) => {
        const repoRoot = makeRepo((callback) => context.after(callback));
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-wip-plan-candidate-'));
        context.after(() => fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
        const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-wip-plan-parent-swap-'));
        context.after(() => fs.rmSync(outsideRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
        const candidateWorktreeRoot = path.join(tempRoot, 'worktree');
        writeFile(candidateWorktreeRoot, 'src/a.ts', 'export const a = 2;\n');
        writeFile(outsideRoot, 'a.ts', 'outside file must remain unchanged\n');
        const gitIndexPath = runGit(repoRoot, ['rev-parse', '--git-path', 'index']).trim();
        const indexPath = path.isAbsolute(gitIndexPath)
            ? path.resolve(gitIndexPath)
            : path.resolve(repoRoot, gitIndexPath);
        const originalIndexSha256 = sha256(indexPath);
        const targetPath = path.join(repoRoot, 'src', 'a.ts');
        const parentPath = path.dirname(targetPath);
        const originalParentPath = path.join(repoRoot, '.src-original');
        const outsideTargetPath = path.join(outsideRoot, 'a.ts');
        const originalFileSha256 = sha256(targetPath);
        let parentReplaced = false;
        const originalOpenSync = mutableFs.openSync;
        context.mock.method(mutableFs, 'openSync', (
            filePath: fs.PathLike,
            flags: fs.OpenMode,
            mode?: fs.Mode
        ) => {
            if (!parentReplaced
                && path.resolve(String(filePath)) === path.resolve(targetPath)
                && typeof flags === 'number'
                && ((flags & fs.constants.O_WRONLY) !== 0
                    || (flags & fs.constants.O_RDWR) !== 0)) {
                parentReplaced = true;
                fs.renameSync(parentPath, originalParentPath);
                fs.symlinkSync(outsideRoot, parentPath, process.platform === 'win32' ? 'junction' : 'dir');
            }
            return originalOpenSync(filePath, flags, mode);
        });
        const trackedFile: SplitRequiredWipTrackedFileEvidence = {
            path: 'src/a.ts',
            head_sha256: originalFileSha256,
            worktree_sha256: originalFileSha256,
            staged: true,
            unstaged: false
        };

        try {
            const violations = applyAdvancedRestorePlan(repoRoot, {
                tempRoot,
                candidateIndexPath: indexPath,
                candidateWorktreeRoot,
                currentHead: runGit(repoRoot, ['rev-parse', 'HEAD']).trim(),
                currentIndexSha256: originalIndexSha256,
                targetSha256: new Map([['src/a.ts', originalFileSha256]])
            }, [trackedFile], []);

            assert.equal(violations.length, 1);
            assert.match(violations[0], /^three-way restore failed without retained mutations:/u);
            assert.equal(parentReplaced, true);
            assert.equal(fs.readFileSync(outsideTargetPath, 'utf8'), 'outside file must remain unchanged\n');
            assert.equal(sha256(indexPath), originalIndexSha256);
            assert.equal(sha256(path.join(originalParentPath, 'a.ts')), originalFileSha256);
        } finally {
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
        }
        assert.equal(runGit(repoRoot, ['status', '--short']).trim(), '');
    });

    it('blocks exclusive restore and neutralizes bytes after its parent relocates during descriptor mutation', {
        skip: process.platform === 'win32' ? 'Windows prevents renaming a directory with an open child handle.' : false
    }, (context) => {
        const repoRoot = makeRepo((callback) => context.after(callback));
        const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-wip-exclusive-parent-move-'));
        context.after(() => fs.rmSync(outsideRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
        const parentPath = path.join(repoRoot, 'src');
        const movedParentPath = path.join(outsideRoot, 'moved-src');
        const movedTargetPath = path.join(movedParentPath, 'new.ts');
        const originalFsyncSync = mutableFs.fsyncSync;
        let parentMoved = false;
        context.mock.method(mutableFs, 'fsyncSync', (descriptor: number) => {
            if (!parentMoved) {
                parentMoved = true;
                fs.renameSync(parentPath, movedParentPath);
            }
            return originalFsyncSync(descriptor);
        });

        try {
            assert.throws(
                () => writeExclusiveRepoFile(
                    repoRoot,
                    'src/new.ts',
                    Buffer.from('restored secret payload\n', 'utf8')
                ),
                /restore parent identity changed during access/u
            );
            assert.equal(parentMoved, true);
            assert.equal(fs.existsSync(movedTargetPath), false);
        } finally {
            if (!fs.existsSync(parentPath) && fs.existsSync(movedParentPath)) {
                fs.renameSync(movedParentPath, parentPath);
            }
        }
        assert.equal(runGit(repoRoot, ['status', '--short']).trim(), '');
    });

    it('removes a retained untracked restore after its parent relocates before rollback', {
        skip: process.platform === 'win32' ? 'Windows prevents renaming a directory with open child handles.' : false
    }, (context) => {
        const repoRoot = makeRepo((callback) => context.after(callback));
        const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-wip-retained-parent-move-'));
        context.after(() => fs.rmSync(outsideRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
        const parentPath = path.join(repoRoot, 'src');
        const movedParentPath = path.join(outsideRoot, 'moved-src');
        const movedTargetPath = path.join(movedParentPath, 'new.ts');
        const removalHandle = writeExclusiveRepoFileWithRemovalHandle(
            repoRoot,
            'src/new.ts',
            Buffer.from('restored secret payload\n', 'utf8')
        );

        try {
            fs.renameSync(parentPath, movedParentPath);
            removalHandle.remove();
            assert.equal(fs.existsSync(movedTargetPath), false);
        } finally {
            removalHandle.close();
            if (!fs.existsSync(parentPath) && fs.existsSync(movedParentPath)) {
                fs.renameSync(movedParentPath, parentPath);
            }
        }
        assert.equal(runGit(repoRoot, ['status', '--short']).trim(), '');
    });

    it('blocks tracked restore and restores original bytes after its parent relocates during descriptor mutation', {
        skip: process.platform === 'win32' ? 'Windows prevents renaming a directory with an open child handle.' : false
    }, (context) => {
        const repoRoot = makeRepo((callback) => context.after(callback));
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-wip-tracked-parent-move-'));
        context.after(() => fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
        const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-wip-tracked-parent-outside-'));
        context.after(() => fs.rmSync(outsideRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
        const candidateWorktreeRoot = path.join(tempRoot, 'worktree');
        writeFile(candidateWorktreeRoot, 'src/a.ts', 'export const a = 2;\n');
        const gitIndexPath = runGit(repoRoot, ['rev-parse', '--git-path', 'index']).trim();
        const indexPath = path.isAbsolute(gitIndexPath)
            ? path.resolve(gitIndexPath)
            : path.resolve(repoRoot, gitIndexPath);
        const originalIndexSha256 = sha256(indexPath);
        const originalFileSha256 = sha256(path.join(repoRoot, 'src', 'a.ts'));
        const parentPath = path.join(repoRoot, 'src');
        const movedParentPath = path.join(outsideRoot, 'moved-src');
        const movedTargetPath = path.join(movedParentPath, 'a.ts');
        const originalFsyncSync = mutableFs.fsyncSync;
        let parentMoved = false;
        context.mock.method(mutableFs, 'fsyncSync', (descriptor: number) => {
            if (!parentMoved) {
                parentMoved = true;
                fs.renameSync(parentPath, movedParentPath);
            }
            return originalFsyncSync(descriptor);
        });
        const trackedFile: SplitRequiredWipTrackedFileEvidence = {
            path: 'src/a.ts',
            head_sha256: originalFileSha256,
            worktree_sha256: originalFileSha256,
            staged: true,
            unstaged: false
        };

        try {
            const violations = applyAdvancedRestorePlan(repoRoot, {
                tempRoot,
                candidateIndexPath: indexPath,
                candidateWorktreeRoot,
                currentHead: runGit(repoRoot, ['rev-parse', 'HEAD']).trim(),
                currentIndexSha256: originalIndexSha256,
                targetSha256: new Map([['src/a.ts', originalFileSha256]])
            }, [trackedFile], []);

            assert.equal(violations.length, 1);
            assert.equal(parentMoved, true);
            assert.equal(fs.readFileSync(movedTargetPath, 'utf8'), 'export const a = 1;\n');
            assert.match(violations[0], /^three-way restore failed without retained mutations:/u);
            assert.ok(violations[0].includes('restore parent identity changed during access'));
        } finally {
            if (fs.existsSync(parentPath)) {
                fs.rmSync(parentPath, { recursive: true, force: true });
            }
            if (fs.existsSync(movedParentPath)) {
                fs.renameSync(movedParentPath, parentPath);
            }
        }
        assert.equal(runGit(repoRoot, ['status', '--short']).trim(), '');
    });

    it('blocks handoff promotion replacement and restores original bytes after its parent relocates', {
        skip: process.platform === 'win32' ? 'Windows prevents renaming a directory with an open child handle.' : false
    }, (context) => {
        const repoRoot = makeRepo((callback) => context.after(callback));
        const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-wip-handoff-parent-outside-'));
        context.after(() => fs.rmSync(outsideRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
        const relativeHandoffPath = 'handoff/restore.json';
        const handoffPath = path.join(repoRoot, relativeHandoffPath);
        const parentPath = path.dirname(handoffPath);
        const movedParentPath = path.join(outsideRoot, 'moved-handoff');
        const movedHandoffPath = path.join(movedParentPath, 'restore.json');
        const originalLinkSync = mutableFs.linkSync;
        let parentMoved = false;
        context.mock.method(mutableFs, 'linkSync', (
            sourcePath: fs.PathLike,
            newPath: fs.PathLike
        ) => {
            originalLinkSync(sourcePath, newPath);
            if (!parentMoved
                && String(sourcePath).includes('.garda-replace-')
                && path.basename(String(newPath)) === path.basename(handoffPath)) {
                parentMoved = true;
                fs.renameSync(parentPath, movedParentPath);
            }
        });
        const preparedHandoff: SplitRequiredWipRestoreHandoff = {
            schema_version: 1,
            kind: 'split_required_wip_restore_handoff',
            status: 'prepared',
            handoff_id: 'handoff-parent-relocation',
            repo_root: repoRoot,
            task_id: TASK_ID,
            manifest_path: path.join(repoRoot, 'manifest.json'),
            manifest_sha256: '0'.repeat(64),
            selected_paths: [],
            restored_files: [],
            timeline_anchor: {
                matching_events: 0,
                parse_errors: 0,
                last_integrity_sequence: null,
                last_event_sha256: null
            },
            created_at_utc: '2026-09-02T00:00:00.000Z'
        };
        const pendingHandoff: SplitRequiredWipRestoreHandoff = {
            ...preparedHandoff,
            status: 'pending',
            restored_file_evidence: [],
            workspace_state_sha256: '1'.repeat(64)
        };
        const originalContent = `${JSON.stringify(preparedHandoff, null, 2)}\n`;
        writeFile(repoRoot, relativeHandoffPath, originalContent);

        try {
            assert.throws(
                () => replaceSplitRequiredWipRestoreHandoff(
                    handoffPath,
                    pendingHandoff,
                    preparedHandoff
                ),
                /restore parent identity changed during access/u
            );
            assert.equal(parentMoved, true);
            assert.equal(fs.readFileSync(movedHandoffPath, 'utf8'), originalContent);
            assert.deepEqual(
                fs.readdirSync(movedParentPath).sort(),
                [path.basename(movedHandoffPath)]
            );
        } finally {
            if (!fs.existsSync(parentPath) && fs.existsSync(movedParentPath)) {
                fs.renameSync(movedParentPath, parentPath);
            }
        }
    });

    it('removes the authenticated repository file instead of an outside target after its parent is replaced', {
        skip: process.platform === 'win32' ? 'Windows prevents replacing a directory with an open child handle.' : false
    }, (context) => {
        const repoRoot = makeRepo((callback) => context.after(callback));
        const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-wip-unlink-parent-outside-'));
        context.after(() => fs.rmSync(outsideRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
        const relativeTargetPath = 'cleanup/new.ts';
        const targetPath = path.join(repoRoot, relativeTargetPath);
        const parentPath = path.dirname(targetPath);
        const movedParentPath = path.join(outsideRoot, 'moved-cleanup');
        const movedTargetPath = path.join(movedParentPath, 'new.ts');
        const outsideTargetPath = path.join(outsideRoot, 'new.ts');
        writeFile(repoRoot, relativeTargetPath, 'created by restore\n');
        fs.writeFileSync(outsideTargetPath, 'external file must remain\n', 'utf8');
        const identity = fs.lstatSync(targetPath);
        const originalUnlinkSync = mutableFs.unlinkSync;
        let parentReplaced = false;
        context.mock.method(mutableFs, 'unlinkSync', (filePath: fs.PathLike) => {
            if (!parentReplaced) {
                parentReplaced = true;
                fs.renameSync(parentPath, movedParentPath);
                fs.symlinkSync(outsideRoot, parentPath, 'dir');
            }
            return originalUnlinkSync(filePath);
        });

        try {
            removeRepoFileIfIdentityMatches(repoRoot, relativeTargetPath, identity);
            assert.equal(parentReplaced, true);
            assert.equal(fs.existsSync(movedTargetPath), false);
            assert.equal(fs.readFileSync(outsideTargetPath, 'utf8'), 'external file must remain\n');
        } finally {
            try {
                if (fs.lstatSync(parentPath).isSymbolicLink()) {
                    fs.unlinkSync(parentPath);
                }
            } catch (error: unknown) {
                assert.equal((error as NodeJS.ErrnoException).code, 'ENOENT');
            }
            if (!fs.existsSync(parentPath) && fs.existsSync(movedParentPath)) {
                fs.renameSync(movedParentPath, parentPath);
            }
        }
    });

    it('preserves a replaced final component instead of unlinking it', {
        skip: process.platform === 'win32' ? 'Windows prevents replacing an open file.' : false
    }, (context) => {
        const repoRoot = makeRepo((callback) => context.after(callback));
        const relativeTargetPath = 'cleanup/replaced.ts';
        const targetPath = path.join(repoRoot, relativeTargetPath);
        const relocatedOriginalPath = path.join(repoRoot, 'cleanup', 'original.ts');
        const originalContent = 'authenticated original\n';
        const replacementContent = 'concurrent replacement must survive\n';
        writeFile(repoRoot, relativeTargetPath, originalContent);
        const identity = fs.lstatSync(targetPath);
        const originalRenameSync = mutableFs.renameSync;
        let preservedReplacementPath: string | null = null;
        context.mock.method(mutableFs, 'renameSync', (
            oldPath: fs.PathLike,
            newPath: fs.PathLike
        ) => {
            if (preservedReplacementPath === null
                && path.basename(String(oldPath)) === path.basename(targetPath)
                && path.basename(path.dirname(String(newPath))).startsWith('.garda-restore-remove-')) {
                originalRenameSync(targetPath, relocatedOriginalPath);
                fs.writeFileSync(targetPath, replacementContent, 'utf8');
                preservedReplacementPath = path.join(
                    fs.realpathSync.native(path.dirname(String(newPath))),
                    path.basename(String(newPath))
                );
            }
            return originalRenameSync(oldPath, newPath);
        });

        assert.throws(
            () => removeRepoFileIfIdentityMatches(repoRoot, relativeTargetPath, identity),
            /restore target identity changed during removal; replacement preserved at/u
        );
        assert.ok(preservedReplacementPath);
        assert.equal(fs.readFileSync(relocatedOriginalPath, 'utf8'), originalContent);
        assert.equal(fs.readFileSync(preservedReplacementPath, 'utf8'), replacementContent);
    });

    it('rejects handoff replacement when the verified preimage is concurrently replaced', (context) => {
        const repoRoot = makeRepo((callback) => context.after(callback));
        const relativeHandoffPath = 'handoff/restore.json';
        const handoffPath = path.join(repoRoot, relativeHandoffPath);
        const preparedHandoff: SplitRequiredWipRestoreHandoff = {
            schema_version: 1,
            kind: 'split_required_wip_restore_handoff',
            status: 'prepared',
            handoff_id: 'handoff-concurrent-replacement',
            repo_root: repoRoot,
            task_id: TASK_ID,
            manifest_path: path.join(repoRoot, 'manifest.json'),
            manifest_sha256: '0'.repeat(64),
            selected_paths: [],
            restored_files: [],
            timeline_anchor: {
                matching_events: 0,
                parse_errors: 0,
                last_integrity_sequence: null,
                last_event_sha256: null
            },
            created_at_utc: '2026-09-02T00:00:00.000Z'
        };
        const pendingHandoff: SplitRequiredWipRestoreHandoff = {
            ...preparedHandoff,
            status: 'pending',
            restored_file_evidence: [],
            workspace_state_sha256: '1'.repeat(64)
        };
        const concurrentHandoff: SplitRequiredWipRestoreHandoff = {
            ...pendingHandoff,
            status: 'finalized',
            finalized_at_utc: '2026-09-02T00:01:00.000Z'
        };
        writeFile(repoRoot, relativeHandoffPath, `${JSON.stringify(preparedHandoff, null, 2)}\n`);
        const originalLstatSync = mutableFs.lstatSync;
        let targetLstatCount = 0;
        context.mock.method(mutableFs, 'lstatSync', (filePath: fs.PathLike) => {
            if (path.resolve(String(filePath)) === path.resolve(handoffPath)) {
                targetLstatCount += 1;
                if (targetLstatCount === 4) {
                    fs.writeFileSync(handoffPath, `${JSON.stringify(concurrentHandoff, null, 2)}\n`, 'utf8');
                }
            }
            return originalLstatSync(filePath);
        });

        assert.throws(
            () => replaceSplitRequiredWipRestoreHandoff(
                handoffPath,
                pendingHandoff,
                preparedHandoff
            ),
            /restore target identity changed before replacement/u
        );
        assert.deepEqual(
            JSON.parse(fs.readFileSync(handoffPath, 'utf8')),
            concurrentHandoff
        );
    });

    it('serializes a competing handoff commit in the final replacement window', (context) => {
        const repoRoot = makeRepo((callback) => context.after(callback));
        const relativeHandoffPath = 'handoff/restore.json';
        const handoffPath = path.join(repoRoot, relativeHandoffPath);
        const preparedHandoff: SplitRequiredWipRestoreHandoff = {
            schema_version: 1,
            kind: 'split_required_wip_restore_handoff',
            status: 'prepared',
            handoff_id: 'handoff-serialized-commit',
            repo_root: repoRoot,
            task_id: TASK_ID,
            manifest_path: path.join(repoRoot, 'manifest.json'),
            manifest_sha256: '0'.repeat(64),
            selected_paths: [],
            restored_files: [],
            timeline_anchor: {
                matching_events: 0,
                parse_errors: 0,
                last_integrity_sequence: null,
                last_event_sha256: null
            },
            created_at_utc: '2026-09-02T00:00:00.000Z'
        };
        const pendingHandoff: SplitRequiredWipRestoreHandoff = {
            ...preparedHandoff,
            status: 'pending',
            restored_file_evidence: [],
            workspace_state_sha256: '1'.repeat(64)
        };
        const competingHandoff: SplitRequiredWipRestoreHandoff = {
            ...pendingHandoff,
            workspace_state_sha256: '2'.repeat(64)
        };
        writeFile(repoRoot, relativeHandoffPath, `${JSON.stringify(preparedHandoff, null, 2)}\n`);
        const originalRenameSync = mutableFs.renameSync;
        let competingError: unknown = null;
        context.mock.method(mutableFs, 'renameSync', (
            oldPath: fs.PathLike,
            newPath: fs.PathLike
        ) => {
            if (competingError === null
                && path.resolve(String(oldPath)) === path.resolve(handoffPath)
                && String(newPath).includes('.garda-replace-displaced-')) {
                try {
                    replaceSplitRequiredWipRestoreHandoff(
                        handoffPath,
                        competingHandoff,
                        preparedHandoff
                    );
                } catch (error: unknown) {
                    competingError = error;
                }
            }
            return originalRenameSync(oldPath, newPath);
        });

        replaceSplitRequiredWipRestoreHandoff(
            handoffPath,
            pendingHandoff,
            preparedHandoff
        );

        assert.ok(competingError instanceof Error);
        assert.match(competingError.message, /restore target replacement is already in progress/u);
        assert.deepEqual(JSON.parse(fs.readFileSync(handoffPath, 'utf8')), pendingHandoff);
        assert.deepEqual(
            fs.readdirSync(path.dirname(handoffPath)).sort(),
            [path.basename(handoffPath)]
        );
    });

    it('preserves an uncoordinated handoff written in the final commit window', (context) => {
        const repoRoot = makeRepo((callback) => context.after(callback));
        const relativeHandoffPath = 'handoff/restore.json';
        const handoffPath = path.join(repoRoot, relativeHandoffPath);
        const preparedHandoff: SplitRequiredWipRestoreHandoff = {
            schema_version: 1,
            kind: 'split_required_wip_restore_handoff',
            status: 'prepared',
            handoff_id: 'handoff-no-clobber-commit',
            repo_root: repoRoot,
            task_id: TASK_ID,
            manifest_path: path.join(repoRoot, 'manifest.json'),
            manifest_sha256: '0'.repeat(64),
            selected_paths: [],
            restored_files: [],
            timeline_anchor: {
                matching_events: 0,
                parse_errors: 0,
                last_integrity_sequence: null,
                last_event_sha256: null
            },
            created_at_utc: '2026-09-02T00:00:00.000Z'
        };
        const pendingHandoff: SplitRequiredWipRestoreHandoff = {
            ...preparedHandoff,
            status: 'pending',
            restored_file_evidence: [],
            workspace_state_sha256: '1'.repeat(64)
        };
        const concurrentHandoff: SplitRequiredWipRestoreHandoff = {
            ...pendingHandoff,
            status: 'finalized',
            finalized_at_utc: '2026-09-02T00:02:00.000Z'
        };
        const originalContent = `${JSON.stringify(preparedHandoff, null, 2)}\n`;
        const concurrentContent = `${JSON.stringify(concurrentHandoff, null, 2)}\n`;
        writeFile(repoRoot, relativeHandoffPath, originalContent);
        const originalLinkSync = mutableFs.linkSync;
        let competingWriteCommitted = false;
        context.mock.method(mutableFs, 'linkSync', (
            existingPath: fs.PathLike,
            newPath: fs.PathLike
        ) => {
            if (!competingWriteCommitted
                && String(existingPath).includes('.garda-replace-')
                && path.resolve(String(newPath)) === path.resolve(handoffPath)) {
                competingWriteCommitted = true;
                fs.writeFileSync(handoffPath, concurrentContent, 'utf8');
            }
            return originalLinkSync(existingPath, newPath);
        });

        assert.throws(
            () => replaceSplitRequiredWipRestoreHandoff(
                handoffPath,
                pendingHandoff,
                preparedHandoff
            ),
            /restore target appeared during replacement/u
        );
        assert.equal(competingWriteCommitted, true);
        assert.equal(fs.readFileSync(handoffPath, 'utf8'), concurrentContent);
        const recoveryDirectories = fs.readdirSync(path.dirname(handoffPath), {
            withFileTypes: true
        }).filter((entry) => entry.isDirectory()
            && entry.name.startsWith('.garda-replace-displaced-'));
        assert.equal(recoveryDirectories.length, 1);
        const recoveryDirectory = recoveryDirectories[0];
        assert.ok(recoveryDirectory);
        assert.equal(
            fs.readFileSync(path.join(
                path.dirname(handoffPath),
                recoveryDirectory.name,
                path.basename(handoffPath)
            ), 'utf8'),
            originalContent
        );
    });

    it('rejects a replaced temporary source before accepting its no-clobber link', {
        skip: process.platform === 'win32'
            ? 'Windows prevents replacing an open staging file.'
            : false
    }, (context) => {
        const repoRoot = makeRepo((callback) => context.after(callback));
        const relativePath = 'handoff/source-race.json';
        const targetPath = path.join(repoRoot, relativePath);
        const originalContent = 'authenticated original\n';
        const replacementContent = Buffer.from('authenticated replacement\n', 'utf8');
        const forgedContent = 'forged temporary source\n';
        writeFile(repoRoot, relativePath, originalContent);
        const expected = readAuthenticatedRepoFileSnapshot(repoRoot, relativePath);
        const originalLinkSync = mutableFs.linkSync;
        let sourceReplaced = false;
        context.mock.method(mutableFs, 'linkSync', (
            existingPath: fs.PathLike,
            newPath: fs.PathLike
        ) => {
            const sourcePath = String(existingPath);
            if (!sourceReplaced
                && sourcePath.includes('.garda-replace-')
                && !sourcePath.includes('.garda-replace-displaced-')
                && path.resolve(String(newPath)) === path.resolve(targetPath)) {
                sourceReplaced = true;
                fs.renameSync(sourcePath, `${sourcePath}.captured`);
                fs.writeFileSync(sourcePath, forgedContent, 'utf8');
            }
            return originalLinkSync(existingPath, newPath);
        });

        assert.throws(
            () => replaceAuthenticatedRepoFile(
                repoRoot,
                relativePath,
                replacementContent,
                expected
            ),
            /replacement staging source changed during authenticated no-clobber link/u
        );
        assert.equal(sourceReplaced, true);
        assert.equal(fs.readFileSync(targetPath, 'utf8'), originalContent);
        assert.notEqual(fs.readFileSync(targetPath, 'utf8'), forgedContent);
    });

    it('removes a forged target when the temporary source is replaced twice during linking', {
        skip: process.platform === 'win32'
            ? 'Windows prevents replacing an open staging file.'
            : false
    }, (context) => {
        const repoRoot = makeRepo((callback) => context.after(callback));
        const relativePath = 'handoff/double-source-race.json';
        const targetPath = path.join(repoRoot, relativePath);
        const originalContent = 'authenticated original\n';
        const firstForgedContent = 'first forged temporary source\n';
        const secondForgedContent = 'second forged temporary source\n';
        writeFile(repoRoot, relativePath, originalContent);
        const expected = readAuthenticatedRepoFileSnapshot(repoRoot, relativePath);
        const originalLinkSync = mutableFs.linkSync;
        let sourceReplacedTwice = false;
        context.mock.method(mutableFs, 'linkSync', (
            existingPath: fs.PathLike,
            newPath: fs.PathLike
        ) => {
            const sourcePath = String(existingPath);
            if (!sourceReplacedTwice
                && sourcePath.includes('.garda-replace-')
                && !sourcePath.includes('.garda-replace-displaced-')
                && path.resolve(String(newPath)) === path.resolve(targetPath)) {
                fs.renameSync(sourcePath, `${sourcePath}.authenticated`);
                fs.writeFileSync(sourcePath, firstForgedContent, 'utf8');
                originalLinkSync(sourcePath, newPath);
                fs.renameSync(sourcePath, `${sourcePath}.linked`);
                fs.writeFileSync(sourcePath, secondForgedContent, 'utf8');
                sourceReplacedTwice = true;
                return;
            }
            originalLinkSync(existingPath, newPath);
        });

        assert.throws(
            () => replaceAuthenticatedRepoFile(
                repoRoot,
                relativePath,
                Buffer.from('authenticated replacement\n', 'utf8'),
                expected
            ),
            /replacement staging source changed during authenticated no-clobber link/u
        );
        assert.equal(sourceReplacedTwice, true);
        assert.equal(fs.readFileSync(targetPath, 'utf8'), originalContent);
        assert.notEqual(fs.readFileSync(targetPath, 'utf8'), firstForgedContent);
        assert.notEqual(fs.readFileSync(targetPath, 'utf8'), secondForgedContent);
    });

    it('preserves a concurrent target replacement after an authenticated link', {
        skip: process.platform === 'win32'
            ? 'Windows prevents replacing an open linked staging file.'
            : false
    }, (context) => {
        const repoRoot = makeRepo((callback) => context.after(callback));
        const relativePath = 'handoff/target-race.json';
        const targetPath = path.join(repoRoot, relativePath);
        const linkedTargetPath = `${targetPath}.authenticated-link`;
        const originalContent = 'authenticated original\n';
        const concurrentContent = 'concurrent target replacement\n';
        writeFile(repoRoot, relativePath, originalContent);
        const expected = readAuthenticatedRepoFileSnapshot(repoRoot, relativePath);
        const originalLinkSync = mutableFs.linkSync;
        let targetReplaced = false;
        context.mock.method(mutableFs, 'linkSync', (
            existingPath: fs.PathLike,
            newPath: fs.PathLike
        ) => {
            originalLinkSync(existingPath, newPath);
            if (!targetReplaced
                && String(existingPath).includes('.garda-replace-')
                && !String(existingPath).includes('.garda-replace-displaced-')
                && path.resolve(String(newPath)) === path.resolve(targetPath)) {
                fs.renameSync(newPath, linkedTargetPath);
                fs.writeFileSync(newPath, concurrentContent, 'utf8');
                targetReplaced = true;
            }
        });

        assert.throws(
            () => replaceAuthenticatedRepoFile(
                repoRoot,
                relativePath,
                Buffer.from('authenticated replacement\n', 'utf8'),
                expected
            ),
            /target changed after authenticated no-clobber link.*authenticated preimage preserved/u
        );
        assert.equal(targetReplaced, true);
        assert.equal(fs.readFileSync(targetPath, 'utf8'), concurrentContent);
        assert.equal(fs.readFileSync(linkedTargetPath, 'utf8'), 'authenticated replacement\n');
    });

    it('rejects a replaced displaced source during pre-commit compensation', {
        skip: process.platform === 'win32'
            ? 'Windows prevents replacing an open displaced file.'
            : false
    }, (context) => {
        const repoRoot = makeRepo((callback) => context.after(callback));
        const relativePath = 'handoff/displaced-source-race.json';
        const targetPath = path.join(repoRoot, relativePath);
        const originalContent = 'authenticated original\n';
        const forgedContent = 'forged displaced source\n';
        writeFile(repoRoot, relativePath, originalContent);
        const expected = readAuthenticatedRepoFileSnapshot(repoRoot, relativePath);
        const originalLinkSync = mutableFs.linkSync;
        let commitFailureInjected = false;
        let displacedSourceReplaced = false;
        context.mock.method(mutableFs, 'linkSync', (
            existingPath: fs.PathLike,
            newPath: fs.PathLike
        ) => {
            const sourcePath = String(existingPath);
            if (!commitFailureInjected
                && sourcePath.includes('.garda-replace-')
                && !sourcePath.includes('.garda-replace-displaced-')
                && path.resolve(String(newPath)) === path.resolve(targetPath)) {
                commitFailureInjected = true;
                throw new Error('simulated commit link failure');
            }
            if (!displacedSourceReplaced
                && sourcePath.includes('.garda-replace-displaced-')
                && path.resolve(String(newPath)) === path.resolve(targetPath)) {
                displacedSourceReplaced = true;
                fs.renameSync(sourcePath, `${sourcePath}.captured`);
                fs.writeFileSync(sourcePath, forgedContent, 'utf8');
            }
            return originalLinkSync(existingPath, newPath);
        });

        assert.throws(
            () => replaceAuthenticatedRepoFile(
                repoRoot,
                relativePath,
                Buffer.from('authenticated replacement\n', 'utf8'),
                expected
            ),
            /displaced preimage source changed during authenticated no-clobber link.*rollback preserved/u
        );
        assert.equal(commitFailureInjected, true);
        assert.equal(displacedSourceReplaced, true);
        assert.equal(fs.existsSync(targetPath), false);
        const rollbackPath = fs.readdirSync(path.dirname(targetPath))
            .map((entry) => path.join(path.dirname(targetPath), entry))
            .find((entry) => entry.includes('.garda-rollback-'));
        assert.ok(rollbackPath);
        assert.equal(fs.readFileSync(rollbackPath, 'utf8'), originalContent);
    });

    it('rejects a replaced rollback source during post-commit compensation', {
        skip: process.platform === 'win32'
            ? 'Windows prevents replacing an open rollback file.'
            : false
    }, (context) => {
        const repoRoot = makeRepo((callback) => context.after(callback));
        const relativePath = 'handoff/rollback-source-race.json';
        const targetPath = path.join(repoRoot, relativePath);
        const originalContent = 'authenticated original\n';
        const forgedContent = 'forged rollback source\n';
        writeFile(repoRoot, relativePath, originalContent);
        const expected = readAuthenticatedRepoFileSnapshot(repoRoot, relativePath);
        const originalLinkSync = mutableFs.linkSync;
        const originalUnlinkSync = mutableFs.unlinkSync;
        let postCommitFailureInjected = false;
        let rollbackSourceReplaced = false;
        context.mock.method(mutableFs, 'unlinkSync', (filePath: fs.PathLike) => {
            const candidatePath = String(filePath);
            if (!postCommitFailureInjected
                && candidatePath.includes('.garda-replace-')
                && !candidatePath.includes('.garda-replace-displaced-')
                && !candidatePath.endsWith('.garda-replace.lock')) {
                postCommitFailureInjected = true;
                throw new Error('simulated post-commit cleanup failure');
            }
            return originalUnlinkSync(filePath);
        });
        context.mock.method(mutableFs, 'linkSync', (
            existingPath: fs.PathLike,
            newPath: fs.PathLike
        ) => {
            const sourcePath = String(existingPath);
            if (!rollbackSourceReplaced
                && sourcePath.includes('.garda-rollback-')
                && path.resolve(String(newPath)) === path.resolve(targetPath)) {
                rollbackSourceReplaced = true;
                fs.renameSync(sourcePath, `${sourcePath}.captured`);
                fs.writeFileSync(sourcePath, forgedContent, 'utf8');
            }
            return originalLinkSync(existingPath, newPath);
        });

        assert.throws(
            () => replaceAuthenticatedRepoFile(
                repoRoot,
                relativePath,
                Buffer.from('authenticated replacement\n', 'utf8'),
                expected
            ),
            /rollback staging source changed during authenticated no-clobber link.*authenticated preimage preserved/u
        );
        assert.equal(postCommitFailureInjected, true);
        assert.equal(rollbackSourceReplaced, true);
        assert.equal(fs.existsSync(targetPath), false);
        const recoveryDirectory = fs.readdirSync(path.dirname(targetPath), {
            withFileTypes: true
        }).find((entry) => entry.isDirectory()
            && entry.name.startsWith('.garda-replace-displaced-'));
        assert.ok(recoveryDirectory);
        assert.equal(
            fs.readFileSync(path.join(
                path.dirname(targetPath),
                recoveryDirectory.name,
                path.basename(targetPath)
            ), 'utf8'),
            originalContent
        );
    });

    it('fails interrupted atomic handoff promotion and preserves the prepared artifact', (context) => {
        const repoRoot = makeRepo((callback) => context.after(callback));
        const relativeHandoffPath = 'handoff/restore.json';
        const handoffPath = path.join(repoRoot, relativeHandoffPath);
        const preparedHandoff: SplitRequiredWipRestoreHandoff = {
            schema_version: 1,
            kind: 'split_required_wip_restore_handoff',
            status: 'prepared',
            handoff_id: 'handoff-interrupted-promotion',
            repo_root: repoRoot,
            task_id: TASK_ID,
            manifest_path: path.join(repoRoot, 'manifest.json'),
            manifest_sha256: '0'.repeat(64),
            selected_paths: [],
            restored_files: [],
            timeline_anchor: {
                matching_events: 0,
                parse_errors: 0,
                last_integrity_sequence: null,
                last_event_sha256: null
            },
            created_at_utc: '2026-09-02T00:00:00.000Z'
        };
        const pendingHandoff: SplitRequiredWipRestoreHandoff = {
            ...preparedHandoff,
            status: 'pending',
            restored_file_evidence: [],
            workspace_state_sha256: '1'.repeat(64)
        };
        const originalContent = `${JSON.stringify(preparedHandoff, null, 2)}\n`;
        writeFile(repoRoot, relativeHandoffPath, originalContent);
        const originalLinkSync = mutableFs.linkSync;
        context.mock.method(mutableFs, 'linkSync', (
            existingPath: fs.PathLike,
            newPath: fs.PathLike
        ) => {
            if (String(existingPath).includes('.garda-replace-')
                && !String(existingPath).includes('.garda-replace-displaced-')
                && path.basename(String(newPath)) === path.basename(handoffPath)) {
                throw new Error('simulated process interruption before atomic commit');
            }
            return originalLinkSync(existingPath, newPath);
        });

        assert.throws(
            () => replaceSplitRequiredWipRestoreHandoff(
                handoffPath,
                pendingHandoff,
                preparedHandoff
            ),
            /simulated process interruption before atomic commit/u
        );
        assert.equal(fs.readFileSync(handoffPath, 'utf8'), originalContent);
        assert.deepEqual(
            fs.readdirSync(path.dirname(handoffPath)).sort(),
            [path.basename(handoffPath)]
        );
    });

    it('rejects authenticated descriptor read when the source grows beyond the bounded snapshot', (context) => {
        const repoRoot = makeRepo((callback) => context.after(callback));
        const relativeTargetPath = 'src/bounded-read.txt';
        const targetPath = path.join(repoRoot, relativeTargetPath);
        const originalContent = Buffer.from('bounded\n', 'utf8');
        const appendedContent = Buffer.alloc(1024 * 1024, 0x61);
        writeFile(repoRoot, relativeTargetPath, originalContent.toString('utf8'));
        const originalReadSync = mutableFs.readSync;
        let requestedLength: number | null = null;
        let sourceGrown = false;
        context.mock.method(mutableFs, 'readSync', (
            descriptor: number,
            buffer: Buffer,
            offset: number,
            length: number,
            position: number | null
        ): number => {
            requestedLength ??= length;
            if (!sourceGrown) {
                sourceGrown = true;
                fs.appendFileSync(targetPath, appendedContent);
            }
            return originalReadSync(descriptor, buffer, offset, length, position);
        });

        assert.throws(
            () => readAuthenticatedRepoFileSnapshot(
                repoRoot,
                relativeTargetPath,
                originalContent.length + 1
            ),
            /restore target changed while capturing rollback bytes/u
        );
        assert.equal(sourceGrown, true);
        assert.equal(requestedLength, originalContent.length);
        assert.equal(fs.statSync(targetPath).size, originalContent.length + appendedContent.length);
    });

    it('rejects dangling symlinks even when their targets do not exist', (context) => {
        const repoRoot = makeRepo((callback) => context.after(callback));
        const linkPath = path.join(repoRoot, 'src', 'dangling.ts');
        fs.symlinkSync(
            path.join(repoRoot, 'missing-symlink-target'),
            linkPath,
            process.platform === 'win32' ? 'junction' : 'file'
        );

        assert.equal(fs.existsSync(linkPath), false);
        assert.equal(fs.lstatSync(linkPath).isSymbolicLink(), true);
        assert.deepEqual(
            validateNoSymlinkPath(repoRoot, 'src/dangling.ts'),
            ['selected restore path contains a symbolic link: src/dangling.ts']
        );
    });

    it('blocks ordinary untracked restore through a symlinked ancestor', (context) => {
        const repoRoot = makeRepo((callback) => context.after(callback));
        const externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-wip-restore-external-'));
        context.after(() => fs.rmSync(externalRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
        writeFile(repoRoot, 'src/linked/new.ts', 'export const escaped = true;\n');
        const captured = captureAndSuspendSplitRequiredWip({
            repoRoot,
            taskId: TASK_ID,
            preflightPath: writePreflight(repoRoot, ['src/linked/new.ts']),
            guardKind: 'scope_budget',
            guardReason: 'ordinary restore symlink boundary'
        });
        assert.equal(captured.status, 'CAPTURED', captured.violations.join('\n'));
        assert.ok(captured.manifest_path);
        fs.rmSync(path.join(repoRoot, 'src', 'linked'), { recursive: true, force: true });
        fs.symlinkSync(
            externalRoot,
            path.join(repoRoot, 'src', 'linked'),
            process.platform === 'win32' ? 'junction' : 'dir'
        );

        const restored = restoreSplitRequiredWip({
            repoRoot,
            taskId: TASK_ID,
            manifestPath: captured.manifest_path
        });

        assert.equal(restored.status, 'BLOCKED');
        assert.ok(restored.violations.some((violation) => violation.includes('symbolic link')));
        assert.equal(fs.existsSync(path.join(externalRoot, 'new.ts')), false);
    });

    it('requires an authenticated untracked artifact snapshot before advanced restore apply', (context) => {
        const repoRoot = makeRepo((callback) => context.after(callback));
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-wip-plan-artifact-'));
        context.after(() => fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
        const artifactPath = path.join(
            repoRoot,
            'garda-agent-orchestrator',
            'runtime',
            'wip',
            'new.ts'
        );
        writeFile(repoRoot, path.relative(repoRoot, artifactPath), 'export const original = true;\n');
        const expectedSha256 = sha256(artifactPath);
        fs.writeFileSync(artifactPath, 'export const tampered = true;\n', 'utf8');
        const gitIndexPath = runGit(repoRoot, ['rev-parse', '--git-path', 'index']).trim();
        const indexPath = path.isAbsolute(gitIndexPath)
            ? path.resolve(gitIndexPath)
            : path.resolve(repoRoot, gitIndexPath);
        const originalIndexSha256 = sha256(indexPath);
        const targetPath = path.join(repoRoot, 'src', 'new.ts');
        const untrackedFile: SplitRequiredWipUntrackedFileEvidence = {
            path: 'src/new.ts',
            artifact_path: artifactPath,
            sha256: expectedSha256,
            bytes: Buffer.byteLength('export const original = true;\n')
        };

        const violations = applyAdvancedRestorePlan(repoRoot, {
            tempRoot,
            candidateIndexPath: indexPath,
            candidateWorktreeRoot: path.join(tempRoot, 'worktree'),
            currentHead: runGit(repoRoot, ['rev-parse', 'HEAD']).trim(),
            currentIndexSha256: originalIndexSha256,
            targetSha256: new Map([['src/new.ts', null]])
        }, [], [untrackedFile]);

        assert.equal(violations.length, 1);
        assert.match(violations[0], /^three-way restore failed without retained mutations:/u);
        assert.match(violations[0], /authenticated untracked artifact snapshot is missing/u);
        assert.equal(fs.existsSync(targetPath), false);
        assert.equal(sha256(indexPath), originalIndexSha256);
        assert.deepEqual(
            fs.readdirSync(path.dirname(targetPath)).filter((name) => name.includes('.garda-')),
            []
        );
    });

    it('reports a stable patch failure without mutating the suspended workspace', (context) => {
        const repoRoot = makeRepo((callback) => context.after(callback));
        writeFile(repoRoot, 'src/a.ts', 'export const a = 2;\n');
        runGit(repoRoot, ['add', 'src/a.ts']);
        const captured = captureAndSuspendSplitRequiredWip({
            repoRoot,
            taskId: TASK_ID,
            preflightPath: writePreflight(repoRoot, ['src/a.ts']),
            guardKind: 'scope_budget',
            guardReason: 'restore plan characterization'
        });
        assert.equal(captured.status, 'CAPTURED', captured.violations.join('\n'));
        assert.ok(captured.manifest_path);
        const manifest = JSON.parse(fs.readFileSync(captured.manifest_path, 'utf8')) as SplitRequiredWipManifest;
        const patchPath = manifest.patches.staged.path;
        fs.writeFileSync(patchPath, 'not a patch\n', 'utf8');
        manifest.patches.staged.sha256 = sha256(patchPath);
        manifest.patches.staged.bytes = fs.statSync(patchPath).size;
        manifest.patches.staged.empty = false;
        fs.writeFileSync(captured.manifest_path, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

        const restored = restoreSplitRequiredWip({
            repoRoot,
            taskId: TASK_ID,
            manifestPath: captured.manifest_path
        });

        assert.equal(restored.status, 'BLOCKED');
        assert.deepEqual(restored.restored_files, []);
        assert.equal(restored.violations.length, 1);
        assert.match(restored.violations[0], /^patch restore failed:/u);
        assert.equal(runGit(repoRoot, ['status', '--short']).trim(), '');
    });
});
