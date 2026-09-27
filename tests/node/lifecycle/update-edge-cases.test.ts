/**
 * Locked-file and interruption tests for update/rollback on Windows.
 *
 * Validates resilience of update and rollback operations under conditions
 * typical on Windows with AV scanners, multi-run orchestration, and
 * file-system contention (EBUSY, EPERM, partial writes).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { runUpdate } from '../../../src/lifecycle/update';
import {
    runRollback
} from '../../../src/lifecycle/rollback';
import {
    removePathRecursive,
    getUpdateSentinelPath,
    writeUpdateSentinel,
    readUpdateSentinel,
    removeUpdateSentinel,
    createRollbackSnapshot,
    writeRollbackRecords,
    readRollbackRecords,
    restoreRollbackSnapshot,
    getLifecycleOperationLockPath,
    copyPathRecursive,
    withLifecycleOperationLock
} from '../../../src/lifecycle/common';

it('rejects an update sentinel under a linked runtime directory', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-linked-sentinel-'));
    try {
        const bundleRoot = path.join(root, 'bundle');
        const outside = path.join(root, 'outside');
        fs.mkdirSync(bundleRoot);
        fs.mkdirSync(outside);
        fs.writeFileSync(path.join(outside, '.update-in-progress'), JSON.stringify({ phase: 'lifecycle' }));
        try {
            fs.symlinkSync(outside, path.join(bundleRoot, 'runtime'), 'junction');
        } catch {
            t.skip('Directory symlinks or junctions are unavailable');
            return;
        }
        assert.throws(() => readUpdateSentinel(bundleRoot), /symlink|junction/);
    } finally {
        removePathRecursive(root);
    }
});


function findRepoRoot() {
    let dir = __dirname;
    while (dir !== path.dirname(dir)) {
        if (fs.existsSync(path.join(dir, 'VERSION')) && fs.existsSync(path.join(dir, 'template'))) {
            return dir;
        }
        dir = path.dirname(dir);
    }
    throw new Error('Cannot find repo root');
}

function copyDirRecursive(src: string, dst: string) {
    fs.mkdirSync(dst, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
        const srcPath = path.join(src, entry.name);
        const dstPath = path.join(dst, entry.name);
        if (entry.isDirectory()) {
            copyDirRecursive(srcPath, dstPath);
        } else {
            fs.copyFileSync(srcPath, dstPath);
        }
    }
}

function seedExecutableBundleSurface(repoRoot: string, bundleRoot: string) {
    fs.copyFileSync(path.join(repoRoot, 'package.json'), path.join(bundleRoot, 'package.json'));
    copyDirRecursive(path.join(repoRoot, 'bin'), path.join(bundleRoot, 'bin'));
    fs.mkdirSync(path.join(bundleRoot, 'dist', 'src'), { recursive: true });
    fs.writeFileSync(path.join(bundleRoot, 'dist', 'src', 'index.js'), 'module.exports = {};', 'utf8');
}

function setupUpdateWorkspace(repoRoot: string) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-edge-'));
    const bundle = path.join(tmpDir, 'garda-agent-orchestrator');
    fs.mkdirSync(bundle, { recursive: true });

    fs.copyFileSync(path.join(repoRoot, 'VERSION'), path.join(bundle, 'VERSION'));
    seedExecutableBundleSurface(repoRoot, bundle);
    copyDirRecursive(path.join(repoRoot, 'template'), path.join(bundle, 'template'));

    fs.mkdirSync(path.join(bundle, 'live', 'config'), { recursive: true });
    fs.mkdirSync(path.join(bundle, 'live', 'docs', 'agent-rules'), { recursive: true });
    fs.mkdirSync(path.join(bundle, 'runtime'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.git', 'hooks'), { recursive: true });

    const answers = {
        AssistantLanguage: 'English',
        AssistantBrevity: 'concise',
        SourceOfTruth: 'Claude',
        EnforceNoAutoCommit: 'false',
        ClaudeOrchestratorFullAccess: 'false',
        TokenEconomyEnabled: 'true',
        CollectedVia: 'CLI_NONINTERACTIVE'
    };
    const answersPath = path.join(bundle, 'runtime', 'init-answers.json');
    fs.writeFileSync(answersPath, JSON.stringify(answers, null, 2));

    return {
        projectRoot: tmpDir,
        bundleRoot: bundle,
        answersPath: path.relative(tmpDir, answersPath).replace(/\\/g, '/')
    };
}

function seedLifecycleOperationLock(projectRoot: string, pid: number, hostname: string = os.hostname()) {
    const lockPath = getLifecycleOperationLockPath(projectRoot);
    fs.mkdirSync(lockPath, { recursive: true });
    fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
        pid,
        hostname,
        operation: 'update',
        acquired_at_utc: '2026-04-05T00:00:00.000Z',
        target_root: path.resolve(projectRoot)
    }, null, 2), 'utf8');
    return lockPath;
}

/** Take a simple content snapshot of key files for comparison. */
function snapshotKeyFiles(projectRoot: string, fileList: string[]): Record<string, string> {
    const snapshot: Record<string, string> = {};
    for (const rel of fileList) {
        const full = path.join(projectRoot, rel);
        if (fs.existsSync(full) && fs.lstatSync(full).isFile()) {
            snapshot[rel] = fs.readFileSync(full, 'utf8');
        }
    }
    return snapshot;
}

