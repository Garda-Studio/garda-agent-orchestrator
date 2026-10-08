import { TASK_QUEUE_FILENAME } from '../../core/orchestration-constants';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildBundleRelativePath } from '../../core/constants';
import { buildExactTaskIdReferencePattern } from '../../core/task-ids';
import { assertValidTaskId } from '../../gate-runtime/task-events';
import { fileSha256, normalizePath, parseBool, toStringArray } from '../shared/helpers';

/** Valid decision values for the doc-impact gate. */
export const VALID_DOC_IMPACT_DECISIONS: readonly string[] = Object.freeze([
    'DOCS_UPDATED',
    'NO_DOC_UPDATES'
]);

function normalizeDecisionShape(value: string): string {
    return value.replace(/[^A-Z0-9]+/g, '');
}

function suggestDocImpactDecision(decision: string): string | null {
    const shape = normalizeDecisionShape(decision);
    if (/^(DOCS?|DOCUMENTS?|DOCUMENTATION)UPDATE(?:D|S)?(?:COMPLETE)?$/.test(shape)) return 'DOCS_UPDATED';
    if (/^NO(DOCS?|DOCUMENTS?|DOCUMENTATION)UPDATE(?:D|S)?(?:COMPLETE)?$/.test(shape)) return 'NO_DOC_UPDATES';
    return null;
}

function buildUnknownDecisionViolation(decision: string): string {
    const validValues = VALID_DOC_IMPACT_DECISIONS.join(', ');
    const suggestedDecision = suggestDocImpactDecision(decision);
    if (suggestedDecision === 'DOCS_UPDATED') {
        return (
            `Unknown decision '${decision}'. Valid values: ${validValues}. ` +
            'Did you mean --decision "DOCS_UPDATED"? Pair it with --docs-updated <path> ' +
            'for each user-facing doc and set --changelog-updated true when the changelog changed.'
        );
    }
    if (suggestedDecision === 'NO_DOC_UPDATES') {
        return (
            `Unknown decision '${decision}'. Valid values: ${validValues}. ` +
            'Did you mean --decision "NO_DOC_UPDATES"? Use it only when no user-facing docs changed ' +
            'with --behavior-changed false --changelog-updated false, or provide internal closeout evidence ' +
            'for internal-only behavior changes.'
        );
    }
    return (
        `Unknown decision '${decision}'. Valid values: ${validValues}. ` +
        'Use --decision "DOCS_UPDATED" with --docs-updated <path> for user-facing documentation changes, ' +
        'or --decision "NO_DOC_UPDATES" only when no user-facing docs changed.'
    );
}

/**
 * Validate preflight for doc-impact gate.
 */
export function validatePreflightForDocImpact(preflightPath: string, explicitTaskId: string) {
    let preflight;
    try {
        preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8'));
    } catch {
        throw new Error(`Preflight artifact is not valid JSON: ${preflightPath}`);
    }

    const errors: string[] = [];
    let resolvedTaskId: string | null = null;
    if (explicitTaskId && explicitTaskId.trim()) {
        try {
            resolvedTaskId = assertValidTaskId(explicitTaskId);
        } catch (exc: unknown) {
            const message = exc instanceof Error ? exc.message : String(exc);
            errors.push(String(message));
        }
    }

    let preflightTaskId: string | null = String(preflight.task_id || '').trim();
    if (preflightTaskId) {
        try {
            preflightTaskId = assertValidTaskId(preflightTaskId);
        } catch (exc: unknown) {
            const message = exc instanceof Error ? exc.message : String(exc);
            errors.push(`preflight.task_id: ${message}`);
            preflightTaskId = null;
        }
    } else {
        preflightTaskId = null;
    }

    if (resolvedTaskId && preflightTaskId && resolvedTaskId !== preflightTaskId) {
        errors.push(`TaskId '${resolvedTaskId}' does not match preflight.task_id '${preflightTaskId}'.`);
    }
    if (!resolvedTaskId && preflightTaskId) resolvedTaskId = preflightTaskId;
    if (!resolvedTaskId) {
        errors.push('TaskId is required and must be provided either via --task-id or preflight.task_id.');
    }

    return {
        preflight,
        resolved_task_id: resolvedTaskId,
        preflight_path: path.resolve(preflightPath),
        preflight_hash: fileSha256(path.resolve(preflightPath)),
        errors
    };
}

