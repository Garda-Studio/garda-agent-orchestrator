import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { resolveBundleName } from '../../../core/constants';
import { lstatFileIdentitySync } from '../../../core/file-stat';
import { validateProfilesConfig } from '../../../schemas/config-artifacts';
import { writeTextFileAtomically } from '../../../core/filesystem';
import { normalizePathValue } from '../cli-helpers';
import { ParsedOptionsRecord, ProfileEntry, ProfilesData } from './profile-types';

const PROFILE_LOCK_MAX_ATTEMPTS = 26;
const PROFILE_LOCK_RETRY_DELAY_MS = 8;
const MALFORMED_PROFILE_LOCK_MIN_AGE_MS = 1_000;
const MALFORMED_CLEANUP_LOCK_MIN_AGE_MS = 1_000;

export class ProfilesConfigLockAcquisitionError extends Error {
    constructor(message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = 'ProfilesConfigLockAcquisitionError';
    }
}

export class ProfilesConfigLockReleaseError extends Error {
    operationResult: unknown = undefined;

    constructor(message: string, readonly operationCompleted: boolean, options?: ErrorOptions) {
        super(message, options);
        this.name = 'ProfilesConfigLockReleaseError';
    }
}

export interface ProfileDirectoryIdentity {
    dev: number;
    ino: number;
}

export function profileFileIdentityMatches(
    left: ProfileDirectoryIdentity,
    right: ProfileDirectoryIdentity
): boolean {
    return left.dev === right.dev && left.ino === right.ino;
}

export interface ProfileBundleRootOwnership {
    repoRoot: string;
    bundleRoot: string;
    repoRootIdentity: ProfileDirectoryIdentity;
    bundleRootIdentity: ProfileDirectoryIdentity;
}

interface PendingProfilesClaim {
    path: string;
    beforeConfigSha256: string;
    afterConfigSha256: string;
}

interface ReadableProfilesConfig {
    path: string;
    expectedConfigSha256: string | null;
}

class ProfilesConfigAdditionalLinksError extends Error {
    constructor() {
        super('Profiles config must not have additional hard links.');
        this.name = 'ProfilesConfigAdditionalLinksError';
    }
}

export function getCompletedProfilesOperationResult<T>(error: unknown): { result: T } | null {
    if (!(error instanceof ProfilesConfigLockReleaseError) || !error.operationCompleted) return null;
    return { result: error.operationResult as T };
}

export function resolveBundleRoot(options: ParsedOptionsRecord): { targetRoot: string; bundleRoot: string } {
    const explicitTargetRoot = typeof options.targetRoot === 'string'
        ? normalizePathValue(options.targetRoot)
        : null;
    const explicitBundleRoot = typeof options.bundleRoot === 'string'
        ? normalizePathValue(options.bundleRoot)
        : null;
    const targetRoot = explicitTargetRoot || (explicitBundleRoot ? path.dirname(explicitBundleRoot) : normalizePathValue('.'));
    const bundleRoot = explicitBundleRoot || path.join(targetRoot, resolveBundleName());
    return { targetRoot, bundleRoot };
}

function pathsAreEquivalent(left: string, right: string): boolean {
    return process.platform === 'win32'
        ? left.toLowerCase() === right.toLowerCase()
        : left === right;
}

function readRealDirectoryIdentity(directoryPath: string, label: string): ProfileDirectoryIdentity {
    const identity = lstatFileIdentitySync(directoryPath);
    if (!identity.isDirectory() || identity.isSymbolicLink()) {
        throw new Error(`${label} must be a real directory.`);
    }
    return { dev: identity.dev, ino: identity.ino };
}

function assertDirectoryIdentity(
    directoryPath: string,
    expected: ProfileDirectoryIdentity,
    label: string
): void {
    const current = readRealDirectoryIdentity(directoryPath, label);
    if (!profileFileIdentityMatches(current, expected)) {
        throw new Error(`${label} changed after profile policy ownership validation.`);
    }
}

export function assertProfileBundleRootOwnership(
    repoRoot: string,
    bundleRoot: string
): ProfileBundleRootOwnership {
    const resolvedRepoRoot = fs.realpathSync.native(path.resolve(repoRoot));
    const resolvedBundleRoot = fs.realpathSync.native(path.resolve(bundleRoot));
    const resolvedBundleParent = path.dirname(resolvedBundleRoot);
    if (!pathsAreEquivalent(resolvedRepoRoot, resolvedBundleParent)) {
        throw new Error('Profile policy requires --target-root to be the parent directory of --bundle-root.');
    }
    return {
        repoRoot: resolvedRepoRoot,
        bundleRoot: resolvedBundleRoot,
        repoRootIdentity: readRealDirectoryIdentity(resolvedRepoRoot, 'Profile policy target root'),
        bundleRootIdentity: readRealDirectoryIdentity(resolvedBundleRoot, 'Profile policy bundle root')
    };
}

export function assertProfileBundleRootOwnershipCurrent(ownership: ProfileBundleRootOwnership): void {
    assertDirectoryIdentity(ownership.repoRoot, ownership.repoRootIdentity, 'Profile policy target root');
    assertDirectoryIdentity(ownership.bundleRoot, ownership.bundleRootIdentity, 'Profile policy bundle root');
}

