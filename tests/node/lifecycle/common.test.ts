import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
    compareVersionStrings,
    copyDirectoryContentMerge,
    copyPathRecursive,
    createRollbackSnapshot,
    getRollbackRecordsPath,
    getSyncBackupMetadataPath,
    getTimestamp,
    readRollbackRecords,
    readSyncBackupMetadata,
    removePathRecursive,
    restoreRollbackSnapshot,
    restoreSyncedItemsFromBackup,
    syncWorkingTreeBundleItems,
    validateTargetRoot,
    writeRollbackRecords,
    writeSyncBackupMetadata
} from '../../../src/lifecycle/common';

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

function mkTmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'gao-lifecycle-common-'));
}

function canCreateSymlinks(): boolean {
    const dir = mkTmpDir();
    try {
        const target = path.join(dir, 'target');
        const link = path.join(dir, 'link');
        fs.mkdirSync(target, { recursive: true });
        fs.symlinkSync(target, link, 'junction');
        return fs.lstatSync(link).isSymbolicLink();
    } catch {
        return false;
    } finally {
        removePathRecursive(dir);
    }
}

const symlinkSupported = canCreateSymlinks();

describe('lifecycle control file links', () => {
    it('rejects linked sync backup metadata directory before reading JSON', { skip: !symlinkSupported && 'Symlinks/junctions not supported' }, () => {
        const root = mkTmpDir();
        try {
            const outside = path.join(root, 'outside');
            const backup = path.join(root, 'backup');
            fs.mkdirSync(outside);
            fs.writeFileSync(path.join(outside, 'sync-backup-metadata.json'),
                JSON.stringify({ preexistingMap: { VERSION: true } }));
            fs.symlinkSync(outside, backup, 'junction');
            assert.throws(() => readSyncBackupMetadata(backup), /symlink|junction/);
        } finally {
            removePathRecursive(root);
        }
    });
});

describe('compareVersionStrings', () => {
    it('returns 0 for equal versions', () => {
        assert.equal(compareVersionStrings('1.0.8', '1.0.8'), 0);
    });

    it('returns -1 when current is older', () => {
        assert.equal(compareVersionStrings('1.0.7', '1.0.8'), -1);
    });

    it('returns 1 when current is newer', () => {
        assert.equal(compareVersionStrings('1.0.9', '1.0.8'), 1);
    });

    it('handles v prefix', () => {
        assert.equal(compareVersionStrings('v1.0.8', 'V1.0.8'), 0);
        assert.equal(compareVersionStrings('v1.0.7', '1.0.8'), -1);
    });

    it('handles different segment counts', () => {
        assert.equal(compareVersionStrings('1.0', '1.0.0'), 0);
        assert.equal(compareVersionStrings('1.0', '1.0.1'), -1);
    });

    it('handles major version differences', () => {
        assert.equal(compareVersionStrings('1.9.9', '2.0.0'), -1);
        assert.equal(compareVersionStrings('2.0.0', '1.9.9'), 1);
    });

    it('treats prerelease as lower than the release version', () => {
        assert.equal(compareVersionStrings('1.0.0-alpha', '1.0.0'), -1);
        assert.equal(compareVersionStrings('1.0.0', '1.0.0-alpha'), 1);
        assert.equal(compareVersionStrings('2.0.0-rc.1', '2.0.0'), -1);
    });

    it('compares prerelease identifiers lexicographically', () => {
        assert.equal(compareVersionStrings('1.0.0-alpha', '1.0.0-beta'), -1);
        assert.equal(compareVersionStrings('1.0.0-beta', '1.0.0-alpha'), 1);
        assert.equal(compareVersionStrings('1.0.0-alpha', '1.0.0-alpha'), 0);
    });

    it('compares numeric prerelease identifiers numerically', () => {
        assert.equal(compareVersionStrings('1.0.0-1', '1.0.0-2'), -1);
        assert.equal(compareVersionStrings('1.0.0-2', '1.0.0-1'), 1);
        assert.equal(compareVersionStrings('1.0.0-alpha.1', '1.0.0-alpha.2'), -1);
        assert.equal(compareVersionStrings('1.0.0-alpha.2', '1.0.0-alpha.1'), 1);
        assert.equal(compareVersionStrings('1.0.0-beta.11', '1.0.0-beta.2'), 1);
    });

    it('ranks numeric prerelease identifiers below alphanumeric', () => {
        assert.equal(compareVersionStrings('1.0.0-1', '1.0.0-alpha'), -1);
        assert.equal(compareVersionStrings('1.0.0-alpha', '1.0.0-1'), 1);
    });

    it('longer prerelease set has higher precedence when prefix matches', () => {
        assert.equal(compareVersionStrings('1.0.0-alpha', '1.0.0-alpha.1'), -1);
        assert.equal(compareVersionStrings('1.0.0-alpha.1', '1.0.0-alpha'), 1);
    });

    it('ignores build metadata', () => {
        assert.equal(compareVersionStrings('1.0.0+build', '1.0.0'), 0);
        assert.equal(compareVersionStrings('1.0.0', '1.0.0+build'), 0);
        assert.equal(compareVersionStrings('1.0.0+build1', '1.0.0+build2'), 0);
    });

    it('handles prerelease combined with build metadata', () => {
        assert.equal(compareVersionStrings('1.0.0-alpha+build', '1.0.0-alpha'), 0);
        assert.equal(compareVersionStrings('1.0.0-alpha+build', '1.0.0'), -1);
    });

    it('follows full SemVer precedence chain', () => {
        const ordered = [
            '1.0.0-alpha',
            '1.0.0-alpha.1',
            '1.0.0-alpha.beta',
            '1.0.0-beta',
            '1.0.0-beta.2',
            '1.0.0-beta.11',
            '1.0.0-rc.1',
            '1.0.0'
        ];
        for (let i = 0; i < ordered.length; i++) {
            for (let j = i + 1; j < ordered.length; j++) {
                assert.equal(
                    compareVersionStrings(ordered[i], ordered[j]),
                    -1,
                    `Expected ${ordered[i]} < ${ordered[j]}`
                );
                assert.equal(
                    compareVersionStrings(ordered[j], ordered[i]),
                    1,
                    `Expected ${ordered[j]} > ${ordered[i]}`
                );
            }
        }
    });
});

