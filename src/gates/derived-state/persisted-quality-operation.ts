import * as path from 'node:path';
import { executeClosedObservationPlan, prepareClosedObservationPlanModules, unwrapObservationCapture, isPublishableObservationCapture,
    captureInvocationMemoTrace, fingerprintObservationData, type ClosedObservationPlan } from '../../core/derivation-observation-recorder';
import { cloneFrozenJson } from '../../core/immutable-json';
import { isInvocationReadObservationActive, assertInvocationDependenciesCurrent, probeOptionalInvocationReads,
    enqueueInvocationOptionalPublication } from '../../core/invocation-read-observation';
import { readInvocationPathObservation, readInvocationFileContent, observedInvocationValue } from '../../core/invocation-file-observation';
import { encodeDerivationValue, decodeDerivationValue, derivationHash } from '../../core/persisted-derivation-value';
import { encodePersistentDependencies, replayPersistentDependencies, observePersistentWorkspaceAuth,
    observePersistentCode, observePersistentQualityQuery } from './persisted-derivation-adapters';
import { readPersistentCandidate, decodePersistentDerivation, publishPersistentDerivation,
    persistentDerivationPath, type PersistentDerivationIdentity } from './persisted-derivation-store';
import { persistentDerivationMode, countPersistentOutcome } from '../../core/persisted-derivation-mode';
export interface QualityPersistenceContext {
    repoRoot: string; taskId: string | null; artifactPath: string; preflight: Record<string, unknown>;
    preflightSha256: string | null; inspection?: 'active' | 'retained_completed';
}
const capturedBindings = new WeakSet<object>();
export interface CapturedQualityBinding {
    readonly auth: ReturnType<typeof observePersistentWorkspaceAuth>;
    readonly identity: PersistentDerivationIdentity;
    readonly dependencies: NonNullable<ReturnType<typeof encodePersistentDependencies>>;
}
export function isCapturedQualityBinding(value: unknown): value is CapturedQualityBinding {
    return value !== null && typeof value === 'object' && capturedBindings.has(value);
}
type QualityPlan = Extract<ClosedObservationPlan, { operation: 'quality-artifact-json' | 'quality-analysis' }>;
function buildBinding(plan: QualityPlan, context: QualityPersistenceContext) {
    if (!context.taskId || !path.isAbsolute(context.artifactPath)) throw new Error('No bound quality task/artifact.');
    // These two native leaf call sites use runtime/reviews. Custom layouts retain the native path.
    const reviews = path.dirname(context.artifactPath), runtime = path.dirname(reviews), bundle = path.dirname(runtime);
    if (path.basename(reviews) !== 'reviews' || path.basename(runtime) !== 'runtime') throw new Error('Unlisted quality artifact layout.');
    const auth = observePersistentWorkspaceAuth(context.repoRoot);
    const codeSha256 = observePersistentCode();
    const query = observePersistentQualityQuery(path.join(runtime, 'task-events', context.taskId + '.jsonl'), context.taskId);
    const policyPath = path.join(bundle, 'live/config/workflow-config.json');
    const policyPathState = readInvocationPathObservation(policyPath);
    if (!policyPathState) throw new Error('No observed quality policy.');
    let absent = false;
    try { observedInvocationValue(policyPathState.stat); }
    catch (error) {
        if (!['ENOENT','ENOTDIR'].includes(String((error as NodeJS.ErrnoException).code))) throw error;
        absent = true;
    }
    const policy = absent ? null : readInvocationFileContent(policyPath);
    const policySha256 = policy ? policy.sha256 : derivationHash('garda.absent-quality-policy.v1');
    const planSha256 = derivationHash(encodeDerivationValue(plan));
    const parametersSha256 = derivationHash(encodeDerivationValue([plan, context.preflight, context.preflightSha256]));
    const identity: PersistentDerivationIdentity = { schema: 1, operation: plan.operation, operationVersion: 1,
        taskId: context.taskId, lane: 'quality',
        contract: plan.operation === 'quality-artifact-json' ? 'artifact-json' : plan.requireObservedExecution ? 'strict' : 'soft',
        inspection: context.inspection ?? 'active',
        workspaceSha256: auth.workspaceSha256, repoRealpath: auth.repoRealpath, gitDirectoryRealpath: auth.gitDirectoryRealpath,
        cycleSha256: query.cycleSha256, querySha256: query.querySha256, codeSha256, policySha256, parametersSha256, planSha256 };
    return { auth, identity };
}
function binding(plan: QualityPlan, context: QualityPersistenceContext): CapturedQualityBinding {
    const capture = captureInvocationMemoTrace(() => buildBinding(plan, context));
    if (!capture.outcome.returned) throw capture.outcome.error;
    const dependencies = encodePersistentDependencies(capture.trace);
    if (!dependencies) throw new Error('Unlisted quality binding dependency.');
    const result = Object.freeze({ auth: capture.outcome.value.auth,
        identity: Object.freeze(capture.outcome.value.identity), dependencies });
    capturedBindings.add(result); return result;
}
/** Only these fixed plans qualify. Full quality acquisition remains live outside this boundary. */
export function executePersistentQualityPlan(plan: QualityPlan, context: QualityPersistenceContext): unknown {
    prepareClosedObservationPlanModules();
    const mode = persistentDerivationMode();
    if (!isInvocationReadObservationActive() || mode === 'disabled') {
        countPersistentOutcome('disabled'); return unwrapObservationCapture(executeClosedObservationPlan(plan));
    }
    // Retain one binding observation for both a miss and its optional publication.
    // Candidate bytes remain outside the decision observation until a hit is selected.
    let pending = probeOptionalInvocationReads(() => {
        const current = binding(plan, context);
        const candidate = readPersistentCandidate(current.auth, persistentDerivationPath(current.auth, current.identity));
        const record = mode === 'force-miss' ? null : candidate?.bytes ? decodePersistentDerivation(current.auth, candidate.bytes) : null;
        if (record && fingerprintObservationData(record.identity) === fingerprintObservationData(current.identity)
            && replayPersistentDependencies(record.dependencies)) {
            const value = cloneFrozenJson(decodeDerivationValue(record.result));
            candidate!.select(); return { current, targetSha256: candidate!.sha256, hit: { value } };
        }
        return { current, targetSha256: candidate?.sha256 ?? null, hit: null };
    });
    if (pending?.value.hit) {
        // Deliberately outside an optional catch. Selected dependency changes reject.
        pending.select(); // select() already performs the immediate parent dependency check.
        countPersistentOutcome('hit'); return pending.value.hit.value;
    }
    countPersistentOutcome('miss');
    try {
        const captured = executeClosedObservationPlan(plan); // Exactly once, with the original result/error.
        const value = unwrapObservationCapture(captured);
        if (!isPublishableObservationCapture(captured)) { countPersistentOutcome('noncacheable'); return value; }
        try { encodeDerivationValue(value); } catch { countPersistentOutcome('noncacheable'); return value; }
        const leafDependencies = encodePersistentDependencies(captured.trace);
        if (!leafDependencies) { countPersistentOutcome('noncacheable'); return value; }
        assertInvocationDependenciesCurrent();
        // Read-only navigation never creates private authentication state. Successful native
        // gate owners create it before starting their fresh, optional read observation.
        if (!pending || !pending.validate()) return value;
        const ready = pending.value;
        assertInvocationDependenciesCurrent();
        const publicationProbe = pending;
        // Nothing is written if a later native read fails, throws, or changes before outer final A1.
        if (enqueueInvocationOptionalPublication(() => {
            if (publicationProbe.validate())
                publishPersistentDerivation(context.repoRoot, ready.current, captured, ready.targetSha256);
        }, () => publicationProbe.discard())) pending = null;
        return value;
    } finally { pending?.discard(); }
}