export function resolveProfilesPath(bundleRoot: string): string {
    return path.join(bundleRoot, 'live', 'config', 'profiles.json');
}

function assertProfilesDirectoryBoundary(
    profilesPath: string,
    ownership?: ProfileBundleRootOwnership
): void {
    const configDirectory = path.dirname(profilesPath);
    const liveDirectory = path.dirname(configDirectory);
    const bundleRoot = path.dirname(liveDirectory);
    for (const directoryPath of [bundleRoot, liveDirectory, configDirectory]) {
        const identity = fs.lstatSync(directoryPath);
        if (!identity.isDirectory() || identity.isSymbolicLink()) {
            throw new Error('Profiles config directory must be a real directory inside the bundle.');
        }
    }
    if (ownership) {
        if (!pathsAreEquivalent(path.resolve(bundleRoot), path.resolve(ownership.bundleRoot))) {
            throw new Error('Profiles config path does not belong to the validated profile policy bundle.');
        }
        assertProfileBundleRootOwnershipCurrent(ownership);
    }
    const realBundleRoot = fs.realpathSync.native(bundleRoot);
    const expectedConfigDirectory = path.join(realBundleRoot, path.basename(liveDirectory), path.basename(configDirectory));
    if (path.resolve(fs.realpathSync.native(configDirectory)) !== path.resolve(expectedConfigDirectory)) {
        throw new Error('Profiles config directory resolves outside the bundle.');
    }
}

export function readProfilesData(profilesPath: string, ownership?: ProfileBundleRootOwnership): ProfilesData {
    for (let attempt = 0; attempt < 3; attempt += 1) {
        let readable = resolveReadableProfilesPath(profilesPath);
        if (!readable) throw new Error(`Profiles config not found: ${profilesPath}`);
        let profilesFd: number;
        try {
            profilesFd = openExistingProfilesConfig(readable.path, ownership);
        } catch (error: unknown) {
            if (error instanceof ProfilesConfigAdditionalLinksError && readable.path === profilesPath) {
                readable = resolveRecoverableLinkedProfilesRead(profilesPath);
                profilesFd = openExistingProfilesConfig(readable.path, ownership, true);
            } else {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT' && attempt < 2) continue;
                throw error;
            }
        }
        try {
            const parsed = validateProfilesConfig(
                JSON.parse(fs.readFileSync(profilesFd, 'utf8'))
            ) as unknown as ProfilesData;
            if (
                readable.expectedConfigSha256
                && hashProfilesConfigData(parsed) !== readable.expectedConfigSha256
            ) {
                throw new Error('Pending profiles config claim does not match its authenticated before hash.');
            }
            return parsed;
        } finally {
            fs.closeSync(profilesFd);
        }
    }
    throw new Error(`Profiles config not found: ${profilesPath}`);
}

export function writeProfilesDataUnlocked(
    profilesPath: string,
    data: ProfilesData,
    ownership?: ProfileBundleRootOwnership,
    expectedCurrentConfigSha256?: string
): void {
    if (ownership && expectedCurrentConfigSha256) {
        writeOwnedProfilesDataAtomically(profilesPath, data, ownership, expectedCurrentConfigSha256);
        return;
    }
    const profilesFd = openExistingProfilesConfig(profilesPath, ownership);
    fs.closeSync(profilesFd);
    const validated = validateProfilesConfig(data) as unknown as ProfilesData;
    writeTextFileAtomically(profilesPath, JSON.stringify(validated, null, 2), {
        trailingNewline: true,
        fsync: true
    });
}

function hashProfilesConfigData(data: ProfilesData): string {
    const normalized = validateProfilesConfig(data) as unknown as ProfilesData;
    return createHash('sha256').update(JSON.stringify(normalized), 'utf8').digest('hex');
}

function readProfilesDataFromDescriptor(profilesFd: number): ProfilesData {
    const size = fs.fstatSync(profilesFd).size;
    const raw = Buffer.alloc(size);
    if (size > 0) fs.readSync(profilesFd, raw, 0, size, 0);
    return validateProfilesConfig(JSON.parse(raw.toString('utf8'))) as unknown as ProfilesData;
}

function assertCurrentProfilesConfigState(
    profilesPath: string,
    profilesFd: number,
    ownership: ProfileBundleRootOwnership,
    expectedConfigSha256: string
): ProfileDirectoryIdentity {
    assertProfilesDirectoryBoundary(profilesPath, ownership);
    const openedIdentity = fs.fstatSync(profilesFd);
    const pathIdentity = lstatFileIdentitySync(profilesPath);
    if (
        !openedIdentity.isFile()
        || !pathIdentity.isFile()
        || pathIdentity.isSymbolicLink()
        || openedIdentity.nlink !== 1
        || pathIdentity.nlink !== 1
        || !profileFileIdentityMatches(openedIdentity, pathIdentity)
    ) {
        throw new Error('Profiles config changed after profile policy validation.');
    }
    if (hashProfilesConfigData(readProfilesDataFromDescriptor(profilesFd)) !== expectedConfigSha256) {
        throw new Error('Profiles config changed after preview; stale preview cannot be applied.');
    }
    return { dev: openedIdentity.dev, ino: openedIdentity.ino };
}

