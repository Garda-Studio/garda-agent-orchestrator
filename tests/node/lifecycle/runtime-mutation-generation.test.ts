import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { readRuntimeMutationGeneration } from '../../../src/gate-runtime/runtime-mutation-generation';
import {
    CANONICAL_RUNTIME_MUTATION_SUBTREES,
    withLifecycleRuntimeMutationGenerationForPath
} from '../../../src/lifecycle/runtime-mutation-generation';
import {
    createRollbackSnapshot,
    writeRollbackRecords,
    writeSyncBackupMetadata
} from '../../../src/lifecycle/lifecycle-common';
import { createInstallFilesystemStage } from '../../../src/materialization/install/install-filesystem-stage';
import { createBackupSnapshot, pruneBackups } from '../../../src/lifecycle/backups';
import {
    runCleanup,
    runGc,
    runTaskRuntimeBatchPurge,
    runTaskRuntimePurge
} from '../../../src/lifecycle/cleanup';
import { runRollbackToVersion, runSnapshotRollback } from '../../../src/lifecycle/rollback';
import { applyAvailableUpdate } from '../../../src/lifecycle/check-update/check-update-bundle-sync';
import type {
    AcquiredUpdateSource,
    CheckUpdateResult
} from '../../../src/lifecycle/check-update/check-update-types';
import {
    writeUpdateReport,
    type UpdateReportData
} from '../../../src/lifecycle/update/update-reporting';

interface WriterCoverageEdge {
    candidatePath: string;
    ownerPath: string;
    edgeSourcePath: string;
    edgeMarker: string;
}

interface NonCanonicalMutationCapability {
    sourceMarker: string;
    boundary: string;
}

const WRITER_COVERAGE_EDGES = Object.freeze({
    reviewWrite: {
        candidatePath: 'src/gate-runtime/review/review-artifacts.ts',
        ownerPath: 'src/gate-runtime/review/review-artifacts.ts',
        edgeSourcePath: 'src/gate-runtime/review/review-artifacts.ts',
        edgeMarker: 'beginRuntimeMutationGeneration('
    },
    taskEventWrite: {
        candidatePath: 'src/gate-runtime/timeline/task-events-io.ts',
        ownerPath: 'src/gate-runtime/timeline/task-events-io.ts',
        edgeSourcePath: 'src/gate-runtime/timeline/task-events-io.ts',
        edgeMarker: 'beginRuntimeMutationGeneration('
    },
    updateApply: {
        candidatePath: 'src/lifecycle/check-update/check-update-bundle-sync.ts',
        ownerPath: 'src/lifecycle/check-update/check-update-bundle-sync.ts',
        edgeSourcePath: 'src/lifecycle/check-update/check-update-bundle-sync.ts',
        edgeMarker: 'withLifecycleRuntimeMutationGenerationAsync('
    },
    updateApplyDelegation: {
        candidatePath: 'src/lifecycle/check-update/check-update-runner.ts',
        ownerPath: 'src/lifecycle/check-update/check-update-bundle-sync.ts',
        edgeSourcePath: 'src/lifecycle/check-update/check-update-runner.ts',
        edgeMarker: 'applyAvailableUpdate('
    },
    cleanupDirect: {
        candidatePath: 'src/lifecycle/cleanup/cleanup-orchestration.ts',
        ownerPath: 'src/lifecycle/cleanup/cleanup-orchestration.ts',
        edgeSourcePath: 'src/lifecycle/cleanup/cleanup-orchestration.ts',
        edgeMarker: 'withLifecycleRuntimeMutationGeneration('
    },
    cleanupRemoval: {
        candidatePath: 'src/lifecycle/cleanup/cleanup-removal.ts',
        ownerPath: 'src/lifecycle/cleanup/cleanup-orchestration.ts',
        edgeSourcePath: 'src/lifecycle/cleanup/cleanup-orchestration.ts',
        edgeMarker: 'processCleanupCandidates('
    },
    cleanupStorage: {
        candidatePath: 'src/lifecycle/cleanup/cleanup-storage-policy.ts',
        ownerPath: 'src/lifecycle/cleanup/cleanup-orchestration.ts',
        edgeSourcePath: 'src/lifecycle/cleanup/cleanup-orchestration.ts',
        edgeMarker: 'applyStoragePolicy('
    },
    commonWrite: {
        candidatePath: 'src/lifecycle/lifecycle-common.ts',
        ownerPath: 'src/lifecycle/lifecycle-common.ts',
        edgeSourcePath: 'src/lifecycle/lifecycle-common.ts',
        edgeMarker: 'withLifecycleRuntimeMutationGenerationForPath('
    },
    rollbackWrite: {
        candidatePath: 'src/lifecycle/rollback/rollback.ts',
        ownerPath: 'src/lifecycle/rollback/rollback.ts',
        edgeSourcePath: 'src/lifecycle/rollback/rollback.ts',
        edgeMarker: 'withLifecycleRuntimeMutationGeneration('
    },
    backupWrite: {
        candidatePath: 'src/lifecycle/runtime-policy/backups.ts',
        ownerPath: 'src/lifecycle/runtime-policy/backups.ts',
        edgeSourcePath: 'src/lifecycle/runtime-policy/backups.ts',
        edgeMarker: 'withLifecycleRuntimeMutationGenerationForPath('
    },
    dailyRetentionGc: {
        candidatePath: 'src/lifecycle/runtime-policy/daily-retention-maintenance.ts',
        ownerPath: 'src/lifecycle/cleanup/cleanup-orchestration.ts',
        edgeSourcePath: 'src/lifecycle/runtime-policy/daily-retention-maintenance.ts',
        edgeMarker: 'runGc('
    },
    scheduledBackup: {
        candidatePath: 'src/lifecycle/runtime-policy/scheduled-backups.ts',
        ownerPath: 'src/lifecycle/runtime-policy/backups.ts',
        edgeSourcePath: 'src/lifecycle/runtime-policy/scheduled-backups.ts',
        edgeMarker: 'createBackupSnapshot('
    },
    updateReportWrite: {
        candidatePath: 'src/lifecycle/update/update-reporting.ts',
        ownerPath: 'src/lifecycle/update/update-reporting.ts',
        edgeSourcePath: 'src/lifecycle/update/update-reporting.ts',
        edgeMarker: 'withLifecycleRuntimeMutationGenerationForPath('
    },
    updateRollbackDelegation: {
        candidatePath: 'src/lifecycle/update/update.ts',
        ownerPath: 'src/lifecycle/lifecycle-common.ts',
        edgeSourcePath: 'src/lifecycle/update/update.ts',
        edgeMarker: 'createRollbackSnapshot('
    },
    updateReportDelegation: {
        candidatePath: 'src/lifecycle/update/update.ts',
        ownerPath: 'src/lifecycle/update/update-reporting.ts',
        edgeSourcePath: 'src/lifecycle/update/update.ts',
        edgeMarker: 'writeUpdateReport('
    },
    installDelegation: {
        candidatePath: 'src/materialization/install.ts',
        ownerPath: 'src/materialization/install/install-filesystem-stage.ts',
        edgeSourcePath: 'src/materialization/install.ts',
        edgeMarker: 'createInstallFilesystemStage('
    },
    installBackupWrite: {
        candidatePath: 'src/materialization/install/install-filesystem-stage.ts',
        ownerPath: 'src/materialization/install/install-filesystem-stage.ts',
        edgeSourcePath: 'src/materialization/install/install-filesystem-stage.ts',
        edgeMarker: 'withLifecycleRuntimeMutationGenerationForPath('
    }
} satisfies Record<string, WriterCoverageEdge>);

