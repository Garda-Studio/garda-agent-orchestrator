import { TASK_QUEUE_FILENAME } from '../../../core/orchestration-constants';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

import { parseTaskMdTableRow } from '../../../core/task-md-table';
import { assertCanonicalTaskId } from '../../../core/task-ids';
import {
    buildTargetBundleRelativePath,
    resolveBundleRootForTarget
} from '../../../core/constants';
import {
    PROJECT_MEMORY_FOCUSED_FILE_NAMES,
    PROJECT_MEMORY_MAP_READ_GUIDANCE,
    PROJECT_MEMORY_MAP_WRITE_CONTRACT,
    PROJECT_MEMORY_READ_FIRST_FILE_NAMES,
    PROJECT_MEMORY_SUMMARY_RULE_RELATIVE_PATH,
    resolveLiveProjectMemoryDir,
    resolveProjectMemoryBootstrapReportPath
} from '../../../core/project-memory';
import { PROJECT_MEMORY_INIT_REFRESH_PROMPT } from '../../../core/project-memory-rollout';
import {
    computeTaskPlanDigest,
    isApprovedPlan,
    validateTaskPlan
} from '../../../schemas/task-plan';
import { getWorkspaceSnapshot } from '../../../gates/compile/compile-gate';
import { resolvePathInsideRepo } from '../../../gates/shared/helpers';
import { readAgentInitStateSafe } from '../../../runtime/agent-init-state';
import {
    buildOptionalSkillSelectionArtifact,
    buildCurrentCycleOptionalSkillActivationIndex,
    buildCurrentCycleOptionalSkillDeclineIndex,
    buildMandatoryCurrentCycleOptionalSkillActivationIndex,
    computeOptionalSkillTaskTextSha256,
    getOptionalSkillSelectionArtifactViolations,
    getOptionalSkillSelectionArtifactPath,
    isMandatoryOptionalSkillSelectionPolicyMode,
    isOptionalSkillSelectionPolicyConfigured,
    loadOptionalSkillSelectionHeadlinesCache,
    normalizeOptionalSkillPathEvidenceSource,
    normalizeOptionalSkillSelectionPhase,
    readOptionalSkillSelectionArtifact,
    readOptionalSkillSelectionPolicyConfig,
    readOptionalSkillSelectionTimelineEvidence,
    type OptionalSkillPathEvidenceSource,
    type OptionalSkillSelectionPhase
} from '../../../runtime/optional-skill-selection';
import { formatStatusSnapshotCompact, getStatusSnapshot } from '../../../validators/status';
import { getWhyBlocked } from '../../../validators/why-blocked';
import { buildTaskContextSelection } from './preprompt-task-context-selection';
import {
    buildOptionalSkillActivationCommand,
    buildOptionalSkillDeclineCommand,
    buildTaskContinuation,
    buildStartupScopeBlocker
} from './preprompt-task-commands';

const MAX_PREPROMPT_CHANGED_FILES = 12;
const MAX_PREPROMPT_REVIEW_ARTIFACTS = 12;
const MAX_PREPROMPT_ARTIFACT_BYTES = 1024 * 1024;

export interface TaskQueueRow {
    id: string;
    status: string;
    priority: string;
    area: string;
    title: string;
    owner: string;
    updated: string;
    profile: string;
    notes: string;
}

export interface ExistingTaskArtifacts {
    review_artifacts: string[];
    review_artifacts_total_count: number;
    review_artifacts_truncated: boolean;
    review_artifacts_omitted_count: number;
    timeline_exists: boolean;
    timeline_path: string;
}

export interface ProjectMemoryBrief {
    status: 'ready' | 'partial' | 'missing';
    read_strategy: 'index_first';
    directory: string;
    summary_rule: string;
    bootstrap_report_path: string;
    initialization_state: {
        state_path: string;
        initialized: boolean;
        validated: boolean;
        pending: boolean;
        error: string | null;
    };
    init_refresh_prompt: string | null;
    read_first: string[];
    suggested_files: string[];
    missing_files: string[];
    warnings: string[];
    unknown_custom_stack_fallback: string;
    task_start_guidance: string[];
}

export interface BoundedListResult<T> {
    items: T[];
    total_count: number;
    truncated: boolean;
    omitted_count: number;
}

export interface JsonArtifactReadResult<T extends Record<string, unknown>> {
    payload: T;
    sha256: string;
}

export function computeSha256FromText(text: string): string {
    return createHash('sha256').update(text, 'utf8').digest('hex');
}

function resolveBriefPath(repoRoot: string, filePath: string): string {
    const confinedPath = resolvePathInsideRepo(filePath, repoRoot, { allowMissing: true, enforceInside: true });
    if (!confinedPath) {
        throw new Error('A nonempty repository-confined brief path is required.');
    }
    return confinedPath;
}

export function readJsonArtifactIfExists<T extends Record<string, unknown>>(
    filePath: string,
    options: { includeSha?: boolean; repoRoot?: string; taskId?: string } = {}
): JsonArtifactReadResult<T> | null {
    try {
        if (options.repoRoot) {
            filePath = resolveBriefPath(options.repoRoot, filePath);
        }
        if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()
            || fs.statSync(filePath).size > MAX_PREPROMPT_ARTIFACT_BYTES) {
            return null;
        }
        const fileText = fs.readFileSync(filePath, 'utf8');
        const payload = JSON.parse(fileText) as T;
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)
            || (options.taskId && payload.task_id !== options.taskId)) {
            return null;
        }
        return {
            payload,
            sha256: options.includeSha === true ? computeSha256FromText(fileText) : ''
        };
    } catch {
        return null;
    }
}

export function toPortableRepoPath(targetRoot: string, filePath: string): string {
    const resolvedTargetRoot = path.resolve(targetRoot);
    const resolvedFilePath = path.resolve(filePath);
    const relative = path.relative(resolvedTargetRoot, resolvedFilePath);
    if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
        return relative.replace(/\\/g, '/');
    }
    return filePath.replace(/\\/g, '/');
}

export function fileExists(filePath: string): boolean {
    try {
        return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
    } catch {
        return false;
    }
}

