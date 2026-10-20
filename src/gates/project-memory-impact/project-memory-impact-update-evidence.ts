import * as fs from 'node:fs';
import * as path from 'node:path';
import { DEFAULT_GIT_TIMEOUT_MS, spawnSyncWithTimeout } from '../../core/subprocess';
import { parsePorcelainV1Z } from '../../core/git-path-output';
import {
    PROJECT_MEMORY_REQUIRED_FILE_NAMES,
    resolveLiveProjectMemoryDir
} from '../../core/project-memory';
import { isPlainObject } from '../../core/config-merge';
import { fileSha256, normalizePath } from '../shared/helpers';
import { readJsonFileIfPresent, toRepoPath, uniqueSorted } from './project-memory-impact-common';
import {
    type ProjectMemoryImpactArtifact,
    type ProjectMemoryUpdateEvidence,
    type ProjectMemoryUpdateEvidenceStatus
} from './project-memory-impact-types';

function isPathInside(parent: string, child: string): boolean {
    const relative = path.relative(path.resolve(parent), path.resolve(child));
    return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function normalizeUpdatedMemoryFile(repoRoot: string, bundleRoot: string, value: string): string {
    const raw = String(value || '').trim();
    if (!raw) {
        throw new Error('Updated memory file path must not be empty.');
    }
    const liveMemoryDir = resolveLiveProjectMemoryDir(bundleRoot);
    let fullPath: string;
    if ((PROJECT_MEMORY_REQUIRED_FILE_NAMES as readonly string[]).includes(raw)) {
        fullPath = path.join(liveMemoryDir, raw);
    } else {
        fullPath = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(repoRoot, raw);
    }
    if (!isPathInside(liveMemoryDir, fullPath)) {
        throw new Error(`Updated memory file must be under ${toRepoPath(path.relative(repoRoot, liveMemoryDir))}: ${raw}`);
    }
    if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
        throw new Error(`Updated memory file does not exist: ${raw}`);
    }
    return toRepoPath(path.relative(repoRoot, fullPath));
}

function hashUpdatedMemoryFiles(repoRoot: string, updatedMemoryFiles: readonly string[]): Record<string, string> {
    const hashes: Record<string, string> = {};
    for (const repoPath of updatedMemoryFiles) {
        hashes[repoPath] = fileSha256(path.join(repoRoot, repoPath)) ?? '';
    }
    return hashes;
}

function buildMissingUpdatedFiles(
    affectedMemoryFiles: readonly string[],
    updatedMemoryFiles: readonly string[],
    skippedMemoryFiles: readonly string[] = []
): string[] {
    const updated = new Set(updatedMemoryFiles);
    const skipped = new Set(skippedMemoryFiles);
    return affectedMemoryFiles.filter((file) => !updated.has(file) && !skipped.has(file));
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
    return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function collectChangedProjectMemoryFiles(repoRoot: string, bundleRoot: string): { files: string[]; error: string | null } {
    const liveMemoryDir = resolveLiveProjectMemoryDir(bundleRoot);
    const repoRelativeMemoryDir = toRepoPath(path.relative(repoRoot, liveMemoryDir));
    const result = spawnSyncWithTimeout('git', [
        '-C',
        repoRoot,
        'status',
        '--porcelain=v1',
        '-z',
        '--untracked-files=all',
        '--',
        `:(literal)${repoRelativeMemoryDir}`
    ], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeoutMs: DEFAULT_GIT_TIMEOUT_MS,
        maxBuffer: 10 * 1024 * 1024
    });
    if (result.timedOut || result.error || result.status !== 0) {
        const reason = result.timedOut
            ? `timed out after ${DEFAULT_GIT_TIMEOUT_MS}ms`
            : result.error
                ? String(result.error)
                : String(result.stderr || result.stdout || `exit status ${result.status}`).trim();
        return {
            files: [],
            error: `git status could not inspect current project-memory changes (${reason}).`
        };
    }

    const files = new Set<string>();
    for (const entry of parsePorcelainV1Z(String(result.stdout || ''))) {
        const normalizedPath = normalizePath(entry.path);
        if (!normalizedPath.startsWith(`${repoRelativeMemoryDir}/`)) {
            continue;
        }
        files.add(normalizedPath);
    }

    return {
        files: [...files].sort(),
        error: null
    };
}

