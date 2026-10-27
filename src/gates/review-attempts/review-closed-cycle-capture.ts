import { captureLoadedCodeClosure } from '../../core/loaded-code-identity';
import { resolveTaskModeArtifactPath } from '../task-mode/task-mode-artifact';
/** Native composition. Full replay is reachable only from captureClosedReviewGate(). */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { cloneJson } from '../../core/immutable-json';
import { countNextStepWork } from '../../core/next-step-measurement';
import { readInvocationFileContent, readInvocationPathObservation } from '../../core/invocation-file-observation';
import { isInvocationReadObservationActive } from '../../core/invocation-read-observation';
import { isPlainRecord } from '../../core/records';
import type { ReviewCycleGuardConfig } from '../../core/review-cycle-guard';
import { joinOrchestratorPath } from '../../core/orchestrator-paths';
import { readTaskTimelineJsonlEntries } from '../../gate-runtime/task-events';
import { readTaskTimelineClosedReviewQuery } from '../../gate-runtime/timeline/task-events-integrity';
import { captureTaskTimelineReadSnapshotSha256, withTaskTimelineFileReadSnapshot } from '../../gate-runtime/timeline/task-timeline-read-snapshot';
import type { CapturedClosedReviewEvent, ClosedReviewVerifiedCapture } from '../../gate-runtime/timeline/task-closed-review-query';
import { withReviewArtifactReadBarrier } from '../../gate-runtime/review-artifacts';
import { invalidateIndex } from '../../gate-runtime/reviews-index';
import { resolveWorkflowConfigPath } from '../full-suite/full-suite-validation';
import { readNormalizedReviewCycleGuardConfig } from '../next-step/next-step-review-cycle-guard-config';
import { readCurrentReviewCyclePreflightFingerprints } from '../next-step/next-step-review-cycle-scope';
import type { ReviewCycleGuardReadEvaluationResult } from '../next-step/next-step-review-cycle-guard-types';
import type { TimelineEventEntry } from '../completion/completion-evidence';
import { createCurrentReviewAttemptArtifactIndex, createReviewAttemptArtifactIndex,
    type ReviewAttemptSnapshotReader } from './review-attempt-artifact-index';
import { getReviewHistoryIntegrityViolations, resolveValidatedReviewCycleArtifactForVerdict,
    getReviewCycleValidationArtifactVerdict } from './review-history-integrity';
import { closedReviewDigest, resolveClosedReviewAuthentication } from './review-closed-cycle-auth';
import { makeClosedReviewBinding, type ClosedReviewGateCapture, type ClosedReviewGateCaptureRequest } from './review-closed-cycle-gate-hooks';
import { readClosedReviewHistory, type PublishClosedReviewInput } from './review-closed-cycle-storage';
import { validateClosedReviewOutcome } from './review-closed-cycle-facts';
import type { ValidatedReviewOutcome } from './review-closed-cycle-summary';
import { reviewCadenceFailedFromDetails, validateReviewCadenceAdmission } from './review-cadence-admission';

