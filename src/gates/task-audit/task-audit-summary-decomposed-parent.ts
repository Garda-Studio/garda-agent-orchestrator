import { isTaskQueueDoneStatus } from '../../core/active-task-state';
import { isCanonicalTaskId } from '../../core/task-ids';
import type {
    DecomposedParentAuditFacts,
    DecomposedParentAuditRequirements,
    ParentAuditEventReference
} from './task-audit-summary-types';

function isValidEventReference(reference: ParentAuditEventReference | null, taskId: string): boolean {
    return reference != null && reference.taskId === taskId
        && Number.isSafeInteger(reference.sequence) && reference.sequence >= 0
        && typeof reference.sha256 === 'string' && /^[a-f0-9]{64}$/u.test(reference.sha256);
}

function isUniqueChildSet(ids: readonly string[], taskId: string): boolean {
    return Array.isArray(ids) && new Set(ids).size === ids.length
        && ids.every((id) => isCanonicalTaskId(id) && id !== taskId);
}

function isTextList(value: unknown): value is string[] {
    return Array.isArray(value)
        && [...value].every((item) => typeof item === 'string' && item.trim().length > 0);
}

function collectAggregateViolations(facts: DecomposedParentAuditFacts): string[] {
    const violations: string[] = [];
    if (!isTaskQueueDoneStatus(facts.taskStatus)) violations.push('Parent is not terminal DONE.');
    if (!isValidEventReference(facts.decomposition, facts.taskId)) {
        violations.push('Current parent decomposition reference is missing or invalid.');
    }
    if (!isValidEventReference(facts.completion, facts.taskId)
        || (facts.completion && facts.decomposition
            && facts.completion.sequence <= facts.decomposition.sequence)) {
        violations.push('Current parent completion reference is missing, invalid or precedes decomposition.');
    }
    if (!isUniqueChildSet(facts.childTaskIds, facts.taskId) || facts.childTaskIds.length === 0
        || !isUniqueChildSet(facts.completedChildTaskIds, facts.taskId)
        || facts.completedChildTaskIds.length !== facts.childTaskIds.length
        || facts.childTaskIds.some((id) => !facts.completedChildTaskIds.includes(id))) {
        violations.push('Declared and completed child identities do not form the same nonempty unique set.');
    }
    if (facts.childGraphComplete !== true) violations.push('Explicit child graph is incomplete or uncertain.');
    return violations;
}

// References and queue facts describe obligations; only native callers can authenticate proof.
export function deriveDecomposedParentAuditRequirements(
    facts: DecomposedParentAuditFacts
): DecomposedParentAuditRequirements {
    const result: DecomposedParentAuditRequirements = {
        status: 'BLOCKED',
        childTaskIds: isTextList(facts.childTaskIds) ? [...facts.childTaskIds] : [],
        requiredProofs: ['authenticated-decomposition', 'source-qualified-child-acceptance', 'preserved-parent-wip'],
        historicalFailures: isTextList(facts.historicalFailures) ? [...facts.historicalFailures] : [],
        violations: []
    };
    if (!isCanonicalTaskId(facts.taskId) || !isTextList(facts.childTaskIds)
        || !isTextList(facts.completedChildTaskIds) || !isTextList(facts.historicalFailures)
        || typeof facts.fullSuiteRequired !== 'boolean'
        || (facts.projectMemoryRequired !== null && typeof facts.projectMemoryRequired !== 'boolean')) {
        result.violations.push('Audit facts have invalid identities, obligations or applicability.');
        return result;
    }
    if (facts.fullSuiteRequired || facts.historicalFailures.includes('full-suite-validation')) {
        result.requiredProofs.push('full-suite-composition');
    }
    if (facts.projectMemoryRequired !== false) result.requiredProofs.push('parent-memory-impact');
    if (facts.historicalFailures.length > 0) result.requiredProofs.push('historical-failure-resolution');
    if (facts.childTaskIds.length === 0 && facts.completedChildTaskIds.length === 0
        && facts.decomposition == null && facts.completion == null) {
        result.status = 'NOT_APPLICABLE';
        return result;
    }
    result.violations.push(...collectAggregateViolations(facts));
    if (result.violations.length === 0) result.status = 'REQUIRES_PROOF';
    return result;
}
