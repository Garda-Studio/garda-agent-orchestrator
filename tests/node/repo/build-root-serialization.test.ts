import test from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';

import {
    buildNodeFoundationInputFingerprint,
    buildPublishRuntimeInputFingerprint,
    buildPublishRuntime,
    checkReusableBuildRoot,
    getRepoRoot,
    printReuseDiagnostic,
    runTsc,
    type BuildInputFingerprint
} from '../../../scripts/node-foundation/build';
import { removeTempRepoWithRetry } from '../cli/commands/gate-test-repo-bootstrap';

const WINDOWS_TEMP_CLEANUP_RETRY_DELAYS_MS = [25, 50, 100, 200, 400, 800, 1200] as const;
const DEFAULT_TEMP_CLEANUP_RETRY_DELAYS_MS = [25, 50, 100, 200] as const;
const {
    acquireBuildRootLock,
    getBuildRootLockPath,
    releaseBuildRootLock
} = require('../../../scripts/node-foundation/build-root-lock.cjs') as {
    acquireBuildRootLock: (
        lockPath: string,
        options?: {
            timeoutMs?: number;
            metadataGraceMs?: number;
            staleMs?: number;
            backoffBaseMs?: number;
            backoffMultiplier?: number;
            backoffMaxMs?: number;
        }
    ) => void;
    getBuildRootLockPath: (buildRoot: string) => string;
    releaseBuildRootLock: (lockPath: string) => void;
};
const buildScriptsWrapper = require('../../../scripts/node-foundation/build-scripts.cjs') as {
    DEFAULT_SCRIPTS_BUILD_PROCESS_TIMEOUT_MS: number;
    buildScriptsInputFingerprint: (repoRoot: string) => { sha256: string };
    getScriptsBuildReuseStatus: (
        repoRoot: string,
        buildRoot: string,
        compiledEntryPath: string,
        fingerprint: { sha256: string }
    ) => { accepted: boolean; reason: string };
    resolveEntryProcessTimeoutMs: (entryScript: string) => number | undefined;
    runProcess: (command: string, args: string[], cwd: string, options?: { timeoutMs?: number }) => void;
};

function sleepSync(delayMs: number): void {
    if (delayMs <= 0) {
        return;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
}

function getTempCleanupRetryDelays(): readonly number[] {
    return process.platform === 'win32'
        ? WINDOWS_TEMP_CLEANUP_RETRY_DELAYS_MS
        : DEFAULT_TEMP_CLEANUP_RETRY_DELAYS_MS;
}

function removeTempTree(tempRoot: string): void {
    removeTempRepoWithRetry(tempRoot, { retryDelaysMs: getTempCleanupRetryDelays() });
}

function removeNodeModulesJunction(fixtureRoot: string): void {
    const nodeModulesPath = path.join(fixtureRoot, 'node_modules');
    if (!fs.existsSync(nodeModulesPath)) {
        return;
    }

    try {
        const stats = fs.lstatSync(nodeModulesPath);
        if (stats.isSymbolicLink()) {
            fs.unlinkSync(nodeModulesPath);
            return;
        }
    } catch {
        // Fall through to junction/rmdir handling.
    }

    try {
        fs.rmdirSync(nodeModulesPath);
        return;
    } catch {
        // Fall through.
    }

    try {
        fs.rmSync(nodeModulesPath, { recursive: false, force: true });
    } catch {
        // Best effort before parent cleanup retries.
    }
}

function cleanupBuildScriptsFixture(tempRoot: string): void {
    const fixtureRoot = path.join(tempRoot, 'repo');
    if (process.platform === 'win32') {
        sleepSync(75);
        removeNodeModulesJunction(fixtureRoot);
        const lockPath = path.join(fixtureRoot, '.scripts-build.lock');
        if (fs.existsSync(lockPath)) {
            try {
                releaseBuildRootLock(lockPath);
            } catch {
                removeTempRepoWithRetry(lockPath, { retryDelaysMs: [25, 50, 100] });
            }
        }
    }
        removeTempTree(tempRoot);
}

function writeTextFile(filePath: string, content: string): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
}

function agePath(targetPath: string, ageMs: number): void {
    const oldTime = new Date(Date.now() - ageMs);
    fs.utimesSync(targetPath, oldTime, oldTime);
}

function parseSerializedRanges(logPath: string): Array<{ pid: number; acquiredAt: number; releasedAt: number; }> {
    const ranges = new Map<number, { acquiredAt?: number; releasedAt?: number }>();
    const lines = fs.readFileSync(logPath, 'utf8').trim().split(/\r?\n/).filter(Boolean);

    for (const line of lines) {
        const [eventType, pidText, timestampText] = line.trim().split(/\s+/);
        const pid = Number(pidText);
        const timestamp = Number(timestampText);
        assert.ok(Number.isInteger(pid) && pid > 0, `Unexpected pid in log line: ${line}`);
        assert.ok(Number.isFinite(timestamp) && timestamp > 0, `Unexpected timestamp in log line: ${line}`);

        const current = ranges.get(pid) || {};
        if (eventType === 'start' || eventType === 'acquired') {
            current.acquiredAt = timestamp;
        } else if (eventType === 'end' || eventType === 'released') {
            current.releasedAt = timestamp;
        } else {
            assert.fail(`Unexpected event type in log line: ${line}`);
        }
        ranges.set(pid, current);
    }

    return Array.from(ranges.entries())
        .map(([pid, range]) => ({
            pid,
            acquiredAt: Number(range.acquiredAt),
            releasedAt: Number(range.releasedAt)
        }))
        .sort((left, right) => left.acquiredAt - right.acquiredAt);
}

