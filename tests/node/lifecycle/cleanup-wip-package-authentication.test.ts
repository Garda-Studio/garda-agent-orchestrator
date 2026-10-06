import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import * as path from 'node:path';
import { test, type TestContext } from 'node:test';

import {
    prepareSplitRequiredWipRestoreHandoff,
    resolveSplitRequiredWipRestoreHandoffIdentity,
    type SplitRequiredWipRuntimeGeneration
} from '../../../src/gates/split-required/split-required-wip-runtime-handoff-contracts';
import { finalizeSplitRequiredWipRestoreHandoff } from '../../../src/gates/split-required/split-required-wip-runtime-handoff';
import { retireSplitRequiredWip } from '../../../src/gates/split-required/split-required-wip';
import { resolveMockFilesystemPath } from '../gates/split-required/fixtures/filesystem-paths';
import {
    assertWipCleanupFileCurrent, readAuthenticatedWipPackage, readWipCleanupFile,
    sameWipRestoreRuntimeGeneration, WIP_CLEANUP_LIMITS
} from '../../../src/lifecycle/cleanup/cleanup-wip-ownership';
import {
    createCapturedWip, createPendingWipRestore, createWip, makeWipRepo, sha256, treeSnapshot
} from './cleanup-wip-fixtures';

function repository(t: TestContext): string {
    const root = makeWipRepo();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return root;
}

function replaceManifest(wip: ReturnType<typeof createWip>, changes: Record<string, unknown>): void {
    fs.writeFileSync(wip.manifestPath, JSON.stringify({ ...wip.manifest, ...changes }));
}

function replaceHandoff(file: string, changes: Record<string, unknown>): void {
    const current: Record<string, unknown> = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify({ ...current, ...changes }));
}

function finalizeProducer(root: string): ReturnType<typeof createPendingWipRestore> {
    const wip = createPendingWipRestore(root);
    const generation: SplitRequiredWipRuntimeGeneration = {
        build_root: path.join(root, 'dist'), input_fingerprint_sha256: 'a'.repeat(64),
        finalizer_sha256: 'b'.repeat(64), writer_sha256: 'c'.repeat(64)
    };
    assert.equal(finalizeSplitRequiredWipRestoreHandoff(wip.identity, () => generation).status, 'RESTORED');
    return wip;
}

function observeDirectoryReads(t: TestContext, packageRoot: string, simulation?: 'initial' | 'closing') {
    const observed = { scans: [] as number[], opened: 0, closed: 0 };
    const target = (directory: fs.PathLike) => typeof directory === 'string'
        && path.resolve(directory) === path.resolve(packageRoot);
    const simulated = (index: number) => simulation === 'initial' || simulation === 'closing' && index === 1;
    const readdir = fs.readdirSync, opendir = fs.opendirSync;
    t.mock.method(fs, 'readdirSync', (directory: fs.PathLike, ...options: unknown[]) => {
        if (!target(directory)) return Reflect.apply(readdir, fs, [directory, ...options]);
        const index = observed.scans.length;
        const entries = simulated(index)
            ? Array.from({ length: WIP_CLEANUP_LIMITS.entries + 1 }, (_, ordinal) => `unexpected-${ordinal}.dat`)
            : Reflect.apply(readdir, fs, [directory, ...options]) as string[];
        observed.scans.push(entries.length);
        return entries;
    });
    t.mock.method(fs, 'opendirSync', (directory: fs.PathLike, options?: Parameters<typeof fs.opendirSync>[1]) => {
        if (!target(directory)) return opendir(directory, options);
        const index = observed.scans.length;
        observed.scans.push(0);
        observed.opened += 1;
        if (simulated(index)) return {
            readSync: () => {
                if (observed.scans[index] === WIP_CLEANUP_LIMITS.entries + 1) return null;
                return { name: `unexpected-${observed.scans[index]++}.dat` } as fs.Dirent;
            },
            closeSync: () => { observed.closed += 1; }
        } as fs.Dir;
        const handle = opendir(directory, options), read = handle.readSync.bind(handle), close = handle.closeSync.bind(handle);
        t.mock.method(handle, 'readSync', () => {
            const entry = read();
            if (entry) observed.scans[index] += 1;
            return entry;
        });
        t.mock.method(handle, 'closeSync', () => { close(); observed.closed += 1; });
        return handle;
    });
    return observed;
}

function injectDuringFileRead(t: TestContext, root: string, file: string, mutation: () => void) {
    const open = fs.openSync, target = resolveMockFilesystemPath(file), injection = { done: false, snapshot: '' };
    t.mock.method(fs, 'openSync', (...args: Parameters<typeof fs.openSync>) => {
        if (!injection.done && typeof args[0] === 'string' && resolveMockFilesystemPath(args[0]) === target) {
            injection.done = true;
            mutation();
            injection.snapshot = treeSnapshot(root);
        }
        return open(...args);
    });
    return injection;
}

test('authenticates exact retired package bytes without filesystem writes', t => {
    const root = repository(t), wip = createWip(root), before = treeSnapshot(root);
    const snapshot = readAuthenticatedWipPackage(root, 'T-CLEAN-1', wip.manifestPath);
    assert.equal(snapshot.manifest.status, 'retired');
    assert.equal(snapshot.manifestSha256, sha256(fs.readFileSync(wip.manifestPath)));
    assert.deepEqual(snapshot.files.map(file => path.relative(wip.packageRoot, file.binding.path).replace(/\\/gu, '/')).sort(),
        ['manifest.json', 'staged.patch', 'unstaged.patch', 'untracked/src/generated.ts']);
    assert.match(snapshot.treeSha256, /^[0-9a-f]{64}$/u);
    assert.ok(snapshot.files.every(file => /^[0-9a-f]{64}$/u.test(file.identity)));
    assert.equal(readAuthenticatedWipPackage(root, 'T-CLEAN-1', wip.manifestPath).treeSha256, snapshot.treeSha256);
    assert.equal(treeSnapshot(root), before);
});

