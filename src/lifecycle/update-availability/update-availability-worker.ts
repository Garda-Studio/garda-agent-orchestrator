import { spawn } from 'node:child_process';
import * as path from 'node:path';
import { createUpdateAvailabilityService } from './update-availability-service';
import { UPDATE_CHECK_OPT_OUT_ENV } from './update-availability-types';
import { formatUpdateAvailabilityNotice } from './update-availability-notice';

/** Cached presentation only; canonical reports, hashes, and gate evidence stay immutable. */
export function cachedUpdateAvailabilityNotice(repoRoot: string): string {
    return formatUpdateAvailabilityNotice(repoRoot, createUpdateAvailabilityService(repoRoot).snapshot());
}

/** Launch only at task entry/closeout boundaries; no foreground network wait. */
export function scheduleUpdateAvailabilityCheck(repoRoot: string): void {
    if (process.env[UPDATE_CHECK_OPT_OUT_ENV] === '0') return;
    const service = createUpdateAvailabilityService(repoRoot);
    if (service.snapshot().status !== 'unknown') return;
    try {
        const child = spawn(process.execPath, [__filename, path.resolve(repoRoot)], {
            detached: true, stdio: 'ignore', windowsHide: true
        });
        child.on('error', () => undefined);
        child.unref();
    } catch {
        // An advisory check cannot turn successful task entry or closeout into a failure.
    }
}

if (require.main === module && process.argv[2]) {
    void createUpdateAvailabilityService(process.argv[2]).check().catch(() => undefined);
}