export function boundList<T>(items: T[], limit: number): BoundedListResult<T> {
    const normalizedLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : items.length;
    const boundedItems = items.slice(0, normalizedLimit);
    return {
        items: boundedItems,
        total_count: items.length,
        truncated: items.length > boundedItems.length,
        omitted_count: Math.max(items.length - boundedItems.length, 0)
    };
}

export function normalizeTaskRow(taskPath: string, taskId: string): TaskQueueRow | null {
    if (!fs.existsSync(taskPath) || !fs.statSync(taskPath).isFile()) {
        return null;
    }
    const lines = fs.readFileSync(taskPath, 'utf8').split(/\r?\n/);
    for (const rawLine of lines) {
        const trimmed = rawLine.trim();
        if (!trimmed.startsWith('|')) {
            continue;
        }
        const cells = parseTaskMdTableRow(rawLine);
        if (cells.length < 9) {
            continue;
        }
        if (cells[0].trimmed.toLowerCase() === 'id' || cells[0].trimmed.startsWith('-') || cells[0].trimmed.startsWith('=')) {
            continue;
        }
        if (cells[0].trimmed !== taskId) {
            continue;
        }
        return {
            id: cells[0].trimmed,
            status: cells[1].trimmed,
            priority: cells[2].trimmed,
            area: cells[3].trimmed,
            title: cells[4].trimmed,
            owner: cells[5].trimmed,
            updated: cells[6].trimmed,
            profile: cells[7].trimmed,
            notes: cells.slice(8).map((cell) => cell.trimmed).join(' | ').trim()
        };
    }
    return null;
}

export function addUnique<T>(items: T[], value: T): void {
    if (!items.includes(value)) {
        items.push(value);
    }
}

export function matchesAnySignal(text: string, signals: readonly string[]): boolean {
    return signals.some((signal) => text.includes(signal));
}

export function inferProjectMemorySuggestedFileNames(
    taskRow: TaskQueueRow,
    changedFiles: readonly string[]
): string[] {
    const signalText = [
        taskRow.area,
        taskRow.title,
        taskRow.notes,
        ...changedFiles
    ].join('\n').toLowerCase();
    const suggested: string[] = [];
    const add = (fileName: string) => {
        if ((PROJECT_MEMORY_FOCUSED_FILE_NAMES as readonly string[]).includes(fileName)) {
            addUnique(suggested, fileName);
        }
    };

    if (matchesAnySignal(signalText, ['unknown stack', 'custom stack', 'unrecognized stack', 'unrecognised stack'])) {
        add('stack.md');
        add('commands.md');
        add('module-map.md');
    }
    if (matchesAnySignal(signalText, ['architecture', 'boundary', 'component', 'integration', 'module', 'decision', 'adr'])) {
        add('architecture.md');
        add('decisions.md');
        add('module-map.md');
        add('risks.md');
    }
    if (matchesAnySignal(signalText, [
        'workflow', 'orchestrator', 'gate', 'lifecycle', 'preflight', 'review', 'cli',
        'command', 'setup', 'install', 'update', 'materialization', 'materialisation',
        'template', 'agent-rules', 'task-entry', 'task entry'
    ])) {
        add('commands.md');
        add('module-map.md');
        add('risks.md');
        add('decisions.md');
    }
    if (matchesAnySignal(signalText, ['stack', 'runtime', 'framework', 'language', 'dependency', 'package manager', 'skill pack'])) {
        add('stack.md');
        add('commands.md');
        add('module-map.md');
    }
    if (matchesAnySignal(signalText, ['style', 'convention', 'format', 'lint', 'naming'])) {
        add('conventions.md');
        add('stack.md');
    }
    if (matchesAnySignal(signalText, ['security', 'secret', 'auth', 'permission', 'token'])) {
        add('risks.md');
        add('architecture.md');
        add('commands.md');
    }
    if (matchesAnySignal(signalText, ['test', 'spec', 'fixture', 'coverage', 'validation'])) {
        add('commands.md');
        add('conventions.md');
        add('module-map.md');
    }
    if (matchesAnySignal(signalText, ['docs', 'readme', 'documentation'])) {
        add('context.md');
        add('module-map.md');
        add('conventions.md');
    }

    if (suggested.length === 0) {
        add('module-map.md');
        add('architecture.md');
        add('commands.md');
        add('risks.md');
    }

    return suggested.slice(0, 4);
}

