import { createHash } from 'node:crypto';

import {
    LEGACY_REVIEW_EXECUTION_POLICY_MODE,
    REVIEW_EXECUTION_POLICY_MODES,
    getReviewExecutionDependencies,
    getReviewExecutionPreparationOrder,
    type EffectiveReviewExecutionPolicyMode
} from './review-execution-policy';
import {
    FULL_SUITE_VALIDATION_PLACEMENTS,
    type FullSuiteValidationPlacement
} from './workflow-config';

export const REVIEW_DEPENDENCY_GRAPH_SCHEMA_VERSION = 1 as const;
export const REVIEW_DEPENDENCY_GRAPH_MAX_NODES = 64;
export const REVIEW_DEPENDENCY_GRAPH_MAX_EDGES = 256;

const REVIEW_ID_PATTERN = /^[a-z][a-z0-9-]*$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export interface ReviewDependencyGraphDeclaration {
    preparation_order: readonly string[];
    dependencies: Readonly<Record<string, readonly string[]>>;
}

export interface ReviewDependencyGraphFullSuiteBarrier {
    enabled: boolean;
    placement: FullSuiteValidationPlacement;
    before_review_ids: readonly string[];
}

export interface CompiledReviewDependencyGraph {
    schema_version: typeof REVIEW_DEPENDENCY_GRAPH_SCHEMA_VERSION;
    source: 'compatibility_mode' | 'profile';
    mode: EffectiveReviewExecutionPolicyMode;
    nodes: readonly string[];
    preparation_order: readonly string[];
    dependencies: Readonly<Record<string, readonly string[]>>;
    preparation_batches: readonly (readonly string[])[];
    full_suite_barrier: ReviewDependencyGraphFullSuiteBarrier;
    graph_sha256: string;
}

export interface CompileReviewDependencyGraphOptions {
    catalogLaneIds: readonly string[];
    activeLaneIds: readonly string[];
    requiredReviewIds: readonly string[];
    mode: EffectiveReviewExecutionPolicyMode;
    declaration?: ReviewDependencyGraphDeclaration | null;
    fullSuiteValidation?: {
        enabled: boolean;
        placement: FullSuiteValidationPlacement;
    };
}

export interface ReviewDependencyReachability {
    seed_review_ids: readonly string[];
    affected_review_ids: readonly string[];
}

export interface ReviewDependencyTimelineEventLike {
    event_type: string;
    sequence: number;
    details?: Record<string, unknown> | null;
}

export type ReviewDependencyTimelineOrderViolationCode =
    | 'missing_upstream_record'
    | 'unaccepted_upstream_record'
    | 'stale_upstream_record'
    | 'downstream_started_early';

export interface ReviewDependencyTimelineOrderViolation {
    code: ReviewDependencyTimelineOrderViolationCode;
    downstream_review_id: string;
    upstream_review_id: string;
    downstream_phase_sequence: number;
    upstream_record_sequence: number | null;
}

export function bindFullSuiteValidationBarrier<
    T extends { enabled: boolean; placement: FullSuiteValidationPlacement }
>(
    config: T,
    dependencyGraph?: CompiledReviewDependencyGraph | null
): T {
    if (!dependencyGraph) {
        return config;
    }
    return {
        ...config,
        enabled: dependencyGraph.full_suite_barrier.enabled,
        placement: dependencyGraph.full_suite_barrier.placement
    };
}

/**
 * Expands changed review lanes through the immutable dependency DAG.
 * Dependencies point from a downstream lane to its direct upstream lanes, so
 * invalidation walks the reverse edge direction and returns graph-order output.
 */
