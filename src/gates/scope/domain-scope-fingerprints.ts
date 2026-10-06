import { matchAnyRegex } from '../../gate-runtime/text-utils';
import {
    readStagedBlobFingerprints,
    type StagedBlobFingerprints
} from '../../core/staged-index-fingerprints';
import { buildScopeContentFingerprint } from '../compile/compile-gate';
import {
    DOMAIN_SCOPE_NAMES,
    type DomainScopeFingerprintEntry,
    type DomainScopeFingerprints,
    type DomainScopeName
} from '../../core/domain-scope-contracts';
import {
    getClassificationConfig,
    isConfigLikePath,
    isRuntimeCodeLikePath,
    isSafeOrdinaryDocumentationPath,
    type ResolvedClassificationConfig
} from '../preflight/classify-change';
import { normalizePath, stringSha256, testPathPrefix } from '../shared/helpers';
import {
    computeReviewRelevantScopeFingerprint,
    computeReviewReuseCodeScopeFingerprint,
    resolveDocumentationReviewScopeHash
} from '../review-reuse/review-reuse';
import { isCloseoutEvidencePath } from './closeout-evidence-paths';
import { canonicalPathList, pathListSha256 } from '../shared/canonical-path-list';

export { DOMAIN_SCOPE_NAMES } from '../../core/domain-scope-contracts';
export type {
    DomainScopeFingerprintEntry,
    DomainScopeFingerprints,
    DomainScopeName
} from '../../core/domain-scope-contracts';

function normalizeDomainScopeHash(value: unknown): string | null {
    const normalized = String(value || '').trim().toLowerCase();
    return /^[0-9a-f]{64}$/u.test(normalized) ? normalized : null;
}

function normalizeDomainScopeFiles(value: unknown): string[] {
    if (!Array.isArray(value)) {
        return [];
    }
    return canonicalPathList(value.map((entry) => normalizePath(entry)).filter(Boolean));
}

function classifyDomainFile(
    filePath: string,
    classificationConfig: ResolvedClassificationConfig
): DomainScopeName {
    const normalizedPath = normalizePath(filePath);
    if (isCloseoutEvidencePath(normalizedPath)) {
        return 'closeout';
    }
    if (isSafeOrdinaryDocumentationPath(normalizedPath, classificationConfig)) {
        return 'docs';
    }
    const testTriggered = matchAnyRegex(normalizedPath, classificationConfig.test_trigger_regexes, {
        skipInvalidRegex: true,
        caseInsensitive: true
    });
    if (testTriggered) {
        return 'test';
    }
    const protectedControlPlane = testPathPrefix(normalizedPath, classificationConfig.protected_control_plane_roots);
    if (protectedControlPlane && isRuntimeCodeLikePath(
        normalizedPath,
        classificationConfig.code_like_regexes,
        classificationConfig.runtime_roots
    )) {
        return 'implementation';
    }
    if (protectedControlPlane || isConfigLikePath(normalizedPath)) {
        return 'config';
    }
    return 'implementation';
}

function buildScopeFingerprintEntry(
    repoRoot: string,
    detectionSource: string,
    includeUntracked: boolean,
    domainFiles: string[],
    stagedBlobFingerprints?: StagedBlobFingerprints
): DomainScopeFingerprintEntry {
    const changedFiles = canonicalPathList(domainFiles.map((entry) => normalizePath(entry)).filter(Boolean));
    const changedFilesSha256 = pathListSha256(changedFiles);
    const scopeContentSha256 = buildScopeContentFingerprint(
        repoRoot,
        detectionSource,
        changedFiles,
        stagedBlobFingerprints
    );
    const useStaged = ['git_staged_only', 'git_staged_plus_untracked'].includes(detectionSource);
    return {
        changed_files: changedFiles,
        changed_files_count: changedFiles.length,
        changed_files_sha256: changedFilesSha256,
        scope_content_sha256: scopeContentSha256,
        scope_sha256: stringSha256(
            [
                detectionSource,
                String(useStaged),
                String(includeUntracked),
                String(changedFiles.length),
                changedFilesSha256 || '',
                scopeContentSha256 || ''
            ].join('|')
        )
    };
}

