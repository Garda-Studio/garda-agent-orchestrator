import * as path from 'node:path';
import { isCanonicalTaskId, parseStructuredTaskArtifactTaskId } from '../../core/task-ids';

const PROTECTED_GENERIC_SCRATCH_NAMES = new Set([
    'reviews', 'wip', 'scratch-writers', '.scratch-writers.lock', 'owner.json',
    'project-memory', 'task-events', 'task-ledger', 'manual-validation', 'plans', 'compact',
    'reviews-index.json', 'all-tasks.jsonl', 'metrics.jsonl', '.timeline-summary.json'
]);

export function resolveRuntimeTmpTaskId(name: string): string | null {
    return isCanonicalTaskId(name) ? name : parseStructuredTaskArtifactTaskId(name);
}

export function isProtectedGenericScratchName(name: string): boolean {
    return PROTECTED_GENERIC_SCRATCH_NAMES.has(name.toLowerCase())
        || /^t-/iu.test(name) || resolveRuntimeTmpTaskId(name) !== null;
}

export function isTaskOwnedRuntimeTmpPath(runtimeDir: string, candidate: string): boolean {
    const relative = path.relative(path.resolve(runtimeDir), path.resolve(candidate));
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return false;
    const parts = relative.split(path.sep), component = (name: string) => process.platform === 'win32' ? name.toLowerCase() : name;
    if (parts.length === 1) return /\.(?:tmp|partial)$/u.test(parts[0]) && resolveRuntimeTmpTaskId(parts[0]) !== null;
    if (component(parts[0]) !== 'tmp') return false;
    if (parts.length === 2) return resolveRuntimeTmpTaskId(parts[1]) !== null;
    return parts.length === 3 && component(parts[1]) === 'reviews' && resolveRuntimeTmpTaskId(parts[2]) !== null;
}

export type RuntimeCleanupArtifactOwnership =
    | 'task-scoped'
    | 'shared-aggregate'
    | 'shared-derived'
    | 'shared-generated'
    | 'mixed';

export type RuntimeCleanupSelectionUnit =
    | 'task-subtree'
    | 'task-file'
    | 'task-pattern'
    | 'shared-file'
    | 'shared-directory'
    | 'mixed-directory';

export type RuntimeCleanupTaskPurgeMode =
    | 'delete-owned-artifacts'
    | 'delete-owned-artifacts-and-rebuild-shared-state'
    | 'prune-or-rebuild-shared-state-only'
    | 'exclude-from-task-purge';

export type RuntimeCleanupSharedSideEffectAction =
    | 'invalidate-reviews-index'
    | 'prune-timeline-summary'
    | 'prune-all-tasks-aggregate';

export type RuntimeCleanupCollectorKey =
    | 'manual-validation-task-root'
    | 'compact-task-root'
    | 'reviews-task-artifacts'
    | 'task-events-task-artifacts'
    | 'plans-task-markdown'
    | 'project-memory-task-artifacts'
    | 'task-ledger-files'
    | 'tmp-task-artifacts';

export type RuntimeCleanupRetentionMode =
    | 'task-age-or-count'
    | 'task-age-or-count-with-shared-rebuild'
    | 'line-pruning'
    | 'general-generated-zone-cleanup'
    | 'operator-managed';

export interface RuntimeCleanupOwnershipEntry {
    id: string;
    location: string;
    ownership: RuntimeCleanupArtifactOwnership;
    selectionUnit: RuntimeCleanupSelectionUnit;
    candidateCategory?: TaskScopedRuntimeCandidateCategory;
    collectorKey?: RuntimeCleanupCollectorKey;
    taskLocator: string;
    taskPurgeMode: RuntimeCleanupTaskPurgeMode;
    retentionMode: RuntimeCleanupRetentionMode;
    sharedSideEffects: readonly string[];
    sharedSideEffectActions?: readonly RuntimeCleanupSharedSideEffectAction[];
    notes: readonly string[];
    examples: readonly string[];
}

