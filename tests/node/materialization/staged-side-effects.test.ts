import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    applyMaterializationStage,
    createCopyFileStage,
    createRemoveFileStage,
    createWriteTextFileStage
} from '../../../src/materialization/staged-side-effects';

describe('materialization staged side effects', () => {
    it('rejects a destination outside the declared root before writing', () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-stage-outside-'));
        try {
            const root = path.join(tempDir, 'root');
            fs.mkdirSync(root);
            const outside = path.join(tempDir, 'outside.txt');
            fs.writeFileSync(outside, 'untouched');
            assert.throws(() => createWriteTextFileStage(outside, 'changed', root), /outside permitted root/);
            assert.equal(fs.readFileSync(outside, 'utf8'), 'untouched');
        } finally {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it('rejects a hard-linked destination without changing the outside file', () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-stage-hardlink-'));
        try {
            const root = path.join(tempDir, 'root');
            fs.mkdirSync(root);
            const outside = path.join(tempDir, 'outside.txt');
            fs.writeFileSync(outside, 'untouched');
            fs.linkSync(outside, path.join(root, 'target.txt'));
            assert.throws(() => createWriteTextFileStage(path.join(root, 'target.txt'), 'changed', root),
                /hard-linked/);
            assert.equal(fs.readFileSync(outside, 'utf8'), 'untouched');
        } finally {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it('rejects a replaced ordinary parent between stage creation and write', () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-stage-replaced-'));
        try {
            const root = path.join(tempDir, 'root');
            const parent = path.join(root, 'parent');
            fs.mkdirSync(parent, { recursive: true });
            const stage = createWriteTextFileStage(path.join(parent, 'target.txt'), 'changed', root);
            fs.renameSync(parent, path.join(root, 'old-parent'));
            fs.mkdirSync(parent);
            assert.throws(() => stage.apply(), /identity changed/);
            assert.equal(fs.existsSync(path.join(parent, 'target.txt')), false);
        } finally {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it('does not roll back over a replaced file when stage apply rejects before mutation', () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-stage-replaced-file-'));
        try {
            const targetPath = path.join(tempDir, 'target.txt');
            const sourcePath = path.join(tempDir, 'source.txt');
            fs.writeFileSync(targetPath, 'original');
            fs.writeFileSync(sourcePath, 'source');
            for (const createStage of [
                () => createWriteTextFileStage(targetPath, 'updated'),
                () => createCopyFileStage(sourcePath, targetPath),
                () => createRemoveFileStage(targetPath)
            ]) {
                const stage = createStage();
                const previousIdentity = fs.statSync(targetPath, { bigint: true });
                fs.renameSync(targetPath, path.join(tempDir, 'previous.txt'));
                fs.writeFileSync(targetPath, 'replacement');
                if (previousIdentity.ino !== 0n) {
                    assert.notEqual(fs.statSync(targetPath, { bigint: true }).ino, previousIdentity.ino);
                }
                assert.throws(() => applyMaterializationStage(stage), /identity changed/);
                assert.equal(fs.readFileSync(targetPath, 'utf8'), 'replacement');
                fs.rmSync(path.join(tempDir, 'previous.txt'));
            }
        } finally {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it('rejects a file that appears after an absent destination is staged', () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-stage-appeared-file-'));
        try {
            const targetPath = path.join(tempDir, 'target.txt');
            const sourcePath = path.join(tempDir, 'source.txt');
            fs.writeFileSync(sourcePath, 'source');
            for (const stage of [
                createWriteTextFileStage(targetPath, 'updated'),
                createCopyFileStage(sourcePath, targetPath),
                createRemoveFileStage(targetPath)
            ]) {
                fs.writeFileSync(targetPath, 'late owner content');
                assert.throws(() => applyMaterializationStage(stage), /identity changed/);
                assert.equal(fs.readFileSync(targetPath, 'utf8'), 'late owner content');
                fs.rmSync(targetPath);
            }
        } finally {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it('rejects a dangling file link before mutation', (t) => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-stage-link-'));
        try {
            const root = path.join(tempDir, 'root');
            fs.mkdirSync(root);
            const dangling = path.join(root, 'dangling.txt');
            try {
                fs.symlinkSync(path.join(tempDir, 'missing.txt'), dangling, 'file');
            } catch (error: unknown) {
                const code = (error as NodeJS.ErrnoException).code;
                if (code === 'EPERM' || code === 'EACCES' || code === 'ENOTSUP') {
                    t.skip(`Link creation is unavailable: ${code}`);
                    return;
                }
                throw error;
            }
            assert.throws(() => createWriteTextFileStage(dangling, 'changed', root), /symlink or junction/);
        } finally {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it('rejects a junction or linked parent directory before mutation', (t) => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-stage-junction-'));
        try {
            const root = path.join(tempDir, 'root');
            const outside = path.join(tempDir, 'outside');
            fs.mkdirSync(root);
            fs.mkdirSync(outside);
            const linkedParent = path.join(root, 'linked-parent');
            try {
                fs.symlinkSync(outside, linkedParent, process.platform === 'win32' ? 'junction' : 'dir');
            } catch (error: unknown) {
                const code = (error as NodeJS.ErrnoException).code;
                if (code === 'EPERM' || code === 'EACCES' || code === 'ENOTSUP') {
                    t.skip(`Link creation is unavailable: ${code}`);
                    return;
                }
                throw error;
            }
            assert.throws(() => createWriteTextFileStage(path.join(linkedParent, 'target.txt'), 'changed', root),
                /symlink or junction/);
            assert.equal(fs.existsSync(path.join(outside, 'target.txt')), false);
        } finally {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it('does not apply stages during dry-run', () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-stage-dry-'));
        try {
            const targetPath = path.join(tempDir, 'nested', 'file.txt');

            const result = applyMaterializationStage(
                createWriteTextFileStage(targetPath, 'new content'),
                { dryRun: true }
            );

            assert.equal(result.status, 'dry-run');
            assert.equal(fs.existsSync(targetPath), false);
        } finally {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it('rolls back an existing file when a later operation in the same stage fails', () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-stage-rollback-'));
        try {
            const targetPath = path.join(tempDir, 'file.txt');
            fs.writeFileSync(targetPath, 'original', 'utf8');

            const stage = createWriteTextFileStage(targetPath, 'updated');
            assert.throws(() => applyMaterializationStage({
                label: 'failing-wrapper',
                apply: () => {
                    stage.apply();
                    throw new Error('simulated failure');
                },
                rollback: stage.rollback
            }), /simulated failure/);

            assert.equal(fs.readFileSync(targetPath, 'utf8'), 'original');
        } finally {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it('restores overwritten copy destinations on rollback', () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-stage-copy-'));
        try {
            const sourcePath = path.join(tempDir, 'source.txt');
            const targetPath = path.join(tempDir, 'target.txt');
            fs.writeFileSync(sourcePath, 'source', 'utf8');
            fs.writeFileSync(targetPath, 'target', 'utf8');

            const stage = createCopyFileStage(sourcePath, targetPath);
            stage.apply();
            assert.equal(fs.readFileSync(targetPath, 'utf8'), 'source');

            stage.rollback?.();
            assert.equal(fs.readFileSync(targetPath, 'utf8'), 'target');
        } finally {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it('does not remove caller-owned empty parent directories during rollback cleanup', () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-stage-boundary-'));
        try {
            const ownedRoot = path.join(tempDir, 'owned-root');
            fs.mkdirSync(ownedRoot);
            const targetPath = path.join(ownedRoot, 'generated', 'file.txt');

            const stage = createWriteTextFileStage(targetPath, 'generated');
            stage.apply();
            stage.rollback?.();

            assert.equal(fs.existsSync(targetPath), false);
            assert.equal(fs.existsSync(path.dirname(targetPath)), false);
            assert.equal(fs.existsSync(ownedRoot), true);
        } finally {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });
});