function resolveUpdatedMemoryFilesForConfirmation(input: {
    repoRoot: string;
    bundleRoot: string;
    affectedMemoryFiles: string[];
    explicitUpdatedMemoryFiles: string[];
    explicitSkippedMemoryFiles: string[];
    allowPartialInference: boolean;
}): { updatedMemoryFiles: string[]; inferenceViolation: string | null } {
    const explicitUpdatedMemoryFiles = input.explicitUpdatedMemoryFiles
        .map((file) => String(file || '').trim())
        .filter(Boolean);
    if (explicitUpdatedMemoryFiles.length > 0 || input.affectedMemoryFiles.length === 0) {
        return {
            updatedMemoryFiles: explicitUpdatedMemoryFiles,
            inferenceViolation: null
        };
    }

    const inferred = collectChangedProjectMemoryFiles(input.repoRoot, input.bundleRoot);
    if (inferred.error) {
        if (input.allowPartialInference && input.explicitSkippedMemoryFiles.length > 0) {
            return {
                updatedMemoryFiles: [],
                inferenceViolation: null
            };
        }
        return {
            updatedMemoryFiles: [],
            inferenceViolation: 'No --updated-memory-file values were provided, and the current project-memory diff could not be inferred safely.'
        };
    }
    const inferredSet = new Set(inferred.files);
    const affectedSet = new Set(input.affectedMemoryFiles);
    const inferredWithinAffected = inferred.files.every((file) => affectedSet.has(file));
    if (!input.allowPartialInference && !arraysEqual(inferred.files, input.affectedMemoryFiles)) {
        const changedSummary = inferred.files.length > 0 ? inferred.files.join(', ') : '(none)';
        return {
            updatedMemoryFiles: [],
            inferenceViolation: `No --updated-memory-file values were provided, and the current changed project-memory files do not exactly match the affected list. Changed project-memory files: ${changedSummary}.`
        };
    }
    if (input.allowPartialInference && !inferredWithinAffected) {
        const extra = inferred.files.filter((file) => !affectedSet.has(file));
        return {
            updatedMemoryFiles: [],
            inferenceViolation: `Current changed project-memory files include non-candidate files: ${extra.join(', ')}.`
        };
    }
    return {
        updatedMemoryFiles: input.allowPartialInference ? [...inferredSet].sort() : inferred.files,
        inferenceViolation: null
    };
}

function normalizeRationale(value: string | null | undefined): string | null {
    const text = String(value || '').trim().replace(/\s+/g, ' ');
    return text || null;
}

function validateSkipRationale(value: string | null): string | null {
    if (!value) {
        return 'Skipped memory candidates require --skip-unchanged-candidates-rationale.';
    }
    if (value.length < 24) {
        return 'Skipped memory candidate rationale is too short.';
    }
    if (/[<>]/.test(value) || /\b(todo|replace me|placeholder)\b/i.test(value)) {
        return 'Skipped memory candidate rationale must be concrete, not a placeholder.';
    }
    return null;
}

export function readUpdateEvidence(updateArtifactPath: string): ProjectMemoryUpdateEvidence | null {
    const parsed = readJsonFileIfPresent(updateArtifactPath);
    if (!isPlainObject(parsed)) {
        return null;
    }
    if (parsed.schema_version !== 1 || parsed.status !== 'UPDATED') {
        return null;
    }
    return parsed as unknown as ProjectMemoryUpdateEvidence;
}

