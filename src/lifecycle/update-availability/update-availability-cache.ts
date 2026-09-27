import * as fs from 'node:fs';
import * as path from 'node:path';
import { assertContainedDestination, bindContainedDestination, ensureContainedDirectory, writeContainedFile } from '../../core/contained-filesystem';
import { isUpdateMetadata } from './update-availability-source';
import { type UpdateAvailabilityCacheEntry, type UpdateAvailabilitySource, UPDATE_CHECK_TTL_MS } from './update-availability-types';

export const UPDATE_CACHE_MAX_ENTRIES = 32;
interface CacheEnvelope { schema: 2; automaticBlockedUntil: number; entries: UpdateAvailabilityCacheEntry[] }
const emptyEnvelope = (): CacheEnvelope => ({ schema: 2, automaticBlockedUntil: 0, entries: [] });

export function updateCachePaths(source: UpdateAvailabilitySource): { directory: string; file: string; lock: string } {
    const directory = path.join(source.bundleRoot, 'runtime', 'update-availability');
    return { directory, file: path.join(directory, 'cache.json'), lock: path.join(directory, 'cache.lock') };
}

export function prepareUpdateCache(source: UpdateAvailabilitySource): void {
    const paths = updateCachePaths(source);
    ensureContainedDirectory(source.bundleRoot, paths.directory);
    bindContainedDestination(source.bundleRoot, paths.lock);
}

function readJson(source: UpdateAvailabilitySource, filePath: string, maxBytes: number): unknown {
    const binding = bindContainedDestination(source.bundleRoot, filePath);
    if (binding.missingAt) return null;
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.size > maxBytes) return null;
    const text = fs.readFileSync(filePath, 'utf8');
    assertContainedDestination(binding);
    try { return JSON.parse(text); } catch { return null; }
}

function isCacheEntry(value: unknown, now: number): value is UpdateAvailabilityCacheEntry {
    if (!value || typeof value !== 'object') return false;
    const entry = value as UpdateAvailabilityCacheEntry;
    return entry.schema === 1 && typeof entry.sourceFingerprint === 'string' && /^[a-f0-9]{64}$/u.test(entry.sourceFingerprint)
        && typeof entry.packageSpec === 'string' && entry.packageSpec.length <= 512
        && entry.trustPolicy === 'enforced' && entry.transport?.kind === 'npm-cli'
        && typeof entry.transport.configurationSha256 === 'string' && /^[a-f0-9]{64}$/u.test(entry.transport.configurationSha256)
        && typeof entry.attemptId === 'string' && /^[a-f0-9]{32}$/u.test(entry.attemptId)
        && Number.isFinite(entry.attemptedAt) && entry.attemptedAt >= 0 && entry.attemptedAt <= now
        && ['pending', 'success', 'unavailable'].includes(entry.outcome)
        && (entry.outcome === 'success' ? isUpdateMetadata(entry.metadata) : entry.metadata === null);
}

async function readJsonAsync(source: UpdateAvailabilitySource, filePath: string, maxBytes: number): Promise<unknown> {
    const binding = bindContainedDestination(source.bundleRoot, filePath);
    if (binding.missingAt) return null;
    const stat = await fs.promises.lstat(filePath);
    if (!stat.isFile() || stat.size > maxBytes) return null;
    const text = await fs.promises.readFile(filePath, 'utf8');
    assertContainedDestination(binding);
    if (Buffer.byteLength(text) > maxBytes) return null;
    try { return JSON.parse(text); } catch { return null; }
}

function readEnvelope(source: UpdateAvailabilitySource, now: number): CacheEnvelope {
    return envelopeFor(readJson(source, updateCachePaths(source).file, 128 * 1024), now);
}

