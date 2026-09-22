import * as fs from 'node:fs';
import * as path from 'node:path';

import { DEFAULT_GIT_TIMEOUT_MS, spawnSyncWithTimeout } from '../../core/subprocess';
import {
    fileSha256,
    isPathInsideRoot,
    joinOrchestratorPath,
    normalizePath,
    resolvePathInsideRepo
} from '../shared/helpers';
import { getSafeWorktreePathState, type SafeWorktreePathState } from '../workspace/worktree-path-state';
import { isPlainRecord } from '../../core/records';
import {
    jsonReviewFindingsArtifactHasActiveFindings,
    parseJsonReviewFindingsArtifact
} from '../review/review-findings-artifact-verdict';

export interface GuardedIgnoredRemediationTarget {
    path: string;
    sha256?: string | null;
    reason?: string | null;
    source?: string | null;
}

export interface IgnoredRemediationTargetEvidence {
    path: string;
    sha256: string;
    state: SafeWorktreePathState['status'];
    explicit_sources: string[];
    approved_by: string[];
}

export interface IgnoredRemediationTargetAssessment {
    targets: IgnoredRemediationTargetEvidence[];
    allowedBoundaryFiles: string[];
    violations: string[];
}

interface IgnoredCandidate {
    path: string;
    sources: Set<string>;
}

interface HashableState {
    sha256: string;
    status: SafeWorktreePathState['status'];
}

const REVIEW_TEXT_MAX_BYTES = 128 * 1024;
const GIT_IGNORE_BATCH_MAX_PATHS = 256;
const GIT_IGNORE_BATCH_MAX_BYTES = 64 * 1024;

interface GitIgnoreResult {
    ignored: boolean;
    error: string | null;
}
const PATH_TOKEN_PATTERN =
    /(?:\.{1,2}\/)?(?:[A-Za-z0-9_.@()+~-]+\/)+[A-Za-z0-9_.@()+~-]+\.[A-Za-z0-9][A-Za-z0-9_.-]*/gu;
const ROOT_CHANGE_ARTIFACT_TOKEN_PATTERN =
    /(?:\.{1,2}\/)?(?:CHANGELOG|RELEASE[-_]?NOTES?|RELEASE[-_]?NOTE)\.[A-Za-z0-9][A-Za-z0-9_.-]*/giu;