interface CapturedFile { file: string; bytes: Buffer | null; identity: string; }
function identity(file: string): string {
    try {
        const stat = fs.lstatSync(file, { bigint: true });
        return JSON.stringify([fs.realpathSync.native(file), String(stat.dev), String(stat.ino), String(stat.mode),
            String(stat.size), String(stat.mtimeNs), String(stat.ctimeNs), String(stat.nlink)]);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
        throw error;
    }
}
function captureFile(file: string): CapturedFile {
    countNextStepWork('visit:closed-review-capture:file');
    readInvocationPathObservation(file);
    const before = identity(file);
    if (before === 'missing') return { file, bytes: null, identity: before };
    const observed = readInvocationFileContent(file);
    const bytes = observed ? observed.copyBytes() : fs.readFileSync(file);
    if (identity(file) !== before) throw new Error('History capture input changed during read.');
    return { file, bytes, identity: before };
}
function assertFilesCurrent(files: readonly CapturedFile[]): void {
    for (const before of files) {
        const now = captureFile(before.file);
        if (now.identity !== before.identity || (now.bytes === null) !== (before.bytes === null)
            || (now.bytes !== null && before.bytes !== null && closedReviewDigest(now.bytes) !== closedReviewDigest(before.bytes)))
            throw new Error('History capture input changed before publication: ' + before.file);
    }
}
/** Fixed Q5 policy owners. Late/unattested startup leaves optional acceleration unavailable. */
function captureProducerModules() {
    const roots = ['./review-closed-cycle-capture', './review-closed-cycle-storage', './review-closed-cycle-summary',
        './review-history-integrity', '../next-step/next-step-review-cycle-guard-attempts', './review-attempt-artifact-index'];
    for (const modulePath of roots) require(modulePath);
    return captureLoadedCodeClosure('garda.closed-review-code.v1', roots.map(modulePath => require.resolve(modulePath)));
}
function timelineEvent(entry: CapturedClosedReviewEvent): TimelineEventEntry {
    const raw = entry.record;
    return { event_type: String(raw.event_type || '').trim().toUpperCase(), outcome: String(raw.outcome || '').trim().toUpperCase() || undefined,
        timestamp_utc: String(raw.timestamp_utc || '').trim(), sequence: entry.lineOrdinal,
        details: isPlainRecord(raw.details) ? raw.details : null };
}
function authenticateEvent(repoRoot: string, taskId: string, reader: ReviewAttemptSnapshotReader,
    source: CapturedClosedReviewEvent): void {
    const event = timelineEvent(source), details = event.details;
    const lane = String(details?.review_type || details?.reviewType || '').trim().toLowerCase();
    if (!lane) throw new Error('Review history event has no lane.');
    const options = { artifactIndex: reader, repoRoot, taskId, reviewType: lane, details };
    const artifact = resolveValidatedReviewCycleArtifactForVerdict(options);
    if (artifact.invalidSnapshot) throw new Error('Review history current report/receipt is invalid.');
    const sha = String(details?.review_artifact_snapshot_sha256 ?? details?.reviewArtifactSnapshotSha256 ?? '').trim().toLowerCase();
    if (artifact.resolvedPath && getReviewCycleValidationArtifactVerdict({ ...options, reviewArtifactSha256: sha })?.invalidSnapshot)
        throw new Error('Review history current findings-validation is invalid.');
}
function nativeSourceAllowed(request: ClosedReviewGateCaptureRequest, source: CapturedClosedReviewEvent, files: CapturedFile[]): void {
    const raw = source.record, details = isPlainRecord(raw.details) ? raw.details : {};
    if (source.sha256 !== request.sourceEventSha256 || raw.task_id !== request.taskId) throw new Error('History producer source changed.');
    if (request.kind === 'record' || request.kind === 'reuse') {
        if (raw.event_type !== 'REVIEW_RECORDED' || raw.actor !== 'gate' || raw.outcome !== 'PASS')
            throw new Error('History producer requires native review admission, not verdict PASS.');
        if ((details.reused_existing_review === true) !== (request.kind === 'reuse')) throw new Error('History review source kind differs.');
        return;
    }
    if (request.kind === 'preflight') {
        if (raw.event_type !== 'PREFLIGHT_CLASSIFIED' || raw.outcome !== 'INFO') throw new Error('History preflight source is not native admission.');
        const output = String(details.output_path || '').trim();
        if (!output) throw new Error('History preflight source has no output.');
        const sourceFile = captureFile(path.resolve(request.repoRoot, output)); files.push(sourceFile);
        const result = sourceFile.bytes && JSON.parse(sourceFile.bytes.toString('utf8'));
        if (!isPlainRecord(result) || !isPlainRecord(result.metrics)
            || result.metrics.scope_sha256 !== details.scope_sha256 || result.metrics.scope_content_sha256 !== details.scope_content_sha256)
            throw new Error('History preflight source differs from native classified output.');
        return;
    }
    if (request.kind === 'restart') {
        if (!['REVIEW_CYCLE_RESTARTED', 'COHERENT_CYCLE_RESTARTED'].includes(String(raw.event_type))
            || raw.actor !== 'orchestrator' || raw.outcome !== 'PASS') throw new Error('History restart source is not native success.');
        for (const [pathKey, shaKey] of [['restart_artifact_path', 'restart_artifact_sha256'], ['task_mode_path', 'task_mode_sha256'],
            ['preflight_path', 'preflight_sha256'], ['compile_evidence_path', 'compile_evidence_sha256']]) {
            const sourceFile = captureFile(path.resolve(request.repoRoot, String(details[pathKey] || ''))); files.push(sourceFile);
            if (!sourceFile.bytes || closedReviewDigest(sourceFile.bytes) !== details[shaKey]) throw new Error('History restart source bytes differ.');
        }
        return;
    }
    throw new Error('Task-mode/reset events invalidate the semantic head; native preflight owns the next publication.');
}
function captureInputs(repoRoot: string, eventsRoot: string, taskId: string, config: ReviewCycleGuardConfig, producer: boolean) {
    const timelinePath = path.join(eventsRoot, taskId + '.jsonl');
    const captured = readTaskTimelineClosedReviewQuery(timelinePath, taskId);
    if (!captured) throw new Error('History capture needs a complete valid canonical timeline.');
    // Small public clones only; the verifier already retains/freeze-counts the underlying records.
    const queryCapture = cloneJson(captured) as ClosedReviewVerifiedCapture;
    const timelineSha = captureTaskTimelineReadSnapshotSha256(timelinePath);
    const auth = resolveClosedReviewAuthentication(repoRoot, producer);
    const reviewsRoot = path.resolve(eventsRoot, '..', 'reviews');
    const files: CapturedFile[] = [];
    const modeDetails = queryCapture.latestTaskMode && isPlainRecord(queryCapture.latestTaskMode.record.details) ? queryCapture.latestTaskMode.record.details : {};
    const taskMode = captureFile(resolveTaskModeArtifactPath(repoRoot, taskId, String(modeDetails.artifact_path || ''))); files.push(taskMode);
    const preflight = captureFile(path.join(reviewsRoot, taskId + '-preflight.json')); files.push(preflight);
    const workflow = captureFile(resolveWorkflowConfigPath(repoRoot)); files.push(workflow);
    const code = captureProducerModules();
    const fingerprints = readCurrentReviewCyclePreflightFingerprints(eventsRoot, taskId);
    const binding = makeClosedReviewBinding({ taskId, repoRealpath: auth.repoRealpath, gitDirectoryRealpath: auth.gitDirectoryRealpath,
        producerBundleSha256: code.sha256, producerPolicySha256: closedReviewDigest(JSON.stringify(['garda.closed-review-capture.v1',
            workflow.bytes === null ? null : closedReviewDigest(workflow.bytes), config])),
        taskModeBytes: taskMode.bytes, preflightBytes: preflight.bytes, config, fingerprints,
        restartEventSha256: queryCapture.latestRestart?.sha256 ?? null, query: queryCapture.query });
    return { queryCapture, timelinePath, timelineSha, auth, reviewsRoot, files, binding, config, fingerprints, preflight, code };
}

