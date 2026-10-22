import { runGit } from '../../core/git-helpers';
import * as path from 'node:path';
import { isPlainRecord } from '../../core/records';
import { readAuthenticatedSplitRequiredWipManifestSnapshot } from '../split-required/split-required-wip-runtime-handoff-contracts';
import { resolveWipRoot } from '../split-required/split-required-wip-contracts';
import { validateAdvancedManifestBlobs, validateManifestFileReferences } from '../split-required/split-required-wip-restore-plan';
import { inspectCompletionGateFinalizationLock } from '../locks/finalization-lock';
import { joinOrchestratorPath } from '../../core/orchestrator-paths';
import { parsePorcelainV1Z, splitNulRecords, type GitPorcelainV1Entry } from '../../core/git-path-output';
import { inspectFilesystemLock } from '../../gate-runtime/task-events-locking';
import { resolveTaskQueueTransactionLockPath } from '../../core/task-queue/task-queue-repository';
import { isTaskQueueDoneStatus } from '../../core/active-task-state';
import { readNativeChildSourceAcceptance, validateNativeParentGitSource, readParentAuditProofBytes, mergeNativeChildSources, type NativeChildSourceAcceptance } from '../task-audit/task-audit-summary-decomposed-parent-proofs';
import { qualifyWip, readNativeParentObligationProofs, readParentSourceEpoch, withNativeParentReadScope, type ParentReadScope } from '../task-audit/task-audit-summary-parent-obligation-proofs';
import { captureTaskTimelineReadSnapshotSha256, assertTaskTimelineReadSnapshotCurrent } from '../../gate-runtime/timeline/task-timeline-read-snapshot';
import { withTaskTimelineReadSnapshot } from '../../gate-runtime/task-events';
import { buildTaskAuditSummary } from '../task-audit/task-audit-summary';
import { readParentQueue, parentEventHash } from './parent-audit-contract';
import { readParentEvents, parentDigest, parentRecordDigest } from './parent-audit-auth';
import type { ParentCompletionContract } from './parent-audit-types';

const GIT_OPTIONS = { timeoutMs: 10000, maxBuffer: 8 * 1024 * 1024 };

function isCurrentQueueLockMetadata(root: string, change: GitPorcelainV1Entry): boolean {
    if (change.indexStatus !== '?' || change.worktreeStatus !== '?' || change.path !== 'TASK.md.garda-status-sync.lock/owner.json') return false;
    const queue = path.join(root, 'TASK.md');
    return [queue + '.garda-status-sync.lock', resolveTaskQueueTransactionLockPath(queue)].every(file => {
        const lock = inspectFilesystemLock(file);
        return lock.metadata.metadata_status === 'ok' && lock.metadata.pid === process.pid
            && lock.ownerAlive === true && lock.ownerHostMatchesCurrent === true
            && lock.metadata.command === 'task-queue-transaction';
    });
}

export function captureParentSource(root: string) {
    const [commitSha, treeSha, parents] = runGit(root, ['--no-replace-objects', 'show', '--no-patch', '--format=%H%n%T%n%P', 'HEAD'], GIT_OPTIONS).trim().split(/\r?\n/u);
    const source = { commitSha, treeSha, parentCommitSha: parents?.split(' ')[0] || null };
    validateNativeParentGitSource(root, source, parents?.split(' ') || []);
    const changes = parsePorcelainV1Z(runGit(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], GIT_OPTIONS));
    if (changes.some(change => !isCurrentQueueLockMetadata(root, change))
        || splitNulRecords(runGit(root, ['ls-files', '-v', '-z'], GIT_OPTIONS)).some(record => /^[a-zS]/u.test(record))) {
        throw new Error('Parent acceptance requires clean Git source without hidden index flags.');
    }
    return source;
}

export function readAcceptedParentChildren(root: string, contract: ParentCompletionContract): NativeChildSourceAcceptance[] {
    return withNativeParentReadScope(root, contract.task_id, scope => {
        const { bytes, entries } = readParentQueue(root), key = parentRecordDigest(contract);
        const cached = scope.childSources.get(key);
        if (cached) {
            if (!cached.queue.equals(bytes)) throw new Error('Child graph changed during SOURCE qualification.');
            return [...cached.sources];
        }
        scope.sourceEpoch ??= readParentSourceEpoch(root);
        const sources = mergeNativeChildSources(contract.child_task_ids.map(childId => {
            if (!isTaskQueueDoneStatus(entries.get(childId)?.status ?? null)) throw new Error('Child has not completed: ' + childId);
            return readAcceptedParentChild(root, childId, scope);
        }));
        const assertCurrent = () => {
            if (!readParentQueue(root).bytes.equals(bytes)) throw new Error('Child graph changed during SOURCE qualification.');
        };
        assertCurrent(); scope.rechecks.push(assertCurrent);
        scope.childSources.set(key, { queue: bytes, sources });
        return [...sources];
    }, () => true);
}