export function resolveReviewDependencyDownstreamReachability(
    dependencyGraph: CompiledReviewDependencyGraph,
    seedReviewIds: readonly string[]
): ReviewDependencyReachability {
    const graphViolations = getCompiledReviewDependencyGraphViolations(dependencyGraph);
    if (graphViolations.length > 0) {
        throw new Error(`Cannot resolve review dependency reachability from an invalid graph: ${graphViolations.join('; ')}`);
    }
    const graphNodes = new Set(dependencyGraph.preparation_order);
    const normalizedSeeds = [...new Set(seedReviewIds.map((reviewId) => String(reviewId || '').trim().toLowerCase()))];
    const unknownSeeds = normalizedSeeds.filter((reviewId) => !graphNodes.has(reviewId));
    if (unknownSeeds.length > 0) {
        throw new Error(
            `Cannot resolve review dependency reachability for lanes missing from the frozen graph: ${unknownSeeds.join(', ')}.`
        );
    }

    const affected = new Set(normalizedSeeds);
    let changed = true;
    while (changed) {
        changed = false;
        for (const reviewId of dependencyGraph.preparation_order) {
            if (affected.has(reviewId)) {
                continue;
            }
            if ((dependencyGraph.dependencies[reviewId] || []).some((dependency) => affected.has(dependency))) {
                affected.add(reviewId);
                changed = true;
            }
        }
    }
    return Object.freeze({
        seed_review_ids: Object.freeze(dependencyGraph.preparation_order.filter((reviewId) => normalizedSeeds.includes(reviewId))),
        affected_review_ids: Object.freeze(dependencyGraph.preparation_order.filter((reviewId) => affected.has(reviewId)))
    });
}

function normalizeTimelineReviewId(event: ReviewDependencyTimelineEventLike): string {
    return String(event.details?.review_type ?? event.details?.reviewType ?? '').trim().toLowerCase();
}

function findLatestTimelineEventLike(
    events: readonly ReviewDependencyTimelineEventLike[],
    predicate: (event: ReviewDependencyTimelineEventLike) => boolean
): ReviewDependencyTimelineEventLike | null {
    let latest: ReviewDependencyTimelineEventLike | null = null;
    for (const event of events) {
        if (predicate(event) && (latest == null || event.sequence > latest.sequence)) {
            latest = event;
        }
    }
    return latest;
}

export function isAcceptedReviewTimelineRecord(event: ReviewDependencyTimelineEventLike): boolean {
    const details = event.details;
    const validation = isPlainRecord(details?.review_findings_validation)
        ? details.review_findings_validation
        : null;
    if (validation?.accepted === false) {
        return false;
    }
    const coverage = isPlainRecord(details?.review_coverage)
        ? details.review_coverage
        : null;
    const coverageStatus = String(coverage?.status ?? '').trim().toUpperCase();
    if (coverageStatus !== '' && coverageStatus !== 'PASS') {
        return false;
    }

    const disposition = isPlainRecord(details?.review_findings_disposition)
        ? details.review_findings_disposition
        : null;
    if (disposition) {
        const blockingCount = Number(disposition.blocking_count);
        if (Number.isInteger(blockingCount) && blockingCount >= 0) {
            return blockingCount === 0;
        }
        const verdict = String(disposition.verdict ?? '').trim().toLowerCase();
        if (verdict !== '') {
            return !verdict.includes('fail');
        }
        return false;
    }

    // Older task timelines and compact fixtures predate findings disposition.
    // Preserve compatibility unless they carry explicit negative evidence.
    const explicitVerdict = String(
        details?.review_verdict ?? details?.verdict_token ?? details?.verdict ?? ''
    ).trim().toLowerCase();
    return explicitVerdict === '' || !explicitVerdict.includes('fail');
}

/**
 * Validates launch-time ordering against the same frozen DAG used by launch
 * routing. It deliberately does not replace receipt, scope, or provenance
 * checks; consumers add those independent trust checks separately.
 */