function assertSerializedRanges(logPath: string, expectedCount: number): void {
    const ranges = parseSerializedRanges(logPath);
    assert.equal(ranges.length, expectedCount, `Expected ${expectedCount} serialized workers`);

    for (const range of ranges) {
        assert.ok(Number.isFinite(range.acquiredAt) && range.acquiredAt > 0, 'Missing acquired/start timestamp');
        assert.ok(Number.isFinite(range.releasedAt) && range.releasedAt >= range.acquiredAt, 'Missing released/end timestamp');
    }

    for (let index = 1; index < ranges.length; index += 1) {
        assert.ok(
            ranges[index].acquiredAt >= ranges[index - 1].releasedAt,
            `Worker ${ranges[index].pid} overlapped worker ${ranges[index - 1].pid}`
        );
    }
}

function runWorker(command: string, args: string[], options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
} = {}): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        const child = spawn(command, args, {
            cwd: options.cwd,
            env: options.env,
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true
        });

        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => {
            stdout += String(chunk);
        });
        child.stderr.on('data', (chunk) => {
            stderr += String(chunk);
        });

        child.on('error', reject);
        child.on('close', (code) => {
            if (code === 0) {
                resolve();
                return;
            }
            reject(new Error([`${path.basename(command)} exited with code ${code}`, stdout, stderr].filter(Boolean).join('\n')));
        });
    });
}

function createBuildScriptsFixture(repoRoot: string): string {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-build-root-fixture-'));
    const fixtureRoot = path.join(tempRoot, 'repo');
    const relativePaths = [
        'package.json',
        'VERSION',
        'tsconfig.scripts.json',
        'src',
        'scripts/node-foundation'
    ];

    fs.mkdirSync(fixtureRoot, { recursive: true });
    for (const relativePath of relativePaths) {
        fs.cpSync(path.join(repoRoot, relativePath), path.join(fixtureRoot, relativePath), { recursive: true });
    }

    const realNodeModules = path.join(repoRoot, 'node_modules');
    const fixtureNodeModules = path.join(fixtureRoot, 'node_modules');
    if (fs.existsSync(realNodeModules) && !fs.existsSync(fixtureNodeModules)) {
        fs.symlinkSync(realNodeModules, fixtureNodeModules, 'junction');
    }

    return tempRoot;
}

test('releaseBuildRootLock retries transient Windows-style removal failures', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-build-root-release-retry-'));
    const buildRoot = path.join(tempRoot, '.scripts-build');
    const lockPath = getBuildRootLockPath(buildRoot);
    const mutableFs = require('node:fs') as typeof import('node:fs') & { rmSync: typeof fs.rmSync; };
    const originalRmSync = mutableFs.rmSync;
    let injectedFailures = 0;

    try {
        fs.mkdirSync(lockPath, { recursive: true });
        fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
            hostname: os.hostname(),
            pid: process.pid,
            startedAtUtc: new Date().toISOString()
        }), 'utf8');

        mutableFs.rmSync = ((targetPath: fs.PathLike, options?: fs.RmOptions) => {
            if (path.resolve(String(targetPath)) === path.resolve(lockPath) && injectedFailures < 2) {
                injectedFailures += 1;
                const error = new Error('Injected transient removal failure') as NodeJS.ErrnoException;
                error.code = 'EBUSY';
                throw error;
            }
            return originalRmSync(targetPath, options);
        }) as typeof fs.rmSync;

        releaseBuildRootLock(lockPath);

        assert.equal(injectedFailures, 2);
        assert.equal(fs.existsSync(lockPath), false);
    } finally {
        mutableFs.rmSync = originalRmSync;
        removeTempTree(tempRoot);
    }
});

test('withBuildRootLock serializes concurrent workers without leaving lock directories', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-build-root-lock-'));
    const buildRoot = path.join(tempRoot, '.node-build');
    const eventLogPath = path.join(tempRoot, 'build-root-events.log');
    const buildModulePath = path.resolve(__dirname, '../../../scripts/node-foundation/build.js');
    const workerScript = [
        "const fs = require('node:fs');",
        "const { withBuildRootLock } = require(process.argv[1]);",
        "const buildRoot = process.argv[2];",
        "const eventLogPath = process.argv[3];",
        "const holdMs = Number(process.argv[4] || '0');",
        "function record(label) { fs.appendFileSync(eventLogPath, `${label} ${process.pid} ${Date.now()}\\n`, 'utf8'); }",
        "withBuildRootLock(buildRoot, () => {",
        "  record('start');",
        "  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, holdMs);",
        "  record('end');",
        "});"
    ].join('\n');

    try {
        await Promise.all([
            runWorker(process.execPath, ['--input-type=commonjs', '--eval', workerScript, buildModulePath, buildRoot, eventLogPath, '400']),
            runWorker(process.execPath, ['--input-type=commonjs', '--eval', workerScript, buildModulePath, buildRoot, eventLogPath, '400'])
        ]);

        assertSerializedRanges(eventLogPath, 2);
        assert.ok(!fs.existsSync(`${buildRoot}.lock`), 'build root lock directory must be removed after workers finish');
    } finally {
        removeTempTree(tempRoot);
    }
});