const NON_CANONICAL_MUTATION_CAPABILITIES = Object.freeze({
    'src/lifecycle/agent-init.ts': {
        sourceMarker: 'writeJsonFile(',
        boundary: 'agent-init configuration artifacts outside the six toxin roots'
    },
    'src/lifecycle/agent-init/contract-migrations.ts': {
        sourceMarker: 'runContractMigrations(',
        boundary: 'live contract migration targets outside the six toxin roots'
    },
    'src/lifecycle/check-update/check-update-source.ts': {
        sourceMarker: 'mkdtempSync(',
        boundary: 'temporary acquired update source outside the six toxin roots'
    },
    'src/lifecycle/generic-utils.ts': {
        sourceMarker: 'copyPathRecursive(',
        boundary: 'generic filesystem primitive whose canonical callers are classified separately'
    },
    'src/lifecycle/lock/lifecycle-lock.ts': {
        sourceMarker: 'acquireLifecycleOperationLock(',
        boundary: 'ephemeral lifecycle lock state outside the six toxin roots'
    },
    'src/lifecycle/uninstall/uninstall-helpers.ts': {
        sourceMarker: 'rmdirSync(',
        boundary: 'project-tree uninstall cleanup outside the six toxin roots'
    },
    'src/lifecycle/uninstall/uninstall-runner.ts': {
        sourceMarker: 'runUninstall(',
        boundary: 'project-tree uninstall and recovery artifacts outside the six toxin roots'
    },
    'src/lifecycle/update/update-announcements.ts': {
        sourceMarker: 'compareVersionStrings(',
        boundary: 'read-only transitive dependency on a generic mutation-capable module'
    },
    'src/lifecycle/update/update-execution.ts': {
        sourceMarker: 'readPreservableCompileGateCommandFromFile(',
        boundary: 'read-only transitive dependency plus project-tree update stages outside the six toxin roots'
    },
    'src/lifecycle/update/update-git.ts': {
        sourceMarker: 'mkdtempSync(',
        boundary: 'temporary Git acquisition workspace outside the six toxin roots'
    }
} satisfies Record<string, NonCanonicalMutationCapability>);

const ROOT_WRITER_COVERAGE = Object.freeze({
    reviews: [
        'reviewWrite', 'cleanupDirect', 'cleanupRemoval', 'cleanupStorage', 'dailyRetentionGc'
    ],
    'task-events': [
        'taskEventWrite', 'cleanupDirect', 'cleanupRemoval', 'cleanupStorage', 'dailyRetentionGc'
    ],
    backups: [
        'backupWrite', 'scheduledBackup', 'installDelegation', 'installBackupWrite',
        'cleanupDirect', 'cleanupRemoval', 'cleanupStorage', 'dailyRetentionGc'
    ],
    'bundle-backups': [
        'updateApply', 'commonWrite', 'cleanupDirect', 'cleanupRemoval', 'cleanupStorage', 'dailyRetentionGc'
    ],
    'update-reports': [
        'updateReportWrite', 'updateReportDelegation', 'rollbackWrite',
        'cleanupDirect', 'cleanupRemoval', 'cleanupStorage', 'dailyRetentionGc'
    ],
    'update-rollbacks': [
        'commonWrite', 'updateRollbackDelegation', 'rollbackWrite', 'backupWrite',
        'cleanupDirect', 'cleanupRemoval', 'cleanupStorage', 'dailyRetentionGc'
    ]
} as const);