test('authenticates an actual capture producer package', t => {
    const root = repository(t), wip = createCapturedWip(root), before = treeSnapshot(root);
    const snapshot = readAuthenticatedWipPackage(root, 'T-CLEAN-1', wip.manifestPath);
    assert.equal(snapshot.manifest.status, 'suspended');
    assert.equal(snapshot.manifest.tracked_files[0].path, 'src/tracked.ts');
    assert.equal(snapshot.manifest.untracked_files[0].path, 'src/generated.ts');
    assert.equal(snapshot.files.length, 4);
    assert.equal(snapshot.handoffs.length, 0);
    assert.equal(treeSnapshot(root), before);
});

test('authenticates an actual prepared restore producer handoff', t => {
    const root = repository(t), wip = createCapturedWip(root);
    const identity = resolveSplitRequiredWipRestoreHandoffIdentity({ repoRoot: root,
        taskId: 'T-CLEAN-1', manifestPath: wip.manifestPath });
    const prepared = prepareSplitRequiredWipRestoreHandoff(identity, identity.timelineAnchor);
    const before = treeSnapshot(root), snapshot = readAuthenticatedWipPackage(root, 'T-CLEAN-1', wip.manifestPath);
    assert.equal(snapshot.handoffs.length, 1);
    assert.deepEqual(snapshot.handoffs[0].value, prepared);
    assert.equal(treeSnapshot(root), before);
});

test('authenticates an actual pending restore producer handoff', t => {
    const root = repository(t), wip = createPendingWipRestore(root), before = treeSnapshot(root);
    const snapshot = readAuthenticatedWipPackage(root, 'T-CLEAN-1', wip.manifestPath);
    assert.equal(snapshot.handoffs.length, 1);
    assert.deepEqual(snapshot.handoffs[0].value, wip.handoff);
    assert.equal(snapshot.handoffs[0].value.restored_file_evidence?.length, 2);
    assert.equal(treeSnapshot(root), before);
});

test('authenticates actual finalized producer evidence with reordered anchor and generation fields', t => {
    const root = repository(t), wip = finalizeProducer(root);
    const handoff = JSON.parse(fs.readFileSync(wip.identity.handoffPath, 'utf8'));
    handoff.timeline_anchor = Object.fromEntries(Object.entries(handoff.timeline_anchor).reverse());
    handoff.runtime_generation = Object.fromEntries(Object.entries(handoff.runtime_generation).reverse());
    fs.writeFileSync(wip.identity.handoffPath, JSON.stringify(handoff));
    const before = treeSnapshot(root), snapshot = readAuthenticatedWipPackage(root, 'T-CLEAN-1', wip.manifestPath);
    assert.equal(snapshot.handoffs.length, 1);
    assert.equal(snapshot.handoffs[0].value.status, 'finalized');
    assert.deepEqual(snapshot.handoffs[0].value, handoff);
    assert.equal(treeSnapshot(root), before);
});

test('authenticates Windows-equivalent manifest selection without changing producer identity',
    { skip: process.platform !== 'win32' }, t => {
        const root = repository(t), wip = finalizeProducer(root);
        const selected = path.join(root, path.relative(root, path.dirname(wip.manifestPath)).toUpperCase(), 'MANIFEST.JSON');
        const before = treeSnapshot(root), snapshot = readAuthenticatedWipPackage(root, 'T-CLEAN-1', selected);
        assert.equal(snapshot.handoffs[0].value.handoff_id, wip.identity.handoffId);
        assert.equal(snapshot.manifestSha256, wip.identity.manifestSha256);
        assert.equal(treeSnapshot(root), before);
    });

test('rejects noncanonical manifest basename on case-sensitive platforms', { skip: process.platform === 'win32' }, t => {
    const root = repository(t), wip = createWip(root), selected = path.join(wip.packageRoot, 'MANIFEST.JSON');
    fs.renameSync(wip.manifestPath, selected);
    const before = treeSnapshot(root);
    assert.throws(() => readAuthenticatedWipPackage(root, 'T-CLEAN-1', selected), /exact canonical capture package/u);
    assert.equal(treeSnapshot(root), before);
});

test('rejects unknown nested restore command fields', t => {
    const root = repository(t), wip = createWip(root);
    replaceManifest(wip, { restore_commands: { ...wip.manifest.restore_commands, unexpected_authority: true } });
    const before = treeSnapshot(root);
    assert.throws(() => readAuthenticatedWipPackage(root, 'T-CLEAN-1', wip.manifestPath), /unknown schema fields/u);
    assert.equal(treeSnapshot(root), before);
});

test('rejects malformed retirement fields on suspended manifests', t => {
    const root = repository(t), wip = createWip(root, { retired: false });
    replaceManifest(wip, { retired_at_utc: {}, retired_reason: ['retired'] });
    const before = treeSnapshot(root);
    assert.throws(() => readAuthenticatedWipPackage(root, 'T-CLEAN-1', wip.manifestPath), /suspended manifest claims retirement/u);
    assert.equal(treeSnapshot(root), before);
});

test('rejects retirement authority claimed by suspended manifests', t => {
    const root = repository(t), wip = createWip(root, { retired: false });
    replaceManifest(wip, { retired_at_utc: wip.manifest.created_at_utc, retired_reason: 'Typed but conflicting retirement.' });
    const before = treeSnapshot(root);
    assert.throws(() => readAuthenticatedWipPackage(root, 'T-CLEAN-1', wip.manifestPath), /suspended manifest claims retirement/u);
    assert.equal(treeSnapshot(root), before);
});

test('rejects over-limit package directories before materializing excess names', t => {
    const root = repository(t), wip = createWip(root), before = treeSnapshot(root);
    const observed = observeDirectoryReads(t, wip.packageRoot, 'initial');
    assert.throws(() => readAuthenticatedWipPackage(root, 'T-CLEAN-1', wip.manifestPath), /entry limit/u);
    assert.ok(observed.scans[0] <= WIP_CLEANUP_LIMITS.entries, JSON.stringify(observed));
    assert.equal(observed.opened, observed.closed);
    t.mock.reset();
    assert.equal(treeSnapshot(root), before);
});

