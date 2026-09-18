import * as fs from 'node:fs';
import * as path from 'node:path';
import { convertToGitPathspecs, filterDiffByHunks, parseUnifiedDiff, reassembleDiff } from '../../gate-runtime/scoped-diff';
import { withReviewArtifactLock, writeArtifactFileAtomically } from '../../gate-runtime/review-artifacts';
import { matchAnyRegex } from '../../gate-runtime/text-utils';
import { fileSha256, normalizePath, resolveGitRoot, resolvePathInsideRepo, stringSha256, toStringArray, toPosix } from '../shared/helpers';
import { DEFAULT_GIT_TIMEOUT_MS, spawnSyncWithTimeout } from '../../core/subprocess';
import { readReviewContextChangedFiles } from '../review-context/review-context-diff';
import {
    parseSplitCheckpointDetectionSource,
    resolveAuthenticatedSplitCheckpointPreflightScope
} from '../split-required/split-checkpoint-scope';

const GIT_DIFF_HARDENING_ARGS = ['--no-ext-diff', '--no-textconv', '--no-color'];
export const SCOPED_DIFF_UNTRACKED_FILE_MAX_CHARS = 1024 * 1024;
export const SCOPED_DIFF_UNTRACKED_TOTAL_MAX_CHARS = 1024 * 1024;

/**
 * Resolve output path for scoped diff.
 */
export function resolveOutputPath(explicitOutputPath: string, preflightPath: string, reviewType: string, repoRoot: string): string {
    if (explicitOutputPath && explicitOutputPath.trim()) {
        return resolvePathInsideRepo(explicitOutputPath, repoRoot, { allowMissing: true }) as string;
    }
    const preflightDir = path.dirname(preflightPath);
    const baseName = path.basename(preflightPath, path.extname(preflightPath)).replace(/-preflight$/, '');
    return path.resolve(preflightDir, `${baseName}-${reviewType}-scoped.diff`);
}

/**
 * Resolve metadata path for scoped diff.
 */
export function resolveMetadataPath(explicitMetadataPath: string, preflightPath: string, reviewType: string, repoRoot: string): string {
    if (explicitMetadataPath && explicitMetadataPath.trim()) {
        return resolvePathInsideRepo(explicitMetadataPath, repoRoot, { allowMissing: true }) as string;
    }
    const preflightDir = path.dirname(preflightPath);
    const baseName = path.basename(preflightPath, path.extname(preflightPath)).replace(/-preflight$/, '');
    return path.resolve(preflightDir, `${baseName}-${reviewType}-scoped.json`);
}

function runGitDiffWithTargetArgs(
    gitRoot: string,
    targetArgs: string[],
    pathspecs: string[],
    commandLabel: string
): string {
    const gitArgs = ['-C', String(gitRoot), 'diff', ...GIT_DIFF_HARDENING_ARGS, ...targetArgs];
    if (pathspecs.length > 0) {
        gitArgs.push('--', ...pathspecs);
    }
    const result = spawnSyncWithTimeout('git', gitArgs, {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        maxBuffer: 50 * 1024 * 1024,
        timeoutMs: DEFAULT_GIT_TIMEOUT_MS
    });
    if (result.timedOut) {
        throw new Error(`${commandLabel} timed out after ${DEFAULT_GIT_TIMEOUT_MS} ms.`);
    }
    if (result.error) {
        throw new Error(`${commandLabel} exited with error: ${result.error.message || result.error}`);
    }
    if (result.status !== 0) {
        const errText = String(result.stderr || '').trim();
        throw new Error(`${commandLabel} exited with code ${result.status}. ${errText}`);
    }
    return String(result.stdout || '');
}

/**
 * Run git diff and return stdout text.
 */
export function runGitDiff(gitRoot: string, useStaged: boolean, pathspecs: string[]): string {
    return runGitDiffWithTargetArgs(gitRoot, [useStaged ? '--staged' : 'HEAD'], pathspecs, 'git diff');
}

export function runGitSplitCheckpointDiff(
    gitRoot: string,
    baseCommit: string,
    checkpointCommit: string,
    pathspecs: string[]
): string {
    return runGitDiffWithTargetArgs(
        gitRoot,
        [baseCommit, checkpointCommit],
        pathspecs,
        'git split-checkpoint diff'
    );
}

