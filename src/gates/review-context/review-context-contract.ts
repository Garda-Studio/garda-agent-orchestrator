import * as fs from 'node:fs';
import { extractFilePathFromDiffLine, parseUnifiedDiff } from '../../gate-runtime/scoped-diff';
import { fileSha256, normalizePath, parseBool } from '../shared/helpers';
import { isPlainRecord } from '../../core/records';
import { getReviewCoverageContractViolations } from '../review/review-coverage-ledger';
import { resolveReviewCoverageChangedFiles } from './review-coverage-scope';
import {
    isCustomReviewLaneInSnapshot,
    resolveReviewContextLaneBinding,
    type ReviewContextLaneBinding
} from './review-context-lane';
import {
    getReviewRemediationReviewContractViolations,
    type ReviewRemediationReviewContract,
    type ReviewRemediationReviewContractValidationAuthority
} from '../review-remediation/review-remediation-review-contract';
import { resolveCatalogReviewSkillBinding } from './review-context-skill-binding';
import { validateReviewTriggerPolicy } from '../../policy/review-trigger-policy';

const NON_CODE_SCOPE_CATEGORIES = new Set(['docs-only', 'config-only', 'audit-only', 'empty']);
const CODE_SCOPE_CATEGORIES = new Set(['code', 'mixed']);
const SCOPED_DIFF_REVIEW_TYPES = new Set(['db', 'security', 'refactor']);

function normalizeOptionalString(value: unknown): string | null {
    const trimmed = String(value || '').trim();
    return trimmed ? trimmed : null;
}

function normalizeOptionalReviewType(value: unknown): string | null {
    const normalized = normalizeOptionalString(value);
    return normalized ? normalized.toLowerCase() : null;
}

function normalizeOptionalHash(value: unknown): string | null {
    const normalized = normalizeOptionalString(value);
    return normalized ? normalized.toLowerCase() : null;
}

function normalizeOptionalBoolean(value: unknown): boolean | null {
    if (typeof value === 'boolean') {
        return value;
    }
    const normalized = normalizeOptionalString(value)?.toLowerCase();
    if (normalized === 'true') {
        return true;
    }
    if (normalized === 'false') {
        return false;
    }
    return null;
}

function normalizePathList(value: unknown): string[] {
    if (!Array.isArray(value)) {
        return [];
    }
    return [...new Set(value
        .map((entry) => normalizeOptionalString(entry))
        .filter((entry): entry is string => Boolean(entry))
        .map((entry) => normalizePath(entry))
        .filter((entry) => entry.length > 0))].sort();
}

function formatChangedFilesForDiagnostic(changedFiles: readonly string[]): string {
    if (changedFiles.length === 0) {
        return 'none';
    }
    const displayed = changedFiles.slice(0, 8);
    const suffix = changedFiles.length > displayed.length
        ? `, ... +${changedFiles.length - displayed.length} more`
        : '';
    return `${displayed.join(', ')}${suffix}`;
}

function formatPathForDiagnostic(value: string | null | undefined): string {
    return value ? normalizePath(value) : 'missing';
}

function pushPathBindingViolation(options: {
    violations: string[];
    normalizedContextPath: string;
    expectedReviewType: string;
    fieldName: string;
    actual: string | null;
    expected: string | null;
}): void {
    const expected = normalizeOptionalString(options.expected);
    if (!expected) {
        return;
    }
    const actual = normalizeOptionalString(options.actual);
    if (actual && normalizePath(actual) === normalizePath(expected)) {
        return;
    }
    options.violations.push(
        `Review context '${options.normalizedContextPath}' scoped diff metadata for ` +
        `'${options.expectedReviewType}' review has stale ${options.fieldName}. ` +
        `Expected: ${formatPathForDiagnostic(expected)}. Actual: ${formatPathForDiagnostic(actual)}.`
    );
}

function pushHashBindingViolation(options: {
    violations: string[];
    normalizedContextPath: string;
    expectedReviewType: string;
    fieldName: string;
    actual: unknown;
    expected?: string | null;
}): void {
    const expected = normalizeOptionalHash(options.expected);
    if (!expected) {
        return;
    }
    const actual = normalizeOptionalHash(options.actual);
    if (actual === expected) {
        return;
    }
    options.violations.push(
        `Review context '${options.normalizedContextPath}' scoped diff metadata for ` +
        `'${options.expectedReviewType}' review has stale ${options.fieldName}. ` +
        `Expected: ${expected}. Actual: ${actual || 'missing'}.`
    );
}

function extractUnifiedDiffMarkerPath(line: string, marker: '---' | '+++'): string | null {
    const prefix = `${marker} `;
    if (!line.startsWith(prefix)) {
        return null;
    }

    const rawPath = line.substring(prefix.length).split('\t')[0];
    if (rawPath === '/dev/null') {
        return null;
    }
    if (rawPath.startsWith('a/') || rawPath.startsWith('b/')) {
        return normalizePath(rawPath.substring(2));
    }
    return '';
}

function parseUnifiedDiffHunkCounts(line: string): { oldRemaining: number; newRemaining: number } | null {
    const match = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
    if (!match) {
        return null;
    }
    return {
        oldRemaining: match[1] == null ? 1 : Number(match[1]),
        newRemaining: match[2] == null ? 1 : Number(match[2])
    };
}