test('rejects package directory reads beyond the shared entry allowance', t => {
    const root = repository(t), wip = createWip(root), before = treeSnapshot(root);
    const observed = observeDirectoryReads(t, wip.packageRoot);
    const budget = { remainingBytes: WIP_CLEANUP_LIMITS.authorityBytes, remainingEntries: 3 };
    assert.throws(() => readAuthenticatedWipPackage(root, 'T-CLEAN-1', wip.manifestPath, budget), /entry limit|aggregate read budget/u);
    assert.ok(observed.scans[0] <= 2, JSON.stringify(observed));
    assert.equal(observed.opened, observed.closed);
    t.mock.reset();
    assert.equal(treeSnapshot(root), before);
});

test('rejects over-limit closing tree inspection before materializing excess names', t => {
    const root = repository(t), wip = createWip(root), before = treeSnapshot(root);
    const observed = observeDirectoryReads(t, wip.packageRoot, 'closing');
    assert.throws(() => readAuthenticatedWipPackage(root, 'T-CLEAN-1', wip.manifestPath), /entry limit/u);
    assert.ok(observed.scans[1] <= WIP_CLEANUP_LIMITS.entries, JSON.stringify(observed));
    assert.equal(observed.opened, observed.closed);
    t.mock.reset();
    assert.equal(treeSnapshot(root), before);
});

test('rejects undeclared membership added after its parent was authenticated', t => {
    const root = repository(t), wip = createWip(root), extra = path.join(wip.packageRoot, 'late-member.txt');
    const injection = injectDuringFileRead(t, root, wip.artifactPath, () => fs.writeFileSync(extra, 'preserve late work'));
    assert.throws(() => readAuthenticatedWipPackage(root, 'T-CLEAN-1', wip.manifestPath), /membership|snapshot|changed/u);
    assert.equal(injection.done, true);
    t.mock.reset();
    assert.equal(treeSnapshot(root), injection.snapshot);
    assert.equal(fs.readFileSync(extra, 'utf8'), 'preserve late work');
});

test('rejects membership added to an already-scanned parent during closing traversal', t => {
    const root = repository(t), wip = createWip(root), extra = path.join(wip.packageRoot, 'closing-member.txt');
    const target = resolveMockFilesystemPath(path.join(wip.packageRoot, 'untracked'));
    const opendir = fs.opendirSync;
    let opened = 0, injectedSnapshot = '';
    t.mock.method(fs, 'opendirSync', (directory: fs.PathLike, options?: Parameters<typeof fs.opendirSync>[1]) => {
        if (typeof directory === 'string' && resolveMockFilesystemPath(directory) === target && ++opened === 2) {
            fs.writeFileSync(extra, 'preserve work added during closing');
            injectedSnapshot = treeSnapshot(root);
        }
        return opendir(directory, options);
    });
    assert.throws(() => readAuthenticatedWipPackage(root, 'T-CLEAN-1', wip.manifestPath), /directory.*changed|snapshot/u);
    assert.equal(opened, 2);
    t.mock.reset();
    assert.equal(treeSnapshot(root), injectedSnapshot);
    assert.equal(fs.readFileSync(extra, 'utf8'), 'preserve work added during closing');
});

test('rejects an already-read member replaced before closing tree inspection', t => {
    const root = repository(t), wip = createWip(root), member = path.join(wip.packageRoot, 'staged.patch');
    const original = fs.readFileSync(member), retained = path.join(root, 'retained-staged.patch');
    const injection = injectDuringFileRead(t, root, wip.artifactPath, () => {
        fs.renameSync(member, retained);
        fs.writeFileSync(member, original);
    });
    assert.throws(() => readAuthenticatedWipPackage(root, 'T-CLEAN-1', wip.manifestPath), /identity|snapshot|changed/u);
    assert.equal(injection.done, true);
    t.mock.reset();
    assert.equal(treeSnapshot(root), injection.snapshot);
    assert.deepEqual(fs.readFileSync(member), original);
    assert.deepEqual(fs.readFileSync(retained), original);
});

test('rejects already-read member bytes changed before snapshot completion', t => {
    const root = repository(t), wip = createWip(root), member = path.join(wip.packageRoot, 'staged.patch');
    const injection = injectDuringFileRead(t, root, wip.artifactPath, () => fs.writeFileSync(member, 'changed staged patch'));
    assert.throws(() => readAuthenticatedWipPackage(root, 'T-CLEAN-1', wip.manifestPath), /snapshot|changed/u);
    assert.equal(injection.done, true);
    t.mock.reset();
    assert.equal(treeSnapshot(root), injection.snapshot);
    assert.equal(fs.readFileSync(member, 'utf8'), 'changed staged patch');
});

test('rejects nonfinite read budgets before payload reads', t => {
    const root = repository(t), file = path.join(root, 'bounded-budget.txt');
    fs.writeFileSync(file, '12345678');
    assert.throws(() => readWipCleanupFile(root, file, 64, { remainingBytes: Number.NaN, remainingEntries: 16 }), /aggregate read budget/u);
    assert.throws(() => readWipCleanupFile(root, file, 64, { remainingBytes: 16, remainingEntries: Number.NaN }), /aggregate read budget/u);
    assert.equal(fs.readFileSync(file, 'utf8'), '12345678');
});

test('rejects array-valued manifest status without coercion', t => {
    const root = repository(t), wip = createWip(root);
    replaceManifest(wip, { status: ['retired'] });
    const before = treeSnapshot(root);
    assert.throws(() => readAuthenticatedWipPackage(root, 'T-CLEAN-1', wip.manifestPath), /status or guard kind is invalid/u);
    assert.equal(treeSnapshot(root), before);
});