const JOURNAL_OWNER_PATTERN = /(?:withLifecycleRuntimeMutationGeneration(?:ForPath)?|beginRuntimeMutationGeneration)/u;
const BOUNDED_MUTATION_SURFACE_SHA256 = 'e5dd077d80f63c32346b6280ac973c790d554d6f3ea7c4871b45a0922073c6a9';
const READ_ONLY_FS_OPERATIONS = new Set([
    'access', 'accessSync', 'close', 'closeSync', 'exists', 'existsSync',
    'fstat', 'fstatSync', 'lstat', 'lstatSync', 'open', 'opendir', 'opendirSync',
    'read', 'readFile', 'readFileSync', 'readdir', 'readdirSync', 'readlink',
    'readlinkSync', 'readSync', 'realpath', 'realpathSync', 'stat', 'statSync'
]);

function createTempRoot(prefix: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function assertRuntimeGenerationJournalAbsent(root: string): void {
    assert.equal(fs.existsSync(path.join(root, 'runtime', '.runtime-mutation-generation')), false);
    assert.equal(fs.existsSync(path.join(root, 'runtime', '.runtime-mutation-generation.anchor.json')), false);
}

function resolveLifecycleGenerationModulePath(): string {
    return path.resolve(__dirname, '../../../src/lifecycle/runtime-mutation-generation.js');
}

function runLifecycleWriterWorker(modulePath: string, targetPath: string, startSignalPath: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        const script = [
            "const fs = require('node:fs');",
            "const path = require('node:path');",
            "const { withLifecycleRuntimeMutationGenerationForPath } = require(process.argv[1]);",
            'const targetPath = process.argv[2];',
            'const startSignalPath = process.argv[3];',
            'const sleeper = new Int32Array(new SharedArrayBuffer(4));',
            'while (!fs.existsSync(startSignalPath)) { Atomics.wait(sleeper, 0, 0, 2); }',
            "withLifecycleRuntimeMutationGenerationForPath(targetPath, 'lifecycle-contention-test', () => {",
            '  fs.mkdirSync(path.dirname(targetPath), { recursive: true });',
            "  fs.writeFileSync(targetPath, 'written\\n', 'utf8');",
            '});'
        ].join('\n');
        const child = spawn(process.execPath, [
            '--input-type=commonjs',
            '--eval',
            script,
            modulePath,
            targetPath,
            startSignalPath
        ], { stdio: ['ignore', 'ignore', 'pipe'] });
        let stderr = '';
        child.stderr.on('data', (chunk) => {
            stderr += String(chunk);
        });
        child.once('error', reject);
        child.once('close', (code) => {
            if (code === 0) {
                resolve();
                return;
            }
            reject(new Error(stderr || `Lifecycle writer worker exited with code ${code}`));
        });
    });
}

function resolveBoundedMutationSurfaceRoots(repoRoot: string): string[] {
    return [
        path.join(repoRoot, 'src', 'gate-runtime', 'review', 'review-artifacts.ts'),
        path.join(repoRoot, 'src', 'gate-runtime', 'timeline', 'task-events-io.ts'),
        path.join(repoRoot, 'src', 'lifecycle'),
        path.join(repoRoot, 'src', 'materialization', 'install'),
        path.join(repoRoot, 'src', 'materialization', 'install.ts')
    ];
}

function listBoundedMutationSurfaceFiles(repoRoot: string): string[] {
    const sourcePaths: string[] = [];
    const visit = (candidatePath: string): void => {
        const stat = fs.statSync(candidatePath);
        if (stat.isDirectory()) {
            for (const entry of fs.readdirSync(candidatePath)) {
                visit(path.join(candidatePath, entry));
            }
            return;
        }
        if (candidatePath.endsWith('.ts')) {
            sourcePaths.push(path.relative(repoRoot, candidatePath).replace(/\\/gu, '/'));
        }
    };
    for (const root of resolveBoundedMutationSurfaceRoots(repoRoot)) {
        visit(root);
    }
    return [...new Set(sourcePaths)].sort();
}

function computeBoundedMutationSurfaceSha256(repoRoot: string): string {
    const hash = createHash('sha256');
    for (const sourcePath of listBoundedMutationSurfaceFiles(repoRoot)) {
        hash.update(sourcePath);
        hash.update('\0');
        hash.update(fs.readFileSync(path.join(repoRoot, sourcePath)));
        hash.update('\0');
    }
    return hash.digest('hex');
}

