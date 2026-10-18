import * as fs from 'node:fs';
import * as path from 'node:path';
import { runGit } from '../../core/git-helpers';
import { isPlainRecord } from '../../core/records';
import { joinOrchestratorPath } from '../../core/orchestrator-paths';
import { parseTaskQueueEntriesFromContent } from '../../core/task-queue-read';
import { isTaskQueueDoneStatus } from '../../core/active-task-state';
import { readTransactionBytes } from '../../core/file-transaction-journal';
import { TASK_QUEUE_FILENAME } from '../../core/orchestration-constants';
import { inspectTaskEventFile, readTaskTimelineJsonlEntries, withTaskTimelineReadSnapshot } from '../../gate-runtime/task-events';
import { captureTaskTimelineReadSnapshotSha256, assertTaskTimelineReadSnapshotCurrent } from '../../gate-runtime/timeline/task-timeline-read-snapshot';
import { getNoOpEvidence, getCurrentNoOpEventSha256 } from '../task-mode/no-op';
import { inspectCompletionGateFinalizationLock } from '../locks/finalization-lock';
import type { NativeChildSourceAcceptance, NativeSourceCompositionRequest, NativeChildGitSource } from './task-audit-summary-decomposed-parent-proofs';
import type { TaskAuditSummaryResult } from './task-audit-summary-types';

export type NativeChildAuditReader = (taskId: string) => Pick<TaskAuditSummaryResult,
    'task_id' | 'status' | 'integrity_status' | 'blockers' | 'point_in_time_snapshot'>;
type Event = Readonly<Record<string, unknown>>;
interface NoOpSourceServices {
    readAudit: NativeChildAuditReader;
    verifyComposition: (root: string, request: NativeSourceCompositionRequest) => unknown;
    validateGit: (root: string, source: NativeChildGitSource) => void;
}
const SUITE_EVENTS = new Set(['FULL_SUITE_VALIDATION_PASSED', 'FULL_SUITE_VALIDATION_FAILED', 'FULL_SUITE_VALIDATION_WARNED']);

function latestIndex(events: Event[], predicate: (event: Event) => boolean): number {
    for (let index = events.length - 1; index >= 0; index--) if (predicate(events[index])) return index;
    return -1;
}

function currentNoOpContract(root: string, taskId: string, timeline: string) {
    const inspection = inspectTaskEventFile(timeline, taskId);
    if (!['PASS', 'PASS_WITH_LEGACY_PREFIX'].includes(inspection.status) || inspection.violations.length) {
        throw new Error('No-op source qualification requires an intact native child timeline.');
    }
    const events = readTaskTimelineJsonlEntries(timeline).map(entry => entry.record).filter(isPlainRecord);
    if (events.some(event => event.event_type === 'TASK_SOURCE_COMMIT_ACCEPTED')) {
        throw new Error('Native SOURCE evidence appeared before no-op reconstruction; retry strict SOURCE verification.');
    }
    const entry = latestIndex(events, event => event.event_type === 'TASK_MODE_ENTERED');
    const preflight = joinOrchestratorPath(root, 'runtime/reviews/' + taskId + '-preflight.json');
    const noOp = getNoOpEvidence(root, taskId, '', preflight);
    const noOpEvent = getCurrentNoOpEventSha256(root, taskId, noOp);
    const noOpIndex = latestIndex(events, event => event.event_type === 'NO_OP_RECORDED');
    const completion = latestIndex(events, event => event.event_type === 'COMPLETION_GATE_PASSED');
    if (entry < 0 || noOpIndex <= entry || completion <= noOpIndex || events[completion].outcome !== 'PASS'
        || events.slice(entry).some(event => event.event_type === 'TASK_DISCARDED' || event.event_type === 'TASK_RESET')
        || noOp.evidence_status !== 'PASS' || !noOpEvent) {
        throw new Error('Source qualification requires a current native-complete audited no-op child.');
    }
    const suiteIndex = latestIndex(events, event => SUITE_EVENTS.has(String(event.event_type)));
    const suite = events[suiteIndex], declaration = suite?.details;
    if (suiteIndex <= noOpIndex || suiteIndex >= completion || suite.event_type !== 'FULL_SUITE_VALIDATION_PASSED'
        || suite.outcome !== 'PASS' || !isPlainRecord(declaration)
        || typeof declaration.command !== 'string' || !declaration.command.trim()) {
        throw new Error('No-op source qualification requires its original native successful full-suite contract.');
    }
    const commandIndex = latestIndex(events, event => event.event_type === 'INTERMEDIATE_COMMAND_RUN'
        && isPlainRecord(event.details) && event.details.command === declaration.command);
    const command = events[commandIndex], details = command?.details;
    if (commandIndex <= completion || !['PASS', 'PASSED'].includes(String(command?.outcome))
        || !isPlainRecord(details) || typeof details.artifact_path !== 'string' || typeof details.artifact_sha256 !== 'string') {
        throw new Error(`No-op child ${taskId} requires a successful post-completion composition of its original suite.`);
    }
    const coverage = declaration.coverage_contract_sha256 ?? null;
    if (coverage !== null && typeof coverage !== 'string') throw new Error('No-op original coverage contract is invalid.');
    return { noOp, noOpEvent, completion: events[completion], suite, command: declaration.command,
        coverageContractSha256: coverage, artifactPath: details.artifact_path, artifactSha256: details.artifact_sha256 };
}

