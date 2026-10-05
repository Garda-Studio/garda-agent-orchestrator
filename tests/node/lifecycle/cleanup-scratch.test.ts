import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import fsNative from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as contained from '../../../src/core/contained-filesystem';
import * as scratchPreview from '../../../src/lifecycle/cleanup/cleanup-scratch-preview';
import { previewStaleScratchCleanup, removeStaleScratch, registerScratchWriter,
    runGc, runTaskRuntimePurge, runTaskRuntimeBatchPurge } from '../../../src/lifecycle/cleanup';
import { resolveScratchWriterLocations } from '../../../src/lifecycle/cleanup/scratch-writer-ownership';
import { processCleanupCandidates } from '../../../src/lifecycle/cleanup/cleanup-removal';
import { writeTaskQueue } from './cleanup-fixtures';

describe('confirmed stale scratch cleanup', () => {
    let targetRoot: string;
    let bundleRoot: string;
    let cutoffUtc: string;
    let deadPid: number;
    const realKill = process.kill.bind(process);
    beforeEach(() => {
        targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-scratch-cleanup-'));
        bundleRoot = path.join(targetRoot, 'garda-agent-orchestrator');
        fs.mkdirSync(bundleRoot);
        fs.writeFileSync(path.join(bundleRoot, 'VERSION'), '1.0.0\n');
        cutoffUtc = new Date(Date.now() - 2 * 86400000).toISOString();
        const exited = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
        assert.equal(exited.status, 0); deadPid = exited.pid;
        mock.method(process, 'kill', (pid: number, signal?: NodeJS.Signals | number) => {
            if (pid === deadPid) throw Object.assign(new Error('known dead local fixture'), { code: 'ESRCH' });
            return realKill(pid, signal);
        });
    });
    afterEach(() => {
        mock.restoreAll();
        fs.rmSync(targetRoot, { recursive: true, force: true });
    });
    const selection = (scratchNames = ['worker-cache']) => ({ targetRoot, bundleRoot, scratchNames, cutoffUtc });
    function locations(scratchName = 'worker-cache') {
        return resolveScratchWriterLocations({ targetRoot, bundleRoot, scratchName });
    }
    function ownerChange(changes: Record<string, unknown>, scratchName = 'worker-cache'): void {
        const ownerPath = locations(scratchName).ownerPath;
        fs.writeFileSync(ownerPath, JSON.stringify({ ...JSON.parse(fs.readFileSync(ownerPath, 'utf8')), ...changes }));
    }
    function ageTree(root: string): void {
        const old = new Date(Date.now() - 4 * 86400000);
        for (const entry of fs.readdirSync(root)) {
            const member = path.join(root, entry);
            if (fs.lstatSync(member).isDirectory()) ageTree(member);
            else fs.utimesSync(member, old, old);
        }
        fs.utimesSync(root, old, old);
    }
    function stale(scratchName = 'worker-cache'): string {
        const registration = registerScratchWriter({ targetRoot, bundleRoot, scratchName });
        fs.mkdirSync(path.join(registration.scratchPath, 'nested'));
        fs.writeFileSync(path.join(registration.scratchPath, 'a.txt'), 'first');
        fs.writeFileSync(path.join(registration.scratchPath, 'nested', 'b.txt'), 'second');
        ownerChange({ pid: deadPid }, scratchName);
        ageTree(registration.scratchPath);
        return registration.scratchPath;
    }
    function contents(root = targetRoot): unknown {
        return fs.readdirSync(root).sort().map(name => {
            const member = path.join(root, name), stat = fs.lstatSync(member);
            return [name, stat.ino, stat.birthtimeMs, stat.mtimeMs, stat.ctimeMs,
                stat.isSymbolicLink() ? fs.readlinkSync(member)
                    : stat.isDirectory() ? contents(member) : fs.readFileSync(member).toString('hex')];
        });
    }
    function apply(scratchNames = ['worker-cache']) {
        const preview = previewStaleScratchCleanup(selection(scratchNames));
        assert.equal(preview.status, 'READY', preview.blockers.join(' | '));
        assert.ok(preview.ownership_digest);
        return removeStaleScratch({ ...selection(scratchNames), confirmed: true, ownershipDigest: preview.ownership_digest });
    }
    it('blocks cancelled cleanup and keeps preview bytes and directory identities unchanged', () => {
        stale();
        const before = contents();
        const preview = previewStaleScratchCleanup(selection());
        assert.equal(preview.status, 'READY', preview.blockers.join(' | '));
        assert.deepEqual(contents(), before);
        assert.equal(fs.existsSync(locations().lockPath), false);
        const cancelled = removeStaleScratch({ ...selection(), confirmed: false, ownershipDigest: preview.ownership_digest! });
        assert.equal(cancelled.status, 'CONFIRMATION_REQUIRED');
        assert.deepEqual(contents(), before);
    });
    it('removes only the confirmed exact roots and retains writer metadata and unrelated evidence', () => {
        const selected = stale();
        const other = stale('other-cache');
        for (const relative of ['runtime/wip/manifest.json', 'runtime/reviews/T-001-code.md',
            'runtime/metrics.jsonl', 'live/docs/project-memory/compact.md']) {
            const file = path.join(bundleRoot, relative);
            fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'keep');
        }
        const beforeOther = contents(other);
        const result = apply();
        assert.equal(result.status, 'REMOVED', result.errors.join(' | '));
        assert.equal(result.removed_file_count, 2);
        assert.equal(result.removed_bytes, 11);
        assert.equal(result.counts_complete, true);
        assert.equal(fs.existsSync(selected), false);
        assert.deepEqual(contents(other), beforeOther);
        assert.equal(fs.existsSync(locations().ownerPath), true);
        assert.equal(fs.readFileSync(path.join(bundleRoot, 'runtime', 'metrics.jsonl'), 'utf8'), 'keep');
        assert.equal(fs.readFileSync(path.join(bundleRoot, 'runtime', 'wip', 'manifest.json'), 'utf8'), 'keep');
    });
    it('invalidates the digest when exact selection, cutoff or full content changes', () => {
        stale(); stale('other-cache');
        const one = previewStaleScratchCleanup(selection(['worker-cache', 'other-cache']));
        const reordered = previewStaleScratchCleanup(selection(['other-cache', 'worker-cache']));
        assert.equal(one.status, 'READY');
        assert.equal(one.ownership_digest, reordered.ownership_digest);
        assert.notEqual(one.ownership_digest, previewStaleScratchCleanup(selection()).ownership_digest);
        assert.notEqual(one.ownership_digest, previewStaleScratchCleanup({ ...selection(['other-cache', 'worker-cache']),
            cutoffUtc: new Date(Date.parse(cutoffUtc) - 86400000).toISOString() }).ownership_digest);
        fs.writeFileSync(path.join(locations().scratchPath, 'a.txt'), 'other'); ageTree(locations().scratchPath);
        assert.notEqual(one.ownership_digest, previewStaleScratchCleanup(selection(['worker-cache', 'other-cache'])).ownership_digest);
    });
    for (const condition of ['live', 'unknown', 'missing', 'malformed', 'foreign', 'conflicting'] as const) {
        it(`preserves stale timestamps with ${condition} ownership`, () => {
            const root = stale();
            if (condition === 'live') ownerChange({ pid: process.pid });
            if (condition === 'unknown') mock.method(process, 'kill', () => { throw Object.assign(new Error('unknown'), { code: 'EIO' }); });
            if (condition === 'missing') fs.unlinkSync(locations().ownerPath);
            if (condition === 'malformed') fs.writeFileSync(locations().ownerPath, '{broken');
            if (condition === 'foreign') ownerChange({ hostname: 'foreign-host' });
            if (condition === 'conflicting') ownerChange({ scratch_relative_path: 'tmp/another-root' });
            const before = contents(root);
            const preview = previewStaleScratchCleanup(selection());
            assert.equal(preview.status, 'BLOCKED');
            const expectedOwnerState = { live: 'live', unknown: 'unknown', missing: 'unverifiable',
                malformed: 'unverifiable', foreign: 'foreign', conflicting: 'unverifiable' } as const;
            assert.equal(preview.items[0]?.owner_state, expectedOwnerState[condition]);
            assert.ok(preview.blockers.length > 0);
            assert.deepEqual(contents(root), before);
        });
    }
    it('blocks cleanup when a fresh descendant is beneath an artificially old directory', () => {
        const root = stale();
        fs.writeFileSync(path.join(root, 'nested', 'fresh.txt'), 'fresh');
        const old = new Date(Date.now() - 4 * 86400000);
        fs.utimesSync(root, old, old); fs.utimesSync(path.join(root, 'nested'), old, old);
        const preview = previewStaleScratchCleanup(selection());
        assert.equal(preview.status, 'BLOCKED');
        assert.equal(preview.items[0]?.owner_state, 'dead');
        assert.equal(fs.readFileSync(path.join(root, 'nested', 'fresh.txt'), 'utf8'), 'fresh');
    });
    it('rejects malformed ownership while retaining verified blocked owner states', () => {
        stale('live-cache'); ownerChange({ pid: process.pid }, 'live-cache');
        stale('foreign-cache'); ownerChange({ hostname: 'foreign-host' }, 'foreign-cache');
        const fresh = stale('fresh-cache'); fs.writeFileSync(path.join(fresh, 'new.txt'), 'fresh');
        stale('malformed-cache'); fs.writeFileSync(locations('malformed-cache').ownerPath, '{broken');
        const before = contents();
        const preview = previewStaleScratchCleanup(selection(['live-cache', 'foreign-cache', 'fresh-cache', 'malformed-cache']));
        const item = (name: string) => preview.items.find(value => value.path ===
            path.relative(targetRoot, locations(name).scratchPath).replace(/\\/gu, '/'));
        assert.equal(preview.status, 'BLOCKED');
        assert.equal(item('live-cache')?.owner_state, 'live');
        assert.equal(item('foreign-cache')?.owner_state, 'foreign');
        assert.equal(item('fresh-cache')?.owner_state, 'dead');
        assert.equal(item('malformed-cache')?.owner_state, 'unverifiable');
        assert.equal(preview.items.every(value => value.state === 'protected'), true);
        assert.equal(preview.ownership_digest, null);
        assert.deepEqual(contents(), before);
    });
    it('rejects epoch clamping when every retained mtime is negative', () => {
        const entries = ['1964-01-01T00:00:00.000Z', '1968-01-01T00:00:00.000Z', '1966-01-01T00:00:00.000Z']
            .map(date => ({ mtimeNs: BigInt(Date.parse(date)) * 1000000n }));
        const before = contents();
        assert.equal(scratchPreview.newestScratchMtimeUtc(entries), '1968-01-01T00:00:00.000Z');
        assert.equal(scratchPreview.newestScratchMtimeUtc([...entries].reverse()), '1968-01-01T00:00:00.000Z');
        assert.deepEqual(contents(), before);
    });
    for (const change of ['writer', 'root', 'parent', 'descendant', 'new-file'] as const) {
        it(`rejects ${change} changes after preview before removing anything`, () => {
            const root = stale();
            const preview = previewStaleScratchCleanup(selection());
            assert.equal(preview.status, 'READY');
            if (change === 'writer') registerScratchWriter({ targetRoot, bundleRoot, scratchName: 'worker-cache' });
            if (change === 'root') { fs.renameSync(root, root + '-saved'); fs.mkdirSync(root); fs.writeFileSync(path.join(root, 'foreign.txt'), 'keep'); }
            if (change === 'parent') { fs.renameSync(locations().tmpDir, locations().tmpDir + '-saved'); fs.mkdirSync(locations().tmpDir); fs.mkdirSync(root); }
            if (change === 'descendant') { fs.renameSync(path.join(root, 'a.txt'), path.join(root, 'a.saved')); fs.writeFileSync(path.join(root, 'a.txt'), 'first'); }
            if (change === 'new-file') fs.writeFileSync(path.join(root, 'new.txt'), 'keep');
            const before = contents(root);
            const result = removeStaleScratch({ ...selection(), confirmed: true, ownershipDigest: preview.ownership_digest! });
            assert.equal(result.status, 'INCOMPLETE');
            assert.equal(result.mutation_attempted, false);
            assert.deepEqual(contents(root), before);
        });
    }
    it('rejects a changed complete selection under both locks before its first removal', () => {
        const first = stale('aaa-cache'), second = stale('zzz-cache');
        const chosen = selection(['aaa-cache', 'zzz-cache']);
        const preview = previewStaleScratchCleanup(chosen);
        const original = contained.assertBoundContainedRemovalTree;
        const buildSnapshot = scratchPreview.buildScratchCleanupSnapshot;
        let injected = false, lockedReadySnapshot = false;
        mock.method(scratchPreview, 'buildScratchCleanupSnapshot', (...args: Parameters<typeof buildSnapshot>) => {
            const result = buildSnapshot(...args);
            if (result.preview.status === 'READY' && fs.existsSync(path.join(locations('aaa-cache').lockPath, 'owner.json'))
                && fs.existsSync(path.join(bundleRoot, 'runtime', '.lifecycle-operation.lock', 'owner.json'))) lockedReadySnapshot = true;
            return result;
        });
        mock.method(contained, 'assertBoundContainedRemovalTree', (...args: Parameters<typeof original>) => {
            const writerHeld = fs.existsSync(path.join(locations('aaa-cache').lockPath, 'owner.json'));
            const lifecycleHeld = fs.existsSync(path.join(bundleRoot, 'runtime', '.lifecycle-operation.lock', 'owner.json'));
            if (!injected && lockedReadySnapshot && writerHeld && lifecycleHeld && args[0].path === first) {
                injected = true; fs.writeFileSync(path.join(second, 'new.txt'), 'late');
            }
            return original(...args);
        });
        const result = removeStaleScratch({ ...chosen, confirmed: true, ownershipDigest: preview.ownership_digest! });
        assert.equal(injected, true);
        assert.equal(lockedReadySnapshot, true);
        assert.equal(result.status, 'INCOMPLETE');
        assert.equal(result.mutation_attempted, false);
        assert.equal(fs.readFileSync(path.join(first, 'a.txt'), 'utf8'), 'first');
        assert.equal(fs.readFileSync(path.join(second, 'new.txt'), 'utf8'), 'late');
    });
    it('blocks remaining removal after a writer activates during a partial removal', () => {
        const root = stale();
        const unlink = fsNative.unlinkSync;
        mock.method(fsNative, 'unlinkSync', (file: fs.PathLike) => {
            unlink(file);
            if (String(file) === path.join(root, 'a.txt')) ownerChange({ pid: process.pid });
        });
        const result = apply();
        assert.equal(result.status, 'INCOMPLETE');
        assert.equal(result.removed_file_count, 1);
        assert.equal(fs.readFileSync(path.join(root, 'nested', 'b.txt'), 'utf8'), 'second');
    });
    it('rejects a stale retry after partial errors and requires a fresh preview', () => {
        const root = stale();
        const preview = previewStaleScratchCleanup(selection());
        const unlink = fsNative.unlinkSync;
        mock.method(fsNative, 'unlinkSync', (file: fs.PathLike) => {
            if (String(file) === path.join(root, 'nested', 'b.txt')) throw Object.assign(new Error('fixture denial'), { code: 'EACCES' });
            unlink(file);
        });
        const result = removeStaleScratch({ ...selection(), confirmed: true, ownershipDigest: preview.ownership_digest! });
        assert.equal(result.status, 'INCOMPLETE');
        assert.equal(result.removed_file_count, 1);
        mock.restoreAll();
        mock.method(process, 'kill', (pid: number, signal?: NodeJS.Signals | number) => {
            if (pid === deadPid) throw Object.assign(new Error('dead'), { code: 'ESRCH' });
            return realKill(pid, signal);
        });
        const retry = removeStaleScratch({ ...selection(), confirmed: true, ownershipDigest: preview.ownership_digest! });
        assert.equal(retry.status, 'INCOMPLETE');
        assert.equal(fs.existsSync(path.join(root, 'nested', 'b.txt')), true);
        ageTree(root);
        const retried = spawnSync(process.execPath, ['-e',
            'const cleanup=require(process.argv[1]); const options=JSON.parse(process.argv[2]); const preview=cleanup.previewStaleScratchCleanup(options); process.stdout.write(JSON.stringify(preview.status==="READY" ? cleanup.removeStaleScratch({...options,confirmed:true,ownershipDigest:preview.ownership_digest}) : preview));',
            require.resolve('../../../src/lifecycle/cleanup'), JSON.stringify(selection())], { encoding: 'utf8' });
        assert.equal(retried.status, 0, retried.stderr);
        assert.equal(JSON.parse(retried.stdout).status, 'REMOVED', retried.stdout);
        assert.equal(fs.existsSync(root), false);
    });
    it('rejects linked and task-owned descendants before deletion', () => {
        const root = stale();
        const external = path.join(targetRoot, 'external.txt'); fs.writeFileSync(external, 'keep');
        fs.linkSync(external, path.join(root, 'hardlink.txt'));
        assert.equal(previewStaleScratchCleanup(selection()).status, 'BLOCKED');
        fs.unlinkSync(path.join(root, 'hardlink.txt'));
        const externalDir = path.join(targetRoot, 'outside'); fs.mkdirSync(externalDir);
        fs.writeFileSync(path.join(externalDir, 'keep.txt'), 'keep');
        fs.symlinkSync(externalDir, path.join(root, 'junction'), process.platform === 'win32' ? 'junction' : 'dir');
        assert.equal(previewStaleScratchCleanup(selection()).status, 'BLOCKED');
        fs.unlinkSync(path.join(root, 'junction'));
        fs.writeFileSync(path.join(root, 'T-001-proof.json'), '{}'); ageTree(root);
        assert.equal(previewStaleScratchCleanup(selection()).status, 'BLOCKED');
        assert.equal(fs.readFileSync(external, 'utf8'), 'keep');
        assert.equal(fs.readFileSync(path.join(externalDir, 'keep.txt'), 'utf8'), 'keep');
    });
    it('rejects task or batch purge authority over generic scratch and writer metadata', () => {
        const root = stale();
        writeTaskQueue(targetRoot, [{ id: 'T-001', status: 'DONE', title: 'Done' }]);
        const before = contents(root), owner = fs.readFileSync(locations().ownerPath);
        runTaskRuntimePurge({ targetRoot, bundleRoot, taskId: 'T-001', confirm: true });
        runTaskRuntimeBatchPurge({ targetRoot, bundleRoot, confirm: true, eligibleOlderThanDays: 0, keepLatestTasks: 0 });
        assert.deepEqual(contents(root), before);
        assert.deepEqual(fs.readFileSync(locations().ownerPath), owner);
    });
    it('rejects generic tmp handed to the legacy candidate remover without its own confirmation', () => {
        const root = stale(), before = contents(root);
        const result = processCleanupCandidates([{ path: root, category: 'tmp', reason: 'age', sizeBytes: 11 }],
            false, path.join(bundleRoot, 'runtime'));
        assert.equal(result.removed.length, 0);
        assert.equal(result.errors.length, 1);
        assert.deepEqual(contents(root), before);
    });
    it('rejects category relabeling that targets generic scratch or writer metadata', () => {
        const registration = registerScratchWriter({ targetRoot, bundleRoot, scratchName: 'worker-cache' });
        const payload = path.join(registration.scratchPath, 'payload'); fs.writeFileSync(payload, 'live');
        const runtime = path.join(bundleRoot, 'runtime'), writer = locations();
        const legacy = path.join(writer.tmpDir, 'legacy-cache'); fs.mkdirSync(legacy); fs.writeFileSync(path.join(legacy, 'keep'), 'legacy');
        const orphan = path.join(runtime, 'orphan.partial'); fs.writeFileSync(orphan, 'unowned');
        fs.writeFileSync(writer.lockPath, '{}');
        const allowedCache = path.join(runtime, 'cache', 'obsolete'), allowedTask = path.join(writer.tmpDir, 'T-002');
        for (const root of [allowedCache, allowedTask]) { fs.mkdirSync(root, { recursive: true }); fs.writeFileSync(path.join(root, 'old'), 'old'); }
        const protectedPaths = [payload, registration.scratchPath, legacy, orphan, writer.ownerPath,
            path.dirname(writer.ownerPath), writer.lockPath, writer.tmpDir, runtime];
        const candidates = protectedPaths.flatMap(candidate => ['cache', 'reports', 'tmp'].map(category => ({
            path: candidate, category, reason: 'relabeled-age', sizeBytes: 1
        })));
        const before = contents(), protectedBefore = contents(registration.scratchPath);
        const result = processCleanupCandidates(candidates, false, runtime);
        assert.equal(result.removed.length, 0);
        assert.equal(result.errors.length, candidates.length);
        assert.equal(result.totalFreedBytes, 0);
        assert.deepEqual(contents(), before);
        const allowed = processCleanupCandidates([allowedCache, allowedTask].map(candidate => ({
            path: candidate, category: 'cache', reason: 'explicit-compatible-selection', sizeBytes: 1
        })), false, runtime);
        assert.equal(allowed.errors.length, 0);
        assert.equal(allowed.removed.length, 2);
        assert.equal(fs.existsSync(allowedCache), false);
        assert.equal(fs.existsSync(allowedTask), false);
        assert.deepEqual(contents(registration.scratchPath), protectedBefore);
    });
    it('rejects legacy aliases into registered scratch and writer metadata', () => {
        const registration = registerScratchWriter({ targetRoot, bundleRoot, scratchName: 'worker-cache' });
        fs.writeFileSync(path.join(registration.scratchPath, 'payload'), 'live');
        const runtime = path.join(bundleRoot, 'runtime'), writer = locations(), aliases = path.join(runtime, 'cache');
        fs.mkdirSync(aliases);
        const scratchAlias = path.join(aliases, 'scratch-alias'), writerAlias = path.join(aliases, 'writer-alias');
        const linkType = process.platform === 'win32' ? 'junction' : 'dir';
        fs.symlinkSync(registration.scratchPath, scratchAlias, linkType);
        fs.symlinkSync(path.dirname(writer.ownerPath), writerAlias, linkType);
        const before = contents(registration.scratchPath), owner = fs.readFileSync(writer.ownerPath);
        const result = processCleanupCandidates([path.join(scratchAlias, 'payload'),
            path.join(writerAlias, path.basename(writer.ownerPath))].map(candidate => ({
            path: candidate, category: 'cache', reason: 'internal-alias', sizeBytes: 1
        })), false, runtime);
        assert.equal(result.removed.length, 0);
        assert.equal(result.errors.length, 2);
        assert.deepEqual(contents(registration.scratchPath), before);
        assert.deepEqual(fs.readFileSync(writer.ownerPath), owner);
        assert.equal(fs.lstatSync(scratchAlias).isSymbolicLink(), true);
        assert.equal(fs.lstatSync(writerAlias).isSymbolicLink(), true);
    });
    it('blocks legacy mutation without an explicit runtime root', () => {
        const root = stale(), before = contents(root);
        const result = processCleanupCandidates([{ path: root, category: 'cache', reason: 'missing-root', sizeBytes: 1 }], false);
        assert.equal(result.removed.length, 0);
        assert.equal(result.errors.length, 1);
        assert.equal(result.totalFreedBytes, 0);
        assert.deepEqual(contents(root), before);
    });
    it('rejects workspace and bundle roots passed to the legacy remover', () => {
        const registration = registerScratchWriter({ targetRoot, bundleRoot, scratchName: 'worker-cache' });
        fs.writeFileSync(path.join(registration.scratchPath, 'payload'), 'live');
        const writer = locations();
        const wrongRoots = [targetRoot, bundleRoot];
        const candidates = [registration.scratchPath, writer.ownerPath].flatMap(candidate =>
            ['cache', 'reports'].map(category => ({ path: candidate, category, reason: 'wrong-root-role', sizeBytes: 1 })));
        const before = contents();
        const results = wrongRoots.map(root => processCleanupCandidates(candidates, false, root));
        assert.equal(results.flatMap(result => result.removed).length, 0);
        assert.equal(results.flatMap(result => result.errors).length, candidates.length * wrongRoots.length);
        assert.deepEqual(contents(), before);
    });
    it('rejects missing or nonregular bundle markers and ambiguous runtime roles', () => {
        const runtime = path.join(bundleRoot, 'runtime');
        const version = path.join(bundleRoot, 'VERSION');
        const candidate = path.join(runtime, 'cache', 'payload');
        fs.mkdirSync(path.dirname(candidate), { recursive: true });
        fs.writeFileSync(candidate, 'keep');
        const results = [];
        for (const variant of ['missing-version', 'directory-version', 'shared-version', 'runtime-version', 'runtime-task']) {
            fs.rmSync(version, { recursive: true, force: true });
            if (variant === 'directory-version') fs.mkdirSync(version);
            else if (variant !== 'missing-version') fs.writeFileSync(version, '1.0.0\n');
            if (variant === 'shared-version') fs.linkSync(version, path.join(targetRoot, 'shared-version'));
            const marker = variant === 'runtime-version' ? path.join(runtime, 'VERSION')
                : variant === 'runtime-task' ? path.join(runtime, 'TASK.md') : undefined;
            if (marker) fs.writeFileSync(marker, 'ambiguous');
            results.push(processCleanupCandidates([{ path: candidate, category: 'cache', reason: 'invalid-root', sizeBytes: 4 }], false, runtime));
            if (marker) fs.unlinkSync(marker);
        }
        assert.equal(results.flatMap(result => result.removed).length, 0);
        assert.equal(results.flatMap(result => result.errors).length, 5);
        assert.ok(results.flatMap(result => result.errors).every(error => error.message.includes('canonical bundle runtime root')));
        assert.equal(fs.readFileSync(candidate, 'utf8'), 'keep');
    });
    it('removes ordinary cache from a canonical runtime in a custom bundle', () => {
        const customBundle = path.join(targetRoot, 'custom-bundle');
        const runtime = path.join(customBundle, 'runtime');
        const candidate = path.join(runtime, 'cache', 'payload');
        fs.mkdirSync(path.dirname(candidate), { recursive: true });
        fs.writeFileSync(path.join(customBundle, 'VERSION'), '1.0.0\n');
        fs.writeFileSync(candidate, 'remove');
        const result = processCleanupCandidates([{ path: candidate, category: 'cache', reason: 'old', sizeBytes: 6 }], false, runtime);
        assert.equal(result.errors.length, 0);
        assert.equal(result.removed.length, 1);
        assert.equal(result.totalFreedBytes, 6);
        assert.equal(fs.existsSync(candidate), false);
    });
    it('rejects nested runtime roots within protected scratch namespaces', () => {
        const registration = registerScratchWriter({ targetRoot, bundleRoot, scratchName: 'worker-cache' });
        const runtime = path.join(bundleRoot, 'runtime');
        const parents = [registration.scratchPath, path.join(runtime, 'tmp', 'legacy'),
            path.join(runtime, 'scratch-writers', 'fixture'), path.join(runtime, '.scratch-writers.lock', 'fixture'),
            path.join(runtime, 'orphan.partial')];
        const roots = parents.map(parent => {
            const innerRuntime = path.join(parent, 'runtime');
            fs.mkdirSync(path.join(innerRuntime, 'cache'), { recursive: true });
            fs.writeFileSync(path.join(parent, 'VERSION'), '1.0.0\n');
            return innerRuntime;
        });
        const alias = path.join(runtime, 'cache', 'inner-runtime-alias');
        fs.mkdirSync(path.dirname(alias), { recursive: true });
        fs.symlinkSync(roots[0], alias, 'junction');
        const selections = [...roots, alias].map((root, index) => {
            const candidates = ['cache', 'reports'].map(category => {
                const file = path.join(root, 'cache', `${category}-${index}`);
                fs.writeFileSync(file, 'live payload');
                return { path: file, category, reason: 'nested-root-role', sizeBytes: 12 };
            });
            return { root, candidates };
        });
        const before = contents();
        const results = selections.map(({ root, candidates }) => processCleanupCandidates(candidates, false, root));
        assert.equal(results.flatMap(result => result.removed).length, 0);
        assert.equal(results.flatMap(result => result.errors).length, selections.length * 2);
        assert.ok(results.flatMap(result => result.errors).every(error => error.message.includes('nested in a protected scratch namespace')));
        assert.deepEqual(contents(), before);
        assert.equal(fs.lstatSync(alias).isSymbolicLink(), true);
        assert.equal(JSON.parse(fs.readFileSync(locations().ownerPath, 'utf8')).pid, process.pid);
    });
    it('retains ordinary nested cache runtime roles outside protected namespaces', () => {
        const customBundle = path.join(bundleRoot, 'runtime', 'cache', 'custom-bundle');
        const runtime = path.join(customBundle, 'runtime');
        const candidate = path.join(runtime, 'cache', 'payload');
        fs.mkdirSync(path.dirname(candidate), { recursive: true });
        fs.writeFileSync(path.join(customBundle, 'VERSION'), '1.0.0\n');
        fs.writeFileSync(candidate, 'remove');
        const result = processCleanupCandidates([{ path: candidate, category: 'cache', reason: 'old', sizeBytes: 6 }], false, runtime);
        assert.equal(result.errors.length, 0);
        assert.equal(result.removed.length, 1);
        assert.equal(fs.existsSync(candidate), false);
    });
    it('preserves active task prefixes while retaining inactive task scratch cleanup', () => {
        stale();
        writeTaskQueue(targetRoot, [{ id: 'T-001', status: 'IN_PROGRESS', title: 'Active' }]);
        const runtime = path.join(bundleRoot, 'runtime');
        const active = path.join(locations().tmpDir, 'T-001-output');
        const inactive = path.join(locations().tmpDir, 'T-002-output');
        const inactiveChild = path.join(locations().tmpDir, 'T-001-2');
        for (const root of [active, inactive, inactiveChild]) { fs.mkdirSync(root); fs.writeFileSync(path.join(root, 'payload'), 'keep'); ageTree(root); }
        const activeTemp = path.join(runtime, 'T-001-debug.partial'), inactiveTemp = path.join(runtime, 'T-002-debug.partial');
        const old = new Date(Date.now() - 4 * 86400000);
        for (const file of [activeTemp, inactiveTemp]) { fs.writeFileSync(file, 'temp'); fs.utimesSync(file, old, old); }
        const result = runGc({ targetRoot, bundleRoot, confirm: true, categories: ['tmp'], retentionPolicy: { maxAgeDays: 2 } });
        assert.equal(result.errors.length, 0);
        assert.equal(fs.existsSync(active), true); assert.equal(fs.existsSync(activeTemp), true);
        assert.equal(fs.existsSync(inactive), false); assert.equal(fs.existsSync(inactiveTemp), false);
        assert.equal(fs.existsSync(inactiveChild), false, 'active parent does not suppress an inactive exact child');
        assert.equal(fs.existsSync(locations().scratchPath), true);
    });
    it('rejects active task-prefixed review directories from GC while admitting inactive exact owners', () => {
        stale();
        writeTaskQueue(targetRoot, [
            { id: 'T-001', status: 'IN_PROGRESS', title: 'Active' },
            { id: 'T-002', status: 'DONE', title: 'Inactive' },
            { id: 'T-001-2', status: 'DONE', title: 'Inactive child' }
        ]);
        const reviews = path.join(locations().tmpDir, 'reviews');
        const active = path.join(reviews, 'T-001-output'), canonicalActive = path.join(reviews, 'T-001');
        const inactive = path.join(reviews, 'T-002-output'), inactiveChild = path.join(reviews, 'T-001-2-output');
        for (const root of [active, canonicalActive, inactive, inactiveChild]) {
            fs.mkdirSync(root, { recursive: true }); fs.writeFileSync(path.join(root, 'payload'), 'fresh');
        }
        const options = { targetRoot, bundleRoot, categories: ['tmp'], retentionPolicy: { maxAgeDays: 2 } };
        const preview = runGc(options);
        assert.equal(preview.errors.length, 0);
        assert.equal(preview.skipped.some(item => item.path === active || item.path === canonicalActive), false);
        assert.equal(preview.skipped.some(item => item.path === inactive), true);
        assert.equal(preview.skipped.some(item => item.path === inactiveChild), true);
        assert.equal(fs.readFileSync(path.join(active, 'payload'), 'utf8'), 'fresh');
        const result = runGc({ ...options, confirm: true });
        assert.equal(result.errors.length, 0);
        assert.equal(fs.readFileSync(path.join(active, 'payload'), 'utf8'), 'fresh');
        assert.equal(fs.readFileSync(path.join(canonicalActive, 'payload'), 'utf8'), 'fresh');
        assert.equal(fs.existsSync(inactive), false);
        assert.equal(fs.existsSync(inactiveChild), false, 'active parent does not protect an inactive exact child owner');
    });
    it('preserves invalid selections and oversized data without acquiring deletion locks', () => {
        const root = stale();
        for (const chosen of [selection(['worker-cache', 'worker-cache']), selection(['../outside']),
            { ...selection(), cutoffUtc: '2026-01-01' }, { ...selection(), cutoffUtc: '3000-01-01T00:00:00.000Z' }]) {
            assert.equal(previewStaleScratchCleanup(chosen).status, 'BLOCKED');
        }
        const large = path.join(root, 'large.bin');
        fs.writeFileSync(large, ''); fs.truncateSync(large, 64 * 1024 * 1024 + 1); ageTree(root);
        const oversized = previewStaleScratchCleanup(selection());
        assert.equal(oversized.status, 'BLOCKED');
        assert.ok(oversized.blockers.some(reason => /bounded|allowance/u.test(reason)));
        assert.equal(fs.existsSync(locations().lockPath), false);
        assert.equal(fs.statSync(large).size, 64 * 1024 * 1024 + 1);
        assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'first');
    });
    it('blocks multiplied revalidation work before locks or mutation', () => {
        const root = stale();
        for (let index = 0; index < 140; index += 1) fs.writeFileSync(path.join(root, `entry-${index}.txt`), 'x');
        ageTree(root);
        const before = contents(root), preview = previewStaleScratchCleanup(selection());
        assert.equal(preview.status, 'BLOCKED');
        assert.ok(preview.blockers.some(reason => /revalidation allowance/u.test(reason)));
        assert.deepEqual(contents(root), before);
        assert.equal(fs.existsSync(locations().lockPath), false);
    });
});