export interface AssessDocImpactOptions {
    preflightPath: string;
    taskId?: string;
    decision?: string;
    behaviorChanged?: unknown;
    changelogUpdated?: unknown;
    internalChangelogUpdated?: unknown;
    projectMemoryUpdated?: unknown;
    projectMemoryUpdateNotNeeded?: unknown;
    sensitiveReviewed?: unknown;
    docsUpdated?: unknown;
    rationale?: string;
    repoRoot?: string;
}

export function normalizeDocImpactInputPath(input: string, repoRoot?: string): string {
    const inputPath = normalizePath(input);
    if (!inputPath) return '';
    const normalized = path.posix.normalize(inputPath);
    if (!repoRoot) {
        return normalized;
    }
    const relative = path.relative(path.resolve(repoRoot), path.resolve(repoRoot, normalized));
    if (relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
        return normalizePath(relative);
    }
    return normalized;
}

export function getInternalCloseoutEvidenceKind(
    input: string,
    repoRoot?: string
): 'task-queue' | 'internal-changelog' | 'project-memory' | null {
    const normalized = normalizeDocImpactInputPath(input, repoRoot).toLowerCase();
    if (normalized === TASK_QUEUE_FILENAME.toLowerCase()) return 'task-queue';
    if (normalized === INTERNAL_CHANGELOG_PATH.toLowerCase()) return 'internal-changelog';
    if (normalized.startsWith(`${PROJECT_MEMORY_ROOT.toLowerCase()}/`)) return 'project-memory';
    return null;
}

function describeInternalCloseoutEvidencePath(input: string, repoRoot?: string): string {
    const normalized = normalizeDocImpactInputPath(input, repoRoot);
    const kind = getInternalCloseoutEvidenceKind(input, repoRoot);
    if (kind === 'task-queue') {
        return `${normalized} (task queue closeout evidence)`;
    }
    if (kind === 'internal-changelog') {
        return `${normalized} (use --internal-changelog-updated true)`;
    }
    if (kind === 'project-memory') {
        return `${normalized} (use --project-memory-updated true)`;
    }
    return normalized;
}

const INTERNAL_CHANGELOG_PATH = buildBundleRelativePath('live/docs/changes/CHANGELOG.md');
const PROJECT_MEMORY_ROOT = buildBundleRelativePath('live/docs/project-memory');

function readTaskScopedFileEvidence(filePath: string, taskId: string): { path: string; sha256: string | null } | null {
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        return null;
    }
    const content = fs.readFileSync(filePath, 'utf8');
    if (!content.trim() || (taskId && !buildExactTaskIdReferencePattern(taskId).test(content))) {
        return null;
    }
    return {
        path: normalizePath(filePath),
        sha256: fileSha256(filePath)
    };
}

function collectTaskScopedProjectMemoryEvidence(
    directoryPath: string,
    taskId: string,
    maxFiles = 25
): Array<{ path: string; sha256: string | null }> {
    if (!fs.existsSync(directoryPath) || !fs.statSync(directoryPath).isDirectory()) {
        return [];
    }
    const evidence: Array<{ path: string; sha256: string | null }> = [];
    const visit = (currentPath: string): void => {
        if (evidence.length >= maxFiles) return;
        const entries = fs.readdirSync(currentPath, { withFileTypes: true })
            .sort((a, b) => a.name.localeCompare(b.name));
        for (const entry of entries) {
            if (evidence.length >= maxFiles) return;
            const childPath = path.join(currentPath, entry.name);
            if (entry.isDirectory()) {
                visit(childPath);
                continue;
            }
            if (!entry.isFile()) continue;
            const fileEvidence = readTaskScopedFileEvidence(childPath, taskId);
            if (fileEvidence) evidence.push(fileEvidence);
        }
    };
    visit(directoryPath);
    return evidence;
}