export function buildProjectMemoryBrief(
    targetRoot: string,
    bundleRoot: string,
    taskRow: TaskQueueRow,
    changedFiles: readonly string[]
): ProjectMemoryBrief {
    const memoryDir = resolveLiveProjectMemoryDir(bundleRoot);
    const readFirst = PROJECT_MEMORY_READ_FIRST_FILE_NAMES.map((fileName) => (
        toPortableRepoPath(targetRoot, path.join(memoryDir, fileName))
    ));
    const suggestedFileNames = inferProjectMemorySuggestedFileNames(taskRow, changedFiles);
    const suggestedFiles = suggestedFileNames.map((fileName) => (
        toPortableRepoPath(targetRoot, path.join(memoryDir, fileName))
    ));
    const summaryRulePath = path.join(bundleRoot, PROJECT_MEMORY_SUMMARY_RULE_RELATIVE_PATH);
    const bootstrapReportPath = resolveProjectMemoryBootstrapReportPath(bundleRoot);
    const missingFiles = [...readFirst, ...suggestedFiles, toPortableRepoPath(targetRoot, summaryRulePath)]
        .filter((displayPath) => fileExists(path.join(targetRoot, ...displayPath.split('/'))) === false);
    const directoryMissing = !fs.existsSync(memoryDir) || !fs.statSync(memoryDir).isDirectory();
    const readFirstMissing = readFirst.filter((displayPath) => fileExists(path.join(targetRoot, ...displayPath.split('/'))) === false);
    const summaryMissing = !fileExists(summaryRulePath);
    const suggestedMissing = suggestedFiles.filter((displayPath) => fileExists(path.join(targetRoot, ...displayPath.split('/'))) === false);
    const warnings: string[] = [];
    const agentInitStateResult = readAgentInitStateSafe(targetRoot);
    const projectMemoryInitialized = agentInitStateResult.state?.ProjectMemoryInitialized === true;
    const projectMemoryValidated = agentInitStateResult.state?.ProjectMemoryValidated === true;
    const projectMemoryStatePending = !projectMemoryInitialized || !projectMemoryValidated || agentInitStateResult.error !== null;
    const agentInitPointer = [
        `Give the agent this canonical prompt: "${PROJECT_MEMORY_INIT_REFRESH_PROMPT}"`,
        'Then run `node garda-agent-orchestrator/bin/garda.js agent-init --target-root "."` to record initialized/validated state.'
    ].join(' ');

    if (directoryMissing) {
        warnings.push(`Project memory directory is missing. ${agentInitPointer}`);
    } else if (readFirstMissing.length > 0) {
        warnings.push(`Project memory read-first files are missing: ${readFirstMissing.join(', ')}. ${agentInitPointer}`);
    }
    if (summaryMissing) {
        warnings.push(`Generated project-memory summary rule is missing: ${toPortableRepoPath(targetRoot, summaryRulePath)}. ${agentInitPointer}`);
    }
    if (!directoryMissing && suggestedMissing.length > 0) {
        warnings.push(`Some task-suggested project-memory files are missing: ${suggestedMissing.join(', ')}. Inspect source evidence as fallback.`);
    }
    if (agentInitStateResult.error) {
        warnings.push(`Project memory agent-init state is invalid: ${agentInitStateResult.error}. ${agentInitPointer}`);
    } else if (projectMemoryStatePending) {
        warnings.push(`Project memory is not recorded as initialized and validated in agent-init state. ${agentInitPointer}`);
    }

    const fileStatus = directoryMissing
        ? 'missing'
        : (readFirstMissing.length > 0 || summaryMissing || suggestedMissing.length > 0) ? 'partial' : 'ready';

    return {
        status: fileStatus === 'ready' && projectMemoryStatePending ? 'partial' : fileStatus,
        read_strategy: 'index_first',
        directory: toPortableRepoPath(targetRoot, memoryDir),
        summary_rule: toPortableRepoPath(targetRoot, summaryRulePath),
        bootstrap_report_path: toPortableRepoPath(targetRoot, bootstrapReportPath),
        initialization_state: {
            state_path: toPortableRepoPath(targetRoot, agentInitStateResult.statePath),
            initialized: projectMemoryInitialized,
            validated: projectMemoryValidated,
            pending: projectMemoryStatePending,
            error: agentInitStateResult.error
        },
        init_refresh_prompt: projectMemoryStatePending ? PROJECT_MEMORY_INIT_REFRESH_PROMPT : null,
        read_first: readFirst,
        suggested_files: suggestedFiles,
        missing_files: [...new Set(missingFiles)],
        warnings,
        unknown_custom_stack_fallback: [
            'If the stack is unknown or custom, read stack.md, commands.md, and module-map.md,',
            'then inspect repository evidence before applying any framework-specific defaults.'
        ].join(' '),
        task_start_guidance: [
            PROJECT_MEMORY_MAP_READ_GUIDANCE,
            'Read the generated summary rule as orientation after TASK_ENTRY rule loading.',
            'Read README.md and compact.md first.',
            'Read only the suggested focused memory files for this task.',
            PROJECT_MEMORY_MAP_WRITE_CONTRACT
        ]
    };
}

export function listTaskArtifacts(targetRoot: string, taskId: string): ExistingTaskArtifacts {
    const bundleRoot = resolveBundleRootForTarget(targetRoot);
    const reviewsRoot = resolveBriefPath(targetRoot, path.join(bundleRoot, 'runtime', 'reviews'));
    const timelinePath = resolveBriefPath(targetRoot, path.join(bundleRoot, 'runtime', 'task-events', `${taskId}.jsonl`));
    const reviewArtifacts = fs.existsSync(reviewsRoot) && fs.statSync(reviewsRoot).isDirectory()
        ? fs.readdirSync(reviewsRoot)
            .filter((entry) => entry.startsWith(`${taskId}-`))
            .map((entry) => {
                const absolutePath = path.join(reviewsRoot, entry);
                let modifiedTimeMs = 0;
                try {
                    modifiedTimeMs = fs.statSync(resolveBriefPath(targetRoot, absolutePath)).mtimeMs;
                } catch {
                    modifiedTimeMs = 0;
                }
                return {
                    path: buildTargetBundleRelativePath(targetRoot, `runtime/reviews/${entry}`),
                    modified_time_ms: modifiedTimeMs
                };
            })
            .sort((left, right) => (
                right.modified_time_ms - left.modified_time_ms
                || left.path.localeCompare(right.path)
            ))
            .map((entry) => entry.path)
        : [];
    const boundedArtifacts = boundList(reviewArtifacts, MAX_PREPROMPT_REVIEW_ARTIFACTS);
    return {
        review_artifacts: boundedArtifacts.items,
        review_artifacts_total_count: boundedArtifacts.total_count,
        review_artifacts_truncated: boundedArtifacts.truncated,
        review_artifacts_omitted_count: boundedArtifacts.omitted_count,
        timeline_exists: fs.existsSync(timelinePath) && fs.statSync(timelinePath).isFile(),
        timeline_path: buildTargetBundleRelativePath(targetRoot, `runtime/task-events/${taskId}.jsonl`)
    };
}

export function readTaskTimelineEvents(targetRoot: string, taskId: string): string[] {
    const timelinePath = resolveBriefPath(targetRoot, path.join(resolveBundleRootForTarget(targetRoot), 'runtime', 'task-events', `${taskId}.jsonl`));
    if (!fs.existsSync(timelinePath) || !fs.statSync(timelinePath).isFile()) {
        return [];
    }
    const eventTypes: string[] = [];
    for (const line of fs.readFileSync(timelinePath, 'utf8').split(/\r?\n/)) {
        if (!line.trim()) {
            continue;
        }
        try {
            const parsed = JSON.parse(line) as Record<string, unknown>;
            const eventType = String(parsed.event_type || '').trim().toUpperCase();
            if (eventType) {
                eventTypes.push(eventType);
            }
        } catch {
            // Ignore malformed lines in this read-only bootstrap view.
        }
    }
    return eventTypes;
}