export function validateExistingUpdateEvidence(input: {
    repoRoot: string;
    updateArtifactPath: string;
    impactFingerprint: string;
    affectedMemoryFiles: string[];
}): ProjectMemoryImpactArtifact['update_evidence'] {
    const evidence = readUpdateEvidence(input.updateArtifactPath);
    if (!evidence) {
        return {
            status: 'MISSING',
            path: normalizePath(input.updateArtifactPath),
            updated_memory_files: [],
            skipped_memory_files: [],
            missing_updated_memory_files: input.affectedMemoryFiles,
            invalid_reasons: ['Update evidence is missing or invalid.']
        };
    }
    const updatedMemoryFiles = Array.isArray(evidence.updated_memory_files)
        ? evidence.updated_memory_files.map((file) => toRepoPath(String(file || ''))).filter(Boolean)
        : [];
    const skippedMemoryFiles = Array.isArray(evidence.skipped_memory_files)
        ? evidence.skipped_memory_files.map((file) => toRepoPath(String(file || ''))).filter(Boolean)
        : [];
    const missingUpdated = buildMissingUpdatedFiles(input.affectedMemoryFiles, updatedMemoryFiles, skippedMemoryFiles);
    const invalidReasons: string[] = [];
    let status: ProjectMemoryUpdateEvidenceStatus = 'VALID';
    const rationale = normalizeRationale(evidence.skip_unchanged_candidates_rationale);

    if (evidence.impact_fingerprint_sha256 !== input.impactFingerprint) {
        status = 'STALE';
        invalidReasons.push('Update evidence is bound to a different impact fingerprint.');
    }
    if (missingUpdated.length > 0) {
        status = 'STALE';
        invalidReasons.push(`Update evidence does not account for affected memory files: ${missingUpdated.join(', ')}.`);
    }
    if (skippedMemoryFiles.length > 0) {
        const rationaleViolation = validateSkipRationale(rationale);
        if (rationaleViolation) {
            status = 'INVALID';
            invalidReasons.push(rationaleViolation);
        }
    }
    const overlap = updatedMemoryFiles.filter((file) => skippedMemoryFiles.includes(file));
    if (overlap.length > 0) {
        status = 'INVALID';
        invalidReasons.push(`Memory files cannot be both updated and skipped: ${overlap.join(', ')}.`);
    }
    const expectedHashes = isPlainObject(evidence.updated_file_hashes)
        ? evidence.updated_file_hashes as Record<string, unknown>
        : {};
    const expectedSkippedHashes = isPlainObject(evidence.skipped_file_hashes)
        ? evidence.skipped_file_hashes as Record<string, unknown>
        : {};
    for (const repoPath of updatedMemoryFiles) {
        const fullPath = path.join(input.repoRoot, repoPath);
        if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
            status = 'TAMPERED';
            invalidReasons.push(`Updated memory file no longer exists: ${repoPath}.`);
            continue;
        }
        const expectedHash = String(expectedHashes[repoPath] || '');
        const actualHash = fileSha256(fullPath);
        if (!expectedHash || expectedHash !== actualHash) {
            status = 'TAMPERED';
            invalidReasons.push(`Updated memory file hash changed after evidence was recorded: ${repoPath}.`);
        }
    }
    for (const repoPath of skippedMemoryFiles) {
        const fullPath = path.join(input.repoRoot, repoPath);
        if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
            status = 'TAMPERED';
            invalidReasons.push(`Skipped memory file no longer exists: ${repoPath}.`);
            continue;
        }
        const expectedHash = String(expectedSkippedHashes[repoPath] || '');
        const actualHash = fileSha256(fullPath);
        if (!expectedHash || expectedHash !== actualHash) {
            status = 'TAMPERED';
            invalidReasons.push(`Skipped memory file hash changed after evidence was recorded: ${repoPath}.`);
        }
    }

    return {
        status,
        path: normalizePath(input.updateArtifactPath),
        updated_memory_files: updatedMemoryFiles,
        skipped_memory_files: skippedMemoryFiles,
        missing_updated_memory_files: missingUpdated,
        invalid_reasons: invalidReasons
    };
}