export function fsyncProfilesDirectoryBestEffort(directoryPath: string): void {
    let directoryFd: number | null = null;
    try {
        directoryFd = fs.openSync(directoryPath, 'r');
        fs.fsyncSync(directoryFd);
    } catch {
        // Directory fsync is not portable across every supported filesystem.
    } finally {
        if (directoryFd !== null) {
            try { fs.closeSync(directoryFd); } catch { /* best-effort descriptor cleanup */ }
        }
    }
}

function assertClaimedProfilesConfigState(
    claimedPath: string,
    expectedIdentity: ProfileDirectoryIdentity,
    ownership: ProfileBundleRootOwnership,
    expectedConfigSha256: string
): void {
    const claimedFd = openExistingProfilesConfig(claimedPath, ownership, true);
    try {
        const claimedIdentity = fs.fstatSync(claimedFd);
        if (!profileFileIdentityMatches(claimedIdentity, expectedIdentity)) {
            throw new Error('Profiles config changed before profile policy commit could claim it.');
        }
        if (hashProfilesConfigData(readProfilesDataFromDescriptor(claimedFd)) !== expectedConfigSha256) {
            throw new Error('Profiles config changed after preview; stale preview cannot be applied.');
        }
    } finally {
        fs.closeSync(claimedFd);
    }
}

function restoreClaimedProfilesConfig(
    claimedPath: string,
    profilesPath: string,
    claimedIdentity: fs.Stats
): void {
    const currentClaimedIdentity = lstatFileIdentitySync(claimedPath);
    if (
        !currentClaimedIdentity.isFile()
        || currentClaimedIdentity.isSymbolicLink()
        || !profileFileIdentityMatches(currentClaimedIdentity, claimedIdentity)
    ) {
        throw new Error('Claimed profiles config changed before it could be restored.');
    }
    fs.linkSync(claimedPath, profilesPath);
    const restoredIdentity = lstatFileIdentitySync(profilesPath);
    if (!profileFileIdentityMatches(restoredIdentity, claimedIdentity)) {
        throw new Error('Claimed profiles config could not be restored safely.');
    }
    if (!unlinkObservedPath(claimedPath, claimedIdentity)) {
        throw new Error('Claimed profiles config path changed before restore cleanup.');
    }
    fsyncProfilesDirectoryBestEffort(path.dirname(profilesPath));
}

function listPendingProfilesClaims(profilesPath: string): PendingProfilesClaim[] {
    const directoryPath = path.dirname(profilesPath);
    const claimPrefix = `.${path.basename(profilesPath)}.garda-claimed-`;
    let entries: string[];
    try {
        entries = fs.readdirSync(directoryPath);
    } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
    }
    return entries
        .filter((entry) => entry.startsWith(claimPrefix))
        .map((entry) => {
            const binding = entry.slice(claimPrefix.length).match(/^([a-f0-9]{64})-([a-f0-9]{64})-(.+)$/u);
            if (!binding) throw new Error('Malformed pending profiles config claim requires manual recovery.');
            return {
                path: path.join(directoryPath, entry),
                beforeConfigSha256: binding[1],
                afterConfigSha256: binding[2]
            };
        })
        .sort((left, right) => left.path.localeCompare(right.path));
}

function resolveReadableProfilesPath(profilesPath: string): ReadableProfilesConfig | null {
    if (fs.existsSync(profilesPath)) return { path: profilesPath, expectedConfigSha256: null };
    const claims = listPendingProfilesClaims(profilesPath);
    if (claims.length > 1) {
        throw new Error('Multiple pending profiles config claims require manual recovery.');
    }
    return claims[0]
        ? { path: claims[0].path, expectedConfigSha256: claims[0].beforeConfigSha256 }
        : null;
}

function resolveRecoverableLinkedProfilesRead(profilesPath: string): ReadableProfilesConfig {
    const claims = listPendingProfilesClaims(profilesPath);
    if (claims.length !== 1) {
        throw new Error('Linked profiles config requires exactly one authenticated pending claim for recovery.');
    }
    const currentIdentity = lstatFileIdentitySync(profilesPath);
    const claimIdentity = lstatFileIdentitySync(claims[0].path);
    const restorationPending = profileFileIdentityMatches(currentIdentity, claimIdentity);
    return {
        path: profilesPath,
        expectedConfigSha256: restorationPending
            ? claims[0].beforeConfigSha256
            : claims[0].afterConfigSha256
    };
}