export function summarizeWorkspaceSnapshot(snapshot: Record<string, unknown>): Record<string, unknown> {
    const changedFiles = Array.isArray(snapshot.changed_files)
        ? snapshot.changed_files.map((entry) => String(entry)).filter(Boolean)
        : [];
    const boundedChangedFiles = boundList(changedFiles, MAX_PREPROMPT_CHANGED_FILES);
    return {
        ...snapshot,
        changed_files: boundedChangedFiles.items,
        changed_files_total_count: Number(snapshot.changed_files_count || changedFiles.length) || 0,
        changed_files_truncated: boundedChangedFiles.truncated,
        changed_files_omitted_count: boundedChangedFiles.omitted_count
    };
}

export function readPlannedChangedFiles(taskModePayload: Record<string, unknown> | null): string[] {
    if (!Array.isArray(taskModePayload?.planned_changed_files)) {
        return [];
    }
    return taskModePayload.planned_changed_files
        .map((entry) => String(entry || '').trim().replace(/\\/g, '/'))
        .filter(Boolean);
}

export function readOptionalSkillPolicyModeSafe(bundleRoot: string): string | null {
    try {
        return readOptionalSkillSelectionPolicyConfig(bundleRoot).mode;
    } catch {
        return null;
    }
}

function normalizePortablePathList(paths: readonly string[] | null | undefined): string[] {
    return [...new Set((Array.isArray(paths) ? paths : [])
        .map((entry) => String(entry || '').replace(/\\/g, '/').trim())
        .filter(Boolean))]
        .sort();
}

function pathScopeContainsAll(scopePaths: readonly string[], changedPaths: readonly string[]): boolean {
    if (changedPaths.length === 0) {
        return true;
    }
    const scope = new Set(normalizePortablePathList(scopePaths));
    return normalizePortablePathList(changedPaths).every((entry) => scope.has(entry));
}

function readApprovedTaskPlanScopeFiles(
    repoRoot: string,
    taskId: string,
    taskModePayload: Record<string, unknown> | null
): string[] {
    const planMetadata = taskModePayload?.plan;
    if (!planMetadata || typeof planMetadata !== 'object' || Array.isArray(planMetadata)) {
        return [];
    }
    const planRecord = planMetadata as Record<string, unknown>;
    const planPath = String(planRecord.plan_path || '').trim();
    const planSha256 = String(planRecord.plan_sha256 || '').trim();
    if (!planPath || !planSha256) {
        return [];
    }
    try {
        const planFilePath = resolvePathInsideRepo(planPath, repoRoot, { allowMissing: false });
        if (!planFilePath || !fs.existsSync(planFilePath) || !fs.statSync(planFilePath).isFile()) {
            return [];
        }
        const validatedPlan = validateTaskPlan(JSON.parse(fs.readFileSync(planFilePath, 'utf8')));
        if (validatedPlan.task_id !== taskId || !isApprovedPlan(validatedPlan)) {
            return [];
        }
        const currentDigest = computeTaskPlanDigest(validatedPlan);
        if (currentDigest !== planSha256) {
            return [];
        }
        return normalizePortablePathList(validatedPlan.scope_files);
    } catch {
        return [];
    }
}

function resolveOptionalSkillPreviewPhaseInput(
    repoRoot: string,
    taskId: string,
    preflightPayload: Record<string, unknown> | null,
    taskModePayload: Record<string, unknown> | null,
    previewChangedPaths: readonly string[]
): {
    selectionPhase: OptionalSkillSelectionPhase;
    pathEvidenceSource: OptionalSkillPathEvidenceSource;
} {
    const changedPaths = normalizePortablePathList(previewChangedPaths);
    if (changedPaths.length === 0) {
        return {
            selectionPhase: 'pre_implementation',
            pathEvidenceSource: 'none'
        };
    }
    const plannedChangedFiles = readPlannedChangedFiles(taskModePayload);
    if (!preflightPayload || pathScopeContainsAll(plannedChangedFiles, changedPaths)) {
        return {
            selectionPhase: 'pre_implementation',
            pathEvidenceSource: 'planned_changed_files'
        };
    }
    if (pathScopeContainsAll(readApprovedTaskPlanScopeFiles(repoRoot, taskId, taskModePayload), changedPaths)) {
        return {
            selectionPhase: 'pre_implementation',
            pathEvidenceSource: 'task_plan_scope'
        };
    }
    if (String(preflightPayload.detection_source || '').trim() === 'explicit_changed_files') {
        return {
            selectionPhase: 'pre_implementation',
            pathEvidenceSource: 'explicit_scope'
        };
    }
    return {
        selectionPhase: 'post_diff',
        pathEvidenceSource: 'actual_changed_files'
    };
}

