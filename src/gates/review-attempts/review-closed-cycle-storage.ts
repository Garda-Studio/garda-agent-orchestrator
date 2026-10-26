/** Full-history replay exists only in producer hooks; navigation never receives it. */
import * as path from 'node:path';
import { assertValidTaskId, appendMandatoryTaskEvent, type AppendTaskEventResult, type TaskEventAppendState } from '../../gate-runtime/task-events';
import { withRecoverableFileTransaction } from '../../core/recoverable-file-transaction';
import { withReviewArtifactTransactionLock } from '../../gate-runtime/review-artifacts';
import { withRuntimeMutationGeneration } from '../../gate-runtime/runtime-mutation-generation';
import { ensureContainedDirectory } from '../../core/contained-filesystem';
import { joinOrchestratorPath } from '../../core/orchestrator-paths';
import { countNextStepWork } from '../../core/next-step-measurement';
import type { ReviewCycleGuardConfig } from '../../core/review-cycle-guard';
import type { DomainScopeFingerprints } from '../scope/domain-scope-fingerprints';
import type { ReviewCycleGuardReadEvaluationResult } from '../next-step/next-step-review-cycle-guard-types';
import { CLOSED_REVIEW_REDUCER_VERSION, appendValidatedReviewOutcome, createClosedReviewProducerState,
    projectClosedReviewGuard, type ClosedReviewNavigationBinding, type ClosedReviewProducerState,
    type ValidatedReviewOutcome } from './review-closed-cycle-summary';
import { CLOSED_REVIEW_NAVIGATION_LIMIT, CLOSED_REVIEW_STATE_LIMIT, closedReviewDigest, isClosedReviewDigest,
    encodeClosedReviewEnvelope, decodeClosedReviewEnvelope, readClosedReviewBytes, resolveClosedReviewAuthentication,
    type ClosedReviewAuthentication } from './review-closed-cycle-auth';

export const CLOSED_REVIEW_PUBLICATION_EVENT = 'REVIEW_HISTORY_SUMMARY_PUBLISHED';
export interface ReviewSourceIdentity { sha256: string; lineOrdinal: number; }
export interface ClosedReviewPublication {
    eventSha256: string;
    lineOrdinal: number;
    taskId: string;
    actor: 'orchestrator';
    outcome: 'PASS';
    details: { schema_version: 1; event_source: 'closed-review-history'; task_id: string;
        source_event_sha256: string; source_line_ordinal: number; semantic_query_sha256: string;
        state_path: string; state_sha256: string | null; navigation_path: string; navigation_sha256: string };
}
/** Construct only during full verified timeline parsing. Do not derive by a second tail scan.
 * previousReview is the review immediately before latestReview, not the previous event.
 * latestPublication is retained even if current semanticQuery differs (producer reuse only).
 */
export interface VerifiedClosedReviewQuery {
    timelineValid: boolean;
    taskId: string;
    semanticQuerySha256: string;
    source: ReviewSourceIdentity;
    sourceEventType: 'REVIEW_RECORDED' | 'REVIEW_CYCLE_RESTARTED' | 'COHERENT_CYCLE_RESTARTED'
        | 'PREFLIGHT_CLASSIFIED' | 'TASK_MODE_ENTERED' | 'TASK_RESET' | 'TASK_DISCARDED';
    latestReview: ReviewSourceIdentity | null;
    previousReview: ReviewSourceIdentity | null;
    latestPublication: ClosedReviewPublication | null;
    appendState: TaskEventAppendState;
}
interface StateDocument { schema_version: 1; binding: ClosedReviewNavigationBinding; state: ClosedReviewProducerState; }
export interface ClosedReviewCompactDocument {
    schema_version: 1;
    reducer_version: typeof CLOSED_REVIEW_REDUCER_VERSION;
    binding: ClosedReviewNavigationBinding;
    available: boolean;
    /** Never include cumulative rows or old receipt chains here. */
    result: ReviewCycleGuardReadEvaluationResult | null;
    unavailable_reason: 'compact-byte-limit' | 'producer-state-byte-limit' | null;
}
export interface ClosedReviewPaths { root: string; state: string; navigation: string; journal: string; lock: string; }
export function closedReviewPaths(repoRoot: string, taskId: string): ClosedReviewPaths {
    assertValidTaskId(taskId);
    const root = path.resolve(joinOrchestratorPath(repoRoot, 'runtime/reviews'));
    const stem = path.join(root, `${taskId}-review-history`);
    return { root, state: stem + '-state.json', navigation: stem + '-navigation.json', journal: stem + '-journal.json', lock: stem + '.lock' };
}
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const nonnegative = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const sameReview = (left: ReviewSourceIdentity | null, right: ReviewSourceIdentity | null): boolean => left === null || right === null
    ? left === right : left.sha256 === right.sha256 && left.lineOrdinal === right.lineOrdinal;
