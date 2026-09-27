import * as fs from 'node:fs';
import * as path from 'node:path';
import { assertContainedDestination, bindContainedDestination, ensureContainedDirectory, writeContainedFile } from '../../core/contained-filesystem';
import { isUpdateMetadata } from './update-availability-source';
import { type UpdateAvailabilityCacheEntry, type UpdateAvailabilitySource, UPDATE_CHECK_TTL_MS } from './update-availability-types';

export function updateCachePaths(source: UpdateAvailabilitySource): { directory: string; file: string; lock: string } {
    const directory = path.join(source.bundleRoot, 'runtime', 'update-availability');
    return { directory, file: path.join(directory, `${source.fingerprint}.json`), lock: path.join(directory, `${source.fingerprint}.lock`) };
}

export function prepareUpdateCache(source: UpdateAvailabilitySource): void {
    const paths = updateCachePaths(source);
    ensureContainedDirectory(source.bundleRoot, paths.directory);
    bindContainedDestination(source.bundleRoot, paths.lock);
}

export function readUpdateCache(source: UpdateAvailabilitySource, now: number): UpdateAvailabilityCacheEntry | null {
    const filePath = updateCachePaths(source).file;
    const binding = bindContainedDestination(source.bundleRoot, filePath);
    if (binding.missingAt) return null;
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.size > 8 * 1024) return null;
    const text = fs.readFileSync(filePath, 'utf8');
    assertContainedDestination(binding);
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { return null; }
    if (!parsed || typeof parsed !== 'object') return null;
    const entry = parsed as UpdateAvailabilityCacheEntry;
    if (entry.schema !== 1 || entry.sourceFingerprint !== source.fingerprint || entry.packageSpec !== source.packageSpec
        || entry.trustPolicy !== source.trustPolicy || entry.transport?.kind !== source.transport.kind
        || entry.transport?.configurationSha256 !== source.transport.configurationSha256
        || typeof entry.attemptId !== 'string' || !/^[a-f0-9]{32}$/u.test(entry.attemptId)
        || !Number.isFinite(entry.attemptedAt) || entry.attemptedAt < 0 || entry.attemptedAt > now
        || !['pending', 'success', 'unavailable'].includes(entry.outcome)
        || (entry.outcome === 'success' ? !isUpdateMetadata(entry.metadata) : entry.metadata !== null)) return null;
    return entry;
}

export function isUpdateCacheFresh(entry: UpdateAvailabilityCacheEntry | null, now: number): boolean {
    return entry !== null && now >= entry.attemptedAt && now - entry.attemptedAt < UPDATE_CHECK_TTL_MS;
}

export function writeUpdateCache(source: UpdateAvailabilitySource, entry: UpdateAvailabilityCacheEntry): void {
    writeContainedFile(source.bundleRoot, updateCachePaths(source).file, JSON.stringify(entry) + '\n');
}
