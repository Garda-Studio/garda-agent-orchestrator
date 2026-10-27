import * as fs from 'node:fs';
import * as path from 'node:path';
import { writeFileAtomically } from '../../core/filesystem';
import {
    isTaskBoundFullSuiteValidationRequirement,
    validateTimelineCompleteness,
    type TimelineCompletenessResult
} from './lifecycle-events';
import { inspectTaskEventFile } from './task-events';
import { withFilesystemLock } from './task-events-locking';
// Keep this dependency-safe helper import; gate barrels load classification modules into status/report paths.
// noinspection ES6PreferShortImport
import { detectCodeChanged } from '../../core/preflight-code-change';
import { loadFullSuiteValidationConfig } from '../../core/full-suite-validation-config';
import { parseTaskIdJsonlFileName, RESERVED_TASK_EVENT_TIMELINE_NAMES } from '../../core/task-ids';
import { resolveGardaCliPrefix } from '../../core/garda-cli-prefix';
const SUMMARY_VERSION = 2;
const SUMMARY_FILE_NAME = '.timeline-summary.json';
const SUMMARY_LOCK_FILE_NAME = '.timeline-summary.lock';
const DEFAULT_SUMMARY_LOCK_TIMEOUT_MS = 500;
const DEFAULT_SUMMARY_LOCK_RETRY_MS = 25;
const DEFAULT_SUMMARY_LOCK_STALE_MS = 30 * 1000;
const MAX_TIMELINE_WARNING_DETAIL_ITEMS = 5;

export interface TimelineSummaryEntry {
    task_id: string;
    file_size_bytes: number;
    file_mtime_ms: number;
    code_changed: boolean;
    full_suite_validation_required?: boolean;
    completeness_status: TimelineCompletenessResult['status'];
    events_found: string[];
    events_missing: string[];
    completeness_violations: string[];
    integrity_status: string;
    events_scanned: number;
    integrity_event_count: number;
    integrity_violations: string[];
    /** Epoch-ms when this entry was last written; enables freshness comparison under concurrent writers. */
    written_at_ms?: number;
}

export interface TimelineSummaryIndex {
    version: number;
    updated_at_utc: string;
    entries: Record<string, TimelineSummaryEntry>;
}

interface TimelineSummaryTestHooks {
    beforeMerge?: (eventsRoot: string, taskId: string, entry: TimelineSummaryEntry) => void;
    afterWrite?: (eventsRoot: string, taskId: string, entry: TimelineSummaryEntry, attempt: number) => void;
}

let timelineSummaryTestHooks: TimelineSummaryTestHooks | null = null;
const preflightCodeChangedCache = new Map<string, { file_size_bytes: number; file_mtime_ms: number; code_changed: boolean }>();

// Test-only hook for deterministic race simulation; no production callers should use this.
export function __setTimelineSummaryTestHooks(hooks: TimelineSummaryTestHooks | null): void {
    timelineSummaryTestHooks = hooks;
}

export interface StatusTimelineSummary {
    taskCount: number;
    healthy: number;
    warnings: string[];
    warningDetails: TimelineWarningDetail[];
}

export interface TimelineSummaryCollectionOptions {
    taskStatuses?: ReadonlyMap<string, string>;
    taskIds?: ReadonlySet<string>;
}

export interface DoctorTimelineEvidence {
    task_id: string;
    timeline_path: string;
    status: string;
    completeness_status: string;
    events_missing: string[];
    code_changed: boolean;
    events_scanned: number;
    integrity_event_count: number;
    violations: string[];
}

export interface DoctorTimelineSummary {
    evidence: DoctorTimelineEvidence[];
    warnings: string[];
}

export type TimelineIssueKind = 'INVALID' | 'LEGACY' | 'INCOMPLETE' | 'INTEGRITY_FAILED';

export interface TimelineWarningDetail {
    task_id: string | null;
    file_name: string;
    kind: TimelineIssueKind | 'INVALID_FILE';
    details: string[];
    details_omitted_count: number;
    message: string;
    repair_guidance: string;
    timeline_path: string;
    task_status: string | null;
}

interface TimelineIssueInput {
    taskId: string;
    cliPrefix?: string;
    fileName: string;
    timelinePath: string;
    taskStatus?: string | null;
    taskStatusScopeProvided?: boolean;
    taskStatusKnown?: boolean;
    statusSurface?: boolean;
    integrityStatus: string;
    completenessStatus: string;
    eventsMissing: string[];
    integrityViolations: string[];
}