export interface RuntimeCleanupCollectorContract {
    key: RuntimeCleanupCollectorKey;
    ownershipEntryIds: readonly string[];
    candidateCategory: TaskScopedRuntimeCandidateCategory;
    taskPurgeMode: RuntimeCleanupTaskPurgeMode;
    sharedSideEffectActions: readonly RuntimeCleanupSharedSideEffectAction[];
}

export const TASK_SCOPED_RUNTIME_CANDIDATE_CATEGORIES = Object.freeze([
    'manual-validation',
    'compact',
    'reviews',
    'task-events',
    'plans',
    'project-memory',
    'task-ledger',
    'tmp'
] as const);

export type TaskScopedRuntimeCandidateCategory = typeof TASK_SCOPED_RUNTIME_CANDIDATE_CATEGORIES[number];

export interface RuntimeCleanupStandardPaths {
    manualValidationDir: string;
    compactDir: string;
    reviewsDir: string;
    taskEventsDir: string;
    plansDir: string;
    projectMemoryDir: string;
    taskLedgerDir: string;
    backupsDir: string;
    bundleBackupsDir: string;
    updateReportsDir: string;
    updateRollbacksDir: string;
    testScratchDir: string;
    cacheDir: string;
    reportsDir: string;
    updateTempDir: string;
    tmpDir: string;
    isolationSandboxDir: string;
}

