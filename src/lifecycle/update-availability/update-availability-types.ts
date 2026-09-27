export const UPDATE_CHECK_TTL_MS = 24 * 60 * 60 * 1000;
export const UPDATE_CHECK_TIMEOUT_MS = 4_000;
export const UPDATE_CHECK_OPT_OUT_ENV = 'GARDA_UPDATE_CHECK';

export interface UpdateAvailabilitySource {
    bundleRoot: string;
    cwd: string;
    currentVersion: string;
    packageSpec: string;
    fingerprint: string;
    trustPolicy: 'enforced';
    transport: { kind: 'npm-cli'; configurationSha256: string };
}

export interface UpdateMetadata {
    version: string;
    integrity: string;
}

/** A persisted pending attempt claimed before a detached worker is launched. */
export interface UpdateAvailabilityClaim {
    sourceFingerprint: string;
    attemptId: string;
}

export interface UpdateAvailabilityCacheEntry {
    schema: 1;
    sourceFingerprint: string;
    packageSpec: string;
    trustPolicy: 'enforced';
    transport: UpdateAvailabilitySource['transport'];
    attemptId: string;
    attemptedAt: number;
    outcome: 'pending' | 'success' | 'unavailable';
    metadata: UpdateMetadata | null;
}

export interface UpdateAvailabilityView {
    status: 'unknown' | 'checking' | 'available' | 'up_to_date' | 'unavailable' | 'disabled';
    currentVersion: string | null;
    latestVersion: string | null;
    updateCommand: string | null;
}

export interface UpdateAvailabilityService {
    snapshot(): UpdateAvailabilityView;
    snapshotAsync?(): Promise<UpdateAvailabilityView>;
    check(options?: { manual?: boolean }): Promise<UpdateAvailabilityView>;
}

export interface UpdateAvailabilityServiceOptions {
    now?: () => number;
    automaticEnabled?: boolean;
    timeoutMs?: number;
    queryMetadata?: (source: UpdateAvailabilitySource, signal: AbortSignal) => Promise<UpdateMetadata>;
}
