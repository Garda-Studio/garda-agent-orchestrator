import * as fs from 'node:fs';
import * as path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parseCommandChain } from '../../../core/command-line';
import { joinOrchestratorPath, normalizePath } from '../../../core/orchestrator-paths';
import { parseCanonicalActiveTaskQueue } from '../../../core/task-md-table';
import { isTaskQueueActiveStatus, resolveActiveTaskIds } from '../../../core/task-queue/active-task-state';
import { assertValidTaskId, inspectTaskEventFile, readTaskTimelineJsonlEntries, withTaskTimelineReadSnapshot } from '../../../gate-runtime/task-events';
import { stringSha256 } from '../../../gate-runtime/hash';
import { getTaskModeEvidence } from '../../../gates/task-mode/task-mode';
import { getSafeWorktreePathState } from '../../../gates/workspace/worktree-path-state';
import { computeSnapshotFingerprint } from '../../../gates/workspace/workspace-snapshot-cache';
import { findOtherActiveImplementationOwners, findUnapprovedActiveImplementationOwners } from '../../../gates/workspace/active-implementation-ownership';
import { inspectReviewerFocusedValidationCommand } from '../../../gates/review/review-findings-schema';
import { getClassificationConfig } from '../../../gates/preflight/classify-change-config';
import { matchAnyRegex } from '../../../gate-runtime/text-utils';
import { validateFullSuiteCommandContract } from '../gate-flows/full-suite/full-suite-command-contract';
import type { ParsedOptionsRecord, WorkflowCommandRoots, WorkflowFileConfigData } from './workflow-command-types';

export interface TaskTestSelectionAuthority {
    schema_version: 1;
    origin: 'task_scoped_test_selection';
    decision_utc: string;
    task_id: string;
    workspace_root: string;
    workspace_fingerprint: string;
    head_sha: string;
    task_mode_entry_sha256: string;
    task_mode_artifact_sha256: string;
    require_operator_confirmation: boolean;
    reason: string;
    targets: Array<{ path: string; sha256: string }>;
}

function fail(reason: string): never {
    throw new Error(`Task-scoped test selection rejected: ${reason}`);
}

function canonicalTarget(value: string): string {
    const normalized = normalizePath(value);
    if (!normalized || path.posix.isAbsolute(normalized) || path.win32.isAbsolute(normalized)
        || normalized.split('/').some(part => part === '..' || part === '.')
        || /[\u0000-\u001f*?\[\]{}]/u.test(normalized)) {
        fail('test targets must be explicit repository-relative files without traversal or globs.');
    }
    return normalized;
}

function readTarget(root: string, target: string): { path: string; sha256: string } {
    const absolute = path.join(root, target);
    const state = getSafeWorktreePathState(root, target, { distinguishAccessErrors: true });
    if (state.status !== 'file' || !state.sha256 || fs.lstatSync(absolute).nlink !== 1
        || path.relative(root, fs.realpathSync.native(absolute)) !== path.normalize(target)) {
        fail(`test target '${target}' must be an ordinary contained file without links.`);
    }
    return { path: target, sha256: state.sha256 };
}

function readCurrentTask(roots: WorkflowCommandRoots, taskId: string): {
    entryHash: string; artifactHash: string; plannedFiles: string[];
} {
    const queue = parseCanonicalActiveTaskQueue(fs.readFileSync(path.join(roots.targetRoot, 'TASK.md'), 'utf8'));
    const rows = queue.rows.filter(row => row.taskId === taskId);
    const activeIds = resolveActiveTaskIds(roots.targetRoot, roots.bundleRoot, [], {
        includeAmbiguousRuntimeTasks: false, includeStaleRuntimeActiveTasks: false
    });
    const owners = findOtherActiveImplementationOwners(roots.targetRoot, taskId);
    if (!queue.found || rows.length !== 1 || !isTaskQueueActiveStatus(rows[0].status)
        || !activeIds.has(taskId) || activeIds.size !== owners.length + 1
        || owners.some(owner => !activeIds.has(owner))) {
        fail('one current active task must match the canonical task queue and native runtime.');
    }
    if (findUnapprovedActiveImplementationOwners(roots.targetRoot, taskId).length) {
        fail('other active implementation owners require current task-specific approval and disjoint scopes.');
    }
    const eventsRoot = path.join(roots.bundleRoot, 'runtime/task-events');
    const timeline = path.join(eventsRoot, `${taskId}.jsonl`);
    return withTaskTimelineReadSnapshot(eventsRoot, taskId, () => {
        if (inspectTaskEventFile(timeline, taskId).status !== 'PASS') fail('current native task timeline is missing or invalid.');
        const entries = readTaskTimelineJsonlEntries(timeline);
        const entry = [...entries].reverse().find(item => item.record?.event_type === 'TASK_MODE_ENTERED');
        const evidence = getTaskModeEvidence(roots.targetRoot, taskId);
        if (entry?.record?.outcome !== 'PASS' || evidence.evidence_status !== 'PASS'
            || evidence.identity_backfilled_from_legacy || !evidence.evidence_hash
            || !evidence.evidence_path || !evidence.planned_changed_files.length) {
            fail('current resolved task-mode evidence and a declared task scope are required.');
        }
        const artifactPath = path.join(roots.bundleRoot, 'runtime/reviews', `${taskId}-task-mode.json`);
        if (fs.realpathSync.native(evidence.evidence_path) !== fs.realpathSync.native(artifactPath)) {
            fail('task-mode evidence must belong to this worktree.');
        }
        const entryHash = stringSha256(entry.rawLine.trim());
        if (!entryHash) fail('current task entry hash is unavailable.');
        return { entryHash, artifactHash: evidence.evidence_hash,
            plannedFiles: evidence.planned_changed_files };
    });
}