function consumeUnifiedDiffHunkLine(
    line: string,
    counts: { oldRemaining: number; newRemaining: number }
): { oldRemaining: number; newRemaining: number } {
    if (line.startsWith('\\')) {
        return counts;
    }
    if (line.startsWith(' ')) {
        return {
            oldRemaining: Math.max(0, counts.oldRemaining - 1),
            newRemaining: Math.max(0, counts.newRemaining - 1)
        };
    }
    if (line.startsWith('-')) {
        return {
            oldRemaining: Math.max(0, counts.oldRemaining - 1),
            newRemaining: counts.newRemaining
        };
    }
    if (line.startsWith('+')) {
        return {
            oldRemaining: counts.oldRemaining,
            newRemaining: Math.max(0, counts.newRemaining - 1)
        };
    }
    return counts;
}

function collectDiffHeaderReferencedFiles(
    diffText: string,
    expectedFileSet: ReadonlySet<string>
): { filePaths: string[]; unparseableCount: number } {
    const filePaths = new Set<string>();
    let unparseableCount = 0;
    let hunkCounts: { oldRemaining: number; newRemaining: number } | null = null;
    let currentDiffPath: string | null = null;
    let beforeFirstHunkInCurrentBlock = false;
    const lines = diffText
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .split('\n');

    for (let index = 0; index < lines.length; index++) {
        const line = lines[index];
        if (line.startsWith('diff --git ')) {
            const diffPath = normalizePath(extractFilePathFromDiffLine(line));
            if (diffPath) {
                filePaths.add(diffPath);
            } else {
                unparseableCount++;
            }
            currentDiffPath = diffPath || null;
            beforeFirstHunkInCurrentBlock = true;
            hunkCounts = null;
            continue;
        }

        const nextHunkCounts = parseUnifiedDiffHunkCounts(line);
        if (nextHunkCounts) {
            beforeFirstHunkInCurrentBlock = false;
            hunkCounts = nextHunkCounts;
            continue;
        }

        if (hunkCounts && (hunkCounts.oldRemaining > 0 || hunkCounts.newRemaining > 0)) {
            hunkCounts = consumeUnifiedDiffHunkLine(line, hunkCounts);
            continue;
        }

        const previousLine = index > 0 ? lines[index - 1] : '';
        const nextLine = index + 1 < lines.length ? lines[index + 1] : '';
        if (line.startsWith('--- ') && nextLine.startsWith('+++ ')) {
            const oldPath = extractUnifiedDiffMarkerPath(line, '---');
            const newPath = extractUnifiedDiffMarkerPath(nextLine, '+++');
            if (oldPath === '' || newPath === '') {
                unparseableCount++;
                index++;
                continue;
            }

            const pairPaths = [oldPath, newPath]
                .filter((filePath): filePath is string => filePath != null);
            const currentFilePath = currentDiffPath;
            const pairBelongsToCurrentDiffHeader = beforeFirstHunkInCurrentBlock
                && currentFilePath != null
                && expectedFileSet.has(currentFilePath)
                && (newPath === currentFilePath || (newPath == null && oldPath === currentFilePath));
            if (pairBelongsToCurrentDiffHeader && currentFilePath != null) {
                filePaths.add(currentFilePath);
            } else {
                pairPaths.forEach((filePath) => filePaths.add(filePath));
            }
            index++;
            continue;
        }

        if (line.startsWith('+++ ') && !previousLine.startsWith('--- ')) {
            const markerPath = extractUnifiedDiffMarkerPath(line, '+++');
            if (markerPath === '') {
                unparseableCount++;
            } else if (markerPath != null) {
                filePaths.add(markerPath);
            }
            continue;
        }
    }

    return {
        filePaths: [...filePaths].sort(),
        unparseableCount
    };
}

function getScopedDiffOutputFileSetViolations(options: {
    contextPath: string;
    expectedReviewType: string;
    metadataOutputPath: string | null;
    expectedChangedFiles: readonly unknown[] | null | undefined;
}): string[] {
    const expectedChangedFiles = normalizePathList(options.expectedChangedFiles);
    if (!options.metadataOutputPath || expectedChangedFiles.length === 0) {
        return [];
    }

    const normalizedContextPath = normalizePath(options.contextPath);
    const changedFilesText = formatChangedFilesForDiagnostic(expectedChangedFiles);
    let diffText = '';
    try {
        diffText = fs.readFileSync(options.metadataOutputPath, 'utf8');
    } catch {
        return [];
    }
    if (!diffText.trim()) {
        return [];
    }

    const blocks = parseUnifiedDiff(diffText);
    const expectedFileSet = new Set(expectedChangedFiles);
    const headerReferences = collectDiffHeaderReferencedFiles(diffText, expectedFileSet);
    if (blocks.length === 0) {
        return [
            `Review context '${normalizedContextPath}' scoped diff output for ` +
            `'${options.expectedReviewType}' review cannot be parsed into diff file blocks. ` +
            `Output path: ${formatPathForDiagnostic(options.metadataOutputPath)}. Changed files: ${changedFilesText}.`
        ];
    }

    const unparseableBlockCount = blocks
        .map((block) => normalizePath(block.filePath))
        .filter((filePath) => filePath.length === 0)
        .length;
    if (unparseableBlockCount > 0) {
        return [
            `Review context '${normalizedContextPath}' scoped diff output for ` +
            `'${options.expectedReviewType}' review contains ${unparseableBlockCount} diff file block(s) ` +
            `with an unparseable path. Output path: ${formatPathForDiagnostic(options.metadataOutputPath)}. ` +
            `Changed files: ${changedFilesText}.`
        ];
    }
    if (headerReferences.unparseableCount > 0) {
        return [
            `Review context '${normalizedContextPath}' scoped diff output for ` +
            `'${options.expectedReviewType}' review contains ${headerReferences.unparseableCount} diff header marker(s) ` +
            `with an unparseable path. Output path: ${formatPathForDiagnostic(options.metadataOutputPath)}. ` +
            `Changed files: ${changedFilesText}.`
        ];
    }

    const outputFiles = [...new Set([
        ...blocks.map((block) => normalizePath(block.filePath)),
        ...headerReferences.filePaths
    ])].sort();
    const unexpectedFiles = outputFiles.filter((filePath) => !expectedFileSet.has(filePath));
    if (unexpectedFiles.length === 0) {
        return [];
    }

    return [
        `Review context '${normalizedContextPath}' scoped diff output for ` +
        `'${options.expectedReviewType}' review contains files outside the current preflight scope. ` +
        `Expected changed files: ${changedFilesText}. ` +
        `Unexpected diff files: ${formatChangedFilesForDiagnostic(unexpectedFiles)}.`
    ];
}