export const RUNTIME_CLEANUP_OWNERSHIP_ENTRIES = Object.freeze([
    {
        id: 'wip-task-packages',
        location: 'runtime/wip/<task-id>/**',
        ownership: 'mixed',
        selectionUnit: 'task-subtree',
        taskLocator: 'Exact canonical task directory and authenticated package manifest identity.',
        taskPurgeMode: 'exclude-from-task-purge',
        retentionMode: 'operator-managed',
        sharedSideEffects: [],
        notes: [
            'Only explicitly confirmed retired orphan packages may be removed through the separate WIP backend.',
            'Suspended work, unfinished cross-task references, pending restore handoffs and ambiguous ownership are preserved.',
            'WIP is excluded from automatic GC, retention and ordinary task-purge candidate walkers.'
        ],
        examples: ['runtime/wip/<task-id>/split-required/<timestamp>/manifest.json']
    },
    {
        id: 'manual-validation-task-root',
        location: 'runtime/manual-validation/<task-id>/',
        ownership: 'task-scoped',
        selectionUnit: 'task-subtree',
        candidateCategory: 'manual-validation',
        collectorKey: 'manual-validation-task-root',
        taskLocator: 'Canonical task-id directory name owns the full subtree.',
        taskPurgeMode: 'delete-owned-artifacts',
        retentionMode: 'task-age-or-count',
        sharedSideEffects: [],
        notes: [
            'Manual validation attachments are task-owned runtime evidence and are intentionally ignored by preflight changed-file scope.',
            'Selectors such as review-evidence.json and full-suite-retry-evidence.json live under the task root and should be purged with the task.'
        ],
        examples: [
            'runtime/manual-validation/<task-id>/review-evidence.json',
            'runtime/manual-validation/<task-id>/full-suite-retry-evidence.json'
        ]
    },
    {
        id: 'compact-task-root',
        location: 'runtime/compact/<task-id>/',
        ownership: 'task-scoped',
        selectionUnit: 'task-subtree',
        candidateCategory: 'compact',
        collectorKey: 'compact-task-root',
        taskLocator: 'Canonical task-id directory name owns retained command output.',
        taskPurgeMode: 'delete-owned-artifacts',
        retentionMode: 'task-age-or-count',
        sharedSideEffects: [],
        notes: [
            'Remove the selected task subtree without retaining a compact tombstone.',
            'Confirmed removal must acquire runtime/compact.lock so cooperating readers and writers cannot overlap deletion.',
            'The shared compact lock and unrelated task output are not task-owned deletion candidates.'
        ],
        examples: ['runtime/compact/<task-id>/<capture-ref>/manifest.json']
    },
    {
        id: 'plans-task-markdown',
        location: 'runtime/plans/<task-id>.md',
        ownership: 'task-scoped',
        selectionUnit: 'task-file',
        candidateCategory: 'plans',
        collectorKey: 'plans-task-markdown',
        taskLocator: 'Canonical task-id markdown file name.',
        taskPurgeMode: 'delete-owned-artifacts',
        retentionMode: 'task-age-or-count',
        sharedSideEffects: [],
        notes: [
            'Runtime plans are optional executor guidance only and are safe to delete with the owning task.',
            'Plan retention should follow the same task age/count policy as other task-owned runtime artifacts.'
        ],
        examples: [
            'runtime/plans/<task-id>.md'
        ]
    },
    {
        id: 'project-memory-task-artifacts',
        location: 'runtime/project-memory/<task-id>-impact.json and <task-id>-update.json',
        ownership: 'task-scoped',
        selectionUnit: 'task-pattern',
        candidateCategory: 'project-memory',
        collectorKey: 'project-memory-task-artifacts',
        taskLocator: 'Canonical task-id file prefix with -impact.json or -update.json suffix.',
        taskPurgeMode: 'delete-owned-artifacts',
        retentionMode: 'task-age-or-count',
        sharedSideEffects: [],
        notes: [
            'These are runtime gate artifacts for project-memory-impact, not the user-owned live/docs/project-memory source files.',
            'Task purge should delete only task-keyed impact/update artifacts and leave shared bootstrap diagnostics alone.'
        ],
        examples: [
            'runtime/project-memory/<task-id>-impact.json',
            'runtime/project-memory/<task-id>-update.json'
        ]
    },
    {
        id: 'project-memory-bootstrap-report',
        location: 'runtime/project-memory/bootstrap-report.json',
        ownership: 'shared-derived',
        selectionUnit: 'shared-file',
        taskLocator: 'Not task keyed; bootstrap diagnostics are shared runtime state.',
        taskPurgeMode: 'exclude-from-task-purge',
        retentionMode: 'operator-managed',
        sharedSideEffects: [],
        notes: [
            'Bootstrap diagnostics describe seeded project-memory files for the workspace as a whole.',
            'Task purge must not delete this shared report just because one task updated project-memory impact evidence.'
        ],
        examples: [
            'runtime/project-memory/bootstrap-report.json'
        ]
    },
    {
        id: 'reviews-task-artifacts',
        location: 'runtime/reviews/<task-owned artifacts>',
        ownership: 'task-scoped',
        selectionUnit: 'task-pattern',
        candidateCategory: 'reviews',
        collectorKey: 'reviews-task-artifacts',
        taskLocator: 'Canonical task-id resolved from review artifact file name or embedded task_id payload.',
        taskPurgeMode: 'delete-owned-artifacts-and-rebuild-shared-state',
        retentionMode: 'task-age-or-count-with-shared-rebuild',
        sharedSideEffects: [
            'Invalidate or rebuild runtime/reviews/reviews-index.json after task-owned review artifacts are removed.'
        ],
        sharedSideEffectActions: ['invalidate-reviews-index'],
        notes: [
            'This area stores preflight, compile, review, doc-impact, full-suite, completion, audit, and final user report artifacts.',
            'Authenticated remediation cycle, decision, delta, validation, baseline, and hash-suffixed snapshot artifacts are task-owned review evidence.',
            'Task purge removes only artifacts owned by the selected task id; shared review indexes are rebuilt separately.'
        ],
        examples: [
            'runtime/reviews/<task-id>-preflight.json',
            'runtime/reviews/<task-id>-review-remediation-cycle.json',
            'runtime/reviews/<task-id>-<review-type>-remediation-baseline.json',
            'runtime/reviews/<task-id>-final-closeout.json'
        ]
    },
    {
        id: 'reviews-index',
        location: 'runtime/reviews/reviews-index.json',
        ownership: 'shared-derived',
        selectionUnit: 'shared-file',
        taskLocator: 'Derived shared index over remaining review artifacts.',
        taskPurgeMode: 'prune-or-rebuild-shared-state-only',
        retentionMode: 'operator-managed',
        sharedSideEffects: [
            'Rebuild from remaining runtime/reviews artifacts after task purge or retention cleanup.'
        ],
        notes: [
            'This index is not task-scoped evidence.',
            'Cleanup should invalidate or rebuild it instead of deleting it as if it belonged to one task.'
        ],
        examples: [
            'runtime/reviews/reviews-index.json'
        ]
    },
    {
        id: 'task-events-timelines',
        location: 'runtime/task-events/<task-id>.jsonl',
        ownership: 'task-scoped',
        selectionUnit: 'task-file',
        candidateCategory: 'task-events',
        collectorKey: 'task-events-task-artifacts',
        taskLocator: 'Canonical task-id JSONL file name.',
        taskPurgeMode: 'delete-owned-artifacts-and-rebuild-shared-state',
        retentionMode: 'task-age-or-count-with-shared-rebuild',
        sharedSideEffects: [
            'Remove the task entry from runtime/task-events/.timeline-summary.json or rebuild the summary.',
            'Rewrite or rebuild runtime/task-events/all-tasks.jsonl so removed tasks are no longer referenced.'
        ],
        sharedSideEffectActions: ['prune-all-tasks-aggregate', 'prune-timeline-summary'],
        notes: [
            'Per-task JSONL timelines are the canonical lifecycle evidence for one task.',
            'Task purge may delete them, but shared aggregates built from them must be repaired instead of deleted wholesale.'
        ],
        examples: [
            'runtime/task-events/<task-id>.jsonl'
        ]
    },
    {
        id: 'task-events-completeness-cache',
        location: 'runtime/task-events/<task-id>.completeness.json',
        ownership: 'task-scoped',
        selectionUnit: 'task-file',
        candidateCategory: 'task-events',
        collectorKey: 'task-events-task-artifacts',
        taskLocator: 'Canonical task-id completeness cache companion file.',
        taskPurgeMode: 'delete-owned-artifacts-and-rebuild-shared-state',
        retentionMode: 'task-age-or-count-with-shared-rebuild',
        sharedSideEffects: [
            'Keep timeline summary coherent with the remaining per-task timelines.'
        ],
        sharedSideEffectActions: ['prune-all-tasks-aggregate', 'prune-timeline-summary'],
        notes: [
            'Completeness cache files are derived companions for one task timeline and should be removed with that task.',
            'They should never outlive the owning per-task JSONL file after purge.'
        ],
        examples: [
            'runtime/task-events/<task-id>.completeness.json'
        ]
    },
    {
        id: 'task-events-all-tasks-aggregate',
        location: 'runtime/task-events/all-tasks.jsonl',
        ownership: 'shared-aggregate',
        selectionUnit: 'shared-file',
        taskLocator: 'Aggregate stream over many task timelines; not owned by one task.',
        taskPurgeMode: 'prune-or-rebuild-shared-state-only',
        retentionMode: 'line-pruning',
        sharedSideEffects: [
            'Selective rewrite or bounded pruning after task deletion.',
            'Never delete the aggregate outright as part of one task purge.'
        ],
        notes: [
            'This file is a shared aggregate index, not canonical single-task evidence.',
            'Task purge should remove or rebuild only the affected task records while preserving the aggregate file itself.'
        ],
        examples: [
            'runtime/task-events/all-tasks.jsonl'
        ]
    },
    {
        id: 'task-events-timeline-summary',
        location: 'runtime/task-events/.timeline-summary.json',
        ownership: 'shared-derived',
        selectionUnit: 'shared-file',
        taskLocator: 'Derived summary keyed by remaining task timelines.',
        taskPurgeMode: 'prune-or-rebuild-shared-state-only',
        retentionMode: 'operator-managed',
        sharedSideEffects: [
            'Prune the removed task entry or rebuild the summary from remaining timelines.'
        ],
        notes: [
            'Timeline summary is a rebuildable shared index.',
            'Task purge should update it after deleting per-task timelines instead of treating it as task-scoped evidence.'
        ],
        examples: [
            'runtime/task-events/.timeline-summary.json'
        ]
    },
    {
        id: 'task-ledger-files',
        location: 'runtime/task-ledger/<task-id>.json',
        ownership: 'task-scoped',
        selectionUnit: 'task-file',
        candidateCategory: 'task-ledger',
        collectorKey: 'task-ledger-files',
        taskLocator: 'Canonical task-id ledger JSON file name.',
        taskPurgeMode: 'delete-owned-artifacts',
        retentionMode: 'task-age-or-count',
        sharedSideEffects: [],
        notes: [
            'Task ledgers are lightweight terminal evidence derived for one task.',
            'If a task is purged, its ledger should disappear with the rest of the task-owned runtime artifacts.'
        ],
        examples: [
            'runtime/task-ledger/<task-id>.json'
        ]
    },
    {
        id: 'tmp-review-scratch',
        location: 'runtime/tmp/reviews/<task-id>/',
        ownership: 'task-scoped',
        selectionUnit: 'task-subtree',
        candidateCategory: 'tmp',
        collectorKey: 'tmp-task-artifacts',
        taskLocator: 'Canonical task-id directory under runtime/tmp/reviews.',
        taskPurgeMode: 'delete-owned-artifacts',
        retentionMode: 'task-age-or-count',
        sharedSideEffects: [],
        notes: [
            'Delegated reviewer scratch paths are transient task-owned artifacts.',
            'Terminal cleanup may delete them earlier, but task purge should remove any residue deterministically.'
        ],
        examples: [
            'runtime/tmp/reviews/<task-id>/code/review-output.md',
            'runtime/tmp/reviews/<task-id>/security/reviewer-launch.json'
        ]
    },
    {
        id: 'tmp-task-prefixed-root-artifacts',
        location: 'runtime/tmp/<task-id>-prefixed files and directories',
        ownership: 'mixed',
        selectionUnit: 'mixed-directory',
        candidateCategory: 'tmp',
        collectorKey: 'tmp-task-artifacts',
        taskLocator: 'Task ownership is explicit only when the file or directory name embeds a canonical task id.',
        taskPurgeMode: 'delete-owned-artifacts',
        retentionMode: 'task-age-or-count',
        sharedSideEffects: [],
        notes: [
            'Root tmp contains both task-prefixed artifacts and generic scratch not owned by one task.',
            'Ownership-aware purge may delete only entries whose name or nested review scratch path resolves to the selected task id.'
        ],
        examples: [
            'runtime/tmp/<task-id>-full-suite-validation-test.log',
            'runtime/tmp/<task-id>-full-suite-sharded.log'
        ]
    },
    {
        id: 'tmp-generic-shared-scratch',
        location: 'runtime/tmp/** non-task-owned scratch',
        ownership: 'shared-generated',
        selectionUnit: 'mixed-directory',
        taskLocator: 'No canonical task-id ownership can be resolved from the path.',
        taskPurgeMode: 'exclude-from-task-purge',
        retentionMode: 'operator-managed',
        sharedSideEffects: [],
        notes: [
            'Generic scratch requires a separate read-only preview and exact confirmed removal with known-dead local writer ownership.',
            'Examples include profile sandboxes, local UI temp roots, compile caches, and other generated scratch without one owning task id.'
        ],
        examples: [
            'runtime/tmp/gao-profile-0ZNQaC',
            'runtime/tmp/node-compile-cache'
        ]
    },
    {
        id: 'scratch-writer-registration',
        location: 'runtime/scratch-writers/*.json and runtime/.scratch-writers.lock',
        ownership: 'shared-generated',
        selectionUnit: 'shared-directory',
        taskLocator: 'Cooperative writer identity bound to an exact generic tmp root, independent of task ownership.',
        taskPurgeMode: 'exclude-from-task-purge',
        retentionMode: 'operator-managed',
        sharedSideEffects: [],
        notes: ['Writer metadata and the shared writer lock remain outside every deletable scratch subtree and automatic cleanup.'],
        examples: ['runtime/scratch-writers/<root-key>.json', 'runtime/.scratch-writers.lock']
    },
    {
        id: 'metrics-jsonl',
        location: 'runtime/metrics.jsonl',
        ownership: 'shared-aggregate',
        selectionUnit: 'shared-file',
        taskLocator: 'Shared telemetry stream, not partitioned by task ownership.',
        taskPurgeMode: 'prune-or-rebuild-shared-state-only',
        retentionMode: 'line-pruning',
        sharedSideEffects: [
            'Prune in place to the configured max line count.'
        ],
        notes: [
            'Task purge must not delete the whole telemetry file to remove one task.',
            'Shared metrics need bounded pruning, and oversized growth should be addressed as shared-state hygiene.'
        ],
        examples: [
            'runtime/metrics.jsonl'
        ]
    },
    {
        id: 'general-runtime-cleanup-zones',
        location: 'runtime/backups, runtime/bundle-backups, runtime/cache, runtime/reports, runtime/update-temp, runtime/update-rollbacks, runtime/update-reports, runtime/.test-scratch, runtime/.isolation-sandbox, runtime/maintenance/**, stale lock directories',
        ownership: 'shared-generated',
        selectionUnit: 'shared-directory',
        taskLocator: 'Generated workspace/runtime maintenance zones; not owned by one task.',
        taskPurgeMode: 'exclude-from-task-purge',
        retentionMode: 'general-generated-zone-cleanup',
        sharedSideEffects: [],
        notes: [
            'These paths remain under preview-first general cleanup and backup retention, not task-scoped purge.',
            'Maintenance reports and backup snapshots may reflect many tasks or workspace-wide lifecycle operations.'
        ],
        examples: [
            'runtime/backups/20260609-120000-000',
            'runtime/maintenance/daily-retention/2026-06-08.json'
        ]
    }
] as const satisfies readonly RuntimeCleanupOwnershipEntry[]);

