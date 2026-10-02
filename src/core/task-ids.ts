export const TASK_ID_MAX_LENGTH = 128;
export const TASK_ID_ALLOWED_PATTERN = /^T-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/u;
export const TASK_ID_CHARACTER_PATTERN = /^[A-Za-z0-9-]$/u;
const REVIEW_FINDINGS_FOLLOW_UP_TASK_ID_PATTERN = /-F[1-9][0-9]*$/u;

export function isReviewFindingsFollowUpTaskId(taskId: unknown): boolean {
    return typeof taskId === 'string'
        && TASK_ID_ALLOWED_PATTERN.test(taskId)
        && REVIEW_FINDINGS_FOLLOW_UP_TASK_ID_PATTERN.test(taskId);
}

export const RESERVED_TASK_EVENT_TIMELINE_NAMES = new Set<string>([
    'all-tasks',
    '.timeline-summary',
    'timeline-summary',
    'index'
]);

// Known artifact type suffixes used to split task-id from artifact-type.
// Ordered longest-first so greedy suffix matching selects the right boundary.
export const KNOWN_REVIEW_ARTIFACT_SUFFIXES: readonly string[] = Object.freeze([
    '-quality-checklist-answers.json',
    '-coherent-cycle-restart.json',
    '-review-cycle-restart.json',
    '-final-user-report.md',
    '-quality-checklist.json',
    '-scoped-summary.json',
    '-scoped-summary.md',
    '-task-plan.json',
    '-review-remediation-cycle.json',
    '-review-cycle-auto-split-prompt.md',
    '-strict-decomposition-decision.json',
    '-optional-skill-selection.json',
    '-dependency-review-context.json',
    '-performance-review-context.json',
    '-security-review-context.json',
    '-refactor-review-context.json',
    '-infra-review-context.json',
    '-code-review-context.json',
    '-test-review-context.json',
    '-api-review-context.json',
    '-db-review-context.json',
    '-dependency-receipt.json',
    '-performance-receipt.json',
    '-security-receipt.json',
    '-refactor-receipt.json',
    '-dependency-review-output.md',
    '-performance-review-output.md',
    '-security-review-output.md',
    '-refactor-review-output.md',
    '-command-timeout.json',
    '-completion-gate.json',
    '-full-suite-validation.json',
    '-full-suite-output.log',
    '-split-required.json',
    '-final-closeout.json',
    '-final-closeout.md',
    '-infra-receipt.json',
    '-infra-review-output.md',
    '-code-receipt.json',
    '-code-review-output.md',
    '-test-receipt.json',
    '-test-review-output.md',
    '-compile-output.log',
    '-compile-gate.json',
    '-api-receipt.json',
    '-api-review-output.md',
    '-db-receipt.json',
    '-db-review-output.md',
    '-review-gate.json',
    '-shell-smoke.json',
    '-doc-impact.json',
    '-task-mode.json',
    '-handshake.json',
    '-preflight.json',
    '-rule-pack.json',
    '-no-op.json',
    '-reset-report.json',
    '-dependency-scoped.json',
    '-performance-scoped.json',
    '-security-scoped.json',
    '-refactor-scoped.json',
    '-infra-scoped.json',
    '-code-scoped.json',
    '-test-scoped.json',
    '-api-scoped.json',
    '-db-scoped.json',
    '-dependency-scoped.diff',
    '-performance-scoped.diff',
    '-security-scoped.diff',
    '-refactor-scoped.diff',
    '-infra-scoped.diff',
    '-code-scoped.diff',
    '-test-scoped.diff',
    '-api-scoped.diff',
    '-db-scoped.diff',
    '-dependency.md',
    '-performance.md',
    '-security.md',
    '-refactor.md',
    '-infra.md',
    '-code.md',
    '-test.md',
    '-api.md',
    '-db.md'
]);

const REVIEW_TYPE_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const REVIEW_ARTIFACT_SUFFIX_CACHE_LIMIT = 64;
const reviewArtifactSuffixCache = new Map<string, readonly string[]>();

export function buildKnownReviewArtifactSuffixes(
    reviewTypeIds: readonly string[]
): readonly string[] {
    const normalizedReviewTypeIds = [...new Set(reviewTypeIds
        .map((reviewType) => String(reviewType || '').trim().toLowerCase())
        .filter((reviewType) => REVIEW_TYPE_ID_PATTERN.test(reviewType)))]
        .sort((left, right) => left.localeCompare(right));
    const cacheKey = normalizedReviewTypeIds.join('\u0000');
    const cached = reviewArtifactSuffixCache.get(cacheKey);
    if (cached) {
        return cached;
    }

    const suffixes = new Set<string>(KNOWN_REVIEW_ARTIFACT_SUFFIXES);
    for (const reviewType of normalizedReviewTypeIds) {
        for (const suffix of [
            `-${reviewType}-review-context.json`,
            `-${reviewType}-review-context.md`,
            `-${reviewType}-receipt.json`,
            `-${reviewType}-review-output.md`,
            `-${reviewType}-role-prompt.md`,
            `-${reviewType}-prompt-template.md`,
            `-${reviewType}-output-template.md`,
            `-${reviewType}-evidence-manifest.json`,
            `-${reviewType}-findings-validation.json`,
            `-${reviewType}-findings-disposition.json`,
            `-${reviewType}-findings-follow-ups.json`,
            `-${reviewType}-remediation-baseline.json`,
            `-${reviewType}-scoped.json`,
            `-${reviewType}-scoped.diff`,
            `-${reviewType}.md`
        ]) {
            suffixes.add(suffix);
        }
    }
    const built = Object.freeze([...suffixes].sort((left, right) => (
        right.length - left.length || left.localeCompare(right)
    )));
    if (reviewArtifactSuffixCache.size >= REVIEW_ARTIFACT_SUFFIX_CACHE_LIMIT) {
        const oldestKey = reviewArtifactSuffixCache.keys().next().value;
        if (typeof oldestKey === 'string') {
            reviewArtifactSuffixCache.delete(oldestKey);
        }
    }
    reviewArtifactSuffixCache.set(cacheKey, built);
    return built;
}

