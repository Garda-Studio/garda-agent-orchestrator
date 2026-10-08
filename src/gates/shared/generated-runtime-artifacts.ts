import * as path from 'node:path';
import { DEFAULT_BUNDLE_NAME } from '../../core/constants';
import { normalizePath } from './helpers';

function isRuntimeSubtree(normalizedPath: string, segment: string): boolean {
    return normalizedPath === segment.slice(0, -1)
        || normalizedPath.startsWith(segment);
}

export function isGeneratedRuntimeControlPlaneArtifactPath(pathValue: string | null | undefined): boolean {
    const inputPath = path.posix.normalize(normalizePath(String(pathValue || '')));
    const bundlePrefix = `${DEFAULT_BUNDLE_NAME}/`;
    const normalizedPath = inputPath.startsWith(bundlePrefix) ? inputPath.slice(bundlePrefix.length) : inputPath;
    // These are supported bundle-relative namespaces, not arbitrary nested path segments.
    if (!normalizedPath.startsWith('runtime/')) {
        return false;
    }

    if (isRuntimeSubtree(normalizedPath, 'runtime/task-events/')) {
        return true;
    }

    if (isRuntimeSubtree(normalizedPath, 'runtime/reviews/')) {
        return true;
    }

    if (isRuntimeSubtree(normalizedPath, 'runtime/reports/')) {
        return true;
    }

    if (isRuntimeSubtree(normalizedPath, 'runtime/plans/')) {
        return true;
    }

    if (isRuntimeSubtree(normalizedPath, 'runtime/cache/')) {
        return true;
    }

    if (isRuntimeSubtree(normalizedPath, 'runtime/locks/')) {
        return true;
    }

    if (isRuntimeSubtree(normalizedPath, 'runtime/.runtime-mutation-generation/')) {
        return true;
    }

    if (isRuntimeSubtree(normalizedPath, 'runtime/.runtime-mutation-generation.lock/')) {
        return true;
    }

    if (/^runtime\/\.reviews-(?:index|transaction)\.lock(?:\/|$)/i.test(normalizedPath)) {
        return true;
    }

    if (/^runtime\/\.runtime-mutation-generation\.anchor\.json$/i.test(normalizedPath)) {
        return true;
    }

    return /^runtime\/(metrics|task-index|review-index|task-audit-summary)\.(jsonl?|md)$/i.test(normalizedPath);
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
