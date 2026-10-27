import { countNextStepWork } from '../../core/next-step-measurement';
import { createInvocationReadMemoKey, isInvocationReadObservationActive, memoizeInvocationRead } from '../../core/invocation-read-observation';
import { captureTaskTimelineReadSnapshotSha256 } from './task-timeline-read-snapshot';

export type ValidationQueryEvent = Readonly<Record<string, unknown>>;
export interface LatestTimelineRecord { readonly event: ValidationQueryEvent; readonly ordinal: number }
export interface ValidationEventMultiplicity { count: number; first: LatestTimelineRecord | null; last: LatestTimelineRecord | null }
export interface ValidationAttemptMultiplicity {
    started: ValidationEventMultiplicity; completed: ValidationEventMultiplicity; evaluated: ValidationEventMultiplicity;
}
const attemptLookups = new WeakMap<object, ReadonlyMap<string, ValidationAttemptMultiplicity>>();
const queryBindings = new WeakMap<object, WeakMap<object, { path: string; sha256: string }>>();
const QUERY_INVOCATION = createInvocationReadMemoKey<object>('validation-query-invocation');
function currentInvocation(): object | null {
    return isInvocationReadObservationActive() ? memoizeInvocationRead(QUERY_INVOCATION, '', () => Object.freeze({})).value : null;
}
function multiplicity(): ValidationEventMultiplicity { return { count: 0, first: null, last: null }; }
export interface ValidationTimelineQuery {
    readonly eventCount: number;
    readonly modeIndex: number;
    readonly modeEvent: ValidationQueryEvent | null;
    readonly preflightFailedIndex: number;
    readonly preflightStartedIndex: number;
    readonly classifiedIndex: number;
    readonly classifiedEvent: ValidationQueryEvent | null;
    readonly completionCount: number;
    readonly firstCompletion: ValidationQueryEvent | null;
    readonly latestQuality: LatestTimelineRecord | null;
    readonly latestTaskMode: LatestTimelineRecord | null;
    readonly qualityNormalizationFailed: boolean;
    readonly taskModeNormalizationFailed: boolean;
    readonly recipeQueryCompatible: boolean;
    readonly recipeAttemptsAfterMode: Readonly<Record<string, ValidationQueryEvent>>;
    readonly recipeAttemptsAfterClassification: Readonly<Record<string, ValidationQueryEvent>>;
    readonly attemptLookup: Readonly<{ version: 1 }>;
}

/** Private verifier map lookup: never enumerates or copies closed history. */
export function readValidationAttemptMultiplicity(query: ValidationTimelineQuery, attemptId: string): ValidationAttemptMultiplicity | null {
    const lookup = attemptLookups.get(query.attemptLookup);
    const invocation = currentInvocation();
    const binding = invocation ? queryBindings.get(query.attemptLookup)?.get(invocation) : undefined;
    if (!lookup || !binding) return null;
    try { if (captureTaskTimelineReadSnapshotSha256(binding.path) !== binding.sha256) return null; }
    catch { return null; }
    countNextStepWork('validation_attempt_multiplicity_lookup');
    const found = lookup.get(attemptId);
    const copy = (entry: ValidationEventMultiplicity): ValidationEventMultiplicity => ({ count: entry.count,
        first: entry.first ? { ...entry.first } : null, last: entry.last ? { ...entry.last } : null });
    return found ? { started: copy(found.started), completed: copy(found.completed), evaluated: copy(found.evaluated) }
        : { started: multiplicity(), completed: multiplicity(), evaluated: multiplicity() };
}

/** Bind only the original verifier-owned capability, never a copied/decoded token. */
export function bindValidationTimelineQuery(query: ValidationTimelineQuery, path: string, sha256: string): void {
    const invocation = currentInvocation();
    if (!invocation || !attemptLookups.has(query.attemptLookup)) return;
    let bindings = queryBindings.get(query.attemptLookup);
    if (!bindings) { bindings = new WeakMap(); queryBindings.set(query.attemptLookup, bindings); }
    if (!bindings.has(invocation)) bindings.set(invocation, { path, sha256 });
}

interface RecipeScope {
    starts: Map<string, string>;
    latest: Map<string, ValidationQueryEvent>;
}
function scope(): RecipeScope { return { starts: new Map(), latest: new Map() }; }
function attemptKey(value: unknown): string | null {
    if (value !== null && typeof value === 'object') return null;
    return typeof value + ':' + String(value);
}
function details(event: ValidationQueryEvent): Record<string, unknown> | null {
    const value = event.details;
    return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}