function removePublishedProfilesTempLink(profilesPath: string, publishedIdentity: fs.Stats): void {
    const directoryPath = path.dirname(profilesPath);
    const tempPrefix = `.${path.basename(profilesPath)}.garda-commit-`;
    const matchingPaths = fs.readdirSync(directoryPath)
        .filter((entry) => entry.startsWith(tempPrefix))
        .map((entry) => path.join(directoryPath, entry))
        .filter((candidatePath) => {
            try {
                const identity = lstatFileIdentitySync(candidatePath);
                return identity.isFile()
                    && !identity.isSymbolicLink()
                    && profileFileIdentityMatches(identity, publishedIdentity);
            } catch (error: unknown) {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
                throw error;
            }
        });
    if (matchingPaths.length !== 1) {
        throw new Error('Published profiles config hard link could not be authenticated for recovery.');
    }
    if (!unlinkObservedPath(matchingPaths[0], publishedIdentity)) {
        throw new Error('Published profiles config temporary link changed before recovery cleanup.');
    }
    const settledIdentity = lstatFileIdentitySync(profilesPath);
    if (
        !profileFileIdentityMatches(settledIdentity, publishedIdentity)
        || settledIdentity.nlink !== 1
    ) {
        throw new Error('Published profiles config did not settle to one authenticated link.');
    }
    fsyncProfilesDirectoryBestEffort(directoryPath);
}

function recoverPendingProfilesClaim(
    profilesPath: string,
    ownership?: ProfileBundleRootOwnership
): void {
    const claims = listPendingProfilesClaims(profilesPath);
    if (claims.length === 0) return;
    if (claims.length > 1) {
        throw new Error('Multiple pending profiles config claims require manual recovery.');
    }
    const claim = claims[0];
    const claimedPath = claim.path;
    const claimedFd = openExistingProfilesConfig(claimedPath, ownership, true);
    let claimedIdentity: fs.Stats;
    let claimedConfigSha256: string;
    try {
        claimedIdentity = fs.fstatSync(claimedFd);
        claimedConfigSha256 = hashProfilesConfigData(readProfilesDataFromDescriptor(claimedFd));
    } finally {
        fs.closeSync(claimedFd);
    }
    if (claimedConfigSha256 !== claim.beforeConfigSha256) {
        throw new Error('Pending profiles config claim does not match its authenticated before hash.');
    }
    if (!fs.existsSync(profilesPath)) {
        restoreClaimedProfilesConfig(claimedPath, profilesPath, claimedIdentity);
        return;
    }
    const currentFd = openExistingProfilesConfig(profilesPath, ownership, true);
    let currentIdentity: fs.Stats;
    let currentConfigSha256: string;
    try {
        currentIdentity = fs.fstatSync(currentFd);
        currentConfigSha256 = hashProfilesConfigData(readProfilesDataFromDescriptor(currentFd));
    } finally {
        fs.closeSync(currentFd);
    }
    const restorationPending = profileFileIdentityMatches(currentIdentity, claimedIdentity);
    if (restorationPending) {
        if (currentConfigSha256 !== claim.beforeConfigSha256) {
            throw new Error('Restored profiles config diverges from the pending claim before hash.');
        }
        if (!unlinkObservedPath(claimedPath, claimedIdentity)) {
            throw new Error('Restored profiles config claim changed before recovery cleanup.');
        }
        fsyncProfilesDirectoryBestEffort(path.dirname(profilesPath));
        return;
    }
    if (currentConfigSha256 !== claim.afterConfigSha256) {
        throw new Error('Published profiles config diverges from the pending claim after hash; recovery stopped.');
    }
    if (currentIdentity.nlink === 2) removePublishedProfilesTempLink(profilesPath, currentIdentity);
    if (!unlinkObservedPath(claimedPath, claimedIdentity)) {
        throw new Error('Pending profiles config claim changed before recovery cleanup.');
    }
    fsyncProfilesDirectoryBestEffort(path.dirname(profilesPath));
}