describe('getTimestamp', () => {
    it('returns timestamp in expected format', () => {
        const ts = getTimestamp();
        assert.match(ts, /^\d{8}-\d{6}-\d{3}$/);
    });
});

describe('validateTargetRoot', () => {
    it('throws when targetRoot equals bundleRoot', () => {
        const dir = mkTmpDir();
        try {
            assert.throws(() => validateTargetRoot(dir, dir), /TargetRoot points to orchestrator bundle directory/);
        } finally {
            removePathRecursive(dir);
        }
    });

    it('returns normalized path when valid', () => {
        const dir = mkTmpDir();
        const bundleDir = path.join(dir, 'bundle');
        fs.mkdirSync(bundleDir);
        try {
            const result = validateTargetRoot(dir, bundleDir);
            assert.equal(result, path.resolve(dir));
        } finally {
            removePathRecursive(dir);
        }
    });
});

describe('copyPathRecursive and removePathRecursive', () => {
    it('copies files and directories recursively', () => {
        const dir = mkTmpDir();
        try {
            const src = path.join(dir, 'src');
            fs.mkdirSync(path.join(src, 'sub'), { recursive: true });
            fs.writeFileSync(path.join(src, 'a.txt'), 'hello');
            fs.writeFileSync(path.join(src, 'sub', 'b.txt'), 'world');

            const dst = path.join(dir, 'dst');
            copyPathRecursive(src, dst);

            assert.ok(fs.existsSync(path.join(dst, 'a.txt')));
            assert.ok(fs.existsSync(path.join(dst, 'sub', 'b.txt')));
            assert.equal(fs.readFileSync(path.join(dst, 'a.txt'), 'utf8'), 'hello');
            assert.equal(fs.readFileSync(path.join(dst, 'sub', 'b.txt'), 'utf8'), 'world');
        } finally {
            removePathRecursive(dir);
        }
    });

    it('rejects nested symlink or junction entries while copying directories', { skip: !symlinkSupported && 'Symlinks/junctions not supported' }, () => {
        const dir = mkTmpDir();
        try {
            const src = path.join(dir, 'src');
            const outside = path.join(dir, 'outside');
            const dst = path.join(dir, 'dst');
            fs.mkdirSync(src, { recursive: true });
            fs.mkdirSync(outside, { recursive: true });
            fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside-secret', 'utf8');
            fs.symlinkSync(outside, path.join(src, 'linked-outside'), 'junction');

            assert.throws(
                () => copyPathRecursive(src, dst),
                /Refusing to copy symlink or junction source/
            );
            assert.equal(fs.existsSync(path.join(dst, 'linked-outside', 'secret.txt')), false);
        } finally {
            removePathRecursive(dir);
        }
    });

    it('rejects destination symlink or junction entries while copying directories', { skip: !symlinkSupported && 'Symlinks/junctions not supported' }, () => {
        const dir = mkTmpDir();
        try {
            const src = path.join(dir, 'src');
            const dst = path.join(dir, 'dst');
            const outside = path.join(dir, 'outside');
            fs.mkdirSync(path.join(src, 'linked-destination'), { recursive: true });
            fs.writeFileSync(path.join(src, 'linked-destination', 'payload.txt'), 'new-data', 'utf8');
            fs.mkdirSync(dst, { recursive: true });
            fs.mkdirSync(outside, { recursive: true });
            fs.writeFileSync(path.join(outside, 'payload.txt'), 'outside-data', 'utf8');
            fs.symlinkSync(outside, path.join(dst, 'linked-destination'), 'junction');

            assert.throws(
                () => copyPathRecursive(src, dst),
                /Refusing to overwrite symlink or junction destination/
            );
            assert.equal(fs.readFileSync(path.join(outside, 'payload.txt'), 'utf8'), 'outside-data');
        } finally {
            removePathRecursive(dir);
        }
    });

    it('removePathRecursive removes directories', () => {
        const dir = mkTmpDir();
        const target = path.join(dir, 'target');
        fs.mkdirSync(path.join(target, 'a'), { recursive: true });
        fs.writeFileSync(path.join(target, 'a', 'file.txt'), 'data');
        removePathRecursive(target);
        assert.ok(!fs.existsSync(target));
        removePathRecursive(dir);
    });
});