export function getTimelineSummaryPath(eventsRoot: string): string {
    return path.join(eventsRoot, SUMMARY_FILE_NAME);
}

export function getTimelineSummaryLockPath(eventsRoot: string): string {
    return path.join(eventsRoot, SUMMARY_LOCK_FILE_NAME);
}

function withTimelineSummaryLock<T>(eventsRoot: string, callback: () => T): T {
    const { result } = withFilesystemLock(getTimelineSummaryLockPath(eventsRoot), {
        timeoutMs: DEFAULT_SUMMARY_LOCK_TIMEOUT_MS,
        retryMs: DEFAULT_SUMMARY_LOCK_RETRY_MS,
        staleMs: DEFAULT_SUMMARY_LOCK_STALE_MS
    }, callback);
    return result;
}

export function readTimelineSummaryIndex(eventsRoot: string): TimelineSummaryIndex | null {
    try {
        const summaryPath = getTimelineSummaryPath(eventsRoot);
        if (!fs.existsSync(summaryPath)) return null;
        const raw = fs.readFileSync(summaryPath, 'utf8');
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        if (parsed.version !== SUMMARY_VERSION) return null;
        if (typeof parsed.updated_at_utc !== 'string') return null;
        if (!parsed.entries || typeof parsed.entries !== 'object' || Array.isArray(parsed.entries)) return null;
        return parsed as unknown as TimelineSummaryIndex;
    } catch {
        return null;
    }
}

function isFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

function isStringArray(value: unknown): value is string[] {
    return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isTimelineSummaryEntryLike(value: unknown): value is TimelineSummaryEntry {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }
    const entry = value as Record<string, unknown>;
    return typeof entry.task_id === 'string'
        && isFiniteNumber(entry.file_size_bytes)
        && isFiniteNumber(entry.file_mtime_ms)
        && typeof entry.code_changed === 'boolean'
        && typeof entry.completeness_status === 'string'
        && isStringArray(entry.events_found)
        && isStringArray(entry.events_missing)
        && isStringArray(entry.completeness_violations)
        && typeof entry.integrity_status === 'string'
        && isFiniteNumber(entry.events_scanned)
        && isFiniteNumber(entry.integrity_event_count)
        && isStringArray(entry.integrity_violations)
        && (entry.written_at_ms === undefined || isFiniteNumber(entry.written_at_ms));
}

interface CleanupPruneSummaryIndex {
    index: TimelineSummaryIndex;
    dropped_invalid_entry_keys: string[];
}

function readTimelineSummaryIndexForCleanupPrune(eventsRoot: string): CleanupPruneSummaryIndex | null {
    const currentIndex = readTimelineSummaryIndex(eventsRoot);
    if (currentIndex) {
        return {
            index: currentIndex,
            dropped_invalid_entry_keys: []
        };
    }

    try {
        const summaryPath = getTimelineSummaryPath(eventsRoot);
        if (!fs.existsSync(summaryPath)) return null;
        const raw = fs.readFileSync(summaryPath, 'utf8');
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        if (!parsed.entries || typeof parsed.entries !== 'object' || Array.isArray(parsed.entries)) {
            return null;
        }

        const normalizedEntries: Record<string, TimelineSummaryEntry> = {};
        const droppedInvalidEntryKeys: string[] = [];
        for (const [taskId, entry] of Object.entries(parsed.entries as Record<string, unknown>)) {
            if (!isTimelineSummaryEntryLike(entry)) {
                droppedInvalidEntryKeys.push(taskId);
                continue;
            }
            normalizedEntries[taskId] = entry;
        }

        return {
            index: {
                version: SUMMARY_VERSION,
                updated_at_utc: typeof parsed.updated_at_utc === 'string'
                    ? parsed.updated_at_utc
                    : new Date().toISOString(),
                entries: normalizedEntries
            },
            dropped_invalid_entry_keys: droppedInvalidEntryKeys
        };
    } catch {
        return null;
    }
}

export function writeTimelineSummaryIndex(eventsRoot: string, index: TimelineSummaryIndex): void {
    const summaryPath = getTimelineSummaryPath(eventsRoot);
    writeFileAtomically(summaryPath, JSON.stringify(index, null, 2) + '\n', { encoding: 'utf8', fsync: false });
}