function writeOwnedProfilesDataAtomically(
    profilesPath: string,
    data: ProfilesData,
    ownership: ProfileBundleRootOwnership,
    expectedCurrentConfigSha256: string
): void {
    const validated = validateProfilesConfig(data) as unknown as ProfilesData;
    const committedConfigSha256 = hashProfilesConfigData(validated);
    const directoryPath = path.dirname(profilesPath);
    const tempPath = path.join(
        directoryPath,
        `.${path.basename(profilesPath)}.garda-commit-${process.pid}-${randomUUID()}`
    );
    const claimedPath = path.join(
        directoryPath,
        `.${path.basename(profilesPath)}.garda-claimed-` +
        `${expectedCurrentConfigSha256}-${committedConfigSha256}-${process.pid}-${randomUUID()}`
    );
    let profilesFd: number | null = openExistingProfilesConfig(profilesPath, ownership);
    let tempPrepared = false;
    let claimedIdentity: fs.Stats | null = null;
    let replacementLinked = false;
    try {
        assertCurrentProfilesConfigState(
            profilesPath,
            profilesFd,
            ownership,
            expectedCurrentConfigSha256
        );
        writeTextFileAtomically(tempPath, JSON.stringify(validated, null, 2), {
            trailingNewline: true,
            fsync: true
        });
        tempPrepared = true;
        const tempIdentity = fs.lstatSync(tempPath);
        if (!tempIdentity.isFile() || tempIdentity.isSymbolicLink() || tempIdentity.nlink !== 1) {
            throw new Error('Prepared profiles config replacement must be a unique regular file.');
        }
        const expectedIdentity = assertCurrentProfilesConfigState(
            profilesPath,
            profilesFd,
            ownership,
            expectedCurrentConfigSha256
        );
        fs.closeSync(profilesFd);
        profilesFd = null;
        fs.renameSync(profilesPath, claimedPath);
        claimedIdentity = lstatFileIdentitySync(claimedPath);
        assertClaimedProfilesConfigState(
            claimedPath,
            expectedIdentity,
            ownership,
            expectedCurrentConfigSha256
        );
        fs.linkSync(tempPath, profilesPath);
        replacementLinked = true;
        fs.unlinkSync(tempPath);
        tempPrepared = false;
        fsyncProfilesDirectoryBestEffort(directoryPath);
        assertProfileBundleRootOwnershipCurrent(ownership);
        const committedFd = openExistingProfilesConfig(profilesPath, ownership);
        try {
            if (hashProfilesConfigData(readProfilesDataFromDescriptor(committedFd)) !== committedConfigSha256) {
                throw new Error('Profiles config atomic replacement could not be verified.');
            }
        } finally {
            fs.closeSync(committedFd);
        }
        if (!unlinkObservedPath(claimedPath, claimedIdentity)) {
            throw new Error('Claimed profiles config path changed before commit cleanup.');
        }
        claimedIdentity = null;
        fsyncProfilesDirectoryBestEffort(directoryPath);
    } catch (error: unknown) {
        if (claimedIdentity && !replacementLinked) {
            try {
                restoreClaimedProfilesConfig(claimedPath, profilesPath, claimedIdentity);
                claimedIdentity = null;
            } catch (restoreError: unknown) {
                throw new AggregateError(
                    [error, restoreError],
                    'Profiles config replacement failed and the claimed config could not be restored safely.'
                );
            }
        }
        throw error;
    } finally {
        if (profilesFd !== null) fs.closeSync(profilesFd);
        if (tempPrepared) {
            try {
                assertProfileBundleRootOwnershipCurrent(ownership);
                const tempIdentity = fs.lstatSync(tempPath);
                if (tempIdentity.isFile() && !tempIdentity.isSymbolicLink() && tempIdentity.nlink === 1) {
                    fs.unlinkSync(tempPath);
                }
            } catch {
                // Never clean up through a changed ownership boundary.
            }
        }
    }
}

type ProfilesLockRelease = (operationCompleted: boolean) => void;

function acquireProfilesLock(lockPath: string): number {
    let lockFd: number | null = null;
    for (let attempt = 0; attempt < PROFILE_LOCK_MAX_ATTEMPTS && lockFd === null; attempt += 1) {
        try {
            lockFd = createProfilesLock(lockPath);
        } catch (error: unknown) {
            if (removeDeadProfilesLock(lockPath)) continue;
            const errorCode = String((error as NodeJS.ErrnoException).code || '').toUpperCase();
            if (errorCode === 'EEXIST' && attempt + 1 < PROFILE_LOCK_MAX_ATTEMPTS) {
                waitForProfilesLockRetry();
                continue;
            }
            const message = error instanceof Error ? error.message : String(error);
            throw new ProfilesConfigLockAcquisitionError(`Could not acquire profiles config lock: ${message}`, {
                cause: error
            });
        }
    }
    if (lockFd === null) throw new ProfilesConfigLockAcquisitionError('Could not acquire profiles config lock.');
    return lockFd;
}

function failProfilesOperation(error: unknown, release: ProfilesLockRelease): never {
    try {
        release(false);
    } catch (releaseError: unknown) {
        throw new AggregateError(
            [error, releaseError],
            'Profiles operation and config lock release both failed.'
        );
    }
    throw error;
}

function settleProfilesOperation<T>(result: T, release: ProfilesLockRelease): T {
    if (result && typeof (result as unknown as PromiseLike<unknown>).then === 'function') {
        return Promise.resolve(result).then(
            (value) => {
                try {
                    release(true);
                } catch (error: unknown) {
                    if (error instanceof ProfilesConfigLockReleaseError) error.operationResult = value;
                    throw error;
                }
                return value;
            },
            (operationError: unknown) => failProfilesOperation(operationError, release)
        ) as T;
    }
    try {
        release(true);
    } catch (error: unknown) {
        if (error instanceof ProfilesConfigLockReleaseError) error.operationResult = result;
        throw error;
    }
    return result;
}

export function withProfilesDataLock<T>(
    profilesPath: string,
    operation: () => T,
    ownership?: ProfileBundleRootOwnership
): T {
    assertProfilesDirectoryBoundary(profilesPath, ownership);
    const lockPath = `${profilesPath}.garda-write.lock`;
    const lockFd = acquireProfilesLock(lockPath);
    let released = false;
    const release = (operationCompleted: boolean): void => {
        if (released) return;
        released = true;
        releaseProfilesLock(lockPath, lockFd, operationCompleted);
    };
    try {
        recoverPendingProfilesClaim(profilesPath, ownership);
        return settleProfilesOperation(operation(), release);
    } catch (error: unknown) {
        if (released) throw error;
        return failProfilesOperation(error, release);
    }
}

