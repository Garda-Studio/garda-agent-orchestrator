import { countNextStepWork } from '../../core/next-step-measurement';
import {
    isTaskQueueBlockedStatus,
    isTaskQueueDecomposedStatus,
    isTaskQueueDoneStatus,
    isTaskQueueTerminalStatus,
    readTaskQueueStatusToken
} from '../../core/active-task-state';
import {
    buildExactTaskIdReferencePattern,
    isCanonicalTaskId,
    isTaskIdReferenceBoundary,
    TASK_ID_ALLOWED_PATTERN
} from '../../core/task-ids';
import type {
    TaskQueueEntry
} from '../../core/task-queue-read';

export {
    parseTaskQueueEntriesFromContent,
    readTaskQueueEntries,
    type TaskQueueEntry
} from '../../core/task-queue-read';

export interface DecomposedChildRoute {
    taskId: string;
    status: string | null;
    chain: string[];
}

export interface DecomposedParentCompletionState {
    hasLinkedChildren: boolean;
    complete: boolean;
    unfinishedRoute: DecomposedChildRoute | null;
    completedDecomposedTaskIds: string[];
    missingChildTaskIds: string[];
}

export const DECOMPOSED_TASK_PROVENANCE_SOURCES = [
    'orchestrator',
    'manual-agent',
    'manual-operator'
] as const;

export type DecomposedTaskProvenanceSource = typeof DECOMPOSED_TASK_PROVENANCE_SOURCES[number];

export interface DecomposedTaskProvenance {
    source: DecomposedTaskProvenanceSource | 'unrecorded';
    evidence: 'structured-note' | 'legacy-manual-note' | 'none';
}

interface ChildTaskIdMention {
    taskId: string;
    index: number;
}

interface NumericTaskIdRangeEndpoint {
    taskId: string;
    prefix: string;
    rawNumber: string;
    value: bigint;
}

export interface StrictDecompositionSplitRoutingState {
    expectedChildProfile: string;
    ready: boolean;
    linkedChildTaskIds: string[];
    missingLinkedChildTaskIds: string[];
    missingChildTaskIds: string[];
    nonParentDerivedChildTaskIds: string[];
    unexpectedLinkedChildTaskIds: string[];
    nonStrictChildTaskIds: string[];
    terminalChildTaskIds: string[];
    placeholderChildTaskIds: string[];
    duplicateScopeChildTaskIds: string[];
    nonExecutableChildTaskIds: string[];
    childRoute: DecomposedChildRoute | null;
}

export interface SplitRequiredDecompositionState {
    ready: boolean;
    linkedChildTaskIds: string[];
    missingChildTaskIds: string[];
    terminalChildTaskIds: string[];
    placeholderChildTaskIds: string[];
    duplicateScopeChildTaskIds: string[];
    nonExecutableChildTaskIds: string[];
    childRoute: DecomposedChildRoute | null;
}

const TASK_QUEUE_LEGACY_SPLIT_NOTE_PATTERN = /\b(?:paused\s+for\s+split|split\s+into|continue\s+via\s+child\s+tasks)\b/i;
const TASK_QUEUE_CHILD_LINK_MARKER_PATTERN =
    /\b(?:split\s+into|continue\s+via|execute|created?|linked)\b[^.;\n|]*\b(?:child(?:ren)?|leaf)\s+tasks?\b|\b(?:child(?:ren)?|leaf)\s+tasks?\s*:|\bchildren\s*:|\breview\s+follow-up\s+tasks?\s+materialized\s*:|\bchild\s+range\b/igu;
const TASK_QUEUE_REVIEW_FOLLOW_UP_LINK_MARKER_PATTERN = /\breview\s+follow-up\s+tasks?\s+materialized\s*:/iu;
const TASK_QUEUE_TASK_ID_PATTERN = TASK_ID_ALLOWED_PATTERN;
const TASK_QUEUE_TASK_ID_REFERENCE_PATTERN = /(^|[^A-Za-z0-9-])([Tt]-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)(?=$|[^A-Za-z0-9-])/gu;
const TASK_QUEUE_DECOMPOSITION_SOURCE_CLAIM_PATTERN = /\bdecomposition\s+source\s*:/iu;
const TASK_QUEUE_DECOMPOSITION_SOURCE_PATTERN =
    /\bdecomposition\s+source\s*:\s*(orchestrator|manual-agent|manual-operator)(?:\s*\(([^)\r\n]*)\))?(?=\s*(?:[;|]|\.(?=\s|$)|$))/iu;
const TASK_QUEUE_LEGACY_MANUAL_DECOMPOSITION_PATTERN =
    /\bmanual\s+(operator|agent)(?:-requested)?\s+decomposition\b/iu;
