import * as fs from 'node:fs';
import * as path from 'node:path';
import { isPlainRecord } from '../../core/records';
import { parseValidationReportFiles, type ValidationReportFile } from '../../core/validation-report-contract';
import { parseTaskQueueEntriesFromContent, type TaskQueueEntry } from '../../core/task-queue-read';
import { isTaskQueueDoneStatus } from '../../core/active-task-state';
import { parseParentCompletionPolicy, resolveParentCompletionPolicy, type ParentCompletionPolicy } from '../../core/parent-completion-policy';
import { joinOrchestratorPath } from '../../core/orchestrator-paths';
import { readTransactionBytes } from '../../core/file-transaction-journal';
import { computeTaskPlanDigest, isApprovedPlan, validateTaskPlan } from '../../schemas/task-plan';
import { readParentAuditProofBytes, readParentAuditProofRecord } from '../task-audit/task-audit-summary-decomposed-parent-proofs';
import { readSplitRequiredLatchEvidence } from '../next-step/next-step-split-required-latch';
import { extractExplicitLinkedChildTaskIds, readDecomposedTaskProvenance } from '../next-step/next-step-task-queue';
import { getStrictDecompositionDecisionEvidence } from '../task-mode/strict-decomposition-decision';
import { parentDigest, publishParentRecord, readParentEvents, readParentRecord, withParentAuditMutation } from './parent-audit-auth';
import type { ParentCompletionContract } from './parent-audit-types';
import { buildReviewVerdictTokenSet, extractReviewVerdictTokenMatch } from '../../gate-runtime/review/review-verdict-tokens';
export { readParentAuditEnabled } from '../../core/parent-completion-policy';

export function parentEventHash(event: Record<string, unknown> | undefined): string | null {
    return isPlainRecord(event?.integrity) && typeof event.integrity.event_sha256 === 'string'
        ? event.integrity.event_sha256 : null;
}

function readDecompositionEvent(events: Record<string, unknown>[]) {
    return [...events].reverse().find(event => event.event_type === 'SPLIT_REQUIRED_LATCHED'
        || (event.event_type === 'STRICT_DECOMPOSITION_DECISION_RECORDED'
            && isPlainRecord(event.details) && event.details.decision === 'split-required'));
}

export function hasBoundParentCompletionPolicy(root: string, taskId: string): boolean {
    const declared = ['strict-decomposition-decision', 'split-required'].some(kind => {
        const bytes = readTransactionBytes(root, joinOrchestratorPath(root, `runtime/reviews/${taskId}-${kind}.json`));
        if (!bytes) return false;
        const raw: unknown = JSON.parse(bytes.toString('utf8'));
        return isPlainRecord(raw) && raw.parent_completion_policy !== undefined;
    });
    if (!declared) return false;
    const split = readDecompositionEvent(readParentEvents(root, taskId));
    if (!split || !isPlainRecord(split.details) || typeof split.details.artifact_sha256 !== 'string') return false;
    const kind = split.event_type === 'SPLIT_REQUIRED_LATCHED' ? 'split-required' : 'strict-decomposition-decision';
    const file = joinOrchestratorPath(root, `runtime/reviews/${taskId}-${kind}.json`);
    const raw = readParentAuditProofRecord(root, file, split.details.artifact_sha256);
    return raw.parent_completion_policy !== undefined;
}

export function requiresParentCompletionContract(root: string, taskId: string, notes: string | null): boolean {
    if (readDecomposedTaskProvenance(notes).source !== 'unrecorded') return true;
    const events = readParentEvents(root, taskId);
    return events.some(event => event.event_type === 'TASK_MODE_ENTERED') || Boolean(readDecompositionEvent(events));
}

/** An ordinary accepted task may bridge to its review follow-ups without becoming a decomposed parent. */
export function isCompletedReviewFollowUpBridge(root: string, entry: TaskQueueEntry | undefined, entries: Map<string, TaskQueueEntry>): boolean {
    if (!entry || !isTaskQueueDoneStatus(entry.status) || readDecomposedTaskProvenance(entry.notes).source !== 'unrecorded') return false;
    const children = extractExplicitLinkedChildTaskIds(entry.notes, entries.keys(), entry.taskId);
    const materialized = [...String(entry.notes || '').matchAll(/Review follow-up tasks materialized: (`[^`\r\n]+`(?:, `[^`\r\n]+`)*); artifact `[^`\r\n]+`\./gu)]
        .flatMap(match => [...match[1].matchAll(/`([^`]+)`/gu)].map(item => item[1]));
    if (!children.length || children.some(id => !id.startsWith(entry.taskId + '-F')
        || !/^[1-9][0-9]*$/u.test(id.slice(entry.taskId.length + 2)) || !materialized.includes(id))) return false;
    if (readParentCompletionContract(root, entry.taskId)) return false;
    return !readParentEvents(root, entry.taskId).some(event =>
        event.event_type === 'SPLIT_REQUIRED_LATCHED' || event.event_type === 'DECOMPOSED_PARENT_COMPLETED'
        || event.event_type === 'PARENT_AUDIT_RECORD_PUBLISHED'
        || (event.event_type === 'STRICT_DECOMPOSITION_DECISION_RECORDED' && isPlainRecord(event.details) && event.details.decision === 'split-required')
        || (event.event_type === 'STATUS_CHANGED' && isPlainRecord(event.details)
            && /DECOMPOSED|SPLIT_REQUIRED/u.test(String(event.details.new_status))));
}