function envelopeFor(input: unknown, now: number): CacheEnvelope {
    const value = input as Partial<CacheEnvelope> | null;
    if (!value || value.schema !== 2 || !Array.isArray(value.entries) || value.entries.length > UPDATE_CACHE_MAX_ENTRIES
        || typeof value.automaticBlockedUntil !== 'number' || !Number.isFinite(value.automaticBlockedUntil) || value.automaticBlockedUntil < 0
        || value.automaticBlockedUntil > now + UPDATE_CHECK_TTL_MS || !value.entries.every((entry) => isCacheEntry(entry, now))
        || new Set(value.entries.map((entry) => entry.sourceFingerprint)).size !== value.entries.length) return emptyEnvelope();
    return value as CacheEnvelope;
}

export async function readUpdateCacheStateAsync(source: UpdateAvailabilitySource, now: number): Promise<{ entry: UpdateAvailabilityCacheEntry | null; automaticBlocked: boolean }> {
    const value = await readJsonAsync(source, updateCachePaths(source).file, 128 * 1024);
    const envelope = envelopeFor(value, now);
    const automaticBlocked = envelope.automaticBlockedUntil > now;
    const entry = envelope.entries.find(item => item.sourceFingerprint === source.fingerprint)
        ?? await readJsonAsync(source, path.join(updateCachePaths(source).directory, `${source.fingerprint}.json`), 8 * 1024);
    if (!isCacheEntry(entry, now) || entry.sourceFingerprint !== source.fingerprint || entry.packageSpec !== source.packageSpec
        || entry.transport.configurationSha256 !== source.transport.configurationSha256) return { entry: null, automaticBlocked };
    return { entry, automaticBlocked };
}

export function readUpdateCache(source: UpdateAvailabilitySource, now: number): UpdateAvailabilityCacheEntry | null {
    const entry = readEnvelope(source, now).entries.find((item) => item.sourceFingerprint === source.fingerprint)
        ?? readJson(source, path.join(updateCachePaths(source).directory, `${source.fingerprint}.json`), 8 * 1024);
    if (!isCacheEntry(entry, now) || entry.sourceFingerprint !== source.fingerprint || entry.packageSpec !== source.packageSpec
        || entry.transport.configurationSha256 !== source.transport.configurationSha256) return null;
    return entry;
}

export function isUpdateCacheFresh(entry: UpdateAvailabilityCacheEntry | null, now: number): boolean {
    return entry !== null && now >= entry.attemptedAt && now - entry.attemptedAt < UPDATE_CHECK_TTL_MS;
}

export function isAutomaticUpdateCacheBlocked(source: UpdateAvailabilitySource, now: number): boolean {
    return readEnvelope(source, now).automaticBlockedUntil > now;
}

/** Called under the shared cache lock. Clean up only this source's recognizable legacy cache. */
export function writeUpdateCache(source: UpdateAvailabilitySource, entry: UpdateAvailabilityCacheEntry, now = Date.now()): void {
    const paths = updateCachePaths(source);
    const envelope = readEnvelope(source, now);
    const legacyPath = path.join(paths.directory, `${source.fingerprint}.json`);
    const legacy = readJson(source, legacyPath, 8 * 1024);
    const ownedLegacy = isCacheEntry(legacy, now) && legacy.sourceFingerprint === source.fingerprint;
    envelope.entries = envelope.entries.filter((item) => item.sourceFingerprint !== entry.sourceFingerprint && isUpdateCacheFresh(item, now));
    if (envelope.entries.length >= UPDATE_CACHE_MAX_ENTRIES) {
        envelope.entries.sort((a, b) => a.attemptedAt - b.attemptedAt);
        envelope.entries.shift();
        // A coarse cooldown prevents a second automatic query for a fresh evicted source.
        envelope.automaticBlockedUntil = now + UPDATE_CHECK_TTL_MS;
    }
    envelope.entries.push(entry);
    writeContainedFile(source.bundleRoot, paths.file, JSON.stringify(envelope) + '\n');
    if (ownedLegacy) {
        const binding = bindContainedDestination(source.bundleRoot, legacyPath);
        assertContainedDestination(binding);
        fs.unlinkSync(legacyPath);
    }
}