function readAcceptedParentChild(root: string, childId: string, scope: ParentReadScope): NativeChildSourceAcceptance[] {
    const readAudit = scope.readChildAudit ?? ((taskId: string) => buildTaskAuditSummary({ repoRoot: root, taskId }));
    const nested = readNativeParentObligationProofs(root, childId, readAudit);
    if (nested) {
        if (nested.status !== 'QUALIFIED') throw new Error('Nested child is not accepted: ' + childId + ': ' + nested.violations.join(' | '));
        const assertFinalized = () => {
            const lock = inspectCompletionGateFinalizationLock(joinOrchestratorPath(root, 'runtime/reviews'), childId);
            if (lock?.active || lock?.stale) throw new Error('Nested parent finalization is unresolved: ' + childId);
        };
        assertFinalized(); scope.rechecks.push(assertFinalized);
        return nested.native.childSources;
    }
    const eventsRoot = joinOrchestratorPath(root, 'runtime/task-events');
    try { return withTaskTimelineReadSnapshot(eventsRoot, childId, () => {
        const timeline = path.join(eventsRoot, childId + '.jsonl'), snapshot = captureTaskTimelineReadSnapshotSha256(timeline);
        const source = readNativeChildSourceAcceptance(root, childId, readAudit), observed = JSON.stringify(source);
        scope.proofRechecks.push(() => {
            if (JSON.stringify(readNativeChildSourceAcceptance(root, childId, readAudit)) !== observed) {
                throw new Error('Parent child SOURCE changed during qualification: ' + childId);
            }
        });
        scope.rechecks.push(() => withTaskTimelineReadSnapshot(eventsRoot, childId, () => {
            try { assertTaskTimelineReadSnapshotCurrent(timeline, snapshot); }
            catch (error: unknown) { throw new Error('Parent child SOURCE changed during qualification: ' + childId, { cause: error }); }
            readParentAuditProofBytes(root, path.resolve(root, source.artifactPath), source.artifactSha256);
        }));
        return [source];
    }); } catch (error: unknown) {
        throw new Error('Native child SOURCE qualification failed for ' + childId + ': '
            + (error instanceof Error ? error.message : String(error)), { cause: error });
    }
}

export function assertParentWipPreserved(root: string, contract: ParentCompletionContract): void {
    if (contract.policy.origin === 'manual-at-creation') return;
    const events = readParentEvents(root, contract.task_id);
    const decomposition = events.findIndex(event => parentEventHash(event) === contract.decomposition_sha256);
    if (decomposition < 0) throw new Error('Original native decomposition is missing.');
    const captures = events.filter(event => event.event_type === 'SPLIT_REQUIRED_WIP_CAPTURED');
    if (!captures.length) { qualifyWip(root, contract.task_id, events.slice(0, decomposition + 1)); return; }
    for (const capture of captures) {
        const details = capture.details;
        if (!isPlainRecord(details) || typeof details.manifest_path !== 'string' || typeof details.manifest_sha256 !== 'string') {
            throw new Error('Native WIP capture identity is missing.');
        }
        const file = path.resolve(root, details.manifest_path), wipRoot = resolveWipRoot(root, contract.task_id);
        const snapshot = readAuthenticatedSplitRequiredWipManifestSnapshot(root, file, wipRoot), manifest = snapshot.manifest;
        let expectedHash = details.manifest_sha256;
        if (manifest.status === 'retired') {
            const retirement = events.slice(events.indexOf(capture) + 1).find(event => event.event_type === 'SPLIT_REQUIRED_WIP_RETIRED'
                && isPlainRecord(event.details) && path.resolve(root, String(event.details.manifest_path)) === file
                && event.details.manifest_sha256 === snapshot.sha256 && event.details.reason === manifest.retired_reason);
            const original: Record<string, unknown> = { ...manifest, status: 'suspended' };
            delete original.retired_at_utc;
            delete original.retired_reason;
            if (!retirement || parentDigest(JSON.stringify(original, null, 2) + '\n') !== expectedHash) {
                throw new Error('Retired WIP has no native retirement preserving its original captured bytes.');
            }
            expectedHash = snapshot.sha256;
        } else if (manifest.status !== 'suspended') throw new Error('Parent WIP is not suspended or natively retired.');
        if (manifest.task_id !== contract.task_id || snapshot.sha256 !== expectedHash || manifest.schema_version !== 1
            || !Array.isArray(manifest.tracked_files) || !Array.isArray(manifest.untracked_files)) throw new Error('Parent WIP capture identity changed.');
        const violations = [...validateManifestFileReferences(root, manifest), ...validateAdvancedManifestBlobs(root, manifest, manifest.tracked_files)];
        if (violations.length) throw new Error('Parent WIP archive changed: ' + violations.join(' | '));
        if (readAuthenticatedSplitRequiredWipManifestSnapshot(root, file, wipRoot).sha256 !== snapshot.sha256) throw new Error('Parent WIP changed during qualification.');
    }
}

export function parentChildSourceIdentity(sources: NativeChildSourceAcceptance[]) {
    return sources.map(source => ({ task_id: source.taskId, commit: source.commitSha, proof_sha256: source.artifactSha256 }));
}
