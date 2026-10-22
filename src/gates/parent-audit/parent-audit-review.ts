import { parentRecordDigest, publishParentRecord, readParentRecord, withParentAuditMutation } from './parent-audit-auth';
import { readParentCompletionContract } from './parent-audit-contract';
import { assertParentReviewInputCurrent, type ParentReviewerStart } from './parent-audit-inputs';
import { readAcceptedParentAuditResult, readParentOutput, readParentReviewObservation, type ParentReviewObservation } from './parent-audit-evidence';
import { materializeParentAuditFollowUp } from './parent-audit-follow-up';
import type { ParentAuditResult, ParentReviewInput } from './parent-audit-types';

export function completeParentAuditReview(root: string, taskId: string, identity: string): ParentAuditResult {
    return withParentAuditMutation(root, taskId, () => {
        const contract = readParentCompletionContract(root, taskId);
        if (!contract?.policy.audit_enabled) throw new Error('This parent has no aggregate review obligation.');
        const existing = readAcceptedParentAuditResult(root, contract);
        if (existing) return existing;
        const input = readParentRecord<ParentReviewInput>(root, taskId, 'review-input');
        const started = readParentRecord<ParentReviewerStart>(root, taskId, 'review-start');
        if (!input || !started || started.status !== 'STARTED' || started.attempt_id !== input.attempt_id
            || started.input_sha256 !== parentRecordDigest(input) || started.reviewer_identity !== identity) {
            throw new Error('The current actual independent reviewer must return before aggregate finalization.');
        }
        let observation = readParentReviewObservation(root, taskId, true);
        assertParentReviewInputCurrent(root, input, observation !== null);
        if (!observation) {
            const result = readParentOutput(root, input);
            assertParentReviewInputCurrent(root, input);
            observation = publishParentRecord(root, { schema_version: 1, event_source: 'parent-audit', task_id: taskId,
                kind: 'review-observation', input_sha256: parentRecordDigest(input), attempt_id: input.attempt_id,
                reviewer_identity: identity, start_sha256: parentRecordDigest(started), output_sha256: result.sha256, findings: result.output.findings } satisfies ParentReviewObservation);
        }
        const followUpTaskId = observation.findings.length ? materializeParentAuditFollowUp(root, contract, input, observation) : null;
        assertParentReviewInputCurrent(root, input, true);
        return publishParentRecord(root, { schema_version: 1, event_source: 'parent-audit', task_id: taskId, kind: 'result',
            contract_sha256: parentRecordDigest(contract), input_sha256: parentRecordDigest(input), attempt_id: input.attempt_id,
            reviewer_identity: identity, output_sha256: observation.output_sha256, source_commit: input.source_commit,
            findings: observation.findings, follow_up_task_id: followUpTaskId });
    });
}