describe('createRollbackSnapshot and restoreRollbackSnapshot', () => {
    it('creates snapshot and restores it', () => {
        const dir = mkTmpDir();
        try {
            // Set up initial state
            fs.writeFileSync(path.join(dir, 'file1.txt'), 'original');
            fs.mkdirSync(path.join(dir, 'subdir'));
            fs.writeFileSync(path.join(dir, 'subdir', 'file2.txt'), 'nested');

            const snapshotRoot = path.join(dir, '_snapshot');
            const records = createRollbackSnapshot(dir, snapshotRoot, ['file1.txt', 'subdir', 'missing.txt']);

            assert.equal(records.length, 3);
            assert.ok(records.find((r) => r.relativePath === 'file1.txt' && r.existed && r.pathType === 'file'));
            assert.ok(records.find((r) => r.relativePath === 'subdir' && r.existed && r.pathType === 'directory'));
            assert.ok(records.find((r) => r.relativePath === 'missing.txt' && !r.existed && r.pathType === 'missing'));

            // Modify state
            fs.writeFileSync(path.join(dir, 'file1.txt'), 'modified');
            fs.writeFileSync(path.join(dir, 'missing.txt'), 'new-file');

            // Restore
            restoreRollbackSnapshot(dir, snapshotRoot, records);

            assert.equal(fs.readFileSync(path.join(dir, 'file1.txt'), 'utf8'), 'original');
            assert.ok(!fs.existsSync(path.join(dir, 'missing.txt')));
            assert.ok(fs.existsSync(path.join(dir, 'subdir', 'file2.txt')));
        } finally {
            removePathRecursive(dir);
        }
    });

    it('writes and reads rollback records metadata', () => {
        const dir = mkTmpDir();
        try {
            const snapshotRoot = path.join(dir, '_snapshot');
            const records = [
                { relativePath: 'file1.txt', existed: true, pathType: 'file' },
                { relativePath: 'missing.txt', existed: false, pathType: 'missing' }
            ];

            fs.mkdirSync(snapshotRoot, { recursive: true });
            fs.writeFileSync(path.join(snapshotRoot, 'file1.txt'), 'original');
            const recordsPath = writeRollbackRecords(snapshotRoot, records);
            assert.equal(recordsPath, getRollbackRecordsPath(snapshotRoot));

            const loaded = readRollbackRecords(snapshotRoot);
            assert.deepEqual(loaded, records);
        } finally {
            removePathRecursive(dir);
        }
    });

    it('rejects changed snapshot bytes before trusting rollback records', () => {
        const dir = mkTmpDir();
        try {
            const snapshotRoot = path.join(dir, '_snapshot');
            fs.mkdirSync(snapshotRoot);
            fs.writeFileSync(path.join(snapshotRoot, 'file.txt'), 'original');
            writeRollbackRecords(snapshotRoot, [
                { relativePath: 'file.txt', existed: true, pathType: 'file' }
            ]);
            fs.writeFileSync(path.join(snapshotRoot, 'file.txt'), 'altered');
            assert.throws(() => readRollbackRecords(snapshotRoot), /Rollback snapshot integrity mismatch/);
        } finally {
            removePathRecursive(dir);
        }
    });

    it('rejects a snapshot record beneath a symlinked directory', { skip: !symlinkSupported && 'Symlinks/junctions not supported' }, () => {
        const dir = mkTmpDir();
        try {
            const snapshotRoot = path.join(dir, '_snapshot');
            const linkedDir = path.join(snapshotRoot, 'linked');
            const outside = path.join(dir, 'outside');
            fs.mkdirSync(linkedDir, { recursive: true });
            fs.mkdirSync(outside);
            fs.writeFileSync(path.join(linkedDir, 'file.txt'), 'original');
            fs.writeFileSync(path.join(outside, 'file.txt'), 'outside');
            writeRollbackRecords(snapshotRoot, [
                { relativePath: 'linked/file.txt', existed: true, pathType: 'file' }
            ]);
            fs.rmSync(linkedDir, { recursive: true });
            fs.symlinkSync(outside, linkedDir, 'junction');
            assert.throws(() => readRollbackRecords(snapshotRoot), /symlink|junction|outside permitted root/);
        } finally {
            removePathRecursive(dir);
        }
    });

    it('rejects a linked restore destination before touching outside files', { skip: !symlinkSupported && 'Symlinks/junctions not supported' }, () => {
        const dir = mkTmpDir();
        try {
            const snapshotRoot = path.join(dir, '_snapshot');
            const outside = path.join(dir, 'outside');
            fs.mkdirSync(path.join(snapshotRoot, 'linked'), { recursive: true });
            fs.mkdirSync(outside);
            fs.writeFileSync(path.join(snapshotRoot, 'linked', 'file.txt'), 'snapshot');
            fs.writeFileSync(path.join(outside, 'file.txt'), 'outside-original');
            const records = [{ relativePath: 'linked/file.txt', existed: true, pathType: 'file' }];
            writeRollbackRecords(snapshotRoot, records);
            fs.symlinkSync(outside, path.join(dir, 'linked'), 'junction');
            assert.throws(() => restoreRollbackSnapshot(dir, snapshotRoot, records), /symlink|junction/);
            assert.equal(fs.readFileSync(path.join(outside, 'file.txt'), 'utf8'), 'outside-original');
        } finally {
            removePathRecursive(dir);
        }
    });

    it('rejects changed rollback records and missing integrity metadata', () => {
        const dir = mkTmpDir();
        try {
            const snapshotRoot = path.join(dir, '_snapshot');
            fs.mkdirSync(snapshotRoot);
            writeRollbackRecords(snapshotRoot, [
                { relativePath: 'missing.txt', existed: false, pathType: 'missing' }
            ]);
            fs.writeFileSync(getRollbackRecordsPath(snapshotRoot), '[]');
            assert.throws(() => readRollbackRecords(snapshotRoot), /Rollback snapshot integrity mismatch/);
            fs.rmSync(path.join(snapshotRoot, 'rollback-integrity.json'));
            assert.throws(() => readRollbackRecords(snapshotRoot), /integrity metadata is missing/);
        } finally {
            removePathRecursive(dir);
        }
    });

    it('rejects duplicate rollback paths and inconsistent record types', () => {
        const dir = mkTmpDir();
        try {
            const snapshotRoot = path.join(dir, '_snapshot');
            fs.mkdirSync(snapshotRoot);
            const recordsPath = getRollbackRecordsPath(snapshotRoot);
            fs.writeFileSync(recordsPath, JSON.stringify([
                { relativePath: 'File.txt', existed: false, pathType: 'missing' },
                { relativePath: 'file.txt', existed: false, pathType: 'missing' }
            ]));
            assert.throws(() => readRollbackRecords(snapshotRoot), /Duplicate rollback record/);
            for (const record of [
                { relativePath: 'file.txt', existed: 'false', pathType: 'missing' },
                { relativePath: 'file.txt', existed: false, pathType: 'file' },
                { relativePath: 'file.txt', existed: true, pathType: 'missing' }
            ]) {
                fs.writeFileSync(recordsPath, JSON.stringify([record]));
                assert.throws(() => readRollbackRecords(snapshotRoot), /invalid existence or pathType/);
            }
        } finally {
            removePathRecursive(dir);
        }
    });

    it('rejects malformed snapshot integrity schema and identity', () => {
        const dir = mkTmpDir();
        try {
            const snapshotRoot = path.join(dir, '_snapshot');
            fs.mkdirSync(snapshotRoot);
            writeRollbackRecords(snapshotRoot, [
                { relativePath: 'missing.txt', existed: false, pathType: 'missing' }
            ]);
            const integrityPath = path.join(snapshotRoot, 'rollback-integrity.json');
            const valid = JSON.parse(fs.readFileSync(integrityPath, 'utf8'));
            for (const change of [
                { schemaVersion: 2 },
                { snapshotName: 'another-snapshot' },
                { recordsSha256: 'not-a-digest' },
                { version: '1.0.0' },
                { entries: [] }
            ]) {
                fs.writeFileSync(integrityPath, JSON.stringify({ ...valid, ...change }));
                assert.throws(() => readRollbackRecords(snapshotRoot), /Rollback snapshot integrity mismatch/);
            }
        } finally {
            removePathRecursive(dir);
        }
    });

    it('rejects invalid rollback records JSON', () => {
        const dir = mkTmpDir();
        try {
            const snapshotRoot = path.join(dir, '_snapshot');
            fs.mkdirSync(snapshotRoot, { recursive: true });
            fs.writeFileSync(getRollbackRecordsPath(snapshotRoot), '{not-json', 'utf8');

            assert.throws(() => readRollbackRecords(snapshotRoot), /not valid JSON/);
        } finally {
            removePathRecursive(dir);
        }
    });

    it('rejects rollback records payloads that are not arrays', () => {
        const dir = mkTmpDir();
        try {
            const snapshotRoot = path.join(dir, '_snapshot');
            fs.mkdirSync(snapshotRoot, { recursive: true });
            fs.writeFileSync(getRollbackRecordsPath(snapshotRoot), JSON.stringify({ relativePath: 'file.txt' }), 'utf8');

            assert.throws(() => readRollbackRecords(snapshotRoot), /must contain an array/);
        } finally {
            removePathRecursive(dir);
        }
    });

    it('rejects rollback records with unsafe relative paths', () => {
        const dir = mkTmpDir();
        try {
            const snapshotRoot = path.join(dir, '_snapshot');
            fs.mkdirSync(snapshotRoot, { recursive: true });
            fs.writeFileSync(
                getRollbackRecordsPath(snapshotRoot),
                JSON.stringify([{ relativePath: '../escape', existed: true, pathType: 'file' }], null, 2),
                'utf8'
            );

            assert.throws(() => readRollbackRecords(snapshotRoot), /parent path traversal/);
        } finally {
            removePathRecursive(dir);
        }
    });

    it('throws when snapshot entry is missing for existed item', () => {
        const dir = mkTmpDir();
        try {
            const snapshotRoot = path.join(dir, '_snapshot');
            fs.mkdirSync(snapshotRoot, { recursive: true });
            const records = [{ relativePath: 'x.txt', existed: true, pathType: 'file' }];
            assert.throws(() => restoreRollbackSnapshot(dir, snapshotRoot, records), /Rollback snapshot entry missing/);
        } finally {
            removePathRecursive(dir);
        }
    });
});