test('rejects array-valued manifest guard kind without coercion', t => {
    const root = repository(t), wip = createWip(root);
    replaceManifest(wip, { guard_kind: ['scope_budget'] });
    const before = treeSnapshot(root);
    assert.throws(() => readAuthenticatedWipPackage(root, 'T-CLEAN-1', wip.manifestPath), /status or guard kind is invalid/u);
    assert.equal(treeSnapshot(root), before);
});

test('rejects unknown manifest schema fields and foreign task identity', t => {
    const root = repository(t), wip = createWip(root);
    replaceManifest(wip, { unexpected_authority: true });
    assert.throws(() => readAuthenticatedWipPackage(root, 'T-CLEAN-1', wip.manifestPath), /unknown schema fields/u);
    replaceManifest(wip, { task_id: 'T-CLEAN-10' });
    const before = treeSnapshot(root);
    assert.throws(() => readAuthenticatedWipPackage(root, 'T-CLEAN-1', wip.manifestPath), /task identity/u);
    assert.equal(treeSnapshot(root), before);
});

test('rejects declared payload paths outside their exact source membership', t => {
    const root = repository(t), wip = createWip(root);
    replaceManifest(wip, { untracked_files: [{ ...wip.manifest.untracked_files[0], artifact_path: wip.manifestPath }] });
    const before = treeSnapshot(root);
    assert.throws(() => readAuthenticatedWipPackage(root, 'T-CLEAN-1', wip.manifestPath), /does not match its declared source/u);
    assert.equal(treeSnapshot(root), before);
});

test('rejects duplicate declared source paths', t => {
    const root = repository(t), wip = createWip(root);
    replaceManifest(wip, { untracked_files: [...wip.manifest.untracked_files, ...wip.manifest.untracked_files] });
    const before = treeSnapshot(root);
    assert.throws(() => readAuthenticatedWipPackage(root, 'T-CLEAN-1', wip.manifestPath), /declared more than once/u);
    assert.equal(treeSnapshot(root), before);
});

test('rejects declared source depth above the package entry limit before directory reads', t => {
    const root = repository(t), wip = createWip(root);
    const source = `${'segment/'.repeat(WIP_CLEANUP_LIMITS.entries)}payload.ts`;
    replaceManifest(wip, { untracked_files: [{ ...wip.manifest.untracked_files[0], path: source,
        artifact_path: path.join(wip.packageRoot, 'untracked', source) }] });
    const before = treeSnapshot(root), observed = observeDirectoryReads(t, wip.packageRoot);
    assert.throws(() => readAuthenticatedWipPackage(root, 'T-CLEAN-1', wip.manifestPath), /source path depth limit/u);
    assert.equal(observed.opened, 0);
    assert.deepEqual(observed.scans, []);
    t.mock.reset();
    assert.equal(treeSnapshot(root), before);
});

test('rejects declared directory indexes above their bound before directory reads', t => {
    const root = repository(t), wip = createWip(root);
    const declarations = Array.from({ length: WIP_CLEANUP_LIMITS.entries }, (_, index) => {
        const source = `branch-${index}/payload.ts`;
        return { ...wip.manifest.untracked_files[0], path: source,
            artifact_path: path.join(wip.packageRoot, 'untracked', source) };
    });
    replaceManifest(wip, { untracked_files: declarations });
    const before = treeSnapshot(root), observed = observeDirectoryReads(t, wip.packageRoot);
    assert.throws(() => readAuthenticatedWipPackage(root, 'T-CLEAN-1', wip.manifestPath), /declared directory limit/u);
    assert.equal(observed.opened, 0);
    assert.deepEqual(observed.scans, []);
    t.mock.reset();
    assert.equal(treeSnapshot(root), before);
});

test('rejects declared ancestry metadata above its bound before directory reads', t => {
    const root = repository(t), wip = createWip(root), source = `${'x/'.repeat(1200)}payload.ts`;
    replaceManifest(wip, { untracked_files: [{ ...wip.manifest.untracked_files[0], path: source,
        artifact_path: path.relative(root, path.join(wip.packageRoot, 'untracked', source)).replace(/\\/gu, '/') }] });
    const before = treeSnapshot(root), observed = observeDirectoryReads(t, wip.packageRoot);
    assert.throws(() => readAuthenticatedWipPackage(root, 'T-CLEAN-1', wip.manifestPath), /snapshot metadata budget/u);
    assert.equal(observed.opened, 0);
    assert.equal(observed.scans.length, 0);
    t.mock.reset();
    assert.equal(treeSnapshot(root), before);
});

test('rejects shared snapshot metadata allowance before directory reads', t => {
    const root = repository(t), wip = createWip(root), before = treeSnapshot(root);
    const observed = observeDirectoryReads(t, wip.packageRoot);
    const budget = { remainingBytes: WIP_CLEANUP_LIMITS.authorityBytes, remainingEntries: 64,
        remainingSnapshotBytes: 1 };
    assert.throws(() => readAuthenticatedWipPackage(root, 'T-CLEAN-1', wip.manifestPath, budget), /snapshot metadata budget/u);
    assert.equal(budget.remainingSnapshotBytes, 0);
    assert.equal(observed.opened, 0);
    assert.equal(observed.scans.length, 0);
    t.mock.reset();
    assert.equal(treeSnapshot(root), before);
});

test('retains snapshot metadata charges after a rejected package and subsequent file read', t => {
    const root = repository(t), wip = createWip(root);
    fs.writeFileSync(wip.artifactPath, 'changed declared bytes');
    const before = treeSnapshot(root), budget = { remainingBytes: WIP_CLEANUP_LIMITS.authorityBytes,
        remainingEntries: 64, remainingSnapshotBytes: WIP_CLEANUP_LIMITS.snapshotBytes };
    assert.throws(() => readAuthenticatedWipPackage(root, 'T-CLEAN-1', wip.manifestPath, budget), /declared artifact bytes changed/u);
    const remainingAfterRejection = budget.remainingSnapshotBytes;
    assert.ok(remainingAfterRejection > 0 && remainingAfterRejection < WIP_CLEANUP_LIMITS.snapshotBytes);
    const file = readWipCleanupFile(root, wip.artifactPath, WIP_CLEANUP_LIMITS.artifactBytes, budget);
    assert.ok(budget.remainingSnapshotBytes < remainingAfterRejection);
    assert.match(file.identity, /^[0-9a-f]{64}$/u);
    assert.equal(treeSnapshot(root), before);
});

