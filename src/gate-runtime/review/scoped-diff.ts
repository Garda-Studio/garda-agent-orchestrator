import { matchAnyRegex } from '../text-utils';
import * as path from 'node:path';
import { TextDecoder } from 'node:util';

/**
 * Build a scoped diff by filtering changed files against trigger regexes.
 * Pure-logic helper: callers provide preflight data and diff text.
 *
 * Shared scoped-diff behavior used by the Node gate runtime.
 * without git or filesystem side effects.
 */
export interface ScopedDiffOptions {
    reviewType: string;
    changedFiles?: string[];
    triggerRegexes?: string[];
    scopedDiffText?: string;
    fullDiffText?: string;
    fullDiffSource?: string;
    useStaged?: boolean;
    preflightPath?: string;
    pathsConfigPath?: string;
    outputPath?: string;
    metadataPath?: string;
    gitRepoRoot?: string;
    fullDiffPath?: string;
}

export function buildScopedDiffMetadata(options: ScopedDiffOptions): Record<string, unknown> {
    const reviewType = options.reviewType;
    const changedFiles = options.changedFiles || [];
    const triggerRegexes = options.triggerRegexes || [];
    const scopedDiffText = options.scopedDiffText || '';
    const fullDiffText = options.fullDiffText || '';
    const fullDiffSource = options.fullDiffSource || 'none';
    const useStaged = options.useStaged || false;
    const preflightPath = options.preflightPath || '';
    const pathsConfigPath = options.pathsConfigPath || '';
    const outputPath = options.outputPath || '';
    const metadataPath = options.metadataPath || '';
    const gitRepoRoot = options.gitRepoRoot || '';
    const fullDiffPath = options.fullDiffPath || '';

    if (!reviewType) {
        throw new Error("reviewType is required.");
    }
    if (triggerRegexes.length === 0) {
        throw new Error(`No trigger regexes found for review type '${reviewType}'.`);
    }

    const normalizedChangedFiles = [...new Set(
        changedFiles.map(f => String(f).replace(/\\/g, '/')).sort()
    )];

    const matchedFiles = normalizedChangedFiles.filter(
        filePath => matchAnyRegex(filePath, triggerRegexes, {
            skipInvalidRegex: true,
            invalidRegexContext: `review '${reviewType}'`,
            caseInsensitive: true
        })
    ).sort();

    let fallbackToFullDiff = false;
    let outputDiffText;

    if (matchedFiles.length > 0 && scopedDiffText && scopedDiffText.trim()) {
        outputDiffText = scopedDiffText;
    } else {
        fallbackToFullDiff = true;
        outputDiffText = fullDiffText;
    }

    function countLines(text: string): number {
        if (!text) return 0;
        return text.split(/\r?\n/).length;
    }

    return {
        review_type: reviewType,
        preflight_path: preflightPath ? String(preflightPath).replace(/\\/g, '/') : null,
        paths_config_path: pathsConfigPath ? String(pathsConfigPath).replace(/\\/g, '/') : null,
        output_path: outputPath ? String(outputPath).replace(/\\/g, '/') : null,
        metadata_path: metadataPath ? String(metadataPath).replace(/\\/g, '/') : null,
        git_repo_root: gitRepoRoot ? String(gitRepoRoot).replace(/\\/g, '/') : null,
        full_diff_path: fullDiffPath ? String(fullDiffPath).replace(/\\/g, '/') : null,
        full_diff_source: fullDiffSource,
        use_staged: useStaged,
        matched_files_count: matchedFiles.length,
        matched_files: matchedFiles,
        fallback_to_full_diff: fallbackToFullDiff,
        scoped_diff_line_count: countLines(scopedDiffText),
        output_diff_line_count: countLines(outputDiffText),
        output_diff_text: outputDiffText
    };
}

export interface DiffHunk {
    header: string;
    lines: string[];
}

export interface DiffFileBlock {
    filePath: string;
    headerLines: string[];
    hunks: DiffHunk[];
}

