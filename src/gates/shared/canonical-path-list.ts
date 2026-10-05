import { stringSha256 } from './hashing-metrics';

export function canonicalPathList(paths: readonly string[]): string[] {
    // Persisted fingerprints require UTF-16 code-unit order, independent of locale.
    return [...new Set(paths)].sort();
}

export function pathListSha256(paths: readonly string[]): string | null {
    return stringSha256(canonicalPathList(paths).join('\n'));
}