function useStagedExpectedByPreflight(preflight: Record<string, unknown> | null | undefined): boolean {
    const detectionSource = normalizeOptionalString(preflight?.detection_source)?.toLowerCase() || '';
    return detectionSource === 'git_staged_only' || detectionSource === 'git_staged_plus_untracked';
}

export function buildReviewContextPreflightDiffExpectations(
    preflight: Record<string, unknown> | null | undefined,
    reviewType: string
): {
    expectedRequiredReview: boolean;
    expectedChangedFiles: string[];
    expectedScopeCategory: string | null;
    expectedChangedFilesSha256: string | null;
    expectedScopeContentSha256: string | null;
    expectedScopeSha256: string | null;
    expectedScopedDiff: boolean;
    expectedScopedDiffUseStaged: boolean;
} {
    const requiredReviews = isPlainRecord(preflight?.required_reviews)
        ? preflight.required_reviews
        : {};
    const metrics = isPlainRecord(preflight?.metrics)
        ? preflight.metrics
        : {};
    const normalizedReviewType = String(reviewType || '').trim().toLowerCase();
    const customReviewLane = isCustomReviewLaneInSnapshot(preflight, normalizedReviewType);
    const expectedRequiredReview = requiredReviews[normalizedReviewType] === true || customReviewLane;
    const expectedChangedFiles = normalizePathList(preflight?.changed_files);
    const expectedScopeCategory = normalizeOptionalString(preflight?.scope_category)?.toLowerCase() || null;
    return {
        expectedRequiredReview,
        expectedChangedFiles,
        expectedScopeCategory,
        expectedChangedFilesSha256: normalizeOptionalHash(metrics.changed_files_sha256),
        expectedScopeContentSha256: normalizeOptionalHash(metrics.scope_content_sha256),
        expectedScopeSha256: normalizeOptionalHash(metrics.scope_sha256),
        expectedScopedDiffUseStaged: useStagedExpectedByPreflight(preflight),
        expectedScopedDiff: scopedDiffRequiredByPreflight({
            preflight,
            reviewType: normalizedReviewType,
            expectedRequiredReview,
            expectedChangedFiles,
            expectedScopeCategory
        })
    };
}

export function reviewContextTaskDiffRequired(options: {
    expectedRequiredReview?: boolean | null;
    expectedChangedFiles?: readonly unknown[] | null;
    expectedScopeCategory?: string | null;
}): boolean {
    if (options.expectedRequiredReview !== true) {
        return false;
    }
    const changedFiles = normalizePathList(options.expectedChangedFiles);
    if (changedFiles.length === 0) {
        return false;
    }
    const scopeCategory = normalizeOptionalString(options.expectedScopeCategory)?.toLowerCase() || '';
    if (NON_CODE_SCOPE_CATEGORIES.has(scopeCategory)) {
        return false;
    }
    if (CODE_SCOPE_CATEGORIES.has(scopeCategory)) {
        return true;
    }
    return true;
}

export function reviewContextScopedDiffRequired(options: {
    reviewType: string;
    expectedRequiredReview?: boolean | null;
    expectedChangedFiles?: readonly unknown[] | null;
    expectedScopeCategory?: string | null;
    tokenEconomyActiveForDepth?: boolean | null;
    scopedDiffsEnabled?: boolean | null;
    customReviewLane?: boolean | null;
}): boolean {
    const reviewType = normalizeOptionalReviewType(options.reviewType) || '';
    if (!SCOPED_DIFF_REVIEW_TYPES.has(reviewType) && options.customReviewLane !== true) {
        return false;
    }
    if (!reviewContextTaskDiffRequired({
        expectedRequiredReview: options.expectedRequiredReview,
        expectedChangedFiles: options.expectedChangedFiles,
        expectedScopeCategory: options.expectedScopeCategory
    })) {
        return false;
    }
    return options.tokenEconomyActiveForDepth === true
        && options.scopedDiffsEnabled === true;
}

