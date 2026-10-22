import * as path from 'node:path';
import { parseOptions } from './cli-helpers';
import { registerParentCompletionContract } from '../../gates/parent-audit/parent-audit-contract';
import { prepareParentAuditReview, recordParentReviewerStarted, recordParentReviewerFailed } from '../../gates/parent-audit/parent-audit-inputs';
import { completeParentAuditReview } from '../../gates/parent-audit/parent-audit-review';
import { runParentValidation } from '../../gates/parent-audit/parent-audit-validation';
import { inspectParentCompletion } from '../../gates/parent-audit/parent-audit-state';
import { parentRecordDigest, parentRecordVersionPath } from '../../gates/parent-audit/parent-audit-auth';
import { assertValidTaskId } from '../../gate-runtime/task-events';
import { appendMandatoryTaskEvent } from '../../gate-runtime/task-events';
import { joinOrchestratorPath } from '../../core/orchestrator-paths';
import { syncTaskQueueStatusDetailed } from './gate-flows/task/task-queue-sync';
import { readParentQueue } from '../../gates/parent-audit/parent-audit-contract';
import { isTaskQueueDoneStatus } from '../../core/active-task-state';

export async function handleParentAudit(gateArgv: string[]): Promise<void> {
    const { options } = parseOptions(gateArgv, {
        '--task-id': { key: 'taskId', type: 'string' }, '--repo-root': { key: 'repoRoot', type: 'string' },
        '--phase': { key: 'phase', type: 'string' }, '--audit-enabled': { key: 'auditEnabled', type: 'string' },
        '--compatibility-reason': { key: 'compatibilityReason', type: 'string' },
        '--reviewer-identity': { key: 'reviewerIdentity', type: 'string' }, '--input-sha256': { key: 'inputSha256', type: 'string' },
        '--controller-tool': { key: 'controllerTool', type: 'string' }, '--reason': { key: 'reason', type: 'string' },
        '--command-index': { key: 'commandIndex', type: 'string' }
    }, { allowPositionals: false });
    const root = path.resolve(String(options.repoRoot || '.')), taskId = assertValidTaskId(String(options.taskId || ''));
    const identity = String(options.reviewerIdentity || '');
    switch (options.phase) {
        case 'register': {
            const value = options.auditEnabled;
            if (value !== undefined && value !== 'true' && value !== 'false') throw new Error('--audit-enabled must be true or false.');
            const record = registerParentCompletionContract(root, taskId, { legacyAuditEnabled: value === undefined ? undefined : value === 'true',
                compatibilityReason: String(options.compatibilityReason || '') });
            if (record.policy.audit_enabled && isTaskQueueDoneStatus(readParentQueue(root).entries.get(taskId)?.status ?? null)
                && !inspectParentCompletion(root, taskId)?.ready) {
                const transition = syncTaskQueueStatusDetailed(root, taskId, 'DECOMPOSED');
                if (transition.outcome !== 'updated') throw new Error('Could not resume retained parent aggregate obligations.');
                appendMandatoryTaskEvent(joinOrchestratorPath(root, ''), taskId, 'STATUS_CHANGED', 'INFO',
                    'Retained parent awaits its selected aggregate audit.', { previous_status: 'DONE', new_status: 'DECOMPOSED',
                        reason: 'parent_audit_compatibility_selected', contract_sha256: parentRecordDigest(record) }, { actor: 'orchestrator' });
            }
            console.log(JSON.stringify({ status: 'REGISTERED', policy: record.policy, contract_sha256: parentRecordDigest(record) }));
            return;
        }
        case 'validate': {
            if (typeof options.commandIndex !== 'string' || !/^(?:0|[1-9][0-9]*)$/u.test(options.commandIndex)) throw new Error('--command-index is required.');
            const result = await runParentValidation(root, taskId, Number(options.commandIndex));
            console.log(JSON.stringify({ status: result.status, command: result.command, output_path: result.output_path, output_sha256: result.output_sha256 }));
            if (result.status !== 'PASSED') process.exitCode = 1;
            return;
        }
        case 'prepare': {
            const record = prepareParentAuditReview(root, taskId);
            console.log('ReviewerLaunchInputArtifactPath: ' + parentRecordVersionPath(root, record));
            console.log('ReviewerLaunchInputSha256: ' + parentRecordDigest(record));
            console.log('ReviewOutputPath: ' + record.output_path);
            console.log('Launch a fresh clean-context delegated reviewer with exactly this generated input. Record actual delegation after launch; wait for its return before complete.');
            return;
        }
        case 'started':
            recordParentReviewerStarted(root, taskId, identity, String(options.inputSha256 || ''), String(options.controllerTool || ''));
            console.log('PARENT_REVIEWER_DELEGATION_RECORDED'); return;
        case 'failed':
            recordParentReviewerFailed(root, taskId, identity, String(options.reason || ''));
            console.log('PARENT_REVIEWER_FAILURE_RECORDED'); return;
        case 'complete': {
            const result = completeParentAuditReview(root, taskId, identity);
            console.log(JSON.stringify({ status: 'AUDITED_ONCE', findings: result.findings.length, follow_up_task_id: result.follow_up_task_id }));
            console.log('Release the reviewer session, then rerun next-step.'); return;
        }
        case 'inspect': {
            const result = inspectParentCompletion(root, taskId);
            console.log(JSON.stringify(result && { ready: result.ready, policy: result.contract.policy,
                follow_up_task_id: result.followUpTaskId, violations: result.violations })); return;
        }
        default: throw new Error('Parent audit phase must be register, validate, prepare, started, failed, complete or inspect.');
    }
}
