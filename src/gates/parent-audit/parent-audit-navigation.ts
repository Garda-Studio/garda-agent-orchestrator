import * as fs from 'node:fs';
import * as path from 'node:path';
import { isTaskQueueDecomposedStatus, isTaskQueueDoneStatus } from '../../core/active-task-state';
import { joinOrchestratorPath } from '../../core/orchestrator-paths';
import { isPlainRecord } from '../../core/records';
import { extractExplicitLinkedChildTaskIds, readDecomposedTaskProvenance, type TaskQueueEntry } from '../next-step/next-step-task-queue';
import { transitionDecomposedParentsToDone } from '../next-step/next-step-task-queue-transitions';
import { createNextStepEffectPlanner, type NextStepEffectController } from '../next-step/next-step-effects';
import { hasBoundParentCompletionPolicy, readParentCompletionContract, registerParentCompletionContract, requiresParentCompletionContract } from './parent-audit-contract';
import { parentRecordDigest, parentRecordVersionPath, readParentRecord, readParentEvents } from './parent-audit-auth';
import { inspectParentCompletion } from './parent-audit-state';
import { readParentValidations } from './parent-audit-validation';
import type { ParentReviewInput } from './parent-audit-types';
import { assertParentReviewInputCurrent, parentReviewerControllerTool, type ParentReviewerStart } from './parent-audit-inputs';