export function getReviewDependencyTimelineOrderViolations(
    dependencyGraph: CompiledReviewDependencyGraph,
    events: readonly ReviewDependencyTimelineEventLike[]
): ReviewDependencyTimelineOrderViolation[] {
    const graphViolations = getCompiledReviewDependencyGraphViolations(dependencyGraph);
    if (graphViolations.length > 0) {
        throw new Error(`Cannot validate review dependency timeline order from an invalid graph: ${graphViolations.join('; ')}`);
    }
    const latestCompileSequence = findLatestTimelineEventLike(
        events,
        (event) => event.event_type === 'COMPILE_GATE_PASSED'
    )?.sequence ?? null;
    const latestReviewCycleRestartSequence = findLatestTimelineEventLike(
        events,
        (event) => event.event_type === 'REVIEW_CYCLE_RESTARTED'
    )?.sequence ?? null;
    const timelineOrderFloorSequence = Math.max(
        latestCompileSequence ?? Number.NEGATIVE_INFINITY,
        latestReviewCycleRestartSequence ?? Number.NEGATIVE_INFINITY
    );
    const typedReviewPhasesPresent = events.some((event) => (
        event.event_type === 'REVIEW_PHASE_STARTED' && normalizeTimelineReviewId(event) !== ''
    ));
    const latestUntypedReviewPhase = typedReviewPhasesPresent
        ? null
        : findLatestTimelineEventLike(events, (event) => event.event_type === 'REVIEW_PHASE_STARTED');
    const violations: ReviewDependencyTimelineOrderViolation[] = [];

    for (const downstreamReviewId of dependencyGraph.preparation_order) {
        const typedDownstreamPhases = events.filter((event) => (
            event.event_type === 'REVIEW_PHASE_STARTED'
            && normalizeTimelineReviewId(event) === downstreamReviewId
            && event.sequence >= timelineOrderFloorSequence
        ));
        const downstreamPhases = typedDownstreamPhases.length > 0
            ? typedDownstreamPhases
            : latestUntypedReviewPhase
                && latestUntypedReviewPhase.sequence >= timelineOrderFloorSequence
                ? [latestUntypedReviewPhase]
                : [];
        if (downstreamPhases.length === 0) {
            continue;
        }
        for (const downstreamPhase of downstreamPhases) {
            for (const upstreamReviewId of dependencyGraph.dependencies[downstreamReviewId] || []) {
                const upstreamRecord = findLatestTimelineEventLike(events, (event) => (
                    event.event_type === 'REVIEW_RECORDED'
                    && normalizeTimelineReviewId(event) === upstreamReviewId
                ));
                if (!upstreamRecord) {
                    violations.push({
                        code: 'missing_upstream_record',
                        downstream_review_id: downstreamReviewId,
                        upstream_review_id: upstreamReviewId,
                        downstream_phase_sequence: downstreamPhase.sequence,
                        upstream_record_sequence: null
                    });
                    continue;
                }
                if (!isAcceptedReviewTimelineRecord(upstreamRecord)) {
                    violations.push({
                        code: 'unaccepted_upstream_record',
                        downstream_review_id: downstreamReviewId,
                        upstream_review_id: upstreamReviewId,
                        downstream_phase_sequence: downstreamPhase.sequence,
                        upstream_record_sequence: upstreamRecord.sequence
                    });
                    continue;
                }
                if (latestCompileSequence != null && upstreamRecord.sequence < latestCompileSequence) {
                    violations.push({
                        code: 'stale_upstream_record',
                        downstream_review_id: downstreamReviewId,
                        upstream_review_id: upstreamReviewId,
                        downstream_phase_sequence: downstreamPhase.sequence,
                        upstream_record_sequence: upstreamRecord.sequence
                    });
                    continue;
                }
                const validReuseRebind = upstreamRecord.details?.reused_existing_review === true
                    && events.some((event) => (
                        event.sequence < downstreamPhase.sequence
                        && event.sequence >= timelineOrderFloorSequence
                        && event.event_type === 'REVIEW_RECORDED'
                        && normalizeTimelineReviewId(event) === upstreamReviewId
                        && isAcceptedReviewTimelineRecord(event)
                    ));
                if (upstreamRecord.sequence > downstreamPhase.sequence && !validReuseRebind) {
                    violations.push({
                        code: 'downstream_started_early',
                        downstream_review_id: downstreamReviewId,
                        upstream_review_id: upstreamReviewId,
                        downstream_phase_sequence: downstreamPhase.sequence,
                        upstream_record_sequence: upstreamRecord.sequence
                    });
                }
            }
        }
    }
    return violations;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function canonicalize(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(canonicalize);
    }
    if (value && typeof value === 'object') {
        return Object.keys(value as Record<string, unknown>).sort().reduce<Record<string, unknown>>((result, key) => {
            result[key] = canonicalize((value as Record<string, unknown>)[key]);
            return result;
        }, {});
    }
    return value;
}

function sha256(value: unknown): string {
    return createHash('sha256').update(JSON.stringify(canonicalize(value)), 'utf8').digest('hex');
}

function assertReviewId(value: unknown, fieldName: string): string {
    if (typeof value !== 'string' || !REVIEW_ID_PATTERN.test(value)) {
        throw new Error(`${fieldName} must be a stable lowercase review lane id.`);
    }
    if (value === 'full-suite-validation') {
        throw new Error(`${fieldName} cannot use the gate-owned 'full-suite-validation' barrier as a review lane.`);
    }
    return value;
}

