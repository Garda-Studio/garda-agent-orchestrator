import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
    createRollbackSnapshot,
    restoreRollbackSnapshot,
    restoreSyncedItemsFromBackup,
    syncWorkingTreeBundleItems,
    removePathRecursive,
    ensureWithinRoot,
    ensureRelativeSafe,
    isSubpath,
    resolveRealPath,
} from '../../../src/lifecycle/common';
import {
    resolveRollbackSnapshotPath,
} from '../../../src/lifecycle/rollback';

function mkTmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'gao-lifecycle-boundary-'));
}

function swapCase(value: string): string {
    return value.split('').map((char) => {
        const lower = char.toLowerCase();
        const upper = char.toUpperCase();
        if (char === lower && char !== upper) {
            return upper;
        }
        if (char === upper && char !== lower) {
            return lower;
        }
        return char;
    }).join('');
}

describe('boundary validation', () => {
    it('createRollbackSnapshot rejects traversal and absolute paths', () => {
        const dir = mkTmpDir();
        try {
            const snapshotRoot = path.join(dir, '_snapshot');
            assert.throws(() => createRollbackSnapshot(dir, snapshotRoot, ['../evil.txt']), /parent path traversal/);
            assert.throws(() => createRollbackSnapshot(dir, snapshotRoot, [path.resolve('/etc/passwd')]), /must be relative/);
        } finally {
            removePathRecursive(dir);
        }
    });

    it('restoreRollbackSnapshot rejects bad records', () => {
        const dir = mkTmpDir();
        try {
            const snapshotRoot = path.join(dir, '_snapshot');
            const records = [{ relativePath: '../bad', existed: true, pathType: 'file' }];
            assert.throws(() => restoreRollbackSnapshot(dir, snapshotRoot, records), /parent path traversal/);
        } finally {
            removePathRecursive(dir);
        }
    });

    it('restoreSyncedItemsFromBackup rejects bad item keys', () => {
        const dir = mkTmpDir();
        try {
            const bundleRoot = path.join(dir, 'bundle');
            fs.mkdirSync(bundleRoot, { recursive: true });
            const backupRoot = path.join(dir, 'backup');
            fs.mkdirSync(backupRoot, { recursive: true });
            const badMap: Record<string, unknown> = { '../secrets': true };
            assert.throws(() => restoreSyncedItemsFromBackup(bundleRoot, backupRoot, badMap, null), /parent path traversal/);
        } finally {
            removePathRecursive(dir);
        }
    });

    it('syncWorkingTreeBundleItems rejects bad item names', () => {
        const dir = mkTmpDir();
        try {
            const src = path.join(dir, 'src');
            fs.mkdirSync(src, { recursive: true });
            const dst = path.join(dir, 'dst');
            fs.mkdirSync(dst, { recursive: true });
            assert.throws(() => syncWorkingTreeBundleItems(src, dst, ['../bad']), /parent path traversal/);
        } finally {
            removePathRecursive(dir);
        }
    });


    it('ensureWithinRoot rejects paths outside root', () => {
        const dir = mkTmpDir();
        try {
            assert.throws(
                () => ensureWithinRoot(dir, path.join(dir, '..', 'escape'), 'Test'),
                /resolves outside permitted root/
            );
            const inside = ensureWithinRoot(dir, path.join(dir, 'child'), 'Test');
            assert.ok(inside.startsWith(path.resolve(dir)));
        } finally {
            removePathRecursive(dir);
        }
    });

    it('ensureRelativeSafe rejects absolute and traversal paths', () => {
        assert.throws(() => ensureRelativeSafe('/etc/passwd', 'Test'), /must be relative/);
        assert.throws(() => ensureRelativeSafe('../escape', 'Test'), /parent path traversal/);
        assert.doesNotThrow(() => ensureRelativeSafe('safe/child.txt', 'Test'));
    });

    it('isSubpath accepts same-path and children, rejects siblings', () => {
        const parent = path.resolve('/a/b');
        assert.equal(isSubpath(parent, parent), true);
        assert.equal(isSubpath(parent, path.join(parent, 'child')), true);
        assert.equal(isSubpath(parent, path.resolve('/a/c')), false);
        assert.equal(isSubpath(parent, path.resolve('/a')), false);
    });

    it('isSubpath treats case-only differences as distinct lexical paths', () => {
        const root = path.resolve('/case-sensitive-root');
        const differentlyCasedChild = path.join(path.resolve('/'), 'CASE-SENSITIVE-ROOT', 'child.txt');
        assert.equal(isSubpath(root, differentlyCasedChild), false);
    });

    it('ensureWithinRoot follows actual filesystem case behavior for existing and missing paths', () => {
        const dir = mkTmpDir();
        try {
            const root = path.join(dir, 'CaseRoot');
            const child = path.join(root, 'child.txt');
            const aliasRoot = path.join(path.dirname(root), swapCase(path.basename(root)));
            const aliasExistingChild = path.join(aliasRoot, 'child.txt');
            const aliasMissingChild = path.join(aliasRoot, 'missing', 'child.txt');

            fs.mkdirSync(root, { recursive: true });
            fs.writeFileSync(child, 'ok', 'utf8');

            const realRoot = fs.realpathSync.native(root);
            let aliasMatchesRoot: boolean;
            try {
                aliasMatchesRoot = fs.realpathSync.native(aliasRoot) === realRoot;
            } catch {
                aliasMatchesRoot = false;
            }

            if (aliasMatchesRoot) {
                assert.doesNotThrow(() => ensureWithinRoot(root, aliasExistingChild, 'Test'));
                assert.doesNotThrow(() => ensureWithinRoot(root, aliasMissingChild, 'Test'));
            } else {
                assert.throws(() => ensureWithinRoot(root, aliasExistingChild, 'Test'), /outside permitted root|escapes permitted root/);
                assert.throws(() => ensureWithinRoot(root, aliasMissingChild, 'Test'), /outside permitted root|escapes permitted root/);
            }
        } finally {
            removePathRecursive(dir);
        }
    });


    it('resolveRollbackSnapshotPath rejects absolute path outside target', () => {
        const dir = mkTmpDir();
        try {
            const outsidePath = path.resolve(dir, '..', 'evil-snapshot');
            assert.throws(
                () => resolveRollbackSnapshotPath(dir, outsidePath),
                /resolves outside permitted root/
            );
        } finally {
            removePathRecursive(dir);
        }
    });

    it('resolveRollbackSnapshotPath rejects relative traversal', () => {
        const dir = mkTmpDir();
        try {
            assert.throws(
                () => resolveRollbackSnapshotPath(dir, '../escape'),
                /resolves outside permitted root/
            );
        } finally {
            removePathRecursive(dir);
        }
    });

    it('resolveRollbackSnapshotPath accepts path within target root', () => {
        const dir = mkTmpDir();
        try {
            const snapshotDir = path.join(
                dir, 'garda-agent-orchestrator', 'runtime',
                'update-rollbacks', 'update-20260401-010101'
            );
            fs.mkdirSync(snapshotDir, { recursive: true });
            const result = resolveRollbackSnapshotPath(dir, snapshotDir);
            assert.ok(result.startsWith(path.resolve(dir)));
        } finally {
            removePathRecursive(dir);
        }
    });
});