test('rejects nonfinite snapshot metadata allowance before opening bytes', t => {
    const root = repository(t), wip = createWip(root), before = treeSnapshot(root), open = fs.openSync;
    let opened = false;
    t.mock.method(fs, 'openSync', (...args: Parameters<typeof fs.openSync>) => {
        opened = true;
        return open(...args);
    });
    assert.throws(() => readAuthenticatedWipPackage(root, 'T-CLEAN-1', wip.manifestPath,
        { remainingBytes: WIP_CLEANUP_LIMITS.authorityBytes, remainingEntries: 64,
            remainingSnapshotBytes: Number.NaN }), /snapshot metadata budget/u);
    assert.equal(opened, false);
    t.mock.reset();
    assert.equal(treeSnapshot(root), before);
});

test('rejects new closing members before enumerating their ancestry', t => {
    const root = repository(t), wip = createWip(root), added = path.join(wip.packageRoot, 'late-tree');
    const injection = injectDuringFileRead(t, root, wip.artifactPath, () => {
        fs.mkdirSync(path.join(added, 'nested'), { recursive: true });
        fs.writeFileSync(path.join(added, 'nested', 'payload.txt'), 'preserve actor work');
    });
    const opendir = fs.opendirSync;
    let openedAddedAncestry = false;
    t.mock.method(fs, 'opendirSync', (directory: fs.PathLike, options?: Parameters<typeof fs.opendirSync>[1]) => {
        if (typeof directory === 'string' && path.resolve(directory).startsWith(path.resolve(added))) {
            openedAddedAncestry = true;
        }
        return opendir(directory, options);
    });
    assert.throws(() => readAuthenticatedWipPackage(root, 'T-CLEAN-1', wip.manifestPath), /membership changed/u);
    assert.equal(injection.done, true);
    assert.equal(openedAddedAncestry, false);
    t.mock.reset();
    assert.equal(treeSnapshot(root), injection.snapshot);
});

test('authenticates shared nested declaration prefixes and suspended directories', t => {
    const root = repository(t), wip = createWip(root), source = 'src/nested/directory/payload.ts';
    const artifact = path.join(wip.packageRoot, 'untracked', source);
    fs.mkdirSync(path.dirname(artifact), { recursive: true });
    fs.renameSync(wip.artifactPath, artifact);
    fs.mkdirSync(path.join(wip.packageRoot, 'suspended-untracked', path.dirname(source)), { recursive: true });
    replaceManifest(wip, { untracked_files: [{ ...wip.manifest.untracked_files[0], path: source, artifact_path: artifact }] });
    const before = treeSnapshot(root), snapshot = readAuthenticatedWipPackage(root, 'T-CLEAN-1', wip.manifestPath);
    assert.equal(snapshot.files.length, 4);
    assert.ok(snapshot.files.some(file => file.binding.path === artifact));
    assert.ok(snapshot.directories.some(directory => directory.path === path.dirname(artifact)));
    assert.ok(snapshot.directories.some(directory => directory.path === path.join(wip.packageRoot,
        'suspended-untracked', path.dirname(source))));
    assert.equal(treeSnapshot(root), before);
});

test('rejects declared artifact byte counts above the supported bound', t => {
    const root = repository(t), wip = createWip(root);
    replaceManifest(wip, { untracked_files: [{ ...wip.manifest.untracked_files[0], bytes: WIP_CLEANUP_LIMITS.artifactBytes + 1 }] });
    const before = treeSnapshot(root);
    assert.throws(() => readAuthenticatedWipPackage(root, 'T-CLEAN-1', wip.manifestPath), /byte count exceeds/u);
    assert.equal(treeSnapshot(root), before);
});

test('rejects changed declared payload bytes without modifying the package', t => {
    const root = repository(t), wip = createWip(root);
    const content = fs.readFileSync(wip.artifactPath), declaration = wip.manifest.untracked_files[0];
    assert.ok(content.length > 0);
    content[0] = content.readUInt8(0) ^ 1;
    assert.equal(content.length, declaration.bytes);
    assert.notEqual(sha256(content), declaration.sha256);
    fs.writeFileSync(wip.artifactPath, content);
    const before = treeSnapshot(root);
    assert.throws(() => readAuthenticatedWipPackage(root, 'T-CLEAN-1', wip.manifestPath), /declared artifact bytes changed/u);
    assert.equal(treeSnapshot(root), before);
});

test('rejects payloads larger than their declared bytes before opening', t => {
    const root = repository(t), wip = createWip(root);
    replaceManifest(wip, { untracked_files: [{ ...wip.manifest.untracked_files[0],
        bytes: wip.manifest.untracked_files[0].bytes - 1 }] });
    const before = treeSnapshot(root), open = fs.openSync;
    let payloadOpened = false;
    t.mock.method(fs, 'openSync', (...args: Parameters<typeof fs.openSync>) => {
        if (typeof args[0] === 'string' && resolveMockFilesystemPath(args[0]) === resolveMockFilesystemPath(wip.artifactPath)) payloadOpened = true;
        return open(...args);
    });
    assert.throws(() => readAuthenticatedWipPackage(root, 'T-CLEAN-1', wip.manifestPath), /declared artifact bytes changed/u);
    assert.equal(payloadOpened, false);
    t.mock.reset();
    assert.equal(treeSnapshot(root), before);
});