export function assertCanonicalTaskId(value: unknown): string {
    if (!value || !String(value).trim()) {
        throw new Error('TaskId must not be empty.');
    }
    const taskId = String(value).trim();
    if (taskId.length > TASK_ID_MAX_LENGTH) {
        throw new Error('TaskId must be 128 characters or fewer.');
    }
    if (RESERVED_TASK_EVENT_TIMELINE_NAMES.has(taskId.toLowerCase())) {
        throw new Error(`TaskId '${taskId}' is reserved for runtime task-event indexes.`);
    }
    if (!TASK_ID_ALLOWED_PATTERN.test(taskId)) {
        throw new Error(`TaskId '${taskId}' must match semantic pattern: T-<segment>(-<segment>)* where each segment is alphanumeric.`);
    }
    return taskId;
}

export function isCanonicalTaskId(value: unknown): boolean {
    try {
        assertCanonicalTaskId(value);
        return true;
    } catch {
        return false;
    }
}

export function isTaskIdReferenceBoundary(value: string | undefined): boolean {
    return value === undefined || !TASK_ID_CHARACTER_PATTERN.test(value);
}

export function escapeRegExpLiteral(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function buildExactTaskIdReferencePattern(taskId: string): RegExp {
    return new RegExp(`(^|[^A-Za-z0-9-])${escapeRegExpLiteral(taskId)}(?=$|[^A-Za-z0-9-])`, 'u');
}

export function parseTaskIdJsonlFileName(fileName: string): string | null {
    if (!fileName.endsWith('.jsonl') || fileName === 'all-tasks.jsonl') {
        return null;
    }
    const taskId = fileName.slice(0, -'.jsonl'.length).trim();
    return isCanonicalTaskId(taskId) ? taskId : null;
}

export function parseKnownReviewArtifactTaskId(
    fileName: string,
    knownSuffixes: readonly string[]
): string | null {
    for (const suffix of knownSuffixes) {
        if (fileName.endsWith(suffix)) {
            const taskId = fileName.slice(0, fileName.length - suffix.length);
            return isCanonicalTaskId(taskId) ? taskId : null;
        }
        const gzSuffix = `${suffix}.gz`;
        if (fileName.endsWith(gzSuffix)) {
            const taskId = fileName.slice(0, fileName.length - gzSuffix.length);
            return isCanonicalTaskId(taskId) ? taskId : null;
        }
    }
    return null;
}

export function parseConventionalReviewArtifactTaskId(fileName: string): string | null {
    const match = /^(T-\d+(?:-\d+)*)-.+$/iu.exec(fileName);
    if (!match) {
        return null;
    }
    const taskId = match[1];
    return isCanonicalTaskId(taskId) ? taskId : null;
}

export function parseStructuredTaskArtifactTaskId(fileName: string): string | null {
    const knownTaskId = parseKnownReviewArtifactTaskId(fileName, KNOWN_REVIEW_ARTIFACT_SUFFIXES);
    if (knownTaskId) {
        return knownTaskId;
    }

    const stem = fileName
        .replace(/\.gz$/iu, '')
        .replace(/\.[A-Za-z0-9]+$/u, '');
    const segments = stem.split('-');
    if (segments.length < 2 || segments[0] !== 'T') {
        return null;
    }
    const second = segments[1]?.trim();
    if (!second || !/^\d[A-Za-z0-9]*$/u.test(second)) {
        return null;
    }
    const taskSegments = ['T', second];
    for (let index = 2; index < segments.length; index += 1) {
        const segment = segments[index]?.trim();
        if (!segment) {
            break;
        }
        if (/^\d+$/u.test(segment) || /^[A-Za-z]+\d+$/u.test(segment)) {
            taskSegments.push(segment);
            continue;
        }
        break;
    }
    const taskId = taskSegments.join('-');
    return isCanonicalTaskId(taskId) ? taskId : null;
}

export function taskIdsEqualCaseInsensitive(left: string, right: string): boolean {
    return left.toLowerCase() === right.toLowerCase();
}

export function parseActiveReviewArtifactTaskId(
    fileName: string,
    activeTaskIds: ReadonlySet<string>
): string | null {
    const taskIds = Array.from(activeTaskIds)
        .filter((taskId) => isCanonicalTaskId(taskId))
        .sort((left, right) => right.length - left.length || left.localeCompare(right));
    const normalizedFileName = fileName.toLowerCase();
    for (const taskId of taskIds) {
        if (normalizedFileName.startsWith(`${taskId.toLowerCase()}-`)) {
            return taskId;
        }
    }
    return null;
}