const GIT_PATH_ESCAPES: Readonly<Record<string, string>> = {
    a: '\x07', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v',
    '\\': '\\', '"': '"'
};
const GIT_PATH_UTF8_DECODER = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function parseQuotedGitPath(text: string): { value: string; length: number } | null {
    const match = text.match(/^"((?:[^"\\]|\\.)*)"/u);
    if (!match) return null;
    const chunks: Buffer[] = [];
    for (const part of match[1].split(/(\\(?:[0-7]{1,3}|.))/u)) {
        if (!part.startsWith('\\')) {
            chunks.push(Buffer.from(part, 'utf8'));
        } else if (/^\\[0-7]{1,3}$/u.test(part)) {
            const byte = Number.parseInt(part.slice(1), 8);
            if (byte > 255) return null;
            chunks.push(Buffer.from([byte]));
        } else {
            const escaped = GIT_PATH_ESCAPES[part.slice(1)];
            if (escaped === undefined) return null;
            chunks.push(Buffer.from(escaped, 'utf8'));
        }
    }
    try {
        // Git's octal escapes encode UTF-8 bytes, not Unicode code points.
        const value = GIT_PATH_UTF8_DECODER.decode(Buffer.concat(chunks));
        return value && !value.includes('\0') ? { value, length: match[0].length } : null;
    } catch {
        return null;
    }
}

function readGitDiffPath(text: string, prefix: string): string | null {
    const quoted = text.startsWith('"') ? parseQuotedGitPath(text) : null;
    if (text.startsWith('"') && (!quoted || quoted.length !== text.length)) return null;
    const value = quoted ? quoted.value : text;
    return value.startsWith(prefix) && value.length > prefix.length && !value.includes('\0')
        ? value.slice(prefix.length)
        : null;
}

function appendDiffBlock(blocks: DiffFileBlock[], block: DiffFileBlock): void {
    if (!block.filePath) throw new Error('Diff block has no decodable Git path; refusing incomplete review scope.');
    blocks.push(block);
}

/**
 * Parse a unified diff into per-file blocks with per-hunk granularity.
 * Handles standard `diff --git` format.
 */
export function parseUnifiedDiff(diffText: string): DiffFileBlock[] {
    if (!diffText || !diffText.trim()) return [];

    const lines = String(diffText)
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .split('\n');
    const blocks: DiffFileBlock[] = [];
    let currentBlock: DiffFileBlock | null = null;
    let currentHunk: DiffHunk | null = null;
    let headerPhase = false;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        if (line.startsWith('diff --git ')) {
            if (currentHunk && currentBlock) {
                currentBlock.hunks.push(currentHunk);
            }
            if (currentBlock) {
                appendDiffBlock(blocks, currentBlock);
            }
            const filePath = extractFilePathFromDiffLine(line);
            currentBlock = { filePath, headerLines: [line], hunks: [] };
            currentHunk = null;
            headerPhase = true;
            continue;
        }

        if (!currentBlock) continue;

        if (line.startsWith('@@ ')) {
            if (currentHunk) {
                currentBlock.hunks.push(currentHunk);
            }
            currentHunk = { header: line, lines: [] };
            headerPhase = false;
            continue;
        }

        if (headerPhase) {
            currentBlock.headerLines.push(line);
            const pathPrefix = line.startsWith('+++ ') ? '+++ ' : line.startsWith('rename to ') ? 'rename to ' : null;
            if (pathPrefix && line.slice(pathPrefix.length) !== '/dev/null') {
                let operand = line.slice(pathPrefix.length);
                // Git adds a tab separator to patch paths with spaces, quoted or not.
                if (pathPrefix === '+++ ' && operand.endsWith('\t')) operand = operand.slice(0, -1);
                const filePath = readGitDiffPath(operand, pathPrefix === '+++ ' ? 'b/' : '');
                if (!filePath) throw new Error('Diff header has no decodable Git path; refusing incomplete review scope.');
                currentBlock.filePath = filePath;
            }
        } else if (currentHunk) {
            currentHunk.lines.push(line);
        }
    }

    if (currentHunk && currentBlock) {
        currentBlock.hunks.push(currentHunk);
    }
    if (currentBlock) {
        appendDiffBlock(blocks, currentBlock);
    }

    return blocks;
}