test('acquireBuildRootLock reclaims orphaned lock directory without owner metadata after grace period', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-build-root-orphan-'));
    const buildRoot = path.join(tempRoot, '.scripts-build');
    const lockPath = getBuildRootLockPath(buildRoot);

    try {
        fs.mkdirSync(lockPath, { recursive: true });
        agePath(lockPath, 5000);

        acquireBuildRootLock(lockPath, {
            timeoutMs: 250,
            metadataGraceMs: 2000,
            backoffBaseMs: 5,
            backoffMaxMs: 10
        });

        const owner = JSON.parse(fs.readFileSync(path.join(lockPath, 'owner.json'), 'utf8'));
        assert.equal(owner.pid, process.pid);
    } finally {
        releaseBuildRootLock(lockPath);
        removeTempTree(tempRoot);
    }
});

test('acquireBuildRootLock reclaims orphaned lock directory with corrupt owner metadata after grace period', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-build-root-corrupt-'));
    const buildRoot = path.join(tempRoot, '.scripts-build');
    const lockPath = getBuildRootLockPath(buildRoot);

    try {
        fs.mkdirSync(lockPath, { recursive: true });
        fs.writeFileSync(path.join(lockPath, 'owner.json'), 'NOT VALID JSON{{{', 'utf8');
        agePath(lockPath, 5000);

        acquireBuildRootLock(lockPath, {
            timeoutMs: 250,
            metadataGraceMs: 2000,
            backoffBaseMs: 5,
            backoffMaxMs: 10
        });

        const owner = JSON.parse(fs.readFileSync(path.join(lockPath, 'owner.json'), 'utf8'));
        assert.equal(owner.pid, process.pid);
    } finally {
        releaseBuildRootLock(lockPath);
        removeTempTree(tempRoot);
    }
});

test('acquireBuildRootLock does not reclaim orphaned lock directory within metadata grace period and reports diagnostics', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-build-root-fresh-'));
    const buildRoot = path.join(tempRoot, '.scripts-build');
    const lockPath = getBuildRootLockPath(buildRoot);

    try {
        fs.mkdirSync(lockPath, { recursive: true });

        assert.throws(
            () => acquireBuildRootLock(lockPath, {
                timeoutMs: 80,
                metadataGraceMs: 2000,
                backoffBaseMs: 5,
                backoffMaxMs: 10
            }),
            function (error: unknown) {
                assert.ok(error instanceof Error);
                assert.match(error.message, /Timed out acquiring build root lock/);
                assert.match(error.message, /metadata_status=missing/);
                assert.match(error.message, /stale_reason=none/);
                return true;
            }
        );
    } finally {
        removeTempTree(tempRoot);
    }
});

test('acquireBuildRootLock does not reclaim aged lock when owner PID is still alive', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-build-root-live-owner-'));
    const buildRoot = path.join(tempRoot, '.scripts-build');
    const lockPath = getBuildRootLockPath(buildRoot);

    try {
        fs.mkdirSync(lockPath, { recursive: true });
        fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
            pid: process.pid,
            hostname: os.hostname(),
            startedAtUtc: new Date().toISOString()
        }), 'utf8');
        agePath(lockPath, 5000);

        assert.throws(
            () => acquireBuildRootLock(lockPath, {
                timeoutMs: 80,
                metadataGraceMs: 2000,
                backoffBaseMs: 5,
                backoffMaxMs: 10
            }),
            function (error: unknown) {
                assert.ok(error instanceof Error);
                assert.match(error.message, /Timed out acquiring build root lock/);
                assert.match(error.message, /metadata_status=ok/);
                assert.match(error.message, /owner_alive=true/);
                assert.match(error.message, /stale_reason=none/);
                return true;
            }
        );
        assert.ok(fs.existsSync(lockPath), 'live-owner lock must remain in place after timeout');
    } finally {
        removeTempTree(tempRoot);
    }
});

test('acquireBuildRootLock keeps foreign-host partial metadata until stale timeout and then reclaims it', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-build-root-foreign-partial-'));
    const buildRoot = path.join(tempRoot, '.scripts-build');
    const lockPath = getBuildRootLockPath(buildRoot);

    try {
        fs.mkdirSync(lockPath, { recursive: true });
        fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
            hostname: 'foreign-host-for-build-lock'
        }), 'utf8');
        agePath(lockPath, 5000);

        assert.throws(
            () => acquireBuildRootLock(lockPath, {
                timeoutMs: 80,
                metadataGraceMs: 2000,
                staleMs: 20000,
                backoffBaseMs: 5,
                backoffMaxMs: 10
            }),
            function (error: unknown) {
                assert.ok(error instanceof Error);
                assert.match(error.message, /metadata_status=invalid_shape/);
                assert.match(error.message, /owner_host=foreign:/);
                assert.match(error.message, /stale_reason=none/);
                return true;
            }
        );

        fs.rmSync(lockPath, { recursive: true, force: true });
        fs.mkdirSync(lockPath, { recursive: true });
        fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
            hostname: 'foreign-host-for-build-lock'
        }), 'utf8');
        agePath(lockPath, 25000);

        acquireBuildRootLock(lockPath, {
            timeoutMs: 250,
            metadataGraceMs: 2000,
            staleMs: 20000,
            backoffBaseMs: 5,
            backoffMaxMs: 10
        });

        const owner = JSON.parse(fs.readFileSync(path.join(lockPath, 'owner.json'), 'utf8'));
        assert.equal(owner.pid, process.pid);
    } finally {
        releaseBuildRootLock(lockPath);
        removeTempTree(tempRoot);
    }
});