export const SPLIT_REQUIRED_STATUS = 'SPLIT_REQUIRED';
const PLACEHOLDER_CHILD_ORDINAL_PATTERN = '(?:#?\\d+(?:st|nd|rd|th)?|one|two|three|four|five|six|seven|eight|nine|ten|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)';
const PLACEHOLDER_CHILD_TITLE_PATTERN = new RegExp(
    `^(?:(?:tbd|todo|placeholder)(?:\\b.*)?|child(?:\\s+(?:task\\s+)?${PLACEHOLDER_CHILD_ORDINAL_PATTERN})?|${PLACEHOLDER_CHILD_ORDINAL_PATTERN}\\s+child(?:\\s+task)?)$`,
    'iu'
);

function isLegacySplitParentTask(entry: TaskQueueEntry | null): boolean {
    if (!entry) {
        return false;
    }
    if (!isTaskQueueBlockedStatus(entry.status)) {
        return false;
    }
    return TASK_QUEUE_LEGACY_SPLIT_NOTE_PATTERN.test(String(entry.notes || ''));
}

function isValidDecompositionRecordedOn(value: string): boolean {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
    if (!match) {
        return false;
    }
    const date = new Date(Date.UTC(
        Number(match[1]),
        Number(match[2]) - 1,
        Number(match[3])
    ));
    return date.getUTCFullYear() === Number(match[1])
        && date.getUTCMonth() === Number(match[2]) - 1
        && date.getUTCDate() === Number(match[3]);
}

export function readDecomposedTaskProvenance(notes: string | null): DecomposedTaskProvenance {
    const text = String(notes || '');
    const structuredMatch = TASK_QUEUE_DECOMPOSITION_SOURCE_PATTERN.exec(text);
    const recordedOn = structuredMatch?.[2];
    if (structuredMatch) {
        if (recordedOn !== undefined && !isValidDecompositionRecordedOn(recordedOn)) {
            return {
                source: 'unrecorded',
                evidence: 'none'
            };
        }
        return {
            source: structuredMatch[1].toLowerCase() as DecomposedTaskProvenanceSource,
            evidence: 'structured-note'
        };
    }
    const legacyManualMatch = TASK_QUEUE_LEGACY_MANUAL_DECOMPOSITION_PATTERN.exec(text);
    if (legacyManualMatch) {
        return {
            source: legacyManualMatch[1].toLowerCase() === 'operator'
                ? 'manual-operator'
                : 'manual-agent',
            evidence: 'legacy-manual-note'
        };
    }
    return {
        source: 'unrecorded',
        evidence: 'none'
    };
}

function hasValidDecompositionChildSetForProvenance(notes: string | null, childTaskIds: readonly string[]): boolean {
    const text = String(notes || '');
    if (!TASK_QUEUE_DECOMPOSITION_SOURCE_CLAIM_PATTERN.test(text)) {
        return true;
    }
    return readDecomposedTaskProvenance(text).evidence === 'structured-note'
        && childTaskIds.length >= 2;
}

export function describeDecomposedTaskProvenance(notes: string | null): string {
    const provenance = readDecomposedTaskProvenance(notes);
    if (provenance.source === 'manual-operator') {
        return 'TASK.md Notes record manual operator decomposition provenance; gate-owned decomposition artifacts are not required for this parent.';
    }
    if (provenance.source === 'manual-agent') {
        return 'TASK.md Notes record manual agent decomposition provenance; gate-owned decomposition artifacts are not required for this parent.';
    }
    if (provenance.source === 'orchestrator') {
        return 'TASK.md Notes record orchestrator-owned decomposition provenance.';
    }
    return 'TASK.md Notes do not record decomposition provenance; only explicit child links may be used and unrelated task IDs must not be inferred.';
}

export function isDecomposedParentTask(entry: TaskQueueEntry | null): boolean {
    return Boolean(entry && (isTaskQueueDecomposedStatus(entry.status) || isLegacySplitParentTask(entry)));
}

function appendTaskMentionIfMissing(taskMentions: ChildTaskIdMention[], taskId: string, index: number): void {
    if (!taskMentions.some((mention) => mention.taskId === taskId)) {
        taskMentions.push({ taskId, index });
    }
}