export function isTimelineSummaryEntryCurrent(
    entry: TimelineSummaryEntry,
    timelinePath: string,
    fullSuiteValidationEnabled: boolean = false
): boolean {
    try {
        const stat = fs.statSync(path.resolve(timelinePath));
        if (!stat.isFile()) return false;
        if (stat.size !== entry.file_size_bytes) return false;
        if (Math.floor(stat.mtimeMs) !== entry.file_mtime_ms) return false;
        return isTaskBoundFullSuiteValidationRequirement(entry.events_found, entry.completeness_status)
            || (entry.full_suite_validation_required === true) === fullSuiteValidationEnabled;
    } catch {
        return false;
    }
}

export function buildTimelineSummaryEntry(
    timelinePath: string,
    taskId: string,
    codeChanged: boolean,
    fullSuiteValidationEnabled: boolean = false
): TimelineSummaryEntry | null {
    let preStat: fs.Stats;
    try {
        preStat = fs.statSync(path.resolve(timelinePath));
        if (!preStat.isFile()) return null;
    } catch {
        return null;
    }

    const completeness = validateTimelineCompleteness(timelinePath, taskId, {
        codeChanged,
        fullSuiteValidationEnabled
    });
    const inspect = inspectTaskEventFile(timelinePath, taskId);

    // Re-stat after read to detect concurrent modification
    let postStat: fs.Stats;
    try {
        postStat = fs.statSync(path.resolve(timelinePath));
    } catch {
        return null;
    }

    if (postStat.size !== preStat.size || Math.floor(postStat.mtimeMs) !== Math.floor(preStat.mtimeMs)) {
        return null;
    }

    return {
        task_id: taskId,
        file_size_bytes: preStat.size,
        file_mtime_ms: Math.floor(preStat.mtimeMs),
        code_changed: codeChanged,
        full_suite_validation_required: completeness.full_suite_validation_required === true ? true : undefined,
        completeness_status: completeness.status,
        events_found: completeness.events_found.slice(),
        events_missing: completeness.events_missing.slice(),
        completeness_violations: completeness.violations.slice(),
        integrity_status: inspect.status,
        events_scanned: inspect.events_scanned,
        integrity_event_count: inspect.integrity_event_count,
        integrity_violations: inspect.violations.slice(),
        written_at_ms: Date.now()
    };
}

// Called after appendTaskEvent, best-effort. Summary mutations are
// serialized under a dedicated summary lock so append and cleanup do
// not clobber each other.
export function updateTimelineSummaryForTask(
    eventsRoot: string,
    taskId: string,
    codeChanged?: boolean
): void {
    // Prefer an explicit hint from the latest PREFLIGHT_CLASSIFIED event.
    // Otherwise reuse the current summary entry's stable code_changed bit
    // to avoid re-reading preflight JSON on every append, and only fall
    // back to preflight parsing when no summary entry exists yet.
    const effectiveCodeChanged = resolveEffectiveCodeChangedForTask(eventsRoot, taskId, codeChanged);
    const timelinePath = path.join(eventsRoot, `${taskId}.jsonl`);
    const fullSuiteValidationEnabled = loadFullSuiteValidationConfig(path.resolve(eventsRoot, '..', '..')).enabled;
    const entry = buildTimelineSummaryEntry(timelinePath, taskId, effectiveCodeChanged, fullSuiteValidationEnabled);
    if (!entry) return;

    timelineSummaryTestHooks?.beforeMerge?.(eventsRoot, taskId, entry);

    try {
        withTimelineSummaryLock(eventsRoot, () => {
            if (!isTimelineSummaryEntryCurrent(entry, timelinePath, fullSuiteValidationEnabled)) {
                return;
            }
            mergeEntryWithRetry(eventsRoot, taskId, entry);
        });
    } catch {
        // Lock contention or transient filesystem issues are best-effort only.
    }
}

function resolveEffectiveCodeChangedForTask(
    eventsRoot: string,
    taskId: string,
    codeChanged?: boolean
): boolean {
    if (typeof codeChanged === 'boolean') {
        return codeChanged;
    }
    const existingSummaryCodeChanged = readTimelineSummaryIndex(eventsRoot)?.entries?.[taskId]?.code_changed;
    if (typeof existingSummaryCodeChanged === 'boolean') {
        return existingSummaryCodeChanged;
    }
    const bundlePath = path.resolve(eventsRoot, '..', '..');
    return detectCodeChangedFromPreflight(bundlePath, taskId);
}