function assertUniqueIds(values: readonly string[], fieldName: string): void {
    const seen = new Set<string>();
    for (const value of values) {
        if (seen.has(value)) {
            throw new Error(`${fieldName} contains duplicate review lane '${value}'.`);
        }
        seen.add(value);
    }
}

function assertNoCycle(declaration: ReviewDependencyGraphDeclaration): void {
    const state = new Map<string, 'visiting' | 'visited'>();
    const visit = (reviewId: string, path: readonly string[]): void => {
        const current = state.get(reviewId);
        if (current === 'visiting') {
            const cycleStart = path.indexOf(reviewId);
            const cycle = [...path.slice(Math.max(0, cycleStart)), reviewId];
            throw new Error(`review_dependency_graph contains a cycle: ${cycle.join(' -> ')}.`);
        }
        if (current === 'visited') {
            return;
        }
        state.set(reviewId, 'visiting');
        for (const dependency of declaration.dependencies[reviewId] || []) {
            visit(dependency, [...path, reviewId]);
        }
        state.set(reviewId, 'visited');
    };
    for (const reviewId of declaration.preparation_order) {
        visit(reviewId, []);
    }
}

export function normalizeReviewDependencyGraphDeclaration(
    value: unknown,
    fieldName = 'review_dependency_graph'
): ReviewDependencyGraphDeclaration {
    if (!isPlainRecord(value)) {
        throw new Error(`${fieldName} must be a JSON object.`);
    }
    const allowedKeys = new Set(['preparation_order', 'dependencies']);
    for (const key of Object.keys(value)) {
        if (!allowedKeys.has(key)) {
            throw new Error(`${fieldName}.${key} is not allowed.`);
        }
    }
    if (!Array.isArray(value.preparation_order)) {
        throw new Error(`${fieldName}.preparation_order must be an array.`);
    }
    if (!isPlainRecord(value.dependencies)) {
        throw new Error(`${fieldName}.dependencies must be a JSON object.`);
    }
    if (value.preparation_order.length > REVIEW_DEPENDENCY_GRAPH_MAX_NODES) {
        throw new Error(`${fieldName}.preparation_order exceeds the ${REVIEW_DEPENDENCY_GRAPH_MAX_NODES}-lane limit.`);
    }

    const preparationOrder = value.preparation_order.map((entry, index) => (
        assertReviewId(entry, `${fieldName}.preparation_order[${index}]`)
    ));
    assertUniqueIds(preparationOrder, `${fieldName}.preparation_order`);
    const declaredNodes = new Set(preparationOrder);
    const dependencies: Record<string, readonly string[]> = {};
    let edgeCount = 0;
    for (const [rawReviewId, rawDependencies] of Object.entries(value.dependencies)) {
        const reviewId = assertReviewId(rawReviewId, `${fieldName}.dependencies key`);
        if (!declaredNodes.has(reviewId)) {
            throw new Error(`${fieldName}.dependencies.${reviewId} is missing from preparation_order.`);
        }
        if (!Array.isArray(rawDependencies)) {
            throw new Error(`${fieldName}.dependencies.${reviewId} must be an array.`);
        }
        const normalizedDependencies = rawDependencies.map((entry, index) => (
            assertReviewId(entry, `${fieldName}.dependencies.${reviewId}[${index}]`)
        ));
        assertUniqueIds(normalizedDependencies, `${fieldName}.dependencies.${reviewId}`);
        for (const dependency of normalizedDependencies) {
            if (dependency === reviewId) {
                throw new Error(`${fieldName} contains a self-edge for review lane '${reviewId}'.`);
            }
            if (!declaredNodes.has(dependency)) {
                throw new Error(
                    `${fieldName}.dependencies.${reviewId} references '${dependency}', which is missing from preparation_order.`
                );
            }
        }
        edgeCount += normalizedDependencies.length;
        dependencies[reviewId] = Object.freeze([...normalizedDependencies]);
    }
    if (edgeCount > REVIEW_DEPENDENCY_GRAPH_MAX_EDGES) {
        throw new Error(`${fieldName} exceeds the ${REVIEW_DEPENDENCY_GRAPH_MAX_EDGES}-edge limit.`);
    }

    const normalized = {
        preparation_order: Object.freeze([...preparationOrder]),
        dependencies: Object.freeze(dependencies)
    } satisfies ReviewDependencyGraphDeclaration;
    assertNoCycle(normalized);

    const rank = new Map(preparationOrder.map((reviewId, index) => [reviewId, index]));
    for (const [reviewId, reviewDependencies] of Object.entries(dependencies)) {
        for (const dependency of reviewDependencies) {
            if ((rank.get(dependency) ?? -1) >= (rank.get(reviewId) ?? -1)) {
                throw new Error(
                    `${fieldName}.preparation_order is ambiguous or contradicts dependency '${dependency}' -> '${reviewId}'.`
                );
            }
        }
    }
    return normalized;
}

