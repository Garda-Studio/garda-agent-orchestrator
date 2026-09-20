import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { redactSecretText, sha256RedactedJsonPayload } from '../../../src/core/redaction';
import { fileSha256 } from '../../../src/gate-runtime/hash';

import {
    assertReviewArtifactFileSha256,
    cleanupStaleReviewArtifactLocks,
    getReviewArtifactLockPath,
    getReviewArtifactTransactionLockPath,
    readReviewArtifactFileSha256,
    readReviewArtifactFileSnapshot,
    readReviewArtifactJsonFile,
    readReviewArtifactJsonSnapshot,
    readReviewArtifactTextFile,
    readReviewArtifactTextSnapshot,
    ReviewArtifactReadBudgetError,
    scanReviewArtifactLocks,
    withReviewArtifactLockAsync,
    withReviewArtifactReadBarrier,
    withReviewArtifactReadSnapshot,
    writeReviewArtifactJson,
    writeReviewArtifactsWithRollback,
    writeReviewArtifactText
} from '../../../src/gate-runtime/review/review-artifacts';
import {
    loadIndex,
    resolveIndexPath,
    resolveIndexLockPath
} from '../../../src/gate-runtime/review/reviews-index';
import { createReviewAttemptArtifactIndex } from '../../../src/gates/review-attempts/review-attempt-artifact-index';
import {
    acquireFilesystemLock,
    releaseFilesystemLock
} from '../../../src/gate-runtime/timeline/task-events';

function listTempArtifacts(directoryPath: string): string[] {
    return fs.readdirSync(directoryPath).filter((entry) => entry.includes('.tmp-'));
}

function createReviewsDir(root: string): string {
    const reviewsDir = path.join(root, 'runtime', 'reviews');
    fs.mkdirSync(reviewsDir, { recursive: true });
    return reviewsDir;
}

async function delay(milliseconds: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function holdReviewArtifactLock(lockPath: string, holdMs: number): Promise<() => Promise<void>> {
    const workerScript = [
        "const fs = require('node:fs');",
        "const os = require('node:os');",
        "const path = require('node:path');",
        "const lockPath = process.argv[1];",
        "const holdMs = Number.parseInt(process.argv[2], 10);",
        "fs.mkdirSync(lockPath, { recursive: true });",
        "fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({",
        "  pid: process.pid,",
        "  hostname: os.hostname(),",
        "  created_at_utc: new Date().toISOString()",
        "}, null, 2) + '\\n', 'utf8');",
        "setTimeout(() => {",
        "  try { fs.rmSync(lockPath, { recursive: true, force: true }); } catch {}",
        "  process.exit(0);",
        "}, holdMs);"
    ].join('\n');

    const child = spawn(process.execPath, [
        '--input-type=commonjs',
        '--eval',
        workerScript,
        lockPath,
        String(holdMs)
    ], {
        stdio: ['ignore', 'ignore', 'pipe']
    });

    let stderr = '';
    child.stderr.on('data', (chunk) => {
        stderr += String(chunk);
    });

    await new Promise<void>((resolve, reject) => {
        const deadline = Date.now() + 1000;
        const timer = setInterval(() => {
            if (fs.existsSync(path.join(lockPath, 'owner.json'))) {
                clearInterval(timer);
                resolve();
                return;
            }
            if (Date.now() >= deadline) {
                clearInterval(timer);
                reject(new Error(stderr || 'Timed out waiting for review-artifact lock holder'));
            }
        }, 10);
        child.once('error', (error) => {
            clearInterval(timer);
            reject(error);
        });
        child.once('exit', (code) => {
            if (!fs.existsSync(path.join(lockPath, 'owner.json')) && code !== 0) {
                clearInterval(timer);
                reject(new Error(stderr || `review-artifact lock holder exited with code ${code}`));
            }
        });
    });

    return async function cleanup(): Promise<void> {
        if (!child.killed && child.exitCode === null) {
            child.kill();
        }
        await new Promise<void>((resolve) => {
            child.once('exit', () => resolve());
            setTimeout(resolve, 250);
        });
    };
}

function resolveReviewArtifactsModulePath(): string {
    return path.resolve(__dirname, '../../../src/gate-runtime/review/review-artifacts.js');
}

function startReviewPublicationWorker(
    reviewsDir: string,
    artifactPath: string,
    startSignalPath: string,
    resultPath: string,
    options: { lowNoiseRuntimeWrites?: boolean } = {}
): Promise<{ code: number | null; stderr: string }> {
    const workerScript = [
        "const fs = require('node:fs');",
        "const { writeReviewArtifactText } = require(process.argv[1]);",
        'const reviewsDir = process.argv[2];',
        'const artifactPath = process.argv[3];',
        'const startSignalPath = process.argv[4];',
        'const resultPath = process.argv[5];',
        "const lowNoiseRuntimeWrites = process.argv[6] === 'true';",
        'const sleeper = new Int32Array(new SharedArrayBuffer(4));',
        'while (!fs.existsSync(startSignalPath)) { Atomics.wait(sleeper, 0, 0, 2); }',
        'try {',
        "  writeReviewArtifactText(artifactPath, 'published\\n', {",
        '    lockTimeoutMs: 300,',
        '    lockRetryMs: 5,',
        '    lowNoiseRuntimeWrites',
        '  });',
        "  fs.writeFileSync(resultPath, JSON.stringify({ status: 'ok' }), 'utf8');",
        '} catch (error) {',
        "  fs.writeFileSync(resultPath, JSON.stringify({ status: 'error', message: String(error && error.message || error) }), 'utf8');",
        '  process.exitCode = 1;',
        '}',
        'void reviewsDir;'
    ].join('\n');
    const child = spawn(process.execPath, [
        '--input-type=commonjs',
        '--eval',
        workerScript,
        resolveReviewArtifactsModulePath(),
        reviewsDir,
        artifactPath,
        startSignalPath,
        resultPath,
        String(options.lowNoiseRuntimeWrites === true)
    ], {
        stdio: ['ignore', 'ignore', 'pipe']
    });
    return new Promise((resolve, reject) => {
        let stderr = '';
        child.stderr.on('data', (chunk) => {
            stderr += String(chunk);
        });
        child.once('error', reject);
        child.once('close', (code) => resolve({ code, stderr }));
    });
}

function waitForFileSync(filePath: string, timeoutMs: number): void {
    const sleeper = new Int32Array(new SharedArrayBuffer(4));
    const deadline = Date.now() + timeoutMs;
    while (!fs.existsSync(filePath)) {
        if (Date.now() >= deadline) {
            throw new Error(`Timed out waiting for ${filePath}`);
        }
        Atomics.wait(sleeper, 0, 0, 5);
    }
}

test('writeReviewArtifactJson writes JSON and cleans up the transient lock', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-artifact-'));
    const artifactPath = path.join(tempDir, 'T-001-task-mode.json');

    writeReviewArtifactJson(artifactPath, {
        task_id: 'T-001',
        status: 'PASSED'
    });

    assert.deepEqual(JSON.parse(fs.readFileSync(artifactPath, 'utf8')), {
        task_id: 'T-001',
        status: 'PASSED'
    });
    assert.equal(fs.existsSync(getReviewArtifactLockPath(artifactPath)), false);
    assert.deepEqual(listTempArtifacts(tempDir), []);

    fs.rmSync(tempDir, { recursive: true, force: true });
});