export function resolveParentAuditNavigation(options: {
    repoRoot: string; taskId: string; taskEntry: TaskQueueEntry | null; taskEntries: Map<string, TaskQueueEntry>;
    cliPrefix: string; eventsRoot: string; effects?: NextStepEffectController;
}) {
    const { repoRoot: root, taskId, taskEntry: entry, taskEntries: entries, cliPrefix } = options;
    if (!isTaskQueueDecomposedStatus(entry?.status ?? null) && !isTaskQueueDoneStatus(entry?.status ?? null)) return null;
    const children = extractExplicitLinkedChildTaskIds(entry?.notes ?? null, entries.keys(), taskId);
    if (children.length < 2) return null;
    const command = (phase: string, argumentsText = '') => `${cliPrefix} gate parent-audit --task-id "${taskId}" --phase ${phase}${argumentsText} --repo-root "."`;
    const route = (title: string, reason: string, phase: string | null, args = '') => ({
        status: 'DECOMPOSED' as const, nextGate: phase ? 'parent-audit' : null, title, reason,
        commands: phase ? [{ label: title, command: command(phase, args) }] : [],
        missingArtifacts: [], finalReport: null
    });
    const unfinished = children.find(id => !isTaskQueueDoneStatus(entries.get(id)?.status ?? null));
    if (unfinished) {
        const nested = entries.get(unfinished);
        const descendants = extractExplicitLinkedChildTaskIds(nested?.notes ?? null, entries.keys(), unfinished);
        if (isTaskQueueDecomposedStatus(nested?.status ?? null) && descendants.length >= 2
            && descendants.every(id => isTaskQueueDoneStatus(entries.get(id)?.status ?? null))
            && (readParentCompletionContract(root, unfinished) || requiresParentCompletionContract(root, unfinished, nested?.notes ?? null))) return {
            ...route('Complete the nested parent acceptance first.', 'Its leaves are DONE, but its own frozen audit or SOURCE obligations still precede outer-parent acceptance.', null),
            nextGate: 'child-task', commands: [{ label: 'Continue nested parent', command: `${cliPrefix} next-step "${unfinished}" --repo-root "."` }]
        };
        return null;
    }
    const contract = readParentCompletionContract(root, taskId);
    if (!contract) {
        const source = readDecomposedTaskProvenance(entry?.notes ?? null);
        const file = joinOrchestratorPath(root, `runtime/reviews/${taskId}-strict-decomposition-decision.json`);
        const decision: unknown = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
        if (source.source === 'manual-agent' || source.source === 'manual-operator' || hasBoundParentCompletionPolicy(root, taskId)) {
            if (!fs.existsSync(path.join(root, '.git'))) return { ...route('Restore native parent SOURCE prerequisites.',
                'Parent acceptance requires a native Git workspace and authenticated child SOURCE; DONE rows cannot replace them.', null), status: 'BLOCKED' as const };
            const effects = options.effects ?? createNextStepEffectPlanner();
            effects.run({ kind: 'register-parent-completion-contract', summary: `Freeze the parent-completion contract for ${taskId}`,
                input: { task_id: taskId, child_task_ids: children, provenance: source.source, policy: isPlainRecord(decision) ? decision.parent_completion_policy : null },
                preview: () => null, execute: () => { registerParentCompletionContract(root, taskId); return null; } });
            return route('Register parent completion contract.', 'Freeze origin and completion policy before accepted-child aggregation.', null);
        }
        if ((isPlainRecord(decision) && decision.decision === 'split-required')
            || readParentEvents(root, taskId).some(event => event.event_type === 'SPLIT_REQUIRED_LATCHED')) {
            return route('Select retained-parent compatibility behavior.',
                'This retained parent predates explicit completion policy. Record its audit choice once; the old global runner declaration is not an execution obligation.',
                'register', ' --audit-enabled "<true|false>" --compatibility-reason "<original parent intent and selected audit behavior>"');
        }
        if (requiresParentCompletionContract(root, taskId, entry?.notes ?? null)) return {
            ...route('Restore native parent decomposition evidence.',
                'The recorded parent requires an explicit completion contract; restore its native split evidence before registration and SOURCE qualification.', null),
            status: 'BLOCKED' as const
        };
        return null;
    }
    const inspection = inspectParentCompletion(root, taskId)!;
    if (inspection.violations.length) return { ...route('Resolve parent acceptance evidence.', inspection.violations.join(' '), null), status: 'BLOCKED' as const };
    if (inspection.ready) {
        if (!isTaskQueueDoneStatus(entry?.status ?? null)) {
            const effects = options.effects ?? createNextStepEffectPlanner();
            effects.run({ kind: 'complete-accepted-parent', summary: `Complete source-qualified parent ${taskId}`,
                input: { task_id: taskId, contract_sha256: inspection.contractSha256, result_sha256: inspection.result ? parentRecordDigest(inspection.result) : null,
                    source_ids: inspection.childSources.map(item => [item.taskId, item.artifactSha256]) },
                preview: () => null, execute: () => {
                    const result = transitionDecomposedParentsToDone({ repoRoot: root, eventsRoot: options.eventsRoot, rootTaskId: taskId, taskIds: [taskId] });
                    if (!['updated', 'unchanged'].includes(result.outcome)) throw new Error(result.error_message || 'Parent completion publication failed.');
                    return null;
                } });
            return route('Complete accepted parent.', 'All required child SOURCE and aggregate correction obligations are accepted.', null);
        }
        return null;
    }
    if (inspection.followUpTaskId) return { ...route('Continue the grouped aggregate correction.', 'The one aggregate audit is completed. Accept this F-task to complete its parent; do not repeat the aggregate review.', null),
        nextGate: 'next-step', commands: [{ label: 'Continue grouped correction', command: `${cliPrefix} next-step "${inspection.followUpTaskId}" --repo-root "."` }] };
    const validations = readParentValidations(root, contract), missing = validations.findIndex(item => item === null);
    if (missing >= 0) return route('Run an original declared parent validation.', 'This command was actually executed before decomposition; current combined-source evidence is required.', 'validate', ` --command-index ${missing}`);
    if (!contract.policy.audit_enabled) return { ...route('Resolve original parent failures.',
        'Automatic completion preserves actual pre-split failures. Accepted children must provide native resolution; failed original validations require a correction before completion.', null), status: 'BLOCKED' as const };
    const input = readParentRecord<ParentReviewInput>(root, taskId, 'review-input');
    const started = readParentRecord<ParentReviewerStart>(root, taskId, 'review-start');
    if (!input || (started?.attempt_id === input.attempt_id && started.status === 'FAILED')) return route('Prepare one aggregate review.', 'Audit the frozen parent requirements and the combined child diff with a fresh independent reviewer.', 'prepare');
    if (!started || started.attempt_id !== input.attempt_id) {
        try { assertParentReviewInputCurrent(root, input); }
        catch (error: unknown) {
            return route('Refresh the unstarted aggregate input.',
                'The previous immutable preparation is retained; prepare a current attempt before launching: ' + (error instanceof Error ? error.message : String(error)), 'prepare');
        }
    }
    if (!started || started.attempt_id !== input.attempt_id) return route('Launch a fresh independent aggregate reviewer.',
        `Launch a fresh subagent with exactly ReviewerLaunchInputArtifactPath: ${parentRecordVersionPath(root, input)}. After actual launch, record its identity. Input SHA256: ${parentRecordDigest(input)}.`,
        'started', ` --reviewer-identity "agent:<actual-new-reviewer-id>" --input-sha256 "${parentRecordDigest(input)}" --controller-tool "${parentReviewerControllerTool(input.runtime_identity.provider)}"`);
    return route('Accept the returned aggregate review.', `Wait for actual reviewer ${started.reviewer_identity} to return its JSON to ${input.output_path}.`,
        'complete', ` --reviewer-identity "${started.reviewer_identity}"`);
}