describe('resolveRealPath', () => {
    it('returns realpath for an existing path', () => {
        const dir = mkTmpDir();
        try {
            const real = resolveRealPath(dir);
            assert.equal(real, fs.realpathSync.native(path.resolve(dir)));
        } finally {
            removePathRecursive(dir);
        }
    });

    it('resolves deepest existing ancestor for a non-existent tail', () => {
        const dir = mkTmpDir();
        try {
            const nonExistent = path.join(dir, 'does', 'not', 'exist');
            const result = resolveRealPath(nonExistent);
            const realDir = fs.realpathSync.native(path.resolve(dir));
            assert.equal(result, path.join(realDir, 'does', 'not', 'exist'));
        } finally {
            removePathRecursive(dir);
        }
    });
});


function canCreateSymlinks(): boolean {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-symtest-'));
    try {
        const target = path.join(dir, 'target');
        const link = path.join(dir, 'link');
        fs.mkdirSync(target);
        
        try {
            fs.symlinkSync(target, link, 'junction');
            return true;
        } catch (e: any) {
            // On Windows, EPERM usually means "Developer Mode" is off or not running as Admin.
            // This is a legitimate environment constraint, not a code failure.
            if (process.platform === 'win32' && e.code === 'EPERM') {
                // Policy: T-494 decides to keep explicit skip with a clear diagnostic.
                // Coverage fallback: resolveRealPath and isSubpath are still tested via 
                // non-escaping paths and deep ancestor resolution (see above).
                return false;
            }
            throw e;
        }
    } catch {
        return false;
    } finally {
        removePathRecursive(dir);
    }
}