export function reconcileTimelineSummaryForTask(
    eventsRoot: string,
    taskId: string,
    codeChanged?: boolean
): void {
    const timelinePath = path.join(eventsRoot, `${taskId}.jsonl`);
    const summaryPath = getTimelineSummaryPath(eventsRoot);
    const fullSuiteValidationEnabled = loadFullSuiteValidationConfig(path.resolve(eventsRoot, '..', '..')).enabled;
    withTimelineSummaryLock(eventsRoot, () => {
        const summaryFileExists = (() => {
            try {
                return fs.existsSync(summaryPath) && fs.statSync(summaryPath).isFile();
            } catch {
                return false;
            }
        })();
        let timelineExists: boolean;
        try {
            timelineExists = fs.existsSync(timelinePath) && fs.statSync(timelinePath).isFile();
        } catch {
            timelineExists = false;
        }

        if (!timelineExists) {
            const cleanupIndex = readTimelineSummaryIndexForCleanupPrune(eventsRoot);
            if (summaryFileExists && !cleanupIndex) {
                throw new Error(`Unable to safely read existing timeline summary index before removing '${taskId}'.`);
            }
            const index = cleanupIndex?.index ?? null;
            if (!index || !Object.prototype.hasOwnProperty.call(index.entries, taskId)) {
                return;
            }
            delete index.entries[taskId];
            index.updated_at_utc = new Date().toISOString();
            writeTimelineSummaryIndex(eventsRoot, index);
            return;
        }

        const entry = buildTimelineSummaryEntry(
            timelinePath,
            taskId,
            resolveEffectiveCodeChangedForTask(eventsRoot, taskId, codeChanged),
            fullSuiteValidationEnabled
        );
        if (!entry) {
            throw new Error(`Unable to rebuild timeline summary entry for '${taskId}'.`);
        }

        const cleanupIndex = readTimelineSummaryIndexForCleanupPrune(eventsRoot);
        if (summaryFileExists && !cleanupIndex) {
            throw new Error(`Unable to safely read existing timeline summary index before reconciling '${taskId}'.`);
        }
        let index = cleanupIndex?.index ?? null;
        if (!index) {
            index = {
                version: SUMMARY_VERSION,
                updated_at_utc: new Date().toISOString(),
                entries: {}
            };
        }
        index.entries[taskId] = entry;
        index.updated_at_utc = new Date().toISOString();
        writeTimelineSummaryIndex(eventsRoot, index);
    });
}

const MAX_MERGE_ATTEMPTS = 2;

function mergeEntryWithRetry(
    eventsRoot: string,
    taskId: string,
    entry: TimelineSummaryEntry
): void {
    for (let attempt = 0; attempt < MAX_MERGE_ATTEMPTS; attempt++) {
        const summaryPath = getTimelineSummaryPath(eventsRoot);
        const summaryFileExists = (() => {
            try {
                return fs.existsSync(summaryPath) && fs.statSync(summaryPath).isFile();
            } catch {
                return false;
            }
        })();
        const cleanupIndex = readTimelineSummaryIndexForCleanupPrune(eventsRoot);
        if (summaryFileExists && !cleanupIndex) {
            return;
        }
        let index = cleanupIndex?.index ?? null;
        if (!index) {
            index = {
                version: SUMMARY_VERSION,
                updated_at_utc: new Date().toISOString(),
                entries: {}
            };
        }

        // Skip write if existing entry is already at least as fresh
        const existing = index.entries[taskId];
        if (
            existing &&
            existing.written_at_ms &&
            entry.written_at_ms &&
            existing.written_at_ms >= entry.written_at_ms &&
            existing.file_size_bytes === entry.file_size_bytes &&
            existing.file_mtime_ms === entry.file_mtime_ms
        ) {
            return;
        }

        index.entries[taskId] = entry;
        index.updated_at_utc = new Date().toISOString();

        try {
            writeTimelineSummaryIndex(eventsRoot, index);
        } catch {
            // Write failed (e.g. EPERM contention on Windows) — best-effort, skip
            return;
        }
        timelineSummaryTestHooks?.afterWrite?.(eventsRoot, taskId, entry, attempt);

        // Verify our entry persisted (another writer may have clobbered it)
        const verification = readTimelineSummaryIndex(eventsRoot);
        if (verification?.entries[taskId]?.written_at_ms === entry.written_at_ms) {
            return; // Success — our entry is present
        }
        // Entry was clobbered; retry with fresh state on next iteration
    }
    // Exhausted retries — best-effort contract: stale entry is acceptable
}