test('rejects payloads smaller than their declared bytes before opening', t => {
    const root = repository(t), wip = createWip(root);
    replaceManifest(wip, { untracked_files: [{ ...wip.manifest.untracked_files[0],
        bytes: wip.manifest.untracked_files[0].bytes + 1 }] });
    const before = treeSnapshot(root), open = fs.openSync;
    let payloadOpened = false;
    t.mock.method(fs, 'openSync', (...args: Parameters<typeof fs.openSync>) => {
        if (typeof args[0] === 'string' && resolveMockFilesystemPath(args[0]) === resolveMockFilesystemPath(wip.artifactPath)) payloadOpened = true;
        return open(...args);
    });
    assert.throws(() => readAuthenticatedWipPackage(root, 'T-CLEAN-1', wip.manifestPath), /declared artifact bytes changed/u);
    assert.equal(payloadOpened, false);
    t.mock.reset();
    assert.equal(treeSnapshot(root), before);
});

test('rejects payloads beyond the remaining package capacity before opening', t => {
    const root = repository(t), wip = createWip(root), first = path.join(wip.packageRoot, 'untracked/src/first.ts');
    const bytes = WIP_CLEANUP_LIMITS.artifactBytes, chunk = Buffer.alloc(64 * 1024), hash = createHash('sha256');
    for (let remaining = bytes; remaining > 0; remaining -= chunk.length) hash.update(chunk.subarray(0, Math.min(remaining, chunk.length)));
    const digest = hash.digest('hex'), payloads = [wip.manifest.patches.staged.path,
        wip.manifest.patches.unstaged.path, first, wip.artifactPath];
    for (const file of payloads) {
        fs.writeFileSync(file, '');
        fs.truncateSync(file, bytes);
    }
    replaceManifest(wip, {
        patches: { staged: { ...wip.manifest.patches.staged, bytes, sha256: digest, empty: false },
            unstaged: { ...wip.manifest.patches.unstaged, bytes, sha256: digest, empty: false } },
        untracked_files: [{ ...wip.manifest.untracked_files[0], bytes, sha256: digest },
            { path: 'src/first.ts', artifact_path: first, bytes, sha256: digest }]
    });
    const before = treeSnapshot(root), open = fs.openSync, opened = new Set<string>();
    t.mock.method(fs, 'openSync', (...args: Parameters<typeof fs.openSync>) => {
        if (typeof args[0] === 'string') opened.add(resolveMockFilesystemPath(args[0]));
        return open(...args);
    });
    assert.throws(() => readAuthenticatedWipPackage(root, 'T-CLEAN-1', wip.manifestPath), /aggregate byte limit|byte limit/u);
    for (const file of payloads.slice(0, -1)) assert.equal(opened.has(resolveMockFilesystemPath(file)), true);
    assert.equal(opened.has(resolveMockFilesystemPath(wip.artifactPath)), false);
    t.mock.reset();
    assert.equal(treeSnapshot(root), before);
});

test('rejects missing declared artifacts', t => {
    const root = repository(t), wip = createWip(root);
    fs.unlinkSync(wip.artifactPath);
    const before = treeSnapshot(root);
    assert.throws(() => readAuthenticatedWipPackage(root, 'T-CLEAN-1', wip.manifestPath), /missing declared artifacts/u);
    assert.equal(treeSnapshot(root), before);
});

test('rejects undeclared package files and directories', t => {
    const root = repository(t), wip = createWip(root), extra = path.join(wip.packageRoot, 'foreign.txt');
    fs.writeFileSync(extra, 'preserve unknown work');
    assert.throws(() => readAuthenticatedWipPackage(root, 'T-CLEAN-1', wip.manifestPath), /undeclared file/u);
    fs.unlinkSync(extra);
    fs.mkdirSync(path.join(wip.packageRoot, 'unknown-directory'));
    const before = treeSnapshot(root);
    assert.throws(() => readAuthenticatedWipPackage(root, 'T-CLEAN-1', wip.manifestPath), /undeclared directory/u);
    assert.equal(treeSnapshot(root), before);
});

test('rejects shared declared artifacts and preserves the linked target', t => {
    const root = repository(t), wip = createWip(root), target = path.join(root, 'shared-payload.ts');
    fs.linkSync(wip.artifactPath, target);
    const before = treeSnapshot(root);
    assert.throws(() => readAuthenticatedWipPackage(root, 'T-CLEAN-1', wip.manifestPath), /Destination crosses a hard-linked file:/u);
    assert.equal(treeSnapshot(root), before);
    assert.equal(fs.readFileSync(target, 'utf8'), 'export const preservedSource = 1;\n');
});

test('rejects a linked package root and preserves its target', t => {
    const root = repository(t), wip = createWip(root), target = path.join(root, 'redirected-package');
    fs.renameSync(wip.packageRoot, target);
    fs.symlinkSync(target, wip.packageRoot, process.platform === 'win32' ? 'junction' : 'dir');
    const before = treeSnapshot(root);
    assert.throws(() => readAuthenticatedWipPackage(root, 'T-CLEAN-1', wip.manifestPath), /link|containment|redirect/iu);
    assert.equal(treeSnapshot(root), before);
    assert.ok(fs.existsSync(path.join(target, 'manifest.json')));
});

test('rejects replaced authenticated file identity even when bytes are equal', t => {
    const root = repository(t), wip = createWip(root);
    const original = readWipCleanupFile(root, wip.artifactPath, WIP_CLEANUP_LIMITS.artifactBytes);
    const content = fs.readFileSync(wip.artifactPath);
    fs.renameSync(wip.artifactPath, path.join(root, 'retained-original.ts'));
    fs.writeFileSync(wip.artifactPath, content);
    const before = treeSnapshot(root);
    assert.throws(() => assertWipCleanupFileCurrent(root, original), /changed|identity/iu);
    assert.equal(treeSnapshot(root), before);
});

test('rejects a changed authenticated file before mutation', t => {
    const root = repository(t), wip = createWip(root);
    const original = readWipCleanupFile(root, wip.artifactPath, WIP_CLEANUP_LIMITS.artifactBytes);
    fs.writeFileSync(wip.artifactPath, 'export const preservedSource = 2;\n');
    const before = treeSnapshot(root);
    assert.throws(() => assertWipCleanupFileCurrent(root, original), /changed before removal/u);
    assert.equal(treeSnapshot(root), before);
});