test('writeReviewArtifactJson redacts secret values before persisting artifacts', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-artifact-redaction-'));
    const artifactPath = path.join(tempDir, 'T-001-security.json');

    try {
        const payload = {
            task_id: 'T-001',
            auth_token: 'tok-live-value',
            command_output: 'Authorization: Bearer ghp_abcdefghijklmnopqrstuvwxyz123456',
            location: 'src/gates/review-context/review-context-token-economy.ts:54'
        };
        writeReviewArtifactJson(artifactPath, payload);

        const artifactText = fs.readFileSync(artifactPath, 'utf8');
        assert.doesNotMatch(artifactText, /tok-live-value/);
        assert.doesNotMatch(artifactText, /abcdefghijklmnopqrstuvwxyz123456/);
        assert.match(artifactText, /<redacted>/);
        assert.match(artifactText, /review-context-token-economy\.ts:54/);
        assert.equal(fileSha256(artifactPath), sha256RedactedJsonPayload(payload));
        assert.doesNotThrow(() => assertReviewArtifactFileSha256(
            artifactPath,
            sha256RedactedJsonPayload(payload),
            'Test review artifact'
        ));
        assert.throws(
            () => assertReviewArtifactFileSha256(artifactPath, '0'.repeat(64), 'Test review artifact'),
            /sha256 mismatch after persistence/
        );
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('review artifact JSON writers preserve valid escaping for redacted source assignments', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-artifact-json-escaping-'));
    const reviewsDir = createReviewsDir(tempDir);
    const directPath = path.join(reviewsDir, 'T-001-code-remediation-baseline.json');
    const transactionalPath = path.join(reviewsDir, 'T-001-code-remediation-baseline-snapshot.json');
    const sourceLine = 'const match = html.match(/const actionToken = "([^"]+)";/u);\n';
    const payload = { redacted_lines: [redactSecretText(sourceLine)] };

    try {
        writeReviewArtifactJson(directPath, payload);
        await writeReviewArtifactsWithRollback([{
            artifactPath: transactionalPath,
            contentType: 'json',
            payload
        }], async () => undefined);

        for (const artifactPath of [directPath, transactionalPath]) {
            assert.deepEqual(JSON.parse(fs.readFileSync(artifactPath, 'utf8')), payload);
            assert.equal(fileSha256(artifactPath), sha256RedactedJsonPayload(payload));
        }
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('writeReviewArtifactText replaces existing content without leaving temp files', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-artifact-'));
    const artifactPath = path.join(tempDir, 'T-002-review-output.log');
    fs.writeFileSync(artifactPath, 'old content\n', 'utf8');

    writeReviewArtifactText(artifactPath, 'new content\n');

    assert.equal(fs.readFileSync(artifactPath, 'utf8'), 'new content\n');
    assert.equal(fs.existsSync(getReviewArtifactLockPath(artifactPath)), false);
    assert.deepEqual(listTempArtifacts(tempDir), []);

    fs.rmSync(tempDir, { recursive: true, force: true });
});

test('writeReviewArtifactText redacts secrets from free-form output', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-artifact-text-redaction-'));
    const artifactPath = path.join(tempDir, 'T-002-review-output.log');

    try {
        writeReviewArtifactText(artifactPath, 'NPM_TOKEN=npm_abcdefghijklmnopqrstuvwxyz123456\n');
        const artifactText = fs.readFileSync(artifactPath, 'utf8');
        assert.doesNotMatch(artifactText, /abcdefghijklmnopqrstuvwxyz123456/);
        assert.equal(artifactText, 'NPM_TOKEN=<redacted>\n');
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('writeReviewArtifactText reports review index update status', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-artifact-index-status-'));
    const reviewsDir = createReviewsDir(tempDir);
    const artifactPath = path.join(reviewsDir, 'T-011-code.md');

    try {
        const result = writeReviewArtifactText(artifactPath, 'REVIEW PASSED\n');

        assert.equal(result.index_update_status, 'updated');
        assert.ok(result.index_path.endsWith('/runtime/reviews/reviews-index.json') || result.index_path.endsWith('\\runtime\\reviews\\reviews-index.json'));
        const index = loadIndex(reviewsDir).index;
        assert.ok(index.entries.some((entry) => entry.fileName === 'T-011-code.md'));
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('writeReviewArtifactText low-noise mode writes artifacts but skips opportunistic review index persistence', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-artifact-low-noise-'));
    const reviewsDir = createReviewsDir(tempDir);
    const artifactPath = path.join(reviewsDir, 'T-011-low-noise-code.md');
    const previousEnv = process.env.GARDA_LOW_NOISE_RUNTIME_WRITES;

    try {
        const result = writeReviewArtifactText(
            artifactPath,
            'REVIEW PASSED\n',
            { lowNoiseRuntimeWrites: true }
        );

        assert.equal(result.index_update_status, 'skipped_low_noise');
        assert.equal(fs.readFileSync(artifactPath, 'utf8'), 'REVIEW PASSED\n');
        assert.equal(fs.existsSync(resolveIndexPath(reviewsDir)), false);

        process.env.GARDA_LOW_NOISE_RUNTIME_WRITES = '1';
        const loaded = loadIndex(reviewsDir);
        assert.equal(loaded.source, 'rebuilt');
        assert.ok(loaded.index.entries.some((entry) => entry.fileName === 'T-011-low-noise-code.md'));
        assert.equal(fs.existsSync(resolveIndexPath(reviewsDir)), false);
    } finally {
        if (previousEnv === undefined) {
            delete process.env.GARDA_LOW_NOISE_RUNTIME_WRITES;
        } else {
            process.env.GARDA_LOW_NOISE_RUNTIME_WRITES = previousEnv;
        }
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('writeReviewArtifactText low-noise mode still persists indexes for critical review writes', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-artifact-low-noise-critical-'));
    const reviewsDir = createReviewsDir(tempDir);
    const artifactPath = path.join(reviewsDir, 'T-011-low-noise-critical-code.md');

    try {
        const result = writeReviewArtifactText(
            artifactPath,
            'REVIEW PASSED\n',
            { lowNoiseRuntimeWrites: true, requireIndexUpdate: true }
        );

        assert.equal(result.index_update_status, 'updated');
        assert.equal(fs.existsSync(resolveIndexPath(reviewsDir)), true);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('writeReviewArtifactText surfaces index failures and rolls back critical writes', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-artifact-index-failure-'));
    const reviewsDir = createReviewsDir(tempDir);
    const artifactPath = path.join(reviewsDir, 'T-012-code.md');
    const criticalArtifactPath = path.join(reviewsDir, 'T-012-test.md');
    const indexLockPath = resolveIndexLockPath(reviewsDir);

    try {
        fs.mkdirSync(indexLockPath, { recursive: true });
        fs.writeFileSync(path.join(indexLockPath, 'owner.json'), JSON.stringify({
            pid: process.pid,
            hostname: os.hostname(),
            created_at_utc: new Date().toISOString()
        }, null, 2) + '\n', 'utf8');

        const result = writeReviewArtifactText(
            artifactPath,
            'REVIEW PASSED\n',
            { lockTimeoutMs: 75, lockRetryMs: 10 }
        );

        assert.equal(result.index_update_status, 'failed');
        assert.match(result.index_update_error || '', /file lock/);
        assert.equal(fs.readFileSync(artifactPath, 'utf8'), 'REVIEW PASSED\n');

        assert.throws(
            () => writeReviewArtifactText(
                criticalArtifactPath,
                'REVIEW PASSED\n',
                { lockTimeoutMs: 75, lockRetryMs: 10, requireIndexUpdate: true }
            ),
            /Review artifact index update failed/
        );
        assert.equal(fs.existsSync(criticalArtifactPath), false);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('writeReviewArtifactJson fails when a live review-artifact lock already exists', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-artifact-'));
    const artifactPath = path.join(tempDir, 'T-003-preflight.json');
    const lockPath = getReviewArtifactLockPath(artifactPath);
    fs.mkdirSync(lockPath, { recursive: true });
    fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
        pid: process.pid,
        hostname: os.hostname(),
        created_at_utc: new Date().toISOString()
    }, null, 2) + '\n', 'utf8');

    assert.throws(
        () => writeReviewArtifactJson(
            artifactPath,
            { task_id: 'T-003' },
            { lockTimeoutMs: 75, lockRetryMs: 10 }
        ),
        /Timed out acquiring file lock/
    );
    assert.equal(fs.existsSync(artifactPath), false);

    fs.rmSync(tempDir, { recursive: true, force: true });
});

test('writeReviewArtifactJson waits for a short-lived external review-artifact lock', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-artifact-'));
    const artifactPath = path.join(tempDir, 'T-004-preflight.json');
    const lockPath = getReviewArtifactLockPath(artifactPath);
    let cleanupChild: (() => Promise<void>) | null = null;

    try {
        cleanupChild = await holdReviewArtifactLock(lockPath, 120);
        const startedAt = Date.now();
        writeReviewArtifactJson(
            artifactPath,
            { task_id: 'T-004', status: 'PASSED' },
            { lockTimeoutMs: 1000, lockRetryMs: 20, lockStaleMs: 60000 }
        );
        const elapsedMs = Date.now() - startedAt;

        assert.ok(elapsedMs >= 80, `sync review-artifact write should wait for brief contention, got ${elapsedMs} ms`);
        assert.deepEqual(JSON.parse(fs.readFileSync(artifactPath, 'utf8')), {
            task_id: 'T-004',
            status: 'PASSED'
        });
        assert.equal(fs.existsSync(lockPath), false);
    } finally {
        if (cleanupChild) {
            await cleanupChild();
        }
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('writeReviewArtifactJson does not reclaim aged foreign-host review-artifact lock without explicit override', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-artifact-'));
    const artifactPath = path.join(tempDir, 'T-005-preflight.json');
    const lockPath = getReviewArtifactLockPath(artifactPath);
    const previousEnv = process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS;
    delete process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS;
    try {
        fs.mkdirSync(lockPath, { recursive: true });
        const ownerPath = path.join(lockPath, 'owner.json');
        fs.writeFileSync(ownerPath, JSON.stringify({
            pid: 999999999,
            hostname: 'remote-build-host',
            created_at_utc: new Date().toISOString()
        }, null, 2) + '\n', 'utf8');
        const oldTime = new Date(Date.now() - (31 * 60 * 1000));
        fs.utimesSync(ownerPath, oldTime, oldTime);
        fs.utimesSync(lockPath, oldTime, oldTime);

        assert.throws(
            () => writeReviewArtifactJson(
                artifactPath,
                { task_id: 'T-005', status: 'PASSED' },
                { lockTimeoutMs: 75, lockRetryMs: 10 }
            ),
            /GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS=1/
        );
        assert.equal(fs.existsSync(artifactPath), false);
        assert.equal(fs.existsSync(lockPath), true);
    } finally {
        if (previousEnv === undefined) {
            delete process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS;
        } else {
            process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS = previousEnv;
        }
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('writeReviewArtifactJson reclaims aged foreign-host review-artifact lock when explicit override is enabled', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-artifact-'));
    const artifactPath = path.join(tempDir, 'T-005-preflight.json');
    const lockPath = getReviewArtifactLockPath(artifactPath);
    const previousEnv = process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS;
    process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS = '1';
    try {
        fs.mkdirSync(lockPath, { recursive: true });
        const ownerPath = path.join(lockPath, 'owner.json');
        fs.writeFileSync(ownerPath, JSON.stringify({
            pid: 999999999,
            hostname: 'remote-build-host',
            created_at_utc: new Date().toISOString()
        }, null, 2) + '\n', 'utf8');
        const oldTime = new Date(Date.now() - (31 * 60 * 1000));
        fs.utimesSync(ownerPath, oldTime, oldTime);
        fs.utimesSync(lockPath, oldTime, oldTime);

        writeReviewArtifactJson(
            artifactPath,
            { task_id: 'T-005', status: 'PASSED' },
            { lockTimeoutMs: 500, lockRetryMs: 10 }
        );

        assert.deepEqual(JSON.parse(fs.readFileSync(artifactPath, 'utf8')), {
            task_id: 'T-005',
            status: 'PASSED'
        });
        assert.equal(fs.existsSync(lockPath), false);
    } finally {
        if (previousEnv === undefined) {
            delete process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS;
        } else {
            process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS = previousEnv;
        }
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('writeReviewArtifactJson does not reclaim fresh foreign-host review-artifact lock', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-artifact-'));
    const artifactPath = path.join(tempDir, 'T-006-preflight.json');
    const lockPath = getReviewArtifactLockPath(artifactPath);
    try {
        fs.mkdirSync(lockPath, { recursive: true });
        fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
            pid: 999999999,
            hostname: 'remote-build-host',
            created_at_utc: new Date().toISOString()
        }, null, 2) + '\n', 'utf8');

        assert.throws(
            () => writeReviewArtifactJson(
                artifactPath,
                { task_id: 'T-006', status: 'PASSED' },
                { lockTimeoutMs: 75, lockRetryMs: 10, lockStaleMs: 60_000 }
            ),
            /Timed out acquiring file lock/
        );
        assert.equal(fs.existsSync(artifactPath), false);
        assert.equal(fs.existsSync(lockPath), true);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('scanReviewArtifactLocks reports active and stale review-artifact locks with task binding', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-artifact-scan-'));
    const reviewsDir = path.join(tempDir, 'runtime', 'reviews');
    const activeLockPath = path.join(reviewsDir, 'T-007-code.md.lock');
    const staleLockPath = path.join(reviewsDir, 'T-008-preflight.json.lock');

    try {
        fs.mkdirSync(activeLockPath, { recursive: true });
        fs.writeFileSync(path.join(activeLockPath, 'owner.json'), JSON.stringify({
            pid: process.pid,
            hostname: os.hostname(),
            created_at_utc: new Date().toISOString()
        }, null, 2) + '\n', 'utf8');

        fs.mkdirSync(staleLockPath, { recursive: true });
        const staleOwnerPath = path.join(staleLockPath, 'owner.json');
        fs.writeFileSync(staleOwnerPath, JSON.stringify({
            pid: 999999999,
            hostname: os.hostname(),
            created_at_utc: '2026-03-30T10:00:00.000Z'
        }, null, 2) + '\n', 'utf8');
        const oldTime = new Date(Date.now() - (31 * 60 * 1000));
        fs.utimesSync(staleOwnerPath, oldTime, oldTime);
        fs.utimesSync(staleLockPath, oldTime, oldTime);

        const result = scanReviewArtifactLocks(tempDir);
        assert.equal(result.lock_root, reviewsDir.replace(/\\/g, '/'));
        assert.equal(result.active_count, 1);
        assert.equal(result.stale_count, 1);
        assert.equal(result.locks.length, 2);

        const activeLock = result.locks.find((lock) => lock.lock_name === 'T-007-code.md.lock');
        assert.ok(activeLock, 'expected active review-artifact lock to be reported');
        assert.equal(activeLock!.task_id, 'T-007');
        assert.equal(activeLock!.artifact_type, 'code.md');
        assert.equal(activeLock!.status, 'ACTIVE');

        const staleLock = result.locks.find((lock) => lock.lock_name === 'T-008-preflight.json.lock');
        assert.ok(staleLock, 'expected stale review-artifact lock to be reported');
        assert.equal(staleLock!.task_id, 'T-008');
        assert.equal(staleLock!.artifact_type, 'preflight.json');
        assert.equal(staleLock!.status, 'STALE');
        assert.ok(staleLock!.remediation.includes('doctor --target-root "." --cleanup-stale-locks --dry-run'));
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('cleanupStaleReviewArtifactLocks removes only proven-stale review-artifact locks', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-artifact-cleanup-'));
    const reviewsDir = path.join(tempDir, 'runtime', 'reviews');
    const activeLockPath = path.join(reviewsDir, 'T-009-test.md.lock');
    const staleLockPath = path.join(reviewsDir, 'T-009-preflight.json.lock');

    try {
        fs.mkdirSync(activeLockPath, { recursive: true });
        fs.writeFileSync(path.join(activeLockPath, 'owner.json'), JSON.stringify({
            pid: process.pid,
            hostname: os.hostname(),
            created_at_utc: new Date().toISOString()
        }, null, 2) + '\n', 'utf8');

        fs.mkdirSync(staleLockPath, { recursive: true });
        const staleOwnerPath = path.join(staleLockPath, 'owner.json');
        fs.writeFileSync(staleOwnerPath, JSON.stringify({
            pid: 999999999,
            hostname: os.hostname(),
            created_at_utc: '2026-03-30T10:00:00.000Z'
        }, null, 2) + '\n', 'utf8');
        const oldTime = new Date(Date.now() - (31 * 60 * 1000));
        fs.utimesSync(staleOwnerPath, oldTime, oldTime);
        fs.utimesSync(staleLockPath, oldTime, oldTime);

        const dryRun = cleanupStaleReviewArtifactLocks(tempDir, { dryRun: true });
        assert.deepEqual(dryRun.removable_stale_locks, ['T-009-preflight.json.lock']);
        assert.deepEqual(dryRun.removed_locks, []);
        assert.ok(fs.existsSync(staleLockPath), 'dry-run must not remove stale review-artifact locks');

        const applied = cleanupStaleReviewArtifactLocks(tempDir, { dryRun: false });
        assert.deepEqual(applied.removed_locks, ['T-009-preflight.json.lock']);
        assert.ok(fs.existsSync(activeLockPath), 'active review-artifact lock must be preserved');
        assert.equal(fs.existsSync(staleLockPath), false, 'stale review-artifact lock should be removed');
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('cleanupStaleReviewArtifactLocks retains aged foreign-host review-artifact locks without explicit override', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-artifact-foreign-cleanup-'));
    const reviewsDir = path.join(tempDir, 'runtime', 'reviews');
    const lockPath = path.join(reviewsDir, 'T-010-code.md.lock');
    const previousEnv = process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS;
    delete process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS;

    try {
        fs.mkdirSync(lockPath, { recursive: true });
        const ownerPath = path.join(lockPath, 'owner.json');
        fs.writeFileSync(ownerPath, JSON.stringify({
            pid: 999999999,
            hostname: 'remote-build-host',
            created_at_utc: new Date().toISOString()
        }, null, 2) + '\n', 'utf8');
        const oldTime = new Date(Date.now() - (31 * 60 * 1000));
        fs.utimesSync(ownerPath, oldTime, oldTime);
        fs.utimesSync(lockPath, oldTime, oldTime);

        const result = cleanupStaleReviewArtifactLocks(tempDir, { dryRun: false });
        assert.deepEqual(result.removed_locks, []);
        assert.ok(result.retained_live_locks.includes('T-010-code.md.lock'));
        assert.ok(result.warnings.some((warning) => warning.includes('GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS=1')));
        assert.equal(fs.existsSync(lockPath), true, 'cleanup must preserve aged foreign-host review-artifact lock without explicit override');
    } finally {
        if (previousEnv === undefined) {
            delete process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS;
        } else {
            process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS = previousEnv;
        }
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('scanReviewArtifactLocks includes the shared reviews-index lock', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-index-lock-scan-'));
    const runtimeDir = path.join(tempDir, 'runtime');
    const indexLockPath = path.join(runtimeDir, '.reviews-index.lock');

    try {
        fs.mkdirSync(indexLockPath, { recursive: true });
        const ownerPath = path.join(indexLockPath, 'owner.json');
        fs.writeFileSync(ownerPath, JSON.stringify({
            pid: 999999999,
            hostname: os.hostname(),
            created_at_utc: '2026-03-30T10:00:00.000Z'
        }, null, 2) + '\n', 'utf8');
        const oldTime = new Date(Date.now() - (31 * 60 * 1000));
        fs.utimesSync(ownerPath, oldTime, oldTime);
        fs.utimesSync(indexLockPath, oldTime, oldTime);

        const result = scanReviewArtifactLocks(tempDir);
        const sharedLock = result.locks.find((lock) => lock.lock_name === '.reviews-index.lock');
        assert.ok(sharedLock, 'expected shared reviews-index lock to be reported');
        assert.equal(sharedLock!.task_id, null);
        assert.equal(sharedLock!.artifact_type, 'reviews-index');
        assert.equal(sharedLock!.status, 'STALE');
        assert.ok(sharedLock!.artifact_path.endsWith('/runtime/reviews/reviews-index.json'));
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('scanReviewArtifactLocks includes the shared reviews transaction lock', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-transaction-lock-scan-'));
    const reviewsDir = createReviewsDir(tempDir);
    const transactionLockPath = getReviewArtifactTransactionLockPath(reviewsDir);

    try {
        fs.mkdirSync(transactionLockPath, { recursive: true });
        const ownerPath = path.join(transactionLockPath, 'owner.json');
        fs.writeFileSync(ownerPath, JSON.stringify({
            pid: 999999999,
            hostname: os.hostname(),
            created_at_utc: '2026-03-30T10:00:00.000Z'
        }, null, 2) + '\n', 'utf8');
        const oldTime = new Date(Date.now() - (31 * 60 * 1000));
        fs.utimesSync(ownerPath, oldTime, oldTime);
        fs.utimesSync(transactionLockPath, oldTime, oldTime);

        const result = scanReviewArtifactLocks(tempDir);
        const sharedLock = result.locks.find((lock) => lock.lock_name === '.reviews-transaction.lock');
        assert.ok(sharedLock, 'expected shared reviews transaction lock to be reported');
        assert.equal(sharedLock!.task_id, null);
        assert.equal(sharedLock!.artifact_type, 'reviews-transaction');
        assert.equal(sharedLock!.status, 'STALE');
        assert.ok(sharedLock!.artifact_path.endsWith('/runtime/reviews'));
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('loadIndex waits for a live review artifact transaction lock before rebuilding', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-transaction-read-barrier-'));
    const reviewsDir = createReviewsDir(tempDir);
    const transactionLockPath = getReviewArtifactTransactionLockPath(reviewsDir);
    let cleanupChild: (() => Promise<void>) | null = null;

    try {
        cleanupChild = await holdReviewArtifactLock(transactionLockPath, 140);
        const startedAt = Date.now();
        const result = loadIndex(reviewsDir);
        const elapsedMs = Date.now() - startedAt;

        assert.ok(elapsedMs >= 90, `index load should wait for transaction lock, got ${elapsedMs} ms`);
        assert.equal(result.source, 'rebuilt');
    } finally {
        if (cleanupChild) {
            await cleanupChild();
        }
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('loadIndex waits for the transaction lock before returning a fresh cache hit', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-transaction-cache-barrier-'));
    const reviewsDir = createReviewsDir(tempDir);
    const transactionLockPath = getReviewArtifactTransactionLockPath(reviewsDir);
    let cleanupChild: (() => Promise<void>) | null = null;

    try {
        writeReviewArtifactText(path.join(reviewsDir, 'T-016-code.md'), 'REVIEW PASSED\n');
        const warmCache = loadIndex(reviewsDir);
        assert.equal(warmCache.source, 'cache');

        cleanupChild = await holdReviewArtifactLock(transactionLockPath, 140);
        const startedAt = Date.now();
        const result = loadIndex(reviewsDir);
        const elapsedMs = Date.now() - startedAt;

        assert.ok(elapsedMs >= 90, `cache-hit index load should wait for transaction lock, got ${elapsedMs} ms`);
        assert.equal(result.source, 'cache');
    } finally {
        if (cleanupChild) {
            await cleanupChild();
        }
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('loadIndex read-only mode does not create a transaction lock when no transaction is active', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-readonly-index-'));
    const reviewsDir = createReviewsDir(tempDir);
    const transactionLockPath = getReviewArtifactTransactionLockPath(reviewsDir);

    try {
        const result = loadIndex(reviewsDir, { readOnly: true });

        assert.equal(result.source, 'rebuilt');
        assert.equal(fs.existsSync(transactionLockPath), false);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('loadIndex uses the in-process pre-transaction snapshot during an async review transaction', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-transaction-snapshot-'));
    const reviewsDir = createReviewsDir(tempDir);
    const existingPath = path.join(reviewsDir, 'T-019-code.md');
    const newPath = path.join(reviewsDir, 'T-020-code.md');

    try {
        writeReviewArtifactText(existingPath, 'old review\n');
        loadIndex(reviewsDir);

        await writeReviewArtifactsWithRollback([
            {
                artifactPath: newPath,
                contentType: 'text',
                content: 'new review\n'
            }
        ], async () => {
            const duringTransaction = loadIndex(reviewsDir).index;
            assert.equal(duringTransaction.entries.some((entry) => entry.fileName === 'T-019-code.md'), true);
            assert.equal(duringTransaction.entries.some((entry) => entry.fileName === 'T-020-code.md'), false);
            return 'done';
        });

        const committed = loadIndex(reviewsDir).index;
        assert.equal(committed.entries.some((entry) => entry.fileName === 'T-020-code.md'), true);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('withReviewArtifactReadBarrier waits for a live external review transaction lock', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-read-barrier-'));
    const reviewsDir = createReviewsDir(tempDir);
    const transactionLockPath = getReviewArtifactTransactionLockPath(reviewsDir);
    let cleanupChild: (() => Promise<void>) | null = null;

    try {
        cleanupChild = await holdReviewArtifactLock(transactionLockPath, 120);
        const startedAt = Date.now();

        const result = withReviewArtifactReadBarrier(reviewsDir, () => 'read-complete', {
            lockTimeoutMs: 1_000,
            lockRetryMs: 10
        });

        assert.equal(result, 'read-complete');
        assert.ok(Date.now() - startedAt >= 90);
    } finally {
        if (cleanupChild) {
            await cleanupChild();
        }
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('slow review reads release the transaction lock before concurrent publication', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-short-read-lock-'));
    const reviewsDir = createReviewsDir(tempDir);
    const existingPath = path.join(reviewsDir, 'T-022-code.md');
    const publicationPath = path.join(reviewsDir, 'T-022-test.md');
    const startSignalPath = path.join(tempDir, 'publish.start');
    const resultPath = path.join(tempDir, 'publish.result.json');
    try {
        writeReviewArtifactText(existingPath, 'existing\n');
        const publication = startReviewPublicationWorker(
            reviewsDir,
            publicationPath,
            startSignalPath,
            resultPath
        );
        const startedAt = Date.now();
        assert.throws(
            () => withReviewArtifactReadBarrier(reviewsDir, () => {
                assert.equal(readReviewArtifactTextFile(existingPath), 'existing\n');
                fs.writeFileSync(startSignalPath, 'go\n', 'utf8');
                waitForFileSync(resultPath, 2_000);
                const publicationResult = JSON.parse(fs.readFileSync(resultPath, 'utf8')) as {
                    status: string;
                    message?: string;
                };
                assert.deepEqual(publicationResult, { status: 'ok' });
                Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 450);
            }, {
                lockTimeoutMs: 1_000,
                lockRetryMs: 5
            }),
            /invalidated by a concurrent review publication/
        );
        const workerResult = await publication;
        assert.equal(workerResult.code, 0, workerResult.stderr);
        assert.ok(Date.now() - startedAt < 2_000);
        assert.equal(fs.readFileSync(publicationPath, 'utf8'), 'published\n');
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('review read barrier accepts a transaction-owned publication after revalidating its generation', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-read-self-publication-'));
    const reviewsDir = createReviewsDir(tempDir);
    const existingPath = path.join(reviewsDir, 'T-022-code.md');
    const publicationPath = path.join(reviewsDir, 'T-022-test.md');
    try {
        writeReviewArtifactText(existingPath, 'existing\n');

        const result = withReviewArtifactReadBarrier(reviewsDir, () => {
            assert.equal(readReviewArtifactTextFile(existingPath), 'existing\n');
            writeReviewArtifactText(publicationPath, 'published\n');
            return 'publication-complete';
        });

        assert.equal(result, 'publication-complete');
        assert.equal(fs.readFileSync(publicationPath, 'utf8'), 'published\n');
        assert.equal(
            loadIndex(reviewsDir).index.entries.some((entry) => entry.fileName === path.basename(publicationPath)),
            true
        );
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('review read barrier rejects an external publication before a transaction-owned write starts', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-read-external-before-self-'));
    const reviewsDir = createReviewsDir(tempDir);
    const existingPath = path.join(reviewsDir, 'T-022-code.md');
    const externalPublicationPath = path.join(reviewsDir, 'T-022-test.md');
    const ownPublicationPath = path.join(reviewsDir, 'T-022-security.md');
    const startSignalPath = path.join(tempDir, 'publish.start');
    const resultPath = path.join(tempDir, 'publish.result.json');
    try {
        writeReviewArtifactText(existingPath, 'existing\n');
        const publication = startReviewPublicationWorker(
            reviewsDir,
            externalPublicationPath,
            startSignalPath,
            resultPath
        );

        assert.throws(
            () => withReviewArtifactReadBarrier(reviewsDir, () => {
                assert.equal(readReviewArtifactTextFile(existingPath), 'existing\n');
                fs.writeFileSync(startSignalPath, 'go\n', 'utf8');
                waitForFileSync(resultPath, 2_000);
                writeReviewArtifactText(ownPublicationPath, 'must not be written\n');
            }, {
                lockTimeoutMs: 1_000,
                lockRetryMs: 5
            }),
            /invalidated by a concurrent review publication/
        );
        const workerResult = await publication;
        assert.equal(workerResult.code, 0, workerResult.stderr);
        assert.equal(fs.existsSync(ownPublicationPath), false);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('review read barrier rejects a low-noise physical-root publication before an alias-root write', async (t) => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-read-alias-publication-'));
    const reviewsDir = createReviewsDir(path.join(tempDir, 'physical'));
    const aliasReviewsDir = path.join(tempDir, 'reviews-alias');
    const existingPath = path.join(aliasReviewsDir, 'T-022-code.md');
    const externalPublicationPath = path.join(reviewsDir, 'T-022-test.md');
    const ownPublicationPath = path.join(aliasReviewsDir, 'T-022-security.md');
    const startSignalPath = path.join(tempDir, 'publish.start');
    const resultPath = path.join(tempDir, 'publish.result.json');
    try {
        try {
            fs.symlinkSync(reviewsDir, aliasReviewsDir, process.platform === 'win32' ? 'junction' : 'dir');
        } catch {
            t.skip('Directory symlink or junction creation is unavailable in this environment.');
            return;
        }
        writeReviewArtifactText(existingPath, 'existing\n');
        const publication = startReviewPublicationWorker(
            reviewsDir,
            externalPublicationPath,
            startSignalPath,
            resultPath,
            { lowNoiseRuntimeWrites: true }
        );

        assert.throws(
            () => withReviewArtifactReadBarrier(aliasReviewsDir, () => {
                assert.equal(readReviewArtifactTextFile(existingPath), 'existing\n');
                fs.writeFileSync(startSignalPath, 'go\n', 'utf8');
                waitForFileSync(resultPath, 2_000);
                writeReviewArtifactText(ownPublicationPath, 'must not be written\n');
            }, {
                lockTimeoutMs: 1_000,
                lockRetryMs: 5
            }),
            /invalidated by a concurrent review publication/
        );
        const workerResult = await publication;
        assert.equal(workerResult.code, 0, workerResult.stderr);
        assert.equal(fs.existsSync(externalPublicationPath), true);
        assert.equal(fs.existsSync(ownPublicationPath), false);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('nested alias-root barriers preserve external-before-own publication protection', async (t) => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-read-nested-alias-'));
    const reviewsDir = createReviewsDir(path.join(tempDir, 'physical'));
    const aliasReviewsDir = path.join(tempDir, 'reviews-alias');
    const existingPath = path.join(aliasReviewsDir, 'T-022-code.md');
    const externalPublicationPath = path.join(reviewsDir, 'T-022-test.md');
    const ownPublicationPath = path.join(aliasReviewsDir, 'T-022-security.md');
    const startSignalPath = path.join(tempDir, 'publish.start');
    const resultPath = path.join(tempDir, 'publish.result.json');
    try {
        try {
            fs.symlinkSync(reviewsDir, aliasReviewsDir, process.platform === 'win32' ? 'junction' : 'dir');
        } catch {
            t.skip('Directory symlink or junction creation is unavailable in this environment.');
            return;
        }
        writeReviewArtifactText(existingPath, 'existing\n');
        const publication = startReviewPublicationWorker(
            reviewsDir,
            externalPublicationPath,
            startSignalPath,
            resultPath,
            { lowNoiseRuntimeWrites: true }
        );

        assert.throws(
            () => withReviewArtifactReadBarrier(aliasReviewsDir, () => {
                withReviewArtifactReadBarrier(aliasReviewsDir, () => {
                    assert.equal(readReviewArtifactTextFile(existingPath), 'existing\n');
                });
                fs.writeFileSync(startSignalPath, 'go\n', 'utf8');
                waitForFileSync(resultPath, 2_000);
                writeReviewArtifactText(ownPublicationPath, 'must not be written\n');
            }, {
                lockTimeoutMs: 1_000,
                lockRetryMs: 5
            }),
            /invalidated by a concurrent review publication/
        );
        const workerResult = await publication;
        assert.equal(workerResult.code, 0, workerResult.stderr);
        assert.equal(fs.existsSync(externalPublicationPath), true);
        assert.equal(fs.existsSync(ownPublicationPath), false);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('review read barrier rejects an external publication after a transaction-owned write', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-read-self-before-external-'));
    const reviewsDir = createReviewsDir(tempDir);
    const ownPublicationPath = path.join(reviewsDir, 'T-022-code.md');
    const externalPublicationPath = path.join(reviewsDir, 'T-022-test.md');
    const startSignalPath = path.join(tempDir, 'publish.start');
    const resultPath = path.join(tempDir, 'publish.result.json');
    try {
        const publication = startReviewPublicationWorker(
            reviewsDir,
            externalPublicationPath,
            startSignalPath,
            resultPath,
            { lowNoiseRuntimeWrites: true }
        );

        assert.throws(
            () => withReviewArtifactReadBarrier(reviewsDir, () => {
                writeReviewArtifactText(ownPublicationPath, 'owned\n');
                fs.writeFileSync(startSignalPath, 'go\n', 'utf8');
                waitForFileSync(resultPath, 2_000);
            }, {
                lockTimeoutMs: 1_000,
                lockRetryMs: 5
            }),
            /invalidated by a concurrent review publication/
        );
        const workerResult = await publication;
        assert.equal(workerResult.code, 0, workerResult.stderr);
        assert.equal(fs.readFileSync(ownPublicationPath, 'utf8'), 'owned\n');
        assert.equal(fs.readFileSync(externalPublicationPath, 'utf8'), 'published\n');
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('review read barrier accepts a transaction-owned publication when the reviews root is missing', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-read-missing-root-'));
    const reviewsDir = path.join(tempDir, 'runtime', 'reviews');
    const publicationPath = path.join(reviewsDir, 'T-022-code.md');
    try {
        assert.equal(fs.existsSync(reviewsDir), false);

        const result = withReviewArtifactReadBarrier(reviewsDir, () => {
            writeReviewArtifactText(publicationPath, 'published\n');
            return 'publication-complete';
        });

        assert.equal(result, 'publication-complete');
        assert.equal(fs.readFileSync(publicationPath, 'utf8'), 'published\n');
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('missing alias-root barrier rejects external publication before a second transaction-owned write', async (t) => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-read-missing-alias-'));
    const physicalRuntimeDir = path.join(tempDir, 'physical-runtime');
    const aliasRuntimeDir = path.join(tempDir, 'runtime-alias');
    const reviewsDir = path.join(physicalRuntimeDir, 'reviews');
    const aliasReviewsDir = path.join(aliasRuntimeDir, 'reviews');
    const firstOwnPublicationPath = path.join(aliasReviewsDir, 'T-022-code.md');
    const externalPublicationPath = path.join(reviewsDir, 'T-022-test.md');
    const secondOwnPublicationPath = path.join(aliasReviewsDir, 'T-022-security.md');
    const startSignalPath = path.join(tempDir, 'publish.start');
    const resultPath = path.join(tempDir, 'publish.result.json');
    try {
        fs.mkdirSync(physicalRuntimeDir, { recursive: true });
        try {
            fs.symlinkSync(physicalRuntimeDir, aliasRuntimeDir, process.platform === 'win32' ? 'junction' : 'dir');
        } catch {
            t.skip('Directory symlink or junction creation is unavailable in this environment.');
            return;
        }
        assert.equal(fs.existsSync(reviewsDir), false);
        const publication = startReviewPublicationWorker(
            reviewsDir,
            externalPublicationPath,
            startSignalPath,
            resultPath,
            { lowNoiseRuntimeWrites: true }
        );

        assert.throws(
            () => withReviewArtifactReadBarrier(aliasReviewsDir, () => {
                writeReviewArtifactText(firstOwnPublicationPath, 'owned first\n');
                fs.writeFileSync(startSignalPath, 'go\n', 'utf8');
                waitForFileSync(resultPath, 2_000);
                writeReviewArtifactText(secondOwnPublicationPath, 'must not be written\n');
            }, {
                lockTimeoutMs: 1_000,
                lockRetryMs: 5
            }),
            /invalidated by a concurrent review publication/
        );
        const workerResult = await publication;
        assert.equal(workerResult.code, 0, workerResult.stderr);
        assert.equal(fs.readFileSync(firstOwnPublicationPath, 'utf8'), 'owned first\n');
        assert.equal(fs.readFileSync(externalPublicationPath, 'utf8'), 'published\n');
        assert.equal(fs.existsSync(secondOwnPublicationPath), false);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('review read barrier rejects external publication before an async transaction-owned write', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-read-async-external-first-'));
    const reviewsDir = createReviewsDir(tempDir);
    const externalPublicationPath = path.join(reviewsDir, 'T-022-test.md');
    const ownPublicationPath = path.join(reviewsDir, 'T-022-code.md');
    const startSignalPath = path.join(tempDir, 'publish.start');
    const resultPath = path.join(tempDir, 'publish.result.json');
    try {
        const publication = startReviewPublicationWorker(
            reviewsDir,
            externalPublicationPath,
            startSignalPath,
            resultPath,
            { lowNoiseRuntimeWrites: true }
        );

        await assert.rejects(
            withReviewArtifactReadBarrier(reviewsDir, async () => {
                fs.writeFileSync(startSignalPath, 'go\n', 'utf8');
                const workerResult = await publication;
                assert.equal(workerResult.code, 0, workerResult.stderr);
                return await writeReviewArtifactsWithRollback([
                    {
                        artifactPath: ownPublicationPath,
                        contentType: 'text',
                        content: 'must not be written\n'
                    }
                ], async () => 'publication-complete');
            }, {
                lockTimeoutMs: 1_000,
                lockRetryMs: 5
            }),
            /invalidated by a concurrent review publication/
        );
        assert.equal(fs.existsSync(externalPublicationPath), true);
        assert.equal(fs.existsSync(ownPublicationPath), false);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('review read barrier accepts an async transaction-owned publication', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-read-async-self-'));
    const reviewsDir = createReviewsDir(tempDir);
    const publicationPath = path.join(reviewsDir, 'T-022-code.md');
    try {
        const result = await withReviewArtifactReadBarrier(reviewsDir, async () => (
            await writeReviewArtifactsWithRollback([
                {
                    artifactPath: publicationPath,
                    contentType: 'text',
                    content: 'published\n'
                }
            ], async () => 'publication-complete')
        ));

        assert.equal(result, 'publication-complete');
        assert.equal(fs.readFileSync(publicationPath, 'utf8'), 'published\n');
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('retargeted alias-root barrier rejects external publication before an own write', async (t) => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-read-retargeted-alias-'));
    const firstReviewsDir = createReviewsDir(path.join(tempDir, 'first'));
    const secondReviewsDir = createReviewsDir(path.join(tempDir, 'second'));
    const aliasReviewsDir = path.join(tempDir, 'reviews-alias');
    const existingPath = path.join(aliasReviewsDir, 'T-022-code.md');
    const externalPublicationPath = path.join(secondReviewsDir, 'T-022-test.md');
    const ownPublicationPath = path.join(aliasReviewsDir, 'T-022-security.md');
    const startSignalPath = path.join(tempDir, 'publish.start');
    const resultPath = path.join(tempDir, 'publish.result.json');
    const linkType = process.platform === 'win32' ? 'junction' : 'dir';
    try {
        try {
            fs.symlinkSync(firstReviewsDir, aliasReviewsDir, linkType);
            fs.unlinkSync(aliasReviewsDir);
            fs.symlinkSync(secondReviewsDir, aliasReviewsDir, linkType);
            fs.unlinkSync(aliasReviewsDir);
            fs.symlinkSync(firstReviewsDir, aliasReviewsDir, linkType);
        } catch {
            t.skip('Directory symlink or junction retargeting is unavailable in this environment.');
            return;
        }
        writeReviewArtifactText(existingPath, 'existing\n');
        const publication = startReviewPublicationWorker(
            secondReviewsDir,
            externalPublicationPath,
            startSignalPath,
            resultPath,
            { lowNoiseRuntimeWrites: true }
        );

        assert.throws(
            () => withReviewArtifactReadBarrier(aliasReviewsDir, () => {
                assert.equal(readReviewArtifactTextFile(existingPath), 'existing\n');
                fs.unlinkSync(aliasReviewsDir);
                fs.symlinkSync(secondReviewsDir, aliasReviewsDir, linkType);
                fs.writeFileSync(startSignalPath, 'go\n', 'utf8');
                waitForFileSync(resultPath, 2_000);
                writeReviewArtifactText(ownPublicationPath, 'must not be written\n');
            }, {
                lockTimeoutMs: 1_000,
                lockRetryMs: 5
            }),
            /invalidated by a concurrent review publication/
        );
        const workerResult = await publication;
        assert.equal(workerResult.code, 0, workerResult.stderr);
        assert.equal(fs.existsSync(externalPublicationPath), true);
        assert.equal(fs.existsSync(ownPublicationPath), false);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('overlapping alias and physical-root async barriers both reject a concurrent publication', async (t) => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-read-overlap-'));
    const reviewsDir = createReviewsDir(path.join(tempDir, 'physical'));
    const aliasReviewsDir = path.join(tempDir, 'reviews-alias');
    const existingPath = path.join(reviewsDir, 'T-022-code.md');
    const externalPublicationPath = path.join(reviewsDir, 'T-022-test.md');
    const startSignalPath = path.join(tempDir, 'publish.start');
    const resultPath = path.join(tempDir, 'publish.result.json');
    try {
        try {
            fs.symlinkSync(reviewsDir, aliasReviewsDir, process.platform === 'win32' ? 'junction' : 'dir');
        } catch {
            t.skip('Directory symlink or junction creation is unavailable in this environment.');
            return;
        }
        writeReviewArtifactText(existingPath, 'initial\n');
        let releaseFirstBarrier!: () => void;
        const firstBarrierHold = new Promise<void>((resolve) => {
            releaseFirstBarrier = resolve;
        });
        const firstBarrier = withReviewArtifactReadBarrier(aliasReviewsDir, async () => {
            assert.equal(readReviewArtifactTextFile(path.join(aliasReviewsDir, 'T-022-code.md')), 'initial\n');
            await firstBarrierHold;
            return 'first-complete';
        });
        const publication = startReviewPublicationWorker(
            reviewsDir,
            externalPublicationPath,
            startSignalPath,
            resultPath,
            { lowNoiseRuntimeWrites: true }
        );
        const secondBarrier = withReviewArtifactReadBarrier(reviewsDir, async () => {
            assert.equal(readReviewArtifactTextFile(existingPath), 'initial\n');
            fs.writeFileSync(startSignalPath, 'go\n', 'utf8');
            const workerResult = await publication;
            assert.equal(workerResult.code, 0, workerResult.stderr);
            return 'second-complete';
        });

        await assert.rejects(secondBarrier, /invalidated by a concurrent review publication/);
        releaseFirstBarrier();
        await assert.rejects(firstBarrier, /invalidated by a concurrent review publication/);
        assert.equal(fs.existsSync(externalPublicationPath), true);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('failing sync participant preserves protection for an overlapping async participant', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-read-mixed-overlap-'));
    const reviewsDir = createReviewsDir(tempDir);
    const externalPublicationPath = path.join(reviewsDir, 'T-022-test.md');
    const ownPublicationPath = path.join(reviewsDir, 'T-022-code.md');
    const startSignalPath = path.join(tempDir, 'publish.start');
    const resultPath = path.join(tempDir, 'publish.result.json');
    try {
        let releaseAsyncBarrier!: () => void;
        const asyncBarrierHold = new Promise<void>((resolve) => {
            releaseAsyncBarrier = resolve;
        });
        const asyncBarrier = withReviewArtifactReadBarrier(reviewsDir, async () => {
            await asyncBarrierHold;
            writeReviewArtifactText(ownPublicationPath, 'must not be written\n');
            return 'async-complete';
        });
        const publication = startReviewPublicationWorker(
            reviewsDir,
            externalPublicationPath,
            startSignalPath,
            resultPath,
            { lowNoiseRuntimeWrites: true }
        );

        assert.throws(
            () => withReviewArtifactReadBarrier(reviewsDir, () => {
                fs.writeFileSync(startSignalPath, 'go\n', 'utf8');
                waitForFileSync(resultPath, 2_000);
            }),
            /invalidated by a concurrent review publication/
        );
        const workerResult = await publication;
        assert.equal(workerResult.code, 0, workerResult.stderr);
        releaseAsyncBarrier();
        await assert.rejects(asyncBarrier, /invalidated by a concurrent review publication/);
        assert.equal(fs.existsSync(externalPublicationPath), true);
        assert.equal(fs.existsSync(ownPublicationPath), false);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('throwing second then probe releases barrier state before a later invocation', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-read-then-probe-'));
    const reviewsDir = createReviewsDir(tempDir);
    let thenAccesses = 0;
    const statefulThenable = Object.defineProperty({}, 'then', {
        get() {
            thenAccesses += 1;
            if (thenAccesses === 1) {
                return undefined;
            }
            throw new Error('then-getter-failure');
        }
    });
    try {
        assert.throws(
            () => withReviewArtifactReadBarrier(reviewsDir, () => statefulThenable),
            /then-getter-failure/
        );
        fs.writeFileSync(path.join(reviewsDir, 'external-publication.tmp'), 'external\n', 'utf8');

        assert.equal(
            withReviewArtifactReadBarrier(reviewsDir, () => 'clean-barrier'),
            'clean-barrier'
        );
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('large receipt histories stop at the aggregate snapshot artifact budget', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-count-budget-'));
    const reviewsDir = createReviewsDir(tempDir);
    const receiptPaths = Array.from({ length: 256 }, (_, index) => {
        const receiptPath = path.join(reviewsDir, `T-HISTORY-code-receipt-${String(index).padStart(4, '0')}.json`);
        fs.writeFileSync(receiptPath, `{"index":${index}}\n`, 'utf8');
        return receiptPath;
    });
    const fsModule = require('node:fs') as typeof fs;
    const originalOpenSync = fsModule.openSync;
    let openedReceiptCount = 0;
    fsModule.openSync = ((targetPath: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
        if (String(targetPath).includes('T-HISTORY-code-receipt-')) {
            openedReceiptCount += 1;
        }
        return originalOpenSync(targetPath, flags, mode);
    }) as typeof fsModule.openSync;
    try {
        assert.throws(
            () => withReviewArtifactReadBarrier(reviewsDir, () => {
                for (const receiptPath of receiptPaths) {
                    readReviewArtifactJsonSnapshot(receiptPath);
                }
            }, {
                snapshotMaxArtifacts: 32,
                snapshotMaxBytes: 1024 * 1024
            }),
            (error: unknown) => (
                error instanceof ReviewArtifactReadBudgetError
                && error.code === 'ARTIFACT_COUNT_EXCEEDED'
            )
        );
        assert.equal(openedReceiptCount, 32);
    } finally {
        fsModule.openSync = originalOpenSync;
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('aggregate snapshot byte budget rejects the next receipt before allocation or I/O', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-byte-budget-'));
    const reviewsDir = createReviewsDir(tempDir);
    const receiptPaths = Array.from({ length: 3 }, (_, index) => {
        const receiptPath = path.join(reviewsDir, `T-BYTES-code-receipt-${index}.json`);
        fs.writeFileSync(receiptPath, Buffer.alloc(1024, index + 1));
        return receiptPath;
    });
    const fsModule = require('node:fs') as typeof fs;
    const originalOpenSync = fsModule.openSync;
    let thirdReceiptOpenCount = 0;
    fsModule.openSync = ((targetPath: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
        if (path.resolve(String(targetPath)) === path.resolve(receiptPaths[2])) {
            thirdReceiptOpenCount += 1;
        }
        return originalOpenSync(targetPath, flags, mode);
    }) as typeof fsModule.openSync;
    try {
        assert.throws(
            () => withReviewArtifactReadBarrier(reviewsDir, () => {
                for (const receiptPath of receiptPaths) {
                    readReviewArtifactFileSha256(receiptPath);
                }
            }, {
                snapshotMaxArtifacts: 10,
                snapshotMaxBytes: 2048
            }),
            (error: unknown) => (
                error instanceof ReviewArtifactReadBudgetError
                && error.code === 'BYTE_LIMIT_EXCEEDED'
            )
        );
        assert.equal(thirdReceiptOpenCount, 0);
    } finally {
        fsModule.openSync = originalOpenSync;
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('review read barrier reuses one immutable byte read without retaining parsed JSON', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-read-snapshot-'));
    const reviewsDir = createReviewsDir(tempDir);
    const receiptPath = path.join(reviewsDir, 'T-022-code-receipt.json');
    fs.writeFileSync(receiptPath, '{"version":1}\n', 'utf8');
    const fsModule = require('node:fs') as typeof fs;
    const originalOpenSync = fsModule.openSync;
    let receiptReadCount = 0;
    fsModule.openSync = ((targetPath: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
        if (path.resolve(String(targetPath)) === path.resolve(receiptPath)) {
            receiptReadCount += 1;
        }
        return originalOpenSync(targetPath, flags, mode);
    }) as typeof fsModule.openSync;
    try {
        withReviewArtifactReadBarrier(reviewsDir, () => {
            const first = readReviewArtifactJsonFile(receiptPath) as Record<string, unknown>;
            const second = readReviewArtifactJsonFile(receiptPath) as Record<string, unknown>;
            const text = readReviewArtifactTextFile(receiptPath);
            const fileSnapshot = readReviewArtifactFileSnapshot(receiptPath);
            assert.deepEqual(first, second);
            assert.notEqual(first, second);
            assert.equal(Object.isFrozen(first), true);
            assert.equal(fileSnapshot.valid, true);
            assert.equal(first.version, 1);
            assert.equal(text, '{"version":1}\n');
            assert.equal(readReviewArtifactFileSha256(receiptPath), fileSnapshot.sha256);
        });
        fs.writeFileSync(receiptPath, '{"version":2,"fresh":true}\n', 'utf8');
        withReviewArtifactReadBarrier(reviewsDir, () => {
            const refreshed = readReviewArtifactJsonFile(receiptPath) as Record<string, unknown>;
            assert.equal(refreshed.version, 2);
        });
    } finally {
        fsModule.openSync = originalOpenSync;
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
    assert.equal(receiptReadCount, 2);
});

test('review read barrier rejects an artifact replaced after its first snapshot read', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-read-snapshot-race-'));
    const reviewsDir = createReviewsDir(tempDir);
    const receiptPath = path.join(reviewsDir, 'T-023-code-receipt.json');
    fs.writeFileSync(receiptPath, '{"version":1}\n', 'utf8');
    try {
        withReviewArtifactReadBarrier(reviewsDir, () => {
            const originalSnapshot = readReviewArtifactTextSnapshot(receiptPath);
            assert.equal(originalSnapshot.value, '{"version":1}\n');
            assert.equal(originalSnapshot.sha256, fileSha256(receiptPath));
            fs.writeFileSync(receiptPath, '{"version":200,"replacement":true}\n', 'utf8');
            assert.equal(readReviewArtifactJsonSnapshot(receiptPath).valid, false);
            assert.equal(readReviewArtifactFileSha256(receiptPath), null);
            assert.throws(
                () => readReviewArtifactTextFile(receiptPath),
                /Review artifact text snapshot is unavailable/
            );
        });
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('review read snapshot rejects a replaced custom artifact outside the reviews root', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-custom-review-read-snapshot-race-'));
    const customEvidenceDir = path.join(tempDir, 'custom-evidence');
    const receiptPath = path.join(customEvidenceDir, 'bound-receipt.json');
    fs.mkdirSync(customEvidenceDir, { recursive: true });
    fs.writeFileSync(receiptPath, '{"version":1}\n', 'utf8');
    try {
        withReviewArtifactReadSnapshot(tempDir, () => {
            const originalSha256 = readReviewArtifactFileSha256(receiptPath);
            assert.equal(originalSha256, fileSha256(receiptPath));
            fs.writeFileSync(receiptPath, '{"version":200,"replacement":true}\n', 'utf8');
            assert.equal(readReviewArtifactJsonSnapshot(receiptPath).valid, false);
            assert.equal(readReviewArtifactFileSha256(receiptPath), null);
        });
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('review-attempt artifact index invalidates a cached read when the shared snapshot changes', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-attempt-snapshot-race-'));
    const reviewsDir = createReviewsDir(tempDir);
    const taskId = 'T-024';
    const receiptFileName = `${taskId}-code-receipt-${'a'.repeat(64)}.json`;
    const receiptPath = path.join(reviewsDir, receiptFileName);
    const originalContent = '{"version":1}\n';
    fs.writeFileSync(receiptPath, originalContent, 'utf8');
    loadIndex(reviewsDir);
    const expectedSha256 = fileSha256(receiptPath);
    assert.ok(expectedSha256);

    try {
        assert.throws(
            () => withReviewArtifactReadBarrier(reviewsDir, () => {
                const artifactIndex = createReviewAttemptArtifactIndex(reviewsDir, taskId);
                assert.equal(
                    artifactIndex.readJsonSnapshot(receiptPath, receiptFileName, expectedSha256).valid,
                    true
                );
                const replacementPath = `${receiptPath}.replacement`;
                fs.writeFileSync(replacementPath, '{"version":2}\n', 'utf8');
                fs.renameSync(replacementPath, receiptPath);
                assert.equal(
                    artifactIndex.readJsonSnapshot(receiptPath, receiptFileName, expectedSha256).valid,
                    false
                );
            }),
            /invalidated by a concurrent review publication/
        );
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('same-process read barrier sees complete staged artifact set during transaction', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-transaction-same-process-read-'));
    const reviewsDir = createReviewsDir(tempDir);
    const reviewPath = path.join(reviewsDir, 'T-021-code.md');
    const receiptPath = path.join(reviewsDir, 'T-021-code-receipt.json');

    try {
        writeReviewArtifactText(reviewPath, 'old review\n');
        loadIndex(reviewsDir);

        await writeReviewArtifactsWithRollback([
            {
                artifactPath: reviewPath,
                contentType: 'text',
                content: 'new review\n'
            },
            {
                artifactPath: receiptPath,
                contentType: 'json',
                payload: {
                    task_id: 'T-021',
                    review_type: 'code'
                }
            }
        ], async () => {
            const snapshot = withReviewArtifactReadBarrier(reviewsDir, () => ({
                review: fs.readFileSync(reviewPath, 'utf8'),
                receipt: JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as Record<string, unknown>,
                indexEntries: loadIndex(reviewsDir).index.entries.map((entry) => entry.fileName).sort()
            }));

            assert.equal(snapshot.review, 'new review\n');
            assert.deepEqual(snapshot.receipt, {
                task_id: 'T-021',
                review_type: 'code'
            });
            assert.equal(snapshot.indexEntries.includes('T-021-code.md'), true);
            assert.equal(snapshot.indexEntries.includes('T-021-code-receipt.json'), false);
            return 'done';
        });

        const committedIndex = loadIndex(reviewsDir).index;
        assert.equal(committedIndex.entries.some((entry) => entry.fileName === 'T-021-code.md'), true);
        assert.equal(committedIndex.entries.some((entry) => entry.fileName === 'T-021-code-receipt.json'), true);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('outer async barrier composes with a nested staged transaction barrier', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-outer-transaction-read-'));
    const reviewsDir = createReviewsDir(tempDir);
    const reviewPath = path.join(reviewsDir, 'T-021-code.md');
    const receiptPath = path.join(reviewsDir, 'T-021-code-receipt.json');

    try {
        writeReviewArtifactText(reviewPath, 'old review\n');

        const result = await withReviewArtifactReadBarrier(reviewsDir, async () => (
            await writeReviewArtifactsWithRollback([
                {
                    artifactPath: reviewPath,
                    contentType: 'text',
                    content: 'new review\n'
                },
                {
                    artifactPath: receiptPath,
                    contentType: 'json',
                    payload: {
                        task_id: 'T-021',
                        review_type: 'code'
                    }
                }
            ], async () => withReviewArtifactReadBarrier(reviewsDir, () => ({
                review: readReviewArtifactTextFile(reviewPath),
                receipt: readReviewArtifactJsonFile(receiptPath)
            }), {
                lockTimeoutMs: 50,
                lockRetryMs: 5
            }))
        ), {
            lockTimeoutMs: 1_000,
            lockRetryMs: 5
        });

        assert.equal(result.review, 'new review\n');
        assert.deepEqual(result.receipt, {
            task_id: 'T-021',
            review_type: 'code'
        });
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('nested staged barrier that outlives commit rejects a later external publication', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-transaction-outliving-commit-'));
    const reviewsDir = createReviewsDir(tempDir);
    const reviewPath = path.join(reviewsDir, 'T-021-code.md');
    const externalPath = path.join(reviewsDir, 'external-publication.tmp');
    let releaseNestedBarrier!: () => void;
    const nestedBarrierHold = new Promise<void>((resolve) => {
        releaseNestedBarrier = resolve;
    });
    let resolveNestedBarrier!: (value: { promise: Promise<string> }) => void;
    const nestedBarrierReady = new Promise<{ promise: Promise<string> }>((resolve) => {
        resolveNestedBarrier = resolve;
    });

    try {
        writeReviewArtifactText(reviewPath, 'old review\n');
        const outerBarrier = withReviewArtifactReadBarrier(reviewsDir, async () => (
            await writeReviewArtifactsWithRollback([
                {
                    artifactPath: reviewPath,
                    contentType: 'text',
                    content: 'new review\n'
                }
            ], async () => {
                const promise = withReviewArtifactReadBarrier(reviewsDir, async () => {
                    const stagedValue = readReviewArtifactTextFile(reviewPath);
                    await nestedBarrierHold;
                    return stagedValue;
                });
                resolveNestedBarrier({ promise });
                return 'transaction-complete';
            })
        ));
        const nestedBarrier = (await nestedBarrierReady).promise;

        assert.equal(await outerBarrier, 'transaction-complete');
        fs.writeFileSync(externalPath, 'external\n', 'utf8');
        releaseNestedBarrier();
        await assert.rejects(nestedBarrier, /invalidated by a concurrent review publication/);
        assert.equal(fs.readFileSync(reviewPath, 'utf8'), 'new review\n');
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('nested staged barrier that outlives rollback rejects the rolled-back snapshot', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-transaction-outliving-rollback-'));
    const reviewsDir = createReviewsDir(tempDir);
    const reviewPath = path.join(reviewsDir, 'T-021-code.md');
    let releaseNestedBarrier!: () => void;
    const nestedBarrierHold = new Promise<void>((resolve) => {
        releaseNestedBarrier = resolve;
    });
    let resolveNestedBarrier!: (value: { promise: Promise<string> }) => void;
    const nestedBarrierReady = new Promise<{ promise: Promise<string> }>((resolve) => {
        resolveNestedBarrier = resolve;
    });

    try {
        writeReviewArtifactText(reviewPath, 'old review\n');
        const outerBarrier = withReviewArtifactReadBarrier(reviewsDir, async () => (
            await writeReviewArtifactsWithRollback([
                {
                    artifactPath: reviewPath,
                    contentType: 'text',
                    content: 'new review\n'
                }
            ], async () => {
                const promise = withReviewArtifactReadBarrier(reviewsDir, async () => {
                    const stagedValue = readReviewArtifactTextFile(reviewPath);
                    await nestedBarrierHold;
                    return stagedValue;
                });
                resolveNestedBarrier({ promise });
                throw new Error('forced transaction rollback');
            })
        ));
        const nestedBarrier = (await nestedBarrierReady).promise;

        await assert.rejects(outerBarrier, /forced transaction rollback/);
        releaseNestedBarrier();
        await assert.rejects(nestedBarrier, /invalidated by a concurrent review publication/);
        assert.equal(fs.readFileSync(reviewPath, 'utf8'), 'old review\n');
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('independent same-process barrier cannot read a paused transaction staged value', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-independent-staged-read-'));
    const reviewsDir = createReviewsDir(tempDir);
    const reviewPath = path.join(reviewsDir, 'T-021-code.md');
    let releaseTransaction!: () => void;
    const transactionHold = new Promise<void>((resolve) => {
        releaseTransaction = resolve;
    });
    let markTransactionPaused!: () => void;
    const transactionPaused = new Promise<void>((resolve) => {
        markTransactionPaused = resolve;
    });

    try {
        writeReviewArtifactText(reviewPath, 'old review\n');
        const outerBarrier = withReviewArtifactReadBarrier(reviewsDir, async () => (
            await writeReviewArtifactsWithRollback([
                {
                    artifactPath: reviewPath,
                    contentType: 'text',
                    content: 'staged review\n'
                }
            ], async () => {
                markTransactionPaused();
                await transactionHold;
                throw new Error('forced transaction rollback');
            })
        ));
        await transactionPaused;
        let callbackExecuted = false;

        assert.throws(
            () => withReviewArtifactReadBarrier(reviewsDir, () => {
                callbackExecuted = true;
                return readReviewArtifactTextFile(reviewPath);
            }),
            /invalidated by a concurrent review publication/
        );
        assert.equal(callbackExecuted, false);
        releaseTransaction();
        await assert.rejects(outerBarrier, /forced transaction rollback/);
        assert.equal(fs.readFileSync(reviewPath, 'utf8'), 'old review\n');
    } finally {
        releaseTransaction();
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('writeReviewArtifactsWithRollback rolls back all artifacts and refreshes the index after callback failure', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-transaction-rollback-'));
    const reviewsDir = createReviewsDir(tempDir);
    const existingPath = path.join(reviewsDir, 'T-013-code.md');
    const newPath = path.join(reviewsDir, 'T-013-code-receipt.json');

    try {
        writeReviewArtifactText(existingPath, 'old review\n');

        await assert.rejects(
            () => writeReviewArtifactsWithRollback([
                {
                    artifactPath: existingPath,
                    contentType: 'text',
                    content: 'new review\n'
                },
                {
                    artifactPath: newPath,
                    contentType: 'json',
                    payload: { task_id: 'T-013' }
                }
            ], async () => {
                throw new Error('simulated telemetry failure');
            }),
            /simulated telemetry failure/
        );

        assert.equal(fs.readFileSync(existingPath, 'utf8'), 'old review\n');
        assert.equal(fs.existsSync(newPath), false);
        const index = loadIndex(reviewsDir).index;
        assert.ok(index.entries.some((entry) => entry.fileName === 'T-013-code.md'));
        assert.equal(index.entries.some((entry) => entry.fileName === 'T-013-code-receipt.json'), false);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('writeReviewArtifactsWithRollback does not publish new index entries before afterWrites succeeds', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-transaction-index-commit-'));
    const reviewsDir = createReviewsDir(tempDir);
    const newPath = path.join(reviewsDir, 'T-017-code.md');

    try {
        loadIndex(reviewsDir);
        const indexPath = resolveIndexPath(reviewsDir);

        await writeReviewArtifactsWithRollback([
            {
                artifactPath: newPath,
                contentType: 'text',
                content: 'REVIEW PASSED\n'
            }
        ], async () => {
            const duringTransactionIndex = JSON.parse(fs.readFileSync(indexPath, 'utf8')) as {
                entries: Array<{ fileName: string }>;
            };
            assert.equal(
                duringTransactionIndex.entries.some((entry) => entry.fileName === 'T-017-code.md'),
                false
            );
            return 'done';
        });

        const committedIndex = loadIndex(reviewsDir).index;
        assert.equal(
            committedIndex.entries.some((entry) => entry.fileName === 'T-017-code.md'),
            true
        );
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('writeReviewArtifactsWithRollback rolls back visible artifacts when commit index persistence fails', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-transaction-index-failure-'));
    const reviewsDir = createReviewsDir(tempDir);
    const newPath = path.join(reviewsDir, 'T-018-code.md');
    const indexLockPath = resolveIndexLockPath(reviewsDir);
    let lockHandle: ReturnType<typeof acquireFilesystemLock>['handle'] | null = null;

    try {
        loadIndex(reviewsDir);
        lockHandle = acquireFilesystemLock(indexLockPath, {
            timeoutMs: 500,
            retryMs: 10
        }).handle;

        await assert.rejects(
            () => writeReviewArtifactsWithRollback([
                {
                    artifactPath: newPath,
                    contentType: 'text',
                    content: 'REVIEW PASSED\n'
                }
            ], async () => 'after-writes-ok', { lockTimeoutMs: 75, lockRetryMs: 10 }),
            /Review artifact transaction index commit failed/
        );

        assert.equal(fs.existsSync(newPath), false);
    } finally {
        if (lockHandle) {
            releaseFilesystemLock(lockHandle);
        }
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('writeReviewArtifactsWithRollback uses an async transaction lock for concurrent async callbacks', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-transaction-async-lock-'));
    const reviewsDir = createReviewsDir(tempDir);
    const firstPath = path.join(reviewsDir, 'T-014-code.md');
    const secondPath = path.join(reviewsDir, 'T-015-code.md');
    let firstCallbackStarted = false;
    let secondCallbackStarted = false;

    try {
        const first = writeReviewArtifactsWithRollback([
            {
                artifactPath: firstPath,
                contentType: 'text',
                content: 'first review\n'
            }
        ], async () => {
            firstCallbackStarted = true;
            await delay(120);
            return 'first';
        }, { lockTimeoutMs: 1_000, lockRetryMs: 10 });

        await delay(20);

        const second = writeReviewArtifactsWithRollback([
            {
                artifactPath: secondPath,
                contentType: 'text',
                content: 'second review\n'
            }
        ], async () => {
            secondCallbackStarted = true;
            return 'second';
        }, { lockTimeoutMs: 1_000, lockRetryMs: 10 });

        const progressProbe = Promise.race([
            first.then(() => 'first-complete'),
            delay(250).then(() => 'timeout')
        ]);
        assert.equal(await progressProbe, 'first-complete');

        const results = await Promise.all([first, second]);
        assert.deepEqual(results, ['first', 'second']);
        assert.equal(firstCallbackStarted, true);
        assert.equal(secondCallbackStarted, true);
        assert.equal(fs.readFileSync(firstPath, 'utf8'), 'first review\n');
        assert.equal(fs.readFileSync(secondPath, 'utf8'), 'second review\n');
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('context lock prevents rebuild after post-write assertion until reuse transaction commits', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-context-reuse-lock-'));
    const reviewsDir = createReviewsDir(tempDir);
    const contextPath = path.join(reviewsDir, 'T-022-code-context.json');
    const receiptPath = path.join(reviewsDir, 'T-022-code-receipt.json');
    const initialContext = '{"schema_version":3,"review_type":"code"}\n';
    const driftedContext = '{"schema_version":3,"review_type":"security"}\n';
    let notifyPostWriteAssertion: (() => void) | null = null;
    const transactionCommitControl = {
        allow: (): void => undefined
    };
    let contextWriter: ReturnType<typeof spawn> | null = null;
    const postWriteAssertionReached = new Promise<void>((resolve) => {
        notifyPostWriteAssertion = resolve;
    });
    const transactionCommitAllowed = new Promise<void>((resolve) => {
        transactionCommitControl.allow = resolve;
    });

    try {
        fs.writeFileSync(contextPath, initialContext, 'utf8');
        const expectedContextSha256 = fileSha256(contextPath);
        const reuseTransaction = withReviewArtifactLockAsync(contextPath, async () => {
            await writeReviewArtifactsWithRollback([
                {
                    artifactPath: receiptPath,
                    contentType: 'json',
                    payload: { task_id: 'T-022', review_type: 'code' }
                }
            ], async () => {
                assertReviewArtifactFileSha256(
                    contextPath,
                    expectedContextSha256,
                    'Current review context'
                );
                notifyPostWriteAssertion?.();
                await transactionCommitAllowed;
                assert.equal(
                    fs.readFileSync(contextPath, 'utf8'),
                    initialContext,
                    'context writer must remain blocked until the reuse transaction commits'
                );
            });
        });

        await postWriteAssertionReached;
        const reviewArtifactsModulePath = path.resolve(
            __dirname,
            '../../../src/gate-runtime/review/review-artifacts.js'
        );
        const writerScript = [
            "const fs = require('node:fs');",
            'const { withReviewArtifactLock } = require(process.argv[1]);',
            'const contextPath = process.argv[2];',
            "const content = Buffer.from(process.argv[3], 'base64').toString('utf8');",
            "process.stdout.write('ATTEMPTING\\n');",
            'withReviewArtifactLock(contextPath, () => {',
            "  fs.writeFileSync(contextPath, content, 'utf8');",
            '});',
            "process.stdout.write('COMPLETED\\n');"
        ].join('\n');
        const writer = spawn(process.execPath, [
            '--input-type=commonjs',
            '--eval',
            writerScript,
            reviewArtifactsModulePath,
            contextPath,
            Buffer.from(driftedContext, 'utf8').toString('base64')
        ], {
            stdio: ['ignore', 'pipe', 'pipe']
        });
        contextWriter = writer;
        let writerStdout = '';
        let writerStderr = '';
        writer.stdout.on('data', (chunk) => {
            writerStdout += String(chunk);
        });
        writer.stderr.on('data', (chunk) => {
            writerStderr += String(chunk);
        });
        await new Promise<void>((resolve, reject) => {
            const deadline = Date.now() + 2_000;
            const timer = setInterval(() => {
                if (writerStdout.includes('ATTEMPTING')) {
                    clearInterval(timer);
                    resolve();
                    return;
                }
                if (Date.now() >= deadline) {
                    clearInterval(timer);
                    reject(new Error(writerStderr || 'Timed out waiting for synchronous context writer'));
                }
            }, 10);
            writer.once('error', (error) => {
                clearInterval(timer);
                reject(error);
            });
        });

        await delay(30);
        assert.equal(fs.readFileSync(contextPath, 'utf8'), initialContext);
        transactionCommitControl.allow();
        await reuseTransaction;
        if (writer.exitCode === null) {
            await new Promise<void>((resolve, reject) => {
                writer.once('error', reject);
                writer.once('exit', (code) => {
                    if (code === 0) {
                        resolve();
                        return;
                    }
                    reject(new Error(writerStderr || `Synchronous context writer exited with code ${code}`));
                });
            });
        } else {
            assert.equal(writer.exitCode, 0, writerStderr);
        }

        assert.match(writerStdout, /COMPLETED/u);
        assert.equal(fs.readFileSync(contextPath, 'utf8'), driftedContext);
        assert.equal(fs.existsSync(receiptPath), true);
    } finally {
        transactionCommitControl.allow();
        if (contextWriter && contextWriter.exitCode === null) {
            contextWriter.kill();
        }
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});