export function pruneTimelineSummaryEntries(eventsRoot: string): void {
    if (!fs.existsSync(eventsRoot)) return;

    try {
        withTimelineSummaryLock(eventsRoot, () => {
            const cleanupIndex = readTimelineSummaryIndexForCleanupPrune(eventsRoot);
            if (!cleanupIndex) return;

            const { index, dropped_invalid_entry_keys: droppedInvalidEntryKeys } = cleanupIndex;
            const taskIds = Object.keys(index.entries);
            if (taskIds.length === 0 && droppedInvalidEntryKeys.length === 0) return;

            let pruned = droppedInvalidEntryKeys.length > 0;
            for (const taskId of taskIds) {
                const jsonlPath = path.join(eventsRoot, `${taskId}.jsonl`);
                if (!fs.existsSync(jsonlPath)) {
                    delete index.entries[taskId];
                    pruned = true;
                }
            }

            if (pruned) {
                index.updated_at_utc = new Date().toISOString();
                writeTimelineSummaryIndex(eventsRoot, index);
            }
        });
    } catch {
        // Cleanup-time summary pruning is also best-effort.
    }
}

function isReservedTimelineJsonlFile(fileName: string): boolean {
    if (!fileName.endsWith('.jsonl')) {
        return false;
    }
    const stem = fileName.slice(0, -'.jsonl'.length).trim().toLowerCase();
    return RESERVED_TASK_EVENT_TIMELINE_NAMES.has(stem);
}

function listTimelineJsonlFiles(eventsRoot: string): string[] {
    try {
        return fs.readdirSync(eventsRoot)
            .filter((name: string) => name.endsWith('.jsonl') && !isReservedTimelineJsonlFile(name));
    } catch {
        return [];
    }
}

function detectCodeChangedFromPreflight(bundlePath: string, taskId: string): boolean {
    const preflightPath = path.join(bundlePath, 'runtime', 'reviews', `${taskId}-preflight.json`);
    try {
        if (!fs.existsSync(preflightPath)) return false;
        const stat = fs.statSync(preflightPath);
        if (!stat.isFile()) return false;
        const cached = preflightCodeChangedCache.get(preflightPath);
        const file_size_bytes = stat.size;
        const file_mtime_ms = Math.floor(stat.mtimeMs);
        if (cached && cached.file_size_bytes === file_size_bytes && cached.file_mtime_ms === file_mtime_ms) {
            return cached.code_changed;
        }
        const parsed = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
        const code_changed = detectCodeChanged(parsed, bundlePath);
        preflightCodeChangedCache.set(preflightPath, {
            file_size_bytes,
            file_mtime_ms,
            code_changed
        });
        return code_changed;
    } catch {
        return false;
    }
}

function shortenIssueDetails(details: string[]): string {
    const normalized = normalizeIssueDetails(details);
    if (normalized.length === 0) {
        return 'none recorded';
    }
    return normalized.slice(0, 3).join('; ');
}

function normalizeIssueDetails(details: string[]): string[] {
    return details
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
}

function buildBoundedIssueDetails(details: string[]): { details: string[]; omittedCount: number } {
    const normalized = normalizeIssueDetails(details);
    const selected = normalized.slice(0, MAX_TIMELINE_WARNING_DETAIL_ITEMS);
    if (normalized.length > selected.length) {
        const priorityDetail = normalized.find((detail) => !selected.includes(detail) && /COMPLETION_GATE_PASSED/u.test(detail))
            || normalized.find((detail) => !selected.includes(detail) && /FULL_SUITE_VALIDATION/u.test(detail));
        if (priorityDetail && selected.length > 0) {
            selected[selected.length - 1] = priorityDetail;
        }
    }
    return {
        details: selected,
        omittedCount: Math.max(0, normalized.length - selected.length)
    };
}

function buildTimelineRepairGuidance(
    kind: TimelineIssueKind,
    taskId: string,
    timelinePath: string,
    taskStatus?: string | null,
    cliPrefix = 'node bin/garda.js'
): string {
    const displayPath = timelinePath.replace(/\\/g, '/');
    switch (kind) {
        case 'INVALID':
            return `inspect ${displayPath}; remove or restore malformed/foreign records, then run ${cliPrefix} repair rebuild-indexes --confirm --repo-root "."`;
        case 'LEGACY':
            return `keep as historical evidence or replay/re-enter ${taskId} through current gates; then run ${cliPrefix} repair rebuild-indexes --confirm --repo-root "."`;
        case 'INTEGRITY_FAILED':
            return `treat ${displayPath} as tampered/corrupt evidence; restore from trusted backup or reset the task before rebuilding indexes`;
        case 'INCOMPLETE':
            if (taskStatus === 'BLOCKED') {
                return `resolve the active BLOCKED task state for ${taskId} in TASK.md, then resume with ${cliPrefix} next-step "${taskId}" --repo-root "."`;
            }
            if (taskStatus === 'SPLIT_REQUIRED') {
                return `complete the SPLIT_REQUIRED decomposition path for ${taskId} in TASK.md, then resume with ${cliPrefix} next-step "${taskId}" --repo-root "."`;
            }
            return `resume ${taskId} with ${cliPrefix} next-step "${taskId}" --repo-root "." and complete the missing lifecycle gates`;
        default:
            return `inspect ${displayPath}`;
    }
}