export function buildDomainScopeFingerprints(options: {
    repoRoot: string;
    detectionSource: string;
    includeUntracked: boolean;
    changedFiles: string[];
    classificationConfig?: ResolvedClassificationConfig;
}): DomainScopeFingerprints {
    const detectionSource = String(options.detectionSource || 'git_auto').trim().toLowerCase() || 'git_auto';
    const includeUntracked = options.includeUntracked === true;
    const useStaged = ['git_staged_only', 'git_staged_plus_untracked'].includes(detectionSource);
    const changedFiles = canonicalPathList(options.changedFiles.map((entry) => normalizePath(entry)).filter(Boolean));
    const stagedBlobFingerprints = useStaged
        ? readStagedBlobFingerprints(options.repoRoot, changedFiles)
        : undefined;
    const classificationConfig = options.classificationConfig || getClassificationConfig(options.repoRoot);
    const byDomain = new Map<DomainScopeName, string[]>(
        DOMAIN_SCOPE_NAMES.map((domain) => [domain, []])
    );
    for (const changedFile of changedFiles) {
        byDomain.get(classifyDomainFile(changedFile, classificationConfig))?.push(changedFile);
    }
    const domains = Object.fromEntries(
        DOMAIN_SCOPE_NAMES.map((domain) => [
            domain,
            buildScopeFingerprintEntry(
                options.repoRoot,
                detectionSource,
                includeUntracked,
                byDomain.get(domain) || [],
                stagedBlobFingerprints
            )
        ])
    ) as Record<DomainScopeName, DomainScopeFingerprintEntry>;
    const fingerprints: DomainScopeFingerprints = {
        schema_version: 1,
        detection_source: detectionSource,
        include_untracked: includeUntracked,
        use_staged: useStaged,
        domains,
        legacy: {
            review_scope_sha256: null,
            code_scope_sha256: null,
            non_test_review_scope_sha256: null,
            code_review_scope_sha256: null
        }
    };
    const legacyPreflight = {
        detection_source: detectionSource,
        include_untracked: includeUntracked,
        changed_files: changedFiles
    };
    fingerprints.legacy.review_scope_sha256 = computeReviewRelevantScopeFingerprint(
        legacyPreflight,
        options.repoRoot,
        classificationConfig,
        stagedBlobFingerprints
    ).review_scope_sha256;
    fingerprints.legacy.non_test_review_scope_sha256 = computeReviewReuseCodeScopeFingerprint(
        'security',
        legacyPreflight,
        options.repoRoot,
        classificationConfig,
        stagedBlobFingerprints
    ).code_scope_sha256;
    fingerprints.legacy.code_review_scope_sha256 = computeReviewReuseCodeScopeFingerprint(
        'code',
        legacyPreflight,
        options.repoRoot,
        classificationConfig,
        stagedBlobFingerprints
    ).code_scope_sha256;
    fingerprints.legacy.code_scope_sha256 = fingerprints.legacy.code_review_scope_sha256;
    return fingerprints;
}

function isDomainScopeRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeDomainScopeFingerprintEntry(value: unknown): DomainScopeFingerprintEntry {
    const record = isDomainScopeRecord(value) ? value : {};
    return {
        changed_files: normalizeDomainScopeFiles(record.changed_files),
        changed_files_count: typeof record.changed_files_count === 'number'
            ? record.changed_files_count
            : normalizeDomainScopeFiles(record.changed_files).length,
        changed_files_sha256: normalizeDomainScopeHash(record.changed_files_sha256),
        scope_content_sha256: normalizeDomainScopeHash(record.scope_content_sha256),
        scope_sha256: normalizeDomainScopeHash(record.scope_sha256)
    };
}

export function normalizeDomainScopeFingerprints(value: unknown): DomainScopeFingerprints | null {
    if (!isDomainScopeRecord(value)) {
        return null;
    }
    const domainsRecord = isDomainScopeRecord(value.domains) ? value.domains : {};
    const legacyRecord = isDomainScopeRecord(value.legacy) ? value.legacy : {};
    return {
        schema_version: 1,
        detection_source: String(value.detection_source || '').trim().toLowerCase() || 'git_auto',
        include_untracked: value.include_untracked === true,
        use_staged: value.use_staged === true,
        domains: Object.fromEntries(
            DOMAIN_SCOPE_NAMES.map((domain) => [domain, normalizeDomainScopeFingerprintEntry(domainsRecord[domain])])
        ) as Record<DomainScopeName, DomainScopeFingerprintEntry>,
        legacy: {
            review_scope_sha256: normalizeDomainScopeHash(legacyRecord.review_scope_sha256),
            code_scope_sha256: normalizeDomainScopeHash(legacyRecord.code_scope_sha256),
            non_test_review_scope_sha256: normalizeDomainScopeHash(legacyRecord.non_test_review_scope_sha256),
            code_review_scope_sha256: normalizeDomainScopeHash(legacyRecord.code_review_scope_sha256)
        }
    };
}

