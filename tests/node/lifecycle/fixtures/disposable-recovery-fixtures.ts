import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { removeBoundContainedPath } from '../../../../src/core/contained-filesystem';
import { fsyncDirectoryBestEffort } from '../../../../src/core/filesystem';
import { prepareOwnedDisposableArtifactRetirement, withOwnedDisposableRetirementMutation }
    from '../../../../src/lifecycle/cleanup/owned-disposable-artifact-journal';
import { readOwnedDisposableArtifactRecoverySnapshot } from '../../../../src/lifecycle/cleanup/owned-disposable-artifact-recovery-snapshot';
import { computeFileSha256 } from '../../gates/task-audit/task-audit-summary-fixtures';
import { fixture, taskId } from '../owned-disposable-artifact-fixtures';

export function recoveryFixture(t: TestContext, count = 1, dependency = false) {
    const f = fixture(t), producers = Array.from({ length: count }, () => f.produce());
    const note = path.join(f.reviews, `${taskId}-dependency-note.json`);
    if (dependency) fs.writeFileSync(note, '{"note":"original dependency"}\n');
    const preview = f.preview(...producers.map(item => item.registrationId));
    assert.equal(preview.status, 'READY', preview.blockers.join());
    const selection = { ...f.options, registrationIds: producers.map(item => item.registrationId), ownershipDigest: preview.ownership_digest! };
    const prepared = prepareOwnedDisposableArtifactRetirement({ ...selection, confirmed: true });
    assert.equal(prepared.status, 'PENDING', prepared.errors.join());
    const journal = prepared.journal_path!, directory = journal.replace(/\.json$/u, '.progress');
    const key = path.join(f.runtime, 'disposable-producers', '.authority-key');
    const files = [...producers.map(item => item.ownerPath), journal, key, path.join(f.runtime, 'task-ledger', `${taskId}.json`)];
    const read = () => readOwnedDisposableArtifactRecoverySnapshot(selection);
    function frames() { return fs.existsSync(directory) ? fs.readdirSync(directory).sort().map(name => [name, computeFileSha256(path.join(directory, name))]) : []; }
    function hashes() { return files.map(file => [file, computeFileSha256(file)]); }
    function payloadHashes() {
        const result: string[][] = [];
        function collect(file: string) {
            if (!fs.existsSync(file)) return;
            if (fs.lstatSync(file).isDirectory()) for (const name of fs.readdirSync(file)) collect(path.join(file, name));
            else result.push([file, computeFileSha256(file)]);
        }
        for (const producer of producers) collect(producer.payloadPath);
        return result.sort((left, right) => left[0].localeCompare(right[0]));
    }
    function prefix(removed: number, pending: 'none' | 'present' | 'absent' | 'error' = 'none') {
        withOwnedDisposableRetirementMutation({ ...selection, confirmed: true }, mutation => {
            for (let index = 0; index < removed; index += 1) {
                const entry = mutation.pending(); assert.ok(entry);
                removeBoundContainedPath(entry.binding, false, () => {
                    fsyncDirectoryBestEffort(path.dirname(entry.binding.path)); mutation.removed();
                });
            }
            if (pending !== 'none') {
                const entry = mutation.pending(); assert.ok(entry);
                if (pending === 'absent') removeBoundContainedPath(entry.binding, false);
                if (pending === 'error') mutation.fail('controlled original error');
            }
        });
    }
    return { ...f, selection, producers, journal, directory, key, note, read, frames, hashes, payloadHashes, prefix,
        alpha: path.join(producers[0].payloadPath, 'alpha.txt'), binary: path.join(producers[0].payloadPath, 'nested', 'bytes.bin') };
}