function normalizeTimelineTaskStatus(taskStatus?: string | null): string {
    return String(taskStatus || '')
        .trim()
        .replace(/^[^A-Za-z0-9_]+/u, '')
        .trim()
        .toUpperCase()
        .replace(/\s+/gu, '_');
}

function shouldSuppressStatusTimelineIncomplete(input: TimelineIssueInput): boolean {
    if (input.statusSurface !== true) {
        return false;
    }

    const normalizedStatus = normalizeTimelineTaskStatus(input.taskStatus);
    return normalizedStatus === 'DONE'
        || normalizedStatus === 'DECOMPOSED'
        || (input.taskStatusScopeProvided === true && input.taskStatusKnown !== true);
}

function buildTimelineWarningDetail(input: TimelineIssueInput): TimelineWarningDetail | null {
    let kind: TimelineIssueKind | null = null;
    let details: string[] = [];

    if (input.integrityStatus === 'MISSING' || input.integrityStatus === 'EMPTY') {
        kind = 'INVALID';
        details = input.integrityViolations.length > 0
            ? input.integrityViolations
            : [`integrity status ${input.integrityStatus}`];
    } else if (
        input.integrityStatus === 'FAILED'
        && input.integrityViolations.some((violation) =>
            violation.includes('invalid JSON') || violation.includes('foreign task_id')
        )
    ) {
        kind = 'INVALID';
        details = input.integrityViolations;
    } else if (input.integrityStatus === 'FAILED') {
        kind = 'INTEGRITY_FAILED';
        details = input.integrityViolations;
    } else if (input.integrityStatus === 'LEGACY_ONLY' || input.integrityStatus === 'PASS_WITH_LEGACY_PREFIX') {
        kind = 'LEGACY';
        details = [`integrity status ${input.integrityStatus}`];
    } else if (input.completenessStatus !== 'COMPLETE') {
        if (shouldSuppressStatusTimelineIncomplete(input)) {
            return null;
        }
        kind = 'INCOMPLETE';
        details = input.eventsMissing;
    }

    if (!kind) {
        return null;
    }

    const repairGuidance = buildTimelineRepairGuidance(kind, input.taskId, input.timelinePath, input.taskStatus, input.cliPrefix);
    const boundedDetails = buildBoundedIssueDetails(details);
    const statusLayerNote = input.statusSurface === true
        ? ' Note: task-cycle diagnostic; workspace readiness is evaluated separately.'
        : '';
    return {
        task_id: input.taskId,
        file_name: input.fileName,
        kind,
        details: boundedDetails.details,
        details_omitted_count: boundedDetails.omittedCount,
        message: `${kind} timeline: ${input.fileName} (${shortenIssueDetails(details)}). Repair: ${repairGuidance}.${statusLayerNote}`,
        repair_guidance: repairGuidance,
        timeline_path: input.timelinePath.replace(/\\/g, '/'),
        task_status: input.taskStatus || null
    };
}

function classifyTimelineIssue(input: TimelineIssueInput): string | null {
    return buildTimelineWarningDetail(input)?.message ?? null;
}

function buildInvalidTimelineFileWarningDetail(fileName: string, timelinePath: string): TimelineWarningDetail {
    const stem = fileName.endsWith('.jsonl') ? fileName.slice(0, -'.jsonl'.length).trim() : fileName;
    const repairGuidance = `remove or rename ${timelinePath.replace(/\\/g, '/')} to a canonical T-<segment>(-<segment>)*.jsonl timeline filename before rebuilding derived indexes`;
    return {
        task_id: null,
        file_name: fileName,
        kind: 'INVALID_FILE',
        details: [`invalid task id '${stem}'`],
        details_omitted_count: 0,
        message: `INVALID timeline file: ${fileName} (invalid task id '${stem}'). Repair: ${repairGuidance}`,
        repair_guidance: repairGuidance,
        timeline_path: timelinePath.replace(/\\/g, '/'),
        task_status: null
    };
}

function buildInvalidTimelineFileWarning(fileName: string, timelinePath: string): string {
    return buildInvalidTimelineFileWarningDetail(fileName, timelinePath).message;
}