function runGitText(gitRoot: string, args: string[]): string {
    const result = spawnSyncWithTimeout('git', ['-C', String(gitRoot), ...args], {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        maxBuffer: 50 * 1024 * 1024,
        timeoutMs: DEFAULT_GIT_TIMEOUT_MS
    });
    if (result.timedOut) {
        throw new Error(`git ${args[0] || ''} timed out after ${DEFAULT_GIT_TIMEOUT_MS} ms.`);
    }
    if (result.error) {
        throw new Error(`git ${args[0] || ''} exited with error: ${result.error.message || result.error}`);
    }
    if (result.status !== 0) {
        const errText = String(result.stderr || '').trim();
        throw new Error(`git ${args[0] || ''} exited with code ${result.status}. ${errText}`);
    }
    return String(result.stdout || '');
}

function shouldIncludeUntracked(preflight: Record<string, unknown>): boolean {
    const detectionSource = String(preflight.detection_source || '').trim().toLowerCase();
    return detectionSource === 'explicit_changed_files'
        || detectionSource === 'git_auto'
        || detectionSource === 'git_staged_plus_untracked';
}

function getDetectionSource(preflight: Record<string, unknown>): string {
    return String(preflight.detection_source || '').trim().toLowerCase();
}

function usesStagedScope(preflight: Record<string, unknown>): boolean {
    const detectionSource = getDetectionSource(preflight);
    return detectionSource === 'git_staged_only' || detectionSource === 'git_staged_plus_untracked';
}

function normalizeOptionalHash(value: unknown): string | null {
    const trimmed = String(value || '').trim().toLowerCase();
    return trimmed ? trimmed : null;
}

function asPlainRecord(value: unknown): Record<string, unknown> | null {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

function getStagedBaselineTrustMetadata(preflight: Record<string, unknown>): {
    status: string | null;
    violationsSha256: string | null;
    inputSha256: string | null;
} {
    const triggers = asPlainRecord(preflight.triggers);
    const status = String(triggers?.dirty_workspace_staged_baseline_trust_status || '').trim().toUpperCase() || null;
    const violations = Array.isArray(triggers?.dirty_workspace_staged_baseline_trust_violations)
        ? triggers.dirty_workspace_staged_baseline_trust_violations.map((entry) => String(entry || '')).filter(Boolean)
        : [];
    const inputSha256 = normalizeOptionalHash(triggers?.dirty_workspace_staged_baseline_trust_input_sha256);
    return {
        status,
        violationsSha256: stringSha256(violations.join('\n')),
        inputSha256
    };
}

function toLiteralGitPathspecs(pathspecs: string[]): string[] {
    return pathspecs.map((pathspec) => `:(literal)${pathspec}`);
}

function resolveGitRelativePath(gitRoot: string, relativeFile: string): string | null {
    const normalizedFile = normalizePath(relativeFile);
    if (
        !normalizedFile
        || normalizedFile === '.'
        || normalizedFile === '..'
        || normalizedFile.startsWith('../')
        || normalizedFile.endsWith('/..')
        || normalizedFile.includes('/../')
        || normalizedFile.startsWith(':')
        || path.isAbsolute(normalizedFile)
    ) {
        return null;
    }
    const resolvedGitRoot = path.resolve(gitRoot);
    const resolvedPath = path.resolve(resolvedGitRoot, normalizedFile);
    const relativeFromRoot = path.relative(resolvedGitRoot, resolvedPath);
    if (!relativeFromRoot || relativeFromRoot.startsWith('..') || path.isAbsolute(relativeFromRoot)) {
        return null;
    }
    return resolvedPath;
}

function listUntrackedFiles(gitRoot: string, pathspecs: string[]): string[] {
    const args = ['ls-files', '--others', '--exclude-standard'];
    if (pathspecs.length > 0) {
        args.push('--', ...pathspecs);
    }
    return runGitText(gitRoot, args)
        .split(/\r?\n/)
        .map((entry) => normalizePath(entry))
        .filter((entry) => entry.length > 0);
}

function readUntrackedFileBody(gitRoot: string, relativeFile: string, maxChars: number): { body: string; mode: string; truncated: boolean } | null {
    const absolutePath = resolveGitRelativePath(gitRoot, relativeFile);
    if (!absolutePath) {
        return null;
    }
    try {
        const stat = fs.lstatSync(absolutePath);
        if (stat.isSymbolicLink()) {
            return {
                mode: '120000',
                body: '+[untracked file content omitted: symbolic_link]',
                truncated: false
            };
        }
        if (!stat.isFile()) {
            return null;
        }
        const effectiveMaxChars = Math.max(0, maxChars);
        const file = fs.openSync(absolutePath, 'r');
        let content = '';
        let truncated = false;
        try {
            const buffer = Buffer.alloc(Math.min(stat.size, effectiveMaxChars + 4096));
            const bytesRead = fs.readSync(file, buffer, 0, buffer.length, 0);
            const bytes = buffer.subarray(0, bytesRead);
            let rawContent: string;
            try {
                if (bytes.includes(0)) throw new TypeError('Binary content');
                rawContent = new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: bytesRead < stat.size });
            } catch {
                return { mode: '100644', body: '+[untracked file content omitted: binary]', truncated: false };
            }
            content = rawContent.slice(0, effectiveMaxChars);
            truncated = rawContent.length > effectiveMaxChars || stat.size > bytesRead;
        } finally {
            fs.closeSync(file);
        }
        const truncatedMarker = truncated
            ? `\n+[untracked file content truncated: ${stat.size} bytes exceeds scoped-diff untracked limit]`
            : '';
        return {
            mode: '100644',
            body: `${content.split(/\r?\n/).map((line) => `+${line}`).join('\n')}${truncatedMarker}`,
            truncated
        };
    } catch {
        return null;
    }
}