const stateReview = (state: ClosedReviewProducerState): ReviewSourceIdentity | null => state.lastReviewEventSha256
    ? { sha256: state.lastReviewEventSha256, lineOrdinal: state.lastReviewLineOrdinal } : null;
const bindingKeys: ReadonlyArray<keyof ClosedReviewNavigationBinding> = ['task_id', 'repo_realpath', 'git_directory_realpath',
    'producer_bundle_sha256', 'producer_policy_sha256', 'task_mode_sha256', 'preflight_sha256',
    'preflight_domain_fingerprints_sha256', 'normalized_guard_config_sha256', 'authenticated_restart_event_sha256',
    'covered_review_event_sha256', 'covered_review_line_ordinal', 'semantic_query_sha256'];
export function equalClosedReviewBindings(left: ClosedReviewNavigationBinding, right: ClosedReviewNavigationBinding): boolean {
    return bindingKeys.every(key => { countNextStepWork('visit:closed-review-summary:binding'); return left[key] === right[key]; });
}
function validateBinding(value: unknown): asserts value is ClosedReviewNavigationBinding {
    if (!record(value) || Object.keys(value).length !== bindingKeys.length
        || typeof value.task_id !== 'string' || !value.task_id || typeof value.repo_realpath !== 'string' || !value.repo_realpath
        || typeof value.git_directory_realpath !== 'string' || !value.git_directory_realpath) throw new Error('Invalid history binding.');
    for (const key of bindingKeys) {
        countNextStepWork('visit:closed-review-summary:binding-schema');
        if (['task_id', 'repo_realpath', 'git_directory_realpath'].includes(key)) continue;
        if (key === 'covered_review_line_ordinal') {
            if (!Number.isSafeInteger(value[key]) || Number(value[key]) < -1) throw new Error('Invalid review ordinal.');
        } else if ((key === 'authenticated_restart_event_sha256' || key === 'covered_review_event_sha256') && value[key] === null) continue;
        else if (!isClosedReviewDigest(value[key])) throw new Error('Invalid history binding digest.');
    }
    if ((value.covered_review_event_sha256 === null) !== (value.covered_review_line_ordinal === -1)) throw new Error('Inconsistent review identity.');
}
function validateState(value: unknown, taskId: string): asserts value is ClosedReviewProducerState {
    if (!record(value) || value.schema_version !== 1 || value.reducer_version !== CLOSED_REVIEW_REDUCER_VERSION
        || value.task_id !== taskId || !record(value.attempts) || !record(value.latestFailureTransitionByLane)
        || !Number.isSafeInteger(value.lastReviewLineOrdinal) || Number(value.lastReviewLineOrdinal) < -1
        || !(value.lastReviewEventSha256 === null || isClosedReviewDigest(value.lastReviewEventSha256))
        || (value.lastReviewEventSha256 === null) !== (value.lastReviewLineOrdinal === -1)) throw new Error('Invalid cumulative history state.');
    for (const row of Object.values(value.attempts)) {
        countNextStepWork('visit:closed-review-summary:producer-state-row');
        if (!record(row) || typeof row.reviewType !== 'string' || !row.reviewType || row.reviewType !== row.reviewType.trim().toLowerCase()
            || !['failed', 'passed', 'latestEventFailed', 'reused', 'sawUnknownScope'].every(key => typeof row[key] === 'boolean')
            || (row.failed && row.passed) || !nonnegative(row.lastSequence) || row.lastSequence > Number(value.lastReviewLineOrdinal)
            || !(row.firstScopeHash === null || isClosedReviewDigest(row.firstScopeHash)) || !Array.isArray(row.seenScopeHashes)
            || !row.seenScopeHashes.every(hash => isClosedReviewDigest(hash))) throw new Error('Invalid cumulative history row.');
    }
    for (const [lane, failure] of Object.entries(value.latestFailureTransitionByLane)) {
        if (!record(failure) || failure.review_type !== lane || failure.event_type !== 'REVIEW_RECORDED' || !nonnegative(failure.sequence)
            || failure.sequence > Number(value.lastReviewLineOrdinal)) throw new Error('Invalid failure transition.');
    }
}
function validateQuery(query: VerifiedClosedReviewQuery, binding: ClosedReviewNavigationBinding): void {
    validateBinding(binding);
    if (!query.timelineValid || query.taskId !== binding.task_id || query.semanticQuerySha256 !== binding.semantic_query_sha256
        || !isClosedReviewDigest(query.source.sha256) || !nonnegative(query.source.lineOrdinal)
        || !sameReview(query.latestReview, binding.covered_review_event_sha256 === null ? null
            : { sha256: binding.covered_review_event_sha256, lineOrdinal: binding.covered_review_line_ordinal }))
        throw new Error('Review history query differs from current verified inputs.');
}
function validPublication(publication: ClosedReviewPublication | null, paths: ClosedReviewPaths, taskId: string): publication is ClosedReviewPublication {
    if (!publication) return false;
    const details = publication.details;
    return publication.actor === 'orchestrator' && publication.outcome === 'PASS' && publication.taskId === taskId
        && isClosedReviewDigest(publication.eventSha256) && nonnegative(publication.lineOrdinal)
        && details.schema_version === 1 && details.event_source === 'closed-review-history' && details.task_id === taskId
        && isClosedReviewDigest(details.source_event_sha256) && nonnegative(details.source_line_ordinal)
        && details.source_line_ordinal < publication.lineOrdinal && isClosedReviewDigest(details.semantic_query_sha256)
        && details.state_path === paths.state && details.navigation_path === paths.navigation
        && (details.state_sha256 === null || isClosedReviewDigest(details.state_sha256)) && isClosedReviewDigest(details.navigation_sha256);
}
function stateForProducer(auth: ClosedReviewAuthentication, paths: ClosedReviewPaths, query: VerifiedClosedReviewQuery,
    binding: ClosedReviewNavigationBinding): ClosedReviewProducerState | null {
    const publication = query.latestPublication;
    if (!validPublication(publication, paths, binding.task_id) || !publication.details.state_sha256) return null;
    try {
        const bytes = readClosedReviewBytes(paths.root, paths.state, CLOSED_REVIEW_STATE_LIMIT);
        if (!bytes || closedReviewDigest(bytes) !== publication.details.state_sha256) return null;
        const document = decodeClosedReviewEnvelope(auth, 'state', bytes) as StateDocument;
        if (document.schema_version !== 1) return null;
        validateBinding(document.binding); validateState(document.state, binding.task_id);
        if (document.binding.repo_realpath !== binding.repo_realpath || document.binding.git_directory_realpath !== binding.git_directory_realpath
            || document.binding.producer_bundle_sha256 !== binding.producer_bundle_sha256
            || document.binding.producer_policy_sha256 !== binding.producer_policy_sha256
            || document.binding.semantic_query_sha256 !== publication.details.semantic_query_sha256
            || document.binding.covered_review_event_sha256 !== document.state.lastReviewEventSha256
            || document.binding.covered_review_line_ordinal !== document.state.lastReviewLineOrdinal) return null;
        return document.state;
    } catch { return null; }
}