function buildCompatibilityPreparationOrder(
    activeLaneIds: readonly string[],
    catalogLaneIds: readonly string[],
    mode: EffectiveReviewExecutionPolicyMode
): string[] {
    const active = new Set(activeLaneIds);
    const ordered: string[] = [];
    for (const reviewId of getReviewExecutionPreparationOrder(mode)) {
        if (active.has(reviewId)) {
            ordered.push(reviewId);
        }
    }
    for (const reviewId of catalogLaneIds) {
        if (active.has(reviewId) && !ordered.includes(reviewId)) {
            ordered.push(reviewId);
        }
    }
    return ordered;
}

function buildPreparationBatches(
    preparationOrder: readonly string[],
    dependencies: Readonly<Record<string, readonly string[]>>
): string[][] {
    const remaining = new Set(preparationOrder);
    const batches: string[][] = [];
    while (remaining.size > 0) {
        const batch = preparationOrder.filter((reviewId) => (
            remaining.has(reviewId)
            && (dependencies[reviewId] || []).every((dependency) => !remaining.has(dependency))
        ));
        if (batch.length === 0) {
            throw new Error('Compiled review dependency graph contains a cycle; no launchable preparation batch exists.');
        }
        batches.push(batch);
        for (const reviewId of batch) {
            remaining.delete(reviewId);
        }
    }
    return batches;
}

function buildFullSuiteBarrier(
    requiredReviewIds: readonly string[],
    config: CompileReviewDependencyGraphOptions['fullSuiteValidation']
): ReviewDependencyGraphFullSuiteBarrier {
    const enabled = config?.enabled === true;
    const placement = config?.placement || 'after_compile_before_reviews';
    if (!FULL_SUITE_VALIDATION_PLACEMENTS.includes(placement)) {
        throw new Error(`full_suite_validation.placement '${String(placement)}' is not supported.`);
    }
    const beforeReviewIds = !enabled
        ? []
        : placement === 'after_compile_before_reviews'
            ? [...requiredReviewIds]
            : placement === 'before_test_review' && requiredReviewIds.includes('test')
                ? ['test']
                : [];
    return {
        enabled,
        placement,
        before_review_ids: Object.freeze(beforeReviewIds)
    };
}