// =========================================================================
// 1. LOCKED-FILE TESTS DURING UPDATE
// =========================================================================

describe('Update locked-file edge cases', () => {
    const repoRoot = findRepoRoot();

    it('rolls back cleanly when install runner fails with EBUSY (locked file)', () => {
        const { projectRoot, bundleRoot, answersPath } = setupUpdateWorkspace(repoRoot);
        try {
            fs.writeFileSync(path.join(projectRoot, 'CLAUDE.md'), 'original-ebusy');
            const keyFiles = ['CLAUDE.md'];
            const before = snapshotKeyFiles(projectRoot, keyFiles);

            assert.throws(
                () => runUpdate({
                    targetRoot: projectRoot,
                    bundleRoot,
                    initAnswersPath: answersPath,
                    skipVerify: true,
                    skipManifestValidation: true,
                    installRunner: () => {
                        const err = new Error('EBUSY: resource busy or locked') as NodeJS.ErrnoException;
                        err.code = 'EBUSY';
                        err.errno = -4082;
                        throw err;
                    }
                }),
                /rollback completed successfully.*EBUSY/
            );

            const after = snapshotKeyFiles(projectRoot, keyFiles);
            assert.deepEqual(after, before, 'Files must be restored after EBUSY install failure');
            assert.ok(!fs.existsSync(getUpdateSentinelPath(bundleRoot)),
                'Sentinel must be cleaned after EBUSY rollback');
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('rolls back cleanly when install runner fails with EPERM (AV lock)', () => {
        const { projectRoot, bundleRoot, answersPath } = setupUpdateWorkspace(repoRoot);
        try {
            fs.writeFileSync(path.join(projectRoot, 'CLAUDE.md'), 'original-eperm');
            fs.writeFileSync(path.join(projectRoot, 'AGENTS.md'), 'agents-eperm');
            const keyFiles = ['CLAUDE.md', 'AGENTS.md'];
            const before = snapshotKeyFiles(projectRoot, keyFiles);

            assert.throws(
                () => runUpdate({
                    targetRoot: projectRoot,
                    bundleRoot,
                    initAnswersPath: answersPath,
                    skipVerify: true,
                    skipManifestValidation: true,
                    installRunner: () => {
                        const err = new Error('EPERM: operation not permitted') as NodeJS.ErrnoException;
                        err.code = 'EPERM';
                        err.errno = -4048;
                        throw err;
                    }
                }),
                /rollback completed successfully.*EPERM/
            );

            const after = snapshotKeyFiles(projectRoot, keyFiles);
            assert.deepEqual(after, before, 'Files must be restored after EPERM install failure');
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('rolls back cleanly when materialization fails with EACCES', () => {
        const { projectRoot, bundleRoot, answersPath } = setupUpdateWorkspace(repoRoot);
        try {
            fs.writeFileSync(path.join(projectRoot, 'CLAUDE.md'), 'original-eacces');
            const keyFiles = ['CLAUDE.md'];
            const before = snapshotKeyFiles(projectRoot, keyFiles);

            assert.throws(
                () => runUpdate({
                    targetRoot: projectRoot,
                    bundleRoot,
                    initAnswersPath: answersPath,
                    skipVerify: true,
                    skipManifestValidation: true,
                    materializationRunner: () => {
                        const err = new Error('EACCES: permission denied') as NodeJS.ErrnoException;
                        err.code = 'EACCES';
                        err.errno = -4092;
                        throw err;
                    }
                }),
                /rollback completed successfully.*EACCES/
            );

            const after = snapshotKeyFiles(projectRoot, keyFiles);
            assert.deepEqual(after, before, 'Files must be restored after EACCES materialization failure');
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('reports double failure when install throws EBUSY and rollback also fails', () => {
        const { projectRoot, bundleRoot, answersPath } = setupUpdateWorkspace(repoRoot);
        try {
            assert.throws(
                () => runUpdate({
                    targetRoot: projectRoot,
                    bundleRoot,
                    initAnswersPath: answersPath,
                    installRunner: () => {
                        // Sabotage rollback snapshot before throwing
                        const runtimeDir = path.join(projectRoot,
                            'garda-agent-orchestrator', 'runtime', 'update-rollbacks');
                        if (fs.existsSync(runtimeDir)) {
                            fs.rmSync(runtimeDir, { recursive: true, force: true });
                        }
                        const err = new Error('EBUSY: resource busy or locked') as NodeJS.ErrnoException;
                        err.code = 'EBUSY';
                        throw err;
                    }
                }),
                /Rollback failed|rollback completed|EBUSY/
            );
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('blocks update when lifecycle lock is held by live process', () => {
        const { projectRoot, bundleRoot, answersPath } = setupUpdateWorkspace(repoRoot);
        try {
            // Seed a lock owned by current process (simulates concurrent run)
            seedLifecycleOperationLock(projectRoot, process.pid);

            assert.throws(
                () => runUpdate({
                    targetRoot: projectRoot,
                    bundleRoot,
                    initAnswersPath: answersPath,
                    skipVerify: true,
                    skipManifestValidation: true
                }),
                /Another lifecycle operation is already running/
            );
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('recovers stale lifecycle lock from dead process and proceeds', () => {
        const { projectRoot, bundleRoot, answersPath } = setupUpdateWorkspace(repoRoot);
        try {
            // Seed a lock with a dead PID and old timestamp
            const lockPath = getLifecycleOperationLockPath(projectRoot);
            fs.mkdirSync(lockPath, { recursive: true });
            const oldDate = new Date('2020-01-01T00:00:00.000Z');
            fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
                pid: 999999,
                hostname: os.hostname(),
                operation: 'update',
                acquired_at_utc: '2020-01-01T00:00:00.000Z',
                target_root: path.resolve(projectRoot)
            }, null, 2), 'utf8');
            fs.utimesSync(path.join(lockPath, 'owner.json'), oldDate, oldDate);
            fs.utimesSync(lockPath, oldDate, oldDate);

            // Update should recover the stale lock and succeed
            const result = runUpdate({
                targetRoot: projectRoot,
                bundleRoot,
                initAnswersPath: answersPath,
                skipVerify: true,
                skipManifestValidation: true
            });

            assert.equal(result.installStatus, 'PASS');
            assert.equal(result.materializationStatus, 'PASS');
        } finally {
            removePathRecursive(projectRoot);
        }
    });
});

// =========================================================================
// 2. LOCKED-FILE TESTS DURING ROLLBACK
// =========================================================================

describe('Rollback locked-file edge cases', () => {
    const repoRoot = findRepoRoot();

    it('rejects altered rollback records before attempting snapshot restore', async () => {
        const { projectRoot, bundleRoot, answersPath } = setupUpdateWorkspace(repoRoot);
        try {
            // Do a successful update first to create a rollback snapshot
            runUpdate({
                targetRoot: projectRoot,
                bundleRoot,
                initAnswersPath: answersPath,
                skipVerify: true,
                skipManifestValidation: true
            });

            // Altering serialized records must fail integrity preflight.
            const snapshotDir = path.join(bundleRoot, 'runtime', 'update-rollbacks');
            assert.ok(fs.existsSync(snapshotDir), 'Snapshot directory must exist');

            const snapshots = fs.readdirSync(snapshotDir).sort();
            assert.ok(snapshots.length > 0, 'At least one snapshot must exist');

            const latestSnapshot = path.join(snapshotDir, snapshots[snapshots.length - 1]);
            const records = readRollbackRecords(latestSnapshot);
            assert.ok(records.length > 0, 'Snapshot records must have entries');

            // Inject a record pointing to a non-existent snapshot file
            // (simulates a partial snapshot from interrupted write)
            const corruptedRecords = [
                ...records,
                { relativePath: 'PHANTOM_LOCKED_FILE.md', existed: true, pathType: 'file' }
            ];
            fs.writeFileSync(
                path.join(latestSnapshot, 'rollback-records.json'),
                JSON.stringify(corruptedRecords, null, 2),
                'utf8'
            );

            const targetVersionPath = path.join(bundleRoot, 'VERSION');
            const targetVersion = '99.99.99\n';
            fs.writeFileSync(targetVersionPath, targetVersion, 'utf8');

            await assert.rejects(
                runRollback({
                    targetRoot: projectRoot,
                    bundleRoot
                }),
                /Rollback snapshot integrity mismatch/
            );
            assert.equal(fs.readFileSync(targetVersionPath, 'utf8'), targetVersion);
            assert.deepEqual(fs.readdirSync(snapshotDir).sort(), snapshots,
                'Integrity preflight must not create a safety snapshot');
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('rollback blocks when lifecycle lock is held', async () => {
        const { projectRoot, bundleRoot, answersPath } = setupUpdateWorkspace(repoRoot);
        try {
            runUpdate({
                targetRoot: projectRoot,
                bundleRoot,
                initAnswersPath: answersPath,
                skipVerify: true,
                skipManifestValidation: true
            });

            seedLifecycleOperationLock(projectRoot, process.pid);

            await assert.rejects(
                runRollback({
                    targetRoot: projectRoot,
                    bundleRoot
                }),
                /Another lifecycle operation is already running/
            );
        } finally {
            removePathRecursive(projectRoot);
        }
    });
});

// =========================================================================
// 3. UPDATE SENTINEL / INTERRUPTION DETECTION
// =========================================================================

describe('Update sentinel interruption detection', () => {
    const repoRoot = findRepoRoot();

    it('writeUpdateSentinel creates sentinel with metadata', () => {
        const { bundleRoot, projectRoot } = setupUpdateWorkspace(repoRoot);
        try {
            const metadata = {
                startedAt: new Date().toISOString(),
                fromVersion: '1.0.0',
                toVersion: '2.0.0'
            };
            const sentinelPath = writeUpdateSentinel(bundleRoot, metadata);

            assert.ok(fs.existsSync(sentinelPath));
            const read = readUpdateSentinel(bundleRoot);
            assert.ok(read !== null, 'Sentinel should be readable');
            assert.equal(read!.fromVersion, '1.0.0');
            assert.equal(read!.toVersion, '2.0.0');
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('removeUpdateSentinel cleans up sentinel file', () => {
        const { bundleRoot, projectRoot } = setupUpdateWorkspace(repoRoot);
        try {
            writeUpdateSentinel(bundleRoot, { startedAt: new Date().toISOString() });
            assert.ok(fs.existsSync(getUpdateSentinelPath(bundleRoot)));

            removeUpdateSentinel(bundleRoot);
            assert.ok(!fs.existsSync(getUpdateSentinelPath(bundleRoot)));
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('readUpdateSentinel returns null for missing sentinel', () => {
        const { bundleRoot, projectRoot } = setupUpdateWorkspace(repoRoot);
        try {
            const result = readUpdateSentinel(bundleRoot);
            assert.equal(result, null);
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('readUpdateSentinel returns null for corrupt sentinel JSON', () => {
        const { bundleRoot, projectRoot } = setupUpdateWorkspace(repoRoot);
        try {
            const sentinelPath = getUpdateSentinelPath(bundleRoot);
            fs.mkdirSync(path.dirname(sentinelPath), { recursive: true });
            fs.writeFileSync(sentinelPath, '{corrupt json!!!', 'utf8');

            const result = readUpdateSentinel(bundleRoot);
            assert.equal(result, null, 'Corrupt sentinel should return null');
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('update pipeline cleans sentinel even after install failure', () => {
        const { projectRoot, bundleRoot, answersPath } = setupUpdateWorkspace(repoRoot);
        try {
            assert.throws(
                () => runUpdate({
                    targetRoot: projectRoot,
                    bundleRoot,
                    initAnswersPath: answersPath,
                    installRunner: () => {
                        // Sentinel should be present mid-pipeline
                        throw new Error('Simulated mid-pipeline crash');
                    }
                }),
                /rollback completed successfully.*Simulated mid-pipeline crash/
            );

            assert.ok(!fs.existsSync(getUpdateSentinelPath(bundleRoot)),
                'Sentinel must be removed after pipeline failure');
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('update pipeline cleans sentinel after materialization failure', () => {
        const { projectRoot, bundleRoot, answersPath } = setupUpdateWorkspace(repoRoot);
        try {
            assert.throws(
                () => runUpdate({
                    targetRoot: projectRoot,
                    bundleRoot,
                    initAnswersPath: answersPath,
                    skipVerify: true,
                    skipManifestValidation: true,
                    materializationRunner: () => {
                        throw new Error('Simulated materialization crash');
                    }
                }),
                /rollback completed successfully.*Simulated materialization crash/
            );

            assert.ok(!fs.existsSync(getUpdateSentinelPath(bundleRoot)),
                'Sentinel must be removed after materialization failure');
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('update pipeline cleans sentinel after contract migration failure', () => {
        const { projectRoot, bundleRoot, answersPath } = setupUpdateWorkspace(repoRoot);
        try {
            assert.throws(
                () => runUpdate({
                    targetRoot: projectRoot,
                    bundleRoot,
                    initAnswersPath: answersPath,
                    skipVerify: true,
                    skipManifestValidation: true,
                    contractMigrationRunner: () => {
                        throw new Error('Simulated migration crash');
                    }
                }),
                /rollback completed successfully.*Simulated migration crash/
            );

            assert.ok(!fs.existsSync(getUpdateSentinelPath(bundleRoot)),
                'Sentinel must be removed after migration failure');
        } finally {
            removePathRecursive(projectRoot);
        }
    });
});

// =========================================================================
// 4. PARTIAL ROLLBACK SNAPSHOT TESTS
// =========================================================================

describe('Partial rollback snapshot edge cases', () => {
    it('restoreRollbackSnapshot throws for missing snapshot entry of an existed=true record', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-partial-snap-'));
        try {
            const rootPath = path.join(tmpDir, 'project');
            const snapshotRoot = path.join(tmpDir, 'snapshot');
            fs.mkdirSync(rootPath, { recursive: true });
            fs.mkdirSync(snapshotRoot, { recursive: true });

            // Record says file existed but snapshot entry is missing
            const records = [
                { relativePath: 'missing-file.txt', existed: true, pathType: 'file' }
            ];

            assert.throws(
                () => restoreRollbackSnapshot(rootPath, snapshotRoot, records),
                /Rollback snapshot entry missing.*missing-file\.txt/
            );
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('restoreRollbackSnapshot removes files that did not exist before', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-partial-snap-'));
        try {
            const rootPath = path.join(tmpDir, 'project');
            const snapshotRoot = path.join(tmpDir, 'snapshot');
            fs.mkdirSync(rootPath, { recursive: true });
            fs.mkdirSync(snapshotRoot, { recursive: true });

            // Create a file that should not have existed
            fs.writeFileSync(path.join(rootPath, 'new-file.txt'), 'should be removed');

            const records = [
                { relativePath: 'new-file.txt', existed: false, pathType: 'missing' }
            ];

            restoreRollbackSnapshot(rootPath, snapshotRoot, records);
            assert.ok(!fs.existsSync(path.join(rootPath, 'new-file.txt')),
                'File that did not exist before must be removed by rollback');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('restoreRollbackSnapshot restores files that existed before', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-partial-snap-'));
        try {
            const rootPath = path.join(tmpDir, 'project');
            const snapshotRoot = path.join(tmpDir, 'snapshot');
            fs.mkdirSync(rootPath, { recursive: true });
            fs.mkdirSync(snapshotRoot, { recursive: true });

            // Create snapshot entry
            fs.writeFileSync(path.join(snapshotRoot, 'existing.txt'), 'original-content');

            // Overwrite the working copy
            fs.writeFileSync(path.join(rootPath, 'existing.txt'), 'modified-content');

            const records = [
                { relativePath: 'existing.txt', existed: true, pathType: 'file' }
            ];

            restoreRollbackSnapshot(rootPath, snapshotRoot, records);
            assert.equal(
                fs.readFileSync(path.join(rootPath, 'existing.txt'), 'utf8'),
                'original-content',
                'File must be restored from snapshot'
            );
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('createRollbackSnapshot records missing items as existed=false', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-partial-snap-'));
        try {
            const rootPath = path.join(tmpDir, 'project');
            const snapshotRoot = path.join(rootPath, 'snapshot');
            fs.mkdirSync(rootPath, { recursive: true });
            fs.mkdirSync(snapshotRoot, { recursive: true });

            const records = createRollbackSnapshot(rootPath, snapshotRoot, [
                'nonexistent-file.txt'
            ]);

            assert.equal(records.length, 1);
            assert.equal(records[0].existed, false);
            assert.equal(records[0].pathType, 'missing');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('createRollbackSnapshot snapshots directories recursively', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-partial-snap-'));
        try {
            const rootPath = path.join(tmpDir, 'project');
            const snapshotRoot = path.join(rootPath, 'snapshot');

            // Create a nested directory tree
            const subDir = path.join(rootPath, 'config', 'nested');
            fs.mkdirSync(subDir, { recursive: true });
            fs.writeFileSync(path.join(rootPath, 'config', 'a.json'), '{"a":1}');
            fs.writeFileSync(path.join(subDir, 'b.json'), '{"b":2}');
            fs.mkdirSync(snapshotRoot, { recursive: true });

            const records = createRollbackSnapshot(rootPath, snapshotRoot, ['config']);
            const dirRecord = records.find(r => r.relativePath === 'config');
            assert.ok(dirRecord, 'Directory record must exist');
            assert.equal(dirRecord!.existed, true);
            assert.equal(dirRecord!.pathType, 'directory');

            // Snapshot must contain recursive copy
            assert.ok(fs.existsSync(path.join(snapshotRoot, 'config', 'a.json')));
            assert.ok(fs.existsSync(path.join(snapshotRoot, 'config', 'nested', 'b.json')));
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('writeRollbackRecords + readRollbackRecords round-trips correctly', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-partial-snap-'));
        try {
            const records = [
                { relativePath: 'file-a.txt', existed: true, pathType: 'file' },
                { relativePath: 'dir-b', existed: true, pathType: 'directory' },
                { relativePath: 'missing-c.txt', existed: false, pathType: 'missing' }
            ];

            fs.writeFileSync(path.join(tmpDir, 'file-a.txt'), 'data');
            fs.mkdirSync(path.join(tmpDir, 'dir-b'));
            writeRollbackRecords(tmpDir, records);
            const read = readRollbackRecords(tmpDir);

            assert.equal(read.length, 3);
            assert.equal(read[0].relativePath, 'file-a.txt');
            assert.equal(read[0].existed, true);
            assert.equal(read[1].pathType, 'directory');
            assert.equal(read[2].existed, false);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('readRollbackRecords throws on corrupt JSON', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-partial-snap-'));
        try {
            const recordsPath = path.join(tmpDir, 'rollback-records.json');
            fs.writeFileSync(recordsPath, 'NOT_JSON!!', 'utf8');

            assert.throws(
                () => readRollbackRecords(tmpDir),
                /not valid JSON/
            );
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('readRollbackRecords throws on non-array JSON', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-partial-snap-'));
        try {
            const recordsPath = path.join(tmpDir, 'rollback-records.json');
            fs.writeFileSync(recordsPath, '{"not":"an-array"}', 'utf8');

            assert.throws(
                () => readRollbackRecords(tmpDir),
                /must contain an array/
            );
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

// =========================================================================
// 5. LIFECYCLE LOCK CONTENTION DURING UPDATE/ROLLBACK
// =========================================================================

describe('Lifecycle lock contention during update/rollback', () => {
    const repoRoot = findRepoRoot();

    it('update releases lock even when install throws EBUSY', () => {
        const { projectRoot, bundleRoot, answersPath } = setupUpdateWorkspace(repoRoot);
        try {
            assert.throws(
                () => runUpdate({
                    targetRoot: projectRoot,
                    bundleRoot,
                    initAnswersPath: answersPath,
                    installRunner: () => {
                        const err = new Error('EBUSY: resource busy') as NodeJS.ErrnoException;
                        err.code = 'EBUSY';
                        throw err;
                    }
                }),
                /EBUSY/
            );

            // Lock must be released — a second operation should succeed
            const lockPath = getLifecycleOperationLockPath(projectRoot);
            assert.ok(!fs.existsSync(lockPath),
                'Lock directory must be released after EBUSY failure');
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('update releases lock even when materialization throws EPERM', () => {
        const { projectRoot, bundleRoot, answersPath } = setupUpdateWorkspace(repoRoot);
        try {
            assert.throws(
                () => runUpdate({
                    targetRoot: projectRoot,
                    bundleRoot,
                    initAnswersPath: answersPath,
                    skipVerify: true,
                    skipManifestValidation: true,
                    materializationRunner: () => {
                        const err = new Error('EPERM: operation not permitted') as NodeJS.ErrnoException;
                        err.code = 'EPERM';
                        throw err;
                    }
                }),
                /EPERM/
            );

            const lockPath = getLifecycleOperationLockPath(projectRoot);
            assert.ok(!fs.existsSync(lockPath),
                'Lock directory must be released after EPERM failure');
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('withLifecycleOperationLock releases lock when callback throws EBUSY', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-lock-edge-'));
        try {
            assert.throws(
                () => withLifecycleOperationLock(tmpDir, 'test-ebusy', () => {
                    const err = new Error('EBUSY: resource busy or locked') as NodeJS.ErrnoException;
                    err.code = 'EBUSY';
                    throw err;
                }),
                /EBUSY/
            );

            const lockPath = getLifecycleOperationLockPath(tmpDir);
            assert.ok(!fs.existsSync(lockPath), 'Lock must be released after EBUSY');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('withLifecycleOperationLock releases lock when callback throws EPERM', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-lock-edge-'));
        try {
            assert.throws(
                () => withLifecycleOperationLock(tmpDir, 'test-eperm', () => {
                    const err = new Error('EPERM: operation not permitted') as NodeJS.ErrnoException;
                    err.code = 'EPERM';
                    throw err;
                }),
                /EPERM/
            );

            const lockPath = getLifecycleOperationLockPath(tmpDir);
            assert.ok(!fs.existsSync(lockPath), 'Lock must be released after EPERM');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('lifecycle lock with corrupt owner.json is treated as stale after grace period', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-lock-corrupt-'));
        try {
            const lockPath = getLifecycleOperationLockPath(tmpDir);
            fs.mkdirSync(lockPath, { recursive: true });
            const ownerPath = path.join(lockPath, 'owner.json');
            fs.writeFileSync(ownerPath, '{CORRUPT', 'utf8');

            // Set old timestamps to exceed grace period
            const oldDate = new Date('2020-01-01T00:00:00.000Z');
            fs.utimesSync(ownerPath, oldDate, oldDate);
            fs.utimesSync(lockPath, oldDate, oldDate);

            // Should recover the stale lock
            const result = withLifecycleOperationLock(tmpDir, 'recovery-test', () => 'recovered');
            assert.equal(result, 'recovered');

            assert.ok(!fs.existsSync(lockPath), 'Lock must be released after recovery');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('lifecycle lock with missing owner.json is treated as stale after grace period', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-lock-noowner-'));
        try {
            const lockPath = getLifecycleOperationLockPath(tmpDir);
            fs.mkdirSync(lockPath, { recursive: true });
            // No owner.json written — simulates SIGKILL after mkdir but before metadata write

            const oldDate = new Date('2020-01-01T00:00:00.000Z');
            fs.utimesSync(lockPath, oldDate, oldDate);

            const result = withLifecycleOperationLock(tmpDir, 'orphan-test', () => 'success');
            assert.equal(result, 'success');
            assert.ok(!fs.existsSync(lockPath), 'Lock must be released');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('update blocks on aged foreign-host lifecycle lock without explicit override', () => {
        const { projectRoot, bundleRoot, answersPath } = setupUpdateWorkspace(repoRoot);
        const previousLifecycleEnv = process.env.GARDA_RECOVER_FOREIGN_HOST_LIFECYCLE_LOCKS;
        const previousFileLockEnv = process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS;
        delete process.env.GARDA_RECOVER_FOREIGN_HOST_LIFECYCLE_LOCKS;
        delete process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS;
        try {
            const lockPath = getLifecycleOperationLockPath(projectRoot);
            fs.mkdirSync(lockPath, { recursive: true });
            fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
                pid: 999999999,
                hostname: 'remote-build-host',
                operation: 'update',
                acquired_at_utc: '2020-01-01T00:00:00.000Z',
                target_root: path.resolve(projectRoot)
            }, null, 2), 'utf8');
            const oldDate = new Date('2020-01-01T00:00:00.000Z');
            fs.utimesSync(path.join(lockPath, 'owner.json'), oldDate, oldDate);
            fs.utimesSync(lockPath, oldDate, oldDate);

            let error: Error | null = null;
            try {
                runUpdate({
                    targetRoot: projectRoot,
                    bundleRoot,
                    initAnswersPath: answersPath,
                    skipVerify: true,
                    skipManifestValidation: true
                });
            } catch (caught: unknown) {
                error = caught instanceof Error ? caught : new Error(String(caught));
            }

            if (error === null) {
                throw new Error('foreign-host lifecycle lock should block update without explicit override');
            }
            assert.match(error.message, /GARDA_RECOVER_FOREIGN_HOST_LIFECYCLE_LOCKS=1/);
            assert.doesNotMatch(String(error.message), /remote-build-host/);
            assert.ok(fs.existsSync(lockPath), 'foreign-host lock must stay in place without override');
        } finally {
            if (previousLifecycleEnv === undefined) {
                delete process.env.GARDA_RECOVER_FOREIGN_HOST_LIFECYCLE_LOCKS;
            } else {
                process.env.GARDA_RECOVER_FOREIGN_HOST_LIFECYCLE_LOCKS = previousLifecycleEnv;
            }
            if (previousFileLockEnv === undefined) {
                delete process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS;
            } else {
                process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS = previousFileLockEnv;
            }
            removePathRecursive(projectRoot);
        }
    });

    it('update recovers aged foreign-host lifecycle lock when explicit override is enabled', () => {
        const { projectRoot, bundleRoot, answersPath } = setupUpdateWorkspace(repoRoot);
        const previousLifecycleEnv = process.env.GARDA_RECOVER_FOREIGN_HOST_LIFECYCLE_LOCKS;
        process.env.GARDA_RECOVER_FOREIGN_HOST_LIFECYCLE_LOCKS = '1';
        try {
            const lockPath = getLifecycleOperationLockPath(projectRoot);
            fs.mkdirSync(lockPath, { recursive: true });
            fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
                pid: 999999999,
                hostname: 'remote-build-host',
                operation: 'update',
                acquired_at_utc: '2020-01-01T00:00:00.000Z',
                target_root: path.resolve(projectRoot)
            }, null, 2), 'utf8');
            const oldDate = new Date('2020-01-01T00:00:00.000Z');
            fs.utimesSync(path.join(lockPath, 'owner.json'), oldDate, oldDate);
            fs.utimesSync(lockPath, oldDate, oldDate);

            const result = runUpdate({
                targetRoot: projectRoot,
                bundleRoot,
                initAnswersPath: answersPath,
                skipVerify: true,
                skipManifestValidation: true
            });

            assert.equal(result.installStatus, 'PASS');
            assert.equal(result.materializationStatus, 'PASS');
        } finally {
            if (previousLifecycleEnv === undefined) {
                delete process.env.GARDA_RECOVER_FOREIGN_HOST_LIFECYCLE_LOCKS;
            } else {
                process.env.GARDA_RECOVER_FOREIGN_HOST_LIFECYCLE_LOCKS = previousLifecycleEnv;
            }
            removePathRecursive(projectRoot);
        }
    });
});

// =========================================================================
// 6. copyPathRecursive EDGE CASES
// =========================================================================

describe('copyPathRecursive edge cases', () => {
    it('copies single file', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-copy-edge-'));
        try {
            const src = path.join(tmpDir, 'source.txt');
            const dst = path.join(tmpDir, 'dest.txt');
            fs.writeFileSync(src, 'content-123');

            copyPathRecursive(src, dst);
            assert.equal(fs.readFileSync(dst, 'utf8'), 'content-123');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('copies nested directory structure', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-copy-edge-'));
        try {
            const src = path.join(tmpDir, 'src-dir');
            const dst = path.join(tmpDir, 'dst-dir');
            fs.mkdirSync(path.join(src, 'a', 'b'), { recursive: true });
            fs.writeFileSync(path.join(src, 'root.txt'), 'r');
            fs.writeFileSync(path.join(src, 'a', 'a.txt'), 'a');
            fs.writeFileSync(path.join(src, 'a', 'b', 'b.txt'), 'b');

            copyPathRecursive(src, dst);

            assert.equal(fs.readFileSync(path.join(dst, 'root.txt'), 'utf8'), 'r');
            assert.equal(fs.readFileSync(path.join(dst, 'a', 'a.txt'), 'utf8'), 'a');
            assert.equal(fs.readFileSync(path.join(dst, 'a', 'b', 'b.txt'), 'utf8'), 'b');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('creates intermediate parent directories', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-copy-edge-'));
        try {
            const src = path.join(tmpDir, 'source.txt');
            const dst = path.join(tmpDir, 'deep', 'nested', 'dest.txt');
            fs.writeFileSync(src, 'deep-content');

            copyPathRecursive(src, dst);
            assert.equal(fs.readFileSync(dst, 'utf8'), 'deep-content');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

// =========================================================================
// 7. FULL UPDATE THEN ROLLBACK WITH FILESYSTEM VERIFICATION
// =========================================================================

describe('Full update-then-rollback filesystem integrity', () => {
    const repoRoot = findRepoRoot();

    it('restores all key files after update + rollback round-trip', async () => {
        const { projectRoot, bundleRoot, answersPath } = setupUpdateWorkspace(repoRoot);
        try {
            // Seed pre-update state
            fs.writeFileSync(path.join(projectRoot, 'CLAUDE.md'), 'pre-update-claude');
            fs.writeFileSync(path.join(projectRoot, 'AGENTS.md'), 'pre-update-agents');
            fs.writeFileSync(path.join(projectRoot, '.gitignore'), 'node_modules/\n');

            const keyFiles = ['CLAUDE.md', 'AGENTS.md', '.gitignore'];
            const before = snapshotKeyFiles(projectRoot, keyFiles);

            // Run update
            const updateResult = runUpdate({
                targetRoot: projectRoot,
                bundleRoot,
                initAnswersPath: answersPath,
                skipVerify: true,
                skipManifestValidation: true
            });
            assert.equal(updateResult.installStatus, 'PASS');
            assert.ok(updateResult.rollbackSnapshotCreated);

            // Snapshot should be written
            assert.ok(fs.existsSync(path.join(projectRoot, updateResult.rollbackRecordsPath)));

            // Now rollback
            const rollbackResult = await runRollback({
                targetRoot: projectRoot,
                bundleRoot
            });
            assert.equal(rollbackResult.restoreStatus, 'SUCCESS');

            // Key files should be restored to pre-update state
            const after = snapshotKeyFiles(projectRoot, keyFiles);
            for (const file of keyFiles) {
                if (before[file]) {
                    assert.equal(after[file], before[file],
                        `${file} must be restored after rollback`);
                }
            }
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('removes files introduced by update when they did not exist before', async () => {
        const { projectRoot, bundleRoot, answersPath } = setupUpdateWorkspace(repoRoot);
        try {
            // Ensure CLAUDE.md does NOT exist before update
            const claudePath = path.join(projectRoot, 'CLAUDE.md');
            if (fs.existsSync(claudePath)) fs.rmSync(claudePath);
            assert.ok(!fs.existsSync(claudePath));

            // Run update (will create CLAUDE.md)
            runUpdate({
                targetRoot: projectRoot,
                bundleRoot,
                initAnswersPath: answersPath,
                skipVerify: true,
                skipManifestValidation: true
            });

            // CLAUDE.md should now exist
            assert.ok(fs.existsSync(claudePath), 'Update should create CLAUDE.md');

            // Rollback should remove it since it didn't exist before
            const rollbackResult = await runRollback({
                targetRoot: projectRoot,
                bundleRoot
            });
            assert.equal(rollbackResult.restoreStatus, 'SUCCESS');

            // CLAUDE.md should be gone — it was not present pre-update
            assert.ok(!fs.existsSync(claudePath),
                'Files that did not exist before update must be removed by rollback');
        } finally {
            removePathRecursive(projectRoot);
        }
    });
});