export function listRuntimeCleanupOwnershipEntries(): readonly RuntimeCleanupOwnershipEntry[] {
    return RUNTIME_CLEANUP_OWNERSHIP_ENTRIES;
}

export function findRuntimeCleanupOwnershipEntry(id: string): RuntimeCleanupOwnershipEntry | null {
    return RUNTIME_CLEANUP_OWNERSHIP_ENTRIES.find((entry) => entry.id === id) ?? null;
}

export function listRuntimeCleanupCollectorContracts(): readonly RuntimeCleanupCollectorContract[] {
    const contracts = new Map<RuntimeCleanupCollectorKey, {
        ownershipEntryIds: string[];
        candidateCategory: TaskScopedRuntimeCandidateCategory;
        taskPurgeMode: RuntimeCleanupTaskPurgeMode;
        sharedSideEffectActions: Set<RuntimeCleanupSharedSideEffectAction>;
    }>();

    for (const entry of RUNTIME_CLEANUP_OWNERSHIP_ENTRIES as readonly RuntimeCleanupOwnershipEntry[]) {
        if (!entry.collectorKey || !entry.candidateCategory) {
            continue;
        }
        const existing = contracts.get(entry.collectorKey);
        if (existing) {
            existing.ownershipEntryIds.push(entry.id);
            if (entry.taskPurgeMode === 'delete-owned-artifacts-and-rebuild-shared-state') {
                existing.taskPurgeMode = entry.taskPurgeMode;
            }
            for (const action of entry.sharedSideEffectActions ?? []) {
                existing.sharedSideEffectActions.add(action);
            }
            continue;
        }
        contracts.set(entry.collectorKey, {
            ownershipEntryIds: [entry.id],
            candidateCategory: entry.candidateCategory,
            taskPurgeMode: entry.taskPurgeMode,
            sharedSideEffectActions: new Set(entry.sharedSideEffectActions ?? [])
        });
    }

    return Array.from(contracts, ([key, contract]) => ({
        key,
        ownershipEntryIds: contract.ownershipEntryIds,
        candidateCategory: contract.candidateCategory,
        taskPurgeMode: contract.taskPurgeMode,
        sharedSideEffectActions: Array.from(contract.sharedSideEffectActions).sort()
    }));
}