// Read-only — never writes to disk.
export function collectTimelineSummaryForStatus(
    bundlePath: string,
    options: TimelineSummaryCollectionOptions = {}
): StatusTimelineSummary {
    const eventsRoot = path.join(bundlePath, 'runtime', 'task-events');
    const cliPrefix = resolveGardaCliPrefix(path.dirname(path.resolve(bundlePath)));
    const fullSuiteValidationEnabled = loadFullSuiteValidationConfig(bundlePath).enabled;
    if (!fs.existsSync(eventsRoot)) {
        return { taskCount: 0, healthy: 0, warnings: [], warningDetails: [] };
    }

    const files = options.taskIds === undefined
        ? listTimelineJsonlFiles(eventsRoot)
        : [...options.taskIds]
            .map((taskId) => ({ taskId, fileName: `${taskId}.jsonl` }))
            .filter(({ taskId, fileName }) => (
                parseTaskIdJsonlFileName(fileName) === taskId
                && fs.existsSync(path.join(eventsRoot, fileName))
            ))
            .map(({ fileName }) => fileName)
            .sort((left, right) => left.localeCompare(right));
    if (files.length === 0) {
        return { taskCount: 0, healthy: 0, warnings: [], warningDetails: [] };
    }

    const summary = readTimelineSummaryIndex(eventsRoot);
    let healthy = 0;
    const warnings: string[] = [];
    const warningDetails: TimelineWarningDetail[] = [];
    const taskStatusScopeProvided = options.taskStatuses !== undefined;

    for (const fileName of files) {
        const taskId = parseTaskIdJsonlFileName(fileName);
        const timelinePath = path.join(eventsRoot, fileName);
        if (!taskId) {
            const detail = buildInvalidTimelineFileWarningDetail(fileName, timelinePath);
            warnings.push(detail.message);
            warningDetails.push(detail);
            continue;
        }
        const cached = summary?.entries[taskId] ?? null;
        const taskStatus = options.taskStatuses?.get(taskId) ?? null;
        const taskStatusKnown = options.taskStatuses?.has(taskId) ?? false;

        if (cached && isTimelineSummaryEntryCurrent(cached, timelinePath, fullSuiteValidationEnabled)) {
            const issue = buildTimelineWarningDetail({
                taskId,
                cliPrefix,
                fileName,
                timelinePath,
                taskStatus,
                taskStatusScopeProvided,
                taskStatusKnown,
                statusSurface: true,
                integrityStatus: cached.integrity_status,
                completenessStatus: cached.completeness_status,
                eventsMissing: cached.events_missing,
                integrityViolations: cached.integrity_violations
            });
            if (!issue) {
                healthy++;
            } else {
                warnings.push(issue.message);
                warningDetails.push(issue);
            }
            continue;
        }

        // Stale or missing — fall back to per-file validation (read-only)
        try {
            const stat = fs.statSync(path.resolve(timelinePath));
            if (stat.isFile() && stat.size > 0) {
                const codeChanged = detectCodeChangedFromPreflight(bundlePath, taskId);
                const completeness = validateTimelineCompleteness(timelinePath, taskId, {
                    codeChanged,
                    fullSuiteValidationEnabled
                });
                const inspectResult = inspectTaskEventFile(timelinePath, taskId);
                const issue = buildTimelineWarningDetail({
                    taskId,
                    cliPrefix,
                    fileName,
                    timelinePath,
                    taskStatus,
                    taskStatusScopeProvided,
                    taskStatusKnown,
                    statusSurface: true,
                    integrityStatus: inspectResult.status,
                    completenessStatus: completeness.status,
                    eventsMissing: completeness.events_missing,
                    integrityViolations: inspectResult.violations
                });
                if (!issue) {
                    healthy++;
                } else {
                    warnings.push(issue.message);
                    warningDetails.push(issue);
                }
            } else {
                const issue = buildTimelineWarningDetail({
                    taskId,
                    cliPrefix,
                    fileName,
                    timelinePath,
                    taskStatus,
                    taskStatusScopeProvided,
                    taskStatusKnown,
                    statusSurface: true,
                    integrityStatus: 'EMPTY',
                    completenessStatus: 'INCOMPLETE',
                    eventsMissing: [],
                    integrityViolations: []
                });
                warnings.push(issue?.message || `INVALID timeline: ${fileName}`);
                if (issue) warningDetails.push(issue);
            }
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            const issue = buildTimelineWarningDetail({
                taskId,
                cliPrefix,
                fileName,
                timelinePath,
                taskStatus,
                taskStatusScopeProvided,
                taskStatusKnown,
                statusSurface: true,
                integrityStatus: 'MISSING',
                completenessStatus: 'INCOMPLETE',
                eventsMissing: [],
                integrityViolations: [`scan error: ${msg}`]
            });
            warnings.push(issue?.message || `INVALID timeline: ${fileName}`);
            if (issue) warningDetails.push(issue);
        }
    }

    return {
        taskCount: files.filter((fileName) => parseTaskIdJsonlFileName(fileName) !== null).length,
        healthy,
        warnings,
        warningDetails
    };
}