/** Concrete required dependency passed by the native record/reuse/restart/preflight compositions. */
export const captureClosedReviewGate: ClosedReviewGateCapture = (request): PublishClosedReviewInput => {
    if (isInvocationReadObservationActive()) throw new Error('History publication must not run inside a read-only navigation invocation.');
    const eventsRoot = joinOrchestratorPath(request.repoRoot, 'runtime/task-events');
    return withTaskTimelineFileReadSnapshot(path.join(eventsRoot, request.taskId + '.jsonl'), () => {
        const config = readNormalizedReviewCycleGuardConfig(request.repoRoot);
        const captured = captureInputs(request.repoRoot, eventsRoot, request.taskId, config, true);
        if (captured.queryCapture.query.source.sha256 !== request.sourceEventSha256) throw new Error('A newer semantic source superseded this producing gate.');
        nativeSourceAllowed(request, captured.queryCapture.sourceEvent, captured.files);
        const validateSource = (): ValidatedReviewOutcome | null => withReviewArtifactReadBarrier(captured.reviewsRoot, () => {
            if (request.kind !== 'record' && request.kind !== 'reuse') return null;
            const reader = createReviewAttemptArtifactIndex(captured.reviewsRoot, request.taskId);
            authenticateEvent(request.repoRoot, request.taskId, reader, captured.queryCapture.sourceEvent);
            const raw = captured.queryCapture.sourceEvent.record;
            const admittedCadence = validateReviewCadenceAdmission(captured.auth, request.taskId, raw);
            return validateClosedReviewOutcome({ repoRoot: request.repoRoot, taskId: request.taskId, artifactIndex: reader,
                event: timelineEvent(captured.queryCapture.sourceEvent), eventSha256: request.sourceEventSha256,
                cadenceFailed: admittedCadence ?? reviewCadenceFailedFromDetails(isPlainRecord(raw.details) ? raw.details : {}) });
        });
        return { repoRoot: request.repoRoot, binding: captured.binding, query: captured.queryCapture.query,
            config, fingerprints: captured.fingerprints, validateSource,
            assertInputsCurrent() {
                captured.code.assertCurrent();
                assertFilesCurrent(captured.files);
                // Gates may reread the canonical bytes. Navigation never reaches this check.
                if (closedReviewDigest(fs.readFileSync(captured.timelinePath)) !== captured.timelineSha)
                    throw new Error('Canonical timeline changed before summary publication.');
                const auth = resolveClosedReviewAuthentication(request.repoRoot, false);
                if (auth.workspaceSha256 !== captured.auth.workspaceSha256 || !auth.key.equals(captured.auth.key))
                    throw new Error('History producer workspace/key changed.');
            },
            bootstrap() {
                return withTaskTimelineFileReadSnapshot(captured.timelinePath, () => withReviewArtifactReadBarrier(captured.reviewsRoot, () => {
                    if (captureTaskTimelineReadSnapshotSha256(captured.timelinePath) !== captured.timelineSha)
                        throw new Error('History bootstrap timeline differs from captured source.');
                    const entries = readTaskTimelineJsonlEntries(captured.timelinePath);
                    const violations = getReviewHistoryIntegrityViolations({ repoRoot: request.repoRoot, reviewsRoot: captured.reviewsRoot,
                        taskId: request.taskId, timelineEvents: entries.map(entry => entry.record || {}) });
                    if (violations.length) throw new Error(violations.join('\n'));
                    const reader = createReviewAttemptArtifactIndex(captured.reviewsRoot, request.taskId), facts: ValidatedReviewOutcome[] = [];
                    let ordinal = 0;
                    for (const entry of entries) {
                        countNextStepWork('visit:closed-review-capture:producer-bootstrap-event');
                        const lineOrdinal = ordinal++, raw = entry.record;
                        if (raw?.event_type !== 'REVIEW_RECORDED') continue;
                        const integrity = isPlainRecord(raw.integrity) ? raw.integrity : {};
                        const eventSha256 = typeof integrity.event_sha256 === 'string' ? integrity.event_sha256 : closedReviewDigest(JSON.stringify(raw));
                        const source = { record: raw, sha256: eventSha256, lineOrdinal };
                        authenticateEvent(request.repoRoot, request.taskId, reader, source);
                        const cadence = validateReviewCadenceAdmission(captured.auth, request.taskId, raw);
                        facts.push(validateClosedReviewOutcome({ repoRoot: request.repoRoot, taskId: request.taskId, artifactIndex: reader,
                            event: timelineEvent(source), eventSha256, cadenceFailed: cadence ?? reviewCadenceFailedFromDetails(isPlainRecord(raw.details) ? raw.details : {}) }));
                    }
                    return facts;
                }));
            }
        };
    });
};