function releaseProfilesLock(lockPath: string, lockFd: number, operationCompleted: boolean): void {
    const cleanupPath = `${lockPath}.dead-owner-cleanup`;
    const cleanupFd = acquireProfilesCleanupLock(cleanupPath);
    let lockClosed = false;
    let releaseFailure: unknown = null;
    try {
        if (cleanupFd === null) {
            markProfilesLockReleased(lockFd);
        } else {
            releaseFailure = releaseOwnedProfilesLockPath(
                lockPath,
                lockFd,
                'Profiles config lock path changed before release.'
            );
            lockClosed = true;
        }
    } catch (error: unknown) {
        releaseFailure = error;
    } finally {
        if (!lockClosed) {
            try { fs.closeSync(lockFd); } catch (error: unknown) { releaseFailure ||= error; }
        }
        if (cleanupFd !== null) {
            const cleanupFailure = releaseOwnedCleanupGuard(cleanupPath, cleanupFd);
            releaseFailure ||= cleanupFailure;
        }
    }
    if (releaseFailure !== null) {
        const message = releaseFailure instanceof Error ? releaseFailure.message : String(releaseFailure);
        throw new ProfilesConfigLockReleaseError(
            `Could not release profiles config lock: ${message}`,
            operationCompleted,
            { cause: releaseFailure }
        );
    }
}

function releaseOwnedCleanupGuard(cleanupPath: string, cleanupFd: number): unknown | null {
    return releaseOwnedProfilesLockPath(
        cleanupPath,
        cleanupFd,
        'Profiles cleanup lock path changed before release.'
    );
}

function releaseOwnedProfilesLockPath(
    lockPath: string,
    lockFd: number,
    changedPathMessage: string
): unknown | null {
    let identity: fs.Stats | null = null;
    let lockId: string | null = null;
    let failure: unknown | null = null;
    try {
        lockId = markProfilesLockReleased(lockFd);
        identity = fs.fstatSync(lockFd);
    } catch (error: unknown) {
        failure = error;
    }
    try { fs.closeSync(lockFd); } catch (error: unknown) { failure ||= error; }
    if (identity && lockId && failure === null) {
        try {
            if (!claimAndUnlinkOwnedProfilesLockPath(lockPath, identity, lockId)) {
                failure = new Error(changedPathMessage);
            }
        } catch (error: unknown) {
            failure = error;
        }
    }
    return failure;
}

function markProfilesLockReleased(lockFd: number): string {
    const owner = readProfilesLockOwner(lockFd);
    const lockId = typeof owner.lock_id === 'string' ? owner.lock_id.trim() : '';
    if (!lockId) {
        throw new Error('Profiles config lock owner id is missing before release.');
    }
    fs.ftruncateSync(lockFd, 0);
    fs.writeSync(lockFd, JSON.stringify({
        ...owner,
        released: true,
        released_at_utc: new Date().toISOString()
    }), 0, 'utf8');
    fs.fsyncSync(lockFd);
    return lockId;
}

function waitForProfilesLockRetry(): void {
    const signal = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
    Atomics.wait(signal, 0, 0, PROFILE_LOCK_RETRY_DELAY_MS);
}

function openPathWithoutFollowing(filePath: string, flags: number): number {
    return fs.openSync(filePath, flags | fs.constants.O_NOFOLLOW);
}

function openExistingProfilesConfig(
    profilesPath: string,
    ownership?: ProfileBundleRootOwnership,
    allowRecoveryHardLink = false
): number {
    assertProfilesDirectoryBoundary(profilesPath, ownership);
    const initialIdentity = lstatFileIdentitySync(profilesPath);
    if (!initialIdentity.isFile() || initialIdentity.isSymbolicLink()) {
        throw new Error('Profiles config must be a regular file inside the bundle.');
    }
    if (initialIdentity.nlink !== 1 && !(allowRecoveryHardLink && initialIdentity.nlink === 2)) {
        throw new ProfilesConfigAdditionalLinksError();
    }
    const profilesFd = openPathWithoutFollowing(profilesPath, fs.constants.O_RDONLY);
    try {
        const openedIdentity = fs.fstatSync(profilesFd);
        const pathIdentity = lstatFileIdentitySync(profilesPath);
        if (!openedIdentity.isFile() || !pathIdentity.isFile() || pathIdentity.isSymbolicLink()) {
            throw new Error('Profiles config must be a regular file inside the bundle.');
        }
        if (
            (openedIdentity.nlink !== 1 && !(allowRecoveryHardLink && openedIdentity.nlink === 2))
            || (pathIdentity.nlink !== 1 && !(allowRecoveryHardLink && pathIdentity.nlink === 2))
        ) {
            throw new ProfilesConfigAdditionalLinksError();
        }
        if (
            !profileFileIdentityMatches(openedIdentity, initialIdentity)
            || !profileFileIdentityMatches(openedIdentity, pathIdentity)
        ) {
            throw new Error('Profiles config path changed while it was opened.');
        }
        assertProfilesDirectoryBoundary(profilesPath, ownership);
        return profilesFd;
    } catch (error: unknown) {
        fs.closeSync(profilesFd);
        throw error;
    }
}