/** Reconstructs current no-op acceptance; it does not create a commit or a SOURCE event. */
export function readNativeAuditedNoOpSourceAcceptance(
    repoRoot: string, taskId: string, services: NoOpSourceServices
): NativeChildSourceAcceptance {
    const root = fs.realpathSync.native(repoRoot), eventsRoot = joinOrchestratorPath(root, 'runtime/task-events');
    return withTaskTimelineReadSnapshot(eventsRoot, taskId, () => {
        const timeline = path.join(eventsRoot, taskId + '.jsonl');
        const timelineHash = captureTaskTimelineReadSnapshotSha256(timeline);
        const queuePath = path.join(root, TASK_QUEUE_FILENAME), queue = readTransactionBytes(root, queuePath);
        if (!queue || !isTaskQueueDoneStatus(parseTaskQueueEntriesFromContent(queue.toString('utf8')).get(taskId)?.status ?? null)) {
            throw new Error('No-op source qualification requires the exact canonical DONE child queue row.');
        }
        const contract = currentNoOpContract(root, taskId, timeline);
        const assertFinalized = () => {
            const lock = inspectCompletionGateFinalizationLock(joinOrchestratorPath(root, 'runtime/reviews'), taskId);
            if (lock?.active || lock?.stale) throw new Error('No-op child completion finalization is unresolved.');
        };
        assertFinalized();
        const sourceLines = runGit(root, ['--no-replace-objects', 'show', '--no-patch', '--format=%H%n%T%n%P', 'HEAD'],
            { timeoutMs: 10000, maxBuffer: 4096 }).trim().split(/\r?\n/u);
        const source = { commitSha: sourceLines[0], treeSha: sourceLines[1], parentCommitSha: sourceLines[2]?.split(' ')[0] || null };
        const request = { taskId, artifactPath: contract.artifactPath, artifactSha256: contract.artifactSha256,
            command: contract.command, coverageContractSha256: contract.coverageContractSha256, source };
        services.validateGit(root, source);
        services.verifyComposition(root, request);
        const audit = services.readAudit(taskId);
        if (audit.task_id !== taskId || audit.status !== 'PASS'
            || !['PASS', 'PASS_WITH_LEGACY_PREFIX'].includes(audit.integrity_status)
            || !Array.isArray(audit.blockers) || audit.blockers.length || audit.point_in_time_snapshot?.status !== 'STABLE') {
            const reasons = Array.isArray(audit.blockers) ? audit.blockers.map(blocker => blocker.reason).join(' | ') : '';
            throw new Error(`No-op child ${taskId} audit requires current stable task-qualified PASS; got ${audit.status}. ${reasons}`);
        }
        services.verifyComposition(root, request);
        assertFinalized();
        if (!readTransactionBytes(root, queuePath)?.equals(queue)
            || currentNoOpContract(root, taskId, timeline).noOp.evidence_hash !== contract.noOp.evidence_hash) {
            throw new Error('No-op source qualification inputs changed during consumption.');
        }
        assertTaskTimelineReadSnapshotCurrent(timeline, timelineHash);
        return { taskId, ...source, artifactPath: contract.artifactPath, artifactSha256: contract.artifactSha256,
            noOpAcceptanceAudit: { task_id: taskId, status: audit.status, integrity_status: audit.integrity_status,
                no_op_event_sha256: contract.noOpEvent, no_op_sha256: contract.noOp.evidence_hash,
                no_op_classification: contract.noOp.classification,
                preflight_sha256: contract.noOp.preflight_sha256,
                completion_event_sha256: isPlainRecord(contract.completion.integrity) ? contract.completion.integrity.event_sha256 : null,
                original_suite_event_sha256: isPlainRecord(contract.suite.integrity) ? contract.suite.integrity.event_sha256 : null } };
    });
}