function buildOptionalSkillTaskStartInstruction(input: {
    policyMode: string;
    decision: string | null;
    selectedSkillIds: string[];
    recommendedMissingPackIds: string[];
    asIsReason: string | null;
    artifactPath: string;
    headlinesPath: string | null;
    selectionPhase: OptionalSkillSelectionPhase;
    pathEvidenceSource: OptionalSkillPathEvidenceSource;
    activationReady: boolean;
    activationCommands: string[];
    declinedSkillIds?: string[];
    declineCommands?: string[];
}): string {
    if (input.policyMode === 'off') {
        return 'Optional skill selection is disabled by policy; proceed without specialized optional skill activation.';
    }
    if (input.selectionPhase === 'post_diff') {
        if (input.selectedSkillIds.length > 0) {
            return `Selected optional skill(s): ${input.selectedSkillIds.join(', ')} surfaced from post-diff changed paths. Treat this as a post-implementation self-check only; do not activate it as pre-implementation skill use.`;
        }
        if (input.recommendedMissingPackIds.length > 0) {
            return `Optional skill recommendation(s): ${input.recommendedMissingPackIds.join(', ')} surfaced from post-diff changed paths. Treat this as a post-implementation self-check only; do not install or activate them as pre-implementation gate work.`;
        }
        const reason = input.asIsReason || 'generic_context_sufficient';
        return `Optional skill selection surfaced post-diff as_is (${reason}). Treat this as a post-implementation self-check only; no pre-implementation activation is required.`;
    }
    if (input.selectedSkillIds.length > 0) {
        const skillList = input.selectedSkillIds.join(', ');
        const declinedSkillIds = input.declinedSkillIds || [];
        if (declinedSkillIds.length > 0 && input.activationCommands.length === 0) {
            return `Selected optional skill(s): ${skillList}. Explicit non-use is recorded for ${declinedSkillIds.join(', ')}; continue with the normal navigator command.`;
        }
        if (input.activationReady && input.activationCommands.length > 0) {
            if (isMandatoryOptionalSkillSelectionPolicyMode(input.policyMode)) {
                return `Selected optional skill(s): ${skillList}. Run the activation command(s) before implementation so the timeline records the required chosen role/skill.`;
            }
            const declineHint = (input.declineCommands || []).length > 0
                ? ' If you intentionally will not use it, run the decline command instead so next-step records non-use.'
                : '';
            return `Selected optional skill(s): ${skillList}. If you use the selected skill, run the activation command(s) before implementation so the timeline records that choice; otherwise continue with the normal navigator command.${declineHint}`;
        }
        return `Selected optional skill(s): ${skillList}. Materialize the current-cycle selection artifact with classify-change before implementation, then activate the selected skill.`;
    }
    if (input.recommendedMissingPackIds.length > 0) {
        if (isMandatoryOptionalSkillSelectionPolicyMode(input.policyMode)) {
            return `Mandatory optional skill selection found missing pack recommendation(s): ${input.recommendedMissingPackIds.join(', ')}. Install a recommended pack, create or choose an installed specialist skill, then rerun classify-change and activation before implementation.`;
        }
        return `No installed optional skill is selected; missing pack recommendation(s): ${input.recommendedMissingPackIds.join(', ')}. Inspect the compact skill catalog before implementation and either install/select a pack through the supported flow or proceed with the recorded no-specialized-skill decision.`;
    }
    const reason = input.asIsReason || 'generic_context_sufficient';
    if (isMandatoryOptionalSkillSelectionPolicyMode(input.policyMode)) {
        return `Mandatory optional skill selection has no installed specialist skill selected (reason: ${reason}). Install or create a relevant specialist skill, choose it for this task, then rerun classify-change and activation before implementation.`;
    }
    const catalogHint = input.headlinesPath
        ? ` Compact catalog: ${input.headlinesPath}.`
        : '';
    return `No specialized optional skill selected; current-cycle evidence records as_is (${reason}). Inspect the compact skill catalog if that looks wrong; otherwise this is the explicit no-specialized-skill-needed decision.${catalogHint}`;
}