function getRequiredDiffMaterialViolations(options: {
    contextPath: string;
    reviewContext: Record<string, unknown>;
    expectedReviewType: string;
    expectedRequiredReview?: boolean | null;
    expectedChangedFiles?: readonly unknown[] | null;
    expectedScopeCategory?: string | null;
    requireDiffMaterialForRequiredReview?: boolean;
}): string[] {
    if (options.requireDiffMaterialForRequiredReview === false) {
        return [];
    }
    const expectedChangedFiles = normalizePathList(options.expectedChangedFiles);
    const diffRequired = reviewContextTaskDiffRequired({
        expectedRequiredReview: options.expectedRequiredReview,
        expectedChangedFiles,
        expectedScopeCategory: options.expectedScopeCategory
    });
    if (!diffRequired) {
        return [];
    }

    const violations: string[] = [];
    const normalizedContextPath = normalizePath(options.contextPath);
    const taskScope = isPlainRecord(options.reviewContext.task_scope)
        ? options.reviewContext.task_scope
        : null;
    const actualChangedFiles = normalizePathList(taskScope?.changed_files);
    const missingFiles = expectedChangedFiles.filter((changedFile) => !actualChangedFiles.includes(changedFile));
    const unexpectedFiles = actualChangedFiles.filter((changedFile) => !expectedChangedFiles.includes(changedFile));
    const changedFilesText = formatChangedFilesForDiagnostic(expectedChangedFiles);

    if (!taskScope) {
        violations.push(
            `Review context '${normalizedContextPath}' is missing task_scope for required '${options.expectedReviewType}' review. ` +
            `Changed files: ${changedFilesText}.`
        );
    } else if (missingFiles.length > 0 || unexpectedFiles.length > 0) {
        violations.push(
            `Review context '${normalizedContextPath}' task_scope.changed_files does not match the current preflight for required ` +
            `'${options.expectedReviewType}' review. Expected: ${changedFilesText}. ` +
            `Missing: ${formatChangedFilesForDiagnostic(missingFiles)}. ` +
            `Unexpected: ${formatChangedFilesForDiagnostic(unexpectedFiles)}.`
        );
    }

    const diff = isPlainRecord(taskScope?.diff) ? taskScope.diff : null;
    if (diff?.available !== true) {
        const errorText = normalizeOptionalString(diff?.error);
        violations.push(
            `Review context '${normalizedContextPath}' has no task diff material for required '${options.expectedReviewType}' review. ` +
            `Changed files: ${changedFilesText}. task_scope.diff.available must be true before reviewer routing or result recording` +
            `${errorText ? ` (diff error: ${errorText})` : ''}.`
        );
    }

    return violations;
}