test('acquireBuildRootLock does not reclaim missing owner metadata during extended initialization grace', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-build-root-init-grace-'));
    const buildRoot = path.join(tempRoot, '.scripts-build');
    const lockPath = getBuildRootLockPath(buildRoot);

    try {
        fs.mkdirSync(lockPath, { recursive: true });
        agePath(lockPath, 5000);

        assert.throws(
            () => acquireBuildRootLock(lockPath, {
                timeoutMs: 80,
                metadataGraceMs: 30000,
                backoffBaseMs: 5,
                backoffMaxMs: 10
            }),
            function (error: unknown) {
                assert.ok(error instanceof Error);
                assert.match(error.message, /metadata_status=missing/);
                assert.match(error.message, /stale_reason=none/);
                return true;
            }
        );
        assert.ok(fs.existsSync(lockPath), 'lock should remain during extended initialization grace');
    } finally {
        removeTempTree(tempRoot);
    }
});

test('acquireBuildRootLock does not treat transient owner metadata read failures as corruption', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-build-root-transient-read-'));
    const buildRoot = path.join(tempRoot, '.scripts-build');
    const lockPath = getBuildRootLockPath(buildRoot);
    const ownerPath = path.join(lockPath, 'owner.json');
    const mutableFs = require('node:fs') as typeof fs & { readFileSync: typeof fs.readFileSync };
    const originalReadFileSync = mutableFs.readFileSync;

    try {
        fs.mkdirSync(lockPath, { recursive: true });
        fs.writeFileSync(ownerPath, JSON.stringify({
            pid: process.pid,
            hostname: os.hostname(),
            startedAtUtc: new Date().toISOString()
        }), 'utf8');
        agePath(lockPath, 5000);

        mutableFs.readFileSync = function (filePath: fs.PathOrFileDescriptor, options?: Parameters<typeof originalReadFileSync>[1]) {
            if (String(filePath).replace(/\\/g, '/').endsWith('/owner.json')) {
                const error = new Error('owner metadata temporarily busy') as NodeJS.ErrnoException;
                error.code = 'EBUSY';
                throw error;
            }
            return (originalReadFileSync as typeof fs.readFileSync)(filePath, options as never);
        } as typeof fs.readFileSync;

        assert.throws(
            () => acquireBuildRootLock(lockPath, {
                timeoutMs: 80,
                metadataGraceMs: 2000,
                staleMs: 20000,
                backoffBaseMs: 5,
                backoffMaxMs: 10
            }),
            function (error: unknown) {
                assert.ok(error instanceof Error);
                assert.match(error.message, /metadata_status=transient_read_error/);
                assert.match(error.message, /stale_reason=none/);
                return true;
            }
        );
        assert.ok(fs.existsSync(lockPath), 'transient read failures must not reclaim a live lock');
    } finally {
        mutableFs.readFileSync = originalReadFileSync;
        removeTempTree(tempRoot);
    }
});

test('build-scripts wrapper serializes concurrent workers and leaves a usable scripts build', async () => {
    const repoRoot = getRepoRoot();
    const tempRoot = createBuildScriptsFixture(repoRoot);
    const fixtureRoot = path.join(tempRoot, 'repo');
    const tracePath = path.join(tempRoot, 'wrapper-lock-trace.log');
    const wrapperPath = path.join(fixtureRoot, 'scripts', 'node-foundation', 'build-scripts.cjs');

    try {
        await Promise.all([
            runWorker(process.execPath, [wrapperPath], {
                cwd: fixtureRoot,
                env: {
                    ...process.env,
                    GARDA_BUILD_SCRIPTS_LOCK_HOLD_MS: '300',
                    GARDA_BUILD_SCRIPTS_TRACE_FILE: tracePath
                }
            }),
            runWorker(process.execPath, [wrapperPath], {
                cwd: fixtureRoot,
                env: {
                    ...process.env,
                    GARDA_BUILD_SCRIPTS_LOCK_HOLD_MS: '300',
                    GARDA_BUILD_SCRIPTS_TRACE_FILE: tracePath
                }
            })
        ]);

        assertSerializedRanges(tracePath, 2);
        assert.ok(fs.existsSync(path.join(fixtureRoot, '.scripts-build', 'scripts', 'node-foundation', 'build.js')));
        assert.ok(fs.existsSync(path.join(fixtureRoot, 'bin', 'garda.js')));
        assert.ok(!fs.existsSync(path.join(fixtureRoot, '.scripts-build.lock')), 'wrapper lock directory must be removed after build');
    } finally {
        cleanupBuildScriptsFixture(tempRoot);
    }
});

test('build input fingerprint changes when source or config inputs change', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-build-fingerprint-'));
    const repoRoot = path.join(tempRoot, 'repo');

    try {
        writeTextFile(path.join(repoRoot, 'package.json'), JSON.stringify({
            name: 'fixture',
            version: '1.0.0',
            engines: { node: '^22.13.0 || >=24.0.0' }
        }));
        writeTextFile(path.join(repoRoot, 'package-lock.json'), '{}\n');
        writeTextFile(path.join(repoRoot, 'tsconfig.json'), '{}\n');
        writeTextFile(path.join(repoRoot, 'tsconfig.tests.json'), '{}\n');
        writeTextFile(path.join(repoRoot, 'src', 'index.ts'), 'export const value = 1;\n');
        writeTextFile(path.join(repoRoot, 'tests', 'node', 'sample.test.ts'), 'void 0;\n');
        writeTextFile(path.join(repoRoot, 'scripts', 'node-foundation', 'build.ts'), 'void 0;\n');
        writeTextFile(path.join(repoRoot, 'scripts', 'node-foundation', 'build-root-lock.cjs'), 'module.exports = {};\n');

        const before = buildNodeFoundationInputFingerprint(repoRoot);
        writeTextFile(path.join(repoRoot, 'src', 'index.ts'), 'export const value = 2;\n');
        const afterSourceChange = buildNodeFoundationInputFingerprint(repoRoot);
        writeTextFile(path.join(repoRoot, 'tsconfig.tests.json'), '{"compilerOptions":{"strict":true}}\n');
        const afterConfigChange = buildNodeFoundationInputFingerprint(repoRoot);

        assert.notEqual(afterSourceChange.sha256, before.sha256);
        assert.notEqual(afterConfigChange.sha256, afterSourceChange.sha256);
    } finally {
        removeTempTree(tempRoot);
    }
});