describe('copyDirectoryContentMerge', () => {
    it('merges source into destination and removes orphan files', () => {
        const dir = mkTmpDir();
        try {
            const src = path.join(dir, 'src');
            fs.mkdirSync(path.join(src, 'sub'), { recursive: true });
            fs.writeFileSync(path.join(src, 'a.txt'), 'new-a');
            fs.writeFileSync(path.join(src, 'sub', 'b.txt'), 'new-b');

            const dst = path.join(dir, 'dst');
            fs.mkdirSync(path.join(dst, 'sub'), { recursive: true });
            fs.writeFileSync(path.join(dst, 'a.txt'), 'old-a');
            fs.writeFileSync(path.join(dst, 'orphan.txt'), 'orphan');
            fs.writeFileSync(path.join(dst, 'sub', 'old.txt'), 'old');

            copyDirectoryContentMerge(src, dst, []);

            assert.equal(fs.readFileSync(path.join(dst, 'a.txt'), 'utf8'), 'new-a');
            assert.equal(fs.readFileSync(path.join(dst, 'sub', 'b.txt'), 'utf8'), 'new-b');
            assert.ok(!fs.existsSync(path.join(dst, 'orphan.txt')));
            assert.ok(!fs.existsSync(path.join(dst, 'sub', 'old.txt')));
        } finally {
            removePathRecursive(dir);
        }
    });

    it('rejects source symlink or junction entries while merging directories', { skip: !symlinkSupported && 'Symlinks/junctions not supported' }, () => {
        const dir = mkTmpDir();
        try {
            const src = path.join(dir, 'src');
            const outside = path.join(dir, 'outside');
            const dst = path.join(dir, 'dst');
            fs.mkdirSync(src, { recursive: true });
            fs.mkdirSync(outside, { recursive: true });
            fs.mkdirSync(dst, { recursive: true });
            fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside-secret', 'utf8');
            fs.symlinkSync(outside, path.join(src, 'linked-outside'), 'junction');

            assert.throws(
                () => copyDirectoryContentMerge(src, dst, []),
                /Refusing to copy symlink or junction source/
            );
            assert.equal(fs.existsSync(path.join(dst, 'linked-outside', 'secret.txt')), false);
        } finally {
            removePathRecursive(dir);
        }
    });

    it('rejects destination symlink or junction entries while merging directories', { skip: !symlinkSupported && 'Symlinks/junctions not supported' }, () => {
        const dir = mkTmpDir();
        try {
            const src = path.join(dir, 'src');
            const outside = path.join(dir, 'outside');
            const dst = path.join(dir, 'dst');
            fs.mkdirSync(src, { recursive: true });
            fs.mkdirSync(outside, { recursive: true });
            fs.mkdirSync(dst, { recursive: true });
            fs.writeFileSync(path.join(src, 'linked-destination'), 'new-data', 'utf8');
            fs.writeFileSync(path.join(outside, 'payload.txt'), 'outside-data', 'utf8');
            fs.symlinkSync(outside, path.join(dst, 'linked-destination'), 'junction');

            assert.throws(
                () => copyDirectoryContentMerge(src, dst, []),
                /Refusing to overwrite symlink or junction destination/
            );
            assert.equal(fs.readFileSync(path.join(outside, 'payload.txt'), 'utf8'), 'outside-data');
        } finally {
            removePathRecursive(dir);
        }
    });

    it('skips files in skipDestinationFiles', () => {
        const dir = mkTmpDir();
        try {
            const src = path.join(dir, 'src');
            fs.mkdirSync(src, { recursive: true });
            fs.writeFileSync(path.join(src, 'a.txt'), 'new-a');

            const dst = path.join(dir, 'dst');
            fs.mkdirSync(dst, { recursive: true });
            fs.writeFileSync(path.join(dst, 'keep.txt'), 'keep-me');

            copyDirectoryContentMerge(src, dst, [path.join(dst, 'keep.txt')]);

            assert.ok(fs.existsSync(path.join(dst, 'keep.txt')));
            assert.equal(fs.readFileSync(path.join(dst, 'keep.txt'), 'utf8'), 'keep-me');
        } finally {
            removePathRecursive(dir);
        }
    });
});