function assertOpenedPathIdentity(filePath: string, fd: number, expectedIdentity?: fs.Stats): fs.Stats {
    const openedIdentity = fs.fstatSync(fd);
    const pathIdentity = lstatFileIdentitySync(filePath);
    if (!openedIdentity.isFile() || !pathIdentity.isFile() || pathIdentity.isSymbolicLink()) {
        throw new Error('Profiles config lock must be a regular file.');
    }
    if (!profileFileIdentityMatches(openedIdentity, pathIdentity)) {
        throw new Error('Profiles config lock path changed while it was opened.');
    }
    if (expectedIdentity && !profileFileIdentityMatches(openedIdentity, expectedIdentity)) {
        throw new Error('Profiles config lock does not match the prepared owner file.');
    }
    return openedIdentity;
}

function openExistingProfilesLock(filePath: string, flags: number): number {
    const fd = openPathWithoutFollowing(filePath, flags);
    try {
        const identity = assertOpenedPathIdentity(filePath, fd);
        if (identity.nlink !== 1) throw new Error('Profiles config lock must not have additional hard links.');
        return fd;
    } catch (error: unknown) {
        fs.closeSync(fd);
        throw error;
    }
}

function createProfilesLock(lockPath: string): number {
    return createOwnedProfilesLock(lockPath, {
        lock_id: randomUUID(),
        pid: process.pid,
        created_at_utc: new Date().toISOString()
    });
}

function createOwnedProfilesLock(lockPath: string, owner: Record<string, unknown>): number {
    let lockFd: number | null = null;
    let lockIdentity: fs.Stats | null = null;
    try {
        const flags = fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR;
        lockFd = openPathWithoutFollowing(lockPath, flags);
        fs.writeFileSync(lockFd, JSON.stringify(owner));
        fs.fsyncSync(lockFd);
        lockIdentity = assertOpenedPathIdentity(lockPath, lockFd);
        if (lockIdentity.nlink !== 1) {
            throw new Error('Profiles config lock must not have additional hard links.');
        }
        const result = lockFd;
        lockFd = null;
        return result;
    } catch (error: unknown) {
        if (lockFd !== null) {
            try { lockIdentity ||= fs.fstatSync(lockFd); } catch { /* descriptor may be invalid */ }
            try { fs.closeSync(lockFd); } catch { /* best-effort descriptor cleanup */ }
        }
        if (lockIdentity) {
            try { unlinkObservedPath(lockPath, lockIdentity); } catch { /* uncertain ownership remains fail-closed */ }
        }
        throw error;
    }
}

function removeDeadProfilesLock(lockPath: string): boolean {
    const cleanupPath = `${lockPath}.dead-owner-cleanup`;
    const cleanupFd = acquireProfilesCleanupLock(cleanupPath);
    if (cleanupFd === null) return false;
    let removed = false;
    try {
        removed = tryRemoveDeadProfilesLock(lockPath);
    } catch {
        removed = false;
    }
    const cleanupFailure = releaseOwnedCleanupGuard(cleanupPath, cleanupFd);
    if (cleanupFailure) {
        const message = cleanupFailure instanceof Error ? cleanupFailure.message : String(cleanupFailure);
        throw new ProfilesConfigLockAcquisitionError(
            `Could not release profiles dead-owner cleanup guard: ${message}`,
            { cause: cleanupFailure }
        );
    }
    return removed;
}

function tryRemoveDeadProfilesLock(lockPath: string): boolean {
    const lockFd = openExistingProfilesLock(lockPath, fs.constants.O_RDONLY);
    let observedIdentity: fs.Stats;
    let owner: Record<string, unknown>;
    try {
        observedIdentity = fs.fstatSync(lockFd);
        try {
            owner = readProfilesLockOwner(lockFd);
        } catch {
            return removeAgedMalformedLock(lockPath, observedIdentity, MALFORMED_PROFILE_LOCK_MIN_AGE_MS);
        }
    } finally {
        fs.closeSync(lockFd);
    }
    const pid = Number(owner.pid);
    const explicitlyReleased = owner.released === true;
    if (!explicitlyReleased && (!Number.isSafeInteger(pid) || pid <= 0)) {
        return removeAgedMalformedLock(lockPath, observedIdentity, MALFORMED_PROFILE_LOCK_MIN_AGE_MS);
    }
    if (!explicitlyReleased && isProcessAlive(pid)) return false;
    return unlinkObservedPath(lockPath, observedIdentity);
}

function acquireProfilesCleanupLock(cleanupPath: string): number | null {
    for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
            return createProfilesCleanupLock(cleanupPath);
        } catch (error: unknown) {
            const errorCode = String((error as NodeJS.ErrnoException).code || '').toUpperCase();
            if (attempt === 0 && errorCode === 'EEXIST' && removeDeadCleanupLock(cleanupPath)) continue;
            return null;
        }
    }
    return null;
}

function createProfilesCleanupLock(cleanupPath: string): number {
    return createOwnedProfilesLock(cleanupPath, {
        lock_id: randomUUID(),
        pid: process.pid,
        created_at_utc: new Date().toISOString()
    });
}

