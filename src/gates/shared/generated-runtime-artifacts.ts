import { normalizePath } from './helpers';

const USER_OWNED_PREFIXES = Object.freeze([
    'src/',
    'app/',
    'apps/',
    'backend/',
    'frontend/',
    'web/',
    'api/',
    'services/',
    'packages/',
    'tests/',
    'test/',
    '__tests__/',
    'docs/',
    'doc/',
    'fixtures/',
    'testdata/',
    'template/',
    'live/',
    'config/',
    '.github/',
    '.agents/'
]);

function isUnderUserOwnedPrefix(normalizedPath: string): boolean {
    return USER_OWNED_PREFIXES.some((prefix) => (
        normalizedPath === prefix.slice(0, -1) || normalizedPath.startsWith(prefix)
    ));
}

function hasRuntimeSegment(normalizedPath: string, segment: string): boolean {
    return normalizedPath === segment.slice(0, -1)
        || normalizedPath.startsWith(segment)
        || normalizedPath.includes(`/${segment}`);
}

export function isGeneratedRuntimeControlPlaneArtifactPath(pathValue: string | null | undefined): boolean {
    const normalizedPath = normalizePath(String(pathValue || '')).replace(/^\.\//, '');
    if (!normalizedPath || isUnderUserOwnedPrefix(normalizedPath)) {
        return false;
    }

    if (hasRuntimeSegment(normalizedPath, 'runtime/task-events/')) {
        return true;
    }

    if (hasRuntimeSegment(normalizedPath, 'runtime/reviews/')) {
        return true;
    }

    if (hasRuntimeSegment(normalizedPath, 'runtime/reports/')) {
        return true;
    }

    if (hasRuntimeSegment(normalizedPath, 'runtime/plans/')) {
        return true;
    }

    if (hasRuntimeSegment(normalizedPath, 'runtime/cache/')) {
        return true;
    }

    if (hasRuntimeSegment(normalizedPath, 'runtime/locks/')) {
        return true;
    }

    if (hasRuntimeSegment(normalizedPath, 'runtime/.runtime-mutation-generation/')) {
        return true;
    }

    if (hasRuntimeSegment(normalizedPath, 'runtime/.runtime-mutation-generation.lock/')) {
        return true;
    }

    if (/(^|\/)runtime\/\.reviews-(?:index|transaction)\.lock(?:\/|$)/i.test(normalizedPath)) {
        return true;
    }

    if (/(^|\/)runtime\/\.runtime-mutation-generation\.anchor\.json$/i.test(normalizedPath)) {
        return true;
    }

    return /(^|\/)runtime\/(metrics|task-index|review-index|task-audit-summary)\.(jsonl?|md)$/i.test(normalizedPath);
}

export function isSourceCheckoutGeneratedRuntimeArtifactPath(
    pathValue: string | null | undefined,
    isSourceCheckout: boolean
): boolean {
    if (!isSourceCheckout) {
        return false;
    }
    const normalizedPath = normalizePath(String(pathValue || '')).replace(/^\.\//u, '');
    // dist/src is the first launcher runtime candidate in source checkouts, so drift there must stay reviewable.
    return normalizedPath === 'dist/publish-runtime-manifest.json';
}

export function splitGeneratedRuntimeControlPlaneArtifacts(
    changedFiles: string[],
    options: {
        isSourceCheckout?: boolean;
    } = {}
): {
    reviewableFiles: string[];
    ignoredGeneratedRuntimeFiles: string[];
} {
    const reviewableFiles: string[] = [];
    const ignoredGeneratedRuntimeFiles: string[] = [];
    const seenReviewableFiles = new Set<string>();
    const seenIgnoredGeneratedRuntimeFiles = new Set<string>();
    for (const filePath of changedFiles) {
        const normalizedPath = normalizePath(filePath);
        if (!normalizedPath) {
            continue;
        }
        if (
            isGeneratedRuntimeControlPlaneArtifactPath(normalizedPath)
            || isSourceCheckoutGeneratedRuntimeArtifactPath(normalizedPath, options.isSourceCheckout === true)
        ) {
            if (!seenIgnoredGeneratedRuntimeFiles.has(normalizedPath)) {
                seenIgnoredGeneratedRuntimeFiles.add(normalizedPath);
                ignoredGeneratedRuntimeFiles.push(normalizedPath);
            }
            continue;
        }
        if (!seenReviewableFiles.has(normalizedPath)) {
            seenReviewableFiles.add(normalizedPath);
            reviewableFiles.push(normalizedPath);
        }
    }
    return {
        reviewableFiles,
        ignoredGeneratedRuntimeFiles
    };
}

export function buildGeneratedRuntimeArtifactHygieneWarnings(ignoredGeneratedRuntimeFiles: string[]): string[] {
    if (ignoredGeneratedRuntimeFiles.length === 0) {
        return [];
    }
    const preview = ignoredGeneratedRuntimeFiles.slice(0, 5).join(', ');
    const suffix = ignoredGeneratedRuntimeFiles.length > 5 ? `, ... +${ignoredGeneratedRuntimeFiles.length - 5} more` : '';
    return [
        `Ignored ${ignoredGeneratedRuntimeFiles.length} generated runtime/control-plane artifact(s) for scope classification: ${preview}${suffix}.`
    ];
}