test('publish-runtime fingerprint changes when build-prep scripts change', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-publish-fingerprint-'));
    const repoRoot = path.join(tempRoot, 'repo');

    try {
        writeTextFile(path.join(repoRoot, 'package.json'), JSON.stringify({
            name: 'fixture',
            version: '1.0.0',
            engines: { node: '^22.13.0 || >=24.0.0' }
        }));
        writeTextFile(path.join(repoRoot, 'package-lock.json'), '{}\n');
        writeTextFile(path.join(repoRoot, 'VERSION'), '1.0.0\n');
        writeTextFile(path.join(repoRoot, 'tsconfig.json'), '{}\n');
        writeTextFile(path.join(repoRoot, 'tsconfig.build.json'), '{}\n');
        writeTextFile(path.join(repoRoot, 'src', 'index.ts'), 'export const value = 1;\n');
        writeTextFile(path.join(repoRoot, 'scripts', 'node-foundation', 'build.ts'), 'export const build = 1;\n');
        writeTextFile(path.join(repoRoot, 'scripts', 'node-foundation', 'build-root-lock.cjs'), 'module.exports = {};\n');

        const before = buildPublishRuntimeInputFingerprint(repoRoot);
        writeTextFile(path.join(repoRoot, 'scripts', 'node-foundation', 'build.ts'), 'export const build = 2;\n');
        const after = buildPublishRuntimeInputFingerprint(repoRoot);

        assert.notEqual(after.sha256, before.sha256);
    } finally {
        removeTempTree(tempRoot);
    }
});

test('build-scripts wrapper reuses current compiled wrapper build by fingerprint', async () => {
    const repoRoot = getRepoRoot();
    const tempRoot = createBuildScriptsFixture(repoRoot);
    const fixtureRoot = path.join(tempRoot, 'repo');
    const wrapperPath = path.join(fixtureRoot, 'scripts', 'node-foundation', 'build-scripts.cjs');
    const compiledBuildPath = path.join(fixtureRoot, '.scripts-build', 'scripts', 'node-foundation', 'build.js');
    const fingerprintPath = path.join(fixtureRoot, '.scripts-build', 'scripts-build-fingerprint.json');

    try {
        await runWorker(process.execPath, [wrapperPath], { cwd: fixtureRoot, env: process.env });
        const firstStat = fs.statSync(compiledBuildPath);
        const firstFingerprint = JSON.parse(fs.readFileSync(fingerprintPath, 'utf8')) as { sha256?: string };

        await runWorker(process.execPath, [wrapperPath], { cwd: fixtureRoot, env: process.env });
        const secondStat = fs.statSync(compiledBuildPath);
        const secondFingerprint = JSON.parse(fs.readFileSync(fingerprintPath, 'utf8')) as { sha256?: string };

        assert.equal(secondFingerprint.sha256, firstFingerprint.sha256);
        assert.equal(secondStat.mtimeMs, firstStat.mtimeMs);
    } finally {
        cleanupBuildScriptsFixture(tempRoot);
    }
});

test('build-scripts prebuilt test entry still requires a current fingerprint', () => {
    const repoRoot = getRepoRoot();
    const tempRoot = createBuildScriptsFixture(repoRoot);
    const fixtureRoot = path.join(tempRoot, 'repo');
    const buildRoot = path.join(fixtureRoot, '.scripts-build');
    const compiledEntryPath = path.join(buildRoot, 'scripts', 'node-foundation', 'test.js');
    const originalPrebuiltEnv = process.env.GARDA_NODE_FOUNDATION_TEST_PREBUILT;

    try {
        process.env.GARDA_NODE_FOUNDATION_TEST_PREBUILT = '1';
        writeTextFile(compiledEntryPath, 'void 0;\n');
        writeTextFile(path.join(buildRoot, 'src', 'bin', 'garda.js'), 'void 0;\n');
        writeTextFile(path.join(buildRoot, 'scripts', 'node-foundation', 'build-root-lock.cjs'), 'module.exports = {};\n');

        const fingerprint = buildScriptsWrapper.buildScriptsInputFingerprint(fixtureRoot);
        const reuseStatus = buildScriptsWrapper.getScriptsBuildReuseStatus(
            fixtureRoot,
            buildRoot,
            compiledEntryPath,
            fingerprint
        );

        assert.equal(reuseStatus.accepted, false);
        assert.equal(reuseStatus.reason, 'input_fingerprint_mismatch');
    } finally {
        if (originalPrebuiltEnv === undefined) {
            delete process.env.GARDA_NODE_FOUNDATION_TEST_PREBUILT;
        } else {
            process.env.GARDA_NODE_FOUNDATION_TEST_PREBUILT = originalPrebuiltEnv;
        }
        cleanupBuildScriptsFixture(tempRoot);
    }
});