export function buildOptionalSkillsDiagnostics(
    repoRoot: string,
    targetRoot: string,
    bundleRoot: string,
    taskId: string,
    taskSummary: string,
    preflightPath: string,
    preflightPayload: Record<string, unknown> | null,
    preflightSha256: string | null,
    taskModePayload: Record<string, unknown> | null
): Record<string, unknown> | null {
    if (!isOptionalSkillSelectionPolicyConfigured(bundleRoot)) {
        return null;
    }
    const portableArtifactPath = toPortableRepoPath(targetRoot, getOptionalSkillSelectionArtifactPath(bundleRoot, taskId));
    try {
        const policyConfig = readOptionalSkillSelectionPolicyConfig(bundleRoot);
        const expectedTaskTextSha256 = computeOptionalSkillTaskTextSha256(taskSummary);
        if (policyConfig.mode === 'off') {
            return {
                artifact_path: portableArtifactPath,
                artifact_present: false,
                current_policy_mode: policyConfig.mode,
                policy_mode: policyConfig.mode,
                decision: null,
                selected_installed_skills: [],
                selected_installed_skill_paths: [],
                selected_installed_skill_sources: [],
                selected_installed_skill_details: [],
                selected_installed_skill_activation_ready: false,
                selected_installed_skill_activation_blocker: null,
                selected_installed_skill_activation_commands: [],
                selected_installed_skill_declined_ids: [],
                selected_installed_skill_decline_commands: [],
                skill_catalog_path: toPortableRepoPath(targetRoot, path.join(bundleRoot, 'live', 'config', 'skills-headlines.json')),
                task_start_instruction: buildOptionalSkillTaskStartInstruction({
                    policyMode: policyConfig.mode,
                    decision: null,
                    selectedSkillIds: [],
                    recommendedMissingPackIds: [],
                    asIsReason: 'policy_off',
                    artifactPath: portableArtifactPath,
                    headlinesPath: toPortableRepoPath(targetRoot, path.join(bundleRoot, 'live', 'config', 'skills-headlines.json')),
                    selectionPhase: 'pre_implementation',
                    pathEvidenceSource: 'none',
                    activationReady: false,
                    activationCommands: [],
                    declinedSkillIds: [],
                    declineCommands: []
                }),
                selection_phase: 'pre_implementation',
                path_evidence_source: 'none',
                recommended_missing_packs: [],
                as_is_reason: 'policy_off',
                visible_summary_line: 'Optional skills: as_is (reason: policy_off)',
                blocker: null
            };
        }
        const currentCycleArtifact = preflightPayload
            ? readOptionalSkillSelectionArtifact(bundleRoot, taskId)
            : null;
        const previewChangedPaths = Array.isArray(preflightPayload?.changed_files)
            ? preflightPayload.changed_files.map((entry) => String(entry || ''))
            : readPlannedChangedFiles(taskModePayload);
        const previewPhaseInput = resolveOptionalSkillPreviewPhaseInput(
            repoRoot,
            taskId,
            preflightPayload,
            taskModePayload,
            previewChangedPaths
        );
        let loadedHeadlinesCache: ReturnType<typeof loadOptionalSkillSelectionHeadlinesCache> = loadOptionalSkillSelectionHeadlinesCache(
            bundleRoot,
            policyConfig.mode,
            {
                preferPersistedSurface: true
            }
        );
        const currentArtifactViolations = currentCycleArtifact
            ? getOptionalSkillSelectionArtifactViolations(bundleRoot, currentCycleArtifact, {
                requireMaterializedArtifact: true,
                expectedPreflightPath: preflightPayload ? preflightPath : null,
                expectedPreflightSha256: preflightPayload ? (preflightSha256 || null) : null,
                expectedTaskTextSha256,
                expectedPolicyMode: policyConfig.mode,
                loadedHeadlinesCache
            })
            : [];
        // Activation-ready checks reuse the same artifact contract as currentArtifactViolations.
        // When the current artifact is stale, advisory mode should still recompute a preview
        // instead of surfacing those stale-artifact violations as a task-start blocker.
        const activationArtifactViolations: string[] = [];
        const preview = currentCycleArtifact && currentArtifactViolations.length === 0
            ? currentCycleArtifact
            : (() => {
                loadedHeadlinesCache = loadedHeadlinesCache || loadOptionalSkillSelectionHeadlinesCache(bundleRoot, policyConfig.mode, {
                    preferPersistedSurface: true
                });
                return buildOptionalSkillSelectionArtifact(bundleRoot, taskId, {
                    taskText: taskSummary,
                    changedPaths: previewChangedPaths,
                    selectionPhase: previewPhaseInput.selectionPhase,
                    pathEvidenceSource: previewPhaseInput.pathEvidenceSource,
                    preflightPath: preflightPayload ? preflightPath : null,
                    preflightSha256: preflightPayload ? preflightSha256 : null,
                    loadedHeadlinesCache
                });
            })();
        const previewViolations = currentCycleArtifact && currentArtifactViolations.length === 0
            ? []
            : getOptionalSkillSelectionArtifactViolations(bundleRoot, preview, {
                requireMaterializedArtifact: false,
                expectedPreflightPath: preflightPayload ? preflightPath : null,
                expectedPreflightSha256: preflightPayload ? (preflightSha256 || null) : null,
                expectedTaskTextSha256,
                expectedPolicyMode: policyConfig.mode,
                loadedHeadlinesCache
        });
        const policyMode = policyConfig.mode;
        const isMandatoryPolicy = isMandatoryOptionalSkillSelectionPolicyMode(policyMode);
        const requiresMaterializedArtifact = isMandatoryPolicy;
        const selectedSkillIds = preview.payload.selected_installed_skills.map((entry) => entry.id);
        const selectionPhase = normalizeOptionalSkillSelectionPhase(
            preview.payload.selection_phase,
            previewPhaseInput.selectionPhase
        );
        const pathEvidenceSource = normalizeOptionalSkillPathEvidenceSource(
            preview.payload.path_evidence_source,
            previewPhaseInput.pathEvidenceSource
        );
        const isPostDiffSelection = selectionPhase === 'post_diff';
        const postDiffSelfCheck = isPostDiffSelection && selectedSkillIds.length > 0;
        const selectedSkillPaths = preview.payload.selected_installed_skills.map((entry) => entry.allowed_skill_path);
        const selectedSkillSources = preview.payload.selected_installed_skills.map((entry) => entry.source);
        const selectedSkillDetails = preview.payload.selected_installed_skills.map((entry) => ({
            id: entry.id,
            pack: entry.pack,
            source: entry.source,
            allowed_skill_path: entry.allowed_skill_path,
            reason_codes: [...entry.reason_codes],
            matches: entry.matches
        }));
        const recommendedPackIds = preview.payload.recommended_missing_packs.map((entry) => entry.id);
        const activationReady = (
            preview.payload.selected_installed_skills.length > 0
            && !isPostDiffSelection
            && currentCycleArtifact !== null
            && currentArtifactViolations.length === 0
            && activationArtifactViolations.length === 0
            && preflightPayload !== null
            && preflightSha256 !== null
        );
        const activationBlocker = activationReady
            ? null
            : isPostDiffSelection
                ? 'Optional skill suggestion was surfaced from post-diff changed paths for self-check only; do not activate it as pre-implementation evidence.'
            : activationArtifactViolations.length > 0
                ? activationArtifactViolations.join(' ')
                : 'Optional skill activation requires a current materialized selection artifact bound to the current preflight.';
        const timelineEvidence = currentCycleArtifact && currentArtifactViolations.length === 0
            ? readOptionalSkillSelectionTimelineEvidence(bundleRoot, taskId)
            : null;
        const activationIndex = currentCycleArtifact && timelineEvidence && !timelineEvidence.invalidJson
            ? isMandatoryPolicy
                ? buildMandatoryCurrentCycleOptionalSkillActivationIndex(currentCycleArtifact.payload, timelineEvidence)
                : buildCurrentCycleOptionalSkillActivationIndex(currentCycleArtifact.payload, timelineEvidence)
            : new Map<string, number>();
        const declineIndex = currentCycleArtifact && timelineEvidence && !timelineEvidence.invalidJson
            ? buildCurrentCycleOptionalSkillDeclineIndex(currentCycleArtifact.payload, timelineEvidence)
            : new Map<string, number>();
        const declinedSkillIds = isMandatoryPolicy
            ? []
            : selectedSkillIds.filter((skillId) => declineIndex.has(skillId));
        const missingActivationSkillIds = selectedSkillIds.filter((skillId) => !activationIndex.has(skillId));
        const mandatorySelectionBlocker = isMandatoryPolicy && !isPostDiffSelection && preview.payload.decision !== 'selected_installed_skills'
            ? preview.payload.decision === 'recommended_missing_packs'
                ? `Mandatory optional skill selection requires an installed specialist skill before implementation. Install a recommended pack (${recommendedPackIds.join(', ')}), create or choose an installed specialist skill, then rerun classify-change and activation.`
                : 'Mandatory optional skill selection requires an installed specialist skill before implementation. Install or create a relevant specialist skill, choose it for this task, then rerun classify-change and activation.'
            : null;
        const mandatoryActivationBlocker = isMandatoryPolicy
            && !isPostDiffSelection
            && currentCycleArtifact !== null
            && currentArtifactViolations.length === 0
            && selectedSkillIds.length > 0
            && missingActivationSkillIds.length > 0
            ? timelineEvidence?.invalidJson === true
                ? 'Mandatory optional skill selection requires readable current task timeline evidence before implementation.'
                : `Mandatory optional skill selection requires current-cycle activation evidence for selected optional skill(s): ${missingActivationSkillIds.join(', ')}.`
            : null;
        let blocker: string | null = null;
        if (mandatorySelectionBlocker) {
            blocker = mandatorySelectionBlocker;
        } else if (requiresMaterializedArtifact && currentCycleArtifact === null) {
            blocker = 'Optional skill selection policy requires a materialized current-cycle selection artifact. Re-run classify-change for this task cycle before implementation.';
        } else if (requiresMaterializedArtifact && currentArtifactViolations.length > 0) {
            blocker = currentArtifactViolations.join(' ');
        } else if (mandatoryActivationBlocker) {
            blocker = mandatoryActivationBlocker;
        } else if (activationArtifactViolations.length > 0) {
            blocker = activationArtifactViolations.join(' ');
        } else if (previewViolations.length > 0) {
            blocker = previewViolations.join(' ');
        }
        const actionableActivationSkillIds = isMandatoryPolicy
            ? selectedSkillIds
            : missingActivationSkillIds.filter((skillId) => !declineIndex.has(skillId));
        const activationCommands = activationReady
            ? preview.payload.selected_installed_skills
                .filter((entry) => actionableActivationSkillIds.includes(entry.id))
                .map((entry) => (
                buildOptionalSkillActivationCommand(repoRoot, taskId, entry.id)
            ))
            : [];
        const declineCommands = activationReady && !isMandatoryPolicy
            ? preview.payload.selected_installed_skills
                .filter((entry) => !activationIndex.has(entry.id) && !declineIndex.has(entry.id))
                .map((entry) => buildOptionalSkillDeclineCommand(repoRoot, taskId, entry.id))
            : [];
        const skillCatalogPath = preview.payload.headlines_path
            ? preview.payload.headlines_path.replace(/\\/g, '/')
            : toPortableRepoPath(targetRoot, path.join(bundleRoot, 'live', 'config', 'skills-headlines.json'));
        const taskStartInstruction = requiresMaterializedArtifact && currentArtifactViolations.length > 0
            ? `Optional skill selection artifact is invalid for current task-start guidance: ${currentArtifactViolations.join(' ')} Rerun classify-change for the current task cycle before activation or review continuation.`
            : buildOptionalSkillTaskStartInstruction({
                policyMode,
                decision: preview.payload.decision,
                selectedSkillIds,
                recommendedMissingPackIds: recommendedPackIds,
                asIsReason: preview.payload.as_is_reason,
                artifactPath: portableArtifactPath,
                headlinesPath: skillCatalogPath,
                selectionPhase,
                pathEvidenceSource,
                activationReady,
                activationCommands,
                declinedSkillIds,
                declineCommands
            });
        return {
            artifact_path: portableArtifactPath,
            artifact_present: currentCycleArtifact !== null,
            current_policy_mode: policyConfig.mode,
            policy_mode: policyMode,
            decision: preview.payload.decision,
            selected_installed_skills: selectedSkillIds,
            selected_installed_skill_paths: selectedSkillPaths,
            selected_installed_skill_sources: selectedSkillSources,
            selected_installed_skill_details: selectedSkillDetails,
            selected_installed_skill_activation_ready: activationReady,
            selected_installed_skill_activation_blocker: activationBlocker,
            selected_installed_skill_activation_commands: activationCommands,
            selected_installed_skill_declined_ids: declinedSkillIds,
            selected_installed_skill_decline_commands: declineCommands,
            selected_installed_skill_post_diff_self_check: postDiffSelfCheck,
            skill_catalog_path: skillCatalogPath,
            task_start_instruction: taskStartInstruction,
            selection_phase: selectionPhase,
            path_evidence_source: pathEvidenceSource,
            recommended_missing_packs: recommendedPackIds,
            as_is_reason: preview.payload.as_is_reason,
            visible_summary_line: preview.payload.visible_summary_line,
            blocker
        };
    } catch (error: unknown) {
        return {
            artifact_path: portableArtifactPath,
            artifact_present: false,
            current_policy_mode: readOptionalSkillPolicyModeSafe(bundleRoot),
            blocker: `Optional skill selection preview is unavailable: ${error instanceof Error ? error.message : String(error)}`
        };
    }
}