function readAttachedPlan(root: string, entry: Record<string, unknown> | undefined) {
    const details = entry?.details;
    if (!isPlainRecord(details) || details.plan_guided !== true) return null;
    if (typeof details.plan_path !== 'string' || typeof details.plan_sha256 !== 'string') throw new Error('Original parent plan binding is incomplete.');
    const file = path.resolve(root, details.plan_path);
    const bytes = readParentAuditProofBytes(root, file);
    const plan = validateTaskPlan(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
    const digest = computeTaskPlanDigest(plan);
    if (plan.task_id !== entry?.task_id || !isApprovedPlan(plan) || digest !== details.plan_sha256
        || (plan.plan_sha256 !== undefined && plan.plan_sha256 !== digest)) throw new Error('Original parent plan binding is invalid.');
    return { plan, binding: { path: file, sha256: parentDigest(bytes) } };
}

export function readParentQueue(root: string) {
    const bytes = readTransactionBytes(root, path.join(root, 'TASK.md'));
    if (!bytes) throw new Error('Canonical TASK.md is missing.');
    return { bytes, entries: parseTaskQueueEntriesFromContent(bytes.toString('utf8')) };
}

export function readParentCompletionContract(root: string, taskId: string): ParentCompletionContract | null {
    const contract = readParentRecord<ParentCompletionContract>(root, taskId, 'contract');
    if (!contract) return null;
    parseParentCompletionPolicy(contract.policy);
    const { entries } = readParentQueue(root), parent = entries.get(taskId);
    const children = extractExplicitLinkedChildTaskIds(parent?.notes ?? null, entries.keys(), taskId);
    if (!parent || parent.title !== contract.title || parent.profile !== contract.profile
        || children.length !== contract.child_task_ids.length || children.some(id => !contract.child_task_ids.includes(id))) {
        throw new Error('Frozen parent identity or original child graph changed.');
    }
    const events = readParentEvents(root, taskId);
    const entry = [...events].reverse().find(event => event.event_type === 'TASK_MODE_ENTERED');
    const split = readDecompositionEvent(events);
    if (split && entry && events.indexOf(split) < events.indexOf(entry)) throw new Error('Native decomposition belongs to an earlier task cycle.');
    if (parentEventHash(entry) !== contract.entry_sha256 || parentEventHash(split) !== contract.decomposition_sha256
        || (contract.policy.origin === 'manual-at-creation' && (entry || split))) {
        throw new Error('Frozen parent origin or native attempt changed.');
    }
    if (contract.plan_binding) readParentAuditProofRecord(root, contract.plan_binding.path, contract.plan_binding.sha256);
    const captures = events.filter(event => event.event_type === 'SPLIT_REQUIRED_WIP_CAPTURED').map(event => parentEventHash(event));
    if (contract.wip_capture_sha256.some(hash => !captures.includes(hash))) throw new Error('Frozen WIP capture history changed.');
    return contract;
}

export function registerParentAtDecomposition(root: string, taskId: string): ParentCompletionContract | null {
    // Retained splits keep their original owner until an explicit compatibility decision.
    if (!hasBoundParentCompletionPolicy(root, taskId)) return null;
    const split = readDecompositionEvent(readParentEvents(root, taskId));
    if (!split) throw new Error('Parent decomposition has no native decision.');
    const kind = split.event_type === 'SPLIT_REQUIRED_LATCHED' ? 'split-required' : 'strict-decomposition-decision';
    const raw: unknown = JSON.parse(fs.readFileSync(joinOrchestratorPath(root, `runtime/reviews/${taskId}-${kind}.json`), 'utf8'));
    if (isPlainRecord(raw) && raw.parent_completion_policy === undefined) return null;
    return registerParentCompletionContract(root, taskId);
}

export function readParentRecordedReview(event: Record<string, unknown>): { reviewType: string; passed: boolean | null } | null {
    if (event.event_type !== 'REVIEW_RECORDED') return null;
    const details = event.details;
    if (!isPlainRecord(details)) throw new Error('Original native review record has no details.');
    const reviewType = String(details.review_type ?? details.reviewType ?? '').trim().toLowerCase();
    if (!/^[a-z][a-z0-9-]*$/u.test(reviewType)) throw new Error('Original native review record has an invalid lane.');
    const validation = isPlainRecord(details.review_findings_validation) ? details.review_findings_validation : null;
    const coverage = isPlainRecord(details.review_coverage) ? details.review_coverage : null;
    if (event.outcome !== 'PASS' || validation?.accepted === false
        || (coverage?.status !== undefined && coverage.status !== 'PASS')) return { reviewType, passed: false };
    const disposition = isPlainRecord(details.review_findings_disposition) ? details.review_findings_disposition : null;
    if (disposition) {
        return { reviewType, passed: validation?.accepted === true && disposition.blocking_count === 0
            && ['pass_no_findings', 'pass_with_follow_up_or_ignored_findings'].includes(String(disposition.verdict)) };
    }
    const verdict = extractReviewVerdictTokenMatch(details.review_verdict ?? details.verdict_token ?? details.verdict,
        buildReviewVerdictTokenSet(reviewType, null));
    return { reviewType, passed: verdict ? verdict.outcome === 'pass' : null };
}

function originalObligations(events: Record<string, unknown>[]) {
    const states = new Map<string, boolean>(), commands = new Set<string>();
    const suiteStates = new Map<string, boolean>();
    const reports: Record<string, ValidationReportFile[]> = {};
    for (const event of events) {
        const type = String(event.event_type);
        const review = readParentRecordedReview(event);
        if (review && review.passed !== null) states.set('REVIEW_RECORDED:' + review.reviewType, !review.passed);
        if (/^FULL_SUITE_VALIDATION_(?:PASSED|FAILED|WARNED|BLOCKED)$/u.test(type)) {
            const command = isPlainRecord(event.details) && typeof event.details.command === 'string' ? event.details.command : '';
            if (event.outcome === 'PASS') suiteStates.set(command, false);
            else if (['FAIL', 'BLOCKED'].includes(String(event.outcome))) suiteStates.set(command, true);
        }
        if (/^(?:COMPILE_GATE|REVIEW_GATE|DOC_IMPACT|FULL_SUITE_VALIDATION|PROJECT_MEMORY_IMPACT)_(?:FAILED|BLOCKED|PASSED|ASSESSED|WARNED)$/u.test(type)) {
            states.set(type.replace(/_(?:FAILED|BLOCKED|PASSED|ASSESSED|WARNED)$/u, ''), ['FAIL', 'BLOCKED'].includes(String(event.outcome)));
        }
        if (/^FULL_SUITE_VALIDATION_(?:PASSED|FAILED|WARNED)$/u.test(type)
            && isPlainRecord(event.details) && typeof event.details.command === 'string') {
            const command = event.details.command;
            commands.add(command);
            const attempts = event.details.report_attempts;
            if (attempts !== undefined && !Array.isArray(attempts)) throw new Error('Original native report attempts are malformed.');
            const declarations = (attempts ?? []).flatMap(attempt => {
                if (!isPlainRecord(attempt) || !isPlainRecord(attempt.report_evidence)) throw new Error('Original native report binding is missing.');
                return parseValidationReportFiles(attempt.report_evidence.declarations);
            });
            const unique = new Map([...(reports[command] ?? []), ...declarations].map(report => [report.path, report]));
            reports[command] = parseValidationReportFiles([...unique.values()]);
        }
    }
    if (suiteStates.size) states.set('FULL_SUITE_VALIDATION', [...suiteStates.values()].some(failed => failed));
    return { failures: [...states].filter(([, failed]) => failed).map(([gate]) => gate), commands: [...commands], reports };
}

export function registerParentCompletionContract(root: string, taskId: string, options: {
    legacyAuditEnabled?: boolean; compatibilityReason?: string;
} = {}): ParentCompletionContract {
    return withParentAuditMutation(root, taskId, () => {
        const existing = readParentCompletionContract(root, taskId);
        if (existing) return existing;
        const { entries } = readParentQueue(root), parent = entries.get(taskId);
        if (!parent) throw new Error('Parent task is missing.');
        const children = extractExplicitLinkedChildTaskIds(parent.notes, entries.keys(), taskId);
        if (children.length < 2 || children.some(id => !entries.has(id))) throw new Error('Parent requires a complete explicit child graph.');
        const events = readParentEvents(root, taskId);
        const entry = [...events].reverse().find(event => event.event_type === 'TASK_MODE_ENTERED');
        const split = readDecompositionEvent(events);
        if (split && entry && events.indexOf(split) < events.indexOf(entry)) throw new Error('Native decomposition belongs to an earlier task cycle.');
        const kind = split ? split.event_type === 'SPLIT_REQUIRED_LATCHED' ? 'guard' : 'strict' : 'manual';
        let policy: ParentCompletionPolicy, compatibility = false;
        let decision: Record<string, unknown> | null = null;
        if (split && kind === 'strict') {
            const file = joinOrchestratorPath(root, `runtime/reviews/${taskId}-strict-decomposition-decision.json`);
            const evidence = getStrictDecompositionDecisionEvidence(root, taskId, file, '', parent.profile ?? '');
            if (evidence.evidence_status !== 'PASS' || evidence.proposed_child_task_ids.length !== children.length
                || children.some(id => !evidence.proposed_child_task_ids.includes(id))) throw new Error('Native split contract differs from the original child graph.');
            decision = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
            if (isPlainRecord(split.details) && split.details.artifact_sha256 !== undefined
                && split.details.artifact_sha256 !== parentDigest(fs.readFileSync(file))) throw new Error('Native split artifact changed.');
            if (isPlainRecord(split.details) && typeof split.details.artifact_sha256 === 'string'
                && decision.parent_completion_policy !== undefined) policy = parseParentCompletionPolicy(decision.parent_completion_policy);
            else {
                if (typeof options.legacyAuditEnabled !== 'boolean' || (options.compatibilityReason?.trim().length ?? 0) < 12) {
                    throw new Error('Retained runtime parent needs an explicit compatibility audit choice and reason.');
                }
                policy = resolveParentCompletionPolicy('runtime', options.legacyAuditEnabled);
                compatibility = true;
            }
        } else if (split) {
            const latch = readSplitRequiredLatchEvidence({ reviewsRoot: joinOrchestratorPath(root, 'runtime/reviews'),
                eventsRoot: joinOrchestratorPath(root, 'runtime/task-events'), taskId });
            if (!latch.valid || !isPlainRecord(split.details) || split.details.artifact_sha256 !== latch.artifact_sha256) {
                throw new Error('Native guard decomposition evidence is invalid: ' + latch.reason);
            }
            const guard = readParentAuditProofRecord(root, path.resolve(root, latch.artifact_path), latch.artifact_sha256!);
            if (guard.parent_completion_policy !== undefined) policy = parseParentCompletionPolicy(guard.parent_completion_policy);
            else {
                if (typeof options.legacyAuditEnabled !== 'boolean' || (options.compatibilityReason?.trim().length ?? 0) < 12) {
                    throw new Error('Retained runtime parent needs an explicit compatibility audit choice and reason.');
                }
                policy = resolveParentCompletionPolicy('runtime', options.legacyAuditEnabled);
                compatibility = true;
            }
        } else {
            const provenance = readDecomposedTaskProvenance(parent.notes);
            if (entry || !['manual-agent', 'manual-operator'].includes(provenance.source) || provenance.evidence !== 'structured-note') {
                throw new Error('Manual-at-creation exemption requires explicit provenance and no native runtime task entry or split.');
            }
            policy = resolveParentCompletionPolicy('manual-at-creation', false);
        }
        if (policy.origin !== 'runtime' && split) throw new Error('Native runtime decomposition cannot claim manual-at-creation origin.');
        const original = split ? events.slice(0, events.indexOf(split) + 1) : events;
        const obligations = originalObligations(original);
        const requirements = [parent.title || taskId, parent.notes || 'All original children must be accepted.'];
        const attached = readAttachedPlan(root, entry);
        if (attached) {
            const plan = attached.plan;
            requirements.push(...(plan.acceptance_criteria ?? []),
                ...(plan.verification_expectations ?? []).map(value => 'Verification expectation: ' + value),
                ...(plan.validation_strategy ? ['Validation approach: ' + plan.validation_strategy.approach,
                    ...(plan.validation_strategy.commands ?? []).map(value => 'Validation command: ' + value)] : []),
                ...(plan.out_of_scope ?? []).map(value => 'Out of scope: ' + value));
        }
        if (isPlainRecord(decision?.work_package_contract)) requirements.push(JSON.stringify(decision.work_package_contract));
        return publishParentRecord(root, {
            schema_version: 1, event_source: 'parent-audit', task_id: taskId, kind: 'contract',
            policy, title: parent.title || '', profile: parent.profile || '', child_task_ids: children,
            requirements, unresolved_failures: obligations.failures, original_commands: obligations.commands, original_reports: obligations.reports,
            decomposition_sha256: parentEventHash(split), entry_sha256: parentEventHash(entry), compatibility,
            decomposition_kind: kind, plan_binding: attached?.binding ?? null,
            wip_capture_sha256: events.filter(event => event.event_type === 'SPLIT_REQUIRED_WIP_CAPTURED').map(event => {
                const hash = parentEventHash(event);
                if (!hash) throw new Error('WIP capture has no native integrity binding.');
                return hash;
            }),
            compatibility_reason: compatibility ? options.compatibilityReason!.trim() : null
        } satisfies ParentCompletionContract);
    });
}