export function buildUpdateEvidence(input: {
    repoRoot: string;
    bundleRoot: string;
    taskId: string;
    impactFingerprint: string;
    affectedMemoryFiles: string[];
    updatedMemoryFiles: string[];
    skippedMemoryFiles?: string[];
    skipUnchangedCandidatesRationale?: string | null;
    compactSha256: string | null;
    previousCompactSha256?: string | null;
}): { evidence: ProjectMemoryUpdateEvidence; updateEvidence: ProjectMemoryImpactArtifact['update_evidence']; violations: string[] } {
    const violations: string[] = [];
    const rationale = normalizeRationale(input.skipUnchangedCandidatesRationale);
    const explicitSkipped = (input.skippedMemoryFiles || [])
        .map((file) => String(file || '').trim())
        .filter(Boolean);
    const resolvedUpdatedMemoryFiles = resolveUpdatedMemoryFilesForConfirmation({
        repoRoot: input.repoRoot,
        bundleRoot: input.bundleRoot,
        affectedMemoryFiles: input.affectedMemoryFiles,
        explicitUpdatedMemoryFiles: input.updatedMemoryFiles,
        explicitSkippedMemoryFiles: explicitSkipped,
        allowPartialInference: !!rationale
    });
    if (resolvedUpdatedMemoryFiles.inferenceViolation) {
        violations.push(resolvedUpdatedMemoryFiles.inferenceViolation);
    }
    const normalizedUpdatedFiles: string[] = [];
    for (const rawFile of resolvedUpdatedMemoryFiles.updatedMemoryFiles) {
        try {
            normalizedUpdatedFiles.push(normalizeUpdatedMemoryFile(input.repoRoot, input.bundleRoot, rawFile));
        } catch (error: unknown) {
            violations.push(error instanceof Error ? error.message : String(error));
        }
    }
    const updatedMemoryFiles = uniqueSorted(normalizedUpdatedFiles);
    const normalizedSkippedFiles: string[] = [];
    for (const rawFile of explicitSkipped) {
        try {
            normalizedSkippedFiles.push(normalizeUpdatedMemoryFile(input.repoRoot, input.bundleRoot, rawFile));
        } catch (error: unknown) {
            violations.push(error instanceof Error ? error.message : String(error));
        }
    }
    const affectedSet = new Set(input.affectedMemoryFiles);
    const updatedSet = new Set(updatedMemoryFiles);
    const skippedMemoryFiles = uniqueSorted([
        ...normalizedSkippedFiles,
        ...(rationale ? input.affectedMemoryFiles.filter((file) => !updatedSet.has(file)) : [])
    ]).filter((file) => affectedSet.has(file));
    const missingUpdated = buildMissingUpdatedFiles(input.affectedMemoryFiles, updatedMemoryFiles, skippedMemoryFiles);
    if (input.affectedMemoryFiles.length > 0 && missingUpdated.length > 0) {
        violations.push(`Confirmed update evidence does not account for affected memory files: ${missingUpdated.join(', ')}.`);
    }
    if (skippedMemoryFiles.length > 0) {
        const rationaleViolation = validateSkipRationale(rationale);
        if (rationaleViolation) {
            violations.push(rationaleViolation);
        }
    }
    const overlap = updatedMemoryFiles.filter((file) => skippedMemoryFiles.includes(file));
    if (overlap.length > 0) {
        violations.push(`Memory files cannot be both updated and skipped: ${overlap.join(', ')}.`);
    }
    const compactRefreshed = !!input.previousCompactSha256
        && !!input.compactSha256
        && input.previousCompactSha256 !== input.compactSha256
        && updatedMemoryFiles.some((file) => file.endsWith('/compact.md'));
    const hashes = hashUpdatedMemoryFiles(input.repoRoot, updatedMemoryFiles);
    const skippedHashes = hashUpdatedMemoryFiles(input.repoRoot, skippedMemoryFiles);
    const evidence: ProjectMemoryUpdateEvidence = {
        schema_version: 1,
        timestamp_utc: new Date().toISOString(),
        task_id: input.taskId,
        status: 'UPDATED',
        impact_fingerprint_sha256: input.impactFingerprint,
        updated_memory_files: updatedMemoryFiles,
        updated_file_hashes: hashes,
        skipped_memory_files: skippedMemoryFiles,
        skipped_file_hashes: skippedHashes,
        skip_unchanged_candidates_rationale: skippedMemoryFiles.length > 0 ? rationale : null,
        compact_refreshed: compactRefreshed,
        compact_sha256: input.compactSha256
    };
    return {
        evidence,
        updateEvidence: {
            status: violations.length > 0 ? 'INVALID' : 'VALID',
            path: '',
            updated_memory_files: updatedMemoryFiles,
            skipped_memory_files: skippedMemoryFiles,
            missing_updated_memory_files: missingUpdated,
            invalid_reasons: violations
        },
        violations
    };
}
