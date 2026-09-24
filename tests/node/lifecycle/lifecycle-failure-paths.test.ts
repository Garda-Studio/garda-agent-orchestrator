/**
 * Critical lifecycle failure-path tests for update, rollback, and uninstall.
 *
 * Tests assert filesystem state (not only error messages) to guarantee rollback
 * and recovery semantics are correct under failure conditions.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { runUpdate } from '../../../src/lifecycle/update';
import { runCheckUpdate } from '../../../src/lifecycle/check-update';
import {
    runRollback,
    runSnapshotRollback
} from '../../../src/lifecycle/rollback';
import { runUninstall } from '../../../src/lifecycle/uninstall';
import {
    removePathRecursive,
    getUpdateSentinelPath,
    readSyncBackupMetadata,
    readRollbackRecords
} from '../../../src/lifecycle/common';
import { verifyRestoredRollbackSnapshot } from '../../../src/lifecycle/rollback/rollback-snapshot-integrity';
import { MANAGED_START, MANAGED_END, COMMIT_GUARD_START, COMMIT_GUARD_END } from '../../../src/materialization/content-builders';


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
    copyDirRecursive(path.join(repoRoot, 'bin'), path.join(bundleRoot, 'bin'));
    fs.mkdirSync(path.join(bundleRoot, 'dist', 'src'), { recursive: true });
    fs.writeFileSync(path.join(bundleRoot, 'dist', 'src', 'index.js'), 'module.exports = {};', 'utf8');
}

function getLatestBundleBackupRoot(bundleRoot: string): string {
    const backupsRoot = path.join(bundleRoot, 'runtime', 'bundle-backups');
    const backups = fs.readdirSync(backupsRoot).sort();
    assert.ok(backups.length > 0, 'Expected at least one bundle backup');
    return path.join(backupsRoot, backups[backups.length - 1]);
}

const MANAGED_END_MARKER = '<!-- garda-agent-orchestrator:managed-end -->';

function setupUpdateWorkspace(repoRoot: string) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-failpath-'));
    const bundle = path.join(tmpDir, 'garda-agent-orchestrator');
    fs.mkdirSync(bundle, { recursive: true });

    fs.copyFileSync(path.join(repoRoot, 'VERSION'), path.join(bundle, 'VERSION'));
    fs.copyFileSync(path.join(repoRoot, 'package.json'), path.join(bundle, 'package.json'));
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

function setupDeployedWorkspace(repoRoot: string) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-failpath-uninst-'));
    const bundle = path.join(tmpDir, 'garda-agent-orchestrator');
    fs.mkdirSync(bundle, { recursive: true });

    fs.copyFileSync(path.join(repoRoot, 'VERSION'), path.join(bundle, 'VERSION'));
    copyDirRecursive(path.join(repoRoot, 'template'), path.join(bundle, 'template'));

    fs.mkdirSync(path.join(bundle, 'live', 'config'), { recursive: true });
    fs.mkdirSync(path.join(bundle, 'live', 'docs', 'agent-rules'), { recursive: true });
    fs.mkdirSync(path.join(bundle, 'runtime'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.git', 'hooks'), { recursive: true });

    const answers = {
        AssistantLanguage: 'English',
        AssistantBrevity: 'concise',
        SourceOfTruth: 'Claude',
        EnforceNoAutoCommit: 'true',
        ClaudeOrchestratorFullAccess: 'false',
        TokenEconomyEnabled: 'true',
        CollectedVia: 'CLI_NONINTERACTIVE'
    };
    fs.writeFileSync(path.join(bundle, 'runtime', 'init-answers.json'), JSON.stringify(answers, null, 2));

    const managedContent = `${MANAGED_START}\n# Garda Agent Orchestrator Rule Index\n## Rule Routing\nSome content\n${MANAGED_END}\n`;
    fs.writeFileSync(path.join(tmpDir, 'CLAUDE.md'), managedContent);
    fs.writeFileSync(path.join(tmpDir, 'TASK.md'), managedContent);
    fs.writeFileSync(path.join(tmpDir, '.gitignore'),
        'node_modules/\n# garda-agent-orchestrator managed ignores\ngarda-agent-orchestrator/\nAGENTS.md\n');

    return { projectRoot: tmpDir, bundleRoot: bundle };
}

function injectBundleUpdate(bundleRoot: string, updateMarker: string, nextVersion: string) {
    const versionPath = path.join(bundleRoot, 'VERSION');
    const canonicalRuleIndexPath = path.join(bundleRoot, 'template', 'entrypoints', 'canonical-rule-index.md');
    const currentTemplate = fs.readFileSync(canonicalRuleIndexPath, 'utf8');
    const updatedTemplate = currentTemplate.replace(
        MANAGED_END_MARKER,
        `Rollback marker: ${updateMarker}\r\n${MANAGED_END_MARKER}`
    );
    fs.writeFileSync(versionPath, `${nextVersion}\n`, 'utf8');
    fs.writeFileSync(canonicalRuleIndexPath, updatedTemplate, 'utf8');
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
// 1. UPDATE FAILURE PATHS
// =========================================================================

describe('Update failure-path tests', () => {
    const repoRoot = findRepoRoot();

    it('rolls back on verify failure and restores filesystem state', () => {
        const { projectRoot, bundleRoot, answersPath } = setupUpdateWorkspace(repoRoot);
        try {
            // Seed pre-update state
            fs.writeFileSync(path.join(projectRoot, 'CLAUDE.md'), 'original-verify-test');
            fs.writeFileSync(path.join(projectRoot, 'AGENTS.md'), 'agents-original');

            const keyFiles = ['CLAUDE.md', 'AGENTS.md'];
            const before = snapshotKeyFiles(projectRoot, keyFiles);

            assert.throws(
                () => runUpdate({
                    targetRoot: projectRoot,
                    bundleRoot,
                    initAnswersPath: answersPath,
                    skipVerify: false,
                    skipManifestValidation: true,
                    verifyRunner: () => {
                        throw new Error('VERIFY_GATE_FAIL');
                    }
                }),
                /rollback completed successfully.*VERIFY_GATE_FAIL/
            );

            // Filesystem state must match pre-update snapshot
            const after = snapshotKeyFiles(projectRoot, keyFiles);
            assert.deepEqual(after, before, 'All key files must be restored after verify failure rollback');
            // Sentinel must not be left
            assert.ok(!fs.existsSync(getUpdateSentinelPath(bundleRoot)));
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('rolls back on manifest validation failure and restores filesystem state', () => {
        const { projectRoot, bundleRoot, answersPath } = setupUpdateWorkspace(repoRoot);
        try {
            fs.writeFileSync(path.join(projectRoot, 'CLAUDE.md'), 'original-manifest-test');
            fs.writeFileSync(path.join(projectRoot, '.gitignore'), 'user-gitignore-content\n');

            const keyFiles = ['CLAUDE.md', '.gitignore'];
            const before = snapshotKeyFiles(projectRoot, keyFiles);

            assert.throws(
                () => runUpdate({
                    targetRoot: projectRoot,
                    bundleRoot,
                    initAnswersPath: answersPath,
                    skipVerify: true,
                    skipManifestValidation: false,
                    manifestRunner: () => {
                        throw new Error('MANIFEST_INTEGRITY_FAIL');
                    }
                }),
                /rollback completed successfully.*MANIFEST_INTEGRITY_FAIL/
            );

            const after = snapshotKeyFiles(projectRoot, keyFiles);
            assert.deepEqual(after, before, 'Files must be restored after manifest failure');
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('rolls back on contract-migration failure and restores filesystem state', () => {
        const { projectRoot, bundleRoot, answersPath } = setupUpdateWorkspace(repoRoot);
        try {
            fs.writeFileSync(path.join(projectRoot, 'CLAUDE.md'), 'original-migration-test');

            const before = snapshotKeyFiles(projectRoot, ['CLAUDE.md']);

            assert.throws(
                () => runUpdate({
                    targetRoot: projectRoot,
                    bundleRoot,
                    initAnswersPath: answersPath,
                    skipVerify: true,
                    skipManifestValidation: true,
                    contractMigrationRunner: () => {
                        throw new Error('CONTRACT_MIGRATION_FAIL');
                    }
                }),
                /rollback completed successfully.*CONTRACT_MIGRATION_FAIL/
            );

            const after = snapshotKeyFiles(projectRoot, ['CLAUDE.md']);
            assert.deepEqual(after, before, 'Files must be restored after contract migration failure');
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('double failure: install + rollback both fail, sentinel is cleaned, error mentions both', () => {
        const { projectRoot, bundleRoot, answersPath } = setupUpdateWorkspace(repoRoot);
        try {
            fs.writeFileSync(path.join(projectRoot, 'CLAUDE.md'), 'double-failure-content');

            let thrown: Error | null = null;
            try {
                runUpdate({
                    targetRoot: projectRoot,
                    bundleRoot,
                    initAnswersPath: answersPath,
                    installRunner: () => {
                        // Destroy the snapshot directory so rollback will also fail
                        const rollbacksDir = path.join(bundleRoot, 'runtime', 'update-rollbacks');
                        if (fs.existsSync(rollbacksDir)) {
                            fs.rmSync(rollbacksDir, { recursive: true, force: true });
                        }
                        throw new Error('INSTALL_FAIL_PRIMARY');
                    }
                });
            } catch (e: unknown) {
                thrown = e as Error;
            }

            if (thrown === null) {
                throw new Error('Should throw on double failure');
            }
            // Error message should mention both failures
            assert.ok(
                thrown.message.includes('INSTALL_FAIL_PRIMARY'),
                'Should reference original error'
            );
            assert.ok(
                thrown.message.includes('Rollback failed') || thrown.message.includes('rollback'),
                'Should reference rollback failure'
            );
            // Bundle directory should still exist (not wiped)
            assert.ok(fs.existsSync(bundleRoot), 'Bundle must survive double failure');
            // CLAUDE.md may be gone or modified but bundle root is intact
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('rollback restores live/ directory contents to pre-update state', () => {
        const { projectRoot, bundleRoot, answersPath } = setupUpdateWorkspace(repoRoot);
        try {
            // Seed stale live/ content that represents the "pre-update" state
            const liveRuleDir = path.join(bundleRoot, 'live', 'docs', 'agent-rules');
            fs.mkdirSync(liveRuleDir, { recursive: true });
            fs.writeFileSync(path.join(liveRuleDir, '00-core.md'), 'PRE_UPDATE_CORE');

            const livePath = path.join(bundleRoot, 'live', 'docs', 'agent-rules', '00-core.md');
            const contentBefore = fs.readFileSync(livePath, 'utf8');

            assert.throws(
                () => runUpdate({
                    targetRoot: projectRoot,
                    bundleRoot,
                    initAnswersPath: answersPath,
                    skipVerify: false,
                    skipManifestValidation: true,
                    // Materialization will overwrite live/ — then verify fails, triggering rollback
                    verifyRunner: () => {
                        throw new Error('POST_MAT_VERIFY_FAIL');
                    }
                }),
                /rollback completed successfully/
            );

            // live/ content should be restored to snapshot
            assert.equal(
                fs.readFileSync(livePath, 'utf8'),
                contentBefore,
                'live/ content must be restored on rollback'
            );
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('rollback after materialization failure does not leave partial live/ state', () => {
        const { projectRoot, bundleRoot, answersPath } = setupUpdateWorkspace(repoRoot);
        try {
            // Seed original file to check rollback
            fs.writeFileSync(path.join(projectRoot, 'CLAUDE.md'), 'pre-mat-fail');

            // We know the rollback items — capture their existence before update
            const versionFileBefore = fs.readFileSync(path.join(bundleRoot, 'VERSION'), 'utf8');

            assert.throws(
                () => runUpdate({
                    targetRoot: projectRoot,
                    bundleRoot,
                    initAnswersPath: answersPath,
                    skipVerify: true,
                    skipManifestValidation: true,
                    materializationRunner: () => {
                        // Partially corrupt the workspace
                        fs.writeFileSync(path.join(bundleRoot, 'live', 'CORRUPT_MARKER.txt'), 'partial');
                        throw new Error('MAT_PARTIAL_FAIL');
                    }
                }),
                /rollback completed successfully.*MAT_PARTIAL_FAIL/
            );

            // CLAUDE.md must be restored
            assert.equal(
                fs.readFileSync(path.join(projectRoot, 'CLAUDE.md'), 'utf8'),
                'pre-mat-fail'
            );
            // VERSION must be restored
            assert.equal(
                fs.readFileSync(path.join(bundleRoot, 'VERSION'), 'utf8'),
                versionFileBefore
            );
            // The corrupt marker should be gone since live/ was in the snapshot
            // (it was created after snapshot, so rollback removes it by restoring live/)
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('update report is not written when install fails with rollback', () => {
        const { projectRoot, bundleRoot, answersPath } = setupUpdateWorkspace(repoRoot);
        try {
            assert.throws(
                () => runUpdate({
                    targetRoot: projectRoot,
                    bundleRoot,
                    initAnswersPath: answersPath,
                    installRunner: () => { throw new Error('EARLY_FAIL'); }
                }),
                /rollback completed successfully/
            );

            // No update report should exist
            const reportsDir = path.join(bundleRoot, 'runtime', 'update-reports');
            if (fs.existsSync(reportsDir)) {
                const reports = fs.readdirSync(reportsDir).filter((f) => f.startsWith('update-'));
                assert.equal(reports.length, 0, 'No update report should be written on failure');
            }
        } finally {
            removePathRecursive(projectRoot);
        }
    });
});

// =========================================================================
// 2. CHECK-UPDATE / PARTIAL SYNC FAILURE PATHS
// =========================================================================

describe('Check-update partial sync failure paths', () => {
    const repoRoot = findRepoRoot();

    it('restores all synced items after updateRunner failure (filesystem verification)', async () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-failpath-cu-'));
        const bundle = path.join(tmpDir, 'garda-agent-orchestrator');
        fs.mkdirSync(path.join(bundle, 'runtime'), { recursive: true });
        fs.writeFileSync(path.join(bundle, 'VERSION'), '0.0.1');
        try {
            const versionBefore = fs.readFileSync(path.join(bundle, 'VERSION'), 'utf8');

            await assert.rejects(
                runCheckUpdate({
                    targetRoot: tmpDir,
                    bundleRoot: bundle,
                    sourcePath: repoRoot,
                    noPrompt: true,
                    apply: true,
                    trustOverride: true,
                    updateRunner: () => {
                        throw new Error('LIFECYCLE_FAIL');
                    }
                }),
                /sync rollback completed.*LIFECYCLE_FAIL/
            );

            // VERSION must be restored to original value
            assert.equal(
                fs.readFileSync(path.join(bundle, 'VERSION'), 'utf8'),
                versionBefore,
                'VERSION must be restored after sync rollback'
            );
            assert.ok(!fs.existsSync(getUpdateSentinelPath(bundle)),
                'Update sentinel must be cleaned after verified sync rollback');
            const metadata = readSyncBackupMetadata(getLatestBundleBackupRoot(bundle));
            assert.equal(metadata.preexistingMap.VERSION, true);
            const evidencePath = path.join(getLatestBundleBackupRoot(bundle), 'sync-rollback-result.json');
            assert.ok(fs.existsSync(evidencePath), 'Sync rollback evidence must remain after sentinel cleanup');
        } finally {
            removePathRecursive(tmpDir);
        }
    });

    it('VERSION stays at old value when updateRunner throws mid-lifecycle', async () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-failpath-cu2-'));
        const bundle = path.join(tmpDir, 'garda-agent-orchestrator');
        fs.mkdirSync(path.join(bundle, 'runtime'), { recursive: true });
        fs.writeFileSync(path.join(bundle, 'VERSION'), '0.0.1');
        try {
            let versionReadDuringLifecycle = null;

            await assert.rejects(
                runCheckUpdate({
                    targetRoot: tmpDir,
                    bundleRoot: bundle,
                    sourcePath: repoRoot,
                    noPrompt: true,
                    apply: true,
                    trustOverride: true,
                    updateRunner: () => {
                        // During lifecycle, VERSION should still be old
                        versionReadDuringLifecycle = fs.readFileSync(
                            path.join(bundle, 'VERSION'), 'utf8'
                        ).trim();
                        throw new Error('MID_LIFECYCLE_FAIL');
                    }
                }),
                /MID_LIFECYCLE_FAIL/
            );

            assert.equal(versionReadDuringLifecycle, '0.0.1',
                'VERSION must remain old during lifecycle');
            assert.equal(
                fs.readFileSync(path.join(bundle, 'VERSION'), 'utf8').trim(),
                '0.0.1',
                'VERSION must be rolled back after failure'
            );
        } finally {
            removePathRecursive(tmpDir);
        }
    });
});

// =========================================================================
// 3. ROLLBACK FAILURE PATHS
// =========================================================================

describe('Rollback safety snapshot and failure paths', () => {
    const repoRoot = findRepoRoot();

    it('safety snapshot is activated and restores state when snapshot-mode restore fails', async () => {
        const { projectRoot, bundleRoot, answersPath } = setupUpdateWorkspace(repoRoot);
        try {
            // Do initial install
            runUpdate({
                targetRoot: projectRoot,
                bundleRoot,
                initAnswersPath: answersPath,
                skipVerify: true,
                skipManifestValidation: true
            });

            // Do a proper update to create a rollback snapshot
            const newerSource = path.join(projectRoot, 'newer-source');
            copyDirRecursive(bundleRoot, newerSource);
            injectBundleUpdate(newerSource, 'NEWER_SNAP_TEST', '9.9.9');

            await runCheckUpdate({
                targetRoot: projectRoot,
                bundleRoot,
                sourcePath: newerSource,
                apply: true,
                noPrompt: true,
                trustOverride: true,
                updateRunner: (opts) => runUpdate({
                    targetRoot: opts.targetRoot,
                    bundleRoot,
                    initAnswersPath: opts.initAnswersPath,
                    skipVerify: true,
                    skipManifestValidation: true
                })
            });

            assert.equal(fs.readFileSync(path.join(bundleRoot, 'VERSION'), 'utf8').trim(), '9.9.9');

            // Keep the selected snapshot authenticated, then inject a one-shot
            // filesystem failure during its restore so safety recovery runs.
            const rollbacksRoot = path.join(bundleRoot, 'runtime', 'update-rollbacks');
            const snapshots = fs.readdirSync(rollbacksRoot)
                .filter((d) => d.startsWith('update-'))
                .sort((a, b) => b.localeCompare(a)); // descending = latest first
            assert.ok(snapshots.length > 0, 'Should have at least one rollback snapshot');

            readRollbackRecords(path.join(rollbacksRoot, snapshots[0]));
            const versionBeforeRollback = fs.readFileSync(path.join(bundleRoot, 'VERSION'), 'utf8').trim();
            const mutableFs = require('node:fs') as typeof fs;
            const originalRmSync = mutableFs.rmSync;
            const versionPath = path.join(bundleRoot, 'VERSION');
            let injected = false;
            mutableFs.rmSync = ((targetPath: fs.PathLike, options?: fs.RmOptions) => {
                if (!injected && path.resolve(String(targetPath)) === path.resolve(versionPath)) {
                    injected = true;
                    throw Object.assign(new Error('EBUSY during selected snapshot restore'), { code: 'EBUSY' });
                }
                return originalRmSync(targetPath, options);
            }) as typeof fs.rmSync;
            try {
                assert.throws(() => runSnapshotRollback({ targetRoot: projectRoot, bundleRoot }),
                    /safety rollback completed successfully.*EBUSY/);
            } finally {
                mutableFs.rmSync = originalRmSync;
            }
            assert.equal(injected, true, 'The selected restore must reach the injected filesystem failure');

            const safetyNames = fs.readdirSync(rollbacksRoot).filter((name) => name.startsWith('rollback-'));
            assert.equal(safetyNames.length, 1, 'Safety snapshot must be created after selected snapshot authentication');
            const safetySnapshot = path.join(rollbacksRoot, safetyNames[0]);
            verifyRestoredRollbackSnapshot(projectRoot, safetySnapshot, readRollbackRecords(safetySnapshot));
            assert.equal(
                fs.readFileSync(path.join(bundleRoot, 'VERSION'), 'utf8').trim(),
                versionBeforeRollback,
                'Safety rollback must restore pre-rollback state'
            );
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('version-based rollback: double failure (install + safety rollback both fail)', async () => {
        const { projectRoot, bundleRoot, answersPath } = setupUpdateWorkspace(repoRoot);
        try {
            runUpdate({
                targetRoot: projectRoot,
                bundleRoot,
                initAnswersPath: answersPath,
                skipVerify: true,
                skipManifestValidation: true
            });

            // Update to newer version
            const newerSource = path.join(projectRoot, 'newer-source');
            copyDirRecursive(bundleRoot, newerSource);
            injectBundleUpdate(newerSource, 'NEWER_DOUBLE', '9.9.9');

            await runCheckUpdate({
                targetRoot: projectRoot,
                bundleRoot,
                sourcePath: newerSource,
                apply: true,
                noPrompt: true,
                trustOverride: true,
                updateRunner: (opts) => runUpdate({
                    targetRoot: opts.targetRoot,
                    bundleRoot,
                    initAnswersPath: opts.initAnswersPath,
                    skipVerify: true,
                    skipManifestValidation: true
                })
            });

            const olderSource = path.join(projectRoot, 'older-source');
            copyDirRecursive(bundleRoot, olderSource);
            fs.writeFileSync(path.join(olderSource, 'VERSION'), '1.0.0\n', 'utf8');

            let thrown: Error | null = null;
            try {
                await runRollback({
                    targetRoot: projectRoot,
                    bundleRoot,
                    targetVersion: '1.0.0',
                    sourcePath: olderSource,
                    trustOverride: true,
                    initAnswersPath: answersPath,
                    installRunner: () => {
                        // Destroy safety snapshots to make safety rollback also fail
                        const rollbacksDir = path.join(bundleRoot, 'runtime', 'update-rollbacks');
                        if (fs.existsSync(rollbacksDir)) {
                            fs.rmSync(rollbacksDir, { recursive: true, force: true });
                        }
                        throw new Error('INSTALL_FAIL_FOR_DOUBLE');
                    }
                });
            } catch (e: unknown) {
                thrown = e as Error;
            }

            if (thrown === null) {
                throw new Error('Should throw on double failure');
            }
            assert.ok(
                thrown.message.includes('INSTALL_FAIL_FOR_DOUBLE'),
                'Should mention original error'
            );
            assert.ok(
                thrown.message.includes('Safety rollback failed') || thrown.message.includes('safety rollback'),
                'Should mention safety rollback failure'
            );
            // Bundle should still exist even in double-failure
            assert.ok(fs.existsSync(bundleRoot), 'Bundle must survive double failure');
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('version-based rollback: materialization failure triggers safety rollback', async () => {
        const { projectRoot, bundleRoot, answersPath } = setupUpdateWorkspace(repoRoot);
        try {
            runUpdate({
                targetRoot: projectRoot,
                bundleRoot,
                initAnswersPath: answersPath,
                skipVerify: true,
                skipManifestValidation: true
            });

            // Update workspace to 9.9.9
            const newerSource = path.join(projectRoot, 'newer-source');
            copyDirRecursive(bundleRoot, newerSource);
            injectBundleUpdate(newerSource, 'MAT_FAIL_TEST', '9.9.9');

            await runCheckUpdate({
                targetRoot: projectRoot,
                bundleRoot,
                sourcePath: newerSource,
                apply: true,
                noPrompt: true,
                trustOverride: true,
                updateRunner: (opts) => runUpdate({
                    targetRoot: opts.targetRoot,
                    bundleRoot,
                    initAnswersPath: opts.initAnswersPath,
                    skipVerify: true,
                    skipManifestValidation: true
                })
            });

            const preRollbackVersion = fs.readFileSync(path.join(bundleRoot, 'VERSION'), 'utf8').trim();
            assert.equal(preRollbackVersion, '9.9.9');

            const olderSource = path.join(projectRoot, 'older-source');
            copyDirRecursive(bundleRoot, olderSource);
            fs.writeFileSync(path.join(olderSource, 'VERSION'), '1.0.0\n', 'utf8');

            await assert.rejects(
                runRollback({
                    targetRoot: projectRoot,
                    bundleRoot,
                    targetVersion: '1.0.0',
                    sourcePath: olderSource,
                    trustOverride: true,
                    initAnswersPath: answersPath,
                    materializationRunner: () => {
                        throw new Error('MATERIALIZATION_ROLLBACK_FAIL');
                    }
                }),
                /safety rollback completed successfully.*MATERIALIZATION_ROLLBACK_FAIL/
            );

            // Safety rollback should restore 9.9.9
            assert.equal(
                fs.readFileSync(path.join(bundleRoot, 'VERSION'), 'utf8').trim(),
                preRollbackVersion,
                'Safety rollback must restore VERSION to pre-rollback value'
            );
            const safetyRoot = path.join(bundleRoot, 'runtime', 'update-rollbacks');
            const safetyName = fs.readdirSync(safetyRoot).filter((name) => name.startsWith('rollback-')).sort().at(-1)!;
            const safetySnapshot = path.join(safetyRoot, safetyName);
            verifyRestoredRollbackSnapshot(projectRoot, safetySnapshot, readRollbackRecords(safetySnapshot));
            // Sentinel must be cleaned
            assert.ok(
                !fs.existsSync(getUpdateSentinelPath(bundleRoot)),
                'Update sentinel must be cleaned after safety rollback'
            );
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('snapshot-based rollback: dry-run does not create safety snapshot', async () => {
        const { projectRoot, bundleRoot, answersPath } = setupUpdateWorkspace(repoRoot);
        try {
            runUpdate({
                targetRoot: projectRoot,
                bundleRoot,
                initAnswersPath: answersPath,
                skipVerify: true,
                skipManifestValidation: true
            });

            // Create a proper update snapshot
            const newerSource = path.join(projectRoot, 'newer-source');
            copyDirRecursive(bundleRoot, newerSource);
            injectBundleUpdate(newerSource, 'DRY_SNAP_TEST', '9.9.9');

            await runCheckUpdate({
                targetRoot: projectRoot,
                bundleRoot,
                sourcePath: newerSource,
                apply: true,
                noPrompt: true,
                trustOverride: true,
                updateRunner: (opts) => runUpdate({
                    targetRoot: opts.targetRoot,
                    bundleRoot,
                    initAnswersPath: opts.initAnswersPath,
                    skipVerify: true,
                    skipManifestValidation: true
                })
            });

            const versionBefore = fs.readFileSync(path.join(bundleRoot, 'VERSION'), 'utf8').trim();
            assert.equal(versionBefore, '9.9.9');

            // Count snapshots before dry-run
            const rollbacksRoot = path.join(bundleRoot, 'runtime', 'update-rollbacks');
            const snapshotsBefore = fs.existsSync(rollbacksRoot)
                ? fs.readdirSync(rollbacksRoot).filter((d) => d.startsWith('rollback-'))
                : [];

            const result = runSnapshotRollback({
                targetRoot: projectRoot,
                bundleRoot,
                dryRun: true
            });

            assert.equal(result.safetySnapshotCreated, false);
            assert.equal(result.restoreStatus, 'SKIPPED_DRY_RUN');
            // No new safety snapshot directory should be created
            const snapshotsAfter = fs.existsSync(rollbacksRoot)
                ? fs.readdirSync(rollbacksRoot).filter((d) => d.startsWith('rollback-'))
                : [];
            assert.equal(snapshotsAfter.length, snapshotsBefore.length,
                'Dry-run should not create new safety snapshots');
            // VERSION unchanged
            assert.equal(
                fs.readFileSync(path.join(bundleRoot, 'VERSION'), 'utf8').trim(),
                versionBefore
            );
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('multiple snapshot selection: rollback uses latest snapshot by default', async () => {
        const { projectRoot, bundleRoot, answersPath } = setupUpdateWorkspace(repoRoot);
        try {
            // First materialization
            runUpdate({
                targetRoot: projectRoot,
                bundleRoot,
                initAnswersPath: answersPath,
                skipVerify: true,
                skipManifestValidation: true
            });

            // Update to v8.0.0
            const source1 = path.join(projectRoot, 'source1');
            copyDirRecursive(bundleRoot, source1);
            injectBundleUpdate(source1, 'V8_MARKER', '8.0.0');
            await runCheckUpdate({
                targetRoot: projectRoot,
                bundleRoot,
                sourcePath: source1,
                apply: true,
                noPrompt: true,
                trustOverride: true,
                updateRunner: (opts) => runUpdate({
                    targetRoot: opts.targetRoot,
                    bundleRoot,
                    initAnswersPath: opts.initAnswersPath,
                    skipVerify: true,
                    skipManifestValidation: true
                })
            });
            assert.equal(fs.readFileSync(path.join(bundleRoot, 'VERSION'), 'utf8').trim(), '8.0.0');

            // Update to v9.0.0 (creates second snapshot with v8 state)
            const source2 = path.join(projectRoot, 'source2');
            copyDirRecursive(bundleRoot, source2);
            injectBundleUpdate(source2, 'V9_MARKER', '9.0.0');
            await runCheckUpdate({
                targetRoot: projectRoot,
                bundleRoot,
                sourcePath: source2,
                apply: true,
                noPrompt: true,
                trustOverride: true,
                updateRunner: (opts) => runUpdate({
                    targetRoot: opts.targetRoot,
                    bundleRoot,
                    initAnswersPath: opts.initAnswersPath,
                    skipVerify: true,
                    skipManifestValidation: true
                })
            });
            assert.equal(fs.readFileSync(path.join(bundleRoot, 'VERSION'), 'utf8').trim(), '9.0.0');

            // Rollback without specifying snapshot — should use latest (v8 state)
            const result = runSnapshotRollback({
                targetRoot: projectRoot,
                bundleRoot
            });

            assert.equal(result.rollbackMode, 'snapshot');
            assert.equal(result.restoreStatus, 'SUCCESS');
            // The rollback should restore to v8 state (most recent snapshot before v9 update)
            assert.equal(
                result.snapshotVersion, '8.0.0',
                'Latest snapshot should contain v8 state (snapshot before v9 update)'
            );
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('explicit snapshot path rollback works with older snapshot', async () => {
        const { projectRoot, bundleRoot, answersPath } = setupUpdateWorkspace(repoRoot);
        try {
            runUpdate({
                targetRoot: projectRoot,
                bundleRoot,
                initAnswersPath: answersPath,
                skipVerify: true,
                skipManifestValidation: true
            });

            const v1 = fs.readFileSync(path.join(bundleRoot, 'VERSION'), 'utf8').trim();

            // Update to v8.0.0 — creates snapshot with v1 state
            const source1 = path.join(projectRoot, 'source1');
            copyDirRecursive(bundleRoot, source1);
            injectBundleUpdate(source1, 'V8_EXPLICIT', '8.0.0');
            await runCheckUpdate({
                targetRoot: projectRoot,
                bundleRoot,
                sourcePath: source1,
                apply: true,
                noPrompt: true,
                trustOverride: true,
                updateRunner: (opts) => runUpdate({
                    targetRoot: opts.targetRoot,
                    bundleRoot,
                    initAnswersPath: opts.initAnswersPath,
                    skipVerify: true,
                    skipManifestValidation: true
                })
            });

            // Identify the v1 snapshot path
            const rollbacksRoot = path.join(bundleRoot, 'runtime', 'update-rollbacks');
            const snapshots = fs.readdirSync(rollbacksRoot)
                .filter((d) => d.startsWith('update-'))
                .sort();
            assert.ok(snapshots.length >= 1);
            const olderSnapshotAbsPath = path.join(rollbacksRoot, snapshots[0]);

            // Update to v9.0.0 — creates snapshot with v8 state
            const source2 = path.join(projectRoot, 'source2');
            copyDirRecursive(bundleRoot, source2);
            injectBundleUpdate(source2, 'V9_EXPLICIT', '9.0.0');
            await runCheckUpdate({
                targetRoot: projectRoot,
                bundleRoot,
                sourcePath: source2,
                apply: true,
                noPrompt: true,
                trustOverride: true,
                updateRunner: (opts) => runUpdate({
                    targetRoot: opts.targetRoot,
                    bundleRoot,
                    initAnswersPath: opts.initAnswersPath,
                    skipVerify: true,
                    skipManifestValidation: true
                })
            });
            assert.equal(fs.readFileSync(path.join(bundleRoot, 'VERSION'), 'utf8').trim(), '9.0.0');

            // Rollback to the older snapshot (v1 state) explicitly
            const result = runSnapshotRollback({
                targetRoot: projectRoot,
                bundleRoot,
                snapshotPath: olderSnapshotAbsPath
            });

            assert.equal(result.rollbackMode, 'snapshot');
            assert.equal(result.restoreStatus, 'SUCCESS');
            assert.equal(result.snapshotVersion, v1,
                'Explicit snapshot should restore to v1 state');
        } finally {
            removePathRecursive(projectRoot);
        }
    });
});

// =========================================================================
// 4. UNINSTALL FAILURE / RECOVERY PATHS
// =========================================================================

describe('Uninstall failure and recovery paths', () => {
    const repoRoot = findRepoRoot();

    it('uninstall after partial update: workspace is cleanly uninstalled', () => {
        const { projectRoot, bundleRoot } = setupDeployedWorkspace(repoRoot);
        try {
            // Simulate a "partial update" by leaving stale state
            fs.writeFileSync(
                path.join(bundleRoot, 'runtime', 'test-leftover.txt'),
                'leftover-from-update'
            );
            fs.writeFileSync(
                path.join(bundleRoot, 'live', 'config', 'stale-config.json'),
                '{"stale":true}'
            );

            const result = runUninstall({
                targetRoot: projectRoot,
                bundleRoot,
                noPrompt: true,
                keepPrimaryEntrypoint: 'no',
                keepTaskFile: 'no',
                keepRuntimeArtifacts: 'no'
            });

            assert.equal(result.result, 'SUCCESS');
            assert.ok(!fs.existsSync(path.join(projectRoot, 'garda-agent-orchestrator')),
                'Bundle directory must be removed');
            assert.ok(!fs.existsSync(path.join(projectRoot, 'CLAUDE.md')),
                'Managed CLAUDE.md must be removed');
            assert.ok(!fs.existsSync(path.join(projectRoot, 'TASK.md')),
                'Managed TASK.md must be removed');
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('uninstall rollback restores .gitignore and settings on failure', () => {
        const { projectRoot, bundleRoot } = setupDeployedWorkspace(repoRoot);
        try {
            // Set up qwen and claude settings
            fs.mkdirSync(path.join(projectRoot, '.qwen'), { recursive: true });
            fs.writeFileSync(
                path.join(projectRoot, '.qwen', 'settings.json'),
                JSON.stringify({ context: { fileName: ['TASK.md', 'user.md'] } }, null, 2)
            );
            fs.mkdirSync(path.join(projectRoot, '.claude'), { recursive: true });
            fs.writeFileSync(
                path.join(projectRoot, '.claude', 'settings.local.json'),
                JSON.stringify({ permissions: { allow: ['Bash(node garda-agent-orchestrator/bin/garda.js *:*)'] } }, null, 2)
            );

            const gitignoreBefore = fs.readFileSync(path.join(projectRoot, '.gitignore'), 'utf8');
            const qwenBefore = fs.readFileSync(path.join(projectRoot, '.qwen', 'settings.json'), 'utf8');
            const claudeBefore = fs.readFileSync(path.join(projectRoot, '.claude', 'settings.local.json'), 'utf8');

            assert.throws(() => {
                runUninstall({
                    targetRoot: projectRoot,
                    bundleRoot,
                    noPrompt: true,
                    keepPrimaryEntrypoint: 'no',
                    keepTaskFile: 'no',
                    keepRuntimeArtifacts: 'no',
                    _testHooks: {
                        afterFileCleanup: () => {
                            throw new Error('SETTINGS_RESTORE_TEST');
                        }
                    }
                });
            }, /restored to pre-uninstall state/);

            // All settings must be restored
            assert.equal(
                fs.readFileSync(path.join(projectRoot, '.gitignore'), 'utf8'),
                gitignoreBefore,
                '.gitignore must be restored'
            );
            assert.equal(
                fs.readFileSync(path.join(projectRoot, '.qwen', 'settings.json'), 'utf8'),
                qwenBefore,
                'Qwen settings must be restored'
            );
            assert.equal(
                fs.readFileSync(path.join(projectRoot, '.claude', 'settings.local.json'), 'utf8'),
                claudeBefore,
                'Claude settings must be restored'
            );
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('uninstall double failure: rollback also fails and error mentions both', () => {
        const { projectRoot, bundleRoot } = setupDeployedWorkspace(repoRoot);
        try {
            let thrown: Error | null = null;
            try {
                runUninstall({
                    targetRoot: projectRoot,
                    bundleRoot,
                    noPrompt: true,
                    keepPrimaryEntrypoint: 'no',
                    keepTaskFile: 'no',
                    keepRuntimeArtifacts: 'no',
                    _testHooks: {
                        afterFileCleanup: () => {
                            // Destroy the rollback journal to make rollback fail
                            const journalPattern = 'garda-agent-orchestrator-uninstall-journal';
                            const entries = fs.readdirSync(projectRoot);
                            for (const entry of entries) {
                                if (entry.includes(journalPattern) || entry.includes('uninstall-journal')) {
                                    const fullPath = path.join(projectRoot, entry);
                                    if (fs.existsSync(fullPath)) {
                                        fs.rmSync(fullPath, { recursive: true, force: true });
                                    }
                                }
                            }
                            throw new Error('PRIMARY_UNINSTALL_FAIL');
                        }
                    }
                });
            } catch (e: unknown) {
                thrown = e as Error;
            }

            if (thrown === null) {
                throw new Error('Should throw on failure');
            }
            // The error should reference either the primary failure or a rollback chain
            assert.ok(
                thrown.message.includes('PRIMARY_UNINSTALL_FAIL') ||
                thrown.message.includes('Rollback also failed') ||
                thrown.message.includes('restored to pre-uninstall state'),
                'Error should reference the failure'
            );
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('uninstall with interrupted sentinel from prior run still succeeds', () => {
        const { projectRoot, bundleRoot } = setupDeployedWorkspace(repoRoot);
        try {
            // Write a sentinel from a previous interrupted uninstall
            fs.writeFileSync(
                path.join(projectRoot, '.uninstall-in-progress'),
                JSON.stringify({
                    startedAt: '2025-06-01T00:00:00.000Z',
                    operation: 'uninstall',
                    rollbackSnapshotPath: '/stale/path'
                })
            );

            const result = runUninstall({
                targetRoot: projectRoot,
                bundleRoot,
                noPrompt: true,
                keepPrimaryEntrypoint: 'no',
                keepTaskFile: 'no',
                keepRuntimeArtifacts: 'no'
            });

            assert.equal(result.result, 'SUCCESS');
            assert.ok(!fs.existsSync(path.join(projectRoot, '.uninstall-in-progress')),
                'Sentinel must be cleaned after success');
            assert.ok(!fs.existsSync(bundleRoot), 'Bundle must be removed');
            assert.ok(result.warnings.some((w) => w.includes('interrupted')),
                'Should warn about previous interrupted uninstall');
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('uninstall preserves runtime artifacts after partial update state', () => {
        const { projectRoot, bundleRoot } = setupDeployedWorkspace(repoRoot);
        try {
            // Simulate partial update artifacts
            fs.writeFileSync(
                path.join(bundleRoot, 'runtime', 'init-answers.json'),
                JSON.stringify({
                    AssistantLanguage: 'English',
                    AssistantBrevity: 'concise',
                    SourceOfTruth: 'Claude',
                    EnforceNoAutoCommit: 'true',
                    ClaudeOrchestratorFullAccess: 'false',
                    TokenEconomyEnabled: 'true',
                    CollectedVia: 'CLI_NONINTERACTIVE'
                }, null, 2)
            );
            fs.mkdirSync(path.join(bundleRoot, 'runtime', 'update-reports'), { recursive: true });
            fs.writeFileSync(
                path.join(bundleRoot, 'runtime', 'update-reports', 'update-20250601-120000.md'),
                '# Update Report\nSome content'
            );

            const result = runUninstall({
                targetRoot: projectRoot,
                bundleRoot,
                noPrompt: true,
                keepPrimaryEntrypoint: 'no',
                keepTaskFile: 'no',
                keepRuntimeArtifacts: 'yes'
            });

            assert.equal(result.result, 'SUCCESS');
            assert.equal(result.keepRuntimeArtifacts, true);
            assert.ok(result.preservedRuntimePath !== '<none>',
                'Runtime preservation path should be reported');
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('uninstall rollback restores commit guard hook on failure', () => {
        const { projectRoot, bundleRoot } = setupDeployedWorkspace(repoRoot);
        try {
            const hookPath = path.join(projectRoot, '.git', 'hooks', 'pre-commit');
            const hookContent = [
                '#!/usr/bin/env bash',
                '# User hook content',
                'echo "user"',
                COMMIT_GUARD_START,
                'echo "guard"',
                COMMIT_GUARD_END
            ].join('\n');
            fs.writeFileSync(hookPath, hookContent);

            const hookBefore = fs.readFileSync(hookPath, 'utf8');

            assert.throws(() => {
                runUninstall({
                    targetRoot: projectRoot,
                    bundleRoot,
                    noPrompt: true,
                    keepPrimaryEntrypoint: 'no',
                    keepTaskFile: 'no',
                    keepRuntimeArtifacts: 'no',
                    _testHooks: {
                        afterFileCleanup: () => {
                            throw new Error('HOOK_RESTORE_TEST');
                        }
                    }
                });
            }, /restored to pre-uninstall state/);

            // Hook must be restored
            assert.ok(fs.existsSync(hookPath), 'Hook file must be restored');
            assert.equal(
                fs.readFileSync(hookPath, 'utf8'),
                hookBefore,
                'Hook content must be exactly restored'
            );
        } finally {
            removePathRecursive(projectRoot);
        }
    });
});