function escapeRegularExpression(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function resolveBoundedImportTarget(
    sourcePath: string,
    importSpecifier: string,
    boundedPaths: ReadonlySet<string>
): string | null {
    const unresolvedPath = path.resolve(path.dirname(sourcePath), importSpecifier);
    for (const candidatePath of [`${unresolvedPath}.ts`, path.join(unresolvedPath, 'index.ts')]) {
        if (boundedPaths.has(candidatePath)) {
            return candidatePath;
        }
    }
    return null;
}

function sourceCallsImportedBinding(source: string, localName: string): boolean {
    return new RegExp(`\\b${escapeRegularExpression(localName)}\\s*\\(`, 'u').test(source);
}

function discoverMutationCapableFiles(repoRoot: string): string[] {
    const relativePaths = listBoundedMutationSurfaceFiles(repoRoot);
    const absolutePaths = relativePaths.map((relativePath) => path.resolve(repoRoot, relativePath));
    const boundedPaths = new Set(absolutePaths);
    const sources = new Map(absolutePaths.map((sourcePath) => [
        sourcePath,
        fs.readFileSync(sourcePath, 'utf8')
    ]));
    const mutationCapablePaths = new Set<string>();

    for (const [sourcePath, source] of sources) {
        const namespaceCalls = source.matchAll(/\bfs(?:\.promises)?\.([A-Za-z_$][\w$]*)\s*\(/gu);
        if ([...namespaceCalls].some((match) => !READ_ONLY_FS_OPERATIONS.has(match[1]))) {
            mutationCapablePaths.add(sourcePath);
            continue;
        }
        const namedImports = source.matchAll(/import\s*\{([\s\S]*?)\}\s*from\s*['"]node:fs['"]/gu);
        for (const match of namedImports) {
            const importsMutation = match[1].split(',').some((entry) => {
                const importedName = entry.trim().replace(/^type\s+/u, '').split(/\s+as\s+/u)[0];
                return importedName.length > 0 && !READ_ONLY_FS_OPERATIONS.has(importedName);
            });
            if (importsMutation) {
                mutationCapablePaths.add(sourcePath);
                break;
            }
        }
    }

    let changed = true;
    while (changed) {
        changed = false;
        for (const [sourcePath, source] of sources) {
            if (mutationCapablePaths.has(sourcePath)) continue;
            const relativeImports = source.matchAll(
                /import\s*\{([\s\S]*?)\}\s*from\s*['"](\.[^'"]+)['"]/gu
            );
            for (const match of relativeImports) {
                const targetPath = resolveBoundedImportTarget(sourcePath, match[2], boundedPaths);
                if (!targetPath || !mutationCapablePaths.has(targetPath)) continue;
                const callsMutationCapableImport = match[1].split(',').some((entry) => {
                    const importedBinding = entry.trim().replace(/^type\s+/u, '').split(/\s+as\s+/u);
                    const localName = (importedBinding[1] || importedBinding[0] || '').trim();
                    return localName.length > 0 && sourceCallsImportedBinding(source, localName);
                });
                if (callsMutationCapableImport) {
                    mutationCapablePaths.add(sourcePath);
                    changed = true;
                    break;
                }
            }
        }
    }

    return [...mutationCapablePaths]
        .map((sourcePath) => path.relative(repoRoot, sourcePath).replace(/\\/gu, '/'))
        .sort();
}

test('lifecycle runtime mutation wrapper covers every toxin subtree and rejects injected partial-write failure without stale BUSY state', () => {
    const orchestratorRoot = createTempRoot('garda-lifecycle-generation-roots-');
    try {
        for (const [index, subtree] of CANONICAL_RUNTIME_MUTATION_SUBTREES.entries()) {
            const targetPath = path.join(orchestratorRoot, 'runtime', subtree, `${index}.txt`);
            withLifecycleRuntimeMutationGenerationForPath(targetPath, `write-${subtree}`, () => {
                fs.mkdirSync(path.dirname(targetPath), { recursive: true });
                fs.writeFileSync(targetPath, `${subtree}\n`, 'utf8');
            });
            assert.equal(readRuntimeMutationGeneration(orchestratorRoot).generation, index + 1);
        }

        const partialPath = path.join(orchestratorRoot, 'runtime', 'update-reports', 'partial.md');
        assert.throws(
            () => withLifecycleRuntimeMutationGenerationForPath(partialPath, 'partial-update-report', () => {
                fs.writeFileSync(partialPath, 'partial\n', 'utf8');
                throw new Error('injected lifecycle failure');
            }),
            /injected lifecycle failure/u
        );
        assert.equal(
            readRuntimeMutationGeneration(orchestratorRoot).generation,
            CANONICAL_RUNTIME_MUTATION_SUBTREES.length + 1
        );
    } finally {
        fs.rmSync(orchestratorRoot, { recursive: true, force: true });
    }
});

test('central lifecycle backup writers publish generation updates', () => {
    const targetRoot = createTempRoot('garda-lifecycle-generation-writers-');
    const orchestratorRoot = path.join(targetRoot, 'garda-agent-orchestrator');
    try {
        const sourcePath = path.join(targetRoot, 'AGENTS.md');
        fs.mkdirSync(orchestratorRoot, { recursive: true });
        fs.writeFileSync(sourcePath, 'source\n', 'utf8');

        const installBackupRoot = path.join(orchestratorRoot, 'runtime', 'backups', '20260802-120000');
        const stage = createInstallFilesystemStage({
            targetRoot,
            backupRoot: installBackupRoot,
            dryRun: false,
            skipBackups: false,
            deploymentDate: '2026-08-02',
            canonicalEntryFile: 'AGENTS.md'
        });
        stage.backupFile(sourcePath, 'AGENTS.md');
        const afterInstallBackup = readRuntimeMutationGeneration(orchestratorRoot).generation;
        assert.ok(afterInstallBackup >= 1);

        const rollbackRoot = path.join(orchestratorRoot, 'runtime', 'update-rollbacks', 'update-20260802-120001');
        const records = createRollbackSnapshot(targetRoot, rollbackRoot, ['AGENTS.md']);
        writeRollbackRecords(rollbackRoot, records);
        const afterRollbackSnapshot = readRuntimeMutationGeneration(orchestratorRoot).generation;
        assert.ok(afterRollbackSnapshot > afterInstallBackup);

        const bundleBackupRoot = path.join(orchestratorRoot, 'runtime', 'bundle-backups', '20260802-120002');
        writeSyncBackupMetadata(bundleBackupRoot, { preexistingMap: { VERSION: true } });
        assert.ok(readRuntimeMutationGeneration(orchestratorRoot).generation > afterRollbackSnapshot);
    } finally {
        fs.rmSync(targetRoot, { recursive: true, force: true });
    }
});

test('update apply and report writers publish generation after real writes', async () => {
    const targetRoot = createTempRoot('garda-lifecycle-generation-update-writers-');
    const bundleRoot = path.join(targetRoot, 'garda-agent-orchestrator');
    const sourceRoot = path.join(targetRoot, 'update-source');
    try {
        fs.mkdirSync(path.join(bundleRoot, 'runtime'), { recursive: true });
        fs.mkdirSync(sourceRoot, { recursive: true });
        fs.writeFileSync(path.join(bundleRoot, 'VERSION'), '1.0.0\n', 'utf8');
        fs.writeFileSync(path.join(sourceRoot, 'VERSION'), '2.0.0\n', 'utf8');

        const source: AcquiredUpdateSource = {
            sourceType: 'path',
            sourceReference: sourceRoot,
            diagnosticSourceReference: sourceRoot,
            packageSpec: null,
            requestedPackageSpec: null,
            exactPackageSpec: null,
            resolvedPackageVersion: null,
            resolvedPackageIntegrity: null,
            releaseProvenanceStatus: null,
            releaseProvenanceSummary: null,
            releaseProvenanceRecommendation: null,
            packageName: null,
            sourceRoot,
            trustPolicy: 'test-path',
            trustOverrideUsed: false,
            trustOverrideSource: 'none',
            diagnosticTool: 'path',
            cleanup: () => undefined
        };
        const result: CheckUpdateResult = {
            targetRoot,
            sourceType: 'path',
            sourceReference: sourceRoot,
            packageSpec: null,
            requestedPackageSpec: null,
            exactPackageSpec: null,
            resolvedPackageVersion: null,
            resolvedPackageIntegrity: null,
            releaseProvenanceStatus: null,
            releaseProvenanceSummary: null,
            releaseProvenanceRecommendation: null,
            sourcePath: sourceRoot,
            packageName: null,
            currentVersion: '1.0.0',
            latestVersion: null,
            updateAvailable: false,
            versionDiffDetected: false,
            contentDriftDetected: false,
            driftedSyncItems: [],
            applyRequested: true,
            noPrompt: true,
            dryRun: false,
            trustPolicy: 'test-path',
            trustOverrideUsed: false,
            trustOverrideSource: 'none',
            syncItemsDetected: 0,
            syncItemsBackedUp: 0,
            syncItemsUpdated: 0,
            syncBackupRoot: '',
            syncBackupMetadataPath: '',
            syncRollbackStatus: 'NOT_NEEDED',
            syncedItems: [],
            updateApplied: false,
            checkUpdateResult: 'NOT_RUN'
        };

        await applyAvailableUpdate({
            normalizedTarget: targetRoot,
            deployedBundleRoot: bundleRoot,
            source,
            result,
            initAnswersPath: path.join(bundleRoot, 'runtime', 'init-answers.json'),
            noPrompt: true,
            dryRun: false,
            skipVerify: true,
            skipManifestValidation: true,
            runningScriptPath: null,
            updateRunner: null,
            testHooks: null,
            effectiveDiagnosticSource: sourceRoot,
            effectiveDiagnosticTool: 'path',
            syncBackupRoot: path.join(bundleRoot, 'runtime', 'bundle-backups', 'generation-test')
        });

        assert.equal(result.updateApplied, true);
        assert.equal(fs.readFileSync(path.join(bundleRoot, 'VERSION'), 'utf8'), '2.0.0\n');
        const afterUpdateApply = readRuntimeMutationGeneration(bundleRoot).generation;
        assert.ok(afterUpdateApply > 0);

        const reportPath = path.join(bundleRoot, 'runtime', 'update-reports', 'generation-test.md');
        const reportData: UpdateReportData = {
            normalizedTarget: targetRoot,
            initAnswersResolvedPath: path.join(bundleRoot, 'runtime', 'init-answers.json'),
            rollbackSnapshotRelativePath: 'runtime/update-rollbacks/generation-test',
            rollbackRecordsRelativePath: 'runtime/update-rollbacks/generation-test/records.json',
            rollbackRecordCount: 0,
            rollbackStatus: 'NOT_TRIGGERED',
            trustContext: {
                policy: 'test-path',
                overrideUsed: false,
                overrideSource: 'none',
                sourceType: 'path',
                sourceReference: sourceRoot,
                gitCommitSha: null,
                requestedPackageSpec: null,
                exactPackageSpec: null,
                resolvedPackageVersion: null,
                resolvedPackageIntegrity: null,
                releaseProvenanceStatus: null,
                releaseProvenanceSummary: null,
                releaseProvenanceRecommendation: null
            },
            previousVersion: '1.0.0',
            previousVersionSource: 'VERSION',
            bundleVersion: '2.0.0',
            stageResult: {
                installStatus: 'PASS',
                materializationStatus: 'PASS',
                workflowConfigMergeStatus: null,
                contractMigrationStatus: 'SKIPPED',
                contractMigrationCount: 0,
                contractMigrationFiles: [],
                verifyStatus: 'PASS',
                manifestStatus: 'PASS',
                invariantStatus: 'PASS',
                updatedVersion: '2.0.0',
                rollbackStatus: 'NOT_TRIGGERED'
            }
        };
        writeUpdateReport(reportPath, reportData);

        assert.match(fs.readFileSync(reportPath, 'utf8'), /# Update Report/u);
        assert.ok(readRuntimeMutationGeneration(bundleRoot).generation > afterUpdateApply);
    } finally {
        fs.rmSync(targetRoot, { recursive: true, force: true });
    }
});

test('dry-run install backups preserve preview metrics without publishing generation', () => {
    const targetRoot = createTempRoot('garda-lifecycle-generation-install-preview-');
    const orchestratorRoot = path.join(targetRoot, 'garda-agent-orchestrator');
    const sourcePath = path.join(targetRoot, 'AGENTS.md');
    const backupRoot = path.join(orchestratorRoot, 'runtime', 'backups', '20260802-120000');
    try {
        fs.writeFileSync(sourcePath, 'source\n', 'utf8');
        const stage = createInstallFilesystemStage({
            targetRoot,
            backupRoot,
            dryRun: true,
            skipBackups: false,
            deploymentDate: '2026-08-02',
            canonicalEntryFile: 'AGENTS.md'
        });

        stage.backupFile(sourcePath, 'AGENTS.md');

        assert.equal(stage.metrics.backedUp, 1);
        assert.equal(fs.existsSync(path.join(backupRoot, 'AGENTS.md')), false);
        assertRuntimeGenerationJournalAbsent(orchestratorRoot);
    } finally {
        fs.rmSync(targetRoot, { recursive: true, force: true });
    }
});

test('confirmed purge, batch purge, GC, and install manifest mutations advance generation', () => {
    const purgeTargetRoot = createTempRoot('garda-lifecycle-generation-task-purge-');
    try {
        const bundleRoot = path.join(purgeTargetRoot, 'garda-agent-orchestrator');
        const eventPath = path.join(bundleRoot, 'runtime', 'task-events', 'T-9001.jsonl');
        fs.mkdirSync(path.dirname(eventPath), { recursive: true });
        fs.writeFileSync(eventPath, '{}\n', 'utf8');

        const result = runTaskRuntimePurge({
            targetRoot: purgeTargetRoot,
            bundleRoot,
            taskId: 'T-9001',
            confirm: true,
            activeTaskIds: []
        });

        assert.ok(result.removed.length > 0);
        assert.equal(fs.existsSync(eventPath), false);
        assert.ok(readRuntimeMutationGeneration(bundleRoot).generation > 0);
    } finally {
        fs.rmSync(purgeTargetRoot, { recursive: true, force: true });
    }

    const batchTargetRoot = createTempRoot('garda-lifecycle-generation-task-batch-purge-');
    try {
        const bundleRoot = path.join(batchTargetRoot, 'garda-agent-orchestrator');
        const eventPath = path.join(bundleRoot, 'runtime', 'task-events', 'T-9002.jsonl');
        fs.mkdirSync(path.dirname(eventPath), { recursive: true });
        fs.writeFileSync(eventPath, '{}\n', 'utf8');
        const oldTimestamp = new Date('2020-01-01T00:00:00.000Z');
        fs.utimesSync(eventPath, oldTimestamp, oldTimestamp);

        const result = runTaskRuntimeBatchPurge({
            targetRoot: batchTargetRoot,
            bundleRoot,
            confirm: true,
            activeTaskIds: [],
            eligibleOlderThanDays: 1,
            keepLatestTasks: 0,
            now: new Date('2026-08-03T00:00:00.000Z')
        });

        assert.ok(result.selectedTaskIds.includes('T-9002'));
        assert.equal(fs.existsSync(eventPath), false);
        assert.ok(readRuntimeMutationGeneration(bundleRoot).generation > 0);
    } finally {
        fs.rmSync(batchTargetRoot, { recursive: true, force: true });
    }

    const gcTargetRoot = createTempRoot('garda-lifecycle-generation-gc-');
    try {
        const bundleRoot = path.join(gcTargetRoot, 'garda-agent-orchestrator');
        const backupPath = path.join(bundleRoot, 'runtime', 'backups', 'old', 'artifact.txt');
        fs.mkdirSync(path.dirname(backupPath), { recursive: true });
        fs.writeFileSync(backupPath, 'old\n', 'utf8');
        const oldTimestamp = new Date('2020-01-01T00:00:00.000Z');
        fs.utimesSync(path.dirname(backupPath), oldTimestamp, oldTimestamp);

        const result = runGc({
            targetRoot: gcTargetRoot,
            bundleRoot,
            confirm: true,
            activeTaskIds: [],
            categories: ['backups'],
            retentionPolicy: { maxBackups: 0, maxAgeDays: 1 },
            now: new Date('2026-08-03T00:00:00.000Z')
        });

        assert.ok(result.removed.length > 0);
        assert.equal(fs.existsSync(path.dirname(backupPath)), false);
        assert.ok(readRuntimeMutationGeneration(bundleRoot).generation > 0);
    } finally {
        fs.rmSync(gcTargetRoot, { recursive: true, force: true });
    }

    const installTargetRoot = createTempRoot('garda-lifecycle-generation-install-manifest-');
    try {
        const bundleRoot = path.join(installTargetRoot, 'garda-agent-orchestrator');
        const backupRoot = path.join(bundleRoot, 'runtime', 'backups', 'manifest-test');
        fs.writeFileSync(path.join(installTargetRoot, 'TASK.md'), '# task queue\n', 'utf8');
        const stage = createInstallFilesystemStage({
            targetRoot: installTargetRoot,
            backupRoot,
            dryRun: false,
            skipBackups: false,
            deploymentDate: '2026-08-03',
            canonicalEntryFile: 'AGENTS.md'
        });

        stage.writeBackupManifest('20260803-000000');

        assert.equal(fs.existsSync(path.join(backupRoot, '_install-backup.manifest.json')), true);
        assert.ok(readRuntimeMutationGeneration(bundleRoot).generation > 0);
    } finally {
        fs.rmSync(installTargetRoot, { recursive: true, force: true });
    }
});

test('rejected lifecycle roots do not create generation journals', async () => {
    const synchronousOperations = [
        {
            name: 'cleanup',
            invoke: (root: string) => runCleanup({ targetRoot: root, bundleRoot: root })
        },
        {
            name: 'task purge',
            invoke: (root: string) => runTaskRuntimePurge({
                targetRoot: root,
                bundleRoot: root,
                taskId: 'T-INVALID-ROOT',
                confirm: true
            })
        },
        {
            name: 'task batch purge',
            invoke: (root: string) => runTaskRuntimeBatchPurge({
                targetRoot: root,
                bundleRoot: root,
                confirm: true
            })
        },
        {
            name: 'gc',
            invoke: (root: string) => runGc({ targetRoot: root, bundleRoot: root, confirm: true })
        },
        {
            name: 'snapshot rollback',
            invoke: (root: string) => runSnapshotRollback({ targetRoot: root, bundleRoot: root })
        }
    ];
    for (const operation of synchronousOperations) {
        const root = createTempRoot(`garda-lifecycle-generation-invalid-${operation.name.replaceAll(' ', '-')}-`);
        try {
            assert.throws(() => operation.invoke(root), /TargetRoot points to orchestrator bundle directory/u);
            assertRuntimeGenerationJournalAbsent(root);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    }

    const rollbackRoot = createTempRoot('garda-lifecycle-generation-invalid-version-rollback-');
    try {
        await assert.rejects(
            () => runRollbackToVersion({
                targetRoot: rollbackRoot,
                bundleRoot: rollbackRoot,
                targetVersion: '1.0.0'
            }),
            /TargetRoot points to orchestrator bundle directory/u
        );
        assertRuntimeGenerationJournalAbsent(rollbackRoot);
    } finally {
        fs.rmSync(rollbackRoot, { recursive: true, force: true });
    }
});

test('backup creation, retention pruning, and cleanup advance generation', () => {
    const targetRoot = createTempRoot('garda-lifecycle-generation-retention-');
    const bundleRoot = path.join(targetRoot, 'garda-agent-orchestrator');
    try {
        fs.mkdirSync(path.join(bundleRoot, 'runtime'), { recursive: true });
        fs.writeFileSync(path.join(bundleRoot, 'VERSION'), '1.0.0\n', 'utf8');

        createBackupSnapshot({
            targetRoot,
            bundleRoot,
            reason: 'manual',
            timestamp: '20260801-120000-000'
        });
        const afterCreation = readRuntimeMutationGeneration(bundleRoot).generation;
        assert.ok(afterCreation > 0);

        createBackupSnapshot({
            targetRoot,
            bundleRoot,
            reason: 'manual',
            timestamp: '20260802-120000-000'
        });
        const beforePrune = readRuntimeMutationGeneration(bundleRoot).generation;
        const pruneResult = pruneBackups({ targetRoot, bundleRoot, keepLatest: 1 });
        assert.equal(pruneResult.removed.length, 1);
        const afterPrune = readRuntimeMutationGeneration(bundleRoot).generation;
        assert.ok(afterPrune > beforePrune);

        const cleanupResult = runCleanup({
            targetRoot,
            bundleRoot,
            retentionPolicy: { maxBackups: 0, maxAgeDays: 365 }
        });
        assert.equal(cleanupResult.result, 'SUCCESS');
        assert.ok(readRuntimeMutationGeneration(bundleRoot).generation > afterPrune);
    } finally {
        fs.rmSync(targetRoot, { recursive: true, force: true });
    }
});

test('snapshot rollback restore advances generation after canonical files change', () => {
    const targetRoot = createTempRoot('garda-lifecycle-generation-restore-');
    const bundleRoot = path.join(targetRoot, 'garda-agent-orchestrator');
    const snapshotPath = path.join(bundleRoot, 'runtime', 'update-rollbacks', 'update-20260801-120000-000');
    const relativeVersionPath = 'garda-agent-orchestrator/VERSION';
    try {
        fs.mkdirSync(bundleRoot, { recursive: true });
        fs.writeFileSync(path.join(bundleRoot, 'VERSION'), '2.0.0\n', 'utf8');
        fs.mkdirSync(path.join(snapshotPath, 'garda-agent-orchestrator'), { recursive: true });
        fs.writeFileSync(path.join(snapshotPath, relativeVersionPath), '1.0.0\n', 'utf8');
        writeRollbackRecords(snapshotPath, [{
            relativePath: relativeVersionPath,
            existed: true,
            pathType: 'file'
        }]);
        const beforeRollback = readRuntimeMutationGeneration(bundleRoot).generation;

        const result = runSnapshotRollback({ targetRoot, bundleRoot, snapshotPath });
        assert.equal(result.restoreStatus, 'SUCCESS');
        assert.equal(fs.readFileSync(path.join(bundleRoot, 'VERSION'), 'utf8'), '1.0.0\n');
        assert.ok(readRuntimeMutationGeneration(bundleRoot).generation > beforeRollback);
    } finally {
        fs.rmSync(targetRoot, { recursive: true, force: true });
    }
});

test('concurrent lifecycle writers do not lose generation updates', async () => {
    const orchestratorRoot = createTempRoot('garda-lifecycle-generation-contention-');
    const startSignalPath = path.join(orchestratorRoot, 'start.signal');
    try {
        const workers = CANONICAL_RUNTIME_MUTATION_SUBTREES.map((subtree, index) => runLifecycleWriterWorker(
            resolveLifecycleGenerationModulePath(),
            path.join(orchestratorRoot, 'runtime', subtree, `worker-${index}.txt`),
            startSignalPath
        ));
        fs.writeFileSync(startSignalPath, 'start\n', 'utf8');
        await Promise.all(workers);
        assert.equal(readRuntimeMutationGeneration(orchestratorRoot).generation, workers.length);
    } finally {
        fs.rmSync(orchestratorRoot, { recursive: true, force: true });
    }
});

test('bounded lifecycle writer audit seals the complete mutation surface and requires every candidate to name a journal owner', () => {
    const repoRoot = path.resolve(__dirname, '../../../..');
    assert.equal(
        computeBoundedMutationSurfaceSha256(repoRoot),
        BOUNDED_MUTATION_SURFACE_SHA256,
        'any source change in the bounded mutation surface requires an explicit writer-audit review'
    );
    const discovered = discoverMutationCapableFiles(repoRoot);
    const coverageEdges = Object.values(WRITER_COVERAGE_EDGES);
    const coveredPaths = new Set(coverageEdges.map((edge) => edge.candidatePath));
    const nonCanonicalPaths = new Set(Object.keys(NON_CANONICAL_MUTATION_CAPABILITIES));
    assert.deepEqual(
        discovered.filter((candidatePath) => (
            !coveredPaths.has(candidatePath) && !nonCanonicalPaths.has(candidatePath)
        )),
        [],
        'every mutation-capable file must be assigned to a journal owner or an explicit non-toxin boundary'
    );

    for (const [sourcePath, classification] of Object.entries(NON_CANONICAL_MUTATION_CAPABILITIES)) {
        assert.ok(
            discovered.includes(sourcePath),
            `${sourcePath} non-toxin classification must remain attached to mutation-capable code`
        );
        assert.match(classification.boundary, /outside the six toxin roots|classified separately|read-only transitive/u);
        assert.ok(
            fs.readFileSync(path.join(repoRoot, sourcePath), 'utf8').includes(classification.sourceMarker),
            `${sourcePath} must retain its explicit non-toxin boundary marker ${classification.sourceMarker}`
        );
    }

    assert.deepEqual(
        Object.keys(ROOT_WRITER_COVERAGE).sort(),
        [...CANONICAL_RUNTIME_MUTATION_SUBTREES].sort()
    );
    for (const [subtree, edgeIds] of Object.entries(ROOT_WRITER_COVERAGE)) {
        assert.ok(edgeIds.length > 0, `${subtree} must retain at least one known writer edge`);
        for (const edgeId of edgeIds) {
            assert.ok(
                Object.hasOwn(WRITER_COVERAGE_EDGES, edgeId),
                `${subtree} writer edge ${edgeId} must name a concrete journal delegation`
            );
        }
    }

    for (const edge of coverageEdges) {
        const candidateSourcePath = path.join(repoRoot, edge.candidatePath);
        const ownerSourcePath = path.join(repoRoot, edge.ownerPath);
        const edgeSourcePath = path.join(repoRoot, edge.edgeSourcePath);
        assert.ok(fs.existsSync(candidateSourcePath), `${edge.candidatePath} must remain in the writer inventory`);
        assert.ok(fs.existsSync(ownerSourcePath), `${edge.ownerPath} must remain a journal owner`);
        assert.ok(fs.existsSync(edgeSourcePath), `${edge.edgeSourcePath} must retain the delegation edge`);

        const edgeSource = fs.readFileSync(edgeSourcePath, 'utf8');
        assert.ok(
            edgeSource.includes(edge.edgeMarker),
            `${edge.candidatePath} must remain connected to ${edge.ownerPath} by ${edge.edgeMarker}`
        );
        const ownerSource = fs.readFileSync(ownerSourcePath, 'utf8');
        assert.match(
            ownerSource,
            JOURNAL_OWNER_PATTERN,
            `${edge.candidatePath} must remain covered by journal owner ${edge.ownerPath}`
        );
    }
});