function buildUntrackedDiff(gitRoot: string, pathspecs: string[]): { text: string; files: string[]; truncated: boolean } {
    const untrackedFiles = listUntrackedFiles(gitRoot, pathspecs);
    const chunks: string[] = [];
    const includedFiles: string[] = [];
    let outputCharCount = 0;
    let truncated = false;
    for (const relativeFile of untrackedFiles) {
        const remainingChars = SCOPED_DIFF_UNTRACKED_TOTAL_MAX_CHARS - outputCharCount;
        if (remainingChars <= 0) {
            truncated = true;
            break;
        }
        const header = [
            `diff --git a/${relativeFile} b/${relativeFile}`,
            'new file mode 100644',
            '--- /dev/null',
            `+++ b/${relativeFile}`
        ].join('\n') + '\n';
        const markerReserveChars = 256;
        const fileBody = readUntrackedFileBody(
            gitRoot,
            relativeFile,
            Math.min(SCOPED_DIFF_UNTRACKED_FILE_MAX_CHARS, Math.max(0, remainingChars - header.length - markerReserveChars))
        );
        if (!fileBody) {
            continue;
        }
        const chunk = [
            `diff --git a/${relativeFile} b/${relativeFile}`,
            `new file mode ${fileBody.mode}`,
            '--- /dev/null',
            `+++ b/${relativeFile}`,
            fileBody.body
        ].join('\n');
        const boundedChunk = chunk.slice(0, remainingChars);
        chunks.push(boundedChunk);
        outputCharCount += boundedChunk.length;
        truncated = truncated || fileBody.truncated || chunk.length > boundedChunk.length;
        includedFiles.push(relativeFile);
    }
    return {
        text: chunks.join('\n'),
        files: includedFiles,
        truncated
    };
}

function runGitDiffBestEffort(gitRoot: string, useStaged: boolean, pathspecs: string[]): string {
    try {
        return runGitDiff(gitRoot, useStaged, pathspecs);
    } catch {
        return '';
    }
}

function filterDiffToChangedFiles(diffText: string, changedFiles: string[]): string {
    const allowedFiles = new Set(changedFiles.map((changedFile) => normalizePath(changedFile)));
    if (allowedFiles.size === 0) {
        return '';
    }
    const blocks = parseUnifiedDiff(diffText);
    if (blocks.length === 0) {
        return '';
    }
    return reassembleDiff(blocks.filter((block) => allowedFiles.has(normalizePath(block.filePath))));
}

export interface BuildScopedDiffOptions {
    reviewType: string;
    preflightPath: string;
    pathsConfigPath: string;
    outputPath: string;
    metadataPath: string;
    fullDiffPath?: string | null;
    repoRoot: string;
    useStaged?: boolean;
    hunkLevel?: boolean;
}

/**
 * Build a scoped diff for a specific review type.
 * Orchestrates git operations and writes artifacts.
 * Supports hunk-level filtering when `hunkLevel` is true.
 * Returns the metadata object.
 */