test('rejects initial manifest reads beyond the remaining shared budget before opening bytes', t => {
    const root = repository(t), wip = createWip(root), size = fs.statSync(wip.manifestPath).size;
    const budget = { remainingBytes: size - 1, remainingEntries: 16 };
    const open = fs.openSync;
    let manifestOpened = false;
    t.mock.method(fs, 'openSync', (...args: Parameters<typeof fs.openSync>) => {
        if (typeof args[0] === 'string' && resolveMockFilesystemPath(args[0]) === resolveMockFilesystemPath(wip.manifestPath)) manifestOpened = true;
        return open(...args);
    });
    assert.throws(() => readAuthenticatedWipPackage(root, 'T-CLEAN-1', wip.manifestPath, budget), /aggregate read budget/u);
    assert.equal(manifestOpened, false);
    assert.equal(budget.remainingBytes, size - 1);
    assert.equal(budget.remainingEntries, 0);
});

test('charges malformed JSON manifests before later package reads', t => {
    const root = repository(t), first = createWip(root, { ordinal: 1 }), second = createWip(root, { ordinal: 2 });
    fs.writeFileSync(first.manifestPath, '{');
    const secondBytes = fs.statSync(second.manifestPath).size;
    const budget = { remainingBytes: secondBytes, remainingEntries: 16 }, open = fs.openSync;
    let secondOpened = false;
    t.mock.method(fs, 'openSync', (...args: Parameters<typeof fs.openSync>) => {
        if (typeof args[0] === 'string' && resolveMockFilesystemPath(args[0]) === resolveMockFilesystemPath(second.manifestPath)) secondOpened = true;
        return open(...args);
    });
    assert.throws(() => readAuthenticatedWipPackage(root, 'T-CLEAN-1', first.manifestPath, budget), SyntaxError);
    assert.equal(budget.remainingBytes, secondBytes - 1);
    assert.throws(() => readAuthenticatedWipPackage(root, 'T-CLEAN-1', second.manifestPath, budget), /aggregate read budget/u);
    assert.equal(secondOpened, false);
});

test('charges rejected manifest schemas before later package reads', t => {
    const root = repository(t), first = createWip(root, { ordinal: 1 }), second = createWip(root, { ordinal: 2 });
    replaceManifest(first, { schema_version: 2 });
    const firstBytes = fs.statSync(first.manifestPath).size, secondBytes = fs.statSync(second.manifestPath).size;
    const budget = { remainingBytes: firstBytes + secondBytes - 1, remainingEntries: 16 }, open = fs.openSync;
    let secondOpened = false;
    t.mock.method(fs, 'openSync', (...args: Parameters<typeof fs.openSync>) => {
        if (typeof args[0] === 'string' && resolveMockFilesystemPath(args[0]) === resolveMockFilesystemPath(second.manifestPath)) secondOpened = true;
        return open(...args);
    });
    assert.throws(() => readAuthenticatedWipPackage(root, 'T-CLEAN-1', first.manifestPath, budget), /manifest schema/u);
    assert.equal(budget.remainingBytes, secondBytes - 1);
    assert.throws(() => readAuthenticatedWipPackage(root, 'T-CLEAN-1', second.manifestPath, budget), /aggregate read budget/u);
    assert.equal(secondOpened, false);
});

test('rejects aggregate file reads before opening a second payload', t => {
    const root = repository(t), first = path.join(root, 'first.txt'), second = path.join(root, 'second.txt');
    fs.writeFileSync(first, '12345678');
    fs.writeFileSync(second, 'abcdefgh');
    const budget = { remainingBytes: 12, remainingEntries: 16 };
    assert.equal(readWipCleanupFile(root, first, 64, budget).content.toString(), '12345678');
    const open = fs.openSync;
    let secondOpened = false;
    t.mock.method(fs, 'openSync', (...args: Parameters<typeof fs.openSync>) => {
        if (typeof args[0] === 'string' && resolveMockFilesystemPath(args[0]) === resolveMockFilesystemPath(second)) secondOpened = true;
        return open(...args);
    });
    assert.throws(() => readWipCleanupFile(root, second, 64, budget), /aggregate read budget/u);
    assert.equal(secondOpened, false);
    assert.equal(budget.remainingBytes, 4);
    assert.equal(budget.remainingEntries, 0);
});

test('charges bounded file rejections without refunding their read reservation', t => {
    const root = repository(t), file = path.join(root, 'bounded.txt');
    fs.writeFileSync(file, '12345678');
    const budget = { remainingBytes: 12, remainingEntries: 16 };
    assert.throws(() => readWipCleanupFile(root, file, 4, budget), /bound|limit|large/iu);
    assert.equal(budget.remainingBytes, 4);
    assert.equal(budget.remainingEntries, 15);
    assert.throws(() => readWipCleanupFile(root, file, 64, budget), /aggregate read budget/u);
});

test('rejects bytes changed after authenticated descriptor closure before snapshot publication', t => {
    const root = repository(t), file = path.join(root, 'snapshot-gap.txt');
    fs.writeFileSync(file, 'original');
    const target = resolveMockFilesystemPath(file), open = fs.openSync, close = fs.closeSync;
    let authenticatedDescriptor: number | null = null, changed = false;
    t.mock.method(fs, 'openSync', (...args: Parameters<typeof fs.openSync>) => {
        const descriptor = open(...args);
        if (authenticatedDescriptor === null && typeof args[0] === 'string'
            && resolveMockFilesystemPath(args[0]) === target) authenticatedDescriptor = descriptor;
        return descriptor;
    });
    t.mock.method(fs, 'closeSync', (descriptor: number) => {
        close(descriptor);
        if (descriptor === authenticatedDescriptor && !changed) {
            changed = true;
            fs.writeFileSync(file, 'modified');
            const later = new Date(Date.now() + 1000);
            fs.utimesSync(file, later, later);
        }
    });
    assert.throws(() => readWipCleanupFile(root, file, 64), /changed while authenticating/u);
    assert.equal(changed, true);
    t.mock.reset();
    assert.equal(fs.readFileSync(file, 'utf8'), 'modified');
});