/** Deliberate authorized producer invalidation, after the complete native index owner finished. */
export function prepareClosedReviewCurrentIndex(repoRoot: string): void {
    // Native invalidation takes its existing index lock. Absence selects native rebuild parity;
    // it never ignores a pre-existing valid cache omission in a reader.
    invalidateIndex(joinOrchestratorPath(repoRoot, 'runtime/reviews'));
}

export function readCapturedClosedReviewGuard(input: { repoRoot: string; eventsRoot: string; taskId: string;
    config: ReviewCycleGuardConfig }): ReviewCycleGuardReadEvaluationResult | null {
    if (!input.config.enabled || !isInvocationReadObservationActive()) return null;
    const canonicalRoot = path.resolve(joinOrchestratorPath(input.repoRoot, 'runtime/task-events'));
    if (path.resolve(input.eventsRoot) !== canonicalRoot) return null;
    try {
        return withTaskTimelineFileReadSnapshot(path.join(input.eventsRoot, input.taskId + '.jsonl'), () => {
            const captured = captureInputs(input.repoRoot, input.eventsRoot, input.taskId, input.config, false);
            const reader = createCurrentReviewAttemptArtifactIndex(captured.reviewsRoot, input.taskId)
                ?? createReviewAttemptArtifactIndex(captured.reviewsRoot, input.taskId);
            // An already selected full catalog retains its exact current-reference membership checks.
            return readClosedReviewHistory({ repoRoot: input.repoRoot, binding: captured.binding, query: captured.queryCapture.query,
                validateCurrentReferences: () => {
                    const currentSha = captured.preflight.bytes && closedReviewDigest(captured.preflight.bytes);
                    const authenticated = new Set<string>();
                    for (const source of captured.queryCapture.unclosedReviews) {
                        countNextStepWork('visit:closed-review-capture:unclosed-review');
                        authenticateEvent(input.repoRoot, input.taskId, reader, source);
                        authenticated.add(source.sha256);
                    }
                    for (const source of Object.values(captured.queryCapture.currentReviews)) {
                        countNextStepWork('visit:closed-review-capture:current-lane');
                        const details = isPlainRecord(source.record.details) ? source.record.details : {};
                        const preflightSha = details.preflight_sha256 ?? details.preflightSha256;
                        if (typeof preflightSha !== 'string') return false; // Ambiguous legacy currentness uses native path.
                        if (preflightSha !== currentSha || authenticated.has(source.sha256)) continue;
                        authenticateEvent(input.repoRoot, input.taskId, reader, source);
                    }
                    return true;
                } });
        });
    } catch { return null; }
}