export function buildScopedDiff(options: BuildScopedDiffOptions) {
    const reviewType = options.reviewType;
    const preflightPath = options.preflightPath;
    const pathsConfigPath = options.pathsConfigPath;
    const outputPath = options.outputPath;
    const metadataPath = options.metadataPath;
    const fullDiffPath = options.fullDiffPath || null;
    const repoRoot = options.repoRoot;
    const hunkLevel = options.hunkLevel || false;

    const gitRepoRoot = resolveGitRoot(repoRoot);

    const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8'));
    const detectionSource = getDetectionSource(preflight);
    const requestedSplitCheckpointRange = parseSplitCheckpointDetectionSource(detectionSource);
    const changedFiles = readReviewContextChangedFiles(preflight.changed_files);
    const splitCheckpointScope = requestedSplitCheckpointRange
        ? resolveAuthenticatedSplitCheckpointPreflightScope(
            repoRoot,
            preflight.task_id,
            detectionSource,
            preflight.changed_files
        )
        : null;
    const splitCheckpointRange = splitCheckpointScope
        ? {
            base_commit: splitCheckpointScope.base_commit,
            checkpoint_commit: splitCheckpointScope.checkpoint_commit
        }
        : null;
    const useStaged = splitCheckpointRange
        ? false
        : options.useStaged === undefined ? usesStagedScope(preflight) : options.useStaged === true;
    const useStagedSource = splitCheckpointRange
        ? 'split_checkpoint'
        : options.useStaged === undefined ? 'preflight_detection_source' : 'explicit_option';
    const preflightMetrics = asPlainRecord(preflight.metrics);
    const stagedBaselineTrustMetadata = getStagedBaselineTrustMetadata(preflight);
    const preflightSha256 = fileSha256(preflightPath);
    const pathsConfig = JSON.parse(fs.readFileSync(pathsConfigPath, 'utf8'));
    const triggers = pathsConfig.triggers || {};
    const triggerRegexes = toStringArray(triggers[reviewType]);
    if (!triggerRegexes.length) {
        throw new Error(`No trigger regexes found for review type '${reviewType}' in ${pathsConfigPath}`);
    }

    const matchedFiles = changedFiles.filter(
        p => matchAnyRegex(p, triggerRegexes, {
            skipInvalidRegex: true,
            invalidRegexContext: `review '${reviewType}'`,
            caseInsensitive: true
        })
    );

    let scopedDiffText = '';
    let fallbackToFullDiff = false;
    let fullDiffSource = 'none';
    const includeUntracked = !splitCheckpointRange && shouldIncludeUntracked(preflight);
    let untrackedFiles: string[] = [];
    let untrackedDiffTruncated = false;
    const changedFilePathspecs = toLiteralGitPathspecs(
        convertToGitPathspecs(changedFiles, toPosix(repoRoot), toPosix(gitRepoRoot))
    );

    if (matchedFiles.length > 0) {
        try {
            const gitPathspecs = toLiteralGitPathspecs(
                convertToGitPathspecs(matchedFiles, toPosix(repoRoot), toPosix(gitRepoRoot))
            );
            const trackedDiffText = splitCheckpointRange
                ? runGitSplitCheckpointDiff(
                    gitRepoRoot,
                    splitCheckpointRange.base_commit,
                    splitCheckpointRange.checkpoint_commit,
                    gitPathspecs
                )
                : includeUntracked
                    ? runGitDiffBestEffort(gitRepoRoot, useStaged, gitPathspecs)
                    : runGitDiff(gitRepoRoot, useStaged, gitPathspecs);
            const untrackedDiff = includeUntracked
                ? buildUntrackedDiff(gitRepoRoot, gitPathspecs)
                : { text: '', files: [], truncated: false };
            untrackedFiles = [...new Set([...untrackedFiles, ...untrackedDiff.files])].sort();
            untrackedDiffTruncated = untrackedDiffTruncated || untrackedDiff.truncated;
            scopedDiffText = [trackedDiffText, untrackedDiff.text].filter((text) => text.trim()).join('\n');
            if (!scopedDiffText.trim()) fallbackToFullDiff = true;
        } catch {
            fallbackToFullDiff = true;
        }
    } else {
        fallbackToFullDiff = true;
    }

    let outputDiffText = scopedDiffText;
    if (fallbackToFullDiff) {
        let artifactDiffText = '';
        if (fullDiffPath && fs.existsSync(fullDiffPath) && fs.statSync(fullDiffPath).isFile()) {
            artifactDiffText = filterDiffToChangedFiles(fs.readFileSync(fullDiffPath, 'utf8'), changedFiles);
        }
        if (artifactDiffText.trim()) {
            outputDiffText = artifactDiffText;
            fullDiffSource = 'artifact_scoped';
        } else {
            const trackedFullDiffText = splitCheckpointRange
                ? runGitSplitCheckpointDiff(
                    gitRepoRoot,
                    splitCheckpointRange.base_commit,
                    splitCheckpointRange.checkpoint_commit,
                    changedFilePathspecs
                )
                : includeUntracked
                    ? runGitDiffBestEffort(gitRepoRoot, useStaged, changedFilePathspecs)
                    : runGitDiff(gitRepoRoot, useStaged, changedFilePathspecs);
            const untrackedFullDiff = includeUntracked
                ? buildUntrackedDiff(gitRepoRoot, changedFilePathspecs)
                : { text: '', files: [], truncated: false };
            untrackedFiles = [...new Set([...untrackedFiles, ...untrackedFullDiff.files])].sort();
            untrackedDiffTruncated = untrackedDiffTruncated || untrackedFullDiff.truncated;
            outputDiffText = [trackedFullDiffText, untrackedFullDiff.text].filter((text) => text.trim()).join('\n');
            fullDiffSource = includeUntracked && untrackedFullDiff.files.length > 0
                ? 'git_plus_untracked'
                : 'git';
        }
    }

    let hunkFilterResult = null;
    if (hunkLevel && outputDiffText && outputDiffText.trim()) {
        const filterResult = filterDiffByHunks(outputDiffText, triggerRegexes, {
            reviewType
        });
        // Always apply hunk filtering result, even if it produces empty output
        if (filterResult.hunkLevelFiltered) {
            outputDiffText = filterResult.filteredDiffText;
        }
        hunkFilterResult = {
            total_file_blocks: filterResult.totalFileBlocks,
            included_file_blocks: filterResult.includedFileBlocks,
            total_hunks: filterResult.totalHunks,
            included_hunks: filterResult.includedHunks,
            hunk_level_filtered: filterResult.hunkLevelFiltered
        };
    }

    let outputPayload = outputDiffText || '';
    if (outputPayload && !outputPayload.endsWith('\n')) outputPayload += '\n';

    function lineCount(text: string): number {
        if (!text) return 0;
        return text.split('\n').length;
    }

    const result: Record<string, unknown> = {
        review_type: reviewType,
        preflight_path: normalizePath(preflightPath),
        preflight_sha256: preflightSha256,
        detection_source: detectionSource,
        split_checkpoint: splitCheckpointRange,
        changed_files_sha256: normalizeOptionalHash(preflightMetrics?.changed_files_sha256),
        scope_content_sha256: normalizeOptionalHash(preflightMetrics?.scope_content_sha256),
        scope_sha256: normalizeOptionalHash(preflightMetrics?.scope_sha256),
        staged_baseline_trust_status: stagedBaselineTrustMetadata.status,
        staged_baseline_trust_violations_sha256: stagedBaselineTrustMetadata.violationsSha256,
        staged_baseline_trust_input_sha256: stagedBaselineTrustMetadata.inputSha256,
        paths_config_path: normalizePath(pathsConfigPath),
        output_path: normalizePath(outputPath),
        metadata_path: normalizePath(metadataPath),
        git_repo_root: normalizePath(gitRepoRoot),
        full_diff_path: fullDiffPath ? normalizePath(fullDiffPath) : null,
        full_diff_source: fullDiffSource,
        use_staged: !!useStaged,
        use_staged_source: useStagedSource,
        include_untracked: includeUntracked,
        untracked_files_count: untrackedFiles.length,
        untracked_files: untrackedFiles,
        untracked_diff_truncated: untrackedDiffTruncated,
        changed_files_count: changedFiles.length,
        changed_files: changedFiles,
        matched_files_count: matchedFiles.length,
        matched_files: matchedFiles,
        fallback_to_full_diff: !!fallbackToFullDiff,
        output_diff_sha256: stringSha256(outputPayload),
        scoped_diff_line_count: lineCount(scopedDiffText),
        output_diff_line_count: lineCount(outputPayload),
        hunk_level: !!hunkLevel
    };

    if (hunkFilterResult) {
        result.hunk_filter = hunkFilterResult;
    }

    withReviewArtifactLock(metadataPath, () => {
        writeArtifactFileAtomically(outputPath, outputPayload);
        writeArtifactFileAtomically(metadataPath, JSON.stringify(result, null, 2) + '\n');
    });

    return result;
}