const PATH_TOKEN_BOUNDARY_PATTERN = /[A-Za-z0-9_.@()+~/-]/u;
const NEGATED_PATH_APPROVAL_PATTERN =
    /\b(?:do\s+not|don't|must\s+not|should\s+not|avoid|exclude|excluded|outside\s+(?:this\s+)?(?:scope|remediation)|not\s+(?:required|needed|requested)|not\s+(?:in|part\s+of)\s+(?:this\s+)?(?:scope|remediation)|remove|revert)\b/u;
const EXAMPLE_ONLY_PATH_CONTEXT_PATTERN =
    /\b(?:such\s+as|for\s+example|e\.g\.|examples?|diagnostic(?:\s+reproduction)?|reproduction)\b/u;
const ACTIONABLE_PATH_BEFORE_PATTERN =
    /\b(?:requires?|needs?|requested|requests?|asks?|add(?:ed|ing)?|updat(?:e|ed|ing)|document(?:ed|ing)?|remediat(?:e|ed|ing)|fix(?:es|ed|ing)?|blocking|blocker)\b/u;
const ACTIONABLE_PATH_AFTER_PATTERN =
    /\b(?:(?:is|are|was|were|remains?|remain)\s+)?(?:missing|required|needed|requested|blocking|blocker)\b|\b(?:requires?|needs?)\b|\b(?:must|should)\s+(?:be\s+)?(?:add(?:ed)?|updat(?:ed)?|document(?:ed)?|remediat(?:ed)?|fix(?:ed)?|included?)\b/u;

function normalizeRepoRelativePath(repoRoot: string, rawPath: unknown): string | null {
    const text = String(rawPath || '').trim();
    if (!text) {
        return null;
    }
    let resolvedPath: string | null = null;
    try {
        resolvedPath = resolvePathInsideRepo(text, repoRoot, {
            allowMissing: true,
            enforceInside: true
        });
    } catch {
        return null;
    }
    if (!resolvedPath) {
        return null;
    }
    return normalizePath(path.relative(path.resolve(repoRoot), resolvedPath));
}

function addCandidate(
    candidates: Map<string, IgnoredCandidate>,
    repoRoot: string,
    rawPath: unknown,
    source: string
): void {
    const normalizedPath = normalizeRepoRelativePath(repoRoot, rawPath);
    if (!normalizedPath) {
        return;
    }
    const existing = candidates.get(normalizedPath);
    if (existing) {
        existing.sources.add(source);
        return;
    }
    candidates.set(normalizedPath, {
        path: normalizedPath,
        sources: new Set([source])
    });
}

function cleanExtractedPathToken(token: string): string {
    return normalizePath(token)
        .replace(/^[`"'(<[{]+/u, '')
        .replace(/[.,;:!?`"')>\]}]+$/u, '');
}

function isStandaloneRootFileToken(text: string, index: number, tokenLength: number): boolean {
    const before = index > 0 ? text[index - 1] : '';
    const after = index + tokenLength < text.length ? text[index + tokenLength] : '';
    return (!before || !PATH_TOKEN_BOUNDARY_PATTERN.test(before))
        && (!after || !PATH_TOKEN_BOUNDARY_PATTERN.test(after));
}

function extractCandidatePathsFromText(repoRoot: string, text: string): string[] {
    const candidates = new Set<string>();
    const normalizedText = String(text || '').replace(/\\/gu, '/');
    for (const match of normalizedText.matchAll(PATH_TOKEN_PATTERN)) {
        const candidate = cleanExtractedPathToken(match[0]);
        const normalizedPath = normalizeRepoRelativePath(repoRoot, candidate);
        if (normalizedPath) {
            candidates.add(normalizedPath);
        }
    }
    for (const match of normalizedText.matchAll(ROOT_CHANGE_ARTIFACT_TOKEN_PATTERN)) {
        if (!isStandaloneRootFileToken(normalizedText, match.index ?? 0, match[0].length)) {
            continue;
        }
        const candidate = cleanExtractedPathToken(match[0]);
        const normalizedPath = normalizeRepoRelativePath(repoRoot, candidate);
        if (normalizedPath) {
            candidates.add(normalizedPath);
        }
    }
    return [...candidates].sort();
}

function reviewTextApprovesPath(text: string, relativePath: string): boolean {
    const normalizedText = normalizePath(text).toLocaleLowerCase();
    const normalizedPath = normalizePath(relativePath).toLocaleLowerCase();
    if (!normalizedText || !normalizedPath) {
        return false;
    }

    let index = normalizedText.indexOf(normalizedPath);
    while (index >= 0) {
        const beforeExcerpt = normalizedText.slice(Math.max(0, index - 180), index);
        const afterExcerpt = normalizedText.slice(index + normalizedPath.length, index + normalizedPath.length + 180);
        if (
            NEGATED_PATH_APPROVAL_PATTERN.test(beforeExcerpt)
            || NEGATED_PATH_APPROVAL_PATTERN.test(afterExcerpt)
            || EXAMPLE_ONLY_PATH_CONTEXT_PATTERN.test(beforeExcerpt)
        ) {
            index = normalizedText.indexOf(normalizedPath, index + normalizedPath.length);
            continue;
        }
        if (ACTIONABLE_PATH_BEFORE_PATTERN.test(beforeExcerpt) || ACTIONABLE_PATH_AFTER_PATTERN.test(afterExcerpt)) {
            return true;
        }
        index = normalizedText.indexOf(normalizedPath, index + normalizedPath.length);
    }

    return false;
}

function getTaskModePlannedChangedFiles(taskMode: Record<string, unknown> | null | undefined): string[] {
    return Array.isArray(taskMode?.planned_changed_files)
        ? taskMode.planned_changed_files.map((entry) => normalizePath(entry)).filter(Boolean)
        : [];
}

function isTaskManualValidationPath(taskId: string, relativePath: string): boolean {
    const normalizedTaskId = String(taskId || '').trim();
    if (!normalizedTaskId) {
        return false;
    }
    const normalizedPath = normalizePath(relativePath);
    const bundledPrefix = normalizePath(`garda-agent-orchestrator/runtime/manual-validation/${normalizedTaskId}/`);
    const deployedPrefix = normalizePath(`runtime/manual-validation/${normalizedTaskId}/`);
    return normalizedPath.startsWith(bundledPrefix) || normalizedPath.startsWith(deployedPrefix);
}

function readSmallTextFile(filePath: string): string {
    try {
        if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
            return '';
        }
        const stat = fs.statSync(filePath);
        if (stat.size > REVIEW_TEXT_MAX_BYTES) {
            return '';
        }
        return fs.readFileSync(filePath, 'utf8');
    } catch {
        return '';
    }
}

function readJsonRecord(filePath: string): Record<string, unknown> | null {
    try {
        if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
            return null;
        }
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
        return isPlainRecord(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

function reviewTextHasFailedVerdict(
    text: string,
    expectedTaskId: string,
    expectedReviewType: string
): boolean {
    if (text.trimStart().startsWith('{')) {
        const findingsReport = parseJsonReviewFindingsArtifact(text);
        return findingsReport !== null
            && findingsReport.task_id === expectedTaskId
            && findingsReport.review_type.toLowerCase() === expectedReviewType.toLowerCase()
            && jsonReviewFindingsArtifactHasActiveFindings(findingsReport);
    }
    return /(?:^|\n)\s*(?:[A-Z]+(?:\s+[A-Z]+)*\s+)?REVIEW\s+FAILED\s*(?:\n|$)/iu.test(text);
}

function resolveReceiptBoundReviewArtifactPath(
    repoRoot: string,
    reviewsRoot: string,
    taskId: string,
    receiptPath: string
): string | null {
    const receipt = readJsonRecord(receiptPath);
    if (!receipt || String(receipt.task_id || '').trim() !== taskId) {
        return null;
    }
    const reviewType = String(receipt.review_type || '').trim().toLowerCase();
    if (!reviewType || !/^[a-z0-9_-]+$/u.test(reviewType)) {
        return null;
    }

    const expectedArtifactSha256 = normalizeSha256(receipt.review_artifact_sha256);
    if (!expectedArtifactSha256) {
        return null;
    }

    const candidatePaths = [
        path.join(reviewsRoot, `${taskId}-${reviewType}.md`),
        String(receipt.review_output_path || '').trim()
    ].filter(Boolean);
    for (const candidatePath of candidatePaths) {
        const resolvedPath = path.isAbsolute(candidatePath)
            ? candidatePath
            : resolvePathInsideRepo(candidatePath, repoRoot, { allowMissing: true, enforceInside: true });
        if (!resolvedPath || !isPathInsideRoot(resolvedPath, repoRoot)) {
            continue;
        }
        if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isFile()) {
            continue;
        }
        if (fileSha256(resolvedPath) !== expectedArtifactSha256) {
            continue;
        }
        const reviewText = readSmallTextFile(resolvedPath);
        if (reviewTextHasFailedVerdict(reviewText, taskId, reviewType)) {
            return resolvedPath;
        }
    }

    return null;
}

function collectReviewArtifactPaths(repoRoot: string, taskId: string): string[] {
    const reviewsRoot = joinOrchestratorPath(repoRoot, path.join('runtime', 'reviews'));
    try {
        if (!fs.existsSync(reviewsRoot) || !fs.statSync(reviewsRoot).isDirectory()) {
            return [];
        }
        const prefix = `${taskId}-`;
        return [...new Set(fs.readdirSync(reviewsRoot)
            .filter((fileName) => (
                fileName.startsWith(prefix)
                && fileName.endsWith('-receipt.json')
            ))
            .map((fileName) => resolveReceiptBoundReviewArtifactPath(
                repoRoot,
                reviewsRoot,
                taskId,
                path.join(reviewsRoot, fileName)
            ))
            .filter((artifactPath): artifactPath is string => !!artifactPath))]
            .sort();
    } catch {
        return [];
    }
}

function readGitIgnoredBatch(repoRoot: string, paths: string[]): Map<string, GitIgnoreResult> {
    const result = spawnSyncWithTimeout('git', [
        '-C',
        String(repoRoot),
        'check-ignore',
        '--stdin',
        '-z'
    ], {
        input: `${paths.join('\0')}\0`,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeoutMs: DEFAULT_GIT_TIMEOUT_MS,
        maxBuffer: 1024 * 1024
    });
    const output = String(result.stdout || '');
    const matches = output.endsWith('\0') ? output.slice(0, -1).split('\0') : [];
    const requested = new Set(paths);
    const validOutput = result.status === 1
        ? output === ''
        : result.status === 0 && matches.length > 0
            && new Set(matches).size === matches.length && matches.every((entry) => requested.has(entry));
    const error = result.timedOut
        ? `git check-ignore timed out after ${DEFAULT_GIT_TIMEOUT_MS}ms`
        : result.error || !validOutput
            ? String(result.stderr || result.error || 'git check-ignore failed or returned invalid output').trim()
            : null;
    const ignored = new Set(matches);
    return new Map(paths.map((entry) => [entry, { ignored: !error && ignored.has(entry), error }]));
}

function readGitIgnoredCandidates(repoRoot: string, paths: string[]): Map<string, GitIgnoreResult> {
    const results = new Map<string, GitIgnoreResult>();
    let batch: string[] = [];
    let bytes = 0;
    const flush = (): void => {
        if (!batch.length) return;
        for (const [entry, result] of readGitIgnoredBatch(repoRoot, batch)) results.set(entry, result);
        batch = [];
        bytes = 0;
    };
    for (const entry of new Set(paths)) {
        const size = Buffer.byteLength(entry, 'utf8') + 1;
        if (entry.includes('\0') || size > GIT_IGNORE_BATCH_MAX_BYTES) {
            results.set(entry, { ignored: false, error: 'git check-ignore candidate exceeds the batch path limit or contains NUL' });
            continue;
        }
        if (batch.length >= GIT_IGNORE_BATCH_MAX_PATHS || bytes + size > GIT_IGNORE_BATCH_MAX_BYTES) flush();
        batch.push(entry);
        bytes += size;
    }
    flush();
    return results;
}

function getHashableState(repoRoot: string, relativePath: string): HashableState | null {
    const repoRealPath = fs.existsSync(repoRoot) ? fs.realpathSync(repoRoot) : path.resolve(repoRoot);
    const state = getSafeWorktreePathState(repoRoot, relativePath, { repoRealPath });
    if (state.status === 'file' && state.sha256) {
        return {
            sha256: state.sha256,
            status: state.status
        };
    }
    if (state.status === 'symbolic_link') {
        const sha256 = state.target_sha256 || state.link_sha256 || '';
        if (sha256) {
            return {
                sha256,
                status: state.status
            };
        }
    }
    return null;
}

function normalizeSha256(value: unknown): string | null {
    const text = String(value || '').trim().toLowerCase();
    return /^[0-9a-f]{64}$/u.test(text) ? text : null;
}

function resolveGuardedTargetSha256(record: Record<string, unknown>): string | null {
    return normalizeSha256(record.sha256)
        || normalizeSha256(record.file_sha256)
        || normalizeSha256(record.content_sha256)
        || normalizeSha256(record.current_sha256);
}

function resolveGuardedTargetPath(record: Record<string, unknown>): string {
    return String(record.path || record.file || record.changed_file || record.changedFile || '').trim();
}

function extractGuardedTargetsFromValue(value: unknown, targets: GuardedIgnoredRemediationTarget[]): void {
    if (!isPlainRecord(value)) {
        return;
    }
    for (const key of [
        'ignored_remediation_targets',
        'ignoredRemediationTargets',
        'ignored_remediation_files',
        'ignoredRemediationFiles'
    ]) {
        const entries = value[key];
        if (!Array.isArray(entries)) {
            continue;
        }
        for (const entry of entries) {
            if (!isPlainRecord(entry)) {
                continue;
            }
            const targetPath = resolveGuardedTargetPath(entry);
            if (!targetPath) {
                continue;
            }
            targets.push({
                path: targetPath,
                sha256: resolveGuardedTargetSha256(entry),
                reason: typeof entry.reason === 'string' ? entry.reason.trim() || null : null,
                source: typeof entry.source === 'string' ? entry.source.trim() || null : null
            });
        }
    }
}

export function extractGuardedIgnoredRemediationTargets(value: unknown): GuardedIgnoredRemediationTarget[] {
    const targets: GuardedIgnoredRemediationTarget[] = [];
    extractGuardedTargetsFromValue(value, targets);
    return targets;
}

export function readTaskReviewArtifactTexts(repoRoot: string, taskId: string): string[] {
    return collectReviewArtifactPaths(repoRoot, taskId)
        .map((artifactPath) => readSmallTextFile(artifactPath))
        .filter(Boolean);
}

export function resolveIgnoredRemediationCommandChangedFiles(params: {
    repoRoot: string;
    taskId: string;
    reviewArtifactPaths?: readonly string[];
    taskMode?: Record<string, unknown> | null;
}): string[] {
    const candidates = new Map<string, IgnoredCandidate>();
    const reviewArtifactPaths = params.reviewArtifactPaths?.length
        ? params.reviewArtifactPaths
        : collectReviewArtifactPaths(params.repoRoot, params.taskId);
    const reviewTexts = reviewArtifactPaths
        .map((artifactPath) => readSmallTextFile(artifactPath))
        .filter(Boolean);

    for (const reviewText of reviewTexts) {
        for (const candidatePath of extractCandidatePathsFromText(params.repoRoot, reviewText)) {
            if (reviewTextApprovesPath(reviewText, candidatePath)) {
                addCandidate(candidates, params.repoRoot, candidatePath, 'review_finding');
            }
        }
    }
    for (const plannedPath of getTaskModePlannedChangedFiles(params.taskMode)) {
        addCandidate(candidates, params.repoRoot, plannedPath, 'task_plan');
    }

    const ignoredCandidates = readGitIgnoredCandidates(params.repoRoot, [...candidates.keys()]);
    return [...candidates.values()]
        .filter((candidate) => {
            const ignored = ignoredCandidates.get(candidate.path);
            return ignored?.ignored && !!getHashableState(params.repoRoot, candidate.path);
        })
        .map((candidate) => candidate.path)
        .sort();
}

export function assessExplicitIgnoredRemediationTargets(params: {
    repoRoot: string;
    taskId: string;
    currentChangedFiles: readonly string[];
    explicitChangedFiles?: readonly string[];
    guardedTargets?: readonly GuardedIgnoredRemediationTarget[];
    impactAnalysisSummary?: string;
    reviewEvidenceTexts?: readonly string[];
    taskMode?: Record<string, unknown> | null;
}): IgnoredRemediationTargetAssessment {
    const candidates = new Map<string, IgnoredCandidate>();
    const repoRoot = path.resolve(params.repoRoot);
    const currentChangedFiles = params.currentChangedFiles.map((entry) => normalizePath(entry)).filter(Boolean);
    const reviewEvidenceTexts = params.reviewEvidenceTexts || [];
    const taskModePlannedChangedFiles = getTaskModePlannedChangedFiles(params.taskMode);

    for (const changedFile of params.explicitChangedFiles || []) {
        addCandidate(candidates, repoRoot, changedFile, 'changed_file_flag');
    }
    for (const currentChangedFile of currentChangedFiles) {
        addCandidate(candidates, repoRoot, currentChangedFile, 'current_changed_file');
    }
    for (const plannedFile of taskModePlannedChangedFiles) {
        addCandidate(candidates, repoRoot, plannedFile, 'task_plan');
    }
    for (const guardedTarget of params.guardedTargets || []) {
        addCandidate(candidates, repoRoot, guardedTarget.path, 'guarded_remediation_evidence');
    }
    for (const reviewText of reviewEvidenceTexts) {
        for (const candidatePath of extractCandidatePathsFromText(repoRoot, reviewText)) {
            if (reviewTextApprovesPath(reviewText, candidatePath)) {
                addCandidate(candidates, repoRoot, candidatePath, 'review_finding');
            }
        }
    }

    const guardedByPath = new Map<string, GuardedIgnoredRemediationTarget[]>();
    for (const guardedTarget of params.guardedTargets || []) {
        const normalizedPath = normalizeRepoRelativePath(repoRoot, guardedTarget.path);
        if (!normalizedPath) {
            continue;
        }
        const existing = guardedByPath.get(normalizedPath) || [];
        existing.push(guardedTarget);
        guardedByPath.set(normalizedPath, existing);
    }

    const targets: IgnoredRemediationTargetEvidence[] = [];
    const violations: string[] = [];
    const ignoredCandidates = readGitIgnoredCandidates(repoRoot, [...candidates.keys()].filter((entry) => (
        !isTaskManualValidationPath(params.taskId, entry) && isPathInsideRoot(path.resolve(repoRoot, entry), repoRoot)
    )));
    for (const candidate of [...candidates.values()].sort((left, right) => left.path.localeCompare(right.path))) {
        if (isTaskManualValidationPath(params.taskId, candidate.path)) {
            continue;
        }
        const hardSource = [...candidate.sources].some((source) => (
            source === 'changed_file_flag'
            || source === 'current_changed_file'
            || source === 'task_plan'
            || source === 'guarded_remediation_evidence'
        ));
        const resolvedPath = path.resolve(repoRoot, candidate.path);
        if (!isPathInsideRoot(resolvedPath, repoRoot)) {
            violations.push(`ignored remediation target must stay inside repo root: ${candidate.path}`);
            continue;
        }
        const ignored = ignoredCandidates.get(candidate.path);
        if (!ignored) throw new Error(`Missing git ignore assessment for '${candidate.path}'.`);
        if (ignored.error) {
            violations.push(`ignored remediation target '${candidate.path}' could not be checked: ${ignored.error}`);
            continue;
        }
        if (!ignored.ignored) {
            continue;
        }
        const hashableState = getHashableState(repoRoot, candidate.path);
        if (!hashableState) {
            if (!hardSource) {
                continue;
            }
            violations.push(`ignored remediation target '${candidate.path}' is not hashable as a file or symlink.`);
            continue;
        }

        const guardedTargets = guardedByPath.get(candidate.path) || [];
        let matchingGuardedHash = false;
        for (const guardedTarget of guardedTargets) {
            const expectedSha256 = normalizeSha256(guardedTarget.sha256);
            if (!guardedTarget.sha256) {
                violations.push(`ignored remediation target '${candidate.path}' guarded evidence must include current sha256.`);
                continue;
            }
            if (!expectedSha256) {
                violations.push(`ignored remediation target hash for '${candidate.path}' is not a valid sha256.`);
                continue;
            }
            if (expectedSha256 !== hashableState.sha256) {
                violations.push(
                    `ignored remediation target hash mismatch for '${candidate.path}': ` +
                    `expected ${expectedSha256}, current ${hashableState.sha256}.`
                );
                continue;
            }
            matchingGuardedHash = true;
        }

        const approvedBy = new Set<string>();
        if (reviewEvidenceTexts.some((reviewText) => reviewTextApprovesPath(reviewText, candidate.path))) {
            approvedBy.add('review_finding');
        }
        if (candidate.sources.has('task_plan')) {
            approvedBy.add('task_plan');
        }
        if (matchingGuardedHash) {
            approvedBy.add('guarded_remediation_evidence');
        }
        if (approvedBy.size === 0) {
            violations.push(
                `ignored remediation target '${candidate.path}' is not approved by review finding, ` +
                'task plan, or guarded hash evidence.'
            );
            continue;
        }

        targets.push({
            path: candidate.path,
            sha256: hashableState.sha256,
            state: hashableState.status,
            explicit_sources: [...candidate.sources].sort(),
            approved_by: [...approvedBy].sort()
        });
    }

    return {
        targets,
        allowedBoundaryFiles: targets.map((target) => target.path).sort(),
        violations
    };
}
