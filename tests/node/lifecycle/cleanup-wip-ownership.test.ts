import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { resolveMockFilesystemPath } from '../gates/split-required/fixtures/filesystem-paths';
import { retireSplitRequiredWip } from '../../../src/gates/split-required/split-required-wip-operations';
import { finalizeSplitRequiredWipRestoreHandoff } from '../../../src/gates/split-required/split-required-wip-runtime-handoff';
import { readAuthenticatedWipPackage, readWipCleanupFile, WIP_CLEANUP_LIMITS } from '../../../src/lifecycle/cleanup/cleanup-wip-ownership';

import { createPendingWipRestore, createWip, event, makeWipRepo, preview, remove, sha256, treeSnapshot, writeQueue } from './cleanup-wip-fixtures';

describe('canonical retired WIP ownership', () => {
    let root: string;
    beforeEach(() => { root = makeWipRepo(); });
    afterEach(() => { mock.restoreAll(); fs.rmSync(root, { recursive: true, force: true }); });

    it('authenticates current retired bytes and previews without filesystem writes', () => {
        const wip = createWip(root);
        const before = treeSnapshot(root);
        const result = preview({ targetRoot: root, taskIds: ['T-CLEAN-1'] });
        assert.equal(result.status, 'READY', result.blockers.join('\n'));
        assert.equal(result.packages[0].classification, 'retired-orphan');
        assert.equal(result.package_count, 1);
        assert.equal(result.file_count, 4);
        assert.ok(result.total_bytes >= fs.statSync(wip.manifestPath).size);
        assert.match(result.ownership_digest, /^[0-9a-f]{64}$/u);
        assert.equal(preview({ targetRoot: root, taskIds: ['T-CLEAN-1'] }).ownership_digest, result.ownership_digest);
        assert.equal(treeSnapshot(root), before);
    });

    it('stops namespace enumeration at the first over-limit entry', () => {
        const wip = createWip(root), namespace = resolveMockFilesystemPath(path.dirname(wip.packageRoot));
        const before = treeSnapshot(root), original = fs.opendirSync;
        let readCount = 0, closed = false;
        mock.method(fs, 'opendirSync', (...args: unknown[]) => {
            if (resolveMockFilesystemPath(String(args[0])) !== namespace) return Reflect.apply(original, fs, args);
            return {
                readSync: () => {
                    readCount += 1;
                    if (readCount > WIP_CLEANUP_LIMITS.entries + 1) throw new Error('Enumeration exceeded the test ceiling');
                    return { name: `entry-${readCount}` };
                },
                closeSync: () => { closed = true; }
            } as unknown as fs.Dir;
        });
        const result = preview({ targetRoot: root, taskIds: ['T-CLEAN-1'] });
        assert.equal(result.status, 'BLOCKED');
        assert.ok(result.blockers.some(blocker => /entry limit exceeded/iu.test(blocker)));
        assert.equal(readCount, WIP_CLEANUP_LIMITS.entries + 1);
        assert.equal(closed, true);
        assert.equal(treeSnapshot(root), before);
    });

    it('preserves suspended work for TODO BLOCKED SPLIT_REQUIRED and DECOMPOSED owners', () => {
        const wip = createWip(root, { retired: false });
        for (const status of ['TODO', 'BLOCKED', 'SPLIT_REQUIRED', 'DECOMPOSED', 'DONE']) {
            writeQueue(root, [{ taskId: 'T-CLEAN-1', status }]);
            const result = preview({ targetRoot: root, taskIds: ['T-CLEAN-1'] });
            assert.equal(result.status, 'BLOCKED');
            assert.equal(result.packages[0].classification, 'referenced');
            assert.ok(fs.existsSync(wip.artifactPath));
        }
        assert.equal(fs.existsSync(wip.manifestPath), true);
    });

    it('blocks removal for same-task and cross-task unfinished references with exact task boundaries', () => {
        const wip = createWip(root);
        writeQueue(root, [{ taskId: 'T-CLEAN-1', status: 'BLOCKED' },
            { taskId: 'T-CLEAN-10', status: 'DECOMPOSED' }]);
        event(root, 'T-CLEAN-1', 'FULL_SUITE_REPAIR_TASK_MATERIALIZED', { wip_manifest_path: wip.manifestPath });
        event(root, 'T-CLEAN-10', 'FULL_SUITE_REPAIR_TASK_MATERIALIZED', { wip_manifest_path: wip.manifestPath });
        const result = preview({ targetRoot: root, taskIds: ['T-CLEAN-1'] });
        assert.equal(result.status, 'BLOCKED');
        assert.equal(result.packages[0].classification, 'referenced');
        assert.deepEqual(result.packages[0].reference_task_ids, ['T-CLEAN-1', 'T-CLEAN-10']);
        assert.equal(fs.existsSync(wip.artifactPath), true);
    });

    it('blocks surviving references from same-owner sibling lifecycle events', () => {
        const selected = createWip(root), sibling = createWip(root, { ordinal: 2, retired: false });
        writeQueue(root, [{ taskId: 'T-CLEAN-1', status: 'BLOCKED' }]);
        const selection = { targetRoot: root, taskIds: ['T-CLEAN-1'], manifestPaths: [selected.manifestPath] };
        const unreferenced = preview(selection);
        assert.equal(unreferenced.status, 'READY', unreferenced.blockers.join('\n'));
        assert.equal(retireSplitRequiredWip({ repoRoot: root, taskId: 'T-CLEAN-1',
            manifestPath: sibling.manifestPath, reason: `Required source remains at ${selected.artifactPath}` }).status, 'RETIRED');
        const before = treeSnapshot(root), result = preview(selection);
        assert.equal(result.status, 'BLOCKED', result.blockers.join('\n'));
        assert.equal(result.packages[0].classification, 'referenced');
        assert.deepEqual(result.packages[0].reference_task_ids, ['T-CLEAN-1']);
        assert.equal(remove(selection, unreferenced.ownership_digest).status, 'BLOCKED');
        assert.equal(remove(selection, result.ownership_digest).status, 'BLOCKED');
        assert.equal(treeSnapshot(root), before);
    });

    it('blocks malformed same-owner lifecycle details before exemption', () => {
        const classifications: string[] = [];
        const eventTypes = ['SPLIT_REQUIRED_WIP_CAPTURED', 'SPLIT_REQUIRED_WIP_RETIRED', 'SPLIT_REQUIRED_WIP_RESTORED'];
        for (const [index, eventType] of eventTypes.entries()) {
            const caseRoot = path.join(root, `malformed-lifecycle-${index}`);
            fs.mkdirSync(caseRoot);
            writeQueue(caseRoot, [{ taskId: 'T-CLEAN-1', status: 'DONE' }]);
            const wip = createWip(caseRoot);
            writeQueue(caseRoot, [{ taskId: 'T-CLEAN-1', status: 'BLOCKED' }]);
            const selection = { targetRoot: caseRoot, taskIds: ['T-CLEAN-1'] }, unreferenced = preview(selection);
            assert.equal(unreferenced.status, 'READY', unreferenced.blockers.join('\n'));
            event(caseRoot, 'T-CLEAN-1', eventType, { manifest_path: [wip.manifestPath] });
            const before = treeSnapshot(caseRoot), result = preview(selection);
            assert.equal(result.status, 'BLOCKED', result.blockers.join('\n'));
            classifications.push(result.packages[0].classification);
            assert.equal(remove(selection, unreferenced.ownership_digest).status, 'BLOCKED');
            assert.equal(treeSnapshot(caseRoot), before);
        }
        assert.deepEqual(classifications, ['ambiguous', 'ambiguous', 'ambiguous']);
    });

    it('blocks malformed timeline event types that suppress unfinished WIP references', () => {
        const classifications: string[] = [];
        const eventTypes = ['SPLIT_REQUIRED_WIP_CAPTURED', 'SPLIT_REQUIRED_WIP_RETIRED', 'SPLIT_REQUIRED_WIP_RESTORED'];
        for (const [index, eventType] of eventTypes.entries()) {
            const caseRoot = path.join(root, `malformed-event-${index}`);
            fs.mkdirSync(caseRoot);
            writeQueue(caseRoot, [{ taskId: 'T-CLEAN-1', status: 'DONE' }]);
            const wip = createWip(caseRoot), selection = { targetRoot: caseRoot, taskIds: ['T-CLEAN-1'] };
            writeQueue(caseRoot, [{ taskId: 'T-CLEAN-1', status: 'BLOCKED' }]);
            const unreferenced = preview(selection);
            assert.equal(unreferenced.status, 'READY', unreferenced.blockers.join('\n'));
            event(caseRoot, 'T-CLEAN-1', [eventType] as unknown as string, { wip_manifest_path: wip.manifestPath });
            const result = preview(selection), before = treeSnapshot(caseRoot);
            assert.equal(result.status, 'BLOCKED', result.blockers.join('\n'));
            classifications.push(result.packages[0].classification);
            assert.equal(remove(selection, unreferenced.ownership_digest).status, 'BLOCKED');
            assert.equal(treeSnapshot(caseRoot), before);
        }
        assert.deepEqual(classifications, ['ambiguous', 'ambiguous', 'ambiguous']);
    });

    it('blocks Windows case-variant references from unfinished Notes and free-form timeline details',
        { skip: process.platform !== 'win32' }, () => {
            const wip = createWip(root), selection = { targetRoot: root, taskIds: ['T-CLEAN-1'] };
            const unreferenced = preview(selection);
            const relative = path.relative(root, wip.manifestPath).toUpperCase().replace(/\//gu, '\\');
            writeQueue(root, [{ taskId: 'T-CLEAN-1', status: 'DONE' },
                { taskId: 'T-SURVIVOR', status: 'TODO', notes: `[Required source](${relative})` }]);
            const fromNotes = preview(selection), before = treeSnapshot(root);
            assert.equal(fromNotes.status, 'BLOCKED');
            assert.deepEqual(fromNotes.packages[0].reference_task_ids, ['T-SURVIVOR']);
            assert.equal(remove(selection, unreferenced.ownership_digest).status, 'BLOCKED');
            assert.equal(treeSnapshot(root), before);
            writeQueue(root, [{ taskId: 'T-CLEAN-1', status: 'DONE' }, { taskId: 'T-SURVIVOR', status: 'TODO' }]);
            event(root, 'T-SURVIVOR', 'WIP_REFERENCE_RECORDED', { reason: `Required source: ${relative}` });
            const fromTimeline = preview(selection);
            assert.equal(fromTimeline.status, 'BLOCKED');
            assert.deepEqual(fromTimeline.packages[0].reference_task_ids, ['T-SURVIVOR']);
            assert.equal(fs.existsSync(wip.artifactPath), true);
        });

    it('blocks path traversal aliases in unfinished Notes and free-form timeline references', () => {
        const segments = ['/split-required/./', '/split-required/../split-required/', '/split-required//'];
        const statuses: string[] = [];
        for (const [index, segment] of segments.entries()) {
            const caseRoot = path.join(root, `reference-alias-${index}`);
            fs.mkdirSync(caseRoot);
            writeQueue(caseRoot, [{ taskId: 'T-CLEAN-1', status: 'DONE' }]);
            const wip = createWip(caseRoot), selection = { targetRoot: caseRoot, taskIds: ['T-CLEAN-1'] };
            const unreferenced = preview(selection);
            assert.equal(unreferenced.status, 'READY', unreferenced.blockers.join('\n'));
            const relative = path.relative(caseRoot, wip.manifestPath).replace(/\\/gu, '/');
            const alias = relative.replace('/split-required/', segment);
            assert.equal(path.resolve(caseRoot, alias), wip.manifestPath);
            writeQueue(caseRoot, [{ taskId: 'T-CLEAN-1', status: 'DONE' },
                { taskId: 'T-SURVIVOR', status: 'TODO', notes: `Keep [required source](${alias}). Also inspect sibling/../notes.` }]);
            const fromNotes = preview(selection), beforeNotes = treeSnapshot(caseRoot);
            assert.equal(fromNotes.status, 'BLOCKED', alias);
            assert.equal(fromNotes.packages[0].classification, 'referenced');
            assert.deepEqual(fromNotes.packages[0].reference_task_ids, ['T-SURVIVOR']);
            assert.equal(remove(selection, fromNotes.ownership_digest).status, 'BLOCKED');
            assert.equal(treeSnapshot(caseRoot), beforeNotes);
            writeQueue(caseRoot, [{ taskId: 'T-CLEAN-1', status: 'DONE' }, { taskId: 'T-SURVIVOR', status: 'TODO' }]);
            event(caseRoot, 'T-SURVIVOR', 'WIP_REFERENCE_RECORDED', {
                notes: [{ reason: `Required source: ${alias}; unrelated location: sibling/../notes` }]
            });
            const fromTimeline = preview(selection), beforeTimeline = treeSnapshot(caseRoot);
            statuses.push(fromNotes.status, fromTimeline.status);
            assert.equal(fromTimeline.status, 'BLOCKED', alias);
            assert.equal(fromTimeline.packages[0].classification, 'referenced');
            assert.deepEqual(fromTimeline.packages[0].reference_task_ids, ['T-SURVIVOR']);
            assert.equal(remove(selection, fromTimeline.ownership_digest).status, 'BLOCKED');
            assert.equal(treeSnapshot(caseRoot), beforeTimeline);
            assert.equal(fs.existsSync(wip.artifactPath), true);
        }
        assert.deepEqual(statuses, ['BLOCKED', 'BLOCKED', 'BLOCKED', 'BLOCKED', 'BLOCKED', 'BLOCKED']);
    });

    it('blocks repository-parent re-entry references in unfinished Notes and timeline details', () => {
        const statuses: string[] = [];
        for (const [prefixIndex, prefix] of ['..', 'src/../..'].entries()) {
            for (const kind of ['manifest', 'directory', 'artifact']) {
                for (const suffix of ['ordinary', 'with spaces', 'with (parentheses)', 'with [brackets]', "with apostrophe's"]) {
                    const caseRoot = path.join(root, `repository-reentry-${prefixIndex}-${kind}-${suffix}`);
                    fs.mkdirSync(caseRoot);
                    writeQueue(caseRoot, [{ taskId: 'T-CLEAN-1', status: 'DONE' }]);
                    const wip = createWip(caseRoot), selection = { targetRoot: caseRoot, taskIds: ['T-CLEAN-1'] };
                    const unreferenced = preview(selection);
                    assert.equal(unreferenced.status, 'READY', unreferenced.blockers.join('\n'));
                    const target = kind === 'manifest' ? wip.manifestPath : kind === 'directory' ? wip.packageRoot : wip.artifactPath;
                    const relative = path.relative(caseRoot, target).replace(/\\/gu, '/');
                    const alias = `${prefix}/${path.basename(caseRoot)}/${relative}`;
                    assert.equal(path.resolve(caseRoot, alias), target);
                    writeQueue(caseRoot, [{ taskId: 'T-CLEAN-1', status: 'DONE' },
                        { taskId: 'T-SURVIVOR', status: 'TODO', notes: `Keep [required source](${alias}). Also inspect sibling/../notes.` }]);
                    const fromNotes = preview(selection), beforeNotes = treeSnapshot(caseRoot);
                    assert.equal(fromNotes.status, 'BLOCKED', alias);
                    assert.equal(fromNotes.packages[0].classification, 'referenced');
                    assert.deepEqual(fromNotes.packages[0].reference_task_ids, ['T-SURVIVOR']);
                    assert.equal(remove(selection, fromNotes.ownership_digest).status, 'BLOCKED');
                    assert.equal(treeSnapshot(caseRoot), beforeNotes);
                    writeQueue(caseRoot, [{ taskId: 'T-CLEAN-1', status: 'DONE' }, { taskId: 'T-SURVIVOR', status: 'TODO' }]);
                    event(caseRoot, 'T-SURVIVOR', 'WIP_REFERENCE_RECORDED', {
                        notes: [{ reason: `Required source: ${alias}; unrelated location: sibling/../notes` }]
                    });
                    const fromTimeline = preview(selection), beforeTimeline = treeSnapshot(caseRoot);
                    assert.equal(fromTimeline.status, 'BLOCKED', alias);
                    assert.equal(fromTimeline.packages[0].classification, 'referenced');
                    assert.deepEqual(fromTimeline.packages[0].reference_task_ids, ['T-SURVIVOR']);
                    assert.equal(remove(selection, fromTimeline.ownership_digest).status, 'BLOCKED');
                    assert.equal(treeSnapshot(caseRoot), beforeTimeline);
                    statuses.push(fromNotes.status, fromTimeline.status);
                }
            }
        }
        assert.deepEqual(statuses, Array<string>(60).fill('BLOCKED'));
    });

    it('blocks over-budget delimited alias resolution before cleanup', () => {
        const statuses: string[] = [];
        for (const budget of ['length', 'checks']) {
            const caseRoot = path.join(root, `alias-budget-${budget} (parentheses)`);
            fs.mkdirSync(caseRoot);
            writeQueue(caseRoot, [{ taskId: 'T-CLEAN-1', status: 'DONE' }]);
            const wip = createWip(caseRoot), selection = { targetRoot: caseRoot, taskIds: ['T-CLEAN-1'] };
            assert.equal(preview(selection).status, 'READY');
            const relative = path.relative(caseRoot, wip.packageRoot).replace(/\\/gu, '/');
            const alias = `${'x'.repeat(32_769)}/../../${path.basename(caseRoot)}/${relative}`;
            assert.equal(path.resolve(caseRoot, alias), wip.packageRoot);
            const notes = budget === 'length' ? `Required source: ${alias};`
                : Array<string>(140).fill(`unrelated/${relative}`).join(' ');
            writeQueue(caseRoot, [{ taskId: 'T-CLEAN-1', status: 'DONE' },
                { taskId: 'T-SURVIVOR', status: 'TODO', notes }]);
            const before = treeSnapshot(caseRoot), planned = preview(selection);
            assert.equal(planned.status, 'BLOCKED');
            assert.equal(planned.packages[0].classification, 'ambiguous');
            assert.match(planned.blockers.join('\n'), /alias.*bounded/iu);
            assert.equal(remove(selection, planned.ownership_digest).status, 'BLOCKED');
            assert.equal(treeSnapshot(caseRoot), before);
            statuses.push(planned.status);
        }
        assert.deepEqual(statuses, ['BLOCKED', 'BLOCKED']);
    });

    it('blocks package directory and artifact references from unfinished Notes and timeline details', () => {
        const statuses: string[] = [];
        for (const kind of ['directory', 'artifact', 'aliased-artifact']) {
            const caseRoot = path.join(root, `package-reference-${kind}`);
            fs.mkdirSync(caseRoot);
            writeQueue(caseRoot, [{ taskId: 'T-CLEAN-1', status: 'DONE' }]);
            const wip = createWip(caseRoot), selection = { targetRoot: caseRoot, taskIds: ['T-CLEAN-1'] };
            const relativePackage = path.relative(caseRoot, wip.packageRoot).replace(/\\/gu, '/');
            const relativeArtifact = path.relative(caseRoot, wip.artifactPath).replace(/\\/gu, '/');
            const reference = kind === 'directory' ? relativePackage : kind === 'artifact'
                ? wip.artifactPath : relativeArtifact.replace('/split-required/', '/split-required/../split-required/');
            writeQueue(caseRoot, [{ taskId: 'T-CLEAN-1', status: 'DONE' }, {
                taskId: 'T-SURVIVOR', status: 'TODO',
                notes: `Other packages: ${relativePackage}-unrelated/untracked/src/generated.ts and elsewhere/${relativeArtifact}`
            }]);
            const unrelated = preview(selection);
            assert.equal(unrelated.status, 'READY', unrelated.blockers.join('\n'));
            writeQueue(caseRoot, [{ taskId: 'T-CLEAN-1', status: 'DONE' },
                { taskId: 'T-SURVIVOR', status: 'TODO', notes: `Keep [required source](${reference}). Also inspect sibling/../notes.` }]);
            const fromNotes = preview(selection), beforeNotes = treeSnapshot(caseRoot);
            assert.equal(fromNotes.status, 'BLOCKED', reference);
            assert.equal(fromNotes.packages[0].classification, 'referenced');
            assert.deepEqual(fromNotes.packages[0].reference_task_ids, ['T-SURVIVOR']);
            assert.equal(remove(selection, fromNotes.ownership_digest).status, 'BLOCKED');
            assert.equal(treeSnapshot(caseRoot), beforeNotes);
            writeQueue(caseRoot, [{ taskId: 'T-CLEAN-1', status: 'DONE' }, { taskId: 'T-SURVIVOR', status: 'TODO' }]);
            event(caseRoot, 'T-SURVIVOR', 'WIP_REFERENCE_RECORDED', {
                notes: [{ reason: `Required source: ${reference}; unrelated location: sibling/../notes` }]
            });
            const fromTimeline = preview(selection), beforeTimeline = treeSnapshot(caseRoot);
            statuses.push(fromNotes.status, fromTimeline.status);
            assert.equal(fromTimeline.status, 'BLOCKED', reference);
            assert.deepEqual(fromTimeline.packages[0].reference_task_ids, ['T-SURVIVOR']);
            assert.equal(remove(selection, fromTimeline.ownership_digest).status, 'BLOCKED');
            assert.equal(treeSnapshot(caseRoot), beforeTimeline);
            assert.equal(fs.existsSync(wip.artifactPath), true);
        }
        assert.deepEqual(statuses, ['BLOCKED', 'BLOCKED', 'BLOCKED', 'BLOCKED', 'BLOCKED', 'BLOCKED']);
    });

    it('blocks removal for prepared and pending restore handoffs even for a retired owner', () => {
        const wip = createPendingWipRestore(root);
        assert.equal(retireSplitRequiredWip({ repoRoot: root, taskId: 'T-CLEAN-1',
            manifestPath: wip.manifestPath, reason: 'Outstanding restore state remains protected.' }).status, 'RETIRED');
        writeQueue(root, [{ taskId: 'T-CLEAN-1', status: 'DONE' }]);
        for (const handoff of [wip.prepared, wip.handoff]) {
            fs.writeFileSync(wip.identity.handoffPath, JSON.stringify(handoff));
            const result = preview({ targetRoot: root, taskIds: ['T-CLEAN-1'] });
            assert.equal(result.status, 'BLOCKED');
            assert.equal(result.packages[0].classification, 'referenced');
            assert.ok(result.blockers.some(blocker => /handoff/iu.test(blocker)));
        }
        assert.equal(fs.existsSync(wip.manifestPath), true);
    });

    it('blocks malformed queue breaks that hide later unfinished WIP references', () => {
        const wip = createWip(root), selection = { targetRoot: root, taskIds: ['T-CLEAN-1'] };
        const unreferenced = preview(selection);
        writeQueue(root, [{ taskId: 'T-CLEAN-1', status: 'DONE' },
            { taskId: 'T-BREAK', status: 'TODO' },
            { taskId: 'T-SURVIVOR', status: 'TODO', notes: wip.manifestPath }]);
        const queuePath = path.join(root, 'TASK.md'), validQueue = fs.readFileSync(queuePath, 'utf8');
        const classifications: string[] = [];
        for (const broken of [validQueue.replace('| T-BREAK', 'T-BREAK'),
            validQueue.replace('| T-BREAK', '\n| T-BREAK')]) {
            fs.writeFileSync(queuePath, broken);
            const result = preview(selection), before = treeSnapshot(root);
            assert.equal(result.status, 'BLOCKED', result.blockers.join('\n'));
            classifications.push(result.packages[0].classification);
            assert.equal(remove(selection, unreferenced.ownership_digest).status, 'BLOCKED');
            assert.equal(treeSnapshot(root), before);
        }
        assert.deepEqual(classifications, ['ambiguous', 'ambiguous']);
        fs.writeFileSync(queuePath, validQueue);
        assert.deepEqual(preview(selection).packages[0].reference_task_ids, ['T-SURVIVOR']);
    });

    it('blocks incomplete finalized handoffs even with integrity-valid matching restore events', () => {
        const wip = createWip(root), handoffId = 'b'.repeat(64);
        const handoffPath = path.join(wip.packageRoot, `restore-handoff-${handoffId}.json`);
        const restored = event(root, 'T-CLEAN-1', 'SPLIT_REQUIRED_WIP_RESTORED', {
            handoff_id: handoffId, handoff_path: handoffPath, manifest_path: wip.manifestPath
        }, 'PASS');
        fs.writeFileSync(handoffPath, JSON.stringify({ schema_version: 1,
            kind: 'split_required_wip_restore_handoff', status: 'finalized', task_id: 'T-CLEAN-1',
            repo_root: root, manifest_path: wip.manifestPath, handoff_id: handoffId,
            event_integrity: restored.integrity }));
        const selection = { targetRoot: root, taskIds: ['T-CLEAN-1'] };
        const result = preview(selection), before = treeSnapshot(root);
        assert.equal(result.status, 'BLOCKED', result.blockers.join('\n'));
        assert.equal(result.packages[0].classification, 'ambiguous');
        assert.equal(remove(selection, result.ownership_digest).status, 'BLOCKED');
        assert.equal(treeSnapshot(root), before);
    });

    it('admits production finalized restore ownership and preserves restored source after cleanup', () => {
        const wip = createPendingWipRestore(root), generation = {
            build_root: path.join(root, 'dist'), input_fingerprint_sha256: 'a'.repeat(64),
            finalizer_sha256: 'b'.repeat(64), writer_sha256: 'c'.repeat(64)
        };
        assert.equal(finalizeSplitRequiredWipRestoreHandoff(wip.identity, () => generation).status, 'RESTORED');
        assert.equal(retireSplitRequiredWip({ repoRoot: root, taskId: 'T-CLEAN-1',
            manifestPath: wip.manifestPath, reason: 'Restored work is no longer required in WIP.' }).status, 'RETIRED');
        writeQueue(root, [{ taskId: 'T-CLEAN-1', status: 'BLOCKED' }]);
        const handoff = JSON.parse(fs.readFileSync(wip.identity.handoffPath, 'utf8'));
        handoff.runtime_generation = Object.fromEntries(Object.entries(handoff.runtime_generation).reverse());
        handoff.timeline_anchor = Object.fromEntries(Object.entries(handoff.timeline_anchor).reverse());
        fs.writeFileSync(wip.identity.handoffPath, JSON.stringify(handoff));
        assert.equal(preview({ targetRoot: root, taskIds: ['T-CLEAN-1'] }).status, 'READY');
        const selectedManifest = process.platform === 'win32'
            ? path.join(root, path.relative(root, path.dirname(wip.manifestPath)).toUpperCase(), 'manifest.json')
            : wip.manifestPath;
        const selection = { targetRoot: root, taskIds: ['T-CLEAN-1'], manifestPaths: [selectedManifest] };
        const before = treeSnapshot(root);
        const result = preview(selection);
        assert.equal(result.status, 'READY', result.blockers.join('\n'));
        assert.equal(result.packages[0].classification, 'retired-orphan');
        assert.equal(treeSnapshot(root), before);
        assert.equal(remove(selection, result.ownership_digest).status, 'REMOVED');
        assert.equal(fs.readFileSync(path.join(root, 'src/tracked.ts'), 'utf8'), 'export const tracked = 2;\n');
        assert.equal(fs.readFileSync(path.join(root, 'src/generated.ts'), 'utf8'), 'export const generated = 1;\n');
    });

    it('blocks malformed finalized restore fields paired with matching canonical event values', () => {
        const classifications: string[] = [];
        const mutations: Array<{ field: string; value?: unknown }> = [
            { field: 'manifest_sha256' }, { field: 'selected_paths' }, { field: 'restored_files' },
            { field: 'runtime_generation' }, { field: 'selected_paths', value: [23] },
            { field: 'restored_files', value: null }, { field: 'runtime_generation', value: {} }
        ];
        for (const [index, mutation] of mutations.entries()) {
            const caseRoot = path.join(root, `malformed-${index}`);
            fs.mkdirSync(caseRoot);
            const wip = createPendingWipRestore(caseRoot), generation = {
                build_root: path.join(caseRoot, 'dist'), input_fingerprint_sha256: 'a'.repeat(64),
                finalizer_sha256: 'b'.repeat(64), writer_sha256: 'c'.repeat(64)
            };
            const handoff: Record<string, unknown> = { ...wip.handoff, status: 'finalized',
                finalized_at_utc: new Date().toISOString(), runtime_generation: generation };
            const details: Record<string, unknown> = { handoff_id: wip.identity.handoffId,
                handoff_path: wip.identity.handoffPath, manifest_path: wip.manifestPath,
                manifest_sha256: wip.identity.manifestSha256, selected_paths: wip.identity.selectedPaths,
                restored_files: wip.identity.restoredFiles, runtime_generation: generation };
            if ('value' in mutation) { handoff[mutation.field] = mutation.value; details[mutation.field] = mutation.value; }
            else { delete handoff[mutation.field]; delete details[mutation.field]; }
            const restored = event(caseRoot, 'T-CLEAN-1', 'SPLIT_REQUIRED_WIP_RESTORED', details, 'PASS');
            handoff.event_integrity = restored.integrity;
            fs.writeFileSync(wip.identity.handoffPath, JSON.stringify(handoff));
            assert.equal(retireSplitRequiredWip({ repoRoot: caseRoot, taskId: 'T-CLEAN-1',
                manifestPath: wip.manifestPath, reason: 'Malformed restore authority regression.' }).status, 'RETIRED');
            writeQueue(caseRoot, [{ taskId: 'T-CLEAN-1', status: 'DONE' }]);
            const selection = { targetRoot: caseRoot, taskIds: ['T-CLEAN-1'] }, result = preview(selection);
            const before = treeSnapshot(caseRoot);
            assert.equal(result.status, 'BLOCKED', `${mutation.field}: ${result.blockers.join('\n')}`);
            classifications.push(result.packages[0].classification);
            assert.equal(remove(selection, result.ownership_digest).status, 'BLOCKED');
            assert.equal(treeSnapshot(caseRoot), before);
        }
        assert.deepEqual(classifications, Array(mutations.length).fill('ambiguous'));
    });

    it('blocks aggregate authority reads before opening bytes beyond the shared budget', () => {
        const first = path.join(root, 'first.jsonl'), second = path.join(root, 'second.jsonl');
        fs.writeFileSync(first, '12345678');
        fs.writeFileSync(second, 'abcdefgh');
        const budget = { remainingBytes: 12, remainingEntries: 10 };
        assert.equal(readWipCleanupFile(root, first, 64, budget).content.toString(), '12345678');
        const original = fs.openSync;
        let opened = false;
        mock.method(fs, 'openSync', (...args: unknown[]) => {
            if (resolveMockFilesystemPath(String(args[0])) === resolveMockFilesystemPath(second)) opened = true;
            return Reflect.apply(original, fs, args);
        });
        assert.throws(() => readWipCleanupFile(root, second, 64, budget), /aggregate read budget/u);
        assert.equal(opened, false);
        assert.equal(fs.readFileSync(second, 'utf8'), 'abcdefgh');
    });

    it('charges rejected manifests to the shared budget before opening later packages', () => {
        const openedLater: boolean[] = [];
        const chargedBytes: number[] = [], expectedCharges: number[] = [];
        const original = fs.openSync;
        for (const kind of ['json', 'schema']) {
            const caseRoot = path.join(root, `manifest-budget-${kind}`);
            fs.mkdirSync(caseRoot);
            writeQueue(caseRoot, [{ taskId: 'T-CLEAN-1', status: 'DONE' }]);
            const first = createWip(caseRoot, { ordinal: 1 }), second = createWip(caseRoot, { ordinal: 2 });
            const firstContent = kind === 'json' ? '{' : JSON.stringify({ ...first.manifest, schema_version: 2 });
            fs.writeFileSync(first.manifestPath, firstContent);
            fs.writeFileSync(second.manifestPath, JSON.stringify({ ...second.manifest, schema_version: 2 }));
            const firstBytes = Buffer.byteLength(firstContent), secondBytes = fs.statSync(second.manifestPath).size;
            const budget = { remainingBytes: firstBytes + secondBytes - 1, remainingEntries: 10 };
            assert.throws(() => readAuthenticatedWipPackage(caseRoot, 'T-CLEAN-1', first.manifestPath, budget));
            chargedBytes.push(firstBytes + secondBytes - 1 - budget.remainingBytes);
            expectedCharges.push(firstBytes);
            let opened = false;
            mock.method(fs, 'openSync', (...args: unknown[]) => {
                if (resolveMockFilesystemPath(String(args[0])) === resolveMockFilesystemPath(second.manifestPath)) opened = true;
                return Reflect.apply(original, fs, args);
            });
            assert.throws(() => readAuthenticatedWipPackage(caseRoot, 'T-CLEAN-1', second.manifestPath, budget), /aggregate read budget/u);
            openedLater.push(opened);
            mock.restoreAll();
            assert.equal(fs.readFileSync(first.manifestPath, 'utf8'), firstContent);
            assert.equal(fs.existsSync(second.artifactPath), true);
        }
        assert.deepEqual(chargedBytes, expectedCharges);
        assert.deepEqual(openedLater, [false, false]);
    });

    it('keeps queue ownership scoped to the canonical section and rejects duplicate Active Queue sections', () => {
        const wip = createWip(root), queuePath = path.join(root, 'TASK.md');
        const valid = fs.readFileSync(queuePath, 'utf8');
        fs.appendFileSync(queuePath, '\n## User Summary (RU)\n\n| A malformed historical summary |\n');
        assert.equal(preview({ targetRoot: root, taskIds: ['T-CLEAN-1'] }).status, 'READY');
        fs.writeFileSync(queuePath, `${valid}\n## Active Queue\n${valid}`);
        const result = preview({ targetRoot: root, taskIds: ['T-CLEAN-1'] });
        assert.equal(result.status, 'BLOCKED');
        assert.equal(result.packages[0].classification, 'ambiguous');
        assert.equal(fs.existsSync(wip.manifestPath), true);
    });

    it('blocks missing corrupt or conflicting canonical retirement evidence', () => {
        const wip = createWip(root);
        const timeline = path.join(root, 'garda-agent-orchestrator/runtime/task-events/T-CLEAN-1.jsonl');
        const valid = fs.readFileSync(timeline);
        fs.unlinkSync(timeline);
        assert.equal(preview({ targetRoot: root, taskIds: ['T-CLEAN-1'] }).status, 'BLOCKED');
        fs.writeFileSync(timeline, Buffer.concat([valid, Buffer.from('{bad-json\n')]));
        assert.equal(preview({ targetRoot: root, taskIds: ['T-CLEAN-1'] }).status, 'BLOCKED');
        fs.writeFileSync(timeline, valid);
        event(root, 'T-CLEAN-1', 'SPLIT_REQUIRED_WIP_RETIRED', {
            manifest_path: wip.manifestPath, manifest_sha256: 'c'.repeat(64), reason: 'Conflicting ownership.'
        });
        const result = preview({ targetRoot: root, taskIds: ['T-CLEAN-1'] });
        assert.equal(result.status, 'BLOCKED');
        assert.equal(result.packages[0].classification, 'ambiguous');
        assert.equal(fs.existsSync(wip.artifactPath), true);
    });

    it('blocks non-string manifest enums even with matching canonical retirement authority', () => {
        const classifications: string[] = [];
        for (const [index, field] of ['status', 'guard_kind'].entries()) {
            const wip = createWip(root, { ordinal: index + 1, retired: false });
            const manifest = { ...wip.manifest, status: 'retired',
                retired_at_utc: '2026-10-02T01:00:00.000Z', retired_reason: 'Schema admission regression.' };
            const malformed: Record<string, unknown> = { ...manifest, [field]: [manifest[field as 'status' | 'guard_kind']] };
            fs.writeFileSync(wip.manifestPath, `${JSON.stringify(malformed, null, 2)}\n`);
            event(root, 'T-CLEAN-1', 'SPLIT_REQUIRED_WIP_RETIRED', {
                manifest_path: wip.manifestPath, manifest_sha256: sha256(fs.readFileSync(wip.manifestPath)),
                reason: malformed.retired_reason
            });
            const selection = { targetRoot: root, taskIds: ['T-CLEAN-1'], manifestPaths: [wip.manifestPath] };
            const result = preview(selection), before = treeSnapshot(root);
            assert.equal(result.status, 'BLOCKED', `${field}: ${result.blockers.join('\n')}`);
            classifications.push(result.packages[0].classification);
            assert.equal(remove(selection, result.ownership_digest).status, 'BLOCKED');
            assert.equal(treeSnapshot(root), before);
        }
        assert.deepEqual(classifications, ['ambiguous', 'ambiguous']);
    });

    it('blocks malformed schema foreign identity and undeclared package files', () => {
        const wip = createWip(root);
        const original = fs.readFileSync(wip.manifestPath);
        for (const mutation of [{ schema_version: 2 }, { task_id: 'T-CLEAN-10' }, { untracked_files: null }]) {
            fs.writeFileSync(wip.manifestPath, JSON.stringify({ ...wip.manifest, ...mutation }));
            assert.equal(preview({ targetRoot: root, taskIds: ['T-CLEAN-1'] }).status, 'BLOCKED');
        }
        fs.writeFileSync(wip.manifestPath, original);
        fs.writeFileSync(path.join(wip.packageRoot, 'unknown-source.txt'), 'must remain');
        const result = preview({ targetRoot: root, taskIds: ['T-CLEAN-1'] });
        assert.equal(result.status, 'BLOCKED');
        assert.ok(result.blockers.some(blocker => /undeclared|unknown/iu.test(blocker)));
        assert.equal(fs.existsSync(wip.artifactPath), true);
    });

    it('blocks hardlinked artifacts and junction packages while preserving foreign data', () => {
        const wip = createWip(root);
        const external = path.join(root, 'foreign-source.ts');
        fs.linkSync(wip.artifactPath, external);
        assert.equal(preview({ targetRoot: root, taskIds: ['T-CLEAN-1'] }).status, 'BLOCKED');
        fs.unlinkSync(external);
        const moved = path.join(root, 'foreign-package');
        fs.renameSync(wip.packageRoot, moved);
        fs.symlinkSync(moved, wip.packageRoot, process.platform === 'win32' ? 'junction' : 'dir');
        const result = preview({ targetRoot: root, taskIds: ['T-CLEAN-1'] });
        assert.equal(result.status, 'BLOCKED');
        assert.equal(fs.readFileSync(path.join(moved, 'untracked/src/generated.ts'), 'utf8'), 'export const preservedSource = 1;\n');
    });

    it('blocks invalid authority with shared bounded diagnostics for all selected packages', () => {
        const selected = Array.from({ length: 4 }, (_, index) => createWip(root, { ordinal: index + 1 }));
        const unfinishedIds = Array.from({ length: 16 }, (_, index) => `T-CLEAN-${index + 10}`);
        writeQueue(root, [{ taskId: 'T-CLEAN-1', status: 'DONE' },
            ...unfinishedIds.map(taskId => ({ taskId, status: 'BLOCKED' }))]);
        const selection = { targetRoot: root, taskIds: ['T-CLEAN-1'], manifestPaths: selected.map(item => item.manifestPath) };
        const before = treeSnapshot(root), result = preview(selection);
        assert.equal(result.status, 'BLOCKED');
        assert.equal(result.package_count, selected.length);
        assert.ok(result.packages.every(item => item.classification === 'ambiguous'));
        assert.ok(unfinishedIds.every(taskId => result.blockers.filter(blocker => blocker.includes(`task ${taskId} `)).length === 1),
            'Each missing timeline must retain one actionable global diagnostic.');
        const packageDiagnostics = JSON.stringify(result.packages.map(item => item.blockers));
        assert.ok(Buffer.byteLength(packageDiagnostics) < Buffer.byteLength(JSON.stringify(result.blockers)),
            'Shared authority diagnostics must not be multiplied across selected packages.');
        assert.ok(result.packages.every(item => item.blockers.length > 0
            && item.blockers.every(blocker => unfinishedIds.every(taskId => !blocker.includes(taskId)))));
        assert.equal(preview(selection).ownership_digest, result.ownership_digest);
        assert.equal(remove(selection, result.ownership_digest).status, 'BLOCKED');
        assert.equal(treeSnapshot(root), before);
    });

    it('blocks unreadable evidence and malformed duplicate or unknown-status queue rows', () => {
        const wip = createWip(root);
        const original = fs.openSync;
        mock.method(fs, 'openSync', (...args: unknown[]) => {
            if (resolveMockFilesystemPath(String(args[0])) === resolveMockFilesystemPath(wip.manifestPath)) throw Object.assign(new Error('Evidence unreadable'), { code: 'EACCES' });
            return Reflect.apply(original, fs, args);
        });
        assert.equal(preview({ targetRoot: root, taskIds: ['T-CLEAN-1'] }).status, 'BLOCKED');
        mock.restoreAll();
        writeQueue(root, [{ taskId: 'T-CLEAN-1', status: 'DONE' }, { taskId: 'T-CLEAN-1', status: 'TODO' }]);
        assert.equal(preview({ targetRoot: root, taskIds: ['T-CLEAN-1'] }).status, 'BLOCKED');
        writeQueue(root, [{ taskId: 'T-CLEAN-1', status: 'UNKNOWN' }]);
        assert.equal(preview({ targetRoot: root, taskIds: ['T-CLEAN-1'] }).status, 'BLOCKED');
        fs.appendFileSync(path.join(root, 'TASK.md'), '| T-CLEAN-10 | TODO | malformed |\n');
        assert.equal(preview({ targetRoot: root, taskIds: ['T-CLEAN-1'] }).status, 'BLOCKED');
        assert.equal(sha256(fs.readFileSync(wip.artifactPath)), wip.manifest.untracked_files[0].sha256);
    });
});