test('node-foundation manifest includes copied UI language packs for reuse validation', () => {
    const repoRoot = getRepoRoot();
    const manifestPath = path.join(repoRoot, '.node-build', 'node-foundation-manifest.json');

    assert.ok(fs.existsSync(manifestPath), 'node-foundation manifest must exist for this compiled test run');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { files?: string[] };
    const files = Array.isArray(manifest.files) ? manifest.files : [];

    assert.ok(
        files.some((filePath) => /^src\/reports\/ui\/lang-packs\/garda-ui-.+\.json$/u.test(filePath)),
        'node-foundation manifest must track copied UI language pack JSON files'
    );
});

function createReusableBuildFixture(kind: BuildInputFingerprint['kind']): {
    buildRoot: string;
    cleanup: () => void;
    fingerprint: BuildInputFingerprint;
    manifestPath: string;
    repoRoot: string;
} {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), `gao-reusable-${kind}-`));
    const repoRoot = path.join(tempRoot, 'repo');
    const buildRoot = path.join(repoRoot, kind === 'node-foundation' ? '.node-build' : 'dist');
    const compiledCliPath = path.join(buildRoot, 'src', 'bin', 'garda.js');
    const compiledTestPath = path.join(buildRoot, 'tests', 'node', 'sample.test.js');
    const runtimeJsonPath = path.join(buildRoot, 'src', 'reports', 'ui', 'lang-packs', 'garda-ui-en.json');
    const supportPath = path.join(buildRoot, 'scripts', 'node-foundation', 'build-root-lock.cjs');
    const buildScriptsSupportPath = path.join(buildRoot, 'scripts', 'node-foundation', 'build-scripts.cjs');

    writeTextFile(path.join(repoRoot, 'package.json'), JSON.stringify({
        name: 'fixture',
        version: '1.0.0',
        engines: { node: '^22.13.0 || >=24.0.0' }
    }));
    writeTextFile(path.join(repoRoot, 'package-lock.json'), '{}\n');
    writeTextFile(path.join(repoRoot, 'VERSION'), '1.0.0\n');
    writeTextFile(path.join(repoRoot, 'tsconfig.json'), '{}\n');
    writeTextFile(path.join(repoRoot, 'tsconfig.tests.json'), '{}\n');
    writeTextFile(path.join(repoRoot, 'tsconfig.build.json'), '{}\n');
    writeTextFile(path.join(repoRoot, 'src', 'index.ts'), 'export const value = 1;\n');
    writeTextFile(path.join(repoRoot, 'tests', 'node', 'sample.test.ts'), 'void 0;\n');
    writeTextFile(path.join(repoRoot, 'scripts', 'node-foundation', 'build.ts'), 'void 0;\n');
    writeTextFile(path.join(repoRoot, 'scripts', 'node-foundation', 'build-root-lock.cjs'), 'module.exports = {};\n');

    writeTextFile(compiledCliPath, 'void 0;\n');
    if (kind === 'node-foundation') {
        writeTextFile(compiledTestPath, 'void 0;\n');
    }
    writeTextFile(runtimeJsonPath, '{}\n');
    writeTextFile(supportPath, 'module.exports = {};\n');
    writeTextFile(buildScriptsSupportPath, 'module.exports = {};\n');

    const fingerprint = kind === 'node-foundation'
        ? buildNodeFoundationInputFingerprint(repoRoot)
        : buildPublishRuntimeInputFingerprint(repoRoot);
    const manifestPath = path.join(buildRoot, kind === 'node-foundation'
        ? 'node-foundation-manifest.json'
        : 'publish-runtime-manifest.json');
    writeTextFile(manifestPath, JSON.stringify({
        nodeEngineRange: '^22.13.0 || >=24.0.0',
        sourceRoots: kind === 'node-foundation' ? ['src', 'tests/node', 'scripts/node-foundation'] : ['src'],
        files: [
            'src/bin/garda.js',
            'src/reports/ui/lang-packs/garda-ui-en.json',
            ...(kind === 'node-foundation' ? ['tests/node/sample.test.js'] : [])
        ],
        inputFingerprint: fingerprint
    }, null, 2) + '\n');

    return {
        buildRoot,
        cleanup() {
            removeTempTree(tempRoot);
        },
        fingerprint,
        manifestPath,
        repoRoot
    };
}

test('node-foundation reuse rejects missing copied assets and force rebuild requests', () => {
    const fixture = createReusableBuildFixture('node-foundation');
    const originalForceRebuild = process.env.GARDA_NODE_FOUNDATION_FORCE_REBUILD;

    try {
        let reuseStatus = checkReusableBuildRoot(
            fixture.buildRoot,
            fixture.manifestPath,
            fixture.fingerprint,
            'GARDA_NODE_FOUNDATION_FORCE_REBUILD',
            true
        );
        assert.equal(reuseStatus.accepted, true);

        fs.rmSync(path.join(fixture.buildRoot, 'src', 'reports', 'ui', 'lang-packs', 'garda-ui-en.json'));
        reuseStatus = checkReusableBuildRoot(
            fixture.buildRoot,
            fixture.manifestPath,
            fixture.fingerprint,
            'GARDA_NODE_FOUNDATION_FORCE_REBUILD',
            true
        );
        assert.equal(reuseStatus.accepted, false);
        assert.equal(reuseStatus.reason, 'compiled_files_missing');

        writeTextFile(path.join(fixture.buildRoot, 'src', 'reports', 'ui', 'lang-packs', 'garda-ui-en.json'), '{}\n');
        process.env.GARDA_NODE_FOUNDATION_FORCE_REBUILD = '1';
        reuseStatus = checkReusableBuildRoot(
            fixture.buildRoot,
            fixture.manifestPath,
            fixture.fingerprint,
            'GARDA_NODE_FOUNDATION_FORCE_REBUILD',
            true
        );
        assert.equal(reuseStatus.accepted, false);
        assert.equal(reuseStatus.reason, 'GARDA_NODE_FOUNDATION_FORCE_REBUILD=1');
    } finally {
        if (originalForceRebuild === undefined) {
            delete process.env.GARDA_NODE_FOUNDATION_FORCE_REBUILD;
        } else {
            process.env.GARDA_NODE_FOUNDATION_FORCE_REBUILD = originalForceRebuild;
        }
        fixture.cleanup();
    }
});