export function isTaskScopedRuntimeCandidateCategory(category: string): category is TaskScopedRuntimeCandidateCategory {
    return TASK_SCOPED_RUNTIME_CANDIDATE_CATEGORIES.includes(category as TaskScopedRuntimeCandidateCategory);
}

export function listTaskPurgeableRuntimeCandidateCategories(): readonly TaskScopedRuntimeCandidateCategory[] {
    const categories = new Set<TaskScopedRuntimeCandidateCategory>();
    for (const entry of RUNTIME_CLEANUP_OWNERSHIP_ENTRIES as readonly RuntimeCleanupOwnershipEntry[]) {
        if (
            entry.candidateCategory
            && isTaskScopedRuntimeCandidateCategory(entry.candidateCategory)
            && (
                entry.taskPurgeMode === 'delete-owned-artifacts'
                || entry.taskPurgeMode === 'delete-owned-artifacts-and-rebuild-shared-state'
            )
        ) {
            categories.add(entry.candidateCategory);
        }
    }
    return TASK_SCOPED_RUNTIME_CANDIDATE_CATEGORIES.filter((category) => categories.has(category));
}

export function getRuntimeCleanupTaskPurgeModeForCandidateCategory(
    category: string
): RuntimeCleanupTaskPurgeMode | null {
    if (!isTaskScopedRuntimeCandidateCategory(category)) {
        return null;
    }

    let resolvedMode: RuntimeCleanupTaskPurgeMode | null = null;
    for (const entry of RUNTIME_CLEANUP_OWNERSHIP_ENTRIES as readonly RuntimeCleanupOwnershipEntry[]) {
        if (entry.candidateCategory !== category) {
            continue;
        }
        if (entry.taskPurgeMode === 'delete-owned-artifacts-and-rebuild-shared-state') {
            return entry.taskPurgeMode;
        }
        if (entry.taskPurgeMode === 'delete-owned-artifacts') {
            resolvedMode = entry.taskPurgeMode;
        } else if (resolvedMode === null) {
            resolvedMode = entry.taskPurgeMode;
        }
    }
    return resolvedMode;
}