export function compileReviewDependencyGraph(
    options: CompileReviewDependencyGraphOptions
): CompiledReviewDependencyGraph {
    const catalogLaneIds = options.catalogLaneIds.map((reviewId, index) => (
        assertReviewId(reviewId, `catalogLaneIds[${index}]`)
    ));
    const activeLaneIds = options.activeLaneIds.map((reviewId, index) => (
        assertReviewId(reviewId, `activeLaneIds[${index}]`)
    ));
    const requiredReviewIds = options.requiredReviewIds.map((reviewId, index) => (
        assertReviewId(reviewId, `requiredReviewIds[${index}]`)
    ));
    assertUniqueIds(catalogLaneIds, 'catalogLaneIds');
    assertUniqueIds(activeLaneIds, 'activeLaneIds');
    assertUniqueIds(requiredReviewIds, 'requiredReviewIds');
    const catalogSet = new Set(catalogLaneIds);
    const activeSet = new Set(activeLaneIds);
    for (const reviewId of activeLaneIds) {
        if (!catalogSet.has(reviewId)) {
            throw new Error(`Active review lane '${reviewId}' is missing from the catalog.`);
        }
    }
    for (const reviewId of requiredReviewIds) {
        if (!activeSet.has(reviewId)) {
            throw new Error(`Required review lane '${reviewId}' is missing or disabled in the active profile.`);
        }
    }

    const declaration = options.declaration == null
        ? null
        : normalizeReviewDependencyGraphDeclaration(options.declaration);
    const source = declaration ? 'profile' : 'compatibility_mode';
    const activePreparationOrder = declaration
        ? [...declaration.preparation_order]
        : buildCompatibilityPreparationOrder(activeLaneIds, catalogLaneIds, options.mode);
    if (declaration) {
        const orderSet = new Set(activePreparationOrder);
        for (const reviewId of activeLaneIds) {
            if (!orderSet.has(reviewId)) {
                throw new Error(`review_dependency_graph.preparation_order is missing active review lane '${reviewId}'.`);
            }
        }
        for (const reviewId of activePreparationOrder) {
            if (!catalogSet.has(reviewId)) {
                throw new Error(`review_dependency_graph references unknown review lane '${reviewId}'.`);
            }
            if (!activeSet.has(reviewId)) {
                throw new Error(`review_dependency_graph references disabled review lane '${reviewId}'.`);
            }
        }
    }

    const requiredSet = new Set(requiredReviewIds);
    const preparationOrder = activePreparationOrder.filter((reviewId) => requiredSet.has(reviewId));
    if (preparationOrder.length !== requiredReviewIds.length) {
        const missing = requiredReviewIds.filter((reviewId) => !preparationOrder.includes(reviewId));
        throw new Error(`Compiled review dependency graph is missing required review lanes: ${missing.join(', ')}.`);
    }
    const requiredReviewRecord = Object.fromEntries(catalogLaneIds.map((reviewId) => [reviewId, requiredSet.has(reviewId)]));
    const dependencies: Record<string, readonly string[]> = {};
    for (const reviewId of preparationOrder) {
        const configuredDependencies = declaration
            ? [...(declaration.dependencies[reviewId] || [])]
            : options.mode === 'strict_sequential'
                ? preparationOrder.slice(0, preparationOrder.indexOf(reviewId))
                : getReviewExecutionDependencies(reviewId, requiredReviewRecord, options.mode);
        const impossibleDependency = configuredDependencies.find((dependency) => !requiredSet.has(dependency));
        if (impossibleDependency) {
            throw new Error(
                `Required review lane '${reviewId}' depends on non-required lane '${impossibleDependency}', so the dependency cannot be satisfied.`
            );
        }
        dependencies[reviewId] = Object.freeze(configuredDependencies);
    }
    const preparationBatches = buildPreparationBatches(preparationOrder, dependencies);
    const body: Omit<CompiledReviewDependencyGraph, 'graph_sha256'> = {
        schema_version: REVIEW_DEPENDENCY_GRAPH_SCHEMA_VERSION,
        source,
        mode: options.mode,
        nodes: Object.freeze([...preparationOrder]),
        preparation_order: Object.freeze([...preparationOrder]),
        dependencies: Object.freeze(dependencies),
        preparation_batches: Object.freeze(preparationBatches.map((batch) => Object.freeze([...batch]))),
        full_suite_barrier: buildFullSuiteBarrier(preparationOrder, options.fullSuiteValidation)
    };
    return Object.freeze({ ...body, graph_sha256: sha256(body) });
}