test('node-foundation reuse rejects incomplete manifests that omit discovered tests', () => {
    const fixture = createReusableBuildFixture('node-foundation');

    try {
        const manifest = JSON.parse(fs.readFileSync(fixture.manifestPath, 'utf8')) as { files: string[] };
        manifest.files = manifest.files.filter((filePath) => filePath !== 'tests/node/sample.test.js');
        writeTextFile(fixture.manifestPath, JSON.stringify(manifest, null, 2) + '\n');

        const reuseStatus = checkReusableBuildRoot(
            fixture.buildRoot,
            fixture.manifestPath,
            fixture.fingerprint,
            'GARDA_NODE_FOUNDATION_FORCE_REBUILD',
            true
        );

        assert.equal(reuseStatus.accepted, false);
        assert.equal(reuseStatus.reason, 'manifest_incomplete');
    } finally {
        fixture.cleanup();
    }
});

test('published runtime manifest excludes host-specific build-cache fingerprints', () => {
    const repoRoot = getRepoRoot();
    const manifestPath = path.join(repoRoot, 'dist', 'publish-runtime-manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    assert.deepEqual(Object.keys(manifest).sort(), ['files', 'nodeEngineRange', 'sourceRoots']);
    assert.deepEqual(manifest.sourceRoots, ['src']);
    assert.ok(Array.isArray(manifest.files) && manifest.files.length > 0);
    const cachePath = path.join(repoRoot, '.scripts-build', 'publish-runtime-build-cache.json');
    const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8')) as {
        inputFingerprint: BuildInputFingerprint;
        publishedManifestSha256: string;
    };
    assert.equal(cache.inputFingerprint.nodeVersion, process.version);
    assert.equal(cache.inputFingerprint.platform, process.platform);
    assert.equal(cache.publishedManifestSha256,
        crypto.createHash('sha256').update(fs.readFileSync(manifestPath)).digest('hex'));
    const manifestMtime = fs.statSync(manifestPath).mtimeMs;
    assert.equal(buildPublishRuntime().manifestPath, manifestPath);
    assert.equal(fs.statSync(manifestPath).mtimeMs, manifestMtime, 'current inputs must reuse the published runtime');
});

test('publish-runtime cache rejects changed or missing manifests and keeps input and asset guards', () => {
    const fixture = createReusableBuildFixture('publish-runtime');
    const cachePath = path.join(fixture.repoRoot, '.scripts-build', 'publish-runtime-build-cache.json');
    const originalForceRebuild = process.env.GARDA_PUBLISH_RUNTIME_FORCE_REBUILD;
    try {
        delete process.env.GARDA_PUBLISH_RUNTIME_FORCE_REBUILD;
        const manifest = JSON.parse(fs.readFileSync(fixture.manifestPath, 'utf8')) as Record<string, unknown>;
        delete manifest.inputFingerprint;
        const publishedContent = JSON.stringify(manifest, null, 2) + '\n';
        writeTextFile(fixture.manifestPath, publishedContent);
        const cache = {
            ...manifest,
            inputFingerprint: fixture.fingerprint,
            publishedManifestSha256: crypto.createHash('sha256').update(publishedContent).digest('hex')
        };
        writeTextFile(cachePath, JSON.stringify(cache));
        const inspect = (fingerprint = fixture.fingerprint) => checkReusableBuildRoot(
            fixture.buildRoot, cachePath, fingerprint, 'GARDA_PUBLISH_RUNTIME_FORCE_REBUILD', false,
            fixture.manifestPath
        );
        assert.equal(inspect().accepted, true);
        assert.equal(inspect({ ...fixture.fingerprint, sha256: 'changed-inputs' }).reason, 'input_fingerprint_mismatch');
        process.env.GARDA_PUBLISH_RUNTIME_FORCE_REBUILD = '1';
        assert.equal(inspect().reason, 'GARDA_PUBLISH_RUNTIME_FORCE_REBUILD=1');
        delete process.env.GARDA_PUBLISH_RUNTIME_FORCE_REBUILD;
        writeTextFile(fixture.manifestPath, publishedContent + ' ');
        assert.equal(inspect().reason, 'published_manifest_mismatch');
        fs.unlinkSync(fixture.manifestPath);
        assert.equal(inspect().reason, 'published_manifest_mismatch');
        writeTextFile(fixture.manifestPath, publishedContent);
        assert.equal(inspect().accepted, true);
        writeTextFile(cachePath, JSON.stringify({ ...cache, publishedManifestSha256: undefined }));
        assert.equal(inspect().reason, 'published_manifest_mismatch');
        writeTextFile(cachePath, '{');
        assert.equal(inspect().reason, 'manifest_missing_or_unreadable');
        fs.unlinkSync(cachePath);
        assert.equal(inspect().reason, 'manifest_missing_or_unreadable');
        writeTextFile(cachePath, JSON.stringify(cache));
        fs.unlinkSync(path.join(fixture.buildRoot, 'src', 'reports', 'ui', 'lang-packs', 'garda-ui-en.json'));
        assert.equal(inspect().reason, 'compiled_files_missing');
    } finally {
        if (originalForceRebuild === undefined) {
            delete process.env.GARDA_PUBLISH_RUNTIME_FORCE_REBUILD;
        } else {
            process.env.GARDA_PUBLISH_RUNTIME_FORCE_REBUILD = originalForceRebuild;
        }
        fixture.cleanup();
    }
});