function getScopedDiffExpectedViolations(options: {
    contextPath: string;
    reviewContext: Record<string, unknown>;
    expectedReviewType: string;
    expectedPreflightPath?: string | null;
    expectedPreflightSha256?: string | null;
    expectedChangedFiles?: readonly unknown[] | null;
    expectedChangedFilesSha256?: string | null;
    expectedScopeContentSha256?: string | null;
    expectedScopeSha256?: string | null;
    expectedScopedDiff?: boolean | null;
    expectedScopedDiffUseStaged?: boolean | null;
    validateScopedDiffOutputFile?: boolean;
}): string[] {
    const scopedDiff = isPlainRecord(options.reviewContext.scoped_diff)
        ? options.reviewContext.scoped_diff
        : null;
    const contextExpected = scopedDiff?.expected === true;
    const trustedExpected = options.expectedScopedDiff === true;
    if (!contextExpected && !trustedExpected) {
        return [];
    }

    const violations: string[] = [];
    const normalizedContextPath = normalizePath(options.contextPath);
    const metadataPath = normalizeOptionalString(scopedDiff?.metadata_path);
    const metadata = isPlainRecord(scopedDiff?.metadata)
        ? scopedDiff.metadata
        : null;
    const changedFilesText = formatChangedFilesForDiagnostic(normalizePathList(options.expectedChangedFiles));
    if (trustedExpected && !contextExpected) {
        violations.push(
            `Review context '${normalizedContextPath}' must declare scoped_diff.expected=true for required ` +
            `'${options.expectedReviewType}' review according to the current preflight scoped-diff policy. ` +
            `Changed files: ${changedFilesText}.`
        );
    }
    if (!metadata) {
        violations.push(
            `Review context '${normalizedContextPath}' expects scoped diff metadata for ` +
            `'${options.expectedReviewType}' review, but scoped_diff.metadata is missing. ` +
            `Metadata path: ${metadataPath ? normalizePath(metadataPath) : 'missing'}. Changed files: ${changedFilesText}.`
        );
        return violations;
    }

    const normalizedMetadataPath = metadataPath ? normalizePath(metadataPath) : null;
    const metadataReviewType = normalizeOptionalReviewType(metadata.review_type);
    const metadataOutputPath = normalizeOptionalString(metadata.output_path);
    if (metadataReviewType !== options.expectedReviewType) {
        violations.push(
            `Review context '${normalizedContextPath}' scoped diff metadata has stale review_type. ` +
            `Expected '${options.expectedReviewType}'. Actual: '${metadataReviewType || 'missing'}'.`
        );
    }
    pushPathBindingViolation({
        violations,
        normalizedContextPath,
        expectedReviewType: options.expectedReviewType,
        fieldName: 'preflight_path',
        actual: normalizeOptionalString(metadata.preflight_path),
        expected: options.expectedPreflightPath || null
    });
    pushHashBindingViolation({
        violations,
        normalizedContextPath,
        expectedReviewType: options.expectedReviewType,
        fieldName: 'preflight_sha256',
        actual: metadata.preflight_sha256,
        expected: options.expectedPreflightSha256 || null
    });
    pushHashBindingViolation({
        violations,
        normalizedContextPath,
        expectedReviewType: options.expectedReviewType,
        fieldName: 'changed_files_sha256',
        actual: metadata.changed_files_sha256,
        expected: options.expectedChangedFilesSha256 || null
    });
    pushHashBindingViolation({
        violations,
        normalizedContextPath,
        expectedReviewType: options.expectedReviewType,
        fieldName: 'scope_content_sha256',
        actual: metadata.scope_content_sha256,
        expected: options.expectedScopeContentSha256 || null
    });
    pushHashBindingViolation({
        violations,
        normalizedContextPath,
        expectedReviewType: options.expectedReviewType,
        fieldName: 'scope_sha256',
        actual: metadata.scope_sha256,
        expected: options.expectedScopeSha256 || null
    });
    if (options.expectedScopedDiffUseStaged != null) {
        const actualUseStaged = normalizeOptionalBoolean(metadata.use_staged);
        if (actualUseStaged !== options.expectedScopedDiffUseStaged) {
            violations.push(
                `Review context '${normalizedContextPath}' scoped diff metadata for ` +
                `'${options.expectedReviewType}' review has stale use_staged. ` +
                `Expected: ${options.expectedScopedDiffUseStaged}. ` +
                `Actual: ${actualUseStaged == null ? 'missing' : actualUseStaged}.`
            );
        }
    }
    pushPathBindingViolation({
        violations,
        normalizedContextPath,
        expectedReviewType: options.expectedReviewType,
        fieldName: 'metadata_path',
        actual: normalizeOptionalString(metadata.metadata_path),
        expected: normalizedMetadataPath
    });
    if (!metadataOutputPath) {
        violations.push(
            `Review context '${normalizedContextPath}' scoped diff metadata for ` +
            `'${options.expectedReviewType}' review is missing output_path.`
        );
    }

    const outputDiffSha256 = normalizeOptionalHash(metadata.output_diff_sha256);
    if (!outputDiffSha256) {
        violations.push(
            `Review context '${normalizedContextPath}' scoped diff metadata for ` +
            `'${options.expectedReviewType}' review is missing output_diff_sha256.`
        );
    } else if (options.validateScopedDiffOutputFile !== false) {
        const actualOutputDiffSha256 = metadataOutputPath ? fileSha256(metadataOutputPath) : null;
        if (!actualOutputDiffSha256) {
            violations.push(
                `Review context '${normalizedContextPath}' scoped diff metadata for ` +
                `'${options.expectedReviewType}' review points to a missing or unreadable output diff file. ` +
                `Output path: ${formatPathForDiagnostic(metadataOutputPath)}.`
            );
        } else if (actualOutputDiffSha256 !== outputDiffSha256) {
            violations.push(
                `Review context '${normalizedContextPath}' scoped diff metadata for ` +
                `'${options.expectedReviewType}' review has stale output_diff_sha256. ` +
                `Expected: ${actualOutputDiffSha256}. Actual: ${outputDiffSha256}.`
            );
        } else {
            violations.push(...getScopedDiffOutputFileSetViolations({
                contextPath: options.contextPath,
                expectedReviewType: options.expectedReviewType,
                metadataOutputPath,
                expectedChangedFiles: options.expectedChangedFiles
            }));
        }
    }

    const expectedChangedFiles = normalizePathList(options.expectedChangedFiles);
    const metadataChangedFiles = normalizePathList(metadata.changed_files);
    if (expectedChangedFiles.length > 0) {
        const missingFiles = expectedChangedFiles.filter((changedFile) => !metadataChangedFiles.includes(changedFile));
        const unexpectedFiles = metadataChangedFiles.filter((changedFile) => !expectedChangedFiles.includes(changedFile));
        if (metadataChangedFiles.length === 0 || missingFiles.length > 0 || unexpectedFiles.length > 0) {
            violations.push(
                `Review context '${normalizedContextPath}' scoped diff metadata changed_files does not match the current preflight for ` +
                `'${options.expectedReviewType}' review. Expected: ${changedFilesText}. ` +
                `Missing: ${formatChangedFilesForDiagnostic(missingFiles)}. ` +
                `Unexpected: ${formatChangedFilesForDiagnostic(unexpectedFiles)}.`
            );
        }
    }

    const parseError = normalizeOptionalString(metadata.parse_error);
    const outputDiffLineCount = typeof metadata.output_diff_line_count === 'number'
        ? metadata.output_diff_line_count
        : Number(metadata.output_diff_line_count);
    if (parseError) {
        violations.push(
            `Review context '${normalizedContextPath}' scoped diff metadata for ` +
            `'${options.expectedReviewType}' review is invalid: ${parseError}. ` +
            `Metadata path: ${metadataPath ? normalizePath(metadataPath) : 'missing'}.`
        );
    }
    if (!Number.isFinite(outputDiffLineCount) || outputDiffLineCount <= 0) {
        violations.push(
            `Review context '${normalizedContextPath}' scoped diff metadata for ` +
            `'${options.expectedReviewType}' review has no output diff lines. ` +
            `Metadata path: ${metadataPath ? normalizePath(metadataPath) : 'missing'}. Changed files: ${changedFilesText}.`
        );
    }
    return violations;
}

