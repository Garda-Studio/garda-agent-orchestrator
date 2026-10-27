import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    cleanupGeneratedLocksAfterTimedOutFullSuite,
    formatGeneratedLockCleanupObservation
} from '../../../../src/cli/commands/gate-flows/full-suite/full-suite-validation-lock-cleanup';

function withTempRepo(run: (repoRoot: string) => void): void {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-fsv-lock-cleanup-'));
    try {
        run(repoRoot);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
}

function createGeneratedLock(repoRoot: string, lockName = '.scripts-build.lock'): string {
    const lockPath = path.join(repoRoot, lockName);
    fs.mkdirSync(lockPath, { recursive: true });
    return lockPath;
}

function writeOwner(lockPath: string, owner: Record<string, unknown>): void {
    fs.writeFileSync(path.join(lockPath, 'owner.json'), `${JSON.stringify(owner, null, 2)}\n`, 'utf8');
}

describe('full-suite generated lock timeout cleanup diagnostics', () => {
    it('retains locks with missing owner metadata and prints recovery guidance', () => {
        withTempRepo((repoRoot) => {
            const lockPath = createGeneratedLock(repoRoot);

            const observations = cleanupGeneratedLocksAfterTimedOutFullSuite(repoRoot, { nowMs: Date.now() });

            assert.equal(observations.length, 1);
            assert.equal(observations[0].lock_path.endsWith('.scripts-build.lock'), true);
            assert.equal(observations[0].removed, false);
            assert.equal(observations[0].reason, 'owner_metadata_missing_after_full_suite_timeout');
            assert.equal(observations[0].owner_metadata_status, 'missing');
            assert.equal(observations[0].owner_pid, null);
            assert.equal(fs.existsSync(lockPath), true);
            assert.match(
                formatGeneratedLockCleanupObservation(observations[0]),
                /recommended_next_command=Run `node garda-agent-orchestrator\/bin\/garda\.js doctor --target-root "\."`/
            );
        });
    });

    it('retains locks when owner metadata has a transient read error', () => {
        withTempRepo((repoRoot) => {
            const lockPath = createGeneratedLock(repoRoot);
            writeOwner(lockPath, { pid: 1234, hostname: os.hostname(), startedAtUtc: '2026-06-12T10:00:00.000Z' });

            const observations = cleanupGeneratedLocksAfterTimedOutFullSuite(repoRoot, {
                readOwnerFile() {
                    const error = new Error('simulated transient read') as NodeJS.ErrnoException;
                    error.code = 'EBUSY';
                    throw error;
                }
            });

            assert.equal(observations.length, 1);
            assert.equal(observations[0].removed, false);
            assert.equal(observations[0].reason, 'owner_metadata_transient_read_error_after_full_suite_timeout');
            assert.equal(observations[0].owner_metadata_status, 'read_error');
            assert.equal(fs.existsSync(lockPath), true);
            assert.match(formatGeneratedLockCleanupObservation(observations[0]), /owner_metadata_status=read_error/);
        });
    });

    it('retains locks when the owner process is still alive', () => {
        withTempRepo((repoRoot) => {
            const lockPath = createGeneratedLock(repoRoot);
            writeOwner(lockPath, { pid: 4242, hostname: os.hostname(), startedAtUtc: '2026-06-12T10:00:00.000Z' });
            const ownerPath = path.join(lockPath, 'owner.json');

            const observations = cleanupGeneratedLocksAfterTimedOutFullSuite(repoRoot, {
                nowMs: 10_000,
                statPath(targetPath) {
                    const normalizedTarget = path.normalize(targetPath);
                    if (normalizedTarget === path.normalize(lockPath)) {
                        return {
                            mtimeMs: 7_000,
                            isFile: () => false,
                            isDirectory: () => true
                        };
                    }
                    if (normalizedTarget === path.normalize(ownerPath)) {
                        return {
                            mtimeMs: 8_500,
                            isFile: () => true,
                            isDirectory: () => false
                        };
                    }
                    return fs.statSync(targetPath);
                },
                processAlive(pid) {
                    return pid === 4242;
                }
            });

            assert.equal(observations.length, 1);
            assert.equal(observations[0].removed, false);
            assert.equal(observations[0].reason, 'owner_process_still_alive_after_full_suite_timeout');
            assert.equal(observations[0].owner_alive, true);
            assert.equal(observations[0].owner_host_matches_current, true);
            assert.equal(observations[0].lock_age_ms, 3_000);
            assert.equal(observations[0].owner_file_age_ms, 1_500);
            assert.equal(observations[0].stale_threshold_ms, 30 * 60 * 1000);
            assert.equal(fs.existsSync(lockPath), true);
            const formatted = formatGeneratedLockCleanupObservation(observations[0]);
            assert.match(formatted, /lock_age_ms=3000ms/);
            assert.match(formatted, /owner_file_age_ms=1500ms/);
            assert.match(formatted, /stale_threshold_ms=1800000/);
            assert.match(formatted, /owner_alive=yes/);
            assert.match(formatted, /Wait for the owner process to exit/);
        });
    });

    it('removes locks when the current owner process is dead and preserves owner diagnostics', () => {
        withTempRepo((repoRoot) => {
            const lockPath = createGeneratedLock(repoRoot);
            writeOwner(lockPath, { pid: 999999, hostname: os.hostname(), startedAtUtc: '2026-06-12T10:00:00.000Z' });

            const observations = cleanupGeneratedLocksAfterTimedOutFullSuite(repoRoot, {
                processAlive(pid) {
                    return pid === 999999 ? false : null;
                }
            });

            assert.equal(observations.length, 1);
            assert.equal(observations[0].removed, true);
            assert.equal(observations[0].reason, 'owner_process_dead_after_full_suite_timeout');
            assert.equal(observations[0].owner_alive, false);
            assert.equal(observations[0].owner_metadata_status, 'ok');
            assert.equal(observations[0].owner_created_at_utc, '2026-06-12T10:00:00.000Z');
            assert.equal(fs.existsSync(lockPath), false);
            assert.match(formatGeneratedLockCleanupObservation(observations[0]), /timeout cleanup removed generated lock/);
            assert.match(formatGeneratedLockCleanupObservation(observations[0]), /Retry the full-suite-validation command/);
        });
    });

    it('retains foreign-host locks even when the pid is not alive locally', () => {
        withTempRepo((repoRoot) => {
            const lockPath = createGeneratedLock(repoRoot);
            writeOwner(lockPath, { pid: 999999, hostname: 'remote-build-host', startedAtUtc: '2026-06-12T10:00:00.000Z' });

            const observations = cleanupGeneratedLocksAfterTimedOutFullSuite(repoRoot, {
                processAlive(pid) {
                    return pid === 999999 ? false : null;
                }
            });

            assert.equal(observations.length, 1);
            assert.equal(observations[0].removed, false);
            assert.equal(observations[0].reason, 'owner_foreign_host_after_full_suite_timeout');
            assert.equal(observations[0].owner_alive, false);
            assert.equal(observations[0].owner_host_matches_current, false);
            assert.equal(fs.existsSync(lockPath), true);
            assert.match(formatGeneratedLockCleanupObservation(observations[0]), /foreign-host owner is gone/);
        });
    });
});