test('publish-runtime reuse rejects missing copied assets and prints rejected diagnostics', () => {
    const fixture = createReusableBuildFixture('publish-runtime');
    const originalWrite = process.stdout.write;
    let output = '';

    try {
        fs.rmSync(path.join(fixture.buildRoot, 'src', 'reports', 'ui', 'lang-packs', 'garda-ui-en.json'));
        const reuseStatus = checkReusableBuildRoot(
            fixture.buildRoot,
            fixture.manifestPath,
            fixture.fingerprint,
            'GARDA_PUBLISH_RUNTIME_FORCE_REBUILD',
            false
        );
        assert.equal(reuseStatus.accepted, false);
        assert.equal(reuseStatus.reason, 'compiled_files_missing');

        process.stdout.write = ((chunk: string | Uint8Array) => {
            output += String(chunk);
            return true;
        }) as typeof process.stdout.write;
        printReuseDiagnostic('PUBLISH_RUNTIME_BUILD', reuseStatus, fixture.fingerprint);

        assert.match(output, /PUBLISH_RUNTIME_BUILD_REUSE rejected reason=compiled_files_missing fingerprint=[a-f0-9]{16}/);
    } finally {
        process.stdout.write = originalWrite;
        fixture.cleanup();
    }
});

test('build-scripts wrapper reclaims orphaned lock directory without owner metadata after grace period', async () => {
    const repoRoot = getRepoRoot();
    const tempRoot = createBuildScriptsFixture(repoRoot);
    const fixtureRoot = path.join(tempRoot, 'repo');
    const wrapperPath = path.join(fixtureRoot, 'scripts', 'node-foundation', 'build-scripts.cjs');
    const lockPath = path.join(fixtureRoot, '.scripts-build.lock');

    try {
        fs.mkdirSync(lockPath, { recursive: true });
        agePath(lockPath, 35000);

        await runWorker(process.execPath, [wrapperPath], {
            cwd: fixtureRoot,
            env: {
                ...process.env,
                GARDA_BUILD_SCRIPTS_LOCK_HOLD_MS: '0'
            }
        });

        assert.ok(fs.existsSync(path.join(fixtureRoot, '.scripts-build', 'scripts', 'node-foundation', 'build.js')));
        assert.ok(!fs.existsSync(lockPath), 'wrapper should reclaim abandoned lock directory and remove it after build');
    } finally {
        cleanupBuildScriptsFixture(tempRoot);
    }
});

test('build-scripts wrapper fails hung child processes with timeout diagnostics', () => {
    assert.equal(buildScriptsWrapper.DEFAULT_SCRIPTS_BUILD_PROCESS_TIMEOUT_MS, 15 * 60 * 1000);

    assert.throws(
        () => buildScriptsWrapper.runProcess(
            process.execPath,
            ['-e', 'const started = Date.now(); while (Date.now() - started < 10000) {}'],
            getRepoRoot(),
            { timeoutMs: 100 }
        ),
        /node(?:\.exe)? timed out after 100 ms: .* -e /u
    );
});

test('build-scripts wrapper leaves test entrypoints unlimited without changing other entrypoints', () => {
    assert.equal(buildScriptsWrapper.resolveEntryProcessTimeoutMs('test.js'), 0);
    assert.equal(buildScriptsWrapper.resolveEntryProcessTimeoutMs('build.js'), undefined);
    assert.equal(buildScriptsWrapper.resolveEntryProcessTimeoutMs('release-validation.js'), undefined);
});

test('build-scripts wrapper honors an explicit unlimited process timeout', () => {
    const previousTimeout = process.env.GARDA_BUILD_SCRIPTS_PROCESS_TIMEOUT_MS;
    process.env.GARDA_BUILD_SCRIPTS_PROCESS_TIMEOUT_MS = '50';
    try {
        buildScriptsWrapper.runProcess(
            process.execPath,
            ['-e', 'setTimeout(() => {}, 150)'],
            getRepoRoot(),
            { timeoutMs: 0 }
        );
    } finally {
        if (previousTimeout === undefined) {
            delete process.env.GARDA_BUILD_SCRIPTS_PROCESS_TIMEOUT_MS;
        } else {
            process.env.GARDA_BUILD_SCRIPTS_PROCESS_TIMEOUT_MS = previousTimeout;
        }
    }
});

test('node-foundation build wrapper fails timed-out tsc with high-signal diagnostics', () => {
    const repoRoot = getRepoRoot();
    const calls: Array<{ timeoutMs: number; nodeOptions: string | undefined }> = [];

    assert.throws(
        () => runTsc(['-p', 'tsconfig.tests.json'], repoRoot, {
            timeoutMs: 1234,
            processRunner: (_command, _args, options) => {
                calls.push({
                    timeoutMs: options.timeoutMs,
                    nodeOptions: options.env.NODE_OPTIONS
                });
                return {
                    pid: 0,
                    output: [],
                    stdout: '',
                    stderr: '',
                    status: null,
                    signal: 'SIGTERM',
                    error: Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }),
                    timedOut: true
                };
            }
        }),
        /TypeScript compilation timed out after 1234 ms: .*tsc -p tsconfig\.tests\.json/u
    );

    assert.deepEqual(calls, [{ timeoutMs: 1234, nodeOptions: '' }]);
});