export function isRuntimeCleanupTaskPurgeDeletionCategory(category: string): boolean {
    const purgeMode = getRuntimeCleanupTaskPurgeModeForCandidateCategory(category);
    return purgeMode === 'delete-owned-artifacts'
        || purgeMode === 'delete-owned-artifacts-and-rebuild-shared-state';
}

export function listRuntimeCleanupSideEffectActionsForRemovedCategories(
    categories: ReadonlySet<string>
): readonly RuntimeCleanupSharedSideEffectAction[] {
    const actions = new Set<RuntimeCleanupSharedSideEffectAction>();
    for (const entry of RUNTIME_CLEANUP_OWNERSHIP_ENTRIES as readonly RuntimeCleanupOwnershipEntry[]) {
        if (
            entry.candidateCategory
            && categories.has(entry.candidateCategory)
            && entry.taskPurgeMode === 'delete-owned-artifacts-and-rebuild-shared-state'
        ) {
            for (const action of entry.sharedSideEffectActions ?? []) {
                actions.add(action);
            }
        }
    }
    return Array.from(actions).sort();
}

export function resolveRuntimeCleanupStandardPaths(runtimeDir: string): RuntimeCleanupStandardPaths {
    return {
        manualValidationDir: path.join(runtimeDir, 'manual-validation'),
        compactDir: path.join(runtimeDir, 'compact'),
        reviewsDir: path.join(runtimeDir, 'reviews'),
        taskEventsDir: path.join(runtimeDir, 'task-events'),
        plansDir: path.join(runtimeDir, 'plans'),
        projectMemoryDir: path.join(runtimeDir, 'project-memory'),
        taskLedgerDir: path.join(runtimeDir, 'task-ledger'),
        backupsDir: path.join(runtimeDir, 'backups'),
        bundleBackupsDir: path.join(runtimeDir, 'bundle-backups'),
        updateReportsDir: path.join(runtimeDir, 'update-reports'),
        updateRollbacksDir: path.join(runtimeDir, 'update-rollbacks'),
        testScratchDir: path.join(runtimeDir, '.test-scratch'),
        cacheDir: path.join(runtimeDir, 'cache'),
        reportsDir: path.join(runtimeDir, 'reports'),
        updateTempDir: path.join(runtimeDir, 'update-temp'),
        tmpDir: path.join(runtimeDir, 'tmp'),
        isolationSandboxDir: path.join(runtimeDir, '.isolation-sandbox')
    };
}