/** Fed once per already parsed entry inside mandatory canonical verification. */
export function beginValidationTimelineQueryPass(): {
    accept(record: ValidationQueryEvent | null, ordinal: number): void;
    finish(authenticated: boolean): ValidationTimelineQuery | null;
} {
    let eventCount = 0, modeIndex = -1, classifiedIndex = -1, completionCount = 0;
    let modeEvent: ValidationQueryEvent | null = null;
    let preflightFailedIndex = -1, preflightStartedIndex = -1;
    let classifiedEvent: ValidationQueryEvent | null = null, firstCompletion: ValidationQueryEvent | null = null;
    let latestQuality: LatestTimelineRecord | null = null, latestTaskMode: LatestTimelineRecord | null = null;
    let qualityNormalizationFailed = false, taskModeNormalizationFailed = false, recipeQueryCompatible = true;
    let afterMode = scope(), afterClassification = scope();
    const attempts = new Map<string, ValidationAttemptMultiplicity>();
    let closed = false;
    function acceptRecipe(target: RecipeScope, record: ValidationQueryEvent): void {
        const type = record.event_type;
        if (!['PROJECT_VALIDATION_STARTED', 'PROJECT_VALIDATION_COMPLETED', 'PROJECT_VALIDATION_RESULTS_EVALUATED'].includes(type as string)) return;
        countNextStepWork('validation_projection_recipe_head_update');
        const body = details(record), attempt = attemptKey(body?.attempt_id);
        if (attempt === null) { recipeQueryCompatible = false; return; }
        if (typeof body?.recipe_id !== 'string') return;
        const key = JSON.stringify([body.recipe_id, attempt]);
        target.latest.set(key, record);
        if (type === 'PROJECT_VALIDATION_STARTED') target.starts.set(body.recipe_id, key);
    }
    function compact(target: RecipeScope): Readonly<Record<string, ValidationQueryEvent>> {
        const result: Record<string, ValidationQueryEvent> = Object.create(null) as Record<string, ValidationQueryEvent>;
        for (const [recipe, key] of target.starts) {
            countNextStepWork('visit:validation_projection_recipe_head');
            const event = target.latest.get(key);
            if (event) Object.defineProperty(result, recipe, { enumerable: true, value: event });
        }
        return Object.freeze(result);
    }
    return {
        accept(record, ordinal) {
            if (closed) throw new Error('Validation timeline collector is already sealed.');
            eventCount++;
            if (!record) return;
            const type = record.event_type;
            const attemptId = details(record)?.attempt_id;
            const phase = type === 'PROJECT_VALIDATION_STARTED' ? 'started'
                : type === 'PROJECT_VALIDATION_COMPLETED' ? 'completed'
                    : type === 'PROJECT_VALIDATION_RESULTS_EVALUATED' ? 'evaluated' : null;
            if (phase && typeof attemptId === 'string') {
                let entry = attempts.get(attemptId);
                if (!entry) { entry = { started: multiplicity(), completed: multiplicity(), evaluated: multiplicity() }; attempts.set(attemptId, entry); }
                const occurrence = { event: record, ordinal };
                entry[phase].count++; entry[phase].first ??= occurrence; entry[phase].last = occurrence;
            }
            if (type === 'TASK_MODE_ENTERED') { modeIndex = ordinal; modeEvent = record; afterMode = scope(); afterClassification = scope(); completionCount = 0; firstCompletion = null; }
            if (type === 'PREFLIGHT_CLASSIFIED') { classifiedIndex = ordinal; classifiedEvent = record; afterClassification = scope(); completionCount = 0; firstCompletion = null; }
            if (type === 'PREFLIGHT_FAILED') preflightFailedIndex = ordinal;
            if (type === 'PREFLIGHT_STARTED') preflightStartedIndex = ordinal;
            if (type === 'COMPLETION_GATE_PASSED') { completionCount++; firstCompletion ??= record; }
            acceptRecipe(afterMode, record); acceptRecipe(afterClassification, record);
            try {
                const normalized = String(type || '').trim().toUpperCase();
                if (normalized === 'QUALITY_CHECKLIST_RECORDED') latestQuality = { event: record, ordinal };
                if (normalized === 'TASK_MODE_ENTERED') latestTaskMode = { event: record, ordinal };
            } catch {
                // Existing quality scanning aborts; task-mode reverse scanning skips
                // coercion failures. Both consumers retain their original fallback.
                qualityNormalizationFailed = true; taskModeNormalizationFailed = true;
            }
        },
        finish(authenticated) {
            if (closed) throw new Error('Validation timeline collector is already sealed.');
            closed = true;
            if (!authenticated) return null;
            const attemptLookup = Object.freeze({ version: 1 as const });
            attemptLookups.set(attemptLookup, attempts);
            return Object.freeze({ eventCount, modeIndex, modeEvent, preflightFailedIndex, preflightStartedIndex,
                classifiedIndex, classifiedEvent, completionCount, firstCompletion,
                latestQuality, latestTaskMode, qualityNormalizationFailed, taskModeNormalizationFailed, recipeQueryCompatible,
                recipeAttemptsAfterMode: compact(afterMode), recipeAttemptsAfterClassification: compact(afterClassification), attemptLookup });
        }
    };
}