export function getCompiledReviewDependencyGraphViolations(value: unknown): string[] {
    if (!isPlainRecord(value)) {
        return ['Compiled review dependency graph must be a JSON object.'];
    }
    const violations: string[] = [];
    if (value.schema_version !== REVIEW_DEPENDENCY_GRAPH_SCHEMA_VERSION) {
        violations.push('Compiled review dependency graph schema_version must be 1.');
    }
    if (value.source !== 'compatibility_mode' && value.source !== 'profile') {
        violations.push('Compiled review dependency graph source must be compatibility_mode or profile.');
    }
    if (
        value.mode !== LEGACY_REVIEW_EXECUTION_POLICY_MODE
        && !REVIEW_EXECUTION_POLICY_MODES.includes(value.mode as never)
    ) {
        violations.push('Compiled review dependency graph mode is invalid.');
    }
    if (!Array.isArray(value.nodes) || !Array.isArray(value.preparation_order) || !isPlainRecord(value.dependencies)) {
        violations.push('Compiled review dependency graph nodes, preparation_order, and dependencies are required.');
    } else {
        try {
            const normalized = normalizeReviewDependencyGraphDeclaration({
                preparation_order: value.preparation_order,
                dependencies: value.dependencies
            }, 'compiled_review_dependency_graph');
            if (JSON.stringify(value.nodes) !== JSON.stringify(normalized.preparation_order)) {
                violations.push('Compiled review dependency graph nodes must match preparation_order exactly.');
            }
            const expectedBatches = buildPreparationBatches(normalized.preparation_order, normalized.dependencies);
            if (JSON.stringify(value.preparation_batches) !== JSON.stringify(expectedBatches)) {
                violations.push('Compiled review dependency graph preparation_batches do not match the dependency DAG.');
            }
        } catch (error) {
            violations.push(error instanceof Error ? error.message : String(error));
        }
    }
    if (!isPlainRecord(value.full_suite_barrier) || typeof value.full_suite_barrier.enabled !== 'boolean' ||
        !FULL_SUITE_VALIDATION_PLACEMENTS.includes(value.full_suite_barrier.placement as FullSuiteValidationPlacement) ||
        !Array.isArray(value.full_suite_barrier.before_review_ids)) {
        violations.push('Compiled review dependency graph full_suite_barrier is invalid.');
    } else if ((value.full_suite_barrier.before_review_ids as unknown[]).includes('full-suite-validation')) {
        violations.push('Compiled review dependency graph cannot expose full-suite-validation as a review lane.');
    }
    if (!SHA256_PATTERN.test(String(value.graph_sha256 || ''))) {
        violations.push('Compiled review dependency graph graph_sha256 must be a SHA-256 hex string.');
    } else {
        const { graph_sha256: actualHash, ...body } = value;
        const expectedHash = sha256(body);
        if (actualHash !== expectedHash) {
            violations.push(`Compiled review dependency graph hash mismatch. Expected ${expectedHash}, got ${actualHash}.`);
        }
    }
    return violations;
}

export function resolveCompiledReviewDependencyGraphFromPreflight(
    preflightPayload: unknown,
    expectedMode?: EffectiveReviewExecutionPolicyMode,
    expectedGraph?: CompiledReviewDependencyGraph | null,
    requireGraph = false
): CompiledReviewDependencyGraph | null {
    if (!isPlainRecord(preflightPayload)) {
        return null;
    }
    const reviewExecutionPolicy = preflightPayload.review_execution_policy;
    const effectiveReviewSnapshot = preflightPayload.effective_review_snapshot;
    const snapshotGraph = isPlainRecord(effectiveReviewSnapshot)
        ? effectiveReviewSnapshot.review_dependency_graph
        : undefined;
    const hasPreflightGraph = isPlainRecord(reviewExecutionPolicy)
        && Object.prototype.hasOwnProperty.call(reviewExecutionPolicy, 'dependency_graph');
    const hasSnapshotGraph = snapshotGraph !== undefined;
    if (hasPreflightGraph !== hasSnapshotGraph) {
        throw new Error(
            'Preflight review dependency graph must match the immutable effective review snapshot graph presence.'
        );
    }
    if (!hasPreflightGraph) {
        if (expectedGraph || requireGraph) {
            throw new Error('Preflight review dependency graph is required by the frozen task profile policy.');
        }
        return null;
    }
    const dependencyGraph = reviewExecutionPolicy.dependency_graph;
    const violations = getCompiledReviewDependencyGraphViolations(dependencyGraph);
    if (violations.length > 0) {
        throw new Error(`Preflight review dependency graph is invalid: ${violations.join('; ')}`);
    }
    const compiled = dependencyGraph as unknown as CompiledReviewDependencyGraph;
    if (expectedMode && compiled.mode !== expectedMode) {
        throw new Error(
            `Preflight review dependency graph mode '${compiled.mode}' does not match review execution policy mode '${expectedMode}'.`
        );
    }
    if (getCompiledReviewDependencyGraphViolations(snapshotGraph).length > 0 ||
        sha256(snapshotGraph) !== sha256(compiled)) {
        throw new Error(
            'Preflight review dependency graph does not match the immutable effective review snapshot graph.'
        );
    }
    if (expectedGraph && sha256(compiled) !== sha256(expectedGraph)) {
        throw new Error(
            'Preflight review dependency graph does not match the canonical frozen task profile graph.'
        );
    }
    return compiled;
}