function isExplicitChildListMentionPosition(text: string, index: number): boolean {
    const introPattern = /\b(?:(?:child(?:ren)?|leaf)\s+tasks?|children|child\s+range|review\s+follow-up\s+tasks?\s+materialized)\b\s*:*/igu;
    let introMatch: RegExpExecArray | null;
    let introEnd: number | null = null;
    while ((introMatch = introPattern.exec(text)) !== null) {
        if (introMatch.index > index) {
            break;
        }
        introEnd = introMatch.index + introMatch[0].length;
    }
    if (introEnd == null) {
        return false;
    }
    const listPrefix = text.slice(introEnd, index);
    const firstTaskId = new RegExp(
        TASK_QUEUE_TASK_ID_REFERENCE_PATTERN.source,
        TASK_QUEUE_TASK_ID_REFERENCE_PATTERN.flags
    ).exec(listPrefix);
    const firstTaskIdIndex = firstTaskId
        ? firstTaskId.index + firstTaskId[1].length
        : listPrefix.length;
    if (!/^[\s,:()[\]`*_\-–—]*$/u.test(listPrefix.slice(0, firstTaskIdIndex))) {
        return false;
    }
    return /^[\s,:()[\]`*_\-–—]*(?:(?:and|or|through|to)[\s,:()[\]`*_\-–—]*)*$/iu.test(
        listPrefix.replace(TASK_QUEUE_TASK_ID_REFERENCE_PATTERN, '$1 ')
    );
}

function parseNumericTaskIdRangeEndpoint(taskId: string): NumericTaskIdRangeEndpoint | null {
    if (!TASK_QUEUE_TASK_ID_PATTERN.test(taskId)) {
        return null;
    }
    const match = /^(.*?)(\d+)$/u.exec(taskId);
    if (!match) {
        return null;
    }
    const prefix = match[1];
    const rawNumber = match[2];
    const value = BigInt(rawNumber);
    if (!prefix) {
        return null;
    }
    return {
        taskId,
        prefix,
        rawNumber,
        value
    };
}

export function formatDecomposedTaskProvenanceNote(options: {
    source: DecomposedTaskProvenanceSource;
    childTaskIds: readonly string[];
    recordedOn?: string | null;
}): string {
    if (!DECOMPOSED_TASK_PROVENANCE_SOURCES.includes(options.source)) {
        throw new Error(`Unsupported decomposition provenance source '${String(options.source)}'.`);
    }
    const normalizedChildTaskIds = options.childTaskIds.map((taskId) => String(taskId).trim());
    const invalidChildIndex = normalizedChildTaskIds.findIndex((taskId) => !isCanonicalTaskId(taskId));
    if (invalidChildIndex >= 0) {
        throw new Error(
            `Decomposition child task id at index ${invalidChildIndex} is not canonical: `
            + `'${normalizedChildTaskIds[invalidChildIndex]}'.`
        );
    }
    const childTaskIds = [...new Set(normalizedChildTaskIds)];
    if (childTaskIds.length < 2) {
        throw new Error('At least two distinct canonical child task ids are required for decomposition provenance.');
    }
    const endpoints = childTaskIds.map(parseNumericTaskIdRangeEndpoint);
    const firstEndpoint = endpoints[0];
    const allUnpadded = endpoints.every((endpoint) => Boolean(
        endpoint && endpoint.rawNumber === endpoint.value.toString()
    ));
    const fixedWidth = firstEndpoint?.rawNumber.length || 0;
    const allFixedWidth = fixedWidth > 0 && endpoints.every((endpoint) => Boolean(
        endpoint
        && endpoint.rawNumber.length === fixedWidth
        && endpoint.rawNumber === endpoint.value.toString().padStart(fixedWidth, '0')
    ));
    const isContiguousNumericRange = childTaskIds.length > 1
        && childTaskIds.length <= 101
        && Boolean(firstEndpoint)
        && (allUnpadded || allFixedWidth)
        && endpoints.every((endpoint, index) => Boolean(
            endpoint
            && endpoint.prefix === firstEndpoint!.prefix
            && endpoint.value === firstEndpoint!.value + BigInt(index)
        ));
    const recordedOn = String(options.recordedOn || '').trim();
    if (recordedOn && !isValidDecompositionRecordedOn(recordedOn)) {
        throw new Error(
            `Decomposition recordedOn must use a valid YYYY-MM-DD date: '${recordedOn}'.`
        );
    }
    const sourceClause = `Decomposition source: ${options.source}${recordedOn ? ` (${recordedOn})` : ''}`;
    const childClause = isContiguousNumericRange
        ? `child range \`${childTaskIds[0]}\` through \`${childTaskIds[childTaskIds.length - 1]}\``
        : `child tasks: ${childTaskIds.map((taskId) => `\`${taskId}\``).join(', ')}`;
    return `${sourceClause}; ${childClause}; execute sequentially.`;
}

function extractChildTaskMentions(notes: string | null, knownTaskIds: Iterable<string>): ChildTaskIdMention[] {
    const text = String(notes || '');
    const taskMentions: ChildTaskIdMention[] = [];
    const rangePattern =
        /(^|[^A-Za-z0-9._-])([A-Za-z0-9._-]*\d)(?=$|[^A-Za-z0-9._-])[\s`*_]*(?:through|to|-|–|—)[\s`*_]*([A-Za-z0-9._-]*\d)(?=$|[^A-Za-z0-9._-])/gu;
    let rangeMatch: RegExpExecArray | null;
    while ((rangeMatch = rangePattern.exec(text)) !== null) {
        const leadingBoundary = rangeMatch[1] || '';
        if (!isExplicitChildListMentionPosition(text, rangeMatch.index + leadingBoundary.length)) {
            continue;
        }
        const startEndpoint = parseNumericTaskIdRangeEndpoint(rangeMatch[2] || '');
        const endEndpoint = parseNumericTaskIdRangeEndpoint(rangeMatch[3] || '');
        if (!startEndpoint || !endEndpoint || startEndpoint.prefix !== endEndpoint.prefix) {
            continue;
        }
        const start = startEndpoint.value;
        const end = endEndpoint.value;
        const distance = start <= end ? end - start : start - end;
        if (distance > 100n) {
            continue;
        }
        const step = start <= end ? 1n : -1n;
        const width = startEndpoint.rawNumber.length === endEndpoint.rawNumber.length
            ? startEndpoint.rawNumber.length
            : 0;
        let offset = 0;
        for (let value = start; step > 0n ? value <= end : value >= end; value += step) {
            const valueText = width > 0 ? value.toString().padStart(width, '0') : value.toString();
            appendTaskMentionIfMissing(
                taskMentions,
                `${startEndpoint.prefix}${valueText}`,
                rangeMatch.index + leadingBoundary.length + offset
            );
            offset += 1;
        }
    }

    const backtickedTaskIdPattern = /`([^`]+)`/gu;
    let backtickedTaskIdMatch: RegExpExecArray | null;
    while ((backtickedTaskIdMatch = backtickedTaskIdPattern.exec(text)) !== null) {
        const taskId = String(backtickedTaskIdMatch[1] || '').trim();
        if (isCanonicalTaskId(taskId)
            && isExplicitChildListMentionPosition(text, backtickedTaskIdMatch.index)) {
            appendTaskMentionIfMissing(taskMentions, taskId, backtickedTaskIdMatch.index + 1);
        }
    }

    const conventionalTaskIdPattern = /(^|[^A-Za-z0-9._-])([Tt]-\d+)(?=$|[^A-Za-z0-9._-])/gu;
    let conventionalTaskIdMatch: RegExpExecArray | null;
    while ((conventionalTaskIdMatch = conventionalTaskIdPattern.exec(text)) !== null) {
        const taskId = conventionalTaskIdMatch[2];
        const mentionIndex = conventionalTaskIdMatch.index + conventionalTaskIdMatch[1].length;
        if (isExplicitChildListMentionPosition(text, mentionIndex)) {
            appendTaskMentionIfMissing(taskMentions, taskId, mentionIndex);
        }
    }

    const referencedTaskIdPattern = new RegExp(
        TASK_QUEUE_TASK_ID_REFERENCE_PATTERN.source,
        TASK_QUEUE_TASK_ID_REFERENCE_PATTERN.flags
    );
    let referencedTaskIdMatch: RegExpExecArray | null;
    while ((referencedTaskIdMatch = referencedTaskIdPattern.exec(text)) !== null) {
        const taskId = referencedTaskIdMatch[2];
        const mentionIndex = referencedTaskIdMatch.index + referencedTaskIdMatch[1].length;
        if (!isCanonicalTaskId(taskId) || /^[Tt]-\d+$/u.test(taskId)) {
            continue;
        }
        if (!isExplicitChildListMentionPosition(text, mentionIndex)) {
            continue;
        }
        appendTaskMentionIfMissing(taskMentions, taskId, mentionIndex);
    }

    for (const taskId of knownTaskIds) {
        const taskIdPattern = buildExactTaskIdReferencePattern(taskId);
        const taskIdMatch = taskIdPattern.exec(text);
        if (taskIdMatch) {
            const mentionIndex = taskIdMatch.index + taskIdMatch[1].length;
            if (!isExplicitChildListMentionPosition(text, mentionIndex)) {
                continue;
            }
            appendTaskMentionIfMissing(taskMentions, taskId, taskIdMatch.index + taskIdMatch[1].length);
        }
    }
    return taskMentions
        .sort((left, right) => left.index - right.index);
}

function isTaskIdCharacter(value: string): boolean {
    return !isTaskIdReferenceBoundary(value);
}

function isExplicitChildContinuationBoundary(text: string, index: number): boolean {
    return /^(?:,\s*)?then\s+continue\b/iu.test(text.slice(index));
}

function findExplicitChildSegmentEnd(text: string, startIndex: number): number {
    for (let index = startIndex; index < text.length; index += 1) {
        if (isExplicitChildContinuationBoundary(text, index)) {
            return index;
        }
        const current = text[index];
        if (current === ';' || current === '\n' || current === '|') {
            return index;
        }
        if (current === '.') {
            const previous = text[index - 1] || '';
            const next = text[index + 1] || '';
            if (!(isTaskIdCharacter(previous) && isTaskIdCharacter(next))) {
                return index;
            }
        }
    }
    return text.length;
}

function isParentDerivedReviewFollowUpTaskId(parentTaskId: string | null, childTaskId: string): boolean {
    if (!parentTaskId) {
        return false;
    }
    const prefix = `${parentTaskId}-F`;
    return childTaskId.toLowerCase().startsWith(prefix.toLowerCase())
        && /^[1-9]\d*$/u.test(childTaskId.slice(prefix.length));
}

export function extractExplicitLinkedChildTaskIds(
    notes: string | null,
    knownTaskIds: Iterable<string>,
    parentTaskId: string | null = null
): string[] {
    const text = String(notes || '');
    const childTaskIds: ChildTaskIdMention[] = [];
    const knownTaskIdList = [...knownTaskIds];
    let markerMatch: RegExpExecArray | null;
    TASK_QUEUE_CHILD_LINK_MARKER_PATTERN.lastIndex = 0;
    while ((markerMatch = TASK_QUEUE_CHILD_LINK_MARKER_PATTERN.exec(text)) !== null) {
        const absoluteSegmentEnd = findExplicitChildSegmentEnd(text, markerMatch.index);
        const segment = text.slice(markerMatch.index, absoluteSegmentEnd);
        const requiresParentDerivedFollowUp = TASK_QUEUE_REVIEW_FOLLOW_UP_LINK_MARKER_PATTERN.test(markerMatch[0]);
        for (const childMention of extractChildTaskMentions(segment, knownTaskIdList)) {
            if (requiresParentDerivedFollowUp
                && !isParentDerivedReviewFollowUpTaskId(parentTaskId, childMention.taskId)) {
                continue;
            }
            appendTaskMentionIfMissing(childTaskIds, childMention.taskId, markerMatch.index + childMention.index);
        }
    }
    return childTaskIds
        .sort((left, right) => left.index - right.index)
        .map((mention) => mention.taskId);
}

export function hasExplicitLinkedChildTasks(taskEntries: Map<string, TaskQueueEntry>, parentTaskId: string): boolean {
    return extractExplicitLinkedChildTaskIds(
        taskEntries.get(parentTaskId)?.notes || null, taskEntries.keys(), parentTaskId
    ).length > 0;
}

export function resolveNextUnfinishedChildRoute(
    taskEntries: Map<string, TaskQueueEntry>,
    parentTaskId: string,
    visited = new Set<string>(),
    childTaskIdExtractor: (
        notes: string | null,
        knownTaskIds: Iterable<string>,
        parentTaskId?: string
    ) => string[] = extractExplicitLinkedChildTaskIds
): DecomposedChildRoute | null {
    if (visited.has(parentTaskId)) {
        return null;
    }
    visited.add(parentTaskId);
    const parentEntry = taskEntries.get(parentTaskId);
    const childTaskIds = childTaskIdExtractor(parentEntry?.notes || null, taskEntries.keys(), parentTaskId)
        .filter((childTaskId) => (countNextStepWork('visit:next-step-task-queue:event:476'), childTaskId !== parentTaskId));
    if (!hasValidDecompositionChildSetForProvenance(parentEntry?.notes || null, childTaskIds)) {
        return null;
    }

    for (const childTaskId of childTaskIds) {
        const childEntry = taskEntries.get(childTaskId);
        if (!childEntry) {
            continue;
        }
        if (isTaskQueueDoneStatus(childEntry.status)) {
            continue;
        }
        if (isDecomposedParentTask(childEntry)) {
            const nestedRoute = resolveNextUnfinishedChildRoute(taskEntries, childTaskId, visited, childTaskIdExtractor);
            if (nestedRoute) {
                return {
                    ...nestedRoute,
                    chain: [childTaskId, ...nestedRoute.chain]
                };
            }
            continue;
        }
        return {
            taskId: childTaskId,
            status: childEntry.status,
            chain: [childTaskId]
        };
    }
    return null;
}

function mergeNestedDecomposedCompletionState(params: {
    childTaskId: string;
    nestedState: DecomposedParentCompletionState;
    completedDecomposedTaskIds: string[];
    missingChildTaskIds: string[];
    allowComplete: boolean;
}): DecomposedParentCompletionState | null {
    if (params.nestedState.unfinishedRoute) {
        return {
            hasLinkedChildren: true,
            complete: false,
            unfinishedRoute: {
                ...params.nestedState.unfinishedRoute,
                chain: [params.childTaskId, ...params.nestedState.unfinishedRoute.chain]
            },
            completedDecomposedTaskIds: params.completedDecomposedTaskIds,
            missingChildTaskIds: params.missingChildTaskIds
        };
    }
    if (params.nestedState.missingChildTaskIds.length > 0) {
        return {
            hasLinkedChildren: true,
            complete: false,
            unfinishedRoute: null,
            completedDecomposedTaskIds: params.completedDecomposedTaskIds,
            missingChildTaskIds: [...params.missingChildTaskIds, ...params.nestedState.missingChildTaskIds]
        };
    }
    if (params.allowComplete && params.nestedState.complete) {
        params.completedDecomposedTaskIds.push(...params.nestedState.completedDecomposedTaskIds, params.childTaskId);
        return null;
    }
    return {
        hasLinkedChildren: true,
        complete: false,
        unfinishedRoute: null,
        completedDecomposedTaskIds: params.completedDecomposedTaskIds,
        missingChildTaskIds: params.missingChildTaskIds
    };
}

export function resolveDecomposedParentCompletionState(
    taskEntries: Map<string, TaskQueueEntry>,
    parentTaskId: string,
    visited = new Set<string>(),
    childTaskIdExtractor: (
        notes: string | null,
        knownTaskIds: Iterable<string>,
        parentTaskId?: string
    ) => string[] = extractExplicitLinkedChildTaskIds
): DecomposedParentCompletionState {
    if (visited.has(parentTaskId)) {
        return {
            hasLinkedChildren: false,
            complete: false,
            unfinishedRoute: null,
            completedDecomposedTaskIds: [],
            missingChildTaskIds: []
        };
    }
    visited.add(parentTaskId);
    const parentEntry = taskEntries.get(parentTaskId);
    const childTaskIds = childTaskIdExtractor(parentEntry?.notes || null, taskEntries.keys(), parentTaskId)
        .filter((childTaskId) => (countNextStepWork('visit:next-step-task-queue:event:571'), childTaskId !== parentTaskId));

    if (childTaskIds.length === 0
        || !hasValidDecompositionChildSetForProvenance(parentEntry?.notes || null, childTaskIds)) {
        return {
            hasLinkedChildren: false,
            complete: false,
            unfinishedRoute: null,
            completedDecomposedTaskIds: [],
            missingChildTaskIds: []
        };
    }

    const completedDecomposedTaskIds: string[] = [];
    const missingChildTaskIds: string[] = [];
    for (const childTaskId of childTaskIds) {
        const childEntry = taskEntries.get(childTaskId);
        if (!childEntry) {
            missingChildTaskIds.push(childTaskId);
            continue;
        }
        const childLinkedTaskIds = childTaskIdExtractor(childEntry.notes || null, taskEntries.keys(), childTaskId)
            .filter((nestedChildTaskId) => (countNextStepWork('visit:next-step-task-queue:event:593'), nestedChildTaskId !== childTaskId));
        if (childLinkedTaskIds.length > 0 && (
            isTaskQueueDoneStatus(childEntry.status)
            || isTaskQueueDecomposedStatus(childEntry.status)
        )) {
            const nestedState = resolveDecomposedParentCompletionState(
                taskEntries,
                childTaskId,
                visited,
                childTaskIdExtractor
            );
            const mergedState = mergeNestedDecomposedCompletionState({
                childTaskId,
                nestedState,
                completedDecomposedTaskIds,
                missingChildTaskIds,
                allowComplete: true
            });
            if (!mergedState) {
                continue;
            }
            return mergedState;
        }
        if (isTaskQueueDoneStatus(childEntry.status)) {
            continue;
        }
        if (isTaskQueueDecomposedStatus(childEntry.status)) {
            const nestedState = resolveDecomposedParentCompletionState(
                taskEntries,
                childTaskId,
                visited,
                childTaskIdExtractor
            );
            const mergedState = mergeNestedDecomposedCompletionState({
                childTaskId,
                nestedState,
                completedDecomposedTaskIds,
                missingChildTaskIds,
                allowComplete: true
            });
            if (!mergedState) {
                continue;
            }
            return mergedState;
        }
        if (isLegacySplitParentTask(childEntry)) {
            const nestedState = resolveDecomposedParentCompletionState(
                taskEntries,
                childTaskId,
                visited,
                childTaskIdExtractor
            );
            const mergedState = mergeNestedDecomposedCompletionState({
                childTaskId,
                nestedState,
                completedDecomposedTaskIds,
                missingChildTaskIds,
                allowComplete: false
            });
            return mergedState || {
                hasLinkedChildren: true,
                complete: false,
                unfinishedRoute: null,
                completedDecomposedTaskIds,
                missingChildTaskIds
            };
        }
        return {
            hasLinkedChildren: true,
            complete: false,
            unfinishedRoute: {
                taskId: childTaskId,
                status: childEntry.status,
                chain: [childTaskId]
            },
            completedDecomposedTaskIds,
            missingChildTaskIds
        };
    }

    if (missingChildTaskIds.length > 0) {
        return {
            hasLinkedChildren: true,
            complete: false,
            unfinishedRoute: null,
            completedDecomposedTaskIds,
            missingChildTaskIds
        };
    }

    return {
        hasLinkedChildren: true,
        complete: true,
        unfinishedRoute: null,
        completedDecomposedTaskIds,
        missingChildTaskIds: []
    };
}

function normalizeChildScopePart(value: string | null): string {
    return String(value || '').trim().toLowerCase().replace(/\s+/gu, ' ');
}

function childSetQuality(taskEntries: Map<string, TaskQueueEntry>, childTaskIds: string[]): Omit<
    SplitRequiredDecompositionState,
    'ready' | 'linkedChildTaskIds' | 'missingChildTaskIds' | 'childRoute'
> {
    const terminalChildTaskIds: string[] = [];
    const placeholderChildTaskIds: string[] = [];
    const nonExecutableChildTaskIds: string[] = [];
    const scopeOwners = new Map<string, string[]>();
    for (const childTaskId of childTaskIds) {
        const child = taskEntries.get(childTaskId);
        if (!child) {
            continue;
        }
        if (isTaskQueueTerminalStatus(child.status)) {
            terminalChildTaskIds.push(childTaskId);
        }
        const status = readTaskQueueStatusToken(child.status);
        if (status !== 'TODO' && status !== 'IN_PROGRESS' && status !== 'IN_REVIEW') {
            nonExecutableChildTaskIds.push(childTaskId);
        }
        const area = normalizeChildScopePart(child.area);
        const title = normalizeChildScopePart(child.title);
        if (!area || !title || PLACEHOLDER_CHILD_TITLE_PATTERN.test(title)) {
            placeholderChildTaskIds.push(childTaskId);
        }
        const scopeKey = `${area}\0${title}`;
        const owners = scopeOwners.get(scopeKey) || [];
        owners.push(childTaskId);
        scopeOwners.set(scopeKey, owners);
    }
    const duplicateScopeChildTaskIds = [...scopeOwners.values()]
        .filter((owners) => owners.length > 1)
        .flat()
        .sort();
    return {
        terminalChildTaskIds,
        placeholderChildTaskIds,
        duplicateScopeChildTaskIds,
        nonExecutableChildTaskIds
    };
}

export function resolveSplitRequiredDecompositionState(
    taskEntries: Map<string, TaskQueueEntry>,
    parentTaskId: string
): SplitRequiredDecompositionState {
    const parentEntry = taskEntries.get(parentTaskId);
    const linkedChildTaskIds = extractExplicitLinkedChildTaskIds(
        parentEntry?.notes || null,
        taskEntries.keys(),
        parentTaskId
    )
        .filter((childTaskId) => (countNextStepWork('visit:next-step-task-queue:event:744'), childTaskId !== parentTaskId));
    const missingChildTaskIds = linkedChildTaskIds.filter((childTaskId) => !taskEntries.has(childTaskId));
    const quality = childSetQuality(taskEntries, linkedChildTaskIds);
    const ready = linkedChildTaskIds.length >= 2
        && missingChildTaskIds.length === 0
        && quality.terminalChildTaskIds.length === 0
        && quality.placeholderChildTaskIds.length === 0
        && quality.duplicateScopeChildTaskIds.length === 0
        && quality.nonExecutableChildTaskIds.length === 0;
    return {
        ready,
        linkedChildTaskIds,
        missingChildTaskIds,
        ...quality,
        childRoute: ready
            ? resolveNextUnfinishedChildRoute(taskEntries, parentTaskId, new Set<string>(), extractExplicitLinkedChildTaskIds)
            : null
    };
}

export function hasLinkedChildTasks(taskEntries: Map<string, TaskQueueEntry>, parentTaskId: string): boolean {
    return resolveSplitRequiredDecompositionState(taskEntries, parentTaskId).ready;
}

function isParentDerivedChildTaskId(parentTaskId: string, childTaskId: string): boolean {
    const normalizedParent = parentTaskId.toLowerCase();
    const normalizedChild = childTaskId.toLowerCase();
    return normalizedChild !== normalizedParent && normalizedChild.startsWith(`${normalizedParent}-`);
}

export function resolveStrictDecompositionSplitRoutingState(
    taskEntries: Map<string, TaskQueueEntry>,
    parentTaskId: string,
    proposedChildTaskIds: string[],
    expectedChildProfile = 'strict'
): StrictDecompositionSplitRoutingState {
    const parentEntry = taskEntries.get(parentTaskId);
    const linkedChildTaskIds = extractExplicitLinkedChildTaskIds(
        parentEntry?.notes || null,
        taskEntries.keys(),
        parentTaskId
    )
        .filter((childTaskId) => (countNextStepWork('visit:next-step-task-queue:event:786'), childTaskId !== parentTaskId));
    const linkedChildTaskIdSet = new Set(linkedChildTaskIds);
    const proposedChildTaskIdSet = new Set(proposedChildTaskIds);
    const nonParentDerivedChildTaskIds = [...new Set([...proposedChildTaskIds, ...linkedChildTaskIds])]
        .filter((childTaskId) => !isParentDerivedChildTaskId(parentTaskId, childTaskId));
    const unexpectedLinkedChildTaskIds = linkedChildTaskIds
        .filter((childTaskId) => isParentDerivedChildTaskId(parentTaskId, childTaskId) && !proposedChildTaskIdSet.has(childTaskId));
    const missingLinkedChildTaskIds = proposedChildTaskIds
        .filter((childTaskId) => !linkedChildTaskIdSet.has(childTaskId));
    const missingChildTaskIds = proposedChildTaskIds
        .filter((childTaskId) => !taskEntries.has(childTaskId));
    const nonStrictChildTaskIds = proposedChildTaskIds
        .filter((childTaskId) => {
            const childEntry = taskEntries.get(childTaskId);
            return childEntry && String(childEntry.profile || '').trim().toLowerCase() !== expectedChildProfile;
        });
    // Strict routing shares the complete child-quality contract with generic split-required routing.
    const quality = childSetQuality(taskEntries, proposedChildTaskIds);

    const ready = proposedChildTaskIds.length >= 2
        && missingLinkedChildTaskIds.length === 0
        && missingChildTaskIds.length === 0
        && nonParentDerivedChildTaskIds.length === 0
        && unexpectedLinkedChildTaskIds.length === 0
        && nonStrictChildTaskIds.length === 0
        && quality.terminalChildTaskIds.length === 0
        && quality.placeholderChildTaskIds.length === 0
        && quality.duplicateScopeChildTaskIds.length === 0
        && quality.nonExecutableChildTaskIds.length === 0;

    return {
        ready,
        linkedChildTaskIds,
        missingLinkedChildTaskIds,
        expectedChildProfile,
        missingChildTaskIds,
        nonParentDerivedChildTaskIds,
        unexpectedLinkedChildTaskIds,
        nonStrictChildTaskIds,
        ...quality,
        childRoute: ready
            ? resolveNextUnfinishedChildRoute(taskEntries, parentTaskId, new Set<string>(), extractExplicitLinkedChildTaskIds)
            : null
    };
}

export function formatStrictDecompositionSplitRoutingViolations(state: StrictDecompositionSplitRoutingState): string {
    const violations: string[] = [];
    if (state.linkedChildTaskIds.length < 2) {
        violations.push('at least two meaningful child tasks are required');
    }
    if (state.missingLinkedChildTaskIds.length > 0) {
        violations.push(`missing linked proposed child tasks: ${state.missingLinkedChildTaskIds.join(', ')}`);
    }
    if (state.missingChildTaskIds.length > 0) {
        violations.push(`missing TASK.md child rows: ${state.missingChildTaskIds.join(', ')}`);
    }
    if (state.nonParentDerivedChildTaskIds.length > 0) {
        violations.push(`non-parent-derived child task ids: ${state.nonParentDerivedChildTaskIds.join(', ')}`);
    }
    if (state.unexpectedLinkedChildTaskIds.length > 0) {
        violations.push(`linked child tasks not declared in the decision artifact: ${state.unexpectedLinkedChildTaskIds.join(', ')}`);
    }
    if (state.nonStrictChildTaskIds.length > 0) {
        violations.push(`child tasks without ${state.expectedChildProfile} profile: ${state.nonStrictChildTaskIds.join(', ')}`);
    }
    if (state.terminalChildTaskIds.length > 0) {
        violations.push(`terminal child tasks cannot establish a new split: ${state.terminalChildTaskIds.join(', ')}`);
    }
    if (state.placeholderChildTaskIds.length > 0) {
        violations.push(`placeholder child tasks are not meaningful work packages: ${state.placeholderChildTaskIds.join(', ')}`);
    }
    if (state.duplicateScopeChildTaskIds.length > 0) {
        violations.push(`duplicate child work-package scopes: ${state.duplicateScopeChildTaskIds.join(', ')}`);
    }
    if (violations.length === 0) {
        return 'child routing is not ready';
    }
    return violations.join('; ');
}