function hasInternalBehaviorEvidence(options: {
    internalChangelogUpdated: boolean;
    projectMemoryUpdated: boolean;
    projectMemoryUpdateNotNeeded: boolean;
}): boolean {
    return options.internalChangelogUpdated || options.projectMemoryUpdated || options.projectMemoryUpdateNotNeeded;
}

/**
 * Run doc-impact gate assessment.
 * Produces the canonical doc-impact gate output shape.
 */
export function assessDocImpact(options: AssessDocImpactOptions) {
    const preflightPath = options.preflightPath;
    const taskId = options.taskId || '';
    const decision = (options.decision || 'NO_DOC_UPDATES').trim().toUpperCase();
    const behaviorChanged = parseBool(options.behaviorChanged);
    const changelogUpdated = parseBool(options.changelogUpdated);
    const internalChangelogUpdated = parseBool(options.internalChangelogUpdated);
    const projectMemoryUpdated = parseBool(options.projectMemoryUpdated);
    const projectMemoryUpdateNotNeeded = parseBool(options.projectMemoryUpdateNotNeeded);
    const sensitiveReviewed = parseBool(options.sensitiveReviewed);
    const docsUpdated = [...new Set(toStringArray(options.docsUpdated, { trimValues: true }).filter(Boolean))].sort();
    const rationale = (options.rationale || '').trim();
    const validated = validatePreflightForDocImpact(preflightPath, taskId);
    const resolvedTaskId = validated.resolved_task_id;
    const errors = [...validated.errors];
    const normalizedRepoRoot = options.repoRoot ? path.resolve(options.repoRoot) : '';
    const internalChangelogEvidencePath = normalizedRepoRoot ? path.join(normalizedRepoRoot, INTERNAL_CHANGELOG_PATH) : '';
    const projectMemoryEvidenceRoot = normalizedRepoRoot ? path.join(normalizedRepoRoot, PROJECT_MEMORY_ROOT) : '';
    const internalChangelogEvidence = internalChangelogUpdated && internalChangelogEvidencePath
        ? readTaskScopedFileEvidence(internalChangelogEvidencePath, resolvedTaskId || '')
        : null;
    const projectMemoryEvidence = projectMemoryUpdated && projectMemoryEvidenceRoot
        ? collectTaskScopedProjectMemoryEvidence(projectMemoryEvidenceRoot, resolvedTaskId || '')
        : [];

    const sensitiveTriggersFired = [];
    const preflightObj = validated.preflight || {};
    const triggersObj = preflightObj.triggers || {};
    for (const triggerName of ['api', 'security', 'infra', 'dependency', 'db']) {
        if (triggersObj[triggerName]) sensitiveTriggersFired.push(triggerName);
    }

    // Reject unknown decision values (fail-closed).
    if (!VALID_DOC_IMPACT_DECISIONS.includes(decision)) {
        errors.push(buildUnknownDecisionViolation(decision));
    }

    if (!rationale || rationale.length < 12) {
        errors.push('Rationale is required (>= 12 chars).');
    }
    const internalBehaviorEvidencePresent = hasInternalBehaviorEvidence({
        internalChangelogUpdated,
        projectMemoryUpdated,
        projectMemoryUpdateNotNeeded
    });
    const internalBehaviorEvidenceMaterialized = (
        !!internalChangelogEvidence
        || projectMemoryUpdated
        || projectMemoryUpdateNotNeeded
    );
    const internalOnlyBehaviorEvidencePresent = decision === 'NO_DOC_UPDATES' && internalBehaviorEvidencePresent;
    const internalOnlyBehaviorEvidenceMaterialized = internalOnlyBehaviorEvidencePresent && internalBehaviorEvidenceMaterialized;
    const behaviorEvidenceMaterialized = decision === 'DOCS_UPDATED'
        ? internalBehaviorEvidenceMaterialized
        : internalOnlyBehaviorEvidenceMaterialized;
    if (projectMemoryUpdated && projectMemoryUpdateNotNeeded) {
        errors.push('ProjectMemoryUpdated=true is incompatible with ProjectMemoryUpdateNotNeeded=true.');
    }
    if (internalChangelogUpdated && !internalChangelogEvidence) {
        errors.push(
            `InternalChangelogUpdated=true requires task-scoped durable evidence in ${INTERNAL_CHANGELOG_PATH} containing task id '${resolvedTaskId || taskId}'.`
        );
    }
    if (decision === 'DOCS_UPDATED' && !docsUpdated.length) {
        errors.push('Decision DOCS_UPDATED requires non-empty docs_updated list.');
    }
    const internalCloseoutDocsUpdated = docsUpdated.filter((entry) => (
        getInternalCloseoutEvidenceKind(entry, options.repoRoot) !== null
    ));
    if (internalCloseoutDocsUpdated.length > 0) {
        errors.push(
            'docs_updated is reserved for user-facing documentation. Internal closeout evidence must use explicit fields: ' +
            internalCloseoutDocsUpdated.map((entry) => describeInternalCloseoutEvidencePath(entry, options.repoRoot)).join(', ') + '.'
        );
    }
    if (behaviorChanged && decision !== 'DOCS_UPDATED' && !internalOnlyBehaviorEvidenceMaterialized) {
        errors.push('BehaviorChanged=true requires Decision=DOCS_UPDATED or internal closeout evidence.');
    }
    if (behaviorChanged && !changelogUpdated && !behaviorEvidenceMaterialized) {
        errors.push('BehaviorChanged=true requires ChangelogUpdated=true or internal closeout evidence.');
    }

    // NO_DOC_UPDATES contract: docs_updated, changelog_updated, and
    // behavior_changed must all be unset / false unless behavior is documented
    // through explicit internal closeout evidence.
    if (decision === 'NO_DOC_UPDATES') {
        if (docsUpdated.length > 0) {
            errors.push('Decision NO_DOC_UPDATES is incompatible with a non-empty docs_updated list.');
        }
        if (changelogUpdated) {
            errors.push('Decision NO_DOC_UPDATES is incompatible with ChangelogUpdated=true.');
        }
        if (behaviorChanged && !internalOnlyBehaviorEvidenceMaterialized) {
            errors.push('Decision NO_DOC_UPDATES is incompatible with BehaviorChanged=true.');
        }
    }

    if (sensitiveTriggersFired.length > 0 && decision === 'NO_DOC_UPDATES' && !sensitiveReviewed) {
        const triggersStr = sensitiveTriggersFired.join(', ');
        errors.push(
            `Sensitive scope triggers detected (${triggersStr}): NO_DOC_UPDATES requires ` +
            '--sensitive-scope-reviewed true with rationale explaining why no documentation updates are needed.'
        );
    }

    const status = errors.length > 0 ? 'FAILED' : 'PASSED';
    const outcome = errors.length > 0 ? 'FAIL' : 'PASS';

    return {
        timestamp_utc: new Date().toISOString(),
        event_source: 'doc-impact-gate',
        task_id: resolvedTaskId,
        status,
        outcome,
        preflight_path: normalizePath(validated.preflight_path),
        preflight_hash_sha256: validated.preflight_hash,
        decision,
        behavior_changed: behaviorChanged,
        changelog_updated: changelogUpdated,
        internal_changelog_updated: internalChangelogUpdated,
        project_memory_updated: projectMemoryUpdated,
        project_memory_update_not_needed: projectMemoryUpdateNotNeeded,
        internal_closeout_evidence: {
            internal_changelog_updated: internalChangelogUpdated,
            project_memory_updated: projectMemoryUpdated,
            project_memory_update_not_needed: projectMemoryUpdateNotNeeded,
            internal_changelog_path: internalChangelogEvidence
                ? normalizeDocImpactInputPath(internalChangelogEvidence.path, options.repoRoot)
                : null,
            internal_changelog_sha256: internalChangelogEvidence?.sha256 || null,
            project_memory_files: projectMemoryEvidence.map((entry) => ({
                path: normalizeDocImpactInputPath(entry.path, options.repoRoot),
                sha256: entry.sha256
            }))
        },
        sensitive_triggers_detected: sensitiveTriggersFired,
        sensitive_scope_reviewed: sensitiveReviewed,
        docs_updated: docsUpdated,
        rationale,
        violations: errors
    };
}