// Read-only — never writes to disk.
export function collectTimelineSummaryForDoctor(
    bundlePath: string,
    options: TimelineSummaryCollectionOptions = {}
): DoctorTimelineSummary {
    const eventsRoot = path.join(bundlePath, 'runtime', 'task-events');
    const cliPrefix = resolveGardaCliPrefix(path.dirname(path.resolve(bundlePath)));
    const fullSuiteValidationEnabled = loadFullSuiteValidationConfig(bundlePath).enabled;
    if (!fs.existsSync(eventsRoot)) {
        return { evidence: [], warnings: [] };
    }

    const files = listTimelineJsonlFiles(eventsRoot);
    if (files.length === 0) {
        return { evidence: [], warnings: [] };
    }

    const summary = readTimelineSummaryIndex(eventsRoot);
    const evidence: DoctorTimelineEvidence[] = [];
    const warnings: string[] = [];

    for (const fileName of files) {
        const taskId = parseTaskIdJsonlFileName(fileName);
        const timelinePath = path.join(eventsRoot, fileName);
        if (!taskId) {
            warnings.push(buildInvalidTimelineFileWarning(fileName, timelinePath));
            continue;
        }
        const cached = summary?.entries[taskId] ?? null;
        const taskStatus = options.taskStatuses?.get(taskId) ?? null;

        if (cached && isTimelineSummaryEntryCurrent(cached, timelinePath, fullSuiteValidationEnabled)) {
            const item: DoctorTimelineEvidence = {
                task_id: taskId,
                timeline_path: timelinePath.replace(/\\/g, '/'),
                status: cached.integrity_status,
                completeness_status: cached.completeness_status,
                events_missing: cached.events_missing.slice(),
                code_changed: cached.code_changed,
                events_scanned: cached.events_scanned,
                integrity_event_count: cached.integrity_event_count,
                violations: cached.integrity_violations.slice()
            };
            evidence.push(item);

            const issue = classifyTimelineIssue({
                taskId,
                cliPrefix,
                fileName,
                timelinePath,
                taskStatus,
                integrityStatus: cached.integrity_status,
                completenessStatus: cached.completeness_status,
                eventsMissing: cached.events_missing,
                integrityViolations: cached.integrity_violations
            });
            if (issue) {
                warnings.push(issue);
            }
            continue;
        }

        // Stale or missing — fall back to full validation (read-only)
        try {
            const codeChanged = detectCodeChangedFromPreflight(bundlePath, taskId);
            const inspectResult = inspectTaskEventFile(timelinePath, taskId);
            const completeness = validateTimelineCompleteness(timelinePath, taskId, {
                codeChanged,
                fullSuiteValidationEnabled
            });

            const item: DoctorTimelineEvidence = {
                task_id: taskId,
                timeline_path: timelinePath.replace(/\\/g, '/'),
                status: inspectResult.status,
                completeness_status: completeness.status,
                events_missing: completeness.events_missing.slice(),
                code_changed: codeChanged,
                events_scanned: inspectResult.events_scanned,
                integrity_event_count: inspectResult.integrity_event_count,
                violations: inspectResult.violations.slice()
            };
            evidence.push(item);

            const issue = classifyTimelineIssue({
                taskId,
                cliPrefix,
                fileName,
                timelinePath,
                taskStatus,
                integrityStatus: inspectResult.status,
                completenessStatus: completeness.status,
                eventsMissing: completeness.events_missing,
                integrityViolations: inspectResult.violations
            });
            if (issue) {
                warnings.push(issue);
            }
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            warnings.push(classifyTimelineIssue({
                taskId,
                cliPrefix,
                fileName,
                timelinePath,
                taskStatus,
                integrityStatus: 'MISSING',
                completenessStatus: 'INCOMPLETE',
                eventsMissing: [],
                integrityViolations: [`scan error: ${msg}`]
            }) || `INVALID timeline: ${fileName}`);
        }
    }

    return { evidence, warnings };
}