describe('syncWorkingTreeBundleItems', () => {
    it('copies items from source to target', () => {
        const dir = mkTmpDir();
        try {
            const src = path.join(dir, 'src');
            fs.mkdirSync(src, { recursive: true });
            fs.writeFileSync(path.join(src, 'VERSION'), '2.0.0');
            fs.writeFileSync(path.join(src, 'README.md'), '# New README');

            const dst = path.join(dir, 'dst');
            fs.mkdirSync(dst, { recursive: true });
            fs.writeFileSync(path.join(dst, 'VERSION'), '1.0.0');

            syncWorkingTreeBundleItems(src, dst, ['VERSION', 'README.md']);

            assert.equal(fs.readFileSync(path.join(dst, 'VERSION'), 'utf8'), '2.0.0');
            assert.equal(fs.readFileSync(path.join(dst, 'README.md'), 'utf8'), '# New README');
        } finally {
            removePathRecursive(dir);
        }
    });
});

describe('restoreSyncedItemsFromBackup', () => {
    it('writes and reads sync backup metadata', () => {
        const dir = mkTmpDir();
        try {
            const backupRoot = path.join(dir, 'backup');
            const metadata = {
                createdAt: '2026-03-29T00:00:00.000Z',
                preexistingMap: { VERSION: true, 'NEW.md': false }
            };

            const metadataPath = writeSyncBackupMetadata(backupRoot, metadata);
            assert.equal(metadataPath, getSyncBackupMetadataPath(backupRoot));
            assert.deepEqual(readSyncBackupMetadata(backupRoot), metadata);
        } finally {
            removePathRecursive(dir);
        }
    });

    it('rejects invalid sync backup metadata JSON', () => {
        const dir = mkTmpDir();
        try {
            const backupRoot = path.join(dir, 'backup');
            fs.mkdirSync(backupRoot, { recursive: true });
            fs.writeFileSync(getSyncBackupMetadataPath(backupRoot), '{not-json', 'utf8');

            assert.throws(() => readSyncBackupMetadata(backupRoot), /not valid JSON/);
        } finally {
            removePathRecursive(dir);
        }
    });

    it('rejects sync backup metadata without preexistingMap', () => {
        const dir = mkTmpDir();
        try {
            const backupRoot = path.join(dir, 'backup');
            fs.mkdirSync(backupRoot, { recursive: true });
            fs.writeFileSync(getSyncBackupMetadataPath(backupRoot), JSON.stringify({ createdAt: '2026-03-29T00:00:00.000Z' }), 'utf8');

            assert.throws(() => readSyncBackupMetadata(backupRoot), /missing preexistingMap/);
        } finally {
            removePathRecursive(dir);
        }
    });

    it('rejects sync backup metadata with unsafe item keys', () => {
        const dir = mkTmpDir();
        try {
            const backupRoot = path.join(dir, 'backup');
            fs.mkdirSync(backupRoot, { recursive: true });
            fs.writeFileSync(
                getSyncBackupMetadataPath(backupRoot),
                JSON.stringify({ preexistingMap: { '../escape': true } }, null, 2),
                'utf8'
            );

            assert.throws(() => readSyncBackupMetadata(backupRoot), /parent path traversal/);
        } finally {
            removePathRecursive(dir);
        }
    });

    it('restores preexisting items and removes new items', () => {
        const dir = mkTmpDir();
        try {
            const bundleRoot = path.join(dir, 'bundle');
            fs.mkdirSync(bundleRoot, { recursive: true });
            fs.writeFileSync(path.join(bundleRoot, 'VERSION'), 'modified');
            fs.writeFileSync(path.join(bundleRoot, 'NEW.md'), 'new-file');

            const backupRoot = path.join(dir, 'backup');
            fs.mkdirSync(backupRoot, { recursive: true });
            fs.writeFileSync(path.join(backupRoot, 'VERSION'), 'original');

            const preexistingMap = { VERSION: true, 'NEW.md': false };

            restoreSyncedItemsFromBackup(bundleRoot, backupRoot, preexistingMap, null);

            assert.equal(fs.readFileSync(path.join(bundleRoot, 'VERSION'), 'utf8'), 'original');
            assert.ok(!fs.existsSync(path.join(bundleRoot, 'NEW.md')));
        } finally {
            removePathRecursive(dir);
        }
    });
});