export interface ReviewContextContractValidationOptions {
    contextPath: string;
    reviewContext: Record<string, unknown> | null;
    expectedTaskId?: string | null;
    expectedReviewType: string;
    expectedPreflightPath?: string | null;
    expectedPreflightSha256?: string | null;
    requireReviewType?: boolean;
    requireTaskId?: boolean;
    requirePreflightPath?: boolean;
    requirePreflightSha256?: boolean;
    expectedRequiredReview?: boolean | null;
    expectedChangedFiles?: readonly unknown[] | null;
    expectedCoverageChangedFiles?: readonly unknown[] | null;
    expectedPreflightPayload?: Record<string, unknown> | null;
    repoRoot?: string | null;
    expectedScopeCategory?: string | null;
    expectedChangedFilesSha256?: string | null;
    expectedScopeContentSha256?: string | null;
    expectedScopeSha256?: string | null;
    expectedScopedDiff?: boolean | null;
    expectedScopedDiffUseStaged?: boolean | null;
    validateScopedDiffOutputFile?: boolean;
    requireDiffMaterialForRequiredReview?: boolean;
    expectedReviewExecutionValidationAuthority?: ReviewRemediationReviewContractValidationAuthority | null;
}

export function getReviewContextContractViolations(
    options: ReviewContextContractValidationOptions
): string[] {
    const reviewContext = options.reviewContext;
    if (!reviewContext || typeof reviewContext !== 'object' || Array.isArray(reviewContext)) {
        return [];
    }

    const violations: string[] = [];
    const normalizedContextPath = normalizePath(options.contextPath);
    const expectedReviewType = normalizeOptionalReviewType(options.expectedReviewType) || '';
    const expectedTaskId = normalizeOptionalString(options.expectedTaskId);
    const expectedPreflightPath = normalizeOptionalString(options.expectedPreflightPath);
    const expectedPreflightSha256 = normalizeOptionalHash(options.expectedPreflightSha256);

    const actualReviewType = normalizeOptionalReviewType(reviewContext.review_type);
    const actualTaskId = normalizeOptionalString(reviewContext.task_id);
    const actualPreflightPath = normalizeOptionalString(reviewContext.preflight_path);
    const actualPreflightSha256 = normalizeOptionalHash(reviewContext.preflight_sha256);
    let expectedLaneBinding: ReviewContextLaneBinding | null = null;
    if (options.expectedPreflightPayload?.effective_review_snapshot !== undefined) {
        try {
            expectedLaneBinding = resolveReviewContextLaneBinding(
                options.expectedPreflightPayload,
                expectedReviewType
            );
        } catch (error: unknown) {
            violations.push(error instanceof Error ? error.message : String(error));
        }
    }

    if (actualReviewType) {
        if (actualReviewType !== expectedReviewType) {
            violations.push(
                `Review context '${normalizedContextPath}' declares review_type '${actualReviewType}', ` +
                `but '${expectedReviewType}' was required.`
            );
        }
    } else if (options.requireReviewType !== false) {
        violations.push(
            `Review context '${normalizedContextPath}' is missing review_type. ` +
            `Expected '${expectedReviewType}'.`
        );
    }

    if (expectedTaskId) {
        if (actualTaskId) {
            if (actualTaskId !== expectedTaskId) {
                violations.push(
                    `Review context '${normalizedContextPath}' belongs to task '${actualTaskId}', ` +
                    `but '${expectedTaskId}' was required.`
                );
            }
        } else if (options.requireTaskId === true) {
            violations.push(
                `Review context '${normalizedContextPath}' is missing task_id. ` +
                `Expected '${expectedTaskId}'.`
            );
        }
    }

    if (expectedPreflightPath) {
        if (actualPreflightPath) {
            const normalizedActualPreflightPath = normalizePath(actualPreflightPath);
            const normalizedExpectedPreflightPath = normalizePath(expectedPreflightPath);
            if (normalizedActualPreflightPath !== normalizedExpectedPreflightPath) {
                violations.push(
                    `Review context '${normalizedContextPath}' points to preflight '${normalizedActualPreflightPath}', ` +
                    `but '${normalizedExpectedPreflightPath}' was required.`
                );
            }
        } else if (options.requirePreflightPath === true) {
            violations.push(
                `Review context '${normalizedContextPath}' is missing preflight_path. ` +
                `Expected '${normalizePath(expectedPreflightPath)}'.`
            );
        }
    }

    if (expectedPreflightSha256) {
        if (actualPreflightSha256) {
            if (actualPreflightSha256 !== expectedPreflightSha256) {
                violations.push(
                    `Review context '${normalizedContextPath}' declares preflight_sha256 '${actualPreflightSha256}', ` +
                    `but '${expectedPreflightSha256}' was required.`
                );
            }
        } else if (options.requirePreflightSha256 === true) {
            violations.push(
                `Review context '${normalizedContextPath}' is missing preflight_sha256. ` +
                `Expected '${expectedPreflightSha256}'.`
            );
        }
    }

    if (expectedLaneBinding && !expectedLaneBinding.built_in) {
        if (JSON.stringify(reviewContext.review_lane) !== JSON.stringify(expectedLaneBinding)) {
            violations.push(
                `Review context '${normalizedContextPath}' custom review_lane binding does not match ` +
                `the immutable effective review snapshot for '${expectedReviewType}'.`
            );
        }
        const ruleContext = isPlainRecord(reviewContext.rule_context) ? reviewContext.rule_context : null;
        const reviewerHandoff = isPlainRecord(reviewContext.reviewer_handoff)
            ? reviewContext.reviewer_handoff
            : null;
        const rolePrompt = isPlainRecord(reviewerHandoff?.role_prompt)
            ? reviewerHandoff.role_prompt
            : null;
        const ruleSelectedSkill = isPlainRecord(ruleContext?.selected_skill)
            ? ruleContext.selected_skill
            : null;
        const roleSelectedSkill = isPlainRecord(rolePrompt?.selected_skill)
            ? rolePrompt.selected_skill
            : null;
        const selectedSkillId = normalizeOptionalString(ruleSelectedSkill?.skill_id);
        if (!selectedSkillId || !expectedLaneBinding.skill_ids.includes(selectedSkillId)) {
            violations.push(
                `Review context '${normalizedContextPath}' custom selected_skill is not bound to ` +
                `immutable lane skill_ids for '${expectedReviewType}'.`
            );
        }
        if (JSON.stringify(ruleSelectedSkill) !== JSON.stringify(roleSelectedSkill)) {
            violations.push(
                `Review context '${normalizedContextPath}' custom selected_skill differs between ` +
                `rule_context and reviewer_handoff.role_prompt.`
            );
        }
        if (JSON.stringify(ruleSelectedSkill?.candidate_skill_ids) !== JSON.stringify(expectedLaneBinding.skill_ids)) {
            violations.push(
                `Review context '${normalizedContextPath}' custom selected_skill candidates do not match ` +
                `immutable lane skill_ids for '${expectedReviewType}'.`
            );
        }
        if (ruleSelectedSkill?.skill_entrypoint_exists !== true
            || !normalizeOptionalHash(ruleSelectedSkill?.skill_sha256)) {
            violations.push(
                `Review context '${normalizedContextPath}' custom selected_skill artifact is missing ` +
                `an authenticated entrypoint hash for '${expectedReviewType}'.`
            );
        }
        if (!options.repoRoot) {
            violations.push(
                `Review context '${normalizedContextPath}' custom selected_skill cannot be authenticated ` +
                `without the current repo root for '${expectedReviewType}'.`
            );
        } else {
            try {
                const expectedSelectedSkill = resolveCatalogReviewSkillBinding(
                    expectedLaneBinding.skill_ids,
                    options.repoRoot
                );
                if (JSON.stringify(ruleSelectedSkill) !== JSON.stringify(expectedSelectedSkill)) {
                    violations.push(
                        `Review context '${normalizedContextPath}' custom selected_skill path or content hash does not match ` +
                        `the current catalog skill entrypoint for '${expectedReviewType}'.`
                    );
                }
            } catch (error) {
                violations.push(
                    `Review context '${normalizedContextPath}' custom selected_skill cannot be authenticated ` +
                    `for '${expectedReviewType}': ${String(error)}`
                );
            }
        }
    }

    violations.push(...getRequiredDiffMaterialViolations({
        contextPath: options.contextPath,
        reviewContext,
        expectedReviewType,
        expectedRequiredReview: options.expectedRequiredReview,
        expectedChangedFiles: options.expectedChangedFiles,
        expectedScopeCategory: options.expectedScopeCategory,
        requireDiffMaterialForRequiredReview: options.requireDiffMaterialForRequiredReview
    }));
    violations.push(...getScopedDiffExpectedViolations({
        contextPath: options.contextPath,
        reviewContext,
        expectedReviewType,
        expectedPreflightPath: options.expectedPreflightPath,
        expectedPreflightSha256: options.expectedPreflightSha256,
        expectedChangedFiles: options.expectedChangedFiles,
        expectedChangedFilesSha256: options.expectedChangedFilesSha256,
        expectedScopeContentSha256: options.expectedScopeContentSha256,
        expectedScopeSha256: options.expectedScopeSha256,
        expectedScopedDiff: options.expectedScopedDiff,
        expectedScopedDiffUseStaged: options.expectedScopedDiffUseStaged,
        validateScopedDiffOutputFile: options.validateScopedDiffOutputFile
    }));
    const treeState = isPlainRecord(reviewContext.tree_state) ? reviewContext.tree_state : null;
    if (treeState?.review_trigger_policy !== undefined) {
        try {
            const profileSnapshot = isPlainRecord(options.expectedPreflightPayload?.profile_policy_snapshot)
                ? options.expectedPreflightPayload.profile_policy_snapshot : null;
            const actualPolicy = validateReviewTriggerPolicy(treeState.review_trigger_policy);
            const expectedPolicy = validateReviewTriggerPolicy(profileSnapshot?.review_trigger_policy);
            if (JSON.stringify(actualPolicy) !== JSON.stringify(expectedPolicy)) {
                violations.push('tree_state.review_trigger_policy does not match the authoritative frozen preflight policy.');
            }
        } catch (error) {
            violations.push(`tree_state.review_trigger_policy binding is invalid: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    const currentPreflightRequiresCoverage = options.expectedPreflightPayload?.review_coverage_contract_required === true;
    const reviewContextSchemaVersion = Number(reviewContext.schema_version);
    if (currentPreflightRequiresCoverage
        && (!Number.isInteger(reviewContextSchemaVersion) || reviewContextSchemaVersion < 4)) {
        violations.push(
            'Generated review coverage context cannot downgrade below schema_version 4; legacy contexts are read-only historical evidence.'
        );
    }
    if (reviewContextSchemaVersion >= 3) {
        const reviewExecution = isPlainRecord(reviewContext.review_execution)
            ? reviewContext.review_execution as unknown as ReviewRemediationReviewContract
            : null;
        let reviewExecutionIsAuthenticated = false;
        if (reviewContextSchemaVersion >= 4) {
            if (!reviewExecution) {
                violations.push('Generated review context is missing the required review_execution contract.');
            } else {
                const initialFullReviewScope = options.repoRoot && options.expectedPreflightPayload
                    ? resolveReviewCoverageChangedFiles({
                        reviewType: expectedReviewType,
                        preflight: options.expectedPreflightPayload,
                        repoRoot: options.repoRoot
                    })
                    : normalizePathList(options.expectedChangedFiles);
                const validationAuthority = reviewExecution.source === 'initial_full'
                    ? {
                        taskId: expectedTaskId || '',
                        reviewType: expectedReviewType,
                        preflightSha256: expectedPreflightSha256 || '',
                        mode: reviewExecution.mode,
                        fullReviewScope: initialFullReviewScope,
                        persistedDecisionSha256: null,
                        authoritativeDecisionSha256: null,
                        authoritativeClassificationSha256: null,
                        authoritativeDecision: null,
                        authoritativeClassification: null
                    } satisfies ReviewRemediationReviewContractValidationAuthority
                    : options.expectedReviewExecutionValidationAuthority ?? null;
                const executionViolations = validationAuthority
                    ? getReviewRemediationReviewContractViolations(reviewExecution, validationAuthority)
                    : ['remediation review_execution validation authority is required before coverage can be trusted.'];
                violations.push(...executionViolations);
                reviewExecutionIsAuthenticated = executionViolations.length === 0;
            }
        }
        const coverageScope = reviewContext.coverage_scope
            && typeof reviewContext.coverage_scope === 'object'
            && !Array.isArray(reviewContext.coverage_scope)
            ? reviewContext.coverage_scope as Record<string, unknown>
            : null;
        const declaredCoverageChangedFiles = normalizePathList(coverageScope?.changed_files);
        const independentlyResolvedCoverageChangedFiles = reviewExecution?.mode === 'DELTA'
            && reviewExecutionIsAuthenticated
            ? reviewExecution.delta?.required_delta_targets ?? []
            : options.repoRoot && options.expectedPreflightPayload
                ? resolveReviewCoverageChangedFiles({
                reviewType: expectedReviewType,
                preflight: options.expectedPreflightPayload,
                repoRoot: options.repoRoot
                })
                : null;
        const expectedCoverageChangedFiles = independentlyResolvedCoverageChangedFiles
            || (options.expectedCoverageChangedFiles == null
                ? declaredCoverageChangedFiles
                : normalizePathList(options.expectedCoverageChangedFiles));
        if (independentlyResolvedCoverageChangedFiles
            && JSON.stringify(declaredCoverageChangedFiles) !== JSON.stringify(independentlyResolvedCoverageChangedFiles)) {
            violations.push(
                `Review coverage scope does not match the independently resolved current preflight scope. ` +
                `Expected ${independentlyResolvedCoverageChangedFiles.join(', ') || 'none'}; ` +
                `actual ${declaredCoverageChangedFiles.join(', ') || 'none'}.`
            );
        }
        const expectedChangedFiles = normalizePathList(options.expectedChangedFiles);
        const unexpectedCoverageFiles = expectedCoverageChangedFiles.filter((filePath) => !expectedChangedFiles.includes(filePath));
        if (unexpectedCoverageFiles.length > 0) {
            violations.push(`Review coverage scope contains files outside the current preflight: ${unexpectedCoverageFiles.join(', ')}.`);
        }
        violations.push(...getReviewCoverageContractViolations(reviewContext.coverage_contract, {
            reviewType: expectedReviewType,
            changedFiles: expectedCoverageChangedFiles,
            categoryIds: expectedLaneBinding && !expectedLaneBinding.built_in
                ? expectedLaneBinding.coverage_category_ids
                : undefined
        }));
    }

    return violations;
}

function scopedDiffRequiredByPreflight(options: {
    preflight: Record<string, unknown> | null | undefined;
    reviewType: string;
    expectedRequiredReview: boolean;
    expectedChangedFiles: readonly unknown[];
    expectedScopeCategory: string | null;
}): boolean {
    return reviewContextScopedDiffRequired({
        reviewType: options.reviewType,
        expectedRequiredReview: options.expectedRequiredReview,
        expectedChangedFiles: options.expectedChangedFiles,
        expectedScopeCategory: options.expectedScopeCategory,
        tokenEconomyActiveForDepth: preflightTokenEconomyActiveForDepth(options.preflight),
        scopedDiffsEnabled: preflightScopedDiffsEnabled(options.preflight),
        customReviewLane: isCustomReviewLaneInSnapshot(options.preflight, options.reviewType)
    });
}

function preflightTokenEconomyActiveForDepth(preflight: Record<string, unknown> | null | undefined): boolean {
    const budgetForecast = isPlainRecord(preflight?.budget_forecast)
        ? preflight.budget_forecast
        : null;
    if (!budgetForecast) {
        return false;
    }
    if ('token_economy_active_for_depth' in budgetForecast) {
        return parseBool(budgetForecast.token_economy_active_for_depth);
    }
    if ('token_economy_active' in budgetForecast) {
        return parseBool(budgetForecast.token_economy_active);
    }
    return false;
}

function preflightScopedDiffsEnabled(preflight: Record<string, unknown> | null | undefined): boolean {
    const riskAwareDepth = isPlainRecord(preflight?.risk_aware_depth)
        ? preflight.risk_aware_depth
        : null;
    const compression = isPlainRecord(riskAwareDepth?.compression)
        ? riskAwareDepth.compression
        : null;
    return compression
        ? parseBool(compression.scoped_diffs)
        : false;
}