function validateTargets(command: string, targets: string[], root: string): void {
    const direct = validateFullSuiteCommandContract(command);
    if (!direct.supported) fail(direct.violation || 'unsupported direct argv command.');
    const tokens = parseCommandChain(command)[0];
    for (const target of targets) {
        // The existing focused validator admits exactly one target. Validate each
        // member against the same argv, removing only the other declared targets.
        const singleTargetCommand = tokens.filter(token => {
            const normalized = normalizePath(token);
            return normalized === target || !targets.includes(normalized);
        }).map(token => JSON.stringify(token)).join(' ');
        const inspected = inspectReviewerFocusedValidationCommand(singleTargetCommand, root);
        if (!inspected.syntax_supported || inspected.target !== target) {
            fail(`command must execute the declared test target '${target}' through a supported native validation runner. ${inspected.violations.join(' ')}`);
        }
    }
}

function validateRelevance(taskId: string, reason: string, targets: string[], plannedFiles: string[]): void {
    if (reason.length < 20 || !reason.includes(taskId)
        || !/\b(?:asserts|covers|exercises|guards|validates|verifies)\b/iu.test(reason)) {
        fail('--reason must explain which current task behavior the selected tests cover.');
    }
    for (const target of targets) {
        if (plannedFiles.includes(target)) continue;
        const justified = reason.split(/[;\n]/u).some(clause => clause.includes(target)
            && plannedFiles.some(file => clause.includes(file))
            && /\b(?:asserts|covers|exercises|guards|validates|verifies)\b/iu.test(clause));
        if (!justified) fail(`unchanged regression target '${target}' needs an explicit relationship to a declared task file in --reason.`);
    }
}

export function resolveTaskTestSelectionAuthority(
    options: ParsedOptionsRecord, roots: WorkflowCommandRoots,
    current: WorkflowFileConfigData, next: WorkflowFileConfigData, requestedFields: readonly string[]
): TaskTestSelectionAuthority | null {
    const selectionRequested = ['taskId', 'taskTestSelectionReason', 'focusedRequiredTestPath']
        .some(key => options[key] !== undefined);
    if (!selectionRequested) return null;
    if (typeof options.taskId !== 'string' || typeof options.taskTestSelectionReason !== 'string'
        || !Array.isArray(options.focusedRequiredTestPath) || !options.focusedRequiredTestPath.length) {
        fail('--task-id, --reason and repeated --focused-required-test-path are required together.');
    }
    if (requestedFields.length !== 1 || requestedFields[0] !== 'full_suite_validation.command'
        || options.mutationSource && options.mutationSource !== 'cli') {
        fail('only full_suite_validation.command may be requested through the CLI selector, including no-op setting requests.');
    }
    const root = fs.realpathSync.native(roots.targetRoot);
    if (root !== fs.realpathSync.native(process.cwd())
        || fs.realpathSync.native(roots.bundleRoot) !== fs.realpathSync.native(joinOrchestratorPath(root, ''))) {
        fail('target and bundle roots must be the current canonical worktree.');
    }
    if (current.full_suite_validation.enabled !== true || next.full_suite_validation.enabled !== true) {
        fail('the enabled test gate must be preserved.');
    }
    const taskId = assertValidTaskId(options.taskId);
    const bound = readCurrentTask(roots, taskId);
    const targets = options.focusedRequiredTestPath.map(canonicalTarget);
    if (new Set(targets).size !== targets.length) fail('duplicate test targets are not allowed.');
    const classification = getClassificationConfig(root);
    if (targets.some(target => !matchAnyRegex(target, classification.test_trigger_regexes, { caseInsensitive: true }))) {
        fail('every selected target must be classified as a repository test.');
    }
    const reason = options.taskTestSelectionReason.trim();
    validateRelevance(taskId, reason, targets, bound.plannedFiles);
    validateTargets(next.full_suite_validation.command, targets, root);
    const workspace = computeSnapshotFingerprint(root, 'git_auto', true, []);
    if (!workspace.headSha) fail('a real Git worktree is required.');
    return { schema_version: 1, origin: 'task_scoped_test_selection', decision_utc: new Date().toISOString(),
        task_id: taskId, workspace_root: root, workspace_fingerprint: workspace.fingerprint, head_sha: workspace.headSha,
        task_mode_entry_sha256: bound.entryHash, task_mode_artifact_sha256: bound.artifactHash,
        require_operator_confirmation: current.task_test_selection?.require_operator_confirmation === true,
        reason, targets: targets.map(target => readTarget(root, target)) };
}

export function assertTaskTestSelectionCurrent(roots: WorkflowCommandRoots, authority: TaskTestSelectionAuthority): void {
    const current = readCurrentTask(roots, authority.task_id);
    const workspace = computeSnapshotFingerprint(roots.targetRoot, 'git_auto', true, []);
    if (current.entryHash !== authority.task_mode_entry_sha256 || current.artifactHash !== authority.task_mode_artifact_sha256
        || workspace.fingerprint !== authority.workspace_fingerprint || workspace.headSha !== authority.head_sha
        || !isDeepStrictEqual(authority.targets.map(target => readTarget(roots.targetRoot, target.path)), authority.targets)) {
        fail('task cycle, worktree or test target content changed before publication.');
    }
}
