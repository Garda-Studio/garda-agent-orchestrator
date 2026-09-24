import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    resolveProtectedControlPlaneManifestPath,
    writeProtectedControlPlaneManifest
} from '../../../../src/gates/protected-control-plane';

test('writeProtectedControlPlaneManifest preserves the previous manifest when final rename fails', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'protected-control-plane-'));
    try {
        const manifestPath = resolveProtectedControlPlaneManifestPath(repoRoot);
        fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
        fs.writeFileSync(manifestPath, '{"previous":true}\n', 'utf8');

        const realFs = require('node:fs');
        const originalRenameSync = realFs.renameSync;
        try {
            realFs.renameSync = function (...args: any[]) {
                if (args[1] === manifestPath) {
                    throw new Error('simulated manifest rename failure');
                }
                return originalRenameSync.apply(realFs, args);
            };

            assert.throws(
                () => writeProtectedControlPlaneManifest(repoRoot),
                /simulated manifest rename failure/
            );
        } finally {
            realFs.renameSync = originalRenameSync;
        }

        assert.equal(fs.readFileSync(manifestPath, 'utf8'), '{"previous":true}\n');
        assert.deepStrictEqual(
            fs.readdirSync(path.dirname(manifestPath)).filter((entry) => entry.includes('.tmp-')),
            []
        );
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('writeProtectedControlPlaneManifest rejects a linked runtime directory', (t) => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'protected-control-plane-'));
    try {
        const outside = path.join(repoRoot, 'outside');
        fs.mkdirSync(outside);
        const manifestPath = resolveProtectedControlPlaneManifestPath(repoRoot);
        fs.mkdirSync(path.dirname(path.dirname(manifestPath)), { recursive: true });
        try {
            fs.symlinkSync(outside, path.dirname(manifestPath), 'junction');
        } catch (error: unknown) {
            const code = (error as NodeJS.ErrnoException).code;
            if (['EPERM', 'EACCES', 'ENOTSUP'].includes(code || '')) {
                t.skip(`Junctions unavailable: ${code}`);
                return;
            }
            throw error;
        }
        assert.throws(() => writeProtectedControlPlaneManifest(repoRoot), /symlink|junction/);
        assert.deepEqual(fs.readdirSync(outside), []);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});