export function getRequiredReviewTypes(preflightPayload: Record<string, unknown> | null): string[] {
    const requiredReviews = preflightPayload?.required_reviews;
    if (!requiredReviews || typeof requiredReviews !== 'object' || Array.isArray(requiredReviews)) {
        return [];
    }
    return Object.entries(requiredReviews)
        .filter(([, value]) => value === true)
        .map(([reviewType]) => reviewType)
        .sort();
}

export function buildTaskBrief(targetRoot: string, taskId: string, initAnswersPath?: string): Record<string, unknown> {
    assertCanonicalTaskId(taskId);
    const bundleRoot = resolveBundleRootForTarget(targetRoot);
    resolveBriefPath(targetRoot, path.join(bundleRoot, 'runtime', 'reviews'));
    resolveBriefPath(targetRoot, path.join(bundleRoot, 'runtime', 'task-events', `${taskId}.jsonl`));
    const continuation = buildTaskContinuation(targetRoot, taskId);
    const taskPath = resolveBriefPath(targetRoot, path.join(targetRoot, TASK_QUEUE_FILENAME));
    const taskRow = normalizeTaskRow(taskPath, taskId);
    if (!taskRow) {
        throw new Error(`Task '${taskId}' was not found in TASK.md.`);
    }

    const statusSnapshot = getStatusSnapshot(targetRoot, initAnswersPath);
    const workspaceSnapshot = (() => {
        try {
            return summarizeWorkspaceSnapshot(getWorkspaceSnapshot(targetRoot, 'git_auto', true, []));
        } catch {
            return summarizeWorkspaceSnapshot({
                detection_source: 'git_auto',
                use_staged: false,
                include_untracked: true,
                changed_files: [],
                changed_files_count: 0,
                additions_total: 0,
                deletions_total: 0,
                changed_lines_total: 0,
                changed_files_sha256: null,
                scope_sha256: null
            });
        }
    })();
    const stagedWorkspaceSnapshot = (() => {
        try {
            return summarizeWorkspaceSnapshot(getWorkspaceSnapshot(targetRoot, 'git_staged_plus_untracked', true, []));
        } catch {
            return summarizeWorkspaceSnapshot({
                detection_source: 'git_staged_plus_untracked',
                use_staged: true,
                include_untracked: true,
                changed_files: [],
                changed_files_count: 0,
                additions_total: 0,
                deletions_total: 0,
                changed_lines_total: 0,
                changed_files_sha256: null,
                scope_sha256: null
            });
        }
    })();
    const whyBlocked = getWhyBlocked(targetRoot);
    const taskArtifacts = listTaskArtifacts(targetRoot, taskId);
    const eventTypes = readTaskTimelineEvents(targetRoot, taskId);
    const taskModePath = path.join(bundleRoot, 'runtime', 'reviews', `${taskId}-task-mode.json`);
    const preflightPath = path.join(bundleRoot, 'runtime', 'reviews', `${taskId}-preflight.json`);
    const taskModeArtifact = readJsonArtifactIfExists<Record<string, unknown>>(taskModePath, { repoRoot: targetRoot, taskId });
    const preflightArtifact = readJsonArtifactIfExists<Record<string, unknown>>(preflightPath, { includeSha: true, repoRoot: targetRoot, taskId });
    const taskModePayload = taskModeArtifact?.payload || null;
    const preflightPayload = preflightArtifact?.payload || null;
    const optionalSkillsDiagnostics = buildOptionalSkillsDiagnostics(
        targetRoot,
        targetRoot,
        bundleRoot,
        taskId,
        String(taskRow.title || taskModePayload?.task_summary || ''),
        preflightPath,
        preflightPayload,
        preflightArtifact?.sha256 || null,
        taskModePayload
    );
    const requiredReviewTypes = getRequiredReviewTypes(preflightPayload);
    const existingChangedFiles = Array.isArray(preflightPayload?.changed_files)
        ? preflightPayload?.changed_files.map((entry) => String(entry)).filter(Boolean)
        : readPlannedChangedFiles(taskModePayload);
    const projectMemory = buildProjectMemoryBrief(targetRoot, bundleRoot, taskRow, existingChangedFiles);
    const contextSelection = buildTaskContextSelection({
        continuation,
        canonicalEntrypoint: statusSnapshot.canonicalEntrypoint,
        bundlePath: toPortableRepoPath(targetRoot, bundleRoot),
        optionalSkillPaths: Array.isArray(optionalSkillsDiagnostics?.selected_installed_skill_paths)
            && !optionalSkillsDiagnostics?.blocker
            ? optionalSkillsDiagnostics.selected_installed_skill_paths.map(String)
            : [],
        projectMemoryReadFirst: projectMemory.read_first
    });
    const boundedPreflightChangedFiles = boundList(existingChangedFiles, MAX_PREPROMPT_CHANGED_FILES);
    const startupScopeBlocker = buildStartupScopeBlocker(
        existingChangedFiles,
        Number(workspaceSnapshot.changed_files_count || 0),
        Number(stagedWorkspaceSnapshot.changed_files_count || 0)
    );
    const startupPending = continuation.next_gate === 'enter-task-mode';
    const startupCommands = startupPending && continuation.action?.command
        ? [continuation.action.command]
        : [];
    const currentTaskBlockers = [
        ...whyBlocked.blocked_tasks,
        ...whyBlocked.in_progress_tasks
    ].filter((entry) => entry.task.id === taskId);

    return {
        schema_version: 3,
        command: 'preprompt task',
        rule_search_required: false,
        project_memory: projectMemory,
        continuation,
        context_selection: contextSelection,
        task: {
            ...taskRow,
            timeline_event_count: eventTypes.length,
            current_stage: continuation.next_gate || continuation.status.toLowerCase()
        },
        workspace: {
            target_root: targetRoot.replace(/\\/g, '/'),
            bundle_root: bundleRoot.replace(/\\/g, '/'),
            status_compact: formatStatusSnapshotCompact(statusSnapshot),
            ready_for_tasks: statusSnapshot.readyForTasks,
            active_profile: statusSnapshot.activeProfile,
            current_dirty_workspace: workspaceSnapshot
        },
        artifacts: {
            ...taskArtifacts,
            has_task_mode: taskModePayload !== null,
            has_preflight: preflightPayload !== null,
            task_mode_path: buildTargetBundleRelativePath(targetRoot, `runtime/reviews/${taskId}-task-mode.json`),
            preflight_path: buildTargetBundleRelativePath(targetRoot, `runtime/reviews/${taskId}-preflight.json`)
        },
        diagnostics: {
            artifact_presence_is_advisory: true,
            why_blocked: currentTaskBlockers,
            required_review_types: requiredReviewTypes,
            latest_preflight: preflightPayload ? {
                mode: preflightPayload.mode || null,
                detection_source: preflightPayload.detection_source || null,
                changed_files: boundedPreflightChangedFiles.items,
                changed_files_total_count: boundedPreflightChangedFiles.total_count,
                changed_files_truncated: boundedPreflightChangedFiles.truncated,
                changed_files_omitted_count: boundedPreflightChangedFiles.omitted_count,
                required_reviews: preflightPayload.required_reviews || {}
            } : null,
            task_mode: taskModePayload ? {
                provider: taskModePayload.provider || null,
                effective_depth: taskModePayload.effective_depth || null,
                orchestrator_work: taskModePayload.orchestrator_work === true,
                dirty_workspace_baseline: taskModePayload.dirty_workspace_baseline || null
            } : null,
            ...(optionalSkillsDiagnostics ? { optional_skills: optionalSkillsDiagnostics } : {})
        },
        commands: {
            startup_pending: startupPending,
            startup_scope_blocker: startupPending ? startupScopeBlocker : null,
            startup_commands: startupCommands,
            post_implementation_sequence_available: false,
            post_implementation_sequence_blocker: 'Schema 3 replaces command batches with continuation.action; rerun continuation.navigator_command before acting.',
            post_implementation_commands: []
        }
    };
}