export function getReviewLaneScopeSha256(
    reviewType: string,
    fingerprints: DomainScopeFingerprints | null
): string | null {
    if (!fingerprints) {
        return null;
    }
    const normalizedReviewType = String(reviewType || '').trim().toLowerCase();
    const documentationScopeSha256 = resolveDocumentationReviewScopeHash(fingerprints);
    if (documentationScopeSha256) {
        if (normalizedReviewType === 'test' && fingerprints.domains.test.changed_files.length > 0) {
            return fingerprints.domains.test.scope_sha256
                ? stringSha256(`${documentationScopeSha256}\n${fingerprints.domains.test.scope_sha256}`)
                : null;
        }
        return documentationScopeSha256;
    }
    if (normalizedReviewType === 'test') {
        return fingerprints.legacy.review_scope_sha256;
    }
    if (normalizedReviewType === 'code') {
        return fingerprints.legacy.code_review_scope_sha256
            || fingerprints.legacy.code_scope_sha256
            || fingerprints.legacy.non_test_review_scope_sha256
            || fingerprints.legacy.review_scope_sha256;
    }
    return fingerprints.legacy.non_test_review_scope_sha256
        || fingerprints.legacy.code_scope_sha256
        || fingerprints.legacy.review_scope_sha256;
}

export function reviewLaneScopeSha256Matches(
    reviewType: string,
    fingerprints: Array<DomainScopeFingerprints | null>
): boolean {
    if (fingerprints.length === 0) {
        return false;
    }
    const laneScopeSha256s = fingerprints.map((entry) => getReviewLaneScopeSha256(reviewType, entry));
    const firstLaneScopeSha256 = laneScopeSha256s[0];
    return !!firstLaneScopeSha256
        && laneScopeSha256s.every((entry) => !!entry && entry === firstLaneScopeSha256);
}

export function reviewContextLaneScopeMatchesCurrentPreflight(
    reviewType: string,
    reviewContext: Record<string, unknown> | null | undefined,
    currentPreflight: Record<string, unknown> | null | undefined
): boolean {
    if (!reviewContext || !currentPreflight) {
        return false;
    }
    const contextTreeState = isDomainScopeRecord(reviewContext.tree_state)
        ? reviewContext.tree_state
        : null;
    const contextDomainScopeFingerprints = normalizeDomainScopeFingerprints(
        contextTreeState?.domain_scope_fingerprints
    );
    const metrics = isDomainScopeRecord(currentPreflight.metrics)
        ? currentPreflight.metrics
        : {};
    const currentDomainScopeFingerprints = normalizeDomainScopeFingerprints(
        metrics.domain_scope_fingerprints
    );
    if (!contextDomainScopeFingerprints || !currentDomainScopeFingerprints) {
        return false;
    }
    return reviewLaneScopeSha256Matches(reviewType, [
        contextDomainScopeFingerprints,
        currentDomainScopeFingerprints
    ]);
}

export function getCombinedDomainScopeFingerprint(
    fingerprints: DomainScopeFingerprints | null,
    domains: DomainScopeName[]
): DomainScopeFingerprintEntry | null {
    if (!fingerprints) {
        return null;
    }
    const changedFiles = canonicalPathList(domains.flatMap((domain) => fingerprints.domains[domain].changed_files));
    return {
        changed_files: changedFiles,
        changed_files_count: changedFiles.length,
        changed_files_sha256: pathListSha256(changedFiles),
        scope_content_sha256: stringSha256(
            domains.map((domain) => `${domain}:${fingerprints.domains[domain].scope_content_sha256 || ''}`).join('\n')
        ),
        scope_sha256: stringSha256(
            domains.map((domain) => `${domain}:${fingerprints.domains[domain].scope_sha256 || ''}`).join('\n')
        )
    };
}