export interface PublishClosedReviewInput {
    repoRoot: string;
    binding: ClosedReviewNavigationBinding;
    query: VerifiedClosedReviewQuery;
    config: ReviewCycleGuardConfig;
    fingerprints: DomainScopeFingerprints | null;
    /** Authenticating the source is mandatory even when retrying an already covered event. */
    validateSource: () => ValidatedReviewOutcome | null;
    /** Full verified native replay, including every report/receipt/findings auth; gates ONLY. */
    bootstrap: () => Iterable<ValidatedReviewOutcome>;
    /** Recheck current evidence/policy/path observations under canonical append lock. */
    assertInputsCurrent: () => void;
}

/** Call after the complete owning record/reuse artifact transaction, not in its afterWrites callback.
 * Publication failure preserves the original error. Admitted REVIEW_RECORDED is not rolled back;
 * retrying has exact dedupe semantics, and an absent projection always takes native fallback.
 */
export function publishClosedReviewHistory(input: PublishClosedReviewInput): AppendTaskEventResult | null {
    const { query, binding } = input;
    validateQuery(query, binding);
    if (closedReviewDigest(JSON.stringify(input.config)) !== binding.normalized_guard_config_sha256
        || closedReviewDigest(JSON.stringify(input.fingerprints)) !== binding.preflight_domain_fingerprints_sha256)
        throw new Error('Review history projection inputs differ from bound config/scope.');
    const auth = resolveClosedReviewAuthentication(input.repoRoot, true);
    if (auth.repoRealpath !== binding.repo_realpath || auth.gitDirectoryRealpath !== binding.git_directory_realpath)
        throw new Error('Review history producer workspace differs.');
    const paths = closedReviewPaths(input.repoRoot, binding.task_id);
    ensureContainedDirectory(input.repoRoot, paths.root);
    // A malformed/oversized cumulative state is an accelerator miss. Leave its bytes
    // untouched and publish from authenticated gate replay using the navigation participant.
    let stateWritable = true;
    try { readClosedReviewBytes(paths.root, paths.state, CLOSED_REVIEW_STATE_LIMIT); } catch { stateWritable = false; }
    // Complete the native read barrier before taking the publication write lock.
    // Recheck the captured source/config/timeline under that lock before any write.
    input.assertInputsCurrent();
    const fact = input.validateSource();
    if (query.sourceEventType === 'REVIEW_RECORDED') {
        if (!fact || fact.eventSha256 !== query.source.sha256 || fact.lineOrdinal !== query.source.lineOrdinal
            || !sameReview(query.latestReview, query.source)) throw new Error('Review publication source mismatch.');
    } else if (fact !== null) throw new Error('Non-review source supplied a review outcome.');
    let state = stateForProducer(auth, paths, query, binding);
    if (state && !sameReview(stateReview(state), query.latestReview)) {
        if (fact && sameReview(stateReview(state), query.previousReview)) appendValidatedReviewOutcome(state, fact);
        else state = null;
    }
    if (!state) {
        state = createClosedReviewProducerState(binding.task_id);
        for (const replayFact of input.bootstrap()) appendValidatedReviewOutcome(state, replayFact);
    }
    validateState(state, binding.task_id);
    if (!sameReview(stateReview(state), query.latestReview)) throw new Error('Bootstrap did not cover the verified review prefix.');
    const stateBytes = encodeClosedReviewEnvelope(auth, 'state', { schema_version: 1, binding, state } satisfies StateDocument);
    let document: ClosedReviewCompactDocument = { schema_version: 1, reducer_version: CLOSED_REVIEW_REDUCER_VERSION,
        binding, available: true, result: projectClosedReviewGuard(state, input.config, input.fingerprints), unavailable_reason: null };
    let navigationBytes = encodeClosedReviewEnvelope(auth, 'navigation', document);
    // A new storage bound never becomes a new workflow refusal: publish explicit miss.
    if (stateBytes.length > CLOSED_REVIEW_STATE_LIMIT || navigationBytes.length > CLOSED_REVIEW_NAVIGATION_LIMIT) {
        document = { ...document, available: false, result: null, unavailable_reason:
            stateBytes.length > CLOSED_REVIEW_STATE_LIMIT ? 'producer-state-byte-limit' : 'compact-byte-limit' };
        navigationBytes = encodeClosedReviewEnvelope(auth, 'navigation', document);
    }
    if (navigationBytes.length > CLOSED_REVIEW_NAVIGATION_LIMIT) throw new Error('Fixed history binding exceeds navigation limit.');
    const stateSha = stateWritable && stateBytes.length <= CLOSED_REVIEW_STATE_LIMIT ? closedReviewDigest(stateBytes) : null;
    const navigationSha = closedReviewDigest(navigationBytes);
    const previous = query.latestPublication;
    if (validPublication(previous, paths, binding.task_id) && previous.details.source_event_sha256 === query.source.sha256
        && previous.details.source_line_ordinal === query.source.lineOrdinal
        && previous.details.semantic_query_sha256 === query.semanticQuerySha256
        && previous.details.state_sha256 === stateSha && previous.details.navigation_sha256 === navigationSha) {
        const existing = readClosedReviewBytes(paths.root, paths.navigation, CLOSED_REVIEW_NAVIGATION_LIMIT);
        if (existing && closedReviewDigest(existing) === navigationSha) return null;
    }
    return withReviewArtifactTransactionLock(paths.root, () =>
        withRuntimeMutationGeneration(joinOrchestratorPath(input.repoRoot, ''), 'review-history-publication',
            () => withRecoverableFileTransaction({ root: paths.root, journalPath: paths.journal, lockPath: paths.lock,
                files: stateWritable ? { state: paths.state, navigation: paths.navigation } : { navigation: paths.navigation }
            }, transaction => {
            input.assertInputsCurrent();
            if (stateSha) transaction.write(paths.state, stateBytes);
            transaction.write(paths.navigation, navigationBytes);
            input.assertInputsCurrent();
            return appendMandatoryTaskEvent(joinOrchestratorPath(input.repoRoot, ''), binding.task_id, CLOSED_REVIEW_PUBLICATION_EVENT,
                'PASS', 'Authenticated cumulative review history published.', {
                    schema_version: 1, event_source: 'closed-review-history', task_id: binding.task_id,
                    source_event_sha256: query.source.sha256, source_line_ordinal: query.source.lineOrdinal,
                    semantic_query_sha256: query.semanticQuerySha256, state_path: paths.state, state_sha256: stateSha,
                    navigation_path: paths.navigation, navigation_sha256: navigationSha
                } satisfies ClosedReviewPublication['details'], { actor: 'orchestrator', expectedPreviousState: query.appendState,
                    validateBeforeCanonicalAppend: input.assertInputsCurrent });
            }))).result;
}