const symlinkSupported = canCreateSymlinks();

describe('symlink/junction escape detection', { skip: !symlinkSupported && 'Symlinks/junctions not supported' }, () => {
    it('ensureWithinRoot rejects junction that escapes root', () => {
        const dir = mkTmpDir();
        try {
            const root = path.join(dir, 'root');
            const outside = path.join(dir, 'outside');
            fs.mkdirSync(root, { recursive: true });
            fs.mkdirSync(outside, { recursive: true });
            fs.writeFileSync(path.join(outside, 'secret.txt'), 'sensitive');

            // Create junction inside root that points outside root
            const junction = path.join(root, 'escape');
            fs.symlinkSync(outside, junction, 'junction');

            // Instrument fs.statSync and fs.readFileSync to prove they are not reached
            const statMock = mock.method(fs, 'statSync');
            const readMock = mock.method(fs, 'readFileSync');

            try {
                // Lexically the path looks inside root, but realpath resolves outside
                const candidate = path.join(root, 'escape', 'secret.txt');
                assert.throws(
                    () => ensureWithinRoot(root, candidate, 'Junction test'),
                    /symlink or junction/
                );

                assert.equal(statMock.mock.callCount(), 0, 'fs.statSync should not be called');
                assert.equal(readMock.mock.callCount(), 0, 'fs.readFileSync should not be called');
            } finally {
                mock.restoreAll();
            }
        } finally {
            removePathRecursive(dir);
        }
    });

    it('ensureWithinRoot rejects junction with non-existent tail', () => {
        const dir = mkTmpDir();
        try {
            const root = path.join(dir, 'root');
            const outside = path.join(dir, 'outside');
            fs.mkdirSync(root, { recursive: true });
            fs.mkdirSync(outside, { recursive: true });

            const junction = path.join(root, 'escape');
            fs.symlinkSync(outside, junction, 'junction');

            // Even when the tail file doesn't exist, the junction should be caught
            const candidate = path.join(root, 'escape', 'new-file.txt');
            assert.throws(
                () => ensureWithinRoot(root, candidate, 'Junction non-existent test'),
                /symlink or junction/
            );
        } finally {
            removePathRecursive(dir);
        }
    });

    it('ensureWithinRoot accepts symlink that stays within root', () => {
        const dir = mkTmpDir();
        try {
            const root = path.join(dir, 'root');
            const subdir = path.join(root, 'real');
            fs.mkdirSync(subdir, { recursive: true });
            fs.writeFileSync(path.join(subdir, 'ok.txt'), 'safe');

            // Symlink inside root pointing to another location inside root
            const link = path.join(root, 'link');
            fs.symlinkSync(subdir, link, 'junction');

            const candidate = path.join(root, 'link', 'ok.txt');
            const result = ensureWithinRoot(root, candidate, 'Safe junction test');
            assert.ok(result);
        } finally {
            removePathRecursive(dir);
        }
    });

    it('ensureWithinRoot rejects external junction alias into root', () => {
        const dir = mkTmpDir();
        try {
            const root = path.join(dir, 'root');
            const outside = path.join(dir, 'outside');
            fs.mkdirSync(root, { recursive: true });
            fs.mkdirSync(outside, { recursive: true });
            fs.writeFileSync(path.join(root, 'ok.txt'), 'safe');

            const externalAlias = path.join(outside, 'into-root');
            fs.symlinkSync(root, externalAlias, 'junction');

            const candidate = path.join(externalAlias, 'ok.txt');
            assert.throws(
                () => ensureWithinRoot(root, candidate, 'External alias test'),
                /outside permitted root/
            );
        } finally {
            removePathRecursive(dir);
        }
    });

    it('createRollbackSnapshot rejects junction escape in target root', () => {
        const dir = mkTmpDir();
        try {
            const root = path.join(dir, 'root');
            const outside = path.join(dir, 'outside');
            fs.mkdirSync(root, { recursive: true });
            fs.mkdirSync(outside, { recursive: true });
            fs.writeFileSync(path.join(outside, 'secret.txt'), 'data');

            const junction = path.join(root, 'escape');
            fs.symlinkSync(outside, junction, 'junction');

            const snapshotRoot = path.join(root, 'snapshot');
            assert.throws(
                () => createRollbackSnapshot(root, snapshotRoot, ['escape/secret.txt']),
                /symlink or junction/
            );
        } finally {
            removePathRecursive(dir);
        }
    });

    it('restoreRollbackSnapshot rejects junction escape', () => {
        const dir = mkTmpDir();
        try {
            const root = path.join(dir, 'root');
            const outside = path.join(dir, 'outside');
            fs.mkdirSync(root, { recursive: true });
            fs.mkdirSync(outside, { recursive: true });

            const junction = path.join(root, 'escape');
            fs.symlinkSync(outside, junction, 'junction');

            const snapshotRoot = path.join(dir, 'snapshot');
            const records = [{ relativePath: 'escape/file.txt', existed: false, pathType: 'missing' }];
            assert.throws(
                () => restoreRollbackSnapshot(root, snapshotRoot, records),
                /symlink or junction/
            );
        } finally {
            removePathRecursive(dir);
        }
    });

    it('syncWorkingTreeBundleItems rejects junction escape in destination', () => {
        const dir = mkTmpDir();
        try {
            const src = path.join(dir, 'src');
            const escapeDir = path.join(src, 'escape');
            fs.mkdirSync(escapeDir, { recursive: true });
            fs.writeFileSync(path.join(escapeDir, 'payload.txt'), 'payload');

            const dst = path.join(dir, 'dst');
            const outside = path.join(dir, 'outside');
            fs.mkdirSync(dst, { recursive: true });
            fs.mkdirSync(outside, { recursive: true });

            // Create junction inside dst pointing outside
            const junction = path.join(dst, 'escape');
            fs.symlinkSync(outside, junction, 'junction');

            // Syncing 'escape/payload.txt' should be caught since junction escapes dst
            assert.throws(
                () => syncWorkingTreeBundleItems(src, dst, ['escape/payload.txt']),
                /symlink or junction/
            );
        } finally {
            removePathRecursive(dir);
        }
    });

    it('restoreSyncedItemsFromBackup rejects junction escape in target', () => {
        const dir = mkTmpDir();
        try {
            const bundleRoot = path.join(dir, 'bundle');
            const outside = path.join(dir, 'outside');
            fs.mkdirSync(bundleRoot, { recursive: true });
            fs.mkdirSync(outside, { recursive: true });

            const junction = path.join(bundleRoot, 'escape');
            fs.symlinkSync(outside, junction, 'junction');

            const backupRoot = path.join(dir, 'backup');
            fs.mkdirSync(backupRoot, { recursive: true });

            const preexistingMap = { 'escape/data': true };
            assert.throws(
                () => restoreSyncedItemsFromBackup(bundleRoot, backupRoot, preexistingMap, null),
                /symlink or junction/
            );
        } finally {
            removePathRecursive(dir);
        }
    });

    it('ensureWithinRoot rejects case-variant external symlink alias (case-sensitive FS only)', () => {
        // This test targets the scenario where a symlink /tmp/cASErOOT -> /tmp/CaseRoot
        // exists on a case-sensitive filesystem.  On a case-insensitive filesystem the
        // two names refer to the same directory entry so symlink creation will fail with
        // EEXIST - in that case the test is skipped, because the path IS a genuine FS
        // alias and must be allowed.
        const dir = mkTmpDir();
        try {
            const root = path.join(dir, 'CaseRoot');
            const aliasDir = path.join(dir, swapCase('CaseRoot')); // e.g. cASErOOT

            fs.mkdirSync(root, { recursive: true });
            fs.writeFileSync(path.join(root, 'ok.txt'), 'safe');

            // Attempt to create a case-variant symlink alias outside the root.
            // On case-insensitive filesystems this will fail because cASErOOT == CaseRoot.
            let aliasCreated: boolean;
            try {
                fs.symlinkSync(root, aliasDir, 'junction');
                aliasCreated = true;
            } catch {
                aliasCreated = false;
            }

            if (!aliasCreated) {
                // Case-insensitive FS: the two names are the same directory - skip.
                return;
            }

            // The candidate path lexically starts with aliasDir, not root, yet
            // realpath resolves inside root. The fix must reject both existing
            // and missing tails when the case-variant prefix is a symlink alias.
            const candidate = path.join(aliasDir, 'ok.txt');
            const missingCandidate = path.join(aliasDir, 'missing', 'ok.txt');
            assert.throws(
                () => ensureWithinRoot(root, candidate, 'Case-variant external alias test'),
                /resolves outside permitted root/
            );
            assert.throws(
                () => ensureWithinRoot(root, missingCandidate, 'Case-variant external missing alias test'),
                /resolves outside permitted root/
            );
        } finally {
            removePathRecursive(dir);
        }
    });
});