test('rejects array-valued restore status without coercion', t => {
    const root = repository(t), wip = createPendingWipRestore(root);
    replaceHandoff(wip.identity.handoffPath, { status: ['pending'] });
    const before = treeSnapshot(root);
    assert.throws(() => readAuthenticatedWipPackage(root, 'T-CLEAN-1', wip.manifestPath), /malformed or conflicting ownership/u);
    assert.equal(treeSnapshot(root), before);
});

test('rejects a restore selection that is not bound by its producer handoff identity', t => {
    const root = repository(t), wip = createCapturedWip(root);
    const identity = resolveSplitRequiredWipRestoreHandoffIdentity({ repoRoot: root,
        taskId: 'T-CLEAN-1', manifestPath: wip.manifestPath });
    prepareSplitRequiredWipRestoreHandoff(identity, identity.timelineAnchor);
    replaceHandoff(identity.handoffPath, { selected_paths: ['src/tracked.ts'], restored_files: ['src/tracked.ts'] });
    const before = treeSnapshot(root);
    assert.throws(() => readAuthenticatedWipPackage(root, 'T-CLEAN-1', wip.manifestPath), /does not bind its immutable ownership/u);
    assert.equal(treeSnapshot(root), before);
});

test('rejects a handoff after valid suspended manifest bytes change', t => {
    const root = repository(t), wip = createCapturedWip(root);
    const identity = resolveSplitRequiredWipRestoreHandoffIdentity({ repoRoot: root,
        taskId: 'T-CLEAN-1', manifestPath: wip.manifestPath });
    prepareSplitRequiredWipRestoreHandoff(identity, identity.timelineAnchor);
    const manifest = JSON.parse(fs.readFileSync(wip.manifestPath, 'utf8'));
    fs.writeFileSync(wip.manifestPath, JSON.stringify({ ...manifest,
        guard_reason: 'Valid edit after the producer handoff was created.' }));
    const before = treeSnapshot(root);
    assert.notEqual(sha256(fs.readFileSync(wip.manifestPath)), identity.manifestSha256);
    assert.throws(() => readAuthenticatedWipPackage(root, 'T-CLEAN-1', wip.manifestPath), /suspended manifest digest/u);
    assert.equal(treeSnapshot(root), before);
});

test('authenticates actual retired producer bytes without rebinding the capture handoff digest', t => {
    const root = repository(t), wip = createPendingWipRestore(root);
    assert.equal(retireSplitRequiredWip({ repoRoot: root, taskId: 'T-CLEAN-1',
        manifestPath: wip.manifestPath, reason: 'Exercise the producer retirement byte transition.' }).status, 'RETIRED');
    const before = treeSnapshot(root), snapshot = readAuthenticatedWipPackage(root, 'T-CLEAN-1', wip.manifestPath);
    assert.equal(snapshot.manifest.status, 'retired');
    assert.equal(snapshot.manifestSha256, sha256(fs.readFileSync(wip.manifestPath)));
    assert.notEqual(snapshot.manifestSha256, wip.identity.manifestSha256);
    assert.equal(snapshot.handoffs[0].value.manifest_sha256, wip.identity.manifestSha256);
    assert.equal(treeSnapshot(root), before);
});

test('rejects prepared handoffs that claim restored workspace evidence', t => {
    const root = repository(t), wip = createCapturedWip(root);
    const identity = resolveSplitRequiredWipRestoreHandoffIdentity({ repoRoot: root,
        taskId: 'T-CLEAN-1', manifestPath: wip.manifestPath });
    prepareSplitRequiredWipRestoreHandoff(identity, identity.timelineAnchor);
    replaceHandoff(identity.handoffPath, { restored_file_evidence: [] });
    const before = treeSnapshot(root);
    assert.throws(() => readAuthenticatedWipPackage(root, 'T-CLEAN-1', wip.manifestPath), /prepared restore handoff claims/u);
    assert.equal(treeSnapshot(root), before);
});

test('rejects pending handoffs with incomplete restored file evidence', t => {
    const root = repository(t), wip = createPendingWipRestore(root);
    replaceHandoff(wip.identity.handoffPath, { restored_file_evidence: [] });
    const before = treeSnapshot(root);
    assert.throws(() => readAuthenticatedWipPackage(root, 'T-CLEAN-1', wip.manifestPath), /exact restored files/u);
    assert.equal(treeSnapshot(root), before);
});

test('rejects finalized handoffs missing canonical event integrity fields', t => {
    const root = repository(t), wip = finalizeProducer(root);
    const handoff = JSON.parse(fs.readFileSync(wip.identity.handoffPath, 'utf8'));
    delete handoff.event_integrity;
    fs.writeFileSync(wip.identity.handoffPath, JSON.stringify(handoff));
    const before = treeSnapshot(root);
    assert.throws(() => readAuthenticatedWipPackage(root, 'T-CLEAN-1', wip.manifestPath), /restore event integrity must be an object/u);
    assert.equal(treeSnapshot(root), before);
});

test('compares runtime generation fields independent of serialization order', () => {
    const expected: SplitRequiredWipRuntimeGeneration = {
        build_root: path.join(path.resolve('.'), 'dist'), input_fingerprint_sha256: 'a'.repeat(64),
        finalizer_sha256: 'b'.repeat(64), writer_sha256: 'c'.repeat(64)
    };
    assert.equal(sameWipRestoreRuntimeGeneration(Object.fromEntries(Object.entries(expected).reverse()), expected), true);
    assert.equal(sameWipRestoreRuntimeGeneration({ ...expected, writer_sha256: 'd'.repeat(64) }, expected), false);
    assert.equal(sameWipRestoreRuntimeGeneration({ ...expected, unverified_extra: true }, expected), false);
});