/** No producer state/key creation/replay dependency is reachable from this function. */
export function readClosedReviewHistory(input: { repoRoot: string; binding: ClosedReviewNavigationBinding;
    query: VerifiedClosedReviewQuery;
    /** Authenticate selected current/reference evidence via exact index, even for a valid summary. */
    validateCurrentReferences: () => boolean }): ReviewCycleGuardReadEvaluationResult | null {
    try {
        validateQuery(input.query, input.binding);
        const paths = closedReviewPaths(input.repoRoot, input.binding.task_id), publication = input.query.latestPublication;
        if (!validPublication(publication, paths, input.binding.task_id)
            || publication.details.semantic_query_sha256 !== input.query.semanticQuerySha256
            || publication.details.source_event_sha256 !== input.query.source.sha256
            || publication.details.source_line_ordinal !== input.query.source.lineOrdinal) return null;
        const auth = resolveClosedReviewAuthentication(input.repoRoot, false);
        if (auth.repoRealpath !== input.binding.repo_realpath || auth.gitDirectoryRealpath !== input.binding.git_directory_realpath) return null;
        const bytes = readClosedReviewBytes(paths.root, paths.navigation, CLOSED_REVIEW_NAVIGATION_LIMIT);
        if (!bytes || closedReviewDigest(bytes) !== publication.details.navigation_sha256) return null;
        const value = decodeClosedReviewEnvelope(auth, 'navigation', bytes) as ClosedReviewCompactDocument;
        if (value.schema_version !== 1 || value.reducer_version !== CLOSED_REVIEW_REDUCER_VERSION || value.available !== true
            || value.unavailable_reason !== null || !value.result || !record(value.result.evaluation)) return null;
        validateBinding(value.binding);
        if (!equalClosedReviewBindings(value.binding, input.binding) || !input.validateCurrentReferences()) return null;
        countNextStepWork('closed-review-summary:accepted');
        return value.result; // Parsed per invocation; no retained mutable authority escapes.
    } catch { countNextStepWork('closed-review-summary:native-fallback'); return null; }
}