/**
 * Extract the b-side file path from a `diff --git a/... b/...` line.
 * Tries the repeated-path pattern (a/X b/X) first for robustness with
 * paths containing ` b/`, then falls back to first ` b/` split.
 */
export function extractFilePathFromDiffLine(line: string): string {
    const prefix = 'diff --git ';
    if (!line.startsWith(prefix)) return '';
    const operands = line.substring(prefix.length);
    if (operands.startsWith('"')) {
        const aSide = parseQuotedGitPath(operands);
        if (!aSide || !aSide.value.startsWith('a/') || operands[aSide.length] !== ' ') return '';
        return readGitDiffPath(operands.slice(aSide.length + 1), 'b/') || '';
    }
    if (!operands.startsWith('a/')) return '';
    const quotedBIndex = operands.indexOf(' "b/');
    if (quotedBIndex >= 0) return readGitDiffPath(operands.slice(quotedBIndex + 1), 'b/') || '';
    const rest = operands.slice(2);
    // Try each ` b/` position: check if a-side equals b-side (same-file diff)
    let searchFrom = 0;
    while (true) {
        const bIdx = rest.indexOf(' b/', searchFrom);
        if (bIdx < 0) break;
        const aSide = rest.substring(0, bIdx);
        const bSide = rest.substring(bIdx + 3);
        if (aSide === bSide) {
            return bSide;
        }
        searchFrom = bIdx + 1;
    }
    // Fallback for renames: use first ` b/` split
    const firstBIdx = rest.indexOf(' b/');
    if (firstBIdx >= 0) {
        return rest.substring(firstBIdx + 3);
    }
    return '';
}

export interface HunkFilterOptions {
    triggerRegexes: string[];
    reviewType?: string;
}

/**
 * Filter hunks within a file block, keeping only those whose changed lines
 * (additions/deletions) match at least one trigger regex.
 * When no hunk matches, the file block is still included if the file path
 * itself matches the triggers (preserving file-level fallback semantics).
 * Blocks with no hunks (binary/mode-only changes) are included when the
 * file path matches triggers.
 */
export function filterHunksInBlock(
    block: DiffFileBlock,
    options: HunkFilterOptions
): { block: DiffFileBlock; matchedHunkCount: number; totalHunkCount: number; filePathMatched: boolean } {
    const { triggerRegexes, reviewType } = options;
    const totalHunkCount = block.hunks.length;
    const matchOpts = {
        skipInvalidRegex: true,
        invalidRegexContext: reviewType ? `hunk filter for '${reviewType}'` : 'hunk filter',
        caseInsensitive: true
    };

    const filePathMatched = matchAnyRegex(block.filePath, triggerRegexes, matchOpts);

    // File path matched: keep ALL hunks regardless of hunk content
    if (filePathMatched) {
        return {
            block,
            matchedHunkCount: totalHunkCount,
            totalHunkCount,
            filePathMatched: true
        };
    }

    // Binary/mode-only blocks have no hunks; exclude when file path doesn't match
    if (totalHunkCount === 0) {
        return {
            block,
            matchedHunkCount: 0,
            totalHunkCount: 0,
            filePathMatched: false
        };
    }

    const matchedHunks: DiffHunk[] = [];
    for (const hunk of block.hunks) {
        if (hunkMatchesTriggers(hunk, triggerRegexes, matchOpts)) {
            matchedHunks.push(hunk);
        }
    }

    if (matchedHunks.length > 0) {
        return {
            block: { ...block, hunks: matchedHunks },
            matchedHunkCount: matchedHunks.length,
            totalHunkCount,
            filePathMatched: false
        };
    }

    return {
        block: { ...block, hunks: [] },
        matchedHunkCount: 0,
        totalHunkCount,
        filePathMatched: false
    };
}

/**
 * Test whether a hunk's changed lines match any trigger regex.
 */