function restoreMismatchedProfilesLockClaim(claimedPath: string, originalPath: string): void {
    if (fs.existsSync(originalPath)) {
        throw new Error('Profiles config lock replacement could not be restored because the original path is occupied.');
    }
    fs.renameSync(claimedPath, originalPath);
}

function claimAndUnlinkOwnedProfilesLockPath(
    lockPath: string,
    observedIdentity: fs.Stats,
    expectedLockId: string
): boolean {
    const currentIdentity = lstatFileIdentitySync(lockPath);
    if (!currentIdentity.isFile() || currentIdentity.isSymbolicLink()) return false;
    if (!profileFileIdentityMatches(currentIdentity, observedIdentity)) return false;

    const claimedPath = `${lockPath}.garda-release-${process.pid}-${randomUUID()}`;
    fs.renameSync(lockPath, claimedPath);
    let restoreClaim = true;
    try {
        const claimedFd = openExistingProfilesLock(claimedPath, fs.constants.O_RDONLY);
        let claimedIdentity: fs.Stats;
        let claimedOwner: Record<string, unknown>;
        try {
            claimedIdentity = fs.fstatSync(claimedFd);
            claimedOwner = readProfilesLockOwner(claimedFd);
        } finally {
            fs.closeSync(claimedFd);
        }
        const claimedLockId = typeof claimedOwner.lock_id === 'string'
            ? claimedOwner.lock_id.trim()
            : '';
        if (
            !profileFileIdentityMatches(claimedIdentity, observedIdentity)
            || claimedLockId !== expectedLockId
            || claimedOwner.released !== true
        ) {
            restoreMismatchedProfilesLockClaim(claimedPath, lockPath);
            restoreClaim = false;
            return false;
        }
        if (!unlinkObservedPath(claimedPath, claimedIdentity)) {
            throw new Error('Profiles config lock release claim changed before cleanup.');
        }
        restoreClaim = false;
        return true;
    } catch (error: unknown) {
        if (!restoreClaim) throw error;
        try {
            restoreMismatchedProfilesLockClaim(claimedPath, lockPath);
        } catch (restoreError: unknown) {
            throw new AggregateError(
                [error, restoreError],
                'Profiles config lock release claim failed and could not be restored safely.'
            );
        }
        throw error;
    }
}

function removeDeadCleanupLock(cleanupPath: string): boolean {
    try {
        const cleanupFd = openExistingProfilesLock(cleanupPath, fs.constants.O_RDONLY);
        let observedIdentity: fs.Stats;
        let owner: Record<string, unknown>;
        try {
            observedIdentity = fs.fstatSync(cleanupFd);
            try {
                owner = readProfilesLockOwner(cleanupFd);
            } catch {
                return removeAgedMalformedLock(cleanupPath, observedIdentity, MALFORMED_CLEANUP_LOCK_MIN_AGE_MS);
            }
        } finally {
            fs.closeSync(cleanupFd);
        }
        const pid = Number(owner.pid);
        const explicitlyReleased = owner.released === true;
        if (!explicitlyReleased && (!Number.isSafeInteger(pid) || pid <= 0)) {
            return removeAgedMalformedLock(cleanupPath, observedIdentity, MALFORMED_CLEANUP_LOCK_MIN_AGE_MS);
        }
        if (!explicitlyReleased && isProcessAlive(pid)) return false;
        return unlinkObservedPath(cleanupPath, observedIdentity);
    } catch {
        return false;
    }
}

function readProfilesLockOwner(lockFd: number): Record<string, unknown> {
    const size = fs.fstatSync(lockFd).size;
    const raw = Buffer.alloc(size);
    if (size > 0) fs.readSync(lockFd, raw, 0, size, 0);
    const parsed = JSON.parse(raw.toString('utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('Profiles config lock owner metadata must be an object.');
    }
    return parsed as Record<string, unknown>;
}

function removeAgedMalformedLock(lockPath: string, identity: fs.Stats, minimumAgeMs: number): boolean {
    if (Date.now() - identity.mtimeMs < minimumAgeMs) return false;
    return unlinkObservedPath(lockPath, identity);
}

function unlinkObservedPath(filePath: string, observedIdentity: fs.Stats): boolean {
    const currentIdentity = lstatFileIdentitySync(filePath);
    if (!currentIdentity.isFile() || currentIdentity.isSymbolicLink()) return false;
    if (!profileFileIdentityMatches(currentIdentity, observedIdentity)) return false;
    fs.unlinkSync(filePath);
    return true;
}

function isProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error: unknown) {
        return (error as NodeJS.ErrnoException).code !== 'ESRCH';
    }
}

export function isBuiltInProfile(data: ProfilesData, name: string): boolean {
    return Object.hasOwn(data.built_in_profiles, name);
}

export function getAllProfileNames(data: ProfilesData): string[] {
    return [
        ...Object.keys(data.built_in_profiles),
        ...Object.keys(data.user_profiles)
    ];
}

export function getProfileEntry(data: ProfilesData, name: string): ProfileEntry | null {
    if (Object.hasOwn(data.built_in_profiles, name)) return data.built_in_profiles[name];
    if (Object.hasOwn(data.user_profiles, name)) return data.user_profiles[name];
    return null;
}