function hunkMatchesTriggers(
    hunk: DiffHunk,
    triggerRegexes: string[],
    matchOpts: { skipInvalidRegex: boolean; invalidRegexContext: string; caseInsensitive: boolean }
): boolean {
    for (const line of hunk.lines) {
        if (line.startsWith('+') || line.startsWith('-')) {
            const content = line.substring(1);
            if (matchAnyRegex(content, triggerRegexes, matchOpts)) {
                return true;
            }
        }
    }
    // Also check the hunk header for function/class context
    if (matchAnyRegex(hunk.header, triggerRegexes, matchOpts)) {
        return true;
    }
    return false;
}

/**
 * Reassemble filtered file blocks into unified diff text.
 * Includes blocks with hunks plus header-only blocks (binary/mode-only)
 * that were retained by file-path matching.
 */
export function reassembleDiff(blocks: DiffFileBlock[]): string {
    const parts: string[] = [];
    for (const block of blocks) {
        if (block.hunks.length === 0 && block.headerLines.length <= 1) continue;
        parts.push(block.headerLines.join('\n'));
        for (const hunk of block.hunks) {
            parts.push(hunk.header);
            if (hunk.lines.length > 0) {
                parts.push(hunk.lines.join('\n'));
            }
        }
    }
    if (parts.length === 0) return '';
    return parts.join('\n') + '\n';
}

export interface HunkLevelFilterResult {
    filteredDiffText: string;
    totalFileBlocks: number;
    includedFileBlocks: number;
    totalHunks: number;
    includedHunks: number;
    hunkLevelFiltered: boolean;
}

/**
 * Apply hunk-level filtering to a unified diff.
 * Files whose path matches triggers are always included.
 * Within non-path-matched files, only hunks with relevant changed lines are kept.
 */
export function filterDiffByHunks(
    diffText: string,
    triggerRegexes: string[],
    options?: { reviewType?: string }
): HunkLevelFilterResult {
    const reviewType = options?.reviewType;
    const blocks = parseUnifiedDiff(diffText);

    if (blocks.length === 0) {
        return {
            filteredDiffText: '',
            totalFileBlocks: 0,
            includedFileBlocks: 0,
            totalHunks: 0,
            includedHunks: 0,
            hunkLevelFiltered: false
        };
    }

    let totalHunks = 0;
    let includedHunks = 0;
    const filteredBlocks: DiffFileBlock[] = [];

    for (const block of blocks) {
        totalHunks += block.hunks.length;
        const result = filterHunksInBlock(block, {
            triggerRegexes,
            reviewType
        });
        // Include block if it has hunks or if it's a path-matched header-only block (binary/mode-only)
        if (result.block.hunks.length > 0 || (result.filePathMatched && block.headerLines.length > 1)) {
            filteredBlocks.push(result.block);
            includedHunks += result.matchedHunkCount;
        }
    }

    const filteredDiffText = reassembleDiff(filteredBlocks);

    return {
        filteredDiffText,
        totalFileBlocks: blocks.length,
        includedFileBlocks: filteredBlocks.length,
        totalHunks,
        includedHunks,
        hunkLevelFiltered: includedHunks < totalHunks || filteredBlocks.length < blocks.length
    };
}

/**
 * Convert pathspecs from repo-root-relative to git-root-relative.
 * Mirrors the legacy pathspec normalization contract.
 */
export function convertToGitPathspecs(pathspecs: string[], repoRoot: string, gitRoot: string): string[] {
    if (!pathspecs || pathspecs.length === 0) {
        return [];
    }

    const repoRootNormalized = repoRoot.replace(/[\\/]+$/, '').replace(/\\/g, '/');
    const gitRootNormalized = gitRoot.replace(/[\\/]+$/, '').replace(/\\/g, '/');

    if (repoRootNormalized.toLowerCase() === gitRootNormalized.toLowerCase()) {
        return [...pathspecs];
    }

    const gitRootName = path.basename(gitRootNormalized);
    const prefix = `${gitRootName}/`;

    return pathspecs.map(pathspec => {
        let normalized = String(pathspec).replace(/\\/g, '/');
        if (normalized.toLowerCase().startsWith(prefix.toLowerCase())) {
            normalized = normalized.substring(prefix.length);
        }
        return normalized;
    });
}
